import {
  compareConvEvents,
  formatModelSwitchSummary,
  isCommandErrorOutput,
  isDismissedCommandOutput,
  parseLocalCommandOutputTag,
  parseModelSwitchEvent,
  parseSlashCommandTag,
  splitFiles,
  type ChatDisplayMode,
  type ConvEvent,
} from "@herdr-pocket/protocol";

export type ToolCallEvent = Extract<ConvEvent, { kind: "tool_call" }>;
export type ToolResultEvent = Extract<ConvEvent, { kind: "tool_result" }>;

export type ToolCategory = "read" | "edit" | "run" | "search" | "web" | "agent" | "other";

export interface ToolStep {
  id: string;
  callId: string;
  name: string;
  category: ToolCategory;
  input: unknown;
  summary: string;
  result?: ToolResultEvent;
  ts: number;
  running: boolean;
  isError: boolean;
}

export interface ToolSeriesChip {
  name: string;
  category: ToolCategory;
  count: number;
  running: boolean;
  error: boolean;
}

export type TurnEntry =
  | { kind: "thinking"; id: string; text: string; ts: number }
  | { kind: "tool"; id: string; step: ToolStep; ts: number }
  | { kind: "note"; id: string; summary: string; text: string; ts: number };

export type ChatRow =
  | { kind: "user"; id: string; text: string; ts: number; pos?: string; injected?: string; attachedLines: string[]; attachedCount: number }
  | { kind: "assistant"; id: string; text: string; ts: number; pos?: string; partial?: boolean; model?: string }
  | { kind: "thinking"; id: string; text: string; ts: number; pos?: string; defaultOpen?: boolean }
  | { kind: "system"; id: string; summary: string; text: string; ts: number; pos?: string }
  | {
      kind: "command_result";
      id: string;
      command: string;
      text: string;
      isError: boolean;
      panelState?: "none" | "closed" | "interactive_open";
      ts: number;
      pos?: string;
    }
  | { kind: "compact_notice"; id: string; summary: string; text: string; ts: number; pos?: string }
  | { kind: "model_switch"; id: string; label: string; model?: string; thinking?: string; ts: number; pos?: string }
  | { kind: "tool"; id: string; ts: number; pos?: string; step: ToolStep }
  | {
      kind: "activity_group";
      id: string;
      ts: number;
      endTs: number;
      pos?: string;
      tools: ToolStep[];
      thoughts: string[];
      notes: Array<{ summary: string; text: string }>;
      entries: TurnEntry[];
      latestThought?: string;
      running: boolean;
      failedCount: number;
      headline: string;
      detailLine: string;
      activeStep?: ToolStep;
      series: ToolSeriesChip[];
      defaultOpen?: boolean;
      hasFollowingAssistant?: boolean;
    }
  | { kind: "turn_end"; id: string; ts: number; pos?: string };

const KEEP_EVENTS = 4000;

function sameEvent(a: ConvEvent, b: ConvEvent): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.ts !== b.ts || a.pos !== b.pos || a.partial !== b.partial || a.truncated !== b.truncated) {
    return false;
  }
  switch (a.kind) {
    case "user_message":
      return b.kind === "user_message" && a.text === b.text && a.injected === b.injected && a.synthetic === b.synthetic;
    case "assistant_message":
    case "reasoning":
      return (b.kind === a.kind) && a.text === b.text;
    case "system":
      return b.kind === "system" && a.subtype === b.subtype && a.text === b.text && a.summary === b.summary;
    case "tool_call":
      return b.kind === "tool_call" && a.name === b.name && a.call_id === b.call_id && JSON.stringify(a.input) === JSON.stringify(b.input);
    case "tool_result":
      return b.kind === "tool_result" && a.call_id === b.call_id && a.is_error === b.is_error && a.output === b.output;
    default:
      return true;
  }
}

/**
 * Merges incoming events into `prev` by `id` in conversation order.
 * Returns `prev` unchanged when nothing was added or modified to avoid redundant React re-renders.
 */
export function mergeConvEvents(prev: ConvEvent[], add: ConvEvent[]): ConvEvent[] {
  if (!add.length) return prev;
  const byId = new Map<string, ConvEvent>();
  for (const e of prev) byId.set(e.id, e);
  let changed = false;
  for (const e of add) {
    const cur = byId.get(e.id);
    if (!cur || !sameEvent(cur, e)) {
      byId.set(e.id, e);
      changed = true;
    }
  }
  if (!changed) return prev;
  return [...byId.values()].sort(compareConvEvents).slice(-KEEP_EVENTS);
}

export interface BufferedEventMerger {
  onInitialPage: (events: ConvEvent[]) => void;
  onInitialReady: () => void;
  onStreamEvent: (ev: ConvEvent) => void;
  dispose: () => void;
}

/**
 * Coordinates initial paged `session.events` fetch with live SSE `session` stream frames:
 * holds early stream frames until the initial page lands (or `fallbackMs` elapses) and
 * coalesces rapid live bursts into 16ms batches to prevent slice artifacts and re-render storms.
 */
export function createBufferedEventMerger(
  applyMerge: (events: ConvEvent[]) => void,
  fallbackMs = 1500,
): BufferedEventMerger {
  let pageReady = false;
  let disposed = false;
  let prePageBuffer: ConvEvent[] = [];
  let liveBatch: ConvEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    fallbackTimer = null;
    if (!disposed) onInitialReady();
  }, fallbackMs);

  const clearFallback = () => {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const onInitialPage = (events: ConvEvent[]) => {
    if (disposed) return;
    clearFallback();
    pageReady = true;
    const buffered = prePageBuffer;
    prePageBuffer = [];
    const combined = buffered.length ? [...events, ...buffered] : events;
    applyMerge(combined);
  };

  const onInitialReady = () => {
    if (disposed || pageReady) return;
    clearFallback();
    pageReady = true;
    if (prePageBuffer.length) {
      const combined = prePageBuffer;
      prePageBuffer = [];
      applyMerge(combined);
    }
  };

  const onStreamEvent = (ev: ConvEvent) => {
    if (disposed) return;
    if (!pageReady) {
      prePageBuffer.push(ev);
      return;
    }
    liveBatch.push(ev);
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (disposed || !liveBatch.length) return;
        const batch = liveBatch;
        liveBatch = [];
        applyMerge(batch);
      }, 16);
    }
  };

  const dispose = () => {
    disposed = true;
    clearFallback();
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    prePageBuffer = [];
    liveBatch = [];
  };

  return { onInitialPage, onInitialReady, onStreamEvent, dispose };
}

/** Classifies a tool name from any harness (Claude Code, Codex, Gemini, Uniflo, Pocket). */
export function toolCategory(name: string): ToolCategory {
  const n = name.trim().toLowerCase();
  if (/^(read|read_file|view_file|view_file_outline|view_code_item|list_dir|find_by_name|files\.read|files\.list|cat)$/.test(n)) {
    return "read";
  }
  if (/^(edit|edit_file|write|write_file|multiedit|apply_patch|replace_file_content|multi_replace_file_content|create_file)$/.test(n)) {
    return "edit";
  }
  if (/^(bash|shell|exec|run_command|command|command_status|send_command_input|terminal)$/.test(n)) {
    return "run";
  }
  if (/^(grep|glob|search|grep_search|ripgrep|rg|find)$/.test(n)) {
    return "search";
  }
  if (/^(webfetch|websearch|search_web|read_url_content|fetch)$/.test(n)) {
    return "web";
  }
  if (/^(task|agent|invoke_subagent|send_message|spawn_agent|subagent)$/.test(n)) {
    return "agent";
  }
  return "other";
}

function clipChars(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const arr = [...clean];
  return arr.length > max ? `${arr.slice(0, max - 1).join("")}…` : clean;
}

function shortPath(raw: string): string {
  const s = raw.trim().replace(/[\\/]+$/, "");
  if (!s) return raw.trim();
  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || s;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Extracts a concise single-line target/argument summary from a tool call input. */
export function toolInputSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return clipChars(input, 96);
  if (typeof input !== "object") return clipChars(String(input), 96);
  const o = input as Record<string, unknown>;
  for (const k of [
    "file_path",
    "path",
    "Path",
    "TargetFile",
    "AbsolutePath",
    "file",
    "SearchPath",
    "SearchDirectory",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return clipChars(shortPath(v), 72);
  }
  for (const k of ["command", "CommandLine", "cmd", "Command", "pattern", "Pattern", "query", "Query", "url", "Url", "uri", "description", "Role", "prompt"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return clipChars(v, 96);
  }
  try {
    const s = JSON.stringify(o);
    return s === "{}" ? "" : clipChars(s, 96);
  } catch {
    return "";
  }
}

/** Formats tool inputs or JSON strings lazily when an individual tool row is expanded. */
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

function systemSummary(text: string): string {
  const first = text
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return "系统提醒";
  return clipChars(first, 36);
}

const VERB_BY_CATEGORY: Record<ToolCategory, string> = {
  read: "读取",
  edit: "修改",
  run: "运行",
  search: "搜索",
  web: "联网",
  agent: "子任务",
  other: "调用",
};

function summarizeCategoryCounts(tools: ToolStep[]): string {
  const counts: Record<ToolCategory, number> = { read: 0, edit: 0, run: 0, search: 0, web: 0, agent: 0, other: 0 };
  for (const t of tools) counts[t.category]++;
  const parts: string[] = [];
  if (counts.read) parts.push(`读取 ${counts.read} 项`);
  if (counts.search) parts.push(`搜索 ${counts.search} 次`);
  if (counts.run) parts.push(`运行 ${counts.run} 条命令`);
  if (counts.edit) parts.push(`修改 ${counts.edit} 处`);
  if (counts.web) parts.push(`联网 ${counts.web} 次`);
  if (counts.agent) parts.push(`${counts.agent} 个子任务`);
  if (counts.other && parts.length === 0) parts.push(`${counts.other} 个工具`);
  return parts.join(" · ");
}

function buildGroupMeta(
  tools: ToolStep[],
  thoughts: string[],
  notes: Array<{ summary: string; text: string }>,
): Pick<
  Extract<ChatRow, { kind: "activity_group" }>,
  "running" | "failedCount" | "headline" | "detailLine" | "activeStep" | "series" | "latestThought"
> {
  const runningSteps = tools.filter((t) => t.running);
  const failedCount = tools.filter((t) => t.isError).length;
  const activeStep = runningSteps[runningSteps.length - 1];
  const running = runningSteps.length > 0;
  const latestThought = thoughts.length > 0 ? thoughts[thoughts.length - 1] : undefined;

  const seriesMap = new Map<string, ToolSeriesChip>();
  for (const t of tools) {
    const prev = seriesMap.get(t.name);
    if (prev) {
      prev.count++;
      if (t.running) prev.running = true;
      if (t.isError) prev.error = true;
    } else {
      seriesMap.set(t.name, { name: t.name, category: t.category, count: 1, running: t.running, error: t.isError });
    }
  }
  const series = [...seriesMap.values()];

  const catSummary = summarizeCategoryCounts(tools);
  let headline: string;
  if (running) {
    const verb = activeStep ? VERB_BY_CATEGORY[activeStep.category] : "执行";
    headline = tools.length > 1 ? `正在${verb} · 已调用 ${tools.length} 个工具` : `正在${verb}`;
  } else if (tools.length > 0) {
    headline = `已调用 ${tools.length} 个工具`;
  } else if (thoughts.length > 0 && notes.length === 0) {
    headline = `思考与分析（${thoughts.length} 段）`;
  } else if (thoughts.length === 0 && notes.length > 0) {
    headline = `状态与重试记录（${notes.length} 条）`;
  } else {
    headline = `思考与记录（${thoughts.length + notes.length}）`;
  }

  let detailLine = "";
  if (activeStep) {
    detailLine = activeStep.summary ? `${activeStep.name} · ${activeStep.summary}` : activeStep.name;
  } else if (failedCount > 0) {
    detailLine = catSummary ? `${catSummary} · ${failedCount} 个失败` : `${failedCount} 个失败`;
  } else if (catSummary) {
    detailLine = thoughts.length > 0 ? `${catSummary} · ${thoughts.length} 段思考` : catSummary;
  } else if (latestThought) {
    detailLine = clipChars(latestThought, 48);
  } else if (notes.length > 0) {
    detailLine = notes[notes.length - 1]!.summary;
  }

  return { running, failedCount, headline, detailLine, activeStep, series, ...(latestThought ? { latestThought } : {}) };
}

const NOISY_SYSTEM_SUBTYPES = new Set(["reminder", "自动插入", "system_message", "developer"]);
const NOISY_SYSTEM_PREFIX_RE =
  /^\s*(?:<(?:SYSTEM_MESSAGE|ephemeral_message|session_context|INSTRUCTIONS|system-reminder|environment_context)\b|Base directory for this skill:\s+\S|\[Image:\s*original\b[^\]]*\]\s*$)/i;

function isHiddenSystemNoise(text: string, subtype?: string): boolean {
  const sub = subtype?.trim().toLowerCase();
  if (sub && NOISY_SYSTEM_SUBTYPES.has(sub)) return true;
  if (subtype === "自动插入") return true;
  return NOISY_SYSTEM_PREFIX_RE.test(text);
}

type Intermediate =
  | { kind: "tool"; id: string; ts: number; pos?: string; step: ToolStep }
  | { kind: "thinking"; id: string; text: string; ts: number; pos?: string }
  | { kind: "system"; id: string; summary: string; text: string; ts: number; pos?: string };

/**
 * Pairs `tool_call` and `tool_result` by `call_id` and formats non-message activity
 * according to the selected `ChatDisplayMode`:
 * - `"standard"` (default): keeps each thinking block standalone (collapsed by default) and
 *   folds contiguous tool runs or repeated retry/system notices.
 * - `"compact"`: folds contiguous thinking, visible system notes, and tool runs chronologically
 *   into a single cohesive `activity_group`.
 * - `"expanded"`: keeps every thinking block, system note, and tool group separate & open.
 */
export function foldConvEvents(events: ConvEvent[], mode: ChatDisplayMode = "standard"): ChatRow[] {
  const rows: ChatRow[] = [];
  const stepByCallId = new Map<string, ToolStep>();
  let pending: Intermediate[] = [];

  const flushPending = () => {
    if (!pending.length) return;
    const tools: ToolStep[] = [];
    const thoughts: string[] = [];
    const notes: Array<{ summary: string; text: string }> = [];
    const entries: TurnEntry[] = [];
    for (const item of pending) {
      if (item.kind === "tool") {
        tools.push(item.step);
        entries.push({ kind: "tool", id: item.id, step: item.step, ts: item.ts });
      } else if (item.kind === "thinking") {
        thoughts.push(item.text);
        entries.push({ kind: "thinking", id: item.id, text: item.text, ts: item.ts });
      } else {
        notes.push({ summary: item.summary, text: item.text });
        entries.push({ kind: "note", id: item.id, summary: item.summary, text: item.text, ts: item.ts });
      }
    }
    const first = pending[0]!;
    const last = pending[pending.length - 1]!;
    const firstId = first.id;
    if (tools.length === 0 && thoughts.length === 1 && notes.length === 0) {
      const only = pending[0]!;
      if (only.kind === "thinking") {
        rows.push({ ...only, ...(mode === "expanded" ? { defaultOpen: true } : {}) });
      }
    } else if (tools.length === 0 && thoughts.length === 0 && (notes.length <= 1 || mode === "expanded")) {
      for (const item of pending) rows.push(item);
    } else if (mode === "expanded" && tools.length === 0) {
      for (const item of pending) {
        rows.push(item.kind === "thinking" ? { ...item, defaultOpen: true } : item);
      }
    } else if (tools.length === 1 && thoughts.length === 0 && notes.length === 0) {
      rows.push({ kind: "tool", id: firstId, ts: first.ts, pos: first.pos, step: tools[0]! });
    } else {
      rows.push({
        kind: "activity_group",
        id: `grp-${firstId}`,
        ts: first.ts,
        endTs: Math.max(first.ts, last.ts),
        pos: first.pos,
        tools,
        thoughts,
        notes,
        entries,
        ...(mode === "expanded" ? { defaultOpen: true } : {}),
        ...buildGroupMeta(tools, thoughts, notes),
      });
    }
    pending = [];
  };

  const lookaheadCommandOutcome = (idx: number): "error" | "dismissed" | "output" | "model_switch" | null => {
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
      const cleanBody = (parsedOut?.body ?? next.text).trim();
      if (!cleanBody) continue;
      if (isDismissedCommandOutput(cleanBody)) return "dismissed";
      if (next.subtype === "command_error" || parsedOut?.isError || isCommandErrorOutput(cleanBody)) {
        return "error";
      }
      const nextSw = parseModelSwitchEvent(next);
      if (nextSw && (nextSw.model || nextSw.thinking || nextSw.ackOnly)) return "model_switch";
      if (next.subtype === "command_output" || parsedOut) return "output";
    }
    return null;
  };

  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.kind === "system") {
      const parsedOut = parseLocalCommandOutputTag(e.text);
      const cleanBody = (parsedOut?.body ?? e.text).trim();
      if (!cleanBody || isDismissedCommandOutput(cleanBody)) {
        continue;
      }
      if (mode !== "expanded" && isHiddenSystemNoise(cleanBody, e.subtype)) {
        continue;
      }
    }

    const cmdTag = e.kind === "system" ? parseSlashCommandTag(e.text) : null;
    if (e.kind === "system" && (e.subtype === "command" || cmdTag)) {
      const nextOutcome = lookaheadCommandOutcome(i);
      if (nextOutcome === "error" || nextOutcome === "dismissed" || nextOutcome === "output" || nextOutcome === "model_switch") {
        // Defer cleanly to the following command output / error / dismissal / model_switch event.
        if (nextOutcome === "model_switch" && parseModelSwitchEvent(e)) {
          // Allow `/model ...` + `<local-command-stdout>` / `/effort` coalescing as usual.
        } else {
          continue;
        }
      }
    }

    const sw = parseModelSwitchEvent(e);
    if (sw) {
      const nextOutcome = lookaheadCommandOutcome(i);
      if (nextOutcome === "error" || nextOutcome === "dismissed") {
        continue;
      }
      flushPending();
      if (sw.ackOnly && !sw.model && !sw.thinking) {
        continue;
      }
      const prev = rows[rows.length - 1];
      if (
        prev?.kind === "model_switch" &&
        Math.abs(e.ts - prev.ts) <= 15_000 &&
        (sw.ackOnly || !(prev.model && sw.model && prev.model !== sw.model))
      ) {
        if (sw.model) prev.model = sw.model;
        if (sw.thinking) prev.thinking = sw.thinking;
        prev.ts = Math.max(prev.ts, e.ts);
        if (e.pos && !prev.pos) prev.pos = e.pos;
        prev.label = formatModelSwitchSummary({ model: prev.model, thinking: prev.thinking });
      } else {
        rows.push({
          kind: "model_switch",
          id: e.id,
          label: formatModelSwitchSummary(sw),
          ...(sw.model ? { model: sw.model } : {}),
          ...(sw.thinking ? { thinking: sw.thinking } : {}),
          ts: e.ts,
          pos: e.pos,
        });
      }
      continue;
    }

    switch (e.kind) {
      case "user_message": {
        if (e.synthetic) {
          const trimmed = e.text.trim();
          if (trimmed && (mode === "expanded" || !isHiddenSystemNoise(trimmed, "自动插入"))) {
            const note: Intermediate = {
              kind: "system",
              id: e.id,
              summary: systemSummary(trimmed),
              text: trimmed,
              ts: e.ts,
              pos: e.pos,
            };
            if (mode !== "expanded") pending.push(note);
            else {
              flushPending();
              rows.push(note);
            }
          }
          break;
        }
        if (!e.text.trim() && !e.injected?.trim()) break;
        flushPending();
        const split = splitFiles(e.text);
        rows.push({
          kind: "user",
          id: e.id,
          text: split.text || (split.count ? "" : e.text.trim()),
          ts: e.ts,
          pos: e.pos,
          injected: e.injected?.trim() || undefined,
          attachedLines: split.lines,
          attachedCount: split.count,
        });
        break;
      }
      case "assistant_message": {
        if (!e.text.trim()) break;
        flushPending();
        rows.push({
          kind: "assistant",
          id: e.id,
          text: e.text,
          ts: e.ts,
          pos: e.pos,
          partial: e.partial,
          ...(e.model ? { model: e.model } : {}),
        });
        break;
      }
      case "reasoning": {
        if (!e.text.trim()) break;
        const text = e.text.trim();
        if (mode === "compact") {
          pending.push({ kind: "thinking", id: e.id, text, ts: e.ts, pos: e.pos });
        } else {
          flushPending();
          rows.push({
            kind: "thinking",
            id: e.id,
            text,
            ts: e.ts,
            pos: e.pos,
            defaultOpen: mode === "expanded",
          });
        }
        break;
      }
      case "system": {
        if (!e.text.trim()) break;
        const parsedOut = parseLocalCommandOutputTag(e.text);
        const cleanBody = (parsedOut?.body ?? e.text).trim();
        if (!cleanBody || isDismissedCommandOutput(cleanBody)) break;
        const subLower = e.subtype?.trim().toLowerCase();
        if (subLower === "compact" || subLower === "checkpoint" || subLower === "compact_boundary") {
          flushPending();
          rows.push({
            kind: "compact_notice",
            id: e.id,
            summary: e.summary?.trim() || "上下文已压缩",
            text: cleanBody,
            ts: e.ts,
            pos: e.pos,
          });
          break;
        }
        if (e.subtype === "command_output" || e.subtype === "command_error" || parsedOut) {
          flushPending();
          const isError = e.subtype === "command_error" || Boolean(parsedOut?.isError) || isCommandErrorOutput(cleanBody);
          rows.push({
            kind: "command_result",
            id: e.id,
            command: e.summary?.trim() || (isError ? "命令失败" : "命令输出"),
            text: cleanBody,
            isError,
            ts: e.ts,
            pos: e.pos,
          });
          break;
        }
        const note: Intermediate = {
          kind: "system",
          id: e.id,
          summary: e.summary?.trim() || systemSummary(e.text),
          text: e.text.trim(),
          ts: e.ts,
          pos: e.pos,
        };
        if (mode !== "expanded") {
          pending.push(note);
        } else {
          flushPending();
          rows.push(note);
        }
        break;
      }
      case "tool_call": {
        const step: ToolStep = {
          id: e.id,
          callId: e.call_id,
          name: e.name,
          category: toolCategory(e.name),
          input: e.input,
          summary: toolInputSummary(e.input),
          ts: e.ts,
          running: true,
          isError: false,
        };
        stepByCallId.set(e.call_id, step);
        pending.push({ kind: "tool", id: e.id, ts: e.ts, pos: e.pos, step });
        break;
      }
      case "tool_result": {
        const existing = stepByCallId.get(e.call_id);
        if (existing) {
          existing.result = e;
          existing.running = false;
          existing.isError = Boolean(e.is_error);
        } else {
          // Orphan result whose tool_call sat before the loaded page: synthesize one paired step
          // instead of rendering a broken standalone result card.
          const step: ToolStep = {
            id: e.id,
            callId: e.call_id,
            name: e.name || "tool",
            category: toolCategory(e.name || "tool"),
            input: undefined,
            summary: "",
            result: e,
            ts: e.ts,
            running: false,
            isError: Boolean(e.is_error),
          };
          stepByCallId.set(e.call_id, step);
          pending.push({ kind: "tool", id: e.id, ts: e.ts, pos: e.pos, step });
        }
        break;
      }
      case "turn_end": {
        flushPending();
        if (rows.length && rows[rows.length - 1]?.kind !== "turn_end") {
          rows.push({ kind: "turn_end", id: e.id, ts: e.ts, pos: e.pos });
        }
        break;
      }
      default:
        break; // usage, turn_start: omitted
    }
  }

  flushPending();
  let sawAssistantAfter = false;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]!;
    if (r.kind === "assistant") {
      sawAssistantAfter = true;
    } else if (r.kind === "activity_group") {
      if (r.running) {
        Object.assign(r, buildGroupMeta(r.tools, r.thoughts, r.notes));
      }
      r.hasFollowingAssistant = sawAssistantAfter && !r.running;
    }
  }
  return rows;
}
