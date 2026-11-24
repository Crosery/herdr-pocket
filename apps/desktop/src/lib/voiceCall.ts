import { createStore, settingsStore } from "./store";
import { assistantStore, loadAssistant } from "./assistant";
import { getActiveToken, wsUrlFor } from "./relay";
import { detectPlatform, requestMicrophonePermission } from "./bridge";
import { isMockServer } from "./mock";
import { logger } from "./log";
import { native, type VoiceHudSyncState } from "./native";

export interface CallCaptionLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  turn?: number;
}

export type VoiceCallStatus = "idle" | "connecting" | "ready";
export type AecMode = "webrtc-aec" | "cpal-fallback";

export interface VoiceCallState {
  status: VoiceCallStatus;
  muted: boolean;
  assistant: "idle" | "thinking" | "speaking";
  micLevel: number;
  outLevel: number;
  lines: CallCaptionLine[];
  task: string | null;
  startedAt: number | null;
  hudShown: boolean;
  message: string | null;
  error: string | null;
}

export const voiceCallStore = createStore<VoiceCallState>({
  status: "idle",
  muted: false,
  assistant: "idle",
  micLevel: 0,
  outLevel: 0,
  lines: [],
  task: null,
  startedAt: null,
  hudShown: false,
  message: null,
  error: null,
});

function numTurn(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : undefined;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

function upsertCallLine(lines: CallCaptionLine[], line: CallCaptionLine, maxLines = 30): CallCaptionLine[] {
  const i = lines.findIndex((l) => l.id === line.id);
  if (i >= 0) {
    const next = lines.slice();
    next[i] = { ...line, turn: line.turn ?? lines[i]!.turn };
    return next;
  }
  if (line.role === "user" && line.turn !== undefined) {
    const idx = lines.findIndex((l) => l.role === "assistant" && l.turn !== undefined && l.turn >= line.turn!);
    if (idx >= 0) {
      const next = lines.slice();
      next.splice(idx, 0, line);
      return next.slice(-maxLines);
    }
  }
  return [...lines, line].slice(-maxLines);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function formatHudCaption(lines: CallCaptionLine[]): string {
  const last = lines[lines.length - 1];
  if (!last || !last.text.trim()) return "";
  return `${last.role === "user" ? "你：" : "小羊："}${last.text.trim()}`;
}

export interface EchoGateInput {
  frameRms: number;
  outRms: number;
  speakerPlaying: boolean;
  lastSpeakerEndedAt: number | null;
  aecMode: AecMode;
  now?: number;
}

export interface EchoGateDecision {
  allow: boolean;
  speakerActive: boolean;
  bargeInActive: boolean;
  consecutiveLoudFrames: number;
}

export interface EchoGate {
  evaluate(input: EchoGateInput): EchoGateDecision;
  reset(): void;
}

export const ECHO_TAIL_GUARD_MS = 260;
export const ECHO_BARGE_IN_HOLDOVER_MS = 280;

/**
 * Software half-duplex barge-in gate sitting behind OS/WebRTC AEC (or cpal fallback)
 * to stop speaker bleed and room reverb tail from triggering false user turns.
 */
export function createEchoGate(): EchoGate {
  let consecutiveLoud = 0;
  let holdoverUntil = 0;

  return {
    evaluate(input: EchoGateInput): EchoGateDecision {
      const now = input.now ?? Date.now();
      const speakerActive =
        input.speakerPlaying ||
        (input.lastSpeakerEndedAt !== null &&
          now - input.lastSpeakerEndedAt >= 0 &&
          now - input.lastSpeakerEndedAt < ECHO_TAIL_GUARD_MS);

      if (!speakerActive) {
        consecutiveLoud = 0;
        holdoverUntil = 0;
        return {
          allow: true,
          speakerActive: false,
          bargeInActive: false,
          consecutiveLoudFrames: 0,
        };
      }

      const threshold =
        input.aecMode === "webrtc-aec"
          ? Math.max(0.045, input.outRms * 0.85)
          : Math.max(0.13, input.outRms * 2.4);
      const requiredFrames = input.aecMode === "webrtc-aec" ? 3 : 4;

      if (input.frameRms >= threshold) {
        consecutiveLoud += 1;
      } else {
        consecutiveLoud = 0;
      }

      if (consecutiveLoud >= requiredFrames) {
        holdoverUntil = now + ECHO_BARGE_IN_HOLDOVER_MS;
      }

      const inHoldover = holdoverUntil > 0 && now < holdoverUntil;
      const allow = consecutiveLoud >= requiredFrames || inHoldover;
      return {
        allow,
        speakerActive: true,
        bargeInActive: allow,
        consecutiveLoudFrames: consecutiveLoud,
      };
    },
    reset(): void {
      consecutiveLoud = 0;
      holdoverUntil = 0;
    },
  };
}

export interface PlayoutTracker {
  enqueueChunk(runId: string, turnId: string, durationMs: number): boolean;
  onChunkEnded(runId: string): { runCompleted: boolean; turnId: string; allIdle: boolean };
  markAudioDone(runId: string, turnId: string): { emitCompleted: boolean; allIdle: boolean };
  markStopped(runId: string, turnId?: string): { playedMs: number; turnId: string; allIdle: boolean };
  isStopped(runId: string): boolean;
  isFinished(runId: string): boolean;
  pendingCount(runId: string): number;
  totalPending(): number;
}

/**
 * Tracks queued AudioBufferSourceNodes per runId so `playback.completed` and idle state
 * only fire after both `response.audio.done` and the final queued chunk's `onended`.
 */
export function createPlayoutTracker(): PlayoutTracker {
  const finishedRuns = new Set<string>();
  const stoppedRuns = new Set<string>();
  const completedRuns = new Set<string>();
  const pendingSourcesByRun = new Map<string, number>();
  const turnIdByRun = new Map<string, string>();
  const playedMsByRun = new Map<string, number>();

  const totalPending = (): number => {
    let total = 0;
    for (const count of pendingSourcesByRun.values()) {
      total += count;
    }
    return total;
  };

  return {
    enqueueChunk(runId: string, turnId: string, durationMs: number): boolean {
      if (stoppedRuns.has(runId)) return false;
      pendingSourcesByRun.set(runId, (pendingSourcesByRun.get(runId) ?? 0) + 1);
      if (turnId) turnIdByRun.set(runId, turnId);
      playedMsByRun.set(runId, (playedMsByRun.get(runId) ?? 0) + Math.max(0, durationMs));
      return true;
    },

    onChunkEnded(runId: string): { runCompleted: boolean; turnId: string; allIdle: boolean } {
      const prev = pendingSourcesByRun.get(runId) ?? 0;
      const next = Math.max(0, prev - 1);
      if (next === 0) {
        pendingSourcesByRun.delete(runId);
      } else {
        pendingSourcesByRun.set(runId, next);
      }

      const turnId = turnIdByRun.get(runId) ?? "";
      const canComplete =
        next === 0 && finishedRuns.has(runId) && !stoppedRuns.has(runId) && !completedRuns.has(runId);
      if (canComplete) {
        completedRuns.add(runId);
        finishedRuns.delete(runId);
      }
      return {
        runCompleted: canComplete,
        turnId,
        allIdle: totalPending() === 0,
      };
    },

    markAudioDone(runId: string, turnId: string): { emitCompleted: boolean; allIdle: boolean } {
      if (turnId) turnIdByRun.set(runId, turnId);
      if (stoppedRuns.has(runId) || completedRuns.has(runId)) {
        return { emitCompleted: false, allIdle: totalPending() === 0 };
      }
      const pending = pendingSourcesByRun.get(runId) ?? 0;
      if (pending === 0) {
        completedRuns.add(runId);
        return { emitCompleted: true, allIdle: totalPending() === 0 };
      }
      finishedRuns.add(runId);
      return { emitCompleted: false, allIdle: false };
    },

    markStopped(runId: string, turnId?: string): { playedMs: number; turnId: string; allIdle: boolean } {
      stoppedRuns.add(runId);
      finishedRuns.delete(runId);
      pendingSourcesByRun.delete(runId);
      const resolvedTurnId = turnId || turnIdByRun.get(runId) || "";
      const playedMs = playedMsByRun.get(runId) ?? 0;
      return {
        playedMs,
        turnId: resolvedTurnId,
        allIdle: totalPending() === 0,
      };
    },

    isStopped(runId: string): boolean {
      return stoppedRuns.has(runId);
    },

    isFinished(runId: string): boolean {
      return finishedRuns.has(runId) || completedRuns.has(runId);
    },

    pendingCount(runId: string): number {
      return pendingSourcesByRun.get(runId) ?? 0;
    },

    totalPending,
  };
}

export function computePlayoutStartTime(currentTime: number, nextPlayTime: number): number {
  const lead = nextPlayTime <= currentTime + 0.005 ? 0.065 : 0;
  return Math.max(currentTime + lead, nextPlayTime);
}

export interface MeterSnapshot {
  micLevel: number;
  outLevel: number;
}

export function shouldPublishMeterUpdate(
  prev: MeterSnapshot,
  next: MeterSnapshot,
  threshold = 0.02,
): boolean {
  return (
    Math.abs(next.micLevel - prev.micLevel) + 1e-9 >= threshold ||
    Math.abs(next.outLevel - prev.outLevel) + 1e-9 >= threshold
  );
}

export interface HudSyncScheduler {
  sync(transitionKey: string): void;
  markOpened(): void;
  dispose(): void;
}

export function createHudSyncScheduler(
  emit: (open: boolean) => void,
  nowFn: () => number = () => Date.now(),
  intervalMs = 85,
): HudSyncScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey = "";
  let lastAt = 0;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    sync(transitionKey: string): void {
      if (transitionKey !== lastKey) {
        lastKey = transitionKey;
        clearTimer();
        lastAt = nowFn();
        emit(false);
        return;
      }
      const elapsed = nowFn() - lastAt;
      if (elapsed >= intervalMs) {
        clearTimer();
        lastAt = nowFn();
        emit(false);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          lastAt = nowFn();
          emit(false);
        }, intervalMs - elapsed);
        if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
          (timer as unknown as { unref: () => void }).unref();
        }
      }
    },

    markOpened(): void {
      clearTimer();
      lastAt = nowFn();
      emit(true);
    },

    dispose(): void {
      clearTimer();
    },
  };
}

interface PendingAudioRef {
  chunkId: string;
  runId: string;
  turnId: string;
}

class WebVoiceSession {
  private ws: WebSocket | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: AudioContext | null = null;
  private outGain: GainNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private outTimeDomain: Float32Array<ArrayBuffer> | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;
  private resampleCarry: number[] = [];
  private micPcmQueue: number[] = [];
  private dspBatchQueue: number[] = [];
  private dspChain: Promise<void> = Promise.resolve();
  private dspPendingCount = 0;
  private sampleRate = 48_000;
  private nextPlayTime = 0;
  private contexts: PendingAudioRef[] = [];
  private playout = createPlayoutTracker();
  private echoGate = createEchoGate();
  private playingSources = new Set<AudioBufferSourceNode>();
  private sourceRunMap = new Map<AudioBufferSourceNode, string>();
  private lastSpeakerEndedAt: number | null = null;
  private latestMicLevel = 0;
  private latestOutLevel = 0;
  private speaking = false;
  private lastAnsweredTurn = -1;
  private currentUserTurn: number | undefined;
  private callId = 0;
  private startedAtMs: number | null = null;
  private turns = 0;
  private interruptions = 0;
  private ended = false;
  private reachedReady = false;
  private aecMode: AecMode = "webrtc-aec";
  private dspActive = false;
  private dspBadge: string | null | undefined = undefined;
  private dspOpened = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private unsubNativeMic: (() => void) | null = null;
  private usedNativeMic = false;
  private unsubHudSync: (() => void) | null = null;
  private hudScheduler: HudSyncScheduler | null = null;

  private readonly mock: boolean;
  private hudShown: boolean;
  private seq?: number;

  constructor(mock: boolean, hudShown: boolean, seq?: number) {
    this.mock = mock;
    this.hudShown = hudShown;
    this.seq = seq;
  }

  isHudShown(): boolean {
    return this.hudShown;
  }

  attachHud(seq?: number): void {
    if (this.ended) return;
    this.hudShown = true;
    if (seq !== undefined) this.seq = seq;
    voiceCallStore.set({ hudShown: true });
    this.startHudSync();
    this.hudScheduler?.markOpened();
  }

  async start(): Promise<string | null> {
    this.callId = Date.now();
    this.ended = false;
    this.reachedReady = false;
    this.turns = 0;
    this.interruptions = 0;
    this.startedAtMs = null;
    this.latestMicLevel = 0;
    this.latestOutLevel = 0;
    this.lastSpeakerEndedAt = null;
    this.echoGate.reset();

    voiceCallStore.set({
      status: "connecting",
      muted: false,
      assistant: "idle",
      micLevel: 0,
      outLevel: 0,
      lines: [],
      task: null,
      startedAt: null,
      hudShown: this.hudShown,
      message: null,
      error: null,
    });

    if (this.hudShown) {
      this.startHudSync();
      this.hudScheduler?.markOpened();
    }

    if (this.mock) {
      this.reachedReady = true;
      this.startedAtMs = Date.now();
      voiceCallStore.set({
        status: "ready",
        startedAt: this.startedAtMs,
        lines: [{ id: "mock-1", role: "assistant", text: "你好，这是演示模式的语音通话界面。", final: true, turn: 1 }],
      });
      let phase = 0;
      const timer = setInterval(() => {
        if (this.ended) return;
        phase += 0.55;
        const muted = voiceCallStore.get().muted;
        voiceCallStore.set({ micLevel: muted ? 0 : Number((0.16 + Math.abs(Math.sin(phase)) * 0.34).toFixed(2)) });
      }, 180);
      if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.demoTimer = timer;
      return null;
    }

    const server = settingsStore.get().server;
    const token = getActiveToken();
    if (!server || !token) {
      this.cleanup("还没连上服务器", true);
      return "还没连上服务器";
    }

    if (!assistantStore.get().loaded) {
      await loadAssistant().catch(() => {});
    }
    if (this.ended) return null;
    if (assistantStore.get().loaded && !assistantStore.get().voice) {
      const msg = "尚未配置小羊实时语音模型，请在「设置 › 小羊助理」配置";
      this.cleanup(msg, true);
      return msg;
    }

    logger.info("voice.call", "call connecting");

    const platform = detectPlatform();
    if (native.available()) {
      const perms = await native.getPermissions().catch(() => null);
      if (perms?.microphone === "denied" || perms?.microphone === "restricted") {
        const msg =
          platform === "windows"
            ? "请在 设置 → 隐私和安全性 → 麦克风 里允许桌面应用使用麦克风"
            : "请在 系统设置 → 隐私与安全性 → 麦克风 里允许 Herdr Pocket";
        this.cleanup(msg, true);
        return msg;
      }
      if (perms?.microphone === "notDetermined") {
        const after = await native.requestPermission("microphone").catch(() => null);
        if (after && after.microphone !== "granted") {
          const msg = "请在弹出的窗口里允许使用麦克风，然后再试一次";
          this.cleanup(msg, true);
          return msg;
        }
      }
    }
    if (this.ended) return null;

    const okPerm = await requestMicrophonePermission();
    if (!okPerm) {
      this.cleanup("没有麦克风权限", true);
      return "没有麦克风权限";
    }
    if (this.ended) return null;

    const denoise = settingsStore.get().denoise;
    let gotWebMic = false;
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16_000,
            echoCancellation: true,
            noiseSuppression: denoise,
            autoGainControl: true,
          },
        });
        gotWebMic = true;
        this.aecMode = "webrtc-aec";
      } catch (err) {
        const errName = (err as { name?: string })?.name;
        if (errName !== "NotAllowedError" && errName !== "PermissionDeniedError") {
          try {
            this.stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: denoise,
                autoGainControl: true,
              },
            });
            gotWebMic = true;
            this.aecMode = "webrtc-aec";
          } catch {
            gotWebMic = false;
          }
        }
      }
    }

    if (this.ended) {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return null;
    }

    if (!gotWebMic) {
      if (native.available()) {
        this.aecMode = "cpal-fallback";
        this.usedNativeMic = true;
        this.unsubNativeMic = native.onVoiceCallMic((ev) => {
          if (this.ended) return;
          if (voiceCallStore.get().muted) {
            this.latestMicLevel = 0;
            return;
          }
          const rawLevel = Math.max(0, Math.min(1, Number(ev.level) || 0));
          if (!ev.pcmBase64 || this.ws?.readyState !== WebSocket.OPEN) {
            this.latestMicLevel = rawLevel;
            return;
          }
          const bytes = base64ToUint8Array(ev.pcmBase64);
          const samples = Math.floor(bytes.byteLength / 2);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          let sq = 0;
          for (let i = 0; i < samples; i++) {
            const f = view.getInt16(i * 2, true) / 32768;
            sq += f * f;
          }
          const frameRms = samples > 0 ? Math.sqrt(sq / samples) : 0;
          const decision = this.echoGate.evaluate({
            frameRms,
            outRms: this.sampleOutRms(),
            speakerPlaying: this.playingSources.size > 0,
            lastSpeakerEndedAt: this.lastSpeakerEndedAt,
            aecMode: "cpal-fallback",
          });
          if (decision.allow) {
            this.latestMicLevel = rawLevel;
            this.ws.send(bytes);
          } else {
            this.latestMicLevel = 0;
            this.ws.send(new Uint8Array(bytes.byteLength));
          }
        });
        try {
          await native.voiceCallMicStart();
        } catch (err) {
          const msg = (err as Error)?.message || "打不开麦克风，请检查系统权限或设备连接";
          this.cleanup(msg, true);
          return msg;
        }
        if (this.ended) {
          void native.voiceCallMicStop();
          return null;
        }
      } else {
        this.cleanup("打不开麦克风，请检查系统权限或设备连接", true);
        return "打不开麦克风，请检查系统权限或设备连接";
      }
    } else if (native.available()) {
      const dsp = await native.voiceCallDspOpen();
      this.dspOpened = true;
      if (this.ended) {
        void native.voiceCallDspClose();
        return null;
      }
      this.dspActive = dsp.active;
      this.dspBadge = dsp.badge;
      if (this.hudShown) {
        this.hudScheduler?.sync(this.buildHudKey());
      }
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      try {
        this.ctx = new AudioCtx({ sampleRate: 48_000 });
      } catch {
        this.ctx = new AudioCtx();
      }
      this.outGain = this.ctx.createGain();
      this.outGain.gain.value = 1;
      this.outAnalyser = this.ctx.createAnalyser();
      this.outAnalyser.fftSize = 256;
      this.outTimeDomain = new Float32Array(this.outAnalyser.fftSize);
      this.outGain.connect(this.outAnalyser);
      this.outAnalyser.connect(this.ctx.destination);
      await this.ctx.resume().catch(() => {});
    }
    if (this.ended) {
      try {
        this.outGain?.disconnect();
        this.outAnalyser?.disconnect();
        void this.ctx?.close();
      } catch {
        // ignore
      }
      this.outGain = null;
      this.outAnalyser = null;
      this.outTimeDomain = null;
      this.ctx = null;
      return null;
    }

    const ws = new WebSocket(wsUrlFor(server, "/v1/assistant/live", token));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (!this.ended && !this.reachedReady) {
        this.cleanup("语音服务连接超时，请检查中转服务实时语音配置", true);
      }
    }, 8_000);

    ws.onopen = () => {
      if (this.ended) {
        ws.close(1000, "bye");
        return;
      }
      if (!this.usedNativeMic) {
        this.setupMicCapture();
      }
      this.startMeterTicker();
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.sendJson({ action: "ping", timestamp: Date.now() });
        }
      }, 20_000);
      if (typeof (this.pingTimer as unknown as { unref?: () => void }).unref === "function") {
        (this.pingTimer as unknown as { unref: () => void }).unref();
      }
    };
    ws.onmessage = (ev) => {
      if (this.ended) return;
      if (typeof ev.data === "string") {
        this.onText(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        this.onBinary(ev.data);
      }
    };
    ws.onclose = () => {
      if (!this.ended) {
        if (this.reachedReady) {
          this.cleanup("通话结束了", false);
        } else {
          this.cleanup("小羊实时语音连接已断开，请检查中转服务与语音配置", true);
        }
      }
    };
    ws.onerror = () => {
      if (!this.ended) this.cleanup("语音连接断开", true);
    };
    return null;
  }

  private startMeterTicker(): void {
    if (this.meterTimer) return;
    const timer = setInterval(() => {
      if (this.ended) return;
      const st = voiceCallStore.get();
      const nextMic = st.muted ? 0 : Math.max(0, Math.min(1, this.latestMicLevel));
      const outRms = this.sampleOutRms();
      const nextOut = this.playingSources.size > 0 ? Math.max(0, Math.min(1, outRms * 4.0)) : 0;
      this.latestOutLevel = nextOut;
      if (
        shouldPublishMeterUpdate(
          { micLevel: st.micLevel, outLevel: st.outLevel },
          { micLevel: nextMic, outLevel: nextOut },
        )
      ) {
        voiceCallStore.set({
          micLevel: Number(nextMic.toFixed(3)),
          outLevel: Number(nextOut.toFixed(3)),
        });
      }
    }, 80);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.meterTimer = timer;
  }

  private sampleOutRms(): number {
    if (!this.outAnalyser || !this.outTimeDomain || this.playingSources.size === 0) {
      return 0;
    }
    this.outAnalyser.getFloatTimeDomainData(this.outTimeDomain);
    let sq = 0;
    for (let i = 0; i < this.outTimeDomain.length; i++) {
      const v = this.outTimeDomain[i]!;
      sq += v * v;
    }
    return Math.sqrt(sq / this.outTimeDomain.length);
  }

  private buildHudKey(st = voiceCallStore.get()): string {
    const caption = formatHudCaption(st.lines);
    return JSON.stringify([st.status, st.assistant, st.muted, st.task, st.startedAt, caption, this.dspBadge]);
  }

  private startHudSync(): void {
    if (!native.available() || this.unsubHudSync) return;
    this.hudScheduler = createHudSyncScheduler((open) => this.pushHudSync(open));
    this.unsubHudSync = voiceCallStore.subscribe(() => {
      if (this.ended || !this.hudShown) return;
      const st = voiceCallStore.get();
      if (st.status === "idle") return;
      this.hudScheduler?.sync(this.buildHudKey(st));
    });
  }

  private pushHudSync(open = false): void {
    if (this.ended || !this.hudShown || !native.available()) return;
    const st = voiceCallStore.get();
    if (st.status === "idle") return;
    const payload: VoiceHudSyncState = {
      state: st.status === "connecting" ? "connecting" : "active",
      ...(open ? { open: true } : {}),
      ...(this.seq !== undefined ? { seq: this.seq } : {}),
      phase: st.assistant,
      muted: st.muted,
      level: Math.max(st.micLevel, st.outLevel),
      startedAt: st.startedAt,
      task: st.task,
      caption: formatHudCaption(st.lines),
      ...(this.dspBadge !== undefined ? { dspBadge: this.dspBadge } : {}),
    };
    void native.voiceHudSync(payload);
  }

  private enqueueDspBatch(pcm960: Int16Array): void {
    if (this.dspPendingCount >= 4) {
      return;
    }
    const bytes = new Uint8Array(pcm960.buffer, pcm960.byteOffset, pcm960.byteLength);
    const b64 = uint8ArrayToBase64(bytes);
    this.dspPendingCount += 1;
    this.dspChain = this.dspChain
      .then(async () => {
        if (this.ended || voiceCallStore.get().muted || this.ws?.readyState !== WebSocket.OPEN) {
          return;
        }
        const chunk = await native.voiceCallDspProcess(b64);
        if (this.ended || voiceCallStore.get().muted || this.ws?.readyState !== WebSocket.OPEN) {
          return;
        }
        this.latestMicLevel = Math.max(0, Math.min(1, Number(chunk.level) || 0));
        if (chunk.pcmBase64) {
          this.ws.send(base64ToUint8Array(chunk.pcmBase64));
        }
      })
      .catch(() => {})
      .finally(() => {
        this.dspPendingCount = Math.max(0, this.dspPendingCount - 1);
      });
  }

  private setupMicCapture(): void {
    if (!this.ctx || !this.stream) return;
    const inRate = this.ctx.sampleRate;
    const outRate = 16_000;
    const step = inRate / outRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;

    this.processor.onaudioprocess = (e) => {
      if (this.ended || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      if (voiceCallStore.get().muted) {
        this.latestMicLevel = 0;
        this.resampleCarry = [];
        this.micPcmQueue = [];
        this.dspBatchQueue = [];
        return;
      }
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i++) {
        this.resampleCarry.push(input[i]!);
      }

      let pos = 0;
      while (pos + 1 < this.resampleCarry.length) {
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const s = this.resampleCarry[i0]! * (1 - frac) + this.resampleCarry[i0 + 1]! * frac;
        const clamped = Math.max(-1, Math.min(1, s));
        this.micPcmQueue.push(Math.round(clamped * 32767));
        pos += step;
      }
      this.resampleCarry = this.resampleCarry.slice(Math.floor(pos));

      // Process 20ms frames (320 samples = 640 bytes)
      while (this.micPcmQueue.length >= 320) {
        const frame = this.micPcmQueue.splice(0, 320);
        let sq = 0;
        for (let i = 0; i < 320; i++) {
          const f = frame[i]! / 32768;
          sq += f * f;
        }
        const frameRms = Math.sqrt(sq / 320);
        const decision = this.echoGate.evaluate({
          frameRms,
          outRms: this.sampleOutRms(),
          speakerPlaying: this.playingSources.size > 0 || this.speaking,
          lastSpeakerEndedAt: this.lastSpeakerEndedAt,
          aecMode: this.aecMode,
        });
        this.latestMicLevel = decision.allow ? Math.min(1, frameRms * 4.2) : 0;

        if (this.dspActive) {
          for (let i = 0; i < 320; i++) {
            this.dspBatchQueue.push(decision.allow ? frame[i]! : 0);
          }
          while (this.dspBatchQueue.length >= 960) {
            const batchSamples = this.dspBatchQueue.splice(0, 960);
            const pcm960 = Int16Array.from(batchSamples);
            this.enqueueDspBatch(pcm960);
          }
        } else if (decision.allow) {
          const buf = new ArrayBuffer(640);
          const view = new DataView(buf);
          for (let i = 0; i < 320; i++) {
            view.setInt16(i * 2, frame[i]!, true);
          }
          this.ws.send(buf);
        } else {
          this.ws.send(new Uint8Array(640));
        }
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private onText(raw: string): void {
    let msg: { action?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const action = msg.action ?? "";
    const d = msg.data ?? {};
    const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : typeof d[k] === "number" ? String(d[k]) : "");
    const turn = numTurn(d.turn) ?? numTurn(d.turn_id);

    switch (action) {
      case "relay.state": {
        const st = str("state");
        if (st === "ready") {
          if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
          if (!this.reachedReady) {
            this.reachedReady = true;
            this.startedAtMs = Date.now();
            logger.info("voice.call", `call ready (aecMode=${this.aecMode}, dsp=${this.dspActive ? "onnx" : "off"})`);
          }
          voiceCallStore.set((prev) => ({
            ...prev,
            status: "ready",
            startedAt: prev.startedAt ?? this.startedAtMs ?? Date.now(),
          }));
        } else if (st === "error") {
          this.cleanup(str("message") || "小羊实时语音连接失败", true);
        } else if (st === "closed") {
          this.cleanup(str("message") || "通话结束了", false);
        }
        break;
      }
      case "media.output.configured": {
        const r = Number(d.sample_rate);
        if (Number.isFinite(r) && r >= 8000 && r <= 96000) this.sampleRate = r;
        break;
      }
      case "response.audio.context":
        this.contexts.push({ chunkId: str("chunk_id"), runId: str("run_id"), turnId: str("turn_id") });
        if (this.contexts.length > 512) this.contexts.shift();
        break;
      case "response.audio.started":
        this.speaking = true;
        if (turn !== undefined) this.lastAnsweredTurn = Math.max(this.lastAnsweredTurn, turn);
        voiceCallStore.set({ assistant: "speaking" });
        break;
      case "response.audio.done": {
        const runId = str("run_id");
        const turnId = str("turn_id");
        const res = this.playout.markAudioDone(runId, turnId);
        if (res.emitCompleted) {
          this.sendJson({ action: "playback.completed", run_id: runId, turn_id: turnId });
        }
        if (res.allIdle && this.playingSources.size === 0) {
          this.speaking = false;
          this.latestOutLevel = 0;
          voiceCallStore.set({ assistant: "idle", outLevel: 0 });
        }
        break;
      }
      case "response.audio.stop": {
        const runId = str("run_id");
        const turnId = str("turn_id");
        if (this.playingSources.size > 0 || this.speaking) {
          this.interruptions += 1;
        }
        for (const s of [...this.playingSources]) {
          const sRun = this.sourceRunMap.get(s);
          if (!runId || !sRun || sRun === runId) {
            this.playingSources.delete(s);
            this.sourceRunMap.delete(s);
            try {
              s.stop();
            } catch {
              // ignore
            }
          }
        }
        if (this.ctx && this.playingSources.size === 0) {
          this.nextPlayTime = this.ctx.currentTime;
        }
        const stopRes = this.playout.markStopped(runId, turnId);
        this.sendJson({
          action: "playback.stopped",
          run_id: runId,
          turn_id: stopRes.turnId || turnId,
          played_audio_ms: Math.round(stopRes.playedMs),
          reason: str("reason") || "interrupted",
        });
        this.echoGate.reset();
        if (stopRes.allIdle && this.playingSources.size === 0) {
          this.speaking = false;
          this.latestOutLevel = 0;
          this.lastSpeakerEndedAt = Date.now();
          voiceCallStore.set({ assistant: "idle", outLevel: 0 });
        }
        break;
      }
      case "input.speech.started":
        this.turns += 1;
        this.speaking = false;
        this.currentUserTurn = turn;
        this.lastSpeakerEndedAt = null;
        this.echoGate.reset();
        voiceCallStore.set({ assistant: "idle" });
        break;
      case "input.speech.stopped":
        voiceCallStore.set((prev) => ({
          ...prev,
          assistant: !this.speaking && (this.currentUserTurn === undefined || this.currentUserTurn > this.lastAnsweredTurn) ? "thinking" : prev.assistant,
        }));
        break;
      case "input.transcript.updated":
      case "input.transcript.done":
      case "input.transcript.revised": {
        const text = str("transcript") || str("text");
        const tid = str("turn_id") || String(turn ?? "");
        if (!text.trim()) break;
        if (turn !== undefined) this.currentUserTurn = turn;
        const line: CallCaptionLine = {
          id: `${this.callId}-u-${tid || "live"}`,
          role: "user",
          text,
          final: action !== "input.transcript.updated",
          turn,
        };
        voiceCallStore.set((prev) => ({ ...prev, lines: upsertCallLine(prev.lines, line) }));
        break;
      }
      case "output.transcript.updated":
      case "output.transcript.done": {
        const text = str("transcript") || str("text");
        const rid = str("run_id") || str("turn_id");
        if (!text.trim()) break;
        if (turn !== undefined) this.lastAnsweredTurn = Math.max(this.lastAnsweredTurn, turn);
        const line: CallCaptionLine = {
          id: `${this.callId}-a-${rid || "live"}`,
          role: "assistant",
          text,
          final: action === "output.transcript.done",
          turn,
        };
        voiceCallStore.set((prev) => ({
          ...prev,
          lines: upsertCallLine(prev.lines, line),
          assistant: this.speaking ? "speaking" : action === "output.transcript.done" ? "idle" : prev.assistant,
        }));
        break;
      }
      case "relay.task": {
        const st = str("status");
        const title = str("title");
        voiceCallStore.set({ task: st === "running" ? title : null });
        break;
      }
      default:
        break;
    }
  }

  private onBinary(buf: ArrayBuffer): void {
    const ref = this.contexts.shift();
    if (!ref || this.playout.isStopped(ref.runId) || !this.ctx) return;
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
    const samples = Math.floor(buf.byteLength / 2);
    if (samples <= 0) return;

    const pcm = new DataView(buf);
    const floats = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      floats[i] = pcm.getInt16(i * 2, true) / 32768;
    }

    const audioBuf = this.ctx.createBuffer(1, samples, this.sampleRate);
    audioBuf.copyToChannel(floats, 0);
    const node = this.ctx.createBufferSource();
    node.buffer = audioBuf;
    node.connect(this.outGain ?? this.ctx.destination);

    const startAt = computePlayoutStartTime(this.ctx.currentTime, this.nextPlayTime);
    const durSec = samples / this.sampleRate;
    this.nextPlayTime = startAt + durSec;
    this.playingSources.add(node);
    this.sourceRunMap.set(node, ref.runId);
    this.playout.enqueueChunk(ref.runId, ref.turnId, durSec * 1000);

    node.onended = () => {
      this.playingSources.delete(node);
      this.sourceRunMap.delete(node);
      const wasStopped = this.playout.isStopped(ref.runId);
      const res = this.playout.onChunkEnded(ref.runId);
      if (!this.ended && !wasStopped) {
        this.sendJson({
          action: "playback.chunk.completed",
          chunk_id: ref.chunkId,
          run_id: ref.runId,
          turn_id: ref.turnId,
        });
        if (res.runCompleted) {
          this.sendJson({
            action: "playback.completed",
            run_id: ref.runId,
            turn_id: res.turnId || ref.turnId,
          });
        }
      }
      if (this.playingSources.size === 0) {
        this.lastSpeakerEndedAt = Date.now();
        this.latestOutLevel = 0;
        if (!this.ended && (res.runCompleted || (res.allIdle && this.playout.isFinished(ref.runId)))) {
          this.speaking = false;
          voiceCallStore.set({ assistant: "idle", outLevel: 0 });
        } else if (!this.ended && voiceCallStore.get().outLevel !== 0) {
          voiceCallStore.set({ outLevel: 0 });
        }
      }
    };
    node.start(startAt);
  }

  setMuted(muted: boolean): void {
    if (muted) {
      this.latestMicLevel = 0;
      this.dspBatchQueue = [];
    }
    voiceCallStore.set({ muted, ...(muted ? { micLevel: 0 } : {}) });
    if (this.usedNativeMic || native.available()) {
      void native.voiceCallMicSetMuted(muted);
    }
    this.sendJson({ action: "mic_state", enabled: !muted });
  }

  hangup(): void {
    this.sendJson({ action: "relay.hangup" });
    this.cleanup("挂断了", false);
  }

  private cleanup(message?: string, isError = false): void {
    if (this.ended) return;
    this.ended = true;
    const wasHudShown = this.hudShown;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.meterTimer) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    this.hudScheduler?.dispose();
    this.hudScheduler = null;
    this.unsubHudSync?.();
    this.unsubHudSync = null;
    this.unsubNativeMic?.();
    this.unsubNativeMic = null;

    if (this.usedNativeMic) {
      this.usedNativeMic = false;
      void native.voiceCallMicStop();
    }
    if (this.dspOpened || (!this.mock && native.available())) {
      this.dspOpened = false;
      this.dspActive = false;
      void native.voiceCallDspClose();
    }

    if (wasHudShown && native.available()) {
      if (isError && message) {
        void native.voiceHudSync({
          state: "error",
          message,
          ...(this.seq !== undefined ? { seq: this.seq } : {}),
        });
      } else {
        void native.voiceHudHide();
      }
    }

    try {
      this.ws?.close(1000, "bye");
    } catch {
      // ignore
    }
    this.ws = null;
    for (const s of this.playingSources) {
      try {
        s.stop();
      } catch {
        // ignore
      }
    }
    this.playingSources.clear();
    this.sourceRunMap.clear();
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.silentGain?.disconnect();
      this.outGain?.disconnect();
      this.outAnalyser?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      void this.ctx?.close();
    } catch {
      // ignore
    }
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.outGain = null;
    this.outAnalyser = null;
    this.outTimeDomain = null;
    this.stream = null;
    this.ctx = null;
    this.latestMicLevel = 0;
    this.latestOutLevel = 0;

    if (!this.mock) {
      const durationMs = this.startedAtMs !== null ? Math.max(0, Date.now() - this.startedAtMs) : 0;
      logger.info(
        "voice.call",
        `call ended (aecMode=${this.aecMode}, turns=${this.turns}, interruptions=${this.interruptions}, durationMs=${durationMs}, error=${isError})`,
      );
    }

    if (activeCall === this) {
      activeCall = null;
    }
    voiceCallStore.set({
      status: "idle",
      muted: false,
      assistant: "idle",
      micLevel: 0,
      outLevel: 0,
      task: null,
      startedAt: null,
      hudShown: false,
      message: message ?? null,
      error: isError && message ? message : null,
    });
  }
}

let activeCall: WebVoiceSession | null = null;

export async function startVoiceCall(opts?: { showHud?: boolean; seq?: number }): Promise<string | null> {
  if (activeCall) {
    if (opts?.showHud && !activeCall.isHudShown()) {
      activeCall.attachHud(opts.seq);
    }
    return null;
  }
  const server = settingsStore.get().server;
  const session = new WebVoiceSession(
    Boolean(server && isMockServer(server)),
    Boolean(opts?.showHud),
    opts?.seq,
  );
  activeCall = session;
  const err = await session.start();
  if (err && activeCall === session) {
    activeCall = null;
  }
  return err;
}

export function attachHudToVoiceCall(seq?: number): void {
  activeCall?.attachHud(seq);
}

export function setVoiceMuted(muted: boolean): void {
  activeCall?.setMuted(muted);
}

export function hangupVoiceCall(): void {
  if (activeCall) {
    const cur = activeCall;
    activeCall = null;
    cur.hangup();
  } else if (voiceCallStore.get().hudShown) {
    voiceCallStore.set({ hudShown: false, status: "idle" });
    void native.voiceHudHide();
  }
}

export function dismissVoiceMessage(): void {
  voiceCallStore.set({ message: null });
}
