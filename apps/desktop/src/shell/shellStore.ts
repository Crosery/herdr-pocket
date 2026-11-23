import type { HerdrDoc, SpaceInfo, SubSession } from "@herdr-pocket/protocol";
import { allAgents, createStore, liveStore } from "../lib/store";
import { registerWorkspaceSection, scheduleWorkspacePersist } from "../lib/workspacePersist";
import type { SettingsSection } from "../views/SettingsView";
import { herdrRootToSplitNode, splitNodeToHerdrRoot, syncedHerdrTabId } from "./herdrDoc";
import {
  computeSplitLayout,
  directionToAxis,
  equalizeSplitWeights,
  findLeaf,
  findPaneInDirection,
  insertSplitLeaf,
  listLeaves,
  makeSplitId,
  moveSplitLeaf,
  normalizeSplitNode,
  parsePersistedSplitState,
  removeSplitLeaf,
  resizeSplitPair,
  SPLIT_GAP_PX,
  swapSplitLeaves,
  updateLeafContent,
  type CssRect,
  type PaneContent,
  type SplitAxis,
  type SplitBranchNode,
  type SplitDirection,
  type SplitLayoutResult,
  type SplitLeafLayout,
  type SplitLeafNode,
  type SplitNode,
  type SplitSashLayout,
  type TabSplitState,
  type UnitRect,
} from "./splitTree";

export {
  computeSplitLayout,
  directionToAxis,
  equalizeSplitWeights,
  findLeaf,
  findPaneInDirection,
  insertSplitLeaf,
  listLeaves,
  makeSplitId,
  moveSplitLeaf,
  normalizeSplitNode,
  parsePersistedSplitState,
  removeSplitLeaf,
  resizeSplitPair,
  SPLIT_GAP_PX,
  swapSplitLeaves,
  updateLeafContent,
  type CssRect,
  type PaneContent,
  type SplitAxis,
  type SplitBranchNode,
  type SplitDirection,
  type SplitLayoutResult,
  type SplitLeafLayout,
  type SplitLeafNode,
  type SplitNode,
  type SplitSashLayout,
  type TabSplitState,
  type UnitRect,
};

/**
 * State of the desktop shell v3 (docs/design/desktop-v2.md, "窗口骨架"): open tabs, the
 * side panel, and the overlays drawn over the window (settings frame, palette, peek).
 * The narrow (phone/HarmonyOS) layout does not use it.
 */

/** Settings frame sections, Herdr's order first, then ours. */
export type FrameSection =
  | "look"
  | "keyboard"
  | "machines"
  | "alerts"
  | "updates"
  | "privacy"
  | "voice"
  | "assistant"
  | "browser"
  | "performance"
  | "logs"
  | "about";

/** The narrow layout's settings sections, mapped onto the frame's. */
export const FRAME_SECTION_OF: Record<SettingsSection, FrameSection> = {
  general: "look",
  connection: "machines",
  voice: "voice",
  notifications: "alerts",
  assistant: "assistant",
  browser: "browser",
  updates: "updates",
  performance: "performance",
  logs: "logs",
  about: "about",
};

export type AgentPaneMode = "chat" | "term";

interface TabSplitFields {
  mountKey?: string;
  primaryPaneId?: string;
  split?: TabSplitState;
  docHostId?: string;
  docSpaceId?: string;
  docSpaceName?: string;
  docTabId?: string;
  docTabName?: string;
}

export type AgentTab = TabSplitFields & { id: string; kind: "agent"; agentKey: string; mode?: AgentPaneMode };
export type FileTab = TabSplitFields & {
  id: string;
  kind: "file";
  agentKey: string;
  path: string;
  title: string;
  absPath?: string;
  line?: number;
  endLine?: number;
  spaceKey?: string | null;
};
export type WebTab = TabSplitFields & { id: string; kind: "web"; webId?: string; url: string; title: string; spaceKey?: string | null };
export type DiffTab = TabSplitFields & {
  id: string;
  kind: "diff";
  deviceId: string;
  agentKey?: string;
  cwd: string;
  path: string;
  staged: boolean;
  commit?: string;
  title: string;
  spaceKey?: string | null;
};
export type ShellTab = AgentTab | FileTab | WebTab | DiffTab;

/** Side panel sections (Herdr: files / changes; ours adds git, browser, 小羊, and subagent aside). */
export type PanelId = "files" | "git" | "browser" | "assistant" | "subagent";

export interface SubagentAside {
  agentKey: string;
  sub: SubSession;
  trail: SubSession[];
}

export interface AgentSpaceRef {
  deviceId: string;
  where?: string;
}

export const ALL_SPACES_KEY = "__all__";
const MAX_SPACE_NAV_HISTORY = 64;

const focusHistoryByTab = new Map<string, string[]>();

function recordPaneFocus(tabId: string, paneId: string): void {
  const prev = focusHistoryByTab.get(tabId) ?? [];
  focusHistoryByTab.set(tabId, [...prev.filter((x) => x !== paneId), paneId]);
}

function pushSpaceNavHistory(
  prevMap: Record<string, string[]> | undefined,
  scopeKey: string,
  fromTabId: string | null | undefined,
  toTabId: string,
): Record<string, string[]> {
  const base = (prevMap?.[scopeKey] ?? []).filter((id) => id !== toTabId);
  if (fromTabId && fromTabId !== toTabId) {
    const withoutFrom = base.filter((id) => id !== fromTabId);
    return {
      ...(prevMap ?? {}),
      [scopeKey]: [...withoutFrom, fromTabId, toTabId].slice(-MAX_SPACE_NAV_HISTORY),
    };
  }
  return {
    ...(prevMap ?? {}),
    [scopeKey]: [...base, toTabId].slice(-MAX_SPACE_NAV_HISTORY),
  };
}

function removeTabIdsFromNavHistory(
  prevMap: Record<string, string[]> | undefined,
  removedIds: ReadonlySet<string>,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(prevMap ?? {})) {
    const filtered: string[] = [];
    for (const id of list) {
      if (removedIds.has(id) || filtered[filtered.length - 1] === id) continue;
      filtered.push(id);
    }
    if (filtered.length > 0) next[k] = filtered;
  }
  return next;
}

function spaceNameFromWhere(where?: string): string {
  const raw = where ?? "";
  const slash = raw.indexOf(" / ");
  return (slash >= 0 ? raw.slice(0, slash) : raw).trim();
}

export function spaceKeyFromAgent(a: AgentSpaceRef): string {
  return `${a.deviceId}\u0000${spaceNameFromWhere(a.where)}`;
}

export function resolveAgentSpaceKey(
  a: AgentSpaceRef,
  spacesMap?: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]>,
): string | null {
  const sp = spaceNameFromWhere(a.where);
  if (sp) return `${a.deviceId}\u0000${sp}`;
  const activeOrFirst = spacesMap?.[a.deviceId]?.find((s) => (s as SpaceInfo).active)?.name?.trim()
    || spacesMap?.[a.deviceId]?.[0]?.name?.trim();
  return activeOrFirst ? `${a.deviceId}\u0000${activeOrFirst}` : null;
}

function makeLiveAgentLookup(): (agentKey: string) => AgentSpaceRef | undefined {
  const byKey = new Map<string, AgentSpaceRef>();
  for (const a of allAgents(liveStore.get().agents)) {
    byKey.set(a.key, a);
  }
  return (k) => byKey.get(k);
}

export function tabToPaneContent(tab: ShellTab): PaneContent {
  if (tab.kind === "agent") {
    return { kind: "agent", agentKey: tab.agentKey, ...(tab.mode ? { mode: tab.mode } : {}) };
  }
  if (tab.kind === "file") {
    return {
      kind: "file",
      agentKey: tab.agentKey,
      path: tab.path,
      title: tab.title,
      ...(tab.absPath ? { absPath: tab.absPath } : {}),
      ...(tab.line !== undefined ? { line: tab.line } : {}),
      ...(tab.endLine !== undefined ? { endLine: tab.endLine } : {}),
      ...(tab.spaceKey !== undefined ? { spaceKey: tab.spaceKey } : {}),
    };
  }
  if (tab.kind === "diff") {
    return {
      kind: "diff",
      deviceId: tab.deviceId,
      ...(tab.agentKey ? { agentKey: tab.agentKey } : {}),
      cwd: tab.cwd,
      path: tab.path,
      staged: tab.staged,
      ...(tab.commit ? { commit: tab.commit } : {}),
      title: tab.title,
      ...(tab.spaceKey !== undefined ? { spaceKey: tab.spaceKey } : {}),
    };
  }
  return {
    kind: "web",
    webId: tab.webId ?? tab.id,
    url: tab.url,
    title: tab.title,
    ...(tab.spaceKey !== undefined ? { spaceKey: tab.spaceKey } : {}),
  };
}

export function tabRootNode(tab: ShellTab): SplitNode {
  if (tab.split) return tab.split.root;
  return {
    type: "leaf",
    id: tab.primaryPaneId ?? `p0:${tab.id}`,
    weight: 1,
    content: tabToPaneContent(tab),
  };
}

export function tabLeaves(tab: ShellTab): SplitLeafNode[] {
  return listLeaves(tabRootNode(tab));
}

export function tabPaneCount(tab: ShellTab): number {
  return tabLeaves(tab).length;
}

export function focusedLeafOfTab(tab: ShellTab): SplitLeafNode {
  const root = tabRootNode(tab);
  const leaves = listLeaves(root);
  if (tab.split?.focusedPaneId) {
    const hit = leaves.find((l) => l.id === tab.split!.focusedPaneId);
    if (hit) return hit;
  }
  return leaves[0]!;
}

export function paneContentSpaceKey(
  content: PaneContent,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
): string | null {
  if (content.kind === "agent") {
    const a = lookupAgent(content.agentKey);
    return a ? spaceKeyFromAgent(a) : null;
  }
  if (content.kind === "file") {
    if (content.spaceKey) return content.spaceKey;
    const a = lookupAgent(content.agentKey);
    return a ? spaceKeyFromAgent(a) : null;
  }
  if (content.kind === "diff") {
    if (content.spaceKey) return content.spaceKey;
    if (content.agentKey) {
      const a = lookupAgent(content.agentKey);
      if (a) return spaceKeyFromAgent(a);
    }
    return null;
  }
  return content.spaceKey ?? null;
}

export function tabSpaceKey(
  tab: ShellTab,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
  hostSpacesMap?: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]>,
): string | null {
  if (tab.docHostId && tab.docSpaceName !== undefined) {
    const metaName =
      tab.docSpaceId && hostSpacesMap?.[tab.docHostId]
        ? hostSpacesMap[tab.docHostId]!.find((sp) => sp.id === tab.docSpaceId)?.name?.trim()
        : "";
    return `${tab.docHostId}\u0000${metaName || tab.docSpaceName}`;
  }
  const focused = focusedLeafOfTab(tab);
  const direct = paneContentSpaceKey(focused.content, lookupAgent);
  if (direct !== null) return direct;
  for (const leaf of tabLeaves(tab)) {
    const k = paneContentSpaceKey(leaf.content, lookupAgent);
    if (k !== null) return k;
  }
  return null;
}

export function visibleTabsForSpace(
  tabs: ShellTab[],
  selectedSpace: string | null,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
  hostSpacesMap?: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]>,
): ShellTab[] {
  if (!selectedSpace) return tabs;
  const sep = selectedSpace.indexOf("\u0000");
  const selHost = sep >= 0 ? selectedSpace.slice(0, sep) : "";
  const selName = sep >= 0 ? selectedSpace.slice(sep + 1) : selectedSpace;
  const matchedSpaceId = selHost ? hostSpacesMap?.[selHost]?.find((sp) => sp.name === selName)?.id : undefined;
  return tabs.filter((t) => {
    if (t.docHostId) {
      if (t.docHostId !== selHost) return false;
      if (matchedSpaceId && t.docSpaceId && t.docSpaceId === matchedSpaceId) return true;
      return t.docSpaceName === selName;
    }
    return tabLeaves(t).some((l) => paneContentSpaceKey(l.content, lookupAgent) === selectedSpace);
  });
}

export function activeTabIdForSpace(
  state: Pick<ShellState, "tabs" | "active" | "selectedSpace" | "activeBySpace">,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
  hostSpacesMap?: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]>,
): string | null {
  const visible = visibleTabsForSpace(state.tabs, state.selectedSpace, lookupAgent, hostSpacesMap);
  if (!visible.length) return null;
  if (state.active && visible.some((t) => t.id === state.active)) return state.active;
  const scopeKey = state.selectedSpace ?? ALL_SPACES_KEY;
  const remembered = state.activeBySpace[scopeKey];
  if (remembered && visible.some((t) => t.id === remembered)) return remembered;
  return visible[0]!.id;
}

export interface ShellState {
  tabs: ShellTab[];
  active: string | null;
  /** Sidebar Space filter (`${deviceId}\u0000${spaceName}`), or null when showing all spaces. */
  selectedSpace: string | null;
  /** Remembered active tab per space (`ALL_SPACES_KEY` for unfiltered view). */
  activeBySpace: Record<string, string | null>;
  /** Per-space tab navigation history stack so closing a jumped-to file/image returns strictly one level back. */
  navHistoryBySpace?: Record<string, string[]>;
  /** Transient map from opened preview tab ID -> agent key shown in PeekOverlay before opening. */
  peekReturnByTab?: Record<string, string>;
  /** The side panel's section, or null when the panel is hidden. */
  panel: PanelId | null;
  /** Remembered side panel section per space (`ALL_SPACES_KEY` for unfiltered view). */
  panelBySpace?: Record<string, PanelId | null>;
  panelWidth: number;
  /** Subagent currently opened in the right-hand side panel. */
  subagentAside: SubagentAside | null;
  /** The settings frame's section, or null when it is closed. */
  settings: FrameSection | null;
  /** The palette: all commands, or "jump" (agents and tabs only, from the brand row's search). */
  palette: false | "command" | "jump";
  /** Agent shown in the peek overlay (a sub-agent or a row opened without a tab). */
  peek: string | null;
}

const KEY = "herdr-pocket-shell";
export const PANEL_DEFAULT = 368;
export const PANEL_MIN = 280;
export const PANEL_MAX = 900;

type PersistedShellState = Pick<
  ShellState,
  "tabs" | "active" | "selectedSpace" | "activeBySpace" | "navHistoryBySpace" | "panel" | "panelBySpace" | "panelWidth"
>;

function docFieldsOfTab(t: Partial<TabSplitFields>): Partial<TabSplitFields> {
  return {
    ...(typeof t.mountKey === "string" && t.mountKey ? { mountKey: t.mountKey } : {}),
    ...(typeof t.docHostId === "string" && t.docHostId ? { docHostId: t.docHostId } : {}),
    ...(typeof t.docSpaceId === "string" && t.docSpaceId ? { docSpaceId: t.docSpaceId } : {}),
    ...(typeof t.docSpaceName === "string" ? { docSpaceName: t.docSpaceName } : {}),
    ...(typeof t.docTabId === "string" && t.docTabId ? { docTabId: t.docTabId } : {}),
    ...(typeof t.docTabName === "string" ? { docTabName: t.docTabName } : {}),
  };
}

function normalizePersistedTab(t: ShellTab): ShellTab {
  const primaryPaneId = typeof t.primaryPaneId === "string" && t.primaryPaneId ? t.primaryPaneId : undefined;
  const split = t.split !== undefined ? parsePersistedSplitState(t.split) : undefined;
  const docFields = docFieldsOfTab(t);
  if (t.kind === "agent") {
    return {
      id: t.id,
      kind: "agent",
      agentKey: t.agentKey,
      ...(t.mode === "chat" || t.mode === "term" ? { mode: t.mode } : {}),
      ...(primaryPaneId ? { primaryPaneId } : {}),
      ...(split ? { split } : {}),
      ...docFields,
    };
  }
  if (t.kind === "web") {
    return {
      ...t,
      ...(typeof t.webId === "string" && t.webId && t.webId !== t.id ? { webId: t.webId } : {}),
      ...(primaryPaneId ? { primaryPaneId } : {}),
      ...(split ? { split } : {}),
      ...docFields,
    };
  }
  return {
    ...t,
    ...(primaryPaneId ? { primaryPaneId } : {}),
    ...(split ? { split } : {}),
    ...docFields,
  };
}

function normalizePersistedShellState(rawInput: unknown): PersistedShellState | null {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const raw = rawInput as Partial<ShellState>;
  if (!Array.isArray(raw.tabs)) return null;
  const tabs = raw.tabs
    .filter((t): t is ShellTab =>
      Boolean(
        t &&
          typeof t.id === "string" &&
          (t.kind === "agent" || t.kind === "file" || t.kind === "web" || t.kind === "diff"),
      ),
    )
    .map(normalizePersistedTab);
  const activeBySpace =
    raw.activeBySpace && typeof raw.activeBySpace === "object" && !Array.isArray(raw.activeBySpace)
      ? raw.activeBySpace
      : {};
  const validTabIds = new Set(tabs.map((t) => t.id));
  const navHistoryBySpace: Record<string, string[]> = {};
  if (raw.navHistoryBySpace && typeof raw.navHistoryBySpace === "object" && !Array.isArray(raw.navHistoryBySpace)) {
    for (const [k, v] of Object.entries(raw.navHistoryBySpace)) {
      if (!Array.isArray(v)) continue;
      const seen = new Set<string>();
      const cleanedRev: string[] = [];
      for (let idx = v.length - 1; idx >= 0; idx -= 1) {
        const id = v[idx];
        if (typeof id === "string" && validTabIds.has(id) && !seen.has(id)) {
          seen.add(id);
          cleanedRev.push(id);
        }
      }
      if (cleanedRev.length > 0) {
        navHistoryBySpace[k] = cleanedRev.reverse().slice(-MAX_SPACE_NAV_HISTORY);
      }
    }
  }
  const panel =
    raw.panel === "files" || raw.panel === "git" || raw.panel === "browser" || raw.panel === "assistant"
      ? raw.panel
      : null;
  const panelBySpace: Record<string, PanelId | null> = {};
  if (raw.panelBySpace && typeof raw.panelBySpace === "object" && !Array.isArray(raw.panelBySpace)) {
    for (const [k, v] of Object.entries(raw.panelBySpace)) {
      if (v === null || v === "files" || v === "git" || v === "browser" || v === "assistant") {
        panelBySpace[k] = v;
      }
    }
  }
  return {
    tabs,
    active: tabs.some((t) => t.id === raw.active) ? raw.active! : (tabs[0]?.id ?? null),
    selectedSpace: typeof raw.selectedSpace === "string" ? raw.selectedSpace : null,
    activeBySpace,
    navHistoryBySpace,
    panel,
    panelBySpace,
    panelWidth: clampPanel(Number(raw.panelWidth) || PANEL_DEFAULT),
  };
}

function pickPersistedShellState(s: ShellState): PersistedShellState {
  return {
    tabs: s.tabs,
    active: s.active,
    selectedSpace: s.selectedSpace,
    activeBySpace: s.activeBySpace,
    navHistoryBySpace: s.navHistoryBySpace ?? {},
    panel: s.panel === "subagent" ? null : s.panel,
    panelBySpace: s.panelBySpace ?? {},
    panelWidth: s.panelWidth,
  };
}

function load(): PersistedShellState {
  try {
    const parsed = normalizePersistedShellState(JSON.parse(localStorage.getItem(KEY) ?? "null"));
    if (parsed) return parsed;
  } catch {
    // Unreadable: start empty.
  }
  return {
    tabs: [],
    active: null,
    selectedSpace: null,
    activeBySpace: {},
    navHistoryBySpace: {},
    panel: null,
    panelBySpace: {},
    panelWidth: PANEL_DEFAULT,
  };
}

export function clampPanel(px: number): number {
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, px)));
}

export const shellStore = createStore<ShellState>({
  ...load(),
  peekReturnByTab: {},
  subagentAside: null,
  settings: null,
  palette: false,
  peek: null,
});

let lastPersistedJson = JSON.stringify(pickPersistedShellState(shellStore.get()));
let dirtyBeforeHydrate = false;

shellStore.subscribe(() => {
  const persisted = pickPersistedShellState(shellStore.get());
  const encoded = JSON.stringify(persisted);
  if (encoded === lastPersistedJson) return;
  lastPersistedJson = encoded;
  dirtyBeforeHydrate = true;
  try {
    localStorage.setItem(KEY, encoded);
  } catch {
    // Storage off: tabs last for this session.
  }
  scheduleWorkspacePersist();
});

registerWorkspaceSection("shellState", {
  serialize: () => pickPersistedShellState(shellStore.get()),
  hydrate: (raw) => {
    const parsed = normalizePersistedShellState(raw);
    if (!parsed) return;
    const cur = shellStore.get();
    if (dirtyBeforeHydrate && cur.tabs.length > 0) return;
    const encoded = JSON.stringify(parsed);
    lastPersistedJson = encoded;
    shellStore.set((s) => ({ ...s, ...parsed }));
    try {
      localStorage.setItem(KEY, encoded);
    } catch {
      /* ignore */
    }
  },
});

const set = shellStore.set;

function spacePanelTransition(
  s: ShellState,
  nextSpace: string | null,
): Pick<ShellState, "panel" | "panelBySpace" | "subagentAside"> {
  if (nextSpace === s.selectedSpace) {
    return { panel: s.panel, panelBySpace: s.panelBySpace ?? {}, subagentAside: s.subagentAside };
  }
  const prevScope = s.selectedSpace ?? ALL_SPACES_KEY;
  const nextScope = nextSpace ?? ALL_SPACES_KEY;
  const savedPanel: PanelId | null = s.panel === "subagent" ? null : s.panel;
  const panelBySpace: Record<string, PanelId | null> = { ...(s.panelBySpace ?? {}), [prevScope]: savedPanel };
  return {
    panel: panelBySpace[nextScope] ?? null,
    panelBySpace,
    subagentAside: null,
  };
}

export function setSelectedSpace(
  selectedSpace: string | null,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined = makeLiveAgentLookup(),
  hostSpacesMap: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]> = liveStore.get().spaces,
): void {
  set((s) => {
    const prevScope = s.selectedSpace ?? ALL_SPACES_KEY;
    const prevVisible = visibleTabsForSpace(s.tabs, s.selectedSpace, lookupAgent, hostSpacesMap);
    const prevActive = s.active && prevVisible.some((t) => t.id === s.active) ? s.active : prevVisible[0]?.id ?? null;
    const activeBySpace = { ...s.activeBySpace, [prevScope]: prevActive };
    const nextVisible = visibleTabsForSpace(s.tabs, selectedSpace, lookupAgent, hostSpacesMap);
    const nextScope = selectedSpace ?? ALL_SPACES_KEY;
    const remembered = activeBySpace[nextScope];
    const nextActive =
      (remembered && nextVisible.some((t) => t.id === remembered) ? remembered : undefined) ??
      nextVisible[0]?.id ??
      null;
    const panelPatch = spacePanelTransition(s, selectedSpace);
    return {
      ...s,
      selectedSpace,
      activeBySpace,
      active: nextActive,
      ...panelPatch,
    };
  });
}

function standaloneTabIdForContent(content: PaneContent, existingIds: ReadonlySet<string>): string {
  const base =
    content.kind === "agent"
      ? `a:${content.agentKey}`
      : content.kind === "file"
        ? `f:${content.agentKey}:${content.path}`
        : content.kind === "diff"
          ? `d:${content.deviceId}:${content.cwd}:${content.commit ? content.commit : content.staged ? "staged" : "work"}:${content.path}`
          : content.webId || `w:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  if (!existingIds.has(base)) return base;
  return `${base}:${makeSplitId("p")}`;
}

export function contentToStandaloneTab(content: PaneContent, id: string, primaryPaneId?: string): ShellTab {
  const paneField = primaryPaneId ? { primaryPaneId } : {};
  if (content.kind === "agent") {
    return {
      id,
      kind: "agent",
      agentKey: content.agentKey,
      ...(content.mode ? { mode: content.mode } : {}),
      ...paneField,
    };
  }
  if (content.kind === "file") {
    return {
      id,
      kind: "file",
      agentKey: content.agentKey,
      path: content.path,
      title: content.title,
      ...(content.absPath ? { absPath: content.absPath } : {}),
      ...(content.line !== undefined ? { line: content.line } : {}),
      ...(content.endLine !== undefined ? { endLine: content.endLine } : {}),
      ...(content.spaceKey !== undefined ? { spaceKey: content.spaceKey } : {}),
      ...paneField,
    };
  }
  if (content.kind === "diff") {
    return {
      id,
      kind: "diff",
      deviceId: content.deviceId,
      ...(content.agentKey ? { agentKey: content.agentKey } : {}),
      cwd: content.cwd,
      path: content.path,
      staged: content.staged,
      ...(content.commit ? { commit: content.commit } : {}),
      title: content.title,
      ...(content.spaceKey !== undefined ? { spaceKey: content.spaceKey } : {}),
      ...paneField,
    };
  }
  return {
    id,
    kind: "web",
    ...(content.webId && content.webId !== id ? { webId: content.webId } : {}),
    url: content.url,
    title: content.title,
    ...(content.spaceKey !== undefined ? { spaceKey: content.spaceKey } : {}),
    ...paneField,
  };
}

function applyRootToTab(
  tab: ShellTab,
  nextRootRaw: SplitNode,
  desiredFocusPaneId?: string,
  desiredZoomPaneId?: string | null,
): ShellTab {
  const normalized = normalizeSplitNode(nextRootRaw);
  const leaves = listLeaves(normalized);
  const docFields = docFieldsOfTab(tab);
  if (leaves.length <= 1) {
    const sole = leaves[0]!;
    const customPrimary = sole.id === `p0:${tab.id}` ? undefined : sole.id;
    const base = contentToStandaloneTab(sole.content, tab.id, customPrimary);
    return Object.keys(docFields).length ? { ...base, ...docFields } : base;
  }
  const focusedPaneId =
    desiredFocusPaneId && leaves.some((l) => l.id === desiredFocusPaneId)
      ? desiredFocusPaneId
      : tab.split?.focusedPaneId && leaves.some((l) => l.id === tab.split!.focusedPaneId)
        ? tab.split!.focusedPaneId
        : leaves[0]!.id;
  const zoomed =
    desiredZoomPaneId !== undefined
      ? desiredZoomPaneId && leaves.some((l) => l.id === desiredZoomPaneId)
        ? desiredZoomPaneId
        : null
      : tab.split?.zoomedPaneId && leaves.some((l) => l.id === tab.split!.zoomedPaneId)
        ? tab.split!.zoomedPaneId
        : null;
  const split: TabSplitState = {
    root: normalized,
    focusedPaneId,
    ...(zoomed ? { zoomedPaneId: zoomed } : {}),
  };
  return { ...tab, ...docFields, split };
}

function activationTransition(
  s: ShellState,
  targetId: string,
  targetSpace: string | null,
  lookup: (k: string) => AgentSpaceRef | undefined,
  spacesMap: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]>,
  opts?: { capturePeek?: boolean; baseActiveBySpace?: Record<string, string | null> },
): Pick<ShellState, "active" | "activeBySpace" | "navHistoryBySpace" | "peek" | "peekReturnByTab"> {
  const scopeKey = targetSpace ?? ALL_SPACES_KEY;
  const activeMap = opts?.baseActiveBySpace ?? s.activeBySpace;
  const prevDisplayed = activeTabIdForSpace(
    { tabs: s.tabs, active: s.active, selectedSpace: targetSpace, activeBySpace: activeMap },
    lookup,
    spacesMap,
  );
  const navHistoryBySpace = pushSpaceNavHistory(s.navHistoryBySpace, scopeKey, prevDisplayed, targetId);
  let peekReturnByTab = s.peekReturnByTab ?? {};
  if (opts?.capturePeek && s.peek) {
    peekReturnByTab = { ...peekReturnByTab, [targetId]: s.peek };
  } else if (peekReturnByTab[targetId]) {
    const next = { ...peekReturnByTab };
    delete next[targetId];
    peekReturnByTab = next;
  }
  return {
    active: targetId,
    activeBySpace: { ...activeMap, [scopeKey]: targetId },
    navHistoryBySpace,
    peek: null,
    peekReturnByTab,
  };
}

function focusTabAndLeaf(
  s: ShellState,
  tab: ShellTab,
  leafId: string,
  targetSpace: string | null,
  lookup: (k: string) => AgentSpaceRef | undefined,
  spacesMap: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]>,
  updateLeaf?: (c: PaneContent) => PaneContent,
  opts?: { capturePeek?: boolean; baseActiveBySpace?: Record<string, string | null> },
): ShellState {
  recordPaneFocus(tab.id, leafId);
  const nextTabs = s.tabs.map((t) => {
    if (t.id !== tab.id) return t;
    const root = updateLeaf ? updateLeafContent(tabRootNode(t), leafId, updateLeaf) : tabRootNode(t);
    const keepZoom = t.split?.zoomedPaneId === leafId ? leafId : null;
    return applyRootToTab(t, root, leafId, keepZoom);
  });
  return {
    ...s,
    tabs: nextTabs,
    ...activationTransition(s, tab.id, targetSpace, lookup, spacesMap, opts),
  };
}

function findTabWithLeaf(
  tabs: readonly ShellTab[],
  predicate: (content: PaneContent) => boolean,
): { tab: ShellTab; leaf: SplitLeafNode } | null {
  for (const preferSynced of [true, false]) {
    for (const tab of tabs) {
      if (Boolean(tab.docHostId) !== preferSynced) continue;
      for (const leaf of tabLeaves(tab)) {
        if (predicate(leaf.content)) return { tab, leaf };
      }
    }
  }
  return null;
}

function hasNonEmptySpaceName(spaceKey: string | null | undefined): spaceKey is string {
  if (!spaceKey) return false;
  const sep = spaceKey.indexOf("\u0000");
  return sep >= 0 && spaceKey.slice(sep + 1).trim().length > 0;
}

/**
 * Opens the agent as a tab, or focuses its tab/pane when already open, and automatically
 * switches `selectedSpace` to that agent's `(deviceId, spaceName)` across devices like Herdr.app.
 */
export function openAgentTab(
  agentKey: string,
  mode?: AgentPaneMode,
  opts?: {
    lookupAgent?: (key: string) => AgentSpaceRef | undefined;
    spacesMap?: Record<string, readonly Pick<SpaceInfo, "id" | "name">[]>;
    followSpace?: boolean;
    docMeta?: {
      docHostId: string;
      docSpaceId?: string;
      docSpaceName?: string;
      docTabId?: string;
    };
  },
): void {
  const s = shellStore.get();
  const lookup = opts?.lookupAgent ?? makeLiveAgentLookup();
  const spacesMap = opts?.spacesMap ?? liveStore.get().spaces;
  const agent = lookup(agentKey);
  const docCanonicalId =
    opts?.docMeta?.docHostId && opts.docMeta.docSpaceId && opts.docMeta.docTabId
      ? syncedHerdrTabId(opts.docMeta.docHostId, opts.docMeta.docSpaceId, opts.docMeta.docTabId)
      : null;
  const hit =
    findTabWithLeaf(s.tabs, (c) => c.kind === "agent" && c.agentKey === agentKey) ??
    (docCanonicalId ? findTabWithLeaf(s.tabs, (c) => c.kind === "agent" && s.tabs.some((t) => t.id === docCanonicalId && tabLeaves(t).some((l) => l.content === c))) : null);

  let nextSpace = s.selectedSpace;
  if (opts?.followSpace !== false) {
    const hitSpace = hit ? tabSpaceKey(hit.tab, lookup, spacesMap) : null;
    const docMetaSpace =
      opts?.docMeta?.docHostId && opts.docMeta.docSpaceName !== undefined
        ? `${opts.docMeta.docHostId}\u0000${opts.docMeta.docSpaceName}`
        : null;
    const resolvedAgentSpace = agent ? resolveAgentSpaceKey(agent, spacesMap) : null;
    if (hasNonEmptySpaceName(hitSpace)) nextSpace = hitSpace;
    else if (hasNonEmptySpaceName(docMetaSpace)) nextSpace = docMetaSpace;
    else if (hasNonEmptySpaceName(resolvedAgentSpace)) nextSpace = resolvedAgentSpace;
  }

  let activeBySpace = s.activeBySpace;
  if (nextSpace !== s.selectedSpace) {
    const prevScope = s.selectedSpace ?? ALL_SPACES_KEY;
    const prevVisible = visibleTabsForSpace(s.tabs, s.selectedSpace, lookup, spacesMap);
    const prevActive = s.active && prevVisible.some((t) => t.id === s.active) ? s.active : prevVisible[0]?.id ?? null;
    activeBySpace = { ...s.activeBySpace, [prevScope]: prevActive };
  }
  const panelPatch = spacePanelTransition(s, nextSpace);

  if (hit) {
    const nextState = focusTabAndLeaf(
      s,
      hit.tab,
      hit.leaf.id,
      nextSpace,
      lookup,
      spacesMap,
      mode && hit.leaf.content.kind === "agent" && hit.leaf.content.mode !== mode
        ? (c) => (c.kind === "agent" ? { ...c, mode } : c)
        : undefined,
      { baseActiveBySpace: activeBySpace },
    );
    set({ ...nextState, selectedSpace: nextSpace, ...panelPatch });
    return;
  }

  const docFields: Partial<TabSplitFields> = opts?.docMeta?.docHostId
    ? {
        docHostId: opts.docMeta.docHostId,
        ...(opts.docMeta.docSpaceId ? { docSpaceId: opts.docMeta.docSpaceId } : {}),
        ...(opts.docMeta.docSpaceName !== undefined ? { docSpaceName: opts.docMeta.docSpaceName } : {}),
        ...(opts.docMeta.docTabId ? { docTabId: opts.docMeta.docTabId } : {}),
      }
    : {};
  const tab: AgentTab = {
    id: docCanonicalId ?? `a:${agentKey}`,
    kind: "agent",
    agentKey,
    ...(mode ? { mode } : {}),
    ...docFields,
  };
  set({
    tabs: [...s.tabs, tab],
    selectedSpace: nextSpace,
    ...activationTransition(s, tab.id, nextSpace, lookup, spacesMap, { baseActiveBySpace: activeBySpace }),
    ...panelPatch,
  });
}

export function setAgentTabMode(tabId: string, mode: AgentPaneMode): void {
  const s = shellStore.get();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const focused = focusedLeafOfTab(tab);
  setPaneAgentMode(tabId, focused.id, mode);
}

export function setPaneAgentMode(tabId: string, paneId: string, mode: AgentPaneMode): void {
  set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => {
      if (t.id !== tabId) return t;
      const root = updateLeafContent(tabRootNode(t), paneId, (c) => (c.kind === "agent" ? { ...c, mode } : c));
      return applyRootToTab(t, root);
    }),
  }));
}

export function openFileTab(
  agentKey: string,
  path: string,
  title: string,
  opts?: { absPath?: string; line?: number; endLine?: number; spaceKey?: string | null },
): void {
  const s = shellStore.get();
  const id = `f:${agentKey}:${path}`;
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  const agentSpaceRef = opts?.spaceKey === undefined ? lookup(agentKey) : undefined;
  const resolvedAgentSpace = agentSpaceRef ? resolveAgentSpaceKey(agentSpaceRef, spacesMap) : null;
  const scope =
    opts?.spaceKey !== undefined
      ? opts.spaceKey
      : (s.selectedSpace ?? (hasNonEmptySpaceName(resolvedAgentSpace) ? resolvedAgentSpace : null));
  const patch = {
    ...(opts?.absPath ? { absPath: opts.absPath } : {}),
    ...(opts?.line !== undefined ? { line: opts.line } : {}),
    ...(opts?.endLine !== undefined ? { endLine: opts.endLine } : {}),
    ...(scope ? { spaceKey: scope } : {}),
  };
  const hit = findTabWithLeaf(s.tabs, (c) => c.kind === "file" && c.agentKey === agentKey && c.path === path);
  if (hit) {
    set(
      focusTabAndLeaf(
        s,
        hit.tab,
        hit.leaf.id,
        scope,
        lookup,
        spacesMap,
        Object.keys(patch).length ? (c) => (c.kind === "file" ? { ...c, ...patch } : c) : undefined,
        { capturePeek: true },
      ),
    );
    return;
  }
  set({
    tabs: [...s.tabs, { id, kind: "file", agentKey, path, title, ...patch }],
    ...activationTransition(s, id, scope, lookup, spacesMap, { capturePeek: true }),
  });
}

/** Updates a file pane's resolved relative `path` & `absPath` after bare-filename lookup finds a subdirectory file. */
export function updateResolvedFilePanePath(
  agentKey: string,
  prevPath: string,
  resolvedPath: string,
  agentCwd?: string,
): void {
  const cleanResolved = resolvedPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleanResolved || cleanResolved === prevPath) return;
  const normCwd = agentCwd?.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "";
  const nextAbs =
    cleanResolved.startsWith("/") || cleanResolved.startsWith("~/") || /^[A-Za-z]:\//.test(cleanResolved)
      ? cleanResolved
      : normCwd
        ? `${normCwd}/${cleanResolved}`
        : undefined;
  const nextTitle = cleanResolved.split("/").filter(Boolean).pop() || cleanResolved;
  set((s) => {
    let changed = false;
    const nextTabs = s.tabs.map((t) => {
      const root = tabRootNode(t);
      let leafChanged = false;
      const walkUpdate = (node: SplitNode): SplitNode => {
        if (node.type === "leaf") {
          if (node.content.kind === "file" && node.content.agentKey === agentKey && node.content.path === prevPath) {
            leafChanged = true;
            return {
              ...node,
              content: {
                ...node.content,
                path: cleanResolved,
                title: nextTitle,
                ...(nextAbs ? { absPath: nextAbs } : {}),
              },
            };
          }
          return node;
        }
        return { ...node, children: node.children.map(walkUpdate) };
      };
      const walked = walkUpdate(root);
      if (!leafChanged) return t;
      changed = true;
      return applyRootToTab(t, walked);
    });
    return changed ? { ...s, tabs: nextTabs } : s;
  });
}

export function moveTab(fromId: string, toIndex: number): void {
  set((s) => {
    const fromIdx = s.tabs.findIndex((t) => t.id === fromId);
    if (fromIdx < 0) return s;
    const bounded = Math.max(0, Math.min(s.tabs.length - 1, toIndex));
    if (fromIdx === bounded) return s;
    const next = [...s.tabs];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(bounded, 0, moved!);
    return { ...s, tabs: next };
  });
}

export function moveTabRelative(fromId: string, targetId: string, side: "before" | "after"): void {
  set((s) => {
    const fromIdx = s.tabs.findIndex((t) => t.id === fromId);
    const targetIdx = s.tabs.findIndex((t) => t.id === targetId);
    if (fromIdx < 0 || targetIdx < 0 || fromIdx === targetIdx) return s;
    const insertSlot = side === "before" ? targetIdx : targetIdx + 1;
    const destIdx = fromIdx < insertSlot ? insertSlot - 1 : insertSlot;
    if (fromIdx === destIdx) return s;
    const next = [...s.tabs];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(destIdx, 0, moved!);
    return { ...s, tabs: next };
  });
}

export function openDiffTab(opts: {
  deviceId: string;
  agentKey?: string;
  cwd: string;
  path: string;
  staged: boolean;
  commit?: string;
  spaceKey?: string | null;
}): void {
  const s = shellStore.get();
  const id = `d:${opts.deviceId}:${opts.cwd}:${opts.commit ? opts.commit : opts.staged ? "staged" : "work"}:${opts.path}`;
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  const diffAgentRef = opts.spaceKey === undefined && opts.agentKey ? lookup(opts.agentKey) : undefined;
  const resolvedAgentSpace = diffAgentRef ? resolveAgentSpaceKey(diffAgentRef, spacesMap) : null;
  const scope =
    opts.spaceKey !== undefined
      ? opts.spaceKey
      : (s.selectedSpace ?? (hasNonEmptySpaceName(resolvedAgentSpace) ? resolvedAgentSpace : null));
  const title = opts.path.split(/[\\/]/).pop() || opts.path;
  const hit = findTabWithLeaf(
    s.tabs,
    (c) =>
      c.kind === "diff" &&
      c.deviceId === opts.deviceId &&
      c.cwd === opts.cwd &&
      c.path === opts.path &&
      c.staged === opts.staged &&
      (c.commit ?? "") === (opts.commit ?? ""),
  );
  if (hit) {
    set(focusTabAndLeaf(s, hit.tab, hit.leaf.id, scope, lookup, spacesMap, undefined, { capturePeek: true }));
    return;
  }
  const tab: DiffTab = {
    id,
    kind: "diff",
    deviceId: opts.deviceId,
    ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
    cwd: opts.cwd,
    path: opts.path,
    staged: opts.staged,
    ...(opts.commit ? { commit: opts.commit } : {}),
    title,
    ...(scope ? { spaceKey: scope } : {}),
  };
  set({
    tabs: [...s.tabs, tab],
    ...activationTransition(s, id, scope, lookup, spacesMap, { capturePeek: true }),
  });
}

export function openWebTab(url: string, title?: string, opts?: { spaceKey?: string | null; insertBeforeId?: string }): void {
  const s = shellStore.get();
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  const id = `w:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const spaceKey = opts?.spaceKey !== undefined ? opts.spaceKey : s.selectedSpace;
  const nextTab: WebTab = { id, kind: "web", url, title: title || url || "新网页", ...(spaceKey ? { spaceKey } : {}) };
  let tabs = [...s.tabs, nextTab];
  if (opts?.insertBeforeId) {
    const idx = s.tabs.findIndex((t) => t.id === opts.insertBeforeId);
    if (idx >= 0) {
      tabs = [...s.tabs.slice(0, idx), nextTab, ...s.tabs.slice(idx)];
    }
  }
  set({
    tabs,
    ...activationTransition(s, id, spaceKey, lookup, spacesMap, { capturePeek: true }),
  });
}

export function updateWebTab(id: string, patch: Partial<Pick<WebTab, "url" | "title">>): void {
  const s = shellStore.get();
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return;
  const leaves = tabLeaves(tab);
  const webLeaf = leaves.find((l) => l.content.kind === "web");
  if (!webLeaf) return;
  updateWebPane(id, webLeaf.id, patch);
}

export function updateWebPane(tabId: string, paneId: string, patch: Partial<{ url: string; title: string }>): void {
  set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => {
      if (t.id !== tabId) return t;
      const root = updateLeafContent(tabRootNode(t), paneId, (c) => (c.kind === "web" ? { ...c, ...patch } : c));
      return applyRootToTab(t, root);
    }),
  }));
}

export function closeTab(id: string): void {
  focusHistoryByTab.delete(id);
  const s = shellStore.get();
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;

  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  const scopeKey = s.selectedSpace ?? ALL_SPACES_KEY;
  const curDisplayed = activeTabIdForSpace(s, lookup, spacesMap);
  const wasDisplayed = curDisplayed === id || s.active === id;

  const visibleBefore = visibleTabsForSpace(s.tabs, s.selectedSpace, lookup, spacesMap);
  const tabs = s.tabs.filter((t) => t.id !== id);
  const visibleAfter = visibleTabsForSpace(tabs, s.selectedSpace, lookup, spacesMap);
  const nextNavHistory = removeTabIdsFromNavHistory(s.navHistoryBySpace, new Set([id]));

  let nextActive: string | null;
  if (!wasDisplayed) {
    nextActive =
      (s.active && visibleAfter.some((t) => t.id === s.active) ? s.active : null) ??
      (curDisplayed && visibleAfter.some((t) => t.id === curDisplayed) ? curDisplayed : null) ??
      visibleAfter[0]?.id ??
      null;
  } else {
    const visibleAfterSet = new Set(visibleAfter.map((t) => t.id));
    let fromHist: string | null = null;
    const scopeHist = nextNavHistory[scopeKey] ?? [];
    for (let k = scopeHist.length - 1; k >= 0; k -= 1) {
      const candidate = scopeHist[k]!;
      if (visibleAfterSet.has(candidate)) {
        fromHist = candidate;
        break;
      }
    }
    if (fromHist) {
      nextActive = fromHist;
    } else {
      const visIdx = visibleBefore.findIndex((t) => t.id === id);
      const fallbackIdx = visIdx >= 0 ? Math.min(visIdx, visibleAfter.length - 1) : 0;
      nextActive = visibleAfter[fallbackIdx]?.id ?? null;
    }
  }

  const nextBySpace: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(s.activeBySpace)) {
    if (v !== id) {
      nextBySpace[k] = v;
      continue;
    }
    const targetSpace = k === ALL_SPACES_KEY ? null : k;
    const spVis = visibleTabsForSpace(tabs, targetSpace, lookup, spacesMap);
    const spVisSet = new Set(spVis.map((t) => t.id));
    const spHist = nextNavHistory[k] ?? [];
    let spPick: string | null = null;
    for (let m = spHist.length - 1; m >= 0; m -= 1) {
      if (spVisSet.has(spHist[m]!)) {
        spPick = spHist[m]!;
        break;
      }
    }
    nextBySpace[k] = spPick ?? spVis[0]?.id ?? null;
  }
  nextBySpace[scopeKey] = nextActive;

  const restorePeek = wasDisplayed ? s.peekReturnByTab?.[id] : undefined;
  const nextPeekReturn = { ...(s.peekReturnByTab ?? {}) };
  delete nextPeekReturn[id];

  set({
    tabs,
    active: nextActive,
    activeBySpace: nextBySpace,
    navHistoryBySpace: nextNavHistory,
    peekReturnByTab: nextPeekReturn,
    ...(restorePeek ? { peek: restorePeek } : {}),
  });
}

// Split-pane actions (Herdr parity) ------------------------------------------------

export function focusTabPane(tabId: string, paneId: string): void {
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const leaves = tabLeaves(tab);
    if (!leaves.some((l) => l.id === paneId)) return s;
    recordPaneFocus(tabId, paneId);
    if (s.active === tabId && (!tab.split || (tab.split.focusedPaneId === paneId && !tab.split.zoomedPaneId))) {
      return s;
    }
    const nextTabs = s.tabs.map((t) => {
      if (t.id !== tabId) return t;
      const root = tabRootNode(t);
      const keepZoom = t.split?.zoomedPaneId === paneId ? paneId : null;
      return applyRootToTab(t, root, paneId, keepZoom);
    });
    const navPatch =
      s.active !== tabId
        ? activationTransition(s, tabId, s.selectedSpace, lookup, spacesMap)
        : { active: tabId, activeBySpace: { ...s.activeBySpace, [s.selectedSpace ?? ALL_SPACES_KEY]: tabId } };
    return {
      ...s,
      tabs: nextTabs,
      ...navPatch,
    };
  });
}

function pruneAgentFromTab(tab: ShellTab, agentKey: string): ShellTab | null {
  const leaves = tabLeaves(tab);
  const target = leaves.find((l) => l.content.kind === "agent" && l.content.agentKey === agentKey);
  if (!target) return tab;
  if (leaves.length <= 1) {
    focusHistoryByTab.delete(tab.id);
    return null;
  }
  const nextRoot = removeSplitLeaf(tabRootNode(tab), target.id);
  if (!nextRoot) {
    focusHistoryByTab.delete(tab.id);
    return null;
  }
  const remaining = listLeaves(nextRoot);
  const nextFocus =
    tab.split?.focusedPaneId && tab.split.focusedPaneId !== target.id && remaining.some((l) => l.id === tab.split!.focusedPaneId)
      ? tab.split.focusedPaneId
      : remaining[0]!.id;
  const nextZoom =
    tab.split?.zoomedPaneId && tab.split.zoomedPaneId !== target.id && remaining.some((l) => l.id === tab.split!.zoomedPaneId)
      ? tab.split.zoomedPaneId
      : null;
  return applyRootToTab(tab, nextRoot, nextFocus, nextZoom);
}

export function splitTabPane(
  tabId: string,
  paneId: string | null,
  direction: SplitDirection,
  content: PaneContent,
  opts?: { newPaneId?: string; dedupeOtherTabs?: boolean },
): string | null {
  const newPaneId = opts?.newPaneId?.trim() || makeSplitId("p");
  let inserted = false;
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const root = tabRootNode(tab);
    const leaves = listLeaves(root);
    const targetId = paneId && leaves.some((l) => l.id === paneId) ? paneId : focusedLeafOfTab(tab).id;
    recordPaneFocus(tabId, targetId);
    recordPaneFocus(tabId, newPaneId);
    const nextRoot = insertSplitLeaf(root, targetId, direction, {
      type: "leaf",
      id: newPaneId,
      weight: 1,
      content,
    });
    inserted = true;
    const dedupeKey = opts?.dedupeOtherTabs && content.kind === "agent" ? content.agentKey : null;
    const agentHost = dedupeKey ? dedupeKey.split("/")[0] : "";
    const targetHost = tab.docHostId || agentHost;
    const canDedupeOnHost = Boolean(dedupeKey && agentHost && targetHost === agentHost);
    const nextTabs: ShellTab[] = [];
    const removedIds = new Set<string>();
    for (const t of s.tabs) {
      if (t.id === tabId) {
        nextTabs.push(applyRootToTab(t, nextRoot, newPaneId, null));
        continue;
      }
      if (canDedupeOnHost && dedupeKey && (!t.docHostId || t.docHostId === targetHost)) {
        const pruned = pruneAgentFromTab(t, dedupeKey);
        if (pruned) nextTabs.push(pruned);
        else removedIds.add(t.id);
        continue;
      }
      nextTabs.push(t);
    }
    const baseState = removedIds.size
      ? { ...s, navHistoryBySpace: removeTabIdsFromNavHistory(s.navHistoryBySpace, removedIds) }
      : s;
    const navPatch =
      s.active !== tabId
        ? activationTransition(baseState, tabId, s.selectedSpace, lookup, spacesMap)
        : {
            active: tabId,
            activeBySpace: { ...s.activeBySpace, [s.selectedSpace ?? ALL_SPACES_KEY]: tabId },
            navHistoryBySpace: baseState.navHistoryBySpace,
            peek: null as string | null,
            peekReturnByTab: s.peekReturnByTab ?? {},
          };
    return {
      ...baseState,
      tabs: nextTabs,
      ...navPatch,
    };
  });
  return inserted ? newPaneId : null;
}

export function splitActivePaneWithContent(direction: SplitDirection, content: PaneContent): void {
  const s = shellStore.get();
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  const activeId = activeTabIdForSpace(s, lookup, spacesMap) ?? s.active;
  if (activeId && s.tabs.some((t) => t.id === activeId)) {
    splitTabPane(activeId, null, direction, content, { dedupeOtherTabs: content.kind === "agent" });
    return;
  }
  const existingIds = new Set(s.tabs.map((t) => t.id));
  const id = standaloneTabIdForContent(content, existingIds);
  const nextTab = contentToStandaloneTab(content, id);
  set({
    ...s,
    tabs: [...s.tabs, nextTab],
    ...activationTransition(s, id, s.selectedSpace, lookup, spacesMap),
  });
}

export function replaceTabPaneContent(tabId: string, paneId: string, content: PaneContent): void {
  set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => {
      if (t.id !== tabId) return t;
      const nextRoot = updateLeafContent(tabRootNode(t), paneId, () => content);
      return applyRootToTab(t, nextRoot, paneId);
    }),
  }));
}

export function closeTabPane(tabId: string, paneId: string): void {
  const s = shellStore.get();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const leaves = tabLeaves(tab);
  if (leaves.length <= 1) {
    closeTab(tabId);
    return;
  }
  const idx = leaves.findIndex((l) => l.id === paneId);
  if (idx < 0) return;
  const nextRoot = removeSplitLeaf(tabRootNode(tab), paneId);
  if (!nextRoot) {
    closeTab(tabId);
    return;
  }
  const remaining = listLeaves(nextRoot);
  const hist = (focusHistoryByTab.get(tabId) ?? []).filter((id) => id !== paneId && remaining.some((l) => l.id === id));
  focusHistoryByTab.set(tabId, hist);
  const fallbackFocus = hist[hist.length - 1] ?? remaining[Math.min(idx, remaining.length - 1)]?.id ?? remaining[0]!.id;
  const nextFocus =
    tab.split?.focusedPaneId && tab.split.focusedPaneId !== paneId && remaining.some((l) => l.id === tab.split!.focusedPaneId)
      ? tab.split.focusedPaneId
      : fallbackFocus;
  const nextZoom =
    tab.split?.zoomedPaneId && tab.split.zoomedPaneId !== paneId && remaining.some((l) => l.id === tab.split!.zoomedPaneId)
      ? tab.split.zoomedPaneId
      : null;
  set({
    ...s,
    tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, nextRoot, nextFocus, nextZoom) : t)),
  });
}

export function toggleZoomTabPane(tabId: string, paneId?: string): void {
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const leaves = tabLeaves(tab);
    if (leaves.length <= 1) return s;
    const targetId = paneId && leaves.some((l) => l.id === paneId) ? paneId : focusedLeafOfTab(tab).id;
    const unzoom = tab.split?.zoomedPaneId === targetId;
    const nextZoom = unzoom ? null : targetId;
    recordPaneFocus(tabId, targetId);
    return {
      ...s,
      tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, tabRootNode(t), targetId, nextZoom) : t)),
    };
  });
}

export function focusPaneDirection(tabId: string, direction: SplitDirection): boolean {
  const s = shellStore.get();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const root = tabRootNode(tab);
  const focused = focusedLeafOfTab(tab);
  const layout = computeSplitLayout(root, null);
  const targetId = findPaneInDirection(layout.leaves, focused.id, direction, focusHistoryByTab.get(tabId));
  if (!targetId) return false;
  recordPaneFocus(tabId, targetId);
  set({
    ...s,
    tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, root, targetId, null) : t)),
  });
  return true;
}

export function swapPaneDirection(tabId: string, direction: SplitDirection): boolean {
  const s = shellStore.get();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return false;
  const root = tabRootNode(tab);
  const focused = focusedLeafOfTab(tab);
  const layout = computeSplitLayout(root, null);
  // Herdr parity: pane.swap uses geometry only (no focus history bias).
  const targetId = findPaneInDirection(layout.leaves, focused.id, direction);
  if (!targetId) return false;
  const nextRoot = swapSplitLeaves(root, focused.id, targetId);
  set({
    ...s,
    tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, nextRoot, focused.id, null) : t)),
  });
  return true;
}

export function swapTabPanes(tabId: string, paneAId: string, paneBId: string): void {
  if (paneAId === paneBId) return;
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const nextRoot = swapSplitLeaves(tabRootNode(tab), paneAId, paneBId);
    recordPaneFocus(tabId, paneAId);
    return {
      ...s,
      tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, nextRoot, paneAId, null) : t)),
    };
  });
}

export function moveTabPaneToEdge(
  tabId: string,
  fromPaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
): void {
  if (fromPaneId === targetPaneId) return;
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const nextRoot = moveSplitLeaf(tabRootNode(tab), fromPaneId, targetPaneId, direction);
    recordPaneFocus(tabId, fromPaneId);
    return {
      ...s,
      tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, nextRoot, fromPaneId, null) : t)),
    };
  });
}

export function resizeTabSplit(tabId: string, branchId: string, index: number, deltaFraction: number): void {
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const nextRoot = resizeSplitPair(tabRootNode(tab), branchId, index, deltaFraction);
    return {
      ...s,
      tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, nextRoot) : t)),
    };
  });
}

export function equalizeTabSplits(tabId: string, branchId?: string): void {
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const nextRoot = equalizeSplitWeights(tabRootNode(tab), branchId);
    return {
      ...s,
      tabs: s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, nextRoot) : t)),
    };
  });
}

export function detachPaneToTab(
  tabId: string,
  paneId: string,
  opts?: { insertBeforeTabId?: string },
): string | null {
  let createdId: string | null = null;
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  set((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    if (!tab) return s;
    const root = tabRootNode(tab);
    const leaves = listLeaves(root);
    if (leaves.length <= 1) return s;
    const leaf = leaves.find((l) => l.id === paneId);
    if (!leaf) return s;
    const remainRoot = removeSplitLeaf(root, paneId);
    if (!remainRoot) return s;
    const remaining = listLeaves(remainRoot);
    const remainFocus =
      tab.split?.focusedPaneId && tab.split.focusedPaneId !== paneId && remaining.some((l) => l.id === tab.split!.focusedPaneId)
        ? tab.split.focusedPaneId
        : remaining[0]!.id;
    const existingIds = new Set(s.tabs.map((t) => t.id));
    const newId = standaloneTabIdForContent(leaf.content, existingIds);
    const spaceMeta: Partial<TabSplitFields> = tab.docHostId
      ? {
          docHostId: tab.docHostId,
          ...(tab.docSpaceId ? { docSpaceId: tab.docSpaceId } : {}),
          ...(tab.docSpaceName !== undefined ? { docSpaceName: tab.docSpaceName } : {}),
        }
      : {};
    const baseNewTab = contentToStandaloneTab(leaf.content, newId, leaf.id);
    const newTab = Object.keys(spaceMeta).length ? { ...baseNewTab, ...spaceMeta } : baseNewTab;
    createdId = newId;
    const updated = s.tabs.map((t) => (t.id === tabId ? applyRootToTab(t, remainRoot, remainFocus, null) : t));
    const tabIdx = updated.findIndex((t) => t.id === tabId);
    const insertIdx = opts?.insertBeforeTabId
      ? updated.findIndex((t) => t.id === opts.insertBeforeTabId)
      : tabIdx + 1;
    const bounded = insertIdx >= 0 ? insertIdx : updated.length;
    const nextTabs = [...updated.slice(0, bounded), newTab, ...updated.slice(bounded)];
    return {
      ...s,
      tabs: nextTabs,
      ...activationTransition(s, newId, s.selectedSpace, lookup, spacesMap),
    };
  });
  return createdId;
}

export function unsplitTabToTabs(tabId: string): void {
  set((s) => {
    const tabIdx = s.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx < 0) return s;
    const tab = s.tabs[tabIdx]!;
    const leaves = tabLeaves(tab);
    if (leaves.length <= 1) return s;
    const focused = focusedLeafOfTab(tab);
    const usedIds = new Set(s.tabs.map((t) => t.id));
    usedIds.delete(tabId);
    const firstDocFields = docFieldsOfTab(tab);
    const spaceMeta: Partial<TabSplitFields> = tab.docHostId
      ? {
          docHostId: tab.docHostId,
          ...(tab.docSpaceId ? { docSpaceId: tab.docSpaceId } : {}),
          ...(tab.docSpaceName !== undefined ? { docSpaceName: tab.docSpaceName } : {}),
        }
      : {};
    const expanded: ShellTab[] = leaves.map((leaf, i) => {
      if (i === 0) {
        usedIds.add(tabId);
        const firstTab = contentToStandaloneTab(leaf.content, tabId, leaf.id);
        return Object.keys(firstDocFields).length ? { ...firstTab, ...firstDocFields } : firstTab;
      }
      const nextId = standaloneTabIdForContent(leaf.content, usedIds);
      usedIds.add(nextId);
      const nextTab = contentToStandaloneTab(leaf.content, nextId, leaf.id);
      return Object.keys(spaceMeta).length ? { ...nextTab, ...spaceMeta } : nextTab;
    });
    const focusedIdx = Math.max(0, leaves.findIndex((l) => l.id === focused.id));
    const nextActiveId = expanded[focusedIdx]?.id ?? tabId;
    const nextTabs = [...s.tabs.slice(0, tabIdx), ...expanded, ...s.tabs.slice(tabIdx + 1)];
    const scopeKey = s.selectedSpace ?? ALL_SPACES_KEY;
    return {
      ...s,
      tabs: nextTabs,
      active: nextActiveId,
      activeBySpace: { ...s.activeBySpace, [scopeKey]: nextActiveId },
    };
  });
}

export function mergeTabIntoSplit(
  fromTabId: string,
  toTabId: string,
  targetPaneId: string | null,
  direction: SplitDirection,
): void {
  if (fromTabId === toTabId) return;
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  set((s) => {
    const fromTab = s.tabs.find((t) => t.id === fromTabId);
    const toTab = s.tabs.find((t) => t.id === toTabId);
    if (!fromTab || !toTab) return s;
    const fromLeaves = tabLeaves(fromTab);
    const insertLeaf = fromLeaves[0];
    if (!insertLeaf) return s;

    const toRoot = tabRootNode(toTab);
    const toLeaves = listLeaves(toRoot);
    const anchorId = targetPaneId && toLeaves.some((l) => l.id === targetPaneId) ? targetPaneId : focusedLeafOfTab(toTab).id;
    const nextToRoot = insertSplitLeaf(toRoot, anchorId, direction, { ...insertLeaf });
    recordPaneFocus(toTabId, insertLeaf.id);

    const nextTabs: ShellTab[] = [];
    const removedIds = new Set<string>();
    for (const t of s.tabs) {
      if (t.id === fromTabId) {
        if (fromLeaves.length > 1) {
          const remainRoot = removeSplitLeaf(tabRootNode(t), insertLeaf.id);
          if (remainRoot) nextTabs.push(applyRootToTab(t, remainRoot));
          else removedIds.add(t.id);
        } else {
          removedIds.add(t.id);
        }
        continue;
      }
      if (t.id === toTabId) {
        nextTabs.push(applyRootToTab(t, nextToRoot, insertLeaf.id, null));
        continue;
      }
      nextTabs.push(t);
    }
    const baseState = removedIds.size
      ? { ...s, navHistoryBySpace: removeTabIdsFromNavHistory(s.navHistoryBySpace, removedIds) }
      : s;
    return {
      ...baseState,
      tabs: nextTabs,
      ...activationTransition(baseState, toTabId, s.selectedSpace, lookup, spacesMap),
    };
  });
}

/** Closes tabs belonging to `spaceKey` and clears `selectedSpace` if active. */
export function closeTabsForSpace(
  spaceKey: string,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
): void {
  set((s) => {
    const removedIds = new Set<string>();
    const tabs = s.tabs.filter((t) => {
      if (tabSpaceKey(t, lookupAgent) === spaceKey) {
        removedIds.add(t.id);
        return false;
      }
      return true;
    });
    const selectedSpace = s.selectedSpace === spaceKey ? null : s.selectedSpace;
    const nextBySpace = { ...s.activeBySpace };
    delete nextBySpace[spaceKey];
    const nextNavHistory = removeTabIdsFromNavHistory(s.navHistoryBySpace, removedIds);
    delete nextNavHistory[spaceKey];
    const nextPeekReturn = { ...(s.peekReturnByTab ?? {}) };
    for (const rid of removedIds) delete nextPeekReturn[rid];
    const activeStillThere = s.active && tabs.some((t) => t.id === s.active);
    const active = activeStillThere
      ? s.active
      : activeTabIdForSpace({ tabs, active: null, selectedSpace, activeBySpace: nextBySpace }, lookupAgent);
    return {
      ...s,
      tabs,
      active,
      selectedSpace,
      activeBySpace: nextBySpace,
      navHistoryBySpace: nextNavHistory,
      peekReturnByTab: nextPeekReturn,
    };
  });
}

export function setActiveTab(id: string): void {
  const lookup = makeLiveAgentLookup();
  const spacesMap = liveStore.get().spaces;
  set((s) => {
    const target = s.tabs.find((t) => t.id === id);
    const tabSp = target ? tabSpaceKey(target, lookup, spacesMap) : null;
    const nextSpace = hasNonEmptySpaceName(tabSp) ? tabSp : s.selectedSpace;
    let nextBySpace = s.activeBySpace;
    if (nextSpace !== s.selectedSpace) {
      const prevScope = s.selectedSpace ?? ALL_SPACES_KEY;
      const prevVisible = visibleTabsForSpace(s.tabs, s.selectedSpace, lookup, spacesMap);
      const prevActive = s.active && prevVisible.some((t) => t.id === s.active) ? s.active : prevVisible[0]?.id ?? null;
      nextBySpace = { ...s.activeBySpace, [prevScope]: prevActive };
    }
    const panelPatch = spacePanelTransition(s, nextSpace);
    return {
      ...s,
      selectedSpace: nextSpace,
      ...activationTransition(s, id, nextSpace, lookup, spacesMap, { baseActiveBySpace: nextBySpace }),
      ...panelPatch,
    };
  });
}

/** Moves the active tab by `step` (wraps around within `visibleTabs`, or all tabs if omitted). */
export function cycleTab(step: 1 | -1, visibleTabs?: ShellTab[]): void {
  const s = shellStore.get();
  const list = visibleTabs && visibleTabs.length ? visibleTabs : s.tabs;
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((t) => t.id === s.active));
  const nextId = list[(i + step + list.length) % list.length]!.id;
  set({
    ...activationTransition(s, nextId, s.selectedSpace, makeLiveAgentLookup(), liveStore.get().spaces),
  });
}

/** Shows the panel at `id`, or hides it when `id` is already showing. */
export function togglePanel(id: PanelId): void {
  set((s) => {
    const nextPanel = s.panel === id ? null : id;
    const scope = s.selectedSpace ?? ALL_SPACES_KEY;
    return {
      ...s,
      panel: nextPanel,
      panelBySpace: { ...(s.panelBySpace ?? {}), [scope]: nextPanel },
    };
  });
}

export function showPanel(id: PanelId | null): void {
  set((s) => {
    const scope = s.selectedSpace ?? ALL_SPACES_KEY;
    return {
      ...s,
      panel: id,
      ...(id !== "subagent" ? { panelBySpace: { ...(s.panelBySpace ?? {}), [scope]: id } } : {}),
    };
  });
}

export function openSubagentAside(agentKey: string, sub: SubSession, trail: SubSession[]): void {
  set({ subagentAside: { agentKey, sub, trail }, panel: "subagent" });
}

export function setPanelWidth(px: number): void {
  set({ panelWidth: clampPanel(px) });
}

export function openSettingsFrame(section: FrameSection = "look"): void {
  set({ settings: section, palette: false });
}

export function closeSettingsFrame(): void {
  set({ settings: null });
}

export function setPalette(open: false | "command" | "jump"): void {
  set({ palette: open });
}

export function setPeek(agentKey: string | null): void {
  set({ peek: agentKey });
}

/** Renames a tab (empty string clears custom name back to numbered label). */
export function renameShellTab(tabId: string, name: string): void {
  const clean = name.trim();
  set((s) => {
    let changed = false;
    const tabs = s.tabs.map((t) => {
      if (t.id !== tabId) return t;
      if ((t.docTabName ?? "") === clean) return t;
      changed = true;
      return { ...t, docTabName: clean };
    });
    return changed ? { ...s, tabs } : s;
  });
}

function sameHerdrSplitShape(a: SplitNode | null, b: SplitNode | null): boolean {
  if (!a || !b) return a === b;
  if (a.type !== b.type) return false;
  if (a.type === "leaf" && b.type === "leaf") {
    return (
      a.id === b.id &&
      Math.abs(a.weight - b.weight) < 1e-3 &&
      a.content.kind === "agent" &&
      b.content.kind === "agent" &&
      a.content.agentKey === b.content.agentKey
    );
  }
  if (a.type === "split" && b.type === "split") {
    if (a.axis !== b.axis || a.children.length !== b.children.length || Math.abs(a.weight - b.weight) >= 1e-3) {
      return false;
    }
    return a.children.every((ch, i) => sameHerdrSplitShape(ch, b.children[i]!));
  }
  return false;
}

function resolveDocSpaceName(
  space: Pick<HerdrDoc["spaces"][number], "id" | "name" | "folder">,
  convertedLeaves: readonly SplitLeafNode[],
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
  hostSpaces?: readonly Pick<SpaceInfo, "id" | "name" | "folder">[],
  prevSpaceName?: string,
): string {
  const direct = space.name?.trim();
  if (direct) return direct;
  const metaName = hostSpaces?.find((sp) => sp.id === space.id)?.name?.trim();
  if (metaName) return metaName;
  for (const leaf of convertedLeaves) {
    if (leaf.content.kind !== "agent") continue;
    const a = lookupAgent(leaf.content.agentKey);
    const sp = a ? spaceNameFromWhere(a.where) : "";
    if (sp) return sp;
  }
  const base = (space.folder ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop()?.trim();
  return base || prevSpaceName?.trim() || "";
}

/**
 * Updates `docSpaceName`, `selectedSpace`, and per-space state maps cleanly when a Space is renamed.
 */
export function renameSpaceInShellStore(
  hostId: string,
  spaceId: string | undefined,
  oldName: string,
  newName: string,
): void {
  const cleanHost = hostId.trim();
  const cleanOld = oldName.trim();
  const cleanNew = newName.trim();
  if (!cleanHost || !cleanNew) return;
  const oldKey = `${cleanHost}\u0000${cleanOld}`;
  const newKey = `${cleanHost}\u0000${cleanNew}`;
  set((s) => {
    let changed = false;
    const updateLeafSpaceKey = (node: SplitNode): { node: SplitNode; touched: boolean } => {
      if (node.type === "leaf") {
        if (node.content.kind !== "agent" && node.content.spaceKey === oldKey && oldKey !== newKey) {
          return { node: { ...node, content: { ...node.content, spaceKey: newKey } }, touched: true };
        }
        return { node, touched: false };
      }
      let anyTouched = false;
      const children = node.children.map((ch) => {
        const res = updateLeafSpaceKey(ch);
        if (res.touched) anyTouched = true;
        return res.node;
      });
      return anyTouched ? { node: { ...node, children }, touched: true } : { node, touched: false };
    };

    const nextTabs = s.tabs.map((t) => {
      let next = t;
      let tabTouched = false;
      const matchesDocSpace =
        Boolean(spaceId && t.docHostId === cleanHost && t.docSpaceId === spaceId) ||
        Boolean(t.docHostId === cleanHost && t.docSpaceName === cleanOld);
      if (matchesDocSpace && next.docSpaceName !== cleanNew) {
        next = { ...next, docSpaceName: cleanNew };
        tabTouched = true;
      }
      if (oldKey !== newKey) {
        if (next.kind !== "agent" && next.spaceKey === oldKey) {
          next = { ...next, spaceKey: newKey };
          tabTouched = true;
        }
        if (next.split) {
          const walked = updateLeafSpaceKey(next.split.root);
          if (walked.touched) {
            next = { ...next, split: { ...next.split, root: walked.node } };
            tabTouched = true;
          }
        }
      }
      if (tabTouched) changed = true;
      return next;
    });

    let selectedSpace = s.selectedSpace;
    let activeBySpace = s.activeBySpace;
    let panelBySpace = s.panelBySpace;
    let navHistoryBySpace = s.navHistoryBySpace;

    if (cleanOld && oldKey !== newKey) {
      if (s.selectedSpace === oldKey) {
        selectedSpace = newKey;
        changed = true;
      }
      if (Object.hasOwn(s.activeBySpace, oldKey)) {
        activeBySpace = { ...s.activeBySpace, [newKey]: s.activeBySpace[oldKey] ?? null };
        delete activeBySpace[oldKey];
        changed = true;
      }
      if (s.panelBySpace && Object.hasOwn(s.panelBySpace, oldKey)) {
        panelBySpace = { ...s.panelBySpace, [newKey]: s.panelBySpace[oldKey] ?? null };
        delete panelBySpace[oldKey];
        changed = true;
      }
      if (s.navHistoryBySpace && Object.hasOwn(s.navHistoryBySpace, oldKey)) {
        const merged = [...(s.navHistoryBySpace[newKey] ?? []), ...s.navHistoryBySpace[oldKey]!];
        navHistoryBySpace = { ...s.navHistoryBySpace, [newKey]: merged.slice(-MAX_SPACE_NAV_HISTORY) };
        delete navHistoryBySpace[oldKey];
        changed = true;
      }
    }

    return changed
      ? {
          ...s,
          tabs: nextTabs,
          selectedSpace,
          activeBySpace,
          ...(panelBySpace ? { panelBySpace } : {}),
          ...(navHistoryBySpace ? { navHistoryBySpace } : {}),
        }
      : s;
  });
}

/**
 * Updates `docSpaceName` on synced tabs when `spaces.list` resolves dynamically computed names
 * for unnamed spaces (`space.name === ""` in `herdr-app` docs).
 */
export function refreshHostDocSpaceNames(
  hostId: string,
  hostSpaces: readonly Pick<SpaceInfo, "id" | "name">[],
): void {
  if (!hostSpaces.length) return;
  const byId = new Map(hostSpaces.filter((s) => s.id && s.name?.trim()).map((s) => [s.id, s.name.trim()] as const));
  if (!byId.size) return;
  set((s) => {
    let changed = false;
    const tabs = s.tabs.map((t) => {
      if (t.docHostId !== hostId || !t.docSpaceId) return t;
      const nextName = byId.get(t.docSpaceId);
      if (!nextName || t.docSpaceName === nextName) return t;
      changed = true;
      return { ...t, docSpaceName: nextName };
    });
    return changed ? { ...s, tabs } : s;
  });
}

/**
 * Reconciles a host's `"herdr-app"` shared layout document into `shellStore.tabs`,
 * preserving Pocket-only tabs/panes (`file`/`diff`/`web`), private per-tab focus/zoom,
 * and deduplicating any standalone `a:${agentKey}` tabs already present in the doc.
 */
export function reconcileHostHerdrDoc(
  hostId: string,
  doc: HerdrDoc,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined = makeLiveAgentLookup(),
  hostSpaces?: readonly Pick<SpaceInfo, "id" | "name" | "folder">[],
): void {
  if (!doc || !Array.isArray(doc.spaces)) return;
  set((s) => {
    const prevByDocTabKey = new Map<string, ShellTab>();
    const standaloneByAgentKey = new Map<string, ShellTab>();
    for (const t of s.tabs) {
      if (t.docHostId === hostId && t.docSpaceId && t.docTabId) {
        prevByDocTabKey.set(`${t.docSpaceId}\u0000${t.docTabId}`, t);
      } else if (!t.docHostId && t.kind === "agent" && !t.split && t.agentKey.startsWith(`${hostId}/hc:`)) {
        standaloneByAgentKey.set(t.agentKey, t);
      }
    }

    const reconciledHostTabs: ShellTab[] = [];
    const idRemap = new Map<string, string>();
    const absorbedStandaloneIds = new Set<string>();

    for (const space of doc.spaces) {
      if (!space || typeof space !== "object" || !space.id) continue;
      for (const docTab of space.tabs ?? []) {
        if (!docTab || typeof docTab !== "object" || !docTab.id) continue;
        const canonicalId = syncedHerdrTabId(hostId, space.id, docTab.id);
        const docKey = `${space.id}\u0000${docTab.id}`;
        const prev = prevByDocTabKey.get(docKey) ?? s.tabs.find((t) => t.id === canonicalId);
        const converted = herdrRootToSplitNode(hostId, docTab.root, prev ? tabRootNode(prev) : undefined);
        if (!converted) continue;

        const convertedLeaves = listLeaves(converted);
        const resolvedSpaceName = resolveDocSpaceName(space, convertedLeaves, lookupAgent, hostSpaces, prev?.docSpaceName);

        let absorbedFocusLeafId: string | null = null;
        let absorbedMountKey: string | undefined;
        for (const leaf of convertedLeaves) {
          if (leaf.content.kind !== "agent") continue;
          const standalone = standaloneByAgentKey.get(leaf.content.agentKey);
          if (standalone) {
            absorbedStandaloneIds.add(standalone.id);
            idRemap.set(standalone.id, canonicalId);
            absorbedMountKey = absorbedMountKey ?? standalone.mountKey ?? standalone.id;
            if (s.active === standalone.id) absorbedFocusLeafId = leaf.id;
            if (!prev && standalone.kind === "agent" && standalone.mode) {
              leaf.content = { ...leaf.content, mode: standalone.mode };
            }
          }
        }
        const resolvedMountKey =
          prev?.mountKey ??
          (prev && prev.id !== canonicalId ? prev.id : undefined) ??
          absorbedMountKey;
        const docFields: TabSplitFields = {
          ...(resolvedMountKey && resolvedMountKey !== canonicalId ? { mountKey: resolvedMountKey } : {}),
          docHostId: hostId,
          docSpaceId: space.id,
          docSpaceName: resolvedSpaceName,
          docTabId: docTab.id,
          docTabName: docTab.name ?? "",
        };

        // Preserve mixed Pocket-only panes (`file`/`diff`/`web`) inside this tab if the hc skeleton hasn't changed.
        if (prev) {
          const prevLeaves = tabLeaves(prev);
          const hasPocketOnlyPane = prevLeaves.some((l) => l.content.kind !== "agent");
          if (hasPocketOnlyPane) {
            const prevHcProjection = splitNodeToHerdrRoot(hostId, tabRootNode(prev), docTab.root);
            const prevProjectedSplit = herdrRootToSplitNode(hostId, prevHcProjection, tabRootNode(prev));
            if (sameHerdrSplitShape(prevProjectedSplit, converted)) {
              reconciledHostTabs.push({ ...prev, id: canonicalId, ...docFields });
              if (prev.id !== canonicalId) idRemap.set(prev.id, canonicalId);
              continue;
            }
          }
        }

        const baseTab: ShellTab =
          converted.type === "leaf" && converted.content.kind === "agent"
            ? {
                id: canonicalId,
                kind: "agent",
                agentKey: converted.content.agentKey,
                ...(converted.content.mode ? { mode: converted.content.mode } : {}),
                primaryPaneId: converted.id,
                ...docFields,
              }
            : {
                id: canonicalId,
                kind: "agent",
                agentKey:
                  convertedLeaves[0]?.content.kind === "agent"
                    ? convertedLeaves[0].content.agentKey
                    : makeFallbackAgentKey(hostId, docTab.id),
                mode: "term",
                ...docFields,
                split: {
                  root: converted,
                  focusedPaneId:
                    prev?.split?.focusedPaneId && convertedLeaves.some((l) => l.id === prev.split!.focusedPaneId)
                      ? prev.split.focusedPaneId
                      : (absorbedFocusLeafId ?? convertedLeaves[0]!.id),
                  ...(prev?.split?.zoomedPaneId && convertedLeaves.some((l) => l.id === prev.split!.zoomedPaneId)
                    ? { zoomedPaneId: prev.split.zoomedPaneId }
                    : {}),
                },
              };

        if (prev && prev.id !== canonicalId) idRemap.set(prev.id, canonicalId);
        reconciledHostTabs.push(baseTab);
      }
    }

    // Splice host's reconciled tabs at the first position where a host synced/absorbed tab lived, preserving other tabs' relative order.
    let insertAt = -1;
    const otherTabs: ShellTab[] = [];
    for (let i = 0; i < s.tabs.length; i++) {
      const t = s.tabs[i]!;
      const belongsHere = t.docHostId === hostId || absorbedStandaloneIds.has(t.id);
      if (belongsHere) {
        if (insertAt < 0) insertAt = otherTabs.length;
      } else {
        otherTabs.push(t);
      }
    }
    const nextTabs =
      insertAt < 0
        ? [...reconciledHostTabs, ...otherTabs]
        : [...otherTabs.slice(0, insertAt), ...reconciledHostTabs, ...otherTabs.slice(insertAt)];

    const remapId = (id: string | null | undefined): string | null => {
      if (!id) return null;
      const mapped = idRemap.get(id) ?? id;
      return nextTabs.some((t) => t.id === mapped) ? mapped : null;
    };

    const mergedSpacesMap = hostSpaces
      ? { ...liveStore.get().spaces, [hostId]: hostSpaces }
      : liveStore.get().spaces;
    const visibleNext = visibleTabsForSpace(nextTabs, s.selectedSpace, lookupAgent, mergedSpacesMap);
    const remappedActive = remapId(s.active);
    const nextActive =
      (remappedActive && (!s.selectedSpace || visibleNext.some((t) => t.id === remappedActive))
        ? remappedActive
        : null) ??
      visibleNext[0]?.id ??
      null;
    const nextBySpace: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(s.activeBySpace)) {
      nextBySpace[k] = remapId(v);
    }
    const nextNavHistory: Record<string, string[]> = {};
    for (const [k, list] of Object.entries(s.navHistoryBySpace ?? {})) {
      const mappedList: string[] = [];
      for (const rawId of list) {
        const mapped = remapId(rawId);
        if (mapped && mappedList[mappedList.length - 1] !== mapped) {
          mappedList.push(mapped);
        }
      }
      if (mappedList.length > 0) nextNavHistory[k] = mappedList.slice(-MAX_SPACE_NAV_HISTORY);
    }
    const nextPeekReturn: Record<string, string> = {};
    for (const [tabId, agentKey] of Object.entries(s.peekReturnByTab ?? {})) {
      const mapped = remapId(tabId);
      if (mapped) nextPeekReturn[mapped] = agentKey;
    }

    if (
      JSON.stringify(nextTabs) === JSON.stringify(s.tabs) &&
      nextActive === s.active &&
      JSON.stringify(nextBySpace) === JSON.stringify(s.activeBySpace) &&
      JSON.stringify(nextNavHistory) === JSON.stringify(s.navHistoryBySpace ?? {}) &&
      JSON.stringify(nextPeekReturn) === JSON.stringify(s.peekReturnByTab ?? {})
    ) {
      return s;
    }

    return {
      ...s,
      tabs: nextTabs,
      active: nextActive,
      activeBySpace: nextBySpace,
      navHistoryBySpace: nextNavHistory,
      peekReturnByTab: nextPeekReturn,
    };
  });
}

function makeFallbackAgentKey(hostId: string, docTabId: string): string {
  return `${hostId}/hc:${docTabId}`;
}

/**
 * Produces stable React keys per leaf content identity so converting `1 pane <-> N panes`
 * or `p0:...` placeholder IDs into synced Herdr block IDs never unmounts running terminals.
 */
export function stableSplitLeafKeys(leaves: readonly SplitLeafNode[]): string[] {
  const seen = new Map<string, number>();
  return leaves.map((leaf) => {
    const c = leaf.content;
    const base =
      c.kind === "agent"
        ? `agent:${c.agentKey}`
        : c.kind === "web"
          ? `web:${c.webId}`
          : c.kind === "file"
            ? `file:${c.agentKey}:${c.path}`
            : `diff:${c.deviceId}:${c.cwd}:${c.commit || (c.staged ? "staged" : "work")}:${c.path}`;
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    return occ === 0 ? base : `${base}#${occ}`;
  });
}
