import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, TextInput, View } from "react-native";
import { Button, Dialog, Portal, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantAction, AssistantItem } from "@herdr-pocket/protocol";
import { BreathingDot, Card, IconTile, PageBackground, PocketToast, SendPill, TypingDots } from "../../components/ui";
import { CuteIcon } from "../../components/icons";
import { Mascot } from "../../components/Mascot";
import { mdStyles } from "../../components/chat";
import { Md } from "../../components/md";
import { CallBar, CallScreen } from "../../components/CallScreen";
import { AgentLink, NoticeBubble } from "../../components/notice";
import { RemindersSheet } from "../../components/reminders";
import { useFocusEffect } from "expo-router";
import { clearAssistant, decideAction, loadAssistant, sendToAssistant, setAssistantWatching, useAssistant } from "../../lib/assistant";
import { dismissCallMessage, startCall, useVoice } from "../../lib/voice";
import { findAgent, useLive, useSettings } from "../../lib/store";
import { fixCjkEmphasis, hasList } from "../../lib/markdown";
import { isMockServer } from "../../lib/mock";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space } from "../../theme/tokens";

const NAME = "小羊";
const SUGGESTIONS = ["谁在等我？", "大家都在忙什么？", "最近谁跑完了，结果怎么样？", "10 分钟后提醒我看一下进度"];

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function AssistantScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const items = useAssistant((s) => s.items);
  const busy = useAssistant((s) => s.busy);
  const busyLabel = useAssistant((s) => s.busyLabel);
  const ready = useAssistant((s) => s.ready);
  const voice = useAssistant((s) => s.voice);
  const loaded = useAssistant((s) => s.loaded);
  const error = useAssistant((s) => s.error);
  const reminders = useAssistant((s) => s.reminders);
  const link = useLive((s) => s.link);
  const server = useSettings((s) => s.server);
  const call = useVoice((s) => s.status);
  const callMessage = useVoice((s) => s.message);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const lastSentRef = useRef<{ text: string; at: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showReminders, setShowReminders] = useState(false);
  const list = useRef<FlatList<AssistantItem>>(null);
  const inCall = call === "connecting" || call === "ready";
  // During a call the chat stays reachable: the call folds into a bar above the composer.
  const [callOpen, setCallOpen] = useState(true);
  const foldCall = useCallback(() => setCallOpen(false), []);

  // Load when the connection or server changes. A paused tab re-runs its effects when it comes back
  // into view; the ref (kept while paused) stops that from reloading for nothing.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${link} ${server}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    if (link === "online" || isMockServer(server)) void loadAssistant();
  }, [link, server]);

  useFocusEffect(
    useCallback(() => {
      setAssistantWatching(true);
      return () => setAssistantWatching(false);
    }, []),
  );

  const data = useMemo(() => [...items].reverse(), [items]);

  /** Sends `raw`; true once the assistant has it (the composer then clears its text). */
  const send = useCallback(
    async (raw: string): Promise<boolean> => {
      const t = raw.trim();
      const now = Date.now();
      if (!t || sendingRef.current) return false;
      if (lastSentRef.current && lastSentRef.current.text === t && now - lastSentRef.current.at < 500) return false;
      sendingRef.current = true;
      lastSentRef.current = { text: t, at: now };
      setSending(true);
      try {
        await sendToAssistant(t);
        list.current?.scrollToOffset({ offset: 0, animated: true });
        return true;
      } catch (e) {
        setToast((e as Error).message);
        return false;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [],
  );
  const renderItem = useCallback(({ item }: { item: AssistantItem }) => <Bubble item={item} onError={setToast} />, []);

  async function call_() {
    setCallOpen(true);
    const err = await startCall();
    if (err) setToast(err);
  }

  const status = inCall
    ? "通话中"
    : busy
      ? `${busyLabel && busyLabel !== "在想" ? busyLabel : "在想"}…`
      : link === "online" || isMockServer(server)
        ? ready
          ? "在线 · 有事会叫你"
          : loaded
            ? "还没接上模型"
            : "连接中…"
        : "等网络恢复";

  return (
    <PageBackground>
      <View style={{ paddingTop: insets.top + space.md, paddingHorizontal: space.lg, paddingBottom: space.sm, flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Mascot mood={busy || inCall ? "hello" : "default"} size={46} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.cute, fontSize: 24, lineHeight: 32, color: p.ink }}>{NAME}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <BreathingDot color={busy || inCall ? p.primary : link === "online" || isMockServer(server) ? "#3FB68B" : p.faint} active={busy || inCall} size={7} />
            <Text style={{ color: p.muted, fontSize: 13 }}>{status}</Text>
          </View>
        </View>
        <View>
          <IconTile icon="bell" tone="plain" size={40} onPress={() => setShowReminders(true)} a11y={`提醒，${reminders.length} 个`} />
          {reminders.length ? (
            <View pointerEvents="none" style={{ position: "absolute", right: 4, top: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: p.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 }}>
              <Text style={{ color: p.onPrimary, fontSize: 10, fontFamily: fonts.bodyBold }}>{reminders.length}</Text>
            </View>
          ) : null}
        </View>
        <IconTile icon="newChat" tone="plain" size={40} onPress={() => setConfirmClear(true)} a11y="开始新对话" />
      </View>

      {error ? (
        <Card flat style={{ marginHorizontal: space.lg, padding: space.md, backgroundColor: p.errorContainer }}>
          <Text style={{ color: p.error, fontSize: 13.5 }}>{error}</Text>
        </Card>
      ) : loaded && !ready && !isMockServer(server) ? (
        <Card flat style={{ marginHorizontal: space.lg, padding: space.md, backgroundColor: p.accentContainer }}>
          <Text style={{ color: p.ink, fontSize: 13.5 }}>服务器上还没配置助理用的模型，配好后就能聊了。</Text>
        </Card>
      ) : null}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {/* The welcome sits outside the inverted list: inverted lists flip their empty view differently per platform. */}
        {loaded && !data.length && !busy ? (
          <Welcome onPick={(s) => void send(s)} voice={voice || isMockServer(server)} />
        ) : (
          <FlatList
            ref={list}
            data={data}
            inverted
            keyExtractor={(it) => it.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md, flexGrow: 1 }}
            renderItem={renderItem}
            ListHeaderComponent={busy ? <Thinking label={busyLabel} /> : undefined}
          />
        )}

        {inCall && !callOpen ? <CallBar name={NAME} onExpand={() => setCallOpen(true)} /> : null}
        <Composer
          onSend={send}
          onCall={() => void call_()}
          sending={sending}
          voice={voice || isMockServer(server)}
          inCall={inCall}
        />
      </KeyboardAvoidingView>

      {inCall && callOpen ? <CallScreen name={NAME} onMinimize={foldCall} /> : null}

      <Portal>
        <Dialog visible={confirmClear} onDismiss={() => setConfirmClear(false)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>开始新对话？</Dialog.Title>
          <Dialog.Content>
            <Text style={{ color: p.muted, lineHeight: 22 }}>聊天记录会清空，提醒不受影响。</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmClear(false)} textColor={p.ink}>
              取消
            </Button>
            <Button
              textColor={p.accentText}
              onPress={async () => {
                setConfirmClear(false);
                try {
                  await clearAssistant();
                } catch (e) {
                  setToast((e as Error).message);
                }
              }}
            >
              清空
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <RemindersSheet visible={showReminders} reminders={reminders} name={NAME} onDismiss={() => setShowReminders(false)} />

      <PocketToast
        visible={!!toast || !!callMessage}
        message={toast ?? callMessage}
        tone={!toast && (callMessage === "挂断了" || callMessage === "通话结束了") ? "hangup" : "error"}
        bottom={86}
        onDismiss={() => (toast ? setToast(null) : dismissCallMessage())}
      />
    </PageBackground>
  );
}

function Welcome({ onPick, voice }: { onPick: (s: string) => void; voice: boolean }) {
  const p = usePalette();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
      <Mascot mood="hello" size={120} />
      <Text style={{ fontFamily: fonts.cute, fontSize: 22, color: p.ink }}>我是{NAME}</Text>
      <Text style={{ color: p.muted, textAlign: "center", lineHeight: 21, paddingHorizontal: space.lg }}>
        你所有电脑上的 agent 我都盯着。问我谁在等你、谁跑完了，或者让我替你回一句{voice ? "；按麦克风可以直接说话" : ""}。
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm, paddingTop: space.sm }}>
        {SUGGESTIONS.map((s) => (
          <Pressable
            key={s}
            accessibilityRole="button"
            onPress={() => onPick(s)}
            style={({ pressed }) => ({ paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: pressed ? p.surface3 : p.surface, borderWidth: 1, borderColor: p.divider })}
          >
            <Text style={{ color: p.ink, fontSize: 13.5 }}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** 小羊 is replying: a small bubble on her side of the chat with typing dots, like the agent chat's working pill. */
function Thinking({ label }: { label: string | null }) {
  const p = usePalette();
  // The dots stand in for the old trailing "…".
  const text = label && label !== "在想" ? `${NAME}正在处理${label}` : `${NAME}在想`;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={text}
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        backgroundColor: p.surface,
        borderRadius: radius.card,
        borderBottomLeftRadius: 6,
        paddingLeft: space.md + 2,
        paddingRight: space.md,
        paddingVertical: 9,
      }}
    >
      <TypingDots color={p.primary} size={7} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: p.muted, fontSize: 13.5, fontFamily: fonts.bodySemi }}>
        {text}
      </Text>
    </View>
  );
}

const Bubble = memo(function Bubble({ item, onError }: { item: AssistantItem; onError: (m: string) => void }) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  const styles = mdStyles(p, scale);

  if (item.action) return <ActionCard item={item} onError={onError} />;

  if (item.role === "notice" && item.notice) return <NoticeBubble item={item} />;

  if (item.role === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "85%", gap: 3, alignItems: "flex-end" }}>
        <View style={{ backgroundColor: p.bubble, borderRadius: radius.card, borderBottomRightRadius: 6, paddingHorizontal: space.md, paddingVertical: 9 }}>
          <Text style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 22 * scale }}>{item.text}</Text>
        </View>
        <Meta item={item} />
      </View>
    );
  }

  return (
    <View style={[{ alignSelf: "flex-start", gap: 4 }, item.via !== "voice" && hasList(item.text) ? { width: "92%" } : { maxWidth: "92%" }]}>
      <View style={{ backgroundColor: item.error ? p.errorContainer : p.surface, borderRadius: radius.card, borderBottomLeftRadius: 6, paddingHorizontal: space.md, paddingVertical: 4 }}>
        {item.via === "voice" ? (
          <Text style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 22 * scale, paddingVertical: 5 }}>{item.text}</Text>
        ) : (
          <Md style={styles}>{fixCjkEmphasis(item.text || "…")}</Md>
        )}
      </View>
      {item.steps?.length ? (
        <Text style={{ color: p.faint, fontSize: 12, paddingHorizontal: 4 }} numberOfLines={2}>
          {item.steps.join(" · ")}
        </Text>
      ) : null}
      <Meta item={item} />
    </View>
  );
});

function Meta({ item }: { item: AssistantItem }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 }}>
      {item.via === "voice" ? <CuteIcon name="mic" size={12} color={p.faint} strokeWidth={2.4} /> : null}
      <Text style={{ color: p.faint, fontSize: 11 }}>{clock(item.ts)}</Text>
    </View>
  );
}

const ACTION_STATE: Record<string, string> = { pending: "等你确认", running: "正在执行", done: "已完成", cancelled: "已取消", failed: "失败了", expired: "已作废" };


/** One icon per kind of thing the assistant asks to do. */
const ACTION_ICONS: Record<AssistantAction["kind"], "send-outline" | "keyboard-outline" | "plus-circle-outline" | "stop-circle-outline" | "close-circle-outline" | "view-dashboard-outline" | "restore"> = {
  send: "send-outline",
  keys: "keyboard-outline",
  create: "plus-circle-outline",
  interrupt: "stop-circle-outline",
  close: "close-circle-outline",
  herdr: "view-dashboard-outline",
  resume: "restore",
};

function ActionCard({ item, onError }: { item: AssistantItem; onError: (m: string) => void }) {
  const p = usePalette();
  const a = item.action!;
  const [working, setWorking] = useState<"confirm" | "cancel" | null>(null);
  const pending = a.state === "pending";
  async function decide(d: "confirm" | "cancel") {
    setWorking(d);
    try {
      await decideAction(a.id, d);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }
  const icon = ACTION_ICONS[a.kind] ?? "send-outline";
  const tone = a.state === "failed" ? p.error : a.state === "done" ? "#3FB68B" : pending ? p.accentText : p.faint;
  // A message says who got it, by the name the answer uses, and on which computer; the text itself is
  // shown once, in full, below (the summary repeats its first 80 characters). Older relays: the summary.
  const send = a.kind === "send" && !!a.text;
  const who = a.agentName || a.agentTitle;
  const head = send && who ? `发给「${who}」` : a.summary;
  const where = send ? [a.deviceName, a.agentTitle && a.agentTitle !== who ? a.agentTitle : undefined].filter(Boolean).join(" · ") : "";
  const agent = a.agent ? findAgent(a.agent) : undefined;
  return (
    <Card style={{ padding: space.md, gap: space.sm, borderWidth: pending ? 1.5 : 0, borderColor: p.primary }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <MaterialCommunityIcons name={icon} size={18} color={p.ink} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bodyBold, color: p.ink }}>{head}</Text>
          {where ? (
            <Text numberOfLines={1} style={{ color: p.faint, fontSize: 12 }}>
              {where}
            </Text>
          ) : null}
        </View>
      </View>
      {send ? (
        <View style={{ backgroundColor: p.surface2, borderRadius: radius.sm, padding: space.sm }}>
          <Text selectable style={{ color: p.ink, lineHeight: 21 }}>
            {a.text}
          </Text>
        </View>
      ) : null}
      {send && a.said ? <SaidLine said={a.said} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ flex: 1, color: tone, fontSize: 12.5, fontFamily: fonts.bodySemi }}>{stateLine(a)}</Text>
        {pending ? (
          <>
            <Button compact mode="text" textColor={p.muted} disabled={!!working} loading={working === "cancel"} onPress={() => void decide("cancel")}>
              取消
            </Button>
            <Button compact mode="contained" disabled={!!working} loading={working === "confirm"} onPress={() => void decide("confirm")} style={{ borderRadius: radius.pill }}>
              确认执行
            </Button>
          </>
        ) : null}
      </View>
      {agent ? <AgentLink agentKey={agent.key} /> : null}
    </Card>
  );
}

/**
 * Where an action stands. A finished one is described by its own result ("发了，它正在忙这一轮…"):
 * "已完成" in front of it read as if the agent had finished the work.
 */
function stateLine(a: AssistantAction): string {
  if (a.state === "pending" || !a.result) return ACTION_STATE[a.state] ?? "";
  return a.state === "done" ? a.result : `${ACTION_STATE[a.state]} · ${a.result}`;
}

/** The person's own words a relayed message was made from: one line, tap for all of it. */
function SaidLine({ said }: { said: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`你的原话：${said}`}
      accessibilityHint={open ? "点按收起" : "点按展开全文"}
      onPress={() => setOpen((v) => !v)}
      hitSlop={6}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, minHeight: 32, paddingHorizontal: 2, paddingTop: 2 }}
    >
      <MaterialCommunityIcons name="format-quote-open" size={15} color={p.faint} style={{ marginTop: 1 }} />
      <Text numberOfLines={open ? undefined : 1} style={{ flex: 1, color: p.muted, fontSize: 12.5, lineHeight: 18 }}>
        你的原话：{said}
      </Text>
      <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={16} color={p.faint} />
    </Pressable>
  );
}

/** Holds what is being typed itself, so a keystroke re-renders only the composer, not the chat. */
function Composer({
  onSend,
  onCall,
  sending,
  voice,
  inCall,
}: {
  onSend: (text: string) => Promise<boolean>;
  onCall: () => void;
  sending: boolean;
  voice: boolean;
  inCall: boolean;
}) {
  const p = usePalette();
  const [text, setText] = useState("");
  const empty = !text.trim();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: space.sm,
        marginHorizontal: space.lg,
        marginBottom: space.sm,
        backgroundColor: p.surface,
        borderRadius: radius.xl,
        paddingLeft: space.lg,
        paddingRight: 5,
        paddingVertical: 5,
        shadowColor: p.shadow,
        shadowOpacity: p.dark ? 0 : 0.12,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: p.dark ? 0 : 2,
      }}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={`和${NAME}说点什么…`}
        placeholderTextColor={p.faint}
        multiline
        style={{ flex: 1, fontFamily: fonts.body, fontSize: 15.5, color: p.ink, maxHeight: 120, paddingVertical: 9 }}
        accessibilityLabel={`发给${NAME}的消息`}
      />
      {empty && voice && !inCall ? (
        <IconTile icon="mic" tone="primary" size={42} onPress={onCall} a11y={`和${NAME}语音通话`} />
      ) : (
        <SendPill disabled={empty || sending} onPress={() => void onSend(text).then((sent) => sent && setText(""))} />
      )}
    </View>
  );
}
