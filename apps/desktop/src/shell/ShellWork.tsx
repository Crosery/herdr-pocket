import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Bell, Check, ChevronDown, Columns2, Compass, Copy, Equal, ExternalLink, EyeOff, File, FileText, FolderOpen, FolderTree, GitBranch, Globe, GripHorizontal, HelpCircle, Keyboard, Laptop, Layers, Maximize2, MessageSquare, Minimize2, MoreHorizontal, PanelTop, Pencil, Plus, Rows2, ScreenShare, Search, ShieldAlert, Sparkles, SquareArrowOutUpRight, Terminal, Trash2, X } from "lucide-react";
import type { Agent, ConvEvent, PortalEgoSpaceState, SubSession } from "@herdr-pocket/protocol";
import { PocketButton, PocketErrorBoundary, PocketInput, PocketModal, PocketSelect, overlayStore, useToast } from "../components/PocketUI";
import { AgentPortsPopover } from "../components/AgentPortsPopover";
import { ChatTimelineRows } from "../components/ChatTimeline";
import { DiffTabView, GitPanel } from "../components/GitPanel";
import { XiaoyangOrb, VendorIcon, mascotAssetPath, resolveCallMascotMood, resolveVendor } from "../components/MascotAndVendor";
import { PortalTabPane } from "../components/PortalTabPane";
import { PortalViewerModal } from "../components/PortalViewerModal";
import { serverLabel } from "../components/Sidebar";
import { SubagentCatalogTrigger, SubagentHeaderLineage, SubagentReadOnlyBar, subLabel } from "../components/SubagentNav";
import { prettyHotkey } from "../components/VoiceInput";
import { AgentDetailPanel, type SubagentHeadInfo } from "../views/AgentsView";
import { FileTree, FileViewer, WebPane, type FileViewerHeadState } from "../views/WorkbenchView";
import { assistantStore, loadAssistant } from "../lib/assistant";
import {
  browserSpacesStore,
  closeBrowserTab,
  createUserBrowserSpace,
  deleteBrowserSpace,
  openBrowserTab,
  selectBrowserSpace,
  selectBrowserTab,
  updateBrowserTab,
  useBrowserSpaces,
} from "../lib/browserSpaces";
import { assetUrl, copyToClipboard, detectPlatform, isH5Web, isTauri } from "../lib/bridge";
import { restoreUpdatePrompt, updateStore } from "../lib/updates";
import {
  ATTENTION_CATEGORY_META,
  attentionStore,
  clearAllAttentionItems,
  dismissAttentionItem,
  jumpToAttentionAgent,
  jumpToNextAttentionItem,
  type AttentionCategory,
} from "../lib/attentionCenter";
import { createBufferedEventMerger, foldConvEvents, mergeConvEvents } from "../lib/chatFold";
import { useClientConfig } from "../lib/config";
import { endPaneDrag, endPanelDrag, endTabDrag, endWorkspaceDrag, hasPaneDrag, hasPanelDrag, hasTabDrag, hasWorkspaceDrag, readPaneDrag, readPanelDrag, readTabDrag, readWorkspaceDrag, startPaneDrag, startPanelDrag, startTabDrag } from "../lib/fileDrag";
import { localHostIdStore, useLocalHostDeviceId } from "../lib/fonts";
import { canActOnLocalFile, isAbsoluteOrHomePath, openLocalFileDefault, openLocalFileInBuiltinBrowser, revealInFolderLabel, revealInFolderShortLabel, revealLocalFile } from "../lib/localFileActions";
import { isMockServer } from "../lib/mock";
import {
  beginSplitMotion,
  collapsedEntryUnitRect,
  easeOutQuart,
  isInteractiveResizeActive,
  isSplitMotionActive,
  lerpUnitRect,
  setInteractiveResizeActive,
  SPLIT_MOTION_MS,
  unitRectToCss,
} from "./splitMotion";
import { registerMountedTabsCounter, reportSplitTransitionPerf } from "../lib/perfTelemetry";
import { resizeSplitPair, type CssRect, type SplitNode, type UnitRect } from "./splitTree";
import { native } from "../lib/native";
import { openAgentFileTarget } from "../lib/openFileTarget";
import { openPortalSurface } from "../lib/portalClient";
import { pingRelay, refreshHostSpaces, rpcCall, subscribeStream } from "../lib/relay";
import { agentSpace, agentTitle, allAgents, createStore, findAgent, liveStore, lookupAgentByKey, settingsStore, spacedTitle } from "../lib/store";
import { dismissVoiceMessage, hangupVoiceCall, startVoiceCall, voiceCallStore } from "../lib/voiceCall";
import { homeFolder, listGroup, type ListGroup } from "./agentInfo";
import { formatHerdrTabLabel } from "./herdrDoc";
import { StatusMark } from "./ShellSidebar";
import {
  activeTabIdForSpace,
  closeTab,
  closeTabPane,
  commitTabSplitRoot,
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
  setActiveTab,
  setPalette,
  setPaneAgentMode,
  setPanelWidth,
  setPeek,
  shellStore,
  showPanel,
  splitActivePaneWithContent,
  splitTabPane,
  stableSplitLeafKeys,
  swapTabPanes,
  tabLeaves,
  tabRootNode,
  tabSpaceKey,
  togglePanel,
  toggleZoomTabPane,
  unsplitTabToTabs,
  updatePortalTabActive,
  updateWebPane,
  visibleTabsForSpace,
  type AgentPaneMode,
  type PaneContent,
  type PanelId,
  type ShellTab,
  type SplitDirection,
  type SplitLeafLayout,
  type SplitLeafNode,
  type SplitSashLayout,
} from "./shellStore";
import { shortcutText, type ShortcutId } from "./shortcuts";
import { SpatialHint } from "./useModifierHoldHints";
import "../styles/btw-slash.css";

const AssistantView = lazy(() => import("../views/AssistantView").then((m) => ({ default: m.AssistantView })));

function useAgent(key: string | null | undefined): Agent | undefined {
  return liveStore.use((s) => lookupAgentByKey(s.agents, key));
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

const TabChip = memo(function TabChip({
  tab,
  index,
  total,
  active,
  hasSpaceFilter,
  isRenaming,
  isDragging,
  dropSide,
  leadAgent: agent,
  group,
  registerTabRef,
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
  isDragging: boolean;
  dropSide: "before" | "after" | null;
  leadAgent: Agent | undefined;
  group: ListGroup | null;
  registerTabRef: (id: string, el: HTMLDivElement | null) => void;
  onStartRename: (id: string) => void;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onDragStartTab: (e: ReactDragEvent<HTMLDivElement>, id: string) => void;
  onDragEndTab: () => void;
  onDragOverTab: (e: ReactDragEvent<HTMLDivElement>, id: string) => void;
  onDropTab: (e: ReactDragEvent<HTMLDivElement>, index: number) => void;
  onMenu: (e: ReactMouseEvent, tab: ShellTab) => void;
}) {
  const leaves = useMemo(() => tabLeaves(tab), [tab]);
  const primary = focusedLeafOfTab(tab);
  const primaryContent = primary.content;
  const leadLeaf = useMemo(
    () => (primaryContent.kind === "agent" ? primary : leaves.find((l) => l.content.kind === "agent") ?? primary),
    [leaves, primary, primaryContent.kind],
  );
  const leadContent = leadLeaf.content;
  const attachTabRef = useCallback(
    (el: HTMLDivElement | null) => registerTabRef(tab.id, el),
    [registerTabRef, tab.id],
  );
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
  return (
    <div
      ref={attachTabRef}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      draggable={total > 1 && !isRenaming}
      data-tauri-drag-region="false"
      className={`v3-tab${active ? " active" : ""}${primaryContent.kind === "agent" && !agent ? " gone" : ""}${isDragging ? " dragging" : ""}${dropSide ? ` drop-${dropSide}` : ""}`}
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
                  : primaryContent.kind === "portal"
                    ? primaryContent.title
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
      ) : primaryContent.kind === "portal" ? (
        <PanelTop size={14} />
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
      <SpatialHint
        text={index < 8 ? String(index + 1) : total >= 9 && index === total - 1 ? "9" : ""}
        corner="right"
        className="v3-tab-hint"
      />
      {active ? <SpatialHint shortcut="closeWholeTab" corner="tr" className="hide-on-bare-mod" /> : null}
      <button
        className="v3-tab-x"
        aria-label={`关闭 ${title}`}
        title={`关闭整个标签（${shortcutText("closeWholeTab")}）`}
        onClick={(e) => {
          e.stopPropagation();
          requestCloseShellTab(tab);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
});

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

export const ShellTabs = memo(function ShellTabs({ onNewTerminal, onNewAgent, padForLights }: { onNewTerminal: () => void; onNewAgent: () => void; padForLights: boolean }) {
  const toast = useToast();
  const tabs = shellStore.use((s) => s.tabs);
  const rawActive = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);
  const activeBySpace = shellStore.use((s) => s.activeBySpace);
  const panel = shellStore.use((s) => s.panel);
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
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
  const prevTabSpaceRef = useRef<string | null>(selectedSpace);
  const prevTabIdsKeyRef = useRef<string>("");
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
  const tabChipMeta = useMemo(() => {
    const rank: Record<ListGroup, number> = { blocked: 4, working: 3, done: 2, idle: 1, offline: 0 };
    const map = new Map<string, { leadAgent: Agent | undefined; group: ListGroup | null }>();
    for (const t of visibleTabs) {
      const leaves = tabLeaves(t);
      const primary = focusedLeafOfTab(t);
      const leadLeaf =
        primary.content.kind === "agent"
          ? primary
          : (leaves.find((l) => l.content.kind === "agent") ?? primary);
      const leadAgent = leadLeaf.content.kind === "agent" ? agentByKey.get(leadLeaf.content.agentKey) : undefined;
      let best: ListGroup | null = null;
      for (const leaf of leaves) {
        if (leaf.content.kind !== "agent") continue;
        const a = agentByKey.get(leaf.content.agentKey);
        if (!a) continue;
        const g = listGroup(a, devices);
        if (!best || rank[g] > rank[best]) best = g;
      }
      map.set(t.id, { leadAgent, group: best });
    }
    return map;
  }, [agentByKey, devices, visibleTabs]);

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

  // Smooth FLIP slide animation via Web Animations API only on intra-space tab list additions/removals/reorders.
  useLayoutEffect(() => {
    const nextTabIdsKey = visibleTabs.map((t) => t.id).join("\u0001");
    const sameSpace = prevTabSpaceRef.current === selectedSpace;
    const idsChanged = prevTabIdsKeyRef.current !== "" && nextTabIdsKey !== prevTabIdsKeyRef.current;
    prevTabSpaceRef.current = selectedSpace;
    prevTabIdsKeyRef.current = nextTabIdsKey;

    const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shouldAnimate = !reduced && sameSpace && idsChanged && prevRectsRef.current.size > 0;
    if (!shouldAnimate) {
      if (idsChanged || !sameSpace || prevRectsRef.current.size === 0) {
        const raf = requestAnimationFrame(() => {
          const nextRects = new Map<string, number>();
          for (const t of visibleTabs) {
            const el = tabElsRef.current.get(t.id);
            if (el) nextRects.set(t.id, el.getBoundingClientRect().left);
          }
          prevRectsRef.current = nextRects;
        });
        return () => cancelAnimationFrame(raf);
      }
      return;
    }

    const nextRects = new Map<string, number>();
    for (const t of visibleTabs) {
      const el = tabElsRef.current.get(t.id);
      if (!el) continue;
      tabAnimsRef.current.get(el)?.cancel();
      tabAnimsRef.current.delete(el);
      nextRects.set(t.id, el.getBoundingClientRect().left);
    }
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
    prevRectsRef.current = nextRects;
  }, [selectedSpace, visibleTabs]);

  const panelBtn = (id: PanelId, label: string, Icon: typeof Plus, keys?: string) => (
    <button
      className={`v3-panel-btn has-hint${panel === id ? " on" : ""}`}
      aria-pressed={panel === id}
      title={keys ? `${label}（${keys}）` : label}
      onClick={() => togglePanel(id)}
    >
      <Icon size={14} />
      <span>{label}</span>
      {keys ? <SpatialHint text={keys} corner="tr" /> : null}
    </button>
  );

  const registerTabRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) tabElsRef.current.set(id, el);
    else tabElsRef.current.delete(id);
  }, []);

  const handleStartRename = useCallback((id: string) => setRenamingId(id), []);
  const handleCommitRename = useCallback((id: string, nextName: string) => {
    setRenamingId(null);
    renameShellTab(id, nextName);
  }, []);
  const handleCancelRename = useCallback(() => setRenamingId(null), []);
  const handleTabMenu = useCallback((e: ReactMouseEvent, tab: ShellTab) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, tab });
  }, []);

  const draggingIdRef = useRef(draggingId);
  draggingIdRef.current = draggingId;
  const visibleTabsRef = useRef(visibleTabs);
  visibleTabsRef.current = visibleTabs;
  const dropTargetRef = useRef(dropTarget);
  dropTargetRef.current = dropTarget;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const selectedSpaceRef = useRef(selectedSpace);
  selectedSpaceRef.current = selectedSpace;

  const onDragStartTab = useCallback((e: ReactDragEvent<HTMLDivElement>, id: string) => {
    setDraggingId(id);
    startTabDrag(e, id);
  }, []);

  const onDragEndTab = useCallback(() => {
    setDraggingId(null);
    setDropTarget(null);
    endTabDrag();
  }, []);

  const onDragOverTab = useCallback((e: ReactDragEvent<HTMLDivElement>, id: string) => {
    if (hasWorkspaceDrag(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setFileDropOver(true);
      return;
    }
    if (!hasTabDrag(e) && !hasPanelDrag(e) && !hasPaneDrag(e)) return;
    if (id === draggingIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const side: "before" | "after" = e.clientX - rect.left < rect.width / 2 ? "before" : "after";
    setDropTarget((prev) => (prev?.id === id && prev.side === side ? prev : { id, side }));
  }, []);

  const handleDropAt = useCallback((e: ReactDragEvent<HTMLDivElement>, targetTabId?: string, side?: "before" | "after") => {
    const curTabs = tabsRef.current;
    const curVisible = visibleTabsRef.current;
    const curSpace = selectedSpaceRef.current;
    setFileDropOver(false);
    const paneItem = readPaneDrag(e);
    if (paneItem) {
      e.preventDefault();
      e.stopPropagation();
      endPaneDrag();
      setDropTarget(null);
      let insertBeforeTabId: string | undefined;
      if (targetTabId && side) {
        const idx = curTabs.findIndex((t) => t.id === targetTabId);
        if (idx >= 0) {
          insertBeforeTabId = side === "before" ? targetTabId : curTabs[idx + 1]?.id;
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
        openFileTab(wsItem.agentKey, wsItem.relPath, wsItem.name, { absPath: wsItem.absPath, spaceKey: curSpace });
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
        const idx = curTabs.findIndex((t) => t.id === targetTabId);
        if (idx >= 0) {
          insertBeforeId = side === "before" ? targetTabId : curTabs[idx + 1]?.id;
        }
      }
      if (panelItem.kind === "browser") {
        openWebTab(panelItem.url, panelItem.title, {
          spaceKey: panelItem.spaceKey ?? curSpace,
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

    const fromId = readTabDrag(e) ?? draggingIdRef.current;
    if (!fromId) return;
    e.preventDefault();
    e.stopPropagation();
    if (targetTabId && side) {
      moveTabRelative(fromId, targetTabId, side);
    } else if (curVisible.length > 0) {
      moveTabRelative(fromId, curVisible[curVisible.length - 1]!.id, "after");
    } else {
      moveTab(fromId, curTabs.length - 1);
    }
    onDragEndTab();
  }, [onDragEndTab, toast]);

  const onDropTab = useCallback((e: ReactDragEvent<HTMLDivElement>, targetIdx: number) => {
    const target = visibleTabsRef.current[targetIdx];
    const curDrop = dropTargetRef.current;
    const side = target && curDrop?.id === target.id ? curDrop.side : "before";
    handleDropAt(e, target?.id, side);
  }, [handleDropAt]);

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
        {visibleTabs.map((t, i) => {
          const meta = tabChipMeta.get(t.id);
          return (
            <TabChip
              key={t.id}
              tab={t}
              index={i}
              total={visibleTabs.length}
              active={t.id === active}
              hasSpaceFilter={Boolean(selectedSpace)}
              isRenaming={renamingId === t.id}
              isDragging={draggingId === t.id}
              dropSide={dropTarget?.id === t.id ? dropTarget.side : null}
              leadAgent={meta?.leadAgent}
              group={meta?.group ?? null}
              registerTabRef={registerTabRef}
              onStartRename={handleStartRename}
              onCommitRename={handleCommitRename}
              onCancelRename={handleCancelRename}
              onDragStartTab={onDragStartTab}
              onDragEndTab={onDragEndTab}
              onDragOverTab={onDragOverTab}
              onDropTab={onDropTab}
              onMenu={handleTabMenu}
            />
          );
        })}
      </div>
      <button
        className="v3-icon-btn has-hint"
        aria-label="新建终端"
        title={`新建终端（${shortcutText("newAgent")}）· 右键查看更多`}
        onClick={onNewTerminal}
        onContextMenu={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setNewMenu({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <Plus size={16} />
        <SpatialHint text={shortcutText("newAgent")} corner="tr" />
      </button>
      <button
        className="v3-icon-btn small"
        aria-label="更多新建选项"
        title="新建终端、Agent、网页或文件…"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setNewMenu(newMenu ? null : { x: r.left, y: r.bottom + 4 });
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ChevronDown size={13} />
      </button>
      <div className="v3-tabs-drag-gap" aria-hidden="true" />
      <div className="v3-tabs-right">
        {panelBtn("files", "文件", FolderTree, shortcutText("togglePanel"))}
        {panelBtn("git", "Git", GitBranch, shortcutText("toggleGit"))}
        {panelBtn("browser", "浏览器", Globe, shortcutText("toggleBrowser"))}
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
              keys={shortcutText(isMultiPane ? "closeWholeTab" : "closeTab")}
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
});

// Panes ----------------------------------------------------------------------------

function resolveAgentMode(tabMode: AgentPaneMode | undefined, _agent: Agent | undefined): AgentPaneMode {
  return tabMode ?? "term";
}

function ModeSwitchIcons({
  mode,
  onModeChange,
  termAttention = false,
}: {
  mode: AgentPaneMode;
  onModeChange: (m: AgentPaneMode) => void;
  termAttention?: boolean;
}) {
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
        title={termAttention ? "终端模式（当前有子面板或等待输入）" : "终端模式"}
        onClick={() => onModeChange("term")}
      >
        <Terminal size={13} />
        {termAttention ? <span className="term-attn-dot" aria-hidden /> : null}
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
  isFocused = true,
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
  isFocused?: boolean;
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
          if (fileHead?.openInBrowserUrl && !canRevealLocal) {
            openWebTab(fileHead.openInBrowserUrl, content.title, { spaceKey: shellStore.get().selectedSpace });
            return;
          }
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
  } else if (content.kind === "portal") {
    icon = <PanelTop size={14} />;
    name = content.title;
    sub = agent ? spacedTitle(agent) : "实时预览合集";
    subTitle = sub;
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
        {content.kind === "agent" && group === "offline" ? <span className="v3-pane-off">电脑离线</span> : null}
        {content.kind === "agent" && agent && !inSubView && (agent.listeningPorts?.length ?? 0) > 0 ? (
          <AgentPortsPopover agent={agent} tabId={tabId} paneId={paneId} />
        ) : null}
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
        ) : !canRevealLocal && content.kind === "file" && fileHead?.openInBrowserUrl ? (
          <button
            type="button"
            className="v3-pane-tool-btn"
            title="用内置浏览器打开"
            onClick={handleOpenBuiltinBrowser}
          >
            <Globe size={12} />
            <span>内置浏览器</span>
          </button>
        ) : null}
        <div className="v3-pane-actions">
          {content.kind === "agent" && agent && mode && onModeChange ? (
            <button
              type="button"
              className="v3-icon-btn small has-hint v3-act-mode"
              aria-label={oppositeMode === "chat" ? "切换到对话视图" : "切换到终端视图"}
              title={`${
                oppositeMode === "chat"
                  ? "切换到对话视图"
                  : agent.subscreen
                    ? "切换到终端视图（终端正打开子面板，发消息将自动返回）"
                    : agent.status === "blocked"
                      ? "切换到终端视图（终端正等待输入）"
                      : "切换到终端视图"
              }（${shortcutText("togglePaneMode")}）`}
              onClick={() => onModeChange(oppositeMode)}
            >
              {oppositeMode === "chat" ? <MessageSquare size={13} /> : <Terminal size={13} />}
              {oppositeMode === "term" && (Boolean(agent.subscreen) || agent.status === "blocked") ? (
                <span className="term-attn-dot" aria-hidden />
              ) : null}
              {isFocused ? <SpatialHint text={shortcutText("togglePaneMode")} corner="bottom" /> : null}
            </button>
          ) : null}
          {content.kind === "agent" && agent ? (
            <button
              type="button"
              className="v3-icon-btn small v3-act-secondary"
              aria-label="跨端窗口、浏览器与文件回传"
              title="跨端窗口、浏览器与文件回传（P2P）"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("pocket:agent-action", {
                      detail: { agentKey: agent.key, action: "openPortalLauncher" },
                    }),
                  );
                }
              }}
            >
              <ScreenShare size={13} />
            </button>
          ) : null}
          {content.kind === "agent" && agent && mode === "term" ? (
            <button
              type="button"
              className="v3-icon-btn small v3-act-secondary"
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
              className="v3-icon-btn small v3-act-secondary"
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
            className="v3-icon-btn small has-hint v3-act-split"
            aria-label="向右分屏"
            title={`向右分屏（${shortcutText("splitRight")}）`}
            onClick={() => onSplitNewTerminal(tabId, paneId, "right")}
          >
            <Columns2 size={13} />
            {isFocused ? <SpatialHint text={shortcutText("splitRight")} corner="bottom" /> : null}
          </button>
          <button
            type="button"
            className="v3-icon-btn small has-hint v3-act-split"
            aria-label="向下分屏"
            title={`向下分屏（${shortcutText("splitDown")}）`}
            onClick={() => onSplitNewTerminal(tabId, paneId, "down")}
          >
            <Rows2 size={13} />
            {isFocused ? <SpatialHint text={shortcutText("splitDown")} corner="bottom" className="hide-on-bare-mod" /> : null}
          </button>
          {isSplit || isZoomed ? (
            <button
              type="button"
              className={`v3-icon-btn small has-hint v3-act-zoom${isZoomed ? " on" : ""}`}
              aria-label={isZoomed ? "还原分屏布局" : "最大化此分屏"}
              title={`${isZoomed ? "还原分屏布局" : "最大化此分屏"}（${shortcutText("zoomPane")}）`}
              onClick={onToggleZoom}
            >
              {isZoomed ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              {isFocused ? <SpatialHint shortcut="zoomPane" corner="bottom" className="hide-on-bare-mod" /> : null}
            </button>
          ) : null}
          <button
            type="button"
            className="v3-icon-btn small v3-act-more"
            aria-label="更多分屏操作"
            title="更多操作（分屏 / 跨端回传 / 缩放）"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setPaneMenu(paneMenu ? null : { x: r.left, y: r.bottom + 4 });
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <MoreHorizontal size={13} />
          </button>
          <button
            type="button"
            className="v3-icon-btn small has-hint v3-act-close"
            aria-label={isSplit ? "关闭此分屏" : "关闭标签"}
            title={`${isSplit ? "关闭此分屏" : "关闭标签"}（${shortcutText("closeTab")}）`}
            onClick={onClose}
          >
            <X size={13} />
            {isFocused ? <SpatialHint text={shortcutText("closeTab")} corner="bottom" /> : null}
            {isFocused && isSplit ? <SpatialHint shortcut="unsplitTab" corner="bottom" className="hide-on-bare-mod" /> : null}
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
          ) : !canRevealLocal && content.kind === "file" && fileHead?.openInBrowserUrl ? (
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
            keys={shortcutText("closeTab")}
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
  sashElsRef,
  onStartDrag,
  onMoveDrag,
  onEndDrag,
  onDraggingChange,
}: {
  tabId: string;
  sash: SplitSashLayout;
  stageRef: React.RefObject<HTMLDivElement | null>;
  sashElsRef: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onStartDrag: () => void;
  onMoveDrag: (branchId: string, index: number, deltaFraction: number) => void;
  onEndDrag: () => void;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const dragRef = useRef<{ lastPos: number; spanPx: number } | null>(null);
  const pendingDeltaRef = useRef(0);
  const rafIdRef = useRef(0);
  const [dragging, setDragging] = useState(false);

  const attachRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) sashElsRef.current.set(sash.id, el);
      else sashElsRef.current.delete(sash.id);
    },
    [sash.id, sashElsRef],
  );

  const flushDragDelta = useCallback(() => {
    rafIdRef.current = 0;
    const d = dragRef.current;
    const delta = pendingDeltaRef.current;
    pendingDeltaRef.current = 0;
    if (!d || Math.abs(delta) < 0.25) return;
    onMoveDrag(sash.branchId, sash.index, delta / d.spanPx);
  }, [onMoveDrag, sash.branchId, sash.index]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
      pendingDeltaRef.current = 0;
      if (dragRef.current) {
        dragRef.current = null;
        delete document.documentElement.dataset.splitResizing;
        onEndDrag();
        onDraggingChange?.(false);
        overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
      }
    };
  }, [onDraggingChange, onEndDrag]);

  const endDrag = () => {
    if (!dragRef.current) return;
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      flushDragDelta();
    }
    dragRef.current = null;
    delete document.documentElement.dataset.splitResizing;
    setDragging(false);
    onEndDrag();
    onDraggingChange?.(false);
    overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
  };

  return (
    <div
      ref={attachRef}
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
        window.getSelection()?.removeAllRanges();
        const rect = stageRef.current?.getBoundingClientRect();
        const totalPx = sash.axis === "row" ? (rect?.width ?? window.innerWidth) : (rect?.height ?? window.innerHeight);
        const spanPx = Math.max(140, totalPx * Math.max(0.1, sash.branchSpanScale));
        dragRef.current = { lastPos: sash.axis === "row" ? e.clientX : e.clientY, spanPx };
        pendingDeltaRef.current = 0;
        document.documentElement.dataset.splitResizing = sash.axis;
        setDragging(true);
        onStartDrag();
        onDraggingChange?.(true);
        overlayStore.set((p) => ({ open: p.open + 1 }));
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
        const d = dragRef.current;
        if (!d) return;
        const pos = sash.axis === "row" ? e.clientX : e.clientY;
        const deltaPx = pos - d.lastPos;
        if (Math.abs(deltaPx) < 0.5) return;
        d.lastPos = pos;
        pendingDeltaRef.current += deltaPx;
        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(flushDragDelta);
        }
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}

function directionalShortcutsForSibling(
  focusedUnit: UnitRect,
  siblingUnit: UnitRect,
): [ShortcutId, ShortcutId] {
  const dx = siblingUnit.x + siblingUnit.w / 2 - (focusedUnit.x + focusedUnit.w / 2);
  const dy = siblingUnit.y + siblingUnit.h / 2 - (focusedUnit.y + focusedUnit.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["focusPaneRight", "swapPaneRight"] : ["focusPaneLeft", "swapPaneLeft"];
  }
  return dy >= 0 ? ["focusPaneDown", "swapPaneDown"] : ["focusPaneUp", "swapPaneUp"];
}

const SplitPaneSlot = memo(function SplitPaneSlot({
  tabId,
  paneKey,
  item,
  isSplit,
  isFocused,
  isZoomed,
  focusedUnit,
  tabActive,
  portalHost = true,
  draggingPaneId,
  slotElsRef,
  onDraggingPaneChange,
  onSplitNewTerminal,
}: {
  tabId: string;
  paneKey: string;
  item: SplitLeafLayout;
  isSplit: boolean;
  isFocused: boolean;
  isZoomed: boolean;
  focusedUnit?: UnitRect | null;
  tabActive: boolean;
  portalHost?: boolean;
  draggingPaneId: string | null;
  slotElsRef?: React.MutableRefObject<Map<string, HTMLDivElement>>;
  onDraggingPaneChange: (paneId: string | null) => void;
  onSplitNewTerminal: (tabId: string, paneId: string, direction: SplitDirection) => void;
}) {
  const { leaf, visible, css } = item;
  const { content } = leaf;
  const agentKey =
    content.kind === "agent" || content.kind === "file" || content.kind === "portal"
      ? content.agentKey
      : content.kind === "diff"
        ? content.agentKey
        : undefined;
  const agent = useAgent(agentKey);
  const hostDeviceId = agentKey ? (agentKey.split("/")[0] ?? "") : "";
  const hostOffline = liveStore.use((s) => (hostDeviceId ? s.devices[hostDeviceId]?.online === false : false));
  const [subHead, setSubHead] = useState<SubagentHeadInfo | null>(null);
  const [fileHead, setFileHead] = useState<FileViewerHeadState | null>(null);
  const [dropZone, setDropZone] = useState<SplitDropZone | null>(null);
  const [expandedPortalModal, setExpandedPortalModal] = useState<{ hostId: string; portalId: string | null; agent?: Agent } | null>(null);
  const slotSelectionCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    slotSelectionCleanupRef.current?.();
  }, []);
  const attachSlotRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!slotElsRef) return;
      if (el) slotElsRef.current.set(leaf.id, el);
      else slotElsRef.current.delete(leaf.id);
    },
    [leaf.id, slotElsRef],
  );

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
        const targetAgent = lookupAgentByKey(liveStore.get().agents, panelItem.agentKey);
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

  const navPair =
    isSplit && !isFocused && !isZoomed && focusedUnit && visible
      ? directionalShortcutsForSibling(focusedUnit, item.unit)
      : null;

  return (
    <div
      ref={attachSlotRef}
      className="v3-split-slot"
      style={visible ? css : { ...css, display: "none" }}
      onPointerDownCapture={(e) => {
        if (!isFocused) focusTabPane(tabId, leaf.id);
        if (!isSplit || e.button !== 0) return;
        slotSelectionCleanupRef.current?.();
        const slotEl = e.currentTarget;
        const stageEl = slotEl.parentElement;
        if (!stageEl) return;
        slotEl.classList.add("is-select-owner");
        stageEl.classList.add("is-select-locked");
        const unlock = () => {
          slotEl.classList.remove("is-select-owner");
          stageEl.classList.remove("is-select-locked");
          window.removeEventListener("pointerup", unlock, true);
          window.removeEventListener("pointercancel", unlock, true);
          window.removeEventListener("dragstart", unlock, true);
          window.removeEventListener("blur", unlock);
          if (slotSelectionCleanupRef.current === unlock) {
            slotSelectionCleanupRef.current = null;
          }
        };
        slotSelectionCleanupRef.current = unlock;
        window.addEventListener("pointerup", unlock, true);
        window.addEventListener("pointercancel", unlock, true);
        window.addEventListener("dragstart", unlock, true);
        window.addEventListener("blur", unlock);
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
          isFocused={isFocused}
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
            <PocketErrorBoundary resetKey={paneKey} title="文件预览加载出错">
              <FileViewer key={paneKey} tab={content} agent={agent} embedded onHeadState={setFileHead} />
            </PocketErrorBoundary>
          ) : content.kind === "diff" ? (
            <PocketErrorBoundary resetKey={paneKey} title="差异对比加载出错">
              <DiffTabView
                key={paneKey}
                tab={{ id: leaf.id, ...content }}
              />
            </PocketErrorBoundary>
          ) : content.kind === "portal" ? (
            <PocketErrorBoundary resetKey={paneKey} title="预览合集加载出错">
              <PortalTabPane
                hostId={content.hostId}
                agentKey={content.agentKey}
                agent={agent}
                activePortalId={content.activePortalId}
                onSelectPortalId={(pid) => updatePortalTabActive(tabId, leaf.id, pid)}
                onExpandModal={(pid, hid) => {
                  setExpandedPortalModal({ hostId: hid, portalId: pid, agent });
                }}
              />
            </PocketErrorBoundary>
          ) : content.kind === "web" ? (
            <PocketErrorBoundary resetKey={paneKey} title="网页加载出错">
              <WebPane
                key={content.webId}
                tab={{ id: content.webId, url: content.url }}
                active={visible && tabActive}
                layoutKey={layoutKey}
                onChange={(patch) => updateWebPane(tabId, leaf.id, patch)}
              />
            </PocketErrorBoundary>
          ) : (
            <PocketErrorBoundary resetKey={paneKey} title="会话视图加载出错">
              {agent ? (
                <AgentDetailPanel
                  key={agent.key}
                  agent={agent}
                  embedded
                  portalHost={portalHost}
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
                  <p>{hostOffline ? "这台电脑暂时离线了。" : "这个 Agent 已经结束，或者它的电脑离线了。"}</p>
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
        {navPair ? (
          <div className="v3-pane-nav-hint-stack" aria-hidden="true">
            <SpatialHint shortcut={navPair[0]} corner="stack" className="v3-pane-nav-hint" />
            <SpatialHint shortcut={navPair[1]} corner="stack" className="v3-pane-nav-hint" />
          </div>
        ) : null}
      </section>
      {expandedPortalModal ? (
        <PortalViewerModal
          open
          onOpenChange={(next) => {
            if (!next) setExpandedPortalModal(null);
          }}
          hostId={expandedPortalModal.hostId}
          agent={expandedPortalModal.agent}
          activePortalId={expandedPortalModal.portalId}
          onSelectPortalId={(pid) =>
            setExpandedPortalModal((prev) => (prev ? { ...prev, portalId: pid } : null))
          }
        />
      ) : null}
    </div>
  );
});

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

const MAX_KEPT_AGENT_TABS = 64;
const MAX_KEPT_NON_AGENT_TABS = 12;
const MAX_PREWARMED_AGENT_TABS = 4;

const TabStage = memo(function TabStage({
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
  const portalShellSig = liveStore.use((s) => {
    if (!tabActive) return "";
    const parts: string[] = [];
    for (const item of splitLayout.leaves) {
      if (!item.visible || item.leaf.content.kind !== "agent") continue;
      const key = item.leaf.content.agentKey;
      if (!key) continue;
      parts.push(`${key}:${lookupAgentByKey(s.agents, key)?.isShell ? 1 : 0}`);
    }
    return parts.join("|");
  });
  const slotKeys = useMemo(
    () => stableSplitLeafKeys(splitLayout.leaves.map((x) => x.leaf)),
    [splitLayout.leaves],
  );
  const portalHostPaneIds = useMemo(() => {
    const hosts = new Set<string>();
    if (!tabActive) return hosts;
    const agentsMap = liveStore.get().agents;
    const byAgent = new Map<string, Array<{ id: string; mode: AgentPaneMode }>>();
    for (const item of splitLayout.leaves) {
      if (!item.visible || item.leaf.content.kind !== "agent") continue;
      const key = item.leaf.content.agentKey;
      if (!key) continue;
      const resolvedMode = resolveAgentMode(item.leaf.content.mode, lookupAgentByKey(agentsMap, key));
      const list = byAgent.get(key) ?? [];
      list.push({ id: item.leaf.id, mode: resolvedMode });
      byAgent.set(key, list);
    }
    for (const list of byAgent.values()) {
      const picked = list.find((x) => x.mode === "term") ?? list[0];
      if (picked) hosts.add(picked.id);
    }
    return hosts;
  }, [portalShellSig, splitLayout.leaves, tabActive]);
  const focusedId = focusedLeafOfTab(tab).id;
  const focusedUnit = useMemo(
    () => splitLayout.leaves.find((x) => x.leaf.id === focusedId)?.unit ?? null,
    [focusedId, splitLayout.leaves],
  );
  const isSplit = splitLayout.leaves.length > 1;
  const zoomedId = tab.split?.zoomedPaneId ?? null;
  const [sashDragging, setSashDragging] = useState(false);
  const prevUnitsRef = useRef<Map<string, UnitRect> | null>(null);
  const prevFocusedIdRef = useRef<string | null>(null);
  const slotElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const sashElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const liveRootRef = useRef<SplitNode>(tabRootNode(tab));
  const motionRafRef = useRef<number>(0);

  if (!sashDragging) {
    liveRootRef.current = tabRootNode(tab);
  }

  const applyDirectSplitCss = useCallback(
    (root: SplitNode) => {
      const computed = computeSplitLayout(root, zoomedId);
      for (const item of computed.leaves) {
        const el = slotElsRef.current.get(item.leaf.id);
        if (!el) continue;
        el.style.left = item.css.left;
        el.style.top = item.css.top;
        el.style.width = item.css.width;
        el.style.height = item.css.height;
      }
      for (const sh of computed.sashes) {
        const el = sashElsRef.current.get(sh.id);
        if (!el) continue;
        el.style.left = sh.css.left;
        el.style.top = sh.css.top;
        el.style.width = sh.css.width;
        el.style.height = sh.css.height;
      }
    },
    [zoomedId],
  );

  const handleSashStart = useCallback(() => {
    liveRootRef.current = tabRootNode(tab);
    setInteractiveResizeActive(true);
  }, [tab]);

  const handleSashMove = useCallback(
    (branchId: string, index: number, deltaFraction: number) => {
      const nextRoot = resizeSplitPair(liveRootRef.current, branchId, index, deltaFraction);
      if (nextRoot === liveRootRef.current) return;
      liveRootRef.current = nextRoot;
      applyDirectSplitCss(nextRoot);
    },
    [applyDirectSplitCss],
  );

  const handleSashEnd = useCallback(() => {
    const finalRoot = liveRootRef.current;
    if (finalRoot !== tabRootNode(tab)) {
      commitTabSplitRoot(tab.id, finalRoot);
    }
    setInteractiveResizeActive(false);
  }, [tab]);

  useLayoutEffect(() => {
    const prevUnits = prevUnitsRef.current;
    const prevFocusedId = prevFocusedIdRef.current;
    const nextUnits = new Map<string, UnitRect>();
    for (const item of splitLayout.leaves) {
      nextUnits.set(item.leaf.id, item.unit);
    }
    prevUnitsRef.current = nextUnits;
    prevFocusedIdRef.current = focusedId;

    if (motionRafRef.current) {
      cancelAnimationFrame(motionRafRef.current);
      motionRafRef.current = 0;
    }
    const stageEl = stageRef.current;
    if (stageEl) delete stageEl.dataset.splitAnimating;

    const reducedMotion =
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    if (!stageEl || !prevUnits || sashDragging || zoomedId || reducedMotion || prevUnits.size === nextUnits.size) {
      return;
    }

    const prevFocusedUnit = prevFocusedId ? prevUnits.get(prevFocusedId) : undefined;
    const tracks: Array<{ el: HTMLDivElement; from: UnitRect; to: UnitRect; finalCss: CssRect }> = [];
    for (const item of splitLayout.leaves) {
      if (!item.visible) continue;
      const el = slotElsRef.current.get(item.leaf.id);
      if (!el) continue;
      const from = prevUnits.get(item.leaf.id) ?? collapsedEntryUnitRect(item.unit, prevFocusedUnit);
      tracks.push({ el, from, to: item.unit, finalCss: item.css });
    }
    if (!tracks.length) return;

    beginSplitMotion(SPLIT_MOTION_MS + 25);
    reportSplitTransitionPerf(nextUnits.size > prevUnits.size ? "open" : "close", nextUnits.size);

    const applyRect = (el: HTMLDivElement, css: CssRect) => {
      el.style.left = css.left;
      el.style.top = css.top;
      el.style.width = css.width;
      el.style.height = css.height;
    };

    stageEl.dataset.splitAnimating = "true";
    // Paint t=0 synchronously before browser composite so there is zero 1-frame snap.
    for (const tr of tracks) {
      applyRect(tr.el, unitRectToCss(tr.from));
    }

    const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
    const step = (now: number) => {
      const elapsed = Math.max(0, now - startTime);
      const t = Math.min(1, elapsed / SPLIT_MOTION_MS);
      const eased = easeOutQuart(t);
      if (t >= 1) {
        motionRafRef.current = 0;
        for (const tr of tracks) {
          applyRect(tr.el, tr.finalCss);
        }
        delete stageEl.dataset.splitAnimating;
        return;
      }
      for (const tr of tracks) {
        applyRect(tr.el, unitRectToCss(lerpUnitRect(tr.from, tr.to, eased)));
      }
      motionRafRef.current = requestAnimationFrame(step);
    };
    motionRafRef.current = requestAnimationFrame(step);

    return () => {
      if (motionRafRef.current) {
        cancelAnimationFrame(motionRafRef.current);
        motionRafRef.current = 0;
      }
      for (const tr of tracks) {
        applyRect(tr.el, tr.finalCss);
      }
      delete stageEl.dataset.splitAnimating;
    };
  }, [focusedId, sashDragging, splitLayout.leaves, zoomedId]);

  const handleSashDraggingChange = useCallback(
    (dragging: boolean) => {
      setSashDragging(dragging);
      if (dragging) reportSplitTransitionPerf("sash", splitLayout.leaves.length);
    },
    [splitLayout.leaves.length],
  );

  return (
    <div ref={stageRef} className="v3-split-stage" data-sash-dragging={sashDragging ? "true" : "false"}>
      {splitLayout.leaves.map((item, idx) => (
        <SplitPaneSlot
          key={slotKeys[idx]!}
          paneKey={slotKeys[idx]!}
          tabId={tab.id}
          item={item}
          isSplit={isSplit}
          isFocused={item.leaf.id === focusedId}
          isZoomed={zoomedId === item.leaf.id}
          focusedUnit={focusedUnit}
          tabActive={tabActive}
          portalHost={portalHostPaneIds.has(item.leaf.id)}
          draggingPaneId={draggingPaneId}
          slotElsRef={slotElsRef}
          onDraggingPaneChange={onDraggingPaneChange}
          onSplitNewTerminal={onSplitNewTerminal}
        />
      ))}
      {tabActive
        ? splitLayout.sashes.map((sash) => (
            <SplitSash
              key={sash.id}
              tabId={tab.id}
              sash={sash}
              stageRef={stageRef}
              sashElsRef={sashElsRef}
              onStartDrag={handleSashStart}
              onMoveDrag={handleSashMove}
              onEndDrag={handleSashEnd}
              onDraggingChange={handleSashDraggingChange}
            />
          ))
        : null}
    </div>
  );
});

export const ShellMain = memo(function ShellMain({
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
  const keptNonAgentIdsRef = useRef<string[]>([]);
  const [prewarmedIds, setPrewarmedIds] = useState<string[]>([]);
  const [bootHydrated, setBootHydrated] = useState(false);
  const mountedCountRef = useRef(0);

  useEffect(() => {
    const id = window.setTimeout(() => setBootHydrated(true), 1200);
    return () => window.clearTimeout(id);
  }, []);

  const agentTabIds = useMemo(
    () => new Set(tabs.filter((t) => tabLeaves(t).some((l) => l.content.kind === "agent")).map((t) => t.id)),
    [tabs],
  );
  const nonAgentTabIds = useMemo(
    () => new Set(tabs.filter((t) => !agentTabIds.has(t.id)).map((t) => t.id)),
    [agentTabIds, tabs],
  );
  const keptAgentIds = useMemo(() => {
    const pruned = keptAgentIdsRef.current.filter((id) => agentTabIds.has(id));
    const ordered =
      activeId && agentTabIds.has(activeId)
        ? [activeId, ...pruned.filter((id) => id !== activeId)]
        : [...pruned];
    for (const id of prewarmedIds) {
      if (agentTabIds.has(id) && !ordered.includes(id)) {
        ordered.push(id);
      }
    }
    const next = ordered.slice(0, MAX_KEPT_AGENT_TABS);
    keptAgentIdsRef.current = next;
    return next;
  }, [activeId, agentTabIds, prewarmedIds]);

  const keptNonAgentIds = useMemo(() => {
    const pruned = keptNonAgentIdsRef.current.filter((id) => nonAgentTabIds.has(id));
    const next =
      activeId && nonAgentTabIds.has(activeId)
        ? [activeId, ...pruned.filter((id) => id !== activeId)].slice(0, MAX_KEPT_NON_AGENT_TABS)
        : pruned.slice(0, MAX_KEPT_NON_AGENT_TABS);
    keptNonAgentIdsRef.current = next;
    return next;
  }, [activeId, nonAgentTabIds]);

  useEffect(() => {
    if (!bootHydrated || tabs.length <= 1) return;
    let alive = true;
    let timer = 0;
    const activeSet = new Set(keptAgentIds);
    const livePrewarmCount = prewarmedIds.filter((id) => agentTabIds.has(id)).length;
    if (livePrewarmCount >= MAX_PREWARMED_AGENT_TABS || activeSet.size >= MAX_KEPT_AGENT_TABS) {
      return;
    }

    const unmountedAgentTabs = tabs.filter((t) => agentTabIds.has(t.id) && !activeSet.has(t.id));
    if (unmountedAgentTabs.length === 0) return;

    const pickCandidate = (): ShellTab | undefined => {
      if (selectedSpace) {
        const sameSpace = unmountedAgentTabs.find(
          (t) => tabSpaceKey(t, lookupAgent, spacesMap) === selectedSpace,
        );
        if (sameSpace) return sameSpace;
      }
      const activeWork = unmountedAgentTabs.find((t) =>
        tabLeaves(t).some((l) => {
          if (l.content.kind !== "agent") return false;
          const st = lookupAgent(l.content.agentKey)?.status;
          return st === "working" || st === "blocked";
        }),
      );
      return activeWork ?? unmountedAgentTabs[0];
    };

    let idleHandle = 0;
    const scheduleTick = () => {
      const runIdlePrewarm = () => {
        if (!alive) return;
        if (isSplitMotionActive() || isInteractiveResizeActive()) {
          scheduleTick();
          return;
        }
        const cand = pickCandidate();
        if (!cand) return;
        setPrewarmedIds((prev) => {
          const filtered = prev.filter((id) => agentTabIds.has(id));
          if (filtered.includes(cand.id) || filtered.length >= MAX_PREWARMED_AGENT_TABS) return filtered;
          return [...filtered, cand.id];
        });
      };
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(runIdlePrewarm, { timeout: 2000 });
      } else {
        timer = window.setTimeout(runIdlePrewarm, 1200);
      }
    };

    scheduleTick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      if (idleHandle && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
    };
  }, [agentTabIds, bootHydrated, keptAgentIds, lookupAgent, prewarmedIds, selectedSpace, spacesMap, tabs]);

  const mountedTabIds = useMemo(() => {
    if (!bootHydrated && activeId) return new Set([activeId]);
    const set = new Set([...keptAgentIds, ...keptNonAgentIds]);
    if (activeId) set.add(activeId);
    return set;
  }, [activeId, bootHydrated, keptAgentIds, keptNonAgentIds]);

  const mountedTabs = useMemo(
    () => tabs.filter((t) => mountedTabIds.has(t.id)),
    [mountedTabIds, tabs],
  );
  mountedCountRef.current = mountedTabs.length;

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        // ignore selection reset edge cases
      }
    }
  }, [activeId]);

  useEffect(() => {
    registerMountedTabsCounter(() => mountedCountRef.current);
    return () => {
      registerMountedTabsCounter(null);
    };
  }, []);

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
            key={t.mountKey ?? t.id}
            className={isTabActive ? "v3-tab-layer is-active" : "v3-tab-layer is-hidden"}
            aria-hidden={!isTabActive}
            inert={!isTabActive || undefined}
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
});

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

function useGitTarget(filesTarget: ReturnType<typeof useFilesTarget>) {
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

function browserTabLabel(title: string, url: string): string {
  if (title && title !== "新标签页" && title !== url) return title;
  if (!url || url === "about:blank") return "新标签页";
  try {
    const u = new URL(url);
    return u.hostname || url;
  } catch {
    return url;
  }
}

function BrowserPanel({
  onMetaChange,
}: {
  url?: string;
  onMetaChange: (meta: { url: string; title: string }) => void;
}) {
  const toast = useToast();
  const homePage = useClientConfig().browser.homePage;
  const bState = useBrowserSpaces();
  const activeSpace = bState.spaces.find((s) => s.id === bState.activeSpaceId) ?? bState.spaces[0]!;
  const activeTab = activeSpace.tabs.find((t) => t.id === activeSpace.activeTabId) ?? activeSpace.tabs[0]!;
  const [addingSpace, setAddingSpace] = useState(false);
  const [spaceDraft, setSpaceDraft] = useState("");
  const [egoSpaces, setEgoSpaces] = useState<PortalEgoSpaceState[]>([]);
  const localHostId = useLocalHostDeviceId();
  const devices = liveStore.use((s) => s.devices);
  const activeShellTab = shellStore.use((s) => s.tabs.find((t) => t.id === s.active));

  const targetHostId = useMemo(() => {
    if (localHostId && devices[localHostId]?.online) return localHostId;
    return Object.values(devices).find((d) => d.kind === "host" && d.online)?.id ?? "";
  }, [devices, localHostId]);

  const activeAgentKey = useMemo(() => {
    if (!activeShellTab) return undefined;
    const f = focusedLeafOfTab(activeShellTab).content;
    if (f.kind === "agent") return f.agentKey;
    return tabLeaves(activeShellTab).find((l) => l.content.kind === "agent")?.content.kind === "agent"
      ? (tabLeaves(activeShellTab).find((l) => l.content.kind === "agent")!.content as { agentKey: string }).agentKey
      : undefined;
  }, [activeShellTab]);

  useEffect(() => {
    if (!targetHostId) {
      setEgoSpaces([]);
      return;
    }
    let alive = true;
    const poll = () => {
      void rpcCall(targetHostId, "portal.egoSpaces", {}, 5_000)
        .then((res) => {
          if (alive && res?.available && Array.isArray(res.spaces)) {
            setEgoSpaces(res.spaces);
          }
        })
        .catch(() => {});
    };
    poll();
    const t = window.setInterval(poll, 6_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [targetHostId]);

  const submitNewSpace = () => {
    createUserBrowserSpace(spaceDraft.trim() || undefined, homePage || "about:blank");
    setSpaceDraft("");
    setAddingSpace(false);
  };

  const launchEgoFloatingWindow = (sp: PortalEgoSpaceState) => {
    if (!targetHostId) return;
    void openPortalSurface(targetHostId, {
      ...(activeAgentKey ? { agent: activeAgentKey } : {}),
      kind: "window",
      title: `EG 空间 · ${sp.spaceName}`,
    })
      .then(() => toast(`已弹出 Ego 空间「${sp.spaceName}」实时小浮窗`))
      .catch((e: Error) => toast(e.message || "弹出 Ego 小浮窗失败", true));
  };

  return (
    <div className="v3-panel-web">
      <div className="v3-bspace-strip" role="tablist" aria-label="浏览空间">
        <div className="v3-bspace-pills">
          {bState.spaces.map((sp) => {
            const isCur = sp.id === activeSpace.id;
            return (
              <div key={sp.id} className={`v3-bspace-pill${isCur ? " active" : ""}${sp.kind === "ai" ? " is-ai" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={isCur}
                  className="v3-bspace-pill-btn"
                  title={`${sp.name}（${sp.tabs.length} 个标签页）`}
                  onClick={() => selectBrowserSpace(sp.id)}
                >
                  {sp.kind === "ai" ? <Sparkles size={11} /> : <Compass size={11} />}
                  <span className="truncate">{sp.name}</span>
                  <span className="v3-bspace-count num">{sp.tabs.length}</span>
                </button>
                {sp.id !== "default" ? (
                  <button
                    type="button"
                    className="v3-bspace-pill-x"
                    aria-label={`关闭浏览空间 ${sp.name}`}
                    title={`关闭空间 ${sp.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteBrowserSpace(sp.id);
                    }}
                  >
                    <X size={10} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="v3-icon-btn small"
          aria-label="新建浏览空间"
          title="新建浏览空间（隔离 Cookie / 任务分组）"
          onClick={() => setAddingSpace((v) => !v)}
        >
          <Plus size={13} />
        </button>
      </div>

      {egoSpaces.length > 0 ? (
        <div className="v3-ego-live-strip" role="region" aria-label="Ego 实时任务空间">
          <span className="v3-ego-live-label">
            <Compass size={11} />
            <span>Ego 空间</span>
          </span>
          <div className="v3-ego-live-list">
            {egoSpaces.map((sp) => (
              <button
                key={sp.spaceId ?? sp.spaceName}
                type="button"
                className={`v3-ego-chip${sp.phase === "handoff" ? " handoff" : ""}`}
                title={`${sp.spaceName}${sp.lastAction ? ` · ${sp.lastAction}` : ""}（点击弹出实时小浮窗）`}
                onClick={() => launchEgoFloatingWindow(sp)}
              >
                <span className={`v3-ego-dot ${sp.phase}`} aria-hidden />
                <span className="truncate">{sp.spaceName}</span>
                <span className="v3-ego-chip-act">小浮窗</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {addingSpace ? (
        <form
          className="v3-bspace-new"
          onSubmit={(e) => {
            e.preventDefault();
            submitNewSpace();
          }}
        >
          <PocketInput
            value={spaceDraft}
            onChange={(e) => setSpaceDraft(e.target.value)}
            placeholder="空间名称（例如：文档研究 / 本地调试）"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAddingSpace(false);
                setSpaceDraft("");
              }
            }}
          />
          <PocketButton size="sm" variant="primary" type="submit">
            创建
          </PocketButton>
          <PocketButton
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => {
              setAddingSpace(false);
              setSpaceDraft("");
            }}
          >
            取消
          </PocketButton>
        </form>
      ) : null}

      <div className="v3-btabs" role="tablist" aria-label="浏览器标签页">
        {activeSpace.tabs.map((t) => {
          const isCur = t.id === activeTab.id;
          const label = browserTabLabel(t.title, t.url);
          return (
            <div key={t.id} className={`v3-btab${isCur ? " active" : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={isCur}
                className="v3-btab-btn truncate"
                title={t.url && t.url !== "about:blank" ? t.url : "新标签页"}
                onClick={() => selectBrowserTab(activeSpace.id, t.id)}
              >
                {t.openedBy === "agent" ? <Sparkles size={11} className="v3-btab-ai" /> : null}
                <span className="truncate">{label}</span>
              </button>
              <button
                type="button"
                className="v3-btab-x"
                aria-label={`关闭标签页 ${label}`}
                onClick={() => closeBrowserTab(activeSpace.id, t.id)}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="v3-icon-btn small v3-btab-add"
          aria-label="新建网页标签页"
          title="新建网页标签页"
          onClick={() => openBrowserTab(activeSpace.id, "about:blank")}
        >
          <Plus size={12} />
        </button>
      </div>

      <WebPane
        key={activeTab.id}
        tab={{ id: activeTab.id, url: activeTab.url }}
        browserSpace={activeSpace}
        active
        onChange={(p) => {
          updateBrowserTab(activeTab.id, p);
          onMetaChange({
            url: p.url ?? activeTab.url,
            title: p.title ?? (p.url ? p.url : activeTab.title),
          });
        }}
      />
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

export const ShellPanel = memo(function ShellPanel() {
  const panel = shellStore.use((s) => s.panel);

  // Hide visible browser space WebViews when the browser panel closes while keeping tabs/spaces intact.
  useEffect(() => {
    if (panel === "browser") return;
    void native.browserSetVisible(PANEL_WEB_ID, false).catch(() => undefined);
    for (const sp of browserSpacesStore.get().spaces) {
      for (const t of sp.tabs) void native.browserSetVisible(t.id, false).catch(() => undefined);
    }
  }, [panel]);

  if (!panel) return null;
  return <ShellPanelOpen panel={panel} />;
});

function ShellPanelOpen({ panel }: { panel: PanelId }) {
  const width = shellStore.use((s) => s.panelWidth);
  const aside = shellStore.use((s) => s.subagentAside);
  const homePage = useClientConfig().browser.homePage;
  const filesTarget = useFilesTarget();
  const gitTarget = useGitTarget(filesTarget);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [browserMeta, setBrowserMeta] = useState<{ url: string; title: string }>({
    url: homePage || "about:blank",
    title: "浏览器",
  });
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
        {panel === "browser" ? (
          <button
            type="button"
            className="v3-icon-btn small"
            aria-label="移入顶部标签页"
            title="在顶部标签页打开当前网页（也可直接拖动标题栏放入）"
            onClick={() => {
              openWebTab(browserMeta.url || homePage || "about:blank", browserMeta.title || browserMeta.url || "网页");
              showPanel(null);
            }}
          >
            <SquareArrowOutUpRight size={13} />
          </button>
        ) : null}
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
  if (isH5Web()) return null;
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
  const attentionItems = attentionStore.use((s) => s.items);
  const [ovisOpen, setOvisOpen] = useState(false);
  const [ovisFilter, setOvisFilter] = useState<"all" | AttentionCategory>("all");
  const ovisAnchorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ovisOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!ovisAnchorRef.current?.contains(e.target as Node | null)) setOvisOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOvisOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, [ovisOpen]);
  const filteredOvisItems = useMemo(
    () => (ovisFilter === "all" ? attentionItems : attentionItems.filter((i) => i.category === ovisFilter)),
    [attentionItems, ovisFilter],
  );
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
        <div ref={ovisAnchorRef} className="v3-ovis-anchor">
          <button
            type="button"
            className={`v3-status-btn has-hint${attentionItems.length > 0 || blocked > 0 ? " v3-status-need" : ""}`}
            title={`打开小羊提醒队列（${shortcutText("jumpUrgent")} 跳转下一条）`}
            onClick={() => setOvisOpen((v) => !v)}
          >
            <Bell size={12} />
            <span className="truncate">
              {attentionItems.length > 0
                ? `${attentionItems.length} 条待处理`
                : blocked > 0
                  ? `${blocked} 个需要你`
                  : "提醒"}
            </span>
            <SpatialHint text={shortcutText("jumpUrgent")} corner="top" />
          </button>
          {ovisOpen ? (
            <div className="v3-ovis-popover" role="dialog" aria-label="小羊分类提醒队列">
              <div className="v3-ovis-head">
                <span>小羊提醒队列（{attentionItems.length}）</span>
                <button
                  type="button"
                  className="btw-icon-btn"
                  aria-label="关闭提醒列表"
                  onClick={() => setOvisOpen(false)}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="v3-ovis-filters">
                {(
                  [
                    ["all", "全部"],
                    ["approval", "审批"],
                    ["question", "提问"],
                    ["error", "异常"],
                    ["completed", "完成"],
                  ] as const
                ).map(([cat, label]) => {
                  const cnt = cat === "all" ? attentionItems.length : attentionItems.filter((x) => x.category === cat).length;
                  if (cat !== "all" && cnt === 0) return null;
                  return (
                    <button
                      key={cat}
                      type="button"
                      className={`v3-ovis-chip${ovisFilter === cat ? " active" : ""}`}
                      onClick={() => setOvisFilter(cat)}
                    >
                      {label} {cnt}
                    </button>
                  );
                })}
              </div>
              <div className="v3-ovis-list">
                {filteredOvisItems.length === 0 ? (
                  <div className="v3-ovis-empty">当前没有待处理的审批、提问、报错或完成提醒。</div>
                ) : (
                  filteredOvisItems.map((item) => (
                    <div key={item.id} className="v3-ovis-card">
                      <button
                        type="button"
                        className="v3-ovis-card-main"
                        onClick={() => {
                          setOvisOpen(false);
                          jumpToAttentionAgent(item.agentKey);
                        }}
                      >
                        <div className="v3-ovis-card-top">
                          <span className={`v3-droplet-tag is-${item.category}`}>
                            {item.category === "approval" ? (
                              <ShieldAlert size={11} />
                            ) : item.category === "question" ? (
                              <HelpCircle size={11} />
                            ) : item.category === "error" ? (
                              <AlertTriangle size={11} />
                            ) : (
                              <Check size={11} />
                            )}
                            <span>{ATTENTION_CATEGORY_META[item.category].label}</span>
                          </span>
                          <span className="v3-ovis-card-title truncate">{item.title}</span>
                        </div>
                        <div className="v3-ovis-card-sub truncate">{item.subtitle}</div>
                      </button>
                      <button
                        type="button"
                        className="btw-icon-btn"
                        aria-label={`忽略 ${item.title}`}
                        onClick={() => dismissAttentionItem(item.id)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              {attentionItems.length > 0 ? (
                <div className="v3-ovis-foot">
                  <PocketButton
                    size="sm"
                    variant="soft"
                    onClick={() => {
                      setOvisOpen(false);
                      jumpToNextAttentionItem();
                    }}
                  >
                    跳转下一条（{shortcutText("jumpUrgent")}）
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="ghost"
                    onClick={() => clearAllAttentionItems()}
                  >
                    全部已读
                  </PocketButton>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
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
      <button
        type="button"
        className="v3-status-item v3-status-btn"
        style={{ flex: "none" }}
        onClick={() => {
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("pocket:toggle-shortcut-help"));
          }
        }}
        title={`快捷键指南（${shortcutText("shortcutHelp")}）`}
      >
        <Keyboard size={13} />
        <span className="v3-keys-text" data-inline-chord="Mod">{shortcutText("shortcutHelp")}</span>
        <span>快捷键</span>
      </button>
      <button className="v3-status-item v3-status-btn" style={{ flex: "none" }} onClick={() => setPalette("command")} title="打开命令面板">
        <span className="v3-keys-text" data-inline-chord="Mod">{shortcutText("palette")}</span>
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
  const subHeadRef = useRef<SubagentHeadInfo | null>(null);
  subHeadRef.current = subHead;
  useEffect(() => {
    setPeekMode(undefined);
    setSubHead(null);
  }, [key]);
  useEffect(() => {
    if (!key) return;
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const curSub = subHeadRef.current;
      if (curSub && curSub.trail.length > 0) {
        e.preventDefault();
        if (curSub.trail.length > 1) curSub.onSelectCrumbIndex(curSub.trail.length - 2);
        else curSub.onGoRoot();
        return;
      }
      setPeek(null);
    };
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
          <div className="v3-pane-right">
            {agent && !inSubView && (agent.listeningPorts?.length ?? 0) > 0 ? (
              <AgentPortsPopover agent={agent} />
            ) : null}
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
            {agent ? (
              <ModeSwitchIcons
                mode={mode}
                onModeChange={setPeekMode}
                termAttention={Boolean(agent.subscreen) || agent.status === "blocked"}
              />
            ) : null}
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
