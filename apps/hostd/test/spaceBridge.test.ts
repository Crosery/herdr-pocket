import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent, HerdrDoc, SpaceInfo } from "@herdr-pocket/protocol";
import {
  mergeHerdrWorkspacesIntoSpaces,
  syncCoreAgentsToHerdr,
  syncSpacesBidirectional,
  type SpaceBridgeCoreLike,
  type SpaceBridgeHerdrLike,
} from "../src/spaceBridge.ts";
import {
  HERDR_BRIDGE_SOURCE,
  HerdrAdapter,
  extractMirroredCoreAddr,
  toPaneAgentState,
  type HerdrAgentInfo,
  type HerdrPaneInfo,
  type HerdrWorkspaceInfo,
} from "../src/herdr.ts";
import { Host } from "../src/host.ts";

test("mergeHerdrWorkspacesIntoSpaces deduplicates by normalized name or folder and combines terminal counts", () => {
  const coreSpaces: SpaceInfo[] = [
    { id: "s1", name: "Backend", folder: "~/work/backend", tabs: 2, terminals: 1 },
    { id: "s2", name: "Frontend", folder: "~/work/frontend", tabs: 1, terminals: 2 },
  ];
  const herdrWorkspaces: HerdrWorkspaceInfo[] = [
    { id: "w1", label: "backend", folder: "~/work/backend", active: true, tabs: [{ id: "tb1", label: "api" }] },
    { id: "w2", label: "Web UI", folder: "~/work/frontend/", active: false, tabs: [{ id: "tb2", label: "web" }] },
    { id: "w3", label: "Mobile App", folder: "~/work/mobile", active: false, tabs: [{ id: "tb3", label: "rn" }, { id: "tb4", label: "ios" }] },
  ];
  const counts = new Map<string, number>([
    ["w1", 2],
    ["w2", 1],
    ["w3", 3],
  ]);

  const merged = mergeHerdrWorkspacesIntoSpaces(coreSpaces, herdrWorkspaces, counts);
  assert.equal(merged.length, 3);
  assert.equal(merged[0]?.id, "s1");
  assert.equal(merged[0]?.terminals, 3);
  assert.equal(merged[1]?.id, "s2");
  assert.equal(merged[1]?.terminals, 3);
  assert.deepEqual(merged[2], {
    id: "herdr:w3",
    name: "Mobile App",
    folder: "~/work/mobile",
    tabs: 2,
    terminals: 3,
  });
});

test("syncSpacesBidirectional mirrors missing spaces both ways and stays idempotent on repeat runs", async () => {
  let docVersion = 1;
  let docValue: HerdrDoc = {
    spaces: [
      { id: "s1", name: "Core Only", folder: "~/work/core-only", tabs: [] },
      { id: "s2", name: "Shared", folder: "~/work/shared", tabs: [] },
    ],
  };

  const core: SpaceBridgeCoreLike = {
    async docGet() {
      return { value: structuredClone(docValue), version: docVersion };
    },
    async docSetCas(_name, value, version) {
      assert.equal(version, docVersion);
      docValue = structuredClone(value as HerdrDoc);
      docVersion += 1;
      return { ok: true, version: docVersion };
    },
  };

  const herdrWorkspaces: HerdrWorkspaceInfo[] = [
    { id: "w1", label: "Shared", folder: "~/work/shared", active: true, tabs: [] },
    { id: "w2", label: "TUI Only", folder: "~/work/tui-only", active: false, tabs: [] },
  ];

  const createdInHerdr: Array<{ label: string; cwd?: string }> = [];
  const herdr: SpaceBridgeHerdrLike = {
    get workspaces() {
      return herdrWorkspaces;
    },
    async refreshWorkspaces() {
      return herdrWorkspaces;
    },
    async createWorkspace(label, cwd) {
      createdInHerdr.push({ label, cwd });
      const ws: HerdrWorkspaceInfo = { id: `w${herdrWorkspaces.length + 1}`, label, folder: cwd, active: false, tabs: [] };
      herdrWorkspaces.push(ws);
      return { id: ws.id, label };
    },
    async renameWorkspace() {},
  };

  const first = await syncSpacesBidirectional({ core, herdr, herdrAvailable: true, mirrorToHerdr: true });
  assert.deepEqual(first, { syncedToCore: 1, syncedToHerdr: 1, herdrAvailable: true });
  assert.equal(docValue.spaces?.some((s) => s.name === "TUI Only"), true);
  assert.deepEqual(createdInHerdr.map((x) => x.label), ["Core Only"]);

  // Second run must be completely idempotent (0 changes in either direction).
  const second = await syncSpacesBidirectional({ core, herdr, herdrAvailable: true, mirrorToHerdr: true });
  assert.deepEqual(second, { syncedToCore: 0, syncedToHerdr: 0, herdrAvailable: true });
});

test("syncSpacesBidirectional retries on CAS conflict without dropping concurrent core spaces and skips unnamed empty spaces", async () => {
  let docVersion = 1;
  let docValue: HerdrDoc = {
    spaces: [
      { id: "sp-empty", name: "", folder: "", tabs: [] },
      { id: "s1", name: "Core Alpha", folder: "~/work/alpha", tabs: [] },
    ],
  };
  let casCalls = 0;

  const core: SpaceBridgeCoreLike = {
    async docGet() {
      return { value: structuredClone(docValue), version: docVersion };
    },
    async docSetCas(_name, value, version) {
      casCalls += 1;
      if (casCalls === 1) {
        // Simulate Herdr.app concurrently adding another space before our CAS write landed.
        docVersion = 2;
        docValue = {
          spaces: [
            ...docValue.spaces,
            { id: "s2", name: "Concurrent Space", folder: "~/work/concurrent", tabs: [] },
          ],
        };
        return { ok: false, conflict: true, value: structuredClone(docValue), version: docVersion };
      }
      assert.equal(version, docVersion);
      docValue = structuredClone(value as HerdrDoc);
      docVersion += 1;
      return { ok: true, version: docVersion };
    },
  };

  const herdrWorkspaces: HerdrWorkspaceInfo[] = [
    { id: "w1", label: "TUI Beta", folder: join(homedir(), "work", "beta"), active: true, tabs: [] },
  ];
  const createdInHerdr: Array<{ label: string; cwd?: string }> = [];
  const herdr: SpaceBridgeHerdrLike = {
    get workspaces() {
      return herdrWorkspaces;
    },
    async refreshWorkspaces() {
      return herdrWorkspaces;
    },
    async createWorkspace(label, cwd) {
      createdInHerdr.push({ label, cwd });
      herdrWorkspaces.push({ id: `w${herdrWorkspaces.length + 1}`, label, folder: cwd, active: false, tabs: [] });
      return { id: `w${herdrWorkspaces.length}`, label };
    },
    async renameWorkspace() {},
  };

  const res = await syncSpacesBidirectional({ core, herdr, herdrAvailable: true, mirrorToHerdr: true });
  assert.equal(casCalls, 2);
  assert.deepEqual(res, { syncedToCore: 1, syncedToHerdr: 2, herdrAvailable: true });
  assert.deepEqual(
    docValue.spaces.map((s) => s.name),
    ["", "Core Alpha", "Concurrent Space", "TUI Beta"],
  );
  // Unnamed + folderless space ("sp-empty") must NEVER be mirrored to herdr as a raw-ID workspace.
  assert.deepEqual(
    createdInHerdr.map((x) => x.label),
    ["Core Alpha", "Concurrent Space"],
  );

  // Disabled / missing herdr returns zeros cleanly.
  const off = await syncSpacesBidirectional({ core, herdr, herdrAvailable: false, mirrorToHerdr: true });
  assert.deepEqual(off, { syncedToCore: 0, syncedToHerdr: 0, herdrAvailable: false });
});

test("mergeHerdrWorkspacesIntoSpaces deduplicates expanded home paths against tilde folders", () => {
  const coreSpaces: SpaceInfo[] = [
    { id: "s1", name: "Repo", folder: "~/work/demo-repo", tabs: 1, terminals: 1 },
  ];
  const herdrWorkspaces: HerdrWorkspaceInfo[] = [
    { id: "w1", label: "Different Label", folder: join(homedir(), "work", "demo-repo"), active: false, tabs: [] },
  ];
  const merged = mergeHerdrWorkspacesIntoSpaces(coreSpaces, herdrWorkspaces, new Map([["w1", 2]]));
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.terminals, 3);
});

/** Test double for `HerdrAdapter` that intercepts NDJSON socket calls in-memory. */
function makeFakeHerdrAdapter(initial?: {
  workspaces?: Array<Record<string, unknown>>;
  panes?: HerdrPaneInfo[];
  agents?: HerdrAgentInfo[];
}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const workspaces: Array<Record<string, unknown>> = initial?.workspaces ? structuredClone(initial.workspaces) : [];
  const panes: HerdrPaneInfo[] = initial?.panes ? structuredClone(initial.panes) : [];
  const agents: HerdrAgentInfo[] = initial?.agents ? structuredClone(initial.agents) : [];
  let tabSeq = 10;
  let paneSeq = 10;

  const adapter = new HerdrAdapter("/nonexistent/test.sock");
  adapter.call = async (method: string, params: unknown) => {
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    calls.push({ method, params: structuredClone(p) });

    if (method === "workspace.list") {
      return { type: "workspace_list", workspaces: structuredClone(workspaces) };
    }
    if (method === "workspace.create") {
      const wid = `w${workspaces.length + 1}`;
      const tid = `${wid}:t1`;
      const pid = `${wid}:p1`;
      const ws = {
        workspace_id: wid,
        number: workspaces.length + 1,
        label: String(p.label ?? wid),
        focused: Boolean(p.focus),
        pane_count: 1,
        tab_count: 1,
        active_tab_id: tid,
        agent_status: "unknown",
        ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
      };
      workspaces.push(ws);
      const rootPane: HerdrPaneInfo = {
        pane_id: pid,
        terminal_id: `term_${pid}`,
        workspace_id: wid,
        tab_id: tid,
        focused: Boolean(p.focus),
        agent_status: "unknown",
        cwd: typeof p.cwd === "string" ? p.cwd : null,
      };
      panes.push(rootPane);
      return {
        type: "workspace_created",
        workspace: ws,
        tab: { tab_id: tid, workspace_id: wid, number: 1, label: "1", focused: Boolean(p.focus), pane_count: 1, agent_status: "unknown" },
        root_pane: rootPane,
      };
    }
    if (method === "pane.list") {
      const wsFilter = typeof p.workspace_id === "string" ? p.workspace_id : null;
      return {
        type: "pane_list",
        panes: structuredClone(wsFilter ? panes.filter((x) => x.workspace_id === wsFilter) : panes),
      };
    }
    if (method === "agent.list") {
      return { type: "agent_list", agents: structuredClone(agents) };
    }
    if (method === "tab.create") {
      const wid = String(p.workspace_id ?? "w1");
      const tid = `${wid}:t${++tabSeq}`;
      const pid = `${wid}:p${++paneSeq}`;
      const rootPane: HerdrPaneInfo = {
        pane_id: pid,
        terminal_id: `term_${pid}`,
        workspace_id: wid,
        tab_id: tid,
        focused: Boolean(p.focus),
        agent_status: "unknown",
        cwd: typeof p.cwd === "string" ? p.cwd : null,
        tokens: {},
      };
      panes.push(rootPane);
      return {
        type: "tab_created",
        tab: {
          tab_id: tid,
          workspace_id: wid,
          number: tabSeq,
          label: String(p.label ?? "tab"),
          focused: Boolean(p.focus),
          pane_count: 1,
          agent_status: "unknown",
        },
        root_pane: rootPane,
      };
    }
    if (method === "pane.send_input") {
      return { type: "ok" };
    }
    if (method === "pane.report_metadata") {
      const hit = panes.find((x) => x.pane_id === p.pane_id);
      if (hit) {
        if (typeof p.title === "string") hit.title = p.title;
        if (typeof p.display_agent === "string") hit.display_agent = p.display_agent;
        if (p.tokens && typeof p.tokens === "object") {
          hit.tokens = { ...(hit.tokens ?? {}), ...(p.tokens as Record<string, string>) };
        }
      }
      return { type: "ok" };
    }
    if (method === "pane.report_agent") {
      const hit = panes.find((x) => x.pane_id === p.pane_id);
      if (hit) {
        if (typeof p.agent === "string") hit.agent = p.agent;
        if (typeof p.state === "string") hit.agent_status = p.state;
        if (Array.isArray(p.resume_argv)) hit.resume_argv = p.resume_argv as string[];
      }
      return { type: "ok" };
    }
    return { type: "ok" };
  };

  return { adapter, calls, workspaces, panes, agents };
}

function makeHcAgent(overrides: Partial<Agent> & { localId: string; harness: string }): Agent {
  const { localId, harness, ...rest } = overrides;
  return {
    key: `dev-1/hc:${localId}`,
    deviceId: "dev-1",
    source: "hc",
    localId,
    harness,
    status: "working",
    isShell: false,
    updatedAt: Date.now(),
    ...rest,
  };
}

test("syncCoreAgentsToHerdr mirrors non-shell hc agents via hc attach with focus:false and stays 100% idempotent", async () => {
  const { adapter, calls, panes } = makeFakeHerdrAdapter({
    workspaces: [
      { workspace_id: "w1", number: 1, label: "Backend", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "unknown", cwd: "~/work/backend" },
      { workspace_id: "w2", number: 2, label: "Frontend", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "unknown", cwd: "~/work/frontend" },
    ],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "unknown", cwd: "~/work/backend" },
      { pane_id: "w2:p1", terminal_id: "term_2", workspace_id: "w2", tab_id: "w2:t1", focused: false, agent_status: "unknown", cwd: "~/work/frontend" },
    ],
  });
  await adapter.refreshWorkspaces();

  const agents: Agent[] = [
    makeHcAgent({
      localId: "t10",
      harness: "claude-code",
      title: "Fix OAuth callback",
      where: "Backend / 1",
      cwd: "~/work/backend",
      status: "working",
    }),
    makeHcAgent({
      localId: "t11",
      harness: "codex",
      title: "Build dashboard",
      where: "Unmatched Label / 2",
      cwd: "~/work/frontend",
      status: "done",
    }),
    makeHcAgent({
      localId: "t12",
      harness: "zsh",
      title: "zsh",
      where: "Backend / 2",
      cwd: "~/work/backend",
      status: "idle",
      isShell: true,
    }),
  ];

  // First sync: mirrors t10 (matched by workspace name) and t11 (matched by folder), skips shell t12.
  const first = await syncCoreAgentsToHerdr({
    agents,
    herdrWorkspaces: adapter.workspaces,
    herdr: adapter,
    hcBin: "herdr-core",
  });
  assert.deepEqual(first, { syncedAgentsToHerdr: 2, updatedMirrors: 0 });

  const tabCreates = calls.filter((c) => c.method === "tab.create");
  assert.equal(tabCreates.length, 2);
  assert.equal(tabCreates[0]?.params.workspace_id, "w1");
  assert.equal(tabCreates[0]?.params.focus, false);
  assert.deepEqual(tabCreates[0]?.params.env, { HERDR_POCKET_CORE_ADDR: "t10" });
  assert.equal(tabCreates[1]?.params.workspace_id, "w2");
  assert.equal(tabCreates[1]?.params.focus, false);
  assert.deepEqual(tabCreates[1]?.params.env, { HERDR_POCKET_CORE_ADDR: "t11" });

  const sendInputs = calls.filter((c) => c.method === "pane.send_input");
  assert.equal(sendInputs.length, 2);
  assert.equal(sendInputs[0]?.params.text, "exec herdr-core attach t10 --history 200");
  assert.deepEqual(sendInputs[0]?.params.keys, ["enter"]);
  assert.equal(sendInputs[1]?.params.text, "exec herdr-core attach t11 --history 200");
  assert.deepEqual(sendInputs[1]?.params.keys, ["enter"]);

  const metaReports = calls.filter((c) => c.method === "pane.report_metadata");
  assert.equal(metaReports.length, 2);
  assert.equal(metaReports[0]?.params.source, HERDR_BRIDGE_SOURCE);
  assert.equal(metaReports[0]?.params.display_agent, "claude-code");
  assert.equal(metaReports[0]?.params.title, "Fix OAuth callback");
  assert.deepEqual(metaReports[0]?.params.tokens, { core_addr: "t10" });
  assert.equal(metaReports[0]?.params.ttl_ms, 86_400_000);

  const agentReports = calls.filter((c) => c.method === "pane.report_agent");
  assert.equal(agentReports.length, 2);
  assert.equal(agentReports[0]?.params.source, HERDR_BRIDGE_SOURCE);
  assert.equal(agentReports[0]?.params.agent, "claude-code");
  assert.equal(agentReports[0]?.params.state, "working");
  assert.deepEqual(agentReports[0]?.params.resume_argv, ["herdr-core", "attach", "t10", "--history", "200"]);
  // `done` must map onto valid `PaneAgentState` enum (`idle`).
  assert.equal(agentReports[1]?.params.state, "idle");
  assert.deepEqual(agentReports[1]?.params.resume_argv, ["herdr-core", "attach", "t11", "--history", "200"]);

  // Second run with identical state: 100% idempotent (0 new tabs, 0 redundant metadata reports).
  const callsBeforeSecond = calls.length;
  const second = await syncCoreAgentsToHerdr({
    agents,
    herdrWorkspaces: adapter.workspaces,
    herdr: adapter,
    hcBin: "herdr-core",
  });
  assert.deepEqual(second, { syncedAgentsToHerdr: 0, updatedMirrors: 0 });
  assert.equal(
    calls.slice(callsBeforeSecond).filter((c) => c.method === "tab.create" || c.method === "pane.send_input" || c.method === "pane.report_agent").length,
    0,
  );

  // Third run after t10 status & title change: updates metadata ONLY, never creates a duplicate tab!
  const callsBeforeThird = calls.length;
  const updatedAgents: Agent[] = [
    { ...agents[0]!, status: "blocked", title: "Fix OAuth callback (confirm)", statusNote: "Approve migration?" },
    agents[1]!,
    agents[2]!,
  ];
  const third = await syncCoreAgentsToHerdr({
    agents: updatedAgents,
    herdrWorkspaces: adapter.workspaces,
    herdr: adapter,
    hcBin: "herdr-core",
  });
  assert.deepEqual(third, { syncedAgentsToHerdr: 0, updatedMirrors: 1 });
  const thirdCalls = calls.slice(callsBeforeThird);
  assert.equal(thirdCalls.filter((c) => c.method === "tab.create" || c.method === "pane.send_input").length, 0);
  const thirdAgentReport = thirdCalls.find((c) => c.method === "pane.report_agent");
  assert.equal(thirdAgentReport?.params.state, "blocked");
  assert.equal(thirdAgentReport?.params.message, "Approve migration?");

  // Post-restart discovery: a brand-new HerdrAdapter with empty in-memory maps still finds mirrored panes via `pane.list` tokens.
  const fresh = makeFakeHerdrAdapter({
    workspaces: [
      { workspace_id: "w1", number: 1, label: "Backend", focused: true, pane_count: 2, tab_count: 2, active_tab_id: "w1:t1", agent_status: "unknown", cwd: "~/work/backend" },
      { workspace_id: "w2", number: 2, label: "Frontend", focused: false, pane_count: 2, tab_count: 2, active_tab_id: "w2:t1", agent_status: "unknown", cwd: "~/work/frontend" },
    ],
    panes,
  });
  await fresh.adapter.refreshWorkspaces();
  const afterRestart = await syncCoreAgentsToHerdr({
    agents: [
      { ...agents[0]!, status: "blocked", title: "Fix OAuth callback (confirm)" },
      agents[1]!,
    ],
    herdrWorkspaces: fresh.adapter.workspaces,
    herdr: fresh.adapter,
    hcBin: "herdr-core",
  });
  assert.deepEqual(afterRestart, { syncedAgentsToHerdr: 0, updatedMirrors: 0 });
  assert.equal(fresh.calls.filter((c) => c.method === "tab.create").length, 0);
});

test("syncCoreAgentsToHerdr updateExistingOnly refreshes existing mirrors without spawning new tabs", async () => {
  const { adapter, calls } = makeFakeHerdrAdapter({
    workspaces: [
      { workspace_id: "w1", number: 1, label: "Backend", focused: true, pane_count: 2, tab_count: 2, active_tab_id: "w1:t1", agent_status: "unknown", cwd: "~/work/backend" },
    ],
    panes: [
      {
        pane_id: "w1:p2",
        terminal_id: "term_mirrored",
        workspace_id: "w1",
        tab_id: "w1:t2",
        agent: "claude-code",
        display_agent: "claude-code",
        title: "Old title",
        agent_status: "working",
        tokens: { core_addr: "t10" },
      },
    ],
  });
  await adapter.refreshWorkspaces();

  const res = await syncCoreAgentsToHerdr({
    agents: [
      makeHcAgent({ localId: "t10", harness: "claude-code", title: "New title", where: "Backend / 1", status: "idle" }),
      makeHcAgent({ localId: "t99", harness: "codex", title: "Unmirrored", where: "Backend / 2", status: "working" }),
    ],
    herdrWorkspaces: adapter.workspaces,
    herdr: adapter,
    hcBin: "hc",
    updateExistingOnly: true,
  });
  assert.deepEqual(res, { syncedAgentsToHerdr: 0, updatedMirrors: 1 });
  assert.equal(calls.filter((c) => c.method === "tab.create" || c.method === "pane.send_input").length, 0);
  assert.equal(calls.filter((c) => c.method === "pane.report_agent").length, 1);
});

test("isMirroredCoreAgent prevents Host.collect() from double-listing mirrored herdr panes while keeping native herdr agents", () => {
  const host = new Host({
    config: { server: "http://127.0.0.1:1", token: "tok", deviceId: "dev-1", name: "test-host" },
    log: () => {},
  });

  // Live hc terminal t42
  host.hc.terminals.set("t42", {
    address: "t42",
    argv: ["claude"],
    cwd: "/tmp/proj",
    state: "live",
    status: { app: "claude-code", state: "working" },
    title: "Implement sync",
    labels: { "herdr.space": "Backend", "herdr.tab": "1" },
  });

  // Two herdr agents:
  // 1) Mirror of hc:t42 (identified via tokens.core_addr)
  // 2) Mirror of hc:t42 (identified via in-memory mirroredPaneIds)
  // 3) Native herdr agent (not mirrored) -> must remain visible
  // 4) Stale mirror of non-live hc:t999 -> must remain visible when hc terminal is not live
  const mirroredByToken: HerdrAgentInfo = {
    terminal_id: "ht_1",
    pane_id: "w1:p2",
    workspace_id: "w1",
    tab_id: "w1:t2",
    agent: "claude-code",
    display_agent: "claude-code",
    title: "Implement sync",
    agent_status: "working",
    tokens: { core_addr: "t42" },
  };
  const mirroredByMemory: HerdrAgentInfo = {
    terminal_id: "ht_2",
    pane_id: "w1:p3",
    workspace_id: "w1",
    tab_id: "w1:t3",
    agent: "claude-code",
    title: "Implement sync",
    agent_status: "working",
  };
  host.herdr.mirroredCorePaneMap.set("t42", "w1:p3");
  host.herdr.mirroredPaneIds.add("w1:p3");

  const nativeHerdr: HerdrAgentInfo = {
    terminal_id: "ht_3",
    pane_id: "w1:p4",
    workspace_id: "w1",
    tab_id: "w1:t4",
    agent: "codex",
    title: "Native TUI session",
    agent_status: "idle",
  };
  const orphanMirror: HerdrAgentInfo = {
    terminal_id: "ht_4",
    pane_id: "w1:p5",
    workspace_id: "w1",
    tab_id: "w1:t5",
    agent: "codex",
    title: "Detached mirror",
    agent_status: "idle",
    tokens: { core_addr: "t999" },
  };

  assert.equal(host.herdr.isMirroredCoreAgent(mirroredByToken), true);
  assert.equal(host.herdr.isMirroredCoreAgent(mirroredByMemory), true);
  assert.equal(host.herdr.isMirroredCoreAgent(nativeHerdr), false);
  assert.equal(host.herdr.isMirroredCoreAgent(orphanMirror), true);

  host.herdr.agents = [mirroredByToken, mirroredByMemory, nativeHerdr, orphanMirror];
  const collected = host.collect();
  const keys = collected.map((a) => a.key);

  assert.equal(keys.includes("dev-1/hc:t42"), true);
  assert.equal(keys.includes("dev-1/herdr:ht_1"), false);
  assert.equal(keys.includes("dev-1/herdr:ht_2"), false);
  assert.equal(keys.includes("dev-1/herdr:ht_3"), true);
  assert.equal(keys.includes("dev-1/herdr:ht_4"), true);

  // Also verify command/resume_argv/agent_session fallback extraction.
  assert.equal(extractMirroredCoreAddr({ command: "exec hc attach mac/t7 --history 200" }), "mac/t7");
  assert.equal(extractMirroredCoreAddr({ resume_argv: ["herdr-core", "attach", "t88", "--history", "200"] }), "t88");
  assert.equal(
    extractMirroredCoreAddr({ agent_session: { source: HERDR_BRIDGE_SOURCE, agent: "claude", kind: "id", value: "t77" } }),
    "t77",
  );
  assert.equal(toPaneAgentState("done"), "idle");
  assert.equal(toPaneAgentState("working"), "working");
  assert.equal(toPaneAgentState("blocked"), "blocked");
  assert.equal(toPaneAgentState("weird"), "unknown");
});

test("attachCoreTerminalInPane rejects shell-injection addresses and quotes hcBin safely", async () => {
  const { adapter, calls } = makeFakeHerdrAdapter();

  for (const badAddr of [
    "",
    "t1; rm -rf /",
    "t1 $(whoami)",
    "t1 `id`",
    "t1 && echo pwned",
    "t1\nid",
    "t1 | cat /etc/passwd",
    "-observe",
  ]) {
    await assert.rejects(
      () =>
        adapter.attachCoreTerminalInPane({
          paneId: "w1:p2",
          hcBin: "herdr-core",
          address: badAddr,
          harness: "claude-code",
        }),
      /invalid herdr-core terminal address/i,
    );
  }
  assert.equal(calls.length, 0);

  // `syncCoreAgentsToHerdr` also skips invalid addresses without creating tabs.
  const skipped = await syncCoreAgentsToHerdr({
    agents: [makeHcAgent({ localId: "t1; touch /tmp/x", harness: "claude-code", where: "Backend / 1" })],
    herdrWorkspaces: [{ id: "w1", label: "Backend", tabs: [] }],
    herdr: adapter,
    hcBin: "herdr-core",
  });
  assert.deepEqual(skipped, { syncedAgentsToHerdr: 0, updatedMirrors: 0 });
  assert.equal(calls.length, 0);

  // Valid address with spaced hcBin path: shell-quoted for `exec`, plain basename for `resume_argv[0]`.
  await adapter.attachCoreTerminalInPane({
    paneId: "w1:p9",
    hcBin: "/Applications/Herdr Core/herdr-core",
    address: "mac/t42",
    harness: "claude-code",
    title: "Safe attach",
    state: "working",
  });
  const sendCall = calls.find((c) => c.method === "pane.send_input");
  assert.equal(sendCall?.params.text, "exec '/Applications/Herdr Core/herdr-core' attach mac/t42 --history 200");
  const reportCall = calls.find((c) => c.method === "pane.report_agent");
  assert.deepEqual(reportCall?.params.resume_argv, ["herdr-core", "attach", "mac/t42", "--history", "200"]);

  // Workspace creation always passes focus:false and extracts nested `workspace.workspace_id`.
  const createdWs = await adapter.createWorkspace("New Space", "~/work/demo");
  const wsCreateCall = calls.find((c) => c.method === "workspace.create");
  assert.equal(wsCreateCall?.params.focus, false);
  assert.equal(createdWs.id, "w1");
});

test("Host spaces.sync RPC performs bidirectional space + agent sync without duplicates or kills", async () => {
  const host = new Host({
    config: { server: "http://127.0.0.1:1", token: "tok", deviceId: "dev-1", name: "test-host" },
    log: () => {},
  });
  host.sources = ["hc", "herdr", "uniflo"];

  let docVersion = 1;
  let docValue: HerdrDoc = {
    spaces: [{ id: "s1", name: "Backend", folder: "~/work/backend", tabs: [] }],
  };

  host.hc.terminals.set("t10", {
    address: "t10",
    argv: ["claude"],
    cwd: join(homedir(), "work", "backend"),
    state: "live",
    status: { app: "claude-code", state: "working" },
    title: "Core agent",
    labels: { "herdr.space": "Backend", "herdr.tab": "1" },
  });
  host.hc.list = async () => {};
  host.hc.docGet = async () => ({ value: structuredClone(docValue), version: docVersion });
  host.hc.docSetCas = async (_name, value, version) => {
    assert.equal(version, docVersion);
    docValue = structuredClone(value as HerdrDoc);
    docVersion += 1;
    return { ok: true, version: docVersion };
  };

  const fake = makeFakeHerdrAdapter({
    workspaces: [
      { workspace_id: "w1", number: 1, label: "Backend", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "w1:t1", agent_status: "unknown", cwd: "~/work/backend" },
      { workspace_id: "w2", number: 2, label: "TUI Space", focused: false, pane_count: 1, tab_count: 1, active_tab_id: "w2:t1", agent_status: "unknown", cwd: "~/work/tui" },
    ],
    panes: [
      { pane_id: "w1:p1", terminal_id: "term_1", workspace_id: "w1", tab_id: "w1:t1", cwd: "~/work/backend", agent_status: "unknown" },
      { pane_id: "w2:p1", terminal_id: "term_native", workspace_id: "w2", tab_id: "w2:t1", cwd: "~/work/tui", agent_status: "idle" },
    ],
    agents: [
      {
        terminal_id: "term_native",
        pane_id: "w2:p1",
        workspace_id: "w2",
        tab_id: "w2:t1",
        agent: "codex",
        title: "Native TUI agent",
        agent_status: "idle",
        cwd: homedir(),
      },
    ],
  });
  host.herdr = fake.adapter;

  const resumedSessions: string[] = [];
  host.uniflo.enrich = (list) =>
    list.map((a) => (a.source === "herdr" && a.localId === "term_native" ? { ...a, sessionKey: "codex:native-1" } : a));
  host.uniflo.resume = async (sessionKey: string) => {
    resumedSessions.push(sessionKey);
    return { supported: true, argv: ["codex", "resume", "native-1"], cwd: homedir() };
  };

  const openedInCore: Array<{ space?: string; folder?: string; argv: string[] }> = [];
  host.app.spaces = async () =>
    docValue.spaces.map((s) => ({ id: s.id, name: s.name, folder: s.folder, tabs: s.tabs.length, terminals: 0 }));
  host.app.names = async () => ({ spaces: new Map(), tabs: new Map(), terminals: new Map() });
  host.app.open = async (opts) => {
    openedInCore.push({ space: opts.space, folder: opts.folder, argv: opts.argv });
    const termId = `t_resumed_${openedInCore.length}`;
    host.hc.terminals.set(termId, {
      address: termId,
      argv: opts.argv,
      cwd: opts.folder ?? homedir(),
      state: "live",
      status: { app: "codex", state: "idle" },
      title: "Resumed native agent",
      labels: { "herdr.space": "TUI Space", "herdr.tab": "1" },
    });
    return { space: opts.space ?? "s_new", tab: "tb1", terminal: termId };
  };
  (host as unknown as { installed(): Promise<string[]> }).installed = async () => ["codex", "claude"];

  const callRpc = async (params: Record<string, unknown>) => {
    let replyFrame: Record<string, unknown> | null = null;
    await (
      host as unknown as {
        handleRpc(f: unknown, reply: (x: Record<string, unknown>) => void): Promise<void>;
      }
    ).handleRpc({ type: "rpc", id: "sync-1", from: "viewer-1", method: "spaces.sync", params }, (x) => {
      replyFrame = x;
    });
    assert.ok(replyFrame);
    assert.equal((replyFrame as Record<string, unknown>).type, "rpc_result");
    return (replyFrame as Record<string, unknown>).result as {
      syncedToCore: number;
      syncedToHerdr: number;
      syncedAgentsToHerdr?: number;
      migratedAgents: number;
      herdrAvailable: boolean;
      spaces: SpaceInfo[];
    };
  };

  // First sync: mirrors TUI Space -> Core, mirrors hc:t10 -> Herdr, resumes native Herdr agent -> Core.
  const first = await callRpc({ mode: "sync" });
  assert.equal(first.herdrAvailable, true);
  assert.equal(first.syncedToCore, 1);
  assert.equal(first.syncedToHerdr, 0);
  assert.equal(first.syncedAgentsToHerdr, 1);
  assert.equal(first.migratedAgents, 1);
  assert.deepEqual(resumedSessions, ["codex:native-1"]);
  assert.equal(openedInCore.length, 1);
  assert.equal(fake.calls.some((c) => /close|kill/i.test(c.method)), false);

  // Mark the resumed core terminal as owning codex:native-1 in uniflo enrich so repeat sync sees it live.
  host.uniflo.enrich = (list) =>
    list.map((a) =>
      (a.source === "herdr" && a.localId === "term_native") || a.localId === "t_resumed_1"
        ? { ...a, sessionKey: "codex:native-1" }
        : a,
    );

  // Second sync: 100% idempotent — neither t10 (already mirrored) nor t_resumed_1 (same session as native herdr pane) is duplicated!
  const callsBeforeSecond = fake.calls.length;
  const second = await callRpc({ mode: "sync" });
  assert.equal(second.syncedToCore, 0);
  assert.equal(second.syncedToHerdr, 0);
  assert.equal(second.syncedAgentsToHerdr, 0);
  assert.equal(second.migratedAgents, 0);
  assert.equal(
    fake.calls.slice(callsBeforeSecond).filter((c) => c.method === "tab.create" || c.method === "pane.send_input").length,
    0,
  );
  assert.equal(fake.calls.some((c) => /close|kill/i.test(c.method)), false);

  // spaces_only mode skips agent sync completely.
  const callsBeforeSpacesOnly = fake.calls.length;
  const spacesOnly = await callRpc({ mode: "spaces_only" });
  assert.equal(spacesOnly.syncedAgentsToHerdr, 0);
  assert.equal(spacesOnly.migratedAgents, 0);
  assert.equal(
    fake.calls.slice(callsBeforeSpacesOnly).filter((c) => c.method === "tab.create" || c.method === "pane.send_input").length,
    0,
  );
});
