import assert from "node:assert/strict";
import test from "node:test";
import { clientConfigStore } from "../src/lib/config.ts";
import {
  dismissUpdatePrompt,
  minimizeUpdatePrompt,
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
