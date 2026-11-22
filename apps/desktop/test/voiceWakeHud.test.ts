import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default '';",
      };
    }
    if ((url.endsWith(".tsx") || url.endsWith(".ts")) && !url.includes("/node_modules/") && !url.endsWith("voiceWakeHud.test.ts")) {
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
const { configKeySpec } = await import("@herdr-pocket/protocol");
const { ToastProvider } = await import("../src/components/PocketUI.tsx");
const { PermissionCards, VoiceInputSetup } = await import("../src/components/VoiceInput.tsx");
const { assistantStore } = await import("../src/lib/assistant.ts");
const { DEMO_URL } = await import("../src/lib/mock.ts");
const { settingsStore } = await import("../src/lib/store.ts");
const {
  formatHudCaption,
  hangupVoiceCall,
  setVoiceMuted,
  startVoiceCall,
  voiceCallStore,
} = await import("../src/lib/voiceCall.ts");

const HUD_HTML = readFileSync(fileURLToPath(new URL("../public/voice-hud.html", import.meta.url)), "utf8");
const HUD_JS = readFileSync(fileURLToPath(new URL("../public/voice-hud.js", import.meta.url)), "utf8");
const AGENTS_TSX = readFileSync(fileURLToPath(new URL("../src/views/AgentsView.tsx", import.meta.url)), "utf8");
const ASSISTANT_TSX = readFileSync(fileURLToPath(new URL("../src/views/AssistantView.tsx", import.meta.url)), "utf8");
const SETTINGS_VIEW_TSX = readFileSync(fileURLToPath(new URL("../src/views/SettingsView.tsx", import.meta.url)), "utf8");
const SETTINGS_FRAME_TSX = readFileSync(fileURLToPath(new URL("../src/views/settings/SettingsFrame.tsx", import.meta.url)), "utf8");
const APP_TSX = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
const SHELL_WORK_TSX = readFileSync(fileURLToPath(new URL("../src/shell/ShellWork.tsx", import.meta.url)), "utf8");

beforeEach(() => {
  hangupVoiceCall();
  settingsStore.set({ server: DEMO_URL });
  assistantStore.set({
    ready: true,
    voice: true,
    loaded: true,
  });
  voiceCallStore.set({
    status: "idle",
    muted: false,
    assistant: "idle",
    micLevel: 0,
    outLevel: 0,
    lines: [],
    task: null,
    startedAt: null,
    hudShown: false,
    message: null,
    error: null,
  });
});

test("voice-hud.html and voice-hud.js are pure Xiaoyang Live Call with zero dictation UI", () => {
  for (const forbidden of ["语音输入", "问小羊", "modeSwitch", "assistant_reply", "transcribing", "btnModeDictate", "btnModeAssistant"]) {
    assert.ok(!HUD_HTML.includes(forbidden), `voice-hud.html must not contain ${forbidden}`);
    assert.ok(!HUD_JS.includes(forbidden), `voice-hud.js must not contain ${forbidden}`);
  }
  assert.ok(HUD_HTML.includes('id="btnMute"'));
  assert.ok(HUD_HTML.includes('id="btnHangup"'));
  assert.ok(HUD_JS.includes("pocket-hud://toggle-mute"));
  assert.ok(HUD_JS.includes("pocket-hud://hangup"));
  assert.ok(HUD_JS.includes("正在接通小羊…"));
  assert.ok(HUD_JS.includes("和小羊通话中"));
  assert.ok(HUD_JS.includes("小羊在想…"));
  assert.ok(HUD_JS.includes("小羊正在说…"));
  assert.ok(HUD_JS.includes("麦克风已静音"));
});

test("voiceCall Demo Mode supports showHud, mute toggle, caption formatting, and clean hangup", async () => {
  const err = await startVoiceCall({ showHud: true });
  assert.equal(err, null);

  let state = voiceCallStore.get();
  assert.equal(state.status, "ready");
  assert.equal(state.hudShown, true);
  assert.equal(typeof state.startedAt, "number");
  assert.equal(formatHudCaption(state.lines), "小羊：你好，这是演示模式的语音通话界面。");

  setVoiceMuted(true);
  assert.equal(voiceCallStore.get().muted, true);

  setVoiceMuted(false);
  assert.equal(voiceCallStore.get().muted, false);

  hangupVoiceCall();
  state = voiceCallStore.get();
  assert.equal(state.status, "idle");
  assert.equal(state.hudShown, false);
  assert.equal(state.startedAt, null);
  assert.equal(state.message, "挂断了");
});

test("Settings, PermissionCards, composers, ShellWork, and App remove dictation UI cleanly", () => {
  assert.equal(configKeySpec("voiceInput.enabled")?.label, "快捷键唤醒小羊");
  assert.equal(configKeySpec("voiceInput.hotkey")?.label, "唤醒快捷键");
  assert.equal(configKeySpec("voiceInput.sounds")?.label, "通话提示音");

  const setupHtml = renderToStaticMarkup(
    React.createElement(ToastProvider, null, React.createElement(VoiceInputSetup)),
  );
  for (const removed of ["识别服务", "说话方式", "识别结果", "识别语言", "单次最长", "试一试", "辅助功能"]) {
    assert.ok(!setupHtml.includes(removed), `VoiceInputSetup must not render dictation row: ${removed}`);
  }
  assert.ok(setupHtml.includes("快捷键唤醒小羊"));
  assert.ok(setupHtml.includes("唤醒快捷键"));
  assert.ok(setupHtml.includes("立即唤起小羊"));

  const permsHtml = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(PermissionCards, { perms: null, checking: false, onChanged: () => {}, singleKey: true }),
    ),
  );
  assert.ok(permsHtml.includes("麦克风"));
  assert.ok(!permsHtml.includes("辅助功能"));

  assert.ok(!AGENTS_TSX.includes("VoiceMicButton"));
  assert.ok(!ASSISTANT_TSX.includes("VoiceMicButton"));
  assert.ok(SETTINGS_VIEW_TSX.includes("语音唤醒与声纹"));
  assert.ok(SETTINGS_FRAME_TSX.includes("语音唤醒与声纹"));
  assert.ok(APP_TSX.includes("onVoiceCallCommand"));
  assert.ok(APP_TSX.includes("^(挂断了|通话结束了)$"));
  assert.ok(SHELL_WORK_TSX.includes("小羊通话中 · 点此挂断"));
  assert.ok(!SHELL_WORK_TSX.includes("voiceStart"));
  assert.ok(!SHELL_WORK_TSX.includes("getTranscribeInfo"));
});
