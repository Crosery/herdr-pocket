import { useEffect, useRef, useState } from "react";
import { Bell, Check, ChevronRight, Mic, MicOff, Minimize2, Phone, PhoneOff, Send, Trash2, X } from "lucide-react";
import type { AssistantItem } from "@herdr-pocket/protocol";
import { EmptyState, PocketBadge, PocketButton, PocketCard, PocketIconButton, PocketModal, fs, useToast } from "../components/PocketUI";
import { XiaoyangOrb, type MascotMood } from "../components/MascotAndVendor";
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
import { VoiceMicButton } from "../components/VoiceInput";
import { hangupVoiceCall, setVoiceMuted, startVoiceCall, voiceCallStore } from "../lib/voiceCall";
import { useComposerInput } from "../lib/composerKeys";
import { isMockServer } from "../lib/mock";
import { liveStore, settingsStore } from "../lib/store";

const SUGGESTIONS = ["谁在等我？", "大家都在忙什么？", "最近谁跑完了，结果怎么样？", "10 分钟后提醒我看一下进度"];

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function AssistantView({ onOpenAgent }: { onOpenAgent: (key: string) => void }) {
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
  const callState = voiceCallStore.use((s) => s);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const [callExpanded, setCallExpanded] = useState(true);
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

  const inCall = callState.status === "connecting" || callState.status === "ready";
  const sendLockRef = useRef(false);
  const lastSendRef = useRef<{ text: string; at: number } | null>(null);

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
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      sendLockRef.current = false;
      setSending(false);
    }
  };

  const composer = useComposerInput(text, () => void send(text));

  const startCall = async () => {
    setCallExpanded(true);
    const err = await startVoiceCall();
    if (err) toast(err, true);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Header */}
      <div className="between" style={{ padding: "12px 18px 8px", flexShrink: 0 }}>
        <div>
          <h2 className="cute-font" style={{ margin: 0, fontSize: fs(24) }}>小羊</h2>
          <div className="faint">
            {busy ? (busyLabel || "正在思考…") : voice || isMockServer(server) ? "盯着所有电脑 · 文字与语音随时可用" : "盯着所有电脑"}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {reminders.length > 0 ? (
            <PocketButton size="sm" variant="soft" onClick={() => setShowReminders(true)}>
              <Bell size={14} />
              <span>提醒 {reminders.length}</span>
            </PocketButton>
          ) : null}
          {(voice || isMockServer(server)) && !inCall ? (
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
      </div>

      {loaded && !ready && !isMockServer(server) ? (
        <div style={{ padding: "0 18px 8px" }}>
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
            body={`你所有电脑上的 agent 我都盯着。问我谁在等你、谁跑完了，或者让我替你回一句${voice ? "；点右上角或麦克风可以直接语音通话" : ""}。`}
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
        <div className="call-mini-bar" onClick={() => setCallExpanded(true)}>
          <div className="row">
            <XiaoyangOrb mood={callState.assistant === "speaking" ? "speaking" : "listening"} size={30} />
            <div>
              <div style={{ fontWeight: 800, fontSize: fs(13) }}>和小羊通话中</div>
              <div className="faint">{callState.status === "connecting" ? "正在接通…" : callState.task || "点击回到通话画面"}</div>
            </div>
          </div>
          <div className="row" onClick={(e) => e.stopPropagation()}>
            <PocketIconButton size="sm" active={callState.muted} onClick={() => setVoiceMuted(!callState.muted)} tooltip={callState.muted ? "取消静音" : "静音"}>
              {callState.muted ? <MicOff size={15} /> : <Mic size={15} />}
            </PocketIconButton>
            <PocketButton size="sm" variant="danger" onClick={() => hangupVoiceCall()}>
              <PhoneOff size={14} />
              <span>挂断</span>
            </PocketButton>
          </div>
        </div>
      ) : null}

      {/* Composer */}
      <div className="composer-card">
        <div className="composer-input-wrap">
          <textarea
            {...composer.textareaProps}
            placeholder="和小羊说点什么…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="composer-foot">
          <div className="composer-tools">
            <VoiceMicButton />
          </div>
          <div className="composer-actions">
            {!text.trim() && (voice || isMockServer(server)) && !inCall ? (
              <PocketIconButton active className="composer-send" tooltip="语音通话" onClick={() => void startCall()}>
                <Phone size={15} />
              </PocketIconButton>
            ) : (
              <PocketButton size="sm" className="composer-send" disabled={!text.trim() || sending} aria-label="发送" onClick={() => void send(text)}>
                <Send size={14} />
              </PocketButton>
            )}
          </div>
        </div>
      </div>

      {/* Fullscreen Call View */}
      {inCall && callExpanded ? (
        <CallOverlay onMinimize={() => setCallExpanded(false)} />
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

function CallOverlay({ onMinimize }: { onMinimize: () => void }) {
  const s = voiceCallStore.use((v) => v);
  const mood: MascotMood = s.assistant === "speaking" ? "speaking" : s.assistant === "thinking" ? "working" : "listening";
  const statusText =
    s.status === "connecting"
      ? "正在接通小羊…"
      : s.task
        ? `正在处理：${s.task}`
        : s.assistant === "speaking"
          ? "小羊正在说…"
          : s.assistant === "thinking"
            ? "小羊在想…"
            : s.muted
              ? "麦克风已静音"
              : "我在听，直接说话就行";

  return (
    <div className="call-overlay">
      <div className="between">
        <PocketIconButton onClick={onMinimize} tooltip="收起继续看消息">
          <Minimize2 size={17} />
        </PocketIconButton>
        <div style={{ fontWeight: 800 }}>和小羊通话</div>
        <div style={{ width: 38 }} />
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, minHeight: 0 }}>
        <XiaoyangOrb mood={mood} size={136} />
        <div style={{ textAlign: "center" }}>
          <h3 className="cute-font" style={{ margin: 0, fontSize: fs(24) }}>{statusText}</h3>
          <div className="row" style={{ justifyContent: "center", marginTop: 10, gap: 12 }}>
            <span className="faint">麦克风</span>
            <div style={{ width: 70, height: 6, borderRadius: 99, background: "var(--line-pink)", overflow: "hidden" }}>
              <div style={{ width: `${Math.round(s.micLevel * 100)}%`, height: "100%", background: "var(--primary)" }} />
            </div>
            <span className="faint">声音</span>
            <div style={{ width: 70, height: 6, borderRadius: 99, background: "var(--line-pink)", overflow: "hidden" }}>
              <div style={{ width: `${Math.round(s.outLevel * 100)}%`, height: "100%", background: "var(--lav)" }} />
            </div>
          </div>
        </div>

        <div style={{ width: "100%", maxWidth: 520, maxHeight: 220, overflowY: "auto", padding: "8px 12px" }} className="stack">
          {s.lines.slice(-6).map((l) => (
            <div
              key={l.id}
              style={{
                alignSelf: l.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                padding: "8px 12px",
                borderRadius: 16,
                background: l.role === "user" ? "var(--primary)" : "var(--surface)",
                color: l.role === "user" ? "var(--on-primary)" : "var(--ink)",
                border: l.role === "user" ? "none" : "1px solid var(--divider)",
                opacity: l.final ? 1 : 0.78,
              }}
            >
              {l.text}
            </div>
          ))}
        </div>
      </div>

      <div className="row" style={{ justifyContent: "center", gap: 22 }}>
        <PocketIconButton active={s.muted} onClick={() => setVoiceMuted(!s.muted)} tooltip={s.muted ? "取消静音" : "静音"}>
          {s.muted ? <MicOff size={18} /> : <Mic size={18} />}
        </PocketIconButton>
        <PocketButton variant="danger" size="lg" onClick={() => hangupVoiceCall()}>
          <PhoneOff size={17} />
          <span>挂断</span>
        </PocketButton>
      </div>
    </div>
  );
}
