import {
  buildChoiceSelectKeys,
  isQuestionToolName,
  normalizeChoiceLabel,
  parseAskQuestionInput,
  summarizeAskQuestionInput,
  type AgentStatus,
  type ConvEvent,
  type ParsedQuestionItem,
} from "@herdr-pocket/protocol";
import type { ChoiceOption } from "./markdown";

export {
  buildChoiceSelectKeys,
  isQuestionToolName,
  normalizeChoiceLabel,
  parseAskQuestionInput,
  summarizeAskQuestionInput,
  type ParsedQuestionItem,
};

export interface DeckChoiceEntry extends ChoiceOption {
  title: string;
  description?: string;
  recommended: boolean;
  isWriteIn: boolean;
}

export interface AskQuestionDeckState {
  callId?: string;
  question: string;
  header?: string;
  totalQuestions: number;
  currentQuestionIndex: number;
  multiSelect: boolean;
  isSubmitStep?: boolean;
  entries: DeckChoiceEntry[];
  fromStructuredTool: boolean;
}

export interface OpenQuestionToolCall {
  callId: string;
  questions: ParsedQuestionItem[];
}

const OPTION_LINE_RE = /^\s*(?:[❯›>▶➜→●▸]\s*)?(?:(\d{1,2})[.)]|(?:\[[ xX✓✔]\]|[●◉○◯]))\s+(.+?)\s*$/;
const ESC_ANSI_RE = /\x1b\[[0-9;]*m/g;
const CHROME_HINT_RE = /^(?:enter\s+to\s+select|tab\s|esc\s|use\s+arrow|↑|↓|←|→|press\s+\d|space\s+to\s+)/i;
const SUBMIT_LABEL_RE = /^(?:submit(?:\s+answers?)?|confirm|send\s+answers?|提交|确认提交|完成并提交)\b/i;

/**
 * Extracts the human question/prompt line immediately preceding the active choice run
 * in captured terminal lines.
 */
export function extractTerminalChoicePrompt(choiceLines: string[]): string | undefined {
  const cleanLines = choiceLines
    .map((l) => l.replace(ESC_ANSI_RE, "").replace(/[│┃║─━═┌┐└┘├┤┬┴┼╭╮╰╯]/g, " ").replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  if (cleanLines.length === 0) return undefined;

  let firstOptionIdx = -1;
  for (let i = cleanLines.length - 1; i >= 0; i -= 1) {
    const m = OPTION_LINE_RE.exec(cleanLines[i]!);
    if (m && (!m[1] || m[1] === "1")) {
      firstOptionIdx = i;
      if (m[1] === "1") break;
    }
  }
  if (firstOptionIdx <= 0) {
    for (let i = cleanLines.length - 1; i >= 0; i -= 1) {
      if (/^\s*[?？]\s+\S/.test(cleanLines[i]!)) {
        return cleanLines[i]!.replace(/^\s*[?？]+\s*/, "").trim();
      }
    }
    return undefined;
  }

  for (let i = firstOptionIdx - 1; i >= Math.max(0, firstOptionIdx - 5); i -= 1) {
    const candidate = cleanLines[i]!.trim();
    if (!candidate || candidate.length < 2) continue;
    if (CHROME_HINT_RE.test(candidate)) continue;
    if (OPTION_LINE_RE.test(candidate)) continue;
    return candidate.replace(/^[?？\s]+/, "").trim() || candidate;
  }
  return undefined;
}

/**
 * Returns the latest truly-open (unanswered) structured question tool call from conversation events.
 *
 * Critically:
 * 1. Scans ALL `tool_result` events first so chronological `tool_call -> tool_result` pairs are
 *    properly recognized as answered (never stuck open after completion!).
 * 2. Any subsequent `user_message`, `assistant_message`, `reasoning`, or non-question `tool_call`
 *    closes any earlier open question call so a completed ask can never linger as a zombie overlay.
 */
export function findOpenQuestionToolCallWithId(events: ConvEvent[]): OpenQuestionToolCall | null {
  if (!events.length) return null;
  const answeredCallIds = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "tool_result" && ev.call_id) {
      answeredCallIds.add(ev.call_id);
    }
  }

  let open: OpenQuestionToolCall | null = null;
  for (const ev of events) {
    if (ev.kind === "tool_call" && isQuestionToolName(ev.name)) {
      if (ev.call_id && answeredCallIds.has(ev.call_id)) {
        open = null;
        continue;
      }
      const parsed = parseAskQuestionInput(ev.input);
      if (parsed.questions.length > 0) {
        open = { callId: ev.call_id || ev.id, questions: parsed.questions };
      }
    } else if (ev.kind === "tool_result") {
      if (open && ev.call_id && ev.call_id === open.callId) {
        open = null;
      }
    } else if (
      ev.kind === "user_message" ||
      ev.kind === "assistant_message" ||
      ev.kind === "reasoning" ||
      (ev.kind === "tool_call" && !isQuestionToolName(ev.name))
    ) {
      // The model already resumed thinking, replying, calling another tool, or the user moved on.
      open = null;
    }
  }

  return open;
}

export function findOpenQuestionToolCall(events: ConvEvent[]): ParsedQuestionItem[] {
  return findOpenQuestionToolCallWithId(events)?.questions ?? [];
}

function normMatchText(s: string): string {
  return s.toLowerCase().replace(/[\s「」『』"'`()（）【】[\]—–\-:：,，.。?？!！]/g, "");
}

/** Merges live terminal choice menus with open `ask_question` metadata for `AskQuestionDeck`. */
export function buildAskQuestionDeck(params: {
  events: ConvEvent[];
  choiceLines: string[];
  choices: ChoiceOption[];
  agentStatus?: AgentStatus;
  dismissedCallId?: string | null;
}): AskQuestionDeckState | null {
  const { events, choiceLines, choices, agentStatus, dismissedCallId } = params;
  const openCall = findOpenQuestionToolCallWithId(events);
  const openQuestions = openCall?.questions ?? [];
  const callId = openCall?.callId;

  // Respect explicit user dismissal for this exact tool call when no live terminal menu overrides it
  if (callId && dismissedCallId && dismissedCallId === callId && choices.length === 0) {
    return null;
  }

  // If the terminal has NO live choice menu:
  // Only show the structured fallback when the agent is genuinely blocked (or in unit tests where agentStatus is omitted).
  // Never show a zombie deck while the agent is already working / idle / done!
  if (choices.length === 0) {
    if (agentStatus !== undefined && agentStatus !== "blocked") return null;
    const fallbackQ = openQuestions[0];
    if (!fallbackQ || fallbackQ.options.length === 0) return null;
    const entries: DeckChoiceEntry[] = fallbackQ.options.map((opt, idx) => ({
      key: String(idx + 1),
      label: opt.rawLabel,
      selected: idx === 0,
      title: opt.title,
      ...(opt.description ? { description: opt.description } : {}),
      recommended: opt.recommended,
      isWriteIn: opt.isWriteIn,
    }));
    return {
      ...(callId ? { callId } : {}),
      question: fallbackQ.question || "请选择下一步操作",
      header: fallbackQ.header,
      totalQuestions: Math.max(1, openQuestions.length),
      currentQuestionIndex: 0,
      multiSelect: Boolean(fallbackQ.multiSelect),
      entries,
      fromStructuredTool: true,
    };
  }

  // Even if choices were parsed from terminal, never show stale terminal menus when the agent isn't blocked.
  if (agentStatus !== undefined && agentStatus !== "blocked") {
    return null;
  }

  const firstLabels = choices.map((c) => normMatchText(normalizeChoiceLabel(c.label).title));
  const terminalPrompt = extractTerminalChoicePrompt(choiceLines);
  const normPrompt = terminalPrompt ? normMatchText(terminalPrompt) : "";
  const isSubmitStep = choices.some((c) => SUBMIT_LABEL_RE.test(normalizeChoiceLabel(c.label).title));

  // Match the live terminal screen against the active structured question item when multi-question exists
  let matchedIdx = 0;
  let matchedQ: ParsedQuestionItem | undefined = isSubmitStep ? undefined : openQuestions[0];
  if (!isSubmitStep && openQuestions.length > 1) {
    let bestScore = -1;
    for (let i = 0; i < openQuestions.length; i += 1) {
      const q = openQuestions[i]!;
      let score = 0;
      const qNorm = normMatchText(q.question || q.header || "");
      if (normPrompt && qNorm && (qNorm.includes(normPrompt.slice(0, 12)) || normPrompt.includes(qNorm.slice(0, 12)))) {
        score += 4;
      }
      for (const opt of q.options) {
        const optNorm = normMatchText(opt.title);
        if (!optNorm) continue;
        const probe = optNorm.slice(0, Math.min(10, optNorm.length));
        if (firstLabels.some((tl) => tl && (tl.includes(probe) || optNorm.includes(tl.slice(0, Math.min(10, tl.length)))))) {
          score += 2;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        matchedIdx = i;
        matchedQ = q;
      }
    }
  }

  const entries: DeckChoiceEntry[] = choices.map((c, idx) => {
    const base = normalizeChoiceLabel(c.label);
    const structuredOpt = matchedQ?.options[idx];
    if (structuredOpt && !base.isWriteIn && !isSubmitStep) {
      return {
        ...c,
        title: base.title.length >= structuredOpt.title.length ? base.title : structuredOpt.title,
        description: base.description ?? structuredOpt.description,
        recommended: base.recommended || structuredOpt.recommended,
        isWriteIn: base.isWriteIn || structuredOpt.isWriteIn,
      };
    }
    return {
      ...c,
      title: base.title,
      ...(base.description ? { description: base.description } : {}),
      recommended: base.recommended,
      isWriteIn: base.isWriteIn,
    };
  });

  const question = isSubmitStep
    ? terminalPrompt || "确认并提交以上回答"
    : matchedQ?.question || terminalPrompt || "请选择下一步操作";

  return {
    ...(callId ? { callId } : {}),
    question,
    header: isSubmitStep ? "最后一步" : matchedQ?.header,
    totalQuestions: Math.max(1, openQuestions.length),
    currentQuestionIndex: isSubmitStep ? Math.max(0, openQuestions.length - 1) : matchedIdx,
    multiSelect: Boolean(!isSubmitStep && (matchedQ?.multiSelect || choices.some((c) => c.checked !== undefined))),
    ...(isSubmitStep ? { isSubmitStep: true } : {}),
    entries,
    fromStructuredTool: Boolean(matchedQ),
  };
}
