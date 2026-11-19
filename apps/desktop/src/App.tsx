import { useEffect, useMemo, useState } from "react";
import { Bot, Command, Laptop, MessageSquare, Moon, RefreshCw, Settings, Sun } from "lucide-react";
import { parsePairLink } from "@herdr-pocket/protocol";
import { PocketInput, PocketModal, ToastProvider, useToast } from "./components/PocketUI";
import { XiaoyangOrb } from "./components/MascotAndVendor";
import { ConnectView } from "./views/ConnectView";
import { AssistantView } from "./views/AssistantView";
import { AgentsView } from "./views/AgentsView";
import { DevicesView } from "./views/DevicesView";
import { SettingsView } from "./views/SettingsView";
import { assistantStore } from "./lib/assistant";
import { IS_HARMONY_TARGET, appVersion, assetUrl, isHarmony, loadSession } from "./lib/bridge";
import { completePairing, pingRelay, signOut, startRelayLink, stopRelayLink } from "./lib/relay";
import {
  allAgents,
  applyThemeAttribute,
  liveStore,
  settingsStore,
  spacedTitle,
  updateSettings,
} from "./lib/store";
import { dismissVoiceMessage, voiceCallStore } from "./lib/voiceCall";

type TabId = "assistant" | "agents" | "devices" | "settings";

function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1200));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}

function PocketAppShell() {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const theme = settingsStore.use((s) => s.theme);
  const textScale = settingsStore.use((s) => s.textScale);
  const link = liveStore.use((s) => s.link);
  const agentsMap = liveStore.use((s) => s.agents);
  const unread = assistantStore.use((s) => s.unread);
  const pendingActions = assistantStore.use((s) => s.items.filter((i) => i.action?.state === "pending").length);
  const callMessage = voiceCallStore.use((s) => s.message);

  const width = useWindowWidth();
  const mobileLayout = IS_HARMONY_TARGET || isHarmony() || width < 860;

  const [booted, setBooted] = useState(false);
  const [tab, setTab] = useState<TabId>("agents");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");

  useEffect(() => {
    applyThemeAttribute(theme);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (settingsStore.get().theme === "system") applyThemeAttribute("system");
    };
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, [theme]);

  useEffect(() => {
    const applySafe = (top: number, bottom: number) => {
      document.documentElement.style.setProperty("--safe-top", `${Math.max(0, Math.round(top))}px`);
      document.documentElement.style.setProperty("--safe-bottom", `${Math.max(0, Math.round(bottom))}px`);
    };
    window.__POCKET_SET_SAFE_AREA__ = applySafe;
    const initial = window.PocketHarmony?.getSafeArea?.();
    if (initial) {
      try {
        const parsed = JSON.parse(initial) as { top?: number; bottom?: number };
        if (typeof parsed.top === "number" || typeof parsed.bottom === "number") {
          applySafe(parsed.top ?? 0, parsed.bottom ?? 0);
        }
      } catch {
        // ignore
      }
    }
    window.__POCKET_OPEN_URL__ = (url: string) => {
      const hit = parsePairLink(url);
      if (hit) {
        void completePairing(hit.server, hit.code).then(
          () => toast("已通过链接重新配对"),
          (e) => toast((e as Error).message, true),
        );
      }
    };
  }, [toast]);

  useEffect(() => {
    let alive = true;
    void loadSession().then((s) => {
      if (!alive) return;
      if (s) {
        updateSettings({ server: s.server, deviceId: s.deviceId, deviceName: s.deviceName, lastServer: s.lastServer ?? s.server });
        startRelayLink(s.server, s.token);
      }
      setBooted(true);
    });
    return () => {
      alive = false;
      stopRelayLink();
    };
  }, []);

  useEffect(() => {
    if (!callMessage) return;
    toast(callMessage, { tone: callMessage === "挂断了" || callMessage === "通话结束了" ? "hangup" : "info" });
    dismissVoiceMessage();
  }, [callMessage, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const agents = useMemo(() => allAgents(agentsMap).filter((a) => !a.isShell), [agentsMap]);
  const blockedCount = useMemo(() => agents.filter((a) => a.status === "blocked").length, [agents]);
  const workingCount = useMemo(() => agents.filter((a) => a.status === "working").length, [agents]);
  const cmdMatches = useMemo(() => {
    const kq = cmdQuery.trim().toLowerCase();
    return agents.filter((a) => !kq || spacedTitle(a).toLowerCase().includes(kq) || a.harness.toLowerCase().includes(kq)).slice(0, 8);
  }, [agents, cmdQuery]);

  const openAgent = (key: string) => {
    setSelectedAgent(key);
    setTab("agents");
  };

  if (!booted) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <XiaoyangOrb mood="hello" size={88} />
      </div>
    );
  }

  if (!server) {
    return <ConnectView />;
  }

  const banner =
    link === "connecting" ? (
      <div className="conn-banner">正在连接服务器…</div>
    ) : link === "offline" ? (
      <div className="conn-banner warn" onClick={() => pingRelay()} style={{ cursor: "pointer" }}>
        <span>和服务器断开了，点击立即重连</span>
      </div>
    ) : link === "unauthorized" ? (
      <div className="conn-banner warn" onClick={() => void signOut()} style={{ cursor: "pointer" }}>
        <span>当前设备授权已失效，点击重新配对</span>
      </div>
    ) : null;

  const navItems: Array<{ id: TabId; label: string; icon: typeof Bot; badge?: number }> = [
    { id: "assistant", label: "助理", icon: MessageSquare, badge: unread + pendingActions || undefined },
    { id: "agents", label: "Agents", icon: Bot, badge: blockedCount || undefined },
    { id: "devices", label: "设备", icon: Laptop },
    { id: "settings", label: "设置", icon: Settings },
  ];

  const activeContent = (
    <>
      {banner}
      {tab === "assistant" ? <AssistantView onOpenAgent={openAgent} /> : null}
      {tab === "agents" ? <AgentsView mobileLayout={mobileLayout} selectedKey={selectedAgent} onSelectAgent={setSelectedAgent} /> : null}
      {tab === "devices" ? (
        <DevicesView
          onShowHostAgents={(id) => {
            updateSettings({ hostFilter: id });
            setTab("agents");
          }}
        />
      ) : null}
      {tab === "settings" ? <SettingsView /> : null}
    </>
  );

  const toggleDark = () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    updateSettings({ theme: isDark ? "light" : "dark" });
  };

  if (mobileLayout) {
    const hideTabs = tab === "agents" && selectedAgent !== null;
    return (
      <div className="mobile-shell" style={{ fontSize: `${Math.round(14 * textScale)}px` }}>
        <div className="mobile-body">{activeContent}</div>
        {!hideTabs ? (
          <nav className="mobile-tabbar" aria-label="主导航">
            {navItems.map((n) => {
              const Icon = n.icon;
              const active = tab === n.id;
              return (
                <button key={n.id} className={`tab-item${active ? " active" : ""}`} onClick={() => setTab(n.id)}>
                  <div className="tab-pill">
                    <Icon size={19} />
                  </div>
                  <span>{n.label}</span>
                  {n.badge ? <span className="tab-dot num">{n.badge}</span> : null}
                </button>
              );
            })}
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <div className="app-shell" style={{ fontSize: `${Math.round(14 * textScale)}px` }}>
      <aside className="sidebar">
        <div className="sidebar-panel">
          <div className="brand-header">
            <img className="brand-logo" src={assetUrl("brand/logo-160.webp")} alt="Herdr Pocket" />
            <div className="grow">
              <h1 className="brand-title">Herdr Pocket</h1>
              <div className="faint num">v{appVersion()}</div>
            </div>
          </div>

          <nav className="nav-list" aria-label="主导航">
            {navItems.map((n) => {
              const Icon = n.icon;
              return (
                <button
                  key={n.id}
                  className={`nav-btn${tab === n.id ? " active" : ""}`}
                  onClick={() => setTab(n.id)}
                >
                  <Icon size={17} />
                  <span>{n.label}</span>
                  {n.badge ? <span className="nav-badge num">{n.badge}</span> : null}
                </button>
              );
            })}
          </nav>

          <button className="nav-btn" style={{ marginTop: 4 }} onClick={() => setCmdOpen(true)}>
            <Command size={16} />
            <span>快速跳转…</span>
            <span className="nav-badge mono">⌘K</span>
          </button>

          <div className="sidebar-mascot-pod">
            <XiaoyangOrb mood={blockedCount ? "waiting" : workingCount ? "working" : "hello"} size={46} />
            <div className="grow">
              <div style={{ fontWeight: 800, fontSize: 13 }}>小羊在岗</div>
              <div className="faint truncate">
                {blockedCount ? `${blockedCount} 个等你回复` : workingCount ? `${workingCount} 个正在干活` : "一切安稳"}
              </div>
            </div>
          </div>

          <div className="sidebar-foot">
            <button className="nav-btn" onClick={() => pingRelay()}>
              <RefreshCw size={15} />
              <span>刷新连接</span>
            </button>
            <button className="nav-btn" onClick={toggleDark}>
              {document.documentElement.getAttribute("data-theme") === "dark" ? <Sun size={15} /> : <Moon size={15} />}
              <span>切换浅/暗色</span>
            </button>
          </div>
        </div>
      </aside>

      <div className="main-col">{activeContent}</div>

      <PocketModal open={cmdOpen} onOpenChange={setCmdOpen} title="快速跳转" width={480}>
        <div className="stack">
          <PocketInput
            autoFocus
            placeholder="搜索 Agent、项目或切换页面…"
            value={cmdQuery}
            onChange={(e) => setCmdQuery(e.target.value)}
          />
          <div className="row wrap" style={{ gap: 6 }}>
            {navItems.map((n) => (
              <button
                key={n.id}
                className="term-key accent"
                onClick={() => {
                  setTab(n.id);
                  setCmdOpen(false);
                }}
              >
                {n.label}
              </button>
            ))}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            {cmdMatches.map((a) => (
              <button
                key={a.key}
                className="agent-row"
                onClick={() => {
                  openAgent(a.key);
                  setCmdOpen(false);
                }}
              >
                <div className="grow truncate" style={{ fontWeight: 700 }}>{spacedTitle(a)}</div>
                <span className="faint">{a.harness}</span>
              </button>
            ))}
          </div>
        </div>
      </PocketModal>
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <PocketAppShell />
    </ToastProvider>
  );
}
