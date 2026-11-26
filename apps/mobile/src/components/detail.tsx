import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Image, Pressable, ScrollView, TextInput as RNTextInput, useWindowDimensions, View, type TextStyle } from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  OMP_MODEL_ROLES,
  OMP_QUICK_ROLE_CHIPS,
  PUT_LIMITS,
  applyTerminalModelFallback,
  buildHarnessSwitchCommands,
  clampThinkingLevel,
  findModelOptionForModel,
  inferAgentModelAndThinking,
  isNonReasoningModelName,
  normalizeChoiceLabel,
  normalizeSwitchHarness,
  parseModelSwitchText,
  resolveThinkingLevelsForModel,
  sameMessage,
  stripModelEffortSuffix,
  synthesizeFallbackAgentModels,
  type Agent,
  type AgentModelsResult,
  type AgentUsageReport,
  type ConvEvent,
  type OmpModelRole,
  type TerminalStreamParams,
} from "@herdr-pocket/protocol";
import { loadAssistant, sendToAssistant, useAssistant } from "../lib/assistant";
import { call, subscribe, type RelayError } from "../lib/relay";
import { addPictures, canPickImages, pickImages, type Attachment } from "../lib/attach";
import { clearMobileDraft, getMobileDraft, hydrateMobileDrafts, onDraftsHydrated, setMobileDraftPictures, setMobileDraftText } from "../lib/drafts";
import {
  cancelMobilePendingSwitch,
  enqueueMobilePrompt,
  ensureMobileQueueWatcher,
  interruptAndSendMobileQueuedPrompt,
  moveMobileQueuedPromptToTop,
  popMobileQueuedPromptForEdit,
  removeMobileQueuedPrompt,
  scheduleMobilePendingSwitch,
  steerMobileQueuedPromptNow,
  useMobileQueue,
} from "../lib/chatQueue";
import { onQueueEvent, sendOut } from "../lib/outbox";
import { chunks, typingDiff } from "../lib/typing";
import { useLive, usePending, useSettings } from "../lib/store";
import { normalizeTermKeyLayout, TERM_KEYS, visibleTermKeys } from "../lib/termkeys";
import { compactNum, money, relTime, shortPath } from "../lib/format";
import { TERM_BG, TERM_FG } from "../lib/ansi";
import { TermScreen, type ScreenView, type ShownRow } from "../lib/termscreen";
import { harnessLook } from "../lib/harness";
import { parseChoices, type Choice } from "../lib/choices";
import { BUILTIN_SLASH, builtinSlashCommands, extractSlashQuery, matchSlashCommands, mergeSlashCommands, slashCommandIconKind, type SlashIconKind } from "../lib/slashCommands";
import { ModelBrandIcon } from "./ModelBrandIcon";

function mobileSlashGlyph(kind: SlashIconKind): keyof typeof MaterialCommunityIcons.glyphMap {
  switch (kind) {
    case "usage":
      return "gauge";
    case "context":
      return "layers-outline";
    case "help":
      return "help-circle-outline";
    case "keyboard":
      return "keyboard-outline";
    case "status":
      return "pulse";
    case "clear":
      return "eraser";
    case "compact":
      return "arrow-collapse-vertical";
    case "new":
      return "plus-circle-outline";
    case "history":
      return "history";
    case "branch":
      return "source-branch";
    case "share":
      return "share-variant-outline";
    case "exit":
      return "logout";
    case "model":
      return "cpu-64-bit";
    case "speed":
      return "lightning-bolt-outline";
    case "shield":
      return "shield-check-outline";
    case "memory":
      return "brain";
    case "auth":
      return "account-check-outline";
    case "settings":
      return "cog-outline";
    case "plan":
      return "compass-outline";
    case "review":
      return "magnify";
    case "git":
      return "source-commit";
    case "mcp":
      return "power-plug-outline";
    case "browser":
      return "web";
    case "schedule":
      return "clock-outline";
    case "workspace":
      return "folder-open-outline";
    case "goal":
      return "target";
    case "agents":
      return "robot-outline";
    case "skill":
      return "creation-outline";
    case "custom":
    default:
      return "tune-variant";
  }
}
import { usePalette } from "../theme/theme";
import { agentStatusLabel, fonts, radius, space, statusColors } from "../theme/tokens";
import { computeComposerBarMetrics, computePopupMaxHeight, horizontalPad } from "../lib/layoutMetrics";
import { useKeyboardState } from "../lib/useKeyboardState";
import { TermKeyboard } from "./TermKeyboard";
import { EmptyState, IconTile, PocketToast, SendPill } from "./ui";
import { PocketButton, PocketCheck, PocketDialog, PocketProgress, PocketSpinner, RowAction, type PocketIcon } from "./pocket";

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const TERM_PAD = 12;
const READ_SIZE = 12.5;
const EMPTY_MOBILE_QUEUE: ReturnType<typeof useMobileQueue.getState>["byAgent"][string] = [];

interface MobileBtwCard {
  id: string;
  question: string;
  status: "loading" | "streaming" | "done" | "error";
  answer?: string;
  error?: string;
  model?: string;
  durationMs?: number;
}

function formatBtwDuration(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function clipBtwText(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function formatMobileBtwTranscript(events: readonly ConvEvent[], maxChars = 40_000): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.partial) continue;
    if (ev.kind === "user_message" && !ev.synthetic && ev.text?.trim()) {
      lines.push(`USER: ${clipBtwText(ev.text, 4000)}`);
    } else if (ev.kind === "assistant_message" && ev.text?.trim()) {
      lines.push(`ASSISTANT: ${clipBtwText(ev.text, 4000)}`);
    } else if (ev.kind === "tool_call" && ev.name?.trim()) {
      let detail = "";
      try {
        detail = clipBtwText(typeof ev.input === "string" ? ev.input : JSON.stringify(ev.input ?? ""), 300);
      } catch {
        detail = "";
      }
      lines.push(detail ? `TOOL: ${ev.name} ${detail}` : `TOOL: ${ev.name}`);
    } else if (ev.kind === "tool_result" && ev.is_error) {
      lines.push("TOOL RESULT: failed");
    }
  }
  const picked: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    size += line.length + 1;
    if (size > maxChars) {
      picked.push("[earlier conversation omitted]");
      break;
    }
    picked.push(line);
  }
  return picked.reverse().join("\n");
}

function stripMobileAnsiTail(raw: string, maxLines = 180): string {
  if (!raw) return "";
  const clean = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
  return clean
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0)
    .slice(-maxLines)
    .join("\n");
}

/** Per-font-size cell metrics, measured once from the real fonts (mono cell, CJK fallback glyph). */
function useCellMetrics() {
  const [m, setM] = useState<{ cell: number; cjk: number } | null>(null);
  const probe = (
    <View pointerEvents="none" style={{ position: "absolute", opacity: 0, left: -9999, top: 0 }}>
      <ScrollView horizontal>
        <View>
          <Text style={{ fontFamily: fonts.mono, fontSize: 20 }} onTextLayout={(e) => setM((x) => ({ cjk: x?.cjk ?? 20, cell: (e.nativeEvent.lines[0]?.width ?? 120) / 10 / 20 }))}>
            MMMMMMMMMM
          </Text>
          <Text style={{ fontFamily: fonts.mono, fontSize: 20 }} onTextLayout={(e) => setM((x) => ({ cell: x?.cell ?? 0.6, cjk: (e.nativeEvent.lines[0]?.width ?? 200) / 10 / 20 }))}>
            中中中中中中中中中中
          </Text>
        </View>
      </ScrollView>
    </View>
  );
  // Ratios per 1pt of font size; fall back to Maple Mono-ish values until measured.
  return { cellRatio: m?.cell ?? 0.6, cjkRatio: m?.cjk ?? 1, probe };
}

/** Queue notices ride every terminal stream; the open terminal hands them to the message box. */
const queueListeners = new Map<string, Set<(event: any) => void>>();
function onQueue(agentKey: string, fn: (event: any) => void): () => void {
  const set = queueListeners.get(agentKey) ?? new Set();
  queueListeners.set(agentKey, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size) queueListeners.delete(agentKey);
  };
}

/** One terminal line. Rendered again only when its own content (or the font) changes. */
const TermRow = memo(function TermRow({ row, style, wideGap }: { row: ShownRow; style: TextStyle; wideGap: number }) {
  return (
    <Text selectable style={style}>
      {row.runs.map((r, j) => (
        <Text
          key={j}
          style={{
            color: r.fg,
            backgroundColor: r.bg,
            fontFamily: r.bold ? fonts.monoBold : fonts.mono,
            fontStyle: r.italic ? "italic" : "normal",
            textDecorationLine: r.underline ? "underline" : "none",
            letterSpacing: r.wide ? wideGap : 0,
          }}
        >
          {r.text}
        </Text>
      ))}
    </Text>
  );
});

/** Lines keyed by an id that moves with them, so a scroll mounts the new lines and moves the rest. */
const TermRows = memo(function TermRows({ view, style, wideGap }: { view: ScreenView; style: TextStyle; wideGap: number }) {
  return (
    <View>
      {view.rows.map((r) => (
        <TermRow key={r.id} row={r.row} style={style} wideGap={wideGap} />
      ))}
    </View>
  );
});

type LiveState = "connecting" | "live" | "stale" | "error";

export function TerminalView({ agent, active }: { agent: Agent; active: boolean }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width: winWidth } = useWindowDimensions();
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const [width, setWidth] = useState(0);
  const [modePick, setMode] = useState<"fit" | "read" | null>(null);
  const [zoom, setZoom] = useState(READ_SIZE);
  const [liveState, setLiveStateNow] = useState<LiveState>("connecting");
  const liveRef = useRef<LiveState>("connecting");
  const setLiveState = useCallback((s: LiveState) => {
    if (liveRef.current === s) return;
    liveRef.current = s;
    setLiveStateNow(s);
  }, []);
  /** A screen came on the current stream. */
  const [gotLive, setGotLive] = useState(false);
  const gotLiveRef = useRef(false);
  /** The stream gave nothing for a while after subscribing. */
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const pinch = useRef<{ d: number; size: number } | null>(null);
  const busy = agent.status === "working" || agent.status === "blocked";
  const [screen] = useState(() => new TermScreen());
  const [view, setView] = useState<ScreenView | null>(null);
  const frame = useRef<number | null>(null);
  // However many paints arrive, the view renders at most once per display frame, with the latest.
  const show = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setView(screen.view());
    });
  }, [screen]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  // Polling is the recovery path: only while the stream is down or has not delivered yet.
  const poll = active && (liveState === "error" || liveState === "stale" || (!gotLive && slow));
  const q = useQuery({
    queryKey: ["terminal.read", agent.key],
    queryFn: () => call(agent.deviceId, "terminal.read", { agent: agent.key, lines: 120 }),
    enabled: poll,
    staleTime: 10_000,
    refetchInterval: poll ? (busy ? 5000 : 12000) : false,
    retry: 1,
  });
  useEffect(() => {
    // A polled (or cached) screen only while the stream has given nothing newer.
    if (!q.data || (gotLiveRef.current && liveRef.current === "live")) return;
    screen.screen(q.data);
    show();
  }, [q.data, screen, show]);
  useEffect(() => {
    if (!active) return;
    setLiveState("connecting");
    gotLiveRef.current = false;
    setGotLive(false);
    setSlow(false);
    screen.restart();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number) => {
      retry ??= setTimeout(() => setAttempt((n) => n + 1), ms);
    };
    const slowTimer = setTimeout(() => setSlow(true), 1500);
    const got = () => {
      if (!gotLiveRef.current) {
        gotLiveRef.current = true;
        setGotLive(true);
      }
      setLiveState("live");
      show();
    };
    const params: TerminalStreamParams = { agent: agent.key, history: 120, rows: true };
    const stop = subscribe(
      agent.deviceId,
      "terminal",
      params,
      (event) => {
        if (event?.kind === "terminal_rows") {
          // A missed change: subscribe again, which starts with a whole screen.
          if (screen.rows(event)) got();
          else again(0);
        } else if (event?.kind === "terminal" && event.screen) {
          // Computers before row changes send the whole screen each time.
          screen.screen(event.screen);
          got();
        } else if (event?.kind === "stale") setLiveState("stale");
        else if (event?.kind === "queue") queueListeners.get(agent.key)?.forEach((fn) => fn(event));
      },
      (state) => {
        if (state.status === "open") {
          failures.current = 0;
          setLiveState("live");
        } else {
          // Refused or ended (the computer went away): poll meanwhile and try the stream again.
          setLiveState("error");
          again(Math.min(30_000, 3000 * 2 ** failures.current++));
        }
      },
    );
    // An unchanged screen sends nothing: silence is not a lost stream.
    return () => {
      clearTimeout(retry);
      clearTimeout(slowTimer);
      stop();
    };
  }, [active, agent.deviceId, agent.key, attempt, screen, show, setLiveState]);
  const linkOnline = useLive((s) => s.link === "online");
  const shown: LiveState = !linkOnline ? "stale" : liveState;
  const { cellRatio, cjkRatio, probe } = useCellMetrics();
  const cols = Math.max(view?.cols ?? 0, view?.widest ?? 0, 20);
  // Wide terminals (e.g. 191 cols) are unreadable when squeezed: default to readable size + horizontal scroll.
  const mode = modePick ?? (cols <= 100 ? "fit" : "read");
  const fitSize = width ? Math.max(5, Math.min(16, (width - TERM_PAD * 2) / (cols * cellRatio))) : READ_SIZE;
  const fontSize = mode === "fit" ? fitSize : zoom;
  const cellW = fontSize * cellRatio;
  // Wide chars render in the system CJK font; pad each to exactly two mono cells.
  const wideGap = 2 * cellW - fontSize * cjkRatio;
  const lineHeight = Math.round(fontSize * 1.38);
  const rowStyle = useMemo<TextStyle>(() => ({ fontFamily: fonts.mono, fontSize, lineHeight, height: lineHeight, color: TERM_FG }), [fontSize, lineHeight]);

  useEffect(() => {
    if (follow) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: false }));
  }, [follow, fontSize]);

  if (!view && q.isError) {
    return <EmptyState mood="waiting" title="终端画面没拿到" body={(q.error as Error).message} action={<PocketButton variant="soft" icon="refresh" onPress={() => void q.refetch()}>再试一次</PocketButton>} />;
  }
  if (!view) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm }}>
        <PocketSpinner size={24} />
        <Text style={{ color: p.faint, fontSize: 12 }}>正在接收终端画面…</Text>
      </View>
    );
  }
  const empty = view.rows.length === 0;
  const termBaseMargin = winWidth < 360 ? 10 : winWidth < 380 ? 12 : space.lg;
  const termMarginL = horizontalPad(termBaseMargin, insets.left);
  const termMarginR = horizontalPad(termBaseMargin, insets.right);
  return (
    <View
      style={{ flex: 1, marginLeft: termMarginL, marginRight: termMarginR, marginTop: space.md, marginBottom: space.sm, borderRadius: radius.card, backgroundColor: TERM_BG, overflow: "hidden" }}
      onTouchStart={(e) => {
        const t = e.nativeEvent.touches;
        if (t.length === 2) pinch.current = { d: Math.hypot(t[0]!.pageX - t[1]!.pageX, t[0]!.pageY - t[1]!.pageY), size: fontSize };
      }}
      onTouchMove={(e) => {
        const t = e.nativeEvent.touches;
        if (t.length !== 2 || !pinch.current) return;
        const d = Math.hypot(t[0]!.pageX - t[1]!.pageX, t[0]!.pageY - t[1]!.pageY);
        const next = Math.round(Math.max(5, Math.min(22, (pinch.current.size * d) / pinch.current.d)) * 2) / 2;
        if (next !== zoom || mode !== "read") {
          setMode("read");
          setZoom(next);
        }
      }}
      onTouchEnd={(e) => {
        if (e.nativeEvent.touches.length < 2) pinch.current = null;
      }}
    >
      {probe}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: winWidth < 360 ? space.md : space.lg, paddingRight: space.xs, minHeight: 44, backgroundColor: "#211B2C" }}>
        <Text style={{ flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 12, color: "#CFC5DA" }} numberOfLines={1}>
          {agent.localId} · {agent.where ?? agent.harness}
          {view.cols ? `  ${view.cols}×${view.height ?? view.rows.length}` : ""}
        </Text>
        <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 4 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: shown === "live" ? "#5ED6A7" : shown === "stale" ? "#F0B85A" : "#E9819E" }} />
            <Text style={{ color: "#CFC5DA", fontSize: 10 }}>{shown === "live" ? "实时" : shown === "stale" ? "重连中" : shown === "connecting" ? "连接中" : "轮询"}</Text>
          </View>
          {q.isFetching ? <PocketSpinner size={12} color="#CFC5DA" style={{ marginRight: 8 }} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === "fit" ? "切换到正常字号，可以左右滑动" : "切换到适应宽度"}
            onPress={() => {
              if (mode === "fit") {
                setZoom(READ_SIZE);
                setMode("read");
              } else setMode("fit");
            }}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 36, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: pressed ? "#3A3148" : "#2C2439" })}
          >
            <MaterialCommunityIcons name={mode === "fit" ? "arrow-expand-horizontal" : "format-size"} size={15} color="#EDE6F3" />
            <Text style={{ color: "#EDE6F3", fontSize: 12, fontFamily: fonts.bodySemi }}>{mode === "fit" ? "适应宽度" : `${fontSize} 号字`}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? "已复制" : "复制终端内容"}
            onPress={async () => {
              await Clipboard.setStringAsync(screen.plain());
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? "#3A3148" : "transparent" })}
          >
            <MaterialCommunityIcons name={copied ? "check" : "content-copy"} size={18} color="#EDE6F3" />
          </Pressable>
        </View>
      </View>
      <ScrollView
        ref={scroller}
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          // A keyboard opening below shrinks the screen: keep the newest lines in view.
          if (follow) requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: false }));
        }}
        // Only when the content grows or shrinks: a scroll of a full history keeps its height and stays at the bottom.
        onContentSizeChange={() => {
          if (follow) scroller.current?.scrollToEnd({ animated: false });
        }}
        onScrollBeginDrag={() => setFollow(false)}
        onMomentumScrollEnd={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          setFollow(contentOffset.y + layoutMeasurement.height >= contentSize.height - 24);
        }}
        contentContainerStyle={{ paddingVertical: TERM_PAD }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={mode !== "fit"} contentContainerStyle={{ paddingHorizontal: TERM_PAD }}>
          {empty ? <Text style={rowStyle}>（屏幕是空的）</Text> : <TermRows view={view} style={rowStyle} wideGap={wideGap} />}
        </ScrollView>
      </ScrollView>
      {!follow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="跳到最新"
          onPress={() => setFollow(true)}
          style={{ position: "absolute", right: space.md, bottom: space.md, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: p.lavenderContainer, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 40 }}
        >
          <MaterialCommunityIcons name="arrow-collapse-down" size={16} color={p.onLavender} />
          <Text style={{ fontFamily: fonts.bodyBold, color: p.onLavender, fontSize: 13.5 }}>到最新</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Waiting card (docked above the composer when the agent is blocked)
// ---------------------------------------------------------------------------

/**
 * Last lines on the agent's screen, so the question it is asking can be read
 * without leaving the chat, and the options it offers (`parseChoices`).
 */
function useScreenTail(agent: Agent, enabled: boolean, lines = 7): { tail: string[]; choices: Choice[] } {
  const q = useQuery({
    queryKey: ["terminal.tail", agent.key],
    queryFn: () => call(agent.deviceId, "terminal.read", { agent: agent.key, lines: 40 }),
    enabled,
    refetchInterval: enabled ? 4000 : false,
    retry: false,
  });
  return useMemo(() => {
    const all = (q.data?.text ?? "").split("\n").map((l) => l.replace(/\s+$/, ""));
    while (all.length && !all[all.length - 1]!.trim()) all.pop();
    const choices = parseChoices(all);
    return { tail: all.filter((l, i) => l.trim() || (i > 0 && all[i - 1]!.trim())).slice(-lines), choices };
  }, [q.data?.text, lines]);
}

function WaitingCard({
  agent,
  onKey,
  onRetry,
  busy,
  compact,
  onOpenTerminal,
  marginLeft = space.lg,
  marginRight = space.lg,
}: {
  agent: Agent;
  onKey: (key: string) => void;
  onRetry: () => void;
  busy: boolean;
  compact: boolean;
  onOpenTerminal?: () => void;
  marginLeft?: number;
  marginRight?: number;
}) {
  const p = usePalette();
  const c = statusColors("blocked", p.dark);
  // Read even beside the terminal: the options decide which keys the buttons press.
  const { tail, choices } = useScreenTail(agent, !agent.errored);
  if (agent.errored) {
    // Stopped on an error, not on a question: y / n mean nothing to it.
    return (
      <View accessibilityLiveRegion="polite" style={{ marginLeft, marginRight, marginBottom: space.sm, backgroundColor: c.bg, borderRadius: radius.card, padding: space.md, gap: space.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <MaterialCommunityIcons name="alert-circle-outline" size={18} color={c.fg} />
          <Text style={{ flex: 1, minWidth: 0, fontFamily: fonts.cute, fontSize: 16, color: c.fg }}>它出错停下了</Text>
        </View>
        {agent.statusNote ? (
          <Text selectable numberOfLines={compact ? 2 : 6} style={{ fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: p.ink }}>
            {agent.statusNote}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Pressable
            disabled={busy}
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel="让它继续：发送“继续”"
            style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 40, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.accentText : p.primary, opacity: busy ? 0.5 : 1 })}
          >
            <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.onPrimary }}>让它继续</Text>
          </Pressable>
          {!compact && onOpenTerminal ? (
            <Pressable
              onPress={onOpenTerminal}
              accessibilityRole="button"
              style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 40, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : p.surface })}
            >
              <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.ink }}>看终端</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }
  const choice = (o: Choice) => {
    const clean = normalizeChoiceLabel(o.label);
    return (
      <Pressable
        key={o.key}
        disabled={busy}
        onPress={() => onKey(o.key)}
        accessibilityRole="button"
        accessibilityLabel={`选第 ${o.key} 项：${clean.title}`}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          minHeight: 40,
          paddingHorizontal: space.md,
          paddingVertical: 6,
          borderRadius: radius.md,
          backgroundColor: pressed ? (o.selected ? p.accentText : p.surface3) : o.selected ? p.primary : p.surface,
          opacity: busy ? 0.5 : 1,
        })}
      >
        <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13, color: o.selected ? p.onPrimary : c.fg, minWidth: 14 }}>{o.key}</Text>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={2} style={{ fontFamily: fonts.bodySemi, fontSize: 13.5, color: o.selected ? p.onPrimary : p.ink }}>
            {clean.title}
          </Text>
          {clean.description ? (
            <Text numberOfLines={1} style={{ fontSize: 11.5, color: o.selected ? p.onPrimary : p.muted, opacity: o.selected ? 0.9 : 1 }}>
              {clean.description}
            </Text>
          ) : null}
        </View>
        {clean.recommended ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: radius.pill,
              backgroundColor: o.selected ? "rgba(255,255,255,0.22)" : p.accentContainer,
            }}
          >
            <Text style={{ fontSize: 10.5, fontFamily: fonts.bodyBold, color: o.selected ? p.onPrimary : p.accentText }}>
              推荐
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  };
  const answer = (label: string, key: string, a11y: string, primary = false) => (
    <Pressable
      key={key}
      disabled={busy}
      onPress={() => onKey(key)}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        minHeight: 40,
        paddingHorizontal: 6,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary ? (pressed ? p.accentText : p.primary) : pressed ? p.surface3 : p.surface,
        opacity: busy ? 0.5 : 1,
      })}
    >
      <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 13, color: primary ? p.onPrimary : p.ink }}>{label}</Text>
    </Pressable>
  );
  return (
    <View accessibilityLiveRegion="polite" style={{ marginLeft, marginRight, marginBottom: space.sm, backgroundColor: c.bg, borderRadius: radius.card, padding: space.md, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <MaterialCommunityIcons name="hand-wave-outline" size={18} color={c.fg} />
        <Text style={{ flex: 1, minWidth: 0, fontFamily: fonts.cute, fontSize: 16, color: c.fg }}>它在等你回复</Text>
        {!compact && onOpenTerminal ? (
          <Pressable hitSlop={8} accessibilityRole="button" onPress={onOpenTerminal} style={{ flexShrink: 0 }}>
            <Text style={{ color: c.fg, fontFamily: fonts.bodySemi, fontSize: 12.5 }}>看终端</Text>
          </Pressable>
        ) : null}
      </View>
      {agent.statusNote ? (
        <Text selectable style={{ fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: p.ink }}>
          {agent.statusNote}
        </Text>
      ) : null}
      {!compact && tail.length && !choices.length ? (
        <Pressable accessibilityLabel="它屏幕上最后几行，点按去终端" onPress={onOpenTerminal} style={{ backgroundColor: TERM_BG, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm }}>
          {tail.map((l, i) => (
            <Text key={i} numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11, lineHeight: 16, color: TERM_FG }}>
              {l || " "}
            </Text>
          ))}
        </Pressable>
      ) : null}
      {choices.length ? (
        <View style={{ gap: 6 }}>
          {choices.slice(0, compact ? 4 : 9).map(choice)}
          <View style={{ flexDirection: "row", gap: 6 }}>
            {answer("回车", "enter", "按回车选高亮的那项")}
            {answer("Esc", "esc", "按 Esc 取消")}
          </View>
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 6 }}>
          {answer("是 y", "y", `同意，发送 y 给 ${agent.harness}`, true)}
          {answer("否 n", "n", "拒绝，发送 n")}
          {answer("回车", "enter", "按回车确认当前选项")}
          {answer("Esc", "esc", "按 Esc 取消")}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/** Show / hide and reorder the accessory keys (saved). */
function KeyLayoutDialog({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const p = usePalette();
  const saved = useSettings((x) => x.termKeys);
  const set = useSettings((x) => x.set);
  const layout = normalizeTermKeyLayout(saved);
  const byId = new Map(TERM_KEYS.map((k) => [k.id, k]));
  const save = (order: string[], visible: string[]) => set({ termKeys: { order, visible: order.filter((id) => visible.includes(id)) } });
  const move = (idx: number, d: -1 | 1) => {
    const order = [...layout.order];
    const to = idx + d;
    if (to < 0 || to >= order.length) return;
    [order[idx], order[to]] = [order[to]!, order[idx]!];
    save(order, layout.visible);
  };
  return (
    <PocketDialog
      visible={visible}
      onDismiss={onDismiss}
      title="调整按键"
      scroll
      actions={[
        { label: "恢复默认", onPress: () => set({ termKeys: null }), tone: "ghost" },
        { label: "好了", onPress: onDismiss },
      ]}
    >
      {layout.order.map((id, idx) => {
        const k = byId.get(id)!;
        const on = layout.visible.includes(id);
        return (
          <View key={id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.sm, minHeight: 50 }}>
            <PocketCheck checked={on} onChange={() => save(layout.order, on ? layout.visible.filter((x) => x !== id) : [...layout.visible, id])} label={`${on ? "隐藏" : "显示"} ${k.a11y}`} />
            <Text style={{ flex: 1, color: p.ink, fontFamily: k.mono ? fonts.mono : fonts.body, fontSize: 15, paddingLeft: space.xs }}>{k.label}</Text>
            <RowAction icon="arrow-up" disabled={idx === 0} onPress={() => move(idx, -1)} a11y={`${k.a11y} 上移`} />
            <RowAction icon="arrow-down" disabled={idx === layout.order.length - 1} onPress={() => move(idx, 1)} a11y={`${k.a11y} 下移`} />
          </View>
        );
      })}
    </PocketDialog>
  );
}

/**
 * Typing straight into the terminal: an invisible box holds the keyboard, and
 * every change goes to the terminal at once, so what is typed shows up on the
 * terminal screen itself. Hosts without `terminal.input` report `unsupported`.
 */
function useDirectTyping(agent: Agent, onError: (message: string, unsupported: boolean) => void) {
  const box = useRef<ComponentRef<typeof RNTextInput>>(null);
  const line = useRef("");
  const out = useRef({ queue: "", busy: false });
  const [on, setOn] = useState(false);

  async function flush() {
    const o = out.current;
    if (o.busy) return;
    o.busy = true;
    while (o.queue) {
      const data = o.queue;
      o.queue = "";
      try {
        for (const piece of chunks(data)) await call(agent.deviceId, "terminal.input", { agent: agent.key, data: piece });
      } catch (e) {
        o.queue = "";
        const err = e as RelayError;
        onError(err.message, err.code === "unsupported");
        if (err.code === "unsupported") box.current?.blur();
        break;
      }
    }
    o.busy = false;
  }
  function push(data: string) {
    if (!data) return;
    out.current.queue += data;
    void flush();
  }
  const input = (
    <RNTextInput
      ref={box}
      onChangeText={(v) => {
        push(typingDiff(line.current, v));
        line.current = v;
      }}
      onKeyPress={(e) => {
        // Deleting past what was typed here still reaches the terminal.
        if (e.nativeEvent.key === "Backspace" && line.current === "") push("\x7f");
      }}
      onSubmitEditing={() => {
        push("\r");
        line.current = "";
        box.current?.clear();
      }}
      submitBehavior="submit"
      onFocus={() => setOn(true)}
      onBlur={() => setOn(false)}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      caretHidden
      accessibilityLabel="直接输入到终端"
      style={{ position: "absolute", left: 0, bottom: 0, width: 1, height: 1, opacity: 0 }}
    />
  );
  const start = useCallback(() => {
    // The phone's own key panel may have typed in between: start the line afresh.
    line.current = "";
    box.current?.clear();
    box.current?.focus();
  }, []);
  const stop = useCallback(() => box.current?.blur(), []);
  return { on, input, start, stop, push };
}

/**
 * `chat`: a message box (keys behind a toggle). `terminal`: the key bar only, so the screen gets the room;
 * the keyboard button types straight into the terminal (older hosts: a one-line box).
 */
export function Composer({
  agent,
  bottomInset,
  mode,
  onOpenTerminal,
  hasReasoningEvents,
}: {
  agent: Agent;
  bottomInset: number;
  mode: "chat" | "terminal";
  onOpenTerminal?: () => void;
  hasReasoningEvents?: boolean;
}) {
  const p = usePalette();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { keyboardOpen, keyboardHeight } = useKeyboardState();
  const [text, setTextState] = useState(() => getMobileDraft(agent.key).text);
  /** Pictures to go with the next message (chat only). */
  const [pictures, setPicturesState] = useState<Attachment[]>(() => getMobileDraft(agent.key).pictures);
  const draftKeyRef = useRef(agent.key);
  draftKeyRef.current = agent.key;
  const setText = useCallback((next: string | ((prev: string) => string)) => {
    setTextState((prev) => {
      const val = typeof next === "function" ? next(prev) : next;
      setMobileDraftText(draftKeyRef.current, val);
      return val;
    });
  }, []);
  const setPictures = useCallback((next: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
    setPicturesState((prev) => {
      const val = typeof next === "function" ? next(prev) : next;
      setMobileDraftPictures(draftKeyRef.current, val);
      return val;
    });
  }, []);
  const [picking, setPicking] = useState(false);
  const [extra, setExtra] = useState(false);
  const lastSendRef = useRef<{ sig: string; at: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** The host cannot take direct typing: fall back to the one-line box. */
  const [boxOnly, setBoxOnly] = useState(false);
  /** The phone's own key panel is open (terminal only). */
  const [pad, setPad] = useState(false);
  const termInput = useSettings((x) => x.termInput);
  const setSettings = useSettings((x) => x.set);
  const direct = useDirectTyping(agent, (message, unsupported) => {
    if (unsupported) {
      setBoxOnly(true);
      setExtra(true);
      setPad(false);
      setToast("这台电脑的 hostd 还不支持直接打字，先用输入框发送");
    } else setToast(message);
  });
  // Switching between chat and terminal folds the extras and puts the keyboard away.
  const [shownMode, setShownMode] = useState(mode);
  if (shownMode !== mode) {
    setShownMode(mode);
    setExtra(false);
    setPad(false);
  }
  const stopDirect = direct.stop;
  useEffect(() => stopDirect, [mode, stopDirect]);
  const showKeys = mode === "terminal" || extra;
  const showInput = mode === "chat" || (extra && boxOnly);
  /** A key press or "让它继续" on its way (messages go out on their own, see lib/outbox). */
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopAgent = useCallback(() => {
    if (stopping) return;
    setStopping(true);
    void call(agent.deviceId, "terminal.interrupt", { agent: agent.key })
      .catch(() => undefined)
      .finally(() => setStopping(false));
  }, [agent.deviceId, agent.key, stopping]);
  /** This phone's messages that wait in the agent's input box: their bubbles say "排队中" already. */
  const mineWaiting = usePending((s) => (s.byAgent[agent.key] ?? []).filter((x) => x.state === "queued" && x.waiting && !x.echo).length);
  useEffect(() => {
    ensureMobileQueueWatcher();
  }, []);
  const queued = useMobileQueue((s) => s.byAgent[agent.key] ?? EMPTY_MOBILE_QUEUE);
  const pendingSwitch = useMobileQueue((s) => s.pendingSwitchByAgent[agent.key]);
  const isSteering = useMobileQueue((s) => Boolean(s.steering[agent.key]));
  const hostHeldCount = Math.max(0, (agent.queued ?? 0) - mineWaiting);
  const rawTerminalQueued = agent.queuedItems?.length
    ? agent.queuedItems
    : hostHeldCount > 0 && agent.queuedText
      ? [agent.queuedText]
      : [];
  const terminalQueuedItems = rawTerminalQueued.filter(
    (item) => item.trim() && !queued.some((q) => sameMessage(item, q.text)),
  );
  const totalQueued = queued.length + Math.max(hostHeldCount, terminalQueuedItems.length);
  const textScale = useSettings((x) => x.textScale);
  const [tuning, setTuning] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageData, setUsageData] = useState<AgentUsageReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [quotaTab, setQuotaTab] = useState<string>("");
  const [modelOpen, setModelOpen] = useState<false | "model" | "thinking">(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelData, setModelData] = useState<AgentModelsResult | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [modelOverride, setModelOverride] = useState<string | undefined>(undefined);
  const [thinkingOverride, setThinkingOverride] = useState<string | undefined>(undefined);
  const [ompTab, setOmpTab] = useState<"session" | "roles">("session");
  const [editingRole, setEditingRole] = useState<OmpModelRole | null>(null);
  const [btwCardsByAgent, setBtwCardsByAgent] = useState<Record<string, MobileBtwCard | undefined>>({});
  const [btwCopiedId, setBtwCopiedId] = useState<string | null>(null);
  const btwGenRef = useRef<Record<string, string>>({});
  const btwCancelRef = useRef<Record<string, () => void>>({});
  const activeBtwCard = mode === "chat" ? btwCardsByAgent[agent.key] : undefined;
  const isBtwDraft = mode === "chat" && !pictures.length && /^\/btw(?:\s|$)/i.test(text.trim());

  useEffect(() => {
    return () => {
      Object.values(btwCancelRef.current).forEach((cancel) => cancel());
      btwCancelRef.current = {};
    };
  }, []);

  useEffect(() => {
    void hydrateMobileDrafts();
    const unsub = onDraftsHydrated(() => {
      const d = getMobileDraft(agent.key);
      if (d.text) setTextState((cur) => cur || d.text);
    });
    const d = getMobileDraft(agent.key);
    setTextState(d.text);
    setPicturesState(d.pictures);
    setUsageOpen(false);
    setUsageData(null);
    setUsageError(null);
    setModelOpen(false);
    setModelData(null);
    setModelError(null);
    setModelFilter("");
    setModelOverride(undefined);
    setThinkingOverride(undefined);
    setOmpTab("session");
    setEditingRole(null);
    return () => {
      unsub();
    };
  }, [agent.key]);

  useEffect(() => {
    setModelOverride(undefined);
    setThinkingOverride(undefined);
  }, [agent.key, agent.model]);
  const termKeys = useSettings((x) => x.termKeys);
  const keys = useMemo(() => visibleTermKeys(normalizeTermKeyLayout(termKeys)), [termKeys]);
  const online = useLive((s) => s.devices[agent.deviceId]?.online ?? false);
  const allAgentsByHost = useLive((s) => s.agents);
  const isOmp = !agent.isShell && normalizeSwitchHarness(agent.harness) === "omp";
  const effectiveHasReasoning = useMemo(() => {
    if (hasReasoningEvents !== undefined) return hasReasoningEvents;
    const queries = qc.getQueriesData<{ events?: Array<{ kind?: string }> }>({
      queryKey: ["session.events", agent.key],
    });
    return queries.some(([, data]) => Array.isArray(data?.events) && data.events.some((e) => e.kind === "reasoning"));
  }, [hasReasoningEvents, qc, agent.key, modelOpen]);
  const peerModels = useMemo(() => {
    const targetHarness = normalizeSwitchHarness(agent.harness);
    const allowCross = targetHarness === "omp" || targetHarness === "pi" || targetHarness === "opencode" || targetHarness === "hermes" || targetHarness === "aider" || targetHarness === "goose";
    const same: string[] = [];
    const other: string[] = [];
    const seen = new Set<string>();
    const curClean = agent.model ? stripModelEffortSuffix(agent.model).toLowerCase() : "";
    for (const list of Object.values(allAgentsByHost)) {
      for (const a of list) {
        if (a.isShell || !a.model?.trim()) continue;
        const clean = stripModelEffortSuffix(a.model);
        const low = clean.toLowerCase();
        if (!low || low === curClean || seen.has(low)) continue;
        seen.add(low);
        if (normalizeSwitchHarness(a.harness) === targetHarness) same.push(clean);
        else if (allowCross) other.push(clean);
      }
    }
    return [...same, ...other];
  }, [allAgentsByHost, agent.harness, agent.model]);
  const inferredMeta = useMemo(
    () =>
      agent.isShell
        ? {}
        : inferAgentModelAndThinking(agent.harness, modelOverride || agent.model, {
            hasReasoningEvents: effectiveHasReasoning,
            thinkingLevel: modelOverride ? undefined : agent.thinkingLevel,
          }),
    [agent.isShell, agent.harness, modelOverride, agent.model, agent.thinkingLevel, effectiveHasReasoning],
  );
  const fallbackModelData = useMemo(
    () =>
      synthesizeFallbackAgentModels(agent, peerModels, {
        hasReasoningEvents: effectiveHasReasoning,
        thinkingLevel: agent.thinkingLevel,
      }),
    [agent.harness, agent.model, agent.thinkingLevel, agent.isShell, agent.source, peerModels, effectiveHasReasoning],
  );
  const effectiveCurrentModel = modelOverride || modelData?.currentModel || inferredMeta.currentModel || agent.model;
  const resolvedLookupModel =
    isOmp && effectiveCurrentModel?.startsWith("@")
      ? stripModelEffortSuffix(modelData?.modelRoles?.[effectiveCurrentModel.slice(1).toLowerCase()] ?? effectiveCurrentModel)
      : effectiveCurrentModel;
  const effectiveModelOpt = useMemo(
    () =>
      findModelOptionForModel(modelData?.models, resolvedLookupModel, {
        harness: agent.harness,
        modelRoles: modelData?.modelRoles,
      }),
    [modelData?.models, modelData?.modelRoles, agent.harness, resolvedLookupModel],
  );
  const effectiveThinkingLevels = useMemo(() => {
    if (agent.isShell) return [];
    if (modelData) {
      return resolveThinkingLevelsForModel(
        {
          ...modelData,
          harness: modelData.harness || agent.harness,
          models: Array.isArray(modelData.models) ? modelData.models : [],
          hasReasoningEvents: effectiveHasReasoning,
        },
        effectiveCurrentModel,
      );
    }
    return inferredMeta.thinkingLevels ?? [];
  }, [agent.isShell, agent.harness, modelData, effectiveCurrentModel, effectiveHasReasoning, inferredMeta.thinkingLevels]);
  const effectiveCurrentThinking =
    effectiveThinkingLevels.length === 0
      ? ""
      : (
          clampThinkingLevel(
            effectiveThinkingLevels,
            thinkingOverride || modelData?.currentThinking || inferredMeta.currentThinking || agent.thinkingLevel,
          ) ?? ""
        ).toLowerCase();

  const loadModelsWithTerminalFallback = useCallback(async (): Promise<AgentModelsResult> => {
    const synth = synthesizeFallbackAgentModels(agent, peerModels, {
      hasReasoningEvents: effectiveHasReasoning,
      thinkingLevel: agent.thinkingLevel,
    });
    let base: AgentModelsResult;
    try {
      const res = await call(agent.deviceId, "agent.models", { agent: agent.key });
      if (res.models.length === 0) {
        base = {
          ...res,
          models: synth.models,
          ...(res.thinkingLevels?.length
            ? {}
            : synth.thinkingLevels?.length
              ? { thinkingLevels: synth.thinkingLevels, canSwitchThinking: res.canSwitch, thinkingLabel: "思考等级" }
              : {}),
        };
      } else {
        base = res;
      }
    } catch {
      base = synth;
    }

    const harness = base.harness || agent.harness;
    const baseModels = Array.isArray(base.models) ? base.models : [];
    const curModel = base.currentModel?.trim() || "";
    const matchedCur = curModel
      ? findModelOptionForModel(baseModels, curModel, { harness, modelRoles: base.modelRoles })
      : undefined;
    const curNonReasoning =
      matchedCur?.reasoning === false ||
      (matchedCur?.thinkingLevels !== undefined && matchedCur.thinkingLevels.length === 0) ||
      (curModel ? isNonReasoningModelName(curModel) : false);
    const missingModel = !curModel;
    const missingThinking = !base.currentThinking?.trim() && !curNonReasoning;
    if ((missingModel || missingThinking) && (agent.source === "hc" || agent.source === "herdr") && !agent.isShell) {
      const termRes = await call(agent.deviceId, "terminal.read", { agent: agent.key, lines: 24 }).catch(() => null);
      const screenText = termRes?.text || termRes?.ansi || "";
      if (screenText.trim()) {
        return applyTerminalModelFallback(base, harness, screenText, {
          thinkingLevel: agent.thinkingLevel,
          hasReasoningEvents: effectiveHasReasoning,
        });
      }
    }
    return base;
  }, [agent, peerModels, effectiveHasReasoning]);

  useEffect(() => {
    if (!online || agent.isShell || (agent.source !== "hc" && agent.source !== "herdr")) return;
    let alive = true;
    void loadModelsWithTerminalFallback().then((res) => {
      if (alive) setModelData(res);
    });
    return () => {
      alive = false;
    };
  }, [online, agent.deviceId, agent.key, agent.harness, agent.model, agent.thinkingLevel, agent.isShell, agent.source, loadModelsWithTerminalFallback]);
  const coral = statusColors("blocked", p.dark).fg;
  const slashQuery = mode === "chat" && !agent.isShell ? extractSlashQuery(text) : null;
  const cmdQ = useQuery({
    queryKey: ["agent.commands", agent.key],
    queryFn: () => call(agent.deviceId, "agent.commands", { agent: agent.key }),
    enabled: online && !agent.isShell && mode === "chat",
    staleTime: 30_000,
    retry: false,
  });
  const allSlashCommands = useMemo(() => {
    const builtins = builtinSlashCommands(agent.harness, agent.isShell);
    return mergeSlashCommands(builtins, cmdQ.data?.commands ?? []);
  }, [agent.harness, agent.isShell, cmdQ.data?.commands]);
  const slashMatches = useMemo(() => {
    if (slashQuery === null) return [];
    return matchSlashCommands(allSlashCommands, slashQuery);
  }, [allSlashCommands, slashQuery]);

  useEffect(() => {
    if (!online) return;
    // The computer's send queue moves the marks on the bubbles of messages sent from here.
    const onEvent = (event: any) => {
      if (event?.kind === "queue" && event.queueId) onQueueEvent(agent.key, event);
    };
    // The open terminal's stream carries them already; a second one would paint the whole screen again.
    if (mode === "terminal") return onQueue(agent.key, onEvent);
    // No screen needed. Computers before `screen: false` still send one; `history: 1` keeps it small
    // (they read a 0 as the default 120).
    const params: TerminalStreamParams = { agent: agent.key, screen: false, history: 1 };
    return subscribe(agent.deviceId, "terminal", params, onEvent);
  }, [agent.deviceId, agent.key, online, mode]);

  function refreshSoon() {
    setTimeout(() => {
      qc.invalidateQueries({ queryKey: ["terminal.read", agent.key] });
      qc.invalidateQueries({ queryKey: ["session.events", agent.key] });
    }, 1000);
  }

  const openUsageCard = useCallback(() => {
    setUsageOpen(true);
    setUsageLoading(true);
    setUsageError(null);
    void call(agent.deviceId, "agent.usage", { agent: agent.key })
      .then((res) => setUsageData(res))
      .catch((e) => setUsageError((e as Error).message || "读取用量失败"))
      .finally(() => setUsageLoading(false));
  }, [agent.deviceId, agent.key]);

  const openModelPicker = useCallback(
    (panelMode: "model" | "thinking" = "model", nextOmpTab: "session" | "roles" = "session") => {
      setModelOpen(panelMode);
      setOmpTab(nextOmpTab);
      setEditingRole(null);
      setModelFilter("");
      setModelLoading(true);
      setModelError(null);
      void loadModelsWithTerminalFallback()
        .then((res) => {
          setModelError(null);
          setModelData(res);
        })
        .finally(() => setModelLoading(false));
    },
    [loadModelsWithTerminalFallback],
  );

  function applyModelOrThinking(opts: { modelId?: string; thinkingLevel?: string }) {
    const cleanModel = opts.modelId?.trim();
    const cleanThinking = opts.thinkingLevel?.trim().toLowerCase();
    if (!cleanModel && !cleanThinking) return;
    const prevModelOverride = modelOverride;
    const prevThinkingOverride = thinkingOverride;
    setModelOpen(false);
    if (cleanModel) {
      const resolvedAlias =
        isOmp && cleanModel.startsWith("@")
          ? modelData?.modelRoles?.[cleanModel.slice(1).toLowerCase()]
          : undefined;
      const nextModelRaw = resolvedAlias || cleanModel;
      const nextModelClean = stripModelEffortSuffix(nextModelRaw);
      setModelOverride(nextModelClean);
      if (!cleanThinking) {
        const catalog = modelData ?? fallbackModelData;
        const nextLevels = resolveThinkingLevelsForModel(
          {
            ...catalog,
            harness: catalog.harness || agent.harness,
            models: Array.isArray(catalog.models) ? catalog.models : [],
            hasReasoningEvents: effectiveHasReasoning,
          },
          nextModelClean,
        );
        setThinkingOverride(clampThinkingLevel(nextLevels, effectiveCurrentThinking || undefined, nextModelRaw));
      }
    }
    if (cleanThinking) setThinkingOverride(cleanThinking);

    const desc = [cleanModel, cleanThinking ? `思考 ${cleanThinking}` : undefined].filter(Boolean).join(" · ");
    const plan = buildHarnessSwitchCommands(agent.harness, { modelId: cleanModel, thinkingLevel: cleanThinking });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    if (agent.status === "working") {
      scheduleMobilePendingSwitch(agent, {
        ...(cleanModel ? { modelId: cleanModel } : {}),
        ...(cleanThinking ? { thinkingLevel: cleanThinking } : {}),
        label: desc,
      });
      setToast(`本轮结束后将自动切换为 ${desc}`);
      return;
    }
    cancelMobilePendingSwitch(agent.key);
    void call(agent.deviceId, "agent.setModel", {
      agent: agent.key,
      ...(cleanModel ? { modelId: cleanModel } : {}),
      ...(cleanThinking ? { thinkingLevel: cleanThinking } : {}),
    })
      .then((res) => {
        if (res.currentModel) setModelOverride(res.currentModel);
        if (res.currentThinking) setThinkingOverride(res.currentThinking);
        setToast(res.note || `已切换：${desc}`);
        refreshSoon();
      })
      .catch(async (e: unknown) => {
        const err = e as { code?: string; message?: string };
        const rpcUnsupported = err?.code === "unsupported";
        if (rpcUnsupported && plan.commands.length > 0) {
          try {
            for (const cmd of plan.commands) {
              await call(agent.deviceId, "terminal.send", { agent: agent.key, text: cmd, enter: true });
            }
            setToast(`已下发切换指令：${desc}`);
            refreshSoon();
          } catch (fallbackErr) {
            setModelOverride(prevModelOverride);
            setThinkingOverride(prevThinkingOverride);
            setToast((fallbackErr as Error).message || "切换失败");
          }
        } else {
          setModelOverride(prevModelOverride);
          setThinkingOverride(prevThinkingOverride);
          setToast(err?.message || "切换失败");
        }
      });
  }

  function applyRoleModelChoice(slot: OmpModelRole, modelId: string) {
    const clean = modelId.trim();
    if (!clean) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    setModelData((cur) => {
      const base = cur ?? fallbackModelData;
      return {
        ...base,
        modelRoles: { ...(base.modelRoles ?? {}), [slot]: clean },
      };
    });
    setEditingRole(null);
    setModelFilter("");
    void call(agent.deviceId, "agent.setModel", {
      agent: agent.key,
      roleSlot: slot,
      modelId: clean,
    })
      .then((res) => {
        if (res.modelRoles) {
          setModelData((cur) => {
            const base = cur ?? fallbackModelData;
            return { ...base, modelRoles: res.modelRoles };
          });
        }
        setToast(res.note || `已更新 ${slot} 角色 -> ${clean}`);
      })
      .catch((e: unknown) => {
        const err = e as { message?: string };
        setToast(err?.message || `更新角色 ${slot} 失败`);
      });
  }

  function applyModelChoice(modelId: string) {
    applyModelOrThinking({ modelId });
  }

  function applyThinkingChoice(thinkingLevel: string) {
    const effortModel = effectiveModelOpt?.effortModelMap?.[thinkingLevel.toLowerCase()];
    applyModelOrThinking({
      ...(effortModel ? { modelId: effortModel } : {}),
      thinkingLevel,
    });
  }

  const dismissBtwCard = useCallback((targetKey = agent.key) => {
    btwCancelRef.current[targetKey]?.();
    delete btwCancelRef.current[targetKey];
    delete btwGenRef.current[targetKey];
    setBtwCardsByAgent((prev) => {
      if (!prev[targetKey]) return prev;
      const next = { ...prev };
      delete next[targetKey];
      return next;
    });
  }, [agent.key]);

  const runMobileBtw = useCallback(async (question: string) => {
    const targetKey = agent.key;
    const targetDevice = agent.deviceId;
    const targetTitle = agent.title || agent.name || agent.harness;
    const targetHarness = agent.harness;
    const targetStatus = agent.status;
    const startedAt = Date.now();
    const reqId = `btw-${startedAt}-${Math.random().toString(36).slice(2, 7)}`;

    btwCancelRef.current[targetKey]?.();
    delete btwCancelRef.current[targetKey];
    btwGenRef.current[targetKey] = reqId;

    const isCurrent = () => btwGenRef.current[targetKey] === reqId;
    const patchCard = (card: MobileBtwCard) => {
      if (!isCurrent()) return;
      setBtwCardsByAgent((prev) => ({ ...prev, [targetKey]: card }));
    };

    patchCard({ id: reqId, question, status: "loading" });

    try {
      const res = await call(targetDevice, "agent.btw", { agent: targetKey, question }, 90_000);
      if (res && typeof res.answer === "string" && res.answer.trim()) {
        patchCard({
          id: reqId,
          question,
          status: "done",
          answer: res.answer.trim(),
          model: res.model,
          durationMs: typeof res.durationMs === "number" ? res.durationMs : Math.max(1, Date.now() - startedAt),
        });
        return;
      }
      throw new Error("主机未返回旁路回答");
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const unsupported =
        err?.code === "unsupported" ||
        /unsupported|unknown method|method not found|未实现|不支持/i.test(err?.message ?? "");
      if (!unsupported) {
        patchCard({
          id: reqId,
          question,
          status: "error",
          error: err?.message || "旁路提问失败",
        });
        return;
      }
    }

    const eventsRes = await call(targetDevice, "session.events", { agent: targetKey, limit: 200 }).catch(() => null);
    let prefetched = eventsRes?.events?.length ? formatMobileBtwTranscript(eventsRes.events, 40_000) : "";
    if (prefetched.length < 300) {
      const termRes = await call(targetDevice, "terminal.read", { agent: targetKey, lines: 180 }).catch(() => null);
      const tail = stripMobileAnsiTail(termRes?.text || termRes?.ansi || "", 180);
      if (tail) {
        const snap = `[Recent Terminal Screen Snapshot]\n${tail}`;
        prefetched = prefetched ? `${prefetched}\n\n${snap}`.slice(-40_000) : snap.slice(-40_000);
      }
    }

    if (!useAssistant.getState().loaded) {
      await loadAssistant().catch(() => {});
    }
    const asst = useAssistant.getState();
    if (!asst.ready) {
      patchCard({
        id: reqId,
        question,
        status: "error",
        error: "当前主机版本暂不支持 agent.btw 旁路，且小羊文字助理未就绪。请升级主机 hostd 或先配置小羊文字模型。",
      });
      return;
    }

    const beforeIds = new Set(asst.items.map((x) => x.id));
    const askPrompt = [
      `请在完全不向目标 Agent 发送任何输入、不打断其运行的前提下，只读依据以下已采集的上下文直接回答我的旁路提问（无需再次调用读取工具）：`,
      `Agent：${targetTitle}（key: ${targetKey}，harness: ${targetHarness}，status: ${targetStatus}）`,
      prefetched
        ? `<transcript>\n${prefetched}\n</transcript>`
        : `（未能拉取到会话历史，请基于 Agent 当前状态或只读查询简短回答）`,
      `我的旁路问题：\n${question}`,
    ].join("\n\n");

    let settled = false;
    let unsub: (() => void) | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStreamed = "";
    let sawBusy = false;
    const initialErr = asst.error;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (settleTimer) clearTimeout(settleTimer);
      timeoutTimer = null;
      settleTimer = null;
      unsub?.();
      unsub = null;
      if (btwCancelRef.current[targetKey] === abortWait) {
        delete btwCancelRef.current[targetKey];
      }
    };
    const abortWait = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    btwCancelRef.current[targetKey] = abortWait;

    const findReply = (items: ReturnType<typeof useAssistant.getState>["items"]) =>
      [...items]
        .reverse()
        .find(
          (item) =>
            item.role === "assistant" &&
            !beforeIds.has(item.id) &&
            item.ts >= startedAt - 2000 &&
            (item.text.trim().length > 0 || Boolean(item.error)),
        );

    const check = () => {
      if (settled || !isCurrent()) {
        abortWait();
        return;
      }
      const s = useAssistant.getState();
      if (s.busy) sawBusy = true;
      const reply = findReply(s.items);
      if (reply) {
        if (reply.error) {
          settled = true;
          cleanup();
          patchCard({
            id: reqId,
            question,
            status: "error",
            error: reply.text.trim() || "小羊助理回答失败",
          });
          return;
        }
        if (reply.text !== lastStreamed) {
          lastStreamed = reply.text;
          patchCard({
            id: reqId,
            question,
            status: "streaming",
            answer: reply.text,
            model: s.model ?? "小羊助理",
          });
          if (!s.busy && settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
        }
        if (s.busy) {
          if (settleTimer) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
          return;
        }
        if (!settleTimer) {
          settleTimer = setTimeout(() => {
            settleTimer = null;
            if (settled || !isCurrent()) return;
            const latest = useAssistant.getState();
            if (latest.busy) {
              sawBusy = true;
              return;
            }
            const finalReply = findReply(latest.items);
            if (finalReply) {
              settled = true;
              cleanup();
              if (finalReply.error) {
                patchCard({
                  id: reqId,
                  question,
                  status: "error",
                  error: finalReply.text.trim() || "小羊助理回答失败",
                });
              } else {
                patchCard({
                  id: reqId,
                  question,
                  status: "done",
                  answer: finalReply.text.trim(),
                  model: latest.model ?? "小羊助理",
                  durationMs: Math.max(1, Date.now() - startedAt),
                });
              }
            }
          }, 150);
        }
        return;
      }
      if (!s.busy && s.error && (sawBusy || s.error !== initialErr)) {
        settled = true;
        cleanup();
        patchCard({
          id: reqId,
          question,
          status: "error",
          error: s.error,
        });
      }
    };

    unsub = useAssistant.subscribe(check);
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      void loadAssistant().finally(() => {
        if (settled || !isCurrent()) return;
        const latest = useAssistant.getState();
        const finalReply = findReply(latest.items);
        settled = true;
        cleanup();
        if (finalReply && !finalReply.error && !latest.busy) {
          patchCard({
            id: reqId,
            question,
            status: "done",
            answer: finalReply.text.trim(),
            model: latest.model ?? "小羊助理",
            durationMs: Math.max(1, Date.now() - startedAt),
          });
        } else {
          patchCard({
            id: reqId,
            question,
            status: "error",
            error: "等待小羊旁路回复超时，请稍后再试",
          });
        }
      });
    }, 90_000);

    try {
      await sendToAssistant(askPrompt);
      check();
    } catch (err: unknown) {
      abortWait();
      patchCard({
        id: reqId,
        question,
        status: "error",
        error: (err as Error)?.message || "发送旁路请求失败",
      });
    }
  }, [agent.key, agent.deviceId, agent.title, agent.name, agent.harness, agent.status]);

  function send() {
    let t = text.trim();
    const pics = mode === "chat" ? pictures : [];
    if (!t && !pics.length) return;
    if (mode === "chat" && !agent.isShell && t.startsWith("\\")) {
      const head = t.slice(1).split(/\s+/)[0] ?? "";
      if (head) {
        const slashHead = `/${head}`.toLowerCase();
        const matchesKnown =
          allSlashCommands.some((item) => item.name.toLowerCase() === slashHead) ||
          BUILTIN_SLASH.some((item) => item.name.toLowerCase() === slashHead) ||
          /^\/(?:btw|usage|model|models|switch|effort|thinking|reasoning)$/i.test(slashHead);
        if (matchesKnown) {
          t = `/${t.slice(1)}`;
        }
      }
    }
    const btwMatch = mode === "chat" && !pics.length ? /^\/btw(?:\s+([\s\S]*))?$/i.exec(t) : null;
    if (btwMatch) {
      const question = (btwMatch[1] ?? "").trim();
      if (!question) {
        setText("/btw ");
        setToast("请在 /btw 后输入旁路问题");
        return;
      }
      clearMobileDraft(agent.key);
      setTextState("");
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      void runMobileBtw(question);
      return;
    }
    if (mode === "chat" && !pics.length && /^\/usage$/i.test(t)) {
      setText("");
      openUsageCard();
      return;
    }
    if (mode === "chat" && !pics.length && /^\/(?:model|models)$/i.test(t)) {
      setText("");
      openModelPicker("model", isOmp ? "roles" : "session");
      return;
    }
    if (mode === "chat" && !pics.length && isOmp && /^\/switch$/i.test(t)) {
      setText("");
      openModelPicker("model", "session");
      return;
    }
    if (mode === "chat" && !pics.length && /^\/(?:effort|thinking|reasoning)$/i.test(t) && effectiveThinkingLevels.length > 0) {
      setText("");
      openModelPicker("thinking");
      return;
    }
    if (mode === "chat" && !pics.length) {
      const sw = parseModelSwitchText(t);
      if (sw) {
        clearMobileDraft(agent.key);
        setTextState("");
        applyModelOrThinking({ modelId: sw.model, thinkingLevel: sw.thinking });
        return;
      }
    }
    const now = Date.now();
    const sig = `${agent.key}\0${t}\0${pics.map((x) => x.id).join(",")}`;
    if (lastSendRef.current && lastSendRef.current.sig === sig && now - lastSendRef.current.at < 500) return;
    lastSendRef.current = { sig, at: now };
    clearMobileDraft(agent.key);
    setTextState("");
    if (pics.length) {
      setPictures((cur) => cur.filter((x) => !pics.includes(x)));
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    if (mode === "chat" && agent.status === "working") {
      enqueueMobilePrompt(agent, t, pics);
      return;
    }
    // The message shows in the conversation at once, with its own state; the box is free for the next one.
    void sendOut(agent, t, pics).then((r) => {
      if (r.ok) refreshSoon();
      // Beside the terminal there is no bubble to show the failure on.
      else if (mode === "terminal") setToast(r.message);
    });
  }

  async function attach() {
    if (!canPickImages()) return setToast("这个版本的 App 还不能选图片，更新 App 后再试");
    const room = PUT_LIMITS.files - pictures.length;
    if (room <= 0) return setToast(`一次最多发 ${PUT_LIMITS.files} 张图片`);
    setPicking(true);
    try {
      const picked = await pickImages(room);
      if (!picked.length) return;
      const r = addPictures(pictures, picked);
      setPictures(r.list);
      if (r.note) setToast(r.note);
    } catch (e) {
      setToast(`图片没读出来：${(e as Error).message}`);
    } finally {
      setPicking(false);
    }
  }

  async function press(key: string, haptic: "select" | "heavy" = "select") {
    if (haptic === "heavy") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    else Haptics.selectionAsync().catch(() => undefined);
    setSending(true);
    try {
      await call(agent.deviceId, "terminal.keys", { agent: agent.key, keys: [key] });
      refreshSoon();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  /** After an error (a dropped connection, a model that failed): ask it to carry on. */
  async function retry() {
    Haptics.selectionAsync().catch(() => undefined);
    setSending(true);
    const r = await sendOut(agent, "继续");
    setSending(false);
    if (r.ok) refreshSoon();
    else if (mode === "terminal") setToast(r.message);
  }

  const keyStyle = { borderRadius: radius.pill, minHeight: 40, minWidth: 48, paddingHorizontal: 14, alignItems: "center" as const, justifyContent: "center" as const };
  const padOpen = mode === "terminal" && pad && online && !boxOnly;
  const closePad = useCallback(() => setPad(false), []);
  /** Keyboard button: closes whichever keyboard is up, else opens the one used last. */
  function toggleKeyboard() {
    if (boxOnly) return setExtra((v) => !v);
    if (padOpen || direct.on) {
      setPad(false);
      direct.stop();
    } else if (termInput === "system") direct.start();
    else setPad(true);
  }
  function switchToSystem() {
    setPad(false);
    setSettings({ termInput: "system" });
    direct.start();
  }
  function switchToPad() {
    direct.stop();
    setSettings({ termInput: "pad" });
    setPad(true);
  }

  const metrics = computeComposerBarMetrics(width, textScale);
  const popupMaxHeight = computePopupMaxHeight(height, keyboardHeight);
  const padLeft = horizontalPad(metrics.outerMargin, insets.left);
  const padRight = horizontalPad(metrics.outerMargin, insets.right);

  return (
    <View style={{ flexShrink: 0, paddingBottom: (keyboardOpen ? 0 : bottomInset) + space.xs, paddingTop: space.xs }}>
      {mode === "terminal" && !boxOnly ? direct.input : null}
      {mode === "terminal" && direct.on ? (
        <View accessibilityLiveRegion="polite" style={{ marginLeft: padLeft, marginRight: padRight, marginBottom: space.xs, paddingLeft: space.md, paddingRight: 4, minHeight: 32, borderRadius: radius.pill, backgroundColor: p.accentContainer, flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.primary }} />
          <Text style={{ color: p.accentText, fontSize: 12.5, flex: 1, minWidth: 0 }} numberOfLines={1}>
            直接输入中，打的字会马上出现在终端里
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="换回小键盘，占的地方更少"
            onPress={switchToPad}
            style={({ pressed }) => ({ flexShrink: 0, height: 26, paddingHorizontal: 10, borderRadius: radius.pill, justifyContent: "center", backgroundColor: pressed ? p.surface3 : p.surface })}
          >
            <Text style={{ fontFamily: fonts.bodySemi, fontSize: 12, color: p.accentText }}>小键盘</Text>
          </Pressable>
        </View>
      ) : null}
      {agent.status === "blocked" && online ? <WaitingCard agent={agent} busy={sending} onKey={(k) => press(k)} onRetry={retry} compact={mode === "terminal"} onOpenTerminal={onOpenTerminal} marginLeft={padLeft} marginRight={padRight} /> : null}
      {showKeys ? (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
      <ScrollView horizontal style={{ flex: 1 }} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingLeft: padLeft, paddingRight: space.xs, paddingVertical: space.xs }} keyboardShouldPersistTaps="always">
        {mode === "terminal" ? (
          <IconTile
            icon={(boxOnly ? extra : direct.on || padOpen) ? "keyboardDown" : "keyboard"}
            size={40}
            disabled={!online}
            active={boxOnly ? extra : direct.on || padOpen}
            onPress={toggleKeyboard}
            a11y={boxOnly ? (extra ? "收起输入框" : "打字输入到终端") : direct.on || padOpen ? "收起键盘" : "直接在终端里打字"}
          />
        ) : null}
        <IconTile icon="tune" size={40} tone="plain" onPress={() => setTuning(true)} a11y="调整按键" />
        {keys.map((k) => (
          <Pressable
            key={k.key}
            disabled={!online}
            onPress={() => press(k.key)}
            accessibilityRole="button"
            accessibilityLabel={k.a11y}
            style={({ pressed }) => [keyStyle, { backgroundColor: pressed ? p.accentContainer : p.surface, borderWidth: 1, borderColor: p.dark ? p.surface3 : "#F6DDE8", opacity: online ? 1 : 0.5, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
          >
            <Text style={{ fontFamily: k.mono ? fonts.mono : fonts.bodySemi, fontSize: 13.5, color: p.ink }}>{k.label}</Text>
          </Pressable>
        ))}

      </ScrollView>
        <View style={{ paddingRight: padRight, paddingLeft: space.xs }}>
        <Pressable
            disabled={!online}
            delayLongPress={500}
            onLongPress={() => press("ctrl+c", "heavy")}
            onPress={() => setToast("长按 0.5 秒发送 Ctrl+C，会打断它正在做的事")}
            accessibilityRole="button"
            accessibilityLabel="Ctrl+C，长按发送中断"
            style={({ pressed }) => [keyStyle, { borderWidth: 1.5, borderColor: coral, backgroundColor: pressed ? statusColors("blocked", p.dark).bg : p.surface, opacity: online ? 1 : 0.5 }]}
          >
            <Text style={{ fontFamily: fonts.monoBold, fontSize: 13, color: coral }}>Ctrl+C</Text>
          </Pressable>
        </View>
      </View>
      ) : null}
      {mode === "chat" && pendingSwitch ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityLabel={`待切换模型：${pendingSwitch.label}`}
          style={{
            marginLeft: padLeft,
            marginRight: padRight,
            marginTop: space.xs,
            paddingHorizontal: space.md,
            paddingVertical: space.xs,
            borderRadius: radius.card,
            backgroundColor: p.surface,
            borderWidth: 1,
            borderColor: p.dark ? p.surface3 : "#FBE3EC",
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ModelBrandIcon model={pendingSwitch.modelId || pendingSwitch.label} size={16} color={p.accentText} />
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: p.ink }}>
            <Text style={{ fontFamily: fonts.bodyBold, color: p.accentText }}>本轮结束后切换 · </Text>
            {pendingSwitch.label}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消待切换模型"
            onPress={() => {
              Haptics.selectionAsync().catch(() => undefined);
              cancelMobilePendingSwitch(agent.key);
            }}
            hitSlop={8}
            style={({ pressed }) => ({
              width: 28,
              height: 28,
              borderRadius: 14,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? p.surface3 : p.surface2,
            })}
          >
            <MaterialCommunityIcons name="close" size={15} color={p.muted} />
          </Pressable>
        </View>
      ) : null}
      {mode === "chat" && totalQueued > 0 ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityLabel={`排队中，共 ${totalQueued} 条`}
          style={{
            marginLeft: padLeft,
            marginRight: padRight,
            marginTop: space.xs,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderRadius: radius.card,
            backgroundColor: p.surface,
            borderWidth: 1,
            borderColor: p.dark ? p.surface3 : "#FBE3EC",
            gap: 6,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ flexShrink: 0, fontFamily: fonts.bodyBold, fontSize: 12, color: p.accentText }}>
              {`排队中 · ${totalQueued} 条`}
            </Text>
            <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, fontSize: 11.5, color: p.faint }}>
              {!online ? "电脑离线，上线后自动发" : agent.status === "blocked" ? "等待确认后继续" : "本轮结束后依次自动发"}
            </Text>
          </View>
          <ScrollView nestedScrollEnabled showsVerticalScrollIndicator={false} style={{ maxHeight: Math.min(156, popupMaxHeight) }} contentContainerStyle={{ gap: 5 }} keyboardShouldPersistTaps="always">
            {queued.map((q, idx) => (
              <View
                key={q.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: radius.sm,
                  backgroundColor: p.surface2,
                }}
              >
                <View style={{ minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: p.accentContainer, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 11 }}>{idx + 1}</Text>
                </View>
                {q.pictures[0] ? (
                  <Image
                    source={{ uri: `data:${q.pictures[0].mime};base64,${q.pictures[0].data}` }}
                    style={{ width: 24, height: 24, borderRadius: 5, backgroundColor: p.surface3 }}
                  />
                ) : null}
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 13, color: p.ink }}>
                  {q.text || "（仅图片）"}
                </Text>
                {q.pictures.length > 1 ? (
                  <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: p.surface, borderWidth: 1, borderColor: p.divider }}>
                    <Text style={{ fontSize: 11, color: p.muted }}>{`+${q.pictures.length}图`}</Text>
                  </View>
                ) : null}
                <Pressable
                  disabled={!online || isSteering}
                  accessibilityRole="button"
                  accessibilityLabel="不打断当前轮插队发送"
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
                    void steerMobileQueuedPromptNow(agent, q.id).then((r) => {
                      if (r.ok) refreshSoon();
                      else setToast(r.message);
                    });
                  }}
                  style={({ pressed }) => ({
                    height: 26,
                    paddingHorizontal: 9,
                    borderRadius: radius.pill,
                    backgroundColor: pressed ? p.surface3 : p.accentContainer,
                    borderWidth: 1,
                    borderColor: p.primary,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 3,
                    opacity: !online || isSteering ? 0.45 : 1,
                  })}
                >
                  <MaterialCommunityIcons name="flash-outline" size={13} color={p.accentText} />
                  <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>插队</Text>
                </Pressable>
                {agent.status === "working" ? (
                  <Pressable
                    disabled={!online || isSteering}
                    accessibilityRole="button"
                    accessibilityLabel="打断当前轮并立即发送"
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
                      void interruptAndSendMobileQueuedPrompt(agent, q.id).then((r) => {
                        if (r.ok) refreshSoon();
                        else setToast(r.message);
                      });
                    }}
                    style={({ pressed }) => ({
                      height: 26,
                      paddingHorizontal: 8,
                      borderRadius: radius.pill,
                      backgroundColor: pressed ? p.surface3 : p.surface,
                      borderWidth: 1,
                      borderColor: p.divider,
                      justifyContent: "center",
                      opacity: !online || isSteering ? 0.45 : 1,
                    })}
                  >
                    <Text style={{ color: p.muted, fontFamily: fonts.bodySemi, fontSize: 11.5 }}>打断</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="编辑这条排队消息"
                  hitSlop={4}
                  onPress={() => {
                    if (text.trim() || pictures.length) {
                      enqueueMobilePrompt(agent, text, pictures);
                    }
                    const popped = popMobileQueuedPromptForEdit(agent.key, q.id);
                    if (!popped) return;
                    setText(popped.text);
                    setPictures(popped.pictures);
                  }}
                  style={({ pressed }) => ({ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : "transparent" })}
                >
                  <MaterialCommunityIcons name="pencil-outline" size={14} color={p.muted} />
                </Pressable>
                {idx > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="移到队列最前"
                    hitSlop={4}
                    onPress={() => moveMobileQueuedPromptToTop(agent.key, q.id)}
                    style={({ pressed }) => ({ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : "transparent" })}
                  >
                    <MaterialCommunityIcons name="arrow-up" size={14} color={p.muted} />
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="移除这条排队消息"
                  hitSlop={4}
                  onPress={() => removeMobileQueuedPrompt(agent.key, q.id)}
                  style={({ pressed }) => ({ width: 26, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.surface3 : "transparent" })}
                >
                  <MaterialCommunityIcons name="close" size={14} color={p.muted} />
                </Pressable>
              </View>
            ))}
            {terminalQueuedItems.length > 0 ? (
              terminalQueuedItems.map((qText, idx) => (
                <View
                  key={`m-term-q-${idx}-${qText.slice(0, 20)}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 5,
                    borderRadius: radius.sm,
                    backgroundColor: p.surface2,
                  }}
                >
                  <View style={{ paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: p.accentContainer, alignItems: "center", justifyContent: "center" }}>
                    <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 10.5 }}>终端</Text>
                  </View>
                  <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: p.ink }}>
                    {qText}
                  </Text>
                  {agent.source === "hc" && online && idx === 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="立即注入到当前轮"
                      onPress={() => void press("alt+m")}
                      style={({ pressed }) => ({
                        height: 26,
                        paddingHorizontal: 9,
                        borderRadius: radius.pill,
                        backgroundColor: pressed ? p.surface3 : p.accentContainer,
                        borderWidth: 1,
                        borderColor: p.primary,
                        alignItems: "center",
                        justifyContent: "center",
                      })}
                    >
                      <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>立即注入</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))
            ) : hostHeldCount > 0 ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: radius.sm,
                  backgroundColor: p.surface2,
                }}
              >
                <View style={{ paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: p.accentContainer, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 10.5 }}>终端</Text>
                </View>
                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: p.ink }}>
                  {`终端输入区排队 · ${hostHeldCount} 条${agent.queuedText ? `：${agent.queuedText}` : ""}`}
                </Text>
                {agent.source === "hc" && online ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="立即注入到当前轮"
                    onPress={() => void press("alt+m")}
                    style={({ pressed }) => ({
                      height: 26,
                      paddingHorizontal: 9,
                      borderRadius: radius.pill,
                      backgroundColor: pressed ? p.surface3 : p.accentContainer,
                      borderWidth: 1,
                      borderColor: p.primary,
                      alignItems: "center",
                      justifyContent: "center",
                    })}
                  >
                    <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>立即注入</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : mode === "terminal" && agent.queued ? (
        <View
          accessibilityLiveRegion="polite"
          accessibilityLabel={`排队中，${agent.queued} 条消息在它的输入框里，这一轮完了才会处理`}
          style={{ marginLeft: padLeft, marginRight: padRight, marginTop: space.xs, paddingHorizontal: space.md, minHeight: 30, borderRadius: radius.pill, backgroundColor: p.accentContainer, flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.primary }} />
          <Text style={{ color: p.accentText, fontSize: 12.5, flex: 1, minWidth: 0 }} numberOfLines={1}>
            {`排队中 · ${agent.queued} 条在它输入框里，这一轮完了才会处理${agent.queuedText ? `：${agent.queuedText}` : ""}`}
          </Text>
        </View>
      ) : null}
      {padOpen ? (
        <TermKeyboard onSend={direct.push} onSystem={switchToSystem} onClose={closePad} />
      ) : null}
      {mode === "chat" && pictures.length ? (
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: space.xs }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md, paddingLeft: padLeft, paddingRight: space.sm, paddingTop: 8, paddingBottom: 2 }} keyboardShouldPersistTaps="always">
            {pictures.map((x, i) => (
              <View key={x.id} style={{ width: 60, height: 60 }}>
                <Image
                  source={{ uri: `data:${x.mime};base64,${x.data}` }}
                  accessibilityLabel={`要发送的第 ${i + 1} 张图片`}
                  style={{ width: 60, height: 60, borderRadius: radius.sm, backgroundColor: p.surface2, borderWidth: 1, borderColor: p.dark ? p.surface3 : "#FBE3EC" }}
                />
                <Pressable
                  onPress={() => setPictures((cur) => cur.filter((y) => y.id !== x.id))}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`移除第 ${i + 1} 张图片`}
                  style={({ pressed }) => ({ position: "absolute", top: -7, right: -7, width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? p.primaryPressed : p.primary, borderWidth: 2, borderColor: p.surface })}
                >
                  <MaterialCommunityIcons name="close" size={12} color={p.onPrimary} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Text accessibilityLiveRegion="polite" style={{ color: p.muted, fontSize: 12, paddingRight: padRight }}>
            {`${pictures.length}/${PUT_LIMITS.files}`}
          </Text>
        </View>
      ) : null}
      {mode === "chat" && activeBtwCard ? (() => {
        const dur = formatBtwDuration(activeBtwCard.durationMs);
        const hasAnswer = Boolean(activeBtwCard.answer && activeBtwCard.answer.trim().length > 0);
        const isStreaming =
          activeBtwCard.status === "streaming" ||
          (activeBtwCard.status === "loading" && hasAnswer);
        return (
          <View
            accessibilityLabel="旁路提问结果"
            style={{
              marginLeft: padLeft,
              marginRight: padRight,
              marginBottom: space.xs,
              padding: space.md,
              borderRadius: radius.card,
              backgroundColor: p.surface,
              borderWidth: 1,
              borderColor: p.dark ? p.surface3 : "#FBE3EC",
              gap: space.sm,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    borderRadius: 7,
                    backgroundColor: p.accentContainer,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <MaterialCommunityIcons name="robot-outline" size={13} color={p.accentText} />
                </View>
                <Text numberOfLines={1} style={{ flexShrink: 0, fontFamily: fonts.bodyBold, fontSize: 13, color: p.ink }}>
                  旁路提问 /btw
                </Text>
                {activeBtwCard.model ? (
                  <View
                    style={{
                      flexShrink: 1,
                      minWidth: 0,
                      maxWidth: 130,
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: radius.pill,
                      backgroundColor: p.lavenderContainer,
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      style={{ flexShrink: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 10.5, color: p.onLavender }}
                    >
                      {activeBtwCard.model}
                    </Text>
                  </View>
                ) : null}
                {dur ? (
                  <View
                    style={{
                      flexShrink: 0,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: radius.pill,
                      backgroundColor: p.surface2,
                      borderWidth: 1,
                      borderColor: p.divider,
                    }}
                  >
                    <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: p.muted }}>{dur}</Text>
                  </View>
                ) : null}
              </View>
              <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 2 }}>
                {activeBtwCard.status === "done" && hasAnswer ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="复制旁路回答"
                    hitSlop={8}
                    style={{ padding: 4 }}
                    onPress={async () => {
                      const content = activeBtwCard.answer?.trim();
                      if (!content) return;
                      await Clipboard.setStringAsync(content);
                      setBtwCopiedId(activeBtwCard.id);
                      setTimeout(() => {
                        setBtwCopiedId((cur) => (cur === activeBtwCard.id ? null : cur));
                      }, 1500);
                    }}
                  >
                    <MaterialCommunityIcons
                      name={btwCopiedId === activeBtwCard.id ? "check" : "content-copy"}
                      size={15}
                      color={btwCopiedId === activeBtwCard.id ? p.accentText : p.muted}
                    />
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭旁路卡片"
                  hitSlop={8}
                  style={{ padding: 4 }}
                  onPress={() => dismissBtwCard(agent.key)}
                >
                  <MaterialCommunityIcons name="close" size={16} color={p.muted} />
                </Pressable>
              </View>
            </View>

            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 4,
                paddingHorizontal: space.sm,
                paddingVertical: 6,
                borderRadius: radius.sm,
                backgroundColor: p.surface2,
              }}
            >
              <Text style={{ fontFamily: fonts.bodyBold, fontSize: 12.5, color: p.accentText }}>
                问：
              </Text>
              <Text
                selectable
                style={{ flex: 1, minWidth: 0, fontFamily: fonts.bodySemi, fontSize: 12.5, lineHeight: 18, color: p.ink }}
              >
                {activeBtwCard.question}
              </Text>
            </View>

            <ScrollView nestedScrollEnabled style={{ maxHeight: Math.min(200, popupMaxHeight) }} keyboardShouldPersistTaps="handled">
              {activeBtwCard.status === "error" ? (
                <View style={{ padding: space.sm, borderRadius: radius.sm, backgroundColor: p.errorContainer }}>
                  <Text selectable style={{ fontSize: 12.5, lineHeight: 18, color: p.error }}>
                    {activeBtwCard.error || "旁路提问失败"}
                  </Text>
                </View>
              ) : isStreaming ? (
                <View style={{ gap: 6 }}>
                  <Text
                    selectable
                    style={{ fontFamily: fonts.body, fontSize: 13.5 * textScale, lineHeight: 20, color: p.ink }}
                  >
                    {activeBtwCard.answer || ""}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <PocketSpinner size={13} />
                    <Text style={{ fontSize: 11.5, color: p.muted }}>正在旁路流式输出…</Text>
                  </View>
                </View>
              ) : activeBtwCard.status === "loading" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
                  <PocketSpinner size={16} />
                  <Text style={{ fontSize: 12.5, color: p.muted }}>
                    正在只读旁路思考，主线对话不会被打断…
                  </Text>
                </View>
              ) : (
                <Text
                  selectable
                  style={{ fontFamily: fonts.body, fontSize: 13.5 * textScale, lineHeight: 20, color: p.ink }}
                >
                  {activeBtwCard.answer || ""}
                </Text>
              )}
            </ScrollView>
          </View>
        );
      })() : null}
      {mode === "chat" && usageOpen ? (
        <View
          accessibilityLabel="用量与上下文"
          style={{
            marginLeft: padLeft,
            marginRight: padRight,
            marginBottom: space.xs,
            padding: space.md,
            borderRadius: radius.card,
            backgroundColor: p.surface,
            borderWidth: 1,
            borderColor: p.dark ? p.surface3 : "#FBE3EC",
            maxHeight: popupMaxHeight,
            overflow: "hidden",
            gap: space.sm,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <MaterialCommunityIcons name="gauge" size={16} color={p.accentText} />
            <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.ink, flex: 1, minWidth: 0 }}>
              用量与上下文 · {usageData?.harness || agent.harness}
            </Text>
            <Pressable accessibilityRole="button" accessibilityLabel="刷新用量" onPress={openUsageCard} hitSlop={8} style={{ flexShrink: 0, padding: 4 }}>
              <MaterialCommunityIcons name="refresh" size={16} color={p.muted} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭用量卡片" onPress={() => setUsageOpen(false)} hitSlop={8} style={{ flexShrink: 0, padding: 4 }}>
              <MaterialCommunityIcons name="close" size={16} color={p.muted} />
            </Pressable>
          </View>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: space.sm }}>
            {usageError ? <Text style={{ fontSize: 12, color: p.error }}>{usageError}</Text> : null}
            {usageLoading && !usageData ? (
              <View style={{ paddingVertical: 8, alignItems: "center" }}>
                <PocketSpinner size={18} />
              </View>
            ) : usageData ? (
              <>
                {(usageData.session?.contextTokens ?? agent.contextTokens) !== undefined ? (() => {
                  const ct = usageData.session?.contextTokens ?? agent.contextTokens ?? 0;
                  const cl = usageData.session?.contextLimit ?? agent.contextLimit;
                  const usedPct = usageData.session?.contextPct ?? (cl && cl > 0 ? Math.min(100, (ct / cl) * 100) : undefined);
                  const remainPct = usedPct !== undefined ? Math.max(0, 100 - usedPct) : undefined;
                  const cacheDenom = usageData.session
                    ? usageData.session.input + usageData.session.cacheRead + usageData.session.cacheWrite
                    : 0;
                  const cacheHitPct =
                    usageData.session && usageData.session.cacheRead > 0 && cacheDenom > 0
                      ? ((usageData.session.cacheRead / cacheDenom) * 100).toFixed(1)
                      : null;
                  return (
                    <View style={{ gap: 5 }}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                        <Text style={{ fontFamily: fonts.monoBold, fontSize: 12.5, color: p.ink }}>
                          {usedPct !== undefined
                            ? `${usedPct.toFixed(1)}% 已用 · ${remainPct!.toFixed(1)}% 剩余`
                            : `${compactNum(ct)} tokens`}
                        </Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 11.5, color: p.muted }}>
                          {cl ? `${compactNum(ct)} / ${compactNum(cl)}` : `${compactNum(ct)} tok`}
                        </Text>
                      </View>
                      {usedPct !== undefined ? (
                        <PocketProgress
                          progress={usedPct / 100}
                          color={usedPct >= 85 ? p.error : usedPct >= 65 ? "#f59e0b" : p.primary}
                          height={6}
                        />
                      ) : null}
                      {cacheHitPct ? (
                        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: p.muted }}>
                          {`缓存命中 ${cacheHitPct}%`}
                        </Text>
                      ) : null}
                    </View>
                  );
                })() : null}
                {(usageData.model || effectiveCurrentModel) ? (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 7,
                      borderRadius: radius.sm,
                      backgroundColor: p.surface2,
                      borderWidth: 1,
                      borderColor: p.divider,
                    }}
                  >
                    <Text style={{ fontSize: 11.5, color: p.muted }}>当前模型</Text>
                    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                      <ModelBrandIcon model={usageData.model || effectiveCurrentModel} size={13} color={p.accentText} />
                      <Text numberOfLines={1} style={{ fontFamily: fonts.monoBold, fontSize: 11.5, color: p.ink, flexShrink: 1 }}>
                        {(usageData.model || effectiveCurrentModel || "").split("/").pop()}
                      </Text>
                    </View>
                  </View>
                ) : null}
                {usageData.quotas.length > 0 ? (() => {
                  const fmtResetShort = (resetAt?: number) => {
                    if (!resetAt) return "";
                    const mins = Math.max(1, Math.round((resetAt - Date.now()) / 60_000));
                    if (mins < 60) return `${mins}m`;
                    const hrs = Math.floor(mins / 60);
                    const remM = mins % 60;
                    if (hrs < 24) return remM > 0 ? `${hrs}h${remM}m` : `${hrs}h`;
                    const d = Math.floor(hrs / 24);
                    const remH = hrs % 24;
                    return remH > 0 ? `${d}d${remH}h` : `${d}d`;
                  };
                  const groups = new Map<string, { title: string; bars: Array<{ win: string; remain: number; reset: string }> }>();
                  for (const q of usageData.quotas) {
                    const low = q.provider.trim().toLowerCase();
                    const title =
                      low === "google" || low === "gemini"
                        ? "Gemini"
                        : low === "anthropic" || low === "claude"
                          ? "Claude"
                          : low === "openai" || low === "codex"
                            ? "OpenAI"
                            : q.provider;
                    const key = title.toLowerCase();
                    const win = /5\s*(?:小时|h)/i.test(q.label) ? "5h窗口" : /7\s*天|周/i.test(q.label) ? "周额度" : q.label;
                    const remain = Math.max(0, Math.min(100, Math.round((100 - q.usedPct) * 10) / 10));
                    const g = groups.get(key) ?? { title, bars: [] };
                    g.bars.push({ win, remain, reset: fmtResetShort(q.resetAt) });
                    groups.set(key, g);
                  }
                  const list = [...groups.entries()];
                  const current = list.find(([k]) => k === quotaTab)?.[1] ?? list[0]![1];
                  const minRemain = current.bars.reduce((acc, b) => Math.min(acc, b.remain), 100);
                  const health = minRemain >= 50 ? "充裕" : minRemain >= 20 ? "适中" : "紧张";
                  const healthColor = minRemain >= 50 ? "#10b981" : minRemain >= 20 ? "#f59e0b" : p.error;
                  return (
                    <View style={{ gap: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: p.divider }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                          <ModelBrandIcon model={current.title} size={13} color={p.ink} />
                          <Text style={{ fontFamily: fonts.bodyBold, fontSize: 12, color: p.ink }}>{current.title}</Text>
                          <Text style={{ fontSize: 10.5, fontFamily: fonts.bodyBold, color: healthColor }}>{health}</Text>
                        </View>
                        {list.length > 1 ? (
                          <View style={{ flexDirection: "row", backgroundColor: p.surface2, borderRadius: radius.pill, padding: 2, gap: 2 }}>
                            {list.map(([k, g]) => {
                              const on = g.title === current.title;
                              return (
                                <Pressable
                                  key={k}
                                  onPress={() => setQuotaTab(k)}
                                  style={{
                                    paddingHorizontal: 8,
                                    paddingVertical: 2,
                                    borderRadius: radius.pill,
                                    backgroundColor: on ? p.surface3 : "transparent",
                                  }}
                                >
                                  <Text style={{ fontSize: 10.5, fontFamily: on ? fonts.bodyBold : fonts.body, color: on ? p.ink : p.muted }}>
                                    {g.title}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        ) : null}
                      </View>
                      {current.bars.map((b, bi) => (
                        <View key={bi} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <Text style={{ width: 46, fontSize: 11, color: p.muted }}>{b.win}</Text>
                          <View style={{ flex: 1 }}>
                            <PocketProgress
                              progress={b.remain / 100}
                              color={b.remain < 20 ? p.error : b.remain < 50 ? "#f59e0b" : "#3898ff"}
                              height={5}
                            />
                          </View>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: p.ink }}>
                            {`${Number.isInteger(b.remain) ? b.remain : b.remain.toFixed(1)}%${b.reset ? ` · ${b.reset}` : ""}`}
                          </Text>
                        </View>
                      ))}
                    </View>
                  );
                })() : null}
                {usageData.session ? (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    <View style={{ flexGrow: 1, minWidth: "46%", padding: 8, borderRadius: radius.sm, backgroundColor: p.surface2 }}>
                      <Text style={{ fontSize: 11, color: p.faint }}>累计费用</Text>
                      <Text style={{ fontFamily: fonts.monoBold, fontSize: 12.5, color: p.ink }}>
                        {usageData.session.steps > 0 && usageData.session.unpricedSteps >= usageData.session.steps && usageData.session.costUsd === 0
                          ? "未计价"
                          : money(usageData.session.costUsd) ?? "$0.00"}
                      </Text>
                    </View>
                    <View style={{ flexGrow: 1, minWidth: "46%", padding: 8, borderRadius: radius.sm, backgroundColor: p.surface2 }}>
                      <Text style={{ fontSize: 11, color: p.faint }}>轮次与步数</Text>
                      <Text style={{ fontFamily: fonts.monoBold, fontSize: 12.5, color: p.ink }}>
                        {`${usageData.session.turns} 轮 · ${usageData.session.steps} 步`}
                      </Text>
                    </View>
                    <View style={{ flexGrow: 1, minWidth: "46%", padding: 8, borderRadius: radius.sm, backgroundColor: p.surface2 }}>
                      <Text style={{ fontSize: 11, color: p.faint }}>输入 / 输出</Text>
                      <Text style={{ fontFamily: fonts.monoBold, fontSize: 12.5, color: p.ink }}>
                        {`${compactNum(usageData.session.input)} / ${compactNum(usageData.session.output)}`}
                      </Text>
                    </View>
                    <View style={{ flexGrow: 1, minWidth: "46%", padding: 8, borderRadius: radius.sm, backgroundColor: p.surface2 }}>
                      <Text style={{ fontSize: 11, color: p.faint }}>缓存读取</Text>
                      <Text style={{ fontFamily: fonts.monoBold, fontSize: 12.5, color: p.ink }}>
                        {compactNum(usageData.session.cacheRead)}
                      </Text>
                    </View>
                  </View>
                ) : (
                  <Text style={{ fontSize: 12, color: p.faint }}>暂无详细会话统计</Text>
                )}
                {usageData.models.length > 0 ? (
                  <View style={{ gap: 3 }}>
                    {usageData.models.slice(0, 4).map((m) => (
                      <View key={m.model} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <ModelBrandIcon model={m.model} size={13} color={p.muted} />
                        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 11.5, color: p.ink }}>{m.model}</Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: p.muted }}>{m.steps} 步</Text>
                        <Text style={{ fontFamily: fonts.monoBold, fontSize: 11.5, color: p.accentText }}>
                          {m.steps > 0 && m.unpricedSteps >= m.steps && m.costUsd === 0 ? "未计价" : money(m.costUsd) ?? "$0.00"}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {usageData.day24h || usageData.day7d ? (
                  <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: p.muted }}>
                    {usageData.day24h ? `24h 合计 ${money(usageData.day24h.total.costUsd) ?? "$0.00"}  ` : ""}
                    {usageData.day7d ? `7d 合计 ${money(usageData.day7d.total.costUsd) ?? "$0.00"}` : ""}
                  </Text>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
      {mode === "chat" && slashQuery !== null && slashMatches.length > 0 ? (
        <View
          accessibilityLabel="斜杠命令推荐"
          style={{
            marginLeft: padLeft,
            marginRight: padRight,
            marginBottom: space.xs,
            borderRadius: radius.card,
            backgroundColor: p.surface,
            borderWidth: 1,
            borderColor: p.dark ? p.surface3 : "#FBE3EC",
            maxHeight: Math.min(210, popupMaxHeight),
            overflow: "hidden",
          }}
        >
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="always" contentContainerStyle={{ padding: space.xs, gap: 3 }}>
            {slashMatches.slice(0, 12).map((cmd) => {
              const glyph = mobileSlashGlyph(slashCommandIconKind(cmd));
              return (
                <Pressable
                  key={`${cmd.name}-${cmd.source ?? "b"}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${cmd.name}，${cmd.description}`}
                  onPress={() => {
                    if (/^\/usage$/i.test(cmd.name)) {
                      setText("");
                      openUsageCard();
                      return;
                    }
                    if (/^\/(?:model|models)$/i.test(cmd.name)) {
                      setText("");
                      openModelPicker("model", isOmp ? "roles" : "session");
                      return;
                    }
                    if (isOmp && /^\/switch$/i.test(cmd.name)) {
                      setText("");
                      openModelPicker("model", "session");
                      return;
                    }
                    if (/^\/(?:effort|thinking|reasoning)$/i.test(cmd.name) && effectiveThinkingLevels.length > 0) {
                      setText("");
                      openModelPicker("thinking");
                      return;
                    }
                    const needsArgs = Boolean(cmd.argHint) || ["/btw", "/add", "/model", "/ask", "/architect", "/add-dir", "/goal"].includes(cmd.name);
                    setText(needsArgs ? `${cmd.name} ` : cmd.name);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: space.sm,
                    paddingVertical: 7,
                    borderRadius: radius.sm,
                    backgroundColor: pressed ? p.surface3 : "transparent",
                  })}
                >
                  <View
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: p.accentContainer,
                    }}
                  >
                    <MaterialCommunityIcons name={glyph} size={13} color={p.accentText} />
                  </View>
                  <Text style={{ fontFamily: fonts.monoBold, fontSize: 13, color: p.accentText }}>{cmd.name}</Text>
                  {cmd.argHint ? <Text style={{ fontFamily: fonts.mono, fontSize: 11.5, color: p.faint }}>{cmd.argHint}</Text> : null}
                  <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 12, color: p.muted }}>{cmd.description}</Text>
                  {cmd.source && cmd.source !== "builtin" ? (
                    <View style={{ flexShrink: 0, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.pill, backgroundColor: p.accentContainer }}>
                      <Text style={{ fontSize: 10.5, color: p.accentText }}>{cmd.source === "project" ? "项目" : "全局"}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {mode === "chat" && modelOpen ? (() => {
        const EFFORT_LABELS: Record<string, string> = {
          off: "关闭", none: "关闭", minimal: "极简", min: "极简", low: "低", medium: "中", med: "中",
          high: "高", xhigh: "超高", max: "最大", ultra: "极致", auto: "自动", normal: "标准", fast: "快速",
          smart: "深度", rush: "极速",
        };
        const effortLabel = (lvl: string) => EFFORT_LABELS[lvl.toLowerCase()] ?? lvl;
        const activeModelData = modelData ?? fallbackModelData;
        const currentModel = effectiveCurrentModel;
        const currentThinking = effectiveCurrentThinking;
        const thinkingLevels = effectiveThinkingLevels;

        if (modelOpen === "thinking") {
          return (
            <View
              accessibilityLabel="切换思考等级下拉列表"
              style={{
                marginLeft: padLeft,
                marginRight: padRight,
                marginBottom: space.xs,
                borderRadius: radius.card,
                backgroundColor: p.surface,
                borderWidth: 1,
                borderColor: p.dark ? p.surface3 : "#FBE3EC",
                maxHeight: Math.min(236, popupMaxHeight),
                overflow: "hidden",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.sm, height: 36, borderBottomWidth: 1, borderBottomColor: p.divider, backgroundColor: p.surface2, gap: 6 }}>
                <MaterialCommunityIcons name="brain" size={15} color={p.accentText} />
                <Text style={{ flex: 1, fontFamily: fonts.bodyBold, fontSize: 12.5, color: p.ink }}>切换思考等级</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="关闭思考等级列表" onPress={() => setModelOpen(false)} hitSlop={8} style={{ padding: 4 }}>
                  <MaterialCommunityIcons name="close" size={15} color={p.muted} />
                </Pressable>
              </View>
              <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="always" contentContainerStyle={{ padding: space.xs, gap: 2 }}>
                {modelLoading && !modelData && thinkingLevels.length === 0 ? (
                  <View style={{ paddingVertical: 14, alignItems: "center" }}><PocketSpinner size={18} /></View>
                ) : thinkingLevels.length === 0 ? (
                  <Text style={{ textAlign: "center", paddingVertical: 14, fontSize: 12.5, color: p.faint }}>当前模型不支持思考等级切换</Text>
                ) : (
                  thinkingLevels.map((lvl) => {
                    const active = currentThinking === lvl.toLowerCase();
                    return (
                      <Pressable
                        key={lvl}
                        disabled={activeModelData.canSwitch === false}
                        onPress={() => applyThinkingChoice(lvl)}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                          paddingHorizontal: space.sm,
                          paddingVertical: 8,
                          borderRadius: radius.sm,
                          backgroundColor: pressed ? p.surface3 : active ? p.accentContainer : "transparent",
                        })}
                      >
                        <MaterialCommunityIcons name="brain" size={14} color={active ? p.accentText : p.muted} />
                        <Text style={{ flex: 1, fontFamily: active ? fonts.bodyBold : fonts.bodySemi, fontSize: 13, color: active ? p.accentText : p.ink }}>
                          {effortLabel(lvl)}
                        </Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: p.muted }}>{lvl}</Text>
                        {active ? <MaterialCommunityIcons name="check" size={14} color={p.accentText} /> : null}
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
            </View>
          );
        }

        const OMP_ROLE_LABELS: Record<OmpModelRole, string> = {
          default: "主模型",
          smol: "轻量快速",
          slow: "深度慢想",
          plan: "架构规划",
          commit: "提交摘要",
        };
        const q = modelFilter.trim().toLowerCase();
        const filteredModels = activeModelData.models.filter(
          (m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q) || (m.provider?.toLowerCase().includes(q) ?? false),
        );
        const trimmedFilter = modelFilter.trim();
        const exactMatch = trimmedFilter ? filteredModels.some((m) => m.id.toLowerCase() === trimmedFilter.toLowerCase()) : false;
        const canCustom = Boolean(trimmedFilter && !exactMatch && activeModelData.canSwitch !== false);
        const showRoleOverview = isOmp && ompTab === "roles" && editingRole === null;
        const roleTargetModel = editingRole ? activeModelData.modelRoles?.[editingRole] : undefined;
        return (
          <View
            accessibilityLabel={isOmp && ompTab === "roles" ? "OMP 角色模型下拉列表" : "切换模型下拉列表"}
            style={{
              marginLeft: padLeft,
              marginRight: padRight,
              marginBottom: space.xs,
              borderRadius: radius.card,
              backgroundColor: p.surface,
              borderWidth: 1,
              borderColor: p.dark ? p.surface3 : "#FBE3EC",
              maxHeight: popupMaxHeight,
              overflow: "hidden",
            }}
          >
            {isOmp ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: space.xs,
                  paddingVertical: 6,
                  borderBottomWidth: 1,
                  borderBottomColor: p.divider,
                  backgroundColor: p.surface2,
                  gap: 6,
                }}
              >
                <View
                  style={{
                    flex: 1,
                    minWidth: 0,
                    flexDirection: "row",
                    backgroundColor: p.surface3,
                    borderRadius: radius.pill,
                    padding: 2,
                    borderWidth: 1,
                    borderColor: p.divider,
                  }}
                >
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: ompTab === "session" }}
                    onPress={() => {
                      setOmpTab("session");
                      setEditingRole(null);
                      setModelFilter("");
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      paddingVertical: 5,
                      paddingHorizontal: 8,
                      borderRadius: radius.pill,
                      alignItems: "center",
                      backgroundColor: ompTab === "session" ? p.surface : "transparent",
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        flexShrink: 1,
                        fontFamily: fonts.bodyBold,
                        fontSize: 11.5,
                        color: ompTab === "session" ? p.accentText : p.muted,
                      }}
                    >
                      会话模型 (/switch)
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: ompTab === "roles" }}
                    onPress={() => {
                      setOmpTab("roles");
                      setEditingRole(null);
                      setModelFilter("");
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      paddingVertical: 5,
                      paddingHorizontal: 8,
                      borderRadius: radius.pill,
                      alignItems: "center",
                      backgroundColor: ompTab === "roles" ? p.surface : "transparent",
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        flexShrink: 1,
                        fontFamily: fonts.bodyBold,
                        fontSize: 11.5,
                        color: ompTab === "roles" ? p.accentText : p.muted,
                      }}
                    >
                      角色模型 (/model)
                    </Text>
                  </Pressable>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭模型列表"
                  onPress={() => setModelOpen(false)}
                  hitSlop={8}
                  style={{ padding: 4 }}
                >
                  <MaterialCommunityIcons name="close" size={15} color={p.muted} />
                </Pressable>
              </View>
            ) : null}
            {isOmp && ompTab === "roles" && editingRole !== null ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: space.sm,
                  paddingVertical: 6,
                  borderBottomWidth: 1,
                  borderBottomColor: p.divider,
                  backgroundColor: p.surface,
                  gap: 8,
                }}
              >
                <Pressable
                  onPress={() => {
                    setEditingRole(null);
                    setModelFilter("");
                  }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 3,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                    borderRadius: radius.pill,
                    backgroundColor: p.surface2,
                    borderWidth: 1,
                    borderColor: p.divider,
                  }}
                >
                  <MaterialCommunityIcons name="chevron-left" size={14} color={p.ink} />
                  <Text style={{ fontSize: 11.5, fontFamily: fonts.bodySemi, color: p.ink }}>返回</Text>
                </Pressable>
                <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.bodyBold, fontSize: 12, color: p.accentText }}>
                  {`设置 ${editingRole} (${OMP_ROLE_LABELS[editingRole]})`}
                </Text>
              </View>
            ) : null}
            {!showRoleOverview ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: space.sm,
                  height: 36,
                  borderBottomWidth: 1,
                  borderBottomColor: p.divider,
                  backgroundColor: p.surface2,
                  gap: 6,
                }}
              >
                <MaterialCommunityIcons name="magnify" size={15} color={p.faint} />
                <RNTextInput
                  value={modelFilter}
                  onChangeText={setModelFilter}
                  placeholder={editingRole ? `筛选或输入 ${editingRole} 角色模型 ID…` : "筛选或输入模型 ID…"}
                  placeholderTextColor={p.faint}
                  editable={activeModelData.canSwitch !== false}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  onSubmitEditing={() => {
                    if (activeModelData.canSwitch === false) return;
                    const targetId = filteredModels.length > 0 ? filteredModels[0]!.id : trimmedFilter;
                    if (!targetId) return;
                    if (editingRole) applyRoleModelChoice(editingRole, targetId);
                    else applyModelChoice(targetId);
                  }}
                  style={{
                    flex: 1,
                    fontFamily: fonts.mono,
                    fontSize: 12.5,
                    color: p.ink,
                    paddingVertical: 4,
                  }}
                  accessibilityLabel={editingRole ? `筛选或输入 ${editingRole} 角色模型 ID` : "筛选或输入模型 ID"}
                />
                {!isOmp ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="关闭模型列表"
                    onPress={() => setModelOpen(false)}
                    hitSlop={8}
                    style={{ padding: 4 }}
                  >
                    <MaterialCommunityIcons name="close" size={15} color={p.muted} />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {ompTab === "session" && thinkingLevels.length > 0 && activeModelData.canSwitch !== false ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                contentContainerStyle={{ paddingHorizontal: space.sm, paddingVertical: 6, gap: 6, alignItems: "center" }}
                style={{ maxHeight: 38, borderBottomWidth: 1, borderBottomColor: p.divider, backgroundColor: p.surface }}
              >
                <Text style={{ fontSize: 11, fontFamily: fonts.bodyBold, color: p.faint }}>思考</Text>
                {thinkingLevels.map((lvl) => {
                  const active = currentThinking === lvl.toLowerCase();
                  return (
                    <Pressable
                      key={lvl}
                      onPress={() => applyThinkingChoice(lvl)}
                      style={{
                        height: 24,
                        paddingHorizontal: 9,
                        borderRadius: 12,
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: active ? p.primary : p.divider,
                        backgroundColor: active ? p.accentContainer : p.surface2,
                      }}
                    >
                      <Text style={{ fontSize: 11, fontFamily: active ? fonts.bodyBold : fonts.bodySemi, color: active ? p.accentText : p.muted }}>
                        {effortLabel(lvl)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}
            {isOmp && ompTab === "session" && activeModelData.canSwitch !== false ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                contentContainerStyle={{ paddingHorizontal: space.sm, paddingVertical: 6, gap: 6, alignItems: "center" }}
                style={{ maxHeight: 38, borderBottomWidth: 1, borderBottomColor: p.divider, backgroundColor: p.surface }}
              >
                <Text style={{ fontSize: 11, fontFamily: fonts.bodyBold, color: p.faint }}>角色</Text>
                {OMP_QUICK_ROLE_CHIPS.map((slot) => {
                  const assigned = activeModelData.modelRoles?.[slot];
                  const assignedClean = assigned ? stripModelEffortSuffix(assigned).toLowerCase() : "";
                  const active = Boolean(assignedClean && resolvedLookupModel && assignedClean === resolvedLookupModel.toLowerCase());
                  return (
                    <Pressable
                      key={slot}
                      onPress={() => applyModelChoice(`@${slot}`)}
                      style={{
                        height: 24,
                        paddingHorizontal: 9,
                        borderRadius: 12,
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: active ? p.primary : p.divider,
                        backgroundColor: active ? p.accentContainer : p.surface2,
                      }}
                    >
                      <Text style={{ fontSize: 11, fontFamily: fonts.monoBold, color: active ? p.accentText : p.muted }}>
                        {`@${slot}`}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}
            {!activeModelData.canSwitch ? (
              <View style={{ paddingHorizontal: space.sm, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: p.divider, backgroundColor: p.surface2 }}>
                <Text style={{ fontSize: 11.5, color: p.error }}>{activeModelData.reason || "当前会话不支持切换模型"}</Text>
              </View>
            ) : null}
            {modelError ? (
              <View style={{ paddingHorizontal: space.sm, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: p.divider, backgroundColor: p.surface2 }}>
                <Text style={{ fontSize: 11.5, color: p.error }}>{modelError}</Text>
              </View>
            ) : null}
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="always" contentContainerStyle={{ padding: space.xs, gap: 2 }}>
              {showRoleOverview ? (
                OMP_MODEL_ROLES.map((slot) => {
                  const assigned = activeModelData.modelRoles?.[slot];
                  return (
                    <Pressable
                      key={slot}
                      disabled={activeModelData.canSwitch === false}
                      onPress={() => {
                        setEditingRole(slot);
                        setModelFilter("");
                      }}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        paddingHorizontal: space.sm,
                        paddingVertical: 8,
                        borderRadius: radius.sm,
                        backgroundColor: pressed ? p.surface3 : "transparent",
                        opacity: activeModelData.canSwitch === false ? 0.5 : 1,
                      })}
                    >
                      <MaterialCommunityIcons name="tune-variant" size={14} color={p.accentText} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 12.5, color: p.ink }}>
                          {`${slot} (${OMP_ROLE_LABELS[slot]})`}
                        </Text>
                        <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11, color: assigned ? p.accentText : p.faint }}>
                          {assigned || "未配置（点击选择）"}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 10.5, color: p.muted }}>分配</Text>
                      <MaterialCommunityIcons name="chevron-right" size={14} color={p.muted} />
                    </Pressable>
                  );
                })
              ) : modelLoading && !modelData && filteredModels.length === 0 ? (
                <View style={{ paddingVertical: 14, alignItems: "center" }}>
                  <PocketSpinner size={18} />
                </View>
              ) : filteredModels.length === 0 && !canCustom ? (
                <Text style={{ textAlign: "center", paddingVertical: 14, fontSize: 12.5, color: p.faint }}>没有找到匹配的模型</Text>
              ) : (
                <>
                  {filteredModels.map((m) => {
                    const active = editingRole
                      ? Boolean(roleTargetModel && m.id.toLowerCase() === stripModelEffortSuffix(roleTargetModel).toLowerCase())
                      : Boolean(resolvedLookupModel && resolvedLookupModel.toLowerCase() === m.id.toLowerCase());
                    const ctxHint = m.contextWindow && Number.isFinite(m.contextWindow)
                      ? m.contextWindow >= 1_000_000
                        ? `${(m.contextWindow / 1_000_000).toFixed(m.contextWindow % 1_000_000 === 0 ? 0 : 1)}M`
                        : `${Math.round(m.contextWindow / 1_000)}k`
                      : null;
                    return (
                      <Pressable
                        key={m.id}
                        disabled={activeModelData.canSwitch === false}
                        onPress={() => {
                          if (editingRole) applyRoleModelChoice(editingRole, m.id);
                          else applyModelChoice(m.id);
                        }}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                          paddingHorizontal: space.sm,
                          paddingVertical: 7,
                          borderRadius: radius.sm,
                          backgroundColor: pressed ? p.surface3 : active ? p.accentContainer : "transparent",
                          opacity: activeModelData.canSwitch === false ? 0.5 : 1,
                        })}
                      >
                        <ModelBrandIcon
                          model={m.id}
                          provider={m.provider}
                          label={m.label}
                          size={14}
                          color={active ? p.accentText : p.muted}
                        />
                        <Text
                          numberOfLines={1}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontFamily: active ? fonts.monoBold : fonts.mono,
                            fontSize: 12.5,
                            color: active ? p.accentText : p.ink,
                          }}
                        >
                          {m.id}
                        </Text>
                        {ctxHint ? (
                          <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: p.muted }}>{ctxHint}</Text>
                        ) : null}
                        <Text style={{ fontSize: 10.5, color: p.muted }}>
                          {m.source === "current" ? "当前" : m.source === "recent" ? "常用" : "目录"}
                        </Text>
                        {active ? <MaterialCommunityIcons name="check" size={14} color={p.accentText} /> : null}
                      </Pressable>
                    );
                  })}
                  {canCustom ? (
                    <Pressable
                      disabled={activeModelData.canSwitch === false}
                      onPress={() => {
                        if (editingRole) applyRoleModelChoice(editingRole, trimmedFilter);
                        else applyModelChoice(trimmedFilter);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                        paddingHorizontal: space.sm,
                        paddingVertical: 7,
                        borderRadius: radius.sm,
                        backgroundColor: pressed ? p.surface3 : "transparent",
                      })}
                    >
                      <ModelBrandIcon model={trimmedFilter} size={14} color={p.accentText} />
                      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontFamily: fonts.monoBold, fontSize: 12.5, color: p.accentText }}>
                        {editingRole ? `设为 ${editingRole}: ${trimmedFilter}` : `切换到 ${trimmedFilter}`}
                      </Text>
                      <Text style={{ fontSize: 10.5, color: p.muted }}>自定义</Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </ScrollView>
          </View>
        );
      })() : null}
      {showInput ? (
      <View
        style={{
          // Chat: the words get the full width and a toolbar sits under them. Terminal box: one row.
          flexDirection: mode === "chat" ? "column" : "row",
          gap: mode === "chat" ? 2 : space.sm,
          marginLeft: padLeft,
          marginRight: padRight,
          marginTop: space.xs,
          backgroundColor: p.surface,
          borderRadius: radius.xl,
          // The send button stays at the bottom while a long line grows upward.
          alignItems: mode === "chat" ? "stretch" : "flex-end",
          paddingLeft: mode === "chat" ? metrics.cardPadX : space.lg,
          paddingRight: metrics.cardPadX,
          paddingTop: mode === "chat" ? 2 : 6,
          paddingBottom: 6,
          borderWidth: 1,
          borderColor: p.dark ? p.surface3 : "#FBE3EC",
          shadowColor: p.shadow,
          shadowOpacity: p.dark ? 0 : 0.12,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: p.dark ? 0 : 2,
        }}
      >
        <RNTextInput
          value={text}
          onChangeText={setText}
          placeholder={!online ? "这台电脑离线了" : mode === "chat" ? (agent.status === "working" ? "正在忙，发送会加入排队…" : agent.isShell ? "输入终端命令（如 ls、git status）…" : "回它一句（输入 / 调用命令）…") : "输入到终端，发送时带回车"}
          placeholderTextColor={p.faint}
          editable={online}
          multiline={mode === "chat"}
          autoFocus={mode === "terminal"}
          autoCapitalize={mode === "terminal" || agent.isShell || text.startsWith("/") ? "none" : undefined}
          autoCorrect={mode === "chat" && !agent.isShell && !text.startsWith("/")}
          onSubmitEditing={mode === "terminal" ? send : undefined}
          style={
            mode === "chat"
              ? // Grows to about six lines, then scrolls.
                { fontFamily: fonts.body, fontSize: 15.5 * textScale, color: p.ink, minHeight: 44, maxHeight: Math.round(15.5 * textScale * 1.4 * 6) + 18, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 8 }
              : { flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: 14, color: p.ink, maxHeight: 120, paddingVertical: 9 }
          }
          accessibilityLabel="发送给 agent 的内容"
        />
        {mode === "chat" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: metrics.itemGap }}>
            <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: metrics.itemGap }}>
              <IconTile
                icon={extra ? "keyboardDown" : "keyboard"}
                size={metrics.iconBtnSize}
                active={extra}
                onPress={() => setExtra((v) => !v)}
                a11y={extra ? "收起快捷按键" : "显示回车、Esc、方向键等快捷按键"}
              />
              <IconTile icon="image" size={metrics.iconBtnSize} disabled={!online || picking} onPress={attach} a11y="添加图片，和消息一起发给它" />
              {!agent.isShell && (agent.source === "hc" || agent.source === "herdr") ? (
                <>
                  <Pressable
                    disabled={!online}
                    onPress={() => (modelOpen === "model" ? setModelOpen(false) : openModelPicker("model"))}
                    accessibilityRole="button"
                    accessibilityLabel={effectiveCurrentModel ? `当前模型 ${effectiveCurrentModel}，点击切换` : "切换模型"}
                    style={({ pressed }) => ({
                      flexShrink: 1,
                      minWidth: metrics.modelMinW,
                      maxWidth: metrics.modelMaxW,
                      height: metrics.pillHeight,
                      overflow: "hidden",
                      paddingHorizontal: metrics.pillPadX,
                      borderRadius: Math.round(metrics.pillHeight / 2),
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      backgroundColor: pressed ? p.surface3 : modelOpen === "model" ? p.accentContainer : p.surface2,
                      borderWidth: 1,
                      borderColor: modelOpen === "model" ? p.primary : p.divider,
                      opacity: online ? 1 : 0.45,
                    })}
                  >
                    {metrics.showModelIcon ? (
                      <ModelBrandIcon model={effectiveCurrentModel} size={14} color={p.accentText} />
                    ) : null}
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      style={{
                        flexShrink: 1,
                        minWidth: 0,
                        fontFamily: fonts.mono,
                        fontSize: width < 360 ? 11.5 : 12,
                        color: modelOpen === "model" ? p.accentText : p.ink,
                      }}
                    >
                      {effectiveCurrentModel ? effectiveCurrentModel.split("/").pop() : "模型"}
                    </Text>
                    <MaterialCommunityIcons
                      name={modelOpen === "model" ? "chevron-up" : "chevron-down"}
                      size={13}
                      color={modelOpen === "model" ? p.accentText : p.muted}
                      style={{ flexShrink: 0 }}
                    />
                  </Pressable>
                  {effectiveThinkingLevels.length > 0 ? (
                    <Pressable
                      disabled={!online}
                      onPress={() => (modelOpen === "thinking" ? setModelOpen(false) : openModelPicker("thinking"))}
                      accessibilityRole="button"
                      accessibilityLabel="切换思考等级"
                      style={({ pressed }) => ({
                        flexShrink: metrics.allowThinkingShrink ? 1 : 0,
                        minWidth: metrics.allowThinkingShrink ? metrics.thinkingMinW : undefined,
                        maxWidth: metrics.thinkingMaxW,
                        height: metrics.pillHeight,
                        overflow: "hidden",
                        paddingHorizontal: metrics.pillPadX,
                        borderRadius: Math.round(metrics.pillHeight / 2),
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        backgroundColor: pressed ? p.surface3 : modelOpen === "thinking" ? p.accentContainer : p.surface2,
                        borderWidth: 1,
                        borderColor: modelOpen === "thinking" ? p.primary : p.divider,
                        opacity: online ? 1 : 0.45,
                      })}
                    >
                      <MaterialCommunityIcons name="brain" size={14} color={p.accentText} style={{ flexShrink: 0 }} />
                      <Text
                        numberOfLines={1}
                        style={{
                          flexShrink: 1,
                          minWidth: 0,
                          fontFamily: fonts.bodySemi,
                          fontSize: 11.5,
                          color: modelOpen === "thinking" ? p.accentText : p.ink,
                        }}
                      >
                        {effectiveCurrentThinking ? effectiveCurrentThinking : "思考"}
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              ) : null}
            </View>
            <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
              {mode === "chat" && !agent.isShell ? (() => {
                const ct = usageData?.session?.contextTokens ?? agent.contextTokens;
                const cl = usageData?.session?.contextLimit ?? agent.contextLimit;
                const rawPct = usageData?.session?.contextPct ?? (cl && cl > 0 && ct !== undefined ? (ct / cl) * 100 : undefined);
                const label = rawPct !== undefined ? `${Math.round(Math.max(0, Math.min(100, rawPct)))}%` : "CTX";
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="查看上下文窗口与用量"
                    onPress={() => {
                      if (usageOpen) setUsageOpen(false);
                      else openUsageCard();
                    }}
                    style={({ pressed }) => ({
                      height: metrics.pillHeight,
                      paddingHorizontal: 8,
                      borderRadius: Math.round(metrics.pillHeight / 2),
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: pressed ? p.surface3 : usageOpen ? p.accentContainer : p.surface2,
                      borderWidth: 1,
                      borderColor: usageOpen ? p.primary : p.divider,
                    })}
                  >
                    <Text style={{ fontFamily: fonts.monoBold, fontSize: 11, color: usageOpen ? p.accentText : p.muted }}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })() : null}
              {online && agent.status === "working" && !text.trim() && !pictures.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="中断当前运行"
                  disabled={stopping}
                  onPress={stopAgent}
                  style={({ pressed }) => ({
                    width: metrics.actionHeight,
                    height: metrics.actionHeight,
                    borderRadius: Math.round(metrics.actionHeight / 2),
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? p.primaryPressed : p.primary,
                    opacity: stopping ? 0.55 : 1,
                  })}
                >
                  <View style={{ width: 11, height: 11, borderRadius: 2.5, backgroundColor: p.onPrimary }} />
                </Pressable>
              ) : (
                <>
                  {online && agent.status === "working" ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="中断当前运行"
                      disabled={stopping}
                      onPress={stopAgent}
                      style={({ pressed }) => ({
                        width: Math.max(30, metrics.actionHeight - 4),
                        height: Math.max(30, metrics.actionHeight - 4),
                        borderRadius: Math.round(Math.max(30, metrics.actionHeight - 4) / 2),
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: pressed ? p.surface3 : p.accentContainer,
                        opacity: stopping ? 0.55 : 1,
                      })}
                    >
                      <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: p.accentText }} />
                    </Pressable>
                  ) : null}
                  <SendPill
                    width={metrics.sendWidth}
                    height={metrics.actionHeight}
                    disabled={
                      !online ||
                      (isBtwDraft
                        ? !/^\/btw\s+\S/i.test(text.trim())
                        : !text.trim() && !pictures.length)
                    }
                    onPress={send}
                    a11y={
                      isBtwDraft
                        ? "发送旁路提问（不打断主线）"
                        : agent.status === "working"
                          ? "发送（运行中将自动排队）"
                          : "发送"
                    }
                  />
                </>
              )}
            </View>
          </View>
        ) : (
          <SendPill width={metrics.sendWidth} height={metrics.actionHeight} disabled={!text.trim() || !online} onPress={send} />
        )}
      </View>
      ) : null}
      <KeyLayoutDialog visible={tuning} onDismiss={() => setTuning(false)} />
      <PocketToast visible={!!toast} message={toast} tone="info" bottom={140} onDismiss={() => setToast(null)} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

export function InfoView({ agent, bottomInset }: { agent: Agent; bottomInset: number }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const device = useLive((s) => s.devices[agent.deviceId]);
  const look = harnessLook(agent.harness, agent.isShell);
  const ratio = agent.contextTokens && agent.contextLimit ? agent.contextTokens / agent.contextLimit : null;
  const row = (title: string, value: string | undefined | null, icon: string, mono = false) =>
    value ? (
      <View key={title} accessibilityLabel={`${title}：${value}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm + 2, minHeight: 56 }}>
        <MaterialCommunityIcons name={icon as PocketIcon} size={22} color={p.muted} style={{ marginTop: 6 }} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ fontSize: 13, color: p.muted }}>{title}</Text>
          <Text selectable numberOfLines={3} style={{ fontSize: 15, color: p.ink, fontFamily: mono ? fonts.mono : fonts.body }}>
            {value}
          </Text>
        </View>
      </View>
    ) : null;
  return (
    <ScrollView
      contentContainerStyle={{
        paddingTop: space.lg,
        paddingLeft: horizontalPad(space.lg, insets.left),
        paddingRight: horizontalPad(space.lg, insets.right),
        paddingBottom: bottomInset + space.xxl,
        gap: space.md,
      }}
    >
      {ratio != null ? (
        <View style={{ backgroundColor: p.surface, borderRadius: radius.card, padding: space.lg, gap: space.sm }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontFamily: fonts.bodyBold, color: p.ink }}>上下文用量</Text>
            <Text style={{ color: p.muted }}>
              {compactNum(agent.contextTokens)} / {compactNum(agent.contextLimit)}
            </Text>
          </View>
          <PocketProgress progress={Math.min(1, ratio)} color={ratio > 0.8 ? p.error : p.lavender} height={8} />
        </View>
      ) : null}
      <View style={{ backgroundColor: p.surface, borderRadius: radius.card, overflow: "hidden", paddingVertical: space.xs }}>
        {row("状态", `${agentStatusLabel(agent)} · ${relTime(agent.statusSince ?? agent.updatedAt)}`, "pulse")}
        {row("程序", look.label, "robot-outline")}
        {row("所在电脑", device?.name ?? agent.deviceId, "laptop")}
        {row("位置", agent.where, "tab")}
        {row("目录", shortPath(agent.cwd), "folder-outline", true)}
        {row("模型", agent.model, "brain")}
        {row("花费", money(agent.costUsd), "cash")}
        {row("轮次", agent.turn ? `第 ${agent.turn} 轮` : null, "counter")}
        {row("会话", agent.sessionKey, "message-text-outline", true)}
        {row("终端地址", `${agent.source}:${agent.localId}`, "console", true)}
      </View>
    </ScrollView>
  );
}
