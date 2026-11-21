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
export function stripModelEffortSuffix(modelId: string): string {
  return modelId.trim().replace(EFFORT_SUFFIX_RE, "");
}

/** Normalizes any harness identifier into its canonical CLI/family key for model & effort switching. */
export function normalizeSwitchHarness(raw: string): string {
  const h = raw.trim().toLowerCase();
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
export function isNonReasoningModelName(modelId: string): boolean {
  const base = stripModelEffortSuffix(modelId.trim());
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
 * defaults only when `modelId` is empty or unknown.
 */
export function inferModelThinkingLevels(
  harness: string,
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

  if (opts?.reasoning === false && !opts?.hasReasoningEvents) {
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
    return opts?.hasReasoningEvents ? fallbackLevels : [];
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
  harness: string;
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
    harness,
    modelRoles: catalogOrOpts.modelRoles,
  });

  if (matched) {
    if (matched.reasoning === false && !hasReasoningEvents) {
      return [];
    }
    if (matched.thinkingLevels?.length) {
      return [...matched.thinkingLevels];
    }
    if (matchExplicitModelFamilyLevels(matched.id) || (!hasReasoningEvents && isNonReasoningModelName(matched.id))) {
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

  if (!matchExplicitModelFamilyLevels(clean) && (hasReasoningEvents || !isNonReasoningModelName(clean))) {
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
  harness: string,
  rawModel?: string,
  opts?: { hasReasoningEvents?: boolean },
): { currentModel?: string; currentThinking?: string; thinkingLevels?: string[] } {
  const hNorm = normalizeSwitchHarness(harness);
  const hasKnownHarness = Boolean(HARNESS_DEFAULT_THINKING_LEVELS[hNorm]);
  const trimmed = rawModel?.trim() || "";
  if (!trimmed) {
    const fallbackLevels = inferModelThinkingLevels(harness, undefined, opts);
    return fallbackLevels.length ? { thinkingLevels: fallbackLevels } : {};
  }

  const base = stripModelEffortSuffix(trimmed);
  const colonEffort =
    base !== trimmed && trimmed.length > base.length + 1
      ? trimmed.slice(base.length + 1).toLowerCase()
      : undefined;

  if (!opts?.hasReasoningEvents && NON_REASONING_MODEL_RE.test(base)) {
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
  const rawThinking = colonEffort ?? hyphenEffort;
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
  agent: Pick<Agent, "harness" | "model" | "isShell" | "source">,
  peerModels: readonly string[] = [],
  opts?: { hasReasoningEvents?: boolean },
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
  const inferred = inferAgentModelAndThinking(agent.harness, agent.model, {
    hasReasoningEvents: opts?.hasReasoningEvents,
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
  const currentThinking = clampThinkingLevel(resolvedLevels, inferred.currentThinking, agent.model);

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
