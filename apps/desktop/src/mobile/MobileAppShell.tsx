import { Suspense, lazy, useState, type ReactNode } from "react";
import { Bot, ChevronLeft, Laptop, MessageSquare, PhoneCall, Settings } from "lucide-react";
import { UpdatePrompt } from "../components/UpdatePrompt";
import { EmptyState, PocketButton, PocketIconButton } from "../components/PocketUI";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import { assistantStore } from "../lib/assistant";
import { allAgents, liveStore, updateSettings } from "../lib/store";
import { voiceCallStore } from "../lib/voiceCall";
import { MobileAgentsTab } from "./MobileAgentsTab";
import { MobileAgentDetail } from "./MobileAgentDetail";
import { MobileDevicesTab } from "./MobileDevicesTab";
import { MobileSettingsTab } from "./MobileSettingsTab";

const AssistantView = lazy(() => import("../views/AssistantView").then((m) => ({ default: m.AssistantView })));
const WorkbenchView = lazy(() => import("../views/WorkbenchView").then((m) => ({ default: m.WorkbenchView })));

export type MobileTabId = "assistant" | "agents" | "devices" | "workbench" | "settings";

function MobileFallback() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <XiaoyangOrb mood="working" size={64} />
    </div>
  );
}

export function MobileAppShell({
  tab,
  onTab,
  selectedAgentKey,
  onSelectAgent,
  workbenchAgent,
  onOpenWorkbench,
  onPairPhone,
  onConnectRelay,
  banner,
  overlays,
  fontSize,
}: {
  tab: MobileTabId;
  onTab: (t: MobileTabId) => void;
  selectedAgentKey: string | null;
  onSelectAgent: (key: string | null) => void;
  workbenchAgent: string | null;
  onOpenWorkbench: (agentKey: string) => void;
  onPairPhone: () => void;
  onConnectRelay: () => void;
  banner: ReactNode;
  overlays: ReactNode;
  fontSize: string;
}) {
  const agentsMap = liveStore.use((s) => s.agents);
  const unread = assistantStore.use((s) => s.unread);
  const pendingActions = assistantStore.use((s) => s.items.filter((i) => i.action?.state === "pending").length);
  const callStatus = voiceCallStore.use((s) => s.status);

  const [detailInitialTab, setDetailInitialTab] = useState<"chat" | "term">("chat");
  const [settingsSubOpen, setSettingsSubOpen] = useState(false);

  const all = allAgents(agentsMap);
  const blockedCount = all.filter((a) => !a.isShell && a.status === "blocked").length;
  const selectedAgent = selectedAgentKey ? all.find((a) => a.key === selectedAgentKey) ?? null : null;

  const hideTabs =
    (tab === "agents" && selectedAgent !== null) ||
    (tab === "settings" && settingsSubOpen) ||
    tab === "workbench";

  const assistantBadge = unread + pendingActions || undefined;

  const openAgent = (key: string, initialTab: "chat" | "term" = "chat") => {
    setDetailInitialTab(initialTab);
    onSelectAgent(key);
    onTab("agents");
  };

  return (
    <div className="mp-shell" style={{ fontSize }}>
      {banner}

      {tab !== "assistant" && callStatus !== "idle" ? (
        <button
          type="button"
          className="between"
          style={{
            border: 0,
            background: "var(--mp-accent-container)",
            color: "var(--mp-accent-text)",
            padding: "8px 14px",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
            flexShrink: 0,
          }}
          onClick={() => onTab("assistant")}
        >
          <span className="row" style={{ gap: 6 }}>
            <PhoneCall size={14} />
            <span>{callStatus === "connecting" ? "正在接通小羊语音…" : "正在与小羊语音通话中 · 点此回到通话"}</span>
          </span>
        </button>
      ) : null}

      <div className="mp-body">
        <Suspense fallback={<MobileFallback />}>
          {tab === "assistant" ? <AssistantView onOpenAgent={(k) => openAgent(k, "chat")} /> : null}

          {tab === "agents" ? (
            selectedAgentKey ? (
              selectedAgent ? (
                <MobileAgentDetail
                  agent={selectedAgent}
                  initialTab={detailInitialTab}
                  onBack={() => onSelectAgent(null)}
                  onOpenWorkbench={(key) => onOpenWorkbench(key)}
                />
              ) : (
                <div className="mp-scroll">
                  <div style={{ marginBottom: 10 }}>
                    <PocketButton size="sm" variant="ghost" onClick={() => onSelectAgent(null)}>
                      <ChevronLeft size={16} />
                      返回列表
                    </PocketButton>
                  </div>
                  <EmptyState mood="waiting" title="找不到这个 Agent" body="它可能已关闭，或所在电脑当前离线。" />
                </div>
              )
            ) : (
              <MobileAgentsTab
                onSelectAgent={(key, initialTab) => openAgent(key, initialTab)}
                onOpenDevices={() => onTab("devices")}
                onOpenSettings={() => onTab("settings")}
              />
            )
          ) : null}

          {tab === "devices" ? (
            <MobileDevicesTab
              onShowHostAgents={(hostId) => {
                updateSettings({ hostFilter: hostId });
                onSelectAgent(null);
                onTab("agents");
              }}
              onPairPhone={onPairPhone}
            />
          ) : null}

          {tab === "workbench" ? (
            <div className="mp-detail-root">
              <div className="mp-detail-header">
                <div className="mp-detail-top">
                  <PocketIconButton size="sm" tooltip="返回" onClick={() => onTab("agents")}>
                    <ChevronLeft size={18} />
                  </PocketIconButton>
                  <div className="grow truncate" style={{ fontWeight: 800 }}>工作区文件</div>
                </div>
              </div>
              <div className="mp-detail-body">
                <WorkbenchView agentKey={workbenchAgent} mobileLayout />
              </div>
            </div>
          ) : null}

          {tab === "settings" ? (
            <MobileSettingsTab
              onPairPhone={onPairPhone}
              onConnectRelay={onConnectRelay}
              onSubPaneChange={setSettingsSubOpen}
            />
          ) : null}
        </Suspense>
      </div>

      {!hideTabs ? (
        <nav className="mp-tabbar" aria-label="主导航">
          {(
            [
              { id: "assistant", label: "助理", icon: MessageSquare, badge: assistantBadge },
              { id: "agents", label: "Agents", icon: Bot, badge: blockedCount || undefined },
              { id: "devices", label: "设备", icon: Laptop },
              { id: "settings", label: "设置", icon: Settings },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`mp-tab-btn${active ? " active" : ""}`}
                onClick={() => {
                  if (item.id === "agents" && tab === "agents") {
                    onSelectAgent(null);
                  }
                  onTab(item.id);
                }}
              >
                <div className="mp-tab-pill">
                  <Icon size={20} />
                  {"badge" in item && item.badge ? (
                    <span className="mp-tab-badge num">{item.badge > 99 ? "99+" : item.badge}</span>
                  ) : null}
                </div>
                <span className="mp-tab-label">{item.label}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      <UpdatePrompt />
      {overlays}
    </div>
  );
}
