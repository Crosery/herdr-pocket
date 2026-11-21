/**
 * A small terminal screen model: enough of VT/xterm to turn a terminal's
 * paint (first paint + redraws) into a clean colored snapshot for a phone.
 * Handles text, wide characters, cursor movement, erase, scroll and SGR.
 * Everything else (modes, OSC, DCS, mouse, kitty keys) is parsed and ignored.
 */

interface Cell {
  ch: string;
  /** SGR parameters active for this cell, "" = default. */
  sgr: string;
}

const BLANK: Cell = { ch: " ", sgr: "" };

const KITTY_VIRTUAL_PLACEHOLDER = 0x10eeee;

/** Official 297-entry Kitty row/col combining diacritics (always zero-width). */
const KITTY_COMBINING_DIACRITICS = new Set<number>([
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
]);

/** East Asian wide / fullwidth and emoji presentation: two cells; Kitty U+10EEEE: 1 cell; combining marks: 0. */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp === KITTY_VIRTUAL_PLACEHOLDER) return 1;
  if (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    KITTY_COMBINING_DIACRITICS.has(cp)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export class Screen {
  cols: number;
  rows: number;
  private grid: Cell[][];
  /** Lines scrolled off the top (main screen only), oldest first. */
  scrollback: Cell[][] = [];
  private x = 0;
  private y = 0;
  private sgr = "";
  private saved = { x: 0, y: 0, sgr: "", wrapNext: false };
  private top = 0;
  private bottom: number;
  private alt: Cell[][] | null = null;
  private pending = "";
  private wrapNext = false;
  private maxScrollback: number;

  constructor(cols: number, rows: number, maxScrollback = 2000) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.bottom = this.rows - 1;
    this.maxScrollback = maxScrollback;
    this.grid = this.blankGrid();
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.cols }, () => BLANK);
  }

  private blankGrid(): Cell[][] {
    return Array.from({ length: this.rows }, () => this.blankRow());
  }

  write(data: string): void {
    const s = this.pending + data;
    this.pending = "";
    let i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x1b) {
        const end = this.escape(s, i);
        if (end < 0) {
          this.pending = s.slice(i); // incomplete sequence: wait for more
          return;
        }
        i = end;
        continue;
      }
      if (c < 0x20 || c === 0x7f) {
        this.control(c);
        i++;
        continue;
      }
      const cp = s.codePointAt(i)!;
      const len = cp > 0xffff ? 2 : 1;
      this.print(s.slice(i, i + len), cp);
      i += len;
    }
  }

  private control(c: number): void {
    switch (c) {
      case 0x0d:
        this.x = 0;
        this.wrapNext = false;
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.lineFeed();
        break;
      case 0x08:
        if (this.x > 0) this.x--;
        this.wrapNext = false;
        break;
      case 0x09:
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
        break;
      default:
        break; // BEL, SO/SI, CAN ...
    }
  }

  private print(ch: string, cp: number): void {
    const w = charWidth(cp);
    if (w === 0) {
      // Combining mark: attach to the previous cell.
      const px = this.x > 0 ? this.x - 1 : 0;
      const cell = this.grid[this.y]![px]!;
      this.grid[this.y]![px] = { ...cell, ch: cell.ch + ch };
      return;
    }
    if (this.wrapNext || this.x + w > this.cols) {
      this.x = 0;
      this.lineFeed();
      this.wrapNext = false;
    }
    const row = this.grid[this.y]!;
    row[this.x] = { ch, sgr: this.sgr };
    if (w === 2 && this.x + 1 < this.cols) row[this.x + 1] = { ch: "", sgr: this.sgr };
    this.x += w;
    if (this.x >= this.cols) {
      this.x = this.cols - 1;
      this.wrapNext = true;
    }
  }

  private lineFeed(): void {
    this.wrapNext = false;
    if (this.y === this.bottom) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
  }

  private scrollUp(n: number): void {
    for (let k = 0; k < n; k++) {
      const [gone] = this.grid.splice(this.top, 1);
      if (!this.alt && this.top === 0 && gone) {
        this.scrollback.push(gone);
        if (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
      }
      this.grid.splice(this.bottom, 0, this.blankRow());
    }
  }

  private scrollDown(n: number): void {
    for (let k = 0; k < n; k++) {
      this.grid.splice(this.bottom, 1);
      this.grid.splice(this.top, 0, this.blankRow());
    }
  }

  /** Returns the index after the sequence, or -1 when it is incomplete. */
  private escape(s: string, i: number): number {
    if (i + 1 >= s.length) return -1;
    const k = s[i + 1]!;
    if (k === "[") {
      let j = i + 2;
      while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
      if (j >= s.length) return -1;
      this.csi(s.slice(i + 2, j), s[j]!);
      return j + 1;
    }
    if (k === "]" || k === "P" || k === "_" || k === "^" || k === "X") {
      // OSC / DCS / APC / PM / SOS: skip to BEL or ST.
      for (let j = i + 2; j < s.length; j++) {
        if (s[j] === "\x07") return j + 1;
        if (s[j] === "\x1b" && j + 1 < s.length && s[j + 1] === "\\") return j + 2;
        if (s[j] === "\x1b" && j + 1 >= s.length) return -1;
      }
      return -1;
    }
    if (k === "(" || k === ")" || k === "*" || k === "+" || k === "#" || k === "%" || k === " ") {
      return i + 3 <= s.length ? i + 3 : -1;
    }
    switch (k) {
      case "7":
        this.saved = { x: this.x, y: this.y, sgr: this.sgr, wrapNext: this.wrapNext };
        break;
      case "8":
        ({ x: this.x, y: this.y, sgr: this.sgr, wrapNext: this.wrapNext } = this.saved);
        break;
      case "D":
        this.lineFeed();
        break;
      case "E":
        this.x = 0;
        this.lineFeed();
        break;
      case "M":
        this.wrapNext = false;
        if (this.y === this.top) this.scrollDown(1);
        else if (this.y > 0) this.y--;
        break;
      case "c":
        this.grid = this.blankGrid();
        this.x = this.y = 0;
        this.sgr = "";
        this.wrapNext = false;
        break;
      default:
        break; // ESC H (tab set), ESC =, ESC > ...
    }
    return i + 2;
  }

  private csi(body: string, final: string): void {
    const priv = /^[?<=>!]/.test(body) ? body[0] : "";
    const params = (priv ? body.slice(1) : body).replace(/[ -/]+$/, "");
    if (/[ -/]$/.test(body)) return; // intermediate bytes: DECSCUSR etc.
    const nums = params.split(";").map((p) => parseInt(p, 10));
    const n = (idx: number, def = 1) => (Number.isFinite(nums[idx]) && nums[idx]! > 0 ? nums[idx]! : def);
    // Preserve pending line wrap across SGR (`m`) and DEC private mode toggles (`?2026h/l`, `?25l/h`).
    if (priv === "?") {
      if (final === "h" || final === "l") {
        for (const m of nums) if (m === 1049 || m === 1047 || m === 47) this.altScreen(final === "h");
      }
      return;
    }
    if (priv) return;
    switch (final) {
      case "m":
        this.applySgr(params);
        break;
      case "H":
      case "f":
        this.y = this.clampY(n(0) - 1);
        this.x = this.clampX(n(1) - 1);
        this.wrapNext = false;
        break;
      case "A":
        this.y = Math.max(this.top <= this.y ? this.top : 0, this.y - n(0));
        this.wrapNext = false;
        break;
      case "B":
      case "e":
        this.y = Math.min(this.bottom >= this.y ? this.bottom : this.rows - 1, this.y + n(0));
        this.wrapNext = false;
        break;
      case "C":
      case "a":
        this.x = this.clampX(this.x + n(0));
        this.wrapNext = false;
        break;
      case "D":
        this.x = this.clampX(this.x - n(0));
        this.wrapNext = false;
        break;
      case "E":
        this.y = this.clampY(this.y + n(0));
        this.x = 0;
        this.wrapNext = false;
        break;
      case "F":
        this.y = this.clampY(this.y - n(0));
        this.x = 0;
        this.wrapNext = false;
        break;
      case "G":
      case "`":
        this.x = this.clampX(n(0) - 1);
        this.wrapNext = false;
        break;
      case "d":
        this.y = this.clampY(n(0) - 1);
        this.wrapNext = false;
        break;
      case "J":
        this.eraseDisplay(Number.isFinite(nums[0]) ? nums[0]! : 0);
        this.wrapNext = false;
        break;
      case "K":
        this.eraseLine(Number.isFinite(nums[0]) ? nums[0]! : 0);
        this.wrapNext = false;
        break;
      case "X": {
        const row = this.grid[this.y]!;
        for (let x = this.x; x < Math.min(this.cols, this.x + n(0)); x++) row[x] = this.blankStyled();
        this.wrapNext = false;
        break;
      }
      case "P": {
        const row = this.grid[this.y]!;
        row.splice(this.x, n(0));
        while (row.length < this.cols) row.push(this.blankStyled());
        this.wrapNext = false;
        break;
      }
      case "@": {
        const row = this.grid[this.y]!;
        row.splice(this.x, 0, ...Array.from({ length: n(0) }, () => this.blankStyled()));
        row.length = this.cols;
        this.wrapNext = false;
        break;
      }
      case "L":
        if (this.y >= this.top && this.y <= this.bottom) {
          for (let k = 0; k < n(0); k++) {
            this.grid.splice(this.bottom, 1);
            this.grid.splice(this.y, 0, this.blankRow());
          }
        }
        this.wrapNext = false;
        break;
      case "M":
        if (this.y >= this.top && this.y <= this.bottom) {
          for (let k = 0; k < n(0); k++) {
            this.grid.splice(this.y, 1);
            this.grid.splice(this.bottom, 0, this.blankRow());
          }
        }
        this.wrapNext = false;
        break;
      case "S":
        this.scrollUp(n(0));
        this.wrapNext = false;
        break;
      case "T":
        this.scrollDown(n(0));
        this.wrapNext = false;
        break;
      case "r":
        this.top = this.clampY(n(0) - 1);
        this.bottom = this.clampY(n(1, this.rows) - 1);
        if (this.top >= this.bottom) {
          this.top = 0;
          this.bottom = this.rows - 1;
        }
        this.x = 0;
        this.y = 0;
        this.wrapNext = false;
        break;
      case "s":
        this.saved = { x: this.x, y: this.y, sgr: this.sgr, wrapNext: this.wrapNext };
        break;
      case "u":
        ({ x: this.x, y: this.y, wrapNext: this.wrapNext } = this.saved);
        break;
      default:
        break;
    }
  }

  private clampX(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, x));
  }

  private clampY(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, y));
  }

  /** Erased cells keep the current background, like a real terminal. */
  private blankStyled(): Cell {
    const bg = bgOnly(this.sgr);
    return bg ? { ch: " ", sgr: bg } : BLANK;
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.y]!;
    const [a, b] = mode === 1 ? [0, this.x + 1] : mode === 2 ? [0, this.cols] : [this.x, this.cols];
    for (let x = a; x < b; x++) row[x] = this.blankStyled();
  }

  private eraseDisplay(mode: number): void {
    if (mode === 3) {
      this.scrollback = [];
      return;
    }
    const fill = (y: number, a: number, b: number) => {
      for (let x = a; x < b; x++) this.grid[y]![x] = this.blankStyled();
    };
    if (mode === 0) {
      fill(this.y, this.x, this.cols);
      for (let y = this.y + 1; y < this.rows; y++) fill(y, 0, this.cols);
    } else if (mode === 1) {
      for (let y = 0; y < this.y; y++) fill(y, 0, this.cols);
      fill(this.y, 0, this.x + 1);
    } else {
      for (let y = 0; y < this.rows; y++) fill(y, 0, this.cols);
    }
  }

  private altScreen(on: boolean): void {
    if (on && !this.alt) {
      this.alt = this.grid;
      this.grid = this.blankGrid();
      this.wrapNext = false;
    } else if (!on && this.alt) {
      this.grid = this.alt;
      this.alt = null;
      this.wrapNext = false;
    }
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.grid = this.grid.slice(0, nextRows).map((r) => {
      const row = r.slice(0, nextCols);
      while (row.length < nextCols) row.push(BLANK);
      return row;
    });
    while (this.grid.length < nextRows) this.grid.push(this.blankRow());
    this.top = 0;
    this.bottom = nextRows - 1;
    this.x = this.clampX(this.x);
    this.y = this.clampY(this.y);
    this.wrapNext = false;
  }

  private applySgr(params: string): void {
    if (params === "" || params === "0") {
      this.sgr = "";
      return;
    }
    // Keep a compact, normalized list of active attributes.
    const parts = params.split(";");
    let state = parseSgr(this.sgr);
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i]!;
      // Colon sub-parameters (38:2::r:g:b, 4:3) -> semicolon form.
      if (raw.includes(":")) {
        const sub = raw.split(":");
        const head = parseInt(sub[0]!, 10);
        if (head === 4) state.underline = sub[1] !== "0";
        else if (head === 38 || head === 48) {
          let v = sub.slice(1);
          // 38:2:<colorspace>:r:g:b carries an extra (often empty) field.
          if (v[0] === "2" && v.length >= 5) v = [v[0], ...v.slice(v.length - 3)];
          state[head === 38 ? "fg" : "bg"] = color(v.map((x) => parseInt(x, 10) || 0));
        }
        continue;
      }
      const p = parseInt(raw, 10) || 0;
      if (p === 0) state = parseSgr("");
      else if (p === 1) state.bold = true;
      else if (p === 2) state.dim = true;
      else if (p === 3) state.italic = true;
      else if (p === 4) state.underline = true;
      else if (p === 7) state.inverse = true;
      else if (p === 9) state.strike = true;
      else if (p === 22) state.bold = state.dim = false;
      else if (p === 23) state.italic = false;
      else if (p === 24) state.underline = false;
      else if (p === 27) state.inverse = false;
      else if (p === 29) state.strike = false;
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) state.fg = String(p);
      else if (p === 39) state.fg = "";
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) state.bg = String(p);
      else if (p === 49) state.bg = "";
      else if (p === 38 || p === 48 || p === 58) {
        const mode = parseInt(parts[i + 1] ?? "", 10);
        const take = mode === 5 ? 2 : mode === 2 ? 4 : 1;
        const v = parts.slice(i + 1, i + 1 + take).map((x) => parseInt(x, 10));
        i += take;
        if (p !== 58) state[p === 38 ? "fg" : "bg"] = color(v);
      }
    }
    this.sgr = formatSgr(state);
  }

  /**
   * Visible text with SGR colors: scrollback then screen, trailing blank
   * cells and blank lines at the end trimmed. Lines end with "\n".
   */
  toAnsi(historyLines = 0): string {
    return this.ansiLines(historyLines).join("\n");
  }

  /** The lines of `toAnsi`, each with its own colors (none carries over to the next). */
  ansiLines(historyLines = 0): string[] {
    const rows = [...this.scrollback.slice(Math.max(0, this.scrollback.length - historyLines)), ...this.grid];
    while (rows.length && isBlank(rows[rows.length - 1]!)) rows.pop();
    return rows.map(rowToAnsi);
  }

  toText(historyLines = 0): string {
    const rows = [...this.scrollback.slice(Math.max(0, this.scrollback.length - historyLines)), ...this.grid];
    while (rows.length && isBlank(rows[rows.length - 1]!)) rows.pop();
    return rows.map((r) => r.map((c) => c.ch).join("").trimEnd()).join("\n");
  }
}

interface SgrState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
  fg: string;
  bg: string;
}

function color(v: number[]): string {
  if (v[0] === 5 && Number.isFinite(v[1])) return `5;${v[1]}`;
  if (v[0] === 2 && v.length >= 4) return `2;${v[1] ?? 0};${v[2] ?? 0};${v[3] ?? 0}`;
  return "";
}

function parseSgr(s: string): SgrState {
  const st: SgrState = { bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false, fg: "", bg: "" };
  if (!s) return st;
  for (const part of s.split("|")) {
    if (part === "1") st.bold = true;
    else if (part === "2") st.dim = true;
    else if (part === "3") st.italic = true;
    else if (part === "4") st.underline = true;
    else if (part === "7") st.inverse = true;
    else if (part === "9") st.strike = true;
    else if (part.startsWith("f")) st.fg = part.slice(1);
    else if (part.startsWith("b")) st.bg = part.slice(1);
  }
  return st;
}

/** Internal form: "|"-joined tokens, so cells can be compared as strings. */
function formatSgr(st: SgrState): string {
  const out: string[] = [];
  if (st.bold) out.push("1");
  if (st.dim) out.push("2");
  if (st.italic) out.push("3");
  if (st.underline) out.push("4");
  if (st.inverse) out.push("7");
  if (st.strike) out.push("9");
  if (st.fg) out.push(`f${st.fg}`);
  if (st.bg) out.push(`b${st.bg}`);
  return out.join("|");
}

function bgOnly(sgr: string): string {
  const b = sgr.split("|").find((p) => p.startsWith("b"));
  return b ?? "";
}

function toEscape(sgr: string): string {
  if (!sgr) return "\x1b[0m";
  const codes = sgr.split("|").map((p) => {
    if (p.startsWith("f")) {
      const v = p.slice(1);
      return v.includes(";") ? `38;${v}` : v;
    }
    if (p.startsWith("b")) {
      const v = p.slice(1);
      return v.includes(";") ? `48;${v}` : v;
    }
    return p;
  });
  return `\x1b[0;${codes.join(";")}m`;
}

function isBlank(row: Cell[]): boolean {
  return row.every((c) => (c.ch === " " || c.ch === "") && !bgOnly(c.sgr));
}

function rowToAnsi(row: Cell[]): string {
  // Trim trailing cells that are blank and have no background.
  let end = row.length;
  while (end > 0 && (row[end - 1]!.ch === " " || row[end - 1]!.ch === "") && !bgOnly(row[end - 1]!.sgr)) end--;
  let out = "";
  let cur = "";
  for (let x = 0; x < end; x++) {
    const c = row[x]!;
    if (c.ch === "") continue; // right half of a wide character
    if (c.sgr !== cur) {
      out += toEscape(c.sgr);
      cur = c.sgr;
    }
    out += c.ch;
  }
  if (cur) out += "\x1b[0m";
  return out;
}

/** Keeps text and SGR color sequences; drops every other escape and control. */
export function sgrOnly(s: string): string {
  return s
    .replace(/\x1b\[[0-9;:]*m/g, (m) => `\u0000${m.slice(1)}`)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g, "")
    .replace(/[\x01-\x08\x0b-\x1f\x7f]/g, (c) => (c === "\r" ? "" : c === "\t" ? "\t" : ""))
    .replace(/\u0000/g, "\x1b");
}
