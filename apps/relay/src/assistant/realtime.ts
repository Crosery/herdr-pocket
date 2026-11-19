/**
 * A voice call through a service that speaks the OpenAI Realtime protocol
 * (OpenAI, Azure OpenAI; the "beta" dialect for services still on the older
 * event names). The phone is not told: it keeps the MOSS-Live-shaped events and
 * audio formats it already handles, and this file translates both ways.
 *
 * Phone side: 16 kHz mono PCM16 microphone in; 48 kHz mono PCM16 speech out,
 * each binary frame after a `response.audio.context`; playback receipts back.
 * Upstream: base64 PCM16 at the service's rate (24 kHz for OpenAI) in JSON events.
 * Tasks the voice hands over arrive as calls of one function tool and are done
 * by the text assistant, like MOSS-Live delegations.
 *
 * Protocol: https://platform.openai.com/docs/guides/realtime (GA interface).
 */
import { randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import type { LiveRelayEvent, LogLevel, Notice } from "@herdr-pocket/protocol";
import type { EventInput } from "../eventlog.ts";
import type { Assistant } from "./assistant.ts";
import { claimCall, releaseCall } from "./calls.ts";
import { personaPrompt, voiceInstructions } from "./prompts.ts";
import { clip } from "./speech.ts";

export interface RealtimeConfig {
  provider: "openai-realtime";
  /** e.g. wss://api.openai.com/v1/realtime; `model` is added as a query parameter unless the URL has one. */
  url: string;
  apiKey: string;
  model: string;
  /** `api-key` header (Azure) instead of `Authorization: Bearer`. */
  auth?: "bearer" | "api-key";
  voice?: string;
  /** Speaking rate (GA only), 0.25–1.5. */
  speed?: number;
  /** `ga`: the current OpenAI interface. `beta`: flat session fields and `response.audio.*` events. */
  dialect?: "ga" | "beta";
  /** Speech-to-text model for the person's captions; none means no captions of what they said. */
  transcribeModel?: string;
  language?: string;
  vad?: "server_vad" | "semantic_vad";
  /** OpenAI Realtime GA background-speaker suppression (`near_field` for phones/headsets). */
  noiseReduction?: "near_field" | "far_field" | null;
  /** Sample rates the service takes and gives (24 kHz for OpenAI). */
  inputRate?: number;
  outputRate?: number;
  /** Least time between two refreshes of the voice's instructions. */
  refreshGapMs?: number;
  /** Max ms to hold assistant captions while waiting for the person's ASR of the same turn. */
  asrHoldMs?: number;
}

const PHONE_MIC_RATE = 16_000;
const PHONE_SPEAKER_RATE = 48_000;
const ATTACH_TIMEOUT_MS = 15_000;
const REFRESH_GAP_MS = 5000;
const ASR_HOLD_MS = 900;
const ASR_SPEECH_MAX_MS = 5000;
const MAX_INSTRUCTIONS = 16_000;
/** After the person stops, the service starts its own answer: a notice waits this long so the two do not collide. */
const AFTER_SPEECH_MS = 1500;
/** Speech counts as heard this long after its audio's length at the latest, receipt or not. */
const PLAYBACK_SLACK_MS = 1500;
/** An answer whose end was never announced must not hold everything back for good. */
const ACTIVE_MAX_MS = 60_000;
const CREATE_MAX_MS = 10_000;
const TOOL = "ask_backend";

const ASK_TOOL = {
  type: "function",
  name: TOOL,
  description: "交给后台：查 agent 的具体情况（在干什么、说了什么、为什么卡住），或替我动手（给 agent 发消息、按键、开新 agent、建空间、改名、定提醒、取消提醒）。",
  parameters: {
    type: "object",
    properties: { objective: { type: "string", description: "我的原话，带上正在说的是哪个 agent" } },
    required: ["objective"],
  },
};

/** How the rules' "hand it to the backend" works on this protocol. */
const BRIDGE = `【后台怎么交】
下面说的“交给后台”，就是调用 ${TOOL} 工具：objective 写我的原话，带上正在说的是哪个 agent。调用前可以短短应一声。
工具返回里“台词”那句，就是回来的那句话；“备查”不出声，我追问时才用。
系统消息里的【要告诉我的事】，现在就主动说，一句话，说过就不再提。`;

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const asBuffer = (d: RawData): Buffer =>
  Buffer.isBuffer(d)
    ? d
    : Array.isArray(d)
      ? d.length === 1
        ? d[0]!
        : Buffer.concat(d)
      : Buffer.from(d);
const rawByteLen = (d: RawData): number => (Array.isArray(d) ? d.reduce((n, b) => n + b.length, 0) : d instanceof ArrayBuffer ? d.byteLength : d.length);

// ---------------------------------------------------------------------------
// Server-side PCM16 16 kHz stream continuity + client AI inference telemetry
// ---------------------------------------------------------------------------

/** 16 kHz mono PCM16 LE: 16 samples/ms * 2 bytes = 32 bytes/ms; 10 ms hop = 160 samples. */
const MIC_BYTES_PER_MS = 32;
const MIC_HOP_SAMPLES = 160;
const FULL_SCALE = 32768;
const SILENCE_DBFS = -100;
const AI_RATE_MAX_PER_MIN = 60;
const AI_RATE_WINDOW_MS = 60_000;
const RX_WINDOW_MS = 10_000;
const RECENT_HOPS = 200; // 2.0 s rolling window at 10 ms/hop
const FORBIDDEN_AI_KEYS = new Set(["action", "text", "transcript", "previous", "prompt", "instructions"]);
const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/i;

const normZero = (n: number): number => (Object.is(n, -0) ? 0 : n);
const round1 = (n: number): number => normZero(Math.round(n * 10) / 10);
const round2 = (n: number): number => normZero(Math.round(n * 100) / 100);
const round3 = (n: number): number => normZero(Math.round(n * 1000) / 1000);
const cleanStr = (s: string, max: number): string => Array.from(s.replace(/\s+/g, " ").trim()).slice(0, max).join("");

function rmsDbfs(sumSq: number, samples: number): number {
  if (samples <= 0 || sumSq <= 0) return SILENCE_DBFS;
  return round2(Math.max(SILENCE_DBFS, 20 * Math.log10(Math.sqrt(sumSq / samples) / FULL_SCALE)));
}

function peakDbfs(peak: number): number {
  if (peak <= 0) return SILENCE_DBFS;
  return round2(Math.max(SILENCE_DBFS, 20 * Math.log10(peak / FULL_SCALE)));
}

interface RxBucket {
  frames: number;
  bytes: number;
  gapMaxMs: number;
  gapsOver80: number;
  hops: number;
  zeroHops: number;
  activeSumSq: number;
  activeSamples: number;
  peak: number;
  clipped: number;
}

const emptyBucket = (): RxBucket => ({
  frames: 0,
  bytes: 0,
  gapMaxMs: 0,
  gapsOver80: 0,
  hops: 0,
  zeroHops: 0,
  activeSumSq: 0,
  activeSamples: 0,
  peak: 0,
  clipped: 0,
});

interface ClientAiState {
  route?: string;
  denoise_model?: string;
  tse_enabled?: boolean;
  sv_enabled?: boolean;
  denoise_enabled?: boolean;
  threshold?: number;
  prototypes_count?: number;
  enroll_ms?: number;
  sv_score?: number;
  sv_raw?: number;
  sv_proto?: number;
  sv_sess?: number;
  sv_ms?: number;
  pass?: boolean;
  tse_atten_db?: number;
  raw_dbfs?: number;
  tse_dbfs?: number;
  enh_dbfs?: number;
  enh_gain_db?: number;
  dpdf_us_avg?: number;
  dpdf_us_max?: number;
  tse_ms_avg?: number;
  tse_ms_max?: number;
  tse_rtf?: number;
  tse_overruns?: number;
  ws_gap_max_ms?: number;
  vad_speech_ratio?: number;
  gated_ratio?: number;
}

export interface CallTelemetryOptions {
  callId: string;
  provider: "moss-live" | "openai-realtime";
  deviceId: string;
  log: (m: string) => void;
  event?: (ev: EventInput) => void;
  now?: () => number;
  /** Periodic incoming PCM window interval in ms; 0 disables the background timer (for deterministic tests). */
  windowMs?: number;
}

/**
 * Correlates server-side 16 kHz PCM stream continuity/clarity, upstream VAD/ASR/TTFA/barge-in
 * timings, and the phone's `client.ai_telemetry` inference diagnostics under `kind: "live.ai"`.
 * Raw user/assistant transcript words are never written to `EventLog`.
 */
export class CallTelemetry {
  readonly callId: string;
  readonly provider: "moss-live" | "openai-realtime";
  private now: () => number;
  private emit: (ev: EventInput) => void;
  private startedAt: number;
  private ready = false;
  private stopped = false;
  private micMuted = false;
  private windowTimer: NodeJS.Timeout | null = null;

  private preReadyDroppedBytes = 0;
  private lastRxAt = 0;
  private win: RxBucket = emptyBucket();
  private total: RxBucket = emptyBucket();

  private recentSumSq = new Float64Array(RECENT_HOPS);
  private recentSamples = new Int32Array(RECENT_HOPS);
  private recentPos = 0;
  private recentTotalSumSq = 0;
  private recentTotalSamples = 0;

  private turn = 0;
  private seenTurns = new Set<string>();
  private userSpeaking = false;
  private speechStartAt = 0;
  private speechStoppedAt = 0;
  private lastSpeechMs: number | undefined;
  private turnActiveSumSq = 0;
  private turnActiveSamples = 0;
  private turnAsrRecorded = false;
  private turnTtfaRecorded = false;
  private asrSamples: number[] = [];
  private ttfaSamples: number[] = [];
  private interruptions = 0;

  private lastAi: ClientAiState = {};
  private clientAiEvents = 0;
  private clientAiDropped = 0;
  private aiRateSince = 0;
  private aiRateCount = 0;
  private aiRateNoted = false;

  constructor(opts: CallTelemetryOptions) {
    this.callId = opts.callId;
    this.provider = opts.provider;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.emit = opts.event
      ? (ev) => opts.event!({ device: opts.deviceId, ...ev })
      : (ev) => {
          const extra = ev.data ? ` ${JSON.stringify(ev.data)}` : "";
          opts.log(`${ev.kind}: ${ev.msg}${extra}`);
        };
    const winMs = opts.windowMs ?? RX_WINDOW_MS;
    if (winMs > 0) {
      this.windowTimer = setInterval(() => this.flushWindow(), winMs);
      this.windowTimer.unref?.();
    }
  }

  onReady(): void {
    this.ready = true;
  }

  onMicState(enabled: boolean): void {
    this.micMuted = !enabled;
    this.lastRxAt = 0;
  }

  onPreReadyBinary(data: RawData): void {
    this.preReadyDroppedBytes += rawByteLen(data);
  }

  /** Zero-copy PCM16 LE 16 kHz frame inspection (< 5 microseconds for a 20 ms frame). */
  onRxPcm(data: RawData): void {
    const buf = asBuffer(data);
    const t = this.now();
    if (!this.micMuted && this.lastRxAt > 0) {
      const gap = Math.max(0, t - this.lastRxAt);
      if (gap > this.win.gapMaxMs) this.win.gapMaxMs = gap;
      if (gap > this.total.gapMaxMs) this.total.gapMaxMs = gap;
      if (gap > 80) {
        this.win.gapsOver80++;
        this.total.gapsOver80++;
      }
    }
    this.lastRxAt = this.micMuted ? 0 : t;

    this.win.frames++;
    this.total.frames++;
    this.win.bytes += buf.length;
    this.total.bytes += buf.length;

    const nSamples = buf.length >> 1;
    let idx = 0;
    while (idx < nSamples) {
      const end = idx + MIC_HOP_SAMPLES <= nSamples ? idx + MIC_HOP_SAMPLES : nSamples;
      const hopLen = end - idx;
      let hopSumSq = 0;
      let hopPeak = 0;
      let hopClipped = 0;
      let hopZero = true;
      for (let i = idx; i < end; i++) {
        const off = i << 1;
        const s = ((buf[off]! | (buf[off + 1]! << 8)) << 16) >> 16;
        if (s !== 0) {
          hopZero = false;
          const a = s < 0 ? -s : s;
          if (a > hopPeak) hopPeak = a;
          if (a >= 32767) hopClipped++;
          hopSumSq += s * s;
        }
      }
      this.win.hops++;
      this.total.hops++;
      if (hopZero) {
        this.win.zeroHops++;
        this.total.zeroHops++;
        this.pushRecentHop(0, 0);
      } else {
        this.win.activeSumSq += hopSumSq;
        this.win.activeSamples += hopLen;
        this.total.activeSumSq += hopSumSq;
        this.total.activeSamples += hopLen;
        if (hopPeak > this.win.peak) this.win.peak = hopPeak;
        if (hopPeak > this.total.peak) this.total.peak = hopPeak;
        this.win.clipped += hopClipped;
        this.total.clipped += hopClipped;
        if (this.userSpeaking) {
          this.turnActiveSumSq += hopSumSq;
          this.turnActiveSamples += hopLen;
        }
        this.pushRecentHop(hopSumSq, hopLen);
      }
      idx = end;
    }
  }

  private pushRecentHop(sumSq: number, samples: number): void {
    const p = this.recentPos;
    this.recentTotalSumSq += sumSq - this.recentSumSq[p]!;
    this.recentTotalSamples += samples - this.recentSamples[p]!;
    if (this.recentTotalSamples <= 0) {
      this.recentTotalSamples = 0;
      this.recentTotalSumSq = 0;
    } else if (this.recentTotalSumSq < 0) {
      this.recentTotalSumSq = 0;
    }
    this.recentSumSq[p] = sumSq;
    this.recentSamples[p] = samples;
    this.recentPos = (p + 1) % RECENT_HOPS;
  }

  private recentActiveDbfs(): number {
    return rmsDbfs(this.recentTotalSumSq, this.recentTotalSamples);
  }

  private aiSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.lastAi.route !== undefined) out.route = this.lastAi.route;
    if (this.lastAi.sv_score !== undefined) out.sv_score = this.lastAi.sv_score;
    if (this.lastAi.tse_atten_db !== undefined) out.tse_atten_db = this.lastAi.tse_atten_db;
    if (this.lastAi.enh_dbfs !== undefined) out.enh_dbfs = this.lastAi.enh_dbfs;
    if (this.lastAi.tse_rtf !== undefined) out.tse_rtf = this.lastAi.tse_rtf;
    return out;
  }

  private syncTurn(rawTurn?: unknown, advance = false): void {
    if (typeof rawTurn === "number" && Number.isFinite(rawTurn) && rawTurn > 0) {
      this.turn = Math.floor(rawTurn);
      this.seenTurns.add(String(this.turn));
      return;
    }
    if (typeof rawTurn === "string" && rawTurn.trim() !== "") {
      const trimmed = rawTurn.trim();
      if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) this.turn = Number(trimmed);
      else if (advance || this.turn === 0) this.turn++;
      this.seenTurns.add(trimmed);
      return;
    }
    if (advance || this.turn === 0) this.turn++;
    this.seenTurns.add(String(this.turn));
  }

  /** Flushes the current 10s incoming PCM window if active frames arrived. */
  flushWindow(): void {
    if (!this.ready || this.stopped || this.win.frames === 0) return;
    const w = this.win;
    const rxAudioMs = round1(w.bytes / MIC_BYTES_PER_MS);
    const rxGapMaxMs = Math.round(w.gapMaxMs);
    const rxZeroRatio = w.hops > 0 ? round3(w.zeroHops / w.hops) : 0;
    const rxActiveDbfs = rmsDbfs(w.activeSumSq, w.activeSamples);
    const rxPeakDbfs = peakDbfs(w.peak);
    const data: Record<string, unknown> = {
      callId: this.callId,
      provider: this.provider,
      stage: "rx_window",
      turn: this.turn,
      rx_frames: w.frames,
      rx_audio_ms: rxAudioMs,
      rx_gap_max_ms: rxGapMaxMs,
      rx_gaps_over_80ms: w.gapsOver80,
      rx_zero_ratio: rxZeroRatio,
      rx_active_dbfs: rxActiveDbfs,
      rx_peak_dbfs: rxPeakDbfs,
      rx_clipped_samples: w.clipped,
      ...this.aiSnapshot(),
    };
    const level: LogLevel = w.gapsOver80 > 0 || rxGapMaxMs > 150 ? "warn" : "info";
    this.emit({
      kind: "live.ai",
      level,
      msg: `rx 10s audio=${rxAudioMs}ms gap_max=${rxGapMaxMs}ms gaps80=${w.gapsOver80} dbfs=${rxActiveDbfs} zero=${rxZeroRatio}`,
      data,
    });
    this.win = emptyBucket();
  }

  /** Ingests a `client.ai_telemetry` message from the phone (never forwarded upstream). */
  onClientTelemetry(msg: Record<string, unknown>): void {
    const raw = msg.data && typeof msg.data === "object" && !Array.isArray(msg.data) ? (msg.data as Record<string, unknown>) : msg;
    const stage = typeof raw.stage === "string" && raw.stage.trim() !== "" ? cleanStr(raw.stage, 24) : "telemetry";
    const sanitized: Record<string, unknown> = {};
    let keys = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (keys >= 36) break;
      if (!SAFE_KEY.test(k) || FORBIDDEN_AI_KEYS.has(k.toLowerCase())) continue;
      if (typeof v === "number" && Number.isFinite(v)) {
        sanitized[k] = round3(v);
        keys++;
      } else if (typeof v === "boolean") {
        sanitized[k] = v;
        keys++;
      } else if (typeof v === "string" && v.trim() !== "") {
        sanitized[k] = cleanStr(v, 64);
        keys++;
      } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        const joined = cleanStr(v.join(","), 80);
        if (joined) {
          sanitized[k] = joined;
          keys++;
        }
      }
    }

    if (typeof sanitized.route === "string") this.lastAi.route = sanitized.route;
    if (typeof sanitized.denoise_model === "string") this.lastAi.denoise_model = sanitized.denoise_model;
    if (typeof sanitized.tse_enabled === "boolean") this.lastAi.tse_enabled = sanitized.tse_enabled;
    if (typeof sanitized.sv_enabled === "boolean") this.lastAi.sv_enabled = sanitized.sv_enabled;
    if (typeof sanitized.denoise_enabled === "boolean") this.lastAi.denoise_enabled = sanitized.denoise_enabled;
    if (typeof sanitized.threshold === "number") this.lastAi.threshold = sanitized.threshold;
    if (typeof sanitized.prototypes_count === "number") this.lastAi.prototypes_count = sanitized.prototypes_count;
    if (typeof sanitized.enroll_ms === "number") this.lastAi.enroll_ms = sanitized.enroll_ms;
    if (typeof sanitized.sv_score === "number") this.lastAi.sv_score = sanitized.sv_score;
    if (typeof sanitized.sv_raw === "number") this.lastAi.sv_raw = sanitized.sv_raw;
    if (typeof sanitized.sv_proto === "number") this.lastAi.sv_proto = sanitized.sv_proto;
    if (typeof sanitized.sv_sess === "number") this.lastAi.sv_sess = sanitized.sv_sess;
    if (typeof sanitized.sv_ms === "number") this.lastAi.sv_ms = sanitized.sv_ms;
    if (typeof sanitized.pass === "boolean") this.lastAi.pass = sanitized.pass;
    if (typeof sanitized.tse_atten_db === "number") this.lastAi.tse_atten_db = sanitized.tse_atten_db;
    if (typeof sanitized.raw_dbfs === "number") this.lastAi.raw_dbfs = sanitized.raw_dbfs;
    if (typeof sanitized.tse_dbfs === "number") this.lastAi.tse_dbfs = sanitized.tse_dbfs;
    if (typeof sanitized.enh_dbfs === "number") this.lastAi.enh_dbfs = sanitized.enh_dbfs;
    if (typeof sanitized.enh_gain_db === "number") this.lastAi.enh_gain_db = sanitized.enh_gain_db;
    if (typeof sanitized.dpdf_us_avg === "number") this.lastAi.dpdf_us_avg = sanitized.dpdf_us_avg;
    if (typeof sanitized.dpdf_us_max === "number") this.lastAi.dpdf_us_max = sanitized.dpdf_us_max;
    if (typeof sanitized.tse_ms_avg === "number") this.lastAi.tse_ms_avg = sanitized.tse_ms_avg;
    if (typeof sanitized.tse_ms_max === "number") this.lastAi.tse_ms_max = sanitized.tse_ms_max;
    if (typeof sanitized.tse_rtf === "number") this.lastAi.tse_rtf = sanitized.tse_rtf;
    if (typeof sanitized.tse_overruns === "number") this.lastAi.tse_overruns = sanitized.tse_overruns;
    if (typeof sanitized.ws_gap_max_ms === "number") this.lastAi.ws_gap_max_ms = sanitized.ws_gap_max_ms;
    if (typeof sanitized.vad_speech_ratio === "number") this.lastAi.vad_speech_ratio = sanitized.vad_speech_ratio;
    if (typeof sanitized.gated_ratio === "number") this.lastAi.gated_ratio = sanitized.gated_ratio;

    this.clientAiEvents++;
    const t = this.now();
    if (t - this.aiRateSince >= AI_RATE_WINDOW_MS) {
      this.aiRateSince = t;
      this.aiRateCount = 0;
      this.aiRateNoted = false;
    }
    if (this.aiRateCount >= AI_RATE_MAX_PER_MIN) {
      this.clientAiDropped++;
      if (!this.aiRateNoted) {
        this.aiRateNoted = true;
        this.emit({
          kind: "live.ai",
          level: "warn",
          msg: `client.ai rate limited (>${AI_RATE_MAX_PER_MIN}/min), dropping excess frames`,
          data: { callId: this.callId, provider: this.provider, stage: "rate_limited", turn: this.turn },
        });
      }
      return;
    }
    this.aiRateCount++;

    const overruns = typeof sanitized.tse_overruns === "number" ? sanitized.tse_overruns : 0;
    const rtf = typeof sanitized.tse_rtf === "number" ? sanitized.tse_rtf : 0;
    const gapMax = typeof sanitized.ws_gap_max_ms === "number" ? sanitized.ws_gap_max_ms : 0;
    const level: LogLevel = overruns > 0 || rtf > 0.85 || gapMax > 150 ? "warn" : "info";

    const msgText =
      stage === "init"
        ? `client.ai init route=${sanitized.route ?? "-"} tse=${sanitized.tse_enabled ?? "-"} sv=${sanitized.sv_enabled ?? "-"}`
        : stage === "utterance"
          ? `client.ai utterance pass=${sanitized.pass ?? "-"} sv=${sanitized.sv_score ?? "-"} atten=${sanitized.tse_atten_db ?? "-"}dB enh=${sanitized.enh_dbfs ?? "-"}dBFS`
          : stage === "periodic"
            ? `client.ai periodic rtf=${sanitized.tse_rtf ?? "-"} dpdf=${sanitized.dpdf_us_avg ?? "-"}us gap_max=${sanitized.ws_gap_max_ms ?? "-"}ms`
            : stage === "summary"
              ? `client.ai summary frames=${sanitized.frames_out ?? sanitized.frames_in ?? "-"} rtf=${sanitized.tse_rtf ?? "-"} overruns=${overruns}`
              : `client.ai ${stage}`;

    this.emit({
      kind: "live.ai",
      level,
      msg: msgText,
      data: {
        callId: this.callId,
        provider: this.provider,
        turn: this.turn,
        ...sanitized,
        stage,
      },
    });
  }

  onSpeechStarted(rawTurn?: unknown): void {
    this.syncTurn(rawTurn, true);
    const t = this.now();
    this.speechStartAt = t;
    this.speechStoppedAt = 0;
    this.lastSpeechMs = undefined;
    this.turnAsrRecorded = false;
    this.turnTtfaRecorded = false;
    this.userSpeaking = true;
    this.turnActiveSumSq = this.recentTotalSumSq;
    this.turnActiveSamples = this.recentTotalSamples;
    const rxActiveDbfs = this.recentActiveDbfs();
    this.emit({
      kind: "live.ai",
      level: "info",
      msg: `speech started turn=${this.turn} dbfs=${rxActiveDbfs} sv=${this.lastAi.sv_score ?? "-"}`,
      data: {
        callId: this.callId,
        provider: this.provider,
        stage: "speech_started",
        turn: this.turn,
        rx_active_dbfs: rxActiveDbfs,
        ...this.aiSnapshot(),
      },
    });
  }

  onSpeechStopped(rawTurn?: unknown): void {
    this.syncTurn(rawTurn, false);
    const t = this.now();
    this.userSpeaking = false;
    this.speechStoppedAt = t;
    const speechMs = this.speechStartAt > 0 ? Math.max(0, t - this.speechStartAt) : undefined;
    this.lastSpeechMs = speechMs;
    const rxActiveDbfs = this.turnActiveSamples > 0 ? rmsDbfs(this.turnActiveSumSq, this.turnActiveSamples) : this.recentActiveDbfs();
    this.emit({
      kind: "live.ai",
      level: "info",
      msg: `speech stopped turn=${this.turn} speech=${speechMs ?? "-"}ms dbfs=${rxActiveDbfs}`,
      data: {
        callId: this.callId,
        provider: this.provider,
        stage: "speech_stopped",
        turn: this.turn,
        ...(speechMs !== undefined ? { speech_ms: speechMs } : {}),
        rx_active_dbfs: rxActiveDbfs,
        ...this.aiSnapshot(),
      },
    });
  }

  /** Records ASR turn completion/revision with char count & latencies (never raw user speech words). */
  onTranscript(text: string, rawTurn?: unknown, revised = false): void {
    this.syncTurn(rawTurn, false);
    const t = this.now();
    const chars = Array.from(text).length;
    const speechMs = this.lastSpeechMs ?? (this.speechStartAt > 0 ? Math.max(0, (this.speechStoppedAt || t) - this.speechStartAt) : undefined);
    const asrMs = this.speechStoppedAt > 0 ? Math.max(0, t - this.speechStoppedAt) : undefined;
    if (!revised && !this.turnAsrRecorded) {
      this.turnAsrRecorded = true;
      if (asrMs !== undefined) this.asrSamples.push(asrMs);
    }
    const rxActiveDbfs = this.turnActiveSamples > 0 ? rmsDbfs(this.turnActiveSumSq, this.turnActiveSamples) : this.recentActiveDbfs();
    this.emit({
      kind: "live.ai",
      level: asrMs !== undefined && asrMs > 2500 ? "warn" : "info",
      msg: `asr ${revised ? "revised" : "done"} turn=${this.turn} chars=${chars} asr=${asrMs ?? "-"}ms speech=${speechMs ?? "-"}ms`,
      data: {
        callId: this.callId,
        provider: this.provider,
        stage: revised ? "asr_revised" : "asr_done",
        turn: this.turn,
        chars,
        ...(speechMs !== undefined ? { speech_ms: speechMs } : {}),
        ...(asrMs !== undefined ? { asr_ms: asrMs } : {}),
        rx_active_dbfs: rxActiveDbfs,
        ...this.aiSnapshot(),
      },
    });
  }

  onResponseAudioStarted(runId?: string, turnId?: string): void {
    const t = this.now();
    let ttfaMs: number | undefined;
    if (this.speechStoppedAt > 0 && !this.turnTtfaRecorded) {
      ttfaMs = Math.max(0, t - this.speechStoppedAt);
      this.turnTtfaRecorded = true;
      this.ttfaSamples.push(ttfaMs);
    }
    this.emit({
      kind: "live.ai",
      level: ttfaMs !== undefined && ttfaMs > 3000 ? "warn" : "info",
      msg: `response audio started turn=${this.turn}${runId ? ` run=${cleanStr(runId, 32)}` : ""}${ttfaMs !== undefined ? ` ttfa=${ttfaMs}ms` : ""}`,
      data: {
        callId: this.callId,
        provider: this.provider,
        stage: "ttfa",
        turn: this.turn,
        ...(runId ? { run_id: cleanStr(runId, 64) } : {}),
        ...(turnId ? { turn_id: cleanStr(turnId, 64) } : {}),
        ...(ttfaMs !== undefined ? { ttfa_ms: ttfaMs } : {}),
        ...(this.lastSpeechMs !== undefined ? { speech_ms: this.lastSpeechMs } : {}),
      },
    });
  }

  onResponseInterrupted(runId?: string, reason?: string): void {
    this.interruptions++;
    const cleanReason = reason ? cleanStr(reason, 60) : "interrupted";
    const level: LogLevel = /timeout|error|fail|stall|disconnect/i.test(cleanReason) ? "warn" : "info";
    const rxActiveDbfs = this.recentActiveDbfs();
    this.emit({
      kind: "live.ai",
      level,
      msg: `response interrupted reason=${cleanReason} dbfs=${rxActiveDbfs} sv=${this.lastAi.sv_score ?? "-"}`,
      data: {
        callId: this.callId,
        provider: this.provider,
        stage: "interrupted",
        turn: this.turn,
        reason: cleanReason,
        ...(runId ? { run_id: cleanStr(runId, 64) } : {}),
        rx_active_dbfs: rxActiveDbfs,
        ...(this.lastAi.sv_score !== undefined ? { last_sv_score: this.lastAi.sv_score, sv_score: this.lastAi.sv_score } : {}),
        ...(this.lastAi.tse_atten_db !== undefined ? { last_tse_atten_db: this.lastAi.tse_atten_db, tse_atten_db: this.lastAi.tse_atten_db } : {}),
        ...(this.lastAi.route !== undefined ? { route: this.lastAi.route } : {}),
      },
    });
  }

  onStop(why: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.windowTimer) {
      clearInterval(this.windowTimer);
      this.windowTimer = null;
    }
    const durationMs = Math.max(0, this.now() - this.startedAt);
    const tot = this.total;
    const rxAudioMs = round1(tot.bytes / MIC_BYTES_PER_MS);
    const preReadyDroppedMs = round1(this.preReadyDroppedBytes / MIC_BYTES_PER_MS);
    const rxGapMaxMs = Math.round(tot.gapMaxMs);
    const rxZeroRatio = tot.hops > 0 ? round3(tot.zeroHops / tot.hops) : 0;
    const rxActiveDbfs = rmsDbfs(tot.activeSumSq, tot.activeSamples);
    const rxPeakDbfs = peakDbfs(tot.peak);
    const asrAvg = this.asrSamples.length ? Math.round(this.asrSamples.reduce((a, b) => a + b, 0) / this.asrSamples.length) : undefined;
    const asrMax = this.asrSamples.length ? Math.max(...this.asrSamples) : undefined;
    const ttfaAvg = this.ttfaSamples.length ? Math.round(this.ttfaSamples.reduce((a, b) => a + b, 0) / this.ttfaSamples.length) : undefined;
    const ttfaMax = this.ttfaSamples.length ? Math.max(...this.ttfaSamples) : undefined;

    const aiSummary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.lastAi)) if (v !== undefined) aiSummary[k] = v;
    if (this.clientAiEvents > 0) aiSummary.client_ai_events = this.clientAiEvents;
    if (this.clientAiDropped > 0) aiSummary.client_ai_dropped = this.clientAiDropped;

    const cleanWhy = cleanStr(why, 80);
    const trouble = tot.gapsOver80 > 3 || (this.lastAi.tse_overruns ?? 0) > 0 || /error|fail|拒绝|连不上|没有及时响应/i.test(cleanWhy);
    this.emit({
      kind: "live.ai",
      level: trouble ? "warn" : "info",
      msg: `call summary dur=${durationMs}ms turns=${this.seenTurns.size} rx=${rxAudioMs}ms gap_max=${rxGapMaxMs}ms cuts=${this.interruptions} (${cleanWhy})`,
      data: {
        callId: this.callId,
        provider: this.provider,
        stage: "call_summary",
        reason: cleanWhy,
        duration_ms: durationMs,
        turns: this.seenTurns.size,
        rx_frames: tot.frames,
        rx_audio_ms: rxAudioMs,
        pre_ready_dropped_ms: preReadyDroppedMs,
        rx_gap_max_ms: rxGapMaxMs,
        rx_gaps_over_80ms: tot.gapsOver80,
        rx_zero_ratio: rxZeroRatio,
        rx_active_dbfs: rxActiveDbfs,
        rx_peak_dbfs: rxPeakDbfs,
        rx_clipped_samples: tot.clipped,
        ...(asrAvg !== undefined ? { asr_avg_ms: asrAvg, asr_max_ms: asrMax } : {}),
        ...(ttfaAvg !== undefined ? { ttfa_avg_ms: ttfaAvg, ttfa_max_ms: ttfaMax } : {}),
        interruptions: this.interruptions,
        ...aiSummary,
      },
    });
  }
}

/** Linear resampler for mono PCM16 little-endian that keeps its place between chunks. */
export class Resampler {
  private step: number;
  private same: boolean;
  private pos = 0;
  private prev: number | null = null;
  private odd: Buffer | null = null;

  constructor(from: number, to: number) {
    this.step = from / to;
    this.same = from === to;
  }

  push(chunk: Buffer): Buffer {
    let buf = this.odd ? Buffer.concat([this.odd, chunk]) : chunk;
    this.odd = null;
    if (buf.length % 2) {
      this.odd = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    if (this.same || !buf.length) return buf;
    const off = this.prev === null ? 0 : 1;
    const len = (buf.length >> 1) + off;
    const at = (k: number) => (k < off ? this.prev! : buf.readInt16LE((k - off) * 2));
    const max = Math.max(0, Math.ceil((len - 1 - this.pos) / this.step));
    const out = Buffer.alloc(max * 2);
    let t = this.pos;
    let w = 0;
    while (t < len - 1 && w < max) {
      const i = Math.floor(t);
      const a = at(i);
      out.writeInt16LE(Math.round(a + (at(i + 1) - a) * (t - i)), w * 2);
      w++;
      t += this.step;
    }
    this.prev = at(len - 1);
    this.pos = t - (len - 1);
    return w === max ? out : out.subarray(0, w * 2);
  }
}

/** One spoken answer (an assistant audio item upstream): the phone's run. */
interface Run {
  id: string;
  turn: string;
  response: string;
  /** When its first audio reached the phone. */
  startedAt: number;
  /** Audio length received so far. */
  ms: number;
  text: string;
  chunks: number;
  audible: boolean;
  audioDone: boolean;
  /** The phone played all of it. */
  played: boolean;
  /** Cut off: the phone was told to stop playing it. */
  stopped: boolean;
  /** The cut was reported upstream and to the phone. */
  settled: boolean;
  /** Final output transcript event was received from upstream. */
  transcriptDone: boolean;
  /** Assistant captions for this run are waiting for the same turn's user ASR. */
  deferredText: boolean;
  /** Response status waiting to emit response.ended after deferred captions flush. */
  deferredEnd?: string;
  out: Resampler;
}

export class RealtimeCall {
  private upstream: WebSocket;
  private ended = false;
  private ready = false;
  /** Unique per call: transcript lines of two calls must never share an id (turn numbers restart at 1). */
  private id = randomUUID().slice(0, 8);
  private ga: boolean;
  private outRate: number;
  private mic: Resampler;
  private turn = 0;
  private turnOf = new Map<string, number>();
  private heard = new Map<string, string>();
  private speechAt = new Map<number, number>();
  private asrPendingTurn = 0;
  private asrHoldTimer: NodeJS.Timeout | null = null;
  private runs = new Map<string, Run>();
  /** The answer being generated upstream, and since when. */
  private active: string | null = null;
  private activeSince = 0;
  /** response.create sent and not yet answered by response.created. */
  private creating = false;
  private creatingSince = 0;
  private createQueued = false;
  private userSpeaking = false;
  private speechStoppedAt = 0;
  private tasks = new Map<string, AbortController>();
  private seenCalls = new Set<string>();
  /** Notices to bring up as soon as nobody is speaking. */
  private pending: Array<{ line: string; details?: string }> = [];
  /** The last few lines of this call, for tasks handed to the backend. */
  private recent: Array<{ role: string; content: string; turn?: number }> = [];
  private recentText = "";
  private lastInstructions = "";
  private lastPush = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshWaiting = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private detach: () => void;
  private keepalive: NodeJS.Timeout;
  private attachTimer: NodeJS.Timeout;
  private phone: WebSocket;
  private deviceId: string;
  private cfg: RealtimeConfig;
  private assistant: Assistant;
  private log: (m: string) => void;
  private telemetry: CallTelemetry;

  constructor(phone: WebSocket, deviceId: string, cfg: RealtimeConfig, assistant: Assistant, log: (m: string) => void, event?: (ev: EventInput) => void) {
    this.phone = phone;
    this.deviceId = deviceId;
    this.cfg = cfg;
    this.assistant = assistant;
    this.log = log;
    this.telemetry = new CallTelemetry({ callId: this.id, provider: "openai-realtime", deviceId, log, event });
    this.ga = cfg.dialect !== "beta";
    this.outRate = cfg.outputRate ?? 24_000;
    this.mic = new Resampler(PHONE_MIC_RATE, cfg.inputRate ?? 24_000);
    claimCall(this);
    this.toPhone({ action: "relay.state", data: { state: "connecting" } });
    const url = new URL(cfg.url);
    if (!url.searchParams.has("model")) url.searchParams.set("model", cfg.model);
    this.upstream = new WebSocket(url, {
      headers: cfg.auth === "api-key" ? { "api-key": cfg.apiKey } : { Authorization: `Bearer ${cfg.apiKey}` },
      // Audio frames would wait for zlib on the thread pool behind the hosts' screens; server-to-server bandwidth is cheap.
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: ATTACH_TIMEOUT_MS,
      maxPayload: 16 * 1024 * 1024,
    });
    this.attachTimer = setTimeout(() => this.fail("语音服务没有及时响应"), ATTACH_TIMEOUT_MS + 5000);
    this.keepalive = setInterval(() => {
      if (this.upstream.readyState === WebSocket.OPEN) this.upstream.ping();
    }, 25_000);
    this.detach = assistant.attachVoice({ notice: (n) => this.notice(n), board: () => this.refresh() });

    this.upstream.on("open", () => this.configure());
    this.upstream.on("message", (data, binary) => {
      if (binary) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg && typeof msg === "object") this.onUpstream(msg);
    });
    this.upstream.on("unexpected-response", (_req, res) => {
      this.fail(res.statusCode === 401 || res.statusCode === 403 ? "语音服务的密钥无效" : res.statusCode === 429 ? "语音服务现在太忙，稍后再试" : `语音服务拒绝了连接（${res.statusCode}）`);
    });
    this.upstream.on("close", () => this.stop("语音服务断开了"));
    this.upstream.on("error", () => this.fail("连不上语音服务"));

    phone.on("message", (data, binary) => {
      if (binary) {
        if (!this.ready || this.upstream.readyState !== WebSocket.OPEN) {
          this.telemetry.onPreReadyBinary(data);
          return;
        }
        const buf = asBuffer(data);
        this.telemetry.onRxPcm(buf);
        const pcm = this.mic.push(buf);
        if (pcm.length) this.up({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.action) {
        case "client.ai_telemetry":
          this.telemetry.onClientTelemetry(msg);
          return;
        case "mic_state":
          if (typeof msg.enabled === "boolean") this.telemetry.onMicState(msg.enabled);
          return;
        case "relay.hangup":
          this.stop("挂断了");
          return;
        case "playback.completed": {
          const r = this.runs.get(String(msg.run_id));
          if (r) r.played = true;
          this.idleSoon();
          return;
        }
        case "playback.stopped":
          this.settle(String(msg.run_id), msg.played_audio_ms, msg.reason);
          return;
        // ping and chunk receipts: the service needs none of them.
      }
    });
    phone.on("close", () => this.stop("手机断开了"));
    phone.on("error", () => this.stop("手机断开了"));
  }

  private up(msg: Record<string, unknown>): void {
    if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(msg));
  }

  private toPhone(msg: LiveRelayEvent | { action: string; data?: unknown }): void {
    if (this.phone.readyState === WebSocket.OPEN) this.phone.send(JSON.stringify(msg));
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  private instructions(): string {
    const text = [personaPrompt(this.assistant.name), BRIDGE, voiceInstructions({ board: this.assistant.voiceBoard(), pending: [], recent: this.recentText })].join("\n\n");
    return Array.from(text).slice(0, MAX_INSTRUCTIONS).join("");
  }

  /** First setup: who it is, how it hears and speaks, the one tool it can call. */
  private configure(): void {
    const c = this.cfg;
    this.recentText = this.assistant.recentForVoice();
    this.lastInstructions = this.instructions();
    this.lastPush = Date.now();
    const vad = c.vad ?? "server_vad";
    const session = this.ga
      ? {
          type: "realtime",
          instructions: this.lastInstructions,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: c.inputRate ?? 24_000 },
              ...(c.noiseReduction ? { noise_reduction: { type: c.noiseReduction } } : {}),
              turn_detection: { type: vad, create_response: true, interrupt_response: true },
              ...(c.transcribeModel ? { transcription: { model: c.transcribeModel, ...(c.language ? { language: c.language } : {}) } } : {}),
            },
            output: {
              format: { type: "audio/pcm", rate: this.outRate },
              ...(c.voice ? { voice: c.voice } : {}),
              ...(c.speed && c.speed !== 1 ? { speed: Math.min(1.5, Math.max(0.25, c.speed)) } : {}),
            },
          },
          tools: [ASK_TOOL],
          tool_choice: "auto",
        }
      : {
          modalities: ["text", "audio"],
          instructions: this.lastInstructions,
          ...(c.voice ? { voice: c.voice } : {}),
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          ...(c.transcribeModel ? { input_audio_transcription: { model: c.transcribeModel } } : {}),
          turn_detection: { type: vad },
          tools: [ASK_TOOL],
          tool_choice: "auto",
        };
    this.up({ type: "session.update", session });
  }

  /** Something the voice answers from changed: pushed at most once per gap, never while anyone is speaking. */
  private refresh(): void {
    if (!this.ready || this.ended) return;
    if (this.speaking) {
      this.refreshWaiting = true;
      return;
    }
    if (this.refreshTimer) return;
    const wait = Math.max(0, (this.cfg.refreshGapMs ?? REFRESH_GAP_MS) - (Date.now() - this.lastPush));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.ended) return;
      if (this.speaking) {
        this.refreshWaiting = true;
        return;
      }
      const next = this.instructions();
      if (next === this.lastInstructions) return;
      this.lastInstructions = next;
      this.lastPush = Date.now();
      this.up({ type: "session.update", session: this.ga ? { type: "realtime", instructions: next } : { instructions: next } });
    }, wait);
  }

  private isPlaying(r: Run, now = Date.now()): boolean {
    return r.audible && !r.played && !r.stopped && now < r.startedAt + r.ms + PLAYBACK_SLACK_MS;
  }

  /** An answer is asked for or being made upstream; one whose end never came stops counting after a while. */
  private generating(): boolean {
    if (this.active && Date.now() - this.activeSince > ACTIVE_MAX_MS) this.active = null;
    if (this.creating && Date.now() - this.creatingSince > CREATE_MAX_MS) this.creating = false;
    return !!this.active || this.creating;
  }

  /** An answer is being made or is still coming out of the phone. */
  private get speaking(): boolean {
    if (this.generating()) return true;
    const now = Date.now();
    for (const r of this.runs.values()) if (this.isPlaying(r, now)) return true;
    return false;
  }

  /** Checks again once the phone should have finished playing; then held-back work goes out. */
  private idleSoon(): void {
    if (this.ended) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const now = Date.now();
    let until = 0;
    if (!this.generating()) for (const r of this.runs.values()) if (this.isPlaying(r, now)) until = Math.max(until, r.startedAt + r.ms + PLAYBACK_SLACK_MS);
    if (until > now) {
      this.idleIn(until - now + 5);
      return;
    }
    if (this.speaking || this.userSpeaking) return;
    if (this.refreshWaiting) {
      this.refreshWaiting = false;
      this.refresh();
    }
    this.speakPending();
  }

  private idleIn(ms: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.idleSoon(), ms);
  }

  /** Asks for an answer; one at a time, the next waits for the current one to end. */
  private respond(): void {
    if (this.generating()) {
      this.createQueued = true;
      return;
    }
    this.creating = true;
    this.creatingSince = Date.now();
    this.up({ type: "response.create" });
  }

  // ---------------------------------------------------------------------------
  // Upstream events
  // ---------------------------------------------------------------------------

  private onUpstream(d: Record<string, any>): void {
    switch (d.type) {
      case "session.updated":
        if (!this.ready) {
          clearTimeout(this.attachTimer);
          this.ready = true;
          this.telemetry.onReady();
          this.toPhone({ action: "relay.state", data: { state: "ready" } });
        }
        return;
      case "input_audio_buffer.speech_started": {
        this.flushAsrHold();
        this.userSpeaking = true;
        this.turn++;
        this.cap(this.speechAt, 50).set(this.turn, Date.now());
        if (this.cfg.transcribeModel) {
          this.asrPendingTurn = this.turn;
          this.armAsrHold(ASR_SPEECH_MAX_MS);
        }
        this.telemetry.onSpeechStarted(this.turn);
        if (str(d.item_id)) this.cap(this.turnOf, 200).set(d.item_id, this.turn);
        // The person talks over the answer: the phone stops it now and says how much was heard.
        const now = Date.now();
        for (const r of this.runs.values()) {
          if (!this.isPlaying(r, now)) continue;
          r.stopped = true;
          this.toPhone({ action: "response.audio.stop", data: { run_id: r.id, turn_id: r.turn, reason: "interrupted" } });
        }
        // GA turn detection cancels the answer by itself; the beta settings do not ask for that.
        if (!this.ga && this.active) this.up({ type: "response.cancel" });
        this.toPhone({ action: "input.speech.started", data: { turn: this.turn } });
        return;
      }
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        this.speechStoppedAt = Date.now();
        this.cap(this.speechAt, 50).set(this.turn, this.speechStoppedAt);
        if (this.asrPendingTurn === this.turn) this.armAsrHold(this.cfg.asrHoldMs ?? ASR_HOLD_MS);
        this.telemetry.onSpeechStopped(this.turn);
        // Held-back work goes out after the answer to this, or after a pause when no answer comes.
        if (this.pending.length || this.refreshWaiting) this.idleIn(AFTER_SPEECH_MS + 5);
        this.toPhone({ action: "input.speech.stopped", data: { turn: this.turn } });
        return;
      case "conversation.item.input_audio_transcription.delta": {
        if (!str(d.item_id) || typeof d.delta !== "string") return;
        const text = (this.heard.get(d.item_id) ?? "") + d.delta;
        this.cap(this.heard, 20).set(d.item_id, text);
        if (text.trim()) this.toPhone({ action: "input.transcript.updated", data: { text, turn: this.turnOf.get(d.item_id) ?? this.turn } });
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof d.transcript === "string" ? d.transcript.trim() : "";
        const turn = (str(d.item_id) ? this.turnOf.get(d.item_id) : undefined) ?? this.turn;
        if (str(d.item_id)) this.heard.delete(d.item_id);
        this.telemetry.onTranscript(text, turn, false);
        this.toPhone({ action: "input.transcript.done", data: { text, turn } });
        if (text) {
          this.assistant.voiceLine("user", text, `${this.id}-${turn}`, this.speechAt.get(turn));
          this.remember("user", text, turn);
        }
        if (this.asrPendingTurn === turn) this.flushAsrHold();
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const turn = (str(d.item_id) ? this.turnOf.get(d.item_id) : undefined) ?? this.turn;
        this.log(`realtime: transcription failed ${String(d.error?.code ?? d.error?.message ?? "").slice(0, 80)}`);
        if (this.asrPendingTurn === turn) this.flushAsrHold();
        return;
      }
      case "response.created":
        this.active = str(d.response?.id) ? d.response.id : "?";
        this.activeSince = Date.now();
        this.creating = false;
        return;
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.audio(d);
        return;
      case "response.output_audio.done":
      case "response.audio.done": {
        const r = str(d.item_id) ? this.runs.get(d.item_id) : undefined;
        if (r) this.audioDone(r);
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (!str(d.item_id) || typeof d.delta !== "string") return;
        const r = this.run(d.item_id, d.response_id);
        r.text += d.delta;
        if (!r.stopped && r.text.trim()) {
          if (this.isTurnAsrPending(r.turn)) r.deferredText = true;
          else this.toPhone({ action: "output.transcript.updated", data: { text: r.text, run_id: r.id, turn_id: r.turn } });
        }
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        if (!str(d.item_id)) return;
        const r = this.run(d.item_id, d.response_id);
        if (typeof d.transcript === "string") r.text = d.transcript;
        // A cut-off answer keeps what was heard (settle), not what was meant.
        if (r.stopped || !r.text.trim()) return;
        r.transcriptDone = true;
        if (this.isTurnAsrPending(r.turn)) r.deferredText = true;
        else this.emitAssistantTranscriptDone(r);
        return;
      }
      case "response.function_call_arguments.done":
        this.delegation(d.call_id, d.name, d.arguments);
        return;
      case "response.output_item.done":
        if (d.item?.type === "function_call") this.delegation(d.item.call_id, d.item.name, d.item.arguments);
        return;
      case "response.done":
      case "response.cancelled": {
        const resp = d.response ?? {};
        const id: string = str(resp.id) ? resp.id : (this.active ?? "");
        this.active = null;
        let last: Run | undefined;
        for (const r of this.runs.values()) {
          if (r.response !== id) continue;
          last = r;
          // Cancelled before its audio was closed: the phone still needs the end to drain.
          this.audioDone(r);
        }
        if (resp.status === "failed") this.log(`realtime: answer failed ${String(resp.status_details?.error?.code ?? resp.status_details?.reason ?? "").slice(0, 80)}`);
        const status = resp.status ?? (d.type === "response.cancelled" ? "cancelled" : "completed");
        if (last && (last.audible || last.deferredText) && this.isTurnAsrPending(last.turn)) {
          last.deferredEnd = status;
        } else {
          this.toPhone({ action: "response.ended", data: { run_id: last?.id ?? id, turn_id: last?.turn ?? String(this.turn), status } });
        }
        if (this.createQueued) {
          this.createQueued = false;
          this.respond();
        }
        this.idleSoon();
        return;
      }
      case "error": {
        const err = d.error ?? {};
        const code = str(err.code) ? err.code : str(err.type) ? err.type : "error";
        this.log(`realtime: upstream error ${code}${str(err.message) ? `: ${clip(err.message.split(this.cfg.apiKey).join("[redacted]"), 160)}` : ""}`);
        if (!this.ready) {
          this.fail(`语音会话配置失败（${code}）`);
          return;
        }
        if (code === "conversation_already_has_active_response") {
          this.creating = false;
          this.createQueued = true;
          return;
        }
        // A rejected request is the relay's problem, not something the person can act on.
        if (err.type !== "invalid_request_error") this.toPhone({ action: "error", data: { error: { code } } });
        return;
      }
    }
  }

  private cap<K, V>(m: Map<K, V>, max: number): Map<K, V> {
    while (m.size >= max) m.delete(m.keys().next().value!);
    return m;
  }

  private run(itemId: string, responseId: unknown): Run {
    let r = this.runs.get(itemId);
    if (!r) {
      r = {
        id: itemId,
        turn: String(this.turn),
        response: str(responseId) ? responseId : (this.active ?? ""),
        startedAt: 0,
        ms: 0,
        text: "",
        chunks: 0,
        audible: false,
        audioDone: false,
        played: false,
        stopped: false,
        settled: false,
        transcriptDone: false,
        deferredText: false,
        out: new Resampler(this.outRate, PHONE_SPEAKER_RATE),
      };
      this.cap(this.runs, 50).set(itemId, r);
    }
    return r;
  }

  private audio(d: Record<string, any>): void {
    if (!str(d.item_id) || typeof d.delta !== "string") return;
    const r = this.run(d.item_id, d.response_id);
    if (r.stopped) return;
    if (!r.audible) {
      r.audible = true;
      r.startedAt = Date.now();
      this.telemetry.onResponseAudioStarted(r.id, r.turn);
      this.toPhone({ action: "response.audio.started", data: { run_id: r.id, turn_id: r.turn } });
    }
    const pcm = Buffer.from(d.delta, "base64");
    r.ms += (pcm.length / 2 / this.outRate) * 1000;
    const out = r.out.push(pcm);
    if (!out.length) return;
    this.toPhone({ action: "response.audio.context", data: { chunk_id: `${r.id}-${r.chunks++}`, run_id: r.id, turn_id: r.turn } });
    if (this.phone.readyState === WebSocket.OPEN) this.phone.send(out, { binary: true });
  }

  private audioDone(r: Run): void {
    if (r.audioDone) return;
    r.audioDone = true;
    if (r.audible && !r.stopped) this.toPhone({ action: "response.audio.done", data: { run_id: r.id, turn_id: r.turn } });
  }

  /** The phone stopped a cut-off answer: the service forgets what was not heard, the captions keep what was. */
  private settle(runId: string, playedMs: unknown, reason?: unknown): void {
    const r = this.runs.get(runId);
    if (!r || r.settled) return;
    r.settled = true;
    r.stopped = true;
    this.telemetry.onResponseInterrupted(r.id, str(reason) ? reason : "interrupted");
    const heardMs = Math.max(0, Math.min(r.ms, typeof playedMs === "number" && Number.isFinite(playedMs) ? playedMs : r.ms));
    if (this.ga && r.ms > 0) this.up({ type: "conversation.item.truncate", item_id: r.id, content_index: 0, audio_end_ms: Math.floor(heardMs) });
    // The service gives no text for part of an answer: take the same share of the words as of the audio.
    const chars = Array.from(r.text);
    const heard = r.ms > 0 ? chars.slice(0, Math.round((chars.length * heardMs) / r.ms)).join("").trim() : "";
    this.toPhone({ action: "response.interrupted", data: { run_id: r.id, turn_id: r.turn, text: heard } });
    if (heard) {
      this.assistant.voiceLine("assistant", `${heard}…`, `${this.id}-${r.id}`, this.assistantTs(r.turn));
      this.remember("assistant", `${heard}…`, Number(r.turn));
    }
    this.idleSoon();
  }

  private isTurnAsrPending(turn: string | number): boolean {
    return this.asrPendingTurn > 0 && Number(turn) === this.asrPendingTurn;
  }

  private assistantTs(turn: string | number): number {
    return Math.max(Date.now(), (this.speechAt.get(Number(turn)) ?? 0) + 1);
  }

  private armAsrHold(ms: number): void {
    if (this.asrHoldTimer) clearTimeout(this.asrHoldTimer);
    this.asrHoldTimer = setTimeout(() => this.flushAsrHold(), ms);
  }

  private emitAssistantTranscriptDone(r: Run): void {
    this.toPhone({ action: "output.transcript.done", data: { text: r.text, run_id: r.id, turn_id: r.turn } });
    this.assistant.voiceLine("assistant", r.text, `${this.id}-${r.id}`, this.assistantTs(r.turn));
    this.remember("assistant", r.text, Number(r.turn));
  }

  private flushAsrHold(): void {
    if (this.asrHoldTimer) {
      clearTimeout(this.asrHoldTimer);
      this.asrHoldTimer = null;
    }
    if (!this.asrPendingTurn) return;
    const pending = this.asrPendingTurn;
    this.asrPendingTurn = 0;
    for (const r of this.runs.values()) {
      if (Number(r.turn) !== pending) continue;
      if (r.deferredText && !r.stopped && r.text.trim()) {
        r.deferredText = false;
        if (r.transcriptDone) this.emitAssistantTranscriptDone(r);
        else this.toPhone({ action: "output.transcript.updated", data: { text: r.text, run_id: r.id, turn_id: r.turn } });
      } else {
        r.deferredText = false;
      }
      if (r.deferredEnd !== undefined) {
        const status = r.deferredEnd;
        r.deferredEnd = undefined;
        this.toPhone({ action: "response.ended", data: { run_id: r.id, turn_id: r.turn, status } });
      }
    }
  }

  private remember(role: "user" | "assistant", content: string, turn?: number): void {
    const entry = { role, content: clip(content, 200), ...(turn !== undefined && Number.isFinite(turn) ? { turn } : {}) };
    let next: Array<{ role: string; content: string; turn?: number }>;
    if (role === "user" && entry.turn !== undefined) {
      const idx = this.recent.findIndex((e) => e.role === "assistant" && e.turn !== undefined && e.turn >= entry.turn!);
      if (idx >= 0) {
        next = this.recent.slice();
        next.splice(idx, 0, entry);
      } else {
        next = [...this.recent, entry];
      }
    } else {
      next = [...this.recent, entry];
    }
    this.recent = next.slice(-6);
  }

  // ---------------------------------------------------------------------------
  // Tasks and notices
  // ---------------------------------------------------------------------------

  private delegation(callId: unknown, name: unknown, args: unknown): void {
    if (!str(callId) || this.seenCalls.has(callId)) return;
    if (this.seenCalls.size >= 200) this.seenCalls.delete(this.seenCalls.values().next().value!);
    this.seenCalls.add(callId);
    if (str(name) && name !== TOOL) {
      this.toolOutput(callId, `没有 ${name} 这个工具，要查或要办的事都用 ${TOOL}。`);
      return;
    }
    let objective = "";
    try {
      const a = JSON.parse(typeof args === "string" && args.trim() ? args : "{}");
      if (typeof a?.objective === "string") objective = a.objective;
    } catch {
      /* answered below */
    }
    if (!objective.trim()) {
      this.toolOutput(callId, "objective 是空的：把我的原话写进 objective 再调用。");
      return;
    }
    const ac = new AbortController();
    this.tasks.set(callId, ac);
    const title = clip(objective.replace(/\s+/g, " ").trim(), 40);
    this.toPhone({ action: "relay.task", data: { id: callId, title, status: "running" } });
    this.assistant
      .delegate(objective, this.recent.map(({ role, content }) => ({ role, content })), ac.signal)
      .then((script) => {
        if (ac.signal.aborted) return;
        this.tasks.delete(callId);
        const lines = [`台词：${clip((script.say || "好了。").trim(), 1990)}`];
        const notes = [script.keep.trim(), ...this.pending.map((p) => p.details?.trim() ?? "")].filter(Boolean);
        if (notes.length) lines.push(`备查（不出声，我追问时再用）：${clip(notes.join("\n"), 1990)}`);
        // Notices that came in meanwhile ride along with the answer.
        if (this.pending.length) lines.push(`说完台词再告诉我：${this.pending.map((p) => p.line).join(" ")}`);
        this.pending = [];
        this.toolOutput(callId, lines.join("\n"));
        this.toPhone({ action: "relay.task", data: { id: callId, title, status: "done" } });
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        this.log(`realtime: delegation failed ${(e as Error).message}`);
        this.tasks.delete(callId);
        this.toolOutput(callId, "台词：没查成，后台没回我。你再说一遍我重查。");
        this.toPhone({ action: "relay.task", data: { id: callId, title, status: "failed" } });
      })
      .finally(() => this.tasks.delete(callId));
  }

  private toolOutput(callId: string, output: string): void {
    this.up({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    this.respond();
  }

  /**
   * A proactive notice while the call is open. Unlike MOSS-Live this protocol
   * can be asked to speak: when nobody is talking the line goes out at once as a
   * system message and a new answer; otherwise it waits until the current answer
   * has been heard, or rides along with a running task's result.
   */
  private notice(n: Notice): void {
    if (!this.ready || this.ended) return;
    // A reminder at a time is the person's own sentence; anything else is news the assistant brings up.
    const line = n.body.startsWith("到点了") ? n.body : `对了，${n.body}`;
    this.pending = [...this.pending, { line, details: n.details }].slice(-3);
    const now = this.tasks.size > 0 || (!this.speaking && !this.userSpeaking && Date.now() - this.speechStoppedAt >= AFTER_SPEECH_MS);
    this.toPhone({ action: "relay.notice", data: { id: n.id, line, how: now ? "now" : "next" } });
    this.speakPending();
  }

  private speakPending(): void {
    if (!this.pending.length || !this.ready || this.ended || this.tasks.size) return;
    if (this.speaking || this.userSpeaking) return;
    const wait = this.speechStoppedAt + AFTER_SPEECH_MS - Date.now();
    if (wait > 0) {
      this.idleIn(wait + 5);
      return;
    }
    const said = this.pending;
    this.pending = [];
    const details = said.map((p) => p.details?.trim() ?? "").filter(Boolean);
    const text = ["【要告诉我的事】", ...said.map((p) => p.line), ...(details.length ? [`备查（不出声，我追问时再用）：${clip(details.join("\n"), 1990)}`] : [])].join("\n");
    this.up({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    this.respond();
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.toPhone({ action: "relay.state", data: { state: "error", message } });
    this.stop(message);
  }

  stop(why: string): void {
    if (this.ended) return;
    this.ended = true;
    this.telemetry.onStop(why);
    releaseCall(this);
    clearTimeout(this.attachTimer);
    clearInterval(this.keepalive);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.asrHoldTimer) clearTimeout(this.asrHoldTimer);
    this.detach();
    for (const ac of this.tasks.values()) ac.abort();
    this.tasks.clear();
    this.toPhone({ action: "relay.state", data: { state: "closed", message: why } });
    try {
      this.phone.close(1000, "call ended");
    } catch {
      /* already gone */
    }
    this.upstream.terminate();
    this.log(`realtime: call ended (${why}) ${this.deviceId}`);
  }
}
