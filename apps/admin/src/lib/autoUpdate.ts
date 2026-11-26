const ADMIN_RELOAD_SIG_KEY = "herdr-pocket-admin-reloaded-sig";
const ADMIN_CHECK_MIN_INTERVAL_MS = 20_000;

let lastCheckAt = 0;
let inFlight: Promise<boolean> | null = null;
let deferredPending = false;
let deferredTimer: number | null = null;

function normalizeAdminAssetPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim().split(/[?#]/)[0] ?? "";
  const hit = /(?:^|\/)(admin-assets\/[^/\s"'<>]+-[A-Za-z0-9_-]{6,}\.(?:js|mjs|css))$/.exec(clean);
  return hit ? hit[1]! : null;
}

export function extractAdminEntrySignature(html: string): string | null {
  const found = new Set<string>();
  const scriptRe = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    if (!/\btype=["']module["']/i.test(m[0])) continue;
    const norm = normalizeAdminAssetPath(m[1]);
    if (norm) found.add(norm);
  }
  const linkRe = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    if (!/\brel=["']stylesheet["']/i.test(m[0])) continue;
    const norm = normalizeAdminAssetPath(m[1]);
    if (norm) found.add(norm);
  }
  if (found.size === 0) return null;
  return [...found].sort().join("|");
}

export function readCurrentAdminEntrySignature(doc: Document | undefined = typeof document !== "undefined" ? document : undefined): string | null {
  if (!doc) return null;
  const found = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('script[type="module"][src]'))) {
    const norm = normalizeAdminAssetPath(el.getAttribute("src"));
    if (norm) found.add(norm);
  }
  for (const el of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
    const norm = normalizeAdminAssetPath(el.getAttribute("href"));
    if (norm) found.add(norm);
  }
  if (found.size === 0) return null;
  return [...found].sort().join("|");
}

function defaultCanReloadAdmin(): boolean {
  if (typeof document === "undefined") return true;
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName;
    if ((tag === "INPUT" || tag === "TEXTAREA") && !(active as HTMLInputElement).readOnly && !(active as HTMLInputElement).disabled) {
      return false;
    }
    if ((active as HTMLElement).isContentEditable) return false;
  }
  if (document.querySelector('[role="dialog"][data-state="open"]')) return false;
  return true;
}

export async function checkAndApplyAdminUpdate(opts?: {
  force?: boolean;
  canReloadNow?: () => boolean;
  onApply?: () => void | Promise<void>;
}): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof fetch !== "function") {
    return false;
  }
  const currentSig = readCurrentAdminEntrySignature(document);
  if (!currentSig) return false;

  const now = Date.now();
  if (!opts?.force && now - lastCheckAt < ADMIN_CHECK_MIN_INTERVAL_MS) {
    return false;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    lastCheckAt = Date.now();
    try {
      const sep = window.location.search ? "&" : "?";
      const probeUrl = `${window.location.pathname}${window.location.search}${sep}__pocket_check=${Date.now()}`;
      const res = await fetch(probeUrl, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return false;
      const html = await res.text();
      const upstreamSig = extractAdminEntrySignature(html);
      if (!upstreamSig || upstreamSig === currentSig) {
        deferredPending = false;
        try {
          if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(ADMIN_RELOAD_SIG_KEY);
        } catch {
          // ignore
        }
        return false;
      }

      const guard = opts?.canReloadNow ?? defaultCanReloadAdmin;
      if (!guard()) {
        deferredPending = true;
        return false;
      }

      try {
        if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(ADMIN_RELOAD_SIG_KEY) === upstreamSig) {
          return false;
        }
        if (typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(ADMIN_RELOAD_SIG_KEY, upstreamSig);
        }
      } catch {
        // ignore storage errors
      }

      deferredPending = false;
      if (opts?.onApply) {
        await opts.onApply();
      } else {
        window.location.reload();
      }
      return true;
    } catch {
      return false;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function initAdminAutoUpdate(opts?: { canReloadNow?: () => boolean }): {
  checkNow: (force?: boolean) => void;
  dispose: () => void;
} {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { checkNow: () => {}, dispose: () => {} };
  }

  const checkNow = (force = false) => {
    void checkAndApplyAdminUpdate({ force, canReloadNow: opts?.canReloadNow }).then((applied) => {
      if (!applied && deferredPending && deferredTimer === null) {
        deferredTimer = window.setTimeout(() => {
          deferredTimer = null;
          if (deferredPending) checkNow(true);
        }, 4_000);
      }
    });
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") checkNow(false);
  };
  const onOnline = () => checkNow(false);
  const onPageShow = (ev: PageTransitionEvent) => {
    if (ev.persisted) checkNow(true);
  };
  const onFocusOut = () => {
    if (deferredPending) {
      window.setTimeout(() => {
        if (deferredPending) checkNow(true);
      }, 150);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("focusout", onFocusOut);
  window.addEventListener("online", onOnline);
  window.addEventListener("pageshow", onPageShow);

  const bootTimer = window.setTimeout(() => checkNow(false), 2_500);

  return {
    checkNow,
    dispose: () => {
      window.clearTimeout(bootTimer);
      if (deferredTimer !== null) {
        window.clearTimeout(deferredTimer);
        deferredTimer = null;
      }
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    },
  };
}
