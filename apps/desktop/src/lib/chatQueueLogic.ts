import { matchesOptimisticCommand, sameMessage, type AgentStatus } from "@herdr-pocket/protocol";
import type { ChatRow } from "./chatFold";

export interface OutgoingSendLike {
  id: string;
  text: string;
  attachedCount: number;
  ts: number;
  state: "sending" | "sent" | "queued_terminal" | "failed";
}

/** True when the agent is actively executing or streaming a tool/activity turn. */
export function isAgentTurnBusy(status: AgentStatus | undefined, rows: readonly ChatRow[]): boolean {
  if (status === "working") return true;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 3); i -= 1) {
    const r = rows[i];
    if (!r) continue;
    if (r.kind === "assistant" || r.kind === "turn_end" || r.kind === "user") break;
    if (r.kind === "activity_group" && r.running) return true;
    if (r.kind === "tool" && r.step.running) return true;
  }
  return false;
}

const ECHO_SLACK_MS = 60_000;
const SENT_TTL_MS = 3 * 60_000;
const SLASH_SENT_TTL_MS = 8_000;
const AWAIT_REPLY_MS = 60_000;
const DRAIN_COOLDOWN_MS = 3500;

function rowTs(row: ChatRow): number {
  switch (row.kind) {
    case "user":
    case "assistant":
    case "turn_end":
    case "thinking":
    case "system":
    case "command_result":
    case "compact_notice":
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
  const attached = row.attachedLines ?? [];
  return attached.length > 0
    ? [row.text, ...attached].filter(Boolean).join("\n")
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

    const isSlash = send.text.trim().startsWith("/");
    let hitIdx = -1;
    const userHit = users.find(
      ({ r, i }) =>
        !claimed.has(i) &&
        (r.ts ?? 0) >= send.ts - ECHO_SLACK_MS &&
        sameMessage(transcriptForm(r), send.text, send.attachedCount > 0),
    );
    if (userHit) {
      hitIdx = userHit.i;
    } else if (isSlash) {
      hitIdx = rows.findIndex((r, i) => {
        if (claimed.has(i)) return false;
        const ts = rowTs(r);
        if (ts > 0 && ts < send.ts - ECHO_SLACK_MS) return false;
        return matchesOptimisticCommand(send.text, {
          kind: r.kind,
          summary: r.kind === "system" ? r.summary : r.kind === "command_result" ? r.command : undefined,
          text:
            r.kind === "user" || r.kind === "system" || r.kind === "command_result" || r.kind === "compact_notice"
              ? r.text
              : undefined,
          label: r.kind === "model_switch" ? r.label : undefined,
        });
      });
    }

    if (hitIdx >= 0) {
      claimed.add(hitIdx);
      matchedIds.push(send.id);
      matchedRowIdx.set(send.id, hitIdx);
      continue;
    }

    const ttlMs = isSlash ? SLASH_SENT_TTL_MS : SENT_TTL_MS;
    if ((send.state === "sent" || send.state === "queued_terminal") && now - send.ts > ttlMs) {
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
  const busyNow = isAgentTurnBusy(agentStatus, rows);
  if (
    lastSend &&
    lastSend.state !== "queued_terminal" &&
    !busyNow &&
    now - lastSend.ts < AWAIT_REPLY_MS &&
    (agentStatus !== "blocked" || now - lastSend.ts < 15_000)
  ) {
    const matchedAt = matchedRowIdx.get(lastSend.id);
    const isSlashLast = lastSend.text.trim().startsWith("/");
    if (isSlashLast && matchedAt !== undefined) {
      awaitingReply = false;
    } else {
      const hasReplyAfter =
        matchedAt !== undefined
          ? rows.some((r, i) => i > matchedAt && r.kind !== "user" && r.kind !== "system" && r.kind !== "model_switch")
          : rows.some((r) => r.kind !== "user" && r.kind !== "system" && r.kind !== "model_switch" && rowTs(r) >= lastSend.ts);
      awaitingReply = !hasReplyAfter;
    }
  }

  return { unmatched, matchedIds, expiredIds, awaitingReply };
}

export type TimelineItem<T extends OutgoingSendLike> =
  | { kind: "row"; row: ChatRow }
  | { kind: "outgoing"; send: T };

function isRunningRow(row: ChatRow): boolean {
  return (row.kind === "activity_group" && row.running) || (row.kind === "tool" && row.step.running);
}

/**
 * Interleaves unconfirmed optimistic `outgoing` sends chronologically inside the active
 * trailing segment (after the last persisted user turn) so short assistant replies over SSE
 * never appear above a just-sent prompt whose persisted page-fetch is still in flight.
 * Terminal-queued sends always stay at the very bottom after active turns.
 */
export function interleaveOptimisticSends<T extends OutgoingSendLike>(
  rows: ChatRow[],
  unmatched: T[],
): TimelineItem<T>[] {
  if (!unmatched.length) {
    return rows.map((row) => ({ kind: "row", row }));
  }

  const activeSends = unmatched.filter((s) => s.state !== "queued_terminal").sort((a, b) => a.ts - b.ts);
  const tailQueuedSends = unmatched.filter((s) => s.state === "queued_terminal").sort((a, b) => a.ts - b.ts);

  if (!activeSends.length) {
    return [
      ...rows.map((row) => ({ kind: "row" as const, row })),
      ...tailQueuedSends.map((send) => ({ kind: "outgoing" as const, send })),
    ];
  }

  const firstSendTs = activeSends[0]!.ts;

  let anchorIdx = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]!;
    if ((r.kind === "user" || r.kind === "turn_end" || r.kind === "command_result") && rowTs(r) <= firstSendTs) {
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
    const allowAtZero = rTs === 0 && !isRunningRow(row);
    // Allow 1000ms slack for second-truncated transcript timestamps on the same computer.
    while (uIdx < activeSends.length && (allowAtZero || (rTs > 0 && rTs >= activeSends[uIdx]!.ts - 1000))) {
      out.push({ kind: "outgoing", send: activeSends[uIdx]! });
      uIdx += 1;
    }
    out.push({ kind: "row", row });
  }
  while (uIdx < activeSends.length) {
    out.push({ kind: "outgoing", send: activeSends[uIdx]! });
    uIdx += 1;
  }
  for (const qSend of tailQueuedSends) {
    out.push({ kind: "outgoing", send: qSend });
  }
  return out;
}

/**
 * Filters terminal-side queued items that already appear inline as an optimistic outgoing
 * bubble, in the app queue, in recent persisted user turns, or have just been injected.
 */
export function filterTerminalQueuedItems<T extends OutgoingSendLike>(
  rawItems: readonly string[],
  unmatched: readonly T[],
  queuedTexts: readonly string[],
  injectedTexts?: ReadonlySet<string> | readonly string[],
  foldedRows?: readonly ChatRow[],
): string[] {
  const injectedList = injectedTexts ? Array.from(injectedTexts) : [];
  const recentUsers = foldedRows ? foldedRows.slice(-8).filter((r) => r.kind === "user") : [];
  return rawItems.filter((qText) => {
    if (!qText.trim()) return false;
    if (unmatched.some((u) => sameMessage(qText, u.text))) return false;
    if (queuedTexts.some((q) => sameMessage(qText, q))) return false;
    if (injectedList.some((inj) => sameMessage(qText, inj))) return false;
    if (recentUsers.some((r) => sameMessage(qText, transcriptForm(r)))) return false;
    return true;
  });
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
