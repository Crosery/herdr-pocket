import type { Agent, AgentModelOption, AgentModelsResult } from "./index.ts";

/** Canonical thinking/reasoning effort level identifiers across supported harnesses. */
export type AgentThinkingLevel =
  | "off"
  | "none"
  | "minimal"
  | "min"
  | "low"
  | "medium"
  | "med"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "auto"
  | "default"
  | "normal"
  | "fast"
  | "smart"
  | "rush"
  | (string & {});

const EFFORT_SUFFIX_RE = /:(off|none|minimal|min|low|medium|med|high|xhigh|max|ultra|auto|default)$/i;
const TRAILING_HYPHEN_EFFORT_RE = /-(minimal|low|medium|high|xhigh)$/i;
const NON_REASONING_MODEL_RE =
  /(?:^|\/)(?:gemini-(?:1\.[05]|2\.0-(?!flash-thinking)|pro$)|gemma-[23](?:-|$)|gpt-(?:3\.5|4o|4\.1|4\.5|4(?:-|$))|claude-3(?:[.-]5-|-(?:opus|sonnet|haiku)(?:-|$))|(?:mimo-v2\.5-asr|codex-auto-review|gpt-reserve|kimi-for-coding-highspeed)(?:$|[-:@]))/i;

const MODEL_FAMILY_THINKING_RULES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/^gemini-4-(?:neon|hydrogen)(?:$|[-_@])/i, ["low", "medium", "high", "xhigh"]],
  [/^(?:gemini-4-(?:carbon|argon)|gemini-3\.[78])(?:$|[-_@])/i, ["low", "medium", "high"]],
  [/^gemini-(?:live-)?2\.5(?:$|[-_@])/i, ["minimal", "low", "medium", "high"]],
  [/^gemini-3(?:\.[156])?-flash(?:$|[-_@])/i, ["minimal", "low", "medium", "high"]],
  [/^gemini-3(?:$|[-_.@])/i, ["low", "high"]],
  [/^gemma-4(?:$|[-_.@])/i, ["high"]],
  [/^(?:k3(?:$|[-_.@])|kimi-k2-thinking(?:$|[-_@])|kimi-for-coding(?:$|[-_@]))/i, ["low", "high", "max"]],
  [/^claude-(?:[a-z0-9-]+-)?4[-.]6(?:$|[-_@])/i, ["low", "medium", "high", "max"]],
  [/^claude-(?:(?:[a-z0-9-]+-)?(?:4[-.]5|5[-.]5)|3[-.]7)(?:$|[-_@])/i, ["low", "medium", "high"]],
  [/^(?:gpt-(?:5\.[2-9]\d*|6(?:\.\d+)?)|(?:.*-)?codex|mimo-v2\.6)(?:$|[-_.@])/i, ["low", "medium", "high", "xhigh"]],
  [/^(?:o1|o3|o4-mini|gpt-5(?:\.[01]|-(?:mini|nano))?)(?:$|[-_@])/i, ["low", "medium", "high"]],
];

const GPT_OSS_EFFORT_RE = /^gpt-oss-.+-(minimal|low|medium|high|xhigh|max)$/i;

const EFFORT_RANK: Record<string, number> = {
  off: 0,
  none: 0,
  minimal: 1,
  min: 1,
  low: 2,
  medium: 3,
  med: 3,
  normal: 3,
  smart: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
  fast: 4,
  rush: 5,
};

/** Canonical OMP role slots configured under `modelRoles` in `~/.omp/agent/config.yml`. */
export const OMP_MODEL_ROLES = ["default", "smol", "slow", "plan", "commit"] as const;
export type OmpModelRole = (typeof OMP_MODEL_ROLES)[number];

/** Quick role alias selectors supported by `omp`'s `/switch @<role>` command. */
export const OMP_QUICK_ROLE_CHIPS: readonly Exclude<OmpModelRole, "commit">[] = [
  "default",
  "smol",
  "slow",
  "plan",
];

/** Canonical default thinking/reasoning effort levels supported per normalized harness family. */
export const HARNESS_DEFAULT_THINKING_LEVELS: Record<string, readonly string[]> = {
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max", "auto"],
  codex: ["low", "medium", "high", "xhigh"],
  antigravity: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["low", "medium", "high"],
  opencode: ["low", "medium", "high", "max"],
  dsh: ["low", "medium", "high"],
  hermes: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  grok: ["low", "medium", "high", "xhigh"],
  aider: ["low", "medium", "high"],
  factory: ["normal", "fast"],
  amp: ["smart", "rush"],
  cursor: ["low", "medium", "high"],
  kimi: ["low", "medium", "high"],
  qwen: ["low", "medium", "high"],
  qoder: ["low", "medium", "high"],
  codebuddy: ["low", "medium", "high"],
  goose: ["low", "medium", "high"],
};

/** Strips a trailing `:effort` modifier (such as `:high`) from an omp/pi selector without disturbing tags like `:8b`. */
export function stripModelEffortSuffix(modelId?: string | null): string {
  return (modelId ?? "").trim().replace(EFFORT_SUFFIX_RE, "");
}

/** Normalizes any harness identifier into its canonical CLI/family key for model & effort switching. */
export function normalizeSwitchHarness(raw?: string | null): string {
  const h = (raw ?? "").trim().toLowerCase();
  if (!h) return "generic";
  if (h.includes("claude") || h === "crosery" || h === "prime" || h === "commandcode" || h === "reasonix") return "claude";
  if (h === "omp" || h.includes("oh-my-pi")) return "omp";
  if (h === "pi" || h.includes("pi-mono")) return "pi";
  if (h.includes("codex")) return "codex";
  if (h.includes("antigravity") || h === "agy") return "antigravity";
  if (h.includes("gemini")) return "gemini";
  if (h.includes("deepseek") || h === "dsh") return "dsh";
  if (h.includes("opencode") || h.includes("kilo") || h.includes("crush")) return "opencode";
  if (h.includes("hermes")) return "hermes";
  if (h.includes("grok")) return "grok";
  if (h.includes("aider")) return "aider";
  if (h.includes("factory") || h === "droid") return "factory";
  if (h.includes("cursor")) return "cursor";
  if (h.includes("kimi")) return "kimi";
  if (h.includes("qwen")) return "qwen";
  if (h.includes("qoder")) return "qoder";
  if (h.includes("codebuddy")) return "codebuddy";
  if (h.includes("goose")) return "goose";
  if (h === "amp") return "amp";
  return h;
}

/** Returns true when `modelId` matches an explicit non-reasoning model pattern. */
export function isNonReasoningModelName(modelId?: string | null): boolean {
  const base = stripModelEffortSuffix(modelId);
  return Boolean(base) && NON_REASONING_MODEL_RE.test(base);
}

function matchExplicitModelFamilyLevels(baseModel: string): readonly string[] | undefined {
  const leaf = baseModel.trim().split("/").pop()?.toLowerCase() ?? "";
  if (!leaf || leaf.startsWith("@")) return undefined;
  const ossMatch = GPT_OSS_EFFORT_RE.exec(leaf);
  if (ossMatch?.[1]) return [ossMatch[1].toLowerCase()];
  for (const [re, levels] of MODEL_FAMILY_THINKING_RULES) {
    if (re.test(leaf)) return levels;
  }
  return undefined;
}

/**
 * Infers per-model thinking effort levels from the model family first, falling back to harness
 * defaults only when `modelId` is empty or unknown. Explicit non-reasoning models stay `[]`
 * even when earlier session turns emitted reasoning events.
 */
export function inferModelThinkingLevels(
  harness?: string | null,
  modelId?: string,
  opts?: { hasReasoningEvents?: boolean; reasoning?: boolean },
): string[] {
  const hNorm = normalizeSwitchHarness(harness);
  const defaults = HARNESS_DEFAULT_THINKING_LEVELS[hNorm];
  const fallbackLevels = defaults
    ? [...defaults]
    : opts?.hasReasoningEvents || opts?.reasoning === true
      ? ["low", "medium", "high"]
      : [];

  if (opts?.reasoning === false) {
    return [];
  }

  const trimmed = modelId?.trim() || "";
  if (!trimmed) {
    return fallbackLevels;
  }

  const base = stripModelEffortSuffix(trimmed);
  if (!base || base.startsWith("@")) {
    return fallbackLevels;
  }

  if (NON_REASONING_MODEL_RE.test(base)) {
    return [];
  }

  const familyLevels = matchExplicitModelFamilyLevels(base);
  if (familyLevels) {
    return [...familyLevels];
  }

  return fallbackLevels;
}

/** Extracts an explicit `:effort` or trailing `-effort` modifier from a raw model string. */
export function extractModelExplicitEffort(rawModel?: string): string | undefined {
  const trimmed = rawModel?.trim() || "";
  if (!trimmed) return undefined;
  const base = stripModelEffortSuffix(trimmed);
  if (base !== trimmed && trimmed.length > base.length + 1) {
    return trimmed.slice(base.length + 1).toLowerCase();
  }
  const hm = TRAILING_HYPHEN_EFFORT_RE.exec(base);
  return hm?.[1]?.toLowerCase();
}

/** Resolves the matching `AgentModelOption` from a catalog list for `modelId` (including `@role` and `effortModelMap`). */
export function findModelOptionForModel(
  models: readonly AgentModelOption[] | undefined,
  modelId?: string,
  opts?: { harness?: string; modelRoles?: Record<string, string> },
): AgentModelOption | undefined {
  if (!models?.length || !modelId?.trim()) return undefined;
  let target = modelId.trim();
  if (target.startsWith("@") && opts?.harness && normalizeSwitchHarness(opts.harness) === "omp") {
    target = opts.modelRoles?.[target.slice(1).toLowerCase()] ?? target;
  }
  const clean = stripModelEffortSuffix(target).toLowerCase();
  if (!clean) return undefined;

  const exact = models.find((m) => m.id.toLowerCase() === clean);
  if (exact) return exact;

  const viaEffortMap = models.find((m) =>
    m.effortModelMap ? Object.values(m.effortModelMap).some((v) => v?.toLowerCase() === clean) : false,
  );
  if (viaEffortMap) return viaEffortMap;

  if (!clean.includes("/")) {
    const suffixMatches = models.filter((m) => m.id.toLowerCase().endsWith(`/${clean}`));
    if (suffixMatches.length === 1) return suffixMatches[0];
  }
  return undefined;
}

export interface ResolveThinkingLevelsInput {
  harness?: string | null;
  models?: readonly AgentModelOption[];
  currentModel?: string;
  modelId?: string;
  thinkingLevels?: readonly string[];
  modelRoles?: Record<string, string>;
  hasReasoningEvents?: boolean;
}

/**
 * Dynamically resolves the supported thinking levels for a specific model (never a static union across models).
 */
export function resolveThinkingLevelsForModel(
  catalogOrOpts: ResolveThinkingLevelsInput,
  modelId?: string,
  opts?: { hasReasoningEvents?: boolean },
): string[] {
  const harness = catalogOrOpts.harness;
  const hasReasoningEvents = opts?.hasReasoningEvents ?? catalogOrOpts.hasReasoningEvents;
  let target = (modelId ?? catalogOrOpts.modelId ?? catalogOrOpts.currentModel ?? "").trim();

  if (target.startsWith("@") && normalizeSwitchHarness(harness) === "omp") {
    target = catalogOrOpts.modelRoles?.[target.slice(1).toLowerCase()] ?? target;
  }

  const clean = stripModelEffortSuffix(target);
  if (!clean || clean.startsWith("@")) {
    return inferModelThinkingLevels(harness, undefined, { hasReasoningEvents });
  }

  const matched = findModelOptionForModel(catalogOrOpts.models, clean, {
    harness: harness ?? undefined,
    modelRoles: catalogOrOpts.modelRoles,
  });

  if (matched) {
    if (matched.reasoning === false || isNonReasoningModelName(matched.id)) {
      return [];
    }
    if (matched.thinkingLevels !== undefined) {
      if (matched.thinkingLevels.length > 0) {
        return [...matched.thinkingLevels];
      }
      if (matched.reasoning !== true) {
        return [];
      }
    }
    if (matchExplicitModelFamilyLevels(matched.id)) {
      return inferModelThinkingLevels(harness, matched.id, {
        hasReasoningEvents,
        reasoning: matched.reasoning,
      });
    }
    const catalogCur = catalogOrOpts.currentModel ? stripModelEffortSuffix(catalogOrOpts.currentModel).toLowerCase() : "";
    if (catalogCur && (catalogCur === matched.id.toLowerCase() || catalogCur === clean.toLowerCase()) && catalogOrOpts.thinkingLevels?.length) {
      return [...catalogOrOpts.thinkingLevels];
    }
    return inferModelThinkingLevels(harness, matched.id, {
      hasReasoningEvents,
      reasoning: matched.reasoning,
    });
  }

  if (isNonReasoningModelName(clean)) {
    return [];
  }

  if (!matchExplicitModelFamilyLevels(clean)) {
    const catalogCur = catalogOrOpts.currentModel ? stripModelEffortSuffix(catalogOrOpts.currentModel).toLowerCase() : "";
    if (catalogCur && catalogCur === clean.toLowerCase() && catalogOrOpts.thinkingLevels?.length) {
      return [...catalogOrOpts.thinkingLevels];
    }
  }

  return inferModelThinkingLevels(harness, clean, { hasReasoningEvents });
}

/** Clamps a candidate thinking effort to a valid level in `levels`, preferring any explicit suffix on `newModelRaw`. */
export function clampThinkingLevel(
  levels: readonly string[],
  candidate?: string,
  newModelRaw?: string,
): string | undefined {
  if (levels.length === 0) return undefined;
  const lowerLevels = levels.map((l) => l.toLowerCase());

  if (newModelRaw) {
    const explicit = extractModelExplicitEffort(newModelRaw);
    if (explicit) {
      const idx = lowerLevels.indexOf(explicit);
      if (idx >= 0) return levels[idx]!;
    }
  }

  const cleanCandidate = candidate?.trim().toLowerCase();
  if (!cleanCandidate) {
    return levels.length === 1 ? levels[0]! : undefined;
  }

  const exactIdx = lowerLevels.indexOf(cleanCandidate);
  if (exactIdx >= 0) return levels[exactIdx]!;

  const targetRank = EFFORT_RANK[cleanCandidate];
  if (targetRank === undefined) {
    for (const pref of ["medium", "high", "low"]) {
      const idx = lowerLevels.indexOf(pref);
      if (idx >= 0) return levels[idx]!;
    }
    return levels[0]!;
  }

  let bestIdx = 0;
  let bestDist = Infinity;
  let bestRank = -1;
  for (let i = 0; i < lowerLevels.length; i++) {
    const r = EFFORT_RANK[lowerLevels[i]!];
    if (r === undefined) continue;
    const dist = Math.abs(r - targetRank);
    if (dist < bestDist || (dist === bestDist && r > bestRank)) {
      bestDist = dist;
      bestIdx = i;
      bestRank = r;
    }
  }
  return levels[bestIdx]!;
}

/**
 * Synchronously infers normalized model ID, current thinking effort, and per-model thinking levels
 * from a harness name and optional raw model string so UI controls can render with 0ms wait.
 */
export function inferAgentModelAndThinking(
  harness?: string | null,
  rawModel?: string,
  opts?: { hasReasoningEvents?: boolean; thinkingLevel?: string },
): { currentModel?: string; currentThinking?: string; thinkingLevels?: string[] } {
  const hNorm = normalizeSwitchHarness(harness);
  const hasKnownHarness = Boolean(HARNESS_DEFAULT_THINKING_LEVELS[hNorm]);
  const explicitOptThinking = opts?.thinkingLevel?.trim().toLowerCase() || undefined;
  const trimmed = rawModel?.trim() || "";
  if (!trimmed) {
    const fallbackLevels = inferModelThinkingLevels(harness, undefined, opts);
    const currentThinking =
      fallbackLevels.length > 0
        ? clampThinkingLevel(fallbackLevels, explicitOptThinking)
        : explicitOptThinking;
    return {
      ...(currentThinking ? { currentThinking } : {}),
      ...(fallbackLevels.length ? { thinkingLevels: fallbackLevels } : {}),
    };
  }

  const base = stripModelEffortSuffix(trimmed);
  const colonEffort =
    base !== trimmed && trimmed.length > base.length + 1
      ? trimmed.slice(base.length + 1).toLowerCase()
      : undefined;

  if (NON_REASONING_MODEL_RE.test(base)) {
    return { currentModel: base, thinkingLevels: [] };
  }

  let hyphenEffort: string | undefined;
  if (!colonEffort) {
    const hm = TRAILING_HYPHEN_EFFORT_RE.exec(base);
    if (hm?.[1]) hyphenEffort = hm[1].toLowerCase();
  }

  const levels = inferModelThinkingLevels(harness, base, opts);
  const thinkingLevels =
    levels.length > 0
      ? levels
      : hasKnownHarness || opts?.hasReasoningEvents || Boolean(matchExplicitModelFamilyLevels(base))
        ? levels
        : undefined;
  const rawThinking = colonEffort ?? hyphenEffort ?? explicitOptThinking;
  const currentThinking =
    thinkingLevels && thinkingLevels.length > 0
      ? clampThinkingLevel(thinkingLevels, rawThinking, trimmed)
      : rawThinking;

  return {
    currentModel: base,
    ...(currentThinking ? { currentThinking } : {}),
    ...(thinkingLevels ? { thinkingLevels } : {}),
  };
}

const FALLBACK_MODEL_PRESETS: Record<string, readonly AgentModelOption[]> = {
  omp: [
    { id: "magpie/crosery/gpt-6.2-astra-fast", label: "GPT 6.2 Astra Fast", provider: "magpie", reasoning: true, source: "catalog" },
    { id: "magpie/crosery/gpt-6.2-sol-ultrafast", label: "GPT 6.2 Sol Ultrafast", provider: "magpie", reasoning: true, source: "catalog" },
    { id: "magpie/crosery/claude-opus-5", label: "Claude Opus 5", provider: "magpie", reasoning: true, source: "catalog" },
    { id: "magpie/crosery/claude-sonnet-5", label: "Claude Sonnet 5", provider: "magpie", reasoning: true, source: "catalog" },
    { id: "google/gemini-4-neon", label: "Gemini 4 Neon", provider: "google", reasoning: true, source: "catalog" },
  ],
  pi: [
    { id: "crosery/gpt-6.2-astra", label: "GPT-6.2 Astra", provider: "crosery", reasoning: true, source: "catalog" },
    { id: "crosery/claude-opus-5-5", label: "Claude Opus 5.5", provider: "crosery", reasoning: true, source: "catalog" },
    { id: "google/gemini-4-neon", label: "Gemini 4 Neon", provider: "google", reasoning: true, source: "catalog" },
    { id: "openrouter/free", label: "OpenRouter Free", provider: "openrouter", source: "catalog" },
  ],
  claude: [
    { id: "default", label: "Default", provider: "anthropic", source: "catalog" },
    { id: "opus", label: "Opus", provider: "anthropic", source: "catalog" },
    { id: "sonnet", label: "Sonnet", provider: "anthropic", source: "catalog" },
    { id: "haiku", label: "Haiku", provider: "anthropic", source: "catalog" },
    { id: "opusplan", label: "Opus Plan", provider: "anthropic", source: "catalog" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", source: "catalog" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", source: "catalog" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic", source: "catalog" },
  ],
  codex: [
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", provider: "openai", source: "catalog" },
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", provider: "openai", source: "catalog" },
    { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "openai", source: "catalog" },
  ],
  gemini: [
    { id: "gemini-3.5-pro", label: "Gemini 3.5 Pro", provider: "google", source: "catalog" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High", provider: "google", source: "catalog" },
    { id: "gemini-4-neon", label: "Gemini 4 Neon", provider: "google", source: "catalog" },
  ],
  antigravity: [
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", provider: "google", source: "catalog" },
    { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)", provider: "google", source: "catalog" },
    { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)", provider: "google", source: "catalog" },
  ],
  opencode: [
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5", provider: "anthropic", source: "catalog" },
    { id: "openai/gpt-6.2-astra", label: "GPT-6.2 Astra", provider: "openai", source: "catalog" },
    { id: "google/gemini-4-neon", label: "Gemini 4 Neon", provider: "google", source: "catalog" },
  ],
  dsh: [
    { id: "deepseek-chat", label: "DeepSeek Chat", provider: "deepseek", source: "catalog" },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner", provider: "deepseek", reasoning: true, source: "catalog" },
  ],
  hermes: [
    { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic", source: "catalog" },
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", provider: "openai", source: "catalog" },
    { id: "gemini-4-neon", label: "Gemini 4 Neon", provider: "google", source: "catalog" },
  ],
};

/**
 * Synthesizes a client-side `AgentModelsResult` fallback when an older remote host returns
 * `unsupported` / `unknown method agent.models`, merging current model, peer models, and presets.
 */
export function synthesizeFallbackAgentModels(
  agent: Pick<Agent, "harness" | "model" | "thinkingLevel" | "isShell" | "source">,
  peerModels: readonly string[] = [],
  opts?: { hasReasoningEvents?: boolean; thinkingLevel?: string },
): AgentModelsResult {
  const canSwitch = !agent.isShell && (agent.source === "hc" || agent.source === "herdr");
  const reason = agent.isShell
    ? "普通终端不支持切换模型"
    : agent.source === "uniflo"
      ? "历史只读会话无法直接切换模型"
      : undefined;

  if (agent.isShell) {
    const clean = agent.model?.trim();
    return {
      harness: agent.harness,
      ...(clean ? { currentModel: clean } : {}),
      canSwitchThinking: false,
      canSwitch: false,
      ...(reason ? { reason } : {}),
      models: clean ? [{ id: clean, label: clean, source: "current" }] : [],
    };
  }

  const hNorm = normalizeSwitchHarness(agent.harness);
  const optThinking = opts?.thinkingLevel?.trim() || agent.thinkingLevel?.trim() || undefined;
  const inferred = inferAgentModelAndThinking(agent.harness, agent.model, {
    hasReasoningEvents: opts?.hasReasoningEvents,
    thinkingLevel: optThinking,
  });
  const models: AgentModelOption[] = [];
  const seen = new Set<string>();

  const push = (opt: AgentModelOption) => {
    const clean = opt.id.trim();
    const key = clean.toLowerCase();
    if (!key || seen.has(key) || models.length >= 200) return;
    seen.add(key);
    models.push({ ...opt, id: clean });
  };

  if (inferred.currentModel) {
    push({
      id: inferred.currentModel,
      label: inferred.currentModel,
      ...(inferred.thinkingLevels?.length
        ? { reasoning: true, thinkingLevels: inferred.thinkingLevels }
        : inferred.thinkingLevels
          ? { reasoning: false }
          : {}),
      source: "current",
    });
  }

  for (const rawPeer of peerModels) {
    const peerInf = inferAgentModelAndThinking(agent.harness, rawPeer);
    if (!peerInf.currentModel) continue;
    push({
      id: peerInf.currentModel,
      label: peerInf.currentModel,
      ...(peerInf.thinkingLevels?.length
        ? { reasoning: true, thinkingLevels: peerInf.thinkingLevels }
        : peerInf.thinkingLevels
          ? { reasoning: false }
          : {}),
      source: "recent",
    });
  }

  const presets = FALLBACK_MODEL_PRESETS[hNorm] ?? (models.length === 0 ? FALLBACK_MODEL_PRESETS.claude ?? [] : []);
  for (const preset of presets) {
    const levels = preset.thinkingLevels?.length
      ? [...preset.thinkingLevels]
      : inferModelThinkingLevels(agent.harness, preset.id, { reasoning: preset.reasoning });
    push({
      ...preset,
      ...(levels.length
        ? { reasoning: preset.reasoning ?? true, thinkingLevels: levels }
        : preset.reasoning === false || isNonReasoningModelName(preset.id)
          ? { reasoning: false }
          : {}),
    });
  }

  const resolvedLevels = resolveThinkingLevelsForModel(
    {
      harness: agent.harness,
      models,
      currentModel: inferred.currentModel,
      hasReasoningEvents: opts?.hasReasoningEvents,
    },
    inferred.currentModel,
  );
  const currentThinking = clampThinkingLevel(resolvedLevels, inferred.currentThinking ?? optThinking, agent.model);

  return {
    harness: agent.harness,
    ...(inferred.currentModel ? { currentModel: inferred.currentModel } : {}),
    ...(currentThinking ? { currentThinking } : {}),
    ...(resolvedLevels.length
      ? { thinkingLevels: resolvedLevels, canSwitchThinking: canSwitch, thinkingLabel: "思考等级" }
      : { canSwitchThinking: false }),
    canSwitch,
    ...(reason ? { reason } : {}),
    models,
  };
}

const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\x1b[@-Z\\-_]/g;
const TERMINAL_PUA_RE = /[\uE000-\uF8FF\uFE0E\uFE0F\u200B-\u200D\uFEFF]|\p{Private_Use}/gu;

const TERMINAL_EFFORT_ALIASES: Record<string, string> = {
  off: "off",
  none: "none",
  minimal: "minimal",
  min: "minimal",
  low: "low",
  lo: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  hi: "high",
  xhigh: "xhigh",
  xhi: "xhigh",
  max: "max",
  ultra: "ultra",
  auto: "auto",
  default: "default",
  normal: "normal",
  fast: "fast",
  smart: "smart",
  rush: "rush",
};

const AGY_MODE_WORDS = new Set(["auto", "plan", "ask", "code", "agent", "build", "chat", "edit", "yolo"]);

function stripAnsiEscapes(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_ESC_RE, "");
}

function stripTerminalIcons(raw: string): string {
  return raw.replace(TERMINAL_PUA_RE, " ");
}

function parseTerminalEffortToken(raw: string, opts?: { allowAuto?: boolean }): string | undefined {
  let clean = stripTerminalIcons(raw)
    .replace(/^(?:thinking|effort|reasoning)\s*[:=]\s*/i, "")
    .trim();
  const paren = /^\(([^()]+)\)$/.exec(clean);
  if (paren?.[1]) clean = paren[1].trim();
  clean = clean.toLowerCase();
  if (!clean) return undefined;
  const mapped = TERMINAL_EFFORT_ALIASES[clean];
  if (!mapped) return undefined;
  if (opts?.allowAuto === false && mapped === "auto") return undefined;
  return mapped;
}

function looseMatchKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toModelSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/\.-|-\./g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
}

function isNonModelStatusSegment(seg: string): boolean {
  const s = seg.trim();
  if (!s) return true;
  if (/^(?:~\/|\/|\.\/|\.\.\/|[a-z]:\\)/i.test(s)) return true;
  if (/^\([^()]+\)$/.test(s)) return true;
  if (/^\$[\d.,]+$/.test(s)) return true;
  if (/^\d+(?:\.\d+)?%$/.test(s)) return true;
  if (/^\d+(?:\.\d+)?[kmgt]?\s*\/\s*\d+(?:\.\d+)?[kmgt]?(?:\s*\([^)]*\))?$/i.test(s)) return true;
  if (/^\d+(?:\.\d+)?\s*(?:ms|s|m|tok|tokens|ctx|left)\b/i.test(s)) return true;
  if (/^(?:esc|tab|ctrl|shift|enter)\b/i.test(s)) return true;
  return false;
}

function looksLikeModelDisplayOrId(seg: string): boolean {
  const s = seg.trim();
  if (!s || isNonModelStatusSegment(s)) return false;
  if (s.includes("/")) return /^[a-z0-9._-]+(?:\/[a-z0-9._:-]+)+$/i.test(s);
  return /(?:gpt|claude|opus|sonnet|haiku|gemini|gemma|deepseek|mimo|kimi|qwen|grok|llama|mistral|codex|orchestrator|worker|o[134](?:\b|-)|k3\b)/i.test(
    s,
  );
}

function matchCatalogOption(
  catalog: readonly AgentModelOption[] | undefined,
  displayOrId: string,
  opts?: { effort?: string; providerHint?: string },
): AgentModelOption | undefined {
  if (!catalog?.length) return undefined;
  const trimmed = displayOrId.trim();
  if (!trimmed) return undefined;

  const rawLow = trimmed.toLowerCase();
  const slug = toModelSlug(trimmed);
  const loose = looseMatchKey(trimmed);
  if (!loose) return undefined;

  const effort = opts?.effort?.trim().toLowerCase();
  const slugWithEffort = effort && slug && !slug.endsWith(`-${effort}`) ? `${slug}-${effort}` : "";
  const looseWithEffort = effort ? looseMatchKey(`${trimmed} ${effort}`) : "";
  const prov = opts?.providerHint?.trim().toLowerCase();

  let best: AgentModelOption | undefined;
  let bestScore = 0;

  for (const opt of catalog) {
    const idLow = opt.id.toLowerCase();
    const idLeaf = idLow.split("/").pop() ?? idLow;
    const idLoose = looseMatchKey(opt.id);
    const leafLoose = looseMatchKey(idLeaf);
    const labelLow = opt.label.trim().toLowerCase();
    const labelLoose = looseMatchKey(opt.label);
    const provMatches = prov
      ? opt.provider?.toLowerCase() === prov || idLow.startsWith(`${prov}/`) || idLow.includes(`/${prov}/`)
      : false;

    let score = 0;
    if (slugWithEffort && idLow === slugWithEffort) {
      score = 100;
    } else if (idLow === rawLow || (slug && idLow === slug)) {
      score = 95;
    } else if (prov && idLow === `${prov}/${slug}`) {
      score = 94;
    } else if (looseWithEffort && labelLoose === looseWithEffort) {
      score = 90;
    } else if (labelLow === rawLow || labelLoose === loose) {
      score = provMatches ? 88 : 78;
    } else if (provMatches && (leafLoose === loose || (looseWithEffort && leafLoose === looseWithEffort))) {
      score = 86;
    } else if (leafLoose === loose || (looseWithEffort && leafLoose === looseWithEffort)) {
      score = 72;
    } else if (idLoose === loose || (looseWithEffort && idLoose === looseWithEffort)) {
      score = 70;
    } else if (loose.includes("-") && (leafLoose.endsWith(`-${loose}`) || labelLoose.endsWith(`-${loose}`))) {
      score = 62;
    }

    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }

  if (!best) return undefined;
  if (effort && best.effortModelMap?.[effort]) {
    const targetId = best.effortModelMap[effort]!;
    return catalog.find((m) => m.id.toLowerCase() === targetId.toLowerCase()) ?? { ...best, id: targetId };
  }
  return best;
}

function splitStatusColumnsAndSegments(line: string): string[][] {
  const noIcons = stripTerminalIcons(line)
    .replace(/\s*([·•|])\s*/g, " $1 ")
    .trim();
  if (!noIcons) return [];
  const cols = noIcons
    .split(/ {4,}|\t+/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return cols.map((col) =>
    col
      .split(/\s*[·•|]\s*/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function parseAntigravityStatusLine(
  line: string,
  catalog?: readonly AgentModelOption[],
): { currentModel?: string; currentThinking?: string } | null {
  for (const segs of splitStatusColumnsAndSegments(line)) {
    if (segs.length === 0) continue;
    let start = 0;
    while (start < segs.length && (AGY_MODE_WORDS.has(segs[start]!.toLowerCase()) || isNonModelStatusSegment(segs[start]!))) {
      start++;
    }
    const body = segs.slice(start);
    if (body.length === 0) continue;

    let effort: string | undefined;
    const nonEffort: string[] = [];
    for (let i = 0; i < body.length; i++) {
      const seg = body[i]!;
      const eff = i > 0 ? parseTerminalEffortToken(seg, { allowAuto: false }) : undefined;
      if (eff && !effort) {
        effort = eff;
      } else if (!isNonModelStatusSegment(seg)) {
        nonEffort.push(seg);
      }
    }

    const candidate = nonEffort[0];
    if (!candidate) continue;

    let display = candidate;
    if (!effort) {
      const parenEff = /^(.+?)\s*\((minimal|min|low|medium|med|high|xhigh|xhi|max)\)$/i.exec(candidate);
      if (parenEff?.[1] && parenEff[2]) {
        const parsedEff = parseTerminalEffortToken(parenEff[2], { allowAuto: false });
        if (parsedEff) {
          display = parenEff[1].trim();
          effort = parsedEff;
        }
      }
    }

    const catalogHit = matchCatalogOption(catalog, display, { effort });
    if (!catalogHit && start === 0 && !effort && !looksLikeModelDisplayOrId(display)) {
      continue;
    }

    if (catalogHit) {
      const resolvedThinking = effort ?? extractModelExplicitEffort(catalogHit.id);
      return {
        currentModel: catalogHit.id,
        ...(resolvedThinking ? { currentThinking: resolvedThinking } : {}),
      };
    }

    const slug = toModelSlug(display);
    if (!slug) continue;
    const currentModel = effort && !slug.endsWith(`-${effort}`) ? `${slug}-${effort}` : slug;
    const resolvedThinking = effort ?? extractModelExplicitEffort(currentModel);
    return {
      currentModel,
      ...(resolvedThinking ? { currentThinking: resolvedThinking } : {}),
    };
  }
  return null;
}

function parseOmpStatusLine(
  line: string,
  catalog?: readonly AgentModelOption[],
): { currentModel?: string; currentThinking?: string } | null {
  for (const segs of splitStatusColumnsAndSegments(line)) {
    if (segs.length === 0) continue;

    let effort: string | undefined;
    const candidateIndices: number[] = [];
    let hasStatusMetric = false;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const eff = i >= 1 ? parseTerminalEffortToken(seg, { allowAuto: true }) : undefined;
      if (eff && !effort) {
        effort = eff;
        continue;
      }
      if (isNonModelStatusSegment(seg)) {
        hasStatusMetric = true;
        continue;
      }
      candidateIndices.push(i);
    }

    if (candidateIndices.length === 0) continue;

    const extractInlineEffort = (raw: string): { clean: string; effort?: string } => {
      const base = stripModelEffortSuffix(raw);
      if (base !== raw && raw.length > base.length + 1) {
        return { clean: base, effort: raw.slice(base.length + 1).toLowerCase() };
      }
      return { clean: raw };
    };

    const isProvToken = (s: string) =>
      /^[a-z0-9][a-z0-9._-]{1,30}$/i.test(s) &&
      !looksLikeModelDisplayOrId(s) &&
      !parseTerminalEffortToken(s, { allowAuto: true }) &&
      !isNonModelStatusSegment(s);

    let bestCatalogHit: { opt: AgentModelOption; eff?: string } | undefined;
    for (const idx of candidateIndices) {
      const rawSeg = segs[idx]!;
      const { clean, effort: inlineEff } = extractInlineEffort(rawSeg);
      const adjPrev = idx > 0 ? segs[idx - 1]! : undefined;
      const adjNext = idx + 1 < segs.length ? segs[idx + 1]! : undefined;
      const provHint =
        adjNext && isProvToken(adjNext)
          ? adjNext
          : adjPrev && isProvToken(adjPrev)
            ? adjPrev
            : undefined;
      const hit = matchCatalogOption(catalog, clean, {
        effort: effort ?? inlineEff,
        providerHint: provHint,
      });
      if (hit) {
        bestCatalogHit = { opt: hit, eff: effort ?? inlineEff };
        break;
      }
    }

    if (bestCatalogHit) {
      const finalEff = bestCatalogHit.eff ?? extractModelExplicitEffort(bestCatalogHit.opt.id);
      return {
        currentModel: bestCatalogHit.opt.id,
        ...(finalEff ? { currentThinking: finalEff } : {}),
      };
    }

    for (const idx of candidateIndices) {
      const rawSeg = segs[idx]!;
      const { clean, effort: inlineEff } = extractInlineEffort(rawSeg);
      const finalEff = effort ?? inlineEff;
      if (!looksLikeModelDisplayOrId(clean) && !(finalEff && candidateIndices.length <= 2 && idx === 0 && (segs.length >= 2 || hasStatusMetric))) {
        continue;
      }
      const slug = toModelSlug(clean);
      if (!slug) continue;
      const adjNext = idx + 1 < segs.length ? segs[idx + 1]! : undefined;
      const adjPrev = idx > 0 ? segs[idx - 1]! : undefined;
      const provHint =
        adjNext && isProvToken(adjNext)
          ? adjNext.toLowerCase()
          : adjPrev && isProvToken(adjPrev)
            ? adjPrev.toLowerCase()
            : undefined;
      const currentModel = provHint && !slug.includes("/") ? `${provHint}/${slug}` : slug;
      return {
        currentModel,
        ...(finalEff ? { currentThinking: finalEff } : {}),
      };
    }
  }
  return null;
}

function normalizeClaudeBracketModel(
  inner: string,
  catalog?: readonly AgentModelOption[],
): { model?: string; effort?: string } {
  let clean = inner.replace(/\([^)]*(?:context|ctx|token)[^)]*\)/gi, "").trim();
  if (!clean) return {};

  let effort: string | undefined;
  const parts = clean.split(/\s*[|·•]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const tailEff = parseTerminalEffortToken(parts[parts.length - 1]!, { allowAuto: true });
    if (tailEff) {
      effort = tailEff;
      clean = parts.slice(0, -1).join(" ").trim();
    }
  }

  const catalogHit = matchCatalogOption(catalog, clean, { effort });
  if (catalogHit) {
    return { model: catalogHit.id, ...(effort ? { effort } : {}) };
  }

  const famVer = /^(?:claude[\s-]+)?(opus|sonnet|haiku)[\s-]+(\d+(?:[.-]\d+)?)$/i.exec(clean);
  if (famVer?.[1] && famVer[2]) {
    return {
      model: `claude-${famVer[1].toLowerCase()}-${famVer[2].replace(/\./g, "-")}`,
      ...(effort ? { effort } : {}),
    };
  }
  const famOnly = /^(?:claude[\s-]+)?(opus|sonnet|haiku)$/i.exec(clean);
  if (famOnly?.[1]) {
    return { model: famOnly[1].toLowerCase(), ...(effort ? { effort } : {}) };
  }
  if (/^claude-[a-z0-9.-]+$/i.test(clean)) {
    return { model: clean.toLowerCase(), ...(effort ? { effort } : {}) };
  }
  return {};
}

function parseClaudeStatusLine(
  line: string,
  catalog?: readonly AgentModelOption[],
): { currentModel?: string; currentThinking?: string } | null {
  const cleanLine = stripTerminalIcons(line).replace(/\s+/g, " ").trim();
  if (!cleanLine) return null;

  const extractLineEffort = (): string | undefined => {
    const labeled = /\b(?:effort|thinking)\s*[:=]\s*(minimal|min|low|lo|medium|med|high|hi|xhigh|xhi|max|auto)\b/i.exec(cleanLine);
    if (labeled?.[1]) return parseTerminalEffortToken(labeled[1], { allowAuto: true });
    const suffixEff = /\b(minimal|low|medium|high|xhigh|max)\s+effort\b/i.exec(cleanLine);
    if (suffixEff?.[1]) return parseTerminalEffortToken(suffixEff[1], { allowAuto: false });
    for (const segs of splitStatusColumnsAndSegments(line)) {
      if (segs.length < 2) continue;
      for (const seg of segs) {
        const eff = parseTerminalEffortToken(seg, { allowAuto: true });
        if (eff) return eff;
      }
    }
    return undefined;
  };

  for (const m of cleanLine.matchAll(/\[([^\[\]]{2,64})\]/g)) {
    const parsed = normalizeClaudeBracketModel(m[1]!, catalog);
    if (parsed.model) {
      const eff = parsed.effort ?? extractLineEffort();
      return {
        currentModel: parsed.model,
        ...(eff ? { currentThinking: eff } : {}),
      };
    }
  }

  for (const segs of splitStatusColumnsAndSegments(line)) {
    for (const seg of segs) {
      if (/^claude-[a-z0-9._-]+$/i.test(seg)) {
        const hit = matchCatalogOption(catalog, seg);
        const eff = extractLineEffort() ?? extractModelExplicitEffort(hit?.id ?? seg);
        return {
          currentModel: hit?.id ?? seg.toLowerCase(),
          ...(eff ? { currentThinking: eff } : {}),
        };
      }
      if (segs.length >= 2) {
        const parsed = normalizeClaudeBracketModel(seg, catalog);
        if (parsed.model) {
          const eff = parsed.effort ?? extractLineEffort();
          return {
            currentModel: parsed.model,
            ...(eff ? { currentThinking: eff } : {}),
          };
        }
      }
    }
  }

  return null;
}

function parseCodexOrGeminiStatusLine(
  hNorm: string,
  line: string,
  catalog?: readonly AgentModelOption[],
): { currentModel?: string; currentThinking?: string } | null {
  const cleanLine = stripTerminalIcons(line).replace(/\s+/g, " ").trim();
  if (!cleanLine) return null;

  if (hNorm === "codex") {
    const m = /\b((?:gpt-[a-z0-9._-]+|o[134](?:-[a-z0-9._-]+)?|codex-[a-z0-9._-]+))\b(?:\s*(?:\(([^)]+)\)|[·•|]?\s*(minimal|min|low|lo|medium|med|high|hi|xhigh|xhi|max)\b))?/i.exec(
      cleanLine,
    );
    if (m?.[1]) {
      const rawId = m[1];
      const eff = parseTerminalEffortToken(m[2] ?? m[3] ?? "", { allowAuto: false }) ?? extractModelExplicitEffort(rawId);
      const hit = matchCatalogOption(catalog, rawId, { effort: eff });
      return {
        currentModel: hit?.id ?? rawId.toLowerCase(),
        ...(eff ? { currentThinking: eff } : {}),
      };
    }
  }

  if (hNorm === "gemini") {
    const m = /\b(gemini-[a-z0-9._-]+)\b/i.exec(cleanLine);
    if (m?.[1]) {
      const rawId = m[1];
      let eff = extractModelExplicitEffort(rawId);
      if (!eff) {
        for (const segs of splitStatusColumnsAndSegments(line)) {
          if (segs.length < 2) continue;
          for (const seg of segs) {
            const e = parseTerminalEffortToken(seg, { allowAuto: false });
            if (e) {
              eff = e;
              break;
            }
          }
          if (eff) break;
        }
      }
      const hit = matchCatalogOption(catalog, rawId, { effort: eff });
      return {
        currentModel: hit?.id ?? rawId.toLowerCase(),
        ...(eff ? { currentThinking: eff } : {}),
      };
    }
  }

  return parseOmpStatusLine(line, catalog);
}

/**
 * Parses live model ID and thinking effort from the bottom ~16 non-empty lines of a terminal screen
 * (scanning bottom-up so the active status bar wins over stale scrollback).
 */
export function parseTerminalModelAndThinking(
  harness: string | null | undefined,
  screenText: string,
  catalog?: readonly AgentModelOption[],
): { currentModel?: string; currentThinking?: string } {
  if (!screenText) return {};
  const stripped = stripAnsiEscapes(screenText);
  const nonEmptyLines = stripped
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0 && !/^[\s─━═\-_|│┌┐└┘├┤┬┴┼╭╮╰╯]+$/.test(l.trim()))
    .slice(-16);

  if (nonEmptyLines.length === 0) return {};
  const hNorm = normalizeSwitchHarness(harness);

  for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
    const line = nonEmptyLines[i]!;
    let parsed: { currentModel?: string; currentThinking?: string } | null = null;
    if (hNorm === "antigravity") {
      parsed = parseAntigravityStatusLine(line, catalog);
    } else if (hNorm === "omp" || hNorm === "pi") {
      parsed = parseOmpStatusLine(line, catalog);
    } else if (hNorm === "claude") {
      parsed = parseClaudeStatusLine(line, catalog);
    } else if (hNorm === "codex" || hNorm === "gemini") {
      parsed = parseCodexOrGeminiStatusLine(hNorm, line, catalog);
    } else {
      parsed =
        parseClaudeStatusLine(line, catalog) ??
        parseAntigravityStatusLine(line, catalog) ??
        parseOmpStatusLine(line, catalog);
    }
    if (parsed?.currentModel) {
      return parsed;
    }
  }

  return {};
}

/**
 * Merges live model and thinking effort parsed from `screenText` into an existing `AgentModelsResult`
 * when `currentModel` or `currentThinking` is still missing, updating `models` and `thinkingLevels`.
 */
export function applyTerminalModelFallback(
  base: AgentModelsResult,
  harness: string,
  screenText: string,
  opts?: { thinkingLevel?: string; hasReasoningEvents?: boolean },
): AgentModelsResult {
  if (!screenText.trim()) return base;
  const models = Array.isArray(base.models) ? base.models : [];
  const effectiveHarness = base.harness || harness;
  const parsed = parseTerminalModelAndThinking(effectiveHarness, screenText, models);
  if (!parsed.currentModel && !parsed.currentThinking) return base;

  const curModel = base.currentModel?.trim() || "";
  const rawResolvedModel = curModel || parsed.currentModel;
  const matchedOpt = rawResolvedModel
    ? findModelOptionForModel(models, rawResolvedModel, {
        harness: effectiveHarness,
        modelRoles: base.modelRoles,
      })
    : undefined;
  const nextModel = matchedOpt?.id ?? rawResolvedModel;

  const nextModels = [...models];
  if (nextModel && !nextModels.some((m) => m.id.toLowerCase() === nextModel.toLowerCase())) {
    nextModels.unshift({ id: nextModel, label: nextModel, source: "current" });
  }

  const nextLevels = resolveThinkingLevelsForModel(
    {
      ...base,
      harness: effectiveHarness,
      models: nextModels,
      currentModel: nextModel,
      hasReasoningEvents: opts?.hasReasoningEvents,
    },
    nextModel,
  );
  const rawThinking =
    base.currentThinking?.trim().toLowerCase() ||
    parsed.currentThinking ||
    opts?.thinkingLevel?.trim().toLowerCase() ||
    extractModelExplicitEffort(nextModel);
  const nextThinking =
    nextLevels.length > 0 ? clampThinkingLevel(nextLevels, rawThinking, nextModel) : undefined;

  return {
    ...base,
    ...(nextModel ? { currentModel: nextModel } : {}),
    ...(nextThinking ? { currentThinking: nextThinking } : {}),
    ...(nextLevels.length > 0
      ? {
          thinkingLevels: nextLevels,
          canSwitchThinking: base.canSwitch,
          thinkingLabel: base.thinkingLabel || "思考等级",
        }
      : { thinkingLevels: undefined, canSwitchThinking: false }),
    models: nextModels,
  };
}
