import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Cpu,
  FileCode2,
  Laptop,
  LayoutGrid,
  LogOut,
  Menu,
  Mic,
  Moon,
  RefreshCw,
  Search,
  Sparkles,
  Sun,
} from "lucide-react";
import {
  adminApi,
  assetUrl,
  fmtUptime,
  getSavedToken,
  greetingNow,
  setSavedToken,
  setUnauthorizedHandler,
  type AdminOverview,
  type AssistantConfigView,
  type Device,
  type PromptView,
} from "./lib/api";
import { initAdminAutoUpdate } from "./lib/autoUpdate";
import { XiaoyangOrb } from "./components/MascotAndVendor";
import {
  PocketButton,
  PocketIconButton,
  PocketInput,
  PocketRibbonFooter,
  ToastProvider,
  useToast,
} from "./components/ui/PocketUI";
import { CommandPalette, type RouteId } from "./components/CommandPalette";
import { OverviewView } from "./views/OverviewView";
import { DevicesView } from "./views/DevicesView";
import { ModelsView } from "./views/ModelsView";
import { VoiceView } from "./views/VoiceView";
import { PromptsView } from "./views/PromptsView";
import { LogsView } from "./views/LogsView";

const ROUTE_META: Array<{ id: RouteId; label: string }> = [
  { id: "overview", label: "概览与智能体" },
  { id: "devices", label: "设备与配对" },
  { id: "models", label: "模型与服务商" },
  { id: "voice", label: "语音与通话" },
  { id: "prompts", label: "提示词工作台" },
  { id: "logs", label: "实时日志" },
];

const ROUTE_ICON: Record<RouteId, (size: number) => React.ReactNode> = {
  overview: (s) => <LayoutGrid size={s} />,
  devices: (s) => <Laptop size={s} />,
  models: (s) => <Cpu size={s} />,
  voice: (s) => <Mic size={s} />,
  prompts: (s) => <FileCode2 size={s} />,
  logs: (s) => <Activity size={s} />,
};

function readInitialDark(): boolean {
  try {
    return document.documentElement.getAttribute("data-theme") === "dark";
  } catch {
    return false;
  }
}

function readHashRoute(): RouteId {
  const raw = location.hash.replace(/^#/, "");
  return ROUTE_META.some((r) => r.id === raw) ? (raw as RouteId) : "overview";
}

function ConsoleInner() {
  const toast = useToast();
  const [dark, setDark] = useState(readInitialDark);
  const [tokenReady, setTokenReady] = useState(() => !!getSavedToken());
  const [tokenInput, setTokenInput] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [entering, setEntering] = useState(false);

  const [route, setRoute] = useState<RouteId>(readHashRoute);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [pairModalOpen, setPairModalOpen] = useState(false);

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [config, setConfig] = useState<AssistantConfigView | null>(null);
  const [prompts, setPrompts] = useState<PromptView[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const autoUpdaterRef = useRef<ReturnType<typeof initAdminAutoUpdate> | null>(null);

  useEffect(() => {
    const updater = initAdminAutoUpdate();
    autoUpdaterRef.current = updater;
    return () => {
      autoUpdaterRef.current = null;
      updater.dispose();
    };
  }, []);

  const serverVersionTag = overview ? `${overview.version}:${overview.uiVersion ?? overview.version}` : "";
  useEffect(() => {
    if (serverVersionTag) autoUpdaterRef.current?.checkNow(true);
  }, [serverVersionTag]);

  const applyTheme = useCallback((nextDark: boolean, origin?: { x: number; y: number }) => {
    const val = nextDark ? "dark" : "light";
    const commit = () => {
      document.documentElement.setAttribute("data-theme", val);
      try {
        localStorage.setItem("herdr-pocket-admin-theme", val);
      } catch {}
      setDark(nextDark);
    };

    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void> };
    };
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (origin && doc.startViewTransition && !reduceMotion) {
      const maxR = Math.hypot(
        Math.max(origin.x, window.innerWidth - origin.x),
        Math.max(origin.y, window.innerHeight - origin.y),
      );
      const vt = doc.startViewTransition(commit);
      vt.ready
        .then(() => {
          document.documentElement.animate(
            {
              clipPath: [
                `circle(0px at ${origin.x}px ${origin.y}px)`,
                `circle(${maxR}px at ${origin.x}px ${origin.y}px)`,
              ],
            },
            { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
          );
        })
        .catch(() => {});
    } else {
      commit();
    }
  }, []);

  const handleToggleTheme = useCallback(
    (e?: React.MouseEvent<HTMLElement>) => {
      const origin = e ? { x: e.clientX || window.innerWidth - 40, y: e.clientY || 40 } : undefined;
      applyTheme(!dark, origin);
    },
    [applyTheme, dark],
  );

  const logout = useCallback((err = "") => {
    setSavedToken("");
    setTokenReady(false);
    setOverview(null);
    setLoginErr(err);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => logout("令牌不对，或者已经更换"));
  }, [logout]);

  const loadAll = useCallback(async (withSpinner = false) => {
    if (withSpinner) setRefreshing(true);
    try {
      const [ov, dev, cfg, prm] = await Promise.all([
        adminApi.overview(),
        adminApi.devices(),
        adminApi.config(),
        adminApi.prompts(),
      ]);
      setOverview(ov);
      setDevices(dev.devices ?? []);
      setConfig(cfg);
      setPrompts(prm.prompts ?? []);
    } finally {
      if (withSpinner) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!tokenReady) return;
    loadAll(false).catch((e) => {
      if ((e as { status?: number }).status !== 401) toast((e as Error).message, true);
    });
    const t = setInterval(() => {
      if (!document.hidden) loadAll(false).catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, [tokenReady, loadAll, toast]);

  useEffect(() => {
    const onHash = () => setRoute(readHashRoute());
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (tokenReady) setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, [tokenReady]);

  const navigate = useCallback((r: RouteId) => {
    setRoute(r);
    setDrawerOpen(false);
    if (location.hash !== `#${r}`) location.hash = r;
  }, []);

  const submitLogin = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = tokenInput.trim();
    if (!t) {
      setLoginErr("先填管理员令牌再进入");
      return;
    }
    setEntering(true);
    setLoginErr("");
    try {
      const ov = await adminApi.overview(t);
      setSavedToken(t);
      setOverview(ov);
      setTokenInput("");
      setTokenReady(true);
    } catch (err) {
      setLoginErr((err as Error).message || "进不去，请核对令牌");
    } finally {
      setEntering(false);
    }
  };

  if (!tokenReady) {
    return (
      <div className="login-stage">
        <div className="noise-layer" />
        <div style={{ position: "fixed", right: 20, top: 20, zIndex: 10 }}>
          <PocketIconButton tooltip={dark ? "切换到浅色模式" : "切换到暗夜模式"} onClick={handleToggleTheme}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </PocketIconButton>
        </div>

        <form className="login-card" onSubmit={submitLogin}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
            <XiaoyangOrb mood="hello" size={102} />
          </div>
          <h1 className="cute-font" style={{ fontSize: 30, margin: "0 0 6px" }}>
            Herdr Pocket
          </h1>
          <div className="muted" style={{ fontSize: 13.5, marginBottom: 20 }}>
            小羊控制台 · 输入管理员令牌进入（仅保存在当前标签页）
          </div>

          <div className="stack" style={{ gap: 12 }}>
            <PocketInput
              mono
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="POCKET_ADMIN_TOKEN"
            />
            <PocketButton variant="primary" size="lg" type="submit" disabled={entering} style={{ width: "100%" }}>
              <Sparkles size={16} />
              <span>{entering ? "验证中…" : "进入小羊控制台"}</span>
            </PocketButton>
          </div>

          <div
            style={{
              minHeight: 22,
              marginTop: 12,
              fontSize: 13,
              fontWeight: 700,
              color: "var(--blush-text)",
            }}
          >
            {loginErr}
          </div>
        </form>

        <PocketRibbonFooter />
      </div>
    );
  }

  const nonShell = (overview?.agentList ?? []).filter((a) => !a.isShell);
  const blockedCount = nonShell.filter((a) => a.status === "blocked").length;
  const workingCount = nonShell.filter((a) => a.status === "working").length;
  const pendingJoins = overview?.joins.length ?? 0;

  const subtitle =
    blockedCount > 0
      ? `有 ${blockedCount} 个 agent 在等你处理`
      : workingCount > 0
        ? `有 ${workingCount} 个 agent 正在干活`
        : overview
          ? `设备在线 ${overview.online}/${overview.devices} · 一切安稳`
          : "正在连接控制台…";

  return (
    <div className="app-shell">
      <div className="noise-layer" />
      <div
        className={`drawer-backdrop${drawerOpen ? " open" : ""}`}
        onClick={() => setDrawerOpen(false)}
      />

      {/* Sidebar */}
      <aside className={`sidebar${drawerOpen ? " open" : ""}`}>
        <div className="sidebar-panel">
          <div className="brand-header">
            <img className="brand-logo" src={assetUrl("brand/logo-160.webp")} alt="Herdr Pocket" />
            <div className="grow">
              <h1 className="brand-title">Herdr Pocket</h1>
              <div className="faint num">
                {overview ? `v${overview.uiVersion || overview.version} · 已运行 ${fmtUptime(overview.startedAt)}` : "连接中…"}
              </div>
            </div>
          </div>

          <nav className="nav-list" aria-label="控制台导航">
            {ROUTE_META.map((item) => {
              const badge =
                item.id === "overview" && blockedCount > 0
                  ? `${blockedCount} 等你`
                  : item.id === "devices"
                    ? `${overview?.online ?? 0}/${overview?.devices ?? 0}${pendingJoins ? ` · +${pendingJoins}` : ""}`
                    : item.id === "voice" && overview?.voice?.voice
                      ? overview.voice.voice
                      : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-route={item.id}
                  className={`nav-btn${route === item.id ? " active" : ""}`}
                  onClick={() => navigate(item.id)}
                >
                  {ROUTE_ICON[item.id](17)}
                  <span>{item.label}</span>
                  {badge ? <span className="nav-badge num">{badge}</span> : null}
                </button>
              );
            })}
          </nav>

          {/* Mini Xiaoyang companion pod in sidebar */}
          <div className="sidebar-mascot-pod">
            <XiaoyangOrb
              mood={blockedCount > 0 ? "waiting" : workingCount > 0 ? "working" : "default"}
              size={48}
            />
            <div className="grow">
              <div style={{ fontWeight: 800, fontSize: 13 }}>{config?.name || "小羊"} 在岗</div>
              <div className="faint truncate">
                {overview?.voice?.voice ? `语音音色：${overview.voice.voice}` : "仅文字调度"}
              </div>
            </div>
          </div>

          <div className="sidebar-foot">
            <button type="button" className="nav-btn" onClick={handleToggleTheme}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
              <span>{dark ? "切换到浅色模式" : "切换到暗夜模式"}</span>
            </button>
            <button type="button" className="nav-btn" onClick={() => logout("")}>
              <LogOut size={17} />
              <span>退出登录</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Column */}
      <div className="main-col">
        <header className="topbar">
          <div className="row grow" style={{ minWidth: 0 }}>
            <PocketIconButton
              className="menu-mobile-btn"
              tooltip="菜单"
              onClick={() => setDrawerOpen((v) => !v)}
            >
              <Menu size={18} />
            </PocketIconButton>
            <div className="topbar-greeting grow">
              <h2>{greetingNow()}</h2>
              <span className="faint truncate">{subtitle}</span>
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="cmd-trigger" onClick={() => setCmdOpen(true)}>
              <Search size={14} />
              <span className="cmd-label">快速跳转…</span>
              <span className="kbd">⌘K</span>
            </button>

            <PocketIconButton tooltip={dark ? "浅色模式" : "暗夜模式"} onClick={handleToggleTheme}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </PocketIconButton>

            <PocketButton
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={() =>
                loadAll(true)
                  .then(() => toast("所有状态已刷新"))
                  .catch((e) => toast((e as Error).message, true))
              }
            >
              <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
              <span>刷新</span>
            </PocketButton>
          </div>
        </header>

        <main className="page-content">
          {route === "overview" && overview ? (
            <OverviewView
              overview={overview}
              devices={devices}
              dark={dark}
              onReload={() => loadAll(false)}
              onGoVoice={() => navigate("voice")}
              onGoDevices={() => navigate("devices")}
            />
          ) : null}

          {route === "devices" && overview ? (
            <DevicesView
              devices={devices}
              joins={overview.joins}
              pairModalOpen={pairModalOpen}
              onPairModalChange={setPairModalOpen}
              onReload={() => loadAll(false)}
            />
          ) : null}

          {route === "models" && config ? (
            <ModelsView config={config} onConfigUpdated={(c) => setConfig(c)} />
          ) : null}

          {route === "voice" && config ? (
            <VoiceView
              config={config}
              onConfigUpdated={(c) => {
                setConfig(c);
                loadAll(false).catch(() => {});
              }}
            />
          ) : null}

          {route === "prompts" ? (
            <PromptsView prompts={prompts} onPromptsUpdated={setPrompts} />
          ) : null}

          {route === "logs" ? <LogsView devices={devices} /> : null}

          <PocketRibbonFooter version={overview?.uiVersion || overview?.version} protocol={overview?.protocol} />
        </main>
      </div>

      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        agents={overview?.agentList ?? []}
        devices={devices}
        dark={dark}
        onNavigate={navigate}
        onToggleTheme={() => applyTheme(!dark)}
        onOpenPair={() => setPairModalOpen(true)}
      />
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <ConsoleInner />
    </ToastProvider>
  );
}
