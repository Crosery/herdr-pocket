import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Columns2, Laptop, PanelLeft, Pencil, Plus, QrCode, Rows2, Search, Server, Settings, SquareArrowOutUpRight, Terminal, Trash2 } from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { VendorIcon } from "../components/MascotAndVendor";
import { PocketButton, PocketInput, PocketModal, overlayStore, useToast } from "../components/PocketUI";
import { serverLabel } from "../components/Sidebar";
import { assetUrl } from "../lib/bridge";
import { useLocalHostDeviceId } from "../lib/fonts";
import { isMockServer } from "../lib/mock";
import { pingRelay, refreshHostSpaces, rpcCall } from "../lib/relay";
import {
  agentSpace,
  allAgents,
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  liveStore,
  settingsStore,
  spacedTitle,
  updateSettings,
  type SidebarAgentGrouping,
  type SidebarStyleScheme,
} from "../lib/store";
import { setInteractiveResizeActive } from "./splitMotion";
import { updateStore } from "../lib/updates";
import { useVisibleTick } from "../lib/layout";
import { endPanelDrag, startPanelDrag } from "../lib/fileDrag";
import { lastChange, listGroup, shortAgo, type ListGroup } from "./agentInfo";
import { pullHostDocNow } from "./herdrDocSync";
import { formatSidebarAgentRow } from "./sidebarAgentRow";
import {
  buildSidebarAgentSections,
  computeWorkspaceTopology,
  formatCompactDeviceBadge,
  formatTopologyBadge,
  getAgentPlacement,
  type AgentRowJoinRole,
  type AgentTopologyPlacement,
  type CompactDeviceBadge,
  type SidebarAgentItem,
} from "./sidebarTopology";
import { SPACE_ICON_PRESETS, SpaceTileIcon, setCustomSpaceIcon, spaceIconStore } from "./spaceIcon";
import {
  activeTabIdForSpace,
  closeTabsForSpace,
  focusedLeafOfTab,
  focusTabPane,
  openAgentTab,
  openSettingsFrame,
  renameSpaceInShellStore,
  setActiveTab,
  setPalette,
  setSelectedSpace,
  shellStore,
  splitActivePaneWithContent,
  tabLeaves,
} from "./shellStore";
import { shortcutText } from "./shortcuts";
import { SpatialHint } from "./useModifierHoldHints";
import { buildHostSpaces, spaceColorVars, type SidebarSpace } from "./spaceSync";

const FOLD_KEY = "herdr-pocket-v3-folded";
const SPACES_RATIO_KEY = "herdr-pocket-v3-spaces-ratio";

function clampSpacesRatio(r: unknown): number | null {
  if (typeof r !== "number" || !Number.isFinite(r)) return null;
  return Math.max(0.18, Math.min(0.72, Number(r.toFixed(3))));
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage off: the choice lasts for this session.
  }
}

/** Fixed compact device badge (`本机` / short remote host) for narrow sidebars and settings previews. */
export function SidebarDeviceChip({
  label,
  fullLabel,
  isLocal,
}: {
  label: string;
  fullLabel?: string;
  isLocal: boolean;
}) {
  return (
    <span className={`v3-dev-chip ${isLocal ? "is-local" : "is-remote"}`} title={fullLabel || label}>
      {isLocal ? <Laptop size={9.5} /> : <Server size={9.5} />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Minimal geometric window/split glyph replacing opaque text codes in Scheme C (no emoji). */
export function SplitMatrixGlyph({ placement }: { placement: AgentTopologyPlacement }) {
  if (placement.isBackground) {
    return (
      <span className="v3-win-glyph is-bg" title="后台未打开标签页（点击自动打开）">
        <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
          <rect x="1" y="1" width="10" height="8" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.5" />
        </svg>
        <span>后台</span>
      </span>
    );
  }
  if (!placement.isSplit || placement.paneCount <= 1) {
    const pageNum = placement.pageNumber;
    return (
      <span className="v3-win-glyph" title={pageNum !== null ? `位于第 ${pageNum} 个独立标签页` : "独立标签页"}>
        <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
          <rect x="1" y="1" width="10" height="8" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.35" />
        </svg>
        {pageNum !== null ? <span>{pageNum}页</span> : null}
      </span>
    );
  }
  if (placement.paneCount === 2) {
    const s1 = placement.paneIndex === 1;
    const s2 = placement.paneIndex === 2;
    return (
      <span className="v3-win-glyph is-split" title={`同窗口 2 分屏（第 ${placement.paneIndex}/2 格）`}>
        <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
          <rect
            x="1"
            y="1"
            width="5.5"
            height="8"
            rx="1.1"
            fill={s1 ? "currentColor" : "none"}
            fillOpacity={s1 ? 0.88 : 0}
            stroke="currentColor"
            strokeWidth="1.1"
          />
          <rect
            x="7.5"
            y="1"
            width="5.5"
            height="8"
            rx="1.1"
            fill={s2 ? "currentColor" : "none"}
            fillOpacity={s2 ? 0.88 : 0}
            stroke="currentColor"
            strokeWidth="1.1"
          />
        </svg>
        <span>{placement.paneIndex}/2</span>
      </span>
    );
  }
  const leftOn = placement.paneIndex === 1;
  const midOn = placement.paneIndex > 1 && placement.paneIndex < placement.paneCount;
  const rightOn = placement.paneIndex >= placement.paneCount;
  return (
    <span className="v3-win-glyph is-split" title={`同窗口 ${placement.paneCount} 分屏（第 ${placement.paneIndex}/${placement.paneCount} 格）`}>
      <svg width="15" height="10" viewBox="0 0 15 10" aria-hidden="true">
        <rect
          x="1"
          y="1"
          width="3.5"
          height="8"
          rx="0.9"
          fill={leftOn ? "currentColor" : "none"}
          fillOpacity={leftOn ? 0.88 : 0}
          stroke="currentColor"
          strokeWidth="1"
        />
        <rect
          x="5.75"
          y="1"
          width="3.5"
          height="8"
          rx="0.9"
          fill={midOn ? "currentColor" : "none"}
          fillOpacity={midOn ? 0.88 : 0}
          stroke="currentColor"
          strokeWidth="1"
        />
        <rect
          x="10.5"
          y="1"
          width="3.5"
          height="8"
          rx="0.9"
          fill={rightOn ? "currentColor" : "none"}
          fillOpacity={rightOn ? 0.88 : 0}
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
      <span>{placement.paneIndex}/{placement.paneCount}</span>
    </span>
  );
}

/** Status mark at the right of a row: spinner, 需要你 chip, done dot or idle ring. */
export function StatusMark({ group, compact = false }: { group: ListGroup; compact?: boolean }) {
  if (group === "working") return <span className="v3-spinner" aria-label="运行中" />;
  if (group === "blocked") return compact ? <span className="v3-need small" aria-label="需要你">!</span> : <span className="v3-need">需要你</span>;
  if (group === "done") return <span className="v3-dot done" aria-label="已完成" />;
  return <span className={`v3-ring${group === "offline" ? " off" : ""}`} aria-label={group === "offline" ? "离线" : "空闲"} />;
}

const SidebarAgentRow = memo(function SidebarAgentRow({
  agent,
  group,
  primary,
  secondary,
  deviceChip,
  tooltipText,
  ageLabel,
  compactBlocked,
  collapsed,
  isFocusedAgent,
  isInSplit,
  showTopology,
  styleScheme,
  inCluster,
  placement,
  joinRole,
  splitPeerHover,
  spaceColorFg,
  onHoverSplit,
  onOpenAgent,
  onContextMenuAgent,
}: {
  agent: Agent;
  group: ListGroup;
  primary: string;
  secondary?: string | null;
  deviceChip?: CompactDeviceBadge | null;
  tooltipText: string;
  ageLabel: string;
  compactBlocked: boolean;
  collapsed: boolean;
  isFocusedAgent: boolean;
  isInSplit: boolean;
  showTopology: boolean;
  styleScheme: SidebarStyleScheme;
  inCluster?: boolean;
  placement?: AgentTopologyPlacement;
  joinRole: AgentRowJoinRole;
  splitPeerHover: boolean;
  spaceColorFg?: string | null;
  onHoverSplit: (tabId: string | null) => void;
  onOpenAgent: (agent: Agent, mods: { altKey: boolean; shiftKey: boolean }) => void;
  onContextMenuAgent: (x: number, y: number, agent: Agent) => void;
}) {
  const showGlyph = !inCluster && showTopology && styleScheme === "c" && Boolean(placement);
  const badge = !inCluster && showTopology && styleScheme !== "c" && placement ? formatTopologyBadge(placement) : null;
  const subLabel = inCluster && showTopology && placement?.isSplit ? `分屏格 ${placement.paneIndex}/${placement.paneCount}` : secondary;
  const showDeviceChip = !inCluster && Boolean(deviceChip);
  const hasSubLine = Boolean(subLabel || showDeviceChip || badge || showGlyph);
  const joinClass = showTopology && joinRole !== "single" ? ` ${joinRole}` : "";
  const splitPeerClass = showTopology && splitPeerHover ? " is-split-peer-hover" : "";
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      data-tauri-drag-region="false"
      className={`v3-row v3-agent${hasSubLine && !collapsed ? " has-sub" : ""}${isFocusedAgent ? " selected" : isInSplit ? " in-split" : ""}${joinClass}${splitPeerClass}${group === "offline" ? " dim" : ""}`}
      title={tooltipText}
      onMouseEnter={() => {
        if (showTopology && placement?.isSplit && placement.tabId) onHoverSplit(placement.tabId);
      }}
      onMouseLeave={() => {
        if (showTopology && placement?.isSplit && placement.tabId) onHoverSplit(null);
      }}
      onDragStart={(e) => startPanelDrag(e, { kind: "agent", agentKey: agent.key })}
      onDragEnd={() => endPanelDrag()}
      onClick={(e) => onOpenAgent(agent, { altKey: e.altKey, shiftKey: e.shiftKey })}
      onContextMenu={(e) => {
        if (collapsed) return;
        e.preventDefault();
        onContextMenuAgent(e.clientX, e.clientY, agent);
      }}
      onKeyDown={(e) =>
        (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpenAgent(agent, { altKey: false, shiftKey: false }))
      }
    >
      <VendorIcon harness={agent.harness} isShell={agent.isShell} size={16} />
      {collapsed ? (
        group === "blocked" ? <span className="v3-corner blocked" aria-label="需要你" /> : null
      ) : (
        <div className="v3-agent-body">
          <div className="v3-agent-top">
            <span className="v3-agent-title v3-row-label truncate">{primary}</span>
            <span className="v3-time">{ageLabel}</span>
            <StatusMark group={group} compact={compactBlocked} />
          </div>
          {hasSubLine ? (
            <div className="v3-agent-sub">
              <span className="v3-agent-sub-main">
                {showDeviceChip && deviceChip ? (
                  <SidebarDeviceChip label={deviceChip.label} fullLabel={deviceChip.fullLabel} isLocal={deviceChip.isLocal} />
                ) : null}
                {subLabel ? (
                  <>
                    {showTopology && spaceColorFg ? (
                      <span className="v3-space-dot" style={{ backgroundColor: spaceColorFg }} aria-hidden="true" />
                    ) : null}
                    <span className="truncate">{subLabel}</span>
                  </>
                ) : null}
              </span>
              {showGlyph && placement ? (
                <SplitMatrixGlyph placement={placement} />
              ) : badge ? (
                <span
                  className={`v3-topo-badge is-${badge.kind}`}
                  title={
                    badge.kind === "split" && placement
                      ? `与另外 ${placement.paneCount - 1} 个窗格在同一窗口分屏（第 ${placement.paneIndex}/${placement.paneCount} 屏）`
                      : badge.kind === "page" && placement
                        ? `位于该空间第 ${placement.pageNumber ?? 1} 个独立标签页`
                        : "尚未在主区打开标签页（点击自动打开）"
                  }
                >
                  {badge.kind === "split" ? <Columns2 size={10} /> : null}
                  <span>{badge.label}</span>
                  {badge.slot ? <span className="v3-topo-slot">{badge.slot}</span> : null}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});

const SidebarSpaceRow = memo(function SidebarSpaceRow({
  space,
  machineName,
  machineOnline,
  collapsed,
  selected,
  showTopology,
  pageCount,
  splitPageCount,
  paneCount,
  drawerExpanded,
  isSplitPeerHover,
  onSelectSpace,
  onToggleDrawer,
  onNewTerminal,
  onDeleteSpace,
  onContextMenuSpace,
}: {
  space: SidebarSpace;
  machineName: string;
  machineOnline: boolean;
  collapsed: boolean;
  selected: boolean;
  showTopology: boolean;
  pageCount: number;
  splitPageCount: number;
  paneCount: number;
  drawerExpanded: boolean;
  isSplitPeerHover: boolean;
  onSelectSpace: (spaceId: string) => void;
  onToggleDrawer: (space: SidebarSpace) => void;
  onNewTerminal: (host: string, space: string) => void;
  onDeleteSpace: (space: SidebarSpace) => void;
  onContextMenuSpace: (x: number, y: number, space: SidebarSpace) => void;
}) {
  const pointerActivatedAtRef = useRef(0);
  const label = space.name;
  const hasSplit = splitPageCount > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      className={`v3-row v3-space${space.count === 0 ? " empty" : ""}${selected ? " selected" : ""}${isSplitPeerHover ? " is-split-peer-hover" : ""}`}
      title={collapsed ? `${machineName} · ${label}` : space.folder || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey) return;
        if ((e.target as HTMLElement | null)?.closest("button")) return;
        pointerActivatedAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
        onSelectSpace(space.id);
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement | null)?.closest("button")) return;
        const nowTs = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (e.detail > 0 && nowTs - pointerActivatedAtRef.current < 2000) {
          pointerActivatedAtRef.current = 0;
          return;
        }
        pointerActivatedAtRef.current = 0;
        onSelectSpace(space.id);
      }}
      onContextMenu={(e) => {
        if (!machineOnline || collapsed) return;
        e.preventDefault();
        onContextMenuSpace(e.clientX, e.clientY, space);
      }}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelectSpace(space.id))}
    >
      <SpaceTileIcon
        spaceKey={space.id}
        name={label}
        folder={space.folder}
        isWorktree={space.isWorktree}
        color={space.color}
        selected={selected}
        blocked={space.blocked > 0}
        size="sm"
      />
      {collapsed ? null : (
        <>
          <span className="v3-row-label truncate">{label}</span>
          {machineOnline ? (
            <>
              <button
                type="button"
                className="v3-icon-btn small hover-only"
                aria-label={`在空间 ${label} 新建终端`}
                title={`在空间 ${label} 新建终端`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onNewTerminal(space.deviceId, space.name);
                }}
              >
                <Plus size={12} />
              </button>
              <button
                type="button"
                className="v3-icon-btn small hover-only danger"
                aria-label={`关闭空间 ${label}`}
                title={`关闭空间 ${label}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteSpace(space);
                }}
              >
                <Trash2 size={12} />
              </button>
            </>
          ) : null}
          {showTopology && pageCount > 0 ? (
            <button
              type="button"
              className={`v3-space-pages-pill${drawerExpanded ? " open" : ""}${hasSplit ? " has-split" : ""}${isSplitPeerHover ? " is-peer-hover" : ""}`}
              aria-expanded={drawerExpanded}
              aria-label={`${label} 共有 ${pageCount} 个工作页${hasSplit ? `，含 ${splitPageCount} 个分屏` : ""}，点击展开或切换`}
              title={`${pageCount} 页${paneCount > pageCount ? ` · ${paneCount} 个窗格` : ""}（点击展开标签页与分屏快捷跳转）`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleDrawer(space);
              }}
            >
              {hasSplit ? <Columns2 size={10} /> : null}
              <span>{pageCount}页</span>
              <ChevronDown size={10} className="v3-pill-caret" />
            </button>
          ) : null}
          <span className="v3-count">{space.count}</span>
          {space.count === 0 ? (
            <span className="v3-ring" aria-label="暂无运行中 Agent" />
          ) : space.blocked ? (
            <span className="v3-need">需要你</span>
          ) : (
            <StatusMark group={space.best} />
          )}
        </>
      )}
    </div>
  );
});

export const ShellSidebar = memo(function ShellSidebar({
  collapsed,
  canToggle,
  onToggle,
  onConnectRelay,
  onPairPhone,
  onNewAgent,
  onNewSpace,
  onNewTerminal,
}: {
  collapsed: boolean;
  canToggle: boolean;
  onToggle: () => void;
  onConnectRelay: () => void;
  onPairPhone: () => void;
  onNewAgent: (host: string | null, space: string | null) => void;
  onNewSpace: (host: string | null) => void;
  onNewTerminal: (host: string | null, space: string | null) => void;
}) {
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const spacesMap = liveStore.use((s) => s.spaces);
  const link = liveStore.use((s) => s.link);
  const server = settingsStore.use((s) => s.server);
  const showShells = settingsStore.use((s) => s.showShells);
  const rawLocalHostId = useLocalHostDeviceId();
  const localHostId = rawLocalHostId ?? (isMockServer(server) ? "dev-mac" : null);
  const tabs = shellStore.use((s) => s.tabs);
  const rawActive = shellStore.use((s) => s.active);
  const spaceSel = shellStore.use((s) => s.selectedSpace);
  const activeBySpace = shellStore.use((s) => s.activeBySpace);
  const allByKey = useMemo(() => new Map(Object.values(agentsMap).flat().map((a) => [a.key, a] as const)), [agentsMap]);
  const activeTab = useMemo(() => {
    const id = activeTabIdForSpace(
      { tabs, active: rawActive, selectedSpace: spaceSel, activeBySpace },
      (k) => allByKey.get(k),
      spacesMap,
    );
    return id ? (tabs.find((t) => t.id === id) ?? null) : null;
  }, [activeBySpace, allByKey, rawActive, spaceSel, spacesMap, tabs]);
  const updateReady = updateStore.use((s) => Boolean(s.info?.hasUpdate));
  useVisibleTick(30_000); // re-render so the ages move
  const now = Date.now();

  const [folded, setFolded] = useState<string[]>(() => readJson<string[]>(FOLD_KEY, []));
  const grouping = settingsStore.use((s) => s.sidebarAgentGrouping);
  const styleScheme = settingsStore.use((s) => s.sidebarStyleScheme);
  const showTopology = settingsStore.use((s) => s.showSidebarTopology);
  const [expandedSpaceDrawers, setExpandedSpaceDrawers] = useState<string[]>([]);
  const [hoveredSplitTabId, setHoveredSplitTabId] = useState<string | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<SidebarSpace | null>(null);
  const [deletingSpace, setDeletingSpace] = useState(false);
  const [renameSpaceTarget, setRenameSpaceTarget] = useState<SidebarSpace | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingSpace, setRenamingSpace] = useState(false);
  const [spaceMenu, setSpaceMenu] = useState<{ x: number; y: number; space: SidebarSpace } | null>(null);
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number; agent: Agent } | null>(null);
  const [hoverFreeze, setHoverFreeze] = useState(false);
  const [spacesRatio, setSpacesRatio] = useState<number | null>(() => clampSpacesRatio(readJson<unknown>(SPACES_RATIO_KEY, null)));
  const [spacesResizing, setSpacesResizing] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarWidth = settingsStore.use((s) => s.sidebarWidth);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const listsRef = useRef<HTMLDivElement | null>(null);
  const spacesBlockRef = useRef<HTMLElement | null>(null);
  const frozenOrderRef = useRef<Map<string, string[]>>(new Map());
  const stableGroupOrderRef = useRef<Map<string, string[]>>(new Map());
  const customSpaceIcons = spaceIconStore.use((m) => m);
  const toast = useToast();
  const allByKeyRef = useRef(allByKey);
  allByKeyRef.current = allByKey;
  const spacesMapRef = useRef(spacesMap);
  spacesMapRef.current = spacesMap;
  const handleSelectSpace = useCallback((next: string | null) => {
    setSelectedSpace(next, (k) => allByKeyRef.current.get(k), spacesMapRef.current);
  }, []);
  const handleOpenAgent = useCallback((a: Agent, mods: { altKey: boolean; shiftKey: boolean }) => {
    if (mods.altKey) {
      splitActivePaneWithContent(mods.shiftKey ? "down" : "right", {
        kind: "agent",
        agentKey: a.key,
        ...(a.isShell ? { mode: "term" } : {}),
      });
      return;
    }
    openAgentTab(a.key);
  }, []);
  const handleAgentContextMenu = useCallback((x: number, y: number, a: Agent) => {
    setSpaceMenu(null);
    setAgentMenu({ x, y, agent: a });
  }, []);
  const handleSpaceContextMenu = useCallback((x: number, y: number, space: SidebarSpace) => {
    setAgentMenu(null);
    setSpaceMenu({ x, y, space });
  }, []);
  const handleDeleteSpace = useCallback((space: SidebarSpace) => {
    setDeleteSpaceTarget(space);
  }, []);

  useEffect(() => {
    if (!agentMenu && !spaceMenu) return;
    const off = () => {
      setAgentMenu(null);
      setSpaceMenu(null);
    };
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && off();
    window.addEventListener("pointerdown", off);
    window.addEventListener("blur", off);
    window.addEventListener("keydown", esc);
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => {
      window.removeEventListener("pointerdown", off);
      window.removeEventListener("blur", off);
      window.removeEventListener("keydown", esc);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [agentMenu, spaceMenu]);

  const confirmRenameSpace = async () => {
    const target = renameSpaceTarget;
    if (!target || renamingSpace || !target.spaceId) return;
    setRenamingSpace(true);
    const trimmed = renameDraft.trim();
    const folderBase = (target.folder ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || target.name;
    try {
      const res = await rpcCall(target.deviceId, "herdr.command", {
        command: "space.rename",
        args: { id: target.spaceId, name: trimmed },
      });
      const returnedName =
        res?.result && typeof (res.result as { name?: unknown }).name === "string"
          ? ((res.result as { name: string }).name.trim() || "")
          : "";
      const nextName = returnedName || trimmed || folderBase || target.name;
      liveStore.set((prev) => {
        const curSpaces = prev.spaces[target.deviceId] ?? [];
        const nextSpaces = curSpaces.map((sp) =>
          sp.id === target.spaceId ? { ...sp, name: nextName } : sp,
        );
        const curAgents = prev.agents[target.deviceId] ?? [];
        const nextAgents = curAgents.map((ag) => {
          const spName = agentSpace(ag)?.trim() ?? "";
          if (spName !== target.name) return ag;
          const oldWhere = ag.where ?? "";
          const slash = oldWhere.indexOf(" / ");
          const nextWhere = slash >= 0 ? `${nextName}${oldWhere.slice(slash)}` : nextName;
          return { ...ag, where: nextWhere };
        });
        return {
          ...prev,
          spaces: { ...prev.spaces, [target.deviceId]: nextSpaces },
          agents: { ...prev.agents, [target.deviceId]: nextAgents },
        };
      });
      renameSpaceInShellStore(target.deviceId, target.spaceId, target.name, nextName);
      void pullHostDocNow(target.deviceId);
      refreshHostSpaces(target.deviceId);
      setRenameSpaceTarget(null);
      toast(trimmed ? `已重命名为「${nextName}」` : `已恢复默认名称「${nextName}」`);
    } catch (e) {
      toast((e as Error).message || "重命名空间失败", true);
    } finally {
      setRenamingSpace(false);
    }
  };

  const confirmDeleteSpace = async () => {
    const target = deleteSpaceTarget;
    if (!target || deletingSpace) return;
    setDeletingSpace(true);
    try {
      try {
        await rpcCall(target.deviceId, "space.delete", {
          ...(target.spaceId ? { spaceId: target.spaceId } : {}),
          ...(target.name ? { spaceName: target.name } : {}),
        });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        const fallback =
          Boolean(target.spaceId) &&
          (err?.code === "unsupported" || err?.code === "bad_request" || /unknown|unsupported|不支持/i.test(err?.message ?? ""));
        if (!fallback) throw e;
        await rpcCall(target.deviceId, "herdr.command", { command: "space.close", args: { id: target.spaceId! } });
      }
      closeTabsForSpace(target.id, (k) => allByKey.get(k));
      const curSpaces = liveStore.get().spaces[target.deviceId] ?? [];
      if (curSpaces.length > 0) {
        liveStore.set((prev) => ({
          ...prev,
          spaces: {
            ...prev.spaces,
            [target.deviceId]: curSpaces.filter((sp) => (target.spaceId ? sp.id !== target.spaceId : sp.name !== target.name)),
          },
        }));
      }
      refreshHostSpaces(target.deviceId);
      void rpcCall(target.deviceId, "agents.list", { includeShells: true })
        .then((res) => {
          liveStore.set((prev) => ({ ...prev, agents: { ...prev.agents, [target.deviceId]: res.agents } }));
        })
        .catch(() => {});
      setDeleteSpaceTarget(null);
      toast(`已关闭空间「${target.name || "空间"}」`);
    } catch (e) {
      toast((e as Error).message || "关闭空间失败", true);
    } finally {
      setDeletingSpace(false);
    }
  };

  const toggleFold = (id: string) => {
    const next = folded.includes(id) ? folded.filter((x) => x !== id) : [...folded, id];
    setFolded(next);
    writeJson(FOLD_KEY, next);
  };
  const setGrouping = useCallback((v: SidebarAgentGrouping) => {
    stableGroupOrderRef.current.clear();
    frozenOrderRef.current.clear();
    updateSettings({ sidebarAgentGrouping: v });
  }, []);
  const toggleSpaceDrawer = useCallback(
    (space: SidebarSpace, hasLocalPages: boolean) => {
      if (!hasLocalPages) {
        setSelectedSpace(space.id, (k) => allByKeyRef.current.get(k), spacesMapRef.current);
        void pullHostDocNow(space.deviceId);
        return;
      }
      setExpandedSpaceDrawers((prev) =>
        prev.includes(space.id) ? prev.filter((x) => x !== space.id) : [...prev, space.id],
      );
    },
    [],
  );
  const handleJumpToPage = useCallback((tabId: string, paneId?: string | null) => {
    setActiveTab(tabId, { trigger: "click" });
    if (paneId) focusTabPane(tabId, paneId);
  }, []);

  const agents = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);

  // 空间: one block per computer (local/online first), spaces in exact Herdr App order with colors & 0-agent spaces.
  const machines = useMemo(() => {
    const ids = new Set<string>([...Object.values(devices).filter((d) => d.kind === "host").map((d) => d.id), ...agents.map((a) => a.deviceId)]);
    return [...ids]
      .map((id) => {
        const dev = devices[id];
        const spaces = buildHostSpaces(id, spacesMap[id], agents, devices);
        return {
          id,
          name: dev?.name ?? id,
          online: dev?.online ?? false,
          isLocal: Boolean(localHostId && id === localHostId),
          spaces,
          count: spaces.reduce((n, s) => n + s.count, 0),
        };
      })
      .sort((x, y) => Number(y.isLocal) - Number(x.isLocal) || Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
  }, [agents, devices, localHostId, spacesMap]);

  const selected = spaceSel && machines.some((m) => m.spaces.some((s) => s.id === spaceSel)) ? spaceSel : null;
  const totalSpaces = useMemo(() => machines.reduce((n, m) => n + m.spaces.length, 0), [machines]);
  // Agent list stays global across all Spaces & computers like Herdr.app; clicking any Agent switches Spaces automatically.
  const inScope = agents;
  const primaryMachineId = localHostId || machines[0]?.id || null;

  const workspaceTopology = useMemo(
    () =>
      computeWorkspaceTopology(
        tabs,
        activeTab?.id ?? null,
        (k) => allByKey.get(k),
        spacesMap,
        inScope,
      ),
    [activeTab?.id, allByKey, inScope, spacesMap, tabs],
  );

  const sections = useMemo(() => {
    const nextSections = buildSidebarAgentSections({
      agents: inScope,
      devices,
      topology: workspaceTopology,
      spacesMap,
      selectedSpace: selected,
      grouping,
      scheme: styleScheme,
      localHostId,
      hoverFreeze,
      previousOrder: hoverFreeze ? frozenOrderRef.current : undefined,
    });
    if (!hoverFreeze && grouping === "status") {
      const nextMap = new Map<string, string[]>();
      for (const s of nextSections) {
        nextMap.set(s.groupKey, s.items.map((it) => it.agent.key));
      }
      frozenOrderRef.current = nextMap;
      stableGroupOrderRef.current = nextMap;
    }
    return nextSections;
  }, [devices, grouping, hoverFreeze, inScope, localHostId, selected, spacesMap, styleScheme, workspaceTopology]);

  const agentMetaByKey = useMemo(() => {
    const out = new Map<
      string,
      {
        group: ListGroup;
        primary: string;
        spaceSecondary: string | null;
        deviceBadge: CompactDeviceBadge;
        collapsedTip: string;
        expandedTip: string;
      }
    >();
    for (const a of inScope) {
      const g = listGroup(a, devices);
      const label = spacedTitle(a);
      const { primary, secondary: rowSpace } = formatSidebarAgentRow(a, { showMachine: false });
      const placement = getAgentPlacement(a, workspaceTopology, spacesMap);
      const devBadge = formatCompactDeviceBadge(a.deviceId, devices, localHostId);
      const spaceSecondary = rowSpace || placement.spaceName || null;
      const badge = showTopology ? formatTopologyBadge(placement) : null;
      const topoNote = badge
        ? placement.isBackground
          ? " · 后台未打开标签"
          : placement.isSplit
            ? ` · ${badge.label} (${badge.slot})`
            : ` · ${badge.label}`
        : "";
      const fullWhere = [devBadge.fullLabel, spaceSecondary].filter(Boolean).join(" · ");
      out.set(a.key, {
        group: g,
        primary,
        spaceSecondary,
        deviceBadge: devBadge,
        collapsedTip: `${devBadge.fullLabel} · ${label}${topoNote}`,
        expandedTip: `${primary}${fullWhere ? ` — ${fullWhere}` : ""}${topoNote}`,
      });
    }
    return out;
  }, [devices, inScope, localHostId, showTopology, spacesMap, workspaceTopology]);

  const focusedContent = activeTab ? focusedLeafOfTab(activeTab).content : null;
  const activeAgentKey = focusedContent?.kind === "agent" ? focusedContent.agentKey : null;
  const activeSplitAgentKeys = useMemo(() => {
    const out = new Set<string>();
    if (!activeTab) return out;
    for (const leaf of tabLeaves(activeTab)) {
      if (leaf.content.kind === "agent") out.add(leaf.content.agentKey);
    }
    return out;
  }, [activeTab]);
  const connected = Boolean(server) && link === "online";
  const demo = isMockServer(server);
  const notice =
    !server ? { text: "还没连接中转服务器", action: "连接", run: onConnectRelay }
    : link === "offline" ? { text: "和服务器断开了，正在重连", action: "立即重连", run: () => pingRelay() }
    : link === "unauthorized" ? { text: "这台设备的授权已失效", action: "重新连接", run: onConnectRelay }
    : link === "connecting" ? { text: "正在连接服务器…", action: null, run: null }
    : null;

  const renderAgentRow = (
    item: SidebarAgentItem,
    opts?: { inCluster?: boolean; isSpaceGroup?: boolean; isUnassignedSpace?: boolean },
  ) => {
    const a = item.agent;
    const placement = item.placement;
    const joinRole = item.joinRole;
    const meta = agentMetaByKey.get(a.key);
    const g = meta?.group ?? listGroup(a, devices);
    const primary = meta?.primary ?? spacedTitle(a);
    const secondary = opts?.isSpaceGroup && !opts?.isUnassignedSpace ? null : (meta?.spaceSecondary ?? null);
    const spaceColorFg = opts?.isSpaceGroup ? null : spaceColorVars(placement.spaceColor)?.fg ?? null;
    const devBadge = meta?.deviceBadge ?? formatCompactDeviceBadge(a.deviceId, devices, localHostId);
    const showRowDeviceChip =
      styleScheme === "b"
        ? opts?.isSpaceGroup && opts?.isUnassignedSpace
          ? devBadge
          : null
        : opts?.isSpaceGroup && !opts?.isUnassignedSpace
          ? null
          : devBadge;
    const isFocusedAgent = a.key === activeAgentKey;
    const isInSplit = !isFocusedAgent && activeSplitAgentKeys.has(a.key);
    const splitPeerHover = Boolean(hoveredSplitTabId && placement.isSplit && placement.tabId === hoveredSplitTabId);
    const tooltipText = collapsed ? (meta?.collapsedTip ?? primary) : (meta?.expandedTip ?? primary);
    return (
      <SidebarAgentRow
        key={a.key}
        agent={a}
        group={g}
        primary={primary}
        secondary={secondary}
        deviceChip={showRowDeviceChip}
        tooltipText={tooltipText}
        ageLabel={shortAgo(lastChange(a), now)}
        compactBlocked={grouping === "status" && g === "blocked"}
        collapsed={collapsed}
        isFocusedAgent={isFocusedAgent}
        isInSplit={isInSplit}
        showTopology={showTopology}
        styleScheme={styleScheme}
        inCluster={opts?.inCluster}
        placement={placement}
        joinRole={joinRole}
        splitPeerHover={splitPeerHover}
        spaceColorFg={spaceColorFg}
        onHoverSplit={setHoveredSplitTabId}
        onOpenAgent={handleOpenAgent}
        onContextMenuAgent={handleAgentContextMenu}
      />
    );
  };

  const renderSectionItems = (items: SidebarAgentItem[], isSpaceGroup: boolean, isUnassignedSpace: boolean) => {
    const nodes: ReactNode[] = [];
    let i = 0;
    while (i < items.length) {
      const cur = items[i]!;
      if (!collapsed && styleScheme === "b" && cur.deviceHeader) {
        const hdr = cur.deviceHeader;
        nodes.push(
          <div key={`devhdr-${hdr.deviceId}-${cur.agent.key}`} className="v3-dev-subhdr">
            <SidebarDeviceChip
              label={`${hdr.isLocal ? hdr.fullLabel : hdr.label} · ${hdr.count}`}
              fullLabel={hdr.fullLabel}
              isLocal={hdr.isLocal}
            />
            <span className="v3-dev-subhdr-line" />
          </div>,
        );
      }
      const canCluster =
        !collapsed &&
        showTopology &&
        (styleScheme === "a" || styleScheme === "b") &&
        cur.joinRole === "split-first" &&
        Boolean(cur.placement.tabId);
      if (canCluster) {
        const tabId = cur.placement.tabId!;
        const clusterItems: SidebarAgentItem[] = [cur];
        let j = i + 1;
        while (
          j < items.length &&
          items[j]!.placement.isSplit &&
          items[j]!.placement.tabId === tabId &&
          !items[j]!.deviceHeader
        ) {
          clusterItems.push(items[j]!);
          j += 1;
        }
        if (clusterItems.length >= 2) {
          const first = clusterItems[0]!;
          const clusterMeta = agentMetaByKey.get(first.agent.key);
          const clusterSpace = clusterMeta?.spaceSecondary || first.placement.spaceName || "同一窗口";
          const clusterColorFg = spaceColorVars(first.placement.spaceColor)?.fg ?? null;
          const clusterDev = clusterMeta?.deviceBadge ?? formatCompactDeviceBadge(first.agent.deviceId, devices, localHostId);
          const isClusterPeerHover = hoveredSplitTabId === tabId;
          nodes.push(
            <div
              key={`cluster-${tabId}-${first.agent.key}`}
              className={`v3-split-cluster${isClusterPeerHover ? " is-peer-hover" : ""}`}
              onMouseEnter={() => setHoveredSplitTabId(tabId)}
              onMouseLeave={() => hoveredSplitTabId === tabId && setHoveredSplitTabId(null)}
            >
              <div className="v3-split-cluster-hd">
                {styleScheme === "a" && !isSpaceGroup ? (
                  <SidebarDeviceChip label={clusterDev.label} fullLabel={clusterDev.fullLabel} isLocal={clusterDev.isLocal} />
                ) : null}
                {clusterColorFg && !isSpaceGroup ? (
                  <span className="v3-space-dot" style={{ backgroundColor: clusterColorFg }} aria-hidden="true" />
                ) : null}
                <span className="truncate">
                  {isSpaceGroup ? `第${first.placement.pageNumber ?? 1}页` : clusterSpace}
                </span>
                <span className="v3-split-cluster-badge">同窗 {first.placement.paneCount}分屏</span>
              </div>
              {clusterItems.map((ci) => renderAgentRow(ci, { inCluster: true, isSpaceGroup, isUnassignedSpace }))}
            </div>,
          );
          i = j;
          continue;
        }
      }
      nodes.push(renderAgentRow(cur, { inCluster: false, isSpaceGroup, isUnassignedSpace }));
      i += 1;
    }
    return nodes;
  };

  return (
    <aside
      ref={sidebarRef}
      className={`v3-sidebar${sidebarResizing ? " is-resizing" : ""}`}
      style={!collapsed ? ({ "--v3-sidebar-w": `${sidebarWidth}px` } as CSSProperties) : undefined}
      aria-label="侧栏"
    >
      {!collapsed ? (
        <div
          className="v3-sidebar-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整侧栏宽度，双击恢复默认"
          title="拖动调整侧栏宽度（双击恢复默认）"
            onDoubleClick={() => updateSettings({ sidebarWidth: DEFAULT_SIDEBAR_WIDTH })}
            onPointerDown={(e) => {
              if (e.button !== 0 || !sidebarRef.current) return;
              e.preventDefault();
              const el = sidebarRef.current;
              const v3El = el.closest(".v3") as HTMLElement | null;
              const startX = e.clientX;
              const startW = el.getBoundingClientRect().width || sidebarWidth;
              let curW = clampSidebarWidth(startW);
              let rafId = 0;
              window.getSelection()?.removeAllRanges();
              setSidebarResizing(true);
              setInteractiveResizeActive(true);
              document.documentElement.dataset.splitResizing = "row";
              e.currentTarget.setPointerCapture(e.pointerId);

              const apply = () => {
                rafId = 0;
                el.style.setProperty("--v3-sidebar-w", `${curW}px`);
                v3El?.style.setProperty("--v3-sidebar-effective", `${curW}px`);
              };
            const onMove = (mv: PointerEvent) => {
              curW = clampSidebarWidth(startW + (mv.clientX - startX));
              if (!rafId) rafId = requestAnimationFrame(apply);
            };
            const finish = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", finish);
              window.removeEventListener("pointercancel", finish);
              if (rafId) {
                cancelAnimationFrame(rafId);
                apply();
              }
              delete document.documentElement.dataset.splitResizing;
              setSidebarResizing(false);
              setInteractiveResizeActive(false);
              updateSettings({ sidebarWidth: curW });
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", finish);
            window.addEventListener("pointercancel", finish);
          }}
        />
      ) : null}
      <div className="v3-brand" data-tauri-drag-region="deep">
        {collapsed ? null : (
          <div className="v3-brand-name">
            <img src={assetUrl("brand/logo-160.webp")} alt="" width={20} height={20} />
            <span className="truncate">Herdr Pocket</span>
          </div>
        )}
        <button className="v3-icon-btn v3-brand-search has-hint" aria-label="跳到 Agent 或标签" title={`跳到 Agent 或标签（${shortcutText("jumpAgent")}）`} onClick={() => setPalette("jump")}>
          <Search size={15} />
          <SpatialHint text={shortcutText("jumpAgent")} corner="bottom" />
        </button>
        {canToggle ? (
          <button className="v3-icon-btn has-hint" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={`${collapsed ? "展开" : "收起"}侧栏（${shortcutText("toggleSidebar")}）`} onClick={onToggle}>
            <PanelLeft size={15} />
            <SpatialHint text={shortcutText("toggleSidebar")} corner="bottom" />
          </button>
        ) : null}
      </div>

      <div ref={listsRef} className="v3-lists">
        <section
          ref={spacesBlockRef}
          className={`v3-block v3-block-spaces${!collapsed && spacesRatio !== null ? " has-ratio" : ""}`}
          style={!collapsed && spacesRatio !== null ? ({ "--v3-spaces-ratio": String(spacesRatio) } as CSSProperties) : undefined}
          aria-label="空间"
        >
          {collapsed ? null : (
            <div className="v3-block-head">
              <span>空间</span>
              {totalSpaces > 0 ? <span className="v3-count v3-sec-count">{totalSpaces}</span> : null}
              <span className="grow" />
              <button
                className="v3-icon-btn small"
                aria-label="新建空间"
                title={`新建空间（${shortcutText("newSpace")}）`}
                onClick={() => onNewSpace(null)}
              >
                <Plus size={14} />
              </button>
            </div>
          )}
          <div className="v3-block-body">
            {notice && !collapsed ? (
              <div className="v3-notice" role="status">
                <span className={`v3-dot ${link === "connecting" ? "warn" : "off"}`} />
                <span className="grow">{notice.text}</span>
                {notice.action ? (
                  <button className="v3-mini-btn" onClick={() => notice.run?.()}>
                    {notice.action}
                  </button>
                ) : null}
              </div>
            ) : null}
            {machines.map((m) => {
              const isFolded = folded.includes(m.id);
              return (
                <div key={m.id} className="v3-machine-group">
                  {collapsed ? (
                    <div className="v3-machine-sep" title={m.name} />
                  ) : (
                    <div className="v3-row v3-machine" onClick={() => toggleFold(m.id)}>
                      <Laptop size={13} />
                      <span className="truncate grow">{m.name}</span>
                      {m.isLocal ? <span className="v3-local-pill">本机</span> : null}
                      {m.online ? (
                        <button
                          className="v3-icon-btn small hover-only"
                          aria-label={`在 ${m.name} 新建空间`}
                          title={`在 ${m.name} 新建空间…`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onNewSpace(m.id);
                          }}
                        >
                          <Plus size={13} />
                        </button>
                      ) : null}
                      <span className={`v3-dot ${m.online ? "ok" : "off"}`} aria-label={m.online ? "在线" : "离线"} />
                      {isFolded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </div>
                  )}
                  {isFolded && !collapsed
                    ? null
                    : m.spaces.map((s) => {
                        const spTopo = workspaceTopology.bySpace.get(s.id);
                        const pageCount = spTopo ? (spTopo.pages.length > 0 ? spTopo.pages.length : spTopo.declaredTabCount) : 0;
                        const splitPageCount = spTopo?.splitPageCount ?? 0;
                        const paneCount = spTopo?.paneCount ?? 0;
                        const hasLocalPages = (spTopo?.pages.length ?? 0) > 0;
                        const drawerExpanded =
                          !collapsed && showTopology && hasLocalPages && expandedSpaceDrawers.includes(s.id);
                        const isSpacePeerHovered = Boolean(
                          showTopology && hoveredSplitTabId && workspaceTopology.tabSpaceById.get(hoveredSplitTabId) === s.id,
                        );
                        return (
                          <div key={s.id} className="v3-space-wrap">
                            <SidebarSpaceRow
                              space={s}
                              machineName={m.name}
                              machineOnline={m.online}
                              collapsed={collapsed}
                              selected={selected === s.id}
                              showTopology={showTopology}
                              pageCount={pageCount}
                              splitPageCount={splitPageCount}
                              paneCount={paneCount}
                              drawerExpanded={drawerExpanded}
                              isSplitPeerHover={isSpacePeerHovered}
                              onSelectSpace={handleSelectSpace}
                              onToggleDrawer={(sp) => toggleSpaceDrawer(sp, hasLocalPages)}
                              onNewTerminal={onNewTerminal}
                              onDeleteSpace={handleDeleteSpace}
                              onContextMenuSpace={handleSpaceContextMenu}
                            />
                            {drawerExpanded && spTopo ? (
                              <div className="v3-space-pages-drawer" role="region" aria-label={`${s.name} 的标签页与分屏`}>
                                {spTopo.pages.map((page) => {
                                  const isPagePeerHovered = hoveredSplitTabId === page.tabId;
                                  const dotKind = page.hasBlocked ? " blocked" : page.hasWorking ? " working" : "";
                                  return (
                                    <div
                                      key={page.tabId}
                                      className={`v3-space-page-card${page.active ? " active" : ""}${isPagePeerHovered ? " is-peer-hover" : ""}`}
                                      onMouseEnter={() => page.isSplit && setHoveredSplitTabId(page.tabId)}
                                      onMouseLeave={() => page.isSplit && hoveredSplitTabId === page.tabId && setHoveredSplitTabId(null)}
                                    >
                                      <button
                                        type="button"
                                        className="v3-space-page-head"
                                        title={`跳转到第 ${page.pageNumber} 页：${page.tabName}`}
                                        onClick={() => handleJumpToPage(page.tabId)}
                                      >
                                        <span className="v3-page-num">第{page.pageNumber}页</span>
                                        {page.isSplit ? (
                                          <span className="v3-page-split-tag">
                                            <Columns2 size={10} />
                                            <span>{page.paneCount}分屏</span>
                                          </span>
                                        ) : null}
                                        <span className="v3-space-page-title truncate">{page.tabName}</span>
                                        {dotKind ? <span className={`v3-dot${dotKind}`} /> : null}
                                      </button>
                                      {page.isSplit ? (
                                        <div className="v3-space-pane-chips">
                                          {page.panes.map((pane) => (
                                            <button
                                              key={pane.paneId}
                                              type="button"
                                              className={`v3-space-pane-chip${page.active && pane.focused ? " is-focused" : ""}${pane.status === "blocked" ? " is-blocked" : ""}`}
                                              title={`定位到分屏 ${pane.paneIndex}/${pane.paneCount}：${pane.title}`}
                                              onClick={() => handleJumpToPage(page.tabId, pane.paneId)}
                                            >
                                              <span className="v3-pane-idx">{pane.paneIndex}</span>
                                              {pane.kind === "agent" ? (
                                                <VendorIcon harness={pane.harness ?? "agent"} isShell={pane.isShell} size={11} />
                                              ) : null}
                                              <span className="truncate">{pane.title}</span>
                                            </button>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                </div>
              );
            })}
            {!machines.length && server && link === "online" && !collapsed ? (
              <div className="v3-empty-line">还没有电脑加入。在那台电脑上运行 herdr-pocket up，或在 设置 › 电脑与中继 里添加电脑。</div>
            ) : null}
          </div>
        </section>

        {!collapsed ? (
          <div
            className={`v3-lists-sash${spacesResizing ? " dragging" : ""}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label="拖动调整空间与 Agent 列表高度，双击恢复自动"
            title="拖动调整空间与 Agent 高度（双击恢复默认）"
            onDoubleClick={() => {
              setSpacesRatio(null);
              writeJson(SPACES_RATIO_KEY, null);
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 || !listsRef.current || !spacesBlockRef.current) return;
              e.preventDefault();
              const listsEl = listsRef.current;
              const spacesEl = spacesBlockRef.current;
              const listsRect = listsEl.getBoundingClientRect();
              const totalH = Math.max(180, listsRect.height);
              const startY = e.clientY;
              const startH = spacesEl.getBoundingClientRect().height || totalH * 0.42;
              let curRatio = clampSpacesRatio(startH / totalH) ?? 0.42;
              let rafId = 0;
              window.getSelection()?.removeAllRanges();
              setSpacesResizing(true);
              document.documentElement.dataset.splitResizing = "column";
              e.currentTarget.setPointerCapture(e.pointerId);

              const apply = () => {
                rafId = 0;
                spacesEl.style.setProperty("--v3-spaces-ratio", String(curRatio));
                spacesEl.classList.add("has-ratio");
              };
              const onMove = (mv: PointerEvent) => {
                curRatio = clampSpacesRatio((startH + (mv.clientY - startY)) / totalH) ?? 0.42;
                if (!rafId) rafId = requestAnimationFrame(apply);
              };
              const finish = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", finish);
                window.removeEventListener("pointercancel", finish);
                if (rafId) {
                  cancelAnimationFrame(rafId);
                  apply();
                }
                delete document.documentElement.dataset.splitResizing;
                setSpacesResizing(false);
                setSpacesRatio(curRatio);
                writeJson(SPACES_RATIO_KEY, curRatio);
              };
              window.addEventListener("pointermove", onMove);
              window.addEventListener("pointerup", finish);
              window.addEventListener("pointercancel", finish);
            }}
          />
        ) : null}

        <section
          className="v3-block v3-block-agents"
          aria-label="Agent"
          onPointerEnter={() => setHoverFreeze(true)}
          onPointerLeave={() => setHoverFreeze(false)}
        >
          {collapsed ? null : (
            <div className="v3-block-head">
              <span>Agent</span>
              <span className="v3-count v3-sec-count">{inScope.length}</span>
              <span className="grow" />
              <div className="v3-seg-mini" role="tablist" aria-label="Agent 列表分组方式">
                {(
                  [
                    { key: "status", label: "状态", title: "按需要你 / 运行中 / 已完成状态分组" },
                    { key: "space", label: "空间", title: "按所属 Space 与同窗分屏关系聚合" },
                    { key: "recent", label: "最近", title: "按最近活跃时间排序" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    role="tab"
                    aria-selected={grouping === opt.key}
                    className={`v3-seg-mini-btn${grouping === opt.key ? " active" : ""}`}
                    title={opt.title}
                    onClick={() => setGrouping(opt.key)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="v3-block-body">
            {sections.map((g) => {
              const id = `g:${g.groupKey}`;
              const isFolded = folded.includes(id) && g.groupKey !== "recent";
              const isSpaceGroup = g.kind === "space";
              const isUnassignedSpace = g.groupKey === "space:__unassigned__";
              const spColor = isSpaceGroup ? spaceColorVars(g.spaceColor)?.fg : undefined;
              const spaceDevBadge =
                isSpaceGroup && !isUnassignedSpace && g.items[0]
                  ? formatCompactDeviceBadge(g.items[0].agent.deviceId, devices, localHostId)
                  : null;
              return (
                <div key={g.id}>
                  {collapsed ? (
                    <div className="v3-machine-sep" />
                  ) : (
                    <button
                      type="button"
                      className="v3-group-head"
                      aria-expanded={!isFolded}
                      onClick={() => g.groupKey !== "recent" && toggleFold(id)}
                    >
                      {isSpaceGroup ? (
                        <span
                          className="v3-space-dot lg"
                          style={spColor ? { backgroundColor: spColor } : undefined}
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className="truncate">{g.title}</span>
                      {spaceDevBadge ? (
                        <SidebarDeviceChip label={spaceDevBadge.label} fullLabel={spaceDevBadge.fullLabel} isLocal={spaceDevBadge.isLocal} />
                      ) : null}
                      {isSpaceGroup && showTopology && (g.pageCount ?? 0) > 0 ? (
                        <span className="v3-group-meta">
                          {g.pageCount}页{(g.splitPageCount ?? 0) > 0 ? " · 含分屏" : ""}
                        </span>
                      ) : null}
                      <span className="v3-count">{g.items.length}</span>
                      {g.groupKey !== "recent" ? (
                        isFolded ? (
                          <ChevronRight size={12} />
                        ) : (
                          <ChevronDown size={12} className="hover-only" />
                        )
                      ) : null}
                    </button>
                  )}
                  {isFolded && !collapsed
                    ? null
                    : renderSectionItems(g.items, isSpaceGroup, isUnassignedSpace)}
                </div>
              );
            })}
            {!inScope.length && !collapsed ? (
              <div className="v3-empty-line">
                {!server ? "连上中转服务器后，各台电脑上的 Agent 会出现在这里。" : link !== "online" ? "连上以后，Agent 会出现在这里。" : "还没有 Agent。点“空间”右边的 + 新建一个。"}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="v3-footer">
        <button className="v3-foot-row has-hint" title={collapsed ? "设置" : `设置（${shortcutText("settings")}）`} onClick={() => openSettingsFrame(updateReady ? "updates" : "look")}>
          <Settings size={14} />
          {collapsed ? null : <span className="grow truncate">设置</span>}
          {updateReady ? <span className="v3-update-dot" aria-label="有新版本" /> : null}
          {!collapsed ? <SpatialHint text={shortcutText("settings")} corner="right" /> : null}
        </button>
        <button
          className="v3-foot-row"
          title={collapsed ? "连接中转服务器" : connected ? "查看电脑与中继" : undefined}
          onClick={() => (server && !demo ? openSettingsFrame("machines") : onConnectRelay())}
        >
          <Server size={14} />
          {collapsed ? null : (
            <span className="grow truncate">{!server ? "连接中转服务器" : demo ? "演示模式 · 连接中转服务器" : serverLabel(server)}</span>
          )}
          <span className={`v3-dot ${connected ? "ok" : link === "connecting" ? "warn" : "off"}${collapsed ? " corner" : ""}`} aria-label={connected ? "已连接" : "未连接"} />
        </button>
        <button className="v3-foot-row" title={collapsed ? "扫码连接手机" : undefined} onClick={onPairPhone}>
          <QrCode size={14} />
          {collapsed ? null : <span className="grow truncate">扫码连接手机</span>}
        </button>
      </div>
      <PocketModal
        open={renameSpaceTarget !== null}
        onOpenChange={(v) => {
          if (!v && !renamingSpace) setRenameSpaceTarget(null);
        }}
        title="重命名空间"
        subtitle={
          renameSpaceTarget?.folder
            ? `工作目录：${renameSpaceTarget.folder}。留空保存将恢复按文件夹自动命名。`
            : "输入新的空间名称；留空保存将恢复按文件夹自动命名。"
        }
        width={420}
      >
        <div className="stack">
          <PocketInput
            autoFocus
            maxLength={60}
            placeholder={
              (renameSpaceTarget?.folder ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ||
              renameSpaceTarget?.name ||
              "空间名称"
            }
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void confirmRenameSpace();
              }
            }}
          />
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <PocketButton variant="ghost" disabled={renamingSpace} onClick={() => setRenameSpaceTarget(null)}>
              取消
            </PocketButton>
            <PocketButton variant="primary" disabled={renamingSpace} onClick={() => void confirmRenameSpace()}>
              {renamingSpace ? "正在保存…" : "保存"}
            </PocketButton>
          </div>
        </div>
      </PocketModal>
      <PocketModal
        open={deleteSpaceTarget !== null}
        onOpenChange={(v) => {
          if (!v && !deletingSpace) setDeleteSpaceTarget(null);
        }}
        title={`关闭空间「${deleteSpaceTarget?.name || "空间"}」？`}
        subtitle={
          deleteSpaceTarget
            ? `${deleteSpaceTarget.count > 0 ? `将关闭该空间并结束其中的 ${deleteSpaceTarget.count} 个运行中终端/Agent。` : "将从列表移除该空空间。"}磁盘上的文件夹与代码文件不会被删除${deleteSpaceTarget.folder ? `（${deleteSpaceTarget.folder}）` : ""}。`
            : undefined
        }
        width={420}
      >
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <PocketButton variant="ghost" disabled={deletingSpace} onClick={() => setDeleteSpaceTarget(null)}>
            取消
          </PocketButton>
          <PocketButton variant="danger" disabled={deletingSpace} onClick={() => void confirmDeleteSpace()}>
            {deletingSpace ? "正在关闭…" : "关闭空间"}
          </PocketButton>
        </div>
      </PocketModal>
      {agentMenu && typeof document !== "undefined"
        ? createPortal(
            <div
              className="ctx-menu v3-popup"
              role="menu"
              data-tauri-drag-region="false"
              style={{
                left: Math.max(8, Math.min(agentMenu.x, window.innerWidth - 208 - 8)),
                top: Math.max(8, Math.min(agentMenu.y, window.innerHeight - 170)),
                width: 208,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const target = agentMenu.agent;
                  setAgentMenu(null);
                  openAgentTab(target.key);
                }}
              >
                <SquareArrowOutUpRight size={14} />
                <span className="grow">在标签页中打开</span>
              </button>
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const target = agentMenu.agent;
                  setAgentMenu(null);
                  splitActivePaneWithContent("right", {
                    kind: "agent",
                    agentKey: target.key,
                    ...(target.isShell ? { mode: "term" } : {}),
                  });
                }}
              >
                <Columns2 size={14} />
                <span className="grow">向右分屏打开</span>
              </button>
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const target = agentMenu.agent;
                  setAgentMenu(null);
                  splitActivePaneWithContent("down", {
                    kind: "agent",
                    agentKey: target.key,
                    ...(target.isShell ? { mode: "term" } : {}),
                  });
                }}
              >
                <Rows2 size={14} />
                <span className="grow">向下分屏打开</span>
              </button>
            </div>,
            document.body,
          )
        : null}
      {spaceMenu && typeof document !== "undefined"
        ? createPortal(
            <div
              className="ctx-menu v3-popup"
              role="menu"
              data-tauri-drag-region="false"
              style={{
                left: Math.max(8, Math.min(spaceMenu.x, window.innerWidth - 228 - 8)),
                top: Math.max(8, Math.min(spaceMenu.y, window.innerHeight - 300)),
                width: 228,
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const target = spaceMenu.space;
                  setSpaceMenu(null);
                  onNewTerminal(target.deviceId, target.name);
                }}
              >
                <Terminal size={14} />
                <span className="grow">新建终端</span>
              </button>
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const target = spaceMenu.space;
                  setSpaceMenu(null);
                  onNewAgent(target.deviceId, target.name);
                }}
              >
                <Plus size={14} />
                <span className="grow">新建 Agent…</span>
              </button>
              <div className="menu-sep" />
              <div className="v3-space-icon-picker">
                <div className="v3-space-icon-head">
                  <span>空间图标</span>
                  {customSpaceIcons[spaceMenu.space.id] ? (
                    <button
                      type="button"
                      className="v3-space-icon-reset"
                      onClick={() => {
                        setCustomSpaceIcon(spaceMenu.space.id, null);
                        setSpaceMenu(null);
                      }}
                    >
                      自动
                    </button>
                  ) : null}
                </div>
                <div className="v3-space-icon-grid">
                  {SPACE_ICON_PRESETS.slice(0, 12).map((p) => {
                    const Icon = p.Icon;
                    const active = customSpaceIcons[spaceMenu.space.id] === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`v3-space-icon-opt${active ? " on" : ""}`}
                        title={p.label}
                        aria-label={p.label}
                        onClick={() => {
                          setCustomSpaceIcon(spaceMenu.space.id, p.id);
                          setSpaceMenu(null);
                        }}
                      >
                        <Icon size={13} strokeWidth={2} />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                disabled={!spaceMenu.space.spaceId}
                onClick={() => {
                  const target = spaceMenu.space;
                  setSpaceMenu(null);
                  setRenameDraft(target.name);
                  setRenameSpaceTarget(target);
                }}
              >
                <Pencil size={14} />
                <span className="grow">重命名空间…</span>
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                style={{ color: "var(--blush-text)" }}
                onClick={() => {
                  const target = spaceMenu.space;
                  setSpaceMenu(null);
                  setDeleteSpaceTarget(target);
                }}
              >
                <Trash2 size={14} />
                <span className="grow">关闭空间…</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </aside>
  );
});
