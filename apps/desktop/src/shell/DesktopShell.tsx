import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  BarChart2,
  Bell,
  BookOpen,
  Bot,
  Columns2,
  Cpu,
  Equal,
  FolderTree,
  GitBranch,
  Globe,
  Info,
  Keyboard,
  Layers,
  Maximize2,
  MessageSquare,
  Mic,
  Moon,
  OctagonX,
  Palette as PaletteIcon,
  PanelLeft,
  Plus,
  QrCode,
  RefreshCw,
  Rows2,
  ScrollText,
  Search,
  Server,
  Shield,
  Sparkles,
  SquareArrowOutUpRight,
  SquareStack,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { VendorIcon } from "../components/MascotAndVendor";
import { PocketDroplet } from "../components/PocketDroplet";
import { AddDeviceModal } from "../views/DevicesView";
import { CreateAgentModal } from "../views/AgentsView";
import { SettingsFrame } from "../views/settings/SettingsFrame";
import { useClientConfig, clientConfigStore } from "../lib/config";
import { overlayStore, useToast } from "../components/PocketUI";
import { isTauri } from "../lib/bridge";
import { logAction } from "../lib/log";
import { localHostIdStore, refreshLocalHostIdFast } from "../lib/fonts";
import { native } from "../lib/native";
import { jumpToNextAttentionItem, startAttentionCenter } from "../lib/attentionCenter";
import { refreshHostSpaces, rpcCall } from "../lib/relay";
import { checkForUpdate } from "../lib/updates";
import { agentSpace, allAgents, liveStore, settingsStore, spacedTitle, updateSettings, agentTitle } from "../lib/store";
import { terminalOwnsCtrlK } from "../lib/termKeys";
import { getTerminalThemeSpec, resolveTerminalAppearance } from "../lib/terminalTheme";
import { GROUP_RANK, lastChange, listGroup } from "./agentInfo";
import { flushHostNow, pullHostDocNow, registerPendingSplitPlacement, syncHostNow, useHerdrDocSync } from "./herdrDocSync";
import { ModifierChordHud } from "./ModifierChordHud";
import { Palette, type PaletteItem } from "./Palette";
import { ShortcutHelpModal } from "./ShortcutHelpModal";
import { ShellSidebar } from "./ShellSidebar";
import { PeekOverlay, ShellMain, ShellPanel, ShellStatus, ShellTabs, requestClosePane, requestCloseShellTab } from "./ShellWork";
import {
  activeTabIdForSpace,
  closeSettingsFrame,
  cycleTab,
  detachPaneToTab,
  equalizeTabSplits,
  focusedLeafOfTab,
  focusPaneDirection,
  openAgentTab,
  openSettingsFrame,
  openWebTab,
  renameSpaceInShellStore,
  setActiveTab,
  setPalette,
  setPaneAgentMode,
  setSelectedSpace,
  shellStore,
  splitTabPane,
  swapPaneDirection,
  tabLeaves,
  togglePanel,
  toggleZoomTabPane,
  unsplitTabToTabs,
  visibleTabsForSpace,
  type FrameSection,
  type SplitDirection,
} from "./shellStore";
import { IS_MAC, matchShortcut } from "./shortcuts";
import { installWindowFocusTelemetry } from "../lib/uiTelemetry";
import { buildHostSpaces } from "./spaceSync";
import { useModifierHoldHints } from "./useModifierHoldHints";
import "../styles/shell.css";

const FRAME_ITEMS: Array<{ id: FrameSection; label: string; icon: PaletteItem["icon"] }> = [
  { id: "look", label: "外观", icon: PaletteIcon },
  { id: "keyboard", label: "键盘", icon: Keyboard },
  { id: "machines", label: "电脑与中继", icon: Server },
  { id: "alerts", label: "提醒", icon: Bell },
  { id: "updates", label: "更新", icon: RefreshCw },
  { id: "privacy", label: "隐私", icon: Shield },
  { id: "voice", label: "语音唤醒与声纹", icon: Mic },
  { id: "assistant", label: "小羊助理", icon: Sparkles },
  { id: "browser", label: "浏览器与文件", icon: Globe },
  { id: "performance", label: "性能与资源", icon: Cpu },
  { id: "logs", label: "日志与诊断", icon: ScrollText },
  { id: "about", label: "关于", icon: Info },
];

function measureTerminalGrid(splitDirection?: SplitDirection): {
  cols: number;
  rows: number;
  display: Record<string, unknown>;
} {
  const termCfg = clientConfigStore.get().config.terminal;
  const fs = Math.max(9, Number(termCfg.fontSize) || 14);
  const lh = Math.max(1.0, (Number(termCfg.lineHeight) || 115) / 100);
  const cellW = Math.max(5, Math.round(fs * 0.6));
  const cellH = Math.max(10, Math.round(fs * lh));
  const pane =
    (document.querySelector(".v3-pane.is-focused .tp-term-host") as HTMLElement | null) ??
    (document.querySelector(".v3-main .tp-term-host") as HTMLElement | null) ??
    (document.querySelector(".v3-main") as HTMLElement | null);
  const rect = pane?.getBoundingClientRect();
  const rawW = Math.max(320, (rect?.width ?? window.innerWidth - 300) - 36);
  const rawH = Math.max(180, (rect?.height ?? window.innerHeight - 100) - 70);
  const availW = splitDirection === "left" || splitDirection === "right" ? Math.max(200, rawW * 0.5) : rawW;
  const availH = splitDirection === "up" || splitDirection === "down" ? Math.max(110, rawH * 0.5) : rawH;
  const cols = Math.min(500, Math.max(30, Math.floor(availW / cellW)));
  const rows = Math.min(200, Math.max(10, Math.floor(availH / cellH)));
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const systemDark =
    typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
  const activeSpec = getTerminalThemeSpec(resolveTerminalAppearance(settingsStore.get().theme, systemDark));
  return {
    cols,
    rows,
    display: {
      fg: activeSpec.fg,
      bg: activeSpec.bg,
      cursor: activeSpec.cursor,
      cell: [Math.max(1, Math.round(cellW * dpr)), Math.max(1, Math.round(cellH * dpr))],
    },
  };
}

// Cache transient Herdr.app GUI unavailability so local splits don't pay RPC timeouts repeatedly.
let herdrAppSplitSkipUntil = 0;

/**
 * Desktop shell v3 (R36): Herdr's window skeleton with our colours and words.
 * sidebar 268 (rail 44) | tabs 42 / body (padding 8, gap 8: pane + panel 368) / status 28.
 * Narrow windows and HarmonyOS keep the phone layout in App.tsx.
 */
export function DesktopShell({
  collapsed,
  canToggleSidebar,
  onToggleSidebar,
  onPairPhone,
  onConnectRelay,
  onReopenGuide,
}: {
  collapsed: boolean;
  canToggleSidebar: boolean;
  onToggleSidebar: () => void;
  onPairPhone: () => void;
  onConnectRelay: () => void;
  onReopenGuide: () => void;
}) {
  const toast = useToast();
  const palette = shellStore.use((s) => s.palette);
  const tabs = shellStore.use((s) => s.tabs);
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const spacesMap = liveStore.use((s) => s.spaces);
  const showShells = settingsStore.use((s) => s.showShells);
  const sidebarWidth = settingsStore.use((s) => s.sidebarWidth);
  const theme = settingsStore.use((s) => s.theme);
  const homePage = useClientConfig().browser.homePage;
  const [create, setCreate] = useState<{ host: string | null; space: string | null; preferNewSpace?: boolean } | null>(null);
  const [addComputer, setAddComputer] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useModifierHoldHints();
  useHerdrDocSync();
  useEffect(() => startAttentionCenter(), []);
  useEffect(() => installWindowFocusTelemetry(), []);

  const agents = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);
  const hosts = useMemo(() => Object.values(devices).filter((d) => d.kind === "host"), [devices]);
  const newSpace = useCallback((host?: string | null) => {
    setCreate({ host: host ?? null, space: null, preferNewSpace: true });
  }, []);
  const newAgent = useCallback((host?: string | null, space?: string | null) => {
    if (host !== undefined || space !== undefined) {
      setCreate({ host: host ?? null, space: space ?? null });
      return;
    }
    const sel = shellStore.get().selectedSpace;
    if (sel) {
      const sep = sel.indexOf("\u0000");
      const selHost = sep >= 0 ? sel.slice(0, sep) : null;
      const selSpace = sep >= 0 ? sel.slice(sep + 1) : sel;
      setCreate({ host: selHost || null, space: selSpace || null });
    } else {
      setCreate({ host: null, space: null });
    }
  }, []);

  // Keep space counts, tabs, and renames synced periodically with Herdr.app while the window is visible.
  useEffect(() => {
    const sync = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refreshHostSpaces();
    };
    const timer = window.setInterval(sync, 10_000);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  // If incoming agents reference a space not yet in liveStore.spaces, refresh spaces for that host immediately.
  useEffect(() => {
    const spacesByHost = liveStore.get().spaces;
    for (const [hostId, list] of Object.entries(agentsMap)) {
      if (devices[hostId]?.online === false) continue;
      const known = new Set((spacesByHost[hostId] ?? []).map((s) => s.name));
      if (list.some((a) => {
        const sp = agentSpace(a);
        return Boolean(sp && !known.has(sp));
      })) {
        refreshHostSpaces(hostId);
      }
    }
  }, [agentsMap, devices]);

  const spawnTerminalNow = useCallback(
    async (
      preferredHost: string | null = null,
      preferredSpace: string | null = null,
      splitTarget?: { tabId: string; paneId: string | null; direction: SplitDirection },
    ) => {
      const { devices: devs, agents: agMap, spaces: spMap } = liveStore.get();
      const all = allAgents(agMap);
      const allMap = new Map(all.map((a) => [a.key, a] as const));
      const lookup = (k: string) => allMap.get(k);
      const s = shellStore.get();
      const activeSpaceTabId = activeTabIdForSpace(s, lookup, spMap);
      const targetTab = splitTarget
        ? s.tabs.find((t) => t.id === splitTarget.tabId)
        : (activeSpaceTabId ? s.tabs.find((t) => t.id === activeSpaceTabId) : undefined);
      const targetLeaf = targetTab
        ? (splitTarget?.paneId
            ? tabLeaves(targetTab).find((l) => l.id === splitTarget.paneId)
            : undefined) ?? focusedLeafOfTab(targetTab)
        : undefined;
      const targetContent = targetLeaf?.content;
      const targetAgentKey =
        targetContent && targetContent.kind !== "web" ? targetContent.agentKey : undefined;
      const activeAgent = targetAgentKey ? allMap.get(targetAgentKey) : undefined;
      const [selHost, selSpace] = s.selectedSpace ? (s.selectedSpace.split("\u0000") as [string, string]) : [null, null];

      const isOnlineHost = (id: string | null | undefined): id is string =>
        Boolean(id && devs[id]?.kind === "host" && devs[id]?.online);

      const localHostId = isTauri() ? localHostIdStore.get() || (await refreshLocalHostIdFast()) : null;

      const hostId =
        (isOnlineHost(preferredHost) ? preferredHost : null) ??
        (splitTarget
          ? (isOnlineHost(activeAgent?.deviceId) ? activeAgent!.deviceId : null) ??
            (isOnlineHost(selHost) ? selHost : null)
          : (isOnlineHost(selHost) ? selHost : null) ??
            (isOnlineHost(activeAgent?.deviceId) ? activeAgent!.deviceId : null)) ??
        Object.values(devs).find((d) => d.kind === "host" && d.online)?.id ??
        (isTauri() && localHostId ? localHostId : undefined);

      if (!hostId) {
        toast("当前没有在线的电脑，无法新建终端", true);
        return;
      }

      const spaceName = splitTarget
        ? preferredSpace ??
          (activeAgent?.deviceId === hostId ? agentSpace(activeAgent) ?? null : null) ??
          (targetTab?.docHostId === hostId && targetTab.docSpaceName ? targetTab.docSpaceName : null) ??
          (selHost === hostId ? selSpace : null)
        : preferredSpace ??
          (selHost === hostId ? selSpace : null) ??
          (activeAgent?.deviceId === hostId ? agentSpace(activeAgent) ?? null : null) ??
          (targetTab?.docHostId === hostId && targetTab.docSpaceName ? targetTab.docSpaceName : null);

      const hostSpacesList = liveStore.get().spaces[hostId] ?? [];
      const matchedKnownSpace = splitTarget
        ? (targetTab?.docHostId === hostId && targetTab.docSpaceId
            ? hostSpacesList.find((sp) => sp.id === targetTab.docSpaceId)
            : undefined) ??
          (spaceName
            ? hostSpacesList.find((sp) => sp.name === spaceName)
            : hostSpacesList.find((sp) => sp.active) ?? hostSpacesList[0])
        : spaceName
          ? hostSpacesList.find((sp) => sp.name === spaceName)
          : hostSpacesList.find((sp) => sp.active) ?? hostSpacesList[0];

      const folder =
        (activeAgent?.deviceId === hostId && activeAgent.cwd ? activeAgent.cwd : undefined) ??
        matchedKnownSpace?.folder ??
        all.find((a) => a.deviceId === hostId && (!spaceName || (agentSpace(a) ?? "") === spaceName) && a.cwd)?.cwd;

      const placePane = (
        key: string,
        resolvedSpaceName?: string,
        newPaneId?: string,
        localIdHint?: string,
        docMeta?: { spaceId?: string; tabId?: string },
      ) => {
        if (splitTarget && targetTab) {
          const termId = localIdHint || key.slice(`${hostId}/hc:`.length);
          if (!newPaneId && termId) {
            registerPendingSplitPlacement(hostId, {
              terminalId: termId,
              agentKey: key,
              targetTabId: targetTab.id,
              ...(targetTab.docTabId ? { targetDocTabId: targetTab.docTabId } : {}),
              anchorPaneId: targetLeaf?.id ?? splitTarget.paneId,
              direction: splitTarget.direction,
            });
          }
          splitTabPane(
            targetTab.id,
            targetLeaf?.id ?? splitTarget.paneId,
            splitTarget.direction,
            { kind: "agent", agentKey: key, mode: "term" },
            { ...(newPaneId ? { newPaneId } : {}), dedupeOtherTabs: true },
          );
          if (newPaneId) {
            void syncHostNow(hostId);
          } else {
            void flushHostNow(hostId);
          }
        } else {
          if (resolvedSpaceName) {
            const targetSpaceKey = `${hostId}\u0000${resolvedSpaceName}`;
            if (shellStore.get().selectedSpace !== targetSpaceKey) {
              setSelectedSpace(targetSpaceKey, lookup, liveStore.get().spaces);
            }
          }
          openAgentTab(key, "term", {
            followSpace: true,
            ...(docMeta?.spaceId
              ? {
                  docMeta: {
                    docHostId: hostId,
                    docSpaceId: docMeta.spaceId,
                    docSpaceName: resolvedSpaceName ?? "",
                    ...(docMeta.tabId ? { docTabId: docMeta.tabId } : {}),
                  },
                }
              : {}),
          });
        }
      };

      const addOptimisticShell = (
        key: string,
        terminalId: string,
        resolvedWhere: string | undefined,
        resolvedCwd: string | undefined,
      ) => {
        liveStore.set((prev) => {
          const list = prev.agents[hostId] ?? [];
          if (list.some((a) => a.key === key)) return prev;
          const shellAgent: Agent = {
            key,
            deviceId: hostId,
            source: "hc",
            localId: terminalId,
            harness: "zsh",
            title: "终端",
            where: resolvedWhere,
            cwd: resolvedCwd,
            status: "idle",
            statusSince: Date.now(),
            isShell: true,
            updatedAt: Date.now(),
          };
          return { ...prev, agents: { ...prev.agents, [hostId]: [shellAgent, ...list] }, rev: prev.rev + 1 };
        });
      };

      // Path 1: When splitting an existing synced Herdr pane, delegate directly to Herdr.app (`pane.split`)
      // so both local Mac and remote Mac split inside the exact tab in Herdr.app instead of creating a new tab.
      const isLocalDesktop = isTauri() && native.available() && Boolean(localHostId && hostId === localHostId);
      const canUseHerdrPaneSplit = Boolean(
        splitTarget &&
          targetTab &&
          targetLeaf &&
          targetLeaf.content.kind === "agent" &&
          activeAgent?.source === "hc" &&
          activeAgent.deviceId === hostId &&
          !targetLeaf.id.startsWith("p0:") &&
          !targetLeaf.id.startsWith("p-") &&
          !(isLocalDesktop && Date.now() < herdrAppSplitSkipUntil),
      );
      if (canUseHerdrPaneSplit && splitTarget && targetTab && targetLeaf) {
        try {
          const cmdRes = await rpcCall(
            hostId,
            "herdr.command",
            {
              command: "pane.split",
              args: { pane: targetLeaf.id, direction: splitTarget.direction },
            },
            isLocalDesktop ? 900 : 10_000,
          );
          const payload = (cmdRes?.result ?? {}) as { terminal?: unknown; pane?: unknown };
          const rawTerm = typeof payload.terminal === "string" ? payload.terminal.trim() : "";
          if (rawTerm) {
            const termId = rawTerm.includes("/") ? rawTerm.split("/").pop()! : rawTerm;
            const key = `${hostId}/hc:${termId}`;
            const newPaneId = typeof payload.pane === "string" && payload.pane.trim() ? payload.pane.trim() : undefined;
            addOptimisticShell(key, termId, spaceName || undefined, folder || undefined);
            placePane(key, spaceName || undefined, newPaneId, termId);
            refreshHostSpaces(hostId);
            return;
          }
        } catch {
          if (isLocalDesktop) herdrAppSplitSkipUntil = Date.now() + 15_000;
          // Herdr.app window may be closed on that computer; fall through cleanly to direct hc/agent.create below.
        }
      }
      const tryLocalShellCreate = async (): Promise<boolean> => {
        if (!isLocalDesktop) return false;
        try {
          let resolvedFolder = folder;
          let spaceId = matchedKnownSpace?.id;
          if ((!resolvedFolder || !spaceId) && spaceName) {
            const spRes = await rpcCall(hostId, "spaces.list", {}, 1_500).catch(() => null);
            const spMatch = spRes?.spaces.find((sp) => sp.name === spaceName);
            resolvedFolder = resolvedFolder || spMatch?.folder;
            spaceId = spaceId || spMatch?.id;
          }
          const localDocTabId =
            !splitTarget && spaceId
              ? `tb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
              : undefined;
          const grid = measureTerminalGrid(splitTarget?.direction);
          const created = await native.localTermCreateShell({
            cwd: resolvedFolder || undefined,
            cols: grid.cols,
            rows: grid.rows,
            display: grid.display,
            spaceName: spaceName || undefined,
            spaceId: spaceId || undefined,
            tabId: splitTarget ? targetTab?.docTabId : localDocTabId,
          });
          const key = `${hostId}/hc:${created.terminal}`;
          addOptimisticShell(key, created.terminal, spaceName || undefined, created.cwd || resolvedFolder || undefined);
          placePane(
            key,
            spaceName || undefined,
            undefined,
            created.terminal,
            spaceId ? { spaceId, ...(localDocTabId ? { tabId: localDocTabId } : {}) } : undefined,
          );
          if (!splitTarget && spaceId) {
            void flushHostNow(hostId);
          }
          refreshHostSpaces(hostId);
          return true;
        } catch {
          return false;
        }
      };

      // When splitting locally while Herdr.app is closed (or standalone), or when there are no Herdr spaces yet,
      // spawn directly via local `hc` and preserve the split placement in HerdrDoc.
      if (isLocalDesktop && (splitTarget || hostSpacesList.length === 0)) {
        if (await tryLocalShellCreate()) return;
      }

      try {
        const spRes = await rpcCall(hostId, "spaces.list", {}, 6_000).catch(() => null);
        const spacesForMatch = spRes?.spaces?.length ? spRes.spaces : hostSpacesList;
        const matchedSpace = spaceName
          ? spacesForMatch.find((sp) => sp.name === spaceName)
          : (matchedKnownSpace ?? spacesForMatch.find((sp) => sp.active) ?? spacesForMatch[0]);
        const spaceId = matchedSpace?.id ?? matchedKnownSpace?.id;
        const resolvedFolder = folder || matchedSpace?.folder || spRes?.folders[0];
        const created = await rpcCall(
          hostId,
          "agent.create",
          {
            space: spaceId || undefined,
            ...(!spaceId && spaceName ? { spaceName } : {}),
            folder: spaceId ? undefined : resolvedFolder || undefined,
            launcher: "shell",
          },
          20_000,
        );
        const resolvedWhere = matchedSpace?.name || spaceName || undefined;
        addOptimisticShell(created.agent, created.terminal, resolvedWhere, resolvedFolder || undefined);
        placePane(created.agent, resolvedWhere, undefined, created.terminal, {
          spaceId: created.space || spaceId,
          ...(created.tab ? { tabId: created.tab } : {}),
        });
        void pullHostDocNow(hostId);
        refreshHostSpaces(hostId);
      } catch (e) {
        if (isLocalDesktop && (await tryLocalShellCreate())) return;
        toast((e as Error).message, true);
      }
    },
    [toast],
  );

  // Keep a valid Space selected whenever host spaces or agents exist so the tab bar stays Space-scoped like Herdr.app.
  useEffect(() => {
    const curSel = shellStore.get().selectedSpace;
    const all = allAgents(agentsMap);
    const agentByKey = new Map(all.map((a) => [a.key, a] as const));
    if (curSel) {
      const sep = curSel.indexOf("\u0000");
      const selHost = sep >= 0 ? curSel.slice(0, sep) : "";
      const selName = sep >= 0 ? curSel.slice(sep + 1) : curSel;
      const stillExists =
        Boolean(spacesMap[selHost]?.some((sp) => sp.name === selName)) ||
        all.some((a) => a.deviceId === selHost && (agentSpace(a) ?? "") === selName);
      if (stillExists) return;
      const prevDocSpaceIds = new Set(
        shellStore
          .get()
          .tabs.filter((t) => t.docHostId === selHost && t.docSpaceName === selName && t.docSpaceId)
          .map((t) => t.docSpaceId!),
      );
      const renamedSpace = spacesMap[selHost]?.find((sp) => sp.id && prevDocSpaceIds.has(sp.id) && sp.name);
      if (renamedSpace) {
        setSelectedSpace(`${selHost}\u0000${renamedSpace.name}`, (k) => agentByKey.get(k), spacesMap, { trigger: "auto" });
        return;
      }
    }

    const localId = localHostIdStore.get();
    const candidateHosts = [
      ...(localId ? [localId] : []),
      ...hosts.filter((h) => h.online && h.id !== localId).map((h) => h.id),
      ...Object.keys(spacesMap),
      ...hosts.filter((h) => !h.online && h.id !== localId).map((h) => h.id),
    ];
    for (const hid of candidateHosts) {
      const list = spacesMap[hid];
      if (list?.length) {
        const pick = list.find((sp) => sp.active) ?? list.find((sp) => sp.terminals > 0) ?? list[0];
        if (pick) {
          setSelectedSpace(`${hid}\u0000${pick.name}`, (k) => agentByKey.get(k), spacesMap, { trigger: "auto" });
          return;
        }
      }
      const fallbackAgent = all.find((a) => a.deviceId === hid && agentSpace(a));
      const fallbackSpace = fallbackAgent ? agentSpace(fallbackAgent) : undefined;
      if (fallbackSpace) {
        setSelectedSpace(`${hid}\u0000${fallbackSpace}`, (k) => agentByKey.get(k), spacesMap, { trigger: "auto" });
        return;
      }
    }
  }, [agentsMap, hosts, spacesMap]);

  // The first time agents arrive with nothing open, open the most urgent one, so the work
  // area shows something useful. Closing every tab afterwards leaves it empty.
  const autoOpened = useRef(tabs.length > 0);
  useEffect(() => {
    if (autoOpened.current || !agents.length) return;
    autoOpened.current = true;
    const pick = [...agents].sort(
      (x, y) => GROUP_RANK[listGroup(x, devices)] - GROUP_RANK[listGroup(y, devices)] || lastChange(y) - lastChange(x),
    )[0];
    if (pick && shellStore.get().tabs.length === 0) openAgentTab(pick.key, "term", { trigger: "auto" });
  }, [agents, devices]);

  const isDark = theme === "dark" || (theme === "system" && document.documentElement.getAttribute("data-theme") === "dark");

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];
    const allByAgentKey = allAgents(agentsMap);
    for (const t of tabs) {
      const focusedContent = focusedLeafOfTab(t).content;
      const leaves = tabLeaves(t);
      const a = focusedContent.kind === "agent" ? allByAgentKey.find((x) => x.key === focusedContent.agentKey) : undefined;
      const baseLabel =
        focusedContent.kind === "agent"
          ? a
            ? agentTitle(a)
            : "已结束的 Agent"
          : focusedContent.title === "about:blank"
            ? "新网页"
            : focusedContent.title;
      const label = leaves.length > 1 ? `${baseLabel}（${leaves.length} 分屏）` : baseLabel;
      list.push({
        id: `tab:${t.id}`,
        group: "标签",
        label: `切到：${label}`,
        hint:
          focusedContent.kind === "file" || focusedContent.kind === "diff"
            ? focusedContent.path
            : focusedContent.kind === "web"
              ? focusedContent.url
              : a
                ? devices[a.deviceId]?.name
                : undefined,
        icon:
          leaves.length > 1
            ? Columns2
            : focusedContent.kind === "agent"
              ? SquareStack
              : focusedContent.kind === "file"
                ? FolderTree
                : focusedContent.kind === "diff"
                  ? GitBranch
                  : Globe,
        terms: label,
        run: () => setActiveTab(t.id),
      });
    }
    list.push(
      { id: "new-terminal", group: "标签", label: "新建终端", keys: ["Mod", "T"], icon: Terminal, terms: "new terminal shell 终端", run: () => void spawnTerminalNow() },
      { id: "new-agent", group: "标签", label: "新建 Agent…", keys: ["Mod", "N"], icon: Plus, terms: "new agent claude codex", run: () => newAgent() },
      { id: "new-space", group: "空间", label: "新建工作空间…", keys: ["Mod", "Shift", "N"], icon: Layers, terms: "space workspace new 空间", run: () => newSpace() },
      { id: "prev-space", group: "空间", label: "切换到上一个空间", keys: ["Mod", "Alt", "["], icon: Layers, terms: "space prev 空间", run: () => cycleSpace(-1) },
      { id: "next-space", group: "空间", label: "切换到下一个空间", keys: ["Mod", "Alt", "]"], icon: Layers, terms: "space next 空间", run: () => cycleSpace(1) },
      { id: "all-spaces", group: "空间", label: "显示全部空间", keys: ["Mod", "Alt", "0"], icon: Layers, terms: "space all 全部空间", run: () => setSelectedSpace(null) },
      { id: "new-web", group: "标签", label: "打开网页", icon: Globe, terms: "browser web", run: () => openWebTab(homePage || "about:blank") },
      { id: "close-tab", group: "标签", label: "关闭当前分屏或标签", keys: ["Mod", "W"], icon: X, run: () => closeActive() },
      { id: "close-whole-tab", group: "标签", label: "关闭整个标签页", keys: ["Mod", "Shift", "W"], icon: X, run: () => closeWholeActiveTab() },
      { id: "next-tab", group: "标签", label: "下一个标签", keys: ["Mod", "Shift", "]"], run: () => cycleTab(1, currentVisibleTabs()) },
      { id: "prev-tab", group: "标签", label: "上一个标签", keys: ["Mod", "Shift", "["], run: () => cycleTab(-1, currentVisibleTabs()) },
      {
        id: "split-right",
        group: "分屏",
        label: "向右分屏新建终端",
        keys: IS_MAC ? ["Mod", "D"] : ["Mod", "Shift", "O"],
        icon: Columns2,
        terms: "split pane right column 分屏 右侧",
        run: () => splitFocusedTerminal("right"),
      },
      {
        id: "split-down",
        group: "分屏",
        label: "向下分屏新建终端",
        keys: ["Mod", "Shift", "D"],
        icon: Rows2,
        terms: "split pane down row 分屏 下方",
        run: () => splitFocusedTerminal("down"),
      },
      {
        id: "pane-zoom",
        group: "分屏",
        label: "最大化 / 还原当前分屏",
        keys: ["Mod", "Shift", "Enter"],
        icon: Maximize2,
        terms: "pane zoom maximize restore 放大 还原",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) toggleZoomTabPane(ref.tab.id, ref.paneId);
        },
      },
      {
        id: "pane-equalize",
        group: "分屏",
        label: "均分当前标签的分屏尺寸",
        keys: ["Mod", "Alt", "="],
        icon: Equal,
        terms: "equalize split balance 均分",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) equalizeTabSplits(ref.tab.id);
        },
      },
      {
        id: "pane-detach",
        group: "分屏",
        label: "拆分当前分屏为独立标签",
        icon: SquareArrowOutUpRight,
        terms: "detach split pane tab 拆分",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) detachPaneToTab(ref.tab.id, ref.paneId);
        },
      },
      {
        id: "pane-unsplit",
        group: "分屏",
        label: "将当前标签的所有分屏拆为独立标签",
        keys: ["Mod", "Alt", "Shift", "W"],
        icon: SquareArrowOutUpRight,
        terms: "unsplit split panes tabs 拆分全部",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) unsplitTabToTabs(ref.tab.id);
        },
      },
      {
        id: "pane-focus-left",
        group: "分屏",
        label: "焦点移到左侧分屏",
        keys: ["Mod", "Alt", "ArrowLeft"],
        icon: ArrowLeft,
        terms: "pane go focus left",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "left");
        },
      },
      {
        id: "pane-focus-right",
        group: "分屏",
        label: "焦点移到右侧分屏",
        keys: ["Mod", "Alt", "ArrowRight"],
        icon: ArrowRight,
        terms: "pane go focus right",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "right");
        },
      },
      {
        id: "pane-focus-up",
        group: "分屏",
        label: "焦点移到上方分屏",
        keys: ["Mod", "Alt", "ArrowUp"],
        icon: ArrowUp,
        terms: "pane go focus up",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "up");
        },
      },
      {
        id: "pane-focus-down",
        group: "分屏",
        label: "焦点移到下方分屏",
        keys: ["Mod", "Alt", "ArrowDown"],
        icon: ArrowDown,
        terms: "pane go focus down",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "down");
        },
      },
      {
        id: "pane-swap-left",
        group: "分屏",
        label: "与左侧分屏交换位置",
        keys: ["Mod", "Alt", "Shift", "ArrowLeft"],
        icon: ArrowLeftRight,
        terms: "pane swap left 交换",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "left");
        },
      },
      {
        id: "pane-swap-right",
        group: "分屏",
        label: "与右侧分屏交换位置",
        keys: ["Mod", "Alt", "Shift", "ArrowRight"],
        icon: ArrowLeftRight,
        terms: "pane swap right 交换",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "right");
        },
      },
      {
        id: "pane-swap-up",
        group: "分屏",
        label: "与上方分屏交换位置",
        keys: ["Mod", "Alt", "Shift", "ArrowUp"],
        icon: ArrowUpDown,
        terms: "pane swap up 交换",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "up");
        },
      },
      {
        id: "pane-swap-down",
        group: "分屏",
        label: "与下方分屏交换位置",
        keys: ["Mod", "Alt", "Shift", "ArrowDown"],
        icon: ArrowUpDown,
        terms: "pane swap down 交换",
        run: () => {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "down");
        },
      },
      {
        id: "term-search",
        group: "分屏",
        label: "在当前终端输出中搜索",
        keys: IS_MAC ? ["Mod", "F"] : ["Mod", "Shift", "F"],
        icon: Search,
        terms: "find search terminal output 查找 搜索",
        run: () => {
          const ref = currentFocusedPane();
          const content = ref ? focusedLeafOfTab(ref.tab).content : null;
          if (content?.kind === "agent") {
            window.dispatchEvent(new CustomEvent("pocket:term-search", { detail: { agentKey: content.agentKey } }));
          }
        },
      },
      { id: "panel-files", group: "面板", label: "显示或隐藏文件", keys: ["Mod", "J"], icon: FolderTree, terms: "files", run: () => togglePanel("files") },
      { id: "panel-git", group: "面板", label: "显示或隐藏 Git 管理", keys: ["Mod", "Shift", "G"], icon: GitBranch, terms: "git diff commit branch", run: () => togglePanel("git") },
      { id: "panel-browser", group: "面板", label: "显示或隐藏浏览器", keys: ["Mod", "Alt", "B"], icon: Globe, run: () => togglePanel("browser") },
      { id: "panel-assistant", group: "面板", label: "和小羊说话", keys: ["Mod", "Shift", "A"], icon: Sparkles, terms: "assistant 助理", run: () => togglePanel("assistant") },
      { id: "sidebar", group: "面板", label: collapsed ? "展开侧栏" : "收起侧栏", keys: ["Mod", "B"], icon: PanelLeft, run: onToggleSidebar },
      { id: "shortcut-help", group: "应用", label: "快捷键指南与帮助", keys: ["Mod", "/"], icon: Keyboard, terms: "shortcut help keymap 快捷键", run: () => setHelpOpen(true) },
      { id: "jump-agent", group: "应用", label: "快速跳转到 Agent 或标签", keys: ["Mod", "O"], icon: Search, terms: "jump switch agent 跳转", run: () => setPalette("jump") },
      { id: "jump-urgent", group: "应用", label: "跳转到下一个需要你的 Agent", keys: ["Mod", "Shift", "U"], icon: Bell, terms: "urgent blocked waiting 阻塞 需要你", run: () => jumpUrgentAgent() },
      { id: "agent-toggle-mode", group: "Agent", label: "切换当前 Agent 对话 / 终端视图", keys: ["Mod", "E"], icon: MessageSquare, terms: "chat terminal mode toggle 切换视图", run: () => toggleFocusedAgentMode() },
      { id: "agent-focus-composer", group: "Agent", label: "聚焦对话输入框", keys: ["Mod", "L"], icon: MessageSquare, terms: "focus composer input 输入框", run: () => dispatchFocusedAgentAction("focusComposer") },
      { id: "agent-model", group: "Agent", label: "切换当前 Agent 模型", keys: ["Mod", "Alt", "M"], icon: Bot, terms: "model switch 模型", run: () => dispatchFocusedAgentAction("openModelPicker") },
      { id: "agent-thinking", group: "Agent", label: "调整思考强度", keys: ["Mod", "Alt", "T"], icon: Cpu, terms: "thinking effort 思考", run: () => dispatchFocusedAgentAction("openThinkingPicker") },
      { id: "agent-usage", group: "Agent", label: "查看会话用量统计", keys: ["Mod", "Alt", "U"], icon: BarChart2, terms: "usage cost 费用 用量", run: () => dispatchFocusedAgentAction("openUsageCard") },
      { id: "agent-interrupt", group: "Agent", label: "中断当前 Agent 回复", keys: ["Mod", "."], icon: OctagonX, terms: "stop interrupt cancel 停止 中断", run: () => dispatchFocusedAgentAction("interruptAgent") },
      { id: "check-update", group: "应用", label: "检查软件更新", icon: RefreshCw, terms: "update upgrade 更新 版本", run: () => void checkForUpdate("manual") },
    );
    for (const a of [...agents].sort((x, y) => GROUP_RANK[listGroup(x, devices)] - GROUP_RANK[listGroup(y, devices)] || lastChange(y) - lastChange(x))) {
      list.push({
        id: `agent:${a.key}`,
        group: "Agent",
        label: spacedTitle(a),
        hint: devices[a.deviceId]?.name,
        terms: `${a.harness} ${a.cwd ?? ""}`,
        icon: (({ size }: { size?: number }) => <VendorIcon harness={a.harness} isShell={a.isShell} size={size ?? 14} />) as PaletteItem["icon"],
        run: () => openAgentTab(a.key),
      });
    }
    list.push(
      { id: "pair", group: "操作", label: "扫码连接手机", icon: QrCode, terms: "phone qr", run: onPairPhone },
      { id: "relay", group: "操作", label: "连接中转服务器", icon: Server, terms: "relay server", run: onConnectRelay },
      { id: "add-computer", group: "操作", label: "添加电脑", icon: Plus, terms: "computer machine", run: () => setAddComputer(true) },
      {
        id: "theme",
        group: "操作",
        label: isDark ? "切换到浅色" : "切换到暗色",
        keys: ["Mod", "Shift", "L"],
        icon: isDark ? Sun : Moon,
        terms: "theme dark light 外观",
        run: () => updateSettings({ theme: isDark ? "light" : "dark" }),
      },
      { id: "guide", group: "操作", label: "重新打开新手引导", icon: BookOpen, run: onReopenGuide },
    );
    for (const f of FRAME_ITEMS) {
      list.push({
        id: `settings:${f.id}`,
        group: "设置",
        label: `设置：${f.label}`,
        icon: f.icon,
        keys: f.id === "look" ? ["Mod", ","] : undefined,
        terms: "settings",
        run: () => openSettingsFrame(f.id),
      });
    }
    list.push({
      id: "term-font",
      group: "设置",
      label: "切换终端字体与字号…",
      icon: Terminal,
      terms: "font terminal 字体 字号 终端",
      run: () => openSettingsFrame("look"),
    });
    return list;
    // closeActive reads the store when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, agentsMap, collapsed, devices, homePage, isDark, newAgent, onConnectRelay, onPairPhone, onReopenGuide, onToggleSidebar, spawnTerminalNow, tabs]);

  function currentVisibleTabs() {
    const s = shellStore.get();
    const map = new Map(allAgents(liveStore.get().agents).map((x) => [x.key, x] as const));
    return visibleTabsForSpace(s.tabs, s.selectedSpace, (k) => map.get(k), liveStore.get().spaces);
  }

  function currentFocusedPane() {
    const s = shellStore.get();
    const map = new Map(allAgents(liveStore.get().agents).map((x) => [x.key, x] as const));
    const activeId = activeTabIdForSpace(s, (k) => map.get(k), liveStore.get().spaces);
    const tab = s.tabs.find((x) => x.id === activeId);
    if (!tab) return null;
    const focused = focusedLeafOfTab(tab);
    return { tab, paneId: focused.id };
  }

  function splitFocusedTerminal(direction: SplitDirection) {
    const ref = currentFocusedPane();
    void spawnTerminalNow(null, null, ref ? { tabId: ref.tab.id, paneId: ref.paneId, direction } : undefined);
  }

  function toggleFocusedAgentMode() {
    const ref = currentFocusedPane();
    if (!ref) return;
    const leaf = focusedLeafOfTab(ref.tab);
    if (leaf.content.kind !== "agent") return;
    const cur = leaf.content.mode ?? "term";
    const next = cur === "chat" ? "term" : "chat";
    logAction("ui", "ui.mode", { mode: next, via: "shortcut" });
    setPaneAgentMode(ref.tab.id, ref.paneId, next);
  }

  function dispatchFocusedAgentAction(
    action: "focusComposer" | "openModelPicker" | "openThinkingPicker" | "openUsageCard" | "interruptAgent",
  ) {
    const ref = currentFocusedPane();
    if (!ref) return;
    const content = focusedLeafOfTab(ref.tab).content;
    if (content.kind === "agent" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pocket:agent-action", { detail: { agentKey: content.agentKey, action } }));
    }
  }

  function cycleSpace(step: 1 | -1) {
    const live = liveStore.get();
    const visible = allAgents(live.agents).filter((a) => settingsStore.get().showShells || !a.isShell);
    const ordered: string[] = [];
    const seen = new Set<string>();
    const hostsList = Object.values(live.devices)
      .filter((d) => d.kind === "host")
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    for (const h of hostsList) {
      for (const sp of buildHostSpaces(h.id, live.spaces[h.id], visible, live.devices)) {
        if (!seen.has(sp.id)) {
          seen.add(sp.id);
          ordered.push(sp.id);
        }
      }
    }
    if (!ordered.length) return;
    const cur = shellStore.get().selectedSpace;
    const idx = cur ? ordered.indexOf(cur) : -1;
    const nextIdx = idx < 0 ? (step > 0 ? 0 : ordered.length - 1) : (idx + step + ordered.length) % ordered.length;
    const lookup = new Map(allAgents(live.agents).map((x) => [x.key, x] as const));
    setSelectedSpace(ordered[nextIdx]!, (k) => lookup.get(k), live.spaces, { trigger: "shortcut" });
  }

  function jumpUrgentAgent() {
    if (jumpToNextAttentionItem()) return;
    const live = liveStore.get();
    const list = allAgents(live.agents)
      .filter((a) => a.status === "blocked")
      .sort((a, b) => lastChange(b) - lastChange(a));
    if (!list.length) {
      toast("当前没有待处理的审批、提问、报错或完成提醒");
      return;
    }
    const ref = currentFocusedPane();
    const curKey = ref && focusedLeafOfTab(ref.tab).content.kind === "agent"
      ? (focusedLeafOfTab(ref.tab).content as { agentKey: string }).agentKey
      : null;
    const curIdx = curKey ? list.findIndex((a) => a.key === curKey) : -1;
    const picked = list[(curIdx + 1) % list.length]!;
    openAgentTab(picked.key, undefined, { trigger: "shortcut" });
  }

  function closeActive() {
    const ref = currentFocusedPane();
    if (ref) requestClosePane(ref.tab.id, ref.paneId);
  }

  function closeWholeActiveTab() {
    const ref = currentFocusedPane();
    if (ref) requestCloseShellTab(ref.tab);
  }

  const jumpUrgentRef = useRef(jumpUrgentAgent);
  jumpUrgentRef.current = jumpUrgentAgent;

  useEffect(() => {
    const onToggleHelp = () => setHelpOpen((prev) => !prev);
    const onJumpUrgent = () => jumpUrgentRef.current();
    window.addEventListener("pocket:toggle-shortcut-help", onToggleHelp);
    window.addEventListener("pocket:jump-urgent", onJumpUrgent);
    return () => {
      window.removeEventListener("pocket:toggle-shortcut-help", onToggleHelp);
      window.removeEventListener("pocket:jump-urgent", onJumpUrgent);
    };
  }, []);

  // Track Ctrl/Cmd modifier state for click-to-jump file links.
  useEffect(() => {
    const sync = (active: boolean) => {
      const next = active ? "true" : "false";
      if (document.documentElement.dataset.linkMod !== next) {
        document.documentElement.dataset.linkMod = next;
      }
    };
    const onKeyEvent = (e: KeyboardEvent) => sync(e.ctrlKey || e.metaKey);
    const onPointerMove = (e: PointerEvent) => {
      if (!(e.ctrlKey || e.metaKey) && document.documentElement.dataset.linkMod === "true") {
        sync(false);
      }
    };
    const clear = () => sync(false);
    sync(false);
    window.addEventListener("keydown", onKeyEvent, true);
    window.addEventListener("keyup", onKeyEvent, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("paste", clear, true);
    window.addEventListener("copy", clear, true);
    window.addEventListener("contextmenu", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      delete document.documentElement.dataset.linkMod;
      window.removeEventListener("keydown", onKeyEvent, true);
      window.removeEventListener("keyup", onKeyEvent, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("paste", clear, true);
      window.removeEventListener("copy", clear, true);
      window.removeEventListener("contextmenu", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // Window shortcuts (shell/shortcuts.ts). On Windows a focused terminal box keeps bare Ctrl+letter keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const s = shellStore.get();
        const dialogUp = Boolean(document.querySelector("[role=dialog][data-state=open]")) && !s.settings && !s.palette;
        if (dialogUp || s.settings || s.palette) return;
        const vis = currentVisibleTabs();
        const picked = e.key === "9" ? vis[vis.length - 1] : vis[Number(e.key) - 1];
        if (picked) {
          e.preventDefault();
          logAction("ui", "ui.shortcut", { id: e.key === "9" ? "jumpLastTab" : "jumpTabRange", slot: Number(e.key) });
          setActiveTab(picked.id, { trigger: "shortcut" });
        }
        return;
      }
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.defaultPrevented) {
        const tgt = e.target as HTMLElement | null;
        const inEditable = Boolean(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
        const s = shellStore.get();
        const dialogUp = Boolean(document.querySelector("[role=dialog][data-state=open]"));
        if (!inEditable && !dialogUp && overlayStore.get().open === 0 && !s.settings && !s.palette && !s.peek) {
          const ref = currentFocusedPane();
          if (ref && tabLeaves(ref.tab).length === 1) {
            const leaf = focusedLeafOfTab(ref.tab);
            if (leaf.content.kind === "file" || leaf.content.kind === "diff") {
              e.preventDefault();
              requestClosePane(ref.tab.id, ref.paneId);
              return;
            }
          }
        }
      }
      const id = matchShortcut(e);
      if (!id) return;
      if (!IS_MAC && !e.shiftKey && !e.altKey && /^[a-z]$/i.test(e.key) && terminalOwnsCtrlK(e.target)) return;
      const s = shellStore.get();
      // Another dialog on top (pairing, a confirm): only the palette, help, and settings toggles pass.
      const dialogUp = Boolean(document.querySelector("[role=dialog][data-state=open]")) && !s.settings && !s.palette;
      if (dialogUp && id !== "palette" && id !== "settings" && id !== "shortcutHelp") return;
      e.preventDefault();
      logAction("ui", "ui.shortcut", { id });
      switch (id) {
        case "shortcutHelp":
          setHelpOpen((prev) => !prev);
          break;
        case "jumpAgent":
          setPalette(s.palette === "jump" ? false : "jump");
          break;
        case "jumpUrgent":
          jumpUrgentRef.current();
          break;
        case "toggleTheme": {
          const curDark = document.documentElement.getAttribute("data-theme") === "dark";
          updateSettings({ theme: curDark ? "light" : "dark" });
          break;
        }
        case "newSpace":
          newSpace();
          break;
        case "prevSpace":
          cycleSpace(-1);
          break;
        case "nextSpace":
          cycleSpace(1);
          break;
        case "allSpaces":
          setSelectedSpace(null, undefined, undefined, { trigger: "shortcut" });
          break;
        case "newAgentDialog":
          newAgent();
          break;
        case "closeWholeTab":
          closeWholeActiveTab();
          break;
        case "equalizeSplits": {
          const ref = currentFocusedPane();
          if (ref) equalizeTabSplits(ref.tab.id);
          break;
        }
        case "unsplitTab": {
          const ref = currentFocusedPane();
          if (ref) unsplitTabToTabs(ref.tab.id);
          break;
        }
        case "toggleBrowser":
          togglePanel("browser");
          break;
        case "togglePaneMode":
          toggleFocusedAgentMode();
          break;
        case "focusComposer":
          dispatchFocusedAgentAction("focusComposer");
          break;
        case "openModelPicker":
          dispatchFocusedAgentAction("openModelPicker");
          break;
        case "openThinkingPicker":
          dispatchFocusedAgentAction("openThinkingPicker");
          break;
        case "openUsageCard":
          dispatchFocusedAgentAction("openUsageCard");
          break;
        case "interruptAgent":
          dispatchFocusedAgentAction("interruptAgent");
          break;
        case "terminalSearch": {
          const ref = currentFocusedPane();
          const content = ref ? focusedLeafOfTab(ref.tab).content : null;
          if (content?.kind === "agent") {
            window.dispatchEvent(new CustomEvent("pocket:term-search", { detail: { agentKey: content.agentKey } }));
          }
          break;
        }
        case "palette":
          setPalette(s.palette ? false : "command");
          break;
        case "settings":
          if (s.settings) closeSettingsFrame();
          else openSettingsFrame("look");
          break;
        case "newAgent":
          void spawnTerminalNow();
          break;
        case "closeTab":
          closeActive();
          break;
        case "nextTab":
          cycleTab(1, currentVisibleTabs());
          break;
        case "prevTab":
          cycleTab(-1, currentVisibleTabs());
          break;
        case "splitRight":
          splitFocusedTerminal("right");
          break;
        case "splitDown":
          splitFocusedTerminal("down");
          break;
        case "zoomPane": {
          const ref = currentFocusedPane();
          if (ref) toggleZoomTabPane(ref.tab.id, ref.paneId);
          break;
        }
        case "focusPaneLeft": {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "left");
          break;
        }
        case "focusPaneRight": {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "right");
          break;
        }
        case "focusPaneUp": {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "up");
          break;
        }
        case "focusPaneDown": {
          const ref = currentFocusedPane();
          if (ref) focusPaneDirection(ref.tab.id, "down");
          break;
        }
        case "swapPaneLeft": {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "left");
          break;
        }
        case "swapPaneRight": {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "right");
          break;
        }
        case "swapPaneUp": {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "up");
          break;
        }
        case "swapPaneDown": {
          const ref = currentFocusedPane();
          if (ref) swapPaneDirection(ref.tab.id, "down");
          break;
        }
        case "toggleSidebar":
          if (canToggleSidebar) onToggleSidebar();
          break;
        case "togglePanel":
          togglePanel("files");
          break;
        case "toggleGit":
          togglePanel("git");
          break;
        case "assistant":
          togglePanel("assistant");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canToggleSidebar, newAgent, newSpace, onToggleSidebar, spawnTerminalNow]);

  const handleShellNewTerminal = useCallback(() => {
    void spawnTerminalNow();
  }, [spawnTerminalNow]);
  const handleShellNewAgent = useCallback(() => {
    newAgent();
  }, [newAgent]);
  const handleShellSplitNewTerminal = useCallback(
    (tabId: string, paneId: string, direction: SplitDirection) => {
      void spawnTerminalNow(null, null, { tabId, paneId, direction });
    },
    [spawnTerminalNow],
  );

  return (
    <div
      className={`v3${collapsed ? " collapsed" : ""}`}
      style={{ "--v3-sidebar-effective": collapsed ? "48px" : `${sidebarWidth}px` } as CSSProperties}
    >
      <ShellSidebar
        collapsed={collapsed}
        canToggle={canToggleSidebar}
        onToggle={onToggleSidebar}
        onConnectRelay={onConnectRelay}
        onPairPhone={onPairPhone}
        onNewAgent={newAgent}
        onNewSpace={newSpace}
        onNewTerminal={(h, sp) => void spawnTerminalNow(h, sp)}
      />
      <div className="v3-work">
        <ShellTabs onNewTerminal={handleShellNewTerminal} onNewAgent={handleShellNewAgent} padForLights={collapsed} />
        <div className="v3-body">
          <ShellMain
            onNewTerminal={handleShellNewTerminal}
            onNewAgent={handleShellNewAgent}
            onSplitNewTerminal={handleShellSplitNewTerminal}
          />
          <ShellPanel />
          <PeekOverlay />
        </div>
        <ShellStatus onConnectRelay={onConnectRelay} />
      </div>

      <Palette mode={palette} onClose={() => setPalette(false)} items={items} />
      <ModifierChordHud />
      <PocketDroplet />
      <ShortcutHelpModal open={helpOpen} onOpenChange={setHelpOpen} />
      <SettingsFrame
        onPairPhone={onPairPhone}
        onConnectRelay={onConnectRelay}
        onAddComputer={() => setAddComputer(true)}
        onReopenGuide={() => {
          closeSettingsFrame();
          onReopenGuide();
        }}
      />
      <CreateAgentModal
        open={create !== null}
        onOpenChange={(v) => !v && setCreate(null)}
        hosts={hosts}
        defaultHost={create?.host ?? null}
        defaultSpace={create?.space ?? null}
        preferNewSpace={Boolean(create?.preferNewSpace)}
        onCreated={(info) => {
          const isShell = info.launcher === "shell";
          const folderBase = (info.folder ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || "";
          const resolvedSpaceName = info.spaceName?.trim() || folderBase || "workspace";
          const localId = info.terminalId || info.agentKey.split("/").pop()?.replace(/^hc:/, "") || info.agentKey;
          liveStore.set((prev) => {
            const curAgents = prev.agents[info.hostId] ?? [];
            const nextAgents = curAgents.some((a) => a.key === info.agentKey)
              ? curAgents
              : [
                  {
                    key: info.agentKey,
                    deviceId: info.hostId,
                    source: "hc" as const,
                    localId,
                    harness: isShell ? "zsh" : info.launcher,
                    title: isShell ? "终端" : "新建 Agent",
                    where: resolvedSpaceName,
                    cwd: info.folder,
                    status: isShell ? ("idle" as const) : ("working" as const),
                    statusSince: Date.now(),
                    isShell,
                    updatedAt: Date.now(),
                  },
                  ...curAgents,
                ];
            const curSpaces = prev.spaces[info.hostId] ?? [];
            const hasSpace = curSpaces.some(
              (sp) => (info.spaceId && sp.id === info.spaceId) || sp.name === resolvedSpaceName,
            );
            const nextSpaces = hasSpace
              ? curSpaces.map((sp) => ({
                  ...sp,
                  active: (info.spaceId && sp.id === info.spaceId) || sp.name === resolvedSpaceName,
                }))
              : [
                  ...curSpaces.map((sp) => ({ ...sp, active: false })),
                  {
                    id: info.spaceId || `sp-opt-${Date.now().toString(36)}`,
                    name: resolvedSpaceName,
                    ...(info.folder ? { folder: info.folder } : {}),
                    tabs: 1,
                    terminals: 1,
                    active: true,
                  },
                ];
            return {
              ...prev,
              agents: { ...prev.agents, [info.hostId]: nextAgents },
              spaces: { ...prev.spaces, [info.hostId]: nextSpaces },
              rev: prev.rev + 1,
            };
          });
          const targetSpaceKey = `${info.hostId}\u0000${resolvedSpaceName}`;
          const lookupNow = (k: string) => liveStore.get().agents[info.hostId]?.find((a) => a.key === k);
          if (shellStore.get().selectedSpace !== targetSpaceKey) {
            setSelectedSpace(targetSpaceKey, lookupNow, liveStore.get().spaces);
          }
          openAgentTab(info.agentKey, "term", {
            followSpace: true,
            lookupAgent: lookupNow,
            ...(info.spaceId
              ? {
                  docMeta: {
                    docHostId: info.hostId,
                    docSpaceId: info.spaceId,
                    docSpaceName: resolvedSpaceName,
                    ...(info.tabId ? { docTabId: info.tabId } : {}),
                  },
                }
              : {}),
          });
          void pullHostDocNow(info.hostId);
          void rpcCall(info.hostId, "spaces.list", {})
            .then((res) => {
              liveStore.set((prev) => ({ ...prev, spaces: { ...prev.spaces, [info.hostId]: res.spaces } }));
              const serverSpace = info.spaceId ? res.spaces.find((sp) => sp.id === info.spaceId) : undefined;
              if (serverSpace && serverSpace.name && serverSpace.name !== resolvedSpaceName) {
                renameSpaceInShellStore(info.hostId, serverSpace.id, resolvedSpaceName, serverSpace.name);
              }
            })
            .catch(() => {});
          toast(isShell ? "已创建并打开终端" : "已创建并在终端中启动 Agent");
        }}
      />
      <AddDeviceModal open={addComputer} onOpenChange={setAddComputer} />
    </div>
  );
}
