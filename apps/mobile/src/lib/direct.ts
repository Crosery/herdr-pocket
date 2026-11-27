/**
 * A direct link to one computer: the same calls and streams as through the relay, but straight to the
 * computer when the phone can reach it (same Wi-Fi, or a VPN such as Tailscale on both). The relay
 * hands out a single-use ticket and key (`direct.offer`); every frame is sealed with it
 * (ChaCha20-Poly1305, see the protocol's DirectCipher). Whatever fails here falls back to the relay.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { DIRECT_FROM_PHONE, DIRECT_PATH, DirectCipher, type DirectAead, type DirectOffer, type RpcError, type RpcMethod, type StreamKind } from "@herdr-pocket/protocol";

const aead: DirectAead = {
  seal: (key, nonce, plain) => chacha20poly1305(key, nonce).encrypt(plain),
  open: (key, nonce, sealed) => {
    try {
      return chacha20poly1305(key, nonce).decrypt(sealed);
    } catch {
      return null;
    }
  },
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

/** How long one address may take to open and greet. */
const DIAL_MS = 2500;
/** Pings keep a link honest: 2 missed checks drop a dead link cleanly without background-wake false drops. */
const PING_EVERY_MS = 20_000;
const PONG_WAIT_MS = 10_000;
const MISSED_PONG_LIMIT = 2;
const TIMEOUT_EVICT_LIMIT = 2;

export function classifyDirectAddr(addr: string): { kind: "local" | "lan-p2p" | "vpn-p2p"; label: string } {
  const host = addr.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
    return { kind: "local", label: "本机直连" };
  }
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m) {
    const oct2 = Number(m[1]);
    if (oct2 >= 64 && oct2 <= 127) return { kind: "vpn-p2p", label: "Tailscale P2P" };
  }
  if (host.startsWith("fd7a:115c:a1e0:")) return { kind: "vpn-p2p", label: "Tailscale P2P" };
  return { kind: "lan-p2p", label: "局域网 P2P" };
}

export class DirectError extends Error {
  code: RpcError["code"];
  constructor(code: RpcError["code"], message: string, readonly uncertain = false) {
    super(message);
    this.code = code;
  }
}

type Frame = { type: string; id?: string; result?: unknown; error?: RpcError; device?: string; t?: number; event?: unknown };

export interface DirectHandlers {
  /** A stream frame (`stream_open` / `stream_event`) for a stream this link carries. */
  onStream: (frame: Frame) => void;
  /** The link is gone (closed, dead, replaced). Called once. */
  onClose: (link: DirectLink) => void;
}

export class DirectLink {
  readonly to: string;
  /** The address that answered first. */
  readonly addr: string;
  readonly port: number;
  private ws: WebSocket;
  private cipher: DirectCipher;
  private handlers: DirectHandlers;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval>;
  private initPingTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRxAt = Date.now();
  private lastBidirectionalRxAt = Date.now();
  private lastPingSentAt = 0;
  private rttMs: number | null = null;
  private missedPongs = 0;
  private consecutiveTimeouts = 0;
  private closed = false;

  private constructor(to: string, addr: string, port: number, ws: WebSocket, cipher: DirectCipher, handlers: DirectHandlers) {
    this.to = to;
    this.addr = addr;
    this.port = port;
    this.ws = ws;
    this.cipher = cipher;
    this.handlers = handlers;
    ws.onmessage = (ev) => {
      const text = this.cipher.open(new Uint8Array(ev.data as ArrayBuffer));
      if (text === null) return this.close();
      let f: Frame;
      try {
        f = JSON.parse(text) as Frame;
      } catch {
        return;
      }
      this.onFrame(f);
    };
    ws.onclose = () => this.close();
    ws.onerror = () => this.close();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
    this.initPingTimer = setTimeout(() => {
      this.initPingTimer = null;
      this.ping();
    }, 60);
  }

  getRttMs(): number | null {
    return this.rttMs;
  }

  pingNow(): void {
    this.ping();
  }

  /**
   * Tries every offered address at once; the first that opens and proves it holds the key wins. Rejects
   * when none does in time (the phone is on another network, a firewall is in the way).
   */
  static open(to: string, offer: DirectOffer, handlers: DirectHandlers): Promise<DirectLink> {
    const key = fromBase64(offer.key);
    return new Promise((resolve, reject) => {
      let left = offer.addrs.length;
      let done = false;
      const tries: WebSocket[] = [];
      const give = (why: string) => {
        if (--left > 0 || done) return;
        done = true;
        reject(new DirectError("offline", why));
      };
      if (!left) return reject(new DirectError("offline", "这台电脑没有可用的地址"));
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        for (const w of tries) w.close();
        reject(new DirectError("timeout", "直连没有接通"));
      }, DIAL_MS);
      for (const addr of offer.addrs) {
        const host = addr.includes(":") ? `[${addr}]` : addr;
        const ws = new WebSocket(`ws://${host}:${offer.port}${DIRECT_PATH}?ticket=${encodeURIComponent(offer.ticket)}`);
        ws.binaryType = "arraybuffer";
        tries.push(ws);
        const cipher = new DirectCipher(aead, key, DIRECT_FROM_PHONE);
        let failed = false;
        const fail = (why: string) => {
          if (failed) return;
          failed = true;
          give(why);
        };
        ws.onmessage = (ev) => {
          const text = typeof ev.data === "string" ? null : cipher.open(new Uint8Array(ev.data as ArrayBuffer));
          let f: Frame | null = null;
          try {
            f = text === null ? null : (JSON.parse(text) as Frame);
          } catch {
            f = null;
          }
          // Only the computer the ticket came from can seal this greeting.
          if (!f || f.type !== "welcome" || f.device !== to || done) {
            ws.close();
            return fail("对方不是这台电脑");
          }
          done = true;
          clearTimeout(timer);
          for (const w of tries) if (w !== ws) w.close();
          resolve(new DirectLink(to, addr, offer.port, ws, cipher, handlers));
        };
        ws.onerror = () => fail("连不上");
        ws.onclose = () => fail("连不上");
      }
    });
  }

  get open(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  private send(frame: object): boolean {
    if (!this.open) return false;
    const sealed = this.cipher.seal(JSON.stringify(frame));
    this.ws.send(sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer);
    return true;
  }

  private onFrame(f: Frame) {
    const now = Date.now();
    this.lastRxAt = now;
    if (f.type === "rpc_result" && f.id) {
      this.lastBidirectionalRxAt = now;
      this.missedPongs = 0;
      this.consecutiveTimeouts = 0;
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.error) p.reject(new DirectError(f.error.code, f.error.message));
      else p.resolve(f.result);
    } else if (f.type === "pong") {
      this.lastBidirectionalRxAt = now;
      this.missedPongs = 0;
      this.consecutiveTimeouts = 0;
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      const echoedT = typeof f.t === "number" ? f.t : this.lastPingSentAt;
      if (echoedT > 0) {
        this.rttMs = Math.max(1, Math.min(9999, now - echoedT));
      }
    } else if (f.type === "stream_open" || f.type === "stream_event") this.handlers.onStream(f);
  }

  clearPongWait() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.missedPongs = 0;
  }

  ping() {
    const now = Date.now();
    this.lastPingSentAt = now;
    if (!this.send({ type: "ping", t: now }) || this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.closed) return;
      if (Date.now() - this.lastBidirectionalRxAt < PONG_WAIT_MS) {
        this.missedPongs = 0;
        return;
      }
      this.missedPongs += 1;
      if (this.missedPongs < MISSED_PONG_LIMIT) {
        this.ping();
        return;
      }
      this.close();
    }, PONG_WAIT_MS);
  }

  call(method: RpcMethod, params: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.open) {
      return Promise.reject(new DirectError("offline", "直连断开了", false));
    }
    const id = `d${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.consecutiveTimeouts += 1;
        const staleBidirectional = Date.now() - this.lastBidirectionalRxAt > PONG_WAIT_MS;
        reject(new DirectError("timeout", "电脑那边没有及时回应", true));
        if (this.consecutiveTimeouts >= TIMEOUT_EVICT_LIMIT || staleBidirectional) {
          this.close();
        } else {
          this.ping();
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ type: "rpc", id, to: this.to, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DirectError("offline", "直连断开了", false));
      }
    });
  }

  subscribe(id: string, stream: StreamKind, params: unknown): boolean {
    return this.send({ type: "stream_subscribe", id, to: this.to, stream, params });
  }

  unsubscribe(id: string): void {
    this.send({ type: "stream_unsubscribe", id, to: this.to });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    if (this.initPingTimer) {
      clearTimeout(this.initPingTimer);
      this.initPingTimer = null;
    }
    if (this.pongTimer) clearTimeout(this.pongTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DirectError("offline", "直连断开了", true));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this.handlers.onClose(this);
  }
}
