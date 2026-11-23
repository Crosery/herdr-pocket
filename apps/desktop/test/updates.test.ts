import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_SOURCE,
  buildReleaseManifest,
  channelFromAssetName,
} from "@herdr-pocket/protocol";
import { appVersion, checkReleaseUpdate, desktopReleaseChannel, probeUpdateSources, readCachedSourceProbes } from "../src/lib/bridge.ts";
import { clientConfigStore } from "../src/lib/config.ts";
import {
  dismissUpdatePrompt,
  minimizeUpdatePrompt,
  probeMirrorsNow,
  restoreUpdatePrompt,
  startAutoUpdateChecks,
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
