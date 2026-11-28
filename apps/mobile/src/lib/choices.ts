import {
  isQuestionToolName,
  normalizeChoiceLabel,
  parseAskQuestionInput,
  parseTerminalChoices,
  type Agent,
  type ConvEvent,
  type ParsedQuestionItem,
  type TerminalChoiceOption,
} from "@herdr-pocket/protocol";

/**
 * Interactive choice options parsed off the bottom of an agent's terminal screen
 * across Claude Code, Antigravity, Codex, Oh My Pi, Gemini CLI, OpenCode, and DSH.
 */
export type Choice = TerminalChoiceOption;

export function parseChoices(lines: readonly string[], lookback = 36): Choice[] {
  return parseTerminalChoices(lines, lookback);
}

export interface MobileQuestionEntry extends Choice {
  title: string;
  description?: string;
  recommended: boolean;
  isWriteIn: boolean;
}

export interface MobileQuestionState {
  callId?: string;
  question?: string;
  header?: string;
  totalQuestions: number;
  currentQuestionIndex: number;
  multiSelect: boolean;
  isSubmitStep?: boolean;
  fromStructuredTool?: boolean;
  entries: MobileQuestionEntry[];
}

export interface OpenMobileQuestionToolCall {
  callId: string;
  questions: ParsedQuestionItem[];
}

const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const OPTION_LINE_RE = /^\s*(?:[❯›>▶➜→●▸]\s*)?(?:(\d{1,2})[.)]|(?:\[[ xX✓✔]\]|[●◉○◯]))\s+(.+?)\s*$/;
const CHROME_HINT_RE = /^(?:enter\s+to\s+select|tab\s|esc\s|use\s+arrow|↑|↓|←|→|press\s+\d|space\s+to\s+)/i;
const SUBMIT_LABEL_RE = /^(?:submit(?:\s+answers?)?|confirm|send\s+answers?|提交|确认提交|完成并提交)\b/i;

function normMatchText(s: string): string {
  return s.toLowerCase().replace(/[\s「」『』"'`()（）【】[\]—–\-:：,，.。?？!！]/g, "");
}

export function extractTerminalPrompt(lines: readonly string[]): string | undefined {
  const cleanLines = lines
    .map((l) => l.replace(ANSI_ESCAPE_RE, "").replace(/[│┃║─━═┌┐└┘├┤┬┴┼╭╮╰╯]/g, " ").replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  if (!cleanLines.length) return undefined;

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
 * Returns the latest unanswered structured question tool call from conversation events.
 */
export function findOpenMobileQuestionToolCall(events: readonly ConvEvent[]): OpenMobileQuestionToolCall | null {
  if (!events.length) return null;
  const answeredCallIds = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "tool_result" && ev.call_id) {
      answeredCallIds.add(ev.call_id);
    }
  }

  let open: OpenMobileQuestionToolCall | null = null;
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
      open = null;
    }
  }
  return open;
}

/**
 * Merges live `terminal.read` choices, hostd `agent.interaction`, and open structured
 * question tool calls into a unified mobile Ask state with parity to Desktop's `AskQuestionDeck`.
 */
export function buildMobileAskState(params: {
  agent: Pick<Agent, "status" | "interaction">;
  events: readonly ConvEvent[];
  tailLines: readonly string[];
  liveChoices: readonly Choice[];
}): MobileQuestionState | null {
  const { agent, events, tailLines, liveChoices } = params;
  const openCall = findOpenMobileQuestionToolCall(events);
  const openQuestions = openCall?.questions ?? [];
  const callId = openCall?.callId;
  const interaction = agent.interaction;
  const hasQuestionInteraction = interaction?.kind === "question";
  const interactionChoices =
    hasQuestionInteraction && Array.isArray(interaction?.choices) ? interaction.choices : [];
  const effectiveChoices = liveChoices.length > 0 ? liveChoices : interactionChoices;

  const statusAllows =
    agent.status === "blocked" ||
    hasQuestionInteraction ||
    (agent.status === "working" && (effectiveChoices.length >= 2 || Boolean(openCall)));

  if (!statusAllows) return null;

  const interactionPrompt = hasQuestionInteraction ? interaction?.prompt?.trim() || undefined : undefined;

  if (effectiveChoices.length === 0) {
    const fallbackQ = openQuestions[0];
    if (!fallbackQ || fallbackQ.options.length === 0) return null;
    const entries: MobileQuestionEntry[] = fallbackQ.options.map((opt, idx) => ({
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
      question: fallbackQ.question || interactionPrompt,
      header: fallbackQ.header,
      totalQuestions: Math.max(1, openQuestions.length),
      currentQuestionIndex: 0,
      multiSelect: Boolean(fallbackQ.multiSelect ?? (hasQuestionInteraction && interaction?.multiSelect)),
      fromStructuredTool: true,
      entries,
    };
  }

  const firstLabels = effectiveChoices.map((c) => normMatchText(normalizeChoiceLabel(c.label).title));
  const terminalPrompt = extractTerminalPrompt(tailLines);
  const promptHint = terminalPrompt || interactionPrompt;
  const normPrompt = promptHint ? normMatchText(promptHint) : "";
  const isSubmitStep = effectiveChoices.some((c) => SUBMIT_LABEL_RE.test(normalizeChoiceLabel(c.label).title));

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

  const entries: MobileQuestionEntry[] = effectiveChoices.map((c, idx) => {
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
    ? promptHint || "确认并提交以上回答"
    : matchedQ?.question || promptHint;

  return {
    ...(callId ? { callId } : {}),
    ...(question ? { question } : {}),
    header: isSubmitStep ? "最后一步" : matchedQ?.header,
    totalQuestions: Math.max(1, openQuestions.length),
    currentQuestionIndex: isSubmitStep ? Math.max(0, openQuestions.length - 1) : matchedIdx,
    multiSelect: Boolean(
      !isSubmitStep &&
        (matchedQ?.multiSelect ||
          (hasQuestionInteraction && interaction?.multiSelect) ||
          effectiveChoices.some((c) => c.checked !== undefined)),
    ),
    ...(isSubmitStep ? { isSubmitStep: true } : {}),
    entries,
  };
}
