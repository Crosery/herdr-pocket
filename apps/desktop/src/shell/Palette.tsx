import { useEffect, useMemo, useState, type ComponentType } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command, Search } from "lucide-react";
import { overlayStore } from "../components/PocketUI";
import { usePaletteNav } from "../lib/usePaletteNav";
import { keyChips } from "./shortcuts";

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  /** Muted text after the label (computer, path). */
  hint?: string;
  /** Shortcut chips, in the table's spelling (["Mod", "P"]). */
  keys?: string[];
  icon?: ComponentType<{ size?: number }>;
  /** Extra words the query matches (pinyin-free aliases, English names). */
  terms?: string;
  run: () => void;
}

const RECENT_KEY = "herdr-pocket-palette-recent";
const RECENT_MAX = 4;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    // Storage off: no recent list.
  }
}

/**
 * Herdr-style command palette: a box near the top centre, the input with a ⌘ mark and an
 * Esc chip, grouped rows with key chips. Arrows move, Enter runs, Esc closes (R31).
 */
export function Palette({
  mode,
  onClose,
  items,
}: {
  mode: false | "command" | "jump";
  onClose: () => void;
  items: PaletteItem[];
}) {
  const open = mode !== false;
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(readRecent);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRecent(readRecent());
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = mode === "jump" ? items.filter((i) => i.group === "标签" || i.group === "Agent") : items;
    if (q) {
      return pool
        .filter((i) => `${i.label} ${i.hint ?? ""} ${i.terms ?? ""}`.toLowerCase().includes(q))
        .map((i) => ({ ...i }));
    }
    if (mode === "jump") return pool;
    // Empty query: what was run lately first, as Herdr's "Recent".
    const byId = new Map(items.map((i) => [i.id, i]));
    const head = recent.map((id) => byId.get(id)).filter((i): i is PaletteItem => Boolean(i)).map((i) => ({ ...i, group: "最近", id: `recent:${i.id}` }));
    return [...head, ...pool];
  }, [items, mode, query, recent]);

  const runnable = useMemo(
    () =>
      shown.map((i) => ({
        ...i,
        run: () => {
          pushRecent(i.id.replace(/^recent:/, ""));
          onClose();
          // After the dialog is gone, so focus lands where the command puts it.
          window.setTimeout(i.run, 0);
        },
      })),
    [onClose, shown],
  );

  const nav = usePaletteNav(runnable, open, "v3-palette-list");

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="v3-palette-backdrop" />
        <Dialog.Content className="v3-palette" aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
          <Dialog.Title className="sr-only">{mode === "jump" ? "跳到 Agent 或标签" : "命令面板"}</Dialog.Title>
          <div className="v3-palette-input">
            {mode === "jump" ? <Search size={15} /> : <Command size={15} />}
            <input
              autoFocus
              {...nav.inputProps}
              value={query}
              placeholder={mode === "jump" ? "跳到 Agent 或标签…" : "输入命令…"}
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                nav.reset();
              }}
            />
            <span className="v3-chip">Esc</span>
          </div>
          <div id="v3-palette-list" role="listbox" aria-label="命令" className="v3-palette-list">
            {runnable.length === 0 ? <div className="v3-palette-empty">没有匹配的命令或 Agent</div> : null}
            {runnable.map((item, i) => {
              const Icon = item.icon;
              const head = i === 0 || runnable[i - 1]!.group !== item.group;
              return (
                <div key={item.id}>
                  {head ? <div className="v3-palette-group">{item.group}</div> : null}
                  <div {...nav.optionProps(i)} className={`v3-palette-row${i === nav.active ? " active" : ""}`}>
                    {Icon ? <Icon size={14} /> : null}
                    <span className="v3-palette-label truncate">{item.label}</span>
                    {item.hint ? <span className="v3-palette-hint truncate">{item.hint}</span> : <span className="grow" />}
                    {item.keys ? (
                      <span className="v3-palette-keys">
                        {keyChips(item.keys).map((k, j) => (
                          <span key={j} className="v3-chip">
                            {k}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
