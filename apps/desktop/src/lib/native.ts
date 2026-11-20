/**
 * Desktop-only capabilities the UI asks for (docs/design/desktop-v2.md section 11).
 *
 * Commands in src-tauri (config, permissions, resources, logs) are invoked by name; the
 * embedded browser, cookie import and dictation go through native-engineer's ./bridge.
 * Outside Tauri every call answers "unsupported" instead of throwing, so each screen renders.
 */
import * as bridge from "./bridge";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  try {
    return await mod.invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : (err as Error)?.message || String(err));
  }
}

const inTauri = () => bridge.isTauri();

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Browser, cookie and dictation shapes are native-engineer's (lib/bridge.ts).
export type {
  BrowserEvent,
  CookieBrowser as BrowserFamily,
  CookieImportResult,
  CookieSource,
  HotkeyCheck,
  VoiceEvent,
  VoiceRuntime,
} from "./bridge";
type BrowserEvent = bridge.BrowserEvent;
type CookieSource = bridge.CookieSource;
type CookieImportResult = bridge.CookieImportResult;
type VoiceEvent = bridge.VoiceEvent;
type VoiceRuntime = bridge.VoiceRuntime;
type HotkeyCheck = bridge.HotkeyCheck;

/** permissions_status in src-tauri/src/perms.rs. */
export type Permission = "granted" | "denied" | "notDetermined" | "restricted" | "notApplicable" | "unknown";
export type PermissionKind = "microphone" | "accessibility" | "inputMonitoring" | "keyboard" | "fullDiskAccess";
export interface Permissions {
  platform: string;
  microphone: Permission;
  accessibility: Permission;
  inputMonitoring: Permission;
  /** macOS: what the 🌐/Fn key does now; "none" is needed to use Fn as the dictation key. */
  fnKeyAction?: "none" | "inputSource" | "emoji" | "dictation" | "unknown";
  notes: string[];
}

/** resource_usage in src-tauri/src/resources.rs. */
export interface ResourceUsage {
  process: { rssBytes: number; footprintBytes?: number; cpuSeconds: number; wakeups?: number; webviewBytes?: number };
  cpuPercent?: number;
  wakeupsPerSec?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  onBattery?: boolean;
  systemLowPower?: boolean;
  lowPower: boolean;
  logBytes: number;
  cacheBytes: number;
  browserDataBytes: number;
  windowVisible: boolean;
  warnings: string[];
}

/** config_load / config_set in src-tauri/src/config.rs. */
export interface ConfigFileInfo {
  path: string;
  exists: boolean;
  raw: Record<string, unknown>;
  mtime?: number;
  error?: string;
}

export interface LogFolderInfo {
  dir: string;
  files: Array<{ name: string; bytes: number; modified: number }>;
  totalBytes: number;
  queuedForRelay: number;
}


const noop = async () => {};
const unsubscribeNoop = () => () => {};

/** Tauri event subscription that is safe to call anywhere; returns an unsubscribe. */
export function onNativeEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri()) return () => {};
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

export const native = {
  available: inTauri,

  // Config file -----------------------------------------------------------
  configLoad: async (): Promise<ConfigFileInfo | null> => (inTauri() ? invoke<ConfigFileInfo>("config_load") : null),
  configSet: (changes: Record<string, unknown>): Promise<ConfigFileInfo> => invoke<ConfigFileInfo>("config_set", { changes }),
  configReveal: (): Promise<void> => (inTauri() ? invoke("config_reveal") : noop()),
  /** Opens config.json in the default editor; older builds without config_open show it in its folder. */
  configOpen: async (): Promise<"opened" | "revealed"> => {
    if (!inTauri()) return "revealed";
    try {
      await invoke("config_open");
      return "opened";
    } catch {
      await invoke("config_reveal");
      return "revealed";
    }
  },

  // Embedded browser (lib/bridge.ts) ---------------------------------------------
  browserSupported: (): boolean => inTauri(),
  browserOpen: (id: string, url: string, rect: Rect): Promise<void> => (inTauri() ? bridge.browserOpen(id, url, rect) : noop()),
  browserSetBounds: (id: string, rect: Rect): Promise<void> => bridge.browserSetBounds(id, rect),
  browserNavigate: (id: string, op: bridge.BrowserNavOp): Promise<void> => (inTauri() ? bridge.browserNavigate(id, op) : noop()),
  browserSetVisible: (id: string, visible: boolean): Promise<void> => bridge.browserSetVisible(id, visible),
  browserClose: (id: string): Promise<void> => bridge.browserClose(id),
  onBrowserEvent: (cb: (e: BrowserEvent) => void): (() => void) => bridge.onBrowserEvent(cb),
  browserClearData: (): Promise<number> => bridge.browserClearData(),
  browserStoreKind: (): Promise<"persistent" | "session" | null> => bridge.browserStoreKind(),

  // Cookie import (lib/bridge.ts) ------------------------------------------------
  cookieImportSupported: (): boolean => inTauri(),
  listCookieSources: (): Promise<CookieSource[]> => bridge.listCookieSources(),
  listCookieDomains: (sourceId: string): Promise<Array<{ domain: string; count: number }>> =>
    inTauri() ? bridge.listCookieDomains(sourceId) : Promise.resolve([]),
  importCookies: (req: bridge.CookieImportRequest): Promise<CookieImportResult> => {
    if (!inTauri()) return Promise.reject(new Error("导入 Cookie 需要 Herdr Pocket 桌面版"));
    return bridge.importCookies(req);
  },

  // Dictation runtime (lib/bridge.ts; its settings live in config.json) -------------
  voiceSupported: (): boolean => inTauri(),
  getVoiceRuntime: (): Promise<VoiceRuntime | null> => bridge.getVoiceRuntime(),
  onVoiceEvent: (cb: (e: VoiceEvent) => void): (() => void) => bridge.onVoiceEvent(cb),
  checkHotkey: (hotkey: string): Promise<HotkeyCheck | null> => (inTauri() ? bridge.checkHotkey(hotkey).catch(() => null) : Promise.resolve(null)),
  voiceReload: (): Promise<boolean> => bridge.voiceReload(),
  getTranscribeInfo: () => bridge.getTranscribeInfo(),

  // Permissions ------------------------------------------------------------
  getPermissions: async (): Promise<Permissions | null> => (inTauri() ? invoke<Permissions>("permissions_status").catch(() => null) : null),
  requestPermission: (kind: PermissionKind): Promise<Permissions> => invoke<Permissions>("permission_request", { kind }),
  openPermissionSettings: (kind: PermissionKind): Promise<void> => (inTauri() ? invoke("permission_open_settings", { kind }) : noop()),

  // Resources ----------------------------------------------------------------
  getResourceUsage: async (): Promise<ResourceUsage | null> => (inTauri() ? invoke<ResourceUsage>("resource_usage").catch(() => null) : null),
  /** Bytes freed. */
  clearCaches: (): Promise<number> => (inTauri() ? invoke<number>("clear_caches") : Promise.resolve(0)),

  // Logs -------------------------------------------------------------------
  writeLog: (level: string, kind: string, msg: string): Promise<void> =>
    inTauri() ? invoke<void>("log_write", { level, kind, msg, data: null }).catch(() => {}) : noop(),
  logInfo: async (): Promise<LogFolderInfo | null> => (inTauri() ? invoke<LogFolderInfo | null>("log_info").catch(() => null) : null),
  openLogFolder: (): Promise<void> => (inTauri() ? invoke("log_open_folder") : noop()),
  /** Path of the written diagnostics file. */
  exportDiagnostics: (context?: Record<string, unknown>): Promise<string> => invoke<string>("log_export_diagnostics", { context: context ?? null }),
  /** Lines sent. */
  uploadLogsNow: (): Promise<number> => (inTauri() ? invoke<number>("log_upload_now") : Promise.resolve(0)),
};
