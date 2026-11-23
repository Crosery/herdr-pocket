/**
 * In-app update from GitHub Releases. Checks the latest release at most every 30 minutes,
 * downloads its APK with progress and hands it to the system installer. Network trouble,
 * GitHub's rate limit and a release without an APK all stay quiet unless the person asked.
 * Demo mode never calls GitHub.
 *
 * In mainland China (by the phone's time zone) GitHub is slow or out of reach, so the
 * release's SHA256SUMS and APK come through a mirror first, GitHub after; elsewhere it is
 * the other way round. A download is checked against SHA256SUMS whichever way it came.
 *
 * Android only: releases ship an APK. An iOS app is not installed from inside an app,
 * so on iOS nothing is checked or downloaded (`updatesSupported`).
 */
import { Linking, Platform } from "react-native";
import Constants from "expo-constants";
import { create } from "zustand";
import {
  LATEST_MANIFEST_URL,
  LATEST_SUMS_URL,
  RELEASE_REPO,
  RELEASES_PAGE,
  allReleaseSources,
  apkAssetName,
  compareVersions,
  inMainlandChina,
  parseReleaseManifest,
  releaseAssetUrl,
  releaseFromSums,
  releaseSources,
  resolveChannelFromManifest,
} from "@herdr-pocket/protocol";
import { PocketNative } from "../../modules/pocket-native";
import { isMockServer } from "./mock";
import { useSettings, type ReleaseInfo } from "./store";
import { applog } from "./applog";

export type UpdatePhase = "idle" | "checking" | "latest" | "available" | "downloading" | "ready" | "permission";

interface UpdateState {
  phase: UpdatePhase;
  /** 0..1 while downloading. */
  progress: number;
  /** The downloaded APK, once it is there. */
  path: string | null;
  /** One quiet line for the settings row; null for the default wording. */
  note: string | null;
}

export const useUpdate = create<UpdateState>()(() => ({ phase: "idle", progress: 0, path: null, note: null }));

/** In-app updates install the release APK: Android only. */
export const updatesSupported = Platform.OS === "android";

const CHECK_EVERY_MS = 30 * 60_000;
const set = (patch: Partial<UpdateState>) => useUpdate.setState(patch);

/** The installed version (the APK's versionName), e.g. "0.1.0". */
export function currentVersion(): string {
  return PocketNative?.appVersion?.() ?? Constants.expoConfig?.version ?? "0.0.0";
}

/** The newer release, if one is known. */
export function useNewRelease(): ReleaseInfo | null {
  const r = useSettings((s) => s.updateRelease);
  return r && r.url && compareVersions(r.version, currentVersion()) > 0 ? r : null;
}

/** Drops headings and markdown marks; keeps a few lines for a quick look. */
function shortNotes(body: unknown): string {
  if (typeof body !== "string") return "";
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*[-*+]\s+|\*\*|`/g, "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join("\n")
    .slice(0, 280);
}

type Latest = { kind: "release"; release: ReleaseInfo } | { kind: "none" } | { kind: "unknown"; why: "offline" | "limited" | "missing" };

/** `fetch` that gives up after `ms`. */
async function fetchWithin(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves Android channel release from `RELEASE-MANIFEST.json` (carries forward APK version across desktop-only releases). */
async function fetchFromManifest(url: string): Promise<Latest> {
  let res: Response;
  try {
    res = await fetchWithin(url, 10_000);
  } catch {
    return { kind: "unknown", why: "offline" };
  }
  if (!res.ok) {
    return { kind: "unknown", why: res.status === 404 ? "missing" : res.status === 403 || res.status === 429 ? "limited" : "offline" };
  }
  const manifest = parseReleaseManifest(await res.text().catch(() => ""));
  if (!manifest) return { kind: "unknown", why: "missing" };
  const entry = resolveChannelFromManifest(manifest, "android-arm64");
  if (!entry) return { kind: "none" };
  return {
    kind: "release",
    release: {
      version: entry.version,
      url: releaseAssetUrl(entry.version, entry.fileName),
      fileName: entry.fileName,
      size: entry.size ?? 0,
      sha256: entry.sha256,
      page: `https://github.com/${RELEASE_REPO}/releases/tag/${entry.tag}`,
      notes: "",
    },
  };
}

/** Fallback for older releases without `RELEASE-MANIFEST.json`: parses `SHA256SUMS`. */
async function fetchFromSums(url: string): Promise<Latest> {
  let res: Response;
  try {
    res = await fetchWithin(url, 10_000);
  } catch {
    return { kind: "unknown", why: "offline" };
  }
  if (!res.ok) return { kind: "unknown", why: res.status === 404 ? "missing" : res.status === 403 || res.status === 429 ? "limited" : "offline" };
  const found = releaseFromSums(await res.text().catch(() => ""));
  if (!found) return { kind: "unknown", why: "offline" };
  const exact = apkAssetName(found.version);
  const matchedEntry = found.sums[exact]
    ? { fileName: exact, version: found.version, sha256: found.sums[exact]! }
    : Object.entries(found.sums)
        .map(([fileName, sha256]) => {
          const m = /^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-android-arm64\.apk$/.exec(fileName);
          return m?.[1] ? { fileName, version: m[1], sha256 } : null;
        })
        .find((x): x is { fileName: string; version: string; sha256: string } => Boolean(x));
  if (!matchedEntry) return { kind: "unknown", why: "missing" };
  return {
    kind: "release",
    release: {
      version: matchedEntry.version,
      url: releaseAssetUrl(matchedEntry.version, matchedEntry.fileName),
      fileName: matchedEntry.fileName,
      size: 0,
      sha256: matchedEntry.sha256,
      page: `https://github.com/${RELEASE_REPO}/releases/tag/v${matchedEntry.version}`,
      notes: "",
    },
  };
}

async function raceMirrorCalls(fns: Array<() => Promise<Latest>>): Promise<Latest | null> {
  if (!fns.length) return null;
  try {
    return await Promise.any(
      fns.map(async (fn) => {
        const r = await fn();
        if (r.kind === "unknown") throw new Error(r.why);
        return r;
      }),
    );
  } catch {
    return null;
  }
}

/** Sources in order until one answers; mirrors race `RELEASE-MANIFEST.json` first, then `SHA256SUMS` / GitHub API. */
async function fetchLatest(): Promise<Latest> {
  const china = inMainlandChina();
  const manifests = releaseSources(LATEST_MANIFEST_URL, china).map((u) => () => fetchFromManifest(u));
  const sums = releaseSources(LATEST_SUMS_URL, china).map((u) => () => fetchFromSums(u));
  if (china && manifests.length > 1) {
    const mHit = await raceMirrorCalls(manifests.slice(0, -1));
    if (mHit) return mHit;
    const sHit = await raceMirrorCalls(sums.slice(0, -1));
    if (sHit) return sHit;
    const rest = [fetchFromApi, manifests[manifests.length - 1]!, sums[sums.length - 1]!];
    let last: Latest = { kind: "unknown", why: "offline" };
    for (const attempt of rest) {
      last = await attempt();
      if (last.kind !== "unknown") return last;
    }
    return last;
  }
  const tries = [...manifests, fetchFromApi, ...sums];
  let last: Latest = { kind: "unknown", why: "offline" };
  for (const attempt of tries) {
    last = await attempt();
    if (last.kind !== "unknown") return last;
  }
  return last;
}

/** The GitHub API: scans recent non-draft releases to find the newest release that ships an Android APK. */
async function fetchFromApi(): Promise<Latest> {
  let res: Response;
  try {
    res = await fetchWithin(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=8`, 12_000, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
  } catch {
    return { kind: "unknown", why: "offline" };
  }
  if (res.status === 404) return { kind: "none" };
  if (!res.ok) return { kind: "unknown", why: res.status === 403 || res.status === 429 ? "limited" : "offline" };
  const list = (await res.json().catch(() => null)) as Array<{
    draft?: boolean;
    prerelease?: boolean;
    tag_name?: string;
    html_url?: string;
    body?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number; digest?: string | null }[];
  }> | null;
  if (!Array.isArray(list)) return { kind: "unknown", why: "offline" };
  for (const json of list) {
    if (json.draft || json.prerelease) continue;
    const tagVersion = json.tag_name?.trim().replace(/^v/i, "") ?? "";
    const assets = json.assets ?? [];
    const want = tagVersion ? apkAssetName(tagVersion) : "";
    const apk =
      (want ? assets.find((a) => a.name === want && a.browser_download_url) : undefined) ??
      assets.find((a) => a.name && /^herdr-pocket-.+-android-arm64\.apk$/.test(a.name) && a.browser_download_url);
    if (!apk?.browser_download_url) continue;
    const verMatch = apk.name ? /^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-android-arm64\.apk$/.exec(apk.name) : null;
    const version = verMatch?.[1] || tagVersion;
    if (!version) continue;
    return {
      kind: "release",
      release: {
        version,
        url: apk.browser_download_url,
        fileName: apk.name ?? apkAssetName(version),
        size: apk.size ?? 0,
        sha256: /^sha256:([0-9a-f]{64})$/i.exec(apk.digest ?? "")?.[1]?.toLowerCase(),
        page: json.html_url ?? RELEASES_PAGE,
        notes: shortNotes(json.body),
      },
    };
  }
  return { kind: "none" };
}

/**
 * `manual`: the person tapped "检查更新" and wants an answer. Otherwise this is the quiet
 * background check, which runs at most every 30 minutes.
 */
export async function checkForUpdate(manual = false): Promise<void> {
  const s = useSettings.getState();
  const { phase } = useUpdate.getState();
  if (phase === "checking" || phase === "downloading") return;
  if (!updatesSupported) {
    if (manual) set({ phase: "latest", note: "iOS 版不在 App 里更新" });
    return;
  }
  if (isMockServer(s.server)) {
    if (manual) set({ phase: "latest", note: "演示模式不检查更新" });
    return;
  }
  if (!manual && Date.now() - s.updateCheckedAt < CHECK_EVERY_MS) {
    syncPhase();
    return;
  }
  if (manual) set({ phase: "checking", note: null });
  const latest = await fetchLatest();
  if (latest.kind === "unknown") {
    applog("info", "update", `update check failed: ${latest.why}`);
    // Try again on the next start rather than waiting 30 minutes.
    syncPhase(manual ? (latest.why === "limited" ? "GitHub 暂时不让查了，过一会儿再试" : "暂时连不上 GitHub，过会儿再试") : null);
    return;
  }
  const release = latest.kind === "release" ? latest.release : null;
  const newer = Boolean(release?.url) && compareVersions(release!.version, currentVersion()) > 0;
  useSettings.getState().set({
    updateCheckedAt: Date.now(),
    updateRelease: newer ? release : null,
    // Found by hand in Settings: the person is already looking at it, so no extra prompt.
    ...(manual && newer && release?.url ? { updatePrompted: release.version } : {}),
  });
  syncPhase(null);
}

/** Phase from what is known, keeping a download that is under way. */
function syncPhase(note: string | null = null): void {
  const { phase } = useUpdate.getState();
  if (phase === "downloading" || phase === "ready" || phase === "permission") return;
  const r = useSettings.getState().updateRelease;
  const newer = !!r?.url && compareVersions(r.version, currentVersion()) > 0;
  set({ phase: newer ? "available" : note || phase !== "idle" ? "latest" : "idle", note });
}

/** Downloads the newer APK, then opens the installer. Without the native updater, opens the release page. */
export async function downloadUpdate(): Promise<void> {
  const r = useSettings.getState().updateRelease;
  if (!r || !updatesSupported) return;
  const native = PocketNative;
  if (!r.url || !native?.downloadUpdate || !native.installUpdate) {
    await Linking.openURL(r.page).catch(() => undefined);
    return;
  }
  if (useUpdate.getState().phase === "downloading") return;
  set({ phase: "downloading", progress: 0, note: null });
  const sub = native.addListener("onUpdateProgress", (e) => {
    if (e.total > 0) set({ progress: Math.min(1, e.received / e.total) });
  });
  try {
    let path: string | null = null;
    let failed: unknown;
    const urls = allReleaseSources(r.url, inMainlandChina());
    if (native.downloadUpdateUrls) {
      path = await native.downloadUpdateUrls(urls, r.fileName, r.size, r.sha256 ?? "");
    } else {
      for (const url of urls) {
        try {
          path = await native.downloadUpdate!(url, r.fileName, r.size, r.sha256 ?? "");
          break;
        } catch (e) {
          failed = e;
          applog("info", "update", `download of ${r.version} from ${url.replace(/^https?:\/\/([^/]+).*$/, "$1")} failed: ${(e as Error)?.message ?? String(e)}`);
          set({ progress: 0 });
        }
      }
    }
    if (!path) throw failed ?? new Error("download failed");
    set({ phase: "ready", path, progress: 1 });
    installUpdate();
  } catch (e) {
    applog("warn", "update", `download of ${r.version} failed: ${(e as Error)?.message ?? String(e)}`);
    // The release may have changed since it was looked up: look again next time.
    useSettings.getState().set({ updateCheckedAt: 0 });
    set({ phase: "available", progress: 0, note: "下载没成功，检查一下网络再试" });
  } finally {
    sub.remove();
  }
}

/** Opens the system installer; the first time, Android asks to allow installing from this app. */
export function installUpdate(): void {
  const { path } = useUpdate.getState();
  if (!path || !PocketNative?.installUpdate) return;
  const r = PocketNative.installUpdate(path);
  if (r === "permission") set({ phase: "permission", note: null });
  else if (r === "missing") set({ phase: "available", path: null, note: null });
  else set({ phase: "ready", note: "按系统提示完成安装" });
}

/** Back from the "install unknown apps" settings page: carry on if it was allowed. */
export function resumeInstallIfAllowed(): void {
  if (useUpdate.getState().phase === "permission" && PocketNative?.canInstallUpdates?.()) installUpdate();
}
