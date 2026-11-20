import {
  LATEST_SUMS_URL,
  RELEASE_REPO,
  allReleaseSources,
  compareVersions,
  inMainlandChina,
  releaseFromSums,
  type PutFile,
} from "@herdr-pocket/protocol";

declare const __POCKET_TARGET__: "desktop" | "harmony";
declare const __APP_VERSION__: string;

export type PlatformKind = "macos" | "windows" | "linux" | "openharmony" | "web";

export interface SavedSession {
  server: string;
  token: string;
  deviceId: string;
  deviceName: string;
  lastServer?: string;
}

export interface HostdLocalStatus {
  installed: boolean;
  configured: boolean;
  server?: string;
  deviceName?: string;
}

export interface HarmonyBridgeApi {
  platform?: () => string;
  deviceName?: () => string;
  appVersion?: () => string;
  getPref?: (key: string) => string;
  setPref?: (key: string, val: string) => void;
  deletePref?: (key: string) => void;
  notify?: (title: string, body: string) => void;
  openExternal?: (url: string) => void;
  requestMicrophone?: () => Promise<boolean> | boolean;
  getSafeArea?: () => string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    PocketHarmony?: HarmonyBridgeApi;
    __POCKET_SET_SAFE_AREA__?: (topPx: number, bottomPx: number) => void;
    __POCKET_OPEN_URL__?: (url: string) => void;
  }
}

export const IS_HARMONY_TARGET =
  typeof __POCKET_TARGET__ !== "undefined" && __POCKET_TARGET__ === "harmony";

export function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function isHarmony(): boolean {
  if (IS_HARMONY_TARGET) return true;
  return typeof window !== "undefined" && Boolean(window.PocketHarmony);
}

export function appVersion(): string {
  const fromHarmony = window.PocketHarmony?.appVersion?.();
  if (fromHarmony && fromHarmony.trim()) return fromHarmony.trim();
  return typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.2.0";
}

export function detectPlatform(): PlatformKind {
  if (isHarmony()) return "openharmony";
  const nav = typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}`.toLowerCase() : "";
  if (nav.includes("mac")) return "macos";
  if (nav.includes("win")) return "windows";
  if (nav.includes("linux") && !nav.includes("android")) return "linux";
  return isTauri() ? "macos" : "web";
}

export function defaultDeviceName(): string {
  const harmonyName = window.PocketHarmony?.deviceName?.();
  if (harmonyName && harmonyName.trim()) return harmonyName.trim().slice(0, 40);
  const p = detectPlatform();
  if (p === "openharmony") return "我的鸿蒙设备";
  if (p === "macos") return "我的 Mac";
  if (p === "windows") return "我的 Windows 电脑";
  if (p === "linux") return "我的 Linux 电脑";
  return "我的浏览器";
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(cmd, args);
}

const SESSION_KEY = "herdr-pocket-client-session-v1";

export async function loadSession(): Promise<SavedSession | null> {
  if (isTauri()) {
    try {
      const s = await tauriInvoke<SavedSession | null>("load_auth");
      if (s && s.server && s.token) return s;
    } catch {
      // Fall through to localStorage
    }
  }
  if (window.PocketHarmony?.getPref) {
    try {
      const raw = window.PocketHarmony.getPref(SESSION_KEY);
      if (raw) return JSON.parse(raw) as SavedSession;
    } catch {
      // ignore
    }
  }
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: SavedSession): Promise<void> {
  if (isTauri()) {
    try {
      await tauriInvoke("save_auth", { session });
    } catch {
      // Fallback below
    }
  }
  const encoded = JSON.stringify(session);
  if (window.PocketHarmony?.setPref) {
    try {
      window.PocketHarmony.setPref(SESSION_KEY, encoded);
    } catch {
      // Fallback below
    }
  }
  try {
    localStorage.setItem(SESSION_KEY, encoded);
  } catch {
    // ignore
  }
}

export async function clearSession(): Promise<void> {
  if (isTauri()) {
    try {
      await tauriInvoke("clear_auth");
    } catch {
      // ignore
    }
  }
  if (window.PocketHarmony?.deletePref) {
    try {
      window.PocketHarmony.deletePref(SESSION_KEY);
    } catch {
      // ignore
    }
  }
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export async function getHostdStatus(): Promise<HostdLocalStatus | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<HostdLocalStatus>("hostd_status");
  } catch {
    return null;
  }
}

export async function pushSystemNotification(title: string, body: string): Promise<void> {
  if (window.PocketHarmony?.notify) {
    try {
      window.PocketHarmony.notify(title, body);
      return;
    } catch {
      // fallback
    }
  }
  if (isTauri()) {
    try {
      const notif = await import("@tauri-apps/plugin-notification");
      let granted = await notif.isPermissionGranted();
      if (!granted) {
        granted = (await notif.requestPermission()) === "granted";
      }
      if (granted) {
        notif.sendNotification({ title, body });
        return;
      }
    } catch {
      // fallback
    }
  }
  if (typeof Notification !== "undefined") {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission === "default") {
      const p = await Notification.requestPermission().catch(() => "denied");
      if (p === "granted") new Notification(title, { body });
    }
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  if (window.PocketHarmony?.requestMicrophone) {
    try {
      const ok = await window.PocketHarmony.requestMicrophone();
      return Boolean(ok);
    } catch {
      return false;
    }
  }
  return true;
}

export async function openExternalUrl(url: string): Promise<void> {
  if (window.PocketHarmony?.openExternal) {
    try {
      window.PocketHarmony.openExternal(url);
      return;
    } catch {
      // fallback
    }
  }
  if (isTauri()) {
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
      return;
    } catch {
      // fallback
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `./assets/${clean}`;
}

export async function encodeImageFiles(files: File[], maxCount = 6, maxSide = 1280): Promise<PutFile[]> {
  const picked = files.filter((f) => f.type.startsWith("image/")).slice(0, maxCount);
  const out: PutFile[] = [];
  for (const file of picked) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片解码失败"));
      el.src = dataUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
    const w = Math.max(1, Math.round((img.width || 1) * scale));
    const h = Math.max(1, Math.round((img.height || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    ctx.drawImage(img, 0, 0, w, h);
    const jpegUrl = canvas.toDataURL("image/jpeg", 0.84);
    const b64 = jpegUrl.split(",")[1] ?? "";
    if (!b64) continue;
    const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
    out.push({ name: `${baseName}.jpg`, mime: "image/jpeg", data: b64 });
  }
  return out;
}

export interface ReleaseUpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  pageUrl: string;
  downloadUrl: string;
}

async function detectMacArch(): Promise<"arm64" | "x64"> {
  if (isTauri()) {
    try {
      const arch = await tauriInvoke<string>("runtime_arch");
      if (arch === "aarch64" || arch === "arm64") return "arm64";
      if (arch === "x86_64" || arch === "x64") return "x64";
    } catch {
      // Fallback to navigator heuristic outside Tauri
    }
  }
  return typeof navigator !== "undefined" && /intel|x86_64/i.test(navigator.userAgent) ? "x64" : "arm64";
}

function platformDownloadAsset(version: string, platform: PlatformKind, macArch: "arm64" | "x64"): string {
  const clean = version.trim().replace(/^v/i, "");
  switch (platform) {
    case "openharmony":
      return `herdr-pocket-${clean}-harmonyos-arm64.hap`;
    case "macos":
      return `herdr-pocket-${clean}-macos-${macArch}.dmg`;
    case "windows":
      return `herdr-pocket-${clean}-windows-x64-setup.exe`;
    case "linux":
      return `herdr-pocket-${clean}-linux-x64.AppImage`;
    default:
      return `herdr-pocket-${clean}.tar.gz`;
  }
}

export async function checkReleaseUpdate(): Promise<ReleaseUpdateInfo> {
  const china = inMainlandChina();
  const sources = allReleaseSources(LATEST_SUMS_URL, china);
  const fetchText = async (url: string): Promise<string> => {
    const abort = new AbortController();
    const t = setTimeout(() => abort.abort(), 8000);
    try {
      const res = await fetch(url, { signal: abort.signal, cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  };
  const rawText = china
    ? await Promise.any(sources.map(fetchText))
    : await (async () => {
        for (const u of sources) {
          try {
            return await fetchText(u);
          } catch {
            // next
          }
        }
        throw new Error("检查更新失败，请检查网络连接");
      })();

  const parsed = releaseFromSums(rawText);
  if (!parsed) throw new Error("无法解析最新版本信息");
  const current = appVersion();
  const platform = detectPlatform();
  const macArch = platform === "macos" ? await detectMacArch() : "arm64";
  const asset = platformDownloadAsset(parsed.version, platform, macArch);
  const rawUrl = `https://github.com/${RELEASE_REPO}/releases/download/v${parsed.version}/${asset}`;
  const downloadUrl = allReleaseSources(rawUrl, china)[0] ?? rawUrl;
  return {
    current,
    latest: parsed.version,
    hasUpdate: compareVersions(parsed.version, current) > 0,
    pageUrl: `https://github.com/${RELEASE_REPO}/releases/tag/v${parsed.version}`,
    downloadUrl,
  };
}
