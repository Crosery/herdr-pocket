import { createStore, settingsStore } from "./store";
import { assistantStore, loadAssistant } from "./assistant";
import { getActiveToken, wsUrlFor } from "./relay";
import { detectPlatform, requestMicrophonePermission } from "./bridge";
import { isMockServer } from "./mock";
import { native, type VoiceHudSyncState } from "./native";

export interface CallCaptionLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  turn?: number;
}

export type VoiceCallStatus = "idle" | "connecting" | "ready";

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

export function formatHudCaption(lines: CallCaptionLine[]): string {
  const last = lines[lines.length - 1];
  if (!last || !last.text.trim()) return "";
  return `${last.role === "user" ? "你：" : "小羊："}${last.text.trim()}`;
}

interface PendingAudioRef {
  chunkId: string;
  runId: string;
  turnId: string;
}

class WebVoiceSession {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;
  private resampleCarry: number[] = [];
  private micPcmQueue: number[] = [];
  private sampleRate = 48_000;
  private nextPlayTime = 0;
  private contexts: PendingAudioRef[] = [];
  private stoppedRuns = new Set<string>();
  private playedMsByRun = new Map<string, number>();
  private playingSources = new Set<AudioBufferSourceNode>();
  private speaking = false;
  private lastAnsweredTurn = -1;
  private currentUserTurn: number | undefined;
  private callId = 0;
  private ended = false;
  private reachedReady = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private unsubNativeMic: (() => void) | null = null;
  private usedNativeMic = false;
  private unsubHudSync: (() => void) | null = null;
  private hudTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHudKey = "";
  private lastHudAt = 0;

  constructor(
    private readonly mock: boolean,
    private hudShown: boolean,
    private seq?: number,
  ) {}

  isHudShown(): boolean {
    return this.hudShown;
  }

  attachHud(seq?: number): void {
    if (this.ended) return;
    this.hudShown = true;
    if (seq !== undefined) this.seq = seq;
    voiceCallStore.set({ hudShown: true });
    this.startHudSync();
    this.pushHudSync(true);
  }

  async start(): Promise<string | null> {
    this.callId = Date.now();
    this.ended = false;
    this.reachedReady = false;
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
      this.pushHudSync(true);
    }

    if (this.mock) {
      this.reachedReady = true;
      voiceCallStore.set({
        status: "ready",
        startedAt: Date.now(),
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

    const platform = detectPlatform();
    const useNativeMic = native.available() && (platform === "macos" || platform === "windows");

    if (useNativeMic) {
      this.usedNativeMic = true;
      this.unsubNativeMic = native.onVoiceCallMic((ev) => {
        if (this.ended) return;
        if (voiceCallStore.get().muted) {
          voiceCallStore.set({ micLevel: 0 });
          return;
        }
        const level = Math.max(0, Math.min(1, Number(ev.level) || 0));
        voiceCallStore.set({ micLevel: level });
        if (ev.pcmBase64 && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(base64ToUint8Array(ev.pcmBase64));
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
      const okPerm = await requestMicrophonePermission();
      if (!okPerm) {
        this.cleanup("没有麦克风权限", true);
        return "没有麦克风权限";
      }
      try {
        const denoise = settingsStore.get().denoise;
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: denoise,
            autoGainControl: true,
          },
        });
      } catch {
        this.cleanup("打不开麦克风，请检查系统权限或设备连接", true);
        return "打不开麦克风，请检查系统权限或设备连接";
      }
      if (this.ended) return null;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      this.ctx = new AudioCtx({ sampleRate: 48_000 });
      await this.ctx.resume().catch(() => {});
    }
    if (this.ended) return null;

    const ws = new WebSocket(wsUrlFor(server, "/v1/assistant/live", token));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (this.ended) {
        ws.close(1000, "bye");
        return;
      }
      if (!this.usedNativeMic) {
        this.setupMicCapture();
      }
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.sendJson({ action: "ping", timestamp: Date.now() });
        }
      }, 20_000);
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

  private startHudSync(): void {
    if (!native.available() || this.unsubHudSync) return;
    this.lastHudKey = "";
    this.lastHudAt = 0;
    this.unsubHudSync = voiceCallStore.subscribe(() => {
      if (this.ended || !this.hudShown) return;
      const st = voiceCallStore.get();
      if (st.status === "idle") return;
      const caption = formatHudCaption(st.lines);
      const key = JSON.stringify([st.status, st.assistant, st.muted, st.task, st.startedAt, caption]);
      if (key !== this.lastHudKey) {
        this.lastHudKey = key;
        if (this.hudTimer) {
          clearTimeout(this.hudTimer);
          this.hudTimer = null;
        }
        this.lastHudAt = Date.now();
        this.pushHudSync(false);
        return;
      }
      const elapsed = Date.now() - this.lastHudAt;
      if (elapsed >= 30) {
        if (this.hudTimer) {
          clearTimeout(this.hudTimer);
          this.hudTimer = null;
        }
        this.lastHudAt = Date.now();
        this.pushHudSync(false);
      } else if (!this.hudTimer) {
        this.hudTimer = setTimeout(() => {
          this.hudTimer = null;
          this.lastHudAt = Date.now();
          this.pushHudSync(false);
        }, 30 - elapsed);
      }
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
    };
    void native.voiceHudSync(payload);
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
      if (this.ended || voiceCallStore.get().muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const input = e.inputBuffer.getChannelData(0);
      let sq = 0;
      for (let i = 0; i < input.length; i++) {
        sq += input[i]! * input[i]!;
        this.resampleCarry.push(input[i]!);
      }
      const rms = Math.sqrt(sq / Math.max(1, input.length));
      voiceCallStore.set({ micLevel: Math.min(1, rms * 4.2) });

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

      // Send 20ms frames (320 samples = 640 bytes)
      while (this.micPcmQueue.length >= 320) {
        const frame = this.micPcmQueue.splice(0, 320);
        const buf = new ArrayBuffer(640);
        const view = new DataView(buf);
        for (let i = 0; i < 320; i++) {
          view.setInt16(i * 2, frame[i]!, true);
        }
        this.ws.send(buf);
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
          this.reachedReady = true;
          voiceCallStore.set((prev) => ({
            ...prev,
            status: "ready",
            startedAt: prev.startedAt ?? Date.now(),
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
        if (!this.stoppedRuns.has(runId)) {
          this.sendJson({ action: "playback.completed", run_id: runId, turn_id: turnId });
        }
        this.speaking = false;
        voiceCallStore.set({ assistant: "idle", outLevel: 0 });
        break;
      }
      case "response.audio.stop": {
        const runId = str("run_id");
        const turnId = str("turn_id");
        this.stoppedRuns.add(runId);
        for (const s of this.playingSources) {
          try {
            s.stop();
          } catch {
            // ignore
          }
        }
        this.playingSources.clear();
        if (this.ctx) this.nextPlayTime = this.ctx.currentTime;
        const played = Math.round(this.playedMsByRun.get(runId) ?? 0);
        this.sendJson({
          action: "playback.stopped",
          run_id: runId,
          turn_id: turnId,
          played_audio_ms: played,
          reason: str("reason") || "interrupted",
        });
        this.speaking = false;
        voiceCallStore.set({ assistant: "idle", outLevel: 0 });
        break;
      }
      case "input.speech.started":
        this.speaking = false;
        this.currentUserTurn = undefined;
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
    if (!ref || this.stoppedRuns.has(ref.runId) || !this.ctx) return;
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
    const samples = Math.floor(buf.byteLength / 2);
    if (samples <= 0) return;

    const pcm = new DataView(buf);
    const floats = new Float32Array(samples);
    let sq = 0;
    for (let i = 0; i < samples; i++) {
      const f = pcm.getInt16(i * 2, true) / 32768;
      floats[i] = f;
      sq += f * f;
    }
    const rms = Math.sqrt(sq / samples);
    voiceCallStore.set({ outLevel: Math.min(1, rms * 4.0) });

    const audioBuf = this.ctx.createBuffer(1, samples, this.sampleRate);
    audioBuf.copyToChannel(floats, 0);
    const node = this.ctx.createBufferSource();
    node.buffer = audioBuf;
    node.connect(this.ctx.destination);

    const startAt = Math.max(this.ctx.currentTime + 0.015, this.nextPlayTime);
    const durSec = samples / this.sampleRate;
    this.nextPlayTime = startAt + durSec;
    this.playingSources.add(node);
    this.playedMsByRun.set(ref.runId, (this.playedMsByRun.get(ref.runId) ?? 0) + durSec * 1000);

    node.onended = () => {
      this.playingSources.delete(node);
      if (!this.ended && !this.stoppedRuns.has(ref.runId)) {
        this.sendJson({
          action: "playback.chunk.completed",
          chunk_id: ref.chunkId,
          run_id: ref.runId,
          turn_id: ref.turnId,
        });
      }
    };
    node.start(startAt);
  }

  setMuted(muted: boolean): void {
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
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.hudTimer) {
      clearTimeout(this.hudTimer);
      this.hudTimer = null;
    }
    this.unsubHudSync?.();
    this.unsubHudSync = null;
    this.unsubNativeMic?.();
    this.unsubNativeMic = null;

    if (this.usedNativeMic) {
      this.usedNativeMic = false;
      void native.voiceCallMicStop();
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
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.silentGain?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      void this.ctx?.close();
    } catch {
      // ignore
    }
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.stream = null;
    this.ctx = null;
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
