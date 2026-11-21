import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Transpile .ts/.tsx components and stub .css imports so assistantCallUi.test.ts exercises the real TSX module in Node.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default '';",
      };
    }
    if ((url.endsWith(".tsx") || url.endsWith(".ts")) && !url.includes("/node_modules/") && !url.endsWith("assistantCallUi.test.ts")) {
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
const { ToastProvider } = await import("../src/components/PocketUI.tsx");
const { assistantStore } = await import("../src/lib/assistant.ts");
const { settingsStore } = await import("../src/lib/store.ts");
const { voiceCallStore } = await import("../src/lib/voiceCall.ts");
const {
  AssistantView,
  CallMiniBar,
  CallOverlay,
  formatCallDuration,
  formatCallMiniSub,
  formatCallOverlayStatus,
  resolveCallStartedAt,
} = await import("../src/views/AssistantView.tsx");

const CSS_PATH = fileURLToPath(new URL("../src/styles/assistant-call.css", import.meta.url));
const TSX_PATH = fileURLToPath(new URL("../src/views/AssistantView.tsx", import.meta.url));

beforeEach(() => {
  settingsStore.set({ server: "https://pocket.example.com" });
  assistantStore.set({
    items: [],
    busy: false,
    busyLabel: null,
    ready: true,
    voice: true,
    model: "assistant-test-model",
    reminders: [{ id: "r1", text: "10 分钟后查看测试", createdAt: 1_700_000_000_000 }],
    loaded: true,
    error: null,
    unread: 0,
  });
  voiceCallStore.set({
    status: "idle",
    muted: false,
    assistant: "idle",
    micLevel: 0,
    outLevel: 0,
    lines: [],
    task: null,
    message: null,
    error: null,
  });
});

test("assistant-call.css defines container query root, non-pill mini bar, adaptive header, and pane-scoped overlay", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const tsx = readFileSync(TSX_PATH, "utf8");

  assert.match(tsx, /import\s+["']\.\.\/styles\/assistant-call\.css["'];/);

  // Container query root and shell.css overflow override
  assert.match(css, /\.assistant-pane-root\s*\{[\s\S]*container-type:\s*inline-size;[\s\S]*container-name:\s*assistant-pane;/);
  assert.match(css, /\.v3-panel-body\.assistant\s*>\s*\.assistant-pane-root\s*\{[\s\S]*overflow:\s*hidden;/);

  // Adaptive header hides redundant title in drawer and <= 400px
  assert.match(css, /\.v3-panel-body\.assistant\s+\.assistant-pane-title\s*\{\s*display:\s*none;/);
  assert.match(css, /@container\s+assistant-pane\s*\(max-width:\s*400px\)[\s\S]*\.assistant-pane-title\s*\{\s*display:\s*none;/);
  assert.match(css, /@container\s+assistant-pane\s*\(max-width:\s*340px\)/);

  // Redesigned .call-mini-bar never uses 999px pill radius
  const miniBarMatch = css.match(/\.assistant-pane-root\s+\.call-mini-bar\s*\{([^}]*)\}/);
  assert.ok(miniBarMatch, "expected .assistant-pane-root .call-mini-bar block");
  assert.match(miniBarMatch[1]!, /border-radius:\s*16px;/);
  assert.match(miniBarMatch[1]!, /flex-direction:\s*column;/);
  assert.doesNotMatch(miniBarMatch[1]!, /999px|--r-pill/);

  // Ultra-narrow mini bar breakpoints
  assert.match(css, /@container\s+assistant-pane\s*\(max-width:\s*320px\)/);
  assert.match(css, /@container\s+assistant-pane\s*\(max-width:\s*265px\)[\s\S]*\.call-mini-hangup-label\s*\{\s*display:\s*none;/);

  // Scoped .call-overlay stays inside the pane
  const overlayMatch = css.match(/\.assistant-pane-root\s+\.call-overlay\s*\{([^}]*)\}/);
  assert.ok(overlayMatch, "expected .assistant-pane-root .call-overlay block");
  assert.match(overlayMatch[1]!, /position:\s*absolute;/);
  assert.match(overlayMatch[1]!, /inset:\s*0;/);
  assert.match(overlayMatch[1]!, /overflow-y:\s*auto;/);
  assert.doesNotMatch(overlayMatch[1]!, /position:\s*fixed;/);

  // Narrow overlay container query scales orb, clamps statusText, wraps meters
  assert.match(
    css,
    /@container\s+assistant-pane\s*\(max-width:\s*420px\)[\s\S]*--call-orb-size:\s*96px;[\s\S]*\.call-overlay-status\s*\{[\s\S]*font-size:\s*calc\(16px \* var\(--ts, 1\)\);[\s\S]*-webkit-line-clamp:\s*3;/,
  );
  assert.match(css, /\.call-overlay-meters\s*\{[\s\S]*flex-wrap:\s*wrap;[\s\S]*max-width:\s*100%;/);

  // Token & no-emoji design compliance
  assert.doesNotMatch(css, /#(?:fff|ffffff|000|000000)\b/i);
  assert.doesNotMatch(css + tsx, /[\u{1F300}-\u{1FAFF}]/u);
});

test("call duration, startedAt fallback, mini subtitle, and overlay status helpers handle all call states", () => {
  assert.equal(formatCallDuration(null, 10_000), "");
  assert.equal(formatCallDuration(undefined, 10_000), "");
  assert.equal(formatCallDuration(10_000, 10_000), "00:00");
  assert.equal(formatCallDuration(10_000, 93_000), "01:23");
  assert.equal(formatCallDuration(50_000, 10_000), "00:00");

  // Explicit startedAt wins over fallback
  assert.equal(
    resolveCallStartedAt(
      { ...voiceCallStore.get(), status: "ready", startedAt: 1_700_000_000_000 },
      1_700_000_050_000,
    ),
    1_700_000_000_000,
  );

  // Reset fallback when idle, stay null on connecting, latch once on ready
  assert.equal(resolveCallStartedAt({ ...voiceCallStore.get(), status: "idle" }, 1_000), null);
  assert.equal(resolveCallStartedAt({ ...voiceCallStore.get(), status: "connecting" }, 2_000), null);
  assert.equal(resolveCallStartedAt({ ...voiceCallStore.get(), status: "ready" }, 3_000), 3_000);
  assert.equal(resolveCallStartedAt({ ...voiceCallStore.get(), status: "ready" }, 9_000), 3_000);
  assert.equal(resolveCallStartedAt({ ...voiceCallStore.get(), status: "idle" }, 10_000), null);

  assert.equal(formatCallMiniSub({ status: "connecting", muted: false }, ""), "正在接通…");
  assert.equal(formatCallMiniSub({ status: "ready", muted: false }, "01:23"), "01:23 · 点此回到通话");
  assert.equal(formatCallMiniSub({ status: "ready", muted: true }, "01:23"), "01:23 · 已静音");

  assert.equal(
    formatCallOverlayStatus({ status: "connecting", task: "ignored", assistant: "idle", muted: false }),
    "正在接通小羊…",
  );
  assert.equal(
    formatCallOverlayStatus({ status: "ready", task: "检查测试输出", assistant: "speaking", muted: false }),
    "正在处理：检查测试输出",
  );
  assert.equal(
    formatCallOverlayStatus({ status: "ready", task: null, assistant: "speaking", muted: false }),
    "小羊正在说…",
  );
  assert.equal(
    formatCallOverlayStatus({ status: "ready", task: null, assistant: "thinking", muted: false }),
    "小羊在想…",
  );
  assert.equal(
    formatCallOverlayStatus({ status: "ready", task: null, assistant: "idle", muted: true }),
    "麦克风已静音",
  );
  assert.equal(
    formatCallOverlayStatus({ status: "ready", task: null, assistant: "idle", muted: false }),
    "我在听，直接说话就行",
  );
});

test("AssistantView renders responsive header and two-row CallMiniBar with optional task row", () => {
  voiceCallStore.set({
    status: "connecting",
    muted: false,
    assistant: "idle",
    task: null,
  });

  const connectingHtml = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(AssistantView, { onOpenAgent: () => {}, initialCallExpanded: false }),
    ),
  );

  assert.match(connectingHtml, /class="assistant-pane-root"/);
  assert.match(connectingHtml, /class="assistant-pane-header"/);
  assert.match(connectingHtml, /class="cute-font assistant-pane-title">小羊<\/h2>/);
  assert.match(connectingHtml, /class="faint assistant-pane-sub"/);
  assert.match(connectingHtml, /class="call-mini-bar"/);
  assert.match(connectingHtml, /class="call-mini-head"/);
  assert.match(connectingHtml, /和小羊通话中/);
  assert.match(connectingHtml, /正在接通…/);
  assert.match(connectingHtml, /aria-label="挂断"/);
  assert.ok(!connectingHtml.includes("call-mini-task"), "empty task must not render .call-mini-task row");

  const longTask = "正在检查所有设备上的构建状态并核对最近一次发布的回归日志，同时整理需要确认的权限项";
  const readyHtml = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(CallMiniBar, {
        callState: {
          ...voiceCallStore.get(),
          status: "ready",
          muted: true,
          assistant: "speaking",
          outLevel: 0.65,
          task: longTask,
        },
        duration: "02:45",
        onExpand: () => {},
        onToggleMute: () => {},
        onHangup: () => {},
      }),
    ),
  );

  assert.match(readyHtml, /call-mini-wave speaking/);
  assert.match(readyHtml, /02:45 · 已静音/);
  assert.match(readyHtml, /class="call-mini-task"/);
  assert.match(readyHtml, /status-dot breathe call-mini-task-dot/);
  assert.match(readyHtml, new RegExp(`class="call-mini-task-text" title="${longTask}"`));
  assert.match(readyHtml, /class="call-mini-hangup-label">挂断<\/span>/);
});

test("AssistantView renders pane-scoped CallOverlay with title tooltip, meters, and captions", () => {
  const longTask = "核对多端桌面和鸿蒙构建结果以及语音通路状态";
  voiceCallStore.set({
    status: "ready",
    muted: false,
    assistant: "speaking",
    micLevel: 0.42,
    outLevel: 0.78,
    task: longTask,
    lines: [
      { id: "u1", role: "user", text: "现在跑完了吗？", final: true, turn: 1 },
      { id: "a1", role: "assistant", text: "正在查看最后一项构建结果。", final: false, turn: 1 },
    ],
  });

  const overlayHtml = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(AssistantView, { onOpenAgent: () => {}, initialCallExpanded: true }),
    ),
  );

  assert.match(overlayHtml, /class="assistant-pane-root"/);
  assert.match(overlayHtml, /class="call-overlay"/);
  assert.match(overlayHtml, /class="call-overlay-orb"/);
  assert.match(overlayHtml, /class="cute-font call-overlay-status" title="正在处理：核对多端桌面和鸿蒙构建结果以及语音通路状态"/);
  assert.match(overlayHtml, /class="call-overlay-meters"/);
  assert.match(overlayHtml, /style="width:42%"/);
  assert.match(overlayHtml, /style="width:78%"/);
  assert.match(overlayHtml, /class="stack call-overlay-captions"/);
  assert.match(overlayHtml, /call-overlay-caption user/);
  assert.match(overlayHtml, /call-overlay-caption assistant interim/);
  assert.match(overlayHtml, /class="pk-btn danger lg call-overlay-hangup"/);

  const customDurationHtml = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(CallOverlay, {
        onMinimize: () => {},
        callState: voiceCallStore.get(),
        duration: "04:19",
      }),
    ),
  );
  assert.match(customDurationHtml, /class="call-overlay-clock num">04:19<\/span>/);
});
