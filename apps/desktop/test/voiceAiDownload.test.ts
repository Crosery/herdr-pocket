import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { VoiceAiProgressEvent, VoiceAiState } from "../src/lib/native.ts";
import {
  createVoiceAiDownloadController,
  type VoiceAiDownloadDriver,
  type VoiceAiDownloadTier,
} from "../src/lib/voiceAiDownload.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

function makeState(overrides: Partial<VoiceAiState> = {}): VoiceAiState {
  return {
    supported: true,
    activeEngine: "rust-dsp",
    denoise: true,
    enhanceVocal: true,
    filter: false,
    tier: "auto",
    recommendedTier: "sv",
    recommendReason: "test",
    threshold: 0.38,
    firstSpeaker: false,
    dpdfReady: false,
    vadReady: false,
    svReady: false,
    tseReady: false,
    svSizeMb: 68,
    tseSizeMb: 142,
    downloading: false,
    progress: 0,
    dlLabel: null,
    dlError: null,
    enrolled: false,
    enrollSeconds: 0,
    ortReady: false,
    ortVersion: null,
    prototypesCount: 0,
    consistency: 0,
    snrDb: null,
    hasSample: false,
    ...overrides,
  };
}

function createFakeDriver(initial: VoiceAiState = makeState()) {
  let state = initial;
  const listeners = new Set<(e: VoiceAiProgressEvent) => void>();
  let downloadCalls: VoiceAiDownloadTier[] = [];
  let cancelCalls = 0;
  let pendingResolve: ((st: VoiceAiState) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  let nextError: Error | null = null;

  const emit = (ev: VoiceAiProgressEvent) => {
    state = {
      ...state,
      downloading: ev.downloading,
      progress: ev.progress,
      dlLabel: ev.dlLabel ?? null,
      dlError: ev.dlError ?? null,
    };
    for (const cb of listeners) cb(ev);
  };

  const driver: VoiceAiDownloadDriver = {
    voiceAiState: async () => state,
    voiceAiDownload: (tier) => {
      downloadCalls.push(tier);
      if (nextError) {
        const err = nextError;
        nextError = null;
        return Promise.reject(err);
      }
      return new Promise<VoiceAiState>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
      });
    },
    voiceAiCancelDownload: async () => {
      cancelCalls += 1;
      state = { ...state, downloading: false, progress: 0, dlLabel: null, dlError: null };
      const rej = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      emit({
        downloading: false,
        progress: 0,
        received: 0,
        total: 0,
        dlLabel: null,
        dlError: null,
        done: false,
      });
      rej?.(new Error("已取消下载"));
      return true;
    },
    onVoiceAiProgress: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  return {
    driver,
    emit,
    setState: (next: VoiceAiState) => {
      state = next;
    },
    setNextError: (err: Error) => {
      nextError = err;
    },
    finishDownload: (next: VoiceAiState) => {
      state = next;
      const res = pendingResolve;
      pendingResolve = null;
      pendingReject = null;
      emit({
        downloading: false,
        progress: 1,
        received: 100,
        total: 100,
        dlLabel: null,
        dlError: null,
        done: true,
      });
      res?.(next);
    },
    failDownload: (message: string) => {
      const rej = pendingReject;
      pendingResolve = null;
      pendingReject = null;
      emit({
        downloading: false,
        progress: 0,
        received: 0,
        total: 100,
        dlLabel: null,
        dlError: message,
        done: false,
      });
      rej?.(new Error(message));
    },
    get downloadCalls() {
      return downloadCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
  };
}

test("voiceAiDownload: downloads continue in background, deduplicate concurrent starts, and fire completion event", async () => {
  const fake = createFakeDriver();
  const ctl = createVoiceAiDownloadController(fake.driver);

  const p1 = ctl.startDownload("sv", "灵巧声纹模型（约 68 MB）");
  assert.equal(ctl.store.get().downloading, true);
  assert.equal(ctl.store.get().label, "灵巧声纹模型（约 68 MB）");

  // Second caller (e.g. reopening modal or clicking again) deduplicates into the active download.
  const p2 = ctl.startDownload("sv");
  assert.deepEqual(fake.downloadCalls, ["sv"]);

  fake.emit({
    downloading: true,
    progress: 0.45,
    received: 45,
    total: 100,
    dlLabel: "灵巧声纹模型（约 68 MB）",
    dlError: null,
    done: false,
  });
  assert.equal(ctl.store.get().progress, 0.45);

  const ready = makeState({ ortReady: true, dpdfReady: true, vadReady: true, svReady: true, progress: 1 });
  fake.finishDownload(ready);

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.svReady, true);
  assert.equal(r2.svReady, true);
  assert.equal(ctl.store.get().downloading, false);
  assert.equal(ctl.store.get().completedSeq, 1);
  assert.equal(ctl.store.get().completedLabel, "灵巧声纹模型（约 68 MB）");
  assert.equal(ctl.store.get().failedSeq, 0);
  assert.equal(fake.cancelCalls, 0);
  ctl.dispose();
});

test("voiceAiDownload: explicit cancel stops download cleanly without triggering failure notification", async () => {
  const fake = createFakeDriver();
  const ctl = createVoiceAiDownloadController(fake.driver);

  const p = ctl.startDownload("tse");
  assert.equal(ctl.store.get().downloading, true);

  await ctl.cancelDownload();
  await assert.rejects(p, /已取消下载/);

  assert.equal(fake.cancelCalls, 1);
  assert.equal(ctl.store.get().downloading, false);
  assert.equal(ctl.store.get().error, null);
  assert.equal(ctl.store.get().failedSeq, 0);
  assert.equal(ctl.store.get().completedSeq, 0);
  ctl.dispose();
});

test("voiceAiDownload: attaches to already-running native download without throwing duplicate error", async () => {
  const running = makeState({ downloading: true, progress: 0.32, dlLabel: "旗舰声纹分离包（约 142 MB）" });
  const fake = createFakeDriver(running);
  fake.setNextError(new Error("正在下载语音模型"));
  const ctl = createVoiceAiDownloadController(fake.driver);

  const p = ctl.startDownload("tse");
  await new Promise((r) => setTimeout(r, 0));

  const ready = makeState({ ortReady: true, dpdfReady: true, vadReady: true, svReady: true, tseReady: true, progress: 1 });
  fake.setState(ready);
  fake.emit({
    downloading: false,
    progress: 1,
    received: 100,
    total: 100,
    dlLabel: null,
    dlError: null,
    done: true,
  });

  const finalState = await p;
  assert.equal(finalState.tseReady, true);
  assert.equal(ctl.store.get().downloading, false);
  assert.equal(ctl.store.get().failedSeq, 0);
  ctl.dispose();
});

test("voiceAiDownload regression guardrails: closing modal or leaving mobile screen never cancels model download", () => {
  const desktopModal = readFileSync(join(repoRoot, "apps/desktop/src/components/VoiceprintModal.tsx"), "utf8");
  assert.equal(desktopModal.includes("native.voiceAiCancelDownload"), false);
  assert.equal(desktopModal.includes("stopCaptureWork"), true);
  assert.equal(desktopModal.includes("if (!openRef.current) return;"), true);
  assert.equal(desktopModal.includes("后台下载"), true);

  const mobileScreen = readFileSync(join(repoRoot, "apps/mobile/src/app/voiceprint.tsx"), "utf8");
  assert.equal(mobileScreen.includes("PocketNative?.cancelVoiceModel"), false);
  assert.equal(mobileScreen.includes("stopCaptureOnly"), true);
  assert.equal(mobileScreen.includes("if (!mountedRef.current) return;"), true);

  // VoicePreviewStudio live ear-return must stream through real Rust LiveCallProcessor, not fake WebAudio EQ.
  const previewStudio = readFileSync(join(repoRoot, "apps/desktop/src/components/VoicePreviewStudio.tsx"), "utf8");
  assert.equal(previewStudio.includes("native.voiceAiPreviewLiveOpen"), true);
  assert.equal(previewStudio.includes("native.voiceAiPreviewLiveProcess"), true);
  assert.equal(previewStudio.includes("native.voiceAiPreviewLiveClose"), true);
  assert.equal(previewStudio.includes("下载神经降噪模型"), true);
});
