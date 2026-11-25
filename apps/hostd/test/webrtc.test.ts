import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import {
  DIRECT_PING_PATH,
  WEBRTC_BIN_CHUNK_BYTES,
  WEBRTC_GET_CHANNEL,
  WEBRTC_PUT_CHANNEL,
  WEBRTC_RPC_CHANNEL,
  type Agent,
} from "@herdr-pocket/protocol";
import { Host } from "../src/host.ts";
import { splitWebRtcRpcPayload } from "../src/webrtc.ts";

function agent(root: string): Agent {
  return {
    key: "d/herdr:t1",
    deviceId: "d",
    source: "herdr",
    localId: "t1",
    name: "t1",
    harness: "claude-code",
    status: "idle",
    isShell: false,
    cwd: root,
    updatedAt: 1,
  };
}

function createClientRpcReceiver(dc: RTCDataChannel) {
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{ pred: (f: Record<string, unknown>) => boolean; resolve: (f: Record<string, unknown>) => void }> = [];
  const partials = new Map<string, { total: number; parts: Array<string | undefined>; received: number }>();

  const pushFrame = (frame: Record<string, unknown>) => {
    const idx = waiters.findIndex((w) => w.pred(frame));
    if (idx >= 0) {
      const [w] = waiters.splice(idx, 1);
      w!.resolve(frame);
      return;
    }
    frames.push(frame);
  };

  dc.onMessage.subscribe((raw) => {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let frame = JSON.parse(text) as Record<string, unknown>;
    if (frame.type === "__chunk") {
      const id = String(frame.id);
      const idx = Number(frame.idx);
      const total = Number(frame.total);
      const part = String(frame.part);
      let entry = partials.get(id);
      if (!entry) {
        entry = { total, parts: new Array(total), received: 0 };
        partials.set(id, entry);
      }
      if (entry.parts[idx] === undefined) {
        entry.parts[idx] = part;
        entry.received += 1;
      }
      if (entry.received < entry.total) return;
      partials.delete(id);
      frame = JSON.parse(entry.parts.join("")) as Record<string, unknown>;
    }
    pushFrame(frame);
  });

  const next = (pred: (f: Record<string, unknown>) => boolean, timeoutMs = 5000) => {
    const existing = frames.findIndex(pred);
    if (existing >= 0) return Promise.resolve(frames.splice(existing, 1)[0]!);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolveWrap);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("timed out waiting for WebRTC RPC frame"));
      }, timeoutMs);
      const resolveWrap = (f: Record<string, unknown>) => {
        clearTimeout(t);
        resolve(f);
      };
      waiters.push({ pred, resolve: resolveWrap });
    });
  };

  return { next };
}

test("splitWebRtcRpcPayload keeps UTF-8 multibyte chunks safely within SCTP frame limits", () => {
  const cjk = "你好世界测试文本".repeat(5000); // 40k chars (~120 KB UTF-8)
  const parts = splitWebRtcRpcPayload(cjk, 32_000, 44 * 1024);
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(Buffer.byteLength(p, "utf8") <= 44 * 1024);
  }
  assert.equal(parts.join(""), cjk);
});

test("DirectServer /v1/direct-ping and WebRTC DataChannels handle RPC chunking, streams, hp-put upload, and hp-get download", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-webrtc-"));
  const h = new Host({
    config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test-host", directPort: 0 },
    log: () => {},
  });
  h.filesDir = root;
  h.agents = [agent(root)];
  (h.webrtc as unknown as { opts: { iceServers?: Array<{ urls: string }> } }).opts.iceServers = [];

  const x = h as unknown as {
    handlers: Record<string, (p: unknown, from: string) => Promise<any>>;
    startDirect: () => Promise<void>;
  };

  const clientPc = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
  });

  try {
    await x.startDirect();

    // 1. Direct HTTP /v1/direct-ping probe check
    const pingRes = await fetch(`http://127.0.0.1:${h.direct.port}${DIRECT_PING_PATH}`);
    assert.equal(pingRes.status, 200);
    assert.equal(pingRes.headers.get("x-pocket-host"), "d");
    assert.equal(await pingRes.text(), "ok");

    // 2. Establish WebRTC PeerConnection via webrtc.offer handler
    const rpcDc = clientPc.createDataChannel(WEBRTC_RPC_CHANNEL, { ordered: true });
    const rpcOpen = new Promise<void>((resolve) => {
      if (rpcDc.readyState === "open") resolve();
      else rpcDc.stateChanged.subscribe((s) => s === "open" && resolve());
    });
    const rpcRx = createClientRpcReceiver(rpcDc);

    const offer = await clientPc.createOffer();
    await clientPc.setLocalDescription(offer);
    const answer = await x.handlers["webrtc.offer"]!({ type: "offer", sdp: clientPc.localDescription!.sdp }, "phone-1");
    assert.equal(answer.type, "answer");
    assert.ok(answer.peerId);
    await clientPc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await rpcOpen;

    // 3. welcome + ping/pong
    const welcome = await rpcRx.next((f) => f.type === "welcome");
    assert.equal(welcome.device, "d");
    rpcDc.send(JSON.stringify({ type: "ping", t: 12345 }));
    const pong = await rpcRx.next((f) => f.type === "pong");
    assert.equal(pong.t, 12345);

    // 4. Large multibyte RPC response (>200 KB UTF-8) over __chunk framing
    const bigText = "中文日志片段-".repeat(16_000); // ~304 KB UTF-8
    writeFileSync(join(root, "big.txt"), bigText, "utf8");
    rpcDc.send(JSON.stringify({ type: "rpc", id: "r-big", method: "files.read", params: { agent: "d/herdr:t1", path: "big.txt", maxBytes: 512 * 1024 } }));
    const bigRes = await rpcRx.next((f) => f.type === "rpc_result" && f.id === "r-big", 10_000);
    assert.equal(bigRes.error, undefined);
    assert.equal((bigRes.result as { text: string }).text, bigText);

    // 5. Stream subscribe over WebRTC RPC channel
    rpcDc.send(JSON.stringify({ type: "stream_subscribe", id: "s-portal", stream: "portal", params: {} }));
    const sOpen = await rpcRx.next((f) => f.type === "stream_open" && f.id === "s-portal");
    assert.equal(sOpen.error, undefined);
    rpcDc.send(JSON.stringify({ type: "stream_unsubscribe", id: "s-portal" }));

    // 6. Binary multi-chunk upload over "hp-put" (>256 KB random bytes)
    const upBytes = randomBytes(280 * 1024);
    const begin = await x.handlers["terminal.putBegin"]!(
      { agent: "d/herdr:t1", name: "webrtc-upload.bin", mime: "application/octet-stream", totalBytes: upBytes.length },
      "phone-1",
    );
    const putDc = clientPc.createDataChannel(WEBRTC_PUT_CHANNEL, { ordered: true });
    const putDone = await new Promise<number>((resolve, reject) => {
      putDc.stateChanged.subscribe((st) => {
        if (st === "open") {
          putDc.send(JSON.stringify({ type: "put", token: begin.directToken }));
        }
      });
      putDc.onMessage.subscribe((raw) => {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as {
          type: string;
          receivedBytes?: number;
          message?: string;
        };
        if (msg.type === "ready") {
          for (let off = 0; off < upBytes.length; off += WEBRTC_BIN_CHUNK_BYTES) {
            putDc.send(upBytes.subarray(off, Math.min(upBytes.length, off + WEBRTC_BIN_CHUNK_BYTES)));
          }
          putDc.send(JSON.stringify({ type: "eof" }));
        } else if (msg.type === "done") {
          resolve(msg.receivedBytes ?? 0);
        } else if (msg.type === "error") {
          reject(new Error(msg.message || "put error"));
        }
      });
    });
    assert.equal(putDone, upBytes.length);
    const fin = await x.handlers["terminal.putFinish"]!({ uploadId: begin.uploadId }, "phone-1");
    assert.equal(
      createHash("sha256").update(readFileSync(fin.path)).digest("hex"),
      createHash("sha256").update(upBytes).digest("hex"),
    );
    putDc.close();

    // 7. Binary multi-chunk download over "hp-get" (full + range)
    const downBytes = randomBytes(290 * 1024);
    writeFileSync(join(root, "webrtc-download.bin"), downBytes);
    const ticket = await x.handlers["portal.fileTicket"]!(
      { agent: "d/herdr:t1", path: "webrtc-download.bin", cwd: root },
      "phone-1",
    );

    const runGet = (range?: { start: number; end: number }) =>
      new Promise<{ meta: Record<string, unknown>; data: Buffer }>((resolve, reject) => {
        const getDc = clientPc.createDataChannel(WEBRTC_GET_CHANNEL, { ordered: true });
        let meta: Record<string, unknown> | null = null;
        const chunks: Buffer[] = [];
        getDc.stateChanged.subscribe((st) => {
          if (st === "open") {
            getDc.send(JSON.stringify({ type: "get", token: ticket.token, ...(range ?? {}) }));
          }
        });
        getDc.onMessage.subscribe((raw) => {
          if (typeof raw === "string") {
            const msg = JSON.parse(raw) as Record<string, unknown>;
            if (msg.type === "meta") {
              meta = msg;
            } else if (msg.type === "eof") {
              getDc.close();
              resolve({ meta: meta!, data: Buffer.concat(chunks) });
            } else if (msg.type === "error") {
              reject(new Error(String(msg.message || "get error")));
            }
          } else {
            chunks.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
          }
        });
      });

    const fullGet = await runGet();
    assert.equal(fullGet.meta.size, downBytes.length);
    assert.equal(
      createHash("sha256").update(fullGet.data).digest("hex"),
      createHash("sha256").update(downBytes).digest("hex"),
    );

    const sliceStart = 4096;
    const sliceEnd = 4096 + 70_000 - 1;
    const rangeGet = await runGet({ start: sliceStart, end: sliceEnd });
    assert.equal(rangeGet.data.length, 70_000);
    assert.equal(rangeGet.data.equals(downBytes.subarray(sliceStart, sliceEnd + 1)), true);
  } finally {
    await clientPc.close().catch(() => {});
    h.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
