/**
 * Mobile touch terminal pad key model, mirrored from apps/mobile/src/lib/termpad.ts.
 */

export const PAD_SEQ = {
  enter: "\r",
  backspace: "\x7f",
  tab: "\t",
  esc: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
} as const;

export type PadSpecial = keyof typeof PAD_SEQ;

const CSI_LETTER: Partial<Record<PadSpecial, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

export function padSpecial(key: PadSpecial, mods: { ctrl?: boolean; shift?: boolean }): string {
  if (key === "tab" && mods.shift) return "\x1b[Z";
  if (key === "enter" && mods.shift) return "\x1b[27;2;13~";
  const letter = CSI_LETTER[key];
  if (letter && (mods.ctrl || mods.shift)) {
    return `\x1b[1;${mods.ctrl ? 5 : 2}${letter}`;
  }
  return PAD_SEQ[key];
}

export function padChar(ch: string, mods: { ctrl?: boolean; shift?: boolean }): string {
  const c = mods.shift ? ch.toUpperCase() : ch;
  if (!mods.ctrl) return c;
  if (c === " " || c === "@") return "\x00";
  if (c === "?") return "\x7f";
  const code = c.toUpperCase().charCodeAt(0);
  if (c.length === 1 && code >= 0x40 && code <= 0x5f) {
    return String.fromCharCode(code & 0x1f);
  }
  return c;
}

export type PadKey =
  | { kind: "char"; ch: string; w?: number }
  | { kind: "special"; key: PadSpecial; label: string; a11y: string; w?: number; repeat?: boolean }
  | { kind: "shift"; w?: number }
  | { kind: "ctrl"; w?: number }
  | { kind: "page"; w?: number };

const chars = (s: string): PadKey[] => Array.from(s).map((ch) => ({ kind: "char", ch }));
const sp = (
  key: PadSpecial,
  label: string,
  a11y: string,
  extra: Partial<Extract<PadKey, { kind: "special" }>> = {},
): PadKey => ({ kind: "special", key, label, a11y, ...extra });

const BACKSPACE = sp("backspace", "退格", "退格", { repeat: true, w: 1.5 });
const BOTTOM: PadKey[] = [
  { kind: "ctrl", w: 1.3 },
  { kind: "page", w: 1.3 },
  sp("tab", "Tab", "Tab，补全", { w: 1.2 }),
  { kind: "char", ch: " ", w: 2.8 },
  { kind: "char", ch: "." },
  { kind: "char", ch: "/" },
  sp("enter", "回车", "回车", { w: 1.4 }),
];

export const PAD_PAGES: { letters: PadKey[][]; symbols: PadKey[][] } = {
  letters: [
    chars("1234567890"),
    chars("qwertyuiop"),
    chars("asdfghjkl-"),
    [{ kind: "shift", w: 1.5 }, ...chars("zxcvbnm"), BACKSPACE],
    BOTTOM,
  ],
  symbols: [
    chars("!@#$%^&*()"),
    chars("~`|\\=+_\"';"),
    chars("[]{}<>:,?-"),
    [
      sp("esc", "Esc", "Esc", { w: 1.5 }),
      sp("left", "←", "向左", { repeat: true }),
      sp("up", "↑", "向上", { repeat: true }),
      sp("down", "↓", "向下", { repeat: true }),
      sp("right", "→", "向右", { repeat: true }),
      sp("home", "Home", "行首", { w: 1.25 }),
      sp("end", "End", "行尾", { w: 1.25 }),
      BACKSPACE,
    ],
    BOTTOM,
  ],
};

export const PAD_SNIPPETS = ["继续", "/compact", "ls", "cd ..", "git status", "git diff", "clear", "exit"];
