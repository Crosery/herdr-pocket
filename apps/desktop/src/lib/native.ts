/**
 * Desktop-only capabilities the UI asks for (docs/design/desktop-v2.md section 11).
 *
 * Commands in src-tauri (config, permissions, resources, logs) are invoked by name; the
 * embedded browser, cookie import and dictation go through native-engineer's ./bridge.
 * Outside Tauri every call answers "unsupported" instead of throwing, so each screen renders.
 */
import type { RpcResult } from "@herdr-pocket/protocol";
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
  fullDiskAccess?: Permission;
  /** macOS: what the 🌐/Fn key does now; "none" is needed to use Fn as the dictation key. */
  fnKeyAction?: "none" | "inputSource" | "emoji" | "dictation" | "unknown";
  appBundlePath?: string;
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

export interface FontCatalog {
  families: string[];
  herdrFont?: string;
  symbolsFont?: string;
}

export interface FontFaceMeta {
  id: number;
  family: string;
  weight: number;
  style: "normal" | "italic";
  format: string;
}

export interface LocalTermAttachResult {
  channel: number;
  cols: number;
  rows: number;
}

export interface LocalCreateShellResult {
  terminal: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface LocalTermDataEvent {
  id: string;
  data: string;
}

export interface LocalTermCloseEvent {
  id: string;
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
  openPermissionSettings: (kind: PermissionKind, register = false): Promise<void> =>
    inTauri() ? invoke("permission_open_settings", { kind, register }) : noop(),
  startAppBundleDrag: (): Promise<boolean> =>
    inTauri() ? invoke<boolean>("permission_drag_app_bundle").catch(() => false) : Promise.resolve(false),
  revealAppBundle: (): Promise<string | null> =>
    inTauri() ? invoke<string>("permission_reveal_app_bundle").catch(() => null) : Promise.resolve(null),

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

  // Local terminal direct `hc connect` bridge --------------------------------
  localHostDeviceId: async (): Promise<string | null> =>
    inTauri() ? invoke<string | null>("local_host_device_id").catch(() => null) : null,
  localTermCreateShell: (params: {
    cwd?: string;
    cols: number;
    rows: number;
    display?: Record<string, unknown>;
    spaceName?: string;
  }): Promise<LocalCreateShellResult> =>
    inTauri()
      ? invoke<LocalCreateShellResult>("local_term_create_shell", {
          cwd: params.cwd ?? null,
          cols: params.cols,
          rows: params.rows,
          display: params.display ?? null,
          spaceName: params.spaceName ?? null,
        })
      : Promise.reject(new Error("仅桌面端支持本地直连")),
  localTermAttach: (params: {
    id: string;
    terminal: string;
    cols: number;
    rows: number;
    history: number;
    display?: Record<string, unknown>;
  }): Promise<LocalTermAttachResult> =>
    inTauri() ? invoke<LocalTermAttachResult>("local_term_attach", params) : Promise.reject(new Error("仅桌面端支持本地直连")),
  localTermInput: (id: string, data: string): Promise<void> =>
    inTauri() ? invoke<void>("local_term_input", { id, data }) : Promise.resolve(),
  localTermResize: (id: string, cols: number, rows: number, display?: Record<string, unknown>): Promise<void> =>
    inTauri() ? invoke<void>("local_term_resize", { id, cols, rows, display: display ?? null }) : Promise.resolve(),
  localTermDetach: (id: string): Promise<void> =>
    inTauri() ? invoke<void>("local_term_detach", { id }).catch(() => {}) : Promise.resolve(),
  localTermReadImage: async (path: string): Promise<ArrayBuffer | null> =>
    inTauri() ? invoke<ArrayBuffer>("local_term_read_image", { path }).catch(() => null) : null,

  // System terminal fonts ----------------------------------------------------
  terminalListFonts: async (): Promise<FontCatalog | null> =>
    inTauri() ? invoke<FontCatalog>("terminal_list_fonts").catch(() => null) : null,
  terminalFontFaces: async (family: string): Promise<FontFaceMeta[]> =>
    inTauri() ? invoke<FontFaceMeta[]>("terminal_font_faces", { family }).catch(() => []) : [],
  terminalFontBytes: async (id: number): Promise<ArrayBuffer | null> =>
    inTauri() ? invoke<ArrayBuffer>("terminal_font_bytes", { id }).catch(() => null) : null,

  // Native folder/file dialog & local files ----------------------------------
  pickFolder: async (initialDir?: string): Promise<string | null> =>
    inTauri() ? invoke<string | null>("pick_folder", { initialDir: initialDir?.trim() || null }) : null,
  pickFile: async (initialDir?: string): Promise<string | null> =>
    inTauri() ? invoke<string | null>("pick_file", { initialDir: initialDir?.trim() || null }) : null,
  localReadFile: async (params: {
    cwd?: string;
    path: string;
    maxBytes?: number;
  }): Promise<RpcResult<"files.read"> | null> =>
    inTauri()
      ? invoke<RpcResult<"files.read">>("local_read_file", {
          cwd: params.cwd?.trim() || null,
          path: params.path,
          maxBytes: params.maxBytes ?? null,
        })
      : null,
  /** Zero-copy local asset URL backed by Tauri's `pocket-local` custom URI scheme (Range streaming, main webview only). */
  localFileStreamUrl: (path: string, cwd?: string): string | null => {
    if (!inTauri() || !path.trim()) return null;
    const origin =
      bridge.detectPlatform() === "windows"
        ? "http://pocket-local.localhost"
        : "pocket-local://localhost";
    const qs = new URLSearchParams({ path: path.trim() });
    if (cwd?.trim()) qs.set("cwd", cwd.trim());
    return `${origin}/file?${qs.toString()}`;
  },
};
