import type { ComponentType } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { PanelLeftClose, PanelLeftOpen, Plus, QrCode, RefreshCw, Search, Server, Settings } from "lucide-react";
import { XiaoyangOrb } from "./MascotAndVendor";
import { appVersion, assetUrl, detectPlatform } from "../lib/bridge";
import { isMockServer } from "../lib/mock";
import { liveStore, settingsStore } from "../lib/store";
import { pingRelay } from "../lib/relay";

export interface NavItem<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number }>;
  badge?: number;
}

function Tip({ show, label, children }: { show: boolean; label: string; children: React.ReactElement }) {
  if (!show) return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="pk-tooltip" side="right" sideOffset={8}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function serverLabel(server: string | null): string {
  if (!server) return "未连接";
  if (isMockServer(server)) return "演示模式";
  return server.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export function Sidebar<T extends string>({
  items,
  active,
  onSelect,
  rail,
  canToggle,
  onToggle,
  showMascot,
  mood,
  moodLine,
  updateReady,
  onSearch,
  onConnectRelay,
  onPairPhone,
  onAddComputer,
  onOpenConnectionSettings,
}: {
  items: NavItem<T>[];
  active: T | "settings";
  onSelect: (id: T | "settings") => void;
  rail: boolean;
  canToggle: boolean;
  onToggle: () => void;
  showMascot: boolean;
  mood: "hello" | "working" | "waiting";
  moodLine: string;
  updateReady: boolean;
  onSearch: () => void;
  onConnectRelay: () => void;
  onPairPhone: () => void;
  onAddComputer: () => void;
  onOpenConnectionSettings: () => void;
}) {
  const server = settingsStore.use((s) => s.server);
  const link = liveStore.use((s) => s.link);
  const mac = detectPlatform() === "macos";
  const healthy = link === "online";
  const statusText =
    link === "online"
      ? "已连接"
      : link === "connecting"
        ? "正在连接…"
        : link === "unauthorized"
          ? "授权已失效，需要重新连接"
          : link === "offline"
            ? "已断开，正在自动重连"
            : "未连接";

  return (
    <aside className={`sidebar${rail ? " rail" : ""}${mac ? " mac" : ""}`} aria-label="侧栏">
      <div className="sidebar-panel">
        <div className="brand-header">
          <img className="brand-logo" src={assetUrl("brand/logo-160.webp")} alt="Herdr Pocket" />
          {!rail ? (
            <div className="grow">
              <div className="brand-title">Herdr Pocket</div>
              <div className="faint num">v{appVersion()}</div>
            </div>
          ) : null}
          {canToggle && !rail ? (
            <Tip show label="收起侧栏">
              <button className="side-icon-btn" onClick={onToggle} aria-label="收起侧栏">
                <PanelLeftClose size={15} />
              </button>
            </Tip>
          ) : null}
        </div>

        {!rail ? (
          <button className="search-pill" onClick={onSearch} aria-label="快速跳转">
            <Search size={14} />
            <span className="grow">搜索或跳转…</span>
            <span className="kbd">{mac ? "⌘K" : "Ctrl K"}</span>
          </button>
        ) : null}

        {rail ? (
          <div className="rail-tools">
            {canToggle ? (
              <Tip show label="展开侧栏">
                <button className="nav-btn" onClick={onToggle} aria-label="展开侧栏">
                  <PanelLeftOpen size={17} />
                </button>
              </Tip>
            ) : null}
            <Tip show label="快速跳转">
              <button className="nav-btn" onClick={onSearch} aria-label="快速跳转">
                <Search size={17} />
              </button>
            </Tip>
          </div>
        ) : null}

        <nav className="nav-list" aria-label="主导航">
          {items.map((n) => {
            const Icon = n.icon;
            return (
              <Tip key={n.id} show={rail} label={n.badge ? `${n.label}（${n.badge}）` : n.label}>
                <button className={`nav-btn${active === n.id ? " active" : ""}`} onClick={() => onSelect(n.id)} aria-label={n.label}>
                  <Icon size={17} />
                  {!rail ? <span className="nav-label">{n.label}</span> : null}
                  {n.badge ? <span className={`nav-badge num${rail ? " dot" : ""}`}>{rail ? "" : n.badge}</span> : null}
                </button>
              </Tip>
            );
          })}
        </nav>

        <div className={`conn-card${healthy ? "" : " warn"}`}>
          {rail ? (
            <>
              <Tip show label={`${statusText} · ${serverLabel(server)}`}>
                <button className="nav-btn" onClick={healthy ? onOpenConnectionSettings : onConnectRelay} aria-label="中转服务器">
                  <Server size={17} />
                  <span className={`status-pip${healthy ? " ok" : ""}`} />
                </button>
              </Tip>
              <Tip show label="扫码连接手机">
                <button className="nav-btn" onClick={onPairPhone} aria-label="扫码连接手机">
                  <QrCode size={17} />
                </button>
              </Tip>
            </>
          ) : (
            <>
              <button className="conn-card-head" onClick={onOpenConnectionSettings} title="查看连接设置">
                <span className={`status-pip${healthy ? " ok" : ""}`} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="conn-card-title">{statusText}</span>
                  <span className="conn-card-server truncate">{serverLabel(server)}</span>
                </span>
              </button>
              {healthy ? (
                <button className="conn-action primary" onClick={onPairPhone}>
                  <QrCode size={15} />
                  <span>扫码连接手机</span>
                </button>
              ) : (
                <div className="conn-actions">
                  <button className="conn-action primary" onClick={onConnectRelay}>
                    <Server size={15} />
                    <span>连接中转服务器</span>
                  </button>
                  {link === "offline" ? (
                    <button className="conn-action" onClick={() => pingRelay()}>
                      <RefreshCw size={14} />
                      <span>立即重连</span>
                    </button>
                  ) : null}
                </div>
              )}
              {healthy ? (
                <button className="conn-action ghost" onClick={onConnectRelay}>
                  <Server size={14} />
                  <span>连接中转服务器</span>
                </button>
              ) : null}
            </>
          )}
        </div>

        {showMascot && !rail ? (
          <div className="sidebar-mascot-pod">
            <XiaoyangOrb mood={mood} size={44} />
            <div className="grow">
              <div className="pod-title">小羊在岗</div>
              <div className="faint truncate">{moodLine}</div>
            </div>
          </div>
        ) : (
          <div className="sidebar-spacer" />
        )}

        <div className="sidebar-foot">
          <Tip show={rail} label="设置">
            <button className={`nav-btn${active === "settings" ? " active" : ""}`} onClick={() => onSelect("settings")} aria-label="设置">
              <Settings size={16} />
              {!rail ? <span className="nav-label">设置</span> : null}
              {updateReady ? <span className="update-dot" aria-label="有新版本" /> : null}
            </button>
          </Tip>
          <Tip show={rail} label="添加电脑">
            <button className="nav-btn dim" onClick={onAddComputer} aria-label="添加电脑">
              <Plus size={16} />
              {!rail ? <span className="nav-label">添加电脑</span> : null}
            </button>
          </Tip>
        </div>
      </div>
    </aside>
  );
}
