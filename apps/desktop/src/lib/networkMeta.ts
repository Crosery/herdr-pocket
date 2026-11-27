import type { DirectHostMeta } from "./store";

export interface TransportBadgeInfo {
  via: "direct" | "relay";
  label: string;
  shortLabel: string;
  tone: "mint" | "lav" | "neutral";
  addr?: string;
}

export interface LatencyQualityInfo {
  label: string;
  tone: "mint" | "lav" | "pink" | "neutral";
  level: "good" | "warn" | "high" | "unknown";
}

/** Describes how this client currently reaches a host (local loopback, LAN/VPN/WebRTC P2P, or relay). */
export function describeHostTransport(
  directAddr: string | undefined,
  meta: DirectHostMeta | undefined,
): TransportBadgeInfo {
  if (directAddr) {
    const kind = meta?.linkKind;
    if (kind === "local" || directAddr === "127.0.0.1" || directAddr === "localhost" || directAddr === "::1") {
      return { via: "direct", label: "本地直连", shortLabel: "本地", tone: "mint", addr: directAddr };
    }
    if (kind === "lan-p2p") {
      return { via: "direct", label: "局域网直连", shortLabel: "局域网", tone: "mint", addr: directAddr };
    }
    if (kind === "vpn-p2p") {
      return { via: "direct", label: "VPN 直连", shortLabel: "VPN", tone: "mint", addr: directAddr };
    }
    if (kind === "webrtc-p2p" || /webrtc/i.test(directAddr)) {
      return { via: "direct", label: "WebRTC P2P", shortLabel: "P2P", tone: "lav", addr: directAddr };
    }
    return { via: "direct", label: "直连", shortLabel: "直连", tone: "mint", addr: directAddr };
  }
  return { via: "relay", label: "中继转发", shortLabel: "中继", tone: "neutral" };
}

/** Classifies RTT latency into clean UI quality tiers. */
export function classifyLatency(ms: number | null | undefined): LatencyQualityInfo {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return { label: "待测速", tone: "neutral", level: "unknown" };
  }
  if (ms <= 80) {
    return { label: "流畅", tone: "mint", level: "good" };
  }
  if (ms <= 220) {
    return { label: "一般", tone: "lav", level: "warn" };
  }
  return { label: "偏高", tone: "pink", level: "high" };
}

/** Turns raw direct-probe error strings into concise user-readable Chinese diagnostics. */
export function summarizeDirectError(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  if (/native tunnel unavailable|dial timed out|connect error/i.test(s)) {
    return "直连通道暂不可达（跨网段或未通 VPN），已自动走中继转发";
  }
  if (/WebRTC|DataChannel/i.test(s)) {
    return "WebRTC P2P 打洞未通，已自动走中继转发";
  }
  if (/连接断开|久久没有响应|timeout/i.test(s)) {
    return "直连探测超时，已自动走中继转发";
  }
  return s.length > 56 ? `${s.slice(0, 55)}…` : s;
}

/** Simple semver comparison (`a < b` => negative) for showing gentle hostd upgrade cues. */
export function isOlderVersion(hostVer: string | undefined, appVer: string | undefined): boolean {
  if (!hostVer || !appVer) return false;
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10));
  const a = parse(hostVer);
  const b = parse(appVer);
  if (a.length < 3 || b.length < 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
}
