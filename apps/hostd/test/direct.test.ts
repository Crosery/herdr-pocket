import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { DIRECT_FROM_HOST, DIRECT_FROM_PHONE, DIRECT_PATH, DirectCipher, directNonce, jsChaCha20Poly1305, utf8Decode, utf8Encode, type DirectAead, type DirectOffer } from "@herdr-pocket/protocol";
import { WebSocket } from "ws";
import { Host } from "../src/host.ts";
import { directAddrs, nodeAead } from "../src/direct.ts";
import type { ScreenLines } from "../src/hcscreen.ts";

/** The app's implementation (the same library the phone uses). */
const nobleAead: DirectAead = {
  seal: (key, nonce, plain) => chacha20poly1305(key, nonce).encrypt(plain),
  open: (key, nonce, sealed) => {
    try {
      return chacha20poly1305(key, nonce).decrypt(sealed);
    } catch {
      return null;
    }
  },
};

test("the computer's and the app's ChaCha20-Poly1305 open each other's frames, and match RFC 8439", () => {
  // RFC 8439 section 2.8.2 (AEAD test vector, with its AAD left out: we use none).
  const key = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
  const nonce = Uint8Array.from([7, 0, 0, 0, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
  const text = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
  const a = nodeAead.seal(key, nonce, utf8Encode(text));
  const b = nobleAead.seal(key, nonce, utf8Encode(text));
  const c = jsChaCha20Poly1305.seal(key, nonce, utf8Encode(text));
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  assert.deepEqual(Buffer.from(a), Buffer.from(c));
  assert.equal(Buffer.from(a.subarray(0, 8)).toString("hex"), "d31a8d34648e60db");
  assert.equal(utf8Decode(nobleAead.open(key, nonce, a)!), text);
  assert.equal(utf8Decode(jsChaCha20Poly1305.open(key, nonce, a)!), text);
  assert.equal(utf8Decode(nodeAead.open(key, nonce, b)!), text);
  assert.equal(utf8Decode(nodeAead.open(key, nonce, c)!), text);
  const bad = Uint8Array.from(a);
  bad[3]! ^= 1;
  assert.equal(nodeAead.open(key, nonce, bad), null);
  assert.equal(nobleAead.open(key, nonce, bad), null);
  assert.equal(jsChaCha20Poly1305.open(key, nonce, bad), null);

  for (const len of [0, 1, 15, 16, 17, 64, 1300]) {
    const sample = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
    const jsSealed = jsChaCha20Poly1305.seal(key, nonce, sample);
    const nodeSealed = nodeAead.seal(key, nonce, sample);
    assert.deepEqual(Buffer.from(jsSealed), Buffer.from(nodeSealed), `seal mismatch at length ${len}`);
    assert.deepEqual(Buffer.from(jsChaCha20Poly1305.open(key, nonce, nodeSealed)!), Buffer.from(sample));
    assert.deepEqual(Buffer.from(nodeAead.open(key, nonce, jsSealed)!), Buffer.from(sample));
  }
});

test("frames carry their direction and count: the app's and the computer's ciphers talk, a replay does not open", () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  const phone = new DirectCipher(nobleAead, key, DIRECT_FROM_PHONE);
  const host = new DirectCipher(nodeAead, key, DIRECT_FROM_HOST);
  const one = phone.seal("一 first");
  const two = phone.seal("二 second");
  assert.equal(host.open(one), "一 first");
  assert.equal(host.open(one), null, "the same frame again is refused");
  assert.equal(host.open(two), "二 second");
  assert.equal(phone.open(host.seal("back")), "back");
  assert.equal(phone.open(phone.seal("mine")), null, "a frame cannot be reflected back to its sender");
  assert.deepEqual([...directNonce(2, 258)], [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
});

test("UTF-8 without a platform codec gives the same bytes as Node's", () => {
  const g = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown };
  const saved = [g.TextEncoder, g.TextDecoder];
  const s = "ascii 中文 emoji \u{1F600} é";
  const want = Buffer.from(s, "utf8");
  try {
    g.TextEncoder = undefined;
    g.TextDecoder = undefined;
    assert.deepEqual(Buffer.from(utf8Encode(s)), want);
    assert.equal(utf8Decode(new Uint8Array(want)), s);
  } finally {
    [g.TextEncoder, g.TextDecoder] = saved;
  }
});

test("addresses offered: LAN first, then VPN, no loopback, link-local, or fake-IP TUN", () => {
  const nets = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    utun4: [{ address: "100.77.43.217", family: "IPv4", internal: false }],
    utun9: [
      { address: "198.18.0.1", family: "IPv4", internal: false },
      { address: "198.19.1.2", family: "IPv4", internal: false },
    ],
    en0: [{ address: "192.168.8.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
    en9: [{ address: "169.254.3.4", family: "IPv4", internal: false }],
  } as never;
  assert.deepEqual(directAddrs(nets), ["192.168.8.20", "100.77.43.217"]);
});

type Frame = { type: string; id?: string; result?: any; error?: any; event?: any; device?: string; t?: number };

/** A host with direct links on a free port and one hc agent whose screen watch the test drives. */
async function directHost() {
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "host1", name: "test", directPort: 0 }, log: () => {} });
  const x = h as unknown as {
    agents: unknown[];
    collect: () => unknown[];
    send: (f: Frame) => void;
    handlers: Record<string, (p: unknown, from: string) => Promise<unknown>>;
    startDirect: () => Promise<void>;
  };
  const agents = [{ key: "host1/hc:t1", localId: "t1", source: "hc", deviceId: "host1", status: "working" }];
  x.agents = agents;
  x.collect = () => agents;
  const relay: Frame[] = [];
  x.send = (f) => relay.push(f);
  const watches: Array<{ paint: (s: ScreenLines) => void; stopped: boolean }> = [];
  h.hc.watch = async (_a, _h, paint) => {
    const w = { paint, stopped: false };
    watches.push(w);
    return () => void (w.stopped = true);
  };
  await x.startDirect();
  const offer = (from = "phone1") => x.handlers["direct.offer"]!({}, from) as Promise<DirectOffer>;
  return { h, relay, watches, offer };
}

/** The phone's side of a direct link, with the app's cipher. */
function dial(o: DirectOffer, ticket = o.ticket) {
  const cipher = new DirectCipher(nobleAead, new Uint8Array(Buffer.from(o.key, "base64")), DIRECT_FROM_PHONE);
  const ws = new WebSocket(`ws://127.0.0.1:${o.port}${DIRECT_PATH}?ticket=${ticket}`);
  const got: Frame[] = [];
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  const refused = new Promise<number>((r) => ws.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0)));
  ws.on("error", () => {});
  ws.on("message", (d) => {
    const t = cipher.open(new Uint8Array(d as Buffer));
    got.push(t === null ? { type: "UNREADABLE" } : (JSON.parse(t) as Frame));
  });
  const send = (f: object) => ws.send(cipher.seal(JSON.stringify(f)));
  const next = async (pred: (f: Frame) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    for (;;) {
      const f = got.find(pred);
      if (f) return f;
      if (Date.now() > end) assert.fail(`no frame matched; got ${JSON.stringify(got)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ws, send, next, got, closed, refused, cipher };
}

test("a phone with a ticket talks to the computer directly: calls, pings and streams, never via the relay", async (t) => {
  const { h, relay, watches, offer } = await directHost();
  t.after(() => h.stop());
  const o = await offer();
  assert.ok(o.port > 0 && o.ticket.length === 32 && Buffer.from(o.key, "base64").length === 32);

  const p = dial(o);
  assert.equal((await p.next((f) => f.type === "welcome")).device, "host1", "the computer proves it holds the key");
  p.send({ type: "rpc", id: "r1", to: "host1", method: "agents.list", params: {} });
  const r = await p.next((f) => f.id === "r1");
  assert.equal(r.type, "rpc_result");
  assert.equal(r.result.agents[0].key, "host1/hc:t1");
  p.send({ type: "ping", t: 42 });
  assert.equal((await p.next((f) => f.type === "pong")).t, 42);

  p.send({ type: "stream_subscribe", id: "s1", to: "host1", stream: "terminal", params: { agent: "host1/hc:t1" } });
  assert.equal((await p.next((f) => f.type === "stream_open")).id, "s1", "the phone sees its own stream id");
  watches[0]!.paint({ lines: ["hello"], text: "hello", cols: 80, rows: 1 } as ScreenLines);
  const ev = await p.next((f) => f.type === "stream_event");
  assert.equal(ev.id, "s1");
  assert.deepEqual(relay.filter((f) => f.type !== "log"), [], "nothing went through the relay");

  // The link closes: its streams stop.
  p.ws.close();
  await p.closed;
  for (let i = 0; i < 100 && !watches[0]!.stopped; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(watches[0]!.stopped);
});

test("no ticket, a used ticket, a wrong key or a replayed frame gets nothing", async (t) => {
  const { h, offer } = await directHost();
  t.after(() => h.stop());
  const o = await offer();
  assert.equal(await dial(o, "0".repeat(32)).refused, 401);

  const first = dial(o);
  await first.next((f) => f.type === "welcome");
  assert.equal(await dial(o).refused, 401, "a ticket opens one link only");

  // Replay: the same sealed bytes sent twice.
  const sealed = first.cipher.seal(JSON.stringify({ type: "ping", t: 1 }));
  first.ws.send(sealed);
  first.ws.send(sealed);
  assert.equal(await first.closed, 4003);

  // Wrong key: a ticket of its own, frames sealed with another key.
  const o2 = await offer();
  const wrong = dial({ ...o2, key: Buffer.alloc(32, 9).toString("base64") });
  assert.equal((await wrong.next((f) => f.type === "UNREADABLE")).type, "UNREADABLE", "the phone cannot read a computer that lacks the key");
  wrong.send({ type: "rpc", id: "x", to: "host1", method: "agents.list", params: {} });
  assert.equal(await wrong.closed, 4003);
});

test("a ticket is bound to the phone the relay authenticated; streams of a direct link survive the relay going away", async (t) => {
  const { h, watches, offer } = await directHost();
  t.after(() => h.stop());
  const p = dial(await offer("phone7"));
  await p.next((f) => f.type === "welcome");
  p.send({ type: "stream_subscribe", id: "s9", to: "host1", stream: "terminal", params: { agent: "host1/hc:t1" } });
  await p.next((f) => f.type === "stream_open");
  const meta = (h as unknown as { streamMeta: Map<string, { from: string }> }).streamMeta;
  assert.deepEqual([...meta.values()].map((m) => m.from), ["phone7"]);
  // What the relay link's close does to streams.
  (h as unknown as { stopStreams: (w: (id: string) => boolean) => void }).stopStreams((id) => !(h as unknown as { streamReply: Map<string, unknown> }).streamReply.has(id));
  assert.equal(watches[0]!.stopped, false);
  assert.equal(meta.size, 1);
});
