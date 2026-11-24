import { useEffect, useRef, useState } from "react";
import { Bell, Check, ChevronRight, Mic, MicOff, Minimize2, Phone, PhoneOff, Send, Trash2, X } from "lucide-react";
import type { AssistantItem } from "@herdr-pocket/protocol";
import { EmptyState, PocketBadge, PocketButton, PocketCard, PocketIconButton, PocketModal, fs, useToast } from "../components/PocketUI";
import { XiaoyangOrb, resolveCallMascotMood } from "../components/MascotAndVendor";
import {
  assistantStore,
  clearAssistantThread,
  decideAssistantAction,
  deleteAssistantReminder,
  loadAssistant,
  sendToAssistant,
  setAssistantWatching,
} from "../lib/assistant";
import { RichMarkdown } from "../lib/markdown";
import { dismissVoiceMessage, hangupVoiceCall, setVoiceMuted, startVoiceCall, voiceCallStore, type VoiceCallState } from "../lib/voiceCall";
import { useComposerInput } from "../lib/composerKeys";
import { isMockServer } from "../lib/mock";
import { liveStore, settingsStore } from "../lib/store";
import "../styles/assistant-call.css";

const SUGGESTIONS = ["谁在等我？", "大家都在忙什么？", "最近谁跑完了，结果怎么样？", "10 分钟后提醒我看一下进度"];

export type CallStateView = VoiceCallState & { startedAt?: number | null };

let fallbackCallStartedAt: number | null = null;

/** Resolve call answer timestamp from VoiceCallState (or track ready-state start locally across drawer toggles). */
export function resolveCallStartedAt(state: { status: VoiceCallState["status"]; startedAt?: number | null }, now = Date.now()): number | null {
  if (typeof state.startedAt === "number" && Number.isFinite(state.startedAt)) {
    fallbackCallStartedAt = state.startedAt;
    return state.startedAt;
  }
  if (state.status === "ready") {
    if (fallbackCallStartedAt === null) fallbackCallStartedAt = now;
    return fallbackCallStartedAt;
  }
  if (state.status === "idle") {
    fallbackCallStartedAt = null;
  }
  return null;
}

voiceCallStore.subscribe(() => {
  resolveCallStartedAt(voiceCallStore.get() as CallStateView);
});

/** Format elapsed call time as mm:ss once the call is active. */
export function formatCallDuration(startedAt: number | null | undefined, now = Date.now()): string {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return "";
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mins = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const secs = String(totalSeconds % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

export function formatCallMiniSub(state: Pick<CallStateView, "status" | "muted">, duration: string): string {
  if (state.status === "connecting") return "正在接通…";
  const label = state.muted ? "已静音" : "点此回到通话";
  return duration ? `${duration} · ${label}` : label;
}

export function formatCallOverlayStatus(state: Pick<VoiceCallState, "status" | "task" | "assistant" | "muted">): string {
  if (state.status === "connecting") return "正在接通小羊…";
  const task = state.task?.trim();
  if (task) return `正在处理：${task}`;
  if (state.assistant === "speaking") return "小羊正在说…";
  if (state.assistant === "thinking") return "小羊在想…";
  if (state.muted) return "麦克风已静音";
  return "我在听，直接说话就行";
}

function useCallClock(status: VoiceCallState["status"], startedAtRaw: number | null | undefined, enabled = true): string {
  const startedAt = enabled ? resolveCallStartedAt({ status, startedAt: startedAtRaw }) : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled || startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled, startedAt]);

  return enabled ? formatCallDuration(startedAt, now) : "";
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function AssistantView({
  onOpenAgent,
  initialCallExpanded = true,
}: {
  onOpenAgent: (key: string) => void;
  initialCallExpanded?: boolean;
}) {
  const toast = useToast();
  const items = assistantStore.use((s) => s.items);
  const busy = assistantStore.use((s) => s.busy);
  const busyLabel = assistantStore.use((s) => s.busyLabel);
  const ready = assistantStore.use((s) => s.ready);
  const voice = assistantStore.use((s) => s.voice);
  const loaded = assistantStore.use((s) => s.loaded);
  const reminders = assistantStore.use((s) => s.reminders);
  const link = liveStore.use((s) => s.link);
  const server = settingsStore.use((s) => s.server);
  const callStatus = voiceCallStore.use((s) => s.status);
  const callMuted = voiceCallStore.use((s) => s.muted);
  const callStartedAt = voiceCallStore.use((s) => (s as CallStateView).startedAt ?? null);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [callExpanded, setCallExpanded] = useState(initialCallExpanded);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAssistantWatching(true);
    return () => setAssistantWatching(false);
  }, []);

  useEffect(() => {
    if (link === "online" || isMockServer(server)) {
      void loadAssistant();
    }
  }, [link, server]);

  useEffect(() => {
    const el = listRef.current;
    // An empty thread shows the mascot from the top; pinning it to the bottom cut its head off.
    if (el) el.scrollTop = items.length || busy ? el.scrollHeight : 0;
  }, [items.length, busy]);

  const inCall = callStatus === "connecting" || callStatus === "ready";
  const callDuration = useCallClock(callStatus, callStartedAt, inCall);
  const sendLockRef = useRef(false);
  const lastSendRef = useRef<{ text: string; at: number } | null>(null);
  const clearComposerRef = useRef<() => void>(() => {});

  const send = async (raw: string) => {
    const t = raw.trim();
    const now = Date.now();
    if (!t || sendLockRef.current) return;
    if (lastSendRef.current && lastSendRef.current.text === t && now - lastSendRef.current.at < 500) return;
    sendLockRef.current = true;
    lastSendRef.current = { text: t, at: now };
    setSending(true);
    try {
      await sendToAssistant(t);
      setText("");
      clearComposerRef.current();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      sendLockRef.current = false;
      setSending(false);
    }
  };

  const composer = useComposerInput(text, () => void send(composer.readValue()), undefined, undefined, setText);
  clearComposerRef.current = composer.clearValue;

  const startCall = async () => {
    setCallExpanded(true);
    const err = await startVoiceCall();
    if (err) {
      toast(err, true);
      dismissVoiceMessage();
    }
  };

  const headerSub = busy
    ? busyLabel || "正在思考…"
    : voice || isMockServer(server)
      ? "盯着所有电脑 · 文字与语音随时可用"
      : "盯着所有电脑";
  const showCallBtn = (voice || isMockServer(server)) && !inCall;
  const hasHeaderActions = reminders.length > 0 || showCallBtn || items.length > 0;

  return (
    <div className="assistant-pane-root">
      {/* Header */}
      <div className="assistant-pane-header">
        <div className="assistant-pane-meta">
          <h2 className="cute-font assistant-pane-title">小羊</h2>
          <div className="faint assistant-pane-sub" title={headerSub}>
            {headerSub}
          </div>
        </div>
        {hasHeaderActions ? (
          <div className="assistant-pane-actions">
            {reminders.length > 0 ? (
              <PocketButton size="sm" variant="soft" onClick={() => setShowReminders(true)}>
                <Bell size={14} />
                <span>提醒 {reminders.length}</span>
              </PocketButton>
            ) : null}
            {showCallBtn ? (
              <PocketButton size="sm" variant="primary" onClick={() => void startCall()}>
                <Phone size={14} />
                <span>打电话</span>
              </PocketButton>
            ) : null}
            {items.length > 0 ? (
              <PocketIconButton tooltip="清空对话" size="sm" onClick={() => setConfirmClear(true)}>
                <Trash2 size={15} />
              </PocketIconButton>
            ) : null}
          </div>
        ) : null}
      </div>

      {loaded && !ready && !isMockServer(server) ? (
        <div className="assistant-pane-notice">
          <PocketCard soft>
            <div className="faint">服务器上还没配置助理用的文字模型，可以在「设置 → 小羊助理」里添加后开聊。</div>
          </PocketCard>
        </div>
      ) : null}

      {/* Thread */}
      <div ref={listRef} className="chat-scroll">
        {loaded && items.length === 0 && !busy ? (
          <EmptyState
            mood="hello"
            title="我是小羊"
            body={`你所有电脑上的 agent 我都盯着。问我谁在等你、谁跑完了，或者让我替你回一句${voice ? "；点右上角或输入框旁的电话按钮可以直接语音通话" : ""}。`}
            action={
              <div className="row wrap" style={{ justifyContent: "center", marginTop: 8 }}>
                {SUGGESTIONS.map((s) => (
                  <PocketButton key={s} size="sm" variant="ghost" onClick={() => void send(s)}>
                    {s}
                  </PocketButton>
                ))}
              </div>
            }
          />
        ) : (
          items.map((item) => <AssistantBubble key={item.id} item={item} onOpenAgent={onOpenAgent} onError={(m) => toast(m, true)} />)
        )}
        {busy ? (
          <div className="bubble-row assistant">
            <div className="bubble assistant row" style={{ gap: 8 }}>
              <span className="status-dot breathe" style={{ color: "var(--accent-text)" }} />
              <span className="muted">{busyLabel || "小羊正在查看并整理…"}</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* Folded Call Bar */}
      {inCall && !callExpanded ? (
        <CallMiniBar
          duration={callDuration}
          onExpand={() => setCallExpanded(true)}
          onToggleMute={() => setVoiceMuted(!callMuted)}
          onHangup={() => hangupVoiceCall()}
        />
      ) : null}

      {/* Composer */}
      <div className="composer-card">
        <div className="composer-input-wrap">
          <textarea
            {...composer.textareaProps}
            placeholder="和小羊说点什么…"
          />
        </div>
        <div className="composer-foot">
          <div className="composer-tools" />
          <div className="composer-actions">
            {!composer.hasText && (voice || isMockServer(server)) && !inCall ? (
              <PocketIconButton active className="composer-send" tooltip="语音通话" onClick={() => void startCall()}>
                <Phone size={15} />
              </PocketIconButton>
            ) : (
              <PocketButton size="sm" className="composer-send" disabled={!composer.hasText || sending} aria-label="发送" onClick={() => void send(composer.readValue())}>
                <Send size={14} />
              </PocketButton>
            )}
          </div>
        </div>
      </div>

      {/* Scoped Call View */}
      {inCall && callExpanded ? (
        <CallOverlay onMinimize={() => setCallExpanded(false)} duration={callDuration} />
      ) : null}

      <PocketModal open={confirmClear} onOpenChange={setConfirmClear} title="开始新对话？" subtitle="聊天记录会清空，已设好的提醒不受影响。" width={380}>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <PocketButton variant="ghost" onClick={() => setConfirmClear(false)}>取消</PocketButton>
          <PocketButton
            variant="danger"
            onClick={async () => {
              setConfirmClear(false);
              try {
                await clearAssistantThread();
                toast("已开始新对话");
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            清空
          </PocketButton>
        </div>
      </PocketModal>

      <PocketModal open={showReminders} onOpenChange={setShowReminders} title="提醒事项" width={460}>
        <div className="stack">
          {reminders.length === 0 ? (
            <div className="muted">目前没有待触发的提醒。</div>
          ) : (
            reminders.map((r) => (
              <PocketCard key={r.id} soft>
                <div className="between">
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{r.text}</div>
                    <div className="faint">{r.dueAt ? `预计 ${new Date(r.dueAt).toLocaleString("zh-CN")}` : "状态满足时提醒"}</div>
                  </div>
                  <PocketIconButton
                    size="sm"
                    tooltip="删除提醒"
                    onClick={() => void deleteAssistantReminder(r.id).catch((e) => toast((e as Error).message, true))}
                  >
                    <X size={14} />
                  </PocketIconButton>
                </div>
              </PocketCard>
            ))
          )}
        </div>
      </PocketModal>
    </div>
  );
}

function AssistantBubble({
  item,
  onOpenAgent,
  onError,
}: {
  item: AssistantItem;
  onOpenAgent: (key: string) => void;
  onError: (m: string) => void;
}) {
  const [working, setWorking] = useState<"confirm" | "cancel" | null>(null);

  if (item.action) {
    const a = item.action;
    const pending = a.state === "pending";
    const decide = async (d: "confirm" | "cancel") => {
      setWorking(d);
      try {
        await decideAssistantAction(a.id, d);
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setWorking(null);
      }
    };
    return (
      <div className="bubble-row assistant">
        <PocketCard soft>
          <div className="stack" style={{ gap: 8 }}>
            <div style={{ fontWeight: 700 }}>{a.summary}</div>
            {a.said ? <div className="faint">你的原话：{a.said}</div> : null}
            <div className="between wrap">
              <PocketBadge tone={a.state === "done" ? "mint" : a.state === "failed" ? "blush" : "lav"}>
                {a.result || (pending ? "等待确认" : a.state)}
              </PocketBadge>
              {pending ? (
                <div className="row" style={{ gap: 6 }}>
                  <PocketButton size="sm" variant="ghost" disabled={Boolean(working)} onClick={() => void decide("cancel")}>取消</PocketButton>
                  <PocketButton size="sm" variant="primary" disabled={Boolean(working)} onClick={() => void decide("confirm")}>
                    <Check size={13} />
                    <span>确认执行</span>
                  </PocketButton>
                </div>
              ) : null}
            </div>
            {a.agent ? (
              <button className="term-key accent" style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => onOpenAgent(a.agent!)}>
                <span>查看目标 Agent</span>
                <ChevronRight size={13} />
              </button>
            ) : null}
          </div>
        </PocketCard>
      </div>
    );
  }

  if (item.notice) {
    const n = item.notice;
    return (
      <div className="bubble-row assistant">
        <PocketCard soft>
          <div className="stack" style={{ gap: 6 }}>
            <div className="between">
              <PocketBadge tone={n.kind === "blocked" ? "blush" : n.kind === "done" ? "mint" : "lav"}>{n.title}</PocketBadge>
              <span className="faint num">{fmtClock(n.ts)}</span>
            </div>
            <div>{n.body}</div>
            {n.details ? <RichMarkdown text={n.details} /> : null}
            {n.agent ? (
              <button className="term-key accent" style={{ alignSelf: "flex-start" }} onClick={() => onOpenAgent(n.agent!)}>
                打开相关 Agent →
              </button>
            ) : null}
          </div>
        </PocketCard>
      </div>
    );
  }

  const isUser = item.role === "user";
  return (
    <div className={`bubble-row ${isUser ? "user" : "assistant"}`}>
      <div className={`bubble ${isUser ? "user" : "assistant"}${item.error ? " error" : ""}`}>
        {isUser ? <div style={{ whiteSpace: "pre-wrap" }}>{item.text}</div> : <RichMarkdown text={item.text || "…"} />}
      </div>
      {item.steps?.length ? (
        <div className="row wrap" style={{ gap: 5 }}>
          {item.steps.map((s, i) => (
            <span key={i} className="faint" style={{ background: "var(--surface-2)", borderRadius: 999, padding: "2px 8px" }}>
              {s}
            </span>
          ))}
        </div>
      ) : null}
      <span className="faint num" style={{ fontSize: fs(11) }}>{fmtClock(item.ts)}</span>
    </div>
  );
}

export function CallMiniBar({
  callState: propState,
  duration,
  onExpand,
  onToggleMute,
  onHangup,
}: {
  callState?: CallStateView;
  duration: string;
  onExpand: () => void;
  onToggleMute: () => void;
  onHangup: () => void;
}) {
  const storeStatus = voiceCallStore.use((s) => s.status);
  const storeMuted = voiceCallStore.use((s) => s.muted);
  const storeAssistant = voiceCallStore.use((s) => s.assistant);
  const storeTask = voiceCallStore.use((s) => s.task);
  const storeMicLevel = voiceCallStore.use((s) => s.micLevel);
  const storeOutLevel = voiceCallStore.use((s) => s.outLevel);

  const status = propState ? propState.status : storeStatus;
  const muted = propState ? propState.muted : storeMuted;
  const assistant = propState ? propState.assistant : storeAssistant;
  const task = propState ? propState.task : storeTask;
  const micLevel = propState ? propState.micLevel : storeMicLevel;
  const outLevel = propState ? propState.outLevel : storeOutLevel;

  const subText = formatCallMiniSub({ status, muted }, duration);
  const taskText = task?.trim() || "";
  const speaking = assistant === "speaking" || outLevel > 0.08;
  const listeningActive = !muted && micLevel > 0.08;
  const waveMode =
    status === "connecting"
      ? "connecting"
      : muted && !speaking
        ? "muted"
        : speaking
          ? "speaking"
          : status === "ready" && listeningActive
            ? "active"
            : "idle";
  const mood = resolveCallMascotMood({ status, assistant, muted });

  return (
    <div className="call-mini-bar" onClick={onExpand}>
      <div className="call-mini-head">
        <div className="call-mini-ident">
          <XiaoyangOrb mood={mood} size={32} />
          <div className="call-mini-meta">
            <div className="call-mini-title-row">
              <span className="call-mini-title">和小羊通话中</span>
              <span className={`call-mini-wave ${waveMode}`} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </div>
            <div className="call-mini-sub num" title={subText}>
              {subText}
            </div>
          </div>
        </div>
        <div className="call-mini-actions" onClick={(e) => e.stopPropagation()}>
          <PocketIconButton
            size="sm"
            active={muted}
            onClick={onToggleMute}
            tooltip={muted ? "取消静音" : "静音"}
          >
            {muted ? <MicOff size={15} /> : <Mic size={15} />}
          </PocketIconButton>
          <PocketButton
            size="sm"
            variant="danger"
            className="call-mini-hangup"
            aria-label="挂断"
            title="挂断"
            onClick={onHangup}
          >
            <PhoneOff size={14} />
            <span className="call-mini-hangup-label">挂断</span>
          </PocketButton>
        </div>
      </div>
      {taskText ? (
        <div className="call-mini-task">
          <span className="status-dot breathe call-mini-task-dot" aria-hidden="true" />
          <span className="call-mini-task-text" title={task ?? taskText}>
            {taskText}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function CallOverlay({
  onMinimize,
  callState: propState,
  duration: propDuration,
}: {
  onMinimize: () => void;
  callState?: CallStateView;
  duration?: string;
}) {
  const storeState = voiceCallStore.use((v) => v) as CallStateView;
  const s = propState ?? storeState;
  const liveDuration = useCallClock(s.status, s.startedAt, propDuration === undefined);
  const duration = propDuration ?? liveDuration;
  const mood = resolveCallMascotMood(s);
  const statusText = formatCallOverlayStatus(s);
  const micPct = Math.max(0, Math.min(100, Math.round(s.micLevel * 100)));
  const outPct = Math.max(0, Math.min(100, Math.round(s.outLevel * 100)));

  return (
    <div className="call-overlay">
      <div className="between call-overlay-head">
        <PocketIconButton className="call-overlay-minimize" onClick={onMinimize} tooltip="收起继续看消息">
          <Minimize2 size={17} />
        </PocketIconButton>
        <div className="call-overlay-heading">
          <span className="call-overlay-title">和小羊通话</span>
          {s.status === "ready" && duration ? <span className="call-overlay-clock num">{duration}</span> : null}
        </div>
        <div className="call-overlay-head-spacer" aria-hidden="true" />
      </div>

      <div className="call-overlay-stage">
        <div className="call-overlay-orb">
          <XiaoyangOrb mood={mood} size={136} />
        </div>
        <div className="call-overlay-status-wrap">
          <h3 className="cute-font call-overlay-status" title={statusText}>
            {statusText}
          </h3>
          <div className="call-overlay-meters">
            <div className="call-overlay-meter">
              <span className="faint">麦克风</span>
              <div className="call-overlay-meter-track">
                <div className="call-overlay-meter-fill mic" style={{ width: `${micPct}%` }} />
              </div>
            </div>
            <div className="call-overlay-meter">
              <span className="faint">声音</span>
              <div className="call-overlay-meter-track">
                <div className="call-overlay-meter-fill out" style={{ width: `${outPct}%` }} />
              </div>
            </div>
          </div>
        </div>

        {s.lines.length > 0 ? (
          <div className="stack call-overlay-captions">
            {s.lines.slice(-6).map((l) => (
              <div
                key={l.id}
                className={`call-overlay-caption ${l.role === "user" ? "user" : "assistant"}${l.final ? "" : " interim"}`}
              >
                {l.text}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="row call-overlay-controls">
        <PocketIconButton
          className="call-overlay-mute"
          active={s.muted}
          onClick={() => setVoiceMuted(!s.muted)}
          tooltip={s.muted ? "取消静音" : "静音"}
        >
          {s.muted ? <MicOff size={18} /> : <Mic size={18} />}
        </PocketIconButton>
        <PocketButton className="call-overlay-hangup" variant="danger" size="lg" onClick={() => hangupVoiceCall()}>
          <PhoneOff size={17} />
          <span>挂断</span>
        </PocketButton>
      </div>
    </div>
  );
}
