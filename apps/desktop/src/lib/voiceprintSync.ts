import { isMockServer } from "./mock";
import { native, type VoiceAiState } from "./native";
import { getActiveToken } from "./relay";
import { settingsStore } from "./store";

export interface RelayVoiceprintPayload {
  voiceprint: Record<string, unknown> | null;
  sampleBase64?: string;
  updatedAt?: number;
}

function relayEndpoint(): { url: string; token: string } | null {
  const srv = settingsStore.get().server?.trim();
  const token = getActiveToken();
  if (!srv || !token || isMockServer(srv)) return null;
  return { url: `${srv.replace(/\/+$/, "")}/v1/voiceprint`, token };
}

export async function pushVoiceprintToRelay(): Promise<boolean> {
  const ep = relayEndpoint();
  if (!ep) return false;
  const exported = await native.voiceAiExportVoiceprint().catch(() => null);
  if (!exported || !exported.voiceprint) return false;
  const res = await fetch(ep.url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ep.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(exported),
  });
  return res.ok;
}

export async function deleteVoiceprintFromRelay(): Promise<boolean> {
  const ep = relayEndpoint();
  if (!ep) return false;
  const res = await fetch(ep.url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ep.token}` },
  });
  return res.ok;
}

export async function pullVoiceprintFromRelay(): Promise<VoiceAiState | null> {
  const ep = relayEndpoint();
  if (!ep) return null;
  const res = await fetch(ep.url, {
    headers: { Authorization: `Bearer ${ep.token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as RelayVoiceprintPayload;
  if (!data?.voiceprint) return null;
  return native.voiceAiImportVoiceprint({
    voiceprint: data.voiceprint,
    ...(typeof data.sampleBase64 === "string" ? { sampleBase64: data.sampleBase64 } : {}),
  });
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Decodes a browser File (.wav, .mp3, .m4a, .aac, .ogg, .flac, etc.) into mono 16 kHz signed
 * little-endian PCM16 base64 suitable for `voice_ai_enroll_from_pcm` (capped at 45 seconds).
 */
export async function decodeAudioFileToPcm16Base64(file: File): Promise<string> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) throw new Error("当前环境不支持解码音频文件");
  const raw = await file.arrayBuffer();
  const ctx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(raw.slice(0));
  } catch {
    throw new Error("无法解码该音频文件，请使用常见的 wav / mp3 / m4a / aac 格式");
  } finally {
    void ctx.close().catch(() => {});
  }

  const maxSeconds = 45;
  const duration = Math.min(maxSeconds, Math.max(0.1, decoded.duration));
  const targetLen = Math.max(1, Math.round(duration * 16_000));
  let mono: Float32Array;

  if (typeof OfflineAudioContext !== "undefined") {
    const offline = new OfflineAudioContext(1, targetLen, 16_000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0, 0, duration);
    const rendered = await offline.startRendering();
    mono = rendered.getChannelData(0);
  } else {
    const ch0 = decoded.getChannelData(0);
    const step = decoded.sampleRate / 16_000;
    mono = new Float32Array(targetLen);
    for (let i = 0; i < targetLen; i++) {
      const idx = Math.min(ch0.length - 1, Math.round(i * step));
      mono[i] = ch0[idx] ?? 0;
    }
  }

  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const clamped = Math.max(-1, Math.min(1, mono[i]!));
    pcm[i] = Math.round(clamped * 32767);
  }
  return uint8ToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}
