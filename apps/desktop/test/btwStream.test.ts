import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Agent, SlashCommandItem } from "@herdr-pocket/protocol";

// Transpile .tsx components and stub .css imports so btwStream.test.ts exercises the real TSX modules in Node.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default '';",
      };
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
      return {
        format: "module",
        shortCircuit: true,
        source: out.outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { assistantStore, onAssistantFrame } = await import("../src/lib/assistant.ts");
const { RelayError } = await import("../src/lib/relay.ts");
const { BtwSideDrawer, executeAgentBtw, formatDurationMs, waitForAssistantBtwReply } = await import(
  "../src/components/BtwSideDrawer.tsx"
);
const { ComposerSlashChip, slashChipCategoryHint } = await import("../src/components/ComposerSlashChip.tsx");

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

test("executeAgentBtw streams multi-chunk assistant reply without truncating at first character '只'", async () => {
  const streamed: Array<{ text: string; model?: string }> = [];
  let resolved = false;
  const fullMarkdown = [
    "只读查看了 `src/auth.ts` 的状态校验：",
    "",
    "- `verifyState()` 正在等待 Redis 会话测试完成",
    "- 主线 Agent 仍处于 `working`，未被注入任何字符",
  ].join("\n");

  const rpcUnsupported = async () => {
    throw new RelayError("unsupported", "unknown method agent.btw");
  };

  const btwPromise = executeAgentBtw(baseAgent, "现在卡在哪一步？", {
    settleMs: 40,
    timeoutMs: 2000,
    onStream: (partial, model) => {
      streamed.push({ text: partial, model });
    },
    deps: {
      rpcCall: rpcUnsupported as never,
      getServer: () => "https://pocket.example.com",
      loadAssistant: async () => {},
      sendToAssistant: async (prompt) => {
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
            item: { id: "a-btw-1", ts: t0 + 20, role: "assistant", text: "只读查看了 `src/auth.ts`...", via: "text" },
          });
        }, 25);
        setTimeout(() => {
          onAssistantFrame({
            type: "assistant_item",
            item: { id: "a-btw-1", ts: t0 + 35, role: "assistant", text: fullMarkdown, via: "text" },
          });
        }, 40);
        setTimeout(() => {
          onAssistantFrame({ type: "assistant_busy", busy: false });
        }, 55);
      },
    },
  }).then((res) => {
    resolved = true;
    return res;
  });

  // After the first single-char chunk ("只") arrives while busy === true, it MUST NOT resolve prematurely.
  await sleep(20);
  assert.equal(resolved, false);
  assert.ok(streamed.some((s) => s.text === "只"));

  // Even after the second chunk while busy === true, it must still be streaming.
  await sleep(15);
  assert.equal(resolved, false);

  const res = await btwPromise;
  assert.equal(resolved, true);
  assert.equal(res.answer, fullMarkdown);
  assert.equal(res.model, "assistant-test-model");
  assert.deepEqual(
    streamed.map((s) => s.text),
    ["只", "只读查看了 `src/auth.ts`...", fullMarkdown],
  );
  assert.equal(streamed[0]?.model, "assistant-test-model");
});

test("waitForAssistantBtwReply captures final assistant_item arriving alongside/just after assistant_busy: false", async () => {
  const beforeIds = new Set<string>(["old-1"]);
  const startedAt = Date.now();
  const chunks: string[] = [];

  const replyPromise = waitForAssistantBtwReply(beforeIds, startedAt, {
    settleMs: 60,
    timeoutMs: 1500,
    onStream: (text) => chunks.push(text),
  });

  onAssistantFrame({ type: "assistant_busy", busy: true, label: "在想" });
  onAssistantFrame({
    type: "assistant_item",
    item: { id: "a-late-1", ts: startedAt + 5, role: "assistant", text: "只读" },
  });
  await sleep(10);
  onAssistantFrame({ type: "assistant_busy", busy: false });

  // Final filtered item arrives 20ms after assistant_busy: false (within 60ms settle window).
  await sleep(20);
  onAssistantFrame({
    type: "assistant_item",
    item: { id: "a-late-1", ts: startedAt + 30, role: "assistant", text: "只读查看完毕：全部测试通过。" },
  });

  const finalAnswer = await replyPromise;
  assert.equal(finalAnswer, "只读查看完毕：全部测试通过。");
  assert.deepEqual(chunks, ["只读", "只读查看完毕：全部测试通过。"]);
});

test("waitForAssistantBtwReply rejects cleanly on reply.error and executeAgentBtw cleans up when sendToAssistant fails", async () => {
  const startedAt = Date.now();
  const streamed: string[] = [];

  const errPromise = waitForAssistantBtwReply(new Set(), startedAt, {
    settleMs: 20,
    timeoutMs: 1000,
    onStream: (text) => streamed.push(text),
  });

  onAssistantFrame({ type: "assistant_busy", busy: true });
  onAssistantFrame({
    type: "assistant_item",
    item: { id: "a-err-1", ts: startedAt + 5, role: "assistant", text: "模型调用超时", error: true },
  });

  await assert.rejects(() => errPromise, /模型调用超时/);
  assert.deepEqual(streamed, []);

  // If sendToAssistant throws, executeAgentBtw rejects immediately without leaving dangling listeners.
  let activeListeners = 0;
  const sub = assistantStore.subscribe;
  await assert.rejects(
    () =>
      executeAgentBtw(baseAgent, "check status", {
        timeoutMs: 500,
        deps: {
          rpcCall: (async () => {
            throw new RelayError("unsupported", "unsupported");
          }) as never,
          getServer: () => "https://pocket.example.com",
          loadAssistant: async () => {},
          subscribeAssistant: (fn) => {
            activeListeners += 1;
            const unsub = sub(fn);
            return () => {
              activeListeners -= 1;
              unsub();
            };
          },
          sendToAssistant: async () => {
            throw new Error("relay offline");
          },
        },
      }),
    /relay offline/,
  );
  assert.equal(activeListeners, 0);
});

test("BtwSideDrawer formats duration cleanly (5.9s) and renders live streaming Markdown", () => {
  assert.equal(formatDurationMs(420), "420ms");
  assert.equal(formatDurationMs(5877), "5.9s");
  assert.equal(formatDurationMs(undefined), null);

  const streamingHtml = renderToStaticMarkup(
    React.createElement(BtwSideDrawer, {
      agent: baseAgent,
      turns: [
        {
          id: "t-stream",
          question: "目前卡在哪？",
          status: "streaming",
          answer: "只读查看了 **src/auth.ts**",
          model: "gpt-6.2",
          createdAt: Date.now(),
        },
      ],
      onDismiss: () => {},
    }),
  );

  assert.match(streamingHtml, /旁路提问 \/btw/);
  assert.match(streamingHtml, /生成中/);
  assert.match(streamingHtml, /问：/);
  assert.match(streamingHtml, /目前卡在哪？/);
  assert.match(streamingHtml, /<strong>src\/auth\.ts<\/strong>/);
  assert.match(streamingHtml, /正在旁路流式输出/);

  const doneHtml = renderToStaticMarkup(
    React.createElement(BtwSideDrawer, {
      agent: baseAgent,
      turns: [
        {
          id: "t-done",
          question: "耗时多久？",
          status: "done",
          answer: "已完成检查。",
          model: "gpt-6.2",
          durationMs: 5877,
          createdAt: Date.now(),
        },
      ],
      onDismiss: () => {},
    }),
  );

  assert.ok(doneHtml.includes("5.9s"));
  assert.ok(!doneHtml.includes("5877ms"));
});

test("ComposerSlashChip renders cohesive flat soft-pink token without nested hint pill", () => {
  const btwCmd: SlashCommandItem = {
    name: "/btw",
    description: "不打断主线快速旁路提问",
    category: "skill",
    source: "builtin",
    argHint: "<question>",
  };
  const modelCmd: SlashCommandItem = {
    name: "/switch",
    description: "切换当前会话模型",
    category: "model",
    source: "builtin",
  };
  const clearCmd: SlashCommandItem = {
    name: "/clear",
    description: "清空会话",
    category: "session",
    source: "builtin",
  };

  assert.equal(slashChipCategoryHint(btwCmd), "旁路");
  assert.equal(slashChipCategoryHint({ ...btwCmd, name: "/skills:ui" }), "技能");
  assert.equal(slashChipCategoryHint(modelCmd), "命令");
  assert.equal(slashChipCategoryHint(clearCmd), "命令");

  const html = renderToStaticMarkup(
    React.createElement(ComposerSlashChip, {
      command: btwCmd,
      onUnwrap: () => {},
    }),
  );

  assert.match(html, /class="composer-slash-chip"/);
  assert.match(html, /data-btw="true"/);
  assert.match(html, /\/btw/);
  assert.match(html, /· 旁路/);
  assert.ok(!html.includes("composer-slash-hint"), "nested bordered sub-pill class must be removed");
});
