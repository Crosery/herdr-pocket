import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
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
const { XiaoyangOrb, mascotAssetPath, resolveCallMascotMood } = await import("../src/components/MascotAndVendor.tsx");
const { PermissionCards, VoiceHud, VoiceInputSetup } = await import("../src/components/VoiceInput.tsx");
const { CallMiniBar, CallOverlay } = await import("../src/views/AssistantView.tsx");
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
const SHELL_SIDEBAR_TSX = readFileSync(fileURLToPath(new URL("../src/shell/ShellSidebar.tsx", import.meta.url)), "utf8");
const SHELL_CSS = readFileSync(fileURLToPath(new URL("../src/styles/shell.css", import.meta.url)), "utf8");

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
  assert.ok(!permsHtml.includes("引导与修复"));

  const allPermsHtml = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(PermissionCards, {
        perms: {
          platform: "macos",
          microphone: "granted",
          accessibility: "denied",
          inputMonitoring: "denied",
          screenRecording: "denied",
          notes: [],
        },
        checking: false,
        onChanged: () => {},
        singleKey: true,
        scope: "all",
      }),
    ),
  );
  assert.ok(allPermsHtml.includes("屏幕录制"));
  assert.ok(allPermsHtml.includes("麦克风"));
  assert.ok(allPermsHtml.includes("输入监控"));
  assert.ok(allPermsHtml.includes("去授权"));
  assert.ok(!allPermsHtml.includes("引导与修复"));

  const compactSetupHtml = renderToStaticMarkup(
    React.createElement(ToastProvider, null, React.createElement(VoiceInputSetup, { compact: true })),
  );
  assert.ok(!compactSetupHtml.includes("系统权限"));

  assert.ok(!AGENTS_TSX.includes("VoiceMicButton"));
  assert.ok(!ASSISTANT_TSX.includes("VoiceMicButton"));
  assert.ok(SETTINGS_VIEW_TSX.includes("语音唤醒与声纹"));
  assert.ok(SETTINGS_FRAME_TSX.includes("语音唤醒与声纹"));
  assert.ok(APP_TSX.includes("onVoiceCallCommand"));
  assert.ok(APP_TSX.includes("^(挂断了|通话结束了)$"));
  assert.ok(SHELL_WORK_TSX.includes("小羊通话中 · 点此挂断"));
  assert.ok(!SHELL_WORK_TSX.includes("voiceStart"));
  assert.ok(!SHELL_WORK_TSX.includes("getTranscribeInfo"));

  for (const rel of [
    "../src/shell/DesktopShell.tsx",
    "../src/views/OnboardingView.tsx",
    "../src/views/settings/FramePanes.tsx",
    "../src/components/PermissionGuideModal.tsx",
    "../src/components/VoiceprintModal.tsx",
    "../src/components/VoiceInput.tsx",
    "../src/views/SettingsView.tsx",
    "../src/views/settings/SettingsFrame.tsx",
    "../src-tauri/Info.plist",
    "../src-tauri/src/perms.rs",
  ]) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    assert.ok(!src.includes("语音输入"), `${rel} must not contain 语音输入`);
    assert.ok(!src.includes("按住说话"), `${rel} must not contain 按住说话`);
  }
});

test("desktop ships all 6 animated call WebPs with ANIM headers and HUD resolves every state", () => {
  const moods = ["connecting", "idle", "listening", "thinking", "speaking", "muted"] as const;
  for (const mood of moods) {
    const filePath = fileURLToPath(new URL(`../public/assets/call/${mood}.webp`, import.meta.url));
    assert.ok(existsSync(filePath), `missing animated portrait: ${filePath}`);
    const bytes = readFileSync(filePath);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", `${mood}.webp must have RIFF header`);
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", `${mood}.webp must have WEBP signature`);
    assert.ok(bytes.includes(Buffer.from("ANIM")), `${mood}.webp must contain ANIM chunk`);
  }

  assert.ok(HUD_HTML.includes('id="mascotOrb"'));
  assert.ok(HUD_HTML.includes('id="mascotImg"'));
  assert.ok(HUD_HTML.includes('src="assets/call/connecting.webp"'));
  assert.ok(HUD_HTML.includes('id="mascotBadge"'));
  assert.ok(!HUD_HTML.includes('class="dot"'));

  for (const mood of moods) {
    assert.ok(HUD_JS.includes(`assets/call/${mood}.webp`), `voice-hud.js must map/preload ${mood}.webp`);
  }

  // Exercise real voice-hud.js state machine, preloading, steady debounce, and non-restarting src mutations.
  let now = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const srcWrites: string[] = [];
  const preloadedUrls: string[] = [];
  const makeEl = (id: string) => {
    let srcVal = id === "mascotImg" ? "assets/call/connecting.webp" : "";
    const el: Record<string, unknown> = {
      id,
      className: "",
      hidden: id === "mascotBadge",
      innerHTML: "",
      textContent: "",
      title: "",
      style: {},
      children: [],
      attrs: {} as Record<string, string>,
      classList: {
        toggle: () => {},
        add: () => {},
        remove: () => {},
      },
      appendChild(child: unknown) {
        (this.children as unknown[]).push(child);
        return child;
      },
      addEventListener() {},
      setAttribute(k: string, v: string) {
        (this.attrs as Record<string, string>)[k] = v;
      },
    };
    if (id === "mascotImg") {
      Object.defineProperty(el, "src", {
        get: () => srcVal,
        set: (v: string) => {
          srcWrites.push(v);
          srcVal = v;
        },
      });
    }
    return el;
  };
  const els = new Map<string, ReturnType<typeof makeEl>>();
  for (const id of ["hud", "mascotOrb", "mascotImg", "mascotBadge", "title", "dspBadge", "sub", "bars", "time", "actions", "btnMute", "btnHangup"]) {
    els.set(id, makeEl(id));
  }
  const fakeWindow: Record<string, unknown> = {
    location: { search: "" },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimerId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    requestAnimationFrame: () => 1,
  };
  const FakeDate = class extends Date {
    static now() {
      return now;
    }
  };
  function FakeImage(this: { src?: string }) {
    Object.defineProperty(this, "src", {
      set: (v: string) => preloadedUrls.push(v),
    });
  }
  const sandbox = {
    window: fakeWindow,
    document: {
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => makeEl("child"),
      body: { classList: { add: () => {} } },
      documentElement: { setAttribute: () => {} },
    },
    Image: FakeImage,
    Date: FakeDate,
    URLSearchParams,
  };
  vm.runInNewContext(HUD_JS, sandbox);
  const hudApi = fakeWindow.__hud as (s: Record<string, unknown>) => void;
  const mascotImg = els.get("mascotImg")!;
  const mascotBadge = els.get("mascotBadge")!;

  assert.equal(preloadedUrls.length, 6);
  for (const mood of moods) {
    assert.ok(preloadedUrls.includes(`assets/call/${mood}.webp`), `expected preload for ${mood}.webp`);
  }

  hudApi({ state: "connecting", muted: false });
  assert.equal(mascotImg.src, "assets/call/connecting.webp");
  assert.equal(mascotBadge.hidden, false);
  assert.match(String(mascotBadge.className), /is-connecting/);

  hudApi({ state: "active", phase: "idle", muted: false, level: 0.2, startedAt: now });
  assert.equal(mascotImg.src, "assets/call/listening.webp");
  assert.equal(mascotBadge.hidden, true);

  // Rapid meter frames while listening must NOT re-write mascotImg.src.
  const writesBeforeMeters = srcWrites.length;
  hudApi({ state: "active", phase: "idle", muted: false, level: 0.5, startedAt: now });
  hudApi({ state: "active", phase: "idle", muted: false, level: 0.8, startedAt: now });
  assert.equal(srcWrites.length, writesBeforeMeters);

  // Active sub-phase transition obeys 450ms hold / 200ms settle steady debounce.
  now += 100;
  hudApi({ state: "active", phase: "speaking", muted: false, level: 0.6, startedAt: now });
  assert.equal(mascotImg.src, "assets/call/listening.webp");
  now += 200;
  // Meter update during pending debounce must not cancel or reset the pending transition.
  hudApi({ state: "active", phase: "speaking", muted: false, level: 0.7, startedAt: now });
  assert.equal(mascotImg.src, "assets/call/listening.webp");
  now += 200;
  for (const [id, t] of [...timers.entries()]) {
    if (t.at <= now) {
      timers.delete(id);
      t.fn();
    }
  }
  assert.equal(mascotImg.src, "assets/call/speaking.webp");

  now += 500;
  hudApi({ state: "active", phase: "thinking", muted: false, level: 0.1, startedAt: now });
  now += 250;
  for (const [id, t] of [...timers.entries()]) {
    if (t.at <= now) {
      timers.delete(id);
      t.fn();
    }
  }
  assert.equal(mascotImg.src, "assets/call/thinking.webp");

  hudApi({ state: "active", phase: "idle", muted: true, level: 0, startedAt: now });
  assert.equal(mascotImg.src, "assets/call/muted.webp");
  assert.equal(mascotBadge.hidden, false);
  assert.match(String(mascotBadge.className), /is-muted/);

  hudApi({ state: "error", message: "连接失败" });
  assert.equal(mascotImg.src, "assets/call/idle.webp");
  assert.equal(mascotBadge.hidden, false);
  assert.match(String(mascotBadge.className), /is-error/);
});

test("XiaoyangOrb, AssistantView, ShellWork, VoiceHud, and ShellSidebar integrate portrait mascots and cleanup", () => {
  for (const mood of ["connecting", "idle", "listening", "thinking", "speaking", "muted"] as const) {
    assert.equal(mascotAssetPath(mood), `call/${mood}.webp`);
    const orbHtml = renderToStaticMarkup(React.createElement(XiaoyangOrb, { mood, size: 32 }));
    assert.match(orbHtml, /class="xiaoyang-orb portrait"/);
    assert.ok(orbHtml.includes(`src="./assets/call/${mood}.webp"`), `XiaoyangOrb must render ${mood}.webp`);
  }

  assert.equal(resolveCallMascotMood({ status: "idle", assistant: "idle", muted: false }), "idle");
  assert.equal(resolveCallMascotMood({ status: "connecting", assistant: "idle", muted: false }), "connecting");
  assert.equal(resolveCallMascotMood({ status: "ready", assistant: "speaking", muted: true }), "speaking");
  assert.equal(resolveCallMascotMood({ status: "ready", assistant: "thinking", muted: false }), "thinking");
  assert.equal(resolveCallMascotMood({ status: "ready", assistant: "idle", muted: true }), "muted");
  assert.equal(resolveCallMascotMood({ status: "ready", assistant: "idle", muted: false }), "listening");

  const miniConnecting = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(CallMiniBar, {
        callState: { ...voiceCallStore.get(), status: "connecting", muted: false, assistant: "idle" },
        duration: "",
        onExpand: () => {},
        onToggleMute: () => {},
        onHangup: () => {},
      }),
    ),
  );
  assert.ok(miniConnecting.includes('src="./assets/call/connecting.webp"'));
  assert.ok(miniConnecting.includes("width:32px;height:32px"));

  const overlayThinking = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(CallOverlay, {
        onMinimize: () => {},
        callState: { ...voiceCallStore.get(), status: "ready", muted: false, assistant: "thinking" },
        duration: "00:12",
      }),
    ),
  );
  assert.ok(overlayThinking.includes('src="./assets/call/thinking.webp"'));

  const overlayMuted = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(CallOverlay, {
        onMinimize: () => {},
        callState: { ...voiceCallStore.get(), status: "ready", muted: true, assistant: "idle" },
        duration: "00:25",
      }),
    ),
  );
  assert.ok(overlayMuted.includes('src="./assets/call/muted.webp"'));

  // AssistantView uses narrow selectors so micLevel/outLevel updates don't re-render the chat thread.
  assert.ok(!ASSISTANT_TSX.includes("const callState = voiceCallStore.use((s) => s)"));
  assert.ok(ASSISTANT_TSX.includes("voiceCallStore.use((s) => s.status)"));

  // ShellWork bottom-right status trigger uses 18x18 Xiaoyang portrait avatar + narrow selectors.
  assert.ok(SHELL_WORK_TSX.includes('className={`status-xiaoyang-avatar'));
  assert.ok(SHELL_WORK_TSX.includes("resolveCallMascotMood"));
  assert.ok(SHELL_WORK_TSX.includes("mascotAssetPath"));
  assert.ok(SHELL_CSS.includes(".status-xiaoyang-avatar"));

  // Sidebar removes hover Eye preview button and preserves row timestamp on hover.
  assert.ok(!SHELL_SIDEBAR_TSX.includes("v3-peek-btn"));
  assert.ok(!SHELL_SIDEBAR_TSX.includes("setPeek"));
  assert.ok(!SHELL_CSS.includes("v3-peek-btn"));

  // VoiceHud renders XiaoyangOrb on non-Tauri targets and returns null early on Tauri.
  const prevWindow = (globalThis as { window?: unknown }).window;
  try {
    voiceCallStore.set({ status: "ready", hudShown: true, assistant: "thinking", muted: false });
    (globalThis as { window?: unknown }).window = undefined;
    const webHudHtml = renderToStaticMarkup(React.createElement(ToastProvider, null, React.createElement(VoiceHud)));
    assert.ok(webHudHtml.includes('class="xiaoyang-orb portrait"'));
    assert.ok(webHudHtml.includes('src="./assets/call/thinking.webp"'));

    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const tauriHudHtml = renderToStaticMarkup(React.createElement(VoiceHud));
    assert.equal(tauriHudHtml, "");
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});
