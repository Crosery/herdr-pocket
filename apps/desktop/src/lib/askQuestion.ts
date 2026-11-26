import {
  isQuestionToolName,
  normalizeChoiceLabel,
  parseAskQuestionInput,
  summarizeAskQuestionInput,
  type ConvEvent,
  type ParsedQuestionItem,
} from "@herdr-pocket/protocol";
import type { ChoiceOption } from "./markdown";

export {
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
  question: string;
  header?: string;
  totalQuestions: number;
  currentQuestionIndex: number;
  multiSelect: boolean;
  entries: DeckChoiceEntry[];
  fromStructuredTool: boolean;
}

const OPTION_LINE_RE = /^\s*(?:[❯›>▶➜→●]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const ESC_ANSI_RE = /\x1b\[[0-9;]*m/g;
const CHROME_HINT_RE = /^(?:enter\s+to\s+select|tab\s|esc\s|use\s+arrow|↑|↓|←|→|press\s+\d)/i;

/**
 * Extracts the human question/prompt line immediately preceding the `1.` numbered choice run
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
    if (m && m[1] === "1") {
      firstOptionIdx = i;
      break;
    }
  }
  if (firstOptionIdx <= 0) return undefined;

  for (let i = firstOptionIdx - 1; i >= Math.max(0, firstOptionIdx - 4); i -= 1) {
    const candidate = cleanLines[i]!.trim();
    if (!candidate || candidate.length < 2) continue;
    if (CHROME_HINT_RE.test(candidate)) continue;
    return candidate.replace(/^[?？\s]+/, "").trim() || candidate;
  }
  return undefined;
}

/** Returns the latest open (unanswered) structured question tool call from conversation events. */
export function findOpenQuestionToolCall(events: ConvEvent[]): ParsedQuestionItem[] {
  const answeredCallIds = new Set<string>();
  const openCalls: ParsedQuestionItem[][] = [];

  for (const ev of events) {
    if (ev.kind === "tool_result") {
      answeredCallIds.add(ev.call_id);
    } else if (ev.kind === "user_message") {
      // A subsequent user turn closes any prior un-answered tool call visually.
      openCalls.length = 0;
    } else if (ev.kind === "tool_call" && isQuestionToolName(ev.name)) {
      if (!answeredCallIds.has(ev.call_id)) {
        const parsed = parseAskQuestionInput(ev.input);
        if (parsed.questions.length > 0) {
          openCalls.push(parsed.questions);
        }
      }
    }
  }

  for (let i = openCalls.length - 1; i >= 0; i -= 1) {
    const items = openCalls[i]!;
    if (items.length > 0) return items;
  }
  return [];
}

/** Merges terminal numbered choices with open `ask_question` metadata for `AskQuestionDeck`. */
export function buildAskQuestionDeck(params: {
  events: ConvEvent[];
  choiceLines: string[];
  choices: ChoiceOption[];
}): AskQuestionDeckState | null {
  const { events, choiceLines, choices } = params;
  const openQuestions = findOpenQuestionToolCall(events);
  if (choices.length === 0) {
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
      question: fallbackQ.question || "请选择下一步操作",
      header: fallbackQ.header,
      totalQuestions: Math.max(1, openQuestions.length),
      currentQuestionIndex: 0,
      multiSelect: Boolean(fallbackQ.multiSelect),
      entries,
      fromStructuredTool: true,
    };
  }

  const firstLabels = choices.map((c) => normalizeChoiceLabel(c.label).title.toLowerCase());

  // Match the terminal screen options against the active structured question item when multi-question exists
  let matchedIdx = 0;
  let matchedQ: ParsedQuestionItem | undefined = openQuestions[0];
  if (openQuestions.length > 1) {
    for (let i = 0; i < openQuestions.length; i += 1) {
      const q = openQuestions[i]!;
      if (
        q.options.some((opt) =>
          firstLabels.some(
            (tl) =>
              tl.startsWith(opt.title.toLowerCase().slice(0, 10)) ||
              opt.title.toLowerCase().startsWith(tl.slice(0, 10)),
          ),
        )
      ) {
        matchedIdx = i;
        matchedQ = q;
        break;
      }
    }
  }

  const entries: DeckChoiceEntry[] = choices.map((c, idx) => {
    const base = normalizeChoiceLabel(c.label);
    const structuredOpt = matchedQ?.options[idx];
    if (structuredOpt && !base.isWriteIn) {
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

  const terminalPrompt = extractTerminalChoicePrompt(choiceLines);
  const question = matchedQ?.question || terminalPrompt || "请选择下一步操作";

  return {
    question,
    header: matchedQ?.header,
    totalQuestions: Math.max(1, openQuestions.length),
    currentQuestionIndex: matchedIdx,
    multiSelect: Boolean(matchedQ?.multiSelect),
    entries,
    fromStructuredTool: Boolean(matchedQ),
  };
}
