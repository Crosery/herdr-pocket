import { createStore, settingsStore } from "./store";
import { getActiveToken, wsUrlFor } from "./relay";
import { requestMicrophonePermission } from "./bridge";
import { isMockServer } from "./mock";

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
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly mock: boolean) {}

  async start(): Promise<string | null> {
    this.callId = Date.now();
    this.ended = false;
    voiceCallStore.set({
      status: "connecting",
      muted: false,
      assistant: "idle",
      micLevel: 0,
      outLevel: 0,
      lines: [],
      task: null,
      message: null,
      error: null,
    });

    if (this.mock) {
      voiceCallStore.set({
        status: "ready",
        lines: [{ id: "mock-1", role: "assistant", text: "你好，这是演示模式的语音通话界面。", final: true, turn: 1 }],
      });
      return null;
    }

    const okPerm = await requestMicrophonePermission();
    if (!okPerm) {
      this.cleanup("没有麦克风权限");
      return "没有麦克风权限";
    }

    const server = settingsStore.get().server;
    const token = getActiveToken();
    if (!server || !token) {
      this.cleanup("还没连上服务器");
      return "还没连上服务器";
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
      this.cleanup("打不开麦克风");
      return "打不开麦克风，请检查系统权限或设备连接";
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx({ sampleRate: 48_000 });
    await this.ctx.resume().catch(() => {});

    const ws = new WebSocket(wsUrlFor(server, "/v1/assistant/live", token));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.setupMicCapture();
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
      if (!this.ended) this.cleanup("通话结束了");
    };
    ws.onerror = () => {
      if (!this.ended) this.cleanup("语音连接断开");
    };
    return null;
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
        if (st === "ready") voiceCallStore.set({ status: "ready" });
        else if (st === "error" || st === "closed") this.cleanup(str("message") || "通话结束了");
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
    voiceCallStore.set({ muted });
    this.sendJson({ action: "mic_state", enabled: !muted });
  }

  hangup(): void {
    this.sendJson({ action: "relay.hangup" });
    this.cleanup("挂断了");
  }

  private cleanup(message?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
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
    voiceCallStore.set({
      status: "idle",
      muted: false,
      assistant: "idle",
      micLevel: 0,
      outLevel: 0,
      task: null,
      message: message ?? null,
    });
  }
}

let activeCall: WebVoiceSession | null = null;

export async function startVoiceCall(): Promise<string | null> {
  if (activeCall) return null;
  const server = settingsStore.get().server;
  const session = new WebVoiceSession(Boolean(server && isMockServer(server)));
  activeCall = session;
  const err = await session.start();
  if (err && activeCall === session) {
    activeCall = null;
  }
  return err;
}

export function setVoiceMuted(muted: boolean): void {
  activeCall?.setMuted(muted);
}

export function hangupVoiceCall(): void {
  activeCall?.hangup();
  activeCall = null;
}

export function dismissVoiceMessage(): void {
  voiceCallStore.set({ message: null });
}
