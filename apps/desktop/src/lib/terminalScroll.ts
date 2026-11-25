import type { Terminal as XTerm } from "@xterm/xterm";

interface XTermCoreInternals {
  _renderService?: {
    _isPaused?: boolean;
    _needsFullRefresh?: boolean;
    _charSizeService?: {
      hasValidSize?: boolean;
      measure?: () => void;
    };
    _pausedResizeTask?: {
      flush?: () => void;
    };
    hasRenderer?: () => boolean;
    handleResize?: (cols: number, rows: number) => void;
    _renderRows?: (start: number, end: number) => void;
    dimensions?: {
      css?: {
        cell?: { height?: number };
        canvas?: { height?: number };
      };
    };
  };
  _viewport?: {
    _latestYDisp?: number;
    _sync?: (ydisp?: number) => void;
    scrollToLine?: (line: number, immediate?: boolean) => void;
  };
  _bufferService?: {
    isUserScrolling?: boolean;
    buffer?: {
      ydisp: number;
      ybase: number;
    };
    scrollLines?: (disp: number, suppressScrollEvent?: boolean) => void;
  };
}

/**
 * Unpauses xterm's RenderService synchronously before Frame 0 paints when a hidden `.v3-tab-layer`
 * becomes active (before IntersectionObserver fires asynchronously post-paint), flushing deferred
 * resize/char-size tasks so dimensions and viewport sync can complete immediately.
 */
export function wakeTerminalRendererImmediate(term: Pick<XTerm, "cols" | "rows"> | null | undefined): boolean {
  if (!term) return false;
  try {
    const rs = (term as unknown as { _core?: XTermCoreInternals })._core?._renderService;
    if (!rs) return false;
    const wasPaused = Boolean(rs._isPaused);
    const needsFull = Boolean(rs._needsFullRefresh);
    if (wasPaused) {
      rs._isPaused = false;
      if (rs._charSizeService && !rs._charSizeService.hasValidSize) {
        rs._charSizeService.measure?.();
      }
      rs._pausedResizeTask?.flush?.();
    }
    const cellH = rs.dimensions?.css?.cell?.height ?? 0;
    const canvasH = rs.dimensions?.css?.canvas?.height ?? 0;
    if ((cellH <= 0 || canvasH <= 0) && term.cols > 0 && term.rows > 0) {
      rs.handleResize?.(term.cols, term.rows);
    }
    return wasPaused || needsFull;
  } catch {
    return false;
  }
}

/**
 * Synchronously paints the visible viewport rows (`0..term.rows - 1`) without waiting for xterm's
 * next requestAnimationFrame render debouncer. Used both when waking a hidden tab in useLayoutEffect
 * and right after promoting DomRenderer -> WebglRenderer so no blank white frame appears in between.
 */
export function paintTerminalViewportImmediate(term: Pick<XTerm, "cols" | "rows"> | null | undefined): boolean {
  if (!term) return false;
  try {
    const rs = (term as unknown as { _core?: XTermCoreInternals })._core?._renderService;
    if (!rs || term.rows <= 0 || typeof rs._renderRows !== "function") return false;
    rs._needsFullRefresh = false;
    rs._renderRows(0, Math.max(0, term.rows - 1));
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true once xterm's active renderer is unpaused and holds non-zero CSS cell/canvas dimensions.
 * While hidden in a `.v3-tab-layer.is-hidden` layer, IntersectionObserver pauses `_renderService` and
 * `detachWebgl` installs a fresh DOM renderer whose `handleResize` stays deferred at 0x0.
 */
export function isTerminalRendererReady(term: Pick<XTerm, "buffer"> | null | undefined): boolean {
  if (!term) return false;
  const rs = (term as unknown as { _core?: XTermCoreInternals })._core?._renderService;
  if (!rs) return true;
  if (rs._isPaused) return false;
  if (typeof rs.hasRenderer === "function" && !rs.hasRenderer()) return false;
  const cellH = rs.dimensions?.css?.cell?.height ?? 0;
  const canvasH = rs.dimensions?.css?.canvas?.height ?? 0;
  return cellH > 0 && canvasH > 0;
}

/**
 * Immediately synchronizes both xterm's logical `viewportY` and its internal `SmoothScrollableElement`
 * `scrollTop` without smooth-scroll animation, recovering from hidden-tab 0-height clamps where
 * `_latestYDisp` stays equal to `baseY` while `_scrollableElement._state.scrollTop` was clamped to `0`.
 * Returns `false` if the renderer is still paused/unmeasured so the caller can complete on next render.
 */
export function snapTerminalViewportImmediate(
  term: Pick<XTerm, "buffer" | "scrollToLine">,
  stickToBottom = true,
  savedOffsetFromBottom = 0,
): boolean {
  const buf = term.buffer;
  if (buf.active !== buf.normal) return true;
  const baseY = Math.max(0, buf.normal.baseY);
  const targetY = stickToBottom
    ? baseY
    : Math.max(0, Math.min(baseY, baseY - Math.max(0, savedOffsetFromBottom)));

  const core = (term as unknown as { _core?: XTermCoreInternals })._core;
  const bs = core?._bufferService;
  const vp = core?._viewport;

  const syncLogicalBuffer = (): boolean => {
    if (bs && typeof bs.scrollLines === "function") {
      const curY = bs.buffer?.ydisp ?? buf.normal.viewportY;
      if (curY !== targetY) {
        bs.scrollLines(targetY - curY, true);
      }
      bs.isUserScrolling = !stickToBottom && targetY < baseY;
      return curY !== targetY;
    }
    if (buf.normal.viewportY !== targetY) {
      term.scrollToLine(targetY);
      return true;
    }
    return false;
  };

  if (!isTerminalRendererReady(term)) {
    syncLogicalBuffer();
    return false;
  }

  if (vp) {
    // Sync Scrollable dimensions before touching viewportY so stale 0-height state cannot clamp to 0.
    vp._latestYDisp = undefined;
    vp._sync?.(targetY);
  }
  const moved = syncLogicalBuffer();
  if (bs && moved) {
    const termWithRefresh = term as unknown as {
      refresh?: (start: number, end: number) => void;
      rows?: number;
    };
    termWithRefresh.refresh?.(0, Math.max(0, (termWithRefresh.rows ?? 1) - 1));
  }
  if (vp) {
    vp._latestYDisp = undefined;
    vp._sync?.(targetY);
    vp.scrollToLine?.(targetY, true);
  }
  return true;
}

export interface StickyScrollState {
  wasAtBottom: boolean;
  savedOffsetFromBottom: number;
}

export interface ReconcileStickyInput {
  prev: StickyScrollState;
  isAltBuffer: boolean;
  baseY: number;
  viewportY: number;
  hasUserScrollUpIntent: boolean;
  hasUserScrollAdjustIntent: boolean;
}

export interface ReconcileStickyResult extends StickyScrollState {
  shouldSnapToBottom: boolean;
}

/**
 * Reconciles sticky bottom scroll tracking without letting passive programmatic reflows,
 * hidden-tab clamps, or renderer swaps poison `wasAtBottom` into scrolling to the top.
 */
export function reconcileTerminalBottomSticky(input: ReconcileStickyInput): ReconcileStickyResult {
  if (input.isAltBuffer) {
    return { wasAtBottom: true, savedOffsetFromBottom: 0, shouldSnapToBottom: false };
  }
  const safeBaseY = Math.max(0, input.baseY);
  const safeViewportY = Math.max(0, Math.min(safeBaseY, input.viewportY));
  const atBottom = safeViewportY >= safeBaseY - 1;

  if (input.prev.wasAtBottom) {
    if (atBottom) {
      return {
        wasAtBottom: true,
        savedOffsetFromBottom: 0,
        shouldSnapToBottom: safeViewportY < safeBaseY,
      };
    }
    if (input.hasUserScrollUpIntent) {
      return {
        wasAtBottom: false,
        savedOffsetFromBottom: Math.max(1, safeBaseY - safeViewportY),
        shouldSnapToBottom: false,
      };
    }
    // Programmatic resize reflow, hidden-tab clamp, or multi-line TUI rewrite — stay pinned to bottom!
    return {
      wasAtBottom: true,
      savedOffsetFromBottom: 0,
      shouldSnapToBottom: true,
    };
  }

  if (atBottom) {
    return {
      wasAtBottom: true,
      savedOffsetFromBottom: 0,
      shouldSnapToBottom: safeViewportY < safeBaseY,
    };
  }
  if (input.hasUserScrollAdjustIntent) {
    return {
      wasAtBottom: false,
      savedOffsetFromBottom: Math.max(1, safeBaseY - safeViewportY),
      shouldSnapToBottom: false,
    };
  }
  if (safeViewportY === 0 && input.prev.savedOffsetFromBottom < safeBaseY - 5) {
    return {
      wasAtBottom: false,
      savedOffsetFromBottom: input.prev.savedOffsetFromBottom,
      shouldSnapToBottom: false,
    };
  }
  return {
    wasAtBottom: false,
    savedOffsetFromBottom: Math.max(1, safeBaseY - safeViewportY),
    shouldSnapToBottom: false,
  };
}
