import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builtinSlashCommands,
  canonicalHarnessId,
  extractSlashQuery,
  matchSlashCommands,
  mergeSlashCommands,
  slashCommandIconKind,
} from "../src/lib/slashCommands.ts";

const ALL_UNIFLO_HARNESSES = [
  "claude",
  "qoder",
  "qwen",
  "codex",
  "pi",
  "omp",
  "crosery",
  "commandcode",
  "prime",
  "cline",
  "roo",
  "kodu",
  "gemini",
  "antigravity",
  "opencode",
  "kilo",
  "zcode",
  "mimocode",
  "workbuddy",
  "minimax",
  "hermes",
  "factory",
  "reasonix",
  "cursor",
  "dsh",
  "grok",
  "kiro",
  "kimi",
  "codebuddy",
  "copilot",
  "devin",
  "craft",
  "openclaw",
];

test("slashCommands supports all Uniflo & Herdr harnesses, includes /usage everywhere, and assigns semantic icons", () => {
  assert.equal(canonicalHarnessId("claude-code"), "claude");
  assert.equal(canonicalHarnessId("agy"), "antigravity");
  assert.equal(canonicalHarnessId("deepseek"), "dsh");
  assert.equal(canonicalHarnessId("oh-my-pi"), "omp");
  assert.equal(canonicalHarnessId("cbc"), "codebuddy");
  assert.equal(canonicalHarnessId("droid"), "factory");

  for (const h of ALL_UNIFLO_HARNESSES) {
    const cmds = builtinSlashCommands(h);
    assert.ok(cmds.length >= 6, `${h} should have commands`);
    assert.ok(cmds.some((c) => c.name === "/usage"), `${h} must expose /usage`);
  }

  const omp = builtinSlashCommands("omp");
  assert.ok(omp.some((c) => c.name === "/modelpreset"));
  assert.ok(omp.some((c) => c.name === "/prewalk"));
  assert.ok(omp.some((c) => c.name === "/hub"));

  const dsh = builtinSlashCommands("dsh");
  assert.ok(dsh.some((c) => c.name === "/subagent"));
  assert.ok(dsh.some((c) => c.name === "/balance"));

  const hermes = builtinSlashCommands("hermes");
  assert.ok(hermes.some((c) => c.name === "/insights"));
  assert.ok(hermes.some((c) => c.name === "/kanban"));

  const aider = builtinSlashCommands("aider");
  assert.ok(aider.some((c) => c.name === "/add"));
  assert.ok(aider.some((c) => c.name === "/usage"));

  // Semantic icon mapping: commands must NOT share one generic icon.
  assert.equal(slashCommandIconKind({ name: "/usage", description: "", category: "session" }), "usage");
  assert.equal(slashCommandIconKind({ name: "/clear", description: "", category: "session" }), "clear");
  assert.equal(slashCommandIconKind({ name: "/model", description: "", category: "model" }), "model");
  assert.equal(slashCommandIconKind({ name: "/plan", description: "", category: "code" }), "plan");
  assert.equal(slashCommandIconKind({ name: "/git", description: "", category: "code" }), "git");
  assert.equal(slashCommandIconKind({ name: "/my-skill", description: "", category: "skill" }), "skill");
  assert.equal(slashCommandIconKind({ name: "/deploy", description: "", category: "custom" }), "custom");

  // Plain shell disables auto-catalog so path typing (/Users/...) doesn't clash.
  assert.deepEqual(builtinSlashCommands("zsh", true), []);

  assert.equal(extractSlashQuery("/com"), "com");
  assert.equal(extractSlashQuery("/compact "), null);
  assert.equal(extractSlashQuery("hello /compact"), null);

  const merged = mergeSlashCommands(builtinSlashCommands("claude"), [
    { name: "/deploy", description: "Custom deploy command", category: "custom", source: "project" },
  ]);
  const ranked = matchSlashCommands(merged, "dep");
  assert.equal(ranked[0]?.name, "/deploy");
});
