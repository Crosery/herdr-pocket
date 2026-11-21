import type { Agent, AgentModelOption, AgentModelsResult } from "./index.ts";

const EFFORT_SUFFIX_RE = /:(off|none|minimal|min|low|medium|med|high|xhigh|max|ultra|auto|default)$/i;
const TRAILING_HYPHEN_EFFORT_RE = /-(minimal|low|medium|high|xhigh)$/i;
const NON_REASONING_MODEL_RE =
  /(?:^|\/)(?:gemini-(?:1\.5|2\.0)-|gemma-3-|(?:mimo-v2\.5-asr|codex-auto-review|gpt-reserve|kimi-for-coding-highspeed)(?:$|[-:@]))/i;

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

/**
 * Synchronously infers normalized model ID, current thinking effort, and available thinking levels
 * from a harness name and optional raw model string so UI controls can render with 0ms wait.
 */
export function inferAgentModelAndThinking(
  harness: string,
  rawModel?: string,
  opts?: { hasReasoningEvents?: boolean },
): { currentModel?: string; currentThinking?: string; thinkingLevels?: string[] } {
  const hNorm = normalizeSwitchHarness(harness);
  const defaults = HARNESS_DEFAULT_THINKING_LEVELS[hNorm];
  const fallbackLevels = defaults
    ? [...defaults]
    : opts?.hasReasoningEvents
      ? ["low", "medium", "high"]
      : undefined;
  const trimmed = rawModel?.trim() || "";
  if (!trimmed) {
    return fallbackLevels ? { thinkingLevels: fallbackLevels } : {};
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

  const currentThinking = colonEffort ?? hyphenEffort;
  const thinkingLevels = fallbackLevels;

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
  const harnessLevels = HARNESS_DEFAULT_THINKING_LEVELS[hNorm];
  for (const preset of presets) {
    const pInf = inferAgentModelAndThinking(agent.harness, preset.id);
    const levels = preset.thinkingLevels ?? (pInf.thinkingLevels?.length ? pInf.thinkingLevels : preset.reasoning && harnessLevels ? [...harnessLevels] : undefined);
    push({
      ...preset,
      ...(levels?.length ? { thinkingLevels: levels } : {}),
    });
  }

  return {
    harness: agent.harness,
    ...(inferred.currentModel ? { currentModel: inferred.currentModel } : {}),
    ...(inferred.currentThinking ? { currentThinking: inferred.currentThinking } : {}),
    ...(inferred.thinkingLevels?.length
      ? { thinkingLevels: inferred.thinkingLevels, canSwitchThinking: canSwitch, thinkingLabel: "思考等级" }
      : { canSwitchThinking: false }),
    canSwitch,
    ...(reason ? { reason } : {}),
    models,
  };
}
