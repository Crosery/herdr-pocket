import { useState, type ComponentType } from "react";
import { AppWindow, Bell, ChevronLeft, ChevronRight, Cpu, Info, Link2, Mic, RefreshCw, ScrollText, Settings2, Sparkles } from "lucide-react";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import { PocketBadge } from "../components/PocketUI";
import { serverLabel } from "../components/Sidebar";
import { VoiceInputSetup } from "../components/VoiceInput";
import { isTauri } from "../lib/bridge";
import { liveStore, settingsStore } from "../lib/store";
import { updateStore } from "../lib/updates";
import { AssistantSettings, type AssistantTab } from "./settings/AssistantSettings";
import { AboutPane, BrowserPane, ConnectionPane, GeneralPane, NotificationsPane, PerformancePane, UpdatesPane, linkLabel } from "./settings/Panes";
import { LogsPane } from "./settings/LogsPane";
import { PaneTitle } from "./settings/rows";

export type SettingsSection =
  | "general"
  | "connection"
  | "voice"
  | "notifications"
  | "assistant"
  | "browser"
  | "updates"
  | "performance"
  | "logs"
  | "about";

const SECTIONS: Array<{ id: SettingsSection; title: string; icon: ComponentType<{ size?: number }> }> = [
  { id: "general", title: "通用", icon: Settings2 },
  { id: "connection", title: "连接", icon: Link2 },
  { id: "voice", title: "语音唤醒与声纹", icon: Mic },
  { id: "notifications", title: "通知", icon: Bell },
  { id: "assistant", title: "小羊助理", icon: Sparkles },
  { id: "browser", title: "浏览器与文件", icon: AppWindow },
  { id: "updates", title: "更新", icon: RefreshCw },
  { id: "performance", title: "性能与资源", icon: Cpu },
  { id: "logs", title: "日志与诊断", icon: ScrollText },
  { id: "about", title: "关于", icon: Info },
];

const DESKTOP_ONLY_SECTIONS: ReadonlySet<SettingsSection> = new Set(["voice", "browser", "performance"]);

/**
 * Settings after Herdr's: a category list and one pane; changes apply at once and go to
 * config.json where the key lives there (docs/design/desktop-v2.md section 4).
 */
export function SettingsView({
  section,
  onSection,
  mobileLayout,
  onPairPhone,
  onConnectRelay,
  onReopenGuide,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  mobileLayout: boolean;
  onPairPhone: () => void;
  onConnectRelay: () => void;
  onReopenGuide: () => void;
}) {
  const [assistantTab, setAssistantTab] = useState<AssistantTab>("models");
  // Narrow windows show the list first, then one pane with a way back.
  const [mobilePane, setMobilePane] = useState(false);
  const updateReady = updateStore.use((s) => Boolean(s.info?.hasUpdate));
  const server = settingsStore.use((s) => s.server);
  const deviceName = settingsStore.use((s) => s.deviceName);
  const link = liveStore.use((s) => s.link);
  const { tone: linkTone, text: linkText } = linkLabel(link);

  const visibleSections = isTauri() ? SECTIONS : SECTIONS.filter((s) => !DESKTOP_ONLY_SECTIONS.has(s.id));
  const activeSection: SettingsSection = visibleSections.some((s) => s.id === section) ? section : "general";

  const pane = (() => {
    switch (activeSection) {
      case "general":
        return <GeneralPane onReopenGuide={onReopenGuide} />;
      case "connection":
        return <ConnectionPane onConnectRelay={onConnectRelay} onPairPhone={onPairPhone} />;
      case "voice":
        return (
          <div className="pane">
            <PaneTitle title="语音唤醒与声纹" about="全局快捷键一键发起或挂断小羊实时语音通话，并配置本地降噪与声纹识别" />
            <VoiceInputSetup />
          </div>
        );
      case "notifications":
        return <NotificationsPane />;
      case "assistant":
        return (
          <div className="pane">
            <PaneTitle title="小羊助理" about="多端共享配置" />
            <AssistantSettings subTab={assistantTab} onSubTab={setAssistantTab} />
          </div>
        );
      case "browser":
        return <BrowserPane />;
      case "updates":
        return <UpdatesPane />;
      case "performance":
        return <PerformancePane />;
      case "logs":
        return <LogsPane />;
      case "about":
        return <AboutPane />;
    }
  })();

  const nav = (
    <nav className="settings-nav" aria-label="设置分类">
      <div className="settings-nav-title cute-font">设置</div>
      {visibleSections.map((s) => {
        const Icon = s.icon;
        const on = s.id === activeSection;
        return (
          <button
            key={s.id}
            className={`settings-nav-item${on && !mobileLayout ? " active" : ""}`}
            aria-current={on ? "page" : undefined}
            onClick={() => {
              onSection(s.id);
              setMobilePane(true);
            }}
          >
            <Icon size={16} />
            <span className="grow truncate">{s.title}</span>
            {s.id === "updates" && updateReady ? <span className="update-dot" aria-label="有新版本" /> : null}
            {mobileLayout ? <ChevronRight size={16} /> : null}
          </button>
        );
      })}
    </nav>
  );

  if (mobileLayout) {
    return (
      <div className="mobile-scroll settings-mobile">
        {mobilePane ? (
          <>
            <button className="back-link" onClick={() => setMobilePane(false)}>
              <ChevronLeft size={16} />
              <span>设置</span>
            </button>
            {pane}
          </>
        ) : (
          <>
            <div className="settings-mobile-hero">
              <XiaoyangOrb mood={link === "online" ? "yay" : "hello"} size={44} />
              <div className="settings-mobile-hero-meta">
                <div className="settings-mobile-hero-name truncate">{deviceName || "Herdr Pocket"}</div>
                <div className="faint truncate">{server ? serverLabel(server) : "未连接服务器"}</div>
              </div>
              <PocketBadge tone={linkTone} pulse={link === "connecting"}>
                {linkText}
              </PocketBadge>
            </div>
            {nav}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="settings-shell">
      {nav}
      <div className="settings-pane-scroll">{pane}</div>
    </div>
  );
}
