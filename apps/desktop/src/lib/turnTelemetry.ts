import type { Agent, AgentQuotaBar, AgentUsageReport, ConvEvent } from "@herdr-pocket/protocol";

export interface TurnTelemetryMetrics {
  ttftMs: number | null;
  tps: number | null;
  cacheHitPct: number | null;
  contextTokens: number;
  contextLimit: number;
  usedPct: number | null;
  remainPct: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface QuotaHealthBadge {
  label: "充裕" | "适中" | "紧张";
  tone: "plenty" | "moderate" | "tight";
}

export interface QuotaGroupItem {
  providerKey: string;
  title: string;
  health: QuotaHealthBadge;
  bars: Array<{
    windowLabel: string;
    remainPct: number;
    usedPct: number;
    resetText: string;
    account?: string;
    note?: string;
  }>;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function fmtPctClean(pct: number): string {
  const clamped = clampPct(pct);
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function fmtCompactReset(resetAt?: number): string {
  if (!resetAt || !Number.isFinite(resetAt)) return "";
  const ms = resetAt - Date.now();
  if (ms <= 0) return "即将重置";
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `${hrs}h${remMins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d${remHrs}h` : `${days}d`;
}

export function normalizeQuotaWindowLabel(rawLabel: string): string {
  const clean = rawLabel.trim();
  if (/5\s*(?:小时|h|hr)/i.test(clean)) return "5h窗口";
  if (/(?:7\s*天|weekly|周)/i.test(clean)) return "周额度";
  if (/24\s*(?:小时|h)|daily|日/i.test(clean)) return "日额度";
  return clean || "窗口";
}

export function providerDisplayName(provider: string): string {
  const p = provider.trim().toLowerCase();
  if (p === "google" || p === "gemini" || p === "google-gemini") return "Gemini";
  if (p === "anthropic" || p === "claude") return "Claude";
  if (p === "openai" || p === "chatgpt" || p === "codex") return "OpenAI";
  if (p === "deepseek") return "DeepSeek";
  if (p === "qwen" || p === "dashscope") return "Qwen";
  if (p === "moonshot" || p === "kimi") return "Kimi";
  if (p === "minimax") return "MiniMax";
  if (p === "zhipu" || p === "zai") return "Zhipu";
  if (p === "xiaomi" || p === "xiaomimimo" || p === "mimo") return "MiMo";
  if (!p) return "默认";
  return provider.trim().replace(/^./, (c) => c.toUpperCase());
}

export function quotaHealth(minRemainPct: number): QuotaHealthBadge {
  if (minRemainPct >= 50) return { label: "充裕", tone: "plenty" };
  if (minRemainPct >= 20) return { label: "适中", tone: "moderate" };
  return { label: "紧张", tone: "tight" };
}

export function groupQuotasByProvider(quotas: AgentQuotaBar[] | undefined): QuotaGroupItem[] {
  if (!quotas || quotas.length === 0) return [];
  const groups = new Map<string, { title: string; bars: QuotaGroupItem["bars"] }>();
  for (const q of quotas) {
    const title = providerDisplayName(q.provider);
    const providerKey = title.toLowerCase();
    const remainPct = Math.round(clampPct(100 - q.usedPct) * 10) / 10;
    const entry = groups.get(providerKey) ?? { title, bars: [] };
    entry.bars.push({
      windowLabel: normalizeQuotaWindowLabel(q.label),
      remainPct,
      usedPct: clampPct(q.usedPct),
      resetText: fmtCompactReset(q.resetAt),
      account: q.account,
      note: q.note,
    });
    groups.set(providerKey, entry);
  }
  return [...groups.entries()].map(([providerKey, g]) => {
    const minRemain = g.bars.reduce((acc, b) => Math.min(acc, b.remainPct), 100);
    return {
      providerKey,
      title: g.title,
      health: quotaHealth(minRemain),
      bars: g.bars,
    };
  });
}

export function formatContextScaleMark(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/**
 * Computes honest TTFT, generation TPS, cache hit %, and context window fill ratios
 * solely from observed conversation events, usage reports, and agent metadata.
 */
export function computeTurnTelemetry(
  events: ConvEvent[] | undefined,
  report: AgentUsageReport | null | undefined,
  agent?: Pick<Agent, "contextTokens" | "contextLimit"> | null,
): TurnTelemetryMetrics {
  const session = report?.session ?? null;
  const contextLimit = Math.max(0, session?.contextLimit ?? agent?.contextLimit ?? 0);
  const contextTokens = Math.max(0, session?.contextTokens ?? agent?.contextTokens ?? 0);

  let rawPct: number | null = null;
  if (typeof session?.contextPct === "number" && Number.isFinite(session.contextPct)) {
    rawPct = clampPct(session.contextPct);
  } else if (contextLimit > 0 && contextTokens > 0) {
    rawPct = clampPct((contextTokens / contextLimit) * 100);
  }
  const usedPct = rawPct !== null ? Math.round(rawPct * 10) / 10 : null;
  const remainPct = usedPct !== null ? Math.round(Math.max(0, 100 - usedPct) * 10) / 10 : null;

  const inputTokens = Math.max(0, session?.input ?? 0);
  const cacheReadTokens = Math.max(0, session?.cacheRead ?? 0);
  const cacheWriteTokens = Math.max(0, session?.cacheWrite ?? 0);
  const outputTokens = Math.max(0, session?.output ?? 0);

  const cacheDenom = inputTokens + cacheReadTokens + cacheWriteTokens;
  const cacheHitPct =
    cacheReadTokens > 0 && cacheDenom > 0
      ? Math.round((cacheReadTokens / cacheDenom) * 1000) / 10
      : null;

  let ttftMs: number | null = null;
  let tps: number | null = null;

  if (events && events.length > 0) {
    // Find latest turn boundaries in chronological order
    let turnStartTs: number | null = null;
    let firstResponseTs: number | null = null;
    let latestUsage: { output: number; ts: number } | null = null;
    let turnEndTs: number | null = null;

    for (const ev of events) {
      if (ev.kind === "turn_start" || (ev.kind === "user_message" && !ev.synthetic)) {
        turnStartTs = ev.ts;
        firstResponseTs = null;
        turnEndTs = null;
        latestUsage = null;
      } else if (
        turnStartTs !== null &&
        firstResponseTs === null &&
        (ev.kind === "reasoning" || ev.kind === "assistant_message" || ev.kind === "tool_call") &&
        ev.ts >= turnStartTs
      ) {
        firstResponseTs = ev.ts;
      } else if (ev.kind === "usage" && typeof ev.output === "number" && ev.output >= 8) {
        latestUsage = { output: ev.output, ts: ev.ts };
      } else if (ev.kind === "turn_end" && turnStartTs !== null && ev.ts >= turnStartTs) {
        turnEndTs = ev.ts;
      }
    }

    if (turnStartTs !== null && firstResponseTs !== null) {
      const dt = firstResponseTs - turnStartTs;
      if (dt >= 80 && dt <= 180_000) {
        ttftMs = dt;
      }
    }

    if (latestUsage) {
      const genStart = firstResponseTs ?? turnStartTs;
      const genEnd = turnEndTs ?? latestUsage.ts;
      if (genStart !== null && genEnd > genStart) {
        const genMs = genEnd - genStart;
        if (genMs >= 300 && genMs <= 600_000) {
          const calc = latestUsage.output / (genMs / 1000);
          if (calc > 0.5 && calc < 2000) {
            tps = Math.round(calc * 10) / 10;
          }
        }
      }
    }
  }

  return {
    ttftMs,
    tps,
    cacheHitPct,
    contextTokens,
    contextLimit,
    usedPct,
    remainPct,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
  };
}
