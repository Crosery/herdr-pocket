import { useCallback, useEffect, useRef, useState } from "react";
import { Lock, RotateCcw, Unlock } from "lucide-react";
import type { PortalFramePayload, PortalInputAction, PortalItem } from "@herdr-pocket/protocol";
import {
  computeContainedRect,
  mapZoomedStagePointer,
  resolvePortalTransport,
  stepTrackpadCursor,
} from "../lib/portalClient";
import { PocketButton } from "./PocketUI";

export type RemoteControlMode = "pointer" | "trackpad" | "view";

export interface StageStreamMetrics {
  fps: number;
  kbps: number;
}

export function PortalRemoteStage({
  item,
  frame,
  controlMode,
  showRemoteCursor,
  zoom,
  pan,
  onPanChange,
  onZoomChange,
  latchedMods,
  onConsumeLatchedMods,
  onSendInput,
  onMetricsChange,
  placeholder,
}: {
  item: PortalItem;
  frame?: PortalFramePayload;
  controlMode: RemoteControlMode;
  showRemoteCursor: boolean;
  zoom: number;
  pan: { x: number; y: number };
  onPanChange: (next: { x: number; y: number }) => void;
  onZoomChange: (next: number) => void;
  latchedMods: string[];
  onConsumeLatchedMods: () => void;
  onSendInput: (input: PortalInputAction) => Promise<unknown> | void;
  onMetricsChange?: (metrics: StageStreamMetrics) => void;
  placeholder: React.ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestSourceRef = useRef<ImageBitmap | HTMLImageElement | null>(null);
  const decodeSeqRef = useRef(0);
  const [stageSize, setStageSize] = useState({ width: 960, height: 540 });
  const [cursorNxNy, setCursorNxNy] = useState<{ nx: number; ny: number }>({ nx: 0.5, ny: 0.5 });
  const [hovering, setHovering] = useState(false);
  const [dragLocked, setDragLocked] = useState(false);
  const [ripple, setRipple] = useState<{ id: number; nx: number; ny: number; right: boolean } | null>(null);

  const dragBtnRef = useRef<"left" | "right" | "middle" | null>(null);
  const lastMoveSentAtRef = useRef(0);
  const lastMoveCoordRef = useRef<{ nx: number; ny: number } | null>(null);
  const pendingMoveRef = useRef<{ nx: number; ny: number; button: "left" | "right" | "middle"; action: "move" | "drag"; mods: string[] } | null>(null);
  const moveInFlightRef = useRef(false);
  const moveRafRef = useRef<number | null>(null);
  const wheelInFlightRef = useRef(false);
  const pendingWheelRef = useRef<{ nx: number; ny: number; deltaX: number; deltaY: number; mods: string[] } | null>(null);

  // Trackpad touch/pointer state
  const pointersRef = useRef<Map<number, { x: number; y: number; downX: number; downY: number; downAt: number }>>(new Map());
  const tapHistoryRef = useRef<{ at: number; nx: number; ny: number }>({ at: 0, nx: 0.5, ny: 0.5 });
  const twoFingerRef = useRef<{ startDist: number; startZoom: number; prevMidX: number; prevMidY: number; moved: boolean } | null>(null);
  const tpDragActiveRef = useRef(false);
  const panDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Live sliding-window FPS / KB/s tracker
  const statSamplesRef = useRef<Array<{ at: number; bytes: number }>>([]);
  const lastSeqRef = useRef<number>(-1);
  const onMetricsChangeRef = useRef(onMetricsChange);
  onMetricsChangeRef.current = onMetricsChange;
  const lastEmittedMetricsRef = useRef<StageStreamMetrics>({ fps: -1, kbps: -1 });

  const imgW = frame?.width ?? item.width ?? 1280;
  const imgH = frame?.height ?? item.height ?? 800;

  const drawCurrentFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const src = latestSourceRef.current;
    if (!canvas || !src) return;
    const w = Math.max(1, stageSize.width);
    const h = Math.max(1, stageSize.height);
    const dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { drawLeft, drawTop, drawW, drawH } = computeContainedRect(w, h, imgW, imgH);
    const z = Math.max(1, zoom);
    const destX = w / 2 + pan.x + (drawLeft - w / 2) * z;
    const destY = h / 2 + pan.y + (drawTop - h / 2) * z;
    const destW = drawW * z;
    const destH = drawH * z;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, destX, destY, destW, destH);
  }, [imgH, imgW, pan.x, pan.y, stageSize.height, stageSize.width, zoom]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const updateSize = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setStageSize({ width: Math.round(r.width), height: Math.round(r.height) });
      }
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    drawCurrentFrame();
  }, [drawCurrentFrame]);

  const emitRollingMetrics = useCallback(() => {
    const now = Date.now();
    const kept = statSamplesRef.current.filter((s) => now - s.at <= 1000);
    statSamplesRef.current = kept;
    const fps = kept.length;
    const totalBytes = kept.reduce((acc, s) => acc + s.bytes, 0);
    const kbps = Math.round(totalBytes / 1024);
    const prev = lastEmittedMetricsRef.current;
    if (prev.fps !== fps || prev.kbps !== kbps) {
      lastEmittedMetricsRef.current = { fps, kbps };
      onMetricsChangeRef.current?.({ fps, kbps });
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(emitRollingMetrics, 500);
    return () => clearInterval(timer);
  }, [emitRollingMetrics]);

  useEffect(() => {
    statSamplesRef.current = [];
    lastSeqRef.current = -1;
    emitRollingMetrics();
  }, [emitRollingMetrics, item.id]);

  useEffect(() => {
    const hasBinary = Boolean(frame?.rawBytes && frame.rawBytes.byteLength > 0);
    const hasBase64 = Boolean(frame?.data);
    if (!frame || (!hasBinary && !hasBase64)) {
      const prev = latestSourceRef.current;
      latestSourceRef.current = null;
      if (prev && "close" in prev && typeof prev.close === "function") prev.close();
      return;
    }

    if (frame.seq !== lastSeqRef.current) {
      lastSeqRef.current = frame.seq;
      const frameBytes =
        frame.byteLength ??
        frame.rawBytes?.byteLength ??
        Math.round((frame.data.length * 3) / 4);
      statSamplesRef.current.push({ at: Date.now(), bytes: frameBytes });
      emitRollingMetrics();
    }

    if (frame.cursorVisible && frame.cursorX !== undefined && frame.cursorY !== undefined && controlMode === "pointer" && !hovering) {
      setCursorNxNy({ nx: frame.cursorX, ny: frame.cursorY });
    }

    const seqToken = ++decodeSeqRef.current;
    let cancelled = false;
    const mime = frame.mime || "image/jpeg";

    const commitSource = (next: ImageBitmap | HTMLImageElement) => {
      if (cancelled || seqToken !== decodeSeqRef.current) {
        if ("close" in next && typeof next.close === "function") next.close();
        return;
      }
      const prev = latestSourceRef.current;
      latestSourceRef.current = next;
      if (prev && "close" in prev && typeof prev.close === "function") prev.close();
      drawCurrentFrame();
    };

    let revokeUrl: string | null = null;
    const loadViaImage = () => {
      if (cancelled || seqToken !== decodeSeqRef.current) return;
      const img = new Image();
      img.onload = () => {
        if (revokeUrl) {
          URL.revokeObjectURL(revokeUrl);
          revokeUrl = null;
        }
        commitSource(img);
      };
      img.onerror = () => {
        if (revokeUrl) {
          URL.revokeObjectURL(revokeUrl);
          revokeUrl = null;
        }
      };
      if (hasBinary && frame.rawBytes) {
        revokeUrl = URL.createObjectURL(new Blob([frame.rawBytes as Uint8Array<ArrayBuffer>], { type: mime }));
        img.src = revokeUrl;
      } else {
        img.src = `data:${mime};base64,${frame.data}`;
      }
    };

    if (typeof createImageBitmap === "function" && (hasBinary || typeof atob === "function")) {
      try {
        let blob: Blob;
        if (hasBinary && frame.rawBytes) {
          blob = new Blob([frame.rawBytes as Uint8Array<ArrayBuffer>], { type: mime });
        } else {
          const bin = atob(frame.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          blob = new Blob([bytes], { type: mime });
        }
        void createImageBitmap(blob)
          .then(commitSource)
          .catch(() => loadViaImage());
        return () => {
          cancelled = true;
          if (revokeUrl) URL.revokeObjectURL(revokeUrl);
        };
      } catch {
        // fall through to HTMLImageElement
      }
    }

    loadViaImage();
    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [controlMode, drawCurrentFrame, emitRollingMetrics, frame, hovering]);

  useEffect(() => {
    return () => {
      if (moveRafRef.current !== null) cancelAnimationFrame(moveRafRef.current);
      const prev = latestSourceRef.current;
      latestSourceRef.current = null;
      if (prev && "close" in prev && typeof prev.close === "function") prev.close();
    };
  }, []);

  const mergeMods = (e?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string[] => {
    const out = new Set<string>(latchedMods);
    if (e?.metaKey) out.add("meta");
    if (e?.ctrlKey) out.add("ctrl");
    if (e?.altKey) out.add("alt");
    if (e?.shiftKey) out.add("shift");
    return [...out];
  };

  const triggerRipple = (nx: number, ny: number, right = false) => {
    setRipple({ id: Date.now() + Math.random(), nx, ny, right });
  };

  const scheduleMoveFlush = () => {
    if (moveRafRef.current !== null || moveInFlightRef.current) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = null;
      if (moveInFlightRef.current) return;
      const pend = pendingMoveRef.current;
      if (!pend) return;
      const now = Date.now();
      const isDirect = resolvePortalTransport(item.hostId, null, frame).isDirect;
      const minInterval = isDirect ? 10 : 22;
      if (now - lastMoveSentAtRef.current < minInterval) {
        scheduleMoveFlush();
        return;
      }
      const prev = lastMoveCoordRef.current;
      if (prev && Math.hypot(pend.nx - prev.nx, pend.ny - prev.ny) < 0.0012 && pend.action === "move") {
        pendingMoveRef.current = null;
        return;
      }
      lastMoveSentAtRef.current = now;
      lastMoveCoordRef.current = { nx: pend.nx, ny: pend.ny };
      pendingMoveRef.current = null;
      moveInFlightRef.current = true;
      void Promise.resolve(
        onSendInput({
          type: "pointer",
          action: pend.action,
          nx: pend.nx,
          ny: pend.ny,
          button: pend.button,
          ...(pend.mods.length ? { modifiers: pend.mods } : {}),
        }),
      )
        .catch(() => {})
        .finally(() => {
          moveInFlightRef.current = false;
          if (pendingMoveRef.current) scheduleMoveFlush();
        });
    });
  };

  const queuePointerMove = (
    nx: number,
    ny: number,
    action: "move" | "drag",
    button: "left" | "right" | "middle",
    mods: string[],
  ) => {
    pendingMoveRef.current = { nx, ny, action, button, mods };
    scheduleMoveFlush();
  };

  const flushWheel = () => {
    if (wheelInFlightRef.current) return;
    const pend = pendingWheelRef.current;
    if (!pend || (pend.deltaX === 0 && pend.deltaY === 0)) {
      pendingWheelRef.current = null;
      return;
    }
    pendingWheelRef.current = null;
    wheelInFlightRef.current = true;
    void Promise.resolve(
      onSendInput({
        type: "wheel",
        nx: pend.nx,
        ny: pend.ny,
        deltaX: pend.deltaX,
        deltaY: pend.deltaY,
        ...(pend.mods.length ? { modifiers: pend.mods } : {}),
      }),
    )
      .catch(() => {})
      .finally(() => {
        wheelInFlightRef.current = false;
        if (pendingWheelRef.current) flushWheel();
      });
  };

  const queueWheelInput = (nx: number, ny: number, deltaX: number, deltaY: number, mods: string[]) => {
    const prev = pendingWheelRef.current;
    if (prev) {
      prev.nx = nx;
      prev.ny = ny;
      prev.deltaX += deltaX;
      prev.deltaY += deltaY;
      prev.mods = mods;
    } else {
      pendingWheelRef.current = { nx, ny, deltaX, deltaY, mods };
    }
    flushWheel();
  };

  const clientToNormalized = (clientX: number, clientY: number) => {
    const el = stageRef.current;
    if (!el) return { nx: 0.5, ny: 0.5, inside: true };
    const r = el.getBoundingClientRect();
    return mapZoomedStagePointer({
      clientX,
      clientY,
      rectLeft: r.left,
      rectTop: r.top,
      rectWidth: r.width,
      rectHeight: r.height,
      imageWidth: imgW,
      imageHeight: imgH,
      zoom,
      panX: pan.x,
      panY: pan.y,
    });
  };

  // Screen overlay coordinate `(x%, y%)` corresponding to remote `(nx, ny)` so cursor stays crisp at any zoom/pan.
  const { drawLeft, drawTop, drawW, drawH } = computeContainedRect(stageSize.width, stageSize.height, imgW, imgH);
  const z = Math.max(1, zoom);
  const cursorCssX = stageSize.width / 2 + pan.x + (drawLeft + cursorNxNy.nx * drawW - stageSize.width / 2) * z;
  const cursorCssY = stageSize.height / 2 + pan.y + (drawTop + cursorNxNy.ny * drawH - stageSize.height / 2) * z;
  const showOverlayCursor =
    Boolean(frame) &&
    controlMode !== "view" &&
    (controlMode === "trackpad" || !showRemoteCursor || !hovering);

  const stageCursorStyle =
    controlMode === "view"
      ? zoom > 1
        ? "grab"
        : "default"
      : controlMode === "trackpad"
        ? "grab"
        : showRemoteCursor
          ? "default"
          : "none";

  return (
    <div
      ref={stageRef}
      className={`portal-stage${controlMode === "trackpad" ? " is-trackpad" : ""}`}
      style={{ cursor: stageCursorStyle }}
      tabIndex={0}
      aria-label="远程桌面与窗口交互舞台"
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => {
        setHovering(false);
        if (dragBtnRef.current) {
          onSendInput({
            type: "pointer",
            action: "up",
            nx: cursorNxNy.nx,
            ny: cursorNxNy.ny,
            button: dragBtnRef.current,
          });
          dragBtnRef.current = null;
        }
      }}
      onPointerDown={(e) => {
        stageRef.current?.focus();
        if (controlMode === "view") {
          if (zoom > 1) {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            panDragRef.current = { startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
          }
          return;
        }
        if (controlMode === "trackpad") {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          pointersRef.current.set(e.pointerId, {
            x: e.clientX,
            y: e.clientY,
            downX: e.clientX,
            downY: e.clientY,
            downAt: Date.now(),
          });
          if (pointersRef.current.size === 2) {
            const pts = [...pointersRef.current.values()];
            const dx = pts[0]!.x - pts[1]!.x;
            const dy = pts[0]!.y - pts[1]!.y;
            twoFingerRef.current = {
              startDist: Math.max(12, Math.hypot(dx, dy)),
              startZoom: zoom,
              prevMidX: (pts[0]!.x + pts[1]!.x) / 2,
              prevMidY: (pts[0]!.y + pts[1]!.y) / 2,
              moved: false,
            };
          } else if (pointersRef.current.size === 1) {
            const gap = Date.now() - tapHistoryRef.current.at;
            if (gap < 280 && !dragLocked) {
              // Double-tap-and-hold starts a native drag gesture after movement.
              tpDragActiveRef.current = false;
            }
          }
          return;
        }

        // Direct pointer mode
        if (!item.canInteract) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const btn: "left" | "right" | "middle" = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
        const { nx, ny } = clientToNormalized(e.clientX, e.clientY);
        setCursorNxNy({ nx, ny });
        dragBtnRef.current = btn;
        pendingMoveRef.current = null;
        const mods = mergeMods(e);
        triggerRipple(nx, ny, btn === "right");
        void onSendInput({
          type: "pointer",
          action: "down",
          nx,
          ny,
          button: btn,
          ...(mods.length ? { modifiers: mods } : {}),
        });
      }}
      onPointerMove={(e) => {
        if (controlMode === "view") {
          if (panDragRef.current) {
            const dx = e.clientX - panDragRef.current.startX;
            const dy = e.clientY - panDragRef.current.startY;
            onPanChange({ x: panDragRef.current.origX + dx, y: panDragRef.current.origY + dy });
          }
          return;
        }
        if (controlMode === "trackpad") {
          const prev = pointersRef.current.get(e.pointerId);
          if (!prev) return;
          const dx = e.clientX - prev.x;
          const dy = e.clientY - prev.y;
          prev.x = e.clientX;
          prev.y = e.clientY;

          if (pointersRef.current.size >= 2 && twoFingerRef.current) {
            const pts = [...pointersRef.current.values()];
            const dist = Math.max(12, Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y));
            const midX = (pts[0]!.x + pts[1]!.x) / 2;
            const midY = (pts[0]!.y + pts[1]!.y) / 2;
            const tf = twoFingerRef.current;
            const ratio = dist / tf.startDist;
            if (Math.abs(ratio - 1) > 0.12) {
              tf.moved = true;
              onZoomChange(Math.min(4, Math.max(1, Math.round(tf.startZoom * ratio * 10) / 10)));
            } else {
              const sdx = midX - tf.prevMidX;
              const sdy = midY - tf.prevMidY;
              if (Math.hypot(sdx, sdy) > 1.5) {
                tf.moved = true;
                queueWheelInput(cursorNxNy.nx, cursorNxNy.ny, -sdx * 2, -sdy * 2, []);
              }
            }
            tf.prevMidX = midX;
            tf.prevMidY = midY;
            return;
          }

          if (Math.hypot(e.clientX - prev.downX, e.clientY - prev.downY) > 6 && !tpDragActiveRef.current) {
            const gap = Date.now() - tapHistoryRef.current.at;
            if (gap < 320 || dragLocked) {
              tpDragActiveRef.current = true;
              if (!dragLocked) {
                onSendInput({ type: "pointer", action: "down", nx: cursorNxNy.nx, ny: cursorNxNy.ny, button: "left" });
              }
            }
          }
          const next = stepTrackpadCursor(cursorNxNy, dx, dy, drawW, drawH);
          setCursorNxNy(next);
          const mods = mergeMods(e);
          queuePointerMove(next.nx, next.ny, dragLocked || tpDragActiveRef.current ? "drag" : "move", "left", mods);
          return;
        }

        if (!item.canInteract) return;
        const { nx, ny } = clientToNormalized(e.clientX, e.clientY);
        setCursorNxNy({ nx, ny });
        const mods = mergeMods(e);
        queuePointerMove(
          nx,
          ny,
          dragBtnRef.current ? "drag" : "move",
          dragBtnRef.current ?? "left",
          mods,
        );
      }}
      onPointerUp={(e) => {
        if (controlMode === "view") {
          panDragRef.current = null;
          return;
        }
        if (controlMode === "trackpad") {
          const tracked = pointersRef.current.get(e.pointerId);
          pointersRef.current.delete(e.pointerId);
          if (twoFingerRef.current) {
            const hadMoved = twoFingerRef.current.moved;
            if (pointersRef.current.size < 2) twoFingerRef.current = null;
            if (!hadMoved && tracked && Date.now() - tracked.downAt < 260) {
              triggerRipple(cursorNxNy.nx, cursorNxNy.ny, true);
              onSendInput({ type: "pointer", action: "click", nx: cursorNxNy.nx, ny: cursorNxNy.ny, button: "right" });
            }
            return;
          }
          if (tpDragActiveRef.current && !dragLocked) {
            tpDragActiveRef.current = false;
            onSendInput({ type: "pointer", action: "up", nx: cursorNxNy.nx, ny: cursorNxNy.ny, button: "left" });
            return;
          }
          if (tracked) {
            const moved = Math.hypot(e.clientX - tracked.downX, e.clientY - tracked.downY);
            const dur = Date.now() - tracked.downAt;
            if (moved <= 6 && dur < 280) {
              if (dragLocked) {
                setDragLocked(false);
                onSendInput({ type: "pointer", action: "up", nx: cursorNxNy.nx, ny: cursorNxNy.ny, button: "left" });
                return;
              }
              const now = Date.now();
              const isDbl = now - tapHistoryRef.current.at < 280;
              tapHistoryRef.current = { at: now, nx: cursorNxNy.nx, ny: cursorNxNy.ny };
              const mods = mergeMods(e);
              triggerRipple(cursorNxNy.nx, cursorNxNy.ny, false);
              onSendInput({
                type: "pointer",
                action: isDbl ? "dblclick" : "click",
                nx: cursorNxNy.nx,
                ny: cursorNxNy.ny,
                button: "left",
                ...(mods.length ? { modifiers: mods } : {}),
              });
              if (latchedMods.length) onConsumeLatchedMods();
            }
          }
          return;
        }

        const btn = dragBtnRef.current;
        if (!btn) return;
        dragBtnRef.current = null;
        pendingMoveRef.current = null;
        const { nx, ny } = clientToNormalized(e.clientX, e.clientY);
        const mods = mergeMods(e);
        void onSendInput({
          type: "pointer",
          action: "up",
          nx,
          ny,
          button: btn,
          ...(mods.length ? { modifiers: mods } : {}),
        });
        if (latchedMods.length) onConsumeLatchedMods();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (controlMode === "trackpad") {
          triggerRipple(cursorNxNy.nx, cursorNxNy.ny, true);
          onSendInput({ type: "pointer", action: "click", nx: cursorNxNy.nx, ny: cursorNxNy.ny, button: "right" });
        }
      }}
      onWheel={(e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const step = e.deltaY < 0 ? 0.2 : -0.2;
          const next = Math.min(4, Math.max(1, Math.round((zoom + step) * 10) / 10));
          onZoomChange(next);
          return;
        }
        if (controlMode === "view" || !item.canInteract) return;
        e.preventDefault();
        const pt =
          controlMode === "trackpad"
            ? cursorNxNy
            : clientToNormalized(e.clientX, e.clientY);
        const mods = mergeMods(e);
        queueWheelInput(pt.nx, pt.ny, e.deltaX, e.deltaY, mods);
      }}
      onKeyDown={(e) => {
        if (controlMode === "view" || !item.canInteract) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
        e.preventDefault();
        const mods = mergeMods(e);
        if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") return;
        if (e.key.length === 1 && mods.length === 0) {
          onSendInput({ type: "text", text: e.key });
        } else {
          onSendInput({
            type: "key",
            key: e.key,
            action: "press",
            ...(mods.length ? { modifiers: mods } : {}),
          });
        }
        if (latchedMods.length) onConsumeLatchedMods();
      }}
      onPaste={(e) => {
        if (controlMode === "view" || !item.canInteract) return;
        const clipText = e.clipboardData.getData("text/plain");
        if (clipText) {
          e.preventDefault();
          onSendInput({ type: "text", text: clipText });
        }
      }}
    >
      {frame ? (
        <canvas ref={canvasRef} className="portal-stage-canvas" />
      ) : (
        placeholder
      )}

      {showOverlayCursor ? (
        <div
          className="portal-remote-cursor"
          style={{ left: `${cursorCssX}px`, top: `${cursorCssY}px` }}
          aria-hidden
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 3L19 12.2L12.1 13.7L8.6 20L5 3Z"
              fill="#ffffff"
              stroke="#18121e"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      ) : null}

      {ripple ? (
        <span
          key={ripple.id}
          className={`portal-click-ripple${ripple.right ? " is-right" : ""}`}
          style={{
            left: `${stageSize.width / 2 + pan.x + (drawLeft + ripple.nx * drawW - stageSize.width / 2) * z}px`,
            top: `${stageSize.height / 2 + pan.y + (drawTop + ripple.ny * drawH - stageSize.height / 2) * z}px`,
          }}
          aria-hidden
        />
      ) : null}

      {controlMode === "trackpad" && frame ? (
        <div
          className="portal-trackpad-bar"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <PocketButton
            size="sm"
            variant="soft"
            onClick={() => {
              triggerRipple(cursorNxNy.nx, cursorNxNy.ny, false);
              onSendInput({
                type: "pointer",
                action: "click",
                nx: cursorNxNy.nx,
                ny: cursorNxNy.ny,
                button: "left",
                ...(latchedMods.length ? { modifiers: latchedMods } : {}),
              });
              if (latchedMods.length) onConsumeLatchedMods();
            }}
          >
            左键
          </PocketButton>
          <PocketButton
            size="sm"
            variant="soft"
            onClick={() => {
              triggerRipple(cursorNxNy.nx, cursorNxNy.ny, true);
              onSendInput({
                type: "pointer",
                action: "click",
                nx: cursorNxNy.nx,
                ny: cursorNxNy.ny,
                button: "right",
                ...(latchedMods.length ? { modifiers: latchedMods } : {}),
              });
              if (latchedMods.length) onConsumeLatchedMods();
            }}
          >
            右键
          </PocketButton>
          <PocketButton
            size="sm"
            variant="ghost"
            onClick={() => {
              onSendInput({
                type: "pointer",
                action: "click",
                nx: cursorNxNy.nx,
                ny: cursorNxNy.ny,
                button: "middle",
              });
            }}
          >
            中键
          </PocketButton>
          <PocketButton
            size="sm"
            variant={dragLocked ? "primary" : "ghost"}
            onClick={() => {
              const next = !dragLocked;
              setDragLocked(next);
              onSendInput({
                type: "pointer",
                action: next ? "down" : "up",
                nx: cursorNxNy.nx,
                ny: cursorNxNy.ny,
                button: "left",
              });
            }}
          >
            {dragLocked ? <Lock size={12} /> : <Unlock size={12} />}
            <span>{dragLocked ? "松开拖拽" : "拖拽锁定"}</span>
          </PocketButton>
          {zoom > 1 ? (
            <PocketButton
              size="sm"
              variant="ghost"
              onClick={() => {
                onZoomChange(1);
                onPanChange({ x: 0, y: 0 });
              }}
            >
              <RotateCcw size={12} />
              <span>{Math.round(zoom * 100)}%</span>
            </PocketButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
