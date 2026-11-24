import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { extractScannedPair } from "../src/lib/h5Identity.ts";

const require = createRequire(new URL("../package.json", import.meta.url));

test("extractScannedPair parses /p/ links, app deep links, H5 ?pair= links, bare codes, and rejects unrelated QRs", () => {
  assert.deepEqual(extractScannedPair("https://pocket.example.com/p/MEOW-4821"), {
    server: "https://pocket.example.com",
    code: "MEOW-4821",
  });
  assert.deepEqual(extractScannedPair("https://pocket.example.com/pocket/p/bark1024"), {
    server: "https://pocket.example.com/pocket",
    code: "BARK-1024",
  });
  assert.deepEqual(extractScannedPair("herdrpocket://pair?server=https%3A%2F%2Fpocket.example.com%2Fpocket&code=purr9001"), {
    server: "https://pocket.example.com/pocket",
    code: "PURR-9001",
  });
  assert.deepEqual(extractScannedPair("https://pocket.example.com/pocket/app/?pair=meow4821"), {
    server: "https://pocket.example.com/pocket",
    code: "MEOW-4821",
  });
  assert.deepEqual(extractScannedPair("/pocket/app/?pair=meow7777", "https://pocket.example.com/pocket/app/"), {
    server: "https://pocket.example.com/pocket",
    code: "MEOW-7777",
  });
  assert.deepEqual(extractScannedPair("WOOF-5566"), {
    code: "WOOF-5566",
  });
  assert.equal(extractScannedPair("https://example.com/not-a-pair-qr"), null);
  assert.equal(extractScannedPair(""), null);
});

test("qrcode PNG buffer decodes end-to-end through jsQR and extractScannedPair", async () => {
  const QRCode = require("qrcode") as {
    toBuffer: (text: string, opts?: Record<string, unknown>) => Promise<Buffer>;
  };
  const jsQRMod = require("jsqr") as {
    default?: (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
  };
  const jsQR = (jsQRMod.default ?? jsQRMod) as (
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ) => { data: string } | null;
  const qrRequire = createRequire(require.resolve("qrcode"));
  const { PNG } = qrRequire("pngjs") as {
    PNG: { sync: { read: (buf: Buffer) => { width: number; height: number; data: Buffer } } };
  };

  const pngBuf = await QRCode.toBuffer("https://pocket.example.com/pocket/p/MEOW-4821", {
    width: 320,
    margin: 4,
    color: { dark: "#111111", light: "#FFFFFF" },
  });
  const decodedPng = PNG.sync.read(pngBuf);
  const hit = jsQR(new Uint8ClampedArray(decodedPng.data), decodedPng.width, decodedPng.height);
  assert.ok(hit, "jsQR decodes generated QR PNG buffer");
  assert.deepEqual(extractScannedPair(hit.data), {
    server: "https://pocket.example.com/pocket",
    code: "MEOW-4821",
  });
});
