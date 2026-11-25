import { randomBytes } from "node:crypto";
import {
  DIRECT_FROM_HOST,
  WEBRTC_BIN_CHUNK_BYTES,
  WEBRTC_CHUNK_CHARS,
  WEBRTC_GET_CHANNEL,
  WEBRTC_PORTAL_CHANNEL,
  WEBRTC_PUT_CHANNEL,
  WEBRTC_RPC_CHANNEL,
  WEBRTC_STUN_URLS,
  type WebRtcAnswerResult,
  type WebRtcOfferParams,
} from "@herdr-pocket/protocol";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { directAddrs, type DirectPeer } from "./direct.ts";
import type { ChunkedPutManager, DirectUploadWriter } from "./put.ts";
import type { PortalFileTicketStore } from "./portal/p2pFiles.ts";

const RPC_MAX_UTF8_BYTES = 44 * 1024;
const RPC_MAX_PARTIAL_BYTES = 32 * 1024 * 1024;
const RPC_PARTIAL_TTL_MS = 30_000;
const PEER_IDLE_TIMEOUT_MS = 90_000;
const ICE_GATHER_WAIT_MS = 700;
const ICE_SRFLX_GRACE_MS = 120;
const DC_HIGH_WATER = 512 * 1024;
const DC_LOW_WATER = 256 * 1024;

interface PartialRpcChunk {
  total: number;
  parts: Array<string | undefined>;
  received: number;
  bytes: number;
  expiresAt: number;
}

export interface WebRtcDirectServerOptions {
  hostId: () => string;
  onOpen?: (peer: DirectPeer) => void;
  onFrame: (peer: DirectPeer, frame: Record<string, unknown>) => void;
  onClose: (peer: DirectPeer) => void;
  chunkedPut: ChunkedPutManager;
  portalTickets: PortalFileTicketStore;
  iceServers?: Array<{ urls: string }>;
  log?: (level: "info" | "warn", kind: string, msg: string, data?: Record<string, unknown>) => void;
}

/** Splits an outbound JSON string into SCTP-safe chunks when large or multibyte-dense. */
export function splitWebRtcRpcPayload(
  json: string,
  maxChars = WEBRTC_CHUNK_CHARS,
  maxBytes = RPC_MAX_UTF8_BYTES,
): string[] {
  if (json.length <= maxChars && Buffer.byteLength(json, "utf8") <= maxBytes) {
    return [json];
  }
  const parts: string[] = [];
  let start = 0;
  while (start < json.length) {
    let end = Math.min(json.length, start + maxChars);
    // Avoid splitting inside a UTF-16 surrogate pair.
    if (end < json.length && end > start + 1) {
      const code = json.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    while (end > start + 1 && Buffer.byteLength(json.slice(start, end), "utf8") > maxBytes) {
      end = start + Math.max(1024, Math.floor((end - start) * 0.6));
      if (end < json.length && end > start + 1) {
        const code = json.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
    }
    parts.push(json.slice(start, end));
    start = end;
  }
  return parts;
}

/** Filters virtual/TUN/link-local candidate lines from an SDP blob and appends missing gathered lines. */
export function sanitizeWebRtcSdp(sdp: string, extraCandidates: string[] = []): string {
  const lines = sdp.split("\r\n");
  const seen = new Set<string>();
  const kept: string[] = [];
  let eocIndex = -1;

  for (const line of lines) {
    if (line.startsWith("a=candidate:")) {
      const ipMatch = /^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+/.exec(line);
      const ip = ipMatch?.[1] ?? "";
      if (ip.startsWith("198.18.") || ip.startsWith("198.19.") || ip.startsWith("169.254.")) {
        continue;
      }
      seen.add(line);
    }
    if (line === "a=end-of-candidates" && eocIndex < 0) {
      eocIndex = kept.length;
    }
    kept.push(line);
  }

  const additions = extraCandidates.filter((line) => {
    if (seen.has(line)) return false;
    const ipMatch = /^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+/.exec(line);
    const ip = ipMatch?.[1] ?? "";
    if (ip.startsWith("198.18.") || ip.startsWith("198.19.") || ip.startsWith("169.254.")) {
      return false;
    }
    seen.add(line);
    return true;
  });

  if (additions.length > 0) {
    if (eocIndex >= 0) kept.splice(eocIndex, 0, ...additions);
    else {
      const trailingEmpty = kept.length > 0 && kept[kept.length - 1] === "";
      if (trailingEmpty) kept.splice(kept.length - 1, 0, ...additions);
      else kept.push(...additions);
    }
  }
  return kept.join("\r\n");
}

function sendJson(dc: RTCDataChannel, payload: unknown): boolean {
  if (dc.readyState !== "open") return false;
  try {
    dc.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

async function waitBufferedAmountBelow(dc: RTCDataChannel, threshold: number): Promise<void> {
  if (dc.readyState !== "open" || dc.bufferedAmount <= threshold) return;
  dc.bufferedAmountLowThreshold = threshold;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(guard);
      sub.unSubscribe();
      resolve();
    };
    const sub = dc.bufferedAmountLow.subscribe(() => {
      if (dc.readyState !== "open" || dc.bufferedAmount <= threshold) finish();
    });
    const poll = setInterval(() => {
      if (dc.readyState !== "open" || dc.bufferedAmount <= threshold) finish();
    }, 15);
    const guard = setTimeout(finish, 2000);
  });
}

interface ActivePeer {
  peerId: string;
  deviceId: string;
  pc: RTCPeerConnection;
  portalDc: RTCDataChannel | null;
  lastActiveAt: number;
  closed: boolean;
  cleanup: (reason?: string) => void;
}

export class WebRtcDirectServer {
  private opts: WebRtcDirectServerOptions;
  private peers = new Map<string, ActivePeer>();
  private seq = 0;
  private sweeper: NodeJS.Timeout;
  private stopped = false;

  constructor(opts: WebRtcDirectServerOptions) {
    this.opts = opts;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - PEER_IDLE_TIMEOUT_MS;
      for (const p of [...this.peers.values()]) {
        if (p.lastActiveAt < cutoff) {
          p.cleanup("idle timeout");
        }
      }
    }, 30_000);
    this.sweeper.unref?.();
  }

  connected(): string[] {
    return [...this.peers.values()].filter((p) => !p.closed).map((p) => p.deviceId);
  }

  async acceptOffer(deviceId: string, params: WebRtcOfferParams): Promise<WebRtcAnswerResult> {
    if (this.stopped) throw new Error("direct links are off");
    if (!params || params.type !== "offer" || typeof params.sdp !== "string" || !params.sdp.includes("v=0")) {
      throw new Error("无效的 WebRTC SDP offer");
    }

    const peerId = `rtc-${randomBytes(8).toString("hex")}`;
    const iceServers =
      this.opts.iceServers ?? (WEBRTC_STUN_URLS.map((urls) => ({ urls })) satisfies Array<{ urls: string }>);

    const pc = new RTCPeerConnection({
      iceServers,
      iceAdditionalHostAddresses: directAddrs(),
      iceUseIpv4: true,
      iceUseIpv6: false,
    });

    const active: ActivePeer = {
      peerId,
      deviceId,
      pc,
      portalDc: null,
      lastActiveAt: Date.now(),
      closed: false,
      cleanup: () => {},
    };
    const touch = () => {
      active.lastActiveAt = Date.now();
    };

    let rpcPeer: DirectPeer | null = null;
    let openedEmitted = false;
    let closedEmitted = false;

    const cleanup = (reason?: string) => {
      if (active.closed) return;
      active.closed = true;
      this.peers.delete(peerId);
      if (openedEmitted && !closedEmitted && rpcPeer) {
        closedEmitted = true;
        this.opts.onClose(rpcPeer);
      }
      if (reason) {
        this.opts.log?.("info", "direct", `webrtc peer closed ${deviceId} (${peerId}): ${reason}`);
      }
      void pc.close().catch(() => {});
    };
    active.cleanup = cleanup;

    // Limit total concurrent WebRTC peers per device (cap 8).
    const sameDev = [...this.peers.values()].filter((p) => p.deviceId === deviceId && !p.closed);
    while (sameDev.length >= 8) {
      const oldest = sameDev.shift();
      oldest?.cleanup("replaced");
    }
    this.peers.set(peerId, active);

    pc.connectionStateChange.subscribe((state) => {
      touch();
      if (state === "closed" || state === "failed") {
        cleanup(`connection ${state}`);
      }
    });

    pc.iceConnectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") {
        cleanup(`ice ${state}`);
      }
    });

    pc.onDataChannel.subscribe((dc) => {
      touch();
      if (dc.label === WEBRTC_RPC_CHANNEL) {
        this.attachRpcChannel(active, dc, touch, (peer) => {
          rpcPeer = peer;
          if (!openedEmitted) {
            openedEmitted = true;
            this.opts.onOpen?.(peer);
          }
        }, () => {
          cleanup("rpc channel closed");
        });
      } else if (dc.label === WEBRTC_PORTAL_CHANNEL) {
        active.portalDc = dc;
        dc.stateChanged.subscribe((state) => {
          if (state === "closed" || state === "closing") {
            if (active.portalDc === dc) active.portalDc = null;
          }
        });
        dc.onMessage.subscribe(() => {
          touch();
        });
      } else if (dc.label === WEBRTC_PUT_CHANNEL) {
        this.attachPutChannel(dc, touch);
      } else if (dc.label === WEBRTC_GET_CHANNEL) {
        this.attachGetChannel(dc, touch);
      }
    });

    const gatheredCandidates: string[] = [];
    let resolvedSrflx = false;
    let resolveWait: (() => void) | null = null;
    const waitDone = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    let srflxTimer: NodeJS.Timeout | null = null;

    pc.onIceCandidate.subscribe((cand) => {
      if (!cand) {
        resolveWait?.();
        return;
      }
      const line = cand.candidate.startsWith("a=") ? cand.candidate : `a=${cand.candidate}`;
      gatheredCandidates.push(line);
      if (!resolvedSrflx && /\styp\s+srflx\b/.test(line)) {
        resolvedSrflx = true;
        srflxTimer = setTimeout(() => resolveWait?.(), ICE_SRFLX_GRACE_MS);
        srflxTimer.unref?.();
      }
    });

    try {
      await pc.setRemoteDescription({ type: "offer", sdp: params.sdp });
      const answer = await pc.createAnswer();
      const setLocalPromise = pc.setLocalDescription(answer);

      let timeoutTimer: NodeJS.Timeout | null = null;
      await Promise.race([
        setLocalPromise,
        waitDone,
        new Promise<void>((resolve) => {
          timeoutTimer = setTimeout(resolve, ICE_GATHER_WAIT_MS);
          timeoutTimer.unref?.();
        }),
      ]);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (srflxTimer) clearTimeout(srflxTimer);

      const rawSdp = pc.localDescription?.sdp ?? answer.sdp;
      const finalSdp = sanitizeWebRtcSdp(rawSdp, gatheredCandidates);
      this.opts.log?.("info", "direct", `webrtc offer accepted for ${deviceId} (${peerId})`, {
        fromFlag: DIRECT_FROM_HOST,
        candidates: gatheredCandidates.length,
        hasSrflx: resolvedSrflx,
      });
      return { peerId, type: "answer", sdp: finalSdp };
    } catch (err) {
      cleanup(`offer error: ${(err as Error).message}`);
      throw err;
    }
  }

  private attachRpcChannel(
    active: ActivePeer,
    dc: RTCDataChannel,
    touch: () => void,
    onReady: (peer: DirectPeer) => void,
    onDone: () => void,
  ): void {
    const partials = new Map<string, PartialRpcChunk>();
    const tag = `webrtc${++this.seq}:`;
    let binSeq = 0;

    const peer: DirectPeer = {
      tag,
      deviceId: active.deviceId,
      transportKind: "webrtc",
      send: (frame) => {
        if (active.closed || dc.readyState !== "open") return;
        const json = JSON.stringify(frame);
        const parts = splitWebRtcRpcPayload(json);
        try {
          if (parts.length === 1) {
            dc.send(parts[0]!);
            return;
          }
          const id = randomBytes(6).toString("hex");
          for (let idx = 0; idx < parts.length; idx++) {
            dc.send(JSON.stringify({ type: "__chunk", id, idx, total: parts.length, part: parts[idx] }));
          }
        } catch {
          onDone();
        }
      },
      sendBinary: (bytes) => {
        if (active.closed) return;
        const targetDc = active.portalDc && active.portalDc.readyState === "open" ? active.portalDc : dc;
        if (targetDc.readyState !== "open") return;
        if (targetDc.bufferedAmount > 220 * 1024) return;
        try {
          if (bytes.byteLength <= WEBRTC_BIN_CHUNK_BYTES) {
            const pkt = Buffer.allocUnsafe(4 + bytes.byteLength);
            pkt[0] = 0x50;
            pkt[1] = 0x4b;
            pkt[2] = 0x42;
            pkt[3] = 0x31; // "PKB1"
            Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(pkt, 4);
            targetDc.send(pkt);
            return;
          }
          const total = Math.ceil(bytes.byteLength / WEBRTC_BIN_CHUNK_BYTES);
          if (total > 65535) return;
          const msgSeq = (++binSeq) >>> 0;
          const src = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let idx = 0; idx < total; idx++) {
            const start = idx * WEBRTC_BIN_CHUNK_BYTES;
            const end = Math.min(bytes.byteLength, start + WEBRTC_BIN_CHUNK_BYTES);
            const sliceLen = end - start;
            const pkt = Buffer.allocUnsafe(12 + sliceLen);
            pkt[0] = 0x50;
            pkt[1] = 0x4b;
            pkt[2] = 0x43;
            pkt[3] = 0x31; // "PKC1"
            pkt.writeUInt32BE(msgSeq, 4);
            pkt.writeUInt16BE(idx, 8);
            pkt.writeUInt16BE(total, 10);
            src.copy(pkt, 12, start, end);
            targetDc.send(pkt);
          }
        } catch {
          if (targetDc === dc) onDone();
        }
      },
      close: () => {
        try {
          dc.close();
        } catch {
          // ignore
        }
        onDone();
      },
      bufferedBytes: () =>
        Math.max(
          dc.readyState === "open" ? dc.bufferedAmount : 0,
          active.portalDc && active.portalDc.readyState === "open" ? active.portalDc.bufferedAmount : 0,
        ),
    };

    const emitWelcome = () => {
      if (active.closed || dc.readyState !== "open") return;
      onReady(peer);
      peer.send({ type: "welcome", device: this.opts.hostId() });
    };

    if (dc.readyState === "open") {
      emitWelcome();
    } else {
      dc.stateChanged.subscribe((state) => {
        if (state === "open") emitWelcome();
        else if (state === "closed" || state === "closing") {
          partials.clear();
          onDone();
        }
      });
    }

    dc.onMessage.subscribe((msg) => {
      touch();
      const raw = typeof msg === "string" ? msg : msg.toString("utf8");
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type === "__chunk") {
        const now = Date.now();
        for (const [k, v] of partials) {
          if (v.expiresAt < now) partials.delete(k);
        }
        const id = typeof frame.id === "string" ? frame.id : "";
        const idx = typeof frame.idx === "number" ? frame.idx : -1;
        const total = typeof frame.total === "number" ? frame.total : -1;
        const part = typeof frame.part === "string" ? frame.part : null;
        if (!id || !Number.isInteger(idx) || !Number.isInteger(total) || total <= 0 || total > 2048 || idx < 0 || idx >= total || part === null) {
          return;
        }
        let entry = partials.get(id);
        if (!entry) {
          entry = { total, parts: new Array(total), received: 0, bytes: 0, expiresAt: now + RPC_PARTIAL_TTL_MS };
          partials.set(id, entry);
        }
        if (entry.total !== total) return;
        if (entry.parts[idx] === undefined) {
          entry.bytes += part.length * 2;
          if (entry.bytes > RPC_MAX_PARTIAL_BYTES) {
            partials.delete(id);
            return;
          }
          entry.parts[idx] = part;
          entry.received += 1;
        }
        entry.expiresAt = now + RPC_PARTIAL_TTL_MS;
        if (entry.received < entry.total) return;
        partials.delete(id);
        try {
          frame = JSON.parse(entry.parts.join("")) as Record<string, unknown>;
        } catch {
          return;
        }
      }
      this.opts.onFrame(peer, frame);
    });
  }

  private attachPutChannel(dc: RTCDataChannel, touch: () => void): void {
    let writer: DirectUploadWriter | null = null;
    let chain: Promise<void> = Promise.resolve();
    let failed = false;

    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      writer?.abort(message);
      writer = null;
      sendJson(dc, { type: "error", message });
      try {
        dc.close();
      } catch {
        // ignore
      }
    };

    dc.stateChanged.subscribe((st) => {
      if (st === "closed" || st === "closing") {
        if (writer) {
          writer.abort("datachannel closed");
          writer = null;
        }
      }
    });

    dc.onMessage.subscribe((raw) => {
      touch();
      if (failed) return;
      chain = chain.then(async () => {
        if (failed) return;
        try {
          if (typeof raw === "string") {
            const msg = JSON.parse(raw) as { type?: string; token?: string };
            if (msg.type === "put") {
              if (writer) throw new Error("upload already initialized");
              const w = this.opts.chunkedPut.openDirectStream(typeof msg.token === "string" ? msg.token : "");
              if (!w) {
                fail("upload session not found");
                return;
              }
              writer = w;
              sendJson(dc, { type: "ready" });
              return;
            }
            if (msg.type === "eof") {
              if (!writer) {
                fail("upload not initialized");
                return;
              }
              const current = writer;
              writer = null;
              const receivedBytes = await current.finish();
              this.opts.log?.("info", "files", `direct-put (webrtc) received ${receivedBytes} bytes`, {
                name: current.name,
                total: current.totalBytes,
              });
              sendJson(dc, { type: "done", receivedBytes });
              return;
            }
            return;
          }
          if (!writer) {
            fail("upload not initialized before binary chunk");
            return;
          }
          await writer.write(raw);
        } catch (err) {
          fail((err as Error)?.message || "webrtc upload failed");
        }
      });
    });
  }

  private attachGetChannel(dc: RTCDataChannel, touch: () => void): void {
    let started = false;

    dc.onMessage.subscribe((raw) => {
      touch();
      if (started || typeof raw !== "string") return;
      let msg: { type?: string; token?: string; path?: string; start?: number; end?: number };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        return;
      }
      if (msg.type !== "get" || typeof msg.token !== "string") return;
      started = true;

      void (async () => {
        let stream: import("node:fs").ReadStream | null = null;
        let closed = false;
        const closeSub = dc.stateChanged.subscribe((st) => {
          if (st === "closed" || st === "closing") {
            closed = true;
            stream?.destroy();
          }
        });
        try {
          const opened = await this.opts.portalTickets.openDirectRead({
            token: msg.token!,
            relPath: typeof msg.path === "string" ? msg.path : "",
            start: typeof msg.start === "number" ? msg.start : undefined,
            end: typeof msg.end === "number" ? msg.end : undefined,
            chunkBytes: WEBRTC_BIN_CHUNK_BYTES,
          });
          stream = opened.stream;
          if (!sendJson(dc, {
            type: "meta",
            ok: true,
            size: opened.size,
            mime: opened.mime,
            start: opened.start,
            end: opened.end,
          })) {
            stream?.destroy();
            return;
          }
          let totalSent = 0;
          if (stream) {
            for await (const chunk of stream) {
              touch();
              if (closed || dc.readyState !== "open") break;
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              for (let off = 0; off < buf.length; off += WEBRTC_BIN_CHUNK_BYTES) {
                if (closed || dc.readyState !== "open") break;
                const slice = buf.subarray(off, Math.min(buf.length, off + WEBRTC_BIN_CHUNK_BYTES));
                if (dc.bufferedAmount > DC_HIGH_WATER) {
                  await waitBufferedAmountBelow(dc, DC_LOW_WATER);
                }
                if (closed || dc.readyState !== "open") break;
                dc.send(slice);
                totalSent += slice.length;
              }
            }
          }
          if (!closed && dc.readyState === "open") {
            sendJson(dc, { type: "eof", bytes: totalSent });
          }
        } catch (err) {
          stream?.destroy();
          sendJson(dc, { type: "error", message: (err as Error)?.message || "direct read failed" });
        } finally {
          closeSub.unSubscribe();
        }
      })();
    });
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.sweeper);
    for (const p of [...this.peers.values()]) {
      p.cleanup("server stopped");
    }
    this.peers.clear();
  }
}
