import { useEffect, useId, useMemo, useState } from "react";
import { Gauge, RefreshCw, Terminal, Timer, X, Zap } from "lucide-react";
import { resolveModelBrand, type Agent, type AgentUsageReport, type ConvEvent } from "@herdr-pocket/protocol";
import {
  computeTurnTelemetry,
  fmtLatencyClean,
  fmtPctClean,
  formatContextScaleMark,
  groupQuotasByProvider,
} from "../lib/turnTelemetry";
import { ModelBrandIcon } from "./ModelBrandIcon";
import { PocketIconButton } from "./PocketUI";

function pctTone(pct: number): "ok" | "warn" | "bad" {
  if (pct >= 85) return "bad";
  if (pct >= 65) return "warn";
  return "ok";
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) {
    const k = n / 1_000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(Math.round(n));
}

function fmtUsd(cost: number, unpricedSteps: number, totalSteps: number): string {
  if (totalSteps > 0 && unpricedSteps >= totalSteps && cost === 0) return "未计价";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  if (cost > 0) return `$${cost.toFixed(4)}`;
  return "$0.00";
}

function formatEffortTag(level?: string): string {
  if (!level) return "";
  const k = level.trim().toLowerCase();
  if (k === "xhigh") return "XHigh";
  if (!k) return "";
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function ContextTestTube({
  pct,
  tokens,
  limit,
  tps,
  isWorking,
  uid,
}: {
  pct: number | null;
  tokens: number;
  limit: number;
  tps: number | null;
  isWorking: boolean;
  uid: string;
}) {
  const hasPct = pct !== null && Number.isFinite(pct);
  const clamped = hasPct ? Math.max(0, Math.min(100, pct)) : 0;
  const tone = hasPct ? pctTone(clamped) : "ok";
  const tubeTop = 10;
  const tubeHeight = 136;
  const fillFraction = hasPct
    ? clamped <= 0
      ? 0.05
      : Math.max(0.08, Math.min(0.96, clamped / 100))
    : tokens > 0
      ? Math.min(0.72, Math.max(0.16, Math.log10(Math.max(1000, tokens) / 1000) / 3.2))
      : 0.05;
  const fillHeight = tubeHeight * fillFraction;
  const surfaceY = tubeTop + tubeHeight - fillHeight;
  const bubbleAnchorBase = Math.max(6, Math.min(fillHeight - 4, 28));

  const stops =
    tone === "bad"
      ? ["#FF6B8A", "#C92A56"]
      : tone === "warn"
        ? ["#F6AD55", "#E85D9C"]
        : ["#56B8FF", "#2F66FF"];

  const ticks = limit > 0
    ? [
        { label: formatContextScaleMark(limit * 0.75), topPct: "25%" },
        { label: formatContextScaleMark(limit * 0.5), topPct: "50%" },
        { label: formatContextScaleMark(limit * 0.25), topPct: "75%" },
      ]
    : [
        { label: "75%", topPct: "25%" },
        { label: "50%", topPct: "50%" },
        { label: "25%", topPct: "75%" },
      ];

  const frontWaveFillD =
    "M 0 0 Q 14 -2.8, 28 0 T 56 0 T 84 0 T 112 0 T 140 0 T 168 0 L 168 160 L 0 160 Z";
  const frontCrestD = "M 0 0 Q 14 -2.8, 28 0 T 56 0 T 84 0 T 112 0 T 140 0 T 168 0";
  const backWaveFillD =
    "M -48 -1 Q -36 -3.6, -24 -1 T 0 -1 T 24 -1 T 48 -1 T 72 -1 T 96 -1 T 120 -1 L 120 160 L -48 160 Z";

  return (
    <div className="usage-vial-col">
      <div className="usage-vial-head">
        <span>CTX</span>
        <span className={`mono usage-vial-pct ${tone}`}>
          {hasPct ? fmtPctClean(clamped) : tokens > 0 ? fmtTokens(tokens) : "0%"}
        </span>
      </div>
      <div className="usage-vial-stage">
        <svg
          className="usage-vial-svg"
          viewBox="0 0 64 158"
          width="48"
          height="124"
          aria-hidden="true"
        >
          <defs>
            <clipPath id={`${uid}-clip`}>
              <rect x="10" y="10" width="44" height="136" rx="22" ry="22" />
            </clipPath>
            <linearGradient id={`${uid}-liq`} x1="0" y1="0" x2="0" y2="0.72">
              <stop offset="0%" stopColor={stops[0]} stopOpacity="0.96" />
              <stop offset="100%" stopColor={stops[1]} stopOpacity="0.94" />
            </linearGradient>
            <linearGradient id={`${uid}-glass`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="rgba(255,255,255,0.22)" />
              <stop offset="28%" stopColor="rgba(255,255,255,0.03)" />
              <stop offset="82%" stopColor="rgba(255,255,255,0.02)" />
              <stop offset="100%" stopColor="rgba(255,255,255,0.16)" />
            </linearGradient>
          </defs>

          {/* Outer vial cavity */}
          <rect
            x="10"
            y="10"
            width="44"
            height="136"
            rx="22"
            ry="22"
            fill="var(--usage-vial-bg)"
            stroke="var(--usage-vial-border)"
            strokeWidth="1.5"
          />

          {/* Liquid fill clipped to glass cavity; GPU compositor transform-only waves */}
          <g clipPath={`url(#${uid}-clip)`}>
            <g
              className={`usage-vial-level${isWorking ? " is-working" : ""}`}
              transform={`translate(0 ${surfaceY.toFixed(1)})`}
              style={{ transform: `translate(0px, ${surfaceY.toFixed(1)}px)` }}
            >
              <g className="usage-vial-wave-back">
                <path d={backWaveFillD} fill={stops[0]} fillOpacity="0.38" />
              </g>
              <g className="usage-vial-wave-front">
                <path d={frontWaveFillD} fill={`url(#${uid}-liq)`} />
                <path
                  d={frontCrestD}
                  fill="none"
                  stroke="rgba(255,255,255,0.68)"
                  strokeWidth="1.35"
                />
              </g>
              {fillFraction >= 0.1 ? (
                <>
                  <circle
                    className="usage-vial-bubble b1"
                    cx="22"
                    cy={Math.min(bubbleAnchorBase, 19).toFixed(1)}
                    r="1.6"
                    fill="rgba(255,255,255,0.52)"
                  />
                  <circle
                    className="usage-vial-bubble b2"
                    cx="37"
                    cy={Math.min(bubbleAnchorBase, 25).toFixed(1)}
                    r="1.2"
                    fill="rgba(255,255,255,0.42)"
                  />
                  <circle
                    className="usage-vial-bubble b3"
                    cx="30"
                    cy={Math.min(bubbleAnchorBase, 14).toFixed(1)}
                    r="1.0"
                    fill="rgba(255,255,255,0.36)"
                  />
                </>
              ) : null}
            </g>
          </g>

          {/* Glass reflection overlay & crisp rim */}
          <rect
            x="10"
            y="10"
            width="44"
            height="136"
            rx="22"
            ry="22"
            fill={`url(#${uid}-glass)`}
            stroke="var(--usage-vial-rim)"
            strokeWidth="1.25"
          />
          <rect x="16" y="22" width="4" height="106" rx="2" fill="rgba(255,255,255,0.22)" />
        </svg>

        <div className="usage-vial-ticks mono" aria-hidden="true">
          {ticks.map((tk) => (
            <div key={tk.topPct} className="usage-vial-tick" style={{ top: tk.topPct }}>
              <span className="usage-vial-dash" />
              <span>{tk.label}</span>
            </div>
          ))}
        </div>
      </div>
      {tps !== null ? (
        <div className="usage-vial-tps mono">{tps.toFixed(1)} tok/s</div>
      ) : null}
    </div>
  );
}

export function AgentUsageCard({
  agent,
  report,
  events,
  loading,
  error,
  onRefresh,
  onClose,
  onRunInTerminal,
}: {
  agent: Agent;
  report: AgentUsageReport | null;
  events?: ConvEvent[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
  onRunInTerminal?: () => void;
}) {
  const uid = useId().replace(/:/g, "");
  const s = report?.session ?? null;

  const telemetry = useMemo(
    () => computeTurnTelemetry(events, report, agent),
    [agent, events, report],
  );
  const quotaGroups = useMemo(
    () => groupQuotasByProvider(report?.quotas),
    [report?.quotas],
  );

  const activeModelId = report?.model || agent.model || "";
  const activeBrand = resolveModelBrand(activeModelId);
  const defaultProviderKey = useMemo(() => {
    if (quotaGroups.length === 0) return "";
    if (activeBrand) {
      const matched = quotaGroups.find((g) => g.providerKey === activeBrand);
      if (matched) return matched.providerKey;
    }
    return quotaGroups[0]!.providerKey;
  }, [activeBrand, quotaGroups]);

  const [selectedProviderKey, setSelectedProviderKey] = useState<string>("");
  useEffect(() => {
    setSelectedProviderKey(defaultProviderKey);
  }, [defaultProviderKey]);

  const activeQuotaGroup =
    quotaGroups.find((g) => g.providerKey === selectedProviderKey) ?? quotaGroups[0] ?? null;

  const hasContext = telemetry.contextLimit > 0 || telemetry.contextTokens > 0;
  const usedPct = telemetry.usedPct ?? 0;
  const remainPct = telemetry.remainPct ?? Math.max(0, 100 - usedPct);
  const tone = pctTone(usedPct);

  const segWidths = useMemo(() => {
    const denom = Math.max(telemetry.contextLimit, telemetry.contextTokens, 1);
    const cacheShare = Math.min(100, (telemetry.cacheReadTokens / denom) * 100);
    const inputShare = Math.min(100 - cacheShare, (telemetry.inputTokens / denom) * 100);
    const outShare = Math.min(100 - cacheShare - inputShare, (telemetry.outputTokens / denom) * 100);
    const totalShown = cacheShare + inputShare + outShare;
    if (totalShown <= 0.1 && usedPct > 0) {
      return { cacheW: Math.min(100, usedPct), inputW: 0, outW: 0 };
    }
    // Scale proportionally inside usedPct when contextLimit is known so bar length reflects real fill %
    const targetPct = usedPct > 0 ? usedPct : Math.min(100, totalShown);
    const factor = totalShown > 0 ? targetPct / totalShown : 0;
    return {
      cacheW: cacheShare * factor,
      inputW: inputShare * factor,
      outW: outShare * factor,
    };
  }, [telemetry, usedPct]);

  const effortTag = formatEffortTag(agent.thinkingLevel);
  const activeModelDisplay = activeModelId
    ? `${activeModelId.split("/").pop()}${effortTag ? ` (${effortTag})` : ""}`
    : "未识别模型";

  const showVialColumn = hasContext;

  return (
    <section className="usage-card" aria-label="上下文与用量仪表盘">
      <div className="usage-card-head">
        <div className="usage-card-title">
          <Gauge size={14} className="usage-head-ic" />
          <span>上下文窗口</span>
          <span className="usage-sub">{report?.harness || agent.harness}</span>
        </div>
        <div className="usage-card-actions">
          <PocketIconButton
            size="sm"
            aria-label="刷新用量"
            title="刷新本地会话与额度统计"
            onClick={onRefresh}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? "spin" : ""} />
          </PocketIconButton>
          {onRunInTerminal && agent.source !== "uniflo" ? (
            <PocketIconButton
              size="sm"
              aria-label="运行 /usage"
              title="在终端运行 /usage"
              onClick={onRunInTerminal}
            >
              <Terminal size={13} />
            </PocketIconButton>
          ) : null}
          <PocketIconButton size="sm" aria-label="关闭用量面板" title="关闭" onClick={onClose}>
            <X size={14} />
          </PocketIconButton>
        </div>
      </div>

      {error ? <div className="inline-alert">{error}</div> : null}

      {loading && !report && !hasContext ? (
        <div className="usage-empty">正在统计本地会话与模型额度…</div>
      ) : (
        <div className="usage-card-body">
          <div className={`usage-hud-grid${showVialColumn ? " with-vial" : ""}`}>
            {showVialColumn ? (
              <ContextTestTube
                pct={telemetry.usedPct}
                tokens={telemetry.contextTokens}
                limit={telemetry.contextLimit}
                tps={telemetry.tps}
                isWorking={agent.status === "working"}
                uid={uid}
              />
            ) : null}

            <div className="usage-detail-col">
              {hasContext ? (
                <div className="usage-hero">
                  <div className="usage-hero-top">
                    <span className={`usage-hero-pct mono ${tone}`}>
                      {telemetry.usedPct !== null
                        ? `${fmtPctClean(usedPct)} 已用 · ${fmtPctClean(remainPct)} 剩余`
                        : telemetry.contextTokens > 0
                          ? `${fmtTokens(telemetry.contextTokens)} 已用`
                          : "0 tok"}
                    </span>
                    <span className="usage-hero-tok mono">
                      {telemetry.contextLimit > 0
                        ? `${fmtTokens(telemetry.contextTokens)} / ${telemetry.contextLimitInferred ? "~" : ""}${fmtTokens(telemetry.contextLimit)} tok`
                        : "窗口上限未知"}
                    </span>
                  </div>
                  {telemetry.contextLimit > 0 ? (
                    <div className="usage-seg-track" aria-hidden="true">
                      <span className="usage-seg-cache" style={{ width: `${segWidths.cacheW}%` }} />
                      <span className="usage-seg-input" style={{ width: `${segWidths.inputW}%` }} />
                      <span className="usage-seg-out" style={{ width: `${segWidths.outW}%` }} />
                      <span className="usage-seg-warn-tick" style={{ left: "80%" }} />
                    </div>
                  ) : null}
                  <div className="usage-metric-pills mono">
                    {telemetry.cacheHitPct !== null ? (
                      <span
                        className="usage-metric-chip usage-cache-chip"
                        title={`提示词缓存命中率 ${fmtPctClean(telemetry.cacheHitPct)}`}
                      >
                        <Zap size={11} className="usage-chip-ic" />
                        <span>缓存</span>
                        <span className="usage-cache-bar" aria-hidden="true">
                          <span
                            className="usage-cache-bar-fill"
                            style={{ width: `${Math.max(6, Math.min(100, telemetry.cacheHitPct))}%` }}
                          />
                        </span>
                        <b className="usage-chip-val">{fmtPctClean(telemetry.cacheHitPct)}</b>
                      </span>
                    ) : null}
                    {telemetry.ttftMs !== null ? (
                      <span
                        className="usage-metric-chip"
                        title={`最近一轮首字响应延迟 (TTFT) ${fmtLatencyClean(telemetry.ttftMs)}`}
                      >
                        <Timer size={11} className="usage-chip-ic" />
                        <span>响应</span>
                        <b className="usage-chip-val">{fmtLatencyClean(telemetry.ttftMs)}</b>
                      </span>
                    ) : null}
                    {telemetry.tps !== null ? (
                      <span
                        className="usage-metric-chip"
                        title={`最近一轮生成吞吐 ${telemetry.tps.toFixed(1)} tokens/s`}
                      >
                        <Gauge size={11} className="usage-chip-ic" />
                        <b className="usage-chip-val">{telemetry.tps.toFixed(1)}</b>
                        <span>tok/s</span>
                      </span>
                    ) : null}
                    {telemetry.cacheHitPct === null && telemetry.ttftMs === null && telemetry.tps === null ? (
                      <span className="usage-metric-chip muted">
                        {`输入 ${fmtTokens(telemetry.inputTokens)} · 输出 ${fmtTokens(telemetry.outputTokens)}`}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="usage-empty">暂无当前上下文窗口读数</div>
              )}

              <div className="usage-current-model-row" aria-label={`当前模型 ${activeModelDisplay}`}>
                <span className="usage-current-label">当前模型</span>
                <span className="usage-current-value">
                  <ModelBrandIcon model={activeModelId} size={14} />
                  <span className="mono truncate">{activeModelDisplay}</span>
                </span>
              </div>

              {activeQuotaGroup ? (
                <div className="usage-quota-panel">
                  <div className="usage-quota-panel-head">
                    <div className="usage-quota-brand">
                      <ModelBrandIcon model={activeQuotaGroup.title} size={13} />
                      <span className="usage-quota-provider-title">{activeQuotaGroup.title}</span>
                      <span className={`usage-health-pill ${activeQuotaGroup.health.tone}`}>
                        {activeQuotaGroup.health.label}
                      </span>
                    </div>
                    {quotaGroups.length > 1 ? (
                      <div className="usage-provider-tabs" role="tablist" aria-label="模型提供商额度切换">
                        {quotaGroups.map((g) => {
                          const on = g.providerKey === activeQuotaGroup.providerKey;
                          return (
                            <button
                              key={g.providerKey}
                              type="button"
                              role="tab"
                              aria-selected={on}
                              className={`usage-provider-tab${on ? " active" : ""}`}
                              onClick={() => setSelectedProviderKey(g.providerKey)}
                            >
                              {g.title}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div className="usage-quota-list">
                    {activeQuotaGroup.bars.map((q, idx) => (
                      <div key={`${activeQuotaGroup.providerKey}-${idx}`} className="usage-quota-row">
                        <span className="usage-quota-win">{q.windowLabel}</span>
                        <div className="usage-quota-bar">
                          <span
                            className={`usage-quota-bar-fill ${q.remainPct < 20 ? "bad" : q.remainPct < 50 ? "warn" : "ok"}`}
                            style={{ width: `${Math.max(2, Math.min(100, q.remainPct))}%` }}
                          />
                        </div>
                        <span className="usage-quota-meta mono">
                          {fmtPctClean(q.remainPct)}
                          {q.resetText ? ` · ${q.resetText}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {s ? (() => {
            const subCount = s.subagentCount ?? 0;
            const subCost = s.subagentCostUsd ?? 0;
            const subSteps = s.subagentSteps ?? 0;
            const subUnpriced = s.subagentUnpricedSteps ?? 0;
            const totalCost = s.costUsd + subCost;
            const totalSteps = s.steps + subSteps;
            const totalUnpriced = s.unpricedSteps + subUnpriced;

            const todayMainCost = s.todayCostUsd ?? s.costUsd;
            const todaySubCost = s.todaySubagentCostUsd ?? 0;
            const todayTotalCost = todayMainCost + todaySubCost;
            const todayMainSteps = s.todaySteps ?? s.steps;
            const todaySubSteps = s.todaySubagentSteps ?? 0;
            const todayTotalSteps = todayMainSteps + todaySubSteps;
            const todayUnpriced = s.todayUnpricedSteps ?? s.unpricedSteps;

            const totalIn = s.input + (s.subagentTokens?.input ?? 0);
            const totalOut = s.output + (s.subagentTokens?.output ?? 0);
            const totalCache = s.cacheRead + (s.subagentTokens?.cacheRead ?? 0);
            const totalTokensAll = totalIn + totalOut;

            return (
              <div className="usage-kpi-grid" aria-label="当前会话与子 Agent 花费及消耗">
                <div className="usage-kpi-cell is-focus">
                  <span className="usage-kpi-label">今日花费{subCount > 0 ? "（含子 Agent）" : ""}</span>
                  <span className="usage-kpi-val mono num">
                    {fmtUsd(todayTotalCost, todayUnpriced, todayTotalSteps)}
                  </span>
                  <span className="usage-kpi-sub mono truncate">
                    {todaySubCost > 0
                      ? `主会话 ${fmtUsd(todayMainCost, todayUnpriced, todayMainSteps)} + 子 Agent ${fmtUsd(todaySubCost, 0, todaySubSteps)}`
                      : `今日 ${todayTotalSteps} 步`}
                  </span>
                </div>

                <div className="usage-kpi-cell">
                  <span className="usage-kpi-label">会话累计{subCount > 0 ? "（含子 Agent）" : ""}</span>
                  <span className="usage-kpi-val mono num">
                    {fmtUsd(totalCost, totalUnpriced, totalSteps)}
                  </span>
                  <span className="usage-kpi-sub mono truncate">
                    {subCount > 0
                      ? `含 ${subCount} 个子 Agent（${fmtUsd(subCost, subUnpriced, subSteps)}）`
                      : `共 ${s.turns} 轮对话`}
                  </span>
                </div>

                <div className="usage-kpi-cell">
                  <span className="usage-kpi-label">轮次与步骤</span>
                  <span className="usage-kpi-val mono num">
                    {s.turns} 轮 · {totalSteps} 步
                  </span>
                  <span className="usage-kpi-sub mono truncate">
                    {subSteps > 0
                      ? `主 ${s.steps} 步 + 子 ${subSteps} 步 · 今日 ${todayTotalSteps} 步`
                      : `今日 ${todayTotalSteps} 步`}
                  </span>
                </div>

                <div className="usage-kpi-cell">
                  <span className="usage-kpi-label">Token 消耗</span>
                  <span className="usage-kpi-val mono num">{fmtTokens(totalTokensAll)}</span>
                  <span className="usage-kpi-sub mono truncate">
                    入 {fmtTokens(totalIn)} · 出 {fmtTokens(totalOut)}
                    {totalCache > 0 ? ` · 缓存 ${fmtTokens(totalCache)}` : ""}
                  </span>
                </div>
              </div>
            );
          })() : null}
        </div>
      )}
    </section>
  );
}
