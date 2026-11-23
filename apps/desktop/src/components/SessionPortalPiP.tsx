import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileCode2,
  FolderSearch,
  Globe,
  Maximize2,
  X,
} from "lucide-react";
import type { Agent, PortalItem } from "@herdr-pocket/protocol";
import {
  closePortalSurface,
  portalStore,
  subscribeAgentPortalUpdates,
  subscribePortalFrames,
} from "../lib/portalClient";
import { liveStore } from "../lib/store";

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
  onExpandPortal,
}: {
  agent: Agent;
  visible?: boolean;
  onExpandPortal: (portalId: string) => void;
}) {
  const itemsById = portalStore.use((s) => s.itemsById);
  const framesById = portalStore.use((s) => s.framesById);
  const dismissedIds = portalStore.use((s) => s.dismissedIds);
  const directAddr = liveStore.use((s) => s.direct[agent.deviceId]);

  const items = useMemo(
    () =>
      Object.values(itemsById)
        .filter((i) => i.hostId === agent.deviceId && (!i.agentKey || i.agentKey === agent.key) && !dismissedIds[i.id])
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [agent.deviceId, agent.key, dismissedIds, itemsById],
  );

  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    if (!visible) return;
    return subscribeAgentPortalUpdates(agent.deviceId, agent.key);
  }, [agent.deviceId, agent.key, visible]);

  const current = items[Math.min(index, Math.max(0, items.length - 1))];

  useEffect(() => {
    if (!visible || collapsed || !current || !current.canInteract) return;
    return subscribePortalFrames(current.hostId, current.id, 3);
  }, [collapsed, current, visible]);

  if (!items.length || !current) return null;

  const frame = framesById[current.id];
  const p2pLabel = directAddr || current.transportHint === "p2p" ? "P2P 直连" : "中继";

  return (
    <div
      className={`session-portal-pip${collapsed ? " is-collapsed" : ""}`}
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
      role="region"
      aria-label={`跨端回传浮窗 · ${current.title}`}
    >
      <div
        className="session-portal-pip-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          const orig = { ...offset };
          dragRef.current = { startX: e.clientX, startY: e.clientY, origX: orig.x, origY: orig.y };
          const onMove = (ev: PointerEvent) => {
            if (!dragRef.current) return;
            setOffset({
              x: Math.min(24, Math.max(-420, dragRef.current.origX + (ev.clientX - dragRef.current.startX))),
              y: Math.min(24, Math.max(-360, dragRef.current.origY + (ev.clientY - dragRef.current.startY))),
            });
          };
          const onUp = () => {
            dragRef.current = null;
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
          };
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
        }}
      >
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
