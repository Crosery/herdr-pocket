/**
 * App-wide background download controller for native iOS/Android voiceprint models.
 *
 * Leaving `VoiceprintScreen` never cancels an active model download; the native thread
 * continues downloading in the background and re-entering the screen immediately reconnects
 * to live progress.
 */
import { create } from "zustand";
import { PocketNative } from "../../modules/pocket-native";

export type MobileVoiceDownloadTarget = "sv" | "tse";

interface MobileVoiceDownloadState {
  downloading: boolean;
  target: MobileVoiceDownloadTarget | null;
  label: string;
  progress: number;
  error: string | null;
  completedSeq: number;
  completedLabel: string | null;
}

export const useMobileVoiceModelDownload = create<MobileVoiceDownloadState>(() => ({
  downloading: false,
  target: null,
  label: "声纹与人声模型",
  progress: 0,
  error: null,
  completedSeq: 0,
  completedLabel: null,
}));

let listenerAttached = false;
let inFlight: Promise<boolean> | null = null;
let inFlightTarget: MobileVoiceDownloadTarget | null = null;
let cancelledByUser = false;

export function isMobileVoiceCancelError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /已取消|取消下载|cancel/i.test(msg);
}

function ensureProgressListener(): void {
  if (listenerAttached || !PocketNative) return;
  listenerAttached = true;
  PocketNative.addListener("onVoiceModelProgress", (e) => {
    if (e.total > 0) {
      const prog = Math.max(0, Math.min(1, e.received / e.total));
      useMobileVoiceModelDownload.setState((cur) =>
        cur.downloading ? { ...cur, progress: prog } : cur,
      );
    }
  });
}

export async function startMobileVoiceModelDownload(
  target: MobileVoiceDownloadTarget,
  label: string,
): Promise<{ ok: true } | { ok: false; cancelled: boolean; error?: string }> {
  ensureProgressListener();
  const dl = PocketNative?.prepareVoiceTier ?? PocketNative?.prepareVoiceModel;
  if (!dl) {
    return { ok: false, cancelled: false, error: "这个版本的 App 还没带声纹功能，先更新 App" };
  }

  if (inFlight) {
    const firstTarget = inFlightTarget;
    const ok = await inFlight;
    if (!ok) {
      const err = useMobileVoiceModelDownload.getState().error;
      return { ok: false, cancelled: !err, ...(err ? { error: err } : {}) };
    }
    if (target === "tse" && firstTarget !== "tse") {
      const st = PocketNative?.voiceState?.();
      if (!(st?.tseModelsReady ?? st?.modelReady)) {
        return startMobileVoiceModelDownload("tse", label);
      }
    }
    return { ok: true };
  }

  cancelledByUser = false;
  inFlightTarget = target;
  useMobileVoiceModelDownload.setState((cur) => ({
    ...cur,
    downloading: true,
    target,
    label,
    progress: 0,
    error: null,
  }));

  let lastError: string | undefined;
  let wasCancelled = false;

  const task = (async (): Promise<boolean> => {
    try {
      if (PocketNative?.prepareVoiceTier) {
        await PocketNative.prepareVoiceTier(target);
      } else {
        await PocketNative!.prepareVoiceModel!();
      }
      useMobileVoiceModelDownload.setState((cur) => ({
        ...cur,
        downloading: false,
        target: null,
        progress: 1,
        error: null,
        completedSeq: cur.completedSeq + 1,
        completedLabel: label,
      }));
      return true;
    } catch (e) {
      const msg = (e as Error)?.message || "下载失败";
      wasCancelled = cancelledByUser || isMobileVoiceCancelError(msg);
      if (!wasCancelled) lastError = msg;
      useMobileVoiceModelDownload.setState((cur) => ({
        ...cur,
        downloading: false,
        target: null,
        progress: 0,
        error: wasCancelled ? null : msg,
      }));
      return false;
    } finally {
      inFlight = null;
      inFlightTarget = null;
    }
  })();

  inFlight = task;
  const ok = await task;
  if (ok) return { ok: true };
  return { ok: false, cancelled: wasCancelled, ...(lastError ? { error: lastError } : {}) };
}

export function cancelMobileVoiceModelDownload(): void {
  cancelledByUser = true;
  PocketNative?.cancelVoiceModel?.();
  useMobileVoiceModelDownload.setState((cur) => ({
    ...cur,
    downloading: false,
    target: null,
    progress: 0,
    error: null,
  }));
}
