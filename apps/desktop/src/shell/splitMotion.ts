export const SPLIT_MOTION_MS = 200;

let settledAt = 0;
let settleTimer: number | null = null;
const settledListeners = new Set<() => void>();

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
