import assert from "node:assert/strict";
import test from "node:test";
import { computeKeyboardAvoidingPadding, sanitizeKeyboardCoordinates } from "../src/lib/keyboardMetrics.ts";

test("reproduces iPhone 16 Pro app-switch transient coordinates without collapsing layout", () => {
  const winW = 402;
  const winH = 874;
  const headerHeight = 114;
  const frame = { x: 0, y: 0, width: winW, height: winH - headerHeight }; // 760pt

  // 1. Transient CGRectZero from RCTKeyWindow() == nil on foreground wake
  const zeroCoords = sanitizeKeyboardCoordinates(
    { screenX: 0, screenY: 0, width: 0, height: 0 },
    winW,
    winH,
    "ios",
  );
  assert.deepEqual(zeroCoords, { kind: "invalid" });
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame,
      keyboard: zeroCoords,
      keyboardVerticalOffset: headerHeight,
      windowHeight: winH,
    }),
    0,
  );

  // 2. Transient top-origin frame { screenY: 0, height: 370.9 }
  const topOrigin = sanitizeKeyboardCoordinates(
    { screenX: 0, screenY: 0, width: winW, height: 370.9 },
    winW,
    winH,
    "ios",
  );
  assert.deepEqual(topOrigin, { kind: "invalid" });
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame,
      keyboard: topOrigin,
      keyboardVerticalOffset: headerHeight,
      windowHeight: winH,
    }),
    0,
  );

  // 3. Settled WeType / system docked keyboard frame { screenY: 503.1, height: 370.9 }
  const settled = sanitizeKeyboardCoordinates(
    { screenX: 0, screenY: 503.1, width: winW, height: 370.9 },
    winW,
    winH,
    "ios",
  );
  assert.deepEqual(settled, { kind: "shown", screenY: 503.1, height: 370.9 });
  const padding = computeKeyboardAvoidingPadding({
    frame,
    keyboard: settled,
    keyboardVerticalOffset: headerHeight,
    windowHeight: winH,
  });
  assert.equal(padding, 371);
  assert.ok(frame.height - padding >= 140, `remaining height ${frame.height - padding} preserves header + list + composer`);
});

test("treats iOS off-screen dismiss frame and floating iPad keyboard as hidden", () => {
  const offScreen = sanitizeKeyboardCoordinates(
    { screenX: 0, screenY: 874, width: 402, height: 370.9 },
    402,
    874,
    "ios",
  );
  assert.deepEqual(offScreen, { kind: "hidden" });

  const floating = sanitizeKeyboardCoordinates(
    { screenX: 40, screenY: 420, width: 320, height: 250 },
    834,
    1194,
    "ios",
  );
  assert.deepEqual(floating, { kind: "hidden" });
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame: { x: 0, y: 0, width: 834, height: 1080 },
      keyboard: floating,
      keyboardVerticalOffset: 114,
      windowHeight: 1194,
    }),
    0,
  );
});

test("computes exact bottom padding for tabs/index layout with zero header offset", () => {
  const winW = 402;
  const winH = 874;
  const parsed = sanitizeKeyboardCoordinates(
    { screenX: 0, screenY: 503.1, width: winW, height: 370.9 },
    winW,
    winH,
    "ios",
  );
  assert.equal(parsed.kind, "shown");
  const padding = computeKeyboardAvoidingPadding({
    frame: { x: 0, y: 118, width: winW, height: 756 },
    keyboard: parsed,
    keyboardVerticalOffset: 0,
    windowHeight: winH,
  });
  assert.equal(padding, 371);
});

test("avoids double padding on Android adjustResize and lifts properly on Android edge-to-edge", () => {
  const winW = 412;
  const winH = 874;
  const headerHeight = 114;
  const kb = sanitizeKeyboardCoordinates(
    { screenX: 0, screenY: 503.1, width: winW, height: 370.9 },
    winW,
    winH,
    "android",
  );
  assert.deepEqual(kb, { kind: "shown", screenY: 503.1, height: 370.9 });

  // Android adjustResize already shrunk frame to 389.1pt
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame: { x: 0, y: 0, width: winW, height: 389.1 },
      keyboard: kb,
      keyboardVerticalOffset: headerHeight,
      windowHeight: winH,
    }),
    0,
  );

  // Android 15 edge-to-edge unshrunk frame stays at 760pt
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame: { x: 0, y: 0, width: winW, height: 760 },
      keyboard: kb,
      keyboardVerticalOffset: headerHeight,
      windowHeight: winH,
    }),
    371,
  );
});

test("clamps extreme padding to keyboard height and container minimum remaining space", () => {
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame: null,
      keyboard: { kind: "shown", screenY: 500, height: 300 },
      windowHeight: 800,
    }),
    0,
  );

  // Large keyboardVerticalOffset cannot push padding beyond keyboard.height
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame: { x: 0, y: 0, width: 402, height: 760 },
      keyboard: { kind: "shown", screenY: 500, height: 300 },
      keyboardVerticalOffset: 400,
      windowHeight: 800,
    }),
    300,
  );

  // Short container keeps at least 140pt when frame.height >= 260
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame: { x: 0, y: 0, width: 375, height: 300 },
      keyboard: { kind: "shown", screenY: 200, height: 350 },
      keyboardVerticalOffset: 100,
      windowHeight: 550,
    }),
    160,
  );

  // Very compact container (<260pt) keeps 35% of its height
  assert.equal(
    computeKeyboardAvoidingPadding({
      frame: { x: 0, y: 0, width: 320, height: 200 },
      keyboard: { kind: "shown", screenY: 120, height: 260 },
      keyboardVerticalOffset: 0,
      windowHeight: 380,
    }),
    80,
  );

  // Rejects absurdly tall (>82% window) or non-finite coordinates
  assert.deepEqual(
    sanitizeKeyboardCoordinates({ screenX: 0, screenY: 50, width: 402, height: 750 }, 402, 874, "ios"),
    { kind: "invalid" },
  );
  assert.deepEqual(sanitizeKeyboardCoordinates({ screenX: 0, screenY: Number.NaN, width: 402, height: 300 }, 402, 874, "ios"), {
    kind: "invalid",
  });
});
