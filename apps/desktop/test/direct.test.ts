import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import {
  DIRECT_FROM_HOST,
  DirectCipher,
  type DirectAead,
} from "@herdr-pocket/protocol";
import { DirectLink } from "../src/lib/direct.ts";

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

test("DirectLink prefers 127.0.0.1 for localHost and exchanges encrypted RPC + stream frames", async () => {
  const savedWs = globalThis.WebSocket;
  const key = randomBytes(32);
  const hostCipher = new DirectCipher(nodeAead, key, DIRECT_FROM_HOST);
  const urlsDialed: string[] = [];
  const receivedStreams: unknown[] = [];

  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeSocket.OPEN;
    binaryType = "arraybuffer";
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
      urlsDialed.push(url);
      queueMicrotask(() => {
        const welcome = hostCipher.seal(JSON.stringify({ type: "welcome", device: "host-local" }));
        this.onmessage?.({ data: Uint8Array.from(welcome).buffer });
      });
    }

    send(data: Uint8Array) {
      const text = hostCipher.open(data);
      assert.ok(text !== null, "host must decrypt client frame");
      const msg = JSON.parse(text) as { type: string; id: string; method?: string };
      if (msg.type === "rpc") {
        const res = hostCipher.seal(JSON.stringify({ type: "rpc_result", id: msg.id, result: { echoed: msg.method } }));
        this.onmessage?.({ data: Uint8Array.from(res).buffer });
      } else if (msg.type === "stream_subscribe") {
        const opened = hostCipher.seal(JSON.stringify({ type: "stream_open", id: msg.id, result: { live: true } }));
        const evt = hostCipher.seal(JSON.stringify({ type: "stream_event", id: msg.id, event: { kind: "tick" } }));
        this.onmessage?.({ data: Uint8Array.from(opened).buffer });
        this.onmessage?.({ data: Uint8Array.from(evt).buffer });
      }
    }

    close() {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.({ code: 1000 });
    }
  }

  (globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket;
  try {
    let closedCalled = false;
    const link = await DirectLink.open(
      "host-local",
      {
        port: 7498,
        addrs: ["192.168.1.50"],
        ticket: "tkt",
        key: key.toString("base64"),
        expiresAt: Date.now() + 60_000,
      },
      {
        onStream: (frame) => receivedStreams.push(frame),
        onClose: () => {
          closedCalled = true;
        },
      },
      true,
    );

    assert.equal(link.addr, "127.0.0.1");
    assert.ok(urlsDialed[0]?.startsWith("ws://127.0.0.1:7498/v1/direct?ticket=tkt"));
    const rpcRes = await link.call("host.info", {});
    assert.deepEqual(rpcRes, { echoed: "host.info" });

    assert.equal(link.subscribe("s1", "session", { key: "k" }), true);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(receivedStreams.length, 2);
    link.close();
    assert.equal(closedCalled, true);
  } finally {
    globalThis.WebSocket = savedWs;
  }
});
