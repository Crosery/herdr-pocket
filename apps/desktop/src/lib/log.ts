import { createStore } from "./store";
import { native } from "./native";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  /** Where it came from: "relay", "pair", "update", "ui", "chat", "term", "files"… */
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

const MAX = 2000;
const WEB_RELAY_MAX = 500;
let seq = 0;
let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export interface WebRelayLogEntry {
  ts: number;
  level: LogLevel;
  kind: string;
  msg: string;
  data?: Record<string, unknown>;
}

const WEB_RELAY_AREAS = new Set([
  "app",
  "config",
  "pair",
  "link",
  "relay",
  "perf",
  "sys",
  "h5",
  "term",
  "portal",
  "ui",
  "chat",
  "startup",
]);

function isWebRelayWorthy(level: LogLevel, scope: string): boolean {
  if (level === "warn" || level === "error") return true;
  if (level !== "info") return false;
  const area = scope.split(".")[0] ?? scope;
  return WEB_RELAY_AREAS.has(area);
}

let webRelayQueue: WebRelayLogEntry[] = [];
let webUploader: ((batch: WebRelayLogEntry[]) => Promise<boolean>) | null = null;
let webUploadTimer: ReturnType<typeof setInterval> | null = null;
let webUploading = false;

export async function flushWebRelayLogs(): Promise<void> {
  if (webUploading || !webUploader || webRelayQueue.length === 0) return;
  webUploading = true;
  try {
    while (webRelayQueue.length > 0 && webUploader) {
      const batch = webRelayQueue.splice(0, 200);
      const ok = await webUploader(batch).catch(() => false);
      if (!ok) {
        webRelayQueue.unshift(...batch);
        if (webRelayQueue.length > WEB_RELAY_MAX) {
          webRelayQueue.splice(0, webRelayQueue.length - WEB_RELAY_MAX);
        }
        break;
      }
    }
  } finally {
    webUploading = false;
  }
}

export function registerWebLogUploader(fn: ((batch: WebRelayLogEntry[]) => Promise<boolean>) | null): void {
  webUploader = fn;
  if (fn && !webUploadTimer && typeof window !== "undefined") {
    webUploadTimer = setInterval(() => {
      void flushWebRelayLogs();
    }, 30_000);
  }
  if (fn && webRelayQueue.length > 0) {
    void flushWebRelayLogs();
  }
}

export const logStore = createStore<{ entries: LogEntry[] }>({ entries: [] });

/**
 * The same rules, in the same order, as the native redactor (src-tauri/src/redact.rs `rules()`),
 * so the in-app log view, "copy" and the web/HarmonyOS builds hide what the log files hide.
 * Auth schemes run first: otherwise "Authorization: Bearer <t>" would mask only the word "Bearer".
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/\bhp_[A-Za-z0-9_-]{8,}/g, "hp_***"],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\bAIza[0-9A-Za-z_-]{16,}/g, "AIza***"],
  [/\b(?:ghp|gho|github_pat|xox[baprs])_[0-9A-Za-z_-]{8,}/g, "***"],
  // Cookie headers keep only their name, to the end of the line.
  [/\b((?:set-)?cookie\s*:\s*)[^\r\n]+/gim, "$1***"],
  [/([?&#](?:token|key|api_key|apikey|secret|password|code|sig|signature|auth)=)[^&\s"']+/gi, "$1***"],
  [
    /("?\b(?:token|deviceToken|accessToken|refreshToken|apiKey|api_key|secret|password|passwd|authorization|adminToken|cookie|cookies|pairCode|encrypted_value)"?\s*[:=]\s*"?)[^"\s,}&]{4,}/gi,
    "$1***",
  ],
  // Invite and join links carry the one-time secret in the path.
  [/(\/[pj]\/)[A-Za-z0-9_-]{4,}/g, "$1***"],
  // Pair codes such as MEOW-4821.
  [/\b[A-Z]{4}-\d{4}\b/g, "****-****"],
];

const SECRET_KEY_RE = /^(?:.*(?:token|secret|password|passwd|cookie|authorization|apikey|api_key|paircode|auth|pin).*|code)$/i;

/** Strips anything that looks like a credential or home username before a line is kept, shown, copied or written. */
export function redact(text: string): string {
  let out = text
    .replace(/\/Users\/[^/\s"'`]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~");
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

/** Sanitizes structured log telemetry so secrets, paths, and raw stacks stay bounded and safe. */
export function sanitizeLogData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, raw] of Object.entries(data)) {
    if (count >= 24) break;
    if (raw === undefined) continue;
    count += 1;
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "***";
      continue;
    }
    if (typeof raw === "string") {
      out[k] = redact(raw).slice(0, 360);
    } else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      out[k] = raw;
    } else {
      try {
        out[k] = redact(JSON.stringify(raw)).slice(0, 360);
      } catch {
        out[k] = redact(String(raw)).slice(0, 160);
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// The desktop app's native side owns the log files and the upload to the relay
// (src-tauri/src/logging.rs, relaylog.rs): lines are handed over in small batches.
function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = pending;
  pending = [];
  if (batch.length) {
    for (const e of batch) {
      void native.writeLog(e.level, e.scope, e.msg, e.data);
    }
  }
  if (!native.available()) {
    void flushWebRelayLogs();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

export function log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
  const cleanData = sanitizeLogData(data);
  const entry: LogEntry = {
    id: ++seq,
    ts: Date.now(),
    level,
    scope,
    msg: redact(msg).slice(0, 2000),
    ...(cleanData ? { data: cleanData } : {}),
  };
  logStore.set((prev) => {
    const entries = prev.entries.length >= MAX ? prev.entries.slice(-(MAX - 1)) : prev.entries.slice();
    entries.push(entry);
    return { entries };
  });
  pending.push(entry);
  if (!native.available() && isWebRelayWorthy(level, scope)) {
    webRelayQueue.push({
      ts: entry.ts,
      level,
      kind: scope.slice(0, 40) || "web",
      msg: entry.msg.slice(0, 500),
      ...(cleanData ? { data: cleanData } : {}),
    });
    if (webRelayQueue.length > WEB_RELAY_MAX) {
      webRelayQueue.splice(0, webRelayQueue.length - WEB_RELAY_MAX);
    }
  }
  if (level === "warn" || level === "error") {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    queueMicrotask(flush);
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, 400);
  }
  if (level === "error") console.error(`[${scope}] ${entry.msg}`);
}

export const logger = {
  debug: (scope: string, msg: string, data?: Record<string, unknown>) => log("debug", scope, msg, data),
  info: (scope: string, msg: string, data?: Record<string, unknown>) => log("info", scope, msg, data),
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => log("warn", scope, msg, data),
  error: (scope: string, msg: string, data?: Record<string, unknown>) => log("error", scope, msg, data),
};

export function logAction(scope: string, action: string, data?: Record<string, unknown>): void {
  log("info", scope, action, data);
}

export function formatLogLine(e: LogEntry): string {
  const d = new Date(e.ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const t = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const extra = e.data
    ? " · " + Object.entries(e.data).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")
    : "";
  return `${t} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}${extra}`;
}
