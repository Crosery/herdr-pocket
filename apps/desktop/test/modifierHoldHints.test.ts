import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chordFromModifierEvent,
  chordOfKeys,
  nextModifierSteps,
  shortcutsForChord,
  trailingKeyChip,
} from "../src/shell/shortcuts.ts";

test("chordOfKeys and chordFromModifierEvent classify Mod -> Mod+Shift / Mod+Alt -> Mod+Alt+Shift accurately", () => {
  assert.equal(chordOfKeys(["Mod", "D"]), "Mod");
  assert.equal(chordOfKeys(["Mod", "Shift", "D"]), "Mod+Shift");
  assert.equal(chordOfKeys(["Mod", "Alt", "ArrowLeft"]), "Mod+Alt");
  assert.equal(chordOfKeys(["Mod", "Alt", "Shift", "ArrowLeft"]), "Mod+Alt+Shift");
  assert.equal(chordOfKeys(["Ctrl", "C"]), null);

  assert.equal(
    chordFromModifierEvent({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true),
    "Mod",
  );
  assert.equal(
    chordFromModifierEvent({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, true),
    "Mod+Shift",
  );
  assert.equal(
    chordFromModifierEvent({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }, true),
    "Mod+Alt",
  );
  assert.equal(
    chordFromModifierEvent({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: true }, true),
    "Mod+Alt+Shift",
  );
  // Cross-holding Ctrl alongside Meta on macOS drops chord cleanly; releasing Shift steps back to Mod.
  assert.equal(
    chordFromModifierEvent({ metaKey: true, ctrlKey: true, altKey: false, shiftKey: false }, true),
    null,
  );
  assert.equal(
    chordFromModifierEvent({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }, false),
    "Mod+Shift",
  );
  assert.equal(trailingKeyChip(["Mod", "Alt", "ArrowRight"], true), "→");
});

test("shortcutsForChord separates each layer exclusively and nextModifierSteps exposes valid progressions", () => {
  const modIds = new Set(shortcutsForChord("Mod").map((s) => s.shortcut.id));
  const shiftIds = new Set(shortcutsForChord("Mod+Shift").map((s) => s.shortcut.id));
  const altIds = new Set(shortcutsForChord("Mod+Alt").map((s) => s.shortcut.id));
  const altShiftIds = new Set(shortcutsForChord("Mod+Alt+Shift").map((s) => s.shortcut.id));

  assert.ok(modIds.has("closeTab"));
  assert.ok(!modIds.has("closeWholeTab"));
  assert.ok(shiftIds.has("closeWholeTab"));
  assert.ok(shiftIds.has("splitDown"));
  assert.ok(shiftIds.has("zoomPane"));
  assert.ok(!shiftIds.has("splitRight"));
  assert.ok(altIds.has("focusPaneLeft"));
  assert.ok(altIds.has("equalizeSplits"));
  assert.ok(altShiftIds.has("swapPaneLeft"));
  assert.ok(altShiftIds.has("unsplitTab"));

  const fromMod = nextModifierSteps("Mod", true);
  assert.deepEqual(
    fromMod.map((s) => s.targetChord),
    ["Mod+Shift", "Mod+Alt"],
  );
  const fromShift = nextModifierSteps("Mod+Shift", true);
  assert.deepEqual(
    fromShift.map((s) => s.targetChord),
    ["Mod+Alt+Shift"],
  );
  const fromAlt = nextModifierSteps("Mod+Alt", true);
  assert.deepEqual(
    fromAlt.map((s) => s.targetChord),
    ["Mod+Alt+Shift"],
  );
  assert.deepEqual(nextModifierSteps("Mod+Alt+Shift", true), []);
});
