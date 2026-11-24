import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "../src/server.ts";

const ADMIN = "test-admin-token-0123456789abcdef";
const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "pocket-vp-relay-"));
  dirs.push(dir);
  return join(dir, "relay.db");
}

test("Relay /v1/voiceprint requires auth and supports PUT, GET, DELETE round-trip", async () => {
  const relay = new Relay({ dbPath: tempDb(), adminToken: ADMIN, log: () => {} });
  const port = await relay.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  try {
    const unauth = await fetch(`${base}/v1/voiceprint`);
    assert.equal(unauth.status, 401);

    const headers = { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" };
    const initial = await fetch(`${base}/v1/voiceprint`, { headers });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { voiceprint: null });

    const invalid = await fetch(`${base}/v1/voiceprint`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ voiceprint: { embedding: [1, 2, 3] } }),
    });
    assert.equal(invalid.status, 400);

    const embedding = Array.from({ length: 192 }, (_, i) => Number(((i % 7) * 0.05).toFixed(4)));
    const putRes = await fetch(`${base}/v1/voiceprint`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        voiceprint: { embedding, prototypes: [embedding], modelVersion: "eres2netv2-voxlock-v2", seconds: 4.5 },
        sampleBase64: "AAAA",
      }),
    });
    assert.equal(putRes.status, 200);

    const fetched = await fetch(`${base}/v1/voiceprint`, { headers });
    assert.equal(fetched.status, 200);
    const body = (await fetched.json()) as { voiceprint: { embedding: number[]; seconds: number }; sampleBase64?: string; updatedAt?: number };
    assert.equal(body.voiceprint.embedding.length, 192);
    assert.equal(body.voiceprint.seconds, 4.5);
    assert.equal(body.sampleBase64, "AAAA");
    assert.equal(typeof body.updatedAt, "number");

    const delRes = await fetch(`${base}/v1/voiceprint`, { method: "DELETE", headers });
    assert.equal(delRes.status, 200);

    const afterDel = await fetch(`${base}/v1/voiceprint`, { headers });
    assert.equal(afterDel.status, 200);
    assert.deepEqual(await afterDel.json(), { voiceprint: null });
  } finally {
    await relay.close();
  }
});
