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

/** Syncs PWA standalone state, captures install prompt events, and registers `./sw.js` on secure H5 origins. */
export function initH5Pwa(): () => void {
  if (!isH5Web() || typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

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

  if (window.isSecureContext && "serviceWorker" in navigator) {
    void navigator.serviceWorker
      .register("./sw.js", { scope: "./" })
      .then((reg) => {
        pwaStore.set({ swReady: true });
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }
        void reg.update().catch(() => {});
      })
      .catch(() => {});
  }

  return () => {
    mqStandalone?.removeEventListener?.("change", onDisplayChange);
    window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    window.removeEventListener("appinstalled", onAppInstalled);
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
