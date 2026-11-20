import { RELEASE_REPO, decideRegion, sourceLabel, sourcePrefixes, type RegionDecision } from "@herdr-pocket/protocol";
import { checkReleaseUpdate, type ReleaseUpdateInfo } from "./bridge";
import { clientConfigStore } from "./config";
import { createStore } from "./store";
import { logger } from "./log";

export interface UpdateState {
  checking: boolean;
  info: ReleaseUpdateInfo | null;
  error: string | null;
  checkedAt: number | null;
}

const LAST_KEY = "herdr-pocket-update-checked-at";

export const updateStore = createStore<UpdateState>({
  checking: false,
  info: null,
  error: null,
  checkedAt: Number(localStorage.getItem(LAST_KEY)) || null,
});

/** Where downloads go first, from config.json `update.region` (auto = by time zone). */
export function currentRegion(): RegionDecision {
  return decideRegion({ setting: clientConfigStore.get().config.update.region });
}

/** Sources in the order they are raced for `region`, as host names ("github.com", mirror hosts). */
export function sourceOrder(region: RegionDecision["region"]): string[] {
  return sourcePrefixes(region, clientConfigStore.get().config.update.mirrors).map(sourceLabel);
}

/** Why this region was picked, in a sentence. */
export function regionReason(d: RegionDecision): string {
  switch (d.reason) {
    case "env":
      return "由环境变量 HERDR_POCKET_MIRROR 决定";
    case "config":
      return "按你在这里的选择";
    case "time-zone":
      return `按这台电脑的时区 ${d.timeZone || "（未知）"} 判断`;
    case "locale-offset":
      return `按时区偏移和系统语言判断（时区 ${d.timeZone || "未知"}）`;
    default:
      return `时区 ${d.timeZone || "（未知）"} 不在镜像优先的范围里`;
  }
}

/** "先试 a，再试 b、c": the race order, shortened. */
export function orderSentence(region: RegionDecision["region"]): string {
  const [first, ...rest] = sourceOrder(region);
  if (!first) return "";
  return rest.length ? `先试 ${first}，再试 ${rest.slice(0, 3).join("、")}${rest.length > 3 ? " 等" : ""}` : `只用 ${first}`;
}

/** How the last check went: the source that answered and how long it took. */
export function lastSourceSentence(info: ReleaseUpdateInfo): string {
  const won = info.probes?.find((p) => p.ok && (p.source === info.source || sourceLabel(p.source) === info.source));
  if (won) return `上次检查走的是 ${info.source}，${(won.ms / 1000).toFixed(1)} 秒响应`;
  if (!info.probes?.length) return `上次检查直接用了之前测出最快的 ${info.source}`;
  return `上次检查走的是 ${info.source}`;
}

export async function checkForUpdate(reason: "manual" | "auto"): Promise<ReleaseUpdateInfo | null> {
  if (updateStore.get().checking) return updateStore.get().info;
  updateStore.set({ checking: true, error: null });
  const { region, mirrors } = clientConfigStore.get().config.update;
  try {
    // The native side races the sources itself; downloadUrl already goes through the winner.
    const info = await checkReleaseUpdate({ setting: region, mirrors: [...mirrors] });
    const at = Date.now();
    localStorage.setItem(LAST_KEY, String(at));
    updateStore.set({ checking: false, info, checkedAt: at });
    const probes = info.probes?.map((p) => `${sourceLabel(p.source) || p.source} ${p.ok ? `${p.ms} ms` : "failed"}`).join(", ");
    logger.info("update", `${reason} check: current ${info.current}, latest ${info.latest}${info.hasUpdate ? " (update available)" : ""}; region ${info.region} (${info.regionReason}), source ${info.source}${probes ? `; probes ${probes}` : ""}`);
    return info;
  } catch (e) {
    const msg = (e as Error).message || "检查更新失败";
    updateStore.set({ checking: false, error: `${msg}：检查网络，或把“下载线路”换一个再试` });
    logger.warn("update", `${reason} check failed: ${msg}`);
    return null;
  }
}

export interface ReleaseNotes {
  body: string;
  url: string;
  publishedAt: string;
}

/**
 * Release notes exist only in the GitHub API, which mirrors don't carry and which is often slow
 * from mainland China: a short wait, then null (the UI links to the release page instead).
 */
export async function fetchReleaseNotes(timeoutMs = 4000): Promise<ReleaseNotes | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      signal: abort.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { body?: string; html_url?: string; published_at?: string };
    return j.body ? { body: j.body, url: j.html_url ?? "", publishedAt: j.published_at ?? "" } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Background checks per `update.autoCheck` / `update.checkIntervalHours`, ±10% jitter. */
export function startAutoUpdateChecks(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const plan = () => {
    const { autoCheck, checkIntervalHours } = clientConfigStore.get().config.update;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!autoCheck) return;
    const every = checkIntervalHours * 3_600_000;
    const last = updateStore.get().checkedAt ?? 0;
    const jitter = every * (Math.random() * 0.2 - 0.1);
    // First look waits a minute so startup stays quiet.
    const wait = Math.max(60_000, last + every + jitter - Date.now());
    timer = setTimeout(() => {
      void checkForUpdate("auto").finally(plan);
    }, Math.min(wait, 2 ** 31 - 1));
  };
  plan();
  const off = clientConfigStore.subscribe(plan);
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}
