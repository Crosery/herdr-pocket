import type { Terminal as XTerm } from "@xterm/xterm";
import { paintTerminalViewportImmediate, wakeTerminalRendererImmediate } from "./terminalScroll";

export const LOCAL_FONT_WAIT_MS = 60;
export const LOCAL_HOST_READY_FALLBACK_MS = 180;
export const RELAY_HOST_READY_FALLBACK_MS = 280;
export const MOUNT_SAFETY_REVEAL_MS = 1500;
export const RELAY_SEED_FALLBACK_MS = 240;
export const RAW_EMPTY_FALLBACK_MS = 1200;
export const FALLBACK_READ_RETRY_MS = 1500;
export const FALLBACK_READ_MAX_RETRIES = 2;

export interface TerminalActivationPhase0Result {
  refreshedWarm: boolean;
  hadDirtyWhileInactive: boolean;
  paintedInPhase0: boolean;
}

export interface TerminalActivationPhase0Context<TAddon = unknown> {
  getWebgl: () => TAddon | null | undefined;
  touchWarmWebgl: () => void;
  refreshWarmWebgl: (addon: TAddon) => void;
  wakeRenderer: () => boolean;
  maybeResize?: () => void;
  snapViewport: () => void;
  isDirtyWhileInactive: () => boolean;
  clearDirtyWhileInactive: () => void;
  paintViewport: () => boolean;
}

/**
 * Phase 0 synchronous activation (before Frame 0 paint, ONLY on inactive -> active transitions):
 * - Never creates a cold WebGL2 context synchronously (keeps click-to-paint off the shader compile path).
 * - If a warm WebGL addon is already attached, touches its LRU slot and invalidates its model/UVs.
 * - Unpauses renderer, snaps scroll, and unconditionally paints visible viewport rows synchronously
 *   so warm WebGL clears (from `refreshWarmWebgl`) and DOM panes never flash or stick blank white.
 */
export function runTerminalActivationPhase0<TAddon>(
  ctx: TerminalActivationPhase0Context<TAddon>,
): TerminalActivationPhase0Result {
  const hadDirtyWhileInactive = ctx.isDirtyWhileInactive();
  if (ctx.getWebgl()) {
    ctx.touchWarmWebgl();
    const stillWarm = ctx.getWebgl();
    if (stillWarm) {
      ctx.refreshWarmWebgl(stillWarm);
    }
  }
  const refreshedWarm = Boolean(ctx.getWebgl());
  const wokeOrNeedsRefresh = ctx.wakeRenderer();
  ctx.maybeResize?.();
  ctx.snapViewport();
  let paintedInPhase0 = false;
  if (refreshedWarm || wokeOrNeedsRefresh || ctx.isDirtyWhileInactive() || !ctx.getWebgl()) {
    ctx.clearDirtyWhileInactive();
    paintedInPhase0 = Boolean(ctx.paintViewport());
  }
  return { refreshedWarm, hadDirtyWhileInactive, paintedInPhase0 };
}

export interface TerminalActivationPhase1Context<TAddon = unknown> {
  getWebgl: () => TAddon | null | undefined;
  attachWebgl: () => void;
  isDirtyWhileInactive: () => boolean;
  clearDirtyWhileInactive: () => void;
  refreshFullViewport: () => void;
}

/**
 * Phase 1 post-paint activation (`requestAnimationFrame`):
 * - Promotes cold panes to WebGL after click paint has committed.
 * - Avoids duplicate `term.refresh` when Phase 0 already painted cleanly, no new output arrived
 *   since Phase 0, and WebGL was not newly attached; otherwise refreshes the full viewport.
 */
export function runTerminalActivationPhase1<TAddon>(
  ctx: TerminalActivationPhase1Context<TAddon>,
  phase0: TerminalActivationPhase0Result,
): { attachedWebgl: boolean; refreshed: boolean } {
  const hadWebglBefore = Boolean(ctx.getWebgl());
  ctx.attachWebgl();
  const attachedWebgl = !hadWebglBefore && Boolean(ctx.getWebgl());
  const shouldRefresh = ctx.isDirtyWhileInactive() || !phase0.paintedInPhase0 || attachedWebgl;
  if (shouldRefresh) {
    ctx.clearDirtyWhileInactive();
    ctx.refreshFullViewport();
  }
  return { attachedWebgl, refreshed: shouldRefresh };
}

export interface WebglContextLike {
  isContextLost?: () => boolean;
  getExtension?: (name: string) => { loseContext?: () => void } | null;
}

interface WebglAddonInternals {
  _renderer?: {
    _gl?: WebglContextLike | null;
    _canvas?: Pick<HTMLCanvasElement, "addEventListener" | "removeEventListener"> | null;
  };
}

/** Captures the underlying WebGL2 context from a mounted `@xterm/addon-webgl` instance if present. */
export function getWebglAddonContext(addon: unknown): WebglContextLike | null {
  return (addon as WebglAddonInternals | null | undefined)?._renderer?._gl ?? null;
}

/**
 * Explicitly calls `WEBGL_lose_context.loseContext()` when disposing a WebGL addon so evicted or
 * unmounted terminals release WebKit GPU WebGL2 context slots immediately instead of waiting for GC.
 */
export function releaseWebglAddonContext(addon: unknown, preCapturedGl?: WebglContextLike | null): boolean {
  try {
    const gl = preCapturedGl ?? getWebglAddonContext(addon);
    if (!gl || gl.isContextLost?.()) return false;
    const ext = gl.getExtension?.("WEBGL_lose_context");
    if (ext && typeof ext.loseContext === "function") {
      ext.loseContext();
      return true;
    }
  } catch {
    // ignore context release errors during teardown
  }
  return false;
}

/**
 * Attaches an immediate `{ once: true }` `webglcontextlost` listener directly on the WebGL canvas
 * to bypass `@xterm/addon-webgl`'s 3000ms delayed `onContextLoss` timer and recover DOM rendering at once.
 */
export function attachImmediateWebglContextLossListener(
  addon: unknown,
  hostEl: { querySelector: (sel: string) => Pick<HTMLCanvasElement, "addEventListener" | "removeEventListener"> | null } | null,
  onLost: () => void,
): (() => void) | null {
  const canvas =
    (addon as WebglAddonInternals | null | undefined)?._renderer?._canvas ?? hostEl?.querySelector("canvas") ?? null;
  if (!canvas || typeof canvas.addEventListener !== "function") return null;
  const handler = () => {
    onLost();
  };
  canvas.addEventListener("webglcontextlost", handler, { once: true });
  return () => {
    canvas.removeEventListener("webglcontextlost", handler);
  };
}

/**
 * Immediately wakes and repaints xterm's fallback DOM renderer when WebGL is disposed
 * (e.g., on `webglcontextlost` / `onContextLoss` or LRU eviction) while the terminal pane is alive and active.
 */
export function recoverActiveTerminalAfterWebglDispose(
  term: Pick<XTerm, "cols" | "rows" | "refresh"> | null | undefined,
  isAliveAndActive: boolean,
): boolean {
  if (!isAliveAndActive || !term) return false;
  wakeTerminalRendererImmediate(term);
  paintTerminalViewportImmediate(term);
  try {
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    // ignore if terminal is tearing down
  }
  return true;
}

/**
 * Runs terminal mount startup with strict reveal-timer reset and rejection fallback so
 * an unhandled error in local attach / font / mux startup never strands `data-ready="false"`.
 */
export async function runTerminalStartupWithFallback(deps: {
  isAlive: () => boolean;
  waitUntilAttachable: () => Promise<void>;
  resetMountStartedAt: () => void;
  startPrimary: () => Promise<void>;
  onError?: (err: unknown) => void;
  clearLocalAttachPending?: () => void;
  isLocalConnected: () => boolean;
  startRelayFallback: () => void;
  hasRelaySubscription: () => boolean;
  markHostReadyFallback: () => void;
}): Promise<void> {
  try {
    await deps.waitUntilAttachable();
    if (!deps.isAlive()) return;
    deps.resetMountStartedAt();
    await deps.startPrimary();
  } catch (err) {
    deps.clearLocalAttachPending?.();
    if (!deps.isAlive()) return;
    deps.onError?.(err);
    if (!deps.isLocalConnected()) {
      try {
        deps.startRelayFallback();
      } catch {
        // fall through to reveal fallback below
      }
      if (!deps.hasRelaySubscription()) {
        deps.markHostReadyFallback();
      }
    } else {
      deps.markHostReadyFallback();
    }
  }
}

export interface RelayStreamStateLike {
  kind?: string;
  result?: { raw?: boolean };
}

export interface RelayFallbackControllerDeps<TReadResult> {
  isAlive: () => boolean;
  hasSawRaw: () => boolean;
  readScreen: () => Promise<TReadResult>;
  onFallbackScreen: (res: TReadResult) => void;
  onFallbackReadStart?: () => void;
  onFallbackReadError?: () => void;
  onRawModeConfirmed?: () => void;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  seedDelayMs?: number;
  rawEmptyDelayMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

export interface RelayFallbackController {
  start: () => void;
  onRawBytes: () => void;
  onStreamState: (state: RelayStreamStateLike | undefined) => void;
  dispose: () => void;
}

/**
 * Manages relay terminal fallback reads so:
 * 1. An idle `raw: true` stream that emits 0 bytes still populates the screen via one-shot `terminal.read` after 1200ms.
 * 2. Transient `terminal.read` failures retry up to 2 times (1500ms backoff) while `!sawRaw && !rawModeConfirmed`.
 * 3. `stale`/`error` -> `live` recovery while `!sawRaw` re-triggers fallback read/timer so evicted streams never stay blank.
 */
export function createRelayFallbackController<TReadResult>(
  deps: RelayFallbackControllerDeps<TReadResult>,
): RelayFallbackController {
  const schedule = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.clearTimeoutFn ?? ((id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  const seedDelayMs = deps.seedDelayMs ?? RELAY_SEED_FALLBACK_MS;
  const rawEmptyDelayMs = deps.rawEmptyDelayMs ?? RAW_EMPTY_FALLBACK_MS;
  const retryDelayMs = deps.retryDelayMs ?? FALLBACK_READ_RETRY_MS;
  const maxRetries = deps.maxRetries ?? FALLBACK_READ_MAX_RETRIES;

  let disposed = false;
  let rawModeConfirmed = false;
  let sawStale = false;
  let fallbackReadGen = 0;
  let seedTimer: ReturnType<typeof setTimeout> | null = null;
  let rawEmptyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearSeedTimer = () => {
    if (seedTimer !== null) {
      cancel(seedTimer);
      seedTimer = null;
    }
  };
  const clearRawEmptyTimer = () => {
    if (rawEmptyFallbackTimer !== null) {
      cancel(rawEmptyFallbackTimer);
      rawEmptyFallbackTimer = null;
    }
  };
  const clearRetryTimer = () => {
    if (fallbackRetryTimer !== null) {
      cancel(fallbackRetryTimer);
      fallbackRetryTimer = null;
    }
  };

  const runFallbackRead = (attempt = 0) => {
    if (disposed || !deps.isAlive() || deps.hasSawRaw() || rawModeConfirmed) return;
    if (attempt === 0) clearRetryTimer();
    deps.onFallbackReadStart?.();
    const gen = ++fallbackReadGen;
    void deps
      .readScreen()
      .then((res) => {
        if (disposed || !deps.isAlive() || deps.hasSawRaw() || rawModeConfirmed) return;
        deps.onFallbackScreen(res);
      })
      .catch(() => {
        if (disposed || !deps.isAlive()) return;
        deps.onFallbackReadError?.();
        if (gen !== fallbackReadGen || deps.hasSawRaw() || rawModeConfirmed) return;
        if (attempt < maxRetries) {
          clearRetryTimer();
          fallbackRetryTimer = schedule(() => {
            fallbackRetryTimer = null;
            runFallbackRead(attempt + 1);
          }, retryDelayMs);
        }
      });
  };

  const scheduleRawEmptyFallback = () => {
    clearRawEmptyTimer();
    if (disposed || !deps.isAlive() || deps.hasSawRaw()) return;
    rawEmptyFallbackTimer = schedule(() => {
      rawEmptyFallbackTimer = null;
      if (disposed || !deps.isAlive() || deps.hasSawRaw()) return;
      void deps
        .readScreen()
        .then((res) => {
          if (!disposed && deps.isAlive() && !deps.hasSawRaw()) {
            deps.onFallbackScreen(res);
          }
        })
        .catch(() => {
          if (!disposed && deps.isAlive()) {
            deps.onFallbackReadError?.();
          }
        });
    }, rawEmptyDelayMs);
  };

  return {
    start() {
      clearSeedTimer();
      seedTimer = schedule(() => {
        seedTimer = null;
        runFallbackRead(0);
      }, seedDelayMs);
    },
    onRawBytes() {
      clearSeedTimer();
      clearRawEmptyTimer();
      clearRetryTimer();
    },
    onStreamState(state) {
      if (disposed || !deps.isAlive() || !state) return;
      if (state.kind === "stale") {
        sawStale = true;
        return;
      }
      if (state.kind === "error") {
        sawStale = true;
        if (!deps.hasSawRaw()) {
          rawModeConfirmed = false;
        }
        clearSeedTimer();
        runFallbackRead(0);
        return;
      }
      if (state.kind === "live") {
        const recoveredFromStale = sawStale;
        sawStale = false;
        if (state.result?.raw === true) {
          rawModeConfirmed = true;
          deps.onRawModeConfirmed?.();
          clearSeedTimer();
          clearRetryTimer();
          if (!deps.hasSawRaw()) {
            scheduleRawEmptyFallback();
          }
        } else {
          rawModeConfirmed = false;
          if (recoveredFromStale && !deps.hasSawRaw()) {
            clearSeedTimer();
            runFallbackRead(0);
          }
        }
      }
    },
    dispose() {
      disposed = true;
      clearSeedTimer();
      clearRawEmptyTimer();
      clearRetryTimer();
    },
  };
}

/** Enables xterm cursor blinking only when configured AND the terminal pane and window are active/focused. */
export function shouldEnableTerminalCursorBlink(input: {
  configBlink: boolean;
  active: boolean;
  focused: boolean;
  windowFocused: boolean;
}): boolean {
  return Boolean(input.configBlink && input.active && input.focused && input.windowFocused);
}
