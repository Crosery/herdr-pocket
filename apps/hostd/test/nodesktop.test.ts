import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HerdrApp, NoDesktopApp } from "../src/create.ts";
import { Host } from "../src/host.ts";

type Handlers = Record<string, (p: unknown, from: string) => Promise<any>>;

const tmpDir = mkdtempSync(join(tmpdir(), "herdr-pocket-nodesktop-"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

/** A host on a computer with herdr-core but no desktop app (Windows, a server). */
function headless() {
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  const x = h as unknown as { handlers: Handlers; launchersCache: unknown };
  h.sources = ["hc"];
  x.launchersCache = {
    at: Date.now(),
    list: Promise.resolve([
      { id: "claude", label: "Claude Code", takesTask: true },
      { id: "kimi", label: "Kimi Code", takesTask: false },
      { id: "shell", label: "终端", takesTask: false },
    ]),
  };
  h.firstTaskOptions = { minMs: 0, stableMs: 20, pollMs: 5, timeoutMs: 3000 };
  h.app = new HerdrApp("herdr-app", {
    docsJsonPath: join(tmpDir, "missing-docs.json"),
    sharedJsonPath: join(tmpDir, "missing-shared.json"),
  });
  h.app.ls = async () => {
    throw new NoDesktopApp();
  };
  h.app.create = async () => {
    throw new NoDesktopApp();
  };
  h.hc.docGet = async () => null;
  const started: Array<{ argv: string[]; cwd: string }> = [];
  const typed: string[] = [];
  h.hc.spawnTerminal = async (argv, cwd) => {
    started.push({ argv, cwd });
    h.hc.terminals.set("t9", { address: "t9", argv, cwd, state: "live", foreground: { argv } });
    return "t9";
  };
  h.hc.list = async () => {};
  h.hc.read = async () => ({ text: "agent ready\n> ", truncated: false }) as Awaited<ReturnType<typeof h.hc.read>>;
  h.hc.send = async (_address, text) => {
    typed.push(text);
  };
  return { h, call: (m: string, p: unknown) => x.handlers[m]!(p, "phone"), started, typed };
}

test("without the desktop app, new agents can still be made: spaces.list allows it", async () => {
  const { h, call } = headless();
  const r = await call("spaces.list", {});
  assert.equal(r.canCreate, true);
  assert.equal(r.reason, undefined);
  assert.deepEqual(r.spaces, []);
  assert.equal(r.standalone, true, "the phone shows no space choices");
  h.stop();
});

test("agent.create starts the program with hc run in the folder, then types the task", async () => {
  const { h, call, started, typed } = headless();
  // Claude Code takes its task on the command line through the desktop app; `hc run` starts it bare.
  const r = await call("agent.create", { launcher: "claude", folder: homedir(), task: "fix the tests" });
  assert.equal(started.length, 1);
  assert.equal(started[0]!.cwd, homedir());
  assert.match(started[0]!.argv[0]!, /claude/);
  assert.equal(started[0]!.argv.length, 1, "no task on the command line");
  assert.deepEqual([r.agent, r.terminal, r.space, r.task], ["d/hc:t9", "t9", "", "typed"]);
  assert.deepEqual(typed, ["fix the tests"]);
  h.stop();
});

test("agent.create without a folder opens in the home folder; the shell gets no task", async () => {
  const { h, call, started } = headless();
  const r = await call("agent.create", { launcher: "shell", task: "ls" });
  assert.deepEqual(started, [{ argv: [], cwd: homedir() }]);
  assert.equal(r.task, "failed");
  h.stop();
});

test("a closed desktop window without a herdr-app doc is still reported, not worked around", async () => {
  const { h, call, started } = headless();
  h.app.ls = async () => {
    throw new Error("herdr-app ls failed: no herdr window");
  };
  h.app.create = async () => {
    throw new Error("桌面 herdr 没有打开，先在电脑上打开它");
  };
  const r = await call("spaces.list", {});
  assert.equal(r.canCreate, false);
  assert.equal(r.standalone, undefined);
  await assert.rejects(call("agent.create", { launcher: "kimi" }), (e: any) => e.code === "unsupported" && /没有打开/.test(e.message));
  assert.equal(started.length, 0);
  h.stop();
});

test("a closed desktop window with an active herdr-app doc allows creating a shell in an unnamed empty Space", async () => {
  const { h, call, started } = headless();
  const saved: Array<{ name: string; version: number; value: any }> = [];
  const labeled: Array<{ addr: string; labels: Record<string, string> }> = [];
  const docValue = {
    activeSpaceId: "sp-other",
    spaces: [
      { id: "sp-other", name: "Other", folder: homedir(), tabs: [{ id: "tb0", name: "1", root: { id: "p0", type: "block", content: { terminal: "t0" } } }] },
      { id: "sp-empty", name: "", folder: join(homedir(), "work_file", "geek_main"), tabs: [] },
    ],
  };
  h.app.spacesFromDocs = () => [
    { id: "sp-other", name: "Other", folder: homedir(), tabs: 1, terminals: 1, active: true },
    { id: "sp-empty", name: "geek_main", folder: join(homedir(), "work_file", "geek_main"), tabs: 0, terminals: 0 },
  ];
  h.app.ls = async () => {
    throw new Error("herdr-app ls failed: no herdr window");
  };
  h.app.create = async () => {
    throw new Error("桌面 herdr 没有打开，先在电脑上打开它");
  };
  h.hc.docGet = async () => ({ version: 4, value: JSON.parse(JSON.stringify(docValue)) });
  h.hc.docSet = async (name, value, version) => {
    saved.push({ name, value, version });
    return version + 1;
  };
  h.hc.label = async (addr, labels) => {
    labeled.push({ addr, labels });
  };

  const list = await call("spaces.list", {});
  assert.equal(list.canCreate, true);
  assert.equal(list.reason, undefined);
  assert.equal(list.spaces[1].name, "geek_main");

  const created = await call("agent.create", { space: "sp-empty", launcher: "shell", folder: homedir() });
  assert.equal(started.length, 1);
  assert.equal(created.agent, "d/hc:t9");
  assert.equal(created.space, "sp-empty");
  assert.ok(created.tab);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.version, 4);
  const emptySpace = saved[0]!.value.spaces[1];
  assert.equal(emptySpace.tabs.length, 1);
  assert.equal(emptySpace.tabs[0].id, created.tab);
  assert.equal(emptySpace.tabs[0].root.content.terminal, "t9");
  assert.deepEqual(labeled, [
    { addr: "t9", labels: { "herdr.space": "sp-empty", "herdr.tab": created.tab, where: "geek_main" } },
  ]);
  h.stop();
});
