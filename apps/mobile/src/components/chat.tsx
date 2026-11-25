import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent, type ViewProps } from "react-native";
import { FlashList, type FlashListRef, type ListRenderItem } from "@shopify/flash-list";
import { Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import {
  compareConvEvents,
  formatModelSwitchSummary,
  isCommandErrorOutput,
  isDismissedCommandOutput,
  parseLocalCommandOutputTag,
  parseModelSwitchEvent,
  parseSlashCommandTag,
  sameMessage,
  type Agent,
  type ChatDisplayMode,
  type ConvEvent,
  type SubSession,
} from "@herdr-pocket/protocol";
import { call, subscribe } from "../lib/relay";
import { splitPictures } from "../lib/attach";
import { followSends, forget, useCapturedCommands } from "../lib/outbox";
import { useLive, usePending, useSettings, type PendingSend } from "../lib/store";
import { fixCjkEmphasis, hasList } from "../lib/markdown";
import { openSub, SUB_STATUS, type Crumb } from "../lib/subnav";
import { parseTerminalChatTranscript, shellTurnMatchesCommand } from "../lib/terminalChat";
import { usePalette } from "../theme/theme";
import { brand, fonts, radius, space, statusColors, type Palette } from "../theme/tokens";
import { EmptyState, PocketToast } from "./ui";
import { PocketButton, PocketSpinner } from "./pocket";
import { Md } from "./md";
import { ReplyDots, SendMark } from "./outbox";
import { Sparkle } from "./Mascot";
import { CuteIcon } from "./icons";

const clock = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Event -> row folding
// ---------------------------------------------------------------------------

type ToolCall = Extract<ConvEvent, { kind: "tool_call" }>;
type ToolResult = Extract<ConvEvent, { kind: "tool_result" }>;

type MobileTurnEntry =
  | { kind: "tool"; item: Extract<Row, { type: "tool" }> }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "note"; id: string; summary: string; text: string };

export type Row =
  | { type: "user"; id: string; text: string; ts: number; injected?: string; pictures?: string[] }
  | { type: "assistant"; id: string; text: string; ts: number }
  | { type: "thinking"; id: string; text: string; defaultOpen?: boolean }
  | { type: "tool"; id: string; call: ToolCall; result?: ToolResult }
  /** A run of tool calls folded into one cohesive progressive block in standard/compact mode. */
  | {
      type: "tools";
      id: string;
      items: Extract<Row, { type: "tool" }>[];
      thoughts?: string[];
      notes?: Array<{ summary: string; text: string }>;
      entries?: MobileTurnEntry[];
      latestThought?: string;
      defaultOpen?: boolean;
    }
  /** Sent from this phone, not yet echoed by the session. */
  | { type: "pending"; id: string; text: string; ts: number; pictures?: string[]; send: PendingSend; agentKey: string }
  | { type: "terminal_queued"; id: string; text: string }
  | { type: "turn_end"; id: string; ts: number }
  | { type: "model_switch"; id: string; ts: number; label: string; model?: string; thinking?: string }
  | {
      type: "command_result";
      id: string;
      command: string;
      text: string;
      isError: boolean;
      panelState?: "none" | "closed" | "interactive_open";
      ts: number;
      captureId?: string;
    }
  | { type: "compact_notice"; id: string; summary: string; ts: number }
  | { type: "system"; id: string; text: string; summary: string; ts?: number };

function pushModelSwitch(
  rows: Row[],
  id: string,
  ts: number,
  sw: { model?: string; thinking?: string; rawLabel?: string },
): void {
  const prev = rows[rows.length - 1];
  if (prev?.type === "model_switch" && Math.abs(ts - prev.ts) <= 60_000) {
    const model = sw.model ?? prev.model;
    const thinking = sw.thinking ?? prev.thinking;
    const label =
      model || thinking
        ? formatModelSwitchSummary({ model, thinking })
        : sw.rawLabel ?? prev.label;
    rows[rows.length - 1] = { ...prev, model, thinking, label, ts };
    return;
  }
  const label =
    sw.model || sw.thinking
      ? formatModelSwitchSummary({ model: sw.model, thinking: sw.thinking })
      : sw.rawLabel ?? "切换模型";
  rows.push({ type: "model_switch", id, ts, label, model: sw.model, thinking: sw.thinking });
}

export function foldEvents(events: ConvEvent[], mode: ChatDisplayMode = "standard"): Row[] {
  const rows: Row[] = [];
  const toolIndex = new Map<string, number>();
  const defaultOpen = mode === "expanded";
  const lookaheadOutcome = (idx: number): "error" | "dismissed" | "output" | "model_switch" | null => {
    const cur = events[idx]!;
    for (let j = idx + 1; j < events.length; j += 1) {
      const next = events[j]!;
      if (Math.abs(next.ts - cur.ts) > 15_000) break;
      if (
        next.kind === "assistant_message" ||
        next.kind === "tool_call" ||
        (next.kind === "user_message" && !next.synthetic)
      ) {
        break;
      }
      if (next.kind !== "system") continue;
      const parsedOut = parseLocalCommandOutputTag(next.text);
      const body = (parsedOut?.body ?? next.text).trim();
      if (!body) continue;
      if (isDismissedCommandOutput(body)) return "dismissed";
      if (next.subtype === "command_error" || parsedOut?.isError || isCommandErrorOutput(body)) return "error";
      const nextSw = parseModelSwitchEvent(next);
      if (nextSw && (nextSw.model || nextSw.thinking || nextSw.ackOnly)) return "model_switch";
      if (next.subtype === "command_output" || parsedOut) return "output";
    }
    return null;
  };

const MOBILE_NOISY_SUBTYPES = new Set(["reminder", "自动插入", "system_message", "developer"]);
const MOBILE_NOISY_PREFIX_RE =
  /^\s*(?:<(?:SYSTEM_MESSAGE|ephemeral_message|session_context|INSTRUCTIONS|system-reminder|environment_context)\b|Base directory for this skill:\s+\S|\[Image:\s*original\b[^\]]*\]\s*$)/i;

function isMobileHiddenNoise(text: string, subtype?: string): boolean {
  const sub = subtype?.trim().toLowerCase();
  if (sub && MOBILE_NOISY_SUBTYPES.has(sub)) return true;
  if (subtype === "自动插入") return true;
  return MOBILE_NOISY_PREFIX_RE.test(text);
}

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.kind === "system") {
      const parsedOut = parseLocalCommandOutputTag(e.text);
      const cleanBody = (parsedOut?.body ?? e.text).trim();
      if (!cleanBody || isDismissedCommandOutput(cleanBody)) continue;
      if (mode !== "expanded" && isMobileHiddenNoise(cleanBody, e.subtype)) continue;
      const cmdTag = parseSlashCommandTag(e.text);
      if (e.subtype === "command" || cmdTag) {
        const nextOut = lookaheadOutcome(i);
        if (nextOut === "error" || nextOut === "dismissed" || nextOut === "output") continue;
        if (nextOut === "model_switch" && !parseModelSwitchEvent(e)) continue;
      }
    }

    switch (e.kind) {
      case "user_message": {
        const sw = parseModelSwitchEvent(e);
        if (sw) {
          const nextOut = lookaheadOutcome(i);
          if (nextOut === "error" || nextOut === "dismissed") break;
          if (!sw.ackOnly || sw.model || sw.thinking) pushModelSwitch(rows, e.id, e.ts, sw);
        } else if (e.synthetic) {
          if (e.text.trim() && (mode === "expanded" || !isMobileHiddenNoise(e.text, "自动插入"))) {
            rows.push({ type: "system", id: e.id, text: e.text, summary: systemSummary(e.text), ts: e.ts });
          }
        } else if (e.text.trim() || e.injected?.trim()) {
          rows.push({ type: "user", id: e.id, text: e.text, ts: e.ts, injected: e.injected?.trim() || undefined });
        }
        break;
      }
      case "assistant_message":
        if (e.text.trim()) rows.push({ type: "assistant", id: e.id, text: e.text, ts: e.ts });
        break;
      case "reasoning":
        if (e.text.trim()) rows.push({ type: "thinking", id: e.id, text: e.text, ...(defaultOpen ? { defaultOpen: true } : {}) });
        break;
      case "tool_call":
        toolIndex.set(e.call_id, rows.length);
        rows.push({ type: "tool", id: e.id, call: e });
        break;
      case "tool_result": {
        const iIdx = toolIndex.get(e.call_id);
        const row = iIdx == null ? undefined : rows[iIdx];
        if (row && row.type === "tool") row.result = e;
        break;
      }
      case "turn_end":
        if (rows.length && rows[rows.length - 1]?.type !== "turn_end") rows.push({ type: "turn_end", id: e.id, ts: e.ts });
        break;
      case "system": {
        const parsedOut = parseLocalCommandOutputTag(e.text);
        const cleanBody = (parsedOut?.body ?? e.text).trim();
        if (!cleanBody || isDismissedCommandOutput(cleanBody)) break;
        const subLower = e.subtype?.trim().toLowerCase();
        if (subLower === "compact" || subLower === "checkpoint" || subLower === "compact_boundary") {
          rows.push({ type: "compact_notice", id: e.id, summary: e.summary?.trim() || "上下文已压缩", ts: e.ts });
          break;
        }
        if (e.subtype === "command_output" || e.subtype === "command_error" || parsedOut) {
          const isError = e.subtype === "command_error" || Boolean(parsedOut?.isError) || isCommandErrorOutput(cleanBody);
          rows.push({
            type: "command_result",
            id: e.id,
            command: e.summary?.trim() || (isError ? "命令失败" : "命令输出"),
            text: cleanBody,
            isError,
            ts: e.ts,
          });
          break;
        }
        if (e.subtype === "model_switch") {
          const sw = parseModelSwitchEvent(e);
          if (sw) {
            if (!sw.ackOnly || sw.model || sw.thinking) pushModelSwitch(rows, e.id, e.ts, sw);
          } else if (e.summary?.trim() || e.text.trim()) {
            pushModelSwitch(rows, e.id, e.ts, { rawLabel: e.summary?.trim() || e.text.trim() });
          }
          break;
        }
        const sw = parseModelSwitchEvent(e);
        if (sw) {
          const nextOut = lookaheadOutcome(i);
          if (nextOut === "error" || nextOut === "dismissed") break;
          if (!sw.ackOnly || sw.model || sw.thinking) pushModelSwitch(rows, e.id, e.ts, sw);
        } else if (e.text.trim()) {
          rows.push({ type: "system", id: e.id, text: e.text, summary: e.summary?.trim() || systemSummary(e.text), ts: e.ts });
        }
        break;
      }
      default:
        break; // usage, turn_start: not shown
    }
  }
  return groupTools(rows, mode);
}

/** Fold runs of tool calls + adjacent thinking/system steps chronologically in standard/compact mode. */
function groupTools(rows: Row[], mode: ChatDisplayMode): Row[] {
  const out: Row[] = [];
  let pending: Array<Extract<Row, { type: "tool" | "thinking" | "system" }>> = [];
  const flush = () => {
    if (!pending.length) return;
    const tools = pending.filter((r): r is Extract<Row, { type: "tool" }> => r.type === "tool");
    const thoughts = pending.filter((r): r is Extract<Row, { type: "thinking" }> => r.type === "thinking").map((r) => r.text);
    const notes = pending
      .filter((r): r is Extract<Row, { type: "system" }> => r.type === "system")
      .map((r) => ({ summary: r.summary, text: r.text }));
    const entries: MobileTurnEntry[] = pending.map((r) =>
      r.type === "tool"
        ? { kind: "tool", item: r }
        : r.type === "thinking"
          ? { kind: "thinking", id: r.id, text: r.text }
          : { kind: "note", id: r.id, summary: r.summary, text: r.text },
    );
    const latestThought = thoughts.length ? thoughts[thoughts.length - 1] : undefined;
    if (tools.length === 0 && thoughts.length <= 1 && notes.length === 0) {
      out.push(...pending);
    } else if (tools.length === 0 && (mode === "expanded" || notes.length > 0 && thoughts.length === 0)) {
      out.push(...pending);
    } else if (tools.length === 1 && thoughts.length === 0 && notes.length === 0) {
      out.push(tools[0]!);
    } else {
      out.push({
        type: "tools",
        id: `g-${pending[0]!.id}`,
        items: tools,
        ...(thoughts.length ? { thoughts } : {}),
        ...(notes.length ? { notes } : {}),
        entries,
        ...(latestThought ? { latestThought } : {}),
        ...(mode === "expanded" ? { defaultOpen: true } : {}),
      });
    }
    pending = [];
  };
  for (const r of rows) {
    if (r.type === "tool" || (mode !== "expanded" && r.type === "system") || (mode === "compact" && r.type === "thinking")) {
      pending.push(r);
    } else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

/** Fallback one-liner for a system note without a hostd `summary`. */
function systemSummary(text: string): string {
  const first = text
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return "系统提醒";
  return first.length > 24 ? `${first.slice(0, 23)}…` : first;
}

/** Pretty-print JSON strings/values; leaves anything else as is. */
export function prettyMaybeJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "string") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  const t = v.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON */
    }
  }
  return v;
}

const MOBILE_PARTIAL_JSON_KEY_RE =
  /"(?:CommandLine|command|cmd|script|Path|file_path|TargetFile|DirectoryPath|path|Pattern|pattern|Query|query|Url|url|toolSummary|description|Summary|Prompt|prompt|Recipient)"\s*:\s*"((?:\\.|[^"])*)/i;

function cleanStepOneLine(raw: string): string {
  return raw.replace(/\\"/g, '"').replace(/\\n/g, " ").replace(/\\\\/g, "\\").replace(/\s+/g, " ").trim();
}

/** One-line human summary of a tool input (also unwraps JSON string payloads and streaming partials). */
export function toolSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    const t = input.trim();
    if (!t) return "";
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return toolSummary(parsed);
        }
      } catch {
        const m = MOBILE_PARTIAL_JSON_KEY_RE.exec(t);
        if (m?.[1]) {
          const s = cleanStepOneLine(m[1]).replace(/^["']+/, "");
          return s.length > 120 ? `${s.slice(0, 117)}…` : s;
        }
      }
    }
    const clean = cleanStepOneLine(t);
    return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
  }
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  for (const k of [
    "CommandLine",
    "command",
    "cmd",
    "script",
    "Path",
    "file_path",
    "TargetFile",
    "DirectoryPath",
    "path",
    "Pattern",
    "pattern",
    "Query",
    "query",
    "Url",
    "url",
    "toolSummary",
    "description",
    "Summary",
    "Prompt",
    "prompt",
    "Recipient",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      const clean = cleanStepOneLine(v);
      return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
    }
  }
  const s = JSON.stringify(o);
  return s === "{}" ? "" : s.length > 140 ? `${s.slice(0, 137)}…` : s;
}

function friendlyToolMeta(
  name: string,
  p: Palette,
): { label: string; icon: "console-line" | "file-edit-outline" | "file-document-outline" | "magnify" | "web" | "robot-outline" | "format-list-checks" | "wrench-outline"; bg: string; fg: string } {
  const n = name.trim().toLowerCase();
  if (/^(bash|shell|exec|run_command|command|command_status|send_command_input|terminal)$/.test(n)) {
    const c = statusColors("working", p.dark);
    return { label: "执行命令", icon: "console-line", bg: c.bg, fg: c.fg };
  }
  if (/^(read|read_file|view_file|view_file_outline|view_code_item|list_dir|files\.read|files\.list|cat)$/.test(n)) {
    return { label: "读取文件", icon: "file-document-outline", bg: p.dark ? "#22394D" : "#E5F3FF", fg: p.dark ? "#9CD0FA" : "#2D6A9E" };
  }
  if (/^(write|write_file|create_file)$/.test(n)) {
    return { label: "创建文件", icon: "file-edit-outline", bg: p.dark ? "#473026" : "#FFEADF", fg: p.dark ? "#FFB88F" : "#B0522A" };
  }
  if (/^(edit|edit_file|multiedit|apply_patch|replace_file_content|multi_replace_file_content)$/.test(n)) {
    return { label: "修改代码", icon: "file-edit-outline", bg: p.dark ? "#473026" : "#FFEADF", fg: p.dark ? "#FFB88F" : "#B0522A" };
  }
  if (/^(grep|glob|search|grep_search|find_by_name|ripgrep|rg|find)$/.test(n)) {
    return { label: "搜索代码", icon: "magnify", bg: p.dark ? "#22394D" : "#E5F3FF", fg: p.dark ? "#9CD0FA" : "#2D6A9E" };
  }
  if (/^(webfetch|websearch|search_web|read_url_content|fetch)$/.test(n)) {
    return { label: "浏览网页", icon: "web", bg: p.dark ? "#22394D" : "#E5F3FF", fg: p.dark ? "#9CD0FA" : "#2D6A9E" };
  }
  if (/^(task|agent|invoke_subagent|send_message|spawn_agent|subagent)$/.test(n)) {
    return { label: "子任务", icon: "robot-outline", bg: p.dark ? "#3B2433" : "#FFEAF2", fg: p.primary };
  }
  if (/^todo_?write$/.test(n)) {
    return { label: "更新清单", icon: "format-list-checks", bg: p.lavenderContainer, fg: p.dusk };
  }
  return { label: name, icon: "wrench-outline", bg: p.lavenderContainer, fg: p.dusk };
}

// Step icon & tint styling is provided uniformly by `friendlyToolMeta`.

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const mdCache = new WeakMap<Palette, Map<number, ReturnType<typeof makeMdStyles>>>();

/** Markdown styles for a look; the same object for the same palette and scale, so every bubble shares one renderer (see `Md`). */
export function mdStyles(p: Palette, scale: number) {
  let byScale = mdCache.get(p);
  if (!byScale) mdCache.set(p, (byScale = new Map()));
  let s = byScale.get(scale);
  if (!s) byScale.set(scale, (s = makeMdStyles(p, scale)));
  return s;
}

function makeMdStyles(p: Palette, scale: number) {
  const base = 15.5 * scale;
  return {
    body: { color: p.ink, fontFamily: fonts.body, fontSize: base, lineHeight: base * 1.55 },
    strong: { fontFamily: fonts.bodyBold, fontWeight: "700" as const },
    em: { fontStyle: "italic" as const },
    heading1: { fontFamily: fonts.cute, fontSize: base * 1.4, lineHeight: base * 1.9, color: p.ink },
    heading2: { fontFamily: fonts.cute, fontSize: base * 1.25, lineHeight: base * 1.7, color: p.ink },
    heading3: { fontFamily: fonts.bodyBold, fontSize: base * 1.1, color: p.ink },
    link: { color: p.accentText },
    bullet_list_icon: { color: p.accentText, marginTop: 1 },
    ordered_list_icon: { color: p.accentText },
    code_inline: {
      fontFamily: fonts.mono,
      fontSize: base * 0.86,
      backgroundColor: p.surface3,
      color: p.ink,
      borderRadius: radius.xs,
      paddingHorizontal: 4,
    },
    fence: {
      fontFamily: fonts.mono,
      fontSize: 12.5 * scale,
      lineHeight: 12.5 * scale * 1.55,
      backgroundColor: p.surface,
      color: p.ink,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: p.divider,
      padding: space.md,
    },
    code_block: { fontFamily: fonts.mono, fontSize: 12.5 * scale, backgroundColor: p.surface2, borderRadius: radius.sm, padding: space.md, borderWidth: 0 },
    blockquote: { backgroundColor: p.surface2, borderLeftColor: p.accentText, borderLeftWidth: 3, paddingHorizontal: space.md, borderRadius: radius.xs },
    hr: { backgroundColor: p.divider },
    table: { borderColor: p.divider, borderRadius: radius.xs },
    th: { padding: 6 },
    td: { padding: 6, borderColor: p.divider },
  };
}

/** Small tappable chip that expands into a monospace, height-capped, scrollable block. */
function FoldChip({ label, icon, body, align = "center", a11y }: { label: string; icon: "information-outline" | "paperclip" | "image-outline"; body: string; align?: "center" | "flex-end"; a11y: string }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ alignItems: open ? "stretch" : align, gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${a11y}，${open ? "点按收起" : "点按展开"}`}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
        style={({ pressed }) => ({
          alignSelf: open ? (align === "center" ? "center" : "flex-end") : undefined,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          maxWidth: "100%",
          minHeight: 30,
          paddingHorizontal: space.md,
          borderRadius: radius.pill,
          backgroundColor: pressed ? p.surface3 : p.surface2,
          borderWidth: 1,
          borderColor: p.divider,
        })}
      >
        <MaterialCommunityIcons name={icon} size={13} color={p.faint} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: p.faint, fontSize: 12, fontFamily: fonts.bodySemi }}>
          {label}
        </Text>
        <MaterialCommunityIcons name={open ? "chevron-up" : "chevron-down"} size={14} color={p.faint} />
      </Pressable>
      {open ? (
        <View style={{ backgroundColor: p.surface2, borderRadius: radius.sm, borderWidth: 1, borderColor: p.divider, maxHeight: 280, overflow: "hidden" }}>
          <ScrollView nestedScrollEnabled contentContainerStyle={{ padding: space.md }}>
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 17, color: p.muted }}>
              {body}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

/** `send`: sent from this phone and not in the conversation yet; its state shows under the bubble. */
const UserBubble = memo(function UserBubble({ text, injected, ts, send, agentKey, pictures, badge }: { text: string; injected?: string; ts?: number; send?: PendingSend; agentKey?: string; pictures?: string[]; badge?: string }) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  // Picture paths sent with a message (and Claude Code's [Image #n] marks) fold into a chip.
  const shown = useMemo(() => splitPictures(text), [text]);
  return (
    <View style={{ alignItems: "flex-end", paddingLeft: 48, gap: space.xs }}>
      {shown.text ? (
        <View style={{ backgroundColor: p.bubble, borderRadius: radius.card, borderBottomRightRadius: radius.xs, paddingHorizontal: space.lg, paddingVertical: space.md }}>
          <Text selectable style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 15.5 * scale * 1.5 }}>
            {shown.text}
          </Text>
        </View>
      ) : null}
      {pictures?.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs }}>
          {pictures.map((uri, i) => (
            <Image key={i} source={{ uri }} accessibilityLabel={`发送的第 ${i + 1} 张图片`} style={{ width: 64, height: 64, borderRadius: radius.sm, backgroundColor: p.surface2 }} />
          ))}
        </View>
      ) : shown.count ? (
        <FoldChip label={`图片 ×${shown.count}`} icon="image-outline" body={shown.lines.join("\n")} align="flex-end" a11y={`这条消息带了 ${shown.count} 张图片`} />
      ) : null}
      {injected ? <FoldChip label="附加内容" icon="paperclip" body={injected} align="flex-end" a11y="这条消息的附加内容" /> : null}
      {send && agentKey ? (
        <SendMark send={send} agentKey={agentKey} time={clock(send.ts)} />
      ) : badge ? (
        <Text style={{ color: p.accentText, fontSize: 11 }}>{badge}</Text>
      ) : ts ? (
        <Text style={{ color: p.faint, fontSize: 11 }}>{clock(ts)}</Text>
      ) : null}
    </View>
  );
});

/** Children of the session on screen, keyed by the parent tool_call that spawned them, plus card actions. */
const SubCtx = createContext<{
  byCall: Map<string, SubSession>;
  open: (s: SubSession) => void;
  agent?: Agent;
  onSwitchToTerminal?: () => void;
} | null>(null);

/** The agent's reply, always in full on the canvas surface matching t3code prose rhythm. */
const AssistantBlock = memo(function AssistantBlock({ text, ts }: { text: string; ts?: number }) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  const styles = mdStyles(p, scale);
  const md = useMemo(() => fixCjkEmphasis(text), [text]);
  return (
    <View style={{ alignItems: "flex-start", gap: 4 }}>
      <View
        style={{
          alignSelf: "stretch",
          paddingHorizontal: 2,
          paddingVertical: space.xxs,
        }}
      >
        <Md style={styles}>{md}</Md>
      </View>
      {ts ? <Text style={{ color: p.faint, fontSize: 11, paddingLeft: 2 }}>{clock(ts)}</Text> : null}
    </View>
  );
});

function ThinkingPill({ text, defaultOpen }: { text: string; defaultOpen?: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  useEffect(() => {
    setOpen(Boolean(defaultOpen));
  }, [defaultOpen]);
  const preview = useMemo(() => text.trim().split("\n").map((l) => l.trim()).find(Boolean) ?? "", [text]);
  const guideColor = p.dark ? "rgba(255,143,179,0.28)" : "#F7C8DC";
  return (
    <View style={{ alignSelf: "stretch", paddingRight: 14 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "收起思考过程" : "展开思考过程"}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          minHeight: 30,
          paddingHorizontal: 4,
          paddingVertical: 3,
          borderRadius: 9,
          backgroundColor: pressed ? p.surface2 : "transparent",
        })}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            backgroundColor: p.dark ? "#3B2433" : "#FFEAF2",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <MaterialCommunityIcons name="brain" size={13} color={p.primary} />
        </View>
        <Text style={{ fontFamily: fonts.bodySemi, fontSize: 12.5, color: p.muted, flexShrink: 0 }}>思考</Text>
        {!open && preview ? (
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: p.faint }}>
            {preview}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <MaterialCommunityIcons name={open ? "chevron-down" : "chevron-right"} size={14} color={p.faint} />
      </Pressable>
      {open ? (
        <View style={{ marginLeft: 14, paddingLeft: 11, marginTop: 3, marginBottom: 4, borderLeftWidth: 2, borderLeftColor: guideColor }}>
          <Text selectable style={{ color: p.muted, fontSize: 12.5, lineHeight: 18.5 }}>{text}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ToolSection({ title, body, error }: { title: string; body: string; error?: boolean }) {
  const p = usePalette();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: p.faint, fontSize: 11.5, fontFamily: fonts.bodyBold }}>{title}</Text>
      <View style={{ backgroundColor: error ? "transparent" : p.surface2, borderRadius: radius.sm, maxHeight: 320, overflow: "hidden" }}>
        <ScrollView nestedScrollEnabled contentContainerStyle={{ padding: space.sm }}>
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 17, color: error ? p.error : p.muted }}>
              {body}
            </Text>
          </ScrollView>
        </ScrollView>
      </View>
    </View>
  );
}

function ToolCard({ call: c, result, bare }: { call: ToolCall; result?: ToolResult; bare?: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const failed = result?.is_error;
  const pending = !result;
  const meta = friendlyToolMeta(c.name, p);
  const summary = toolSummary(c.input);
  const input = useMemo(() => (open ? prettyMaybeJson(c.input) : ""), [open, c.input]);
  const output = useMemo(() => (open ? prettyMaybeJson(result?.output ?? "") : ""), [open, result?.output]);
  const state = failed ? "失败" : pending ? "进行中" : "完成";
  const subs = useContext(SubCtx);
  const child = subs?.byCall.get(c.call_id);
  const guideColor = p.dark ? "rgba(255,143,179,0.28)" : "#F7C8DC";
  return (
    <View
      style={{
        alignSelf: "stretch",
        paddingRight: bare ? 0 : 14,
        backgroundColor: failed ? p.errorContainer : "transparent",
        borderRadius: 9,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`工具 ${meta.label}，${state}，${open ? "点按收起" : "点按查看输入和输出"}`}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: 4,
          paddingVertical: 3,
          minHeight: 30,
          borderRadius: 9,
          backgroundColor: pressed ? p.surface2 : "transparent",
        })}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            backgroundColor: failed ? p.errorContainer : meta.bg,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <MaterialCommunityIcons name={meta.icon} size={13} color={failed ? p.error : meta.fg} />
        </View>
        <Text style={{ fontFamily: fonts.bodySemi, color: failed ? p.error : p.ink, fontSize: 12.5, flexShrink: 0 }}>
          {meta.label}
        </Text>
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 11.5, color: p.faint }}>
          {summary}
        </Text>
        {pending ? (
          <PocketSpinner size={12} />
        ) : failed ? (
          <MaterialCommunityIcons name="alert-circle" size={14} color={p.error} />
        ) : (
          <CuteIcon
            name="done"
            size={13}
            color={statusColors("working", p.dark).fg}
            fill={p.dark ? "transparent" : statusColors("working", p.dark).bg}
            strokeWidth={2.4}
          />
        )}
        <MaterialCommunityIcons name={open ? "chevron-down" : "chevron-right"} size={14} color={p.faint} />
      </Pressable>
      {child && subs ? <SubLink s={child} onPress={() => subs.open(child)} /> : null}
      {open ? (
        <View style={{ marginLeft: 14, paddingLeft: 11, marginTop: 3, marginBottom: 4, borderLeftWidth: 2, borderLeftColor: guideColor, gap: space.sm }}>
          {input ? <ToolSection title="输入" body={input} /> : null}
          {result ? (
            <ToolSection title={failed ? "输出（出错）" : "输出"} body={output || "（没有输出）"} error={failed} />
          ) : (
            <Text style={{ color: p.faint, fontSize: 12 }}>还在运行，结果出来后会显示在这里</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** A run of tool calls on one compact borderless step line matching Desktop t3code × Pocket style. */
function ToolGroup({
  items: tools,
  thoughts,
  notes,
  entries,
  latestThought,
  defaultOpen,
}: {
  items: Extract<Row, { type: "tool" }>[];
  thoughts?: string[];
  notes?: Array<{ summary: string; text: string }>;
  entries?: MobileTurnEntry[];
  latestThought?: string;
  defaultOpen?: boolean;
}) {
  const p = usePalette();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  useEffect(() => {
    setOpen(Boolean(defaultOpen));
  }, [defaultOpen]);
  const subs = useContext(SubCtx);
  const failed = tools.filter((t) => t.result?.is_error).length;
  const running = tools.filter((t) => !t.result);
  const counts = new Map<string, number>();
  for (const t of tools) {
    const lbl = friendlyToolMeta(t.call.name, p).label;
    counts.set(lbl, (counts.get(lbl) ?? 0) + 1);
  }
  const names = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ");
  const current = running[running.length - 1];
  const children = tools.map((t) => subs?.byCall.get(t.call.call_id)).filter((s): s is SubSession => !!s);
  const thoughtText = latestThought || (thoughts?.length ? thoughts[thoughts.length - 1] : undefined);
  const guideColor = p.dark ? "rgba(255,143,179,0.28)" : "#F7C8DC";
  const currentMeta = current ? friendlyToolMeta(current.call.name, p) : null;
  const currentSummary = current ? toolSummary(current.call.input) : "";
  return (
    <View style={{ alignSelf: "stretch", paddingRight: 14 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${tools.length ? `用了 ${tools.length} 个工具` : `思考与记录（${entries?.length ?? thoughts?.length ?? 0}）`}${failed ? `，${failed} 个失败` : ""}${running.length ? "，还在运行" : ""}，${open ? "点按收起" : "点按展开"}`}
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          paddingHorizontal: 4,
          paddingVertical: 3,
          minHeight: 30,
          borderRadius: 9,
          backgroundColor: pressed ? p.surface2 : "transparent",
        })}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            backgroundColor: failed ? p.errorContainer : running.length ? (p.dark ? "#3B2433" : "#FFEAF2") : p.lavenderContainer,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {running.length ? (
            <PocketSpinner size={12} color={p.primary} />
          ) : (
            <MaterialCommunityIcons
              name={failed ? "alert-circle-outline" : "wrench-outline"}
              size={13}
              color={failed ? p.error : p.dusk}
            />
          )}
        </View>
        <Text style={{ fontFamily: fonts.bodySemi, color: failed ? p.error : p.ink, fontSize: 12.5, flexShrink: 0 }}>
          {tools.length ? (running.length ? `执行中 · ${tools.length} 步` : `${tools.length} 个步骤`) : `思考与分析（${thoughts?.length ?? 0}）`}
        </Text>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: p.faint }}>
          {names}
        </Text>
        {failed ? <Text style={{ color: p.error, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>{failed} 失败</Text> : null}
        <MaterialCommunityIcons name={open ? "chevron-down" : "chevron-right"} size={14} color={p.faint} />
      </Pressable>
      {!open && current && currentMeta ? (
        <Text numberOfLines={1} style={{ paddingLeft: 33, paddingBottom: 3, fontFamily: fonts.mono, fontSize: 11.5, color: p.muted }}>
          {currentMeta.label}{currentSummary ? ` · ${currentSummary}` : ""}
        </Text>
      ) : !open && running.length > 0 && thoughtText ? (
        <Text numberOfLines={1} style={{ paddingLeft: 33, paddingBottom: 3, fontSize: 11.5, color: p.muted }}>
          {thoughtText}
        </Text>
      ) : null}
      {!open && subs ? children.map((s) => <SubLink key={s.key} s={s} onPress={() => subs.open(s)} />) : null}
      {open ? (
        <View style={{ marginLeft: 14, paddingLeft: 10, marginTop: 3, marginBottom: 4, borderLeftWidth: 2, borderLeftColor: guideColor, gap: 2 }}>
          {entries?.length ? (
            entries.map((entry, idx) =>
              entry.kind === "thinking" ? (
                <ThinkingPill key={`${entry.id}-${idx}`} text={entry.text} />
              ) : entry.kind === "note" ? (
                <FoldChip key={`${entry.id}-${idx}`} label={entry.summary} icon="information-outline" body={entry.text} a11y={`系统提醒：${entry.summary}`} />
              ) : (
                <ToolCard key={entry.item.id} call={entry.item.call} result={entry.item.result} bare />
              ),
            )
          ) : (
            <>
              {thoughts?.map((t, i) => (
                <ThinkingPill key={`th-${i}`} text={t} />
              ))}
              {tools.map((r) => (
                <ToolCard key={r.id} call={r.call} result={r.result} bare />
              ))}
              {notes?.map((n, i) => (
                <FoldChip key={`nt-${i}`} label={n.summary} icon="information-outline" body={n.text} a11y={`系统提醒：${n.summary}`} />
              ))}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function SubLink({ s, onPress }: { s: SubSession; onPress: () => void }) {
  const p = usePalette();
  const c = statusColors(s.status === "working" ? "working" : "idle", p.dark);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看子 agent 对话，${SUB_STATUS[s.status]}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 44,
        marginHorizontal: space.sm,
        marginBottom: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.sm,
        backgroundColor: pressed ? p.surface3 : p.lavenderContainer,
      })}
    >
      <MaterialCommunityIcons name="source-branch" size={16} color={p.ink} />
      <Text style={{ flex: 1, color: p.ink, fontFamily: fonts.bodyBold, fontSize: 13.5 }}>查看子 agent 对话</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />
        <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>{SUB_STATUS[s.status]}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={18} color={p.muted} />
    </Pressable>
  );
}

function TurnEnd({ ts }: { ts?: number }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs }}>
      <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
      <Sparkle size={10} color={p.dark ? p.lavender : brand.blush} />
      <Text style={{ color: p.faint, fontSize: 11.5, fontFamily: fonts.cute }}>这一轮结束{ts ? ` · ${clock(ts)}` : ""}</Text>
      <Sparkle size={10} color={p.dark ? p.lavender : brand.blush} />
      <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
    </View>
  );
}

function ModelSwitchBanner({ label, ts }: { label: string; ts: number }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 2 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          maxWidth: "82%",
          backgroundColor: p.surface2,
          borderWidth: 1,
          borderColor: p.divider,
          borderRadius: radius.pill,
          paddingHorizontal: 10,
          paddingVertical: 3,
        }}
      >
        <MaterialCommunityIcons name="cpu-64-bit" size={13} color={p.muted} />
        <Text numberOfLines={1} style={{ flexShrink: 1, color: p.ink, fontSize: 11.5, fontFamily: fonts.bodyBold }}>
          {label}
        </Text>
        <Text style={{ color: p.faint, fontSize: 11, fontFamily: fonts.mono }}>{clock(ts)}</Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
    </View>
  );
}

/**
 * The strip under the newest message: the working badge or the reply dots, then the space above the
 * composer. It is the list's first row (the list is inverted) rather than its header, so when it
 * changes the rows are laid out again like for any other row, and a reader's place is kept across it.
 */
type EndRow = {
  type: "end";
  id: string;
  working: boolean;
  since?: number;
  now: number;
  awaiting: boolean;
  inset: number;
  onStop?: () => void;
  stopping?: boolean;
};
type ListRow = Row | EndRow;
const END_ID = "\u0000end";

const ROW_GAP = { height: space.md };

/** Space between chat rows; a fixed component, so a list re-render does not remount every separator. */
function RowGap({ leadingItem }: { leadingItem?: ListRow }) {
  return leadingItem?.type === "end" ? null : <View style={ROW_GAP} />;
}

/** FlashList draws a row's separator after the row, which an inverted list turns to the newer side; draw it above. */
const SEPARATOR_ABOVE = { flexDirection: "column-reverse" } as const;
function Cell({ style, ...rest }: ViewProps) {
  return <View {...rest} style={[style, SEPARATOR_ABOVE]} />;
}

/** Android inverts the list by rotating it, which puts the scrollbar on the left; this moves it back (FlatList passes the same). */
const SCROLLBAR_RIGHT = { isInvertedVirtualizedList: true };
/** The chat keeps a reader's place itself (ChatView's keepReading). */
const NO_MVCP = { disabled: true };

const rowType = (r: ListRow) => r.type;

function MobileCommandCard({
  row,
}: {
  row: Extract<Row, { type: "command_result" }>;
}) {
  const p = usePalette();
  const ctx = useContext(SubCtx);
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => (row.text ? row.text.split("\n") : []), [row.text]);
  const collapsible = lines.length > 14;
  const shownText = collapsible && !expanded ? lines.slice(0, 14).join("\n") : row.text;
  const interactive = row.panelState === "interactive_open";

  return (
    <View
      style={{
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: row.isError ? p.error : interactive ? p.accentText : p.divider,
        backgroundColor: p.surface2,
        padding: space.md,
        gap: space.sm,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <MaterialCommunityIcons
          name={row.isError ? "alert-circle-outline" : "console"}
          size={14}
          color={row.isError ? p.error : p.accentText}
        />
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.monoBold, fontSize: 12, color: row.isError ? p.error : p.ink }}>
          {row.command}
        </Text>
        {row.ts > 0 ? <Text style={{ color: p.faint, fontSize: 11 }}>{clock(row.ts)}</Text> : null}
        {row.captureId && ctx?.agent ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭输出卡片"
            onPress={() => useCapturedCommands.getState().dismiss(ctx.agent!.key, row.captureId!)}
            style={{ padding: 2 }}
          >
            <MaterialCommunityIcons name="close" size={14} color={p.muted} />
          </Pressable>
        ) : null}
      </View>
      {shownText ? (
        <View style={{ borderRadius: radius.sm, backgroundColor: p.surface, padding: space.sm, borderWidth: 1, borderColor: p.divider }}>
          <Text selectable style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, color: p.ink }}>
            {shownText}
          </Text>
        </View>
      ) : null}
      {collapsible || interactive ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" }}>
          {collapsible ? (
            <Pressable onPress={() => setExpanded((v) => !v)}>
              <Text style={{ color: p.accentText, fontSize: 12, fontWeight: "600" }}>
                {expanded ? "收起输出" : `展开全部（${lines.length} 行）`}
              </Text>
            </Pressable>
          ) : null}
          {interactive && ctx?.onSwitchToTerminal ? (
            <PocketButton size="sm" variant="primary" onPress={ctx.onSwitchToTerminal}>
              切到终端继续操作
            </PocketButton>
          ) : null}
          {interactive && ctx?.agent ? (
            <PocketButton
              size="sm"
              variant="ghost"
              onPress={() => {
                void call(ctx.agent!.deviceId, "terminal.keys", { agent: ctx.agent!.key, keys: ["esc"] }).catch(() => {});
                if (row.captureId) useCapturedCommands.getState().markPanelClosed(ctx.agent!.key, row.captureId);
              }}
            >
              关闭面板 (Esc)
            </PocketButton>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const renderRow: ListRenderItem<ListRow> = ({ item }) => {
  switch (item.type) {
    case "end":
      return (
        <View style={{ paddingBottom: item.inset }}>
          {item.working ? <WorkingBadge since={item.since} now={item.now} onStop={item.onStop} stopping={item.stopping} /> : item.awaiting ? <ReplyDots /> : null}
        </View>
      );
    case "user":
      return <UserBubble text={item.text} injected={item.injected} ts={item.ts} pictures={item.pictures} />;
    case "pending":
      return <UserBubble text={item.text} pictures={item.pictures} send={item.send} agentKey={item.agentKey} />;
    case "terminal_queued":
      return <UserBubble text={item.text} badge="终端排队中 · 本轮结束后自动处理" />;
    case "tools":
      return (
        <ToolGroup
          items={item.items}
          thoughts={item.thoughts}
          notes={item.notes}
          entries={item.entries}
          latestThought={item.latestThought}
          defaultOpen={item.defaultOpen}
        />
      );
    case "assistant":
      return <AssistantBlock text={item.text} ts={item.ts} />;
    case "thinking":
      return <ThinkingPill text={item.text} defaultOpen={item.defaultOpen} />;
    case "tool":
      return <ToolCard call={item.call} result={item.result} />;
    case "command_result":
      return <MobileCommandCard row={item} />;
    case "compact_notice":
      return <ModelSwitchBanner label={item.summary} ts={item.ts} />;
    case "turn_end":
      return null;
    case "model_switch":
      return <ModelSwitchBanner label={item.label} ts={item.ts} />;
    case "system":
      return <FoldChip label={item.summary} icon="information-outline" body={item.text} a11y={`系统提醒：${item.summary}`} />;
  }
};


// ---------------------------------------------------------------------------
// Chat view
// ---------------------------------------------------------------------------

export function ChatView({
  agent,
  active,
  bottomInset,
  sub,
  childCount,
  trail = [],
  onSwitchToTerminal,
}: {
  agent: Agent;
  active: boolean;
  bottomInset: number;
  /** Read a subagent session of this agent instead of its own. */
  sub?: string;
  /** Known number of children of the session on screen (enables `session.children`). */
  childCount?: number;
  trail?: Crumb[];
  onSwitchToTerminal?: () => void;
}) {
  if (agent.isShell && !agent.sessionKey && !sub) {
    return <ShellChatView agent={agent} active={active} bottomInset={bottomInset} />;
  }
  return (
    <SessionChatView
      agent={agent}
      active={active}
      bottomInset={bottomInset}
      sub={sub}
      childCount={childCount}
      trail={trail}
      onSwitchToTerminal={onSwitchToTerminal}
    />
  );
}

function ShellChatView({ agent, active, bottomInset }: { agent: Agent; active: boolean; bottomInset: number }) {
  const p = usePalette();
  const [liveScreen, setLiveScreen] = useState<string>("");
  const sendsAll = usePending((s) => s.byAgent[agent.key]);
  const patchSend = usePending((s) => s.update);
  const hasRecentSend = Boolean(sendsAll?.some((s) => Date.now() - s.ts < 15_000));

  const q = useQuery({
    queryKey: ["terminal.read", agent.key],
    queryFn: () => call(agent.deviceId, "terminal.read", { agent: agent.key, lines: 200 }),
    enabled: active,
    refetchInterval: active ? (hasRecentSend ? 1500 : 4000) : false,
  });

  useEffect(() => {
    if (!active) return;
    return subscribe(agent.deviceId, "terminal", { agent: agent.key, history: 180 }, (ev) => {
      if (ev?.kind === "terminal" && ev.screen) {
        const s = ev.screen as { text?: string; ansi?: string };
        if (typeof s.text === "string" || typeof s.ansi === "string") {
          setLiveScreen(s.text || s.ansi || "");
        }
      }
    });
  }, [active, agent.deviceId, agent.key]);

  const rawText = liveScreen || q.data?.text || q.data?.ansi || "";
  const parsed = useMemo(() => parseTerminalChatTranscript(rawText), [rawText]);

  const matchedIds = useMemo(() => {
    if (!sendsAll?.length || !parsed.turns.length) return [];
    const hit: string[] = [];
    for (const s of sendsAll) {
      if (parsed.turns.some((t) => shellTurnMatchesCommand(t, s.text))) hit.push(s.id);
    }
    return hit;
  }, [parsed.turns, sendsAll]);

  useEffect(() => {
    if (!matchedIds.length) return;
    const matched = sendsAll?.filter((s) => matchedIds.includes(s.id) && s.state !== "sent") ?? [];
    for (const m of matched) patchSend(agent.key, m.id, { state: "sent", error: undefined });
    const dropIds = (sendsAll ?? [])
      .filter((s) => matchedIds.includes(s.id) && parsed.turns.some((t) => shellTurnMatchesCommand(t, s.text) && (t.hasNextPrompt || t.outputLines.length > 0)))
      .map((s) => s.id);
    if (dropIds.length) forget(agent.key, dropIds);
  }, [agent.key, matchedIds, parsed.turns, patchSend, sendsAll]);

  const unmatchedPending = useMemo(
    () => (sendsAll ?? []).filter((s) => !parsed.turns.some((t) => shellTurnMatchesCommand(t, s.text))),
    [parsed.turns, sendsAll],
  );

  if (q.isLoading && !rawText) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm }}>
        <PocketSpinner size={26} />
        <Text style={{ color: p.faint, fontSize: 12 }}>正在读取终端输出…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: space.lg,
        paddingTop: space.md,
        paddingBottom: bottomInset + space.xxl,
        gap: space.md,
        flexGrow: 1,
      }}
    >
      {parsed.preambleLines.length > 0 ? (
        <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, borderWidth: 1, borderColor: p.divider, padding: space.md }}>
          <Text selectable style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: p.muted }}>
            {parsed.preambleLines.join("\n")}
          </Text>
        </View>
      ) : null}

      {parsed.turns.map((turn) => (
        <View key={turn.id} style={{ gap: space.xs }}>
          <UserBubble text={turn.command} />
          {turn.outputLines.length > 0 ? (
            <View style={{ alignSelf: "stretch", backgroundColor: p.surface, borderRadius: radius.md, borderWidth: 1, borderColor: p.divider, paddingHorizontal: space.md, paddingVertical: space.sm }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: p.ink }}>
                  {turn.outputLines.join("\n")}
                </Text>
              </ScrollView>
            </View>
          ) : turn.completedEmpty ? (
            <View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: p.surface2, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6, borderWidth: 1, borderColor: p.divider }}>
              <CuteIcon name="done" size={14} color={statusColors("working", p.dark).fg} fill={p.dark ? "transparent" : statusColors("working", p.dark).bg} strokeWidth={2.4} />
              <Text style={{ color: p.muted, fontSize: 12, fontFamily: fonts.bodySemi }}>已执行（无输出）</Text>
            </View>
          ) : (
            <ReplyDots />
          )}
        </View>
      ))}

      {unmatchedPending.map((item) => (
        <View key={item.id} style={{ gap: space.xs }}>
          <UserBubble text={item.text} send={item} agentKey={agent.key} />
          {item.state === "sent" ? <ReplyDots /> : null}
        </View>
      ))}

      {!parsed.turns.length && !unmatchedPending.length ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            mood="sleepy"
            title="终端对话视图"
            body="直接在这里输入终端命令（如 ls、pwd、git status），命令与输出结果会以对话气泡展示。"
          />
        </View>
      ) : null}
    </ScrollView>
  );
}

function SessionChatView({
  agent,
  active,
  bottomInset,
  sub,
  childCount,
  trail = [],
  onSwitchToTerminal,
}: {
  agent: Agent;
  active: boolean;
  bottomInset: number;
  sub?: string;
  childCount?: number;
  trail?: Crumb[];
  onSwitchToTerminal?: () => void;
}) {
  const p = usePalette();
  const [older, setOlder] = useState<ConvEvent[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // The session the agent is on. A new one (a fresh start, `/clear`) is another conversation: its file
  // positions do not continue the old one's. A moment without a match keeps the last one.
  const [session, setSession] = useState(agent.sessionKey);
  if (agent.sessionKey && agent.sessionKey !== session) setSession(agent.sessionKey);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "stale" | "error">("connecting");
  const [waitingForSession, setWaitingForSession] = useState(false);
  const linkOnline = useLive((s) => s.link === "online");
  const q = useQuery({
    queryKey: ["session.events", agent.key, sub ?? null, session ?? null],
    // One screenful first; older pages load as the list is scrolled up.
    queryFn: () => call(agent.deviceId, "session.events", { agent: agent.key, sub, limit: 60 }),
    enabled: active,
    // Recover missed events while the stream is unavailable or still finding a session.
    refetchInterval: !active || (!linkOnline && streamState !== "live") ? false : streamState === "live" && !!session ? 30_000 : 3000,
  });
  // Everything received for this conversation, by id. The newest page slides forward as the agent works;
  // without this, events between the older pages and the current page would silently disappear.
  const [liveEvents, setLiveEvents] = useState<ConvEvent[]>([]);
  // Another conversation starts empty, and each newest page the query brings is merged in. Done while
  // rendering (React's way to adjust state to new props), so a frame never shows the old conversation.
  const conv = `${agent.key}\n${sub ?? ""}\n${session ?? ""}`;
  const [synced, setSynced] = useState<{ conv: string; page: typeof q.data }>({ conv, page: undefined });
  if (synced.conv !== conv || synced.page !== q.data) {
    const fresh = synced.conv !== conv;
    setSynced({ conv, page: q.data });
    let next = fresh ? [] : liveEvents;
    if (fresh) {
      setOlder([]);
      setOlderCursor(undefined);
      setStreamState("connecting");
    }
    const page = q.data?.events;
    if (page?.length) {
      const oldestNew = posOf(page[0]!);
      const newestOld = next.length ? posOf(next[next.length - 1]!) : null;
      // The page no longer touches what we hold (long time away): what lies between is unknown, so start over from the page.
      if (newestOld !== null && oldestNew !== null && oldestNew > newestOld && !next.some((e) => e.id === page[0]!.id)) {
        setOlder([]);
        setOlderCursor(undefined);
        next = page;
      } else next = mergeEvents(next, page);
    }
    if (next !== liveEvents) setLiveEvents(next);
  }
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const hasPageDataRef = useRef(q.data !== undefined);
  const flushBufferedRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    hasPageDataRef.current = q.data !== undefined;
    if (q.data !== undefined) flushBufferedRef.current?.();
  }, [conv, q.data]);
  useEffect(() => {
    if (!active) return;
    let opened = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let pageSettled = hasPageDataRef.current;
    let buffered: ConvEvent[] = [];
    let bufferTimer: ReturnType<typeof setTimeout> | undefined;
    const flushBuffer = () => {
      clearTimeout(bufferTimer);
      bufferTimer = undefined;
      pageSettled = true;
      if (buffered.length) {
        const batch = buffered;
        buffered = [];
        setLiveEvents((old) => mergeEvents(old, batch));
      }
    };
    flushBufferedRef.current = flushBuffer;
    if (!pageSettled) {
      // Wait briefly for the initial session.events page so replayed SSE frames merge in one ordered pass.
      bufferTimer = setTimeout(flushBuffer, 1500);
    }
    const stop = subscribe(agent.deviceId, "session", { agent: agent.key, sub }, (event) => {
      if (event?.kind === "session" && event.event) {
        const e = event.event as ConvEvent;
        if (!pageSettled) {
          buffered.push(e);
          if (hasPageDataRef.current) flushBuffer();
        } else {
          setLiveEvents((old) => mergeEvents(old, [e]));
        }
        setStreamState("live");
      } else if (event?.kind === "stale") setStreamState("stale");
      else if (event?.kind === "alive") setStreamState("live");
    }, (state) => {
      setWaitingForSession(state.code === "not_found" && !sub && !session);
      setStreamState(state.status === "open" ? "live" : "error");
      // A stream that reopens after a drop may have missed events; the page query fills them in.
      if (state.status === "open") {
        failures.current = 0;
        clearTimeout(retry);
        retry = undefined;
        if (opened) void q.refetch();
        opened = true;
      } else {
        // Refused, or ended because the computer went away: try again a little later.
        retry ??= setTimeout(() => {
          setStreamState("connecting");
          setAttempt((n) => n + 1);
        }, Math.min(30_000, 3000 * 2 ** failures.current++));
      }
    });
    return () => {
      clearTimeout(retry);
      clearTimeout(bufferTimer);
      if (flushBufferedRef.current === flushBuffer) flushBufferedRef.current = null;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, agent.deviceId, agent.key, sub, session, attempt]);
  useEffect(() => {
    if (active && linkOnline && !q.isFetching) void q.refetch();
    // The socket may have come back before the stream is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, linkOnline]);
  const kids = useQuery({
    queryKey: ["session.children", agent.key, sub ?? null],
    queryFn: () => call(agent.deviceId, "session.children", { agent: agent.key, sub }),
    enabled: active && (childCount ?? 0) > 0,
    refetchInterval: active && (sub || agent.status === "working") ? 3000 : active ? 10_000 : false,
    retry: false,
  });
  const subCtx = useMemo(() => {
    const byCall = new Map<string, SubSession>();
    for (const s of kids.data?.sessions ?? []) if (s.parentCall) byCall.set(s.parentCall, s);
    return {
      byCall,
      open: (s: SubSession) => openSub(agent.key, trail, s),
      agent,
      onSwitchToTerminal,
    };
  }, [kids.data, agent, trail, onSwitchToTerminal]);

  const events = useMemo(() => {
    const seen = new Set(liveEvents.map((e) => e.id));
    return [...older.filter((e) => !seen.has(e.id)), ...liveEvents];
  }, [older, liveEvents]);

  // Messages sent from this phone show at once and give way to the session's own copy (lib/outbox).
  const sendsAll = usePending((s) => (sub ? undefined : s.byAgent[agent.key]));
  const patchSend = usePending((s) => s.update);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!sendsAll?.length && agent.status !== "working") return;
    const t = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, [sendsAll?.length, agent.status]);
  const chatDisplayMode = useSettings((s) => s.chatDisplayMode);
  const capturedCommands = useCapturedCommands((s) => s.byAgent[agent.key]);
  const folded = useMemo(() => foldEvents(events, chatDisplayMode), [events, chatDisplayMode]);
  const convForFollow = useMemo(
    () =>
      folded.map((r) => ({
        type: r.type,
        id: r.id,
        ts: "ts" in r ? r.ts : undefined,
        text: "text" in r ? r.text : undefined,
        summary: r.type === "system" ? r.summary : r.type === "command_result" ? r.command : undefined,
        label: r.type === "model_switch" ? r.label : undefined,
      })),
    [folded],
  );
  const sends = useMemo(() => followSends(sendsAll ?? [], convForFollow, { status: agent.status, queued: agent.queued }, nowTick), [sendsAll, convForFollow, agent.status, agent.queued, nowTick]);
  useEffect(() => {
    for (const x of sends.patches) patchSend(agent.key, x.id, x.patch);
    if (sends.drop.length) forget(agent.key, sends.drop);
  }, [sends, patchSend, agent.key]);

  const rawTerminalQueued = useMemo(
    () =>
      sub
        ? []
        : agent.queuedItems?.length
          ? agent.queuedItems
          : agent.queued && agent.queuedText
            ? [agent.queuedText]
            : [],
    [sub, agent.queued, agent.queuedItems, agent.queuedText],
  );
  const terminalQueuedItems = useMemo(
    () => rawTerminalQueued.filter((t) => t.trim() && !(sendsAll ?? []).some((x) => !x.echo && sameMessage(t, x.text))),
    [rawTerminalQueued, sendsAll],
  );

  // Inverted list: newest first. The session's copy of a message from this phone keeps its bubble's key.
  const rows = useMemo(
    () =>
      [
        ...folded.map((r): Row => {
          const x = r.type === "user" ? sends.echoes.get(r.id) : undefined;
          return r.type === "user" && x ? { ...r, id: x.id, pictures: x.pictures } : r;
        }),
        ...sends.shown.map((x): Row => ({ type: "pending", id: x.id, text: x.text, ts: x.ts, pictures: x.pictures, send: x, agentKey: agent.key })),
        ...(capturedCommands ?? []).map(
          (c): Row => ({
            type: "command_result",
            id: c.id,
            captureId: c.id,
            command: c.command,
            text: c.output,
            isError: c.isError,
            panelState: c.panelState,
            ts: c.ts,
          }),
        ),
        ...terminalQueuedItems.map((text, idx): Row => ({ type: "terminal_queued", id: `term-q-${idx}-${text.slice(0, 24)}`, text })),
      ].reverse(),
    [folded, sends, agent.key, capturedCommands, terminalQueuedItems],
  );
  const working = !sub && agent.status === "working";
  const [stopping, setStopping] = useState(false);
  const stopTurn = useCallback(() => {
    if (stopping) return;
    setStopping(true);
    void call(agent.deviceId, "terminal.interrupt", { agent: agent.key })
      .catch(() => undefined)
      .finally(() => setStopping(false));
  }, [agent.deviceId, agent.key, stopping]);
  const end = useMemo(
    (): EndRow => ({
      type: "end",
      id: END_ID,
      working,
      since: agent.statusSince,
      now: working ? nowTick : 0,
      awaiting: !working && !!sends.awaiting,
      inset: bottomInset + space.md,
      onStop: !sub ? stopTurn : undefined,
      stopping,
    }),
    [working, agent.statusSince, nowTick, sends.awaiting, bottomInset, sub, stopTurn, stopping],
  );
  const more = olderCursor === undefined ? q.data?.more : olderCursor !== null;

  const listRef = useRef<FlashListRef<ListRow>>(null);
  const busyRef = useRef(false);
  /** Until this time, keep pushing to the top as rows get measured (virtualised list). */
  const toTopUntil = useRef(0);
  const [jumping, setJumping] = useState<{ loaded: number } | null>(null);
  const [capped, setCapped] = useState(false);
  // Inverted list: offset 0 is the newest message. The offset lives in a ref and only crossing
  // an edge re-renders, so scrolling does not re-render the whole conversation every 64 ms.
  const view = useRef({ y: 0, h: 0, content: 0 });
  const [edges, setEdges] = useState({ bottom: true, top: false });
  /**
   * At the newest message: the list stays there when it grows (new rows, the working badge) or
   * shrinks (keyboard, the choice card). Only the user's own scrolling leaves it; the list's own
   * moves while it lays out rows do not.
   */
  const stick = useRef(true);
  const dragging = useRef(false);
  const latestSend = sendsAll?.[sendsAll.length - 1]?.id;
  const seenSend = useRef(latestSend);
  useEffect(() => {
    const added = latestSend && latestSend !== seenSend.current && sendsAll?.at(-1)?.state === "sending";
    seenSend.current = latestSend;
    if (!added) return;
    stick.current = true;
    dragging.current = false;
    toTopUntil.current = 0;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setEdges((e) => e.bottom ? e : { ...e, bottom: true });
  }, [latestSend, sendsAll]);
  const measureEdges = useCallback(() => {
    const { y, h, content } = view.current;
    const bottom = y < 48;
    const top = content > 0 && y + h >= content - 48;
    if (dragging.current) stick.current = bottom;
    setEdges((e) => (e.bottom === bottom && e.top === top ? e : { bottom, top }));
  }, []);
  /**
   * Away from the newest message, the row at the top of the screen holds its place while rows under it
   * grow or arrive (a streamed reply, a new message), as in a list that is not inverted. FlashList's own
   * keeping anchors the row at the bottom edge, which an inverted list turns into the newest row; so it
   * is off, and this anchors the top row's far end instead (the end that stays put while a row grows).
   */
  const hold = useRef<{ key: string; rel: number } | null>(null);
  const corrected = useRef(0);
  const captureHold = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const { endIndex } = list.computeVisibleIndices();
    const row = list.props.data?.[endIndex];
    const l = list.getLayout(endIndex);
    hold.current = row && l ? { key: row.id, rel: l.y + l.height + list.getFirstItemOffset() - view.current.y } : null;
  }, []);
  const keepReading = useCallback(() => {
    const list = listRef.current;
    const h = hold.current;
    if (!list || !h || stick.current || dragging.current || Date.now() < toTopUntil.current) return;
    const at = list.props.data?.findIndex((r) => r.id === h.key) ?? -1;
    const l = at < 0 ? undefined : list.getLayout(at);
    if (!l) return;
    const target = l.y + l.height + list.getFirstItemOffset() - h.rel;
    if (Math.abs(target - view.current.y) < 0.5) return;
    view.current.y = target;
    corrected.current = Date.now();
    list.scrollToOffset({ offset: target, animated: false });
  }, []);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      view.current = { y: contentOffset.y, h: layoutMeasurement.height, content: contentSize.height };
      measureEdges();
      // Re-anchor on the user's own scrolling, and on a jump once it settles; not on the echo of a correction.
      if (dragging.current || (!stick.current && Date.now() - corrected.current > 150 && Date.now() >= toTopUntil.current)) captureHold();
    },
    [measureEdges, captureHold],
  );
  /** The user let go (no fling) or a fling stopped: take its final offset, then stop following the finger. */
  const endScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll(e);
      dragging.current = false;
    },
    [onScroll],
  );
  /**
   * The content or the list's height changed: keep to the top (jump to start), or back to the newest
   * message if the user let go just short of it. At offset 0 nothing is needed: the list grows away from it.
   */
  const settle = useCallback(() => {
    if (Date.now() < toTopUntil.current) listRef.current?.scrollToEnd({ animated: false });
    else if (stick.current && !dragging.current && view.current.y > 0) {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
      setEdges((e) => (e.bottom ? e : { ...e, bottom: true }));
      return;
    }
    measureEdges();
  }, [measureEdges]);
  const atBottom = edges.bottom;
  const atTop = !more && edges.top;
  // Unread: the newest row id when the user left the bottom; rows before it (newer) are new.
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const anchorNow = atBottom ? null : (anchorId ?? rows[0]?.id ?? null);
  if (anchorNow !== anchorId) setAnchorId(anchorNow);
  const unread = anchorId ? Math.max(0, rows.findIndex((r) => r.id === anchorId)) : 0;
  // Away from the newest message, rows that arrive wait below until the reader comes back (the jump button
  // counts them): FlashList keeps row sizes by position, so a row inserted under a reader would shift the
  // rows on screen for a frame or two. Rows already shown still grow in place, and keepReading holds the view.
  const data = useMemo((): ListRow[] => [end, ...(unread ? rows.slice(unread) : rows)], [end, rows, unread]);

  /** Fetch one older page; returns the next cursor (null at the beginning). */
  async function fetchOlder(before: string, limit: number): Promise<{ next: string | null; count: number }> {
    const res = await call(agent.deviceId, "session.events", { agent: agent.key, sub, limit, before });
    setOlder((o) => [...res.events, ...o]);
    const next = res.more ? res.nextBefore ?? res.events[0]?.pos ?? null : null;
    setOlderCursor(next);
    return { next, count: res.events.length };
  }

  async function loadOlder() {
    const first = events[0];
    if (!more || !first?.pos || busyRef.current) return;
    busyRef.current = true;
    setLoadingOlder(true);
    try {
      await fetchOlder(olderCursor ?? q.data?.nextBefore ?? first.pos, 120);
    } catch {
      /* next scroll retries */
    } finally {
      busyRef.current = false;
      setLoadingOlder(false);
    }
  }

  /** Load pages (300 each) until the beginning or ~5000 events, then scroll to the very top. */
  async function jumpToStart() {
    if (busyRef.current) return;
    busyRef.current = true;
    let cursor: string | null = more ? olderCursor ?? q.data?.nextBefore ?? events[0]?.pos ?? null : null;
    let total = events.length;
    setJumping({ loaded: total });
    setCapped(false);
    try {
      while (cursor && total < JUMP_CAP) {
        const r = await fetchOlder(cursor, 300);
        total += r.count;
        cursor = r.count ? r.next : null;
        setJumping({ loaded: total });
      }
      if (cursor) setCapped(true);
    } catch {
      /* show what we have */
    } finally {
      busyRef.current = false;
      setJumping(null);
      toTopUntil.current = Date.now() + 4000;
      stick.current = false;
      hold.current = null;
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 120);
      setTimeout(() => {
        if (!stick.current && !dragging.current) captureHold();
      }, 4100);
    }
  }

  // Pending local messages and streamed events stay visible while a snapshot is loading.
  if (sub && q.isLoading && !rows.length) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm }}>
        <PocketSpinner size={28} />
        <Text style={{ color: p.faint, fontSize: 12 }}>正在接收对话…</Text>
      </View>
    );
  }
  if (sub && q.isError && !rows.length) {
    return <EmptyState mood="waiting" title="对话没加载出来" body={(q.error as Error).message} action={<PocketButton variant="text" onPress={() => q.refetch()}>再试一次</PocketButton>} />;
  }
  if (sub && !rows.length) return <EmptyState mood="sleepy" title="还没有对话" />;
  const connectionNote = !linkOnline && streamState !== "live"
    ? "和服务器断开了，正在重连"
    : streamState === "stale" || (streamState === "error" && !waitingForSession)
      ? "实时更新暂时中断，正在重试"
      : q.isError && streamState !== "live" ? "对话同步失败，正在重试" : null;

  return (
    <SubCtx.Provider value={subCtx}>
      <View style={{ flex: 1 }}>
        <FlashList
          ref={listRef}
          // Inverted, so the list opens at the newest message and holds it while a reply streams in.
          inverted
          {...SCROLLBAR_RIGHT}
          data={data}
          keyExtractor={(r) => r.id}
          renderItem={renderRow}
          getItemType={rowType}
          ItemSeparatorComponent={RowGap}
          CellRendererComponent={Cell}
          maintainVisibleContentPosition={NO_MVCP}
          onCommitLayoutEffect={keepReading}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.lg }}
          // Inverted: the list "end" is the top of the conversation. Older pages append there,
          // so what is on screen keeps its place.
          onEndReached={loadOlder}
          onEndReachedThreshold={1.5}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={(_, height) => {
            view.current.content = height;
            settle();
          }}
          onLayout={(e) => {
            view.current.h = e.nativeEvent.layout.height;
            settle();
          }}
          onScrollBeginDrag={() => {
            toTopUntil.current = 0;
            dragging.current = true;
          }}
          // A slow drag ends without momentum; a fling's momentum is still the user's scroll.
          onScrollEndDrag={endScroll}
          onMomentumScrollBegin={() => {
            dragging.current = true;
          }}
          onMomentumScrollEnd={endScroll}
          ListFooterComponent={
            more ? (
              <View style={{ alignItems: "center", paddingVertical: space.md, minHeight: 40 }}>
                {loadingOlder ? <PocketSpinner size={16} /> : null}
              </View>
            ) : rows.some((row) => row.type !== "pending") ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.md }}>
                <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
                <Text style={{ color: p.faint, fontSize: 11.5 }}>对话开头</Text>
                <View style={{ flex: 1, height: 1, backgroundColor: p.divider }} />
              </View>
            ) : null
          }
          keyboardDismissMode="interactive"
          extraData={subCtx}
        />
        {/* A new agent has no conversation until its first turn: say so instead of showing a blank page. */}
        {!sub && !rows.length && !q.isLoading ? (
          <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: bottomInset, justifyContent: "center" }}>
            <EmptyState
              mood={working ? "default" : "waiting"}
              title={working ? "它开始干活了" : "还没有对话"}
              body={
                working
                  ? "第一条消息一到，就会出现在这里。"
                  : waitingForSession
                    ? "它刚开好，还在等第一句话。在下面说一句，对话就从这里开始。"
                    : "在下面说一句，对话就会出现在这里。"
              }
            />
          </View>
        ) : null}
        <View pointerEvents="box-none" style={{ position: "absolute", right: 10, bottom: bottomInset + space.md, alignItems: "flex-end", gap: 6 }}>
          {jumping ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: p.surface, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 36, borderWidth: 1, borderColor: p.divider }}>
              <PocketSpinner size={12} />
              <Text style={{ color: p.muted, fontSize: 12.5 }}>正在往前翻，已载入 {jumping.loaded} 条</Text>
            </View>
          ) : null}
          {!atBottom && !atTop && !jumping ? (
            <JumpButton icon="arrow-collapse-up" label="到开头" onPress={jumpToStart} />
          ) : null}
          {!atBottom ? (
            <JumpButton
              icon="arrow-collapse-down"
              label={unread ? `到最新，${unread} 条新消息` : "到最新"}
              badge={unread}
              onPress={() => {
                stick.current = true;
                dragging.current = false;
                listRef.current?.scrollToOffset({ offset: 0, animated: true });
              }}
            />
          ) : null}
        </View>
        {/* Quiet is not broken: only say so when the link is down or the computer reports it cannot read the session. */}
        {connectionNote ? (
          <View pointerEvents="none" style={{ position: "absolute", top: 4, alignSelf: "center", paddingHorizontal: 10, minHeight: 24, justifyContent: "center", borderRadius: radius.pill, backgroundColor: p.surface2 }}>
            <Text style={{ color: p.faint, fontSize: 11 }}>{connectionNote}</Text>
          </View>
        ) : null}
        <PocketToast
          visible={capped}
          message={`对话太长，只载入了最近约 ${JUMP_CAP} 条，这里是已载入部分的开头`}
          tone="info"
          duration={2800}
          bottom={24}
          onDismiss={() => setCapped(false)}
        />
      </View>
    </SubCtx.Provider>
  );
}

const JUMP_CAP = 5000;
const KEEP_EVENTS = 4000;

function posOf(e: ConvEvent): bigint | null {
  return e.pos && /^\d+$/.test(e.pos) ? BigInt(e.pos) : null;
}

/** Union by id (newer copy wins), in conversation order. */
function mergeEvents(old: ConvEvent[], add: ConvEvent[]): ConvEvent[] {
  const byId = new Map(old.map((e) => [e.id, e]));
  for (const e of add) byId.set(e.id, e);
  return [...byId.values()].sort(compareConvEvents).slice(-KEEP_EVENTS);
}

function workedFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "刚开始";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分钟` : m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${Math.floor(m / 60)} 小时`;
}

/** Flat one-line working status matching t3code WorkingTimelineRow (no bulky card). */
function WorkingBadge({
  since,
  now,
  onStop,
  stopping,
}: {
  since?: number;
  now: number;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const p = usePalette();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingTop: space.sm, paddingHorizontal: 4, paddingRight: 14 }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          backgroundColor: p.dark ? "#3B2433" : "#FFEAF2",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <PocketSpinner size={12} color={p.primary} />
      </View>
      <Text style={{ color: p.muted, fontSize: 12.5, fontFamily: fonts.bodySemi }}>
        正在思考 · {since ? workedFor(now - since) : "刚开始"}
      </Text>
      {onStop ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="停止当前轮"
          disabled={stopping}
          onPress={onStop}
          hitSlop={6}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: 9,
            paddingVertical: 3.5,
            borderRadius: radius.pill,
            backgroundColor: pressed ? p.surface3 : p.accentContainer,
            opacity: stopping ? 0.55 : 1,
            marginLeft: "auto",
          })}
        >
          <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: p.accentText }} />
          <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>停止</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Small translucent round floating button for the chat's "到开头 / 到最新" jumps. */
function JumpButton({ icon, label, badge, onPress }: { icon: "arrow-collapse-up" | "arrow-collapse-down"; label: string; badge?: number; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? p.surface3 : p.surface,
        borderWidth: 1,
        borderColor: p.divider,
        opacity: 0.94,
        shadowColor: p.shadow,
        shadowOpacity: p.dark ? 0 : 0.14,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: p.dark ? 0 : 2,
      })}
    >
      <MaterialCommunityIcons name={icon} size={17} color={p.ink} />
      {badge ? (
        <View style={{ position: "absolute", top: -5, right: -5, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: p.primary }}>
          <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 10 }}>{badge > 99 ? "99+" : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
