import { Suspense, lazy, useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AppWindow,
  Bell,
  Cpu,
  FileDown,
  Info,
  Keyboard,
  Mic,
  Palette,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { overlayStore, useToast } from "../../components/PocketUI";
import { VoiceInputSetup } from "../../components/VoiceInput";
import { appVersion, detectPlatform } from "../../lib/bridge";
import { native } from "../../lib/native";
import { isMockServer } from "../../lib/mock";
import { liveStore, settingsStore } from "../../lib/store";
import { updateStore } from "../../lib/updates";
import { closeSettingsFrame, openSettingsFrame, shellStore, type FrameSection } from "../../shell/shellStore";
import { AboutPane, BrowserPane, NotificationsPane, PerformancePane, UpdatesPane } from "./Panes";
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

type Item = { id: FrameSection; title: string; icon: ComponentType<{ size?: number }> };

/** Herdr's sections first, then ours (docs/design/desktop-v2.md, "设置"). */
const HERDR_ORDER: Item[] = [
  { id: "look", title: "外观", icon: Palette },
  { id: "keyboard", title: "键盘", icon: Keyboard },
  { id: "machines", title: "电脑与中继", icon: Server },
  { id: "alerts", title: "提醒", icon: Bell },
  { id: "updates", title: "更新", icon: RefreshCw },
  { id: "privacy", title: "隐私", icon: Shield },
];
const OURS: Item[] = [
  { id: "voice", title: "语音输入", icon: Mic },
  { id: "assistant", title: "小羊助理", icon: Sparkles },
  { id: "browser", title: "浏览器与文件", icon: AppWindow },
  { id: "performance", title: "性能与资源", icon: Cpu },
  { id: "logs", title: "日志与诊断", icon: ScrollText },
  { id: "about", title: "关于", icon: Info },
];
const ALL = [...HERDR_ORDER, ...OURS];

/**
 * Settings as a modal frame over the window, after Herdr's: a section list on the left, one
 * scrolling page on the right, changes applied at once. Esc, the backdrop and × close it.
 */
export function SettingsFrame({ onPairPhone, onConnectRelay, onAddComputer, onReopenGuide }: SettingsFrameProps) {
  const toast = useToast();
  const section = shellStore.use((s) => s.settings);
  const updateReady = updateStore.use((s) => Boolean(s.info?.hasUpdate));
  const open = section !== null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // Kept while the frame is closed, so 小羊助理 reopens on the same sub-tab.
  const [assistantTab, setAssistantTab] = useState<AssistantTab>("models");

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
        <Icon size={16} />
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
            <PaneTitle title="语音输入" about="在任何应用里按快捷键说话，文字自动打进光标处。" />
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

  const title = ALL.find((s) => s.id === section)?.title ?? "设置";

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && closeSettingsFrame()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sf-backdrop" />
        <Dialog.Content
          className="settings-frame"
          aria-describedby={undefined}
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
            <div className="sf-nav-list">
              {HERDR_ORDER.map(navButton)}
              <div className="sf-nav-sep" role="separator" />
              {OURS.map(navButton)}
            </div>
            <button className="sf-outline-btn" disabled={!native.available()} onClick={() => void exportDiagnostics()}>
              <FileDown size={14} />
              <span>导出诊断</span>
            </button>
          </nav>
          <div className="sf-main" style={{ flexDirection: "column" }}>
            <div
              style={{
                flex: "0 0 auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 14px 10px 28px",
                borderBottom: "1px solid var(--divider)",
                background: "var(--surface)",
              }}
            >
              <span
                style={{
                  fontSize: "calc(14px * var(--ts, 1))",
                  fontWeight: 700,
                  lineHeight: 1.4,
                  color: "var(--ink)",
                }}
              >
                {title}
              </span>
              <Dialog.Close className="sf-close" aria-label="关闭设置" style={{ position: "static" }}>
                <X size={15} />
              </Dialog.Close>
            </div>
            <div className="sf-body" ref={bodyRef} role="region" aria-label={title} tabIndex={-1} style={{ minHeight: 0 }}>
              <div className="sf-page" style={{ paddingTop: 18 }}>
                {pane}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
