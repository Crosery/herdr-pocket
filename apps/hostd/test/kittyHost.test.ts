import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KittyHostStream } from "../src/kittyHost.ts";

const tmp = mkdtempSync(join(tmpdir(), "kitty-host-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function makeSamplePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  return buf;
}

test("KittyHostStream passes normal PTY bytes with zero copy", () => {
  const stream = new KittyHostStream();
  const plain = Buffer.from("hello world\r\n");
  const res = stream.push(plain);
  assert.equal(res.outBytes, plain);
  assert.deepEqual(res.autoReplies, []);
});

test("KittyHostStream answers a=q queries immediately on host and rewrites q=2 downstream", () => {
  const stream = new KittyHostStream();
  const res = stream.push(Buffer.from("before\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\after"));
  assert.deepEqual(
    res.autoReplies.map((b) => b.toString("utf8")),
    ["\x1b_Gi=31;OK\x1b\\"],
  );
  const out = res.outBytes.toString("utf8");
  assert.match(out, /^before\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24,q=2;AAAA\x1b\\after$/);
});

test("KittyHostStream unlinks t=t temp probe on a=q and avoids duplicate reply when split across chunks", () => {
  const stream = new KittyHostStream();
  const probeFile = join(tmp, "tty-graphics-protocol-probe");
  writeFileSync(probeFile, "x");
  const apc = `\x1b_Ga=q,t=t,i=9;${Buffer.from(probeFile).toString("base64")}\x1b\\`;
  const p1 = stream.push(Buffer.from(apc.slice(0, 12)));
  assert.equal(p1.autoReplies.length, 0);
  const p2 = stream.push(Buffer.from(apc.slice(12)));
  assert.deepEqual(
    p2.autoReplies.map((b) => b.toString("utf8")),
    ["\x1b_Gi=9;OK\x1b\\"],
  );
  assert.equal(existsSync(probeFile), false);
});

test("KittyHostStream inlines t=f host PNG into t=d,q=2 with dimensions and replies OK immediately", () => {
  const stream = new KittyHostStream();
  const pngPath = join(tmp, "logo.png");
  const pngBytes = makeSamplePng(320, 240);
  writeFileSync(pngPath, pngBytes);
  const b64Path = Buffer.from(pngPath).toString("base64");
  const res = stream.push(Buffer.from(`X\x1b_Ga=T,f=100,t=f,i=7,c=20,r=12;${b64Path}\x1b\\Y`));
  assert.deepEqual(
    res.autoReplies.map((b) => b.toString("utf8")),
    ["\x1b_Gi=7;OK\x1b\\"],
  );
  const out = res.outBytes.toString("utf8");
  assert.ok(out.startsWith("X\x1b_G"));
  assert.ok(out.endsWith("Y"));
  assert.ok(out.includes("t=d,f=100,q=2,s=320,v=240;"));
  assert.ok(out.includes(pngBytes.toString("base64")));
});

test("KittyHostStream rejects blocked paths and non-image files with ENOENT reply", () => {
  const stream = new KittyHostStream();
  const txtPath = join(tmp, "secret.txt");
  writeFileSync(txtPath, "not an image");
  const r1 = stream.push(Buffer.from(`\x1b_Ga=T,f=100,t=f,i=5;${Buffer.from(txtPath).toString("base64")}\x1b\\`));
  assert.deepEqual(
    r1.autoReplies.map((b) => b.toString("utf8")),
    ["\x1b_Gi=5;ENOENT:unable to open file\x1b\\"],
  );
  assert.equal(r1.outBytes.length, 0);

  const blockedDir = join(tmp, ".ssh");
  mkdirSync(blockedDir, { recursive: true });
  const fakePng = join(blockedDir, "id_rsa");
  writeFileSync(fakePng, makeSamplePng(16, 16));
  const r2 = stream.push(Buffer.from(`\x1b_Ga=T,f=100,t=f,i=6;${Buffer.from(fakePng).toString("base64")}\x1b\\`));
  assert.deepEqual(
    r2.autoReplies.map((b) => b.toString("utf8")),
    ["\x1b_Gi=6;ENOENT:unable to open file\x1b\\"],
  );
  assert.equal(r2.outBytes.length, 0);
});
