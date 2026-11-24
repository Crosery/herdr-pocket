import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chordIncludesPrefix,
  remainingSuffixChip,
  shortcutsMatchingChordPrefix,
} from "../src/shell/shortcuts.ts";

test("progressive modifier prefix matching includes supersets while holding ⌘ and narrows on ⌘⇧ / ⌘⌥", () => {
  assert.equal(chordIncludesPrefix("Mod", "Mod"), true);
  assert.equal(chordIncludesPrefix("Mod+Shift", "Mod"), true);
  assert.equal(chordIncludesPrefix("Mod+Alt", "Mod"), true);
  assert.equal(chordIncludesPrefix("Mod+Alt+Shift", "Mod"), true);

  assert.equal(chordIncludesPrefix("Mod", "Mod+Shift"), false);
  assert.equal(chordIncludesPrefix("Mod+Shift", "Mod+Shift"), true);
  assert.equal(chordIncludesPrefix("Mod+Alt", "Mod+Shift"), false);
  assert.equal(chordIncludesPrefix("Mod+Alt+Shift", "Mod+Shift"), true);

  assert.equal(chordIncludesPrefix("Mod+Alt+Shift", "Mod+Alt+Shift"), true);
  assert.equal(chordIncludesPrefix("Mod+Shift", "Mod+Alt+Shift"), false);

  assert.equal(remainingSuffixChip(["Mod", "D"], "Mod", true), "D");
  assert.equal(remainingSuffixChip(["Mod", "Shift", "D"], "Mod", true), "⇧D");
  assert.equal(remainingSuffixChip(["Mod", "Shift", "D"], "Mod+Shift", true), "D");
  assert.equal(remainingSuffixChip(["Mod", "Alt", "Shift", "ArrowLeft"], "Mod", true), "⌥⇧←");
  assert.equal(remainingSuffixChip(["Mod", "Alt", "Shift", "ArrowLeft"], "Mod+Shift", true), "⌥←");
  assert.equal(remainingSuffixChip(["Mod", "Alt", "Shift", "ArrowLeft"], "Mod+Alt+Shift", true), "←");

  const modIds = new Set(shortcutsMatchingChordPrefix("Mod").map((x) => x.shortcut.id));
  assert.equal(modIds.has("newAgent"), true);
  assert.equal(modIds.has("splitDown"), true);
  assert.equal(modIds.has("focusPaneLeft"), true);
  assert.equal(modIds.has("unsplitTab"), true);

  const modShiftIds = new Set(shortcutsMatchingChordPrefix("Mod+Shift").map((x) => x.shortcut.id));
  assert.equal(modShiftIds.has("newAgent"), false);
  assert.equal(modShiftIds.has("focusPaneLeft"), false);
  assert.equal(modShiftIds.has("splitDown"), true);
  assert.equal(modShiftIds.has("unsplitTab"), true);

  const modAltShiftIds = new Set(shortcutsMatchingChordPrefix("Mod+Alt+Shift").map((x) => x.shortcut.id));
  assert.equal(modAltShiftIds.has("splitDown"), false);
  assert.equal(modAltShiftIds.has("swapPaneLeft"), true);
  assert.equal(modAltShiftIds.has("unsplitTab"), true);
});
