import { detectPlatform } from "../lib/bridge";

/**
 * Window shortcuts of the desktop shell. One table drives the key handler,
 * command palette key chips, hold-⌘ spatial hints, ⌘/ help modal, and Settings → 键盘.
 */
export const IS_MAC = detectPlatform() === "macos";

export type ShortcutCategory = "general" | "space" | "tab" | "split" | "panel" | "agent";

export const SHORTCUT_CATEGORIES: Array<{ id: ShortcutCategory; label: string }> = [
  { id: "general", label: "全局与导航" },
  { id: "space", label: "空间" },
  { id: "tab", label: "标签页" },
  { id: "split", label: "分屏" },
  { id: "panel", label: "面板" },
  { id: "agent", label: "Agent 与对话" },
];

export type ShortcutId =
  | "shortcutHelp"
  | "palette"
  | "jumpAgent"
  | "jumpUrgent"
  | "settings"
  | "toggleTheme"
  | "newSpace"
  | "prevSpace"
  | "nextSpace"
  | "allSpaces"
  | "newAgent"
  | "newAgentDialog"
  | "closeTab"
  | "closeWholeTab"
  | "nextTab"
  | "prevTab"
  | "jumpTabRange"
  | "jumpLastTab"
  | "splitRight"
  | "splitDown"
  | "zoomPane"
  | "equalizeSplits"
  | "unsplitTab"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown"
  | "swapPaneLeft"
  | "swapPaneRight"
  | "swapPaneUp"
  | "swapPaneDown"
  | "toggleSidebar"
  | "togglePanel"
  | "toggleGit"
  | "toggleBrowser"
  | "assistant"
  | "togglePaneMode"
  | "terminalSearch"
  | "focusComposer"
  | "openModelPicker"
  | "openThinkingPicker"
  | "openUsageCard"
  | "interruptAgent";

export interface Shortcut {
  id: ShortcutId;
  category: ShortcutCategory;
  label: string;
  /** Optional contextual condition displayed as subtle note in help cards. */
  when?: string;
  /** Help-only entry (handled dynamically via range matching such as Mod+1..9). */
  helpOnly?: boolean;
  /** "Mod" = ⌘ on macOS, Ctrl elsewhere. The last entry is the key itself. */
  keys: string[];
  /** Other combos that do the same (shown after "或"). */
  alt?: string[][];
}

export const SHORTCUTS: Shortcut[] = [
  // 全局与导航
  { id: "palette", category: "general", label: "命令面板", keys: ["Mod", "P"], alt: [["Mod", "K"]] },
  { id: "shortcutHelp", category: "general", label: "快捷键速查与帮助", keys: ["Mod", "/"] },
  { id: "jumpAgent", category: "general", label: "快速跳转到 Agent 或标签", keys: ["Mod", "O"] },
  { id: "jumpUrgent", category: "general", label: "跳转到下一个需要你的 Agent", keys: ["Mod", "Shift", "U"] },
  { id: "settings", category: "general", label: "打开设置", keys: ["Mod", ","] },
  { id: "toggleTheme", category: "general", label: "切换浅色 / 暗色主题", keys: ["Mod", "Shift", "L"] },

  // 空间
  { id: "newSpace", category: "space", label: "新建工作空间", keys: ["Mod", "Shift", "N"] },
  { id: "prevSpace", category: "space", label: "切换到上一个空间", keys: ["Mod", "Alt", "["] },
  { id: "nextSpace", category: "space", label: "切换到下一个空间", keys: ["Mod", "Alt", "]"] },
  { id: "allSpaces", category: "space", label: "显示全部空间", keys: ["Mod", "Alt", "0"] },

  // 标签页
  { id: "newAgent", category: "tab", label: "新建终端标签", keys: ["Mod", "T"] },
  { id: "newAgentDialog", category: "tab", label: "新建 Agent 对话框", keys: ["Mod", "N"] },
  { id: "closeTab", category: "tab", label: "关闭当前分屏或标签", when: "优先关当前分屏", keys: ["Mod", "W"] },
  {
    id: "closeWholeTab",
    category: "tab",
    label: "关闭整个标签页",
    keys: ["Mod", "Shift", "W"],
    alt: IS_MAC ? undefined : [["Mod", "Shift", "X"]],
  },
  { id: "nextTab", category: "tab", label: "下一个标签", keys: ["Mod", "Shift", "]"] },
  { id: "prevTab", category: "tab", label: "上一个标签", keys: ["Mod", "Shift", "["] },
  { id: "jumpTabRange", category: "tab", label: "切换到第 1–8 个标签", helpOnly: true, keys: ["Mod", "1..8"] },
  { id: "jumpLastTab", category: "tab", label: "切换到最后一个标签", helpOnly: true, keys: ["Mod", "9"] },

  // 分屏
  { id: "splitRight", category: "split", label: "向右分屏新建终端", keys: IS_MAC ? ["Mod", "D"] : ["Mod", "Shift", "O"] },
  {
    id: "splitDown",
    category: "split",
    label: "向下分屏新建终端",
    keys: ["Mod", "Shift", "D"],
    alt: IS_MAC ? undefined : [["Mod", "Shift", "E"]],
  },
  {
    id: "zoomPane",
    category: "split",
    label: "最大化 / 还原当前分屏",
    keys: ["Mod", "Shift", "Enter"],
    alt: IS_MAC ? undefined : [["Mod", "Shift", "Z"]],
  },
  { id: "equalizeSplits", category: "split", label: "均分当前标签的分屏尺寸", keys: ["Mod", "Alt", "="] },
  { id: "unsplitTab", category: "split", label: "把当前分屏全部拆成独立标签", keys: ["Mod", "Alt", "Shift", "W"] },
  { id: "focusPaneLeft", category: "split", label: "焦点移到左侧分屏", keys: ["Mod", "Alt", "ArrowLeft"] },
  { id: "focusPaneRight", category: "split", label: "焦点移到右侧分屏", keys: ["Mod", "Alt", "ArrowRight"] },
  { id: "focusPaneUp", category: "split", label: "焦点移到上方分屏", keys: ["Mod", "Alt", "ArrowUp"] },
  { id: "focusPaneDown", category: "split", label: "焦点移到下方分屏", keys: ["Mod", "Alt", "ArrowDown"] },
  { id: "swapPaneLeft", category: "split", label: "与左侧分屏交换位置", keys: ["Mod", "Alt", "Shift", "ArrowLeft"] },
  { id: "swapPaneRight", category: "split", label: "与右侧分屏交换位置", keys: ["Mod", "Alt", "Shift", "ArrowRight"] },
  { id: "swapPaneUp", category: "split", label: "与上方分屏交换位置", keys: ["Mod", "Alt", "Shift", "ArrowUp"] },
  { id: "swapPaneDown", category: "split", label: "与下方分屏交换位置", keys: ["Mod", "Alt", "Shift", "ArrowDown"] },

  // 面板
  { id: "toggleSidebar", category: "panel", label: "显示或隐藏侧栏", keys: ["Mod", "B"] },
  { id: "togglePanel", category: "panel", label: "显示或隐藏文件面板", keys: ["Mod", "J"] },
  { id: "toggleGit", category: "panel", label: "显示或隐藏 Git 管理", keys: ["Mod", "Shift", "G"] },
  { id: "toggleBrowser", category: "panel", label: "显示或隐藏内置浏览器", keys: ["Mod", "Alt", "B"] },
  { id: "assistant", category: "panel", label: "打开小羊", keys: ["Mod", "Shift", "A"] },

  // Agent 与对话
  { id: "togglePaneMode", category: "agent", label: "切换对话 / 终端视图", when: "Agent 分屏", keys: ["Mod", "E"] },
  {
    id: "terminalSearch",
    category: "agent",
    label: "在终端输出中搜索",
    when: "终端模式",
    keys: IS_MAC ? ["Mod", "F"] : ["Mod", "Shift", "F"],
  },
  { id: "focusComposer", category: "agent", label: "聚焦对话输入框", when: "对话模式", keys: ["Mod", "L"] },
  { id: "openModelPicker", category: "agent", label: "切换模型", when: "对话模式", keys: ["Mod", "Alt", "M"] },
  { id: "openThinkingPicker", category: "agent", label: "调整思考强度", when: "对话模式", keys: ["Mod", "Alt", "T"] },
  { id: "openUsageCard", category: "agent", label: "查看会话用量统计", when: "对话模式", keys: ["Mod", "Alt", "U"] },
  { id: "interruptAgent", category: "agent", label: "中断当前 Agent 回复", when: "运行中", keys: ["Mod", "."] },
];

const MAC_GLYPH: Record<string, string> = {
  Mod: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Ctrl: "⌃",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
};

const OTHER_GLYPH: Record<string, string> = {
  Mod: "Ctrl",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "Enter",
};

/** Key chips for one combo, in the platform's spelling: ["⌘", "P"] or ["Ctrl", "P"]. */
export function keyChips(keys: string[]): string[] {
  return keys.map((k) => (IS_MAC ? (MAC_GLYPH[k] ?? k) : (OTHER_GLYPH[k] ?? k)));
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

/** Formats a single keyboard event into display chips matching shortcut tables (used by key-capture filters). */
export function formatEventKeyTokens(e: KeyboardEvent): string[] {
  const out: string[] = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) out.push("Mod");
  if (IS_MAC && e.ctrlKey) out.push("Ctrl");
  if (!IS_MAC && e.metaKey) out.push("Meta");
  if (e.altKey) out.push("Alt");
  if (e.shiftKey) out.push("Shift");
  const k = e.key;
  if (!["Meta", "Control", "Alt", "Shift"].includes(k)) {
    if (e.code === "BracketLeft") out.push("[");
    else if (e.code === "BracketRight") out.push("]");
    else if (e.code === "Slash") out.push("/");
    else if (e.code === "Comma") out.push(",");
    else if (e.code === "Period") out.push(".");
    else if (e.code === "Equal") out.push("=");
    else if (k === " ") out.push("Space");
    else out.push(k.length === 1 ? k.toUpperCase() : k);
  }
  return out;
}

/** Whether a keydown matches one combo of the table. */
export function matchesCombo(e: KeyboardEvent, keys: string[]): boolean {
  const key = keys[keys.length - 1]!;
  const wantShift = keys.includes("Shift");
  const wantAlt = keys.includes("Alt");
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey !== wantAlt || e.shiftKey !== wantShift) return false;
  // Shift+[ arrives as "{" on most layouts; compare physical code for punctuation too.
  if (key === "[" || key === "]") return e.code === (key === "[" ? "BracketLeft" : "BracketRight");
  if (key === ",") return e.key === "," || e.code === "Comma";
  if (key === ".") return e.key === "." || e.code === "Period";
  if (key === "/") return e.key === "/" || e.code === "Slash";
  if (key === "=") return e.key === "=" || e.code === "Equal";
  if (key === "0") return e.key === "0" || e.code === "Digit0";
  if (key === "Enter") return e.key === "Enter";
  if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
    return e.key === key;
  }
  return e.key.toLowerCase() === key.toLowerCase();
}

export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  for (const s of SHORTCUTS) {
    if (s.helpOnly) continue;
    if (matchesCombo(e, s.keys) || s.alt?.some((k) => matchesCombo(e, k))) return s.id;
  }
  return null;
}
