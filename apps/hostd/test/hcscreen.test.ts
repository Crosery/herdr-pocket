import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcScreens } from "../src/hcscreen.ts";
import { Screen, charWidth } from "../src/vt.ts";

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

test("vt Screen treats U+10EEEE as width 1 and Kitty combining diacritics as width 0 without column drift", () => {
  assert.equal(charWidth(0x10eeee), 1);
  for (const cp of [0x0305, 0x030d, 0x0483, 0x1dc0, 0x20d0, 0xa8e0, 0xfe20, 0x10a0f, 0x1d185, 0x1d244]) {
    assert.equal(charWidth(cp), 0, `expected zero width for U+${cp.toString(16)}`);
  }

  const ph = String.fromCodePoint(0x10eeee);
  const d0 = String.fromCodePoint(0x0305);
  const d30 = String.fromCodePoint(0x0483);
  const d296 = String.fromCodePoint(0x1d244);

  const screen = new Screen(24, 5);
  // Emit a 7x3 avatar placeholder block using both BMP and astral Kitty diacritics, followed by column-7 labels.
  screen.write(
    [
      `\x1b_Ga=p,U=1,q=2,i=9,c=7,r=3\x1b\\\x1b[38;2;0;0;9m${(ph + d0 + d30).repeat(7)}\x1b[39;59m coordinator`,
      `\x1b[38;2;0;0;9m${(ph + d30 + d296).repeat(7)}\x1b[39;59m btw-slash`,
      `\x1b[38;2;0;0;9m${(ph + d296 + d0).repeat(7)}\x1b[39;59m monitor`,
    ].join("\r\n"),
  );

  const lines = screen.toText().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.endsWith(" coordinator"));
  assert.ok(lines[1]!.endsWith(" btw-slash"));
  assert.ok(lines[2]!.endsWith(" monitor"));
  // Verify exact column index (7 placeholder cells + 1 space = index 8 in codepoints)
  assert.equal([...lines[0]!.slice(0, lines[0]!.indexOf(" "))].filter((ch) => ch.codePointAt(0) === 0x10eeee).length, 7);
});

test("HcScreens swallows EPIPE / broken child stdin errors cleanly without crashing hostd", SH, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-epipe-"));
  const bin = join(dir, "hc");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
process.stdin.destroy();
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  const screens = new HcScreens(bin);
  try {
    await assert.rejects(screens.resize("t1", 80, 24), /exited|lost hc|failed/i);
  } finally {
    screens.stop();
  }
});
