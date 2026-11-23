import { settingsStore } from "./store";

const CHIME_COOLDOWN_MS = 1800;
const LONG_TASK_MS = 45_000;

let lastChimeAt = 0;
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/**
 * Plays a gentle two-note desktop chime for background agent attention events
 * (`blocked` always chimes when enabled; `done` chimes when elapsed >= 45s or `alertChimeOnlyLongTasks` is off).
 */
export function playAttentionChime(kind: "blocked" | "done", elapsedMs = 0): void {
  const { notifications, alertSound, alertChimeOnlyLongTasks } = settingsStore.get();
  if (!notifications || !alertSound) return;
  if (kind === "done" && alertChimeOnlyLongTasks && elapsedMs < LONG_TASK_MS) return;

  const now = Date.now();
  if (now - lastChimeAt < CHIME_COOLDOWN_MS) return;
  lastChimeAt = now;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    const base = ctx.currentTime + 0.015;
    const notes = kind === "blocked" ? [587.33, 880] : [523.25, 659.25];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, base + idx * 0.09);
      gain.gain.setValueAtTime(0.0001, base + idx * 0.09);
      gain.gain.exponentialRampToValueAtTime(kind === "blocked" ? 0.045 : 0.032, base + idx * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, base + idx * 0.09 + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(base + idx * 0.09);
      osc.stop(base + idx * 0.09 + 0.26);
    });
  } catch {
    // Audio playback can fail on headless/restricted webviews; ignore silently.
  }
}
