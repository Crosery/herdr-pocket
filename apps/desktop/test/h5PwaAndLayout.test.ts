import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkAndApplyH5Update, detectStandaloneDisplay, extractH5EntrySignature } from "../src/lib/pwa.ts";
import { notifyReleaseAvailable, startAutoUpdateChecks, updateStore } from "../src/lib/updates.ts";
import { checkAndApplyAdminUpdate, extractAdminEntrySignature } from "../../admin/src/lib/autoUpdate.ts";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("PWA manifest.webmanifest, icons, and sw.js are valid and non-empty", () => {
  const manifestPath = resolve(DESKTOP_ROOT, "public/manifest.webmanifest");
  const swPath = resolve(DESKTOP_ROOT, "public/sw.js");
  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(swPath), true);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: string;
    short_name?: string;
    display?: string;
    start_url?: string;
    scope?: string;
    icons?: Array<{ src?: string; sizes?: string; type?: string }>;
  };
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    assert.ok(icon.src, "manifest icon entry must declare src");
    const rel = icon.src.replace(/^\.\//, "");
    const abs = resolve(DESKTOP_ROOT, "public", rel);
    assert.equal(existsSync(abs), true, `missing icon file: ${abs}`);
    assert.ok(statSync(abs).size > 1000, `icon file looks empty: ${abs}`);
  }

  const sw = readFileSync(swPath, "utf8");
  assert.equal(sw.includes("herdr-pocket-shell-v11"), true);
  assert.equal(sw.includes("__pocket_check"), true, "SW must bypass cache-probing requests");
  assert.equal(sw.includes("SKIP_WAITING"), true);
  assert.equal(sw.includes('cache: "no-cache"'), true, "SW must revalidate document navigations against upstream");
});

test("detectStandaloneDisplay respects navigator.standalone and matchMedia standalone", () => {
  const g = globalThis as { window?: unknown };
  const prevWindow = g.window;
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (val: unknown) =>
    Object.defineProperty(globalThis, "navigator", {
      value: val,
      configurable: true,
      writable: true,
    });
  try {
    setNavigator(undefined);
    assert.equal(detectStandaloneDisplay(), false);

    setNavigator({ standalone: true });
    g.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(detectStandaloneDisplay(), true);

    setNavigator({ standalone: false });
    g.window = {
      matchMedia: (q: string) => ({ matches: q === "(display-mode: standalone)" }),
    };
    assert.equal(detectStandaloneDisplay(), true);

    g.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(detectStandaloneDisplay(), false);
  } finally {
    g.window = prevWindow;
    if (prevNavDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavDesc);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }
});

test("app.css and mobile-parity.css pin iOS standalone root, handle keyboard height, and align H5 cards", () => {
  const css = readFileSync(resolve(DESKTOP_ROOT, "src/styles/app.css"), "utf8");
  const mobileCss = readFileSync(resolve(DESKTOP_ROOT, "src/styles/mobile-parity.css"), "utf8");

  const standaloneRoot = /html\[data-client="h5"\]\[data-standalone="true"\],\s*html\[data-client="h5"\]\[data-standalone="true"\] body,\s*html\[data-client="h5"\]\[data-standalone="true"\] #root\s*\{[^}]*\}/.exec(css);
  assert.ok(standaloneRoot, "found standalone H5 fixed root block");
  assert.equal(standaloneRoot[0].includes("position: fixed"), true);
  assert.equal(standaloneRoot[0].includes("inset: 0"), true);
  assert.equal(standaloneRoot[0].includes("100dvh"), false, "iOS standalone root must not rely on 100dvh");

  const mpShell = /\.mp-shell\s*\{[^}]*\}/.exec(mobileCss);
  assert.ok(mpShell, "found .mp-shell block");
  assert.equal(mpShell[0].includes("height: 100%;"), true);
  assert.equal(mpShell[0].includes("100dvh"), false, ".mp-shell must inherit root 100% height rather than 100dvh");
  assert.equal(mobileCss.includes('html[data-kb-open="true"] .mp-shell .mp-tabbar'), true);
  assert.equal(mobileCss.includes(".mp-shell .bubble-row.is-card"), true);

  const authBlock = /\.h5-auth-screen\s*\{[^}]*\}/.exec(css);
  assert.ok(authBlock, "found .h5-auth-screen block");
  assert.equal(authBlock[0].includes("height: 100%;"), true);
  assert.equal(authBlock[0].includes("overflow-y: auto"), true);

  const idx1099 = css.indexOf("@media (max-width: 1099.98px)");
  const idx859 = css.indexOf("@media (max-width: 859.98px)");
  assert.ok(idx1099 > 0 && idx859 > 0);
  assert.ok(idx1099 < idx859, "@media (max-width: 1099.98px) must come before @media (max-width: 859.98px)");
});

test("H5 silently detects upstream bundle hash changes without reload loops or voice call interruption", async () => {
  const v1Html = `<!doctype html><html><head>
    <script type="module" crossorigin src="./assets/index-AAA11111.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-BBB22222.css">
  </head></html>`;
  const v2Html = `<!doctype html><html><head>
    <script type="module" crossorigin src="/pocket/app/assets/index-CCC33333.js"></script>
    <link rel="stylesheet" crossorigin href="/pocket/app/assets/index-DDD44444.css">
  </head></html>`;
  assert.equal(extractH5EntrySignature(v1Html), "assets/index-AAA11111.js|assets/index-BBB22222.css");
  assert.equal(extractH5EntrySignature(v2Html), "assets/index-CCC33333.js|assets/index-DDD44444.css");
  assert.equal(extractH5EntrySignature('<script type="module" src="/src/main.tsx"></script>'), null);

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDoc = g.document;
  const prevFetch = globalThis.fetch;
  const prevSession = g.sessionStorage;
  const sessionMap = new Map<string, string>();

  g.window = {};
  g.sessionStorage = {
    getItem: (k: string) => sessionMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      sessionMap.set(k, v);
    },
    removeItem: (k: string) => {
      sessionMap.delete(k);
    },
  };
  g.document = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("script")) return [{ getAttribute: () => "./assets/index-AAA11111.js" }];
      if (sel.includes("link")) return [{ getAttribute: () => "./assets/index-BBB22222.css" }];
      return [];
    },
  };

  let htmlToServe = v1Html;
  let applyCount = 0;
  globalThis.fetch = (async () => new Response(htmlToServe, { status: 200 })) as typeof fetch;

  try {
    // Unchanged upstream does not reload.
    assert.equal(await checkAndApplyH5Update({ force: true, onApply: async () => { applyCount += 1; } }), false);
    assert.equal(applyCount, 0);

    // Changed upstream deferred while voice call is active.
    htmlToServe = v2Html;
    assert.equal(
      await checkAndApplyH5Update({ force: true, canReloadNow: () => false, onApply: async () => { applyCount += 1; } }),
      false,
    );
    assert.equal(applyCount, 0);

    // Changed upstream applies once when idle.
    assert.equal(
      await checkAndApplyH5Update({ force: true, canReloadNow: () => true, onApply: async () => { applyCount += 1; } }),
      true,
    );
    assert.equal(applyCount, 1);

    // Repeat check for the same upstream signature is blocked by sessionStorage anti-loop guard.
    assert.equal(
      await checkAndApplyH5Update({ force: true, canReloadNow: () => true, onApply: async () => { applyCount += 1; } }),
      false,
    );
    assert.equal(applyCount, 1);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevDoc === undefined) delete g.document;
    else g.document = prevDoc;
    if (prevSession === undefined) delete g.sessionStorage;
    else g.sessionStorage = prevSession;
  }
});

test("H5 web mode never starts desktop auto-update checks or renders UpdatePrompt popup", () => {
  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const realSetTimeout = globalThis.setTimeout;
  const scheduled: number[] = [];
  (globalThis as Record<string, unknown>).setTimeout = (_cb: () => void, ms: number) => {
    scheduled.push(ms);
    return {};
  };

  g.window = {};
  try {
    updateStore.set({ info: null, checking: false });
    const stop = startAutoUpdateChecks();
    assert.equal(scheduled.length, 0, "startAutoUpdateChecks must be a no-op on H5 web");
    stop();

    notifyReleaseAvailable("99.9.9");
    assert.equal(updateStore.get().checking, false, "notifyReleaseAvailable must not start desktop release fetch on H5");
    assert.equal(updateStore.get().info, null);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
  }

  const promptSrc = readFileSync(resolve(DESKTOP_ROOT, "src/components/UpdatePrompt.tsx"), "utf8");
  assert.ok(promptSrc.includes("if (isH5Web()"), "UpdatePrompt must return null on H5 web");

  const mobileShellSrc = readFileSync(resolve(DESKTOP_ROOT, "src/mobile/MobileAppShell.tsx"), "utf8");
  assert.equal(mobileShellSrc.includes("<UpdatePrompt"), false, "MobileAppShell must not mount duplicate UpdatePrompt");
});

test("Admin console silently detects upstream admin-assets signature changes without reload loops", async () => {
  const v1Html = `<!doctype html><html><head>
    <script type="module" crossorigin src="./admin-assets/index-ADM11111.js"></script>
    <link rel="stylesheet" crossorigin href="./admin-assets/index-ADM22222.css">
  </head></html>`;
  const v2Html = `<!doctype html><html><head>
    <script type="module" crossorigin src="/pocket/admin-assets/index-ADM33333.js"></script>
    <link rel="stylesheet" crossorigin href="/pocket/admin-assets/index-ADM44444.css">
  </head></html>`;
  assert.equal(extractAdminEntrySignature(v1Html), "admin-assets/index-ADM11111.js|admin-assets/index-ADM22222.css");
  assert.equal(extractAdminEntrySignature(v2Html), "admin-assets/index-ADM33333.js|admin-assets/index-ADM44444.css");

  const g = globalThis as Record<string, unknown>;
  const prevWindow = g.window;
  const prevDoc = g.document;
  const prevFetch = globalThis.fetch;
  const prevSession = g.sessionStorage;
  const sessionMap = new Map<string, string>();

  g.window = { location: { pathname: "/pocket/admin", search: "" } };
  g.sessionStorage = {
    getItem: (k: string) => sessionMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      sessionMap.set(k, v);
    },
    removeItem: (k: string) => {
      sessionMap.delete(k);
    },
  };
  g.document = {
    querySelectorAll: (sel: string) => {
      if (sel.includes("script")) return [{ getAttribute: () => "./admin-assets/index-ADM11111.js" }];
      if (sel.includes("link")) return [{ getAttribute: () => "./admin-assets/index-ADM22222.css" }];
      return [];
    },
  };

  let htmlToServe = v1Html;
  let applyCount = 0;
  globalThis.fetch = (async () => new Response(htmlToServe, { status: 200 })) as typeof fetch;

  try {
    assert.equal(await checkAndApplyAdminUpdate({ force: true, onApply: () => { applyCount += 1; } }), false);
    assert.equal(applyCount, 0);

    htmlToServe = v2Html;
    assert.equal(
      await checkAndApplyAdminUpdate({ force: true, canReloadNow: () => false, onApply: () => { applyCount += 1; } }),
      false,
    );
    assert.equal(applyCount, 0);

    assert.equal(
      await checkAndApplyAdminUpdate({ force: true, canReloadNow: () => true, onApply: () => { applyCount += 1; } }),
      true,
    );
    assert.equal(applyCount, 1);

    assert.equal(
      await checkAndApplyAdminUpdate({ force: true, canReloadNow: () => true, onApply: () => { applyCount += 1; } }),
      false,
    );
    assert.equal(applyCount, 1);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWindow === undefined) delete g.window;
    else g.window = prevWindow;
    if (prevDoc === undefined) delete g.document;
    else g.document = prevDoc;
    if (prevSession === undefined) delete g.sessionStorage;
    else g.sessionStorage = prevSession;
  }
});
