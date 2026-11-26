import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, AgentUsageReport, ConvEvent } from "@herdr-pocket/protocol";
import {
  computeTurnTelemetry,
  fmtLatencyClean,
  fmtPctClean,
  inferFallbackContextLimit,
} from "../src/lib/turnTelemetry.ts";

test("inferFallbackContextLimit and computeTurnTelemetry resolve Gemini/Antigravity worker limits cleanly", () => {
  assert.equal(inferFallbackContextLimit("gemini-flash-worker-agy", "antigravity", 475_000), 1_048_576);
  assert.equal(inferFallbackContextLimit("gemini-4-pro", "antigravity", 1_500_000), 2_097_152);
  assert.equal(inferFallbackContextLimit("claude-opus-4-6", "claude", 120_000), 1_000_000);
  assert.equal(inferFallbackContextLimit("claude-sonnet-4", "claude-code", 80_000), 200_000);
  assert.equal(inferFallbackContextLimit("gpt-5.4", "codex", 100_000), 272_000);
  assert.equal(inferFallbackContextLimit("unknown-custom", "custom", 50_000), 0);

  const report: AgentUsageReport = {
    harness: "antigravity",
    model: "gemini-flash-worker-agy",
    session: {
      turns: 205,
      steps: 9316,
      prompts: 205,
      input: 221_670_000,
      output: 12_650_000,
      cacheRead: 2_413_020_000,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: 0,
      unpricedSteps: 9316,
      contextTokens: 475_000,
    },
    models: [],
    quotas: [],
  };

  const agent: Pick<Agent, "contextTokens" | "contextLimit" | "cacheHitPct" | "model" | "harness"> = {
    harness: "antigravity",
    model: "gemini-flash-worker-agy",
    contextTokens: 475_000,
  };

  const metrics = computeTurnTelemetry(undefined, report, agent);
  assert.equal(metrics.contextTokens, 475_000);
  assert.equal(metrics.contextLimit, 1_048_576);
  assert.equal(metrics.contextLimitInferred, true);
  assert.equal(metrics.usedPct, 45.3);
  assert.equal(metrics.remainPct, 54.7);
  assert.equal(metrics.cacheHitPct, 91.6);
});

test("computeTurnTelemetry falls back to instant agent.cacheHitPct before AgentUsageReport loads", () => {
  const agent: Pick<Agent, "contextTokens" | "contextLimit" | "cacheHitPct" | "model" | "harness"> = {
    harness: "antigravity",
    model: "gemini-flash-worker-agy",
    contextTokens: 120_000,
    contextLimit: 1_048_576,
    cacheHitPct: 88.44,
  };

  const beforeReport = computeTurnTelemetry(undefined, null, agent);
  assert.equal(beforeReport.contextLimitInferred, false);
  assert.equal(beforeReport.usedPct, 11.4);
  assert.equal(beforeReport.cacheHitPct, 88.4);

  const report: AgentUsageReport = {
    harness: "antigravity",
    session: {
      turns: 2,
      steps: 4,
      prompts: 2,
      input: 10_000,
      output: 500,
      cacheRead: 90_000,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: 0.1,
      unpricedSteps: 0,
      contextTokens: 120_000,
      contextLimit: 1_048_576,
      contextPct: 11.44,
    },
    models: [],
    quotas: [],
  };

  const withReport = computeTurnTelemetry(undefined, report, agent);
  assert.equal(withReport.cacheHitPct, 90);
  assert.equal(withReport.contextLimitInferred, false);
});

test("fmtLatencyClean, fmtPctClean, and event TTFT/TPS telemetry calculations", () => {
  assert.equal(fmtLatencyClean(420.4), "420ms");
  assert.equal(fmtLatencyClean(1250), "1.25s");
  assert.equal(fmtLatencyClean(12_540), "12.5s");
  assert.equal(fmtPctClean(0), "0%");
  assert.equal(fmtPctClean(91.64), "91.6%");
  assert.equal(fmtPctClean(120), "100%");

  const t0 = 1_700_000_000_000;
  const events: ConvEvent[] = [
    { id: "u1", session: "s1", harness: "codex", ts: t0, kind: "user_message", text: "hi" },
    { id: "r1", session: "s1", harness: "codex", ts: t0 + 620, kind: "reasoning", text: "think" },
    { id: "us1", session: "s1", harness: "codex", ts: t0 + 2_620, kind: "usage", input: 1000, output: 120 },
    { id: "te1", session: "s1", harness: "codex", ts: t0 + 2_620, kind: "turn_end" },
  ];
  const m = computeTurnTelemetry(events, null, null);
  assert.equal(m.ttftMs, 620);
  assert.equal(m.tps, 60);
});
