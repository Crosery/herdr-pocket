import {
  DIRECT_FROM_PHONE,
  DIRECT_PATH,
  DirectCipher,
  jsChaCha20Poly1305,
  type DirectOffer,
  type RpcError,
  type RpcMethod,
  type ServerFrame,
  type StreamKind,
} from "@herdr-pocket/protocol";
import { native } from "./native";
import { logger } from "./log";

export class DirectError extends Error {
  code: RpcError["code"];
  uncertain?: boolean;
  constructor(code: RpcError["code"], message: string, uncertain?: boolean) {
    super(message);
    this.code = code;
    this.uncertain = uncertain;
  }
}

/** Read-only RPCs safe to replay over the relay if the direct socket drops mid-flight. */
export const SAFE_AGAIN = new Set<RpcMethod>([
  "host.info",
  "agents.list",
  "spaces.list",
  "terminal.read",
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

export interface DirectHandlers {
  onStream: (frame: ServerFrame) => void;
  onClose: (link: DirectLink) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DIAL_LOCAL_MS = 1200;
const DIAL_REMOTE_MS = 2200;
const PING_MS = 20_000;
const PONG_WAIT_MS = 15_000;

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

function dialCandidate(
  addr: string,
  port: number,
  ticket: string,
  key: Uint8Array,
  timeoutMs: number,
): Promise<{ ws: WebSocket; cipher: DirectCipher; addr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket;
    const cipher = new DirectCipher(jsChaCha20Poly1305, key, DIRECT_FROM_PHONE);
    const url = `ws://${addr}:${port}${DIRECT_PATH}?ticket=${encodeURIComponent(ticket)}`;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new DirectError("offline", `${addr} dial timed out`));
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
        resolve({ ws, cipher, addr });
      } catch {
        fail("invalid welcome json");
      }
    };
    ws.onerror = () => fail(`connect error on ${addr}`);
    ws.onclose = (ev) => fail(`closed during handshake (${ev.code})`);
  });
}

export class DirectLink {
  readonly to: string;
  readonly addr: string;
  readonly displayAddr: string;
  readonly port: number;
  private ws: WebSocket;
  private cipher: DirectCipher;
  private handlers: DirectHandlers;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval>;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private pingSentAt = 0;
  private rxChain: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    to: string,
    addr: string,
    port: number,
    ws: WebSocket,
    cipher: DirectCipher,
    handlers: DirectHandlers,
    displayAddr = addr,
  ) {
    this.to = to;
    this.addr = addr;
    this.displayAddr = displayAddr;
    this.port = port;
    this.ws = ws;
    this.cipher = cipher;
    this.handlers = handlers;

    ws.onmessage = (ev) => {
      this.enqueueMessage(ev.data);
    };
    ws.onclose = (ev) => {
      logger.info("link.direct", `ws closed on ${this.displayAddr} (code=${ev?.code ?? "?"})`);
      this.close();
    };
    ws.onerror = () => {
      logger.warn("link.direct", `ws error on ${this.displayAddr}`);
      this.close();
    };

    this.pingTimer = setInterval(() => this.sendPing(), PING_MS);
  }

  get open(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  static async open(
    to: string,
    offer: DirectOffer,
    handlers: DirectHandlers,
    preferLoopback = false,
  ): Promise<DirectLink> {
    const key = decodeBase64(offer.key);
    const candidates = preferLoopback
      ? ["127.0.0.1", ...offer.addrs.filter((a) => a !== "127.0.0.1")]
      : [...offer.addrs];
    if (candidates.length === 0) {
      throw new DirectError("offline", "这台电脑没有可直连的地址");
    }

    if (native.available() && !preferLoopback) {
      logger.info("link.direct", `probing ${candidates.join(", ")}:${offer.port} via native tunnel`);
      const tunnel = await native.openDirectTunnel(candidates, offer.port);
      if (tunnel && tunnel.localPort > 0) {
        try {
          const win = await dialCandidate("127.0.0.1", tunnel.localPort, offer.ticket, key, DIAL_LOCAL_MS);
          logger.info("link.direct", `tunnel connected -> ${tunnel.remoteAddr}:${offer.port} (local:${tunnel.localPort})`);
          return new DirectLink(to, "127.0.0.1", tunnel.localPort, win.ws, win.cipher, handlers, tunnel.remoteAddr);
        } catch (err) {
          logger.warn("link.direct", `tunnel handshake failed (${String(err)}), falling back to direct race`);
        }
      } else {
        logger.warn("link.direct", `native tunnel unavailable for ${candidates.join(", ")}, falling back to direct race`);
      }
    }

    const STAGGER_MS = 120;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const opened: WebSocket[] = [];
    let settled = false;

    const cleanup = (keep?: WebSocket) => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      for (const sock of opened) {
        if (sock === keep) continue;
        sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
        try {
          sock.close();
        } catch {
          // ignore
        }
      }
    };

    try {
      const win = await Promise.any(
        candidates.map(
          (addr, idx) =>
            new Promise<{ ws: WebSocket; cipher: DirectCipher; addr: string }>((resolve, reject) => {
              const run = () => {
                if (settled) {
                  reject(new DirectError("offline", "cancelled"));
                  return;
                }
                const timeoutMs = addr === "127.0.0.1" ? DIAL_LOCAL_MS : DIAL_REMOTE_MS;
                dialCandidate(addr, offer.port, offer.ticket, key, timeoutMs)
                  .then((res) => {
                    opened.push(res.ws);
                    if (settled) {
                      try {
                        res.ws.close();
                      } catch {
                        // ignore
                      }
                      reject(new DirectError("offline", "cancelled"));
                      return;
                    }
                    settled = true;
                    resolve(res);
                  })
                  .catch((err) => reject(err));
              };
              if (idx === 0) run();
              else timers.push(setTimeout(run, idx * STAGGER_MS));
            }),
        ),
      );
      cleanup(win.ws);
      return new DirectLink(to, win.addr, offer.port, win.ws, win.cipher, handlers, win.addr);
    } catch (agg) {
      cleanup();
      const firstErr =
        agg && typeof agg === "object" && "errors" in agg && Array.isArray((agg as { errors: unknown[] }).errors)
          ? ((agg as { errors: Error[] }).errors[0] ?? new DirectError("offline", "无法直连这台电脑"))
          : new DirectError("offline", "无法直连这台电脑");
      throw firstErr instanceof Error ? firstErr : new DirectError("offline", String(firstErr));
    }
  }

  private enqueueMessage(data: unknown): void {
    if (this.closed) return;
    const syncBytes = rawToBytesSync(data);
    if (syncBytes) {
      // Run ArrayBuffer / TypedArray decryption synchronously so ChaCha20 nonce order never drifts across microtasks.
      this.processPacketBytes(syncBytes);
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
      this.processPacketBytes(bytes);
    });
  }

  private processPacketBytes(bytes: Uint8Array): void {
    if (this.closed) return;
    const text = this.cipher.open(bytes);
    if (text === null) {
      logger.warn("link.direct", `cipher open failed on ${this.displayAddr}`);
      this.close();
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(text) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === "pong") {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }
    if (frame.type === "rpc_result") {
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
    const now = Date.now();
    this.pingSentAt = now;
    if (!this.send({ type: "ping", t: now })) return;
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.closed) return;
        const elapsed = Date.now() - this.pingSentAt;
        if (elapsed > PONG_WAIT_MS + 5_000) {
          // WKWebView / App Nap froze timers: probe once more instead of tearing down a healthy socket.
          this.sendPing();
          return;
        }
        logger.warn("link.direct", `direct pong timeout on ${this.displayAddr} (${elapsed}ms)`);
        this.close();
      }, PONG_WAIT_MS);
    }
  }

  private send(frame: Record<string, unknown>): boolean {
    if (!this.open) return false;
    try {
      const sealed = this.cipher.seal(JSON.stringify(frame));
      this.ws.send(sealed);
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  call(method: RpcMethod, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.open) {
      return Promise.reject(new DirectError("offline", "直连已断开", true));
    }
    const id = `d${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DirectError("timeout", "直连请求超时", true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ type: "rpc", id, to: this.to, method, params })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DirectError("offline", "直连已断开", true));
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
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DirectError("offline", "直连断开了", true));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.handlers.onClose(this);
  }
}
