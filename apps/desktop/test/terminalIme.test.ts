import assert from "node:assert/strict";
import { test } from "node:test";
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

test("attachTerminalImeBridge rescues dropped WKWebView XPC Chinese punctuation without duplicates", async () => {
  const host = new EventTarget();
  const ta = new MockTextarea();
  ta.parentElement = host;
  const sent: string[] = [];
  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, (d) => sent.push(d));

  assert.equal(ta.attrs.get("autocorrect"), "off");
  assert.equal(ta.spellcheck, false);

  // 1) Delayed XPC Chinese punctuation sequence: "。", "。", "，", "？", "……", "“”"
  for (const ch of ["。", "。", "，", "？", "……", "“”"]) {
    ta.value += ch;
    const before = new Event("beforeinput", { bubbles: true });
    Object.assign(before, { inputType: "insertText", data: ch, isComposing: false });
    ta.dispatchEvent(before);

    const input = new Event("input", { bubbles: true });
    Object.assign(input, { inputType: "insertText", data: ch, isComposing: false });
    ta.dispatchEvent(input);
    await sleep(2);
  }
  await sleep(16);
  assert.deepEqual(sent, ["。", "。", "，", "？", "……", "“”"]);
  assert.equal(ta.value, "");

  // 2) Synchronous xterm _inputEvent commit must NOT be duplicated.
  sent.length = 0;
  ta.value = "、";
  ta.addEventListener("input", () => bridge.handleXtermData("、"), { capture: true, once: true });
  const inputSync = new Event("input", { bubbles: true });
  Object.assign(inputSync, { inputType: "insertText", data: "、", isComposing: false });
  ta.dispatchEvent(inputSync);
  await sleep(14);
  assert.deepEqual(sent, ["、"]);
  assert.equal(ta.value, "");

  // 3) Delayed 0ms xterm _handleAnyTextareaChanges commit must NOT be duplicated.
  sent.length = 0;
  ta.value = "！";
  const inputZero = new Event("input", { bubbles: true });
  Object.assign(inputZero, { inputType: "insertText", data: "！", isComposing: false });
  ta.dispatchEvent(inputZero);
  setTimeout(() => bridge.handleXtermData("！"), 0);
  await sleep(14);
  assert.deepEqual(sent, ["！"]);

  bridge.dispose();
});

test("attachTerminalImeBridge preserves active composition preedit and rescues dropped compositionend commit", async () => {
  const ta = new MockTextarea();
  const sent: string[] = [];
  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, (d) => sent.push(d));

  ta.dispatchEvent(new Event("compositionstart"));
  assert.equal(bridge.isComposing(), true);

  ta.value = "nihao";
  const compInput = new Event("input", { bubbles: true });
  Object.assign(compInput, { inputType: "insertCompositionText", data: "nihao", isComposing: true });
  ta.dispatchEvent(compInput);
  await sleep(14);
  assert.deepEqual(sent, []);

  // xterm 0ms _finalizeComposition handles "你好" -> emitted once.
  const end1 = new Event("compositionend");
  Object.assign(end1, { data: "你好" });
  ta.dispatchEvent(end1);
  assert.equal(bridge.isComposing(), false);
  setTimeout(() => bridge.handleXtermData("你好"), 0);
  await sleep(16);
  assert.deepEqual(sent, ["你好"]);
  assert.equal(ta.value, "");

  // Fallback when xterm 0ms timer misses compositionend data.
  sent.length = 0;
  ta.dispatchEvent(new Event("compositionstart"));
  ta.value = "测试。";
  const end2 = new Event("compositionend");
  Object.assign(end2, { data: "测试。" });
  ta.dispatchEvent(end2);
  await sleep(16);
  assert.deepEqual(sent, ["测试。"]);
  assert.equal(ta.value, "");

  bridge.dispose();
});

test("clampCompositionOverlayLayout keeps long preedit inside screen and chunkTerminalInputPayload stays <= 512B", async () => {
  const inside = clampCompositionOverlayLayout({
    cursorLeft: 420,
    cursorTop: 460,
    cellHeight: 18,
    screenWidth: 480,
    screenHeight: 480,
    naturalWidth: 960,
    naturalHeight: 72,
  });
  assert.equal(inside.maxWidth, 472);
  assert.ok(inside.left >= 4);
  assert.ok(inside.left + Math.min(960, inside.maxWidth) <= 476);
  assert.ok(inside.top < 460, "flips composition overlay above cursor near bottom edge");

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

  const activeClasses = new Set(["composition-view", "active"]);
  const compView = {
    textContent: "残留文本",
    classList: {
      remove: (cls: string) => activeClasses.delete(cls),
    },
    style: {},
  };
  const host = new EventTarget() as EventTarget & { querySelector?: (sel: string) => unknown };
  host.querySelector = (sel: string) => (sel === ".composition-view" ? compView : null);
  const ta = new MockTextarea();
  ta.parentElement = host;
  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, () => {});

  ta.dispatchEvent(new Event("paste"));
  await sleep(14);
  assert.equal(activeClasses.has("active"), false);
  assert.equal(compView.textContent, "");

  activeClasses.add("active");
  compView.textContent = "失焦残留";
  ta.dispatchEvent(new Event("blur"));
  await sleep(100);
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
      // Simulate xterm.js Clipboard.ts handlePasteEvent firing synchronously before bridge's onPaste
      bridge.handleXtermData("\x1b[200~line1\rline2\x1b[201~");
      ta.value = "";
    }
  });
  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, (d) => sent.push(d));

  // 1) Paste event WITH clipboardData (even if a WebKit implementation still emits insertFromPaste)
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
  await sleep(20);
  assert.deepEqual(sent, ["\x1b[200~line1\rline2\x1b[201~"]);
  assert.equal(ta.value, "");

  // 2) Short single-word paste followed by insertFromPaste must also fire only once.
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
  await sleep(75);
  assert.deepEqual(sent, ["\x1b[200~hello\x1b[201~"]);

  bridge.dispose();
});

test("clampCompositionOverlay walks past 0x0 .xterm-helpers to .xterm-screen and lifts above bottom bar", async () => {
  const screen = new EventTarget() as EventTarget & {
    parentElement?: EventTarget | null;
    getBoundingClientRect?: () => { width: number; height: number };
  };
  screen.getBoundingClientRect = () => ({ width: 1200, height: 800 });

  const compView = {
    textContent: "测试语音输入很长的一段文字会正确换行而不是被 0px 父元素裁成一条细线",
    offsetWidth: 420,
    offsetHeight: 54,
    classList: { remove: () => {} },
    style: { left: "24px", top: "768px", lineHeight: "20px" } as Record<string, string>,
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
  ta.style = { left: "24px", top: "768px" };

  const bridge = attachTerminalImeBridge(ta as unknown as HTMLTextAreaElement, () => {});
  ta.dispatchEvent(new Event("compositionstart"));
  ta.dispatchEvent(new Event("compositionupdate"));
  await sleep(25);

  assert.equal(compView.style.maxWidth, "1192px");
  assert.equal(compView.style.left, "24px");
  assert.ok(parseInt(compView.style.top, 10) < 768 - 20, `expected lifted top, got ${compView.style.top}`);
  assert.ok(parseInt(compView.style.top, 10) + 54 <= 800 - 28, "must clear bottom status bar");

  bridge.dispose();
});
