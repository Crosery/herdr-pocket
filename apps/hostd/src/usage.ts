import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agent, AgentQuotaBar, AgentUsageModelRow, AgentUsageReport, UsageRow } from "@herdr-pocket/protocol";
import { findPrograms } from "./create.ts";
import { harnessId, type UnifloAdapter } from "./uniflo.ts";

const execFileAsync = promisify(execFile);

const WINDOW_CACHE_MS = 15_000;
const QUOTA_CACHE_MS = 30_000;

interface CachedWindow {
  at: number;
  data: { rows: UsageRow[]; total: UsageRow };
}

const windowCache = new Map<string, CachedWindow>();
let quotaCache: { at: number; bars: AgentQuotaBar[] } | null = null;

function sanitizeAccountLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("@")) {
    const [local, domain] = trimmed.split("@");
    const masked = local && local.length > 2 ? `${local.slice(0, 2)}***` : "***";
    return domain ? `${masked}@${domain}` : masked;
  }
  return trimmed.slice(0, 32);
}

/** Parses `omp usage --json --redact` output defensively without forwarding secrets or emails. */
export function parseOmpUsageJson(raw: string): AgentQuotaBar[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const reports = (parsed as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return [];

  const bars: AgentQuotaBar[] = [];
  for (const r of reports) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const provider = String(rec.provider ?? rec.providerId ?? rec.id ?? "").trim();
    if (!provider) continue;
    const account = sanitizeAccountLabel(rec.account ?? rec.label ?? rec.credentialId ?? rec.redactedAccount);

    const bucketList = Array.isArray(rec.windows)
      ? rec.windows
      : Array.isArray(rec.buckets)
        ? rec.buckets
        : Array.isArray(rec.limits)
          ? rec.limits
          : [rec];

    for (const b of bucketList) {
      if (!b || typeof b !== "object") continue;
      const item = b as Record<string, unknown>;
      const rawPct =
        typeof item.usedPct === "number"
          ? item.usedPct
          : typeof item.usedPercent === "number"
            ? item.usedPercent
            : typeof item.percent === "number"
              ? item.percent
              : typeof item.used_pct === "number"
                ? item.used_pct
                : typeof item.utilization === "number"
                  ? item.utilization * (item.utilization <= 1 ? 100 : 1)
                  : undefined;
      if (rawPct === undefined || !Number.isFinite(rawPct)) continue;
      const clamped = Math.max(0, Math.min(100, Math.round(rawPct * 10) / 10));
      const label = String(item.label ?? item.window ?? item.name ?? "额度占用").trim().slice(0, 40) || "额度占用";
      const resetRaw = item.resetAt ?? item.reset_at ?? item.resetsAt;
      const resetAt =
        typeof resetRaw === "number" && Number.isFinite(resetRaw)
          ? resetRaw > 1e12
            ? resetRaw
            : resetRaw * 1000
          : typeof resetRaw === "string" && Date.parse(resetRaw)
            ? Date.parse(resetRaw)
            : undefined;
      const note = typeof item.note === "string" && item.note.trim() ? item.note.trim().slice(0, 80) : undefined;
      bars.push({
        provider,
        ...(account ? { account } : {}),
        label,
        usedPct: clamped,
        ...(resetAt ? { resetAt } : {}),
        ...(note ? { note } : {}),
      });
      if (bars.length >= 12) return bars;
    }
  }
  return bars;
}

export async function getDefaultOmpQuotas(): Promise<AgentQuotaBar[]> {
  if (quotaCache && Date.now() - quotaCache.at < QUOTA_CACHE_MS) return quotaCache.bars;
  try {
    const found = await findPrograms(["omp"]);
    const bin = found.get("omp");
    if (!bin) {
      quotaCache = { at: Date.now(), bars: [] };
      return [];
    }
    const { stdout } = await execFileAsync(bin, ["usage", "--json", "--redact"], { timeout: 3500, maxBuffer: 512 * 1024 });
    const bars = parseOmpUsageJson(stdout);
    quotaCache = { at: Date.now(), bars };
    return bars;
  } catch {
    return quotaCache?.bars ?? [];
  }
}

export interface UsageLike {
  sessionUsage(sessionKey: string): Promise<{
    turns: number;
    steps: number;
    prompts: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    costUsd: number;
    unpricedSteps: number;
    contextTokens?: number;
    contextLimit?: number;
    contextPct?: number;
    model?: string;
    models: AgentUsageModelRow[];
  }>;
  usage(since: string | undefined, groupBy: string): Promise<{ since?: number; rows: UsageRow[]; total: UsageRow }>;
}

async function cachedWindowUsage(uniflo: UsageLike, since: "24h" | "7d"): Promise<{ rows: UsageRow[]; total: UsageRow } | null> {
  const hit = windowCache.get(since);
  if (hit && Date.now() - hit.at < WINDOW_CACHE_MS) return hit.data;
  try {
    const res = await uniflo.usage(since, "harness");
    const data = { rows: res.rows, total: res.total };
    windowCache.set(since, { at: Date.now(), data });
    return data;
  } catch {
    return hit?.data ?? null;
  }
}

function pickHarnessWindow(
  win: { rows: UsageRow[]; total: UsageRow } | null,
  harness: string,
): { harness?: UsageRow; total: UsageRow } | null {
  if (!win) return null;
  const norm = (harnessId(harness) ?? harness).toLowerCase();
  const matched = win.rows.find((r) => r.key.toLowerCase() === norm || r.label.toLowerCase() === harness.toLowerCase());
  return { ...(matched ? { harness: matched } : {}), total: win.total };
}

export function clearUsageCachesForTest(): void {
  windowCache.clear();
  quotaCache = null;
}

export async function getAgentUsageReport(
  agent: Agent,
  opts: {
    uniflo?: UsageLike;
    unifloReady?: boolean;
    sessionKey?: string;
    readOmpQuotas?: () => Promise<AgentQuotaBar[]>;
  } = {},
): Promise<AgentUsageReport> {
  const effectiveKey = opts.sessionKey ?? agent.sessionKey;
  const uniflo = opts.unifloReady === false ? undefined : opts.uniflo;

  const sessionPromise =
    uniflo && effectiveKey
      ? uniflo.sessionUsage(effectiveKey).catch(() => null)
      : Promise.resolve(null);
  const w24Promise = uniflo ? cachedWindowUsage(uniflo, "24h") : Promise.resolve(null);
  const w7Promise = uniflo ? cachedWindowUsage(uniflo, "7d") : Promise.resolve(null);
  const quotaPromise = (opts.readOmpQuotas ?? getDefaultOmpQuotas)().catch(() => []);

  const [detail, w24, w7, quotas] = await Promise.all([sessionPromise, w24Promise, w7Promise, quotaPromise]);

  let session: AgentUsageReport["session"] = null;
  if (detail) {
    session = {
      turns: detail.turns,
      steps: detail.steps,
      prompts: detail.prompts,
      input: detail.input,
      output: detail.output,
      cacheRead: detail.cacheRead,
      cacheWrite: detail.cacheWrite,
      reasoning: detail.reasoning,
      costUsd: detail.costUsd,
      unpricedSteps: detail.unpricedSteps,
      ...(detail.contextTokens !== undefined ? { contextTokens: detail.contextTokens } : agent.contextTokens !== undefined ? { contextTokens: agent.contextTokens } : {}),
      ...(detail.contextLimit !== undefined ? { contextLimit: detail.contextLimit } : agent.contextLimit !== undefined ? { contextLimit: agent.contextLimit } : {}),
      ...(detail.contextPct !== undefined
        ? { contextPct: detail.contextPct }
        : agent.contextTokens !== undefined && agent.contextLimit
          ? { contextPct: (agent.contextTokens / agent.contextLimit) * 100 }
          : {}),
    };
  } else if (agent.costUsd !== undefined || agent.contextTokens !== undefined || agent.contextLimit !== undefined) {
    session = {
      turns: agent.turn ?? 0,
      steps: 0,
      prompts: agent.turn ?? 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      costUsd: agent.costUsd ?? 0,
      unpricedSteps: 0,
      ...(agent.contextTokens !== undefined ? { contextTokens: agent.contextTokens } : {}),
      ...(agent.contextLimit !== undefined ? { contextLimit: agent.contextLimit } : {}),
      ...(agent.contextTokens !== undefined && agent.contextLimit ? { contextPct: (agent.contextTokens / agent.contextLimit) * 100 } : {}),
    };
  }

  return {
    harness: agent.harness,
    ...(effectiveKey ? { sessionKey: effectiveKey } : {}),
    ...(detail?.model ?? agent.model ? { model: detail?.model ?? agent.model } : {}),
    session,
    models: detail?.models ?? [],
    day24h: pickHarnessWindow(w24, agent.harness),
    day7d: pickHarnessWindow(w7, agent.harness),
    quotas,
  };
}
