import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_SOURCE,
  buildReleaseManifest,
  channelFromAssetName,
} from "@herdr-pocket/protocol";
import { appVersion, checkReleaseUpdate, desktopReleaseChannel, probeUpdateSources, readCachedSourceProbes } from "../src/lib/bridge.ts";
import { clientConfigStore } from "../src/lib/config.ts";
import { settingsStore } from "../src/lib/store.ts";
import {
  checkForUpdate,
  dismissUpdatePrompt,
  fetchReleaseNotes,
  minimizeUpdatePrompt,
  notifyReleaseAvailable,
  probeMirrorsNow,
  restoreUpdatePrompt,
  startAutoUpdateChecks,
  startUpdateDownload,
  updateStore,
} from "../src/lib/updates.ts";

test("minimizeUpdatePrompt and restoreUpdatePrompt preserve version availability while toggling minimized", () => {
  updateStore.set({
    info: {
      current: "0.2.4",
      latest: "0.2.5",
      hasUpdate: true,
      downloadUrl: "https://example.com/a.dmg",
      downloadUrls: [],
      pageUrl: "https://example.com/releases",
      source: "github.com",
      region: "global",
      regionReason: "test",
    },
    minimized: false,
    dismissedVersion: null,
  });

  minimizeUpdatePrompt();
  assert.equal(updateStore.get().minimized, true);

  restoreUpdatePrompt();
  assert.equal(updateStore.get().minimized, false);
  assert.equal(updateStore.get().dismissedVersion, null);

  dismissUpdatePrompt();
  assert.equal(updateStore.get().dismissedVersion, "0.2.5");
  restoreUpdatePrompt();
  assert.equal(updateStore.get().dismissedVersion, null);
});

test("startAutoUpdateChecks does not cancel startup timer when unrelated client config updates fire", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const scheduled: Array<{ ms: number; cb: () => void; cleared: boolean }> = [];
  (globalThis as any).setTimeout = (cb: () => void, ms: number) => {
    const rec = { ms, cb, cleared: false };
    scheduled.push(rec);
    return rec;
  };
  const realClearTimeout = globalThis.clearTimeout;
  (globalThis as any).clearTimeout = (id: any) => {
    if (id && typeof id === "object" && "cleared" in id) id.cleared = true;
  };

  let calls = 0;
  try {
    const stop = startAutoUpdateChecks(async () => {
      calls += 1;
      return null;
    });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.ms, 4000);

    // Emit unrelated config change without changing update.autoCheck / checkIntervalHours.
    clientConfigStore.set((prev) => ({ ...prev, loaded: true }));
    assert.equal(scheduled[0]!.cleared, false, "unrelated config emissions must NOT cancel startup timer");

    // Fire startup check callback and confirm it invokes checkFn once.
    scheduled[0]!.cb();
    await Promise.resolve();
    assert.equal(calls, 1);
    stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

const SAMPLE_SUMS = `${"a".repeat(64)}  herdr-pocket-0.2.10-macos-arm64.dmg\n`;

test("probeUpdateSources and probeMirrorsNow measure all reachable mirrors in parallel without aborting slower mirrors", async () => {
  const store = new Map<string, string>();
  const prevStorage = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.startsWith("https://ghfast.top/")) {
      await new Promise((r) => setTimeout(r, 15));
      return new Response(SAMPLE_SUMS, { status: 200 });
    }
    if (url.startsWith("https://gh-proxy.com/")) {
      // Slower than 150ms runner-up slack: must NOT be aborted during probeUpdateSources.
      await new Promise((r) => setTimeout(r, 180));
      return new Response(SAMPLE_SUMS, { status: 200 });
    }
    if (url.startsWith("https://cdn.gh-proxy.com/")) {
      return new Response("bad gateway", { status: 502 });
    }
    if (url.startsWith("https://edgeone.gh-proxy.com/")) {
      await new Promise((r) => setTimeout(r, 40));
      return new Response(SAMPLE_SUMS, { status: 200 });
    }
    throw new Error("network unreachable");
  }) as typeof fetch;

  try {
    const res = await probeUpdateSources({ region: "cn", mirrors: [] });
    assert.equal(res.winner, "https://ghfast.top/");
    const proxyProbe = res.probes.find((p) => p.source === "https://gh-proxy.com/");
    assert.equal(proxyProbe?.ok, true, "slower reachable mirror (>150ms) must still report ok=true with real ms");
    assert.ok((proxyProbe?.ms ?? 0) >= 150);
    const directProbe = res.probes.find((p) => p.source === DIRECT_SOURCE);
    assert.equal(directProbe?.ok, false);

    const cached = await readCachedSourceProbes();
    assert.equal(cached?.winner, "https://ghfast.top/");
    assert.equal(cached?.probes.length, res.probes.length);

    clientConfigStore.set((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        update: { ...prev.config.update, region: "cn", mirrors: [], preferredSource: "auto" },
      },
    }));
    const probes = await probeMirrorsNow(false);
    assert.equal(updateStore.get().probing, false);
    assert.equal(updateStore.get().probes.length, probes.length);
  } finally {
    globalThis.fetch = realFetch;
    if (prevStorage === undefined) delete (globalThis as Record<string, unknown>).localStorage;
    else (globalThis as Record<string, unknown>).localStorage = prevStorage;
  }
});

test("checkReleaseUpdate honors explicit preferredSource and falls back cleanly if explicit source fails", async () => {
  const tried: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    tried.push(url);
    if (url.startsWith("https://github.com/")) {
      throw new Error("direct blocked");
    }
    if (url.startsWith("https://gh-proxy.com/")) {
      return new Response(SAMPLE_SUMS, { status: 200 });
    }
    return new Response("nope", { status: 503 });
  }) as typeof fetch;

  try {
    const pinnedMirror = await checkReleaseUpdate({
      region: "global",
      preferredSource: "https://gh-proxy.com/",
      mirrors: [],
    });
    assert.equal(tried[0]?.startsWith("https://gh-proxy.com/"), true);
    assert.equal(pinnedMirror.source, "gh-proxy.com");
    assert.equal(pinnedMirror.latest, "0.2.10");

    tried.length = 0;
    const directFallback = await checkReleaseUpdate({
      region: "cn",
      preferredSource: "direct",
      mirrors: [],
    });
    assert.equal(tried[0]?.startsWith("https://github.com/"), true, "direct must be tried first");
    assert.equal(directFallback.source, "gh-proxy.com", "fallback mirror takes over when direct fails");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("checkReleaseUpdate reads per-channel RELEASE-MANIFEST.json and ignores unrelated mobile-only bumps", async () => {
  const desktopAsset = `herdr-pocket-0.2.23-macos-${typeof process !== "undefined" && process.arch === "x64" ? "x64" : "arm64"}.dmg`;
  const channel = channelFromAssetName(desktopAsset)?.channel ?? desktopReleaseChannel();
  const manifest = buildReleaseManifest({
    releaseVersion: "99.0.0",
    sums: {
      "herdr-pocket-99.0.0-android-arm64.apk": "a".repeat(64),
      [`herdr-pocket-${appVersion()}-${channel === "macos-x64" ? "macos-x64.dmg" : channel === "macos-arm64" ? "macos-arm64.dmg" : "linux-x64.AppImage"}`]:
        "b".repeat(64),
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("RELEASE-MANIFEST.json")) {
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const info = await checkReleaseUpdate({
      region: "global",
      preferredSource: "direct",
      mirrors: [],
    });
    assert.equal(info.latest, appVersion());
    assert.equal(info.hasUpdate, false, "mobile-only 99.0.0 release must NOT trigger desktop update");
  } finally {
    globalThis.fetch = realFetch;
  }
});

function multiChannelManifest(ver: string) {
  return buildReleaseManifest({
    releaseVersion: ver,
    sums: {
      [`herdr-pocket-${ver}.tar.gz`]: "a".repeat(64),
      [`herdr-pocket-${ver}-macos-arm64.dmg`]: "b".repeat(64),
      [`herdr-pocket-${ver}-macos-x64.dmg`]: "c".repeat(64),
      [`herdr-pocket-${ver}-windows-x64-setup.exe`]: "d".repeat(64),
      [`herdr-pocket-${ver}-linux-x64.AppImage`]: "e".repeat(64),
    },
  });
}

test("notifyReleaseAvailable hot-swaps dismissed/minimized/ready popup and stale notes even when mirror /latest lags", async () => {
  const realFetch = globalThis.fetch;
  const prevServer = settingsStore.get().server;
  settingsStore.set({ server: "" });
  clientConfigStore.set((prev) => ({
    ...prev,
    config: { ...prev.config, update: { ...prev.config.update, region: "global", preferredSource: "direct", mirrors: [] } },
  }));

  const m91 = multiChannelManifest("99.1.0");
  const m92 = multiChannelManifest("99.2.0");
  globalThis.fetch = (async (input: string | URL) => {
    const u = String(input);
    if (u.endsWith("/releases/latest/download/RELEASE-MANIFEST.json")) {
      return new Response(JSON.stringify(m91), { status: 200 });
    }
    if (u.endsWith("/releases/download/v99.2.0/RELEASE-MANIFEST.json")) {
      return new Response(JSON.stringify(m92), { status: 200 });
    }
    if (u.endsWith("/releases/download/v99.2.0/RELEASE-NOTES.md")) {
      return new Response("# Herdr Pocket v99.2.0\n\n- Live popup swap\n", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    updateStore.set({
      checking: false,
      info: {
        current: appVersion(),
        latest: "99.1.0",
        hasUpdate: true,
        downloadUrl: "https://github.com/Crosery/herdr-pocket/releases/download/v99.1.0/herdr-pocket-99.1.0.tar.gz",
        downloadUrls: [],
        pageUrl: "https://github.com/Crosery/herdr-pocket/releases/tag/v99.1.0",
        notes: { body: "stale 99.1.0 notes", url: "https://example.com/99.1.0", publishedAt: "" },
        source: "github.com",
        region: "global",
        regionReason: "test",
      },
      minimized: true,
      dismissedVersion: "99.1.0",
      installPhase: "ready",
      supersededFrom: null,
      checkedAt: Date.now() - 120_000,
    });

    notifyReleaseAvailable("99.2.0");
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const cur = updateStore.get();
      if (!cur.checking && cur.info?.latest === "99.2.0" && cur.info?.notes?.body) break;
    }

    const after = updateStore.get();
    assert.equal(after.info?.latest, "99.2.0");
    assert.equal(after.info?.hasUpdate, true);
    assert.equal(after.minimized, false);
    assert.equal(after.dismissedVersion, null);
    assert.equal(after.installPhase, "idle");
    assert.equal(after.supersededFrom, "99.1.0");
    assert.match(after.info?.notes?.body ?? "", /Live popup swap/);

    const fetchedNotes = await fetchReleaseNotes(1000, "99.2.0");
    assert.match(fetchedNotes?.body ?? "", /Live popup swap/);
  } finally {
    globalThis.fetch = realFetch;
    settingsStore.set({ server: prevServer });
  }
});

test("startUpdateDownload checks pre-download freshness and upgrades to newer release before downloading", async () => {
  const realFetch = globalThis.fetch;
  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevServer = settingsStore.get().server;
  let openedUrl = "";
  (globalThis as Record<string, unknown>).window = {
    open: (url: string) => {
      openedUrl = url;
      return null;
    },
  };
  settingsStore.set({ server: "" });
  clientConfigStore.set((prev) => ({
    ...prev,
    config: { ...prev.config, update: { ...prev.config.update, region: "global", preferredSource: "direct", mirrors: [] } },
  }));

  const m92 = multiChannelManifest("99.2.0");
  globalThis.fetch = (async (input: string | URL) => {
    const u = String(input);
    if (u.endsWith("/releases/latest/download/RELEASE-MANIFEST.json")) {
      return new Response(JSON.stringify(m92), { status: 200 });
    }
    if (u.endsWith("/releases/download/v99.2.0/RELEASE-NOTES.md")) {
      return new Response("# Herdr Pocket v99.2.0\n\n- Pre-download guard\n", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    await checkForUpdate("manual");
    updateStore.set({
      info: {
        current: appVersion(),
        latest: "99.1.0",
        hasUpdate: true,
        downloadUrl: "https://github.com/Crosery/herdr-pocket/releases/download/v99.1.0/herdr-pocket-99.1.0.tar.gz",
        downloadUrls: [],
        pageUrl: "https://github.com/Crosery/herdr-pocket/releases/tag/v99.1.0",
        source: "github.com",
        region: "global",
        regionReason: "test",
      },
      checkedAt: Date.now() - 20_000,
      installPhase: "idle",
      supersededFrom: null,
    });

    await startUpdateDownload();
    assert.equal(updateStore.get().info?.latest, "99.2.0");
    assert.equal(updateStore.get().supersededFrom, "99.1.0");
    assert.match(openedUrl, /releases\/download\/v99\.2\.0\//);
  } finally {
    globalThis.fetch = realFetch;
    settingsStore.set({ server: prevServer });
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
  }
});
