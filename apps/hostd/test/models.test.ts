import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";
import { clearModelsCacheForTest, getAgentModels, parseOmpModelsJson } from "../src/models.ts";

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
        ["deepseek-v4.1-flash", "recent"],
        ["google/gemini-4-flash", "catalog"],
      ],
    );
    assert.ok(!JSON.stringify(res).includes("sk-secret-must-not-appear"));

    const shellRes = await getAgentModels({ ...hcAgent, harness: "zsh", isShell: true }, { unifloReady: false, homeDir: dir });
    assert.equal(shellRes.canSwitch, false);
    assert.ok(shellRes.reason?.includes("普通终端"));

    const historyRes = await getAgentModels({ ...hcAgent, source: "uniflo" }, { unifloReady: false, homeDir: dir });
    assert.equal(historyRes.canSwitch, false);
    assert.ok(historyRes.reason?.includes("历史"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
