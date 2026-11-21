import type { Region, SourceProbe } from "./index.ts";

const MIRROR_PREFIX_RE = /^(?:https:\/\/[A-Za-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1))(?::\d+)?(?:\/[^\s?#]*)?\/$/;

/**
 * Picks the lowest-latency reachable source from `probes`.
 * Filters `p.ok`, finds the strict minimum `ms`, and allows near-ties within `tieSlackMs`
 * (default 15 ms) to be broken by `recommendedOrder` so timezone-recommended sources win ties.
 */
export function pickLowestLatency(
  probes: readonly SourceProbe[],
  recommendedOrder: readonly string[],
  tieSlackMs = 15,
): string | undefined {
  const ok = probes.filter((p) => p.ok && Number.isFinite(p.ms));
  if (!ok.length) return undefined;
  const best = Math.min(...ok.map((p) => p.ms));
  const slack = Math.max(0, Number.isFinite(tieSlackMs) ? tieSlackMs : 0);
  const rank = (s: string) => {
    const i = recommendedOrder.indexOf(s);
    return i < 0 ? recommendedOrder.length : i;
  };
  return ok
    .filter((p) => p.ms <= best + slack)
    .sort((a, b) => rank(a.source) - rank(b.source) || a.ms - b.ms)[0]!.source;
}

/** Resolves `update.preferredSource` to an explicit source prefix (`""` for `"direct"`, or mirror URL), else `undefined` for `"auto"`. */
export function resolvePreferredSource(preferredSource: string | undefined): string | undefined {
  if (preferredSource === "direct") return "";
  if (typeof preferredSource === "string" && MIRROR_PREFIX_RE.test(preferredSource)) return preferredSource;
  return undefined;
}

/**
 * Orders candidate sources honoring `preferredSource`:
 * - `"direct"` moves `""` first
 * - an explicit mirror prefix puts that prefix first (deduped)
 * - `"auto"` moves `cached` first when present in `base`
 */
export function orderWithPreferredSource(
  base: readonly string[],
  preferredSource: string | undefined,
  cached?: string,
): string[] {
  const explicit = resolvePreferredSource(preferredSource);
  if (explicit !== undefined) {
    return [explicit, ...base.filter((x) => x !== explicit)];
  }
  return cached !== undefined && base.includes(cached)
    ? [cached, ...base.filter((x) => x !== cached)]
    : [...base];
}

/**
 * True when `source` is one of the top timezone-recommended candidates for `region`
 * (top mirrors excluding direct in CN; GitHub direct first globally).
 */
export function isRecommendedSourceForRegion(
  source: string,
  region: Region,
  baseOrder: readonly string[],
  ownMirrorsCount = 0,
): boolean {
  if (region === "cn") {
    if (source === "") return false;
    const idx = baseOrder.indexOf(source);
    return idx >= 0 && idx < Math.max(2, ownMirrorsCount + 2);
  }
  return source === "";
}
