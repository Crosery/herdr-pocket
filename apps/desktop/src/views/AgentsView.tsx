import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock,
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
  stripModelEffortSuffix,
  textWithFiles,
  type Agent,
  type AgentModelsResult,
  type AgentStatus,
  type AgentUsageReport,
  type ConvEvent,
  type Device,
  type LaunchOption,
  type SlashCommandItem,
  type SpaceInfo,
  type SubSession,
} from "@herdr-pocket/protocol";
import {
  EmptyState,
  PocketBadge,
  PocketButton,
  PocketCard,
  PocketIconButton,
  PocketInput,
  PocketModal,
  PocketSelect,
  fs,
  useToast,
} from "../components/PocketUI";
import { AgentUsageCard } from "../components/AgentUsageCard";
import { ChatTimelineRows } from "../components/ChatTimeline";
import { DropRail } from "../components/DropRail";
import { FolderExplorerModal, normalizeFolderKey } from "../components/FolderExplorerModal";
import { VendorAvatar, XiaoyangOrb, statusTone } from "../components/MascotAndVendor";
import { ModelSwitchDropdown, formatEffortLabel } from "../components/ModelSwitchDropdown";
import { SlashCommandPopup } from "../components/SlashCommandPopup";
import { SubagentCatalogTrigger, SubagentHeaderLineage, SubagentReadOnlyBar } from "../components/SubagentNav";
import { TerminalSurface } from "../components/TerminalSurface";
import { VoiceMicButton } from "../components/VoiceInput";
import { copyToClipboard } from "../lib/bridge";
import { foldConvEvents, mergeConvEvents } from "../lib/chatFold";
import {
  builtinSlashCommands,
  extractSlashQuery,
  matchSlashCommands,
  mergeSlashCommands,
  type SlashCategory,
} from "../lib/slashCommands";
import { parseTerminalChatTranscript, shellTurnMatchesCommand } from "../lib/terminalChat";
import {
  dismissOutgoingSend,
  enqueuePrompt,
  moveQueuedPromptToTop,
  popQueuedPromptForEdit,
  pruneOutgoingSends,
  reconcileOutgoingSends,
  removeQueuedPrompt,
  retryFailedSend,
  sendPromptNow,
  steerQueuedPromptNow,
  useAgentChatQueue,
} from "../lib/chatQueue";
import { useComposerInput } from "../lib/composerKeys";
import { prepareDroppedFiles, revokeAttachment, stageWorkspaceDragItem, type StagedAttachment } from "../lib/dropPreview";
import {
  clearComposerDraft,
  getComposerDraft,
  setComposerDraftAttachments,
  setComposerDraftText,
} from "../lib/composerDrafts";
import { endWorkspaceDrag, hasWorkspaceDrag, readWorkspaceDrag } from "../lib/fileDrag";
import { useLocalHostDeviceId } from "../lib/fonts";
import { openFileTab, openSubagentAside } from "../shell/shellStore";
import { native } from "../lib/native";
import { parseChoices } from "../lib/markdown";
import { openAgentFileTarget } from "../lib/openFileTarget";
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

/** A stable colour slot (0-4) for a space badge. */
function toneIndex(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 5;
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
          key={`${selectedAgent.key}:${initialTab}`}
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
                        <span className={`space-badge tone-${toneIndex(label)}`} aria-hidden>
                          {[...label][0]?.toUpperCase()}
                        </span>
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
              <AgentDetailPanel key={`${selectedAgent.key}:${initialTab}`} agent={selectedAgent} initialTab={initialTab} onOpenWorkbench={onOpenWorkbench} />
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
        onCreated={(key) => {
          setDetailTab(null);
          onSelectAgent(key);
          toast("已创建并打开 Agent");
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
}) {
  const toast = useToast();
  const hostOnline = liveStore.use((s) => s.devices[agent.deviceId]?.online ?? true);
  const chatDisplayMode = settingsStore.use((s) => s.chatDisplayMode);
  const [tab, setTab] = useState<"chat" | "term">(mode ?? initialTab);
  const activeMode: "chat" | "term" = mode ?? tab;
  const selectMode = (m: "chat" | "term") => {
    setTab(m);
    onModeChange?.(m);
  };
  const [termVisited, setTermVisited] = useState(activeMode === "term");
  useEffect(() => {
    if (activeMode === "term") setTermVisited(true);
  }, [activeMode]);

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
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageReport, setUsageReport] = useState<AgentUsageReport | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [modelMenuMode, setModelMenuMode] = useState<"model" | "thinking" | null>(null);
  const [modelMeta, setModelMeta] = useState<{
    currentModel?: string;
    currentThinking?: string;
    thinkingLevels?: string[];
  }>({});

  useEffect(() => {
    const draft = getComposerDraft(agent.key);
    setTextState(draft.text);
    setAttachmentsState(draft.attachments);
    setUsageOpen(false);
    setUsageReport(null);
    setUsageError(null);
    setModelMenuMode(null);
    setModelMeta({ currentModel: agent.model });

    if (agent.isShell || (agent.source !== "hc" && agent.source !== "herdr")) return;
    let alive = true;
    void rpcCall(agent.deviceId, "agent.models", { agent: agent.key })
      .then((res) => {
        if (!alive) return;
        setModelMeta({
          currentModel: res.currentModel || agent.model,
          currentThinking: res.currentThinking,
          thinkingLevels: res.thinkingLevels,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent.key, agent.deviceId, agent.isShell, agent.source, agent.model]);
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
  const sessionTrackRef = useRef<{ agentKey: string; sessionKey?: string }>({ agentKey: agent.key, sessionKey: agent.sessionKey });
  const dragDepthRef = useRef(0);
  const attachmentsRef = useRef<StagedAttachment[]>([]);
  attachmentsRef.current = attachments;

  const { queued, outgoing } = useAgentChatQueue(agent.key);
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
    if (agent.status !== "working" && outgoing.length === 0 && !sending) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [agent.status, outgoing.length, sending]);

  useEffect(() => {
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
    }
    streamLiveRef.current = false;
    hadOpenRef.current = false;

    void rpcCall(agent.deviceId, "session.events", { agent: agent.key, limit: 200 })
      .then((res) => {
        if (!alive) return;
        setEvents((prevList) => mergeConvEvents(prevList, res.events));
        setOlderCursor(res.more ? (res.nextBefore ?? null) : null);
      })
      .catch(() => {});

    if (agent.subagents || subs.length > 0) {
      void rpcCall(agent.deviceId, "session.children", { agent: agent.key })
        .then((res) => {
          if (alive) setSubs(res.sessions);
        })
        .catch(() => {});
    }

    const unsubSession = subscribeStream(
      agent.deviceId,
      "session",
      { agent: agent.key },
      (ev) => {
        if (!alive || !ev) return;
        if ((ev.kind === "session" || ev.kind === "session_event") && ev.event) {
          const nextEv = ev.event as ConvEvent;
          setEvents((prevList) => mergeConvEvents(prevList, [nextEv]));
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
      if (!alive) return;
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

    void rpcCall(agent.deviceId, "agent.seen", { agent: agent.key }).catch(() => {});

    return () => {
      alive = false;
      window.clearInterval(pollTimer);
      unsubSession();
    };
  }, [agent.deviceId, agent.key, agent.sessionKey, agent.subagents]);

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

    void rpcCall(agent.deviceId, "session.events", { agent: agent.key, sub: activeSubKey, limit: 200 })
      .then((res) => {
        if (alive) setSubEvents((prev) => mergeConvEvents(prev, res.events));
      })
      .catch(() => {});

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
          setSubEvents((prev) => mergeConvEvents(prev, [ev.event as ConvEvent]));
        }
      },
      (st) => {
        if (alive) subLive = st?.kind === "live";
      },
    );

    const pollTimer = window.setInterval(() => {
      if (!alive) return;
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
        }
      },
      (st) => {
        if (alive) live = st?.kind === "live";
      },
    );

    const pollTimer = window.setInterval(() => {
      if (!alive || live) return;
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

  useEffect(() => {
    if (agent.isShell) {
      setDiscoveredSlash([]);
      return;
    }
    let alive = true;
    void rpcCall(agent.deviceId, "agent.commands", { agent: agent.key })
      .then((res) => {
        if (alive) setDiscoveredSlash(res.commands);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agent.cwd, agent.deviceId, agent.harness, agent.isShell, agent.key]);

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
  const foldedRows = useMemo(
    () => (isPlainShellChat ? [] : foldConvEvents(displayedEvents, chatDisplayMode)),
    [chatDisplayMode, displayedEvents, isPlainShellChat],
  );
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

  const allSlashCommands = useMemo(
    () => mergeSlashCommands(builtinSlashCommands(agent.harness, agent.isShell), discoveredSlash),
    [agent.harness, agent.isShell, discoveredSlash],
  );
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

  const hasAnyRenderedRows =
    foldedRows.length > 0 ||
    reconciled.unmatched.length > 0 ||
    Boolean(shellChat && (shellChat.turns.length > 0 || shellChat.preambleLines.length > 0));

  const scrollToBottom = useCallback((smooth = false) => {
    stickRef.current = true;
    setAtBottom(true);
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

  useLayoutEffect(() => {
    const justEnteredChat = prevModeRef.current !== "chat" && activeMode === "chat";
    prevModeRef.current = activeMode;
    if (activeMode !== "chat") return;
    const el = chatScrollRef.current;
    if (!el) return;
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
      return;
    }
    if (stickRef.current) {
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
  ]);

  const onChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const prevTop = prevScrollTopRef.current;
    prevScrollTopRef.current = top;
    const nearBottom = el.scrollHeight - top - el.clientHeight < 72;
    stickRef.current = nearBottom;
    setAtBottom(nearBottom);
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

      setModelMeta((prev) => ({
        ...prev,
        ...(modelId ? { currentModel: stripModelEffortSuffix(modelId) } : {}),
        ...(thinkingLevel ? { currentThinking: thinkingLevel } : {}),
      }));
      stickRef.current = true;
      setAtBottom(true);

      const plan = buildHarnessSwitchCommands(agent.harness, { modelId, thinkingLevel });
      if (agent.status === "working") {
        if (plan.commands.length > 0) {
          for (const cmd of plan.commands) enqueuePrompt(agent, cmd, []);
          toast(`已加入排队：当前轮结束后切换为 ${labelDesc}`);
        } else {
          toast(`当前轮进行中，请空闲后再切换 ${labelDesc}`, true);
        }
        return;
      }

      setSending(true);
      try {
        const res = await rpcCall(agent.deviceId, "agent.setModel", {
          agent: agent.key,
          ...(modelId ? { modelId } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
        setModelMeta((prev) => ({
          ...prev,
          ...(res.currentModel ? { currentModel: res.currentModel } : {}),
          ...(res.currentThinking ? { currentThinking: res.currentThinking } : {}),
        }));
        toast(res.note || `已切换：${labelDesc}`);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        const unsupported =
          err?.code === "unsupported" ||
          err?.code === "bad_request" ||
          /unknown|unsupported|不支持/i.test(err?.message ?? "");
        if (unsupported && plan.commands.length > 0) {
          for (const cmd of plan.commands) await sendPromptNow(agent, cmd, []);
          toast(`已发送切换指令：${labelDesc}`);
        } else {
          toast(err?.message || "切换失败", true);
        }
      } finally {
        setSending(false);
      }
    },
    [agent, toast],
  );

  const applyModelSwitch = useCallback(
    (modelId: string) => {
      void runModelOrThinkingSwitch({ modelId });
    },
    [runModelOrThinkingSwitch],
  );

  const applyThinkingSwitch = useCallback(
    (thinkingLevel: string) => {
      void runModelOrThinkingSwitch({ thinkingLevel });
    },
    [runModelOrThinkingSwitch],
  );

  const onModelsLoaded = useCallback((res: AgentModelsResult) => {
    setModelMeta({
      currentModel: res.currentModel || agent.model,
      currentThinking: res.currentThinking,
      thinkingLevels: res.thinkingLevels,
    });
  }, [agent.model]);

  const lastSendRef = useRef<{ sig: string; at: number } | null>(null);

  const submitComposer = (overrideText?: string) => {
    const isOverride = overrideText !== undefined;
    const raw = (overrideText ?? text).trim();
    const staged = isOverride ? [] : attachments;
    const now = Date.now();
    const sig = `${agent.key}\0${raw}\0${staged.length}`;
    if (!raw && staged.length === 0) return;
    if (lastSendRef.current && lastSendRef.current.sig === sig && now - lastSendRef.current.at < 400) return;
    lastSendRef.current = { sig, at: now };

    if (!staged.length && /^\/usage$/i.test(raw)) {
      if (!isOverride) setText("");
      openUsageView();
      return;
    }
    if (!staged.length && /^\/(?:model|models)$/i.test(raw)) {
      if (!isOverride) setText("");
      setModelMenuMode("model");
      return;
    }
    if (!staged.length && /^\/(?:effort|thinking)$/i.test(raw) && (modelMeta.thinkingLevels?.length ?? 0) > 0) {
      if (!isOverride) setText("");
      setModelMenuMode("thinking");
      return;
    }

    if (!isOverride) {
      clearComposerDraft(agent.key, { revoke: false });
      setTextState("");
      setAttachmentsState([]);
    }
    stickRef.current = true;
    setAtBottom(true);

    if (agent.status === "working") {
      enqueuePrompt(agent, raw, staged);
      requestAnimationFrame(() => composer.textareaRef.current?.focus());
      return;
    }

    setSending(true);
    void sendPromptNow(agent, raw, staged).finally(() => setSending(false));
  };

  const interruptTurn = () => {
    void rpcCall(agent.deviceId, "terminal.interrupt", { agent: agent.key }).catch((e) =>
      toast((e as Error).message, true),
    );
  };

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

  const composer = useComposerInput(text, () => submitComposer());

  const pickSlashCommand = useCallback(
    (cmd: SlashCommandItem, allowAutoSend: boolean) => {
      setSlashDismissedFor(null);
      if (allowAutoSend && /^\/usage$/i.test(cmd.name)) {
        setText("");
        setAttachments([]);
        openUsageView();
        return;
      }
      if (allowAutoSend && /^\/(?:model|models)$/i.test(cmd.name)) {
        setText("");
        setAttachments([]);
        setModelMenuMode("model");
        return;
      }
      if (allowAutoSend && !cmd.argHint) {
        setText("");
        setAttachments([]);
        stickRef.current = true;
        setAtBottom(true);
        if (agent.status === "working") {
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
    [agent, composer.textareaRef, openUsageView],
  );

  useEffect(() => {
    const onWindowPaste = (e: ClipboardEvent) => {
      if (activeMode !== "chat") return;
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
  }, [activeMode, composer.textareaRef, handleFiles]);

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat") return;
    if (!e.dataTransfer?.types?.includes("Files") && !hasWorkspaceDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat") return;
    if (!e.dataTransfer?.types?.includes("Files") && !hasWorkspaceDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat") return;
    if (!e.dataTransfer?.types?.includes("Files") && !hasWorkspaceDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (activeMode !== "chat") return;
    dragDepthRef.current = 0;
    setDragOver(false);
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
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    void handleFiles(files);
  };

  const hasSending = sending || reconciled.unmatched.some((s) => s.state === "sending");
  const showEmptyState =
    !hasAnyRenderedRows &&
    !loadingOlder &&
    agent.status !== "working" &&
    !reconciled.awaitingReply &&
    !hasSending;
  const totalQueuedCount = queued.length + (agent.queued ?? 0);
  const runElapsed = workingStartRef.current ? workedFor(nowTick - workingStartRef.current) : "刚开始";

  return (
    <div
      ref={panelRef}
      style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}
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
            <div className="segmented">
              <button className={activeMode === "chat" ? "active" : ""} onClick={() => selectMode("chat")}>对话</button>
              <button className={activeMode === "term" ? "active" : ""} onClick={() => selectMode("term")}>终端</button>
            </div>
            {onOpenWorkbench && agent.cwd && !agent.isShell ? (
              <PocketIconButton size="sm" tooltip="在工作台看它的文件" onClick={() => onOpenWorkbench(agent.key)}>
                <FolderOpen size={14} />
              </PocketIconButton>
            ) : null}
            <PocketIconButton
              size="sm"
              tooltip="中断当前轮"
              onClick={interruptTurn}
            >
              <Square size={14} />
            </PocketIconButton>
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

      {activeMode === "chat" ? (
        <div className="chat-scroll-wrap">
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
                  </>
                ) : (
                  <ChatTimelineRows
                    rows={foldedRows}
                    subs={activeSub ? activeChildSubs : subs}
                    agentKey={agent.key}
                    deviceId={agent.deviceId}
                    cwd={agent.cwd}
                    onOpenSub={(s) => selectSubInPlace(s, subTrail)}
                    onOpenSubAside={(s) => openSubAsideView(s, subTrail)}
                    onOpenFile={(target) => {
                      openAgentFileTarget(agent, target);
                    }}
                  />
                )}
                {reconciled.unmatched.map((item) => (
                  <div key={item.id} className="bubble-row user">
                    {item.text ? <div className="bubble user">{item.text}</div> : null}
                    {item.attachedCount > 0 ? (
                      <div className="chat-attach-note row" style={{ gap: 5 }} title={item.attachedNames.join("\n")}>
                        <Paperclip size={12} />
                        <span>已附带 {item.attachedCount} 个文件/图片</span>
                      </div>
                    ) : null}
                    {item.state === "sending" ? (
                      <div className="bubble-send-meta">发送中…</div>
                    ) : item.state === "failed" ? (
                      <div className="bubble-send-meta error">
                        <span>发送失败{item.error ? `：${clip(item.error, 40)}` : ""}</span>
                        <button
                          type="button"
                          className="bubble-meta-btn primary"
                          onClick={() => void retryFailedSend(item.id, agent.key)}
                        >
                          重发
                        </button>
                        <button
                          type="button"
                          className="bubble-meta-btn"
                          onClick={() => dismissOutgoingSend(agent.key, item.id)}
                        >
                          删掉
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </>
            )}

            {agent.status === "working" ? (
              <div className="agent-run-card" role="status" aria-live="polite">
                <XiaoyangOrb mood="working" size={30} />
                <div className="agent-run-body">
                  <div className="agent-run-title">
                    <span>{activeToolLabel ? `正在执行 · ${activeToolLabel}` : "正在思考与处理"}</span>
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
            ) : hasSending || reconciled.awaitingReply ? (
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
          </div>

          {!atBottom && hasAnyRenderedRows ? (
            <button type="button" className="chat-jump-bottom" onClick={() => scrollToBottom(true)}>
              <ArrowDown size={13} />
              <span>回到底部</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {termVisited ? (
        <div style={{ flex: 1, minHeight: 0, display: activeMode === "term" ? "flex" : "none" }}>
          <TerminalSurface agent={agent} active={activeMode === "term"} />
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
          {totalQueuedCount > 0 ? (
            <div className="composer-queue-shelf" aria-label="排队中的消息">
              <div className="composer-queue-head">
                <span className="composer-queue-title">排队中 · {totalQueuedCount} 条</span>
                <span className="composer-queue-hint">
                  {!hostOnline
                    ? "电脑离线，上线后自动发送"
                    : agent.status === "blocked"
                      ? "等待确认后继续"
                      : "当前轮结束后依次自动发送"}
                </span>
              </div>
              {queued.map((q, idx) => (
                <div key={q.id} className="composer-queue-item">
                  <span className="composer-queue-idx">{idx + 1}</span>
                  <span className="composer-queue-text" title={q.text}>
                    {q.text || "（仅附件）"}
                  </span>
                  {q.attachments.length > 0 ? (
                    <span className="composer-queue-att">+{q.attachments.length} 附件</span>
                  ) : null}
                  <div className="composer-queue-actions">
                    <button
                      type="button"
                      className="composer-queue-steer"
                      title="立即打断当前轮并发送"
                      onClick={() => void steerQueuedPromptNow(agent, q.id)}
                    >
                      立即发送
                    </button>
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
              ))}
              {agent.queued ? (
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
                composer.textareaProps.onKeyDown(e);
              }}
              placeholder={
                agent.status === "working"
                  ? "继续输入将加入排队（Enter 加入排队）"
                  : agent.isShell
                    ? "输入终端命令按 Enter 执行…"
                    : `发给 ${clip(agent.name || agent.title || agent.harness, 16)}（/ 命令 · 可拖入或粘贴文件）`
              }
              value={text}
              onChange={(e) => {
                setSlashDismissedFor(null);
                if (e.target.value.startsWith("/") && modelMenuMode) setModelMenuMode(null);
                setText(e.target.value);
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
              <VoiceMicButton />
              {!agent.isShell && (agent.source === "hc" || agent.source === "herdr") ? (
                <>
                  <button
                    ref={modelBtnRef}
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={modelMenuMode === "model"}
                    className={`composer-model-btn${modelMenuMode === "model" ? " open" : ""}`}
                    title={(modelMeta.currentModel || agent.model) ? `当前模型：${modelMeta.currentModel || agent.model}（点击切换）` : "切换模型 (/model)"}
                    onClick={() => {
                      setSlashDismissedFor(text);
                      setModelMenuMode((v) => (v === "model" ? null : "model"));
                    }}
                  >
                    <Cpu size={13} />
                    <span className="truncate mono">{(modelMeta.currentModel || agent.model) ? (modelMeta.currentModel || agent.model)!.split("/").pop() : "切换模型"}</span>
                    <ChevronDown size={11} />
                  </button>
                  {(modelMeta.thinkingLevels?.length ?? 0) > 0 ? (
                    <button
                      ref={effortBtnRef}
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={modelMenuMode === "thinking"}
                      className={`composer-model-btn${modelMenuMode === "thinking" ? " open" : ""}`}
                      title={modelMeta.currentThinking ? `思考等级：${formatEffortLabel(modelMeta.currentThinking)}（点击切换）` : "切换思考等级"}
                      onClick={() => {
                        setSlashDismissedFor(text);
                        setModelMenuMode((v) => (v === "thinking" ? null : "thinking"));
                      }}
                    >
                      <Brain size={13} />
                      <span className="truncate">
                        {modelMeta.currentThinking ? `思考 · ${formatEffortLabel(modelMeta.currentThinking)}` : "思考等级"}
                      </span>
                      <ChevronDown size={11} />
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            <div className="composer-actions">
              {agent.status === "working" ? (
                !text.trim() && attachments.length === 0 ? (
                  <PocketButton size="sm" variant="soft" className="composer-send" aria-label="中断当前轮" title="中断当前轮" onClick={interruptTurn}>
                    <Square size={13} />
                  </PocketButton>
                ) : (
                  <PocketButton
                    size="sm"
                    className="composer-send"
                    aria-label="加入排队"
                    title="加入排队 (Enter)"
                    onClick={() => submitComposer()}
                  >
                    <Clock size={14} />
                  </PocketButton>
                )
              ) : (
                <PocketButton
                  size="sm"
                  className="composer-send"
                  aria-label="发送"
                  title="发送 (Enter)"
                  disabled={!text.trim() && attachments.length === 0}
                  onClick={() => submitComposer()}
                >
                  <Send size={14} />
                </PocketButton>
              )}
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
        currentModelHint={modelMeta.currentModel}
        currentThinkingHint={modelMeta.currentThinking}
        onSelectModel={applyModelSwitch}
        onSelectThinking={applyThinkingSwitch}
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
    </div>
  );
}

export function CreateAgentModal({
  open,
  onOpenChange,
  hosts,
  defaultHost,
  defaultSpace,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hosts: Device[];
  defaultHost: string | null;
  defaultSpace: string | null;
  onCreated: (key: string) => void;
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
        setSpaces(res.spaces);
        setLaunchers(res.launchers);
        setFolders(res.folders);
        setLauncher(res.launchers[0]?.id ?? "");
        const matched = defaultSpace ? res.spaces.find((s) => s.name === defaultSpace) : undefined;
        const initialSpace = matched ?? res.spaces[0];
        setSpaceId(initialSpace?.id ?? "");
        setFolder(initialSpace?.folder || res.folders[0] || "");
        setSpaceState({ loading: false, error: null, canCreate: res.canCreate !== false, reason: res.reason });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setSpaceState({ loading: false, error: e.message || "无法联系这台电脑", canCreate: false });
      });
    return () => {
      cancelled = true;
    };
  }, [open, hostId, defaultSpace]);

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
      const res = await rpcCall(hostId, "agent.create", {
        space: spaceId || undefined,
        spaceName: spaceId ? undefined : spaceName.trim() || undefined,
        folder: folder.trim() || undefined,
        launcher,
        task: task.trim() || undefined,
      }, 30_000);
      onOpenChange(false);
      setTask("");
      onCreated(res.agent);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PocketModal open={open} onOpenChange={onOpenChange} title="新建 Agent" subtitle="选择工作目录后自动匹配已有空间（或新建命名空间）" width={540}>
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

          <div>
            <div className="faint" style={{ marginBottom: 4 }}>第一条任务（可选）</div>
            <PocketInput placeholder="要交给它做什么…" value={task} onChange={(e) => setTask(e.target.value)} />
          </div>

          <div className="row" style={{ justifyContent: "flex-end" }}>
            <PocketButton variant="ghost" onClick={() => onOpenChange(false)}>取消</PocketButton>
            <PocketButton variant="primary" disabled={busy || spaceState.loading || !spaceState.canCreate || !hostId || !launcher} onClick={() => void submit()}>
              {busy ? "正在启动…" : "启动 Agent"}
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
