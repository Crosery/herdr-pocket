/**
 * Direct links: a phone on the same network (or the same VPN, such as Tailscale) talks to this
 * computer without the relay, so calls, streams and files go as fast as the network between them.
 *
 * Nobody can open one without the relay's help: the phone asks the relay (which has authenticated it)
 * for `direct.offer`, gets a single-use ticket and a fresh 32-byte key, and must connect within a
 * minute. Every frame is sealed with that key (ChaCha20-Poly1305, counted nonces), so the network
 * between them sees neither content nor anything it could replay. A request without a live ticket is
 * refused before the WebSocket opens.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { DIRECT_FROM_HOST, DIRECT_PATH, DirectCipher, type DirectAead, type DirectOffer } from "@herdr-pocket/protocol";
import { WebSocket, WebSocketServer } from "ws";

/** RFC 8439 ChaCha20-Poly1305 from Node's crypto. */
export const nodeAead: DirectAead = {
  seal(key, nonce, plain) {
    const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  },
  open(key, nonce, sealed) {
    if (sealed.length < 16) return null;
    try {
      const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
      d.setAuthTag(sealed.subarray(sealed.length - 16));
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
    } catch {
      return null;
    }
  },
};

export const DIRECT_PORT = 7421;
const TICKET_MS = 60_000;

/** One phone connected directly. */
export interface DirectPeer {
  /** Unique per link, so stream ids of two links (or of a link and the relay) never meet. */
  tag: string;
  deviceId: string;
  send(frame: object): void;
  close(): void;
}

export interface DirectServerOptions {
  /** 0: any free port. Busy: any free port. */
  port?: number;
  /** This computer's device id (sent to the phone once the link opens). */
  hostId: () => string;
  onFrame: (peer: DirectPeer, frame: Record<string, unknown>) => void;
  onClose: (peer: DirectPeer) => void;
  log?: (msg: string) => void;
}

const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
const isVpn = (a: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);

/** IPv4 addresses a phone could reach this computer at: home/office networks first, then VPN, then the rest. */
export function directAddrs(nets = networkInterfaces()): string[] {
  const all = Object.values(nets)
    .flat()
    .filter((n): n is NonNullable<typeof n> => !!n && (n.family === "IPv4" || (n.family as unknown) === 4) && !n.internal && !n.address.startsWith("169.254."))
    .map((n) => n.address);
  const rank = (a: string) => (isPrivate(a) ? 0 : isVpn(a) ? 1 : 2);
  return [...new Set(all)].sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}

export class DirectServer {
  port: number | null = null;
  private opts: DirectServerOptions;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private tickets = new Map<string, { deviceId: string; key: Buffer; expiresAt: number }>();
  private peers = new Map<WebSocket, DirectPeer>();
  private seq = 0;
  private beat: NodeJS.Timeout | null = null;

  constructor(opts: DirectServerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    const http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    http.on("upgrade", (req, socket, head) => this.upgrade(wss, req, socket, head));
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const onError = (e: Error) => {
          http.off("listening", onListening);
          reject(e);
        };
        const onListening = () => {
          http.off("error", onError);
          resolve((http.address() as { port: number }).port);
        };
        http.once("error", onError);
        http.once("listening", onListening);
        http.listen(port, "0.0.0.0");
      });
    const wanted = this.opts.port ?? DIRECT_PORT;
    try {
      this.port = await listen(wanted);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || wanted === 0) throw e;
      this.port = await listen(0);
    }
    http.on("error", (e) => this.opts.log?.(`direct links: ${(e as Error).message}`));
    this.http = http;
    this.wss = wss;
    // A phone that went away without closing (out of range, asleep) is dropped within a minute.
    const alive = new WeakSet<WebSocket>();
    this.beat = setInterval(() => {
      for (const ws of this.peers.keys()) {
        if (!alive.has(ws)) {
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        ws.ping();
      }
      const now = Date.now();
      for (const [t, x] of this.tickets) if (x.expiresAt < now) this.tickets.delete(t);
    }, 30_000);
    this.beat.unref?.();
    wss.on("connection", (ws: WebSocket) => {
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      ws.on("message", () => alive.add(ws));
    });
  }

  /** A ticket for `deviceId` (the caller the relay authenticated). */
  offer(deviceId: string): DirectOffer {
    if (!this.port) throw new Error("direct links are off");
    const ticket = randomBytes(16).toString("hex");
    const key = randomBytes(32);
    const expiresAt = Date.now() + TICKET_MS;
    this.tickets.set(ticket, { deviceId, key, expiresAt });
    return { port: this.port, addrs: directAddrs(), ticket, key: key.toString("base64"), expiresAt };
  }

  /** Phones connected now (device ids). */
  connected(): string[] {
    return [...this.peers.values()].map((p) => p.deviceId);
  }

  private upgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // A peer that resets mid-handshake must not take the daemon down (an unhandled socket error would).
    socket.on("error", () => socket.destroy());
    const url = new URL(req.url ?? "/", "http://x");
    const ticket = url.searchParams.get("ticket") ?? "";
    const t = url.pathname === DIRECT_PATH ? this.tickets.get(ticket) : undefined;
    if (!t || t.expiresAt < Date.now()) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    this.tickets.delete(ticket);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      this.accept(ws, t.deviceId, t.key);
    });
  }

  private accept(ws: WebSocket, deviceId: string, key: Buffer): void {
    const cipher = new DirectCipher(nodeAead, key, DIRECT_FROM_HOST);
    const peer: DirectPeer = {
      tag: `direct${++this.seq}:`,
      deviceId,
      send: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(cipher.seal(JSON.stringify(frame)), { binary: true });
      },
      close: () => ws.close(),
    };
    // One link per phone: a new one (the phone came back) replaces the old.
    for (const [other, p] of this.peers) if (p.deviceId === deviceId) other.close(4000, "replaced");
    this.peers.set(ws, peer);
    ws.on("message", (data, isBinary) => {
      const text = isBinary ? cipher.open(new Uint8Array(data as Buffer)) : null;
      if (text === null) {
        // Not sealed with this link's key, or out of order: nothing more from this socket is trusted.
        ws.close(4003, "bad frame");
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      this.opts.onFrame(peer, frame);
    });
    ws.on("close", () => {
      if (this.peers.get(ws) !== peer) return;
      this.peers.delete(ws);
      this.opts.onClose(peer);
    });
    ws.on("error", () => {
      /* close follows */
    });
    peer.send({ type: "welcome", device: this.opts.hostId() });
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat);
    for (const ws of this.peers.keys()) ws.terminate();
    this.peers.clear();
    this.tickets.clear();
    this.wss?.close();
    this.http?.close();
    this.http = null;
    this.port = null;
  }
}
