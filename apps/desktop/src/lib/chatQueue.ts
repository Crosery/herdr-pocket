import { useEffect } from "react";
import { textWithFiles, type Agent } from "@herdr-pocket/protocol";
import {
  reconcileOutgoingSends,
  shouldAutoDrainQueue,
  type OutgoingSendLike,
} from "./chatQueueLogic";
import { revokeAttachment, type StagedAttachment } from "./dropPreview";
import { rpcCall } from "./relay";
import { allAgents, createStore, liveStore } from "./store";

export { reconcileOutgoingSends, shouldAutoDrainQueue, type OutgoingSendLike };

export interface OutgoingSend extends OutgoingSendLike {
  agentKey: string;
  deviceId: string;
  attachments: StagedAttachment[];
  attachedNames: string[];
  error?: string;
}

export interface QueuedPrompt {
  id: string;
  agentKey: string;
  deviceId: string;
  text: string;
  attachments: StagedAttachment[];
  createdAt: number;
}

interface ChatQueueState {
  queuedByAgent: Record<string, QueuedPrompt[]>;
  outgoingByAgent: Record<string, OutgoingSend[]>;
}

const EMPTY_QUEUED: QueuedPrompt[] = [];
const EMPTY_OUTGOING: OutgoingSend[] = [];
const STEER_SETTLE_MS = 180;

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++idSeq}`;

export const chatQueueStore = createStore<ChatQueueState>({
  queuedByAgent: {},
  outgoingByAgent: {},
});

function updateOutgoing(
  agentKey: string,
  updater: (prev: OutgoingSend[]) => OutgoingSend[],
): void {
  chatQueueStore.set((state) => {
    const cur = state.outgoingByAgent[agentKey] ?? EMPTY_OUTGOING;
    const next = updater(cur);
    if (next === cur) return state;
    const nextMap = { ...state.outgoingByAgent };
    if (next.length === 0) delete nextMap[agentKey];
    else nextMap[agentKey] = next;
    return { ...state, outgoingByAgent: nextMap };
  });
}

function updateQueued(
  agentKey: string,
  updater: (prev: QueuedPrompt[]) => QueuedPrompt[],
): void {
  chatQueueStore.set((state) => {
    const cur = state.queuedByAgent[agentKey] ?? EMPTY_QUEUED;
    const next = updater(cur);
    if (next === cur) return state;
    const nextMap = { ...state.queuedByAgent };
    if (next.length === 0) delete nextMap[agentKey];
    else nextMap[agentKey] = next;
    return { ...state, queuedByAgent: nextMap };
  });
}

async function deliverOutgoing(send: OutgoingSend): Promise<boolean> {
  try {
    let body = send.text;
    if (send.attachments.length > 0) {
      const uploaded = await rpcCall(
        send.deviceId,
        "terminal.put",
        { agent: send.agentKey, files: send.attachments.map((s) => s.put) },
        30_000,
      );
      body = textWithFiles(send.text, uploaded.paths);
    }
    await rpcCall(send.deviceId, "terminal.send", {
      agent: send.agentKey,
      text: body,
      enter: true,
    });
    for (const a of send.attachments) revokeAttachment(a);
    updateOutgoing(send.agentKey, (list) =>
      list.map((x) => (x.id === send.id ? { ...x, state: "sent", attachments: [], error: undefined } : x)),
    );
    return true;
  } catch (e) {
    const message = (e as Error).message || "发送失败";
    updateOutgoing(send.agentKey, (list) =>
      list.map((x) => (x.id === send.id ? { ...x, state: "failed", error: message } : x)),
    );
    return false;
  }
}

export async function sendPromptNow(
  agent: Pick<Agent, "key" | "deviceId">,
  rawText: string,
  attachments: StagedAttachment[],
): Promise<boolean> {
  const clean = rawText.trim();
  if (!clean && attachments.length === 0) return false;
  const entry: OutgoingSend = {
    id: nextId("out"),
    agentKey: agent.key,
    deviceId: agent.deviceId,
    text: clean,
    attachments,
    attachedCount: attachments.length,
    attachedNames: attachments.map((a) => a.name),
    ts: Date.now(),
    state: "sending",
  };
  updateOutgoing(agent.key, (list) => [...list, entry]);
  return deliverOutgoing(entry);
}

export async function retryFailedSend(sendId: string, agentKey: string): Promise<boolean> {
  const target = (chatQueueStore.get().outgoingByAgent[agentKey] ?? EMPTY_OUTGOING).find(
    (s) => s.id === sendId && s.state === "failed",
  );
  if (!target) return false;
  const refreshed: OutgoingSend = { ...target, ts: Date.now(), state: "sending", error: undefined };
  updateOutgoing(agentKey, (list) => list.map((s) => (s.id === sendId ? refreshed : s)));
  return deliverOutgoing(refreshed);
}

export function dismissOutgoingSend(agentKey: string, sendId: string): void {
  const cur = chatQueueStore.get().outgoingByAgent[agentKey] ?? EMPTY_OUTGOING;
  const target = cur.find((s) => s.id === sendId);
  if (!target) return;
  for (const a of target.attachments) revokeAttachment(a);
  updateOutgoing(agentKey, (list) => list.filter((s) => s.id !== sendId));
}

export function pruneOutgoingSends(agentKey: string, dropIds: string[]): void {
  if (!dropIds.length) return;
  const drop = new Set(dropIds);
  const cur = chatQueueStore.get().outgoingByAgent[agentKey] ?? EMPTY_OUTGOING;
  let hasDrop = false;
  for (const item of cur) {
    if (drop.has(item.id)) {
      hasDrop = true;
      for (const a of item.attachments) revokeAttachment(a);
    }
  }
  if (!hasDrop) return;
  updateOutgoing(agentKey, (list) => list.filter((s) => !drop.has(s.id)));
}

export function enqueuePrompt(
  agent: Pick<Agent, "key" | "deviceId">,
  rawText: string,
  attachments: StagedAttachment[],
): QueuedPrompt {
  const item: QueuedPrompt = {
    id: nextId("q"),
    agentKey: agent.key,
    deviceId: agent.deviceId,
    text: rawText.trim(),
    attachments,
    createdAt: Date.now(),
  };
  updateQueued(agent.key, (list) => [...list, item]);
  return item;
}

export function removeQueuedPrompt(agentKey: string, id: string): void {
  const cur = chatQueueStore.get().queuedByAgent[agentKey] ?? EMPTY_QUEUED;
  const target = cur.find((q) => q.id === id);
  if (!target) return;
  for (const a of target.attachments) revokeAttachment(a);
  updateQueued(agentKey, (list) => list.filter((q) => q.id !== id));
}

export function popQueuedPromptForEdit(agentKey: string, id: string): QueuedPrompt | null {
  const cur = chatQueueStore.get().queuedByAgent[agentKey] ?? EMPTY_QUEUED;
  const target = cur.find((q) => q.id === id) ?? null;
  if (!target) return null;
  updateQueued(agentKey, (list) => list.filter((q) => q.id !== id));
  return target;
}

export function moveQueuedPromptToTop(agentKey: string, id: string): void {
  updateQueued(agentKey, (list) => {
    const idx = list.findIndex((q) => q.id === id);
    if (idx <= 0) return list;
    const target = list[idx]!;
    return [target, ...list.slice(0, idx), ...list.slice(idx + 1)];
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function steerQueuedPromptNow(
  agent: Pick<Agent, "key" | "deviceId">,
  id: string,
): Promise<void> {
  if (inFlightAgents.has(agent.key)) return;
  const popped = popQueuedPromptForEdit(agent.key, id);
  if (!popped) return;
  dispatchState.delete(agent.key);
  inFlightAgents.add(agent.key);
  try {
    await rpcCall(agent.deviceId, "terminal.interrupt", { agent: agent.key }).catch(() => {});
    await waitMs(STEER_SETTLE_MS);
    await sendPromptNow(agent, popped.text, popped.attachments);
  } finally {
    inFlightAgents.delete(agent.key);
  }
}

export async function steerComposerNow(
  agent: Pick<Agent, "key" | "deviceId">,
  rawText: string,
  attachments: StagedAttachment[],
): Promise<void> {
  if (inFlightAgents.has(agent.key)) return;
  const clean = rawText.trim();
  if (!clean && attachments.length === 0) return;
  dispatchState.delete(agent.key);
  inFlightAgents.add(agent.key);
  try {
    await rpcCall(agent.deviceId, "terminal.interrupt", { agent: agent.key }).catch(() => {});
    await waitMs(STEER_SETTLE_MS);
    await sendPromptNow(agent, clean, attachments);
  } finally {
    inFlightAgents.delete(agent.key);
  }
}

const inFlightAgents = new Set<string>();
const dispatchState = new Map<string, { lastDispatchedAt: number; sawWorking: boolean }>();
let watcherInstalled = false;

function runQueueDrainTick(): void {
  const now = Date.now();
  const state = chatQueueStore.get();
  const live = liveStore.get();
  const agents = allAgents(live.agents);
  const byKey = new Map(agents.map((a) => [a.key, a]));

  for (const [key, track] of dispatchState) {
    const agent = byKey.get(key);
    const hasQueue = (state.queuedByAgent[key]?.length ?? 0) > 0;
    if (!agent) {
      dispatchState.delete(key);
      continue;
    }
    if (agent.status === "working") {
      track.sawWorking = true;
    } else if (track.sawWorking && (agent.status === "done" || agent.status === "idle")) {
      track.lastDispatchedAt = 0;
      track.sawWorking = false;
    } else if (!hasQueue) {
      dispatchState.delete(key);
    }
  }

  for (const [key, queue] of Object.entries(state.queuedByAgent)) {
    if (!queue.length) continue;
    const agent = byKey.get(key);
    if (!agent) continue;
    const online = Boolean(live.devices[agent.deviceId]?.online);
    const track = dispatchState.get(key);
    if (!shouldAutoDrainQueue(agent.status, online, track?.lastDispatchedAt ?? 0, inFlightAgents.has(key), now)) {
      continue;
    }
    const nextItem = queue[0]!;
    updateQueued(key, (list) => list.slice(1));
    inFlightAgents.add(key);
    dispatchState.set(key, { lastDispatchedAt: now, sawWorking: false });
    void sendPromptNow(agent, nextItem.text, nextItem.attachments).finally(() => {
      inFlightAgents.delete(key);
    });
  }
}

export function ensureChatQueueWatcher(): void {
  if (watcherInstalled || typeof window === "undefined") return;
  watcherInstalled = true;
  liveStore.subscribe(runQueueDrainTick);
  window.setInterval(runQueueDrainTick, 1000);
}

export function useAgentChatQueue(agentKey: string): {
  queued: QueuedPrompt[];
  outgoing: OutgoingSend[];
} {
  useEffect(() => {
    ensureChatQueueWatcher();
  }, []);
  const queued = chatQueueStore.use((s) => s.queuedByAgent[agentKey] ?? EMPTY_QUEUED);
  const outgoing = chatQueueStore.use((s) => s.outgoingByAgent[agentKey] ?? EMPTY_OUTGOING);
  return { queued, outgoing };
}
