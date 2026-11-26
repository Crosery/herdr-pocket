import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CheckCircle2,
  Compass,
  Globe,
  GraduationCap,
  Laptop,
  Maximize2,
  MessageSquare,
  QrCode,
  Radio,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { createStore } from "../lib/store";
import { XiaoyangOrb } from "./MascotAndVendor";
import { PocketButton, overlayStore } from "./PocketUI";
import "../styles/tutorial.css";

export type TutorialMode = "auto" | "replay";

export const tutorialReplayStore = createStore<{ open: boolean }>({ open: false });

export function openInteractiveTutorialReplay(): void {
  tutorialReplayStore.set({ open: true });
}

export function closeInteractiveTutorialReplay(): void {
  tutorialReplayStore.set({ open: false });
}

interface SandboxState {
  step: number; // 0..4 (5 interactive steps), 5 = completion celebration
  selectedAgentId: "a1" | "a2";
  decisionPicked: boolean;
  pipExpanded: boolean;
  paneMode: "chat" | "term";
  assistantOpen: boolean;
  pulseCount: number;
}

type SandboxAction =
  | { type: "PICK_AGENT"; id: "a1" | "a2" }
  | { type: "PICK_DECISION" }
  | { type: "INSPECT_PIP" }
  | { type: "TOGGLE_MODE" }
  | { type: "OPEN_ASSISTANT" }
  | { type: "PREV_STEP" }
  | { type: "NEXT_STEP" }
  | { type: "PULSE_TARGET" };

const INITIAL_SANDBOX: SandboxState = {
  step: 0,
  selectedAgentId: "a2",
  decisionPicked: false,
  pipExpanded: false,
  paneMode: "chat",
  assistantOpen: false,
  pulseCount: 0,
};

function sandboxReducer(s: SandboxState, a: SandboxAction): SandboxState {
  switch (a.type) {
    case "PICK_AGENT":
      return {
        ...s,
        selectedAgentId: a.id,
        step: s.step === 0 && a.id === "a1" ? 1 : s.step,
      };
    case "PICK_DECISION":
      return {
        ...s,
        selectedAgentId: "a1",
        decisionPicked: true,
        step: s.step === 1 ? 2 : s.step,
      };
    case "INSPECT_PIP":
      return {
        ...s,
        decisionPicked: true,
        pipExpanded: true,
        step: s.step === 2 ? 3 : s.step,
      };
    case "TOGGLE_MODE":
      return {
        ...s,
        paneMode: s.paneMode === "chat" ? "term" : "chat",
        step: s.step === 3 ? 4 : s.step,
      };
    case "OPEN_ASSISTANT":
      return {
        ...s,
        assistantOpen: true,
        step: s.step === 4 ? 5 : s.step,
      };
    case "PREV_STEP": {
      const prev = Math.max(0, s.step - 1);
      return {
        ...s,
        step: prev,
        selectedAgentId: prev === 0 ? "a2" : "a1",
        decisionPicked: prev >= 2,
        pipExpanded: prev >= 3,
        paneMode: prev >= 4 ? "term" : "chat",
        assistantOpen: false,
      };
    }
    case "NEXT_STEP": {
      const next = Math.min(5, s.step + 1);
      return {
        ...s,
        step: next,
        selectedAgentId: next >= 1 ? "a1" : "a2",
        decisionPicked: next >= 2,
        pipExpanded: next >= 3,
        paneMode: next >= 4 ? "term" : "chat",
        assistantOpen: next >= 5,
      };
    }
    case "PULSE_TARGET":
      return { ...s, pulseCount: s.pulseCount + 1 };
    default:
      return s;
  }
}

interface StepDef {
  targetId: string;
  badge: string;
  title: string;
  body: string;
  actionHint: string;
}

const TUTORIAL_STEPS: StepDef[] = [
  {
    targetId: "tut-agent-blocked",
    badge: "认识助手状态",
    title: "点开正在「等你拍板」的助手",
    body: "左侧列出电脑上所有干活的 AI 助手。带粉色提示的「整理活动宣传页」遇到了选择题，点它查看详情。",
    actionHint: "点击左侧高亮的「整理活动宣传页」",
  },
  {
    targetId: "tut-decision-opt",
    badge: "一键替 AI 拍板",
    title: "选一个方案，让 AI 继续干活",
    body: "不用自己敲复杂命令。直接点一下推荐方案，AI 就会立刻按你的决定继续生成页面。",
    actionHint: "点击高亮的「方案 A · 清爽粉白卡片风（推荐）」",
  },
  {
    targetId: "tut-live-pip",
    badge: "成果实时浮窗",
    title: "看看右上角弹出的实时预览",
    body: "当 AI 启动了本地网页、打开了文件或浏览器，右上角会自动浮出小窗，点一下就能展开看效果。",
    actionHint: "点击右上角高亮的「实时预览小浮窗」",
  },
  {
    targetId: "tut-mode-toggle",
    badge: "对话与终端翻面",
    title: "一键切换「对话」和「终端」",
    body: "平时用聊天气泡最省心；如果想看底层运行日志或敲命令，随时点右上角翻面到终端视图。",
    actionHint: "点击高亮的「切换终端」按钮",
  },
  {
    targetId: "tut-assistant-btn",
    badge: "小羊全局管家",
    title: "喊「小羊」帮你汇总全部进度",
    body: "电脑上开了十几个任务也不用一个个翻。点右上角「小羊」就能一次看清所有进展，还能顺便通过左下角扫码连手机随时看。",
    actionHint: "点击右上角高亮的「小羊」按钮完成新手关卡",
  },
];

interface TargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function TutorialSandboxStage({
  mode,
  onComplete,
  onSkip,
}: {
  mode: TutorialMode;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [sb, dispatch] = useReducer(sandboxReducer, INITIAL_SANDBOX);
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [exiting, setExiting] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const maskId = "tut-spotlight-mask";

  const isFinished = sb.step >= TUTORIAL_STEPS.length;
  const activeStep = !isFinished ? TUTORIAL_STEPS[sb.step]! : null;

  const finishAndClose = useCallback(
    (kind: "complete" | "skip") => {
      if (exiting) return;
      setExiting(true);
      window.setTimeout(() => {
        if (kind === "complete") onComplete();
        else onSkip();
      }, 180);
    },
    [exiting, onComplete, onSkip],
  );

  // Isolate Tauri native WebViews & capture global keyboard shortcuts so real workspace is never touched.
  useEffect(() => {
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        finishAndClose(isFinished ? "complete" : "skip");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && ["k", "p", "t", "w", "n", ",", "1", "2", "3", "4", "5"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKeyCapture, true);
    return () => {
      window.removeEventListener("keydown", onKeyCapture, true);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [finishAndClose, isFinished]);

  // Track highlighted element bounds inside sandbox stage smoothly.
  const measureTarget = useCallback(() => {
    if (!activeStep || !stageRef.current) {
      setRect(null);
      return;
    }
    const el = stageRef.current.querySelector<HTMLElement>(`[data-tut-target="${activeStep.targetId}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    setRect({
      left: Math.max(4, r.left - pad),
      top: Math.max(4, r.top - pad),
      width: Math.max(24, r.width + pad * 2),
      height: Math.max(24, r.height + pad * 2),
    });
  }, [activeStep]);

  useLayoutEffect(() => {
    measureTarget();
    const raf = requestAnimationFrame(measureTarget);
    const t = window.setTimeout(measureTarget, 120);
    window.addEventListener("resize", measureTarget);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      window.removeEventListener("resize", measureTarget);
    };
  }, [measureTarget, sb.step, sb.decisionPicked, sb.paneMode, sb.pipExpanded]);

  // Auto-position guide card without overlapping the highlighted target.
  const cardStyle = (() => {
    if (!rect || typeof window === "undefined") return undefined;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = Math.min(340, vw - 24);
    const cardH = 210;
    const gap = 16;

    // Try right of target, then left, then below, then above
    if (rect.left + rect.width + gap + cardW <= vw - 12) {
      return {
        left: Math.round(rect.left + rect.width + gap),
        top: Math.round(Math.max(58, Math.min(vh - cardH - 16, rect.top))),
        width: cardW,
      };
    }
    if (rect.left - gap - cardW >= 12) {
      return {
        left: Math.round(rect.left - gap - cardW),
        top: Math.round(Math.max(58, Math.min(vh - cardH - 16, rect.top))),
        width: cardW,
      };
    }
    if (rect.top + rect.height + gap + cardH <= vh - 12) {
      return {
        left: Math.round(Math.max(12, Math.min(vw - cardW - 12, rect.left))),
        top: Math.round(rect.top + rect.height + gap),
        width: cardW,
      };
    }
    return {
      left: Math.round(Math.max(12, Math.min(vw - cardW - 12, rect.left))),
      top: Math.round(Math.max(58, rect.top - gap - cardH)),
      width: cardW,
    };
  })();

  const content = (
    <div
      ref={stageRef}
      className={`tut-overlay${exiting ? " is-exiting" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Herdr Pocket 新手互动练习"
    >
      {/* Top sandbox safety ribbon + persistent exit button (clears macOS traffic lights) */}
      <div className="tut-top-ribbon">
        <div className="tut-top-pill">
          <GraduationCap size={14} />
          <span>新手练习模式</span>
          <span className="tut-top-sep">·</span>
          <span className="tut-top-sub">模拟演示环境，不会改动你的任何真实文件与任务</span>
        </div>
        <button
          type="button"
          className="tut-skip-btn"
          onClick={() => finishAndClose(mode === "replay" ? "complete" : "skip")}
        >
          <span>{mode === "replay" ? "退出重温" : "先不看，直接用"}</span>
          <X size={14} />
        </button>
      </div>

      {/* Simulated isolated Pocket workspace (never touches liveStore / shellStore) */}
      <div className="tut-sandbox-frame" aria-hidden={isFinished}>
        {/* Simulated Left Sidebar */}
        <aside className="tut-sim-sidebar">
          <div className="tut-sim-brand">
            <XiaoyangOrb mood="hello" size={22} />
            <span className="cute-font">Herdr Pocket</span>
          </div>

          <div className="tut-sim-sec-label">示例空间</div>
          <div className="tut-sim-space active">
            <Compass size={13} />
            <span>周末活动海报</span>
            <span className="tut-sim-badge num">2</span>
          </div>

          <div className="tut-sim-sec-label">AI 助手 · 2</div>
          <button
            type="button"
            data-tut-target="tut-agent-blocked"
            className={`tut-sim-agent${sb.selectedAgentId === "a1" ? " active" : ""}${!sb.decisionPicked ? " needs-you" : ""}`}
            onClick={() => dispatch({ type: "PICK_AGENT", id: "a1" })}
          >
            <div className="tut-sim-agent-row">
              <span className="tut-sim-agent-title truncate">整理活动宣传页</span>
              <span className={`tut-sim-status ${sb.decisionPicked ? "working" : "blocked"}`}>
                {sb.decisionPicked ? "干活中" : "需要你"}
              </span>
            </div>
            <div className="tut-sim-agent-meta">
              <Laptop size={11} />
              <span>示例电脑 · Claude Code</span>
            </div>
          </button>

          <button
            type="button"
            className={`tut-sim-agent${sb.selectedAgentId === "a2" ? " active" : ""}`}
            onClick={() => dispatch({ type: "PICK_AGENT", id: "a2" })}
          >
            <div className="tut-sim-agent-row">
              <span className="tut-sim-agent-title truncate">检查接口单元测试</span>
              <span className="tut-sim-status done">已完成</span>
            </div>
            <div className="tut-sim-agent-meta">
              <Laptop size={11} />
              <span>示例电脑 · Codex</span>
            </div>
          </button>

          <div className="tut-sim-side-foot">
            <div className="tut-sim-qr-hint">
              <QrCode size={13} />
              <span>扫码连手机 · 出门随时看</span>
            </div>
          </div>
        </aside>

        {/* Simulated Main Work Area */}
        <main className="tut-sim-main">
          <header className="tut-sim-topbar">
            <div className="tut-sim-tab active">
              <Sparkles size={13} />
              <span>{sb.selectedAgentId === "a1" ? "整理活动宣传页" : "检查接口单元测试"}</span>
            </div>
            <div className="tut-sim-topbar-right">
              <button
                type="button"
                data-tut-target="tut-assistant-btn"
                className={`tut-sim-top-btn${sb.assistantOpen ? " active" : ""}`}
                onClick={() => dispatch({ type: "OPEN_ASSISTANT" })}
              >
                <Sparkles size={13} />
                <span>小羊</span>
              </button>
            </div>
          </header>

          <div className="tut-sim-pane">
            <div className="tut-sim-pane-head">
              <span className="tut-sim-pane-title truncate">
                {sb.selectedAgentId === "a1" ? "周末活动海报 · 整理活动宣传页" : "周末活动海报 · 检查接口单元测试"}
              </span>
              <div className="tut-sim-pane-right">
                {sb.decisionPicked ? (
                  <span className="tut-sim-port-pill mono">
                    <Radio size={11} />
                    <span>:5173</span>
                  </span>
                ) : null}
                <button
                  type="button"
                  data-tut-target="tut-mode-toggle"
                  className={`tut-sim-mode-btn${sb.paneMode === "term" ? " active" : ""}`}
                  onClick={() => dispatch({ type: "TOGGLE_MODE" })}
                >
                  {sb.paneMode === "chat" ? <Terminal size={13} /> : <MessageSquare size={13} />}
                  <span>{sb.paneMode === "chat" ? "切到终端" : "切回对话"}</span>
                </button>
              </div>
            </div>

            <div className="tut-sim-pane-body">
              {/* Auto-popping Floating Live Preview PiP (appears from Step 2 onwards) */}
              {sb.decisionPicked ? (
                <button
                  type="button"
                  data-tut-target="tut-live-pip"
                  className={`tut-sim-pip${sb.pipExpanded ? " expanded" : ""}`}
                  onClick={() => dispatch({ type: "INSPECT_PIP" })}
                >
                  <div className="tut-sim-pip-head">
                    <Globe size={12} />
                    <span className="truncate">localhost:5173 · 活动宣传页</span>
                    <Maximize2 size={11} />
                  </div>
                  <div className="tut-sim-pip-preview">
                    <div className="tut-sim-poster-badge">LIVE PREVIEW</div>
                    <div className="tut-sim-poster-title">春日开放日 · 周末见</div>
                    <div className="tut-sim-poster-sub">
                      {sb.pipExpanded ? "已实时同步最新页面，可点击放大交互" : "点击预览小窗查看实时成果"}
                    </div>
                  </div>
                </button>
              ) : null}

              {sb.paneMode === "term" ? (
                <div className="tut-sim-term mono">
                  <div className="tut-term-line faint">$ pnpm dev --port 5173</div>
                  <div className="tut-term-line mint">VITE v6.1 ready in 210 ms</div>
                  <div className="tut-term-line">➜ Local: http://localhost:5173/</div>
                  <div className="tut-term-line pink">✓ 已按「方案 A · 清爽粉白卡片风」更新首页组件</div>
                  <div className="tut-term-line">✓ 自动截图校验完成 · 等待下一步指令…</div>
                </div>
              ) : sb.selectedAgentId === "a1" ? (
                <div className="tut-sim-chat">
                  <div className="tut-bubble user">帮我把周末活动宣传页整理好，并起一个本地预览。</div>
                  <div className="tut-bubble assistant">
                    我准备了两套视觉配色方案，请你拍板选一个，选完我立刻生成并启动预览：
                  </div>

                  <div className="tut-ask-card">
                    <div className="tut-ask-head">
                      <span className="tut-ask-pill">需要你选择</span>
                      <span className="faint">点一下即可继续</span>
                    </div>
                    <button
                      type="button"
                      data-tut-target="tut-decision-opt"
                      className={`tut-ask-opt${sb.decisionPicked ? " picked" : ""}`}
                      onClick={() => dispatch({ type: "PICK_DECISION" })}
                    >
                      <span className="tut-ask-key">{sb.decisionPicked ? <Check size={12} /> : "1"}</span>
                      <span className="tut-ask-copy">
                        <strong>方案 A · 清爽粉白卡片风（推荐）</strong>
                        <span className="faint">重点突出活动时间、报名按钮与移动端适配</span>
                      </span>
                    </button>
                    <div className="tut-ask-opt muted-opt">
                      <span className="tut-ask-key">2</span>
                      <span className="tut-ask-copy">
                        <strong>方案 B · 深色极简海报风</strong>
                        <span className="faint">适合夜间展板投影展示</span>
                      </span>
                    </div>
                  </div>

                  {sb.decisionPicked ? (
                    <div className="tut-bubble assistant is-new">
                      收到！已按「方案 A」生成页面并启动本地服务 <code className="mono">:5173</code>，右上角小浮窗已同步画面。
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="tut-sim-chat">
                  <div className="tut-bubble user">跑一遍接口回归测试，确认没有报错。</div>
                  <div className="tut-bubble assistant">
                    24 项接口测试全部通过，耗时 3.2 秒。你可以去左侧点开带「需要你」标记的助手继续体验！
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {/* SVG Spotlight Mask + 4-Rect Click Blocker (when on active interactive step) */}
      {!isFinished && rect ? (
        <>
          <svg className="tut-mask-svg" aria-hidden="true">
            <defs>
              <mask id={maskId}>
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                <rect
                  x={rect.left}
                  y={rect.top}
                  width={rect.width}
                  height={rect.height}
                  rx="12"
                  ry="12"
                  fill="black"
                />
              </mask>
            </defs>
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              fill="rgba(22, 16, 30, 0.62)"
              mask={`url(#${maskId})`}
            />
          </svg>

          {/* 4-rect click blocker prevents clicking outside the spotlight while letting the target stay 100% interactive */}
          <div
            className="tut-blocker"
            style={{ top: 48, left: 0, right: 0, height: Math.max(0, rect.top - 48) }}
            onClick={() => dispatch({ type: "PULSE_TARGET" })}
          />
          <div
            className="tut-blocker"
            style={{ top: rect.top + rect.height, left: 0, right: 0, bottom: 0 }}
            onClick={() => dispatch({ type: "PULSE_TARGET" })}
          />
          <div
            className="tut-blocker"
            style={{ top: rect.top, left: 0, width: Math.max(0, rect.left), height: rect.height }}
            onClick={() => dispatch({ type: "PULSE_TARGET" })}
          />
          <div
            className="tut-blocker"
            style={{ top: rect.top, left: rect.left + rect.width, right: 0, height: rect.height }}
            onClick={() => dispatch({ type: "PULSE_TARGET" })}
          />

          <div
            key={`${sb.step}-${sb.pulseCount}`}
            className={`tut-spotlight-ring${sb.pulseCount > 0 ? " is-pulsing" : ""}`}
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
            aria-hidden="true"
          />
        </>
      ) : null}

      {/* Floating Guide Card for Steps 1..5 */}
      {!isFinished && activeStep ? (
        <div className="tut-guide-card" style={cardStyle} role="status" aria-live="polite">
          <div className="tut-guide-progress">
            <span className="tut-guide-step-badge">{activeStep.badge}</span>
            <span className="tut-guide-count mono">
              第 {sb.step + 1} / {TUTORIAL_STEPS.length} 步
            </span>
          </div>
          <div className="tut-progress-track" aria-hidden="true">
            <div
              className="tut-progress-fill"
              style={{ width: `${((sb.step + 1) / TUTORIAL_STEPS.length) * 100}%` }}
            />
          </div>
          <h3 className="tut-guide-title">{activeStep.title}</h3>
          <p className="tut-guide-body">{activeStep.body}</p>
          <div className="tut-guide-hint">{activeStep.actionHint}</div>
          <div className="tut-guide-foot">
            {sb.step > 0 ? (
              <PocketButton size="sm" variant="ghost" onClick={() => dispatch({ type: "PREV_STEP" })}>
                上一步
              </PocketButton>
            ) : (
              <span />
            )}
            <PocketButton size="sm" variant="soft" onClick={() => dispatch({ type: "NEXT_STEP" })}>
              {sb.step === TUTORIAL_STEPS.length - 1 ? "完成这一步" : "直接下一步"}
            </PocketButton>
          </div>
        </div>
      ) : null}

      {/* Completion Celebration Modal */}
      {isFinished ? (
        <div className="tut-finish-backdrop">
          <div className="tut-finish-card">
            <div className="tut-finish-orb">
              <XiaoyangOrb mood="hello" size={76} />
            </div>
            <div className="tut-finish-badge">
              <CheckCircle2 size={14} />
              <span>5 步全部通关</span>
            </div>
            <h2 className="cute-font tut-finish-title">太棒了，你已经上手 Herdr Pocket！</h2>
            <p className="tut-finish-desc">
              你已经学会了看 AI 状态、一键拍板派活、用浮窗看实时成果、切对话与终端，以及找小羊汇总进展。
            </p>
            <div className="tut-finish-remind">
              以后如果忘了操作，随时可以在左下角 <strong>「设置 → 重温互动教程」</strong> 里重新打开这个练习环境。
            </div>
            <div className="tut-finish-acts">
              <PocketButton variant="primary" onClick={() => finishAndClose("complete")}>
                {mode === "replay" ? "返回工作台" : "进入我的真实工作台"}
              </PocketButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(content, document.body);
}
