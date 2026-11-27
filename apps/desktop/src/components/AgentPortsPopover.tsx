import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Columns2,
  Copy,
  Globe,
  Radio,
  RefreshCw,
  ScreenShare,
  Square,
} from "lucide-react";
import type { Agent, AgentListeningPort } from "@herdr-pocket/protocol";
import { copyToClipboard, isTauri } from "../lib/bridge";
import { useLocalHostDeviceId } from "../lib/fonts";
import { openPortalSurface } from "../lib/portalClient";
import { rpcCall } from "../lib/relay";
import { openWebTab, shellStore, splitTabPane } from "../shell/shellStore";
import { overlayStore, useToast } from "./PocketUI";

function clampPortsPos(rect: DOMRect, width = 336): { top: number; left: number; width: number } {
  if (typeof window === "undefined") return { top: rect.bottom + 6, left: rect.left, width };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(width, Math.max(248, vw - 16));
  const left = Math.max(8, Math.min(vw - w - 8, rect.right - w));
  const estH = 260;
  const top =
    rect.bottom + 6 + estH > vh - 8 && rect.top - estH > 12
      ? Math.max(8, rect.top - 6 - estH)
      : rect.bottom + 6;
  return { top, left, width: w };
}

export function AgentPortsPopover({
  agent,
  tabId,
  paneId,
}: {
  agent: Agent;
  tabId?: string;
  paneId?: string;
}) {
  const toast = useToast();
  const localHostId = useLocalHostDeviceId();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const [livePorts, setLivePorts] = useState<AgentListeningPort[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [stoppingPort, setStoppingPort] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  const ports = livePorts ?? agent.listeningPorts ?? [];
  const isLocalHost = Boolean(isTauri() && localHostId && agent.deviceId === localHostId);

  const activeTabId = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);

  useEffect(() => {
    setLivePorts(null);
  }, [agent.key, agent.listeningPorts]);

  useEffect(() => {
    setOpen(false);
  }, [activeTabId, agent.key, selectedSpace]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent("pocket:close-popovers", { detail: popId }));
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const onPeerOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== popId) setOpen(false);
    };
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && !triggerRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onResize = () => {
      const el = triggerRef.current;
      if (el) setCoords(clampPortsPos(el.getBoundingClientRect()));
    };
    window.addEventListener("pocket:close-popovers", onPeerOpen);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pocket:close-popovers", onPeerOpen);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [open, popId]);

  if (ports.length === 0) return null;

  const first = ports[0]!;
  const extraCount = ports.length - 1;

  const refreshPorts = async () => {
    setLoading(true);
    try {
      const res = await rpcCall(agent.deviceId, "agent.ports", { agent: agent.key, action: "list" }, 8_000);
      setLivePorts(res.ports);
    } catch (e) {
      toast((e as Error).message || "刷新端口失败", true);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenPreview = (p: AgentListeningPort, inSplit = false) => {
    const url = p.url || `http://localhost:${p.port}`;
    setOpen(false);
    if (!isLocalHost) {
      void openPortalSurface(agent.deviceId, {
        agent: agent.key,
        kind: "browser",
        url,
        title: p.title || `:${p.port} (${p.processName})`,
      })
        .then(() => toast(`已通过远端小窗打开 :${p.port}`))
        .catch((e: Error) => toast(e.message || "打开远端端口失败", true));
      return;
    }
    if (inSplit && tabId && paneId) {
      splitTabPane(tabId, paneId, "right", {
        kind: "web",
        webId: `w:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        url,
        title: p.title || `localhost:${p.port}`,
        spaceKey: shellStore.get().selectedSpace,
      });
      return;
    }
    openWebTab(url, p.title || `localhost:${p.port}`, { spaceKey: shellStore.get().selectedSpace });
  };

  const handleStop = async (p: AgentListeningPort) => {
    setStoppingPort(p.port);
    try {
      const res = await rpcCall(
        agent.deviceId,
        "agent.ports",
        { agent: agent.key, action: "stop", pid: p.pid, port: p.port },
        8_000,
      );
      setLivePorts(res.ports);
      toast(`已停止 :${p.port} (${p.processName})`);
      if (res.ports.length === 0) setOpen(false);
    } catch (e) {
      toast((e as Error).message || `停止 :${p.port} 失败`, true);
    } finally {
      setStoppingPort(null);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`port-pill${open ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={`此实例正在监听 ${ports.map((p) => `:${p.port}`).join("、")}（点击预览或管理）`}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          const el = triggerRef.current;
          if (el) setCoords(clampPortsPos(el.getBoundingClientRect()));
          setOpen(true);
        }}
      >
        <Radio size={12} aria-hidden />
        <span className="mono">:{first.port}</span>
        {extraCount > 0 ? <span className="port-pill-extra mono">+{extraCount}</span> : null}
      </button>

      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              id={popId}
              role="dialog"
              aria-label="当前会话启动的服务与端口"
              className="port-pop"
              style={{ top: coords.top, left: coords.left, width: coords.width }}
            >
              <div className="port-pop-head">
                <span className="port-pop-title">
                  <Radio size={13} />
                  <span>运行中服务 · {ports.length}</span>
                </span>
                <button
                  type="button"
                  className="port-pop-refresh"
                  title="重新检测监听端口"
                  aria-label="重新检测监听端口"
                  onClick={() => void refreshPorts()}
                >
                  <RefreshCw size={12} className={loading ? "spin" : ""} />
                </button>
              </div>
              <div className="port-pop-list">
                {ports.map((p) => {
                  const displayUrl = p.url || `${p.host}:${p.port}`;
                  const isHttp = p.protocol === "http";
                  return (
                    <div key={`${p.pid}:${p.port}`} className="port-pop-card">
                      <div className="port-pop-main">
                        <div className="port-pop-row1">
                          <span className="port-pop-port mono">:{p.port}</span>
                          <span className="port-pop-proto">{isHttp ? "HTTP" : "TCP"}</span>
                          <span className="port-pop-name truncate" title={p.title || p.processName}>
                            {p.title || p.processName}
                          </span>
                        </div>
                        <div className="port-pop-row2 mono truncate" title={`${p.processName} (PID ${p.pid}) · ${displayUrl}`}>
                          <span>{p.processName}</span>
                          <span> · PID {p.pid}</span>
                        </div>
                      </div>
                      <div className="port-pop-acts">
                        {isHttp ? (
                          <button
                            type="button"
                            className="port-act-btn primary"
                            title={isLocalHost ? "在内置浏览器打开预览" : "在远端小窗打开预览（P2P）"}
                            onClick={() => handleOpenPreview(p, false)}
                          >
                            {isLocalHost ? <Globe size={12} /> : <ScreenShare size={12} />}
                            <span>预览</span>
                          </button>
                        ) : null}
                        {isHttp && isLocalHost && tabId && paneId ? (
                          <button
                            type="button"
                            className="port-act-btn icon"
                            title="向右分屏打开预览"
                            aria-label={`向右分屏打开 :${p.port}`}
                            onClick={() => handleOpenPreview(p, true)}
                          >
                            <Columns2 size={12} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="port-act-btn icon"
                          title={`复制 ${displayUrl}`}
                          aria-label={`复制 ${displayUrl}`}
                          onClick={() => {
                            void copyToClipboard(displayUrl).then((ok) =>
                              toast(ok ? `已复制 ${displayUrl}` : "复制失败", !ok),
                            );
                          }}
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          type="button"
                          className="port-act-btn icon danger"
                          disabled={stoppingPort === p.port}
                          title={`停止服务 :${p.port} (SIGTERM)`}
                          aria-label={`停止服务 :${p.port}`}
                          onClick={() => void handleStop(p)}
                        >
                          <Square size={11} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
