import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import type { Agent, Device, SpaceInfo } from "@herdr-pocket/protocol";
import { logStore } from "../src/lib/log.ts";
import { recordClickPaintSample, resetPerfTelemetryForTest } from "../src/lib/perfTelemetry.ts";
import {
  getPortalWatcherSnapshotForTest,
  markHostPortalUnsupported,
  resetPortalClientStateForTest,
  subscribeAgentPortalUpdates,
} from "../src/lib/portalClient.ts";
import {
  isTerminalRendererReady,
  paintTerminalViewportImmediate,
  snapTerminalViewportImmediate,
  wakeTerminalRendererImmediate,
} from "../src/lib/terminalScroll.ts";
import { resetUiTelemetryForTest, trackTerminalReveal } from "../src/lib/uiTelemetry.ts";
import { liveStore } from "../src/lib/store.ts";
import {
  flushShellPersistenceNow,
  focusTabPane,
  openAgentTab,
  setActiveTab,
  shellStore,
  splitTabPane,
} from "../src/shell/shellStore.ts";

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreGlobals(): void {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
}

function resetStores(): void {
  resetPortalClientStateForTest();
  resetPerfTelemetryForTest();
  resetUiTelemetryForTest();
  shellStore.set({
    tabs: [],
    active: null,
    selectedSpace: null,
    activeBySpace: {},
    navHistoryBySpace: {},
    peekReturnByTab: {},
    panel: null,
    panelBySpace: {},
    panelWidth: 368,
    subagentAside: null,
    settings: null,
    palette: false,
    peek: null,
  });
  liveStore.set({
    link: "online",
    error: null,
    devices: {
      h1: { id: "h1", name: "Mac", kind: "host", online: true } as Device,
    },
    agents: {
      h1: [
        {
          key: "h1/hc:t1",
          deviceId: "h1",
          source: "hc",
          localId: "t1",
          harness: "claude",
          title: "Agent 1",
          where: "proj / t1",
          status: "idle",
          updatedAt: 1000,
        } as Agent,
        {
          key: "h1/hc:t2",
          deviceId: "h1",
          source: "hc",
          localId: "t2",
          harness: "codex",
          title: "Agent 2",
          where: "proj / t2",
          status: "working",
          updatedAt: 2000,
        } as Agent,
      ],
    },
    spaces: {
      h1: [{ id: "sp1", name: "proj", active: true } as SpaceInfo],
    },
    direct: {},
    rev: 1,
  });
}

afterEach(() => {
  resetStores();
  flushShellPersistenceNow();
  restoreGlobals();
});

test("openAgentTab, setActiveTab, and focusTabPane preserve tabs array reference when split focus is unchanged", () => {
  resetStores();
  openAgentTab("h1/hc:t1", "term");
  openAgentTab("h1/hc:t2", "term");

  const tabsRefAfterOpen = shellStore.get().tabs;
  assert.equal(tabsRefAfterOpen.length, 2);

  // Switching back to an already-open single-pane agent tab must not clone `tabs`.
  openAgentTab("h1/hc:t1");
  assert.equal(shellStore.get().active, "a:h1/hc:t1");
  assert.strictEqual(shellStore.get().tabs, tabsRefAfterOpen);

  // `setActiveTab` must also preserve exact `tabs` reference.
  setActiveTab("a:h1/hc:t2");
  assert.equal(shellStore.get().active, "a:h1/hc:t2");
  assert.strictEqual(shellStore.get().tabs, tabsRefAfterOpen);

  // Split pane t2 into 2 panes: changing pane focus must update `tabs`, re-focusing same pane must not.
  const paneB = splitTabPane("a:h1/hc:t2", null, "right", {
    kind: "agent",
    agentKey: "h1/hc:t1",
    mode: "term",
  });
  assert.ok(paneB);
  const splitTabsRef = shellStore.get().tabs;
  assert.notStrictEqual(splitTabsRef, tabsRefAfterOpen);

  focusTabPane("a:h1/hc:t2", paneB!);
  assert.strictEqual(shellStore.get().tabs, splitTabsRef);

  const paneA = shellStore.get().tabs[1]!.split!.root.type === "split"
    ? shellStore.get().tabs[1]!.split!.root.children[0]!.id
    : "";
  assert.ok(paneA);
  focusTabPane("a:h1/hc:t2", paneA);
  assert.notStrictEqual(shellStore.get().tabs, splitTabsRef);
});

test("shellStore debounces localStorage writes off synchronous click path and flushes on demand", () => {
  resetStores();
  const written = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => written.get(k) ?? null,
      setItem: (k: string, v: string) => {
        written.set(k, v);
      },
      removeItem: (k: string) => {
        written.delete(k);
      },
    },
  });

  openAgentTab("h1/hc:t1", "term");
  setActiveTab("a:h1/hc:t1");
  // Debounced: no synchronous JSON.stringify/setItem blocked the click call.
  assert.equal(written.has("herdr-pocket-shell"), false);

  flushShellPersistenceNow();
  const saved = written.get("herdr-pocket-shell");
  assert.ok(saved);
  const parsed = JSON.parse(saved) as { active: string; tabs: Array<{ id: string }> };
  assert.equal(parsed.active, "a:h1/hc:t1");
  assert.equal(parsed.tabs.length, 1);
});

test("recordClickPaintSample emits perf.click warning only when frame delay exceeds 80ms", () => {
  resetPerfTelemetryForTest();
  const baseLen = logStore.get().entries.length;
  recordClickPaintSample(6.4, "button: fast click");
  recordClickPaintSample(95.2, "button: slow click");
  const added = logStore.get().entries.slice(baseLen);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.scope, "perf.click");
  assert.equal(added[0]!.level, "warn");
  assert.equal(added[0]!.data?.ms, 95);
});

test("subscribeAgentPortalUpdates retains host watcher across brief 0-ref tab switches", () => {
  resetStores();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  markHostPortalUnsupported("h1");

  const unsub1 = subscribeAgentPortalUpdates("h1", "h1/hc:t1");
  assert.deepEqual(getPortalWatcherSnapshotForTest("h1"), { refs: 1, hasDisposeTimer: false });

  unsub1();
  assert.deepEqual(getPortalWatcherSnapshotForTest("h1"), { refs: 0, hasDisposeTimer: true });

  const unsub2 = subscribeAgentPortalUpdates("h1", "h1/hc:t2");
  assert.deepEqual(getPortalWatcherSnapshotForTest("h1"), { refs: 1, hasDisposeTimer: false });
  unsub2();
});

test("wakeTerminalRendererImmediate and paintTerminalViewportImmediate unpause and render Frame 0 safely", () => {
  let measured = 0;
  let flushed = 0;
  let resized: [number, number] | null = null;
  let rendered: [number, number] | null = null;
  let scrolledTo: number | null = null;

  const rs = {
    _isPaused: true,
    _needsFullRefresh: true,
    _charSizeService: {
      hasValidSize: false,
      measure: () => {
        measured += 1;
        rs._charSizeService.hasValidSize = true;
      },
    },
    _pausedResizeTask: {
      flush: () => {
        flushed += 1;
      },
    },
    dimensions: {
      css: {
        cell: { height: 18 },
        canvas: { height: 0 },
      },
    },
    hasRenderer: () => true,
    handleResize: (cols: number, rows: number) => {
      resized = [cols, rows];
      rs.dimensions.css.canvas.height = rows * 18;
    },
    _renderRows: (start: number, end: number) => {
      rendered = [start, end];
    },
  };

  const normalBuf = { baseY: 120, viewportY: 0 };
  const fakeTerm = {
    cols: 100,
    rows: 30,
    buffer: { active: normalBuf, normal: normalBuf },
    scrollToLine: (line: number) => {
      scrolledTo = line;
      normalBuf.viewportY = line;
    },
    _core: {
      _renderService: rs,
      _viewport: {
        _latestYDisp: 120,
        _sync: () => {},
        scrollToLine: (line: number) => {
          scrolledTo = line;
          normalBuf.viewportY = line;
        },
      },
    },
  };

  assert.equal(isTerminalRendererReady(fakeTerm as never), false);
  const woke = wakeTerminalRendererImmediate(fakeTerm as never);
  assert.equal(woke, true);
  assert.equal(rs._isPaused, false);
  assert.equal(measured, 1);
  assert.equal(flushed, 1);
  assert.deepEqual(resized, [100, 30]);
  assert.equal(isTerminalRendererReady(fakeTerm as never), true);

  assert.equal(snapTerminalViewportImmediate(fakeTerm as never, true, 0), true);
  assert.equal(scrolledTo, 120);

  const painted = paintTerminalViewportImmediate(fakeTerm as never);
  assert.equal(painted, true);
  assert.equal(rs._needsFullRefresh, false);
  assert.deepEqual(rendered, [0, 29]);

  // Partial or throwing mocks must never crash callers.
  assert.equal(wakeTerminalRendererImmediate(null), false);
  assert.equal(paintTerminalViewportImmediate(undefined), false);
  assert.equal(wakeTerminalRendererImmediate({ cols: 80, rows: 24 } as never), false);
  assert.equal(paintTerminalViewportImmediate({ cols: 80, rows: 24 } as never), false);
  const throwingTerm = {
    cols: 80,
    rows: 24,
    get _core() {
      throw new Error("boom");
    },
  };
  assert.equal(wakeTerminalRendererImmediate(throwingTerm as never), false);
  assert.equal(paintTerminalViewportImmediate(throwingTerm as never), false);
});

test("trackTerminalReveal emits term.reveal.slow warning only when duration exceeds 220ms", () => {
  resetUiTelemetryForTest();
  const baseLen = logStore.get().entries.length;
  trackTerminalReveal(180, "local");
  trackTerminalReveal(220, "relay");
  assert.equal(logStore.get().entries.length, baseLen);

  trackTerminalReveal(345.6, "local");
  const added = logStore.get().entries.slice(baseLen);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.scope, "term");
  assert.equal(added[0]!.level, "warn");
  assert.equal(added[0]!.msg, "term.reveal.slow");
  assert.deepEqual(added[0]!.data, { ms: 346, mode: "local" });
});
