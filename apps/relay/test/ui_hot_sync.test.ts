import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
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

function buildTarGz(files: Array<{ name: string; content: string | Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    const header = Buffer.alloc(512, 0);
    const nameBytes = Buffer.from(f.name, "utf8");
    assert.ok(nameBytes.length <= 100, `test tar entry path too long: ${f.name}`);
    nameBytes.copy(header, 0);
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i]!;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header);
    if (data.length > 0) {
      const rem = data.length % 512;
      const padded = rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem, 0)]);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

test("Relay hot-syncs verified web/dist and admin/dist bundles before broadcasting release_update and restores across restart", async () => {
  const ver = "99.3.0";
  const tarballName = `herdr-pocket-${ver}.tar.gz`;
  const h5Html = '<!doctype html><html><head><script type="module" src="./assets/index-HOT99300.js"></script></head><body>h5-hot-99.3.0</body></html>';
  const adminHtml = '<!doctype html><html><head><script type="module" src="./admin-assets/index-ADM99300.js"></script></head><body>admin-hot-99.3.0</body></html>';
  const tarball = buildTarGz([
    { name: `herdr-pocket-${ver}/apps/relay/src/web/dist/index.html`, content: h5Html },
    { name: `herdr-pocket-${ver}/apps/relay/src/web/dist/assets/index-HOT99300.js`, content: "console.log('h5-99.3.0');" },
    { name: `herdr-pocket-${ver}/apps/relay/src/admin/dist/index.html`, content: adminHtml },
    { name: `herdr-pocket-${ver}/apps/relay/src/admin/dist/admin-assets/index-ADM99300.js`, content: "console.log('admin-99.3.0');" },
  ]);
  const tarSha = sha256(tarball);
  const sumsText = `${tarSha}  ${tarballName}\n`;
  const manifest = JSON.stringify(
    buildReleaseManifest({
      releaseVersion: ver,
      sums: { [tarballName]: tarSha },
    }),
  );

  let publishUpgrade = false;
  const upstream = createServer((req, res) => {
    const u = req.url ?? "";
    if (!publishUpgrade) {
      res.writeHead(404).end();
      return;
    }
    if (u === "/latest/RELEASE-MANIFEST.json" || u === `/v${ver}/RELEASE-MANIFEST.json`) {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(manifest) }).end(manifest);
      return;
    }
    if (u === `/v${ver}/SHA256SUMS` || u === "/latest/SHA256SUMS") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(sumsText) }).end(sumsText);
      return;
    }
    if (u === `/v${ver}/${tarballName}`) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": tarball.length }).end(tarball);
      return;
    }
    res.writeHead(404).end();
  });
  const upPort = await new Promise<number>((resolve) =>
    upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port)),
  );

  const dbPath = join(tempDir("pocket-hot-ui-db-"), "relay.db");
  const cacheDir = tempDir("pocket-hot-ui-cache-");
  const adminToken = "admin-hot-sync-token-0123456789abcdef";

  const relay1 = new Relay({
    dbPath,
    adminToken,
    releaseCacheDir: cacheDir,
    releaseUpstreamBases: [`http://127.0.0.1:${upPort}`],
    releasePollIntervalMs: 75,
    autoSyncUiBundles: true,
    log: () => {},
  });
  const port1 = await relay1.listen(0, "127.0.0.1");
  const base1 = `http://127.0.0.1:${port1}`;

  try {
    const codeRes = await fetch(`${base1}/v1/pair/codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ kind: "viewer" }),
    });
    const { code } = (await codeRes.json()) as { code: string };
    const pairRes = await fetch(`${base1}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "HotSync Phone", kind: "viewer" }),
    });
    const { token } = (await pairRes.json()) as { token: string };

    const ws = new WebSocket(`${base1.replace("http", "ws")}/v1/ws?token=${encodeURIComponent(token)}`);
    const releasePromise = new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for release_update")), 4000);
      ws.on("message", (d) => {
        const f = JSON.parse(d.toString()) as ServerFrame;
        if (f.type === "release_update" && f.version === ver) {
          clearTimeout(timer);
          resolve(f);
        }
      });
    });

    publishUpgrade = true;
    await releasePromise;
    ws.terminate();

    const h5Page = await (await fetch(`${base1}/app/`)).text();
    assert.equal(h5Page, h5Html);
    const h5Js = await (await fetch(`${base1}/app/assets/index-HOT99300.js`)).text();
    assert.equal(h5Js, "console.log('h5-99.3.0');");

    const admPage = await (await fetch(`${base1}/admin`)).text();
    assert.equal(admPage, adminHtml);
    const admJs = await (await fetch(`${base1}/admin-assets/index-ADM99300.js`)).text();
    assert.equal(admJs, "console.log('admin-99.3.0');");

    const ovRes = await fetch(`${base1}/v1/admin/overview`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const ov = (await ovRes.json()) as { uiVersion?: string };
    assert.equal(ov.uiVersion, ver);
  } finally {
    await relay1.close();
  }

  // Stop upstream completely and start a fresh Relay pointing at the same DB/cache: restored automatically from disk.
  await new Promise<void>((r) => upstream.close(() => r()));
  const relay2 = new Relay({
    dbPath,
    adminToken,
    releaseCacheDir: cacheDir,
    releasePollIntervalMs: 0,
    autoSyncUiBundles: true,
    log: () => {},
  });
  const port2 = await relay2.listen(0, "127.0.0.1");
  const base2 = `http://127.0.0.1:${port2}`;
  try {
    const restoredH5 = await (await fetch(`${base2}/app/`)).text();
    const restoredAdmin = await (await fetch(`${base2}/admin`)).text();
    assert.equal(restoredH5, h5Html);
    assert.equal(restoredAdmin, adminHtml);
  } finally {
    await relay2.close();
  }
});
