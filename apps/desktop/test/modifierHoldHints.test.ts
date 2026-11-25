import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  chordIncludesPrefix,
  IS_MAC,
  remainingSuffixChip,
  shortcutsMatchingChordPrefix,
} from "../src/shell/shortcuts.ts";
import { chordFromOsModifiers, HOLD_DELAY_MS, SpatialHint } from "../src/shell/useModifierHoldHints.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

test("SpatialHint renders contextual shortcut badges and shell.css enables progressive spatial hints + bottom chord HUD", () => {
  const newTabHint = SpatialHint({ shortcut: "newAgent", corner: "tr" });
  assert.ok(newTabHint, "SpatialHint returns kbd element for shortcut");
  assert.equal(newTabHint.type, "kbd");
  assert.equal(newTabHint.props["data-chord"], "Mod");
  assert.equal(newTabHint.props["data-chip-mod"], "T");
  assert.equal(newTabHint.props.className, "v3-spatial-hint pos-tr");

  const splitDownHint = SpatialHint({ shortcut: "splitDown", corner: "bottom", className: "hide-on-bare-mod" });
  assert.ok(splitDownHint, "SpatialHint returns kbd element for subchord shortcut");
  assert.equal(splitDownHint.props["data-chord"], "Mod+Shift");
  assert.equal(splitDownHint.props["data-chip-mod"], IS_MAC ? "⇧D" : "Shift+D");
  assert.equal(splitDownHint.props["data-chip-mod-shift"], "D");
  assert.equal(splitDownHint.props.className, "v3-spatial-hint pos-bottom hide-on-bare-mod");

  assert.equal(SpatialHint({ text: "" }), null);

  const css = readFileSync(resolve(ROOT, "src/styles/shell.css"), "utf8");
  assert.equal(css.includes("display: none !important;\n  opacity: 0 !important;"), false);
  assert.equal(css.includes(':root[data-shortcut-hints="Mod"] .v3-spatial-hint[data-chord^="Mod"]'), true);

  const statusMatch = /\.v3-status\s*\{[^}]*\}/.exec(css);
  assert.ok(statusMatch, "found .v3-status block");
  assert.equal(statusMatch[0].includes("overflow: visible"), true);

  const hudMatch = /\.v3-chord-hud\s*\{[^}]*\}/.exec(css);
  assert.ok(hudMatch, "found .v3-chord-hud block");
  assert.equal(hudMatch[0].includes("bottom: 0"), true);
  assert.equal(hudMatch[0].includes("height: 28px"), true);
  assert.equal(hudMatch[0].includes("flex-wrap: nowrap"), true);

  const itemsMatch = /\.v3-chord-items\s*\{[^}]*\}/.exec(css);
  assert.ok(itemsMatch, "found .v3-chord-items block");
  assert.equal(itemsMatch[0].includes("flex-wrap: nowrap"), true);

  const brandNameMatch = /\.v3-brand-name\s*\{[^}]*\}/.exec(css);
  assert.ok(brandNameMatch, "found .v3-brand-name block");
  assert.equal(brandNameMatch[0].includes("overflow: hidden"), true);

  const statusBtnMatch = /\.v3-status-btn\s*\{[^}]*\}/.exec(css);
  assert.ok(statusBtnMatch, "found .v3-status-btn block");
  assert.equal(statusBtnMatch[0].includes("display: inline-flex"), true);

  const inlineKeysMatch = /\.v3-keys-text\[data-inline-chord="Mod"\]\s*\{[^}]*\}/.exec(css);
  assert.ok(inlineKeysMatch, "found resting .v3-keys-text[data-inline-chord=\"Mod\"] block");
  assert.equal(inlineKeysMatch[0].includes("padding: 1px 5px"), true);
});

test("OS HID modifier resolver suppresses phantom Command popups and hold delay stays responsive", async () => {
  assert.equal(HOLD_DELAY_MS, 350);

  const { settingsStore } = await import("../src/lib/store.ts");
  assert.equal(settingsStore.get().showModifierHoldHints, true, "cmux hold hints enabled by default when never explicitly disabled");

  // Unsupported OS never fabricates a chord
  assert.equal(
    chordFromOsModifiers({ supported: false, meta: true, ctrl: false, alt: false, shift: false }, true),
    null,
  );
  // Released Command on macOS returns null
  assert.equal(
    chordFromOsModifiers({ supported: true, meta: false, ctrl: false, alt: false, shift: false }, true),
    null,
  );
  // Held Command layers on macOS
  assert.equal(
    chordFromOsModifiers({ supported: true, meta: true, ctrl: false, alt: false, shift: false }, true),
    "Mod",
  );
  assert.equal(
    chordFromOsModifiers({ supported: true, meta: true, ctrl: false, alt: true, shift: true }, true),
    "Mod+Alt+Shift",
  );
  // Ctrl+Cmd on macOS does not trigger Mod
  assert.equal(
    chordFromOsModifiers({ supported: true, meta: true, ctrl: true, alt: false, shift: false }, true),
    null,
  );
  // Windows uses Ctrl as Mod
  assert.equal(
    chordFromOsModifiers({ supported: true, meta: false, ctrl: true, alt: false, shift: true }, false),
    "Mod+Shift",
  );
});
