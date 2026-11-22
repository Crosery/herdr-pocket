import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, ExternalLink, EyeOff, File, FileText, FolderOpen, FolderTree, GitBranch, Globe, Laptop, Layers, MessageSquare, Plus, Sparkles, SquareArrowOutUpRight, Terminal, X } from "lucide-react";
import type { Agent, ConvEvent, SubSession } from "@herdr-pocket/protocol";
import { PocketButton, PocketModal, overlayStore, useToast } from "../components/PocketUI";
import { ChatTimelineRows } from "../components/ChatTimeline";
import { DiffTabView, GitPanel } from "../components/GitPanel";
import { XiaoyangOrb, VendorIcon, mascotAssetPath, resolveCallMascotMood } from "../components/MascotAndVendor";
import { serverLabel } from "../components/Sidebar";
import { SubagentCatalogTrigger, SubagentHeaderLineage, SubagentReadOnlyBar, subLabel } from "../components/SubagentNav";
import { prettyHotkey } from "../components/VoiceInput";
import { AgentDetailPanel, type SubagentHeadInfo } from "../views/AgentsView";
import { FileTree, FileViewer, WebPane, type FileViewerHeadState } from "../views/WorkbenchView";
import { assistantStore, loadAssistant } from "../lib/assistant";
import { assetUrl, copyToClipboard, detectPlatform } from "../lib/bridge";
import { restoreUpdatePrompt, updateStore } from "../lib/updates";
import { foldConvEvents, mergeConvEvents } from "../lib/chatFold";
import { useClientConfig } from "../lib/config";
import { endPanelDrag, endTabDrag, endWorkspaceDrag, hasPanelDrag, hasTabDrag, hasWorkspaceDrag, readPanelDrag, readTabDrag, readWorkspaceDrag, startPanelDrag, startTabDrag } from "../lib/fileDrag";
import { useLocalHostDeviceId } from "../lib/fonts";
import { canActOnLocalFile, revealInFolderLabel, revealInFolderShortLabel, revealLocalFile } from "../lib/localFileActions";
import { isMockServer } from "../lib/mock";
import { native } from "../lib/native";
import { openAgentFileTarget } from "../lib/openFileTarget";
import { pingRelay, refreshHostSpaces, rpcCall, subscribeStream } from "../lib/relay";
import { agentSpace, agentTitle, allAgents, createStore, findAgent, liveStore, settingsStore, spacedTitle } from "../lib/store";
import { dismissVoiceMessage, hangupVoiceCall, startVoiceCall, voiceCallStore } from "../lib/voiceCall";
import { homeFolder, listGroup } from "./agentInfo";
import { StatusMark } from "./ShellSidebar";
import {
  activeTabIdForSpace,
  closeTab,
  moveTab,
  moveTabRelative,
  openAgentTab,
  openFileTab,
  openSettingsFrame,
  openSubagentAside,
  openWebTab,
  setActiveTab,
  setAgentTabMode,
  setPalette,
  setPanelWidth,
  setPeek,
  setSelectedSpace,
  shellStore,
  showPanel,
  togglePanel,
  updateWebTab,
  visibleTabsForSpace,
  type AgentPaneMode,
  type AgentTab,
  type DiffTab,
  type FileTab,
  type PanelId,
  type ShellTab,
} from "./shellStore";
import { comboText, shortcutText, SHORTCUTS } from "./shortcuts";
import "../styles/btw-slash.css";

const AssistantView = lazy(() => import("../views/AssistantView").then((m) => ({ default: m.AssistantView })));

function useAgent(key: string | null | undefined): Agent | undefined {
  return liveStore.use((s) => (key ? allAgents(s.agents).find((a) => a.key === key) : undefined));
}

/** Closes a tab in the UI only; a web tab's native view goes with it. */
export function closeShellTab(tab: ShellTab): void {
  if (tab.kind === "web") void native.browserClose(tab.id);
  closeTab(tab.id);
}

type CloseConfirmState = {
  tabs: ShellTab[];
  busyAgents: Agent[];
} | null;

const closeConfirmStore = createStore<CloseConfirmState>(null);
let reportCloseError: (message: string) => void = () => {};

function isLiveTerminalAgent(agent: Agent | undefined): agent is Agent {
  return Boolean(agent && (agent.source === "hc" || agent.source === "herdr"));
}

function isBusyAgent(agent: Agent): boolean {
  return agent.status === "working" || agent.status === "blocked";
}

function removeAgentFromLiveStore(agent: Agent): void {
  liveStore.set((prev) => {
    const list = prev.agents[agent.deviceId];
    if (!list || !list.some((a) => a.key === agent.key)) return prev;
    return {
      ...prev,
      agents: {
        ...prev.agents,
        [agent.deviceId]: list.filter((a) => a.key !== agent.key),
      },
      rev: prev.rev + 1,
    };
  });
}

function restoreAgentToLiveStore(agent: Agent): void {
  liveStore.set((prev) => {
    const list = prev.agents[agent.deviceId] ?? [];
    if (list.some((a) => a.key === agent.key)) return prev;
    return {
      ...prev,
      agents: {
        ...prev.agents,
        [agent.deviceId]: [agent, ...list],
      },
      rev: prev.rev + 1,
    };
  });
}

function clearAgentOverlays(agentKey: string): void {
  const s = shellStore.get();
  if (s.peek === agentKey) setPeek(null);
  if (s.subagentAside?.agentKey === agentKey) {
    shellStore.set({
      subagentAside: null,
      ...(s.panel === "subagent" ? { panel: null } : {}),
    });
  }
}

function executeCloseTabs(tabs: ShellTab[], mode: "hideOnly" | "killLive"): void {
  const killedKeys = new Set<string>();
  const devicesToRefresh = new Set<string>();
  for (const tab of tabs) {
    const agent = mode === "killLive" && tab.kind === "agent" ? findAgent(tab.agentKey) : undefined;
    closeShellTab(tab);
    if (!isLiveTerminalAgent(agent) || killedKeys.has(agent.key)) continue;
    killedKeys.add(agent.key);
    removeAgentFromLiveStore(agent);
    clearAgentOverlays(agent.key);
    void rpcCall(agent.deviceId, "terminal.kill", { agent: agent.key })
      .then(() => {
        if (!devicesToRefresh.has(agent.deviceId)) {
          devicesToRefresh.add(agent.deviceId);
          refreshHostSpaces(agent.deviceId);
        }
      })
      .catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        if (code === "not_found") {
          refreshHostSpaces(agent.deviceId);
          return;
        }
        restoreAgentToLiveStore(agent);
        reportCloseError((err as Error)?.message || "关闭终端失败");
      });
  }
}

/**
 * Closes multiple tabs with Herdr App parity:
 * - File/diff/web/missing/`uniflo` tabs close in UI immediately.
 * - Idle/done live agents close UI + optimistically leave sidebar + kill backend tab/terminal.
 * - Any `working`/`blocked` live agent triggers the confirmation modal (`取消` / `仅收起标签` / `关闭并结束`).
 */
export function requestCloseShellTabs(tabs: ShellTab[]): void {
  if (!tabs.length) return;
  const busyAgents: Agent[] = [];
  const seenBusy = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind !== "agent") continue;
    const agent = findAgent(tab.agentKey);
    if (isLiveTerminalAgent(agent) && isBusyAgent(agent) && !seenBusy.has(agent.key)) {
      seenBusy.add(agent.key);
      busyAgents.push(agent);
    }
  }
  if (busyAgents.length > 0) {
    closeConfirmStore.set({ tabs, busyAgents });
    return;
  }
  executeCloseTabs(tabs, "killLive");
}

/** Closes one tab with Herdr App parity (idle/done live agents kill tab & terminal; running/blocked prompt first). */
export function requestCloseShellTab(tab: ShellTab): void {
  requestCloseShellTabs([tab]);
}

function clipModalTitleName(name: string, max = 48): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

function TabCloseConfirmModal() {
  const confirm = closeConfirmStore.use((s) => s);
  if (!confirm) return null;
  const singleBusy = confirm.tabs.length === 1 && confirm.busyAgents.length === 1 ? confirm.busyAgents[0] : null;
  let title: string;
  let subtitle: string;
  if (singleBusy) {
    title = `关闭正在运行的标签「${clipModalTitleName(agentTitle(singleBusy))}」？`;
    subtitle =
      singleBusy.status === "blocked"
        ? "该 Agent 正在等待你的回复或确认。你可以仅收起标签让它在后台继续，或直接关闭并结束终端进程。"
        : "该 Agent 正在运行中。你可以仅收起标签让它在后台继续，或直接关闭并结束终端进程。";
  } else if (confirm.busyAgents.length === 1) {
    title = `关闭正在运行的标签「${clipModalTitleName(agentTitle(confirm.busyAgents[0]!), 32)}」及其他 ${confirm.tabs.length - 1} 个标签？`;
    subtitle = "其中有 1 个 Agent 正在运行或等待回复：选择「仅收起标签」会保留进程在后台继续，选择「关闭并结束」将终止终端进程。";
  } else {
    title = `关闭 ${confirm.tabs.length} 个标签（含 ${confirm.busyAgents.length} 个运行中）？`;
    subtitle = `其中 ${confirm.busyAgents.length} 个 Agent 正在运行或等待回复：选择「仅收起标签」会保留进程在后台继续，选择「关闭并结束」将终止终端进程。`;
  }

  return (
    <PocketModal
      open
      onOpenChange={(open) => {
        if (!open) closeConfirmStore.set(null);
      }}
      title={title}
      subtitle={subtitle}
      width={460}
    >
      <div className="row wrap" style={{ justifyContent: "flex-end", gap: 8 }}>
        <PocketButton variant="ghost" onClick={() => closeConfirmStore.set(null)}>
          取消
        </PocketButton>
        <PocketButton
          variant="soft"
          onClick={() => {
            const pending = closeConfirmStore.get();
            closeConfirmStore.set(null);
            if (pending) executeCloseTabs(pending.tabs, "hideOnly");
          }}
        >
          仅收起标签
        </PocketButton>
        <PocketButton
          variant="danger"
          onClick={() => {
            const pending = closeConfirmStore.get();
            closeConfirmStore.set(null);
            if (pending) executeCloseTabs(pending.tabs, "killLive");
          }}
        >
          关闭并结束
        </PocketButton>
      </div>
    </PocketModal>
  );
}

// Tabs bar ---------------------------------------------------------------------

function TabChip({
  tab,
  index,
  total,
  active,
  draggingId,
  dropTarget,
  setTabRef,
  onDragStartTab,
  onDragEndTab,
  onDragOverTab,
  onDropTab,
  onMenu,
}: {
  tab: ShellTab;
  index: number;
  total: number;
  active: boolean;
  draggingId: string | null;
  dropTarget: { id: string; side: "before" | "after" } | null;
  setTabRef: (el: HTMLDivElement | null) => void;
  onDragStartTab: (e: ReactDragEvent<HTMLDivElement>, id: string) => void;
  onDragEndTab: () => void;
  onDragOverTab: (e: ReactDragEvent<HTMLDivElement>, id: string) => void;
  onDropTab: (e: ReactDragEvent<HTMLDivElement>, index: number) => void;
  onMenu: (e: ReactMouseEvent, tab: ShellTab) => void;
}) {
  const agent = useAgent(tab.kind === "agent" ? tab.agentKey : null);
  const devices = liveStore.use((s) => s.devices);
  const group = agent ? listGroup(agent, devices) : null;
  const title =
    tab.kind === "agent" ? (agent ? agentTitle(agent) : "已结束的 Agent") : tab.title === "about:blank" ? "新网页" : tab.title;
  const side = dropTarget?.id === tab.id ? dropTarget.side : null;
  return (
    <div
      ref={setTabRef}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable={total > 1}
      data-tauri-drag-region="false"
      className={`v3-tab${active ? " active" : ""}${tab.kind === "agent" && !agent ? " gone" : ""}${draggingId === tab.id ? " dragging" : ""}${side ? ` drop-${side}` : ""}`}
      title={
        tab.kind === "agent"
          ? agent
            ? spacedTitle(agent)
            : title
          : tab.kind === "file"
            ? tab.path
            : tab.kind === "diff"
              ? `${tab.path} (${tab.staged ? "已暂存" : "工作区"})`
              : tab.url
      }
      onClick={() => setActiveTab(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          requestCloseShellTab(tab);
        }
      }}
      onContextMenu={(e) => onMenu(e, tab)}
      onDragStart={(e) => onDragStartTab(e, tab.id)}
      onDragEnd={onDragEndTab}
      onDragOver={(e) => onDragOverTab(e, tab.id)}
      onDrop={(e) => onDropTab(e, index)}
    >
      {tab.kind === "agent" ? (
        agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : <File size={14} />
      ) : tab.kind === "file" ? (
        <FileText size={14} />
      ) : tab.kind === "diff" ? (
        <GitBranch size={14} />
      ) : (
        <Globe size={14} />
      )}
      <span className="v3-tab-label truncate">{title}</span>
      {group === "working" ? <span className="v3-spinner small" aria-label="运行中" /> : null}
      {group === "blocked" ? <span className="v3-dot blocked" aria-label="需要你" /> : null}
      {group === "done" ? <span className="v3-dot done" aria-label="已完成" /> : null}
      <button
        className="v3-tab-x"
        aria-label={`关闭 ${title}`}
        title={`关闭（${shortcutText("closeTab")}）`}
        onClick={(e) => {
          e.stopPropagation();
          requestCloseShellTab(tab);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function Popup({ x, y, onClose, children, width = 220 }: { x: number; y: number; onClose: () => void; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    const off = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
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
  }, [onClose]);
  return (
    <div
      className="ctx-menu v3-popup"
      role="menu"
      // Menus open inside the tabs bar, which is a drag region: a press on a menu's padding must not move the window.
      data-tauri-drag-region="false"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.min(y, window.innerHeight - 200), width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function MenuItem({ label, keys, icon: Icon, onClick, disabled }: { label: string; keys?: string; icon?: typeof Plus; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="menu-item v3-menu-item" role="menuitem" disabled={disabled} onClick={onClick}>
      {Icon ? <Icon size={14} /> : null}
      <span className="grow">{label}</span>
      {keys ? <span className="v3-keys-text">{keys}</span> : null}
    </button>
  );
}

export function ShellTabs({ onNewTerminal, onNewAgent, padForLights }: { onNewTerminal: () => void; onNewAgent: () => void; padForLights: boolean }) {
  const toast = useToast();
  const tabs = shellStore.use((s) => s.tabs);
  const rawActive = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const activeBySpace = shellStore.use((s) => s.activeBySpace);
  const panel = shellStore.use((s) => s.panel);
  const agentsMap = liveStore.use((s) => s.agents);
  const homePage = useClientConfig().browser.homePage;
  const [menu, setMenu] = useState<{ x: number; y: number; tab: ShellTab } | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const [fileDropOver, setFileDropOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabElsRef = useRef(new Map<string, HTMLDivElement>());
  const prevRectsRef = useRef(new Map<string, number>());

  const agentByKey = useMemo(() => new Map(allAgents(agentsMap).map((a) => [a.key, a] as const)), [agentsMap]);
  const lookupAgent = useCallback((k: string) => agentByKey.get(k), [agentByKey]);
  const visibleTabs = useMemo(
    () => visibleTabsForSpace(tabs, selectedSpace, lookupAgent),
    [lookupAgent, selectedSpace, tabs],
  );
  const active = useMemo(
    () => activeTabIdForSpace({ tabs, active: rawActive, selectedSpace, activeBySpace }, lookupAgent),
    [activeBySpace, lookupAgent, rawActive, selectedSpace, tabs],
  );
  const selSpaceLabel = useMemo(() => {
    if (!selectedSpace) return null;
    const [, sp] = selectedSpace.split("\u0000");
    return sp || "未分空间";
  }, [selectedSpace]);

  // Keep the active chip in view, as Herdr does.
  useEffect(() => {
    scrollRef.current?.querySelector<HTMLElement>(".v3-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, visibleTabs.length]);

  useEffect(() => {
    reportCloseError = (msg) => toast(msg, true);
    return () => {
      reportCloseError = () => {};
    };
  }, [toast]);

  // Smooth FLIP slide animation whenever visible tabs reorder or insert.
  useLayoutEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nextRects = new Map<string, number>();
    for (const t of visibleTabs) {
      const el = tabElsRef.current.get(t.id);
      if (el) nextRects.set(t.id, el.getBoundingClientRect().left);
    }
    if (!reduced && prevRectsRef.current.size > 0) {
      for (const t of visibleTabs) {
        const el = tabElsRef.current.get(t.id);
        const prevLeft = prevRectsRef.current.get(t.id);
        const nextLeft = nextRects.get(t.id);
        if (!el || prevLeft === undefined || nextLeft === undefined) continue;
        const dx = prevLeft - nextLeft;
        if (Math.abs(dx) < 1) continue;
        el.style.transition = "none";
        el.style.transform = `translateX(${dx}px)`;
        el.getBoundingClientRect();
        requestAnimationFrame(() => {
          el.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
          el.style.transform = "";
        });
      }
    }
    prevRectsRef.current = nextRects;
  }, [visibleTabs]);

  const panelBtn = (id: PanelId, label: string, Icon: typeof Plus, keys?: string) => (
    <button
      className={`v3-panel-btn${panel === id ? " on" : ""}`}
      aria-pressed={panel === id}
      title={keys ? `${label}（${keys}）` : label}
      onClick={() => togglePanel(id)}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );

  const onDragStartTab = (e: ReactDragEvent<HTMLDivElement>, id: string) => {
    setDraggingId(id);
    startTabDrag(e, id);
  };

  const onDragEndTab = () => {
    setDraggingId(null);
    setDropTarget(null);
    endTabDrag();
  };

  const onDragOverTab = (e: ReactDragEvent<HTMLDivElement>, id: string) => {
    if (hasWorkspaceDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setFileDropOver(true);
      return;
    }
    if (!hasTabDrag(e) && !hasPanelDrag(e)) return;
    if (id === draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const side: "before" | "after" = e.clientX - rect.left < rect.width / 2 ? "before" : "after";
    setDropTarget((prev) => (prev?.id === id && prev.side === side ? prev : { id, side }));
  };

  const handleDropAt = (e: ReactDragEvent<HTMLDivElement>, targetTabId?: string, side?: "before" | "after") => {
    setFileDropOver(false);
    const wsItem = readWorkspaceDrag(e);
    if (wsItem) {
      e.preventDefault();
      e.stopPropagation();
      endWorkspaceDrag();
      if (wsItem.kind === "file") {
        openFileTab(wsItem.agentKey, wsItem.relPath, wsItem.name, { absPath: wsItem.absPath, spaceKey: selectedSpace });
      } else {
        toast("拖入文件可直接打开标签，文件夹请拖入对话输入框引用");
      }
      return;
    }

    const panelItem = readPanelDrag(e);
    if (panelItem) {
      e.preventDefault();
      e.stopPropagation();
      endPanelDrag();
      setDropTarget(null);
      let insertBeforeId: string | undefined;
      if (targetTabId && side) {
        const idx = tabs.findIndex((t) => t.id === targetTabId);
        if (idx >= 0) {
          insertBeforeId = side === "before" ? targetTabId : tabs[idx + 1]?.id;
        }
      }
      if (panelItem.kind === "browser") {
        openWebTab(panelItem.url, panelItem.title, {
          spaceKey: panelItem.spaceKey ?? selectedSpace,
          insertBeforeId,
        });
        if (shellStore.get().panel === "browser") showPanel(null);
      } else if (panelItem.kind === "agent") {
        openAgentTab(panelItem.agentKey);
        if (targetTabId && side) {
          moveTabRelative(`a:${panelItem.agentKey}`, targetTabId, side);
        }
      }
      return;
    }

    const fromId = readTabDrag(e) ?? draggingId;
    if (!fromId) return;
    e.preventDefault();
    e.stopPropagation();
    if (targetTabId && side) {
      moveTabRelative(fromId, targetTabId, side);
    } else if (visibleTabs.length > 0) {
      moveTabRelative(fromId, visibleTabs[visibleTabs.length - 1]!.id, "after");
    } else {
      moveTab(fromId, tabs.length - 1);
    }
    onDragEndTab();
  };

  const onDropTab = (e: ReactDragEvent<HTMLDivElement>, targetIdx: number) => {
    const target = visibleTabs[targetIdx];
    const side = target && dropTarget?.id === target.id ? dropTarget.side : "before";
    handleDropAt(e, target?.id, side);
  };

  const openPickedLocalFile = async () => {
    const path = await native.pickFile();
    if (!path) return;
    const title = path.split(/[\\/]/).pop() || path;
    openFileTab("local", path, title, { absPath: path, spaceKey: selectedSpace });
  };

  return (
    <div
      className={`v3-tabs${padForLights ? " lights" : ""}${fileDropOver ? " drop-over" : ""}`}
      data-tauri-drag-region="deep"
      onDragOver={(e) => {
        if (hasWorkspaceDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setFileDropOver(true);
        } else if (hasTabDrag(e) || hasPanelDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFileDropOver(false);
          setDropTarget(null);
        }
      }}
      onDrop={(e) => handleDropAt(e)}
    >
      {selSpaceLabel ? (
        <span className="v3-space-scope-chip" data-tauri-drag-region="false" title={`当前仅显示空间「${selSpaceLabel}」的标签页`}>
          <Layers size={11} />
          <span className="truncate">{selSpaceLabel}</span>
          <button
            type="button"
            className="v3-space-scope-x"
            aria-label="显示全部空间的标签"
            title="取消空间筛选，显示全部标签"
            onClick={() => setSelectedSpace(null, lookupAgent)}
          >
            <X size={10} />
          </button>
        </span>
      ) : null}
      <div
        ref={scrollRef}
        className="v3-tab-scroll"
        role="tablist"
        aria-label="标签"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {visibleTabs.map((t, i) => (
          <TabChip
            key={t.id}
            tab={t}
            index={i}
            total={visibleTabs.length}
            active={t.id === active}
            draggingId={draggingId}
            dropTarget={dropTarget}
            setTabRef={(el) => {
              if (el) tabElsRef.current.set(t.id, el);
              else tabElsRef.current.delete(t.id);
            }}
            onDragStartTab={onDragStartTab}
            onDragEndTab={onDragEndTab}
            onDragOverTab={onDragOverTab}
            onDropTab={onDropTab}
            onMenu={(e, tab) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, tab }))}
          />
        ))}
      </div>
      <button
        className="v3-icon-btn"
        aria-label="新建"
        title="新建终端、Agent、网页或文件"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setNewMenu(newMenu ? null : { x: r.left, y: r.bottom + 4 });
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Plus size={16} />
      </button>
      <div className="v3-tabs-right">
        {panelBtn("files", "文件", FolderTree, shortcutText("togglePanel"))}
        {panelBtn("git", "Git", GitBranch, shortcutText("toggleGit"))}
        {panelBtn("browser", "浏览器", Globe)}
        {panelBtn("assistant", "小羊", Sparkles, shortcutText("assistant"))}
      </div>

      {newMenu ? (
        <Popup x={newMenu.x} y={newMenu.y} onClose={() => setNewMenu(null)}>
          <MenuItem label="新建终端" icon={Terminal} keys={shortcutText("newAgent")} onClick={() => (setNewMenu(null), onNewTerminal())} />
          <MenuItem label="新建 Agent…" icon={Plus} onClick={() => (setNewMenu(null), onNewAgent())} />
          <MenuItem label="打开网页" icon={Globe} onClick={() => (setNewMenu(null), openWebTab(homePage || "about:blank", undefined, { spaceKey: selectedSpace }))} />
          {native.available() ? (
            <MenuItem label="打开本地文件…" icon={FolderOpen} onClick={() => { setNewMenu(null); void openPickedLocalFile(); }} />
          ) : null}
          <MenuItem label="浏览工作区文件" icon={FolderTree} onClick={() => (setNewMenu(null), showPanel("files"))} />
        </Popup>
      ) : null}
      {menu ? (() => {
        const menuAgent = menu.tab.kind === "agent" ? agentByKey.get(menu.tab.agentKey) : undefined;
        const isLive = isLiveTerminalAgent(menuAgent);
        const idx = visibleTabs.findIndex((t) => t.id === menu.tab.id);
        const otherTabs = visibleTabs.filter((t) => t.id !== menu.tab.id);
        const rightTabs = idx >= 0 ? visibleTabs.slice(idx + 1) : [];
        return (
          <Popup x={menu.x} y={menu.y} onClose={() => setMenu(null)} width={isLive ? 220 : 196}>
            <MenuItem
              label={isLive ? "关闭并结束" : "关闭"}
              icon={X}
              keys={shortcutText("closeTab")}
              onClick={() => {
                const target = menu.tab;
                setMenu(null);
                requestCloseShellTab(target);
              }}
            />
            {isLive ? (
              <MenuItem
                label="仅从标签栏收起"
                icon={EyeOff}
                onClick={() => {
                  const target = menu.tab;
                  setMenu(null);
                  closeShellTab(target);
                }}
              />
            ) : null}
            {isLive ? <div className="menu-sep" /> : null}
            <MenuItem
              label="关闭其他"
              disabled={otherTabs.length === 0}
              onClick={() => {
                setMenu(null);
                requestCloseShellTabs(otherTabs);
              }}
            />
            <MenuItem
              label="关闭右侧"
              disabled={rightTabs.length === 0}
              onClick={() => {
                setMenu(null);
                requestCloseShellTabs(rightTabs);
              }}
            />
            {menu.tab.kind !== "agent" ? <div className="menu-sep" /> : null}
            {menu.tab.kind === "file" || menu.tab.kind === "diff" ? (
              <MenuItem
                label="复制路径"
                icon={Copy}
                onClick={() => (setMenu(null), void copyToClipboard((menu.tab as { path: string }).path).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok)))}
              />
            ) : null}
            {menu.tab.kind === "web" ? (
              <MenuItem
                label="复制网址"
                icon={Copy}
                onClick={() => (setMenu(null), void copyToClipboard((menu.tab as { url: string }).url).then((ok) => toast(ok ? "网址已复制" : "复制失败", !ok)))}
              />
            ) : null}
          </Popup>
        );
      })() : null}
      <TabCloseConfirmModal />
    </div>
  );
}

// Panes ----------------------------------------------------------------------------

function resolveAgentMode(tabMode: AgentPaneMode | undefined, agent: Agent | undefined): AgentPaneMode {
  return tabMode ?? (agent?.isShell ? "term" : "chat");
}

function ModeSwitchIcons({ mode, onModeChange }: { mode: AgentPaneMode; onModeChange: (m: AgentPaneMode) => void }) {
  return (
    <div className="v3-mode-switch" role="group" aria-label="视图模式">
      <button
        type="button"
        className={`v3-mode-btn${mode === "chat" ? " on" : ""}`}
        aria-pressed={mode === "chat"}
        aria-label="对话模式"
        title="对话模式"
        onClick={() => onModeChange("chat")}
      >
        <MessageSquare size={13} />
      </button>
      <button
        type="button"
        className={`v3-mode-btn${mode === "term" ? " on" : ""}`}
        aria-pressed={mode === "term"}
        aria-label="终端模式"
        title="终端模式"
        onClick={() => onModeChange("term")}
      >
        <Terminal size={13} />
      </button>
    </div>
  );
}

function PaneHead({
  tab,
  agent,
  mode,
  onModeChange,
  subHead,
  fileHead,
  onClose,
}: {
  tab: ShellTab;
  agent: Agent | undefined;
  mode?: AgentPaneMode;
  onModeChange?: (m: AgentPaneMode) => void;
  subHead?: SubagentHeadInfo | null;
  fileHead?: FileViewerHeadState | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const devices = liveStore.use((s) => s.devices);
  const localHostId = useLocalHostDeviceId();
  const group = agent ? listGroup(agent, devices) : null;
  const platform = detectPlatform();
  const revealLabel = revealInFolderLabel(platform);
  const revealShortLabel = revealInFolderShortLabel(platform);
  const canRevealLocal =
    tab.kind === "file" &&
    canActOnLocalFile({
      nativeAvailable: native.available(),
      agentDeviceId: agent?.deviceId,
      agentCwd: agent?.cwd,
      localHostId,
      path: tab.path,
      absPath: tab.absPath,
    });
  const handleReveal =
    tab.kind === "file"
      ? () => {
          void revealLocalFile({
            path: tab.path,
            absPath: tab.absPath,
            agentCwd: agent?.cwd,
          }).catch((e: Error) => toast(e.message || "打开所在目录失败", true));
        }
      : undefined;
  let icon: React.ReactNode;
  let name: string;
  let sub: string;
  let subTitle = "";
  if (tab.kind === "agent") {
    icon = agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : <File size={14} />;
    name = agent ? spacedTitle(agent) : "这个 Agent 已经结束了";
    sub = agent ? homeFolder(agent.cwd) || agent.where || "" : "";
    subTitle = sub;
  } else if (tab.kind === "file") {
    icon = <FileText size={14} />;
    name = tab.title;
    const normPath = tab.path.replace(/\\/g, "/");
    const slash = normPath.lastIndexOf("/");
    sub = slash > 0 ? normPath.slice(0, slash) : "";
    subTitle = tab.absPath || tab.path;
  } else if (tab.kind === "diff") {
    icon = <GitBranch size={14} />;
    name = tab.title;
    sub = tab.commit ? `提交 ${tab.commit.slice(0, 7)}` : tab.staged ? "暂存区变更" : "工作区变更";
    subTitle = tab.path;
  } else {
    icon = <Globe size={14} />;
    name = tab.title === "about:blank" ? "新网页" : tab.title;
    sub = tab.url === "about:blank" ? "" : tab.url;
    subTitle = sub;
  }
  const lineBadge =
    tab.kind === "file" && tab.line
      ? tab.endLine && tab.endLine !== tab.line
        ? `L${tab.line}–${tab.endLine}`
        : `L${tab.line}`
      : null;
  const sizeText =
    tab.kind === "file" && fileHead && fileHead.size !== null
      ? fileHead.size >= 1024
        ? `${Math.round(fileHead.size / 1024)} KB`
        : `${fileHead.size} B`
      : null;
  const inSubView = Boolean(tab.kind === "agent" && agent && subHead && subHead.trail.length > 0);
  const previewToggleable = Boolean(tab.kind === "file" && (fileHead?.canPreview || fileHead?.isMd));

  return (
    <div className="v3-pane-head">
      {icon}
      {inSubView && agent && subHead ? (
        <SubagentHeaderLineage
          mainTitle={name}
          trail={subHead.trail}
          rootSubs={subHead.rootSubs}
          activeSubs={subHead.activeSubs}
          deviceId={agent.deviceId}
          agentKey={agent.key}
          onGoRoot={subHead.onGoRoot}
          onSelectCrumbIndex={subHead.onSelectCrumbIndex}
          onSelectSub={subHead.onSelectSub}
          onOpenAside={subHead.onOpenAside}
        />
      ) : (
        <>
          <span className="v3-pane-name truncate" title={subTitle || name}>{name}</span>
          {canRevealLocal && sub ? (
            <button
              type="button"
              className="v3-pane-sub v3-pane-sub-btn truncate"
              title={`${revealLabel}（${subTitle}）`}
              onClick={handleReveal}
            >
              {sub}
            </button>
          ) : (
            <span className="v3-pane-sub truncate" title={subTitle}>{sub}</span>
          )}
        </>
      )}
      {lineBadge ? <span className="v3-pane-pill accent">{lineBadge}</span> : null}
      {sizeText ? <span className="v3-pane-pill num">{sizeText}</span> : null}
      {tab.kind === "agent" && agent && !inSubView && subHead && (subHead.knownCount > 0 || subHead.rootSubs.length > 0) ? (
        <SubagentCatalogTrigger
          compact
          deviceId={agent.deviceId}
          agentKey={agent.key}
          knownCount={subHead.knownCount}
          subs={subHead.rootSubs}
          onSelectSub={subHead.onSelectSub}
          onOpenAside={subHead.onOpenAside}
          onRefresh={subHead.onRefresh}
        />
      ) : null}
      {tab.kind === "agent" && group && group !== "idle" && group !== "offline" ? <StatusMark group={group} /> : null}
      {tab.kind === "agent" && group === "offline" ? <span className="v3-pane-off">电脑离线</span> : null}
      {tab.kind === "agent" && agent && mode && onModeChange ? <ModeSwitchIcons mode={mode} onModeChange={onModeChange} /> : null}
      {previewToggleable && fileHead ? (
        <div className="v3-mode-switch" role="group" aria-label="视图">
          <button
            type="button"
            className={`v3-mode-btn v3-pane-mode-text${fileHead.preview ? " on" : ""}`}
            aria-pressed={fileHead.preview}
            onClick={() => fileHead.setPreview(true)}
          >
            {fileHead.previewLabel || "预览"}
          </button>
          <button
            type="button"
            className={`v3-mode-btn v3-pane-mode-text${!fileHead.preview ? " on" : ""}`}
            aria-pressed={!fileHead.preview}
            onClick={() => fileHead.setPreview(false)}
          >
            源码
          </button>
        </div>
      ) : null}
      {canRevealLocal ? (
        <button
          type="button"
          className="v3-icon-btn small"
          aria-label={revealShortLabel}
          title={`${revealLabel}（${tab.absPath || tab.path}）`}
          onClick={handleReveal}
        >
          <FolderOpen size={13} />
        </button>
      ) : null}
      {tab.kind === "file" ? (
        <button
          className="v3-icon-btn small"
          aria-label="复制路径"
          title={`复制路径（${tab.absPath || tab.path}）`}
          onClick={() => {
            void copyToClipboard(tab.absPath || tab.path).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok));
          }}
        >
          <Copy size={13} />
        </button>
      ) : null}
      <button className="v3-icon-btn small" aria-label="关闭标签" title={`关闭标签（${shortcutText("closeTab")}）`} onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

function FilePane({ tab, agent }: { tab: FileTab; agent: Agent | undefined }) {
  const [fileHead, setFileHead] = useState<FileViewerHeadState | null>(null);
  return (
    <section className="v3-pane" aria-label={tab.title}>
      <PaneHead tab={tab} agent={agent} fileHead={fileHead} onClose={() => requestCloseShellTab(tab)} />
      <div className="v3-pane-body">
        <FileViewer key={tab.id} tab={tab} agent={agent} embedded onHeadState={setFileHead} />
      </div>
    </section>
  );
}

function DiffPane({ tab }: { tab: DiffTab }) {
  return (
    <section className="v3-pane" aria-label={tab.title}>
      <PaneHead tab={tab} agent={undefined} onClose={() => requestCloseShellTab(tab)} />
      <div className="v3-pane-body">
        <DiffTabView key={tab.id} tab={tab} />
      </div>
    </section>
  );
}

function AgentPane({ tab, agentKey }: { tab: AgentTab; agentKey: string }) {
  const agent = useAgent(agentKey);
  const mode = resolveAgentMode(tab.mode, agent);
  const [subHead, setSubHead] = useState<SubagentHeadInfo | null>(null);
  return (
    <section className="v3-pane" aria-label={agent ? spacedTitle(agent) : "Agent"}>
      <PaneHead
        tab={tab}
        agent={agent}
        mode={mode}
        subHead={subHead}
        onModeChange={(m) => setAgentTabMode(tab.id, m)}
        onClose={() => requestCloseShellTab(tab)}
      />
      <div className="v3-pane-body">
        {agent ? (
          <AgentDetailPanel
            key={agent.key}
            agent={agent}
            embedded
            mode={mode}
            onModeChange={(m) => setAgentTabMode(tab.id, m)}
            onSubHeadChange={setSubHead}
            onBack={() => closeShellTab(tab)}
            onOpenWorkbench={() => showPanel("files")}
          />
        ) : (
          <div className="v3-pane-empty">
            <p>这个 Agent 已经结束，或者它的电脑离线了。</p>
            <PocketButton size="sm" variant="soft" onClick={() => requestCloseShellTab(tab)}>
              关闭标签
            </PocketButton>
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyMain({ onNewTerminal, onNewAgent }: { onNewTerminal: () => void; onNewAgent: () => void }) {
  const homePage = useClientConfig().browser.homePage;
  const [dropOver, setDropOver] = useState(false);
  const rows: Array<{ label: string; keys?: string; run: () => void }> = [
    { label: "新建终端", keys: shortcutText("newAgent"), run: onNewTerminal },
    { label: "新建 Agent…", run: onNewAgent },
    { label: "打开网页", run: () => openWebTab(homePage || "about:blank") },
    { label: "命令面板", keys: shortcutText("palette"), run: () => setPalette("command") },
  ];
  return (
    <section
      className={`v3-pane v3-pane-blank${dropOver ? " drop-over" : ""}`}
      aria-label="没有打开的标签"
      onDragOver={(e) => {
        if (!hasWorkspaceDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={(e) => {
        setDropOver(false);
        const wsItem = readWorkspaceDrag(e);
        if (!wsItem) return;
        e.preventDefault();
        endWorkspaceDrag();
        if (wsItem.kind === "file") {
          openFileTab(wsItem.agentKey, wsItem.relPath, wsItem.name, { absPath: wsItem.absPath });
        }
      }}
    >
      <div className="v3-blank">
        <div className="v3-blank-mascot">
          <XiaoyangOrb mood="hello" size={72} />
        </div>
        <h2>没有打开的标签</h2>
        <p>在左边的 Agent 列表点一个，它会在这里以标签打开。</p>
        <div className="v3-blank-actions">
          {rows.map((r) => (
            <button key={r.label} className="v3-blank-row" onClick={r.run}>
              <span className="grow">{r.label}</span>
              {r.keys ? <span className="v3-keys-text">{r.keys}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ShellMain({ onNewTerminal, onNewAgent }: { onNewTerminal: () => void; onNewAgent: () => void }) {
  const tabs = shellStore.use((s) => s.tabs);
  const rawActive = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const activeBySpace = shellStore.use((s) => s.activeBySpace);
  const agentsMap = liveStore.use((s) => s.agents);
  const agentByKey = useMemo(() => new Map(allAgents(agentsMap).map((a) => [a.key, a] as const)), [agentsMap]);
  const lookupAgent = useCallback((k: string) => agentByKey.get(k), [agentByKey]);
  const activeId = useMemo(
    () => activeTabIdForSpace({ tabs, active: rawActive, selectedSpace, activeBySpace }, lookupAgent),
    [activeBySpace, lookupAgent, rawActive, selectedSpace, tabs],
  );
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const fileAgent = useAgent(active?.kind === "file" ? active.agentKey : null);

  return (
    <div className="v3-main">
      {!active ? <EmptyMain onNewTerminal={onNewTerminal} onNewAgent={onNewAgent} /> : null}
      {active?.kind === "agent" ? <AgentPane key={active.id} tab={active} agentKey={active.agentKey} /> : null}
      {active?.kind === "file" ? <FilePane key={active.id} tab={active} agent={fileAgent} /> : null}
      {active?.kind === "diff" ? <DiffPane key={active.id} tab={active} /> : null}
      {/* Web pages stay mounted so their native views keep their pages. */}
      {tabs.map((t) =>
        t.kind === "web" ? (
          <section key={t.id} className="v3-pane" aria-label={t.title} style={{ display: t.id === activeId ? undefined : "none" }}>
            <PaneHead tab={t} agent={undefined} onClose={() => requestCloseShellTab(t)} />
            <div className="v3-pane-body">
              <WebPane tab={t} active={t.id === activeId} onChange={(patch) => updateWebTab(t.id, patch)} />
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

// Side panel -----------------------------------------------------------------------

const PANEL_TITLE: Record<PanelId, string> = { files: "文件", git: "Git 管理", browser: "浏览器", assistant: "小羊", subagent: "子 Agent" };

/** Resolves the Space and backing Agent for the right-hand Files panel without any Agent dropdown. */
function useFilesTarget() {
  const tabs = shellStore.use((s) => s.tabs);
  const activeId = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const withFolder = useMemo(
    () => [...allAgents(agentsMap).filter((a) => a.cwd && !a.isShell), ...allAgents(agentsMap).filter((a) => a.cwd && a.isShell)],
    [agentsMap],
  );
  const all = useMemo(() => allAgents(agentsMap), [agentsMap]);
  const active = tabs.find((t) => t.id === activeId);
  const tabAgentKey = active?.kind === "agent" || active?.kind === "file" ? active.agentKey : null;
  const lastKeyRef = useRef<string | null>(null);

  const spaceExists = useMemo(() => {
    if (!selectedSpace) return false;
    const [devId, spName] = selectedSpace.split("\u0000");
    return all.some((a) => a.deviceId === devId && (agentSpace(a) ?? "") === (spName ?? ""));
  }, [all, selectedSpace]);

  const resolved = useMemo(() => {
    if (selectedSpace && spaceExists) {
      const [devId, spName] = selectedSpace.split("\u0000") as [string, string];
      const matches = withFolder.filter((a) => a.deviceId === devId && (agentSpace(a) ?? "") === spName);
      const picked =
        (tabAgentKey ? matches.find((a) => a.key === tabAgentKey) : undefined) ??
        matches.find((a) => devices[a.deviceId]?.online) ??
        matches[0];
      return {
        agent: picked,
        spaceName: spName || "未分空间",
        fromSelectedSpace: true,
      };
    }
    const fromTab = tabAgentKey ? withFolder.find((a) => a.key === tabAgentKey) : undefined;
    const fromLast = !tabAgentKey && lastKeyRef.current ? withFolder.find((a) => a.key === lastKeyRef.current) : undefined;
    const picked = fromTab ?? fromLast ?? withFolder[0];
    return {
      agent: picked,
      spaceName: picked ? (agentSpace(picked) || homeFolder(picked.cwd) || "") : "",
      fromSelectedSpace: false,
    };
  }, [devices, selectedSpace, spaceExists, tabAgentKey, withFolder]);

  useEffect(() => {
    if (resolved.agent) lastKeyRef.current = resolved.agent.key;
  }, [resolved.agent]);

  return resolved;
}

function useGitTarget() {
  const filesTarget = useFilesTarget();
  const tabs = shellStore.use((s) => s.tabs);
  const activeId = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const spacesMap = liveStore.use((s) => s.spaces);
  const devices = liveStore.use((s) => s.devices);
  const active = tabs.find((t) => t.id === activeId);

  return useMemo(() => {
    if (active?.kind === "diff") {
      return {
        deviceId: active.deviceId,
        agent: filesTarget.agent,
        cwd: active.cwd,
        spaceName: active.cwd.split(/[\\/]/).filter(Boolean).pop() || "",
        spaceKey: active.spaceKey ?? selectedSpace,
      };
    }
    if (selectedSpace) {
      const [devId, spName] = selectedSpace.split("\u0000") as [string, string];
      const spInfo = (spacesMap[devId] ?? []).find((s) => s.name === spName);
      if (filesTarget.fromSelectedSpace && filesTarget.agent?.cwd) {
        return {
          deviceId: filesTarget.agent.deviceId,
          agent: filesTarget.agent,
          cwd: filesTarget.agent.cwd,
          spaceName: spName || filesTarget.spaceName,
          spaceKey: selectedSpace,
        };
      }
      if (spInfo?.folder) {
        return {
          deviceId: devId,
          agent: undefined,
          cwd: spInfo.folder,
          spaceName: spInfo.name,
          spaceKey: selectedSpace,
        };
      }
    }
    if (filesTarget.agent?.cwd) {
      return {
        deviceId: filesTarget.agent.deviceId,
        agent: filesTarget.agent,
        cwd: filesTarget.agent.cwd,
        spaceName: filesTarget.spaceName,
        spaceKey: selectedSpace,
      };
    }
    for (const [devId, list] of Object.entries(spacesMap)) {
      if (devices[devId]?.online === false) continue;
      const hit = list.find((s) => s.folder);
      if (hit) {
        return {
          deviceId: devId,
          agent: undefined,
          cwd: hit.folder,
          spaceName: hit.name,
          spaceKey: `${devId}\u0000${hit.name}`,
        };
      }
    }
    return { deviceId: undefined, agent: undefined, cwd: undefined, spaceName: "", spaceKey: selectedSpace };
  }, [active, devices, filesTarget, selectedSpace, spacesMap]);
}

function FilesPanel({ agent, spaceName, fromSelectedSpace }: ReturnType<typeof useFilesTarget>) {
  if (!agent) {
    return (
      <div className="v3-empty-line">
        {fromSelectedSpace
          ? `「${spaceName}」还没有带工作目录的 Agent。在该空间打开一个 Agent 后，这里会显示它的文件。`
          : "还没有带工作目录的 Agent。开一个 Agent 后，这里会列出它的文件。"}
      </div>
    );
  }
  return (
    <div className="v3-files">
      <FileTree key={`${agent.deviceId}:${agent.cwd}`} agent={agent} onOpen={(path, name) => openFileTab(agent.key, path, name)} />
    </div>
  );
}

const PANEL_WEB_ID = "panel-web";

function BrowserPanel({
  url,
  onMetaChange,
}: {
  url: string;
  onMetaChange: (meta: { url: string; title: string }) => void;
}) {
  const homePage = useClientConfig().browser.homePage;
  const [title, setTitle] = useState(url);
  return (
    <div className="v3-panel-web">
      <WebPane
        tab={{ id: PANEL_WEB_ID, url: homePage || "about:blank" }}
        active
        onChange={(p) => {
          const nextUrl = p.url ?? url;
          const nextTitle = p.title ?? (p.url ? p.url : title);
          if (p.title) setTitle(p.title);
          onMetaChange({ url: nextUrl, title: nextTitle });
        }}
      />
      <button
        className="v3-mini-btn v3-panel-web-pop"
        onClick={() => {
          openWebTab(url, title || url);
          showPanel(null);
        }}
        title="在顶部标签页打开此网页，或直接拖动标题栏放入"
      >
        <SquareArrowOutUpRight size={12} />
        <span>放入标签栏</span>
      </button>
    </div>
  );
}

function SubagentAsidePanel() {
  const aside = shellStore.use((s) => s.subagentAside);
  const parentAgent = useAgent(aside?.agentKey);
  const chatDisplayMode = settingsStore.use((s) => s.chatDisplayMode);
  const [trail, setTrail] = useState<SubSession[]>(aside?.trail ?? []);
  const [events, setEvents] = useState<ConvEvent[]>([]);
  const [rootSubs, setRootSubs] = useState<SubSession[]>([]);
  const [childSubs, setChildSubs] = useState<SubSession[]>([]);

  useEffect(() => {
    setTrail(aside?.trail ?? (aside?.sub ? [aside.sub] : []));
  }, [aside]);

  const current = trail[trail.length - 1] ?? aside?.sub ?? null;

  useEffect(() => {
    if (!parentAgent || !aside) return;
    let alive = true;
    void rpcCall(parentAgent.deviceId, "session.children", { agent: aside.agentKey })
      .then((res) => {
        if (alive) setRootSubs(res.sessions);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [aside, parentAgent]);

  useEffect(() => {
    if (!parentAgent || !aside || !current) {
      setEvents([]);
      setChildSubs([]);
      return;
    }
    let alive = true;
    let live = false;
    setEvents([]);
    setChildSubs([]);

    void rpcCall(parentAgent.deviceId, "session.events", { agent: aside.agentKey, sub: current.key, limit: 200 })
      .then((res) => {
        if (alive) setEvents((prev) => mergeConvEvents(prev, res.events));
      })
      .catch(() => {});

    void rpcCall(parentAgent.deviceId, "session.children", { agent: aside.agentKey, sub: current.key })
      .then((res) => {
        if (alive) setChildSubs(res.sessions);
      })
      .catch(() => {});

    const unsub = subscribeStream(
      parentAgent.deviceId,
      "session",
      { agent: aside.agentKey, sub: current.key },
      (ev) => {
        if (!alive || !ev) return;
        if ((ev.kind === "session" || ev.kind === "session_event") && ev.event) {
          setEvents((prev) => mergeConvEvents(prev, [ev.event as ConvEvent]));
        }
      },
      (st) => {
        if (alive) live = st?.kind === "live";
      },
    );

    const timer = window.setInterval(() => {
      if (!alive || live) return;
      void rpcCall(parentAgent.deviceId, "session.events", { agent: aside.agentKey, sub: current.key, limit: 120 })
        .then((res) => {
          if (alive) setEvents((prev) => mergeConvEvents(prev, res.events));
        })
        .catch(() => {});
    }, 3_000);

    return () => {
      alive = false;
      window.clearInterval(timer);
      unsub();
    };
  }, [aside, current, parentAgent]);

  const foldedRows = useMemo(() => foldConvEvents(events, chatDisplayMode), [chatDisplayMode, events]);

  if (!aside || !parentAgent || !current) {
    return <div className="v3-empty-line">从对话里的子 Agent 树或工具卡片右上角点开后，可在这里并排查看运行记录。</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="sub-aside-bar">
        <SubagentHeaderLineage
          mainTitle={spacedTitle(parentAgent)}
          trail={trail}
          rootSubs={rootSubs}
          activeSubs={childSubs}
          deviceId={parentAgent.deviceId}
          agentKey={aside.agentKey}
          onGoRoot={() => {
            openAgentTab(aside.agentKey, "chat");
            showPanel(null);
          }}
          onSelectCrumbIndex={(idx) => setTrail((prev) => prev.slice(0, idx + 1))}
          onSelectSub={(s, anc) => setTrail([...anc, s])}
          onOpenAside={(s, anc) => setTrail([...anc, s])}
        />
      </div>
      <div className="chat-scroll agent-chat" style={{ flex: 1, minHeight: 0 }}>
        {foldedRows.length === 0 ? (
          <div className="v3-empty-line">正在同步子 Agent「{subLabel(current)}」的对白与工具步骤…</div>
        ) : (
          <ChatTimelineRows
            rows={foldedRows}
            subs={childSubs}
            agentKey={parentAgent.key}
            deviceId={parentAgent.deviceId}
            cwd={parentAgent.cwd}
            onOpenSub={(s) => setTrail((prev) => [...prev, s])}
            onOpenSubAside={(s) => setTrail((prev) => [...prev, s])}
            onOpenFile={(target) => {
              openAgentFileTarget(parentAgent, target);
            }}
          />
        )}
      </div>
      <SubagentReadOnlyBar
        current={current}
        inSidebar
        onBackMain={() => {
          openAgentTab(aside.agentKey, "chat");
          showPanel(null);
        }}
      />
    </div>
  );
}

export function ShellPanel() {
  const panel = shellStore.use((s) => s.panel);
  const width = shellStore.use((s) => s.panelWidth);
  const aside = shellStore.use((s) => s.subagentAside);
  const homePage = useClientConfig().browser.homePage;
  const filesTarget = useFilesTarget();
  const gitTarget = useGitTarget();
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [browserMeta, setBrowserMeta] = useState<{ url: string; title: string }>({
    url: homePage || "about:blank",
    title: "浏览器",
  });

  // The browser panel's native view closes with the panel.
  useEffect(() => {
    if (panel !== "browser") void native.browserClose(PANEL_WEB_ID).catch(() => undefined);
  }, [panel]);

  if (!panel) return null;
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) setPanelWidth(drag.current.w + (drag.current.x - e.clientX));
  };
  const onUp = () => {
    drag.current = null;
  };
  const subTitleText =
    panel === "files" && filesTarget.spaceName
      ? filesTarget.spaceName
      : panel === "git" && gitTarget.spaceName
        ? gitTarget.spaceName
        : panel === "subagent" && aside
          ? subLabel(aside.sub)
          : panel === "browser"
            ? "可拖到顶部标签栏"
            : "";
  const showSub = Boolean(subTitleText);

  return (
    <aside className="v3-panel" style={{ width }} aria-label={PANEL_TITLE[panel]}>
      <div
        className="v3-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整面板宽度"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => setPanelWidth(368)}
      />
      <div
        className={`v3-pane-head${panel === "browser" ? " draggable" : ""}`}
        draggable={panel === "browser"}
        title={panel === "browser" ? "拖动标题栏到顶部标签栏，即可固定为标签页" : undefined}
        onDragStart={(e) => {
          if (panel !== "browser") return;
          startPanelDrag(e, {
            kind: "browser",
            url: browserMeta.url || homePage || "about:blank",
            title: browserMeta.title || browserMeta.url || "网页",
          });
        }}
        onDragEnd={() => endPanelDrag()}
      >
        {panel === "files" ? (
          <FolderTree size={14} />
        ) : panel === "git" ? (
          <GitBranch size={14} />
        ) : panel === "browser" ? (
          <Globe size={14} />
        ) : panel === "subagent" ? (
          <GitBranch size={14} />
        ) : (
          <Sparkles size={14} />
        )}
        <span className={`v3-pane-name${showSub ? "" : " grow"}`}>{PANEL_TITLE[panel]}</span>
        {showSub ? <span className="v3-pane-sub grow truncate" title={subTitleText}>{subTitleText}</span> : null}
        <button className="v3-icon-btn small" aria-label="关闭面板" onClick={() => showPanel(null)}>
          <X size={13} />
        </button>
      </div>
      <div className={`v3-pane-body v3-panel-body ${panel}`}>
        {panel === "files" ? <FilesPanel {...filesTarget} /> : null}
        {panel === "git" ? (
          <GitPanel
            deviceId={gitTarget.deviceId}
            agent={gitTarget.agent}
            initialCwd={gitTarget.cwd}
            spaceKey={gitTarget.spaceKey}
          />
        ) : null}
        {panel === "browser" ? <BrowserPanel url={browserMeta.url} onMetaChange={setBrowserMeta} /> : null}
        {panel === "subagent" ? <SubagentAsidePanel /> : null}
        {panel === "assistant" ? (
          <Suspense fallback={<div className="v3-empty-line">正在打开小羊…</div>}>
            <AssistantView onOpenAgent={openAgentTab} />
          </Suspense>
        ) : null}
      </div>
    </aside>
  );
}

// Status bar -----------------------------------------------------------------------

function UpdateStatusSegment() {
  const st = updateStore.use((s) => s);
  if (st.checking) {
    return (
      <span className="v3-status-item" title="正在检查新版本">
        <span className="v3-spinner small" aria-hidden />
        <span>检查更新…</span>
      </span>
    );
  }
  if (!st.info?.hasUpdate) return null;
  const busy =
    st.installPhase === "downloading" ||
    st.installPhase === "verifying" ||
    st.installPhase === "staging";
  const pct = st.progress?.percent;
  const label =
    st.installPhase === "ready"
      ? `v${st.info.latest} 已就绪 · 重启更新`
      : busy
        ? `更新中${pct !== null && pct !== undefined ? ` ${pct}%` : "…"}`
        : `新版本 v${st.info.latest}`;
  return (
    <button
      type="button"
      className="v3-status-item v3-status-btn update-pill"
      title={`查看更新 v${st.info.current} → v${st.info.latest}`}
      onClick={() => restoreUpdatePrompt()}
    >
      <span className={`v3-dot ${st.installPhase === "ready" ? "ok" : "warn"}`} />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function ShellStatus({ onConnectRelay }: { onConnectRelay: () => void }) {
  const toast = useToast();
  const link = liveStore.use((s) => s.link);
  const devices = liveStore.use((s) => s.devices);
  const agentsMap = liveStore.use((s) => s.agents);
  const server = settingsStore.use((s) => s.server);
  const showShells = settingsStore.use((s) => s.showShells);
  const activeTab = shellStore.use((s) => s.tabs.find((t) => t.id === s.active) ?? null);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const localHostId = useLocalHostDeviceId();
  const voice = useClientConfig().voiceInput;
  const callStatus = voiceCallStore.use((s) => s.status);
  const callAssistant = voiceCallStore.use((s) => s.assistant);
  const callMuted = voiceCallStore.use((s) => s.muted);
  const assistantVoice = assistantStore.use((s) => s.voice);
  const [voiceSetupHint, setVoiceSetupHint] = useState<string | null>(null);
  const realtimeReady = Boolean(assistantVoice || (server && isMockServer(server)));
  useEffect(() => {
    if (realtimeReady) setVoiceSetupHint(null);
  }, [realtimeReady]);
  const agent = useAgent(activeTab && activeTab.kind !== "web" ? (activeTab.agentKey ?? null) : null);

  const all = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);
  const blocked = all.filter((a) => listGroup(a, devices) === "blocked").length;
  const [selDevice, selSpace] = selectedSpace ? (selectedSpace.split("\u0000") as [string, string]) : [null, null];
  const validSpace = Boolean(selectedSpace && all.some((a) => a.deviceId === selDevice && (agentSpace(a) ?? "") === selSpace));
  const host = agent
    ? devices[agent.deviceId]
    : validSpace && selDevice
      ? devices[selDevice]
      : (localHostId && devices[localHostId]?.online ? devices[localHostId] : undefined) ?? Object.values(devices).find((d) => d.kind === "host" && d.online);
  const hostLabel = host ? (localHostId && host.id === localHostId ? `本机 · ${host.name}` : host.name) : "还没有电脑";
  const space = agent ? agentSpace(agent) : validSpace ? (selSpace || "未分空间") : undefined;
  const demo = isMockServer(server);

  const linkText = !server
    ? "未连接中转服务器"
    : link === "online"
      ? demo
        ? "演示模式"
        : `已连接 ${serverLabel(server)}`
      : link === "connecting"
        ? "正在连接…"
        : link === "unauthorized"
          ? "授权失效，点这里重新连接"
          : "已断开，点这里重连";
  const linkTone = link === "online" ? "ok" : link === "connecting" ? "warn" : "off";

  const liveCallActive = callStatus === "connecting" || callStatus === "ready";
  const callMood = resolveCallMascotMood({
    status: callStatus,
    assistant: callAssistant,
    muted: callMuted,
  });
  const voiceButtonLabel = liveCallActive
    ? "小羊通话中 · 点此挂断"
    : voice.enabled
      ? `快速说话 · ${prettyHotkey(voice.hotkey)}`
      : "快速说话";
  const voiceButtonTitle = liveCallActive
    ? "小羊实时语音通话中，点击挂断"
    : voice.enabled
      ? `点击唤起小羊实时语音通话（也可按全局快捷键 ${prettyHotkey(voice.hotkey)}）`
      : "点击唤起小羊实时语音通话";

  const handleVoiceTrigger = async () => {
    if (liveCallActive) {
      hangupVoiceCall();
      return;
    }
    if (!server) {
      setVoiceSetupHint("还没有连接中转服务器，连接并配置小羊实时语音模型后即可一键通话。");
      return;
    }
    if (!isMockServer(server) && !assistantStore.get().loaded) {
      await loadAssistant().catch(() => {});
    }
    const fresh = assistantStore.get();
    if (fresh.voice || isMockServer(server)) {
      setVoiceSetupHint(null);
      const err = await startVoiceCall({ showHud: true });
      if (err) {
        toast(err, true);
        dismissVoiceMessage();
      }
      return;
    }
    setVoiceSetupHint("中转服务器尚未配置小羊实时语音模型，请前往「设置 › 小羊助理」完成配置后即可一键通话。");
  };

  return (
    <footer className="v3-status">
      <span
        className="v3-status-item"
        title={
          host
            ? `${localHostId && host.id === localHostId ? "本机运行载体 · " : ""}${host.name} ${host.online ? "在线" : "离线"}`
            : undefined
        }
      >
        <Laptop size={13} />
        <span className="truncate">{hostLabel}</span>
      </span>
      {space ? (
        <span className="v3-status-item" title="空间">
          <Layers size={13} />
          <span className="truncate">{space}</span>
        </span>
      ) : null}
      <span className="v3-status-item">
        <span className="v3-dot dim" />
        <span className="truncate">{all.length} 个 Agent</span>
        {blocked ? <span className="v3-status-need truncate">· {blocked} 个需要你</span> : null}
      </span>
      <span className="grow" />
      <UpdateStatusSegment />
      <button
        className="v3-status-item v3-status-btn"
        onClick={() => (!server || link === "unauthorized" ? onConnectRelay() : link === "online" ? undefined : pingRelay())}
        title={link === "online" ? undefined : "点这里处理连接"}
      >
        <span className={`v3-dot ${linkTone}`} />
        <span className="truncate">{linkText}</span>
      </button>
      <div className="voice-wake-anchor">
        <button
          type="button"
          data-voice-trigger="true"
          className={`v3-status-item v3-status-btn${liveCallActive ? " on" : ""}`}
          title={voiceButtonTitle}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void handleVoiceTrigger()}
        >
          <img
            className={`status-xiaoyang-avatar${callMood === "muted" ? " is-muted" : ""}`}
            src={assetUrl(mascotAssetPath(callMood))}
            alt=""
          />
          <span className="truncate">{voiceButtonLabel}</span>
        </button>
        {voiceSetupHint ? (
          <div className="voice-wake-pop" role="dialog" aria-label="小羊语音尚未就绪">
            <div className="voice-wake-pop-head">
              <span className="row" style={{ gap: 6 }}>
                <Sparkles size={14} style={{ color: "var(--accent-text)" }} />
                <span>小羊语音尚未就绪</span>
              </span>
              <button
                type="button"
                className="btw-icon-btn"
                aria-label="关闭语音配置提示"
                onClick={() => setVoiceSetupHint(null)}
              >
                <X size={13} />
              </button>
            </div>
            <div className="voice-wake-pop-desc">{voiceSetupHint}</div>
            <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
              {native.voiceSupported() ? (
                <PocketButton
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    setVoiceSetupHint(null);
                    openSettingsFrame("voice");
                  }}
                >
                  语音唤醒设置
                </PocketButton>
              ) : null}
              <PocketButton
                size="sm"
                variant="primary"
                onClick={() => {
                  setVoiceSetupHint(null);
                  openSettingsFrame("assistant");
                }}
              >
                去配置小羊语音模型
              </PocketButton>
            </div>
          </div>
        ) : null}
      </div>
      <button className="v3-status-item v3-status-btn" style={{ flex: "none" }} onClick={() => setPalette("command")} title="打开命令面板">
        <span className="v3-keys-text">{comboText(SHORTCUTS[0]!.keys)}</span>
        <span>命令</span>
      </button>
    </footer>
  );
}

// Peek -----------------------------------------------------------------------------

/** An agent shown over the work area without opening a tab (Herdr's peek). */
export function PeekOverlay() {
  const key = shellStore.use((s) => s.peek);
  const agent = useAgent(key);
  const [peekMode, setPeekMode] = useState<AgentPaneMode | undefined>(undefined);
  const [subHead, setSubHead] = useState<SubagentHeadInfo | null>(null);
  useEffect(() => {
    setPeekMode(undefined);
    setSubHead(null);
  }, [key]);
  useEffect(() => {
    if (!key) return;
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPeek(null);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [key]);
  if (!key) return null;
  const mode = resolveAgentMode(peekMode, agent);
  const title = agent ? spacedTitle(agent) : "这个 Agent 已经结束了";
  const inSubView = Boolean(agent && subHead && subHead.trail.length > 0);
  return (
    <div className="v3-peek-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setPeek(null)}>
      <section className="v3-pane v3-peek" role="dialog" aria-label="预览 Agent">
        <div className="v3-pane-head">
          {agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : null}
          {inSubView && agent && subHead ? (
            <SubagentHeaderLineage
              mainTitle={title}
              trail={subHead.trail}
              rootSubs={subHead.rootSubs}
              activeSubs={subHead.activeSubs}
              deviceId={agent.deviceId}
              agentKey={agent.key}
              onGoRoot={subHead.onGoRoot}
              onSelectCrumbIndex={subHead.onSelectCrumbIndex}
              onSelectSub={subHead.onSelectSub}
              onOpenAside={subHead.onOpenAside}
            />
          ) : (
            <>
              <span className="v3-pane-name truncate">{title}</span>
              <span className="v3-pane-sub truncate">{agent ? homeFolder(agent.cwd) : ""}</span>
            </>
          )}
          {agent && !inSubView && subHead && (subHead.knownCount > 0 || subHead.rootSubs.length > 0) ? (
            <SubagentCatalogTrigger
              compact
              deviceId={agent.deviceId}
              agentKey={agent.key}
              knownCount={subHead.knownCount}
              subs={subHead.rootSubs}
              onSelectSub={subHead.onSelectSub}
              onOpenAside={subHead.onOpenAside}
              onRefresh={subHead.onRefresh}
            />
          ) : null}
          {agent ? <ModeSwitchIcons mode={mode} onModeChange={setPeekMode} /> : null}
          {agent ? (
            <button className="v3-mini-btn" onClick={() => openAgentTab(agent.key, mode)}>
              <ExternalLink size={12} />
              <span>保留为标签</span>
            </button>
          ) : null}
          <button className="v3-icon-btn small" aria-label="关闭预览" title="关闭（Esc）" onClick={() => setPeek(null)}>
            <X size={13} />
          </button>
        </div>
        <div className="v3-pane-body">
          {agent ? (
            <AgentDetailPanel
              key={agent.key}
              agent={agent}
              embedded
              mode={mode}
              onModeChange={setPeekMode}
              onSubHeadChange={setSubHead}
              onBack={() => setPeek(null)}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
