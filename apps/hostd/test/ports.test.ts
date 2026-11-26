import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";
import {
  clearPortProbeCacheForTest,
  extractHtmlTitle,
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
