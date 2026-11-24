import { AppState, Dimensions, PixelRatio, Platform } from "react-native";
import { applog } from "./applog";

const STARTUP_DELAY_MS = 3500;
const INTERVAL_MS = 30_000;
const WINDOW_MS = 4000;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function summarize(deltas: readonly number[]) {
  if (deltas.length === 0) return null;
  let sum = 0;
  let jank = 0;
  let severe = 0;
  for (const d of deltas) {
    sum += d;
    if (d > 33.4) jank += 1;
    if (d >= 100) severe += 1;
  }
  const sorted = [...deltas].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;
  const fpsAvg = round1((deltas.length * 1000) / Math.max(1, sum));
  return {
    frames: deltas.length,
    sampleMs: Math.round(sum),
    fpsAvg,
    fpsP5: round1(1000 / Math.max(1, p95)),
    frameP95Ms: round1(p95),
    frameMaxMs: round1(max),
    jankFrames: jank,
    severeFreezeFrames: severe,
  };
}

let started = false;

/** Reports mobile boot specs + periodic foreground RAF FPS metrics to Relay logs. */
export function startMobilePerfTelemetry(): () => void {
  if (started) return () => {};
  started = true;

  const win = Dimensions.get("window");
  applog("info", "sys.mobile_boot", "mobile device profile", {
    os: Platform.OS,
    osVersion: String(Platform.Version),
    viewport: `${Math.round(win.width)}x${Math.round(win.height)}`,
    dpr: PixelRatio.get(),
  });

  let activeRaf = 0;
  let stateSub: { remove(): void } | null = null;
  let appState = AppState.currentState;

  const cancelSample = () => {
    if (activeRaf) {
      cancelAnimationFrame(activeRaf);
      activeRaf = 0;
    }
  };

  const runSample = () => {
    if (appState !== "active" || typeof requestAnimationFrame !== "function") return;
    cancelSample();
    let startAt = 0;
    let prevAt = 0;
    const deltas: number[] = [];
    const step = (now: number) => {
      if (appState !== "active") {
        activeRaf = 0;
        return;
      }
      if (startAt === 0) {
        startAt = now;
        prevAt = now;
        activeRaf = requestAnimationFrame(step);
        return;
      }
      deltas.push(now - prevAt);
      prevAt = now;
      if (now - startAt >= WINDOW_MS) {
        activeRaf = 0;
        const stats = summarize(deltas);
        if (stats) {
          const low = stats.fpsAvg < 40 || stats.frameP95Ms > 34 || stats.severeFreezeFrames >= 2;
          applog(
            low ? "warn" : "info",
            "perf.fps",
            low ? `low mobile fps (${stats.fpsAvg} fps)` : `mobile fps ${stats.fpsAvg}`,
            stats,
          );
        }
        return;
      }
      activeRaf = requestAnimationFrame(step);
    };
    activeRaf = requestAnimationFrame(step);
  };

  stateSub = AppState.addEventListener("change", (next) => {
    appState = next;
    if (next !== "active") cancelSample();
  });

  const startupTimer = setTimeout(runSample, STARTUP_DELAY_MS);
  const intervalTimer = setInterval(runSample, INTERVAL_MS);

  return () => {
    started = false;
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
    cancelSample();
    stateSub?.remove();
  };
}
