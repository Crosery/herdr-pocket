import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  FileCode2,
  FolderSearch,
  Globe,
  Maximize2,
  MousePointer,
  X,
} from "lucide-react";
import type { Agent, PortalItem } from "@herdr-pocket/protocol";
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
import { allAgents, liveStore, lookupAgentByKey } from "../lib/store";
import { openWebTab, shellStore } from "../shell/shellStore";
import { PocketButton } from "./PocketUI";

type ResizeDir = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

const PIP_MIN_W = 220;
const PIP_MAX_W = 880;
const PIP_MIN_H = 150;
const PIP_MAX_H = 680;
const PIP_MARGIN = 12;
const PIP_DEFAULT_W = 320;
const PIP_DEFAULT_H = 224;
const PIP_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i;

interface PipBox {
  x: number | null;
  y: number | null;
  w: number;
  h: number;
}

function clampPipSize(w: number, h: number): { w: number; h: number } {
  const maxW = typeof window !== "undefined" ? Math.min(PIP_MAX_W, Math.max(PIP_MIN_W, window.innerWidth - PIP_MARGIN * 2)) : PIP_MAX_W;
  const maxH = typeof window !== "undefined" ? Math.min(PIP_MAX_H, Math.max(PIP_MIN_H, window.innerHeight - PIP_MARGIN * 2)) : PIP_MAX_H;
  return {
    w: Math.round(Math.max(PIP_MIN_W, Math.min(maxW, w))),
    h: Math.round(Math.max(PIP_MIN_H, Math.min(maxH, h))),
  };
}

function clampPipPos(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const maxX = Math.max(PIP_MARGIN, vw - w - PIP_MARGIN);
  const maxY = Math.max(PIP_MARGIN, vh - h - PIP_MARGIN);
  return {
    x: Math.round(Math.max(PIP_MARGIN, Math.min(maxX, x))),
    y: Math.round(Math.max(PIP_MARGIN, Math.min(maxY, y))),
  };
}

function portalIcon(kind: PortalItem["kind"]) {
  switch (kind) {
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
  const framesById = portalStore.use((s) => s.framesById);
  const dismissedIds = portalStore.use((s) => s.dismissedIds);
  const manualIds = portalStore.use((s) => s.manualIds);
  const openSeqById = portalStore.use((s) => s.openSeqById);
  const agentsMap = liveStore.use((s) => s.agents);
  liveStore.use((s) => s.direct);
  const localHostId = useLocalHostDeviceId();
  const isTauriApp = isTauri();
  const [, setTransportTick] = useState(0);

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
    if (agent?.key) set.add(agent.key);
    if (agentKeys) {
      for (const k of agentKeys) {
        if (k) set.add(k);
      }
    }
    return [...set];
  }, [agent?.key, agentKeys]);

  const items = useMemo(() => {
    if (effectiveHostIds.length === 0) return [];
    if (effectiveHostIds.length === 1 && effectiveAgentKeys.length <= 1 && agent) {
      return filterVisiblePortalItems({
        itemsById,
        dismissedIds,
        manualIds,
        agent,
        isTauriApp,
        localHostId,
      });
    }
    const hostSet = new Set(effectiveHostIds);
    const keySet = new Set(effectiveAgentKeys);
    const matched = new Map<string, PortalItem>();
    const hostsToScan = effectiveHostIds;
    const keysToScan = effectiveAgentKeys.length > 0 ? effectiveAgentKeys : [agent?.key ?? ""];
    for (const hid of hostsToScan) {
      for (const aKey of keysToScan) {
        for (const it of filterVisiblePortalItems({
          itemsById,
          dismissedIds,
          manualIds,
          agent: { deviceId: hid, key: aKey },
          isTauriApp,
          localHostId,
        })) {
          matched.set(it.id, it);
        }
      }
    }
    for (const it of Object.values(itemsById)) {
      if (!hostSet.has(it.hostId) || dismissedIds[it.id]) continue;
      if (!it.agentKey || keySet.size === 0 || keySet.has(it.agentKey)) {
        matched.set(it.id, it);
      }
    }
    return [...matched.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [agent, dismissedIds, effectiveAgentKeys, effectiveHostIds, isTauriApp, itemsById, localHostId, manualIds]);

  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [directControl, setDirectControl] = useState(true);
  const [box, setBox] = useState<PipBox>({ x: null, y: null, w: PIP_DEFAULT_W, h: PIP_DEFAULT_H });
  const [gesture, setGesture] = useState<"idle" | "drag" | "resize">("idle");
  const [htmlPreview, setHtmlPreview] = useState<{ portalId: string; memUrl?: string | null; srcDoc?: string } | null>(null);
  const [imgPreview, setImgPreview] = useState<{ portalId: string; dataUri: string } | null>(null);
  const [textPreview, setTextPreview] = useState<{ portalId: string; text: string } | null>(null);
  const [pipFps, setPipFps] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
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
  const prevTopSigRef = useRef<string | null>(null);

  const hostListKey = effectiveHostIds.join("\0");
  const primaryAgentKey = agent?.key ?? effectiveAgentKeys[0];

  useEffect(() => {
    if (!visible || !hostListKey) return;
    const stops = hostListKey.split("\0").filter(Boolean).map((hid) =>
      subscribeAgentPortalUpdates(hid, primaryAgentKey ?? ""),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [hostListKey, primaryAgentKey, visible]);

  const topId = items[0]?.id ?? null;
  const topOpenSeq = topId ? (openSeqById[topId] ?? 0) : 0;
  useEffect(() => {
    if (!topId) {
      prevTopSigRef.current = null;
      return;
    }
    const sig = `${topId}:${topOpenSeq}`;
    if (sig !== prevTopSigRef.current) {
      setIndex(0);
      setCollapsed(false);
    }
    prevTopSigRef.current = sig;
  }, [topId, topOpenSeq]);

  useEffect(() => {
    const onResize = () => {
      setBox((prev) => {
        const sz = clampPipSize(prev.w, prev.h);
        if (prev.x === null || prev.y === null) {
          return sz.w === prev.w && sz.h === prev.h ? prev : { ...prev, ...sz };
        }
        const pos = clampPipPos(prev.x, prev.y, sz.w, collapsed ? 44 : sz.h);
        return { ...sz, ...pos };
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [collapsed]);

  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  const currentId = current?.id;
  const currentKind = current?.kind;
  const currentHostId = current?.hostId;
  const currentPath = current?.targetPath;
  const currentTitle = current?.title;
  const currentMime = current?.mime;
  const currentCanInteract = Boolean(current?.canInteract);
  const currentAgentKey = current?.agentKey ?? primaryAgentKey;
  const currentAgent = useMemo(() => {
    if (agent && (!currentAgentKey || agent.key === currentAgentKey)) return agent;
    if (currentAgentKey) return lookupAgentByKey(agentsMap, currentAgentKey);
    if (currentHostId) return allAgents(agentsMap).find((a) => a.deviceId === currentHostId);
    return undefined;
  }, [agent, agentsMap, currentAgentKey, currentHostId]);

  useEffect(() => {
    if (!visible || collapsed || !currentHostId || !currentId || !currentCanInteract) return;
    return subscribePortalFrames(currentHostId, currentId, { fps: 24, maxWidth: 960, quality: 58 });
  }, [collapsed, currentCanInteract, currentHostId, currentId, visible]);

  useEffect(() => {
    if (!visible || collapsed || !currentId) return;
    const timer = setInterval(() => setTransportTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [collapsed, currentId, visible]);

  useEffect(() => {
    if (!currentId || currentKind !== "html") {
      setHtmlPreview(null);
      return;
    }
    if (!visible || collapsed || !currentHostId || !currentPath) {
      return;
    }
    if (htmlPreview?.portalId === currentId && (htmlPreview.memUrl || htmlPreview.srcDoc)) {
      return;
    }
    let alive = true;
    void rpcCall(currentHostId, "portal.bundleHtml", {
      ...(currentAgentKey ? { agent: currentAgentKey } : {}),
      path: currentPath,
      ...(currentAgent?.cwd ? { cwd: currentAgent.cwd } : {}),
    })
      .then(async (res) => {
        if (!alive || !res?.html) return;
        let memUrl: string | null = null;
        if (isTauri() && native.available()) {
          memUrl = await native.registerMemHtmlPreview(res.title || currentTitle || "preview.html", res.html).catch(() => null);
        }
        if (alive) {
          setHtmlPreview({ portalId: currentId, memUrl, srcDoc: res.html });
        }
      })
      .catch(() => {
        if (alive) setHtmlPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [collapsed, currentAgent?.cwd, currentAgentKey, currentHostId, currentId, currentKind, currentPath, currentTitle, htmlPreview?.memUrl, htmlPreview?.portalId, htmlPreview?.srcDoc, visible]);

  const isInlineImageFile =
    currentKind === "file" && Boolean(currentPath && (PIP_IMAGE_EXT_RE.test(currentPath) || currentMime?.startsWith("image/")));

  useEffect(() => {
    if (!currentId || !isInlineImageFile) {
      setImgPreview(null);
      return;
    }
    if (!visible || collapsed || !currentHostId || !currentPath) {
      return;
    }
    if (imgPreview?.portalId === currentId && imgPreview.dataUri) {
      return;
    }
    let alive = true;
    void rpcCall(currentHostId, "files.readChunk", {
      ...(currentAgentKey ? { agent: currentAgentKey } : {}),
      path: currentPath,
      offset: 0,
      length: 1536 * 1024,
    })
      .then((c) => {
        if (!alive || !c?.base64) return;
        setImgPreview({ portalId: currentId, dataUri: `data:${c.mime || "image/png"};base64,${c.base64}` });
      })
      .catch(() => {
        if (alive) setImgPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [collapsed, currentAgentKey, currentHostId, currentId, currentPath, imgPreview?.dataUri, imgPreview?.portalId, isInlineImageFile, visible]);

  const isInlineTextFile = currentKind === "file" && !isInlineImageFile;

  useEffect(() => {
    if (!currentId || !isInlineTextFile) {
      setTextPreview(null);
      return;
    }
    if (!visible || collapsed || !currentHostId || !currentPath) return;
    if (textPreview?.portalId === currentId && textPreview.text) return;
    let alive = true;
    void rpcCall(currentHostId, "files.read", {
      agent: currentAgentKey ?? "",
      path: currentPath,
    })
      .then((res) => {
        if (!alive || !res?.text) return;
        setTextPreview({ portalId: currentId, text: res.text.slice(0, 1200) });
      })
      .catch(() => {
        if (alive) setTextPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [collapsed, currentAgentKey, currentHostId, currentId, currentPath, isInlineTextFile, textPreview?.portalId, textPreview?.text, visible]);

  const isSameLocalHost = Boolean(isTauriApp && localHostId && current?.hostId === localHostId);
  const needsMacScreenPerm = Boolean(
    isTauriApp &&
      detectPlatform() === "macos" &&
      isSameLocalHost &&
      current?.streamError &&
      /屏幕录制|抓屏权限|screen_recording/i.test(current.streamError),
  );

  useEffect(() => {
    if (!needsMacScreenPerm || !currentHostId || !currentId) return;
    const retryIfGranted = async () => {
      const p = await native.getPermissions();
      if (p?.screenRecording === "granted") {
        void capturePortalFrameOnce(currentHostId, currentId);
      }
    };
    const off = native.onPermissionsChanged((p) => {
      if (p.screenRecording === "granted") {
        void capturePortalFrameOnce(currentHostId, currentId);
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
  }, [currentHostId, currentId, needsMacScreenPerm]);

  const currentFrame = currentId ? framesById[currentId] : undefined;
  const currentCanStream = Boolean(currentCanInteract && currentFrame && (currentFrame.rawBytes?.byteLength || currentFrame.data));

  const drawPipFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const src = latestSourceRef.current;
    const previewEl = previewRef.current;
    if (!canvas || !src || !previewEl) return;
    const r = previewEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width || box.w));
    const h = Math.max(1, Math.round(r.height || box.h));
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
    const imgW = currentFrame?.width ?? current?.width ?? 1280;
    const imgH = currentFrame?.height ?? current?.height ?? 800;
    const { drawLeft, drawTop, drawW, drawH } = computeContainedRect(w, h, imgW, imgH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, drawLeft, drawTop, drawW, drawH);
  }, [box.h, box.w, current?.height, current?.width, currentFrame?.height, currentFrame?.width]);

  useEffect(() => {
    drawPipFrame();
  }, [drawPipFrame]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => drawPipFrame());
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawPipFrame, collapsed, currentId]);

  useEffect(() => {
    fpsSamplesRef.current = [];
    lastFrameSeqRef.current = -1;
    setPipFps(0);
  }, [currentId]);

  useEffect(() => {
    if (!visible || collapsed || !currentCanInteract) {
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
  }, [collapsed, currentCanInteract, visible]);

  useEffect(() => {
    const hasBinary = Boolean(currentFrame?.rawBytes && currentFrame.rawBytes.byteLength > 0);
    const hasBase64 = Boolean(currentFrame?.data);
    if (!currentCanStream || !currentFrame || (!hasBinary && !hasBase64)) {
      const prev = latestSourceRef.current;
      latestSourceRef.current = null;
      if (prev && "close" in prev && typeof prev.close === "function") prev.close();
      return;
    }

    if (currentFrame.seq !== lastFrameSeqRef.current) {
      lastFrameSeqRef.current = currentFrame.seq;
      const now = Date.now();
      const cutoff = now - 1000;
      const kept = fpsSamplesRef.current.filter((t) => t >= cutoff);
      kept.push(now);
      fpsSamplesRef.current = kept;
      setPipFps(kept.length);
    }

    const seqToken = ++decodeSeqRef.current;
    let cancelled = false;
    const mime = currentFrame.mime || "image/jpeg";

    const commitSource = (next: ImageBitmap | HTMLImageElement) => {
      if (cancelled || seqToken !== decodeSeqRef.current) {
        if ("close" in next && typeof next.close === "function") next.close();
        return;
      }
      const prev = latestSourceRef.current;
      latestSourceRef.current = next;
      if (prev && "close" in prev && typeof prev.close === "function") prev.close();
      drawPipFrame();
    };

    if (typeof createImageBitmap === "function" && (hasBinary || typeof atob === "function")) {
      try {
        let blob: Blob;
        if (hasBinary && currentFrame.rawBytes) {
          blob = new Blob([currentFrame.rawBytes as Uint8Array<ArrayBuffer>], { type: mime });
        } else {
          const bin = atob(currentFrame.data);
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
    if (hasBinary && currentFrame.rawBytes) {
      revokeUrl = URL.createObjectURL(new Blob([currentFrame.rawBytes as Uint8Array<ArrayBuffer>], { type: mime }));
      img.src = revokeUrl;
    } else {
      img.src = `data:${mime};base64,${currentFrame.data}`;
    }
    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [currentCanStream, currentFrame, drawPipFrame]);

  useEffect(() => {
    return () => {
      const prev = latestSourceRef.current;
      latestSourceRef.current = null;
      if (prev && "close" in prev && typeof prev.close === "function") prev.close();
    };
  }, []);

  if (!items.length || !current) return null;

  const frame = currentFrame;
  const activeHtml = htmlPreview?.portalId === current.id ? htmlPreview : null;
  const activeImg = imgPreview?.portalId === current.id ? imgPreview : null;
  const activeText = textPreview?.portalId === current.id ? textPreview : null;
  const safeExternalUrl =
    current.url && /^https?:\/\//i.test(current.url) && (isSameLocalHost || !isLoopbackPortalUrl(current.url))
      ? current.url
      : null;
  const openUrl = safeExternalUrl ?? (activeHtml?.memUrl ? activeHtml.memUrl : null);
  const hasStreamFrame = Boolean(current.canInteract && frame && (frame.rawBytes?.byteLength || frame.data));
  const canDirectControl = Boolean(directControl && hasStreamFrame && !current.streamError && !needsMacScreenPerm);
  const transport = resolvePortalTransport(current.hostId, localHostId, frame);
  const p2pLabel = pipFps > 0 ? `${transport.label} · ${pipFps}fps` : transport.label;

  const clientToPipNormalized = (clientX: number, clientY: number) => {
    const el = previewRef.current;
    if (!el) return { nx: 0.5, ny: 0.5 };
    const r = el.getBoundingClientRect();
    const imgW = frame?.width ?? current.width ?? 1280;
    const imgH = frame?.height ?? current.height ?? 800;
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
    void sendPortalInput(current.hostId, current.id, {
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
    void sendPortalInput(current.hostId, current.id, {
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

  const currentAnchorRect = () => {
    const el = rootRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (el && parent) {
      const r = el.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      return {
        x: box.x ?? Math.round(r.left - pr.left),
        y: box.y ?? Math.round(r.top - pr.top),
        w: box.w,
        h: box.h,
        parentW: parent.clientWidth,
        parentH: parent.clientHeight,
      };
    }
    return {
      x: box.x ?? Math.max(PIP_MARGIN, (typeof window !== "undefined" ? window.innerWidth : 1000) - box.w - 24),
      y:
        box.y ??
        (mode === "term" ? 14 : Math.max(PIP_MARGIN, (typeof window !== "undefined" ? window.innerHeight : 700) - box.h - 120)),
      w: box.w,
      h: box.h,
      parentW: typeof window !== "undefined" ? window.innerWidth : 1200,
      parentH: typeof window !== "undefined" ? window.innerHeight : 800,
    };
  };

  const startMoveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
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
      if (!moved) onExpandPortal(current.id, current.hostId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const startResize = (dir: ResizeDir) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || collapsed) return;
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
      const clampedSz = clampPipSize(nextW, nextH);
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

  const sizeClamp: React.CSSProperties = { maxWidth: "calc(100% - 24px)", maxHeight: "calc(100% - 24px)" };
  const posStyle: React.CSSProperties =
    box.x !== null && box.y !== null
      ? {
          left: box.x,
          top: box.y,
          right: "auto",
          bottom: "auto",
          ...sizeClamp,
          ...(collapsed ? {} : { width: box.w, height: box.h }),
        }
      : collapsed
        ? sizeClamp
        : { width: box.w, height: box.h, ...sizeClamp };

  const dirs: ResizeDir[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

  return (
    <div
      ref={rootRef}
      className={`session-portal-pip${mode === "term" ? " in-term" : ""}${collapsed ? " is-collapsed" : ""}${gesture === "drag" ? " is-dragging" : ""}${gesture === "resize" ? " is-resizing" : ""}`}
      style={posStyle}
      role="region"
      aria-label={`跨端回传浮窗 · ${current.title}`}
      onMouseDown={(e) => {
        if (!canDirectControl || !(e.target as HTMLElement).closest(".session-portal-pip-preview")) {
          e.preventDefault();
        }
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

      <div className="session-portal-pip-head" onPointerDown={startMoveDrag}>
        <span className="session-portal-pip-ic">{portalIcon(current.kind)}</span>
        <span className="session-portal-pip-title truncate" title={current.title}>
          {current.title}
        </span>
        <span className="session-portal-pip-badge">{p2pLabel}</span>
        {items.length > 1 ? (
          <div className="session-portal-pip-nav">
            <button
              type="button"
              className="session-portal-pip-btn"
              aria-label="上一个回传项"
              onClick={() => setIndex((i) => (i - 1 + items.length) % items.length)}
            >
              <ChevronLeft size={12} />
            </button>
            <span className="num">{Math.min(index, items.length - 1) + 1}/{items.length}</span>
            <button
              type="button"
              className="session-portal-pip-btn"
              aria-label="下一个回传项"
              onClick={() => setIndex((i) => (i + 1) % items.length)}
            >
              <ChevronRight size={12} />
            </button>
          </div>
        ) : null}
        {openUrl ? (
          <button
            type="button"
            className="session-portal-pip-btn"
            title="在内置浏览器标签打开"
            aria-label="在内置浏览器标签打开"
            onClick={() => openWebTab(openUrl, current.title, { spaceKey: shellStore.get().selectedSpace })}
          >
            <ExternalLink size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="session-portal-pip-btn"
          title={collapsed ? "展开小窗预览" : "收起小窗"}
          aria-label={collapsed ? "展开小窗预览" : "收起小窗"}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {current.canInteract ? (
          <button
            type="button"
            className={`session-portal-pip-btn${directControl ? " is-active" : ""}`}
            title={directControl ? "小窗直控已开启（点击切换为点击放大）" : "开启小窗直控（直接在悬浮窗内操作）"}
            aria-label={directControl ? "关闭小窗直控" : "开启小窗直控"}
            aria-pressed={directControl}
            onClick={() => setDirectControl((v) => !v)}
          >
            <MousePointer size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="session-portal-pip-btn"
          title="放大进入交互操作"
          aria-label="放大进入交互操作"
          onClick={() => onExpandPortal(current.id, current.hostId)}
        >
          <Maximize2 size={12} />
        </button>
        <button
          type="button"
          className="session-portal-pip-btn"
          title="关闭浮窗"
          aria-label="关闭浮窗"
          onClick={() => void closePortalSurface(current.hostId, current.id)}
        >
          <X size={13} />
        </button>
      </div>

      {!collapsed ? (
        <div
          ref={previewRef}
          role={canDirectControl ? "application" : "button"}
          tabIndex={0}
          className={`session-portal-pip-preview${canDirectControl ? " is-interactive" : ""}`}
          onClick={() => {
            if (!canDirectControl) onExpandPortal(current.id, current.hostId);
          }}
          onPointerDown={(e) => {
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
            void sendPortalInput(current.hostId, current.id, {
              type: "pointer",
              action: "down",
              nx,
              ny,
              button: btn,
            }).catch(() => {});
          }}
          onPointerMove={(e) => {
            if (!canDirectControl) return;
            const { nx, ny } = clientToPipNormalized(e.clientX, e.clientY);
            pipPendingMoveRef.current = {
              nx,
              ny,
              action: pipDragBtnRef.current ? "drag" : "move",
              button: pipDragBtnRef.current ?? "left",
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
            void sendPortalInput(current.hostId, current.id, {
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
            void sendPortalInput(current.hostId, current.id, {
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
                void sendPortalInput(current.hostId, current.id, { type: "text", text: e.key }).catch(() => {});
              } else {
                void sendPortalInput(current.hostId, current.id, {
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
              onExpandPortal(current.id, current.hostId);
            }
          }}
        >
          {hasStreamFrame ? (
            <canvas ref={canvasRef} aria-label={current.title} className="session-portal-pip-img" />
          ) : activeImg ? (
            <img
              src={activeImg.dataUri}
              alt={current.title}
              className="session-portal-pip-img"
              draggable={false}
            />
          ) : activeHtml && (activeHtml.memUrl || activeHtml.srcDoc) ? (
            <div className="session-portal-pip-framewrap">
              <iframe
                title={current.title}
                className="session-portal-pip-iframe"
                sandbox="allow-scripts"
                tabIndex={-1}
                {...(activeHtml.memUrl ? { src: activeHtml.memUrl } : { srcDoc: activeHtml.srcDoc })}
              />
            </div>
          ) : (
            <div className={`session-portal-pip-card${needsMacScreenPerm ? " is-perm" : ""}`}>
              <div className="session-portal-pip-kind">
                {portalIcon(current.kind)}
                <span>
                  {current.streamError
                    ? "画面捕获受限"
                    : current.kind === "browser"
                      ? "远程浏览器画面"
                      : current.kind === "window"
                        ? "远程桌面窗口"
                        : current.kind === "reveal"
                          ? "已定位到远程目录"
                          : current.kind === "html"
                            ? "P2P HTML 应用预览"
                            : "P2P 跨端文件预览"}
                </span>
              </div>
              <div
                className={`session-portal-pip-sub${current.streamError ? " is-err" : " mono truncate"}`}
                title={current.streamError || current.subtitle || current.url || current.targetPath || current.title}
              >
                {current.streamError || current.highlightName || current.subtitle || current.url || current.targetPath || current.title}
              </div>
              {activeText && !current.streamError ? (
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
                onExpandPortal(current.id, current.hostId);
              }}
            >
              放大
            </button>
          ) : (
            <span className="session-portal-pip-overlay">点击放大并交互操作</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
