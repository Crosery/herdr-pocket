import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Camera,
  Columns2,
  Copy,
  ExternalLink,
  Globe,
  Hand,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  BrowserNetworkBodyResult,
  BrowserNetworkEntry,
  BrowserSpaceSummary,
  PortalInputAction,
  PortalItem,
} from "@herdr-pocket/protocol";
import { copyToClipboard } from "../lib/bridge";
import {
  computeContainedRect,
  portalStore,
  subscribeHostPortals,
  subscribePortalFrames,
} from "../lib/portalClient";
import { rpcCall } from "../lib/relay";
import { PocketBadge, PocketButton, PocketIconButton, useToast } from "./PocketUI";
import { PortalRemoteStage, type StageStreamMetrics } from "./PortalRemoteStage";
import "../styles/ai-browser.css";

type NetFilterTab = "all" | "xhr" | "doc";
type NetDetailTab = "body" | "headers";

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function shortNetPath(rawUrl: string): { path: string; host: string } {
  try {
    const u = new URL(rawUrl);
    return {
      path: `${u.pathname}${u.search}` || "/",
      host: u.host,
    };
  } catch {
    return { path: rawUrl, host: "" };
  }
}

function prettyBody(body: BrowserNetworkBodyResult): string {
  if (body.json !== undefined) {
    try {
      return JSON.stringify(body.json, null, 2);
    } catch {
      // fall through to raw body
    }
  }
  const raw = body.body || "";
  const trimmed = raw.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 400_000) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // not JSON
    }
  }
  return body.base64Encoded ? `[Base64 · ${raw.length} chars]\n${raw.slice(0, 600)}` : raw || "(响应体为空)";
}

export function AiBrowserTabPane({
  hostId,
  spaceId,
  portalId,
  title,
  onSplitBeside,
  onClosedSpace,
}: {
  hostId: string;
  spaceId: string;
  portalId?: string;
  title: string;
  onSplitBeside?: () => void;
  onClosedSpace?: () => void;
}) {
  const toast = useToast();
  const resolvedPortalId = portalId || `ptl-aib-${spaceId}`;
  const portalItem = portalStore.use((s) => s.itemsById[resolvedPortalId]);
  const frame = portalStore.use((s) => s.framesById[resolvedPortalId]);

  const [space, setSpace] = useState<BrowserSpaceSummary | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [streamMetrics, setStreamMetrics] = useState<StageStreamMetrics>({ fps: 0, kbps: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // Network Inspector state
  const [netOpen, setNetOpen] = useState(false);
  const [netTab, setNetTab] = useState<NetFilterTab>("all");
  const [netSearch, setNetSearch] = useState("");
  const [netEntries, setNetEntries] = useState<BrowserNetworkEntry[]>([]);
  const [netTotal, setNetTotal] = useState(0);
  const [netLoading, setNetLoading] = useState(false);
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [netDetailTab, setNetDetailTab] = useState<NetDetailTab>("body");
  const [selectedBody, setSelectedBody] = useState<BrowserNetworkBodyResult | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);

  // Stage size measurement for accurate ghost cursor mapping
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const [stageBox, setStageBox] = useState({ width: 960, height: 540 });
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setStageBox({ width: r.width, height: r.height });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await rpcCall(hostId, "browser.status", {}, 8_000);
      const found = st.spaces.find((sp) => sp.id === spaceId) ?? null;
      setSpace(found);
      if (found) {
        const activePg = found.pages.find((p) => p.active) ?? found.pages[0];
        if (activePg?.url && !urlFocused) setUrlDraft(activePg.url);
      }
    } catch {
      // ignore transient errors while reconnecting
    }
  }, [hostId, spaceId, urlFocused]);

  // Keep host portals & browser status fresh
  useEffect(() => {
    const stopHost = subscribeHostPortals(hostId);
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 3_000);
    return () => {
      stopHost();
      clearInterval(timer);
    };
  }, [hostId, refreshStatus]);

  // Trigger fast status refresh whenever portal metadata changes (activePage, ownership, networkCount)
  useEffect(() => {
    if (!portalItem) return;
    void refreshStatus();
  }, [
    portalItem?.aiBrowserPageLabel,
    portalItem?.aiBrowserOwnership,
    portalItem?.url,
    refreshStatus,
  ]);

  // Subscribe live CDP frames for this AI browser space
  useEffect(() => {
    if (!portalItem && !space?.pages.length) return;
    const maxWidth = Math.min(1440, Math.max(960, Math.round(stageBox.width * Math.min(2, window.devicePixelRatio || 1))));
    return subscribePortalFrames(hostId, resolvedPortalId, {
      fps: 24,
      maxWidth,
      quality: 82,
      showCursor: true,
    });
  }, [hostId, portalItem?.id, resolvedPortalId, space?.pages.length, stageBox.width]);

  // Sync address bar with live URL
  const activePage = useMemo(() => {
    if (!space?.pages.length) return null;
    return space.pages.find((p) => p.active) ?? space.pages[0] ?? null;
  }, [space]);

  const currentUrl = frame?.url || activePage?.url || portalItem?.url || "";
  useEffect(() => {
    if (!urlFocused && currentUrl && currentUrl !== "about:blank") {
      setUrlDraft(currentUrl);
    }
  }, [currentUrl, urlFocused]);

  // Ghost cursor fade timer
  const activeCursor = portalItem?.aiBrowserCursor ?? space?.cursor;
  useEffect(() => {
    if (!activeCursor) return;
    setNowTick(Date.now());
    const t = setTimeout(() => setNowTick(Date.now()), 6500);
    return () => clearTimeout(t);
  }, [activeCursor?.at]);

  // Network Inspector polling when drawer is open
  const fetchNetworkList = useCallback(async () => {
    if (!space?.pages.length && !portalItem) return;
    setNetLoading(true);
    try {
      const resourceTypes =
        netTab === "xhr" ? ["XHR", "Fetch"] : netTab === "doc" ? ["Document"] : undefined;
      const res = await rpcCall(
        hostId,
        "browser.net",
        {
          spaceId,
          page: activePage?.label,
          action: "list",
          ...(netSearch.trim() ? { filter: netSearch.trim() } : {}),
          ...(resourceTypes ? { resourceTypes } : {}),
          limit: 160,
        },
        8_000,
      );
      setNetEntries(res.requests ?? []);
      setNetTotal(res.total ?? (res.requests?.length ?? 0));
    } catch {
      // ignore if page is navigating
    } finally {
      setNetLoading(false);
    }
  }, [activePage?.label, hostId, netSearch, netTab, portalItem, space?.pages.length, spaceId]);

  useEffect(() => {
    if (!netOpen) return;
    void fetchNetworkList();
    const timer = setInterval(() => void fetchNetworkList(), 1_600);
    return () => clearInterval(timer);
  }, [fetchNetworkList, netOpen]);

  // Load selected response body lazily
  const selectRequest = useCallback(
    async (entry: BrowserNetworkEntry) => {
      setSelectedReqId(entry.requestId);
      setSelectedBody(null);
      setBodyLoading(true);
      try {
        const res = await rpcCall(
          hostId,
          "browser.net",
          {
            spaceId,
            page: activePage?.label,
            action: "body",
            requestId: entry.requestId,
          },
          10_000,
        );
        setSelectedBody(res.body ?? null);
      } catch (err) {
        setSelectedBody({
          requestId: entry.requestId,
          url: entry.url,
          status: entry.status,
          mimeType: entry.mimeType,
          base64Encoded: false,
          body: `无法读取响应体：${(err as Error)?.message || "响应体未缓存或已被清理"}`,
        });
      } finally {
        setBodyLoading(false);
      }
    },
    [activePage?.label, hostId, spaceId],
  );

  const runAct = useCallback(
    async (
      opLabel: string,
      params: Parameters<typeof rpcCall<"browser.act">>[2],
      successMsg?: string,
    ) => {
      setBusyOp(opLabel);
      try {
        const res = await rpcCall(hostId, "browser.act", { spaceId, ...params }, 30_000);
        if (successMsg) toast(successMsg);
        await refreshStatus();
        return res;
      } catch (err) {
        toast((err as Error)?.message || "浏览器操作失败", true);
        return null;
      } finally {
        setBusyOp(null);
      }
    },
    [hostId, refreshStatus, spaceId, toast],
  );

  const handleNavigateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let target = urlDraft.trim();
    if (!target) return;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
      target = target.includes(".") && !target.includes(" ")
        ? `https://${target}`
        : `https://www.bing.com/search?q=${encodeURIComponent(target)}`;
    }
    setUrlFocused(false);
    const hasPages = Boolean(space?.pages.length);
    await runAct("navigate", {
      op: hasPages ? "navigate" : "open",
      url: target,
      page: activePage?.label ?? "p1",
    });
  };

  const handleSendInput = useCallback(
    async (input: PortalInputAction) => {
      try {
        await rpcCall(hostId, "portal.input", { portalId: resolvedPortalId, input }, 6_000);
      } catch {
        // ignore transient pointer errors
      }
    },
    [hostId, resolvedPortalId],
  );

  const ownership = portalItem?.aiBrowserOwnership ?? space?.ownership ?? "agentWorking";
  const statusText =
    portalItem?.aiBrowserStatusText ??
    space?.statusText ??
    (ownership === "agentHandoff"
      ? space?.handoffReason || "AI 需要你协助完成后再继续"
      : ownership === "user"
        ? "当前由你接管，可直接点击、滚轮和键盘输入"
        : "AI 正在操控内置跨平台 Chromium 会话");
  const networkCount = portalItem?.aiBrowserNetworkCount ?? space?.networkCount ?? netTotal;

  const syntheticItem: PortalItem = useMemo(
    () =>
      portalItem ?? {
        id: resolvedPortalId,
        hostId,
        kind: "browser",
        title: space?.name || title || "AI 浏览器",
        url: currentUrl || "about:blank",
        canInteract: true,
        width: frame?.width ?? 1280,
        height: frame?.height ?? 800,
        createdAt: space?.createdAt ?? Date.now(),
        updatedAt: space?.updatedAt ?? Date.now(),
        aiBrowserSpaceId: spaceId,
        aiBrowserPageLabel: activePage?.label ?? "p1",
        aiBrowserOwnership: ownership,
      },
    [activePage?.label, currentUrl, frame?.height, frame?.width, hostId, ownership, portalItem, resolvedPortalId, space, spaceId, title],
  );

  const showGhostCursor = Boolean(
    activeCursor &&
      ownership === "agentWorking" &&
      nowTick - activeCursor.at < 6_500 &&
      frame,
  );

  const ghostOverlayGeometry = useMemo(() => {
    if (!showGhostCursor || !activeCursor) return null;
    const imgW = frame?.width ?? syntheticItem.width ?? 1280;
    const imgH = frame?.height ?? syntheticItem.height ?? 800;
    const { drawLeft, drawTop, drawW, drawH } = computeContainedRect(
      stageBox.width,
      stageBox.height,
      imgW,
      imgH,
    );
    const z = Math.max(1, zoom);
    const destX = stageBox.width / 2 + pan.x + (drawLeft - stageBox.width / 2) * z;
    const destY = stageBox.height / 2 + pan.y + (drawTop - stageBox.height / 2) * z;
    const destW = drawW * z;
    const destH = drawH * z;
    const vw = Math.max(1, activeCursor.viewportW || imgW);
    const vh = Math.max(1, activeCursor.viewportH || imgH);
    const nx = Math.min(1, Math.max(0, activeCursor.x / vw));
    const ny = Math.min(1, Math.max(0, activeCursor.y / vh));
    return {
      x: destX + nx * destW,
      y: destY + ny * destH,
      box: activeCursor.box
        ? {
            left: destX + (activeCursor.box.x / vw) * destW,
            top: destY + (activeCursor.box.y / vh) * destH,
            width: Math.max(8, (activeCursor.box.width / vw) * destW),
            height: Math.max(8, (activeCursor.box.height / vh) * destH),
          }
        : null,
      label: activeCursor.label,
    };
  }, [activeCursor, frame?.height, frame?.width, pan.x, pan.y, showGhostCursor, stageBox.height, stageBox.width, syntheticItem.height, syntheticItem.width, zoom]);

  const selectedEntry = useMemo(
    () => netEntries.find((e) => e.requestId === selectedReqId) ?? null,
    [netEntries, selectedReqId],
  );

  const hasLiveSession = Boolean(space?.pages.length || portalItem || frame);

  return (
    <div className="aib-root" data-testid="ai-browser-tab-pane">
      {/* Top chrome: sub-tabs + nav + address bar */}
      <div className="aib-top-strip">
        <div className="aib-subtabs-row">
          <div className="aib-subtabs-list" role="tablist" aria-label="AI 浏览器标签页">
            {(space?.pages ?? []).map((pg) => (
              <div
                key={pg.label}
                role="tab"
                tabIndex={0}
                aria-selected={Boolean(pg.active)}
                className={`aib-subtab${pg.active ? " is-active" : ""}`}
                title={`${pg.label} · ${pg.title || pg.url}`}
                onClick={() => {
                  if (!pg.active) {
                    void runAct("switch", { op: "tabs", tabAction: "switch", page: pg.label });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    if (!pg.active) {
                      void runAct("switch", { op: "tabs", tabAction: "switch", page: pg.label });
                    }
                  }
                }}
              >
                <span className="aib-subtab-id mono">{pg.label}</span>
                <span className="aib-subtab-title">{pg.title || pg.url || "新标签页"}</span>
                {(space?.pages.length ?? 0) > 1 ? (
                  <button
                    type="button"
                    className="aib-subtab-x"
                    aria-label={`关闭页面 ${pg.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void runAct("closeTab", { op: "tabs", tabAction: "close", page: pg.label });
                    }}
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </div>
            ))}
            <PocketIconButton
              size="sm"
              tooltip="新建子标签页"
              aria-label="新建子标签页"
              disabled={busyOp !== null}
              onClick={() =>
                void runAct("newTab", {
                  op: "tabs",
                  tabAction: "open",
                  url: "about:blank",
                })
              }
            >
              <Plus size={13} />
            </PocketIconButton>
          </div>
          <div className="aib-collab-actions">
            {streamMetrics.fps > 0 ? (
              <PocketBadge tone="neutral">
                <span className="mono">{streamMetrics.fps} fps · {streamMetrics.kbps} KB/s</span>
              </PocketBadge>
            ) : null}
            {onSplitBeside ? (
              <PocketButton size="sm" variant="ghost" onClick={onSplitBeside}>
                <Columns2 size={13} />
                <span>分屏</span>
              </PocketButton>
            ) : null}
            <PocketButton
              size="sm"
              variant="ghost"
              disabled={busyOp !== null || !hasLiveSession}
              onClick={() =>
                void runAct("popout", { op: "popout", url: currentUrl || undefined }, "已在有头浏览器窗口打开当前页")
              }
            >
              <ExternalLink size={13} />
              <span>弹出窗口</span>
            </PocketButton>
          </div>
        </div>

        <div className="aib-nav-row">
          <PocketIconButton
            size="sm"
            tooltip="后退"
            aria-label="后退"
            disabled={busyOp !== null || !hasLiveSession}
            onClick={() => void runAct("back", { op: "back", page: activePage?.label })}
          >
            <ArrowLeft size={14} />
          </PocketIconButton>
          <PocketIconButton
            size="sm"
            tooltip="前进"
            aria-label="前进"
            disabled={busyOp !== null || !hasLiveSession}
            onClick={() => void runAct("forward", { op: "forward", page: activePage?.label })}
          >
            <ArrowRight size={14} />
          </PocketIconButton>
          <PocketIconButton
            size="sm"
            tooltip="刷新页面"
            aria-label="刷新页面"
            disabled={busyOp !== null || !hasLiveSession}
            onClick={() => void runAct("reload", { op: "reload", page: activePage?.label })}
          >
            <RotateCw size={14} className={busyOp === "reload" ? "pk-spin" : undefined} />
          </PocketIconButton>
          <form className="aib-url-form" onSubmit={(e) => void handleNavigateSubmit(e)}>
            <span className="aib-url-icon" aria-hidden>
              <Globe size={13} />
            </span>
            <input
              type="text"
              className="aib-url-input mono"
              value={urlDraft}
              placeholder="输入网址并按 Enter 打开，例如 https://www.bilibili.com"
              aria-label="AI 浏览器地址栏"
              onFocus={() => setUrlFocused(true)}
              onBlur={() => setUrlFocused(false)}
              onChange={(e) => setUrlDraft(e.target.value)}
            />
          </form>
          <PocketIconButton
            size="sm"
            tooltip="截图"
            aria-label="截图"
            disabled={busyOp !== null || !hasLiveSession}
            onClick={async () => {
              const res = await runAct("screenshot", { op: "screenshot", page: activePage?.label });
              if (res?.screenshotPath) {
                toast(`截图已保存：${res.screenshotPath}`);
              }
            }}
          >
            <Camera size={14} />
          </PocketIconButton>
        </div>
      </div>

      {/* Live AI Collaboration & Handoff Bar */}
      <div className={`aib-collab-bar${ownership === "agentHandoff" ? " is-handoff" : ""}`}>
        <div className="aib-collab-status">
          <span
            className={`aib-pulse-dot ${
              ownership === "agentHandoff"
                ? "is-handoff"
                : ownership === "user"
                  ? "is-user"
                  : "is-working"
            }`}
            aria-hidden
          />
          <PocketBadge
            tone={
              ownership === "agentHandoff"
                ? "pink"
                : ownership === "user"
                  ? "mint"
                  : "lav"
            }
          >
            {ownership === "agentHandoff"
              ? "等你接管"
              : ownership === "user"
                ? "你已接管"
                : "AI 操作中"}
          </PocketBadge>
          <span className="aib-collab-text truncate" title={statusText}>
            {statusText}
          </span>
        </div>

        <div className="aib-collab-actions">
          {ownership === "agentWorking" ? (
            <PocketButton
              size="sm"
              variant="soft"
              disabled={busyOp !== null || !hasLiveSession}
              onClick={() => void runAct("takeover", { op: "takeover" }, "已切换为你接管，可直接操作页面")}
            >
              <Hand size={13} />
              <span>我来接管</span>
            </PocketButton>
          ) : (
            <PocketButton
              size="sm"
              variant="primary"
              disabled={busyOp !== null || !hasLiveSession}
              onClick={() => void runAct("resume", { op: "resume" }, "已交还 AI 继续执行")}
            >
              <Play size={13} />
              <span>已完成，交还 AI</span>
            </PocketButton>
          )}
          <PocketButton
            size="sm"
            variant={netOpen ? "primary" : "soft"}
            onClick={() => setNetOpen((v) => !v)}
          >
            <Activity size={13} />
            <span>网络抓包 ({networkCount})</span>
          </PocketButton>
          {hasLiveSession ? (
            <PocketButton
              size="sm"
              variant="ghost"
              disabled={busyOp !== null}
              onClick={async () => {
                const res = await runAct("finish", { op: "finish", keep: [] }, "已结束 AI 浏览空间");
                if (res?.ok) onClosedSpace?.();
              }}
            >
              <Square size={12} />
              <span>结束空间</span>
            </PocketButton>
          ) : null}
        </div>
      </div>

      {/* Main Stage + Optional Network Inspector */}
      <div className="aib-body">
        <div className="aib-stage-wrap" ref={stageWrapRef}>
          {hasLiveSession ? (
            <>
              <PortalRemoteStage
                item={syntheticItem}
                frame={frame}
                controlMode="pointer"
                showRemoteCursor
                zoom={zoom}
                pan={pan}
                onPanChange={setPan}
                onZoomChange={setZoom}
                latchedMods={[]}
                onConsumeLatchedMods={() => {}}
                onSendInput={handleSendInput}
                onMetricsChange={setStreamMetrics}
                placeholder={
                  <div className="aib-empty">
                    <div className="aib-empty-card">
                      <div className="aib-empty-head">
                        <span className="aib-empty-icon">
                          <Sparkles size={18} />
                        </span>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: "calc(13.5px * var(--ts, 1))" }}>
                            正在连接内置 Chromium CDP 画面…
                          </div>
                          <div style={{ fontSize: "calc(12px * var(--ts, 1))", color: "var(--muted)", marginTop: 2 }}>
                            无焦点抢占后台渲染，支持真实键鼠、弹窗接管与全程 HTTP 抓包。
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                }
              />
              {ghostOverlayGeometry ? (
                <div className="aib-ghost-layer" aria-hidden>
                  {ghostOverlayGeometry.box ? (
                    <div
                      className="aib-ghost-box"
                      style={{
                        left: ghostOverlayGeometry.box.left,
                        top: ghostOverlayGeometry.box.top,
                        width: ghostOverlayGeometry.box.width,
                        height: ghostOverlayGeometry.box.height,
                      }}
                    />
                  ) : null}
                  <div
                    className="aib-ghost-pointer"
                    style={{
                      left: ghostOverlayGeometry.x,
                      top: ghostOverlayGeometry.y,
                    }}
                  >
                    <svg width="20" height="22" viewBox="0 0 20 22" fill="none">
                      <path
                        d="M2.5 1.8L17.4 10.6L10.3 12.1L7.3 19.2L2.5 1.8Z"
                        fill="var(--primary)"
                        stroke="#FFFFFF"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {ghostOverlayGeometry.label ? (
                      <span className="aib-ghost-pill">{ghostOverlayGeometry.label}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="aib-empty">
              <div className="aib-empty-card">
                <div className="aib-empty-head">
                  <span className="aib-empty-icon">
                    <Globe size={18} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: "calc(14px * var(--ts, 1))" }}>
                      内置跨平台 AI 浏览器已就绪
                    </div>
                    <div style={{ fontSize: "calc(12px * var(--ts, 1))", color: "var(--muted)", marginTop: 2 }}>
                      输入任意网址立即打开，或在终端运行 <code className="mono">herdr-pocket browser run</code> 让 AI 操控并实时回传到这里。
                    </div>
                  </div>
                </div>
                <div className="aib-empty-presets">
                  {[
                    { label: "B 站", url: "https://www.bilibili.com" },
                    { label: "GitHub", url: "https://github.com" },
                    { label: "Example", url: "https://example.com" },
                  ].map((p) => (
                    <PocketButton
                      key={p.url}
                      size="sm"
                      variant="soft"
                      disabled={busyOp !== null}
                      onClick={() =>
                        void runAct("open", { op: "open", url: p.url, page: "p1", label: `打开 ${p.label}` })
                      }
                    >
                      <Globe size={12} />
                      <span>{p.label}</span>
                    </PocketButton>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Collapsible Network Inspector Drawer */}
        {netOpen ? (
          <div className="aib-net-drawer" data-testid="ai-browser-net-drawer">
            <div className="aib-net-head">
              <div className="aib-net-filters">
                <div className="segmented" role="tablist" aria-label="抓包过滤类型">
                  {(
                    [
                      { id: "all", label: "全部" },
                      { id: "xhr", label: "Fetch/XHR" },
                      { id: "doc", label: "文档" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={netTab === t.id}
                      className={netTab === t.id ? "active" : undefined}
                      onClick={() => setNetTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  className="aib-net-search mono"
                  value={netSearch}
                  placeholder="按 URL / 接口路径筛选…"
                  aria-label="按 URL 筛选网络请求"
                  onChange={(e) => setNetSearch(e.target.value)}
                />
                <PocketBadge tone="neutral">
                  <span className="mono">{netEntries.length} / {netTotal}</span>
                </PocketBadge>
              </div>
              <div className="aib-collab-actions">
                <PocketIconButton
                  size="sm"
                  tooltip="刷新抓包列表"
                  aria-label="刷新抓包列表"
                  disabled={netLoading}
                  onClick={() => void fetchNetworkList()}
                >
                  <RefreshCw size={13} className={netLoading ? "pk-spin" : undefined} />
                </PocketIconButton>
                <PocketIconButton
                  size="sm"
                  tooltip="清空抓包"
                  aria-label="清空抓包"
                  onClick={async () => {
                    try {
                      await rpcCall(hostId, "browser.net", {
                        spaceId,
                        page: activePage?.label,
                        action: "clear",
                      });
                      setNetEntries([]);
                      setNetTotal(0);
                      setSelectedReqId(null);
                      setSelectedBody(null);
                    } catch (err) {
                      toast((err as Error)?.message || "清空失败", true);
                    }
                  }}
                >
                  <Trash2 size={13} />
                </PocketIconButton>
                <PocketIconButton size="sm" tooltip="收起网络抓包" aria-label="收起网络抓包" onClick={() => setNetOpen(false)}>
                  <X size={13} />
                </PocketIconButton>
              </div>
            </div>

            <div className="aib-net-body">
              <div className="aib-net-list">
                {netEntries.length === 0 ? (
                  <div className="aib-net-empty">
                    {netLoading ? "正在读取抓包记录…" : "暂无匹配的 HTTP 请求（打开或操作网页后将自动记录）"}
                  </div>
                ) : (
                  netEntries.map((entry) => {
                    const { path, host } = shortNetPath(entry.url);
                    const statusTone =
                      entry.failed || (entry.status !== undefined && entry.status >= 400)
                        ? "is-err"
                        : entry.status !== undefined && entry.status >= 200 && entry.status < 300
                          ? "is-ok"
                          : "is-mid";
                    return (
                      <button
                        key={entry.requestId}
                        type="button"
                        className={`aib-net-row${selectedReqId === entry.requestId ? " is-selected" : ""}`}
                        onClick={() => void selectRequest(entry)}
                      >
                        <span className="aib-net-method mono">{entry.method}</span>
                        <span className={`aib-net-status mono ${statusTone}`}>
                          {entry.failed ? "ERR" : entry.status ?? "…"}
                        </span>
                        <span className="truncate mono" title={entry.url}>
                          {path}
                          {host ? <span style={{ color: "var(--faint)", marginLeft: 6 }}>{host}</span> : null}
                        </span>
                        <span className="mono" style={{ color: "var(--muted)", textAlign: "right" }}>
                          {entry.durationMs !== undefined ? `${entry.durationMs}ms` : "-"}
                        </span>
                        <span className="mono" style={{ color: "var(--faint)", textAlign: "right" }}>
                          {formatBytes(entry.encodedDataLength)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="aib-net-detail">
                {selectedEntry ? (
                  <>
                    <div className="aib-net-detail-head">
                      <div className="segmented" role="tablist" aria-label="请求详情视图">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={netDetailTab === "body"}
                          className={netDetailTab === "body" ? "active" : undefined}
                          onClick={() => setNetDetailTab("body")}
                        >
                          响应体
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={netDetailTab === "headers"}
                          className={netDetailTab === "headers" ? "active" : undefined}
                          onClick={() => setNetDetailTab("headers")}
                        >
                          Headers
                        </button>
                      </div>
                      <PocketButton
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const text =
                            netDetailTab === "body"
                              ? selectedBody
                                ? prettyBody(selectedBody)
                                : ""
                              : JSON.stringify(
                                  {
                                    url: selectedEntry.url,
                                    method: selectedEntry.method,
                                    status: selectedEntry.status,
                                    requestHeaders: selectedEntry.requestHeaders ?? {},
                                    responseHeaders: selectedEntry.responseHeaders ?? {},
                                  },
                                  null,
                                  2,
                                );
                          void copyToClipboard(text);
                          toast("已复制到剪贴板");
                        }}
                      >
                        <Copy size={12} />
                        <span>复制</span>
                      </PocketButton>
                    </div>
                    <div className="aib-net-detail-url mono">
                      <strong>{selectedEntry.method}</strong> {selectedEntry.url}
                    </div>
                    {netDetailTab === "body" ? (
                      <pre className="aib-net-code mono">
                        {bodyLoading
                          ? "正在读取响应体…"
                          : selectedBody
                            ? prettyBody(selectedBody)
                            : "点击左侧任意请求查看响应体 JSON/文本"}
                      </pre>
                    ) : (
                      <pre className="aib-net-code mono">
                        {JSON.stringify(
                          {
                            status: selectedEntry.status,
                            statusText: selectedEntry.statusText,
                            resourceType: selectedEntry.resourceType,
                            mimeType: selectedEntry.mimeType,
                            durationMs: selectedEntry.durationMs,
                            fromCache: selectedEntry.fromCache,
                            requestHeaders: selectedEntry.requestHeaders ?? {},
                            responseHeaders: selectedEntry.responseHeaders ?? {},
                            ...(selectedEntry.postData ? { postData: selectedEntry.postData } : {}),
                          },
                          null,
                          2,
                        )}
                      </pre>
                    )}
                  </>
                ) : (
                  <div className="aib-net-empty">点击左侧任意请求查看响应体 JSON 与请求头</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
