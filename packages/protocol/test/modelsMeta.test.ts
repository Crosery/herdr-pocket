import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HARNESS_DEFAULT_THINKING_LEVELS,
  clampThinkingLevel,
  inferAgentModelAndThinking,
  inferModelThinkingLevels,
  normalizeSwitchHarness,
  resolveThinkingLevelsForModel,
  stripModelEffortSuffix,
  synthesizeFallbackAgentModels,
} from "../src/index.ts";

test("HARNESS_DEFAULT_THINKING_LEVELS covers all 19 supported harnesses", () => {
  const expected = [
    "omp",
    "pi",
    "claude",
    "codex",
    "antigravity",
    "gemini",
    "opencode",
    "dsh",
    "hermes",
    "grok",
    "aider",
    "factory",
    "amp",
    "cursor",
    "kimi",
    "qwen",
    "qoder",
    "codebuddy",
    "goose",
  ];
  for (const key of expected) {
    assert.ok((HARNESS_DEFAULT_THINKING_LEVELS[key]?.length ?? 0) >= 2, `missing levels for ${key}`);
  }
});

test("inferAgentModelAndThinking detects colon effort, hyphen effort, per-model levels, non-reasoning models, and harness defaults", () => {
  assert.deepEqual(inferAgentModelAndThinking("claude-code", "claude-opus-4-6:high"), {
    currentModel: "claude-opus-4-6",
    currentThinking: "high",
    thinkingLevels: ["low", "medium", "high", "max"],
  });

  assert.deepEqual(inferAgentModelAndThinking("antigravity", "gemini-4-neon-xhigh"), {
    currentModel: "gemini-4-neon-xhigh",
    currentThinking: "xhigh",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  });

  assert.deepEqual(inferAgentModelAndThinking("gemini", "gemini-3.8-flash-high"), {
    currentModel: "gemini-3.8-flash-high",
    currentThinking: "high",
    thinkingLevels: ["low", "medium", "high"],
  });

  assert.deepEqual(inferAgentModelAndThinking("omp"), {
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
  });

  assert.deepEqual(inferAgentModelAndThinking("omp", "magpie/crosery/gpt-6.2-astra-fast"), {
    currentModel: "magpie/crosery/gpt-6.2-astra-fast",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  });

  // mimo-v2.6-pro and gpt-6-chat-thinking are reasoning-capable models and must expose thinking levels
  assert.deepEqual(inferAgentModelAndThinking("omp", "magpie/crosery/mimo-v2.6-pro"), {
    currentModel: "magpie/crosery/mimo-v2.6-pro",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  });
  assert.deepEqual(inferAgentModelAndThinking("omp", "magpie/crosery/gpt-6-chat-thinking:high"), {
    currentModel: "magpie/crosery/gpt-6-chat-thinking",
    currentThinking: "high",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  });

  // Explicit non-reasoning models must return empty thinkingLevels unless reasoning events were emitted
  for (const nonReasoning of [
    "google/gemini-1.5-flash",
    "google/gemini-2.0-flash",
    "openai/gpt-4o",
    "openai/gpt-4.1-mini",
    "anthropic/claude-3-5-sonnet-20241022",
    "magpie/crosery/mimo-v2.5-asr",
    "magpie/crosery/codex-auto-review",
    "magpie/crosery/gpt-reserve",
    "magpie/crosery/kimi-for-coding-highspeed",
  ]) {
    assert.deepEqual(inferAgentModelAndThinking("omp", nonReasoning), {
      currentModel: nonReasoning,
      thinkingLevels: [],
    });
    assert.deepEqual(inferAgentModelAndThinking("omp", nonReasoning, { hasReasoningEvents: true }), {
      currentModel: nonReasoning,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
    });
  }

  // Preserves tags like :8b while stripping :high
  assert.equal(stripModelEffortSuffix("qwen3:8b"), "qwen3:8b");
  assert.equal(stripModelEffortSuffix("magpie/crosery/gpt-6.2-sol-ultrafast:max"), "magpie/crosery/gpt-6.2-sol-ultrafast");
  assert.equal(normalizeSwitchHarness("oh-my-pi"), "omp");
});

test("inferModelThinkingLevels resolves per-model family levels and falls back to harness default only when empty or unknown", () => {
  assert.deepEqual(inferModelThinkingLevels("antigravity", "gemini-4-neon-high"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(inferModelThinkingLevels("antigravity", "gemini-4-hydrogen-low"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(inferModelThinkingLevels("antigravity", "gemini-4-carbon-high"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("antigravity", "gemini-4-argon-medium"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-3.7-flash"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-3.8-flash"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-2.5-pro"), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-3-flash-preview"), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-3.1-flash-lite"), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-3-pro-preview"), ["low", "high"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-3.1-pro-preview"), ["low", "high"]);
  assert.deepEqual(inferModelThinkingLevels("omp", "google/gemma-4-26b-it"), ["high"]);
  assert.deepEqual(inferModelThinkingLevels("omp", "crosery/k3-256k"), ["low", "high", "max"]);
  assert.deepEqual(inferModelThinkingLevels("kimi", "kimi-k2-thinking"), ["low", "high", "max"]);
  assert.deepEqual(inferModelThinkingLevels("kimi", "kimi-for-coding"), ["low", "high", "max"]);
  assert.deepEqual(inferModelThinkingLevels("claude", "claude-sonnet-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(inferModelThinkingLevels("claude", "claude-opus-4-5"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("claude", "claude-opus-5-5"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("claude", "claude-haiku-4-5"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("claude", "claude-3-7-sonnet-20250219"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "o1"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "o3-mini"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "o4-mini"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "gpt-5"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "gpt-5-mini"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "gpt-5-nano"), ["low", "medium", "high"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "gpt-5.2"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "gpt-5.3-codex"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(inferModelThinkingLevels("codex", "gpt-5.4"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(inferModelThinkingLevels("antigravity", "gpt-oss-120b-medium"), ["medium"]);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-2.0-flash"), []);
  assert.deepEqual(inferModelThinkingLevels("gemini", "gemini-2.0-flash-thinking-exp"), ["low", "medium", "high"]);

  // Unknown model or empty model falls back to harness default; unknown harness + reasoning event -> ["low","medium","high"]
  assert.deepEqual(inferModelThinkingLevels("claude", ""), ["low", "medium", "high", "xhigh", "max", "auto"]);
  assert.deepEqual(inferModelThinkingLevels("claude", "custom-local-model"), ["low", "medium", "high", "xhigh", "max", "auto"]);
  assert.deepEqual(inferModelThinkingLevels("custom-cli", "custom-model"), []);
  assert.deepEqual(inferModelThinkingLevels("custom-cli", "custom-model", { hasReasoningEvents: true }), ["low", "medium", "high"]);
});

test("resolveThinkingLevelsForModel & clampThinkingLevel dynamically track selected model instead of static superset", () => {
  const catalog = {
    harness: "claude-code",
    currentModel: "claude-opus-4-6",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max", "auto"],
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", reasoning: true, thinkingLevels: ["low", "medium", "high", "max"], source: "current" as const },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: true, source: "catalog" as const },
      { id: "gpt-4o", label: "GPT-4o", reasoning: false, source: "catalog" as const },
      {
        id: "gemini-4-neon-high",
        label: "Gemini 4 Neon (High)",
        reasoning: true,
        thinkingLevels: ["low", "medium", "high", "xhigh"],
        effortModelMap: {
          low: "gemini-4-neon-low",
          medium: "gemini-4-neon-medium",
          high: "gemini-4-neon-high",
          xhigh: "gemini-4-neon-xhigh",
        },
        source: "catalog" as const,
      },
    ],
  };

  assert.deepEqual(resolveThinkingLevelsForModel(catalog, "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(resolveThinkingLevelsForModel(catalog, "claude-opus-5-5"), ["low", "medium", "high"]);
  assert.deepEqual(resolveThinkingLevelsForModel(catalog, "gpt-4o"), []);
  assert.deepEqual(resolveThinkingLevelsForModel(catalog, "gemini-4-neon-low"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(resolveThinkingLevelsForModel(catalog, "gemma-4-31b"), ["high"]);

  assert.equal(clampThinkingLevel(["low", "medium", "high"], "max"), "high");
  assert.equal(clampThinkingLevel(["low", "medium", "high", "xhigh"], "high", "gemini-4-neon-xhigh"), "xhigh");
  assert.equal(clampThinkingLevel(["medium"], "high"), "medium");
  assert.equal(clampThinkingLevel([], "high"), undefined);
});

test("synthesizeFallbackAgentModels merges current, peer models, and presets without errors", () => {
  const res = synthesizeFallbackAgentModels(
    {
      harness: "oh-my-pi",
      model: "magpie/crosery/gpt-6.2-astra-fast:xhigh",
      isShell: false,
      source: "hc",
    },
    ["magpie/crosery/gpt-6.2-sol-ultrafast", "google/gemini-1.5-flash"],
  );

  assert.equal(res.canSwitch, true);
  assert.equal(res.canSwitchThinking, true);
  assert.equal(res.currentModel, "magpie/crosery/gpt-6.2-astra-fast");
  assert.equal(res.currentThinking, "xhigh");
  assert.equal(res.thinkingLabel, "思考等级");
  assert.deepEqual(res.thinkingLevels, ["low", "medium", "high", "xhigh"]);
  assert.equal(res.models[0]?.id, "magpie/crosery/gpt-6.2-astra-fast");
  assert.equal(res.models[0]?.source, "current");
  assert.ok(res.models.some((m) => m.id === "magpie/crosery/gpt-6.2-sol-ultrafast" && m.source === "recent"));
  assert.equal(res.models.find((m) => m.id === "google/gemini-1.5-flash")?.reasoning, false);

  const nonReason = synthesizeFallbackAgentModels({
    harness: "omp",
    model: "magpie/crosery/mimo-v2.5-asr",
    isShell: false,
    source: "hc",
  });
  assert.equal(nonReason.canSwitch, true);
  assert.equal(nonReason.canSwitchThinking, false);
  assert.equal(nonReason.thinkingLevels, undefined);

  const shell = synthesizeFallbackAgentModels({
    harness: "zsh",
    model: undefined,
    isShell: true,
    source: "hc",
  });
  assert.equal(shell.canSwitch, false);
  assert.equal(shell.canSwitchThinking, false);
  assert.ok(shell.reason?.includes("普通终端"));
});
