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

/** Approx terminal column width (handles wide CJK/Emoji and ignores Kitty virtual placeholder U+10EEEE). */
export function terminalTextColumns(text: string): number {
  let cols = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x200b || cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f)) {
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
  if (!text) return null;
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
        return `\x1b[27;${modBits + 1};13~`;
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
