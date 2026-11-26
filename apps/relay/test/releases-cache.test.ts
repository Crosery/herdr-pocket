import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { buildReleaseManifest, type ServerFrame } from "@herdr-pocket/protocol";
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

test("Relay /v1/releases/latest, welcome.serverVersion, and WebSocket release_update track upstream upgrades", async () => {
  let latestVer = "99.1.0";
  const upstream = createServer((req, res) => {
    const u = req.url ?? "";
    const makeManifest = (ver: string) =>
      JSON.stringify(
        buildReleaseManifest({
          releaseVersion: ver,
          sums: {
            [`herdr-pocket-${ver}-macos-arm64.dmg`]: sha256(Buffer.from(`dmg-${ver}`)),
            [`herdr-pocket-${ver}-android-arm64.apk`]: sha256(Buffer.from(`apk-${ver}`)),
          },
        }),
      );
    if (u === "/latest/RELEASE-MANIFEST.json") {
      const body = makeManifest(latestVer);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }).end(body);
      return;
    }
    if (u === "/v99.1.0/RELEASE-MANIFEST.json" || u === "/v99.2.0/RELEASE-MANIFEST.json") {
      const v = u.slice(2, 8);
      const body = makeManifest(v);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }).end(body);
      return;
    }
    if (u === "/latest/RELEASE-NOTES.md") {
      const body = `# Notes ${latestVer}\n- Ready ${latestVer}`;
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) }).end(body);
      return;
    }
    if (u === "/v99.1.0/RELEASE-NOTES.md" || u === "/v99.2.0/RELEASE-NOTES.md") {
      const v = u.slice(2, 8);
      const body = `# Notes ${v}\n- Ready ${v}`;
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) }).end(body);
      return;
    }
    res.writeHead(404).end();
  });
  const upPort = await new Promise<number>((resolve) =>
    upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port)),
  );
  const adminToken = "admin-rel-watch-0123456789abcdef";
  const relay = new Relay({
    dbPath: join(tempDir("pocket-rel-latest-db-"), "relay.db"),
    adminToken,
    releaseCacheDir: tempDir("pocket-rel-latest-cache-"),
    releaseUpstreamBases: [`http://127.0.0.1:${upPort}`],
    releasePollIntervalMs: 75,
    log: () => {},
  });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;

  try {
    const codeRes = await fetch(`${base}/v1/pair/codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ kind: "viewer" }),
    });
    const { code } = (await codeRes.json()) as { code: string };
    const pairRes = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "RelWatch Viewer", kind: "viewer" }),
    });
    const { token } = (await pairRes.json()) as { token: string };

    const frames: ServerFrame[] = [];
    const waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(token)}`);
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as ServerFrame;
      frames.push(f);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(f)) {
          const w = waiters.splice(i, 1)[0]!;
          w.resolve(f);
        }
      }
    });
    const nextFrame = (pred: (f: ServerFrame) => boolean, ms = 3000) => {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<ServerFrame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    };

    const welcome = await nextFrame((f) => f.type === "welcome");
    assert.equal(welcome.type, "welcome");
    assert.match(welcome.serverVersion ?? "", /^\d+\.\d+\.\d+/);

    const firstRes = await fetch(`${base}/v1/releases/latest?refresh=1`);
    assert.equal(firstRes.status, 200);
    const firstJson = (await firstRes.json()) as { latest: string; notes: string };
    assert.equal(firstJson.latest, "99.1.0");
    assert.match(firstJson.notes, /Ready 99\.1\.0/);

    latestVer = "99.2.0";
    const pushFrame = await nextFrame((f) => f.type === "release_update" && f.version === "99.2.0");
    assert.equal(pushFrame.type, "release_update");

    const latestRes = await fetch(`${base}/v1/releases/latest`);
    const latestJson = (await latestRes.json()) as { latest: string; notes: string };
    assert.equal(latestJson.latest, "99.2.0");
    assert.match(latestJson.notes, /Ready 99\.2\.0/);
    ws.terminate();
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
