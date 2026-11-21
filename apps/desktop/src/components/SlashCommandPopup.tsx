import { useEffect, useRef } from "react";
import {
  Activity,
  Bot,
  Brain,
  Clock,
  Compass,
  Cpu,
  Eraser,
  FolderOpen,
  Gauge,
  GitBranch,
  GitCompare,
  Globe,
  HelpCircle,
  History,
  Keyboard,
  Layers,
  LogOut,
  Minimize2,
  Plug,
  PlusCircle,
  SearchCheck,
  Settings,
  Share2,
  ShieldCheck,
  Sliders,
  Sparkles,
  Target,
  TerminalSquare,
  UserCheck,
  Zap,
} from "lucide-react";
import type { SlashCommandItem } from "@herdr-pocket/protocol";
import { SLASH_CATEGORIES, slashCommandIconKind, type SlashCategory, type SlashIconKind } from "../lib/slashCommands";

function SlashKindIcon({ kind }: { kind: SlashIconKind }) {
  const s = 12;
  switch (kind) {
    case "usage":
      return <Gauge size={s} />;
    case "context":
      return <Layers size={s} />;
    case "help":
      return <HelpCircle size={s} />;
    case "keyboard":
      return <Keyboard size={s} />;
    case "status":
      return <Activity size={s} />;
    case "clear":
      return <Eraser size={s} />;
    case "compact":
      return <Minimize2 size={s} />;
    case "new":
      return <PlusCircle size={s} />;
    case "history":
      return <History size={s} />;
    case "branch":
      return <GitBranch size={s} />;
    case "share":
      return <Share2 size={s} />;
    case "exit":
      return <LogOut size={s} />;
    case "model":
      return <Cpu size={s} />;
    case "speed":
      return <Zap size={s} />;
    case "shield":
      return <ShieldCheck size={s} />;
    case "memory":
      return <Brain size={s} />;
    case "auth":
      return <UserCheck size={s} />;
    case "settings":
      return <Settings size={s} />;
    case "plan":
      return <Compass size={s} />;
    case "review":
      return <SearchCheck size={s} />;
    case "git":
      return <GitCompare size={s} />;
    case "mcp":
      return <Plug size={s} />;
    case "browser":
      return <Globe size={s} />;
    case "schedule":
      return <Clock size={s} />;
    case "workspace":
      return <FolderOpen size={s} />;
    case "goal":
      return <Target size={s} />;
    case "agents":
      return <Bot size={s} />;
    case "skill":
      return <Sparkles size={s} />;
    case "custom":
    default:
      return <Sliders size={s} />;
  }
}

export function SlashCommandPopup({
  commands,
  selectedIndex,
  category,
  onCategoryChange,
  onHoverIndex,
  onPick,
  harnessLabel,
}: {
  commands: SlashCommandItem[];
  selectedIndex: number;
  category: "all" | SlashCategory;
  onCategoryChange: (cat: "all" | SlashCategory) => void;
  onHoverIndex: (idx: number) => void;
  onPick: (cmd: SlashCommandItem) => void;
  harnessLabel: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-slash-idx="${selectedIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="slash-pop" role="listbox" aria-label={`${harnessLabel} 斜杠命令`}>
      <div className="slash-pop-head">
        <span className="slash-pop-title">
          <TerminalSquare size={12} />
          <span>{harnessLabel} · 斜杠命令</span>
        </span>
        <div className="slash-cats" role="tablist" aria-label="命令分类">
          {SLASH_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={category === c.id}
              className={`slash-cat${category === c.id ? " on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onCategoryChange(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={listRef} className="slash-pop-list">
        {commands.length === 0 ? (
          <div className="slash-pop-empty">没有匹配的斜杠命令</div>
        ) : (
          commands.map((cmd, idx) => {
            const on = idx === selectedIndex;
            const badge = cmd.source === "project" ? "项目" : cmd.source === "user" ? "全局" : null;
            const kind = slashCommandIconKind(cmd);
            return (
              <button
                key={`${cmd.name}-${cmd.source ?? "b"}`}
                type="button"
                role="option"
                aria-selected={on}
                data-slash-idx={idx}
                className={`slash-row${on ? " on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(cmd);
                }}
                onMouseEnter={() => onHoverIndex(idx)}
              >
                <span className="slash-row-ic" data-cat={cmd.category ?? "session"}>
                  <SlashKindIcon kind={kind} />
                </span>
                <span className="slash-row-name mono">{cmd.name}</span>
                {cmd.argHint ? <span className="slash-row-arg mono">{cmd.argHint}</span> : null}
                <span className="slash-row-desc truncate">{cmd.description}</span>
                {badge ? <span className="slash-row-badge">{badge}</span> : null}
              </button>
            );
          })
        )}
      </div>

      <div className="slash-pop-foot">
        <span>↑↓ 选择</span>
        <span>·</span>
        <span>Tab / Enter 填入或发送</span>
        <span>·</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}
