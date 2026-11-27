/**
 * Messages sent from this phone to an agent. Each shows in the agent's
 * conversation at once, as the person's own bubble, and is followed until the
 * conversation shows its own copy: sending, then sent (typed in), or queued
 * (the agent is in a turn and its program holds the text), or failed (with a
 * retry). Sends to one agent go out one after another in the order written, so
 * a message with pictures is never overtaken by a quicker one after it.
 */
import { create } from "zustand";
import { matchesOptimisticCommand, type Agent } from "@herdr-pocket/protocol";
import { sameMessage, sendWithPictures, type Attachment } from "./attach";
import { RelayError } from "./relay";
import { findAgent, usePending, type PendingSend, type SendState } from "./store";

/** A send-queue event from the computer (`queue` on the terminal stream). */
export interface QueueEvent {
  queueId: string;
  status: "queued" | "sending" | "sent" | "failed";
  position?: number;
  message?: string;
}

export type SendResult = { ok: true } | { ok: false; message: string };

/** The conversation's copy may carry the computer's clock: allow it to read a little earlier. */
const ECHO_SLACK_MS = 60_000;
/**
 * How long a message not seen in the conversation stays on screen. Sent (typed in) but never shown there,
 * as with another session or a program without one: a few minutes, counted from when the computer took it.
 */
const TTL: Record<SendState, number> = { sending: Infinity, sent: 3 * 60_000, queued: 2 * 3_600_000, uncertain: Infinity, failed: 30 * 60_000 };
/** How long a message keeps its bubble's identity (key, thumbnails) once the conversation shows it. */
const ECHO_KEEP_MS = 15 * 60_000;
/** The computer counts text held during a turn (`Agent.queued`) once its agent list goes out. */
const WAIT_GRACE_MS = 10_000;
/** Longest the "it is answering" dots show for an agent that has not started working. */
const AWAIT_MS = 60_000;

/** Pictures of messages not delivered yet, kept for a retry, by message id. */
const keep = new Map<string, Attachment[]>();
/** Per agent: the send in progress, so the next one waits its turn. */
const lines = new Map<string, Promise<unknown>>();
/** Queue events that arrived before the send's own answer, by queue id. */
const early = new Map<string, QueueEvent>();

export interface CapturedMobileCommand {
  id: string;
  agentKey: string;
  command: string;
  output: string;
  isError: boolean;
  panelState: "none" | "closed" | "interactive_open";
  ts: number;
}

const EMPTY_CAPTURED_MOBILE: CapturedMobileCommand[] = [];

export const useCapturedCommands = create<{
  byAgent: Record<string, CapturedMobileCommand[]>;
  add: (entry: CapturedMobileCommand) => void;
  dismiss: (agentKey: string, id: string) => void;
  markPanelClosed: (agentKey: string, id: string) => void;
}>((set) => ({
  byAgent: {},
  add: (entry) =>
    set((s) => ({
      byAgent: {
        ...s.byAgent,
        [entry.agentKey]: [...(s.byAgent[entry.agentKey] ?? EMPTY_CAPTURED_MOBILE), entry].slice(-12),
      },
    })),
  dismiss: (agentKey, id) =>
    set((s) => {
      const cur = s.byAgent[agentKey];
      if (!cur) return s;
      const next = cur.filter((c) => c.id !== id);
      const map = { ...s.byAgent };
      if (next.length) map[agentKey] = next;
      else delete map[agentKey];
      return { byAgent: map };
    }),
  markPanelClosed: (agentKey, id) =>
    set((s) => {
      const cur = s.byAgent[agentKey];
      if (!cur) return s;
      return {
        byAgent: {
          ...s.byAgent,
          [agentKey]: cur.map((c) => (c.id === id ? { ...c, panelState: "closed" } : c)),
        },
      };
    }),
}));

const patch = (agentKey: string, id: string, p: Partial<Omit<PendingSend, "id">>) => usePending.getState().update(agentKey, id, p);
const find = (agentKey: string, id: string) => usePending.getState().byAgent[agentKey]?.find((x) => x.id === id);

function attachmentsFromDataUris(id: string, uris?: string[]): Attachment[] {
  if (!uris?.length) return [];
  const out: Attachment[] = [];
  uris.forEach((uri, idx) => {
    const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(uri.trim());
    if (!m) return;
    const mime = m[1]!.toLowerCase();
    const data = m[2]!;
    const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = Math.max(0, Math.floor((data.length * 3) / 4) - pad);
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    out.push({
      id: `${id}-att-${idx}`,
      name: `image-${idx + 1}.${ext}`,
      mime: mime as Attachment["mime"],
      data,
      width: 0,
      height: 0,
      bytes,
    });
  });
  return out;
}

/** Shows the message at once, then sends it after any earlier ones to the same agent. */
export function sendOut(agent: Agent, text: string, pictures: Attachment[] = [], delivery: "auto" | "steer" = "auto"): Promise<SendResult> {
  const id = usePending.getState().add(agent.key, text, pictures.map((x) => `data:${x.mime};base64,${x.data}`));
  if (pictures.length) keep.set(id, pictures);
  return deliver(agent, id, text, delivery);
}

/** Resends a message in place. An unconfirmed send needs explicit consent to risk a duplicate. */
export function resend(agentKey: string, id: string, allowDuplicate = false): Promise<SendResult> {
  const x = find(agentKey, id);
  const agent = findAgent(agentKey);
  if (!x || x.echo || (x.state !== "failed" && !(allowDuplicate && x.state === "uncertain"))) return Promise.resolve({ ok: false, message: "这条消息不能重发" });
  if (!agent) {
    patch(agentKey, id, { error: "找不到这个 agent 了" });
    return Promise.resolve({ ok: false, message: "找不到这个 agent 了" });
  }
  if (!keep.has(id) && x.pictures?.length) {
    const restored = attachmentsFromDataUris(id, x.pictures);
    if (restored.length) keep.set(id, restored);
  }
  patch(agentKey, id, { state: "sending", ts: Date.now(), error: undefined, queueId: undefined, waiting: undefined, sentAt: undefined });
  return deliver(agent, id, x.text, "auto");
}

/** Takes messages off the screen (and their kept pictures). */
export function forget(agentKey: string, ids: string[]) {
  for (const id of ids) keep.delete(id);
  usePending.getState().drop(agentKey, ids);
}

function deliver(agent: Agent, id: string, text: string, delivery: "auto" | "steer" = "auto"): Promise<SendResult> {
  const run = (lines.get(agent.key) ?? Promise.resolve()).then(async (): Promise<SendResult> => {
    try {
      let pictures = keep.get(id);
      if (!pictures?.length) {
        const restored = attachmentsFromDataUris(id, find(agent.key, id)?.pictures);
        if (restored.length) {
          keep.set(id, restored);
          pictures = restored;
        }
      }
      const { accepted } = await sendWithPictures(agent, text, pictures ?? [], delivery);
      if (!accepted.queueId) keep.delete(id);
      const cap = accepted.commandCapture;
      if (cap && (cap.output || cap.panelState === "interactive_open")) {
        useCapturedCommands.getState().add({
          id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          agentKey: agent.key,
          command: cap.command || text.trim(),
          output: cap.output ?? "",
          isError: Boolean(cap.isError),
          panelState: cap.panelState ?? "none",
          ts: Date.now(),
        });
        forget(agent.key, [id]);
        return { ok: true };
      }
      const waiting = !!accepted.waiting;
      const behind = (accepted.position ?? 0) > 0;
      // Older computers send no queue events: accepted is as far as the phone can follow.
      patch(agent.key, id, { queueId: accepted.queueId, waiting, sentAt: Date.now(), state: waiting || behind ? "queued" : accepted.queueId ? "sending" : "sent" });
      const ev = accepted.queueId ? early.get(accepted.queueId) : undefined;
      if (ev) {
        early.delete(ev.queueId);
        onQueueEvent(agent.key, ev);
      }
      if (accepted.queueId && !waiting && !behind) {
        setTimeout(() => {
          const x = find(agent.key, id);
          if (x?.state === "sending") patch(agent.key, id, { state: "uncertain" });
        }, 8000);
      }
      return { ok: true };
    } catch (e) {
      const uncertain = e instanceof RelayError && e.uncertain;
      const message = uncertain ? "发送结果待确认" : (e as Error).message || "没发出去";
      patch(agent.key, id, { state: uncertain ? "uncertain" : "failed", error: message });
      return { ok: false, message };
    }
  });
  lines.set(agent.key, run);
  void run.then(() => {
    if (lines.get(agent.key) === run) lines.delete(agent.key);
  });
  return run;
}

/** Follows the computer's send queue for messages from this phone. */
export function onQueueEvent(agentKey: string, ev: QueueEvent) {
  const x = usePending.getState().byAgent[agentKey]?.find((m) => m.queueId === ev.queueId);
  if (!x) {
    // It can beat the send's own answer; keep the latest a moment for that answer.
    early.set(ev.queueId, ev);
    setTimeout(() => {
      if (early.get(ev.queueId) === ev) early.delete(ev.queueId);
    }, 15_000);
    return;
  }
  if (ev.status === "queued" && (ev.position ?? 0) > 0) patch(agentKey, x.id, { state: "queued" });
  else if (ev.status === "sending" && !x.waiting && x.state !== "sent") patch(agentKey, x.id, { state: "sending" });
  else if (ev.status === "sent") {
    keep.delete(x.id);
    patch(agentKey, x.id, { state: x.waiting ? "queued" : "sent", sentAt: Date.now() });
  }
  else if (ev.status === "failed") patch(agentKey, x.id, { state: "failed", error: ev.message || "电脑那边没打进去" });
}

/** The conversation rows `followSends` reads: user messages, and anything that counts as a reply. */
export interface ConvRow {
  type: string;
  id: string;
  text?: string;
  summary?: string;
  label?: string;
  ts?: number;
}

export interface Followed {
  /** Not in the conversation yet: the person's own bubbles after it, in the state to show. */
  shown: PendingSend[];
  /** The conversation's copies of this phone's messages, by row id: they keep the bubble's key and thumbnails. */
  echoes: Map<string, PendingSend>;
  /** Store changes: messages to take off the screen, and states that moved on. */
  drop: string[];
  patches: { id: string; patch: Partial<PendingSend> }[];
  /** The phone has the last word and the agent, not working yet, has not answered. */
  awaiting: boolean;
}

/**
 * Matches messages sent from this phone with the conversation: each user
 * message in it stands for at most one sent message (same words, not much
 * earlier than the send), so its bubble gives way without a duplicate.
 */
export function followSends(sends: PendingSend[], rows: readonly ConvRow[], agent: Pick<Agent, "status" | "queued">, now: number): Followed {
  const drop: string[] = [];
  const patches: Followed["patches"] = [];
  const echoes = new Map<string, PendingSend>();
  const echoAt = new Map<string, number>();
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const claimed = new Set<number>();
  for (const x of sends) {
    const i = x.echo ? index.get(x.echo) : undefined;
    // A row id met again with other words (a conversation read anew) is not this message's copy.
    if (i !== undefined && sameMessage(rows[i]!.text ?? "", x.text, !!x.pictures?.length)) {
      claimed.add(i);
      echoes.set(x.echo!, x);
      echoAt.set(x.id, i);
    }
  }
  const users = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.type === "user");
  // Confirmed sends claim first. Ambiguous sends can still have a transcript echo.
  const open = sends.filter((x) => !x.echo && x.state !== "failed").sort((a, b) => Number(a.state === "uncertain") - Number(b.state === "uncertain") || a.ts - b.ts);
  for (const x of open) {
    const isSlash = x.text.trim().startsWith("/");
    let hitIdx = users.findIndex(({ r, i }) => !claimed.has(i) && ((r.ts ?? 0) === 0 || (r.ts ?? 0) >= x.ts - ECHO_SLACK_MS) && sameMessage(r.text ?? "", x.text, !!x.pictures?.length));
    let matchedRowIdx = hitIdx >= 0 ? users[hitIdx]!.i : -1;
    if (matchedRowIdx < 0 && isSlash) {
      matchedRowIdx = rows.findIndex(
        (r, i) =>
          !claimed.has(i) &&
          ((r.ts ?? 0) === 0 || (r.ts ?? 0) >= x.ts - ECHO_SLACK_MS) &&
          matchesOptimisticCommand(x.text, {
            kind: r.type,
            summary: r.summary,
            text: r.text,
            label: r.label,
          }),
      );
    }
    if (matchedRowIdx < 0) continue;
    const hitRow = rows[matchedRowIdx]!;
    claimed.add(matchedRowIdx);
    echoes.set(hitRow.id, x);
    echoAt.set(x.id, matchedRowIdx);
    patches.push({ id: x.id, patch: { echo: hitRow.id, state: "sent", error: undefined } });
  }

  const shown: PendingSend[] = [];
  for (const x of sends) {
    if (x.echo || echoAt.has(x.id)) {
      if (now - x.ts > ECHO_KEEP_MS) drop.push(x.id);
      continue;
    }
    // Held during a turn until the computer stops counting it: taken (or the turn was cut short).
    if (x.state === "queued" && x.waiting && !agent.queued && now - (x.sentAt ?? x.ts) > WAIT_GRACE_MS) {
      patches.push({ id: x.id, patch: { state: "sent", sentAt: now } });
      shown.push({ ...x, state: "sent", sentAt: now });
      continue;
    }
    const since = x.state === "sent" ? (x.sentAt ?? x.ts) : x.ts;
    const ttlMs = x.state === "sent" && x.text.trim().startsWith("/") ? 8_000 : TTL[x.state];
    if (now - since > ttlMs) drop.push(x.id);
    else shown.push(x);
  }

  let awaiting = false;
  const last = sends.reduce<PendingSend | undefined>((a, x) => (!a || x.ts > a.ts ? x : a), undefined);
  if (last && !drop.includes(last.id) && agent.status !== "working" && (agent.status !== "blocked" || now - last.ts < 15_000) && now - last.ts < AWAIT_MS) {
    const at = echoAt.get(last.id);
    const state = at !== undefined ? "sent" : shown.find((x) => x.id === last.id)?.state;
    if (state === "sent") {
      if (last.text.trim().startsWith("/") && at !== undefined) {
        awaiting = false;
      } else {
        // A reply is anything the agent wrote or did after the message (or, not matched yet, after it was sent).
        awaiting = !rows.some((r, i) => r.type !== "user" && r.type !== "system" && r.type !== "model_switch" && (at !== undefined ? i > at : (r.ts ?? 0) >= last.ts));
      }
    }
  }
  return { shown, echoes, drop, patches, awaiting };
}
