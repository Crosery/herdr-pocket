import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTerminalRendererReady,
  reconcileTerminalBottomSticky,
  snapTerminalViewportImmediate,
} from "../src/lib/terminalScroll.ts";

function makeMockTerm({
  baseY = 240,
  viewportY = 240,
  alt = false,
  isPaused = false,
  hasRenderer = true,
  cellHeight = 18,
  canvasHeight = 720,
  initialLatestYDisp = viewportY as number | undefined,
  withBufferService = false,
  isUserScrolling = false,
} = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const normalBuf = {
    get baseY() {
      return baseY;
    },
    get viewportY() {
      return viewportY;
    },
    get ydisp() {
      return viewportY;
    },
    set ydisp(v: number) {
      viewportY = v;
    },
    get ybase() {
      return baseY;
    },
  };
  const altBuf = {
    get baseY() {
      return 0;
    },
    get viewportY() {
      return 0;
    },
  };
  const viewport = {
    _latestYDisp: initialLatestYDisp,
    _sync(y?: number) {
      calls.push({ op: "_sync", args: [y] });
      viewport._latestYDisp = y ?? viewportY;
    },
    scrollToLine(line: number, immediate?: boolean) {
      calls.push({ op: "vp.scrollToLine", args: [line, immediate] });
      if (immediate) viewport._latestYDisp = line;
    },
  };
  const bufferService = {
    isUserScrolling,
    buffer: normalBuf,
    scrollLines(disp: number, suppressScrollEvent?: boolean) {
      calls.push({ op: "bs.scrollLines", args: [disp, suppressScrollEvent] });
      viewportY = Math.max(0, Math.min(baseY, viewportY + disp));
    },
  };
  const term = {
    rows: 40,
    buffer: {
      normal: normalBuf,
      alternate: altBuf,
      active: alt ? altBuf : normalBuf,
    },
    scrollToLine(line: number) {
      calls.push({ op: "term.scrollToLine", args: [line] });
      viewportY = line;
    },
    refresh(start: number, end: number) {
      calls.push({ op: "term.refresh", args: [start, end] });
    },
    _core: {
      _renderService: {
        _isPaused: isPaused,
        hasRenderer: () => hasRenderer,
        dimensions: {
          css: {
            cell: { height: cellHeight },
            canvas: { height: canvasHeight },
          },
        },
      },
      _viewport: viewport,
      ...(withBufferService ? { _bufferService: bufferService } : {}),
    },
  };
  return { term, calls, getViewportY: () => viewportY, viewport, bufferService };
}

test("isTerminalRendererReady rejects paused or 0-height hidden renderers", () => {
  assert.equal(isTerminalRendererReady(null), false);
  assert.equal(isTerminalRendererReady(makeMockTerm().term as never), true);
  assert.equal(isTerminalRendererReady(makeMockTerm({ isPaused: true }).term as never), false);
  assert.equal(isTerminalRendererReady(makeMockTerm({ hasRenderer: false }).term as never), false);
  assert.equal(isTerminalRendererReady(makeMockTerm({ cellHeight: 0 }).term as never), false);
  assert.equal(isTerminalRendererReady(makeMockTerm({ canvasHeight: 0 }).term as never), false);
});

test("snapTerminalViewportImmediate recovers 0-clamped Scrollable even when viewportY already equals baseY", () => {
  const { term, calls, getViewportY } = makeMockTerm({ baseY: 320, viewportY: 320, initialLatestYDisp: 320 });
  const ok = snapTerminalViewportImmediate(term as never, true, 0);
  assert.equal(ok, true);
  assert.equal(getViewportY(), 320);
  assert.deepEqual(calls, [
    { op: "_sync", args: [320] },
    { op: "_sync", args: [320] },
    { op: "vp.scrollToLine", args: [320, true] },
  ]);
});

test("snapTerminalViewportImmediate restores user scroll offset from bottom when not sticking to bottom", () => {
  const { term, calls, getViewportY } = makeMockTerm({ baseY: 300, viewportY: 0, initialLatestYDisp: 0 });
  const ok = snapTerminalViewportImmediate(term as never, false, 45);
  assert.equal(ok, true);
  assert.equal(getViewportY(), 255);
  assert.deepEqual(calls, [
    { op: "_sync", args: [255] },
    { op: "term.scrollToLine", args: [255] },
    { op: "_sync", args: [255] },
    { op: "vp.scrollToLine", args: [255, true] },
  ]);
});

test("snapTerminalViewportImmediate defers cleanly when renderer is paused or 0-height", () => {
  const { term, calls, getViewportY } = makeMockTerm({
    baseY: 180,
    viewportY: 0,
    isPaused: true,
    canvasHeight: 0,
  });
  const ok = snapTerminalViewportImmediate(term as never, true, 0);
  assert.equal(ok, false);
  assert.equal(getViewportY(), 180);
  assert.deepEqual(calls, [{ op: "term.scrollToLine", args: [180] }]);
});

test("snapTerminalViewportImmediate treats alternate screen buffer as a safe no-op", () => {
  const { term, calls } = makeMockTerm({ alt: true });
  assert.equal(snapTerminalViewportImmediate(term as never, true, 0), true);
  assert.deepEqual(calls, []);
});

test("snapTerminalViewportImmediate uses _bufferService on paused renderer without smooth term.scrollToLine", () => {
  const { term, calls, getViewportY, bufferService } = makeMockTerm({
    baseY: 300,
    viewportY: 120,
    isPaused: true,
    canvasHeight: 0,
    withBufferService: true,
    isUserScrolling: true,
  });
  const ok = snapTerminalViewportImmediate(term as never, true, 0);
  assert.equal(ok, false);
  assert.equal(getViewportY(), 300);
  assert.equal(bufferService.isUserScrolling, false);
  assert.deepEqual(calls, [{ op: "bs.scrollLines", args: [180, true] }]);
});

test("snapTerminalViewportImmediate sets isUserScrolling based on stickToBottom on ready renderer", () => {
  const { term, calls, getViewportY, bufferService } = makeMockTerm({
    baseY: 400,
    viewportY: 400,
    withBufferService: true,
    isUserScrolling: false,
  });
  assert.equal(snapTerminalViewportImmediate(term as never, false, 35), true);
  assert.equal(getViewportY(), 365);
  assert.equal(bufferService.isUserScrolling, true);
  assert.deepEqual(calls, [
    { op: "_sync", args: [365] },
    { op: "bs.scrollLines", args: [-35, true] },
    { op: "term.refresh", args: [0, 39] },
    { op: "_sync", args: [365] },
    { op: "vp.scrollToLine", args: [365, true] },
  ]);

  calls.length = 0;
  assert.equal(snapTerminalViewportImmediate(term as never, true, 0), true);
  assert.equal(getViewportY(), 400);
  assert.equal(bufferService.isUserScrolling, false);
  assert.deepEqual(calls, [
    { op: "_sync", args: [400] },
    { op: "bs.scrollLines", args: [35, true] },
    { op: "term.refresh", args: [0, 39] },
    { op: "_sync", args: [400] },
    { op: "vp.scrollToLine", args: [400, true] },
  ]);
});

test("reconcileTerminalBottomSticky resists programmatic clamps and honors real user scroll", () => {
  // Programmatic reflow or clamp leaves viewportY < baseY while user did not scroll up.
  assert.deepEqual(
    reconcileTerminalBottomSticky({
      prev: { wasAtBottom: true, savedOffsetFromBottom: 0 },
      isAltBuffer: false,
      baseY: 500,
      viewportY: 0,
      hasUserScrollUpIntent: false,
      hasUserScrollAdjustIntent: false,
    }),
    { wasAtBottom: true, savedOffsetFromBottom: 0, shouldSnapToBottom: true },
  );

  // Explicit user upward scroll unsticks cleanly and records offset.
  assert.deepEqual(
    reconcileTerminalBottomSticky({
      prev: { wasAtBottom: true, savedOffsetFromBottom: 0 },
      isAltBuffer: false,
      baseY: 500,
      viewportY: 440,
      hasUserScrollUpIntent: true,
      hasUserScrollAdjustIntent: true,
    }),
    { wasAtBottom: false, savedOffsetFromBottom: 60, shouldSnapToBottom: false },
  );

  // Streaming output while scrolled up adjusts savedOffsetFromBottom to track the user's line.
  assert.deepEqual(
    reconcileTerminalBottomSticky({
      prev: { wasAtBottom: false, savedOffsetFromBottom: 60 },
      isAltBuffer: false,
      baseY: 510,
      viewportY: 440,
      hasUserScrollUpIntent: false,
      hasUserScrollAdjustIntent: false,
    }),
    { wasAtBottom: false, savedOffsetFromBottom: 70, shouldSnapToBottom: false },
  );

  // Sudden viewportY === 0 clamp without user intent while scrolled up preserves previous offset.
  assert.deepEqual(
    reconcileTerminalBottomSticky({
      prev: { wasAtBottom: false, savedOffsetFromBottom: 60 },
      isAltBuffer: false,
      baseY: 500,
      viewportY: 0,
      hasUserScrollUpIntent: false,
      hasUserScrollAdjustIntent: false,
    }),
    { wasAtBottom: false, savedOffsetFromBottom: 60, shouldSnapToBottom: false },
  );

  // Scrolling back within 1 line of baseY restores sticky bottom tracking.
  assert.deepEqual(
    reconcileTerminalBottomSticky({
      prev: { wasAtBottom: false, savedOffsetFromBottom: 60 },
      isAltBuffer: false,
      baseY: 500,
      viewportY: 499,
      hasUserScrollUpIntent: false,
      hasUserScrollAdjustIntent: true,
    }),
    { wasAtBottom: true, savedOffsetFromBottom: 0, shouldSnapToBottom: true },
  );
});
