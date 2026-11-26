import { useSyncExternalStore } from "react";
import type { Agent, AgentStatus, ChatDisplayMode, Device, PortalDisplayMode, SpaceInfo } from "@herdr-pocket/protocol";
import { STATUS_ORDER } from "@herdr-pocket/protocol";

export type LinkStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";
export type ThemeChoice = "system" | "light" | "dark";
export type H5LayoutMode = "auto" | "mobile" | "desktop";

export const DEFAULT_SIDEBAR_WIDTH = 268;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 400;

export function clampSidebarWidth(w: unknown): number {
  const n = typeof w === "number" && Number.isFinite(w) ? Math.round(w) : DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, n));
}

export function resolveInitialSidebarWidth(saved: {
  sidebarWidth?: unknown;
  sidebarWidthV2?: unknown;
}): number {
  if (!saved.sidebarWidthV2 && (saved.sidebarWidth === undefined || saved.sidebarWidth === 236)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return clampSidebarWidth(saved.sidebarWidth);
}

export interface AppSettings {
  server: string | null;
  deviceId: string | null;
  deviceName: string;
  lastServer: string | null;
  theme: ThemeChoice;
  textScale: number;
  chatDisplayMode: ChatDisplayMode;
  portalDisplayMode: PortalDisplayMode;
  showShells: boolean;
  notifications: boolean;
  denoise: boolean;
  hostFilter: string | null;
  foldedGroups: string[];
  /** Sidebar folded to its icon rail by the user (wide windows only; narrow ones fold on their own). */
  sidebarCollapsed: boolean;
  /** User-dragged sidebar width in px (180..380). */
  sidebarWidth: number;
  /** H5 browser layout mode preference ("auto" detects mobile vs desktop hardware). */
  h5LayoutMode: H5LayoutMode;
  /** Show cmux-style floating spatial shortcut badges when holding ⌘ / Ctrl. */
  showModifierHoldHints: boolean;
  /** Play subtle local audio chime for background agent attention events. */
  alertSound: boolean;
  /** Only chime for completed tasks that ran >= 45s (blocked/permission always chime when alertSound is on). */
  alertChimeOnlyLongTasks: boolean;
  /** Show the graduated test-tube ("实体试管") fill visualization in the context window HUD. */
  contextVialMode: boolean;
  /** How the sidebar Agent section is grouped: status, space hierarchy, or recent activity. */
  sidebarAgentGrouping: SidebarAgentGrouping;
  /** Visual presentation scheme ("a" cluster cards, "b" machine subheaders, "c" split glyphs) for the sidebar Agent list. */
  sidebarStyleScheme: SidebarStyleScheme;
  /** Show page-count badges, location tags, split-pane clusters, and hover links in the sidebar. */
  showSidebarTopology: boolean;
  /** "done" once the first-run guide was finished or skipped; "later" when closed half way. */
  onboarding: "new" | "later" | "done";
}

export type SidebarAgentGrouping = "status" | "space" | "recent";
export type SidebarStyleScheme = "a" | "b" | "c";

export interface LiveState {
  link: LinkStatus;
  devices: Record<string, Device>;
  agents: Record<string, Agent[]>;
  spaces: Record<string, SpaceInfo[]>;
  direct: Record<string, string>;
  rttMs?: number | null;
  rev: number;
}

const PREF_KEY = "herdr-pocket-client-prefs-v1";

type PersistedPrefs = Partial<AppSettings> & {
  sidebarWidthV2?: boolean;
  modifierHintsExplicit?: boolean;
};

function loadPrefs(): PersistedPrefs {
  try {
    const raw = window.PocketHarmony?.getPref?.(PREF_KEY) || localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as PersistedPrefs) : {};
  } catch {
    return {};
  }
}

let modifierHintsExplicit = Boolean(loadPrefs().modifierHintsExplicit);

function persistPrefs(s: AppSettings): void {
  const payload = JSON.stringify({
    lastServer: s.lastServer,
    theme: s.theme,
    textScale: s.textScale,
    chatDisplayMode: s.chatDisplayMode,
    portalDisplayMode: s.portalDisplayMode,
    showShells: s.showShells,
    notifications: s.notifications,
    denoise: s.denoise,
    hostFilter: s.hostFilter,
    foldedGroups: s.foldedGroups,
    sidebarCollapsed: s.sidebarCollapsed,
    sidebarWidth: s.sidebarWidth,
    sidebarWidthV2: true,
    h5LayoutMode: s.h5LayoutMode,
    showModifierHoldHints: s.showModifierHoldHints,
    modifierHintsExplicit,
    alertSound: s.alertSound,
    alertChimeOnlyLongTasks: s.alertChimeOnlyLongTasks,
    contextVialMode: s.contextVialMode,
    sidebarAgentGrouping: s.sidebarAgentGrouping,
    sidebarStyleScheme: s.sidebarStyleScheme,
    showSidebarTopology: s.showSidebarTopology,
    onboarding: s.onboarding,
  });
  try {
    window.PocketHarmony?.setPref?.(PREF_KEY, payload);
  } catch {
    // ignore
  }
  try {
    localStorage.setItem(PREF_KEY, payload);
  } catch {
    // ignore
  }
}

export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const get = () => state;
  const set = (patch: Partial<T> | ((prev: T) => T)) => {
    const next =
      typeof patch === "function"
        ? patch(state)
        : state !== null &&
            typeof state === "object" &&
            !Array.isArray(state) &&
            patch !== null &&
            typeof patch === "object" &&
            !Array.isArray(patch)
          ? { ...state, ...patch }
          : (patch as T);
    state = next;
    for (const l of listeners) l();
  };
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const use = <U,>(selector: (s: T) => U): U =>
    useSyncExternalStore(
      subscribe,
      () => selector(state),
      () => selector(state),
    );
  return { get, set, subscribe, use };
}

function readLegacySidebarGrouping(): SidebarAgentGrouping {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("herdr-pocket-v3-agent-sort") === "recent") {
      return "recent";
    }
  } catch {
    // ignore
  }
  return "status";
}

const saved = loadPrefs();

export const settingsStore = createStore<AppSettings>({
  server: null,
  deviceId: null,
  deviceName: "",
  lastServer: saved.lastServer ?? null,
  theme: saved.theme ?? "system",
  textScale: saved.textScale ?? 1,
  chatDisplayMode: saved.chatDisplayMode ?? "standard",
  portalDisplayMode:
    saved.portalDisplayMode === "collapsed" ||
    saved.portalDisplayMode === "fan" ||
    saved.portalDisplayMode === "tile" ||
    saved.portalDisplayMode === "cascade"
      ? saved.portalDisplayMode
      : "collapsed",
  showShells: saved.showShells ?? false,
  notifications: saved.notifications ?? true,
  denoise: saved.denoise ?? true,
  hostFilter: saved.hostFilter ?? null,
  foldedGroups: saved.foldedGroups ?? [],
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  sidebarWidth: resolveInitialSidebarWidth(saved),
  h5LayoutMode: saved.h5LayoutMode === "mobile" || saved.h5LayoutMode === "desktop" ? saved.h5LayoutMode : "auto",
  showModifierHoldHints: saved.modifierHintsExplicit ? (saved.showModifierHoldHints ?? true) : true,
  alertSound: saved.alertSound ?? true,
  alertChimeOnlyLongTasks: saved.alertChimeOnlyLongTasks ?? false,
  contextVialMode: saved.contextVialMode ?? true,
  sidebarAgentGrouping:
    saved.sidebarAgentGrouping === "status" ||
    saved.sidebarAgentGrouping === "space" ||
    saved.sidebarAgentGrouping === "recent"
      ? saved.sidebarAgentGrouping
      : readLegacySidebarGrouping(),
  sidebarStyleScheme:
    saved.sidebarStyleScheme === "b" || saved.sidebarStyleScheme === "c"
      ? saved.sidebarStyleScheme
      : "a",
  showSidebarTopology: saved.showSidebarTopology ?? true,
  // Installs from before the guide existed already have a server: don't greet them as new.
  onboarding: saved.onboarding ?? (saved.lastServer ? "done" : "new"),
});

export function updateSettings(patch: Partial<AppSettings>): void {
  if (patch.showModifierHoldHints !== undefined) {
    modifierHintsExplicit = true;
  }
  settingsStore.set((prev) => {
    const next = { ...prev, ...patch };
    persistPrefs(next);
    if (patch.theme) {
      applyThemeAttribute(patch.theme);
    }
    return next;
  });
}

export function applyThemeAttribute(choice: ThemeChoice): void {
  const dark =
    choice === "dark" ||
    (choice === "system" &&
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches));
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute("content", dark ? "#1E1A26" : "#FBF4FC");
    }
  }
}

export const liveStore = createStore<LiveState>({
  link: "idle",
  devices: {},
  agents: {},
  spaces: {},
  direct: {},
  rttMs: null,
  rev: 0,
});

export function allAgents(byHost: Record<string, Agent[]>): Agent[] {
  const out = Object.values(byHost).flat();
  out.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.statusSince ?? b.updatedAt) - (a.statusSince ?? a.updatedAt),
  );
  return out;
}

/** O(1)-host-indexed lookup of a single agent key without flattening/sorting all hosts. */
export function lookupAgentByKey(
  byHost: Record<string, Agent[]>,
  key: string | null | undefined,
): Agent | undefined {
  if (!key) return undefined;
  const slash = key.indexOf("/");
  if (slash > 0) {
    const host = key.slice(0, slash);
    const hit = byHost[host]?.find((a) => a.key === key);
    if (hit) return hit;
  }
  for (const list of Object.values(byHost)) {
    const hit = list.find((a) => a.key === key);
    if (hit) return hit;
  }
  return undefined;
}

export function findAgent(key: string): Agent | undefined {
  return lookupAgentByKey(liveStore.get().agents, key);
}

export function agentTitle(a: Pick<Agent, "name" | "title" | "localId" | "harness">): string {
  return a.name || a.title || a.harness || a.localId;
}

export function agentSpace(a: Pick<Agent, "where">): string | undefined {
  if (!a.where) return undefined;
  const slash = a.where.indexOf(" / ");
  return slash >= 0 ? a.where.slice(0, slash).trim() : a.where.trim();
}

export function spacedTitle(a: Agent): string {
  const sp = agentSpace(a);
  const t = agentTitle(a);
  return sp && !t.startsWith(sp) ? `${sp} · ${t}` : t;
}

export function relTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 45) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜深啦";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "工作中",
  blocked: "需要你",
  done: "已完成",
  idle: "空闲",
  unknown: "未知",
};
