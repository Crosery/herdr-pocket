import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BookOpen,
  Cpu,
  FolderTree,
  GitBranch,
  Globe,
  Info,
  Keyboard,
  Mic,
  Moon,
  Palette as PaletteIcon,
  PanelLeft,
  Plus,
  QrCode,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  Sparkles,
  SquareStack,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { VendorIcon } from "../components/MascotAndVendor";
import { AddDeviceModal } from "../views/DevicesView";
import { CreateAgentModal } from "../views/AgentsView";
import { SettingsFrame } from "../views/settings/SettingsFrame";
import { useClientConfig, clientConfigStore } from "../lib/config";
import { useToast } from "../components/PocketUI";
import { isTauri } from "../lib/bridge";
import { localHostIdStore, refreshLocalHostIdFast } from "../lib/fonts";
import { native } from "../lib/native";
import { refreshHostSpaces, rpcCall } from "../lib/relay";
import { checkForUpdate } from "../lib/updates";
import { agentSpace, allAgents, liveStore, settingsStore, spacedTitle, updateSettings, agentTitle } from "../lib/store";
import { terminalOwnsCtrlK } from "../lib/termKeys";
import { GROUP_RANK, lastChange, listGroup } from "./agentInfo";
import { Palette, type PaletteItem } from "./Palette";
import { ShellSidebar } from "./ShellSidebar";
import { PeekOverlay, ShellMain, ShellPanel, ShellStatus, ShellTabs, closeShellTab } from "./ShellWork";
import {
  activeTabIdForSpace,
  closeSettingsFrame,
  cycleTab,
  openAgentTab,
  openSettingsFrame,
  openWebTab,
  setActiveTab,
  setPalette,
  setSelectedSpace,
  shellStore,
  spaceKeyFromAgent,
  togglePanel,
  visibleTabsForSpace,
  type FrameSection,
} from "./shellStore";
import { IS_MAC, matchShortcut } from "./shortcuts";
import "../styles/shell.css";

const FRAME_ITEMS: Array<{ id: FrameSection; label: string; icon: PaletteItem["icon"] }> = [
  { id: "look", label: "外观", icon: PaletteIcon },
  { id: "keyboard", label: "键盘", icon: Keyboard },
  { id: "machines", label: "电脑与中继", icon: Server },
  { id: "alerts", label: "提醒", icon: Bell },
  { id: "updates", label: "更新", icon: RefreshCw },
  { id: "privacy", label: "隐私", icon: Shield },
  { id: "voice", label: "语音输入", icon: Mic },
  { id: "assistant", label: "小羊助理", icon: Sparkles },
  { id: "browser", label: "浏览器与文件", icon: Globe },
  { id: "performance", label: "性能与资源", icon: Cpu },
  { id: "logs", label: "日志与诊断", icon: ScrollText },
  { id: "about", label: "关于", icon: Info },
];

function measureTerminalGrid(): {
  cols: number;
  rows: number;
  display: Record<string, unknown>;
} {
  const termCfg = clientConfigStore.get().config.terminal;
  const fs = Math.max(9, Number(termCfg.fontSize) || 13);
  const lh = Math.max(1.0, (Number(termCfg.lineHeight) || 135) / 100);
  const cellW = Math.max(5, Math.round(fs * 0.6));
  const cellH = Math.max(10, Math.round(fs * lh));
  const pane =
    (document.querySelector(".v3-main .term-host") as HTMLElement | null) ??
    (document.querySelector(".v3-main") as HTMLElement | null);
  const rect = pane?.getBoundingClientRect();
  const availW = Math.max(320, (rect?.width ?? window.innerWidth - 300) - 24);
  const availH = Math.max(180, (rect?.height ?? window.innerHeight - 100) - 42);
  const cols = Math.min(500, Math.max(40, Math.floor(availW / cellW)));
  const rows = Math.min(200, Math.max(12, Math.floor(availH / cellH)));
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return {
    cols,
    rows,
    display: {
      fg: "#f4eef8",
      bg: "#16141d",
      cursor: "#ff71a8",
      cell: [Math.max(1, Math.round(cellW * dpr)), Math.max(1, Math.round(cellH * dpr))],
    },
  };
}

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
  const showShells = settingsStore.use((s) => s.showShells);
  const theme = settingsStore.use((s) => s.theme);
  const homePage = useClientConfig().browser.homePage;
  const [create, setCreate] = useState<{ host: string | null; space: string | null } | null>(null);
  const [addComputer, setAddComputer] = useState(false);

  const agents = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);
  const hosts = useMemo(() => Object.values(devices).filter((d) => d.kind === "host"), [devices]);
  const newAgent = useCallback((host: string | null = null, space: string | null = null) => setCreate({ host, space }), []);

  const spawnTerminalNow = useCallback(
    async (preferredHost: string | null = null, preferredSpace: string | null = null) => {
      const { devices: devs, agents: agMap } = liveStore.get();
      const all = allAgents(agMap);
      const s = shellStore.get();
      const activeTab = s.tabs.find((t) => t.id === s.active);
      const activeAgent = activeTab && activeTab.kind !== "web" ? all.find((a) => a.key === activeTab.agentKey) : undefined;
      const [selHost, selSpace] = s.selectedSpace ? (s.selectedSpace.split("\u0000") as [string, string]) : [null, null];

      const isOnlineHost = (id: string | null | undefined): id is string =>
        Boolean(id && devs[id]?.kind === "host" && devs[id]?.online);

      const localHostId = isTauri() ? localHostIdStore.get() || (await refreshLocalHostIdFast()) : null;

      const hostId =
        (isOnlineHost(preferredHost) ? preferredHost : null) ??
        (isOnlineHost(selHost) ? selHost : null) ??
        (isOnlineHost(activeAgent?.deviceId) ? activeAgent!.deviceId : null) ??
        Object.values(devs).find((d) => d.kind === "host" && d.online)?.id ??
        (isTauri() && localHostId ? localHostId : undefined);

      if (!hostId) {
        toast("当前没有在线的电脑，无法新建终端", true);
        return;
      }

      const spaceName =
        preferredSpace ??
        (selHost === hostId ? selSpace : null) ??
        (activeAgent?.deviceId === hostId ? agentSpace(activeAgent) ?? null : null);

      const folder =
        (activeAgent?.deviceId === hostId && activeAgent.cwd ? activeAgent.cwd : undefined) ??
        all.find((a) => a.deviceId === hostId && (!spaceName || (agentSpace(a) ?? "") === spaceName) && a.cwd)?.cwd;

      const isLocal = isTauri() && Boolean(localHostId && hostId === localHostId);
      if (isLocal) {
        try {
          let resolvedFolder = folder;
          if (!resolvedFolder && spaceName) {
            const spRes = await rpcCall(hostId, "spaces.list", {}, 1_500).catch(() => null);
            resolvedFolder = spRes?.spaces.find((sp) => sp.name === spaceName)?.folder;
          }
          const grid = measureTerminalGrid();
          const created = await native.localTermCreateShell({
            cwd: resolvedFolder || undefined,
            cols: grid.cols,
            rows: grid.rows,
            display: grid.display,
            spaceName: spaceName || undefined,
          });
          const key = `${hostId}/hc:${created.terminal}`;
          liveStore.set((prev) => {
            const list = prev.agents[hostId] ?? [];
            if (list.some((a) => a.key === key)) return prev;
            const shellAgent: Agent = {
              key,
              deviceId: hostId,
              source: "hc",
              localId: created.terminal,
              harness: "zsh",
              title: "终端",
              where: spaceName || undefined,
              cwd: created.cwd || resolvedFolder || undefined,
              status: "idle",
              statusSince: Date.now(),
              isShell: true,
              updatedAt: Date.now(),
            };
            return { ...prev, agents: { ...prev.agents, [hostId]: [shellAgent, ...list] }, rev: prev.rev + 1 };
          });
          openAgentTab(key, "term");
          return;
        } catch {
          // If local `hc` direct launch failed (e.g. `hc` absent), fall back to daemon RPC below.
        }
      }

      try {
        const spRes = await rpcCall(hostId, "spaces.list", {}, 6_000).catch(() => null);
        const matchedSpace = spaceName ? spRes?.spaces.find((sp) => sp.name === spaceName) : spRes?.spaces[0];
        const spaceId = matchedSpace?.id;
        const resolvedFolder = folder || matchedSpace?.folder || spRes?.folders[0];
        const created = await rpcCall(
          hostId,
          "agent.create",
          {
            space: spaceId || undefined,
            folder: spaceId ? undefined : resolvedFolder || undefined,
            launcher: "shell",
          },
          20_000,
        );
        liveStore.set((prev) => {
          const list = prev.agents[hostId] ?? [];
          if (list.some((a) => a.key === created.agent)) return prev;
          const shellAgent: Agent = {
            key: created.agent,
            deviceId: hostId,
            source: "hc",
            localId: created.terminal,
            harness: "zsh",
            title: "终端",
            where: matchedSpace?.name || spaceName || undefined,
            cwd: resolvedFolder || undefined,
            status: "idle",
            statusSince: Date.now(),
            isShell: true,
            updatedAt: Date.now(),
          };
          return { ...prev, agents: { ...prev.agents, [hostId]: [shellAgent, ...list] }, rev: prev.rev + 1 };
        });
        openAgentTab(created.agent, "term");
      } catch (e) {
        toast((e as Error).message, true);
      }
    },
    [toast],
  );

  // The first time agents arrive with nothing open, open the most urgent one, so the work
  // area shows something useful. Closing every tab afterwards leaves it empty.
  const autoOpened = useRef(tabs.length > 0);
  useEffect(() => {
    if (autoOpened.current || !agents.length) return;
    autoOpened.current = true;
    const pick = [...agents].sort(
      (x, y) => GROUP_RANK[listGroup(x, devices)] - GROUP_RANK[listGroup(y, devices)] || lastChange(y) - lastChange(x),
    )[0];
    if (pick && shellStore.get().tabs.length === 0) openAgentTab(pick.key);
  }, [agents, devices]);

  const isDark = theme === "dark" || (theme === "system" && document.documentElement.getAttribute("data-theme") === "dark");

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];
    const allByAgentKey = allAgents(agentsMap);
    for (const t of tabs) {
      const a = t.kind === "agent" ? allByAgentKey.find((x) => x.key === t.agentKey) : undefined;
      const label = t.kind === "agent" ? (a ? agentTitle(a) : "已结束的 Agent") : t.title === "about:blank" ? "新网页" : t.title;
      list.push({
        id: `tab:${t.id}`,
        group: "标签",
        label: `切到：${label}`,
        hint: t.kind === "file" || t.kind === "diff" ? t.path : t.kind === "web" ? t.url : a ? devices[a.deviceId]?.name : undefined,
        icon: t.kind === "agent" ? SquareStack : t.kind === "file" ? FolderTree : t.kind === "diff" ? GitBranch : Globe,
        terms: label,
        run: () => {
          const map = new Map(allAgents(liveStore.get().agents).map((x) => [x.key, x] as const));
          if (shellStore.get().selectedSpace) setSelectedSpace(null, (k) => map.get(k));
          setActiveTab(t.id);
        },
      });
    }
    list.push(
      { id: "new-terminal", group: "标签", label: "新建终端", keys: ["Mod", "T"], icon: Terminal, terms: "new terminal shell 终端", run: () => void spawnTerminalNow() },
      { id: "new-agent", group: "标签", label: "新建 Agent…", icon: Plus, terms: "new agent claude codex", run: () => newAgent() },
      { id: "new-web", group: "标签", label: "打开网页", icon: Globe, terms: "browser web", run: () => openWebTab(homePage || "about:blank") },
      { id: "close-tab", group: "标签", label: "关闭标签", keys: ["Mod", "W"], icon: X, run: () => closeActive() },
      { id: "next-tab", group: "标签", label: "下一个标签", keys: ["Mod", "Shift", "]"], run: () => cycleTab(1, currentVisibleTabs()) },
      { id: "prev-tab", group: "标签", label: "上一个标签", keys: ["Mod", "Shift", "["], run: () => cycleTab(-1, currentVisibleTabs()) },
      { id: "panel-files", group: "面板", label: "显示或隐藏文件", keys: ["Mod", "J"], icon: FolderTree, terms: "files", run: () => togglePanel("files") },
      { id: "panel-git", group: "面板", label: "显示或隐藏 Git 管理", keys: ["Mod", "Shift", "G"], icon: GitBranch, terms: "git diff commit branch", run: () => togglePanel("git") },
      { id: "panel-browser", group: "面板", label: "显示或隐藏浏览器", icon: Globe, run: () => togglePanel("browser") },
      { id: "panel-assistant", group: "面板", label: "和小羊说话", keys: ["Mod", "Shift", "A"], icon: Sparkles, terms: "assistant 助理", run: () => togglePanel("assistant") },
      { id: "sidebar", group: "面板", label: collapsed ? "展开侧栏" : "收起侧栏", keys: ["Mod", "B"], icon: PanelLeft, run: onToggleSidebar },
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
        run: () => {
          const s = shellStore.get();
          const map = new Map(allAgents(liveStore.get().agents).map((x) => [x.key, x] as const));
          if (s.selectedSpace && s.selectedSpace !== spaceKeyFromAgent(a)) {
            setSelectedSpace(null, (k) => map.get(k));
          }
          openAgentTab(a.key);
        },
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
    return visibleTabsForSpace(s.tabs, s.selectedSpace, (k) => map.get(k));
  }

  function closeActive() {
    const s = shellStore.get();
    const map = new Map(allAgents(liveStore.get().agents).map((x) => [x.key, x] as const));
    const activeId = activeTabIdForSpace(s, (k) => map.get(k));
    const t = s.tabs.find((x) => x.id === activeId);
    if (t) closeShellTab(t);
  }

  // Window shortcuts (shell/shortcuts.ts). On Windows a focused terminal box keeps its Ctrl keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const id = matchShortcut(e);
      if (!id) return;
      if (!IS_MAC && terminalOwnsCtrlK(e.target)) return;
      const s = shellStore.get();
      // Another dialog on top (pairing, a confirm): only the palette and settings toggles pass.
      const dialogUp = Boolean(document.querySelector("[role=dialog][data-state=open]")) && !s.settings && !s.palette;
      if (dialogUp && id !== "palette" && id !== "settings") return;
      e.preventDefault();
      switch (id) {
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
  }, [canToggleSidebar, onToggleSidebar, spawnTerminalNow]);

  return (
    <div className={`v3${collapsed ? " collapsed" : ""}`}>
      <ShellSidebar
        collapsed={collapsed}
        canToggle={canToggleSidebar}
        onToggle={onToggleSidebar}
        onConnectRelay={onConnectRelay}
        onPairPhone={onPairPhone}
        onNewAgent={newAgent}
      />
      <div className="v3-work">
        <ShellTabs onNewTerminal={() => void spawnTerminalNow()} onNewAgent={() => newAgent()} padForLights={collapsed} />
        <div className="v3-body">
          <ShellMain onNewTerminal={() => void spawnTerminalNow()} onNewAgent={() => newAgent()} />
          <ShellPanel />
          <PeekOverlay />
        </div>
        <ShellStatus onConnectRelay={onConnectRelay} />
      </div>

      <Palette mode={palette} onClose={() => setPalette(false)} items={items} />
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
        onCreated={(key) => {
          openAgentTab(key);
          refreshHostSpaces();
          toast("已创建并打开 Agent");
        }}
      />
      <AddDeviceModal open={addComputer} onOpenChange={setAddComputer} />
    </div>
  );
}
