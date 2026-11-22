import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";
import {
  clearModelsCacheForTest,
  findCatalogMatch,
  getAgentModels,
  parseAgyModelsText,
  parseOmpModelsJson,
  parseOmpModelsYml,
  readOmpLocalConfig,
  readSessionLiveModelAndThinking,
  setAgentModelAndThinking,
  updateOmpRoleModel,
} from "../src/models.ts";
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
    assert.equal(res.thinkingLevels, undefined);
    assert.equal(res.canSwitchThinking, false);

    const exactRes = await getAgentModels(
      { ...hcAgent, model: "model-98" },
      {
        homeDir: emptyHome,
        unifloReady: false,
        async readCatalog() {
          return parsed;
        },
      },
    );
    assert.equal(exactRes.currentModel, "magpie/model-98");
    assert.deepEqual(exactRes.thinkingLevels, ["minimal", "low", "medium", "high"]);
    assert.equal(exactRes.canSwitchThinking, true);

    const fallbackReasoningRes = await getAgentModels(
      { ...hcAgent, model: "magpie/unknown-reasoning" },
      {
        homeDir: emptyHome,
        unifloReady: false,
        async readCatalog() {
          return [
            { id: "magpie/unknown-reasoning", label: "Unknown Reasoning", provider: "magpie", reasoning: true, source: "catalog" },
          ];
        },
      },
    );
    assert.deepEqual(fallbackReasoningRes.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
    assert.equal(fallbackReasoningRes.canSwitchThinking, true);
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

test("parseOmpModelsYml extracts non-secret model definitions and drops all credentials", () => {
  const yml = [
    "providers:",
    "  magpie:",
    "    api: openai-completions",
    "    auth: sk-secret-auth-token-must-never-leak",
    "    apiKey: secret-api-key-123",
    "    token: bearer-secret-token",
    "    baseUrl: http://127.0.0.1:3425/v1",
    "    headers:",
    "      Authorization: Bearer top-secret-header",
    "      X-Custom-Secret: should-not-appear",
    "    models:",
    "      - contextWindow: 922000",
    "        cost:",
    "          input: 8",
    "          output: 40",
    "        id: crosery/gpt-6.2-astra-fast",
    "        name: GPT 6.2 Astra Fast",
    "        reasoning: true",
    "        thinking:",
    "          efforts:",
    "            - low",
    "            - medium",
    "            - high",
    "            - xhigh",
    "            - max",
    "          mode: effort",
    "      - id: crosery/mimo-v2.5-asr",
    "        name: MiMo ASR",
    "        reasoning: false",
    "        thinking: null",
    "      - id: custom-embed",
    "        kind: embedding",
    "  crosery-ultrafast:",
    "    secret: ultra-secret",
    "    models:",
    "      - id: gpt-6.2-sol",
    "        name: GPT 6.2 Sol Ultrafast",
    "        reasoning: true",
    "        thinking: [low, high, max]",
  ].join("\n");

  const parsed = parseOmpModelsYml(yml);
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes("sk-secret-auth-token"));
  assert.ok(!serialized.includes("secret-api-key-123"));
  assert.ok(!serialized.includes("bearer-secret-token"));
  assert.ok(!serialized.includes("top-secret-header"));
  assert.ok(!serialized.includes("should-not-appear"));
  assert.ok(!serialized.includes("ultra-secret"));
  assert.ok(!serialized.includes("127.0.0.1"));

  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], {
    id: "magpie/crosery/gpt-6.2-astra-fast",
    label: "GPT 6.2 Astra Fast",
    provider: "magpie",
    contextWindow: 922000,
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    source: "catalog",
  });
  assert.deepEqual(parsed[1], {
    id: "magpie/crosery/mimo-v2.5-asr",
    label: "MiMo ASR",
    provider: "magpie",
    reasoning: false,
    source: "catalog",
  });
  assert.deepEqual(parsed[2], {
    id: "crosery-ultrafast/gpt-6.2-sol",
    label: "GPT 6.2 Sol Ultrafast",
    provider: "crosery-ultrafast",
    reasoning: true,
    thinkingLevels: ["low", "high", "max"],
    source: "catalog",
  });
});

test("findCatalogMatch resolves exact, suffix, and -fast / -ultrafast variants cleanly", () => {
  const catalog = parseOmpModelsJson(
    JSON.stringify({
      models: [
        { provider: "crosery-ultrafast", kind: "chat", id: "gpt-6.2-sol", selector: "crosery-ultrafast/gpt-6.2-sol", name: "Sol Ultrafast", reasoning: true, thinking: ["low", "high", "max"] },
        { provider: "magpie", kind: "chat", id: "crosery/gpt-6.2-astra-fast", selector: "magpie/crosery/gpt-6.2-astra-fast", name: "Astra Fast", reasoning: true, thinking: ["low", "medium", "high", "xhigh", "max"] },
        { provider: "magpie", kind: "chat", id: "crosery/gpt-6.2-sol-ultrafast", selector: "magpie/crosery/gpt-6.2-sol-ultrafast", name: "Magpie Sol Ultrafast", reasoning: true, thinking: ["low", "medium", "high", "xhigh", "max"] },
      ],
    }),
  );

  assert.equal(findCatalogMatch("magpie/crosery/gpt-6.2-astra-fast", catalog)?.id, "magpie/crosery/gpt-6.2-astra-fast");
  assert.equal(findCatalogMatch("crosery/gpt-6.2-astra-fast", catalog)?.id, "magpie/crosery/gpt-6.2-astra-fast");
  assert.equal(findCatalogMatch("crosery-fast/gpt-6.2-astra", catalog)?.id, "magpie/crosery/gpt-6.2-astra-fast");
  assert.equal(findCatalogMatch("gpt-6.2-sol-ultrafast", catalog)?.id, "magpie/crosery/gpt-6.2-sol-ultrafast");
  assert.equal(findCatalogMatch("crosery-ultrafast/gpt-6.2-sol", catalog)?.id, "crosery-ultrafast/gpt-6.2-sol");

  // Also cross-matches provider-encoded tier when nested magpie entry isn't present
  const onlyProviderTier = catalog.slice(0, 1);
  assert.equal(findCatalogMatch("gpt-6.2-sol-ultrafast", onlyProviderTier)?.id, "crosery-ultrafast/gpt-6.2-sol");
});

test("readSessionLiveModelAndThinking tail-reads >128KB session logs for omp, claude, codex, and pi", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-session-tail-"));
  try {
    // 1. OMP (>128KB noise + latest model_change & thinking_level_change)
    const ompSessDir = join(dir, ".omp", "agent", "sessions", "-tmp-proj");
    mkdirSync(ompSessDir, { recursive: true });
    const ompUuid = "01a1fe83-1f9a-73e1-92ca-7ff20d80c2be";
    const ompFile = join(ompSessDir, `2026-11-21T14-29-28-602Z_${ompUuid}.jsonl`);
    const padLine = JSON.stringify({ type: "message", text: "x".repeat(4000) });
    const ompLines = [
      JSON.stringify({ type: "model_change", model: "magpie/crosery/claude-opus-5" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "low" }),
      ...Array.from({ length: 40 }, () => padLine),
      JSON.stringify({ type: "model_change", model: "magpie/crosery/gpt-6.2-astra-fast" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "max" }),
    ];
    writeFileSync(ompFile, ompLines.join("\n") + "\n");
    const ompLive = await readSessionLiveModelAndThinking({ sessionKey: `omp:${ompUuid}`, homeDir: dir });
    assert.deepEqual(ompLive, {
      currentModel: "magpie/crosery/gpt-6.2-astra-fast",
      currentThinking: "max",
    });

    // 2. Claude (thinkingMetadata + requestedModel + synthetic ignore)
    const claudeDir = join(dir, ".claude", "projects", "-tmp-proj");
    mkdirSync(claudeDir, { recursive: true });
    const claudeUuid = "de58c9e0-c3fc-402b-9319-d3f927d00aea";
    writeFileSync(
      join(claudeDir, `${claudeUuid}.jsonl`),
      [
        JSON.stringify({ type: "user", thinkingMetadata: { level: "high" } }),
        JSON.stringify({ type: "assistant", requestedModel: "claude-opus-5-5", effort: "xhigh" }),
        JSON.stringify({ type: "assistant", message: { model: "<synthetic>" } }),
      ].join("\n") + "\n",
    );
    const claudeLive = await readSessionLiveModelAndThinking({ sessionKey: `claude:${claudeUuid}`, homeDir: dir });
    assert.deepEqual(claudeLive, {
      currentModel: "claude-opus-5-5",
      currentThinking: "xhigh",
    });

    // 3. Codex (turn_context reasoning_effort & model)
    const codexDir = join(dir, ".codex", "sessions", "2026", "11", "21");
    mkdirSync(codexDir, { recursive: true });
    const codexUuid = "01a1ed06-9c54-7213-9349-ce8140f4cfe3";
    writeFileSync(
      join(codexDir, `rollout-2026-11-21T12-00-00-${codexUuid}.jsonl`),
      JSON.stringify({
        type: "turn_context",
        payload: { model: "gpt-6.2-astra", reasoning_effort: "xhigh" },
      }) + "\n",
    );
    const codexLive = await readSessionLiveModelAndThinking({ sessionKey: `codex:${codexUuid}`, homeDir: dir });
    assert.deepEqual(codexLive, {
      currentModel: "gpt-6.2-astra",
      currentThinking: "xhigh",
    });

    // 4. PI (provider + modelId)
    const piDir = join(dir, ".pi", "agent", "sessions", "-tmp-proj");
    mkdirSync(piDir, { recursive: true });
    const piUuid = "01a05750-c6e4-7f2e-831e-5cf4a840737a";
    const piFile = join(piDir, `2026-11-21T10-00-00Z_${piUuid}.jsonl`);
    writeFileSync(
      piFile,
      [
        JSON.stringify({ type: "model_change", provider: "crosery", modelId: "gpt-5.6-luna" }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: "max" }),
      ].join("\n") + "\n",
    );
    const piLive = await readSessionLiveModelAndThinking({ sessionSourcePath: piFile, homeDir: dir });
    assert.deepEqual(piLive, {
      currentModel: "crosery/gpt-5.6-luna",
      currentThinking: "max",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getAgentModels populates live thinking from session jsonl and disables thinking for reasoning===false models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-models-live-"));
  try {
    mkdirSync(join(dir, ".omp", "agent", "sessions", "-tmp-proj"), { recursive: true });
    writeFileSync(
      join(dir, ".omp", "agent", "models.yml"),
      [
        "providers:",
        "  magpie:",
        "    auth: sk-secret-do-not-expose",
        "    models:",
        "      - id: crosery/gpt-6.2-sol-ultrafast",
        "        name: Sol Ultrafast",
        "        reasoning: true",
        "        thinking:",
        "          efforts: [low, medium, high, max]",
        "      - id: crosery/mimo-v2.5-asr",
        "        name: MiMo ASR",
        "        reasoning: false",
      ].join("\n"),
    );

    const sessUuid = "01a1fe83-1f9a-73e1-92ca-7ff20d80c2be";
    writeFileSync(
      join(dir, ".omp", "agent", "sessions", "-tmp-proj", `2026-11-21T14-29-28Z_${sessUuid}.jsonl`),
      [
        JSON.stringify({ type: "model_change", model: "magpie/crosery/gpt-6.2-sol-ultrafast" }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: "max" }),
      ].join("\n") + "\n",
    );

    const liveRes = await getAgentModels(
      { ...hcAgent, model: "gpt-6.2-sol-ultrafast", sessionKey: `omp:${sessUuid}` },
      { homeDir: dir, unifloReady: false, readCatalog: async () => [] },
    );
    assert.equal(liveRes.currentModel, "magpie/crosery/gpt-6.2-sol-ultrafast");
    assert.equal(liveRes.currentThinking, "max");
    assert.deepEqual(liveRes.thinkingLevels, ["low", "medium", "high", "max"]);
    assert.equal(liveRes.canSwitchThinking, true);
    assert.ok(!JSON.stringify(liveRes).includes("sk-secret-do-not-expose"));

    const nonReasonRes = await getAgentModels(
      { ...hcAgent, model: "magpie/crosery/mimo-v2.5-asr" },
      { homeDir: dir, unifloReady: false, readCatalog: async () => [] },
    );
    assert.equal(nonReasonRes.currentModel, "magpie/crosery/mimo-v2.5-asr");
    assert.equal(nonReasonRes.thinkingLevels, undefined);
    assert.equal(nonReasonRes.canSwitchThinking, false);
    assert.equal(nonReasonRes.currentThinking, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getAgentModels returns immediately from models.yml/config.yml/agent.db without blocking on slow CLI, and exposes mimo-v2.6-pro thinking + modelRoles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-omp-fast-"));
  try {
    const ompAgentDir = join(dir, ".omp", "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    writeFileSync(
      join(ompAgentDir, "models.yml"),
      [
        "providers:",
        "  magpie:",
        "    models:",
        "      - id: crosery/mimo-v2.6-pro",
        "        name: MiMo V2.6 Pro",
      ].join("\n"),
    );
    writeFileSync(
      join(ompAgentDir, "config.yml"),
      [
        "defaultThinkingLevel: xhigh",
        "modelRoles:",
        "  default: magpie/crosery/mimo-v2.6-pro",
        "  smol: magpie/crosery/gpt-6.2-sol-ultrafast",
      ].join("\n"),
    );

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(ompAgentDir, "agent.db"));
    try {
      db.exec("CREATE TABLE model_usage (model_key TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL);");
      db.prepare("INSERT INTO model_usage (model_key, last_used_at) VALUES (?, ?)").run(
        "magpie/crosery/claude-opus-5",
        1_700_000_000,
      );
    } finally {
      db.close();
    }

    let bgStarted = false;
    let releaseBg: (() => void) | undefined;
    const bgPromise = new Promise<void>((resolve) => {
      releaseBg = resolve;
    });

    const t0 = Date.now();
    const res = await getAgentModels(
      { ...hcAgent, model: "magpie/crosery/mimo-v2.6-pro" },
      {
        homeDir: dir,
        unifloReady: false,
        refreshOmpCatalog: async () => {
          bgStarted = true;
          await bgPromise;
          return [
            {
              id: "magpie/crosery/gemini-4-neon",
              label: "Gemini 4 Neon",
              provider: "magpie",
              reasoning: true,
              source: "catalog",
            },
          ];
        },
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 250, `expected instant return (<250ms), got ${elapsed}ms`);
    assert.equal(bgStarted, true);

    assert.equal(res.currentModel, "magpie/crosery/mimo-v2.6-pro");
    assert.equal(res.currentThinking, "xhigh");
    assert.equal(res.canSwitchThinking, true);
    assert.deepEqual(res.thinkingLevels, ["off", "low", "medium", "high", "xhigh"]);
    assert.deepEqual(res.modelRoles, {
      default: "magpie/crosery/mimo-v2.6-pro",
      smol: "magpie/crosery/gpt-6.2-sol-ultrafast",
    });
    assert.ok(res.models.some((m) => m.id === "magpie/crosery/claude-opus-5"));

    // Finish background refresh and verify subsequent call picks up cached CLI models
    releaseBg?.();
    await new Promise((r) => setTimeout(r, 20));
    const res2 = await getAgentModels(
      { ...hcAgent, model: "magpie/crosery/mimo-v2.6-pro" },
      { homeDir: dir, unifloReady: false },
    );
    assert.ok(res2.models.some((m) => m.id === "magpie/crosery/gemini-4-neon"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateOmpRoleModel safely edits config.yml preserving comments/keys, and setAgentModelAndThinking handles roleSlot and @role switch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-omp-roles-"));
  try {
    const ompAgentDir = join(dir, ".omp", "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    const cfgPath = join(ompAgentDir, "config.yml");
    writeFileSync(
      cfgPath,
      [
        "# User OMP settings",
        "symbolPreset: minimal",
        "modelRoles:",
        "  # primary model comment",
        "  default: magpie/crosery/gpt-6.2-astra-fast # keep comment",
        "  smol: magpie/crosery/gpt-6.2-sol-ultrafast",
        "theme:",
        "  light: rose",
        "  dark: noir",
        "",
      ].join("\n"),
    );

    const updated1 = updateOmpRoleModel(dir, "default", "magpie/crosery/mimo-v2.6-pro");
    assert.equal(updated1.default, "magpie/crosery/mimo-v2.6-pro");
    assert.equal(updated1.smol, "magpie/crosery/gpt-6.2-sol-ultrafast");

    const updated2 = updateOmpRoleModel(dir, "plan", "magpie/crosery/claude-opus-5");
    assert.equal(updated2.plan, "magpie/crosery/claude-opus-5");

    const rawAfter = readFileSync(cfgPath, "utf8");
    assert.ok(rawAfter.includes("# User OMP settings"));
    assert.ok(rawAfter.includes("# primary model comment"));
    assert.ok(rawAfter.includes("default: magpie/crosery/mimo-v2.6-pro # keep comment"));
    assert.ok(rawAfter.includes("  plan: magpie/crosery/claude-opus-5"));
    assert.ok(rawAfter.includes("theme:\n  light: rose\n  dark: noir"));

    const sent: string[] = [];
    const transport = {
      homeDir: dir,
      hc: {
        send: async (_addr: string, text: string) => {
          sent.push(text);
        },
        input: async () => {},
        keys: async () => {},
        snapshotText: async () => "",
      },
    };

    const roleRes = await setAgentModelAndThinking(
      { ...hcAgent, harness: "omp" },
      { roleSlot: "slow", modelId: "magpie/crosery/claude-opus-5", thinkingLevel: "xhigh" },
      transport,
    );
    assert.equal(sent.length, 0);
    assert.equal(roleRes.modelRoles?.slow, "magpie/crosery/claude-opus-5:xhigh");
    assert.ok(roleRes.note?.includes("slow"));

    const switchAliasRes = await setAgentModelAndThinking(
      { ...hcAgent, harness: "omp" },
      { modelId: "@slow" },
      transport,
    );
    assert.deepEqual(sent, ["/switch @slow"]);
    assert.equal(switchAliasRes.currentModel, "magpie/crosery/claude-opus-5");
    assert.equal(switchAliasRes.currentThinking, "xhigh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseAgyModelsText groups effort-suffixed siblings with effortModelMap and exact ordered levels", () => {
  const raw = [
    "gemini-4-neon-high\tGemini 4 Neon (High)",
    "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
    "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
    "gemini-4-neon-low\tGemini 4 Neon (Low)",
    "gemini-4-carbon-medium\tGemini 4 Carbon (Medium)",
    "gemini-4-carbon-high\tGemini 4 Carbon (High)",
    "gemini-4-carbon-low\tGemini 4 Carbon (Low)",
    "claude-opus-5-5-low\tClaude Opus 5.5 (Low)",
    "claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)",
    "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    "gemini-pro-orchestrator\tOrchestrator (Carbon)",
    "gemini-flash-worker-agy\tFlash Worker (Agy)",
    "claude-3-5-sonnet\tClaude 3.5 Sonnet",
  ].join("\n");

  const parsed = parseAgyModelsText(raw);
  const byId = new Map(parsed.map((m) => [m.id, m]));

  const neonHigh = byId.get("gemini-4-neon-high");
  assert.deepEqual(neonHigh?.thinkingLevels, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(neonHigh?.effortModelMap, {
    low: "gemini-4-neon-low",
    medium: "gemini-4-neon-medium",
    high: "gemini-4-neon-high",
    xhigh: "gemini-4-neon-xhigh",
  });
  assert.equal(neonHigh?.reasoning, true);

  assert.deepEqual(byId.get("gemini-4-carbon-low")?.thinkingLevels, ["low", "medium", "high"]);
  assert.deepEqual(byId.get("claude-opus-5-5-high")?.thinkingLevels, ["low", "medium", "high"]);
  assert.deepEqual(byId.get("gpt-oss-120b-medium")?.thinkingLevels, ["medium"]);
  assert.deepEqual(byId.get("gpt-oss-120b-medium")?.effortModelMap, { medium: "gpt-oss-120b-medium" });
  assert.equal(byId.get("gemini-pro-orchestrator")?.reasoning, false);
  assert.equal(byId.get("gemini-pro-orchestrator")?.thinkingLevels, undefined);
  assert.equal(byId.get("gemini-flash-worker-agy")?.reasoning, false);
  assert.equal(byId.get("gemini-flash-worker-agy")?.thinkingLevels, undefined);
  assert.equal(byId.get("claude-3-5-sonnet")?.reasoning, false);
  assert.equal(byId.get("claude-3-5-sonnet")?.thinkingLevels, undefined);
});

test("setAgentModelAndThinking switches antigravity sibling model and returns synced currentModel & currentThinking", async () => {
  const sent: string[] = [];
  const agyCatalog = parseAgyModelsText(
    [
      "gemini-4-neon-low\tGemini 4 Neon (Low)",
      "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n"),
  );

  const agyAgent: Agent = { ...hcAgent, harness: "antigravity", model: "gemini-4-neon-high" };
  const res = await setAgentModelAndThinking(
    agyAgent,
    { thinkingLevel: "xhigh" },
    {
      agyCatalog,
      hc: {
        send: async (_addr, text) => { sent.push(text); },
        input: async () => {},
        keys: async () => {},
        snapshotText: async () => "",
      },
    },
  );
  assert.deepEqual(sent, ["/model gemini-4-neon-xhigh", "/effort xhigh"]);
  assert.equal(res.currentModel, "gemini-4-neon-xhigh");
  assert.equal(res.currentThinking, "xhigh");

  // Also works via stem fallback when catalog wasn't pre-populated
  sent.length = 0;
  const fallbackRes = await setAgentModelAndThinking(
    { ...hcAgent, harness: "antigravity", model: "claude-opus-5-5-low" },
    { thinkingLevel: "high" },
    {
      hc: {
        send: async (_addr, text) => { sent.push(text); },
        input: async () => {},
        keys: async () => {},
        snapshotText: async () => "",
      },
    },
  );
  assert.deepEqual(sent, ["/model claude-opus-5-5-high", "/effort high"]);
  assert.equal(fallbackRes.currentModel, "claude-opus-5-5-high");
  assert.equal(fallbackRes.currentThinking, "high");

  // Selecting an effort-suffixed model without thinkingLevel syncs currentThinking
  sent.length = 0;
  const modelOnlyRes = await setAgentModelAndThinking(
    agyAgent,
    { modelId: "gemini-4-neon-low" },
    {
      agyCatalog,
      hc: {
        send: async (_addr, text) => { sent.push(text); },
        input: async () => {},
        keys: async () => {},
        snapshotText: async () => "",
      },
    },
  );
  assert.deepEqual(sent, ["/model gemini-4-neon-low"]);
  assert.equal(modelOnlyRes.currentModel, "gemini-4-neon-low");
  assert.equal(modelOnlyRes.currentThinking, "low");
});

test("OMP models.yml enrichment uses cached omp models --json else inferModelThinkingLevels with prepended off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-omp-enrich-"));
  try {
    const ompAgentDir = join(dir, ".omp", "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    writeFileSync(
      join(ompAgentDir, "models.yml"),
      [
        "providers:",
        "  google:",
        "    models:",
        "      - id: gemini-2.5-flash",
        "        name: Gemini 2.5 Flash",
        "      - id: gemini-1.5-flash",
        "        name: Gemini 1.5 Flash",
        "  magpie:",
        "    models:",
        "      - id: crosery/claude-opus-4-6",
        "        name: Claude Opus 4.6",
        "      - id: crosery/gpt-4o",
        "        name: GPT-4o",
      ].join("\n"),
    );

    const flashRes = await getAgentModels(
      { ...hcAgent, model: "google/gemini-2.5-flash" },
      {
        homeDir: dir,
        unifloReady: false,
        async readCatalog() {
          return [
            {
              id: "google/gemini-2.5-flash",
              label: "Gemini 2.5 Flash",
              provider: "google",
              reasoning: true,
              thinkingLevels: ["minimal", "low", "medium", "high"],
              source: "catalog",
            },
          ];
        },
      },
    );
    assert.deepEqual(flashRes.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);

    const claudeRes = await getAgentModels(
      { ...hcAgent, model: "magpie/crosery/claude-opus-4-6" },
      { homeDir: dir, unifloReady: false, readCatalog: async () => [] },
    );
    assert.deepEqual(claudeRes.thinkingLevels, ["off", "low", "medium", "high", "max"]);

    const nonReasonRes = await getAgentModels(
      { ...hcAgent, model: "magpie/crosery/gpt-4o" },
      { homeDir: dir, unifloReady: false, readCatalog: async () => [] },
    );
    assert.equal(nonReasonRes.canSwitchThinking, false);
    assert.equal(nonReasonRes.thinkingLevels, undefined);

    const nonReasonWithHistoryRes = await getAgentModels(
      { ...hcAgent, model: "demo/gemini-1.5-pro" },
      { homeDir: dir, unifloReady: false, hasReasoningEvents: true, readCatalog: async () => [] },
    );
    assert.equal(nonReasonWithHistoryRes.canSwitchThinking, false);
    assert.equal(nonReasonWithHistoryRes.thinkingLevels, undefined);
    assert.equal(nonReasonWithHistoryRes.models[0]?.reasoning, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSessionLiveModelAndThinking and getAgentModels recover Antigravity PLANNER_RESPONSE transcript and readTerminalTail fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-agy-transcript-"));
  try {
    const agyUuid = "74bb761a-1234-4567-89ab-cdef01234567";
    const transcriptDir = join(dir, ".gemini", "antigravity-cli", "brain", agyUuid, ".system_generated", "logs");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, "transcript.jsonl"),
      [
        JSON.stringify({ type: "USER_INPUT", content: "hi" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", content: "hello" }),
      ].join("\n") + "\n",
    );

    const live = await readSessionLiveModelAndThinking({
      sessionKey: `antigravity:${agyUuid}`,
      harness: "antigravity",
      homeDir: dir,
    });
    assert.deepEqual(live, {
      currentModel: "gemini-4-neon-high",
      currentThinking: "high",
    });

    const agyCatalog = parseAgyModelsText(
      [
        "gemini-4-neon-low\tGemini 4 Neon (Low)",
        "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
        "gemini-4-neon-high\tGemini 4 Neon (High)",
        "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
        "gemini-pro-orchestrator\tOrchestrator (Carbon)",
      ].join("\n"),
    );

    let termCalledForTranscript = false;
    const fromTranscript = await getAgentModels(
      {
        ...hcAgent,
        harness: "antigravity",
        model: undefined,
        sessionKey: `antigravity:${agyUuid}`,
      },
      {
        homeDir: dir,
        unifloReady: false,
        readCatalog: async () => agyCatalog,
        readTerminalTail: async () => {
          termCalledForTranscript = true;
          return "";
        },
      },
    );
    assert.equal(termCalledForTranscript, false);
    assert.equal(fromTranscript.currentModel, "gemini-4-neon-high");
    assert.equal(fromTranscript.currentThinking, "high");
    assert.deepEqual(fromTranscript.thinkingLevels, ["low", "medium", "high", "xhigh"]);

    // When neither agent.model nor liveSession has model/thinking, readTerminalTail rescues it
    const fromTerminal = await getAgentModels(
      {
        ...hcAgent,
        harness: "antigravity",
        model: undefined,
        sessionKey: undefined,
      },
      {
        homeDir: dir,
        unifloReady: false,
        readCatalog: async () => agyCatalog,
        readTerminalTail: async () => "────────────────\n  auto · Gemini 4 Neon · xhigh\n",
      },
    );
    assert.equal(fromTerminal.currentModel, "gemini-4-neon-xhigh");
    assert.equal(fromTerminal.currentThinking, "xhigh");
    assert.deepEqual(fromTerminal.thinkingLevels, ["low", "medium", "high", "xhigh"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
