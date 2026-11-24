import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Columns2, History, Laptop, PanelLeft, Pencil, Plus, QrCode, Rows2, Search, Server, Settings, SquareArrowOutUpRight, Terminal, Trash2 } from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { VendorIcon } from "../components/MascotAndVendor";
import { PocketButton, PocketInput, PocketModal, overlayStore, useToast } from "../components/PocketUI";
import { serverLabel } from "../components/Sidebar";
import { assetUrl } from "../lib/bridge";
import { useLocalHostDeviceId } from "../lib/fonts";
import { isMockServer } from "../lib/mock";
import { pingRelay, refreshHostSpaces, rpcCall } from "../lib/relay";
import { agentSpace, allAgents, clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH, liveStore, settingsStore, spacedTitle, updateSettings } from "../lib/store";
import { setInteractiveResizeActive } from "./splitMotion";
import { updateStore } from "../lib/updates";
import { useVisibleTick } from "../lib/layout";
import { endPanelDrag, startPanelDrag } from "../lib/fileDrag";
import { GROUP_RANK, LIST_GROUPS, lastChange, listGroup, shortAgo, type ListGroup } from "./agentInfo";
import { pullHostDocNow } from "./herdrDocSync";
import { SPACE_ICON_PRESETS, SpaceTileIcon, setCustomSpaceIcon, spaceIconStore } from "./spaceIcon";
import { activeTabIdForSpace, closeTabsForSpace, focusedLeafOfTab, openAgentTab, openSettingsFrame, renameSpaceInShellStore, setPalette, setSelectedSpace, shellStore, splitActivePaneWithContent, tabLeaves } from "./shellStore";
import { shortcutText } from "./shortcuts";
import { SpatialHint } from "./useModifierHoldHints";
import { buildHostSpaces, type SidebarSpace } from "./spaceSync";

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
  const localHostId = useLocalHostDeviceId();
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
  const [sort, setSortState] = useState<"status" | "recent">(() => readJson(SORT_KEY, "status"));
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<SidebarSpace | null>(null);
  const [deletingSpace, setDeletingSpace] = useState(false);
  const [renameSpaceTarget, setRenameSpaceTarget] = useState<SidebarSpace | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renamingSpace, setRenamingSpace] = useState(false);
  const [spaceMenu, setSpaceMenu] = useState<{ x: number; y: number; space: SidebarSpace } | null>(null);
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number; agent: Agent } | null>(null);
  const customSpaceIcons = spaceIconStore.use((m) => m);
  const toast = useToast();
  const setSpaceSel = (next: string | null) => setSelectedSpace(next, (k) => allByKey.get(k), spacesMap);

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
  const setSort = (v: "status" | "recent") => {
    setSortState(v);
    writeJson(SORT_KEY, v);
  };

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
  // Agent list stays global across all Spaces & computers like Herdr.app; clicking any Agent switches Spaces automatically.
  const inScope = agents;
  const primaryMachineId = localHostId || machines[0]?.id || null;

  const [hoverFreeze, setHoverFreeze] = useState(false);
  const frozenOrderRef = useRef<Map<string, string[]>>(new Map());

  const groups = useMemo(() => {
    const raw =
      sort === "recent"
        ? [{ key: "recent" as const, title: "最近", list: [...inScope].sort((x, y) => lastChange(y) - lastChange(x)) }]
        : (() => {
            const by = new Map<ListGroup, Agent[]>();
            for (const a of inScope) {
              const g = listGroup(a, devices);
              by.set(g, [...(by.get(g) ?? []), a]);
            }
            return LIST_GROUPS.filter((g) => by.get(g.key)?.length).map((g) => ({
              key: g.key,
              title: g.title,
              list: by.get(g.key)!.sort((x, y) => lastChange(y) - lastChange(x)),
            }));
          })();

    if (!hoverFreeze) {
      const nextMap = new Map<string, string[]>();
      for (const g of raw) {
        nextMap.set(g.key, g.list.map((a) => a.key));
      }
      frozenOrderRef.current = nextMap;
      return raw;
    }

    return raw.map((g) => {
      const frozen = frozenOrderRef.current.get(g.key);
      if (!frozen?.length) return g;
      const rank = new Map<string, number>();
      frozen.forEach((k, idx) => rank.set(k, idx));
      const sorted = [...g.list].sort((x, y) => {
        const rx = rank.get(x.key);
        const ry = rank.get(y.key);
        if (rx !== undefined && ry !== undefined) return rx - ry;
        if (rx !== undefined) return -1;
        if (ry !== undefined) return 1;
        return lastChange(y) - lastChange(x);
      });
      return { ...g, list: sorted };
    });
  }, [devices, hoverFreeze, inScope, sort]);

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

  const agentRow = (a: Agent) => {
    const g = listGroup(a, devices);
    const label = spacedTitle(a);
    const showMachine = machines.length > 1 && a.deviceId !== primaryMachineId;
    const machineName = showMachine ? devices[a.deviceId]?.name : undefined;
    const isFocusedAgent = a.key === activeAgentKey;
    const isInSplit = !isFocusedAgent && activeSplitAgentKeys.has(a.key);
    return (
      <div
        key={a.key}
        role="button"
        tabIndex={0}
        draggable
        data-tauri-drag-region="false"
        className={`v3-row v3-agent${isFocusedAgent ? " selected" : isInSplit ? " in-split" : ""}${g === "offline" ? " dim" : ""}`}
        title={collapsed ? (machineName ? `${machineName} · ${label}` : label) : undefined}
        onDragStart={(e) => startPanelDrag(e, { kind: "agent", agentKey: a.key })}
        onDragEnd={() => endPanelDrag()}
        onClick={(e) => {
          if (e.altKey) {
            splitActivePaneWithContent(e.shiftKey ? "down" : "right", {
              kind: "agent",
              agentKey: a.key,
              ...(a.isShell ? { mode: "term" } : {}),
            });
            return;
          }
          openAgentTab(a.key);
        }}
        onContextMenu={(e) => {
          if (collapsed) return;
          e.preventDefault();
          setAgentMenu({ x: e.clientX, y: e.clientY, agent: a });
        }}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openAgentTab(a.key))}
      >
        <VendorIcon harness={a.harness} isShell={a.isShell} size={16} />
        {collapsed ? (
          g === "blocked" ? <span className="v3-corner blocked" aria-label="需要你" /> : null
        ) : (
          <>
            <span className="v3-row-label truncate">{label}</span>
            {machineName ? <span className="v3-agent-machine truncate">{machineName}</span> : null}
            <span className="v3-time">{shortAgo(lastChange(a), now)}</span>
            <StatusMark group={g} compact={sort === "status" && g === "blocked"} />
          </>
        )}
      </div>
    );
  };

  const sidebarWidth = settingsStore.use((s) => s.sidebarWidth);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);

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
            const startX = e.clientX;
            const startW = el.getBoundingClientRect().width || sidebarWidth;
            let curW = clampSidebarWidth(startW);
            let rafId = 0;
            setSidebarResizing(true);
            setInteractiveResizeActive(true);
            document.documentElement.dataset.splitResizing = "row";
            e.currentTarget.setPointerCapture(e.pointerId);

            const apply = () => {
              rafId = 0;
              el.style.setProperty("--v3-sidebar-w", `${curW}px`);
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
        {collapsed && canToggle ? null : (
          <button className="v3-icon-btn has-hint" aria-label="跳到 Agent 或标签" title={`跳到 Agent 或标签（${shortcutText("jumpAgent")}）`} onClick={() => setPalette("jump")}>
            <Search size={15} />
            <SpatialHint text={shortcutText("jumpAgent")} corner="bottom" />
          </button>
        )}
        {canToggle ? (
          <button className="v3-icon-btn has-hint" aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={`${collapsed ? "展开" : "收起"}侧栏（${shortcutText("toggleSidebar")}）`} onClick={onToggle}>
            <PanelLeft size={15} />
            <SpatialHint text={shortcutText("toggleSidebar")} corner="bottom" />
          </button>
        ) : null}
      </div>

      <div className="v3-lists">
        <section className="v3-block" aria-label="空间">
          {collapsed ? null : (
            <div className="v3-block-head">
              <span className="grow">空间</span>
              <button className="v3-icon-btn small has-hint" aria-label="新建空间" title={`新建空间（${shortcutText("newSpace")}）`} onClick={() => onNewSpace(null)}>
                <Plus size={14} />
                <SpatialHint text={shortcutText("newSpace")} corner="tr" />
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
                        const label = s.name;
                        return (
                          <div
                            key={s.id}
                            role="button"
                            tabIndex={0}
                            aria-pressed={selected === s.id}
                            className={`v3-row v3-space${s.count === 0 ? " empty" : ""}${selected === s.id ? " selected" : ""}`}
                            title={collapsed ? `${m.name} · ${label}` : s.folder || undefined}
                            onClick={() => setSpaceSel(s.id)}
                            onContextMenu={(e) => {
                              if (!m.online || collapsed) return;
                              e.preventDefault();
                              setAgentMenu(null);
                              setSpaceMenu({ x: e.clientX, y: e.clientY, space: s });
                            }}
                            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setSpaceSel(s.id))}
                          >
                            <SpaceTileIcon
                              spaceKey={s.id}
                              name={label}
                              folder={s.folder}
                              isWorktree={s.isWorktree}
                              color={s.color}
                              selected={selected === s.id}
                              blocked={s.blocked > 0}
                              size="sm"
                            />
                            {collapsed ? null : (
                              <>
                                <span className="v3-row-label truncate">{label}</span>
                                {m.online ? (
                                  <>
                                    <button
                                      type="button"
                                      className="v3-icon-btn small hover-only"
                                      aria-label={`在空间 ${label} 新建终端`}
                                      title={`在空间 ${label} 新建终端`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onNewTerminal(m.id, s.name);
                                      }}
                                    >
                                      <Plus size={12} />
                                    </button>
                                    <button
                                      type="button"
                                      className="v3-icon-btn small hover-only danger"
                                      aria-label={`关闭空间 ${label}`}
                                      title={`关闭空间 ${label}`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setDeleteSpaceTarget(s);
                                      }}
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </>
                                ) : null}
                                <span className="v3-count">{s.count}</span>
                                {s.count === 0 ? (
                                  <span className="v3-ring" aria-label="暂无运行中 Agent" />
                                ) : s.blocked ? (
                                  <span className="v3-need">需要你</span>
                                ) : (
                                  <StatusMark group={s.best} />
                                )}
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

        <section
          className="v3-block"
          aria-label="Agent"
          onPointerEnter={() => setHoverFreeze(true)}
          onPointerLeave={() => setHoverFreeze(false)}
        >
          {collapsed ? null : (
            <div className="v3-block-head">
              <span className="grow">Agent</span>
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
}
