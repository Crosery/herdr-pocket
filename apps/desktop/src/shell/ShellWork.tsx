import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Columns2, Copy, Equal, ExternalLink, EyeOff, File, FileText, FolderOpen, FolderTree, GitBranch, Globe, GripHorizontal, Laptop, Layers, Maximize2, MessageSquare, Minimize2, Pencil, Plus, Rows2, Search, Sparkles, SquareArrowOutUpRight, Terminal, X } from "lucide-react";
import type { Agent, ConvEvent, SubSession } from "@herdr-pocket/protocol";
import { PocketButton, PocketErrorBoundary, PocketModal, overlayStore, useToast } from "../components/PocketUI";
import { ChatTimelineRows } from "../components/ChatTimeline";
import { DiffTabView, GitPanel } from "../components/GitPanel";
import { XiaoyangOrb, VendorIcon, mascotAssetPath, resolveCallMascotMood, resolveVendor } from "../components/MascotAndVendor";
import { serverLabel } from "../components/Sidebar";
import { SubagentCatalogTrigger, SubagentHeaderLineage, SubagentReadOnlyBar, subLabel } from "../components/SubagentNav";
import { prettyHotkey } from "../components/VoiceInput";
import { AgentDetailPanel, type SubagentHeadInfo } from "../views/AgentsView";
import { FileTree, FileViewer, WebPane, type FileViewerHeadState } from "../views/WorkbenchView";
import { assistantStore, loadAssistant } from "../lib/assistant";
import { assetUrl, copyToClipboard, detectPlatform, isTauri } from "../lib/bridge";
import { restoreUpdatePrompt, updateStore } from "../lib/updates";
import { createBufferedEventMerger, foldConvEvents, mergeConvEvents } from "../lib/chatFold";
import { useClientConfig } from "../lib/config";
import { endPaneDrag, endPanelDrag, endTabDrag, endWorkspaceDrag, hasPaneDrag, hasPanelDrag, hasTabDrag, hasWorkspaceDrag, readPaneDrag, readPanelDrag, readTabDrag, readWorkspaceDrag, startPaneDrag, startPanelDrag, startTabDrag } from "../lib/fileDrag";
import { localHostIdStore, useLocalHostDeviceId } from "../lib/fonts";
import { canActOnLocalFile, isAbsoluteOrHomePath, openLocalFileDefault, openLocalFileInBuiltinBrowser, revealInFolderLabel, revealInFolderShortLabel, revealLocalFile } from "../lib/localFileActions";
import { isMockServer } from "../lib/mock";
import { native } from "../lib/native";
import { openAgentFileTarget } from "../lib/openFileTarget";
import { pingRelay, refreshHostSpaces, rpcCall, subscribeStream } from "../lib/relay";
import { agentSpace, agentTitle, allAgents, createStore, findAgent, liveStore, settingsStore, spacedTitle } from "../lib/store";
import { dismissVoiceMessage, hangupVoiceCall, startVoiceCall, voiceCallStore } from "../lib/voiceCall";
import { homeFolder, listGroup } from "./agentInfo";
import { formatHerdrTabLabel } from "./herdrDoc";
import { StatusMark } from "./ShellSidebar";
import {
  activeTabIdForSpace,
  closeTab,
  closeTabPane,
  computeSplitLayout,
  cycleTab,
  detachPaneToTab,
  equalizeTabSplits,
  focusedLeafOfTab,
  focusTabPane,
  mergeTabIntoSplit,
  moveTab,
  moveTabPaneToEdge,
  moveTabRelative,
  openAgentTab,
  openFileTab,
  openSettingsFrame,
  openWebTab,
  renameShellTab,
  resizeTabSplit,
  setActiveTab,
  setPalette,
  setPaneAgentMode,
  setPanelWidth,
  setPeek,
  shellStore,
  showPanel,
  splitActivePaneWithContent,
  splitTabPane,
  swapTabPanes,
  tabLeaves,
  tabRootNode,
  togglePanel,
  toggleZoomTabPane,
  unsplitTabToTabs,
  updateWebPane,
  visibleTabsForSpace,
  type AgentPaneMode,
  type PaneContent,
  type PanelId,
  type ShellTab,
  type SplitDirection,
  type SplitLeafLayout,
  type SplitSashLayout,
} from "./shellStore";
import { comboText, shortcutText, SHORTCUTS } from "./shortcuts";
import "../styles/btw-slash.css";

const AssistantView = lazy(() => import("../views/AssistantView").then((m) => ({ default: m.AssistantView })));

function useAgent(key: string | null | undefined): Agent | undefined {
  return liveStore.use((s) => (key ? allAgents(s.agents).find((a) => a.key === key) : undefined));
}

/** Closes a tab in the UI only; any web pane native views inside go with it. */
export function closeShellTab(tab: ShellTab): void {
  for (const leaf of tabLeaves(tab)) {
    if (leaf.content.kind === "web") void native.browserClose(leaf.content.webId);
  }
  closeTab(tab.id);
}

type CloseConfirmState =
  | { kind: "tabs"; tabs: ShellTab[]; busyAgents: Agent[] }
  | { kind: "pane"; tabId: string; paneId: string; busyAgent: Agent }
  | null;

const closeConfirmStore = createStore<CloseConfirmState>(null);
let reportCloseError: (message: string) => void = () => {};

function isLiveTerminalAgent(agent: Agent | undefined): agent is Agent {
  return Boolean(agent && (agent.source === "hc" || agent.source === "herdr"));
}

function isBusyAgent(agent: Agent): boolean {
  return agent.status === "working" || agent.status === "blocked";
}

function countAgentPanesOutside(excluded: { tabIds?: ReadonlySet<string>; tabId?: string; paneId?: string }, agentKey: string): number {
  let count = 0;
  for (const t of shellStore.get().tabs) {
    if (excluded.tabIds?.has(t.id)) continue;
    for (const leaf of tabLeaves(t)) {
      if (excluded.tabId === t.id && excluded.paneId === leaf.id) continue;
      if (leaf.content.kind === "agent" && leaf.content.agentKey === agentKey) count += 1;
    }
  }
  return count;
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

function killLiveAgent(agent: Agent, devicesToRefresh: Set<string>): void {
  removeAgentFromLiveStore(agent);
  clearAgentOverlays(agent.key);
  const localId = localHostIdStore.get();
  const killPromise =
    isTauri() && native.available() && localId && localId === agent.deviceId && agent.source === "hc" && agent.localId
      ? native
          .localTermKill(agent.localId)
          .catch(() => rpcCall(agent.deviceId, "terminal.kill", { agent: agent.key }))
      : rpcCall(agent.deviceId, "terminal.kill", { agent: agent.key });
  void killPromise
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

function executeCloseTabs(tabs: ShellTab[], mode: "hideOnly" | "killLive"): void {
  const closingIds = new Set(tabs.map((t) => t.id));
  const candidates: string[] = [];
  for (const tab of tabs) {
    for (const leaf of tabLeaves(tab)) {
      if (leaf.content.kind === "agent") candidates.push(leaf.content.agentKey);
    }
    closeShellTab(tab);
  }
  if (mode !== "killLive") return;
  const killedKeys = new Set<string>();
  const devicesToRefresh = new Set<string>();
  for (const agentKey of candidates) {
    if (killedKeys.has(agentKey)) continue;
    if (countAgentPanesOutside({ tabIds: closingIds }, agentKey) > 0) continue;
    const agent = findAgent(agentKey);
    if (!isLiveTerminalAgent(agent)) continue;
    killedKeys.add(agent.key);
    killLiveAgent(agent, devicesToRefresh);
  }
}

function executeClosePane(tabId: string, paneId: string, mode: "hideOnly" | "killLive"): void {
  const tab = shellStore.get().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const leaf = tabLeaves(tab).find((l) => l.id === paneId);
  if (!leaf) return;
  if (leaf.content.kind === "web") {
    void native.browserClose(leaf.content.webId);
  }
  const agentKey = leaf.content.kind === "agent" ? leaf.content.agentKey : null;
  const agent = agentKey ? findAgent(agentKey) : undefined;
  const keepShared = agentKey ? countAgentPanesOutside({ tabId, paneId }, agentKey) > 0 : false;
  closeTabPane(tabId, paneId);
  if (mode === "killLive" && !keepShared && isLiveTerminalAgent(agent)) {
    killLiveAgent(agent, new Set<string>());
  }
}

/**
 * Closes multiple tabs with Herdr App parity:
 * - File/diff/web/missing/`uniflo` panes close in UI immediately.
 * - Idle/done live agents (when not open in another pane) close UI + kill backend terminal.
 * - Any `working`/`blocked` live agent triggers the confirmation modal (`取消` / `仅收起标签` / `关闭并结束`).
 */
export function requestCloseShellTabs(tabs: ShellTab[]): void {
  if (!tabs.length) return;
  const closingIds = new Set(tabs.map((t) => t.id));
  const busyAgents: Agent[] = [];
  const seenBusy = new Set<string>();
  for (const tab of tabs) {
    for (const leaf of tabLeaves(tab)) {
      if (leaf.content.kind !== "agent") continue;
      if (countAgentPanesOutside({ tabIds: closingIds }, leaf.content.agentKey) > 0) continue;
      const agent = findAgent(leaf.content.agentKey);
      if (isLiveTerminalAgent(agent) && isBusyAgent(agent) && !seenBusy.has(agent.key)) {
        seenBusy.add(agent.key);
        busyAgents.push(agent);
      }
    }
  }
  if (busyAgents.length > 0) {
    closeConfirmStore.set({ kind: "tabs", tabs, busyAgents });
    return;
  }
  executeCloseTabs(tabs, "killLive");
}

/** Closes one tab with Herdr App parity (idle/done live agents kill tab & terminal; running/blocked prompt first). */
export function requestCloseShellTab(tab: ShellTab): void {
  requestCloseShellTabs([tab]);
}

/** Closes one pane inside a tab (delegates to requestCloseShellTab when only one pane remains). */
export function requestClosePane(tabId: string, paneId: string): void {
  const tab = shellStore.get().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const leaves = tabLeaves(tab);
  if (leaves.length <= 1) {
    requestCloseShellTab(tab);
    return;
  }
  const leaf = leaves.find((l) => l.id === paneId);
  if (!leaf) return;
  if (leaf.content.kind === "agent" && countAgentPanesOutside({ tabId, paneId }, leaf.content.agentKey) === 0) {
    const agent = findAgent(leaf.content.agentKey);
    if (isLiveTerminalAgent(agent) && isBusyAgent(agent)) {
      closeConfirmStore.set({ kind: "pane", tabId, paneId, busyAgent: agent });
      return;
    }
  }
  executeClosePane(tabId, paneId, "killLive");
}

function clipModalTitleName(name: string, max = 48): string {
  return name.length > max ? `${name.slice(0, max)}…` : name;
}

function TabCloseConfirmModal() {
  const confirm = closeConfirmStore.use((s) => s);
  if (!confirm) return null;
  const singleBusy =
    confirm.kind === "pane"
      ? confirm.busyAgent
      : confirm.tabs.length === 1 && confirm.busyAgents.length === 1
        ? confirm.busyAgents[0]
        : null;
  const isPane = confirm.kind === "pane";
  let title: string;
  let subtitle: string;
  if (singleBusy) {
    title = `关闭正在运行的${isPane ? "分屏" : "标签"}「${clipModalTitleName(agentTitle(singleBusy))}」？`;
    subtitle =
      singleBusy.status === "blocked"
        ? `该 Agent 正在等待你的回复或确认。你可以仅收起${isPane ? "分屏" : "标签"}让它在后台继续，或直接关闭并结束终端进程。`
        : `该 Agent 正在运行中。你可以仅收起${isPane ? "分屏" : "标签"}让它在后台继续，或直接关闭并结束终端进程。`;
  } else if (confirm.kind === "tabs" && confirm.busyAgents.length === 1) {
    title = `关闭正在运行的标签「${clipModalTitleName(agentTitle(confirm.busyAgents[0]!), 32)}」及其他 ${confirm.tabs.length - 1} 个标签？`;
    subtitle = "其中有 1 个 Agent 正在运行或等待回复：选择「仅收起标签」会保留进程在后台继续，选择「关闭并结束」将终止终端进程。";
  } else {
    const count = confirm.kind === "tabs" ? confirm.tabs.length : 1;
    const busyCount = confirm.kind === "tabs" ? confirm.busyAgents.length : 1;
    title = `关闭 ${count} 个标签（含 ${busyCount} 个运行中）？`;
    subtitle = `其中 ${busyCount} 个 Agent 正在运行或等待回复：选择「仅收起标签」会保留进程在后台继续，选择「关闭并结束」将终止终端进程。`;
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
            if (!pending) return;
            if (pending.kind === "pane") executeClosePane(pending.tabId, pending.paneId, "hideOnly");
            else executeCloseTabs(pending.tabs, "hideOnly");
          }}
        >
          {isPane ? "仅收起分屏" : "仅收起标签"}
        </PocketButton>
        <PocketButton
          variant="danger"
          onClick={() => {
            const pending = closeConfirmStore.get();
            closeConfirmStore.set(null);
            if (!pending) return;
            if (pending.kind === "pane") executeClosePane(pending.tabId, pending.paneId, "killLive");
            else executeCloseTabs(pending.tabs, "killLive");
          }}
        >
          关闭并结束
        </PocketButton>
      </div>
    </PocketModal>
  );
}

// Tabs bar ---------------------------------------------------------------------

function contentTitle(content: PaneContent, agent: Agent | undefined): string {
  if (content.kind === "agent") return agent ? agentTitle(agent) : "已结束的 Agent";
  if (content.kind === "web") return content.title === "about:blank" ? "新网页" : content.title;
  return content.title;
}

function TabChip({
  tab,
  index,
  total,
  active,
  hasSpaceFilter,
  isRenaming,
  draggingId,
  dropTarget,
  setTabRef,
  onStartRename,
  onCommitRename,
  onCancelRename,
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
  hasSpaceFilter: boolean;
  isRenaming: boolean;
  draggingId: string | null;
  dropTarget: { id: string; side: "before" | "after" } | null;
  setTabRef: (el: HTMLDivElement | null) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onDragStartTab: (e: ReactDragEvent<HTMLDivElement>, id: string) => void;
  onDragEndTab: () => void;
  onDragOverTab: (e: ReactDragEvent<HTMLDivElement>, id: string) => void;
  onDropTab: (e: ReactDragEvent<HTMLDivElement>, index: number) => void;
  onMenu: (e: ReactMouseEvent, tab: ShellTab) => void;
}) {
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const all = useMemo(() => allAgents(agentsMap), [agentsMap]);
  const leaves = useMemo(() => tabLeaves(tab), [tab]);
  const primary = focusedLeafOfTab(tab);
  const primaryContent = primary.content;
  const leadLeaf = useMemo(
    () => (primaryContent.kind === "agent" ? primary : leaves.find((l) => l.content.kind === "agent") ?? primary),
    [leaves, primary, primaryContent.kind],
  );
  const leadContent = leadLeaf.content;
  const agent = useMemo(
    () => (leadContent.kind === "agent" ? all.find((a) => a.key === leadContent.agentKey) : undefined),
    [all, leadContent],
  );
  const group = useMemo(() => {
    let best: ReturnType<typeof listGroup> | null = null;
    const rank = { blocked: 4, working: 3, done: 2, idle: 1, offline: 0 };
    for (const leaf of leaves) {
      if (leaf.content.kind !== "agent") continue;
      const ak = leaf.content.agentKey;
      const a = all.find((x) => x.key === ak);
      if (!a) continue;
      const g = listGroup(a, devices);
      if (!best || rank[g] > rank[best]) best = g;
    }
    return best;
  }, [all, devices, leaves]);
  const title = contentTitle(primaryContent, agent);
  const primaryProgram = leadContent.kind === "agent"
    ? (agent ? (agent.isShell ? "Terminal" : resolveVendor(agent.harness, false).label) : "已结束的 Agent")
    : undefined;
  const primaryLiveTitle = leadContent.kind === "agent" && agent ? (agent.name || agent.title) : undefined;
  const isHerdrTab = Boolean(tab.docTabId || leadContent.kind === "agent" || hasSpaceFilter);
  const shownLabel = isHerdrTab && (tab.docTabId || leadContent.kind === "agent")
    ? formatHerdrTabLabel(
        { name: tab.docTabName ?? (tab.docTabId ? "" : undefined) },
        { programName: primaryProgram, liveTitle: primaryLiveTitle, index },
        Boolean(tab.split?.zoomedPaneId),
      )
    : (tab.docTabName || title);
  const [draft, setDraft] = useState(tab.docTabName ?? "");
  useEffect(() => {
    if (isRenaming) setDraft(tab.docTabName ?? "");
  }, [isRenaming, tab.docTabName]);
  const side = dropTarget?.id === tab.id ? dropTarget.side : null;
  return (
    <div
      ref={setTabRef}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable={total > 1 && !isRenaming}
      data-tauri-drag-region="false"
      className={`v3-tab${active ? " active" : ""}${primaryContent.kind === "agent" && !agent ? " gone" : ""}${draggingId === tab.id ? " dragging" : ""}${side ? ` drop-${side}` : ""}`}
      title={
        leaves.length > 1
          ? `${title}（共 ${leaves.length} 个分屏）`
          : primaryContent.kind === "agent"
            ? agent
              ? spacedTitle(agent)
              : title
            : primaryContent.kind === "file"
              ? primaryContent.path
              : primaryContent.kind === "diff"
                ? `${primaryContent.path} (${primaryContent.staged ? "已暂存" : "工作区"})`
                : primaryContent.url
      }
      onClick={() => {
        if (!isRenaming) setActiveTab(tab.id);
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement | null)?.closest(".v3-tab-x")) return;
        e.stopPropagation();
        onStartRename(tab.id);
      }}
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
      {primaryContent.kind === "agent" ? (
        agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : <File size={14} />
      ) : primaryContent.kind === "file" ? (
        <FileText size={14} />
      ) : primaryContent.kind === "diff" ? (
        <GitBranch size={14} />
      ) : (
        <Globe size={14} />
      )}
      {isRenaming ? (
        <input
          type="text"
          className="v3-tab-rename-input"
          autoFocus
          value={draft}
          placeholder={String(index + 1)}
          aria-label="重命名标签"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitRename(tab.id, draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename(tab.id, draft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancelRename();
            }
          }}
        />
      ) : (
        <span className="v3-tab-label truncate">{shownLabel}</span>
      )}
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
  const menuEl = (
    <div
      className="ctx-menu v3-popup"
      role="menu"
      // Menus open inside header/tabs bars: a press on a menu must not move the window.
      data-tauri-drag-region="false"
      style={{
        left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - 240)),
        width,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
  return typeof document !== "undefined" ? createPortal(menuEl, document.body) : menuEl;
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
  const spacesMap = liveStore.use((s) => s.spaces);
  const homePage = useClientConfig().browser.homePage;
  const [menu, setMenu] = useState<{ x: number; y: number; tab: ShellTab } | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const [fileDropOver, setFileDropOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wheelLockRef = useRef(0);
  const tabElsRef = useRef(new Map<string, HTMLDivElement>());
  const prevRectsRef = useRef(new Map<string, number>());
  const tabAnimsRef = useRef(new WeakMap<HTMLDivElement, Animation>());

  const agentByKey = useMemo(() => new Map(allAgents(agentsMap).map((a) => [a.key, a] as const)), [agentsMap]);
  const lookupAgent = useCallback((k: string) => agentByKey.get(k), [agentByKey]);
  const visibleTabs = useMemo(
    () => visibleTabsForSpace(tabs, selectedSpace, lookupAgent, spacesMap),
    [lookupAgent, selectedSpace, spacesMap, tabs],
  );
  const active = useMemo(
    () => activeTabIdForSpace({ tabs, active: rawActive, selectedSpace, activeBySpace }, lookupAgent, spacesMap),
    [activeBySpace, lookupAgent, rawActive, selectedSpace, spacesMap, tabs],
  );

  // Keep the active chip in view on tab switch and tab-strip resize, matching Herdr.app.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const revealActive = () => {
      scroller.querySelector<HTMLElement>(".v3-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    revealActive();
    if (typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        revealActive();
      });
    });
    ro.observe(scroller);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active, visibleTabs.length]);

  useEffect(() => {
    reportCloseError = (msg) => toast(msg, true);
    return () => {
      reportCloseError = () => {};
    };
  }, [toast]);

  // Smooth FLIP slide animation via Web Animations API so layout transform never gets stuck if renders overlap.
  useLayoutEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nextRects = new Map<string, number>();
    for (const t of visibleTabs) {
      const el = tabElsRef.current.get(t.id);
      if (!el) continue;
      tabAnimsRef.current.get(el)?.cancel();
      tabAnimsRef.current.delete(el);
      nextRects.set(t.id, el.getBoundingClientRect().left);
    }
    if (!reduced && prevRectsRef.current.size > 0) {
      for (const t of visibleTabs) {
        const el = tabElsRef.current.get(t.id);
        const prevLeft = prevRectsRef.current.get(t.id);
        const nextLeft = nextRects.get(t.id);
        if (!el || prevLeft === undefined || nextLeft === undefined) continue;
        const dx = prevLeft - nextLeft;
        if (Math.abs(dx) < 1 || typeof el.animate !== "function") continue;
        const anim = el.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0px)" }],
          { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
        tabAnimsRef.current.set(el, anim);
        anim.onfinish = () => {
          if (tabAnimsRef.current.get(el) === anim) tabAnimsRef.current.delete(el);
        };
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
    if (!hasTabDrag(e) && !hasPanelDrag(e) && !hasPaneDrag(e)) return;
    if (id === draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const side: "before" | "after" = e.clientX - rect.left < rect.width / 2 ? "before" : "after";
    setDropTarget((prev) => (prev?.id === id && prev.side === side ? prev : { id, side }));
  };

  const handleDropAt = (e: ReactDragEvent<HTMLDivElement>, targetTabId?: string, side?: "before" | "after") => {
    setFileDropOver(false);
    const paneItem = readPaneDrag(e);
    if (paneItem) {
      e.preventDefault();
      e.stopPropagation();
      endPaneDrag();
      setDropTarget(null);
      let insertBeforeTabId: string | undefined;
      if (targetTabId && side) {
        const idx = tabs.findIndex((t) => t.id === targetTabId);
        if (idx >= 0) {
          insertBeforeTabId = side === "before" ? targetTabId : tabs[idx + 1]?.id;
        }
      }
      detachPaneToTab(paneItem.tabId, paneItem.paneId, { insertBeforeTabId });
      return;
    }

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
        } else if (hasTabDrag(e) || hasPanelDrag(e) || hasPaneDrag(e)) {
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
      <div
        ref={scrollRef}
        className="v3-tab-scroll"
        role="tablist"
        aria-label="标签"
        onWheel={(e) => {
          if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
            e.currentTarget.scrollLeft += e.deltaX;
            return;
          }
          if (Math.abs(e.deltaY) >= 4 && visibleTabs.length > 1) {
            const nowMs = Date.now();
            if (nowMs - wheelLockRef.current < 160) return;
            wheelLockRef.current = nowMs;
            cycleTab(e.deltaY > 0 ? 1 : -1, visibleTabs);
          }
        }}
      >
        {visibleTabs.map((t, i) => (
          <TabChip
            key={t.id}
            tab={t}
            index={i}
            total={visibleTabs.length}
            active={t.id === active}
            hasSpaceFilter={Boolean(selectedSpace)}
            isRenaming={renamingId === t.id}
            draggingId={draggingId}
            dropTarget={dropTarget}
            setTabRef={(el) => {
              if (el) tabElsRef.current.set(t.id, el);
              else tabElsRef.current.delete(t.id);
            }}
            onStartRename={(id) => setRenamingId(id)}
            onCommitRename={(id, nextName) => {
              setRenamingId(null);
              renameShellTab(id, nextName);
            }}
            onCancelRename={() => setRenamingId(null)}
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
        const menuFocused = focusedLeafOfTab(menu.tab).content;
        const menuLeaves = tabLeaves(menu.tab);
        const menuFileLeaf = menuFocused.kind === "file" ? menuFocused : menuLeaves.find((l) => l.content.kind === "file")?.content;
        const menuFileAgent = menuFileLeaf && menuFileLeaf.kind === "file" ? agentByKey.get(menuFileLeaf.agentKey) : undefined;
        const menuPlatform = detectPlatform();
        const menuLocalHostId = localHostIdStore.get();
        const canMenuFileLocal = Boolean(
          menuFileLeaf &&
            menuFileLeaf.kind === "file" &&
            canActOnLocalFile({
              nativeAvailable: native.available(),
              agentDeviceId: menuFileAgent?.deviceId,
              agentCwd: menuFileAgent?.cwd,
              localHostId: menuLocalHostId,
              path: menuFileLeaf.path,
              absPath: menuFileLeaf.absPath,
            }),
        );
        const isLive = menuLeaves.some((l) => l.content.kind === "agent" && isLiveTerminalAgent(agentByKey.get(l.content.agentKey)));
        const idx = visibleTabs.findIndex((t) => t.id === menu.tab.id);
        const otherTabs = visibleTabs.filter((t) => t.id !== menu.tab.id);
        const rightTabs = idx >= 0 ? visibleTabs.slice(idx + 1) : [];
        const canMergeIntoActive = Boolean(active && menu.tab.id !== active && visibleTabs.some((t) => t.id === active));
        const isMultiPane = menuLeaves.length > 1;
        return (
          <Popup x={menu.x} y={menu.y} onClose={() => setMenu(null)} width={228}>
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
            <MenuItem
              label="重命名标签"
              icon={Pencil}
              onClick={() => {
                const id = menu.tab.id;
                setMenu(null);
                setRenamingId(id);
              }}
            />
            {canMenuFileLocal && menuFileLeaf && menuFileLeaf.kind === "file" ? (
              <>
                <div className="menu-sep" />
                <MenuItem
                  label="用内置浏览器打开"
                  icon={Globe}
                  onClick={() => {
                    const target = menuFileLeaf;
                    const ag = menuFileAgent;
                    setMenu(null);
                    void openLocalFileInBuiltinBrowser({
                      path: target.path,
                      absPath: target.absPath,
                      agentCwd: ag?.cwd,
                      title: target.title,
                      spaceKey: selectedSpace,
                    }).catch((e: Error) => toast(e.message || "无法用内置浏览器打开", true));
                  }}
                />
                <MenuItem
                  label="用系统默认应用打开"
                  icon={ExternalLink}
                  onClick={() => {
                    const target = menuFileLeaf;
                    const ag = menuFileAgent;
                    setMenu(null);
                    void openLocalFileDefault({
                      path: target.path,
                      absPath: target.absPath,
                      agentCwd: ag?.cwd,
                    }).catch((e: Error) => toast(e.message || "无法用系统默认应用打开", true));
                  }}
                />
                <MenuItem
                  label={revealInFolderLabel(menuPlatform)}
                  icon={FolderOpen}
                  onClick={() => {
                    const target = menuFileLeaf;
                    const ag = menuFileAgent;
                    setMenu(null);
                    void revealLocalFile({
                      path: target.path,
                      absPath: target.absPath,
                      agentCwd: ag?.cwd,
                    }).catch((e: Error) => toast(e.message || "打开所在目录失败", true));
                  }}
                />
              </>
            ) : null}
            <div className="menu-sep" />
            {canMergeIntoActive ? (
              <>
                <MenuItem
                  label="并入当前标签右侧分屏"
                  icon={Columns2}
                  onClick={() => {
                    const target = menu.tab;
                    setMenu(null);
                    mergeTabIntoSplit(target.id, active!, null, "right");
                  }}
                />
                <MenuItem
                  label="并入当前标签下方分屏"
                  icon={Rows2}
                  onClick={() => {
                    const target = menu.tab;
                    setMenu(null);
                    mergeTabIntoSplit(target.id, active!, null, "down");
                  }}
                />
                <div className="menu-sep" />
              </>
            ) : null}
            {isMultiPane ? (
              <>
                <MenuItem
                  label="均分分屏尺寸"
                  icon={Equal}
                  onClick={() => {
                    const target = menu.tab;
                    setMenu(null);
                    equalizeTabSplits(target.id);
                  }}
                />
                <MenuItem
                  label="拆分为多个标签页"
                  icon={SquareArrowOutUpRight}
                  onClick={() => {
                    const target = menu.tab;
                    setMenu(null);
                    unsplitTabToTabs(target.id);
                  }}
                />
                <div className="menu-sep" />
              </>
            ) : null}
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
            {menuFocused.kind !== "agent" ? <div className="menu-sep" /> : null}
            {menuFocused.kind === "file" || menuFocused.kind === "diff" ? (
              <MenuItem
                label="复制路径"
                icon={Copy}
                onClick={() => {
                  const path = menuFocused.kind === "file" ? (menuFocused.absPath || menuFocused.path) : menuFocused.path;
                  setMenu(null);
                  void copyToClipboard(path).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok));
                }}
              />
            ) : null}
            {menuFocused.kind === "web" ? (
              <MenuItem
                label="复制网址"
                icon={Copy}
                onClick={() => {
                  const url = menuFocused.url;
                  setMenu(null);
                  void copyToClipboard(url).then((ok) => toast(ok ? "网址已复制" : "复制失败", !ok));
                }}
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

function resolveAgentMode(tabMode: AgentPaneMode | undefined, _agent: Agent | undefined): AgentPaneMode {
  return tabMode ?? "term";
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
  tabId,
  paneId,
  content,
  agent,
  mode,
  onModeChange,
  subHead,
  fileHead,
  isSplit,
  isZoomed,
  onDraggingPaneChange,
  onSplitNewTerminal,
  onToggleZoom,
  onEqualize,
  onDetach,
  onClose,
}: {
  tabId: string;
  paneId: string;
  content: PaneContent;
  agent: Agent | undefined;
  mode?: AgentPaneMode;
  onModeChange?: (m: AgentPaneMode) => void;
  subHead?: SubagentHeadInfo | null;
  fileHead?: FileViewerHeadState | null;
  isSplit: boolean;
  isZoomed: boolean;
  onDraggingPaneChange: (paneId: string | null) => void;
  onSplitNewTerminal: (tabId: string, paneId: string, direction: SplitDirection) => void;
  onToggleZoom: () => void;
  onEqualize: () => void;
  onDetach: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const devices = liveStore.use((s) => s.devices);
  const homePage = useClientConfig().browser.homePage;
  const localHostId = useLocalHostDeviceId();
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null);
  const group = agent ? listGroup(agent, devices) : null;
  const platform = detectPlatform();
  const revealLabel = revealInFolderLabel(platform);
  const revealShortLabel = revealInFolderShortLabel(platform);
  const canRevealLocal =
    content.kind === "file" &&
    canActOnLocalFile({
      nativeAvailable: native.available(),
      agentDeviceId: agent?.deviceId,
      agentCwd: agent?.cwd,
      localHostId,
      path: content.path,
      absPath: content.absPath,
    });
  const handleReveal =
    content.kind === "file"
      ? () => {
          void revealLocalFile({
            path: content.path,
            absPath: content.absPath,
            agentCwd: agent?.cwd,
          }).catch((e: Error) => toast(e.message || "打开所在目录失败", true));
        }
      : undefined;
  const handleOpenDefault =
    content.kind === "file"
      ? () => {
          void openLocalFileDefault({
            path: content.path,
            absPath: content.absPath,
            agentCwd: agent?.cwd,
          }).catch((e: Error) => toast(e.message || "无法用系统默认应用打开", true));
        }
      : undefined;
  const handleOpenBuiltinBrowser =
    content.kind === "file"
      ? () => {
          void openLocalFileInBuiltinBrowser({
            path: content.path,
            absPath: content.absPath,
            agentCwd: agent?.cwd,
            title: content.title,
            spaceKey: shellStore.get().selectedSpace,
          }).catch((e: Error) => toast(e.message || "无法用内置浏览器打开", true));
        }
      : undefined;
  let icon: React.ReactNode;
  let name: string;
  let sub: string;
  let subTitle = "";
  if (content.kind === "agent") {
    icon = agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : <File size={14} />;
    name = agent ? spacedTitle(agent) : "这个 Agent 已经结束了";
    sub = agent ? homeFolder(agent.cwd) || agent.where || "" : "";
    subTitle = sub;
  } else if (content.kind === "file") {
    icon = <FileText size={14} />;
    name = content.title;
    const normPath = content.path.replace(/\\/g, "/");
    const slash = normPath.lastIndexOf("/");
    sub = slash > 0 ? normPath.slice(0, slash) : "";
    subTitle = content.absPath || content.path;
  } else if (content.kind === "diff") {
    icon = <GitBranch size={14} />;
    name = content.title;
    sub = content.commit ? `提交 ${content.commit.slice(0, 7)}` : content.staged ? "暂存区变更" : "工作区变更";
    subTitle = content.path;
  } else {
    icon = <Globe size={14} />;
    name = content.title === "about:blank" ? "新网页" : content.title;
    sub = content.url === "about:blank" ? "" : content.url;
    subTitle = sub;
  }
  const lineBadge =
    content.kind === "file" && content.line
      ? content.endLine && content.endLine !== content.line
        ? `L${content.line}–${content.endLine}`
        : `L${content.line}`
      : null;
  const sizeText =
    content.kind === "file" && fileHead && fileHead.size !== null
      ? fileHead.size >= 1024
        ? `${Math.round(fileHead.size / 1024)} KB`
        : `${fileHead.size} B`
      : null;
  const inSubView = Boolean(content.kind === "agent" && agent && subHead && subHead.trail.length > 0);
  const previewToggleable = Boolean(content.kind === "file" && (fileHead?.canPreview || fileHead?.isMd));
  const oppositeMode: AgentPaneMode = mode === "term" ? "chat" : "term";

  const canDragHead = isSplit && !isZoomed;

  return (
    <div
      className={`v3-pane-head${canDragHead ? " draggable" : ""}`}
      draggable={canDragHead}
      data-menu-open={paneMenu ? "true" : undefined}
      data-tauri-drag-region="false"
      onDragStart={(e) => {
        if (!canDragHead) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("button, input, a, [role='button']")) {
          e.preventDefault();
          return;
        }
        e.stopPropagation();
        startPaneDrag(e, { tabId, paneId });
        onDraggingPaneChange(paneId);
      }}
      onDragEnd={() => {
        endPaneDrag();
        onDraggingPaneChange(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setPaneMenu({ x: e.clientX, y: e.clientY });
      }}
    >
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
      <div className="v3-pane-right">
        {lineBadge ? <span className="v3-pane-pill accent">{lineBadge}</span> : null}
        {sizeText ? <span className="v3-pane-pill num">{sizeText}</span> : null}
        {content.kind === "agent" && agent && !inSubView && subHead && (subHead.knownCount > 0 || subHead.rootSubs.length > 0) ? (
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
        {content.kind === "agent" && group && group !== "idle" && group !== "offline" ? <StatusMark group={group} /> : null}
        {content.kind === "agent" && group === "offline" ? <span className="v3-pane-off">电脑离线</span> : null}
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
        {canRevealLocal && content.kind === "file" ? (
          <>
            <button
              type="button"
              className="v3-pane-tool-btn"
              title="用内置浏览器打开"
              onClick={handleOpenBuiltinBrowser}
            >
              <Globe size={12} />
              <span>内置浏览器</span>
            </button>
            <button
              type="button"
              className="v3-pane-tool-btn"
              title="用系统默认应用打开"
              onClick={handleOpenDefault}
            >
              <ExternalLink size={12} />
              <span>系统打开</span>
            </button>
            <button
              type="button"
              className="v3-pane-tool-btn"
              aria-label={revealShortLabel}
              title={`${revealLabel}（${content.absPath || content.path}）`}
              onClick={handleReveal}
            >
              <FolderOpen size={12} />
              <span>{platform === "macos" ? "访达" : "目录"}</span>
            </button>
          </>
        ) : null}
        <div className="v3-pane-actions">
          {content.kind === "agent" && agent && mode && onModeChange ? (
            <button
              type="button"
              className="v3-icon-btn small"
              aria-label={oppositeMode === "chat" ? "切换到对话视图" : "切换到终端视图"}
              title={oppositeMode === "chat" ? "切换到对话视图" : "切换到终端视图"}
              onClick={() => onModeChange(oppositeMode)}
            >
              {oppositeMode === "chat" ? <MessageSquare size={13} /> : <Terminal size={13} />}
            </button>
          ) : null}
          {content.kind === "agent" && agent && mode === "term" ? (
            <button
              type="button"
              className="v3-icon-btn small"
              aria-label="在终端中搜索"
              title={`在终端中搜索（${shortcutText("terminalSearch")}）`}
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(new CustomEvent("pocket:term-search", { detail: { agentKey: agent.key } }));
                }
              }}
            >
              <Search size={13} />
            </button>
          ) : null}
          {content.kind === "file" ? (
            <button
              type="button"
              className="v3-icon-btn small"
              aria-label="复制路径"
              title={`复制路径（${content.absPath || content.path}）`}
              onClick={() => {
                void copyToClipboard(content.absPath || content.path).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok));
              }}
            >
              <Copy size={13} />
            </button>
          ) : null}
          <button
            type="button"
            className="v3-icon-btn small"
            aria-label="向右分屏"
            title={`向右分屏（${shortcutText("splitRight")}）`}
            onClick={() => onSplitNewTerminal(tabId, paneId, "right")}
          >
            <Columns2 size={13} />
          </button>
          <button
            type="button"
            className="v3-icon-btn small"
            aria-label="向下分屏"
            title={`向下分屏（${shortcutText("splitDown")}）`}
            onClick={() => onSplitNewTerminal(tabId, paneId, "down")}
          >
            <Rows2 size={13} />
          </button>
          {isSplit || isZoomed ? (
            <button
              type="button"
              className={`v3-icon-btn small${isZoomed ? " on" : ""}`}
              aria-label={isZoomed ? "还原分屏布局" : "最大化此分屏"}
              title={`${isZoomed ? "还原分屏布局" : "最大化此分屏"}（${shortcutText("zoomPane")}）`}
              onClick={onToggleZoom}
            >
              {isZoomed ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          ) : null}
          <button
            type="button"
            className="v3-icon-btn small"
            aria-label={isSplit ? "关闭此分屏" : "关闭标签"}
            title={isSplit ? `关闭此分屏（${shortcutText("closePane")}）` : `关闭标签（${shortcutText("closeTab")}）`}
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {paneMenu ? (
        <Popup x={paneMenu.x} y={paneMenu.y} onClose={() => setPaneMenu(null)} width={236}>
          <MenuItem
            label="向右分屏新建终端"
            icon={Columns2}
            keys={shortcutText("splitRight")}
            onClick={() => {
              setPaneMenu(null);
              onSplitNewTerminal(tabId, paneId, "right");
            }}
          />
          <MenuItem
            label="向下分屏新建终端"
            icon={Rows2}
            keys={shortcutText("splitDown")}
            onClick={() => {
              setPaneMenu(null);
              onSplitNewTerminal(tabId, paneId, "down");
            }}
          />
          {content.kind === "agent" && agent ? (
            <MenuItem
              label={oppositeMode === "term" ? "右侧对照打开终端视图" : "右侧对照打开对话视图"}
              icon={oppositeMode === "term" ? Terminal : MessageSquare}
              onClick={() => {
                setPaneMenu(null);
                splitTabPane(tabId, paneId, "right", { kind: "agent", agentKey: agent.key, mode: oppositeMode });
              }}
            />
          ) : null}
          <MenuItem
            label="向右分屏打开网页"
            icon={Globe}
            onClick={() => {
              setPaneMenu(null);
              const url = homePage || "about:blank";
              splitTabPane(tabId, paneId, "right", {
                kind: "web",
                webId: `w:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
                url,
                title: url === "about:blank" ? "新网页" : url,
                spaceKey: shellStore.get().selectedSpace,
              });
            }}
          />
          {canRevealLocal && content.kind === "file" ? (
            <>
              <div className="menu-sep" />
              <MenuItem
                label="用内置浏览器打开"
                icon={Globe}
                onClick={() => {
                  setPaneMenu(null);
                  handleOpenBuiltinBrowser?.();
                }}
              />
              <MenuItem
                label="用系统默认应用打开"
                icon={ExternalLink}
                onClick={() => {
                  setPaneMenu(null);
                  handleOpenDefault?.();
                }}
              />
              <MenuItem
                label={revealLabel}
                icon={FolderOpen}
                onClick={() => {
                  setPaneMenu(null);
                  handleReveal?.();
                }}
              />
            </>
          ) : null}
          {isSplit || isZoomed ? (
            <>
              <div className="menu-sep" />
              <MenuItem
                label={isZoomed ? "还原分屏布局" : "最大化此分屏"}
                icon={isZoomed ? Minimize2 : Maximize2}
                keys={shortcutText("zoomPane")}
                onClick={() => {
                  setPaneMenu(null);
                  onToggleZoom();
                }}
              />
              {isSplit ? (
                <>
                  <MenuItem
                    label="均分分屏尺寸"
                    icon={Equal}
                    onClick={() => {
                      setPaneMenu(null);
                      onEqualize();
                    }}
                  />
                  <MenuItem
                    label="拆分为独立标签页"
                    icon={SquareArrowOutUpRight}
                    onClick={() => {
                      setPaneMenu(null);
                      onDetach();
                    }}
                  />
                </>
              ) : null}
            </>
          ) : null}
          <div className="menu-sep" />
          <MenuItem
            label={isSplit ? "关闭此分屏" : "关闭标签"}
            icon={X}
            keys={isSplit ? shortcutText("closePane") : shortcutText("closeTab")}
            onClick={() => {
              setPaneMenu(null);
              onClose();
            }}
          />
        </Popup>
      ) : null}
    </div>
  );
}

type SplitDropZone = SplitDirection | "center";

function detectSplitDropZone(
  e: ReactDragEvent<HTMLElement>,
  rect: DOMRect,
  allowCenter: boolean,
): SplitDropZone {
  const rx = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
  const ry = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
  if (allowCenter && rx > 0.25 && rx < 0.75 && ry > 0.25 && ry < 0.75) {
    return "center";
  }
  const distances: Array<[SplitDirection, number]> = [
    ["left", rx],
    ["right", 1 - rx],
    ["up", ry],
    ["down", 1 - ry],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0]![0];
}

function SplitSash({
  tabId,
  sash,
  stageRef,
}: {
  tabId: string;
  sash: SplitSashLayout;
  stageRef: React.RefObject<HTMLDivElement | null>;
}) {
  const dragRef = useRef<{ lastPos: number; spanPx: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    return () => {
      if (dragRef.current) {
        dragRef.current = null;
        overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
      }
    };
  }, []);

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
  };

  return (
    <div
      className={`v3-split-sash ${sash.axis}${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation={sash.axis === "row" ? "vertical" : "horizontal"}
      aria-label="拖动调整分屏大小，双击均分"
      title="拖动调整分屏大小（双击恢复均分）"
      style={sash.css}
      onDoubleClick={() => equalizeTabSplits(tabId, sash.branchId)}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const rect = stageRef.current?.getBoundingClientRect();
        const totalPx = sash.axis === "row" ? (rect?.width ?? window.innerWidth) : (rect?.height ?? window.innerHeight);
        const spanPx = Math.max(140, totalPx * Math.max(0.1, sash.branchSpanScale));
        dragRef.current = { lastPos: sash.axis === "row" ? e.clientX : e.clientY, spanPx };
        setDragging(true);
        overlayStore.set((p) => ({ open: p.open + 1 }));
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const pos = sash.axis === "row" ? e.clientX : e.clientY;
        const deltaPx = pos - d.lastPos;
        if (Math.abs(deltaPx) < 1) return;
        d.lastPos = pos;
        resizeTabSplit(tabId, sash.branchId, sash.index, deltaPx / d.spanPx);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}

function SplitPaneSlot({
  tabId,
  item,
  isSplit,
  isFocused,
  isZoomed,
  tabActive,
  draggingPaneId,
  onDraggingPaneChange,
  onSplitNewTerminal,
}: {
  tabId: string;
  item: SplitLeafLayout;
  isSplit: boolean;
  isFocused: boolean;
  isZoomed: boolean;
  tabActive: boolean;
  draggingPaneId: string | null;
  onDraggingPaneChange: (paneId: string | null) => void;
  onSplitNewTerminal: (tabId: string, paneId: string, direction: SplitDirection) => void;
}) {
  const { leaf, visible, css } = item;
  const { content } = leaf;
  const agentKey = content.kind === "agent" || content.kind === "file" ? content.agentKey : content.kind === "diff" ? content.agentKey : undefined;
  const agent = useAgent(agentKey);
  const devices = liveStore.use((s) => s.devices);
  const agentsMap = liveStore.use((s) => s.agents);
  const [subHead, setSubHead] = useState<SubagentHeadInfo | null>(null);
  const [fileHead, setFileHead] = useState<FileViewerHeadState | null>(null);
  const [dropZone, setDropZone] = useState<SplitDropZone | null>(null);

  useEffect(() => {
    if (!dropZone) return;
    const clear = () => setDropZone(null);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, [dropZone]);

  const label =
    content.kind === "agent"
      ? agent
        ? spacedTitle(agent)
        : "已结束的 Agent"
      : content.kind === "web"
        ? content.title === "about:blank"
          ? "新网页"
          : content.title
        : content.title;

  const mode = content.kind === "agent" ? resolveAgentMode(content.mode, agent) : undefined;
  const layoutKey = `${css.left}|${css.top}|${css.width}|${css.height}|${visible ? 1 : 0}`;
  const isAgentPane = content.kind === "agent";

  const acceptsSplitDrop = (e: ReactDragEvent<HTMLElement>): { ok: boolean; allowCenter: boolean } => {
    if (hasPaneDrag(e)) {
      const paneDrag = readPaneDrag(e);
      if (paneDrag && paneDrag.tabId === tabId && paneDrag.paneId === leaf.id) return { ok: false, allowCenter: false };
      return { ok: true, allowCenter: Boolean(paneDrag && paneDrag.tabId === tabId) };
    }
    if (hasTabDrag(e) || hasPanelDrag(e)) return { ok: true, allowCenter: false };
    if (hasWorkspaceDrag(e)) {
      const overHead = Boolean((e.target as HTMLElement | null)?.closest(".v3-pane-head"));
      if (!isAgentPane || e.altKey || overHead) return { ok: true, allowCenter: false };
    }
    return { ok: false, allowCenter: false };
  };

  const handleDragOver = (e: ReactDragEvent<HTMLElement>) => {
    const check = acceptsSplitDrop(e);
    if (!check.ok) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = hasWorkspaceDrag(e) ? "copy" : "move";
    const zone = detectSplitDropZone(e, e.currentTarget.getBoundingClientRect(), check.allowCenter);
    setDropZone((prev) => (prev === zone ? prev : zone));
  };

  const handleDrop = (e: ReactDragEvent<HTMLElement>) => {
    const check = acceptsSplitDrop(e);
    if (!check.ok) return;
    const zone = detectSplitDropZone(e, e.currentTarget.getBoundingClientRect(), check.allowCenter);
    setDropZone(null);

    const paneDrag = readPaneDrag(e);
    if (paneDrag) {
      e.preventDefault();
      e.stopPropagation();
      endPaneDrag();
      onDraggingPaneChange(null);
      if (paneDrag.tabId === tabId) {
        if (zone === "center") swapTabPanes(tabId, paneDrag.paneId, leaf.id);
        else moveTabPaneToEdge(tabId, paneDrag.paneId, leaf.id, zone);
      } else {
        const detachedId = detachPaneToTab(paneDrag.tabId, paneDrag.paneId);
        if (detachedId) mergeTabIntoSplit(detachedId, tabId, leaf.id, zone === "center" ? "right" : zone);
      }
      return;
    }

    const tabDragId = readTabDrag(e);
    if (tabDragId && tabDragId !== tabId) {
      e.preventDefault();
      e.stopPropagation();
      endTabDrag();
      mergeTabIntoSplit(tabDragId, tabId, leaf.id, zone === "center" ? "right" : zone);
      return;
    }

    const panelItem = readPanelDrag(e);
    if (panelItem) {
      e.preventDefault();
      e.stopPropagation();
      endPanelDrag();
      const dir: SplitDirection = zone === "center" ? "right" : zone;
      if (panelItem.kind === "browser") {
        splitTabPane(tabId, leaf.id, dir, {
          kind: "web",
          webId: `w:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
          url: panelItem.url,
          title: panelItem.title,
          ...(panelItem.spaceKey ? { spaceKey: panelItem.spaceKey } : {}),
        });
        if (shellStore.get().panel === "browser") showPanel(null);
      } else if (panelItem.kind === "agent") {
        const targetAgent = allAgents(agentsMap).find((a) => a.key === panelItem.agentKey);
        splitTabPane(
          tabId,
          leaf.id,
          dir,
          {
            kind: "agent",
            agentKey: panelItem.agentKey,
            ...(targetAgent?.isShell ? { mode: "term" } : {}),
          },
          { dedupeOtherTabs: true },
        );
      }
      return;
    }

    const wsItem = readWorkspaceDrag(e);
    if (wsItem) {
      e.preventDefault();
      e.stopPropagation();
      endWorkspaceDrag();
      if (wsItem.kind === "file") {
        const dir: SplitDirection = zone === "center" ? "right" : zone;
        splitTabPane(tabId, leaf.id, dir, {
          kind: "file",
          agentKey: wsItem.agentKey,
          path: wsItem.relPath,
          title: wsItem.name,
          ...(wsItem.absPath ? { absPath: wsItem.absPath } : {}),
          spaceKey: shellStore.get().selectedSpace,
        });
      }
    }
  };

  return (
    <div
      className="v3-split-slot"
      style={visible ? css : { ...css, display: "none" }}
      onPointerDownCapture={() => {
        if (!isFocused) focusTabPane(tabId, leaf.id);
      }}
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropZone(null);
      }}
      onDrop={handleDrop}
    >
      <section
        className={`v3-pane${isSplit ? " is-split" : ""}${isFocused ? " is-focused" : ""}${isZoomed ? " is-zoomed" : ""}`}
        aria-label={label}
      >
        <PaneHead
          tabId={tabId}
          paneId={leaf.id}
          content={content}
          agent={agent}
          mode={mode}
          subHead={subHead}
          fileHead={fileHead}
          isSplit={isSplit}
          isZoomed={isZoomed}
          onDraggingPaneChange={onDraggingPaneChange}
          onModeChange={content.kind === "agent" ? (m) => setPaneAgentMode(tabId, leaf.id, m) : undefined}
          onSplitNewTerminal={onSplitNewTerminal}
          onToggleZoom={() => toggleZoomTabPane(tabId, leaf.id)}
          onEqualize={() => equalizeTabSplits(tabId)}
          onDetach={() => detachPaneToTab(tabId, leaf.id)}
          onClose={() => requestClosePane(tabId, leaf.id)}
        />
        {isSplit && !isZoomed ? (
          <div
            className="v3-pane-grip"
            draggable
            data-tauri-drag-region="false"
            title="拖动可移动或交换此分屏；拖到顶部标签栏可拆分为独立标签"
            onDragStart={(e) => {
              e.stopPropagation();
              startPaneDrag(e, { tabId, paneId: leaf.id });
              onDraggingPaneChange(leaf.id);
            }}
            onDragEnd={() => {
              endPaneDrag();
              onDraggingPaneChange(null);
              setDropZone(null);
            }}
          >
            <GripHorizontal size={12} />
          </div>
        ) : null}
        <div className="v3-pane-body">
          {content.kind === "file" ? (
            <PocketErrorBoundary resetKey={leaf.id} title="文件预览加载出错">
              <FileViewer key={leaf.id} tab={content} agent={agent} embedded onHeadState={setFileHead} />
            </PocketErrorBoundary>
          ) : content.kind === "diff" ? (
            <PocketErrorBoundary resetKey={leaf.id} title="差异对比加载出错">
              <DiffTabView
                key={leaf.id}
                tab={{ id: leaf.id, ...content }}
              />
            </PocketErrorBoundary>
          ) : content.kind === "web" ? (
            <PocketErrorBoundary resetKey={leaf.id} title="网页加载出错">
              <WebPane
                key={content.webId}
                tab={{ id: content.webId, url: content.url }}
                active={visible && tabActive}
                layoutKey={layoutKey}
                onChange={(patch) => updateWebPane(tabId, leaf.id, patch)}
              />
            </PocketErrorBoundary>
          ) : (
            <PocketErrorBoundary resetKey={`${content.agentKey}:${leaf.id}`} title="会话视图加载出错">
              {agent ? (
                <AgentDetailPanel
                  key={agent.key}
                  agent={agent}
                  embedded
                  visible={visible && tabActive}
                  focused={isFocused && visible && tabActive}
                  mode={mode}
                  onModeChange={(m) => setPaneAgentMode(tabId, leaf.id, m)}
                  onSubHeadChange={setSubHead}
                  onBack={() => requestClosePane(tabId, leaf.id)}
                  onOpenWorkbench={() => showPanel("files")}
                />
              ) : (
                <div className="v3-pane-empty">
                  <p>{devices[content.agentKey.split("/")[0] ?? ""]?.online === false ? "这台电脑暂时离线了。" : "这个 Agent 已经结束，或者它的电脑离线了。"}</p>
                  <PocketButton size="sm" variant="soft" onClick={() => requestClosePane(tabId, leaf.id)}>
                    {isSplit ? "关闭此分屏" : "关闭标签"}
                  </PocketButton>
                </div>
              )}
            </PocketErrorBoundary>
          )}
        </div>
        {dropZone && draggingPaneId !== leaf.id ? (
          <div className="v3-split-drop-preview" data-zone={dropZone} aria-hidden />
        ) : null}
      </section>
    </div>
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

const MAX_KEPT_AGENT_TABS = 12;

function TabStage({
  tab,
  tabActive,
  draggingPaneId,
  onDraggingPaneChange,
  onSplitNewTerminal,
}: {
  tab: ShellTab;
  tabActive: boolean;
  draggingPaneId: string | null;
  onDraggingPaneChange: (paneId: string | null) => void;
  onSplitNewTerminal: (tabId: string, paneId: string, direction: SplitDirection) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const splitLayout = useMemo(
    () => computeSplitLayout(tabRootNode(tab), tab.split?.zoomedPaneId),
    [tab],
  );
  const focusedId = focusedLeafOfTab(tab).id;
  const isSplit = splitLayout.leaves.length > 1;
  const zoomedId = tab.split?.zoomedPaneId ?? null;
  return (
    <div ref={stageRef} className="v3-split-stage">
      {splitLayout.leaves.map((item) => (
        <SplitPaneSlot
          key={item.leaf.id}
          tabId={tab.id}
          item={item}
          isSplit={isSplit}
          isFocused={item.leaf.id === focusedId}
          isZoomed={zoomedId === item.leaf.id}
          tabActive={tabActive}
          draggingPaneId={draggingPaneId}
          onDraggingPaneChange={onDraggingPaneChange}
          onSplitNewTerminal={onSplitNewTerminal}
        />
      ))}
      {tabActive
        ? splitLayout.sashes.map((sash) => (
            <SplitSash key={sash.id} tabId={tab.id} sash={sash} stageRef={stageRef} />
          ))
        : null}
    </div>
  );
}

export function ShellMain({
  onNewTerminal,
  onNewAgent,
  onSplitNewTerminal,
}: {
  onNewTerminal: () => void;
  onNewAgent: () => void;
  onSplitNewTerminal: (tabId: string, paneId: string, direction: SplitDirection) => void;
}) {
  const tabs = shellStore.use((s) => s.tabs);
  const rawActive = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const activeBySpace = shellStore.use((s) => s.activeBySpace);
  const agentsMap = liveStore.use((s) => s.agents);
  const spacesMap = liveStore.use((s) => s.spaces);
  const agentByKey = useMemo(() => new Map(allAgents(agentsMap).map((a) => [a.key, a] as const)), [agentsMap]);
  const lookupAgent = useCallback((k: string) => agentByKey.get(k), [agentByKey]);
  const activeId = useMemo(
    () => activeTabIdForSpace({ tabs, active: rawActive, selectedSpace, activeBySpace }, lookupAgent, spacesMap),
    [activeBySpace, lookupAgent, rawActive, selectedSpace, spacesMap, tabs],
  );
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null);
  const keptAgentIdsRef = useRef<string[]>([]);

  const agentTabIds = useMemo(
    () => new Set(tabs.filter((t) => tabLeaves(t).some((l) => l.content.kind === "agent")).map((t) => t.id)),
    [tabs],
  );
  const keptAgentIds = useMemo(() => {
    const pruned = keptAgentIdsRef.current.filter((id) => agentTabIds.has(id));
    const next =
      activeId && agentTabIds.has(activeId)
        ? [activeId, ...pruned.filter((id) => id !== activeId)].slice(0, MAX_KEPT_AGENT_TABS)
        : pruned.slice(0, MAX_KEPT_AGENT_TABS);
    keptAgentIdsRef.current = next;
    return next;
  }, [activeId, agentTabIds]);

  const mountedTabIds = useMemo(() => {
    const set = new Set(keptAgentIds);
    if (activeId) set.add(activeId);
    return set;
  }, [activeId, keptAgentIds]);

  const mountedTabs = useMemo(
    () => tabs.filter((t) => mountedTabIds.has(t.id)),
    [mountedTabIds, tabs],
  );

  // Keep native WebViews from unmounted inactive tabs alive in hidden containers so pages never reload on tab switch.
  const inactiveWebLeaves = useMemo(() => {
    const out: Array<{ tabId: string; leafId: string; webId: string; url: string }> = [];
    for (const t of tabs) {
      if (mountedTabIds.has(t.id)) continue;
      for (const leaf of tabLeaves(t)) {
        if (leaf.content.kind === "web") {
          out.push({ tabId: t.id, leafId: leaf.id, webId: leaf.content.webId, url: leaf.content.url });
        }
      }
    }
    return out;
  }, [mountedTabIds, tabs]);

  return (
    <div className="v3-main">
      {!active ? <EmptyMain onNewTerminal={onNewTerminal} onNewAgent={onNewAgent} /> : null}
      {mountedTabs.map((t) => {
        const isTabActive = t.id === active?.id;
        return (
          <div
            key={t.id}
            style={isTabActive ? { display: "contents" } : { display: "none" }}
            aria-hidden={!isTabActive}
          >
            <TabStage
              tab={t}
              tabActive={isTabActive}
              draggingPaneId={draggingPaneId}
              onDraggingPaneChange={setDraggingPaneId}
              onSplitNewTerminal={onSplitNewTerminal}
            />
          </div>
        );
      })}
      {inactiveWebLeaves.map((w) => (
        <div key={`bg-web:${w.webId}`} style={{ display: "none" }}>
          <WebPane
            tab={{ id: w.webId, url: w.url }}
            active={false}
            onChange={(patch) => updateWebPane(w.tabId, w.leafId, patch)}
          />
        </div>
      ))}
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
  const focusedContent = active ? focusedLeafOfTab(active).content : null;
  const tabAgentKey =
    focusedContent?.kind === "agent" || focusedContent?.kind === "file"
      ? focusedContent.agentKey
      : focusedContent?.kind === "diff"
        ? focusedContent.agentKey ?? null
        : null;
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
        spaceKey: selectedSpace,
        fromSelectedSpace: true,
      };
    }
    const fromTab = tabAgentKey ? withFolder.find((a) => a.key === tabAgentKey) : undefined;
    const fromLast = !tabAgentKey && lastKeyRef.current ? withFolder.find((a) => a.key === lastKeyRef.current) : undefined;
    const picked = fromTab ?? fromLast ?? withFolder[0];
    return {
      agent: picked,
      spaceName: picked ? (agentSpace(picked) || homeFolder(picked.cwd) || "") : "",
      spaceKey: selectedSpace,
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
  const focusedContent = active ? focusedLeafOfTab(active).content : null;

  return useMemo(() => {
    if (focusedContent?.kind === "diff") {
      return {
        deviceId: focusedContent.deviceId,
        agent: filesTarget.agent,
        cwd: focusedContent.cwd,
        spaceName: focusedContent.cwd.split(/[\\/]/).filter(Boolean).pop() || "",
        spaceKey: focusedContent.spaceKey ?? selectedSpace,
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
  }, [devices, filesTarget, focusedContent, selectedSpace, spacesMap]);
}

function joinAgentAbsPath(cwd: string | undefined, relPath: string): string | undefined {
  const trimmedRel = relPath.trim();
  if (!trimmedRel) return undefined;
  if (isAbsoluteOrHomePath(trimmedRel)) return trimmedRel;
  const cleanCwd = cwd?.trim().replace(/[\\/]+$/, "");
  if (!cleanCwd) return undefined;
  const cleanRel = trimmedRel.replace(/^\.\//, "");
  return `${cleanCwd}/${cleanRel}`;
}

function FilesPanel({ agent, spaceName, spaceKey, fromSelectedSpace }: ReturnType<typeof useFilesTarget>) {
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
      <FileTree
        key={`${agent.deviceId}:${agent.cwd}`}
        agent={agent}
        onOpen={(path, name, absPath) =>
          openFileTab(agent.key, path, name, {
            absPath: absPath ?? joinAgentAbsPath(agent.cwd, path),
            spaceKey,
          })
        }
        onOpenSplit={(path, name, direction, absPath) =>
          splitActivePaneWithContent(direction, {
            kind: "file",
            agentKey: agent.key,
            path,
            title: name,
            ...(absPath ?? joinAgentAbsPath(agent.cwd, path)
              ? { absPath: absPath ?? joinAgentAbsPath(agent.cwd, path) }
              : {}),
            spaceKey: spaceKey ?? shellStore.get().selectedSpace,
          })
        }
      />
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
    const merger = createBufferedEventMerger((batch) => {
      if (alive) setEvents((prev) => mergeConvEvents(prev, batch));
    });

    void rpcCall(parentAgent.deviceId, "session.events", { agent: aside.agentKey, sub: current.key, limit: 200 })
      .then((res) => {
        if (alive) merger.onInitialPage(res.events);
      })
      .catch(() => {
        if (alive) merger.onInitialReady();
      });

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
          merger.onStreamEvent(ev.event as ConvEvent);
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
      merger.dispose();
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
  const spacesMap = liveStore.use((s) => s.spaces);
  const server = settingsStore.use((s) => s.server);
  const showShells = settingsStore.use((s) => s.showShells);
  const tabs = shellStore.use((s) => s.tabs);
  const rawActive = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const activeBySpace = shellStore.use((s) => s.activeBySpace);
  const statusAgentByKey = useMemo(() => new Map(allAgents(agentsMap).map((a) => [a.key, a] as const)), [agentsMap]);
  const statusActiveId = useMemo(
    () => activeTabIdForSpace({ tabs, active: rawActive, selectedSpace, activeBySpace }, (k) => statusAgentByKey.get(k), spacesMap),
    [activeBySpace, rawActive, selectedSpace, spacesMap, statusAgentByKey, tabs],
  );
  const activeTab = useMemo(() => tabs.find((t) => t.id === statusActiveId) ?? null, [statusActiveId, tabs]);
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
  const focusedTabContent = activeTab ? focusedLeafOfTab(activeTab).content : null;
  const agent = useAgent(
    focusedTabContent && focusedTabContent.kind !== "web" ? (focusedTabContent.agentKey ?? null) : null,
  );

  const all = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);
  const blocked = all.filter((a) => listGroup(a, devices) === "blocked").length;
  const [selDevice, selSpace] = selectedSpace ? (selectedSpace.split("\u0000") as [string, string]) : [null, null];
  const validSpace = Boolean(
    selectedSpace &&
      selDevice &&
      (all.some((a) => a.deviceId === selDevice && (agentSpace(a) ?? "") === selSpace) ||
        spacesMap[selDevice]?.some((sp) => sp.name === selSpace)),
  );
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
