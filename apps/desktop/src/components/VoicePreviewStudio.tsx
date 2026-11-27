import { useCallback, useEffect, useRef, useState } from "react";
import { Headphones, Mic, Play, Square, Volume2 } from "lucide-react";
import { native, type VoiceAiPreviewResult, type VoiceAiState } from "../lib/native";
import { PocketBadge, PocketButton, PocketCheckbox, useToast } from "./PocketUI";

const TARGET_RATE = 16_000;
const MAX_RECORD_MS = 5_000;
const HEADPHONE_RE = /headphone|headset|earphone|earbud|airpods|buds|beats|bose|sony|wh-|wf-|bluetooth|耳机|头戴/i;

function resampleTo16k(input: Float32Array, fromRate: number): Int16Array {
  if (fromRate === TARGET_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]!));
      out[i] = Math.round(s * 32767);
    }
    return out;
  }
  const ratio = fromRate / TARGET_RATE;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(input.length - 1, idx + 1)] ?? a;
    const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
    out[i] = Math.round(s * 32767);
  }
  return out;
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const samples = Math.floor(bin.length / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
  }
  return out;
}

export function VoicePreviewStudio({ aiState }: { aiState: VoiceAiState }) {
  const toast = useToast();
  const [detectedHeadphone, setDetectedHeadphone] = useState<string | null>(null);
  const [headphoneConfirmed, setHeadphoneConfirmed] = useState(false);
  const [liveOn, setLiveOn] = useState(false);
  const [listenMode, setListenMode] = useState<"processed" | "raw">("processed");
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [rawBase64, setRawBase64] = useState<string | null>(null);
  const [rawDurationMs, setRawDurationMs] = useState(0);
  const [processed, setProcessed] = useState<VoiceAiPreviewResult | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [playing, setPlaying] = useState<"raw" | "processed" | null>(null);
  const [bars, setBars] = useState<number[]>(() => Array.from({ length: 28 }, () => 5));

  const liveCtxRef = useRef<AudioContext | null>(null);
  const liveStreamRef = useRef<MediaStream | null>(null);
  const liveNodesRef = useRef<{
    rawGain: GainNode;
    procGain: GainNode;
    hpf: BiquadFilterNode;
    presence: BiquadFilterNode;
  } | null>(null);
  const liveRafRef = useRef<number | null>(null);

  const recStopRef = useRef<(() => void) | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const playSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const playRafRef = useRef<number | null>(null);

  const canUseLive = Boolean(detectedHeadphone) || headphoneConfirmed;
  const estLatencyMs = aiState.tier === "tse" && aiState.filter ? 148 : 42;

  const refreshOutputs = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const list = await navigator.mediaDevices.enumerateDevices();
      const outs = list.filter((d) => d.kind === "audiooutput" && d.label);
      const hp = outs.find((d) => HEADPHONE_RE.test(d.label));
      setDetectedHeadphone(hp ? hp.label : null);
    } catch {
      // ignore permission-less enumeration errors
    }
  }, []);

  useEffect(() => {
    void refreshOutputs();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const onChange = () => void refreshOutputs();
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [refreshOutputs]);

  const stopPlayback = useCallback(() => {
    if (playRafRef.current != null) {
      cancelAnimationFrame(playRafRef.current);
      playRafRef.current = null;
    }
    try {
      playSrcRef.current?.stop();
    } catch {
      // already stopped
    }
    playSrcRef.current = null;
    if (playCtxRef.current) {
      void playCtxRef.current.close().catch(() => {});
      playCtxRef.current = null;
    }
    setPlaying(null);
  }, []);

  const stopLiveMonitor = useCallback(() => {
    if (liveRafRef.current != null) {
      cancelAnimationFrame(liveRafRef.current);
      liveRafRef.current = null;
    }
    liveNodesRef.current = null;
    if (liveStreamRef.current) {
      liveStreamRef.current.getTracks().forEach((t) => t.stop());
      liveStreamRef.current = null;
    }
    if (liveCtxRef.current) {
      void liveCtxRef.current.close().catch(() => {});
      liveCtxRef.current = null;
    }
    setLiveOn(false);
    setBars(Array.from({ length: 28 }, () => 5));
  }, []);

  useEffect(() => {
    return () => {
      recStopRef.current?.();
      stopLiveMonitor();
      stopPlayback();
    };
  }, [stopLiveMonitor, stopPlayback]);

  // Keep live monitor DSP nodes synced with switches & listen mode in real time.
  useEffect(() => {
    const nodes = liveNodesRef.current;
    if (!nodes) return;
    nodes.rawGain.gain.value = listenMode === "raw" ? 0.92 : 0;
    nodes.procGain.gain.value = listenMode === "processed" ? 0.92 : 0;
    nodes.hpf.frequency.value = aiState.denoise ? 110 : 20;
    nodes.presence.gain.value = aiState.enhanceVocal ? 5.2 : 0;
  }, [listenMode, aiState.denoise, aiState.enhanceVocal]);

  // Re-run real Rust/DSP LiveCallProcessor whenever parameters change on an existing 5s clip.
  const configSig = `${aiState.denoise}:${aiState.enhanceVocal}:${aiState.tier}:${aiState.filter}:${aiState.firstSpeaker}:${aiState.threshold.toFixed(2)}:${aiState.enrolled}`;
  useEffect(() => {
    if (!rawBase64) return;
    let cancelled = false;
    setRecomputing(true);
    void native
      .voiceAiPreviewProcess(rawBase64)
      .then((res) => {
        if (!cancelled) setProcessed(res);
      })
      .catch((e) => {
        if (!cancelled) toast((e as Error).message || "重算试听效果失败", true);
      })
      .finally(() => {
        if (!cancelled) setRecomputing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rawBase64, configSig, toast]);

  const startLiveMonitor = async () => {
    if (!canUseLive) {
      toast("外放扬声器下请先戴好耳机并勾选确认，避免啸叫", true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("当前环境不支持麦克风试听", true);
      return;
    }
    stopPlayback();
    recStopRef.current?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: aiState.denoise,
          autoGainControl: false,
        },
      });
      void refreshOutputs();
      const ctx = new AudioContext({ latencyHint: "interactive" });
      const src = ctx.createMediaStreamSource(stream);
      const rawGain = ctx.createGain();
      const procGain = ctx.createGain();
      const hpf = ctx.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = aiState.denoise ? 110 : 20;
      const presence = ctx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 2600;
      presence.Q.value = 1.1;
      presence.gain.value = aiState.enhanceVocal ? 5.2 : 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.ratio.value = 3.2;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;

      rawGain.gain.value = listenMode === "raw" ? 0.92 : 0;
      procGain.gain.value = listenMode === "processed" ? 0.92 : 0;

      src.connect(rawGain);
      rawGain.connect(analyser);

      src.connect(hpf);
      hpf.connect(presence);
      presence.connect(comp);
      comp.connect(procGain);
      procGain.connect(analyser);

      analyser.connect(ctx.destination);

      liveStreamRef.current = stream;
      liveCtxRef.current = ctx;
      liveNodesRef.current = { rawGain, procGain, hpf, presence };
      setLiveOn(true);

      const bins = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!liveCtxRef.current) return;
        analyser.getByteFrequencyData(bins);
        const next: number[] = [];
        for (let i = 0; i < 28; i++) {
          const v = bins[i % bins.length] ?? 0;
          next.push(Math.max(4, Math.min(34, Math.round(4 + (v / 255) * 30))));
        }
        setBars(next);
        liveRafRef.current = requestAnimationFrame(tick);
      };
      liveRafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      toast((e as Error).message || "无法打开麦克风进行耳返试听", true);
      stopLiveMonitor();
    }
  };

  const toggleRecord5s = async () => {
    if (recording) {
      recStopRef.current?.();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("当前环境不支持麦克风录音试听", true);
      return;
    }
    stopLiveMonitor();
    stopPlayback();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      void refreshOutputs();
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const silent = ctx.createGain();
      silent.gain.value = 0;
      const chunks: Float32Array[] = [];
      const startedAt = Date.now();
      let stopped = false;

      proc.onaudioprocess = (ev) => {
        if (stopped) return;
        const ch = ev.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(ch));
        let peak = 0;
        for (let i = 0; i < ch.length; i += 8) {
          const a = Math.abs(ch[i]!);
          if (a > peak) peak = a;
        }
        setBars((prev) => [...prev.slice(1), Math.max(4, Math.min(34, Math.round(4 + peak * 58)))]);
      };

      src.connect(proc);
      proc.connect(silent);
      silent.connect(ctx.destination);

      setRecording(true);
      setRecordSec(0);

      const timer = window.setInterval(() => {
        const elapsed = Date.now() - startedAt;
        setRecordSec(Math.min(5, elapsed / 1000));
        if (elapsed >= MAX_RECORD_MS) {
          finish();
        }
      }, 100);

      const finish = () => {
        if (stopped) return;
        stopped = true;
        window.clearInterval(timer);
        recStopRef.current = null;
        try {
          proc.disconnect();
          src.disconnect();
        } catch {
          // ignore
        }
        stream.getTracks().forEach((t) => t.stop());
        const rate = ctx.sampleRate;
        void ctx.close().catch(() => {});
        setRecording(false);
        setBars(Array.from({ length: 28 }, () => 5));

        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        if (total < rate * 0.6) {
          toast("录制时间太短，请至少说 1 秒以上", true);
          return;
        }
        const merged = new Float32Array(total);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }
        const pcm16 = resampleTo16k(merged, rate);
        setRawDurationMs(Math.round((pcm16.length / TARGET_RATE) * 1000));
        setRawBase64(pcm16ToBase64(pcm16));
      };

      recStopRef.current = finish;
    } catch (e) {
      toast((e as Error).message || "无法获取麦克风权限", true);
      setRecording(false);
    }
  };

  const playClip = (which: "raw" | "processed") => {
    if (playing === which) {
      stopPlayback();
      return;
    }
    const b64 = which === "raw" ? rawBase64 : processed?.pcmBase64;
    if (!b64) return;
    stopLiveMonitor();
    stopPlayback();

    const samples = base64ToFloat32(b64);
    const ctx = new AudioContext();
    const buf = ctx.createBuffer(1, samples.length, TARGET_RATE);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    src.connect(analyser);
    analyser.connect(ctx.destination);

    playCtxRef.current = ctx;
    playSrcRef.current = src;
    setPlaying(which);

    const bins = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!playCtxRef.current) return;
      analyser.getByteFrequencyData(bins);
      const next: number[] = [];
      for (let i = 0; i < 28; i++) {
        const v = bins[i % bins.length] ?? 0;
        next.push(Math.max(4, Math.min(34, Math.round(4 + (v / 255) * 30))));
      }
      setBars(next);
      playRafRef.current = requestAnimationFrame(tick);
    };
    playRafRef.current = requestAnimationFrame(tick);

    src.onended = () => {
      stopPlayback();
      setBars(Array.from({ length: 28 }, () => 5));
    };
    src.start();
  };

  const statusTone = liveOn ? "mint" : recording ? "blush" : playing ? "pink" : "neutral";
  const statusLabel = liveOn
    ? `实时耳返中 · 约 ${estLatencyMs} ms`
    : recording
      ? `录音中 · ${recordSec.toFixed(1)}s / 5.0s`
      : playing === "raw"
        ? "正在回放：原始麦克风"
        : playing === "processed"
          ? "正在回放：增强后效果"
          : recomputing
            ? "正在重算增强效果…"
            : rawBase64
              ? `已缓存 ${(rawDurationMs / 1000).toFixed(1)}s 样本`
              : "待机";

  return (
    <div className="vlab-card" aria-label="语音效果实时试听台">
      <div className="vlab-head">
        <div className="row" style={{ gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          <strong style={{ fontSize: 13, color: "var(--ink)" }}>效果试听台</strong>
          <PocketBadge tone={statusTone}>{statusLabel}</PocketBadge>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <PocketButton
            size="sm"
            variant={liveOn ? "primary" : "soft"}
            disabled={!canUseLive && !liveOn}
            onClick={() => (liveOn ? stopLiveMonitor() : void startLiveMonitor())}
          >
            <Headphones size={13} />
            <span>{liveOn ? "停止耳返" : "戴耳机实时耳返"}</span>
          </PocketButton>
          <PocketButton
            size="sm"
            variant={recording ? "danger" : "ghost"}
            onClick={() => void toggleRecord5s()}
          >
            {recording ? <Square size={12} /> : <Mic size={13} />}
            <span>{recording ? "停止录音" : "录 5 秒 A/B 对比"}</span>
          </PocketButton>
        </div>
      </div>

      <div className="vlab-body">
        {!canUseLive ? (
          <div className="vlab-route-bar warn">
            <span className="row" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <Volume2 size={14} style={{ flexShrink: 0 }} />
              <span>外放扬声器下已锁定实时耳返以防啸叫；可直接用「录 5 秒 A/B 对比」试听，或戴好耳机后勾选解锁：</span>
            </span>
            <div className="row" style={{ gap: 6, flexShrink: 0, cursor: "pointer" }} onClick={() => setHeadphoneConfirmed((v) => !v)}>
              <PocketCheckbox
                checked={headphoneConfirmed}
                onCheckedChange={setHeadphoneConfirmed}
                ariaLabel="我已戴耳机"
              />
              <span style={{ fontWeight: 700, fontSize: 12 }}>我已戴耳机</span>
            </div>
          </div>
        ) : (
          <div className="vlab-route-bar">
            <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
              {detectedHeadphone ? `已检测到耳机（${detectedHeadphone}）` : "已确认佩戴耳机"} · 边说边切下方开关立刻听差别
            </span>
            <div className="segmented" role="tablist" aria-label="实时耳返监听源">
              <button
                type="button"
                role="tab"
                aria-selected={listenMode === "processed"}
                className={listenMode === "processed" ? "active" : ""}
                onClick={() => setListenMode("processed")}
              >
                听处理后
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={listenMode === "raw"}
                className={listenMode === "raw" ? "active" : ""}
                onClick={() => setListenMode("raw")}
              >
                听原始麦
              </button>
            </div>
          </div>
        )}

        <div className="vlab-wave-box">
          <div className="row wrap" style={{ justifyContent: "space-between", gap: 6 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              <PocketBadge tone={aiState.denoise ? "mint" : "neutral"}>
                {aiState.denoise ? (processed?.usedDpdf ? "降噪 · DPDFNet" : "降噪 · 已开") : "降噪 · 已关"}
              </PocketBadge>
              <PocketBadge tone={aiState.enhanceVocal ? "pink" : "neutral"}>
                {aiState.enhanceVocal ? "人声增强 · 已开" : "人声增强 · 已关"}
              </PocketBadge>
              <PocketBadge tone={aiState.enrolled && aiState.filter ? "lav" : "neutral"}>
                {aiState.enrolled && aiState.filter
                  ? processed?.usedTse
                    ? "声纹分离 · VoxLock"
                    : "只认我的声音 · 已开"
                  : "声纹过滤 · 未开"}
              </PocketBadge>
            </div>
            {processed ? (
              <span className="mono faint" style={{ fontSize: 11 }}>
                原 {processed.inRmsDb} dB → 现 {processed.outRmsDb} dB · {processed.processMs} ms
              </span>
            ) : null}
          </div>

          <div className="vlab-bars" aria-hidden="true">
            {bars.map((h, idx) => (
              <span
                key={idx}
                className={`vlab-bar${playing === "raw" || (liveOn && listenMode === "raw") ? " raw" : ""}`}
                style={{ height: `${h}px` }}
              />
            ))}
          </div>

          <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
            <span className="faint" style={{ fontSize: 11.5 }}>
              {rawBase64
                ? "改下方任意降噪/人声/声纹开关会自动用真实本地引擎重算样本，无需重录"
                : "点右上角「录 5 秒 A/B 对比」录一句日常对话，即可反复切换原声与增强后效果"}
            </span>
            <div className="row" style={{ gap: 6 }}>
              <PocketButton
                size="sm"
                variant={playing === "raw" ? "primary" : "ghost"}
                disabled={!rawBase64 || recording}
                onClick={() => playClip("raw")}
              >
                {playing === "raw" ? <Square size={11} /> : <Play size={11} />}
                <span>听原声</span>
              </PocketButton>
              <PocketButton
                size="sm"
                variant={playing === "processed" ? "primary" : "soft"}
                disabled={!processed || recording || recomputing}
                onClick={() => playClip("processed")}
              >
                {playing === "processed" ? <Square size={11} /> : <Play size={11} />}
                <span>{recomputing ? "重算中…" : "听增强后"}</span>
              </PocketButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
