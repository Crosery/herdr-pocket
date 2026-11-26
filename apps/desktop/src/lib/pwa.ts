import { isH5Web } from "./bridge";
import { createStore } from "./store";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface H5PwaState {
  standalone: boolean;
  canPromptInstall: boolean;
  swReady: boolean;
}

export const pwaStore = createStore<H5PwaState>({
  standalone: false,
  canPromptInstall: false,
  swReady: false,
});

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let canReloadHook: (() => boolean) | null = null;
let lastAutoCheckAt = 0;
let autoCheckInFlight: Promise<boolean> | null = null;
const H5_RELOAD_SIG_KEY = "herdr-pocket-h5-reloaded-sig";
const H5_CHECK_MIN_INTERVAL_MS = 25_000;

/** Normalizes a built Vite asset URL (e.g. `./assets/index-abc123.js` or `/pocket/app/assets/...`) to `assets/<file>`. */
function normalizeBuiltAssetPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim().split(/[?#]/)[0] ?? "";
  const hit = /(?:^|\/)(assets\/[^/\s"'<>]+-[A-Za-z0-9_-]{6,}\.(?:js|mjs|css))$/.exec(clean);
  return hit ? hit[1]! : null;
}

/** Extracts a deterministic entry-bundle signature from an HTML document's hashed Vite assets. */
export function extractH5EntrySignature(html: string): string | null {
  const found = new Set<string>();
  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const norm = normalizeBuiltAssetPath(m[1]);
    if (norm) found.add(norm);
  }
  const linkRe = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\brel=["']stylesheet["']/i.test(tag)) continue;
    const norm = normalizeBuiltAssetPath(m[1]);
    if (norm) found.add(norm);
  }
  if (found.size === 0) return null;
  return [...found].sort().join("|");
}

/** Reads the currently loaded document's hashed Vite asset signature (null in Vite dev mode). */
export function readCurrentH5EntrySignature(doc: Document | undefined = typeof document !== "undefined" ? document : undefined): string | null {
  if (!doc) return null;
  const found = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('script[type="module"][src]'))) {
    const norm = normalizeBuiltAssetPath(el.getAttribute("src"));
    if (norm) found.add(norm);
  }
  for (const el of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
    const norm = normalizeBuiltAssetPath(el.getAttribute("href"));
    if (norm) found.add(norm);
  }
  if (found.size === 0) return null;
  return [...found].sort().join("|");
}

/** Checks upstream `./` HTML on H5 and silently reloads when the relay has published a newer built web bundle. */
export async function checkAndApplyH5Update(opts?: {
  force?: boolean;
  canReloadNow?: () => boolean;
  onApply?: () => Promise<void>;
}): Promise<boolean> {
  if (!isH5Web() || typeof window === "undefined" || typeof document === "undefined" || typeof fetch !== "function") {
    return false;
  }
  const currentSig = readCurrentH5EntrySignature(document);
  if (!currentSig) return false;

  const now = Date.now();
  if (!opts?.force && now - lastAutoCheckAt < H5_CHECK_MIN_INTERVAL_MS) {
    return false;
  }
  if (autoCheckInFlight) return autoCheckInFlight;

  autoCheckInFlight = (async () => {
    lastAutoCheckAt = Date.now();
    try {
      const res = await fetch("./", { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return false;
      const html = await res.text();
      const upstreamSig = extractH5EntrySignature(html);
      if (!upstreamSig || upstreamSig === currentSig) {
        try {
          if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(H5_RELOAD_SIG_KEY);
        } catch {
          // ignore
        }
        return false;
      }
      const guard = opts?.canReloadNow ?? canReloadHook;
      if (guard && !guard()) return false;
      try {
        if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(H5_RELOAD_SIG_KEY) === upstreamSig) {
          return false;
        }
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(H5_RELOAD_SIG_KEY, upstreamSig);
        }
      } catch {
        // ignore storage restrictions
      }
      if (opts?.onApply) {
        await opts.onApply();
      } else {
        await refreshH5Bundle();
      }
      return true;
    } catch {
      return false;
    } finally {
      autoCheckInFlight = null;
    }
  })();

  return autoCheckInFlight;
}

/** Checks whether the H5 web client is currently running installed on a home screen / standalone window. */
export function detectStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const navStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (navStandalone) return true;
  if (typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches
  );
}

/** Syncs PWA standalone state, captures install prompt events, registers `./sw.js`, and silently follows upstream H5 updates. */
export function initH5Pwa(opts?: { canReloadNow?: () => boolean }): () => void {
  if (!isH5Web() || typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  canReloadHook = opts?.canReloadNow ?? null;

  const syncStandalone = () => {
    const standalone = detectStandaloneDisplay();
    document.documentElement.setAttribute("data-standalone", standalone ? "true" : "false");
    pwaStore.set({ standalone });
  };
  syncStandalone();

  const mqStandalone = typeof window.matchMedia === "function" ? window.matchMedia("(display-mode: standalone)") : null;
  const onDisplayChange = () => syncStandalone();
  mqStandalone?.addEventListener?.("change", onDisplayChange);

  const onBeforeInstall = (ev: Event) => {
    ev.preventDefault();
    deferredPrompt = ev as BeforeInstallPromptEvent;
    pwaStore.set({ canPromptInstall: true });
  };

  const onAppInstalled = () => {
    deferredPrompt = null;
    pwaStore.set({ standalone: true, canPromptInstall: false });
    document.documentElement.setAttribute("data-standalone", "true");
  };

  window.addEventListener("beforeinstallprompt", onBeforeInstall);
  window.addEventListener("appinstalled", onAppInstalled);

  let swReg: ServiceWorkerRegistration | null = null;
  const swContainer = window.isSecureContext && "serviceWorker" in navigator ? navigator.serviceWorker : null;
  const hadController = Boolean(swContainer?.controller);

  const checkUpstream = (force = false) => {
    void swReg?.update().catch(() => {});
    void checkAndApplyH5Update({ force });
  };

  const onControllerChange = () => {
    if (!hadController) return;
    void checkAndApplyH5Update({ force: true });
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      checkUpstream(false);
    }
  };
  const onPageShow = (ev: PageTransitionEvent) => {
    if (ev.persisted) checkUpstream(true);
  };
  const onOnline = () => checkUpstream(false);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("online", onOnline);

  if (swContainer) {
    swContainer.addEventListener("controllerchange", onControllerChange);
    void swContainer
      .register("./sw.js", { scope: "./" })
      .then((reg) => {
        swReg = reg;
        pwaStore.set({ swReady: true });
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && swContainer.controller) {
              installing.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
        void reg.update().catch(() => {});
      })
      .catch(() => {});
  }

  const bootTimer = window.setTimeout(() => {
    void checkAndApplyH5Update({ force: false });
  }, 2_500);

  return () => {
    canReloadHook = null;
    window.clearTimeout(bootTimer);
    mqStandalone?.removeEventListener?.("change", onDisplayChange);
    window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    window.removeEventListener("appinstalled", onAppInstalled);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("online", onOnline);
    swContainer?.removeEventListener("controllerchange", onControllerChange);
  };
}

/** Triggers the browser's native WebAPK / PWA install sheet when `beforeinstallprompt` is ready. */
export async function promptNativePwaInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  try {
    await deferredPrompt.prompt();
    const res = await deferredPrompt.userChoice;
    deferredPrompt = null;
    pwaStore.set({ canPromptInstall: false });
    return res.outcome;
  } catch {
    deferredPrompt = null;
    pwaStore.set({ canPromptInstall: false });
    return "unavailable";
  }
}

/** Updates any active Service Worker shell and reloads the page to fetch the latest Relay H5 build. */
export async function refreshH5Bundle(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
    }
    if ("caches" in window) {
      const keys = await window.caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("herdr-pocket-shell-")).map((k) => window.caches.delete(k)));
    }
  } finally {
    window.location.reload();
  }
}
