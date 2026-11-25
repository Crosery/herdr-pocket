import type { Terminal as XTerm } from "@xterm/xterm";

interface XTermCoreInternals {
  _renderService?: {
    _isPaused?: boolean;
    hasRenderer?: () => boolean;
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

  if (!isTerminalRendererReady(term)) {
    if (buf.normal.viewportY !== targetY) {
      term.scrollToLine(targetY);
    }
    return false;
  }

  const vp = (term as unknown as { _core?: XTermCoreInternals })._core?._viewport;
  if (vp) {
    // Sync Scrollable dimensions before touching viewportY so stale 0-height state cannot clamp to 0.
    vp._latestYDisp = undefined;
    vp._sync?.(targetY);
  }
  if (buf.normal.viewportY !== targetY) {
    term.scrollToLine(targetY);
  }
  if (vp) {
    vp._latestYDisp = undefined;
    vp._sync?.(targetY);
    vp.scrollToLine?.(targetY, true);
  }
  return true;
}
