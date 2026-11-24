import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type Device,
  type DeviceKind,
  type DirectOffer,
  type JoinClaim,
  type JoinRequest,
  type JoinTicket,
  type PairCode,
  type PairRequest,
  type PairResponse,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerFrame,
  type StreamKind,
} from "@herdr-pocket/protocol";
import { DirectError, DirectLink, SAFE_AGAIN } from "./direct";
import { createIdentityProof } from "./h5Identity";
import { localHostIdStore, refreshLocalHostIdFast } from "./fonts";
import { liveStore, settingsStore, updateSettings } from "./store";
import { clearSession, defaultDeviceName, detectPlatform, getLocalPairCode, pushSystemNotification, saveSession, type LocalPairError } from "./bridge";
import { isMockServer, mockApi } from "./mock";
import { loadAssistant, onAssistantFrame } from "./assistant";
import { logger, registerWebLogUploader } from "./log";
import { onNativeEvent } from "./native";
import { recordClientRpcSample } from "./perfTelemetry";

export class RelayError extends Error {
  code: RpcError["code"];
  constructor(code: RpcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function normalizeServer(input: string): string {
  const s = input.trim().replace(/\/+$/, "");
  if (isMockServer(s)) return s;
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export function wsUrlFor(server: string, path: string, token: string): string {
  const base = server.trim().replace(/\/+$/, "");
  const proto = base.startsWith("https://") ? "wss://" : base.startsWith("http://") ? "ws://" : "wss://";
  const host = base.replace(/^https?:\/\//i, "");
  const sep = path.includes("?") ? "&" : "?";
  return `${proto}${host}${path}${sep}token=${encodeURIComponent(token)}`;
}

export async function restRequest<T>(
  server: string,
  path: string,
  init: RequestInit & { token?: string; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), init.timeoutMs ?? 12_000);
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      credentials: "same-origin",
      ...init,
      signal: abort.signal,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    logger.warn("relay", `${init.method ?? "GET"} ${path} failed: ${(err as Error)?.name === "AbortError" ? "timeout" : String(err)}`);
    throw new RelayError("offline", `连不上 ${server.replace(/^https?:\/\//i, "")}：检查地址是否写对、服务器是否在运行；公司网络可能需要代理`);
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: RpcError } & T;
  if (!res.ok) {
    const err = body.error;
    logger.warn("relay", `${init.method ?? "GET"} ${path} -> HTTP ${res.status} ${err?.code ?? ""} ${err?.message ?? ""}`);
    throw new RelayError(err?.code ?? (res.status === 401 ? "unauthorized" : "internal"), err?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

/** How a pair code reached this app; only the relay's log sees it (PairRequest.via). */
export type PairVia = "local-login" | "link" | "typed" | "qr";

export async function pairDevice(
  server: string,
  code: string,
  name: string,
  platform: string,
  previousToken?: string,
  via: PairVia = "typed",
): Promise<PairResponse> {
  if (isMockServer(server)) return mockApi.pair(code, name, platform);
  const identity = await createIdentityProof();
  const req: PairRequest = {
    code: code.trim().toUpperCase(),
    name,
    kind: "viewer",
    platform,
    via,
    ...(identity ? { identity } : {}),
  };
  return restRequest<PairResponse>(server, "/v1/pair", {
    method: "POST",
    token: previousToken,
    body: JSON.stringify(req),
  });
}

type LinkState = ReturnType<typeof liveStore.get>["link"];

/** Every change of the link state goes through here, so each transition is logged exactly once. */
function setLink(next: LinkState, detail?: string): void {
  const prev = liveStore.get().link;
  if (prev === next) return;
  liveStore.set({ link: next });
  const line = `link ${prev} -> ${next}${detail ? ` (${detail})` : ""}`;
  if (next === "online" || next === "connecting" || next === "idle") logger.info("link", line);
  else logger.warn("link", line);
}

export async function createPairCode(server: string, token: string, kind?: DeviceKind): Promise<PairCode> {
  if (isMockServer(server)) return mockApi.createPairCode(kind);
  return restRequest<PairCode>(server, "/v1/pair/codes", {
    method: "POST",
    token,
    body: JSON.stringify(kind ? { kind } : {}),
  });
}

export async function getJoinRequest(server: string, token: string, id: string): Promise<JoinRequest> {
  return restRequest<JoinRequest>(server, `/v1/join/${encodeURIComponent(id)}`, { token });
}

export async function answerJoinRequest(server: string, token: string, id: string, allow: boolean): Promise<Device | null> {
  const res = await restRequest<{ device?: Device }>(server, `/v1/join/${encodeURIComponent(id)}/${allow ? "approve" : "deny"}`, {
    method: "POST",
    token,
  });
  return res.device ?? null;
}

export async function revokeDevice(server: string, token: string, id: string): Promise<void> {
  if (isMockServer(server)) return;
  await restRequest(server, `/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE", token });
}

export async function tokenStillValid(server: string, token: string): Promise<boolean> {
  try {
    await restRequest(server, "/v1/devices", { token });
    return true;
  } catch (e) {
    return !(e instanceof RelayError && e.code === "unauthorized");
  }
}

/** Ping cadence; the relay answers each ping with a pong. */
const HEARTBEAT_MS = 20_000;
/** Watchdog cadence (also how soon a hung connect or a dead socket is noticed). */
const TICK_MS = 5_000;
/** An open socket with no frame and no pong for this long is dead. */
const SILENT_DEAD_MS = 2 * HEARTBEAT_MS;
/** A watchdog tick this late means timers were throttled or the page was frozen, not that the link died. */
const TIMER_GAP_MS = 3 * TICK_MS;
const PONG_TIMEOUT_MS = 8_000;
const WAKE_PONG_TIMEOUT_MS = 4_000;
const CONNECT_TIMEOUT_MS = 12_000;
const MAX_BACKOFF_MS = 15_000;

/** Native "app://wake" (src-tauri/src/mainwin.rs): window focus/show, Dock reopen, network change. */
const WAKE_EVENT = "app://wake";
interface AppWake {
  reason?: string;
  /** Only with reason "network"; null when the system could not tell. */
  online?: boolean | null;
}

/** Runs a callback that belongs to someone else; its exception must not stop the reconnect logic. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn("relay", `listener failed: ${String(err)}`);
  }
}

type StreamCb = (ev: any) => void;
interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Sub {
  id: string;
  to: string;
  stream: StreamKind;
  params: unknown;
  onEvent: StreamCb;
  onState?: StreamCb;
  via?: DirectLink;
}

interface DirectTryState {
  busy: boolean;
  next: number;
  fails: number;
}

class SocketClient {
  private ws: WebSocket | null = null;
  private notifyWs: WebSocket | null = null;
  private pending = new Map<string, PendingRpc>();
  private subs = new Map<string, Sub>();
  private direct = new Map<string, DirectLink>();
  private directTry = new Map<string, DirectTryState>();
  private spaceInflight = new Map<string, Promise<void>>();
  private spaceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private spaceSig = new Map<string, string>();
  private seq = 0;
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private welcomed = false;
  private seenNoticeIds = new Set<string>();
  /** Last time anything arrived on the socket (frames and pongs alike). */
  private lastSeen = 0;
  private lastPing = 0;
  private connectStartedAt = 0;
  private attempt = 0;
  private lastTick = Date.now();
  /** When the current socket was first seen closing without its close event (0: not seen). */
  private stuckSince = 0;
  private readonly offWake: () => void;
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") this.wake("window visible");
  };
  private readonly onFocus = () => this.wake("window focus");
  private readonly onOnline = () => this.wake("network online");
  private readonly onOffline = () => logger.warn("link", "network offline (system)");

  private server: string;
  readonly token: string;

  constructor(server: string, token: string) {
    this.server = server;
    this.token = token;
    this.open();
    this.openNotify();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    // Timers can stall while the window is hidden (App Nap, WKWebView throttling): these
    // events check the link again as soon as the app or the network comes back.
    if (typeof window !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisible);
      window.addEventListener("focus", this.onFocus);
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
    }
    // The desktop app also tells us about Dock reopen and network changes the page cannot see.
    this.offWake = onNativeEvent<AppWake>(WAKE_EVENT, (p) => this.onAppWake(p ?? {}));
  }

  private onAppWake(p: AppWake): void {
    const reason = p.reason || "unknown";
    if (reason === "network" && p.online === false) {
      // Nothing to reconnect to yet; an open socket is probably dead, and a ping tells.
      logger.warn("link", "app wake: network gone");
      if (this.ws?.readyState === WebSocket.OPEN) this.ping(WAKE_PONG_TIMEOUT_MS, "network gone: no pong");
      return;
    }
    this.wake(`app wake: ${reason}`);
  }

  private send(frame: ClientFrame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private open(): void {
    if (this.closed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.attempt += 1;
    this.connectStartedAt = Date.now();
    this.stuckSince = 0;
    setLink("connecting", `attempt ${this.attempt}`);
    this.welcomed = false;
    logger.info("relay", `connecting to ${this.server} (attempt ${this.attempt})`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrlFor(this.server, "/v1/ws", this.token));
    } catch (err) {
      // Without this the retry chain would end here: no socket, so no close event, no next try.
      this.dropSocket(`cannot open socket: ${String(err)}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      this.send({ type: "hello", version: PROTOCOL_VERSION, platform: detectPlatform() });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      this.lastSeen = Date.now();
      try {
        this.onFrame(JSON.parse(ev.data) as ServerFrame);
      } catch {
        // ignore invalid json
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.dropSocket(`socket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`, ev.code);
    };
  }

  /**
   * Forgets the current socket without waiting for its close event (a half-open socket can
   * take minutes to report one), fails what was waiting on it and schedules the next try.
   */
  private dropSocket(reason: string, code?: number, retryNow = false): void {
    const old = this.ws;
    this.ws = null;
    this.stuckSince = 0;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) {
        try {
          old.close(4000, "reconnect");
        } catch {
          // already closing
        }
      }
    }
    this.clearPong();
    const subs = [...this.subs.values()];
    const pending = [...this.pending.values()];
    this.pending.clear();
    // The next try is booked before anyone else's code runs, so nothing can end the chain.
    if (!this.closed && code !== 4001) {
      const delay = retryNow ? 0 : this.backoff;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.open(), delay);
      if (!retryNow) this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      logger.warn("relay", `${reason}; reconnect in ${delay} ms`);
      if (!this.welcomed) {
        void tokenStillValid(this.server, this.token).then((ok) => {
          if (!ok && !this.closed) {
            setLink("unauthorized", "token no longer valid");
            this.closed = true;
          }
        });
      }
    }
    if (!this.closed) setLink(code === 4001 ? "unauthorized" : "offline", reason);
    for (const s of subs) {
      if (!s.via) safely(() => s.onState?.({ kind: "stale", error: "连接断开" }));
    }
    for (const p of pending) {
      clearTimeout(p.timer);
      safely(() => p.reject(new RelayError("offline", "连接断开")));
    }
  }

  /** Closes the socket and connects again now; `cause` is logged. */
  private reconnect(cause: string): void {
    if (this.closed || liveStore.get().link === "unauthorized") return;
    logger.info("link", `reconnect: ${cause}`);
    this.dropSocket(cause, undefined, true);
    // If the link went silent, so did the notification socket, and nothing is ever sent on it.
    this.recycleNotify();
  }

  /**
   * Watchdog, every TICK_MS. It keeps the chain going: there is always either a socket being
   * watched or a retry booked. A connect that hangs, a socket stuck closing, or an open socket
   * with no frame or pong for two heartbeats is replaced instead of waiting for a close event.
   */
  private tick(): void {
    if (this.closed) return;
    const now = Date.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    const ws = this.ws;
    if (!ws) {
      if (!this.retryTimer && liveStore.get().link !== "unauthorized") {
        logger.warn("link", "watchdog: no socket and no retry booked");
        this.open();
      }
      return;
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      if (now - this.connectStartedAt > CONNECT_TIMEOUT_MS) {
        this.reconnect(`connect timed out after ${Math.round((now - this.connectStartedAt) / 1000)} s`);
      }
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      // CLOSING or CLOSED with no close event yet: a half-open socket can stay like that for minutes.
      if (!this.stuckSince) this.stuckSince = now;
      else if (now - this.stuckSince >= TICK_MS) this.dropSocket(`socket stuck closing for ${Math.round((now - this.stuckSince) / 1000)} s`);
      return;
    }
    if (gap > TIMER_GAP_MS) {
      // Throttled or frozen timers (hidden window, App Nap): silence proves nothing, a ping does.
      logger.info("link", `timers resumed after ${Math.round(gap / 1000)} s; checking the link`);
      this.ping(WAKE_PONG_TIMEOUT_MS, `no pong after a ${Math.round(gap / 1000)} s timer gap`);
      return;
    }
    if (!this.welcomed && now - this.connectStartedAt > CONNECT_TIMEOUT_MS) {
      this.reconnect(`no welcome ${Math.round((now - this.connectStartedAt) / 1000)} s after connecting`);
      return;
    }
    if (this.lastSeen && now - this.lastSeen > SILENT_DEAD_MS) {
      this.reconnect(`no frame or pong for ${Math.round((now - this.lastSeen) / 1000)} s`);
      return;
    }
    if (now - this.lastPing >= HEARTBEAT_MS) this.ping(PONG_TIMEOUT_MS, "pong timeout");
  }

  /** The app or the network came back: reconnect now, or prove an open link with a ping. */
  private wake(cause: string): void {
    if (this.closed) return;
    const link = liveStore.get().link;
    if (link === "unauthorized") return;
    if (settingsStore.get().notifications && !this.notifyWs) this.openNotify();
    this.tryDirectAll(cause.includes("network") || cause.includes("wake"));
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      // One ping in flight is enough (focus and app wake usually arrive together).
      if (this.pongTimer || Date.now() - this.lastPing < 2_000) return;
      logger.debug("link", `${cause}: checking the link`);
      this.ping(WAKE_PONG_TIMEOUT_MS, `${cause}: no pong`);
      return;
    }
    if (ws?.readyState === WebSocket.CONNECTING && Date.now() - this.connectStartedAt < 5_000) return;
    this.backoff = 1000;
    this.reconnect(cause);
  }

  private recycleNotify(): void {
    const old = this.notifyWs;
    if (!old) return;
    this.notifyWs = null;
    old.onmessage = old.onclose = null;
    try {
      old.close(4000, "reconnect");
    } catch {
      // already closing
    }
    this.openNotify();
  }

  private openNotify(): void {
    if (this.closed || !settingsStore.get().notifications) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrlFor(this.server, `/v1/notify?since=${Date.now()}`, this.token));
    } catch (err) {
      logger.warn("relay", `cannot open the notification socket: ${String(err)}`);
      setTimeout(() => {
        if (!this.notifyWs) this.openNotify();
      }, 5000);
      return;
    }
    this.notifyWs = ws;
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as { type?: string; notice?: { id: string; title: string; body: string } };
        if (msg.type === "notice" && msg.notice && !this.seenNoticeIds.has(msg.notice.id)) {
          this.seenNoticeIds.add(msg.notice.id);
          if (this.seenNoticeIds.size > 100) {
            const first = this.seenNoticeIds.values().next().value;
            if (first) this.seenNoticeIds.delete(first);
          }
          if (settingsStore.get().notifications) {
            const winActive =
              typeof document !== "undefined" &&
              document.visibilityState === "visible" &&
              document.hasFocus();
            if (!winActive) {
              void pushSystemNotification(msg.notice.title, msg.notice.body);
            }
          }
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      if (this.notifyWs !== ws) return;
      this.notifyWs = null;
      if (!this.closed && settingsStore.get().notifications) {
        setTimeout(() => this.openNotify(), 5000);
      }
    };
  }

  private onFrame(f: ServerFrame): void {
    switch (f.type) {
      case "welcome":
        this.welcomed = true;
        setLink("online", `attempt ${this.attempt}, ${Date.now() - this.connectStartedAt} ms`);
        this.backoff = 1000;
        this.attempt = 0;
        void loadAssistant();
        for (const s of this.subs.values()) {
          if (!s.via) this.send({ type: "stream_subscribe", id: s.id, to: s.to, stream: s.stream, params: s.params });
        }
        this.tryDirectAll(false);
        break;
      case "snapshot": {
        const devices: Record<string, Device> = {};
        for (const d of f.devices) devices[d.id] = d;
        const agents: Record<string, import("@herdr-pocket/protocol").Agent[]> = {};
        for (const a of f.agents) (agents[a.deviceId] ??= []).push(a);
        liveStore.set({ devices, agents, rev: liveStore.get().rev + 1 });
        for (const d of f.devices) {
          if (d.kind === "host" && !d.online) this.closeDirectFor(d.id);
        }
        this.tryDirectAll(true);
        for (const d of f.devices) {
          if (d.kind === "host" && d.online) this.scheduleSpacesRefresh(d.id, 0);
        }
        break;
      }
      case "device":
        liveStore.set((prev) => ({
          ...prev,
          devices: { ...prev.devices, [f.device.id]: f.device },
          rev: prev.rev + 1,
        }));
        if (f.device.kind === "host") {
          if (f.device.online) {
            this.tryDirect(f.device.id, true);
            this.scheduleSpacesRefresh(f.device.id, 0);
          } else {
            this.closeDirectFor(f.device.id);
          }
        }
        break;
      case "device_removed":
        this.closeDirectFor(f.id);
        this.clearSpaceTimer(f.id);
        this.spaceSig.delete(f.id);
        liveStore.set((prev) => {
          const devices = { ...prev.devices };
          delete devices[f.id];
          const agents = { ...prev.agents };
          delete agents[f.id];
          const spaces = { ...prev.spaces };
          delete spaces[f.id];
          return { ...prev, devices, agents, spaces, rev: prev.rev + 1 };
        });
        break;
      case "agents":
        liveStore.set((prev) => ({
          ...prev,
          agents: { ...prev.agents, [f.deviceId]: f.agents },
          rev: prev.rev + 1,
        }));
        if (liveStore.get().devices[f.deviceId]?.online !== false) {
          this.scheduleSpacesRefresh(f.deviceId, 500);
        }
        break;
      case "rpc_result": {
        const p = this.pending.get(f.id);
        if (!p) break;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.error) {
          logger.warn("rpc", `${f.id} ${f.error.code}: ${f.error.message}`);
          p.reject(new RelayError(f.error.code, f.error.message));
        }
        else p.resolve(f.result);
        break;
      }
      case "stream_open": {
        const s = this.subs.get(f.id);
        if (!s) break;
        if (f.error) s.onState?.({ kind: "error", code: f.error.code, error: f.error.message });
        else s.onState?.({ kind: "live", result: f.result });
        break;
      }
      case "stream_event":
        this.subs.get(f.id)?.onEvent(f.event);
        break;
      case "pong":
        this.clearPong();
        break;
      case "error":
        logger.warn("relay", `server error ${f.error.code}: ${f.error.message}`);
        if (f.error.code === "unauthorized") setLink("unauthorized", "server said unauthorized");
        break;
      default:
        onAssistantFrame(f);
    }
  }

  private ping(timeoutMs: number, cause: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastPing = Date.now();
    this.send({ type: "ping", t: this.lastPing });
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.reconnect(cause);
      }, timeoutMs);
    }
  }

  private clearPong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private openStream(s: Sub): void {
    const sent = s.via
      ? s.via.subscribe(s.id, s.stream, s.params)
      : this.send({ type: "stream_subscribe", id: s.id, to: s.to, stream: s.stream, params: s.params });
    if (!sent) s.onState?.({ kind: "stale", error: "连接断开" });
  }

  private rehome(to: string): void {
    const link = this.direct.get(to);
    const active = link?.open ? link : undefined;
    for (const s of [...this.subs.values()]) {
      if (s.to !== to || s.via === active) continue;
      if (s.via) s.via.unsubscribe(s.id);
      else if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "stream_unsubscribe", id: s.id, to });
      this.subs.delete(s.id);
      s.id = `s${++this.seq}`;
      s.via = active;
      this.subs.set(s.id, s);
      this.openStream(s);
    }
  }

  private clearSpaceTimer(hostId: string): void {
    const t = this.spaceTimers.get(hostId);
    if (t) {
      clearTimeout(t);
      this.spaceTimers.delete(hostId);
    }
  }

  scheduleSpacesRefresh(hostId: string, delayMs = 0): void {
    if (this.closed) return;
    if (delayMs <= 0) {
      this.clearSpaceTimer(hostId);
      void this.refreshHostSpaces(hostId);
      return;
    }
    if (this.spaceTimers.has(hostId)) return;
    const t = setTimeout(() => {
      this.spaceTimers.delete(hostId);
      void this.refreshHostSpaces(hostId);
    }, delayMs);
    this.spaceTimers.set(hostId, t);
  }

  refreshHostSpaces(hostId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const inflight = this.spaceInflight.get(hostId);
    if (inflight) return inflight;
    const job = (this.call(hostId, "spaces.list", {}, 10_000) as Promise<RpcResult<"spaces.list">>)
      .then((res) => {
        if (this.closed || !Array.isArray(res?.spaces)) return;
        const sig = JSON.stringify(res.spaces);
        if (this.spaceSig.get(hostId) === sig) return;
        this.spaceSig.set(hostId, sig);
        liveStore.set((prev) => ({
          ...prev,
          spaces: { ...prev.spaces, [hostId]: res.spaces },
          rev: prev.rev + 1,
        }));
      })
      .catch(() => {
        // Offline or older hostd: keep previous spaces safely.
      })
      .finally(() => {
        this.spaceInflight.delete(hostId);
      });
    this.spaceInflight.set(hostId, job);
    return job;
  }

  private closeDirectFor(to: string): void {
    const link = this.direct.get(to);
    if (link) {
      link.close();
    }
  }

  private tryDirectAll(now: boolean): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    const localId = localHostIdStore.get();
    for (const d of Object.values(liveStore.get().devices)) {
      if (d.kind === "host" && d.online) {
        this.tryDirect(d.id, now || (localId !== null && d.id === localId));
      }
    }
  }

  private tryDirect(to: string, now: boolean): void {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.direct.get(to)?.open) return;
    const t = this.directTry.get(to) ?? { busy: false, next: 0, fails: 0 };
    this.directTry.set(to, t);
    if (t.busy || t.next === Infinity || (!now && Date.now() < t.next)) return;
    t.busy = true;
    void (async () => {
      try {
        const localId = localHostIdStore.get() ?? (await refreshLocalHostIdFast());
        const preferLoopback = localId !== null && localId === to;
        const offer = (await this.relayCall(to, "direct.offer", {}, 8_000)) as DirectOffer;
        if (this.closed) return;
        const link = await DirectLink.open(
          to,
          offer,
          {
            onStream: (frame) => this.onFrame(frame),
            onClose: (l) => this.directGone(l),
          },
          preferLoopback,
        );
        if (this.closed) {
          link.close();
          return;
        }
        t.fails = 0;
        t.next = 0;
        this.direct.set(to, link);
        liveStore.set((prev) => ({ ...prev, direct: { ...prev.direct, [to]: link.addr } }));
        logger.info("link", `direct link to ${liveStore.get().devices[to]?.name ?? to} via ${link.addr}`);
        this.rehome(to);
      } catch (e) {
        t.fails += 1;
        if (e instanceof RelayError && (e.code === "unsupported" || e.code === "forbidden")) {
          t.next = Infinity;
        } else {
          const isLocal = localHostIdStore.get() === to;
          const capMs = isLocal ? 15_000 : 5 * 60_000;
          const baseMs = isLocal ? 2_000 : 15_000;
          t.next = Date.now() + Math.min(capMs, baseMs * 2 ** Math.min(t.fails - 1, 5));
        }
      } finally {
        t.busy = false;
      }
    })();
  }

  private directGone(link: DirectLink): void {
    if (this.direct.get(link.to) !== link) return;
    this.direct.delete(link.to);
    liveStore.set((prev) => {
      const direct = { ...prev.direct };
      delete direct[link.to];
      return { ...prev, direct };
    });
    if (this.closed) return;
    logger.info("link", `direct link closed (${link.to}), using relay`);
    const t = this.directTry.get(link.to);
    if (t && t.next !== Infinity) t.next = Date.now() + 2_000;
    this.rehome(link.to);
  }

  private relayCall(to: string, method: RpcMethod, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RelayError("offline", "当前未连上服务器"));
    }
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError("timeout", "电脑久久没有响应"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ type: "rpc", id, to, method, params })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new RelayError("offline", "连接刚断开了"));
      }
    });
  }

  async call(to: string, method: RpcMethod, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsed = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    const link = this.direct.get(to);
    if (!link?.open || method === "direct.offer") {
      try {
        const out = await this.relayCall(to, method, params, timeoutMs);
        recordClientRpcSample(method, elapsed(), false, true);
        return out;
      } catch (err) {
        recordClientRpcSample(method, elapsed(), false, false);
        throw err;
      }
    }
    try {
      const out = await link.call(method, params, timeoutMs);
      recordClientRpcSample(method, elapsed(), true, true);
      return out;
    } catch (err: unknown) {
      if (!(err instanceof DirectError)) {
        recordClientRpcSample(method, elapsed(), true, false);
        throw err;
      }
      if ((err.code === "offline" || err.code === "timeout") && SAFE_AGAIN.has(method)) {
        try {
          const fallback = await this.relayCall(to, method, params, timeoutMs);
          recordClientRpcSample(method, elapsed(), false, true);
          return fallback;
        } catch (err2) {
          recordClientRpcSample(method, elapsed(), false, false);
          throw err2;
        }
      }
      recordClientRpcSample(method, elapsed(), true, false);
      throw new RelayError(err.code, err.message);
    }
  }

  directEndpoint(to: string): { addr: string; port: number } | null {
    const link = this.direct.get(to);
    return link?.open ? { addr: link.addr, port: link.port } : null;
  }

  subscribe(to: string, stream: StreamKind, params: unknown, onEvent: StreamCb, onState?: StreamCb): () => void {
    const id = `s${++this.seq}`;
    const link = this.direct.get(to);
    const sub: Sub = { id, to, stream, params, onEvent, onState, via: link?.open ? link : undefined };
    this.subs.set(id, sub);
    if (sub.via || this.ws?.readyState === WebSocket.OPEN) {
      this.openStream(sub);
    }
    return () => {
      const cur = this.subs.get(id);
      if (cur === sub) this.subs.delete(id);
      if (sub.via) sub.via.unsubscribe(id);
      else if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "stream_unsubscribe", id, to });
      }
    };
  }

  refreshNotify(): void {
    if (settingsStore.get().notifications) {
      if (!this.notifyWs) this.openNotify();
    } else if (this.notifyWs) {
      this.notifyWs.close();
      this.notifyWs = null;
    }
  }

  /** "立即重连": try now instead of waiting for the backoff. */
  retryNow(): void {
    this.backoff = 1000;
    this.wake("user asked to reconnect");
  }

  close(): void {
    this.closed = true;
    this.clearPong();
    for (const d of [...this.direct.values()]) d.close();
    this.direct.clear();
    for (const t of this.spaceTimers.values()) clearTimeout(t);
    this.spaceTimers.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.offWake();
    if (typeof window !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisible);
      window.removeEventListener("focus", this.onFocus);
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
    }
    if (this.ws) this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    this.ws?.close(1000, "bye");
    this.notifyWs?.close(1000, "bye");
    this.ws = null;
    this.notifyWs = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RelayError("offline", "已断开连接"));
    }
    this.pending.clear();
  }
}

let activeClient: SocketClient | null = null;
let currentToken: string | null = null;

export function getActiveToken(): string | null {
  return currentToken;
}

export function startRelayLink(server: string, token: string): void {
  stopRelayLink();
  currentToken = token;
  if (isMockServer(server)) {
    registerWebLogUploader(null);
    mockApi.connect();
    return;
  }
  activeClient = new SocketClient(server, token);
  registerWebLogUploader(async (entries) => {
    try {
      const res = await fetch(`${normalizeServer(server)}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ entries }),
      });
      if (res.status === 404 || res.status === 401) return true;
      return res.ok;
    } catch {
      return false;
    }
  });
}

export function stopRelayLink(): void {
  registerWebLogUploader(null);
  activeClient?.close();
  activeClient = null;
  currentToken = null;
  setLink("idle");
  liveStore.set({ devices: {}, agents: {}, spaces: {}, direct: {}, rev: liveStore.get().rev + 1 });
}

export function refreshNotifyChannel(): void {
  activeClient?.refreshNotify();
}

export function pingRelay(): void {
  const s = settingsStore.get();
  if (s.server && isMockServer(s.server)) {
    mockApi.connect();
  } else {
    activeClient?.retryNow();
  }
}

/** Re-fetches `spaces.list` for a specific online host or all online hosts into `liveStore.spaces`. */
export function refreshHostSpaces(hostId?: string): void {
  const s = settingsStore.get();
  if (s.server && isMockServer(s.server)) return;
  if (!activeClient) return;
  if (hostId) {
    activeClient.scheduleSpacesRefresh(hostId, 0);
    return;
  }
  for (const d of Object.values(liveStore.get().devices)) {
    if (d.kind === "host" && d.online) activeClient.scheduleSpacesRefresh(d.id, 0);
  }
}

export async function rpcCall<M extends RpcMethod>(
  to: string,
  method: M,
  params: RpcParams<M>,
  timeoutMs = 15_000,
): Promise<RpcResult<M>> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    return mockApi.call(to, method, params) as Promise<RpcResult<M>>;
  }
  if (!activeClient) throw new RelayError("offline", "还没连上服务器");
  return activeClient.call(to, method, params, timeoutMs) as Promise<RpcResult<M>>;
}

export function getDirectEndpoint(to: string): { addr: string; port: number } | null {
  return activeClient?.directEndpoint(to) ?? null;
}

export function subscribeStream(
  to: string,
  stream: StreamKind,
  params: unknown,
  onEvent: StreamCb,
  onState?: StreamCb,
): () => void {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    return mockApi.subscribe(to, stream, params, onEvent, onState);
  }
  if (!activeClient) {
    onState?.({ kind: "stale", error: "未连接" });
    return () => {};
  }
  return activeClient.subscribe(to, stream, params, onEvent, onState);
}

export async function applyAuthenticatedPairResponse(serverInput: string, res: PairResponse): Promise<void> {
  const server = normalizeServer(serverInput);
  if (!server) throw new RelayError("bad_request", "请填写服务器地址");
  await saveSession({
    server,
    token: res.token,
    deviceId: res.device.id,
    deviceName: res.device.name,
    lastServer: isMockServer(server) ? settingsStore.get().lastServer ?? undefined : server,
  });
  updateSettings({
    server,
    deviceId: res.device.id,
    deviceName: res.device.name,
    ...(isMockServer(server) ? {} : { lastServer: server }),
  });
  startRelayLink(server, res.token);
}

export async function requestWebJoinTicket(serverInput: string, customName?: string): Promise<JoinTicket> {
  const server = normalizeServer(serverInput);
  if (!server) throw new RelayError("bad_request", "请先填写服务器地址");
  if (isMockServer(server)) throw new RelayError("unsupported", "演示模式不支持扫码加入申请");
  const name = customName?.trim() || defaultDeviceName();
  const prevServer = settingsStore.get().server;
  const prevToken = prevServer === server ? currentToken ?? undefined : undefined;
  const identity = await createIdentityProof();
  return restRequest<JoinTicket>(server, "/v1/join", {
    method: "POST",
    token: prevToken,
    body: JSON.stringify({
      name,
      kind: "viewer",
      platform: detectPlatform(),
      ...(identity ? { identity } : {}),
    }),
  });
}

export async function claimWebJoinTicket(serverInput: string, id: string, secret: string): Promise<JoinClaim> {
  const server = normalizeServer(serverInput);
  if (!server) throw new RelayError("bad_request", "请先填写服务器地址");
  return restRequest<JoinClaim>(server, `/v1/join/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    body: JSON.stringify({ secret }),
  });
}

export async function completePairing(serverInput: string, code: string, customName?: string, via: PairVia = "typed"): Promise<void> {
  const server = normalizeServer(serverInput);
  if (!server) throw new RelayError("bad_request", "请填写服务器地址");
  if (!isMockServer(server) && !code.trim()) throw new RelayError("bad_request", "请填写配对码");
  const name = customName?.trim() || defaultDeviceName();
  const prevServer = settingsStore.get().server;
  const prevToken = prevServer === server ? currentToken ?? undefined : undefined;
  // Never the code or the token in the log: only how the code arrived.
  logger.info("pair", `pairing "${name}" with ${server} via ${via}`);
  const res = await pairDevice(server, code || "DEMO-0000", name, detectPlatform(), prevToken, via).catch((err: Error) => {
    logger.warn("pair", `pairing via ${via} failed: ${err.message}`);
    throw err;
  });
  logger.info("pair", `paired as ${res.device.id}`);
  await applyAuthenticatedPairResponse(server, res);
}

/**
 * Pairs this app through the computer's own herdr-pocket login: the daemon's device token
 * asks its relay for a one-time viewer code, which then pairs this app like a typed code.
 */
export async function pairWithLocalHost(customName?: string): Promise<void> {
  // The native side makes the code with the daemon's token; the token never comes here.
  const local = await getLocalPairCode().catch((err: LocalPairError) => {
    throw new RelayError(err.code === "unauthorized" || err.code === "offline" ? err.code : "internal", err.message);
  });
  const server = normalizeServer(local.server);
  logger.info("pair", `using this computer's herdr-pocket login for ${server}`);
  await completePairing(server, local.code, customName, "local-login");
}

/** pairWithLocalHost with a deadline, for the unattended first-launch attempt. */
export async function pairWithLocalHostWithin(ms: number, customName?: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RelayError("timeout", `${Math.round(ms / 1000)} 秒内没连上本机登录的服务器：检查网络后重试，或在下面手动连接`)), ms);
  });
  try {
    await Promise.race([pairWithLocalHost(customName), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function signOut(): Promise<void> {
  logger.info("pair", "signing out");
  const server = settingsStore.get().server;
  const deviceId = settingsStore.get().deviceId;
  const token = currentToken;
  stopRelayLink();
  if (server && !isMockServer(server) && token && deviceId) {
    void revokeDevice(server, token, deviceId).catch(() => {});
  }
  await clearSession();
  updateSettings({ server: null, deviceId: null, hostFilter: null });
}
