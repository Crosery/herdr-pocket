import { useEffect, useId, useMemo, useState } from "react";
import { Gauge, RefreshCw, Terminal, X } from "lucide-react";
import { resolveModelBrand, type Agent, type AgentUsageReport, type ConvEvent } from "@herdr-pocket/protocol";
import {
  computeTurnTelemetry,
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
  limit,
  tps,
  uid,
}: {
  pct: number;
  limit: number;
  tps: number | null;
  uid: string;
}) {
  const tone = pctTone(pct);
  const clamped = Math.max(0, Math.min(100, pct));
  const tubeTop = 10;
  const tubeHeight = 136;
  const fillFraction = clamped <= 0 ? 0.04 : Math.max(0.08, Math.min(0.96, clamped / 100));
  const fillHeight = tubeHeight * fillFraction;
  const surfaceY = tubeTop + tubeHeight - fillHeight;

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

  const wavePath = `M 6 ${surfaceY.toFixed(1)} Q 19 ${(surfaceY - 3).toFixed(1)}, 32 ${surfaceY.toFixed(1)} T 58 ${surfaceY.toFixed(1)} L 58 152 L 6 152 Z`;

  return (
    <div className="usage-vial-col">
      <div className="usage-vial-head">
        <span>CTX</span>
        <span className={`mono usage-vial-pct ${tone}`}>{fmtPctClean(clamped)}</span>
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
            <linearGradient id={`${uid}-liq`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stops[0]} stopOpacity="0.96" />
              <stop offset="100%" stopColor={stops[1]} stopOpacity="0.92" />
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

          {/* Liquid fill clipped to glass cavity */}
          <g clipPath={`url(#${uid}-clip)`}>
            <path d={wavePath} fill={`url(#${uid}-liq)`} />
            {/* Meniscus highlight line */}
            <path
              d={`M 6 ${surfaceY.toFixed(1)} Q 19 ${(surfaceY - 3).toFixed(1)}, 32 ${surfaceY.toFixed(1)} T 58 ${surfaceY.toFixed(1)}`}
              fill="none"
              stroke="rgba(255,255,255,0.58)"
              strokeWidth="1.4"
            />
            {clamped >= 5 ? (
              <>
                <circle cx="24" cy={Math.min(138, surfaceY + 11)} r="1.7" fill="rgba(255,255,255,0.48)" />
                <circle cx="38" cy={Math.min(140, surfaceY + 7)} r="1.2" fill="rgba(255,255,255,0.38)" />
              </>
            ) : null}
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

  const speedBits: string[] = [];
  if (telemetry.ttftMs !== null) speedBits.push(`TTFT ${(telemetry.ttftMs / 1000).toFixed(2)}s`);
  if (telemetry.tps !== null) speedBits.push(`TPS ${telemetry.tps.toFixed(1)} tok/s`);
  if (telemetry.cacheHitPct !== null) speedBits.push(`缓存 ${fmtPctClean(telemetry.cacheHitPct)}`);

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
                pct={usedPct}
                limit={telemetry.contextLimit}
                tps={telemetry.tps}
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
                        : `${fmtTokens(telemetry.contextTokens)} tok`}
                    </span>
                    <span className="usage-hero-tok mono">
                      {telemetry.contextLimit > 0
                        ? `${fmtTokens(telemetry.contextTokens)} / ${fmtTokens(telemetry.contextLimit)} tok`
                        : `${fmtTokens(telemetry.contextTokens)} tokens`}
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
                  <div className="usage-speed-row mono">
                    <span className="usage-speed-left">
                      {speedBits.length > 0
                        ? speedBits.join(" · ")
                        : `输入 ${fmtTokens(telemetry.inputTokens)} · 输出 ${fmtTokens(telemetry.outputTokens)}`}
                    </span>
                    {telemetry.contextLimit > 0 ? (
                      <span className="usage-speed-right">
                        {`${fmtTokens(telemetry.contextTokens)} / ${fmtTokens(telemetry.contextLimit)}`}
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

          {report ? (
            <div className="usage-summary-strip mono">
              {s ? (
                <>
                  <span>
                    费用 <b>{fmtUsd(s.costUsd, s.unpricedSteps, s.steps)}</b>
                  </span>
                  <span>
                    <b>{s.turns}</b> 轮 / <b>{s.steps}</b> 步
                  </span>
                  <span>
                    入/出 {fmtTokens(s.input)} / {fmtTokens(s.output)}
                  </span>
                  {s.cacheRead > 0 ? <span>缓存 {fmtTokens(s.cacheRead)}</span> : null}
                </>
              ) : null}
              {report.day24h ? (
                <span>
                  24h <b>{fmtUsd(report.day24h.total.costUsd, 0, 1)}</b>
                </span>
              ) : null}
              {report.day7d ? (
                <span>
                  7d <b>{fmtUsd(report.day7d.total.costUsd, 0, 1)}</b>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
