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

export type AgentTab = { id: string; kind: "agent"; agentKey: string };
export type FileTab = { id: string; kind: "file"; agentKey: string; path: string; title: string };
export type WebTab = { id: string; kind: "web"; url: string; title: string };
export type ShellTab = AgentTab | FileTab | WebTab;

/** Side panel sections (Herdr: files / changes; ours adds the browser and 小羊). */
export type PanelId = "files" | "browser" | "assistant";

export interface ShellState {
  tabs: ShellTab[];
  active: string | null;
  /** The side panel's section, or null when the panel is hidden. */
  panel: PanelId | null;
  panelWidth: number;
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

function load(): Pick<ShellState, "tabs" | "active" | "panel" | "panelWidth"> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ShellState> | null;
    if (raw && Array.isArray(raw.tabs)) {
      const tabs = raw.tabs.filter((t): t is ShellTab => Boolean(t && typeof t.id === "string" && (t.kind === "agent" || t.kind === "file" || t.kind === "web")));
      return {
        tabs,
        active: tabs.some((t) => t.id === raw.active) ? raw.active! : (tabs[0]?.id ?? null),
        panel: raw.panel === "files" || raw.panel === "browser" || raw.panel === "assistant" ? raw.panel : null,
        panelWidth: clampPanel(Number(raw.panelWidth) || PANEL_DEFAULT),
      };
    }
  } catch {
    // Unreadable: start empty.
  }
  return { tabs: [], active: null, panel: null, panelWidth: PANEL_DEFAULT };
}

export function clampPanel(px: number): number {
  return Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, px)));
}

export const shellStore = createStore<ShellState>({ ...load(), settings: null, palette: false, peek: null });

shellStore.subscribe(() => {
  const { tabs, active, panel, panelWidth } = shellStore.get();
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs, active, panel, panelWidth }));
  } catch {
    // Storage off: tabs last for this session.
  }
});

const set = shellStore.set;

/** Opens the agent as a tab, or focuses its tab when it is already open. */
export function openAgentTab(agentKey: string): void {
  const s = shellStore.get();
  const hit = s.tabs.find((t) => t.kind === "agent" && t.agentKey === agentKey);
  if (hit) return set({ active: hit.id, peek: null });
  const tab: AgentTab = { id: `a:${agentKey}`, kind: "agent", agentKey };
  set({ tabs: [...s.tabs, tab], active: tab.id, peek: null });
}

export function openFileTab(agentKey: string, path: string, title: string): void {
  const s = shellStore.get();
  const id = `f:${agentKey}:${path}`;
  if (s.tabs.some((t) => t.id === id)) return set({ active: id });
  set({ tabs: [...s.tabs, { id, kind: "file", agentKey, path, title }], active: id });
}

export function openWebTab(url: string, title?: string): void {
  const s = shellStore.get();
  const id = `w:${Date.now().toString(36)}`;
  set({ tabs: [...s.tabs, { id, kind: "web", url, title: title || url || "新网页" }], active: id });
}

export function updateWebTab(id: string, patch: Partial<Pick<WebTab, "url" | "title">>): void {
  set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id && t.kind === "web" ? { ...t, ...patch } : t)) }));
}

export function closeTab(id: string): void {
  const s = shellStore.get();
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const active = s.active === id ? (tabs[i]?.id ?? tabs[i - 1]?.id ?? null) : s.active;
  set({ tabs, active });
}

export function setActiveTab(id: string): void {
  set({ active: id });
}

/** Moves the active tab by `step` (wraps around). */
export function cycleTab(step: 1 | -1): void {
  const s = shellStore.get();
  if (!s.tabs.length) return;
  const i = Math.max(0, s.tabs.findIndex((t) => t.id === s.active));
  set({ active: s.tabs[(i + step + s.tabs.length) % s.tabs.length]!.id });
}

/** Shows the panel at `id`, or hides it when `id` is already showing. */
export function togglePanel(id: PanelId): void {
  set((s) => ({ ...s, panel: s.panel === id ? null : id }));
}

export function showPanel(id: PanelId | null): void {
  set({ panel: id });
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
