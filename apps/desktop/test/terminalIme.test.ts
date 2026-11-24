import assert from "node:assert/strict";
import { test } from "node:test";
import { attachTerminalImeBridge, isImeKeyEvent } from "../src/lib/terminalIme.ts";
import { matchesCombo } from "../src/shell/shortcuts.ts";

class MockTextarea extends EventTarget {
  value = "";
  spellcheck = true;
  parentElement: EventTarget | null = null;
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
