import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";
import {
  clearPortProbeCacheForTest,
  extractHtmlTitle,
  parseLsofCwds,
  parseLsofListeners,
  parseSsListeners,
  parseWinNetstatListeners,
  scanAgentListeningPorts,
  stopAgentListeningPort,
  type PortTerminalRef,
} from "../src/ports.ts";

const sampleAgent: Agent = {
  key: "h1/hc:t1",
  deviceId: "h1",
  source: "hc",
  localId: "t1",
  harness: "claude-code",
  title: "Dev Server Agent",
  where: "web",
  cwd: "/tmp/web",
  status: "working",
  isShell: false,
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  clearPortProbeCacheForTest();
});

test("parseLsofListeners extracts deduplicated IPv4/IPv6 listeners cleanly", () => {
  const sample = [
    "p4200",
    "cnode",
    "n*:5173",
    "n[::1]:5173",
    "n127.0.0.1:8080",
    "p9999",
    "cpython3",
    "n0.0.0.0:3000",
  ].join("\n");
  const rows = parseLsofListeners(sample);
  assert.deepEqual(rows, [
    { pid: 4200, processName: "node", host: "127.0.0.1", port: 5173 },
    { pid: 4200, processName: "node", host: "127.0.0.1", port: 8080 },
    { pid: 9999, processName: "python3", host: "127.0.0.1", port: 3000 },
  ]);
});

test("parseSsListeners and parseWinNetstatListeners parse Linux and Windows listening sockets", () => {
  const ssOut = `LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=5100,fd=21))\nLISTEN 0 128 [::]:8000 [::]:* users:(("uvicorn",pid=6200,fd=8))`;
  assert.deepEqual(parseSsListeners(ssOut), [
    { pid: 5100, processName: "node", host: "127.0.0.1", port: 5173 },
    { pid: 6200, processName: "uvicorn", host: "127.0.0.1", port: 8000 },
  ]);

  const winOut = [
    "  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       7300",
    "  TCP    0.0.0.0:5432           0.0.0.0:0              ESTABLISHED     7301",
    "  TCP    [::1]:5173             [::]:0                 LISTENING       7302",
  ].join("\r\n");
  const procs = new Map<number, { ppid: number; name: string }>([
    [7300, { ppid: 100, name: "node.exe" }],
    [7302, { ppid: 100, name: "vite.exe" }],
  ]);
  assert.deepEqual(parseWinNetstatListeners(winOut, procs), [
    { pid: 7300, processName: "node.exe", host: "127.0.0.1", port: 3001 },
    { pid: 7302, processName: "vite.exe", host: "127.0.0.1", port: 5173 },
  ]);
});

test("extractHtmlTitle decodes entities and collapses whitespace", () => {
  assert.equal(extractHtmlTitle("<html><head><title>  Demo &amp; App &lt;Dev&gt; </title></head></html>"), "Demo & App <Dev>");
  assert.equal(extractHtmlTitle("<html><body>No title</body></html>"), undefined);
});

test("scanAgentListeningPorts attributes nested descendants via ppid lineage and respects exclusions", async () => {
  const terminals = new Map<string, PortTerminalRef>([
    ["t1", { address: "t1", pid: 1000, foreground: { pid: 1001 } }],
  ]);
  const procs = new Map<number, { ppid: number; name: string }>([
    [1000, { ppid: 1, name: "zsh" }],
    [1001, { ppid: 1000, name: "pnpm" }],
    [1002, { ppid: 1001, name: "node" }],
    [1003, { ppid: 1002, name: "vite" }],
    [2000, { ppid: 1, name: "unrelated" }],
    [3000, { ppid: 1000, name: "herdr" }],
  ]);
  const listeners = [
    { pid: 1003, processName: "vite", host: "127.0.0.1", port: 5173 },
    { pid: 1002, processName: "node", host: "127.0.0.1", port: 5432 },
    { pid: 1002, processName: "node", host: "127.0.0.1", port: 49210 }, // excluded port
    { pid: 2000, processName: "unrelated", host: "127.0.0.1", port: 9000 }, // unrelated tree
    { pid: 3000, processName: "herdr", host: "127.0.0.1", port: 4444 }, // ignored system/tool proc
  ];

  const mapped = await scanAgentListeningPorts([sampleAgent], terminals, {
    selfPid: 99999,
    excludedPorts: new Set([49210]),
    listProcessParents: async () => procs,
    listListeners: async () => listeners,
    probeHttp: async (_host, port) =>
      port === 5173 ? { protocol: "http", title: "Vite Dev App" } : { protocol: "tcp" },
  });

  const entries = mapped.get(sampleAgent.key) ?? [];
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    port: 5173,
    pid: 1003,
    processName: "vite",
    host: "127.0.0.1",
    protocol: "http",
    title: "Vite Dev App",
    url: "http://localhost:5173",
  });
  assert.deepEqual(entries[1], {
    port: 5432,
    pid: 1002,
    processName: "node",
    host: "127.0.0.1",
    protocol: "tcp",
  });
});

test("stopAgentListeningPort verifies process ownership before signaling SIGTERM", async () => {
  const terminals = new Map<string, PortTerminalRef>([["t1", { address: "t1", pid: 1000 }]]);
  const procs = new Map<number, { ppid: number; name: string }>([
    [1000, { ppid: 1, name: "zsh" }],
    [1050, { ppid: 1000, name: "node" }],
    [2050, { ppid: 1, name: "other" }],
  ]);
  const listeners = [
    { pid: 1050, processName: "node", host: "127.0.0.1", port: 5173 },
    { pid: 2050, processName: "other", host: "127.0.0.1", port: 8888 },
  ];
  const killed: number[] = [];
  const deps = {
    selfPid: 99999,
    listProcessParents: async () => procs,
    listListeners: async () => listeners,
    probeHttp: async () => ({ protocol: "http" as const }),
    killPid: (pid: number) => {
      killed.push(pid);
    },
  };

  await assert.rejects(
    stopAgentListeningPort(sampleAgent, 2050, 8888, terminals, deps),
    /不属于当前会话/,
  );
  assert.deepEqual(killed, []);

  const remaining = await stopAgentListeningPort(sampleAgent, 1050, 5173, terminals, deps);
  assert.deepEqual(killed, [1050]);
  assert.deepEqual(remaining, []);
});

test("scanAgentListeningPorts ignores agent harness IPC ports and attributes detached PPID=1 dev servers via project CWD", async () => {
  assert.deepEqual(
    parseLsofCwds("p500\nn/work/app/apps/web\np501\nn/work/my\\x20app\n"),
    new Map([
      [500, "/work/app/apps/web"],
      [501, "/work/my app"],
    ]),
  );

  const containerAgent: Agent = { ...sampleAgent, key: "h1/hc:t-root", localId: "t-root", cwd: "/work" };
  const repoAgent: Agent = { ...sampleAgent, key: "h1/hc:t-repo", localId: "t-repo", harness: "antigravity", cwd: "/work/demo-repo" };
  const terminals = new Map<string, PortTerminalRef>([
    ["t-root", { address: "t-root", pid: 100, cwd: "/work" }],
    ["t-repo", { address: "t-repo", pid: 200, foreground: { pid: 201, cwd: "/work/demo-repo" }, cwd: "/work/demo-repo" }],
  ]);

  const procs = new Map<number, { ppid: number; name: string }>([
    [100, { ppid: 1, name: "zsh" }],
    [200, { ppid: 1, name: "zsh" }],
    [201, { ppid: 200, name: "agy" }],
    [202, { ppid: 201, name: "python3" }], // child server of agy
    [301, { ppid: 1, name: "node" }], // detached vite in monorepo subdir
    [302, { ppid: 1, name: "nginx" }], // detached nginx master
    [303, { ppid: 302, name: "nginx" }], // detached nginx worker (same port)
    [304, { ppid: 1, name: "adb" }], // ignored daemon in same cwd
    [305, { ppid: 1, name: "OrbStack\\x20Helper" }], // ignored container helper in same cwd
    [306, { ppid: 1, name: "node" }], // detached server in unrelated sibling project under /work
    [307, { ppid: 1, name: "node" }], // detached server inside nested git sub-repo
  ]);

  const listeners = [
    { pid: 201, processName: "agy", host: "127.0.0.1", port: 62495 }, // agent internal IPC — MUST ignore
    { pid: 202, processName: "python3", host: "127.0.0.1", port: 18736 }, // tree match
    { pid: 301, processName: "node", host: "127.0.0.1", port: 5173 }, // detached subpath match
    { pid: 302, processName: "nginx", host: "127.0.0.1", port: 18191 }, // detached exact match
    { pid: 303, processName: "nginx", host: "127.0.0.1", port: 18191 }, // duplicate port
    { pid: 304, processName: "adb", host: "127.0.0.1", port: 5037 }, // ignored
    { pid: 305, processName: "OrbStack\\x20Helper", host: "127.0.0.1", port: 15432 }, // ignored
    { pid: 306, processName: "node", host: "127.0.0.1", port: 8888 }, // sibling under non-project /work
    { pid: 307, processName: "node", host: "127.0.0.1", port: 9999 }, // nested .git boundary
  ];

  const cwds = new Map<number, string>([
    [301, "/work/demo-repo/apps/console"],
    [302, "/work/demo-repo"],
    [303, "/work/demo-repo"],
    [304, "/work/demo-repo"],
    [305, "/work/demo-repo"],
    [306, "/work/other-service"],
    [307, "/work/demo-repo/vendor/subrepo"],
  ]);

  const mapped = await scanAgentListeningPorts([containerAgent, repoAgent], terminals, {
    selfPid: 99999,
    listProcessParents: async () => procs,
    listListeners: async () => listeners,
    listProcessCwds: async () => cwds,
    isProjectRoot: (dir) => dir === "/work/demo-repo",
    hasGitDir: (dir) => dir === "/work/demo-repo" || dir === "/work/demo-repo/vendor/subrepo",
    probeHttp: async () => ({ protocol: "http" as const }),
  });

  // Container directory `/work` (not a project root) must NOT steal sibling `/work/other-service`.
  assert.equal(mapped.get(containerAgent.key), undefined);

  // `repoAgent` gets its child server + detached monorepo & exact-cwd servers, excluding `agy`, `adb`, `OrbStack Helper`, and nested `.git` sub-repo.
  const repoPorts = (mapped.get(repoAgent.key) ?? []).map((p) => p.port);
  assert.deepEqual(repoPorts, [5173, 18191, 18736]);
});
