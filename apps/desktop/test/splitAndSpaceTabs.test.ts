import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent, Device, HerdrDoc, SpaceInfo } from "@herdr-pocket/protocol";
import { liveStore } from "../src/lib/store.ts";
import { canActOnLocalFile, revealInFolderLabel } from "../src/lib/localFileActions.ts";
import { hasFileJumpModifier } from "../src/lib/openFileTarget.ts";
import { tierFor } from "../src/lib/layout.ts";
import { extractHostHerdrDoc, formatHerdrTabLabel, splitNodeToHerdrRoot } from "../src/shell/herdrDoc.ts";
import {
  clearPendingSplitPlacements,
  createHerdrDocSyncController,
  registerPendingSplitPlacement,
  type HerdrDocTransport,
} from "../src/shell/herdrDocSync.ts";
import { IS_MAC, formatEventKeyTokens, matchShortcut } from "../src/shell/shortcuts.ts";
import { beginSplitMotion, isSplitMotionActive, onSplitMotionSettled } from "../src/shell/splitMotion.ts";
import {
  activeTabIdForSpace,
  closeTab,
  closeTabPane,
  openAgentTab,
  openDiffTab,
  openFileTab,
  openWebTab,
  reconcileHostHerdrDoc,
  refreshHostDocSpaceNames,
  renameSpaceInShellStore,
  setActiveTab,
  setPeek,
  setSelectedSpace,
  shellStore,
  splitActivePaneWithContent,
  splitTabPane,
  stableSplitLeafKeys,
  tabLeaves,
  togglePanel,
  visibleTabsForSpace,
} from "../src/shell/shellStore.ts";

function resetStores(): void {
  clearPendingSplitPlacements();
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
    link: "idle",
    devices: {},
    agents: {},
    spaces: {},
    direct: {},
    rev: 0,
  });
}

afterEach(() => {
  resetStores();
});

test("visibleTabsForSpace & openAgentTab keep tabs Space-scoped and follow clicked Agent across Spaces & both Macs", () => {
  const officeAgents: Agent[] = [
    { key: "office/hc:t1", deviceId: "office", source: "hc", localId: "t1", harness: "claude-code", title: "Shop API", where: "伊吹工坊 / 1", status: "working", isShell: false, updatedAt: 1 },
    { key: "office/hc:t2", deviceId: "office", source: "hc", localId: "t2", harness: "codex", title: "Session Index", where: "Uniflo / 1", status: "idle", isShell: false, updatedAt: 2 },
  ];
  const homeAgents: Agent[] = [
    { key: "home/hc:h1", deviceId: "home", source: "hc", localId: "h1", harness: "gemini-cli", title: "Home Runner", where: "测试 / 1", status: "done", isShell: false, updatedAt: 3 },
    { key: "home/hc:h2", deviceId: "home", source: "hc", localId: "h2", harness: "zsh", title: "zsh", where: "测试 / 2", status: "idle", isShell: true, updatedAt: 4 },
  ];
  const officeSpaces: SpaceInfo[] = [
    { id: "sp-ibuki", name: "伊吹工坊", folder: "~/work_file/ibuki-pet", tabs: 1, terminals: 1, active: true },
    { id: "sp-uniflo", name: "Uniflo", folder: "~/work_file/ibuki-next", tabs: 1, terminals: 1 },
  ];
  const homeSpaces: SpaceInfo[] = [
    { id: "sp-home-test", name: "测试", folder: "~/crosery", tabs: 2, terminals: 2, active: true },
  ];

  liveStore.set({
    link: "online",
    devices: {
      office: { id: "office", name: "Office Mac", kind: "host", platform: "darwin", online: true, createdAt: 1, lastSeenAt: 1 },
      home: { id: "home", name: "Home Mac", kind: "host", platform: "darwin", online: true, createdAt: 1, lastSeenAt: 1 },
    },
    agents: { office: officeAgents, home: homeAgents },
    spaces: { office: officeSpaces, home: homeSpaces },
    direct: {},
    rev: 1,
  });

  // Unnamed space (`name: ""`) in Office Mac HerdrDoc is matched to `"Uniflo"` via spaces.list (`refreshHostDocSpaceNames`).
  const officeDoc: HerdrDoc = {
    spaces: [
      { id: "sp-ibuki", name: "伊吹工坊", folder: "~/work_file/ibuki-pet", tabs: [{ id: "tb1", name: "1", root: { id: "p1", type: "block", content: { terminal: "t1" } } }] },
      { id: "sp-uniflo", name: "", folder: "~/work_file/ibuki-next", tabs: [{ id: "tb2", name: "1", root: { id: "p2", type: "block", content: { terminal: "t2" } } }] },
    ],
  };
  const homeDoc: HerdrDoc = {
    spaces: [
      {
        id: "sp-home-test",
        name: "测试",
        folder: "~/crosery",
        tabs: [
          { id: "ht1", name: "1", root: { id: "hp1", type: "block", content: { terminal: "h1" } } },
          { id: "ht2", name: "2", root: { id: "hp2", type: "block", content: { terminal: "h2" } } },
        ],
      },
    ],
  };

  // Reconcile office doc BEFORE spaces resolve name, then refresh name.
  reconcileHostHerdrDoc("office", officeDoc);
  reconcileHostHerdrDoc("home", homeDoc, undefined, homeSpaces);
  refreshHostDocSpaceNames("office", officeSpaces);

  setSelectedSpace("office\u0000伊吹工坊");
  let s = shellStore.get();
  let vis = visibleTabsForSpace(s.tabs, s.selectedSpace, () => undefined, liveStore.get().spaces);
  assert.deepEqual(vis.map((t) => t.id), ["ht:office:sp-ibuki:tb1"]);

  // Clicking Uniflo agent (whose HerdrDoc space had `name: ""`) switches selectedSpace to Office/Uniflo & shows ONLY Uniflo's tab!
  openAgentTab("office/hc:t2");
  s = shellStore.get();
  assert.equal(s.selectedSpace, "office\u0000Uniflo");
  assert.equal(s.active, "ht:office:sp-uniflo:tb2");
  vis = visibleTabsForSpace(s.tabs, s.selectedSpace, () => undefined, liveStore.get().spaces);
  assert.deepEqual(vis.map((t) => t.id), ["ht:office:sp-uniflo:tb2"]);

  // Extracting office doc back preserves the unnamed `name: ""` metadata from baseDoc and avoids duplicating `sp-uniflo`.
  const extracted = extractHostHerdrDoc("office", s.tabs, officeDoc, officeSpaces, (k) => officeAgents.find((a) => a.key === k));
  assert.equal(extracted.spaces.length, 2);
  assert.equal(extracted.spaces[1]!.id, "sp-uniflo");
  assert.equal(extracted.spaces[1]!.tabs.length, 1);

  // Clicking an Agent on Home Mac switches selectedSpace to Home Mac/测试 and scopes the tab strip to Home Mac's 2 tabs!
  openAgentTab("home/hc:h2");
  s = shellStore.get();
  assert.equal(s.selectedSpace, "home\u0000测试");
  assert.equal(s.active, "ht:home:sp-home-test:ht2");
  vis = visibleTabsForSpace(s.tabs, s.selectedSpace, () => undefined, liveStore.get().spaces);
  assert.deepEqual(vis.map((t) => t.id), ["ht:home:sp-home-test:ht1", "ht:home:sp-home-test:ht2"]);

  // Switching back to Office Mac/伊吹工坊 restores remembered active tab `tb1`, and setActiveTab also follows tab Space!
  setSelectedSpace("office\u0000伊吹工坊");
  s = shellStore.get();
  assert.equal(activeTabIdForSpace(s, () => undefined, liveStore.get().spaces), "ht:office:sp-ibuki:tb1");
  setActiveTab("ht:home:sp-home-test:ht1");
  s = shellStore.get();
  assert.equal(s.selectedSpace, "home\u0000测试");
  assert.equal(s.active, "ht:home:sp-home-test:ht1");
});

test("splitTabPane dedupeOtherTabs prevents duplicate HerdrDoc terminals on same host while preserving cross-host tabs", () => {
  const agents: Record<string, Agent[]> = {
    office: [
      { key: "office/hc:t1", deviceId: "office", source: "hc", localId: "t1", harness: "claude-code", where: "backend / 1", status: "idle", isShell: false, updatedAt: 1 },
      { key: "office/hc:t2", deviceId: "office", source: "hc", localId: "t2", harness: "codex", where: "backend / 2", status: "idle", isShell: false, updatedAt: 2 },
    ],
    home: [
      { key: "home/hc:h1", deviceId: "home", source: "hc", localId: "h1", harness: "gemini-cli", where: "tests / 1", status: "idle", isShell: false, updatedAt: 3 },
    ],
  };
  liveStore.set({
    link: "online",
    devices: {},
    agents,
    spaces: {
      office: [{ id: "sp-1", name: "backend", folder: "~/app", tabs: 2, terminals: 2 }],
      home: [{ id: "sp-h", name: "tests", folder: "~/home", tabs: 1, terminals: 1 }],
    },
    direct: {},
    rev: 1,
  });

  reconcileHostHerdrDoc("office", {
    spaces: [
      {
        id: "sp-1",
        name: "backend",
        folder: "~/app",
        tabs: [
          { id: "tb1", name: "1", root: { id: "p1", type: "block", content: { terminal: "t1" } } },
          { id: "tb2", name: "2", root: { id: "p2", type: "block", content: { terminal: "t2" } } },
        ],
      },
    ],
  });
  reconcileHostHerdrDoc("home", {
    spaces: [{ id: "sp-h", name: "tests", folder: "~/home", tabs: [{ id: "ht1", name: "1", root: { id: "hp1", type: "block", content: { terminal: "h1" } } }] }],
  });
  setSelectedSpace("office\u0000backend");

  // Same-host split removes duplicate `tb2` from Office doc so t2 lives only in tb1 split.
  splitActivePaneWithContent("right", { kind: "agent", agentKey: "office/hc:t2", mode: "term" });
  let s = shellStore.get();
  assert.equal(s.tabs.some((t) => t.id === "ht:office:sp-1:tb2"), false);
  const tb1 = s.tabs.find((t) => t.id === "ht:office:sp-1:tb1")!;
  assert.equal(tabLeaves(tb1).length, 2);

  // Side-by-side duplicate leaf of same agent serializes cleanly without duplicating terminal block in HerdrDoc.
  splitTabPane(tb1.id, "p1", "down", { kind: "agent", agentKey: "office/hc:t1", mode: "chat" });
  const herdrRoot = splitNodeToHerdrRoot("office", shellStore.get().tabs.find((t) => t.id === tb1.id)!.split!.root);
  const serializedJson = JSON.stringify(herdrRoot);
  assert.equal(serializedJson.match(/"terminal":"t1"/g)?.length, 1);

  // Cross-host split keeps Home Mac's own tab intact in Home Mac's doc!
  splitTabPane(tb1.id, "p1", "right", { kind: "agent", agentKey: "home/hc:h1", mode: "term" }, { dedupeOtherTabs: true });
  s = shellStore.get();
  assert.equal(s.tabs.some((t) => t.id === "ht:home:sp-h:ht1"), true);
});

test("herdrDocSync preserves registered pending fallback split across an inbound CAS conflict", async () => {
  const dev: Device = { id: "h1", name: "mac", kind: "host", platform: "darwin", online: true, createdAt: 1, lastSeenAt: 1 };
  const spaces: SpaceInfo[] = [{ id: "sp-1", name: "backend", folder: "~/app", tabs: 1, terminals: 1, active: true }];
  const agents: Agent[] = [
    { key: "h1/hc:t1", deviceId: "h1", source: "hc", localId: "t1", harness: "claude-code", where: "backend", status: "idle", isShell: false, updatedAt: 1 },
    { key: "h1/hc:t2", deviceId: "h1", source: "hc", localId: "t2", harness: "zsh", where: "backend", status: "idle", isShell: true, updatedAt: 2 },
  ];

  let serverVersion = 5;
  let serverDoc: HerdrDoc = {
    spaces: [
      { id: "sp-1", name: "backend", folder: "~/app", tabs: [{ id: "tb1", name: "1", root: { id: "p1", type: "block", content: { terminal: "t1" } } }] },
    ],
  };

  const transport: HerdrDocTransport = {
    async getDoc() {
      return { value: JSON.parse(JSON.stringify(serverDoc)), version: serverVersion };
    },
    async setDoc(_hostId, value, version) {
      if (version !== serverVersion) {
        return {
          ok: false,
          conflict: true,
          value: JSON.parse(JSON.stringify(serverDoc)),
          version: serverVersion,
        };
      }
      serverDoc = JSON.parse(JSON.stringify(value));
      serverVersion += 1;
      return { ok: true, version: serverVersion };
    },
    getAgents: () => ({ h1: agents }),
    getSpaces: () => ({ h1: spaces }),
    getDevices: () => ({ h1: dev }),
    getLocalHostId: () => "h1",
  };

  const ctrl = createHerdrDocSyncController(transport, 1);
  await ctrl.syncAllOnlineHosts();

  // Simulate concurrent Herdr.app update pushing `t2` as a standalone tab (`version: 6`) while Pocket splits `t2` into `tb1`.
  serverDoc = {
    spaces: [
      {
        id: "sp-1",
        name: "backend",
        folder: "~/app",
        tabs: [
          { id: "tb1", name: "1", root: { id: "p1", type: "block", content: { terminal: "t1" } } },
          { id: "tb2", name: "", root: { id: "p2", type: "block", content: { terminal: "t2" } } },
        ],
      },
    ],
  };
  serverVersion = 6;

  registerPendingSplitPlacement("h1", {
    terminalId: "t2",
    agentKey: "h1/hc:t2",
    targetTabId: "ht:h1:sp-1:tb1",
    targetDocTabId: "tb1",
    anchorPaneId: "p1",
    direction: "right",
  });
  splitTabPane("ht:h1:sp-1:tb1", "p1", "right", { kind: "agent", agentKey: "h1/hc:t2", mode: "term" }, { dedupeOtherTabs: true });
  ctrl.handleShellChange();
  await ctrl.flushHost("h1");

  // Pending split survived CAS conflict cleanly and landed at version 7 with tb1 having 2 panes and no duplicate tb2!
  assert.equal(serverVersion, 7);
  assert.equal(serverDoc.spaces[0]!.tabs.length, 1);
  assert.equal(serverDoc.spaces[0]!.tabs[0]!.root.type, "row");
  assert.equal(serverDoc.spaces[0]!.tabs[0]!.root.children?.length, 2);
  ctrl.reset();
});

test("TerminalSurface and AgentsView let internal split drags pass through without stopPropagation, and shell.css disables icon drag", () => {
  const termSrc = readFileSync(new URL("../src/components/TerminalSurface.tsx", import.meta.url), "utf8");
  const agentsSrc = readFileSync(new URL("../src/views/AgentsView.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8");

  assert.match(termSrc, /hasTabDrag\(e\)\s*\|\|\s*hasPanelDrag\(e\)\s*\|\|\s*hasPaneDrag\(e\)/);
  assert.equal(termSrc.includes("(dt.items?.length ?? 0) > 0"), false, "string drag items must not trigger TerminalSurface stopPropagation");
  assert.match(agentsSrc, /hasTabDrag\(e\)\s*\|\|\s*hasPanelDrag\(e\)\s*\|\|\s*hasPaneDrag\(e\)/);
  assert.match(css, /\.v3-row\[draggable="true"\]\s*\{[^}]*-webkit-user-drag:\s*element/);
  assert.match(css, /\.v3-row\[draggable="true"\]\s*>\s*\.vendor-icon[\s\S]*?-webkit-user-drag:\s*none/);
  assert.match(css, /\.v3-tab\[draggable="true"\]\s*>\s*\.vendor-icon[\s\S]*?-webkit-user-drag:\s*none/);
});

test("Herdr tab naming never falls back to bare index numbers and cleans paths/terminal ids", () => {
  assert.equal(formatHerdrTabLabel({ name: "" }, { programName: "Claude Code", liveTitle: "" }, false), "Claude Code");
  assert.equal(formatHerdrTabLabel({ name: "" }, { programName: "Codex", liveTitle: "~/work_file/app" }, false), "Codex");
  assert.equal(formatHerdrTabLabel({ name: "" }, { programName: "Antigravity", liveTitle: "t19g" }, false), "Antigravity");
  assert.equal(formatHerdrTabLabel({ name: "" }, { programName: "Claude Code", liveTitle: "user@macbook" }, true), "Claude Code Z");
  assert.equal(formatHerdrTabLabel({ name: "" }, { programName: "", liveTitle: "zsh" }, false), "Terminal");
  assert.equal(formatHerdrTabLabel({ name: "" }, { programName: "Claude Code", liveTitle: "✳ Fix split tabs" }, false), "Fix split tabs");
});

test("panelBySpace and file/diff/web tabs remain scoped per Space across Space switches", () => {
  resetStores();
  const h1 = "h1";
  const agents: Agent[] = [
    { key: "h1/hc:t1", deviceId: h1, source: "hc", localId: "t1", harness: "claude-code", title: "A1", where: "alpha", cwd: "~/alpha", status: "idle", isShell: false, updatedAt: 1 },
    { key: "h1/hc:t2", deviceId: h1, source: "hc", localId: "t2", harness: "codex", title: "A2", where: "beta", cwd: "~/beta", status: "idle", isShell: false, updatedAt: 1 },
  ];
  liveStore.set({
    agents: { h1: agents },
    spaces: {
      h1: [
        { id: "sp-a", name: "alpha", folder: "~/alpha", tabs: 1, terminals: 1, color: "ansi1", active: true },
        { id: "sp-b", name: "beta", folder: "~/beta", tabs: 1, terminals: 1, color: "ansi2", active: false },
      ],
    },
  });

  setSelectedSpace("h1\u0000alpha");
  togglePanel("files");
  openFileTab("h1/hc:t1", "README.md", "README.md", { absPath: "/Users/dev/alpha/README.md" });
  openDiffTab({ deviceId: h1, agentKey: "h1/hc:t1", cwd: "~/alpha", path: "app.ts", staged: false });
  assert.equal(shellStore.get().panel, "files");

  setSelectedSpace("h1\u0000beta");
  assert.equal(shellStore.get().panel, null);
  togglePanel("git");
  openWebTab("https://example.com", "Example");

  const visibleInBeta = visibleTabsForSpace(shellStore.get().tabs, "h1\u0000beta", (k) => agents.find((a) => a.key === k), liveStore.get().spaces);
  assert.deepEqual(visibleInBeta.map((t) => t.kind), ["web"]);

  setSelectedSpace("h1\u0000alpha");
  assert.equal(shellStore.get().panel, "files");
  const visibleInAlpha = visibleTabsForSpace(shellStore.get().tabs, "h1\u0000alpha", (k) => agents.find((a) => a.key === k), liveStore.get().spaces);
  assert.deepEqual(visibleInAlpha.map((t) => t.kind), ["file", "diff"]);
});

test("canActOnLocalFile handles local agents/missing localHostId and Finder labels use 访达", () => {
  assert.equal(revealInFolderLabel("macos"), "在访达中定位");
  assert.equal(
    canActOnLocalFile({ nativeAvailable: true, agentDeviceId: "local", path: "/tmp/demo.html", absPath: "/tmp/demo.html" }),
    true,
  );
  assert.equal(
    canActOnLocalFile({ nativeAvailable: true, agentDeviceId: "h1", localHostId: null, path: "demo.html", absPath: "/tmp/demo.html" }),
    false,
  );
  assert.equal(
    canActOnLocalFile({ nativeAvailable: true, agentDeviceId: "h1", localHostId: "h1", path: "demo.html", absPath: "/tmp/demo.html" }),
    true,
  );
  assert.equal(
    canActOnLocalFile({ nativeAvailable: true, agentDeviceId: "remote-1", localHostId: "local-1", path: "demo.html", absPath: "/tmp/demo.html" }),
    false,
  );
});

test("Keep-alive ShellMain, TerminalSurface no-reattach focus/size sync, ResizeObserver settle debounce, and Tauri rail floor guards", () => {
  const shellSrc = readFileSync(new URL("../src/shell/ShellWork.tsx", import.meta.url), "utf8");
  const termSrc = readFileSync(new URL("../src/components/TerminalSurface.tsx", import.meta.url), "utf8");
  const appSrc = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8");

  assert.match(shellSrc, /MAX_KEPT_AGENT_TABS\s*=\s*24/);
  assert.match(shellSrc, /v3-tab-layer/);
  assert.match(shellSrc, /v3-pane-tool-btn/);
  assert.match(css, /\.v3-tab\s*\{[\s\S]*min-width:\s*78px;[\s\S]*max-width:\s*210px;/);
  assert.match(css, /@media \(hover: hover\)[\s\S]*\.v3-tab:not\(\.active\):not\(:hover\):not\(:focus-within\) \.v3-tab-x/);
  assert.doesNotMatch(termSrc, /reattachLocalRef\.current\(\)/);
  assert.match(termSrc, /resizeSettleTimer\s*=\s*window\.setTimeout\(/);
  assert.match(appSrc, /useViewportTier\(\)/);
  // Outside Tauri, < 860px collapses to mobile tier as documented.
  assert.equal(tierFor(780), "mobile");
});

test("Empty Space keeps active=null across reconcileHostHerdrDoc and openAgentTab with docMeta attaches to empty Space immediately", () => {
  resetStores();
  const h1 = "h1";
  const spaces: SpaceInfo[] = [
    { id: "sp-other", name: "测试", folder: "~/other", tabs: 1, terminals: 1, active: true },
    { id: "sp-empty", name: "geek_main", folder: "~/work_file/geek_main", tabs: 0, terminals: 0, active: false },
  ];
  const existingAgents: Agent[] = [
    { key: "h1/hc:t1", deviceId: h1, source: "hc", localId: "t1", harness: "claude-code", where: "测试 / 1", status: "idle", isShell: false, updatedAt: 1 },
  ];
  liveStore.set({
    agents: { h1: existingAgents },
    spaces: { h1: spaces },
  });

  // Select empty 0-tab Space `geek_main`.
  setSelectedSpace("h1\u0000geek_main");
  assert.equal(shellStore.get().active, null);

  // Reconciling a host doc with tabs in `sp-other` and 0 tabs in `sp-empty` MUST NOT leak `sp-other`'s tab into `active`.
  reconcileHostHerdrDoc(h1, {
    spaces: [
      { id: "sp-other", name: "测试", folder: "~/other", tabs: [{ id: "tb1", name: "1", root: { id: "p1", type: "block", content: { terminal: "t1" } } }] },
      { id: "sp-empty", name: "", folder: "~/work_file/geek_main", tabs: [] },
    ],
  }, undefined, spaces);
  assert.equal(shellStore.get().selectedSpace, "h1\u0000geek_main");
  assert.equal(shellStore.get().active, null);
  assert.deepEqual(
    visibleTabsForSpace(shellStore.get().tabs, shellStore.get().selectedSpace, (k) => existingAgents.find((a) => a.key === k), liveStore.get().spaces),
    [],
  );

  // Creating a shell in empty Space passes docMeta (`docSpaceId`, `docSpaceName`, `docTabId`) -> immediately visible in `geek_main`.
  openAgentTab("h1/hc:t2", "term", {
    followSpace: true,
    docMeta: { docHostId: h1, docSpaceId: "sp-empty", docSpaceName: "geek_main", docTabId: "tb-new" },
  });
  const s = shellStore.get();
  assert.equal(s.selectedSpace, "h1\u0000geek_main");
  assert.equal(s.active, "ht:h1:sp-empty:tb-new");
  const vis = visibleTabsForSpace(s.tabs, s.selectedSpace, (k) => existingAgents.find((a) => a.key === k), liveStore.get().spaces);
  assert.deepEqual(vis.map((t) => t.id), ["ht:h1:sp-empty:tb-new"]);
});

test("Closing image/file previews pops strictly one level back within the active Space and restores PeekOverlay", () => {
  resetStores();
  const h1 = "h1";
  const agents: Agent[] = [
    { key: "h1/hc:t1", deviceId: h1, source: "hc", localId: "t1", harness: "claude-code", where: "work / T1", cwd: "~/work", status: "idle", isShell: false, updatedAt: 1 },
    { key: "h1/hc:t2", deviceId: h1, source: "hc", localId: "t2", harness: "codex", where: "work / T2", cwd: "~/work", status: "idle", isShell: false, updatedAt: 2 },
    { key: "h1/hc:t3", deviceId: h1, source: "hc", localId: "t3", harness: "gemini-cli", where: "work / T3", cwd: "~/work", status: "idle", isShell: false, updatedAt: 3 },
    { key: "h1/hc:t4", deviceId: h1, source: "hc", localId: "t4", harness: "zsh", where: "work / T4", cwd: "~/work", status: "idle", isShell: true, updatedAt: 4 },
    { key: "h1/hc:b1", deviceId: h1, source: "hc", localId: "b1", harness: "claude-code", where: "other / B1", cwd: "~/other", status: "idle", isShell: false, updatedAt: 5 },
  ];
  const spaces: SpaceInfo[] = [
    { id: "sp-w", name: "work", folder: "~/work", tabs: 4, terminals: 4, active: true },
    { id: "sp-o", name: "other", folder: "~/other", tabs: 1, terminals: 1, active: false },
  ];
  liveStore.set({ agents: { h1 }, spaces: { h1: spaces } });

  reconcileHostHerdrDoc(h1, {
    spaces: [
      {
        id: "sp-w",
        name: "work",
        folder: "~/work",
        tabs: [
          { id: "tb1", name: "T1", root: { id: "p1", type: "block", content: { terminal: "t1" } } },
          { id: "tb2", name: "T2", root: { id: "p2", type: "block", content: { terminal: "t2" } } },
          { id: "tb3", name: "T3", root: { id: "p3", type: "block", content: { terminal: "t3" } } },
          { id: "tb4", name: "T4", root: { id: "p4", type: "block", content: { terminal: "t4" } } },
        ],
      },
      {
        id: "sp-o",
        name: "other",
        folder: "~/other",
        tabs: [{ id: "tb-o1", name: "B1", root: { id: "po1", type: "block", content: { terminal: "b1" } } }],
      },
    ],
  }, undefined, spaces);

  setSelectedSpace("h1\u0000work");
  setActiveTab("ht:h1:sp-w:tb2");

  // 1) Multi-level navigation from T2 -> spec.md -> diagram.png -> zoom.png returns strictly 1 level on each close!
  openFileTab("h1/hc:t2", "spec.md", "spec.md", { absPath: "/tmp/work/spec.md" });
  openFileTab("h1/hc:t2", "diagram.png", "diagram.png", { absPath: "/tmp/work/diagram.png" });
  openFileTab("h1/hc:t2", "zoom.png", "zoom.png", { absPath: "/tmp/work/zoom.png" });

  assert.equal(shellStore.get().active, "f:h1/hc:t2:zoom.png");
  closeTab("f:h1/hc:t2:zoom.png");
  assert.equal(shellStore.get().active, "f:h1/hc:t2:diagram.png");
  closeTab("f:h1/hc:t2:diagram.png");
  assert.equal(shellStore.get().active, "f:h1/hc:t2:spec.md");
  closeTab("f:h1/hc:t2:spec.md");
  assert.equal(shellStore.get().active, "ht:h1:sp-w:tb2");

  // 2) Re-opening existing preview from T3 returns to T3 (even if opened when another tab previously created it).
  openFileTab("h1/hc:t2", "shot.png", "shot.png");
  setActiveTab("ht:h1:sp-w:tb3");
  openFileTab("h1/hc:t2", "shot.png", "shot.png");
  assert.equal(shellStore.get().active, "f:h1/hc:t2:shot.png");
  closeTab("f:h1/hc:t2:shot.png");
  assert.equal(shellStore.get().active, "ht:h1:sp-w:tb3");

  // 3) Opening an image inside PeekOverlay hides PeekOverlay and closing the image restores PeekOverlay.
  setPeek("h1/hc:t4");
  openFileTab("h1/hc:t4", "peek.png", "peek.png");
  assert.equal(shellStore.get().peek, null);
  assert.equal(shellStore.get().active, "f:h1/hc:t4:peek.png");
  closeTab("f:h1/hc:t4:peek.png");
  assert.equal(shellStore.get().active, "ht:h1:sp-w:tb3");
  assert.equal(shellStore.get().peek, "h1/hc:t4");
  setPeek(null);

  // 4) reconcileHostHerdrDoc absorbing a standalone tab (`a:...` -> `ht:...`) remaps navHistoryBySpace cleanly.
  const freshAgent: Agent = {
    key: "h1/hc:t5",
    deviceId: h1,
    source: "hc",
    localId: "t5",
    harness: "codex",
    where: "work",
    cwd: "~/work",
    status: "idle",
    isShell: false,
    updatedAt: 6,
  };
  liveStore.set({ ...liveStore.get(), agents: { h1: [...agents, freshAgent] } });
  openAgentTab("h1/hc:t5", "term");
  openFileTab("h1/hc:t5", "after.png", "after.png");
  reconcileHostHerdrDoc(h1, {
    spaces: [
      {
        id: "sp-w",
        name: "work",
        folder: "~/work",
        tabs: [
          { id: "tb1", name: "T1", root: { id: "p1", type: "block", content: { terminal: "t1" } } },
          { id: "tb2", name: "T2", root: { id: "p2", type: "block", content: { terminal: "t2" } } },
          { id: "tb3", name: "T3", root: { id: "p3", type: "block", content: { terminal: "t3" } } },
          { id: "tb4", name: "T4", root: { id: "p4", type: "block", content: { terminal: "t4" } } },
          { id: "tb5", name: "T5", root: { id: "p5", type: "block", content: { terminal: "t5" } } },
        ],
      },
      {
        id: "sp-o",
        name: "other",
        folder: "~/other",
        tabs: [{ id: "tb-o1", name: "B1", root: { id: "po1", type: "block", content: { terminal: "b1" } } }],
      },
    ],
  }, undefined, spaces);
  closeTab("f:h1/hc:t5:after.png");
  assert.equal(shellStore.get().active, "ht:h1:sp-w:tb5");
});

test("split pane and synced-tab reconciliation preserve mountKey and stable leaf keys to avoid terminal flash", () => {
  const h1 = "h1";
  const spaces: SpaceInfo[] = [
    { id: "sp-new", name: "fresh-proj", folder: "~/work/fresh-proj", tabs: 1, terminals: 1, active: true },
    { id: "sp-old", name: "old-proj", folder: "~/work/old-proj", tabs: 1, terminals: 1 },
  ];
  const agents: Agent[] = [
    { key: "h1/hc:t1", deviceId: h1, source: "hc", localId: "t1", harness: "zsh", where: "fresh-proj", cwd: "~/work/fresh-proj", status: "idle", isShell: true, updatedAt: 10 },
    { key: "h1/hc:t2", deviceId: h1, source: "hc", localId: "t2", harness: "zsh", where: "fresh-proj", cwd: "~/work/fresh-proj", status: "idle", isShell: true, updatedAt: 9 },
  ];
  liveStore.set({
    link: "online",
    devices: { h1: { id: h1, name: "mac", kind: "host", platform: "darwin", online: true, createdAt: 1, lastSeenAt: 1 } },
    agents: { h1: agents },
    spaces: { h1: spaces },
    direct: {},
    rev: 1,
  });

  // 1) New Space creation focuses the new Space directly in terminal mode (`"term"`).
  setSelectedSpace(`${h1}\u0000fresh-proj`);
  openAgentTab("h1/hc:t1", "term", {
    followSpace: true,
    docMeta: { docHostId: h1, docSpaceId: "sp-new", docSpaceName: "fresh-proj", docTabId: "tb-fresh" },
  });
  let tab = shellStore.get().tabs.find((t) => t.id === "ht:h1:sp-new:tb-fresh")!;
  assert.ok(tab);
  assert.equal(tab.kind === "agent" ? tab.mode : undefined, "term");
  assert.equal(shellStore.get().selectedSpace, `${h1}\u0000fresh-proj`);

  const preSyncMountKey = tab.mountKey ?? tab.id;
  const preSplitLeafKeys = stableSplitLeafKeys(tabLeaves(tab));
  assert.deepEqual(preSplitLeafKeys, ["agent:h1/hc:t1"]);

  // 2) Reconciling with HerdrDoc assigns a real block id (`p1`) instead of `p0:...` without changing mountKey or leaf key.
  reconcileHostHerdrDoc(h1, {
    spaces: [
      { id: "sp-new", name: "fresh-proj", folder: "~/work/fresh-proj", tabs: [{ id: "tb-fresh", name: "", root: { id: "p1", type: "block", content: { terminal: "t1" } } }] },
    ],
  }, undefined, spaces);
  tab = shellStore.get().tabs.find((t) => t.id === "ht:h1:sp-new:tb-fresh")!;
  assert.equal(tab.mountKey ?? tab.id, preSyncMountKey);
  assert.deepEqual(stableSplitLeafKeys(tabLeaves(tab)), preSplitLeafKeys);

  // 3) Splitting 1 pane -> 2 panes -> 3 panes and collapsing back keeps pane 1's key 100% invariant.
  splitTabPane(tab.id, "p1", "right", { kind: "agent", agentKey: "h1/hc:t2", mode: "term" }, { newPaneId: "p2" });
  tab = shellStore.get().tabs.find((t) => t.id === "ht:h1:sp-new:tb-fresh")!;
  assert.equal(tab.mountKey ?? tab.id, preSyncMountKey);
  assert.deepEqual(stableSplitLeafKeys(tabLeaves(tab)), ["agent:h1/hc:t1", "agent:h1/hc:t2"]);

  // Simulate Herdr.app re-wrapping `p1` under a new split node ID during pane.split sync.
  reconcileHostHerdrDoc(h1, {
    spaces: [
      {
        id: "sp-new",
        name: "fresh-proj",
        folder: "~/work/fresh-proj",
        tabs: [
          {
            id: "tb-fresh",
            name: "",
            root: {
              id: "s1",
              type: "row",
              children: [
                { id: "p1_rebuilt", type: "block", size: { weight: 0.5 }, content: { terminal: "t1" } },
                { id: "p2_rebuilt", type: "block", size: { weight: 0.5 }, content: { terminal: "t2" } },
              ],
            },
          },
        ],
      },
    ],
  }, undefined, spaces);
  tab = shellStore.get().tabs.find((t) => t.id === "ht:h1:sp-new:tb-fresh")!;
  assert.equal(tab.mountKey ?? tab.id, preSyncMountKey);
  assert.deepEqual(stableSplitLeafKeys(tabLeaves(tab)), ["agent:h1/hc:t1", "agent:h1/hc:t2"]);

  // Closing the second pane keeps pane 1's mountKey & key stable.
  closeTabPane(tab.id, "p2_rebuilt");
  tab = shellStore.get().tabs.find((t) => t.id === "ht:h1:sp-new:tb-fresh")!;
  assert.equal(tab.mountKey ?? tab.id, preSyncMountKey);
  assert.deepEqual(stableSplitLeafKeys(tabLeaves(tab)), ["agent:h1/hc:t1"]);
});

test("renameSpaceInShellStore migrates selectedSpace, activeBySpace, panelBySpace, navHistoryBySpace, and docSpaceName atomically", () => {
  const h1 = "h1";
  const oldSpaceKey = `${h1}\u0000alpha`;
  const newSpaceKey = `${h1}\u0000renamed-alpha`;
  const agents: Agent[] = [
    { key: "h1/hc:t1", deviceId: h1, source: "hc", localId: "t1", harness: "zsh", where: "alpha", cwd: "~/work/alpha", status: "idle", isShell: true, updatedAt: 10 },
  ];
  liveStore.set({
    link: "online",
    devices: { h1: { id: h1, name: "mac", kind: "host", platform: "darwin", online: true, createdAt: 1, lastSeenAt: 1 } },
    agents: { h1: agents },
    spaces: { h1: [{ id: "sp-a", name: "alpha", folder: "~/work/alpha", tabs: 1, terminals: 1, active: true }] },
    direct: {},
    rev: 1,
  });

  reconcileHostHerdrDoc(h1, {
    spaces: [
      { id: "sp-a", name: "alpha", folder: "~/work/alpha", tabs: [{ id: "tb1", name: "", root: { id: "p1", type: "block", content: { terminal: "t1" } } }] },
    ],
  });
  setSelectedSpace(oldSpaceKey);
  togglePanel("files");
  openFileTab("h1/hc:t1", "README.md", "README.md", { spaceKey: oldSpaceKey });

  renameSpaceInShellStore(h1, "sp-a", "alpha", "renamed-alpha");

  const st = shellStore.get();
  assert.equal(st.selectedSpace, newSpaceKey);
  assert.equal(st.activeBySpace[oldSpaceKey], undefined);
  assert.equal(st.activeBySpace[newSpaceKey], "f:h1/hc:t1:README.md");
  assert.equal(st.panelBySpace?.[oldSpaceKey], undefined);
  assert.equal(st.panelBySpace?.[newSpaceKey], "files");
  assert.equal(st.navHistoryBySpace?.[oldSpaceKey], undefined);
  assert.deepEqual(st.navHistoryBySpace?.[newSpaceKey], ["ht:h1:sp-a:tb1", "f:h1/hc:t1:README.md"]);
  assert.equal(st.tabs.find((t) => t.id === "ht:h1:sp-a:tb1")?.docSpaceName, "renamed-alpha");
  const fileTab = st.tabs.find((t) => t.id === "f:h1/hc:t1:README.md");
  assert.equal(fileTab?.kind === "file" ? fileTab.spaceKey : undefined, newSpaceKey);
});

test("terminal stability and pane-header hover guards cap WebGL contexts and avoid subagent jump", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const termSrc = readFileSync(resolve(testDir, "../src/components/TerminalSurface.tsx"), "utf8");
  assert.equal(termSrc.includes("MAX_ACTIVE_WEBGL = 6"), true, "WebGL addon must be pooled and bounded by MAX_ACTIVE_WEBGL");
  assert.equal(termSrc.includes("onContextLoss"), true, "WebGL addon must detach cleanly on context loss");
  assert.equal(termSrc.includes("detachWebgl()"), true, "WebGL addon must detach when hidden or showing Kitty underlays");
  assert.equal(termSrc.includes("useLayoutEffect("), true, "TerminalSurface should use useLayoutEffect for synchronous tab-switch repaint");
  assert.equal(termSrc.includes("term.reset();\n            return connectLocal"), false, "connectLocal size drift should resize in place instead of term.reset()");

  const shellCss = readFileSync(resolve(testDir, "../src/styles/shell.css"), "utf8");
  const paneActionsBlock = /\.v3-pane-actions\s*\{[\s\S]*?\}/.exec(shellCss)?.[0] ?? "";
  assert.equal(paneActionsBlock.includes("display: inline-flex"), true);
  assert.equal(shellCss.includes(".v3-pane-actions {\n    display: none;"), false, "hover must not flip display:none -> inline-flex");

  const shellWork = readFileSync(resolve(testDir, "../src/shell/ShellWork.tsx"), "utf8");
  const paneRightIdx = shellWork.indexOf('<div className="v3-pane-right">');
  const paneRightEnd = shellWork.indexOf("<div className=\"v3-pane-actions\">", paneRightIdx);
  const paneRightSlice = shellWork.slice(paneRightIdx, paneRightEnd);
  const statusIdx = paneRightSlice.indexOf("<StatusMark");
  const subTriggerIdx = paneRightSlice.indexOf("<SubagentCatalogTrigger");
  assert.ok(statusIdx >= 0 && subTriggerIdx > statusIdx, "StatusMark must precede SubagentCatalogTrigger in PaneHead");

  const mockSrc = readFileSync(resolve(testDir, "../src/lib/mock.ts"), "utf8");
  assert.equal(mockSrc.includes('method === "agent.seen"'), true, "desktop mock mode should handle agent.seen done->idle transition");

  const inSplitBlock = /\.v3-row\.in-split\s*\{[\s\S]*?\}/.exec(shellCss)?.[0] ?? "";
  assert.equal(inSplitBlock.includes("background: transparent"), true, ".v3-row.in-split must not paint a second pink row selection");
  const sidebarSrc = readFileSync(resolve(testDir, "../src/shell/ShellSidebar.tsx"), "utf8");
  assert.equal(sidebarSrc.includes("activeTabIdForSpace("), true, "ShellSidebar must scope activeTab via activeTabIdForSpace");
  const desktopShellSrc = readFileSync(resolve(testDir, "../src/shell/DesktopShell.tsx"), "utf8");
  assert.equal(desktopShellSrc.includes('leaf.content.kind === "file" || leaf.content.kind === "diff"'), true, "Escape should close standalone file/diff preview tabs single-level");
});

test("file links require Ctrl/Cmd modifier and HTML FileViewer stays scroll-stable across agent ticks", () => {
  assert.equal(hasFileJumpModifier({ ctrlKey: false, metaKey: false }), false);
  assert.equal(hasFileJumpModifier({ ctrlKey: true, metaKey: false }), true);
  assert.equal(hasFileJumpModifier({ ctrlKey: false, metaKey: true }), true);

  const testDir = dirname(fileURLToPath(import.meta.url));
  const termSrc = readFileSync(resolve(testDir, "../src/components/TerminalSurface.tsx"), "utf8");
  assert.equal(termSrc.includes("hasFileJumpModifier(ev)"), true);
  assert.equal(termSrc.includes("pointerCursor: false"), true);

  const wbSrc = readFileSync(resolve(testDir, "../src/views/WorkbenchView.tsx"), "utf8");
  const fvStart = wbSrc.indexOf("export function FileViewer(");
  const fvEnd = wbSrc.indexOf("// Browser pane", fvStart);
  const fvSlice = wbSrc.slice(fvStart, fvEnd > fvStart ? fvEnd : undefined);
  assert.equal(/,\s*\[agent\s*(?:,|\])/.test(fvSlice), false, "FileViewer hooks must depend on primitive agent fields, not object identity");
  assert.equal(fvSlice.includes("capHtmlResolvedFor"), true, "HTML viewer must resolve capability URL before mounting iframe");
});

test("markdown viewer scales fluidly across ultrawide/narrow viewports and supports GFM alerts", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const appCss = readFileSync(resolve(testDir, "../src/styles/app.css"), "utf8");
  const viewerBlock = /\.viewer\s*\{[\s\S]*?\}/.exec(appCss)?.[0] ?? "";
  assert.equal(viewerBlock.includes("container-type: inline-size"), true);
  const viewerMdBlock = /\.viewer-md\s*\{[\s\S]*?\}/.exec(appCss)?.[0] ?? "";
  assert.equal(viewerMdBlock.includes("clamp(920px, 88cqi, 2240px)"), true);
  assert.equal(viewerMdBlock.includes("margin: 0 auto"), true);
  assert.equal(appCss.includes(".md-alert-tip"), true);
  assert.equal(appCss.includes(".md-table .md-file-chip"), true);

  const fpCss = readFileSync(resolve(testDir, "../src/styles/file-preview.css"), "utf8");
  assert.equal(fpCss.includes("clamp(820px, 86cqi, 1760px)"), true);

  const shellCss = readFileSync(resolve(testDir, "../src/styles/shell.css"), "utf8");
  assert.equal(shellCss.includes("@container (max-width: 680px)"), true);
  assert.equal(shellCss.includes(".v3-tab-layer.is-hidden"), true);
  assert.equal(shellCss.includes('data-split-animating="true"'), true);

  const mdSrc = readFileSync(resolve(testDir, "../src/lib/markdown.tsx"), "utf8");
  assert.equal(mdSrc.includes("md-alert-${kind}"), true);
});

test("shortcuts table matches Mod+/, Mod+., Mod+E, Mod+Alt+=, Mod+Shift+U and splitMotion defers settle callbacks", async () => {
  const mkEvent = (opts: { key: string; code?: string; altKey?: boolean; shiftKey?: boolean }) =>
    ({
      key: opts.key,
      code: opts.code ?? "",
      metaKey: IS_MAC,
      ctrlKey: !IS_MAC,
      altKey: Boolean(opts.altKey),
      shiftKey: Boolean(opts.shiftKey),
    }) as KeyboardEvent;

  assert.equal(matchShortcut(mkEvent({ key: "/", code: "Slash" })), "shortcutHelp");
  assert.equal(matchShortcut(mkEvent({ key: ".", code: "Period" })), "interruptAgent");
  assert.equal(matchShortcut(mkEvent({ key: "e" })), "togglePaneMode");
  assert.equal(matchShortcut(mkEvent({ key: "=", code: "Equal", altKey: true })), "equalizeSplits");
  assert.equal(matchShortcut(mkEvent({ key: "u", shiftKey: true })), "jumpUrgent");
  assert.deepEqual(formatEventKeyTokens(mkEvent({ key: "/", code: "Slash" })), ["Mod", "/"]);

  const prevWindow = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: unknown }).window = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    };
    beginSplitMotion(35);
    assert.equal(isSplitMotionActive(), true);
    let settled = false;
    onSplitMotionSettled(() => {
      settled = true;
    });
    assert.equal(settled, false);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(isSplitMotionActive(), false);
    assert.equal(settled, true);
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});
