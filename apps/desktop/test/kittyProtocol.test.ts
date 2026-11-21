import { strict as assert } from "node:assert";
import { test } from "node:test";
import { KittyKeyboardState, encodeKittyKey } from "../src/lib/kittyProtocol";
import type { TermKeyInput } from "../src/lib/termKeys";

function key(
  keyName: string,
  mods: Partial<Pick<TermKeyInput, "shiftKey" | "ctrlKey" | "altKey" | "metaKey">> = {},
): TermKeyInput {
  return {
    key: keyName,
    shiftKey: Boolean(mods.shiftKey),
    ctrlKey: Boolean(mods.ctrlKey),
    altKey: Boolean(mods.altKey),
    metaKey: Boolean(mods.metaKey),
  };
}

test("legacy mode encodes modified Enter sequences per shell vs agent TUI without altering plain Enter or macOS Cmd+Enter", () => {
  // Coding agent TUIs (isShell = false) receive CSI u even before/without >1u so re-attached TUIs accept Shift+Enter newlines.
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, true), "\x1b[13;2u");
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, false), "\x1b[13;2u");
  assert.equal(encodeKittyKey(key("Enter", { ctrlKey: true }), 0, 0, true), "\x1b[13;5u");
  assert.equal(encodeKittyKey(key("Enter", { ctrlKey: true, shiftKey: true }), 0, 0, true), "\x1b[13;6u");
  assert.equal(encodeKittyKey(key("Enter", { altKey: true }), 0, 0, true), "\x1b\r");

  // Shells (isShell = true) receive ESC CR so readline/zsh inserts a literal newline instead of "~".
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, true, false, true), "\x1b\r");
  assert.equal(encodeKittyKey(key("Enter", { ctrlKey: true }), 0, 0, false, false, true), "\x1b\r");
  assert.equal(encodeKittyKey(key("Enter", { altKey: true }), 0, 0, true, false, true), "\x1b\r");

  assert.equal(encodeKittyKey(key("Enter"), 0, 0, true), null);
  assert.equal(encodeKittyKey(key("Enter", { metaKey: true }), 0, 0, true), null);
});

test("Kitty keyboard protocol flags (>1u and >9u) encode Shift+Enter and plain Enter accurately", () => {
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 1, 0, true), "\x1b[13;2u");
  assert.equal(encodeKittyKey(key("Enter"), 1, 0, true), null);

  assert.equal(encodeKittyKey(key("Enter"), 9, 0, true), "\x1b[13;1u");
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 9, 0, true), "\x1b[13;2u");
});

test("modifyOtherKeys emits CSI 27;mod;code~ sequences when Kitty flags are off", () => {
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 2, true), "\x1b[27;2;13~");
  assert.equal(encodeKittyKey(key("Tab", { shiftKey: true }), 0, 2, true), "\x1b[27;2;9~");
  assert.equal(encodeKittyKey(key("Enter"), 0, 2, true), null);
});

test("win32-input-mode (?9001h) encodes modified Enter when Kitty flags are zero", () => {
  assert.equal(
    encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, false, true),
    "\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_",
  );
  assert.equal(
    encodeKittyKey(key("Enter", { ctrlKey: true }), 0, 0, false, true),
    "\x1b[13;28;10;1;8;1_\x1b[13;28;10;0;8;1_",
  );
  assert.equal(encodeKittyKey(key("Enter"), 0, 0, false, true), null);
});

test("KittyKeyboardState.reset restores win32InputMode and modifyOtherKeys", () => {
  const state = new KittyKeyboardState();
  state.push(false, 9);
  state.modifyOtherKeys = 2;
  state.win32InputMode = true;
  state.reset();
  assert.equal(state.current(false), 0);
  assert.equal(state.modifyOtherKeys, 0);
  assert.equal(state.win32InputMode, false);
});
