import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  attachTerminalImeBridge,
  chunkTerminalInputPayload,
  clampCompositionOverlayLayout,
  isImeKeyEvent,
} from "../src/lib/terminalIme.ts";
import { matchesCombo } from "../src/shell/shortcuts.ts";

class MockTextarea extends EventTarget {
  value = "";
  spellcheck = true;
  parentElement: EventTarget | null = null;
  style: Record<string, string> = {};
  attrs = new Map<string, string>();
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("isImeKeyEvent and matchesCombo protect active IME composition and keyCode 229", () => {
  assert.equal(isImeKeyEvent({ isComposing: false, keyCode: 229, key: "Process" }), true);
  assert.equal(isImeKeyEvent({ isComposing: true, keyCode: 190, key: "." }), true);
  assert.equal(isImeKeyEvent({ isComposing: false, keyCode: 0, key: "Dead" }), true);
  assert.equal(isImeKeyEvent({ isComposing: false, keyCode: 190, key: "." }), false);

  const imePeriod = {
    isComposing: true,
    keyCode: 229,
    key: "Process",
    code: "Period",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  } as unknown as KeyboardEvent;
  assert.equal(matchesCombo(imePeriod, ["Mod", "."]), false);
});

test("attachTerminalImeBridge rescues dropped WKWebView XPC commits without wiping active textarea value", async () => {
  const host = new EventTarget();
  const ta = new MockTextarea();
  ta.parentElement = host;
  const sent: string[] = [];
  const telemetry: string[] = [];
  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, (d) => sent.push(d), {
    onTelemetry: (ev) => telemetry.push(ev),
  });

  assert.equal(ta.attrs.get("autocorrect"), "off");
  assert.equal(ta.spellcheck, false);

  // 1) Delayed XPC Chinese punctuation sequence preserves monotonic textarea buffer for xterm CompositionHelper.
  for (const ch of ["。", "。", "，", "？", "……", "“”"]) {
    ta.value += ch;
    const before = new Event("beforeinput", { bubbles: true });
    Object.assign(before, { inputType: "insertText", data: ch, isComposing: false });
    ta.dispatchEvent(before);

    const input = new Event("input", { bubbles: true });
    Object.assign(input, { inputType: "insertText", data: ch, isComposing: false });
    ta.dispatchEvent(input);
    await sleep(3);
  }
  await sleep(24);
  assert.deepEqual(sent, ["。", "。", "，", "？", "……", "“”"]);
  assert.equal(ta.value, "。。，？……“”", "must preserve textarea.value during active typing");
  assert.equal(telemetry.includes("rescue_xpc"), true);

  // 2) Synchronous xterm _inputEvent commit must NOT be duplicated.
  sent.length = 0;
  ta.value += "、";
  ta.addEventListener("input", () => bridge.handleXtermData("、"), { capture: true, once: true });
  const inputSync = new Event("input", { bubbles: true });
  Object.assign(inputSync, { inputType: "insertText", data: "、", isComposing: false });
  ta.dispatchEvent(inputSync);
  await sleep(22);
  assert.deepEqual(sent, ["、"]);

  // 3) Delayed 0ms xterm _handleAnyTextareaChanges commit must NOT be duplicated.
  sent.length = 0;
  ta.value += "！";
  const inputZero = new Event("input", { bubbles: true });
  Object.assign(inputZero, { inputType: "insertText", data: "！", isComposing: false });
  ta.dispatchEvent(inputZero);
  setTimeout(() => bridge.handleXtermData("！"), 0);
  await sleep(22);
  assert.deepEqual(sent, ["！"]);

  bridge.dispose();
});

test("attachTerminalImeBridge preserves composition across transient blur and rapid back-to-back IME sequences", async () => {
  const ta = new MockTextarea();
  const sent: string[] = [];
  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, (d) => sent.push(d));

  // Simulate xterm CompositionHelper tracking monotonic offsets across rapid back-to-back compositions.
  ta.value = "prev";
  let compStartIdx = ta.value.length;
  ta.dispatchEvent(new Event("compositionstart"));
  assert.equal(bridge.isComposing(), true);

  // Transient blur from OS IME / HUD must NOT prematurely cancel active composition or lose text.
  ta.value = "prevnihao";
  ta.dispatchEvent(new Event("blur"));
  await sleep(25);
  assert.equal(bridge.isComposing(), true);

  const compInput = new Event("input", { bubbles: true });
  Object.assign(compInput, { inputType: "insertCompositionText", data: "nihao", isComposing: true });
  ta.dispatchEvent(compInput);
  await sleep(18);
  assert.deepEqual(sent, []);

  // xterm 0ms _finalizeComposition slices from monotonic compStartIdx when compositionend fires.
  ta.value = "prev你好";
  const firstStart = compStartIdx;
  const firstEnd = ta.value.length;
  const end1 = new Event("compositionend");
  Object.assign(end1, { data: "你好" });
  ta.dispatchEvent(end1);
  assert.equal(bridge.isComposing(), false);
  setTimeout(() => bridge.handleXtermData(ta.value.substring(firstStart, firstEnd)), 0);

  // Start second composition immediately on the next tick (compStartIdx = 6, must still be valid!).
  compStartIdx = ta.value.length;
  ta.dispatchEvent(new Event("compositionstart"));
  ta.value = "prev你好世界";
  const end2 = new Event("compositionend");
  Object.assign(end2, { data: "世界" });
  ta.dispatchEvent(end2);
  await sleep(26);
  assert.deepEqual(sent, ["你好", "世界"]);
  assert.equal(ta.value, "prev你好世界");

  bridge.dispose();
});

test("clampCompositionOverlayLayout aligns inline without bottom jump and leaves textarea.style untouched", async () => {
  const normalLine = clampCompositionOverlayLayout({
    cursorLeft: 84,
    cursorTop: 420,
    cellHeight: 20,
    screenWidth: 800,
    screenHeight: 460,
    naturalWidth: 120,
    naturalHeight: 20,
  });
  assert.equal(normalLine.top, 420, "normal line must never jump upward");
  assert.equal(normalLine.left, 84);

  const edgeOverflow = clampCompositionOverlayLayout({
    cursorLeft: 420,
    cursorTop: 460,
    cellHeight: 18,
    screenWidth: 480,
    screenHeight: 480,
    naturalWidth: 960,
    naturalHeight: 72,
  });
  assert.equal(edgeOverflow.maxWidth, 476);
  assert.ok(edgeOverflow.left >= 0);
  assert.ok(edgeOverflow.left + Math.min(960, edgeOverflow.maxWidth) <= 478);
  assert.ok(edgeOverflow.top < 460, "lifts only when overflowing bottom edge");

  const encoder = new TextEncoder();
  const longVoiceText = "语音输入测试长文本，不会因为超过一百多个汉字就把终端横着撑爆掉。".repeat(45);
  assert.ok(encoder.encode(longVoiceText).length > 2000);
  const chunks = chunkTerminalInputPayload(longVoiceText, true);
  assert.ok(chunks.length >= 4);
  for (const chunk of chunks) {
    assert.ok(encoder.encode(chunk).length <= 512, `chunk exceeded 512B: ${encoder.encode(chunk).length}`);
    assert.equal(chunk.includes("\uFFFD"), false, "never splits multi-byte UTF-8 characters");
  }
  assert.equal(chunks.join(""), `\x1b[200~${longVoiceText}\x1b[201~`);

  const screen = new EventTarget() as EventTarget & {
    parentElement?: EventTarget | null;
    getBoundingClientRect?: () => { width: number; height: number };
  };
  screen.getBoundingClientRect = () => ({ width: 1200, height: 800 });

  const activeClasses = new Set(["composition-view", "active"]);
  const compView = {
    textContent: "测试语音输入很长的一段文字",
    offsetWidth: 420,
    offsetHeight: 20,
    classList: {
      remove: (cls: string) => activeClasses.delete(cls),
    },
    style: { left: "24px", top: "400px", lineHeight: "20px" } as Record<string, string>,
  };
  const helpers = new EventTarget() as EventTarget & {
    parentElement?: EventTarget | null;
    querySelector?: (sel: string) => unknown;
    getBoundingClientRect?: () => { width: number; height: number };
  };
  helpers.parentElement = screen;
  helpers.getBoundingClientRect = () => ({ width: 0, height: 0 });
  helpers.querySelector = (sel: string) => (sel === ".composition-view" ? compView : null);

  const ta = new MockTextarea() as MockTextarea & { closest?: (sel: string) => unknown };
  ta.parentElement = helpers;
  ta.closest = (sel: string) => (sel === ".xterm-screen" ? screen : null);
  const initialTaStyle = { left: "24px", top: "400px", width: "12px", height: "20px" };
  ta.style = { ...initialTaStyle };

  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, () => {});
  ta.dispatchEvent(new Event("compositionstart"));
  ta.dispatchEvent(new Event("compositionupdate"));
  await sleep(16);

  assert.equal(compView.style.maxWidth, "1196px");
  assert.equal(compView.style.left, "24px");
  assert.equal(compView.style.top, "400px");
  assert.deepEqual(ta.style, initialTaStyle, "must never mutate xterm helper textarea styles");

  ta.dispatchEvent(new Event("paste"));
  await sleep(14);
  assert.equal(activeClasses.has("active"), false);
  assert.equal(compView.textContent, "");

  bridge.dispose();
});

test("attachTerminalImeBridge prevents WebKit double-paste across bracketed and plain pastes", async () => {
  const host = new EventTarget();
  const ta = new MockTextarea();
  ta.parentElement = host;
  const sent: string[] = [];
  let xtermRunning = true;
  ta.addEventListener("paste", () => {
    if (xtermRunning) {
      bridge.handleXtermData("\x1b[200~line1\rline2\x1b[201~");
    }
  });
  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, (d) => sent.push(d));

  const pasteEv = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(pasteEv, { clipboardData: { getData: () => "line1\nline2" } });
  ta.dispatchEvent(pasteEv);
  assert.equal(pasteEv.defaultPrevented, true, "onPaste should call preventDefault when clipboardData exists");

  ta.value = "line1\nline2";
  const before = new Event("beforeinput", { bubbles: true });
  Object.assign(before, { inputType: "insertFromPaste", data: "line1\nline2", isComposing: false });
  ta.dispatchEvent(before);

  const inp = new Event("input", { bubbles: true });
  Object.assign(inp, { inputType: "insertFromPaste", data: "line1\nline2", isComposing: false });
  ta.dispatchEvent(inp);
  await sleep(25);
  assert.deepEqual(sent, ["\x1b[200~line1\rline2\x1b[201~"]);

  sent.length = 0;
  xtermRunning = false;
  ta.addEventListener(
    "paste",
    () => {
      bridge.handleXtermData("\x1b[200~hello\x1b[201~");
    },
    { once: true },
  );
  const shortPaste = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(shortPaste, { clipboardData: { getData: () => "hello" } });
  ta.dispatchEvent(shortPaste);
  const shortInp = new Event("input", { bubbles: true });
  Object.assign(shortInp, { inputType: "insertFromPaste", data: "hello", isComposing: false });
  ta.dispatchEvent(shortInp);
  await sleep(95);
  assert.deepEqual(sent, ["\x1b[200~hello\x1b[201~"]);

  bridge.dispose();
});

test("terminal.css renders .composition-view inline without card chrome or helper-textarea pointer traps", () => {
  const css = readFileSync(resolve(ROOT, "src/styles/terminal.css"), "utf8");
  const compMatch = /\.tp-term-host\s+\.xterm\s+\.composition-view\s*\{[^}]*\}/.exec(css);
  assert.ok(compMatch, "found .composition-view rule");
  assert.equal(compMatch[0].includes("border: none"), true);
  assert.equal(compMatch[0].includes("box-shadow: none"), true);
  assert.equal(compMatch[0].includes("padding: 0"), true);
  assert.equal(css.includes(".xterm-helper-textarea"), false);
});
