import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";
import { clearModelsCacheForTest, getAgentModels, parseOmpModelsJson, readOmpLocalConfig, setAgentModelAndThinking } from "../src/models.ts";
import { buildHarnessSwitchCommands } from "@herdr-pocket/protocol";

const hcAgent: Agent = {
  key: "dev-1/hc:t1",
  deviceId: "dev-1",
  source: "hc",
  localId: "t1",
  harness: "oh-my-pi",
  title: "Test",
  where: "backend",
  cwd: "/tmp/proj",
  status: "idle",
  model: "crosery/gpt-6.2-astra",
  isShell: false,
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  clearModelsCacheForTest();
});

test("parseOmpModelsJson extracts chat models and ignores non-chat kinds", () => {
  const parsed = parseOmpModelsJson(
    JSON.stringify({
      models: [
        { provider: "google", kind: "chat", id: "gemini-4-flash", selector: "google/gemini-4-flash", name: "Gemini 4 Flash", contextWindow: 1_048_576, reasoning: true },
        { provider: "openai", kind: "embedding", id: "text-embedding-3", name: "Embed" },
      ],
    }),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.id, "google/gemini-4-flash");
  assert.equal(parsed[0]?.contextWindow, 1_048_576);
  assert.equal(parsed[0]?.reasoning, true);
});

test("getAgentModels orders current -> recent -> catalog deduplicated and honors canSwitch rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-models-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude/settings.json"),
      JSON.stringify({ model: "claude-opus-5-5", env: { ANTHROPIC_API_KEY: "sk-secret-must-not-appear" } }),
    );

    const res = await getAgentModels(hcAgent, {
      unifloReady: true,
      homeDir: dir,
      uniflo: {
        async recentModels(h) {
          return h ? ["crosery/gpt-6.2-astra", "claude-opus-5-5"] : ["deepseek-v4.1-flash"];
        },
      },
      async readCatalog() {
        return [
          { id: "google/gemini-4-flash", label: "Gemini 4 Flash", provider: "google", contextWindow: 1_048_576, reasoning: true, source: "catalog" },
          { id: "crosery/gpt-6.2-astra", label: "Duplicate current", source: "catalog" },
        ];
      },
    });

    assert.equal(res.canSwitch, true);
    assert.equal(res.currentModel, "crosery/gpt-6.2-astra");
    assert.deepEqual(
      res.models.map((m) => [m.id, m.source]),
      [
        ["crosery/gpt-6.2-astra", "current"],
        ["claude-opus-5-5", "recent"],
        ["google/gemini-4-flash", "catalog"],
        ["deepseek-v4.1-flash", "recent"],
      ],
    );
    assert.ok(!JSON.stringify(res).includes("sk-secret-must-not-appear"));

    const shellRes = await getAgentModels({ ...hcAgent, harness: "zsh", isShell: true }, { unifloReady: false, homeDir: dir });
    assert.equal(shellRes.canSwitch, false);
    assert.ok(shellRes.reason?.includes("普通终端"));

    const historyRes = await getAgentModels({ ...hcAgent, source: "uniflo" }, { unifloReady: false, homeDir: dir, readCatalog: async () => [] });
    assert.equal(historyRes.canSwitch, false);
    assert.ok(historyRes.reason?.includes("历史"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseOmpModelsJson extracts per-model thinking levels and retains >80 models", async () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    provider: i < 50 ? "google" : "magpie",
    kind: "chat",
    id: `model-${i}`,
    selector: `${i < 50 ? "google" : "magpie"}/model-${i}`,
    name: `Model ${i}`,
    reasoning: i % 2 === 0,
    thinking: i % 2 === 0 ? ["minimal", "low", "medium", "high"] : null,
  }));
  const parsed = parseOmpModelsJson(JSON.stringify({ models: many }));
  assert.equal(parsed.length, 120);
  assert.deepEqual(parsed[0]?.thinkingLevels, ["minimal", "low", "medium", "high"]);

  const emptyHome = mkdtempSync(join(tmpdir(), "pocket-models-empty-"));
  try {
    const res = await getAgentModels(
      { ...hcAgent, model: "model-99" },
      {
        homeDir: emptyHome,
        unifloReady: true,
        uniflo: {
          async recentModels() {
            return ["model-100"];
          },
        },
        async readCatalog() {
          return parsed;
        },
      },
    );
    assert.equal(res.models.length, 120);
    assert.equal(res.currentModel, "magpie/model-99");
    assert.ok(res.models.some((m) => m.id === "magpie/model-119"));
    assert.deepEqual(res.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("readOmpLocalConfig parses config.yml modelRoles and defaultThinkingLevel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-omp-"));
  try {
    mkdirSync(join(dir, ".omp", "agent"), { recursive: true });
    writeFileSync(
      join(dir, ".omp", "agent", "config.yml"),
      [
        "defaultThinkingLevel: high",
        "modelRoles:",
        "  default: magpie/crosery/gpt-6.2-astra-fast",
        "  slow: magpie/crosery/deepseek-v4.1-flash:xhigh",
      ].join("\n"),
    );
    const cfg = await readOmpLocalConfig(dir);
    assert.equal(cfg.defaultModel, "magpie/crosery/gpt-6.2-astra-fast");
    assert.equal(cfg.defaultThinking, "high");
    assert.ok(cfg.models.some((m) => m.id === "magpie/crosery/deepseek-v4.1-flash"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildHarnessSwitchCommands & setAgentModelAndThinking dispatch right syntax for every harness", async () => {
  assert.deepEqual(buildHarnessSwitchCommands("omp", { modelId: "magpie/crosery/gpt-6.2-astra-fast" }).commands, [
    "/switch magpie/crosery/gpt-6.2-astra-fast",
  ]);
  assert.deepEqual(buildHarnessSwitchCommands("omp", { modelId: "magpie/crosery/gpt-6.2-astra-fast:low", thinkingLevel: "high" }).commands, [
    "/switch magpie/crosery/gpt-6.2-astra-fast:high",
  ]);
  assert.deepEqual(buildHarnessSwitchCommands("omp", { thinkingLevel: "xhigh" }).commands, ["/effort xhigh"]);
  assert.deepEqual(buildHarnessSwitchCommands("pi", { modelId: "crosery/claude-opus-5-5", thinkingLevel: "high" }).commands, [
    "/model crosery/claude-opus-5-5",
    "/thinking high",
  ]);
  assert.deepEqual(buildHarnessSwitchCommands("claude-code", { modelId: "opus", thinkingLevel: "max" }).commands, [
    "/model opus",
    "/effort max",
  ]);
  assert.deepEqual(buildHarnessSwitchCommands("gemini", { modelId: "gemini-4-neon-low", thinkingLevel: "high" }).commands, [
    "/model set gemini-4-neon-high",
  ]);
  assert.deepEqual(buildHarnessSwitchCommands("hermes", { modelId: "m1", thinkingLevel: "ultra" }).commands, [
    "/model m1",
    "/reasoning ultra",
  ]);
  assert.deepEqual(buildHarnessSwitchCommands("aider", { modelId: "m1", thinkingLevel: "high" }).commands, [
    "/model m1",
    "/reasoning-effort high",
  ]);

  const sent: string[] = [];
  const res = await setAgentModelAndThinking(
    { ...hcAgent, harness: "omp" },
    { modelId: "magpie/crosery/gpt-6.2-sol-ultrafast", thinkingLevel: "medium" },
    {
      hc: {
        send: async (_addr, text) => { sent.push(text); },
        input: async () => {},
        keys: async () => {},
        snapshotText: async () => "",
      },
    },
  );
  assert.deepEqual(sent, ["/switch magpie/crosery/gpt-6.2-sol-ultrafast:medium"]);
  assert.equal(res.currentModel, "magpie/crosery/gpt-6.2-sol-ultrafast");
  assert.equal(res.currentThinking, "medium");
});
