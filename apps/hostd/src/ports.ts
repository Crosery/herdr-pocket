import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agent, AgentListeningPort } from "@herdr-pocket/protocol";

const execFileAsync = promisify(execFile);

export interface PortTerminalRef {
  address: string;
  pid?: number;
  cwd?: string | null;
  foreground?: { pid?: number; cwd?: string | null } | null;
}

export interface RawListener {
  pid: number;
  processName: string;
  host: string;
  port: number;
}

export interface PortScannerDeps {
  platform?: NodeJS.Platform;
  listListeners?: () => Promise<RawListener[]>;
  listProcessParents?: () => Promise<Map<number, { ppid: number; name: string }>>;
  probeHttp?: (host: string, port: number) => Promise<{ protocol: "http" | "tcp"; title?: string }>;
  killPid?: (pid: number) => void;
  selfPid?: number;
  excludedPorts?: ReadonlySet<number>;
}

const MAX_HOPS = 16;
const PROBE_CACHE_TTL_MS = 25_000;
const IGNORED_PROCS = new Set([
  "rapportd",
  "controlcenter",
  "airplayxpchelper",
  "sharingd",
  "identityservicesd",
  "sshd",
  "mDNSResponder".toLowerCase(),
  "systemd-resolved",
  "uniflo",
  "herdr",
  "herdr-app",
  "hc",
  "ego lite",
  "ego helper",
  "herdr pocket",
  "herdr-pocket",
]);

const probeCache = new Map<string, { at: number; protocol: "http" | "tcp"; title?: string }>();

export function clearPortProbeCacheForTest(): void {
  probeCache.clear();
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` machine-readable output. */
export function parseLsofListeners(stdout: string): RawListener[] {
  const out: RawListener[] = [];
  const seen = new Set<string>();
  let pid = 0;
  let cmd = "";
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    const tag = rawLine[0];
    const val = rawLine.slice(1).trim();
    if (tag === "p") {
      pid = Number.parseInt(val, 10) || 0;
      cmd = "";
    } else if (tag === "c") {
      cmd = val;
    } else if (tag === "n" && pid > 0) {
      const m = /^(.+):(\d+)$/.exec(val);
      if (!m) continue;
      const port = Number.parseInt(m[2]!, 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
      let host = m[1]!.replace(/^\[|\]$/g, "");
      if (host === "*" || host === "0.0.0.0" || host === "::" || host === "::1") host = "127.0.0.1";
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pid, processName: cmd || "proc", host, port });
    }
  }
  return out;
}

/** Parses Linux `ss -lntpH` output as fallback when `lsof` is absent. */
export function parseSsListeners(stdout: string): RawListener[] {
  const out: RawListener[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const m = /^(.+):(\d+)$/.exec(local);
    if (!m) continue;
    const port = Number.parseInt(m[2]!, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
    const usersPart = cols.slice(5).join(" ");
    const pidMatch = /"([^"]+)",pid=(\d+)/.exec(usersPart);
    if (!pidMatch) continue;
    const processName = pidMatch[1] || "proc";
    const pid = Number.parseInt(pidMatch[2]!, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    let host = m[1]!.replace(/^\[|\]$/g, "");
    if (host === "*" || host === "0.0.0.0" || host === "::" || host === "::1") host = "127.0.0.1";
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, processName, host, port });
  }
  return out;
}

/** Parses Windows `netstat -ano -p tcp` output (`LISTENING` lines). */
export function parseWinNetstatListeners(stdout: string, procs?: Map<number, { ppid: number; name: string }>): RawListener[] {
  const out: RawListener[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^TCP\s+/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 5 || !/^LISTENING$/i.test(cols[3]!)) continue;
    const m = /^(.+):(\d+)$/.exec(cols[1]!);
    if (!m) continue;
    const port = Number.parseInt(m[2]!, 10);
    const pid = Number.parseInt(cols[4]!, 10);
    if (!Number.isFinite(port) || port <= 0 || !Number.isFinite(pid) || pid <= 0) continue;
    let host = m[1]!.replace(/^\[|\]$/g, "");
    if (host === "*" || host === "0.0.0.0" || host === "::" || host === "::1") host = "127.0.0.1";
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, processName: procs?.get(pid)?.name || "proc", host, port });
  }
  return out;
}

export async function defaultListProcessParents(plat: NodeJS.Platform = process.platform): Promise<Map<number, { ppid: number; name: string }>> {
  const map = new Map<number, { ppid: number; name: string }>();
  if (plat === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }"],
        { timeout: 2500, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      );
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const pid = Number.parseInt(m[1]!, 10);
        const ppid = Number.parseInt(m[2]!, 10);
        if (pid > 0) map.set(pid, { ppid, name: m[3]!.replace(/\.exe$/i, "") });
      }
    } catch {
      // ignore
    }
    return map;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,comm="], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
    for (const line of stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number.parseInt(m[1]!, 10);
      const ppid = Number.parseInt(m[2]!, 10);
      const name = m[3]!.split("/").pop() || m[3]!;
      if (pid > 0) map.set(pid, { ppid, name });
    }
  } catch {
    // ignore
  }
  return map;
}

export async function defaultListListeners(
  plat: NodeJS.Platform = process.platform,
  procs?: Map<number, { ppid: number; name: string }>,
): Promise<RawListener[]> {
  if (plat === "win32") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { timeout: 2500, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      return parseWinNetstatListeners(stdout, procs);
    } catch {
      return [];
    }
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
    return parseLsofListeners(stdout);
  } catch {
    if (plat === "linux") {
      try {
        const { stdout } = await execFileAsync("ss", ["-lntpH"], { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
        return parseSsListeners(stdout);
      } catch {
        return [];
      }
    }
    return [];
  }
}

export function extractHtmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html);
  if (!m?.[1]) return undefined;
  const cleaned = m[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

export async function defaultProbeHttp(host: string, port: number): Promise<{ protocol: "http" | "tcp"; title?: string }> {
  const probeHost = host === "0.0.0.0" || host === "::" || host === "*" ? "127.0.0.1" : host;
  const url = `http://${probeHost.includes(":") ? `[${probeHost}]` : probeHost}:${port}/`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 550);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { accept: "text/html,application/json;q=0.8,*/*;q=0.5" },
    });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    let title: string | undefined;
    if (ct.includes("html") || ct.includes("xml") || !ct) {
      const reader = res.body?.getReader();
      if (reader) {
        let text = "";
        let readBytes = 0;
        const dec = new TextDecoder();
        while (readBytes < 16_384) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          readBytes += value.byteLength;
          text += dec.decode(value, { stream: true });
          if (/<\/title>/i.test(text)) break;
        }
        reader.cancel().catch(() => {});
        title = extractHtmlTitle(text);
      }
    } else if (ct.includes("json")) {
      title = "JSON API";
    }
    return { protocol: "http", ...(title ? { title } : {}) };
  } catch {
    return { protocol: "tcp" };
  } finally {
    clearTimeout(timer);
  }
}

function isExcludedListener(l: RawListener, selfPid: number, excludedPorts?: ReadonlySet<number>): boolean {
  if (l.pid === selfPid) return true;
  if (excludedPorts?.has(l.port)) return true;
  const nameLower = l.processName.trim().toLowerCase();
  if (IGNORED_PROCS.has(nameLower)) return true;
  return false;
}

/**
 * Attributes listening TCP ports strictly to their owning Agent terminal process trees.
 */
export async function scanAgentListeningPorts(
  agents: readonly Agent[],
  terminals: ReadonlyMap<string, PortTerminalRef>,
  deps: PortScannerDeps = {},
): Promise<Map<string, AgentListeningPort[]>> {
  const result = new Map<string, AgentListeningPort[]>();
  if (agents.length === 0 || terminals.size === 0) return result;

  const plat = deps.platform ?? process.platform;
  const selfPid = deps.selfPid ?? process.pid;

  const pidToAgent = new Map<number, Agent>();
  for (const agent of agents) {
    const t = terminals.get(agent.localId);
    if (!t) continue;
    if (t.foreground?.pid && t.foreground.pid > 1) pidToAgent.set(t.foreground.pid, agent);
    if (t.pid && t.pid > 1) pidToAgent.set(t.pid, agent);
  }
  if (pidToAgent.size === 0) return result;

  const procs = await (deps.listProcessParents ? deps.listProcessParents() : defaultListProcessParents(plat));
  const rawListeners = await (deps.listListeners ? deps.listListeners() : defaultListListeners(plat, procs));
  if (rawListeners.length === 0) return result;

  const matched: Array<{ agent: Agent; listener: RawListener }> = [];
  const seenAgentPort = new Set<string>();

  for (const listener of rawListeners) {
    if (isExcludedListener(listener, selfPid, deps.excludedPorts)) continue;
    let cur = listener.pid;
    let owner: Agent | undefined;
    const visited = new Set<number>();
    for (let hop = 0; hop < MAX_HOPS && cur > 1 && !visited.has(cur); hop += 1) {
      visited.add(cur);
      const hit = pidToAgent.get(cur);
      if (hit) {
        owner = hit;
        break;
      }
      const p = procs.get(cur);
      if (!p || !p.ppid || p.ppid === cur) break;
      cur = p.ppid;
    }
    if (!owner) continue;
    const dedup = `${owner.key}:${listener.port}`;
    if (seenAgentPort.has(dedup)) continue;
    seenAgentPort.add(dedup);
    matched.push({ agent: owner, listener });
  }

  if (matched.length === 0) return result;

  const probe = deps.probeHttp ?? defaultProbeHttp;
  const now = Date.now();
  await Promise.all(
    matched.map(async ({ agent, listener }) => {
      const cacheKey = `${listener.pid}:${listener.host}:${listener.port}`;
      let info = probeCache.get(cacheKey);
      if (!info || now - info.at > PROBE_CACHE_TTL_MS) {
        const probed: { protocol: "http" | "tcp"; title?: string } = await probe(listener.host, listener.port).catch(() => ({ protocol: "tcp" as const }));
        info = { at: Date.now(), protocol: probed.protocol, ...(probed.title ? { title: probed.title } : {}) };
        probeCache.set(cacheKey, info);
      }
      const url =
        info.protocol === "http"
          ? `http://${listener.host === "127.0.0.1" ? "localhost" : listener.host}:${listener.port}`
          : undefined;
      const entry: AgentListeningPort = {
        port: listener.port,
        pid: listener.pid,
        processName: listener.processName,
        host: listener.host,
        protocol: info.protocol,
        ...(info.title ? { title: info.title } : {}),
        ...(url ? { url } : {}),
      };
      const arr = result.get(agent.key) ?? [];
      arr.push(entry);
      result.set(agent.key, arr);
    }),
  );

  for (const arr of result.values()) {
    arr.sort((a, b) => a.port - b.port);
  }
  return result;
}

/** Stops a listening child process only after verifying it belongs to the target agent's process tree. */
export async function stopAgentListeningPort(
  agent: Agent,
  pid: number,
  port: number,
  terminals: ReadonlyMap<string, PortTerminalRef>,
  deps: PortScannerDeps = {},
): Promise<AgentListeningPort[]> {
  const scanned = await scanAgentListeningPorts([agent], terminals, deps);
  const owned = scanned.get(agent.key) ?? [];
  const target = owned.find((p) => p.pid === pid && p.port === port);
  if (!target) {
    throw new Error(`端口 :${port} 不属于当前会话或已停止`);
  }
  const killFn = deps.killPid ?? ((p: number) => process.kill(p, "SIGTERM"));
  try {
    killFn(target.pid);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ESRCH") throw err;
  }
  probeCache.delete(`${target.pid}:${target.host}:${target.port}`);
  return owned.filter((p) => !(p.pid === target.pid && p.port === target.port));
}
