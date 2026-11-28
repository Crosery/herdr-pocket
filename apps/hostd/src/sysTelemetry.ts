import { arch, cpus, freemem, loadavg, release, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { LogLevel } from "@herdr-pocket/protocol";

export interface HostSystemProfile {
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalRamMb: number;
  displayServer: string;
  nodeVersion: string;
}

export function detectHostDisplayServer(
  plat: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (plat === "darwin") return "quartz";
  if (plat === "win32") return "win32";
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "headless";
}

export function collectHostSystemProfile(): HostSystemProfile {
  const cpuList = cpus();
  const cpuModel = (cpuList[0]?.model ?? "unknown").trim().slice(0, 120);
  return {
    os: `${process.platform} ${release()}`,
    arch: arch(),
    cpuModel,
    cpuCores: cpuList.length || 1,
    totalRamMb: Math.round(totalmem() / (1024 * 1024)),
    displayServer: detectHostDisplayServer(),
    nodeVersion: process.version,
  };
}

export function collectHostResourcePulse(stats: { agentCount: number; activeStreams: number; directPeers: number }) {
  const mem = process.memoryUsage();
  const loads = loadavg();
  return {
    rssMb: Math.round(mem.rss / (1024 * 1024)),
    heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
    freeMemMb: Math.round(freemem() / (1024 * 1024)),
    load1m: Math.round((loads[0] ?? 0) * 100) / 100,
    agentCount: stats.agentCount,
    activeStreams: stats.activeStreams,
    directPeers: stats.directPeers,
  };
}

function roundDelayMs(ns: number): number {
  return Number.isFinite(ns) && ns > 0 ? Math.round((ns / 1e6) * 10) / 10 : 0;
}

export function startHostTelemetry(
  emit: (level: LogLevel, kind: string, msg: string, data: Record<string, unknown>) => void,
  readStats: () => { agentCount: number; activeStreams: number; directPeers: number },
  intervalMs = 60_000,
): () => void {
  const boot = collectHostSystemProfile();
  emit("info", "sys.host_boot", `hostd ${boot.os} (${boot.arch}, ${boot.displayServer})`, { ...boot });

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  const timer = setInterval(() => {
    const pulse = collectHostResourcePulse(readStats());
    const hasSamples = histogram.count > 0;
    const elMeanMs = hasSamples ? roundDelayMs(histogram.mean) : 0;
    const elP99Ms = hasSamples ? roundDelayMs(histogram.percentile(99)) : 0;
    const elMaxMs = hasSamples ? roundDelayMs(histogram.max) : 0;
    histogram.reset();
    emit("info", "sys.host_pulse", `hostd rss=${pulse.rssMb}MB load=${pulse.load1m} elP99=${elP99Ms}ms`, {
      ...pulse,
      elMeanMs,
      elP99Ms,
      elMaxMs,
    });
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
