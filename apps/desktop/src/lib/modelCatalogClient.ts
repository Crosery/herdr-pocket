import { useCallback, useEffect, useMemo, useState } from "react";
import {
  inferAgentModelAndThinking,
  normalizeSwitchHarness,
  stripModelEffortSuffix,
  synthesizeFallbackAgentModels,
  type Agent,
  type AgentModelOption,
  type AgentModelsResult,
} from "@herdr-pocket/protocol";
import { isTauri } from "./bridge";
import { ensureLocalHostDeviceId, localHostIdStore } from "./fonts";
import { liveStore } from "./store";

const CACHE_TTL_MS = 60_000;
const TRANSIENT_FALLBACK_TTL_MS = 10_000;

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

/** Optimistically updates cached model/thinking metadata after a user switch. */
export function patchCachedAgentModelMeta(
  agentKey: string,
  patch: { currentModel?: string; currentThinking?: string },
): void {
  const entry = modelsCache.get(agentKey);
  if (!entry) return;
  const nextModel = patch.currentModel ? stripModelEffortSuffix(patch.currentModel) : entry.res.currentModel;
  const nextThinking = patch.currentThinking?.trim().toLowerCase() || entry.res.currentThinking;
  const matchedOpt = nextModel
    ? entry.res.models.find((m) => m.id.toLowerCase() === nextModel.toLowerCase())
    : undefined;
  const isNonReasoning = matchedOpt?.reasoning === false;
  entry.res = {
    ...entry.res,
    ...(nextModel ? { currentModel: nextModel } : {}),
    ...(isNonReasoning
      ? { currentThinking: undefined, thinkingLevels: undefined, canSwitchThinking: false }
      : nextThinking
        ? { currentThinking: nextThinking }
        : {}),
    ...(matchedOpt?.thinkingLevels?.length ? { thinkingLevels: matchedOpt.thinkingLevels, canSwitchThinking: entry.res.canSwitch } : {}),
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

function normalizeLocalResultForAgent(raw: AgentModelsResult, agent: Agent): AgentModelsResult {
  const canSwitch = !agent.isShell && (agent.source === "hc" || agent.source === "herdr");
  const reason = agent.isShell
    ? "普通终端不支持切换模型"
    : agent.source === "uniflo"
      ? "历史只读会话无法直接切换模型"
      : raw.reason;
  return {
    ...raw,
    harness: agent.harness,
    canSwitch,
    canSwitchThinking: canSwitch && Boolean(raw.thinkingLevels?.length),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Fetches an agent's model catalog & live thinking state with full multi-layer fallback:
 * 1. Remote/host `agent.models` RPC
 * 2. Native desktop Tauri `local_agent_models` command when target is this computer
 * 3. Client-side `synthesizeFallbackAgentModels` using peer models & harness presets
 * Never surfaces `unknown method agent.models` errors.
 */
export async function fetchAgentModelsWithFallback(
  agent: Agent,
  peerModels: readonly string[] = collectPeerModels(agent),
  opts: { force?: boolean; deps?: Partial<ModelCatalogDeps> } = {},
): Promise<AgentModelsResult> {
  if (agent.isShell) {
    return synthesizeFallbackAgentModels(agent, []);
  }

  const useDefaultDeps = !opts.deps;
  if (!opts.force && useDefaultDeps) {
    const cached = getCachedEntry(agent);
    if (cached) return cached;
  }

  const reqKey = `${agent.deviceId}\0${agent.key}\0${agent.model ?? ""}\0${agent.sessionKey ?? ""}`;
  if (!opts.force && useDefaultDeps) {
    const existing = inflightRequests.get(reqKey);
    if (existing) return existing;
  }

  const deps: ModelCatalogDeps = { ...defaultDeps, ...opts.deps };

  const task = (async (): Promise<AgentModelsResult> => {
    let ttl = CACHE_TTL_MS;
    try {
      const rpcRes = await deps.rpcCall(agent.deviceId, agent.key);
      if (rpcRes && (rpcRes.models.length > 0 || !deps.isTauri())) {
        if (rpcRes.models.length === 0) {
          const synth = synthesizeFallbackAgentModels(agent, peerModels);
          return {
            ...rpcRes,
            models: synth.models,
            ...(rpcRes.thinkingLevels?.length ? {} : synth.thinkingLevels?.length ? { thinkingLevels: synth.thinkingLevels, canSwitchThinking: rpcRes.canSwitch, thinkingLabel: "思考等级" } : {}),
          };
        }
        return rpcRes;
      }
    } catch (err) {
      if (!isUnsupportedRpcError(err)) {
        ttl = TRANSIENT_FALLBACK_TTL_MS;
      }
    }

    if (deps.isTauri()) {
      try {
        const localId = await deps.getLocalHostId();
        if (localId && localId === agent.deviceId) {
          const localRes = await deps.invokeLocalAgentModels({
            harness: agent.harness,
            currentModel: agent.model ?? null,
            sessionKey: agent.sessionKey ?? null,
          });
          if (localRes && Array.isArray(localRes.models) && (localRes.models.length > 0 || localRes.thinkingLevels?.length)) {
            return normalizeLocalResultForAgent(localRes, agent);
          }
        }
      } catch {
        // Fall through to client-side synthesis.
      }
    }

    return synthesizeFallbackAgentModels(agent, peerModels);
  })();

  if (useDefaultDeps) {
    inflightRequests.set(reqKey, task);
  }
  try {
    const result = await task;
    if (useDefaultDeps) {
      modelsCache.set(agent.key, {
        at: Date.now(),
        ttl: result.models.length > 0 ? CACHE_TTL_MS : TRANSIENT_FALLBACK_TTL_MS,
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
  canSwitch?: boolean;
  canSwitchThinking?: boolean;
  loaded: boolean;
  refresh: () => void;
  applyOverride: (patch: { currentModel?: string; currentThinking?: string }) => void;
}

/**
 * React hook that synchronously provides inferred model/thinking metadata on mount (0ms wait)
 * and refreshes in the background via `fetchAgentModelsWithFallback` with 60s caching.
 */
export function useAutoAgentModelMeta(agent: Agent): AutoAgentModelMeta {
  const inferred = useMemo(
    () => (agent.isShell ? {} : inferAgentModelAndThinking(agent.harness, agent.model)),
    [agent.isShell, agent.harness, agent.model],
  );

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
  } | null>(null);

  const [rev, setRev] = useState(0);

  useEffect(() => {
    if (agent.isShell) return;
    let alive = true;
    const force = rev > 0;
    const peers = collectPeerModels(agent);
    void fetchAgentModelsWithFallback(agent, peers, { force }).then((res) => {
      if (alive) setFetched({ key: agent.key, res });
    });
    return () => {
      alive = false;
    };
  }, [agent.key, agent.deviceId, agent.harness, agent.model, agent.sessionKey, agent.source, agent.isShell, rev]);

  const refresh = useCallback(() => {
    invalidateModelCatalogCache(agent.key);
    setRev((n) => n + 1);
  }, [agent.key]);

  const applyOverride = useCallback(
    (patch: { currentModel?: string; currentThinking?: string }) => {
      patchCachedAgentModelMeta(agent.key, patch);
      setOverride((prev) => ({
        key: agent.key,
        currentModel: patch.currentModel ? stripModelEffortSuffix(patch.currentModel) : prev?.key === agent.key ? prev.currentModel : undefined,
        currentThinking: patch.currentThinking?.trim().toLowerCase() || (prev?.key === agent.key ? prev.currentThinking : undefined),
      }));
    },
    [agent.key],
  );

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

  const activeFetched = fetched?.key === agent.key ? fetched.res : null;
  const activeOverride = override?.key === agent.key ? override : null;

  const currentModel =
    activeOverride?.currentModel || activeFetched?.currentModel || inferred.currentModel || agent.model;

  const matchedOption = currentModel && activeFetched
    ? activeFetched.models.find((m) => m.id.toLowerCase() === currentModel.toLowerCase())
    : undefined;

  const thinkingLevels = activeFetched
    ? matchedOption?.reasoning === false
      ? undefined
      : matchedOption?.thinkingLevels?.length
        ? matchedOption.thinkingLevels
        : activeFetched.thinkingLevels
    : inferred.thinkingLevels?.length
      ? inferred.thinkingLevels
      : undefined;

  const currentThinking =
    thinkingLevels?.length === 0 || (activeFetched && !thinkingLevels?.length)
      ? undefined
      : activeOverride?.currentThinking || activeFetched?.currentThinking || inferred.currentThinking;

  return {
    ...(currentModel ? { currentModel } : {}),
    ...(currentThinking ? { currentThinking } : {}),
    ...(thinkingLevels?.length ? { thinkingLevels } : {}),
    ...(activeFetched ? { models: activeFetched.models, canSwitch: activeFetched.canSwitch, canSwitchThinking: activeFetched.canSwitchThinking } : {}),
    loaded: Boolean(activeFetched),
    refresh,
    applyOverride,
  };
}
