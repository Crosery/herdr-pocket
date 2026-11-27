import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { DIRECT_FROM_HOST, DirectCipher, type DirectAead } from "@herdr-pocket/protocol";
import { DirectError, DirectLink, SAFE_AGAIN } from "../src/lib/direct.ts";
import {
  classifyLatency,
  describeHostTransport,
  isOlderVersion,
  summarizeDirectError,
} from "../src/lib/networkMeta.ts";

const nodeAead: DirectAead = {
  seal(key, nonce, plain) {
    const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  },
  open(key, nonce, sealed) {
    if (sealed.length < 16) return null;
    try {
      const tag = sealed.subarray(sealed.length - 16);
      const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
      d.setAuthTag(tag);
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    } catch {
      return null;
    }
  },
};

test("SAFE_AGAIN includes safe upload, resize, and port probe RPCs", () => {
  for (const method of [
    "terminal.put",
    "terminal.putBegin",
    "terminal.putAbort",
    "terminal.resize",
    "agent.ports",
  ] as const) {
    assert.equal(SAFE_AGAIN.has(method), true, `expected ${method} in SAFE_AGAIN`);
  }
  // terminal.send stays out of SAFE_AGAIN (only replayed on uncertain === false or bypassed pre-send)
  assert.equal(SAFE_AGAIN.has("terminal.send"), false);
});

test("DirectLink evicts stalled link after consecutive RPC timeouts even when one-way stream frames arrive", async () => {
  const savedWs = globalThis.WebSocket;
  const key = randomBytes(32);
  const hostCipher = new DirectCipher(nodeAead, key, DIRECT_FROM_HOST);
  let activeSocket: FakeSocket | null = null;

  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeSocket.OPEN;
    bufferedAmount = 0;
    binaryType = "arraybuffer";
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(_url: string) {
      activeSocket = this;
      queueMicrotask(() => {
        const welcome = hostCipher.seal(JSON.stringify({ type: "welcome", device: "host-a" }));
        this.onmessage?.({ data: Uint8Array.from(welcome).buffer });
      });
    }

    send(_data: Uint8Array) {
      // Simulate wedged client->host path: host never replies with pong or rpc_result.
    }

    pushOneWayStream() {
      const evt = hostCipher.seal(JSON.stringify({ type: "stream_event", id: "s1", event: { kind: "tick" } }));
      this.onmessage?.({ data: Uint8Array.from(evt).buffer });
    }

    close() {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
  }

  (globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket;
  try {
    let closedCount = 0;
    let streamCount = 0;
    const link = await DirectLink.open(
      "host-a",
      {
        port: 7499,
        addrs: ["127.0.0.1"],
        ticket: "tkt",
        key: key.toString("base64"),
        expiresAt: Date.now() + 60_000,
      },
      {
        onStream: () => {
          streamCount += 1;
        },
        onClose: () => {
          closedCount += 1;
        },
      },
      true,
    );

    assert.equal(link.open, true);
    assert.equal(link.isCongested(), false);

    // One-way stream arrives, proving the link receives server pushes while RPCs still hang.
    activeSocket!.pushOneWayStream();
    assert.equal(streamCount, 1);

    // First RPC timeout marks the link congested immediately.
    await assert.rejects(() => link.call("session.children", { agent: "a" }, 35), (err: unknown) => {
      assert.ok(err instanceof DirectError);
      assert.equal(err.code, "timeout");
      assert.equal(err.uncertain, true);
      return true;
    });
    assert.equal(link.isCongested(), true);

    // Second consecutive RPC timeout evicts the zombie link automatically.
    await assert.rejects(() => link.call("session.children", { agent: "a" }, 35), (err: unknown) => {
      assert.ok(err instanceof DirectError);
      assert.equal(err.code, "timeout");
      return true;
    });
    assert.equal(link.open, false);
    assert.equal(closedCount, 1);

    // Subsequent calls on the closed link report uncertain === false (zero bytes sent -> safe to replay via relay).
    await assert.rejects(() => link.call("terminal.send", { agent: "a", text: "hi" }, 35), (err: unknown) => {
      assert.ok(err instanceof DirectError);
      assert.equal(err.code, "offline");
      assert.equal(err.uncertain, false);
      return true;
    });
  } finally {
    globalThis.WebSocket = savedWs;
  }
});

test("DirectLink.measureRtt resolves RTT and notifies onRtt callback", async () => {
  const savedWs = globalThis.WebSocket;
  const key = randomBytes(32);
  const hostCipher = new DirectCipher(nodeAead, key, DIRECT_FROM_HOST);

  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeSocket.OPEN;
    bufferedAmount = 0;
    binaryType = "arraybuffer";
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(_url: string) {
      queueMicrotask(() => {
        const welcome = hostCipher.seal(JSON.stringify({ type: "welcome", device: "host-rtt" }));
        this.onmessage?.({ data: Uint8Array.from(welcome).buffer });
      });
    }

    send(data: Uint8Array) {
      const text = hostCipher.open(data);
      if (!text) return;
      const msg = JSON.parse(text) as { type: string; t?: number };
      if (msg.type === "ping") {
        setTimeout(() => {
          const pong = hostCipher.seal(JSON.stringify({ type: "pong", t: msg.t }));
          this.onmessage?.({ data: Uint8Array.from(pong).buffer });
        }, 8);
      }
    }

    close() {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
  }

  (globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket;
  try {
    const rttEvents: number[] = [];
    const link = await DirectLink.open(
      "host-rtt",
      {
        port: 7499,
        addrs: ["127.0.0.1"],
        ticket: "tkt",
        key: key.toString("base64"),
        expiresAt: Date.now() + 60_000,
      },
      {
        onStream: () => {},
        onClose: () => {},
        onRtt: (_l, rtt) => rttEvents.push(rtt),
      },
      true,
    );

    const measured = await link.measureRtt(1000);
    assert.ok(typeof measured === "number" && measured >= 1);
    assert.ok(rttEvents.length >= 1);
    assert.equal(link.getRttMs(), measured);
    link.close();
  } finally {
    globalThis.WebSocket = savedWs;
  }
});

test("networkMeta classifies transports, latency quality, direct errors, and older hostd versions", () => {
  assert.equal(describeHostTransport("127.0.0.1", undefined).label, "本地直连");
  assert.equal(
    describeHostTransport("100.64.0.10", { addr: "100.64.0.10", linkKind: "vpn-p2p", rttMs: 14 }).label,
    "VPN 直连",
  );
  assert.equal(
    describeHostTransport("WebRTC P2P", { addr: "WebRTC P2P", linkKind: "webrtc-p2p", rttMs: 36 }).label,
    "WebRTC P2P",
  );
  assert.equal(describeHostTransport(undefined, undefined).label, "中继转发");

  assert.equal(classifyLatency(null).level, "unknown");
  assert.equal(classifyLatency(28).level, "good");
  assert.equal(classifyLatency(140).level, "warn");
  assert.equal(classifyLatency(380).level, "high");

  assert.match(summarizeDirectError("native tunnel unavailable for 192.168.1.1") ?? "", /跨网段|中继转发/);
  assert.match(summarizeDirectError("WebRTC P2P 握手超时") ?? "", /WebRTC/);

  assert.equal(isOlderVersion("0.2.53", "0.2.58"), true);
  assert.equal(isOlderVersion("0.2.58", "0.2.58"), false);
  assert.equal(isOlderVersion("0.2.59", "0.2.58"), false);
});

test("SocketClient does not abort an in-flight CONNECTING WebSocket on window focus", async () => {
  const { startRelayLink, stopRelayLink } = await import("../src/lib/relay.ts");
  const { liveStore } = await import("../src/lib/store.ts");

  const savedWs = globalThis.WebSocket;
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  const listeners = new Map<string, Set<() => void>>();
  let createdCount = 0;
  let closedCount = 0;

  class SlowConnectWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = SlowConnectWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
      if (url.includes("/v1/ws")) {
        createdCount += 1;
      }
    }

    send(_data: string) {}

    close() {
      if (this.readyState === SlowConnectWebSocket.CLOSED) return;
      this.readyState = SlowConnectWebSocket.CLOSED;
      closedCount += 1;
    }
  }

  (globalThis as unknown as { WebSocket: typeof SlowConnectWebSocket }).WebSocket = SlowConnectWebSocket;
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener(ev: string, fn: () => void) {
      let s = listeners.get(ev);
      if (!s) {
        s = new Set();
        listeners.set(ev, s);
      }
      s.add(fn);
    },
    removeEventListener(ev: string, fn: () => void) {
      listeners.get(ev)?.delete(fn);
    },
  };
  (globalThis as unknown as { document: unknown }).document = {
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener(ev: string, fn: () => void) {
      let s = listeners.get(`doc:${ev}`);
      if (!s) {
        s = new Set();
        listeners.set(`doc:${ev}`, s);
      }
      s.add(fn);
    },
    removeEventListener(ev: string, fn: () => void) {
      listeners.get(`doc:${ev}`)?.delete(fn);
    },
  };

  try {
    startRelayLink("https://pocket.example.com", "tok-test");
    assert.equal(createdCount, 1);
    assert.equal(liveStore.get().link, "connecting");

    // Simulate rapid focus & visibility wakes during a slow startup handshake.
    for (const fn of listeners.get("focus") ?? []) fn();
    for (const fn of listeners.get("doc:visibilitychange") ?? []) fn();
    await new Promise((r) => setTimeout(r, 20));

    // Must keep the single in-flight handshake alive instead of aborting and reconnecting.
    assert.equal(createdCount, 1);
    assert.equal(closedCount, 0);
  } finally {
    stopRelayLink();
    globalThis.WebSocket = savedWs;
    if (savedWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = savedWindow;
    if (savedDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = savedDocument;
  }
});
