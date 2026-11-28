import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  HcAdapter,
  demotedFinishedStatus,
  detectDismissableSubscreen,
  endsInPanel,
  isFalseAntigravityReviewBlock,
  isFalseAntigravityWorkingState,
  isFalseBlockedCandidate,
  isFalseBlockedState,
  isInteractiveApprovalOrQuestion,
  isViewerSubscreen,
} from "../src/hc.ts";
import { Host } from "../src/host.ts";

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

test("isViewerSubscreen and endsInPanel distinguish interactive viewers from interrupt/cancel prompts", () => {
  const swarmBoard = [
    "Swarm board  4 agents",
    "coordinator  working",
    "tab switch pane · enter hide message · space expand · p filter · f follow · z zoom · esc back",
  ].join("\n");
  assert.equal(isViewerSubscreen(swarmBoard), true);
  assert.equal(endsInPanel(swarmBoard), true);

  for (const viewer of [
    "Swarm board\nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7",
    "Detail view\nEsc to go back",
    "Log viewer\nenter open · esc close",
    "Status\nEsc to exit",
    "Help\nesc return",
    "面板详情\n按 Esc 键返回",
    "设置视图\n按esc关闭",
    "预览\nEsc 退出",
  ]) {
    assert.equal(isViewerSubscreen(viewer), true, `expected viewer subscreen: ${viewer}`);
    assert.equal(endsInPanel(viewer), true, `expected endsInPanel: ${viewer}`);
  }

  // Modal picker footers match endsInPanel (when idle/done), NOT isViewerSubscreen (when working).
  for (const modal of ["Select model\nEnter to confirm · Esc to cancel", "Notice\nEsc dismiss", "选择模型\n按 esc 取消"]) {
    assert.equal(isViewerSubscreen(modal), false, `modal should not interrupt working: ${modal}`);
    assert.equal(endsInPanel(modal), true, `modal should close when idle: ${modal}`);
  }

  // Normal working spinner with "esc to interrupt" must NEVER match either predicate.
  for (const normal of [
    "✳ Germinating… (esc to interrupt · 12s · ↑ 1.2k tokens)",
    "Working on tests\nesc to interrupt",
    "❯ ",
  ]) {
    assert.equal(isViewerSubscreen(normal), false, `normal screen must not match viewer: ${normal}`);
    assert.equal(endsInPanel(normal), false, `normal screen must not match panel: ${normal}`);
  }
});

test("HcAdapter.send closes /swarm board (idle & working, multi-level) via Esc while sparing normal working, blocked, and shell", SH, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-send-subscreen-"));
  const bin = join(dir, "hc");
  const statePath = join(dir, "screens.json");
  const keysLog = join(dir, "keys.log");
  const rawInputLog = join(dir, "raw.log");
  const pasteLog = join(dir, "paste.log");

  const boardFooter = "tab switch pane · enter hide message · space expand · p filter · f follow · z zoom · esc back";
  const initialState: Record<string, string[]> = {
    // 2 levels open while working: expanded detail -> board -> working prompt
    "t-work-board": [
      `Expanded message\nbody\n${boardFooter}`,
      `Swarm board\nagent 1\n${boardFooter}`,
      "✳ Germinating… (esc to interrupt)",
    ],
    // 1 level open while idle: board -> prompt
    "t-idle-board": [`Swarm board\nagent 1\n${boardFooter}`, "❯ "],
    // Ignores raw DATA Esc so `hc keys` fallback closes it.
    "t-fallback": [`Swarm board\nagent 2\n${boardFooter}`, "❯ "],
    // Stuck viewer (>3 Esc attempts)
    "t-stuck": [`Swarm board\nstuck\n${boardFooter}`],
    // Normal working screen (must NOT send Esc)
    "t-working-ok": ["✳ Thinking… (esc to interrupt)"],
    // Blocked permission dialog (must NOT send Esc even if footer looks like a panel)
    "t-blocked": ["Allow tool execution?\nEsc to cancel"],
    // Shell terminal (must NOT send Esc)
    "t-shell": ["man less\nPress q or esc to exit"],
  };
  writeFileSync(statePath, JSON.stringify(initialState));
  writeFileSync(keysLog, "");
  writeFileSync(rawInputLog, "");
  writeFileSync(pasteLog, "");

  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(statePath)};
if (args[0] === "keys") {
  appendFileSync(${JSON.stringify(keysLog)}, JSON.stringify(args.slice(1)) + "\\n");
  const addr = args[1];
  if (args[2] === "esc") {
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    if (Array.isArray(st[addr]) && st[addr].length > 1) {
      st[addr].shift();
      writeFileSync(stateFile, JSON.stringify(st));
    }
  }
  process.exit(0);
}
if (args[0] === "connect") {
  const H = 9;
  const frame = (ch, kind, p) => { const h = Buffer.alloc(H); h.writeUInt32LE(ch, 0); h[4] = kind; h.writeUInt32LE(p.length, 5); return Buffer.concat([h, p]); };
  let buf = Buffer.alloc(0), framed = false, nextCh = 10;
  const chToAddr = new Map();
  process.stdin.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (!framed) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      buf = buf.subarray(nl + 1);
      framed = true;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { features: ["framed"] } }) + "\\n");
    }
    while (buf.length >= H) {
      const ch = buf.readUInt32LE(0), kind = buf[4], len = buf.readUInt32LE(5);
      if (buf.length < H + len) return;
      const p = buf.subarray(H, H + len); buf = buf.subarray(H + len);
      if (ch === 0) {
        const m = JSON.parse(p.toString());
        if (m.method === "terminal.attach") {
          const id = nextCh++;
          const addr = m.params.terminal;
          chToAddr.set(id, addr);
          process.stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { channel: id, terminal: { cols: 100, rows: 30 } } }))));
          if (m.params.observe) {
            const st = JSON.parse(readFileSync(stateFile, "utf8"));
            const screen = (st[addr] && st[addr][0]) || "❯ ";
            process.stdout.write(frame(id, 0, Buffer.from("\\x1b[2J\\x1b[H" + screen.replace(/\\n/g, "\\r\\n"))));
          } else {
            process.stdout.write(frame(id, 0, Buffer.from("\\x1b[?2004h❯ ")));
          }
        }
      } else if (kind === 0) {
        const addr = chToAddr.get(ch);
        const raw = p.toString("utf8");
        if (raw === "\\x1b" || raw === "q" || raw === "\\x0f") {
          appendFileSync(${JSON.stringify(rawInputLog)}, JSON.stringify([addr, raw]) + "\\n");
          if (addr !== "t-fallback") {
            const st = JSON.parse(readFileSync(stateFile, "utf8"));
            if (Array.isArray(st[addr]) && st[addr].length > 1) {
              st[addr].shift();
              writeFileSync(stateFile, JSON.stringify(st));
            }
          }
        } else {
          appendFileSync(${JSON.stringify(pasteLog)}, JSON.stringify({ terminal: addr, data: raw }) + "\\n");
        }
      }
    }
  });
}
`,
  );
  chmodSync(bin, 0o755);

  const hc = new HcAdapter(bin);
  hc.terminals.set("t-work-board", { address: "t-work-board", status: { app: "omp", state: "working" } });
  hc.terminals.set("t-idle-board", { address: "t-idle-board", status: { app: "omp", state: "idle" } });
  hc.terminals.set("t-fallback", { address: "t-fallback", status: { app: "omp", state: "idle" } });
  hc.terminals.set("t-stuck", { address: "t-stuck", status: { app: "omp", state: "working" } });
  hc.terminals.set("t-working-ok", { address: "t-working-ok", status: { app: "claude-code", state: "working" } });
  hc.terminals.set("t-blocked", { address: "t-blocked", status: { app: "claude-code", state: "blocked", msg: "Allow?" } });
  hc.terminals.set("t-shell", { address: "t-shell", argv: ["/bin/zsh"], status: null });

  try {
    await hc.send("t-work-board", "继续重构", true);
    await hc.send("t-idle-board", "看看进度", true);
    await hc.send("t-fallback", "备选按键", true);
    await hc.send("t-working-ok", "补充测试", true);
    await hc.send("t-blocked", "允许执行", true);
    await hc.send("t-shell", "ls -la", true);

    await assert.rejects(
      () => hc.send("t-stuck", "卡住了", true),
      /它开着一个面板，消息没送进去/,
    );

    await wait(50);
    const rawCalls = readFileSync(rawInputLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(rawCalls, [
      ["t-work-board", "\x1b"],
      ["t-work-board", "\x1b"],
      ["t-idle-board", "\x1b"],
      ["t-fallback", "\x1b"],
      ["t-stuck", "\x1b"],
      ["t-stuck", "\x1b"],
      ["t-stuck", "\x1b"],
    ]);
    const keyCalls = readFileSync(keysLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(keyCalls, [
      ["t-fallback", "esc"],
      ["t-stuck", "esc"],
      ["t-stuck", "esc"],
      ["t-stuck", "esc"],
    ]);

    const pastedByTerminal = new Map<string, string>();
    for (const line of readFileSync(pasteLog, "utf8").trim().split("\n").filter(Boolean)) {
      const ev = JSON.parse(line) as { terminal: string; data: string };
      pastedByTerminal.set(ev.terminal, (pastedByTerminal.get(ev.terminal) ?? "") + ev.data);
    }
    assert.deepEqual(Object.fromEntries(pastedByTerminal), {
      "t-work-board": "\x1b[200~继续重构\x1b[201~\r",
      "t-idle-board": "\x1b[200~看看进度\x1b[201~\r",
      "t-fallback": "\x1b[200~备选按键\x1b[201~\r",
      "t-working-ok": "\x1b[200~补充测试\x1b[201~\r",
      "t-blocked": "\x1b[200~允许执行\x1b[201~\r",
      "t-shell": "\x1b[200~ls -la\x1b[201~\r",
    });
  } finally {
    hc.stop();
  }
});

test("HcAdapter.rm runs hc rm and ignores still-running/not-found errors", SH, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-rm-"));
  const bin = join(dir, "hc");
  const argsLog = join(dir, "args.log");
  writeFileSync(argsLog, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");
if (args[1] === "t-fail") {
  process.stderr.write("terminal t-fail is still running\\n");
  process.exit(1);
}
`,
  );
  chmodSync(bin, 0o755);

  const hc = new HcAdapter(bin);
  try {
    await hc.rm("t-ok");
    await hc.rm("t-fail");
    const calls = readFileSync(argsLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(calls, [
      ["rm", "t-ok"],
      ["rm", "t-fail"],
    ]);
  } finally {
    hc.stop();
  }
});

test("detectDismissableSubscreen enforces Hard Veto, handles working (esc to cancel) safely, and detects pagers/transcripts/status tabs", () => {
  // Normal working turn with (esc to cancel) must NEVER be auto-dismissed.
  assert.equal(endsInPanel("⠋ Working on task (esc to cancel)\n❯ "), false);
  assert.equal(
    detectDismissableSubscreen({
      screen: "⠋ Thinking… (12s • esc to cancel)\n❯ ",
      status: "working",
    }),
    null,
  );
  assert.equal(
    detectDismissableSubscreen({
      screen: "正在生成回复 (按 esc 取消)\n❯ ",
      status: "working",
    }),
    null,
  );

  // Hard Veto: approval/permission/question prompts never dismiss even when status reads idle or blocked.
  assert.equal(isInteractiveApprovalOrQuestion("Do you want to proceed?\n1. Yes\n2. No\nEsc to cancel"), true);
  assert.equal(
    detectDismissableSubscreen({
      screen: "Allow tool execution?\n1. Yes, allow once\n2. No\nEsc to cancel",
      status: "idle",
    }),
    null,
  );
  assert.equal(
    detectDismissableSubscreen({
      screen: "Press a number to choose\n1. Option A\nEsc to cancel",
      status: "idle",
    }),
    null,
  );
  assert.equal(
    detectDismissableSubscreen({
      screen: "Settings Status Config\nEsc to close",
      status: "blocked",
      statusKind: "permission",
    }),
    null,
  );

  // Tabbed /status or /usage viewer closes via Esc even if agent status is working.
  assert.deepEqual(
    detectDismissableSubscreen({
      screen: "   Settings  Status  Config\n   Model: opus\n   Esc to cancel",
      status: "working",
    }),
    { kind: "viewer", dismissKey: "\x1b", dismissAlias: "esc", reason: "viewer" },
  );

  // OS pager (less/man) closes via 'q'.
  assert.deepEqual(
    detectDismissableSubscreen({
      screen: "NAME\n  git-status - Show the working tree status\n(END)",
      altScreen: true,
      status: "idle",
      fgName: "less",
    }),
    { kind: "pager", dismissKey: "q", dismissAlias: "q", reason: "pager" },
  );

  // Claude Code detailed transcript viewer exits safely via Esc (never toggles Ctrl+O \x0f),
  // and if an active composer prompt (`❯ `) is visible, scrollback noise never triggers dismissal.
  assert.deepEqual(
    detectDismissableSubscreen({
      screen: "Showing detailed transcript\n• Tool call output...\nctrl+o to collapse",
      status: "idle",
    }),
    { kind: "viewer", dismissKey: "\x1b", dismissAlias: "esc", reason: "transcript" },
  );
  assert.equal(
    detectDismissableSubscreen({
      screen: "Showing detailed transcript\nctrl+o to collapse\nSettings Status Usage\n❯ \nshift+tab to cycle",
      status: "idle",
    }),
    null,
  );

  // HcAdapter.toAgent exposes structured statusKind only when blocked.
  const perm = HcAdapter.toAgent(
    { address: "t1", status: { app: "claude-code", state: "blocked", kind: "permission", msg: "Allow Bash?" } },
    "d1",
  );
  assert.equal(perm.statusKind, "permission");
  const idleWithKind = HcAdapter.toAgent(
    { address: "t2", status: { app: "claude-code", state: "idle", kind: "permission" } },
    "d1",
  );
  assert.equal(idleWithKind.statusKind, undefined);
});

test("dismissSubscreens inspects visible viewport only (history=0) and stops if screen is unchanged", async () => {
  const historyArgs: number[] = [];
  const rawInputs: string[] = [];
  const snapshotMock = {
    async snapshot(_address: string, history = 0) {
      historyArgs.push(history);
      return { text: "Showing detailed transcript\nctrl+o to collapse", cols: 80, rows: 24, altScreen: false };
    },
    async input(_address: string, data: string) {
      rawInputs.push(data);
    },
  };
  const hc = new HcAdapter("nonexistent-hc-bin");
  (hc as any).screens = snapshotMock;
  (hc as any).terminals.set("t1", { address: "t1", cols: 80, rows: 24, status: { app: "claude-code", state: "idle" } });

  const res = await hc.dismissSubscreens("t1");
  assert.equal(res, "blocked");
  assert.ok(historyArgs.length >= 2 && historyArgs.every((h) => h === 0));
  // Raw input must send Esc (\x1b), never Ctrl+O (\x0f), and abort on the first unchanged pass.
  assert.deepEqual(rawInputs, ["\x1b"]);
});

test("isFalseAntigravityReviewBlock demotes idle reviewing screens while preserving genuine approvals", () => {
  const falseReviewScreen = [
    "已检查完毕，等待下一轮 cron 自动巡检（之前讨论过 approve 流程）。",
    "                              1 artifact · /artifact to review",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "  ● [12:15:38] cron (every 3 minutes) running",
    "  ● [12:10:53] nginx -g 'daemon off;' -c /tmp/nginx.conf running",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 15% ctx · reviewing",
  ].join("\n");

  assert.equal(
    isFalseAntigravityReviewBlock({
      harness: "antigravity",
      status: "blocked",
      statusKind: "permission",
      statusNote: "Approve plan",
      screen: falseReviewScreen,
    }),
    true,
  );

  // Real Antigravity approval modal with selectable options must NEVER be demoted.
  const realApprovalModal = [
    "Approve plan?",
    "❯ 1. Proceed",
    "  2. Review changes",
    "  3. Reject",
    "Gemini 4 Neon (XHigh) · 15% ctx · reviewing",
  ].join("\n");
  assert.equal(
    isFalseAntigravityReviewBlock({
      harness: "antigravity",
      status: "blocked",
      statusKind: "permission",
      statusNote: "Approve plan",
      screen: realApprovalModal,
    }),
    false,
  );

  // Explicit modal question right above composer must NEVER be demoted.
  const realPermissionPrompt = [
    "Permission required: Allow execution of rm -rf build?",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 15% ctx · reviewing",
  ].join("\n");
  assert.equal(
    isFalseAntigravityReviewBlock({
      harness: "antigravity",
      status: "blocked",
      statusKind: "permission",
      statusNote: "Approve plan",
      screen: realPermissionPrompt,
    }),
    false,
  );

  // Different harness or different statusNote must NEVER be demoted.
  assert.equal(
    isFalseAntigravityReviewBlock({
      harness: "claude-code",
      status: "blocked",
      statusKind: "permission",
      statusNote: "Approve plan",
      screen: falseReviewScreen,
    }),
    false,
  );
  assert.equal(
    isFalseAntigravityReviewBlock({
      harness: "antigravity",
      status: "blocked",
      statusKind: "permission",
      statusNote: "Allow bash command",
      screen: falseReviewScreen,
    }),
    false,
  );
});

test("isFalseAntigravityWorkingState demotes idle footer with background tasks while preserving real working turns", () => {
  // Case 1: Idle composer with Swarm workers + background commands below `>` (footer literally says `· idle`).
  const idleSwarmFooterScreen = [
    "已汇总完本轮检查结果，等待下一条指令。",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "  ● Agent(worker-a) Working",
    "  ● [15:37:47] python3 scripts/listener.py running",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 43% ctx · idle",
  ].join("\n");
  assert.equal(
    isFalseAntigravityWorkingState({
      harness: "antigravity",
      status: "working",
      screen: idleSwarmFooterScreen,
    }),
    true,
  );

  // Case 2: Idle composer with single background command running below `>` and `· done` / `· reviewing` footer.
  const idleBgTaskScreen = [
    "已将配置写入，随时可继续。",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "  ● [15:37:47] python3 watch.py --poll running",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 32% ctx · done",
  ].join("\n");
  assert.equal(
    isFalseAntigravityWorkingState({
      harness: "antigravity",
      status: "working",
      screen: idleBgTaskScreen,
    }),
    true,
  );

  // Case 3: Active working turn with narrow truncated `· workin` + spinner + `● Running` must NEVER be demoted.
  const activeWorkingNarrowScreen = [
    "● Running pnpm test",
    "⣯ 2/4 steps (esc to interrupt)",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 43% ctx · workin",
  ].join("\n");
  assert.equal(
    isFalseAntigravityWorkingState({
      harness: "antigravity",
      status: "working",
      screen: activeWorkingNarrowScreen,
    }),
    false,
  );

  // Case 4: Active foreground spinner or `(esc to interrupt)` above composer even if footer hasn't flipped yet.
  const activeSpinnerAboveComposer = [
    "⣾ 0/4 steps (esc to cancel)",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 43% ctx · idle",
  ].join("\n");
  assert.equal(
    isFalseAntigravityWorkingState({
      harness: "antigravity",
      status: "working",
      screen: activeSpinnerAboveComposer,
    }),
    false,
  );

  // Case 5: Non-antigravity harness must NEVER be demoted.
  assert.equal(
    isFalseAntigravityWorkingState({
      harness: "claude-code",
      status: "working",
      screen: idleSwarmFooterScreen,
    }),
    false,
  );
});

test("demotedFinishedStatus preserves done for unseen turns and returns idle when seen or turn 0", () => {
  assert.equal(demotedFinishedStatus(undefined), "idle");
  assert.equal(demotedFinishedStatus({ address: "t0", turn: 0, labels: {} }), "idle");
  assert.equal(demotedFinishedStatus({ address: "t1", turn: 3, labels: {} }), "done");
  assert.equal(demotedFinishedStatus({ address: "t2", turn: 63, labels: { "herdr.seen": "25" } }), "done");
  assert.equal(demotedFinishedStatus({ address: "t3", turn: 1, labels: { "herdr.seen": "" } }), "done");
  assert.equal(demotedFinishedStatus({ address: "t4", turn: 26, labels: { "herdr.seen": "26" } }), "idle");
  assert.equal(demotedFinishedStatus({ address: "t5", turn: 26, labels: { "herdr.seen": "30" } }), "idle");
});

test("isFalseBlockedState demotes stale idle blocks across harnesses while enforcing all Hard Vetoes", () => {
  const agyIdleReview = [
    "本轮巡检完成，未发现异常。",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 18% ctx · reviewing",
  ].join("\n");

  const agyIdleDone = [
    "构建成功，可以继续下一步。",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 22% ctx · idle",
  ].join("\n");

  const claudeIdle = [
    "All 42 unit tests passed.",
    "──────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  const codexIdle = [
    "Patch applied cleanly.",
    "›",
    "  ? for shortcuts                                  91% context left",
  ].join("\n");

  const ompIdle = [
    "Verification complete.",
    "──────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────",
    "  claude-opus-4-6 · 24% ctx · idle",
  ].join("\n");

  // Stale non-error blocked states on clean idle composers across harnesses MUST demote.
  assert.equal(
    isFalseBlockedState({ harness: "antigravity", status: "blocked", statusNote: "", screen: agyIdleReview }),
    true,
  );
  assert.equal(
    isFalseBlockedState({ harness: "antigravity", status: "blocked", statusKind: "permission", statusNote: "Review output", screen: agyIdleDone }),
    true,
  );
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", statusKind: "permission", screen: claudeIdle }),
    true,
  );
  assert.equal(
    isFalseBlockedState({ harness: "codex", status: "blocked", screen: codexIdle }),
    true,
  );
  assert.equal(
    isFalseBlockedState({ harness: "omp", status: "blocked", statusKind: "question", screen: ompIdle }),
    true,
  );

  // Hard Veto: selectable choice menu / ask_question options NEVER demote.
  const askNumberedChoices = [
    "Which deployment environment should we target?",
    "❯ 1. Staging (Recommended)",
    "  2. Production",
    "  3. Cancel",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "antigravity", status: "blocked", statusKind: "question", screen: askNumberedChoices }),
    false,
  );
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", statusKind: "question", screen: askNumberedChoices }),
    false,
  );

  const askRadioChoices = [
    "Select features to enable:",
    "❯ ○ Strict mode",
    "  ○ Verbose logs",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", statusKind: "question", screen: askRadioChoices }),
    false,
  );

  // Hard Veto: permission [y/n] or (y/n) prompt right above empty composer NEVER demotes.
  const ynAboveAgyComposer = [
    "Delete temporary build cache? [y/n]",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 18% ctx · reviewing",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "antigravity", status: "blocked", statusKind: "permission", screen: ynAboveAgyComposer }),
    false,
  );
  assert.equal(isInteractiveApprovalOrQuestion("Continue deployment? (y/n)"), true);

  const ynAboveClaudeComposer = [
    "Run database migration now? (y/n)",
    "❯",
    "  ? for shortcuts",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", statusKind: "permission", screen: ynAboveClaudeComposer }),
    false,
  );

  // Hard Veto: statusKind === "auth" or explicit auth/OAuth/login prompt on screen NEVER demotes.
  assert.equal(
    isFalseBlockedCandidate({ harness: "claude-code", status: "blocked", statusKind: "auth" }),
    false,
  );
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", statusKind: "auth", screen: claudeIdle }),
    false,
  );
  const oauthScreen = [
    "Please sign in to continue. Open this URL to authenticate: https://auth.example.com/device",
    "❯",
    "  ? for shortcuts",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", screen: oauthScreen }),
    false,
  );

  // Hard Veto: statusKind === "question" with active `? ...` question header or non-empty input NEVER demotes.
  const activeQuestionHeader = [
    "? What branch name should we use?",
    "❯",
    "  ? for shortcuts",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", statusKind: "question", screen: activeQuestionHeader }),
    false,
  );
  const nonEmptyPrompt = [
    "Finished previous step.",
    "❯ draft answer in progress",
    "  ? for shortcuts",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", statusKind: "question", screen: nonEmptyPrompt }),
    false,
  );

  // Hard Veto: errored, active spinner / Running line, or shell terminals NEVER demote.
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", errored: true, screen: claudeIdle }),
    false,
  );
  const spinnerAboveClaude = [
    "⏺ Running test suite…",
    "❯",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
  assert.equal(
    isFalseBlockedState({ harness: "claude-code", status: "blocked", screen: spinnerAboveClaude }),
    false,
  );
  assert.equal(
    isFalseBlockedState({ harness: "zsh", status: "blocked", isShell: true, screen: claudeIdle }),
    false,
  );
});

test("Host demotes false working/blocked to done when unseen, idle when seen, handles agent.seen, and preserves real blocked prompts", async () => {
  const frames: any[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on("upgrade", (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (d) => frames.push(JSON.parse(d.toString())))),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

  const h = new Host({
    config: { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "t", deviceId: "d1", name: "test-host" },
    log: () => {},
  });

  const agyIdleBgScreen = [
    "本轮任务已完成，等待下一条消息。",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "  ● [15:37:47] cron (every 3 minutes) running",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 30% ctx · idle",
  ].join("\n");

  const agyReviewIdleScreen = [
    "计划已生成，可随时审阅。",
    "                              1 artifact · /artifact to review",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 19% ctx · reviewing",
  ].join("\n");

  const claudeStaleBlockedScreen = [
    "Tests are green.",
    "──────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");

  const realAskScreen = [
    "Which option should we pick?",
    "❯ 1. Option A (Recommended)",
    "  2. Option B",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  const realAuthScreen = [
    "Please log in to continue.",
    "❯",
    "  ? for shortcuts",
  ].join("\n");

  const screens = new Map<string, string>([
    ["t-work-unseen", agyIdleBgScreen],
    ["t-work-seen", agyIdleBgScreen],
    ["t-blk-agy-unseen", agyReviewIdleScreen],
    ["t-blk-claude-unseen", claudeStaleBlockedScreen],
    ["t-blk-claude-seen", claudeStaleBlockedScreen],
    ["t-real-ask", realAskScreen],
    ["t-real-auth", realAuthScreen],
  ]);

  h.hc.terminals.set("t-work-unseen", {
    address: "t-work-unseen",
    status: { app: "antigravity", state: "working" },
    status_ms: 100,
    turn: 63,
    labels: { "herdr.seen": "25" },
  });
  h.hc.terminals.set("t-work-seen", {
    address: "t-work-seen",
    status: { app: "antigravity", state: "working" },
    status_ms: 100,
    turn: 12,
    labels: { "herdr.seen": "12" },
  });
  h.hc.terminals.set("t-blk-agy-unseen", {
    address: "t-blk-agy-unseen",
    status: { app: "antigravity", state: "blocked", kind: "permission", msg: "" },
    status_ms: 200,
    turn: 9,
    labels: {},
  });
  h.hc.terminals.set("t-blk-claude-unseen", {
    address: "t-blk-claude-unseen",
    status: { app: "claude-code", state: "blocked", kind: "permission", msg: "stale" },
    status_ms: 300,
    turn: 5,
    labels: { "herdr.seen": "4" },
  });
  h.hc.terminals.set("t-blk-claude-seen", {
    address: "t-blk-claude-seen",
    status: { app: "claude-code", state: "blocked", kind: "permission", msg: "stale" },
    status_ms: 300,
    turn: 5,
    labels: { "herdr.seen": "5" },
  });
  h.hc.terminals.set("t-real-ask", {
    address: "t-real-ask",
    status: { app: "claude-code", state: "blocked", kind: "question", msg: "Which option?" },
    status_ms: 400,
    turn: 4,
    labels: {},
  });
  h.hc.terminals.set("t-real-auth", {
    address: "t-real-auth",
    status: { app: "claude-code", state: "blocked", kind: "auth", msg: "Sign in" },
    status_ms: 500,
    turn: 2,
    labels: {},
  });

  const labelsSet: Array<{ addr: string; labels: Record<string, string> }> = [];
  h.hc.snapshotWithMeta = async (addr: string) => ({ text: screens.get(addr) ?? "", cols: 100, rows: 30, altScreen: false, ansi: "" });
  h.hc.read = async (addr: string) => ({ text: screens.get(addr) ?? "" });
  h.hc.label = async (addr: string, labels: Record<string, string>) => {
    labelsSet.push({ addr, labels });
    const term = h.hc.terminals.get(addr);
    if (term) term.labels = { ...term.labels, ...labels };
  };
  h.hc.list = async () => {};

  try {
    (h as unknown as { connect(): void }).connect();
    for (let i = 0; i < 100 && !h.connected; i++) await wait(15);

    h.agents = h.collect();
    await (h as unknown as { refreshScreenQueues(): Promise<void> }).refreshScreenQueues();
    const afterDemote = h.collect();
    h.agents = afterDemote;
    const byId = new Map(afterDemote.map((a) => [a.localId, a]));

    // Unseen false-working and false-blocked MUST become "done" (已完成), NOT "idle".
    assert.equal(byId.get("t-work-unseen")?.status, "done");
    assert.equal(byId.get("t-work-seen")?.status, "idle");
    assert.equal(byId.get("t-blk-agy-unseen")?.status, "done");
    assert.equal(byId.get("t-blk-agy-unseen")?.statusKind, undefined);
    assert.equal(byId.get("t-blk-claude-unseen")?.status, "done");
    assert.equal(byId.get("t-blk-claude-seen")?.status, "idle");

    // Genuine ask_question and auth prompts MUST stay "blocked".
    assert.equal(byId.get("t-real-ask")?.status, "blocked");
    assert.equal(byId.get("t-real-auth")?.status, "blocked");

    // Calling agent.seen on demoted-to-done terminals (both falseWorking and falseBlocked)
    // MUST write herdr.seen = String(turn) and transition them to "idle".
    await (h as unknown as { handleRpc(f: unknown): Promise<void> }).handleRpc({
      type: "rpc",
      id: "seen-work",
      from: "relay",
      method: "agent.seen",
      params: { agent: "d1/hc:t-work-unseen" },
    });
    await (h as unknown as { handleRpc(f: unknown): Promise<void> }).handleRpc({
      type: "rpc",
      id: "seen-blk",
      from: "relay",
      method: "agent.seen",
      params: { agent: "d1/hc:t-blk-agy-unseen" },
    });

    assert.deepEqual(labelsSet, [
      { addr: "t-work-unseen", labels: { "herdr.seen": "63" } },
      { addr: "t-blk-agy-unseen", labels: { "herdr.seen": "9" } },
    ]);

    const afterSeen = new Map(h.agents.map((a) => [a.localId, a]));
    assert.equal(afterSeen.get("t-work-unseen")?.status, "idle");
    assert.equal(afterSeen.get("t-blk-agy-unseen")?.status, "idle");
    assert.equal(afterSeen.get("t-blk-claude-unseen")?.status, "done");
    assert.equal(afterSeen.get("t-real-ask")?.status, "blocked");
  } finally {
    h.stop();
    for (const c of wss.clients) c.terminate();
    wss.close();
    server.closeAllConnections();
    server.close();
  }
});

test("HcAdapter done status transition resyncs immediately without debounce starvation from noisy sibling events", SH, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-done-resync-"));
  const bin = join(dir, "hc");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const term = (addr, state, turn, seen) => ({ address: addr, state: "live", status: { app: "claude-code", state }, status_ms: 1, turn, labels: seen ? { "herdr.seen": String(seen) } : {} });
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
      out({ jsonrpc: "2.0", id: msg.id, result: { terminals: [term("t1", "working", 4, 3)] } });
      setTimeout(() => out({ jsonrpc: "2.0", method: "event", params: { type: "status", terminal: "t1", data: { status: { app: "claude-code", state: "done" } } } }), 30);
      // Continuous doc events every 80ms would starve a 400ms debounced resync.
      const noise = setInterval(() => out({ jsonrpc: "2.0", method: "event", params: { type: "doc" } }), 80);
      setTimeout(() => clearInterval(noise), 1200);
    } else if (msg.method === "terminal.list" && !subscribed) {
      out({ jsonrpc: "2.0", id: msg.id, result: { terminals: [term("t1", "done", 4, 3)] } });
    }
  }
});
`,
  );
  chmodSync(bin, 0o755);

  const hc = new HcAdapter(bin);
  hc.start();
  try {
    for (let i = 0; i < 400 && !hc.terminals.get("t1"); i++) await wait(5);
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "working");
    // Must flip to "done" promptly (< 350ms) despite noisy doc events every 80ms.
    for (let i = 0; i < 70 && HcAdapter.status(hc.terminals.get("t1")!) !== "done"; i++) await wait(10);
    assert.equal(HcAdapter.status(hc.terminals.get("t1")!), "done");
  } finally {
    hc.stop();
  }
});
