import type { TermKeyInput } from "./termKeys";

// ---------------------------------------------------------------------------
// Kitty Graphics Protocol APC splitter & command parser
// ---------------------------------------------------------------------------

export type VtOrKittySegment =
  | { kind: "vt"; data: string }
  | { kind: "kitty"; raw: string };

/**
 * Stateful splitter that extracts Kitty graphics APC sequences (`ESC _ G ... ST/BEL`
 * or `0x9f G ...`) from raw VT text chunks without breaking sequences split across frames.
 */
export class KittyApcSplitter {
  private pending = "";

  push(chunk: string): VtOrKittySegment[] {
    if (!chunk && !this.pending) return [];
    const input = this.pending + chunk;
    this.pending = "";
    const out: VtOrKittySegment[] = [];
    let i = 0;

    while (i < input.length) {
      const escIdx = findNextApcStart(input, i);
      if (escIdx < 0) {
        // Hold trailing incomplete ESC / ESC _ prefix in case the next chunk completes `_G`.
        const tailHold = trailingEscPrefix(input, i);
        if (tailHold > i) {
          out.push({ kind: "vt", data: input.slice(i, tailHold) });
          this.pending = input.slice(tailHold);
        } else if (i < input.length) {
          if (this.pending) this.pending += input.slice(i);
          else if (input.length - i <= 3 && (input.endsWith("\x1b") || input.endsWith("\x1b_"))) {
            this.pending = input.slice(i);
          } else {
            out.push({ kind: "vt", data: input.slice(i) });
          }
        }
        break;
      }

      if (escIdx > i) {
        out.push({ kind: "vt", data: input.slice(i, escIdx) });
      }

      const start = input[escIdx] === "\x9f" ? escIdx + 2 : escIdx + 3; // after `\x9fG` or `\x1b_G`
      const end = findApcEnd(input, start);
      if (!end) {
        // Guard against unbounded memory if a malformed APC never closes (> 24 MB).
        if (input.length - escIdx > 24 * 1024 * 1024) {
          out.push({ kind: "vt", data: input.slice(escIdx) });
        } else {
          this.pending = input.slice(escIdx);
        }
        break;
      }

      out.push({ kind: "kitty", raw: input.slice(start, end.contentEnd) });
      i = end.nextIdx;
    }

    return out;
  }

  reset(): void {
    this.pending = "";
  }
}

function findNextApcStart(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\x1b" && i + 2 < s.length && s[i + 1] === "_" && s[i + 2] === "G") return i;
    if (c === "\x9f" && i + 1 < s.length && s[i + 1] === "G") return i;
  }
  return -1;
}

function trailingEscPrefix(s: string, minIdx: number): number {
  const n = s.length;
  if (n - minIdx >= 2 && s.endsWith("\x1b_")) return n - 2;
  if (n - minIdx >= 1 && (s.endsWith("\x1b") || s.endsWith("\x9f"))) return n - 1;
  return -1;
}

function findApcEnd(s: string, from: number): { contentEnd: number; nextIdx: number } | null {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\x07" || c === "\x9c") return { contentEnd: i, nextIdx: i + 1 };
    if (c === "\x1b" && i + 1 < s.length && s[i + 1] === "\\") return { contentEnd: i, nextIdx: i + 2 };
  }
  return null;
}

export interface KittyGfxCommand {
  action: "t" | "T" | "p" | "d" | "q" | "f" | "a" | "c";
  format: 24 | 32 | 100;
  medium: "d" | "f" | "t" | "s";
  compression?: "z";
  id?: number;
  imageNumber?: number;
  placementId?: number;
  more: boolean;
  width?: number;
  height?: number;
  cols?: number;
  rows?: number;
  cropW?: number;
  cropH?: number;
  cropX?: number;
  cropY?: number;
  cursorMovement: 0 | 1;
  unicodePlaceholder: boolean;
  deleteWhat?: string;
  quiet: 0 | 1 | 2;
  zIndex: number;
  payload: string;
}

export function parseKittyGfxCommand(raw: string): KittyGfxCommand {
  const semi = raw.indexOf(";");
  const header = semi >= 0 ? raw.slice(0, semi) : raw;
  const payload = semi >= 0 ? raw.slice(semi + 1) : "";
  const kv: Record<string, string> = {};
  if (header) {
    for (const part of header.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const int = (k: string): number | undefined => {
    const v = kv[k];
    if (v === undefined) return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const a = kv.a;
  const action: KittyGfxCommand["action"] =
    a === "T" || a === "p" || a === "d" || a === "q" || a === "f" || a === "a" || a === "c" ? a : "t";
  const fmtRaw = int("f");
  const format: 24 | 32 | 100 = fmtRaw === 24 || fmtRaw === 32 ? fmtRaw : 100;
  const t = kv.t;
  const medium: KittyGfxCommand["medium"] = t === "f" || t === "t" || t === "s" ? t : "d";
  const qRaw = int("q");
  const quiet: 0 | 1 | 2 = qRaw === 1 || qRaw === 2 ? qRaw : 0;

  return {
    action,
    format,
    medium,
    compression: kv.o === "z" ? "z" : undefined,
    id: int("i"),
    imageNumber: int("I"),
    placementId: int("p"),
    more: kv.m === "1",
    width: int("s"),
    height: int("v"),
    cols: int("c"),
    rows: int("r"),
    cropW: int("w"),
    cropH: int("h"),
    cropX: int("x"),
    cropY: int("y"),
    cursorMovement: int("C") === 1 ? 1 : 0,
    unicodePlaceholder: int("U") === 1,
    deleteWhat: kv.d,
    quiet,
    zIndex: int("z") ?? 0,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Kitty Text Sizing Protocol (OSC 66)
// ---------------------------------------------------------------------------

export interface Osc66Parsed {
  scale: number;
  num: number;
  den: number;
  /** Fractional multiplier relative to the cell box (`num / den`, else 1). */
  ratio: number;
  width: number;
  explicitWidth: boolean;
  verticalAlign: 0 | 1 | 2;
  horizontalAlign: 0 | 1 | 2;
  text: string;
  /** Number of terminal grid columns this text occupies horizontally. */
  cellsWide: number;
}

const KITTY_VIRTUAL_PLACEHOLDER = 0x10eeee;

/**
 * Official 297-entry Kitty Unicode Placeholder row/column combining diacritics table
 * (`rowcolumn-diacritics.txt`, ordered index 0..296).
 */
export const KITTY_PLACEHOLDER_DIACRITICS: readonly number[] = [
  773, 781, 782, 784, 786, 829, 830, 831, 838, 842, 843, 844, 848, 849, 850, 855, 859,
  867, 868, 869, 870, 871, 872, 873, 874, 875, 876, 877, 878, 879, 1155, 1156, 1157,
  1158, 1159, 1426, 1427, 1428, 1429, 1431, 1432, 1433, 1436, 1437, 1438, 1439, 1440,
  1441, 1448, 1449, 1451, 1452, 1455, 1476, 1552, 1553, 1554, 1555, 1556, 1557, 1558,
  1559, 1623, 1624, 1625, 1626, 1627, 1629, 1630, 1750, 1751, 1752, 1753, 1754, 1755,
  1756, 1759, 1760, 1761, 1762, 1764, 1767, 1768, 1771, 1772, 1840, 1842, 1843, 1845,
  1846, 1850, 1853, 1855, 1856, 1857, 1859, 1861, 1863, 1865, 1866, 2027, 2028, 2029,
  2030, 2031, 2032, 2033, 2035, 2070, 2071, 2072, 2073, 2075, 2076, 2077, 2078, 2079,
  2080, 2081, 2082, 2083, 2085, 2086, 2087, 2089, 2090, 2091, 2092, 2093, 2385, 2387,
  2388, 3970, 3971, 3974, 3975, 4957, 4958, 4959, 6109, 6458, 6679, 6773, 6774, 6775,
  6776, 6777, 6778, 6779, 6780, 7019, 7021, 7022, 7023, 7024, 7025, 7026, 7027, 7376,
  7377, 7378, 7386, 7387, 7392, 7616, 7617, 7619, 7620, 7621, 7622, 7623, 7624, 7625,
  7627, 7628, 7633, 7634, 7635, 7636, 7637, 7638, 7639, 7640, 7641, 7642, 7643, 7644,
  7645, 7646, 7647, 7648, 7649, 7650, 7651, 7652, 7653, 7654, 7678, 8400, 8401, 8404,
  8405, 8406, 8407, 8411, 8412, 8417, 8423, 8425, 8432, 11503, 11504, 11505, 11744,
  11745, 11746, 11747, 11748, 11749, 11750, 11751, 11752, 11753, 11754, 11755, 11756,
  11757, 11758, 11759, 11760, 11761, 11762, 11763, 11764, 11765, 11766, 11767, 11768,
  11769, 11770, 11771, 11772, 11773, 11774, 11775, 42607, 42620, 42621, 42736, 42737,
  43232, 43233, 43234, 43235, 43236, 43237, 43238, 43239, 43240, 43241, 43242, 43243,
  43244, 43245, 43246, 43247, 43248, 43249, 43696, 43698, 43699, 43703, 43704, 43710,
  43711, 43713, 65056, 65057, 65058, 65059, 65060, 65061, 65062, 68111, 68152, 119173,
  119174, 119175, 119176, 119177, 119210, 119211, 119212, 119213, 119362, 119363, 119364,
];

const KITTY_DIACRITIC_INDEX = new Map<number, number>(
  KITTY_PLACEHOLDER_DIACRITICS.map((cp, idx) => [cp, idx]),
);

const KITTY_PLACEHOLDER_UTF16 = String.fromCodePoint(KITTY_VIRTUAL_PLACEHOLDER);

/**
 * 1-column-wide, zero-ink sentinel stored in xterm.js cells for `U+10EEEE` placeholders
 * (`U+2800` Braille Pattern Blank + `U+200B` ZWSP, followed by 27 `U+200C`/`U+200D` payload bits).
 */
export const KITTY_SENTINEL_PREFIX = "\u2800\u200B";
const SENTINEL_BIT0 = "\u200C";
const SENTINEL_BIT1 = "\u200D";
const SENTINEL_OMITTED = 0x1ff; // 511 (9 bits, outside 0..296)
const SENTINEL_PAYLOAD_BITS = 27;

export interface KittyPlaceholderCellMeta {
  row?: number;
  col?: number;
  idMsb?: number;
}

function encode9Bits(val: number | undefined): string {
  const n = val === undefined ? SENTINEL_OMITTED : Math.max(0, Math.min(KITTY_PLACEHOLDER_DIACRITICS.length - 1, val));
  let out = "";
  for (let b = 8; b >= 0; b--) {
    out += (n >> b) & 1 ? SENTINEL_BIT1 : SENTINEL_BIT0;
  }
  return out;
}

function decode9Bits(s: string, offset: number): number | undefined | null {
  let n = 0;
  for (let i = 0; i < 9; i++) {
    const ch = s[offset + i];
    if (ch === SENTINEL_BIT0) n <<= 1;
    else if (ch === SENTINEL_BIT1) n = (n << 1) | 1;
    else return null;
  }
  if (n === SENTINEL_OMITTED) return undefined;
  return n < KITTY_PLACEHOLDER_DIACRITICS.length ? n : null;
}

/** Encodes Kitty placeholder `(row, col, idMsb)` metadata into a 1-column zero-ink sentinel cell string. */
export function encodeKittySentinel(meta: KittyPlaceholderCellMeta): string {
  return KITTY_SENTINEL_PREFIX + encode9Bits(meta.row) + encode9Bits(meta.col) + encode9Bits(meta.idMsb);
}

/** Decodes `(row, col, idMsb)` from a Kitty placeholder sentinel cell string, or null if not a valid sentinel. */
export function decodeKittySentinel(chars: string): KittyPlaceholderCellMeta | null {
  if (!chars.startsWith(KITTY_SENTINEL_PREFIX) || chars.length < KITTY_SENTINEL_PREFIX.length + SENTINEL_PAYLOAD_BITS) {
    return null;
  }
  const base = KITTY_SENTINEL_PREFIX.length;
  const row = decode9Bits(chars, base);
  if (row === null) return null;
  const col = decode9Bits(chars, base + 9);
  if (col === null) return null;
  const idMsb = decode9Bits(chars, base + 18);
  if (idMsb === null) return null;
  return { row, col, idMsb };
}

/**
 * Streaming VT rewriter that converts `U+10EEEE` + 0..3 Kitty row/col/idMsb combining diacritics
 * into guaranteed 1-column, zero-ink sentinels (`\u2800\u200B...`) without breaking across
 * UTF-16 surrogate boundaries or split chunks.
 */
export class KittyUnicodePlaceholderRewriter {
  private pendingHighSurrogate = "";
  private inPlaceholder = false;
  private diacritics: number[] = [];

  private emitPlaceholder(): string {
    const [row, col, idMsb] = this.diacritics;
    this.inPlaceholder = false;
    this.diacritics.length = 0;
    return encodeKittySentinel({ row, col, idMsb });
  }

  push(chunk: string): string {
    if (!chunk) return "";

    if (!this.inPlaceholder && !this.pendingHighSurrogate && !chunk.includes(KITTY_PLACEHOLDER_UTF16)) {
      const last = chunk.charCodeAt(chunk.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        this.pendingHighSurrogate = chunk.slice(-1);
        return chunk.slice(0, -1);
      }
      return chunk;
    }

    const input = this.pendingHighSurrogate ? this.pendingHighSurrogate + chunk : chunk;
    this.pendingHighSurrogate = "";

    let out = "";
    let i = 0;
    while (i < input.length) {
      const code = input.charCodeAt(i);
      let cp: number;
      let step: number;
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= input.length) {
          this.pendingHighSurrogate = input[i]!;
          break;
        }
        const low = input.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
          step = 2;
        } else {
          cp = code;
          step = 1;
        }
      } else {
        cp = code;
        step = 1;
      }

      if (this.inPlaceholder) {
        const idx = KITTY_DIACRITIC_INDEX.get(cp);
        if (idx !== undefined && this.diacritics.length < 3) {
          this.diacritics.push(idx);
          i += step;
          if (this.diacritics.length === 3) {
            out += this.emitPlaceholder();
          }
          continue;
        }
        out += this.emitPlaceholder();
      }

      if (cp === KITTY_VIRTUAL_PLACEHOLDER) {
        this.inPlaceholder = true;
        this.diacritics.length = 0;
        i += step;
        continue;
      }

      out += input.slice(i, i + step);
      i += step;
    }

    return out;
  }

  flush(): string {
    let out = "";
    if (this.inPlaceholder) {
      out += this.emitPlaceholder();
    }
    if (this.pendingHighSurrogate) {
      out += this.pendingHighSurrogate;
      this.pendingHighSurrogate = "";
    }
    return out;
  }

  reset(): void {
    this.pendingHighSurrogate = "";
    this.inPlaceholder = false;
    this.diacritics.length = 0;
  }
}

export interface KittyVirtualPlacementDims {
  cols: number;
  rows: number;
  zIndex: number;
}

/** True only for non-virtual (`U=0`) `a=T` / `a=p` placements anchored at the terminal cursor. */
export function shouldCreateCursorPlacement(cmd: Pick<KittyGfxCommand, "action" | "unicodePlaceholder">): boolean {
  return (cmd.action === "T" || cmd.action === "p") && !cmd.unicodePlaceholder;
}

/** Registers virtual (`U=1`) dimensions under both `${imageId}:${placementId}` and `${imageId}:0`. */
export function registerKittyVirtualPlacement(
  map: Map<string, KittyVirtualPlacementDims>,
  imageId: number,
  placementId: number | undefined,
  cols: number,
  rows: number,
  zIndex = 0,
): void {
  const dims: KittyVirtualPlacementDims = { cols, rows, zIndex };
  map.set(`${imageId}:${placementId ?? 0}`, dims);
  map.set(`${imageId}:0`, dims);
}

/** Removes virtual (`U=1`) placement dimensions for `imageId` (or a single `placementId` when provided). */
export function deleteKittyVirtualPlacements(
  map: Map<string, KittyVirtualPlacementDims>,
  imageId: number,
  placementId?: number,
): void {
  if (placementId !== undefined) {
    map.delete(`${imageId}:${placementId}`);
    return;
  }
  const prefix = `${imageId}:`;
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key);
  }
}

export function lookupKittyVirtualPlacement(
  map: Map<string, KittyVirtualPlacementDims>,
  imageId: number,
  placementId: number,
): KittyVirtualPlacementDims | undefined {
  return map.get(`${imageId}:${placementId}`) ?? map.get(`${imageId}:0`);
}

export interface KittyBufferCellSample {
  chars: string;
  width: number;
  fgMode: "rgb" | "palette" | "default";
  fgColor: number;
  placementId: number;
}

export interface VirtualSpriteBlock {
  imageId: number;
  placementId: number;
  startAbsY: number;
  startX: number;
  cols: number;
  rows: number;
  startTileCol: number;
  startTileRow: number;
}

interface ActiveVirtualBlock extends VirtualSpriteBlock {
  lastAbsY: number;
  lastTileRow: number;
}

interface HorizontalVirtualRun {
  absY: number;
  startX: number;
  len: number;
  imageId: number;
  placementId: number;
  tileRow: number;
  startTileCol: number;
  lastTileCol: number;
}

/**
 * Scans visible terminal rows (`topY .. botY - 1`), decodes Kitty sentinel cells, resolves omitted
 * diacritic inheritance left-to-right, and merges contiguous cells into rectangular sprite blocks.
 */
export function collectVirtualSpriteBlocks(
  topY: number,
  botY: number,
  cols: number,
  readSentinelCell: (absY: number, x: number, out: KittyBufferCellSample) => boolean,
): VirtualSpriteBlock[] {
  const sample: KittyBufferCellSample = { chars: "", width: 1, fgMode: "default", fgColor: 0, placementId: 0 };
  const completed: VirtualSpriteBlock[] = [];
  let active: ActiveVirtualBlock[] = [];

  const finalizeBlock = (blk: ActiveVirtualBlock): VirtualSpriteBlock => ({
    imageId: blk.imageId,
    placementId: blk.placementId,
    startAbsY: blk.startAbsY,
    startX: blk.startX,
    cols: blk.cols,
    rows: blk.rows,
    startTileCol: blk.startTileCol,
    startTileRow: blk.startTileRow,
  });

  for (let absY = topY; absY < botY; absY++) {
    // Finalize any active block that did not continue onto the previous row.
    if (active.length > 0) {
      const nextActive: ActiveVirtualBlock[] = [];
      for (const blk of active) {
        if (blk.lastAbsY === absY - 1) nextActive.push(blk);
        else completed.push(finalizeBlock(blk));
      }
      active = nextActive;
    }

    const rowRuns: HorizontalVirtualRun[] = [];
    let currentRun: HorizontalVirtualRun | null = null;
    let prevCell: { baseId: number; placementId: number; row: number; col: number; idMsb: number } | null = null;

    const flushRun = () => {
      if (currentRun) {
        rowRuns.push(currentRun);
        currentRun = null;
      }
    };

    for (let x = 0; x < cols; x++) {
      if (!readSentinelCell(absY, x, sample) || sample.width === 0) {
        prevCell = null;
        flushRun();
        continue;
      }

      const meta = decodeKittySentinel(sample.chars);
      if (!meta) {
        prevCell = null;
        flushRun();
        continue;
      }

      const baseId = sample.fgMode === "default" ? 0 : sample.fgColor;
      const placementId = sample.placementId;
      const canInherit = prevCell !== null && prevCell.baseId === baseId && prevCell.placementId === placementId;

      let tileRow: number;
      let tileCol: number;
      let idMsb: number;

      if (meta.row === undefined) {
        if (canInherit) {
          tileRow = prevCell!.row;
          tileCol = prevCell!.col + 1;
          idMsb = prevCell!.idMsb;
        } else {
          tileRow = 0;
          tileCol = 0;
          idMsb = 0;
        }
      } else if (meta.col === undefined) {
        if (canInherit && prevCell!.row === meta.row) {
          tileRow = meta.row;
          tileCol = prevCell!.col + 1;
          idMsb = prevCell!.idMsb;
        } else {
          tileRow = meta.row;
          tileCol = 0;
          idMsb = 0;
        }
      } else if (meta.idMsb === undefined) {
        if (canInherit && prevCell!.row === meta.row && prevCell!.col + 1 === meta.col) {
          tileRow = meta.row;
          tileCol = meta.col;
          idMsb = prevCell!.idMsb;
        } else {
          tileRow = meta.row;
          tileCol = meta.col;
          idMsb = 0;
        }
      } else {
        tileRow = meta.row;
        tileCol = meta.col;
        idMsb = meta.idMsb;
      }

      prevCell = { baseId, placementId, row: tileRow, col: tileCol, idMsb };
      const imageId = baseId + (idMsb & 0xff) * 0x1000000;
      if (imageId === 0) {
        flushRun();
        continue;
      }

      if (
        currentRun &&
        currentRun.startX + currentRun.len === x &&
        currentRun.imageId === imageId &&
        currentRun.placementId === placementId &&
        currentRun.tileRow === tileRow &&
        currentRun.lastTileCol + 1 === tileCol
      ) {
        currentRun.len += 1;
        currentRun.lastTileCol = tileCol;
      } else {
        flushRun();
        currentRun = {
          absY,
          startX: x,
          len: 1,
          imageId,
          placementId,
          tileRow,
          startTileCol: tileCol,
          lastTileCol: tileCol,
        };
      }
    }
    flushRun();

    for (const run of rowRuns) {
      let matched = false;
      for (const blk of active) {
        if (
          blk.lastAbsY === absY - 1 &&
          blk.imageId === run.imageId &&
          blk.placementId === run.placementId &&
          blk.startX === run.startX &&
          blk.cols === run.len &&
          blk.startTileCol === run.startTileCol &&
          blk.lastTileRow + 1 === run.tileRow
        ) {
          blk.rows += 1;
          blk.lastAbsY = absY;
          blk.lastTileRow = run.tileRow;
          matched = true;
          break;
        }
      }
      if (!matched) {
        active.push({
          imageId: run.imageId,
          placementId: run.placementId,
          startAbsY: absY,
          startX: run.startX,
          cols: run.len,
          rows: 1,
          startTileCol: run.startTileCol,
          startTileRow: run.tileRow,
          lastAbsY: absY,
          lastTileRow: run.tileRow,
        });
      }
    }
  }

  for (const blk of active) {
    completed.push(finalizeBlock(blk));
  }
  return completed;
}

/** Approx terminal column width (handles wide CJK/Emoji and treats Kitty U+10EEEE / sentinels as width 1). */
export function terminalTextColumns(text: string): number {
  let cols = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (
      cp < 0x20 ||
      cp === 0x200b ||
      cp === 0x200c ||
      cp === 0x200d ||
      (cp >= 0x300 && cp <= 0x36f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      KITTY_DIACRITIC_INDEX.has(cp)
    ) {
      continue;
    }
    if (cp === KITTY_VIRTUAL_PLACEHOLDER || cp === 0x2800) {
      cols += 1;
      continue;
    }
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      cols += 2;
    } else {
      cols += 1;
    }
  }
  return cols;
}

/**
 * Parses Kitty OSC 66 text-sizing sequence payload (`<metadata>;<text>`).
 * Returns null if invalid or if `text` contains a Kitty U+10EEEE virtual image placeholder,
 * which must remain untouched so virtual graphics placements do not get wrapped as scaled text.
 */
export function parseOsc66(data: string): Osc66Parsed | null {
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const metaRaw = data.slice(0, semi);
  const text = data.slice(semi + 1);
  if (!text || text.includes(KITTY_SENTINEL_PREFIX)) return null;
  for (const ch of text) {
    if (ch.codePointAt(0) === KITTY_VIRTUAL_PLACEHOLDER) return null;
  }

  let scale = 1;
  let num = 0;
  let den = 0;
  let width = 0;
  let verticalAlign: 0 | 1 | 2 = 0;
  let horizontalAlign: 0 | 1 | 2 = 0;

  if (metaRaw) {
    for (const pair of metaRaw.split(":")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq);
      const v = Number.parseInt(pair.slice(eq + 1), 10);
      if (!Number.isFinite(v)) continue;
      if (k === "s") scale = Math.max(1, Math.min(7, v));
      else if (k === "n") num = Math.max(0, Math.min(7, v));
      else if (k === "d") den = Math.max(0, Math.min(7, v));
      else if (k === "w") width = Math.max(0, Math.min(7, v));
      else if (k === "v" && (v === 0 || v === 1 || v === 2)) verticalAlign = v;
      else if (k === "h" && (v === 0 || v === 1 || v === 2)) horizontalAlign = v;
    }
  }

  const ratio = num > 0 && den > num ? num / den : 1;
  const baseCols = Math.max(1, width > 0 ? width : terminalTextColumns(text));
  const cellsWide = Math.max(1, Math.round(baseCols * scale));
  return {
    scale,
    num,
    den,
    ratio,
    width,
    explicitWidth: width > 0,
    verticalAlign,
    horizontalAlign,
    text,
    cellsWide,
  };
}

// ---------------------------------------------------------------------------
// Kitty Keyboard Protocol state stack & CSI u encoding
// ---------------------------------------------------------------------------

export class KittyKeyboardState {
  private normal: number[] = [];
  private alt: number[] = [];
  modifyOtherKeys = 0;
  win32InputMode = false;

  private stack(altScreen: boolean): number[] {
    return altScreen ? this.alt : this.normal;
  }

  current(altScreen: boolean): number {
    const s = this.stack(altScreen);
    return s.length ? s[s.length - 1]! : 0;
  }

  push(altScreen: boolean, flags: number): void {
    const s = this.stack(altScreen);
    s.push(flags & 0x1f);
    if (s.length > 32) s.shift();
  }

  pop(altScreen: boolean, count = 1): void {
    const s = this.stack(altScreen);
    const n = Math.max(1, count);
    s.splice(Math.max(0, s.length - n), n);
  }

  set(altScreen: boolean, flags: number, mode = 1): void {
    const s = this.stack(altScreen);
    const masked = flags & 0x1f;
    const top = s.length ? s[s.length - 1]! : 0;
    const next = mode === 2 ? top | masked : mode === 3 ? top & ~masked : masked;
    if (s.length) s[s.length - 1] = next;
    else s.push(next);
  }

  reset(): void {
    this.normal = [];
    this.alt = [];
    this.modifyOtherKeys = 0;
    this.win32InputMode = false;
  }
}

function encodeWin32Enter(shift: boolean, ctrl: boolean, alt: boolean): string {
  const held = (shift ? 0x10 : 0) | (ctrl ? 0x08 : 0) | (alt ? 0x02 : 0);
  const typed = ctrl ? 10 : 13;
  return `\x1b[13;28;${typed};1;${held};1_\x1b[13;28;${typed};0;${held};1_`;
}

const KITTY_SPECIAL_CODES: Record<string, { code: number; final?: string; legacyCode?: number }> = {
  Escape: { code: 27 },
  Enter: { code: 13 },
  Tab: { code: 9 },
  Backspace: { code: 127 },
  Insert: { code: 2, final: "~" },
  Delete: { code: 3, final: "~" },
  PageUp: { code: 5, final: "~" },
  PageDown: { code: 6, final: "~" },
  ArrowUp: { code: 1, final: "A" },
  ArrowDown: { code: 1, final: "B" },
  ArrowRight: { code: 1, final: "C" },
  ArrowLeft: { code: 1, final: "D" },
  Home: { code: 1, final: "H" },
  End: { code: 1, final: "F" },
  F1: { code: 1, final: "P", legacyCode: 57364 },
  F2: { code: 1, final: "Q", legacyCode: 57365 },
  F3: { code: 1, final: "R", legacyCode: 57366 },
  F4: { code: 1, final: "S", legacyCode: 57367 },
  F5: { code: 15, final: "~" },
  F6: { code: 17, final: "~" },
  F7: { code: 18, final: "~" },
  F8: { code: 19, final: "~" },
  F9: { code: 20, final: "~" },
  F10: { code: 21, final: "~" },
  F11: { code: 23, final: "~" },
  F12: { code: 24, final: "~" },
};

/**
 * Encodes a keydown using the Kitty keyboard protocol (`CSI u`), xterm `modifyOtherKeys`,
 * Windows ConPTY `win32-input-mode` (`?9001h`), or legacy modified-Enter sequences (`CSI 27;mod;13~` / `ESC CR`).
 * Returns null if standard xterm legacy handling should proceed.
 */
export function encodeKittyKey(
  e: TermKeyInput,
  flags: number,
  modifyOtherKeys: number,
  mac: boolean,
  win32InputMode = false,
  isShell = false,
): string | null {
  if (mac && e.metaKey) return null;

  const modBits =
    (e.shiftKey ? 1 : 0) +
    (e.altKey ? 2 : 0) +
    (e.ctrlKey ? 4 : 0) +
    (e.metaKey && !mac ? 8 : 0);

  if (flags === 0) {
    if (win32InputMode && e.key === "Enter" && modBits > 0) {
      return encodeWin32Enter(e.shiftKey, e.ctrlKey, e.altKey);
    }
    if (modifyOtherKeys === 0) {
      if (e.key === "Enter" && modBits > 0) {
        if (e.altKey && !e.shiftKey && !e.ctrlKey) return "\x1b\r";
        if (isShell) return "\x1b\r";
        return `\x1b[${13};${modBits + 1}u`;
      }
      return null;
    }
  }

  // With Kitty disambiguate (bit 1) or modifyOtherKeys, modified Enter/Tab/Escape/Backspace emit unambiguous sequences.
  const special = KITTY_SPECIAL_CODES[e.key];
  if (special) {
    if (modBits === 0 && !(flags & 8)) return null;
    const modParam = modBits + 1;
    if (special.final && special.final !== "~") {
      return `\x1b[1;${modParam}${special.final}`;
    }
    if (special.final === "~") {
      return `\x1b[${special.code};${modParam}~`;
    }
    if (flags === 0 && modifyOtherKeys > 0) {
      return `\x1b[27;${modParam};${special.code}~`;
    }
    return `\x1b[${special.code};${modParam}u`;
  }

  if (e.key.length === 1 && (e.ctrlKey || e.altKey)) {
    const cp = e.key.toLowerCase().codePointAt(0)!;
    // With disambiguate (1) or report-all (8), modified ASCII keys use CSI code;mod u (except plain Enter/Ctrl+C if flags==0).
    if ((flags & 1) || (flags & 8) || (modifyOtherKeys >= 2 && modBits > 0)) {
      const shifted = e.shiftKey && e.key !== e.key.toLowerCase() ? `:${e.key.codePointAt(0)!}` : "";
      const keyCode = flags & 4 ? `${cp}${shifted}` : String(cp);
      return `\x1b[${keyCode};${modBits + 1}u`;
    }
  }

  return null;
}

export function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_./~:-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Reads pixel dimensions from a PNG IHDR header, or null if bytes are not a valid PNG. */
export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { width, height };
}
