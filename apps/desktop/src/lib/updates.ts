import { RELEASE_REPO, decideRegion, sourceLabel, sourcePrefixes, type RegionDecision } from "@herdr-pocket/protocol";
import {
  checkReleaseUpdate,
  downloadAndStageUpdate,
  fetchVersionReleaseNotes,
  fetchVersionSums,
  isTauri,
  onUpdateProgress,
  openExternalUrl,
  platformAssetNameHint,
  restartAndApplyUpdate,
  type ReleaseUpdateInfo,
} from "./bridge";
import { clientConfigStore } from "./config";
import { createStore } from "./store";
import { logger } from "./log";

export type UpdateInstallPhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "staging"
  | "ready"
  | "restarting"
  | "error";

export interface UpdateInstallProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  source?: string;
  message?: string;
}

export interface UpdateState {
  checking: boolean;
  info: ReleaseUpdateInfo | null;
  error: string | null;
  checkedAt: number | null;
  installPhase: UpdateInstallPhase;
  progress: UpdateInstallProgress | null;
  installError: string | null;
  dismissedVersion: string | null;
  minimized: boolean;
  manualNotice: string | null;
}

const LAST_KEY = "herdr-pocket-update-checked-at";

function readLastCheckedAt(): number | null {
  try {
    return typeof localStorage !== "undefined" ? Number(localStorage.getItem(LAST_KEY)) || null : null;
  } catch {
    return null;
  }
}

function saveLastCheckedAt(at: number): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LAST_KEY, String(at));
  } catch {
    // ignore
  }
}

export const updateStore = createStore<UpdateState>({
  checking: false,
  info: null,
  error: null,
  checkedAt: readLastCheckedAt(),
  installPhase: "idle",
  progress: null,
  installError: null,
  dismissedVersion: null,
  minimized: false,
  manualNotice: null,
});

let progressListenerInstalled = false;
function ensureProgressListener(): void {
  if (progressListenerInstalled || !isTauri()) return;
  progressListenerInstalled = true;
  onUpdateProgress((ev) => {
    const cur = updateStore.get();
    if (cur.info && ev.version && ev.version !== cur.info.latest) return;
    if (ev.phase === "error") {
      updateStore.set({
        installPhase: "error",
        installError: ev.message || "更新下载失败",
      });
      return;
    }
    updateStore.set({
      installPhase: ev.phase,
      installError: null,
      progress: {
        downloadedBytes: ev.downloadedBytes,
        totalBytes: ev.totalBytes ?? cur.progress?.totalBytes ?? null,
        percent: ev.percent ?? cur.progress?.percent ?? null,
        source: ev.source ?? cur.progress?.source,
        message: ev.message,
      },
    });
  });
}

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

let manualNoticeTimer: ReturnType<typeof setTimeout> | null = null;
function showManualNotice(msg: string, durationMs = 4500): void {
  if (manualNoticeTimer) clearTimeout(manualNoticeTimer);
  updateStore.set({ manualNotice: msg });
  manualNoticeTimer = setTimeout(() => {
    manualNoticeTimer = null;
    updateStore.set({ manualNotice: null });
  }, durationMs);
}

export async function checkForUpdate(reason: "manual" | "auto" | "startup"): Promise<ReleaseUpdateInfo | null> {
  ensureProgressListener();
  if (updateStore.get().checking) return updateStore.get().info;
  updateStore.set({
    checking: true,
    error: null,
    ...(reason === "manual" ? { dismissedVersion: null, minimized: false, manualNotice: null } : {}),
  });
  const { region, mirrors } = clientConfigStore.get().config.update;
  try {
    // Manual clicks always race fresh sources; startup/background refreshes may reuse recent cache.
    const info = await checkReleaseUpdate({
      setting: region,
      mirrors: [...mirrors],
      forceRace: reason === "manual",
    });
    const at = Date.now();
    saveLastCheckedAt(at);
    const prev = updateStore.get();
    const sameLatestReady = prev.info?.latest === info.latest && prev.installPhase === "ready";
    const changedVersion = prev.info?.latest !== info.latest;
    updateStore.set({
      checking: false,
      info,
      checkedAt: at,
      ...(changedVersion ? { minimized: false, installPhase: "idle", progress: null, installError: null } : sameLatestReady ? {} : {}),
    });
    if (info.hasUpdate && !info.notes?.body) {
      void fetchReleaseNotes(4000, info.latest).then((notes) => {
        if (!notes) return;
        updateStore.set((cur) => (cur.info && cur.info.latest === info.latest ? { ...cur, info: { ...cur.info, notes } } : cur));
      });
    }
    if (reason === "manual" && !info.hasUpdate) {
      showManualNotice(`当前已是最新版本 v${info.current}`);
    }
    const probes = info.probes?.map((p) => `${sourceLabel(p.source) || p.source} ${p.ok ? `${p.ms} ms` : "failed"}`).join(", ");
    logger.info("update", `${reason} check: current ${info.current}, latest ${info.latest}${info.hasUpdate ? " (update available)" : ""}; region ${info.region} (${info.regionReason}), source ${info.source}${probes ? `; probes ${probes}` : ""}`);
    return info;
  } catch (e) {
    const msg = (e as Error).message || "检查更新失败";
    updateStore.set({ checking: false, error: `${msg}：检查网络，或把“下载线路”换一个再试` });
    if (reason === "manual") {
      showManualNotice(`检查更新失败：${msg}`, 5500);
    }
    logger.warn("update", `${reason} check failed: ${msg}`);
    return null;
  }
}

export async function startUpdateDownload(): Promise<void> {
  ensureProgressListener();
  const st = updateStore.get();
  const info = st.info;
  if (!info?.hasUpdate) return;
  if (
    st.installPhase === "downloading" ||
    st.installPhase === "verifying" ||
    st.installPhase === "staging" ||
    st.installPhase === "restarting"
  ) {
    return;
  }

  if (!isTauri()) {
    await openExternalUrl(info.downloadUrl);
    return;
  }

  updateStore.set({
    installPhase: "downloading",
    installError: null,
    progress: {
      downloadedBytes: 0,
      totalBytes: info.assetSize ?? null,
      percent: 0,
      source: info.source,
      message: "正在准备下载…",
    },
  });

  try {
    let sha256 = info.sha256;
    const assetName = info.assetName || platformAssetNameHint(info.latest);
    if (!sha256) {
      const { region, mirrors } = clientConfigStore.get().config.update;
      const sums = await fetchVersionSums(info.latest, { setting: region, mirrors: [...mirrors] });
      sha256 = sums?.[assetName];
      if (sha256) {
        updateStore.set((prev) => (prev.info ? { ...prev, info: { ...prev.info, sha256 } } : prev));
      }
    }
    if (!sha256) {
      throw new Error("未获取到安装包 SHA-256 校验值（可能仍在发布上传中）");
    }

    const res = await downloadAndStageUpdate({
      version: info.latest,
      assetName,
      urls: info.downloadUrls.length ? info.downloadUrls : [info.downloadUrl],
      expectedSha256: sha256,
    });
    if (res.ready) {
      updateStore.set({
        installPhase: "ready",
        installError: null,
        progress: {
          downloadedBytes: info.assetSize ?? 0,
          totalBytes: info.assetSize ?? null,
          percent: 100,
          source: info.source,
          message: "更新已准备就绪",
        },
      });
    }
  } catch (e) {
    const msg = (e as Error).message || "下载或校验更新失败";
    logger.warn("update", `download/stage failed: ${msg}`);
    updateStore.set({
      installPhase: "error",
      installError: msg,
    });
  }
}

export async function restartToApplyUpdate(): Promise<void> {
  const st = updateStore.get();
  if (st.installPhase !== "ready") return;
  updateStore.set({ installPhase: "restarting", installError: null });
  try {
    await restartAndApplyUpdate();
  } catch (e) {
    const msg = (e as Error).message || "重启并安装更新失败";
    logger.warn("update", `restart/apply failed: ${msg}`);
    updateStore.set({ installPhase: "error", installError: msg });
  }
}

export function minimizeUpdatePrompt(): void {
  updateStore.set({ minimized: true });
}

export function restoreUpdatePrompt(): void {
  updateStore.set({ minimized: false, dismissedVersion: null });
}

export function dismissUpdatePrompt(): void {
  const cur = updateStore.get();
  const latest = cur.info?.latest;
  if (!latest) return;
  if (cur.installPhase === "error") {
    updateStore.set({ dismissedVersion: latest, minimized: false, installPhase: "idle", installError: null });
    return;
  }
  updateStore.set({ dismissedVersion: latest, minimized: false });
}

export interface ReleaseNotes {
  body: string;
  url: string;
  publishedAt: string;
}

function stripInstallFooter(body: string): string {
  const cut = body.search(/\r?\n---\r?\n+Relay image:/);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
}

/**
 * Prefers the release's mirrored RELEASE-NOTES.md asset (fast in Mainland China without GitHub API),
 * then falls back to GitHub Releases API when needed.
 */
export async function fetchReleaseNotes(timeoutMs = 4000, version?: string): Promise<ReleaseNotes | null> {
  const cached = updateStore.get().info?.notes;
  if (cached?.body) return cached;
  const target = (version || updateStore.get().info?.latest || "").trim().replace(/^v/i, "");
  if (target) {
    try {
      const { region, mirrors } = clientConfigStore.get().config.update;
      const mirrorNotes = await fetchVersionReleaseNotes(target, { setting: region, mirrors: [...mirrors] });
      if (mirrorNotes) {
        return {
          body: stripInstallFooter(mirrorNotes),
          url: updateStore.get().info?.pageUrl || `https://github.com/${RELEASE_REPO}/releases/tag/v${target}`,
          publishedAt: "",
        };
      }
    } catch {
      // Fallback to GitHub API below
    }
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      signal: abort.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { body?: string; html_url?: string; published_at?: string };
    const cleanBody = j.body ? stripInstallFooter(j.body) : "";
    return cleanBody ? { body: cleanBody, url: j.html_url ?? "", publishedAt: j.published_at ?? "" } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000];
const FOCUS_RECHECK_MS = 30 * 60_000;

/** Startup check (after 4s, immune to unrelated config loads) + focus/wake re-checks + retry backoff. */
export function startAutoUpdateChecks(
  checkFn: (reason: "manual" | "auto" | "startup") => Promise<ReleaseUpdateInfo | null> = checkForUpdate,
): () => void {
  ensureProgressListener();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let startupDone = false;
  let failStreak = 0;
  let stopped = false;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped || !clientConfigStore.get().config.update.autoCheck) return;
      void checkFn("auto").then((res) => {
        failStreak = res ? 0 : failStreak + 1;
        plan();
      });
    }, Math.min(Math.max(10_000, delayMs), 2 ** 31 - 1));
  };

  let prevAuto = clientConfigStore.get().config.update.autoCheck;
  let prevHours = clientConfigStore.get().config.update.checkIntervalHours;

  const plan = () => {
    if (stopped) return;
    const { autoCheck, checkIntervalHours } = clientConfigStore.get().config.update;
    if (!autoCheck) {
      if (timer) clearTimeout(timer);
      timer = null;
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      return;
    }

    if (!startupDone) {
      if (!startupTimer) {
        startupTimer = setTimeout(() => {
          startupTimer = null;
          startupDone = true;
          if (stopped || !clientConfigStore.get().config.update.autoCheck) return;
          void checkFn("startup").then((res) => {
            failStreak = res ? 0 : failStreak + 1;
            plan();
          });
        }, 4_000);
      }
      return;
    }

    if (failStreak > 0) {
      const backoff = RETRY_BACKOFF_MS[Math.min(failStreak - 1, RETRY_BACKOFF_MS.length - 1)]!;
      scheduleNext(backoff);
      return;
    }

    const every = checkIntervalHours * 3_600_000;
    const last = updateStore.get().checkedAt ?? 0;
    const jitter = every * (Math.random() * 0.2 - 0.1);
    const wait = Math.max(60_000, last + every + jitter - Date.now());
    scheduleNext(wait);
  };

  const onFocusOrOnline = () => {
    if (stopped || !clientConfigStore.get().config.update.autoCheck) return;
    const last = updateStore.get().checkedAt ?? 0;
    if (Date.now() - last > FOCUS_RECHECK_MS && !updateStore.get().checking) {
      void checkFn("auto").then((res) => {
        failStreak = res ? 0 : failStreak + 1;
        plan();
      });
    }
  };

  plan();
  const off = clientConfigStore.subscribe(() => {
    const { autoCheck, checkIntervalHours } = clientConfigStore.get().config.update;
    if (autoCheck !== prevAuto || checkIntervalHours !== prevHours) {
      prevAuto = autoCheck;
      prevHours = checkIntervalHours;
      plan();
    }
  });
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocusOrOnline);
    window.addEventListener("online", onFocusOrOnline);
  }
  return () => {
    stopped = true;
    off();
    if (timer) clearTimeout(timer);
    if (startupTimer) clearTimeout(startupTimer);
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onFocusOrOnline);
      window.removeEventListener("online", onFocusOrOnline);
    }
  };
}
