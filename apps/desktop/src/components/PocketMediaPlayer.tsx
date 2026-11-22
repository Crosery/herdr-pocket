import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  Music,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { formatMediaTimecode } from "../lib/filePreview";
import { PocketSelect, type SelectOption } from "./PocketUI";
import "../styles/media-player.css";

const SPEED_OPTIONS: SelectOption[] = [
  { value: "0.25", label: "0.25x" },
  { value: "0.5", label: "0.5x" },
  { value: "0.75", label: "0.75x" },
  { value: "1", label: "1.0x" },
  { value: "1.25", label: "1.25x" },
  { value: "1.5", label: "1.5x" },
  { value: "2", label: "2.0x" },
];

const FRAME_STEP_SEC = 1 / 30;

function readBufferedPct(el: HTMLMediaElement, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || el.buffered.length === 0) return 0;
  const cur = el.currentTime;
  for (let i = el.buffered.length - 1; i >= 0; i -= 1) {
    if (el.buffered.start(i) <= cur + 0.25) {
      return Math.min(100, Math.max(0, (el.buffered.end(i) / duration) * 100));
    }
  }
  return Math.min(100, Math.max(0, (el.buffered.end(el.buffered.length - 1) / duration) * 100));
}

function clampRatio(clientX: number, rect: DOMRect): number {
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/** Custom non-occluding studio video player with 60/120fps scrubber, frame-step, speed, PiP & keyboard shortcuts. */
export function PocketVideoPlayer({
  src,
  title,
  autoPlay = false,
  onError,
  extraActions,
}: {
  src: string;
  title?: string;
  autoPlay?: boolean;
  onError?: () => void;
  extraActions?: ReactNode;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [duration, setDuration] = useState(0);
  const [resolution, setResolution] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState("1");
  const [loop, setLoop] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hudIdle, setHudIdle] = useState(false);
  const [pulseIcon, setPulseIcon] = useState<"play" | "pause" | null>(null);
  const [hasError, setHasError] = useState(false);

  const draggingRef = useRef(false);
  const idleTimerRef = useRef(0);
  const pulseTimerRef = useRef(0);

  const paintScrub = useCallback((curTime: number, dur: number, bufferedPct?: number) => {
    const el = scrubRef.current;
    const pct = dur > 0 ? Math.min(100, Math.max(0, (curTime / dur) * 100)) : 0;
    if (el) {
      el.style.setProperty("--pk-pct", `${pct.toFixed(3)}%`);
      if (bufferedPct !== undefined) {
        el.style.setProperty("--pk-buf", `${bufferedPct.toFixed(2)}%`);
      }
      el.setAttribute("aria-valuenow", String(Math.round(curTime * 100) / 100));
    }
    if (timeRef.current) {
      timeRef.current.textContent = `${formatMediaTimecode(curTime)} / ${formatMediaTimecode(dur)}`;
    }
  }, []);

  const flashPulse = useCallback((kind: "play" | "pause") => {
    setPulseIcon(kind);
    window.clearTimeout(pulseTimerRef.current);
    pulseTimerRef.current = window.setTimeout(() => setPulseIcon(null), 420);
  }, []);

  const pokeHud = useCallback(() => {
    setHudIdle(false);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused && !draggingRef.current) {
        setHudIdle(true);
      }
    }, 2200);
  }, []);

  useEffect(() => {
    setHasError(false);
    setPlaying(false);
    setWaiting(false);
    setDuration(0);
    setResolution(null);
    paintScrub(0, 0, 0);
  }, [paintScrub, src]);

  // 60/120fps direct CSS variable sync without React re-renders during playback
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let alive = true;
    let rafId = 0;
    let rvfcId = 0;
    const anyV = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };

    const syncNow = () => {
      if (!alive) return;
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      if (!draggingRef.current) {
        paintScrub(v.currentTime, dur, readBufferedPct(v, dur));
      }
    };

    const tickFrame = () => {
      syncNow();
      if (!alive || v.paused || v.ended) return;
      if (typeof anyV.requestVideoFrameCallback === "function") {
        rvfcId = anyV.requestVideoFrameCallback(() => {
          rafId = requestAnimationFrame(tickFrame);
        });
      } else {
        rafId = requestAnimationFrame(tickFrame);
      }
    };

    const onPlay = () => {
      setPlaying(true);
      setWaiting(false);
      pokeHud();
      tickFrame();
    };
    const onPause = () => {
      setPlaying(false);
      setWaiting(false);
      setHudIdle(false);
      window.clearTimeout(idleTimerRef.current);
      syncNow();
    };
    const onEnded = () => {
      setPlaying(false);
      setHudIdle(false);
      syncNow();
    };
    const onLoadedMeta = () => {
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      setDuration(dur);
      if (v.videoWidth > 0 && v.videoHeight > 0) {
        setResolution(`${v.videoWidth}×${v.videoHeight}`);
      }
      v.playbackRate = Number(rate) || 1;
      syncNow();
    };
    const onProgress = () => syncNow();
    const onSeeked = () => syncNow();
    const onWaiting = () => setWaiting(true);
    const onCanPlay = () => {
      setWaiting(false);
      syncNow();
    };
    const onVolumeChange = () => {
      setMuted(v.muted);
      setVolume(v.volume);
    };

    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    v.addEventListener("loadedmetadata", onLoadedMeta);
    v.addEventListener("durationchange", onLoadedMeta);
    v.addEventListener("progress", onProgress);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("volumechange", onVolumeChange);

    if (v.readyState >= 1) onLoadedMeta();
    if (!v.paused) onPlay();

    return () => {
      alive = false;
      cancelAnimationFrame(rafId);
      if (rvfcId && typeof anyV.cancelVideoFrameCallback === "function") {
        anyV.cancelVideoFrameCallback(rvfcId);
      }
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("loadedmetadata", onLoadedMeta);
      v.removeEventListener("durationchange", onLoadedMeta);
      v.removeEventListener("progress", onProgress);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("volumechange", onVolumeChange);
    };
  }, [paintScrub, pokeHud, rate]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      window.clearTimeout(idleTimerRef.current);
      window.clearTimeout(pulseTimerRef.current);
    };
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      void v.play().catch(() => {});
      flashPulse("play");
    } else {
      v.pause();
      flashPulse("pause");
    }
    pokeHud();
  }, [flashPulse, pokeHud]);

  const seekBy = useCallback((deltaSec: number) => {
    const v = videoRef.current;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : duration;
    const next = Math.min(dur || Infinity, Math.max(0, v.currentTime + deltaSec));
    v.currentTime = next;
    paintScrub(next, dur);
    pokeHud();
  }, [duration, paintScrub, pokeHud]);

  const stepFrame = useCallback((dir: -1 | 1) => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) v.pause();
    seekBy(dir * FRAME_STEP_SEC);
  }, [seekBy]);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.7;
    pokeHud();
  }, [pokeHud]);

  const changeVolume = useCallback((val: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.min(1, Math.max(0, val));
    v.volume = clamped;
    v.muted = clamped === 0;
  }, []);

  const changeRate = useCallback((next: string) => {
    setRate(next);
    if (videoRef.current) videoRef.current.playbackRate = Number(next) || 1;
  }, []);

  const toggleLoop = useCallback(() => {
    setLoop((prev) => {
      const next = !prev;
      if (videoRef.current) videoRef.current.loop = next;
      return next;
    });
  }, []);

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement === shell) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void shell.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const togglePip = useCallback(() => {
    const v = videoRef.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    if (!v) return;
    if (document.pictureInPictureElement === v) {
      void document.exitPictureInPicture?.().catch(() => {});
    } else if (document.pictureInPictureEnabled && typeof v.requestPictureInPicture === "function") {
      void v.requestPictureInPicture().catch(() => {});
    }
  }, []);

  const updateTipAt = useCallback((clientX: number, rect: DOMRect) => {
    const ratio = clampRatio(clientX, rect);
    const tip = tipRef.current;
    if (tip) {
      tip.style.left = `${(ratio * 100).toFixed(2)}%`;
      tip.textContent = formatMediaTimecode(ratio * duration);
    }
    return ratio;
  }, [duration]);

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      ref={shellRef}
      tabIndex={0}
      aria-label={title || "视频播放器"}
      className={`pk-video-shell${fullscreen ? " is-fs" : ""}${hudIdle && playing && fullscreen ? " is-idle" : ""}`}
      onMouseMove={pokeHud}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const k = e.key.toLowerCase();
        if (k === " " || k === "k") {
          e.preventDefault();
          togglePlay();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          seekBy(-5);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          seekBy(5);
        } else if (k === "j") {
          e.preventDefault();
          seekBy(-10);
        } else if (k === "l") {
          e.preventDefault();
          seekBy(10);
        } else if (e.key === ",") {
          e.preventDefault();
          stepFrame(-1);
        } else if (e.key === ".") {
          e.preventDefault();
          stepFrame(1);
        } else if (k === "m") {
          e.preventDefault();
          toggleMute();
        } else if (k === "r") {
          e.preventDefault();
          toggleLoop();
        } else if (k === "f") {
          e.preventDefault();
          toggleFullscreen();
        } else if (e.key === "Home" && videoRef.current) {
          e.preventDefault();
          videoRef.current.currentTime = 0;
          paintScrub(0, duration);
        } else if (e.key === "End" && videoRef.current && duration > 0) {
          e.preventDefault();
          videoRef.current.currentTime = duration;
          paintScrub(duration, duration);
        }
      }}
    >
      <div
        className="pk-video-stage"
        onClick={(e) => {
          e.currentTarget.closest<HTMLElement>(".pk-video-shell")?.focus();
          togglePlay();
        }}
        onDoubleClick={toggleFullscreen}
      >
        <video
          ref={videoRef}
          className="pk-video-el"
          src={src}
          autoPlay={autoPlay}
          loop={loop}
          playsInline
          preload="metadata"
          onError={() => {
            setHasError(true);
            onError?.();
          }}
        />
        {hasError ? (
          <div className="pk-video-badge-center err">无法解码此视频流，可尝试用系统默认播放器打开</div>
        ) : waiting ? (
          <div className="pk-video-badge-center">
            <Loader2 size={20} className="pk-spin" />
          </div>
        ) : pulseIcon ? (
          <div className="pk-video-badge-center pulse" key={pulseIcon}>
            {pulseIcon === "play" ? <Play size={22} /> : <Pause size={22} />}
          </div>
        ) : null}
      </div>

      <div className="pk-video-deck" onClick={(e) => e.stopPropagation()}>
        <div
          ref={scrubRef}
          className="pk-scrub"
          role="slider"
          tabIndex={0}
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.round(duration * 100) / 100)}
          aria-valuenow={0}
          onPointerDown={(e) => {
            const bar = e.currentTarget;
            bar.setPointerCapture(e.pointerId);
            draggingRef.current = true;
            const rect = bar.getBoundingClientRect();
            const ratio = updateTipAt(e.clientX, rect);
            const target = ratio * duration;
            paintScrub(target, duration);
            if (videoRef.current && Number.isFinite(target)) videoRef.current.currentTime = target;
          }}
          onPointerMove={(e) => {
            const bar = e.currentTarget;
            const rect = bar.getBoundingClientRect();
            const ratio = updateTipAt(e.clientX, rect);
            if (!draggingRef.current) return;
            const target = ratio * duration;
            paintScrub(target, duration);
            if (videoRef.current && Number.isFinite(target)) videoRef.current.currentTime = target;
          }}
          onPointerUp={(e) => {
            draggingRef.current = false;
            try {
              e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
              // ignore
            }
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
        >
          <div className="pk-scrub-track">
            <div className="pk-scrub-buf" />
            <div className="pk-scrub-fill" />
          </div>
          <div className="pk-scrub-thumb" />
          <div ref={tipRef} className="pk-scrub-tip num">00:00.00</div>
        </div>

        <div className="pk-video-controls">
          <div className="pk-vc-group">
            <button
              type="button"
              className="pk-vc-btn primary"
              aria-label={playing ? "暂停" : "播放"}
              title={playing ? "暂停 (Space)" : "播放 (Space)"}
              onClick={togglePlay}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              className="pk-vc-btn"
              aria-label="上一帧"
              title="上一帧 (,)"
              onClick={() => stepFrame(-1)}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              className="pk-vc-btn"
              aria-label="下一帧"
              title="下一帧 (.)"
              onClick={() => stepFrame(1)}
            >
              <ChevronRight size={14} />
            </button>
            <button
              type="button"
              className="pk-vc-btn"
              aria-label="后退 5 秒"
              title="后退 5 秒 (←)"
              onClick={() => seekBy(-5)}
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              className="pk-vc-btn"
              aria-label="前进 5 秒"
              title="前进 5 秒 (→)"
              onClick={() => seekBy(5)}
            >
              <RotateCw size={13} />
            </button>
            <span ref={timeRef} className="pk-vc-time num">
              00:00.00 / 00:00.00
            </span>
          </div>

          <div className="pk-vc-group">
            {resolution ? <span className="pk-vc-meta num">{resolution}</span> : null}
            <div className="pk-vol-wrap">
              <button
                type="button"
                className="pk-vc-btn"
                aria-label={muted ? "取消静音" : "静音"}
                title="静音 (M)"
                onClick={toggleMute}
              >
                <VolumeIcon size={14} />
              </button>
              <div
                className="pk-vol-bar"
                role="slider"
                tabIndex={0}
                aria-label="音量"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
                onPointerDown={(e) => {
                  const el = e.currentTarget;
                  el.setPointerCapture(e.pointerId);
                  changeVolume(clampRatio(e.clientX, el.getBoundingClientRect()));
                }}
                onPointerMove={(e) => {
                  if (e.buttons !== 1) return;
                  changeVolume(clampRatio(e.clientX, e.currentTarget.getBoundingClientRect()));
                }}
              >
                <div className="pk-vol-fill" style={{ width: `${Math.round((muted ? 0 : volume) * 100)}%` }} />
              </div>
            </div>

            <PocketSelect
              size="sm"
              mono
              ariaLabel="倍速"
              value={rate}
              onValueChange={changeRate}
              options={SPEED_OPTIONS}
              className="pk-vc-speed"
            />

            <button
              type="button"
              className={`pk-vc-btn${loop ? " on" : ""}`}
              aria-label="循环播放"
              aria-pressed={loop}
              title="循环播放 (R)"
              onClick={toggleLoop}
            >
              <Repeat size={13} />
            </button>

            {typeof document !== "undefined" && document.pictureInPictureEnabled ? (
              <button
                type="button"
                className="pk-vc-btn"
                aria-label="画中画"
                title="画中画"
                onClick={togglePip}
              >
                <PictureInPicture2 size={13} />
              </button>
            ) : null}

            <button
              type="button"
              className="pk-vc-btn"
              aria-label={fullscreen ? "退出全屏" : "全屏"}
              title="全屏 (F)"
              onClick={toggleFullscreen}
            >
              {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            {extraActions}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Styled Pocket studio audio player matching desktop visual design rules. */
export function PocketAudioPlayer({
  src,
  title,
  autoPlay = false,
  onError,
  extraActions,
}: {
  src: string;
  title?: string;
  autoPlay?: boolean;
  onError?: () => void;
  extraActions?: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState("1");
  const [loop, setLoop] = useState(false);

  const paintScrub = useCallback((cur: number, dur: number) => {
    const pct = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
    if (scrubRef.current) {
      scrubRef.current.style.setProperty("--pk-pct", `${pct.toFixed(3)}%`);
      scrubRef.current.setAttribute("aria-valuenow", String(Math.round(cur * 100) / 100));
    }
    if (timeRef.current) {
      timeRef.current.textContent = `${formatMediaTimecode(cur)} / ${formatMediaTimecode(dur)}`;
    }
  }, []);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let alive = true;
    let rafId = 0;

    const tick = () => {
      if (!alive) return;
      const dur = Number.isFinite(a.duration) ? a.duration : 0;
      if (!draggingRef.current) paintScrub(a.currentTime, dur);
      if (!a.paused && !a.ended) rafId = requestAnimationFrame(tick);
    };

    const onPlay = () => {
      setPlaying(true);
      tick();
    };
    const onPause = () => {
      setPlaying(false);
      paintScrub(a.currentTime, Number.isFinite(a.duration) ? a.duration : 0);
    };
    const onMeta = () => {
      const dur = Number.isFinite(a.duration) ? a.duration : 0;
      setDuration(dur);
      a.playbackRate = Number(rate) || 1;
      paintScrub(a.currentTime, dur);
    };
    const onVol = () => {
      setMuted(a.muted);
      setVolume(a.volume);
    };

    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onPause);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("seeked", onPause);
    a.addEventListener("volumechange", onVol);

    return () => {
      alive = false;
      cancelAnimationFrame(rafId);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onPause);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("seeked", onPause);
      a.removeEventListener("volumechange", onVol);
    };
  }, [paintScrub, rate]);

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="pk-audio-card">
      <audio ref={audioRef} src={src} autoPlay={autoPlay} loop={loop} onError={onError} />
      <div className="pk-audio-top">
        <span className="pk-audio-icon" aria-hidden>
          <Music size={18} />
        </span>
        <div className="pk-audio-title truncate" title={title}>{title || "音频文件"}</div>
        <span ref={timeRef} className="pk-vc-time num">00:00.00 / 00:00.00</span>
      </div>

      <div
        ref={scrubRef}
        className="pk-scrub"
        role="slider"
        tabIndex={0}
        aria-label="音频进度"
        aria-valuemin={0}
        aria-valuemax={Math.max(1, Math.round(duration * 100) / 100)}
        aria-valuenow={0}
        onPointerDown={(e) => {
          const bar = e.currentTarget;
          bar.setPointerCapture(e.pointerId);
          draggingRef.current = true;
          const next = clampRatio(e.clientX, bar.getBoundingClientRect()) * duration;
          paintScrub(next, duration);
          if (audioRef.current && Number.isFinite(next)) audioRef.current.currentTime = next;
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          const next = clampRatio(e.clientX, e.currentTarget.getBoundingClientRect()) * duration;
          paintScrub(next, duration);
          if (audioRef.current && Number.isFinite(next)) audioRef.current.currentTime = next;
        }}
        onPointerUp={(e) => {
          draggingRef.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
        }}
      >
        <div className="pk-scrub-track">
          <div className="pk-scrub-fill" />
        </div>
        <div className="pk-scrub-thumb" />
      </div>

      <div className="pk-video-controls">
        <div className="pk-vc-group">
          <button
            type="button"
            className="pk-vc-btn primary"
            aria-label={playing ? "暂停" : "播放"}
            onClick={() => {
              const a = audioRef.current;
              if (!a) return;
              if (a.paused || a.ended) void a.play().catch(() => {});
              else a.pause();
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            type="button"
            className="pk-vc-btn"
            aria-label="后退 5 秒"
            onClick={() => {
              if (audioRef.current) audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 5);
            }}
          >
            <RotateCcw size={13} />
          </button>
          <button
            type="button"
            className="pk-vc-btn"
            aria-label="前进 5 秒"
            onClick={() => {
              if (audioRef.current) audioRef.current.currentTime = Math.min(duration || Infinity, audioRef.current.currentTime + 5);
            }}
          >
            <RotateCw size={13} />
          </button>
        </div>

        <div className="pk-vc-group">
          <div className="pk-vol-wrap">
            <button
              type="button"
              className="pk-vc-btn"
              aria-label={muted ? "取消静音" : "静音"}
              onClick={() => {
                if (audioRef.current) audioRef.current.muted = !audioRef.current.muted;
              }}
            >
              <VolumeIcon size={14} />
            </button>
            <div
              className="pk-vol-bar"
              role="slider"
              tabIndex={0}
              aria-label="音量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((muted ? 0 : volume) * 100)}
              onPointerDown={(e) => {
                const a = audioRef.current;
                if (!a) return;
                const el = e.currentTarget;
                el.setPointerCapture(e.pointerId);
                const val = clampRatio(e.clientX, el.getBoundingClientRect());
                a.volume = val;
                a.muted = val === 0;
              }}
              onPointerMove={(e) => {
                const a = audioRef.current;
                if (!a || e.buttons !== 1) return;
                const val = clampRatio(e.clientX, e.currentTarget.getBoundingClientRect());
                a.volume = val;
                a.muted = val === 0;
              }}
            >
              <div className="pk-vol-fill" style={{ width: `${Math.round((muted ? 0 : volume) * 100)}%` }} />
            </div>
          </div>

          <PocketSelect
            size="sm"
            mono
            ariaLabel="倍速"
            value={rate}
            onValueChange={(next) => {
              setRate(next);
              if (audioRef.current) audioRef.current.playbackRate = Number(next) || 1;
            }}
            options={SPEED_OPTIONS}
            className="pk-vc-speed"
          />

          <button
            type="button"
            className={`pk-vc-btn${loop ? " on" : ""}`}
            aria-label="循环播放"
            aria-pressed={loop}
            onClick={() => {
              setLoop((prev) => {
                const next = !prev;
                if (audioRef.current) audioRef.current.loop = next;
                return next;
              });
            }}
          >
            <Repeat size={13} />
          </button>
          {extraActions}
        </div>
      </div>
    </div>
  );
}
