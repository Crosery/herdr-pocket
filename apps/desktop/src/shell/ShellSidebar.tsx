import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye, History, Laptop, PanelLeft, Plus, QrCode, Search, Server, Settings, X } from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { VendorIcon } from "../components/MascotAndVendor";
import { serverLabel } from "../components/Sidebar";
import { assetUrl } from "../lib/bridge";
import { isMockServer } from "../lib/mock";
import { pingRelay } from "../lib/relay";
import { agentSpace, agentTitle, allAgents, liveStore, settingsStore, spacedTitle } from "../lib/store";
import { updateStore } from "../lib/updates";
import { useVisibleTick } from "../lib/layout";
import { GROUP_RANK, LIST_GROUPS, lastChange, listGroup, shortAgo, tileLetter, toneIndex, type ListGroup } from "./agentInfo";
import { openAgentTab, openSettingsFrame, setPalette, setPeek, shellStore } from "./shellStore";
import { shortcutText } from "./shortcuts";

const FOLD_KEY = "herdr-pocket-v3-folded";
const SORT_KEY = "herdr-pocket-v3-agent-sort";

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

/** Status mark at the right of a row: spinner, 需要你 chip, done dot or idle ring. */
export function StatusMark({ group, compact = false }: { group: ListGroup; compact?: boolean }) {
  if (group === "working") return <span className="v3-spinner" aria-label="运行中" />;
  if (group === "blocked") return compact ? <span className="v3-need small" aria-label="需要你">!</span> : <span className="v3-need">需要你</span>;
  if (group === "done") return <span className="v3-dot done" aria-label="已完成" />;
  return <span className={`v3-ring${group === "offline" ? " off" : ""}`} aria-label={group === "offline" ? "离线" : "空闲"} />;
}

export function ShellSidebar({
  collapsed,
  canToggle,
  onToggle,
  onConnectRelay,
  onPairPhone,
  onNewAgent,
}: {
  collapsed: boolean;
  canToggle: boolean;
  onToggle: () => void;
  onConnectRelay: () => void;
  onPairPhone: () => void;
  onNewAgent: (host: string | null, space: string | null) => void;
}) {
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const link = liveStore.use((s) => s.link);
  const server = settingsStore.use((s) => s.server);
  const showShells = settingsStore.use((s) => s.showShells);
  const activeTab = shellStore.use((s) => s.tabs.find((t) => t.id === s.active) ?? null);
  const updateReady = updateStore.use((s) => Boolean(s.info?.hasUpdate));
  useVisibleTick(30_000); // re-render so the ages move
  const now = Date.now();

  const [folded, setFolded] = useState<string[]>(() => readJson<string[]>(FOLD_KEY, []));
  const [sort, setSortState] = useState<"status" | "recent">(() => readJson(SORT_KEY, "status"));
  const [spaceSel, setSpaceSel] = useState<string | null>(null);

  const toggleFold = (id: string) => {
    const next = folded.includes(id) ? folded.filter((x) => x !== id) : [...folded, id];
    setFolded(next);
    writeJson(FOLD_KEY, next);
  };
  const setSort = (v: "status" | "recent") => {
    setSortState(v);
    writeJson(SORT_KEY, v);
  };

  const agents = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);

  // 空间: one block per computer (online first), its spaces under it, most urgent first.
  const machines = useMemo(() => {
    const ids = new Set<string>([...Object.values(devices).filter((d) => d.kind === "host").map((d) => d.id), ...agents.map((a) => a.deviceId)]);
    return [...ids]
      .map((id) => {
        const dev = devices[id];
        const per = new Map<string, Agent[]>();
        for (const a of agents) {
          if (a.deviceId !== id) continue;
          const sp = agentSpace(a) ?? "";
          per.set(sp, [...(per.get(sp) ?? []), a]);
        }
        const spaces = [...per.entries()].map(([name, list]) => {
          const groups = list.map((a) => listGroup(a, devices));
          const blocked = groups.filter((g) => g === "blocked").length;
          const best = groups.reduce<ListGroup>((b, g) => (GROUP_RANK[g] < GROUP_RANK[b] ? g : b), "offline");
          return { id: `${id}\u0000${name}`, deviceId: id, name, count: list.length, blocked, best, latest: Math.max(...list.map(lastChange)) };
        });
        spaces.sort((x, y) => y.blocked - x.blocked || GROUP_RANK[x.best] - GROUP_RANK[y.best] || y.latest - x.latest);
        return { id, name: dev?.name ?? id, online: dev?.online ?? false, spaces, count: spaces.reduce((n, s) => n + s.count, 0) };
      })
      .sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
  }, [agents, devices]);

  const selected = spaceSel && machines.some((m) => m.spaces.some((s) => s.id === spaceSel)) ? spaceSel : null;
  const [selDevice, selSpace] = selected ? (selected.split("\u0000") as [string, string]) : [null, null];
  const inScope = useMemo(
    () => (selected ? agents.filter((a) => a.deviceId === selDevice && (agentSpace(a) ?? "") === selSpace) : agents),
    [agents, selected, selDevice, selSpace],
  );

  const groups = useMemo(() => {
    if (sort === "recent") return [{ key: "recent" as const, title: "最近", list: [...inScope].sort((x, y) => lastChange(y) - lastChange(x)) }];
    const by = new Map<ListGroup, Agent[]>();
    for (const a of inScope) {
      const g = listGroup(a, devices);
      by.set(g, [...(by.get(g) ?? []), a]);
    }
    return LIST_GROUPS.filter((g) => by.get(g.key)?.length).map((g) => ({ key: g.key, title: g.title, list: by.get(g.key)!.sort((x, y) => lastChange(y) - lastChange(x)) }));
  }, [devices, inScope, sort]);

  const activeAgentKey = activeTab?.kind === "agent" ? activeTab.agentKey : null;
  const connected = Boolean(server) && link === "online";
  const demo = isMockServer(server);
  const notice =
    !server ? { text: "还没连接中转服务器", action: "连接", run: onConnectRelay }
    : link === "offline" ? { text: "和服务器断开了，正在重连", action: "立即重连", run: () => pingRelay() }
    : link === "unauthorized" ? { text: "这台设备的授权已失效", action: "重新连接", run: onConnectRelay }
    : link === "connecting" ? { text: "正在连接服务器…", action: null, run: null }
    : null;

  const agentRow = (a: Agent) => {
    const g = listGroup(a, devices);
    const label = selected ? agentTitle(a) : spacedTitle(a);
    return (
      <div
        key={a.key}
        role="button"
        tabIndex={0}
        className={`v3-row v3-agent${a.key === activeAgentKey ? " selected" : ""}${g === "offline" ? " dim" : ""}`}
        title={collapsed ? label : undefined}
        onClick={() => openAgentTab(a.key)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openAgentTab(a.key))}
      >
        <VendorIcon harness={a.harness} isShell={a.isShell} size={16} />
        {collapsed ? (
          g === "blocked" ? <span className="v3-corner blocked" aria-label="需要你" /> : null
        ) : (
          <>
            <span className="v3-row-label truncate">{label}</span>
            <span className="v3-time">{shortAgo(lastChange(a), now)}</span>
            <button
              className="v3-peek-btn"
              aria-label={`预览 ${label}`}
              title="预览（不开标签）"
              onClick={(e) => {
                e.stopPropagation();
                setPeek(a.key);
              }}
            >
              <Eye size={13} />
            </button>
            <StatusMark group={g} compact={sort === "status" && g === "blocked"} />
          </>
        )}
      </div>
    );
  };

  return (
    <aside className="v3-sidebar" aria-label="侧栏">
      <div className="v3-brand" data-tauri-drag-region="deep">
        {collapsed ? null : (
          <div className="v3-brand-name">
            <img src={assetUrl("brand/logo-160.webp")} alt="" width={20} height={20} />
            <span>Herdr Pocket</span>
          </div>
        )}
        {collapsed && canToggle ? null : (
          <button className="v3-icon-btn" aria-label="跳到 Agent 或标签" title={`跳到 Agent 或标签（${shortcutText("palette")}）`} onClick={() => setPalette("jump")}>
            <Search size={15} />
          </button>
        )}
        {canToggle ? (
          <button className="v3-icon-btn" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={`${collapsed ? "展开" : "收起"}侧栏（${shortcutText("toggleSidebar")}）`} onClick={onToggle}>
            <PanelLeft size={15} />
          </button>
        ) : null}
      </div>

      <div className="v3-lists">
        <section className="v3-block" aria-label="空间">
          {collapsed ? null : (
            <div className="v3-block-head">
              <span className="grow">空间</span>
              <button className="v3-icon-btn small" aria-label="新建 Agent" title={`新建 Agent（${shortcutText("newAgent")}）`} onClick={() => onNewAgent(null, null)}>
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
                      {m.online ? (
                        <button
                          className="v3-icon-btn small hover-only"
                          aria-label={`在 ${m.name} 新建 Agent`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onNewAgent(m.id, null);
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
                        const label = s.name || "未分空间";
                        return (
                          <div
                            key={s.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={selected === s.id}
                            className={`v3-row v3-space${selected === s.id ? " selected" : ""}`}
                            title={collapsed ? `${m.name} · ${label}` : undefined}
                            onClick={() => setSpaceSel(selected === s.id ? null : s.id)}
                            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSpaceSel(selected === s.id ? null : s.id))}
                          >
                            <span className={`v3-tile tone-${toneIndex(label)}`} aria-hidden>
                              {tileLetter(label)}
                            </span>
                            {collapsed ? null : (
                              <>
                                <span className="v3-row-label truncate">{label}</span>
                                <span className="v3-count">{s.count}</span>
                                {s.blocked ? <span className="v3-need">需要你</span> : <StatusMark group={s.best} />}
                              </>
                            )}
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

        <section className="v3-block" aria-label="Agent">
          {collapsed ? null : (
            <div className="v3-block-head">
              <span className="grow">Agent</span>
              {selected ? (
                <button className="v3-filter-chip" onClick={() => setSpaceSel(null)} title="显示全部空间的 Agent">
                  <span className="truncate">{selSpace || "未分空间"}</span>
                  <X size={11} />
                </button>
              ) : null}
              <button
                className={`v3-icon-btn small${sort === "recent" ? " on" : ""}`}
                aria-label={sort === "recent" ? "按状态分组" : "按最近排序"}
                title={sort === "recent" ? "现在按最近排序，点一下按状态分组" : "现在按状态分组，点一下按最近排序"}
                onClick={() => setSort(sort === "recent" ? "status" : "recent")}
              >
                <History size={14} />
              </button>
            </div>
          )}
          <div className="v3-block-body">
            {groups.map((g) => {
              const id = `g:${g.key}`;
              const isFolded = folded.includes(id) && g.key !== "recent";
              return (
                <div key={g.key}>
                  {collapsed ? (
                    <div className="v3-machine-sep" />
                  ) : (
                    <button className="v3-group-head" aria-expanded={!isFolded} onClick={() => g.key !== "recent" && toggleFold(id)}>
                      <span>{g.title}</span>
                      <span className="v3-count">{g.list.length}</span>
                      {g.key !== "recent" ? isFolded ? <ChevronRight size={12} /> : <ChevronDown size={12} className="hover-only" /> : null}
                    </button>
                  )}
                  {isFolded && !collapsed ? null : g.list.map(agentRow)}
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
        <button className="v3-foot-row" title={collapsed ? "设置" : undefined} onClick={() => openSettingsFrame(updateReady ? "updates" : "look")}>
          <Settings size={14} />
          {collapsed ? null : <span className="grow truncate">设置</span>}
          {updateReady ? <span className="v3-update-dot" aria-label="有新版本" /> : null}
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
    </aside>
  );
}
