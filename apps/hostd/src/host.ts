import { homedir, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  HARNESS_ICON_MAX,
  PROTOCOL_VERSION,
  agentKey,
  parseAgentKey,
  rowsChange,
  type Agent,
  type AgentSource,
  type ConvEvent,
  type LayoutSpace,
  type Device,
  type ClientFrame,
  type RpcError,
  type RpcMethod,
  type RpcMethods,
  type ServerFrame,
  type TerminalDataEvent,
  type TerminalDisplay,
  type TerminalRowsEvent,
} from "@herdr-pocket/protocol";
import { HcAdapter, type AppNames } from "./hc.ts";
import type { ScreenLines } from "./hcscreen.ts";
import { HerdrApp, NoDesktopApp, checkFolder, findPrograms, herdrCommandArgs, installedLaunchers, launcherArgv, resolveSpaceFolder, resumeArgv, shortHome, withProgramPath } from "./create.ts";
import { HerdrAdapter } from "./herdr.ts";
import { DirectServer, type DirectPeer } from "./direct.ts";
import { UnifloAdapter, harnessId } from "./uniflo.ts";
import { SessionHints } from "./sessionhint.ts";
import { base, debounce } from "./util.ts";
import { InputWaits } from "./waiting.ts";
import { typeFirstTask, type TypeTaskOptions } from "./firsttask.ts";
import { FILES_DIR, checkFiles, putLocal, putThrough, type CheckedFile } from "./put.ts";
import { LogBuffer, clipChars, levelOf } from "./logbuf.ts";
import { CONFIG_DIR, type HostConfig } from "./config.ts";
import { FilesError, listFiles, listFolders, readFileSlice } from "./files.ts";
import { getGitDiff, getGitLog, getGitStatus, gitCheckout, gitCommit, gitDiscard, gitPull, gitPush, gitStage, gitUnstage } from "./git.ts";
import { scanAgentSlashCommands } from "./slash.ts";
import { getAgentModels, setAgentModelAndThinking } from "./models.ts";
import { getAgentUsageReport } from "./usage.ts";
import { run } from "./util.ts";
import { changedKeys } from "./configcmd.ts";
import { VERSION, clientConfigPath, readClientConfig, type LoadedClientConfig } from "@herdr-pocket/update";
import { getConfigValue, type ClientConfig, type HostTools, type LogLevel, type UpstreamLatest } from "@herdr-pocket/protocol";
import { checkUpstream, herdrAppVersion, readUpstreamCache, writeUpstreamCache, type UpstreamDeps } from "./upstream.ts";

/** The repository version (root package.json), shared with the relay and the app. */
export const HOSTD_VERSION = VERSION;

/** Calls that change something here: logged when they work too. */
const MUTATING = new Set([
  "terminal.send",
  "terminal.keys",
  "terminal.put",
  "agent.create",
  "agent.setModel",
  "space.delete",
  "terminal.interrupt",
  "terminal.kill",
  "herdr.command",
  "sessions.resume",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "git.checkout",
  "git.pull",
  "git.push",
]);

/** What a call was about, short: never more than 200 characters of anyone's message. */
function callSummary(params: unknown, result?: unknown): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (params && typeof params === "object") {
    const p = params as Record<string, unknown>;
    for (const k of ["agent", "launcher", "space", "spaceId", "spaceName", "tabName", "folder", "command", "session", "path", "modelId", "thinkingLevel"]) if (typeof p[k] === "string") out[k] = p[k];
    if (typeof p.text === "string") out.text = clipChars(p.text, 200);
    if (typeof p.task === "string") out.task = clipChars(p.task, 200);
    if (Array.isArray(p.keys)) out.keys = p.keys.slice(0, 16).join(" ");
    // Pictures: how many, never their contents.
    if (Array.isArray(p.files)) out.files = p.files.length;
    if (p.args && typeof p.args === "object") out.args = clipChars(JSON.stringify(p.args), 200);
  }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const k of ["agent", "terminal", "position", "waiting", "agentStatus", "task", "taskNote"]) if (r[k] !== undefined && typeof r[k] !== "object") out[`result.${k}`] = r[k];
  }
  return Object.keys(out).length ? out : undefined;
}

type Handler<M extends RpcMethod> = (params: RpcMethods[M]["params"], from: string) => Promise<RpcMethods[M]["result"]>;

class RpcFailure extends Error {
  code: RpcError["code"];
  constructor(code: RpcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface HostOptions {
  config: HostConfig;
  /** Device ids allowed to drive this computer. Empty = every paired device. */
  allow?: string[];
  readOnly?: boolean;
  log?: (msg: string) => void;
}

/**
 * Runs on each computer: publishes its herdr agents to the relay and answers
 * rpc calls from phones and other computers.
 */
export class Host {
  hc = new HcAdapter();
  herdr = new HerdrAdapter();
  uniflo = new UnifloAdapter();
  /** Session ids running agents name themselves (Claude Code registry, `--resume <id>`). */
  sessionHints = new SessionHints();
  app = new HerdrApp();
  private launchersCache: { at: number; list: ReturnType<typeof installedLaunchers> } | null = null;
  /** Installed programs, re-checked every 10 minutes so a newly installed agent shows up without a restart. */
  private get launchers(): ReturnType<typeof installedLaunchers> {
    if (!this.launchersCache || Date.now() - this.launchersCache.at > 10 * 60_000) {
      const list = installedLaunchers();
      this.launchersCache = { at: Date.now(), list };
      list.catch(() => {
        if (this.launchersCache?.list === list) this.launchersCache = null;
      });
    }
    return this.launchersCache.list;
  }
  sources: AgentSource[] = [];
  agents: Agent[] = [];
  deviceId = "";

  /** Everything the relay knows (all devices, all hosts' agents). */
  devices = new Map<string, Device>();
  remoteAgents = new Map<string, Agent[]>();

  private ws: WebSocket | null = null;
  private calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private callSeq = 0;
  private streamStops = new Map<string, () => void>();
  private streamMeta = new Map<string, { from: string; kind: "terminal" | "session"; agent: string }>();
  /** Streams opened over a direct link answer there, not through the relay. */
  private streamReply = new Map<string, (f: ClientFrame) => void>();
  /** Phones connected straight to this computer (see direct.ts). */
  direct: DirectServer;
  private sendQueues = new Map<string, Array<{ id: string; text: string; enter: boolean }>>();
  private queueSeq = 0;
  private stopped = false;
  private backoff = 1000;
  /** How often the relay link is pinged; a ping still unanswered at the next one drops the link. */
  heartbeatMs = 30_000;
  private lastPublished = "";
  private log: (msg: string) => void;
  private opts: HostOptions;
  private publish = debounce(() => this.publishNow(), 300);
  /** Space and tab names from the desktop app; the last good copy is kept while its window is closed. */
  private names: AppNames | undefined;
  private namesSig = "";
  private namesTimer: NodeJS.Timeout | null = null;
  /** Resolved space folders cached from `spaces.list` so empty `agent.create` folder inherits live cwd. */
  private spaceFolders = new Map<string, string>();
  /** Optimistic current model / thinking overrides per agent after `agent.setModel`. */
  private modelOverrides = new Map<string, { model?: string; thinking?: string }>();
  /**
   * Sources that did not answer are looked for again this often. After a reboot or a login the
   * daemon can start before the herdr app or Uniflo; without this it would never read
   * conversations until it was restarted.
   */
  sourceRetryMs = 30_000;
  /** How often a conversation stream reads the page: without Uniflo's push, and as recovery beside it. */
  sessionPollMs = 250;
  sessionPollLiveMs = 2000;
  private sourceTimer: NodeJS.Timeout | null = null;
  private findingSources = false;
  private sourcesLogged = false;
  /** Text typed into busy agents that their programs have not taken yet. */
  waits = new InputWaits();
  private waitTimer: NodeJS.Timeout | null = null;
  /** This computer's own log lines, uploaded to the relay every minute. */
  logs = new LogBuffer();
  private logTimer: NodeJS.Timeout | null = null;
  /** How often the log ring is uploaded. */
  logEveryMs = 60_000;
  /** How long agent.create waits for a program before typing its first task (tests shorten it). */
  firstTaskOptions: TypeTaskOptions = {};
  /** Where pictures for agents of the herdr terminal app are kept (tests point it elsewhere). */
  filesDir = FILES_DIR;
  /** Folders `files.list` / `files.read` never show: this computer's own settings, with its token. */
  privateDirs = [CONFIG_DIR];
  /** config.json as last read (logging settings; changes are logged). */
  private settings: LoadedClientConfig;
  private settingsStamp = "";
  /** Versions of herdr, Uniflo (`--version`) and the Herdr app, looked up at start (again by the upstream check). */
  private toolVersions: { herdr?: string; uniflo?: string; app?: string } = {};
  /** Full paths of herdr and uniflo as findPrograms found them (a service's PATH is bare). */
  private toolBins: { herdr?: string; uniflo?: string } = {};
  /** Newer upstream releases, from `<state>/upstream.json` and the daily check (cli.ts schedules it). */
  private upstream: UpstreamLatest | undefined;

  constructor(opts: HostOptions) {
    this.opts = opts;
    const out = opts.log ?? ((m: string) => console.log(`[hostd] ${m}`));
    // Every plain line also goes to the relay's log, so trouble here can be seen from there.
    this.log = (m) => {
      out(m);
      this.keep(levelOf(m), "hostd", m);
    };
    this.settings = readClientConfig();
    this.settingsStamp = this.stampOf(this.settings);
    this.deviceId = opts.config.deviceId;
    this.direct = new DirectServer({
      port: opts.config.directPort,
      hostId: () => this.deviceId,
      onFrame: (peer, f) => this.onDirectFrame(peer, f),
      onClose: (peer) => this.stopStreams((id) => id.startsWith(peer.tag)),
      log: (m) => this.log(m),
    });
  }

  /** Direct links are on unless `"direct": false` in hostd.json or HERDR_POCKET_DIRECT=0. */
  private async startDirect(): Promise<void> {
    if (this.opts.config.direct === false || process.env.HERDR_POCKET_DIRECT === "0") return;
    try {
      await this.direct.start();
      this.log(`direct links on port ${this.direct.port}`);
    } catch (e) {
      this.log(`direct links off: ${(e as Error).message}`);
    }
  }

  /** A frame from a phone on a direct link: the same calls and streams as through the relay. */
  private onDirectFrame(peer: DirectPeer, f: Record<string, unknown>): void {
    const id = typeof f.id === "string" ? f.id : "";
    if (f.type === "ping") peer.send({ type: "pong", t: f.t });
    else if (f.type === "rpc" && id && typeof f.method === "string") {
      void this.handleRpc({ type: "rpc", id, from: peer.deviceId, method: f.method as RpcMethod, params: f.params }, (x) => peer.send(x));
    } else if (f.type === "stream_subscribe" && id && (f.stream === "terminal" || f.stream === "session")) {
      const reply = (x: ClientFrame) => peer.send("id" in x && typeof x.id === "string" ? { ...x, id: x.id.slice(peer.tag.length) } : x);
      void this.handleStreamSubscribe({ type: "stream_subscribe", id: peer.tag + id, from: peer.deviceId, stream: f.stream, params: f.params }, reply);
    } else if (f.type === "stream_unsubscribe" && id) this.stopStream(peer.tag + id);
  }

  private stopStreams(which: (id: string) => boolean): void {
    for (const id of [...this.streamStops.keys(), ...this.streamMeta.keys()]) if (which(id)) this.stopStream(id);
  }

  /** A structured line for the relay's log (not printed). */
  note(level: LogLevel, kind: string, msg: string, data?: Record<string, unknown>): void {
    this.keep(level, kind, msg, data);
  }

  /** Into the ring, unless below `logging.level` in config.json. */
  private keep(level: LogLevel, kind: string, msg: string, data?: Record<string, unknown>): void {
    const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    if (rank[level] < rank[this.settings.config.logging.level]) return;
    this.logs.push(level, kind, msg, data);
  }

  private stampOf(c: LoadedClientConfig): string {
    return JSON.stringify([c.exists, c.config, c.problems.map((p) => p.key + p.message)]);
  }

  /** Reads config.json again; a change (from the CLI or the desktop app) is logged with the keys it touched. */
  checkSettings(): void {
    const next = readClientConfig(this.settings.path);
    const stamp = this.stampOf(next);
    if (stamp === this.settingsStamp) return;
    const keys = changedKeys(this.settings.config, next.config);
    const prev = this.settings.config;
    this.settings = next;
    this.settingsStamp = stamp;
    if (keys.length) {
      const show = (c: ClientConfig, k: string) => JSON.stringify(getConfigValue(c, k));
      this.note("info", "config", `config.json changed: ${keys.map((k) => `${k} ${show(prev, k)} -> ${show(next.config, k)}`).join(", ")}`, { keys: keys.join(",") });
    }
    const errors = next.problems.filter((p) => p.level === "error");
    if (errors.length) this.note("warn", "config", `config.json has problems: ${errors.map((p) => `${p.key || "file"}: ${p.message}`).join("; ")}`);
  }

  /** Sends what the ring holds, at most a few batches at a time (none with `logging.upload: false`). */
  flushLogs(): void {
    this.checkSettings();
    if (!this.settings.config.logging.upload) return;
    for (let i = 0; i < 5 && this.logs.size && this.connected; i++) {
      const entries = this.logs.take(200);
      this.send({ type: "log", entries });
    }
  }

  async start(): Promise<void> {
    const cfg = this.settings;
    const set = cfg.raw ? Object.entries(cfg.raw).filter(([k]) => k !== "version").length : 0;
    this.note("info", "config", `config.json ${cfg.exists ? `read (${set} section(s) set)` : "not created, defaults"}: ${clientConfigPath()}`, {
      level: cfg.config.logging.level,
      upload: cfg.config.logging.upload,
      region: cfg.config.update.region,
    });
    for (const p of cfg.problems.filter((x) => x.level === "error")) this.note("warn", "config", `config.json ${p.key || "file"}: ${p.message}`);
    this.upstream = readUpstreamCache()?.latest;
    void this.lookUpTools();
    await this.findSources();
    if (!this.sources.includes("hc") && !this.sources.includes("herdr")) {
      this.log("no herdr runtime found: start the herdr app (hc) or `herdr` first. Waiting anyway.");
    }
    if (this.sources.length < 3) {
      this.sourceTimer = setInterval(() => void this.findSources(), this.sourceRetryMs);
      this.sourceTimer.unref?.();
    }
    this.logTimer = setInterval(() => this.flushLogs(), this.logEveryMs);
    this.logTimer.unref?.();
    await this.startDirect();
    this.connect();
  }

  /**
   * Turns on every source that answers and is not on yet. The first time it logs the whole
   * list; later, only what came up, and the relay is told (a second hello updates the device).
   */
  async findSources(): Promise<void> {
    if (this.findingSources || this.stopped) return;
    this.findingSources = true;
    try {
      await this.probeSources();
    } finally {
      this.findingSources = false;
    }
    // All three on: nothing left to look for.
    if ((["hc", "herdr", "uniflo"] as const).every((s) => this.sources.includes(s)) && this.sourceTimer) {
      clearInterval(this.sourceTimer);
      this.sourceTimer = null;
    }
  }

  private async probeSources(): Promise<void> {
    const has = (s: AgentSource) => this.sources.includes(s);
    const [hc, herdr, uniflo] = await Promise.all([
      has("hc") ? false : this.hc.available(),
      has("herdr") ? false : this.herdr.available(),
      has("uniflo") ? false : this.uniflo.available(),
    ]);
    if (this.stopped) return;
    const added: string[] = [];
    if (hc) {
      this.sources.push("hc");
      this.hc.on("change", this.publish);
      this.hc.start();
      void this.refreshNames();
      this.namesTimer = setInterval(() => void this.refreshNames(), 15_000);
      added.push(`herdr GUI core (hc) ${this.hc.version ?? ""}`.trim());
    }
    if (herdr) {
      this.sources.push("herdr");
      this.herdr.on("change", this.publish);
      this.herdr.start();
      added.push("herdr TUI");
    }
    if (uniflo) {
      this.sources.push("uniflo");
      this.uniflo.start(this.publish);
      added.push("uniflo");
    }
    if (!this.sourcesLogged) {
      this.sourcesLogged = true;
      this.log(
        `sources: herdr GUI core (hc) ${has("hc") ? `✓ ${this.hc.version ?? ""}` : "✗"} · herdr TUI ${has("herdr") ? "✓" : "✗"} · uniflo ${has("uniflo") ? "✓" : "✗"}`,
      );
      return;
    }
    if (!added.length) return;
    this.log(`source came up: ${added.join(", ")}`);
    this.note("info", "sources", `came up after start: ${added.join(", ")}`);
    if (this.connected) this.hello();
    this.publish();
  }

  private hello(): void {
    this.send({
      type: "hello",
      version: PROTOCOL_VERSION,
      platform: platform(),
      sources: this.sources,
      appVersion: HOSTD_VERSION,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.namesTimer) clearInterval(this.namesTimer);
    if (this.sourceTimer) clearInterval(this.sourceTimer);
    if (this.logTimer) clearInterval(this.logTimer);
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.flushLogs();
    this.hc.stop();
    this.herdr.stop();
    this.uniflo.stop();
    this.direct.stop();
    for (const stop of this.streamStops.values()) stop();
    this.streamStops.clear();
    this.streamMeta.clear();
    this.streamReply.clear();
    this.ws?.close();
  }

  // -------------------------------------------------------------------------

  /** Re-reads the desktop app's space and tab names (a rename there does not always reach hc). */
  private async refreshNames(): Promise<void> {
    let names: AppNames;
    try {
      names = await this.app.names();
    } catch {
      return; // window closed: keep what we have, `where` labels cover the rest
    }
    const sig = JSON.stringify([[...names.spaces], [...names.tabs]]);
    if (sig === this.namesSig) return;
    this.namesSig = sig;
    this.names = names;
    this.publish();
  }

  collect(): Agent[] {
    const id = this.deviceId;
    const pids = new Map<string, number | undefined>();
    const hints = new Map<string, string>();
    const created = new Map<string, number>();
    const live = new Set<number>();
    const agents: Agent[] = [];
    for (const t of this.hc.terminals.values()) {
      const a = HcAdapter.toAgent(t, id, this.names);
      const pid = t.foreground?.pid;
      pids.set(a.key, pid);
      if (t.created_ms) created.set(a.key, t.created_ms);
      if (pid) live.add(pid);
      const hint = a.isShell ? undefined : this.sessionHints.key(harnessId(a.harness), t.foreground?.argv, pid);
      if (hint) hints.set(a.key, hint);
      agents.push(a);
    }
    this.sessionHints.prune(live);
    for (const info of this.herdr.agents) agents.push(HerdrAdapter.toAgent(info, id));
    return this.waits.decorate(this.uniflo.enrich(agents, pids, hints, created));
  }

  private publishNow(): void {
    this.agents = this.collect();
    if (this.modelOverrides.size) {
      const live = new Set(this.agents.map((a) => a.key));
      for (const k of this.modelOverrides.keys()) {
        if (!live.has(k)) this.modelOverrides.delete(k);
      }
    }
    const data = JSON.stringify(this.agents.map((a) => ({ ...a, updatedAt: 0 })));
    if (data === this.lastPublished) return;
    this.lastPublished = data;
    this.send({ type: "agents", agents: this.agents });
  }

  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    const { server, token } = this.opts.config;
    const url = `${server.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/ws`;
    // A handshake that never gets an answer must not wait forever either.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 15_000 });
    this.ws = ws;
    // The relay can vanish without a close (server restart behind a proxy, sleep, network
    // switch): a ping that goes unanswered for a whole interval drops the socket so it reconnects.
    let alive = true;
    const beat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        this.log("relay stopped answering, reconnecting");
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.heartbeatMs);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("open", () => {
      this.backoff = 1000;
      this.log(`connected to ${server}`);
      this.hello();
      this.lastPublished = "";
      this.publishNow();
      // What happened while the link was down goes up first.
      this.flushLogs();
    });
    ws.on("message", (data) => {
      alive = true;
      let f: ServerFrame;
      try {
        f = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return;
      }
      if (f.type === "welcome") this.deviceId = f.device.id;
      else if (f.type === "rpc") void this.handleRpc(f);
      else if (f.type === "stream_subscribe") void this.handleStreamSubscribe(f);
      else if (f.type === "stream_unsubscribe") this.stopStream(f.id);
      else if (f.type === "snapshot") {
        this.devices = new Map(f.devices.map((d) => [d.id, d]));
        this.remoteAgents = new Map();
        for (const a of f.agents) this.remoteAgents.set(a.deviceId, [...(this.remoteAgents.get(a.deviceId) ?? []), a]);
      } else if (f.type === "device") this.devices.set(f.device.id, f.device);
      else if (f.type === "device_removed") {
        this.devices.delete(f.id);
        this.remoteAgents.delete(f.id);
      } else if (f.type === "agents") this.remoteAgents.set(f.deviceId, f.agents);
      else if (f.type === "rpc_result") {
        const c = this.calls.get(f.id);
        if (!c) return;
        clearTimeout(c.timer);
        this.calls.delete(f.id);
        if (f.error) c.reject(new Error(`${f.error.code}: ${f.error.message}`));
        else c.resolve(f.result);
      }
      else if (f.type === "error") this.log(`relay error: ${f.error.message}`);
    });
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        this.log("relay rejected this computer's token (revoked?). Run `herdr-pocket login` again.");
        this.stopped = true;
      } else {
        this.log(`relay answered ${res.statusCode}`);
      }
      // With this listener attached, `ws` no longer aborts the handshake on its own: a 502 from
      // the proxy while the relay restarted left the socket connecting forever, never retrying.
      ws.terminate();
    });
    ws.on("close", (code) => {
      clearInterval(beat);
      if (this.ws !== ws) return;
      this.ws = null;
      // Streams of direct links do not need the relay.
      this.stopStreams((id) => !this.streamReply.has(id));
      if (code === 4001) {
        this.log("this computer was removed from the relay. Run `herdr-pocket login` to pair again.");
        this.stopped = true;
      }
      if (this.stopped) return;
      this.log(`disconnected, retrying in ${Math.round(this.backoff / 1000)}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.on("error", () => {});
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Calls a method on another computer through the relay. */
  call<M extends RpcMethod>(to: string, method: M, params: RpcMethods[M]["params"], timeoutMs = 35_000): Promise<RpcMethods[M]["result"]> {
    if (!this.connected) return Promise.reject(new Error("offline: not connected to the relay"));
    const id = `h${++this.callSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ type: "rpc", id, to, method, params });
    });
  }

  private send(f: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }

  // -------------------------------------------------------------------------

  private async handleRpc(f: Extract<ServerFrame, { type: "rpc" }>, reply: (x: ClientFrame) => void = (x) => this.send(x)): Promise<void> {
    try {
      const allow = this.opts.allow ?? [];
      if (allow.length && !allow.includes(f.from)) throw new RpcFailure("forbidden", "这台电脑没有授权给你");
      const handler = (this.handlers as Record<string, Handler<any> | undefined>)[f.method];
      if (!handler) throw new RpcFailure("unsupported", `unknown method ${f.method}`);
      const result = await handler((f.params ?? {}) as never, f.from);
      reply({ type: "rpc_result", id: f.id, result });
      if (MUTATING.has(f.method)) this.note("info", "rpc", `${f.method} from ${this.who(f.from)} ok`, callSummary(f.params, result));
    } catch (e) {
      const error: RpcError =
        e instanceof RpcFailure
          ? { code: e.code, message: e.message }
          : { code: "internal", message: e instanceof Error ? e.message : String(e) };
      reply({ type: "rpc_result", id: f.id, error });
      // Reads that find nothing are normal; anything else failing is worth a line.
      const quiet = error.code === "not_found" && !MUTATING.has(f.method);
      if (!quiet) this.note(error.code === "internal" ? "error" : "warn", "rpc", `${f.method} from ${this.who(f.from)} failed: ${error.code}: ${error.message}`, callSummary(f.params));
    }
  }

  private sendStream(id: string, event: unknown): void {
    const frame: ClientFrame = { type: "stream_event", id, event };
    const reply = this.streamReply.get(id);
    if (reply) reply(frame);
    else this.send(frame);
  }

  private async handleStreamSubscribe(f: Extract<ServerFrame, { type: "stream_subscribe" }>, reply?: (x: ClientFrame) => void): Promise<void> {
    const out = reply ?? ((x: ClientFrame) => this.send(x));
    const allow = this.opts.allow ?? [];
    if (allow.length && !allow.includes(f.from)) {
      out({ type: "stream_open", id: f.id, error: { code: "forbidden", message: "这台电脑没有授权给你" } });
      return;
    }
    const p = (f.params ?? {}) as Record<string, unknown>;
    const agentName = p.agent;
    try {
      const a = this.resolve(agentName);
      const prev = this.streamMeta.get(f.id);
      if (prev && prev.from !== f.from) throw new RpcFailure("bad_request", "重复的流 id");
      // The same viewer again (it reconnected through a relay that did not end the old one): the new one replaces it.
      if (prev) this.stopStream(f.id);
      const meta = { from: f.from, kind: f.stream, agent: a.key };
      this.streamMeta.set(f.id, meta);
      if (reply) this.streamReply.set(f.id, reply);
      if (f.stream === "terminal") {
        let stop: () => void = () => undefined;
        // `screen: false`: only queue notices (they go to every terminal stream of the agent).
        if (p.screen !== false) {
          const onError = (error: Error) => this.sendStream(f.id, { kind: "stale", message: error.message, at: Date.now() });
          const hcBacked = a.source === "hc" || (a.source === "herdr" && this.hc.terminals.has(a.localId));
          if (p.raw === true && hcBacked) {
            let seq = 0;
            const cols = typeof p.cols === "number" && Number.isFinite(p.cols) ? p.cols : 80;
            const rows = typeof p.rows === "number" && Number.isFinite(p.rows) ? p.rows : 24;
            const history = Math.min(Math.max(Number(p.history ?? 2000) || 2000, 0), 4000);
            const display = p.display && typeof p.display === "object" ? (p.display as TerminalDisplay) : undefined;
            stop = await this.hc.watchRaw(
              a.localId,
              { cols, rows, history, display },
              (chunk, curCols, curRows) => {
                const ev: TerminalDataEvent = {
                  kind: "terminal_data",
                  seq: ++seq,
                  data: chunk.toString("base64"),
                  cols: curCols,
                  rows: curRows,
                  at: Date.now(),
                };
                this.sendStream(f.id, ev);
              },
              onError,
            );
          } else {
            const paint = this.terminalPainter(f.id, p.rows === true);
            if (a.source === "hc") {
              const history = Math.min(Math.max(Number(p.history ?? 120) || 120, 0), 600);
              stop = await this.hc.watch(a.localId, history, paint, onError, { text: p.rows !== true });
            } else {
              let busy = false;
              const tick = async () => {
                if (busy) return;
                busy = true;
                try {
                  const r = a.source === "herdr" ? await this.herdr.read(a.localId, 400) : null;
                  if (r) paint({ lines: (r.ansi ?? r.text).split("\n"), text: r.text, cols: 0, rows: 0 });
                } catch (e) {
                  onError(e as Error);
                } finally {
                  busy = false;
                }
              };
              const timer = setInterval(() => void tick(), 500);
              void tick();
              stop = () => clearInterval(timer);
            }
          }
        }
        // Unsubscribed (or replaced) while the watch was starting.
        if (this.streamMeta.get(f.id) !== meta) {
          stop();
          return;
        }
        this.streamStops.set(f.id, stop);
        out({ type: "stream_open", id: f.id, result: { kind: "terminal", agent: a.key } });
        return;
      }
      const sessionKey = await this.sessionOf(a.key, p.sub);
      if (!sessionKey) throw new RpcFailure("not_found", "这个 agent 没有对话会话");
      if (this.streamMeta.get(f.id) !== meta) return; // unsubscribed while the session was looked up
      let stopped = false;
      const seen = new Map<string, string>();
      /** Event id -> `clock` when the live stream last sent it, so an older page read cannot undo it. */
      const liveAt = new Map<string, number>();
      let clock = 0;
      const forward = (e: ConvEvent, fromLive: boolean) => {
        const sig = JSON.stringify(e);
        if (fromLive) liveAt.set(e.id, ++clock);
        if (seen.get(e.id) === sig) return;
        seen.set(e.id, sig);
        if (seen.size > 2000) {
          const old = seen.keys().next().value!;
          seen.delete(old);
          liveAt.delete(old);
        }
        this.sendStream(f.id, { kind: "session", event: e, at: Date.now() });
      };
      let busy = false;
      let again = false;
      let failing = false;
      const tick = async () => {
        if (stopped) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        const at = clock;
        try {
          // The viewer loads the page itself; the stream only has to carry what is new.
          const r = await this.uniflo.events(sessionKey, 40);
          if (failing) {
            failing = false;
            this.sendStream(f.id, { kind: "alive", at: Date.now() });
          }
          for (const e of r.events) if ((liveAt.get(e.id) ?? 0) <= at) forward(e, false);
        } catch (e) {
          if (!failing) this.sendStream(f.id, { kind: "stale", message: (e as Error).message, at: Date.now() });
          failing = true;
        } finally {
          busy = false;
          if (again && !stopped) {
            again = false;
            void tick();
          }
        }
      };
      // Uniflo pushes each event as it indexes it; the page is read when it can't (too long to send as is,
      // the push link just came back) and, slowly, to recover. Without the push, the page is read 4 times a second.
      const offLive = this.uniflo.onEvents(sessionKey, (e) => {
        if (stopped) return;
        if (e) forward(e, true);
        else void tick();
      });
      let timer: NodeJS.Timeout | undefined;
      const poll = () => {
        timer = setTimeout(() => {
          void tick().finally(() => {
            if (!stopped) poll();
          });
        }, this.uniflo.live ? this.sessionPollLiveMs : this.sessionPollMs);
      };
      void tick();
      poll();
      this.streamStops.set(f.id, () => {
        stopped = true;
        clearTimeout(timer);
        offLive();
      });
      out({ type: "stream_open", id: f.id, result: { kind: "session", sessionKey } });
    } catch (e) {
      const error: RpcError = e instanceof RpcFailure ? { code: e.code, message: e.message } : { code: "internal", message: String(e) };
      this.streamMeta.delete(f.id);
      this.streamReply.delete(f.id);
      out({ type: "stream_open", id: f.id, error });
      if (error.code !== "not_found") this.note("warn", "stream", `${f.stream} stream for ${String(agentName)} failed: ${error.code}: ${error.message}`);
    }
  }

  /**
   * Sends a terminal's paints on stream `id`, unchanged ones skipped. `rows`:
   * as `terminal_rows` changes (only what moved or changed); else a whole
   * `terminal` screen each time, for apps before that.
   */
  private terminalPainter(id: string, rows: boolean): (paint: ScreenLines) => void {
    let last: string[] | null = null;
    let lastText: string | undefined;
    let seq = 0;
    return ({ lines, text, cols, rows: height }) => {
      if (!rows) {
        const same = last && text === lastText && last.length === lines.length && lines.every((l, i) => l === last![i]);
        if (same) return;
        last = lines;
        lastText = text;
        const screen = { ansi: lines.join("\n"), text: text ?? "", ...(cols ? { cols, rows: height } : {}) };
        this.sendStream(id, { kind: "terminal", screen, at: Date.now() });
        return;
      }
      const change = rowsChange(last, lines);
      if (!change) return;
      last = lines;
      const event: TerminalRowsEvent = { kind: "terminal_rows", seq: ++seq, cols, rows: height, ...change, at: Date.now() };
      this.sendStream(id, event);
    };
  }

  private stopStream(id: string): void {
    this.streamStops.get(id)?.();
    this.streamStops.delete(id);
    this.streamMeta.delete(id);
    this.streamReply.delete(id);
  }

  private queueEvent(agent: string, event: unknown): void {
    for (const [id, meta] of this.streamMeta) {
      if (meta.kind === "terminal" && meta.agent === agent) this.sendStream(id, { kind: "queue", ...event as Record<string, unknown>, at: Date.now() });
    }
  }

  private enqueueSend(a: Agent, text: string, enter: boolean): { id: string; position: number } {
    const id = `q${Date.now().toString(36)}${(++this.queueSeq).toString(36)}`;
    const q = this.sendQueues.get(a.key) ?? [];
    const position = q.length;
    q.push({ id, text, enter });
    this.sendQueues.set(a.key, q);
    this.queueEvent(a.key, { queueId: id, status: "queued", position });
    if (q.length === 1) void this.drainSendQueue(a);
    return { id, position };
  }

  private async drainSendQueue(a: Agent): Promise<void> {
    const q = this.sendQueues.get(a.key);
    if (!q) return;
    while (q.length) {
      const item = q[0]!;
      this.queueEvent(a.key, { queueId: item.id, status: "sending", position: 0 });
      try {
        if (a.source === "hc") await this.hc.send(a.localId, item.text, item.enter);
        else await this.herdr.send(a.localId, item.text, item.enter);
        this.queueEvent(a.key, { queueId: item.id, status: "sent", position: 0 });
      } catch (e) {
        this.queueEvent(a.key, { queueId: item.id, status: "failed", position: 0, message: (e as Error).message });
      }
      q.shift();
      for (let i = 0; i < q.length; i++) this.queueEvent(a.key, { queueId: q[i]!.id, status: "queued", position: i });
    }
    this.sendQueues.delete(a.key);
  }

  /** Checks every few seconds whether busy agents have taken what was typed into them. */
  private watchWaits(): void {
    if (this.waitTimer) return;
    let busy = false;
    this.waitTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const screen = async (a: Agent) =>
          a.source === "hc" && !this.sendQueues.has(a.key) ? (await this.hc.read(a.localId, 0)).text : undefined;
        if (await this.waits.settle(this.agents, async (key) => (await this.uniflo.events(key, 15)).events, Date.now(), screen)) this.publish();
      } finally {
        busy = false;
      }
      if (!this.waits.size && this.waitTimer) {
        clearInterval(this.waitTimer);
        this.waitTimer = null;
      }
    }, 3000);
    this.waitTimer.unref?.();
  }

  /** A caller's name for the log. */
  private who(from: string): string {
    return from === "relay" ? "assistant" : (this.devices.get(from)?.name ?? from);
  }

  /** Accepts a full agent key or a bare local id (t42) on this host. */
  private resolve(agent: unknown): Agent {
    if (typeof agent !== "string" || !agent) throw new RpcFailure("bad_request", "agent is required");
    const parsed = parseAgentKey(agent);
    if (parsed && parsed.deviceId !== this.deviceId) throw new RpcFailure("not_found", "这个 agent 不在这台电脑上");
    const found = this.agents.find((a) => (parsed ? a.key === agent : a.localId === agent));
    if (!found) throw new RpcFailure("not_found", "找不到这个 agent，可能已经关掉了");
    return found;
  }

  /**
   * Session to read for an agent: its own, or `sub` when that subagent session
   * really descends from it, so a viewer cannot read arbitrary sessions.
   */
  private async sessionOf(agent: unknown, sub: unknown): Promise<string | null> {
    const a = this.resolve(agent);
    if (!a.sessionKey) return null;
    if (sub === undefined || sub === null || sub === "") return a.sessionKey;
    if (typeof sub !== "string") throw new RpcFailure("bad_request", "sub must be a session key");
    let ok = false;
    try {
      ok = await this.uniflo.descends(sub, a.sessionKey);
    } catch {
      ok = false;
    }
    if (!ok) throw new RpcFailure("forbidden", "这个子会话不属于这个 agent");
    return sub;
  }

  /** Folders worth offering for a new agent: spaces', live agents', recent sessions'. */
  private suggestFolders(extra: Array<string | undefined>): string[] {
    const home = homedir();
    const seen = new Set<string>();
    const out: string[] = [];
    const recent = [...this.uniflo.sessions].sort((a, b) => b.updated_at - a.updated_at).map((s) => s.cwd);
    for (const f of [...extra, ...this.agents.map((a) => a.cwd), ...recent]) {
      if (!f || f === "/") continue;
      let abs: string;
      try {
        abs = checkFolder(f);
      } catch {
        continue;
      }
      if (abs === "/" || seen.has(abs)) continue;
      seen.add(abs);
      const label = shortHome(abs, home);
      if (label) out.push(label);
      if (out.length >= 16) break;
    }
    return out;
  }

  private writable(): void {
    if (this.opts.readOnly) throw new RpcFailure("forbidden", "这台电脑开了只读模式");
  }

  /**
   * Whole-computer session access (any session, not only a live agent's) is for
   * the assistant on the relay; phones and other computers keep `session.events`.
   */
  private assistantOnly(from: string): void {
    if (from !== "relay") throw new RpcFailure("forbidden", "只有助理可以查这台电脑的全部会话");
    if (!this.sources.includes("uniflo")) throw new RpcFailure("unsupported", "这台电脑没有运行 Uniflo，查不了会话记录");
  }

  /**
   * A new terminal through the desktop app; where there is none (herdr-core alone, as on
   * Windows or a server) one of hc's own, outside any space. `direct` says which it was.
   */
  private async newTerminal(
    viaApp: () => Promise<{ space: string; tab: string; terminal: string }>,
    argv: string[],
    folder: string | undefined,
  ): Promise<{ space: string; tab: string; terminal: string; direct: boolean }> {
    try {
      return { ...(await viaApp()), direct: false };
    } catch (e) {
      if (!(e instanceof NoDesktopApp)) throw new RpcFailure("unsupported", (e as Error).message);
    }
    try {
      const terminal = await this.hc.spawnTerminal(argv, folder ?? checkFolder("~"));
      this.note("info", "create", `no desktop herdr here: started ${argv[0] ? base(argv[0]) : "a shell"} as ${terminal} with hc run`);
      return { space: "", tab: "", terminal, direct: true };
    } catch (e) {
      throw new RpcFailure("unsupported", (e as Error).message);
    }
  }

  private needApp(): void {
    if (!this.sources.includes("hc")) throw new RpcFailure("unsupported", "这台电脑没有装桌面 herdr");
  }

  /** The file view's own refusals keep their code; anything else is an internal error. */
  private async files<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FilesError) throw new RpcFailure(e.code, e.message);
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new RpcFailure("not_found", "没有这个文件或目录");
      if (code === "EACCES" || code === "EPERM") throw new RpcFailure("forbidden", "没有权限读它");
      throw e;
    }
  }

  /** herdr's and Uniflo's versions for host.info (hc's comes with its adapter). Missing programs stay out. */
  private async lookUpTools(): Promise<void> {
    // By full path, the way the person's terminal finds them: launchd's PATH has no ~/.cargo/bin (uniflo).
    const bins = await findPrograms(["herdr", "uniflo"]);
    this.toolBins = { ...(bins.get("herdr") ? { herdr: bins.get("herdr") } : {}), ...(bins.get("uniflo") ? { uniflo: bins.get("uniflo") } : {}) };
    const version = async (bin: string | undefined) => {
      if (!bin) return undefined;
      try {
        return (await run(bin, ["--version"], { timeoutMs: 5000 })).trim().split(/\s+/).pop() || undefined;
      } catch {
        return undefined;
      }
    };
    const [herdr, uniflo, app] = await Promise.all([version(this.toolBins.herdr), version(this.toolBins.uniflo), herdrAppVersion()]);
    this.toolVersions = { ...(herdr ? { herdr } : {}), ...(uniflo ? { uniflo } : {}), ...(app ? { app } : {}) };
    this.note("info", "hostd", `tools: herdr ${herdr ?? "-"} · hc ${this.hc.version ?? "-"} · uniflo ${uniflo ?? "-"} · Herdr app ${app ?? "-"}`, this.toolVersions);
  }

  /** host.info `tools`, and the daemon's state for `herdr-pocket status`. */
  tools(): HostTools {
    return { ...this.toolVersions, ...(this.hc.version ? { hc: this.hc.version } : {}), ...(this.upstream ? { latest: this.upstream } : {}) };
  }

  /**
   * One upstream check (see upstream.ts): the running core's version and generation, the Herdr
   * app's version, then the release server and Uniflo. Logged as one `update` line; the answers
   * go to `<state>/upstream.json`. Report only.
   */
  async checkUpstream(deps?: UpstreamDeps & { cachePath?: string; appVersion?: () => Promise<string | undefined> }): Promise<void> {
    const hello = this.hc.version ? await this.hc.hello() : undefined;
    const app = await (deps?.appVersion ?? herdrAppVersion)();
    if (app) this.toolVersions.app = app;
    else delete this.toolVersions.app;
    const r = await checkUpstream(
      { hc: this.hc.version, hcGeneration: hello?.generation, app, uniflo: this.toolVersions.uniflo, unifloBin: this.toolBins.uniflo },
      this.upstream,
      deps,
    );
    if (r.uniflo?.current) this.toolVersions.uniflo = r.uniflo.current;
    this.upstream = r.latest;
    const { latest, ...have } = this.tools();
    writeUpstreamCache({ latest: latest ?? {}, have }, deps?.cachePath);
    this.note(r.level, "update", r.message, { ...r.latest, ms: r.ms, asked: r.asked, answered: r.answered, ...(r.uniflo?.method ? { unifloMethod: r.uniflo.method } : {}), ...(hello?.generation !== undefined ? { hcGeneration: hello.generation } : {}) });
  }

  private async installed(): Promise<string[]> {
    return (await this.launchers).map((l) => l.id);
  }

  private handlers: { [M in RpcMethod]: Handler<M> } = {
    "agents.list": async (p) => {
      this.agents = this.collect();
      return { agents: p.includeShells === false ? this.agents.filter((a) => !a.isShell) : this.agents };
    },
    "terminal.read": async (p) => {
      const a = this.resolve(p.agent);
      const lines = Math.min(Math.max(Number(p.lines ?? 200) || 200, 0), 2000);
      return a.source === "hc" ? this.hc.read(a.localId, lines) : this.herdr.read(a.localId, lines);
    },
    "terminal.send": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (typeof p.text !== "string" || p.text.length > 20_000) throw new RpcFailure("bad_request", "text is required");
      const status = a.status;
      const queued = this.enqueueSend(a, p.text, p.enter !== false);
      // In a turn, the program keeps typed text in its input box until the turn ends.
      const waiting = p.enter !== false && status === "working";
      if (waiting) {
        this.waits.add(a.key, queued.id, p.text, Date.now());
        this.watchWaits();
        this.publish();
      }
      return { ok: true as const, queueId: queued.id, position: queued.position, agentStatus: status, waiting };
    },
    "terminal.keys": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (!Array.isArray(p.keys) || !p.keys.length || p.keys.length > 32 || !p.keys.every((k) => typeof k === "string"))
        throw new RpcFailure("bad_request", "keys must be a non-empty list");
      if (a.source === "hc") await this.hc.keys(a.localId, p.keys);
      else await this.herdr.keys(a.localId, p.keys);
      return { ok: true as const };
    },
    "terminal.input": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (typeof p.data !== "string" || !p.data || p.data.length > 262_144) throw new RpcFailure("bad_request", "data is required");
      if (a.source === "hc" || (a.source === "herdr" && this.hc.terminals.has(a.localId))) {
        await this.hc.input(a.localId, p.data);
        return { ok: true as const };
      }
      if (a.source === "herdr" && (p.data === "\x1b[13;2u" || p.data === "\x1b[27;2;13~" || p.data === "\x1b\r")) {
        await this.herdr.keys(a.localId, ["shift+enter"]);
        return { ok: true as const };
      }
      throw new RpcFailure("unsupported", "这个 agent 不是桌面 herdr 开的，只能用输入框发送");
    },
    "terminal.resize": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      const cols = Number(p.cols);
      const rows = Number(p.rows);
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 10 || cols > 500 || rows < 2 || rows > 200) {
        throw new RpcFailure("bad_request", "cols and rows must be valid terminal dimensions");
      }
      if (a.source === "hc" || (a.source === "herdr" && this.hc.terminals.has(a.localId))) {
        const display = p.display && typeof p.display === "object" ? p.display : undefined;
        await this.hc.resize(a.localId, Math.round(cols), Math.round(rows), display);
      }
      return { ok: true as const };
    },
    "terminal.put": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      let files: CheckedFile[];
      try {
        files = checkFiles(p.files);
      } catch (e) {
        throw new RpcFailure("bad_request", (e as Error).message);
      }
      try {
        // hc keeps its own copy beside the terminal; the herdr terminal app has no such place, so this computer keeps one.
        const paths = a.source === "hc" ? await putThrough(files, (file) => this.hc.put(a.localId, file)) : await putLocal(files, a.localId, this.filesDir);
        return { paths };
      } catch (e) {
        const msg = (e as Error).message;
        if (/unrecognized subcommand|unknown command/i.test(msg)) throw new RpcFailure("unsupported", "这台电脑的 herdr 太旧，还不能收图片（没有 hc put），更新 herdr 后再试");
        throw new RpcFailure("internal", `图片没能放到这台电脑上：${msg}`);
      }
    },
    "session.events": async (p) => {
      const key = await this.sessionOf(p.agent, p.sub);
      if (!key) return { sessionKey: null, events: [], more: false, nextBefore: null };
      const r = await this.uniflo.events(key, p.limit ?? 80, p.before);
      return { sessionKey: key, events: r.events, more: r.more, nextBefore: r.nextBefore };
    },
    "direct.offer": async (_p, from) => {
      if (!this.direct.port) throw new RpcFailure("unsupported", "这台电脑没有开直连");
      return this.direct.offer(from);
    },
    "session.children": async (p) => {
      const key = await this.sessionOf(p.agent, p.sub);
      return { sessions: key ? await this.uniflo.children(key) : [] };
    },
    "spaces.list": async () => {
      const launchers = await this.launchers;
      let spaces: Awaited<ReturnType<HerdrApp["spaces"]>> = [];
      let reason: string | undefined;
      let standalone = false;
      if (this.opts.readOnly) reason = "这台电脑开了只读模式";
      else if (!this.sources.includes("hc")) reason = "这台电脑没有装桌面 herdr";
      else if (this.hc.terminals.size === 0) await this.hc.list().catch(() => undefined);
      try {
        spaces = await this.app.spaces(this.hc.terminals);
      } catch (e) {
        // Without the desktop app (Windows, servers) new agents get terminals of their own.
        if (e instanceof NoDesktopApp) standalone = true;
        else {
          reason ??= "桌面 herdr 没有打开，先在电脑上打开它";
          spaces = this.app.spacesFromDocs(this.hc.terminals);
        }
      }
      for (const s of spaces) {
        if (s.folder) this.spaceFolders.set(s.id, s.folder);
      }
      return {
        spaces,
        launchers,
        folders: this.suggestFolders(spaces.map((x) => x.folder)),
        canCreate: !reason,
        reason,
        typesTask: true,
        ...(standalone ? { standalone } : {}),
      };
    },
    "agent.create": async (p) => {
      this.writable();
      if (!this.sources.includes("hc")) throw new RpcFailure("unsupported", "这台电脑没有装桌面 herdr");
      const launcher = typeof p.launcher === "string" ? (await this.launchers).find((l) => l.id === p.launcher) : undefined;
      if (!launcher) throw new RpcFailure("bad_request", "这台电脑上没有这个程序");
      const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
      let folder: string | undefined;
      try {
        folder = p.folder === undefined || p.folder === "" ? undefined : checkFolder(p.folder);
      } catch (e) {
        throw new RpcFailure("bad_request", (e as Error).message);
      }
      if (!p.space && !folder) folder = checkFolder("~");
      else if (p.space && !folder) {
        let spaceFolder = this.spaceFolders.get(p.space);
        if (!spaceFolder) {
          const list = await this.app.spaces(this.hc.terminals).catch(() => []);
          for (const s of list) {
            if (s.folder) this.spaceFolders.set(s.id, s.folder);
          }
          spaceFolder = this.spaceFolders.get(p.space);
        }
        if (spaceFolder) {
          try {
            folder = checkFolder(spaceFolder);
          } catch {
            /* ignore if directory no longer exists */
          }
        }
      }
      const task = str(p.task, 20_000);
      const r = await this.newTerminal(
        () =>
          this.app.create({
            space: str(p.space, 100),
            spaceName: str(p.spaceName, 60),
            tabName: str(p.tabName, 60),
            folder,
            launcher: launcher.id,
            // Only programs that take it on their command line get it at start; the others have it typed in below.
            task: launcher.takesTask ? task : undefined,
          }),
        launcherArgv(launcher.id),
        folder,
      );
      await Promise.all([this.hc.list(), this.refreshNames()]);
      this.publishNow();
      const made = { agent: agentKey(this.deviceId, "hc", r.terminal), space: r.space, terminal: r.terminal };
      if (!task) return made;
      // `hc run` starts the bare program: the task is typed in like for any other.
      if (launcher.takesTask && !r.direct) return { ...made, task: "started" as const };
      if (launcher.id === "shell") return { ...made, task: "failed" as const, taskNote: "终端不接任务" };
      const typed = await typeFirstTask(
        task,
        {
          terminal: async () => {
            if (!this.hc.terminals.has(r.terminal)) await this.hc.list().catch(() => undefined);
            return this.hc.terminals.get(r.terminal);
          },
          screen: async () => (await this.hc.read(r.terminal, 0)).text,
          type: (text) => this.hc.send(r.terminal, text),
          now: () => Date.now(),
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
        },
        this.firstTaskOptions,
      );
      this.note(typed.ok ? "info" : "warn", "create", typed.ok ? `first task typed into ${launcher.id} ${r.terminal} after ${typed.waitedMs}ms (${typed.how})` : `first task for ${launcher.id} ${r.terminal} not typed after ${typed.waitedMs}ms: ${typed.reason}`, {
        task: clipChars(task, 200),
      });
      return typed.ok ? { ...made, task: "typed" as const } : { ...made, task: "failed" as const, taskNote: typed.reason };
    },
    "host.info": async () => ({
      name: this.opts.config.name || hostname(),
      platform: platform(),
      sources: this.sources,
      version: HOSTD_VERSION,
      hcVersion: this.hc.version,
      tools: this.tools(),
      files: true,
    }),
    "files.list": async (p) => {
      const a = this.resolve(p.agent);
      const t0 = Date.now();
      const r = await this.files(() => listFiles(a.cwd, p, { privateDirs: this.privateDirs }));
      this.note("debug", "files", `files.list ${a.localId} "${r.path || "."}" ${r.entries.length}${r.truncated ? "+" : ""} entries ${Date.now() - t0}ms`, { agent: a.key });
      return r;
    },
    "files.read": async (p) => {
      const a = this.resolve(p.agent);
      const t0 = Date.now();
      const extraRoots = [this.filesDir, homedir(), tmpdir(), "/tmp"];
      const privateDirs = [
        ...this.privateDirs,
        join(homedir(), ".agents", "crosery", "credentials"),
        join(homedir(), "Library", "Keychains"),
      ];
      const r = await this.files(() => readFileSlice(a.cwd, p, { privateDirs, extraRoots }));
      this.note("debug", "files", `files.read ${a.localId} "${r.path}" ${r.bytes}/${r.size} bytes${r.binary ? " binary" : ""} ${Date.now() - t0}ms`, { agent: a.key });
      return r;
    },
    "folders.list": async (p) => {
      const hidden = Boolean(p?.hidden);
      return this.files(() => listFolders(p?.path, hidden, { privateDirs: this.privateDirs }));
    },
    "agent.commands": async (p) => {
      const a = this.resolve(p.agent);
      const commands = a.isShell ? [] : await scanAgentSlashCommands(a.harness, a.cwd);
      return { harness: a.harness, commands };
    },
    "agent.usage": async (p) => {
      const a = this.resolve(p.agent);
      const key = (await this.sessionOf(p.agent, undefined).catch(() => null)) ?? a.sessionKey;
      return getAgentUsageReport(a, {
        uniflo: this.uniflo,
        unifloReady: this.sources.includes("uniflo"),
        sessionKey: key ?? undefined,
      });
    },
    "agent.models": async (p) => {
      const a = this.resolve(p.agent);
      const ov = this.modelOverrides.get(a.key);
      return getAgentModels(a, {
        uniflo: this.uniflo,
        unifloReady: this.sources.includes("uniflo"),
        currentModelOverride: ov?.model,
        currentThinkingOverride: ov?.thinking,
      });
    },
    "agent.setModel": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      const res = await setAgentModelAndThinking(
        a,
        { modelId: p.modelId, thinkingLevel: p.thinkingLevel },
        { hc: this.hc, herdr: this.herdr },
      );
      const prev = this.modelOverrides.get(a.key) ?? {};
      const next = {
        ...(res.currentModel ?? prev.model ? { model: res.currentModel ?? prev.model } : {}),
        ...(res.currentThinking ?? prev.thinking ? { thinking: res.currentThinking ?? prev.thinking } : {}),
      };
      if (next.model || next.thinking) this.modelOverrides.set(a.key, next);
      return { ok: true as const, ...res };
    },
    "space.delete": async (p) => {
      this.writable();
      if (this.hc.terminals.size === 0) await this.hc.list().catch(() => undefined);
      const res = await this.app.deleteSpace(
        { spaceId: p.spaceId, spaceName: p.spaceName },
        this.hc,
        { names: this.names, herdr: this.herdr },
      );
      await Promise.all([this.hc.list().catch(() => undefined), this.refreshNames().catch(() => undefined)]);
      this.publishNow();
      return { ok: true as const, closedTerminals: res.closedTerminals };
    },
    "git.status": async (p) => {
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      return this.files(() => getGitStatus(dir, this.privateDirs));
    },
    "git.diff": async (p) => {
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      return this.files(() => getGitDiff(dir, p, this.privateDirs));
    },
    "git.log": async (p) => {
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      return { commits: await this.files(() => getGitLog(dir, p.limit, this.privateDirs)) };
    },
    "git.stage": async (p) => {
      this.writable();
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      await this.files(() => gitStage(dir, p, this.privateDirs));
      return { ok: true as const };
    },
    "git.unstage": async (p) => {
      this.writable();
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      await this.files(() => gitUnstage(dir, p, this.privateDirs));
      return { ok: true as const };
    },
    "git.discard": async (p) => {
      this.writable();
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      await this.files(() => gitDiscard(dir, p, this.privateDirs));
      return { ok: true as const };
    },
    "git.commit": async (p) => {
      this.writable();
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      return this.files(() => gitCommit(dir, p.message, this.privateDirs));
    },
    "git.checkout": async (p) => {
      this.writable();
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      return this.files(() => gitCheckout(dir, p, this.privateDirs));
    },
    "git.pull": async (p) => {
      this.writable();
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      return this.files(() => gitPull(dir, this.privateDirs));
    },
    "git.push": async (p) => {
      this.writable();
      const dir = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : p.agent ? this.resolve(p.agent).cwd : undefined;
      return this.files(() => gitPush(dir, this.privateDirs));
    },
    "agent.seen": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      const t = a.source === "hc" ? this.hc.terminals.get(a.localId) : undefined;
      // Same mark the desktop app leaves when the person looks at a finished turn.
      if (t && typeof t.turn === "number" && HcAdapter.status(t) === "done") {
        await this.hc.label(a.localId, { "herdr.seen": String(t.turn) });
        await this.hc.list();
      }
      return { ok: true as const };
    },
    "terminal.interrupt": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (a.source !== "hc") {
        await this.herdr.keys(a.localId, ["esc"]);
        return { ok: true as const };
      }
      return { ok: true as const, report: await this.hc.interrupt(a.localId) };
    },
    "terminal.kill": async (p) => {
      this.writable();
      const a = this.resolve(p.agent);
      if (a.source !== "hc") throw new RpcFailure("unsupported", "这个 agent 不是桌面 herdr 开的，从这里关不了");
      await this.hc.kill(a.localId);
      await this.hc.list();
      return { ok: true as const };
    },
    "herdr.layout": async () => {
      this.needApp();
      let ls: Awaited<ReturnType<HerdrApp["ls"]>>;
      try {
        ls = await this.app.ls();
      } catch {
        throw new RpcFailure("unsupported", "桌面 herdr 没有打开，先在电脑上打开它");
      }
      this.agents = this.collect();
      const byLocal = new Map(this.agents.filter((a) => a.source === "hc").map((a) => [a.localId, a]));
      const spaces: LayoutSpace[] = ls.spaces
        .filter((s) => !s.machine)
        .map((s) => ({
          id: s.id,
          name: s.name,
          folder: resolveSpaceFolder(s, this.hc.terminals),
          active: !!s.active,
          tabs: (s.tabs ?? []).map((t) => ({
            id: t.id ?? "",
            name: t.name ?? "",
            active: !!t.active,
            settled: !!t.settled,
            terminals: (t.terminals ?? [])
              .filter((x) => typeof x.terminal === "string")
              .map((x) => {
                const a = byLocal.get(x.terminal!);
                return { terminal: x.terminal!, pane: x.pane ?? undefined, agent: a?.key, title: a?.title ?? x.name ?? undefined, harness: a?.harness ?? x.app ?? undefined, status: a?.status };
              }),
          })),
        }));
      return { spaces };
    },
    "herdr.command": async (p) => {
      this.writable();
      this.needApp();
      const args: Record<string, unknown> = { ...(p.args ?? {}) };
      // An agent key is as good as its terminal address.
      if (typeof args.terminal === "string" && args.terminal.includes("/")) args.terminal = this.resolve(args.terminal).localId;
      let checked: ReturnType<typeof herdrCommandArgs>;
      try {
        checked = herdrCommandArgs(p.command, args, await this.installed());
      } catch (e) {
        throw new RpcFailure("bad_request", (e as Error).message);
      }
      let result: unknown;
      try {
        result = await this.app.command(checked.command, checked.args);
      } catch (e) {
        throw new RpcFailure("unsupported", (e as Error).message);
      }
      await Promise.all([this.hc.list(), this.refreshNames()]);
      return { ok: true as const, result: result ?? undefined };
    },
    "sessions.list": async (p, from) => {
      this.assistantOnly(from);
      const limit = Math.min(Math.max(Number(p.limit ?? 15) || 15, 1), 50);
      const sessions = await this.uniflo.list(typeof p.q === "string" ? p.q.slice(0, 300) : undefined, limit);
      const live = new Map(this.agents.filter((a) => a.sessionKey).map((a) => [a.sessionKey!, a.key]));
      return { sessions: sessions.map((s) => ({ ...s, agent: live.get(s.key) })) };
    },
    "sessions.search": async (p, from) => {
      this.assistantOnly(from);
      if (typeof p.q !== "string" || !p.q.trim()) throw new RpcFailure("bad_request", "要搜什么");
      return this.uniflo.search(p.q.trim().slice(0, 300), Math.min(Math.max(Number(p.limit ?? 8) || 8, 1), 20));
    },
    "sessions.read": async (p, from) => {
      this.assistantOnly(from);
      if (typeof p.session !== "string" || !p.session) throw new RpcFailure("bad_request", "session is required");
      let session: Awaited<ReturnType<UnifloAdapter["info"]>>;
      try {
        session = await this.uniflo.info(p.session);
      } catch {
        throw new RpcFailure("not_found", "这台电脑上没有这个会话");
      }
      const r = await this.uniflo.events(p.session, p.limit ?? 40, p.before);
      return { session: { ...session, agent: this.agents.find((a) => a.sessionKey === session.key)?.key }, events: r.events, more: r.more, nextBefore: r.nextBefore };
    },
    "harness.icons": async (p) => {
      if (!Array.isArray(p.ids) || !p.ids.every((id) => typeof id === "string")) throw new RpcFailure("bad_request", "ids must be a list");
      return { icons: await this.uniflo.icons(p.ids.slice(0, HARNESS_ICON_MAX)) };
    },
    "sessions.usage": async (p, from) => {
      this.assistantOnly(from);
      const groupBy = p.groupBy && ["harness", "model", "cwd", "day", "session"].includes(p.groupBy) ? p.groupBy : "harness";
      return this.uniflo.usage(typeof p.since === "string" ? p.since.slice(0, 40) : undefined, groupBy);
    },
    "sessions.resume": async (p, from) => {
      this.assistantOnly(from);
      this.writable();
      this.needApp();
      if (typeof p.session !== "string" || !p.session) throw new RpcFailure("bad_request", "session is required");
      this.agents = this.collect();
      const open = this.agents.find((a) => a.sessionKey === p.session);
      if (open) throw new RpcFailure("bad_request", `这个会话正在「${open.title ?? open.localId}」里开着，不用再开一个`);
      let argv: string[];
      let folder: string | undefined;
      try {
        const r = await this.uniflo.resume(p.session);
        if (!r.supported) throw new Error("这个程序的会话不支持续跑");
        argv = resumeArgv(r.argv, await this.installed());
        folder = r.cwd ? checkFolder(r.cwd) : undefined;
      } catch (e) {
        throw new RpcFailure("unsupported", (e as Error).message);
      }
      const space = typeof p.space === "string" && p.space ? p.space.slice(0, 100) : undefined;
      const r = await this.newTerminal(() => this.app.open({ space, folder, argv }), withProgramPath(argv), folder);
      await Promise.all([this.hc.list(), this.refreshNames()]);
      return { agent: agentKey(this.deviceId, "hc", r.terminal), space: r.space, terminal: r.terminal };
    },
  };
}
