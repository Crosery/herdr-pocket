import { Cpu, Gauge, RotateCw, Terminal, X } from "lucide-react";
import type { Agent, AgentUsageReport } from "@herdr-pocket/protocol";

function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtUsd(cost: number | undefined, steps = 0, unpricedSteps = 0): string {
  const c = cost ?? 0;
  if (steps > 0 && unpricedSteps >= steps && c === 0) return "未计价";
  const str = c >= 100 ? `$${c.toFixed(0)}` : c >= 10 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(2)}` : c > 0 ? `$${c.toFixed(4)}` : "$0.00";
  if (steps > 0 && unpricedSteps > 0 && unpricedSteps < steps) return `${str} · 部分未计价`;
  return str;
}

function fmtReset(ms?: number): string {
  if (!ms) return "";
  const diffMin = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  if (diffMin < 60) return `${diffMin}m 后重置`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 48) return `${diffH}h 后重置`;
  return `${Math.floor(diffH / 24)}d 后重置`;
}

function pctTone(pct: number): "ok" | "warn" | "high" {
  if (pct >= 90) return "high";
  if (pct >= 75) return "warn";
  return "ok";
}

/** Inline live usage, context window, model breakdown, and quota telemetry card rendered above the composer on `/usage`. */
export function AgentUsageCard({
  agent,
  report,
  loading,
  error,
  onRefresh,
  onClose,
  onOpenModelSwitch,
  onRunInTerminal,
}: {
  agent: Agent;
  report: AgentUsageReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
  onOpenModelSwitch?: () => void;
  onRunInTerminal?: () => void;
}) {
  const s = report?.session ?? null;
  const activeModel = report?.model || agent.model;
  const canSwitch = !agent.isShell && (agent.source === "hc" || agent.source === "herdr");
  const canSendTerminal = !agent.isShell && (agent.source === "hc" || agent.source === "herdr");

  const ctxTokens = s?.contextTokens ?? agent.contextTokens;
  const ctxLimit = s?.contextLimit ?? agent.contextLimit;
  const ctxPct =
    s?.contextPct ??
    (ctxTokens !== undefined && ctxLimit && ctxLimit > 0 ? (ctxTokens / ctxLimit) * 100 : undefined);
  const clampedCtx = ctxPct !== undefined ? Math.max(0, Math.min(100, ctxPct)) : undefined;

  const hitDenom = (s?.input ?? 0) + (s?.cacheRead ?? 0);
  const hitPct = hitDenom > 0 && s?.cacheRead ? Math.round((s.cacheRead / hitDenom) * 100) : 0;

  return (
    <section className="usage-card" role="region" aria-label="用量与上下文">
      <div className="usage-card-head">
        <div className="usage-card-title">
          <Gauge size={14} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
          <span>用量与上下文</span>
          <span className="usage-pill mono">{report?.harness || agent.harness}</span>
          {activeModel ? (
            <button
              type="button"
              className="usage-pill mono interactive"
              disabled={!canSwitch || !onOpenModelSwitch}
              title={canSwitch ? "点击切换模型 (/model)" : undefined}
              onClick={onOpenModelSwitch}
            >
              <Cpu size={11} />
              <span className="truncate">{activeModel}</span>
            </button>
          ) : null}
        </div>
        <div className="usage-card-actions">
          {canSendTerminal && onRunInTerminal ? (
            <button
              type="button"
              className="usage-action-btn"
              title="把原始 /usage 命令发给终端执行"
              onClick={onRunInTerminal}
            >
              <Terminal size={12} />
              <span>终端 /usage</span>
            </button>
          ) : null}
          <button
            type="button"
            className="usage-icon-btn"
            aria-label="刷新用量"
            title="刷新"
            disabled={loading}
            onClick={onRefresh}
          >
            <RotateCw size={13} className={loading ? "v3-spin" : undefined} />
          </button>
          <button
            type="button"
            className="usage-icon-btn"
            aria-label="关闭用量卡片"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {error ? <div className="inline-alert">{error}</div> : null}

      {loading && !report ? (
        <div className="usage-empty">正在读取会话与本机用量统计…</div>
      ) : (
        <div className="usage-card-body">
          {/* Context window meter */}
          {ctxTokens !== undefined ? (
            <div className="usage-section">
              <div className="usage-bar-row">
                <span className="usage-label">上下文窗口</span>
                <span className="usage-val mono">
                  {ctxLimit && ctxLimit > 0
                    ? `${fmtTokens(ctxTokens)} / ${fmtTokens(ctxLimit)} · ${clampedCtx !== undefined ? `${clampedCtx.toFixed(1)}%` : ""}`
                    : `当前上下文 ${fmtTokens(ctxTokens)} tokens`}
                </span>
              </div>
              {clampedCtx !== undefined ? (
                <div className="usage-meter">
                  <div className={`usage-meter-fill ${pctTone(clampedCtx)}`} style={{ width: `${clampedCtx}%` }} />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Provider / account rate limits (when available from omp) */}
          {report && report.quotas.length > 0 ? (
            <div className="usage-section">
              <div className="usage-section-label">账号速率与额度</div>
              <div className="usage-quota-list">
                {report.quotas.map((q, idx) => (
                  <div key={`${q.provider}-${q.label}-${idx}`} className="usage-quota-item">
                    <div className="usage-bar-row">
                      <span className="usage-label truncate">
                        <strong className="mono">{q.provider}</strong>
                        {q.account ? ` · ${q.account}` : ""}
                        {` · ${q.label}`}
                      </span>
                      <span className="usage-val mono">
                        {q.usedPct.toFixed(1)}%
                        {q.resetAt ? <span className="usage-sub"> · {fmtReset(q.resetAt)}</span> : null}
                      </span>
                    </div>
                    <div className="usage-meter">
                      <div className={`usage-meter-fill ${pctTone(q.usedPct)}`} style={{ width: `${Math.min(100, q.usedPct)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Session 4-tile grid */}
          {s ? (
            <div className="usage-grid">
              <div className="usage-tile">
                <div className="usage-tile-k">累计费用</div>
                <div className="usage-tile-v mono">{fmtUsd(s.costUsd, s.steps, s.unpricedSteps)}</div>
              </div>
              <div className="usage-tile">
                <div className="usage-tile-k">轮次与步数</div>
                <div className="usage-tile-v mono">{s.turns} 轮 · {s.steps} 步</div>
              </div>
              <div className="usage-tile">
                <div className="usage-tile-k">输入 / 输出</div>
                <div className="usage-tile-v mono">{fmtTokens(s.input)} in · {fmtTokens(s.output)} out</div>
              </div>
              <div className="usage-tile">
                <div className="usage-tile-k">缓存与思考</div>
                <div className="usage-tile-v mono">
                  {fmtTokens(s.cacheRead)} 缓存{hitPct > 0 ? ` (${hitPct}%)` : ""}
                  {s.reasoning > 0 ? ` · ${fmtTokens(s.reasoning)} 思考` : ""}
                </div>
              </div>
            </div>
          ) : (
            <div className="usage-empty">当前会话尚未绑定 Uniflo 用量明细，发起一轮对话后将自动累计。</div>
          )}

          {/* Per-model breakdown */}
          {report && report.models.length > 0 ? (
            <div className="usage-section">
              <div className="usage-section-label">会话模型明细</div>
              <div className="usage-model-list">
                {report.models.slice(0, 6).map((m) => (
                  <div key={m.model} className="usage-model-row">
                    <span className="usage-model-name mono truncate" title={m.model}>{m.model}</span>
                    <span className="usage-model-meta mono">{m.steps} 步</span>
                    <span className="usage-model-meta mono">
                      {fmtTokens(m.input + m.cacheRead)} / {fmtTokens(m.output)}
                    </span>
                    <span className="usage-model-cost mono">{fmtUsd(m.costUsd, m.steps, m.unpricedSteps)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Computer 24h / 7d summary */}
          {report && (report.day24h || report.day7d) ? (
            <div className="usage-foot mono">
              {report.day24h ? (
                <span>
                  24h：{report.day24h.harness ? `${report.harness} ${fmtUsd(report.day24h.harness.costUsd)} · ` : ""}
                  本机合计 {fmtUsd(report.day24h.total.costUsd)} ({fmtTokens(report.day24h.total.input + report.day24h.total.output)})
                </span>
              ) : null}
              {report.day7d ? (
                <span>
                  7d：{report.day7d.harness ? `${report.harness} ${fmtUsd(report.day7d.harness.costUsd)} · ` : ""}
                  本机合计 {fmtUsd(report.day7d.total.costUsd)}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
