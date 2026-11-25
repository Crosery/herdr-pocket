const LOCAL_ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO[\s\S]?|\x1b[\s\S]?/g;
const XTERM_OMZ_PROMPT_RE =
  /^.*?➜\s+(?:\S+\s+git:\([^)]+\)(?:\s+[✗×*!+])?\s+|(?:~(?:\/[^\s]*)?|\/[^\s]+|\.\.?)\s+)/u;
const XTERM_PROMPT_GLYPH_RE = /^.*?(?:→|❯|➜|λ)\s+/u;
const XTERM_STD_PROMPT_RE = /^(?:\([^)]+\)\s+)?(?:[^$%#>\r\n]{0,64}[$%#>]\s+)/;

/** Tracks typed local keystrokes into trimmed command lines on CR/LF submission. */
export function feedLocalCommandLineBuffer(bufRef: { current: string }, raw: string): string[] {
  const cleaned = raw.replace(LOCAL_ANSI_RE, "");
  const out: string[] = [];
  let chars = Array.from(bufRef.current);
  for (const ch of cleaned) {
    if (ch === "\r" || ch === "\n") {
      const line = chars.join("").trim();
      chars = [];
      if (line) out.push(line);
      continue;
    }
    if (ch === "\x03" || ch === "\x15") {
      chars = [];
      continue;
    }
    if (ch === "\x7f" || ch === "\x08") {
      chars.pop();
      continue;
    }
    if (ch === "\x17") {
      while (chars.length && chars[chars.length - 1] === " ") chars.pop();
      while (chars.length && chars[chars.length - 1] !== " ") chars.pop();
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09) {
      if (chars.length < 4096) chars.push(" ");
      continue;
    }
    if (code < 0x20) continue;
    if (chars.length < 4096) chars.push(ch);
  }
  bufRef.current = chars.slice(-4096).join("");
  return out;
}

export interface XtermCommandBufferLike {
  buffer?: {
    active?: {
      baseY: number;
      cursorY: number;
      length: number;
      getLine: (y: number) => { isWrapped?: boolean; translateToString: (trimRight?: boolean) => string } | undefined;
    };
  };
}

/** Reconstructs the logical prompt command line currently under the xterm cursor (handling wrapped rows and Starship/OMZ prompts). */
export function extractPromptCommandFromXterm(term: XtermCommandBufferLike | null): string {
  try {
    const buf = term?.buffer?.active;
    if (!buf) return "";
    const curRow = (buf.baseY ?? 0) + (buf.cursorY ?? 0);
    if (curRow < 0 || curRow >= buf.length) return "";
    let startRow = curRow;
    let guard = 0;
    while (startRow > 0 && guard < 12) {
      const line = buf.getLine(startRow);
      if (!line?.isWrapped) break;
      startRow -= 1;
      guard += 1;
    }
    const parts: string[] = [];
    for (let r = startRow; r < Math.min(buf.length, startRow + 12); r += 1) {
      const line = buf.getLine(r);
      if (!line) break;
      if (r > startRow && !line.isWrapped && r > curRow) break;
      parts.push(line.translateToString(true));
      if (r >= curRow && !buf.getLine(r + 1)?.isWrapped) break;
    }
    const raw = parts.join("").replace(LOCAL_ANSI_RE, "").trimEnd();
    if (!raw.trim()) return "";
    const glyphMatch = XTERM_OMZ_PROMPT_RE.exec(raw) ?? XTERM_PROMPT_GLYPH_RE.exec(raw);
    const stripped = glyphMatch ? raw.slice(glyphMatch[0].length) : raw.replace(XTERM_STD_PROMPT_RE, "");
    const cmd = stripped.trim();
    return cmd && !/^(?:→|❯|➜|λ|[$%#>])$/u.test(cmd) ? cmd : "";
  } catch {
    return "";
  }
}
