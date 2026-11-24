import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Relay } from "../src/server.ts";

const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

test("Relay release cache fetches, verifies SHA256SUMS, serves Range 206, hits local disk after upstream stops, and prunes to 3 versions", async () => {
  const payload = randomBytes(128 * 1024 + 321);
  const assetName = "herdr-pocket-0.2.33-macos-arm64.dmg";
  const goodDigest = sha256(payload);
  let hits = 0;

  const files = new Map<string, Buffer>([
    ["/v0.2.30/SHA256SUMS", Buffer.from(`${sha256(Buffer.from("v30"))}  herdr-pocket-0.2.30-macos-arm64.dmg\n`)],
    ["/v0.2.30/herdr-pocket-0.2.30-macos-arm64.dmg", Buffer.from("v30")],
    ["/v0.2.31/SHA256SUMS", Buffer.from(`${sha256(Buffer.from("v31"))}  herdr-pocket-0.2.31-macos-arm64.dmg\n`)],
    ["/v0.2.31/herdr-pocket-0.2.31-macos-arm64.dmg", Buffer.from("v31")],
    ["/v0.2.32/SHA256SUMS", Buffer.from(`${sha256(Buffer.from("v32"))}  herdr-pocket-0.2.32-macos-arm64.dmg\n`)],
    ["/v0.2.32/herdr-pocket-0.2.32-macos-arm64.dmg", Buffer.from("v32")],
    ["/v0.2.33/SHA256SUMS", Buffer.from(`${goodDigest}  ${assetName}\n${"0".repeat(64)}  herdr-pocket-0.2.33-windows-x64.msi\n`)],
    [`/v0.2.33/${assetName}`, payload],
    ["/v0.2.33/herdr-pocket-0.2.33-windows-x64.msi", Buffer.from("tampered-binary")],
  ]);

  const upstream = createServer((req, res) => {
    const body = files.get(req.url ?? "");
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    if ((req.url ?? "").endsWith(assetName)) hits += 1;
    res.writeHead(200, { "Content-Length": body.length });
    res.end(body);
  });
  const upstreamPort = await new Promise<number>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port)));
  const cacheDir = tempDir("pocket-rel-cache-");
  const dbDir = tempDir("pocket-rel-db-");
  const relay = new Relay({
    dbPath: join(dbDir, "relay.db"),
    releaseCacheDir: cacheDir,
    releaseUpstreamBases: [`http://127.0.0.1:${upstreamPort}`],
    log: () => {},
  });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;

  try {
    // Path traversal / invalid asset rejected
    const badReq = await fetch(`${base}/v1/releases/download/v0.2.33/..%2Fsecret`);
    assert.equal(badReq.status, 400);

    // Mismatched checksum asset rejected with 502 and not persisted
    const badHashRes = await fetch(`${base}/v1/releases/download/v0.2.33/herdr-pocket-0.2.33-windows-x64.msi`);
    assert.equal(badHashRes.status, 502);
    assert.equal(existsSync(join(cacheDir, "v0.2.33", "herdr-pocket-0.2.33-windows-x64.msi")), false);

    // Concurrent requests coalesce to a single upstream fetch and return verified bytes
    const [r1, r2] = await Promise.all([
      fetch(`${base}/v1/releases/download/v0.2.33/${assetName}`),
      fetch(`${base}/v1/releases/download/v0.2.33/${assetName}`),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r1.headers.get("accept-ranges"), "bytes");
    const b1 = Buffer.from(await r1.arrayBuffer());
    const b2 = Buffer.from(await r2.arrayBuffer());
    assert.deepEqual(b1, payload);
    assert.deepEqual(b2, payload);
    assert.equal(hits, 1);

    // Close upstream completely; cached reads + Range 206 still succeed
    await new Promise<void>((resolve) => upstream.close(() => resolve()));

    const headRes = await fetch(`${base}/v1/releases/download/v0.2.33/${assetName}`, { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(Number(headRes.headers.get("content-length")), payload.length);

    const rangeRes = await fetch(`${base}/v1/releases/download/v0.2.33/${assetName}`, {
      headers: { Range: "bytes=0-65535" },
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get("content-range"), `bytes 0-65535/${payload.length}`);
    assert.equal(Number(rangeRes.headers.get("content-length")), 65536);
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    assert.deepEqual(rangeBuf, payload.subarray(0, 65536));

    const oobRes = await fetch(`${base}/v1/releases/download/v0.2.33/${assetName}`, {
      headers: { Range: `bytes=${payload.length + 10}-${payload.length + 20}` },
    });
    assert.equal(oobRes.status, 416);

    // Reopen a temporary upstream to test pruning > 3 versions
    const up2 = createServer((req, res) => {
      const body = files.get(req.url ?? "");
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Length": body.length });
      res.end(body);
    });
    const p2 = await new Promise<number>((resolve) => up2.listen(0, "127.0.0.1", () => resolve((up2.address() as { port: number }).port)));
    const cacheDir2 = tempDir("pocket-rel-prune-");
    const relay2 = new Relay({
      dbPath: join(tempDir("pocket-rel-db2-"), "relay.db"),
      releaseCacheDir: cacheDir2,
      releaseUpstreamBases: [`http://127.0.0.1:${p2}`],
      log: () => {},
    });
    const port2 = await relay2.listen(0, "127.0.0.1");
    try {
      for (const ver of ["0.2.30", "0.2.31", "0.2.32", "0.2.33"]) {
        const res = await fetch(`http://127.0.0.1:${port2}/v1/releases/download/v${ver}/herdr-pocket-${ver}-macos-arm64.dmg`);
        assert.equal(res.status, 200);
        await res.arrayBuffer();
      }
      const cachedDirs = readdirSync(cacheDir2).filter((d) => d.startsWith("v"));
      assert.equal(cachedDirs.length, 3);
      assert.ok(cachedDirs.includes("v0.2.33"));
    } finally {
      await relay2.close();
      await new Promise<void>((resolve) => up2.close(() => resolve()));
    }
  } finally {
    await relay.close();
  }
});
