import { useCallback, useMemo, useRef, useState } from "react";
import { Menu, Plus, Search, Terminal, X } from "lucide-react";
import type { Agent, AgentStatus, Device } from "@herdr-pocket/protocol";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import { EmptyState, PocketButton, PocketIconButton, PocketInput, useToast } from "../components/PocketUI";
import { copyToClipboard } from "../lib/bridge";
import {
  STATUS_LABEL,
  agentSpace,
  agentTitle,
  allAgents,
  greeting,
  liveStore,
  settingsStore,
  spacedTitle,
  updateSettings,
} from "../lib/store";
import { SpaceTileIcon } from "../shell/spaceIcon";
import { AgentRow, CreateAgentModal } from "../views/AgentsView";
import { MobileSidebarDrawer } from "./MobileSidebarDrawer";

type GroupMode = "space" | "status";
type GroupKey = "blocked" | "working" | "done" | "idle" | "offline";

const GROUPS: Array<{ key: GroupKey; title: string }> = [
  { key: "blocked", title: "需要你" },
  { key: "working", title: "工作中" },
  { key: "done", title: "已完成" },
  { key: "idle", title: "空闲" },
  { key: "offline", title: "离线" },
];

const STATUS_RANK: Record<GroupKey, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  offline: 4,
};

const byRecent = (x: Agent, y: Agent) => (y.statusSince ?? y.updatedAt) - (x.statusSince ?? x.updatedAt);

export function MobileAgentsTab({
  onSelectAgent,
  onOpenDevices,
  onOpenSettings,
}: {
  onSelectAgent: (key: string, tab?: "chat" | "term") => void;
  onOpenDevices: () => void;
  onOpenSettings: () => void;
}) {
  const toast = useToast();
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const showShells = settingsStore.use((s) => s.showShells);
  const hostFilterSaved = settingsStore.use((s) => s.hostFilter);
  const dark = settingsStore.use((s) => s.theme) === "dark";

  const [statusFilter, setStatusFilter] = useState<AgentStatus | null>(null);
  const [spaceFilter, setSpaceFilter] = useState<string | null>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>("space");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<{ host: string | null; space: string | null }>({ host: null, space: null });
  const [menu, setMenu] = useState<Agent | null>(null);
  const [foldedSpaces, setFoldedSpaces] = useState<string[]>([]);
  const [foldedGroups, setFoldedGroups] = useState<GroupKey[]>([]);
  const [fabCompact, setFabCompact] = useState(false);
  const lastScrollRef = useRef(0);

  const hosts = useMemo(() => {
    const list: Device[] = Object.values(devices).filter((d) => d.kind === "host");
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
  const hostCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of all) out[a.deviceId] = (out[a.deviceId] ?? 0) + 1;
    return out;
  }, [all]);

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

  const groupOf = useCallback(
    (a: Agent): GroupKey =>
      !isOnline(a) ? "offline" : a.status === "blocked" || a.status === "working" || a.status === "done" ? a.status : "idle",
    [isOnline],
  );

  const q = query.trim().toLowerCase();

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
    return [...byDevice.entries()]
      .map(([deviceId, perSpace]) => {
        const groups = [...perSpace.entries()]
          .map(([space, list]) => {
            list.sort((x, y) => STATUS_RANK[groupOf(x)] - STATUS_RANK[groupOf(y)] || byRecent(x, y));
            const tally = { blocked: 0, working: 0, done: 0 };
            for (const a of list) {
              const g = groupOf(a);
              if (g === "blocked" || g === "working" || g === "done") tally[g]++;
            }
            const id = `${deviceId}:${space}`;
            return {
              id,
              space,
              list,
              tally,
              folded: !q && !statusFilter && foldedSpaces.includes(id),
            };
          })
          .sort((a, b) => Number(Boolean(b.space)) - Number(Boolean(a.space)) || byRecent(a.list[0]!, b.list[0]!));
        const dev = devices[deviceId];
        return {
          deviceId,
          name: dev?.name ?? deviceId,
          online: dev?.online ?? false,
          count: groups.reduce((n, g) => n + g.list.length, 0),
          groups,
        };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [devices, foldedSpaces, groupOf, inScope, q, statusFilter]);

  const sections = useMemo(() => {
    const by: Record<GroupKey, Agent[]> = { blocked: [], working: [], done: [], idle: [], offline: [] };
    for (const a of inScope) {
      if (q && ![spacedTitle(a), a.harness, a.where, a.cwd, a.preview].some((s) => s?.toLowerCase().includes(q))) continue;
      by[groupOf(a)].push(a);
    }
    return GROUPS.filter((g) => by[g.key].length && (!statusFilter || g.key === statusFilter)).map((g) => {
      const folded = !q && !statusFilter && foldedGroups.includes(g.key);
      return {
        key: g.key,
        title: g.title,
        count: by[g.key].length,
        folded,
        data: folded ? [] : by[g.key].sort(byRecent),
      };
    });
  }, [foldedGroups, groupOf, inScope, q, statusFilter]);

  const openCreate = (host: string | null, space: string | null) => {
    setCreateTarget({ host, space });
    setCreateOpen(true);
  };

  const scopeLabel = activeSpace || (hostFilter ? devices[hostFilter]?.name ?? "当前电脑" : "全部电脑");
  const headline = `${scopeLabel} · ${inScope.length} 个运行中${counts.blocked ? ` · ${counts.blocked} 个需要你` : ""}`;

  const rowFor = (agent: Agent, showSpace: boolean) => {
    const offline = !isOnline(agent);
    const sub = [
      showSpace ? agentSpace(agent) : null,
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
        selected={false}
        dark={dark}
        sub={sub || agent.cwd || agent.harness}
        onOpen={() => onSelectAgent(agent.key, agent.isShell ? "term" : "chat")}
        onMenu={() => setMenu(agent)}
      />
    );
  };

  return (
    <>
      <div
        className="mp-scroll has-fab"
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop;
          const delta = top - lastScrollRef.current;
          if (Math.abs(delta) > 6) {
            setFabCompact(delta > 0 && top > 24);
            lastScrollRef.current = top;
          }
        }}
      >
        <div className="stack" style={{ gap: 12 }}>
          <div className="between" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <PocketIconButton tooltip="筛选电脑与空间" onClick={() => setDrawerOpen(true)}>
                <Menu size={18} />
              </PocketIconButton>
              <div style={{ minWidth: 0 }}>
                <h1 className="cute-font mp-page-title" style={{ fontSize: 22 }}>{greeting()}</h1>
                <div className="mp-page-sub truncate">{headline}</div>
              </div>
            </div>
            <div className="row" style={{ gap: 6, flexShrink: 0 }}>
              <PocketIconButton tooltip="搜索" active={searching} onClick={() => setSearching((v) => !v)}>
                <Search size={16} />
              </PocketIconButton>
              <PocketIconButton
                tooltip={showShells ? "隐藏普通终端" : "显示普通终端"}
                active={showShells}
                onClick={() => updateSettings({ showShells: !showShells })}
              >
                <Terminal size={16} />
              </PocketIconButton>
              <XiaoyangOrb mood={counts.blocked ? "waiting" : counts.working ? "working" : "hello"} size={40} />
            </div>
          </div>

          {searching ? (
            <div className="row" style={{ gap: 6 }}>
              <PocketInput
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称、路径、分支或助手…"
              />
              {query ? (
                <PocketIconButton size="sm" tooltip="清除搜索" onClick={() => setQuery("")}>
                  <X size={14} />
                </PocketIconButton>
              ) : null}
            </div>
          ) : null}

          <div className="mp-stat-row">
            {(
              [
                { key: "blocked", label: STATUS_LABEL.blocked },
                { key: "working", label: STATUS_LABEL.working },
                { key: "done", label: STATUS_LABEL.done },
              ] as const
            ).map((s) => {
              const active = statusFilter === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  className={`mp-stat-pill${active ? " active" : ""}`}
                  onClick={() => setStatusFilter(active ? null : s.key)}
                >
                  <span className="mp-stat-label">{s.label}</span>
                  <span className="mp-stat-num num">{counts[s.key]}</span>
                </button>
              );
            })}
          </div>

          <div className="mp-seg" role="tablist" aria-label="分组方式">
            <button
              type="button"
              role="tab"
              aria-selected={groupMode === "space"}
              className={`mp-seg-btn${groupMode === "space" ? " active" : ""}`}
              onClick={() => setGroupMode("space")}
            >
              按空间
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={groupMode === "status"}
              className={`mp-seg-btn${groupMode === "status" ? " active" : ""}`}
              onClick={() => setGroupMode("status")}
            >
              按状态
            </button>
          </div>

          {inScope.length === 0 ? (
            <EmptyState
              mood="hello"
              title="还没有运行的 Agent"
              body={hosts.some((h) => h.online) ? "点右下角“+ 新建”在电脑上启动一个 Agent。" : "先在电脑上启动 hostd 并连上同一个中转服务器。"}
              action={
                hosts.some((h) => h.online) ? (
                  <PocketButton variant="primary" onClick={() => openCreate(hostFilter, activeSpace)}>
                    新建 Agent
                  </PocketButton>
                ) : undefined
              }
            />
          ) : groupMode === "space" ? (
            <div className="stack" style={{ gap: 12 }}>
              {spaceGroups.map((dev) => (
                <div key={dev.deviceId} className="stack" style={{ gap: 8 }}>
                  <div className="mp-section-head" style={{ margin: "4px 2px 0" }}>
                    <span className="row" style={{ gap: 6 }}>
                      <span className={`status-pip${dev.online ? " ok" : ""}`} />
                      <span>{dev.name}</span>
                    </span>
                    <span className="faint num">{dev.count}</span>
                  </div>
                  {dev.groups.map((g) => {
                    const label = g.space || "未分空间";
                    return (
                      <div key={g.id} className="stack" style={{ gap: 8 }}>
                        <div className="between" style={{ padding: "0 2px" }}>
                          <button
                            type="button"
                            className="row"
                            style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", gap: 8, color: "var(--mp-ink)" }}
                            onClick={() =>
                              setFoldedSpaces((prev) => (prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id]))
                            }
                          >
                            <SpaceTileIcon spaceKey={`${dev.deviceId}\u0000${label}`} name={label} blocked={g.tally.blocked > 0} size="md" />
                            <span style={{ fontWeight: 800, fontSize: 13.5 }}>{label}</span>
                            <span className="faint num" style={{ fontSize: 12 }}>{g.list.length}</span>
                          </button>
                          {g.space && dev.online ? (
                            <PocketIconButton size="sm" tooltip={`在 ${g.space} 新建`} onClick={() => openCreate(dev.deviceId, g.space)}>
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
            <div className="stack" style={{ gap: 10 }}>
              {sections.map((sec) => (
                <div key={sec.key} className="stack" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="between"
                    style={{ border: 0, background: "transparent", padding: "2px 4px", cursor: "pointer", color: "var(--mp-muted)", fontWeight: 800, fontSize: 13 }}
                    onClick={() =>
                      setFoldedGroups((prev) => (prev.includes(sec.key) ? prev.filter((x) => x !== sec.key) : [...prev, sec.key]))
                    }
                  >
                    <span>{sec.title} · {sec.count}</span>
                  </button>
                  {sec.data.map((agent) => rowFor(agent, true))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <button
        type="button"
        className={`fab-new${fabCompact ? " compact" : ""}`}
        aria-label="新建 Agent"
        onClick={() => openCreate(hostFilter, activeSpace)}
      >
        <Plus size={20} />
        <span className="fab-new-label">新建</span>
      </button>

      {menu ? (
        <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setMenu(null)}>
          <div className="action-sheet" role="menu" aria-label={agentTitle(menu)}>
            <div className="action-sheet-title truncate">{agentTitle(menu)}</div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const key = menu.key;
                setMenu(null);
                onSelectAgent(key, "chat");
              }}
            >
              打开对话
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const key = menu.key;
                setMenu(null);
                onSelectAgent(key, "term");
              }}
            >
              打开终端
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const target = menu;
                setMenu(null);
                openCreate(target.deviceId, agentSpace(target) ?? null);
              }}
            >
              {agentSpace(menu) ? `在「${agentSpace(menu)}」再开一个` : "在这台电脑再开一个"}
            </button>
            <button
              type="button"
              className="menu-item"
              disabled={!menu.cwd}
              onClick={() => {
                const path = menu.cwd;
                setMenu(null);
                if (path) void copyToClipboard(path).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok));
              }}
            >
              复制工作路径
            </button>
            <button type="button" className="menu-item action-sheet-cancel" onClick={() => setMenu(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      <MobileSidebarDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        hosts={hosts}
        hostCounts={hostCounts}
        allCount={all.length}
        hostFilter={hostFilter}
        onSelectHost={(id) => updateSettings({ hostFilter: id })}
        spaces={spaces}
        scopeCount={onHost.length}
        spaceFilter={activeSpace}
        onSelectSpace={setSpaceFilter}
        onNewInSpace={(space) => openCreate(hostFilter, space)}
        onOpenDevices={onOpenDevices}
        onOpenSettings={onOpenSettings}
      />

      <CreateAgentModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        hosts={hosts}
        defaultHost={createTarget.host ?? hostFilter}
        defaultSpace={createTarget.space ?? activeSpace}
        onCreated={(info) => onSelectAgent(info.agentKey, "chat")}
      />
    </>
  );
}
