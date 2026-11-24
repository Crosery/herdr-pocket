import { useEffect, useMemo, useRef, useState } from "react";
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
  X,
} from "lucide-react";
import type { Agent, PortalItem } from "@herdr-pocket/protocol";
import { isTauri } from "../lib/bridge";
import { useLocalHostDeviceId } from "../lib/fonts";
import { native } from "../lib/native";
import { rpcCall } from "../lib/relay";
import {
  closePortalSurface,
  filterVisiblePortalItems,
  portalStore,
  subscribeAgentPortalUpdates,
  subscribePortalFrames,
} from "../lib/portalClient";
import { liveStore } from "../lib/store";
import { openWebTab, shellStore } from "../shell/shellStore";

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
  visible = true,
  mode = "chat",
  onExpandPortal,
}: {
  agent: Agent;
  visible?: boolean;
  mode?: "chat" | "term";
  onExpandPortal: (portalId: string) => void;
}) {
  const itemsById = portalStore.use((s) => s.itemsById);
  const framesById = portalStore.use((s) => s.framesById);
  const dismissedIds = portalStore.use((s) => s.dismissedIds);
  const manualIds = portalStore.use((s) => s.manualIds);
  const directAddr = liveStore.use((s) => s.direct[agent.deviceId]);
  const localHostId = useLocalHostDeviceId();
  const isTauriApp = isTauri();

  const items = useMemo(
    () =>
      filterVisiblePortalItems({
        itemsById,
        dismissedIds,
        manualIds,
        agent,
        isTauriApp,
        localHostId,
      }),
    [agent, dismissedIds, isTauriApp, itemsById, localHostId, manualIds],
  );

  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [box, setBox] = useState<PipBox>({ x: null, y: null, w: PIP_DEFAULT_W, h: PIP_DEFAULT_H });
  const [gesture, setGesture] = useState<"idle" | "drag" | "resize">("idle");
  const [htmlPreview, setHtmlPreview] = useState<{ portalId: string; memUrl?: string | null; srcDoc?: string } | null>(null);
  const [imgPreview, setImgPreview] = useState<{ portalId: string; dataUri: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const prevTopIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    return subscribeAgentPortalUpdates(agent.deviceId, agent.key);
  }, [agent.deviceId, agent.key, visible]);

  useEffect(() => {
    const topId = items[0]?.id ?? null;
    if (topId && topId !== prevTopIdRef.current) {
      setIndex(0);
      setCollapsed(false);
    }
    prevTopIdRef.current = topId;
  }, [items]);

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

  useEffect(() => {
    if (!visible || collapsed || !currentHostId || !currentId || !currentCanInteract) return;
    return subscribePortalFrames(currentHostId, currentId, 6);
  }, [collapsed, currentCanInteract, currentHostId, currentId, visible]);

  useEffect(() => {
    if (!visible || collapsed || !currentId || !currentHostId || !currentPath || currentKind !== "html") {
      setHtmlPreview(null);
      return;
    }
    let alive = true;
    void rpcCall(currentHostId, "portal.bundleHtml", {
      agent: agent.key,
      path: currentPath,
      ...(agent.cwd ? { cwd: agent.cwd } : {}),
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
  }, [agent.cwd, agent.key, collapsed, currentHostId, currentId, currentKind, currentPath, currentTitle, visible]);

  const isInlineImageFile =
    currentKind === "file" && Boolean(currentPath && (PIP_IMAGE_EXT_RE.test(currentPath) || currentMime?.startsWith("image/")));

  useEffect(() => {
    if (!visible || collapsed || !currentId || !currentHostId || !currentPath || !isInlineImageFile) {
      setImgPreview(null);
      return;
    }
    let alive = true;
    void rpcCall(currentHostId, "files.readChunk", {
      agent: agent.key,
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
  }, [agent.key, collapsed, currentHostId, currentId, currentPath, isInlineImageFile, visible]);

  if (!items.length || !current) return null;

  const frame = framesById[current.id];
  const activeHtml = htmlPreview?.portalId === current.id ? htmlPreview : null;
  const activeImg = imgPreview?.portalId === current.id ? imgPreview : null;
  const openUrl =
    (current.url && /^https?:\/\//i.test(current.url) ? current.url : null) ??
    (activeHtml?.memUrl ? activeHtml.memUrl : null);
  const p2pLabel = directAddr || current.transportHint === "p2p" ? "P2P 直连" : "中继";

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
      if (!moved) onExpandPortal(current.id);
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

  const posStyle: React.CSSProperties =
    box.x !== null && box.y !== null
      ? {
          left: box.x,
          top: box.y,
          right: "auto",
          bottom: "auto",
          ...(collapsed ? {} : { width: box.w, height: box.h }),
        }
      : collapsed
        ? {}
        : { width: box.w, height: box.h };

  const dirs: ResizeDir[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

  return (
    <div
      ref={rootRef}
      className={`session-portal-pip${mode === "term" ? " in-term" : ""}${collapsed ? " is-collapsed" : ""}${gesture === "drag" ? " is-dragging" : ""}${gesture === "resize" ? " is-resizing" : ""}`}
      style={posStyle}
      role="region"
      aria-label={`跨端回传浮窗 · ${current.title}`}
      onMouseDown={(e) => {
        e.preventDefault();
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
        <button
          type="button"
          className="session-portal-pip-btn"
          title="放大进入交互操作"
          aria-label="放大进入交互操作"
          onClick={() => onExpandPortal(current.id)}
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
        <button
          type="button"
          className="session-portal-pip-preview"
          onClick={() => onExpandPortal(current.id)}
        >
          {current.canInteract && frame ? (
            <img
              src={`data:${frame.mime};base64,${frame.data}`}
              alt={current.title}
              className="session-portal-pip-img"
              draggable={false}
            />
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
            <div className="session-portal-pip-card">
              <div className="session-portal-pip-kind">
                {portalIcon(current.kind)}
                <span>
                  {current.kind === "browser"
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
              <div className="session-portal-pip-sub mono truncate">
                {current.highlightName || current.subtitle || current.url || current.targetPath || current.title}
              </div>
            </div>
          )}
          <span className="session-portal-pip-overlay">点击放大并交互操作</span>
        </button>
      ) : null}
    </div>
  );
}
