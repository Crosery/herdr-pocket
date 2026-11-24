import assert from "node:assert/strict";
import { test } from "node:test";
import { logStore } from "../src/lib/log.ts";
import {
  FocusFlipTracker,
  resetUiTelemetryForTest,
  trackModifierGhostBlocked,
  trackModifierHudHide,
  trackModifierHudShow,
  trackTerminalImeEvent,
  trackTerminalLayoutJump,
} from "../src/lib/uiTelemetry.ts";

test("uiTelemetry logs privacy-safe modifier ghost blocks, HUD show/hide, and layout jumps", () => {
  resetUiTelemetryForTest();
  const baseCount = logStore.get().entries.length;

  trackModifierHudShow("Mod+Shift");
  trackModifierHudHide("Mod+Shift", 512.4, "keyup");
  trackModifierGhostBlocked(
    "Mod",
    { supported: true, meta: false, ctrl: false, alt: false, shift: false },
    "os_hid",
  );
  trackTerminalImeEvent("rescue_comp", { chars: 12 });
  trackTerminalLayoutJump({
    prevCols: 240,
    prevRows: 50,
    cols: 120,
    rows: 50,
    deltaCols: -120,
    deltaRows: 0,
    mode: "local",
  });

  const added = logStore.get().entries.slice(baseCount);
  assert.equal(added.length, 5);

  const ghost = added.find((e) => e.msg === "ui.modifier.ghost_blocked");
  assert.ok(ghost);
  assert.equal(ghost.level, "warn");
  assert.equal(ghost.scope, "ui");
  assert.equal(ghost.data?.domChord, "Mod");
  assert.equal(ghost.data?.osMeta, false);

  const hide = added.find((e) => e.msg === "ui.modifier.hide");
  assert.ok(hide);
  assert.equal(hide.data?.heldMs, 512);
  assert.equal(hide.data?.reason, "keyup");

  const jump = added.find((e) => e.msg === "term.layout.jump");
  assert.ok(jump);
  assert.equal(jump.level, "warn");
  assert.equal(jump.data?.deltaCols, -120);
});

test("FocusFlipTracker detects rapid focus-steal oscillation inside 5s window without spamming", () => {
  const tracker = new FocusFlipTracker();
  assert.equal(tracker.recordBlurOrFlip(1_000), false);
  assert.equal(tracker.recordBlurOrFlip(2_000), false);
  assert.equal(tracker.recordBlurOrFlip(3_500), true, "3 blurs within 5s must warn");
  assert.equal(tracker.recordBlurOrFlip(4_000), false, "cooldown suppresses duplicate warn inside 5s");
  assert.equal(tracker.recordBlurOrFlip(9_600), false, "older timestamps expire cleanly outside 5s window");
  assert.equal(tracker.recentCount(9_600), 1);
});
