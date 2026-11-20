import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BookOpen,
  Cpu,
  FolderTree,
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
  X,
} from "lucide-react";
import { VendorIcon } from "../components/MascotAndVendor";
import { AddDeviceModal } from "../views/DevicesView";
import { CreateAgentModal } from "../views/AgentsView";
import { SettingsFrame } from "../views/settings/SettingsFrame";
import { useClientConfig } from "../lib/config";
import { useToast } from "../components/PocketUI";
import { allAgents, liveStore, settingsStore, spacedTitle, updateSettings, agentTitle } from "../lib/store";
import { terminalOwnsCtrlK } from "../lib/termKeys";
import { GROUP_RANK, lastChange, listGroup } from "./agentInfo";
import { Palette, type PaletteItem } from "./Palette";
import { ShellSidebar } from "./ShellSidebar";
import { PeekOverlay, ShellMain, ShellPanel, ShellStatus, ShellTabs, closeShellTab } from "./ShellWork";
import {
  closeSettingsFrame,
  cycleTab,
  openAgentTab,
  openSettingsFrame,
  openWebTab,
  setActiveTab,
  setPalette,
  shellStore,
  togglePanel,
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
    for (const t of tabs) {
      const a = t.kind === "agent" ? agents.find((x) => x.key === t.agentKey) : undefined;
      const label = t.kind === "agent" ? (a ? agentTitle(a) : "已结束的 Agent") : t.title === "about:blank" ? "新网页" : t.title;
      list.push({
        id: `tab:${t.id}`,
        group: "标签",
        label: `切到：${label}`,
        hint: t.kind === "file" ? t.path : t.kind === "web" ? t.url : a ? devices[a.deviceId]?.name : undefined,
        icon: t.kind === "agent" ? SquareStack : t.kind === "file" ? FolderTree : Globe,
        terms: label,
        run: () => setActiveTab(t.id),
      });
    }
    list.push(
      { id: "new-agent", group: "标签", label: "新建 Agent", keys: ["Mod", "T"], icon: Plus, terms: "new agent", run: () => newAgent() },
      { id: "new-web", group: "标签", label: "打开网页", icon: Globe, terms: "browser web", run: () => openWebTab(homePage || "about:blank") },
      { id: "close-tab", group: "标签", label: "关闭标签", keys: ["Mod", "W"], icon: X, run: () => closeActive() },
      { id: "next-tab", group: "标签", label: "下一个标签", keys: ["Mod", "Shift", "]"], run: () => cycleTab(1) },
      { id: "prev-tab", group: "标签", label: "上一个标签", keys: ["Mod", "Shift", "["], run: () => cycleTab(-1) },
      { id: "panel-files", group: "面板", label: "显示或隐藏文件", keys: ["Mod", "J"], icon: FolderTree, terms: "files", run: () => togglePanel("files") },
      { id: "panel-browser", group: "面板", label: "显示或隐藏浏览器", icon: Globe, run: () => togglePanel("browser") },
      { id: "panel-assistant", group: "面板", label: "和小羊说话", keys: ["Mod", "Shift", "A"], icon: Sparkles, terms: "assistant 助理", run: () => togglePanel("assistant") },
      { id: "sidebar", group: "面板", label: collapsed ? "展开侧栏" : "收起侧栏", keys: ["Mod", "B"], icon: PanelLeft, run: onToggleSidebar },
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
    return list;
    // closeActive reads the store when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, collapsed, devices, homePage, isDark, newAgent, onConnectRelay, onPairPhone, onReopenGuide, onToggleSidebar, tabs]);

  function closeActive() {
    const s = shellStore.get();
    const t = s.tabs.find((x) => x.id === s.active);
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
          newAgent();
          break;
        case "closeTab":
          closeActive();
          break;
        case "nextTab":
          cycleTab(1);
          break;
        case "prevTab":
          cycleTab(-1);
          break;
        case "toggleSidebar":
          if (canToggleSidebar) onToggleSidebar();
          break;
        case "togglePanel":
          togglePanel("files");
          break;
        case "assistant":
          togglePanel("assistant");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canToggleSidebar, newAgent, onToggleSidebar]);

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
        <ShellTabs onNewAgent={() => newAgent()} padForLights={collapsed} />
        <div className="v3-body">
          <ShellMain onNewAgent={() => newAgent()} />
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
          toast("已创建并打开 Agent");
        }}
      />
      <AddDeviceModal open={addComputer} onOpenChange={setAddComputer} />
    </div>
  );
}
