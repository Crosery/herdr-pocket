/**
 * In-app update from GitHub Releases. Checks the latest release at most every 12 hours,
 * downloads its APK with progress and hands it to the system installer. Network trouble,
 * GitHub's rate limit and a release without an APK all stay quiet unless the person asked.
 * Demo mode never calls GitHub.
 */
import { Linking } from "react-native";
import Constants from "expo-constants";
import { create } from "zustand";
import { RELEASE_REPO, RELEASES_PAGE, apkAssetName, compareVersions } from "@herdr-pocket/protocol";
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

const CHECK_EVERY_MS = 12 * 3600_000;
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

type Latest = { kind: "release"; release: ReleaseInfo } | { kind: "none" } | { kind: "unknown"; why: "offline" | "limited" };

async function fetchLatest(): Promise<Latest> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: abort.signal,
    });
  } catch {
    return { kind: "unknown", why: "offline" };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return { kind: "none" };
  if (!res.ok) return { kind: "unknown", why: res.status === 403 || res.status === 429 ? "limited" : "offline" };
  const json = (await res.json().catch(() => null)) as {
    tag_name?: string;
    html_url?: string;
    body?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  } | null;
  const version = json?.tag_name?.trim().replace(/^v/i, "");
  if (!version) return { kind: "unknown", why: "offline" };
  const assets = json?.assets ?? [];
  const want = apkAssetName(version);
  const apk = assets.find((a) => a.name === want) ?? assets.find((a) => a.name && /^herdr-pocket-.+-android-arm64\.apk$/.test(a.name));
  return {
    kind: "release",
    release: {
      version,
      url: apk?.browser_download_url ?? "",
      fileName: apk?.name ?? want,
      size: apk?.size ?? 0,
      page: json?.html_url ?? RELEASES_PAGE,
      notes: shortNotes(json?.body),
    },
  };
}

/**
 * `manual`: the person tapped "检查更新" and wants an answer. Otherwise this is the quiet
 * background check, which runs at most every 12 hours.
 */
export async function checkForUpdate(manual = false): Promise<void> {
  const s = useSettings.getState();
  const { phase } = useUpdate.getState();
  if (phase === "checking" || phase === "downloading") return;
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
    // Try again on the next start rather than in 12 hours.
    syncPhase(manual ? (latest.why === "limited" ? "GitHub 暂时不让查了，过一会儿再试" : "暂时连不上 GitHub，过会儿再试") : null);
    return;
  }
  const release = latest.kind === "release" ? latest.release : null;
  const newer = !!release && compareVersions(release.version, currentVersion()) > 0;
  useSettings.getState().set({
    updateCheckedAt: Date.now(),
    updateRelease: newer ? release : null,
    // Found by hand in Settings: the person is already looking at it, so no extra prompt.
    ...(manual && newer && release?.url ? { updatePrompted: release.version } : {}),
  });
  const waiting = newer && !release?.url;
  syncPhase(manual && waiting ? `v${release?.version} 已发布，安卓安装包还没传上来` : null);
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
  if (!r) return;
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
    const path = await native.downloadUpdate(r.url, r.fileName, r.size);
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
