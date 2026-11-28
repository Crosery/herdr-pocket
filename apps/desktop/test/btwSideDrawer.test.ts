import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Agent, ConvEvent } from "@herdr-pocket/protocol";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", shortCircuit: true, source: "export default '';" };
    }
    if (url.endsWith(".tsx")) {
      const sourceText = readFileSync(fileURLToPath(url), "utf8");
      const out = ts.transpileModule(sourceText, {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      return { format: "module", shortCircuit: true, source: out.outputText };
    }
    return nextLoad(url, context);
  },
});

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { assistantStore, onAssistantFrame } = await import("../src/lib/assistant.ts");
const { RelayError } = await import("../src/lib/relay.ts");
const {
  BtwSideDrawer,
  executeAgentBtw,
  formatBtwTranscriptFromEvents,
  formatDurationMs,
  waitForAssistantBtwReply,
} = await import("../src/components/BtwSideDrawer.tsx");
const desktopSlash = await import("../src/lib/slashCommands.ts");
const mobileSlash = await import("../../mobile/src/lib/slashCommands.ts");

const baseAgent: Agent = {
  key: "dev-local/hc:t1",
  deviceId: "dev-local",
  source: "hc",
  localId: "t1",
  harness: "antigravity",
  title: "Fix auth callback",
  cwd: "/tmp/demo-proj",
  status: "working",
  model: "gemini-4-neon-high",
  sessionKey: "antigravity:0ef132a6-a586-4803-b414-c3fa1a35a6ff",
  isShell: false,
  updatedAt: 1_700_000_000_000,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  assistantStore.set({
    items: [],
    busy: false,
    busyLabel: null,
    ready: true,
    voice: false,
    model: "assistant-test-model",
    reminders: [],
    loaded: true,
    error: null,
    unread: 0,
  });
});

test("executeAgentBtw uses localAgentBtw first on local Tauri host without RPC round-trip", async () => {
  const calls: string[] = [];
  let localPayload: Record<string, unknown> | null = null;

  const res = await executeAgentBtw(baseAgent, "现在进展到哪一步？", {
    deps: {
      isTauri: () => true,
      getLocalHostId: async () => "dev-local",
      getServer: () => "https://pocket.example.com",
      localAgentBtw: async (req) => {
        calls.push("localAgentBtw");
        localPayload = req as unknown as Record<string, unknown>;
        return { answer: "已完成接口设计，正在写单测。", model: "claude-sonnet-4-5", durationMs: 420 };
      },
      rpcCall: (async () => {
        calls.push("rpcCall");
        throw new Error("should not hit RPC");
      }) as never,
    },
  });

  assert.deepEqual(calls, ["localAgentBtw"]);
  assert.equal(localPayload?.["harness"], "antigravity");
  assert.equal(localPayload?.["sessionKey"], baseAgent.sessionKey);
  assert.equal(localPayload?.["localId"], "t1");
  assert.equal(localPayload?.["prebuiltTranscript"], undefined);
  assert.equal(res.answer, "已完成接口设计，正在写单测。");
  assert.equal(res.model, "claude-sonnet-4-5");
  assert.equal(res.durationMs, 420);
});

test("executeAgentBtw falls back from failed localAgentBtw to hostd agent.btw RPC", async () => {
  const calls: string[] = [];

  const res = await executeAgentBtw(baseAgent, "检查构建状态", {
    deps: {
      isTauri: () => true,
      getLocalHostId: async () => "dev-local",
      getServer: () => "https://pocket.example.com",
      localAgentBtw: async () => {
        calls.push("localAgentBtw");
        throw new Error("CLI not found in GUI PATH");
      },
      rpcCall: (async (_to: string, method: string, params: unknown, timeoutMs?: number) => {
        calls.push(`rpc:${method}:${timeoutMs}`);
        assert.deepEqual(params, { agent: baseAgent.key, question: "检查构建状态" });
        return { answer: "hostd 旁路确认构建正常", model: "omp", durationMs: 310 };
      }) as never,
    },
  });

  assert.deepEqual(calls, ["localAgentBtw", "rpc:agent.btw:90000"]);
  assert.equal(res.answer, "hostd 旁路确认构建正常");
  assert.equal(res.model, "omp");
});

test("executeAgentBtw on remote host uses agent.btw RPC and skips localAgentBtw when supported", async () => {
  const calls: string[] = [];
  const remoteAgent: Agent = { ...baseAgent, key: "dev-remote/hc:t2", deviceId: "dev-remote" };

  const res = await executeAgentBtw(remoteAgent, "远程状态？", {
    deps: {
      isTauri: () => true,
      getLocalHostId: async () => "dev-local",
      getServer: () => "https://pocket.example.com",
      localAgentBtw: async () => {
        calls.push("localAgentBtw");
        return { answer: "unexpected", durationMs: 1 };
      },
      rpcCall: (async (_to: string, method: string) => {
        calls.push(`rpc:${method}`);
        return { answer: "远程 hostd 已响应", model: "codex", durationMs: 550 };
      }) as never,
    },
  });

  assert.deepEqual(calls, ["rpc:agent.btw"]);
  assert.equal(res.answer, "远程 hostd 已响应");
});

test("executeAgentBtw on legacy remote host pre-fetches session.events + terminal.read and runs localAgentBtw(prebuiltTranscript)", async () => {
  const calls: string[] = [];
  let capturedPrebuilt = "";
  const remoteAgent: Agent = { ...baseAgent, key: "dev-remote/hc:t2", deviceId: "dev-remote" };
  const sampleEvents: ConvEvent[] = [
    { id: "e1", session: "s", ts: 100, kind: "user_message", text: "请修复登录回调" },
    { id: "e2", session: "s", ts: 200, kind: "assistant_message", text: "已定位 state 校验缺失" },
    { id: "e3", session: "s", ts: 300, kind: "tool_call", call_id: "c1", name: "edit_file", input: { path: "src/auth.ts" } },
  ];

  const res = await executeAgentBtw(remoteAgent, "它修改了哪个文件？", {
    deps: {
      isTauri: () => true,
      getLocalHostId: async () => "dev-local",
      getServer: () => "https://pocket.example.com",
      rpcCall: (async (_to: string, method: string) => {
        calls.push(`rpc:${method}`);
        if (method === "agent.btw") {
          throw new RelayError("unsupported", "unknown method agent.btw");
        }
        if (method === "session.events") {
          return { sessionKey: "s", events: sampleEvents, more: false };
        }
        if (method === "terminal.read") {
          return { text: "Running cargo test...\nok 42 passed" };
        }
        throw new Error(`unexpected rpc ${method}`);
      }) as never,
      localAgentBtw: async (req) => {
        calls.push("localAgentBtw:prebuilt");
        capturedPrebuilt = req.prebuiltTranscript ?? "";
        return { answer: "它修改了 `src/auth.ts`。", model: "claude", durationMs: 890 };
      },
    },
  });

  assert.deepEqual(calls, ["rpc:agent.btw", "rpc:session.events", "rpc:terminal.read", "localAgentBtw:prebuilt"]);
  assert.match(capturedPrebuilt, /USER: 请修复登录回调/);
  assert.match(capturedPrebuilt, /ASSISTANT: 已定位 state 校验缺失/);
  assert.match(capturedPrebuilt, /TOOL: edit_file/);
  assert.match(capturedPrebuilt, /\[Recent Terminal Screen Snapshot\]/);
  assert.match(capturedPrebuilt, /ok 42 passed/);
  assert.equal(res.answer, "它修改了 `src/auth.ts`。");
});

test("executeAgentBtw inlines pre-fetched transcript into Xiaoyang prompt when localAgentBtw unavailable/fails", async () => {
  let capturedPrompt = "";
  const streamed: Array<{ text: string; model?: string }> = [];
  let resolved = false;
  const fullMarkdown = [
    "只读查看了 `src/auth.ts` 的状态校验：",
    "",
    "- `verifyState()` 正在等待 Redis 会话测试完成",
    "- 主线 Agent 仍处于 `working`",
  ].join("\n");

  const btwPromise = executeAgentBtw(
    { ...baseAgent, deviceId: "dev-remote" },
    "现在卡在哪一步？",
    {
      settleMs: 40,
      timeoutMs: 2000,
      onStream: (partial, model) => streamed.push({ text: partial, model }),
      deps: {
        isTauri: () => true,
        getLocalHostId: async () => "dev-local",
        getServer: () => "https://pocket.example.com",
        localAgentBtw: async () => {
          throw new Error("no local CLI");
        },
        rpcCall: (async (_to: string, method: string) => {
          if (method === "agent.btw") throw new RelayError("unsupported", "unknown method");
          if (method === "session.events") {
            return {
              sessionKey: "s",
              events: [{ id: "e1", session: "s", ts: 1, kind: "user_message", text: "运行 Redis 会话测试" }],
              more: false,
            };
          }
          if (method === "terminal.read") return { text: "waiting on verifyState()" };
          throw new Error("unexpected");
        }) as never,
        loadAssistant: async () => {},
        sendToAssistant: async (prompt) => {
          capturedPrompt = prompt;
          const t0 = Date.now();
          onAssistantFrame({
            type: "assistant_item",
            item: { id: "u-btw-1", ts: t0, role: "user", text: prompt, via: "text" },
          });
          onAssistantFrame({ type: "assistant_busy", busy: true, label: "在想" });
          setTimeout(() => {
            onAssistantFrame({
              type: "assistant_item",
              item: { id: "a-btw-1", ts: t0 + 10, role: "assistant", text: "只", via: "text" },
            });
          }, 10);
          setTimeout(() => {
            onAssistantFrame({
              type: "assistant_item",
              item: { id: "a-btw-1", ts: t0 + 30, role: "assistant", text: fullMarkdown, via: "text" },
            });
          }, 30);
          setTimeout(() => {
            onAssistantFrame({ type: "assistant_busy", busy: false });
          }, 45);
        },
      },
    },
  ).then((res) => {
    resolved = true;
    return res;
  });

  await sleep(20);
  assert.equal(resolved, false);
  const res = await btwPromise;
  assert.equal(resolved, true);
  assert.equal(res.answer, fullMarkdown);
  assert.match(capturedPrompt, /<transcript>/);
  assert.match(capturedPrompt, /USER: 运行 Redis 会话测试/);
  assert.match(capturedPrompt, /waiting on verifyState\(\)/);
  assert.deepEqual(streamed.map((s) => s.text), ["只", fullMarkdown]);
});

test("waitForAssistantBtwReply captures late post-busy chunk and rejects cleanly on error", async () => {
  const beforeIds = new Set<string>(["old"]);
  const startedAt = Date.now();
  const chunks: string[] = [];

  const p = waitForAssistantBtwReply(beforeIds, startedAt, {
    settleMs: 60,
    timeoutMs: 1500,
    onStream: (t) => chunks.push(t),
  });

  onAssistantFrame({ type: "assistant_busy", busy: true });
  onAssistantFrame({
    type: "assistant_item",
    item: { id: "a-late", ts: startedAt + 5, role: "assistant", text: "部分" },
  });
  await sleep(10);
  onAssistantFrame({ type: "assistant_busy", busy: false });
  await sleep(20);
  onAssistantFrame({
    type: "assistant_item",
    item: { id: "a-late", ts: startedAt + 30, role: "assistant", text: "部分与完整结论。" },
  });

  assert.equal(await p, "部分与完整结论。");
  assert.deepEqual(chunks, ["部分", "部分与完整结论。"]);

  const errStarted = Date.now();
  const errP = waitForAssistantBtwReply(new Set(), errStarted, { settleMs: 20, timeoutMs: 1000 });
  onAssistantFrame({
    type: "assistant_item",
    item: { id: "a-err", ts: errStarted + 5, role: "assistant", text: "模型异常", error: true },
  });
  await assert.rejects(() => errP, /模型异常/);
});

test("BtwSideDrawer renders duration, streaming, and formatBtwTranscriptFromEvents clips cleanly", () => {
  assert.equal(formatDurationMs(420), "420ms");
  assert.equal(formatDurationMs(5877), "5.9s");

  const huge = formatBtwTranscriptFromEvents(
    [
      { id: "1", session: "s", ts: 1, kind: "user_message", text: "a".repeat(120) },
      { id: "2", session: "s", ts: 2, kind: "assistant_message", text: "latest reply" },
    ],
    "/repo",
    50,
  );
  assert.ok(huge.startsWith("[earlier conversation omitted]"));
  assert.ok(huge.endsWith("ASSISTANT: latest reply"));

  const html = renderToStaticMarkup(
    React.createElement(BtwSideDrawer, {
      agent: baseAgent,
      turns: [
        {
          id: "t1",
          question: "进度如何？",
          status: "done",
          answer: "已通过测试。",
          model: "gemini-4",
          durationMs: 5877,
          createdAt: Date.now(),
        },
      ],
      onDismiss: () => {},
    }),
  );
  assert.match(html, /旁路提问 \/btw/);
  assert.ok(html.includes("5.9s"));
  assert.ok(html.includes("主线运行中"), "should fall back to agent.status === working when mainRunning is omitted");
  assert.ok(!html.includes("继续旁路追问"), "should omit follow-up icon when onAskAgain is not provided");

  // When mainRunning={false} (e.g. stale hc working after turn_end), drawer must NOT show 主线运行中.
  const idleMainHtml = renderToStaticMarkup(
    React.createElement(BtwSideDrawer, {
      agent: baseAgent, // status: "working"
      mainRunning: false,
      onAskAgain: () => {},
      turns: [
        {
          id: "t2",
          question: "主线还在跑吗？",
          status: "done",
          answer: "已空闲。",
          model: "gemini-4",
          durationMs: 910,
          createdAt: Date.now(),
        },
      ],
      onDismiss: () => {},
    }),
  );
  assert.ok(!idleMainHtml.includes("主线运行中"), "mainRunning={false} must override stale agent.status === working");
  assert.ok(idleMainHtml.includes("继续旁路追问"), "onAskAgain should render follow-up icon button");

  // CSS layout alignment guardrails: .btw-drawer stays centered within 48rem composer width and compact body height.
  const btwCss = readFileSync(new URL("../src/styles/btw-slash.css", import.meta.url), "utf8");
  const drawerRule = /\.btw-drawer\s*\{[^}]*\}/.exec(btwCss)?.[0] ?? "";
  assert.match(drawerRule, /max-width:\s*calc\(48rem\s*-\s*40px\)/);
  assert.match(drawerRule, /margin:\s*0\s+auto\s+8px/);
  assert.match(btwCss, /\.t3-composer-shell\s+\.btw-drawer\s*\{[^}]*width:\s*100%/);
  assert.match(btwCss, /\.btw-drawer-body\s*\{[^}]*max-height:\s*min\(260px,\s*36vh\)/);
});

test("desktop and mobile slashCommands expose /btw across all harnesses", () => {
  const harnesses = [
    "claude",
    "codex",
    "gemini",
    "antigravity",
    "omp",
    "pi",
    "dsh",
    "hermes",
    "grok",
    "codebuddy",
    "opencode",
    "aider",
    "goose",
    "amp",
    "copilot",
    "kiro",
    "kimi",
    "cursor",
    "generic",
  ];
  for (const h of harnesses) {
    const dCmd = desktopSlash.builtinSlashCommands(h).find((c) => c.name === "/btw");
    assert.ok(dCmd, `desktop ${h} missing /btw`);
    assert.equal(dCmd.argHint, "<question>");

    const mCmds = mobileSlash.builtinSlashCommands(h).filter((c) => c.name === "/btw");
    assert.equal(mCmds.length, 1, `mobile ${h} should have exactly one /btw`);
    assert.equal(mCmds[0]?.argHint, "<question>");
  }
});

test("executeAgentBtw falls back to idle terminal.send /btw on omp when assistant is unavailable", async () => {
  assistantStore.set({ ready: false, loaded: true });
  const sent: Array<{ method: string; params: unknown }> = [];
  const idleOmp: Agent = {
    ...baseAgent,
    deviceId: "dev-remote",
    harness: "oh-my-pi",
    status: "idle",
  };

  const res = await executeAgentBtw(idleOmp, "查看上下文", {
    deps: {
      isTauri: () => false,
      getServer: () => "https://pocket.example.com",
      rpcCall: (async (_to: string, method: string, params: unknown) => {
        sent.push({ method, params });
        if (method === "agent.btw") throw new RelayError("unsupported", "unsupported");
        if (method === "terminal.send") return { ok: true };
        return null;
      }) as never,
    },
  });

  assert.equal(res.model, "omp /btw");
  assert.ok(sent.some((s) => s.method === "terminal.send"));
});
