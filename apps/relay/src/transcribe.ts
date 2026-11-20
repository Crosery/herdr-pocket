/**
 * Dictation: a recording in, its text out (POST /v1/transcribe), for quick voice input on
 * computers. Any OpenAI-compatible `/audio/transcriptions` service works. Which one is used:
 * POCKET_TRANSCRIBE_* settings of its own, else what the relay already has (read only, never
 * changed here): the OpenAI Realtime voice service's key and host, or the `openai` /
 * `siliconflow` text provider. A key only ever goes to the host it was configured for.
 * Neither audio nor text is stored or logged; log lines carry sizes, timings and the service.
 */
import { TRANSCRIBE_FORMATS, TRANSCRIBE_LIMITS, type TranscribeInfo, type TranscribeResult } from "@herdr-pocket/protocol";
import type { LlmTarget } from "./assistant/llm.ts";
import type { LiveConfig } from "./assistant/live.ts";

export interface TranscribeSettings {
  /** `auto` (default), `off`, `voice`, or a text provider id. */
  provider?: string;
  /** A service of its own: base URL (requests go to `<url>/audio/transcriptions`). */
  url?: string;
  key?: string;
  auth?: "bearer" | "api-key" | "none";
  model?: string;
}

export interface TranscribeTarget {
  /** For logs and the settings screen: a provider id, never a key or address. */
  provider: string;
  baseUrl: string;
  apiKey?: string;
  auth: "bearer" | "api-key" | "none";
  model: string;
  headers?: Record<string, string>;
}

/** Models the known services document for `/audio/transcriptions` (2026-11). */
export const TRANSCRIBE_DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini-transcribe",
  siliconflow: "FunAudioLLM/SenseVoiceSmall",
  voice: "gpt-4o-mini-transcribe",
  custom: "gpt-4o-mini-transcribe",
};

type Env = Record<string, string | undefined>;

export function loadTranscribeSettings(env: Env): { settings: TranscribeSettings; warnings: string[] } {
  const e = (n: string) => {
    const v = env[n]?.trim();
    return v ? v : undefined;
  };
  const warnings: string[] = [];
  const auth = e("POCKET_TRANSCRIBE_AUTH")?.toLowerCase();
  if (auth && auth !== "bearer" && auth !== "api-key" && auth !== "none") warnings.push(`POCKET_TRANSCRIBE_AUTH "${auth}" is unknown; using bearer.`);
  const url = e("POCKET_TRANSCRIBE_URL");
  if (url && !/^https?:\/\/\S+$/i.test(url)) warnings.push(`POCKET_TRANSCRIBE_URL "${url}" is not an http(s) URL: ignored.`);
  return {
    settings: {
      provider: e("POCKET_TRANSCRIBE_PROVIDER")?.toLowerCase(),
      url: url && /^https?:\/\/\S+$/i.test(url) ? url.replace(/\/+$/, "") : undefined,
      key: e("POCKET_TRANSCRIBE_KEY"),
      auth: auth === "api-key" || auth === "none" ? auth : "bearer",
      model: e("POCKET_TRANSCRIBE_MODEL"),
    },
    warnings,
  };
}

/** `wss://api.openai.com/v1/realtime?model=x` -> `https://api.openai.com/v1`. */
export function httpBaseOfRealtime(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return undefined;
    const path = u.pathname.replace(/\/realtime\/?$/, "").replace(/\/+$/, "");
    return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}${path}`;
  } catch {
    return undefined;
  }
}

function fromText(t: LlmTarget, model: string | undefined): TranscribeTarget | undefined {
  if (t.protocol !== "openai" && t.protocol !== "openai-responses") return undefined;
  const m = model ?? TRANSCRIBE_DEFAULT_MODELS[t.provider];
  if (!m || !t.apiKey) return undefined;
  const auth = t.auth === "api-key" ? "api-key" : t.auth === "none" ? "none" : "bearer";
  return { provider: t.provider, baseUrl: t.baseUrl.replace(/\/+$/, ""), apiKey: t.apiKey, auth, model: m, headers: t.headers };
}

function fromVoice(live: LiveConfig | undefined, model: string | undefined): TranscribeTarget | undefined {
  if (!live || live.provider !== "openai-realtime" || !live.apiKey) return undefined;
  // The older "beta" dialect belongs to services with their own transcription models (realtime only).
  if (live.dialect === "beta") return undefined;
  const base = httpBaseOfRealtime(live.url);
  const m = model ?? (live.transcribeModel && live.transcribeModel !== "none" ? live.transcribeModel : TRANSCRIBE_DEFAULT_MODELS.voice!);
  if (!base) return undefined;
  return { provider: "voice", baseUrl: base, apiKey: live.apiKey, auth: live.auth === "api-key" ? "api-key" : "bearer", model: m };
}

/** The service in force now, or why there is none (Chinese, for the settings screen). */
export function resolveTranscribe(s: TranscribeSettings, targets: readonly LlmTarget[], live: LiveConfig | undefined): TranscribeTarget | { reason: string } {
  const want = s.provider ?? "auto";
  if (want === "off" || want === "none") return { reason: "中转服务关掉了语音转文字（POCKET_TRANSCRIBE_PROVIDER=off）" };
  if (s.url && (want === "auto" || want === "custom")) {
    return { provider: "custom", baseUrl: s.url, apiKey: s.key, auth: s.key ? (s.auth ?? "bearer") : "none", model: s.model ?? TRANSCRIBE_DEFAULT_MODELS.custom! };
  }
  if (want === "voice") return fromVoice(live, s.model) ?? { reason: "语音通话没有用 OpenAI Realtime 服务或没有密钥，用不了它来转文字" };
  if (want !== "auto") {
    const t = targets.find((x) => x.provider === want);
    if (!t) return { reason: `中转服务上没有名为 ${want} 的模型服务` };
    return fromText(t, s.model) ?? { reason: `${want} 没有密钥、不是 OpenAI 兼容接口，或需要设置 POCKET_TRANSCRIBE_MODEL` };
  }
  const voice = fromVoice(live, s.model);
  if (voice) return voice;
  for (const id of ["openai", "siliconflow"]) {
    const t = targets.find((x) => x.provider === id);
    const found = t && fromText(t, s.model);
    if (found) return found;
  }
  return { reason: "中转服务还没有配置语音转文字：设置 POCKET_TRANSCRIBE_URL 和 POCKET_TRANSCRIBE_KEY，或给 OpenAI / 硅基流动配上密钥" };
}

export function transcribeInfo(r: TranscribeTarget | { reason: string }): TranscribeInfo {
  const limits = { maxBytes: TRANSCRIBE_LIMITS.maxBytes, maxSeconds: TRANSCRIBE_LIMITS.maxSeconds, formats: TRANSCRIBE_FORMATS };
  return "reason" in r ? { available: false, reason: r.reason, ...limits } : { available: true, provider: r.provider, model: r.model, ...limits };
}

/** The audio type without parameters (`audio/webm;codecs=opus` -> `audio/webm`), if it is one the relay takes. */
export function audioType(contentType: string | undefined): string | undefined {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return TRANSCRIBE_FORMATS.includes(t) ? t : undefined;
}

const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
};

/** Length of a PCM WAV recording from its header, in ms; undefined for anything else. */
export function wavDurationMs(buf: Uint8Array): number | undefined {
  if (buf.length < 44) return undefined;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt " && off + 16 <= buf.length) byteRate = view.getUint32(off + 16, true);
    if (id === "data") return byteRate ? Math.round((Math.min(size, buf.length - off - 8) / byteRate) * 1000) : undefined;
    off += 8 + size + (size & 1);
  }
  return undefined;
}

/** Per device: at most `perMinute` requests a minute and `concurrent` at a time. */
export class TranscribeLimiter {
  private seen = new Map<string, { times: number[]; active: number }>();
  private perMinute: number;
  private concurrent: number;
  private now: () => number;

  constructor(perMinute: number = TRANSCRIBE_LIMITS.perMinute, concurrent: number = TRANSCRIBE_LIMITS.concurrent, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.concurrent = concurrent;
    this.now = now;
  }

  /** A release function, or why not now. */
  take(device: string): (() => void) | { reason: string } {
    const t = this.now();
    const s = this.seen.get(device) ?? { times: [], active: 0 };
    s.times = s.times.filter((x) => t - x < 60_000);
    if (s.active >= this.concurrent) return { reason: "上一段还在识别，稍等一下" };
    if (s.times.length >= this.perMinute) return { reason: "语音输入太频繁了，过一分钟再试" };
    s.times.push(t);
    s.active++;
    this.seen.set(device, s);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      s.active = Math.max(0, s.active - 1);
      if (!s.active && !s.times.length) this.seen.delete(device);
    };
  }
}

export class TranscribeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Upstream error text without anything that looks like a key, short. */
function cleanUpstream(text: string, key?: string): string {
  let s = text.replace(/\s+/g, " ").trim();
  if (key) s = s.split(key).join("***");
  return s.replace(/\b(sk|hp|key)[-_][A-Za-z0-9_-]{8,}/gi, "***").slice(0, 200);
}

/** Sends one recording to the service and returns its text. */
export async function transcribe(
  t: TranscribeTarget,
  audio: Uint8Array,
  type: string,
  o: { language?: string; timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<Omit<TranscribeResult, "ms"> & { ms: number }> {
  const form = new FormData();
  form.append("file", new Blob([audio as BlobPart], { type }), `audio.${EXT[type] ?? "bin"}`);
  form.append("model", t.model);
  form.append("response_format", "json");
  const language = o.language && o.language !== "auto" && /^[a-z]{2,3}$/i.test(o.language) ? o.language.toLowerCase() : undefined;
  if (language) form.append("language", language);
  const headers: Record<string, string> = { ...(t.headers ?? {}) };
  if (t.apiKey && t.auth === "bearer") headers.authorization = `Bearer ${t.apiKey}`;
  if (t.apiKey && t.auth === "api-key") headers["api-key"] = t.apiKey;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(`${t.baseUrl}/audio/transcriptions`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(o.timeoutMs ?? 90_000) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new TranscribeError(504, "语音识别服务没有及时回应");
    throw new TranscribeError(502, `连不上语音识别服务（${cleanUpstream((err.cause as Error | undefined)?.message ?? err.message, t.apiKey)}）`);
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) throw new TranscribeError(502, `语音识别服务回答 ${res.status}${body ? `：${cleanUpstream(body, t.apiKey)}` : ""}`);
  let text: unknown;
  try {
    text = (JSON.parse(body) as { text?: unknown }).text;
  } catch {
    text = undefined;
  }
  if (typeof text !== "string") throw new TranscribeError(502, "语音识别服务的回答里没有文字");
  return { text: text.trim(), provider: t.provider, model: t.model, ms: Date.now() - t0, ...(language ? { language } : {}) };
}
