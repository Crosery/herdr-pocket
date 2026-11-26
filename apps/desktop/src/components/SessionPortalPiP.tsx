import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  Compass,
  ExternalLink,
  FileCode2,
  FolderSearch,
  Globe,
  Layers,
  LayoutGrid,
  Maximize2,
  MousePointer,
  Rows3,
  X,
} from "lucide-react";
import type { Agent, EgoSpacePhase, PortalItem } from "@herdr-pocket/protocol";
import { detectPlatform, isTauri } from "../lib/bridge";
import { useLocalHostDeviceId } from "../lib/fonts";
import { native } from "../lib/native";
import { rpcCall } from "../lib/relay";
import {
  capturePortalFrameOnce,
  closePortalSurface,
  computeContainedRect,
  filterVisiblePortalItems,
  isLoopbackPortalUrl,
  portalStore,
  resolvePortalTransport,
  sendPortalInput,
  subscribeAgentPortalUpdates,
  subscribePortalFrames,
} from "../lib/portalClient";
import { allAgents, liveStore, lookupAgentByKey, settingsStore } from "../lib/store";
import { openWebTab, shellStore } from "../shell/shellStore";
import { PocketButton } from "./PocketUI";

type ResizeDir = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

const PIP_MIN_W = 188;
const PIP_MAX_W = 880;
const PIP_MIN_H = 144;
const PIP_MAX_H = 680;
const PIP_MARGIN = 10;
const PIP_DEFAULT_W = 328;
const PIP_DEFAULT_H = 224;
const PIP_BITMAP_CACHE_MAX = 8;
const PIP_FAN_STEP_Y = 34;
const PIP_FAN_STEP_X = 8;
const PIP_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i;

interface PipBox {
  x: number | null;
  y: number | null;
  w: number;
  h: number;
}

function clampPipSize(w: number, h: number, parentW?: number, parentH?: number): { w: number; h: number } {
  const boundW = parentW && parentW > 0 ? parentW : typeof window !== "undefined" ? window.innerWidth : PIP_MAX_W;
  const boundH = parentH && parentH > 0 ? parentH : typeof window !== "undefined" ? window.innerHeight : PIP_MAX_H;
  const minW = Math.min(PIP_MIN_W, Math.max(116, boundW - PIP_MARGIN * 2));
  const minH = Math.min(PIP_MIN_H, Math.max(100, boundH - PIP_MARGIN * 2));
  const maxW = Math.min(PIP_MAX_W, Math.max(minW, boundW - PIP_MARGIN * 2));
  const maxH = Math.min(PIP_MAX_H, Math.max(minH, boundH - PIP_MARGIN * 2));
  return {
    w: Math.round(Math.max(minW, Math.min(maxW, w))),
    h: Math.round(Math.max(minH, Math.min(maxH, h))),
  };
}

function clampPipPos(x: number, y: number, w: number, h: number, parentW?: number, parentH?: number): { x: number; y: number } {
  const vw = parentW && parentW > 0 ? parentW : typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = parentH && parentH > 0 ? parentH : typeof window !== "undefined" ? window.innerHeight : 800;
  const maxX = Math.max(PIP_MARGIN, vw - w - PIP_MARGIN);
  const maxY = Math.max(PIP_MARGIN, vh - h - PIP_MARGIN);
  return {
    x: Math.round(Math.max(PIP_MARGIN, Math.min(maxX, x))),
    y: Math.round(Math.max(PIP_MARGIN, Math.min(maxY, y))),
  };
}

function egoPhaseMeta(phase: EgoSpacePhase): { label: string; cls: string } {
  switch (phase) {
    case "handoff":
      return { label: "等你接管", cls: "is-handoff" };
    case "user":
      return { label: "已移交", cls: "is-user" };
    case "finished":
      return { label: "已完成", cls: "is-idle" };
    case "idle":
      return { label: "空间就绪", cls: "is-idle" };
    default:
      return { label: "AI 操作中", cls: "is-running" };
  }
}

function portalIcon(item: Pick<PortalItem, "kind" | "egoSpace">) {
  if (item.egoSpace) return <Compass size={13} />;
  switch (item.kind) {
    case "browser":
      return <Globe size={13} />;
    case "window":
      return <AppWindow size={13} />;
    case "reveal":
      return <FolderSearch size={13} />;
    default:
      return <FileCode2 size={13} />;
  }
}

function putBitmapCache(
  cache: Map<string, ImageBitmap | HTMLImageElement>,
  portalId: string,
  src: ImageBitmap | HTMLImageElement,
): void {
  const prev = cache.get(portalId);
  if (prev && prev !== src && "close" in prev && typeof prev.close === "function") {
    prev.close();
  }
  cache.delete(portalId);
  cache.set(portalId, src);
  while (cache.size > PIP_BITMAP_CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    const evicted = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (evicted && "close" in evicted && typeof evicted.close === "function") {
      evicted.close();
    }
  }
}

interface PortalMiniCardProps {
  item: PortalItem;
  contextAgent?: Agent | null;
  visible: boolean;
  collapsed?: boolean;
  isActive: boolean;
  inDeckBack?: boolean;
  cardNumber?: number;
  stackCount?: number;
  fps?: number;
  maxWidth?: number;
  quality?: number;
  bitmapCacheRef: MutableRefObject<Map<string, ImageBitmap | HTMLImageElement>>;
  onStartHeaderDrag?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onFocusCard?: () => void;
  onToggleCollapse?: () => void;
  onQuickLayout?: (mode: "fan" | "tile" | "cascade") => void;
  onExpandPortal: (portalId: string, hostId: string) => void;
  onClosePortal: (portalId: string, hostId: string) => void;
}

function PortalMiniCard({
  item,
  contextAgent,
  visible,
  collapsed = false,
  isActive,
  inDeckBack = false,
  cardNumber,
  stackCount = 1,
  fps = 24,
  maxWidth = 960,
  quality = 58,
  bitmapCacheRef,
  onStartHeaderDrag,
  onFocusCard,
  onToggleCollapse,
  onQuickLayout,
  onExpandPortal,
  onClosePortal,
}: PortalMiniCardProps) {
  const frame = portalStore.use((s) => s.framesById[item.id]);
  const heartbeat = portalStore.use((s) => s.heartbeatsById[item.id]);
  const agentsMap = liveStore.use((s) => s.agents);
  liveStore.use((s) => s.direct);
  const localHostId = useLocalHostDeviceId();
  const isTauriApp = isTauri();
  const [, setTransportTick] = useState(0);

  // Never auto-enable mouse forwarding in floating PiP: same-host window portals would warp the user's own cursor away.
  const [directControl, setDirectControl] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState<{ portalId: string; memUrl?: string | null; srcDoc?: string } | null>(null);
  const [imgPreview, setImgPreview] = useState<{ portalId: string; dataUri: string } | null>(null);
  const [textPreview, setTextPreview] = useState<{ portalId: string; text: string } | null>(null);
  const [pipFps, setPipFps] = useState(0);

  const previewRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestSourceRef = useRef<ImageBitmap | HTMLImageElement | null>(null);
  const decodeSeqRef = useRef(0);
  const lastFrameSeqRef = useRef(-1);
  const fpsSamplesRef = useRef<number[]>([]);
  const pipDragBtnRef = useRef<"left" | "right" | "middle" | null>(null);
  const pipMoveInFlightRef = useRef(false);
  const pipLastMoveAtRef = useRef(0);
  const pipPendingMoveRef = useRef<{ nx: number; ny: number; action: "move" | "drag"; button: "left" | "right" | "middle" } | null>(null);
  const pipWheelInFlightRef = useRef(false);
  const pipPendingWheelRef = useRef<{ nx: number; ny: number; deltaX: number; deltaY: number } | null>(null);

  const resolvedAgentKey = item.agentKey ?? contextAgent?.key;
  const resolvedAgent = useMemo(() => {
    if (contextAgent && (!resolvedAgentKey || contextAgent.key === resolvedAgentKey)) return contextAgent;
    if (resolvedAgentKey) return lookupAgentByKey(agentsMap, resolvedAgentKey);
    return allAgents(agentsMap).find((a) => a.deviceId === item.hostId);
  }, [agentsMap, contextAgent, item.hostId, resolvedAgentKey]);

  useEffect(() => {
    if (!visible || collapsed || !item.canInteract) return;
    if (fps <= 0) {
      if (!bitmapCacheRef.current.has(item.id) && !portalStore.get().framesById[item.id]) {
        void capturePortalFrameOnce(item.hostId, item.id, { maxWidth, quality }).catch(() => {});
      }
      return;
    }
    return subscribePortalFrames(item.hostId, item.id, { fps, maxWidth, quality });
  }, [bitmapCacheRef, collapsed, fps, item.canInteract, item.hostId, item.id, item.windowId, maxWidth, quality, visible]);

  useEffect(() => {
    if (!visible || collapsed) return;
    const timer = setInterval(() => setTransportTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [collapsed, item.id, visible]);

  useEffect(() => {
    if (item.kind !== "html") {
      setHtmlPreview(null);
      return;
    }
    if (!visible || collapsed || !item.targetPath) return;
    if (htmlPreview?.portalId === item.id && (htmlPreview.memUrl || htmlPreview.srcDoc)) return;
    let alive = true;
    void rpcCall(item.hostId, "portal.bundleHtml", {
      ...(resolvedAgentKey ? { agent: resolvedAgentKey } : {}),
      path: item.targetPath,
      ...(resolvedAgent?.cwd ? { cwd: resolvedAgent.cwd } : {}),
    })
      .then(async (res) => {
        if (!alive || !res?.html) return;
        let memUrl: string | null = null;
        if (isTauri() && native.available()) {
          memUrl = await native.registerMemHtmlPreview(res.title || item.title || "preview.html", res.html).catch(() => null);
        }
        if (alive) setHtmlPreview({ portalId: item.id, memUrl, srcDoc: res.html });
      })
      .catch(() => {
        if (alive) setHtmlPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [collapsed, htmlPreview?.memUrl, htmlPreview?.portalId, htmlPreview?.srcDoc, item.hostId, item.id, item.kind, item.targetPath, item.title, resolvedAgent?.cwd, resolvedAgentKey, visible]);

  const isInlineImageFile =
    item.kind === "file" && Boolean(item.targetPath && (PIP_IMAGE_EXT_RE.test(item.targetPath) || item.mime?.startsWith("image/")));

  useEffect(() => {
    if (!isInlineImageFile) {
      setImgPreview(null);
      return;
    }
    if (!visible || collapsed || !item.targetPath) return;
    if (imgPreview?.portalId === item.id && imgPreview.dataUri) return;
    let alive = true;
    void rpcCall(item.hostId, "files.readChunk", {
      ...(resolvedAgentKey ? { agent: resolvedAgentKey } : {}),
      path: item.targetPath,
      offset: 0,
      length: 1536 * 1024,
    })
      .then((c) => {
        if (!alive || !c?.base64) return;
        setImgPreview({ portalId: item.id, dataUri: `data:${c.mime || "image/png"};base64,${c.base64}` });
      })
      .catch(() => {
        if (alive) setImgPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [collapsed, imgPreview?.dataUri, imgPreview?.portalId, isInlineImageFile, item.hostId, item.id, item.targetPath, resolvedAgentKey, visible]);

  const isInlineTextFile = item.kind === "file" && !isInlineImageFile;

  useEffect(() => {
    if (!isInlineTextFile) {
      setTextPreview(null);
      return;
    }
    if (!visible || collapsed || !item.targetPath) return;
    if (textPreview?.portalId === item.id && textPreview.text) return;
    let alive = true;
    void rpcCall(item.hostId, "files.read", {
      agent: resolvedAgentKey ?? "",
      path: item.targetPath,
    })
      .then((res) => {
        if (!alive || !res?.text) return;
        setTextPreview({ portalId: item.id, text: res.text.slice(0, 1200) });
      })
      .catch(() => {
        if (alive) setTextPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [collapsed, isInlineTextFile, item.hostId, item.id, item.targetPath, resolvedAgentKey, textPreview?.portalId, textPreview?.text, visible]);

  const isSameLocalHost = Boolean(isTauriApp && localHostId && item.hostId === localHostId);
  const needsMacScreenPerm = Boolean(
    isTauriApp &&
      detectPlatform() === "macos" &&
      isSameLocalHost &&
      item.streamError &&
      /屏幕录制|抓屏权限|screen_recording/i.test(item.streamError),
  );

  useEffect(() => {
    if (!needsMacScreenPerm) return;
    const retryIfGranted = async () => {
      const p = await native.getPermissions();
      if (p?.screenRecording === "granted") {
        void capturePortalFrameOnce(item.hostId, item.id);
      }
    };
    const off = native.onPermissionsChanged((p) => {
      if (p.screenRecording === "granted") {
        void capturePortalFrameOnce(item.hostId, item.id);
      }
    });
    const onFocus = () => {
      void retryIfGranted();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [item.hostId, item.id, needsMacScreenPerm]);

  const hasStreamFrame = Boolean(item.canInteract && frame && (frame.rawBytes?.byteLength || frame.data));

  const drawPipFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const src = latestSourceRef.current ?? bitmapCacheRef.current.get(item.id) ?? null;
    const previewEl = previewRef.current;
    if (!canvas || !src || !previewEl) return;
    const r = previewEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width || 312));
    const h = Math.max(1, Math.round(r.height || 184));
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
    const imgW = frame?.width ?? item.width ?? 1280;
    const imgH = frame?.height ?? item.height ?? 800;
    const { drawLeft, drawTop, drawW, drawH } = computeContainedRect(w, h, imgW, imgH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, drawLeft, drawTop, drawW, drawH);
  }, [bitmapCacheRef, frame?.height, frame?.width, item.height, item.id, item.width]);

  useEffect(() => {
    const cached = bitmapCacheRef.current.get(item.id) ?? null;
    latestSourceRef.current = cached;
    fpsSamplesRef.current = [];
    lastFrameSeqRef.current = -1;
    setPipFps(0);
    if (cached) drawPipFrame();
  }, [bitmapCacheRef, drawPipFrame, item.id]);

  useEffect(() => {
    drawPipFrame();
  }, [drawPipFrame]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => drawPipFrame());
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed, drawPipFrame, item.id]);

  useEffect(() => {
    if (!visible || collapsed || !item.canInteract) {
      fpsSamplesRef.current = [];
      setPipFps(0);
      return;
    }
    const timer = setInterval(() => {
      const cutoff = Date.now() - 1000;
      const kept = fpsSamplesRef.current.filter((t) => t >= cutoff);
      fpsSamplesRef.current = kept;
      setPipFps((prev) => (prev === kept.length ? prev : kept.length));
    }, 500);
    return () => clearInterval(timer);
  }, [collapsed, item.canInteract, visible]);

  useEffect(() => {
    const hasBinary = Boolean(frame?.rawBytes && frame.rawBytes.byteLength > 0);
    const hasBase64 = Boolean(frame?.data);
    if (!hasStreamFrame || !frame || (!hasBinary && !hasBase64)) {
      return;
    }

    if (frame.seq !== lastFrameSeqRef.current) {
      lastFrameSeqRef.current = frame.seq;
      const now = Date.now();
      const cutoff = now - 1000;
      const kept = fpsSamplesRef.current.filter((t) => t >= cutoff);
      kept.push(now);
      fpsSamplesRef.current = kept;
      setPipFps(kept.length);
    }

    const seqToken = ++decodeSeqRef.current;
    let cancelled = false;
    const mime = frame.mime || "image/jpeg";

    const commitSource = (next: ImageBitmap | HTMLImageElement) => {
      if (cancelled || seqToken !== decodeSeqRef.current) {
        if ("close" in next && typeof next.close === "function") next.close();
        return;
      }
      latestSourceRef.current = next;
      putBitmapCache(bitmapCacheRef.current, item.id, next);
      drawPipFrame();
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
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      } catch {
        // fall through
      }
    }

    const img = new Image();
    let revokeUrl: string | null = null;
    img.onload = () => {
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
      commitSource(img);
    };
    img.onerror = () => {
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
    if (hasBinary && frame.rawBytes) {
      revokeUrl = URL.createObjectURL(new Blob([frame.rawBytes as Uint8Array<ArrayBuffer>], { type: mime }));
      img.src = revokeUrl;
    } else {
      img.src = `data:${mime};base64,${frame.data}`;
    }
    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [bitmapCacheRef, drawPipFrame, frame, hasStreamFrame, item.id]);

  const activeHtml = htmlPreview?.portalId === item.id ? htmlPreview : null;
  const activeImg = imgPreview?.portalId === item.id ? imgPreview : null;
  const activeText = textPreview?.portalId === item.id ? textPreview : null;
  const safeExternalUrl =
    item.url && /^https?:\/\//i.test(item.url) && (isSameLocalHost || !isLoopbackPortalUrl(item.url))
      ? item.url
      : null;
  const openUrl = safeExternalUrl ?? (activeHtml?.memUrl ? activeHtml.memUrl : null);
  const allowDirectControlToggle = Boolean(item.canInteract && !(isSameLocalHost && item.kind === "window"));
  const canDirectControl = Boolean(allowDirectControlToggle && directControl && hasStreamFrame && !item.streamError && !needsMacScreenPerm);
  const transport = resolvePortalTransport(item.hostId, localHostId, frame);
  const p2pLabel = pipFps >= 2 && !heartbeat?.idle ? `${transport.label} · ${pipFps}fps` : transport.label;
  const egoSpace = item.egoSpace;
  const egoPhase = egoSpace ? egoPhaseMeta(egoSpace.phase) : null;
  const egoSummaryText = egoSpace
    ? [egoSpace.activeTabTitle, egoSpace.lastAction].filter(Boolean).join(" · ") || item.url || "EG 浏览器空间"
    : "";

  const clientToPipNormalized = (clientX: number, clientY: number) => {
    const el = previewRef.current;
    if (!el) return { nx: 0.5, ny: 0.5 };
    const r = el.getBoundingClientRect();
    const imgW = frame?.width ?? item.width ?? 1280;
    const imgH = frame?.height ?? item.height ?? 800;
    const { drawLeft, drawTop, drawW, drawH } = computeContainedRect(r.width, r.height, imgW, imgH);
    const nx = Math.min(1, Math.max(0, (clientX - r.left - drawLeft) / Math.max(1, drawW)));
    const ny = Math.min(1, Math.max(0, (clientY - r.top - drawTop) / Math.max(1, drawH)));
    return { nx, ny };
  };

  const flushPipMove = () => {
    if (pipMoveInFlightRef.current) return;
    const pend = pipPendingMoveRef.current;
    if (!pend) return;
    const now = Date.now();
    const minInterval = transport.isDirect ? 12 : 24;
    if (now - pipLastMoveAtRef.current < minInterval) {
      setTimeout(flushPipMove, minInterval);
      return;
    }
    pipLastMoveAtRef.current = now;
    pipPendingMoveRef.current = null;
    pipMoveInFlightRef.current = true;
    void sendPortalInput(item.hostId, item.id, {
      type: "pointer",
      action: pend.action,
      nx: pend.nx,
      ny: pend.ny,
      button: pend.button,
    })
      .catch(() => {})
      .finally(() => {
        pipMoveInFlightRef.current = false;
        if (pipPendingMoveRef.current) flushPipMove();
      });
  };

  const flushPipWheel = () => {
    if (pipWheelInFlightRef.current) return;
    const pend = pipPendingWheelRef.current;
    if (!pend || (pend.deltaX === 0 && pend.deltaY === 0)) {
      pipPendingWheelRef.current = null;
      return;
    }
    pipPendingWheelRef.current = null;
    pipWheelInFlightRef.current = true;
    void sendPortalInput(item.hostId, item.id, {
      type: "wheel",
      nx: pend.nx,
      ny: pend.ny,
      deltaX: pend.deltaX,
      deltaY: pend.deltaY,
    })
      .catch(() => {})
      .finally(() => {
        pipWheelInFlightRef.current = false;
        if (pipPendingWheelRef.current) flushPipWheel();
      });
  };

  return (
    <div
      className={`session-portal-pip-card-shell${isActive ? " is-active" : ""}${collapsed ? " is-collapsed" : ""}`}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        onFocusCard?.();
        if (!canDirectControl || !(e.target as HTMLElement).closest(".session-portal-pip-preview")) {
          e.preventDefault();
        }
      }}
    >
      <div
        className={`session-portal-pip-head${onStartHeaderDrag ? " is-draggable" : ""}`}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          onFocusCard?.();
          onStartHeaderDrag?.(e);
        }}
      >
        {cardNumber !== undefined ? <span className="session-portal-card-num">{cardNumber}</span> : null}
        <span className="session-portal-pip-ic">{portalIcon(item)}</span>
        <span className="session-portal-pip-title truncate" title={item.title}>
          {egoSpace ? egoSpace.spaceName : item.title}
        </span>
        {egoPhase ? (
          <span className={`session-portal-ego-phase ${egoPhase.cls}`}>{egoPhase.label}</span>
        ) : null}
        {collapsed && stackCount > 1 ? (
          <button
            type="button"
            className="session-portal-pip-count-badge"
            title={`展开全部 ${stackCount} 个悬浮窗口`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse?.();
            }}
          >
            共 {stackCount} 个
          </button>
        ) : !egoPhase || hasStreamFrame ? (
          <span className="session-portal-pip-badge">{p2pLabel}</span>
        ) : null}
        {collapsed && stackCount > 1 && onQuickLayout ? (
          <button
            type="button"
            className="session-portal-pip-btn"
            title="平铺展开多窗口"
            aria-label="平铺展开多窗口"
            onClick={(e) => {
              e.stopPropagation();
              onQuickLayout("tile");
            }}
          >
            <LayoutGrid size={12} />
          </button>
        ) : null}
        {openUrl && !collapsed ? (
          <button
            type="button"
            className="session-portal-pip-btn"
            title="在内置浏览器标签打开"
            aria-label="在内置浏览器标签打开"
            onClick={(e) => {
              e.stopPropagation();
              openWebTab(openUrl, item.title, { spaceKey: shellStore.get().selectedSpace });
            }}
          >
            <ExternalLink size={12} />
          </button>
        ) : null}
        {onToggleCollapse ? (
          <button
            type="button"
            className="session-portal-pip-btn"
            title={collapsed ? "展开小窗预览" : "收起成胶囊"}
            aria-label={collapsed ? "展开小窗预览" : "收起成胶囊"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse();
            }}
          >
            {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </button>
        ) : null}
        {allowDirectControlToggle && !collapsed && !inDeckBack ? (
          <button
            type="button"
            className={`session-portal-pip-btn${directControl ? " is-active" : ""}`}
            title={directControl ? "小窗直控已开启（点击切换为点击放大）" : "开启小窗直控（拖拽控制画面，默认关闭）"}
            aria-label={directControl ? "关闭小窗直控" : "开启小窗直控"}
            aria-pressed={directControl}
            onClick={(e) => {
              e.stopPropagation();
              setDirectControl((v) => !v);
            }}
          >
            <MousePointer size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="session-portal-pip-btn session-portal-pip-expand-btn"
          title="放大进入交互操作"
          aria-label="放大进入交互操作"
          onClick={(e) => {
            e.stopPropagation();
            onExpandPortal(item.id, item.hostId);
          }}
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          className="session-portal-pip-btn"
          title="关闭浮窗"
          aria-label="关闭浮窗"
          onClick={(e) => {
            e.stopPropagation();
            onClosePortal(item.id, item.hostId);
          }}
        >
          <X size={13} />
        </button>
      </div>

      {!collapsed && egoSpace ? (
        <div className="session-portal-ego-strip">
          {(egoSpace.spaceId !== undefined || egoSpace.pageLabel || (egoSpace.tabCount ?? 0) > 1) ? (
            <span className="session-portal-ego-tags">
              {egoSpace.spaceId !== undefined ? (
                <span className="session-portal-ego-tag mono">#{egoSpace.spaceId}</span>
              ) : null}
              {egoSpace.pageLabel ? (
                <span className="session-portal-ego-tag mono">{egoSpace.pageLabel}</span>
              ) : null}
              {egoSpace.tabCount && egoSpace.tabCount > 1 ? (
                <span className="session-portal-ego-tag">{egoSpace.tabCount} 标签</span>
              ) : null}
            </span>
          ) : null}
          <span className="session-portal-ego-meta truncate" title={egoSummaryText}>
            {egoSummaryText}
          </span>
        </div>
      ) : null}

      {!collapsed ? (
        <div
          ref={previewRef}
          role={canDirectControl ? "application" : "button"}
          tabIndex={0}
          className={`session-portal-pip-preview${canDirectControl ? " is-interactive" : ""}`}
          onClick={() => {
            onFocusCard?.();
            if (!canDirectControl && !inDeckBack) onExpandPortal(item.id, item.hostId);
          }}
          onDoubleClick={() => {
            if (inDeckBack) onExpandPortal(item.id, item.hostId);
          }}
          onPointerDown={(e) => {
            onFocusCard?.();
            if (!canDirectControl) return;
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            previewRef.current?.focus();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            const btn: "left" | "right" | "middle" =
              e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
            pipDragBtnRef.current = btn;
            pipPendingMoveRef.current = null;
            const { nx, ny } = clientToPipNormalized(e.clientX, e.clientY);
            void sendPortalInput(item.hostId, item.id, {
              type: "pointer",
              action: "down",
              nx,
              ny,
              button: btn,
            }).catch(() => {});
          }}
          onPointerMove={(e) => {
            if (!canDirectControl || !pipDragBtnRef.current) return;
            const { nx, ny } = clientToPipNormalized(e.clientX, e.clientY);
            pipPendingMoveRef.current = {
              nx,
              ny,
              action: "drag",
              button: pipDragBtnRef.current,
            };
            flushPipMove();
          }}
          onPointerUp={(e) => {
            if (!canDirectControl) return;
            const btn = pipDragBtnRef.current;
            if (!btn) return;
            pipDragBtnRef.current = null;
            pipPendingMoveRef.current = null;
            const { nx, ny } = clientToPipNormalized(e.clientX, e.clientY);
            void sendPortalInput(item.hostId, item.id, {
              type: "pointer",
              action: "up",
              nx,
              ny,
              button: btn,
            }).catch(() => {});
          }}
          onContextMenu={(e) => {
            if (!canDirectControl) return;
            e.preventDefault();
            const { nx, ny } = clientToPipNormalized(e.clientX, e.clientY);
            void sendPortalInput(item.hostId, item.id, {
              type: "pointer",
              action: "click",
              nx,
              ny,
              button: "right",
            }).catch(() => {});
          }}
          onWheel={(e) => {
            if (!canDirectControl) return;
            e.preventDefault();
            const { nx, ny } = clientToPipNormalized(e.clientX, e.clientY);
            const prev = pipPendingWheelRef.current;
            if (prev) {
              prev.nx = nx;
              prev.ny = ny;
              prev.deltaX += e.deltaX;
              prev.deltaY += e.deltaY;
            } else {
              pipPendingWheelRef.current = { nx, ny, deltaX: e.deltaX, deltaY: e.deltaY };
            }
            flushPipWheel();
          }}
          onKeyDown={(e) => {
            if (canDirectControl) {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
              e.preventDefault();
              if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") return;
              const mods: string[] = [];
              if (e.metaKey) mods.push("meta");
              if (e.ctrlKey) mods.push("ctrl");
              if (e.altKey) mods.push("alt");
              if (e.shiftKey) mods.push("shift");
              if (e.key.length === 1 && mods.length === 0) {
                void sendPortalInput(item.hostId, item.id, { type: "text", text: e.key }).catch(() => {});
              } else {
                void sendPortalInput(item.hostId, item.id, {
                  type: "key",
                  key: e.key,
                  action: "press",
                  ...(mods.length ? { modifiers: mods } : {}),
                }).catch(() => {});
              }
              return;
            }
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onExpandPortal(item.id, item.hostId);
            }
          }}
        >
          {hasStreamFrame ? (
            <canvas ref={canvasRef} aria-label={item.title} className="session-portal-pip-img" />
          ) : activeImg ? (
            <img
              src={activeImg.dataUri}
              alt={item.title}
              className="session-portal-pip-img"
              draggable={false}
            />
          ) : activeHtml && (activeHtml.memUrl || activeHtml.srcDoc) ? (
            <div className="session-portal-pip-framewrap">
              <iframe
                title={item.title}
                className="session-portal-pip-iframe"
                sandbox="allow-scripts"
                tabIndex={-1}
                {...(activeHtml.memUrl ? { src: activeHtml.memUrl } : { srcDoc: activeHtml.srcDoc })}
              />
            </div>
          ) : (
            <div className={`session-portal-pip-card${needsMacScreenPerm ? " is-perm" : ""}`}>
              <div className="session-portal-pip-kind">
                {portalIcon(item)}
                <span>
                  {item.streamError
                    ? "画面捕获受限"
                    : egoSpace
                      ? "EG 浏览器空间状态"
                      : item.kind === "browser"
                        ? "远程浏览器画面"
                        : item.kind === "window"
                          ? "远程桌面窗口"
                          : item.kind === "reveal"
                            ? "已定位到远程目录"
                            : item.kind === "html"
                              ? "P2P HTML 应用预览"
                              : "P2P 跨端文件预览"}
                </span>
              </div>
              <div
                className={`session-portal-pip-sub${item.streamError ? " is-err" : " mono truncate"}`}
                title={item.streamError || item.subtitle || item.url || item.targetPath || item.title}
              >
                {item.streamError
                  ? item.streamError
                  : egoSpace
                    ? egoSpace.activeTabTitle || item.url || egoSpace.spaceName
                    : item.highlightName || item.subtitle || item.url || item.targetPath || item.title}
              </div>
              {egoSpace && !item.streamError ? (
                <div className="session-portal-ego-card-row">
                  {egoSpace.lastAction ? (
                    <span className="session-portal-ego-action truncate">{egoSpace.lastAction}</span>
                  ) : null}
                  {egoSpace.profileName ? (
                    <span className="session-portal-ego-tag">{egoSpace.profileName}</span>
                  ) : null}
                </div>
              ) : null}
              {activeText && !item.streamError ? (
                <pre className="session-portal-pip-text mono">{activeText.text}</pre>
              ) : null}
              {needsMacScreenPerm ? (
                <div className="session-portal-pip-card-act">
                  <PocketButton
                    size="sm"
                    variant="primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      void native.openPermissionSettings("screenRecording", true);
                    }}
                  >
                    <ExternalLink size={12} />
                    <span>去授权屏幕录制</span>
                  </PocketButton>
                </div>
              ) : null}
            </div>
          )}
          {needsMacScreenPerm ? null : canDirectControl ? (
            <button
              type="button"
              className="session-portal-pip-expand-chip"
              onClick={(e) => {
                e.stopPropagation();
                onExpandPortal(item.id, item.hostId);
              }}
            >
              放大
            </button>
          ) : (
            <span className="session-portal-pip-overlay">
              {inDeckBack
                ? "点击置顶查看 · 双击放大"
                : egoSpace && !item.canInteract
                  ? "点击查看空间详情"
                  : "点击放大并交互操作"}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SessionPortalPiP({
  agent,
  hostIds,
  agentKeys,
  visible = true,
  mode = "chat",
  onExpandPortal,
}: {
  agent?: Agent | null;
  hostIds?: string[];
  agentKeys?: string[];
  visible?: boolean;
  mode?: "chat" | "term";
  onExpandPortal: (portalId: string, hostId: string) => void;
}) {
  const itemsById = portalStore.use((s) => s.itemsById);
  const dismissedIds = portalStore.use((s) => s.dismissedIds);
  const manualIds = portalStore.use((s) => s.manualIds);
  const openSeqById = portalStore.use((s) => s.openSeqById);
  const openedAtById = portalStore.use((s) => s.openedAtById);
  const localHostId = useLocalHostDeviceId();
  const isTauriApp = isTauri();

  const effectiveHostIds = useMemo(() => {
    const set = new Set<string>();
    if (agent?.deviceId) set.add(agent.deviceId);
    if (hostIds) {
      for (const hid of hostIds) {
        if (hid) set.add(hid);
      }
    }
    return [...set];
  }, [agent?.deviceId, hostIds]);

  const effectiveAgentKeys = useMemo(() => {
    const set = new Set<string>();
    if (agentKeys) {
      for (const k of agentKeys) {
        if (k) set.add(k);
      }
    } else if (agent?.key) {
      set.add(agent.key);
    }
    return [...set];
  }, [agent?.key, agentKeys]);

  const items = useMemo(() => {
    if (effectiveHostIds.length === 0) return [];
    const sortStable = (arr: PortalItem[]) =>
      arr.sort(
        (a, b) =>
          (openedAtById[b.id] ?? b.updatedAt) - (openedAtById[a.id] ?? a.updatedAt) ||
          a.id.localeCompare(b.id),
      );

    if (effectiveHostIds.length === 1 && effectiveAgentKeys.length <= 1 && agent) {
      return filterVisiblePortalItems({
        itemsById,
        dismissedIds,
        manualIds,
        openedAtById,
        agent,
        isTauriApp,
        localHostId,
      });
    }

    if (effectiveAgentKeys.length === 0) return [];
    const matched = new Map<string, PortalItem>();
    for (const hid of effectiveHostIds) {
      for (const aKey of effectiveAgentKeys) {
        for (const it of filterVisiblePortalItems({
          itemsById,
          dismissedIds,
          manualIds,
          openedAtById,
          agent: { deviceId: hid, key: aKey },
          isTauriApp,
          localHostId,
        })) {
          matched.set(it.id, it);
        }
      }
    }
    return sortStable([...matched.values()]);
  }, [agent, dismissedIds, effectiveAgentKeys, effectiveHostIds, isTauriApp, itemsById, localHostId, manualIds, openedAtById]);

  const preferredMode = settingsStore.use((s) => s.portalDisplayMode);
  const initialLayout: "fan" | "tile" | "cascade" = preferredMode === "collapsed" ? "fan" : preferredMode;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredBackIdx, setHoveredBackIdx] = useState<number | null>(null);
  const [stackLayout, setStackLayout] = useState<"fan" | "tile" | "cascade">(initialLayout);
  const [collapsed, setCollapsed] = useState<boolean>(preferredMode === "collapsed");
  const [box, setBox] = useState<PipBox>({ x: null, y: null, w: PIP_DEFAULT_W, h: PIP_DEFAULT_H });
  const [parentDims, setParentDims] = useState<{ w: number; h: number } | null>(null);
  const [gesture, setGesture] = useState<"idle" | "drag" | "resize">("idle");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bitmapCacheRef = useRef<Map<string, ImageBitmap | HTMLImageElement>>(new Map());
  const seenOpenSeqRef = useRef<Map<string, number>>(new Map());
  const userExpandedRef = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hostListKey = effectiveHostIds.join("\0");
  const primaryAgentKey = agent?.key ?? effectiveAgentKeys[0];

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const scheduleHoverIdx = (nextIdx: number | null) => {
    clearHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      setHoveredBackIdx(nextIdx);
    }, 65);
  };

  useEffect(() => {
    clearHoverTimer();
    setHoveredBackIdx(null);
  }, [collapsed, items.length, selectedId, stackLayout]);

  useEffect(() => () => clearHoverTimer(), []);

  useEffect(() => {
    userExpandedRef.current = false;
    if (preferredMode === "collapsed") {
      setCollapsed(true);
    } else {
      setCollapsed(false);
      setStackLayout(preferredMode);
    }
  }, [preferredMode]);

  useEffect(() => {
    if (!visible || !hostListKey) return;
    const stops = hostListKey.split("\0").filter(Boolean).map((hid) =>
      subscribeAgentPortalUpdates(hid, primaryAgentKey ?? ""),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [hostListKey, primaryAgentKey, visible]);

  useEffect(() => {
    const liveIds = new Set(items.map((it) => it.id));
    for (const prevId of [...bitmapCacheRef.current.keys()]) {
      if (!liveIds.has(prevId)) {
        const cached = bitmapCacheRef.current.get(prevId);
        bitmapCacheRef.current.delete(prevId);
        if (cached && "close" in cached && typeof cached.close === "function") cached.close();
      }
    }
    for (const seenKey of [...seenOpenSeqRef.current.keys()]) {
      if (!liveIds.has(seenKey)) seenOpenSeqRef.current.delete(seenKey);
    }

    let promotedId: string | null = null;
    let promotedTs = -1;
    for (const it of items) {
      const seq = openSeqById[it.id] ?? 0;
      const seenSeq = seenOpenSeqRef.current.get(it.id) ?? 0;
      if (seq > seenSeq) {
        seenOpenSeqRef.current.set(it.id, seq);
        const ts = openedAtById[it.id] ?? it.updatedAt;
        if (ts >= promotedTs) {
          promotedTs = ts;
          promotedId = it.id;
        }
      } else if (!seenOpenSeqRef.current.has(it.id)) {
        seenOpenSeqRef.current.set(it.id, seq);
      }
    }

    if (promotedId) {
      setSelectedId(promotedId);
      // Respect "默认收起": stay folded in capsule until user explicitly expands it.
      if (preferredMode !== "collapsed" || userExpandedRef.current) {
        setCollapsed(false);
      }
    } else if (selectedId && !liveIds.has(selectedId)) {
      setSelectedId(items[0]?.id ?? null);
    }
  }, [items, openSeqById, openedAtById, preferredMode, selectedId]);

  useEffect(() => {
    return () => {
      for (const cached of bitmapCacheRef.current.values()) {
        if ("close" in cached && typeof cached.close === "function") cached.close();
      }
      bitmapCacheRef.current.clear();
    };
  }, []);

  const hasRenderedStage = visible && items.length > 0;
  useEffect(() => {
    if (!hasRenderedStage) return;
    const syncToParent = () => {
      const parent = rootRef.current?.offsetParent as HTMLElement | null;
      const pw = parent?.clientWidth;
      const ph = parent?.clientHeight;
      if (pw && ph) {
        setParentDims((prev) => (prev && prev.w === pw && prev.h === ph ? prev : { w: pw, h: ph }));
      }
      setBox((prev) => {
        if (prev.x === null || prev.y === null) return prev;
        const sz = clampPipSize(prev.w, prev.h, pw, ph);
        const pos = clampPipPos(prev.x, prev.y, sz.w, collapsed ? 44 : sz.h, pw, ph);
        return pos.x === prev.x && pos.y === prev.y ? prev : { ...prev, ...pos };
      });
    };
    syncToParent();
    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    const ro = typeof ResizeObserver !== "undefined" && parent ? new ResizeObserver(syncToParent) : null;
    if (ro && parent) ro.observe(parent);
    window.addEventListener("resize", syncToParent);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", syncToParent);
    };
  }, [collapsed, hasRenderedStage]);

  const current = useMemo(
    () => (selectedId ? items.find((i) => i.id === selectedId) : undefined) ?? items[0],
    [items, selectedId],
  );

  const tileCards = useMemo(() => {
    if (items.length <= 4) return items;
    const top = items.slice(0, 4);
    if (current && !top.some((i) => i.id === current.id)) {
      return [current, ...top.slice(0, 3)];
    }
    return top;
  }, [current, items]);

  const cascadeCards = useMemo(() => {
    if (items.length <= 1) return items;
    const top = items.slice(0, 3);
    if (current && !top.some((i) => i.id === current.id)) {
      return [current, ...top.slice(0, 2)];
    }
    return top;
  }, [current, items]);

  if (!visible || !items.length || !current) return null;

  const isMulti = items.length > 1;
  const isTile = !collapsed && stackLayout === "tile";
  const isCascade = isMulti && !collapsed && stackLayout === "cascade";
  const backItems = !isTile && !isCascade && isMulti && !collapsed ? items.filter((i) => i.id !== current.id).slice(0, 3) : [];
  const cardIndexOf = (id: string) => items.findIndex((i) => i.id === id) + 1;

  const setExpandedLayout = (next: "fan" | "tile" | "cascade") => {
    clearHoverTimer();
    setHoveredBackIdx(null);
    userExpandedRef.current = true;
    setStackLayout(next);
    setCollapsed(false);
  };

  const setFolded = (nextCollapsed: boolean) => {
    clearHoverTimer();
    setHoveredBackIdx(null);
    userExpandedRef.current = !nextCollapsed;
    setCollapsed(nextCollapsed);
  };

  const currentAnchorRect = () => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (el && parent) {
      const r = el.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      const sz = clampPipSize(box.w, box.h, parent.clientWidth, parent.clientHeight);
      return {
        x: box.x ?? Math.round(r.left - pr.left),
        y: box.y ?? Math.round(r.top - pr.top),
        w: sz.w,
        h: sz.h,
        parentW: parent.clientWidth,
        parentH: parent.clientHeight,
      };
    }
    return {
      x: box.x ?? Math.max(PIP_MARGIN, (typeof window !== "undefined" ? window.innerWidth : 1000) - box.w - 16),
      y: box.y ?? PIP_MARGIN,
      w: box.w,
      h: box.h,
      parentW: typeof window !== "undefined" ? window.innerWidth : 1200,
      parentH: typeof window !== "undefined" ? window.innerHeight : 800,
    };
  };

  const startMoveDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = currentAnchorRect();
    let moved = false;
    setGesture("drag");
    e.currentTarget.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      const h = collapsed ? 44 : orig.h;
      const maxX = Math.max(PIP_MARGIN, orig.parentW - orig.w - PIP_MARGIN);
      const maxY = Math.max(PIP_MARGIN, orig.parentH - h - PIP_MARGIN);
      setBox((prev) => ({
        ...prev,
        x: Math.round(Math.max(PIP_MARGIN, Math.min(maxX, orig.x + dx))),
        y: Math.round(Math.max(PIP_MARGIN, Math.min(maxY, orig.y + dy))),
      }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setGesture("idle");
      if (!moved) {
        if (collapsed) {
          setFolded(false);
        } else {
          onExpandPortal(current.id, current.hostId);
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const startResize = (dir: ResizeDir) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || collapsed || isCascade || isTile) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = currentAnchorRect();
    const origRight = orig.x + orig.w;
    const origBottom = orig.y + orig.h;
    setGesture("resize");
    e.currentTarget.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let nextX = orig.x;
      let nextY = orig.y;
      let nextW = orig.w;
      let nextH = orig.h;

      if (dir.includes("e")) nextW = orig.w + dx;
      if (dir.includes("s")) nextH = orig.h + dy;
      if (dir.includes("w")) {
        nextW = orig.w - dx;
        nextX = origRight - Math.max(PIP_MIN_W, Math.min(PIP_MAX_W, nextW));
      }
      if (dir.includes("n")) {
        nextH = orig.h - dy;
        nextY = origBottom - Math.max(PIP_MIN_H, Math.min(PIP_MAX_H, nextH));
      }
      const clampedSz = clampPipSize(nextW, nextH, orig.parentW, orig.parentH);
      if (dir.includes("w")) nextX = origRight - clampedSz.w;
      if (dir.includes("n")) nextY = origBottom - clampedSz.h;
      const maxX = Math.max(PIP_MARGIN, orig.parentW - clampedSz.w - PIP_MARGIN);
      const maxY = Math.max(PIP_MARGIN, orig.parentH - clampedSz.h - PIP_MARGIN);
      setBox({
        w: clampedSz.w,
        h: clampedSz.h,
        x: Math.round(Math.max(PIP_MARGIN, Math.min(maxX, nextX))),
        y: Math.round(Math.max(PIP_MARGIN, Math.min(maxY, nextY))),
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setGesture("idle");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const effectiveSz = parentDims ? clampPipSize(box.w, box.h, parentDims.w, parentDims.h) : { w: box.w, h: box.h };
  const fanPadY = backItems.length * PIP_FAN_STEP_Y;
  const fanPadX = backItems.length * PIP_FAN_STEP_X;
  const fanPeekExpandY = Math.min(128, Math.max(84, Math.round(effectiveSz.h * 0.56)));
  const isNarrowPane = Boolean(parentDims && parentDims.w < 430);
  const isCompactPane = Boolean(parentDims && parentDims.w < 240);
  const compactCls = isCompactPane ? " is-compact-pane" : "";
  const sizeClamp: React.CSSProperties = { maxWidth: "calc(100% - 20px)", maxHeight: "calc(100% - 20px)" };
  const outerExtraH = (!collapsed && isMulti ? 40 : 0) + fanPadY;
  const posStyle: React.CSSProperties =
    isCascade || isTile
      ? { ...sizeClamp }
      : box.x !== null && box.y !== null
        ? {
            left: box.x,
            top: box.y,
            right: "auto",
            bottom: "auto",
            ...sizeClamp,
            ...(collapsed ? {} : { width: effectiveSz.w + fanPadX, height: effectiveSz.h + outerExtraH }),
          }
        : collapsed
          ? sizeClamp
          : { width: effectiveSz.w + fanPadX, height: effectiveSz.h + outerExtraH, ...sizeClamp };

  const dirs: ResizeDir[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

  const renderModeButtons = (activeMode: "fan" | "tile" | "cascade") => (
    <div className="session-portal-mode-acts" role="group" aria-label="多窗口排列方式">
      <button
        type="button"
        className={`session-portal-stack-toggle${activeMode === "fan" ? " is-active" : ""}`}
        title="1·2·3·4 叠牌露头"
        aria-label="叠牌露头"
        aria-pressed={activeMode === "fan"}
        onClick={() => setExpandedLayout("fan")}
      >
        <Layers size={11} />
        <span>叠牌</span>
      </button>
      <button
        type="button"
        className={`session-portal-stack-toggle${activeMode === "tile" ? " is-active" : ""}`}
        title="多窗口平铺展开"
        aria-label="平铺展开"
        aria-pressed={activeMode === "tile"}
        onClick={() => setExpandedLayout("tile")}
      >
        <LayoutGrid size={11} />
        <span>平铺</span>
      </button>
      <button
        type="button"
        className={`session-portal-stack-toggle${activeMode === "cascade" ? " is-active" : ""}`}
        title="纵向叠列对比"
        aria-label="纵向叠列"
        aria-pressed={activeMode === "cascade"}
        onClick={() => setExpandedLayout("cascade")}
      >
        <Rows3 size={11} />
        <span>叠列</span>
      </button>
    </div>
  );

  const renderStackBar = (activeMode: "fan" | "tile" | "cascade", showModeControls = true) => {
    if (activeMode === "fan" && items.length <= 4) {
      return (
        <div className="session-portal-stack-bar is-compact" role="region" aria-label="多窗口叠牌控制">
          <span className="session-portal-cascade-label">
            <Layers size={12} />
            <span>共 {items.length} 个窗口 · 悬停露头</span>
          </span>
          <div className="session-portal-cascade-acts">
            {showModeControls ? renderModeButtons("fan") : null}
            <button
              type="button"
              className="session-portal-pip-btn"
              title="收起成胶囊"
              aria-label="收起成胶囊"
              onClick={() => setFolded(true)}
            >
              <ChevronUp size={13} />
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="session-portal-stack-bar" role="tablist" aria-label="多窗口切换">
        <div className="session-portal-stack-pills">
          {items.map((it, idx) => {
            const active = it.id === current.id;
            return (
              <div key={it.id} className={`session-portal-stack-pill${active ? " is-active" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="session-portal-stack-pill-btn"
                  title={it.title}
                  onClick={() => {
                    setSelectedId(it.id);
                    setHoveredBackIdx(null);
                    setFolded(false);
                  }}
                >
                  <span className="session-portal-card-num is-mini">{idx + 1}</span>
                  <span className="session-portal-stack-pill-ic">{portalIcon(it)}</span>
                  <span className="truncate">{it.title}</span>
                </button>
                <button
                  type="button"
                  className="session-portal-stack-pill-close"
                  aria-label={`关闭 ${it.title}`}
                  title={`关闭 ${it.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void closePortalSurface(it.hostId, it.id);
                  }}
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
        {showModeControls ? renderModeButtons(activeMode) : null}
      </div>
    );
  };

  if (isTile) {
    return (
      <div
        ref={rootRef}
        className={`session-portal-pip is-tile${mode === "term" ? " in-term" : ""}${compactCls}`}
        style={posStyle}
        role="region"
        aria-label={`跨端多窗口平铺 · 共 ${items.length} 个`}
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest(".session-portal-pip-preview")) {
            e.preventDefault();
          }
        }}
      >
        <div className="session-portal-cascade-bar">
          <span className="session-portal-cascade-label">
            <LayoutGrid size={12} />
            <span>已平铺 {items.length} 个窗口</span>
          </span>
          <div className="session-portal-cascade-acts">
            {isMulti ? renderModeButtons("tile") : null}
            <button
              type="button"
              className="session-portal-pip-btn"
              title="收起成胶囊"
              aria-label="收起成胶囊"
              onClick={() => setFolded(true)}
            >
              <ChevronUp size={13} />
            </button>
          </div>
        </div>
        {items.length > 4 ? renderStackBar("tile", false) : null}
        <div className={`session-portal-tile-grid${tileCards.length === 1 ? " is-single" : ""}${isNarrowPane ? " is-narrow" : ""}`}>
          {tileCards.map((it) => {
            const active = it.id === current.id;
            return (
              <div key={it.id} className={`session-portal-tile-item${active ? " is-active" : ""}`}>
                <PortalMiniCard
                  item={it}
                  contextAgent={agent}
                  visible={visible}
                  isActive={active}
                  cardNumber={cardIndexOf(it.id)}
                  fps={active ? 30 : 15}
                  maxWidth={720}
                  quality={50}
                  bitmapCacheRef={bitmapCacheRef}
                  onFocusCard={() => setSelectedId(it.id)}
                  onExpandPortal={onExpandPortal}
                  onClosePortal={(pid, hid) => void closePortalSurface(hid, pid)}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (isCascade) {
    return (
      <div
        ref={rootRef}
        className={`session-portal-pip is-cascade${mode === "term" ? " in-term" : ""}${compactCls}`}
        style={posStyle}
        role="region"
        aria-label={`跨端多窗口叠列 · 共 ${items.length} 个`}
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest(".session-portal-pip-preview")) {
            e.preventDefault();
          }
        }}
      >
        <div className="session-portal-cascade-bar">
          <span className="session-portal-cascade-label">
            <Rows3 size={12} />
            <span>已展开 {items.length} 个窗口</span>
          </span>
          <div className="session-portal-cascade-acts">
            {renderModeButtons("cascade")}
            <button
              type="button"
              className="session-portal-pip-btn"
              title="收起成胶囊"
              aria-label="收起成胶囊"
              onClick={() => setFolded(true)}
            >
              <ChevronUp size={13} />
            </button>
          </div>
        </div>
        {items.length > 3 ? renderStackBar("cascade", false) : null}
        <div className="session-portal-cascade">
          {cascadeCards.map((it) => {
            const active = it.id === current.id;
            return (
              <div key={it.id} className={`session-portal-cascade-item${active ? " is-active" : ""}`}>
                <PortalMiniCard
                  item={it}
                  contextAgent={agent}
                  visible={visible}
                  isActive={active}
                  cardNumber={cardIndexOf(it.id)}
                  fps={active ? 30 : 15}
                  maxWidth={800}
                  quality={54}
                  bitmapCacheRef={bitmapCacheRef}
                  onFocusCard={() => setSelectedId(it.id)}
                  onExpandPortal={onExpandPortal}
                  onClosePortal={(pid, hid) => void closePortalSurface(hid, pid)}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`session-portal-pip${mode === "term" ? " in-term" : ""}${collapsed ? " is-collapsed" : ""}${isMulti ? " has-multi" : ""}${compactCls}${gesture === "drag" ? " is-dragging" : ""}${gesture === "resize" ? " is-resizing" : ""}`}
      style={posStyle}
      role="region"
      aria-label={`跨端回传浮窗 · ${current.title}`}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest(".session-portal-pip-preview")) {
          e.preventDefault();
        }
      }}
    >
      {!collapsed && isMulti ? renderStackBar("fan", true) : null}

      <div
        className={`session-portal-deck-stage${backItems.length > 0 ? " has-back" : ""}`}
        style={backItems.length > 0 ? { paddingTop: fanPadY, paddingLeft: fanPadX } : undefined}
        onMouseLeave={() => {
          clearHoverTimer();
          setHoveredBackIdx(null);
        }}
      >
        {backItems.map((backIt, idx) => {
          const z = idx + 1;
          const cardNum = cardIndexOf(backIt.id);
          const isHovered = hoveredBackIdx === idx;
          const isPartedDown = hoveredBackIdx !== null && idx > hoveredBackIdx;
          const depth = backItems.length - idx;
          const shiftY = isPartedDown ? fanPeekExpandY : isHovered ? -2 : 0;
          return (
            <div
              key={backIt.id}
              className={`session-portal-deck-back${isHovered ? " is-hovered" : ""}${isPartedDown ? " is-parted" : ""}`}
              data-depth={String(depth)}
              style={{
                top: idx * PIP_FAN_STEP_Y,
                left: idx * PIP_FAN_STEP_X,
                width: `calc(100% - ${fanPadX}px)`,
                height: `calc(100% - ${fanPadY}px)`,
                zIndex: z,
                transform: `translate3d(0, ${shiftY}px, 0)`,
              }}
              onMouseEnter={() => scheduleHoverIdx(idx)}
            >
              <PortalMiniCard
                item={backIt}
                contextAgent={agent}
                visible={visible}
                isActive={false}
                inDeckBack
                cardNumber={cardNum}
                fps={isHovered ? 24 : 0}
                maxWidth={720}
                quality={52}
                bitmapCacheRef={bitmapCacheRef}
                onFocusCard={() => {
                  clearHoverTimer();
                  setSelectedId(backIt.id);
                  setHoveredBackIdx(null);
                  setFolded(false);
                }}
                onExpandPortal={onExpandPortal}
                onClosePortal={(pid, hid) => void closePortalSurface(hid, pid)}
              />
            </div>
          );
        })}

        <div
          className={`session-portal-deck-front${hoveredBackIdx !== null && backItems.length > 0 ? " is-parted" : ""}`}
          style={{
            ...(backItems.length > 0 ? { zIndex: backItems.length + 2 } : {}),
            ...(backItems.length > 0
              ? {
                  transform:
                    hoveredBackIdx !== null ? `translate3d(0, ${fanPeekExpandY}px, 0)` : "translate3d(0, 0, 0)",
                }
              : {}),
          }}
          onMouseEnter={() => {
            if (hoveredBackIdx !== null) scheduleHoverIdx(null);
          }}
        >
          {!collapsed
            ? dirs.map((d) => (
                <div
                  key={d}
                  className={`pip-resize-handle pip-resize-${d}`}
                  onPointerDown={startResize(d)}
                  aria-hidden
                />
              ))
            : null}
          <PortalMiniCard
            item={current}
            contextAgent={agent}
            visible={visible}
            collapsed={collapsed}
            isActive
            cardNumber={cardIndexOf(current.id)}
            stackCount={items.length}
            fps={60}
            maxWidth={960}
            quality={62}
            bitmapCacheRef={bitmapCacheRef}
            onStartHeaderDrag={startMoveDrag}
            onToggleCollapse={() => setFolded(!collapsed)}
            onQuickLayout={(next) => setExpandedLayout(next)}
            onExpandPortal={onExpandPortal}
            onClosePortal={(pid, hid) => void closePortalSurface(hid, pid)}
          />
        </div>
      </div>
    </div>
  );
}
