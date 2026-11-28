import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { USER_IDLE_TIMEOUT_MS, attachUserIdleAttribute, attachWindowBlurAttribute } from "../src/lib/layout.ts";
import {
  FALLBACK_READ_MAX_RETRIES,
  FALLBACK_READ_RETRY_MS,
  LOCAL_FONT_WAIT_MS,
  LOCAL_HOST_READY_FALLBACK_MS,
  MOUNT_SAFETY_REVEAL_MS,
  RAW_EMPTY_FALLBACK_MS,
  RELAY_HOST_READY_FALLBACK_MS,
  attachImmediateWebglContextLossListener,
  createRelayFallbackController,
  recoverActiveTerminalAfterWebglDispose,
  releaseWebglAddonContext,
  runTerminalActivationPhase0,
  runTerminalActivationPhase1,
  runTerminalStartupWithFallback,
  shouldEnableTerminalCursorBlink,
} from "../src/lib/terminalActivation.ts";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function createManualTimers() {
  let nextId = 1;
  const tasks = new Map<number, { fn: () => void; ms: number; at: number }>();
  let now = 0;
  return {
    now: () => now,
    setTimeoutFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      tasks.set(id, { fn, ms, at: now + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
      tasks.delete(id as unknown as number);
    }) as unknown as typeof clearTimeout,
    advance(ms: number) {
      const target = now + ms;
      while (true) {
        let earliestId: number | null = null;
        let earliestAt = Infinity;
        for (const [id, task] of tasks) {
          if (task.at <= target && task.at < earliestAt) {
            earliestAt = task.at;
            earliestId = id;
          }
        }
        if (earliestId === null) break;
        const task = tasks.get(earliestId)!;
        tasks.delete(earliestId);
        now = task.at;
        task.fn();
      }
      now = target;
    },
    pendingCount() {
      return tasks.size;
    },
  };
}

test("Bug 1A: warm idle WebGL activation always repaints synchronously in Phase 0, avoids duplicate rAF refresh, and defers cold WebGL promotion to Phase 1", () => {
  // Scenario 1: Warm idle WebGL pane (not paused, not dirty — e.g. Chat->Term switch where IntersectionObserver stayed active).
  const calls: string[] = [];
  const warmAddon = { id: "warm-gl" };
  let dirty = false;

  const phase0Warm = runTerminalActivationPhase0({
    getWebgl: () => warmAddon,
    touchWarmWebgl: () => calls.push("touchWarmWebgl"),
    refreshWarmWebgl: () => calls.push("refreshWarmWebgl"),
    wakeRenderer: () => {
      calls.push("wakeRenderer");
      return false; // renderer was NOT paused
    },
    maybeResize: () => calls.push("maybeResize"),
    snapViewport: () => calls.push("snapViewport"),
    isDirtyWhileInactive: () => dirty,
    clearDirtyWhileInactive: () => {
      dirty = false;
      calls.push("clearDirty");
    },
    paintViewport: () => {
      calls.push("paintViewport");
      return true;
    },
  });

  assert.equal(phase0Warm.refreshedWarm, true);
  assert.equal(phase0Warm.paintedInPhase0, true);
  assert.deepEqual(calls, [
    "touchWarmWebgl",
    "refreshWarmWebgl",
    "wakeRenderer",
    "maybeResize",
    "snapViewport",
    "clearDirty",
    "paintViewport",
  ]);

  // Phase 1 must NOT do a duplicate full term.refresh when Phase 0 already painted cleanly,
  // no new bytes arrived since Phase 0, and WebGL was not newly attached.
  const phase1CleanCalls: string[] = [];
  const p1WarmClean = runTerminalActivationPhase1(
    {
      getWebgl: () => warmAddon,
      attachWebgl: () => phase1CleanCalls.push("attachWebgl"),
      isDirtyWhileInactive: () => false,
      clearDirtyWhileInactive: () => phase1CleanCalls.push("clearDirty"),
      refreshFullViewport: () => phase1CleanCalls.push("refreshFullViewport"),
    },
    phase0Warm,
  );
  assert.equal(p1WarmClean.attachedWebgl, false);
  assert.equal(p1WarmClean.refreshed, false);
  assert.deepEqual(phase1CleanCalls, ["attachWebgl"]);

  // If Phase 0 could not paint synchronously (paintedInPhase0 === false), Phase 1 must refresh full viewport.
  const phase1RetryCalls: string[] = [];
  const p1WarmRetry = runTerminalActivationPhase1(
    {
      getWebgl: () => warmAddon,
      attachWebgl: () => phase1RetryCalls.push("attachWebgl"),
      isDirtyWhileInactive: () => false,
      clearDirtyWhileInactive: () => phase1RetryCalls.push("clearDirty"),
      refreshFullViewport: () => phase1RetryCalls.push("refreshFullViewport"),
    },
    { ...phase0Warm, paintedInPhase0: false },
  );
  assert.equal(p1WarmRetry.refreshed, true);
  assert.deepEqual(phase1RetryCalls, ["attachWebgl", "clearDirty", "refreshFullViewport"]);

  // Scenario 2: Cold pane (no WebGL yet) must paint DOM synchronously in Phase 0 without calling attachWebgl,
  // then promote to WebGL and refresh full viewport in Phase 1 rAF.
  let coldAddon: { id: string } | null = null;
  const coldPhase0Calls: string[] = [];
  const phase0Cold = runTerminalActivationPhase0({
    getWebgl: () => coldAddon,
    touchWarmWebgl: () => coldPhase0Calls.push("touchWarmWebgl"),
    refreshWarmWebgl: () => coldPhase0Calls.push("refreshWarmWebgl"),
    wakeRenderer: () => {
      coldPhase0Calls.push("wakeRenderer");
      return false;
    },
    snapViewport: () => coldPhase0Calls.push("snapViewport"),
    isDirtyWhileInactive: () => false,
    clearDirtyWhileInactive: () => coldPhase0Calls.push("clearDirty"),
    paintViewport: () => {
      coldPhase0Calls.push("paintViewport");
      return true;
    },
  });

  assert.equal(phase0Cold.refreshedWarm, false);
  assert.equal(phase0Cold.paintedInPhase0, true);
  assert.deepEqual(coldPhase0Calls, ["wakeRenderer", "snapViewport", "clearDirty", "paintViewport"]);

  const coldPhase1Calls: string[] = [];
  const p1Cold = runTerminalActivationPhase1(
    {
      getWebgl: () => coldAddon,
      attachWebgl: () => {
        coldPhase1Calls.push("attachWebgl");
        coldAddon = { id: "promoted-gl" };
      },
      isDirtyWhileInactive: () => false,
      clearDirtyWhileInactive: () => coldPhase1Calls.push("clearDirty"),
      refreshFullViewport: () => coldPhase1Calls.push("refreshFullViewport"),
    },
    phase0Cold,
  );

  assert.equal(p1Cold.attachedWebgl, true);
  assert.equal(p1Cold.refreshed, true);
  assert.deepEqual(coldPhase1Calls, ["attachWebgl", "clearDirty", "refreshFullViewport"]);
});

test("Bug 1B & Blank #5: immediate webglcontextlost listener, WEBGL_lose_context release, and active DOM fallback repaint", () => {
  const ops: string[] = [];
  const fakeTerm = {
    cols: 100,
    rows: 28,
    refresh: (s: number, e: number) => ops.push(`refresh(${s},${e})`),
    _core: {
      _renderService: {
        _isPaused: true,
        _needsFullRefresh: true,
        _charSizeService: {
          hasValidSize: false,
          measure: () => ops.push("measure"),
        },
        _pausedResizeTask: { flush: () => ops.push("flushResize") },
        dimensions: { css: { cell: { height: 18 }, canvas: { height: 0 } } },
        handleResize: (c: number, r: number) => ops.push(`handleResize(${c},${r})`),
        _renderRows: (s: number, e: number) => ops.push(`renderRows(${s},${e})`),
      },
    },
  };

  // Inactive or disposed pane must be a clean no-op.
  assert.equal(recoverActiveTerminalAfterWebglDispose(fakeTerm as never, false), false);
  assert.deepEqual(ops, []);

  // Active pane on context loss / LRU eviction must wake + paint + refresh immediately.
  assert.equal(recoverActiveTerminalAfterWebglDispose(fakeTerm as never, true), true);
  assert.deepEqual(ops, ["measure", "flushResize", "handleResize(100,28)", "renderRows(0,27)", "refresh(0,27)"]);

  // Immediate canvas webglcontextlost listener fires without waiting for xterm's 3s delay and cleans up cleanly.
  const canvasListeners = new Map<string, Set<() => void>>();
  let loseContextCalls = 0;
  let contextLostFlag = false;
  const mockCanvas = {
    addEventListener(type: string, fn: () => void) {
      let set = canvasListeners.get(type);
      if (!set) {
        set = new Set();
        canvasListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      canvasListeners.get(type)?.delete(fn);
    },
  };
  const mockGl = {
    isContextLost: () => contextLostFlag,
    getExtension: (name: string) =>
      name === "WEBGL_lose_context"
        ? {
            loseContext: () => {
              loseContextCalls += 1;
              contextLostFlag = true;
            },
          }
        : null,
  };
  const mockAddon = { _renderer: { _canvas: mockCanvas, _gl: mockGl } };

  let lostCount = 0;
  const detachListener = attachImmediateWebglContextLossListener(mockAddon, null, () => {
    lostCount += 1;
  });
  assert.ok(detachListener);
  assert.equal(canvasListeners.get("webglcontextlost")?.size, 1);

  for (const fn of canvasListeners.get("webglcontextlost") ?? []) fn();
  assert.equal(lostCount, 1);

  detachListener();
  assert.equal(canvasListeners.get("webglcontextlost")?.size ?? 0, 0);

  // Explicit WEBGL_lose_context frees GPU slot on live context and skips already-lost context.
  assert.equal(releaseWebglAddonContext(mockAddon, mockGl), true);
  assert.equal(loseContextCalls, 1);
  assert.equal(releaseWebglAddonContext(mockAddon, mockGl), false);
  assert.equal(loseContextCalls, 1);
});

test("Bug 1C & Blank #2: runTerminalStartupWithFallback resets reveal timer after waitUntilAttachable and falls back on unhandled rejection", async () => {
  assert.equal(MOUNT_SAFETY_REVEAL_MS, 1500);
  const events: string[] = [];
  let relaySubscribed = false;
  let localPending = true;

  await runTerminalStartupWithFallback({
    isAlive: () => true,
    waitUntilAttachable: async () => {
      events.push("waitUntilAttachable");
    },
    resetMountStartedAt: () => {
      events.push("resetMountStartedAt");
    },
    startPrimary: async () => {
      events.push("startPrimary");
      throw new Error("local mux failed");
    },
    onError: () => {
      events.push("onError");
    },
    clearLocalAttachPending: () => {
      localPending = false;
      events.push("clearLocalAttachPending");
    },
    isLocalConnected: () => false,
    startRelayFallback: () => {
      relaySubscribed = true;
      events.push("startRelayFallback");
    },
    hasRelaySubscription: () => relaySubscribed,
    markHostReadyFallback: () => {
      events.push("markHostReadyFallback");
    },
  });

  assert.equal(localPending, false);
  assert.deepEqual(events, [
    "waitUntilAttachable",
    "resetMountStartedAt",
    "startPrimary",
    "clearLocalAttachPending",
    "onError",
    "startRelayFallback",
  ]);

  // If relay fallback itself cannot subscribe, markHostReadyFallback guarantees data-ready="true".
  const fallbackEvents: string[] = [];
  await runTerminalStartupWithFallback({
    isAlive: () => true,
    waitUntilAttachable: async () => {
      throw new Error("attachable rejected");
    },
    resetMountStartedAt: () => fallbackEvents.push("resetMountStartedAt"),
    startPrimary: async () => fallbackEvents.push("startPrimary"),
    clearLocalAttachPending: () => fallbackEvents.push("clearLocalAttachPending"),
    isLocalConnected: () => false,
    startRelayFallback: () => {
      fallbackEvents.push("startRelayFallback");
      throw new Error("relay unavailable");
    },
    hasRelaySubscription: () => false,
    markHostReadyFallback: () => fallbackEvents.push("markHostReadyFallback"),
  });

  assert.deepEqual(fallbackEvents, [
    "clearLocalAttachPending",
    "startRelayFallback",
    "markHostReadyFallback",
  ]);
});

test("Bug 1D: createRelayFallbackController handles 0-byte raw:true fallback, 2x retry backoff, stale->live recovery, and cleanup", async () => {
  // Case 1: live raw:true with 0 bytes triggers one-shot terminal.read after 1200ms and writes only if still !sawRaw.
  {
    const timers = createManualTimers();
    let sawRaw = false;
    const reads: number[] = [];
    const written: string[] = [];
    const ctrl = createRelayFallbackController({
      isAlive: () => true,
      hasSawRaw: () => sawRaw,
      readScreen: async () => {
        reads.push(1);
        return { text: "idle-screen" };
      },
      onFallbackScreen: (res) => written.push(res.text),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    ctrl.start();
    ctrl.onStreamState({ kind: "live", result: { raw: true } });
    timers.advance(RAW_EMPTY_FALLBACK_MS - 1);
    assert.equal(reads.length, 0);

    timers.advance(1);
    await Promise.resolve();
    assert.equal(reads.length, 1);
    assert.deepEqual(written, ["idle-screen"]);
    ctrl.dispose();
  }

  // Case 2: If raw bytes arrive before 1200ms, rawEmptyFallbackTimer is canceled immediately.
  {
    const timers = createManualTimers();
    let sawRaw = false;
    let reads = 0;
    const ctrl = createRelayFallbackController({
      isAlive: () => true,
      hasSawRaw: () => sawRaw,
      readScreen: async () => {
        reads += 1;
        return { text: "should-not-read" };
      },
      onFallbackScreen: () => {},
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    ctrl.start();
    ctrl.onStreamState({ kind: "live", result: { raw: true } });
    timers.advance(200);
    sawRaw = true;
    ctrl.onRawBytes();
    assert.equal(timers.pendingCount(), 0);
    timers.advance(RAW_EMPTY_FALLBACK_MS * 2);
    await Promise.resolve();
    assert.equal(reads, 0);
    ctrl.dispose();
  }

  // Case 3: Failed terminal.read retries up to 2 times with 1500ms backoff while !sawRaw && !rawModeConfirmed.
  {
    const timers = createManualTimers();
    let attempts = 0;
    const written: string[] = [];
    let errorNotifies = 0;
    const ctrl = createRelayFallbackController({
      isAlive: () => true,
      hasSawRaw: () => false,
      readScreen: async () => {
        attempts += 1;
        if (attempts <= FALLBACK_READ_MAX_RETRIES) {
          throw new Error(`blip-${attempts}`);
        }
        return { text: "recovered-on-retry-2" };
      },
      onFallbackScreen: (res) => written.push(res.text),
      onFallbackReadError: () => {
        errorNotifies += 1;
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    ctrl.start();
    timers.advance(240);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(attempts, 1);
    assert.equal(errorNotifies, 1);

    timers.advance(FALLBACK_READ_RETRY_MS);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(attempts, 2);

    timers.advance(FALLBACK_READ_RETRY_MS);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(attempts, 3);
    assert.deepEqual(written, ["recovered-on-retry-2"]);
    ctrl.dispose();
  }

  // Case 4: stale/error -> live recovery while !sawRaw re-triggers fallback read/timer.
  {
    const timers = createManualTimers();
    let reads = 0;
    const written: string[] = [];
    const ctrl = createRelayFallbackController({
      isAlive: () => true,
      hasSawRaw: () => false,
      readScreen: async () => {
        reads += 1;
        return { text: `read-${reads}` };
      },
      onFallbackScreen: (res) => written.push(res.text),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    ctrl.start();
    ctrl.onStreamState({ kind: "stale" });
    ctrl.onStreamState({ kind: "live", result: { raw: false } });
    await Promise.resolve();
    assert.equal(reads, 1);
    assert.deepEqual(written, ["read-1"]);

    // Subsequent stale -> live(raw: true) re-arms rawEmptyFallbackTimer.
    ctrl.onStreamState({ kind: "stale" });
    ctrl.onStreamState({ kind: "live", result: { raw: true } });
    timers.advance(RAW_EMPTY_FALLBACK_MS);
    await Promise.resolve();
    assert.equal(reads, 2);
    assert.deepEqual(written, ["read-1", "read-2"]);
    ctrl.dispose();
    assert.equal(timers.pendingCount(), 0);
  }
});

test("Bug 1E & Task 2 / Q2: reveal budgets, cursorBlink gating, data-blurred, data-user-idle, and static guardrails", () => {
  assert.equal(LOCAL_FONT_WAIT_MS, 60);
  assert.equal(LOCAL_HOST_READY_FALLBACK_MS, 180);
  assert.equal(RELAY_HOST_READY_FALLBACK_MS, 280);
  assert.equal(USER_IDLE_TIMEOUT_MS, 45_000);

  assert.equal(
    shouldEnableTerminalCursorBlink({ configBlink: true, active: true, focused: true, windowFocused: true }),
    true,
  );
  assert.equal(
    shouldEnableTerminalCursorBlink({ configBlink: true, active: true, focused: false, windowFocused: true }),
    false,
  );
  assert.equal(
    shouldEnableTerminalCursorBlink({ configBlink: true, active: false, focused: true, windowFocused: true }),
    false,
  );
  assert.equal(
    shouldEnableTerminalCursorBlink({ configBlink: true, active: true, focused: true, windowFocused: false }),
    false,
  );
  assert.equal(
    shouldEnableTerminalCursorBlink({ configBlink: false, active: true, focused: true, windowFocused: true }),
    false,
  );

  // Verify attachWindowBlurAttribute + attachUserIdleAttribute deterministically.
  const winListeners = new Map<string, Set<() => void>>();
  const docListeners = new Map<string, Set<() => void>>();
  const attrs = new Map<string, string>();
  let focused = false;
  let hidden = false;

  const mockWin = {
    addEventListener(type: string, fn: () => void) {
      let set = winListeners.get(type);
      if (!set) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      winListeners.get(type)?.delete(fn);
    },
  };
  const mockDoc = {
    get hidden() {
      return hidden;
    },
    hasFocus: () => focused,
    documentElement: {
      setAttribute(name: string, val: string) {
        attrs.set(name, val);
      },
      removeAttribute(name: string) {
        attrs.delete(name);
      },
    },
    addEventListener(type: string, fn: () => void) {
      let set = docListeners.get(type);
      if (!set) {
        set = new Set();
        docListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      docListeners.get(type)?.delete(fn);
    },
  };

  const cleanupBlur = attachWindowBlurAttribute(mockWin as never, mockDoc);
  assert.equal(attrs.has("data-blurred"), true);
  for (const fn of winListeners.get("focus") ?? []) fn();
  assert.equal(attrs.has("data-blurred"), false);
  focused = true;
  for (const fn of winListeners.get("blur") ?? []) fn();
  assert.equal(attrs.has("data-blurred"), true);
  focused = true;
  hidden = false;
  for (const fn of docListeners.get("visibilitychange") ?? []) fn();
  assert.equal(attrs.has("data-blurred"), false);
  hidden = true;
  for (const fn of docListeners.get("visibilitychange") ?? []) fn();
  assert.equal(attrs.has("data-blurred"), true);
  cleanupBlur();

  // Verify attachUserIdleAttribute sets data-user-idle after 25s and clears immediately on input/focus.
  hidden = false;
  const idleTimers = createManualTimers();
  const cleanupIdle = attachUserIdleAttribute(mockWin as never, mockDoc, {
    now: idleTimers.now,
    setTimeoutFn: idleTimers.setTimeoutFn,
    clearTimeoutFn: idleTimers.clearTimeoutFn,
  });
  assert.equal(attrs.has("data-user-idle"), false);

  // Move pointer at t=10s (past throttle) -> extends deadline by USER_IDLE_TIMEOUT_MS.
  idleTimers.advance(10_000);
  for (const fn of winListeners.get("pointermove") ?? []) fn();
  idleTimers.advance(USER_IDLE_TIMEOUT_MS - 5_000);
  assert.equal(attrs.has("data-user-idle"), false);

  idleTimers.advance(5_000);
  assert.equal(attrs.has("data-user-idle"), true);

  // Pointermove wakes immediately even inside throttle window!
  for (const fn of winListeners.get("pointermove") ?? []) fn();
  assert.equal(attrs.has("data-user-idle"), false);

  // Advance 25s -> idle again, then keydown wakes immediately.
  idleTimers.advance(USER_IDLE_TIMEOUT_MS);
  assert.equal(attrs.has("data-user-idle"), true);
  for (const fn of winListeners.get("keydown") ?? []) fn();
  assert.equal(attrs.has("data-user-idle"), false);

  // Advance 25s -> idle again, then focus wakes immediately.
  idleTimers.advance(USER_IDLE_TIMEOUT_MS);
  assert.equal(attrs.has("data-user-idle"), true);
  for (const fn of winListeners.get("focus") ?? []) fn();
  assert.equal(attrs.has("data-user-idle"), false);

  cleanupIdle();
  assert.equal(idleTimers.pendingCount(), 0);
  assert.equal(winListeners.get("pointerdown")?.size ?? 0, 0);
  assert.equal(winListeners.get("pointermove")?.size ?? 0, 0);
  assert.equal(winListeners.get("keydown")?.size ?? 0, 0);
  assert.equal(winListeners.get("wheel")?.size ?? 0, 0);

  // Guardrail assertions on CSS and TerminalSurface wiring.
  const appCss = readFileSync(resolve(DESKTOP_ROOT, "src/styles/app.css"), "utf8");
  const shellCss = readFileSync(resolve(DESKTOP_ROOT, "src/styles/shell.css"), "utf8");
  const termSrc = readFileSync(resolve(DESKTOP_ROOT, "src/components/TerminalSurface.tsx"), "utf8");

  assert.equal(appCss.includes(":root[data-blurred] *"), true);
  assert.equal(appCss.includes(":root[data-user-idle] *"), true);
  assert.equal(appCss.includes(":root[data-blurred] .usage-vial-wave-front"), true);
  assert.equal(appCss.includes(":root[data-user-idle] .usage-vial-wave-front"), true);
  assert.equal(appCss.includes(":root[data-user-idle] .update-toast-card"), true);
  assert.equal(shellCss.includes(":root[data-blurred] .v3-spinner"), true);
  assert.equal(shellCss.includes(":root[data-user-idle] .v3-spinner"), true);
  assert.equal(termSrc.includes("prevActiveRef"), true);
  assert.equal(termSrc.includes("MOUNT_SAFETY_REVEAL_MS"), true);
  assert.equal(termSrc.includes("pendingBytes.shift()"), false, "Must never drop head VT chunks on hidden tabs");
  assert.equal(termSrc.includes("attachImmediateWebglContextLossListener"), true);
  assert.equal(termSrc.includes("releaseWebglAddonContext"), true);
  assert.equal(termSrc.includes("runTerminalActivationPhase0"), true);
  assert.equal(termSrc.includes("runTerminalActivationPhase1"), true);
  assert.equal(termSrc.includes("recoverActiveTerminalAfterWebglDispose"), true);
  assert.equal(termSrc.includes("runTerminalStartupWithFallback"), true);
  assert.equal(termSrc.includes("createRelayFallbackController"), true);
});
