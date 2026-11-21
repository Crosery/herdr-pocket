import assert from "node:assert/strict";
import { test } from "node:test";
import type { Agent, ConvEvent } from "@herdr-pocket/protocol";
import { askAgentBtw, buildBtwCliArgs, buildBtwContext, preferredBinariesForHarness, type BtwRunnerRequest } from "../src/btw.ts";

const baseAgent: Agent = {
  key: "dev-1/hc:t1",
  deviceId: "dev-1",
  source: "hc",
  localId: "t1",
  harness: "oh-my-pi",
  title: "Fix auth callback",
  cwd: "/tmp/demo-proj",
  status: "working",
  model: "claude-sonnet-4-5",
  sessionKey: "omp:sess-1",
  isShell: false,
  updatedAt: 1_700_000_000_000,
};

test("askAgentBtw fetches up to 16 Uniflo events (~10k chars), uses ephemeral read-only omp flags, and never mutates session", async () => {
  let fetchedLimit: number | undefined;
  let fetchedKey: string | undefined;
  const calls: BtwRunnerRequest[] = [];

  const events: ConvEvent[] = [
    { id: "e1", session: "omp:sess-1", ts: 1, kind: "user_message", text: "Check oauth callback" },
    { id: "e2", session: "omp:sess-1", ts: 2, kind: "tool_call", call_id: "c1", name: "read_file", input: { path: "src/auth.ts" } },
    { id: "e3", session: "omp:sess-1", ts: 3, kind: "tool_result", call_id: "c1", name: "read_file", output: "export function verifyState() {}", is_error: false },
    { id: "e4", session: "omp:sess-1", ts: 4, kind: "assistant_message", text: "Running full suite now.", model: "claude-sonnet-4-5" },
  ];

  const res = await askAgentBtw(baseAgent, "现在 auth 回调卡在哪里？", {
    uniflo: {
      async events(key, limit) {
        fetchedKey = key;
        fetchedLimit = limit;
        return { events, more: false, nextBefore: null };
      },
    },
    async findBins() {
      return new Map([
        ["omp", "/usr/local/bin/omp"],
        ["claude", "/usr/local/bin/claude"],
      ]);
    },
    async runner(req) {
      calls.push(req);
      return { stdout: "\x1b[32m正在跑测试，src/auth.ts 的 verifyState 已读取。\x1b[0m" };
    },
  });

  assert.equal(fetchedKey, "omp:sess-1");
  assert.equal(fetchedLimit, 16);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.binary, "omp");
  assert.ok(calls[0]!.args.includes("-p"));
  assert.ok(calls[0]!.args.includes("--no-session"));
  assert.ok(calls[0]!.args.includes("--no-tools"));
  assert.ok(calls[0]!.args.includes("--no-judge"));
  assert.ok(calls[0]!.args.includes("--no-spotlight"));
  assert.ok(calls[0]!.args.includes("--hide-thinking"));
  assert.ok(calls[0]!.args.includes("--cwd"));
  assert.ok(calls[0]!.args.includes("/tmp/demo-proj"));
  assert.deepEqual(buildBtwCliArgs("omp", "hello", "/tmp/demo-proj"), [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-judge",
    "--no-spotlight",
    "--hide-thinking",
    "--cwd",
    "/tmp/demo-proj",
    "hello",
  ]);
  assert.deepEqual(buildBtwCliArgs("omp", "hello"), [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-judge",
    "--no-spotlight",
    "--hide-thinking",
    "hello",
  ]);
  const promptArg = calls[0]!.args[calls[0]!.args.length - 1]!;
  assert.match(promptArg, /Check oauth callback/);
  assert.match(promptArg, /现在 auth 回调卡在哪里？/);
  assert.equal(res.answer, "正在跑测试，src/auth.ts 的 verifyState 已读取。");
  assert.equal(res.model, "claude-sonnet-4-5");
  assert.ok(res.durationMs >= 1);
});

test("askAgentBtw prefers matching harness CLI and falls back across installed binaries on failure", async () => {
  const claudeAgent: Agent = { ...baseAgent, harness: "claude-code", sessionKey: undefined, model: "claude-opus-4-6" };
  const tried: string[] = [];

  const res = await askAgentBtw(claudeAgent, "Explain current status", {
    async findBins() {
      return new Map([
        ["claude", "/opt/bin/claude"],
        ["codex", "/opt/bin/codex"],
        ["gemini", "/opt/bin/gemini"],
      ]);
    },
    async runner(req) {
      tried.push(req.binary);
      if (req.binary === "claude") {
        assert.ok(req.args.includes("-p"));
        assert.ok(req.args.includes("--no-session-persistence"));
        assert.ok(req.args.includes("--tools"));
        throw new Error("claude rate limited");
      }
      if (req.binary === "codex") {
        assert.equal(req.args[0], "exec");
        assert.ok(req.args.includes("--ephemeral"));
        assert.ok(req.args.includes("read-only"));
        return { stdout: "Fallback codex answer", model: "gpt-5.4" };
      }
      return { stdout: "gemini answer" };
    },
  });

  assert.deepEqual(tried, ["claude", "codex"]);
  assert.equal(res.answer, "Fallback codex answer");
  assert.equal(res.model, "gpt-5.4");
});

test("buildBtwContext keeps newest events within 10k char budget and handles empty/missing binaries cleanly", async () => {
  const bigEvents: ConvEvent[] = [
    { id: "old", session: "s", ts: 1, kind: "user_message", text: "OLD_MARKER " + "x".repeat(2000) },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `mid-${i}`,
      session: "s",
      ts: i + 2,
      kind: "assistant_message" as const,
      text: `MID_${i} ` + "y".repeat(2500),
    })),
    { id: "new", session: "s", ts: 10, kind: "user_message", text: "NEW_MARKER_LATEST" },
  ];
  const ctx = buildBtwContext(bigEvents, 10_000);
  assert.ok(ctx.length <= 10_000);
  assert.ok(ctx.includes("NEW_MARKER_LATEST"));
  assert.ok(!ctx.includes("OLD_MARKER"));

  assert.deepEqual(preferredBinariesForHarness("agy"), ["gemini", "omp", "claude", "codex"]);
  assert.deepEqual(preferredBinariesForHarness("codex"), ["codex", "omp", "claude", "gemini"]);

  await assert.rejects(() => askAgentBtw(baseAgent, "   "), /旁路提问/);
  await assert.rejects(
    () => askAgentBtw(baseAgent, "hi", { findBins: async () => new Map() }),
    /omp \/ claude \/ codex \/ gemini/,
  );
});
