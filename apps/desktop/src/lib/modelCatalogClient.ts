import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clampThinkingLevel,
  findModelOptionForModel,
  inferAgentModelAndThinking,
  normalizeSwitchHarness,
  resolveThinkingLevelsForModel,
  stripModelEffortSuffix,
  synthesizeFallbackAgentModels,
  type Agent,
  type AgentModelOption,
  type AgentModelsResult,
  type OmpModelRole,
} from "@herdr-pocket/protocol";
import { isTauri } from "./bridge";
import { ensureLocalHostDeviceId, localHostIdStore } from "./fonts";
import { liveStore } from "./store";

const CACHE_TTL_MS = 60_000;
const TRANSIENT_FALLBACK_TTL_MS = 10_000;
const REMOTE_RACE_MS = 800;

interface CacheEntry {
  at: number;
  ttl: number;
  model: string;
  sessionKey: string;
  res: AgentModelsResult;
}

const modelsCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<AgentModelsResult>>();

const MULTI_PROVIDER_HARNESSES = new Set(["omp", "pi", "opencode", "hermes", "aider", "goose"]);

export interface ModelCatalogDeps {
  rpcCall: (deviceId: string, agentKey: string) => Promise<AgentModelsResult>;
  isTauri: () => boolean;
  getLocalHostId: () => Promise<string | null>;
  invokeLocalAgentModels: (params: {
    harness: string;
    currentModel: string | null;
    sessionKey: string | null;
  }) => Promise<AgentModelsResult>;
}

const defaultDeps: ModelCatalogDeps = {
  rpcCall: async (deviceId, agentKey) => {
    const { rpcCall } = await import("./relay");
    return rpcCall(deviceId, "agent.models", { agent: agentKey });
  },
  isTauri,
  getLocalHostId: async () => localHostIdStore.get() ?? (await ensureLocalHostDeviceId()),
  invokeLocalAgentModels: async (params) => {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke<AgentModelsResult>("local_agent_models", params);
  },
};

/** Collects deduplicated peer models from `liveStore`, prioritizing same-harness peers. */
export function collectPeerModels(
  target: Pick<Agent, "key" | "harness" | "model">,
  agentsByHost: Record<string, Agent[]> = liveStore.get().agents,
): string[] {
  const targetHarness = normalizeSwitchHarness(target.harness);
  const allowCrossHarness = MULTI_PROVIDER_HARNESSES.has(targetHarness);
  const sameHarness: string[] = [];
  const otherHarness: string[] = [];
  const seen = new Set<string>();
  const targetClean = target.model ? stripModelEffortSuffix(target.model).toLowerCase() : "";

  for (const list of Object.values(agentsByHost)) {
    for (const a of list) {
      if (a.isShell || !a.model?.trim()) continue;
      const clean = stripModelEffortSuffix(a.model);
      const low = clean.toLowerCase();
      if (!low || low === targetClean || seen.has(low)) continue;
      seen.add(low);
      if (normalizeSwitchHarness(a.harness) === targetHarness) {
        sameHarness.push(clean);
      } else if (allowCrossHarness) {
        otherHarness.push(clean);
      }
    }
  }
  return [...sameHarness, ...otherHarness];
}

function getCachedEntry(agent: Agent): AgentModelsResult | null {
  const entry = modelsCache.get(agent.key);
  if (!entry) return null;
  if (
    entry.model !== (agent.model ?? "") ||
    entry.sessionKey !== (agent.sessionKey ?? "") ||
    Date.now() - entry.at >= entry.ttl
  ) {
    modelsCache.delete(agent.key);
    return null;
  }
  return entry.res;
}

/** Clears cached model discovery entries (for tests or forced reload). */
export function invalidateModelCatalogCache(agentKey?: string): void {
  if (agentKey) modelsCache.delete(agentKey);
  else modelsCache.clear();
}

/** Seeds a cached catalog entry (for unit tests exercising `patchCachedAgentModelMeta` / `useAutoAgentModelMeta`). */
export function seedModelCatalogCacheForTest(agent: Agent, res: AgentModelsResult): void {
  modelsCache.set(agent.key, {
    at: Date.now(),
    ttl: CACHE_TTL_MS,
    model: agent.model ?? "",
    sessionKey: agent.sessionKey ?? "",
    res,
  });
}

/** Optimistically updates cached model/thinking/role metadata after a user switch. */
export function patchCachedAgentModelMeta(
  agentKey: string,
  patch: { currentModel?: string; currentThinking?: string; modelRoles?: Record<string, string> },
): void {
  const entry = modelsCache.get(agentKey);
  if (!entry) return;
  const nextModel = patch.currentModel ? stripModelEffortSuffix(patch.currentModel) : entry.res.currentModel;
  const nextRoles = patch.modelRoles
    ? { ...(entry.res.modelRoles ?? {}), ...patch.modelRoles }
    : entry.res.modelRoles;
  const resolvedLevels = resolveThinkingLevelsForModel(
    {
      ...entry.res,
      models: Array.isArray(entry.res.models) ? entry.res.models : [],
      currentModel: nextModel,
      modelRoles: nextRoles,
    },
    nextModel,
  );
  const nextThinking = patch.currentThinking
    ? clampThinkingLevel(resolvedLevels, patch.currentThinking)
    : clampThinkingLevel(
        resolvedLevels,
        entry.res.currentThinking,
        patch.currentModel,
      );
  entry.res = {
    ...entry.res,
    ...(nextModel ? { currentModel: nextModel } : {}),
    currentThinking: nextThinking,
    thinkingLevels: resolvedLevels.length ? resolvedLevels : undefined,
    canSwitchThinking: resolvedLevels.length > 0 ? entry.res.canSwitch : false,
    ...(resolvedLevels.length ? { thinkingLabel: entry.res.thinkingLabel || "思考等级" } : {}),
    ...(nextRoles ? { modelRoles: nextRoles } : {}),
  };
}

function isUnsupportedRpcError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  const code = e?.code ?? "";
  const msg = e?.message ?? "";
  return (
    code === "unsupported" ||
    code === "not_found" ||
    /unknown\s+method|unsupported|not\s+implemented|不支持/i.test(msg)
  );
}

function normalizeAgentModelsResult(
  raw: AgentModelsResult,
  agent: Pick<Agent, "harness">,
): AgentModelsResult {
  const models = Array.isArray(raw.models) ? raw.models : [];
  const harness = typeof raw.harness === "string" && raw.harness.trim() ? raw.harness : agent.harness;
  return raw.harness === harness && raw.models === models ? raw : { ...raw, harness, models };
}

function applyReasoningEventsFallback(
  res: AgentModelsResult,
  agent: Pick<Agent, "harness" | "isShell">,
  hasReasoningEvents?: boolean,
): AgentModelsResult {
  const normalized = normalizeAgentModelsResult(res, agent);
  if (agent.isShell || normalized.thinkingLevels?.length) return normalized;
  const fallbackLevels = resolveThinkingLevelsForModel(
    { ...normalized, harness: normalized.harness || agent.harness, hasReasoningEvents },
    normalized.currentModel,
  );
  if (fallbackLevels.length === 0) return normalized;
  return {
    ...normalized,
    thinkingLevels: fallbackLevels,
    canSwitchThinking: normalized.canSwitch,
    thinkingLabel: normalized.thinkingLabel || "思考等级",
  };
}

function mergeAgentModelsResults(primary: AgentModelsResult, secondary: AgentModelsResult): AgentModelsResult {
  const primaryModels = Array.isArray(primary.models) ? primary.models : [];
  const secondaryModels = Array.isArray(secondary.models) ? secondary.models : [];
  const seen = new Set(primaryModels.map((m) => m.id.toLowerCase()));
  const extra: AgentModelOption[] = [];
  for (const m of secondaryModels) {
    const key = m.id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      extra.push(m);
    }
  }
  const models = [...primaryModels, ...extra];
  const harness = primary.harness || secondary.harness;
  const modelRoles = primary.modelRoles ?? secondary.modelRoles;
  const currentModel = primary.currentModel ?? secondary.currentModel;
  const matchedOpt = findModelOptionForModel(models, currentModel, {
    harness,
    modelRoles,
  });
  const thinkingLevels =
    matchedOpt?.reasoning === false
      ? []
      : matchedOpt?.thinkingLevels?.length
        ? [...matchedOpt.thinkingLevels]
        : primary.currentModel && primary.thinkingLevels?.length
          ? [...primary.thinkingLevels]
          : resolveThinkingLevelsForModel(
              {
                harness,
                models,
                currentModel,
                modelRoles,
                thinkingLevels: secondary.thinkingLevels,
              },
              currentModel,
            );
  const currentThinking = clampThinkingLevel(
    thinkingLevels,
    primary.currentThinking ?? secondary.currentThinking,
  );
  return {
    ...primary,
    harness,
    ...(currentModel ? { currentModel } : {}),
    currentThinking,
    ...(thinkingLevels.length
      ? { thinkingLevels, canSwitchThinking: primary.canSwitchThinking || primary.canSwitch, thinkingLabel: primary.thinkingLabel || secondary.thinkingLabel || "思考等级" }
      : { thinkingLevels: undefined, canSwitchThinking: false }),
    ...(modelRoles ? { modelRoles } : {}),
    models,
  };
}

function normalizeLocalResultForAgent(
  raw: AgentModelsResult,
  agent: Agent,
  opts?: { isRemoteHost?: boolean },
): AgentModelsResult {
  const canSwitch = !agent.isShell && (agent.source === "hc" || agent.source === "herdr");
  const reason = agent.isShell
    ? "普通终端不支持切换模型"
    : agent.source === "uniflo"
      ? "历史只读会话无法直接切换模型"
      : raw.reason;
  const { modelRoles, models: rawModels, ...rest } = raw;
  const models = Array.isArray(rawModels) ? rawModels : [];
  const isRemote = Boolean(opts?.isRemoteHost);
  const inferred = isRemote && agent.model ? inferAgentModelAndThinking(agent.harness, agent.model) : undefined;
  const nextModel = inferred?.currentModel || raw.currentModel;
  const nextLevels =
    isRemote && agent.model
      ? resolveThinkingLevelsForModel(
          {
            ...raw,
            models,
            harness: agent.harness,
            currentModel: nextModel,
            modelRoles: undefined,
          },
          nextModel,
        )
      : (raw.thinkingLevels ?? []);
  const nextThinking =
    isRemote && agent.model
      ? clampThinkingLevel(nextLevels, inferred?.currentThinking ?? raw.currentThinking, agent.model)
      : raw.currentThinking;
  return {
    ...rest,
    models,
    ...(isRemote ? {} : modelRoles ? { modelRoles } : {}),
    ...(nextModel ? { currentModel: nextModel } : {}),
    ...(nextThinking ? { currentThinking: nextThinking } : { currentThinking: undefined }),
    ...(nextLevels.length ? { thinkingLevels: nextLevels } : { thinkingLevels: undefined }),
    harness: agent.harness,
    canSwitch,
    canSwitchThinking: canSwitch && nextLevels.length > 0,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Synchronously seeds model dropdown state on open from cache or client-side synthesis
 * so the picker never appears stuck empty on `"正在读取可用模型…"`.
 */
export function getInitialAgentModelsSeed(
  agent: Agent,
  peerModels: readonly string[] = collectPeerModels(agent),
  opts?: { hasReasoningEvents?: boolean },
): AgentModelsResult {
  if (agent.isShell) {
    return synthesizeFallbackAgentModels(agent, [], opts);
  }
  const cached = getCachedEntry(agent);
  if (cached) {
    return applyReasoningEventsFallback(cached, agent, opts?.hasReasoningEvents);
  }
  return synthesizeFallbackAgentModels(agent, peerModels, opts);
}

/**
 * Updates an OMP role slot (`default`, `smol`, `slow`, `plan`, `commit`) via host RPC,
 * falling back to local Tauri command when running against this computer on an older hostd.
 */
export async function updateAgentRoleModel(
  agent: Agent,
  roleSlot: OmpModelRole,
  modelId: string,
  opts: {
    thinkingLevel?: string;
    deps?: {
      rpcCall?: (
        deviceId: string,
        params: { agent: string; roleSlot: OmpModelRole; modelId: string; thinkingLevel?: string },
      ) => Promise<{ ok: true; modelRoles?: Record<string, string>; note?: string }>;
      isTauri?: () => boolean;
      getLocalHostId?: () => Promise<string | null>;
      invokeLocalSetRole?: (
        roleSlot: OmpModelRole,
        modelId: string,
      ) => Promise<{ ok?: boolean; modelRoles?: Record<string, string> }>;
    };
  } = {},
): Promise<{ ok: true; modelRoles?: Record<string, string>; note?: string }> {
  const cleanModel = modelId.trim();
  const thinkingLevel = opts.thinkingLevel?.trim().toLowerCase() || undefined;
  const rpcFn =
    opts.deps?.rpcCall ??
    (async (deviceId, params) => {
      const { rpcCall } = await import("./relay");
      return rpcCall(deviceId, "agent.setModel", params);
    });
  const tauriCheck = opts.deps?.isTauri ?? isTauri;
  const getLocalId = opts.deps?.getLocalHostId ?? defaultDeps.getLocalHostId;
  const invokeRole =
    opts.deps?.invokeLocalSetRole ??
    (async (slot, id) => {
      const mod = await import("@tauri-apps/api/core");
      return mod.invoke<{ ok?: boolean; modelRoles?: Record<string, string> }>("local_set_omp_role_model", {
        roleSlot: slot,
        modelId: id,
      });
    });

  try {
    const res = await rpcFn(agent.deviceId, {
      agent: agent.key,
      roleSlot,
      modelId: cleanModel,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });
    const selector = thinkingLevel ? `${stripModelEffortSuffix(cleanModel)}:${thinkingLevel}` : cleanModel;
    patchCachedAgentModelMeta(agent.key, {
      modelRoles: res.modelRoles ?? { [roleSlot]: selector },
    });
    return res;
  } catch (err) {
    if (isUnsupportedRpcError(err) && tauriCheck()) {
      const localId = await getLocalId().catch(() => null);
      if (localId && localId === agent.deviceId) {
        const selector = thinkingLevel ? `${stripModelEffortSuffix(cleanModel)}:${thinkingLevel}` : cleanModel;
        const localRes = await invokeRole(roleSlot, selector);
        const roles = localRes?.modelRoles ?? { [roleSlot]: selector };
        patchCachedAgentModelMeta(agent.key, { modelRoles: roles });
        return { ok: true, modelRoles: roles, note: `已更新 OMP 角色 ${roleSlot} -> ${selector}` };
      }
    }
    throw err;
  }
}

/**
 * Fetches an agent's model catalog & live thinking state with full multi-layer fallback:
 * 1. Remote/host `agent.models` RPC
 * 2. Native desktop Tauri `local_agent_models` race/merge (~800ms for omp/pi or on failure)
 * 3. Client-side `synthesizeFallbackAgentModels` using peer models & harness presets
 * Never surfaces `unknown method agent.models` errors.
 */
export async function fetchAgentModelsWithFallback(
  agent: Agent,
  peerModels: readonly string[] = collectPeerModels(agent),
  opts: {
    force?: boolean;
    hasReasoningEvents?: boolean;
    remoteRaceMs?: number;
    onUpdate?: (res: AgentModelsResult) => void;
    deps?: Partial<ModelCatalogDeps>;
  } = {},
): Promise<AgentModelsResult> {
  if (agent.isShell) {
    return synthesizeFallbackAgentModels(agent, []);
  }

  const useDefaultDeps = !opts.deps;
  if (!opts.force && useDefaultDeps) {
    const cached = getCachedEntry(agent);
    if (cached) return applyReasoningEventsFallback(cached, agent, opts.hasReasoningEvents);
  }

  const reqKey = `${agent.deviceId}\0${agent.key}\0${agent.model ?? ""}\0${agent.sessionKey ?? ""}`;
  if (!opts.force && useDefaultDeps) {
    const existing = inflightRequests.get(reqKey);
    if (existing) {
      return existing.then((res) => applyReasoningEventsFallback(res, agent, opts.hasReasoningEvents));
    }
  }

  const deps: ModelCatalogDeps = { ...defaultDeps, ...opts.deps };
  const hNorm = normalizeSwitchHarness(agent.harness);
  const canRaceLocal = deps.isTauri() && (hNorm === "omp" || hNorm === "pi");
  const raceMs = Math.max(0, opts.remoteRaceMs ?? REMOTE_RACE_MS);

  let usedTransientLocal = false;

  const task = (async (): Promise<AgentModelsResult> => {
    const synth = synthesizeFallbackAgentModels(agent, peerModels, {
      hasReasoningEvents: opts.hasReasoningEvents,
    });
    const rpcPromise = deps.rpcCall(agent.deviceId, agent.key);

    if (!deps.isTauri()) {
      try {
        const rpcRes = normalizeAgentModelsResult(await rpcPromise, agent);
        if (rpcRes.models.length === 0) {
          return applyReasoningEventsFallback(mergeAgentModelsResults(rpcRes, synth), agent, opts.hasReasoningEvents);
        }
        return applyReasoningEventsFallback(rpcRes, agent, opts.hasReasoningEvents);
      } catch {
        usedTransientLocal = true;
        return synth;
      }
    }

    const localId = await deps.getLocalHostId().catch(() => null);
    const isRemoteHost = !localId || localId !== agent.deviceId;

    const loadLocalNormalized = async (): Promise<AgentModelsResult | null> => {
      try {
        const localRes = await deps.invokeLocalAgentModels({
          harness: agent.harness,
          currentModel: agent.model ?? null,
          sessionKey: isRemoteHost ? null : (agent.sessionKey ?? null),
        });
        if (localRes && Array.isArray(localRes.models) && (localRes.models.length > 0 || localRes.thinkingLevels?.length)) {
          return normalizeLocalResultForAgent(localRes, agent, { isRemoteHost });
        }
      } catch {
        /* ignore local invoke error */
      }
      return null;
    };

    if (!canRaceLocal) {
      try {
        const rpcRes = normalizeAgentModelsResult(await rpcPromise, agent);
        if (rpcRes && (rpcRes.models.length > 0 || isRemoteHost)) {
          return applyReasoningEventsFallback(
            rpcRes.models.length === 0 ? mergeAgentModelsResults(rpcRes, synth) : rpcRes,
            agent,
            opts.hasReasoningEvents,
          );
        }
      } catch (err) {
        if (!isUnsupportedRpcError(err)) usedTransientLocal = true;
      }
      if (!isRemoteHost) {
        const localNorm = await loadLocalNormalized();
        if (localNorm) return applyReasoningEventsFallback(localNorm, agent, opts.hasReasoningEvents);
      }
      return synth;
    }

    type RpcOutcome = { kind: "ok"; res: AgentModelsResult } | { kind: "err"; err: unknown } | { kind: "timeout" };
    const rpcSettled: Promise<RpcOutcome> = rpcPromise.then(
      (res) => ({ kind: "ok", res: normalizeAgentModelsResult(res, agent) }),
      (err) => ({ kind: "err", err }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<RpcOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), raceMs);
    });
    const outcome = await Promise.race([rpcSettled, timeoutPromise]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });

    if (outcome.kind === "ok" && outcome.res.models.length > 0) {
      return applyReasoningEventsFallback(outcome.res, agent, opts.hasReasoningEvents);
    }

    if (outcome.kind === "err" && !isUnsupportedRpcError(outcome.err)) {
      usedTransientLocal = true;
    }

    if (outcome.kind === "timeout") {
      usedTransientLocal = true;
      const localPromise = loadLocalNormalized().then((localNorm) => ({ kind: "local" as const, localNorm }));
      const winner = await Promise.race([rpcSettled, localPromise]);

      if (winner.kind === "ok" && winner.res.models.length > 0) {
        return applyReasoningEventsFallback(winner.res, agent, opts.hasReasoningEvents);
      }

      const localNorm = winner.kind === "local" ? winner.localNorm : await loadLocalNormalized();
      const baseResult = localNorm
        ? applyReasoningEventsFallback(mergeAgentModelsResults(localNorm, synth), agent, opts.hasReasoningEvents)
        : synth;

      void rpcSettled.then((late) => {
        if (late.kind !== "ok") return;
        const mergedLate = applyReasoningEventsFallback(
          mergeAgentModelsResults(late.res, baseResult),
          agent,
          opts.hasReasoningEvents,
        );
        if (useDefaultDeps) {
          modelsCache.set(agent.key, {
            at: Date.now(),
            ttl: mergedLate.models.length > 0 ? CACHE_TTL_MS : TRANSIENT_FALLBACK_TTL_MS,
            model: agent.model ?? "",
            sessionKey: agent.sessionKey ?? "",
            res: mergedLate,
          });
        }
        opts.onUpdate?.(mergedLate);
      });

      return baseResult;
    }

    const localNorm = await loadLocalNormalized();
    if (localNorm) {
      const merged = outcome.kind === "ok"
        ? mergeAgentModelsResults(outcome.res, localNorm)
        : mergeAgentModelsResults(localNorm, synth);
      return applyReasoningEventsFallback(merged, agent, opts.hasReasoningEvents);
    }

    if (outcome.kind === "ok") {
      return applyReasoningEventsFallback(mergeAgentModelsResults(outcome.res, synth), agent, opts.hasReasoningEvents);
    }

    return synth;
  })();

  if (useDefaultDeps) {
    inflightRequests.set(reqKey, task);
  }
  try {
    const result = await task;
    if (useDefaultDeps) {
      modelsCache.set(agent.key, {
        at: Date.now(),
        ttl: !usedTransientLocal && result.models.length > 0 ? CACHE_TTL_MS : TRANSIENT_FALLBACK_TTL_MS,
        model: agent.model ?? "",
        sessionKey: agent.sessionKey ?? "",
        res: result,
      });
    }
    return result;
  } finally {
    if (useDefaultDeps) {
      inflightRequests.delete(reqKey);
    }
  }
}

export interface AutoAgentModelMeta {
  currentModel?: string;
  currentThinking?: string;
  thinkingLevels?: string[];
  models?: AgentModelOption[];
  activeModelOption?: AgentModelOption;
  modelRoles?: Record<string, string>;
  canSwitch?: boolean;
  canSwitchThinking?: boolean;
  loaded: boolean;
  refresh: () => void;
  applyOverride: (patch: { currentModel?: string; currentThinking?: string; modelRoles?: Record<string, string> }) => void;
}

const noopMeta = () => {};

/** Pure computation backing `useAutoAgentModelMeta`, safe against partial/legacy host catalogs missing `.harness`. */
export function computeAutoAgentModelMeta(
  agent: Agent,
  opts: {
    fetched?: AgentModelsResult | null;
    override?: {
      currentModel?: string;
      currentThinking?: string;
      fallbackThinkingCandidate?: string;
      modelRoles?: Record<string, string>;
    } | null;
    hasReasoningEvents?: boolean;
    refresh?: () => void;
    applyOverride?: AutoAgentModelMeta["applyOverride"];
  } = {},
): AutoAgentModelMeta {
  const refresh = opts.refresh ?? noopMeta;
  const applyOverride = opts.applyOverride ?? noopMeta;

  if (agent.isShell) {
    return {
      currentModel: agent.model,
      canSwitch: false,
      canSwitchThinking: false,
      loaded: true,
      refresh,
      applyOverride,
    };
  }

  const activeFetched = opts.fetched ? normalizeAgentModelsResult(opts.fetched, agent) : null;
  const activeOverride = opts.override ?? null;
  const hasReasoningEvents = opts.hasReasoningEvents;
  const inferred = inferAgentModelAndThinking(
    agent.harness,
    !activeFetched && activeOverride?.currentModel ? activeOverride.currentModel : agent.model,
    { hasReasoningEvents },
  );

  const currentModel =
    activeOverride?.currentModel || activeFetched?.currentModel || inferred.currentModel || agent.model;

  const modelRoles =
    activeFetched?.modelRoles || activeOverride?.modelRoles
      ? { ...(activeFetched?.modelRoles ?? {}), ...(activeOverride?.modelRoles ?? {}) }
      : undefined;

  const activeModelOption = findModelOptionForModel(activeFetched?.models, currentModel, {
    harness: activeFetched?.harness || agent.harness,
    modelRoles,
  });

  const thinkingLevels = activeFetched
    ? resolveThinkingLevelsForModel(
        {
          ...activeFetched,
          harness: activeFetched.harness || agent.harness,
          models: activeFetched.models,
          modelRoles,
          hasReasoningEvents,
        },
        currentModel,
      )
    : (inferred.thinkingLevels ?? []);

  const currentThinking =
    thinkingLevels.length === 0
      ? undefined
      : activeOverride?.currentThinking
        ? clampThinkingLevel(thinkingLevels, activeOverride.currentThinking)
        : clampThinkingLevel(
            thinkingLevels,
            activeOverride?.fallbackThinkingCandidate || activeFetched?.currentThinking || inferred.currentThinking,
            activeOverride?.currentModel,
          );

  const canSwitch = activeFetched?.canSwitch;
  const canSwitchThinking = activeFetched
    ? Boolean(activeFetched.canSwitch) && thinkingLevels.length > 0
    : undefined;

  return {
    ...(currentModel ? { currentModel } : {}),
    ...(currentThinking ? { currentThinking } : {}),
    ...(thinkingLevels.length ? { thinkingLevels } : {}),
    ...(activeModelOption ? { activeModelOption } : {}),
    ...(modelRoles ? { modelRoles } : {}),
    ...(activeFetched ? { models: activeFetched.models, canSwitch, canSwitchThinking } : {}),
    loaded: Boolean(activeFetched),
    refresh,
    applyOverride,
  };
}

/**
 * React hook that synchronously provides inferred model/thinking metadata on mount (0ms wait)
 * and refreshes in the background via `fetchAgentModelsWithFallback` with 60s caching.
 */
export function useAutoAgentModelMeta(
  agent: Agent,
  opts?: { hasReasoningEvents?: boolean },
): AutoAgentModelMeta {
  const hasReasoningEvents = opts?.hasReasoningEvents;

  const [fetched, setFetched] = useState<{
    key: string;
    res: AgentModelsResult;
  } | null>(() => {
    if (agent.isShell) return null;
    const hit = getCachedEntry(agent);
    return hit ? { key: agent.key, res: hit } : null;
  });

  const [override, setOverride] = useState<{
    key: string;
    currentModel?: string;
    currentThinking?: string;
    fallbackThinkingCandidate?: string;
    modelRoles?: Record<string, string>;
  } | null>(null);

  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (agent.isShell) return;
    let alive = true;
    const force = rev > 0;
    const peers = collectPeerModels(agent);
    void fetchAgentModelsWithFallback(agent, peers, {
      force,
      hasReasoningEvents,
      onUpdate: (res) => {
        if (alive) setFetched({ key: agent.key, res });
      },
    }).then((res) => {
      if (alive) setFetched({ key: agent.key, res });
    });
    return () => {
      alive = false;
    };
  }, [agent.key, agent.deviceId, agent.harness, agent.model, agent.sessionKey, agent.source, agent.isShell, hasReasoningEvents, rev]);

  const refresh = useCallback(() => {
    invalidateModelCatalogCache(agent.key);
    setRev((n) => n + 1);
  }, [agent.key]);

  const applyOverride = useCallback(
    (patch: { currentModel?: string; currentThinking?: string; modelRoles?: Record<string, string> }) => {
      patchCachedAgentModelMeta(agent.key, patch);
      setOverride((prev) => {
        const sameKey = prev?.key === agent.key;
        const nextModel = patch.currentModel
          ? stripModelEffortSuffix(patch.currentModel)
          : sameKey
            ? prev.currentModel
            : undefined;
        const explicitThinking = patch.currentThinking?.trim().toLowerCase() || undefined;
        const nextThinking = explicitThinking
          ? explicitThinking
          : patch.currentModel
            ? undefined
            : sameKey
              ? prev.currentThinking
              : undefined;
        const nextFallbackCandidate = explicitThinking
          ? undefined
          : patch.currentModel
            ? sameKey
              ? (prev.currentThinking ?? prev.fallbackThinkingCandidate)
              : undefined
            : sameKey
              ? prev.fallbackThinkingCandidate
              : undefined;
        return {
          key: agent.key,
          currentModel: nextModel,
          currentThinking: nextThinking,
          fallbackThinkingCandidate: nextFallbackCandidate,
          modelRoles: patch.modelRoles
            ? { ...(sameKey ? prev.modelRoles : undefined), ...patch.modelRoles }
            : sameKey
              ? prev.modelRoles
              : undefined,
        };
      });
    },
    [agent.key],
  );

  const activeFetched = fetched?.key === agent.key ? fetched.res : null;
  const activeOverride = override?.key === agent.key ? override : null;

  return computeAutoAgentModelMeta(agent, {
    fetched: activeFetched,
    override: activeOverride,
    hasReasoningEvents,
    refresh,
    applyOverride,
  });
}
