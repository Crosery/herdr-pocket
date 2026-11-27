import { Suspense, lazy, useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AppWindow,
  Bell,
  Blocks,
  Cpu,
  FileDown,
  GraduationCap,
  Info,
  Keyboard,
  Mic,
  Palette,
  RefreshCw,
  ScrollText,
  Search,
  Server,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { overlayStore, useToast } from "../../components/PocketUI";
import { openInteractiveTutorialReplay } from "../../components/TutorialSandboxStage";
import { VoiceInputSetup } from "../../components/VoiceInput";
import { appVersion, detectPlatform, isH5Web } from "../../lib/bridge";
import { native } from "../../lib/native";
import { isMockServer } from "../../lib/mock";
import { liveStore, settingsStore } from "../../lib/store";
import { updateStore } from "../../lib/updates";
import { closeSettingsFrame, openSettingsFrame, shellStore, type FrameSection } from "../../shell/shellStore";
import { AboutPane, BrowserPane, NotificationsPane, PerformancePane, UpdatesPane } from "./Panes";
import { PluginsPane } from "./PluginsPane";
import { KeyboardPane, LookPane, MachinesPane, PrivacyPane } from "./FramePanes";
import { LogsPane } from "./LogsPane";
import { PaneTitle } from "./rows";
import type { AssistantTab } from "./AssistantSettings";
import "../../styles/settings-frame.css";

// The model settings are the heaviest pane: loaded on first visit.
const AssistantSettings = lazy(() => import("./AssistantSettings").then((m) => ({ default: m.AssistantSettings })));

export interface SettingsFrameProps {
  onPairPhone: () => void;
  onConnectRelay: () => void;
  onAddComputer: () => void;
  onReopenGuide: () => void;
}

type Item = { id: FrameSection; title: string; subtitle: string; keys: string; icon: ComponentType<{ size?: number }> };

const NAV_GROUPS: Array<{ label: string; items: Item[] }> = [
  {
    label: "基础",
    items: [
      { id: "look", title: "外观", subtitle: "主题、字号、对话密度与侧边栏样式", keys: "主题 浅色 暗色 字号 字体 终端 侧边栏 小窗 theme font", icon: Palette },
      { id: "keyboard", title: "键盘", subtitle: "全局快捷键与操作热键", keys: "快捷键 热键 shortcut keybind", icon: Keyboard },
      { id: "machines", title: "电脑与中继", subtitle: "本机服务、远程桌面、手机配对与空间同步", keys: "主机 设备 扫码 空间同步 迁移 中转 服务器 relay host", icon: Server },
      { id: "alerts", title: "提醒", subtitle: "桌面通知与任务完成提示音", keys: "通知 提示音 静音 alert sound", icon: Bell },
      { id: "updates", title: "更新", subtitle: "桌面端与本机工具版本检查", keys: "版本 镜像 组件 升级 update", icon: RefreshCw },
      { id: "privacy", title: "隐私", subtitle: "系统权限与本地数据边界", keys: "权限 脱敏 隐私 privacy", icon: Shield },
    ],
  },
  {
    label: "小羊与扩展",
    items: [
      { id: "voice", title: "语音唤醒与声纹", subtitle: "本地降噪、人声增强、声纹过滤与实时试听", keys: "降噪 主动降噪 人声 响度 清晰度 声纹 耳返 试听 过滤 通话 voice", icon: Mic },
      { id: "assistant", title: "小羊助理", subtitle: "多端同步，模型、服务商与提示词改完即时生效", keys: "文字模型 服务商 扫描 音色 提示词 assistant model provider", icon: Sparkles },
      { id: "plugins", title: "插件中心", subtitle: "按需开启的浏览器、Webhook 与巡检能力", keys: "浏览器 Webhook 巡检 plugin", icon: Blocks },
    ],
  },
  {
    label: "系统",
    items: [
      { id: "browser", title: "浏览器与文件", subtitle: "内置浏览器主页、Cookie 导入与文件树选项", keys: "主页 Cookie 隐藏文件 browser", icon: AppWindow },
      { id: "performance", title: "性能与资源", subtitle: "内存占用、帧率与省电策略", keys: "省电 内存 CPU 缓存 perf", icon: Cpu },
      { id: "logs", title: "日志与诊断", subtitle: "客户端与中继运行日志排查", keys: "导出 服务器日志 诊断 log", icon: ScrollText },
      { id: "about", title: "关于", subtitle: "版本信息、配置路径与新手引导", keys: "版本 配置文件 新手引导 about", icon: Info },
    ],
  },
];
const ALL: Item[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * Settings as a modal frame over the window, after Herdr's: a section list on the left, one
 * scrolling page on the right, changes applied at once. Esc, the backdrop and × close it.
 */
export function SettingsFrame({ onPairPhone, onConnectRelay, onAddComputer, onReopenGuide }: SettingsFrameProps) {
  const toast = useToast();
  const section = shellStore.use((s) => s.settings);
  const updateReady = updateStore.use((s) => !isH5Web() && Boolean(s.info?.hasUpdate));
  const open = section !== null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // Kept while the frame is closed, so 小羊助理 reopens on the same sub-tab.
  const [assistantTab, setAssistantTab] = useState<AssistantTab>("models");
  const [navQuery, setNavQuery] = useState("");

  // The built-in browser is a native view drawn above the page: it hides while this is open.
  useEffect(() => {
    if (!open) return;
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
  }, [open]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    // Opened elsewhere (palette, a link in a page): keep keyboard focus on the selected item.
    const nav = navRef.current;
    if (nav && nav.contains(document.activeElement)) nav.querySelector<HTMLButtonElement>(".sf-nav-item.active")?.focus();
  }, [section]);

  const exportDiagnostics = async () => {
    try {
      const server = settingsStore.get().server;
      const path = await native.exportDiagnostics({
        app: appVersion(),
        platform: detectPlatform(),
        link: liveStore.get().link,
        server: server && !isMockServer(server) ? server : null,
      });
      toast(`已导出：${path}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  // Arrow keys walk the section list, like a listbox.
  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = ALL.findIndex((s) => s.id === section);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? ALL.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + ALL.length) % ALL.length;
    openSettingsFrame(ALL[next]!.id);
    navRef.current?.querySelector<HTMLButtonElement>(`[data-section="${ALL[next]!.id}"]`)?.focus();
  };

  const navButton = (s: Item) => {
    const Icon = s.icon;
    const on = s.id === section;
    return (
      <button
        key={s.id}
        data-section={s.id}
        className={`sf-nav-item${on ? " active" : ""}`}
        aria-current={on ? "page" : undefined}
        tabIndex={on ? 0 : -1}
        onClick={() => openSettingsFrame(s.id)}
      >
        <Icon size={15} />
        <span className="grow truncate">{s.title}</span>
        {s.id === "updates" && updateReady ? <span className="sf-update-dot" aria-label="有新版本" /> : null}
      </button>
    );
  };

  const pane = (() => {
    switch (section) {
      case "look":
        return <LookPane />;
      case "keyboard":
        return <KeyboardPane />;
      case "machines":
        return <MachinesPane onConnectRelay={onConnectRelay} onPairPhone={onPairPhone} onAddComputer={onAddComputer} />;
      case "alerts":
        return <NotificationsPane />;
      case "updates":
        return <UpdatesPane />;
      case "privacy":
        return <PrivacyPane />;
      case "voice":
        return (
          <div className="pane">
            <PaneTitle title="语音唤醒与声纹" about="全局快捷键一键发起或挂断小羊实时语音通话，并配置本地降噪与声纹识别" />
            <VoiceInputSetup />
          </div>
        );
      case "assistant":
        return (
          // AssistantSettings says where these live itself, per sub-tab.
          <div className="pane">
            <Suspense fallback={<div className="faint">正在打开…</div>}>
              <AssistantSettings subTab={assistantTab} onSubTab={setAssistantTab} />
            </Suspense>
          </div>
        );
      case "plugins":
        return <PluginsPane />;
      case "browser":
        return <BrowserPane />;
      case "performance":
        return <PerformancePane />;
      case "logs":
        return <LogsPane />;
      case "about":
        return <AboutPane onReopenGuide={onReopenGuide} />;
      default:
        return null;
    }
  })();

  const currentItem = ALL.find((s) => s.id === section);
  const title = currentItem?.title ?? "设置";
  const subtitle = currentItem?.subtitle ?? "";
  const q = navQuery.trim().toLowerCase();
  const filteredGroups = NAV_GROUPS.map((g) => ({
    label: g.label,
    items: g.items.filter(
      (it) =>
        !q ||
        it.title.toLowerCase().includes(q) ||
        it.subtitle.toLowerCase().includes(q) ||
        it.keys.toLowerCase().includes(q),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && closeSettingsFrame()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sf-backdrop" />
        <Dialog.Content
          className="settings-frame"
          data-tour="settings-frame"
          aria-describedby={undefined}
          onPointerDownOutside={(e) => {
            if ((e.target as HTMLElement | null)?.closest?.('[data-tour-ui="true"]')) {
              e.preventDefault();
            }
          }}
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement | null)?.closest?.('[data-tour-ui="true"]')) {
              e.preventDefault();
            }
          }}
          onFocusOutside={(e) => {
            if ((e.target as HTMLElement | null)?.closest?.('[data-tour-ui="true"]')) {
              e.preventDefault();
            }
          }}
          onEscapeKeyDown={(e) => {
            const target = e.target as HTMLElement | null;
            if (target?.dataset?.escapeLocal === "true") {
              e.preventDefault();
            }
          }}
          onOpenAutoFocus={(e) => {
            // Start on the selected section, not on the first control of the page.
            e.preventDefault();
            navRef.current?.querySelector<HTMLButtonElement>(".sf-nav-item.active")?.focus();
          }}
        >
          <nav className="sf-nav" ref={navRef} aria-label="设置分类" onKeyDown={onNavKey}>
            <Dialog.Title className="sf-title">设置</Dialog.Title>
            <div className="sf-search-wrap">
              <Search size={12} className="sf-search-ic" aria-hidden />
              <input
                type="text"
                className="sf-search-input"
                value={navQuery}
                onChange={(e) => setNavQuery(e.target.value)}
                placeholder="搜索设置…"
                aria-label="搜索设置项"
              />
            </div>
            <div className="sf-nav-list">
              {filteredGroups.length ? (
                filteredGroups.map((g, gi) => (
                  <div key={g.label} className="sf-nav-group">
                    {gi > 0 ? <div className="sf-nav-sep" role="separator" /> : null}
                    <div className="sf-nav-group-label">{g.label}</div>
                    {g.items.map(navButton)}
                  </div>
                ))
              ) : (
                <div className="faint" style={{ padding: "10px 8px", fontSize: 12 }}>
                  未找到匹配项
                </div>
              )}
            </div>
            <div className="sf-nav-footer">
              <button
                type="button"
                className="sf-outline-btn"
                title="重温新手引导"
                onClick={() => {
                  closeSettingsFrame();
                  openInteractiveTutorialReplay();
                }}
              >
                <GraduationCap size={13} />
                <span>引导</span>
              </button>
              <button
                type="button"
                className="sf-outline-btn"
                title="导出诊断信息"
                disabled={!native.available()}
                onClick={() => void exportDiagnostics()}
              >
                <FileDown size={13} />
                <span>诊断</span>
              </button>
            </div>
          </nav>
          <div className="sf-main" style={{ flexDirection: "column" }}>
            <div className="sf-main-head">
              <div className="sf-main-head-left">
                <span className="sf-main-head-title">{title}</span>
                {subtitle ? <span className="sf-main-head-sub truncate">{subtitle}</span> : null}
              </div>
              <Dialog.Close className="sf-close" aria-label="关闭设置" style={{ position: "static" }}>
                <X size={15} />
              </Dialog.Close>
            </div>
            <div className="sf-body tinted" ref={bodyRef} role="region" aria-label={title} tabIndex={-1} style={{ minHeight: 0 }}>
              <div className="sf-page" style={{ paddingTop: 16 }}>
                {pane}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
