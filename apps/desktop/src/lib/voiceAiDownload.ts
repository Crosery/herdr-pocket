/**
 * App-wide background download controller for local voiceprint / audio enhancement models.
 *
 * Downloads run in the native Tauri runtime (or Demo timer) independently of any modal or
 * settings view lifecycle. Closing `VoiceprintModal` or leaving Settings never cancels an
 * active download; reopening immediately reconnects to live progress, and completion fires
 * a global toast notification via `voiceAiDownloadStore`.
 */
import { createStore } from "./store";
import {
  native,
  type VoiceAiProgressEvent,
  type VoiceAiState,
} from "./native";

export type VoiceAiDownloadTier = "base" | "sv" | "tse";

export interface VoiceAiDownloadState {
  downloading: boolean;
  tier: VoiceAiDownloadTier | null;
  label: string | null;
  progress: number;
  received: number;
  total: number;
  error: string | null;
  lastState: VoiceAiState | null;
  /** Incremented whenever a download finishes cleanly. */
  completedSeq: number;
  completedLabel: string | null;
  /** Incremented whenever a download fails with a non-cancel error. */
  failedSeq: number;
  failedMessage: string | null;
}

export interface VoiceAiDownloadDriver {
  voiceAiState: () => Promise<VoiceAiState>;
  voiceAiDownload: (tier: VoiceAiDownloadTier) => Promise<VoiceAiState>;
  voiceAiCancelDownload: () => Promise<boolean>;
  onVoiceAiProgress: (cb: (e: VoiceAiProgressEvent) => void) => () => void;
}

export function isVoiceAiCancelMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /已取消|取消下载|cancel/i.test(msg);
}

export function defaultVoiceAiDownloadLabel(
  tier: VoiceAiDownloadTier,
  state?: Pick<VoiceAiState, "svSizeMb" | "tseSizeMb"> | null,
): string {
  if (tier === "base") return "基础降噪引擎 (DPDFNet + VAD)";
  if (tier === "tse") {
    const mb = state?.tseSizeMb ?? 142;
    return `旗舰声纹分离包（约 ${mb} MB）`;
  }
  const mb = state?.svSizeMb ?? 68;
  return `灵巧声纹模型（约 ${mb} MB）`;
}

function tierAlreadyReady(tier: VoiceAiDownloadTier, st: VoiceAiState): boolean {
  const baseReady = Boolean(st.dpdfReady && st.vadReady && st.ortReady);
  if (tier === "base") return baseReady;
  if (tier === "sv") return baseReady && Boolean(st.svReady);
  return baseReady && Boolean(st.svReady && st.tseReady);
}

const INITIAL_STATE: VoiceAiDownloadState = {
  downloading: false,
  tier: null,
  label: null,
  progress: 0,
  received: 0,
  total: 0,
  error: null,
  lastState: null,
  completedSeq: 0,
  completedLabel: null,
  failedSeq: 0,
  failedMessage: null,
};

export function createVoiceAiDownloadController(driver: VoiceAiDownloadDriver) {
  const store = createStore<VoiceAiDownloadState>({ ...INITIAL_STATE });

  let unsubProgress: (() => void) | null = null;
  let hydrated = false;
  let inFlight: Promise<VoiceAiState> | null = null;
  let inFlightTier: VoiceAiDownloadTier | null = null;
  let cancelledByUser = false;
  let pendingCompletionResolvers: Array<{
    resolve: (st: VoiceAiState) => void;
    reject: (err: Error) => void;
  }> = [];

  const flushWaitersResolve = (st: VoiceAiState) => {
    const list = pendingCompletionResolvers;
    pendingCompletionResolvers = [];
    for (const w of list) w.resolve(st);
  };

  const flushWaitersReject = (err: Error) => {
    const list = pendingCompletionResolvers;
    pendingCompletionResolvers = [];
    for (const w of list) w.reject(err);
  };

  const waitForActiveProgressFinish = (): Promise<VoiceAiState> =>
    new Promise<VoiceAiState>((resolve, reject) => {
      pendingCompletionResolvers.push({ resolve, reject });
    });

  const handleProgress = (ev: VoiceAiProgressEvent) => {
    const cleanErr = isVoiceAiCancelMessage(ev.dlError) ? null : (ev.dlError ?? null);
    const prev = store.get();
    const label = ev.downloading
      ? (ev.dlLabel ?? prev.label ?? "声纹模型")
      : null;

    store.set((cur) => ({
      ...cur,
      downloading: ev.downloading,
      progress: ev.downloading ? Math.max(0, Math.min(1, ev.progress)) : ev.done ? 1 : 0,
      received: ev.received ?? cur.received,
      total: ev.total ?? cur.total,
      label,
      error: cleanErr,
      ...(ev.downloading ? {} : { tier: null }),
    }));

    if (!ev.downloading && ev.done) {
      const doneLabel = prev.label || ev.dlLabel || "声纹模型";
      void driver
        .voiceAiState()
        .then((fresh) => {
          const trackedByCall = inFlight !== null;
          store.set((cur) => ({
            ...cur,
            downloading: false,
            tier: null,
            label: null,
            progress: 1,
            error: null,
            lastState: fresh,
            // If this download was attached from a pre-existing native job (not started via startDownload),
            // fire the completion counter here so global notifications still trigger once.
            ...(trackedByCall
              ? {}
              : {
                  completedSeq: cur.completedSeq + 1,
                  completedLabel: doneLabel,
                }),
          }));
          flushWaitersResolve(fresh);
        })
        .catch(() => {
          flushWaitersReject(new Error("刷新声纹模型状态失败"));
        });
    } else if (!ev.downloading && !ev.done) {
      const errMsg = cleanErr ?? (cancelledByUser ? "已取消下载" : null);
      if (cleanErr && inFlight === null) {
        store.set((cur) => ({
          ...cur,
          failedSeq: cur.failedSeq + 1,
          failedMessage: cleanErr,
        }));
      }
      if (pendingCompletionResolvers.length > 0) {
        flushWaitersReject(new Error(errMsg || "已取消下载"));
      }
    }
  };

  function ensureWatcher(): void {
    if (!unsubProgress) {
      unsubProgress = driver.onVoiceAiProgress(handleProgress);
    }
    if (!hydrated) {
      hydrated = true;
      void driver
        .voiceAiState()
        .then((st) => {
          syncFromState(st);
        })
        .catch(() => {});
    }
  }

  function syncFromState(st: VoiceAiState): void {
    store.set((cur) => {
      const isActive = st.downloading || (inFlight !== null && cur.downloading);
      const cleanErr = isVoiceAiCancelMessage(st.dlError) ? null : (st.dlError ?? null);
      return {
        ...cur,
        lastState: st,
        downloading: isActive,
        progress: isActive ? Math.max(cur.progress, st.progress || 0) : st.progress,
        label: isActive ? (st.dlLabel ?? cur.label ?? "声纹模型") : null,
        error: isActive ? null : (cleanErr ?? cur.error),
      };
    });
  }

  async function startDownload(
    tier: VoiceAiDownloadTier,
    fallbackLabel?: string,
  ): Promise<VoiceAiState> {
    ensureWatcher();

    // If a download is already running in this session, reuse it rather than starting a duplicate.
    if (inFlight) {
      const firstTier = inFlightTier;
      const doneState = await inFlight;
      if (tier === "tse" && firstTier !== "tse" && !tierAlreadyReady("tse", doneState)) {
        return startDownload("tse", fallbackLabel);
      }
      return doneState;
    }

    const curSnap = store.get();
    const label = fallbackLabel || defaultVoiceAiDownloadLabel(tier, curSnap.lastState);

    // If native was already downloading (e.g. after webview reload), attach to live progress.
    if (curSnap.downloading) {
      return waitForActiveProgressFinish();
    }

    cancelledByUser = false;
    inFlightTier = tier;
    store.set((cur) => ({
      ...cur,
      downloading: true,
      tier,
      label,
      progress: 0,
      received: 0,
      total: 0,
      error: null,
    }));

    const task = (async (): Promise<VoiceAiState> => {
      try {
        const next = await driver.voiceAiDownload(tier);
        store.set((cur) => ({
          ...cur,
          downloading: false,
          tier: null,
          label: null,
          progress: 1,
          error: null,
          lastState: next,
          completedSeq: cur.completedSeq + 1,
          completedLabel: label,
        }));
        flushWaitersResolve(next);
        return next;
      } catch (err) {
        const msg = (err as Error)?.message || "模型下载失败";
        // Native reported a download is already active: attach instead of failing.
        if (/正在下载语音模型/.test(msg) && !cancelledByUser) {
          const attached = await waitForActiveProgressFinish();
          return attached;
        }
        const cancelled = cancelledByUser || isVoiceAiCancelMessage(msg);
        const refreshed = await driver.voiceAiState().catch(() => null);
        store.set((cur) => ({
          ...cur,
          downloading: false,
          tier: null,
          label: null,
          progress: 0,
          error: cancelled ? null : msg,
          ...(refreshed ? { lastState: refreshed } : {}),
          ...(cancelled
            ? {}
            : {
                failedSeq: cur.failedSeq + 1,
                failedMessage: msg,
              }),
        }));
        const wrapped = err instanceof Error ? err : new Error(msg);
        flushWaitersReject(wrapped);
        throw wrapped;
      } finally {
        inFlight = null;
        inFlightTier = null;
      }
    })();

    inFlight = task;
    return task;
  }

  async function cancelDownload(): Promise<boolean> {
    cancelledByUser = true;
    const ok = await driver.voiceAiCancelDownload().catch(() => false);
    const refreshed = await driver.voiceAiState().catch(() => null);
    store.set((cur) => ({
      ...cur,
      downloading: false,
      tier: null,
      label: null,
      progress: 0,
      received: 0,
      total: 0,
      error: null,
      ...(refreshed ? { lastState: refreshed } : {}),
    }));
    flushWaitersReject(new Error("已取消下载"));
    return ok;
  }

  function clearError(): void {
    store.set((cur) => (cur.error ? { ...cur, error: null } : cur));
  }

  function dispose(): void {
    unsubProgress?.();
    unsubProgress = null;
    hydrated = false;
    inFlight = null;
    inFlightTier = null;
    cancelledByUser = false;
    pendingCompletionResolvers = [];
  }

  return {
    store,
    ensureWatcher,
    syncFromState,
    startDownload,
    cancelDownload,
    clearError,
    dispose,
  };
}

const defaultController = createVoiceAiDownloadController({
  voiceAiState: () => native.voiceAiState(),
  voiceAiDownload: (tier) => native.voiceAiDownload(tier),
  voiceAiCancelDownload: () => native.voiceAiCancelDownload(),
  onVoiceAiProgress: (cb) => native.onVoiceAiProgress(cb),
});

export const voiceAiDownloadStore = defaultController.store;
export const ensureVoiceAiDownloadWatcher = defaultController.ensureWatcher;
export const syncVoiceAiDownloadFromState = defaultController.syncFromState;
export const startVoiceAiDownload = defaultController.startDownload;
export const cancelVoiceAiDownload = defaultController.cancelDownload;
export const clearVoiceAiDownloadError = defaultController.clearError;
