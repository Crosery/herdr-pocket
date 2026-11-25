import assert from "node:assert/strict";
import { test } from "node:test";
import { isTerminalRendererReady, snapTerminalViewportImmediate } from "../src/lib/terminalScroll.ts";

function makeMockTerm({
  baseY = 240,
  viewportY = 240,
  alt = false,
  isPaused = false,
  hasRenderer = true,
  cellHeight = 18,
  canvasHeight = 720,
  initialLatestYDisp = viewportY as number | undefined,
} = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const normalBuf = {
    get baseY() {
      return baseY;
    },
    get viewportY() {
      return viewportY;
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
  const term = {
    buffer: {
      normal: normalBuf,
      alternate: altBuf,
      active: alt ? altBuf : normalBuf,
    },
    scrollToLine(line: number) {
      calls.push({ op: "term.scrollToLine", args: [line] });
      viewportY = line;
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
    },
  };
  return { term, calls, getViewportY: () => viewportY, viewport };
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
