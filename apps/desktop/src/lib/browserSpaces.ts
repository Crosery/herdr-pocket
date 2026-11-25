import type { BrowserSpaceOwnership } from "@herdr-pocket/protocol";
import { clientConfigStore } from "./config";
import { native } from "./native";
import { createStore } from "./store";

export interface BrowserSpaceTab {
  id: string;
  label?: string;
  title: string;
  url: string;
  pinned?: boolean;
  openedBy?: "user" | "agent";
}

export interface BrowserSpace {
  id: string;
  name: string;
  kind: "user" | "ai";
  ownership: BrowserSpaceOwnership;
  statusText?: string;
  handoffReason?: string;
  activeTabId: string;
  tabs: BrowserSpaceTab[];
}

export interface BrowserSpacesState {
  spaces: BrowserSpace[];
  activeSpaceId: string;
  bookmarks: Array<{ url: string; title: string }>;
}

const STORAGE_KEY = "hp-browser-spaces-v1";
const DEFAULT_SPACE_ID = "default";

function defaultTab(id = "panel-web", url = "about:blank", title = "新标签页"): BrowserSpaceTab {
  return { id, label: "p1", title, url, openedBy: "user" };
}

function defaultState(): BrowserSpacesState {
  return {
    spaces: [
      {
        id: DEFAULT_SPACE_ID,
        name: "默认浏览",
        kind: "user",
        ownership: "user",
        activeTabId: "panel-web",
        tabs: [defaultTab("panel-web")],
      },
    ],
    activeSpaceId: DEFAULT_SPACE_ID,
    bookmarks: [],
  };
}

function loadInitial(): BrowserSpacesState {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<BrowserSpacesState>;
    const spaces = Array.isArray(parsed.spaces)
      ? parsed.spaces
          .filter((s): s is BrowserSpace => Boolean(s && typeof s.id === "string" && Array.isArray(s.tabs) && s.tabs.length > 0))
          .filter((s) => s.kind === "user") // Transient AI task spaces start fresh per session.
      : [];
    if (!spaces.length) return defaultState();
    const activeSpaceId = spaces.some((s) => s.id === parsed.activeSpaceId) ? parsed.activeSpaceId! : spaces[0]!.id;
    const bookmarks = Array.isArray(parsed.bookmarks)
      ? parsed.bookmarks.filter((b): b is { url: string; title: string } => Boolean(b && typeof b.url === "string")).slice(0, 12)
      : [];
    return { spaces, activeSpaceId, bookmarks };
  } catch {
    return defaultState();
  }
}

function persistState(s: BrowserSpacesState): void {
  try {
    if (typeof localStorage === "undefined") return;
    // Keep only persistent user spaces & bookmarks across restarts.
    const userSpaces = s.spaces.filter((sp) => sp.kind === "user");
    const active = userSpaces.some((sp) => sp.id === s.activeSpaceId) ? s.activeSpaceId : (userSpaces[0]?.id ?? DEFAULT_SPACE_ID);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ spaces: userSpaces, activeSpaceId: active, bookmarks: s.bookmarks }));
  } catch {
    // ignore storage errors
  }
}

export const browserSpacesStore = createStore<BrowserSpacesState>(loadInitial());

export function useBrowserSpaces(): BrowserSpacesState {
  return browserSpacesStore.use((s) => s);
}

export function removeBrowserBookmark(url: string): void {
  const cur = browserSpacesStore.get();
  const nextBookmarks = cur.bookmarks.filter((b) => b.url !== url);
  if (nextBookmarks.length === cur.bookmarks.length) return;
  commit({ ...cur, bookmarks: nextBookmarks });
}

let tabCounter = 1;
let spaceCounter = 1;

function nextTabId(spaceId: string): string {
  const clean = spaceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 10) || "u";
  return `w-${clean}-${++tabCounter}-${Date.now().toString(36).slice(-4)}`.slice(0, 30);
}

function syncToNative(): void {
  if (!native.available()) return;
  const st = browserSpacesStore.get();
  const payload = st.spaces.map((sp) => ({
    id: sp.id,
    name: sp.name,
    kind: sp.kind,
    ownership: sp.ownership,
    statusText: sp.statusText,
    handoffReason: sp.handoffReason,
    activePage: sp.tabs.find((t) => t.id === sp.activeTabId)?.label ?? "p1",
    pages: sp.tabs.map((t, i) => ({
      label: t.label || `p${i + 1}`,
      panelId: t.id,
      title: t.title,
      url: t.url,
      active: t.id === sp.activeTabId,
    })),
  }));
  void native.browserSyncSpaces(payload, st.activeSpaceId).catch(() => {});
}

function commit(next: BrowserSpacesState): void {
  browserSpacesStore.set(next);
  persistState(next);
  syncToNative();
}

export function selectBrowserSpace(spaceId: string): void {
  const cur = browserSpacesStore.get();
  if (!cur.spaces.some((s) => s.id === spaceId)) return;
  commit({ ...cur, activeSpaceId: spaceId });
}

export function createUserBrowserSpace(name?: string, initialUrl = "about:blank"): BrowserSpace {
  const cur = browserSpacesStore.get();
  const id = `bs-${++spaceCounter}-${Date.now().toString(36).slice(-4)}`;
  const tabId = nextTabId(id);
  const spName = name?.trim() || `空间 ${cur.spaces.filter((s) => s.kind === "user").length + 1}`;
  const space: BrowserSpace = {
    id,
    name: spName,
    kind: "user",
    ownership: "user",
    activeTabId: tabId,
    tabs: [defaultTab(tabId, initialUrl, initialUrl === "about:blank" ? "新标签页" : initialUrl)],
  };
  commit({ ...cur, spaces: [...cur.spaces, space], activeSpaceId: id });
  return space;
}

export function deleteBrowserSpace(spaceId: string): void {
  const cur = browserSpacesStore.get();
  if (spaceId === DEFAULT_SPACE_ID) return;
  const victim = cur.spaces.find((s) => s.id === spaceId);
  if (!victim) return;
  for (const t of victim.tabs) void native.browserClose(t.id);
  const spaces = cur.spaces.filter((s) => s.id !== spaceId);
  const activeSpaceId = cur.activeSpaceId === spaceId ? (spaces[0]?.id ?? DEFAULT_SPACE_ID) : cur.activeSpaceId;
  commit({ ...cur, spaces, activeSpaceId });
  if (victim.kind === "ai" && native.available()) {
    void native.browserAiControl(spaceId, "close_space").catch(() => {});
  }
}

export function openBrowserTab(spaceId?: string, url = "about:blank", title = "新标签页"): string {
  const cur = browserSpacesStore.get();
  const sid = spaceId && cur.spaces.some((s) => s.id === spaceId) ? spaceId : cur.activeSpaceId;
  const tabId = nextTabId(sid);
  const spaces = cur.spaces.map((sp) => {
    if (sp.id !== sid) return sp;
    const label = `p${sp.tabs.length + 1}`;
    return {
      ...sp,
      activeTabId: tabId,
      tabs: [...sp.tabs, { id: tabId, label, title, url, openedBy: "user" as const }],
    };
  });
  commit({ ...cur, spaces, activeSpaceId: sid });
  return tabId;
}

export function selectBrowserTab(spaceId: string, tabId: string): void {
  const cur = browserSpacesStore.get();
  const spaces = cur.spaces.map((sp) => (sp.id === spaceId ? { ...sp, activeTabId: tabId } : sp));
  commit({ ...cur, spaces, activeSpaceId: spaceId });
}

export function closeBrowserTab(spaceId: string, tabId: string): void {
  const cur = browserSpacesStore.get();
  void native.browserClose(tabId);
  let nextActiveSpace = cur.activeSpaceId;
  const spaces = cur.spaces
    .map((sp) => {
      if (sp.id !== spaceId) return sp;
      const remaining = sp.tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        if (sp.id === DEFAULT_SPACE_ID) {
          const fresh = defaultTab(nextTabId(sp.id));
          return { ...sp, activeTabId: fresh.id, tabs: [fresh] };
        }
        return null;
      }
      const activeTabId = sp.activeTabId === tabId ? remaining[remaining.length - 1]!.id : sp.activeTabId;
      return { ...sp, activeTabId, tabs: remaining };
    })
    .filter((sp): sp is BrowserSpace => sp !== null);
  if (!spaces.some((s) => s.id === nextActiveSpace)) {
    nextActiveSpace = spaces[0]?.id ?? DEFAULT_SPACE_ID;
  }
  commit({ ...cur, spaces, activeSpaceId: nextActiveSpace });
}

export function updateBrowserTab(panelId: string, patch: { url?: string; title?: string }): void {
  const cur = browserSpacesStore.get();
  let changed = false;
  const spaces = cur.spaces.map((sp) => ({
    ...sp,
    tabs: sp.tabs.map((t) => {
      if (t.id !== panelId) return t;
      changed = true;
      return { ...t, ...patch };
    }),
  }));
  if (!changed) return;
  let bookmarks = cur.bookmarks;
  if (patch.url && /^https?:\/\//i.test(patch.url)) {
    const label = (patch.title || patch.url).slice(0, 48);
    bookmarks = [{ url: patch.url, title: label }, ...cur.bookmarks.filter((b) => b.url !== patch.url)].slice(0, 12);
  }
  commit({ ...cur, spaces, bookmarks });
}

export function controlAiBrowserSpace(
  spaceId: string,
  action: "takeover" | "resume" | "handoff" | "close_space",
  reason?: string,
): void {
  const cur = browserSpacesStore.get();
  if (action === "close_space") {
    deleteBrowserSpace(spaceId);
    return;
  }
  const spaces = cur.spaces.map((sp) => {
    if (sp.id !== spaceId) return sp;
    if (action === "takeover") {
      return { ...sp, ownership: "user" as const, statusText: "已由你接管", handoffReason: undefined };
    }
    if (action === "resume") {
      return { ...sp, ownership: "agentWorking" as const, statusText: "已交还 AI，等待下一步操作", handoffReason: undefined };
    }
    return { ...sp, ownership: "agentHandoff" as const, statusText: "需要你手动协助", handoffReason: reason || "请完成后点“已完成，交还 AI”" };
  });
  commit({ ...cur, spaces });
  if (native.available()) {
    void native.browserAiControl(spaceId, action, reason).catch(() => {});
  }
}

/**
 * Installs listeners keeping React's Browser Spaces synced with the optional native
 * AI Browser plugin (zero overhead when `plugins.aiBrowser` is disabled).
 */
export function installBrowserAiBridgeListeners(onOpenBrowserPanel: () => void): () => void {
  const offState = native.onBrowserAiState((snap) => {
    if (!clientConfigStore.get().config.plugins.aiBrowser && !snap.enabled) return;
    const cur = browserSpacesStore.get();
    const userById = new Map(cur.spaces.map((s) => [s.id, s]));
    const nextSpaces: BrowserSpace[] = [...cur.spaces.filter((s) => s.kind === "user")];
    for (const remote of snap.spaces) {
      if (remote.kind !== "ai") continue;
      const existing = userById.get(remote.id);
      const tabs: BrowserSpaceTab[] = remote.pages.map((p) => ({
        id: p.panelId,
        label: p.label,
        title: p.title || p.url || "AI 标签页",
        url: p.url || "about:blank",
        openedBy: "agent",
      }));
      if (!tabs.length) continue;
      nextSpaces.push({
        id: remote.id,
        name: remote.name,
        kind: "ai",
        ownership: remote.ownership,
        statusText: remote.statusText,
        handoffReason: remote.handoffReason,
        activeTabId:
          remote.pages.find((p) => p.label === remote.activePage)?.panelId ??
          existing?.activeTabId ??
          tabs[0]!.id,
        tabs,
      });
    }
    const nextActive = snap.activeSpaceId && nextSpaces.some((s) => s.id === snap.activeSpaceId)
      ? snap.activeSpaceId
      : cur.activeSpaceId;
    browserSpacesStore.set({ ...cur, spaces: nextSpaces, activeSpaceId: nextActive });
  });

  const offCmd = native.onBrowserAiCommand((cmd) => {
    if (cmd.kind === "open_space" && cmd.spaceId && cmd.panelId) {
      const cur = browserSpacesStore.get();
      const url = cmd.url || "about:blank";
      const tab: BrowserSpaceTab = {
        id: cmd.panelId,
        label: cmd.pageLabel || "p1",
        title: url === "about:blank" ? "AI 新标签页" : url,
        url,
        openedBy: "agent",
      };
      const existingIdx = cur.spaces.findIndex((s) => s.id === cmd.spaceId);
      let spaces: BrowserSpace[];
      if (existingIdx >= 0) {
        spaces = cur.spaces.map((s, i) => {
          if (i !== existingIdx) return s;
          const hasTab = s.tabs.some((t) => t.id === tab.id);
          return {
            ...s,
            ownership: "agentWorking",
            statusText: cmd.statusText || s.statusText,
            handoffReason: undefined,
            activeTabId: tab.id,
            tabs: hasTab ? s.tabs.map((t) => (t.id === tab.id ? { ...t, url } : t)) : [...s.tabs, tab],
          };
        });
      } else {
        spaces = [
          ...cur.spaces,
          {
            id: cmd.spaceId,
            name: `AI 任务 · ${cmd.spaceId.replace(/^ai-/, "")}`,
            kind: "ai",
            ownership: "agentWorking",
            statusText: cmd.statusText || "正在打开网页",
            activeTabId: tab.id,
            tabs: [tab],
          },
        ];
      }
      browserSpacesStore.set({ ...cur, spaces, activeSpaceId: cmd.spaceId });
      onOpenBrowserPanel();
    } else if (cmd.kind === "finish_space" && cmd.spaceId) {
      const cur = browserSpacesStore.get();
      const victim = cur.spaces.find((s) => s.id === cmd.spaceId);
      if (victim) {
        const keep = new Set(cmd.keep ?? []);
        for (const t of victim.tabs) {
          if (!keep.has(t.label || "")) void native.browserClose(t.id);
        }
      }
    }
  });

  if (native.available()) {
    syncToNative();
  }
  return () => {
    offState();
    offCmd();
  };
}
