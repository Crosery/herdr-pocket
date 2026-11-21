import type { SubSession } from "@herdr-pocket/protocol";
import { createStore } from "../lib/store";
import type { SettingsSection } from "../views/SettingsView";

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

export type AgentTab = { id: string; kind: "agent"; agentKey: string; mode?: AgentPaneMode };
export type FileTab = {
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
export type WebTab = { id: string; kind: "web"; url: string; title: string; spaceKey?: string | null };
export type DiffTab = {
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

export function spaceKeyFromAgent(a: AgentSpaceRef): string {
  const raw = a.where ?? "";
  const slash = raw.indexOf(" / ");
  const sp = (slash >= 0 ? raw.slice(0, slash) : raw).trim();
  return `${a.deviceId}\u0000${sp}`;
}

export function tabSpaceKey(
  tab: ShellTab,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
): string | null {
  if (tab.kind === "agent") {
    const a = lookupAgent(tab.agentKey);
    return a ? spaceKeyFromAgent(a) : null;
  }
  if (tab.kind === "file") {
    if (tab.spaceKey) return tab.spaceKey;
    const a = lookupAgent(tab.agentKey);
    return a ? spaceKeyFromAgent(a) : null;
  }
  if (tab.kind === "diff") {
    if (tab.spaceKey) return tab.spaceKey;
    if (tab.agentKey) {
      const a = lookupAgent(tab.agentKey);
      if (a) return spaceKeyFromAgent(a);
    }
    return null;
  }
  return tab.spaceKey ?? null;
}

export function visibleTabsForSpace(
  tabs: ShellTab[],
  selectedSpace: string | null,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
): ShellTab[] {
  if (!selectedSpace) return tabs;
  return tabs.filter((t) => tabSpaceKey(t, lookupAgent) === selectedSpace);
}

export function activeTabIdForSpace(
  state: Pick<ShellState, "tabs" | "active" | "selectedSpace" | "activeBySpace">,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined,
): string | null {
  const visible = visibleTabsForSpace(state.tabs, state.selectedSpace, lookupAgent);
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
  /** The side panel's section, or null when the panel is hidden. */
  panel: PanelId | null;
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

function load(): Pick<ShellState, "tabs" | "active" | "selectedSpace" | "activeBySpace" | "panel" | "panelWidth"> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ShellState> | null;
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs
        .filter((t): t is ShellTab =>
          Boolean(
            t &&
              typeof t.id === "string" &&
              (t.kind === "agent" || t.kind === "file" || t.kind === "web" || t.kind === "diff"),
          ),
        )
        .map((t) =>
          t.kind === "agent"
            ? {
                id: t.id,
                kind: "agent" as const,
                agentKey: t.agentKey,
                ...(t.mode === "chat" || t.mode === "term" ? { mode: t.mode } : {}),
              }
            : t,
        );
      const activeBySpace =
        raw.activeBySpace && typeof raw.activeBySpace === "object" && !Array.isArray(raw.activeBySpace)
          ? raw.activeBySpace
          : {};
      const panel =
        raw.panel === "files" || raw.panel === "git" || raw.panel === "browser" || raw.panel === "assistant"
          ? raw.panel
          : null;
      return {
        tabs,
        active: tabs.some((t) => t.id === raw.active) ? raw.active! : (tabs[0]?.id ?? null),
        selectedSpace: typeof raw.selectedSpace === "string" ? raw.selectedSpace : null,
        activeBySpace,
        panel,
        panelWidth: clampPanel(Number(raw.panelWidth) || PANEL_DEFAULT),
      };
    }
  } catch {
    // Unreadable: start empty.
  }
  return { tabs: [], active: null, selectedSpace: null, activeBySpace: {}, panel: null, panelWidth: PANEL_DEFAULT };
}

export function clampPanel(px: number): number {
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, px)));
}

export const shellStore = createStore<ShellState>({
  ...load(),
  subagentAside: null,
  settings: null,
  palette: false,
  peek: null,
});

shellStore.subscribe(() => {
  const { tabs, active, selectedSpace, activeBySpace, panel, panelWidth } = shellStore.get();
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        tabs,
        active,
        selectedSpace,
        activeBySpace,
        panel: panel === "subagent" ? null : panel,
        panelWidth,
      }),
    );
  } catch {
    // Storage off: tabs last for this session.
  }
});

const set = shellStore.set;

export function setSelectedSpace(
  selectedSpace: string | null,
  lookupAgent: (agentKey: string) => AgentSpaceRef | undefined = () => undefined,
): void {
  set((s) => {
    const prevScope = s.selectedSpace ?? ALL_SPACES_KEY;
    const prevVisible = visibleTabsForSpace(s.tabs, s.selectedSpace, lookupAgent);
    const prevActive = s.active && prevVisible.some((t) => t.id === s.active) ? s.active : prevVisible[0]?.id ?? null;
    const activeBySpace = { ...s.activeBySpace, [prevScope]: prevActive };
    const nextVisible = visibleTabsForSpace(s.tabs, selectedSpace, lookupAgent);
    const nextScope = selectedSpace ?? ALL_SPACES_KEY;
    const remembered = activeBySpace[nextScope];
    const nextActive =
      (remembered && nextVisible.some((t) => t.id === remembered) ? remembered : undefined) ??
      nextVisible[0]?.id ??
      null;
    return {
      ...s,
      selectedSpace,
      activeBySpace,
      active: nextActive,
    };
  });
}

/** Opens the agent as a tab, or focuses its tab when it is already open. */
export function openAgentTab(agentKey: string, mode?: AgentPaneMode): void {
  const s = shellStore.get();
  const hit = s.tabs.find((t): t is AgentTab => t.kind === "agent" && t.agentKey === agentKey);
  const scope = s.selectedSpace ?? ALL_SPACES_KEY;
  if (hit) {
    if (mode && hit.mode !== mode) {
      return set({
        tabs: s.tabs.map((t) => (t.id === hit.id && t.kind === "agent" ? { ...t, mode } : t)),
        active: hit.id,
        activeBySpace: { ...s.activeBySpace, [scope]: hit.id },
        peek: null,
      });
    }
    return set({ active: hit.id, activeBySpace: { ...s.activeBySpace, [scope]: hit.id }, peek: null });
  }
  const tab: AgentTab = { id: `a:${agentKey}`, kind: "agent", agentKey, ...(mode ? { mode } : {}) };
  set({
    tabs: [...s.tabs, tab],
    active: tab.id,
    activeBySpace: { ...s.activeBySpace, [scope]: tab.id },
    peek: null,
  });
}

export function setAgentTabMode(tabId: string, mode: AgentPaneMode): void {
  set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "agent" ? { ...t, mode } : t)),
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
  const scope = opts?.spaceKey !== undefined ? opts.spaceKey : s.selectedSpace;
  const scopeMapKey = scope ?? ALL_SPACES_KEY;
  const patch = {
    ...(opts?.absPath ? { absPath: opts.absPath } : {}),
    ...(opts?.line !== undefined ? { line: opts.line } : {}),
    ...(opts?.endLine !== undefined ? { endLine: opts.endLine } : {}),
    ...(scope ? { spaceKey: scope } : {}),
  };
  if (s.tabs.some((t) => t.id === id)) {
    set({
      tabs: Object.keys(patch).length ? s.tabs.map((t) => (t.id === id && t.kind === "file" ? { ...t, ...patch } : t)) : s.tabs,
      active: id,
      activeBySpace: { ...s.activeBySpace, [scopeMapKey]: id },
    });
    return;
  }
  set({
    tabs: [...s.tabs, { id, kind: "file", agentKey, path, title, ...patch }],
    active: id,
    activeBySpace: { ...s.activeBySpace, [scopeMapKey]: id },
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
  const scope = opts.spaceKey !== undefined ? opts.spaceKey : s.selectedSpace;
  const scopeMapKey = scope ?? ALL_SPACES_KEY;
  const title = opts.path.split(/[\\/]/).pop() || opts.path;
  if (s.tabs.some((t) => t.id === id)) {
    set({
      active: id,
      activeBySpace: { ...s.activeBySpace, [scopeMapKey]: id },
    });
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
    active: id,
    activeBySpace: { ...s.activeBySpace, [scopeMapKey]: id },
  });
}

export function openWebTab(url: string, title?: string, opts?: { spaceKey?: string | null; insertBeforeId?: string }): void {
  const s = shellStore.get();
  const id = `w:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const spaceKey = opts?.spaceKey !== undefined ? opts.spaceKey : s.selectedSpace;
  const scopeKey = spaceKey ?? ALL_SPACES_KEY;
  const nextTab: WebTab = { id, kind: "web", url, title: title || url || "新网页", ...(spaceKey ? { spaceKey } : {}) };
  let tabs = [...s.tabs, nextTab];
  if (opts?.insertBeforeId) {
    const idx = s.tabs.findIndex((t) => t.id === opts.insertBeforeId);
    if (idx >= 0) {
      tabs = [...s.tabs.slice(0, idx), nextTab, ...s.tabs.slice(idx)];
    }
  }
  set({ tabs, active: id, activeBySpace: { ...s.activeBySpace, [scopeKey]: id } });
}

export function updateWebTab(id: string, patch: Partial<Pick<WebTab, "url" | "title">>): void {
  set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id && t.kind === "web" ? { ...t, ...patch } : t)) }));
}

export function closeTab(id: string): void {
  const s = shellStore.get();
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const scopeKey = s.selectedSpace ?? ALL_SPACES_KEY;
  const active = s.active === id ? (tabs[i]?.id ?? tabs[i - 1]?.id ?? null) : s.active;
  set({
    tabs,
    active,
    activeBySpace: { ...s.activeBySpace, [scopeKey]: active },
  });
}

export function setActiveTab(id: string): void {
  set((s) => {
    const scopeKey = s.selectedSpace ?? ALL_SPACES_KEY;
    return { ...s, active: id, activeBySpace: { ...s.activeBySpace, [scopeKey]: id } };
  });
}

/** Moves the active tab by `step` (wraps around within `visibleTabs`, or all tabs if omitted). */
export function cycleTab(step: 1 | -1, visibleTabs?: ShellTab[]): void {
  const s = shellStore.get();
  const list = visibleTabs && visibleTabs.length ? visibleTabs : s.tabs;
  if (!list.length) return;
  const i = Math.max(0, list.findIndex((t) => t.id === s.active));
  const nextId = list[(i + step + list.length) % list.length]!.id;
  const scopeKey = s.selectedSpace ?? ALL_SPACES_KEY;
  set({ active: nextId, activeBySpace: { ...s.activeBySpace, [scopeKey]: nextId } });
}

/** Shows the panel at `id`, or hides it when `id` is already showing. */
export function togglePanel(id: PanelId): void {
  set((s) => ({ ...s, panel: s.panel === id ? null : id }));
}

export function showPanel(id: PanelId | null): void {
  set({ panel: id });
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
