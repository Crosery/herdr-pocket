import { sameMessage, type AgentStatus } from "@herdr-pocket/protocol";
import type { ChatRow } from "./chatFold";

export interface OutgoingSendLike {
  id: string;
  text: string;
  attachedCount: number;
  ts: number;
  state: "sending" | "sent" | "failed";
}

const ECHO_SLACK_MS = 60_000;
const SENT_TTL_MS = 3 * 60_000;
const AWAIT_REPLY_MS = 60_000;
const DRAIN_COOLDOWN_MS = 3500;

function rowTs(row: ChatRow): number {
  switch (row.kind) {
    case "user":
    case "assistant":
    case "turn_end":
    case "thinking":
    case "system":
    case "model_switch":
    case "tool":
      return row.ts;
    case "activity_group":
      return row.endTs;
  }
}

function rowStartTs(row: ChatRow): number {
  switch (row.kind) {
    case "activity_group":
      return row.ts;
    default:
      return rowTs(row);
  }
}

function transcriptForm(row: Extract<ChatRow, { kind: "user" }>): string {
  return row.attachedLines.length > 0
    ? [row.text, ...row.attachedLines].filter(Boolean).join("\n")
    : row.text;
}

/**
 * Reconciles optimistic outgoing messages against folded timeline rows so
 * confirmed user turns drop without duplicate bubbles and recent replies clear awaiting state.
 */
export function reconcileOutgoingSends<T extends OutgoingSendLike>(
  sends: T[],
  rows: ChatRow[],
  agentStatus: AgentStatus,
  now: number,
): {
  unmatched: T[];
  matchedIds: string[];
  expiredIds: string[];
  awaitingReply: boolean;
} {
  const claimed = new Set<number>();
  const matchedIds: string[] = [];
  const expiredIds: string[] = [];
  const unmatched: T[] = [];
  const matchedRowIdx = new Map<string, number>();

  const users = rows
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: Extract<ChatRow, { kind: "user" }>; i: number } => x.r.kind === "user");

  for (const send of sends) {
    if (send.state === "failed") {
      unmatched.push(send);
      continue;
    }

    const hit = users.find(
      ({ r, i }) =>
        !claimed.has(i) &&
        (r.ts ?? 0) >= send.ts - ECHO_SLACK_MS &&
        sameMessage(transcriptForm(r), send.text, send.attachedCount > 0),
    );
    if (hit) {
      claimed.add(hit.i);
      matchedIds.push(send.id);
      matchedRowIdx.set(send.id, hit.i);
      continue;
    }

    if (send.state === "sent" && now - send.ts > SENT_TTL_MS) {
      expiredIds.push(send.id);
      continue;
    }

    unmatched.push(send);
  }

  let awaitingReply = false;
  const nonFailed = sends.filter((s) => s.state !== "failed");
  const lastSend = nonFailed.reduce<T | undefined>(
    (best, cur) => (!best || cur.ts > best.ts ? cur : best),
    undefined,
  );
  if (
    lastSend &&
    now - lastSend.ts < AWAIT_REPLY_MS &&
    agentStatus !== "working" &&
    (agentStatus !== "blocked" || now - lastSend.ts < 15_000)
  ) {
    const matchedAt = matchedRowIdx.get(lastSend.id);
    const hasReplyAfter =
      matchedAt !== undefined
        ? rows.some((r, i) => i > matchedAt && r.kind !== "user" && r.kind !== "system" && r.kind !== "model_switch")
        : rows.some((r) => r.kind !== "user" && r.kind !== "system" && r.kind !== "model_switch" && rowTs(r) >= lastSend.ts);
    awaitingReply = !hasReplyAfter;
  }

  return { unmatched, matchedIds, expiredIds, awaitingReply };
}

export type TimelineItem<T extends OutgoingSendLike> =
  | { kind: "row"; row: ChatRow }
  | { kind: "outgoing"; send: T };

/**
 * Interleaves unconfirmed optimistic `outgoing` sends chronologically inside the active
 * trailing segment (after the last persisted user turn) so short assistant replies over SSE
 * never appear above a just-sent prompt whose persisted page-fetch is still in flight.
 */
export function interleaveOptimisticSends<T extends OutgoingSendLike>(
  rows: ChatRow[],
  unmatched: T[],
): TimelineItem<T>[] {
  if (!unmatched.length) {
    return rows.map((row) => ({ kind: "row", row }));
  }

  let anchorIdx = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.kind === "user") {
      anchorIdx = i;
      break;
    }
  }

  const sortedUnmatched = [...unmatched].sort((a, b) => a.ts - b.ts);
  const firstSendTs = sortedUnmatched[0]!.ts;
  // Never place a new optimistic send before an already-completed previous turn.
  for (let i = rows.length - 1; i > anchorIdx; i -= 1) {
    const r = rows[i]!;
    if (r.kind === "turn_end" && r.ts <= firstSendTs) {
      anchorIdx = i;
      break;
    }
  }

  const out: TimelineItem<T>[] = [];
  for (let i = 0; i <= anchorIdx; i += 1) {
    out.push({ kind: "row", row: rows[i]! });
  }

  let uIdx = 0;
  for (let i = anchorIdx + 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const rTs = rowStartTs(row);
    // Allow 1000ms slack for second-truncated transcript timestamps on the same computer.
    while (uIdx < sortedUnmatched.length && (rTs === 0 || rTs >= sortedUnmatched[uIdx]!.ts - 1000)) {
      out.push({ kind: "outgoing", send: sortedUnmatched[uIdx]! });
      uIdx += 1;
    }
    out.push({ kind: "row", row });
  }
  while (uIdx < sortedUnmatched.length) {
    out.push({ kind: "outgoing", send: sortedUnmatched[uIdx]! });
    uIdx += 1;
  }
  return out;
}

/**
 * True only when the agent host is online, no send is in flight, the agent is ready
 * (`idle` or `done`), and the inter-dispatch cooldown has elapsed.
 */
export function shouldAutoDrainQueue(
  status: AgentStatus | undefined,
  online: boolean,
  lastDispatchedAt: number,
  inFlight: boolean,
  now: number,
): boolean {
  return (
    online &&
    !inFlight &&
    (status === "idle" || status === "done") &&
    now - lastDispatchedAt >= DRAIN_COOLDOWN_MS
  );
}
