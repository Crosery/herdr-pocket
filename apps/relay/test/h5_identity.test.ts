import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createHash, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { Relay } from "../src/server.ts";

const ADMIN = "test-admin-token-0123456789abcdef";
const PUBLIC = "https://pocket.example.com/pocket";
const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "pocket-h5-"));
  dirs.push(dir);
  return join(dir, "relay.db");
}

function toB64Url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? Buffer.from(buf) : Buffer.from(new Uint8Array(buf));
  return b.toString("base64url");
}

test("H5 /app subpath redirect and static bundle serving work under reverse-proxy subpaths", async () => {
  const relay = new Relay({ dbPath: tempDb(), adminToken: ADMIN, publicUrl: PUBLIC, log: () => {} });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  try {
    const redir = await fetch(`${base}/app?pair=MEOW-1234`, { redirect: "manual" });
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get("location"), `${PUBLIC}/app/?pair=MEOW-1234`);

    const htmlRes = await fetch(`${base}/app/`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
    const html = await htmlRes.text();
    assert.ok(html.includes("./assets/"), "uses relative asset paths for subpath safety");

    const assetMatch = /\.\/(assets\/[^"'\s]+\.(?:js|css))/.exec(html);
    assert.ok(assetMatch, "built H5 index.html references an asset under ./assets/");
    const assetRes = await fetch(`${base}/app/${assetMatch[1]}`);
    assert.equal(assetRes.status, 200);
    const assetBody = await assetRes.text();
    assert.ok(assetBody.length > 0);

    const manifestRes = await fetch(`${base}/app/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get("content-type") ?? "", /manifest\+json/);
    const manifestJson = (await manifestRes.json()) as { display?: string; start_url?: string };
    assert.equal(manifestJson.display, "standalone");
    assert.equal(manifestJson.start_url, "./");

    const swRes = await fetch(`${base}/app/sw.js`);
    assert.equal(swRes.status, 200);
    assert.equal(swRes.headers.get("service-worker-allowed"), "./");
    assert.equal(swRes.headers.get("cache-control"), "no-cache");

    const pwaIconRes = await fetch(`${base}/app/assets/brand/pwa-192.png`);
    assert.equal(pwaIconRes.status, 200);
    assert.match(pwaIconRes.headers.get("content-type") ?? "", /image\/png/);
    const pwaIconBytes = await pwaIconRes.arrayBuffer();
    assert.ok(pwaIconBytes.byteLength > 1000);

    const jsMatch = /\.\/(assets\/index-[^"'\s]+\.js)/.exec(html);
    assert.ok(jsMatch, "built H5 index.html references main index bundle");
    const jsRes = await fetch(`${base}/app/${jsMatch[1]}`);
    assert.equal(jsRes.status, 200);
    const jsBody = await jsRes.text();
    assert.ok(jsBody.includes("摄像头扫码连接"), "built H5 bundle exposes camera scan UI");
    assert.ok(jsBody.includes("打开摄像头扫码"), "built H5 bundle exposes camera trigger button");
    assert.ok(jsBody.includes("选二维码图片"), "built H5 bundle exposes screenshot/photo QR picker");
    assert.ok(jsBody.includes("使用通行密钥确认唯一身份"), "built H5 bundle exposes Passkey identity modal");
    assert.ok(!jsBody.includes("让已登录的手机或电脑扫码放行"), "built H5 bundle removes reverse-QR join section");
  } finally {
    await relay.close();
  }
});

test("H5 ECDSA P-256 identity proof & anchor cookie recover identity without duplicate viewer devices", async () => {
  const relay = new Relay({ dbPath: tempDb(), adminToken: ADMIN, publicUrl: PUBLIC, log: () => {} });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  try {
    const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const spki = toB64Url(await webcrypto.subtle.exportKey("spki", kp.publicKey));

    const code1Res = await fetch(`${base}/v1/pair/codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "viewer" }),
    });
    const code1 = (await code1Res.json()) as { code: string };

    const ts1 = Date.now();
    const sig1 = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      kp.privateKey,
      new TextEncoder().encode(`herdr-pocket-id-v1:${ts1}:${spki}`),
    );
    const pair1Res = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code1.code,
        name: "iPhone · Safari (H5)",
        kind: "viewer",
        platform: "h5-ios",
        via: "qr",
        identity: {
          identityPubKey: spki,
          proofSignature: toB64Url(sig1),
          proofTimestamp: ts1,
          uaPlatform: "h5-ios",
          formFactor: "mobile",
        },
      }),
    });
    assert.equal(pair1Res.status, 200);
    const pair1 = (await pair1Res.json()) as { device: { id: string; name: string }; token: string };
    const setCookie = pair1Res.headers.get("set-cookie");
    assert.ok(setCookie && setCookie.includes("hp_anchor="), "issues HttpOnly hp_anchor identity cookie");
    const cookieHeader = setCookie.split(";")[0]!;

    const hintRes = await fetch(`${base}/v1/identity/hint`, { headers: { Cookie: cookieHeader } });
    assert.equal(hintRes.status, 200);
    const hint = (await hintRes.json()) as { anchored: boolean; deviceId?: string };
    assert.equal(hint.anchored, true);
    assert.equal(hint.deviceId, pair1.device.id);

    // Simulate clearing localStorage and recovering via keypair challenge-response.
    const chRes = await fetch(`${base}/v1/identity/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(chRes.status, 200);
    const ch = (await chRes.json()) as { challenge: string };
    const recSig = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      kp.privateKey,
      new TextEncoder().encode(`herdr-pocket-reconfirm-v1:${ch.challenge}:${spki}`),
    );
    const recRes = await fetch(`${base}/v1/identity/reconfirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({
        challenge: ch.challenge,
        identityPubKey: spki,
        signature: toB64Url(recSig),
        platform: "h5-ios",
      }),
    });
    assert.equal(recRes.status, 200);
    const rec = (await recRes.json()) as { device: { id: string }; token: string };
    assert.equal(rec.device.id, pair1.device.id, "reconfirm reuses the original deviceId");
    assert.notEqual(rec.token, pair1.token, "reconfirm rotates device token");

    // Re-scanning a second pair code WITHOUT Authorization header still deduplicates by identityPubKey.
    const code2Res = await fetch(`${base}/v1/pair/codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "viewer" }),
    });
    const code2 = (await code2Res.json()) as { code: string };
    const ts2 = Date.now();
    const sig2 = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      kp.privateKey,
      new TextEncoder().encode(`herdr-pocket-id-v1:${ts2}:${spki}`),
    );
    const pair2Res = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code2.code,
        name: "iPhone · Safari (H5) New",
        kind: "viewer",
        platform: "h5-ios",
        via: "qr",
        identity: {
          identityPubKey: spki,
          proofSignature: toB64Url(sig2),
          proofTimestamp: ts2,
        },
      }),
    });
    assert.equal(pair2Res.status, 200);
    const pair2 = (await pair2Res.json()) as { device: { id: string }; token: string };
    assert.equal(pair2.device.id, pair1.device.id, "fresh /v1/pair without token deduplicates by identityPubKey");

    const devsRes = await fetch(`${base}/v1/devices`, {
      headers: { Authorization: `Bearer ${pair2.token}` },
    });
    assert.equal(devsRes.status, 200);
    const devsBody = (await devsRes.json()) as { devices: Array<{ id: string; kind: string }> };
    const viewers = devsBody.devices.filter((d) => d.kind === "viewer");
    assert.equal(viewers.length, 1, "only 1 viewer device exists in store");
    assert.equal(viewers[0]!.id, pair1.device.id);
  } finally {
    await relay.close();
  }
});

test("H5 WebAuthn Passkey options, registration, and reconfirm merge temporary viewer into original identity", async () => {
  const relay = new Relay({ dbPath: tempDb(), adminToken: ADMIN, publicUrl: PUBLIC, log: () => {} });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  try {
    const codeARes = await fetch(`${base}/v1/pair/codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "viewer" }),
    });
    const codeA = (await codeARes.json()) as { code: string };
    const pairARes = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: codeA.code,
        name: "iPhone · Safari (Passkey Primary)",
        kind: "viewer",
        platform: "h5-ios",
        via: "qr",
      }),
    });
    assert.equal(pairARes.status, 200);
    const viewerA = (await pairARes.json()) as { device: { id: string; passkeyLinked?: boolean }; token: string };

    const optRes = await fetch(`${base}/v1/identity/passkey/options`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewerA.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(optRes.status, 200);
    const opt = (await optRes.json()) as {
      challenge: string;
      rp: { id: string };
      authenticatorSelection?: { residentKey?: string; requireResidentKey?: boolean; userVerification?: string };
    };
    assert.equal(opt.rp.id, "pocket.example.com");
    assert.equal(opt.authenticatorSelection?.residentKey, "preferred");
    assert.equal(opt.authenticatorSelection?.userVerification, "preferred");

    const passkeyKp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const passkeySpki = toB64Url(passkeyKp.publicKey.export({ type: "spki", format: "der" }));
    const regClientData = toB64Url(
      Buffer.from(
        JSON.stringify({
          type: "webauthn.create",
          challenge: opt.challenge,
          origin: "https://pocket.example.com",
        }),
      ),
    );
    const regRes = await fetch(`${base}/v1/identity/passkey/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewerA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        challenge: opt.challenge,
        credId: "cred-passkey-1",
        publicKeySpki: passkeySpki,
        clientDataJSON: regClientData,
      }),
    });
    assert.equal(regRes.status, 200);
    const regBody = (await regRes.json()) as { device: { id: string; passkeyLinked?: boolean } };
    assert.equal(regBody.device.id, viewerA.device.id);
    assert.equal(regBody.device.passkeyLinked, true);

    // Pair a temporary second viewer (e.g., user scanned QR on a brand-new browser) then switch back via Passkey.
    const codeBRes = await fetch(`${base}/v1/pair/codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "viewer" }),
    });
    const codeB = (await codeBRes.json()) as { code: string };
    const pairBRes = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: codeB.code,
        name: "Mac · Chrome (Temp Session)",
        kind: "viewer",
        platform: "h5-macos",
        via: "qr",
      }),
    });
    assert.equal(pairBRes.status, 200);
    const viewerB = (await pairBRes.json()) as { device: { id: string }; token: string };
    assert.notEqual(viewerB.device.id, viewerA.device.id);

    const chRes = await fetch(`${base}/v1/identity/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(chRes.status, 200);
    const ch = (await chRes.json()) as { challenge: string; rpId: string };

    const authData = Buffer.concat([
      createHash("sha256").update(ch.rpId, "utf8").digest(),
      Buffer.from([0x05, 0, 0, 0, 1]),
    ]);
    const assertionClientBuf = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: ch.challenge,
        origin: "https://pocket.example.com",
      }),
    );
    const clientHash = createHash("sha256").update(assertionClientBuf).digest();
    const sig = sign("sha256", Buffer.concat([authData, clientHash]), passkeyKp.privateKey);

    const reconfirmRes = await fetch(`${base}/v1/identity/reconfirm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${viewerB.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        challenge: ch.challenge,
        platform: "h5-macos",
        passkey: {
          id: "cred-passkey-1",
          rawId: toB64Url(Buffer.from("cred-passkey-1")),
          authenticatorData: toB64Url(authData),
          clientDataJSON: toB64Url(assertionClientBuf),
          signature: toB64Url(sig),
        },
      }),
    });
    assert.equal(reconfirmRes.status, 200);
    const reconfirmed = (await reconfirmRes.json()) as { device: { id: string; passkeyLinked?: boolean }; token: string };
    assert.equal(reconfirmed.device.id, viewerA.device.id);
    assert.equal(reconfirmed.device.passkeyLinked, true);

    const devsRes = await fetch(`${base}/v1/devices`, {
      headers: { Authorization: `Bearer ${reconfirmed.token}` },
    });
    assert.equal(devsRes.status, 200);
    const devsBody = (await devsRes.json()) as { devices: Array<{ id: string; kind: string }> };
    const viewers = devsBody.devices.filter((d) => d.kind === "viewer");
    assert.equal(viewers.length, 1, "temporary viewer B should be merged away cleanly");
    assert.equal(viewers[0]!.id, viewerA.device.id);

    const staleRes = await fetch(`${base}/v1/devices`, {
      headers: { Authorization: `Bearer ${viewerB.token}` },
    });
    assert.equal(staleRes.status, 401, "merged temporary viewer token is revoked");
  } finally {
    await relay.close();
  }
});
