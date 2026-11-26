import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";
import { computeSessionCacheHitPct } from "../src/uniflo.ts";
import { clearUsageCachesForTest, getAgentUsageReport, parseOmpUsageJson } from "../src/usage.ts";

const baseAgent: Agent = {
  key: "dev-1/hc:t1",
  deviceId: "dev-1",
  source: "hc",
  localId: "t1",
  harness: "oh-my-pi",
  title: "Test Session",
  where: "backend",
  cwd: "/tmp/proj",
  status: "idle",
  model: "gpt-6.2-astra",
  sessionKey: "omp:abc",
  isShell: false,
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  clearUsageCachesForTest();
});

test("getAgentUsageReport returns session breakdown, models, unpriced honesty, 24h/7d windows, and redacted omp quotas", async () => {
  const report = await getAgentUsageReport(baseAgent, {
    unifloReady: true,
    uniflo: {
      async sessionUsage() {
        return {
          turns: 3,
          steps: 10,
          prompts: 3,
          input: 120_000,
          output: 14_500,
          cacheRead: 420_000,
          cacheWrite: 0,
          reasoning: 3_200,
          costUsd: 1.42,
          unpricedSteps: 2,
          contextTokens: 73_266,
          contextLimit: 200_000,
          contextPct: 36.633,
          model: "gpt-6.2-astra",
          models: [
            { model: "gpt-6.2-astra", steps: 8, input: 100_000, output: 12_000, cacheRead: 400_000, cacheWrite: 0, costUsd: 1.42, unpricedSteps: 0 },
            { model: "gemini-4-flash", steps: 2, input: 20_000, output: 2_500, cacheRead: 20_000, cacheWrite: 0, costUsd: 0, unpricedSteps: 2 },
          ],
        };
      },
      async usage(since) {
        return {
          since: 0,
          rows: [
            { key: "oh-my-pi", label: "oh-my-pi", sessions: 2, steps: 25, prompts: 5, input: 300_000, output: 30_000, cacheRead: 800_000, cacheWrite: 0, costUsd: since === "24h" ? 2.5 : 9.8 },
          ],
          total: { key: "total", label: "total", sessions: 5, steps: 50, prompts: 10, input: 600_000, output: 60_000, cacheRead: 1_500_000, cacheWrite: 0, costUsd: since === "24h" ? 5.1 : 21.4 },
        };
      },
    },
    async readOmpQuotas() {
      return parseOmpUsageJson(
        JSON.stringify({
          reports: [
            {
              provider: "anthropic",
              account: "user@example.com",
              windows: [
                { label: "5h Window", usedPercent: 42.3, resetAt: 1_800_000_000 },
              ],
            },
          ],
        }),
      );
    },
  });

  assert.equal(report.session?.turns, 3);
  assert.equal(report.session?.steps, 10);
  assert.equal(report.session?.unpricedSteps, 2);
  assert.equal(report.session?.contextLimit, 200_000);
  assert.equal(report.models.length, 2);
  assert.equal(report.day24h?.harness?.costUsd, 2.5);
  assert.equal(report.day7d?.total.costUsd, 21.4);
  assert.equal(report.quotas[0]?.provider, "anthropic");
  assert.equal(report.quotas[0]?.account, "us***@example.com");
  assert.equal(report.quotas[0]?.usedPct, 42.3);
  assert.equal(report.quotas[0]?.resetAt, 1_800_000_000_000);
});

test("getAgentUsageReport falls back gracefully without Uniflo using agent snapshot fields", async () => {
  const report = await getAgentUsageReport(
    { ...baseAgent, sessionKey: undefined, costUsd: 0.75, contextTokens: 45_000 },
    {
      unifloReady: false,
      async readOmpQuotas() {
        return [];
      },
    },
  );
  assert.equal(report.session?.costUsd, 0.75);
  assert.equal(report.session?.contextTokens, 45_000);
  assert.equal(report.session?.contextLimit, undefined);
  assert.deepEqual(report.models, []);
  assert.equal(report.day24h, null);
});

test("getAgentUsageReport lite mode skips quotas/models and preserves cachedSessionSummary when sessionUsage fails", async () => {
  let quotaCalled = false;
  let usageWindowCalled = false;
  let receivedSkipModels: boolean | undefined;

  const liteOk = await getAgentUsageReport(baseAgent, {
    unifloReady: true,
    lite: true,
    uniflo: {
      async sessionUsage(_key, opts) {
        receivedSkipModels = opts?.skipModels;
        return {
          turns: 5,
          steps: 12,
          prompts: 5,
          input: 10_000,
          output: 2_000,
          cacheRead: 90_000,
          cacheWrite: 0,
          reasoning: 0,
          costUsd: 0.45,
          unpricedSteps: 0,
          contextTokens: 82_000,
          contextLimit: 200_000,
          contextPct: 41,
          model: "gpt-6.2-astra",
          models: [],
        };
      },
      async usage() {
        usageWindowCalled = true;
        return { rows: [], total: { key: "total", label: "total", sessions: 0, steps: 0, prompts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } };
      },
    },
    async readOmpQuotas() {
      quotaCalled = true;
      return [];
    },
  });

  assert.equal(receivedSkipModels, true);
  assert.equal(quotaCalled, false);
  assert.equal(usageWindowCalled, false);
  assert.equal(liteOk.session?.cacheRead, 90_000);

  const fallbackReport = await getAgentUsageReport(baseAgent, {
    unifloReady: true,
    lite: true,
    uniflo: {
      async sessionUsage() {
        throw new Error("timeout");
      },
      cachedSessionSummary() {
        return {
          steps: 18,
          input: 15_000,
          output: 3_000,
          cacheRead: 165_000,
          cacheWrite: 0,
          reasoning: 200,
          costUsd: 0.88,
          unpricedSteps: 0,
          contextTokens: 96_000,
          contextLimit: 200_000,
          model: "gpt-6.2-astra",
        };
      },
      async usage() {
        return { rows: [], total: { key: "total", label: "total", sessions: 0, steps: 0, prompts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } };
      },
    },
  });

  assert.equal(fallbackReport.session?.cacheRead, 165_000);
  assert.equal(fallbackReport.session?.input, 15_000);
  assert.equal(fallbackReport.session?.output, 3_000);
  assert.equal(fallbackReport.session?.contextTokens, 96_000);
  assert.equal(fallbackReport.session?.contextLimit, 200_000);
  assert.equal(fallbackReport.session?.contextPct, 48);
  assert.equal(computeSessionCacheHitPct({ input: 10_000, cache_read: 90_000, cache_write: 0 }), 90);
});

test("getAgentUsageReport forwards session today + recursive subagent cost, steps, and token breakdown", async () => {
  const report = await getAgentUsageReport(baseAgent, {
    unifloReady: true,
    uniflo: {
      async sessionUsage() {
        return {
          turns: 4,
          steps: 18,
          prompts: 4,
          input: 140_000,
          output: 26_000,
          cacheRead: 530_000,
          cacheWrite: 12_000,
          reasoning: 1_200,
          costUsd: 1.42,
          unpricedSteps: 0,
          todayCostUsd: 0.96,
          todayUnpricedSteps: 0,
          todaySteps: 12,
          todayTokens: { input: 98_000, output: 19_000, cacheRead: 380_000, cacheWrite: 9_000 },
          subagentCount: 3,
          subagentSteps: 25,
          subagentCostUsd: 0.38,
          subagentUnpricedSteps: 1,
          subagentTokens: { input: 46_000, output: 11_000, cacheRead: 160_000, cacheWrite: 4_000 },
          todaySubagentCostUsd: 0.31,
          todaySubagentSteps: 19,
          todaySubagentTokens: { input: 39_000, output: 9_500, cacheRead: 138_000, cacheWrite: 3_000 },
          model: "gpt-6.2-astra",
          models: [],
        };
      },
      async usage() {
        return { rows: [], total: { key: "total", label: "total", sessions: 0, steps: 0, prompts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 } };
      },
    },
    async readOmpQuotas() {
      return [];
    },
  });

  assert.equal(report.session?.todayCostUsd, 0.96);
  assert.equal(report.session?.todaySteps, 12);
  assert.equal(report.session?.todayTokens?.input, 98_000);
  assert.equal(report.session?.subagentCount, 3);
  assert.equal(report.session?.subagentCostUsd, 0.38);
  assert.equal(report.session?.subagentUnpricedSteps, 1);
  assert.deepEqual(report.session?.subagentTokens, { input: 46_000, output: 11_000, cacheRead: 160_000, cacheWrite: 4_000 });
  assert.equal(report.session?.todaySubagentCostUsd, 0.31);
  assert.equal(report.session?.todaySubagentSteps, 19);
});
