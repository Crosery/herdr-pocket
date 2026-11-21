import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  FileEdit,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Info,
  MessageSquareMore,
  PanelRightOpen,
  Paperclip,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { SubSession } from "@herdr-pocket/protocol";
import { extractImageTargets } from "../lib/chatImages";
import { useLocalHostDeviceId } from "../lib/fonts";
import { native } from "../lib/native";
import { RichMarkdown } from "../lib/markdown";
import { looksLikeClickableFilePath } from "../lib/openFileTarget";
import { prettyMaybeJson, type ChatRow, type ToolCategory, type ToolStep } from "../lib/chatFold";
import { rpcCall } from "../lib/relay";
import { subLabel } from "./SubagentNav";
import "../styles/chat-tools.css";

const STEP_WINDOW = 50;
const IO_PREVIEW_LIMIT = 4000;

const ChatInlineImageThumb = memo(function ChatInlineImageThumb({
  target,
  agentKey,
  deviceId,
  cwd,
  onOpenFile,
}: {
  target: string;
  agentKey?: string;
  deviceId?: string;
  cwd?: string;
  onOpenFile?: (target: string) => void;
}) {
  const localId = useLocalHostDeviceId();
  const isLocal = Boolean(deviceId && localId && deviceId === localId);
  const localUrl = useMemo(
    () => (isLocal ? native.localFileStreamUrl(target, cwd) : null),
    [cwd, isLocal, target],
  );
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "gone">(() =>
    localUrl ? "ready" : "idle",
  );
  const [visible, setVisible] = useState(isLocal);
  const ref = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setRemoteUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setStatus(localUrl ? "ready" : "idle");
  }, [localUrl, target]);

  useEffect(() => {
    if (localUrl || visible || !ref.current) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, [localUrl, visible]);

  useEffect(() => {
    if (localUrl || !visible || !deviceId || !agentKey) return;
    let dead = false;
    setStatus("loading");
    void rpcCall(deviceId, "files.read", { agent: agentKey, path: target }, 20_000)
      .then((res) => {
        if (dead) return;
        if (res.base64 && res.mime) {
          const bin = atob(res.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([bytes], { type: res.mime }));
          setRemoteUrl(url);
          setStatus("ready");
          return;
        }
        if (res.text && /\.svg$/i.test(target) && res.text.includes("<svg")) {
          const url = URL.createObjectURL(new Blob([res.text], { type: "image/svg+xml" }));
          setRemoteUrl(url);
          setStatus("ready");
          return;
        }
        setStatus("gone");
      })
      .catch(() => {
        if (!dead) setStatus("gone");
      });
    return () => {
      dead = true;
    };
  }, [agentKey, deviceId, localUrl, target, visible]);

  useEffect(() => {
    return () => {
      if (remoteUrl) URL.revokeObjectURL(remoteUrl);
    };
  }, [remoteUrl]);

  if (status === "gone") return null;
  const src = localUrl ?? remoteUrl;
  if (!localUrl && !agentKey) return null;
  const name = target.split("/").filter(Boolean).pop() || target;

  return (
    <button
      ref={ref}
      type="button"
      className={`chat-img-card${status === "loading" || !src ? " loading" : ""}`}
      title={`查看图片 ${target}`}
      onClick={() => onOpenFile?.(target)}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          loading="lazy"
          onError={() => setStatus("gone")}
        />
      ) : (
        <span className="chat-img-skel">
          <ImageIcon size={16} />
          <span className="truncate">{name}</span>
        </span>
      )}
    </button>
  );
});

function InlineImageStrip({
  targets,
  agentKey,
  deviceId,
  cwd,
  onOpenFile,
}: {
  targets: string[];
  agentKey?: string;
  deviceId?: string;
  cwd?: string;
  onOpenFile?: (target: string) => void;
}) {
  if (targets.length === 0) return null;
  return (
    <div className="chat-img-strip">
      {targets.map((target) => (
        <ChatInlineImageThumb
          key={target}
          target={target}
          agentKey={agentKey}
          deviceId={deviceId}
          cwd={cwd}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

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

function extractTargetFromLine(line: string): string | null {
  const cleaned = line
    .trim()
    .replace(/^\[(?:Image|File|Attachment)\s*#?\d*\]\s*/i, "")
    .replace(/^@/, "")
    .replace(/^["'`<]+|["'`>]+$/g, "");
  if (looksLikeClickableFilePath(cleaned)) return cleaned;
  const tokens = line.trim().split(/\s+/);
  for (const raw of tokens) {
    const t = raw.replace(/^@/, "").replace(/^["'`(<]+|["'`>),.;]+$/g, "");
    if (looksLikeClickableFilePath(t)) return t;
  }
  return null;
}

function SubLinkCard({
  sub,
  onOpenSub,
  onOpenSubAside,
  inset = false,
}: {
  sub: SubSession;
  onOpenSub?: (sub: SubSession) => void;
  onOpenSubAside?: (sub: SubSession) => void;
  inset?: boolean;
}) {
  const label = subLabel(sub);
  const working = sub.status === "working";
  return (
    <div className={`act-sub-card${inset ? " inset" : ""}`}>
      <button
        type="button"
        className="act-sub-card-main"
        title={`打开子 Agent 对话：${label}`}
        onClick={() => onOpenSub?.(sub)}
      >
        <GitBranch size={13} className="act-sub-ic" />
        <span className="act-sub-label truncate">查看子 Agent 对话 · {label}</span>
        <span className={`act-sub-pill${working ? " working" : ""}`}>
          <span className={`sub-dot ${working ? "working" : "done"}`} />
          <span>{working ? "工作中" : "已完成"}</span>
        </span>
        <ChevronRight size={14} className="act-sub-chev" />
      </button>
      {onOpenSubAside ? (
        <button
          type="button"
          className="act-sub-aside-btn"
          title="在右侧边栏打开"
          aria-label={`在侧边栏打开 ${label}`}
          onClick={() => onOpenSubAside(sub)}
        >
          <PanelRightOpen size={13} />
        </button>
      ) : null}
    </div>
  );
}

/** Standalone thinking block matching Mobile's ThinkingPill & Uniflo clarity. */
const ThinkingRowItem = memo(function ThinkingRowItem({
  row,
}: {
  row: Extract<ChatRow, { kind: "thinking" }>;
}) {
  const [open, setOpen] = useState(Boolean(row.defaultOpen));
  useEffect(() => {
    setOpen(Boolean(row.defaultOpen));
  }, [row.defaultOpen]);
  const preview = useMemo(
    () => row.text.trim().split("\n").map((l) => l.trim()).find(Boolean) ?? "",
    [row.text],
  );
  return (
    <div className={`act-thought-pill${open ? " open" : ""}`}>
      <button
        type="button"
        className="act-thought-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={13} className={`act-chev${open ? " open" : ""}`} />
        <MessageSquareMore size={13} className="act-thought-ic" />
        <span className="act-thought-title">思考过程</span>
        {!open && preview ? <span className="act-thought-preview truncate">{preview}</span> : null}
      </button>
      {open ? <div className="act-thought-body">{row.text}</div> : null}
    </div>
  );
});

/** Single paired tool call + result row; lazily parses & mounts JSON/output only when clicked open. */
const ToolStepItem = memo(function ToolStepItem({
  step,
  sub,
  agentKey,
  deviceId,
  cwd,
  onOpenSub,
  onOpenSubAside,
  onOpenFile,
  standalone = false,
}: {
  step: ToolStep;
  sub?: SubSession;
  agentKey?: string;
  deviceId?: string;
  cwd?: string;
  onOpenSub?: (sub: SubSession) => void;
  onOpenSubAside?: (sub: SubSession) => void;
  onOpenFile?: (target: string) => void;
  standalone?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const formattedInput = useMemo(() => (open ? prettyMaybeJson(step.input) : ""), [open, step.input]);
  const formattedOutput = useMemo(() => (open && step.result ? prettyMaybeJson(step.result.output) : ""), [open, step.result]);
  const fileTarget = useMemo(() => {
    if (!onOpenFile || (step.category !== "read" && step.category !== "edit") || !step.summary) return null;
    return extractTargetFromLine(step.summary);
  }, [onOpenFile, step.category, step.summary]);
  const toolImages = useMemo(
    () =>
      step.category === "read" || step.category === "edit" || step.result?.output
        ? extractImageTargets([step.summary, step.result?.output])
        : [],
    [step.category, step.result?.output, step.summary],
  );

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
        {fileTarget && onOpenFile ? (
          <button
            type="button"
            className="act-sub-btn"
            style={{ marginRight: 6 }}
            title={`在标签页打开 ${fileTarget}`}
            onClick={() => onOpenFile(fileTarget)}
          >
            打开文件
          </button>
        ) : null}
      </div>
      {sub && onOpenSub ? (
        <SubLinkCard sub={sub} onOpenSub={onOpenSub} onOpenSubAside={onOpenSubAside} inset />
      ) : null}
      {toolImages.length > 0 ? (
        <div style={{ padding: "0 12px 6px 40px" }}>
          <InlineImageStrip
            targets={toolImages}
            agentKey={agentKey}
            deviceId={deviceId}
            cwd={cwd}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : null}
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

/** Collapsible multi-tool activity row (Uniflo / Mobile pattern): crisp grouped bar, or expanded stack in full mode. */
const ActivityGroupItem = memo(function ActivityGroupItem({
  row,
  subsByCall,
  agentKey,
  deviceId,
  cwd,
  onOpenSub,
  onOpenSubAside,
  onOpenFile,
}: {
  row: Extract<ChatRow, { kind: "activity_group" }>;
  subsByCall: Map<string, SubSession>;
  agentKey?: string;
  deviceId?: string;
  cwd?: string;
  onOpenSub?: (sub: SubSession) => void;
  onOpenSubAside?: (sub: SubSession) => void;
  onOpenFile?: (target: string) => void;
}) {
  const [open, setOpen] = useState(Boolean(row.defaultOpen));
  useEffect(() => {
    setOpen(Boolean(row.defaultOpen));
  }, [row.defaultOpen]);
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
    <div className={`act-group${row.running ? " running" : row.failedCount > 0 ? " error" : ""}${row.defaultOpen ? " full-mode" : ""}`}>
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
      </div>

      {!open && subSessions.length > 0 && onOpenSub
        ? subSessions.map((s) => (
            <SubLinkCard key={s.key} sub={s} onOpenSub={onOpenSub} onOpenSubAside={onOpenSubAside} inset />
          ))
        : null}

      {open ? (
        <div className={`act-body${row.defaultOpen ? " expanded" : ""}`}>
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
            <ToolStepItem
              key={step.id}
              step={step}
              sub={subsByCall.get(step.callId)}
              agentKey={agentKey}
              deviceId={deviceId}
              cwd={cwd}
              onOpenSub={onOpenSub}
              onOpenSubAside={onOpenSubAside}
              onOpenFile={onOpenFile}
            />
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

const UserRowItem = memo(function UserRowItem({
  row,
  agentKey,
  deviceId,
  cwd,
  onOpenFile,
}: {
  row: Extract<ChatRow, { kind: "user" }>;
  agentKey?: string;
  deviceId?: string;
  cwd?: string;
  onOpenFile?: (target: string) => void;
}) {
  const [showInjected, setShowInjected] = useState(false);
  const attachTargets = useMemo(() => {
    if (!row.attachedLines.length) return [];
    return row.attachedLines.map((line) => {
      const target = extractTargetFromLine(line);
      const label = (target || line).split("/").filter(Boolean).pop() || line;
      return { raw: line, target, label };
    });
  }, [row.attachedLines]);
  const imageTargets = useMemo(
    () => extractImageTargets([...row.attachedLines, row.text]),
    [row.attachedLines, row.text],
  );

  return (
    <div className="bubble-row user">
      {row.text ? <div className="bubble user">{row.text}</div> : null}
      <InlineImageStrip
        targets={imageTargets}
        agentKey={agentKey}
        deviceId={deviceId}
        cwd={cwd}
        onOpenFile={onOpenFile}
      />
      {row.attachedCount > 0 ? (
        attachTargets.length > 0 && onOpenFile ? (
          <div className="chat-att-list" title={row.attachedLines.join("\n")}>
            {attachTargets.map((att, idx) =>
              att.target ? (
                <button
                  key={`${att.raw}-${idx}`}
                  type="button"
                  className="chat-attach-note chat-att-chip"
                  title={`在标签页打开 ${att.target}`}
                  onClick={() => onOpenFile(att.target!)}
                >
                  <Paperclip size={11} />
                  <span className="truncate">{att.label}</span>
                </button>
              ) : (
                <span key={`${att.raw}-${idx}`} className="chat-attach-note row" style={{ gap: 5 }}>
                  <Paperclip size={11} />
                  <span>{att.label}</span>
                </span>
              ),
            )}
          </div>
        ) : (
          <div className="chat-attach-note row" style={{ gap: 5 }} title={row.attachedLines.join("\n")}>
            <Paperclip size={12} />
            <span>已附带 {row.attachedCount} 个文件/图片</span>
          </div>
        )
      ) : null}
      {row.injected ? (
        <button type="button" className="chat-attach-note" onClick={() => setShowInjected((v) => !v)} style={{ cursor: "pointer" }}>
          {showInjected ? row.injected : "附加系统上下文（点击查看）"}
        </button>
      ) : null}
    </div>
  );
});

const AssistantRowItem = memo(function AssistantRowItem({
  row,
  agentKey,
  deviceId,
  cwd,
  onOpenFile,
}: {
  row: Extract<ChatRow, { kind: "assistant" }>;
  agentKey?: string;
  deviceId?: string;
  cwd?: string;
  onOpenFile?: (target: string) => void;
}) {
  const imageTargets = useMemo(() => extractImageTargets([row.text]), [row.text]);
  return (
    <div className="bubble-row assistant">
      <div className="bubble assistant">
        <RichMarkdown text={row.text} onOpenFile={onOpenFile} />
      </div>
      <InlineImageStrip
        targets={imageTargets}
        agentKey={agentKey}
        deviceId={deviceId}
        cwd={cwd}
        onOpenFile={onOpenFile}
      />
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
  agentKey,
  deviceId,
  cwd,
  onOpenSub,
  onOpenSubAside,
  onOpenFile,
}: {
  rows: ChatRow[];
  subs: SubSession[];
  agentKey?: string;
  deviceId?: string;
  cwd?: string;
  onOpenSub?: (sub: SubSession) => void;
  onOpenSubAside?: (sub: SubSession) => void;
  onOpenFile?: (target: string) => void;
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
            return (
              <UserRowItem
                key={row.id}
                row={row}
                agentKey={agentKey}
                deviceId={deviceId}
                cwd={cwd}
                onOpenFile={onOpenFile}
              />
            );
          case "assistant":
            return (
              <AssistantRowItem
                key={row.id}
                row={row}
                agentKey={agentKey}
                deviceId={deviceId}
                cwd={cwd}
                onOpenFile={onOpenFile}
              />
            );
          case "tool":
            return (
              <ToolStepItem
                key={row.id}
                step={row.step}
                sub={subsByCall.get(row.step.callId)}
                agentKey={agentKey}
                deviceId={deviceId}
                cwd={cwd}
                onOpenSub={onOpenSub}
                onOpenSubAside={onOpenSubAside}
                onOpenFile={onOpenFile}
                standalone
              />
            );
          case "activity_group":
            return (
              <ActivityGroupItem
                key={row.id}
                row={row}
                subsByCall={subsByCall}
                agentKey={agentKey}
                deviceId={deviceId}
                cwd={cwd}
                onOpenSub={onOpenSub}
                onOpenSubAside={onOpenSubAside}
                onOpenFile={onOpenFile}
              />
            );
          case "thinking":
            return <ThinkingRowItem key={row.id} row={row} />;
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
