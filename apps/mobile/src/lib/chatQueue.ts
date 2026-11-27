/**
 * Mobile chat pending prompt queue and fast-steer ("插队发送") controller.
 * Keeps parity with desktop's ChatGPT-style queue: when an agent is working, messages wait
 * in a visible local queue above the composer and auto-send once the turn finishes (or can
 * interrupt & steer immediately with one tap).
 */
import { AppState } from "react-native";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  buildHarnessSwitchCommands,
  isStaleWorkingAfterTurnEnd,
  stripModelEffortSuffix,
  type Agent,
  type ConvEvent,
} from "@herdr-pocket/protocol";
import type { Attachment } from "./attach";
import { sendOut, type SendResult } from "./outbox";
import { call } from "./relay";
import { safeAsyncStorage, useLive, usePending } from "./store";

export interface MobileQueuedPrompt {
  id: string;
  agentKey: string;
  deviceId: string;
  text: string;
  pictures: Attachment[];
  createdAt: number;
}

export interface MobilePendingSwitch {
  agentKey: string;
  deviceId: string;
  harness: string;
  modelId?: string;
  thinkingLevel?: string;
  label: string;
  createdAt: number;
}

interface MobileQueueState {
  byAgent: Record<string, MobileQueuedPrompt[]>;
  pendingSwitchByAgent: Record<string, MobilePendingSwitch>;
  steering: Record<string, boolean>;
  enqueue: (item: MobileQueuedPrompt) => void;
  setPendingSwitch: (item: MobilePendingSwitch) => void;
  clearPendingSwitch: (agentKey: string) => void;
  remove: (agentKey: string, id: string) => void;
  moveToTop: (agentKey: string, id: string) => void;
  pop: (agentKey: string, id: string) => MobileQueuedPrompt | null;
  shiftNext: (agentKey: string) => MobileQueuedPrompt | null;
  setSteering: (agentKey: string, on: boolean) => void;
}

const DRAIN_COOLDOWN_MS = 2500;
const STEER_SETTLE_MS = 180;
const QUEUE_PERSIST_MAX_CHARS = 1_500_000;

let idSeq = 0;
const nextId = () => `mq-${Date.now()}-${++idSeq}`;

function bumpSeqFromId(id: string): void {
  const m = /^mq-\d+-(\d+)$/.exec(id);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > idSeq) idSeq = n;
  }
}

function compactMobileQueue(byAgent: Record<string, MobileQueuedPrompt[]>): Record<string, MobileQueuedPrompt[]> {
  const out: Record<string, MobileQueuedPrompt[]> = {};
  for (const [agentKey, list] of Object.entries(byAgent)) {
    if (!Array.isArray(list) || !list.length) continue;
    out[agentKey] = list.map((item) => ({
      ...item,
      pictures: Array.isArray(item.pictures) ? item.pictures.map((p) => ({ ...p })) : [],
    }));
  }
  if (JSON.stringify({ byAgent: out }).length <= QUEUE_PERSIST_MAX_CHARS) {
    return out;
  }
  // Convert oversized picture payloads gracefully so queued prompts still survive restarts.
  const withPics: Array<{ item: MobileQueuedPrompt }> = [];
  for (const list of Object.values(out)) {
    for (const item of list) {
      if (item.pictures.length) withPics.push({ item });
    }
  }
  withPics.sort((a, b) => a.item.createdAt - b.item.createdAt);
  for (const { item } of withPics) {
    item.pictures = [];
    if (!item.text) {
      item.text = "（原附带图片体积过大未持久化，请补充后发送）";
    }
    if (JSON.stringify({ byAgent: out }).length <= QUEUE_PERSIST_MAX_CHARS) {
      return out;
    }
  }
  const keys = Object.keys(out);
  while (JSON.stringify({ byAgent: out }).length > QUEUE_PERSIST_MAX_CHARS && keys.length) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const k of keys) {
      const head = out[k]?.[0];
      if (head && head.createdAt < oldestAt) {
        oldestAt = head.createdAt;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    out[oldestKey]!.shift();
    if (!out[oldestKey]!.length) {
      delete out[oldestKey];
      keys.splice(keys.indexOf(oldestKey), 1);
    }
  }
  return out;
}

export const useMobileQueue = create<MobileQueueState>()(
  persist(
    (set, get) => ({
      byAgent: {},
      pendingSwitchByAgent: {},
      steering: {},
      enqueue: (item) =>
        set((s) => ({
          byAgent: {
            ...s.byAgent,
            [item.agentKey]: [...(s.byAgent[item.agentKey] ?? []), item],
          },
        })),
      setPendingSwitch: (item) =>
        set((s) => ({
          pendingSwitchByAgent: {
            ...s.pendingSwitchByAgent,
            [item.agentKey]: item,
          },
        })),
      clearPendingSwitch: (agentKey) =>
        set((s) => {
          if (!s.pendingSwitchByAgent[agentKey]) return s;
          const next = { ...s.pendingSwitchByAgent };
          delete next[agentKey];
          return { pendingSwitchByAgent: next };
        }),
      remove: (agentKey, id) =>
        set((s) => {
          const prev = s.byAgent[agentKey];
          if (!prev) return s;
          const next = prev.filter((x) => x.id !== id);
          const map = { ...s.byAgent };
          if (next.length) map[agentKey] = next;
          else delete map[agentKey];
          return { byAgent: map };
        }),
      moveToTop: (agentKey, id) =>
        set((s) => {
          const prev = s.byAgent[agentKey];
          if (!prev) return s;
          const idx = prev.findIndex((x) => x.id === id);
          if (idx <= 0) return s;
          const next = [prev[idx]!, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
          return { byAgent: { ...s.byAgent, [agentKey]: next } };
        }),
      pop: (agentKey, id) => {
        const prev = get().byAgent[agentKey];
        const target = prev?.find((x) => x.id === id) ?? null;
        if (!target) return null;
        get().remove(agentKey, id);
        return target;
      },
      shiftNext: (agentKey) => {
        const prev = get().byAgent[agentKey];
        if (!prev?.length) return null;
        const [head, ...rest] = prev;
        set((s) => {
          const map = { ...s.byAgent };
          if (rest.length) map[agentKey] = rest;
          else delete map[agentKey];
          return { byAgent: map };
        });
        return head!;
      },
      setSteering: (agentKey, on) =>
        set((s) => {
          const next = { ...s.steering };
          if (on) next[agentKey] = true;
          else delete next[agentKey];
          return { steering: next };
        }),
    }),
    {
      name: "hp.mobile.queue.v1",
      storage: createJSONStorage(() => safeAsyncStorage),
      partialize: (s) => ({
        byAgent: compactMobileQueue(s.byAgent),
        pendingSwitchByAgent: s.pendingSwitchByAgent,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        for (const list of Object.values(state.byAgent)) {
          for (const item of list) bumpSeqFromId(item.id);
        }
        if (watcherInstalled) {
          setTimeout(runDrainTick, 0);
        }
      },
    },
  ),
);

const inFlight = new Set<string>();
const dispatchState = new Map<string, { lastDispatchedAt: number; sawWorking: boolean; idleSince?: number }>();
const latestEventsByAgent = new Map<string, readonly ConvEvent[]>();
let watcherInstalled = false;
const IDLE_DEBOUNCE_MS = 600;
const RECENT_OUTGOING_MS = 15_000;

export function recordMobileSessionEvents(agentKey: string, events: readonly ConvEvent[]): void {
  if (!events.length) {
    latestEventsByAgent.delete(agentKey);
  } else {
    latestEventsByAgent.set(agentKey, events);
  }
}

export function getMobileSessionEvents(agentKey: string): readonly ConvEvent[] | undefined {
  return latestEventsByAgent.get(agentKey);
}

/**
 * True when an agent is genuinely busy executing a turn. Guards against older `hostd` / `hc`
 * instances stuck on `status: "working"` long after `turn_end` was recorded in the transcript.
 */
export function isMobileAgentEffectivelyWorking(
  agent: Pick<Agent, "key" | "status" | "statusSince">,
  eventsOverride?: readonly ConvEvent[],
  now = Date.now(),
): boolean {
  if (agent.status !== "working") return false;
  const events = eventsOverride ?? latestEventsByAgent.get(agent.key);
  if (!events || !events.length) return true;
  const track = dispatchState.get(agent.key);
  const pendingList = usePending.getState().byAgent[agent.key] ?? [];
  const hasRecentOutgoing =
    (track ? now - track.lastDispatchedAt < RECENT_OUTGOING_MS : false) ||
    pendingList.some((p) => p.state !== "failed" && now - p.ts < RECENT_OUTGOING_MS);
  return !isStaleWorkingAfterTurnEnd({
    status: agent.status,
    statusSince: agent.statusSince,
    events,
    now,
    hasRecentOutgoing,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function enqueueMobilePrompt(
  agent: Pick<Agent, "key" | "deviceId">,
  rawText: string,
  pictures: Attachment[] = [],
): MobileQueuedPrompt {
  const item: MobileQueuedPrompt = {
    id: nextId(),
    agentKey: agent.key,
    deviceId: agent.deviceId,
    text: rawText.trim(),
    pictures,
    createdAt: Date.now(),
  };
  useMobileQueue.getState().enqueue(item);
  return item;
}

export function scheduleMobilePendingSwitch(
  agent: Pick<Agent, "key" | "deviceId" | "harness">,
  patch: { modelId?: string; thinkingLevel?: string; label?: string },
): MobilePendingSwitch | null {
  const modelId = patch.modelId?.trim() || undefined;
  const thinkingLevel = patch.thinkingLevel?.trim().toLowerCase() || undefined;
  if (!modelId && !thinkingLevel) return null;
  const store = useMobileQueue.getState();
  const prev = store.pendingSwitchByAgent[agent.key];
  const nextModel = modelId ?? prev?.modelId;
  const nextThinking = thinkingLevel ?? prev?.thinkingLevel;
  const baseLabel = nextModel ? stripModelEffortSuffix(nextModel) : "";
  const autoLabel = [baseLabel, nextThinking ? `思考 ${nextThinking}` : ""].filter(Boolean).join(" · ");
  const label =
    patch.label?.trim() && !(modelId && !thinkingLevel && prev?.thinkingLevel) && !(!modelId && thinkingLevel && prev?.modelId)
      ? patch.label.trim()
      : autoLabel || patch.label?.trim() || "模型配置";
  const next: MobilePendingSwitch = {
    agentKey: agent.key,
    deviceId: agent.deviceId,
    harness: agent.harness,
    ...(nextModel ? { modelId: nextModel } : {}),
    ...(nextThinking ? { thinkingLevel: nextThinking } : {}),
    label,
    createdAt: Date.now(),
  };
  store.setPendingSwitch(next);
  return next;
}

export function cancelMobilePendingSwitch(agentKey: string): void {
  useMobileQueue.getState().clearPendingSwitch(agentKey);
}

async function deliverMobilePendingSwitch(sw: MobilePendingSwitch): Promise<void> {
  try {
    await call(sw.deviceId, "agent.setModel", {
      agent: sw.agentKey,
      ...(sw.modelId ? { modelId: sw.modelId } : {}),
      ...(sw.thinkingLevel ? { thinkingLevel: sw.thinkingLevel } : {}),
    });
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    const unsupported =
      err?.code === "unsupported" ||
      err?.code === "bad_request" ||
      /unknown|unsupported|不支持/i.test(err?.message ?? "");
    if (unsupported) {
      const plan = buildHarnessSwitchCommands(sw.harness, {
        modelId: sw.modelId,
        thinkingLevel: sw.thinkingLevel,
      });
      for (const cmd of plan.commands) {
        await call(sw.deviceId, "terminal.send", { agent: sw.agentKey, text: cmd, enter: true }).catch(() => undefined);
      }
    }
  }
}

export function removeMobileQueuedPrompt(agentKey: string, id: string): void {
  useMobileQueue.getState().remove(agentKey, id);
}

export function moveMobileQueuedPromptToTop(agentKey: string, id: string): void {
  useMobileQueue.getState().moveToTop(agentKey, id);
}

export function popMobileQueuedPromptForEdit(agentKey: string, id: string): MobileQueuedPrompt | null {
  return useMobileQueue.getState().pop(agentKey, id);
}

/** Non-destructive soft steer ("插队发送") from the mobile queue shelf. */
export async function steerMobileQueuedPromptNow(agent: Agent, id: string): Promise<SendResult> {
  const store = useMobileQueue.getState();
  if (store.steering[agent.key] || inFlight.has(agent.key)) {
    return { ok: false, message: "正在插队发送，请稍候" };
  }
  const popped = store.pop(agent.key, id);
  if (!popped) return { ok: false, message: "这条排队消息已不存在" };
  return softSteerSend(agent, popped.text, popped.pictures);
}

/** Explicit interrupt-and-send ("打断当前轮并发送") from the mobile queue shelf. */
export async function interruptAndSendMobileQueuedPrompt(agent: Agent, id: string): Promise<SendResult> {
  const store = useMobileQueue.getState();
  if (store.steering[agent.key] || inFlight.has(agent.key)) {
    return { ok: false, message: "正在操作，请稍候" };
  }
  const popped = store.pop(agent.key, id);
  if (!popped) return { ok: false, message: "这条排队消息已不存在" };
  return interruptAndSend(agent, popped.text, popped.pictures);
}

/** Non-destructive soft steer from the mobile composer. */
export async function steerMobileComposerNow(
  agent: Agent,
  rawText: string,
  pictures: Attachment[] = [],
): Promise<SendResult> {
  const clean = rawText.trim();
  if (!clean && !pictures.length) return { ok: false, message: "内容为空" };
  if (useMobileQueue.getState().steering[agent.key] || inFlight.has(agent.key)) {
    return { ok: false, message: "正在插队发送，请稍候" };
  }
  return softSteerSend(agent, clean, pictures);
}

async function softSteerSend(agent: Agent, text: string, pictures: Attachment[]): Promise<SendResult> {
  const store = useMobileQueue.getState();
  dispatchState.delete(agent.key);
  inFlight.add(agent.key);
  store.setSteering(agent.key, true);
  try {
    return await sendOut(agent, text, pictures, "steer");
  } finally {
    inFlight.delete(agent.key);
    store.setSteering(agent.key, false);
  }
}

async function interruptAndSend(agent: Agent, text: string, pictures: Attachment[]): Promise<SendResult> {
  const store = useMobileQueue.getState();
  dispatchState.delete(agent.key);
  inFlight.add(agent.key);
  store.setSteering(agent.key, true);
  try {
    if (agent.status === "working") {
      await call(agent.deviceId, "terminal.interrupt", { agent: agent.key }).catch(() => undefined);
      await sleep(STEER_SETTLE_MS);
    }
    return await sendOut(agent, text, pictures, "auto");
  } finally {
    inFlight.delete(agent.key);
    store.setSteering(agent.key, false);
  }
}

function runDrainTick(): void {
  const now = Date.now();
  const qState = useMobileQueue.getState();
  const live = useLive.getState();
  const all = Object.values(live.agents).flat();
  const byKey = new Map(all.map((a) => [a.key, a]));

  for (const [key, track] of dispatchState) {
    const a = byKey.get(key);
    const hasQueue = (qState.byAgent[key]?.length ?? 0) > 0 || Boolean(qState.pendingSwitchByAgent[key]);
    if (!a) {
      dispatchState.delete(key);
      continue;
    }
    if (a.status === "working") {
      track.sawWorking = true;
      track.idleSince = undefined;
    } else if (track.sawWorking && (a.status === "done" || a.status === "idle")) {
      if (!track.idleSince) track.idleSince = now;
      if (now - track.idleSince >= IDLE_DEBOUNCE_MS) {
        track.lastDispatchedAt = 0;
        track.sawWorking = false;
        track.idleSince = undefined;
      }
    } else if (!hasQueue) {
      dispatchState.delete(key);
    } else {
      track.idleSince = undefined;
    }
  }

  for (const [key, sw] of Object.entries(qState.pendingSwitchByAgent)) {
    const agent = byKey.get(key);
    if (!agent) continue;
    const online = Boolean(live.devices[agent.deviceId]?.online);
    if (!online || inFlight.has(key) || qState.steering[key]) continue;
    const staleWorking = agent.status === "working" && !isMobileAgentEffectivelyWorking(agent, undefined, now);
    if (agent.status !== "idle" && agent.status !== "done" && !staleWorking) continue;
    const track = dispatchState.get(key);
    if (track?.idleSince && now - track.idleSince < IDLE_DEBOUNCE_MS) continue;
    if (now - (track?.lastDispatchedAt ?? 0) < DRAIN_COOLDOWN_MS) continue;

    useMobileQueue.getState().clearPendingSwitch(key);
    inFlight.add(key);
    dispatchState.set(key, { lastDispatchedAt: now, sawWorking: false });
    void deliverMobilePendingSwitch(sw).finally(() => {
      inFlight.delete(key);
      if ((useMobileQueue.getState().byAgent[key]?.length ?? 0) > 0) {
        dispatchState.set(key, { lastDispatchedAt: Date.now() - DRAIN_COOLDOWN_MS + 300, sawWorking: false });
      }
    });
  }

  const nextQueueState = useMobileQueue.getState();
  for (const [key, queue] of Object.entries(nextQueueState.byAgent)) {
    if (!queue.length) continue;
    const agent = byKey.get(key);
    if (!agent) continue;
    const online = Boolean(live.devices[agent.deviceId]?.online);
    if (!online || inFlight.has(key) || nextQueueState.steering[key]) continue;
    const staleWorking = agent.status === "working" && !isMobileAgentEffectivelyWorking(agent, undefined, now);
    if (agent.status !== "idle" && agent.status !== "done" && !staleWorking) continue;
    const track = dispatchState.get(key);
    if (track?.idleSince && now - track.idleSince < IDLE_DEBOUNCE_MS) continue;
    if (now - (track?.lastDispatchedAt ?? 0) < DRAIN_COOLDOWN_MS) continue;

    const next = nextQueueState.shiftNext(key);
    if (!next) continue;
    inFlight.add(key);
    dispatchState.set(key, { lastDispatchedAt: now, sawWorking: false });
    void sendOut(agent, next.text, next.pictures).finally(() => {
      inFlight.delete(key);
    });
  }
}

export function ensureMobileQueueWatcher(): void {
  if (watcherInstalled) return;
  watcherInstalled = true;
  useLive.subscribe(runDrainTick);
  AppState.addEventListener("change", (st) => {
    if (st === "active") runDrainTick();
  });
  setInterval(runDrainTick, 1000);
  runDrainTick();
}
