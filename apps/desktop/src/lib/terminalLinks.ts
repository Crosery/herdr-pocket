import { looksLikeClickableFilePath, splitFileLineSuffix } from "./openFileTarget";

export interface TerminalBufferCellLike {
  getChars(): string;
  getWidth(): number;
}

export interface TerminalBufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number, cell?: TerminalBufferCellLike): TerminalBufferCellLike | undefined;
}

export interface TerminalBufferLike {
  readonly length: number;
  getNullCell(): TerminalBufferCellLike;
  getLine(y: number): TerminalBufferLineLike | undefined;
}

export interface TerminalBufferRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface DetectedTerminalLink {
  kind: "url" | "file";
  text: string;
  range: TerminalBufferRange;
}

interface CharCellCoord {
  row: number;
  col: number;
  width: number;
}

interface LogicalParagraph {
  startRow: number;
  endRow: number;
  text: string;
  coords: CharCellCoord[];
}

const MAX_WRAPPED_SPAN = 12;
const URL_RE = /https?:\/\/[^\s<>"'`\u0000-\u001f\u007f\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+/gi;
const DELIM_SPLIT_RE = /[\s()[\]{}<>"'`,;|，。；：！？「」『』【】（）]+/g;
const TRAILING_URL_PUNCT = new Set([".", ",", ";", ":", "!", "?", "]", "}", "'", '"', "`"]);

function collectLogicalParagraph(buf: TerminalBufferLike, absRow0: number): LogicalParagraph | null {
  if (absRow0 < 0 || absRow0 >= buf.length) return null;
  let startRow = absRow0;
  let steps = 0;
  while (startRow > 0 && steps < MAX_WRAPPED_SPAN) {
    const cur = buf.getLine(startRow);
    if (!cur || !cur.isWrapped) break;
    startRow -= 1;
    steps += 1;
  }

  let endRow = absRow0;
  steps = 0;
  while (endRow + 1 < buf.length && steps < MAX_WRAPPED_SPAN) {
    const next = buf.getLine(endRow + 1);
    if (!next || !next.isWrapped) break;
    endRow += 1;
    steps += 1;
  }

  const reusable = buf.getNullCell();
  let text = "";
  const coords: CharCellCoord[] = [];

  for (let row = startRow; row <= endRow; row++) {
    const line = buf.getLine(row);
    if (!line) continue;
    let lastNonEmpty = -1;
    for (let x = line.length - 1; x >= 0; x--) {
      const c = line.getCell(x, reusable);
      if (c && c.getWidth() > 0 && c.getChars().length > 0) {
        lastNonEmpty = x;
        break;
      }
    }
    const maxCol = Math.min(line.length - 1, lastNonEmpty);
    for (let x = 0; x <= maxCol; x++) {
      const c = line.getCell(x, reusable);
      if (!c) continue;
      const w = c.getWidth();
      if (w === 0) continue; // Trailing spacer cell for wide CJK/fullwidth glyph.
      const chars = c.getChars() || " ";
      const cellWidth = Math.max(1, w);
      for (let k = 0; k < chars.length; k++) {
        text += chars[k]!;
        coords.push({ row, col: x, width: cellWidth });
      }
    }
  }

  return { startRow, endRow, text, coords };
}

function trimUrlCandidate(raw: string): string {
  let s = raw;
  while (s.length > 0) {
    const last = s[s.length - 1]!;
    if (TRAILING_URL_PUNCT.has(last)) {
      s = s.slice(0, -1);
      continue;
    }
    if (last === ")") {
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "(") opens += 1;
        else if (s[i] === ")") closes += 1;
      }
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return s;
}

function rangeFromSpan(coords: CharCellCoord[], charStart: number, charEnd: number): TerminalBufferRange | null {
  if (charStart < 0 || charEnd <= charStart || charEnd > coords.length) return null;
  const first = coords[charStart]!;
  const last = coords[charEnd - 1]!;
  return {
    start: { x: first.col + 1, y: first.row + 1 },
    end: { x: last.col + last.width, y: last.row + 1 },
  };
}

function extractLinksFromParagraph(para: LogicalParagraph): DetectedTerminalLink[] {
  const out: DetectedTerminalLink[] = [];
  const usedSpans: Array<[number, number]> = [];
  const { text, coords } = para;
  if (!text) return out;

  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const clean = trimUrlCandidate(m[0]);
    if (!clean || clean.length <= "https://".length) continue;
    const start = m.index;
    const end = start + clean.length;
    const range = rangeFromSpan(coords, start, end);
    if (!range) continue;
    out.push({ kind: "url", text: clean, range });
    usedSpans.push([start, end]);
  }

  const overlapsUrl = (s: number, e: number) => usedSpans.some(([us, ue]) => s < ue && e > us);

  // Split around whitespace and CJK/ASCII punctuation, then inspect candidate tokens for file paths / file:// URIs.
  let pos = 0;
  DELIM_SPLIT_RE.lastIndex = 0;
  const pushToken = (rawStart: number, rawEnd: number) => {
    if (rawEnd <= rawStart) return;
    let start = rawStart;
    let end = rawEnd;
    // Trim leading/trailing quotes or ASCII punctuation except leading / . ~ and trailing digits/letters.
    while (start < end && /^['"`(<[{]$/.test(text[start]!)) start += 1;
    while (end > start && /^[.,;!?)'"`>\}\]]$/.test(text[end - 1]!)) end -= 1;
    if (end <= start) return;
    if (overlapsUrl(start, end)) return;
    const tok = text.slice(start, end);
    if (!looksLikeClickableFilePath(tok)) return;
    const range = rangeFromSpan(coords, start, end);
    if (!range) return;
    out.push({ kind: "file", text: tok, range });
  };

  while ((m = DELIM_SPLIT_RE.exec(text)) !== null) {
    if (m.index > pos) pushToken(pos, m.index);
    pos = m.index + m[0].length;
  }
  if (pos < text.length) pushToken(pos, text.length);

  out.sort((a, b) => a.range.start.y - b.range.start.y || a.range.start.x - b.range.start.x);
  return out;
}

/** Returns all URL and file links touching 1-based buffer row `bufferLineNumber`. */
export function findTerminalLinksForBufferLine(
  buf: TerminalBufferLike,
  bufferLineNumber: number,
): DetectedTerminalLink[] {
  const para = collectLogicalParagraph(buf, bufferLineNumber - 1);
  if (!para) return [];
  return extractLinksFromParagraph(para).filter(
    (link) => link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber,
  );
}

function cellInsideRange(range: TerminalBufferRange, row1: number, col1: number): boolean {
  if (row1 < range.start.y || row1 > range.end.y) return false;
  if (row1 === range.start.y && col1 < range.start.x) return false;
  if (row1 === range.end.y && col1 > range.end.x) return false;
  return true;
}

/** Finds a URL or file link under 0-based buffer coordinates `(absRow0, col0)`. */
export function findLinkAtCell(
  buf: TerminalBufferLike,
  absRow0: number,
  col0: number,
): DetectedTerminalLink | null {
  const row1 = absRow0 + 1;
  const col1 = col0 + 1;
  const links = findTerminalLinksForBufferLine(buf, row1);
  return links.find((l) => cellInsideRange(l.range, row1, col1)) ?? null;
}

const WORD_STOP_RE = /^[\s()[\]{}<>"'`.,;!?，。；：！？「」『』【】（）]$/;

/** Computes a double-click selection `{ col, row, length }` around 0-based `(absRow0, col0)`. */
export function findWordSelectionAtCell(
  buf: TerminalBufferLike,
  absRow0: number,
  col0: number,
  cols: number,
): { col: number; row: number; length: number } | null {
  const link = findLinkAtCell(buf, absRow0, col0);
  if (link) {
    const startCol = Math.max(0, link.range.start.x - 1);
    const startRow = link.range.start.y - 1;
    const endRow = link.range.end.y - 1;
    const endCol = link.range.end.x;
    const length = Math.max(1, (endRow - startRow) * cols + (endCol - startCol));
    return { col: startCol, row: startRow, length };
  }

  const line = buf.getLine(absRow0);
  if (!line || col0 < 0 || col0 >= line.length) return null;
  const reusable = buf.getNullCell();
  const charAt = (x: number): string | null => {
    const c = line.getCell(x, reusable);
    if (!c) return null;
    if (c.getWidth() === 0) return ""; // Wide-char spacer counts as part of same word.
    return c.getChars() || " ";
  };
  let targetCol = col0;
  if (charAt(targetCol) === "" && targetCol > 0) targetCol -= 1;
  const center = charAt(targetCol);
  if (center === null) return null;
  const isSpace = center === " ";
  const isStop = !isSpace && WORD_STOP_RE.test(center);

  if (isStop) {
    const w = Math.max(1, line.getCell(targetCol, reusable)?.getWidth() ?? 1);
    return { col: targetCol, row: absRow0, length: w };
  }

  let start = targetCol;
  while (start > 0) {
    const ch = charAt(start - 1);
    if (ch === null) break;
    if (ch === "") {
      start -= 1;
      continue;
    }
    if (isSpace ? ch === " " : ch !== " " && !WORD_STOP_RE.test(ch)) {
      start -= 1;
    } else {
      break;
    }
  }

  let end = targetCol + 1;
  const limit = Math.min(cols, line.length);
  while (end < limit) {
    const ch = charAt(end);
    if (ch === null) break;
    if (ch === "") {
      end += 1;
      continue;
    }
    if (isSpace ? ch === " " : ch !== " " && !WORD_STOP_RE.test(ch)) {
      end += 1;
    } else {
      break;
    }
  }

  return { col: start, row: absRow0, length: Math.max(1, end - start) };
}

/** Reads the full wrapped logical line containing `absRow0` as plain text. */
export function readLogicalLineText(buf: TerminalBufferLike, absRow0: number): string {
  return collectLogicalParagraph(buf, absRow0)?.text ?? "";
}

function normalizeMatchPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Resolves a bare filename or relative suffix clicked in terminal output (e.g.
 * `external-delivery-sequence.html`) to the nearest longer path mentioning it
 * in recent scrollback (e.g. `docs/external-delivery-sequence.html`), preserving `#L` / `:line`.
 */
export function resolveBareTerminalFileLink(
  buf: TerminalBufferLike,
  rawTarget: string,
  fromRow0?: number,
  maxLookbackLines = 400,
): string {
  const trimmed = rawTarget.trim();
  if (!trimmed) return rawTarget;
  if (/^(?:file:\/\/|https?:\/\/|mailto:|\/|~\/|\.\.\/|[A-Za-z]:[\\/])/i.test(trimmed)) {
    return rawTarget;
  }
  const { target, suffix } = splitFileLineSuffix(trimmed);
  const norm = normalizeMatchPath(target).replace(/\/+$/, "");
  if (!norm || norm === "." || norm === ".." || norm.includes("/")) return rawTarget;

  const endRow = Math.min(buf.length - 1, fromRow0 ?? buf.length - 1);
  if (endRow < 0) return rawTarget;
  const minRow = Math.max(0, endRow - Math.max(1, maxLookbackLines));

  const lowerSuffix = `/${norm.toLowerCase()}`;
  const exactSuffix = `/${norm}`;
  let caseInsensitiveHit: string | null = null;

  let row = endRow;
  while (row >= minRow) {
    const para = collectLogicalParagraph(buf, row);
    if (!para) {
      row -= 1;
      continue;
    }
    const links = extractLinksFromParagraph(para);
    for (let i = links.length - 1; i >= 0; i--) {
      const item = links[i]!;
      if (item.kind !== "file") continue;
      const candTargetRaw = splitFileLineSuffix(item.text).target;
      if (/^file:\/\//i.test(candTargetRaw)) continue;
      const candNorm = normalizeMatchPath(candTargetRaw).replace(/\/+$/, "");
      if (candNorm.length <= norm.length) continue;
      if (candNorm.endsWith(exactSuffix)) {
        return `${candTargetRaw}${suffix}`;
      }
      if (!caseInsensitiveHit && candNorm.toLowerCase().endsWith(lowerSuffix)) {
        caseInsensitiveHit = `${candTargetRaw}${suffix}`;
      }
    }
    row = para.startRow - 1;
  }

  return caseInsensitiveHit ?? rawTarget;
}
