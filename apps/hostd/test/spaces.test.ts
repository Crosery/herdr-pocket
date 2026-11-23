import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HerdrApp, NoDesktopApp } from "../src/create.ts";
import type { HcTerminal } from "../src/hc.ts";

const tmp = mkdtempSync(join(tmpdir(), "herdr-pocket-spaces-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("HerdrApp.spaces preserves exact Herdr order, empty spaces, and shared.json colors", async () => {
  const sharedPath = join(tmp, "shared.json");
  const docsPath = join(tmp, "docs.json");
  writeFileSync(
    sharedPath,
    JSON.stringify({
      "space.colors": {
        sp1: "ansi6",
        sp2: "ansi3",
        sp3: "ansi5",
      },
    }),
  );
  writeFileSync(
    docsPath,
    JSON.stringify({
      "herdr-app": {
        version: 1,
        value: {
          activeSpaceId: "sp2",
          spaces: [
            { id: "sp1", name: "И Work", folder: "/tmp/work", isWorktree: true, tabs: [{ id: "tb1", name: "Main", root: { content: { terminal: "t1" } } }] },
            { id: "sp2", name: "Empty Space", folder: "/tmp/empty", tabs: [] },
            { id: "sp3", name: "Docs", folder: "/tmp/docs", tabs: [{ id: "tb2", name: "Notes", terminals: [{ id: "t2" }] }] },
            { id: "sp_remote", name: "Other Machine", machine: "office-mac", folder: "/tmp/other", tabs: [] },
          ],
        },
      },
    }),
  );

  const app = new HerdrApp("herdr-app", { sharedJsonPath: sharedPath, docsJsonPath: docsPath });
  app.ls = async () => ({
    spaces: [
      { id: "sp1", name: "И Work", folder: "/tmp/work", tabs: [{ id: "tb1", name: "Main", terminals: [{ terminal: "t1" }] }] },
      { id: "sp2", name: "Empty Space", folder: "/tmp/empty", tabs: [] },
      { id: "sp3", name: "Docs", folder: "/tmp/docs", tabs: [{ id: "tb2", name: "Notes", terminals: [{ terminal: "t2" }] }] },
      { id: "sp_remote", name: "Other Machine", machine: "office-mac", folder: "/tmp/other", tabs: [] },
    ],
  });

  const live = await app.spaces();
  assert.deepEqual(
    live.map((s) => ({ id: s.id, name: s.name, color: s.color, tabs: s.tabs, terminals: s.terminals, isWorktree: s.isWorktree })),
    [
      { id: "sp1", name: "И Work", color: "ansi6", tabs: 1, terminals: 1, isWorktree: true },
      { id: "sp2", name: "Empty Space", color: "ansi3", tabs: 0, terminals: 0, isWorktree: undefined },
      { id: "sp3", name: "Docs", color: "ansi5", tabs: 1, terminals: 1, isWorktree: undefined },
    ],
  );

  const fromDocs = app.spacesFromDocs();
  assert.deepEqual(
    fromDocs.map((s) => ({ id: s.id, name: s.name, color: s.color, active: s.active, tabs: s.tabs, terminals: s.terminals, isWorktree: s.isWorktree })),
    [
      { id: "sp1", name: "И Work", color: "ansi6", active: undefined, tabs: 1, terminals: 1, isWorktree: true },
      { id: "sp2", name: "Empty Space", color: "ansi3", active: true, tabs: 0, terminals: 0, isWorktree: undefined },
      { id: "sp3", name: "Docs", color: "ansi5", active: undefined, tabs: 1, terminals: 1, isWorktree: undefined },
    ],
  );
});

test("HerdrApp.spacesFromDocs resolves live terminal cwds when docs folder is absent", () => {
  const docsDir = join(tmp, "docs2");
  mkdirSync(docsDir, { recursive: true });
  const docsPath = join(docsDir, "docs.json");
  const sharedPath = join(docsDir, "shared.json");
  writeFileSync(sharedPath, JSON.stringify({ "space.colors": { sp9: "#ec4899" } }));
  writeFileSync(
    docsPath,
    JSON.stringify({
      docs: {
        "herdr-app": {
          value: {
            spaces: [
              { id: "sp9", name: "Nested", tabs: [{ id: "tb9", root: { children: [{ content: { terminal: "t99" } }] } }] },
            ],
          },
        },
      },
    }),
  );
  const app = new HerdrApp("herdr-app", { sharedJsonPath: sharedPath, docsJsonPath: docsPath });
  const terms = new Map([["t99", { cwd: "/Users/demo/repo" }]]);
  const res = app.spacesFromDocs(terms);
  assert.deepEqual(res, [
    { id: "sp9", name: "Nested", folder: "/Users/demo/repo", tabs: 1, terminals: 1, color: "#ec4899" },
  ]);
});

test("HerdrApp.deleteSpace closes via space.close when open, kills subagents, and never deletes disk folders", async () => {
  const projDir = join(tmp, "repo-open");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "keep.txt"), "safe");

  const app = new HerdrApp("herdr-app");
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  app.command = async (cmd, args) => {
    calls.push({ cmd, args });
    return null;
  };

  const killed: string[] = [];
  const labeled: Array<{ addr: string; labels: Record<string, string> }> = [];
  const terms = new Map<string, HcTerminal>([
    ["t1", { address: "t1", cwd: projDir, labels: { "herdr.space": "sp1", "herdr.tab": "tb1" } }],
    ["t1-sub", { address: "t1-sub", cwd: projDir, parent: "t1", labels: {} }],
    ["t2", { address: "t2", cwd: "/tmp/other", labels: { "herdr.space": "sp2" } }],
  ]);

  const res = await app.deleteSpace(
    { spaceId: "sp1", spaceName: "Work" },
    {
      terminals: terms,
      kill: async (addr) => { killed.push(addr); },
      label: async (addr, labels) => { labeled.push({ addr, labels }); },
    },
  );

  assert.deepEqual(calls, [{ cmd: "space.close", args: { id: "sp1", confirmed: true } }]);
  assert.deepEqual(killed.sort(), ["t1", "t1-sub"]);
  assert.equal(res.closedTerminals, 2);
  assert.equal(existsSync(join(projDir, "keep.txt")), true);
  assert.equal(labeled.some((x) => x.addr === "t1" && x.labels["herdr.space"] === ""), true);
});

test("HerdrApp.deleteSpace falls back to doc.get/doc.set when Herdr window is closed", async () => {
  const projDir = join(tmp, "repo-closed");
  mkdirSync(projDir, { recursive: true });
  const app = new HerdrApp("herdr-app");
  app.command = async () => {
    throw new NoDesktopApp();
  };

  let savedDoc: { name: string; version: number; value: any } | null = null;
  const setDoc = (d: { name: string; version: number; value: any }) => { savedDoc = d; };
  const killed: string[] = [];
  const docState = {
    version: 7,
    value: {
      activeSpaceId: "sp-del",
      spaces: [
        { id: "sp-del", name: "Del", folder: projDir, tabs: [{ id: "tb1", root: { content: { terminal: "t10" } } }] },
        { id: "sp-keep", name: "Keep", folder: "/tmp/keep", tabs: [] },
      ],
    },
  };

  const res = await app.deleteSpace(
    { spaceId: "sp-del", spaceName: "Del" },
    {
      terminals: new Map([
        ["t10", { address: "t10", cwd: projDir, labels: { "herdr.space": "sp-del" } }],
        ["t11", { address: "t11", cwd: "/tmp/keep", labels: { "herdr.space": "sp-keep" } }],
      ]),
      docGet: async () => docState,
      docSet: async (name, value, version) => {
        setDoc({ name, value, version });
        return version + 1;
      },
      kill: async (addr) => { killed.push(addr); },
    },
  );

  assert.ok(savedDoc);
  const wrote = savedDoc as { name: string; version: number; value: any };
  assert.equal(wrote.name, "herdr-app");
  assert.equal(wrote.version, 7);
  assert.deepEqual(wrote.value.spaces.map((s: any) => s.id), ["sp-keep"]);
  assert.equal(wrote.value.activeSpaceId, "sp-keep");
  assert.deepEqual(killed, ["t10"]);
  assert.equal(res.closedTerminals, 1);
  assert.equal(existsSync(projDir), true);
});

test("HerdrApp.deleteSpace cleans up standalone orphan space terminals by where prefix", async () => {
  const app = new HerdrApp("herdr-app");
  app.spaces = async () => {
    throw new NoDesktopApp();
  };
  const killed: string[] = [];
  const res = await app.deleteSpace(
    { spaceName: "backend" },
    {
      terminals: new Map([
        ["t21", { address: "t21", labels: { where: "backend / tab1" } }],
        ["t22", { address: "t22", labels: { where: "frontend / tab1" } }],
      ]),
      kill: async (addr) => { killed.push(addr); },
    },
  );
  assert.deepEqual(killed, ["t21"]);
  assert.equal(res.closedTerminals, 1);
});

test("HerdrApp.names + Host.collect exclude detached closed tabs and restore stopped agents", async () => {
  const { Host } = await import("../src/host.ts");
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  const app = new HerdrApp("herdr-app");
  app.ls = async () => ({
    spaces: [
      {
        id: "sp1",
        name: "SpaceA",
        folder: "/tmp/demo",
        tabs: [
          {
            id: "tb1",
            name: "Tab1",
            terminals: [{ terminal: "t_open", app: "claude-code", status: null, name: "Agent1" }],
          },
        ],
      },
      {
        id: "sp_remote",
        name: "RemoteSpace",
        machine: "peer",
        tabs: [{ id: "tb_r", name: "RemoteTab", terminals: [{ terminal: "t_remote", app: "codex" }] }],
      },
    ],
  });
  const names = await app.names();
  assert.equal(names.terminals?.get("t_open")?.app, "claude-code");
  assert.equal(names.terminals?.has("t_remote"), false);

  const now = Date.now();
  (h as unknown as { names: typeof names; hc: { terminals: Map<string, HcTerminal> } }).names = names;
  (h as unknown as { hc: { terminals: Map<string, HcTerminal> } }).hc.terminals = new Map<string, HcTerminal>([
    [
      "t_open",
      {
        address: "t_open",
        cwd: "/tmp/demo",
        created_ms: now - 120_000,
        foreground: { argv: ["zsh"] },
        labels: { "herdr.space": "sp1", "herdr.tab": "tb1" },
      },
    ],
    [
      "t_closed_ghost",
      {
        address: "t_closed_ghost",
        cwd: "/tmp/demo",
        created_ms: now - 120_000,
        status: { app: "codex", state: "idle" },
        labels: { "herdr.seen": "2", where: "SpaceA / Closed" },
      },
    ],
    [
      "t_fresh",
      {
        address: "t_fresh",
        cwd: "/tmp/demo",
        created_ms: now - 1_000,
        labels: { "herdr.seen": "1", where: "SpaceA / Starting" },
      },
    ],
    [
      "t_standalone",
      {
        address: "t_standalone",
        cwd: "/tmp/other",
        created_ms: now - 120_000,
        status: { app: "omp", state: "working" },
        labels: {},
      },
    ],
  ]);

  const collected = h.collect();
  assert.deepEqual(
    collected.map((a) => [a.localId, a.harness, a.isShell, a.where]),
    [
      ["t_open", "claude-code", false, "SpaceA / Tab1"],
      ["t_fresh", "terminal", false, "SpaceA / Starting"],
      ["t_standalone", "omp", false, undefined],
    ],
  );
});

test("Host herdr.doc.get, herdr.doc.set CAS, and herdr.layout fallback when Herdr.app window is closed", async () => {
  const { Host } = await import("../src/host.ts");
  const { NoDesktopApp } = await import("../src/create.ts");
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  h.sources = ["hc"];
  h.deviceId = "d";

  let docVersion = 3;
  let storedDoc: Record<string, unknown> = {
    spaces: [
      {
        id: "sp1",
        name: "work",
        folder: "/tmp/work",
        tabs: [
          {
            id: "tb1",
            name: "",
            root: {
              id: "tb1",
              type: "row",
              children: [
                { id: "p1", type: "block", content: { terminal: "t1" } },
                { id: "p2", type: "block", content: { terminal: "t2" } },
              ],
            },
          },
        ],
      },
    ],
  };

  h.app = new HerdrApp("herdr-app");
  h.app.ls = async () => {
    throw new NoDesktopApp();
  };
  h.hc.terminals = new Map<string, HcTerminal>([
    ["t1", { address: "t1", cwd: "/tmp/work", status: { app: "claude-code", state: "working" } }],
    ["t2", { address: "t2", cwd: "/tmp/work", foreground: { argv: ["zsh"] } }],
  ]);
  h.hc.list = async () => {};
  h.hc.docGet = async () => ({ value: storedDoc, version: docVersion });
  h.hc.docSetCas = async (_name, val, ver) => {
    if (ver !== docVersion) {
      return { ok: false, conflict: true, value: storedDoc, version: docVersion };
    }
    docVersion += 1;
    storedDoc = val as Record<string, unknown>;
    return { ok: true, version: docVersion };
  };

  const handlers = (h as unknown as {
    handlers: {
      "herdr.doc.get": (p: Record<string, never>, from: string) => Promise<{ value: unknown; version: number }>;
      "herdr.doc.set": (p: { value: unknown; version: number }, from: string) => Promise<{ ok: boolean; conflict?: boolean; value?: unknown; version: number }>;
      "herdr.layout": (p: Record<string, never>, from: string) => Promise<{ spaces: Array<{ id: string; tabs: Array<{ id: string; terminals: Array<{ terminal: string }> }> }> }>;
    };
  }).handlers;

  const got = await handlers["herdr.doc.get"]({}, "phone1");
  assert.equal(got.version, 3);
  assert.equal((got.value as { spaces: Array<{ id: string }> }).spaces[0]!.id, "sp1");

  const conflict = await handlers["herdr.doc.set"]({ value: storedDoc, version: 1 }, "phone1");
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.version, 3);

  const ok = await handlers["herdr.doc.set"]({ value: storedDoc, version: 3 }, "phone1");
  assert.equal(ok.ok, true);
  assert.equal(ok.version, 4);

  const layout = await handlers["herdr.layout"]({}, "phone1");
  assert.equal(layout.spaces.length, 1);
  assert.deepEqual(layout.spaces[0]!.tabs[0]!.terminals.map((t) => t.terminal), ["t1", "t2"]);
});
