import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Columns2, Compass, Keyboard, Layers, PanelLeft, Search, X } from "lucide-react";
import { PocketButton, PocketModal, PocketSwitch } from "../components/PocketUI";
import { settingsStore, updateSettings } from "../lib/store";
import {
  IS_MAC,
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  comboText,
  formatEventKeyTokens,
  keyChips,
  type ShortcutCategory,
} from "./shortcuts";

const CATEGORY_ICON: Record<ShortcutCategory, typeof Compass> = {
  general: Compass,
  space: Layers,
  tab: Keyboard,
  split: Columns2,
  panel: PanelLeft,
  agent: Bot,
};

export function ShortcutHelpModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const showHoldHints = settingsStore.use((s) => s.showModifierHoldHints);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | ShortcutCategory>("all");
  const [capturing, setCapturing] = useState(false);
  const [capturedTokens, setCapturedTokens] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setCapturing(false);
      setCapturedTokens([]);
      return;
    }
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open || !capturing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setCapturing(false);
        return;
      }
      const tokens = formatEventKeyTokens(e);
      if (tokens.length > 0) {
        setCapturedTokens(tokens);
        const last = tokens[tokens.length - 1];
        if (last && !["Mod", "Alt", "Shift", "Ctrl", "Meta"].includes(last)) {
          setCapturing(false);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const capSet = capturedTokens.length > 0 ? new Set(capturedTokens.map((t) => t.toLowerCase())) : null;
    return SHORTCUTS.filter((s) => {
      if (category !== "all" && s.category !== category) return false;
      if (capSet) {
        const combos = [s.keys, ...(s.alt ?? [])];
        const hitCombo = combos.some((combo) => {
          const tokens = new Set(combo.map((t) => t.toLowerCase()));
          for (const req of capSet) {
            if (!tokens.has(req)) return false;
          }
          return true;
        });
        if (!hitCombo) return false;
      }
      if (!q) return true;
      const hay = `${s.label} ${s.when ?? ""} ${comboText(s.keys)} ${s.keys.join(" ")} ${(s.alt ?? [])
        .map((c) => `${comboText(c)} ${c.join(" ")}`)
        .join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [capturedTokens, category, query]);

  const sections = useMemo(() => {
    return SHORTCUT_CATEGORIES.map((cat) => ({
      ...cat,
      Icon: CATEGORY_ICON[cat.id],
      items: filtered.filter((s) => s.category === cat.id),
    })).filter((g) => g.items.length > 0);
  }, [filtered]);

  return (
    <PocketModal
      open={open}
      onOpenChange={onOpenChange}
      title="快捷键指南"
      subtitle={`按住 ${IS_MAC ? "⌘" : "Ctrl"} 不放可直接预览界面按键角标；${IS_MAC ? "⌘/" : "Ctrl+/"} 打开或关闭此面板`}
      width={680}
    >
      <div className="v3-help-body">
        <div className="v3-help-toolbar">
          <div className="v3-help-search">
            <Search size={14} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索操作名、分类或按键（例如：分屏、空间、E）"
              aria-label="搜索快捷键"
            />
            {query ? (
              <button
                type="button"
                className="v3-icon-btn small"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
          <PocketButton
            size="sm"
            variant={capturing || capturedTokens.length > 0 ? "primary" : "ghost"}
            onClick={() => {
              if (capturedTokens.length > 0 && !capturing) {
                setCapturedTokens([]);
              } else {
                setCapturing((v) => !v);
              }
            }}
          >
            <Keyboard size={13} />
            <span>
              {capturing
                ? "请按下组合键…"
                : capturedTokens.length > 0
                  ? `已筛 ${comboText(capturedTokens)} ×`
                  : "按键筛选"}
            </span>
          </PocketButton>
        </div>

        <div className="v3-help-cats" role="tablist" aria-label="快捷键分类">
          <button
            type="button"
            role="tab"
            aria-selected={category === "all"}
            className={`v3-help-cat${category === "all" ? " on" : ""}`}
            onClick={() => setCategory("all")}
          >
            全部（{SHORTCUTS.length}）
          </button>
          {SHORTCUT_CATEGORIES.map((c) => {
            const Icon = CATEGORY_ICON[c.id];
            return (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={category === c.id}
                className={`v3-help-cat${category === c.id ? " on" : ""}`}
                onClick={() => setCategory(c.id)}
              >
                <Icon size={12} />
                <span>{c.label}</span>
              </button>
            );
          })}
        </div>

        <div className="v3-help-scroll">
          {sections.length === 0 ? (
            <div className="v3-help-empty">没有匹配的快捷键</div>
          ) : (
            sections.map((sec) => {
              const Icon = sec.Icon;
              return (
                <section key={sec.id} className="v3-help-sec">
                  <header className="v3-help-sec-head">
                    <Icon size={13} />
                    <span>{sec.label}</span>
                  </header>
                  <div className="v3-help-grid">
                    {sec.items.map((item) => (
                      <div key={item.id} className="v3-help-card">
                        <div className="v3-help-card-text">
                          <span className="v3-help-card-label">{item.label}</span>
                          {item.when ? <span className="v3-help-card-when">{item.when}</span> : null}
                        </div>
                        <span className="sf-combo">
                          <span className="sf-keys">
                            {keyChips(item.keys).map((k, idx) => (
                              <kbd key={idx} className="sf-kbd">
                                {k}
                              </kbd>
                            ))}
                          </span>
                          {item.alt?.map((altCombo, idx) => (
                            <span key={idx} className="sf-combo">
                              <span className="faint">/</span>
                              <span className="sf-keys">
                                {keyChips(altCombo).map((k, kIdx) => (
                                  <kbd key={kIdx} className="sf-kbd">
                                    {k}
                                  </kbd>
                                ))}
                              </span>
                            </span>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>

        <div className="v3-help-foot">
          <span className="v3-help-foot-note">按住 {IS_MAC ? "⌘" : "Ctrl"} 显示页签编号与操作角标</span>
          <PocketSwitch
            checked={showHoldHints}
            onCheckedChange={(v) => updateSettings({ showModifierHoldHints: v })}
            label="按住修饰键显示提示角标"
          />
        </div>
      </div>
    </PocketModal>
  );
}
