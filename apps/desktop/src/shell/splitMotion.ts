import { SPLIT_GAP_PX, type CssRect, type UnitRect } from "./splitTree";

export const SPLIT_MOTION_MS = 210;

/** Fast pure grid calculation from container CSS dimensions + cached cell metrics (zero DOM queries). */
export function proposeGridFast(
  widthPx: number,
  heightPx: number,
  cellW: number,
  cellH: number,
): { cols: number; rows: number } | null {
  if (widthPx <= 0 || heightPx <= 0 || cellW <= 0 || cellH <= 0) return null;
  return {
    cols: Math.max(2, Math.floor(widthPx / cellW)),
    rows: Math.max(1, Math.floor(heightPx / cellH)),
  };
}

let settledAt = 0;
let settleTimer: number | null = null;
const settledListeners = new Set<() => void>();

export function easeOutQuart(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 4);
}

export function lerpUnitRect(from: UnitRect, to: UnitRect, t: number): UnitRect {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    w: from.w + (to.w - from.w) * t,
    h: from.h + (to.h - from.h) * t,
  };
}

function fmtEdgeCalc(scale: number, offsetPx: number): string {
  const pct = Number((scale * 100).toFixed(4));
  const px = Number(offsetPx.toFixed(2));
  if (Math.abs(px) < 0.01) return `${pct}%`;
  if (Math.abs(pct) < 0.0001) return `${px}px`;
  return px >= 0 ? `calc(${pct}% + ${px}px)` : `calc(${pct}% - ${Math.abs(px)}px)`;
}

/**
 * Converts a normalized [0..1] UnitRect into CSS percentages + split gap offsets
 * matching `computeSplitLayout` boundary offsets so t=1 ends seamlessly with zero snap.
 */
export function unitRectToCss(u: UnitRect, gapPx = SPLIT_GAP_PX): CssRect {
  const half = gapPx / 2;
  const leftPad = u.x > 0.0001 ? half : 0;
  const rightPad = u.x + u.w < 0.9999 ? half : 0;
  const topPad = u.y > 0.0001 ? half : 0;
  const bottomPad = u.y + u.h < 0.9999 ? half : 0;
  return {
    left: fmtEdgeCalc(u.x, leftPad),
    top: fmtEdgeCalc(u.y, topPad),
    width: fmtEdgeCalc(Math.max(0, u.w), -(leftPad + rightPad)),
    height: fmtEdgeCalc(Math.max(0, u.h), -(topPad + bottomPad)),
  };
}

/**
 * Computes the collapsed zero-width or zero-height entry rect along the split seam
 * so a new split pane slides/expands smoothly while squeezing its sibling.
 */
export function collapsedEntryUnitRect(target: UnitRect, prevFocused?: UnitRect): UnitRect {
  if (prevFocused) {
    const horizontalMoved = Math.abs(target.x - prevFocused.x) > 0.025;
    const widthShrank = target.w < prevFocused.w - 0.025 && Math.abs(target.h - prevFocused.h) < 0.025;
    if (horizontalMoved || widthShrank) {
      if (target.x >= prevFocused.x + prevFocused.w * 0.25) {
        return { x: target.x + target.w, y: target.y, w: 0, h: target.h };
      }
      return { x: target.x, y: target.y, w: 0, h: target.h };
    }
    if (target.y >= prevFocused.y + prevFocused.h * 0.25) {
      return { x: target.x, y: target.y + target.h, w: target.w, h: 0 };
    }
    return { x: target.x, y: target.y, w: target.w, h: 0 };
  }
  return target.w <= target.h
    ? { x: target.x + target.w, y: target.y, w: 0, h: target.h }
    : { x: target.x, y: target.y + target.h, w: target.w, h: 0 };
}

function flushSettled(): void {
  if (settleTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(settleTimer);
    settleTimer = null;
  }
  settledAt = 0;
  if (settledListeners.size === 0) return;
  const callbacks = Array.from(settledListeners);
  settledListeners.clear();
  for (const cb of callbacks) {
    try {
      cb();
    } catch {
      // ignore listener errors during split settle flush
    }
  }
}

export function beginSplitMotion(durationMs = SPLIT_MOTION_MS + 25): void {
  if (typeof window === "undefined") return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const target = now + Math.max(0, durationMs);
  if (target > settledAt) settledAt = target;
  if (settleTimer !== null) window.clearTimeout(settleTimer);
  const remaining = Math.max(16, Math.ceil(settledAt - now));
  settleTimer = window.setTimeout(flushSettled, remaining);
}

export function isSplitMotionActive(): boolean {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return now < settledAt;
}

export function onSplitMotionSettled(cb: () => void): () => void {
  if (!isSplitMotionActive()) {
    cb();
    return () => {};
  }
  settledListeners.add(cb);
  return () => {
    settledListeners.delete(cb);
  };
}
