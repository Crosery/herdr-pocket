import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  Gauge,
  Mic,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  native,
  type VoiceAiEnrollEvent,
  type VoiceAiState,
  type VoiceAiTestEvent,
  type VoiceAiTier,
} from "../lib/native";
import {
  VOICEPRINT_SAMPLE_LINES,
  VOICEPRINT_SENSITIVITY_OPTIONS,
} from "../lib/voicePresets";
import {
  PocketBadge,
  PocketButton,
  PocketModal,
  PocketSelect,
  PocketSwitch,
  fs,
  useToast,
} from "./PocketUI";

type Phase = "idle" | "downloading" | "recording" | "finishing" | "testing";

export interface VoiceprintModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aiState: VoiceAiState;
  onStateChange: (next: VoiceAiState) => void;
}

function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const clamped = Math.max(0, Math.min(1, level));
  const bars = 16;
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: 28,
        padding: "0 10px",
        borderRadius: 10,
        border: "1px solid var(--divider)",
        background: "var(--surface)",
      }}
    >
      {Array.from({ length: bars }, (_, idx) => {
        const threshold = (idx + 1) / bars;
        const lit = active && clamped >= threshold * 0.72;
        const h = lit ? Math.max(8, Math.round(10 + clamped * 14 - Math.abs(idx - bars / 2) * 0.5)) : 5;
        return (
          <span
            key={idx}
            style={{
              flex: 1,
              height: h,
              borderRadius: 999,
              background: lit ? "var(--primary)" : "var(--surface-3)",
              transition: "height 90ms ease, background 120ms ease",
            }}
          />
        );
      })}
    </div>
  );
}

export function VoiceprintModal({
  open,
  onOpenChange,
  aiState,
  onStateChange,
}: VoiceprintModalProps) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("idle");
  const [dlLabel, setDlLabel] = useState("声纹模型");
  const [dlProgress, setDlProgress] = useState(0);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [recFull, setRecFull] = useState(false);
  const [testSpeaking, setTestSpeaking] = useState(false);
  const [testResult, setTestResult] = useState<VoiceAiTestEvent | null>(null);
  const [benchBusy, setBenchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askClear, setAskClear] = useState(false);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const stopTransientWork = useCallback(() => {
    const cur = phaseRef.current;
    if (cur === "downloading") void native.voiceAiCancelDownload();
    if (cur === "recording" || cur === "finishing") void native.voiceAiCancelEnroll();
    if (cur === "testing") void native.voiceAiStopTest();
    setPhase("idle");
    setLevel(0);
    setSeconds(0);
    setRecFull(false);
    setTestSpeaking(false);
  }, []);

  useEffect(() => {
    if (!open) {
      stopTransientWork();
      setError(null);
      setAskClear(false);
      setTestResult(null);
      return;
    }
    const offProg = native.onVoiceAiProgress((e) => {
      if (e.dlLabel) setDlLabel(e.dlLabel);
      setDlProgress(e.progress);
      if (e.dlError) setError(e.dlError);
      if (!e.downloading && e.done) {
        void native.voiceAiState().then(onStateChange);
      }
    });
    const offEnroll = native.onVoiceAiEnroll((e: VoiceAiEnrollEvent) => {
      setLevel(e.level);
      setSeconds(e.seconds);
      setRecFull(e.full);
    });
    const offTest = native.onVoiceAiTest((e: VoiceAiTestEvent) => {
      setLevel(e.level);
      setTestSpeaking(e.speaking);
      if (e.score !== undefined && e.pass !== undefined) {
        setTestResult(e);
      }
    });
    return () => {
      offProg();
      offEnroll();
      offTest();
    };
  }, [open, onStateChange, stopTransientWork]);

  const busy = phase !== "idle";

  const ensureModelForTier = async (target: "sv" | "tse"): Promise<boolean> => {
    const needSv = !aiState.svReady || !aiState.dpdfReady || !aiState.vadReady;
    const needTse = target === "tse" && !aiState.tseReady;
    if (!needSv && !needTse) return true;
    setError(null);
    setPhase("downloading");
    setDlLabel(
      target === "tse"
        ? `旗舰声纹分离包（约 ${aiState.tseSizeMb} MB）`
        : `灵巧声纹模型（约 ${aiState.svSizeMb} MB）`,
    );
    setDlProgress(0);
    try {
      const next = await native.voiceAiDownload(target);
      onStateChange(next);
      return true;
    } catch (e) {
      const msg = (e as Error).message || "模型下载失败";
      if (!/取消/.test(msg)) setError(msg);
      return false;
    } finally {
      setPhase((cur) => (cur === "downloading" ? "idle" : cur));
    }
  };

  const handleSelectTier = async (nextTier: VoiceAiTier) => {
    if (busy) return;
    setError(null);
    try {
      const updated = await native.voiceAiSetConfig({ tier: nextTier });
      onStateChange(updated);
      if (nextTier === "sv" && !updated.svReady) {
        await ensureModelForTier("sv");
      } else if (nextTier === "tse" && (!updated.svReady || !updated.tseReady)) {
        await ensureModelForTier("tse");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleBenchmark = async () => {
    if (benchBusy || busy) return;
    setBenchBusy(true);
    setError(null);
    try {
      await native.voiceAiBenchmark();
      onStateChange(await native.voiceAiState());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBenchBusy(false);
    }
  };

  const handleStartEnroll = async () => {
    if (busy) return;
    setError(null);
    setAskClear(false);
    const wantTse =
      aiState.tier === "tse" ||
      (aiState.tier === "auto" && aiState.recommendedTier === "tse");
    if (!(await ensureModelForTier(wantTse ? "tse" : "sv"))) return;
    try {
      setSeconds(0);
      setLevel(0);
      setRecFull(false);
      await native.voiceAiStartEnroll();
      setPhase("recording");
    } catch (e) {
      setError((e as Error).message || "无法开始录音");
      setPhase("idle");
    }
  };

  const handleFinishEnroll = async () => {
    if (phase !== "recording") return;
    setPhase("finishing");
    setError(null);
    try {
      const res = await native.voiceAiFinishEnroll();
      onStateChange(res.state);
      setPhase("idle");
      setLevel(0);
      toast(
        res.consistency < 0.55
          ? "声纹已录入，建议后续在更安静的环境重录一次"
          : "声纹已录入，已自动开启只认本人声音",
      );
    } catch (e) {
      setError((e as Error).message || "声纹录入失败");
      setPhase("idle");
      setLevel(0);
    }
  };

  const handleCancelEnroll = async () => {
    await native.voiceAiCancelEnroll();
    setPhase("idle");
    setLevel(0);
    setSeconds(0);
  };

  const handleStartTest = async () => {
    if (busy) return;
    setError(null);
    setTestResult(null);
    setTestSpeaking(false);
    if (!(await ensureModelForTier("sv"))) return;
    try {
      await native.voiceAiStartTest(aiState.threshold);
      setPhase("testing");
    } catch (e) {
      setError((e as Error).message || "无法开始声纹测试");
      setPhase("idle");
    }
  };

  const handleStopTest = async () => {
    await native.voiceAiStopTest();
    setPhase("idle");
    setLevel(0);
    setTestSpeaking(false);
  };

  const handleClearVoiceprint = async () => {
    setAskClear(false);
    try {
      const next = await native.voiceAiClearVoiceprint();
      onStateChange(next);
      setTestResult(null);
      toast("已清除本地声纹");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const activeSens =
    VOICEPRINT_SENSITIVITY_OPTIONS.find(
      (x) => Math.abs(x.value - aiState.threshold) < 0.02,
    ) ?? VOICEPRINT_SENSITIVITY_OPTIONS[1];

  const tierOptions = [
    {
      value: "auto",
      label: "自动推荐",
      badge:
        aiState.recommendedTier === "tse"
          ? "旗舰"
          : aiState.recommendedTier === "sv"
            ? "灵巧"
            : undefined,
    },
    {
      value: "sv",
      label: "灵巧声纹 · ERes2NetV2",
      badge: `${aiState.svSizeMb} MB`,
    },
    {
      value: "tse",
      label: "旗舰声纹分离 · VoxLock v2",
      badge: `${aiState.tseSizeMb} MB`,
    },
    {
      value: "denoise",
      label: "仅降噪与人声增强",
    },
  ];

  return (
    <PocketModal
      open={open}
      onOpenChange={(next) => {
        if (!next) stopTransientWork();
        onOpenChange(next);
      }}
      title="只认我的声音"
      subtitle="声纹模型与特征均留在本地设备，不上传云端"
      width={560}
    >
      <div className="stack" style={{ gap: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 14,
            border: "1px solid var(--divider)",
            background: "var(--surface-2)",
            flexWrap: "wrap",
          }}
        >
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            <ShieldCheck size={16} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <strong style={{ fontSize: fs(13.5) }}>本地声纹状态</strong>
                {aiState.enrolled ? (
                  <PocketBadge tone="mint">
                    已录 {aiState.enrollSeconds.toFixed(1)} 秒 · 稳定{" "}
                    {Math.round((aiState.consistency || 0) * 100)}%
                  </PocketBadge>
                ) : (
                  <PocketBadge tone="neutral">未录入</PocketBadge>
                )}
              </div>
              {aiState.enrolled && (aiState.prototypesCount || aiState.snrDb != null) ? (
                <div className="faint mono" style={{ fontSize: fs(11.5), marginTop: 2 }}>
                  {[
                    aiState.prototypesCount ? `${aiState.prototypesCount} 段原型` : null,
                    aiState.snrDb != null ? `信噪比 ${aiState.snrDb.toFixed(0)} dB` : null,
                    aiState.hasSample ? "VoxLock 样本就绪" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              ) : null}
            </div>
          </div>
          <PocketButton
            size="sm"
            variant="ghost"
            disabled={benchBusy || busy}
            onClick={() => void handleBenchmark()}
          >
            <Gauge size={13} />
            <span>{benchBusy ? "检测中…" : "重测算力"}</span>
          </PocketButton>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "10px 12px",
            borderRadius: 14,
            border: "1px solid var(--divider)",
            background: "var(--surface-2)",
          }}
        >
          {aiState.enrolled ? (
            <div className="between" style={{ gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: fs(13.5) }}>只认我的声音</div>
                <div className="faint" style={{ fontSize: fs(12) }}>
                  通话时忽略旁人说话，仅保留本人声纹
                </div>
              </div>
              <PocketSwitch
                checked={aiState.filter}
                disabled={busy}
                label="只认我的声音"
                onCheckedChange={(v) => void native.voiceAiSetConfig({ filter: v }).then(onStateChange)}
              />
            </div>
          ) : null}

          <div className="between" style={{ gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: fs(13.5) }}>未录声纹只认第一个说话人</div>
              <div className="faint" style={{ fontSize: fs(12) }}>
                暂未录入个人声纹时自动锁定首位说话人
              </div>
            </div>
            <PocketSwitch
              checked={aiState.firstSpeaker}
              disabled={busy}
              label="未录声纹只认第一个说话人"
              onCheckedChange={(v) =>
                void native.voiceAiSetConfig({ firstSpeaker: v }).then(onStateChange)
              }
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: "10px 12px",
            borderRadius: 14,
            border: "1px solid var(--divider)",
            background: "var(--surface-2)",
          }}
        >
          <div className="between" style={{ gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: fs(13.5) }}>声纹与人声分离档位</span>
            <PocketSelect
              size="sm"
              ariaLabel="声纹与人声分离档位"
              value={aiState.tier}
              disabled={busy}
              onValueChange={(v) => void handleSelectTier(v as VoiceAiTier)}
              options={tierOptions}
            />
          </div>
          {aiState.recommendReason ? (
            <div className="faint" style={{ fontSize: fs(12) }}>
              {aiState.recommendReason}
            </div>
          ) : null}

          <div className="between" style={{ gap: 10, flexWrap: "wrap", paddingTop: 4 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: fs(13.5) }}>识别要求</div>
              <div className="faint" style={{ fontSize: fs(12) }}>
                {activeSens.hint}
              </div>
            </div>
            <div className="segmented" role="group" aria-label="声纹识别要求">
              {VOICEPRINT_SENSITIVITY_OPTIONS.map((opt) => {
                const selected = Math.abs(activeSens.value - opt.value) < 0.01;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={selected ? "active" : ""}
                    disabled={busy}
                    onClick={() =>
                      void native
                        .voiceAiSetConfig({ threshold: opt.value })
                        .then(onStateChange)
                    }
                  >
                    {opt.label} {opt.value.toFixed(2)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {error ? (
          <div className="inline-alert" role="alert">
            <XCircle size={15} style={{ flexShrink: 0 }} />
            <span className="grow">{error}</span>
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: 12,
            borderRadius: 14,
            border: "1px solid var(--line-pink)",
            background: "var(--surface-2)",
          }}
        >
          {phase === "downloading" ? (
            <>
              <div className="between" style={{ gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: fs(13) }}>
                  <Download size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                  正在准备 {dlLabel}
                </span>
                <span className="mono" style={{ fontSize: fs(12.5), color: "var(--accent-text)" }}>
                  {Math.round(dlProgress * 100)}%
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 999,
                  background: "var(--surface-3)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.round(dlProgress * 100)}%`,
                    height: "100%",
                    borderRadius: 999,
                    background: "var(--primary)",
                    transition: "width 120ms ease",
                  }}
                />
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <PocketButton
                  size="sm"
                  variant="ghost"
                  onClick={() => void native.voiceAiCancelDownload().then(() => setPhase("idle"))}
                >
                  取消下载
                </PocketButton>
              </div>
            </>
          ) : phase === "recording" || phase === "finishing" ? (
            <>
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: "var(--surface)",
                  border: "1px solid var(--divider)",
                }}
              >
                <div className="faint" style={{ fontSize: fs(11.5), marginBottom: 4 }}>
                  请用平时说话的语气朗读以下两句（6–15 秒即可）：
                </div>
                {VOICEPRINT_SAMPLE_LINES.map((line, i) => (
                  <div key={i} style={{ fontSize: fs(13), lineHeight: 1.55, color: "var(--ink)" }}>
                    {line}
                  </div>
                ))}
              </div>
              <LevelMeter level={level} active />
              <div className="between" style={{ gap: 8 }}>
                <span className="mono" style={{ fontWeight: 700, fontSize: fs(13) }}>
                  已录有效说话 {seconds.toFixed(1)} 秒
                </span>
                <span
                  style={{
                    fontSize: fs(12),
                    color: seconds >= 4 ? "var(--mint-text)" : "var(--muted)",
                  }}
                >
                  {recFull
                    ? "已充足，点击完成即可"
                    : seconds >= 6
                      ? "效果很好，随时可完成"
                      : seconds >= 4
                        ? "可以完成，读满 6 秒更稳"
                        : "至少需要 4 秒有效说话"}
                </span>
              </div>
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <PocketButton
                  size="sm"
                  variant="ghost"
                  disabled={phase === "finishing"}
                  onClick={() => void handleCancelEnroll()}
                >
                  取消
                </PocketButton>
                <PocketButton
                  size="sm"
                  variant="primary"
                  disabled={seconds < 3.8 || phase === "finishing"}
                  onClick={() => void handleFinishEnroll()}
                >
                  {phase === "finishing" ? "正在生成声纹…" : "完成录入"}
                </PocketButton>
              </div>
            </>
          ) : phase === "testing" ? (
            <>
              <LevelMeter level={level} active={testSpeaking} />
              <div className="between" style={{ gap: 8, flexWrap: "wrap" }}>
                <div className="row" style={{ gap: 8, minWidth: 0 }}>
                  {testResult ? (
                    testResult.pass ? (
                      <CheckCircle2 size={17} style={{ color: "var(--mint-text)", flexShrink: 0 }} />
                    ) : (
                      <XCircle size={17} style={{ color: "var(--blush-text)", flexShrink: 0 }} />
                    )
                  ) : (
                    <Mic size={17} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
                  )}
                  <span style={{ fontWeight: 700, fontSize: fs(13.5) }}>
                    {testResult
                      ? testResult.pass
                        ? "声纹匹配通过"
                        : "未匹配本人声纹"
                      : testSpeaking
                        ? "正在核对声纹…"
                        : "请对着麦克风说一句话试试"}
                  </span>
                </div>
                {testResult && testResult.score !== undefined ? (
                  <PocketBadge tone={testResult.pass ? "mint" : "blush"}>
                    {`${Math.round(testResult.score * 100)}% · ${
                      testResult.pass ? "已通过" : "已拦截"
                    }${testResult.inferMs != null ? ` · ${Math.round(testResult.inferMs)} ms` : ""}`}
                  </PocketBadge>
                ) : null}
              </div>
              {testResult && testResult.rawScore != null && testResult.protoScore != null ? (
                <div className="faint mono" style={{ fontSize: fs(11.5) }}>
                  均值 {Math.round(testResult.rawScore * 100)}% · 原型{" "}
                  {Math.round(testResult.protoScore * 100)}% · 阈值{" "}
                  {Math.round(aiState.threshold * 100)}%
                </div>
              ) : null}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <PocketButton size="sm" variant="soft" onClick={() => void handleStopTest()}>
                  结束测试
                </PocketButton>
              </div>
            </>
          ) : (
            <>
              <div className="faint" style={{ fontSize: fs(12.5), lineHeight: 1.5 }}>
                {aiState.enrolled
                  ? "可随时测试本人与旁人说话的拦截效果，或重新录入新声纹。"
                  : `首次录入需准备约 ${aiState.svSizeMb} MB 灵巧声纹模型，安静读两句话即可完成。`}
              </div>
              {askClear ? (
                <div className="inline-alert" role="alert">
                  <span className="grow">确认清除当前已录入的本地声纹？</span>
                  <PocketButton size="sm" variant="ghost" onClick={() => setAskClear(false)}>
                    取消
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="danger"
                    onClick={() => void handleClearVoiceprint()}
                  >
                    确认清除
                  </PocketButton>
                </div>
              ) : (
                <div className="row wrap" style={{ gap: 8, justifyContent: "flex-end" }}>
                  {aiState.enrolled ? (
                    <>
                      <PocketButton
                        size="sm"
                        variant="ghost"
                        onClick={() => setAskClear(true)}
                      >
                        <Trash2 size={13} />
                        <span>清除声纹</span>
                      </PocketButton>
                      <PocketButton
                        size="sm"
                        variant="soft"
                        onClick={() => void handleStartEnroll()}
                      >
                        <RotateCcw size={13} />
                        <span>重新录入</span>
                      </PocketButton>
                      <PocketButton
                        size="sm"
                        variant="primary"
                        onClick={() => void handleStartTest()}
                      >
                        <Sparkles size={13} />
                        <span>实时测试</span>
                      </PocketButton>
                    </>
                  ) : (
                    <PocketButton
                      size="sm"
                      variant="primary"
                      onClick={() => void handleStartEnroll()}
                    >
                      <Mic size={13} />
                      <span>开始录入声纹</span>
                    </PocketButton>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </PocketModal>
  );
}
