import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import QRCode from "qrcode";
import {
  PROTOCOL_VERSION,
  isJoinId,
  isPairCode,
  joinLink,
  pairLink,
  parsePairInput,
  voiceCatalogFor,
  type Agent,
  type ClientFrame,
  type Device,
  type DeviceKind,
  type JoinClaim,
  type JoinRequest,
  type JoinTicket,
  type PairCode,
  type PairResponse,
  type RpcError,
  type RpcMethod,
  type RpcParams,
  type RpcResult,
  type ServerFrame,
  type NotifyFrame,
  type AssistantConfirm,
  type AssistantConfigChange,
  type AssistantPluginId,
  type LogLevel,
  type PasskeyAssertionPayload,
  type VoiceProviderId,
  TRANSCRIBE_LIMITS,
  type TranscribeResult,
} from "@herdr-pocket/protocol";
import { VERSION } from "@herdr-pocket/update";
import { Store } from "./store.ts";
import { issueSetupCode, type SetupInfo } from "./setup.ts";
import { joinLanding, notFoundLanding, pairLanding, type LandingPage } from "./landing.ts";
import { Assistant, type AssistantOptions } from "./assistant/assistant.ts";
import { listModels, makeLlm, testModel, type Llm, type LlmTarget } from "./assistant/llm.ts";
import { ConfigError, ConfigStore, Sealer, type EffectiveConfig } from "./assistant/configstore.ts";
import { isPromptId, promptView, promptViews, setPromptEdits } from "./assistant/prompts.ts";
import { startCall, endAllCalls, type LiveConfig } from "./assistant/live.ts";
import { EventLog, levelsFrom, parseSince, type EventInput } from "./eventlog.ts";
import { adminPage, adminAsset } from "./admin.ts";
import { webAsset, webPage } from "./web/index.ts";
import {
  ChallengeStore,
  formatAnchorCookieHeader,
  parseAnchorCookies,
  signAnchorToken,
  verifyAnchorToken,
  verifyDeviceIdentityProof,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
  verifyReconfirmEcdsa,
} from "./identity.ts";
import { TranscribeError, TranscribeLimiter, audioType, resolveTranscribe, transcribe, transcribeInfo, wavDurationMs, type TranscribeSettings, type TranscribeTarget } from "./transcribe.ts";
import { ReleaseCache } from "./releases.ts";

const WEB_APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https: http:; media-src 'self' blob: data:; connect-src *; frame-src 'self' blob: data:; manifest-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'";

export interface RelayOptions {
  dbPath: string;
  /** Admin token: may mint pair codes. Required to bootstrap the first device. */
  adminToken?: string;
  /** Public base URL put into pairing links, e.g. https://pocket.example.com */
  publicUrl?: string;
  /** Trust X-Forwarded-For (set when behind Caddy/nginx). */
  trustProxy?: boolean;
  rpcTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Text assistant: models tried in order, each at its provider (see src/config.ts). Phones can change it (configstore.ts). */
  assistant?: { targets: LlmTarget[]; name?: string; firstByteMs?: number };
  /** Injected model for tests; wins over `assistant`. */
  llm?: Llm;
  /** Live voice (MOSS-Live or an OpenAI Realtime service); off when unset. Phones can change it. */
  live?: LiveConfig;
  /** Timing overrides for tests. */
  assistantTiming?: Omit<AssistantOptions, "store" | "host" | "llm" | "model" | "name" | "voice" | "confirm">;
  /** Whether the assistant asks before acting until the app changes it (POCKET_ASSISTANT_CONFIRM). Default `never`. */
  assistantConfirm?: AssistantConfirm;
  /** Dictation (POST /v1/transcribe): POCKET_TRANSCRIBE_* settings; otherwise the voice or text providers' (src/transcribe.ts). */
  transcribe?: TranscribeSettings;
  /** Per-device dictation limits (tests lower them). */
  transcribeLimits?: { perMinute?: number; concurrent?: number };
  /** Directory and upstream override for the built-in release cache (`:memory:` tests isolate automatically). */
  releaseCacheDir?: string;
  releaseUpstreamBases?: string[];
  releasePollIntervalMs?: number;
}

interface Conn {
  ws: WebSocket;
  device: Device;
  alive: boolean;
}

interface Pending {
  /** A device's call, answered over its socket; or the relay's own (assistant) call. */
  caller: Conn | { resolve: (v: unknown) => void; reject: (e: Error) => void };
  callerId: string;
  target: string;
  timer: NodeJS.Timeout;
  /** For the log. */
  method: string;
  from: string;
  params: unknown;
  t0: number;
}

/** Calls that change something on a computer: logged even when they work. Typing keystrokes and "seen" marks are not. */
const MUTATING = new Set(["terminal.send", "terminal.keys", "agent.create", "agent.setModel", "space.delete", "terminal.interrupt", "terminal.kill", "herdr.command", "herdr.doc.set", "sessions.resume", "tools.update"]);
/** Calls that may run longer than the usual RPC timeout: a new agent's first task is typed in once its program is up (hostd waits up to 45 s). */
const SLOW_RPC_MS: Partial<Record<string, number>> = {
  "agent.create": 100_000,
  "agent.btw": 65_000,
  "tools.update": 180_000,
  "terminal.putBegin": 60_000,
  "terminal.putChunk": 60_000,
  "terminal.putFinish": 60_000,
};
/** Bodies of log uploads are larger than other requests. */
const MAX_LOG_BODY = 2 * 1024 * 1024;
const STARTED = Date.now();

export class HostCallError extends Error {
  code: RpcError["code"];
  constructor(error: RpcError) {
    super(error.message);
    this.code = error.code;
  }
}

/** A device that asked to join and waits for a paired device to approve it. */
interface Join {
  req: JoinRequest;
  secret: string;
  ip: string;
  /** Device this request replaces when approved (the asker's previous registration). */
  replaces?: string;
  identity?: { identityPubKey: string; fingerprintHash?: string };
  anchorDeviceId?: string;
  state: "pending" | "denied" | "approved";
  /** Held only until the asking device collects it. */
  granted?: PairResponse;
}

interface StreamPending {
  caller: Conn;
  callerId: string;
  target: string;
}

const MAX_BODY = 64 * 1024;
const MAX_AGENTS = 2000;
const MAX_VIEWER_CONNS_PER_DEVICE = 8;
const PAIR_FAIL_LIMIT = 10;
const PAIR_FAIL_WINDOW_MS = 10 * 60 * 1000;
const JOIN_TTL_MS = 5 * 60 * 1000;
const JOIN_MAX = 200;
const JOIN_MAX_PER_IP = 5;

export class Relay {
  readonly store: Store;
  readonly http: Server;
  private wss: WebSocketServer;
  private hostConns = new Map<string, Conn>();
  private viewerConns = new Map<string, Set<Conn>>();
  private agents = new Map<string, Agent[]>();
  private pending = new Map<string, Pending>();
  private streams = new Map<string, StreamPending>();
  private callerStreams = new Map<Conn, Map<string, string>>();
  private streamSeq = 0;
  private seq = 0;
  private pairFails = new Map<string, { n: number; since: number }>();
  private joins = new Map<string, Join>();
  private challenges = new ChallengeStore();
  private heartbeat: NodeJS.Timeout;
  /** Every line also becomes an event (see eventlog.ts); `journal` is the raw output. */
  private log: (msg: string) => void;
  readonly events: EventLog;
  private notifyWss: WebSocketServer;
  private notifySubs = new Set<{ ws: WebSocket; alive: boolean }>();
  readonly assistant: Assistant;
  /** Models, keys, voice and prompt edits as phones set them, over the server's own settings. */
  readonly config: ConfigStore;
  /** What is in force now. */
  private eff: EffectiveConfig;
  private dictation: TranscribeLimiter;
  private releases: ReleaseCache;

  private opts: RelayOptions;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.dictation = new TranscribeLimiter(opts.transcribeLimits?.perMinute, opts.transcribeLimits?.concurrent);
    this.store = new Store(opts.dbPath);
    const journal = opts.log ?? ((m: string) => console.log(`[relay] ${m}`));
    this.events = new EventLog(this.store, { journal, deviceName: (id) => (id === "relay" ? "relay" : this.store.getDevice(id)?.name) });
    // Plain lines ("paired ...", "live: ...") are events too: kind from their prefix, trouble from their words.
    this.log = (m) => this.events.record(plainEvent(m));
    this.releases = new ReleaseCache({
      dbPath: opts.dbPath,
      cacheDir: opts.releaseCacheDir,
      upstreamBases: opts.releaseUpstreamBases,
      serverVersion: VERSION,
      pollIntervalMs: opts.releasePollIntervalMs,
      onNewRelease: (version) => this.broadcast({ type: "release_update", version, ts: Date.now() }),
      log: this.log,
    });
    this.http = createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.log(`http error: ${err instanceof Error ? err.stack : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "internal error" } });
      });
    });
    // Screens and conversations are text that shrinks several times over; hosts usually sit behind a slow uplink.
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 32 * 1024 * 1024,
      perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 4 }, concurrencyLimit: 16 },
    });
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.notifyWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.heartbeat = setInterval(() => this.sweep(), 30_000);
    // Keys and prompt edits are sealed with a key in a file of its own next to the database.
    const memory = opts.dbPath === ":memory:" || opts.dbPath.startsWith("file::memory:");
    this.config = new ConfigStore(this.store, new Sealer(memory ? null : `${opts.dbPath}.key`), {
      targets: opts.assistant?.targets ?? [],
      name: opts.assistant?.name,
      firstByteMs: opts.assistant?.firstByteMs,
      live: opts.live,
    });
    setPromptEdits(this.config.promptEdits());
    this.eff = this.config.effective();
    if (this.eff.view.edited) for (const w of this.eff.view.warnings) this.log(`config: ${w}`);
    this.assistant = new Assistant({
      store: this.store,
      llm: this.buildLlm(),
      model: opts.llm ? "test" : (this.eff.targets[0]?.model ?? this.eff.fallbackTargets?.[0]?.model),
      name: this.eff.name,
      voice: !!this.eff.live?.apiKey,
      confirm: opts.assistantConfirm,
      ...opts.assistantTiming,
      host: {
        devices: () => this.devices(),
        agents: () => this.allAgents(),
        call: (to, method, params, timeoutMs) => this.callHost(to, method, params, timeoutMs),
        toViewers: (frame) => this.toViewers(frame),
        log: this.log,
        event: (e) => this.events.record(e),
        logs: (q) => this.events.query(q),
      },
    });
    this.assistant.onNotice((notice) => {
      const data = JSON.stringify({ type: "notice", notice } satisfies NotifyFrame);
      for (const s of this.notifySubs) if (s.ws.readyState === WebSocket.OPEN) s.ws.send(data);
    });
  }

  /** The model client for what is in force (tests inject their own). */
  private buildLlm(): Llm | undefined {
    if (this.opts.llm) return this.opts.llm;
    const e = this.eff;
    const targets = [...e.targets, ...(e.fallbackTargets ?? [])];
    return targets.length
      ? makeLlm({ targets, firstByteMs: e.firstByteMs, log: (m) => this.events.record({ kind: "model", level: /fail|error|refus/i.test(m) ? "warn" : "info", msg: m }) })
      : undefined;
  }

  /** A phone changed the configuration or a prompt: the next message or call uses it, and the other phones are told. */
  private reconfigure(what: "config" | "prompts", by: string, change: string): void {
    if (what === "prompts") setPromptEdits(this.config.promptEdits());
    this.eff = this.config.effective();
    this.assistant.useModels({
      llm: this.buildLlm(),
      model: this.opts.llm ? "test" : (this.eff.targets[0]?.model ?? this.eff.fallbackTargets?.[0]?.model),
      name: this.eff.name,
      voice: !!this.eff.live?.apiKey,
    });
    this.events.record({ kind: "config", level: "info", msg: `${by}: ${change}` });
    this.toViewers({ type: "assistant_config", rev: this.eff.view.rev, by, what });
  }

  /**
   * First run: while no device is registered, a one-time setup code lets the first phone or
   * computer in without the admin token. Null once the relay has devices.
   */
  setupCode(fresh = false): SetupInfo | null {
    return issueSetupCode(this.store, this.opts.publicUrl, fresh);
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(port, host, () => {
        const addr = this.http.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  private closing = false;

  async close(): Promise<void> {
    // Sockets report their close after the store is gone; they have nothing left to record.
    this.closing = true;
    clearInterval(this.heartbeat);
    this.assistant.close();
    endAllCalls();
    for (const s of this.notifySubs) s.ws.terminate();
    this.notifySubs.clear();
    this.notifyWss.close();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.streams.clear();
    this.callerStreams.clear();
    for (const c of this.allConns()) c.ws.terminate();
    this.hostConns.clear();
    this.viewerConns.clear();
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
    this.releases.close();
    this.store.close();
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay");
    const rawPathname = url.pathname;
    const path = rawPathname.replace(/\/+$/, "") || "/";

    // H5 Web Client at /app/ and /h5/: trailing slash ensures relative ./assets/ resolves cleanly under subpaths like /pocket/app/.
    if ((req.method === "GET" || req.method === "HEAD") && (rawPathname === "/app" || rawPathname === "/h5")) {
      const target = `${this.publicUrl(req)}/app/${url.search}`;
      res.writeHead(302, { Location: target, "Cache-Control": "no-store" }).end();
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && (rawPathname === "/app/" || rawPathname === "/h5/")) {
      const html = webPage();
      if (!html) {
        sendError(res, 503, "unsupported", "网页版资源尚未构建");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": WEB_APP_CSP,
      });
      res.end(req.method === "HEAD" ? undefined : html);
      return;
    }

    const webMatch = /^\/(?:app|h5)\/(.+)$/.exec(rawPathname);
    if ((req.method === "GET" || req.method === "HEAD") && webMatch) {
      const rel = webMatch[1] === "favicon.ico" ? "assets/brand/favicon.ico" : webMatch[1]!;
      const asset = webAsset(rel);
      if (asset) {
        res.writeHead(200, {
          "Content-Type": asset.type,
          "Content-Length": asset.body.length,
          "Cache-Control": asset.noCache
            ? "no-cache"
            : asset.immutable
              ? "public, max-age=31536000, immutable"
              : "public, max-age=3600",
          ...(rel === "sw.js" ? { "Service-Worker-Allowed": "./" } : {}),
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : asset.body);
        return;
      }
      if (!rel.includes(".")) {
        const html = webPage();
        if (html) {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": WEB_APP_CSP,
          });
          res.end(req.method === "HEAD" ? undefined : html);
          return;
        }
      }
      sendError(res, 404, "not_found", "not found");
      return;
    }

    // QR landing pages: they echo the URL and never look the code or request up.
    const lm = /^\/(p|j)\/([^/]+)$/.exec(path);
    if (lm && (req.method === "GET" || req.method === "HEAD")) {
      const value = lm[2]!;
      const server = this.publicUrl(req);
      const code = lm[1] === "p" && isPairCode(value) ? parsePairInput(value)?.code : undefined;
      const landing = code ? pairLanding(server, code) : lm[1] === "j" && isJoinId(value) ? joinLanding(server, value) : null;
      sendPage(res, landing ? 200 : 404, landing ?? notFoundLanding(), req.method === "HEAD");
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && path === "/admin") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
      });
      res.end(req.method === "HEAD" ? undefined : adminPage());
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && (path === "/favicon.ico" || path === "/admin/favicon.ico")) {
      const ico = adminAsset("brand/favicon.ico");
      if (!ico) {
        sendError(res, 404, "not_found", "not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": ico.type,
        "Content-Length": ico.body.length,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : ico.body);
      return;
    }

    const assetMatch = /^\/(?:admin\/)?admin-assets\/(.+)$/.exec(path);
    if ((req.method === "GET" || req.method === "HEAD") && assetMatch) {
      const asset = adminAsset(assetMatch[1]!);
      if (!asset) {
        sendError(res, 404, "not_found", "not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": asset.type,
        "Content-Length": asset.body.length,
        "Cache-Control": asset.immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : asset.body);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && path === "/v1/releases/latest") {
      await this.releases.handleLatest(req, res, VERSION);
      return;
    }

    const releaseMatch = /^\/v1\/releases\/download\/([^/]+)\/([^/]+)$/.exec(path);
    if ((req.method === "GET" || req.method === "HEAD") && releaseMatch) {
      let tag = releaseMatch[1]!;
      let asset = releaseMatch[2]!;
      try {
        tag = decodeURIComponent(tag);
        asset = decodeURIComponent(asset);
      } catch {
        sendError(res, 400, "bad_request", "无效的下载地址");
        return;
      }
      await this.releases.handleDownload(req, res, tag, asset);
      return;
    }

    if (req.method === "GET" && (path === "/v1/health" || path === "/")) {
      sendJson(res, 200, {
        ok: true,
        name: "herdr-pocket-relay",
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        devices: this.store.listDevices().length,
        online: this.onlineDeviceCount(),
        // Which services are configured (names only, never keys or addresses).
        assistant: [...new Set(this.eff.targets.map((t) => t.provider))],
        voice: this.eff.live ? (this.eff.live.provider ?? "moss-live") : null,
      });
      return;
    }

    if (req.method === "GET" && path === "/v1/identity/hint") {
      const anchored = this.resolveAnchoredDevice(req);
      if (!anchored || anchored.kind !== "viewer") {
        sendJson(res, 200, { anchored: false });
        return;
      }
      sendJson(res, 200, {
        anchored: true,
        deviceId: anchored.id,
        deviceName: anchored.name,
        passkeyLinked: Boolean(anchored.passkeyLinked),
      });
      return;
    }

    if (req.method === "POST" && path === "/v1/identity/challenge") {
      const ip = this.clientIp(req);
      if (this.pairBlocked(ip)) {
        sendError(res, 429, "forbidden", "尝试太多次，请稍后再试");
        return;
      }
      const issued = this.challenges.issue(this.rpIdOf(req));
      sendJson(res, 200, issued);
      return;
    }

    if (req.method === "POST" && path === "/v1/identity/reconfirm") {
      const ip = this.clientIp(req);
      if (this.pairBlocked(ip)) {
        sendError(res, 429, "forbidden", "验证尝试太多次，请稍后再试");
        return;
      }
      const body = await readJson(req);
      const challenge = str(body?.challenge, 128);
      if (!challenge) {
        sendError(res, 400, "bad_request", "缺少验证 challenge");
        return;
      }
      const ch = this.challenges.consume(challenge);
      if (!ch) {
        this.pairFailed(ip);
        sendError(res, 401, "unauthorized", "验证已过期或无效，请重试");
        return;
      }
      const platform = str(body?.platform, 32);
      const customName = str(body?.name, 64)?.trim();
      const passkey = body?.passkey as PasskeyAssertionPayload | undefined;
      if (passkey && typeof passkey === "object" && typeof passkey.id === "string") {
        const rec = this.store.findPasskeyAuthRecord(passkey.id);
        if (!rec || rec.device.kind !== "viewer") {
          this.pairFailed(ip);
          sendError(res, 401, "unauthorized", "当前中转服务未绑定该通行密钥");
          return;
        }
        const check = verifyPasskeyAssertion({
          challenge,
          rpId: ch.rpId,
          publicKeySpki: rec.publicKeySpki,
          prevSignCount: rec.signCount,
          assertion: passkey,
        });
        if (!check.ok) {
          this.pairFailed(ip);
          sendError(res, 401, "unauthorized", "通行密钥签名校验失败");
          return;
        }
        this.store.setPasskeySignCount(rec.device.id, check.nextSignCount);
        const caller = this.authenticate(req, url);
        if (caller && caller !== "admin" && caller.kind === "viewer" && caller.id !== rec.device.id) {
          this.removeDevice(caller.id, "merged-into-passkey");
        }
        const rotated = this.store.rotateDeviceToken(rec.device.id, {
          name: customName,
          platform,
        });
        if (!rotated) {
          sendError(res, 404, "not_found", "设备记录已移除");
          return;
        }
        this.events.record({
          kind: "pair",
          level: "info",
          msg: `viewer "${rotated.device.name}" (${rotated.device.id}) reconfirmed identity via passkey`,
          device: rotated.device.id,
          data: { platform: platform ?? rotated.device.platform, method: "passkey" },
        });
        this.setAnchorCookie(req, res, rotated.device.id);
        this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(rotated.device) });
        sendJson(res, 200, { device: this.decorate(rotated.device), token: rotated.token } satisfies PairResponse);
        return;
      }

      const identityPubKey = str(body?.identityPubKey, 512);
      const signature = str(body?.signature, 512);
      if (!identityPubKey || !signature || !verifyReconfirmEcdsa(challenge, identityPubKey, signature)) {
        this.pairFailed(ip);
        sendError(res, 401, "unauthorized", "设备身份密钥校验失败，需要重新扫码连接");
        return;
      }
      const existing = this.store.findDeviceByIdentityPubKey(identityPubKey, "viewer");
      if (!existing) {
        sendError(res, 404, "not_found", "这台浏览器还没有在中转服务登记身份");
        return;
      }
      const rotated = this.store.rotateDeviceToken(existing.id, {
        name: customName,
        platform,
      });
      if (!rotated) {
        sendError(res, 404, "not_found", "设备记录已移除");
        return;
      }
      this.events.record({
        kind: "pair",
        level: "info",
        msg: `viewer "${rotated.device.name}" (${rotated.device.id}) reconfirmed identity via keypair`,
        device: rotated.device.id,
        data: { platform: platform ?? rotated.device.platform, method: "ecdsa" },
      });
      this.setAnchorCookie(req, res, rotated.device.id);
      this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(rotated.device) });
      sendJson(res, 200, { device: this.decorate(rotated.device), token: rotated.token } satisfies PairResponse);
      return;
    }

    if (req.method === "POST" && path === "/v1/pair") {
      const ip = this.clientIp(req);
      if (this.pairBlocked(ip)) {
        sendError(res, 429, "forbidden", "配对尝试太多次，请 10 分钟后再试");
        return;
      }
      const body = await readJson(req);
      const code = str(body?.code, 32);
      const name = str(body?.name, 64)?.trim();
      const kind = body?.kind === "host" || body?.kind === "viewer" ? (body.kind as DeviceKind) : null;
      const platform = str(body?.platform, 32);
      const via = str(body?.via, 24)?.replace(/[^a-z0-9-]/gi, "");
      const verifiedId = verifyDeviceIdentityProof(body?.identity);
      if (!code || !name || !kind) {
        sendError(res, 400, "bad_request", "需要 code、name 和 kind（host 或 viewer）");
        return;
      }
      const row = this.store.consumePairCode(code, kind);
      if (typeof row === "string") {
        this.pairFailed(ip);
        this.events.record({ kind: "pair", level: "warn", msg: `pairing ${kind} "${name}" refused: ${row}${via ? ` (via ${via})` : ""}`, data: { kind, platform, via, reason: row } });
        if (row === "wrong_kind") {
          sendError(
            res,
            400,
            "bad_request",
            kind === "viewer"
              ? "这个配对码是给电脑用的。给手机配对请在“添加设备”里选手机，或在电脑上运行 herdr-pocket pair"
              : "这个配对码是给手机用的。给电脑配对请运行 herdr-pocket pair --kind host，或在 App 的“添加设备”里选电脑",
          );
        } else if (row === "expired") sendError(res, 401, "unauthorized", "配对码已过期，换一个新的");
        else sendError(res, 401, "unauthorized", "配对码不对，或者已经用过了");
        return;
      }
      const previous = this.authenticate(req, url);
      const existingMatch = this.findReusableDeviceForPair({
        kind,
        previous,
        verifiedId,
        anchored: this.resolveAnchoredDevice(req),
      });
      let created: { device: Device; token: string };
      if (existingMatch && existingMatch.mode === "reuse") {
        created = this.store.rotateDeviceToken(existingMatch.device.id, {
          platform,
          identityPubKey: verifiedId?.identityPubKey,
          identityFp: verifiedId?.fingerprintHash,
        })!;
      } else {
        if (previous && previous !== "admin" && previous.kind === kind) {
          this.removeDevice(previous.id, "re-paired");
        }
        created = this.store.createDevice({
          name: this.store.uniqueName(name),
          kind,
          platform,
          identityPubKey: verifiedId?.identityPubKey,
          identityFp: verifiedId?.fingerprintHash,
        });
      }
      const { device, token } = created;
      const maker = row.createdBy === "admin" ? "admin" : row.createdBy ? (this.store.getDevice(row.createdBy)?.name ?? row.createdBy) : "setup code";
      this.log(`paired ${kind} "${device.name}" (${device.id})`);
      this.events.record({
        kind: "pair",
        level: "info",
        msg: `${kind} "${device.name}" paired with a code from ${maker}${via ? ` via ${via}` : ""}${existingMatch?.mode === "reuse" ? ", reusing anchored identity" : previous && previous !== "admin" && previous.kind === kind ? ", replacing its old entry" : ""}`,
        device: device.id,
        data: { kind, platform, via, codeFrom: row.createdBy ?? "setup", reused: existingMatch?.mode === "reuse" ? device.id : undefined },
      });
      if (kind === "viewer") this.setAnchorCookie(req, res, device.id);
      this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(device) });
      const out: PairResponse = { device: this.decorate(device), token };
      sendJson(res, 200, out);
      return;
    }

    if (req.method === "POST" && path === "/v1/join") {
      const ip = this.clientIp(req);
      this.sweepJoins();
      const mine = [...this.joins.values()].filter((j) => j.ip === ip && j.state === "pending").length;
      if (this.joins.size >= JOIN_MAX || mine >= JOIN_MAX_PER_IP) {
        sendError(res, 429, "forbidden", "等待确认的加入请求太多了，过几分钟再试");
        return;
      }
      const body = await readJson(req);
      const name = str(body?.name, 64)?.trim();
      const kind = body?.kind === "host" || body?.kind === "viewer" ? (body.kind as DeviceKind) : null;
      if (!name || !kind) {
        sendError(res, 400, "bad_request", "需要 name 和 kind（host 或 viewer）");
        return;
      }
      const previous = this.authenticate(req, url);
      const verifiedId = verifyDeviceIdentityProof(body?.identity);
      const anchored = kind === "viewer" ? this.resolveAnchoredDevice(req) : null;
      const join: Join = {
        req: { id: randomBytes(12).toString("base64url"), name, kind, platform: str(body?.platform, 32), expiresAt: Date.now() + JOIN_TTL_MS },
        secret: randomBytes(24).toString("base64url"),
        ip,
        replaces: previous && previous !== "admin" && previous.kind === kind ? previous.id : undefined,
        ...(verifiedId ? { identity: verifiedId } : {}),
        ...(anchored && anchored.kind === kind ? { anchorDeviceId: anchored.id } : {}),
        state: "pending",
      };
      this.joins.set(join.req.id, join);
      const out: JoinTicket = { ...join.req, secret: join.secret, link: joinLink(this.publicUrl(req), join.req.id) };
      sendJson(res, 200, out);
      return;
    }

    const jm = /^\/v1\/join\/([A-Za-z0-9_-]{8,32})(?:\/(claim|approve|deny))?$/.exec(path);
    if (jm && req.method === "POST" && jm[2] === "claim") {
      this.sweepJoins();
      const join = this.joins.get(jm[1]!);
      const secret = str((await readJson(req))?.secret, 64);
      if (!join || !secret || !safeEqual(secret, join.secret)) {
        sendError(res, 404, "not_found", "这个加入请求已经过期，重新发起一次");
        return;
      }
      let out: JoinClaim = { status: "pending" };
      if (join.state === "denied") out = { status: "denied" };
      else if (join.state === "approved" && join.granted) {
        out = { status: "approved", ...join.granted };
        if (join.granted.device.kind === "viewer") this.setAnchorCookie(req, res, join.granted.device.id);
      }
      // Answered requests are handed over exactly once.
      if (join.state !== "pending") this.joins.delete(join.req.id);
      sendJson(res, 200, out);
      return;
    }

    // Everything below needs a device token (or the admin token where noted).
    const auth = this.authenticate(req, url);

    if (req.method === "POST" && path === "/v1/identity/passkey/options") {
      if (!auth || auth === "admin" || auth.kind !== "viewer") {
        sendError(res, 401, "unauthorized", "需要浏览器/手机端设备令牌");
        return;
      }
      const issued = this.challenges.issue(this.rpIdOf(req));
      sendJson(res, 200, {
        challenge: issued.challenge,
        expiresAt: issued.expiresAt,
        rp: { id: issued.rpId, name: "Herdr Pocket" },
        user: { id: auth.id, name: auth.name, displayName: auth.name },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          residentKey: "preferred",
          requireResidentKey: false,
          userVerification: "preferred",
        },
      });
      return;
    }

    if (req.method === "POST" && path === "/v1/identity/passkey/register") {
      if (!auth || auth === "admin" || auth.kind !== "viewer") {
        sendError(res, 401, "unauthorized", "需要浏览器/手机端设备令牌");
        return;
      }
      const body = await readJson(req);
      const challenge = str(body?.challenge, 128);
      const credId = str(body?.credId, 512);
      const publicKeySpki = str(body?.publicKeySpki, 512);
      const clientDataJSON = str(body?.clientDataJSON, 2048);
      if (!challenge || !credId || !publicKeySpki || !clientDataJSON) {
        sendError(res, 400, "bad_request", "缺少通行密钥注册参数");
        return;
      }
      const ch = this.challenges.consume(challenge);
      if (!ch) {
        sendError(res, 401, "unauthorized", "注册超时或 challenge 无效，请重试");
        return;
      }
      const verified = verifyPasskeyRegistration({ challenge, rpId: ch.rpId, credId, publicKeySpki, clientDataJSON });
      if (!verified) {
        sendError(res, 400, "bad_request", "通行密钥公钥或来源验证失败");
        return;
      }
      const updated = this.store.setDevicePasskey(auth.id, verified.credId, verified.publicKeySpki);
      if (!updated) {
        sendError(res, 404, "not_found", "设备记录不存在");
        return;
      }
      this.events.record({
        kind: "pair",
        level: "info",
        msg: `viewer "${updated.name}" (${updated.id}) linked a hardware passkey`,
        device: updated.id,
      });
      this.setAnchorCookie(req, res, updated.id);
      this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(updated) });
      sendJson(res, 200, { device: this.decorate(updated) });
      return;
    }

    if (jm && (req.method === "GET" ? !jm[2] : jm[2] === "approve" || jm[2] === "deny")) {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌");
        return;
      }
      this.sweepJoins();
      const join = this.joins.get(jm[1]!);
      if (!join || join.state !== "pending") {
        sendError(res, 404, "not_found", "这个加入请求已经过期或处理过了，让对方重新显示二维码");
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, join.req);
        return;
      }
      const by = auth === "admin" ? "admin" : auth.id;
      if (jm[2] === "deny") {
        join.state = "denied";
        this.log(`join denied "${join.req.name}" by ${by}`);
        sendJson(res, 200, { ok: true });
        return;
      }
      let grantedPair: { device: Device; token: string } | null = null;
      if (!join.replaces) {
        const match = this.findReusableDeviceForPair({
          kind: join.req.kind,
          previous: null,
          verifiedId: join.identity ?? null,
          anchored: join.anchorDeviceId ? this.store.getDevice(join.anchorDeviceId) : null,
        });
        if (match?.mode === "reuse") {
          grantedPair = this.store.rotateDeviceToken(match.device.id, {
            platform: join.req.platform,
            identityPubKey: join.identity?.identityPubKey,
            identityFp: join.identity?.fingerprintHash,
          });
        }
      }
      if (!grantedPair) {
        if (join.replaces) this.removeDevice(join.replaces, "re-paired");
        grantedPair = this.store.createDevice({
          name: this.store.uniqueName(join.req.name),
          kind: join.req.kind,
          platform: join.req.platform,
          identityPubKey: join.identity?.identityPubKey,
          identityFp: join.identity?.fingerprintHash,
        });
      }
      const { device, token } = grantedPair;
      join.state = "approved";
      join.granted = { device: this.decorate(device), token };
      this.log(`joined ${device.kind} "${device.name}" (${device.id}), approved by ${by}`);
      this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(device) });
      sendJson(res, 200, { device: this.decorate(device) });
      return;
    }

    if (req.method === "POST" && path === "/v1/pair/codes") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌或管理员令牌");
        return;
      }
      const body = (await readJson(req)) ?? {};
      const kind = body.kind === "host" || body.kind === "viewer" ? (body.kind as DeviceKind) : undefined;
      const ttlSec = typeof body.ttlSec === "number" ? body.ttlSec : undefined;
      const row = this.store.createPairCode({ kind, ttlSec, createdBy: auth === "admin" ? "admin" : auth.id });
      this.events.record({
        kind: "pair",
        level: "info",
        msg: `pair code for ${kind ?? "any device"} made by ${auth === "admin" ? "admin" : `${auth.kind} "${auth.name}"`}, valid ${Math.round((row.expiresAt - Date.now()) / 1000)} s`,
        ...(auth === "admin" ? {} : { device: auth.id }),
        data: { kind: kind ?? "any", ttlSec: Math.round((row.expiresAt - Date.now()) / 1000) },
      });
      const link = pairLink(this.publicUrl(req), row.code);
      const qrSvg = await QRCode.toString(link, { type: "svg", margin: 1 }).catch(() => undefined);
      const out: PairCode & { qrSvg?: string } = { code: row.code, expiresAt: row.expiresAt, link, ...(qrSvg ? { qrSvg } : {}) };
      sendJson(res, 200, out);
      return;
    }

    if (req.method === "GET" && path === "/v1/devices") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌");
        return;
      }
      sendJson(res, 200, { devices: this.devices() });
      return;
    }

    const m = /^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (m && req.method === "DELETE") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌");
        return;
      }
      const id = m[1]!;
      if (!this.removeDevice(id, `revoked by ${auth === "admin" ? "admin" : auth.id}`)) {
        sendError(res, 404, "not_found", "没有这个设备");
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (path === "/v1/logs") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要设备令牌或管理员令牌");
        return;
      }
      if (req.method === "POST") {
        if (auth === "admin") {
          sendError(res, 400, "bad_request", "日志要由设备自己上传");
          return;
        }
        const body = await readJson(req, MAX_LOG_BODY);
        if (!body || !Array.isArray(body.entries)) {
          sendError(res, 400, "bad_request", "需要 entries 数组（太大也会被拒，每批最多 200 条）");
          return;
        }
        sendJson(res, 200, { stored: this.events.ingest(auth, body.entries) });
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { entries: this.events.query(this.logQuery(url.searchParams)) });
        return;
      }
    }

    if (path === "/v1/transcribe" && (req.method === "GET" || req.method === "POST")) {
      // Dictation is for the person's own apps (phones, the desktop app), like the assistant.
      if (!auth || auth === "admin" || auth.kind !== "viewer") {
        sendError(res, 401, "unauthorized", "需要手机或桌面应用的设备令牌");
        return;
      }
      const target = resolveTranscribe(this.opts.transcribe ?? {}, this.eff.targets, this.eff.live);
      if (req.method === "GET") sendJson(res, 200, transcribeInfo(target));
      else await this.handleTranscribe(req, res, url, auth, target);
      return;
    }

    if (req.method === "GET" && path === "/v1/admin/overview") {
      if (auth !== "admin") {
        sendError(res, 401, "unauthorized", "需要管理员令牌");
        return;
      }
      sendJson(res, 200, this.overview());
      return;
    }

    if (path === "/v1/voiceprint") {
      if (!auth) {
        sendError(res, 401, "unauthorized", "需要有效的设备令牌");
        return;
      }
      if (req.method === "GET") {
        const saved = this.store.getSetting<Record<string, unknown> | null>("voiceprint") ?? null;
        sendJson(res, 200, {
          voiceprint: saved?.voiceprint ?? null,
          ...(typeof saved?.sampleBase64 === "string" ? { sampleBase64: saved.sampleBase64 } : {}),
          ...(typeof saved?.updatedAt === "number" ? { updatedAt: saved.updatedAt } : {}),
        });
        return;
      }
      if (req.method === "PUT") {
        const buf = await readBody(req, 512 * 1024);
        if (!buf) {
          sendError(res, 413, "bad_request", "声纹数据超出大小限制");
          return;
        }
        let body: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(buf.toString("utf8"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          body = null;
        }
        const vp = body?.voiceprint as Record<string, unknown> | undefined;
        if (!vp || !Array.isArray(vp.embedding) || vp.embedding.length < 64) {
          sendError(res, 400, "bad_request", "声纹特征格式无效");
          return;
        }
        this.store.putSetting("voiceprint", {
          voiceprint: vp,
          ...(typeof body?.sampleBase64 === "string" ? { sampleBase64: body.sampleBase64 } : {}),
          updatedAt: Date.now(),
        });
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "DELETE") {
        this.store.putSetting("voiceprint", null);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendError(res, 405, "bad_request", "method not allowed");
      return;
    }

    if (path === "/v1/assistant" || path.startsWith("/v1/assistant/")) {
      // The assistant belongs to the person: phones (and the admin), not computers.
      if (!auth || (auth !== "admin" && auth.kind !== "viewer")) {
        sendError(res, 401, "unauthorized", "需要手机的设备令牌");
        return;
      }
      await this.handleAssistant(req, res, path, auth);
      return;
    }

    sendError(res, 404, "not_found", "not found");
  }

  /** Settings -> 模型 / 语音 / 提示词 on any phone. Keys go in, never out. */
  private async handleConfig(req: IncomingMessage, res: ServerResponse, path: string, by: string): Promise<void> {
    try {
      if (path === "/v1/assistant/config" && req.method === "GET") {
        sendJson(res, 200, this.eff.view);
        return;
      }
      if (path === "/v1/assistant/config" && req.method === "POST") {
        const change = (await readJson(req)) as unknown as AssistantConfigChange | null;
        if (!change || typeof change !== "object") throw new ConfigError(400, "bad_request", "要改什么没写");
        const said = this.config.apply(change, by);
        this.reconfigure("config", by, said);
        sendJson(res, 200, this.eff.view);
        return;
      }
      if (path === "/v1/assistant/config/test" && req.method === "POST") {
        const body = (await readJson(req)) as { provider?: unknown; model?: unknown } | undefined;
        const model = typeof body?.model === "string" ? body.model : "";
        if (!model.trim()) throw new ConfigError(400, "bad_request", "要测哪个模型没写");
        const target = this.config.targetFor(body?.provider as string, model);
        const r = await testModel(target);
        this.events.record({ kind: "config", level: r.ok ? "info" : "warn", msg: `${by}: tested ${target.provider}:${target.model}: ${r.ok ? `first word ${r.firstMs}ms, all ${r.totalMs}ms` : r.error}` });
        sendJson(res, 200, r);
        return;
      }
      if (path === "/v1/assistant/config/models" && (req.method === "GET" || req.method === "POST")) {
        let provider: unknown = new URL(req.url ?? "/", "http://relay").searchParams.get("provider") ?? "";
        if (req.method === "POST") {
          const body = (await readJson(req)) as { provider?: unknown } | undefined;
          provider = body?.provider ?? "";
        }
        try {
          sendJson(res, 200, { models: await listModels(this.config.targetFor(provider as string, "")) });
        } catch (e) {
          if (e instanceof ConfigError) throw e;
          sendError(res, 502, "unsupported", `服务商没给模型列表：${(e as Error).message.slice(0, 160)}`);
        }
        return;
      }
      if (path === "/v1/assistant/config/voices" && req.method === "GET") {
        const raw = new URL(req.url ?? "/", "http://relay").searchParams.get("provider");
        const activeProvider = this.eff.live?.provider ?? "openai-realtime";
        const provider: VoiceProviderId =
          raw === "moss-live" || raw === "openai-realtime" ? raw : activeProvider === "moss-live" ? "moss-live" : "openai-realtime";
        sendJson(res, 200, voiceCatalogFor(provider));
        return;
      }
      if (path === "/v1/assistant/prompts" && req.method === "GET") {
        sendJson(res, 200, { prompts: promptViews() });
        return;
      }
      const pm = /^\/v1\/assistant\/prompts\/([a-z_]{1,20})$/.exec(path);
      if (pm && req.method === "POST") {
        const id = pm[1];
        if (!isPromptId(id)) throw new ConfigError(404, "not_found", "没有这条提示词");
        const body = (await readJson(req)) as { text?: unknown; reset?: unknown } | undefined;
        if (body?.reset === true) this.config.setPrompt(id, null, by);
        else if (typeof body?.text === "string") this.config.setPrompt(id, body.text, by);
        else throw new ConfigError(400, "bad_request", "要么给 text，要么 reset: true");
        this.reconfigure("prompts", by, `prompt ${id} ${body?.reset === true ? "back to default" : "edited"}`);
        sendJson(res, 200, promptView(id));
        return;
      }
      sendError(res, 404, "not_found", "not found");
    } catch (e) {
      if (e instanceof ConfigError) sendError(res, e.status, e.code, e.message);
      else throw e;
    }
  }

  private async handleAssistant(req: IncomingMessage, res: ServerResponse, path: string, auth: Device | "admin"): Promise<void> {
    if (req.method === "GET" && path === "/v1/assistant") {
      sendJson(res, 200, this.assistant.state());
      return;
    }
    if (req.method === "POST" && path === "/v1/assistant/messages") {
      const text = str((await readJson(req))?.text, 4000)?.trim();
      if (!text) {
        sendError(res, 400, "bad_request", "消息是空的");
        return;
      }
      sendJson(res, 200, { item: this.assistant.say(text, auth === "admin" ? { id: "admin", name: "admin" } : { id: auth.id, name: auth.name }) });
      return;
    }
    if (path.startsWith("/v1/assistant/config") || path.startsWith("/v1/assistant/prompts")) {
      await this.handleConfig(req, res, path, auth === "admin" ? "admin" : auth.name);
      return;
    }
    if (path === "/v1/assistant/settings") {
      if (req.method === "GET") {
        sendJson(res, 200, { ...this.assistant.settings(), default: this.assistant.defaultConfirm() });
        return;
      }
      if (req.method === "POST" || req.method === "PUT") {
        const body = (await readJson(req)) ?? {};
        const hasConfirm = Object.hasOwn(body, "confirm");
        const hasPlugins = Object.hasOwn(body, "plugins");
        const hasWebhooks = Object.hasOwn(body, "webhooks");
        if (hasConfirm && body.confirm !== "never" && body.confirm !== "always") {
          sendError(res, 400, "bad_request", "confirm 需要是 never 或 always");
          return;
        }
        if (hasPlugins && (typeof body.plugins !== "object" || body.plugins === null || Array.isArray(body.plugins))) {
          sendError(res, 400, "bad_request", "plugins 需要是对象");
          return;
        }
        if (hasWebhooks && !Array.isArray(body.webhooks)) {
          sendError(res, 400, "bad_request", "webhooks 需要是数组");
          return;
        }
        if (!hasConfirm && !hasPlugins && !hasWebhooks) {
          sendError(res, 400, "bad_request", "至少需要传入 confirm、plugins 或 webhooks");
          return;
        }
        sendJson(
          res,
          200,
          this.assistant.updateSettings(
            {
              ...(hasConfirm ? { confirm: body.confirm as AssistantConfirm } : {}),
              ...(hasPlugins ? { plugins: body.plugins as Partial<Record<AssistantPluginId, boolean>> } : {}),
              ...(hasWebhooks ? { webhooks: body.webhooks } : {}),
            },
            auth === "admin" ? "admin" : auth.name,
          ),
        );
        return;
      }
    }
    const am = /^\/v1\/assistant\/actions\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (am && req.method === "POST") {
      const decision = (await readJson(req))?.decision;
      if (decision !== "confirm" && decision !== "cancel") {
        sendError(res, 400, "bad_request", "decision 需要是 confirm 或 cancel");
        return;
      }
      try {
        sendJson(res, 200, { item: await this.assistant.decide(am[1]!, decision) });
      } catch (e) {
        sendError(res, 404, "not_found", (e as Error).message);
      }
      return;
    }
    if (req.method === "DELETE" && path === "/v1/assistant/thread") {
      this.assistant.clear();
      sendJson(res, 200, { ok: true });
      return;
    }
    const rm = /^\/v1\/assistant\/reminders\/([A-Za-z0-9_-]{1,40})$/.exec(path);
    if (rm && req.method === "DELETE") {
      if (!this.assistant.cancelReminder(rm[1]!)) sendError(res, 404, "not_found", "没有这个提醒");
      else sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 404, "not_found", "not found");
  }

  /** The relay's own call to a computer (used by the assistant). */
  callHost<M extends RpcMethod>(to: string, method: M, params: RpcParams<M>, timeoutMs?: number): Promise<RpcResult<M>> {
    return new Promise((resolve, reject) => {
      const target = this.hostConns.get(to);
      if (!target || target.device.kind !== "host") {
        this.rpcEvent({ method, from: "relay", target: to, params, t0: Date.now() }, { code: "offline", message: "这台电脑现在不在线" });
        reject(new HostCallError({ code: "offline", message: "这台电脑现在不在线" }));
        return;
      }
      const id = randomUUID();
      const t0 = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.rpcEvent({ method, from: "relay", target: to, params, t0 }, { code: "timeout", message: "电脑端没有及时回应" });
        reject(new HostCallError({ code: "timeout", message: "电脑端没有及时回应" }));
      }, timeoutMs ?? this.opts.rpcTimeoutMs ?? 30_000);
      this.pending.set(id, { caller: { resolve: resolve as (v: unknown) => void, reject }, callerId: id, target: to, timer, method, from: "relay", params, t0 });
      this.send(target, { type: "rpc", id, from: "relay", method, params });
    });
  }

  /**
   * One recording to text. Logged with sizes, timings and the service; never the audio or the text.
   * Limits: TRANSCRIBE_LIMITS (size, length, per-device rate and parallel requests).
   */
  private async handleTranscribe(req: IncomingMessage, res: ServerResponse, url: URL, device: Device, target: TranscribeTarget | { reason: string }): Promise<void> {
    const note = (level: LogLevel, msg: string, data?: Record<string, unknown>) => this.events.record({ kind: "transcribe", level, msg: `"${device.name}": ${msg}`, device: device.id, data });
    const refuse = (status: number, code: RpcError["code"], message: string) => {
      // The rest of a refused upload is not read: close the connection once the answer is out.
      res.setHeader("Connection", "close");
      res.on("finish", () => req.destroy());
      sendError(res, status, code, message);
    };
    if ("reason" in target) {
      note("info", `not available: ${target.reason}`);
      refuse(503, "unsupported", target.reason);
      return;
    }
    const type = audioType(req.headers["content-type"]);
    if (!type) {
      refuse(400, "bad_request", "需要录音本身作为请求体，Content-Type 是 audio/webm、audio/wav、audio/mp4 等");
      return;
    }
    const declared = Number(req.headers["content-length"]);
    if (declared > TRANSCRIBE_LIMITS.maxBytes) {
      note("warn", `refused ${declared} bytes (over ${TRANSCRIBE_LIMITS.maxBytes})`);
      refuse(413, "bad_request", `录音太大（最多 ${Math.round(TRANSCRIBE_LIMITS.maxBytes / 1024 / 1024)} MB）`);
      return;
    }
    const release = this.dictation.take(device.id);
    if (typeof release !== "function") {
      note("warn", `rate limited: ${release.reason}`);
      refuse(429, "forbidden", release.reason);
      return;
    }
    const t0 = Date.now();
    try {
      const audio = await readBody(req, TRANSCRIBE_LIMITS.maxBytes);
      if (!audio) {
        note("warn", `refused an upload over ${TRANSCRIBE_LIMITS.maxBytes} bytes`);
        refuse(413, "bad_request", `录音太大（最多 ${Math.round(TRANSCRIBE_LIMITS.maxBytes / 1024 / 1024)} MB）`);
        return;
      }
      if (!audio.length) {
        sendError(res, 400, "bad_request", "录音是空的");
        return;
      }
      const clientMs = Number(url.searchParams.get("durationMs"));
      const audioMs = wavDurationMs(audio) ?? (Number.isFinite(clientMs) && clientMs > 0 ? Math.round(clientMs) : undefined);
      if (audioMs !== undefined && audioMs > TRANSCRIBE_LIMITS.maxSeconds * 1000) {
        note("warn", `refused ${Math.round(audioMs / 1000)} s of audio (over ${TRANSCRIBE_LIMITS.maxSeconds} s)`);
        sendError(res, 413, "bad_request", `录音太长（最多 ${TRANSCRIBE_LIMITS.maxSeconds} 秒）`);
        return;
      }
      const language = url.searchParams.get("language")?.trim() || undefined;
      const r = await transcribe(target, audio, type, { language });
      const data = { provider: r.provider, model: r.model, type, bytes: audio.length, audioMs, ms: r.ms, totalMs: Date.now() - t0, chars: Array.from(r.text).length, language: r.language ?? "auto" };
      note(r.ms > 8000 ? "warn" : "info", `${r.provider}/${r.model} ${Math.round(audio.length / 1024)} KB${audioMs !== undefined ? ` ${(audioMs / 1000).toFixed(1)} s` : ""} -> ${data.chars} chars in ${r.ms} ms`, data);
      sendJson(res, 200, r satisfies TranscribeResult);
    } catch (e) {
      const status = e instanceof TranscribeError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      note("warn", `${target.provider}/${target.model} failed after ${Date.now() - t0} ms: ${message}`, { provider: target.provider, model: target.model, status, ms: Date.now() - t0 });
      sendError(res, status, status === 504 ? "timeout" : "internal", status === 500 ? "语音识别出错了" : message);
    } finally {
      release();
    }
  }

  /** One line per forwarded call that changed something or failed; reads that work are not worth a row. */
  private rpcEvent(p: { method: string; from: string; target: string; params: unknown; t0: number }, error?: RpcError): void {
    if (!error && !MUTATING.has(p.method)) return;
    const from = p.from === "relay" ? "assistant" : (this.store.getDevice(p.from)?.name ?? p.from);
    const to = this.store.getDevice(p.target)?.name ?? p.target;
    this.events.record({
      kind: "rpc",
      level: error ? (error.code === "internal" || error.code === "timeout" || error.code === "offline" ? "warn" : "info") : "info",
      msg: `${p.method} ${from} -> ${to} ${error ? `${error.code}: ${error.message.slice(0, 200)}` : "ok"} ${Date.now() - p.t0}ms`,
      device: p.target,
      data: rpcSummary(p.method, p.params),
    });
  }

  private logQuery(q: URLSearchParams) {
    const now = Date.now();
    let device = q.get("device")?.trim() || undefined;
    if (device && !this.store.getDevice(device)) {
      const all = this.store.listDevices();
      const want = device.toLowerCase();
      device = (all.find((d) => d.name.toLowerCase() === want) ?? all.find((d) => d.name.toLowerCase().includes(want)))?.id ?? device;
    }
    const after = Number(q.get("after"));
    return {
      since: parseSince(q.get("since"), now) ?? (Number.isFinite(after) && after > 0 ? undefined : now - 3_600_000),
      until: parseSince(q.get("until"), now),
      after: Number.isFinite(after) && after > 0 ? after : undefined,
      device,
      source: ["relay", "host", "viewer"].includes(q.get("source") ?? "") ? q.get("source")! : undefined,
      kind: q.get("kind")?.trim().slice(0, 40) || undefined,
      levels: levelsFrom(q.get("level") as LogLevel | null),
      text: q.get("text")?.trim().slice(0, 80) || undefined,
      limit: Math.min(Math.max(Number(q.get("limit")) || 200, 1), 2000),
    };
  }

  /** What the control panel shows at the top: health and how the relay is set up (never keys). */
  private overview() {
    this.sweepJoins();
    const devices = this.devices();
    const deviceNames = new Map(devices.map((d) => [d.id, d.name]));
    const agents = this.allAgents();
    const a = this.eff;
    const live = this.eff.live;
    const dayAgo = Date.now() - 86_400_000;
    const trouble = this.events.query({ since: dayAgo, levels: ["warn", "error"], limit: 5000 });
    const hostOf = (u: string) => {
      try {
        return new URL(u).host;
      } catch {
        return "";
      }
    };
    const host = [...new Set((a?.targets ?? []).map((t) => hostOf(t.baseUrl)).filter(Boolean))].join(", ");
    const joins: JoinRequest[] = [];
    for (const j of this.joins.values()) {
      if (j.state === "pending") joins.push(j.req);
    }
    return {
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      startedAt: STARTED,
      devices: devices.length,
      online: devices.filter((d) => d.online).length,
      agents: agents.filter((x) => !x.isShell).length,
      agentList: agents.map((ag) => ({ ...ag, deviceName: deviceNames.get(ag.deviceId) ?? ag.deviceId })),
      joins,
      assistant: {
        ready: this.assistant.state().ready,
        models: this.opts.llm ? ["test"] : (a?.targets ?? []).map((t) => `${t.provider}:${t.model}`),
        endpoint: host,
        confirm: this.assistant.confirmMode(),
        busy: this.assistant.state().busy,
      },
      voice: live?.apiKey ? { provider: live.provider ?? "moss-live", model: live.model, ...(live.voice ? { voice: live.voice } : {}), endpoint: hostOf(live.url) } : null,
      last24h: { warn: trouble.filter((e) => e.level === "warn").length, error: trouble.filter((e) => e.level === "error").length },
      actions: this.assistant
        .state()
        .items.filter((i) => i.action)
        .slice(-30)
        .reverse()
        .map((i) => i.action),
    };
  }

  private *allConns(): IterableIterator<Conn> {
    for (const c of this.hostConns.values()) yield c;
    for (const set of this.viewerConns.values()) {
      for (const c of set) yield c;
    }
  }

  private onlineDeviceCount(): number {
    return this.hostConns.size + this.viewerConns.size;
  }

  private latestViewerConn(deviceId: string): Conn | undefined {
    const set = this.viewerConns.get(deviceId);
    if (!set || set.size === 0) return undefined;
    let last: Conn | undefined;
    for (const c of set) last = c;
    return last;
  }

  private toViewers(frame: ServerFrame): void {
    const data = JSON.stringify(frame);
    for (const set of this.viewerConns.values()) {
      for (const c of set) {
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
      }
    }
  }

  /** Deletes a device, drops its live connection(s) and tells everyone. */
  private removeDevice(id: string, why: string): boolean {
    if (!this.store.deleteDevice(id)) return false;
    this.log(`removed ${id}: ${why}`);
    const hc = this.hostConns.get(id);
    if (hc) {
      this.hostConns.delete(id);
      this.failPendingForHost(id);
      this.endStreams(hc);
      hc.ws.close(4001, "revoked");
    }
    const vcSet = this.viewerConns.get(id);
    if (vcSet) {
      this.viewerConns.delete(id);
      for (const vc of vcSet) {
        this.failPendingForCaller(vc);
        this.endStreams(vc);
        vc.ws.close(4001, "revoked");
      }
    }
    this.agents.delete(id);
    this.broadcast({ type: "device_removed", seq: ++this.seq, id });
    return true;
  }

  private authenticate(req: IncomingMessage, url: URL): Device | "admin" | null {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : url.searchParams.get("token");
    if (!token) return null;
    if (this.opts.adminToken && safeEqual(token, this.opts.adminToken)) return "admin";
    return this.store.deviceByToken(token);
  }

  private publicUrl(req: IncomingMessage): string {
    if (this.opts.publicUrl) return this.opts.publicUrl.replace(/\/+$/, "");
    const proto = this.opts.trustProxy ? String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0] : "http";
    return `${proto}://${req.headers.host ?? "localhost"}`;
  }

  private rpIdOf(req: IncomingMessage): string {
    try {
      return new URL(this.publicUrl(req)).hostname.toLowerCase();
    } catch {
      return String(req.headers.host ?? "localhost").split(":")[0]!.toLowerCase();
    }
  }

  private resolveAnchoredDevice(req: IncomingMessage): Device | null {
    const cookies = parseAnchorCookies(req);
    const id = verifyAnchorToken(cookies.hp_anchor, (d) => this.config.hmacAnchor(d));
    return id ? this.store.getDevice(id) : null;
  }

  private setAnchorCookie(req: IncomingMessage, res: ServerResponse, deviceId: string): void {
    const secure = this.publicUrl(req).startsWith("https://");
    const val = signAnchorToken(deviceId, (d) => this.config.hmacAnchor(d));
    res.setHeader("Set-Cookie", formatAnchorCookieHeader(val, secure));
  }

  private findReusableDeviceForPair(opts: {
    kind: DeviceKind;
    previous: Device | "admin" | null;
    verifiedId: { identityPubKey: string; fingerprintHash?: string } | null;
    anchored: Device | null;
  }): { mode: "reuse"; device: Device } | null {
    if (opts.verifiedId) {
      const byKey = this.store.findDeviceByIdentityPubKey(opts.verifiedId.identityPubKey, opts.kind);
      if (byKey) return { mode: "reuse", device: byKey };
    }
    if (opts.previous && opts.previous !== "admin" && opts.previous.kind === opts.kind) {
      const rec = this.store.getDeviceIdentityRecord(opts.previous.id);
      if (rec?.identityPubKey && opts.verifiedId && rec.identityPubKey === opts.verifiedId.identityPubKey) {
        return { mode: "reuse", device: rec.device };
      }
    }
    if (opts.anchored && opts.anchored.kind === opts.kind) {
      const rec = this.store.getDeviceIdentityRecord(opts.anchored.id);
      if (rec && (!rec.identityPubKey || (opts.verifiedId && rec.identityPubKey === opts.verifiedId.identityPubKey))) {
        return { mode: "reuse", device: rec.device };
      }
    }
    return null;
  }

  private clientIp(req: IncomingMessage): string {
    if (this.opts.trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "?";
  }

  private sweepJoins(): void {
    const now = Date.now();
    for (const [id, j] of this.joins) if (j.req.expiresAt < now) this.joins.delete(id);
  }

  private pairBlocked(ip: string): boolean {
    const f = this.pairFails.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > PAIR_FAIL_WINDOW_MS) {
      this.pairFails.delete(ip);
      return false;
    }
    return f.n >= PAIR_FAIL_LIMIT;
  }

  private pairFailed(ip: string): void {
    const f = this.pairFails.get(ip);
    if (!f || Date.now() - f.since > PAIR_FAIL_WINDOW_MS) this.pairFails.set(ip, { n: 1, since: Date.now() });
    else f.n++;
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://relay");
    const path = url.pathname.replace(/\/+$/, "");
    if (path !== "/v1/ws" && path !== "/v1/notify" && path !== "/v1/assistant/live") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const auth = this.authenticate(req, url);
    if (!auth || auth === "admin") {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (path === "/v1/ws") {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, auth));
      return;
    }
    if (auth.kind !== "viewer") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (path === "/v1/notify") {
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      this.notifyWss.handleUpgrade(req, socket, head, (ws) => this.onNotifyConnection(ws, since));
      return;
    }
    const live = this.eff.live;
    if (!live?.apiKey) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    this.notifyWss.handleUpgrade(req, socket, head, (ws) => {
      this.log(`live: call from "${auth.name}" (${auth.id})`);
      startCall(ws, auth.id, live, this.assistant, this.log, (ev) => this.events.record({ device: auth.id, ...ev }));
    });
  }

  /** A phone's background push channel: notices only, never replaces the main socket. */
  private onNotifyConnection(ws: WebSocket, since: number): void {
    const sub = { ws, alive: true };
    this.notifySubs.add(sub);
    ws.on("pong", () => (sub.alive = true));
    ws.on("message", () => (sub.alive = true));
    ws.on("close", () => this.notifySubs.delete(sub));
    ws.on("error", () => this.notifySubs.delete(sub));
    const send = (f: NotifyFrame) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(f));
    send({ type: "hello", ts: Date.now() });
    if (since > 0) for (const notice of this.assistant.noticesSince(since)) send({ type: "notice", notice });
  }

  private onConnection(ws: WebSocket, device: Device): void {
    const conn: Conn = { ws, device: { ...device }, alive: true };
    let announceOnline = true;
    if (device.kind === "host") {
      const prev = this.hostConns.get(device.id);
      if (prev) {
        // A newer connection of the same host wins.
        this.hostConns.delete(device.id);
        prev.ws.close(4000, "replaced");
        // Before this connection's frames: end any streams bound to the previous host socket.
        this.endStreams(prev);
      }
      this.hostConns.set(device.id, conn);
      this.store.touch(device.id);
      this.events.record({ kind: "device", msg: `online ${device.kind} "${device.name}"`, device: device.id });
    } else {
      let set = this.viewerConns.get(device.id);
      if (!set) {
        set = new Set();
        this.viewerConns.set(device.id, set);
      }
      const wasOnline = set.size > 0;
      announceOnline = !wasOnline;
      while (set.size >= MAX_VIEWER_CONNS_PER_DEVICE) {
        const oldest = set.values().next().value;
        if (!oldest) break;
        set.delete(oldest);
        this.failPendingForCaller(oldest);
        this.endStreams(oldest);
        oldest.ws.close(4000, "replaced");
      }
      set.add(conn);
      this.store.touch(device.id);
      if (!wasOnline) {
        this.events.record({ kind: "device", msg: `online ${device.kind} "${device.name}"`, device: device.id });
      }
    }

    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      conn.alive = true;
      if (isBinary) return;
      let frame: ClientFrame;
      try {
        frame = JSON.parse(data.toString()) as ClientFrame;
      } catch {
        this.send(conn, { type: "error", error: { code: "bad_request", message: "invalid json" } });
        return;
      }
      this.onFrame(conn, frame);
    });
    ws.on("close", () => {
      if (this.closing) return;
      if (device.kind === "host") {
        if (this.hostConns.get(device.id) !== conn) return; // replaced
        this.hostConns.delete(device.id);
        this.store.touch(device.id);
        this.failPendingForHost(device.id);
        this.endStreams(conn);
        this.events.record({ kind: "device", msg: `offline ${device.kind} "${device.name}"`, device: device.id });
        if (this.agents.delete(device.id)) {
          this.broadcast({ type: "agents", seq: ++this.seq, deviceId: device.id, agents: [] });
        }
        const d = this.store.getDevice(device.id);
        if (d) this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(d) });
        return;
      }
      const curSet = this.viewerConns.get(device.id);
      if (!curSet?.delete(conn)) return; // already removed or replaced
      this.store.touch(device.id);
      this.failPendingForCaller(conn);
      this.endStreams(conn);
      if (curSet.size === 0) {
        this.viewerConns.delete(device.id);
        this.events.record({ kind: "device", msg: `offline ${device.kind} "${device.name}"`, device: device.id });
        const d = this.store.getDevice(device.id);
        if (d) this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(d) });
      }
    });
    ws.on("error", () => {});

    const latestRel = this.releases.latestVersion();
    this.send(conn, {
      type: "welcome",
      version: PROTOCOL_VERSION,
      serverVersion: VERSION,
      ...(latestRel ? { latestRelease: latestRel } : {}),
      device: this.decorate(conn.device),
      seq: this.seq,
    });
    this.send(conn, { type: "snapshot", seq: this.seq, devices: this.devices(), agents: this.allAgents() });
    if (announceOnline) {
      this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(conn.device) }, device.id);
    }
  }

  private onFrame(conn: Conn, frame: ClientFrame): void {
    switch (frame.type) {
      case "hello": {
        conn.device.platform = str(frame.platform, 32) ?? conn.device.platform;
        conn.device.sources = Array.isArray(frame.sources) ? frame.sources.slice(0, 8) : undefined;
        conn.device.version = str(frame.appVersion, 32);
        this.store.touch(conn.device.id, conn.device.platform);
        this.events.record({ kind: "device", level: "debug", msg: `hello "${conn.device.name}" ${conn.device.version ?? "?"} ${conn.device.platform ?? ""}`.trim(), device: conn.device.id });
        this.broadcast({ type: "device", seq: ++this.seq, device: this.decorate(conn.device) });
        return;
      }
      case "agents": {
        if (conn.device.kind !== "host") {
          this.send(conn, { type: "error", error: { code: "forbidden", message: "only hosts publish agents" } });
          return;
        }
        if (!Array.isArray(frame.agents)) return;
        // Never trust the host about whose agents these are.
        const agents = frame.agents
          .slice(0, MAX_AGENTS)
          .filter((a) => a && typeof a.localId === "string" && typeof a.source === "string")
          .map((a) => ({ ...a, deviceId: conn.device.id, key: `${conn.device.id}/${a.source}:${a.localId}` }));
        this.agents.set(conn.device.id, agents);
        this.broadcast({ type: "agents", seq: ++this.seq, deviceId: conn.device.id, agents });
        this.assistant.onAgents(conn.device.id, agents);
        return;
      }
      case "rpc": {
        this.routeRpc(conn, frame);
        return;
      }
      case "stream_subscribe": {
        this.routeStreamSubscribe(conn, frame);
        return;
      }
      case "stream_unsubscribe": {
        this.routeStreamUnsubscribe(conn, frame);
        return;
      }
      case "stream_open": {
        const s = this.streams.get(frame.id);
        if (!s || s.target !== conn.device.id) return;
        this.send(s.caller, { ...frame, id: s.callerId });
        if (frame.error) {
          this.streams.delete(frame.id);
          const byCaller = this.callerStreams.get(s.caller);
          if (byCaller?.get(s.callerId) === frame.id) {
            byCaller.delete(s.callerId);
            if (byCaller.size === 0) this.callerStreams.delete(s.caller);
          }
        }
        return;
      }
      case "stream_event": {
        const s = this.streams.get(frame.id);
        if (s?.target === conn.device.id) {
          this.send(s.caller, { ...frame, id: s.callerId });
        }
        return;
      }
      case "rpc_result": {
        const p = this.pending.get(frame.id);
        // Only the host the call was sent to may answer it.
        if (!p || p.target !== conn.device.id) return;
        clearTimeout(p.timer);
        this.pending.delete(frame.id);
        this.rpcEvent(p, frame.error);
        if ("resolve" in p.caller) {
          if (frame.error) p.caller.reject(new HostCallError(frame.error));
          else p.caller.resolve(frame.result);
        } else this.send(p.caller, { type: "rpc_result", id: p.callerId, result: frame.result, error: frame.error });
        return;
      }
      case "ping": {
        this.send(conn, { type: "pong", t: frame.t });
        return;
      }
      case "log": {
        this.events.ingest(conn.device, frame.entries);
        return;
      }
      default:
        return; // unknown frames are ignored (forward compatible)
    }
  }

  private routeStreamSubscribe(caller: Conn, frame: Extract<ClientFrame, { type: "stream_subscribe" }>): void {
    const fail = (error: RpcError) => this.send(caller, { type: "stream_open", id: frame.id, error });
    if (
      typeof frame.id !== "string" ||
      typeof frame.to !== "string" ||
      (frame.stream !== "terminal" && frame.stream !== "session" && frame.stream !== "portal")
    ) {
      fail({ code: "bad_request", message: "stream_subscribe 需要 id、to、stream" });
      return;
    }
    if (this.viewerConns.has(frame.to)) {
      fail({ code: "forbidden", message: "只能订阅电脑端的流" });
      return;
    }
    const target = this.hostConns.get(frame.to);
    if (!target) {
      fail({ code: "offline", message: "这台电脑现在不在线" });
      return;
    }
    if (target.device.kind !== "host") {
      fail({ code: "forbidden", message: "只能订阅电脑端的流" });
      return;
    }
    let byCaller = this.callerStreams.get(caller);
    if (byCaller?.has(frame.id)) {
      fail({ code: "bad_request", message: "重复的流 id" });
      return;
    }
    if (!byCaller) {
      byCaller = new Map();
      this.callerStreams.set(caller, byCaller);
    }
    const relayId = !this.streams.has(frame.id) ? frame.id : `vs${++this.streamSeq}:${frame.id}`;
    this.streams.set(relayId, { caller, callerId: frame.id, target: frame.to });
    byCaller.set(frame.id, relayId);
    this.send(target, { type: "stream_subscribe", id: relayId, from: caller.device.id, stream: frame.stream, params: frame.params });
  }

  /**
   * A connection is gone. End any streams it subscribed to (and notify target hosts),
   * and if it is a host connection, notify callers waiting on streams to that host.
   */
  private endStreams(conn: Conn): void {
    const byCaller = this.callerStreams.get(conn);
    if (byCaller) {
      for (const relayId of byCaller.values()) {
        const s = this.streams.get(relayId);
        if (!s) continue;
        this.streams.delete(relayId);
        const target = this.hostConns.get(s.target);
        if (target) this.send(target, { type: "stream_unsubscribe", id: relayId, from: conn.device.id });
      }
      this.callerStreams.delete(conn);
    }
    if (conn.device.kind !== "host") return;
    for (const [relayId, s] of this.streams) {
      if (s.target === conn.device.id) {
        this.streams.delete(relayId);
        const callerMap = this.callerStreams.get(s.caller);
        if (callerMap?.get(s.callerId) === relayId) {
          callerMap.delete(s.callerId);
          if (callerMap.size === 0) this.callerStreams.delete(s.caller);
        }
        this.send(s.caller, { type: "stream_open", id: s.callerId, error: { code: "offline", message: "这台电脑断开了" } });
      }
    }
  }

  private routeStreamUnsubscribe(caller: Conn, frame: Extract<ClientFrame, { type: "stream_unsubscribe" }>): void {
    const byCaller = this.callerStreams.get(caller);
    const relayId = byCaller?.get(frame.id);
    if (!relayId) return;
    byCaller!.delete(frame.id);
    if (byCaller!.size === 0) this.callerStreams.delete(caller);
    const s = this.streams.get(relayId);
    if (!s || s.caller !== caller) return;
    this.streams.delete(relayId);
    const target = this.hostConns.get(s.target);
    if (target) this.send(target, { type: "stream_unsubscribe", id: relayId, from: caller.device.id });
  }

  private routeRpc(caller: Conn, frame: Extract<ClientFrame, { type: "rpc" }>): void {
    const fail = (error: RpcError) => this.send(caller, { type: "rpc_result", id: String(frame.id), error });
    if (typeof frame.id !== "string" || typeof frame.to !== "string" || typeof frame.method !== "string") {
      fail({ code: "bad_request", message: "rpc needs id, to and method" });
      return;
    }
    if (frame.to === caller.device.id) {
      fail({ code: "bad_request", message: "cannot call yourself through the relay" });
      return;
    }
    if (this.viewerConns.has(frame.to)) {
      fail({ code: "forbidden", message: "只能调用电脑端（host）" });
      return;
    }
    const target = this.hostConns.get(frame.to);
    if (!target) {
      this.rpcEvent({ method: frame.method, from: caller.device.id, target: frame.to, params: frame.params, t0: Date.now() }, { code: "offline", message: "这台电脑现在不在线" });
      fail({ code: "offline", message: "这台电脑现在不在线" });
      return;
    }
    if (target.device.kind !== "host") {
      fail({ code: "forbidden", message: "只能调用电脑端（host）" });
      return;
    }
    const id = randomUUID();
    const t0 = Date.now();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.rpcEvent({ method: frame.method, from: caller.device.id, target: target.device.id, params: frame.params, t0 }, { code: "timeout", message: "电脑端没有及时回应" });
      fail({ code: "timeout", message: "电脑端没有及时回应" });
    }, Math.max(this.opts.rpcTimeoutMs ?? 30_000, SLOW_RPC_MS[frame.method] ?? 0));
    this.pending.set(id, { caller, callerId: frame.id, target: target.device.id, timer, method: frame.method, from: caller.device.id, params: frame.params, t0 });
    this.send(target, { type: "rpc", id, from: caller.device.id, method: frame.method, params: frame.params });
  }

  private failPendingForHost(deviceId: string): void {
    for (const [id, p] of this.pending) {
      if (p.target === deviceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        const error: RpcError = { code: "offline", message: "电脑端断开了连接" };
        this.rpcEvent(p, error);
        if ("resolve" in p.caller) p.caller.reject(new HostCallError(error));
        else this.send(p.caller, { type: "rpc_result", id: p.callerId, error });
      }
    }
  }

  private failPendingForCaller(caller: Conn): void {
    for (const [id, p] of this.pending) {
      if (!("resolve" in p.caller) && p.caller === caller) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
    }
  }

  private sweep(): void {
    for (const c of this.allConns()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
    for (const s of this.notifySubs) {
      if (!s.alive) {
        s.ws.terminate();
        this.notifySubs.delete(s);
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }

  // -------------------------------------------------------------------------

  private decorate(d: Device): Device {
    const live = d.kind === "host" ? this.hostConns.get(d.id) : this.latestViewerConn(d.id);
    return {
      ...d,
      online: !!live,
      platform: live?.device.platform ?? d.platform,
      sources: live?.device.sources ?? d.sources,
      version: live?.device.version ?? d.version,
      lastSeenAt: live ? Date.now() : d.lastSeenAt,
    };
  }

  private devices(): Device[] {
    return this.store.listDevices().map((d) => this.decorate(d));
  }

  private allAgents(): Agent[] {
    return [...this.agents.values()].flat();
  }

  private send(conn: Conn, frame: ServerFrame): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
  }

  private broadcast(frame: ServerFrame, exceptId?: string): void {
    const data = JSON.stringify(frame);
    for (const c of this.allConns()) {
      if (c.device.id !== exceptId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }
}

// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

function sendPage(res: ServerResponse, status: number, page: LandingPage, headOnly: boolean): void {
  res.writeHead(status, page.headers);
  res.end(headOnly ? undefined : page.html);
}

function sendError(res: ServerResponse, status: number, code: RpcError["code"], message: string): void {
  sendJson(res, status, { error: { code, message } });
}

/** A plain journal line as an event: "live: call ended" is kind live, "http error" is an error. */
function plainEvent(m: string): EventInput {
  const prefix = /^([a-z][a-z.-]{1,20}):\s/i.exec(m);
  const kind = prefix && ["assistant", "live", "live.ai", "realtime", "assistant notice"].includes(prefix[1]!.toLowerCase()) ? prefix[1]!.toLowerCase() : "relay";
  const msg = kind === "relay" ? m : m.slice(prefix![0].length);
  const level = /^http error/.test(m) ? "error" : /\b(fail(ed|ure)?|error|rejected|refused|timeout|dropped)\b/i.test(m) ? "warn" : "info";
  return { kind, level, msg };
}

/** What a mutating call was about, short; message text clipped. */
function rpcSummary(method: string, params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") return undefined;
  const p = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["agent", "launcher", "space", "spaceId", "spaceName", "tabName", "folder", "command", "session", "path", "modelId", "thinkingLevel"]) if (typeof p[k] === "string") out[k] = p[k];
  if (typeof p.text === "string") out.text = Array.from(p.text).slice(0, 200).join("");
  if (typeof p.task === "string") out.task = Array.from(p.task).slice(0, 200).join("");
  if (Array.isArray(p.keys)) out.keys = p.keys.slice(0, 16).join(" ");
  if (method === "herdr.command" && p.args && typeof p.args === "object") out.args = JSON.stringify(p.args).slice(0, 200);
  return Object.keys(out).length ? out : undefined;
}

/** The whole body, or null once it passes `max` bytes (the rest is not read). */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  if (!size) return null;
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
