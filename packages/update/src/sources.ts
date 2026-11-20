// Where release files come from: the region decision (environment, config file, time zone),
// a race of short parallel probes that picks the fastest source, and a day-long memory of the
// winner. The decisions themselves are pure functions in the protocol package.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SOURCE_PROBE_SLACK_MS,
  SOURCE_PROBE_TIMEOUT_MS,
  cachedWinner,
  decideRegion,
  pickFastest,
  sourcePrefixes,
  sourceUrl,
  withWinnerFirst,
  type RegionDecision,
  type SourceCache,
  type SourceProbe,
} from "@herdr-pocket/protocol";
import { currentClientConfig } from "./clientconfig.ts";
import { stateDir, type Env } from "./paths.ts";

/** This machine's region now: HERDR_POCKET_MIRROR, then `update.region` in config.json, then the time zone. */
export function currentRegion(env: Env = process.env): RegionDecision {
  return decideRegion({ env: env.HERDR_POCKET_MIRROR, setting: currentClientConfig().config.update.region });
}

export interface SourcePlan {
  decision: RegionDecision;
  /** Prefixes in fallback order ("" is GitHub itself), the remembered winner first. */
  order: string[];
  /** The remembered winner, while it is fresh. */
  cached?: string;
}

export function sourceCachePath(env: Env = process.env): string {
  return join(stateDir(env), "sources.json");
}

export function readSourceCache(path = sourceCachePath()): SourceCache | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SourceCache;
  } catch {
    return undefined;
  }
}

export function writeSourceCache(cache: SourceCache, path = sourceCachePath()): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
    renameSync(tmp, path);
    rmSync(tmp, { force: true });
  } catch {
    /* A read-only state folder only costs a race next time. */
  }
}

export function sourcePlan(env: Env = process.env, now = Date.now()): SourcePlan {
  const decision = currentRegion(env);
  const base = sourcePrefixes(decision.region, currentClientConfig().config.update.mirrors);
  const cached = cachedWinner(readSourceCache(sourceCachePath(env)), decision.region, base, now);
  return { decision, order: withWinnerFirst(base, cached), cached };
}

export interface RaceResult<T> {
  winner?: string;
  value?: T;
  probes: SourceProbe[];
  ms: number;
}

/**
 * Asks every source at once (`attempt` gets its own abort signal, cut after `timeoutMs`). Once one
 * answers, the others get `slackMs` more; then the fastest wins (`pickFastest`: an earlier one in
 * `order` within the slack beats a slightly faster later one) and the rest are aborted.
 */
export async function raceSources<T>(
  order: readonly string[],
  attempt: (source: string, signal: AbortSignal) => Promise<T>,
  o: { timeoutMs?: number; slackMs?: number } = {},
): Promise<RaceResult<T>> {
  const timeoutMs = o.timeoutMs ?? SOURCE_PROBE_TIMEOUT_MS;
  const slackMs = o.slackMs ?? SOURCE_PROBE_SLACK_MS;
  const t0 = Date.now();
  const probes: SourceProbe[] = [];
  const values = new Map<string, T>();
  const controllers = order.map(() => new AbortController());
  if (!order.length) return { probes, ms: 0 };
  return new Promise((resolve) => {
    let done = false;
    let slack: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (slack) clearTimeout(slack);
      for (const c of controllers) c.abort();
      const winner = pickFastest(probes, order, slackMs);
      // Sources still running when the race ended are recorded as too slow.
      for (const s of order) if (!probes.some((p) => p.source === s)) probes.push({ source: s, ok: false, ms: Date.now() - t0, error: "slower than the winner" });
      resolve({ winner, value: winner === undefined ? undefined : values.get(winner), probes, ms: Date.now() - t0 });
    };
    order.forEach((source, i) => {
      const ctl = controllers[i]!;
      const timer = setTimeout(() => ctl.abort(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      const started = Date.now();
      attempt(source, ctl.signal).then(
        (v) => {
          clearTimeout(timer);
          if (done) return;
          values.set(source, v);
          probes.push({ source, ok: true, ms: Date.now() - started });
          if (probes.length === order.length) finish();
          else slack ??= setTimeout(finish, slackMs);
        },
        (e: unknown) => {
          clearTimeout(timer);
          if (done) return;
          const reason = ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason.message : e instanceof Error ? e.message : String(e);
          probes.push({ source, ok: false, ms: Date.now() - started, error: reason.split("\n")[0]!.slice(0, 160) });
          if (probes.length === order.length) finish();
        },
      );
    });
  });
}

/** Full URLs of a github.com file in plan order. */
export function planUrls(plan: SourcePlan, githubUrl: string): string[] {
  return plan.order.map((p) => sourceUrl(p, githubUrl));
}
