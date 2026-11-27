/**
 * Desktop-only capabilities the UI asks for (docs/design/desktop-v2.md section 11).
 *
 * Commands in src-tauri (config, permissions, resources, logs) are invoked by name; the
 * embedded browser, cookie import and dictation go through native-engineer's ./bridge.
 * Outside Tauri every call answers "unsupported" instead of throwing, so each screen renders.
 */
import type { AgentModelsResult, HerdrDoc, RpcResult } from "@herdr-pocket/protocol";
import * as bridge from "./bridge";
import type { VoiceAiTier } from "./voicePresets";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  try {
    return await mod.invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : (err as Error)?.message || String(err));
  }
}

const inTauri = () => bridge.isTauri();

export interface OsModifierState {
  supported: boolean;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const UNSUPPORTED_OS_MODIFIERS: OsModifierState = {
  supported: false,
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
};

export interface TrafficLightMetrics {
  supported: boolean;
  fullscreen: boolean;
  safeLeft: number;
  safeTop: number;
}

const UNSUPPORTED_TRAFFIC_LIGHTS: TrafficLightMetrics = {
  supported: false,
  fullscreen: false,
  safeLeft: 0,
  safeTop: 0,
};

export interface DirectTunnelInfo {
  localPort: number;
  remoteAddr: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Browser, cookie and voice wake shapes are in ./bridge.
export type {
  BrowserAiBridgePage,
  BrowserAiBridgeSpace,
  BrowserAiBridgeState,
  BrowserAiCommand,
  BrowserEvent,
  CookieBrowser as BrowserFamily,
  CookieImportResult,
  CookieSource,
  HotkeyCheck,
  VoiceCallCommand,
  VoiceCallMicEvent,
  VoiceHudSyncState,
  VoiceRuntime,
} from "./bridge";
type BrowserEvent = bridge.BrowserEvent;
type CookieSource = bridge.CookieSource;
type CookieImportResult = bridge.CookieImportResult;
type VoiceCallCommand = bridge.VoiceCallCommand;
type VoiceCallMicEvent = bridge.VoiceCallMicEvent;
type VoiceHudSyncState = bridge.VoiceHudSyncState;
type VoiceRuntime = bridge.VoiceRuntime;
type HotkeyCheck = bridge.HotkeyCheck;

/** permissions_status in src-tauri/src/perms.rs. */
export type Permission = "granted" | "denied" | "notDetermined" | "restricted" | "notApplicable" | "unknown";
export type PermissionKind = "microphone" | "accessibility" | "inputMonitoring" | "screenRecording" | "keyboard" | "fullDiskAccess";
export interface Permissions {
  platform: string;
  microphone: Permission;
  accessibility: Permission;
  inputMonitoring: Permission;
  screenRecording?: Permission;
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
  uiFamilies?: string[];
  herdrFont?: string;
  herdrFontSize?: number;
  herdrLineHeight?: number;
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

export interface LocalImageStat {
  urlPath: string;
  width: number;
  height: number;
  mime: string;
}

export interface DraggedOsItemNative {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export interface LocalTermDataEvent {
  id: string;
  data: string;
}

export interface LocalTermCloseEvent {
  id: string;
}

export interface LocalTermSizeEvent {
  terminal: string;
  cols: number;
  rows: number;
}

export interface VoiceCallDspInfo {
  active: boolean;
  badge: string | null;
}

export interface VoiceCallDspChunk {
  pcmBase64: string;
  level: number;
}

export interface LocalBtwRequest {
  harness: string;
  sessionKey?: string | null;
  localId?: string | null;
  cwd?: string | null;
  status?: string | null;
  title?: string | null;
  model?: string | null;
  prebuiltTranscript?: string | null;
  question: string;
  timeoutMs?: number | null;
}

export interface LocalBtwResult {
  answer: string;
  model?: string;
  durationMs: number;
}

export type { VoiceAiTier };

export interface VoiceAiState {
  supported: boolean;
  activeEngine: string;
  denoise: boolean;
  enhanceVocal: boolean;
  filter: boolean;
  tier: VoiceAiTier;
  recommendedTier: "denoise" | "sv" | "tse" | null;
  recommendReason: string | null;
  threshold: number;
  firstSpeaker: boolean;
  dpdfReady: boolean;
  vadReady: boolean;
  svReady: boolean;
  tseReady: boolean;
  svSizeMb: number;
  tseSizeMb: number;
  downloading: boolean;
  progress: number;
  dlLabel: string | null;
  dlError: string | null;
  enrolled: boolean;
  enrollSeconds: number;
  ortReady?: boolean;
  ortVersion?: string | null;
  prototypesCount?: number;
  consistency?: number;
  snrDb?: number | null;
  hasSample?: boolean;
}

export interface VoiceAiConfigPatch {
  denoise?: boolean;
  enhanceVocal?: boolean;
  filter?: boolean;
  tier?: VoiceAiTier;
  threshold?: number;
  firstSpeaker?: boolean;
}

export interface VoiceAiProgressEvent {
  downloading: boolean;
  progress: number;
  received: number;
  total: number;
  dlLabel?: string | null;
  dlError?: string | null;
  done?: boolean;
}

export interface VoiceAiBenchmarkResult {
  recommendedTier: "denoise" | "sv" | "tse";
  reason: string;
  dpdfUs: number;
  tseRtf: number;
  cores: number;
  ramMb: number;
  ortReady: boolean;
}

export interface VoiceAiEnrollEvent {
  level: number;
  seconds: number;
  full: boolean;
}

export interface VoiceAiEnrollResult {
  seconds: number;
  consistency: number;
  lowest: number;
  snrDb: number;
  prototypesCount: number;
  hasSample: boolean;
  state: VoiceAiState;
}

export interface VoiceAiTestEvent {
  level: number;
  speaking: boolean;
  score?: number;
  rawScore?: number;
  protoScore?: number;
  pass?: boolean;
  inferMs?: number;
}

export interface VoiceAiPreviewResult {
  pcmBase64: string;
  sampleRate: number;
  durationMs: number;
  processMs: number;
  inRmsDb: number;
  outRmsDb: number;
  suppressedRatio: number;
  usedDpdf: boolean;
  usedTse: boolean;
  svActive: boolean;
}

const DEMO_VOICE_AI_KEY = "herdr-pocket-demo-voice-ai-v1";
const demoProgressListeners = new Set<(e: VoiceAiProgressEvent) => void>();
const demoEnrollListeners = new Set<(e: VoiceAiEnrollEvent) => void>();
const demoTestListeners = new Set<(e: VoiceAiTestEvent) => void>();
let demoDownloadTimer: ReturnType<typeof setInterval> | null = null;
let demoEnrollTimer: ReturnType<typeof setInterval> | null = null;
let demoEnrollSecs = 0;
let demoTestTimer: ReturnType<typeof setInterval> | null = null;

function defaultDemoVoiceAiState(): VoiceAiState {
  return {
    supported: true,
    activeEngine: "onnx-dpdfnet",
    denoise: true,
    enhanceVocal: true,
    filter: false,
    tier: "auto",
    recommendedTier: "sv",
    recommendReason: "演示环境：降噪 1.4 ms/帧，推荐 68 MB 灵巧声纹门控",
    threshold: 0.38,
    firstSpeaker: true,
    dpdfReady: true,
    vadReady: true,
    svReady: true,
    tseReady: false,
    svSizeMb: 68,
    tseSizeMb: 142,
    downloading: false,
    progress: 0,
    dlLabel: null,
    dlError: null,
    enrolled: false,
    enrollSeconds: 0,
    ortReady: true,
    ortVersion: "1.21.0",
    prototypesCount: 0,
    consistency: 0,
    snrDb: null,
    hasSample: false,
  };
}

function readDemoVoiceAiState(): VoiceAiState {
  const base = defaultDemoVoiceAiState();
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(DEMO_VOICE_AI_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VoiceAiState>;
      return computeDemoEngine({ ...base, ...parsed, downloading: false, dlLabel: null, dlError: null });
    }
  } catch {
    // ignore storage errors
  }
  return base;
}

function computeDemoEngine(s: VoiceAiState): VoiceAiState {
  const active =
    !s.denoise && !s.enhanceVocal && !(s.filter && s.enrolled)
      ? "off"
      : s.tier === "tse" && s.tseReady && s.enrolled
        ? "onnx-voxlock"
        : "onnx-dpdfnet";
  return { ...s, activeEngine: active };
}

let demoVoiceAiMem: VoiceAiState | null = null;

function getDemoVoiceAi(): VoiceAiState {
  demoVoiceAiMem ??= readDemoVoiceAiState();
  return demoVoiceAiMem;
}

function setDemoVoiceAi(next: VoiceAiState): VoiceAiState {
  const computed = computeDemoEngine(next);
  demoVoiceAiMem = computed;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DEMO_VOICE_AI_KEY, JSON.stringify(computed));
    }
  } catch {
    // ignore
  }
  return computed;
}

function stopDemoEnrollTimer(): void {
  if (demoEnrollTimer) {
    clearInterval(demoEnrollTimer);
    demoEnrollTimer = null;
  }
}

function stopDemoTestTimer(): void {
  if (demoTestTimer) {
    clearInterval(demoTestTimer);
    demoTestTimer = null;
  }
}

function stopDemoDownloadTimer(): void {
  if (demoDownloadTimer) {
    clearInterval(demoDownloadTimer);
    demoDownloadTimer = null;
  }
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
  browserAiState: (): Promise<bridge.BrowserAiBridgeState | null> => bridge.browserAiState(),
  browserSyncSpaces: (spaces: bridge.BrowserAiBridgeSpace[], activeSpaceId: string | null): Promise<void> =>
    bridge.browserSyncSpaces(spaces, activeSpaceId),
  browserAiControl: (
    spaceId: string,
    action: "takeover" | "resume" | "handoff" | "close_space",
    reason?: string,
  ): Promise<void> => bridge.browserAiControl(spaceId, action, reason),
  onBrowserAiState: (cb: (s: bridge.BrowserAiBridgeState) => void): (() => void) => bridge.onBrowserAiState(cb),
  onBrowserAiCommand: (cb: (cmd: bridge.BrowserAiCommand) => void): (() => void) => bridge.onBrowserAiCommand(cb),

  // Cookie import (lib/bridge.ts) ------------------------------------------------
  cookieImportSupported: (): boolean => inTauri(),
  listCookieSources: (): Promise<CookieSource[]> => bridge.listCookieSources(),
  listCookieDomains: (sourceId: string): Promise<Array<{ domain: string; count: number }>> =>
    inTauri() ? bridge.listCookieDomains(sourceId) : Promise.resolve([]),
  importCookies: (req: bridge.CookieImportRequest): Promise<CookieImportResult> => {
    if (!inTauri()) return Promise.reject(new Error("导入 Cookie 需要 Herdr Pocket 桌面版"));
    return bridge.importCookies(req);
  },

  // Xiaoyang wake hotkey & live call HUD (lib/bridge.ts; settings live in config.json) -
  voiceSupported: (): boolean => inTauri(),
  getVoiceRuntime: (): Promise<VoiceRuntime | null> => bridge.getVoiceRuntime(),
  onVoiceRuntimeState: (cb: (s: VoiceRuntime) => void): (() => void) => bridge.onVoiceRuntimeState(cb),
  onVoiceError: (cb: (e: { message: string }) => void): (() => void) => bridge.onVoiceError(cb),
  onVoiceCallCommand: (cb: (cmd: VoiceCallCommand) => void): (() => void) => bridge.onVoiceCallCommand(cb),
  onVoiceCallMic: (cb: (ev: VoiceCallMicEvent) => void): (() => void) => bridge.onVoiceCallMic(cb),
  checkHotkey: (hotkey: string): Promise<HotkeyCheck | null> => (inTauri() ? bridge.checkHotkey(hotkey).catch(() => null) : Promise.resolve(null)),
  voiceSetRecordingHotkey: async (recording: boolean): Promise<void> => {
    if (inTauri()) await invoke<void>("voice_set_recording_hotkey", { recording }).catch(() => {});
  },
  voiceReload: (): Promise<boolean> => bridge.voiceReload(),
  voiceCallMicStart: (): Promise<void> => bridge.voiceCallMicStart(),
  voiceCallMicStop: (): Promise<void> => bridge.voiceCallMicStop(),
  voiceCallMicSetMuted: (muted: boolean): Promise<void> => bridge.voiceCallMicSetMuted(muted),
  voiceCallDspOpen: async (): Promise<VoiceCallDspInfo> =>
    inTauri()
      ? invoke<VoiceCallDspInfo>("voice_call_dsp_open").catch(() => ({ active: false, badge: null }))
      : { active: false, badge: null },
  voiceCallDspProcess: async (pcmBase64: string): Promise<VoiceCallDspChunk> =>
    inTauri()
      ? invoke<VoiceCallDspChunk>("voice_call_dsp_process", { pcmBase64 })
      : { pcmBase64, level: 0 },
  voiceCallDspClose: async (): Promise<void> =>
    inTauri() ? invoke<void>("voice_call_dsp_close").catch(() => {}) : noop(),
  voiceHudSync: (state: VoiceHudSyncState): Promise<void> => bridge.voiceHudSync(state),
  voiceHudHide: (): Promise<void> => bridge.voiceHudHide(),
  windowStartDragging: async (): Promise<void> =>
    inTauri() ? invoke<void>("window_start_dragging").catch(() => {}) : noop(),
  windowToggleMaximize: async (): Promise<void> =>
    inTauri() ? invoke<void>("window_toggle_maximize").catch(() => {}) : noop(),

  // Local SOTA Audio DSP & Voiceprint (src-tauri/src/voice_ai.rs + Demo Mode) ---
  voiceAiState: async (): Promise<VoiceAiState> =>
    inTauri() ? invoke<VoiceAiState>("voice_ai_state") : Promise.resolve(getDemoVoiceAi()),
  voiceAiSetConfig: async (changes: VoiceAiConfigPatch): Promise<VoiceAiState> => {
    if (inTauri()) return invoke<VoiceAiState>("voice_ai_set_config", { changes });
    const cur = getDemoVoiceAi();
    return setDemoVoiceAi({
      ...cur,
      ...(changes.denoise !== undefined ? { denoise: changes.denoise } : {}),
      ...(changes.enhanceVocal !== undefined ? { enhanceVocal: changes.enhanceVocal } : {}),
      ...(changes.filter !== undefined ? { filter: changes.filter } : {}),
      ...(changes.tier !== undefined ? { tier: changes.tier } : {}),
      ...(changes.threshold !== undefined ? { threshold: Math.min(0.8, Math.max(0.15, changes.threshold)) } : {}),
      ...(changes.firstSpeaker !== undefined ? { firstSpeaker: changes.firstSpeaker } : {}),
    });
  },
  voiceAiDownload: async (tier: "base" | "sv" | "tse"): Promise<VoiceAiState> => {
    if (inTauri()) return invoke<VoiceAiState>("voice_ai_download", { tier });
    stopDemoDownloadTimer();
    const cur = getDemoVoiceAi();
    const totalMb = tier === "tse" ? cur.tseSizeMb : tier === "sv" ? cur.svSizeMb : 10;
    const total = totalMb * 1024 * 1024;
    const dlLabel =
      tier === "tse"
        ? `旗舰声纹分离包（约 ${cur.tseSizeMb} MB）`
        : tier === "sv"
          ? `灵巧声纹模型（约 ${cur.svSizeMb} MB）`
          : "基础降噪引擎 (DPDFNet + VAD)";
    setDemoVoiceAi({ ...cur, downloading: true, progress: 0, dlLabel, dlError: null });
    return new Promise<VoiceAiState>((resolve) => {
      let step = 0;
      const steps = 8;
      demoDownloadTimer = setInterval(() => {
        step += 1;
        const prog = Math.min(1, step / steps);
        const done = step >= steps;
        const nextState = setDemoVoiceAi({
          ...getDemoVoiceAi(),
          downloading: !done,
          progress: prog,
          dlLabel: done ? null : dlLabel,
          dlError: null,
          ...(done ? { dpdfReady: true, vadReady: true } : {}),
          ...(done && (tier === "sv" || tier === "tse") ? { svReady: true } : {}),
          ...(done && tier === "tse" ? { tseReady: true } : {}),
        });
        const ev: VoiceAiProgressEvent = {
          downloading: !done,
          progress: prog,
          received: Math.round(total * prog),
          total,
          dlLabel: done ? null : dlLabel,
          dlError: null,
          done,
        };
        demoProgressListeners.forEach((cb) => cb(ev));
        if (done) {
          stopDemoDownloadTimer();
          resolve(nextState);
        }
      }, 90);
    });
  },
  voiceAiCancelDownload: async (): Promise<boolean> => {
    if (inTauri()) return invoke<boolean>("voice_ai_cancel_download");
    stopDemoDownloadTimer();
    const cur = getDemoVoiceAi();
    setDemoVoiceAi({ ...cur, downloading: false, progress: 0, dlLabel: null });
    demoProgressListeners.forEach((cb) =>
      cb({ downloading: false, progress: 0, received: 0, total: 0, dlLabel: null, dlError: null, done: false }),
    );
    return true;
  },
  voiceAiBenchmark: async (): Promise<VoiceAiBenchmarkResult> => {
    if (inTauri()) return invoke<VoiceAiBenchmarkResult>("voice_ai_benchmark");
    await new Promise((r) => setTimeout(r, 240));
    const cur = getDemoVoiceAi();
    const rec: "sv" | "tse" = cur.tseReady ? "tse" : "sv";
    const reason =
      rec === "tse"
        ? "演示环境：实测分离负载 42%（单帧降噪 1.38 ms），可流畅运行旗舰分离模型"
        : "演示环境：实测降噪 1.38 ms/帧（8核），推荐 68 MB 灵巧声纹门控";
    setDemoVoiceAi({ ...cur, recommendedTier: rec, recommendReason: reason });
    return {
      recommendedTier: rec,
      reason,
      dpdfUs: 1380,
      tseRtf: 0.42,
      cores: 8,
      ramMb: 16384,
      ortReady: true,
    };
  },
  voiceAiStartEnroll: async (): Promise<void> => {
    if (inTauri()) return invoke<void>("voice_ai_start_enroll");
    stopDemoEnrollTimer();
    stopDemoTestTimer();
    demoEnrollSecs = 0;
    demoEnrollTimer = setInterval(() => {
      demoEnrollSecs = Math.min(20, demoEnrollSecs + 0.25);
      const level = 0.28 + Math.abs(Math.sin(demoEnrollSecs * 3.1)) * 0.52;
      demoEnrollListeners.forEach((cb) =>
        cb({ level, seconds: Number(demoEnrollSecs.toFixed(2)), full: demoEnrollSecs >= 18 }),
      );
    }, 200);
  },
  voiceAiFinishEnroll: async (): Promise<VoiceAiEnrollResult> => {
    if (inTauri()) return invoke<VoiceAiEnrollResult>("voice_ai_finish_enroll");
    stopDemoEnrollTimer();
    const secs = Math.max(6.2, demoEnrollSecs);
    const next = setDemoVoiceAi({
      ...getDemoVoiceAi(),
      enrolled: true,
      filter: true,
      enrollSeconds: Number(secs.toFixed(1)),
      prototypesCount: 4,
      consistency: 0.91,
      snrDb: 24.6,
      hasSample: true,
    });
    return {
      seconds: next.enrollSeconds,
      consistency: 0.91,
      lowest: 0.84,
      snrDb: 24.6,
      prototypesCount: 4,
      hasSample: true,
      state: next,
    };
  },
  voiceAiCancelEnroll: async (): Promise<boolean> => {
    if (inTauri()) return invoke<boolean>("voice_ai_cancel_enroll");
    stopDemoEnrollTimer();
    demoEnrollSecs = 0;
    return true;
  },
  voiceAiClearVoiceprint: async (): Promise<VoiceAiState> => {
    if (inTauri()) return invoke<VoiceAiState>("voice_ai_clear_voiceprint");
    stopDemoEnrollTimer();
    stopDemoTestTimer();
    return setDemoVoiceAi({
      ...getDemoVoiceAi(),
      enrolled: false,
      filter: false,
      enrollSeconds: 0,
      prototypesCount: 0,
      consistency: 0,
      snrDb: null,
      hasSample: false,
    });
  },
  voiceAiExportVoiceprint: async (): Promise<{ voiceprint: Record<string, unknown>; sampleBase64?: string } | null> => {
    if (inTauri()) {
      return invoke<{ voiceprint: Record<string, unknown>; sampleBase64?: string } | null>("voice_ai_export_voiceprint");
    }
    const cur = getDemoVoiceAi();
    if (!cur.enrolled) return null;
    return {
      voiceprint: {
        embedding: Array.from({ length: 192 }, () => 0.07),
        prototypes: [Array.from({ length: 192 }, () => 0.07)],
        modelVersion: "eres2netv2-voxlock-v2",
        seconds: cur.enrollSeconds || 5,
        consistency: cur.consistency || 0.9,
      },
    };
  },
  voiceAiImportVoiceprint: async (payload: { voiceprint: Record<string, unknown>; sampleBase64?: string }): Promise<VoiceAiState> => {
    if (inTauri()) {
      return invoke<VoiceAiState>("voice_ai_import_voiceprint", { payload });
    }
    return setDemoVoiceAi({
      ...getDemoVoiceAi(),
      enrolled: true,
      filter: true,
      enrollSeconds: Number((payload.voiceprint?.seconds as number) || 5),
      prototypesCount: Array.isArray(payload.voiceprint?.prototypes) ? payload.voiceprint.prototypes.length : 1,
      consistency: Number((payload.voiceprint?.consistency as number) || 0.9),
      hasSample: Boolean(payload.sampleBase64),
    });
  },
  voiceAiEnrollFromPcm: async (pcmBase64: string): Promise<VoiceAiEnrollResult> => {
    if (inTauri()) {
      return invoke<VoiceAiEnrollResult>("voice_ai_enroll_from_pcm", { pcmBase64 });
    }
    if (!pcmBase64) throw new Error("音频文件为空");
    const next = setDemoVoiceAi({
      ...getDemoVoiceAi(),
      enrolled: true,
      filter: true,
      svReady: true,
      vadReady: true,
      enrollSeconds: 6.4,
      prototypesCount: 4,
      consistency: 0.92,
      snrDb: 26.1,
      hasSample: true,
    });
    return {
      seconds: 6.4,
      consistency: 0.92,
      lowest: 0.86,
      snrDb: 26.1,
      prototypesCount: 4,
      hasSample: true,
      state: next,
    };
  },
  voiceAiStartTest: async (threshold?: number): Promise<void> => {
    if (inTauri()) return invoke<void>("voice_ai_start_test", { threshold: threshold ?? null });
    stopDemoEnrollTimer();
    stopDemoTestTimer();
    const thr = threshold ?? getDemoVoiceAi().threshold;
    let tick = 0;
    demoTestTimer = setInterval(() => {
      tick += 1;
      const level = 0.25 + Math.abs(Math.sin(tick * 0.9)) * 0.55;
      const ev: VoiceAiTestEvent =
        tick >= 2
          ? {
              level,
              speaking: true,
              score: 0.92,
              rawScore: 0.89,
              protoScore: 0.94,
              pass: 0.92 >= thr,
              inferMs: 18,
            }
          : { level, speaking: true };
      demoTestListeners.forEach((cb) => cb(ev));
    }, 200);
  },
  voiceAiStopTest: async (): Promise<boolean> => {
    if (inTauri()) return invoke<boolean>("voice_ai_stop_test");
    stopDemoTestTimer();
    return true;
  },
  voiceAiPreviewProcess: async (pcmBase64: string): Promise<VoiceAiPreviewResult> => {
    if (inTauri()) return invoke<VoiceAiPreviewResult>("voice_ai_preview_process", { pcmBase64 });
    // Real lightweight PCM16 DSP fallback for Web/H5/Demo preview (HPF + noise gate + vocal presence + soft limit).
    const t0 = performance.now();
    const bin = atob(pcmBase64);
    const len = bin.length - (bin.length % 2);
    const samples = len / 2;
    const raw = new Int16Array(samples);
    for (let i = 0; i < samples; i++) {
      const lo = bin.charCodeAt(i * 2);
      const hi = bin.charCodeAt(i * 2 + 1);
      const v = (hi << 8) | lo;
      raw[i] = v >= 0x8000 ? v - 0x10000 : v;
    }
    const cfg = getDemoVoiceAi();
    const out = new Int16Array(samples);
    let inSq = 0;
    let outSq = 0;
    let prevIn = 0;
    let prevOut = 0;
    let prevPres = 0;
    let env = 0;
    let suppressed = 0;
    for (let i = 0; i < samples; i++) {
      const x = raw[i]! / 32768;
      inSq += x * x;
      let y = x;
      if (cfg.denoise) {
        // Simple 1st-order ~90Hz HPF + soft noise floor gate
        y = 0.965 * (prevOut + x - prevIn);
        prevIn = x;
        prevOut = y;
        env = 0.96 * env + 0.04 * Math.abs(y);
        if (env < 0.014) {
          const g = Math.max(0.08, env / 0.014);
          y *= g;
          if (g < 0.35) suppressed += 1;
        }
      }
      if (cfg.enhanceVocal) {
        // Gentle presence emphasis + soft tanh limiter
        const hi = y - prevPres * 0.72;
        prevPres = y;
        y = Math.tanh((y + hi * 0.32) * 1.25);
      } else if (cfg.denoise) {
        y = Math.tanh(y * 1.05);
      }
      outSq += y * y;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(y * 32767)));
    }
    const u8 = new Uint8Array(out.buffer);
    let outBin = "";
    const CHUNK = 8192;
    for (let i = 0; i < u8.length; i += CHUNK) {
      outBin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
    }
    const n = Math.max(1, samples);
    const inDb = Math.round(20 * Math.log10(Math.max(1e-6, Math.sqrt(inSq / n))) * 10) / 10;
    const outDb = Math.round(20 * Math.log10(Math.max(1e-6, Math.sqrt(outSq / n))) * 10) / 10;
    return {
      pcmBase64: btoa(outBin),
      sampleRate: 16000,
      durationMs: Math.round((samples / 16000) * 1000),
      processMs: Math.round((performance.now() - t0) * 10) / 10,
      inRmsDb: inDb,
      outRmsDb: outDb,
      suppressedRatio: Math.round((suppressed / n) * 1000) / 1000,
      usedDpdf: cfg.denoise,
      usedTse: cfg.tier === "tse" && cfg.filter,
      svActive: cfg.enrolled && cfg.filter,
    };
  },
  onVoiceAiProgress: (cb: (e: VoiceAiProgressEvent) => void): (() => void) => {
    if (inTauri()) return onNativeEvent<VoiceAiProgressEvent>("voice-ai://progress", cb);
    demoProgressListeners.add(cb);
    return () => demoProgressListeners.delete(cb);
  },
  onVoiceAiEnroll: (cb: (e: VoiceAiEnrollEvent) => void): (() => void) => {
    if (inTauri()) return onNativeEvent<VoiceAiEnrollEvent>("voice-ai://enroll", cb);
    demoEnrollListeners.add(cb);
    return () => demoEnrollListeners.delete(cb);
  },
  onVoiceAiTest: (cb: (e: VoiceAiTestEvent) => void): (() => void) => {
    if (inTauri()) return onNativeEvent<VoiceAiTestEvent>("voice-ai://test", cb);
    demoTestListeners.add(cb);
    return () => demoTestListeners.delete(cb);
  },

  // Permissions ------------------------------------------------------------
  getPermissions: async (): Promise<Permissions | null> => (inTauri() ? invoke<Permissions>("permissions_status").catch(() => null) : null),
  onPermissionsChanged: (cb: (p: Permissions) => void): (() => void) =>
    inTauri() ? onNativeEvent<Permissions>("app://permissions", cb) : () => {},
  requestPermission: (kind: PermissionKind): Promise<Permissions> => invoke<Permissions>("permission_request", { kind }),
  openPermissionSettings: (kind: PermissionKind, register = false): Promise<void> =>
    inTauri() ? invoke("permission_open_settings", { kind, register }) : noop(),
  resetMacPermission: async (kind: PermissionKind): Promise<Permissions> => {
    if (inTauri()) return invoke<Permissions>("reset_mac_permission", { kind });
    const platform = bridge.detectPlatform();
    const mac = platform === "macos";
    return {
      platform: platform === "windows" ? "windows" : platform === "linux" ? "linux" : "macos",
      microphone: kind === "microphone" ? "notDetermined" : "granted",
      accessibility: mac ? (kind === "accessibility" ? "notDetermined" : "denied") : "notApplicable",
      inputMonitoring: mac ? (kind === "inputMonitoring" ? "notDetermined" : "denied") : "notApplicable",
      screenRecording: mac ? (kind === "screenRecording" ? "notDetermined" : "denied") : "notApplicable",
      fullDiskAccess: mac ? (kind === "fullDiskAccess" ? "notDetermined" : "denied") : "notApplicable",
      appBundlePath: mac ? "/Applications/Herdr Pocket.app" : undefined,
      notes: [],
    };
  },
  relaunchApp: async (): Promise<boolean> => {
    if (inTauri()) {
      await invoke("relaunch_app");
      return true;
    }
    return false;
  },
  startAppBundleDrag: (): Promise<boolean> =>
    inTauri() ? invoke<boolean>("permission_drag_app_bundle").catch(() => false) : Promise.resolve(false),
  revealAppBundle: (): Promise<string | null> =>
    inTauri() ? invoke<string>("permission_reveal_app_bundle").catch(() => null) : Promise.resolve(null),

  // Resources ----------------------------------------------------------------
  getResourceUsage: async (): Promise<ResourceUsage | null> => (inTauri() ? invoke<ResourceUsage>("resource_usage").catch(() => null) : null),
  /** Bytes freed. */
  clearCaches: (): Promise<number> => (inTauri() ? invoke<number>("clear_caches") : Promise.resolve(0)),

  // Logs -------------------------------------------------------------------
  writeLog: (level: string, kind: string, msg: string, data?: Record<string, unknown>): Promise<void> =>
    inTauri() ? invoke<void>("log_write", { level, kind, msg, data: data ?? null }).catch(() => {}) : noop(),
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
    spaceId?: string;
    tabId?: string;
    argv?: string[];
  }): Promise<LocalCreateShellResult> =>
    inTauri()
      ? invoke<LocalCreateShellResult>("local_term_create_shell", {
          cwd: params.cwd ?? null,
          cols: params.cols,
          rows: params.rows,
          display: params.display ?? null,
          spaceName: params.spaceName ?? null,
          spaceId: params.spaceId ?? null,
          tabId: params.tabId ?? null,
          argv: params.argv ?? null,
        })
      : Promise.reject(new Error("仅桌面端支持本地直连")),
  localTermAttach: async (params: {
    id: string;
    terminal: string;
    cols: number;
    rows: number;
    history: number;
    focused?: boolean;
    display?: Record<string, unknown>;
    onData?: (bytes: Uint8Array) => void;
  }): Promise<LocalTermAttachResult> => {
    if (!inTauri()) throw new Error("仅桌面端支持本地直连");
    const mod = await import("@tauri-apps/api/core");
    const cb = params.onData;
    const ch = new mod.Channel<ArrayBuffer>((raw) => {
      if (!cb) return;
      if (raw instanceof ArrayBuffer) {
        cb(new Uint8Array(raw));
      } else if (ArrayBuffer.isView(raw)) {
        const v = raw as ArrayBufferView;
        cb(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      } else if (Array.isArray(raw)) {
        cb(Uint8Array.from(raw));
      }
    });
    return mod.invoke<LocalTermAttachResult>("local_term_attach", {
      id: params.id,
      terminal: params.terminal,
      cols: params.cols,
      rows: params.rows,
      history: params.history,
      focused: params.focused ?? null,
      display: params.display ?? null,
      onData: ch,
    });
  },
  localTermInput: (id: string, data: string): Promise<void> =>
    inTauri() ? invoke<void>("local_term_input", { id, data }) : Promise.resolve(),
  localTermAutoInput: (id: string, data: string): Promise<void> =>
    inTauri() ? invoke<void>("local_term_auto_input", { id, data }) : Promise.resolve(),
  localTermFocus: (id: string, focused: boolean): Promise<void> =>
    inTauri() ? invoke<void>("local_term_focus", { id, focused }).catch(() => {}) : Promise.resolve(),
  localTermResize: (id: string, cols: number, rows: number, display?: Record<string, unknown>): Promise<void> =>
    inTauri() ? invoke<void>("local_term_resize", { id, cols, rows, display: display ?? null }) : Promise.resolve(),
  localTermDetach: (id: string): Promise<void> =>
    inTauri() ? invoke<void>("local_term_detach", { id }).catch(() => {}) : Promise.resolve(),
  localTermKill: (terminal: string): Promise<void> =>
    inTauri() ? invoke<void>("local_term_kill", { terminal }) : Promise.resolve(),
  localTermKeys: (terminal: string, keys: string[]): Promise<void> =>
    inTauri() ? invoke<void>("local_term_keys", { terminal, keys }) : Promise.resolve(),
  localTermInterrupt: (terminal: string): Promise<string> =>
    inTauri() ? invoke<string>("local_term_interrupt", { terminal }) : Promise.resolve(""),
  localHerdrDocGet: async (): Promise<{ value: HerdrDoc | null; version: number } | null> =>
    inTauri() ? invoke<{ value: HerdrDoc | null; version: number }>("local_herdr_doc_get").catch(() => null) : null,
  localHerdrDocSet: async (
    value: HerdrDoc,
    version: number,
  ): Promise<{ ok: boolean; conflict?: boolean; value?: HerdrDoc | null; version: number }> => {
    if (!inTauri()) throw new Error("仅桌面端支持本地文档写入");
    return invoke<{ ok: boolean; conflict?: boolean; value?: HerdrDoc | null; version: number }>(
      "local_herdr_doc_set",
      { value, version },
    );
  },
  localTermReadImage: async (path: string): Promise<ArrayBuffer | null> =>
    inTauri() ? invoke<ArrayBuffer>("local_term_read_image", { path }).catch(() => null) : null,
  localTermStatImage: async (path: string, deleteAfter?: boolean): Promise<LocalImageStat | null> =>
    inTauri()
      ? invoke<LocalImageStat>("local_term_stat_image", { path, deleteAfter: deleteAfter ?? null }).catch(() => null)
      : null,
  localAgentModels: async (params: {
    harness: string;
    currentModel?: string;
    sessionKey?: string;
  }): Promise<AgentModelsResult | null> =>
    inTauri()
      ? invoke<AgentModelsResult>("local_agent_models", {
          harness: params.harness,
          currentModel: params.currentModel ?? null,
          sessionKey: params.sessionKey ?? null,
        }).catch(() => null)
      : null,
  localAgentBtw: (req: LocalBtwRequest): Promise<LocalBtwResult> =>
    inTauri()
      ? invoke<LocalBtwResult>("local_agent_btw", { req })
      : Promise.reject(new Error("仅桌面端支持本地旁路提问")),

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
  localRevealInFolder: (params: { path: string; cwd?: string }): Promise<void> =>
    inTauri()
      ? invoke<void>("local_reveal_in_folder", {
          cwd: params.cwd?.trim() || null,
          path: params.path,
        })
      : Promise.reject(new Error("仅桌面端支持本地文件操作")),
  localOpenFile: (params: { path: string; cwd?: string }): Promise<void> =>
    inTauri()
      ? invoke<void>("local_open_file", {
          cwd: params.cwd?.trim() || null,
          path: params.path,
        })
      : Promise.reject(new Error("仅桌面端支持本地文件操作")),
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
  /** Scoped capability URL (`pocket-local://localhost/cap/<token>/...`) usable inside HTML iframe & built-in browser. */
  registerLocalPreviewUrl: async (path: string, cwd?: string): Promise<string | null> => {
    if (!inTauri() || !path.trim()) return null;
    return invoke<string>("register_local_preview_token", {
      cwd: cwd?.trim() || null,
      path: path.trim(),
    });
  },
  /** In-memory HTML capability URL (`pocket-local://localhost/cap/mem-<token>/...`) for remote HTML previews without CSP `srcdoc` restrictions. */
  registerMemHtmlPreview: async (fileName: string, html: string): Promise<string | null> => {
    if (!inTauri() || !html) return null;
    return invoke<string>("register_mem_html_preview", {
      fileName: fileName.trim() || "preview.html",
      html,
    });
  },
  readOsDragPaths: async (): Promise<DraggedOsItemNative[]> =>
    inTauri() ? invoke<DraggedOsItemNative[]>("read_os_drag_paths").catch(() => []) : [],
  workspaceStateLoad: async (): Promise<string | null> =>
    inTauri() ? invoke<string | null>("workspace_state_load").catch(() => null) : null,
  workspaceStateSave: async (raw: string): Promise<void> =>
    inTauri() ? invoke<void>("workspace_state_save", { raw }) : Promise.resolve(),
  queryOsModifiers: async (): Promise<OsModifierState> =>
    inTauri() ? invoke<OsModifierState>("query_os_modifiers").catch(() => UNSUPPORTED_OS_MODIFIERS) : UNSUPPORTED_OS_MODIFIERS,
  openDirectTunnel: async (addrs: string[], port: number, expectedHostId?: string): Promise<DirectTunnelInfo | null> =>
    inTauri() ? invoke<DirectTunnelInfo>("open_direct_tunnel", { addrs, port, expectedHostId }).catch(() => null) : null,
  localPortalCaptureFrame: async (params: {
    windowId: string;
    maxWidth?: number;
    quality?: number;
    showCursor?: boolean;
    fps?: number;
    sinceSeq?: string;
  }): Promise<ArrayBuffer | null> =>
    inTauri()
      ? invoke<ArrayBuffer>("local_portal_capture_frame", {
          windowId: params.windowId,
          maxWidth: params.maxWidth ?? 1600,
          quality: params.quality ?? 68,
          showCursor: params.showCursor ?? true,
          fps: params.fps ?? 30,
          sinceSeq: params.sinceSeq ?? null,
        })
      : null,
  queryTrafficLightMetrics: async (): Promise<TrafficLightMetrics> =>
    inTauri()
      ? invoke<TrafficLightMetrics>("query_traffic_light_metrics").catch(() => UNSUPPORTED_TRAFFIC_LIGHTS)
      : UNSUPPORTED_TRAFFIC_LIGHTS,
  onTrafficLightMetrics: (cb: (metrics: TrafficLightMetrics) => void): (() => void) => {
    if (!inTauri()) return () => {};
    let alive = true;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<TrafficLightMetrics>("app://traffic-lights", (ev) => {
          if (alive && ev.payload) cb(ev.payload);
        }),
      )
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  },
};
