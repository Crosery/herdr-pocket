import {
  LATEST_MANIFEST_URL,
  LATEST_SUMS_URL,
  RELEASE_REPO,
  SOURCE_PROBE_SLACK_MS,
  SOURCE_PROBE_TIMEOUT_MS,
  cachedWinner,
  compareVersions,
  decideRegion,
  localTimeZone,
  orderWithPreferredSource,
  parseReleaseManifest,
  pickLowestLatency,
  releaseFromSums,
  resolveChannelFromManifest,
  resolvePreferredSource,
  sourceLabel,
  sourcePrefixes,
  sourceUrl,
  withWinnerFirst,
  type PutFile,
  type Region,
  type RegionDecision,
  type RegionSetting,
  type ReleaseChannelId,
  type ReleaseManifest,
  type SourceCache,
  type SourceProbe,
} from "@herdr-pocket/protocol";
import { desktopSessionStore, type DesktopSessionStore } from "./sessionStore";
import { logger } from "./log";

declare const __POCKET_TARGET__: "desktop" | "harmony";
declare const __APP_VERSION__: string;

export type PlatformKind = "macos" | "windows" | "linux" | "openharmony" | "web";

export interface SavedSession {
  server: string;
  token: string;
  deviceId: string;
  deviceName: string;
  lastServer?: string;
}

/** A program this computer needs before its agents show up (see hostd_status in src-tauri). */
export interface LocalDep {
  id: "herdr" | "hc" | "herdr-pocket" | "uniflo";
  found: boolean;
  /** Agents still show up without it. */
  optional: boolean;
}

export interface HostdLocalStatus {
  /** hostd.json exists. */
  installed: boolean;
  /** hostd.json has a server and a device token, so this computer is logged in. */
  configured: boolean;
  server?: string;
  deviceId?: string;
  deviceName?: string;
  /** The daemon answers on its control socket; absent where that cannot be checked. */
  running?: boolean;
  deps: LocalDep[];
}

export interface HarmonyBridgeApi {
  platform?: () => string;
  deviceName?: () => string;
  appVersion?: () => string;
  getPref?: (key: string) => string;
  setPref?: (key: string, val: string) => void;
  deletePref?: (key: string) => void;
  notify?: (title: string, body: string) => void;
  openExternal?: (url: string) => void;
  requestMicrophone?: () => Promise<boolean> | boolean;
  getSafeArea?: () => string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** The desktop app's version, set by its native side (src-tauri/src/webdiag.rs). */
    __POCKET_APP_VERSION__?: string;
    /** This machine's hostd deviceId (if already logged in at launch), set by src-tauri/src/webdiag.rs. */
    __POCKET_LOCAL_HOST_ID__?: string | null;
    PocketHarmony?: HarmonyBridgeApi;
    __POCKET_SET_SAFE_AREA__?: (topPx: number, bottomPx: number) => void;
    __POCKET_OPEN_URL__?: (url: string) => void;
  }
}

export const IS_HARMONY_TARGET =
  typeof __POCKET_TARGET__ !== "undefined" && __POCKET_TARGET__ === "harmony";

export function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function isHarmony(): boolean {
  if (IS_HARMONY_TARGET) return true;
  return typeof window !== "undefined" && Boolean(window.PocketHarmony);
}

export function appVersion(): string {
  const w = typeof window !== "undefined" ? window : undefined;
  const fromHarmony = w?.PocketHarmony?.appVersion?.();
  if (fromHarmony && fromHarmony.trim()) return fromHarmony.trim();
  // Desktop: the running app's own version (what Tauri's getVersion() returns), set by
  // src-tauri/src/webdiag.rs before this page's scripts run.
  const fromTauri = w?.__POCKET_APP_VERSION__;
  if (fromTauri && fromTauri.trim()) return fromTauri.trim();
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.2.0";
}

export function detectPlatform(): PlatformKind {
  if (isHarmony()) return "openharmony";
  const nav = typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}`.toLowerCase() : "";
  if (nav.includes("mac")) return "macos";
  if (nav.includes("win")) return "windows";
  if (nav.includes("linux") && !nav.includes("android")) return "linux";
  return isTauri() ? "macos" : "web";
}

export function defaultDeviceName(): string {
  const harmonyName = window.PocketHarmony?.deviceName?.();
  if (harmonyName && harmonyName.trim()) return harmonyName.trim().slice(0, 40);
  const p = detectPlatform();
  if (p === "openharmony") return "我的鸿蒙设备";
  if (p === "macos") return "我的 Mac";
  if (p === "windows") return "我的 Windows 电脑";
  if (p === "linux") return "我的 Linux 电脑";
  return "我的浏览器";
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

const SESSION_KEY = "herdr-pocket-client-session-v1";

/** Desktop: session.json through Rust only (see sessionStore.ts); browser and Harmony builds below. */
let desktopStore: DesktopSessionStore<SavedSession> | null = null;
function desktopSessions(): DesktopSessionStore<SavedSession> {
  const log = (level: "info" | "warn") => (msg: string, data?: Record<string, unknown>) => {
    void tauriInvoke("log_write", { level, kind: "pair.session", msg, data: data ?? null }).catch(() => undefined);
  };
  desktopStore ??= desktopSessionStore<SavedSession>({
    load: () => tauriInvoke<SavedSession | null>("load_auth"),
    save: (session) => tauriInvoke<void>("save_auth", { session }),
    clear: () => tauriInvoke<void>("clear_auth"),
    legacyGet: () => localStorage.getItem(SESSION_KEY),
    legacyRemove: () => localStorage.removeItem(SESSION_KEY),
    warn: log("warn"),
    info: log("info"),
  });
  return desktopStore;
}

export async function loadSession(): Promise<SavedSession | null> {
  if (isTauri()) return desktopSessions().load();
  if (window.PocketHarmony?.getPref) {
    try {
      const raw = window.PocketHarmony.getPref(SESSION_KEY);
      if (raw) return JSON.parse(raw) as SavedSession;
    } catch {
      // ignore
    }
  }
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: SavedSession): Promise<void> {
  if (isTauri()) return desktopSessions().save(session);
  const encoded = JSON.stringify(session);
  if (window.PocketHarmony?.setPref) {
    try {
      window.PocketHarmony.setPref(SESSION_KEY, encoded);
    } catch {
      // Fallback below
    }
  }
  try {
    localStorage.setItem(SESSION_KEY, encoded);
  } catch {
    // ignore
  }
}

export async function clearSession(): Promise<void> {
  if (isTauri()) return desktopSessions().clear();
  if (window.PocketHarmony?.deletePref) {
    try {
      window.PocketHarmony.deletePref(SESSION_KEY);
    } catch {
      // ignore
    }
  }
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export async function getHostdStatus(): Promise<HostdLocalStatus | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<HostdLocalStatus>("hostd_status");
  } catch {
    return null;
  }
}

/** A one-time viewer pairing code made with this computer's herdr-pocket login. */
export interface LocalPairCode {
  /** The relay hostd.json points at, normalised like the app stores it. */
  server: string;
  code: string;
  expiresAt: number;
  link: string;
}

/** Rejects with an Error whose `code` is `not_logged_in`, `offline`, `unauthorized` or the relay's own code. */
export type LocalPairError = Error & { code: string };

/**
 * Asks the relay this computer's herdr-pocket is logged in to for a viewer pairing code (desktop
 * app only). The daemon's token is used inside the native side and never reaches this page.
 */
export async function getLocalPairCode(): Promise<LocalPairCode> {
  if (!isTauri()) throw Object.assign(new Error("只有桌面应用能使用本机的 herdr-pocket 登录"), { code: "unsupported" });
  try {
    return await tauriInvoke<LocalPairCode>("hostd_local_pair_code");
  } catch (err) {
    const e = err as { code?: string; message?: string } | string;
    if (typeof e === "string") throw Object.assign(new Error(e), { code: "internal" });
    throw Object.assign(new Error(e?.message || "无法使用本机登录"), { code: e?.code || "internal" });
  }
}

export async function pushSystemNotification(title: string, body: string): Promise<void> {
  if (window.PocketHarmony?.notify) {
    try {
      window.PocketHarmony.notify(title, body);
      return;
    } catch {
      // fallback
    }
  }
  if (isTauri()) {
    try {
      const notif = await import("@tauri-apps/plugin-notification");
      let granted = await notif.isPermissionGranted();
      if (!granted) {
        granted = (await notif.requestPermission()) === "granted";
      }
      if (granted) {
        notif.sendNotification({ title, body });
        return;
      }
    } catch {
      // fallback
    }
  }
  if (typeof Notification !== "undefined") {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission === "default") {
      const p = await Notification.requestPermission().catch(() => "denied");
      if (p === "granted") new Notification(title, { body });
    }
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  if (window.PocketHarmony?.requestMicrophone) {
    try {
      const ok = await window.PocketHarmony.requestMicrophone();
      return Boolean(ok);
    } catch {
      return false;
    }
  }
  return true;
}

export async function openExternalUrl(url: string): Promise<void> {
  if (window.PocketHarmony?.openExternal) {
    try {
      window.PocketHarmony.openExternal(url);
      return;
    } catch {
      // fallback
    }
  }
  if (isTauri()) {
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
      return;
    } catch {
      // fallback
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `./assets/${clean}`;
}

export async function encodeImageFiles(files: File[], maxCount = 6, maxSide = 1280): Promise<PutFile[]> {
  const picked = files.filter((f) => f.type.startsWith("image/")).slice(0, maxCount);
  const out: PutFile[] = [];
  for (const file of picked) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片解码失败"));
      el.src = dataUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
    const w = Math.max(1, Math.round((img.width || 1) * scale));
    const h = Math.max(1, Math.round((img.height || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.drawImage(img, 0, 0, w, h);
    const jpegUrl = canvas.toDataURL("image/jpeg", 0.84);
    const b64 = jpegUrl.split(",")[1] ?? "";
    if (!b64) continue;
    const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
    out.push({ name: `${baseName}.jpg`, mime: "image/jpeg", data: b64 });
  }
  return out;
}

export interface ReleaseNotesInfo {
  body: string;
  url: string;
  publishedAt: string;
}

export interface GithubReleaseAsset {
  name: string;
  size: number;
  browserDownloadUrl: string;
  sha256?: string;
}

export interface GithubLatestRelease {
  version: string;
  tagName: string;
  htmlUrl: string;
  publishedAt: string;
  body: string;
  assets: GithubReleaseAsset[];
}

export interface UpdateProgressEvent {
  phase: "downloading" | "verifying" | "staging" | "ready" | "restarting" | "error";
  version: string;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  source?: string;
  message?: string;
}

export interface StagedUpdateResult {
  version: string;
  ready: boolean;
}

export interface ReleaseUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  pageUrl: string;
  /** The installer through the source that answered (a mirror or github.com). */
  downloadUrl: string;
  assetName: string;
  downloadUrls: string[];
  sha256?: string;
  assetSize?: number;
  notes?: ReleaseNotesInfo | null;
  region: Region;
  regionReason: RegionDecision["reason"];
  /** `github.com` or the mirror's host. */
  source: string;
  /** This check's race; absent when a remembered winner answered. */
  probes?: SourceProbe[];
}

/**
 * `"cn"`/`"global"` forces the region; an object passes what config.json says
 * (`update.region`, `update.mirrors`). Without one, the desktop app reads config.json itself.
 */
export type UpdateCheckOptions =
  | Region
  | {
      region?: Region;
      setting?: RegionSetting | string;
      mirrors?: string[];
      preferredSource?: string;
      forceRace?: boolean;
    };

async function detectMacArch(): Promise<"arm64" | "x64"> {
  if (isTauri()) {
    try {
      const arch = await tauriInvoke<string>("runtime_arch");
      if (arch === "aarch64" || arch === "arm64") return "arm64";
      if (arch === "x86_64" || arch === "x64") return "x64";
    } catch {
      // Fallback to navigator heuristic outside Tauri
    }
  }
  return typeof navigator !== "undefined" && /intel|x86_64/i.test(navigator.userAgent) ? "x64" : "arm64";
}

export function desktopReleaseChannel(
  platform: PlatformKind = detectPlatform(),
  macArch: "arm64" | "x64" = "arm64",
): ReleaseChannelId {
  switch (platform) {
    case "openharmony":
      return "harmonyos-arm64";
    case "macos":
      return macArch === "x64" ? "macos-x64" : "macos-arm64";
    case "windows":
      return "windows-x64-setup";
    case "linux":
      return "linux-x64-appimage";
    default:
      return "bundle";
  }
}

export function platformAssetNameHint(version: string): string {
  const platform = detectPlatform();
  const macArch: "arm64" | "x64" =
    typeof navigator !== "undefined" && /intel|x86_64/i.test(navigator.userAgent) ? "x64" : "arm64";
  return platformDownloadAsset(version, platform, macArch);
}

function platformDownloadAsset(version: string, platform: PlatformKind, macArch: "arm64" | "x64"): string {
  const clean = version.trim().replace(/^v/i, "");
  switch (platform) {
    case "openharmony":
      return `herdr-pocket-${clean}-harmonyos-arm64.hap`;
    case "macos":
      return `herdr-pocket-${clean}-macos-${macArch}.dmg`;
    case "windows":
      return `herdr-pocket-${clean}-windows-x64-setup.exe`;
    case "linux":
      return `herdr-pocket-${clean}-linux-x64.AppImage`;
    default:
      return `herdr-pocket-${clean}.tar.gz`;
  }
}

/** Writes one line to the desktop log file (and the relay, when it qualifies); no-op elsewhere. */
function nativeLog(level: "debug" | "info" | "warn" | "error", kind: string, msg: string, data?: Record<string, unknown>): void {
  if (!isTauri()) return;
  void tauriInvoke("log_write", { level, kind, msg, data: data ?? null }).catch(() => {});
}

const SOURCE_CACHE_KEY = "herdr-pocket-sources";

/** The last race's winner: the shared state folder in the desktop app (`sources.json`), localStorage elsewhere. */
async function readSourceCache(): Promise<unknown> {
  if (isTauri()) return tauriInvoke<unknown>("update_source_cache_read").catch(() => undefined);
  try {
    return JSON.parse(localStorage.getItem(SOURCE_CACHE_KEY) || "null");
  } catch {
    return undefined;
  }
}

async function writeSourceCache(cache: SourceCache): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("update_source_cache_write", { cache }).catch(() => {});
    return;
  }
  try {
    localStorage.setItem(SOURCE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A full storage only costs a race next time.
  }
}

export interface CachedSourceProbes {
  region?: Region;
  winner?: string;
  at?: number;
  probes: SourceProbe[];
}

export interface ProbeUpdateSourcesResult {
  region: Region;
  reason: RegionDecision["reason"];
  timeZone: string;
  recommendedOrder: string[];
  winner?: string;
  probes: SourceProbe[];
}

const FULL_PROBE_TIMEOUT_MS = 3500;

/** Reads cached `probes` and `winner` from `sources.json` (or localStorage outside Tauri). */
export async function readCachedSourceProbes(): Promise<CachedSourceProbes | null> {
  const raw = await readSourceCache();
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<SourceCache>;
  const probes = Array.isArray(c.probes)
    ? c.probes.filter(
        (p): p is SourceProbe =>
          Boolean(
            p &&
              typeof p === "object" &&
              typeof p.source === "string" &&
              typeof p.ok === "boolean" &&
              typeof p.ms === "number",
          ),
      )
    : [];
  if (!probes.length && typeof c.winner !== "string") return null;
  return {
    region: c.region === "cn" || c.region === "global" ? c.region : undefined,
    winner: typeof c.winner === "string" ? c.winner : undefined,
    at: typeof c.at === "number" ? c.at : undefined,
    probes,
  };
}

/** Region, own mirrors, and preferred source, in decideRegion's order: HERDR_POCKET_MIRROR, config.json, time zone. */
async function updateRegion(
  opts?: UpdateCheckOptions,
): Promise<{ decision: RegionDecision; mirrors: string[]; preferredSource: string }> {
  if (typeof opts === "string") {
    return {
      decision: { region: opts, reason: "config", timeZone: localTimeZone() },
      mirrors: [],
      preferredSource: "auto",
    };
  }
  let setting = opts?.setting;
  let mirrors = opts?.mirrors;
  let preferredSource = opts?.preferredSource;
  let env: string | undefined;
  if (isTauri()) {
    env = (await tauriInvoke<{ mirror?: string }>("update_env").catch(() => ({ mirror: undefined }))).mirror;
    if (setting === undefined || mirrors === undefined || preferredSource === undefined) {
      const file = await tauriInvoke<{
        raw?: { update?: { region?: unknown; mirrors?: unknown; preferredSource?: unknown } };
      }>("config_load").catch(() => null);
      const u = file?.raw?.update;
      if (setting === undefined && typeof u?.region === "string") setting = u.region;
      if (mirrors === undefined && Array.isArray(u?.mirrors)) {
        mirrors = u.mirrors.filter((m): m is string => typeof m === "string");
      }
      if (preferredSource === undefined && typeof u?.preferredSource === "string") {
        preferredSource = u.preferredSource;
      }
    }
  }
  const pref = resolvePreferredSource(preferredSource) !== undefined ? preferredSource! : "auto";
  if (opts?.region) {
    return {
      decision: { region: opts.region, reason: "config", timeZone: localTimeZone() },
      mirrors: mirrors ?? [],
      preferredSource: pref,
    };
  }
  return { decision: decideRegion({ env, setting }), mirrors: mirrors ?? [], preferredSource: pref };
}

/** The listing's text. In the desktop app natively: github.com's redirect carries no CORS headers. */
async function fetchListing(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  if (!isTauri()) {
    const res = await fetch(url, { signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  // The native request has its own timeout; an abort only stops waiting for it.
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    tauriInvoke<string>("update_fetch_sums", { url, timeoutMs }).then(
      (t) => {
        signal.removeEventListener("abort", onAbort);
        resolve(t);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error(errorText(e)));
      },
    );
  });
}

interface ParsedReleaseSource {
  manifest?: ReleaseManifest;
  version: string;
  sums: Record<string, string>;
}

function parseManifestOrSums(text: string): ParsedReleaseSource | null {
  const manifest = parseReleaseManifest(text);
  if (manifest) {
    const sums: Record<string, string> = {};
    for (const entry of Object.values(manifest.channels)) {
      if (entry) sums[entry.fileName] = entry.sha256;
    }
    return { manifest, version: manifest.releaseVersion, sums };
  }
  return releaseFromSums(text);
}

async function fetchSums(
  url: string,
  signal: AbortSignal,
  timeoutMs = SOURCE_PROBE_TIMEOUT_MS,
): Promise<ParsedReleaseSource> {
  // A mirror that answers with an error page is not an answer.
  const parsed = parseManifestOrSums(await fetchListing(url, signal, timeoutMs));
  if (!parsed) throw new Error("not a release manifest or SHA256SUMS listing");
  return parsed;
}

async function fetchManifestOrSumsFromSource(
  source: string,
  signal: AbortSignal,
  timeoutMs = SOURCE_PROBE_TIMEOUT_MS,
): Promise<ParsedReleaseSource> {
  try {
    return await fetchSums(sourceUrl(source, LATEST_MANIFEST_URL), signal, timeoutMs);
  } catch (err) {
    if (signal.aborted) throw err;
    return await fetchSums(sourceUrl(source, LATEST_SUMS_URL), signal, timeoutMs);
  }
}

/** Every source at once; once one answers the others get the slack, then pickLowestLatency decides. */
async function raceSums(
  order: string[],
  pathUrl?: string,
): Promise<{
  winner?: string;
  version?: string;
  sums?: Record<string, string>;
  manifest?: ReleaseManifest;
  probes: SourceProbe[];
}> {
  const probes: SourceProbe[] = [];
  const results = new Map<string, ParsedReleaseSource>();
  const ctls = order.map(() => new AbortController());
  return new Promise((resolve) => {
    let done = false;
    let slack: ReturnType<typeof setTimeout> | undefined;
    const t0 = Date.now();
    const finish = () => {
      if (done) return;
      done = true;
      if (slack) clearTimeout(slack);
      ctls.forEach((c) => c.abort());
      for (const s of order) if (!probes.some((p) => p.source === s)) probes.push({ source: s, ok: false, ms: Date.now() - t0, error: "slower than the winner" });
      const winner = pickLowestLatency(probes, order);
      const picked = winner === undefined ? undefined : results.get(winner);
      resolve({ winner, version: picked?.version, sums: picked?.sums, manifest: picked?.manifest, probes });
    };
    if (!order.length) return finish();
    order.forEach((source, i) => {
      const ctl = ctls[i]!;
      const timer = setTimeout(() => ctl.abort(), SOURCE_PROBE_TIMEOUT_MS);
      const started = Date.now();
      const req = pathUrl
        ? fetchSums(sourceUrl(source, pathUrl), ctl.signal)
        : fetchManifestOrSumsFromSource(source, ctl.signal);
      req.then(
        (r) => {
          clearTimeout(timer);
          if (done) return;
          results.set(source, r);
          probes.push({ source, ok: true, ms: Date.now() - started });
          if (probes.length === order.length) finish();
          else slack ??= setTimeout(finish, SOURCE_PROBE_SLACK_MS);
        },
        (e: unknown) => {
          clearTimeout(timer);
          if (done) return;
          const msg = ctl.signal.aborted ? `no answer within ${SOURCE_PROBE_TIMEOUT_MS} ms` : e instanceof Error ? e.message : String(e);
          probes.push({ source, ok: false, ms: Date.now() - started, error: msg.slice(0, 160) });
          if (probes.length === order.length) finish();
        },
      );
    });
  });
}

/**
 * Probes every candidate source in parallel (3500 ms per source, without aborting runner-ups)
 * so all healthy mirrors report real ms latency, picks `pickLowestLatency`, and persists `sources.json`.
 */
export async function probeUpdateSources(opts?: UpdateCheckOptions): Promise<ProbeUpdateSourcesResult> {
  const { decision, mirrors } = await updateRegion(opts);
  const base = sourcePrefixes(decision.region, mirrors);
  const probes = await Promise.all(
    base.map(async (source): Promise<SourceProbe> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FULL_PROBE_TIMEOUT_MS);
      const started = Date.now();
      try {
        await fetchSums(sourceUrl(source, LATEST_SUMS_URL), ctl.signal, FULL_PROBE_TIMEOUT_MS);
        return { source, ok: true, ms: Date.now() - started };
      } catch (e) {
        const msg = ctl.signal.aborted
          ? `no answer within ${FULL_PROBE_TIMEOUT_MS} ms`
          : e instanceof Error
            ? e.message
            : String(e);
        return { source, ok: false, ms: Date.now() - started, error: msg.slice(0, 160) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const winner = pickLowestLatency(probes, base);
  if (winner !== undefined) {
    await writeSourceCache({
      region: decision.region,
      winner,
      at: Date.now(),
      probes,
    });
  }
  for (const p of probes) {
    nativeLog("debug", "update", "source latency probe", {
      source: sourceLabel(p.source),
      ok: p.ok,
      ms: p.ms,
      error: p.error,
    });
  }
  return {
    region: decision.region,
    reason: decision.reason,
    timeZone: decision.timeZone,
    recommendedOrder: base,
    winner,
    probes,
  };
}

/** Fetches SHA256SUMS for an explicit release tag when the cached latest mirror was stale. */
export async function fetchVersionSums(
  version: string,
  opts?: UpdateCheckOptions,
): Promise<Record<string, string> | null> {
  const { decision, mirrors, preferredSource } = await updateRegion(opts);
  const base = sourcePrefixes(decision.region, mirrors);
  const cached = cachedWinner(await readSourceCache(), decision.region, base);
  const taggedUrl = `https://github.com/${RELEASE_REPO}/releases/download/v${version.trim().replace(/^v/i, "")}/SHA256SUMS`;
  const race = await raceSums(orderWithPreferredSource(base, preferredSource, cached), taggedUrl);
  return race.sums ?? null;
}

/**
 * Fetches RELEASE-NOTES.md for a specific version through the fastest release source
 * (including Mainland China mirrors, avoiding GitHub API rate/network blocks).
 */
export async function fetchVersionReleaseNotes(
  version: string,
  opts?: UpdateCheckOptions,
): Promise<string | null> {
  const clean = version.trim().replace(/^v/i, "");
  if (!clean) return null;
  const { decision, mirrors, preferredSource } = await updateRegion(opts);
  const base = sourcePrefixes(decision.region, mirrors);
  const cached = cachedWinner(await readSourceCache(), decision.region, base);
  const rawUrl = `https://github.com/${RELEASE_REPO}/releases/download/v${clean}/RELEASE-NOTES.md`;
  for (const src of orderWithPreferredSource(base, preferredSource, cached)) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    try {
      const text = await fetchListing(sourceUrl(src, rawUrl), ctl.signal, 3000);
      const trimmed = text.trim();
      if (trimmed && !/^\s*<(?:!doctype|html)\b/i.test(trimmed)) {
        return trimmed;
      }
    } catch {
      // Try next mirror or GitHub source
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

/**
 * The newest release and where to download it. Region: HERDR_POCKET_MIRROR, then
 * `update.region`, then the time zone. When `update.preferredSource` pins `"direct"` or a
 * mirror prefix, that source is tried first (falling back to others if it fails). Otherwise
 * a remembered winner (24 h, shared via sources.json) is asked first unless `forceRace` is set;
 * GitHub Releases API is queried in parallel in the desktop app.
 */
export async function checkReleaseUpdate(opts?: UpdateCheckOptions): Promise<ReleaseUpdateInfo> {
  const forceRace = typeof opts === "object" && opts !== null && Boolean(opts.forceRace);
  const ghPromise: Promise<GithubLatestRelease | null> = isTauri()
    ? tauriInvoke<GithubLatestRelease>("update_fetch_github_latest", { timeoutMs: 4500 }).catch(() => null)
    : Promise.resolve(null);

  const { decision, mirrors, preferredSource } = await updateRegion(opts);
  const base = sourcePrefixes(decision.region, mirrors);
  const explicitSource = resolvePreferredSource(preferredSource);
  const cached =
    explicitSource === undefined ? cachedWinner(await readSourceCache(), decision.region, base) : undefined;
  let source: string | undefined;
  let version: string | undefined;
  let sumsMap: Record<string, string> | undefined;
  let manifest: ReleaseManifest | undefined;
  let probes: SourceProbe[] | undefined;

  if (explicitSource !== undefined) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), SOURCE_PROBE_TIMEOUT_MS);
    const started = Date.now();
    try {
      const hit = await fetchManifestOrSumsFromSource(explicitSource, ctl.signal, SOURCE_PROBE_TIMEOUT_MS);
      version = hit.version;
      sumsMap = hit.sums;
      manifest = hit.manifest;
      source = explicitSource;
      probes = [{ source: explicitSource, ok: true, ms: Date.now() - started }];
    } catch (e) {
      const msg = ctl.signal.aborted
        ? `no answer within ${SOURCE_PROBE_TIMEOUT_MS} ms`
        : e instanceof Error
          ? e.message
          : String(e);
      probes = [{ source: explicitSource, ok: false, ms: Date.now() - started, error: msg.slice(0, 160) }];
      nativeLog("info", "update", "preferred source failed, falling back to race", {
        source: sourceLabel(explicitSource),
        error: msg,
      });
    } finally {
      clearTimeout(t);
    }
  } else if (!forceRace && cached !== undefined) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    try {
      const hit = await fetchManifestOrSumsFromSource(cached, ctl.signal, 2500);
      version = hit.version;
      sumsMap = hit.sums;
      manifest = hit.manifest;
      source = cached;
    } catch (e) {
      nativeLog("info", "update", "remembered source failed, racing again", {
        source: sourceLabel(cached),
        error: (e as Error).message,
      });
    } finally {
      clearTimeout(t);
    }
  }
  if (version === undefined) {
    const raceOrder =
      explicitSource !== undefined ? base.filter((s) => s !== explicitSource) : withWinnerFirst(base, cached);
    const race = await raceSums(raceOrder);
    probes = probes ? [...probes, ...race.probes] : race.probes;
    for (const p of race.probes) {
      nativeLog("debug", "update", "source probe", { source: sourceLabel(p.source), ok: p.ok, ms: p.ms, error: p.error });
    }
    if (race.winner !== undefined && race.version !== undefined) {
      source = race.winner;
      version = race.version;
      sumsMap = race.sums;
      manifest = race.manifest;
      if (explicitSource === undefined) {
        await writeSourceCache({ region: decision.region, winner: source, at: Date.now(), probes });
      }
    }
  }

  const current = appVersion();
  const platform = detectPlatform();
  const macArch = platform === "macos" ? await detectMacArch() : "arm64";
  const channel = desktopReleaseChannel(platform, macArch);

  const gh = await ghPromise;
  const ghExpectedAsset = gh ? platformDownloadAsset(gh.version, platform, macArch) : "";
  const ghHasPlatformAsset = Boolean(gh && gh.assets.some((a) => a.name === ghExpectedAsset));

  if (version === undefined) {
    if (gh) {
      version = gh.version;
      source = "";
    } else {
      nativeLog("warn", "update", "no release source answered", { region: decision.region, sources: base.length });
      throw new Error("检查更新失败，GitHub 与镜像线路均未响应，请检查网络连接");
    }
  } else if (gh && ghHasPlatformAsset && compareVersions(gh.version, version) > 0) {
    // GitHub API has a newer release that actually ships this platform's installer.
    version = gh.version;
    sumsMap = undefined;
    manifest = undefined;
  }

  const chEntry = manifest ? resolveChannelFromManifest(manifest, channel) : null;
  const resolvedVersion = manifest ? (chEntry?.version ?? current) : version;
  const assetName = chEntry?.fileName ?? platformDownloadAsset(resolvedVersion, platform, macArch);
  const rawUrl = `https://github.com/${RELEASE_REPO}/releases/download/v${resolvedVersion}/${assetName}`;

  const winner = source ?? "";
  nativeLog("info", "update", "release source chosen", {
    region: decision.region,
    reason: decision.reason,
    source: sourceLabel(winner),
    remembered: probes === undefined,
    latest: resolvedVersion,
    channel,
  });

  const orderedSources =
    explicitSource !== undefined && winner !== explicitSource
      ? withWinnerFirst(base, winner)
      : orderWithPreferredSource(base, preferredSource, winner);
  const downloadUrls = Array.from(new Set(orderedSources.map((s) => sourceUrl(s, rawUrl))));

  const ghMatch = gh && compareVersions(gh.version, resolvedVersion) === 0 ? gh : null;
  const ghAsset = ghMatch?.assets.find((a) => a.name === assetName);
  const sha256 = chEntry?.sha256 ?? sumsMap?.[assetName] ?? ghAsset?.sha256;
  const assetSize = chEntry?.size || ghAsset?.size || undefined;
  const assetConfirmed = manifest ? Boolean(chEntry) : sumsMap ? Boolean(sumsMap[assetName]) : Boolean(ghAsset);
  const hasUpdate = assetConfirmed && compareVersions(resolvedVersion, current) > 0;
  const notes: ReleaseNotesInfo | null = ghMatch?.body
    ? { body: ghMatch.body, url: ghMatch.htmlUrl || `https://github.com/${RELEASE_REPO}/releases/tag/v${resolvedVersion}`, publishedAt: ghMatch.publishedAt }
    : null;

  return {
    current,
    latest: resolvedVersion,
    hasUpdate,
    pageUrl: ghMatch?.htmlUrl || `https://github.com/${RELEASE_REPO}/releases/tag/v${resolvedVersion}`,
    downloadUrl: sourceUrl(winner, rawUrl),
    assetName,
    downloadUrls,
    sha256,
    assetSize,
    notes,
    region: decision.region,
    regionReason: decision.reason,
    source: sourceLabel(winner),
    probes,
  };
}

export function downloadAndStageUpdate(params: {
  version: string;
  assetName: string;
  urls: string[];
  expectedSha256: string;
}): Promise<StagedUpdateResult> {
  return call<StagedUpdateResult>("update_download_and_stage", params);
}

export function restartAndApplyUpdate(): Promise<void> {
  return call<void>("update_restart_and_apply");
}

export function onUpdateProgress(cb: (ev: UpdateProgressEvent) => void): () => void {
  return listenTauri<UpdateProgressEvent>("update://progress", cb);
}

/** Loads persisted workspace state JSON from `workspace-state.json` on Tauri desktop, else null. */
export async function loadWorkspaceStateRaw(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const raw = await tauriInvoke<string | null>("workspace_state_load");
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Atomically writes workspace state JSON to `workspace-state.json` on Tauri desktop. */
export async function saveWorkspaceStateRaw(raw: string): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>("workspace_state_save", { raw });
}

// ---------------------------------------------------------------------------
// Desktop-only native features (src-tauri). Outside Tauri each call is a no-op, answers
// null/[] or rejects with a Chinese message, so web and HarmonyOS builds still work.
// ---------------------------------------------------------------------------

function rejectOutside(): Promise<never> {
  return Promise.reject(new Error("这个功能需要 Herdr Pocket 桌面版"));
}

/** Subscribes to a Tauri event; returns an unsubscribe that is safe to call at any time. */
function listenTauri<T>(name: string, cb: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  let off: (() => void) | null = null;
  let dead = false;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<T>(name, (e) => cb(e.payload)).then((un) => {
      if (dead) un();
      else off = un;
    }),
  );
  return () => {
    dead = true;
    off?.();
  };
}

function errorText(err: unknown): string {
  return typeof err === "string" ? err : (err as Error)?.message || String(err);
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return rejectOutside();
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    throw new Error(errorText(err));
  }
}

// Built-in browser -----------------------------------------------------------------------------------

export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserNavOp {
  url?: string;
  back?: true;
  forward?: true;
  reload?: true;
  stop?: true;
}

export interface BrowserEvent {
  id: string;
  kind: "url" | "title" | "loading" | "loaded" | "error" | "download";
  url?: string;
  title?: string;
  error?: string;
  /** download: finished and where the file went. */
  ok?: boolean;
  path?: string;
}

/** Creates panel `id` at `rect`; for an id that is already open it only shows and moves it (no reload). */
export function browserOpen(id: string, url: string, rect: BrowserRect): Promise<void> {
  return call("browser_open", { id, url, rect });
}

/** Resolves even when the panel is not open (yet): the UI calls this on every resize. */
export function browserSetBounds(id: string, rect: BrowserRect): Promise<void> {
  return isTauri() ? call<void>("browser_set_bounds", { id, rect }).catch(() => {}) : Promise.resolve();
}

export function browserNavigate(id: string, op: BrowserNavOp): Promise<void> {
  return call("browser_navigate", { id, op });
}

export function browserSetVisible(id: string, visible: boolean): Promise<void> {
  return isTauri() ? call<void>("browser_set_visible", { id, visible }).catch(() => {}) : Promise.resolve();
}

export function browserClose(id: string): Promise<void> {
  return isTauri() ? call<void>("browser_close", { id }).catch(() => {}) : Promise.resolve();
}

export function onBrowserEvent(cb: (e: BrowserEvent) => void): () => void {
  return listenTauri<BrowserEvent>("browser://event", cb);
}

/** Clears the built-in browser's cookies, cache and storage; resolves to the bytes they took. */
export function browserClearData(): Promise<number> {
  return isTauri() ? call<number>("browser_clear_data") : Promise.resolve(0);
}

/**
 * `persistent`: imported cookies and sign-ins survive a restart. `session` (macOS 11–13):
 * they last until the last browser tab closes. null outside the desktop app.
 */
export async function browserStoreKind(): Promise<"persistent" | "session" | null> {
  return isTauri() ? call<"persistent" | "session">("browser_store_kind").catch(() => null) : null;
}

// Cookie import from installed browsers --------------------------------------------

export type CookieBrowser = "chrome" | "edge" | "brave" | "arc" | "chromium" | "vivaldi" | "safari";

export interface CookieSource {
  /** `<browser>:<profile folder>`, what listCookieDomains / importCookies take. */
  id: string;
  browser: CookieBrowser;
  /** "Google Chrome · 个人" */
  label: string;
  /** The profile's display name. */
  profile: string;
  importable: boolean;
  /** Chinese: the Keychain prompt to expect, quit the browser first, why it cannot be imported. */
  note?: string;
  /** Permission page that would unlock it (Safari: `fullDiskAccess`). */
  settings?: "fullDiskAccess";
}

interface RawCookieSource {
  id: CookieBrowser;
  name: string;
  profiles: Array<{ id: string; name: string }>;
  importable: boolean;
  note?: string;
}

/** Installed browsers and their profiles. Reads folder names only: nothing is decrypted, no prompt. */
export async function listCookieSources(): Promise<CookieSource[]> {
  if (!isTauri()) return [];
  const raw = await call<RawCookieSource[]>("cookie_sources").catch(() => [] as RawCookieSource[]);
  const out: CookieSource[] = [];
  for (const s of raw) {
    if (!s.profiles.length) {
      out.push({ id: `${s.id}:`, browser: s.id, label: s.name, profile: "", importable: s.importable, note: s.note, settings: s.id === "safari" ? "fullDiskAccess" : undefined });
      continue;
    }
    for (const p of s.profiles) {
      out.push({
        id: `${s.id}:${p.id}`,
        browser: s.id,
        label: s.profiles.length > 1 ? `${s.name} · ${p.name}` : s.name,
        profile: p.name,
        importable: s.importable,
        note: s.note,
      });
    }
  }
  return out;
}

function splitSource(sourceId: string): { browser: string; profile: string } {
  const at = sourceId.indexOf(":");
  if (at <= 0 || at === sourceId.length - 1) throw new Error("请选择一个浏览器配置");
  return { browser: sourceId.slice(0, at), profile: sourceId.slice(at + 1) };
}

/** Sites with cookies in that profile, most cookies first (at most 1000). Counts only, no values. */
export async function listCookieDomains(sourceId: string): Promise<Array<{ domain: string; count: number }>> {
  const { browser, profile } = splitSource(sourceId);
  return call("cookie_domains", { browser, profile });
}

export interface CookieImportRequest {
  sourceId: string;
  /** Sites to bring over (a host such as `github.com` also takes its subdomains). `["*"]`: every site. */
  domains?: string[];
  /** Also session cookies (no expiry). Default false. */
  includeSession?: boolean;
}

export interface CookieImportResult {
  imported: number;
  /** Expired, session (unless asked for), app-bound and undecryptable ones. */
  skipped: number;
  domains: string[];
  warnings: Array<{ code: "app_bound" | "session" | "expired" | "other"; count: number }>;
  /** Chinese summary from the importer, when there is something to say. */
  note?: string;
}

interface RawImportResult {
  imported: number;
  expired: number;
  session: number;
  appBound: number;
  failed: number;
  domains: number;
  note?: string;
}

/**
 * Copies cookies for `domains` from an installed browser into the built-in browser (a panel
 * must be open). Without `domains`, the sites open in the built-in browser's tabs.
 * macOS asks once for the browser's Keychain item; Windows needs the browser quit.
 */
export async function importCookies(req: CookieImportRequest | { file: true }): Promise<CookieImportResult> {
  if ("file" in req) throw new Error("暂不支持从文件导入 Cookie");
  const { browser, profile } = splitSource(req.sourceId);
  let domains = (req.domains ?? []).map((d) => d.trim()).filter(Boolean);
  if (!domains.length) {
    const panels = await call<Array<{ id: string; url: string }>>("browser_list").catch(() => []);
    domains = [
      ...new Set(
        panels
          .map((p) => {
            try {
              const u = new URL(p.url);
              return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : "";
            } catch {
              return "";
            }
          })
          .filter(Boolean),
      ),
    ];
  }
  if (!domains.length) throw new Error("先在内置浏览器里打开要登录的网站，或选择要导入的网站");
  const r = await call<RawImportResult>("cookie_import", { browser, profile, domains, includeSession: req.includeSession ?? false });
  const warnings: CookieImportResult["warnings"] = [];
  if (r.appBound) warnings.push({ code: "app_bound", count: r.appBound });
  if (r.session) warnings.push({ code: "session", count: r.session });
  if (r.expired) warnings.push({ code: "expired", count: r.expired });
  if (r.failed) warnings.push({ code: "other", count: r.failed });
  return { imported: r.imported, skipped: r.expired + r.session + r.appBound + r.failed, domains, warnings, note: r.note };
}

// Xiaoyang wake hotkey & live call HUD ---------------------------------------------------------------

/** voice_status in src-tauri/src/voice/mod.rs. */
export interface VoiceRuntime {
  /** This build supports global wake hotkey (macOS and Windows). */
  supported: boolean;
  enabled: boolean;
  hotkey: string;
  kind?: "accelerator" | "modifier";
  /** The hotkey is live. */
  registered: boolean;
  /** Why it is not live (syntax, taken by another app, permission), in Chinese. */
  error?: string;
  warning?: string;
  /** Grant this first (`inputMonitoring`). */
  needsPermission?: "inputMonitoring";
  phase: "idle" | "connecting" | "active";
  lastError?: string;
}

export interface VoiceCallCommand {
  action: "start" | "hangup" | "toggle-mute";
  showHud?: boolean;
  seq?: number;
}

export interface VoiceCallMicEvent {
  pcmBase64: string;
  level: number;
}

export interface VoiceHudSyncState {
  state: "connecting" | "active" | "error";
  open?: boolean;
  seq?: number;
  phase?: "idle" | "thinking" | "speaking";
  muted?: boolean;
  level?: number;
  startedAt?: number | null;
  task?: string | null;
  caption?: string;
  dspBadge?: string | null;
  message?: string;
}

export interface HotkeyCheck {
  ok: boolean;
  kind?: "accelerator" | "modifier";
  error?: string;
  warning?: string;
  needsPermission?: "inputMonitoring";
}

export async function getVoiceRuntime(): Promise<VoiceRuntime | null> {
  return isTauri() ? call<VoiceRuntime>("voice_status").catch(() => null) : null;
}

export function onVoiceRuntimeState(cb: (s: VoiceRuntime) => void): () => void {
  return listenTauri<VoiceRuntime>("voice://state", cb);
}

export function onVoiceError(cb: (e: { message: string }) => void): () => void {
  return listenTauri<{ message: string }>("voice://error", cb);
}

export function onVoiceCallCommand(cb: (cmd: VoiceCallCommand) => void): () => void {
  return listenTauri<VoiceCallCommand>("voice://call-command", cb);
}

export function onVoiceCallMic(cb: (ev: VoiceCallMicEvent) => void): () => void {
  return listenTauri<VoiceCallMicEvent>("voice-call://mic", cb);
}

/** Can `hotkey` be used (syntax, taken by another app, permission)? Does not change the setting. */
export async function checkHotkey(hotkey: string): Promise<HotkeyCheck> {
  return call("voice_check_hotkey", { hotkey });
}

/** Re-reads config.json and retries the hotkey (after a permission was granted). */
export function voiceReload(): Promise<boolean> {
  return isTauri() ? call<boolean>("voice_reload") : Promise.resolve(false);
}

export function voiceCallMicStart(): Promise<void> {
  return call<void>("voice_call_mic_start");
}

export function voiceCallMicStop(): Promise<void> {
  return isTauri() ? call<void>("voice_call_mic_stop").catch(() => {}) : Promise.resolve();
}

export function voiceCallMicSetMuted(muted: boolean): Promise<void> {
  return isTauri() ? call<void>("voice_call_mic_set_muted", { muted }).catch(() => {}) : Promise.resolve();
}

export function voiceHudSync(state: VoiceHudSyncState): Promise<void> {
  return isTauri() ? call<void>("voice_hud_sync", { state }).catch(() => {}) : Promise.resolve();
}

export function voiceHudHide(): Promise<void> {
  return isTauri() ? call<void>("voice_hud_hide").catch(() => {}) : Promise.resolve();
}

// Error logging ----------------------------------------------------------------------------------------

let errorLoggingInstalled = false;

/** Sends uncaught errors and unhandled rejections to the desktop log (redacted there). Call once at startup. */
export function installErrorLogging(): void {
  if (errorLoggingInstalled || typeof window === "undefined") return;
  errorLoggingInstalled = true;
  let windowStart = Date.now();
  let windowCount = 0;
  let lastSig = "";
  const send = (kind: string, msg: string, data: Record<string, unknown>) => {
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    const sig = `${kind}:${msg}`;
    if (sig === lastSig && windowCount > 3) return;
    if (++windowCount > 30) return;
    lastSig = sig;
    logger.error(kind, msg.slice(0, 500), data);
  };
  window.addEventListener(
    "error",
    (e) => {
      const target = e.target as HTMLElement | null;
      if (e instanceof ErrorEvent || !target || target === (window as unknown as EventTarget)) {
        send("app.js", e.message || "script error", {
          source: e.filename ? e.filename.replace(/^.*\/(?=[^/]+$)/, "") : undefined,
          line: e.lineno,
          col: e.colno,
          stack: e.error instanceof Error ? e.error.stack : undefined,
        });
      } else {
        const tag = target.tagName?.toLowerCase() || "element";
        const src = (target as HTMLImageElement | HTMLScriptElement).src || "";
        send("app.resource", `failed to load <${tag}>`, {
          tag,
          src: src.slice(0, 180),
        });
      }
    },
    true,
  );
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason as { message?: string; name?: string; stack?: string } | string | undefined;
    send("app.js", typeof r === "string" ? r : r?.message || "unhandled rejection", {
      name: typeof r === "object" ? r?.name : undefined,
      stack: typeof r === "object" ? r?.stack : undefined,
    });
  });
}
