import { useMemo } from "react";
import { keyChips, nextModifierSteps, shortcutsForChord, shortcutText, type ShortcutModifierChord } from "./shortcuts";
import { useActiveModifierChord } from "./useModifierHoldHints";

const SHORT_LABELS: Record<string, string> = {
  palette: "命令面板",
  shortcutHelp: "快捷键",
  jumpAgent: "跳 Agent",
  jumpUrgent: "跳待办",
  settings: "设置",
  toggleTheme: "切主题",
  newSpace: "新空间",
  prevSpace: "上一空间",
  nextSpace: "下一空间",
  allSpaces: "全部空间",
  newAgent: "新终端",
  newAgentDialog: "新对话",
  closeTab: "关分屏/页",
  closeWholeTab: "关整页",
  nextTab: "下一标签",
  prevTab: "上一标签",
  splitRight: "向右分屏",
  splitDown: "向下分屏",
  zoomPane: "最大化",
  equalizeSplits: "均分分屏",
  unsplitTab: "拆成独立页",
  focusPaneLeft: "左分屏",
  focusPaneRight: "右分屏",
  focusPaneUp: "上分屏",
  focusPaneDown: "下分屏",
  swapPaneLeft: "左交换",
  swapPaneRight: "右交换",
  swapPaneUp: "上交换",
  swapPaneDown: "下交换",
  toggleSidebar: "侧栏",
  togglePanel: "文件面板",
  toggleGit: "Git",
  toggleBrowser: "浏览器",
  assistant: "小羊",
  togglePaneMode: "对话/终端",
  terminalSearch: "终端搜索",
  focusComposer: "输入框",
  openModelPicker: "切模型",
  openThinkingPicker: "思考强度",
  openUsageCard: "用量统计",
  interruptAgent: "中断回复",
};

const PRIORITY_BY_CHORD: Record<ShortcutModifierChord, string[]> = {
  Mod: ["splitRight", "newAgent", "closeTab", "toggleSidebar", "togglePanel", "palette", "shortcutHelp"],
  "Mod+Shift": ["splitDown", "zoomPane", "closeWholeTab", "nextTab", "jumpUrgent", "toggleGit", "assistant"],
  "Mod+Alt": ["focusPaneLeft", "focusPaneRight", "equalizeSplits", "prevSpace", "nextSpace", "openModelPicker", "toggleBrowser"],
  "Mod+Alt+Shift": ["swapPaneLeft", "swapPaneRight", "swapPaneUp", "swapPaneDown", "unsplitTab"],
};

const STEP_SUMMARY: Record<ShortcutModifierChord, string> = {
  Mod: "基础导航",
  "Mod+Shift": "分屏/标签进阶",
  "Mod+Alt": "焦点/空间/模型",
  "Mod+Alt+Shift": "交换/拆分分屏",
};

/**
 * Floating bottom chord guide bar shown while holding ⌘ / Ctrl and stepping into
 * second modifiers (⇧ / ⌥ / ⌥⇧), always pointer-events: none.
 */
export function ModifierChordHud() {
  const chord = useActiveModifierChord();

  const model = useMemo(() => {
    if (!chord) return null;
    const modChips = keyChips(chord.split("+"));
    const entries = shortcutsForChord(chord);
    const byId = new Map(entries.map((entry) => [entry.shortcut.id, entry] as const));
    const ordered: typeof entries = [];
    for (const id of PRIORITY_BY_CHORD[chord]) {
      const hit = byId.get(id as any);
      if (hit) {
        ordered.push(hit);
        byId.delete(id as any);
      }
    }
    for (const rest of byId.values()) {
      if (!rest.shortcut.helpOnly) ordered.push(rest);
    }
    const items = ordered.slice(0, 7).map((item) => ({
      id: item.shortcut.id,
      key: item.actionChip,
      label: SHORT_LABELS[item.shortcut.id] ?? item.shortcut.label,
    }));
    const steps = nextModifierSteps(chord).map((s) => ({
      ...s,
      hint: STEP_SUMMARY[s.targetChord],
    }));
    return { modChips, items, steps, helpKey: shortcutText("shortcutHelp") };
  }, [chord]);

  if (!chord || !model) return null;

  return (
    <div className="v3-chord-hud" data-chord={chord} role="status" aria-live="off">
      <div className="v3-chord-mods" aria-label="当前按住的修饰键">
        {model.modChips.map((chip) => (
          <kbd key={chip} className="v3-chord-cap is-held">
            {chip}
          </kbd>
        ))}
      </div>
      <div className="v3-chord-items">
        {model.items.map((item) => (
          <span key={item.id} className="v3-chord-item">
            <kbd className="v3-chord-key">{item.key}</kbd>
            <span>{item.label}</span>
          </span>
        ))}
      </div>
      {model.steps.length > 0 ? (
        <div className="v3-chord-next">
          {model.steps.map((step) => (
            <span key={step.targetChord} className="v3-chord-step">
              <span>+</span>
              <kbd className="v3-chord-cap is-next">{step.addChip}</kbd>
              <span className="v3-chord-step-label">{step.hint}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="v3-chord-next">
          <span className="v3-chord-step">
            <span className="v3-chord-step-label">{model.helpKey} 完整列表</span>
          </span>
        </div>
      )}
    </div>
  );
}
