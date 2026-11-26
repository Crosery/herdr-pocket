import { useState } from "react";
import { ChevronLeft, ChevronRight, GraduationCap, Link2, LogOut, QrCode, RefreshCw, ScrollText, Sparkles } from "lucide-react";
import type { PortalDisplayMode } from "@herdr-pocket/protocol";
import { PROTOCOL_VERSION } from "@herdr-pocket/protocol";
import { H5InstallAppCard } from "../components/H5InstallAppCard";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import { PocketButton, PocketIconButton, PocketModal, PocketSwitch, fs } from "../components/PocketUI";
import { openInteractiveTutorialReplay } from "../components/TutorialSandboxStage";
import { serverLabel } from "../components/Sidebar";
import { appVersion, isH5Web } from "../lib/bridge";
import { signOut } from "../lib/relay";
import { liveStore, settingsStore, updateSettings, type ThemeChoice } from "../lib/store";
import { updateStore } from "../lib/updates";
import { AssistantSettings, type AssistantTab } from "../views/settings/AssistantSettings";
import { LogsPane } from "../views/settings/LogsPane";
import { UpdatesPane } from "../views/settings/Panes";

type SubPane = "assistant" | "updates" | "logs" | null;

const LINK_LABELS: Record<string, string> = {
  idle: "未连接",
  connecting: "正在连接…",
  online: "已连接",
  offline: "断开重连中",
  unauthorized: "授权失效",
};

const SCALES = [
  { value: 0.85, label: "小", glyph: 12 },
  { value: 1, label: "标准", glyph: 15 },
  { value: 1.15, label: "大", glyph: 18 },
  { value: 1.3, label: "特大", glyph: 21 },
] as const;

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const PORTAL_MODES: Array<{ value: PortalDisplayMode; label: string }> = [
  { value: "collapsed", label: "默认收起" },
  { value: "fan", label: "叠牌露头" },
  { value: "tile", label: "平铺" },
  { value: "cascade", label: "叠列" },
];

export function MobileSettingsTab({
  onPairPhone,
  onConnectRelay,
  onSubPaneChange,
}: {
  onPairPhone: () => void;
  onConnectRelay: () => void;
  onSubPaneChange?: (open: boolean) => void;
}) {
  const server = settingsStore.use((s) => s.server);
  const deviceName = settingsStore.use((s) => s.deviceName);
  const theme = settingsStore.use((s) => s.theme);
  const textScale = settingsStore.use((s) => s.textScale);
  const portalDisplayMode = settingsStore.use((s) => s.portalDisplayMode);
  const showShells = settingsStore.use((s) => s.showShells);
  const link = liveStore.use((s) => s.link);
  const rttMs = liveStore.use((s) => s.rttMs);
  const hasUpdate = updateStore.use((s) => !isH5Web() && Boolean(s.info?.hasUpdate));

  const [subPane, setSubPaneState] = useState<SubPane>(null);
  const [assistantTab, setAssistantTab] = useState<AssistantTab>("models");
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const openSubPane = (pane: SubPane) => {
    setSubPaneState(pane);
    onSubPaneChange?.(pane !== null);
  };

  if (subPane) {
    const title =
      subPane === "assistant" ? "小羊助理设置" : subPane === "updates" ? "组件与版本更新" : "运行日志与诊断";
    return (
      <div className="mp-detail-root">
        <div className="mp-detail-header">
          <div className="mp-detail-top">
            <PocketIconButton size="sm" tooltip="返回设置" onClick={() => openSubPane(null)}>
              <ChevronLeft size={18} />
            </PocketIconButton>
            <div className="grow truncate" style={{ fontWeight: 800, fontSize: fs(16) }}>{title}</div>
          </div>
        </div>
        <div className="mp-scroll">
          {subPane === "assistant" ? <AssistantSettings subTab={assistantTab} onSubTab={setAssistantTab} /> : null}
          {subPane === "updates" ? <UpdatesPane /> : null}
          {subPane === "logs" ? <LogsPane /> : null}
        </div>
      </div>
    );
  }

  const dotColor = link === "online" ? "#3FB68B" : link === "connecting" ? "var(--mp-lavender)" : "var(--mp-error)";

  return (
    <div className="mp-scroll">
      <h1 className="cute-font mp-page-title">设置</h1>
      <div className="mp-page-sub">让小羊更合你心意</div>

      {/* Hero Profile Card */}
      <div className="mp-settings-hero">
        <div className="row" style={{ gap: 12 }}>
          <XiaoyangOrb mood={link === "online" ? "hello" : "waiting"} size={52} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 800, fontSize: fs(17) }}>{deviceName}</div>
            <div className="faint truncate" style={{ fontSize: fs(12.5) }}>{serverLabel(server)}</div>
            <div className="row" style={{ gap: 6, marginTop: 4, fontSize: fs(12.5) }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: dotColor, display: "inline-block" }} />
              <span style={{ fontWeight: 700 }}>{LINK_LABELS[link] ?? link}</span>
              {typeof rttMs === "number" && rttMs > 0 ? (
                <span className="faint num">· {rttMs} ms</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <PocketButton size="sm" variant="soft" onClick={onPairPhone}>
            <QrCode size={14} />
            配对其他设备
          </PocketButton>
          <PocketButton size="sm" variant="ghost" onClick={onConnectRelay}>
            <Link2 size={14} />
            切换服务器
          </PocketButton>
        </div>
      </div>

      {/* Assistant Config */}
      <div className="mp-section-head"><span>小羊助理</span></div>
      <div className="mp-card-list">
        <button type="button" className="mp-setting-row" onClick={() => openSubPane("assistant")}>
          <div className="row" style={{ gap: 10 }}>
            <Sparkles size={18} style={{ color: "var(--mp-accent-text)" }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: fs(14.5) }}>模型、音色与提示词</div>
              <div className="faint" style={{ fontSize: fs(12) }}>多端共享配置</div>
            </div>
          </div>
          <ChevronRight size={16} className="faint" />
        </button>
      </div>

      {/* Appearance */}
      <div className="mp-section-head"><span>外观与显示</span></div>
      <div className="mp-card stack" style={{ gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: fs(13.5), marginBottom: 8 }}>主题风格</div>
          <div className="mp-seg" role="tablist" aria-label="主题切换">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={theme === t.value}
                className={`mp-seg-btn${theme === t.value ? " active" : ""}`}
                onClick={() => updateSettings({ theme: t.value })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 700, fontSize: fs(13.5), marginBottom: 8 }}>文字大小</div>
          <div className="mp-scale-grid">
            {SCALES.map((sc) => {
              const active = Math.abs(textScale - sc.value) < 0.04;
              return (
                <button
                  key={sc.value}
                  type="button"
                  className={`mp-scale-tile${active ? " active" : ""}`}
                  onClick={() => updateSettings({ textScale: sc.value })}
                >
                  <span style={{ fontSize: sc.glyph, fontWeight: 800, lineHeight: 1.1 }}>A</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700 }}>{sc.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 700, fontSize: fs(13.5), marginBottom: 8 }}>跨端小窗默认显示</div>
          <div className="mp-seg" role="tablist" aria-label="跨端小窗默认显示">
            {PORTAL_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="tab"
                aria-selected={portalDisplayMode === m.value}
                className={`mp-seg-btn${portalDisplayMode === m.value ? " active" : ""}`}
                onClick={() => updateSettings({ portalDisplayMode: m.value })}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="between" style={{ paddingTop: 4, borderTop: "1px solid var(--mp-divider)" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: fs(14) }}>显示普通终端</div>
            <div className="faint" style={{ fontSize: fs(12) }}>在 Agents 列表包含非 AI 的 Shell 终端</div>
          </div>
          <PocketSwitch
            checked={showShells}
            onCheckedChange={(v) => updateSettings({ showShells: v })}
            label="显示普通终端"
          />
        </div>
      </div>

      {/* Components & Diagnostics */}
      <div className="mp-section-head"><span>更新与诊断</span></div>
      <div className="mp-card-list">
        <button type="button" className="mp-setting-row" onClick={() => openSubPane("updates")}>
          <div className="row" style={{ gap: 10 }}>
            <RefreshCw size={17} />
            <div>
              <div style={{ fontWeight: 700, fontSize: fs(14.5) }}>
                {isH5Web() ? "版本与电脑端组件" : "检查更新与电脑端组件"}
              </div>
              <div className="faint" style={{ fontSize: fs(12) }}>
                {isH5Web()
                  ? `当前版本 v${appVersion()} · 随中转服务器自动更新`
                  : hasUpdate
                    ? "发现新版本可用"
                    : `当前版本 v${appVersion()} · 协议 v${PROTOCOL_VERSION}`}
              </div>
            </div>
          </div>
          <ChevronRight size={16} className="faint" />
        </button>
        <button type="button" className="mp-setting-row" onClick={() => openInteractiveTutorialReplay()}>
          <div className="row" style={{ gap: 10 }}>
            <GraduationCap size={17} style={{ color: "var(--mp-accent-text)" }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: fs(14.5) }}>重温互动教程</div>
              <div className="faint" style={{ fontSize: fs(12) }}>在安全练习环境快速回顾 5 步核心用法</div>
            </div>
          </div>
          <ChevronRight size={16} className="faint" />
        </button>
        <button type="button" className="mp-setting-row" onClick={() => openSubPane("logs")}>
          <div className="row" style={{ gap: 10 }}>
            <ScrollText size={17} />
            <div>
              <div style={{ fontWeight: 700, fontSize: fs(14.5) }}>运行日志与诊断</div>
              <div className="faint" style={{ fontSize: fs(12) }}>连接状态、实时音视频与错误日志</div>
            </div>
          </div>
          <ChevronRight size={16} className="faint" />
        </button>
      </div>

      {isH5Web() ? (
        <div style={{ marginTop: 14 }}>
          <H5InstallAppCard compact />
        </div>
      ) : null}

      <div style={{ marginTop: 18 }}>
        <PocketButton
          variant="danger"
          style={{ width: "100%", justifyContent: "center" }}
          onClick={() => setConfirmSignOut(true)}
        >
          <LogOut size={15} />
          退出当前连接
        </PocketButton>
      </div>

      <PocketModal
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title="退出当前连接？"
        subtitle="退出后当前浏览器/设备需要重新扫码或使用通行密钥验证接入。"
        width={380}
      >
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <PocketButton variant="ghost" onClick={() => setConfirmSignOut(false)}>
            取消
          </PocketButton>
          <PocketButton
            variant="danger"
            onClick={() => {
              setConfirmSignOut(false);
              void signOut();
            }}
          >
            确认退出
          </PocketButton>
        </div>
      </PocketModal>
    </div>
  );
}
