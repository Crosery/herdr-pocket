/**
 * Pure turn-aware caption ordering helpers for voice calls.
 * Kept dependency-free so both the React Native client and Node tests run the exact same logic.
 */

/** One caption of the current call. Text is always the whole line so far, never a piece. */
export interface CallLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** False while the line is still being said. */
  final: boolean;
  turn?: number;
}

/** Parses a non-negative integer turn from a number or numeric string (`d.turn` / `d.turn_id`). */
export function numTurn(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^\d+$/.test(s)) return undefined;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Adds a caption or replaces the one with the same id.
 * When a user's transcript arrives after the assistant has already started answering that turn
 * (common in OpenAI Realtime when TTFA < input ASR), place the user caption above the reply.
 */
export function upsertCallLine(lines: CallLine[], line: CallLine, maxLines = 30): CallLine[] {
  const i = lines.findIndex((l) => l.id === line.id);
  if (i >= 0) {
    const next = lines.slice();
    next[i] = { ...line, turn: line.turn ?? lines[i]!.turn };
    return next;
  }
  if (line.role === "user" && line.turn !== undefined) {
    const idx = lines.findIndex((l) => l.role === "assistant" && l.turn !== undefined && l.turn >= line.turn!);
    if (idx >= 0) {
      const next = lines.slice();
      next.splice(idx, 0, line);
      return next.slice(-maxLines);
    }
  }
  return [...lines, line].slice(-maxLines);
}

/**
 * Only enter "thinking" ("小羊在想") if the assistant is not already speaking and has not already
 * started/finished answering this user turn.
 */
export function shouldWaitForAnswer(turn: number | undefined, lastAnsweredTurn: number, speaking: boolean): boolean {
  return !speaking && (turn === undefined || turn > lastAnsweredTurn);
}
