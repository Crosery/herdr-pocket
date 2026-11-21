import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcAdapter } from "../src/hc.ts";

/** These fakes are shell scripts: Windows can't run them (CI there runs the rest). */
const SH = { skip: process.platform === "win32" && "shell-script fakes" };

/**
 * A stand-in for `hc connect` that behaves like herdr-core 0.1.21: once a
 * connection subscribes, it only streams events and never answers another
 * request on it; a fresh connection answers terminal.list.
 */
function fakeHc(dir: string, listState: string): string {
  const bin = join(dir, "hc");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const term = (state, turn, seen) => ({ address: "t1", state: "live", status: { app: "claude-code", state }, status_ms: 1, turn, labels: seen ? { "herdr.seen": String(seen) } : {} });
let subscribed = false;
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    if (msg.method === "events.subscribe") {
      subscribed = true;
      out({ jsonrpc: "2.0", id: msg.id, result: { terminals: [term("working", 3)] } });
      setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: { type: "status", terminal: "t1", data: { status: { app: "claude-code", msg: "still", state: "working" } } } }), 30);
      setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: { type: "status", terminal: "t1", data: { status: { app: "claude-code", state: "done" } } } }), 80);
    } else if (msg.method === "terminal.list" && !subscribed) {
      const s = readFileSync(${JSON.stringify(listState)}, "utf8").trim();
      out({ jsonrpc: "2.0", id: msg.id, result: { terminals: [term(s, 3, s === "seen" ? 3 : 0)].map((t) => (s === "seen" ? { ...t, status: { app: "claude-code", state: "done" } } : t)) } });
    }
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("status follows the event stream even though the subscribed connection answers nothing else", SH, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-fake-"));
  const listState = join(dir, "state");
  writeFileSync(listState, "done");
  const hc = new HcAdapter(fakeHc(dir, listState));
  const changes: string[] = [];
  hc.on("change", () => changes.push(HcAdapter.status(hc.terminals.get("t1")!)));
  hc.start();
  try {
    // The fake process starts slowly on a busy machine: wait for its snapshot (the "done" event follows 80 ms after it).
    for (let i = 0; i < 400 && !hc.terminals.get("t1"); i++) await wait(5);
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "working", "snapshot from the subscription");
    await wait(700);
    // A message-only update did not count as a change; the finished turn came with the list that followed.
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "done");
    assert.deepEqual(changes.slice(0, 2), ["working", "done"]);

    // A full list comes over its own connection: the desktop marked the turn seen.
    writeFileSync(listState, "seen");
    await hc.list();
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "idle");
  } finally {
    hc.stop();
  }
});

test("HcAdapter.send delivers immediately to blocked terminals via human stream or --force fallback", SH, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-send-blocked-"));
  const bin = join(dir, "hc");
  const argsLog = join(dir, "args.json");
  const streamLog = join(dir, "stream.log");
  writeFileSync(argsLog, "");
  writeFileSync(streamLog, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "connect") {
  const H = 9;
  const frame = (ch, kind, p) => { const h = Buffer.alloc(H); h.writeUInt32LE(ch, 0); h[4] = kind; h.writeUInt32LE(p.length, 5); return Buffer.concat([h, p]); };
  let buf = Buffer.alloc(0), framed = false, mode = "unknown";
  process.stdin.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (!framed && mode === "unknown") {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const msg = JSON.parse(buf.subarray(0, nl).toString());
      buf = buf.subarray(nl + 1);
      if (msg.method === "hello" && msg.params?.framed) {
        framed = true;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { features: ["framed"] } }) + "\\n");
      } else {
        process.exit(1);
      }
    }
    while (framed && buf.length >= H) {
      const ch = buf.readUInt32LE(0), kind = buf[4], len = buf.readUInt32LE(5);
      if (buf.length < H + len) return;
      const p = buf.subarray(H, H + len); buf = buf.subarray(H + len);
      if (ch === 0) {
        const m = JSON.parse(p.toString());
        if (m.method === "terminal.attach" && m.params.terminal === "t-fail") {
          process.stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { message: "attach unavailable" } }))));
        } else {
          process.stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { channel: 9, terminal: { cols: 80, rows: 24 } } }))));
          process.stdout.write(frame(9, 0, Buffer.from("\\x1b[?2004h❯ ")));
        }
      } else if (ch === 9 && kind === 0) {
        appendFileSync(${JSON.stringify(streamLog)}, p);
      }
    }
  });
} else {
  appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");
}
`,
  );
  chmodSync(bin, 0o755);

  const hc = new HcAdapter(bin);
  hc.terminals.set("t1", { address: "t1", status: { app: "claude-code", state: "blocked", msg: "误判需要你" }, cols: 100, rows: 30 });
  hc.terminals.set("t-fail", { address: "t-fail", status: { app: "claude-code", state: "blocked" } });
  try {
    await hc.send("t1", "继续跑测试", true);
    await wait(50);
    assert.equal(readFileSync(streamLog, "utf8"), "\x1b[200~继续跑测试\x1b[201~\r");
    assert.equal(readFileSync(argsLog, "utf8"), "", "blocked terminal uses stream without spawning hc send");

    await hc.send("t-fail", "强制送入", true);
    const cliArgs = readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(cliArgs, [["send", "--force", "--", "t-fail", "强制送入"]]);
  } finally {
    hc.stop();
  }
});
