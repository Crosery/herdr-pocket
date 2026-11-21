import { memo, useMemo, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  FileEdit,
  FileText,
  Globe,
  Info,
  MessageSquareMore,
  Paperclip,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { SubSession } from "@herdr-pocket/protocol";
import { RichMarkdown } from "../lib/markdown";
import { prettyMaybeJson, type ChatRow, type ToolCategory, type ToolStep } from "../lib/chatFold";
import "../styles/chat-tools.css";

const STEP_WINDOW = 50;
const IO_PREVIEW_LIMIT = 4000;

function CategoryIcon({ cat }: { cat: ToolCategory }) {
  switch (cat) {
    case "read":
      return <FileText size={12} />;
    case "edit":
      return <FileEdit size={12} />;
    case "run":
      return <Terminal size={12} />;
    case "search":
      return <Search size={12} />;
    case "web":
      return <Globe size={12} />;
    case "agent":
      return <Bot size={12} />;
    default:
      return <Wrench size={12} />;
  }
}

function IoBlock({ title, content, error }: { title: string; content: string; error?: boolean }) {
  const [full, setFull] = useState(false);
  const clipped = !full && content.length > IO_PREVIEW_LIMIT;
  const shown = clipped ? `${content.slice(0, IO_PREVIEW_LIMIT)}\n…（已截断，共 ${content.length.toLocaleString()} 字符）` : content;
  return (
    <div className="act-io-box">
      <div className={`act-io-head${error ? " error" : ""}`}>
        <span>{title}</span>
        {clipped || full ? (
          <button type="button" className="act-io-more" onClick={() => setFull((v) => !v)}>
            {full ? "收起长输出" : "显示完整输出"}
          </button>
        ) : null}
      </div>
      <pre>{shown}</pre>
    </div>
  );
}

/** Single paired tool call + result row; lazily parses & mounts JSON/output only when clicked open. */
const ToolStepItem = memo(function ToolStepItem({
  step,
  sub,
  onOpenSub,
  standalone = false,
}: {
  step: ToolStep;
  sub?: SubSession;
  onOpenSub?: (sub: SubSession) => void;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const formattedInput = useMemo(() => (open ? prettyMaybeJson(step.input) : ""), [open, step.input]);
  const formattedOutput = useMemo(() => (open && step.result ? prettyMaybeJson(step.result.output) : ""), [open, step.result]);

  return (
    <div className={standalone ? "act-group" : "act-step"}>
      <div className="act-step-wrap">
        <button
          type="button"
          className="act-step-row"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`act-step-ic ${step.category}`}>
            <CategoryIcon cat={step.category} />
          </span>
          <span className="act-step-name">{step.name}</span>
          {step.summary ? <span className="act-step-target" title={step.summary}>{step.summary}</span> : <span className="act-step-target" />}
          <span className={`act-step-state${step.running ? " running" : step.isError ? " error" : ""}`}>
            {step.running ? <span className="act-spin" aria-label="运行中" /> : step.isError ? <AlertCircle size={13} /> : <Check size={13} />}
          </span>
          <ChevronRight size={13} className={`act-chev${open ? " open" : ""}`} />
        </button>
        {sub && onOpenSub ? (
          <button
            type="button"
            className="act-sub-btn"
            style={{ marginRight: 8 }}
            onClick={() => onOpenSub(sub)}
          >
            子任务
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="act-step-io">
          {formattedInput ? <IoBlock title="输入参数" content={formattedInput} /> : null}
          {step.result ? (
            <IoBlock title={step.isError ? "输出（出错）" : "输出"} content={formattedOutput || "（无输出）"} error={step.isError} />
          ) : (
            <div className="faint">正在执行，结果到达后将自动更新…</div>
          )}
        </div>
      ) : null}
    </div>
  );
});

/** Collapsible multi-tool activity row (ChatGPT Desktop / Uniflo pattern): one compact line when closed, lazy body when open. */
const ActivityGroupItem = memo(function ActivityGroupItem({
  row,
  subsByCall,
  onOpenSub,
}: {
  row: Extract<ChatRow, { kind: "activity_group" }>;
  subsByCall: Map<string, SubSession>;
  onOpenSub?: (sub: SubSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const visibleTools = useMemo(() => {
    if (!open) return [];
    if (showAll || row.tools.length <= STEP_WINDOW) return row.tools;
    return row.tools.slice(-STEP_WINDOW);
  }, [open, row.tools, showAll]);

  const hiddenCount = open && !showAll && row.tools.length > STEP_WINDOW ? row.tools.length - STEP_WINDOW : 0;
  const subSessions = useMemo(
    () => row.tools.map((t) => subsByCall.get(t.callId)).filter((s): s is SubSession => Boolean(s)),
    [row.tools, subsByCall],
  );

  return (
    <div className={`act-group${row.running ? " running" : row.failedCount > 0 ? " error" : ""}`}>
      <div className="act-head-wrap">
        <button
          type="button"
          className="act-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="act-status-ic">
            {row.running ? <span className="act-spin" aria-label="运行中" /> : row.failedCount > 0 ? <AlertCircle size={14} /> : <Check size={14} />}
          </span>
          <span className="act-title">{row.headline}</span>
          {row.detailLine ? <span className="act-detail" title={row.detailLine}>{row.detailLine}</span> : null}
          <span className="act-series" aria-hidden>
            {row.series.map((s) => (
              <span key={s.name} className={`act-chip${s.running ? " running" : s.error ? " error" : ""}`}>
                <span>{s.name}</span>
                {s.count > 1 ? <span>×{s.count}</span> : null}
              </span>
            ))}
          </span>
          <ChevronRight size={14} className={`act-chev${open ? " open" : ""}`} />
        </button>
        {subSessions.length > 0 && onOpenSub ? (
          <button
            type="button"
            className="act-sub-btn"
            style={{ marginRight: 10 }}
            onClick={() => onOpenSub(subSessions[0]!)}
          >
            子 agent ({subSessions.length})
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="act-body">
          {hiddenCount > 0 ? (
            <button type="button" className="act-more-steps" onClick={() => setShowAll(true)}>
              还有更早的 {hiddenCount} 个步骤 · 点此展开全部 {row.tools.length} 步
            </button>
          ) : null}
          {row.thoughts.map((t, i) => (
            <details key={i} className="act-thought" style={{ margin: "6px 8px 2px", borderRadius: 8 }}>
              <summary>
                <MessageSquareMore size={12} />
                <span>思考过程{row.thoughts.length > 1 ? ` #${i + 1}` : ""}</span>
              </summary>
              <div className="act-thought-body">{t}</div>
            </details>
          ))}
          {visibleTools.map((step) => (
            <ToolStepItem key={step.id} step={step} sub={subsByCall.get(step.callId)} onOpenSub={onOpenSub} />
          ))}
          {row.notes.map((n, i) => (
            <details key={i} className="act-thought" style={{ margin: "4px 8px 6px", borderRadius: 8 }}>
              <summary>
                <Info size={12} />
                <span>{n.summary}</span>
              </summary>
              <div className="act-thought-body">{n.text}</div>
            </details>
          ))}
        </div>
      ) : null}
    </div>
  );
});

const UserRowItem = memo(function UserRowItem({ row }: { row: Extract<ChatRow, { kind: "user" }> }) {
  const [showInjected, setShowInjected] = useState(false);
  return (
    <div className="bubble-row user">
      {row.text ? <div className="bubble user">{row.text}</div> : null}
      {row.attachedCount > 0 ? (
        <div className="chat-attach-note row" style={{ gap: 5 }} title={row.attachedLines.join("\n")}>
          <Paperclip size={12} />
          <span>已附带 {row.attachedCount} 个文件/图片</span>
        </div>
      ) : null}
      {row.injected ? (
        <button type="button" className="chat-attach-note" onClick={() => setShowInjected((v) => !v)} style={{ cursor: "pointer" }}>
          {showInjected ? row.injected : "附加系统上下文（点击查看）"}
        </button>
      ) : null}
    </div>
  );
});

const AssistantRowItem = memo(function AssistantRowItem({ row }: { row: Extract<ChatRow, { kind: "assistant" }> }) {
  return (
    <div className="bubble-row assistant">
      <div className="bubble assistant">
        <RichMarkdown text={row.text} />
      </div>
    </div>
  );
});

const clockStr = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const ChatTimelineRows = memo(function ChatTimelineRows({
  rows,
  subs,
  onOpenSub,
}: {
  rows: ChatRow[];
  subs: SubSession[];
  onOpenSub?: (sub: SubSession) => void;
}) {
  const subsByCall = useMemo(() => {
    const m = new Map<string, SubSession>();
    for (const s of subs) {
      if (s.parentCall) m.set(s.parentCall, s);
    }
    return m;
  }, [subs]);

  return (
    <>
      {rows.map((row) => {
        switch (row.kind) {
          case "user":
            return <UserRowItem key={row.id} row={row} />;
          case "assistant":
            return <AssistantRowItem key={row.id} row={row} />;
          case "tool":
            return <ToolStepItem key={row.id} step={row.step} sub={subsByCall.get(row.step.callId)} onOpenSub={onOpenSub} standalone />;
          case "activity_group":
            return <ActivityGroupItem key={row.id} row={row} subsByCall={subsByCall} onOpenSub={onOpenSub} />;
          case "thinking":
            return (
              <details key={row.id} className="act-thought">
                <summary>
                  <MessageSquareMore size={13} />
                  <span>思考过程</span>
                </summary>
                <div className="act-thought-body">{row.text}</div>
              </details>
            );
          case "system":
            return (
              <details key={row.id} className="act-thought">
                <summary>
                  <Info size={13} />
                  <span>{row.summary}</span>
                </summary>
                <div className="act-thought-body">{row.text}</div>
              </details>
            );
          case "turn_end":
            return (
              <div key={row.id} className="chat-turn-sep">
                <span>这一轮结束 · {clockStr(row.ts)}</span>
              </div>
            );
        }
      })}
    </>
  );
});
