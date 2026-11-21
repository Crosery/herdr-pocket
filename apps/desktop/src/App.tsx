import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { AppWindow, Bot, Laptop, MessageSquare, Moon, QrCode, Server, Settings, Sun } from "lucide-react";
import { parsePairLink } from "@herdr-pocket/protocol";
import { PocketButton, PocketInput, PocketModal, ToastProvider, useToast } from "./components/PocketUI";
import { XiaoyangOrb } from "./components/MascotAndVendor";
import type { NavItem } from "./components/Sidebar";
import { DesktopShell } from "./shell/DesktopShell";
import { FRAME_SECTION_OF, openSettingsFrame } from "./shell/shellStore";
import { PairPhoneModal } from "./components/PairPhoneModal";
import { ConnectRelayPanel, RELAY_EXPLAINER } from "./components/ConnectRelayPanel";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { VoiceHud } from "./components/VoiceInput";
import { AgentsView } from "./views/AgentsView";
import { DevicesView } from "./views/DevicesView";
import { OnboardingView, type OnboardStep } from "./views/OnboardingView";
import type { SettingsSection } from "./views/SettingsView";
import { assistantStore } from "./lib/assistant";
import { detectPlatform, getHostdStatus, isTauri, loadSession } from "./lib/bridge";
import { ensureChatQueueWatcher } from "./lib/chatQueue";
import { refreshLocalHostIdFast } from "./lib/fonts";
import { hydrateWorkspaceState } from "./lib/workspacePersist";
import { startAutoUpdateChecks, updateStore } from "./lib/updates";
import { completePairing, pairWithLocalHostWithin, pingRelay, signOut, startRelayLink, stopRelayLink } from "./lib/relay";
import { allAgents, applyThemeAttribute, liveStore, settingsStore, spacedTitle, updateSettings } from "./lib/store";
import { useEnergyAttributes, useViewport } from "./lib/layout";
import { clientConfigStore, startClientConfig } from "./lib/config";
import { logger } from "./lib/log";
import { terminalOwnsCtrlK } from "./lib/termKeys";
import { dismissVoiceMessage, voiceCallStore } from "./lib/voiceCall";

// Heavy views load on first visit, not at startup.
const AssistantView = lazy(() => import("./views/AssistantView").then((m) => ({ default: m.AssistantView })));
const SettingsView = lazy(() => import("./views/SettingsView").then((m) => ({ default: m.SettingsView })));
const WorkbenchView = lazy(() => import("./views/WorkbenchView").then((m) => ({ default: m.WorkbenchView })));

type TabId = "assistant" | "agents" | "devices" | "workbench" | "settings";
type Boot = "loading" | "auto" | "ready";

interface CmdItem {
  id: string;
  group: "页面" | "操作" | "Agent";
  label: string;
  hint?: string;
  icon?: ComponentType<{ size?: number }>;
  run: () => void;
}

function ViewFallback() {
  return (
    <div className="view-fallback">
      <XiaoyangOrb mood="working" size={64} />
    </div>
  );
}

function PocketAppShell() {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const theme = settingsStore.use((s) => s.theme);
  const textScale = settingsStore.use((s) => s.textScale);
  const collapsedPref = settingsStore.use((s) => s.sidebarCollapsed);
  const onboarding = settingsStore.use((s) => s.onboarding);
  const link = liveStore.use((s) => s.link);
  const agentsMap = liveStore.use((s) => s.agents);
  const unread = assistantStore.use((s) => s.unread);
  const pendingActions = assistantStore.use((s) => s.items.filter((i) => i.action?.state === "pending").length);
  const callMessage = voiceCallStore.use((s) => s.message);
  const updateReady = updateStore.use((s) => Boolean(s.info?.hasUpdate));

  useEnergyAttributes();
  const vp = useViewport();
  const mobileLayout = vp.tier === "mobile";
  const rail = vp.tier === "rail" || ((vp.tier === "regular" || vp.tier === "wide") && collapsedPref);

  const [boot, setBoot] = useState<Boot>("loading");
  const [tab, setTab] = useState<TabId>("agents");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [workbenchAgent, setWorkbenchAgent] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdQuery, setCmdQuery] = useState("");
  const [cmdIndex, setCmdIndex] = useState(0);
  const [pairOpen, setPairOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [addHostNonce, setAddHostNonce] = useState(0);
  const [guide, setGuide] = useState<{ step: OnboardStep; error: string | null } | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  // Desktop without a relay: the guide floats over the (empty) shell and can be closed.
  const [firstGuideClosed, setFirstGuideClosed] = useState(false);
  const mobileRef = useRef(mobileLayout);
  mobileRef.current = mobileLayout;

  useEffect(() => {
    const platform = detectPlatform();
    document.documentElement.setAttribute("data-platform", platform);
    // macOS app: the title bar overlays the window and the traffic lights sit in the sidebar (R36 / N4).
    if (platform === "macos" && isTauri()) document.documentElement.setAttribute("data-titlebar", "overlay");
  }, []);

  // Text size reaches every CSS font size (and dialogs outside the shell) through --ts.
  useEffect(() => {
    document.documentElement.style.setProperty("--ts", String(textScale || 1));
  }, [textScale]);

  useEffect(() => {
    if (boot !== "ready") return;
    return startAutoUpdateChecks();
  }, [boot]);

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
        if (typeof parsed.top === "number" || typeof parsed.bottom === "number") applySafe(parsed.top ?? 0, parsed.bottom ?? 0);
      } catch {
        // ignore
      }
    }
    window.__POCKET_OPEN_URL__ = (url: string) => {
      const hit = parsePairLink(url);
      if (hit) {
        void completePairing(hit.server, hit.code, undefined, "link").then(
          () => toast("已通过链接重新配对"),
          (e) => toast((e as Error).message, true),
        );
      }
    };
  }, [toast]);

  // Startup never waits on the network: a saved session connects in the background, and a
  // logged-in herdr-pocket on this computer is tried once with a deadline.
  useEffect(() => {
    let alive = true;
    ensureChatQueueWatcher();
    void hydrateWorkspaceState();
    void refreshLocalHostIdFast();
    void (async () => {
      await startClientConfig();
      const s = await loadSession();
      if (!alive) return;
      if (s) {
        updateSettings({ server: s.server, deviceId: s.deviceId, deviceName: s.deviceName, lastServer: s.lastServer ?? s.server });
        startRelayLink(s.server, s.token);
        setBoot("ready");
        return;
      }
      const local = await getHostdStatus();
      if (!alive) return;
      if (!local?.configured || !clientConfigStore.get().config.general.useLocalLogin) {
        setBoot("ready");
        return;
      }
      setBoot("auto");
      try {
        await pairWithLocalHostWithin(8000);
        if (!alive) return;
        toast(`已用这台电脑的 herdr-pocket 登录连上 ${(local.server ?? "").replace(/^https?:\/\//, "")}`);
        logger.info("startup", "connected through the local herdr-pocket login");
        if (settingsStore.get().onboarding !== "done") setGuide({ step: "phone", error: null });
      } catch (err) {
        if (!alive) return;
        const msg = (err as Error).message;
        logger.warn("startup", `automatic local login failed: ${msg}`);
        setAutoError(msg);
      } finally {
        if (alive) setBoot("ready");
      }
    })();
    return () => {
      alive = false;
      stopRelayLink();
    };
  }, [toast]);

  useEffect(() => {
    if (!callMessage) return;
    toast(callMessage, { tone: callMessage === "挂断了" || callMessage === "通话结束了" ? "hangup" : "info" });
    dismissVoiceMessage();
  }, [callMessage, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The desktop shell has its own shortcuts (shell/shortcuts.ts).
      if (!mobileRef.current) return;
      // Ctrl+K typed into a terminal box goes to the terminal (^K) only; ⌘K still opens the palette.
      if (e.ctrlKey && !e.metaKey && terminalOwnsCtrlK(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setTab("settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (cmdOpen) setCmdIndex(0);
  }, [cmdOpen]);

  useEffect(() => {
    if (cmdOpen) document.getElementById(`cmdk-${cmdIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [cmdOpen, cmdIndex]);

  const agents = useMemo(() => allAgents(agentsMap).filter((a) => !a.isShell), [agentsMap]);
  const blockedCount = useMemo(() => agents.filter((a) => a.status === "blocked").length, [agents]);
  const cmdMatches = useMemo(() => {
    const kq = cmdQuery.trim().toLowerCase();
    return agents.filter((a) => !kq || spacedTitle(a).toLowerCase().includes(kq) || a.harness.toLowerCase().includes(kq)).slice(0, 8);
  }, [agents, cmdQuery]);

  const openAgent = useCallback((key: string) => {
    setSelectedAgent(key);
    setTab("agents");
  }, []);

  const openSettings = useCallback((section: SettingsSection) => {
    if (!mobileRef.current) return openSettingsFrame(FRAME_SECTION_OF[section]);
    setSettingsSection(section);
    setTab("settings");
  }, []);

  if (boot === "loading") {
    return (
      <div className="boot-screen">
        <TitlebarStrip />
        <XiaoyangOrb mood="hello" size={104} />
      </div>
    );
  }

  if (boot === "auto") {
    return (
      <div className="boot-screen">
        <TitlebarStrip />
        <XiaoyangOrb mood="working" size={104} />
        <div className="boot-line">正在用这台电脑的 herdr-pocket 登录连接…</div>
        <PocketButton variant="ghost" size="sm" onClick={() => setBoot("ready")}>
          不等了，手动连接
        </PocketButton>
      </div>
    );
  }

  if (!server && mobileLayout) {
    return (
      <>
        <TitlebarStrip />
        <OnboardingView
          key={autoError ?? "guide"}
          initialStep={autoError || onboarding !== "new" ? "relay" : "welcome"}
          initialError={autoError}
          onClose={() => setAutoError(null)}
        />
      </>
    );
  }

  const banner =
    link === "connecting" ? (
      <div className="conn-banner">正在连接服务器…</div>
    ) : link === "offline" ? (
      <button className="conn-banner warn" onClick={() => pingRelay()}>
        和服务器断开了，正在自动重连 · 点这里立即重连
      </button>
    ) : link === "unauthorized" ? (
      <button className="conn-banner warn" onClick={() => void signOut()}>
        这台设备的授权已失效（可能被别的设备移除了）· 点这里重新连接
      </button>
    ) : null;

  const navItems: NavItem<Exclude<TabId, "settings">>[] = [
    { id: "assistant", label: "助理", icon: MessageSquare, badge: unread + pendingActions || undefined },
    { id: "agents", label: "Agents", icon: Bot, badge: blockedCount || undefined },
    { id: "devices", label: "设备", icon: Laptop },
    { id: "workbench", label: "工作台", icon: AppWindow },
  ];

  const activeContent = (
    <>
      {banner}
      <Suspense fallback={<ViewFallback />}>
        {tab === "assistant" ? <AssistantView onOpenAgent={openAgent} /> : null}
        {tab === "agents" ? (
          <AgentsView
            mobileLayout={mobileLayout}
            selectedKey={selectedAgent}
            onSelectAgent={setSelectedAgent}
            onOpenWorkbench={(key) => {
              setWorkbenchAgent(key);
              setTab("workbench");
            }}
          />
        ) : null}
        {tab === "devices" ? (
          <DevicesView
            addHostNonce={addHostNonce}
            onPairPhone={() => setPairOpen(true)}
            onShowHostAgents={(id) => {
              updateSettings({ hostFilter: id });
              setTab("agents");
            }}
          />
        ) : null}
        {tab === "workbench" ? <WorkbenchView agentKey={workbenchAgent} mobileLayout={mobileLayout} /> : null}
        {tab === "settings" ? (
          <SettingsView
            section={settingsSection}
            onSection={setSettingsSection}
            mobileLayout={mobileLayout}
            onPairPhone={() => setPairOpen(true)}
            onConnectRelay={() => setRelayOpen(true)}
            onReopenGuide={() => setGuide({ step: "welcome", error: null })}
          />
        ) : null}
      </Suspense>
    </>
  );

  const toggleDark = () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    updateSettings({ theme: isDark ? "light" : "dark" });
  };

  // The palette is one list (pages, actions, agents) driven by the arrow keys and Enter.
  const closeCmd = () => setCmdOpen(false);
  const kq = cmdQuery.trim().toLowerCase();
  const isDarkNow = document.documentElement.getAttribute("data-theme") === "dark";
  const cmdItems = ([
    ...[...navItems, { id: "settings" as const, label: "设置", icon: Settings }].map<CmdItem>((n) => ({
      id: `page-${n.id}`,
      group: "页面",
      label: n.label,
      icon: n.icon,
      run: () => {
        setTab(n.id);
        closeCmd();
      },
    })),
    { id: "act-pair", group: "操作", label: "扫码连接手机", icon: QrCode, run: () => { closeCmd(); setPairOpen(true); } },
    { id: "act-relay", group: "操作", label: "连接中转服务器", icon: Server, run: () => { closeCmd(); setRelayOpen(true); } },
    { id: "act-theme", group: "操作", label: isDarkNow ? "切换到浅色" : "切换到暗色", icon: isDarkNow ? Sun : Moon, run: () => { toggleDark(); closeCmd(); } },
  ] as CmdItem[]).filter((it) => !kq || it.label.toLowerCase().includes(kq));
  for (const a of cmdMatches) {
    cmdItems.push({ id: `agent-${a.key}`, group: "Agent", label: spacedTitle(a), hint: a.harness, icon: Bot, run: () => { openAgent(a.key); closeCmd(); } });
  }
  const cmdActive = Math.min(cmdIndex, Math.max(0, cmdItems.length - 1));

  const overlays = (
    <>
      <PairPhoneModal
        open={pairOpen}
        onOpenChange={setPairOpen}
        onNeedRelay={() => {
          setPairOpen(false);
          setRelayOpen(true);
        }}
      />
      <PocketModal open={relayOpen} onOpenChange={setRelayOpen} title="连接中转服务器" subtitle={RELAY_EXPLAINER} width={560}>
        {relayOpen ? <ConnectRelayPanel autoFocus onConnected={() => setRelayOpen(false)} /> : null}
      </PocketModal>
      <PocketModal open={cmdOpen} onOpenChange={setCmdOpen} title="快速跳转" width={480}>
        <div className="stack cmdk">
          <PocketInput
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="cmdk-list"
            aria-activedescendant={cmdItems[cmdActive] ? `cmdk-${cmdActive}` : undefined}
            placeholder="搜索 Agent，或跳到某个页面…"
            value={cmdQuery}
            onChange={(e) => {
              setCmdQuery(e.target.value);
              setCmdIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!cmdItems.length) return;
                const step = e.key === "ArrowDown" ? 1 : -1;
                setCmdIndex((cmdActive + step + cmdItems.length) % cmdItems.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                cmdItems[cmdActive]?.run();
              }
            }}
          />
          <div id="cmdk-list" role="listbox" aria-label="跳转目标" className="cmdk-list">
            {cmdItems.length === 0 ? <div className="faint cmdk-empty">没有找到匹配的页面或 Agent</div> : null}
            {cmdItems.map((item, i) => {
              const Icon = item.icon;
              return (
                <div key={item.id} className="cmdk-block">
                  {i === 0 || cmdItems[i - 1]!.group !== item.group ? <div className="cmdk-group">{item.group}</div> : null}
                  <button
                    id={`cmdk-${i}`}
                    role="option"
                    aria-selected={i === cmdActive}
                    tabIndex={-1}
                    className={`cmdk-item${i === cmdActive ? " active" : ""}`}
                    onMouseMove={() => i !== cmdActive && setCmdIndex(i)}
                    onClick={item.run}
                  >
                    {Icon ? <Icon size={15} /> : null}
                    <span className="grow truncate">{item.label}</span>
                    {item.hint ? <span className="faint truncate cmdk-hint">{item.hint}</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </PocketModal>
      {guide ? (
        <OnboardingView
          overlay
          frame={!mobileLayout}
          initialStep={guide.step}
          initialError={guide.error}
          onClose={() => setGuide(null)}
        />
      ) : null}
      <VoiceHud />
      <UpdatePrompt />
    </>
  );

  const fontSize = `${Math.round(14 * textScale)}px`;

  if (mobileLayout) {
    const hideTabs = tab === "agents" && selectedAgent !== null;
    const mobileNav: Array<{ id: TabId; label: string; icon: NavItem<TabId>["icon"]; badge?: number }> = [
      ...navItems.filter((n) => n.id !== "workbench"),
      { id: "settings", label: "设置", icon: Settings },
    ];
    return (
      <div className="mobile-shell" style={{ fontSize }}>
        <TitlebarStrip />
        <div className="mobile-body">{activeContent}</div>
        {!hideTabs ? (
          <nav className="mobile-tabbar" aria-label="主导航">
            {mobileNav.map((n) => {
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
        {overlays}
      </div>
    );
  }

  return (
    <div className="v3-root" style={{ fontSize }}>
      <DesktopShell
        collapsed={rail}
        canToggleSidebar={vp.tier !== "rail"}
        onToggleSidebar={() => updateSettings({ sidebarCollapsed: !collapsedPref })}
        onPairPhone={() => setPairOpen(true)}
        onConnectRelay={() => setRelayOpen(true)}
        onReopenGuide={() => setGuide({ step: "welcome", error: null })}
      />
      {overlays}
      {!server && !firstGuideClosed && !guide ? (
        <OnboardingView
          key={autoError ?? "guide"}
          overlay
          frame
          initialStep={autoError || onboarding !== "new" ? "relay" : "welcome"}
          initialError={autoError}
          onClose={() => {
            setAutoError(null);
            setFirstGuideClosed(true);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Views without the v3 sidebar (boot, the phone layout below 860 px, the phone guide) have no
 * brand row or tabs bar to drag. Under the macOS overlay title bar this strip moves the window;
 * --safe-top keeps their content below it and the traffic lights. Hidden everywhere else.
 */
function TitlebarStrip() {
  return <div className="titlebar-strip" data-tauri-drag-region aria-hidden="true" />;
}

export function App() {
  return (
    <ToastProvider>
      <PocketAppShell />
    </ToastProvider>
  );
}
