import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  Cpu,
  Folder,
  FolderOpen,
  FolderTree,
  Laptop,
  Menu,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  ScreenShare,
  Search,
  Send,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  PUT_LIMITS,
  applyRows,
  buildHarnessSwitchCommands,
  normalizeSwitchHarness,
  parseModelSwitchText,
  sameMessage,
  stripModelEffortSuffix,
  textWithFiles,
  type Agent,
  type AgentModelsResult,
  type AgentStatus,
  type AgentUsageReport,
  type ConvEvent,
  type Device,
  type LaunchOption,
  type OmpModelRole,
  type SlashCommandItem,
  type SpaceInfo,
  type SubSession,
} from "@herdr-pocket/protocol";
import {
  EmptyState,
  PocketBadge,
  PocketButton,
  PocketCard,
  PocketErrorBoundary,
  PocketIconButton,
  PocketInput,
  PocketModal,
  PocketSelect,
  fs,
  overlayStore,
  useToast,
} from "../components/PocketUI";
import { AgentUsageCard } from "../components/AgentUsageCard";
import { BtwSideDrawer, executeAgentBtw, type BtwTurn } from "../components/BtwSideDrawer";
import { ChatTimelineRows, CommandResultCard, InlineImageStrip, clockStr } from "../components/ChatTimeline";
import { COMPOSER_SLASH_CHIP_PLACEHOLDER, ComposerSlashChip } from "../components/ComposerSlashChip";
import { DropRail } from "../components/DropRail";
import { PortalViewerModal } from "../components/PortalViewerModal";
import { SessionPortalPiP } from "../components/SessionPortalPiP";
import { FolderExplorerModal, normalizeFolderKey } from "../components/FolderExplorerModal";
import { VendorAvatar, XiaoyangOrb, statusTone } from "../components/MascotAndVendor";
import { ModelSwitchDropdown, formatEffortLabel } from "../components/ModelSwitchDropdown";
import { SlashCommandPopup } from "../components/SlashCommandPopup";
import { SubagentCatalogTrigger, SubagentHeaderLineage, SubagentReadOnlyBar } from "../components/SubagentNav";
import { TerminalSurface } from "../components/TerminalSurface";
import { copyToClipboard } from "../lib/bridge";
import { extractImageTargets } from "../lib/chatImages";
import { createBufferedEventMerger, foldConvEvents, mergeConvEvents, type ChatRow } from "../lib/chatFold";
import {
  builtinSlashCommands,
  extractSlashQuery,
  matchSlashCommands,
  mergeSlashCommands,
  parseLeadingSlashToken,
  type SlashCategory,
} from "../lib/slashCommands";
import { parseTerminalChatTranscript, shellTurnMatchesCommand } from "../lib/terminalChat";
import {
  cancelPendingModelSwitch,
  chatQueueStore,
  closeInteractiveCommandPanel,
  dismissCapturedCommand,
  dismissOutgoingSend,
  enqueuePrompt,
  interruptAndSendQueuedPrompt,
  moveQueuedPromptToTop,
  popQueuedPromptForEdit,
  pruneOutgoingSends,
  reconcileOutgoingSends,
  removeQueuedPrompt,
  retryFailedSend,
  schedulePendingModelSwitch,
  sendPromptNow,
  steerComposerNow,
  steerQueuedPromptNow,
  useAgentChatQueue,
  type CapturedCommandEntry,
  type OutgoingSend,
} from "../lib/chatQueue";
import { interleaveOptimisticSends, isAgentTurnBusy } from "../lib/chatQueueLogic";
import { useComposerInput } from "../lib/composerKeys";
import { prepareDroppedFiles, revokeAttachment, stageWorkspaceDragItem, type StagedAttachment } from "../lib/dropPreview";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraftAttachments,
  setComposerDraftText,
  subscribeComposerDrafts,
} from "../lib/composerDrafts";
import { endWorkspaceDrag, hasPaneDrag, hasPanelDrag, hasTabDrag, hasWorkspaceDrag, readWorkspaceDrag } from "../lib/fileDrag";
import { collectDroppedFilesSafe, readOsDraggedPaths, snapshotDroppedDataTransfer, stageOsDraggedItems } from "../lib/finderDrop";
import { localHostIdStore, useLocalHostDeviceId } from "../lib/fonts";
import { updateAgentRoleModel, useAutoAgentModelMeta } from "../lib/modelCatalogClient";
import { SpaceTileIcon } from "../shell/spaceIcon";
import { openFileTab, openSubagentAside, shellStore } from "../shell/shellStore";
import { shortcutText } from "../shell/shortcuts";
import { SpatialHint } from "../shell/useModifierHoldHints";
import { logAction } from "../lib/log";
import { native } from "../lib/native";
import { RichMarkdown, parseChoices } from "../lib/markdown";
import { openAgentFileTarget } from "../lib/openFileTarget";
import { ingestPortalStreamEvent } from "../lib/portalClient";
import { pingRelay, rpcCall, subscribeStream } from "../lib/relay";
import {
  STATUS_LABEL,
  agentSpace,
  agentTitle,
  allAgents,
  greeting,
  liveStore,
  relTime,
  settingsStore,
  spacedTitle,
  updateSettings,
} from "../lib/store";

type GroupKey = "blocked" | "working" | "done" | "idle" | "offline";
const GROUPS: { key: GroupKey; title: string }[] = [
  { key: "blocked", title: "需要你" },
  { key: "working", title: "工作中" },
  { key: "done", title: "已完成" },
  { key: "idle", title: "空闲" },
  { key: "offline", title: "离线" },
];

const byRecent = (x: Agent, y: Agent) => (y.statusSince ?? y.updatedAt) - (x.statusSince ?? x.updatedAt);

/** Shortens `s` to `max` characters with an ellipsis (placeholders cannot ellipsize in CSS). */
function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

type GroupMode = "space" | "status";
const GROUP_MODE_KEY = "herdr-pocket-agents-group";
const FOLDED_SPACES_KEY = "herdr-pocket-folded-spaces";
const STATUS_RANK: Record<GroupKey, number> = { blocked: 0, working: 1, done: 2, idle: 3, offline: 4 };

function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage off: the choice lasts for this session only.
  }
}

interface QuickMenuState {
  agent: Agent;
  x: number;
  y: number;
  /** Bottom sheet (long press, narrow windows) instead of a menu at the pointer. */
  sheet: boolean;
}

const LONG_PRESS_MS = 500;

function AgentRow({
  agent,
  offline,
  selected,
  dark,
  sub,
  onOpen,
  onMenu,
}: {
  agent: Agent;
  offline: boolean;
  selected: boolean;
  dark: boolean;
  sub: string;
  onOpen: () => void;
  onMenu: (x: number, y: number, sheet: boolean) => void;
}) {
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  const title = agentTitle(agent);
  return (
    <button
      className={`agent-row${selected ? " selected" : ""}${agent.status === "blocked" && !offline ? " needs-you" : ""}`}
      title={title}
      onClick={() => {
        if (press.current?.fired) {
          press.current = null;
          return;
        }
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
        onMenu(e.clientX, e.clientY, false);
      }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        const { clientX: x, clientY: y } = e;
        cancel();
        press.current = {
          x,
          y,
          fired: false,
          timer: window.setTimeout(() => {
            if (press.current) press.current.fired = true;
            onMenu(x, y, true);
          }, LONG_PRESS_MS),
        };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
    >
      <VendorAvatar harness={agent.harness} isShell={agent.isShell} dark={dark} size={42} />
      <div className="grow">
        <div style={{ fontWeight: 800, fontSize: fs(14.5) }} className="truncate">
          {title}
        </div>
        <div className="faint truncate">{sub}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <PocketBadge tone={offline ? "neutral" : statusTone(agent.status)} pulse={!offline && (agent.status === "working" || agent.status === "blocked")}>
          {offline ? "离线" : STATUS_LABEL[agent.status]}
        </PocketBadge>
        <span className="faint num" style={{ fontSize: fs(11.5) }}>{relTime(agent.statusSince ?? agent.updatedAt)}</span>
      </div>
    </button>
  );
}

/** Quick actions for an agent row: a menu at the pointer, or a bottom sheet on touch / narrow windows. */
function AgentQuickMenu({
  state,
  onClose,
  onOpen,
  onNewHere,
  onCopyPath,
}: {
  state: QuickMenuState;
  onClose: () => void;
  onOpen: (tab: "chat" | "term") => void;
  onNewHere: () => void;
  onCopyPath: () => void;
}) {
  const space = agentSpace(state.agent);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      className="menu-item"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClose();
        fn();
      }}
    >
      {label}
    </button>
  );
  const items = (
    <>
      {item("打开对话", () => onOpen("chat"))}
      {item("看终端", () => onOpen("term"))}
      {item(space ? `在「${space}」再开一个` : "在这台电脑再开一个", onNewHere)}
      {item("复制文件夹路径", onCopyPath, !state.agent.cwd)}
    </>
  );
  if (state.sheet) {
    return (
      <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="action-sheet" role="menu" aria-label={agentTitle(state.agent)}>
          <div className="action-sheet-title truncate">{agentTitle(state.agent)}</div>
          {items}
          <button className="menu-item action-sheet-cancel" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="ctx-backdrop" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        className="ctx-menu"
        role="menu"
        style={{ left: Math.min(state.x, window.innerWidth - 200), top: Math.min(state.y, window.innerHeight - 190) }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {items}
      </div>
    </div>
  );
}

export function AgentsView({
  mobileLayout,
  selectedKey,
  onSelectAgent,
  onOpenWorkbench,
}: {
  mobileLayout: boolean;
  selectedKey: string | null;
  onSelectAgent: (key: string | null) => void;
  /** Opens the agent's working folder in the workbench. */
  onOpenWorkbench?: (agentKey: string) => void;
}) {
  const toast = useToast();
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const link = liveStore.use((s) => s.link);
  const showShells = settingsStore.use((s) => s.showShells);
  const hostFilterSaved = settingsStore.use((s) => s.hostFilter);
  const foldedGroups = settingsStore.use((s) => s.foldedGroups);
  const dark = settingsStore.use((s) => s.theme) === "dark";

  const [statusFilter, setStatusFilter] = useState<AgentStatus | null>(null);
  const [spaceFilter, setSpaceFilter] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const hosts = useMemo(() => {
    const list = Object.values(devices).filter((d) => d.kind === "host");
    for (const id of Object.keys(agentsMap)) {
      if (!devices[id]) {
        list.push({ id, name: id, kind: "host", online: false, createdAt: 0, lastSeenAt: 0 });
      }
    }
    return list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [devices, agentsMap]);

  const hostFilter = hostFilterSaved && hosts.some((h) => h.id === hostFilterSaved) ? hostFilterSaved : null;
  const isOnline = useCallback((a: Agent) => devices[a.deviceId]?.online ?? false, [devices]);
  const all = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);

  const onHost = useMemo(() => all.filter((a) => !hostFilter || a.deviceId === hostFilter), [all, hostFilter]);
  const spaces = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of onHost) {
      const sp = agentSpace(a);
      if (sp) m.set(sp, (m.get(sp) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [onHost]);

  const activeSpace = spaceFilter && spaces.some(([s]) => s === spaceFilter) ? spaceFilter : null;
  const inScope = useMemo(() => onHost.filter((a) => !activeSpace || agentSpace(a) === activeSpace), [onHost, activeSpace]);

  const counts = useMemo(() => {
    const c: Record<AgentStatus, number> = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
    for (const a of inScope) if (isOnline(a)) c[a.status]++;
    return c;
  }, [inScope, isOnline]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(() => {
    const by: Record<GroupKey, Agent[]> = { blocked: [], working: [], done: [], idle: [], offline: [] };
    for (const a of inScope) {
      if (q && ![spacedTitle(a), a.harness, a.where, a.cwd, a.preview].some((s) => s?.toLowerCase().includes(q))) {
        continue;
      }
      const g: GroupKey = !isOnline(a)
        ? "offline"
        : a.status === "blocked" || a.status === "working" || a.status === "done"
          ? a.status
          : "idle";
      by[g].push(a);
    }
    return GROUPS.filter((g) => by[g.key].length && (!statusFilter || g.key === statusFilter)).map((g) => {
      const folded = !q && !statusFilter && foldedGroups.includes(g.key);
      return { key: g.key, title: g.title, count: by[g.key].length, folded, data: folded ? [] : by[g.key].sort(byRecent) };
    });
  }, [foldedGroups, inScope, isOnline, q, statusFilter]);

  const toggleGroup = (k: GroupKey) => {
    updateSettings({
      foldedGroups: foldedGroups.includes(k) ? foldedGroups.filter((x) => x !== k) : [...foldedGroups, k],
    });
  };

  // "按空间": computer, then space, the way the phone app groups them (mobile R25).
  const [groupMode, setGroupModeState] = useState<GroupMode>(() => readPref<GroupMode>(GROUP_MODE_KEY, "space"));
  const setGroupMode = (m: GroupMode) => {
    setGroupModeState(m);
    writePref(GROUP_MODE_KEY, m);
  };
  const [foldedSpaces, setFoldedSpaces] = useState<string[]>(() => readPref<string[]>(FOLDED_SPACES_KEY, []));
  const toggleSpace = (id: string) => {
    const next = foldedSpaces.includes(id) ? foldedSpaces.filter((x) => x !== id) : [...foldedSpaces, id];
    setFoldedSpaces(next);
    writePref(FOLDED_SPACES_KEY, next);
  };
  const groupOf = useCallback(
    (a: Agent): GroupKey =>
      !isOnline(a) ? "offline" : a.status === "blocked" || a.status === "working" || a.status === "done" ? a.status : "idle",
    [isOnline],
  );
  const spaceGroups = useMemo(() => {
    const byDevice = new Map<string, Map<string, Agent[]>>();
    for (const a of inScope) {
      if (q && ![spacedTitle(a), a.harness, a.where, a.cwd, a.preview].some((s) => s?.toLowerCase().includes(q))) continue;
      if (statusFilter && groupOf(a) !== statusFilter) continue;
      const perSpace = byDevice.get(a.deviceId) ?? new Map<string, Agent[]>();
      const sp = agentSpace(a) ?? "";
      perSpace.set(sp, [...(perSpace.get(sp) ?? []), a]);
      byDevice.set(a.deviceId, perSpace);
    }
    const out = [...byDevice.entries()].map(([deviceId, perSpace]) => {
      const groups = [...perSpace.entries()].map(([space, list]) => {
        list.sort((x, y) => STATUS_RANK[groupOf(x)] - STATUS_RANK[groupOf(y)] || byRecent(x, y));
        const tally = { blocked: 0, working: 0, done: 0 };
        for (const a of list) {
          const g = groupOf(a);
          if (g === "blocked" || g === "working" || g === "done") tally[g]++;
        }
        const latest = Math.max(...list.map((a) => a.statusSince ?? a.updatedAt));
        const id = `${deviceId}\u0000${space}`;
        return { id, space, list, tally, latest, folded: !q && !statusFilter && foldedSpaces.includes(id) };
      });
      groups.sort((x, y) => y.tally.blocked - x.tally.blocked || y.latest - x.latest);
      const device = devices[deviceId];
      return {
        deviceId,
        name: device?.name ?? deviceId,
        online: device?.online ?? false,
        count: groups.reduce((n, g) => n + g.list.length, 0),
        blocked: groups.reduce((n, g) => n + g.tally.blocked, 0),
        groups,
      };
    });
    return out.sort((x, y) => Number(y.online) - Number(x.online) || y.blocked - x.blocked || x.name.localeCompare(y.name));
  }, [devices, foldedSpaces, groupOf, inScope, q, statusFilter]);

  const [createTarget, setCreateTarget] = useState<{ host: string | null; space: string | null }>({ host: null, space: null });
  const openCreate = (host: string | null, space: string | null) => {
    setCreateTarget({ host, space });
    setCreateOpen(true);
  };
  const [menu, setMenu] = useState<QuickMenuState | null>(null);
  const [detailTab, setDetailTab] = useState<{ key: string; tab: "chat" | "term" } | null>(null);
  const [fabCompact, setFabCompact] = useState(false);
  const lastScrollRef = useRef(0);

  const openAgentAt = (key: string, tab: "chat" | "term") => {
    setDetailTab({ key, tab });
    onSelectAgent(key);
  };

  const selectedAgent = useMemo(() => all.find((a) => a.key === selectedKey) ?? null, [all, selectedKey]);
  const onlyOfflineHosts = hosts.length > 0 && (hostFilter ? !hosts.find((h) => h.id === hostFilter)?.online : hosts.every((h) => !h.online));
  const listEmpty = groupMode === "space" ? spaceGroups.length === 0 : sections.length === 0;

  const headline = link === "online" && onlyOfflineHosts && !inScope.length
    ? "电脑离线，暂时看不到 agent"
    : counts.blocked
    ? `有 ${counts.blocked} 个 agent 在等你`
    : counts.working
      ? `${counts.working} 个 agent 正在忙`
      : counts.done
        ? "大家都忙完啦"
        : "大家都歇着呢";

  const initialTab = detailTab && detailTab.key === selectedAgent?.key ? detailTab.tab : "chat";

  if (mobileLayout && selectedAgent) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <AgentDetailPanel
          key={selectedAgent.key}
          agent={selectedAgent}
          initialTab={initialTab}
          onBack={() => {
            setDetailTab(null);
            onSelectAgent(null);
          }}
          onOpenWorkbench={onOpenWorkbench}
          mobile
        />
      </div>
    );
  }

  const quickActions = menu ? (
    <AgentQuickMenu
      state={menu}
      onClose={() => setMenu(null)}
      onOpen={(tab) => openAgentAt(menu.agent.key, tab)}
      onNewHere={() => openCreate(menu.agent.deviceId, agentSpace(menu.agent) ?? null)}
      onCopyPath={() => {
        const path = menu.agent.cwd;
        if (!path) return;
        void copyToClipboard(path).then((ok) => toast(ok ? "文件夹路径已复制" : "复制失败", !ok));
      }}
    />
  ) : null;

  const rowFor = (agent: Agent, showSpace: boolean) => {
    const offline = !isOnline(agent);
    const sub = [
      showSpace ? agentSpace(agent) : null,
      // 按空间 already shows the computer as a header.
      groupMode === "status" ? devices[agent.deviceId]?.name : null,
      agent.turn ? `第 ${agent.turn} 轮` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <AgentRow
        key={agent.key}
        agent={agent}
        offline={offline}
        selected={selectedKey === agent.key}
        dark={dark}
        sub={sub || agent.cwd || agent.harness}
        onOpen={() => openAgentAt(agent.key, "chat")}
        onMenu={(x, y, sheet) => setMenu({ agent, x, y, sheet: sheet || mobileLayout })}
      />
    );
  };

  const listPane = (
    <div className="stack" style={{ gap: 12 }}>
      <div className="between">
        <div className="row" style={{ minWidth: 0 }}>
          <PocketIconButton tooltip="筛选电脑与空间" onClick={() => setDrawerOpen(true)}>
            <Menu size={17} />
          </PocketIconButton>
          <div style={{ minWidth: 0 }}>
            <h2 className="cute-font" style={{ margin: 0, fontSize: fs(22) }}>{greeting()}</h2>
            <div className="faint truncate" title={headline}>{headline}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <PocketIconButton tooltip="搜索" active={searching} onClick={() => setSearching((v) => !v)}>
            <Search size={16} />
          </PocketIconButton>
          <PocketIconButton tooltip={showShells ? "隐藏普通终端" : "显示普通终端"} active={showShells} onClick={() => updateSettings({ showShells: !showShells })}>
            <Terminal size={16} />
          </PocketIconButton>
          {!mobileLayout ? (
            <PocketIconButton tooltip="新建 Agent" onClick={() => openCreate(hostFilter, activeSpace)}>
              <Plus size={17} />
            </PocketIconButton>
          ) : listEmpty ? null : (
            <XiaoyangOrb mood={counts.blocked ? "waiting" : counts.working ? "working" : "hello"} size={44} />
          )}
        </div>
      </div>

      {/* Stat Cards */}
      <div className="stat-grid">
        {(
          [
            { key: "blocked", label: "需要你", tone: "blush" },
            { key: "working", label: "工作中", tone: "pink" },
            { key: "done", label: "已完成", tone: "mint" },
          ] as const
        ).map((item) => {
          const active = statusFilter === item.key;
          return (
            <button
              key={item.key}
              className={`stat-tile ${item.tone}${active ? " active" : ""}`}
              onClick={() => setStatusFilter(active ? null : item.key)}
            >
              <span style={{ fontSize: fs(12.5), fontWeight: 800 }}>{item.label}</span>
              <span className="stat-tile-num num">{counts[item.key]}</span>
            </button>
          );
        })}
      </div>

      <div className="segmented group-toggle" role="tablist" aria-label="分组方式">
        <button role="tab" aria-selected={groupMode === "space"} className={groupMode === "space" ? "active" : ""} onClick={() => setGroupMode("space")}>
          按空间
        </button>
        <button role="tab" aria-selected={groupMode === "status"} className={groupMode === "status" ? "active" : ""} onClick={() => setGroupMode("status")}>
          按状态
        </button>
      </div>

      {/* Filter Tags */}
      {hostFilter || activeSpace ? (
        <div className="row wrap" style={{ gap: 6 }}>
          {hostFilter ? (
            <PocketButton size="sm" variant="soft" onClick={() => updateSettings({ hostFilter: null })}>
              <Laptop size={13} />
              <span>{hosts.find((h) => h.id === hostFilter)?.name ?? hostFilter}</span>
              <X size={13} />
            </PocketButton>
          ) : null}
          {activeSpace ? (
            <PocketButton size="sm" variant="soft" onClick={() => setSpaceFilter(null)}>
              <span>空间：{activeSpace}</span>
              <X size={13} />
            </PocketButton>
          ) : null}
        </div>
      ) : null}

      {searching ? (
        <PocketInput
          autoFocus
          placeholder="搜标题、项目、目录…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}

      {/* List */}
      {listEmpty ? (
        <EmptyState
          mood="sleepy"
          title={
            link !== "online"
              ? "还在连服务器"
              : hosts.length === 0
                ? "还没有电脑加入"
                : onlyOfflineHosts
                  ? hostFilter || hosts.length === 1
                    ? `${hosts.find((h) => h.id === (hostFilter ?? hosts[0]!.id))?.name ?? "这台电脑"}离线了`
                    : "电脑都离线了"
                  : q || statusFilter || activeSpace
                    ? "没有符合条件的 agent"
                    : "还没有 agent"
          }
          body={
            link !== "online"
              ? "连上以后，各台电脑上的 agent 会出现在这里。"
              : hosts.length === 0
                ? "在电脑上运行 herdr-pocket up，再到“设备”页扫码或配对。"
                : onlyOfflineHosts
                  ? "确认那台电脑开着、herdr-pocket 在运行；它重新上线后，agent 会自动出现在这里。"
                  : q || statusFilter || activeSpace
                    ? "换个筛选条件试试。"
                    : "点“新建”在某台电脑上开一个 agent。"
          }
          action={
            <PocketButton size="sm" variant="soft" onClick={() => pingRelay()}>
              <RefreshCw size={13} />
              <span>刷新状态</span>
            </PocketButton>
          }
        />
      ) : groupMode === "space" ? (
        <div className="stack" style={{ gap: 12 }}>
          {spaceGroups.map((dev) => (
            <div key={dev.deviceId} className="stack" style={{ gap: 8 }}>
              {spaceGroups.length > 1 ? (
                <div className="computer-head">
                  <Laptop size={15} />
                  <span className="truncate">{dev.name}</span>
                  <span className={`status-pip${dev.online ? " ok" : ""}`} aria-label={dev.online ? "在线" : "离线"} />
                  <span className="faint num">{dev.count}</span>
                </div>
              ) : null}
              {dev.groups.map((g) => {
                const label = g.space || "未分空间";
                return (
                  <div key={g.id} className="stack" style={{ gap: 6 }}>
                    <div className="space-head">
                      <button className="space-head-main" aria-expanded={!g.folded} onClick={() => !q && !statusFilter && toggleSpace(g.id)}>
                        <SpaceTileIcon
                          spaceKey={`${dev.deviceId}\u0000${label}`}
                          name={label}
                          blocked={g.tally.blocked > 0}
                          size="md"
                        />
                        <span className="space-name truncate">{label}</span>
                        <span className="faint num">{g.list.length}</span>
                        <span className="space-dots" aria-label={`需要你 ${g.tally.blocked}，工作中 ${g.tally.working}，已完成 ${g.tally.done}`}>
                          {g.tally.blocked ? <span className="space-dot blocked num">{g.tally.blocked}</span> : null}
                          {g.tally.working ? <span className="space-dot working num">{g.tally.working}</span> : null}
                          {g.tally.done ? <span className="space-dot done num">{g.tally.done}</span> : null}
                        </span>
                        <span className="grow" />
                        {!q && !statusFilter ? g.folded ? <ChevronRight size={16} /> : <ChevronDown size={16} /> : null}
                      </button>
                      {g.space && dev.online ? (
                        <PocketIconButton size="sm" className="space-add" tooltip={`在空间 ${g.space} 新建 agent`} onClick={() => openCreate(dev.deviceId, g.space)}>
                          <Plus size={14} />
                        </PocketIconButton>
                      ) : null}
                    </div>
                    {g.folded ? null : g.list.map((agent) => rowFor(agent, false))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {sections.map((sec) => (
            <div key={sec.key} className="stack" style={{ gap: 6 }}>
              <button
                className="between"
                style={{ border: 0, background: "transparent", padding: "4px 4px", cursor: "pointer", color: "var(--muted)" }}
                onClick={() => !q && !statusFilter && toggleGroup(sec.key)}
              >
                <span style={{ fontWeight: 800, fontSize: fs(13) }}>
                  {sec.title} <span className="faint num">{sec.count}</span>
                </span>
                {!q && !statusFilter ? (sec.folded ? <ChevronRight size={16} /> : <ChevronDown size={16} />) : null}
              </button>
              {sec.data.map((agent) => rowFor(agent, true))}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    // A flex column, so the narrow list's .mobile-scroll (flex: 1) gets a height and actually scrolls.
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column" }}>
      {mobileLayout ? (
        <div
          className="mobile-scroll has-fab"
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            const delta = top - lastScrollRef.current;
            if (Math.abs(delta) > 6) {
              setFabCompact(delta > 0 && top > 24);
              lastScrollRef.current = top;
            }
          }}
        >
          {listPane}
          <button
            className={`fab-new${fabCompact ? " compact" : ""}`}
            aria-label="新建 Agent"
            onClick={() => openCreate(hostFilter, activeSpace)}
          >
            <Plus size={20} />
            <span className="fab-new-label">新建</span>
          </button>
        </div>
      ) : (
        <div className="agents-split">
          <div className="agents-col">{listPane}</div>
          <div className="detail-pane">
            {selectedAgent ? (
              <AgentDetailPanel key={selectedAgent.key} agent={selectedAgent} initialTab={initialTab} onOpenWorkbench={onOpenWorkbench} />
            ) : listEmpty ? (
              <div className="detail-hint faint">agent 出现后，点左侧任意一个在这里查看对话和终端。</div>
            ) : (
              <EmptyState mood="hello" title="选一个 Agent" body="点左侧任意 agent，在这里查看实时对话、终端输出、子 agent，或者发消息与图片。" />
            )}
          </div>
        </div>
      )}
      {quickActions}

      {/* Filter Drawer Modal */}
      <PocketModal open={drawerOpen} onOpenChange={setDrawerOpen} title="按电脑或空间筛选" width={400}>
        <div className="stack">
          <div>
            <div className="faint" style={{ marginBottom: 6 }}>电脑</div>
            <div className="stack" style={{ gap: 6 }}>
              <PocketButton
                size="sm"
                variant={!hostFilter ? "primary" : "ghost"}
                onClick={() => {
                  updateSettings({ hostFilter: null });
                  setDrawerOpen(false);
                }}
              >
                全部电脑 ({all.length})
              </PocketButton>
              {hosts.map((h) => (
                <PocketButton
                  key={h.id}
                  size="sm"
                  variant={hostFilter === h.id ? "primary" : "ghost"}
                  onClick={() => {
                    updateSettings({ hostFilter: h.id });
                    setDrawerOpen(false);
                  }}
                >
                  {h.name} {!h.online ? "(离线)" : ""}
                </PocketButton>
              ))}
            </div>
          </div>

          {spaces.length > 0 ? (
            <div>
              <div className="faint" style={{ marginBottom: 6 }}>工作空间</div>
              <div className="row wrap" style={{ gap: 6 }}>
                <PocketButton
                  size="sm"
                  variant={!activeSpace ? "soft" : "ghost"}
                  onClick={() => {
                    setSpaceFilter(null);
                    setDrawerOpen(false);
                  }}
                >
                  全部空间
                </PocketButton>
                {spaces.map(([name, cnt]) => (
                  <PocketButton
                    key={name}
                    size="sm"
                    variant={activeSpace === name ? "primary" : "ghost"}
                    onClick={() => {
                      setSpaceFilter(name);
                      setDrawerOpen(false);
                    }}
                  >
                    {name} ({cnt})
                  </PocketButton>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </PocketModal>

      <CreateAgentModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        hosts={hosts}
        defaultHost={createTarget.host ?? hostFilter}
        defaultSpace={createTarget.space ?? activeSpace}
        onCreated={(info) => {
          if (info.spaceName) setSpaceFilter(info.spaceName);
          setDetailTab({ key: info.agentKey, tab: "term" });
          onSelectAgent(info.agentKey);
          toast(info.launcher === "shell" ? "已创建并打开终端" : "已创建并打开 Agent");
        }}
      />
    </div>
  );
}

function extractClipboardFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

function workedFor(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return "刚开始";
  if (sec < 60) return `已运行 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `已运行 ${min} 分 ${remSec} 秒`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `已运行 ${hr} 小时 ${remMin} 分` : `已运行 ${hr} 小时`;
}

export interface SubagentHeadInfo {
  trail: SubSession[];
  rootSubs: SubSession[];
  activeSubs: SubSession[];
  knownCount: number;
  onGoRoot: () => void;
  onSelectCrumbIndex: (idx: number) => void;
  onSelectSub: (s: SubSession, ancestors: SubSession[]) => void;
  onOpenAside: (s: SubSession, ancestors: SubSession[]) => void;
  onRefresh: () => void;
}

export function AgentDetailPanel({
  agent,
  initialTab = "chat",
  mode,
  onModeChange,
  onBack,
  onOpenWorkbench,
  onSubHeadChange,
  mobile = false,
  embedded = false,
  focused = true,
  visible = true,
}: {
  agent: Agent;
  initialTab?: "chat" | "term";
  mode?: "chat" | "term";
  onModeChange?: (mode: "chat" | "term") => void;
  onBack?: () => void;
  onOpenWorkbench?: (agentKey: string) => void;
  onSubHeadChange?: (info: SubagentHeadInfo | null) => void;
  mobile?: boolean;
  /** Inside a v3 pane: the pane header already shows harness, title, folder, and mode switcher. */
  embedded?: boolean;
  /** Whether this pane holds focus within a split tab. */
  focused?: boolean;
  /** Whether the hosting tab/slot is currently visible on screen. */
  visible?: boolean;
}) {
  const toast = useToast();
  const localHostId = useLocalHostDeviceId();
  const hostOnline = liveStore.use((s) => s.devices[agent.deviceId]?.online ?? true);
  const chatDisplayMode = settingsStore.use((s) => s.chatDisplayMode);
  const [tab, setTab] = useState<"chat" | "term">(mode ?? initialTab);
  useEffect(() => {
    if (mode === undefined) setTab(initialTab);
  }, [initialTab, mode]);
  const activeMode: "chat" | "term" = mode ?? tab;
  const selectMode = (m: "chat" | "term") => {
    if (m !== activeMode) {
      logAction("ui", "ui.mode", { mode: m });
    }
    setTab(m);
    onModeChange?.(m);
  };
  const [termVisited, setTermVisited] = useState(activeMode === "term");
  const [chatVisited, setChatVisited] = useState(activeMode === "chat");
  const modeVisitKeyRef = useRef(agent.key);
  useEffect(() => {
    if (modeVisitKeyRef.current !== agent.key) {
      modeVisitKeyRef.current = agent.key;
      setTermVisited(activeMode === "term");
      setChatVisited(activeMode === "chat");
      return;
    }
    if (activeMode === "chat") {
      setChatVisited(true);
    }
  }, [activeMode, agent.key]);
  useEffect(() => {
    if (activeMode === "term") {
      setTermVisited(true);
      return;
    }
    if (!termVisited && visible && agent.source === "hc" && localHostId === agent.deviceId) {
      // Idle pre-warm for local terminals makes Chat <-> Terminal switches instantaneous without mount flicker.
      const timer = window.setTimeout(() => setTermVisited(true), 180);
      return () => window.clearTimeout(timer);
    }
  }, [activeMode, agent.deviceId, agent.source, localHostId, termVisited, visible]);

  const [events, setEvents] = useState<ConvEvent[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadOlderError, setLoadOlderError] = useState(false);
  const [hasLoadedOlder, setHasLoadedOlder] = useState(false);
  const prevModeRef = useRef(activeMode);
  const [atBottom, setAtBottom] = useState(true);
  const [choiceLines, setChoiceLines] = useState<string[]>([]);
  const [subs, setSubs] = useState<SubSession[]>([]);
  const [subTrail, setSubTrail] = useState<SubSession[]>([]);
  const [activeChildSubs, setActiveChildSubs] = useState<SubSession[]>([]);
  const [subEvents, setSubEvents] = useState<ConvEvent[]>([]);
  const [shellRaw, setShellRaw] = useState("");
  const [discoveredSlash, setDiscoveredSlash] = useState<SlashCommandItem[]>([]);
  const [slashCategory, setSlashCategory] = useState<"all" | SlashCategory>("all");
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  const [text, setTextState] = useState(() => getComposerDraft(agent.key).text);
  const [attachments, setAttachmentsState] = useState<StagedAttachment[]>(() => getComposerDraft(agent.key).attachments);
  const draftKeyRef = useRef(agent.key);
  draftKeyRef.current = agent.key;

  const setText = useCallback((next: string | ((prev: string) => string)) => {
    setTextState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      setComposerDraftText(draftKeyRef.current, resolved);
      return resolved;
    });
  }, []);

  const setAttachments = useCallback((next: StagedAttachment[] | ((prev: StagedAttachment[]) => StagedAttachment[])) => {
    setAttachmentsState((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      setComposerDraftAttachments(draftKeyRef.current, resolved);
      return resolved;
    });
  }, []);

  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [portalModalOpen, setPortalModalOpen] = useState(false);
  const [activePortalId, setActivePortalId] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageReport, setUsageReport] = useState<AgentUsageReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [modelMenuMode, setModelMenuMode] = useState<"model" | "thinking" | null>(null);
  const [modelMenuOmpTab, setModelMenuOmpTab] = useState<"session" | "roles">("session");
  const hasReasoningEvents = useMemo(() => events.some((e) => e.kind === "reasoning"), [events]);
  const modelMeta = useAutoAgentModelMeta(agent, { hasReasoningEvents, thinkingLevel: agent.thinkingLevel });
  const effectiveThinkingLevels = useMemo(() => {
    if (agent.isShell || modelMeta.canSwitchThinking === false) {
      return [];
    }
    return modelMeta.thinkingLevels ?? [];
  }, [agent.isShell, modelMeta.canSwitchThinking, modelMeta.thinkingLevels]);
  const applyModelMetaOverride = modelMeta.applyOverride;
  const clearModelMetaOverride = modelMeta.clearOverride;
  const [btwTurnsByAgent, setBtwTurnsByAgent] = useState<Record<string, BtwTurn[]>>({});
  const [chipDismissedPrefix, setChipDismissedPrefix] = useState<string | null>(null);
  const btwTurns = btwTurnsByAgent[agent.key] ?? [];

  useEffect(() => {
    const draft = getComposerDraft(agent.key);
    setTextState(draft.text);
    setAttachmentsState(draft.attachments);
    setUsageOpen(false);
    setUsageReport(null);
    setUsageError(null);
    setModelMenuMode(null);
    setModelMenuOmpTab("session");
    setChipDismissedPrefix(null);
  }, [agent.key]);

  useEffect(() => {
    return subscribeComposerDrafts(() => {
      const draft = getComposerDraft(agent.key);
      setTextState(draft.text);
      setAttachmentsState(draft.attachments);
    });
  }, [agent.key]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const panelRef = useRef<HTMLDivElement>(null);
  const composerCardRef = useRef<HTMLDivElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const effortBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const initialPositionedRef = useRef(false);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const inFlightCursorRef = useRef<string | null>(null);
  const prevScrollTopRef = useRef(0);
  const autoFillCountRef = useRef(0);
  const workingStartRef = useRef<number | null>(agent.status === "working" ? (agent.statusSince ?? Date.now()) : null);
  const streamLiveRef = useRef(false);
  const hadOpenRef = useRef(false);
  const hasSubsRef = useRef(false);
  hasSubsRef.current = Boolean(agent.subagents || subs.length);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const subLiveRef = useRef(false);
  const sessionTrackRef = useRef<{ agentKey: string; sessionKey?: string }>({ agentKey: agent.key, sessionKey: agent.sessionKey });
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<StagedAttachment[]>([]);
  attachmentsRef.current = attachments;

  const overlayOpenCount = overlayStore.use((s) => s.open);
  const settingsOpen = Boolean(shellStore.use((s) => s.settings));
  const paletteOpen = Boolean(shellStore.use((s) => s.palette));
  const [unreadCount, setUnreadCount] = useState(0);
  const lastTrackedRowIdRef = useRef<string | null>(null);
  const [winFocused, setWinFocused] = useState(
    () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus()),
  );
  useEffect(() => {
    const sync = () => {
      setWinFocused(typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus()));
    };
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const { queued, outgoing, pendingSwitch, captured } = useAgentChatQueue(agent.key);
  const activeSub = subTrail[subTrail.length - 1] ?? null;
  const isPlainShellChat = Boolean(agent.isShell && !agent.sessionKey && !activeSub);

  useEffect(() => {
    if (agent.status === "working") {
      if (workingStartRef.current === null) workingStartRef.current = agent.statusSince ?? Date.now();
    } else {
      workingStartRef.current = null;
    }
  }, [agent.key, agent.status, agent.statusSince]);

  useEffect(() => {
    if (activeMode !== "chat" || !visible || (agent.status !== "working" && outgoing.length === 0 && !sending)) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeMode, agent.status, outgoing.length, sending, visible]);

  useEffect(() => {
    if (!chatVisited) return;
    let alive = true;
    const prev = sessionTrackRef.current;
    const sessionSwitched = prev.agentKey !== agent.key || (Boolean(prev.sessionKey) && Boolean(agent.sessionKey) && prev.sessionKey !== agent.sessionKey);
    sessionTrackRef.current = { agentKey: agent.key, sessionKey: agent.sessionKey };
    if (sessionSwitched) {
      setEvents([]);
      setOlderCursor(null);
      setLoadingOlder(false);
      setLoadOlderError(false);
      setHasLoadedOlder(false);
      setChoiceLines([]);
      setSubs([]);
      setSubTrail([]);
      setActiveChildSubs([]);
      setSubEvents([]);
      setShellRaw("");
      setDiscoveredSlash([]);
      setSlashDismissedFor(null);
      stickRef.current = true;
      initialPositionedRef.current = false;
      prependAnchorRef.current = null;
      inFlightCursorRef.current = null;
      prevScrollTopRef.current = 0;
      autoFillCountRef.current = 0;
      setAtBottom(true);
      setUnreadCount(0);
      lastTrackedRowIdRef.current = null;
    }
    streamLiveRef.current = false;
    hadOpenRef.current = false;
    const merger = createBufferedEventMerger((batch) => {
      if (alive) setEvents((prevList) => mergeConvEvents(prevList, batch));
    });

    void rpcCall(agent.deviceId, "session.events", { agent: agent.key, limit: 200 })
      .then((res) => {
        if (!alive) return;
        merger.onInitialPage(res.events);
        setOlderCursor(res.more ? (res.nextBefore ?? null) : null);
      })
      .catch(() => {
        if (alive) merger.onInitialReady();
      });

    const unsubSession = subscribeStream(
      agent.deviceId,
      "session",
      { agent: agent.key },
      (ev) => {
        if (!alive || !ev) return;
        if ((ev.kind === "session" || ev.kind === "session_event") && ev.event) {
          merger.onStreamEvent(ev.event as ConvEvent);
        }
      },
      (st) => {
        if (!alive) return;
        if (st?.kind === "live") {
          const reopened = hadOpenRef.current && !streamLiveRef.current;
          hadOpenRef.current = true;
          streamLiveRef.current = true;
          if (reopened) {
            void rpcCall(agent.deviceId, "session.events", { agent: agent.key, limit: 120 })
              .then((res) => {
                if (alive) setEvents((prevList) => mergeConvEvents(prevList, res.events));
              })
              .catch(() => {});
          }
        } else {
          streamLiveRef.current = false;
        }
      },
    );

    const pollTimer = window.setInterval(() => {
      if (!alive || !visibleRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (hasSubsRef.current) {
        void rpcCall(agent.deviceId, "session.children", { agent: agent.key })
          .then((res) => {
            if (alive) setSubs(res.sessions);
          })
          .catch(() => {});
      }
      if (streamLiveRef.current || !agent.sessionKey) return;
      void rpcCall(agent.deviceId, "session.events", { agent: agent.key, limit: 80 })
        .then((res) => {
          if (alive) setEvents((prevList) => mergeConvEvents(prevList, res.events));
        })
        .catch(() => {});
    }, 3_000);

    return () => {
      alive = false;
      merger.dispose();
      window.clearInterval(pollTimer);
      unsubSession();
    };
  }, [agent.deviceId, agent.key, agent.sessionKey, chatVisited]);

  const lastSeenMarkRef = useRef<string | null>(null);
  const wasVisibleForSeenRef = useRef(false);
  const isActivelyViewed = visible && (!embedded || focused);
  const canMarkSeen = isActivelyViewed && atBottom && overlayOpenCount === 0 && !settingsOpen && !paletteOpen && winFocused;
  useEffect(() => {
    const justBecameViewed = canMarkSeen && !wasVisibleForSeenRef.current;
    wasVisibleForSeenRef.current = canMarkSeen;
    if (!canMarkSeen || agent.status !== "done") {
      if (agent.status !== "done") lastSeenMarkRef.current = null;
      return;
    }
    const mark = `${agent.key}:${agent.turn ?? ""}`;
    if (lastSeenMarkRef.current === mark && !justBecameViewed) return;
    lastSeenMarkRef.current = mark;
    liveStore.set((prev) => {
      const list = prev.agents[agent.deviceId];
      if (!list?.some((a) => a.key === agent.key && a.status === "done")) return prev;
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [agent.deviceId]: list.map((a) =>
            a.key === agent.key && a.status === "done" ? { ...a, status: "idle" } : a,
          ),
        },
        rev: prev.rev + 1,
      };
    });
    void rpcCall(agent.deviceId, "agent.seen", { agent: agent.key }).catch(() => {});
  }, [agent.deviceId, agent.key, agent.status, agent.turn, canMarkSeen]);

  useEffect(() => {
    if (!chatVisited || !agent.subagents) return;
    let alive = true;
    void rpcCall(agent.deviceId, "session.children", { agent: agent.key })
      .then((res) => {
        if (alive) setSubs(res.sessions);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent.deviceId, agent.key, agent.subagents, chatVisited]);

  const activeSubKey = activeSub?.key;
  useEffect(() => {
    if (!activeSubKey) {
      setSubEvents([]);
      setActiveChildSubs([]);
      return;
    }
    let alive = true;
    let subLive = false;
    setSubEvents([]);
    setActiveChildSubs([]);
    const merger = createBufferedEventMerger((batch) => {
      if (alive) setSubEvents((prev) => mergeConvEvents(prev, batch));
    });

    void rpcCall(agent.deviceId, "session.events", { agent: agent.key, sub: activeSubKey, limit: 200 })
      .then((res) => {
        if (alive) merger.onInitialPage(res.events);
      })
      .catch(() => {
        if (alive) merger.onInitialReady();
      });

    void rpcCall(agent.deviceId, "session.children", { agent: agent.key, sub: activeSubKey })
      .then((res) => {
        if (alive) setActiveChildSubs(res.sessions);
      })
      .catch(() => {});

    const unsubSub = subscribeStream(
      agent.deviceId,
      "session",
      { agent: agent.key, sub: activeSubKey },
      (ev) => {
        if (!alive || !ev) return;
        if ((ev.kind === "session" || ev.kind === "session_event") && ev.event) {
          merger.onStreamEvent(ev.event as ConvEvent);
        }
      },
      (st) => {
        if (alive) {
          subLive = st?.kind === "live";
          subLiveRef.current = subLive;
        }
      },
    );

    const pollTimer = window.setInterval(() => {
      if (!alive || !visibleRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (!subLive) {
        void rpcCall(agent.deviceId, "session.events", { agent: agent.key, sub: activeSubKey, limit: 120 })
          .then((res) => {
            if (alive) setSubEvents((prev) => mergeConvEvents(prev, res.events));
          })
          .catch(() => {});
      }
      void rpcCall(agent.deviceId, "session.children", { agent: agent.key, sub: activeSubKey })
        .then((res) => {
          if (alive) setActiveChildSubs(res.sessions);
        })
        .catch(() => {});
    }, 3_000);

    return () => {
      alive = false;
      subLiveRef.current = false;
      merger.dispose();
      window.clearInterval(pollTimer);
      unsubSub();
    };
  }, [activeSubKey, agent.deviceId, agent.key]);

  useEffect(() => {
    if (!isPlainShellChat || activeMode !== "chat") return;
    let alive = true;
    let live = false;
    let lines: string[] = [];

    const commit = (raw: string) => {
      if (!alive) return;
      lines = raw.split("\n");
      setShellRaw(raw);
    };

    void rpcCall(agent.deviceId, "terminal.read", { agent: agent.key, lines: 220 })
      .then((res) => commit(res.text || res.ansi || ""))
      .catch(() => {});

    const unsubTerm = subscribeStream(
      agent.deviceId,
      "terminal",
      { agent: agent.key, lines: 220, rows: true },
      (ev) => {
        if (!alive || !ev) return;
        if (ev.kind === "terminal" && ev.screen) {
          commit(String(ev.screen.text || ev.screen.ansi || ""));
        } else if (ev.kind === "terminal_rows") {
          lines = applyRows(lines, ev);
          setShellRaw(lines.join("\n"));
        } else if (ev.kind === "portal_event") {
          ingestPortalStreamEvent(ev);
        }
      },
      (st) => {
        if (alive) live = st?.kind === "live";
      },
    );

    const pollTimer = window.setInterval(() => {
      if (!alive || live || !visibleRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void rpcCall(agent.deviceId, "terminal.read", { agent: agent.key, lines: 220 })
        .then((res) => commit(res.text || res.ansi || ""))
        .catch(() => {});
    }, 2_000);

    return () => {
      alive = false;
      window.clearInterval(pollTimer);
      unsubTerm();
    };
  }, [activeMode, agent.deviceId, agent.key, isPlainShellChat]);

  const prevPollVisibleRef = useRef(visible);
  useEffect(() => {
    const wasVisible = prevPollVisibleRef.current;
    prevPollVisibleRef.current = visible;
    if (!visible || wasVisible) return;
    let alive = true;
    if (!streamLiveRef.current && agent.sessionKey) {
      void rpcCall(agent.deviceId, "session.events", { agent: agent.key, limit: 80 })
        .then((res) => {
          if (alive) setEvents((prevList) => mergeConvEvents(prevList, res.events));
        })
        .catch(() => {});
    }
    if (hasSubsRef.current) {
      void rpcCall(agent.deviceId, "session.children", { agent: agent.key })
        .then((res) => {
          if (alive) setSubs(res.sessions);
        })
        .catch(() => {});
    }
    if (activeSubKey && !subLiveRef.current) {
      void rpcCall(agent.deviceId, "session.events", { agent: agent.key, sub: activeSubKey, limit: 120 })
        .then((res) => {
          if (alive) setSubEvents((prev) => mergeConvEvents(prev, res.events));
        })
        .catch(() => {});
      void rpcCall(agent.deviceId, "session.children", { agent: agent.key, sub: activeSubKey })
        .then((res) => {
          if (alive) setActiveChildSubs(res.sessions);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [activeSubKey, agent.deviceId, agent.key, agent.sessionKey, visible]);

  useEffect(() => {
    if (!chatVisited || agent.isShell) {
      setDiscoveredSlash([]);
      return;
    }
    let alive = true;
    void rpcCall(agent.deviceId, "agent.commands", { agent: agent.key })
      .then((res) => {
        if (alive) setDiscoveredSlash(Array.isArray(res?.commands) ? res.commands : []);
      })
      .catch(() => {
        if (alive) setDiscoveredSlash([]);
      });
    return () => {
      alive = false;
    };
  }, [agent.cwd, agent.deviceId, agent.harness, agent.isShell, agent.key, chatVisited]);

  useEffect(() => {
    if (activeMode !== "chat" || agent.status !== "blocked") {
      setChoiceLines([]);
      return;
    }
    let alive = true;
    void rpcCall(agent.deviceId, "terminal.read", { agent: agent.key, lines: 40 })
      .then((res) => {
        if (alive) setChoiceLines((res.ansi || res.text || "").split("\n"));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeMode, agent.deviceId, agent.key, agent.status, events.length]);

  const choices = useMemo(() => (activeMode === "chat" && choiceLines.length ? parseChoices(choiceLines) : []), [activeMode, choiceLines]);
  const displayedEvents = activeSub ? subEvents : events;
  const shellChat = useMemo(() => (isPlainShellChat ? parseTerminalChatTranscript(shellRaw) : null), [isPlainShellChat, shellRaw]);
  const cachedFoldedRef = useRef<ChatRow[]>([]);
  const foldedRows = useMemo(() => {
    if (isPlainShellChat) return [];
    if (activeMode !== "chat") return cachedFoldedRef.current;
    const next = foldConvEvents(displayedEvents, chatDisplayMode);
    cachedFoldedRef.current = next;
    return next;
  }, [activeMode, chatDisplayMode, displayedEvents, isPlainShellChat]);
  const isTurnBusy = useMemo(() => isAgentTurnBusy(agent.status, foldedRows), [agent.status, foldedRows]);
  const convReconciled = useMemo(
    () => reconcileOutgoingSends(outgoing, foldedRows, agent.status, nowTick),
    [agent.status, foldedRows, nowTick, outgoing],
  );
  const reconciled = useMemo(() => {
    if (!isPlainShellChat || !shellChat) return convReconciled;
    const matchedIds: string[] = [];
    const expiredIds: string[] = [];
    const unmatched = outgoing.filter((item) => {
      if (item.state === "sending" || item.state === "failed") return true;
      const age = nowTick - item.ts;
      const matched = shellChat.turns.some((t) => shellTurnMatchesCommand(t, item.text));
      if (matched) {
        matchedIds.push(item.id);
        return false;
      }
      if (age > 4500) {
        expiredIds.push(item.id);
        return false;
      }
      return true;
    });
    return { unmatched, matchedIds, expiredIds, awaitingReply: false };
  }, [convReconciled, isPlainShellChat, nowTick, outgoing, shellChat]);

  const cachedSegmentsRef = useRef<
    Array<
      | { kind: "rows"; id: string; rows: ChatRow[] }
      | { kind: "outgoing"; send: OutgoingSend }
      | { kind: "captured"; cap: CapturedCommandEntry }
    >
  >([]);
  const timelineSegments = useMemo(() => {
    if (activeMode !== "chat") return cachedSegmentsRef.current;
    const items = interleaveOptimisticSends(foldedRows, reconciled.unmatched);
    const sortedCaps = !isPlainShellChat && !activeSub ? [...captured].sort((a, b) => a.ts - b.ts) : [];
    const segs: Array<
      | { kind: "rows"; id: string; rows: ChatRow[] }
      | { kind: "outgoing"; send: OutgoingSend }
      | { kind: "captured"; cap: CapturedCommandEntry }
    > = [];
    const rowEndTs = (r: ChatRow) => (r.kind === "activity_group" ? r.endTs : r.ts);
    let cIdx = 0;
    const pushRow = (row: ChatRow) => {
      const last = segs[segs.length - 1];
      if (last?.kind === "rows") last.rows.push(row);
      else segs.push({ kind: "rows", id: `seg-${row.id}`, rows: [row] });
    };
    for (const item of items) {
      const itemTs = item.kind === "outgoing" ? item.send.ts : rowEndTs(item.row);
      while (cIdx < sortedCaps.length && (itemTs === 0 || sortedCaps[cIdx]!.ts <= itemTs)) {
        segs.push({ kind: "captured", cap: sortedCaps[cIdx]! });
        cIdx += 1;
      }
      if (item.kind === "outgoing") {
        segs.push(item);
      } else {
        pushRow(item.row);
      }
    }
    while (cIdx < sortedCaps.length) {
      segs.push({ kind: "captured", cap: sortedCaps[cIdx]! });
      cIdx += 1;
    }
    cachedSegmentsRef.current = segs;
    return segs;
  }, [activeMode, activeSub, captured, foldedRows, isPlainShellChat, reconciled.unmatched]);

  const allSlashCommands = useMemo(
    () => mergeSlashCommands(builtinSlashCommands(agent.harness, agent.isShell), discoveredSlash),
    [agent.harness, agent.isShell, discoveredSlash],
  );
  const rawLeadingSlash = !agent.isShell && !activeSub ? parseLeadingSlashToken(text, allSlashCommands) : null;
  const leadingSlash =
    rawLeadingSlash && chipDismissedPrefix?.toLowerCase() !== rawLeadingSlash.rawToken.toLowerCase()
      ? rawLeadingSlash
      : null;
  const composerInputValue = leadingSlash ? leadingSlash.rest : text;
  const isBtwDraft = !agent.isShell && !activeSub && attachments.length === 0 && /^\/btw(?:\s|$)/i.test(text.trim());

  useEffect(() => {
    if (chipDismissedPrefix && (!rawLeadingSlash || !text.trim())) {
      setChipDismissedPrefix(null);
    }
  }, [chipDismissedPrefix, rawLeadingSlash, text]);

  const slashQuery = !agent.isShell && !activeSub ? extractSlashQuery(text) : null;
  const matchedSlash = useMemo(
    () => (slashQuery === null ? [] : matchSlashCommands(allSlashCommands, slashQuery, slashCategory)),
    [allSlashCommands, slashCategory, slashQuery],
  );
  const slashOpen =
    slashQuery !== null &&
    slashDismissedFor !== text &&
    (matchedSlash.length > 0 || slashCategory !== "all" || Boolean(slashQuery));

  useEffect(() => {
    setSlashIdx(0);
  }, [slashQuery, slashCategory]);

  useEffect(() => {
    const toDrop = [...reconciled.matchedIds, ...reconciled.expiredIds];
    if (toDrop.length > 0) pruneOutgoingSends(agent.key, toDrop);
  }, [agent.key, reconciled.expiredIds, reconciled.matchedIds]);

  const refreshRootSubs = useCallback(() => {
    void rpcCall(agent.deviceId, "session.children", { agent: agent.key })
      .then((res) => setSubs(res.sessions))
      .catch(() => {});
  }, [agent.deviceId, agent.key]);

  const selectSubInPlace = useCallback((s: SubSession, ancestors: SubSession[]) => {
    setSubTrail([...ancestors, s]);
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  const openSubAsideView = useCallback(
    (s: SubSession, ancestors: SubSession[]) => {
      openSubagentAside(agent.key, s, [...ancestors, s]);
    },
    [agent.key],
  );

  const selectCrumbIndex = useCallback((idx: number) => {
    setSubTrail((prev) => prev.slice(0, idx + 1));
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  const goRootSub = useCallback(() => {
    setSubTrail([]);
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  const knownSubCount = Math.max(agent.subagents ?? 0, subs.length);
  useEffect(() => {
    if (!embedded || !onSubHeadChange) return;
    if (knownSubCount === 0 && subTrail.length === 0) {
      onSubHeadChange(null);
      return;
    }
    onSubHeadChange({
      trail: subTrail,
      rootSubs: subs,
      activeSubs: activeChildSubs,
      knownCount: knownSubCount,
      onGoRoot: goRootSub,
      onSelectCrumbIndex: selectCrumbIndex,
      onSelectSub: selectSubInPlace,
      onOpenAside: openSubAsideView,
      onRefresh: refreshRootSubs,
    });
  }, [
    activeChildSubs,
    embedded,
    goRootSub,
    knownSubCount,
    onSubHeadChange,
    openSubAsideView,
    refreshRootSubs,
    selectCrumbIndex,
    selectSubInPlace,
    subTrail,
    subs,
  ]);

  useEffect(() => {
    return () => {
      onSubHeadChange?.(null);
    };
  }, [onSubHeadChange]);

  const activeToolLabel = useMemo(() => {
    for (let i = foldedRows.length - 1; i >= Math.max(0, foldedRows.length - 5); i -= 1) {
      const r = foldedRows[i]!;
      if (r.kind === "activity_group" && r.running) {
        return r.activeStep
          ? `${r.activeStep.name}${r.activeStep.summary ? ` · ${clip(r.activeStep.summary, 36)}` : ""}`
          : "工具调用";
      }
      if (r.kind === "tool" && r.step.running) {
        return `${r.step.name}${r.step.summary ? ` · ${clip(r.step.summary, 36)}` : ""}`;
      }
    }
    return null;
  }, [foldedRows]);

  const rawTerminalQueued = useMemo(
    () =>
      activeSub
        ? []
        : agent.queuedItems?.length
          ? agent.queuedItems
          : agent.queued && agent.queuedText
            ? [agent.queuedText]
            : [],
    [activeSub, agent.queued, agent.queuedItems, agent.queuedText],
  );
  const terminalQueuedItems = useMemo(
    () =>
      rawTerminalQueued.filter(
        (qText) =>
          qText.trim() &&
          !reconciled.unmatched.some((u) => sameMessage(qText, u.text)) &&
          !queued.some((q) => sameMessage(qText, q.text)),
      ),
    [queued, rawTerminalQueued, reconciled.unmatched],
  );

  const hasAnyRenderedRows =
    foldedRows.length > 0 ||
    reconciled.unmatched.length > 0 ||
    captured.length > 0 ||
    terminalQueuedItems.length > 0 ||
    Boolean(shellChat && (shellChat.turns.length > 0 || shellChat.preambleLines.length > 0));

  const scrollToBottom = useCallback((smooth = false) => {
    stickRef.current = true;
    setAtBottom(true);
    setUnreadCount(0);
    const el = chatScrollRef.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = hasAnyRenderedRows ? el.scrollHeight : 0;
  }, [hasAnyRenderedRows]);

  const loadOlderEvents = useCallback(async () => {
    const cursor = olderCursor;
    if (!cursor || inFlightCursorRef.current === cursor) return;
    inFlightCursorRef.current = cursor;
    const reqAgentKey = agent.key;
    setLoadingOlder(true);
    setLoadOlderError(false);
    try {
      const res = await rpcCall(agent.deviceId, "session.events", { agent: agent.key, before: cursor, limit: 200 });
      if (sessionTrackRef.current.agentKey !== reqAgentKey) return;
      const el = chatScrollRef.current;
      prependAnchorRef.current = el ? { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop } : null;
      stickRef.current = false;
      setAtBottom(false);
      setHasLoadedOlder(true);
      setEvents((prevList) => mergeConvEvents(prevList, res.events));
      const nextCursor =
        !res.more || !res.nextBefore || res.nextBefore === cursor || res.events.length === 0
          ? null
          : res.nextBefore;
      setOlderCursor(nextCursor);
    } catch (e) {
      setLoadOlderError(true);
      toast((e as Error).message, true);
    } finally {
      if (inFlightCursorRef.current === cursor) inFlightCursorRef.current = null;
      setLoadingOlder(false);
    }
  }, [agent.deviceId, agent.key, olderCursor, toast]);

  useEffect(() => {
    const tail = captured.length ? `cap:${captured[captured.length - 1]!.id}` : foldedRows.length ? `row:${foldedRows[foldedRows.length - 1]!.id}` : null;
    if (!tail) {
      lastTrackedRowIdRef.current = null;
      return;
    }
    if (atBottom) {
      lastTrackedRowIdRef.current = tail;
      if (unreadCount !== 0) setUnreadCount(0);
      return;
    }
    const prevTail = lastTrackedRowIdRef.current;
    if (prevTail && prevTail !== tail && initialPositionedRef.current) {
      setUnreadCount((c) => Math.min(99, c + 1));
    }
    lastTrackedRowIdRef.current = tail;
  }, [atBottom, captured, foldedRows, unreadCount]);

  useLayoutEffect(() => {
    const justEnteredChat = prevModeRef.current !== "chat" && activeMode === "chat";
    prevModeRef.current = activeMode;
    if (activeMode !== "chat") return;
    const el = chatScrollRef.current;
    if (!el) return;
    const hasSelectionInside = () => {
      if (typeof window === "undefined") return false;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return false;
      return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
    };
    const hasAnyRows = hasAnyRenderedRows;
    if (prependAnchorRef.current) {
      const anchor = prependAnchorRef.current;
      prependAnchorRef.current = null;
      el.scrollTop = anchor.scrollTop + Math.max(0, el.scrollHeight - anchor.scrollHeight);
      prevScrollTopRef.current = el.scrollTop;
      return;
    }
    if (justEnteredChat && initialPositionedRef.current && !stickRef.current) {
      el.scrollTop = prevScrollTopRef.current;
      return;
    }
    if (!initialPositionedRef.current && hasAnyRows) {
      el.scrollTop = el.scrollHeight;
      prevScrollTopRef.current = el.scrollTop;
      initialPositionedRef.current = true;
      stickRef.current = true;
      setAtBottom(true);
      setUnreadCount(0);
      return;
    }
    if (stickRef.current && !hasSelectionInside()) {
      el.scrollTop = hasAnyRows || agent.status === "working" || reconciled.awaitingReply || sending ? el.scrollHeight : 0;
      prevScrollTopRef.current = el.scrollTop;
    }
    if (
      !activeSub &&
      !isPlainShellChat &&
      initialPositionedRef.current &&
      olderCursor &&
      !loadingOlder &&
      !loadOlderError &&
      el.scrollHeight <= el.clientHeight + 24 &&
      autoFillCountRef.current < 3
    ) {
      autoFillCountRef.current += 1;
      void loadOlderEvents();
    }
  }, [
    activeMode,
    activeSub,
    agent.status,
    captured,
    foldedRows,
    hasAnyRenderedRows,
    isPlainShellChat,
    loadOlderError,
    loadOlderEvents,
    loadingOlder,
    olderCursor,
    reconciled.awaitingReply,
    sending,
    shellChat,
    terminalQueuedItems.length,
  ]);

  const chatScrollRafRef = useRef<number>(0);
  const runChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const prevTop = prevScrollTopRef.current;
    prevScrollTopRef.current = top;
    const nearBottom = el.scrollHeight - top - el.clientHeight < 72;
    stickRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setUnreadCount(0);
    if (
      !activeSub &&
      !isPlainShellChat &&
      initialPositionedRef.current &&
      olderCursor &&
      !loadingOlder &&
      !loadOlderError &&
      top <= 180 &&
      (top < prevTop || top <= 64)
    ) {
      void loadOlderEvents();
    }
  }, [activeSub, isPlainShellChat, loadOlderError, loadOlderEvents, loadingOlder, olderCursor]);

  const onChatScroll = useCallback(() => {
    if (chatScrollRafRef.current) return;
    chatScrollRafRef.current = requestAnimationFrame(() => {
      chatScrollRafRef.current = 0;
      runChatScroll();
    });
  }, [runChatScroll]);

  useEffect(() => {
    return () => {
      if (chatScrollRafRef.current) {
        cancelAnimationFrame(chatScrollRafRef.current);
        chatScrollRafRef.current = 0;
      }
    };
  }, []);

  const openUsageView = useCallback(() => {
    setUsageOpen(true);
    setUsageLoading(true);
    setUsageError(null);
    void rpcCall(agent.deviceId, "agent.usage", { agent: agent.key })
      .then((res) => setUsageReport(res))
      .catch((e) => setUsageError((e as Error).message || "读取用量统计失败"))
      .finally(() => setUsageLoading(false));
  }, [agent.deviceId, agent.key]);

  const runModelOrThinkingSwitch = useCallback(
    async (opts: { modelId?: string; thinkingLevel?: string }) => {
      const modelId = opts.modelId?.trim() || undefined;
      const thinkingLevel = opts.thinkingLevel?.trim().toLowerCase() || undefined;
      if (!modelId && !thinkingLevel) return;

      const labelDesc = modelId && thinkingLevel
        ? `${modelId} · ${formatEffortLabel(thinkingLevel)}`
        : modelId
          ? modelId
          : `思考等级 ${formatEffortLabel(thinkingLevel)}`;

      const resolvedAlias =
        modelId && normalizeSwitchHarness(agent.harness) === "omp" && modelId.startsWith("@")
          ? modelMeta.modelRoles?.[modelId.slice(1).toLowerCase()]
          : undefined;
      const displayModel = resolvedAlias ? stripModelEffortSuffix(resolvedAlias) : modelId ? stripModelEffortSuffix(modelId) : undefined;

      applyModelMetaOverride({
        ...(displayModel ? { currentModel: displayModel } : {}),
        ...(thinkingLevel ? { currentThinking: thinkingLevel } : {}),
      });
      stickRef.current = true;
      setAtBottom(true);

      const plan = buildHarnessSwitchCommands(agent.harness, { modelId, thinkingLevel });
      if (agent.status === "working") {
        schedulePendingModelSwitch(agent, { modelId, thinkingLevel, label: labelDesc });
        toast(`本轮结束后将自动切换为 ${labelDesc}`);
        return;
      }

      cancelPendingModelSwitch(agent.key);
      logAction("model", "model.switch", {
        harness: agent.harness,
        hasModel: Boolean(modelId),
        hasThinking: Boolean(thinkingLevel),
      });
      setSending(true);
      try {
        const res = await rpcCall(agent.deviceId, "agent.setModel", {
          agent: agent.key,
          ...(modelId ? { modelId } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
        applyModelMetaOverride({
          ...(res.currentModel ? { currentModel: res.currentModel } : {}),
          ...(res.currentThinking ? { currentThinking: res.currentThinking } : {}),
        });
        toast(res.note || `已切换：${labelDesc}`);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        const rpcUnsupported = err?.code === "unsupported";
        if (rpcUnsupported && plan.commands.length > 0) {
          try {
            for (const cmd of plan.commands) {
              await rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: cmd, enter: true });
            }
            toast(`已切换：${labelDesc}`);
          } catch (fallbackErr) {
            clearModelMetaOverride();
            toast((fallbackErr as Error).message || "切换失败", true);
          }
        } else {
          clearModelMetaOverride();
          toast(err?.message || "切换失败", true);
        }
      } finally {
        setSending(false);
      }
    },
    [agent, applyModelMetaOverride, clearModelMetaOverride, modelMeta.modelRoles, toast],
  );

  const applyModelSwitch = useCallback(
    (modelId: string) => {
      void runModelOrThinkingSwitch({ modelId });
    },
    [runModelOrThinkingSwitch],
  );

  const applyThinkingSwitch = useCallback(
    (thinkingLevel: string, effortModelId?: string) => {
      void runModelOrThinkingSwitch({ ...(effortModelId ? { modelId: effortModelId } : {}), thinkingLevel });
    },
    [runModelOrThinkingSwitch],
  );

  const applyRoleModelSwitch = useCallback(
    async (slot: OmpModelRole, modelId: string) => {
      const clean = modelId.trim();
      if (!clean) return;
      applyModelMetaOverride({
        modelRoles: { ...(modelMeta.modelRoles ?? {}), [slot]: clean },
      });
      try {
        const res = await updateAgentRoleModel(agent, slot, clean);
        if (res.modelRoles) {
          applyModelMetaOverride({ modelRoles: res.modelRoles });
        }
        toast(res.note || `已更新 OMP 角色 ${slot} -> ${clean}`);
      } catch (e) {
        toast((e as Error).message || `更新角色 ${slot} 失败`, true);
      }
    },
    [agent, applyModelMetaOverride, modelMeta.modelRoles, toast],
  );

  const onModelsLoaded = useCallback((res: AgentModelsResult) => {
    applyModelMetaOverride({
      currentModel: res.currentModel || agent.model,
      currentThinking: res.currentThinking || agent.thinkingLevel,
      ...(res.modelRoles ? { modelRoles: res.modelRoles } : {}),
    });
  }, [agent.model, agent.thinkingLevel, applyModelMetaOverride]);

  const dismissBtwTurn = useCallback((agentKey: string, turnId?: string) => {
    setBtwTurnsByAgent((prev) => {
      const list = prev[agentKey];
      if (!list?.length) return prev;
      if (!turnId) {
        const next = { ...prev };
        delete next[agentKey];
        return next;
      }
      const filtered = list.filter((t) => t.id !== turnId);
      if (filtered.length === 0) {
        const next = { ...prev };
        delete next[agentKey];
        return next;
      }
      return { ...prev, [agentKey]: filtered };
    });
  }, []);

  const runBtwQuestion = useCallback(
    async (question: string) => {
      const targetKey = agent.key;
      const turnId = `btw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const pendingTurn: BtwTurn = {
        id: turnId,
        question,
        status: "loading",
        createdAt: Date.now(),
      };
      setBtwTurnsByAgent((prev) => ({
        ...prev,
        [targetKey]: [...(prev[targetKey] ?? []).slice(-5), pendingTurn],
      }));
      try {
        const res = await executeAgentBtw(agent, question, {
          onStream: (partialAnswer, streamModel) => {
            setBtwTurnsByAgent((prev) => {
              const list = prev[targetKey];
              if (!list?.some((t) => t.id === turnId)) return prev;
              return {
                ...prev,
                [targetKey]: list.map((t) =>
                  t.id === turnId
                    ? {
                        ...t,
                        status: "streaming",
                        answer: partialAnswer,
                        ...(streamModel ? { model: streamModel } : {}),
                      }
                    : t,
                ),
              };
            });
          },
        });
        setBtwTurnsByAgent((prev) => {
          const list = prev[targetKey];
          if (!list?.some((t) => t.id === turnId)) return prev;
          return {
            ...prev,
            [targetKey]: list.map((t) =>
              t.id === turnId
                ? { ...t, status: "done", answer: res.answer, model: res.model, durationMs: res.durationMs }
                : t,
            ),
          };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err ?? "旁路提问失败");
        setBtwTurnsByAgent((prev) => {
          const list = prev[targetKey];
          if (!list?.some((t) => t.id === turnId)) return prev;
          return {
            ...prev,
            [targetKey]: list.map((t) =>
              t.id === turnId ? { ...t, status: "error", error: msg } : t,
            ),
          };
        });
        toast(msg, true);
      }
    },
    [agent, toast],
  );

  const lastSendRef = useRef<{ sig: string; at: number } | null>(null);
  const submitComposerRef = useRef<(overrideText?: string) => void>(() => {});
  const steerComposerRef = useRef<() => void>(() => {});
  const composer = useComposerInput(
    composerInputValue,
    () => submitComposerRef.current(),
    isTurnBusy && !isBtwDraft ? () => steerComposerRef.current() : undefined,
  );

  const submitComposer = (overrideText?: string) => {
    const isOverride = overrideText !== undefined;
    const raw = (overrideText ?? text).trim();
    const staged = isOverride ? [] : attachments;
    const now = Date.now();
    const sig = `${agent.key}\0${raw}\0${staged.length}`;
    if (!raw && staged.length === 0) return;
    if (lastSendRef.current && lastSendRef.current.sig === sig && now - lastSendRef.current.at < 400) return;
    lastSendRef.current = { sig, at: now };

    const btwMatch = !agent.isShell && !activeSub && !staged.length ? /^\/btw(?:\s+([\s\S]*))?$/i.exec(raw) : null;
    if (btwMatch) {
      const question = (btwMatch[1] ?? "").trim();
      if (!question) {
        toast("请在 /btw 后输入旁路提问内容", true);
        if (!isOverride && !text.startsWith("/btw ")) setText("/btw ");
        requestAnimationFrame(() => composer.textareaRef.current?.focus());
        return;
      }
      if (!isOverride) {
        clearComposerDraft(agent.key, { revoke: false });
        setTextState("");
        setAttachmentsState([]);
        setChipDismissedPrefix(null);
      }
      void runBtwQuestion(question);
      requestAnimationFrame(() => composer.textareaRef.current?.focus());
      return;
    }

    if (!staged.length && /^\/usage$/i.test(raw)) {
      if (!isOverride) {
        setText("");
        setChipDismissedPrefix(null);
      }
      openUsageView();
      return;
    }
    if (
      !staged.length &&
      !agent.isShell &&
      !activeSub &&
      (/^\/(?:model|models)$/i.test(raw) ||
        (normalizeSwitchHarness(agent.harness) === "omp" && /^\/switch$/i.test(raw)))
    ) {
      const isOmpRoleCmd = normalizeSwitchHarness(agent.harness) === "omp" && /^\/(?:model|models)$/i.test(raw);
      if (!isOverride) {
        setText("");
        setChipDismissedPrefix(null);
      }
      setModelMenuOmpTab(isOmpRoleCmd ? "roles" : "session");
      setModelMenuMode("model");
      return;
    }
    if (!staged.length && /^\/(?:effort|thinking)$/i.test(raw) && effectiveThinkingLevels.length > 0) {
      if (!isOverride) {
        setText("");
        setChipDismissedPrefix(null);
      }
      setModelMenuMode("thinking");
      return;
    }
    if (!staged.length && !agent.isShell && !activeSub) {
      const sw = parseModelSwitchText(raw);
      if (sw && (sw.model || sw.thinking)) {
        if (!isOverride) {
          clearComposerDraft(agent.key, { revoke: false });
          setTextState("");
          setAttachmentsState([]);
          setChipDismissedPrefix(null);
        }
        void runModelOrThinkingSwitch({ modelId: sw.model, thinkingLevel: sw.thinking });
        requestAnimationFrame(() => composer.textareaRef.current?.focus());
        return;
      }
    }

    if (!isOverride) {
      clearComposerDraft(agent.key, { revoke: false });
      setTextState("");
      setAttachmentsState([]);
      setChipDismissedPrefix(null);
    }
    stickRef.current = true;
    setAtBottom(true);

    logAction("chat", "chat.send", {
      slash: raw.startsWith("/"),
      chars: raw.length,
      files: staged.length,
    });

    if (isTurnBusy) {
      enqueuePrompt(agent, raw, staged);
      requestAnimationFrame(() => composer.textareaRef.current?.focus());
      return;
    }

    setSending(true);
    void sendPromptNow(agent, raw, staged)
      .then((ok) => {
        if (!ok) {
          const list = chatQueueStore.get().outgoingByAgent[agent.key] ?? [];
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i]?.state === "failed" && list[i]?.error) {
              toast(list[i]!.error!, true);
              break;
            }
          }
        }
      })
      .finally(() => setSending(false));
  };
  submitComposerRef.current = submitComposer;

  const steerComposer = () => {
    const raw = text.trim();
    const staged = attachments;
    if (!raw && staged.length === 0) return;
    clearComposerDraft(agent.key, { revoke: false });
    setTextState("");
    setAttachmentsState([]);
    setChipDismissedPrefix(null);
    stickRef.current = true;
    setAtBottom(true);
    logAction("chat", "chat.steer", {
      slash: raw.startsWith("/"),
      chars: raw.length,
      files: staged.length,
    });
    setSending(true);
    void steerComposerNow(agent, raw, staged).finally(() => setSending(false));
    requestAnimationFrame(() => composer.textareaRef.current?.focus());
  };
  steerComposerRef.current = steerComposer;

  const interruptTurn = useCallback(() => {
    void rpcCall(agent.deviceId, "terminal.interrupt", { agent: agent.key }).catch((e) =>
      toast((e as Error).message, true),
    );
  }, [agent.deviceId, agent.key, toast]);

  useEffect(() => {
    const onAgentAction = (ev: Event) => {
      const detail = (ev as CustomEvent<{ agentKey?: string; action?: string }>).detail;
      if (!detail || detail.agentKey !== agent.key || !visibleRef.current) return;
      if (embedded && !focused) return;
      switch (detail.action) {
        case "focusComposer":
          if (activeMode !== "chat") selectMode("chat");
          requestAnimationFrame(() => composer.textareaRef.current?.focus());
          break;
        case "openModelPicker":
          if (activeMode !== "chat") selectMode("chat");
          setModelMenuOmpTab(normalizeSwitchHarness(agent.harness) === "omp" ? "roles" : "session");
          setModelMenuMode("model");
          break;
        case "openThinkingPicker":
          if (activeMode !== "chat") selectMode("chat");
          setModelMenuMode(effectiveThinkingLevels.length > 0 ? "thinking" : "model");
          break;
        case "openUsageCard":
          if (activeMode !== "chat") selectMode("chat");
          openUsageView();
          break;
        case "interruptAgent":
          interruptTurn();
          break;
        case "openPortalLauncher":
          setActivePortalId(null);
          setPortalModalOpen(true);
          break;
      }
    };
    window.addEventListener("pocket:agent-action", onAgentAction);
    return () => window.removeEventListener("pocket:agent-action", onAgentAction);
  });

  const sendKeys = async (keys: string[]) => {
    try {
      await rpcCall(agent.deviceId, "terminal.keys", { agent: agent.key, keys });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const list = files ? Array.from(files) : [];
      if (!list.length) return;
      try {
        const res = await prepareDroppedFiles(
          attachmentsRef.current,
          list,
          PUT_LIMITS.files,
          PUT_LIMITS.fileBytes,
          PUT_LIMITS.totalBytes,
        );
        if (res.added.length) {
          setAttachments((prev) => [...prev, ...res.added].slice(0, PUT_LIMITS.files));
        }
        if (res.notice) toast(res.notice, true);
      } catch (e) {
        toast((e as Error).message, true);
      }
    },
    [toast],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target) revokeAttachment(target);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  const prevFocusedRef = useRef(focused);

  useEffect(() => {
    const wasFocused = prevFocusedRef.current;
    prevFocusedRef.current = focused;
    if (embedded && focused && !wasFocused && activeMode === "chat") {
      requestAnimationFrame(() => composer.textareaRef.current?.focus({ preventScroll: true }));
    }
  }, [activeMode, composer.textareaRef, embedded, focused]);

  const prevModeForFocusRef = useRef(activeMode);

  useEffect(() => {
    const prevMode = prevModeForFocusRef.current;
    prevModeForFocusRef.current = activeMode;
    if (prevMode === "term" && activeMode === "chat" && focused && visible && !activeSub) {
      requestAnimationFrame(() => composer.textareaRef.current?.focus({ preventScroll: true }));
    }
  }, [activeMode, activeSub, composer.textareaRef, focused, visible]);

  const pickSlashCommand = useCallback(
    (cmd: SlashCommandItem, allowAutoSend: boolean) => {
      setSlashDismissedFor(null);
      setChipDismissedPrefix(null);
      if (allowAutoSend && /^\/usage$/i.test(cmd.name)) {
        setText("");
        setAttachments([]);
        openUsageView();
        return;
      }
      if (allowAutoSend && /^\/(?:model|models)$/i.test(cmd.name)) {
        setText("");
        setAttachments([]);
        setModelMenuOmpTab(normalizeSwitchHarness(agent.harness) === "omp" ? "roles" : "session");
        setModelMenuMode("model");
        return;
      }
      if (allowAutoSend && !cmd.argHint && !/^\/btw$/i.test(cmd.name)) {
        setText("");
        setAttachments([]);
        stickRef.current = true;
        setAtBottom(true);
        if (isTurnBusy) {
          enqueuePrompt(agent, cmd.name, []);
        } else {
          setSending(true);
          void sendPromptNow(agent, cmd.name, []).finally(() => setSending(false));
        }
        return;
      }
      setText(`${cmd.name} `);
      requestAnimationFrame(() => composer.textareaRef.current?.focus());
    },
    [agent, composer.textareaRef, isTurnBusy, openUsageView],
  );

  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      if (activeMode !== "chat" || !focused) return;
      const root = panelRef.current;
      if (!root || root.offsetParent === null) return;
      const target = e.target as HTMLElement | null;
      if (target === composer.textareaRef.current) return;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable || target.closest(".term-box, .xterm, .tp-term"))) {
        return;
      }
      const files = extractClipboardFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void handleFiles(files);
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [activeMode, composer.textareaRef, focused, handleFiles]);

  const isSplitOnlyDrag = (e: DragEvent<HTMLDivElement>): boolean =>
    hasTabDrag(e) || hasPanelDrag(e) || hasPaneDrag(e) || (hasWorkspaceDrag(e) && e.altKey);

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat" || isSplitOnlyDrag(e)) return;
    if (!e.dataTransfer?.types?.includes("Files") && !hasWorkspaceDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat" || isSplitOnlyDrag(e)) return;
    if (!e.dataTransfer?.types?.includes("Files") && !hasWorkspaceDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat" || isSplitOnlyDrag(e)) return;
    if (!e.dataTransfer?.types?.includes("Files") && !hasWorkspaceDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat" || isSplitOnlyDrag(e)) return;
    dragDepthRef.current = 0;
    setDragOver(false);
    const snap = snapshotDroppedDataTransfer(e.dataTransfer);
    const wsItem = readWorkspaceDrag(e);
    if (wsItem) {
      e.preventDefault();
      e.stopPropagation();
      endWorkspaceDrag();
      const stagedItem = stageWorkspaceDragItem(wsItem, agent.deviceId);
      setAttachments((prev) => {
        if (prev.some((x) => x.sig === stagedItem.sig)) return prev;
        if (prev.length >= PUT_LIMITS.files) {
          toast(`一次最多附带 ${PUT_LIMITS.files} 个文件`, true);
          return prev;
        }
        return [...prev, stagedItem];
      });
      requestAnimationFrame(() => composer.textareaRef.current?.focus());
      return;
    }
    const hasDropPayload =
      snap.entries.length > 0 ||
      snap.files.length > 0 ||
      Boolean(e.dataTransfer?.types?.includes("Files"));
    if (!hasDropPayload) return;
    e.preventDefault();
    e.stopPropagation();

    void (async () => {
      if (native.available() && localHostIdStore.get() && localHostIdStore.get() === agent.deviceId) {
        const osItems = await readOsDraggedPaths();
        if (osItems.length > 0) {
          const res = stageOsDraggedItems(attachmentsRef.current, osItems, PUT_LIMITS.files);
          if (res.added.length > 0) {
            setAttachments((prev) => [...prev, ...res.added].slice(0, PUT_LIMITS.files));
          }
          if (res.notice) toast(res.notice, true);
          requestAnimationFrame(() => composer.textareaRef.current?.focus());
          return;
        }
      }

      const collected = await collectDroppedFilesSafe(snap, { maxFiles: PUT_LIMITS.files });
      if (collected.files.length > 0) {
        await handleFiles(collected.files);
      } else if (collected.skippedDirs.length > 0) {
        toast("当前连接不支持直接读取空文件夹或受限目录，请拖入具体文件", true);
      }
      requestAnimationFrame(() => composer.textareaRef.current?.focus());
    })();
  };

  const hasSending = sending || reconciled.unmatched.some((s) => s.state === "sending");
  const showEmptyState =
    !hasAnyRenderedRows &&
    !loadingOlder &&
    agent.status !== "working" &&
    !reconciled.awaitingReply &&
    !hasSending;
  const totalQueuedCount = queued.length + (terminalQueuedItems.length || (agent.queued ?? 0));
  const runElapsed = workingStartRef.current ? workedFor(nowTick - workingStartRef.current) : "刚开始";

  return (
    <div
      ref={panelRef}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, position: "relative" }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Top Bar (standalone narrow/mobile view only; v3 panes use PaneHead top-right switch) */}
      {!embedded ? (
        <div className="between wrap" style={{ padding: "10px 14px", borderBottom: "1px solid var(--divider)", flexShrink: 0, flexWrap: "wrap", rowGap: 8 }}>
          <div className="row" style={{ minWidth: 0, flex: "1 1 200px" }}>
            {mobile && onBack ? (
              <PocketIconButton size="sm" onClick={onBack} tooltip="返回">
                <ArrowLeft size={16} />
              </PocketIconButton>
            ) : null}
            <VendorAvatar harness={agent.harness} isShell={agent.isShell} size={36} />
            <div className="grow">
              <div style={{ fontWeight: 800, fontSize: fs(15) }} className="truncate">{spacedTitle(agent)}</div>
              <div className="faint truncate">{agent.cwd || agent.where || agent.harness}</div>
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            {activeSub ? (
              <SubagentHeaderLineage
                mainTitle={spacedTitle(agent)}
                trail={subTrail}
                rootSubs={subs}
                activeSubs={activeChildSubs}
                deviceId={agent.deviceId}
                agentKey={agent.key}
                onGoRoot={goRootSub}
                onSelectCrumbIndex={selectCrumbIndex}
                onSelectSub={selectSubInPlace}
                onOpenAside={openSubAsideView}
              />
            ) : knownSubCount > 0 ? (
              <SubagentCatalogTrigger
                deviceId={agent.deviceId}
                agentKey={agent.key}
                knownCount={knownSubCount}
                subs={subs}
                onSelectSub={selectSubInPlace}
                onOpenAside={openSubAsideView}
                onRefresh={refreshRootSubs}
              />
            ) : null}
            <div className="segmented has-hint" title={`切换对话 / 终端视图（${shortcutText("togglePaneMode")}）`}>
              <button className={activeMode === "chat" ? "active" : ""} onClick={() => selectMode("chat")}>对话</button>
              <button
                className={activeMode === "term" ? "active" : ""}
                title={
                  agent.subscreen
                    ? "终端正打开子面板（发消息将自动返回）"
                    : agent.status === "blocked"
                      ? "终端正等待确认或输入"
                      : undefined
                }
                onClick={() => selectMode("term")}
              >
                终端
                {Boolean(agent.subscreen) || agent.status === "blocked" ? (
                  <span className="term-attn-dot" aria-hidden />
                ) : null}
              </button>
              <SpatialHint shortcut="togglePaneMode" corner="tr" />
            </div>
            {onOpenWorkbench && agent.cwd && !agent.isShell ? (
              <PocketIconButton size="sm" tooltip="在工作台看它的文件" onClick={() => onOpenWorkbench(agent.key)}>
                <FolderOpen size={14} />
              </PocketIconButton>
            ) : null}
            <PocketIconButton
              size="sm"
              tooltip="跨端窗口、浏览器与文件回传"
              onClick={() => {
                setActivePortalId(null);
                setPortalModalOpen(true);
              }}
            >
              <ScreenShare size={14} />
            </PocketIconButton>
            <span className="has-hint" style={{ position: "relative", display: "inline-flex" }}>
              <PocketIconButton
                size="sm"
                tooltip={`中断当前轮（${shortcutText("interruptAgent")}）`}
                onClick={interruptTurn}
              >
                <Square size={14} />
              </PocketIconButton>
              <SpatialHint shortcut="interruptAgent" corner="tr" />
            </span>
            <PocketIconButton
              size="sm"
              tooltip="关闭终端"
              onClick={() => setKillConfirmOpen(true)}
            >
              <Trash2 size={14} />
            </PocketIconButton>
          </div>
        </div>
      ) : null}

      {chatVisited ? (
      <div className="chat-scroll-wrap" style={{ display: activeMode === "chat" ? undefined : "none" }}>
        <div
          ref={chatScrollRef}
          className="chat-scroll agent-chat"
          onScroll={onChatScroll}
          onWheel={(e) => {
            const el = chatScrollRef.current;
            if (e.deltaY < 0 && el && initialPositionedRef.current && olderCursor && !loadingOlder && !loadOlderError && el.scrollTop <= 180) {
              void loadOlderEvents();
            }
          }}
        >
          {!activeSub && !isPlainShellChat && loadingOlder ? (
            <div className="chat-top-status" role="status" aria-live="polite">
              <span className="act-spin" aria-hidden />
              <span>正在加载更早对话…</span>
            </div>
          ) : !activeSub && !isPlainShellChat && loadOlderError && olderCursor ? (
            <button type="button" className="chat-top-retry" onClick={() => void loadOlderEvents()}>
              加载更早记录失败 · 点击重试
            </button>
          ) : !activeSub && !isPlainShellChat && !olderCursor && hasLoadedOlder && foldedRows.length > 0 ? (
            <div className="chat-start-sep">
              <span>对话开头</span>
            </div>
          ) : null}

          {showEmptyState ? (
            <EmptyState mood="sleepy" title="还没有对话记录" body="在下方发一条消息，或点右上角切换到“终端”直接操作。" />
          ) : (
            <>
              {isPlainShellChat && shellChat ? (
                <>
                  {shellChat.preambleLines.length > 0 ? (
                    <pre className="chat-shell-out mono">{shellChat.preambleLines.join("\n")}</pre>
                  ) : null}
                  {shellChat.turns.map((turn) => (
                    <div key={turn.id} className="chat-shell-turn">
                      <div className="bubble-row user">
                        <div className="bubble user mono">
                          <span className="chat-shell-prompt">{turn.prompt}</span> {turn.command}
                        </div>
                      </div>
                      {turn.outputLines.length > 0 ? (
                        <pre className="chat-shell-out mono">{turn.outputLines.join("\n")}</pre>
                      ) : turn.completedEmpty ? (
                        <div className="chat-shell-empty">✓ 已执行（无输出）</div>
                      ) : null}
                    </div>
                  ))}
                  {reconciled.unmatched.map((item) => (
                    <div key={item.id} className="bubble-row user">
                      {item.text ? <div className="bubble user">{item.text}</div> : null}
                      <div className={`bubble-send-meta${item.state === "failed" ? " error" : ""}`}>
                        <span>
                          {clockStr(item.ts)} · {item.state === "sending" ? "发送中…" : item.state === "failed" ? `发送失败${item.error ? `：${clip(item.error, 40)}` : ""}` : "等待终端显示…"}
                        </span>
                        {item.state === "failed" ? (
                          <>
                            <button type="button" className="bubble-meta-btn primary" onClick={() => void retryFailedSend(item.id, agent.key)}>重发</button>
                            <button type="button" className="bubble-meta-btn" onClick={() => dismissOutgoingSend(agent.key, item.id)}>删掉</button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                timelineSegments.map((seg) =>
                  seg.kind === "rows" ? (
                    <ChatTimelineRows
                      key={seg.id}
                      rows={seg.rows}
                      subs={activeSub ? activeChildSubs : subs}
                      agentKey={agent.key}
                      deviceId={agent.deviceId}
                      cwd={agent.cwd}
                      onOpenSub={(s) => selectSubInPlace(s, subTrail)}
                      onOpenSubAside={(s) => openSubAsideView(s, subTrail)}
                      onOpenFile={(target) => {
                        openAgentFileTarget(agent, target);
                      }}
                      onSwitchToTerminal={() => selectMode("term")}
                      onDismissCommandPanel={() => void sendKeys(["esc"])}
                    />
                  ) : seg.kind === "captured" ? (
                    <CommandResultCard
                      key={seg.cap.id}
                      command={seg.cap.command}
                      text={seg.cap.output}
                      isError={seg.cap.isError}
                      panelState={seg.cap.panelState}
                      ts={seg.cap.ts}
                      onSwitchToTerminal={() => selectMode("term")}
                      onDismissPanel={() => void closeInteractiveCommandPanel(agent, seg.cap.id)}
                      onDismissCard={() => dismissCapturedCommand(agent.key, seg.cap.id)}
                    />
                  ) : (() => {
                    const imgAtts = seg.send.attachments.filter((a) => a.kind === "image" && a.previewUrl);
                    const fileAtts = seg.send.attachments.filter((a) => !(a.kind === "image" && a.previewUrl));
                    const outImgs = !imgAtts.length
                      ? extractImageTargets([...(seg.send.uploadedPaths ?? []), seg.send.text])
                      : [];
                    return (
                      <div key={seg.send.id} className="bubble-row user">
                        {seg.send.text ? <div className="bubble user">{seg.send.text}</div> : null}
                        {outImgs.length > 0 ? (
                          <InlineImageStrip
                            targets={outImgs}
                            agentKey={agent.key}
                            deviceId={agent.deviceId}
                            cwd={agent.cwd}
                            onOpenFile={(target) => openAgentFileTarget(agent, target)}
                          />
                        ) : imgAtts.length > 0 ? (
                          <div className="chat-img-strip-inline">
                            {imgAtts.map((att) => (
                              <img
                                key={att.id}
                                src={att.previewUrl}
                                alt={att.name}
                                className="chat-img-strip-thumb"
                              />
                            ))}
                          </div>
                        ) : null}
                        {fileAtts.length > 0 ? (
                          <div className="chat-att-list" title={fileAtts.map((a) => a.name).join("\n")}>
                            {fileAtts.map((att) => (
                              <span key={att.id} className="chat-attach-note row" style={{ gap: 5 }}>
                                <Paperclip size={11} />
                                <span className="truncate">{att.name}</span>
                              </span>
                            ))}
                          </div>
                        ) : seg.send.attachedCount > 0 && imgAtts.length === 0 && !(seg.send.uploadedPaths?.length) ? (
                          <div className="chat-attach-note row" style={{ gap: 5 }} title={seg.send.attachedNames.join("\n")}>
                            <Paperclip size={12} />
                            <span>已附带 {seg.send.attachedCount} 个文件/图片</span>
                          </div>
                        ) : null}
                        <div className={`bubble-send-meta${seg.send.state === "failed" ? " error" : ""}`}>
                          <span>
                            {clockStr(seg.send.ts)} ·{" "}
                            {seg.send.state === "sending"
                              ? "发送中…"
                              : seg.send.state === "failed"
                                ? `发送失败${seg.send.error ? `：${clip(seg.send.error, 40)}` : ""}`
                                : seg.send.state === "queued_terminal"
                                  ? "终端排队中 · 本轮结束后自动处理"
                                  : "等待会话同步…"}
                          </span>
                          {seg.send.state === "failed" ? (
                            <>
                              <button
                                type="button"
                                className="bubble-meta-btn primary"
                                onClick={() => void retryFailedSend(seg.send.id, agent.key)}
                              >
                                重发
                              </button>
                              <button
                                type="button"
                                className="bubble-meta-btn"
                                onClick={() => dismissOutgoingSend(agent.key, seg.send.id)}
                              >
                                删掉
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })(),
                )
              )}
            </>
          )}

          {isTurnBusy ? (() => {
            const lastFolded = foldedRows[foldedRows.length - 1];
            const hasInlineRunning = Boolean(
              lastFolded &&
                ((lastFolded.kind === "activity_group" && lastFolded.running) ||
                  (lastFolded.kind === "tool" && lastFolded.step.running)),
            );
            return (
              <div className="agent-run-card" role="status" aria-live="polite">
                <XiaoyangOrb mood="working" size={30} />
                <div className="agent-run-body">
                  <div className="agent-run-title">
                    <span>{hasInlineRunning ? "正在运行" : activeToolLabel ? `正在执行 · ${activeToolLabel}` : "正在思考与处理"}</span>
                    <span className="chat-typing-dots" aria-hidden>
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                  <div className="agent-run-sub">{runElapsed}</div>
                </div>
                <button type="button" className="agent-stop-pill" onClick={interruptTurn} title="中断当前轮">
                  <Square size={10} />
                  <span>停止</span>
                </button>
              </div>
            );
          })() : (hasSending || reconciled.awaitingReply) && reconciled.unmatched.length === 0 ? (
            <div className="agent-run-card" role="status" aria-live="polite">
              <XiaoyangOrb mood="working" size={26} />
              <div className="agent-run-body">
                <div className="agent-run-title">
                  <span>{hasSending ? "正在发送…" : "已送达，等待响应…"}</span>
                  <span className="chat-typing-dots" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            </div>
          ) : agent.status === "blocked" ? (
            <div className="agent-run-card blocked" role="status" aria-live="polite">
              <XiaoyangOrb mood="waiting" size={28} />
              <div className="agent-run-body">
                <div className="agent-run-title">等待你的确认或输入</div>
                {agent.statusNote ? <div className="agent-run-sub">{clip(agent.statusNote, 48)}</div> : null}
              </div>
              <button type="button" className="agent-stop-pill" onClick={() => selectMode("term")}>
                切到终端处理
              </button>
            </div>
          ) : null}

          {!activeSub && terminalQueuedItems.length > 0
            ? terminalQueuedItems.map((qText, idx) => {
                const qImgs = extractImageTargets([qText]);
                return (
                  <div key={`term-q-${idx}-${qText.slice(0, 24)}`} className="bubble-row user queued-terminal">
                    <div className="bubble user">
                      <RichMarkdown text={qText} onOpenFile={(target) => openAgentFileTarget(agent, target)} />
                    </div>
                    {qImgs.length > 0 ? (
                      <InlineImageStrip
                        targets={qImgs}
                        agentKey={agent.key}
                        deviceId={agent.deviceId}
                        cwd={agent.cwd}
                        onOpenFile={(target) => openAgentFileTarget(agent, target)}
                      />
                    ) : null}
                    <div className="bubble-send-meta">
                      <span>终端排队中 · 本轮结束后自动处理</span>
                      {agent.source === "hc" && idx === 0 ? (
                        <button
                          type="button"
                          className="bubble-meta-btn primary"
                          title="立即注入到当前轮 (Alt+M)"
                          onClick={() => void sendKeys(["alt+m"])}
                        >
                          立即注入
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            : null}
        </div>

        {!atBottom && hasAnyRenderedRows ? (
          <button type="button" className="chat-jump-bottom" onClick={() => scrollToBottom(true)}>
            <ArrowDown size={13} />
            <span>{unreadCount > 0 ? `${unreadCount} 条新消息` : "回到底部"}</span>
          </button>
        ) : null}
      </div>
      ) : null}

      {termVisited ? (
        <div style={{ flex: 1, minHeight: 0, display: activeMode === "term" ? "flex" : "none" }}>
          <PocketErrorBoundary resetKey={agent.key} title="终端视图加载出错">
            <TerminalSurface agent={agent} active={visible && activeMode === "term"} focused={focused && visible} />
          </PocketErrorBoundary>
        </div>
      ) : null}

      {/* Quick Numbered Choices (Chat mode only) */}
      {activeMode === "chat" && !activeSub && choices.length > 0 ? (
        <div className="row wrap" style={{ padding: "4px 14px", gap: 6, flexShrink: 0 }}>
          {choices.map((c) => (
            <button
              key={c.key}
              className={`term-key${c.selected ? " accent" : ""}`}
              onClick={() => void sendKeys([c.key, "enter"])}
            >
              {c.key}. {c.label}
            </button>
          ))}
        </div>
      ) : null}

      {activeMode === "chat" && !activeSub && usageOpen ? (
        <AgentUsageCard
          agent={agent}
          report={usageReport}
          loading={usageLoading}
          error={usageError}
          onRefresh={openUsageView}
          onClose={() => setUsageOpen(false)}
          onOpenModelSwitch={() => setModelMenuMode("model")}
          onRunInTerminal={() => {
            setUsageOpen(false);
            if (agent.status === "working") enqueuePrompt(agent, "/usage", []);
            else void sendPromptNow(agent, "/usage", []);
          }}
        />
      ) : null}

      {activeMode === "chat" && !activeSub && btwTurns.length > 0 ? (
        <BtwSideDrawer
          turns={btwTurns}
          agent={agent}
          onDismiss={(turnId) => dismissBtwTurn(agent.key, turnId)}
          onOpenFile={(target) => {
            void openAgentFileTarget(agent, target);
          }}
        />
      ) : null}

      {/* Composer or Subagent Read-Only Footer */}
      {activeMode === "chat" && activeSub ? (
        <SubagentReadOnlyBar
          current={activeSub}
          onOpenAside={() => {
            openSubAsideView(activeSub, subTrail.slice(0, -1));
            goRootSub();
          }}
          onBackMain={goRootSub}
        />
      ) : activeMode === "chat" ? (
        <div ref={composerCardRef} className={`composer-card${dragOver ? " drop-over" : ""}`} style={{ position: "relative" }}>
          {slashOpen ? (
            <SlashCommandPopup
              commands={matchedSlash}
              selectedIndex={slashIdx}
              category={slashCategory}
              onCategoryChange={setSlashCategory}
              onHoverIndex={setSlashIdx}
              onPick={(cmd) => pickSlashCommand(cmd, true)}
              harnessLabel={agent.harness}
            />
          ) : null}
          {pendingSwitch ? (
            <div className="composer-switch-banner" role="status" aria-live="polite">
              <Cpu size={13} />
              <span className="composer-switch-title">本轮结束后切换</span>
              <span className="composer-switch-target mono truncate" title={pendingSwitch.label}>
                {pendingSwitch.label}
              </span>
              <button
                type="button"
                className="composer-queue-ic"
                aria-label="取消待切换模型"
                title="取消待切换"
                onClick={() => cancelPendingModelSwitch(agent.key)}
              >
                <X size={12} />
              </button>
            </div>
          ) : null}
          {totalQueuedCount > 0 ? (
            <div className="composer-queue-shelf" aria-label="排队中的消息">
              <div className="composer-queue-head">
                <span className="composer-queue-title">排队中 · {totalQueuedCount} 条</span>
                <span className="composer-queue-hint">
                  {!hostOnline
                    ? "电脑离线，上线后自动发送"
                    : agent.status === "blocked"
                      ? "等待确认，点「立即发送」可直接送入"
                      : "当前轮结束后依次自动发送"}
                </span>
              </div>
              {queued.map((q, idx) => {
                const imgAtts = q.attachments.filter((a) => a.kind === "image" && a.previewUrl);
                return (
                  <div key={q.id} className="composer-queue-item">
                    <span className="composer-queue-idx">{idx + 1}</span>
                    {imgAtts.slice(0, 2).map((att) => (
                      <img key={att.id} src={att.previewUrl} alt={att.name} className="composer-queue-thumb" />
                    ))}
                    <span className="composer-queue-text" title={q.text}>
                      {q.text || "（仅附件）"}
                    </span>
                    {q.attachments.length > imgAtts.length ? (
                      <span className="composer-queue-att">+{q.attachments.length - imgAtts.length} 附件</span>
                    ) : null}
                    <div className="composer-queue-actions">
                      <button
                        type="button"
                        className="composer-queue-steer"
                        title="不打断当前轮，直接插队发送"
                        onClick={() => void steerQueuedPromptNow(agent, q.id)}
                      >
                        插队
                      </button>
                      {isTurnBusy ? (
                        <button
                          type="button"
                          className="composer-queue-steer subtle"
                          title="打断当前轮并立即发送"
                          onClick={() => void interruptAndSendQueuedPrompt(agent, q.id)}
                        >
                          打断
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="composer-queue-ic"
                        aria-label="编辑这条排队消息"
                        title="放回输入框编辑"
                        onClick={() => {
                          if (text.trim() || attachments.length > 0) {
                            enqueuePrompt(agent, text, attachments);
                          }
                          const popped = popQueuedPromptForEdit(agent.key, q.id);
                          if (!popped) return;
                          setText(popped.text);
                          setAttachments(popped.attachments);
                          requestAnimationFrame(() => composer.textareaRef.current?.focus());
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                      {idx > 0 ? (
                        <button
                          type="button"
                          className="composer-queue-ic"
                          aria-label="移到最前"
                          title="移到队列最前"
                          onClick={() => moveQueuedPromptToTop(agent.key, q.id)}
                        >
                          <ArrowUp size={12} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="composer-queue-ic"
                        aria-label="移出排队"
                        title="移除"
                        onClick={() => removeQueuedPrompt(agent.key, q.id)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {terminalQueuedItems.length > 0 ? (
                terminalQueuedItems.map((qText, idx) => {
                  const qImgs = extractImageTargets([qText]);
                  return (
                    <div key={`shelf-term-q-${idx}-${qText.slice(0, 24)}`} className="composer-queue-item">
                      <span className="composer-queue-idx">终端</span>
                      <span className="composer-queue-text" title={qText}>
                        {qText}
                      </span>
                      {qImgs.length > 0 ? (
                        <span className="composer-queue-att" title={qImgs.join("\n")}>
                          图片 ×{qImgs.length}
                        </span>
                      ) : null}
                      <div className="composer-queue-actions">
                        {agent.source === "hc" && idx === 0 ? (
                          <button
                            type="button"
                            className="composer-queue-steer"
                            title="立即注入到当前轮 (Alt+M)"
                            onClick={() => void sendKeys(["alt+m"])}
                          >
                            立即注入
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="composer-queue-ic"
                          aria-label="中断当前轮"
                          title="中断当前轮"
                          onClick={interruptTurn}
                        >
                          <Square size={11} />
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : agent.queued ? (
                <div className="composer-queue-item">
                  <span className="composer-queue-idx">终端</span>
                  <span className="composer-queue-text" title={agent.queuedText || ""}>
                    终端输入区排队 · {agent.queued} 条{agent.queuedText ? `：${agent.queuedText}` : ""}
                  </span>
                  <div className="composer-queue-actions">
                    {agent.source === "hc" ? (
                      <button
                        type="button"
                        className="composer-queue-steer"
                        title="立即注入到当前轮 (Alt+M)"
                        onClick={() => void sendKeys(["alt+m"])}
                      >
                        立即注入
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="composer-queue-ic"
                      aria-label="中断当前轮"
                      title="中断当前轮"
                      onClick={interruptTurn}
                    >
                      <Square size={11} />
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <DropRail
            items={attachments}
            onRemove={removeAttachment}
            onOpenFile={(item) => {
              if (!item.openPath) return;
              openFileTab(item.openAgentKey || agent.key, item.openPath, item.name, {
                absPath: item.hostRef && item.hostRef.startsWith("/") ? item.hostRef : undefined,
              });
            }}
          />
          <div className="composer-input-wrap">
            {leadingSlash ? (
              <ComposerSlashChip
                command={leadingSlash.command}
                onUnwrap={() => {
                  if (!leadingSlash.rest) {
                    setText(leadingSlash.rawToken);
                    setSlashDismissedFor(leadingSlash.rawToken);
                  } else {
                    setChipDismissedPrefix(leadingSlash.rawToken);
                  }
                  requestAnimationFrame(() => composer.textareaRef.current?.focus());
                }}
              />
            ) : null}
            <textarea
              {...composer.textareaProps}
              onKeyDown={(e) => {
                if (slashOpen && matchedSlash.length > 0 && !e.nativeEvent.isComposing) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIdx((i) => (i + 1) % matchedSlash.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIdx((i) => (i - 1 + matchedSlash.length) % matchedSlash.length);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashDismissedFor(text);
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const picked = matchedSlash[Math.min(slashIdx, matchedSlash.length - 1)];
                    if (picked) pickSlashCommand(picked, false);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    const picked = matchedSlash[Math.min(slashIdx, matchedSlash.length - 1)];
                    if (picked) pickSlashCommand(picked, true);
                    return;
                  }
                } else if (slashOpen && e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissedFor(text);
                  return;
                } else if (usageOpen && e.key === "Escape" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  setUsageOpen(false);
                  return;
                }
                if (
                  leadingSlash &&
                  e.key === "Backspace" &&
                  !e.nativeEvent.isComposing &&
                  e.currentTarget.selectionStart === 0 &&
                  e.currentTarget.selectionEnd === 0
                ) {
                  e.preventDefault();
                  if (!leadingSlash.rest) {
                    setText(leadingSlash.rawToken);
                    setSlashDismissedFor(leadingSlash.rawToken);
                  } else {
                    setChipDismissedPrefix(leadingSlash.rawToken);
                  }
                  return;
                }
                composer.textareaProps.onKeyDown(e);
              }}
              placeholder={
                leadingSlash
                  ? /^\/btw$/i.test(leadingSlash.command.name)
                    ? "输入旁路问题（只读上下文，不打断当前运行）…"
                    : COMPOSER_SLASH_CHIP_PLACEHOLDER
                  : isTurnBusy
                    ? "发送消息（运行中将自动排队 · /btw 旁路提问）"
                    : agent.status === "blocked"
                      ? "直接输入回复或指令（Enter 立即送入终端）"
                      : agent.isShell
                        ? "输入终端命令按 Enter 执行…"
                        : `发给 ${clip(agent.name || agent.title || agent.harness, 16)}（/ 命令 · 可拖入或粘贴文件）`
              }
              value={composerInputValue}
              onChange={(e) => {
                setSlashDismissedFor(null);
                if (leadingSlash) {
                  setText(`${leadingSlash.rawToken} ${e.target.value}`);
                } else {
                  if (e.target.value.startsWith("/") && modelMenuMode) setModelMenuMode(null);
                  setText(e.target.value);
                }
              }}
              onPaste={(e) => {
                const files = extractClipboardFiles(e.clipboardData);
                if (files.length) {
                  e.preventDefault();
                  void handleFiles(files);
                }
              }}
            />
          </div>
          <div className="composer-foot">
            <div className="composer-tools">
              <button
                type="button"
                className="composer-tool-btn"
                aria-label="添加文件或图片"
                title="添加文件或图片"
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={16} />
              </button>
              {!agent.isShell && (agent.source === "hc" || agent.source === "herdr") ? (
                <>
                  <button
                    ref={modelBtnRef}
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={modelMenuMode === "model"}
                    className={`composer-model-btn has-hint${modelMenuMode === "model" ? " open" : ""}`}
                    title={(modelMeta.currentModel || agent.model) ? `当前模型：${modelMeta.currentModel || agent.model}（点击切换 · ${shortcutText("openModelPicker")}）` : `切换模型 (/model · ${shortcutText("openModelPicker")})`}
                    onClick={() => {
                      setSlashDismissedFor(text);
                      setModelMenuOmpTab("session");
                      setModelMenuMode((v) => (v === "model" ? null : "model"));
                    }}
                  >
                    <Cpu size={13} />
                    <span className="truncate mono">{(modelMeta.currentModel || agent.model) ? (modelMeta.currentModel || agent.model)!.split("/").pop() : "切换模型"}</span>
                    <ChevronDown size={11} />
                    <SpatialHint shortcut="openModelPicker" corner="top" />
                  </button>
                  {effectiveThinkingLevels.length > 0 ? (() => {
                    const displayThinking = modelMeta.currentThinking || agent.thinkingLevel;
                    return (
                      <button
                        ref={effortBtnRef}
                        type="button"
                        aria-haspopup="listbox"
                        aria-expanded={modelMenuMode === "thinking"}
                        className={`composer-model-btn has-hint${modelMenuMode === "thinking" ? " open" : ""}`}
                        title={displayThinking ? `思考等级：${formatEffortLabel(displayThinking)}（点击切换 · ${shortcutText("openThinkingPicker")}）` : `切换思考等级（${shortcutText("openThinkingPicker")}）`}
                        onClick={() => {
                          setSlashDismissedFor(text);
                          setModelMenuMode((v) => (v === "thinking" ? null : "thinking"));
                        }}
                      >
                        <Brain size={13} />
                        <span className="truncate">
                          {displayThinking ? `思考 · ${formatEffortLabel(displayThinking)}` : "思考等级"}
                        </span>
                        <ChevronDown size={11} />
                        <SpatialHint shortcut="openThinkingPicker" corner="top" />
                      </button>
                    );
                  })() : null}
                </>
              ) : null}
            </div>
            <div className="composer-actions">
              <PocketButton
                size="sm"
                className="composer-send"
                aria-label={isBtwDraft ? "发送旁路提问" : isTurnBusy ? "发送（运行中将自动排队）" : "发送"}
                title={isBtwDraft ? "旁路提问，不打断当前轮 (Enter)" : isTurnBusy ? "发送或加入排队 (Enter)" : "发送 (Enter)"}
                disabled={isBtwDraft ? !/^\/btw\s+\S/i.test(text.trim()) : !text.trim() && attachments.length === 0}
                onClick={() => submitComposer()}
              >
                <Send size={14} />
              </PocketButton>
            </div>
          </div>
        </div>
      ) : null}

      <ModelSwitchDropdown
        open={modelMenuMode !== null}
        mode={modelMenuMode ?? "model"}
        onOpenChange={(v) => {
          if (!v) setModelMenuMode(null);
        }}
        agent={agent}
        anchorRef={modelMenuMode === "thinking" ? effortBtnRef : modelBtnRef}
        fallbackAnchorRef={composerCardRef}
        currentModelHint={modelMeta.currentModel || agent.model}
        currentThinkingHint={modelMeta.currentThinking || agent.thinkingLevel}
        hasReasoningEvents={hasReasoningEvents}
        initialOmpTab={modelMenuOmpTab}
        onSelectModel={applyModelSwitch}
        onSelectThinking={applyThinkingSwitch}
        onSelectRoleModel={(slot, id) => void applyRoleModelSwitch(slot, id)}
        onLoaded={onModelsLoaded}
      />

      <PocketModal
        open={killConfirmOpen}
        onOpenChange={setKillConfirmOpen}
        title="关闭终端"
        subtitle="关闭后将终止该终端内正在运行的进程，未保存的进度会丢失。"
        width={400}
      >
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <PocketButton variant="ghost" onClick={() => setKillConfirmOpen(false)}>取消</PocketButton>
          <PocketButton
            variant="danger"
            onClick={() => {
              setKillConfirmOpen(false);
              void rpcCall(agent.deviceId, "terminal.kill", { agent: agent.key })
                .then(() => onBack?.())
                .catch((e) => toast((e as Error).message, true));
            }}
          >
            关闭并结束
          </PocketButton>
        </div>
      </PocketModal>

      <SessionPortalPiP
        agent={agent}
        visible={visible}
        onExpandPortal={(pid) => {
          setActivePortalId(pid);
          setPortalModalOpen(true);
        }}
      />

      <PortalViewerModal
        open={portalModalOpen}
        onOpenChange={setPortalModalOpen}
        hostId={agent.deviceId}
        agent={agent}
        activePortalId={activePortalId}
        onSelectPortalId={setActivePortalId}
      />
    </div>
  );
}

export interface CreatedAgentInfo {
  agentKey: string;
  terminalId?: string;
  hostId: string;
  spaceId?: string;
  tabId?: string;
  spaceName?: string;
  folder?: string;
  launcher: string;
}

export function CreateAgentModal({
  open,
  onOpenChange,
  hosts,
  defaultHost,
  defaultSpace,
  preferNewSpace = false,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hosts: Device[];
  defaultHost: string | null;
  defaultSpace: string | null;
  preferNewSpace?: boolean;
  onCreated: (info: CreatedAgentInfo) => void;
}) {
  const toast = useToast();
  const localHostId = useLocalHostDeviceId();
  const onlineHosts = hosts.filter((h) => h.online);
  const [hostId, setHostId] = useState(defaultHost || onlineHosts[0]?.id || "");
  const isLocalHost = native.available() && Boolean(localHostId) && hostId === localHostId;
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [launchers, setLaunchers] = useState<LaunchOption[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [spaceName, setSpaceName] = useState(defaultSpace || "");
  const [spaceNameTouched, setSpaceNameTouched] = useState(Boolean(defaultSpace));
  const [launcher, setLauncher] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [spaceState, setSpaceState] = useState<{ loading: boolean; error: string | null; canCreate: boolean; reason?: string }>({
    loading: false,
    error: null,
    canCreate: true,
  });

  useEffect(() => {
    if (!open) return;
    const h = defaultHost || onlineHosts[0]?.id || hosts[0]?.id || "";
    setHostId(h);
    setSpaceName(defaultSpace || "");
    setSpaceNameTouched(Boolean(defaultSpace));
    setTask("");
    setFolderTouched(false);
    setBrowseOpen(false);
  }, [open, defaultHost, defaultSpace]);

  useEffect(() => {
    if (!open || !hostId) return;
    let cancelled = false;
    setSpaces([]);
    setLaunchers([]);
    setFolders([]);
    setLauncher("");
    setSpaceId("");
    setFolder("");
    setFolderTouched(false);
    setBrowseOpen(false);
    setSpaceState({ loading: true, error: null, canCreate: true });
    void rpcCall(hostId, "spaces.list", {})
      .then((res) => {
        if (cancelled) return;
        const sortedLaunchers = [...res.launchers].sort((a, b) => Number(b.id === "shell") - Number(a.id === "shell"));
        setSpaces(res.spaces);
        setLaunchers(sortedLaunchers);
        setFolders(res.folders);
        setLauncher(sortedLaunchers.find((l) => l.id === "shell")?.id ?? sortedLaunchers[0]?.id ?? "");
        const matched = defaultSpace ? res.spaces.find((s) => s.name === defaultSpace) : undefined;
        if (preferNewSpace && !defaultSpace) {
          setSpaceId("");
          setFolder("");
        } else {
          const initialSpace = matched ?? res.spaces[0];
          setSpaceId(initialSpace?.id ?? "");
          setFolder(initialSpace?.folder || res.folders[0] || "");
        }
        setSpaceState({ loading: false, error: null, canCreate: res.canCreate !== false, reason: res.reason });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setSpaceState({ loading: false, error: e.message || "无法联系这台电脑", canCreate: false });
      });
    return () => {
      cancelled = true;
    };
  }, [open, hostId, defaultSpace, preferNewSpace]);

  const applyChosenFolder = (nextFolder: string, markTouched = true) => {
    setFolder(nextFolder);
    if (markTouched) setFolderTouched(true);
    const norm = normalizeFolderKey(nextFolder);
    if (!norm) return;
    const matched = spaces.find((s) => s.folder && normalizeFolderKey(s.folder) === norm);
    if (matched) {
      setSpaceId(matched.id);
    } else {
      setSpaceId("");
      if (!spaceNameTouched) {
        const baseName = nextFolder.trim().replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
        if (baseName) setSpaceName(baseName);
      }
    }
  };

  const pickSystemFolder = async () => {
    try {
      const picked = await native.pickFolder(folder.trim() || undefined);
      if (picked) applyChosenFolder(picked);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const matchedSpaceObj = spaceId ? spaces.find((s) => s.id === spaceId) : undefined;

  const submit = async () => {
    if (!hostId || !launcher) return;
    setBusy(true);
    try {
      const cleanFolder = folder.trim();
      const folderBase = cleanFolder.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
      const resolvedSpaceName = matchedSpaceObj?.name || spaceName.trim() || folderBase || "workspace";
      const res = await rpcCall(hostId, "agent.create", {
        space: spaceId || undefined,
        spaceName: spaceId ? undefined : spaceName.trim() || undefined,
        folder: cleanFolder || undefined,
        launcher,
        task: launcher !== "shell" && task.trim() ? task.trim() : undefined,
      }, 30_000);
      onOpenChange(false);
      setTask("");
      onCreated({
        agentKey: res.agent,
        terminalId: res.terminal,
        hostId,
        spaceId: res.space || spaceId || undefined,
        tabId: res.tab || undefined,
        spaceName: resolvedSpaceName,
        folder: cleanFolder || matchedSpaceObj?.folder || undefined,
        launcher,
      });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const isCreatingSpace = preferNewSpace || !spaceId;
  const isShellLauncher = launcher === "shell";

  return (
    <>
      <PocketModal
        open={open}
        onOpenChange={onOpenChange}
        title={isCreatingSpace ? "新建空间" : "新建终端 / Agent"}
        subtitle={
          isCreatingSpace
            ? "选择工作目录并创建新空间，默认直接进入终端（也可切换启动指定 Agent）"
            : "选择工作目录后自动匹配已有空间（或新建命名空间）"
        }
        width={540}
      >
        <div className="stack">
          {hosts.length > 0 ? (
            <div>
              <div className="faint" style={{ marginBottom: 4 }}>电脑</div>
              <PocketSelect
                value={hostId}
                onValueChange={setHostId}
                options={hosts.map((h) => ({ value: h.id, label: h.online ? h.name : `${h.name} (离线)` }))}
              />
            </div>
          ) : null}

          {spaceState.error ? (
            <div className="faint" style={{ color: "var(--blush-text)", fontSize: 12.5 }}>{spaceState.error}</div>
          ) : !spaceState.canCreate && spaceState.reason ? (
            <div className="faint" style={{ color: "var(--blush-text)", fontSize: 12.5 }}>{spaceState.reason}</div>
          ) : null}

          {launchers.length > 0 ? (
            <div>
              <div className="faint" style={{ marginBottom: 4 }}>程序 / Harness</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {launchers.map((l) => (
                  <PocketButton key={l.id} size="sm" variant={launcher === l.id ? "primary" : "ghost"} onClick={() => setLauncher(l.id)}>
                    {l.label}
                  </PocketButton>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <div className="between" style={{ marginBottom: 4, gap: 8 }}>
              <span className="faint" style={{ flexShrink: 0 }}>工作目录</span>
              {folder.trim() ? (
                <span className="faint truncate" style={{ minWidth: 0, fontSize: 12, color: matchedSpaceObj ? "var(--mint-text)" : "var(--accent-text)" }}>
                  {matchedSpaceObj ? `复用空间「${matchedSpaceObj.name}」· 新建 Tab` : `将新建空间「${spaceName.trim() || folder.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "新空间"}」`}
                </span>
              ) : null}
            </div>
            <div className="row wrap" style={{ gap: 6, alignItems: "center" }}>
              <PocketInput
                mono
                style={{ flex: "1 1 200px", minWidth: 0 }}
                placeholder="~/work/project"
                value={folder}
                onChange={(e) => applyChosenFolder(e.target.value)}
              />
              {isLocalHost ? (
                <PocketButton size="sm" variant="ghost" onClick={() => void pickSystemFolder()}>
                  <FolderOpen size={14} /> 访达
                </PocketButton>
              ) : null}
              <PocketButton size="sm" variant="soft" onClick={() => setBrowseOpen(true)}>
                <FolderTree size={14} /> 浏览目录…
              </PocketButton>
            </div>

            {folders.length > 0 ? (
              <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
                {folders.slice(0, 8).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="term-key"
                    style={
                      normalizeFolderKey(folder) === normalizeFolderKey(f)
                        ? { borderColor: "var(--line-pink)", color: "var(--accent-text)", background: "var(--accent-soft)", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }
                        : { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }
                    }
                    onClick={() => applyChosenFolder(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {spaces.length > 0 ? (
            <div>
              <div className="faint" style={{ marginBottom: 4 }}>所属空间（同目录自动复用，也可手动指定或新建）</div>
              <PocketSelect
                value={spaceId}
                onValueChange={(nextId) => {
                  setSpaceId(nextId);
                  if (!folderTouched) {
                    const sp = spaces.find((s) => s.id === nextId);
                    if (sp?.folder) setFolder(sp.folder);
                  }
                }}
                options={[{ value: "", label: "新建命名空间" }, ...spaces.map((s) => ({ value: s.id, label: s.folder ? `${s.name} (${s.folder})` : s.name }))]}
              />
            </div>
          ) : null}

          {!spaceId ? (
            <div>
              <div className="faint" style={{ marginBottom: 4 }}>新空间名称</div>
              <PocketInput
                placeholder="例如：backend"
                value={spaceName}
                onChange={(e) => {
                  setSpaceName(e.target.value);
                  setSpaceNameTouched(true);
                }}
              />
            </div>
          ) : null}

          {!isShellLauncher ? (
            <div>
              <div className="faint" style={{ marginBottom: 4 }}>第一条任务（可选）</div>
              <PocketInput placeholder="要交给它做什么…" value={task} onChange={(e) => setTask(e.target.value)} />
            </div>
          ) : null}

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <PocketButton variant="ghost" onClick={() => onOpenChange(false)}>取消</PocketButton>
            <PocketButton variant="primary" disabled={busy || spaceState.loading || !spaceState.canCreate || !hostId || !launcher} onClick={() => void submit()}>
              {busy
                ? "正在打开…"
                : !spaceId && isShellLauncher
                  ? "创建空间并打开终端"
                  : isShellLauncher
                    ? "打开终端"
                    : "启动 Agent"}
            </PocketButton>
          </div>
        </div>
      </PocketModal>

      <FolderExplorerModal
        open={open && browseOpen}
        onOpenChange={setBrowseOpen}
        hostId={hostId}
        isLocalHost={isLocalHost}
        spaces={spaces}
        recentFolders={folders}
        initialPath={folder.trim() || undefined}
        onSelect={(picked) => applyChosenFolder(picked)}
      />
    </>
  );
}
