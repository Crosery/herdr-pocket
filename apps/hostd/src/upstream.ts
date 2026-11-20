/**
 * Newer releases of the programs a host depends on: herdr-core (hc), the Herdr desktop app and
 * Uniflo. Report only: nothing here installs or updates anything.
 *
 * - hc: `<releases>/core/latest.json` ({version, generation}); offered only within the installed
 *   core's generation, as Herdr's own app does (herdr-app src/update.rs check_core).
 * - Herdr app: `<releases>/app/latest.json` ({version}), only where the app is installed.
 * - Uniflo: `uniflo update --check --json` (exit 10: a newer release), never crates.io directly.
 *
 * `<releases>` is HERDR_RELEASES_URL, like Herdr, else https://releases.herdr.dev. hostd checks a
 * few minutes after start, then about daily (`update.checkTools`, under `update.autoCheck`), and
 * keeps the answers in `<state>/upstream.json` so `herdr-pocket status` has them too.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, updateCheckDelays, type ClientConfig, type HostTools, type LogLevel, type UpstreamLatest } from "@herdr-pocket/protocol";
import { currentClientConfig, stateDir } from "@herdr-pocket/update";
import { run } from "./util.ts";

/** Per release-server request. */
export const UPSTREAM_REQUEST_MS = 4000;
/** `uniflo update --check` asks crates.io itself and may take longer. */
export const UNIFLO_CHECK_MS = 10_000;

export function releasesUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HERDR_RELEASES_URL || "https://releases.herdr.dev").replace(/\/+$/, "");
}

/** What is installed here; `hcGeneration` comes from the running core's `hello`. */
export interface InstalledTools {
  hc?: string;
  hcGeneration?: number;
  app?: string;
  uniflo?: string;
  /** Where uniflo was found (findPrograms): launchd's PATH lacks ~/.cargo/bin. Default "uniflo". */
  unifloBin?: string;
}

export interface UpstreamDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  /** Runs a program; resolves with its exit code even when that is not 0. */
  runCheck?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string }>;
}

export interface UpstreamCheck {
  /** The previous answers with this check's on top: an offline check keeps what was known. */
  latest: UpstreamLatest;
  /** How many of the installed programs answered this time. */
  answered: number;
  asked: number;
  /** How Uniflo is installed (cargo | binary | unknown) and the version it reports running. */
  uniflo?: { current?: string; method?: string };
  /** One log line: what was found, per program. */
  message: string;
  level: LogLevel;
  ms: number;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  // A file:// release folder works too, as with Herdr (its tests point HERDR_RELEASES_URL at one).
  if (url.startsWith("file:")) return readFile(fileURLToPath(url), "utf8");
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "herdr-pocket-hostd" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function runCheck(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const code = (err as { code?: unknown }).code;
      // A number is the exit code (10: update available); anything else did not run or timed out.
      if (typeof code === "number" && !(err as { killed?: boolean }).killed) resolve({ code, stdout });
      else reject(err);
    });
  });
}

const why = (e: unknown) => (e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message.split("\n")[0]!) : String(e));

interface Answer {
  latest?: string;
  note: string;
}

/** `have -> latest`, `have (latest)`, or what went wrong. */
const found = (name: string, have: string, latest: string) =>
  compareVersions(latest, have) > 0 ? `${name} ${have} -> ${latest}` : `${name} ${have} (latest)`;

async function hcAnswer(have: InstalledTools, deps: Required<Pick<UpstreamDeps, "fetchText">>, base: string): Promise<Answer> {
  const name = "hc";
  try {
    const j = JSON.parse(await deps.fetchText(`${base}/core/latest.json`, UPSTREAM_REQUEST_MS));
    const v = typeof j?.version === "string" ? j.version : undefined;
    if (!v) return { note: `${name} ${have.hc} (core/latest.json names no version)` };
    // A core of another generation needs a matching Herdr app: never offered as an update.
    if (have.hcGeneration === undefined) return { note: `${name} ${have.hc} (its generation is unknown; latest ${v})` };
    if (j.generation !== have.hcGeneration) {
      return { note: `${name} ${have.hc} (latest ${v} is generation ${j.generation ?? "?"}, this core speaks ${have.hcGeneration})` };
    }
    return { latest: v, note: found(name, have.hc!, v) };
  } catch (e) {
    return { note: `${name} ${have.hc} (no answer: ${why(e)})` };
  }
}

async function appAnswer(have: InstalledTools, deps: Required<Pick<UpstreamDeps, "fetchText">>, base: string): Promise<Answer> {
  const name = "Herdr app";
  try {
    const j = JSON.parse(await deps.fetchText(`${base}/app/latest.json`, UPSTREAM_REQUEST_MS));
    const v = typeof j?.version === "string" ? j.version : undefined;
    if (!v) return { note: `${name} ${have.app} (app/latest.json names no version)` };
    return { latest: v, note: found(name, have.app!, v) };
  } catch (e) {
    return { note: `${name} ${have.app} (no answer: ${why(e)})` };
  }
}

async function unifloAnswer(have: InstalledTools, deps: Required<Pick<UpstreamDeps, "runCheck">>): Promise<Answer & { current?: string; method?: string }> {
  const name = "uniflo";
  try {
    const r = await deps.runCheck(have.unifloBin ?? "uniflo", ["update", "--check", "--json"], UNIFLO_CHECK_MS);
    if (r.code !== 0 && r.code !== 10) return { note: `${name} ${have.uniflo} (update --check exited ${r.code})` };
    const j = JSON.parse(r.stdout);
    const current = typeof j?.current === "string" ? j.current : undefined;
    const method = typeof j?.method === "string" ? j.method : undefined;
    const v = typeof j?.latest === "string" ? j.latest : undefined;
    if (j?.error || !v) return { current, method, note: `${name} ${current ?? have.uniflo} (no answer: ${j?.error ?? "no latest version"})` };
    return { latest: v, current, method, note: `${found(name, current ?? have.uniflo!, v)}${method ? ` via ${method}` : ""}` };
  } catch (e) {
    return { note: `${name} ${have.uniflo} (no answer: ${why(e)})` };
  }
}

/** Asks for the newest release of each installed program at once; never throws. */
export async function checkUpstream(have: InstalledTools, previous: UpstreamLatest | undefined, deps: UpstreamDeps = {}): Promise<UpstreamCheck> {
  const now = deps.now ?? Date.now;
  const d = { fetchText: deps.fetchText ?? fetchText, runCheck: deps.runCheck ?? runCheck };
  const base = releasesUrl(deps.env);
  const t0 = now();
  const [hc, app, uniflo] = await Promise.all([
    have.hc ? hcAnswer(have, d, base) : undefined,
    have.app ? appAnswer(have, d, base) : undefined,
    have.uniflo ? unifloAnswer(have, d) : undefined,
  ]);
  const latest: UpstreamLatest = { ...previous };
  const keys = [["hc", hc], ["app", app], ["uniflo", uniflo]] as const;
  for (const [k, a] of keys) {
    if (!a) delete latest[k]; // not installed (any more)
    else if (a.latest) latest[k] = a.latest;
  }
  const asked = keys.filter(([, a]) => a).length;
  const answered = keys.filter(([, a]) => a?.latest).length;
  if (answered) latest.checkedAt = now();
  const ms = now() - t0;
  const notes = keys.flatMap(([, a]) => (a ? [a.note] : []));
  const message = asked
    ? `upstream check in ${ms} ms: ${notes.join(" · ")}`
    : "upstream check: none of hc, the Herdr app and uniflo is installed";
  return {
    latest,
    answered,
    asked,
    ...(uniflo && (uniflo.current || uniflo.method) ? { uniflo: { current: uniflo.current, method: uniflo.method } } : {}),
    message,
    // Offline: nothing answered. Quietly kept for the log, not a warning.
    level: asked && !answered ? "debug" : "info",
    ms,
  };
}

// --- The Herdr desktop app on this computer ------------------------------------------------

/** Where the Herdr app may be: macOS bundles (the release's /Applications first), elsewhere its folder's program. */
export function herdrAppPlaces(platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") return ["/Applications/Herdr.app", join(home, "Applications", "Herdr.app")].map((a) => join(a, "Contents", "Info.plist"));
  if (platform === "win32") return [join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "herdr-app", "herdr-app.exe")];
  return [join(env.XDG_DATA_HOME || join(home, ".local", "share"), "herdr-app", "herdr-app")];
}

/** The installed Herdr app's version: its Info.plist on macOS, `herdr-app --version` elsewhere. */
export async function herdrAppVersion(places = herdrAppPlaces()): Promise<string | undefined> {
  for (const p of places) {
    if (!existsSync(p)) continue;
    if (p.endsWith(".plist")) {
      try {
        const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(p, "utf8"));
        if (m) return m[1]!.trim();
        // A binary plist: macOS reads it.
        const v = (await run("plutil", ["-extract", "CFBundleShortVersionString", "raw", p], { timeoutMs: UPSTREAM_REQUEST_MS })).trim();
        if (v) return v;
      } catch {
        // Unreadable: try the next place.
      }
      continue;
    }
    try {
      const v = /^herdr-app\s+(\S+)/.exec((await run(p, ["--version"], { timeoutMs: 5000 })).trim())?.[1];
      if (v) return v;
    } catch {
      // Not runnable here: as if not installed.
    }
  }
  return undefined;
}

// --- Cache -----------------------------------------------------------------------------------

/** `<state>/upstream.json`: the last answers and the versions installed then (for `status` without the daemon). */
export interface UpstreamCache {
  latest: UpstreamLatest;
  have?: Omit<HostTools, "latest">;
}

export const upstreamCachePath = (env: NodeJS.ProcessEnv = process.env) => join(stateDir(env), "upstream.json");

export function readUpstreamCache(path = upstreamCachePath()): UpstreamCache | undefined {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j.latest === "object" && j.latest ? (j as UpstreamCache) : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write; false when the state folder cannot be written (the check still counts). */
export function writeUpstreamCache(cache: UpstreamCache, path = upstreamCachePath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

// --- When -------------------------------------------------------------------------------------

/** The settings: HERDR_POCKET_UPDATE_CHECK=0, `update.autoCheck: false` or `update.checkTools: false` turn it off. */
export function upstreamCheckEnabled(env: NodeJS.ProcessEnv = process.env, config: ClientConfig = currentClientConfig().config): boolean {
  if (/^(0|false|off|no)$/i.test(env.HERDR_POCKET_UPDATE_CHECK ?? "")) return false;
  return config.update.autoCheck && config.update.checkTools;
}

/**
 * Runs `check` a few minutes after start, then about daily (both jittered, like the release
 * check); the settings are read again before each run. Never under `node --test` (or anything a
 * test starts), unless a test passes its own `enabled`.
 */
export function watchUpstream(
  check: () => Promise<unknown>,
  opts: { enabled?: () => boolean; firstMs?: number; everyMs?: () => number; env?: NodeJS.ProcessEnv } = {},
): () => void {
  if ((opts.env ?? process.env).NODE_TEST_CONTEXT && !opts.enabled) return () => {};
  const enabled = opts.enabled ?? (() => upstreamCheckEnabled());
  const every = opts.everyMs ?? (() => updateCheckDelays(24).everyMs);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref();
  };
  const tick = () => {
    if (!enabled()) return schedule(every());
    check()
      .catch(() => undefined)
      .finally(() => schedule(every()));
  };
  schedule(opts.firstMs ?? updateCheckDelays(24).firstMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

// --- `herdr-pocket status` ----------------------------------------------------------------------

/** `hc 0.1.21 → 0.1.22 可更新 · uniflo 0.2.8 (最新)`; 未检查 before the first answer. */
export function upstreamLine(tools: HostTools | undefined, enabled = true): string {
  const l = tools?.latest;
  if (!l?.checkedAt) return enabled ? "未检查" : "未检查（自动检查已关闭）";
  const parts: string[] = [];
  for (const [name, have, latest] of [
    ["hc", tools?.hc, l.hc],
    ["Herdr app", tools?.app, l.app],
    ["uniflo", tools?.uniflo, l.uniflo],
  ] as const) {
    if (!have) continue;
    if (!latest) parts.push(`${name} ${have} (未检查)`);
    else if (compareVersions(latest, have) > 0) parts.push(`${name} ${have} → ${latest} 可更新`);
    else parts.push(`${name} ${have} (最新)`);
  }
  return parts.join(" · ") || "未装 hc、Herdr app、uniflo";
}
