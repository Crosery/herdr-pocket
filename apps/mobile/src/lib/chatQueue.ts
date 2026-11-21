/**
 * Mobile chat pending prompt queue and fast-steer ("插队发送") controller.
 * Keeps parity with desktop's ChatGPT-style queue: when an agent is working, messages wait
 * in a visible local queue above the composer and auto-send once the turn finishes (or can
 * interrupt & steer immediately with one tap).
 */
import { AppState } from "react-native";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Agent } from "@herdr-pocket/protocol";
import type { Attachment } from "./attach";
import { sendOut, type SendResult } from "./outbox";
import { call } from "./relay";
import { safeAsyncStorage, useLive } from "./store";

export interface MobileQueuedPrompt {
  id: string;
  agentKey: string;
  deviceId: string;
  text: string;
  pictures: Attachment[];
  createdAt: number;
}

interface MobileQueueState {
  byAgent: Record<string, MobileQueuedPrompt[]>;
  steering: Record<string, boolean>;
  enqueue: (item: MobileQueuedPrompt) => void;
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
      steering: {},
      enqueue: (item) =>
        set((s) => ({
          byAgent: {
            ...s.byAgent,
            [item.agentKey]: [...(s.byAgent[item.agentKey] ?? []), item],
          },
        })),
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
      partialize: (s) => ({ byAgent: compactMobileQueue(s.byAgent) }),
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
const dispatchState = new Map<string, { lastDispatchedAt: number; sawWorking: boolean }>();
let watcherInstalled = false;

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

export function removeMobileQueuedPrompt(agentKey: string, id: string): void {
  useMobileQueue.getState().remove(agentKey, id);
}

export function moveMobileQueuedPromptToTop(agentKey: string, id: string): void {
  useMobileQueue.getState().moveToTop(agentKey, id);
}

export function popMobileQueuedPromptForEdit(agentKey: string, id: string): MobileQueuedPrompt | null {
  return useMobileQueue.getState().pop(agentKey, id);
}

export async function steerMobileQueuedPromptNow(agent: Agent, id: string): Promise<SendResult> {
  const store = useMobileQueue.getState();
  if (store.steering[agent.key] || inFlight.has(agent.key)) {
    return { ok: false, message: "正在插队发送，请稍候" };
  }
  const popped = store.pop(agent.key, id);
  if (!popped) return { ok: false, message: "这条排队消息已不存在" };
  return interruptAndSend(agent, popped.text, popped.pictures);
}

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
  return interruptAndSend(agent, clean, pictures);
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
    return await sendOut(agent, text, pictures);
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
    const hasQueue = (qState.byAgent[key]?.length ?? 0) > 0;
    if (!a) {
      dispatchState.delete(key);
      continue;
    }
    if (a.status === "working") {
      track.sawWorking = true;
    } else if (track.sawWorking && (a.status === "done" || a.status === "idle")) {
      track.lastDispatchedAt = 0;
      track.sawWorking = false;
    } else if (!hasQueue) {
      dispatchState.delete(key);
    }
  }

  for (const [key, queue] of Object.entries(qState.byAgent)) {
    if (!queue.length) continue;
    const agent = byKey.get(key);
    if (!agent) continue;
    const online = Boolean(live.devices[agent.deviceId]?.online);
    if (!online || inFlight.has(key) || qState.steering[key]) continue;
    if (agent.status !== "idle" && agent.status !== "done") continue;
    const track = dispatchState.get(key);
    if (now - (track?.lastDispatchedAt ?? 0) < DRAIN_COOLDOWN_MS) continue;

    const next = qState.shiftNext(key);
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
