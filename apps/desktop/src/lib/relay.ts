import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type Device,
  type DeviceKind,
  type JoinRequest,
  type PairCode,
  type PairResponse,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerFrame,
} from "@herdr-pocket/protocol";
import { liveStore, settingsStore, updateSettings } from "./store";
import { clearSession, defaultDeviceName, detectPlatform, pushSystemNotification, saveSession } from "./bridge";
import { isMockServer, mockApi } from "./mock";
import { loadAssistant, onAssistantFrame } from "./assistant";

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
      ...init,
      signal: abort.signal,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new RelayError("offline", `连不上 ${server.replace(/^https?:\/\//i, "")}，请检查服务器地址与网络`);
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: RpcError } & T;
  if (!res.ok) {
    const err = body.error;
    throw new RelayError(err?.code ?? (res.status === 401 ? "unauthorized" : "internal"), err?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

export async function pairDevice(
  server: string,
  code: string,
  name: string,
  platform: string,
  previousToken?: string,
): Promise<PairResponse> {
  if (isMockServer(server)) return mockApi.pair(code, name, platform);
  return restRequest<PairResponse>(server, "/v1/pair", {
    method: "POST",
    token: previousToken,
    body: JSON.stringify({ code: code.trim().toUpperCase(), name, kind: "viewer", platform }),
  });
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

type StreamCb = (ev: any) => void;
interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface Sub {
  id: string;
  to: string;
  stream: "terminal" | "session";
  params: unknown;
  onEvent: StreamCb;
  onState?: StreamCb;
}

class SocketClient {
  private ws: WebSocket | null = null;
  private notifyWs: WebSocket | null = null;
  private pending = new Map<string, PendingRpc>();
  private subs = new Map<string, Sub>();
  private seq = 0;
  private backoff = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private welcomed = false;
  private seenNoticeIds = new Set<string>();

  constructor(private server: string, readonly token: string) {
    this.open();
    this.openNotify();
    this.pingTimer = setInterval(() => this.ping(), 20_000);
  }

  private send(frame: ClientFrame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private open(): void {
    if (this.closed) return;
    liveStore.set({ link: "connecting" });
    this.welcomed = false;
    const ws = new WebSocket(wsUrlFor(this.server, "/v1/ws", this.token));
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = 1000;
      this.send({ type: "hello", version: PROTOCOL_VERSION, platform: detectPlatform() });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      try {
        this.onFrame(JSON.parse(ev.data) as ServerFrame);
      } catch {
        // ignore invalid json
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPong();
      for (const s of this.subs.values()) s.onState?.({ kind: "stale", error: "连接断开" });
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new RelayError("offline", "连接断开"));
      }
      this.pending.clear();
      if (this.closed) return;
      if (ev.code === 4001) {
        liveStore.set({ link: "unauthorized" });
        return;
      }
      if (!this.welcomed) {
        void tokenStillValid(this.server, this.token).then((ok) => {
          if (!ok && !this.closed) {
            liveStore.set({ link: "unauthorized" });
            this.closed = true;
          }
        });
      }
      liveStore.set({ link: "offline" });
      this.retryTimer = setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    };
  }

  private openNotify(): void {
    if (this.closed || !settingsStore.get().notifications) return;
    const ws = new WebSocket(wsUrlFor(this.server, `/v1/notify?since=${Date.now()}`, this.token));
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
            void pushSystemNotification(msg.notice.title, msg.notice.body);
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
        liveStore.set({ link: "online" });
        void loadAssistant();
        for (const s of this.subs.values()) {
          this.send({ type: "stream_subscribe", id: s.id, to: s.to, stream: s.stream, params: s.params });
        }
        break;
      case "snapshot": {
        const devices: Record<string, Device> = {};
        for (const d of f.devices) devices[d.id] = d;
        const agents: Record<string, import("@herdr-pocket/protocol").Agent[]> = {};
        for (const a of f.agents) (agents[a.deviceId] ??= []).push(a);
        liveStore.set({ devices, agents, rev: liveStore.get().rev + 1 });
        break;
      }
      case "device":
        liveStore.set((prev) => ({
          ...prev,
          devices: { ...prev.devices, [f.device.id]: f.device },
          rev: prev.rev + 1,
        }));
        break;
      case "device_removed":
        liveStore.set((prev) => {
          const devices = { ...prev.devices };
          delete devices[f.id];
          const agents = { ...prev.agents };
          delete agents[f.id];
          return { ...prev, devices, agents, rev: prev.rev + 1 };
        });
        break;
      case "agents":
        liveStore.set((prev) => ({
          ...prev,
          agents: { ...prev.agents, [f.deviceId]: f.agents },
          rev: prev.rev + 1,
        }));
        break;
      case "rpc_result": {
        const p = this.pending.get(f.id);
        if (!p) break;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.error) p.reject(new RelayError(f.error.code, f.error.message));
        else p.resolve(f.result);
        break;
      }
      case "stream_open": {
        const s = this.subs.get(f.id);
        if (!s) break;
        if (f.error) s.onState?.({ kind: "error", error: f.error.message });
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
        if (f.error.code === "unauthorized") liveStore.set({ link: "unauthorized" });
        break;
      default:
        onAssistantFrame(f);
    }
  }

  private ping(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "ping", t: Date.now() });
    if (!this.pongTimer) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.ws?.close(4000, "pong timeout");
      }, 6000);
    }
  }

  private clearPong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  call(to: string, method: RpcMethod, params: unknown, timeoutMs = 15_000): Promise<unknown> {
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

  subscribe(to: string, stream: "terminal" | "session", params: unknown, onEvent: StreamCb, onState?: StreamCb): () => void {
    const id = `s${++this.seq}`;
    const sub: Sub = { id, to, stream, params, onEvent, onState };
    this.subs.set(id, sub);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "stream_subscribe", id, to, stream, params });
    }
    return () => {
      this.subs.delete(id);
      if (this.ws?.readyState === WebSocket.OPEN) {
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

  close(): void {
    this.closed = true;
    this.clearPong();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
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
    mockApi.connect();
    return;
  }
  activeClient = new SocketClient(server, token);
}

export function stopRelayLink(): void {
  activeClient?.close();
  activeClient = null;
  currentToken = null;
  liveStore.set({ link: "idle", devices: {}, agents: {}, rev: liveStore.get().rev + 1 });
}

export function refreshNotifyChannel(): void {
  activeClient?.refreshNotify();
}

export function pingRelay(): void {
  const s = settingsStore.get();
  if (s.server && isMockServer(s.server)) {
    mockApi.connect();
  } else if (activeClient) {
    // Re-open if offline
    if (liveStore.get().link === "offline" && s.server && currentToken) {
      startRelayLink(s.server, currentToken);
    }
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

export function subscribeStream(
  to: string,
  stream: "terminal" | "session",
  params: unknown,
  onEvent: StreamCb,
  onState?: StreamCb,
): () => void {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    onState?.({ kind: "live" });
    return () => {};
  }
  if (!activeClient) {
    onState?.({ kind: "stale", error: "未连接" });
    return () => {};
  }
  return activeClient.subscribe(to, stream, params, onEvent, onState);
}

export async function completePairing(serverInput: string, code: string, customName?: string): Promise<void> {
  const server = normalizeServer(serverInput);
  if (!server) throw new RelayError("bad_request", "请填写服务器地址");
  if (!isMockServer(server) && !code.trim()) throw new RelayError("bad_request", "请填写配对码");
  const name = customName?.trim() || defaultDeviceName();
  const prevServer = settingsStore.get().server;
  const prevToken = prevServer === server ? currentToken ?? undefined : undefined;
  const res = await pairDevice(server, code || "DEMO-0000", name, detectPlatform(), prevToken);
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

export async function signOut(): Promise<void> {
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
