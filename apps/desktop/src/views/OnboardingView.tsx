import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bell, Check, Circle, MessageSquare, Smartphone, Sparkles, X } from "lucide-react";
import { PocketButton, useToast } from "../components/PocketUI";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import { ConnectRelayPanel, RELAY_EXPLAINER } from "../components/ConnectRelayPanel";
import { PairPhonePanel } from "../components/PairPhoneModal";
import { LocalHostDeps, missingRequiredDeps } from "../components/LocalHostDeps";
import { VoiceInputSetup } from "../components/VoiceInput";
import { serverLabel } from "../components/Sidebar";
import { defaultDeviceName, getHostdStatus, isTauri, type HostdLocalStatus } from "../lib/bridge";
import { completePairing } from "../lib/relay";
import { DEMO_URL, isMockServer } from "../lib/mock";
import { assetUrl } from "../lib/bridge";
import { TextScaleStepper } from "./settings/FramePanes";
import "../styles/welcome.css";
import { liveStore, settingsStore, updateSettings } from "../lib/store";
import { logger } from "../lib/log";
import { tierFor } from "../lib/layout";

export type OnboardStep = "welcome" | "local" | "relay" | "phone" | "voice" | "done";
const ORDER: OnboardStep[] = ["welcome", "local", "relay", "phone", "voice", "done"];
const TITLES: Record<OnboardStep, string> = {
  welcome: "欢迎使用 Herdr Pocket",
  local: "检查这台电脑",
  relay: "连接中转服务器",
  phone: "扫码连接手机",
  voice: "语音输入（可选）",
  done: "都准备好了",
};

/** Step headings inside the desktop welcome frame (its header already says 欢迎使用). */
const FRAME_TITLES: Record<OnboardStep, string> = {
  ...TITLES,
  welcome: "一个窗口，看住每台电脑上的 Agent",
};

const FEATURES = [
  { icon: Bell, title: "需要你的时候会说", line: "Agent 停下来等你回复时，侧栏和手机都会提示。" },
  { icon: MessageSquare, title: "直接回复、看终端", line: "不用切回那台电脑：在这里发消息、发图片、看屏幕输出。" },
  { icon: Smartphone, title: "手机扫码随身看", line: "扫一下就能在手机上接着看，还能用语音和小羊对话。" },
];

/**
 * First-run guide (docs/design/desktop-v2.md section 5). Full screen when there is no
 * session yet; an overlay over the app when reopened from Settings or resumed after the
 * automatic local login. Every step can go back or be skipped.
 */
export function OnboardingView({
  initialStep = "welcome",
  initialError = null,
  overlay = false,
  frame = false,
  onClose,
}: {
  initialStep?: OnboardStep;
  initialError?: string | null;
  overlay?: boolean;
  /** Desktop shell v3: a Herdr-style welcome frame over the window (docs/design/desktop-v2.md). */
  frame?: boolean;
  onClose: (finished: boolean) => void;
}) {
  const theme = settingsStore.use((s) => s.theme);
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const deviceId = settingsStore.use((s) => s.deviceId);
  const devices = liveStore.use((s) => s.devices);
  const [step, setStep] = useState<OnboardStep>(initialStep);
  const [local, setLocal] = useState<HostdLocalStatus | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [skipped, setSkipped] = useState<Set<OnboardStep>>(new Set());
  const [busyDemo, setBusyDemo] = useState(false);
  const phoneSince = useRef(Date.now());
  const [phoneName, setPhoneName] = useState<string | null>(null);

  const connected = Boolean(server && !isMockServer(server));
  const idx = ORDER.indexOf(step);

  const recheck = async () => {
    setChecking(true);
    setLocal(await getHostdStatus());
    setChecking(false);
  };

  useEffect(() => {
    void recheck();
  }, []);

  useEffect(() => {
    logger.info("onboarding", `step ${step}`);
    if (step === "phone") phoneSince.current = Date.now();
  }, [step]);

  // A phone that joins while the QR step is open is this guide's doing: say so.
  const newPhone = useMemo(() => {
    if (step !== "phone") return null;
    return (
      Object.values(devices).find(
        (d) => d.kind === "viewer" && d.id !== deviceId && d.createdAt >= phoneSince.current - 5_000,
      ) ?? null
    );
  }, [devices, deviceId, step]);

  useEffect(() => {
    if (newPhone) setPhoneName(newPhone.name);
  }, [newPhone]);

  const go = (to: OnboardStep) => setStep(to);
  const next = () => go(ORDER[Math.min(ORDER.length - 1, idx + 1)]!);
  const back = () => go(ORDER[Math.max(0, idx - 1)]!);
  const skip = () => {
    setSkipped((prev) => new Set(prev).add(step));
    next();
  };

  const finish = () => {
    updateSettings({ onboarding: "done" });
    logger.info("onboarding", `finished; skipped: ${[...skipped].join(", ") || "none"}`);
    onClose(true);
  };

  const close = () => {
    // Closing before the end leaves the guide for later; Settings can reopen it.
    if (settingsStore.get().onboarding !== "done") updateSettings({ onboarding: "later" });
    onClose(false);
  };

  const enterDemo = async () => {
    setBusyDemo(true);
    try {
      await completePairing(DEMO_URL, "DEMO-0000", defaultDeviceName());
      updateSettings({ onboarding: "later" });
      toast(
        tierFor(window.innerWidth) === "mobile"
          ? "这是演示模式：数据都是假的，随时可以在“设置 → 连接”里连接真的服务器"
          : "这是演示模式：数据都是假的，随时可以点左下角的“连接中转服务器”换成真的",
      );
      onClose(false);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusyDemo(false);
    }
  };

  // Without a server, the app can't open behind the guide: the relay step has no "skip",
  // only the demo as the other way out.
  const canSkip = step !== "welcome" && step !== "done" && !(step === "relay" && !server);
  const canClose = overlay || Boolean(server);

  let body: React.ReactNode = null;
  let primary: React.ReactNode = null;

  switch (step) {
    case "welcome":
      body = frame ? (
        <div className="wf-welcome">
          <p className="wf-lead">
            Agent 在你自己的电脑上运行，Pocket 把它们集中到一个窗口里。关掉这个窗口，它们照常工作；换台电脑或拿起手机，也能接着看。
          </p>
          <div className="wf-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="wf-feature">
                <span className="wf-feature-icon">
                  <f.icon size={15} />
                </span>
                <div className="grow">
                  <div className="wf-feature-title">{f.title}</div>
                  <div className="wf-feature-line">{f.line}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="wf-look">
            <div className="wf-look-row">
              <span className="wf-look-label">外观</span>
              <div className="wf-seg" role="radiogroup" aria-label="外观">
                {(
                  [
                    ["system", "跟随系统"],
                    ["light", "浅色"],
                    ["dark", "暗色"],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} role="radio" aria-checked={theme === v} className={theme === v ? "on" : ""} onClick={() => updateSettings({ theme: v })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="wf-look-row">
              <span className="wf-look-label">大小</span>
              <TextScaleStepper className="wf-stepper" />
            </div>
          </div>
        </div>
      ) : (
        <div className="onboard-hero">
          <XiaoyangOrb mood="hello" size={112} />
          <ul className="feature-list">
            <li><Check size={16} /> 一处看到所有电脑上的 Agent：谁在干活、谁在等你</li>
            <li><Check size={16} /> 直接回复、发指令、看终端，不用切回那台电脑</li>
            <li><Check size={16} /> 手机扫码就能随身查看，还能语音和小羊对话</li>
          </ul>
          <div className="faint">接下来几步大约 2 分钟，每一步都能跳过，之后在“设置”里能重新打开。</div>
        </div>
      );
      primary = (
        <>
          <PocketButton variant="ghost" disabled={busyDemo} onClick={() => void enterDemo()}>
            <Sparkles size={15} />
            <span>{busyDemo ? "正在进入…" : "先随便看看（演示模式）"}</span>
          </PocketButton>
          <PocketButton variant="primary" size="lg" onClick={next}>
            <span>{frame ? "下一步" : "开始设置"}</span>
            <ArrowRight size={16} />
          </PocketButton>
        </>
      );
      break;

    case "local":
      body =
        local === undefined ? (
          <div className="muted">正在检查这台电脑…</div>
        ) : local === null ? (
          <div className="stack">
            <div className="muted">
              {isTauri() ? "没读到这台电脑的 herdr-pocket 状态。" : "当前不是桌面版，不需要检查本机。"}
              只想查看别的电脑上的 Agent，直接下一步就行。
            </div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="muted">
              {local.configured
                ? `这台电脑已登录 herdr-pocket（${local.deviceName || "本机"}），它的 Agent 会自动出现在 Pocket 里。`
                : missingRequiredDeps(local)
                  ? "要让这台电脑上的 Agent 出现在 Pocket 里，标红的程序都要装好。只想看别的电脑，可以跳过。"
                  : "程序都装好了，还差登录：连上中转服务器后，在终端运行 herdr-pocket up 即可。"}
            </div>
            <LocalHostDeps status={local} server={connected ? server ?? undefined : local.server} checking={checking} onRecheck={() => void recheck()} />
          </div>
        );
      primary = (
        <PocketButton variant="primary" size="lg" onClick={next}>
          <span>下一步</span>
          <ArrowRight size={16} />
        </PocketButton>
      );
      break;

    case "relay":
      body = (
        <div className="stack" style={{ gap: 14 }}>
          <div className="explainer">{RELAY_EXPLAINER}</div>
          {connected ? (
            <div className="choice-card primary">
              <div className="grow">
                <div className="choice-title">已连接：{serverLabel(server)}</div>
                <div className="faint">要换一个服务器，可以在下面重新连接。</div>
              </div>
              <Check size={18} />
            </div>
          ) : null}
          <ConnectRelayPanel initialError={initialError} autoFocus onConnected={() => go("phone")} />
        </div>
      );
      primary = connected ? (
        <PocketButton variant="primary" size="lg" onClick={next}>
          <span>下一步</span>
          <ArrowRight size={16} />
        </PocketButton>
      ) : (
        <PocketButton variant="ghost" disabled={busyDemo} onClick={() => void enterDemo()}>
          <Sparkles size={15} />
          <span>暂时没有服务器，先看演示</span>
        </PocketButton>
      );
      break;

    case "phone":
      body = (
        <div className="stack" style={{ gap: 14 }}>
          {newPhone ? (
            <div className="choice-card primary">
              <div className="grow">
                <div className="choice-title">手机连上了：{newPhone.name}</div>
                <div className="faint">之后在“设备”页能看到它，也能随时移除。</div>
              </div>
              <Check size={18} />
            </div>
          ) : null}
          <PairPhonePanel onNeedRelay={() => go("relay")} />
        </div>
      );
      primary = (
        <PocketButton variant={newPhone ? "primary" : "soft"} size="lg" onClick={next}>
          <span>{newPhone ? "下一步" : "手机连上了"}</span>
          <ArrowRight size={16} />
        </PocketButton>
      );
      break;

    case "voice":
      body = <VoiceInputSetup compact />;
      primary = (
        <PocketButton variant="primary" size="lg" onClick={next}>
          <span>下一步</span>
          <ArrowRight size={16} />
        </PocketButton>
      );
      break;

    case "done": {
      const rows: Array<{ label: string; ok: boolean; note: string }> = [
        { label: "这台电脑", ok: Boolean(local?.configured), note: local?.configured ? "已登录" : "未登录，只查看别的电脑" },
        { label: "中转服务器", ok: connected, note: connected ? serverLabel(server) : "未连接" },
        { label: "手机", ok: Boolean(phoneName), note: phoneName ?? (skipped.has("phone") ? "已跳过，随时可在侧栏扫码连接" : "随时可在侧栏扫码连接") },
        { label: "语音输入", ok: !skipped.has("voice"), note: skipped.has("voice") ? "已跳过，可在 设置 › 语音输入 开启" : "可在 设置 › 语音输入 调整" },
      ];
      body = (
        <div className="stack" style={{ gap: 14 }}>
          <div className={frame ? "wf-mascot" : "onboard-hero compact"}>
            <XiaoyangOrb mood="yay" size={frame ? 80 : 92} />
          </div>
          <div className="summary-list">
            {rows.map((r) => (
              <div key={r.label} className="summary-row">
                {r.ok ? <Check size={16} className="ok" /> : <Circle size={14} className="dim" />}
                <span className="summary-label">{r.label}</span>
                <span className="faint grow truncate">{r.note}</span>
              </div>
            ))}
          </div>
        </div>
      );
      primary = (
        <PocketButton variant="primary" size="lg" onClick={finish}>
          <span>进入 Pocket</span>
          <ArrowRight size={16} />
        </PocketButton>
      );
      break;
    }
  }

  if (frame) {
    return (
      // The frame covers the shell's drag regions, so its backdrop and header move the window (macOS overlay title bar).
      <div className="wf-root" role="dialog" aria-modal="true" aria-label="新手引导" data-tauri-drag-region>
        <div className="wf-card">
          <header className="wf-head" data-tauri-drag-region="deep">
            <img src={assetUrl("brand/logo-160.webp")} alt="" width={18} height={18} />
            <span className="wf-head-title">欢迎使用 Herdr Pocket</span>
            <span className="wf-beta">BETA</span>
            <span className="grow" />
            {canClose ? (
              <button className="wf-x" onClick={close} aria-label="关闭引导，稍后再说" title="稍后再说（设置 › 关于 里能重新打开）">
                <X size={15} />
              </button>
            ) : null}
          </header>
          <div className="wf-body">
            <h2 className="wf-title">{FRAME_TITLES[step]}</h2>
            {body}
          </div>
          <footer className="wf-foot">
            <div className="wf-dots" aria-label={`第 ${idx + 1} 步，共 ${ORDER.length} 步`}>
              {ORDER.map((s, i) => (
                <span key={s} className={`wf-dot${i === idx ? " on" : i < idx ? " past" : ""}`} />
              ))}
            </div>
            <span className="grow" />
            {idx > 0 ? (
              <button className="wf-text-btn" onClick={back}>
                <ArrowLeft size={14} />
                <span>上一步</span>
              </button>
            ) : null}
            {canSkip ? (
              <button className="wf-text-btn" onClick={skip}>
                跳过
              </button>
            ) : null}
            {primary}
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className={`onboard-root${overlay ? " overlay" : ""}`} role="dialog" aria-modal={overlay} aria-label="新手引导">
      <div className="onboard-card">
        <header className="onboard-head">
          <div className="onboard-dots" aria-label={`第 ${idx + 1} 步，共 ${ORDER.length} 步`}>
            {ORDER.map((s, i) => (
              <span key={s} className={`onboard-dot${i === idx ? " on" : i < idx ? " past" : ""}`} />
            ))}
          </div>
          {canClose ? (
            <button className="side-icon-btn" onClick={close} aria-label="关闭引导，稍后再说">
              <X size={16} />
            </button>
          ) : null}
        </header>
        <h1 className="onboard-title cute-font">{TITLES[step]}</h1>
        <div className="onboard-body">{body}</div>
        <footer className="onboard-foot">
          {idx > 0 ? (
            <PocketButton variant="ghost" onClick={back}>
              <ArrowLeft size={15} />
              <span>上一步</span>
            </PocketButton>
          ) : (
            <span />
          )}
          <div className="row wrap" style={{ gap: 8, justifyContent: "flex-end" }}>
            {canSkip ? (
              <button className="link-btn" onClick={skip}>
                跳过这一步
              </button>
            ) : null}
            {primary}
          </div>
        </footer>
      </div>
    </div>
  );
}
