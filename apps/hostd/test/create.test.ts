import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HerdrApp, NoDesktopApp } from "../src/create.ts";
import type { HcTerminal } from "../src/hc.ts";
import { Host } from "../src/host.ts";

const tmp = mkdtempSync(join(tmpdir(), "herdr-pocket-close-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const missingAppBin = join(tmp, "missing-herdr-app");

test("HerdrApp.closeAgentTerminal with open Herdr.app calls tab.close, clears labels first, kills & rms un-kept children", async () => {
  const app = new HerdrApp(missingAppBin);
  const events: string[] = [];
  const cmdCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  app.command = async (cmd, args) => {
    cmdCalls.push({ cmd, args });
    events.push(`cmd:${cmd}:${String(args.id ?? "")}`);
    return null;
  };

  const terms = new Map<string, HcTerminal>([
    ["t1", { address: "t1", labels: { "herdr.space": "sp1", "herdr.tab": "tb1", where: "work / main" } }],
    ["t1-sub", { address: "t1-sub", parent: "t1", labels: {} }],
    ["t1-sub2", { address: "t1-sub2", parent: "t1-sub", labels: { where: "sub" } }],
    ["t1-kept", { address: "t1-kept", parent: "t1", labels: { "herdr.space": "sp1", "herdr.tab": "tb2" } }],
    ["t2", { address: "t2", labels: { "herdr.space": "sp1", "herdr.tab": "tb2" } }],
  ]);

  const res = await app.closeAgentTerminal(
    { localId: "t1" },
    {
      terminals: terms,
      label: async (addr, labels) => {
        events.push(`label:${addr}:${JSON.stringify(labels)}`);
      },
      kill: async (addr) => {
        events.push(`kill:${addr}`);
      },
      rm: async (addr) => {
        events.push(`rm:${addr}`);
      },
    },
  );

  assert.deepEqual(res, { closedTab: true, closedTerminals: 3 });
  assert.deepEqual(cmdCalls, [{ cmd: "tab.close", args: { id: "tb1", confirmed: true } }]);

  const labelEvents = events.filter((e) => e.startsWith("label:"));
  const killEvents = events.filter((e) => e.startsWith("kill:"));
  const rmEvents = events.filter((e) => e.startsWith("rm:"));
  assert.equal(labelEvents.length, 3);
  assert.deepEqual(killEvents.sort(), ["kill:t1", "kill:t1-sub", "kill:t1-sub2"]);
  assert.deepEqual(rmEvents.sort(), ["rm:t1", "rm:t1-sub", "rm:t1-sub2"]);

  // Labels must be cleared before any kill, and each kill must precede its rm.
  const maxLabelIdx = Math.max(...labelEvents.map((e) => events.indexOf(e)));
  const minKillIdx = Math.min(...killEvents.map((e) => events.indexOf(e)));
  assert.ok(maxLabelIdx < minKillIdx, "labels must be cleared before kill");
  for (const addr of ["t1", "t1-sub", "t1-sub2"]) {
    assert.ok(events.indexOf(`kill:${addr}`) < events.indexOf(`rm:${addr}`), `kill before rm for ${addr}`);
  }
  assert.equal(events.some((e) => e.includes("t1-kept") || e.includes(":t2")), false);
});

test("HerdrApp.closeAgentTerminal with closed Herdr.app removes tab from herdr-app doc, updates activeTabId, and kills/rms children", async () => {
  const app = new HerdrApp(missingAppBin);
  app.command = async () => {
    throw new NoDesktopApp();
  };

  let saved: { name: string; version: number; value: any } | null = null;
  const killed: string[] = [];
  const removed: string[] = [];
  const labeled: Array<{ addr: string; labels: Record<string, string> }> = [];

  const docState = {
    version: 11,
    value: {
      activeSpaceId: "sp1",
      activeTabId: "tb1",
      spaces: [
        {
          id: "sp1",
          name: "Work",
          activeTabId: "tb1",
          tabs: [
            {
              id: "tb1",
              name: "1",
              active: true,
              root: { id: "r1", type: "row", children: [{ id: "b1", type: "block", content: { terminal: "t1" } }] },
            },
            {
              id: "tb2",
              name: "2",
              root: { id: "r2", type: "row", children: [{ id: "b2", type: "block", content: { terminal: "t2" } }] },
            },
          ],
        },
      ],
    },
  };

  const terms = new Map<string, HcTerminal>([
    ["t1", { address: "t1", labels: { "herdr.space": "sp1", "herdr.tab": "tb1", where: "Work / 1" } }],
    ["t1-sub", { address: "t1-sub", parent: "t1", labels: {} }],
    ["t2", { address: "t2", labels: { "herdr.space": "sp1", "herdr.tab": "tb2", where: "Work / 2" } }],
  ]);

  const res = await app.closeAgentTerminal(
    { localId: "t1" },
    {
      terminals: terms,
      docGet: async () => docState,
      docSet: async (name, value, version) => {
        saved = { name, value, version };
        return version + 1;
      },
      label: async (addr, labels) => {
        labeled.push({ addr, labels });
      },
      kill: async (addr) => {
        killed.push(addr);
      },
      rm: async (addr) => {
        removed.push(addr);
      },
    },
  );

  assert.deepEqual(res, { closedTab: true, closedTerminals: 2 });
  assert.ok(saved);
  const wrote = saved as { name: string; version: number; value: any };
  assert.equal(wrote.name, "herdr-app");
  assert.equal(wrote.version, 11);
  assert.deepEqual(wrote.value.spaces[0].tabs.map((t: any) => t.id), ["tb2"]);
  assert.equal(wrote.value.spaces[0].activeTabId, "tb2");
  assert.equal(wrote.value.spaces[0].tabs[0].active, true);
  assert.equal(wrote.value.activeTabId, "tb2");
  assert.deepEqual(killed.sort(), ["t1", "t1-sub"]);
  assert.deepEqual(removed.sort(), ["t1", "t1-sub"]);
  assert.equal(labeled.some((x) => x.addr === "t1" && x.labels["herdr.tab"] === "" && x.labels.where === ""), true);
});

test("HerdrApp.closeAgentTerminal on split-pane tab keeps sibling terminal alive (closed & open Herdr.app)", async () => {
  // 1) Closed Herdr.app: prunes only doomed terminal from tab.root and tab.terminals, preserving sibling t2.
  const closedApp = new HerdrApp(missingAppBin);
  closedApp.command = async () => {
    throw new Error("桌面 herdr 没有打开，先在电脑上打开它");
  };

  let savedClosed: any = null;
  const killedClosed: string[] = [];
  const removedClosed: string[] = [];
  const docClosed = {
    version: 4,
    value: {
      spaces: [
        {
          id: "sp1",
          name: "Work",
          activeTabId: "tb-split",
          tabs: [
            {
              id: "tb-split",
              name: "Split",
              root: {
                id: "r1",
                type: "row",
                children: [
                  { id: "p1", type: "block", content: { terminal: "t1" } },
                  { id: "p2", type: "block", content: { terminal: "t2" } },
                ],
              },
              terminals: [{ terminal: "t1" }, { terminal: "t2" }],
            },
          ],
        },
      ],
    },
  };

  const splitTerms = new Map<string, HcTerminal>([
    ["t1", { address: "t1", labels: { "herdr.space": "sp1", "herdr.tab": "tb-split", where: "Work / Split" } }],
    ["t1-sub", { address: "t1-sub", parent: "t1", labels: { "herdr.tab": "tb-split" } }],
    ["t2", { address: "t2", labels: { "herdr.space": "sp1", "herdr.tab": "tb-split", where: "Work / Split" } }],
  ]);

  const resClosed = await closedApp.closeAgentTerminal(
    { localId: "t1" },
    {
      terminals: splitTerms,
      docGet: async () => docClosed,
      docSet: async (_name, value) => {
        savedClosed = value;
        return 5;
      },
      kill: async (addr) => {
        killedClosed.push(addr);
      },
      rm: async (addr) => {
        removedClosed.push(addr);
      },
    },
  );

  assert.deepEqual(resClosed, { closedTab: false, closedTerminals: 2 });
  assert.ok(savedClosed);
  assert.equal(savedClosed.spaces[0].tabs.length, 1);
  assert.equal(savedClosed.spaces[0].activeTabId, "tb-split");
  assert.deepEqual(savedClosed.spaces[0].tabs[0].root.children, [{ id: "p2", type: "block", content: { terminal: "t2" } }]);
  assert.deepEqual(savedClosed.spaces[0].tabs[0].terminals, [{ terminal: "t2" }]);
  assert.deepEqual(killedClosed.sort(), ["t1", "t1-sub"]);
  assert.deepEqual(removedClosed.sort(), ["t1", "t1-sub"]);

  // 2) Open Herdr.app: calls pane.close for t1's pane instead of tab.close.
  const openApp = new HerdrApp(missingAppBin);
  const openCmds: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  openApp.ls = async () => ({
    spaces: [
      {
        id: "sp1",
        name: "Work",
        tabs: [
          {
            id: "tb-split",
            name: "Split",
            terminals: [
              { terminal: "t1", pane: "pane-1" },
              { terminal: "t2", pane: "pane-2" },
            ],
          },
        ],
      },
    ],
  });
  openApp.command = async (cmd, args) => {
    openCmds.push({ cmd, args });
    return null;
  };
  const killedOpen: string[] = [];
  const resOpen = await openApp.closeAgentTerminal(
    { localId: "t1" },
    {
      terminals: splitTerms,
      kill: async (addr) => {
        killedOpen.push(addr);
      },
    },
  );

  assert.deepEqual(resOpen, { closedTab: false, closedTerminals: 2 });
  assert.deepEqual(openCmds, [{ cmd: "pane.close", args: { pane: "pane-1" } }]);
  assert.deepEqual(killedOpen.sort(), ["t1", "t1-sub"]);
});

test("Host terminal.kill uses closeAgentTerminal, falls back cleanly, refreshes/publishes immediately, and supports herdr pane.close", async () => {
  type Handlers = Record<string, (p: unknown, from: string) => Promise<any>>;
  const h = new Host({
    config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" },
    log: () => {},
  });
  const x = h as unknown as { handlers: Handlers; refreshNames: () => Promise<void>; publishNow: () => void };

  h.hc.terminals.set("t1", { address: "t1", status: { app: "codex", state: "idle" }, labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } });
  h.hc.terminals.set("t2", { address: "t2", status: { app: "claude-code", state: "idle" }, labels: { "herdr.space": "sp1", "herdr.tab": "tb2" } });
  h.herdr.agents = [
    { terminal_id: "ht1", pane_id: "hp1", workspace_id: "w1", tab_id: "tab1", agent: "codex", agent_status: "idle" },
    { terminal_id: "ht2", pane_id: "", workspace_id: "w1", tab_id: "tab2", agent: "codex", agent_status: "idle" },
  ];
  h.agents = h.collect();

  let closeCalled = 0;
  let listCalled = 0;
  let namesCalled = 0;
  h.app.closeAgentTerminal = async ({ localId }) => {
    closeCalled += 1;
    assert.equal(localId, "t1");
    return { closedTab: true, closedTerminals: 1 };
  };
  h.hc.list = async () => {
    listCalled += 1;
  };
  x.refreshNames = async () => {
    namesCalled += 1;
  };

  const r1 = await x.handlers["terminal.kill"]!({ agent: "d/hc:t1" }, "phone");
  assert.deepEqual(r1, { ok: true });
  assert.equal(closeCalled, 1);
  assert.equal(listCalled, 1);
  assert.equal(namesCalled, 1);
  assert.equal(h.agents.some((a) => a.localId === "t1"), false);

  // Fallback to direct hc.label + hc.kill + hc.rm when closeAgentTerminal fails.
  const fallbackEvents: string[] = [];
  h.app.closeAgentTerminal = async () => {
    throw new Error("boom");
  };
  h.hc.label = async (addr) => {
    fallbackEvents.push(`label:${addr}`);
  };
  h.hc.kill = async (addr) => {
    fallbackEvents.push(`kill:${addr}`);
  };
  h.hc.rm = async (addr) => {
    fallbackEvents.push(`rm:${addr}`);
  };
  const r2 = await x.handlers["terminal.kill"]!({ agent: "d/hc:t2" }, "phone");
  assert.deepEqual(r2, { ok: true });
  assert.deepEqual(fallbackEvents, ["label:t2", "kill:t2", "rm:t2"]);
  assert.equal(h.agents.some((a) => a.localId === "t2"), false);

  // Herdr TUI agent: uses pane.close when pane_id is present; throws unsupported when missing.
  const herdrCalls: Array<{ method: string; params: unknown }> = [];
  h.herdr.call = async (method, params) => {
    herdrCalls.push({ method, params });
    return {};
  };
  const r3 = await x.handlers["terminal.kill"]!({ agent: "d/herdr:ht1" }, "phone");
  assert.deepEqual(r3, { ok: true });
  assert.deepEqual(herdrCalls, [{ method: "pane.close", params: { pane_id: "hp1" } }]);
  assert.equal(h.agents.some((a) => a.localId === "ht1"), false);

  await assert.rejects(
    x.handlers["terminal.kill"]!({ agent: "d/herdr:ht2" }, "phone"),
    (e: any) => e.code === "unsupported",
  );

  h.stop();
});
