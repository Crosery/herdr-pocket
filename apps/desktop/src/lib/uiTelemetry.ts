import { log, type LogLevel } from "./log";

export interface TelemetryModifierState {
  supported: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const FOCUS_FLIP_WINDOW_MS = 5_000;
const FOCUS_FLIP_WARN_THRESHOLD = 3;
const THROTTLE_MS = 1_500;
const lastEmittedAt = new Map<string, number>();

function emitThrottled(
  throttleKey: string,
  level: LogLevel,
  scope: string,
  msg: string,
  data?: Record<string, unknown>,
  minIntervalMs = THROTTLE_MS,
): boolean {
  const now = Date.now();
  const prev = lastEmittedAt.get(throttleKey) ?? 0;
  if (minIntervalMs > 0 && now - prev < minIntervalMs) {
    return false;
  }
  lastEmittedAt.set(throttleKey, now);
  log(level, scope, msg, data);
  return true;
}

/** Records when the modifier shortcut hint HUD becomes visible. */
export function trackModifierHudShow(chord: string): void {
  log("info", "ui", "ui.modifier.show", { chord });
}

/** Records why and after how long the modifier shortcut hint HUD closed. */
export function trackModifierHudHide(chord: string, heldMs: number, reason: string): void {
  log("info", "ui", "ui.modifier.hide", {
    chord,
    heldMs: Math.max(0, Math.round(heldMs)),
    reason,
  });
}

/**
 * Logs a warning when DOM saw a held modifier timer elapse, but OS HID or DOM state
 * proved the physical modifier key is NOT held down (catching phantom Command popups).
 */
export function trackModifierGhostBlocked(
  domChord: string,
  osState: TelemetryModifierState,
  source: "os_hid" | "dom_mismatch" | "unfocused" = "os_hid",
): void {
  emitThrottled(
    `ghost:${domChord}:${source}`,
    "warn",
    "ui",
    "ui.modifier.ghost_blocked",
    {
      domChord,
      source,
      supported: osState.supported,
      osMeta: osState.meta,
      osCtrl: osState.ctrl,
      osAlt: osState.alt,
      osShift: osState.shift,
    },
    600,
  );
}

/** Privacy-safe terminal IME / paste recovery telemetry (never logs text contents). */
export function trackTerminalImeEvent(
  event: "rescue_xpc" | "rescue_comp" | "paste_dedup" | "stuck_cleared",
  meta: Record<string, number | string | boolean>,
): void {
  const level: LogLevel = event === "rescue_comp" || event === "rescue_xpc" ? "info" : "debug";
  emitThrottled(`ime:${event}`, level, "term", `term.ime.${event}`, meta, 800);
}

/** Warns when an active terminal's PTY grid jumps unexpectedly without user resize drag. */
export function trackTerminalLayoutJump(meta: {
  prevCols: number;
  prevRows: number;
  cols: number;
  rows: number;
  deltaCols: number;
  deltaRows: number;
  mode: string;
}): void {
  emitThrottled("term:layout_jump", "warn", "term", "term.layout.jump", meta, 1_500);
}

/** Stateful detector for rapid unintended window focus/blur oscillation (e.g. non-panel steals). */
export class FocusFlipTracker {
  private readonly transitionTimestamps: number[] = [];
  private lastWarnAt: number | null = null;

  recordBlurOrFlip(now = Date.now()): boolean {
    this.transitionTimestamps.push(now);
    const cutoff = now - FOCUS_FLIP_WINDOW_MS;
    while (this.transitionTimestamps.length > 0 && this.transitionTimestamps[0]! < cutoff) {
      this.transitionTimestamps.shift();
    }
    if (
      this.transitionTimestamps.length >= FOCUS_FLIP_WARN_THRESHOLD &&
      (this.lastWarnAt === null || now - this.lastWarnAt >= FOCUS_FLIP_WINDOW_MS)
    ) {
      this.lastWarnAt = now;
      return true;
    }
    return false;
  }

  recentCount(now = Date.now()): number {
    const cutoff = now - FOCUS_FLIP_WINDOW_MS;
    while (this.transitionTimestamps.length > 0 && this.transitionTimestamps[0]! < cutoff) {
      this.transitionTimestamps.shift();
    }
    return this.transitionTimestamps.length;
  }
}

/**
 * Tracks window focus/blur & rapid focus-steal oscillation without logging sensitive UI titles.
 */
export function installWindowFocusTelemetry(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const tracker = new FocusFlipTracker();
  let blurCount = 0;
  let lastState = document.hasFocus();

  const onFocusChange = (focused: boolean, via: "focus" | "blur" | "visibility") => {
    if (focused === lastState && via !== "visibility") return;
    lastState = focused;
    if (!focused) {
      blurCount += 1;
      if (tracker.recordBlurOrFlip()) {
        log("warn", "ui", "ui.window.rapid_focus_flip", {
          flipsIn5s: tracker.recentCount(),
          blurCount,
          visibility: document.visibilityState,
        });
      }
    }
    emitThrottled(
      `winfocus:${focused}`,
      "debug",
      "ui",
      "ui.window.focus",
      {
        focused,
        via,
        visibility: document.visibilityState,
        blurCount,
      },
      1_000,
    );
  };

  const onFocus = () => onFocusChange(true, "focus");
  const onBlur = () => onFocusChange(false, "blur");
  const onVisibility = () => onFocusChange(!document.hidden && document.hasFocus(), "visibility");

  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

export function resetUiTelemetryForTest(): void {
  lastEmittedAt.clear();
}
