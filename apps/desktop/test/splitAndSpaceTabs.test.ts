import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import type { Agent, Device, HerdrDoc, SpaceInfo } from "@herdr-pocket/protocol";
import { liveStore } from "../src/lib/store.ts";
import { canActOnLocalFile, revealInFolderLabel } from "../src/lib/localFileActions.ts";
import { tierFor } from "../src/lib/layout.ts";
import { extractHostHerdrDoc, formatHerdrTabLabel, splitNodeToHerdrRoot } from "../src/shell/herdrDoc.ts";
import {
  clearPendingSplitPlacements,
  createHerdrDocSyncController,
  registerPendingSplitPlacement,
  type HerdrDocTransport,
} from "../src/shell/herdrDocSync.ts";
import {
  activeTabIdForSpace,
  openAgentTab,
  openDiffTab,
  openFileTab,
  openWebTab,
  reconcileHostHerdrDoc,
  refreshHostDocSpaceNames,
  setActiveTab,
  setSelectedSpace,
  shellStore,
  splitActivePaneWithContent,
  splitTabPane,
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
    panel: null,
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

  assert.match(shellSrc, /MAX_KEPT_AGENT_TABS\s*=\s*12/);
  assert.match(shellSrc, /v3-pane-tool-btn/);
  assert.match(css, /\.v3-tab\s*\{[\s\S]*min-width:\s*78px;[\s\S]*max-width:\s*210px;/);
  assert.match(css, /@media \(hover: hover\)[\s\S]*\.v3-tab:not\(\.active\):not\(:hover\):not\(:focus-within\) \.v3-tab-x/);
  assert.doesNotMatch(termSrc, /reattachLocalRef\.current\(\)/);
  assert.match(termSrc, /resizeSettleTimer\s*=\s*window\.setTimeout\(/);
  assert.match(appSrc, /useViewportTier\(\)/);
  // Outside Tauri, < 860px collapses to mobile tier as documented.
  assert.equal(tierFor(780), "mobile");
});
