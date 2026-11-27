import {
  DIRECT_FROM_PHONE,
  DIRECT_PATH,
  DirectCipher,
  WEBRTC_BIN_CHUNK_BYTES,
  WEBRTC_CHUNK_CHARS,
  WEBRTC_GET_CHANNEL,
  WEBRTC_PORTAL_CHANNEL,
  WEBRTC_PUT_CHANNEL,
  WEBRTC_RPC_CHANNEL,
  WEBRTC_STUN_URLS,
  decodeBinaryPortalStreamFrame,
  jsChaCha20Poly1305,
  utf8Decode,
  type DirectOffer,
  type PortalFrameTransport,
  type RpcError,
  type RpcMethod,
  type ServerFrame,
  type StreamKind,
  type WebRtcAnswerResult,
  type WebRtcOfferParams,
} from "@herdr-pocket/protocol";
import { native } from "./native";
import { logger } from "./log";

export type DirectLinkKind = "local" | "lan-p2p" | "vpn-p2p" | "webrtc-p2p";

/** Classifies a direct transport path from its remote address and socket kind. */
export function classifyDirectLinkKind(displayAddr: string, transportKind: "ws" | "webrtc"): DirectLinkKind {
  if (transportKind === "webrtc") return "webrtc-p2p";
  const host = displayAddr.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return "local";
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) {
    const oct2 = Number(m[1]);
    if (oct2 >= 64 && oct2 <= 127) return "vpn-p2p";
  }
  if (host.startsWith("fd7a:115c:a1e0:")) return "vpn-p2p";
  return "lan-p2p";
}

export class DirectError extends Error {
  code: RpcError["code"];
  uncertain?: boolean;
  constructor(code: RpcError["code"], message: string, uncertain?: boolean) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

/** Read-only or idempotent RPCs safe to replay over the relay if the direct socket drops mid-flight. */
export const SAFE_AGAIN = new Set<RpcMethod>([
  "host.info",
  "agents.list",
  "spaces.list",
  "terminal.read",
  "terminal.resize",
  "terminal.put",
  "terminal.putBegin",
  "terminal.putAbort",
  "session.events",
  "session.children",
  "sessions.list",
  "sessions.search",
  "sessions.read",
  "sessions.usage",
  "harness.icons",
  "herdr.layout",
  "herdr.doc.get",
  "agent.seen",
  "agent.ports",
  "files.list",
  "files.read",
  "folders.list",
  "agent.commands",
  "agent.usage",
  "agent.models",
  "agent.btw",
  "git.status",
  "git.diff",
  "git.log",
  "tools.check",
  "tools.updateStatus",
  "files.readChunk",
  "portal.list",
  "portal.frame",
  "portal.fileTicket",
  "portal.dirList",
  "portal.bundleHtml",
]);

export type WebRtcSignaler = (offer: WebRtcOfferParams) => Promise<WebRtcAnswerResult>;

export interface DirectHandlers {
  onStream: (frame: ServerFrame) => void;
  onClose: (link: DirectLink) => void;
  onRtt?: (link: DirectLink, rttMs: number) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PartialRpcChunk {
  total: number;
  parts: Array<string | undefined>;
  received: number;
  bytes: number;
  expiresAt: number;
}

interface PartialBinaryFrame {
  total: number;
  parts: Array<Uint8Array | undefined>;
  received: number;
  bytes: number;
  expiresAt: number;
}

const DIAL_LOCAL_MS = 1800;
const DIAL_REMOTE_MS = 2800;
const DIAL_WEBRTC_MS = 6500;
const WEBRTC_GATHER_WAIT_MS = 700;
const WEBRTC_SRFLX_GRACE_MS = 120;
const PING_MS = 20_000;
const PONG_WAIT_MS = 10_000;
const PONG_DRAIN_GRACE_MS = 250;
const MISSED_PONG_LIMIT = 2;
const TIMEOUT_EVICT_LIMIT = 2;
const WEBRTC_CONGESTED_BYTES = 64 * 1024;
const PUT_OPEN_TIMEOUT_MS = 8_000;
const PUT_IDLE_TIMEOUT_MS = 20_000;
const RPC_MAX_UTF8_BYTES = 44 * 1024;
const RPC_MAX_PARTIAL_BYTES = 32 * 1024 * 1024;
const DC_HIGH_WATER = 512 * 1024;
const DC_LOW_WATER = 256 * 1024;

const utf8Encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function utf8ByteLength(str: string): number {
  if (utf8Encoder) return utf8Encoder.encode(str).byteLength;
  if (typeof Buffer !== "undefined") return Buffer.byteLength(str, "utf8");
  return str.length * 3;
}

/** Splits an outbound JSON string into SCTP-safe chunks bounded by both chars and UTF-8 bytes. */
export function splitWebRtcRpcPayload(
  json: string,
  maxChars = WEBRTC_CHUNK_CHARS,
  maxBytes = RPC_MAX_UTF8_BYTES,
): string[] {
  if (json.length <= maxChars && utf8ByteLength(json) <= maxBytes) {
    return [json];
  }
  const parts: string[] = [];
  let start = 0;
  while (start < json.length) {
    let end = Math.min(json.length, start + maxChars);
    if (end < json.length && end > start + 1) {
      const code = json.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    while (end > start + 1 && utf8ByteLength(json.slice(start, end)) > maxBytes) {
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

/** Merges gathered `a=candidate:...` lines into SDP (critical on iOS/macOS WebKit) and filters virtual/TUN IPs. */
export function mergeWebRtcCandidates(sdp: string, gathered: string[]): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const seen = new Set<string>();
  const kept: string[] = [];
  let eocIndex = -1;

  const isVirtualCand = (line: string) => {
    const m = /^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+/.exec(line);
    const ip = m?.[1] ?? "";
    return ip.startsWith("198.18.") || ip.startsWith("198.19.") || ip.startsWith("169.254.");
  };

  for (const line of lines) {
    if (line.startsWith("a=candidate:")) {
      if (isVirtualCand(line)) continue;
      seen.add(line);
    }
    if (line === "a=end-of-candidates" && eocIndex < 0) {
      eocIndex = kept.length;
    }
    kept.push(line);
  }

  const additions: string[] = [];
  for (const raw of gathered) {
    const line = raw.startsWith("a=") ? raw : `a=${raw}`;
    if (!line.startsWith("a=candidate:") || isVirtualCand(line) || seen.has(line)) continue;
    seen.add(line);
    additions.push(line);
  }

  if (additions.length > 0) {
    if (eocIndex >= 0) {
      kept.splice(eocIndex, 0, ...additions);
    } else {
      const trailingEmpty = kept.length > 0 && kept[kept.length - 1] === "";
      if (trailingEmpty) kept.splice(kept.length - 1, 0, ...additions);
      else kept.push(...additions);
    }
  }
  return kept.join(eol);
}

function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function isHttpsOrigin(): boolean {
  return typeof window !== "undefined" && window.location?.protocol === "https:";
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rawToBytesSync(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

async function rawToBytes(data: unknown): Promise<Uint8Array | null> {
  const sync = rawToBytesSync(data);
  if (sync) return sync;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}

async function waitDcBufferedBelow(dc: RTCDataChannel, threshold: number): Promise<void> {
  if (dc.readyState !== "open" || dc.bufferedAmount <= threshold) return;
  try {
    dc.bufferedAmountLowThreshold = threshold;
  } catch {
    // ignore in minimal shims
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(guard);
      dc.removeEventListener("bufferedamountlow", finish);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", finish);
    const poll = setInterval(() => {
      if (dc.readyState !== "open" || dc.bufferedAmount <= threshold) finish();
    }, 20);
    const guard = setTimeout(finish, 2000);
  });
}

type WsDialWinner = { kind: "ws"; ws: WebSocket; cipher: DirectCipher; addr: string; port: number; displayAddr: string };
type WebRtcDialWinner = { kind: "webrtc"; pc: RTCPeerConnection; dc: RTCDataChannel; portalDc: RTCDataChannel; peerId: string };
type DialWinner = WsDialWinner | WebRtcDialWinner;

function dialCandidate(
  addr: string,
  port: number,
  ticket: string,
  key: Uint8Array,
  timeoutMs: number,
  displayAddr = addr,
): Promise<WsDialWinner> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    const cipher = new DirectCipher(jsChaCha20Poly1305, key, DIRECT_FROM_PHONE);
    const host = addr.includes(":") ? `[${addr}]` : addr;
    const url = `ws://${host}:${port}${DIRECT_PATH}?ticket=${encodeURIComponent(ticket)}`;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new DirectError("offline", `${displayAddr} dial timed out`));
    }, timeoutMs);

    try {
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
    } catch (err) {
      clearTimeout(timer);
      reject(new DirectError("offline", String(err)));
      return;
    }

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new DirectError("offline", msg));
    };

    ws.onmessage = async (ev) => {
      if (settled) return;
      const bytes = await rawToBytes(ev.data);
      const text = bytes ? cipher.open(bytes) : null;
      if (text === null) {
        fail("bad encrypted welcome frame");
        return;
      }
      try {
        const frame = JSON.parse(text) as { type?: string };
        if (frame.type !== "welcome") {
          fail("unexpected first frame");
          return;
        }
        settled = true;
        clearTimeout(timer);
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        resolve({ kind: "ws", ws, cipher, addr, port, displayAddr });
      } catch {
        fail("invalid welcome json");
      }
    };
    ws.onerror = () => fail(`connect error on ${displayAddr}`);
    ws.onclose = (ev) => fail(`closed during handshake (${ev.code})`);
  });
}

async function dialWebRtc(
  to: string,
  signalWebRtc: WebRtcSignaler,
  timeoutMs = DIAL_WEBRTC_MS,
): Promise<WebRtcDialWinner> {
  if (typeof RTCPeerConnection === "undefined") {
    throw new DirectError("unsupported", "当前环境不支持 WebRTC P2P");
  }
  const pc = new RTCPeerConnection({
    iceServers: WEBRTC_STUN_URLS.map((urls) => ({ urls })),
  });
  const dc = pc.createDataChannel(WEBRTC_RPC_CHANNEL, { ordered: true });
  dc.binaryType = "arraybuffer";
  const portalDc = pc.createDataChannel(WEBRTC_PORTAL_CHANNEL, {
    ordered: false,
    maxRetransmits: 2,
  });
  portalDc.binaryType = "arraybuffer";

  const gathered: string[] = [];
  let settled = false;
  let overallTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanupFailed = () => {
    if (overallTimer) {
      clearTimeout(overallTimer);
      overallTimer = null;
    }
    dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null;
    portalDc.onopen = portalDc.onmessage = portalDc.onclose = portalDc.onerror = null;
    pc.onicecandidate = pc.onicegatheringstatechange = pc.onconnectionstatechange = null;
    try {
      dc.close();
    } catch {
      // ignore
    }
    try {
      portalDc.close();
    } catch {
      // ignore
    }
    try {
      pc.close();
    } catch {
      // ignore
    }
  };

  return await new Promise<WebRtcDialWinner>((resolve, reject) => {
    const fail = (err: DirectError) => {
      if (settled) return;
      settled = true;
      cleanupFailed();
      reject(err);
    };

    overallTimer = setTimeout(() => {
      fail(new DirectError("offline", "WebRTC P2P 握手超时"));
    }, timeoutMs);

    dc.onmessage = (ev) => {
      if (settled) return;
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw) return;
      try {
        const frame = JSON.parse(raw) as { type?: string; device?: string };
        if (frame.type === "welcome") {
          if (frame.device && frame.device !== to) {
            fail(new DirectError("offline", "WebRTC 对端设备不匹配"));
            return;
          }
          settled = true;
          if (overallTimer) {
            clearTimeout(overallTimer);
            overallTimer = null;
          }
          dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null;
          pc.onicecandidate = pc.onicegatheringstatechange = pc.onconnectionstatechange = null;
          resolve({ kind: "webrtc", pc, dc, portalDc, peerId: "" });
        }
      } catch {
        // ignore non-welcome
      }
    };

    dc.onerror = () => fail(new DirectError("offline", "WebRTC DataChannel 连接失败"));
    dc.onclose = () => fail(new DirectError("offline", "WebRTC DataChannel 已关闭"));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        fail(new DirectError("offline", `WebRTC state ${pc.connectionState}`));
      }
    };

    void (async () => {
      let srflxTimer: ReturnType<typeof setTimeout> | null = null;
      let gatherTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        let resolveGather: (() => void) | null = null;
        const gatherDone = new Promise<void>((r) => {
          resolveGather = r;
        });
        let seenSrflx = false;

        pc.onicecandidate = (ev) => {
          if (!ev.candidate) {
            resolveGather?.();
            return;
          }
          if (ev.candidate.candidate) {
            gathered.push(ev.candidate.candidate);
            if (!seenSrflx && /\styp\s+srflx\b/.test(ev.candidate.candidate)) {
              seenSrflx = true;
              srflxTimer = setTimeout(() => resolveGather?.(), WEBRTC_SRFLX_GRACE_MS);
            }
          }
        };
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") resolveGather?.();
        };

        const offer = await pc.createOffer();
        if (settled) return;
        await pc.setLocalDescription(offer);
        if (settled) return;

        if (pc.iceGatheringState !== "complete") {
          gatherTimer = setTimeout(() => resolveGather?.(), WEBRTC_GATHER_WAIT_MS);
          await gatherDone;
        }
        if (srflxTimer) clearTimeout(srflxTimer);
        if (gatherTimer) clearTimeout(gatherTimer);
        if (settled) return;

        const baseSdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
        const sdp = mergeWebRtcCandidates(baseSdp, gathered);
        const answer = await signalWebRtc({ type: "offer", sdp });
        if (settled) return;
        await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      } catch (err) {
        if (srflxTimer) clearTimeout(srflxTimer);
        if (gatherTimer) clearTimeout(gatherTimer);
        const code =
          err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
            ? ((err as { code: RpcError["code"] }).code)
            : "offline";
        const msg = err instanceof Error ? err.message : String(err);
        fail(new DirectError(code, msg));
      }
    })();
  });
}

function closeDialWinner(w: DialWinner): void {
  if (w.kind === "ws") {
    w.ws.onopen = w.ws.onmessage = w.ws.onclose = w.ws.onerror = null;
    try {
      w.ws.close();
    } catch {
      // ignore
    }
  } else {
    w.dc.onopen = w.dc.onmessage = w.dc.onclose = w.dc.onerror = null;
    w.portalDc.onopen = w.portalDc.onmessage = w.portalDc.onclose = w.portalDc.onerror = null;
    w.pc.onicecandidate = w.pc.onicegatheringstatechange = w.pc.onconnectionstatechange = null;
    try {
      w.dc.close();
    } catch {
      // ignore
    }
    try {
      w.portalDc.close();
    } catch {
      // ignore
    }
    try {
      w.pc.close();
    } catch {
      // ignore
    }
  }
}

export class DirectLink {
  readonly to: string;
  readonly transportKind: "ws" | "webrtc";
  readonly linkKind: DirectLinkKind;
  readonly addr: string;
  readonly displayAddr: string;
  readonly port: number;
  private ws: WebSocket | null = null;
  private cipher: DirectCipher | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private portalDc: RTCDataChannel | null = null;
  private partials = new Map<string, PartialRpcChunk>();
  private binPartials = new Map<number, PartialBinaryFrame>();
  private handlers: DirectHandlers;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private chunkSeq = 0;
  private pingTimer: ReturnType<typeof setInterval>;
  private initPingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pongGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRxAt = Date.now();
  /** Last time a bidirectional response (`pong` or `rpc_result`) proved client -> host -> client works. */
  private lastBidirectionalRxAt = Date.now();
  private lastPingSentAt = 0;
  private rttMs: number | null = null;
  private missedPongs = 0;
  private consecutiveTimeouts = 0;
  private pongWaiters: Array<(rttMs: number | null) => void> = [];
  private rxChain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    to: string,
    winner: DialWinner,
    handlers: DirectHandlers,
  ) {
    this.to = to;
    this.transportKind = winner.kind;
    this.handlers = handlers;

    if (winner.kind === "ws") {
      this.addr = winner.addr;
      this.displayAddr = winner.displayAddr;
      this.linkKind = classifyDirectLinkKind(winner.displayAddr, "ws");
      this.port = winner.port;
      this.ws = winner.ws;
      this.cipher = winner.cipher;

      winner.ws.onmessage = (ev) => {
        this.enqueueWsMessage(ev.data);
      };
      winner.ws.onclose = (ev) => {
        logger.info("link.direct", `ws closed on ${this.displayAddr} (code=${ev?.code ?? "?"})`);
        this.close();
      };
      winner.ws.onerror = () => {
        logger.warn("link.direct", `ws error on ${this.displayAddr}`);
        this.close();
      };
    } else {
      this.addr = winner.peerId ? `webrtc:${winner.peerId}` : "webrtc";
      this.displayAddr = "WebRTC P2P";
      this.linkKind = "webrtc-p2p";
      this.port = 0;
      this.pc = winner.pc;
      this.dc = winner.dc;
      this.portalDc = winner.portalDc;

      winner.dc.onmessage = (ev) => {
        this.handleWebRtcMessage(ev.data);
      };
      winner.dc.onclose = () => {
        logger.info("link.direct", `webrtc channel closed on ${this.displayAddr}`);
        this.close();
      };
      winner.dc.onerror = () => {
        logger.warn("link.direct", `webrtc channel error on ${this.displayAddr}`);
        this.close();
      };
      winner.portalDc.onmessage = (ev) => {
        this.handleWebRtcMessage(ev.data);
      };
      winner.portalDc.onclose = () => {
        logger.info("link.direct", `webrtc portal channel closed on ${this.displayAddr}`);
      };
      winner.portalDc.onerror = () => {
        logger.warn("link.direct", `webrtc portal channel error on ${this.displayAddr}`);
      };
      winner.pc.onconnectionstatechange = () => {
        const st = winner.pc.connectionState;
        if (st === "failed" || st === "closed") {
          logger.info("link.direct", `webrtc connection ${st}`);
          this.close();
        }
      };
    }

    this.pingTimer = setInterval(() => this.sendPing(), PING_MS);
    this.initPingTimer = setTimeout(() => {
      this.initPingTimer = null;
      this.sendPing();
    }, 60);
  }

  getRttMs(): number | null {
    return this.rttMs;
  }

  getBufferedAmount(): number {
    if (this.closed) return 0;
    if (this.transportKind === "webrtc") {
      return this.dc?.readyState === "open" ? this.dc.bufferedAmount ?? 0 : 0;
    }
    return this.ws?.readyState === WebSocket.OPEN ? this.ws.bufferedAmount ?? 0 : 0;
  }

  /** True when the direct channel is backed up or recently timed out and interactive writes should bypass it. */
  isCongested(): boolean {
    if (!this.open) return true;
    if (this.consecutiveTimeouts > 0) return true;
    if (this.transportKind === "webrtc" && this.getBufferedAmount() > WEBRTC_CONGESTED_BYTES) {
      return true;
    }
    return false;
  }

  pingNow(): void {
    this.sendPing();
  }

  /** Actively measures direct RTT via ping/pong (resolves `null` if link is closed or times out). */
  measureRtt(timeoutMs = 3_500): Promise<number | null> {
    if (!this.open) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (val: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => {
        const idx = this.pongWaiters.indexOf(done);
        if (idx >= 0) this.pongWaiters.splice(idx, 1);
        done(null);
      }, timeoutMs);
      this.pongWaiters.push(done);
      this.sendPing();
    });
  }

  get open(): boolean {
    if (this.closed) return false;
    if (this.transportKind === "ws") {
      return this.ws?.readyState === WebSocket.OPEN;
    }
    return this.dc?.readyState === "open";
  }

  static async open(
    to: string,
    offer: DirectOffer | null,
    handlers: DirectHandlers,
    opts?: boolean | { preferLoopback?: boolean; signalWebRtc?: WebRtcSignaler },
  ): Promise<DirectLink> {
    const preferLoopback = typeof opts === "boolean" ? opts : Boolean(opts?.preferLoopback);
    const signalWebRtc = typeof opts === "object" && opts !== null ? opts.signalWebRtc : undefined;
    const httpsBrowser = !native.available() && isHttpsOrigin();

    if (preferLoopback && offer) {
      const key = decodeBase64(offer.key);
      const candidates = ["127.0.0.1", ...offer.addrs.filter((a) => a !== "127.0.0.1")];
      if (!candidates.length) throw new DirectError("offline", "没有可直连的本地地址");
      const win = await dialCandidate(candidates[0]!, offer.port, offer.ticket, key, DIAL_LOCAL_MS, "127.0.0.1");
      return new DirectLink(to, win, handlers);
    }

    // HTTPS browser origins block cleartext ws:// to private/VPN IPs: use standards-based WebRTC STUN P2P directly.
    if (httpsBrowser) {
      if (!signalWebRtc) {
        throw new DirectError("unsupported", "未提供 WebRTC 信令通道");
      }
      logger.info("link.direct", `probing WebRTC P2P for ${to}`);
      const win = await dialWebRtc(to, signalWebRtc, DIAL_WEBRTC_MS);
      return new DirectLink(to, win, handlers);
    }

    const candidates = offer ? [...offer.addrs] : [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const waiters: Array<() => void> = [];
    let settled = false;
    const cancelStaggers = () => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      for (const wake of waiters.splice(0)) wake();
    };
    const stagger = (ms: number) =>
      new Promise<void>((resolve) => {
        if (settled || ms <= 0) {
          resolve();
          return;
        }
        const wake = () => resolve();
        waiters.push(wake);
        timers.push(setTimeout(wake, ms));
      });

    const racers: Array<() => Promise<DialWinner>> = [];

    if (offer && candidates.length > 0) {
      const key = decodeBase64(offer.key);
      if (native.available()) {
        racers.push(async () => {
          logger.info("link.direct", `probing ${candidates.join(", ")}:${offer.port} via native tunnel`);
          const tunnel = await native.openDirectTunnel(candidates, offer.port, to);
          if (settled || !tunnel || tunnel.localPort <= 0) {
            throw new DirectError("offline", `native tunnel unavailable for ${candidates.join(", ")}`);
          }
          const win = await dialCandidate("127.0.0.1", tunnel.localPort, offer.ticket, key, DIAL_LOCAL_MS, tunnel.remoteAddr);
          logger.info("link.direct", `tunnel connected -> ${tunnel.remoteAddr}:${offer.port} (local:${tunnel.localPort})`);
          return win;
        });
      } else {
        candidates.forEach((addr, idx) => {
          racers.push(async () => {
            if (idx > 0) await stagger(idx * 120);
            if (settled) throw new DirectError("offline", "cancelled");
            const timeoutMs = addr === "127.0.0.1" ? DIAL_LOCAL_MS : DIAL_REMOTE_MS;
            return await dialCandidate(addr, offer.port, offer.ticket, key, timeoutMs, addr);
          });
        });
      }
    }

    if (signalWebRtc && typeof RTCPeerConnection !== "undefined") {
      racers.push(async () => {
        if (offer && candidates.length > 0) {
          // Give local/VPN HTTP-verified TCP tunnel a 350ms head start before opening STUN signaling.
          await stagger(350);
          if (settled) throw new DirectError("offline", "cancelled");
        }
        return await dialWebRtc(to, signalWebRtc, DIAL_WEBRTC_MS);
      });
    }

    if (racers.length === 0) {
      throw new DirectError("offline", "这台电脑没有可直连的地址");
    }

    try {
      const win = await Promise.any(
        racers.map((fn) =>
          fn().then((res) => {
            if (settled) {
              closeDialWinner(res);
              throw new DirectError("offline", "cancelled");
            }
            settled = true;
            cancelStaggers();
            return res;
          }),
        ),
      );
      cancelStaggers();
      return new DirectLink(to, win, handlers);
    } catch (agg) {
      settled = true;
      cancelStaggers();
      const firstErr =
        agg && typeof agg === "object" && "errors" in agg && Array.isArray((agg as { errors: unknown[] }).errors)
          ? ((agg as { errors: Error[] }).errors[0] ?? new DirectError("offline", "无法直连这台电脑"))
          : new DirectError("offline", "无法直连这台电脑");
      throw firstErr instanceof Error ? firstErr : new DirectError("offline", String(firstErr));
    }
  }

  private enqueueWsMessage(data: unknown): void {
    if (this.closed) return;
    const syncBytes = rawToBytesSync(data);
    if (syncBytes) {
      this.processWsBytes(syncBytes);
      return;
    }
    this.rxChain = this.rxChain.then(async () => {
      if (this.closed) return;
      const bytes = await rawToBytes(data);
      if (!bytes) {
        logger.warn("link.direct", `unexpected non-binary direct frame on ${this.displayAddr}`);
        this.close();
        return;
      }
      this.processWsBytes(bytes);
    });
  }

  private decodeAndEmitBinaryFrame(pkt: Uint8Array, transport: PortalFrameTransport): boolean {
    const decoded = decodeBinaryPortalStreamFrame(pkt);
    if (!decoded) return false;
    const rawCopy = new Uint8Array(decoded.bytes.byteLength);
    rawCopy.set(decoded.bytes);
    const eventFrame: ServerFrame = {
      type: "stream_event",
      id: decoded.id,
      event: {
        kind: "portal_frame",
        portalId: decoded.meta.portalId,
        seq: decoded.meta.seq,
        mime: decoded.meta.mime,
        data: "",
        rawBytes: rawCopy,
        byteLength: rawCopy.byteLength,
        transport,
        width: decoded.meta.width,
        height: decoded.meta.height,
        ...(decoded.meta.url !== undefined ? { url: decoded.meta.url } : {}),
        ...(decoded.meta.title !== undefined ? { title: decoded.meta.title } : {}),
        ...(decoded.meta.canGoBack !== undefined ? { canGoBack: decoded.meta.canGoBack } : {}),
        ...(decoded.meta.canGoForward !== undefined ? { canGoForward: decoded.meta.canGoForward } : {}),
        ...(decoded.meta.cursorX !== undefined ? { cursorX: decoded.meta.cursorX } : {}),
        ...(decoded.meta.cursorY !== undefined ? { cursorY: decoded.meta.cursorY } : {}),
        ...(decoded.meta.cursorVisible !== undefined ? { cursorVisible: decoded.meta.cursorVisible } : {}),
        ...(decoded.meta.captureMs !== undefined ? { captureMs: decoded.meta.captureMs } : {}),
        at: decoded.meta.at,
      },
    };
    this.onDecodedFrame(eventFrame);
    return true;
  }

  private processWsBytes(bytes: Uint8Array): void {
    if (this.closed || !this.cipher) return;
    const plain = this.cipher.openBytes(bytes);
    if (plain === null) {
      logger.warn("link.direct", `cipher open failed on ${this.displayAddr}`);
      this.close();
      return;
    }
    if (
      plain.byteLength >= 4 &&
      plain[0] === 0x50 &&
      plain[1] === 0x4b &&
      plain[2] === 0x46 &&
      plain[3] === 0x31
    ) {
      if (this.decodeAndEmitBinaryFrame(plain, this.linkKind)) return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(utf8Decode(plain)) as ServerFrame;
    } catch {
      return;
    }
    this.onDecodedFrame(frame);
  }

  private handleWebRtcMessage(data: unknown): void {
    if (this.closed) return;
    let raw = "";
    if (typeof data === "string") {
      raw = data;
    } else {
      const bytes = rawToBytesSync(data);
      if (bytes && bytes.byteLength >= 4) {
        if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x42 && bytes[3] === 0x31) {
          this.decodeAndEmitBinaryFrame(bytes.subarray(4), "webrtc-p2p");
          return;
        }
        if (
          bytes.byteLength >= 12 &&
          bytes[0] === 0x50 &&
          bytes[1] === 0x4b &&
          bytes[2] === 0x43 &&
          bytes[3] === 0x31
        ) {
          const msgSeq =
            ((bytes[4]! << 24) | (bytes[5]! << 16) | (bytes[6]! << 8) | bytes[7]!) >>> 0;
          const idx = (bytes[8]! << 8) | bytes[9]!;
          const total = (bytes[10]! << 8) | bytes[11]!;
          if (total <= 0 || total > 65535 || idx < 0 || idx >= total) return;
          const now = Date.now();
          for (const [k, v] of this.binPartials) {
            if (v.expiresAt < now) this.binPartials.delete(k);
          }
          if (!this.binPartials.has(msgSeq) && this.binPartials.size >= 8) {
            const oldestKey = this.binPartials.keys().next().value;
            if (oldestKey !== undefined) this.binPartials.delete(oldestKey);
          }
          let entry = this.binPartials.get(msgSeq);
          if (!entry) {
            entry = { total, parts: new Array(total), received: 0, bytes: 0, expiresAt: now + 8_000 };
            this.binPartials.set(msgSeq, entry);
          }
          if (entry.total !== total) return;
          const chunk = bytes.subarray(12);
          if (entry.parts[idx] === undefined) {
            const copy = new Uint8Array(chunk.byteLength);
            copy.set(chunk);
            entry.parts[idx] = copy;
            entry.bytes += copy.byteLength;
            entry.received += 1;
            if (entry.bytes > 8 * 1024 * 1024) {
              this.binPartials.delete(msgSeq);
              return;
            }
          }
          entry.expiresAt = now + 8_000;
          if (entry.received < entry.total) return;
          this.binPartials.delete(msgSeq);
          const assembled = new Uint8Array(entry.bytes);
          let off = 0;
          for (let i = 0; i < entry.total; i += 1) {
            const part = entry.parts[i];
            if (!part) return;
            assembled.set(part, off);
            off += part.byteLength;
          }
          this.decodeAndEmitBinaryFrame(assembled, "webrtc-p2p");
          return;
        }
      }
      if (bytes) {
        raw = utf8Decode(bytes);
      }
    }
    if (!raw) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === "__chunk") {
      const now = Date.now();
      for (const [k, v] of this.partials) {
        if (v.expiresAt < now) this.partials.delete(k);
      }
      const id = typeof frame.id === "string" ? frame.id : "";
      const idx = typeof frame.idx === "number" ? frame.idx : -1;
      const total = typeof frame.total === "number" ? frame.total : -1;
      const part = typeof frame.part === "string" ? frame.part : null;
      if (!id || !Number.isInteger(idx) || !Number.isInteger(total) || total <= 0 || total > 2048 || idx < 0 || idx >= total || part === null) {
        return;
      }
      let entry = this.partials.get(id);
      if (!entry) {
        entry = { total, parts: new Array(total), received: 0, bytes: 0, expiresAt: now + 30_000 };
        this.partials.set(id, entry);
      }
      if (entry.total !== total) return;
      if (entry.parts[idx] === undefined) {
        entry.bytes += part.length * 2;
        if (entry.bytes > RPC_MAX_PARTIAL_BYTES) {
          this.partials.delete(id);
          return;
        }
        entry.parts[idx] = part;
        entry.received += 1;
      }
      entry.expiresAt = now + 30_000;
      if (entry.received < entry.total) return;
      this.partials.delete(id);
      try {
        frame = JSON.parse(entry.parts.join("")) as Record<string, unknown>;
      } catch {
        return;
      }
    }
    this.onDecodedFrame(frame as unknown as ServerFrame);
  }

  private clearPongTimers(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (this.pongGraceTimer) {
      clearTimeout(this.pongGraceTimer);
      this.pongGraceTimer = null;
    }
  }

  private onDecodedFrame(frame: ServerFrame): void {
    const now = Date.now();
    this.lastRxAt = now;

    if (frame.type === "pong") {
      this.lastBidirectionalRxAt = now;
      this.missedPongs = 0;
      this.consecutiveTimeouts = 0;
      this.clearPongTimers();
      const echoedT =
        typeof (frame as { t?: unknown }).t === "number"
          ? (frame as { t: number }).t
          : this.lastPingSentAt;
      if (echoedT > 0) {
        const measured = Math.max(1, Math.min(9999, now - echoedT));
        this.rttMs = measured;
        this.handlers.onRtt?.(this, measured);
        for (const w of this.pongWaiters.splice(0)) w(measured);
      } else {
        for (const w of this.pongWaiters.splice(0)) w(this.rttMs);
      }
      return;
    }
    if (frame.type === "rpc_result") {
      this.lastBidirectionalRxAt = now;
      this.missedPongs = 0;
      this.consecutiveTimeouts = 0;
      this.clearPongTimers();
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) p.reject(new DirectError(frame.error.code, frame.error.message));
      else p.resolve(frame.result);
      return;
    }
    if (frame.type === "stream_open" || frame.type === "stream_event") {
      this.handlers.onStream(frame);
    }
  }

  private sendPing(): void {
    if (!this.open) return;
    // While hidden, WKWebView/browser throttles timers and delivers queued pong frames out-of-phase.
    if (isPageHidden()) {
      this.clearPongTimers();
      return;
    }
    const now = Date.now();
    this.lastPingSentAt = now;
    if (!this.send({ type: "ping", t: now })) return;
    if (!this.pongTimer && !this.pongGraceTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.closed || isPageHidden()) return;
        // Only bidirectional responses (pong / rpc_result) prove client -> host -> client is alive.
        if (Date.now() - this.lastBidirectionalRxAt < PONG_WAIT_MS) {
          this.missedPongs = 0;
          return;
        }
        // Let queued WebSocket/DataChannel message callbacks drain on wakeup before counting a miss.
        this.pongGraceTimer = setTimeout(() => {
          this.pongGraceTimer = null;
          if (this.closed || isPageHidden()) return;
          if (Date.now() - this.lastBidirectionalRxAt < PONG_WAIT_MS + PONG_DRAIN_GRACE_MS) {
            this.missedPongs = 0;
            return;
          }
          this.missedPongs += 1;
          if (this.missedPongs < MISSED_PONG_LIMIT) {
            this.sendPing();
            return;
          }
          logger.warn(
            "link.direct",
            `direct pong timeout on ${this.displayAddr} (${Date.now() - this.lastBidirectionalRxAt}ms bidirectional idle, ${Date.now() - this.lastRxAt}ms rx idle)`,
          );
          this.close();
        }, PONG_DRAIN_GRACE_MS);
      }, PONG_WAIT_MS);
    }
  }

  /**
   * Sends a frame over WS or WebRTC DataChannel.
   * Returns `"sent"` on success, `"not_sent"` when refused before transmitting any bytes
   * (e.g. closed or WebRTC send buffer full), or `"failed_midway"` if a multi-chunk send threw mid-stream.
   */
  private sendFrame(frame: Record<string, unknown>): "sent" | "not_sent" | "failed_midway" {
    if (!this.open) return "not_sent";
    let json: string;
    try {
      json = JSON.stringify(frame);
    } catch {
      return "not_sent";
    }
    if (this.transportKind === "ws") {
      if (!this.cipher || !this.ws) return "not_sent";
      try {
        this.ws.send(this.cipher.seal(json));
        return "sent";
      } catch {
        this.close();
        return "not_sent";
      }
    }
    if (!this.dc || this.dc.readyState !== "open") return "not_sent";
    const parts = splitWebRtcRpcPayload(json);
    // Avoid head-of-line deadlocking the ordered hp-rpc DataChannel with a large burst when SCTP buffer is already full.
    if (parts.length > 1 && (this.dc.bufferedAmount ?? 0) > DC_HIGH_WATER) {
      logger.warn(
        "link.direct",
        `webrtc rpc buffer saturated (${this.dc.bufferedAmount}B); refusing ${parts.length}-chunk frame pre-send`,
      );
      return "not_sent";
    }
    let chunksSent = 0;
    try {
      if (parts.length === 1) {
        this.dc.send(parts[0]!);
        return "sent";
      }
      const id = `c${++this.chunkSeq}`;
      for (let idx = 0; idx < parts.length; idx += 1) {
        this.dc.send(JSON.stringify({ type: "__chunk", id, idx, total: parts.length, part: parts[idx] }));
        chunksSent += 1;
      }
      return "sent";
    } catch (err) {
      logger.warn("link.direct", `webrtc send failed after ${chunksSent}/${parts.length} chunks: ${String(err)}`);
      this.close();
      return chunksSent > 0 ? "failed_midway" : "not_sent";
    }
  }

  private send(frame: Record<string, unknown>): boolean {
    return this.sendFrame(frame) === "sent";
  }

  /** Streams a Blob/File directly over a dedicated ordered binary WebRTC DataChannel (`hp-put`). */
  async putFile(token: string, file: Blob, onProgress?: (pct: number) => void): Promise<boolean> {
    if (this.transportKind !== "webrtc" || !this.pc || !this.open) return false;
    const dc = this.pc.createDataChannel(WEBRTC_PUT_CHANNEL, { ordered: true });
    dc.binaryType = "arraybuffer";

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const bumpTimer = (ms: number) => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => finish(false), ms);
      };
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
        dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null;
        try {
          dc.close();
        } catch {
          // ignore
        }
        resolve(ok);
      };
      bumpTimer(PUT_OPEN_TIMEOUT_MS);

      const startUpload = async () => {
        try {
          const total = Math.max(1, file.size);
          let sent = 0;
          for (let off = 0; off < file.size; off += WEBRTC_BIN_CHUNK_BYTES) {
            if (settled || dc.readyState !== "open") return;
            const buf = await file.slice(off, Math.min(file.size, off + WEBRTC_BIN_CHUNK_BYTES)).arrayBuffer();
            if (settled || dc.readyState !== "open") return;
            if (dc.bufferedAmount > DC_HIGH_WATER) {
              await waitDcBufferedBelow(dc, DC_LOW_WATER);
            }
            if (settled || dc.readyState !== "open") return;
            dc.send(buf);
            bumpTimer(PUT_IDLE_TIMEOUT_MS);
            sent += buf.byteLength;
            onProgress?.(Math.min(99, Math.round((sent / total) * 100)));
          }
          dc.send(JSON.stringify({ type: "eof" }));
          bumpTimer(PUT_IDLE_TIMEOUT_MS);
        } catch {
          finish(false);
        }
      };

      dc.onopen = () => {
        bumpTimer(PUT_OPEN_TIMEOUT_MS);
        try {
          dc.send(JSON.stringify({ type: "put", token }));
        } catch {
          finish(false);
        }
      };
      dc.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        bumpTimer(PUT_IDLE_TIMEOUT_MS);
        try {
          const msg = JSON.parse(ev.data) as { type?: string; receivedBytes?: number };
          if (msg.type === "ready") {
            void startUpload();
          } else if (msg.type === "done") {
            onProgress?.(99);
            finish((msg.receivedBytes ?? 0) === file.size);
          } else if (msg.type === "error") {
            finish(false);
          }
        } catch {
          finish(false);
        }
      };
      dc.onerror = () => finish(false);
      dc.onclose = () => finish(false);
    });
  }

  /** Downloads a full file or byte range over a dedicated binary WebRTC DataChannel (`hp-get`). */
  async getFile(
    req: { token: string; path?: string; start?: number; end?: number },
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ blob: Blob; mime: string; size: number } | null> {
    if (this.transportKind !== "webrtc" || !this.pc || !this.open) return null;
    const dc = this.pc.createDataChannel(WEBRTC_GET_CHANNEL, { ordered: true });
    dc.binaryType = "arraybuffer";

    return await new Promise<{ blob: Blob; mime: string; size: number } | null>((resolve) => {
      let settled = false;
      let mime = "application/octet-stream";
      let totalSize = 0;
      let loaded = 0;
      const parts: BlobPart[] = [];

      const finish = (out: { blob: Blob; mime: string; size: number } | null) => {
        if (settled) return;
        settled = true;
        dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null;
        try {
          dc.close();
        } catch {
          // ignore
        }
        resolve(out);
      };

      dc.onopen = () => {
        try {
          dc.send(JSON.stringify({ type: "get", ...req }));
        } catch {
          finish(null);
        }
      };
      dc.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as { type?: string; mime?: string; size?: number };
            if (msg.type === "meta") {
              mime = msg.mime || mime;
              totalSize = Number(msg.size ?? 0);
            } else if (msg.type === "eof") {
              finish({ blob: new Blob(parts, { type: mime }), mime, size: totalSize || loaded });
            } else if (msg.type === "error") {
              finish(null);
            }
          } catch {
            finish(null);
          }
          return;
        }
        const bytes = rawToBytesSync(ev.data);
        if (bytes) {
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          parts.push(copy.buffer);
          loaded += copy.byteLength;
          onProgress?.(loaded, totalSize);
        }
      };
      dc.onerror = () => finish(null);
      dc.onclose = () => finish(null);
    });
  }

  call(method: RpcMethod, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.open) {
      return Promise.reject(new DirectError("offline", "直连已断开", false));
    }
    const id = `d${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.consecutiveTimeouts += 1;
        const staleBidirectional = Date.now() - this.lastBidirectionalRxAt > PONG_WAIT_MS;
        const shouldEvict =
          this.consecutiveTimeouts >= TIMEOUT_EVICT_LIMIT ||
          (this.transportKind === "webrtc" && this.getBufferedAmount() > WEBRTC_CONGESTED_BYTES) ||
          staleBidirectional;
        reject(new DirectError("timeout", "直连请求超时", true));
        if (shouldEvict) {
          logger.warn(
            "link.direct",
            `evicting stalled direct link on ${this.displayAddr} (${method} timed out, timeouts=${this.consecutiveTimeouts}, buf=${this.getBufferedAmount()}B)`,
          );
          this.close();
        } else {
          this.sendPing();
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const status = this.sendFrame({ type: "rpc", id, to: this.to, method, params });
      if (status !== "sent") {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DirectError("offline", "直连已断开", status === "failed_midway"));
      }
    });
  }

  subscribe(id: string, stream: StreamKind, params: unknown): boolean {
    return this.send({ type: "stream_subscribe", id, to: this.to, stream, params });
  }

  unsubscribe(id: string): void {
    this.send({ type: "stream_unsubscribe", id, to: this.to });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.initPingTimer) {
      clearTimeout(this.initPingTimer);
      this.initPingTimer = null;
    }
    this.clearPongTimers();
    for (const w of this.pongWaiters.splice(0)) w(null);
    this.partials.clear();
    this.binPartials.clear();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    if (this.portalDc) {
      this.portalDc.onopen = this.portalDc.onmessage = this.portalDc.onclose = this.portalDc.onerror = null;
      try {
        this.portalDc.close();
      } catch {
        // ignore
      }
    }
    if (this.dc) {
      this.dc.onopen = this.dc.onmessage = this.dc.onclose = this.dc.onerror = null;
      try {
        this.dc.close();
      } catch {
        // ignore
      }
    }
    if (this.pc) {
      this.pc.onicecandidate = this.pc.onicegatheringstatechange = this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // ignore
      }
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DirectError("offline", "直连断开了", true));
    }
    this.pending.clear();
    this.handlers.onClose(this);
  }
}
