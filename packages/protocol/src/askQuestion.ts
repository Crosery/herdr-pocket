export interface ParsedQuestionOption {
  title: string;
  description?: string;
  recommended: boolean;
  isWriteIn: boolean;
  rawLabel: string;
}

export interface ParsedQuestionItem {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: ParsedQuestionOption[];
}

export interface ParsedAskQuestionPayload {
  questions: ParsedQuestionItem[];
  partialText?: string;
}

const QUESTION_TOOL_NAMES = new Set([
  "ask_question",
  "askuserquestion",
  "ask_user_question",
  "request_user_input",
  "ask_followup_question",
]);

export function isQuestionToolName(name?: string | null): boolean {
  if (!name) return false;
  return QUESTION_TOOL_NAMES.has(name.trim().toLowerCase());
}

const WRITE_IN_RE = /^(?:write[- ]?in|other|type something|custom|enter\s+custom|自定义|其他|自由输入|手动输入)\b/i;
const RECOMMENDED_PREFIX_RE = /^(?:\(\s*recommended\s*\)|（\s*推荐\s*）|\[\s*recommended\s*\])\s*/i;
const RECOMMENDED_SUFFIX_RE = /\s*(?:\(\s*recommended\s*\)|（\s*推荐\s*）|\[\s*recommended\s*\])$/i;

function clipQuestionText(text: string, max = 96): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const arr = [...clean];
  return arr.length > max ? `${arr.slice(0, max - 1).join("")}…` : clean;
}

/** Strips `(Recommended)`, extracts `—` description, and flags Write-in/Other items. */
export function normalizeChoiceLabel(
  rawLabel: string,
  explicitDescription?: string,
): ParsedQuestionOption {
  let clean = rawLabel.replace(/\s+/g, " ").trim();
  let recommended = false;
  if (RECOMMENDED_PREFIX_RE.test(clean)) {
    recommended = true;
    clean = clean.replace(RECOMMENDED_PREFIX_RE, "").trim();
  }
  if (RECOMMENDED_SUFFIX_RE.test(clean)) {
    recommended = true;
    clean = clean.replace(RECOMMENDED_SUFFIX_RE, "").trim();
  }

  let title = clean;
  let description = explicitDescription?.replace(/\s+/g, " ").trim() || undefined;
  if (!description) {
    const emIdx = clean.indexOf(" — ");
    const enIdx = clean.indexOf(" – ");
    const sepIdx = emIdx >= 0 ? emIdx : enIdx;
    if (sepIdx > 0 && sepIdx + 3 < clean.length) {
      title = clean.slice(0, sepIdx).trim();
      description = clean.slice(sepIdx + 3).trim() || undefined;
    }
  }

  const isWriteIn = WRITE_IN_RE.test(title) || WRITE_IN_RE.test(clean);
  if (isWriteIn && /^(?:write[- ]?in(?:\.\.\.|…)?|type something(?:\.\.\.|…)?)$/i.test(title)) {
    title = "自定义输入…";
    if (!description) description = "输入你想补充的文字内容";
  }

  return {
    title: title || clean || rawLabel,
    ...(description ? { description } : {}),
    recommended,
    isWriteIn,
    rawLabel,
  };
}

function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function coerceQuestionRecord(item: unknown): ParsedQuestionItem | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const rawQ =
    (typeof o.question === "string" && o.question) ||
    (typeof o.prompt === "string" && o.prompt) ||
    (typeof o.title === "string" && o.title) ||
    (typeof o.text === "string" && o.text) ||
    "";
  const header = typeof o.header === "string" && o.header.trim() ? o.header.trim() : undefined;
  const question = rawQ.replace(/\s+/g, " ").trim() || header || "";

  let rawOptions: unknown = o.options ?? o.choices;
  if (typeof rawOptions === "string") {
    const parsedOpts = tryJsonParse(rawOptions);
    if (Array.isArray(parsedOpts)) rawOptions = parsedOpts;
  }

  const options: ParsedQuestionOption[] = [];
  if (Array.isArray(rawOptions)) {
    for (const opt of rawOptions) {
      if (typeof opt === "string" && opt.trim()) {
        options.push(normalizeChoiceLabel(opt));
      } else if (opt && typeof opt === "object" && !Array.isArray(opt)) {
        const oo = opt as Record<string, unknown>;
        const lbl =
          (typeof oo.label === "string" && oo.label) ||
          (typeof oo.title === "string" && oo.title) ||
          (typeof oo.value === "string" && oo.value) ||
          "";
        const desc = typeof oo.description === "string" ? oo.description : undefined;
        if (lbl.trim()) {
          options.push(normalizeChoiceLabel(lbl, desc));
        }
      }
    }
  }

  if (!question && options.length === 0) return null;
  return {
    ...(header ? { header } : {}),
    question,
    multiSelect: Boolean(o.multiSelect ?? o.is_multi_select ?? o.isMultiSelect),
    options,
  };
}

/**
 * Parses `ask_question` / `AskUserQuestion` payloads including doubly-encoded
 * JSON-string `questions` arrays and streaming partial JSON inputs.
 */
export function parseAskQuestionInput(input: unknown): ParsedAskQuestionPayload {
  if (input == null) return { questions: [] };
  let value: unknown = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { questions: [] };
    const parsed = tryJsonParse(trimmed);
    if (parsed !== undefined) {
      value = parsed;
    } else {
      // Partial streaming JSON fallback: pull readable question or first option snippet.
      const qMatch = /"(?:question|prompt|header)"\s*:\s*(?:\\?")((?:\\.|[^"\\])*)/.exec(trimmed);
      if (qMatch?.[1]) {
        return {
          questions: [],
          partialText: clipQuestionText(qMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " ")),
        };
      }
      const optMatch = /"options"\s*:\s*\[\\?"([^"\\]{2,80})/.exec(trimmed);
      if (optMatch?.[1]) {
        return {
          questions: [],
          partialText: clipQuestionText(normalizeChoiceLabel(optMatch[1]).title),
        };
      }
      return { questions: [] };
    }
  }

  const out: ParsedQuestionItem[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const q = coerceQuestionRecord(item);
      if (q) out.push(q);
    }
    return { questions: out };
  }

  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    let rawQuestions = o.questions;
    if (typeof rawQuestions === "string") {
      const parsedQ = tryJsonParse(rawQuestions);
      if (parsedQ !== undefined) rawQuestions = parsedQ;
      else {
        const partial = parseAskQuestionInput(rawQuestions);
        if (partial.questions.length > 0 || partial.partialText) return partial;
      }
    }
    if (Array.isArray(rawQuestions)) {
      for (const item of rawQuestions) {
        const q = coerceQuestionRecord(item);
        if (q) out.push(q);
      }
    } else {
      const single = coerceQuestionRecord(o);
      if (single) out.push(single);
    }
  }
  return { questions: out };
}

/** Formats a single readable line for a question tool call (never returns raw JSON). */
export function summarizeAskQuestionInput(input: unknown, maxLen = 84): string {
  const parsed = parseAskQuestionInput(input);
  if (parsed.questions.length > 0) {
    const first = parsed.questions[0]!;
    const lead = first.question || first.header || first.options.map((o) => o.title).slice(0, 2).join(" / ");
    const base = parsed.questions.length > 1 ? `${lead}（共 ${parsed.questions.length} 题）` : lead;
    return clipQuestionText(base, maxLen);
  }
  if (parsed.partialText) {
    return clipQuestionText(parsed.partialText, maxLen);
  }
  return "等待确认选项";
}
