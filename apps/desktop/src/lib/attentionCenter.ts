import type { Agent, AgentStatus, SpaceInfo } from "@herdr-pocket/protocol";
import { playAttentionChime } from "./alertSound";
import { isTauri } from "./bridge";
import { clientConfigStore, isDynamicIslandEnabled } from "./config";
import { native } from "./native";
import { rpcCall } from "./relay";
import { agentSpace, allAgents, createStore, findAgent, liveStore, settingsStore, spacedTitle } from "./store";
import {
  activeTabIdForSpace,
  openAgentTab,
  shellStore,
  tabLeaves,
  toggleZoomTabPane,
  type ShellState,
} from "../shell/shellStore";

export type AttentionCategory = "approval" | "question" | "error" | "completed";

export interface AttentionItem {
  id: string;
  agentKey: string;
  category: AttentionCategory;
  title: string;
  subtitle: string;
  ts: number;
  spaceName?: string;
  deviceId?: string;
}

export interface AttentionState {
  items: AttentionItem[];
  peek: AttentionItem | null;
  windowFocused: boolean;
}

export const ATTENTION_CATEGORY_META: Record<
  AttentionCategory,
  { label: string; shortLabel: string; priority: number }
> = {
  approval: { label: "需要审批", shortLabel: "审批", priority: 0 },
  question: { label: "提问待答", shortLabel: "提问", priority: 1 },
  error: { label: "异常报错", shortLabel: "异常", priority: 2 },
  completed: { label: "任务完成", shortLabel: "完成", priority: 3 },
};

const APPROVAL_NOTE_RE = /\b(?:allow|permission|approve|auth|confirm|consent)\b|授权|允许|审批|权限|确认执行/i;
const LONG_TASK_MS = 45_000;
const PEEK_DURATION_MS = 5_600;
const DEMO_HOLD_MS = 12_000;

export function classifyAttentionCategory(
  agent: Pick<Agent, "status" | "statusKind" | "statusNote" | "errored">,
): AttentionCategory | null {
  if (agent.status === "blocked") {
    if (
      agent.statusKind === "permission" ||
      agent.statusKind === "auth" ||
      (agent.statusNote ? APPROVAL_NOTE_RE.test(agent.statusNote) : false)
    ) {
      return "approval";
    }
    return "question";
  }
  if (agent.errored) return "error";
  if (agent.status === "done") return "completed";
  return null;
}

export function sortAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort(
    (a, b) =>
      ATTENTION_CATEGORY_META[a.category].priority - ATTENTION_CATEGORY_META[b.category].priority ||
      b.ts - a.ts,
  );
}

export function collectFocusedAgentKeys(
  state: Pick<ShellState, "tabs" | "active" | "selectedSpace" | "activeBySpace">,
  byKey: Map<string, Agent>,
  spacesMap: Record<string, readonly SpaceInfo[]>,
): Set<string> {
  const activeId = activeTabIdForSpace(state, (k) => byKey.get(k), spacesMap);
  const tab = state.tabs.find((t) => t.id === activeId) ?? null;
  const focused = new Set<string>();
  if (!tab) return focused;
  const zoomedId = tab.split?.zoomedPaneId;
  for (const leaf of tabLeaves(tab)) {
    if (zoomedId && leaf.id !== zoomedId) continue;
    if (leaf.content.kind === "agent") focused.add(leaf.content.agentKey);
  }
  return focused;
}

export interface AttentionTracker {
  seeded: boolean;
  prevStatus: Map<string, AgentStatus>;
  prevErrored: Map<string, boolean>;
  workStartedAt: Map<string, number>;
  demoUntil: number;
}

export function createAttentionTracker(): AttentionTracker {
  return {
    seeded: false,
    prevStatus: new Map(),
    prevErrored: new Map(),
    workStartedAt: new Map(),
    demoUntil: 0,
  };
}

export interface ReconcileResult {
  items: AttentionItem[];
  newPeek: AttentionItem | null;
  chimes: Array<{ kind: "blocked" | "done"; elapsedMs: number }>;
}

function defaultSubtitleFor(
  agent: Pick<Agent, "statusNote">,
  category: AttentionCategory,
  elapsedMs: number,
): string {
  if (category === "error") {
    return agent.statusNote?.trim() || "运行出现异常报错";
  }
  if (category === "approval") {
    return agent.statusNote?.trim() || "请求操作授权确认";
  }
  if (category === "question") {
    return agent.statusNote?.trim() || "等待你的进一步指示或输入";
  }
  if (elapsedMs >= 1000) {
    return `已完成（耗时 ${Math.max(1, Math.round(elapsedMs / 1000))} 秒）`;
  }
  return agent.statusNote?.trim() || "本轮任务已完成";
}

/**
 * Pure Ovis-style state reconciler computing categorized queue items, alert chimes,
 * and transient popup peeks without firing noisy alerts while focused on that agent.
 */
export function reconcileAttentionSnapshot(
  tracker: AttentionTracker,
  prevItems: AttentionItem[],
  agents: Agent[],
  focusedKeys: Set<string>,
  windowFocused: boolean,
  now = Date.now(),
): ReconcileResult {
  const byKey = new Map<string, Agent>();
  for (const a of agents) byKey.set(a.key, a);

  const itemMap = new Map<string, AttentionItem>();
  for (const item of prevItems) {
    if (item.id.startsWith("demo-") && now < tracker.demoUntil) {
      itemMap.set(item.agentKey, item);
      continue;
    }
    const agent = byKey.get(item.agentKey);
    if (!agent) continue;
    if ((item.category === "approval" || item.category === "question") && agent.status !== "blocked") continue;
    if (item.category === "error" && !agent.errored) continue;
    if (item.category === "completed") {
      if (agent.status !== "done" || (windowFocused && focusedKeys.has(agent.key))) continue;
    }
    itemMap.set(item.agentKey, item);
  }

  const chimes: Array<{ kind: "blocked" | "done"; elapsedMs: number }> = [];
  let newPeek: AttentionItem | null = null;
  const firstSeed = !tracker.seeded;
  tracker.seeded = true;

  for (const a of agents) {
    const prevSt = tracker.prevStatus.get(a.key);
    const prevErr = tracker.prevErrored.get(a.key) ?? false;
    tracker.prevStatus.set(a.key, a.status);
    tracker.prevErrored.set(a.key, Boolean(a.errored));

    if (a.status === "working") {
      if (!tracker.workStartedAt.has(a.key)) {
        tracker.workStartedAt.set(a.key, a.statusSince ?? now);
      }
    }
    const workStart = tracker.workStartedAt.get(a.key);
    if (a.status === "blocked" || a.status === "done" || a.status === "idle") {
      tracker.workStartedAt.delete(a.key);
    }

    if (a.isShell && !a.errored) continue;

    const category = classifyAttentionCategory(a);
    const viewingNow = windowFocused && focusedKeys.has(a.key);

    if (firstSeed) {
      if (category === "approval" || category === "question" || category === "error") {
        itemMap.set(a.key, {
          id: `${a.key}:${category}`,
          agentKey: a.key,
          category,
          title: spacedTitle(a),
          subtitle: defaultSubtitleFor(a, category, 0),
          ts: a.statusSince ?? a.updatedAt ?? now,
          spaceName: agentSpace(a),
          deviceId: a.deviceId,
        });
      }
      continue;
    }

    const enteredBlocked = a.status === "blocked" && prevSt !== "blocked";
    const enteredError = Boolean(a.errored) && !prevErr;
    const finishedWork = a.status === "done" && prevSt === "working";

    if (category === "approval" || category === "question") {
      const item: AttentionItem = {
        id: `${a.key}:${category}`,
        agentKey: a.key,
        category,
        title: spacedTitle(a),
        subtitle: defaultSubtitleFor(a, category, 0),
        ts: itemMap.get(a.key)?.ts ?? now,
        spaceName: agentSpace(a),
        deviceId: a.deviceId,
      };
      itemMap.set(a.key, item);
      if (enteredBlocked && !viewingNow) {
        chimes.push({ kind: "blocked", elapsedMs: 0 });
        newPeek = item;
      }
      continue;
    }

    if (category === "error") {
      const item: AttentionItem = {
        id: `${a.key}:error`,
        agentKey: a.key,
        category: "error",
        title: spacedTitle(a),
        subtitle: defaultSubtitleFor(a, "error", 0),
        ts: itemMap.get(a.key)?.ts ?? now,
        spaceName: agentSpace(a),
        deviceId: a.deviceId,
      };
      itemMap.set(a.key, item);
      if (enteredError && !viewingNow) {
        chimes.push({ kind: "blocked", elapsedMs: 0 });
        if (!newPeek) newPeek = item;
      }
      continue;
    }

    if (category === "completed" && finishedWork && !viewingNow) {
      const elapsedMs = workStart ? Math.max(0, now - workStart) : 0;
      const item: AttentionItem = {
        id: `${a.key}:completed:${now}`,
        agentKey: a.key,
        category: "completed",
        title: spacedTitle(a),
        subtitle: defaultSubtitleFor(a, "completed", elapsedMs),
        ts: now,
        spaceName: agentSpace(a),
        deviceId: a.deviceId,
      };
      itemMap.set(a.key, item);
      if (elapsedMs >= LONG_TASK_MS) {
        chimes.push({ kind: "done", elapsedMs });
        if (!newPeek) newPeek = item;
      }
    }
  }

  return {
    items: sortAttentionItems([...itemMap.values()]),
    newPeek,
    chimes,
  };
}

export const attentionStore = createStore<AttentionState>({
  items: [],
  peek: null,
  windowFocused: typeof document === "undefined" ? true : document.hasFocus(),
});

const runtimeTracker = createAttentionTracker();
let peekTimer: number | null = null;
let notchTimer: number | null = null;
let lastNotchSyncJson: string | null = null;

export function buildNotchSyncPayload(): Record<string, unknown> {
  const st = attentionStore.get();
  const notifOn = settingsStore.get().notifications;
  const islandOn = isDynamicIslandEnabled();
  const prefTheme = settingsStore.get().theme;
  const domTheme =
    typeof document !== "undefined" ? document.documentElement.getAttribute("data-theme") : null;
  const theme =
    prefTheme === "dark" ||
    domTheme === "dark" ||
    (prefTheme === "system" &&
      domTheme !== "light" &&
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches))
      ? "dark"
      : "light";
  const visibleItems = st.items.slice(0, 12);
  return {
    enabled: Boolean(notifOn && islandOn),
    theme,
    windowFocused: st.windowFocused,
    demo: runtimeTracker.demoUntil > Date.now(),
    items: visibleItems.map((it) => ({
      id: it.id,
      agentKey: it.agentKey,
      category: it.category,
      title: it.title,
      subtitle: it.subtitle,
      ts: it.ts,
    })),
    peek:
      notifOn && st.peek
        ? {
            id: st.peek.id,
            agentKey: st.peek.agentKey,
            category: st.peek.category,
            title: st.peek.title,
            subtitle: st.peek.subtitle,
          }
        : null,
  };
}

export function resetNotchSyncDedupeForTest(): void {
  lastNotchSyncJson = null;
}

function clearPeekTimer(): void {
  if (peekTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(peekTimer);
    peekTimer = null;
  }
}

function showTransientPeek(item: AttentionItem | null, durationMs = PEEK_DURATION_MS): void {
  clearPeekTimer();
  attentionStore.set({ peek: item });
  if (item && typeof window !== "undefined") {
    peekTimer = window.setTimeout(() => {
      peekTimer = null;
      attentionStore.set((prev) => (prev.peek?.id === item.id ? { ...prev, peek: null } : prev));
      scheduleNotchSync(true);
    }, durationMs);
  }
}

export function pushNotchNow(): boolean {
  if (notchTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(notchTimer);
    notchTimer = null;
  }
  const payload = buildNotchSyncPayload();
  const json = JSON.stringify(payload);
  if (json === lastNotchSyncJson) return false;
  lastNotchSyncJson = json;
  void native.notchSync(payload);
  return true;
}

function scheduleNotchSync(immediate = false): void {
  if (immediate || typeof window === "undefined") {
    pushNotchNow();
    return;
  }
  if (notchTimer !== null) return;
  notchTimer = window.setTimeout(() => {
    notchTimer = null;
    pushNotchNow();
  }, 100);
}

function syncAttentionFromRuntime(): void {
  const live = liveStore.get();
  const all = allAgents(live.agents);
  const byKey = new Map(all.map((a) => [a.key, a] as const));
  const focused = collectFocusedAgentKeys(shellStore.get(), byKey, live.spaces);
  const prevState = attentionStore.get();
  const notifOn = settingsStore.get().notifications;

  const result = reconcileAttentionSnapshot(
    runtimeTracker,
    prevState.items,
    all,
    focused,
    prevState.windowFocused,
  );

  for (const chime of result.chimes) {
    playAttentionChime(chime.kind, chime.elapsedMs);
  }

  let nextPeek = prevState.peek;
  if (nextPeek && !nextPeek.id.startsWith("demo-")) {
    const stillExists = result.items.some((i) => i.id === nextPeek!.id);
    if (!stillExists) nextPeek = null;
  }
  if (notifOn && result.newPeek) {
    nextPeek = result.newPeek;
  } else if (!notifOn) {
    nextPeek = null;
  }

  const changedItems =
    prevState.items.length !== result.items.length ||
    prevState.items.some(
      (it, idx) =>
        it.id !== result.items[idx]?.id ||
        it.subtitle !== result.items[idx]?.subtitle ||
        it.category !== result.items[idx]?.category,
    );
  const changedPeek = prevState.peek?.id !== nextPeek?.id || prevState.peek?.subtitle !== nextPeek?.subtitle;

  if (changedItems || changedPeek) {
    attentionStore.set({
      items: result.items,
      peek: nextPeek,
    });
    if (result.newPeek && notifOn) {
      showTransientPeek(result.newPeek);
    }
    scheduleNotchSync(Boolean(result.newPeek));
  }
}

export function dismissAttentionPeek(): void {
  clearPeekTimer();
  attentionStore.set({ peek: null });
  scheduleNotchSync(true);
}

export function dismissAttentionItem(id: string): void {
  attentionStore.set((prev) => ({
    ...prev,
    items: prev.items.filter((i) => i.id !== id),
    peek: prev.peek?.id === id ? null : prev.peek,
  }));
  scheduleNotchSync(true);
}

export function clearAllAttentionItems(): void {
  runtimeTracker.demoUntil = 0;
  clearPeekTimer();
  attentionStore.set({ items: [], peek: null });
  scheduleNotchSync(true);
}

/**
 * Surfaces the desktop window, switches space/tab/split-pane cleanly to `agentKey`,
 * clears its queued attention alerts, and acknowledges `agent.seen`.
 */
export function jumpToAttentionAgent(agentKey: string): boolean {
  if (!agentKey) return false;
  void native.notchFocusMain();

  if (!agentKey.startsWith("demo/")) {
    openAgentTab(agentKey, undefined, { trigger: "attention" });
    const s = shellStore.get();
    for (const tab of s.tabs) {
      const hitLeaf = tabLeaves(tab).find((l) => l.content.kind === "agent" && l.content.agentKey === agentKey);
      if (hitLeaf && tab.split?.zoomedPaneId && tab.split.zoomedPaneId !== hitLeaf.id) {
        toggleZoomTabPane(tab.id, hitLeaf.id);
        break;
      }
    }
    const agent = findAgent(agentKey);
    if (agent) {
      void rpcCall(agent.deviceId, "agent.seen", { agent: agent.key }).catch(() => {});
    }
  }

  clearPeekTimer();
  attentionStore.set((prev) => ({
    ...prev,
    items: prev.items.filter((i) => i.agentKey !== agentKey),
    peek: prev.peek?.agentKey === agentKey ? null : prev.peek,
  }));
  scheduleNotchSync(true);
  return true;
}

export function jumpToNextAttentionItem(): boolean {
  const next = attentionStore.get().items[0] ?? attentionStore.get().peek;
  if (!next) return false;
  return jumpToAttentionAgent(next.agentKey);
}

export function triggerDemoAttentionPreview(): void {
  const now = Date.now();
  runtimeTracker.demoUntil = now + DEMO_HOLD_MS;
  const demoItems: AttentionItem[] = [
    {
      id: `demo-approval-${now}`,
      agentKey: "demo/hc:approval",
      category: "approval",
      title: "herdr-pocket · 主干发布",
      subtitle: "请求允许运行 cargo test --release",
      ts: now,
    },
    {
      id: `demo-question-${now}`,
      agentKey: "demo/hc:question",
      category: "question",
      title: "ibuki-next · 媒体优化",
      subtitle: "是否确认将视频直链切换为七牛 CDN",
      ts: now - 15_000,
    },
    {
      id: `demo-completed-${now}`,
      agentKey: "demo/hc:completed",
      category: "completed",
      title: "Taproom · 类型校验",
      subtitle: "已完成（耗时 68 秒）",
      ts: now - 42_000,
    },
  ];
  attentionStore.set((prev) => ({
    ...prev,
    items: sortAttentionItems([
      ...demoItems,
      ...prev.items.filter((i) => !i.id.startsWith("demo-")),
    ]),
  }));
  showTransientPeek(demoItems[0]!, 6_500);
  scheduleNotchSync(true);
}

export function startAttentionCenter(): () => void {
  syncAttentionFromRuntime();
  scheduleNotchSync(true);

  const unsubLive = liveStore.subscribe(syncAttentionFromRuntime);
  const unsubShell = shellStore.subscribe(syncAttentionFromRuntime);
  const unsubCfg = clientConfigStore.subscribe(() => scheduleNotchSync());
  const unsubSettings = settingsStore.subscribe(() => scheduleNotchSync());

  const onFocus = () => {
    attentionStore.set({ windowFocused: true });
    syncAttentionFromRuntime();
    scheduleNotchSync(true);
  };
  const onBlur = () => {
    attentionStore.set({ windowFocused: false });
    scheduleNotchSync(true);
  };
  const onVisibility = () => {
    const focused = !document.hidden && document.hasFocus();
    attentionStore.set({ windowFocused: focused });
    if (focused) syncAttentionFromRuntime();
    scheduleNotchSync(true);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
  }

  let unlistenTauri: (() => void) | null = null;
  let disposed = false;
  if (isTauri()) {
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ action?: string; agentKey?: string; id?: string }>("notch://action", (ev) => {
        if (disposed) return;
        const p = ev.payload ?? {};
        if (p.action === "jump" && p.agentKey) {
          jumpToAttentionAgent(p.agentKey);
        } else if (p.action === "dismiss" && p.id) {
          dismissAttentionItem(p.id);
        } else if (p.action === "clear-all") {
          clearAllAttentionItems();
        }
      }).then((fn) => {
        if (disposed) fn();
        else unlistenTauri = fn;
      }),
    );
  }

  return () => {
    disposed = true;
    unsubLive();
    unsubShell();
    unsubCfg();
    unsubSettings();
    clearPeekTimer();
    if (notchTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(notchTimer);
      notchTimer = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    }
    unlistenTauri?.();
  };
}
