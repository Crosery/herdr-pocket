import { createStore } from "./store";
import { native } from "./native";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  /** Where it came from: "relay", "pair", "update", "onboarding", "voice", "browser"… */
  scope: string;
  msg: string;
}

const MAX = 2000;
let seq = 0;
let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const logStore = createStore<{ entries: LogEntry[] }>({ entries: [] });

/**
 * The same rules, in the same order, as the native redactor (src-tauri/src/redact.rs `rules()`),
 * so the in-app log view, "copy" and the web/HarmonyOS builds hide what the log files hide.
 * Auth schemes run first: otherwise "Authorization: Bearer <t>" would mask only the word "Bearer".
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/\bhp_[A-Za-z0-9_-]{8,}/g, "hp_***"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
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

/** Strips anything that looks like a credential before a line is kept, shown, copied or written. */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

// The desktop app's native side owns the log files and the upload to the relay
// (src-tauri/src/logging.rs, relaylog.rs): lines are handed over in small batches.
function flush(): void {
  flushTimer = null;
  const batch = pending;
  pending = [];
  for (const e of batch) void native.writeLog(e.level, e.scope, e.msg);
}

export function log(level: LogLevel, scope: string, msg: string): void {
  const entry: LogEntry = { id: ++seq, ts: Date.now(), level, scope, msg: redact(msg).slice(0, 2000) };
  logStore.set((prev) => {
    const entries = prev.entries.length >= MAX ? prev.entries.slice(-(MAX - 1)) : prev.entries.slice();
    entries.push(entry);
    return { entries };
  });
  pending.push(entry);
  if (!flushTimer) flushTimer = setTimeout(flush, 2000);
  if (level === "error") console.error(`[${scope}] ${entry.msg}`);
}

export const logger = {
  debug: (scope: string, msg: string) => log("debug", scope, msg),
  info: (scope: string, msg: string) => log("info", scope, msg),
  warn: (scope: string, msg: string) => log("warn", scope, msg),
  error: (scope: string, msg: string) => log("error", scope, msg),
};

export function formatLogLine(e: LogEntry): string {
  const d = new Date(e.ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const t = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${t} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}`;
}
