import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcScreens } from "../src/hcscreen.ts";

/** These fakes are shell scripts: Windows can't run them (CI there runs the rest). */
const SH = { skip: process.platform === "win32" && "shell-script fakes" };

/** A framed `hc connect` stand-in: records attach params and the bytes typed on the stream. */
function fakeHc(dir: string, firstPaint = "first paint", attachDelayMs = 0): { bin: string; typed: string; attaches: string } {
  const bin = join(dir, "hc");
  const typed = join(dir, "typed");
  const attaches = join(dir, "attaches");
  writeFileSync(typed, "");
  writeFileSync(attaches, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const H = 9;
const frame = (ch, kind, p) => { const h = Buffer.alloc(H); h.writeUInt32LE(ch, 0); h[4] = kind; h.writeUInt32LE(p.length, 5); return Buffer.concat([h, p]); };
let buf = Buffer.alloc(0), framed = false;
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  if (!framed) {
    const nl = buf.indexOf(10); if (nl < 0) return;
    buf = buf.subarray(nl + 1); framed = true;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { features: ["framed"] } }) + "\\n");
  }
  while (buf.length >= H) {
    const ch = buf.readUInt32LE(0), kind = buf[4], len = buf.readUInt32LE(5);
    if (buf.length < H + len) return;
    const p = buf.subarray(H, H + len); buf = buf.subarray(H + len);
    if (ch === 0) {
      const m = JSON.parse(p.toString());
      appendFileSync(${JSON.stringify(attaches)}, JSON.stringify(m.params) + "\\n");
      const sendAttach = () => {
        process.stdout.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { channel: 7, automatic_input: true, terminal: { cols: m.params.cols, rows: m.params.rows } } }))));
        process.stdout.write(frame(7, 0, Buffer.from(${JSON.stringify(firstPaint)})));
      };
      if (${attachDelayMs} > 0) setTimeout(sendAttach, ${attachDelayMs});
      else sendAttach();
    } else if (ch === 7 && kind === 0) appendFileSync(${JSON.stringify(typed)}, p);
    else if (ch === 7 && kind === 2) appendFileSync(${JSON.stringify(typed)}, "<CLOSE>");
  }
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, typed, attaches };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("typing goes out at once, in order, on one stream at the terminal's own size", SH, async () => {
  const f = fakeHc(mkdtempSync(join(tmpdir(), "hc-framed-")));
  const screens = new HcScreens(f.bin);
  try {
    await Promise.all([screens.input("t1", "abc你好", 202, 47), screens.input("t1", "\x7f", 202, 47)]);
    await screens.input("t1", "!\r", 202, 47);
    await wait(150);
    assert.equal(readFileSync(f.typed, "utf8"), "abc你好\x7f!\r");
    const attaches = readFileSync(f.attaches, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(attaches.length, 1, "one stream for a burst of typing");
    assert.deepEqual({ ...attaches[0] }, { terminal: "t1", cols: 202, rows: 47, observe: false, resumed: true });
  } finally {
    screens.stop();
  }
});

test("paste wraps text with bracketed paste (?2004h) or plain text (?2004l) and presses Enter immediately", SH, async () => {
  const bracketed = fakeHc(mkdtempSync(join(tmpdir(), "hc-paste-bp-")), "\x1b[?2004h> ");
  const screensBp = new HcScreens(bracketed.bin);
  try {
    const t0 = Date.now();
    await screensBp.paste("t1", "line1\nline2", 120, 40, true);
    assert.ok(Date.now() - t0 < 500, "stream paste should complete promptly");
    await wait(50);
    assert.equal(readFileSync(bracketed.typed, "utf8"), "\x1b[200~line1\rline2\x1b[201~\r");
  } finally {
    screensBp.stop();
  }

  const plain = fakeHc(mkdtempSync(join(tmpdir(), "hc-paste-plain-")), "\x1b[?2004l$ ");
  const screensPlain = new HcScreens(plain.bin);
  try {
    await screensPlain.paste("t1", "line1\r\nline2", 120, 40, true);
    await wait(50);
    assert.equal(readFileSync(plain.typed, "utf8"), "line1\nline2\r");
  } finally {
    screensPlain.stop();
  }

  // Slow spawn/attach (>35ms) still waits for post-attach firstPaint and detects ?2004h cleanly.
  const slow = fakeHc(mkdtempSync(join(tmpdir(), "hc-paste-slow-")), "\x1b[?2004h❯ ", 60);
  const screensSlow = new HcScreens(slow.bin);
  try {
    await screensSlow.paste("t1", "继续", 120, 40, true);
    await wait(50);
    assert.equal(readFileSync(slow.typed, "utf8"), "\x1b[200~继续\x1b[201~\r");
  } finally {
    screensSlow.stop();
  }
});
