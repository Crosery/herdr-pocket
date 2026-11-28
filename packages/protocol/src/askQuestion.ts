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
  "ask",
  "ask_question",
  "askuserquestion",
  "ask_user_question",
  "ask_user",
  "ask_human",
  "user_input",
  "clarify",
  "question",
  "request_user_input",
  "ask_followup_question",
]);

export function isQuestionToolName(name?: string | null): boolean {
  if (!name) return false;
  return QUESTION_TOOL_NAMES.has(name.trim().toLowerCase());
}

const WRITE_IN_RE = /^(?:write[- ]?in|other|type something|custom|enter\s+custom|none of the above|自定义|其他|自由输入|手动输入)\b/i;
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
    multiSelect: Boolean(o.multiSelect ?? o.is_multi_select ?? o.isMultiSelect ?? o.multi),
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

export interface SelectableChoiceLike {
  key: string;
  selected?: boolean;
}

export interface TerminalChoiceOption {
  key: string;
  label: string;
  selected: boolean;
  checked?: boolean;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const NUMBERED_OPTION_RE = /^\s*([❯›>▶➜→●▸]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const RADIO_CHECK_OPTION_RE = /^\s*([❯›>▶➜→▸]\s*)?(?:(\[[ xX✓✔]\])|([●◉○◯]))\s+(.+?)\s*$/;
const POINTER_ONLY_OPTION_RE = /^(\s*)([❯›▶▸]|>\s)(.+?)\s*$/;
const NON_CHOICE_LINE_RE =
  /(?:alt\+m\s+to\s+send|ctrl\+[a-z]\s+to\s+|enter\s+to\s+select|esc\s+to\s+|use\s+arrow|↑\/↓|←\/→|^\s*[●○◉◯]\s*\[\d{2}:\d{2}(?::\d{2})?\]|^\s*[●○◉◯]\s*(?:Thought\s+for|Ran\b|Explored\b|Read\b|Reading\b|Edited\b|Editing\b|Wrote\b|Writing\b|Updated\b|Updating\b|Created\b|Creating\b|Checked\b|Checking\b|Waiting\b|Working\b|Swarm\b|Scheduling\b|Running\b|Searching\b|Listing\b|Calling\b|Fetching\b)|^\s*\d+\/\d+\s+steps\b|\b\d+\s+artifacts?\s*·\s*\/artifact\s+to\s+review\b|\bctx\s*·\s*(?:working|idle|done|reviewing)\b|^\s*[─━═┄┈-]{4,}\s*$)/i;
const CLEAN_TRAILING_HINT_RE = /\s+\((?:esc|y|n|a|p|shift\+tab|tab)\)$/i;

/**
 * Parses live interactive choice menus from captured terminal screen lines across
 * Claude Code, Antigravity (`agy`), Codex, Oh My Pi (`omp`), Gemini CLI, OpenCode, and DSH:
 * 1. Numbered cursor lists (`❯ 1. ...`, `  2. ...`)
 * 2. Unnumbered radio/checkbox lists (`❯ ○ ...` / `  ○ ...`, `❯ [ ] ...` / `  [x] ...`)
 * 3. Unnumbered arrow-cursor lists beneath a `? ` question line (`? ...\n❯ Opt A\n  Opt B`)
 */
export function parseTerminalChoices(lines: readonly string[], lookback = 36): TerminalChoiceOption[] {
  const cleaned = lines
    .map((l) => l.replace(ANSI_ESCAPE_RE, "").replace(/[│┃║]/g, " ").replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0)
    .slice(-lookback);
  if (cleaned.length === 0) return [];

  // 1. Numbered cursor option run (1, 2, 3...)
  let bestNum: TerminalChoiceOption[] = [];
  let runNum: TerminalChoiceOption[] = [];
  for (const line of cleaned) {
    if (NON_CHOICE_LINE_RE.test(line)) continue;
    const m = NUMBERED_OPTION_RE.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    if (n === 1) runNum = [];
    if (n !== runNum.length + 1) continue;
    const rawLabel = m[3]!.replace(CLEAN_TRAILING_HINT_RE, "");
    const checkMatch = /^\[([ xX✓✔])\]\s*/.exec(rawLabel);
    const checked = checkMatch ? checkMatch[1] !== " " : undefined;
    const label = rawLabel.replace(/^\[[ xX✓✔]\]\s*/, "").trim();
    if (!label) continue;
    runNum.push({
      key: String(n),
      label,
      selected: Boolean(m[1]),
      ...(checked !== undefined ? { checked } : {}),
    });
    if (runNum.length >= 2) bestNum = [...runNum];
  }
  if (bestNum.length >= 2 && bestNum.length <= 9 && bestNum.some((c) => c.selected)) {
    return bestNum;
  }

  // 2. Unnumbered radio/checkbox option cluster (`❯ ○ ...` / `  ○ ...` or `❯ [ ] ...` / `  [x] ...`)
  interface RadioCandidate extends TerminalChoiceOption {
    hasPointer: boolean;
    isBox: boolean;
    isUnfilledRadio: boolean;
  }
  const acceptRadioRun = (run: readonly RadioCandidate[]): TerminalChoiceOption[] | null => {
    if (run.length < 2 || run.length > 9) return null;
    if (!run.some((c) => c.selected)) return null;
    const hasPointerOrBox = run.some((c) => c.hasPointer || c.isBox);
    // Reject pure all-filled bullet lists (`● task 1`, `● task 2`) with no cursor pointer and no unfilled `○`/`◯`.
    if (!hasPointerOrBox && !run.some((c) => c.isUnfilledRadio)) return null;
    return run.map(({ hasPointer: _p, isBox: _b, isUnfilledRadio: _u, ...opt }) => opt);
  };
  let bestRadio: TerminalChoiceOption[] = [];
  let runRadio: RadioCandidate[] = [];
  for (const line of cleaned) {
    if (NON_CHOICE_LINE_RE.test(line)) {
      const accepted = acceptRadioRun(runRadio);
      if (accepted) bestRadio = accepted;
      runRadio = [];
      continue;
    }
    const m = RADIO_CHECK_OPTION_RE.exec(line);
    if (!m) {
      // Allow a single indented description line inside a cluster without breaking it immediately
      if (runRadio.length > 0 && /^\s{4,}\S/.test(line)) continue;
      const accepted = acceptRadioRun(runRadio);
      if (accepted) bestRadio = accepted;
      runRadio = [];
      continue;
    }
    const pointer = Boolean(m[1]);
    const box = m[2];
    const radio = m[3];
    const label = m[4]!.replace(CLEAN_TRAILING_HINT_RE, "").trim();
    if (!label) continue;
    const checked = box ? box[1] !== " " : radio === "●" || radio === "◉";
    const selected = pointer || (!box && (radio === "●" || radio === "◉"));
    runRadio.push({
      key: String(runRadio.length + 1),
      label,
      selected,
      ...(box ? { checked } : {}),
      hasPointer: pointer,
      isBox: Boolean(box),
      isUnfilledRadio: !box && (radio === "○" || radio === "◯"),
    });
  }
  const trailingAccepted = acceptRadioRun(runRadio);
  if (trailingAccepted) bestRadio = trailingAccepted;
  if (bestRadio.length >= 2 && bestRadio.length <= 9) {
    return bestRadio;
  }

  // 3. Unnumbered arrow-cursor menu immediately following a `? ` prompt line (e.g. Antigravity / OMP / Inquirer)
  let qIdx = -1;
  for (let i = cleaned.length - 1; i >= 0; i -= 1) {
    if (/^\s*[?？]\s+\S/.test(cleaned[i]!)) {
      qIdx = i;
      break;
    }
  }
  if (qIdx >= 0 && qIdx < cleaned.length - 1) {
    const afterQ = cleaned.slice(qIdx + 1);
    const items: TerminalChoiceOption[] = [];
    let pointerIndent: number | null = null;
    for (const line of afterQ) {
      if (NON_CHOICE_LINE_RE.test(line)) break;
      if (/^\s*[?？]\s+\S/.test(line)) break;
      const pm = POINTER_ONLY_OPTION_RE.exec(line);
      if (pm) {
        const label = pm[3]!.replace(CLEAN_TRAILING_HINT_RE, "").trim();
        if (!label) continue;
        pointerIndent = pm[1]!.length;
        items.push({ key: String(items.length + 1), label, selected: true });
        continue;
      }
      const indentMatch = /^(\s+)(\S.+?)\s*$/.exec(line);
      if (indentMatch && (pointerIndent === null || indentMatch[1]!.length <= pointerIndent + 4)) {
        const label = indentMatch[2]!.replace(CLEAN_TRAILING_HINT_RE, "").trim();
        if (label) items.push({ key: String(items.length + 1), label, selected: false });
      }
    }
    if (items.length >= 2 && items.length <= 9 && items.some((c) => c.selected)) {
      return items;
    }
  }

  return [];
}

const ARROW_NAV_HARNESSES = new Set([
  "antigravity",
  "agy",
  "claude",
  "claude-code",
  "codex",
  "omp",
  "oh-my-pi",
  "pi",
  "gemini",
  "gemini-cli",
  "opencode",
  "dsh",
  "qoder",
  "qwen",
  "cursor",
  "aider",
  "amp",
  "goose",
]);

/**
 * Computes the universal terminal key sequence to select an option across all coding-agent TUIs:
 * - Arrow-navigated TUIs (Antigravity, Claude Code, Codex, Oh My Pi, Gemini CLI, OpenCode, DSH,
 *   or any menu with a visible cursor pointer) use relative `up`/`down` moves + `enter` (or `space`
 *   for multi-select), preventing double-submit and preventing digits like `"1"` from leaking into
 *   text inputs / queued prompts.
 * - Plain non-cursor shell `select` / readline prompts fall back to `[targetKey, "enter"]`.
 */
export function buildChoiceSelectKeys(params: {
  entries: readonly SelectableChoiceLike[];
  targetKey: string;
  harness?: string | null;
  multiSelect?: boolean;
  isShell?: boolean;
  confirm?: boolean;
}): string[] {
  const { entries, targetKey, harness, multiSelect = false, isShell = false, confirm = true } = params;
  const targetIdx = entries.findIndex((e) => e.key === targetKey);
  const selectedIdx = entries.findIndex((e) => Boolean(e.selected));
  const hasCursor = selectedIdx >= 0;
  const normHarness = (harness ?? "").trim().toLowerCase();
  const isArrowTui = hasCursor || (!isShell && ARROW_NAV_HARNESSES.has(normHarness));

  if (isArrowTui && targetIdx >= 0) {
    const fromIdx = hasCursor ? selectedIdx : 0;
    const delta = targetIdx - fromIdx;
    const keys: string[] = [];
    const dir = delta >= 0 ? "down" : "up";
    const steps = Math.min(20, Math.abs(delta));
    for (let i = 0; i < steps; i += 1) keys.push(dir);
    if (confirm) keys.push(multiSelect ? "space" : "enter");
    return keys;
  }

  return confirm ? [targetKey, "enter"] : [targetKey];
}
