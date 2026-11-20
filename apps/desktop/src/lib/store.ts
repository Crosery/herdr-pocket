import { useSyncExternalStore } from "react";
import type { Agent, AgentStatus, Device } from "@herdr-pocket/protocol";
import { STATUS_ORDER } from "@herdr-pocket/protocol";

export type LinkStatus = "idle" | "connecting" | "online" | "offline" | "unauthorized";
export type ThemeChoice = "system" | "light" | "dark";

export interface AppSettings {
  server: string | null;
  deviceId: string | null;
  deviceName: string;
  lastServer: string | null;
  theme: ThemeChoice;
  textScale: number;
  showShells: boolean;
  notifications: boolean;
  denoise: boolean;
  hostFilter: string | null;
  foldedGroups: string[];
  /** Sidebar folded to its icon rail by the user (wide windows only; narrow ones fold on their own). */
  sidebarCollapsed: boolean;
  /** "done" once the first-run guide was finished or skipped; "later" when closed half way. */
  onboarding: "new" | "later" | "done";
}

export interface LiveState {
  link: LinkStatus;
  devices: Record<string, Device>;
  agents: Record<string, Agent[]>;
  rev: number;
}

const PREF_KEY = "herdr-pocket-client-prefs-v1";

function loadPrefs(): Partial<AppSettings> {
  try {
    const raw = window.PocketHarmony?.getPref?.(PREF_KEY) || localStorage.getItem(PREF_KEY);
    return raw ? (JSON.parse(raw) as Partial<AppSettings>) : {};
  } catch {
    return {};
  }
}

function persistPrefs(s: AppSettings): void {
  const payload = JSON.stringify({
    lastServer: s.lastServer,
    theme: s.theme,
    textScale: s.textScale,
    showShells: s.showShells,
    notifications: s.notifications,
    denoise: s.denoise,
    hostFilter: s.hostFilter,
    foldedGroups: s.foldedGroups,
    sidebarCollapsed: s.sidebarCollapsed,
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
    const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
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

const saved = loadPrefs();

export const settingsStore = createStore<AppSettings>({
  server: null,
  deviceId: null,
  deviceName: "",
  lastServer: saved.lastServer ?? null,
  theme: saved.theme ?? "system",
  textScale: saved.textScale ?? 1,
  showShells: saved.showShells ?? false,
  notifications: saved.notifications ?? true,
  denoise: saved.denoise ?? true,
  hostFilter: saved.hostFilter ?? null,
  foldedGroups: saved.foldedGroups ?? [],
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  // Installs from before the guide existed already have a server: don't greet them as new.
  onboarding: saved.onboarding ?? (saved.lastServer ? "done" : "new"),
});

export function updateSettings(patch: Partial<AppSettings>): void {
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
  }
}

export const liveStore = createStore<LiveState>({
  link: "idle",
  devices: {},
  agents: {},
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

export function findAgent(key: string): Agent | undefined {
  for (const list of Object.values(liveStore.get().agents)) {
    const hit = list.find((a) => a.key === key);
    if (hit) return hit;
  }
  return undefined;
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
