import { activeTabIdForSpace, shellStore, tabLeaves } from "../shell/shellStore";
import { logger } from "./log";
import { allAgents, liveStore, lookupAgentByKey } from "./store";

export interface FrameStats {
  frames: number;
  sampleMs: number;
  fpsAvg: number;
  fpsMin: number;
  fpsP5: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameMaxMs: number;
  droppedFrames: number;
  jankFrames: number;
  severeFreezeFrames: number;
}

interface RpcSample {
  method: string;
  ms: number;
  direct: boolean;
  ok: boolean;
}

const RPC_SAMPLE_CAP = 2000;
const CLICK_SAMPLE_CAP = 500;
const SLOW_RPC_MS = 2000;
const SLOW_CLICK_PAINT_MS = 80;
const SLOW_RPC_EXCLUDED = new Set(["agent.create", "tools.update", "sessions.resume"]);
const STARTUP_SAMPLE_DELAY_MS = 3000;
const PERIODIC_INTERVAL_MS = 30_000;
const PERIODIC_WINDOW_MS = 5000;
const SPLIT_WINDOW_MS = 1200;

let webglCountProvider: () => number = () => 0;
let mountedTabsCountProvider: (() => number) | null = null;
let started = false;
let rpcSamples: RpcSample[] = [];
let clickPaintSamples: number[] = [];
let longTasks = 0;
let longTaskMaxMs = 0;
let splitSamplerCancel: (() => void) | null = null;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function quantile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx]!;
}

/** Computes FPS and frame-time percentiles from inter-frame `requestAnimationFrame` deltas in milliseconds. */
export function computeFrameStats(deltasMs: readonly number[]): FrameStats {
  const valid = deltasMs.filter((d) => Number.isFinite(d) && d > 0);
  if (valid.length === 0) {
    return {
      frames: 0,
      sampleMs: 0,
      fpsAvg: 0,
      fpsMin: 0,
      fpsP5: 0,
      frameP50Ms: 0,
      frameP95Ms: 0,
      frameMaxMs: 0,
      droppedFrames: 0,
      jankFrames: 0,
      severeFreezeFrames: 0,
    };
  }
  let sum = 0;
  let droppedFrames = 0;
  let jankFrames = 0;
  let severeFreezeFrames = 0;
  for (const d of valid) {
    sum += d;
    if (d > 25) droppedFrames += 1;
    if (d > 33.4) jankFrames += 1;
    if (d >= 100) severeFreezeFrames += 1;
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const frameP50Ms = round1(quantile(sorted, 0.5));
  const frameP95Ms = round1(quantile(sorted, 0.95));
  const frameMaxMs = round1(sorted[sorted.length - 1]!);
  return {
    frames: valid.length,
    sampleMs: Math.round(sum),
    fpsAvg: round1((valid.length * 1000) / Math.max(1, sum)),
    fpsMin: round1(1000 / Math.max(1, frameMaxMs)),
    fpsP5: round1(1000 / Math.max(1, frameP95Ms)),
    frameP50Ms,
    frameP95Ms,
    frameMaxMs,
    droppedFrames,
    jankFrames,
    severeFreezeFrames,
  };
}

/** Registers the active WebGL terminal renderer count reader cleanly without import cycles. */
export function registerWebglCounter(reader: () => number): void {
  webglCountProvider = reader;
}

/** Registers the mounted shell tab count reader cleanly without import cycles. */
export function registerMountedTabsCounter(reader: (() => number) | null): void {
  mountedTabsCountProvider = reader;
}

/** Records a click-to-next-animation-frame latency sample and warns when visible click paint exceeds 80ms. */
export function recordClickPaintSample(paintMs: number, label: string): void {
  if (!Number.isFinite(paintMs) || paintMs < 0) return;
  clickPaintSamples.push(paintMs);
  if (clickPaintSamples.length > CLICK_SAMPLE_CAP) {
    clickPaintSamples.splice(0, clickPaintSamples.length - CLICK_SAMPLE_CAP);
  }
  if (paintMs > SLOW_CLICK_PAINT_MS) {
    logger.warn("perf.click", `slow click paint (${Math.round(paintMs)}ms)`, {
      ms: Math.round(paintMs),
      label: label.slice(0, 64),
    });
  }
}

/** Records a client RPC completion for periodic summary stats and immediate slow-RPC warnings. */
export function recordClientRpcSample(method: string, ms: number, viaDirect: boolean, ok: boolean): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  rpcSamples.push({ method, ms, direct: viaDirect, ok });
  if (rpcSamples.length > RPC_SAMPLE_CAP) {
    rpcSamples.splice(0, rpcSamples.length - RPC_SAMPLE_CAP);
  }
  if (ms > SLOW_RPC_MS && !SLOW_RPC_EXCLUDED.has(method)) {
    logger.warn("perf.rpc", `slow rpc ${method}`, {
      method,
      ms: Math.round(ms),
      direct: viaDirect,
      ok,
    });
  }
}

export function resetPerfTelemetryForTest(): void {
  rpcSamples = [];
  clickPaintSamples = [];
  longTasks = 0;
  longTaskMaxMs = 0;
}

function summarizeClickWindow(): Record<string, unknown> {
  const batch = clickPaintSamples;
  clickPaintSamples = [];
  if (batch.length === 0) {
    return { clickCount: 0 };
  }
  const sorted = [...batch].sort((a, b) => a - b);
  return {
    clickCount: batch.length,
    clickP50Ms: round1(quantile(sorted, 0.5)),
    clickMaxMs: round1(sorted[sorted.length - 1]!),
  };
}

function summarizeRpcWindow(): Record<string, unknown> {
  const batch = rpcSamples;
  rpcSamples = [];
  if (batch.length === 0) {
    return { rpcCount: 0, rpcErrors: 0 };
  }
  const sortedMs = batch.map((s) => s.ms).sort((a, b) => a - b);
  let totalMs = 0;
  let directCount = 0;
  let errorCount = 0;
  let slowest = batch[0]!;
  for (const s of batch) {
    totalMs += s.ms;
    if (s.direct) directCount += 1;
    if (!s.ok) errorCount += 1;
    if (s.ms > slowest.ms) slowest = s;
  }
  return {
    rpcCount: batch.length,
    rpcDirectRatio: Math.round((directCount / batch.length) * 100) / 100,
    rpcAvgMs: round1(totalMs / batch.length),
    rpcP95Ms: round1(quantile(sortedMs, 0.95)),
    rpcMaxMs: Math.round(slowest.ms),
    slowestRpc: slowest.method,
    rpcErrors: errorCount,
  };
}

function collectShellContext(): Record<string, unknown> {
  const shell = shellStore.get();
  const live = liveStore.get();
  const all = allAgents(live.agents);
  const byKey = new Map(all.map((a) => [a.key, a] as const));
  const lookup = (k: string) => byKey.get(k);
  const activeTabId = activeTabIdForSpace(shell, lookup, live.spaces);
  const activeTab = shell.tabs.find((t) => t.id === activeTabId) ?? null;
  const leaves = activeTab ? tabLeaves(activeTab) : [];
  let termPanes = 0;
  let chatPanes = 0;
  for (const leaf of leaves) {
    if (leaf.content.kind !== "agent") continue;
    const ag = lookupAgentByKey(live.agents, leaf.content.agentKey);
    const mode = leaf.content.mode ?? (ag?.isShell ? "term" : "chat");
    if (mode === "term") termPanes += 1;
    else chatPanes += 1;
  }
  const workingAgents = all.filter((a) => a.status === "working").length;
  return {
    isSplit: leaves.length > 1,
    splitPanes: leaves.length,
    termPanes,
    chatPanes,
    webglTerminals: webglCountProvider(),
    mountedTabs: mountedTabsCountProvider ? mountedTabsCountProvider() : Math.min(shell.tabs.length, 6),
    totalTabs: shell.tabs.length,
    totalAgents: all.length,
    workingAgents,
    ...(typeof window !== "undefined"
      ? {
          dpr: window.devicePixelRatio || 1,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        }
      : {}),
  };
}

function sampleRafWindow(
  durationMs: number,
  onDone: (stats: FrameStats) => void,
): () => void {
  if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") {
    return () => {};
  }
  let cancelled = false;
  let rafId = 0;
  let startAt = 0;
  let prevAt = 0;
  const deltas: number[] = [];

  const cleanup = () => {
    cancelled = true;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    document.removeEventListener("visibilitychange", onHide);
  };

  const onHide = () => {
    if (document.hidden) cleanup();
  };
  document.addEventListener("visibilitychange", onHide);

  const step = (now: number) => {
    if (cancelled) return;
    if (document.visibilityState !== "visible") {
      cleanup();
      return;
    }
    if (startAt === 0) {
      startAt = now;
      prevAt = now;
      rafId = requestAnimationFrame(step);
      return;
    }
    deltas.push(now - prevAt);
    prevAt = now;
    if (now - startAt >= durationMs) {
      cleanup();
      onDone(computeFrameStats(deltas));
      return;
    }
    rafId = requestAnimationFrame(step);
  };

  rafId = requestAnimationFrame(step);
  return cleanup;
}

function isLowFpsStats(stats: FrameStats): boolean {
  return (stats.frames > 0 && stats.fpsAvg < 40) || stats.frameP95Ms > 34 || stats.severeFreezeFrames >= 2;
}

/** Captures a 1.2s RAF window across split open/close/sash drag transitions and emits `perf.split`. */
export function reportSplitTransitionPerf(trigger: "open" | "close" | "sash", panes: number): void {
  if (typeof window === "undefined" || typeof document === "undefined" || document.visibilityState !== "visible") {
    return;
  }
  splitSamplerCancel?.();
  splitSamplerCancel = sampleRafWindow(SPLIT_WINDOW_MS, (stats) => {
    splitSamplerCancel = null;
    if (stats.frames === 0) return;
    const warn = isLowFpsStats(stats);
    const data = {
      trigger,
      panes,
      ...stats,
      webglTerminals: webglCountProvider(),
    };
    if (warn) logger.warn("perf.split", `split transition slow (${trigger}, ${stats.fpsAvg} fps)`, data);
    else logger.info("perf.split", `split transition (${trigger}, ${stats.fpsAvg} fps)`, data);
  });
}

/** Starts periodic client FPS, long-task, and RPC latency telemetry when the window is visible. */
export function startDesktopPerfTelemetry(): () => void {
  if (started || typeof window === "undefined") return () => {};
  started = true;

  const nav = navigator as Navigator & { deviceMemory?: number };
  logger.info("sys.info", "web client profile", {
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency || undefined,
    memoryGb: nav.deviceMemory || undefined,
  });

  let longTaskObserver: PerformanceObserver | null = null;
  if (typeof PerformanceObserver === "function") {
    try {
      const supported = PerformanceObserver.supportedEntryTypes ?? [];
      if (supported.includes("longtask")) {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks += 1;
            if (entry.duration > longTaskMaxMs) longTaskMaxMs = Math.round(entry.duration);
          }
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });
      }
    } catch {
      longTaskObserver = null;
    }
  }

  let activeWindowCancel: (() => void) | null = null;
  const runSample = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    activeWindowCancel?.();
    activeWindowCancel = sampleRafWindow(PERIODIC_WINDOW_MS, (stats) => {
      activeWindowCancel = null;
      if (stats.frames === 0) return;
      const ltCount = longTasks;
      const ltMax = longTaskMaxMs;
      longTasks = 0;
      longTaskMaxMs = 0;
      const payload = {
        ...stats,
        longTasks: ltCount,
        longTaskMaxMs: ltMax,
        ...collectShellContext(),
        ...summarizeRpcWindow(),
        ...summarizeClickWindow(),
      };
      if (isLowFpsStats(stats)) {
        logger.warn("perf.fps", `low client fps (${stats.fpsAvg} fps, p95 ${stats.frameP95Ms}ms)`, payload);
      } else {
        logger.info("perf.fps", `client fps ${stats.fpsAvg} (p95 ${stats.frameP95Ms}ms)`, payload);
      }
    });
  };

  const startupTimer = window.setTimeout(runSample, STARTUP_SAMPLE_DELAY_MS);
  const intervalTimer = window.setInterval(runSample, PERIODIC_INTERVAL_MS);

  return () => {
    started = false;
    window.clearTimeout(startupTimer);
    window.clearInterval(intervalTimer);
    activeWindowCancel?.();
    activeWindowCancel = null;
    splitSamplerCancel?.();
    splitSamplerCancel = null;
    longTaskObserver?.disconnect();
    longTaskObserver = null;
  };
}
