import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  ImagePlus,
  Laptop,
  Menu,
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
  textWithFiles,
  type Agent,
  type AgentStatus,
  type ConvEvent,
  type Device,
  type LaunchOption,
  type PutFile,
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
import { VendorAvatar, XiaoyangOrb, statusTone } from "../components/MascotAndVendor";
import { renderAnsiLines } from "../lib/ansi";
import { copyToClipboard, detectPlatform, encodeImageFiles } from "../lib/bridge";
import { termKeyAction } from "../lib/termKeys";
import { RichMarkdown, parseChoices } from "../lib/markdown";
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

const MAC = detectPlatform() === "macos";

/** Shortens `s` to `max` characters with an ellipsis (placeholders cannot ellipsize in CSS). */
function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

/** Text selected inside `box`, or "". */
function termSelection(box: HTMLElement | null): string {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!box || !sel || sel.isCollapsed || !sel.anchorNode || !box.contains(sel.anchorNode)) return "";
  return sel.toString();
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

export function AgentDetailPanel({
  agent,
  initialTab = "chat",
  onBack,
  onOpenWorkbench,
  mobile = false,
  embedded = false,
}: {
  agent: Agent;
  initialTab?: "chat" | "term";
  onBack?: () => void;
  onOpenWorkbench?: (agentKey: string) => void;
  mobile?: boolean;
  /** Inside a v3 pane: the pane header already shows harness, title and folder. */
  embedded?: boolean;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<"chat" | "term" | "subs">(initialTab);
  const [events, setEvents] = useState<ConvEvent[]>([]);
  const [termLines, setTermLines] = useState<string[]>([]);
  const [subs, setSubs] = useState<SubSession[]>([]);
  const [subModal, setSubModal] = useState<{ title: string; events: ConvEvent[] } | null>(null);
  const [text, setText] = useState("");
  const [pendingImages, setPendingImages] = useState<PutFile[]>([]);
  const [sending, setSending] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const termScrollRef = useRef<HTMLDivElement>(null);
  const pasteCatchRef = useRef<HTMLTextAreaElement>(null);
  const pasteArmedRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setEvents([]);
    setTermLines(["正在加载终端…"]);
    setSubs([]);

    void rpcCall(agent.deviceId, "session.events", { agent: agent.key, limit: 80 })
      .then((res) => {
        if (alive) setEvents(res.events);
      })
      .catch(() => {});

    void rpcCall(agent.deviceId, "terminal.read", { agent: agent.key, lines: 160 })
      .then((res) => {
        if (alive) setTermLines((res.ansi || res.text || "").split("\n"));
      })
      .catch((e) => {
        if (alive) setTermLines([`读取失败：${(e as Error).message}`]);
      });

    if (agent.subagents) {
      void rpcCall(agent.deviceId, "session.children", { agent: agent.key })
        .then((res) => {
          if (alive) setSubs(res.sessions);
        })
        .catch(() => {});
    }

    const unsubSession = subscribeStream(agent.deviceId, "session", { agent: agent.key }, (ev) => {
      if (!alive || !ev) return;
      if (ev.kind === "session_event" && ev.event) {
        const nextEv = ev.event as ConvEvent;
        setEvents((prev) => {
          const i = prev.findIndex((x) => x.id === nextEv.id);
          if (i >= 0) {
            const copy = prev.slice();
            copy[i] = nextEv;
            return copy;
          }
          return [...prev, nextEv];
        });
      }
    });

    const unsubTerm = subscribeStream(
      agent.deviceId,
      "terminal",
      { agent: agent.key, history: 160, rows: true },
      (ev) => {
        if (!alive || !ev) return;
        if (ev.kind === "terminal" && ev.screen) {
          setTermLines(String(ev.screen.ansi || ev.screen.text || "").split("\n"));
        } else if (ev.kind === "terminal_rows") {
          setTermLines((prev) => applyRows(prev, ev));
        }
      },
    );

    void rpcCall(agent.deviceId, "agent.seen", { agent: agent.key }).catch(() => {});

    return () => {
      alive = false;
      unsubSession();
      unsubTerm();
    };
  }, [agent.deviceId, agent.key, agent.subagents]);

  useEffect(() => {
    const el = chatScrollRef.current;
    // Only a thread with messages sticks to the bottom; the empty state is read from the top.
    if (el && tab === "chat") el.scrollTop = events.length ? el.scrollHeight : 0;
  }, [events.length, tab]);

  useEffect(() => {
    const el = termScrollRef.current;
    if (el && tab === "term") el.scrollTop = el.scrollHeight;
  }, [termLines.length, tab]);

  const choices = useMemo(() => parseChoices(termLines), [termLines]);

  const sendLockRef = useRef(false);
  const lastSendRef = useRef<{ sig: string; at: number } | null>(null);

  const sendMessage = async (msgText?: string) => {
    const raw = (msgText ?? text).trim();
    const pics = msgText === undefined ? pendingImages : [];
    const now = Date.now();
    const sig = `${agent.key}\0${raw}\0${pics.length}`;
    if ((!raw && pics.length === 0) || sendLockRef.current) return;
    if (lastSendRef.current && lastSendRef.current.sig === sig && now - lastSendRef.current.at < 500) return;
    sendLockRef.current = true;
    lastSendRef.current = { sig, at: now };
    setSending(true);
    try {
      let body = raw;
      if (pics.length > 0 && msgText === undefined) {
        const uploaded = await rpcCall(agent.deviceId, "terminal.put", { agent: agent.key, files: pics }, 30_000);
        body = textWithFiles(raw, uploaded.paths);
      }
      await rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: body, enter: true });
      if (msgText === undefined) {
        setText("");
        setPendingImages([]);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      sendLockRef.current = false;
      setSending(false);
    }
  };

  const sendKeys = async (keys: string[]) => {
    try {
      await rpcCall(agent.deviceId, "terminal.keys", { agent: agent.key, keys });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const sendRawInput = async (data: string) => {
    try {
      await rpcCall(agent.deviceId, "terminal.input", { agent: agent.key, data });
    } catch {
      await rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: data, enter: false }).catch(() => {});
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    try {
      const encoded = await encodeImageFiles(Array.from(files), PUT_LIMITS.files - pendingImages.length);
      setPendingImages((prev) => [...prev, ...encoded].slice(0, PUT_LIMITS.files));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Top Bar */}
      <div className={`between wrap${embedded ? " detail-toolbar" : ""}`} style={embedded ? undefined : { padding: "10px 14px", borderBottom: "1px solid var(--divider)", flexShrink: 0, flexWrap: "wrap", rowGap: 8 }}>
        {/* Narrow windows: the actions drop below the title instead of squeezing it to a few letters. */}
        <div className="row" style={{ minWidth: 0, flex: "1 1 200px", display: embedded ? "none" : undefined }}>
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
          <div className="segmented">
            <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>对话</button>
            <button className={tab === "term" ? "active" : ""} onClick={() => setTab("term")}>终端</button>
            {agent.subagents || subs.length ? (
              <button className={tab === "subs" ? "active" : ""} onClick={() => setTab("subs")}>子 agent ({subs.length || agent.subagents})</button>
            ) : null}
          </div>
          {onOpenWorkbench && agent.cwd && !agent.isShell ? (
            <PocketIconButton size="sm" tooltip="在工作台看它的文件" onClick={() => onOpenWorkbench(agent.key)}>
              <FolderOpen size={14} />
            </PocketIconButton>
          ) : null}
          <PocketIconButton
            size="sm"
            tooltip="中断当前轮 (Esc)"
            onClick={() => void rpcCall(agent.deviceId, "terminal.interrupt", { agent: agent.key }).catch((e) => toast((e as Error).message, true))}
          >
            <Square size={14} />
          </PocketIconButton>
          <PocketIconButton
            size="sm"
            tooltip="关闭终端"
            onClick={() => void rpcCall(agent.deviceId, "terminal.kill", { agent: agent.key }).then(() => onBack?.()).catch((e) => toast((e as Error).message, true))}
          >
            <Trash2 size={14} />
          </PocketIconButton>
        </div>
      </div>

      {tab === "chat" ? (
        <div ref={chatScrollRef} className="chat-scroll">
          {events.length === 0 ? (
            <EmptyState mood="sleepy" title="还没有对话记录" body="在下方发一条消息，或切换到“终端”直接看屏幕输出。" />
          ) : (
            events.map((ev) => {
              if (ev.kind === "user_message") {
                return (
                  <div key={ev.id} className="bubble-row user">
                    <div className="bubble user">{ev.text}</div>
                  </div>
                );
              }
              if (ev.kind === "assistant_message") {
                return (
                  <div key={ev.id} className="bubble-row assistant">
                    <div className="bubble assistant">
                      <RichMarkdown text={ev.text} />
                    </div>
                  </div>
                );
              }
              if (ev.kind === "tool_call") {
                return (
                  <details key={ev.id} className="pk-card soft" style={{ padding: "8px 12px" }}>
                    <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: fs(12.5) }}>
                      调用工具：<span className="mono">{ev.name}</span>
                    </summary>
                    <pre className="mono" style={{ fontSize: fs(11.5), margin: "6px 0 0", overflowX: "auto" }}>
                      {JSON.stringify(ev.input, null, 2)}
                    </pre>
                  </details>
                );
              }
              if (ev.kind === "tool_result") {
                return (
                  <details key={ev.id} className="pk-card soft" style={{ padding: "8px 12px" }}>
                    <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: fs(12.5), color: ev.is_error ? "var(--blush-text)" : "var(--mint-text)" }}>
                      {ev.is_error ? "工具出错" : "工具返回"} {ev.name || ""}
                    </summary>
                    <pre className="mono" style={{ fontSize: fs(11.5), margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{ev.output}</pre>
                  </details>
                );
              }
              return null;
            })
          )}
        </div>
      ) : null}

      {tab === "term" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div
            ref={termScrollRef}
            tabIndex={0}
            className="term-box"
            title={MAC ? "点击此处后可直接用键盘输入终端控制符" : "点击此处后可直接用键盘输入；Ctrl+V 粘贴，选中文字后 Ctrl+C 复制"}
            onKeyDown={(e) => {
              const action = termKeyAction(e, MAC, termSelection(termScrollRef.current) !== "");
              switch (action.kind) {
                case "send":
                  e.preventDefault();
                  void sendRawInput(action.data);
                  return;
                case "copy":
                  e.preventDefault();
                  void copyToClipboard(termSelection(termScrollRef.current));
                  return;
                case "paste":
                  // The browser's own paste lands in the hidden box below, which forwards it;
                  // reading the clipboard directly would need a permission prompt.
                  pasteArmedRef.current = Date.now();
                  pasteCatchRef.current?.focus();
                  window.setTimeout(() => {
                    if (!pasteArmedRef.current) return;
                    pasteArmedRef.current = 0;
                    termScrollRef.current?.focus();
                    void navigator.clipboard
                      ?.readText()
                      .then((t) => (t ? sendRawInput(t) : undefined))
                      .catch(() => toast("读不到剪贴板：在别处复制后再按 Ctrl+V，或用下方输入框发送", true));
                  }, 250);
                  return;
                case "none":
                  e.preventDefault();
                  return;
                case "native-copy":
                case "pass":
                  return;
              }
            }}
          >
            {renderAnsiLines(termLines)}
          </div>
          <textarea
            ref={pasteCatchRef}
            className="paste-catch"
            aria-hidden
            tabIndex={-1}
            onPaste={(e) => {
              e.preventDefault();
              const t = e.clipboardData?.getData("text/plain") ?? "";
              pasteArmedRef.current = 0;
              termScrollRef.current?.focus();
              if (t) void sendRawInput(t);
            }}
            onBlur={(e) => {
              e.currentTarget.value = "";
            }}
          />
          <div className="term-keybar">
            {[
              { label: "Esc", keys: ["esc"] },
              { label: "Tab", keys: ["tab"] },
              { label: "Shift+Tab", keys: ["shift+tab"] },
              { label: "↑", keys: ["up"] },
              { label: "↓", keys: ["down"] },
              { label: "←", keys: ["left"] },
              { label: "→", keys: ["right"] },
              { label: "Ctrl+C", keys: ["ctrl+c"] },
              { label: "Enter", keys: ["enter"], accent: true },
            ].map((k) => (
              <button key={k.label} className={`term-key${k.accent ? " accent" : ""}`} onClick={() => void sendKeys(k.keys)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {tab === "subs" ? (
        <div className="chat-scroll">
          {subs.map((s) => (
            <PocketCard key={s.key} soft>
              <div className="between">
                <div className="grow">
                  <div style={{ fontWeight: 800 }}>{s.title || s.preview || s.key}</div>
                  <div className="faint">{s.harness} · {s.status}</div>
                </div>
                <PocketButton
                  size="sm"
                  variant="soft"
                  onClick={async () => {
                    try {
                      const res = await rpcCall(agent.deviceId, "session.events", { agent: agent.key, sub: s.key, limit: 80 });
                      setSubModal({ title: s.title || s.key, events: res.events });
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  }}
                >
                  看对话
                </PocketButton>
              </div>
            </PocketCard>
          ))}
        </div>
      ) : null}

      {/* Quick Numbered Choices */}
      {choices.length > 0 ? (
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

      {/* Attached Images */}
      {pendingImages.length > 0 ? (
        <div className="row wrap" style={{ padding: "4px 16px", gap: 8, flexShrink: 0 }}>
          {pendingImages.map((img, i) => (
            <div key={i} className="row" style={{ background: "var(--surface-2)", padding: "4px 10px", borderRadius: 999, gap: 6 }}>
              <span className="faint">{img.name}</span>
              <button style={{ border: 0, background: "transparent", cursor: "pointer" }} onClick={() => setPendingImages((prev) => prev.filter((_, idx) => idx !== i))}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Composer */}
      <div className="composer-bar" style={{ flexShrink: 0 }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <PocketIconButton size="sm" tooltip="发送图片" onClick={() => fileRef.current?.click()}>
          <ImagePlus size={16} />
        </PocketIconButton>
        <textarea
          rows={1}
          placeholder={`发给 ${clip(agent.name || agent.title || agent.harness, 16)}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) {
              e.preventDefault();
              void handleFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <PocketButton size="sm" disabled={(!text.trim() && pendingImages.length === 0) || sending} onClick={() => void sendMessage()}>
          <Send size={14} />
        </PocketButton>
      </div>

      <PocketModal open={Boolean(subModal)} onOpenChange={(v) => !v && setSubModal(null)} title={subModal?.title || "子 Agent 对话"} width={620}>
        <div className="stack" style={{ maxHeight: 420, overflowY: "auto" }}>
          {(subModal?.events ?? []).map((ev) =>
            ev.kind === "assistant_message" || ev.kind === "user_message" ? (
              <div key={ev.id} className={`bubble-row ${ev.kind === "user_message" ? "user" : "assistant"}`}>
                <div className={`bubble ${ev.kind === "user_message" ? "user" : "assistant"}`}>
                  <RichMarkdown text={ev.text} />
                </div>
              </div>
            ) : null,
          )}
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
  const onlineHosts = hosts.filter((h) => h.online);
  const [hostId, setHostId] = useState(defaultHost || onlineHosts[0]?.id || "");
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [launchers, setLaunchers] = useState<LaunchOption[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [spaceName, setSpaceName] = useState(defaultSpace || "");
  const [launcher, setLauncher] = useState("");
  const [folder, setFolder] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const h = defaultHost || onlineHosts[0]?.id || hosts[0]?.id || "";
    setHostId(h);
  }, [open, defaultHost]);

  useEffect(() => {
    if (!open || !hostId) return;
    void rpcCall(hostId, "spaces.list", {})
      .then((res) => {
        setSpaces(res.spaces);
        setLaunchers(res.launchers);
        setFolders(res.folders);
        setLauncher(res.launchers[0]?.id ?? "");
        setFolder(res.folders[0] ?? "");
        const matched = defaultSpace ? res.spaces.find((s) => s.name === defaultSpace) : undefined;
        setSpaceId(matched?.id ?? res.spaces[0]?.id ?? "");
      })
      .catch(() => {});
  }, [open, hostId]);

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
    <PocketModal open={open} onOpenChange={onOpenChange} title="新建 Agent" subtitle="在指定电脑和工作空间里启动一个新会话" width={480}>
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

        {spaces.length > 0 ? (
          <div>
            <div className="faint" style={{ marginBottom: 4 }}>空间（留空或新建）</div>
            <PocketSelect
              value={spaceId}
              onValueChange={setSpaceId}
              options={[{ value: "", label: "新建空间" }, ...spaces.map((s) => ({ value: s.id, label: s.name }))]}
            />
          </div>
        ) : null}

        {!spaceId ? (
          <div>
            <div className="faint" style={{ marginBottom: 4 }}>新空间名称</div>
            <PocketInput placeholder="例如：backend" value={spaceName} onChange={(e) => setSpaceName(e.target.value)} />
          </div>
        ) : null}

        <div>
          <div className="faint" style={{ marginBottom: 4 }}>工作目录</div>
          <PocketInput placeholder="~/work/project" value={folder} onChange={(e) => setFolder(e.target.value)} />
          {folders.length > 0 ? (
            <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
              {folders.slice(0, 4).map((f) => (
                <button key={f} type="button" className="term-key" onClick={() => setFolder(f)}>{f}</button>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <div className="faint" style={{ marginBottom: 4 }}>第一条任务（可选）</div>
          <PocketInput placeholder="要交给它做什么…" value={task} onChange={(e) => setTask(e.target.value)} />
        </div>

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <PocketButton variant="ghost" onClick={() => onOpenChange(false)}>取消</PocketButton>
          <PocketButton variant="primary" disabled={busy || !hostId || !launcher} onClick={() => void submit()}>
            {busy ? "正在启动…" : "启动 Agent"}
          </PocketButton>
        </div>
      </div>
    </PocketModal>
  );
}
