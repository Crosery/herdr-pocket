import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { AlertCircle, AppWindow, Bot, Fingerprint, Laptop, MessageSquare, Moon, QrCode, Server, Settings, Sun } from "lucide-react";
import { parsePairLink, type IdentityHintResponse, type PairResponse } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketErrorBoundary, PocketInput, PocketModal, ToastProvider, useToast } from "./components/PocketUI";
import { XiaoyangOrb } from "./components/MascotAndVendor";
import type { NavItem } from "./components/Sidebar";
import { DesktopShell } from "./shell/DesktopShell";
import { FRAME_SECTION_OF, openSettingsFrame } from "./shell/shellStore";
import { MobileAppShell } from "./mobile/MobileAppShell";
import "./styles/mobile-parity.css";
import { PairPhoneModal } from "./components/PairPhoneModal";
import { ConnectRelayPanel, RELAY_EXPLAINER } from "./components/ConnectRelayPanel";
import { H5InstallAppCard } from "./components/H5InstallAppCard";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { VoiceHud } from "./components/VoiceInput";
import { AgentsView } from "./views/AgentsView";
import { DevicesView } from "./views/DevicesView";
import { OnboardingView, type OnboardStep } from "./views/OnboardingView";
import type { SettingsSection } from "./views/SettingsView";
import { assistantStore } from "./lib/assistant";
import { detectPlatform, getHostdStatus, isH5Web, isHarmony, isTauri, loadSession } from "./lib/bridge";
import { initH5Pwa } from "./lib/pwa";
import {
  fetchIdentityHint,
  inferRelayUrlFromLocation,
  isPasskeySupported,
  recognizeWebDevice,
  reconfirmWithPasskey,
  registerDevicePasskey,
  trySilentReconfirm,
} from "./lib/h5Identity";
import { isMockServer } from "./lib/mock";
import { native, type TrafficLightMetrics } from "./lib/native";
import { installWindowDragBridge } from "./lib/windowDrag";
import { ensureChatQueueWatcher } from "./lib/chatQueue";
import {
  buildCuteFontFamily,
  buildUiFontFamily,
  ensureUiFontLoaded,
  refreshLocalHostIdFast,
} from "./lib/fonts";
import { hydrateWorkspaceState } from "./lib/workspacePersist";
import { startAutoUpdateChecks, updateStore } from "./lib/updates";
import {
  answerJoinRequest,
  applyAuthenticatedPairResponse,
  completePairing,
  getActiveToken,
  getJoinRequest,
  pairWithLocalHostWithin,
  pingRelay,
  signOut,
  startRelayLink,
  stopRelayLink,
} from "./lib/relay";
import { allAgents, applyThemeAttribute, liveStore, settingsStore, spacedTitle, updateSettings } from "./lib/store";
import { useEnergyAttributes, useViewportTier } from "./lib/layout";
import { clientConfigStore, startClientConfig } from "./lib/config";
import { logger } from "./lib/log";
import { installGlobalActionTelemetry } from "./lib/actionTelemetry";
import { startDesktopPerfTelemetry } from "./lib/perfTelemetry";
import { terminalOwnsCtrlK } from "./lib/termKeys";
import { attachHudToVoiceCall, dismissVoiceMessage, hangupVoiceCall, setVoiceMuted, startVoiceCall, voiceCallStore } from "./lib/voiceCall";

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
  const uiFontFamily = clientConfigStore.use((s) => s.config.general.fontFamily);
  const collapsedPref = settingsStore.use((s) => s.sidebarCollapsed);
  const onboarding = settingsStore.use((s) => s.onboarding);
  const link = liveStore.use((s) => s.link);
  const agentsMap = liveStore.use((s) => s.agents);
  const unread = assistantStore.use((s) => s.unread);
  const pendingActions = assistantStore.use((s) => s.items.filter((i) => i.action?.state === "pending").length);
  const callMessage = voiceCallStore.use((s) => s.message);
  const updateReady = updateStore.use((s) => !isH5Web() && Boolean(s.info?.hasUpdate));

  useEnergyAttributes();
  const tier = useViewportTier();
  const mobileLayout = tier === "mobile";
  const rail = tier === "rail" || ((tier === "regular" || tier === "wide") && collapsedPref);

  const [boot, setBoot] = useState<Boot>("loading");
  const [tab, setTab] = useState<TabId>(() => {
    if (typeof window !== "undefined") {
      const hasAgentParam = new URLSearchParams(window.location.search).has("agent");
      if (!hasAgentParam && window.innerWidth < 860) return "assistant";
    }
    return "agents";
  });
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
  const [h5Hint, setH5Hint] = useState<IdentityHintResponse | null>(null);
  const [pendingApproveId, setPendingApproveId] = useState<string | null>(null);
  const [approveReq, setApproveReq] = useState<{ id: string; name: string; platform?: string } | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [passkeyPrompt, setPasskeyPrompt] = useState<{ server: string; deviceId: string; deviceName: string } | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState<"register" | "switch" | null>(null);
  const [passkeyErr, setPasskeyErr] = useState<string | null>(null);
  // Desktop without a relay: the guide floats over the (empty) shell and can be closed.
  const [firstGuideClosed, setFirstGuideClosed] = useState(false);
  const mobileRef = useRef(mobileLayout);
  mobileRef.current = mobileLayout;

  const maybePromptH5Passkey = useCallback((pairedServer: string, res?: PairResponse | null) => {
    if (!isH5Web() || !res || res.device.passkeyLinked || isMockServer(pairedServer) || !isPasskeySupported()) {
      return;
    }
    setPasskeyErr(null);
    setPasskeyPrompt({ server: pairedServer, deviceId: res.device.id, deviceName: res.device.name });
  }, []);

  useEffect(() => {
    const platform = detectPlatform();
    document.documentElement.setAttribute("data-platform", platform);
    document.documentElement.setAttribute("data-client", isH5Web() ? "h5" : isHarmony() ? "harmony" : "desktop");
    // macOS app: the title bar overlays the window and the traffic lights sit in the sidebar (R36 / N4).
    let offTrafficLights: (() => void) | null = null;
    if (platform === "macos" && isTauri()) {
      document.documentElement.setAttribute("data-titlebar", "overlay");
      const applyTrafficLights = (m: TrafficLightMetrics) => {
        if (!m.supported) return;
        const root = document.documentElement;
        root.style.setProperty("--tl-safe-left", `${Math.round(m.safeLeft)}px`);
        root.style.setProperty("--safe-top", m.safeTop > 0 ? `${Math.round(m.safeTop)}px` : "0px");
        root.toggleAttribute("data-fullscreen", Boolean(m.fullscreen));
      };
      void native.queryTrafficLightMetrics().then(applyTrafficLights);
      offTrafficLights = native.onTrafficLightMetrics(applyTrafficLights);
    }
    const offPerf = startDesktopPerfTelemetry();
    const offActions = installGlobalActionTelemetry();
    const offDrag = installWindowDragBridge();
    const offPwa = initH5Pwa({
      canReloadNow: () => voiceCallStore.get().status === "idle",
    });
    return () => {
      offPwa();
      offDrag();
      offActions();
      offPerf();
      offTrafficLights?.();
    };
  }, []);

  // Text size reaches every CSS font size (and dialogs outside the shell) through --ts.
  useEffect(() => {
    document.documentElement.style.setProperty("--ts", String(textScale || 1));
  }, [textScale]);

  // Global UI font family reaches body, headers, sidebar, chat, and modals through --font-body / --font-cute.
  useEffect(() => {
    const clean = uiFontFamily.trim();
    const rootStyle = document.documentElement.style;
    if (!clean) {
      rootStyle.removeProperty("--font-body");
      rootStyle.removeProperty("--font-cute");
      return;
    }
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      rootStyle.setProperty("--font-body", buildUiFontFamily(clean));
      rootStyle.setProperty("--font-cute", buildCuteFontFamily(clean));
    };
    apply();
    void ensureUiFontLoaded(clean).then((loaded) => {
      if (loaded && !cancelled) apply();
    });
    return () => {
      cancelled = true;
    };
  }, [uiFontFamily]);

  useEffect(() => {
    if (boot !== "ready" || isH5Web()) return;
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
          (res) => {
            toast("已通过链接重新配对");
            maybePromptH5Passkey(hit.server, res);
          },
          (e) => toast((e as Error).message, true),
        );
      }
    };
  }, [maybePromptH5Passkey, toast]);

  // Startup never waits on the network: a saved session connects in the background, and a
  // logged-in herdr-pocket on this computer is tried once with a deadline.
  useEffect(() => {
    let alive = true;
    ensureChatQueueWatcher();
    void hydrateWorkspaceState();
    void refreshLocalHostIdFast();
    void (async () => {
      await startClientConfig();

      if (isH5Web() && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        const pairParam = url.searchParams.get("pair")?.trim();
        const approveParam = url.searchParams.get("approve")?.trim();
        const inferred = inferRelayUrlFromLocation(window.location);
        if (pairParam || approveParam) {
          window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
        }
        if (approveParam && alive) setPendingApproveId(approveParam);

        if (pairParam && inferred) {
          try {
            const res = await completePairing(inferred, pairParam, undefined, "qr");
            if (!alive) return;
            toast("扫码登录成功，已绑定本机防漂移身份");
            maybePromptH5Passkey(inferred, res);
            setBoot("ready");
            return;
          } catch (err) {
            if (!alive) return;
            setAutoError((err as Error).message);
          }
        }

        const saved = await loadSession();
        if (!alive) return;
        if (saved) {
          updateSettings({ server: saved.server, deviceId: saved.deviceId, deviceName: saved.deviceName, lastServer: saved.lastServer ?? saved.server });
          startRelayLink(saved.server, saved.token);
          setBoot("ready");
          return;
        }

        if (inferred) {
          const recovered = await trySilentReconfirm(inferred);
          if (!alive) return;
          if (recovered) {
            await applyAuthenticatedPairResponse(inferred, recovered);
            if (!alive) return;
            toast("已自动恢复本机设备身份");
            setBoot("ready");
            return;
          }
          const hint = await fetchIdentityHint(inferred);
          if (!alive) return;
          setH5Hint(hint);
          if (!settingsStore.get().lastServer) {
            updateSettings({ lastServer: inferred });
          }
        }
        setBoot("ready");
        return;
      }

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
    if (boot !== "ready" || !server || !pendingApproveId) return;
    const token = getActiveToken();
    if (!token) return;
    let cancelled = false;
    void getJoinRequest(server, token, pendingApproveId)
      .then((req) => {
        if (!cancelled) setApproveReq({ id: req.id, name: req.name, platform: req.platform });
      })
      .catch((err) => {
        if (!cancelled) {
          toast((err as Error).message || "加入请求已失效或过期", true);
          setPendingApproveId(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [boot, server, pendingApproveId, toast]);

  useEffect(() => {
    if (!callMessage) return;
    if (!/^(挂断了|通话结束了)$/.test(callMessage)) {
      toast(callMessage, true);
    }
    dismissVoiceMessage();
  }, [callMessage, toast]);

  useEffect(() => {
    return native.onVoiceCallCommand((cmd) => {
      if (cmd.action === "start") {
        const st = voiceCallStore.get();
        if (st.status === "idle") {
          void startVoiceCall({ showHud: Boolean(cmd.showHud ?? true), seq: cmd.seq });
        } else if (cmd.showHud !== false && !st.hudShown) {
          attachHudToVoiceCall(cmd.seq);
        }
      } else if (cmd.action === "hangup") {
        hangupVoiceCall();
      } else if (cmd.action === "toggle-mute") {
        setVoiceMuted(!voiceCallStore.get().muted);
      }
    });
  }, []);

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
    const onOpenMobileFile = (ev: Event) => {
      const detail = (ev as CustomEvent<{ agentKey?: string; path?: string; title?: string }>).detail;
      if (!detail?.agentKey || !detail.path) return;
      const agentKey = detail.agentKey;
      const path = detail.path;
      const title = detail.title || path;
      void import("./views/WorkbenchView").then((m) => {
        m.openWorkbenchFileFromAgent(agentKey, path, title);
        setWorkbenchAgent(agentKey);
        setTab("workbench");
      });
    };
    const onBackToAgent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ agentKey?: string }>).detail;
      if (detail?.agentKey) setSelectedAgent(detail.agentKey);
      setTab("agents");
    };
    window.addEventListener("pocket:open-mobile-file", onOpenMobileFile);
    window.addEventListener("pocket:workbench-back-to-agent", onBackToAgent);
    return () => {
      window.removeEventListener("pocket:open-mobile-file", onOpenMobileFile);
      window.removeEventListener("pocket:workbench-back-to-agent", onBackToAgent);
    };
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

  if (!server && isH5Web()) {
    const recognized = recognizeWebDevice();
    return (
      <div className="h5-auth-screen" style={{ fontSize: `${Math.round(14 * textScale)}px` }}>
        <div className="h5-auth-card">
          <div className="h5-auth-hero">
            <XiaoyangOrb mood="hello" size={64} />
            <h1 className="cute-font h5-auth-title">Herdr Pocket</h1>
            <div className="row wrap" style={{ justifyContent: "center", gap: 6 }}>
              <PocketBadge tone="pink">{recognized.name}</PocketBadge>
              <span className="h5-auth-subtitle">扫码连接 · 通行密钥确认唯一身份</span>
            </div>
          </div>
          <ConnectRelayPanel
            autoFocus
            hideDeviceBanner
            initialError={autoError}
            initialHint={h5Hint}
            onConnected={(res) => {
              setAutoError(null);
              const srv = settingsStore.get().server;
              if (srv) maybePromptH5Passkey(srv, res);
            }}
          />
          <H5InstallAppCard compact />
        </div>
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
        {relayOpen ? (
          <ConnectRelayPanel
            autoFocus
            onConnected={(res) => {
              setRelayOpen(false);
              const srv = settingsStore.get().server;
              if (srv) maybePromptH5Passkey(srv, res);
            }}
          />
        ) : null}
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
      {!isH5Web() ? <UpdatePrompt /> : null}
      <PocketModal
        open={Boolean(approveReq)}
        onOpenChange={(open) => {
          if (!open && !approveBusy) {
            setApproveReq(null);
            setPendingApproveId(null);
          }
        }}
        title="允许新设备加入？"
        width={420}
      >
        {approveReq ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="muted">
              设备 <strong style={{ color: "var(--ink)" }}>{approveReq.name}</strong>
              {approveReq.platform ? `（${approveReq.platform}）` : ""} 请求接入当前中转服务器。
            </div>
            <div className="row wrap" style={{ justifyContent: "flex-end", gap: 8 }}>
              <PocketButton
                variant="ghost"
                disabled={approveBusy}
                onClick={async () => {
                  const tok = getActiveToken();
                  if (!server || !tok) return;
                  setApproveBusy(true);
                  try {
                    await answerJoinRequest(server, tok, approveReq.id, false);
                    toast("已拒绝该加入请求");
                  } catch (e) {
                    toast((e as Error).message, true);
                  } finally {
                    setApproveBusy(false);
                    setApproveReq(null);
                    setPendingApproveId(null);
                  }
                }}
              >
                拒绝
              </PocketButton>
              <PocketButton
                variant="primary"
                disabled={approveBusy}
                onClick={async () => {
                  const tok = getActiveToken();
                  if (!server || !tok) return;
                  setApproveBusy(true);
                  try {
                    await answerJoinRequest(server, tok, approveReq.id, true);
                    toast(`已允许 ${approveReq.name} 加入`);
                  } catch (e) {
                    toast((e as Error).message, true);
                  } finally {
                    setApproveBusy(false);
                    setApproveReq(null);
                    setPendingApproveId(null);
                  }
                }}
              >
                允许加入
              </PocketButton>
            </div>
          </div>
        ) : null}
      </PocketModal>
      <PocketModal
        open={Boolean(passkeyPrompt)}
        onOpenChange={(open) => {
          if (!open && !passkeyBusy) {
            setPasskeyErr(null);
            setPasskeyPrompt(null);
          }
        }}
        title="使用通行密钥确认唯一身份"
        subtitle="绑定后，后续在任何新设备或新浏览器都可用通行密钥直接回到当前身份，避免重复设备。"
        width={440}
      >
        {passkeyPrompt ? (
          <div className="stack" style={{ gap: 14 }}>
            {passkeyErr ? (
              <div className="inline-alert" role="alert">
                <AlertCircle size={16} />
                <span>{passkeyErr}</span>
              </div>
            ) : null}
            <div className="muted">
              当前已接入身份 <strong style={{ color: "var(--ink)" }}>{passkeyPrompt.deviceName}</strong>（
              <span className="mono">{passkeyPrompt.deviceId}</span>）。你可以用 Face ID / Touch ID / 指纹锁定此身份，或直接切回之前绑定过通行密钥的旧身份。
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <PocketButton
                variant="primary"
                disabled={passkeyBusy !== null}
                onClick={async () => {
                  const tok = getActiveToken();
                  if (!tok) return;
                  setPasskeyBusy("register");
                  setPasskeyErr(null);
                  try {
                    const updated = await registerDevicePasskey(passkeyPrompt.server, tok);
                    liveStore.set({ devices: { ...liveStore.get().devices, [updated.id]: updated } });
                    toast("已用通行密钥锁定唯一身份");
                    setPasskeyPrompt(null);
                  } catch (e) {
                    setPasskeyErr((e as Error)?.message || "通行密钥绑定失败，可稍后在“设置 -> 本机唯一身份锁”绑定");
                  } finally {
                    setPasskeyBusy(null);
                  }
                }}
              >
                <Fingerprint size={15} />
                <span>{passkeyBusy === "register" ? "正在验证通行密钥…" : "创建并绑定通行密钥"}</span>
              </PocketButton>
              <PocketButton
                variant="soft"
                disabled={passkeyBusy !== null}
                onClick={async () => {
                  const tok = getActiveToken();
                  setPasskeyBusy("switch");
                  setPasskeyErr(null);
                  try {
                    const switched = await reconfirmWithPasskey(passkeyPrompt.server, tok ?? undefined);
                    await applyAuthenticatedPairResponse(passkeyPrompt.server, switched);
                    toast(`已回到原身份 ${switched.device.name}`);
                    setPasskeyPrompt(null);
                  } catch (e) {
                    setPasskeyErr((e as Error)?.message || "未匹配到已有通行密钥或验证已取消");
                  } finally {
                    setPasskeyBusy(null);
                  }
                }}
              >
                <Fingerprint size={15} />
                <span>{passkeyBusy === "switch" ? "正在恢复原身份…" : "已有通行密钥？回到上一个身份"}</span>
              </PocketButton>
              <PocketButton
                variant="ghost"
                disabled={passkeyBusy !== null}
                onClick={() => {
                  setPasskeyErr(null);
                  setPasskeyPrompt(null);
                }}
              >
                稍后再说
              </PocketButton>
            </div>
          </div>
        ) : null}
      </PocketModal>
    </>
  );

  const fontSize = `${Math.round(14 * textScale)}px`;

  if (mobileLayout) {
    return (
      <MobileAppShell
        tab={tab}
        onTab={setTab}
        selectedAgentKey={selectedAgent}
        onSelectAgent={setSelectedAgent}
        workbenchAgent={workbenchAgent}
        onOpenWorkbench={(key) => {
          setWorkbenchAgent(key);
          setTab("workbench");
        }}
        onPairPhone={() => setPairOpen(true)}
        onConnectRelay={() => setRelayOpen(true)}
        banner={banner}
        overlays={overlays}
        fontSize={fontSize}
      />
    );
  }

  return (
    <div className="v3-root" style={{ fontSize }}>
      <DesktopShell
        collapsed={rail}
        canToggleSidebar={tier !== "rail"}
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
      <PocketErrorBoundary title="界面渲染出错">
        <PocketAppShell />
      </PocketErrorBoundary>
    </ToastProvider>
  );
}
