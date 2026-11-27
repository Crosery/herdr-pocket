import { useEffect, useMemo } from "react";
import { buildHarnessSwitchCommands, sameMessage, stripModelEffortSuffix, textWithFiles, type Agent } from "@herdr-pocket/protocol";
import {
  filterTerminalQueuedItems,
  reconcileOutgoingSends,
  shouldAutoDrainQueue,
  type OutgoingSendLike,
} from "./chatQueueLogic";
import {
  hydrateAttachment,
  revokeAttachment,
  serializeAttachment,
  type SerializedAttachment,
  type StagedAttachment,
} from "./dropPreview";
import { logger } from "./log";
import { localHostIdStore } from "./fonts";
import { native } from "./native";
import { isDirectConnected, rpcCall } from "./relay";
import { allAgents, createStore, liveStore } from "./store";
import { uploadRemoteFile } from "./uploadLargeFile";
import { registerWorkspaceSection, scheduleWorkspacePersist } from "./workspacePersist";

export { filterTerminalQueuedItems, reconcileOutgoingSends, shouldAutoDrainQueue, type OutgoingSendLike };

export type DeliveryMode = "auto" | "steer" | "interrupt";

export interface OutgoingSend extends OutgoingSendLike {
  agentKey: string;
  deviceId: string;
  attachments: StagedAttachment[];
  uploadedPaths?: string[];
  attachedNames: string[];
  progressText?: string;
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

export interface PendingModelSwitch {
  agentKey: string;
  deviceId: string;
  harness: string;
  modelId?: string;
  thinkingLevel?: string;
  label: string;
  createdAt: number;
}

export interface CapturedCommandEntry {
  id: string;
  agentKey: string;
  command: string;
  output: string;
  isError: boolean;
  panelState: "none" | "closed" | "interactive_open";
  ts: number;
}

interface InjectedTerminalRecord {
  text: string;
  at: number;
}

interface ChatQueueState {
  queuedByAgent: Record<string, QueuedPrompt[]>;
  outgoingByAgent: Record<string, OutgoingSend[]>;
  pendingSwitchByAgent: Record<string, PendingModelSwitch>;
  capturedByAgent: Record<string, CapturedCommandEntry[]>;
  injectedTerminalByAgent: Record<string, InjectedTerminalRecord[]>;
}

const EMPTY_QUEUED: QueuedPrompt[] = [];
const EMPTY_OUTGOING: OutgoingSend[] = [];
const EMPTY_CAPTURED: CapturedCommandEntry[] = [];
const EMPTY_INJECTED: InjectedTerminalRecord[] = [];
const DRAIN_COOLDOWN_MS = 3500;
const STEER_SETTLE_MS = 180;
const INJECTED_TERMINAL_TTL_MS = 15_000;
const INTERRUPTED_SEND_ERROR = "应用重启前发送中断，点击可重试";

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++idSeq}`;

export const chatQueueStore = createStore<ChatQueueState>({
  queuedByAgent: {},
  outgoingByAgent: {},
  pendingSwitchByAgent: {},
  capturedByAgent: {},
  injectedTerminalByAgent: {},
});

interface SerializedQueuedPrompt {
  id: string;
  agentKey: string;
  deviceId: string;
  text: string;
  attachments: SerializedAttachment[];
  createdAt: number;
}

interface SerializedOutgoingSend {
  id: string;
  agentKey: string;
  deviceId: string;
  text: string;
  attachments: SerializedAttachment[];
  uploadedPaths?: string[];
  attachedCount: number;
  attachedNames: string[];
  ts: number;
  state: OutgoingSend["state"];
  error?: string;
}

interface SerializedChatQueueState {
  queuedByAgent: Record<string, SerializedQueuedPrompt[]>;
  outgoingByAgent: Record<string, SerializedOutgoingSend[]>;
  pendingSwitchByAgent?: Record<string, PendingModelSwitch>;
}

function bumpIdSeq(id: string): void {
  const m = /^(?:q|out)-\d+-(\d+)$/.exec(id);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > idSeq) idSeq = n;
  }
}

function parseSerializedAttachments(raw: unknown): StagedAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: StagedAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<SerializedAttachment>;
    if (typeof rec.id !== "string" || typeof rec.name !== "string") continue;
    out.push(hydrateAttachment(rec as SerializedAttachment));
  }
  return out;
}

function serializeChatQueue(): SerializedChatQueueState | undefined {
  const state = chatQueueStore.get();
  const queuedByAgent: Record<string, SerializedQueuedPrompt[]> = {};
  for (const [key, list] of Object.entries(state.queuedByAgent)) {
    if (!list.length) continue;
    queuedByAgent[key] = list.map((item) => ({
      ...item,
      attachments: item.attachments.map(serializeAttachment),
    }));
  }
  const outgoingByAgent: Record<string, SerializedOutgoingSend[]> = {};
  for (const [key, list] of Object.entries(state.outgoingByAgent)) {
    const keep = list.filter((item) => item.state !== "sent" && item.state !== "queued_terminal");
    if (!keep.length) continue;
    outgoingByAgent[key] = keep.map((item) => ({
      ...item,
      attachments: item.attachments.map(serializeAttachment),
    }));
  }
  const pendingSwitchByAgent: Record<string, PendingModelSwitch> = {};
  for (const [key, sw] of Object.entries(state.pendingSwitchByAgent)) {
    if (sw && (sw.modelId || sw.thinkingLevel)) {
      pendingSwitchByAgent[key] = sw;
    }
  }
  if (!Object.keys(queuedByAgent).length && !Object.keys(outgoingByAgent).length && !Object.keys(pendingSwitchByAgent).length) {
    return undefined;
  }
  return {
    queuedByAgent,
    outgoingByAgent,
    ...(Object.keys(pendingSwitchByAgent).length ? { pendingSwitchByAgent } : {}),
  };
}

function hydrateChatQueue(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const obj = raw as Record<string, unknown>;
  const queuedByAgent: Record<string, QueuedPrompt[]> = {};
  if (obj.queuedByAgent && typeof obj.queuedByAgent === "object" && !Array.isArray(obj.queuedByAgent)) {
    for (const [agentKey, list] of Object.entries(obj.queuedByAgent as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const restored: QueuedPrompt[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const r = entry as Record<string, unknown>;
        if (typeof r.id !== "string" || typeof r.deviceId !== "string" || typeof r.text !== "string") continue;
        bumpIdSeq(r.id);
        restored.push({
          id: r.id,
          agentKey: typeof r.agentKey === "string" ? r.agentKey : agentKey,
          deviceId: r.deviceId,
          text: r.text,
          attachments: parseSerializedAttachments(r.attachments),
          createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
        });
      }
      if (restored.length) queuedByAgent[agentKey] = restored;
    }
  }

  const outgoingByAgent: Record<string, OutgoingSend[]> = {};
  if (obj.outgoingByAgent && typeof obj.outgoingByAgent === "object" && !Array.isArray(obj.outgoingByAgent)) {
    for (const [agentKey, list] of Object.entries(obj.outgoingByAgent as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const restored: OutgoingSend[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const r = entry as Record<string, unknown>;
        if (typeof r.id !== "string" || typeof r.deviceId !== "string" || typeof r.text !== "string") continue;
        if (r.state === "sent" || r.state === "queued_terminal") continue;
        bumpIdSeq(r.id);
        const attachments = parseSerializedAttachments(r.attachments);
        const uploadedPaths = Array.isArray(r.uploadedPaths)
          ? r.uploadedPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
          : undefined;
        const wasSending = r.state === "sending";
        const attachedNames = Array.isArray(r.attachedNames)
          ? r.attachedNames.filter((n): n is string => typeof n === "string")
          : attachments.map((a) => a.name);
        restored.push({
          id: r.id,
          agentKey: typeof r.agentKey === "string" ? r.agentKey : agentKey,
          deviceId: r.deviceId,
          text: r.text,
          attachments,
          ...(uploadedPaths?.length ? { uploadedPaths } : {}),
          attachedCount: typeof r.attachedCount === "number" ? r.attachedCount : attachments.length,
          attachedNames,
          ts: typeof r.ts === "number" ? r.ts : Date.now(),
          state: "failed",
          error: wasSending
            ? INTERRUPTED_SEND_ERROR
            : typeof r.error === "string" && r.error
              ? r.error
              : "发送失败",
        });
      }
      if (restored.length) outgoingByAgent[agentKey] = restored;
    }
  }

  const pendingSwitchByAgent: Record<string, PendingModelSwitch> = {};
  if (obj.pendingSwitchByAgent && typeof obj.pendingSwitchByAgent === "object" && !Array.isArray(obj.pendingSwitchByAgent)) {
    for (const [agentKey, rawSw] of Object.entries(obj.pendingSwitchByAgent as Record<string, unknown>)) {
      if (!rawSw || typeof rawSw !== "object") continue;
      const r = rawSw as Record<string, unknown>;
      if (typeof r.deviceId !== "string") continue;
      const modelId = typeof r.modelId === "string" && r.modelId.trim() ? r.modelId.trim() : undefined;
      const thinkingLevel = typeof r.thinkingLevel === "string" && r.thinkingLevel.trim() ? r.thinkingLevel.trim() : undefined;
      if (!modelId && !thinkingLevel) continue;
      pendingSwitchByAgent[agentKey] = {
        agentKey: typeof r.agentKey === "string" ? r.agentKey : agentKey,
        deviceId: r.deviceId,
        harness: typeof r.harness === "string" ? r.harness : "",
        ...(modelId ? { modelId } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        label: typeof r.label === "string" && r.label.trim() ? r.label : [modelId, thinkingLevel].filter(Boolean).join(" · "),
        createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
      };
    }
  }

  const current = chatQueueStore.get();
  for (const [k, list] of Object.entries(current.queuedByAgent)) {
    if (!list.length) continue;
    const seen = new Set((queuedByAgent[k] ?? []).map((x) => x.id));
    queuedByAgent[k] = [...(queuedByAgent[k] ?? []), ...list.filter((x) => !seen.has(x.id))];
  }
  for (const [k, list] of Object.entries(current.outgoingByAgent)) {
    if (!list.length) continue;
    const seen = new Set((outgoingByAgent[k] ?? []).map((x) => x.id));
    outgoingByAgent[k] = [...(outgoingByAgent[k] ?? []), ...list.filter((x) => !seen.has(x.id))];
  }
  for (const [k, sw] of Object.entries(current.pendingSwitchByAgent)) {
    pendingSwitchByAgent[k] = sw;
  }

  chatQueueStore.set({
    queuedByAgent,
    outgoingByAgent,
    pendingSwitchByAgent,
    capturedByAgent: current.capturedByAgent,
    injectedTerminalByAgent: current.injectedTerminalByAgent,
  });
}

registerWorkspaceSection("chatQueue", {
  serialize: serializeChatQueue,
  hydrate: hydrateChatQueue,
});

export function resetChatQueueForTest(): void {
  const cur = chatQueueStore.get();
  for (const list of Object.values(cur.queuedByAgent)) {
    for (const item of list) {
      for (const a of item.attachments) revokeAttachment(a);
    }
  }
  for (const list of Object.values(cur.outgoingByAgent)) {
    for (const item of list) {
      for (const a of item.attachments) revokeAttachment(a);
    }
  }
  inFlightAgents.clear();
  dispatchState.clear();
  chatQueueStore.set({
    queuedByAgent: {},
    outgoingByAgent: {},
    pendingSwitchByAgent: {},
    capturedByAgent: {},
    injectedTerminalByAgent: {},
  });
}

export function dismissCapturedCommand(agentKey: string, id: string): void {
  chatQueueStore.set((state) => {
    const cur = state.capturedByAgent[agentKey];
    if (!cur?.some((c) => c.id === id)) return state;
    const nextList = cur.filter((c) => c.id !== id);
    const nextMap = { ...state.capturedByAgent };
    if (nextList.length) nextMap[agentKey] = nextList;
    else delete nextMap[agentKey];
    return { ...state, capturedByAgent: nextMap };
  });
}

export async function closeInteractiveCommandPanel(
  agent: Pick<Agent, "key" | "deviceId">,
  captureId?: string,
): Promise<void> {
  await rpcCall(agent.deviceId, "terminal.keys", { agent: agent.key, keys: ["esc"] }).catch(() => {});
  if (!captureId) return;
  chatQueueStore.set((state) => {
    const cur = state.capturedByAgent[agent.key];
    if (!cur?.some((c) => c.id === captureId)) return state;
    return {
      ...state,
      capturedByAgent: {
        ...state.capturedByAgent,
        [agent.key]: cur.map((c) => (c.id === captureId ? { ...c, panelState: "closed" as const } : c)),
      },
    };
  });
}

function updateOutgoing(
  agentKey: string,
  updater: (prev: OutgoingSend[]) => OutgoingSend[],
): void {
  let changed = false;
  chatQueueStore.set((state) => {
    const cur = state.outgoingByAgent[agentKey] ?? EMPTY_OUTGOING;
    const next = updater(cur);
    if (next === cur) return state;
    changed = true;
    const nextMap = { ...state.outgoingByAgent };
    if (next.length === 0) delete nextMap[agentKey];
    else nextMap[agentKey] = next;
    return { ...state, outgoingByAgent: nextMap };
  });
  if (changed) scheduleWorkspacePersist();
}

function updateQueued(
  agentKey: string,
  updater: (prev: QueuedPrompt[]) => QueuedPrompt[],
): void {
  let changed = false;
  chatQueueStore.set((state) => {
    const cur = state.queuedByAgent[agentKey] ?? EMPTY_QUEUED;
    const next = updater(cur);
    if (next === cur) return state;
    changed = true;
    const nextMap = { ...state.queuedByAgent };
    if (next.length === 0) delete nextMap[agentKey];
    else nextMap[agentKey] = next;
    return { ...state, queuedByAgent: nextMap };
  });
  if (changed) scheduleWorkspacePersist();
}

async function deliverOutgoing(send: OutgoingSend, delivery: DeliveryMode = "auto"): Promise<boolean> {
  try {
    let body = send.text;
    let uploadedPaths = send.uploadedPaths;
    if (uploadedPaths?.length) {
      body = textWithFiles(send.text, uploadedPaths);
    } else if (send.attachments.length > 0) {
      const preferStream = (att: StagedAttachment) =>
        Boolean(
          !att.hostRef &&
            att.file &&
            (!att.put ||
              (att.kind !== "image" &&
                att.file.size > 512 * 1024 &&
                (!native.available() || isDirectConnected(send.deviceId)))),
        );
      const toUpload = send.attachments.filter((s) => !s.hostRef && s.put && !preferStream(s));
      const uploaded = toUpload.length
        ? await rpcCall(
            send.deviceId,
            "terminal.put",
            { agent: send.agentKey, files: toUpload.map((s) => s.put!) },
            30_000,
          )
        : { paths: [] as string[] };
      let uploadIdx = 0;
      const paths: string[] = [];
      for (const att of send.attachments) {
        if (att.hostRef) {
          paths.push(att.hostRef);
        } else if (att.put && !preferStream(att)) {
          if (uploadIdx < uploaded.paths.length) {
            paths.push(uploaded.paths[uploadIdx++]!);
          }
        } else if (att.file) {
          const uploadedPath = await uploadRemoteFile(
            send.deviceId,
            send.agentKey,
            att.file,
            (pct, viaDirect) => {
              const label = `正在上传 ${att.name} · ${pct}%${viaDirect ? " (P2P直连)" : ""}`;
              updateOutgoing(send.agentKey, (list) =>
                list.map((x) => (x.id === send.id ? { ...x, progressText: label } : x)),
              );
            },
          );
          paths.push(uploadedPath);
        }
      }
      uploadedPaths = paths;
      body = textWithFiles(send.text, paths);
      updateOutgoing(send.agentKey, (list) =>
        list.map((x) =>
          x.id === send.id
            ? {
                ...x,
                ...(x.progressText ? { progressText: undefined } : {}),
                ...(uploadedPaths?.length ? { uploadedPaths } : {}),
              }
            : x,
        ),
      );
    }
    const sendRes = await rpcCall(send.deviceId, "terminal.send", {
      agent: send.agentKey,
      text: body,
      enter: true,
      ...(delivery === "steer" ? { delivery: "steer" } : {}),
    });
    const cap = sendRes?.commandCapture;
    if (cap && (cap.output || cap.panelState === "interactive_open")) {
      for (const a of send.attachments) revokeAttachment(a);
      const capEntry: CapturedCommandEntry = {
        id: nextId("cap"),
        agentKey: send.agentKey,
        command: cap.command || send.text.trim(),
        output: cap.output ?? "",
        isError: Boolean(cap.isError),
        panelState: cap.panelState ?? "none",
        ts: Date.now(),
      };
      chatQueueStore.set((state) => {
        const nextOutgoingList = (state.outgoingByAgent[send.agentKey] ?? EMPTY_OUTGOING).filter((x) => x.id !== send.id);
        const nextOutgoingMap = { ...state.outgoingByAgent };
        if (nextOutgoingList.length) nextOutgoingMap[send.agentKey] = nextOutgoingList;
        else delete nextOutgoingMap[send.agentKey];
        const prevCaps = state.capturedByAgent[send.agentKey] ?? EMPTY_CAPTURED;
        return {
          ...state,
          outgoingByAgent: nextOutgoingMap,
          capturedByAgent: {
            ...state.capturedByAgent,
            [send.agentKey]: [...prevCaps, capEntry].slice(-12),
          },
        };
      });
      scheduleWorkspacePersist();
      return true;
    }
    // Keep attachment thumbnails/paths alive on the optimistic bubble until Uniflo echoes or prunes it.
    // Explicit steer / interrupt / inject sends stay inline (`sent`), never falling back to `queued_terminal`.
    const nextState: OutgoingSend["state"] = delivery === "auto" && sendRes?.waiting ? "queued_terminal" : "sent";
    logger.info("chat", `deliver.${nextState}`, {
      delivery,
      chars: send.text.length,
      files: send.attachments.length,
      waiting: Boolean(sendRes?.waiting),
    });
    updateOutgoing(send.agentKey, (list) =>
      list.map((x) =>
        x.id === send.id
          ? {
              ...x,
              state: nextState,
              ...(uploadedPaths?.length ? { uploadedPaths } : {}),
              error: undefined,
            }
          : x,
      ),
    );
    return true;
  } catch (e) {
    const message = (e as Error).message || "发送失败";
    logger.error("chat", `deliver.failed: ${message}`, {
      delivery,
      chars: send.text.length,
      files: send.attachments.length,
    });
    updateOutgoing(send.agentKey, (list) =>
      list.map((x) => (x.id === send.id ? { ...x, state: "failed", error: message } : x)),
    );
    return false;
  }
}

function createOutgoingEntry(
  agent: Pick<Agent, "key" | "deviceId">,
  cleanText: string,
  attachments: StagedAttachment[],
  state: OutgoingSend["state"] = "sending",
): OutgoingSend {
  return {
    id: nextId("out"),
    agentKey: agent.key,
    deviceId: agent.deviceId,
    text: cleanText,
    attachments,
    attachedCount: attachments.length,
    attachedNames: attachments.map((a) => a.name),
    ts: Date.now(),
    state,
  };
}

export async function sendPromptNow(
  agent: Pick<Agent, "key" | "deviceId">,
  rawText: string,
  attachments: StagedAttachment[],
  delivery: DeliveryMode = "auto",
): Promise<boolean> {
  const clean = rawText.trim();
  if (!clean && attachments.length === 0) return false;
  const entry = createOutgoingEntry(agent, clean, attachments, "sending");
  updateOutgoing(agent.key, (list) => [...list, entry]);
  return deliverOutgoing(entry, delivery);
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

/** Non-destructive soft steer ("插队发送"): submits without killing the active turn. */
export async function steerQueuedPromptNow(
  agent: Pick<Agent, "key" | "deviceId" | "status">,
  id: string,
): Promise<void> {
  if (inFlightAgents.has(agent.key)) return;
  const popped = popQueuedPromptForEdit(agent.key, id);
  if (!popped) return;
  dispatchState.delete(agent.key);
  inFlightAgents.add(agent.key);
  try {
    await sendPromptNow(agent, popped.text, popped.attachments, "steer");
  } finally {
    inFlightAgents.delete(agent.key);
  }
}

/** Explicit destructive interrupt-and-send ("打断当前轮并发送"). */
async function fastInterruptAgent(agent: Pick<Agent, "key" | "deviceId"> & Partial<Pick<Agent, "source" | "localId">>): Promise<void> {
  if (native.available() && localHostIdStore.get() === agent.deviceId && agent.source === "hc" && agent.localId) {
    try {
      await native.localTermInterrupt(agent.localId);
      return;
    } catch {
      // fall through to hostd RPC
    }
  }
  await rpcCall(agent.deviceId, "terminal.interrupt", { agent: agent.key }).catch(() => {});
}

export async function interruptAndSendQueuedPrompt(
  agent: Pick<Agent, "key" | "deviceId" | "status"> & Partial<Pick<Agent, "source" | "localId">>,
  id: string,
): Promise<void> {
  if (inFlightAgents.has(agent.key)) return;
  const popped = popQueuedPromptForEdit(agent.key, id);
  if (!popped) return;
  dispatchState.delete(agent.key);
  inFlightAgents.add(agent.key);
  try {
    const entry = createOutgoingEntry(agent, popped.text.trim(), popped.attachments, "sending");
    updateOutgoing(agent.key, (list) => [...list, entry]);
    if (agent.status === "working") {
      await fastInterruptAgent(agent);
      await waitMs(STEER_SETTLE_MS);
    }
    await deliverOutgoing(entry, "interrupt");
  } finally {
    inFlightAgents.delete(agent.key);
  }
}

/** Interrupt the running turn from the composer and immediately insert/send the prompt once. */
export async function interruptComposerNow(
  agent: Pick<Agent, "key" | "deviceId" | "status"> & Partial<Pick<Agent, "source" | "localId">>,
  rawText: string,
  attachments: StagedAttachment[],
): Promise<boolean> {
  if (inFlightAgents.has(agent.key)) return false;
  const clean = rawText.trim();
  if (!clean && attachments.length === 0) return false;
  logger.info("chat", "composer.interrupt", { chars: clean.length, files: attachments.length, status: agent.status });
  dispatchState.delete(agent.key);
  inFlightAgents.add(agent.key);
  try {
    const entry = createOutgoingEntry(agent, clean, attachments, "sending");
    updateOutgoing(agent.key, (list) => [...list, entry]);
    if (agent.status === "working") {
      await fastInterruptAgent(agent);
      await waitMs(STEER_SETTLE_MS);
    }
    return await deliverOutgoing(entry, "interrupt");
  } finally {
    inFlightAgents.delete(agent.key);
  }
}

/** Injects a terminal-queued message immediately into the active turn without creating duplicate bubbles. */
export async function injectTerminalQueuedNow(
  agent: Pick<Agent, "key" | "deviceId">,
  rawText: string,
): Promise<void> {
  const clean = rawText.trim();
  logger.info("chat", "terminal_queued.inject", { chars: clean.length });
  const now = Date.now();
  chatQueueStore.set((state) => {
    const nextInjectedMap = { ...state.injectedTerminalByAgent };
    if (clean) {
      const fresh = (nextInjectedMap[agent.key] ?? EMPTY_INJECTED).filter(
        (x) => now - x.at < INJECTED_TERMINAL_TTL_MS && !sameMessage(x.text, clean),
      );
      fresh.push({ text: clean, at: now });
      nextInjectedMap[agent.key] = fresh;
    }

    const curOutgoing = state.outgoingByAgent[agent.key] ?? EMPTY_OUTGOING;
    let promoted = false;
    let nextOutgoing = curOutgoing.map((item) => {
      if (!promoted && clean && item.state === "queued_terminal" && sameMessage(item.text, clean)) {
        promoted = true;
        return { ...item, state: "sent" as const, ts: now, error: undefined };
      }
      return item;
    });
    if (!promoted && clean && !nextOutgoing.some((item) => sameMessage(item.text, clean))) {
      nextOutgoing = [...nextOutgoing, createOutgoingEntry(agent, clean, [], "sent")];
    }

    const nextOutgoingMap = { ...state.outgoingByAgent };
    if (nextOutgoing.length) nextOutgoingMap[agent.key] = nextOutgoing;
    else delete nextOutgoingMap[agent.key];

    return {
      ...state,
      injectedTerminalByAgent: nextInjectedMap,
      outgoingByAgent: nextOutgoingMap,
    };
  });
  await rpcCall(agent.deviceId, "terminal.keys", { agent: agent.key, keys: ["alt+m"] });
}

/** Non-destructive soft steer from the composer ("插队发送"): submits without interrupting the running turn. */
export async function steerComposerNow(
  agent: Pick<Agent, "key" | "deviceId" | "status">,
  rawText: string,
  attachments: StagedAttachment[],
): Promise<void> {
  if (inFlightAgents.has(agent.key)) return;
  const clean = rawText.trim();
  if (!clean && attachments.length === 0) return;
  logger.info("chat", "composer.steer", { chars: clean.length, files: attachments.length });
  dispatchState.delete(agent.key);
  inFlightAgents.add(agent.key);
  try {
    await sendPromptNow(agent, clean, attachments, "steer");
  } finally {
    inFlightAgents.delete(agent.key);
  }
}

export function schedulePendingModelSwitch(
  agent: Pick<Agent, "key" | "deviceId" | "harness">,
  patch: { modelId?: string; thinkingLevel?: string; label?: string },
): PendingModelSwitch | null {
  const modelId = patch.modelId?.trim() || undefined;
  const thinkingLevel = patch.thinkingLevel?.trim().toLowerCase() || undefined;
  if (!modelId && !thinkingLevel) return null;

  let saved: PendingModelSwitch | null = null;
  chatQueueStore.set((state) => {
    const prev = state.pendingSwitchByAgent[agent.key];
    const nextModel = modelId ?? prev?.modelId;
    const nextThinking = thinkingLevel ?? prev?.thinkingLevel;
    const baseLabel = nextModel ? stripModelEffortSuffix(nextModel) : "";
    const autoLabel = [baseLabel, nextThinking ? `思考 ${nextThinking}` : ""].filter(Boolean).join(" · ");
    const label =
      patch.label?.trim() && !(modelId && !thinkingLevel && prev?.thinkingLevel) && !(!modelId && thinkingLevel && prev?.modelId)
        ? patch.label.trim()
        : autoLabel || patch.label?.trim() || "模型配置";
    saved = {
      agentKey: agent.key,
      deviceId: agent.deviceId,
      harness: agent.harness,
      ...(nextModel ? { modelId: nextModel } : {}),
      ...(nextThinking ? { thinkingLevel: nextThinking } : {}),
      label,
      createdAt: Date.now(),
    };
    return {
      ...state,
      pendingSwitchByAgent: {
        ...state.pendingSwitchByAgent,
        [agent.key]: saved,
      },
    };
  });
  scheduleWorkspacePersist();
  return saved;
}

export function cancelPendingModelSwitch(agentKey: string): void {
  let removed = false;
  chatQueueStore.set((state) => {
    if (!state.pendingSwitchByAgent[agentKey]) return state;
    removed = true;
    const next = { ...state.pendingSwitchByAgent };
    delete next[agentKey];
    return { ...state, pendingSwitchByAgent: next };
  });
  if (removed) scheduleWorkspacePersist();
}

async function deliverPendingModelSwitch(sw: PendingModelSwitch): Promise<void> {
  try {
    await rpcCall(sw.deviceId, "agent.setModel", {
      agent: sw.agentKey,
      ...(sw.modelId ? { modelId: sw.modelId } : {}),
      ...(sw.thinkingLevel ? { thinkingLevel: sw.thinkingLevel } : {}),
    });
  } catch (e) {
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
        await rpcCall(sw.deviceId, "terminal.send", { agent: sw.agentKey, text: cmd, enter: true }).catch(() => {});
      }
    }
  }
}

const IDLE_DEBOUNCE_MS = 600;
const inFlightAgents = new Set<string>();
const dispatchState = new Map<string, { lastDispatchedAt: number; sawWorking: boolean; idleSince?: number }>();
let watcherInstalled = false;

function runQueueDrainTick(): void {
  const now = Date.now();
  const state = chatQueueStore.get();
  const live = liveStore.get();
  const agents = allAgents(live.agents);
  const byKey = new Map(agents.map((a) => [a.key, a]));

  for (const [key, track] of dispatchState) {
    const agent = byKey.get(key);
    const hasQueue = (state.queuedByAgent[key]?.length ?? 0) > 0 || Boolean(state.pendingSwitchByAgent[key]);
    if (!agent) {
      dispatchState.delete(key);
      continue;
    }
    if (agent.status === "working") {
      track.sawWorking = true;
      track.idleSince = undefined;
    } else if (track.sawWorking && (agent.status === "done" || agent.status === "idle")) {
      // Require continuous idle/done >= 600ms so a 1-frame tool flicker never prematurely drains the queue.
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

  for (const [key, sw] of Object.entries(state.pendingSwitchByAgent)) {
    const agent = byKey.get(key);
    if (!agent) continue;
    const online = Boolean(live.devices[agent.deviceId]?.online);
    const track = dispatchState.get(key);
    if (track?.idleSince && now - track.idleSince < IDLE_DEBOUNCE_MS) continue;
    if (!shouldAutoDrainQueue(agent.status, online, track?.lastDispatchedAt ?? 0, inFlightAgents.has(key), now)) {
      continue;
    }
    cancelPendingModelSwitch(key);
    inFlightAgents.add(key);
    dispatchState.set(key, { lastDispatchedAt: now, sawWorking: false });
    void deliverPendingModelSwitch(sw).finally(() => {
      inFlightAgents.delete(key);
      if ((chatQueueStore.get().queuedByAgent[key]?.length ?? 0) > 0) {
        dispatchState.set(key, { lastDispatchedAt: Date.now() - DRAIN_COOLDOWN_MS + 300, sawWorking: false });
      }
    });
  }

  const afterSwitchState = chatQueueStore.get();
  for (const [key, queue] of Object.entries(afterSwitchState.queuedByAgent)) {
    if (!queue.length) continue;
    const agent = byKey.get(key);
    if (!agent) continue;
    const online = Boolean(live.devices[agent.deviceId]?.online);
    const track = dispatchState.get(key);
    if (track?.idleSince && now - track.idleSince < IDLE_DEBOUNCE_MS) continue;
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
  pendingSwitch: PendingModelSwitch | null;
  captured: CapturedCommandEntry[];
  injectedTerminalTexts: Set<string>;
} {
  useEffect(() => {
    ensureChatQueueWatcher();
  }, []);
  const queued = chatQueueStore.use((s) => s.queuedByAgent[agentKey] ?? EMPTY_QUEUED);
  const outgoing = chatQueueStore.use((s) => s.outgoingByAgent[agentKey] ?? EMPTY_OUTGOING);
  const pendingSwitch = chatQueueStore.use((s) => s.pendingSwitchByAgent[agentKey] ?? null);
  const captured = chatQueueStore.use((s) => s.capturedByAgent[agentKey] ?? EMPTY_CAPTURED);
  const injectedRecords = chatQueueStore.use((s) => s.injectedTerminalByAgent[agentKey] ?? EMPTY_INJECTED);
  const injectedTerminalTexts = useMemo(
    () => new Set(injectedRecords.map((r) => r.text)),
    [injectedRecords],
  );
  return { queued, outgoing, pendingSwitch, captured, injectedTerminalTexts };
}
