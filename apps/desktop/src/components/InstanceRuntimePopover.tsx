import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Columns2,
  Copy,
  Globe,
  Radio,
  RefreshCw,
  ScreenShare,
  Search,
  Square,
} from "lucide-react";
import type { Agent, AgentListeningPort, SubSession } from "@herdr-pocket/protocol";
import { copyToClipboard, isTauri } from "../lib/bridge";
import { useLocalHostDeviceId } from "../lib/fonts";
import { openPortalSurface } from "../lib/portalClient";
import { rpcCall } from "../lib/relay";
import { openSubagentAside, openWebTab, shellStore, splitTabPane } from "../shell/shellStore";
import type { SubagentHeadInfo } from "../views/AgentsView";
import { overlayStore, useToast } from "./PocketUI";
import { SubTreeRows, clampPopoverPos, parseSubagentDisplay } from "./SubagentNav";

type RuntimeTab = "ports" | "subs";

/**
 * Per-instance runtime controls for the pane header:
 * - Mint Radio trigger for active listening ports (`:3000 +1`)
 * - Agent Bot trigger for subagents (`2/5`)
 * Clicking either opens one slim, zero-bloat popover with a single header bar
 * switching cleanly between `端口` and `子 Agent` bound to the instance (not the tab).
 */
export function InstanceRuntimePopover({
  agent,
  subHead,
  tabId,
  paneId,
}: {
  agent: Agent;
  subHead?: SubagentHeadInfo | null;
  tabId?: string;
  paneId?: string;
}) {
  const toast = useToast();
  const localHostId = useLocalHostDeviceId();
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<RuntimeTab>("ports");
  const [coords, setCoords] = useState<{ top: number; left: number; maxWidth: number } | null>(null);

  // Port state
  const [livePorts, setLivePorts] = useState<AgentListeningPort[] | null>(null);
  const [portsLoading, setPortsLoading] = useState(false);
  const [stoppingPort, setStoppingPort] = useState<number | null>(null);

  // Subagent state
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [childrenMap, setChildrenMap] = useState<Record<string, SubSession[]>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [subsLoading, setSubsLoading] = useState(false);
  const [fetchedSubs, setFetchedSubs] = useState<SubSession[] | null>(null);
  const [onlyWorking, setOnlyWorking] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  const ports = livePorts ?? agent.listeningPorts ?? [];
  const subs = useMemo(
    () => (subHead?.rootSubs.length ? subHead.rootSubs : fetchedSubs ?? []),
    [fetchedSubs, subHead?.rootSubs],
  );
  const subTotalCount = Math.max(subHead?.knownCount ?? agent.subagents ?? 0, subs.length);
  const workingCount = subs.filter((s) => s.status === "working").length;
  const isLocalHost = Boolean(isTauri() && localHostId && agent.deviceId === localHostId);

  const activeTabId = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);

  const filteredSubs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return subs.filter((it) => {
      if (onlyWorking && it.status !== "working") return false;
      if (!q) return true;
      const d = parseSubagentDisplay(it);
      return (
        d.headline.toLowerCase().includes(q) ||
        (d.roleLabel?.toLowerCase().includes(q) ?? false) ||
        (it.model?.toLowerCase().includes(q) ?? false) ||
        (it.title?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [onlyWorking, query, subs]);

  useEffect(() => {
    setLivePorts(null);
    setFetchedSubs(null);
    setChildrenMap({});
    setExpanded(new Set());
    setOnlyWorking(false);
    setQuery("");
  }, [agent.key, agent.listeningPorts]);

  useEffect(() => {
    setOpen(false);
  }, [activeTabId, agent.key, selectedSpace]);

  useEffect(() => {
    if (!open || workingCount === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open, workingCount]);

  const refreshPorts = useCallback(async () => {
    setPortsLoading(true);
    try {
      const res = await rpcCall(agent.deviceId, "agent.ports", { agent: agent.key, action: "list" }, 8_000);
      setLivePorts(res.ports);
    } catch (e) {
      toast((e as Error).message || "刷新端口失败", true);
    } finally {
      setPortsLoading(false);
    }
  }, [agent.deviceId, agent.key, toast]);

  const refreshSubs = useCallback(async () => {
    setSubsLoading(true);
    try {
      const res = await rpcCall(agent.deviceId, "session.children", { agent: agent.key }, 8_000);
      setFetchedSubs(res.sessions ?? []);
      subHead?.onRefresh?.();
    } catch {
      // ignore transient rpc errors
    } finally {
      setSubsLoading(false);
    }
  }, [agent.deviceId, agent.key, subHead]);

  const closeMenu = useCallback(() => setOpen(false), []);

  const openOn = useCallback(
    (tab: RuntimeTab) => {
      if (open && activeTab === tab) {
        setOpen(false);
        return;
      }
      const el = wrapRef.current;
      if (el) setCoords(clampPopoverPos(el.getBoundingClientRect(), 386));
      setActiveTab(tab);
      setOpen(true);
      if (tab === "subs" && subs.length === 0 && subTotalCount > 0) {
        void refreshSubs();
      }
    },
    [activeTab, open, refreshSubs, subTotalCount, subs.length],
  );

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent("pocket:close-popovers", { detail: popId }));
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const onPeerOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== popId) setOpen(false);
    };
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && !wrapRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onResize = () => {
      const el = wrapRef.current;
      if (el) setCoords(clampPopoverPos(el.getBoundingClientRect(), 386));
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

  const toggleBranch = useCallback(
    (item: SubSession) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(item.key)) {
          next.delete(item.key);
        } else {
          next.add(item.key);
          if (!childrenMap[item.key] && !loadingMap[item.key]) {
            setLoadingMap((m) => ({ ...m, [item.key]: true }));
            void rpcCall(agent.deviceId, "session.children", { agent: agent.key, sub: item.key }, 8_000)
              .then((res) => setChildrenMap((c) => ({ ...c, [item.key]: res.sessions ?? [] })))
              .catch(() => {})
              .finally(() => setLoadingMap((m) => ({ ...m, [item.key]: false })));
          }
        }
        return next;
      });
    },
    [agent.deviceId, agent.key, childrenMap, loadingMap],
  );

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

  const handleStopPort = async (p: AgentListeningPort) => {
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
      if (res.ports.length === 0 && subTotalCount === 0) setOpen(false);
    } catch (e) {
      toast((e as Error).message || `停止 :${p.port} 失败`, true);
    } finally {
      setStoppingPort(null);
    }
  };

  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    const nodes = popRef.current
      ? Array.from(popRef.current.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      : [];
    if (!nodes.length) return;
    const idx = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nodes[(idx + 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nodes[(idx - 1 + nodes.length) % nodes.length]?.focus();
    }
  };

  if (ports.length === 0 && subTotalCount === 0) return null;

  const firstPort = ports[0];
  const extraPorts = Math.max(0, ports.length - 1);
  const refreshing = activeTab === "ports" ? portsLoading : subsLoading;

  return (
    <>
      <div ref={wrapRef} className="inst-triggers">
        {firstPort ? (
          <button
            type="button"
            className={`inst-btn port${open && activeTab === "ports" ? " open" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={open && activeTab === "ports"}
            aria-controls={open ? popId : undefined}
            title={`本实例监听端口 ${ports.map((p) => `:${p.port}`).join("、")}（点击预览或管理）`}
            onClick={() => openOn("ports")}
          >
            <Radio size={12} aria-hidden />
            <span className="mono">:{firstPort.port}</span>
            {extraPorts > 0 ? <span className="port-pill-extra mono">+{extraPorts}</span> : null}
          </button>
        ) : null}

        {subTotalCount > 0 ? (
          <button
            type="button"
            className={`inst-btn sub${workingCount > 0 ? " working" : ""}${open && activeTab === "subs" ? " open" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={open && activeTab === "subs"}
            aria-controls={open ? popId : undefined}
            title={`查看本实例的 ${subTotalCount} 个子 Agent`}
            onClick={() => openOn("subs")}
          >
            <span className="inst-ic-wrap" aria-hidden>
              <Bot size={13} />
              {workingCount > 0 ? <span className="inst-ic-dot" /> : null}
            </span>
            <span className="num">
              {workingCount > 0 ? `${workingCount}/${subTotalCount}` : `${subTotalCount}`}
            </span>
          </button>
        ) : null}
      </div>

      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={popRef}
              id={popId}
              role="dialog"
              aria-label="实例端口与子 Agent"
              className="sub-pop"
              style={{ top: coords.top, left: coords.left, width: coords.maxWidth }}
              onKeyDown={onTreeKeyDown}
            >
              <div className="inst-pop-head">
                <div className="inst-pop-seg" role="tablist" aria-label="实例视图">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === "ports"}
                    className={`inst-pop-tab port${activeTab === "ports" ? " active" : ""}`}
                    onClick={() => setActiveTab("ports")}
                  >
                    <Radio size={12} />
                    <span>端口 {ports.length}</span>
                  </button>
                  {subTotalCount > 0 || subHead ? (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeTab === "subs"}
                      className={`inst-pop-tab${activeTab === "subs" ? " active" : ""}`}
                      onClick={() => {
                        setActiveTab("subs");
                        if (subs.length === 0 && subTotalCount > 0) void refreshSubs();
                      }}
                    >
                      <Bot size={13} />
                      <span>子 Agent {subTotalCount}</span>
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="sub-pop-refresh"
                  title="重新扫描"
                  aria-label="重新扫描"
                  onClick={() => void (activeTab === "ports" ? refreshPorts() : refreshSubs())}
                >
                  <RefreshCw size={12} className={refreshing ? "spin" : ""} />
                </button>
              </div>

              <div className="sub-pop-body" role={activeTab === "subs" ? "tree" : undefined} style={{ padding: 8, gap: 6 }}>
                {activeTab === "ports" ? (
                  ports.length > 0 ? (
                    ports.map((p) => {
                      const displayUrl = p.url || `http://localhost:${p.port}`;
                      const isHttp = p.protocol === "http";
                      return (
                        <div key={`${p.pid}:${p.port}`} className="inst-pop-port-row">
                          <div className="row" style={{ gap: 7, minWidth: 0, flex: 1 }}>
                            <Radio size={13} style={{ color: "var(--mint-text)", flexShrink: 0 }} />
                            <span className="mono" style={{ fontWeight: 800, fontSize: 12.5, color: "var(--mint-text)" }}>
                              :{p.port}
                            </span>
                            <span className="truncate" style={{ fontWeight: 700, fontSize: 12.5, color: "var(--ink)" }} title={p.title || p.processName}>
                              {p.title || p.processName}
                            </span>
                            <span className="mono faint truncate" style={{ fontSize: 11 }}>
                              {p.processName}
                            </span>
                          </div>
                          <div className="port-pop-acts">
                            {isHttp ? (
                              <button
                                type="button"
                                className="port-act-btn primary"
                                title={isLocalHost ? "内置浏览器预览" : "远端小窗预览"}
                                onClick={() => handleOpenPreview(p, false)}
                              >
                                {isLocalHost ? <Globe size={11} /> : <ScreenShare size={11} />}
                                <span>预览</span>
                              </button>
                            ) : null}
                            {isHttp && isLocalHost && tabId && paneId ? (
                              <button
                                type="button"
                                className="port-act-btn icon"
                                title="向右分屏打开"
                                aria-label={`向右分屏打开 :${p.port}`}
                                onClick={() => handleOpenPreview(p, true)}
                              >
                                <Columns2 size={11} />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="port-act-btn icon"
                              title="复制地址"
                              aria-label={`复制 :${p.port} 地址`}
                              onClick={() => {
                                void copyToClipboard(displayUrl);
                                toast(`已复制 ${displayUrl}`);
                              }}
                            >
                              <Copy size={11} />
                            </button>
                            <button
                              type="button"
                              className="port-act-btn icon danger"
                              title={`停止 ${p.processName} (PID ${p.pid})`}
                              aria-label={`停止 :${p.port}`}
                              disabled={stoppingPort === p.port}
                              onClick={() => void handleStopPort(p)}
                            >
                              <Square size={10} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="sub-pop-notice">暂无监听端口（点右上角 ↻ 重新检测）</div>
                  )
                ) : (
                  <>
                    {subs.length >= 3 || workingCount > 0 ? (
                      <div className="inst-pop-toolbar">
                        {subs.length >= 3 ? (
                          <div className="sub-pop-search-wrap" style={{ padding: 0, flex: 1 }}>
                            <Search size={12} className="sub-pop-search-ic" style={{ left: 9 }} />
                            <input
                              type="text"
                              className="sub-pop-search"
                              style={{ paddingLeft: 28, height: 26 }}
                              value={query}
                              onChange={(e) => setQuery(e.target.value)}
                              placeholder="筛选子 Agent…"
                              aria-label="筛选子 Agent"
                            />
                          </div>
                        ) : (
                          <span className="grow" />
                        )}
                        {workingCount > 0 ? (
                          <button
                            type="button"
                            className={`inst-pop-only-active${onlyWorking ? " on" : ""}`}
                            onClick={() => setOnlyWorking((v) => !v)}
                          >
                            进行中 {workingCount}
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {subsLoading && subs.length === 0 ? (
                      <div className="sub-pop-notice">
                        <span className="act-spin" aria-hidden />
                        <span>正在加载子 Agent…</span>
                      </div>
                    ) : filteredSubs.length === 0 ? (
                      <div className="sub-pop-notice">{subs.length === 0 ? "暂无子 Agent 记录" : "没有匹配的子 Agent"}</div>
                    ) : (
                      <SubTreeRows
                        deviceId={agent.deviceId}
                        agentKey={agent.key}
                        items={filteredSubs}
                        trailPrefix={[]}
                        childrenMap={childrenMap}
                        loadingMap={loadingMap}
                        expanded={expanded}
                        now={now}
                        level={1}
                        onToggleBranch={toggleBranch}
                        onSelectSub={(s, anc) => {
                          if (subHead) subHead.onSelectSub(s, anc);
                          else openSubagentAside(agent.key, s, [...anc, s]);
                        }}
                        onOpenAside={(s, anc) => {
                          if (subHead) subHead.onOpenAside(s, anc);
                          else openSubagentAside(agent.key, s, [...anc, s]);
                        }}
                        closeMenu={closeMenu}
                      />
                    )}
                  </>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
