import { detectPlatform } from "../lib/bridge";

/**
 * Window shortcuts of the desktop shell. One table drives the key handler (shell/useShellKeys),
 * the palette's key chips and Settings → 键盘. Keys are written for macOS; on Windows and
 * Linux "Mod" is Ctrl and the chips say Ctrl.
 */
export const IS_MAC = detectPlatform() === "macos";

export type ShortcutId =
  | "palette"
  | "settings"
  | "newAgent"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "toggleSidebar"
  | "togglePanel"
  | "assistant";

export interface Shortcut {
  id: ShortcutId;
  label: string;
  /** "Mod" = ⌘ on macOS, Ctrl elsewhere. The last entry is the key itself. */
  keys: string[];
  /** Other combos that do the same (shown after "或"). */
  alt?: string[][];
}

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", label: "命令面板", keys: ["Mod", "P"], alt: [["Mod", "K"]] },
  { id: "settings", label: "设置", keys: ["Mod", ","] },
  { id: "newAgent", label: "新建 Agent", keys: ["Mod", "T"] },
  { id: "closeTab", label: "关闭标签", keys: ["Mod", "W"] },
  { id: "nextTab", label: "下一个标签", keys: ["Mod", "Shift", "]"] },
  { id: "prevTab", label: "上一个标签", keys: ["Mod", "Shift", "["] },
  { id: "toggleSidebar", label: "显示或隐藏侧栏", keys: ["Mod", "B"] },
  { id: "togglePanel", label: "显示或隐藏文件面板", keys: ["Mod", "J"] },
  { id: "assistant", label: "打开小羊", keys: ["Mod", "Shift", "A"] },
];

const MAC_GLYPH: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" };

/** Key chips for one combo, in the platform's spelling: ["⌘", "P"] or ["Ctrl", "P"]. */
export function keyChips(keys: string[]): string[] {
  return keys.map((k) => (IS_MAC ? (MAC_GLYPH[k] ?? k) : k === "Mod" ? "Ctrl" : k));
}

/** One combo as text: "⌘P" on macOS, "Ctrl+P" elsewhere. */
export function comboText(keys: string[]): string {
  const chips = keyChips(keys);
  return IS_MAC ? chips.join("") : chips.join("+");
}

export function shortcutText(id: ShortcutId): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? comboText(s.keys) : "";
}

/** Whether a keydown matches one combo of the table. */
export function matchesCombo(e: KeyboardEvent, keys: string[]): boolean {
  const key = keys[keys.length - 1]!;
  const wantShift = keys.includes("Shift");
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey || e.shiftKey !== wantShift) return false;
  // Shift+[ arrives as "{" on most layouts; compare the physical key for brackets.
  if (key === "[" || key === "]") return e.code === (key === "[" ? "BracketLeft" : "BracketRight");
  if (key === ",") return e.key === "," || e.code === "Comma";
  return e.key.toLowerCase() === key.toLowerCase();
}

export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  for (const s of SHORTCUTS) {
    if (matchesCombo(e, s.keys) || s.alt?.some((k) => matchesCombo(e, k))) return s.id;
  }
  return null;
}
