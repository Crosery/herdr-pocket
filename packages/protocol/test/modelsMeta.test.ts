import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HARNESS_DEFAULT_THINKING_LEVELS,
  inferAgentModelAndThinking,
  normalizeSwitchHarness,
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

test("inferAgentModelAndThinking detects colon effort, hyphen effort, non-reasoning models, and harness defaults", () => {
  assert.deepEqual(inferAgentModelAndThinking("claude-code", "claude-opus-4-6:high"), {
    currentModel: "claude-opus-4-6",
    currentThinking: "high",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max", "auto"],
  });

  assert.deepEqual(inferAgentModelAndThinking("antigravity", "gemini-4-neon-xhigh"), {
    currentModel: "gemini-4-neon-xhigh",
    currentThinking: "xhigh",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
  });

  assert.deepEqual(inferAgentModelAndThinking("gemini", "gemini-3.8-flash-high"), {
    currentModel: "gemini-3.8-flash-high",
    currentThinking: "high",
    thinkingLevels: ["low", "medium", "high"],
  });

  assert.deepEqual(inferAgentModelAndThinking("omp"), {
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  });

  assert.deepEqual(inferAgentModelAndThinking("omp", "magpie/crosery/gpt-6.2-astra-fast"), {
    currentModel: "magpie/crosery/gpt-6.2-astra-fast",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  });

  // Explicit non-reasoning models must return empty thinkingLevels
  for (const nonReasoning of [
    "google/gemini-1.5-flash",
    "magpie/crosery/mimo-v2.5-asr",
    "magpie/crosery/codex-auto-review",
    "magpie/crosery/gpt-reserve",
    "magpie/crosery/kimi-for-coding-highspeed",
  ]) {
    assert.deepEqual(inferAgentModelAndThinking("omp", nonReasoning), {
      currentModel: nonReasoning,
      thinkingLevels: [],
    });
  }

  // Preserves tags like :8b while stripping :high
  assert.equal(stripModelEffortSuffix("qwen3:8b"), "qwen3:8b");
  assert.equal(stripModelEffortSuffix("magpie/crosery/gpt-6.2-sol-ultrafast:max"), "magpie/crosery/gpt-6.2-sol-ultrafast");
  assert.equal(normalizeSwitchHarness("oh-my-pi"), "omp");
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
  assert.deepEqual(res.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
