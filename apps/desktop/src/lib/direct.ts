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
const PONG_WAIT_MS = 6_000;

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function rawToBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
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
  readonly port: number;
  private ws: WebSocket;
  private cipher: DirectCipher;
  private handlers: DirectHandlers;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval>;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private constructor(
    to: string,
    addr: string,
    port: number,
    ws: WebSocket,
    cipher: DirectCipher,
    handlers: DirectHandlers,
  ) {
    this.to = to;
    this.addr = addr;
    this.port = port;
    this.ws = ws;
    this.cipher = cipher;
    this.handlers = handlers;

    ws.onmessage = (ev) => {
      void this.handleMessage(ev.data);
    };
    ws.onclose = () => this.close();
    ws.onerror = () => this.close();

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

    let lastErr: Error = new DirectError("offline", "无法直连这台电脑");
    for (const addr of candidates) {
      try {
        const timeoutMs = addr === "127.0.0.1" ? DIAL_LOCAL_MS : DIAL_REMOTE_MS;
        const win = await dialCandidate(addr, offer.port, offer.ticket, key, timeoutMs);
        return new DirectLink(to, win.addr, offer.port, win.ws, win.cipher, handlers);
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr;
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (this.closed) return;
    const bytes = await rawToBytes(data);
    const text = bytes ? this.cipher.open(bytes) : null;
    if (text === null) {
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
    if (!this.send({ type: "ping", t: Date.now() })) return;
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
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
