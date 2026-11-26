import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  Agent,
  HostPortalCapabilities,
  PortalEgoSpaceState,
  PortalFileTicket,
  PortalFramePayload,
  PortalInputAction,
  PortalItem,
  PortalKind,
  PortalStreamEvent,
  RemoteWindowInfo,
} from "@herdr-pocket/protocol";
import { stateDir } from "@herdr-pocket/update";
import { CdpBrowserPool } from "./cdpBrowser.ts";
import {
  defaultQueryEgoTaskSpaces,
  ownershipToEgoPhase,
  selectMatchingEgoSpaceWindow,
  type EgoTaskSpaceEntry,
} from "./egoSpace.ts";
import { OsCaptureDriver, computeCapabilities, type OsCaptureDeps } from "./osCapture.ts";
import { PortalFileTicketStore, bundleHtmlForRelay, listDirectoryForPortal, mimeForFilename, readChunkForRpc } from "./p2pFiles.ts";
import {
  PortalHookServer,
  TerminalInputLineTracker,
  classifyTarget,
  ensurePortalShims,
  extractAutoPortalIntents,
  parseEgoScreenSnapshot,
  parseOpenerArgs,
  type AutoPortalIntent,
  type EgoScreenSnapshot,
  type HookOpenPayload,
} from "./shims.ts";
import type { FilesOptions } from "../files.ts";

export interface PortalManagerDeps {
  hostId: () => string;
  getAgents: () => Agent[];
  getTerminals: () => Map<string, { address: string; cwd?: string | null; pid?: number; foreground?: { pid?: number; argv?: string[] } | null }>;
  getFilesOptions: (agentCwd?: string) => FilesOptions;
  getDirectInfo: () => { port: number | null; addrs: string[]; connectedCount: number };
  hasRemoteViewers: () => boolean;
  onPortalEvent: (event: PortalStreamEvent) => void;
  captureDeps?: OsCaptureDeps;
  queryEgoTaskSpaces?: (serverName?: string) => Promise<EgoTaskSpaceEntry[]>;
  stateDir?: string;
}

const MAX_PORTAL_ITEMS = 40;
const AUTO_DEDUP_MS = 4000;
const PENDING_WINDOW_INTENT_TTL_MS = 8000;
const EGO_SPACE_SYNC_MS = 2500;
const SCREEN_FOREGROUND_THROTTLE_MS = 8000;
const PROCESS_TREE_MAX_HOPS = 14;
const XSERVER_APP_RE = /\b(?:vcxsrv|x410|xming|xwin|mobaxterm|msrdc|wslg)\b/i;
const BROWSER_WINDOW_HINTS = ["ego lite", "google chrome", "safari", "tabbit", "arc", "microsoft edge", "brave browser", "firefox", "chromium"];
const TERMINAL_APP_NAMES = new Set(["herdr", "herdr pocket", "ghostty", "iterm2", "terminal", "终端", "wezterm", "alacritty", "kitty", "warp", "windowsterminal", "conhost", "cmd", "powershell", "pwsh"]);
const INLINE_FILE_EXT_RE = /\.(?:html?|png|jpe?g|webp|gif|svg|bmp|ico|avif|pdf|mp4|webm|mov|mp3|wav|m4a|ogg|aac|flac|csv|tsv|json|jsonl|docx?|xlsx?|pptx?|odt|ods|rtf|md|txt|ts|tsx|js|jsx|py|rs|go|css|yml|yaml|toml|sh|log)$/i;
const APP_ALIASES: Record<string, string[]> = {
  "ego lite": ["ego lite", "ego"],
  chrome: ["google chrome", "chrome", "chromium"],
  "google chrome": ["google chrome", "chrome", "chromium"],
  finder: ["访达", "finder"],
  "访达": ["访达", "finder"],
  preview: ["预览", "preview"],
  "预览": ["预览", "preview"],
  tabbit: ["tabbit"],
  safari: ["safari"],
  x11: ["vcxsrv", "x410", "xming", "xwin", "mobaxterm", "msrdc", "wslg", "x11", "xeyes", "xclock", "xcalc"],
};

interface PendingWindowIntent {
  agentKey: string;
  expiresAt: number;
  appHints: string[];
  titleHint?: string;
  urlHint?: string;
  isWsl?: boolean;
}

interface AgentEgoSpaceBinding {
  agentKey: string;
  serverName?: string;
  spaceId?: number;
  spaceName?: string;
  pageLabel?: string;
  screenPageTitle?: string;
  url?: string;
  lastAction?: string;
  handoffHint?: boolean;
  beforeSpaceIds?: Set<number>;
  confirmedInEgoLite?: boolean;
  portalId?: string;
  updatedAt: number;
}

function expandAppHints(hints: string[]): string[] {
  return hints.flatMap((h) => {
    const lower = h.trim().toLowerCase();
    return APP_ALIASES[lower] ?? (lower ? [lower] : []);
  });
}

function titleMatchesHint(w: RemoteWindowInfo, hint?: string): boolean {
  const clean = hint?.trim().toLowerCase();
  if (!clean) return false;
  const app = w.appName.toLowerCase();
  const title = w.title.toLowerCase();
  if (app.includes(clean) || title.includes(clean)) return true;
  const dot = clean.lastIndexOf(".");
  if (dot > 2) {
    const stem = clean.slice(0, dot);
    if (stem.length >= 3 && (title.includes(stem) || app.includes(stem))) return true;
  }
  return false;
}

function buildEgoSubtitle(egoSpace: PortalEgoSpaceState, url?: string): string {
  const phaseLabel =
    egoSpace.phase === "handoff"
      ? "等你接管"
      : egoSpace.phase === "user"
        ? "已移交"
        : egoSpace.phase === "idle"
          ? "空间就绪"
          : "AI 操作中";
  const parts = [phaseLabel];
  if (egoSpace.activeTabTitle) parts.push(egoSpace.activeTabTitle);
  else if (url) parts.push(url);
  if (egoSpace.lastAction) parts.push(egoSpace.lastAction);
  return parts.join(" · ");
}

function delayMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function frameFingerprint(frame: PortalFramePayload): string {
  const byteLen = frame.rawBytes?.byteLength ?? frame.data.length;
  let head = "";
  let mid = "";
  let tail = "";
  if (frame.data) {
    const m = frame.data.length >> 1;
    head = frame.data.slice(0, 32);
    mid = frame.data.slice(m, m + 32);
    tail = frame.data.slice(-32);
  } else if (frame.rawBytes && frame.rawBytes.byteLength > 0) {
    const rb = frame.rawBytes;
    const m = rb.byteLength >> 1;
    const toHex = (s: number, e: number) =>
      Buffer.from(rb.buffer, rb.byteOffset + s, Math.max(0, e - s)).toString("hex");
    head = toHex(0, Math.min(24, rb.byteLength));
    mid = toHex(m, Math.min(m + 24, rb.byteLength));
    tail = toHex(Math.max(0, rb.byteLength - 24), rb.byteLength);
  }
  return `${frame.width}x${frame.height}:${byteLen}:${head}:${mid}:${tail}:${frame.cursorX?.toFixed(3) ?? ""}:${frame.cursorY?.toFixed(3) ?? ""}:${frame.cursorVisible ? 1 : 0}:${frame.url ?? ""}`;
}

interface PortalWatcher {
  portalId?: string;
  agentKey?: string;
  send: (ev: PortalStreamEvent) => void;
  timer?: NodeJS.Timeout;
  heartbeatTimer?: NodeJS.Timeout;
  offBrowser?: () => void;
  fps: number;
  maxWidth: number;
  quality: number;
  showCursor: boolean;
  binaryFrames?: boolean;
  lastNativeSeq?: string;
  lastHash?: string;
  lastSentAt?: number;
  hasAck?: boolean;
  lastSentSeq: number;
  lastAckedSeq: number;
  sentAtBySeq: Map<number, number>;
  rttEwmaMs: number;
  effectiveQuality: number;
  effectiveMaxWidth: number;
  slowStreak: number;
  fastStreak: number;
}

export class PortalManager {
  private deps: PortalManagerDeps;
  readonly tickets = new PortalFileTicketStore();
  readonly browser: CdpBrowserPool;
  readonly capture: OsCaptureDriver;
  private hookServer: PortalHookServer | null = null;
  private items = new Map<string, PortalItem>();
  private itemSeq = 0;
  private windowSeq = 0;
  private shimsInfo: { shimsDir: string; browserShim: string; execWrapper?: string } | null = null;
  private seenOAuthUrls = new Set<string>();
  private inputTracker = new TerminalInputLineTracker();
  private recentAutoKeys = new Map<string, number>();
  private lastForegroundCheckAt = new Map<string, number>();
  private baselineWindowIds: Set<string> | null = null;
  private baselineFgPids = new Set<number>();
  private baselineInitPromise: Promise<void> | null = null;
  private autoWindowMeta = new Map<string, { portalId: string; windowId: string; openedAt: number; missCount: number }>();
  private lastTerminalFgPid = new Map<string, number>();
  private pendingWindowIntents = new Map<string, PendingWindowIntent[]>();
  private egoBindings = new Map<string, AgentEgoSpaceBinding>();
  private egoSyncTimer: NodeJS.Timeout | null = null;
  private egoSyncInFlight = new Map<string, Promise<PortalItem | null>>();
  private scanTimer: NodeJS.Timeout | null = null;
  private scanFollowupTimers: NodeJS.Timeout[] = [];
  private scanInFlight: Promise<void> | null = null;
  private lastScanAt = 0;
  private windowDeltaTimer: NodeJS.Timeout | null = null;
  private windowDeltaInFlight = false;
  private knownWindows = new Map<string, { appName: string; title: string }>();
  private windowBaselineSeeded = false;
  private browserReviving = new Map<string, Promise<void>>();
  private pokeTimers = new Map<string, NodeJS.Timeout>();
  private streamWatchers = new Map<string, PortalWatcher>();
  private inputMoveInFlight = new Set<string>();
  private inputMoveQueued = new Map<string, PortalInputAction>();
  private capsCache: { value: HostPortalCapabilities; at: number } | null = null;
  private capsInFlight: Promise<HostPortalCapabilities> | null = null;

  constructor(deps: PortalManagerDeps) {
    this.deps = deps;
    const sDir = deps.stateDir ?? stateDir();
    this.browser = new CdpBrowserPool(`${sDir}/portal-chrome`);
    this.capture = new OsCaptureDriver(deps.captureDeps);
  }

  async startHookAndShims(): Promise<{ shimsDir: string; browserShim: string; execWrapper?: string; port: number } | null> {
    if (this.hookServer) {
      return this.shimsInfo ? { ...this.shimsInfo, port: this.hookServer.port } : null;
    }
    const dir = this.deps.stateDir ?? stateDir();
    try {
      this.shimsInfo = ensurePortalShims(dir);
      const secret = randomBytes(24).toString("hex");
      this.hookServer = new PortalHookServer({
        dir,
        secret,
        onOpen: (payload) => this.handleHookOpen(payload),
      });
      const port = await this.hookServer.start();
      void this.ensureBaselineInitialized();
      this.ensureWindowDeltaWatcher();
      return { ...this.shimsInfo, port };
    } catch {
      return null;
    }
  }

  isHookRunning(): boolean {
    return Boolean(this.hookServer?.port);
  }

  hasActiveWatchers(): boolean {
    return this.streamWatchers.size > 0;
  }

  childEnv(terminalId?: string): Record<string, string> {
    const dir = this.deps.stateDir ?? stateDir();
    if (!this.shimsInfo) {
      try {
        this.shimsInfo = ensurePortalShims(dir);
      } catch {
        return {};
      }
    }
    const sep = process.platform === "win32" ? ";" : ":";
    const curPath = process.env.PATH ?? "";
    const out: Record<string, string> = {
      BROWSER: this.shimsInfo.browserShim,
      HERDR_POCKET_STATE: dir,
      PATH: curPath.startsWith(this.shimsInfo.shimsDir) ? curPath : `${this.shimsInfo.shimsDir}${sep}${curPath}`,
    };
    if (terminalId) out.HERDR_POCKET_TERMINAL = terminalId;
    return out;
  }

  stop(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.windowDeltaTimer) {
      clearInterval(this.windowDeltaTimer);
      this.windowDeltaTimer = null;
    }
    if (this.egoSyncTimer) {
      clearInterval(this.egoSyncTimer);
      this.egoSyncTimer = null;
    }
    for (const t of this.scanFollowupTimers) clearTimeout(t);
    this.scanFollowupTimers = [];
    for (const t of this.pokeTimers.values()) clearTimeout(t);
    this.pokeTimers.clear();
    this.autoWindowMeta.clear();
    this.pendingWindowIntents.clear();
    this.egoBindings.clear();
    this.egoSyncInFlight.clear();
    this.knownWindows.clear();
    this.windowBaselineSeeded = false;
    this.browserReviving.clear();
    for (const id of [...this.streamWatchers.keys()]) this.unsubscribe(id);
    this.inputMoveInFlight.clear();
    this.inputMoveQueued.clear();
    this.hookServer?.stop();
    this.hookServer = null;
    this.browser.closeAll();
    this.capture.dispose();
  }

  async fastCapabilities(): Promise<HostPortalCapabilities> {
    if (this.capsCache && Date.now() - this.capsCache.at < 60_000) {
      return this.capsCache.value;
    }
    const { port } = this.deps.getDirectInfo();
    return computeCapabilities({
      deps: this.deps.captureDeps,
      hasCdpBrowser: false,
      directPort: port,
    });
  }

  async capabilities(force = false): Promise<HostPortalCapabilities> {
    if (!force && this.capsCache && Date.now() - this.capsCache.at < 60_000) {
      return this.capsCache.value;
    }
    if (this.capsInFlight) return this.capsInFlight;
    const job = (async () => {
      const hasCdpBrowser = await this.browser.hasBrowser().catch(() => false);
      const { port } = this.deps.getDirectInfo();
      const caps = computeCapabilities({
        deps: this.deps.captureDeps,
        hasCdpBrowser,
        directPort: port,
      });
      const [permNote, inputPermissionNote] = await Promise.all([
        this.capture.checkPermissionNote().catch(() => null),
        this.capture.checkInputPermissionNote().catch(() => null),
      ]);
      const full: HostPortalCapabilities = {
        ...caps,
        ...(inputPermissionNote ? { inputPermissionNote } : {}),
        ...(permNote ? { notes: [...(caps.notes ?? []), permNote] } : {}),
      };
      this.capsCache = { value: full, at: Date.now() };
      return full;
    })().finally(() => {
      if (this.capsInFlight === job) this.capsInFlight = null;
    });
    this.capsInFlight = job;
    return job;
  }

  private resolveAgentForHook(payload: HookOpenPayload): Agent | undefined {
    const agents = this.deps.getAgents();
    if (payload.terminalId) {
      const hit = agents.find((a) => a.localId === payload.terminalId || a.key === payload.terminalId);
      if (hit) return hit;
    }
    if (payload.ppid && payload.ppid > 1) {
      const terms = this.deps.getTerminals();
      for (const [addr, t] of terms) {
        if (t.foreground?.pid === payload.ppid || t.pid === payload.ppid) {
          const hit = agents.find((a) => a.localId === addr);
          if (hit) return hit;
        }
      }
      // Best-effort parent PID walk on Unix (short)
      if (process.platform !== "win32") {
        let cur = payload.ppid;
        for (let depth = 0; depth < 8 && cur > 1; depth++) {
          for (const [addr, t] of terms) {
            if (t.foreground?.pid === cur || t.pid === cur) {
              const hit = agents.find((a) => a.localId === addr);
              if (hit) return hit;
            }
          }
          try {
            const p = execFileSync("ps", ["-o", "ppid=", "-p", String(cur)], { encoding: "utf8", timeout: 400 }).trim();
            const next = Number(p);
            if (!Number.isFinite(next) || next <= 1 || next === cur) break;
            cur = next;
          } catch {
            break;
          }
        }
      }
    }
    return undefined;
  }

  async handleHookOpen(payload: HookOpenPayload): Promise<{ handled: boolean; id?: string }> {
    const hasRemote = this.deps.hasRemoteViewers();
    const caps = await this.capabilities();
    const isHeadless = caps.sessionType === "headless";
    const forceHandled = payload.tool === "herdr-pocket-open" || payload.tool === "herdr-pocket-browser";
    if (!hasRemote && !isHeadless && !forceHandled) {
      // No remote viewer connected and host has its own desktop: let native OS opener handle it.
      return { handled: false };
    }

    const parsed =
      payload.target
        ? classifyTarget(payload.target, { reveal: payload.reveal, cwd: payload.cwd })
        : parseOpenerArgs(payload.tool, payload.argv, payload.cwd);
    if (!parsed) return { handled: false };

    const agent = this.resolveAgentForHook(payload);
    if (!agent) {
      // Strict per-terminal lineage: never open unattributed portals or leak across terminals.
      return { handled: false };
    }
    if (parsed.kind === "window" && parsed.app) {
      this.markAutoDedup(`${agent.key}\0win\0${parsed.app.toLowerCase()}`);
      this.recordPendingWindowIntent(agent.key, {
        appHints: expandAppHints([parsed.app]),
        titleHint: parsed.app,
        urlHint: parsed.url,
      });
      void this.detectAndOpenWindowPortal({
        agent,
        appHint: parsed.app,
        titleHint: parsed.app,
        urlHint: parsed.url,
      });
      return { handled: isHeadless || forceHandled };
    }

    this.markAutoDedup(`${agent.key}\0${parsed.kind}\0${parsed.url || parsed.target}`);
    const opened = await this.openPortal({
      agentKey: agent.key,
      kind: parsed.kind,
      target: parsed.target,
      url: parsed.url,
      reveal: parsed.reveal,
      title: parsed.app ? `${parsed.app} · ${basename(parsed.target)}` : undefined,
    });
    // Return handled:false on GUI hosts for native `open` shims so the real OS app/browser also launches locally.
    return { handled: isHeadless || forceHandled, id: opened.item.id };
  }

  private pruneItems(): void {
    while (this.items.size > MAX_PORTAL_ITEMS) {
      const oldest = this.items.keys().next().value;
      if (!oldest) break;
      const item = this.items.get(oldest)!;
      this.items.delete(oldest);
      this.browser.close(oldest);
      this.deps.onPortalEvent({ kind: "portal_event", action: "closed", item, at: Date.now() });
    }
  }

  private emitEvent(action: "opened" | "updated" | "closed", item: PortalItem): void {
    const ev: PortalStreamEvent = { kind: "portal_event", action, item, at: Date.now() };
    this.deps.onPortalEvent(ev);
    for (const w of this.streamWatchers.values()) {
      if (w.agentKey && item.agentKey !== w.agentKey) continue;
      if (w.portalId && w.portalId !== item.id && action !== "opened") continue;
      w.send(ev);
    }
  }

  private syncItemStreamError(item: PortalItem, nextError?: string): void {
    const clean = nextError?.trim() || undefined;
    if (item.streamError === clean) return;
    if (clean) item.streamError = clean;
    else delete item.streamError;
    item.updatedAt = Date.now();
    this.emitEvent("updated", item);
  }

  private emitPortalFrame(item: PortalItem, frame: PortalFramePayload): void {
    const frameEv: PortalStreamEvent = { kind: "portal_frame", ...frame };
    this.deps.onPortalEvent(frameEv);
    for (const w of this.streamWatchers.values()) {
      if (w.portalId === item.id || (w.agentKey && item.agentKey && w.agentKey === item.agentKey)) {
        w.send(frameEv);
      }
    }
  }

  private attachBrowserWatchersForPortal(portalId: string): void {
    for (const [wId, w] of this.streamWatchers) {
      if (w.portalId === portalId) this.attachBrowserToWatcher(wId);
    }
  }

  private async reviveBrowserSession(item: PortalItem): Promise<void> {
    if (!item.url) throw new Error("缺少网页链接");
    const inflight = this.browserReviving.get(item.id);
    if (inflight) return inflight;
    const p = (async () => {
      const res = await this.browser.open(item.id, item.url!);
      item.url = res.url || item.url;
      if (res.title) item.title = res.title;
      item.subtitle = item.url;
      this.syncItemStreamError(item, undefined);
      this.attachBrowserWatchersForPortal(item.id);
    })().finally(() => {
      this.browserReviving.delete(item.id);
    });
    this.browserReviving.set(item.id, p);
    return p;
  }

  private attachBrowserToWatcher(wId: string): void {
    const w = this.streamWatchers.get(wId);
    if (!w?.portalId) return;
    w.offBrowser?.();
    w.offBrowser = undefined;
    const sess = this.browser.get(w.portalId);
    if (sess) {
      const portalId = w.portalId;
      w.offBrowser = sess.onFrame((frame) => {
        const item = this.items.get(portalId);
        if (item) {
          if (frame.url && frame.url !== item.url) {
            item.url = frame.url;
            item.subtitle = frame.url;
          }
          if (frame.title && frame.title !== item.title) {
            item.title = frame.title;
          }
          item.width = frame.width;
          item.height = frame.height;
          if (item.streamError) this.syncItemStreamError(item, undefined);
        }
        w.send({ kind: "portal_frame", ...frame });
      });
    }
  }

  async openPortal(opts: {
    agentKey?: string;
    kind: PortalKind;
    target?: string;
    url?: string;
    windowId?: string;
    reveal?: boolean;
    title?: string;
    egoSpace?: PortalEgoSpaceState;
  }): Promise<{ item: PortalItem; ticket?: PortalFileTicket }> {
    const now = Date.now();
    const agent = opts.agentKey ? this.deps.getAgents().find((a) => a.key === opts.agentKey) : undefined;
    const direct = this.deps.getDirectInfo();
    const transportHint: "p2p" | "relay" = direct.connectedCount > 0 || direct.port ? "p2p" : "relay";

    let kind = opts.kind;
    let targetPath = opts.target?.trim() || undefined;
    let parentDir: string | undefined;
    let highlightName: string | undefined;
    let mime: string | undefined;
    let size: number | undefined;
    let ticket: PortalFileTicket | undefined;

    if (kind === "file" || kind === "html" || kind === "reveal") {
      if (!targetPath) throw new Error("需要提供文件路径或链接");
      const filesOpts = this.deps.getFilesOptions(agent?.cwd);
      const st = await stat(targetPath).catch(() => null);
      if (st?.isDirectory() && kind !== "reveal") kind = "reveal";
      if (kind === "reveal" && st && !st.isDirectory()) {
        highlightName = basename(targetPath);
        parentDir = dirname(targetPath);
      } else if (kind === "reveal") {
        parentDir = targetPath;
      } else {
        parentDir = dirname(targetPath);
      }
      const issued = await this.tickets.issueTicket({
        agentCwd: agent?.cwd,
        path: kind === "reveal" && st && !st.isDirectory() ? targetPath : targetPath,
        filesOpts,
        port: direct.port,
        addrs: direct.addrs,
      });
      targetPath = issued.absPath;
      mime = issued.mime;
      size = issued.size;
      const { absPath: _ignored, ...wireTicket } = issued;
      ticket = wireTicket;
    }

    const portalId = `ptl-${(++this.itemSeq).toString(36)}-${now.toString(36)}`;
    let url = opts.url ?? (kind === "browser" ? targetPath : undefined);
    let title =
      opts.title?.trim() ||
      (opts.egoSpace
        ? `EG 空间 · ${opts.egoSpace.spaceName}`
        : kind === "window"
          ? opts.windowId === "screen:0"
            ? "远程桌面"
            : "系统窗口"
          : kind === "browser"
            ? url || "远程浏览器"
            : targetPath
              ? basename(targetPath)
              : "回传视图");
    let streamError: string | undefined;
    let initialFrame: PortalFramePayload | null = null;
    let width: number | undefined;
    let height: number | undefined;
    let resolvedWindowId = opts.windowId;

    if (kind === "browser") {
      if (!url) throw new Error("需要提供网页 URL");
      try {
        const res = await this.browser.open(portalId, url);
        url = res.url || url;
        title = res.title || title;
        const sess = this.browser.get(portalId);
        initialFrame = sess?.getLatestFrame() ?? (await sess?.captureOnce().catch(() => null)) ?? null;
        if (initialFrame) {
          width = initialFrame.width;
          height = initialFrame.height;
        }
      } catch (err) {
        const browserMsg = (err as Error)?.message || "远端浏览器启动失败";
        const permNote = await this.capture.checkPermissionNote().catch(() => null);
        streamError =
          permNote && !browserMsg.includes("屏幕录制")
            ? `${browserMsg}（如需改用系统窗口捕获：${permNote}）`
            : browserMsg;
      }
    } else if (kind === "window") {
      if (opts.egoSpace && !opts.windowId) {
        resolvedWindowId = undefined;
      } else {
        const winId = opts.windowId || "screen:0";
        resolvedWindowId = winId;
        const wins = await this.capture.listWindows().catch(() => []);
        const hit = wins.find((w) => w.id === winId);
        if (hit && !opts.egoSpace) {
          title = opts.title?.trim() || `${hit.appName} · ${hit.title}`;
        }
        const cap = await this.capture.captureWindow(winId).catch(() => null);
        if (cap) {
          width = cap.width;
          height = cap.height;
          initialFrame = {
            portalId,
            seq: ++this.windowSeq,
            mime: cap.mime,
            data: cap.data,
            ...(cap.rawBytes ? { rawBytes: cap.rawBytes, byteLength: cap.rawBytes.byteLength } : {}),
            width: cap.width,
            height: cap.height,
            ...(url ? { url } : {}),
            title,
            ...(cap.cursorX !== undefined ? { cursorX: cap.cursorX, cursorY: cap.cursorY, cursorVisible: cap.cursorVisible } : {}),
            ...(cap.captureMs !== undefined ? { captureMs: cap.captureMs } : {}),
            at: now,
          };
        } else {
          if (hit?.bounds) {
            width = hit.bounds.width;
            height = hit.bounds.height;
          }
          const permNote = await this.capture.checkPermissionNote().catch(() => null);
          streamError = permNote ?? "当前无法捕获该系统窗口画面（窗口可能已最小化、关闭，或系统未授予抓屏权限）";
        }
      }
    }

    const canInteract = kind === "browser" || (kind === "window" && Boolean(resolvedWindowId));
    const item: PortalItem = {
      id: portalId,
      hostId: this.deps.hostId(),
      ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
      ...(agent?.localId ? { terminalId: agent.localId } : {}),
      kind,
      title,
      subtitle: opts.egoSpace
        ? buildEgoSubtitle(opts.egoSpace, url)
        : kind === "reveal" && highlightName
          ? `定位文件：${highlightName}`
          : kind === "browser"
            ? url
            : url || targetPath,
      ...(targetPath ? { targetPath } : {}),
      ...(parentDir ? { parentDir } : {}),
      ...(highlightName ? { highlightName } : {}),
      ...(url ? { url } : {}),
      ...(resolvedWindowId ? { windowId: resolvedWindowId } : {}),
      ...(opts.egoSpace ? { egoSpace: opts.egoSpace } : {}),
      ...(mime ? { mime } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      canInteract,
      ...(streamError ? { streamError } : {}),
      transportHint,
      createdAt: now,
      updatedAt: now,
    };

    this.items.set(portalId, item);
    this.pruneItems();
    this.emitEvent("opened", item);
    this.attachBrowserWatchersForPortal(portalId);
    if (initialFrame) {
      this.emitPortalFrame(item, initialFrame);
    }
    return { item, ...(ticket ? { ticket } : {}) };
  }

  closePortal(portalId: string): void {
    this.autoWindowMeta.delete(portalId);
    this.inputMoveInFlight.delete(portalId);
    this.inputMoveQueued.delete(portalId);
    const existing = this.items.get(portalId);
    this.browser.close(portalId);
    if (!existing) return;
    if (existing.agentKey) {
      const binding = this.egoBindings.get(existing.agentKey);
      if (binding?.portalId === portalId) {
        this.egoBindings.delete(existing.agentKey);
        this.maybeStopEgoSpaceSyncTimer();
      }
    }
    this.items.delete(portalId);
    this.emitEvent("closed", existing);
  }

  listPortals(agentKey?: string): PortalItem[] {
    const all = [...this.items.values()];
    return (agentKey ? all.filter((i) => i.agentKey === agentKey) : all).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listWindows(): Promise<RemoteWindowInfo[]> {
    return this.capture.listWindows();
  }

  async captureFrame(
    portalId: string,
    opts?: { maxWidth?: number; quality?: number; showCursor?: boolean; fps?: number; sinceNativeSeq?: string; skipBase64?: boolean },
  ): Promise<{ frame: PortalFramePayload | null; item: PortalItem | null; unchanged?: boolean; nativeSeq?: string }> {
    const item = this.items.get(portalId) ?? null;
    if (!item) return { frame: null, item: null };
    if (item.kind === "browser") {
      let sess = this.browser.get(portalId);
      if (!sess && item.url) {
        try {
          await this.reviveBrowserSession(item);
          sess = this.browser.get(portalId);
        } catch (err) {
          this.syncItemStreamError(item, (err as Error)?.message || "远端浏览器未启动或当前环境未安装 Chromium/Chrome");
          return { frame: null, item };
        }
      }
      const frame = sess ? await sess.captureOnce() : null;
      if (frame) {
        if (frame.url && frame.url !== item.url) {
          item.url = frame.url;
          item.subtitle = frame.url;
          item.updatedAt = Date.now();
        }
        if (frame.title && frame.title !== item.title) {
          item.title = frame.title;
        }
        item.width = frame.width;
        item.height = frame.height;
        this.syncItemStreamError(item, undefined);
      } else if (!sess) {
        this.syncItemStreamError(item, item.streamError ?? "远端浏览器未启动或当前环境未安装 Chromium/Chrome");
      }
      return { frame, item };
    }
    if (item.kind === "window") {
      if (item.egoSpace && !item.windowId) {
        return { frame: null, item };
      }
      const cap = await this.capture.captureWindow(item.windowId || "screen:0", opts);
      if (!cap) {
        const permNote = await this.capture.checkPermissionNote().catch(() => null);
        this.syncItemStreamError(item, permNote ?? "当前无法捕获该系统窗口画面（窗口可能已最小化、关闭，或系统未授予抓屏权限）");
        return { frame: null, item };
      }
      this.syncItemStreamError(item, undefined);
      if (cap.unchanged) {
        return { frame: null, item, unchanged: true, nativeSeq: cap.nativeSeq };
      }
      const dataStr = opts?.skipBase64 ? "" : cap.data || (cap.rawBytes ? cap.rawBytes.toString("base64") : "");
      const frame: PortalFramePayload = {
        portalId,
        seq: ++this.windowSeq,
        mime: cap.mime,
        data: dataStr,
        ...(cap.rawBytes ? { rawBytes: cap.rawBytes, byteLength: cap.rawBytes.byteLength } : {}),
        width: cap.width,
        height: cap.height,
        ...(item.url ? { url: item.url } : {}),
        title: item.title,
        ...(cap.cursorX !== undefined ? { cursorX: cap.cursorX, cursorY: cap.cursorY, cursorVisible: cap.cursorVisible } : {}),
        ...(cap.captureMs !== undefined ? { captureMs: cap.captureMs } : {}),
        at: Date.now(),
      };
      item.width = cap.width;
      item.height = cap.height;
      item.updatedAt = frame.at;
      return { frame, item, nativeSeq: cap.nativeSeq };
    }
    return { frame: null, item };
  }

  private sendFrameToWatcher(w: PortalWatcher, frame: PortalFramePayload, allowDedup = true): void {
    const fp = frameFingerprint(frame);
    const now = Date.now();
    if (allowDedup && w.lastHash === fp && now - (w.lastSentAt ?? 0) < 2800) {
      return;
    }
    w.lastHash = fp;
    w.lastSentAt = now;
    w.lastSentSeq = frame.seq;
    w.sentAtBySeq.set(frame.seq, now);
    if (w.sentAtBySeq.size > 32) {
      const oldest = w.sentAtBySeq.keys().next().value;
      if (oldest !== undefined) w.sentAtBySeq.delete(oldest);
    }
    w.send({ kind: "portal_frame", ...frame });
  }

  private startWindowWatcherLoop(streamId: string, w: PortalWatcher): void {
    if (w.timer) {
      clearTimeout(w.timer);
      w.timer = undefined;
    }
    const portalId = w.portalId;
    if (!portalId) return;
    let lastErrCapAt = 0;
    const intervalMs = Math.max(16, Math.round(1000 / Math.max(1, w.fps)));
    const pump = () => {
      if (this.streamWatchers.get(streamId) !== w) return;
      const curItem = this.items.get(portalId);
      if (curItem?.streamError && Date.now() - lastErrCapAt < 2000) {
        w.timer = setTimeout(pump, 200);
        w.timer.unref?.();
        return;
      }
      // TigerVNC ContinuousUpdates / RustDesk-style BDP sliding credit window (up to 6 frames inflight).
      const maxInflight = w.fps >= 30 ? 6 : 4;
      if (w.hasAck && w.lastSentSeq - w.lastAckedSeq >= maxInflight) {
        const stalledFor = Date.now() - (w.lastSentAt ?? 0);
        if (stalledFor < 120) {
          w.timer = setTimeout(pump, 6);
          w.timer.unref?.();
          return;
        }
        w.lastAckedSeq = Math.max(w.lastAckedSeq, w.lastSentSeq - 2);
      }
      const startedAt = Date.now();
      void this.captureFrame(portalId, {
        maxWidth: w.effectiveMaxWidth,
        quality: w.effectiveQuality,
        showCursor: w.showCursor,
        fps: w.fps,
        sinceNativeSeq: w.lastNativeSeq,
        skipBase64: Boolean(w.binaryFrames),
      })
        .then(({ frame, unchanged, nativeSeq }) => {
          if (this.streamWatchers.get(streamId) !== w) return;
          if (unchanged) {
            if (nativeSeq) w.lastNativeSeq = nativeSeq;
            return;
          }
          if (frame) {
            if (nativeSeq) w.lastNativeSeq = nativeSeq;
            this.sendFrameToWatcher(w, frame, true);
          } else {
            lastErrCapAt = Date.now();
          }
        })
        .catch(() => {})
        .finally(() => {
          if (this.streamWatchers.get(streamId) !== w) return;
          const waitMs = Math.max(1, intervalMs - (Date.now() - startedAt));
          w.timer = setTimeout(pump, waitMs);
          w.timer.unref?.();
        });
    };
    pump();
  }

  private scheduleInputPoke(portalId: string): void {
    if (this.pokeTimers.has(portalId)) return;
    const t = setTimeout(() => {
      this.pokeTimers.delete(portalId);
      const item = this.items.get(portalId);
      if (!item || item.kind !== "window") return;
      const watchers = [...this.streamWatchers.values()].filter((w) => w.portalId === portalId);
      if (!watchers.length) return;
      const lead = watchers[0]!;
      void this.captureFrame(portalId, {
        maxWidth: lead.effectiveMaxWidth,
        quality: lead.effectiveQuality,
        showCursor: lead.showCursor,
        fps: lead.fps,
      })
        .then(({ frame }) => {
          if (!frame) return;
          for (const w of watchers) {
            this.sendFrameToWatcher(w, frame, false);
          }
        })
        .catch(() => {});
    }, 18);
    t.unref?.();
    this.pokeTimers.set(portalId, t);
  }

  private drainQueuedWindowMove(portalId: string, windowId: string): void {
    const next = this.inputMoveQueued.get(portalId);
    if (!next) return;
    this.inputMoveQueued.delete(portalId);
    this.inputMoveInFlight.add(portalId);
    void this.capture
      .injectInput(windowId, next)
      .catch(() => {})
      .finally(() => {
        this.inputMoveInFlight.delete(portalId);
        if (this.items.has(portalId) && this.inputMoveQueued.has(portalId)) {
          this.drainQueuedWindowMove(portalId, windowId);
        }
      });
  }

  async sendInput(portalId: string, input: PortalInputAction): Promise<{ url?: string; title?: string; clipboardText?: string }> {
    const item = this.items.get(portalId);
    if (!item) throw new Error("回传窗口不存在或已关闭");

    if (input.type === "ack") {
      const now = Date.now();
      for (const w of this.streamWatchers.values()) {
        if (w.portalId !== portalId) continue;
        w.hasAck = true;
        if (input.seq > w.lastAckedSeq) w.lastAckedSeq = input.seq;
        const sentAt = w.sentAtBySeq.get(input.seq);
        if (sentAt !== undefined) {
          w.sentAtBySeq.delete(input.seq);
          const rtt = Math.max(1, now - sentAt);
          w.rttEwmaMs = w.rttEwmaMs > 0 ? Math.round(w.rttEwmaMs * 0.7 + rtt * 0.3) : rtt;
          let abrChanged = false;
          if (rtt > 105) {
            w.slowStreak += 1;
            w.fastStreak = 0;
            if (w.slowStreak >= 3) {
              const nextQ = Math.max(38, w.effectiveQuality - 10);
              const nextW = Math.max(960, Math.round(w.effectiveMaxWidth * 0.82));
              if (nextQ !== w.effectiveQuality || nextW !== w.effectiveMaxWidth) {
                w.effectiveQuality = nextQ;
                w.effectiveMaxWidth = nextW;
                abrChanged = true;
              }
              w.slowStreak = 0;
            }
          } else if (rtt < 55) {
            w.fastStreak += 1;
            w.slowStreak = 0;
            if (w.fastStreak >= 8) {
              const nextQ = Math.min(w.quality, w.effectiveQuality + 6);
              const nextW = Math.min(w.maxWidth, Math.round(w.effectiveMaxWidth * 1.12));
              if (nextQ !== w.effectiveQuality || nextW !== w.effectiveMaxWidth) {
                w.effectiveQuality = nextQ;
                w.effectiveMaxWidth = nextW;
                abrChanged = true;
              }
              w.fastStreak = 0;
            }
          } else {
            w.slowStreak = 0;
          }
          if (abrChanged && item.kind === "browser") {
            void this.browser.get(portalId)?.updateScreencastConfig({
              maxWidth: w.effectiveMaxWidth,
              quality: w.effectiveQuality,
            });
          }
        }
      }
      return { title: item.title };
    }

    if (input.type === "config") {
      for (const [streamId, w] of this.streamWatchers) {
        if (w.portalId !== portalId) continue;
        if (typeof input.fps === "number" && Number.isFinite(input.fps)) {
          w.fps = Math.min(60, Math.max(1, Math.round(input.fps)));
        }
        if (typeof input.maxWidth === "number" && Number.isFinite(input.maxWidth)) {
          w.maxWidth = Math.min(2560, Math.max(480, Math.round(input.maxWidth)));
          w.effectiveMaxWidth = w.maxWidth;
        }
        if (typeof input.quality === "number" && Number.isFinite(input.quality)) {
          w.quality = Math.min(92, Math.max(40, Math.round(input.quality)));
          w.effectiveQuality = w.quality;
        }
        if (typeof input.showCursor === "boolean") {
          w.showCursor = input.showCursor;
        }
        w.slowStreak = 0;
        w.fastStreak = 0;
        w.lastHash = undefined;
        w.lastNativeSeq = undefined;
        if (item.kind === "window") {
          this.startWindowWatcherLoop(streamId, w);
        } else if (item.kind === "browser") {
          void this.browser.get(portalId)?.updateScreencastConfig({
            maxWidth: w.effectiveMaxWidth,
            quality: w.effectiveQuality,
          });
        }
      }
      if (item.kind === "browser") {
        void this.captureFrame(portalId).catch(() => {});
      }
      return { title: item.title };
    }

    if (input.type === "promptPermission") {
      await this.capture.promptPermission(input.kind);
      return { title: item.title };
    }

    if (input.type === "clipboard") {
      if (item.kind === "browser") {
        const sess = this.browser.get(portalId);
        if (sess && input.action === "set" && input.text) {
          await sess.dispatchInput({ type: "text", text: input.text });
          return { url: item.url, title: item.title };
        }
      }
      const clipboardText = await this.capture.handleClipboard(input.action, input.text);
      return {
        ...(item.url ? { url: item.url } : {}),
        title: item.title,
        ...(clipboardText !== undefined ? { clipboardText } : {}),
      };
    }

    if (item.kind === "browser") {
      let sess = this.browser.get(portalId);
      if (!sess && item.url) {
        try {
          await this.reviveBrowserSession(item);
          sess = this.browser.get(portalId);
        } catch (err) {
          const msg = (err as Error)?.message || "远端浏览器未启动或当前环境未安装 Chromium/Chrome";
          this.syncItemStreamError(item, msg);
          throw new Error(msg);
        }
      }
      if (!sess) throw new Error(item.streamError || "远端浏览器未启动或当前环境未安装 Chromium/Chrome");
      const res = await sess.dispatchInput(input);
      if (res.url) {
        item.url = res.url;
        item.subtitle = res.url;
      }
      if (res.title) item.title = res.title;
      item.updatedAt = Date.now();
      this.syncItemStreamError(item, undefined);
      return res;
    }
    if (item.kind === "window") {
      if (item.egoSpace && !item.windowId) {
        throw new Error("当前 EG 浏览器空间暂未关联可操控的独立窗口");
      }
      const targetWin = item.windowId || "screen:0";
      if (input.type === "pointer" && (input.action === "move" || input.action === "drag")) {
        if (this.inputMoveInFlight.has(portalId)) {
          this.inputMoveQueued.set(portalId, input);
          return { title: item.title };
        }
        this.inputMoveInFlight.add(portalId);
        try {
          await this.capture.injectInput(targetWin, input);
        } finally {
          this.inputMoveInFlight.delete(portalId);
          if (this.items.has(portalId) && this.inputMoveQueued.has(portalId)) {
            this.drainQueuedWindowMove(portalId, targetWin);
          }
        }
        item.updatedAt = Date.now();
        return { title: item.title };
      }
      this.inputMoveQueued.delete(portalId);
      await this.capture.injectInput(targetWin, input);
      item.updatedAt = Date.now();
      this.scheduleInputPoke(portalId);
      return { title: item.title };
    }
    throw new Error("当前回传类型不支持远程键鼠交互");
  }

  async issueFileTicket(opts: { agentCwd?: string; path: string; cwd?: string }): Promise<PortalFileTicket> {
    const direct = this.deps.getDirectInfo();
    const root = opts.cwd?.trim() || opts.agentCwd;
    const issued = await this.tickets.issueTicket({
      agentCwd: root,
      path: opts.path,
      filesOpts: this.deps.getFilesOptions(root),
      port: direct.port,
      addrs: direct.addrs,
    });
    const { absPath: _ignored, ...ticket } = issued;
    return ticket;
  }

  async readChunk(opts: { agentCwd?: string; path: string; cwd?: string; offset?: number; length?: number }) {
    return readChunkForRpc(opts.agentCwd, opts, this.deps.getFilesOptions(opts.cwd?.trim() || opts.agentCwd));
  }

  async bundleHtml(opts: { agentCwd?: string; path: string; cwd?: string }) {
    return bundleHtmlForRelay(opts.agentCwd, opts, this.deps.getFilesOptions(opts.cwd?.trim() || opts.agentCwd));
  }

  async dirList(opts: { portalId?: string; agentCwd?: string; path: string; hidden?: boolean }) {
    const item = opts.portalId ? this.items.get(opts.portalId) : undefined;
    return listDirectoryForPortal({
      dirPath: opts.path,
      agentCwd: opts.agentCwd,
      allowedParentDir: item?.parentDir,
      highlightName: item?.highlightName,
      hidden: opts.hidden,
      filesOpts: this.deps.getFilesOptions(opts.agentCwd),
    });
  }

  subscribe(
    streamId: string,
    params: { portalId?: string; agent?: string; fps?: number; maxWidth?: number; quality?: number; showCursor?: boolean; binaryFrames?: boolean },
    send: (ev: PortalStreamEvent) => void,
  ): () => void {
    const fps = Math.min(60, Math.max(1, Number(params.fps ?? (params.portalId ? 30 : 0)) || (params.portalId ? 30 : 0)));
    const maxWidth = Math.min(2560, Math.max(480, Number(params.maxWidth ?? 1600) || 1600));
    const quality = Math.min(92, Math.max(40, Number(params.quality ?? 72) || 72));
    const showCursor = typeof params.showCursor === "boolean" ? params.showCursor : true;
    const entry: PortalWatcher = {
      portalId: params.portalId,
      agentKey: params.agent,
      send,
      fps,
      maxWidth,
      quality,
      showCursor,
      ...(params.binaryFrames ? { binaryFrames: true } : {}),
      lastSentSeq: 0,
      lastAckedSeq: 0,
      sentAtBySeq: new Map(),
      rttEwmaMs: 0,
      effectiveQuality: quality,
      effectiveMaxWidth: maxWidth,
      slowStreak: 0,
      fastStreak: 0,
    };
    this.streamWatchers.set(streamId, entry);
    this.ensureWindowDeltaWatcher();

    if (params.portalId) {
      const pid = params.portalId;
      this.attachBrowserToWatcher(streamId);
      const item = this.items.get(pid);
      if (item?.kind === "browser") {
        const sess = this.browser.get(pid);
        if (sess) {
          void sess.updateScreencastConfig({ maxWidth, quality });
        }
        if (!sess?.getLatestFrame()) {
          void this.captureFrame(pid)
            .then(({ frame }) => {
              if (frame && this.streamWatchers.has(streamId)) this.sendFrameToWatcher(entry, frame, false);
            })
            .catch(() => {});
        }
      } else if (item?.kind === "window" && (!item.egoSpace || item.windowId)) {
        this.startWindowWatcherLoop(streamId, entry);
      }
      entry.heartbeatTimer = setInterval(() => {
        if (this.streamWatchers.get(streamId) !== entry) return;
        const curItem = this.items.get(pid);
        if (!curItem || curItem.streamError) return;
        if (Date.now() - (entry.lastSentAt ?? 0) >= 550) {
          entry.send({
            kind: "portal_heartbeat",
            portalId: pid,
            fps: entry.fps,
            idle: true,
            ...(entry.rttEwmaMs > 0 ? { rttMs: Math.round(entry.rttEwmaMs) } : {}),
            quality: entry.effectiveQuality,
            ...(curItem.width ? { width: curItem.width } : {}),
            ...(curItem.height ? { height: curItem.height } : {}),
            at: Date.now(),
          });
        }
      }, 400);
      entry.heartbeatTimer.unref?.();
    }

    return () => this.unsubscribe(streamId);
  }

  unsubscribe(streamId: string): void {
    const w = this.streamWatchers.get(streamId);
    if (!w) return;
    this.streamWatchers.delete(streamId);
    if (w.timer) clearTimeout(w.timer);
    if (w.heartbeatTimer) clearInterval(w.heartbeatTimer);
    w.offBrowser?.();
  }

  private markAutoDedup(key: string): void {
    const now = Date.now();
    this.recentAutoKeys.set(key, now);
    if (this.recentAutoKeys.size > 160) {
      const oldest = this.recentAutoKeys.keys().next().value;
      if (oldest) this.recentAutoKeys.delete(oldest);
    }
  }

  private checkAndMarkAutoDedup(key: string, ttlMs = AUTO_DEDUP_MS): boolean {
    const now = Date.now();
    const prev = this.recentAutoKeys.get(key);
    if (prev !== undefined && now - prev < ttlMs) return true;
    this.markAutoDedup(key);
    return false;
  }

  private recordPendingWindowIntent(
    agentKey: string,
    intent: Omit<PendingWindowIntent, "agentKey" | "expiresAt">,
    ttlMs = PENDING_WINDOW_INTENT_TTL_MS,
  ): void {
    const now = Date.now();
    this.prunePendingWindowIntents(now);
    const list = this.pendingWindowIntents.get(agentKey) ?? [];
    list.push({
      agentKey,
      expiresAt: now + ttlMs,
      ...intent,
    });
    if (list.length > 16) list.splice(0, list.length - 16);
    this.pendingWindowIntents.set(agentKey, list);
  }

  private prunePendingWindowIntents(now = Date.now()): void {
    for (const [key, list] of this.pendingWindowIntents) {
      const alive = list.filter((it) => it.expiresAt > now);
      if (alive.length > 0) this.pendingWindowIntents.set(key, alive);
      else this.pendingWindowIntents.delete(key);
    }
  }

  private hasUnexpiredPendingIntents(): boolean {
    this.prunePendingWindowIntents();
    return this.pendingWindowIntents.size > 0;
  }

  private hasPendingWslIntentForAgent(agentKey: string): boolean {
    this.prunePendingWindowIntents();
    return Boolean(this.pendingWindowIntents.get(agentKey)?.some((it) => it.isWsl));
  }

  private matchPendingWindowIntent(w: RemoteWindowInfo): Agent | undefined {
    this.prunePendingWindowIntents();
    const agents = this.deps.getAgents();
    const appLower = w.appName.toLowerCase();
    let best: { agent: Agent; expiresAt: number } | null = null;
    for (const [agentKey, list] of this.pendingWindowIntents) {
      const agent = agents.find((a) => a.key === agentKey);
      if (!agent) continue;
      for (const intent of list) {
        let matches = false;
        if (intent.appHints.length > 0) {
          matches = intent.appHints.some((h) => appLower.includes(h) || w.title.toLowerCase().includes(h));
        }
        if (!matches && intent.titleHint && titleMatchesHint(w, intent.titleHint)) {
          matches = true;
        }
        if (!matches && intent.isWsl && XSERVER_APP_RE.test(w.appName)) {
          matches = true;
        }
        if (matches && (!best || intent.expiresAt > best.expiresAt)) {
          best = { agent, expiresAt: intent.expiresAt };
        }
      }
    }
    return best?.agent;
  }

  private matchWindowByHint(
    windows: RemoteWindowInfo[],
    hints: string[],
    beforeIds?: Set<string>,
    beforeTitles?: Map<string, string>,
    strictFresh = false,
    titleHint?: string,
  ): RemoteWindowInfo | undefined {
    const visible = windows.filter((w) => !w.isScreen && (w.bounds?.width ?? 200) >= 140 && (w.bounds?.height ?? 200) >= 100);
    const expandedHints = expandAppHints(hints);
    const allowPocket = expandedHints.some((h) => h.includes("herdr pocket"));
    const candidates = visible.filter((w) => allowPocket || !w.appName.toLowerCase().includes("herdr pocket"));

    const isFreshOrRetitled = (w: RemoteWindowInfo): boolean => {
      if (beforeIds && !beforeIds.has(w.id)) return true;
      if (beforeTitles && beforeTitles.has(w.id) && beforeTitles.get(w.id) !== w.title && w.title.trim() !== "") return true;
      return false;
    };

    const matchHint = (w: RemoteWindowInfo): boolean => {
      if (!expandedHints.length) return false;
      const app = w.appName.toLowerCase();
      const title = w.title.toLowerCase();
      return expandedHints.some((h) => app.includes(h) || title.includes(h));
    };

    if (expandedHints.length) {
      const freshMatch = beforeIds || beforeTitles ? candidates.find((w) => isFreshOrRetitled(w) && matchHint(w)) : undefined;
      if (freshMatch) return freshMatch;
      if (!strictFresh || !(beforeIds || beforeTitles)) {
        const matched = candidates.filter(matchHint);
        if (matched.length) {
          return matched.sort(
            (a, b) => (b.bounds?.width ?? 800) * (b.bounds?.height ?? 600) - (a.bounds?.width ?? 800) * (a.bounds?.height ?? 600),
          )[0];
        }
      }
    }

    if ((beforeIds || beforeTitles) && titleHint) {
      const freshTitleMatch = candidates.find(
        (w) => isFreshOrRetitled(w) && !TERMINAL_APP_NAMES.has(w.appName.toLowerCase()) && titleMatchesHint(w, titleHint),
      );
      if (freshTitleMatch) return freshTitleMatch;
    }
    return undefined;
  }

  private isTrackableAppWindow(w: RemoteWindowInfo): boolean {
    if (w.isScreen) return false;
    if ((w.bounds?.width ?? 200) < 160 || (w.bounds?.height ?? 200) < 120) return false;
    const app = w.appName.trim().toLowerCase();
    if (!app) return false;
    if (TERMINAL_APP_NAMES.has(app) || app.includes("herdr pocket")) return false;
    if (
      app === "system settings" ||
      app === "系统设置" ||
      app === "loginwindow" ||
      app === "dock" ||
      app === "window server" ||
      app === "windowserver" ||
      app === "control center" ||
      app === "控制中心" ||
      app === "notification center" ||
      app === "通知中心" ||
      app === "spotlight" ||
      app === "聚焦" ||
      app === "screenshot" ||
      app === "截屏"
    ) {
      return false;
    }
    if ((app === "finder" || app === "访达") && !w.title.trim()) return false;
    return true;
  }

  private resolveProcessTreeOwnerAgent(
    w: RemoteWindowInfo,
    procs: Map<number, { ppid: number; name: string }>,
    opts: { isNewWindow?: boolean; requireNonBaselineForExistingWin?: boolean } = {},
  ): Agent | undefined {
    const agents = this.deps.getAgents();
    const terms = this.deps.getTerminals();
    const fgPidToAgent = new Map<number, Agent>();
    const termPidToAgent = new Map<number, Agent>();
    let wslFgAgent: Agent | undefined;

    for (const agent of agents) {
      const t = terms.get(agent.localId);
      if (!t) continue;
      if (t.foreground?.pid) {
        fgPidToAgent.set(t.foreground.pid, agent);
        if (!wslFgAgent && t.foreground.argv?.some((arg) => /\bwsl(?:\.exe)?\b/i.test(arg))) {
          wslFgAgent = agent;
        }
      }
      if (t.pid) termPidToAgent.set(t.pid, agent);
    }

    const isNew = opts.isNewWindow ?? true;
    if (w.pid && (fgPidToAgent.size > 0 || termPidToAgent.size > 0)) {
      let cur = w.pid;
      const seen = new Set<number>();
      for (let hop = 0; hop < PROCESS_TREE_MAX_HOPS && cur > 1 && !seen.has(cur); hop += 1) {
        seen.add(cur);
        const fgHit = fgPidToAgent.get(cur);
        if (fgHit && (!opts.requireNonBaselineForExistingWin || isNew || !this.baselineFgPids.has(cur))) {
          return fgHit;
        }
        const termHit = termPidToAgent.get(cur);
        if (termHit && isNew) {
          return termHit;
        }
        const p = procs.get(cur);
        if (!p || !p.ppid || p.ppid === cur) break;
        cur = p.ppid;
      }
    }

    const isWinHost = (this.deps.captureDeps?.platform ?? process.platform) === "win32";
    if (isNew && XSERVER_APP_RE.test(w.appName) && wslFgAgent && (isWinHost || this.hasPendingWslIntentForAgent(wslFgAgent.key))) {
      return wslFgAgent;
    }
    return undefined;
  }

  private ensureWindowDeltaWatcher(): void {
    if (this.windowDeltaTimer) return;
    const plat = this.deps.captureDeps?.platform ?? process.platform;
    if (plat === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
    this.windowDeltaTimer = setInterval(() => {
      void this.pollWindowDeltas().catch(() => {});
    }, 850);
    this.windowDeltaTimer.unref?.();
  }

  /**
   * Watches OS window deltas strictly for child windows whose lineage traces back to a terminal PTY process
   * or an explicit per-terminal command launch intent — never surfacing unrelated OS windows.
   */
  async pollWindowDeltas(): Promise<void> {
    if (this.windowDeltaInFlight) return;
    this.windowDeltaInFlight = true;
    try {
      const wins = await this.capture.listWindows().catch(() => []);
      if (!wins.length && !this.windowBaselineSeeded) return;
      const visible = wins.filter((w) => this.isTrackableAppWindow(w));
      if (!this.windowBaselineSeeded) {
        this.knownWindows = new Map(visible.map((w) => [w.id, { appName: w.appName, title: w.title }]));
        this.windowBaselineSeeded = true;
        return;
      }

      const egoChanged =
        visible.some((w) => {
          if (!/ego\s*lite/i.test(w.appName)) return false;
          const prev = this.knownWindows.get(w.id);
          return !prev || prev.title !== w.title;
        }) ||
        [...this.knownWindows.entries()].some(
          ([id, meta]) => /ego\s*lite/i.test(meta.appName) && !visible.some((w) => w.id === id),
        );

      const newWindows = visible.filter((w) => !this.knownWindows.has(w.id) && !/ego\s*lite/i.test(w.appName));
      const procs = newWindows.some((w) => w.pid)
        ? await this.capture.listProcessParents().catch(() => new Map<number, { ppid: number; name: string }>())
        : new Map<number, { ppid: number; name: string }>();

      for (const w of visible) {
        const prev = this.knownWindows.get(w.id);
        const existingPortal = [...this.items.values()].find((i) => i.kind === "window" && i.windowId === w.id);
        const nextTitle = `${w.appName}${w.title && w.title !== w.appName ? ` · ${w.title}` : ""}`;
        const isEgoApp = /ego\s*lite/i.test(w.appName);

        if (!prev) {
          if (isEgoApp) continue;
          if (existingPortal) {
            const meta = this.autoWindowMeta.get(existingPortal.id);
            if (meta) meta.missCount = 0;
            continue;
          }
          if (this.checkAndMarkAutoDedup(`delta-open\0${w.id}`, 2000)) continue;
          const owner =
            this.resolveProcessTreeOwnerAgent(w, procs, { isNewWindow: true }) ??
            this.matchPendingWindowIntent(w);
          if (!owner) continue;
          const { item } = await this.openPortal({
            agentKey: owner.key,
            kind: "window",
            windowId: w.id,
            title: nextTitle,
          });
          this.autoWindowMeta.set(item.id, {
            portalId: item.id,
            windowId: w.id,
            openedAt: Date.now(),
            missCount: 0,
          });
          continue;
        }

        if (prev.title !== w.title && w.title.trim() !== "") {
          if (existingPortal) {
            if (existingPortal.egoSpace) continue;
            const cap = await this.capture.captureWindow(w.id).catch(() => null);
            if (cap) {
              this.syncItemStreamError(existingPortal, undefined);
              this.pushWindowPortalUpdate(existingPortal, { title: nextTitle, cap }, "updated");
            } else {
              existingPortal.title = nextTitle;
              this.emitEvent("updated", existingPortal);
            }
          } else if (!isEgoApp) {
            const pendingOwner = this.matchPendingWindowIntent(w);
            if (pendingOwner && !this.checkAndMarkAutoDedup(`delta-retitle\0${w.id}`, 2000)) {
              const { item } = await this.openPortal({
                agentKey: pendingOwner.key,
                kind: "window",
                windowId: w.id,
                title: nextTitle,
              });
              this.autoWindowMeta.set(item.id, {
                portalId: item.id,
                windowId: w.id,
                openedAt: Date.now(),
                missCount: 0,
              });
            }
          }
        }
      }

      this.knownWindows = new Map(visible.map((w) => [w.id, { appName: w.appName, title: w.title }]));

      if (this.autoWindowMeta.size > 0 && wins.length > 0) {
        const liveIds = new Set(visible.map((w) => w.id));
        const now = Date.now();
        for (const [portalId, meta] of [...this.autoWindowMeta.entries()]) {
          if (liveIds.has(meta.windowId)) {
            meta.missCount = 0;
            continue;
          }
          if (now - meta.openedAt < 1500) continue;
          meta.missCount += 1;
          if (meta.missCount >= 4) {
            this.closePortal(portalId);
          }
        }
      }

      if (egoChanged && this.egoBindings.size > 0) {
        void this.syncActiveEgoSpacePortals().catch(() => {});
      }
    } finally {
      this.windowDeltaInFlight = false;
    }
  }

  private pushWindowPortalUpdate(
    existing: PortalItem,
    opts: { title?: string; url?: string; cap: { mime: "image/jpeg" | "image/png"; data: string; rawBytes?: Buffer; width: number; height: number } },
    action: "opened" | "updated" = "opened",
  ): void {
    const now = Date.now();
    if (opts.title) existing.title = opts.title;
    if (opts.url) {
      existing.url = opts.url;
      existing.subtitle = opts.url;
    }
    existing.width = opts.cap.width;
    existing.height = opts.cap.height;
    if (action === "opened") {
      existing.updatedAt = now;
    }
    this.emitEvent(action, existing);
    const frame: PortalFramePayload = {
      portalId: existing.id,
      seq: ++this.windowSeq,
      mime: opts.cap.mime,
      data: opts.cap.data,
      ...(opts.cap.rawBytes ? { rawBytes: opts.cap.rawBytes, byteLength: opts.cap.rawBytes.byteLength } : {}),
      width: opts.cap.width,
      height: opts.cap.height,
      url: existing.url,
      title: existing.title,
      at: now,
    };
    this.deps.onPortalEvent({ kind: "portal_frame", ...frame });
    for (const w of this.streamWatchers.values()) {
      if (w.portalId === existing.id || (w.agentKey && existing.agentKey && w.agentKey === existing.agentKey)) {
        w.send({ kind: "portal_frame", ...frame });
      }
    }
  }

  private async detectAndOpenWindowPortal(opts: {
    agent?: Agent;
    appHint?: string | string[];
    titleHint?: string;
    urlHint?: string;
    beforeIds?: Set<string>;
    beforeTitles?: Map<string, string>;
    fallbackOpener?: Extract<AutoPortalIntent, { type: "opener" }>;
    immediate?: boolean;
  }): Promise<PortalItem | null> {
    const hints = Array.isArray(opts.appHint) ? opts.appHint : opts.appHint ? [opts.appHint] : [];
    const delays = opts.immediate ? [0, 300, 900, 1700] : [250, 800, 1600];
    let lastHit: RemoteWindowInfo | undefined;
    let lastPermNote: string | null = null;

    for (let i = 0; i < delays.length; i += 1) {
      const ms = delays[i]!;
      if (ms > 0) await delayMs(ms);
      const strictFresh = Boolean(opts.beforeIds || opts.beforeTitles) && i < delays.length - 1;
      const wins = await this.capture.listWindows().catch(() => []);
      const hit = this.matchWindowByHint(wins, hints, opts.beforeIds, opts.beforeTitles, strictFresh, opts.titleHint);
      if (!hit) continue;
      lastHit = hit;
      const cap = await this.capture.captureWindow(hit.id).catch(() => null);
      if (!cap) {
        const permNote = await this.capture.checkPermissionNote().catch(() => null);
        if (permNote) {
          lastPermNote = permNote;
          break;
        }
        continue;
      }

      const existing = [...this.items.values()].find(
        (i) => i.agentKey === opts.agent?.key && i.kind === "window" && i.windowId === hit.id,
      );
      const nextTitle = opts.titleHint || `${hit.appName}${hit.title && hit.title !== hit.appName ? ` · ${hit.title}` : ""}`;
      if (existing) {
        this.syncItemStreamError(existing, undefined);
        this.pushWindowPortalUpdate(existing, { title: nextTitle, url: opts.urlHint, cap });
        return existing;
      }
      const { item } = await this.openPortal({
        agentKey: opts.agent?.key,
        kind: "window",
        windowId: hit.id,
        url: opts.urlHint,
        title: nextTitle,
      });
      return item;
    }

    if (opts.urlHint) {
      const existingBrowser = [...this.items.values()].find(
        (i) => i.agentKey === opts.agent?.key && i.kind === "browser" && i.url === opts.urlHint && !i.streamError,
      );
      if (existingBrowser) {
        existingBrowser.updatedAt = Date.now();
        this.emitEvent("opened", existingBrowser);
        return existingBrowser;
      }
      const { item } = await this.openPortal({
        agentKey: opts.agent?.key,
        kind: "browser",
        url: opts.urlHint,
        title: opts.titleHint,
      }).catch(() => ({ item: null as PortalItem | null }));
      return item;
    }

    if (opts.fallbackOpener?.target && existsSync(opts.fallbackOpener.target)) {
      const { item } = await this.openPortal({
        agentKey: opts.agent?.key,
        kind: opts.fallbackOpener.kind,
        target: opts.fallbackOpener.target,
        reveal: opts.fallbackOpener.reveal,
      }).catch(() => ({ item: null as PortalItem | null }));
      return item;
    }

    const existingHealthy = [...this.items.values()].find(
      (i) => i.agentKey === opts.agent?.key && (i.kind === "browser" || i.kind === "window") && !i.streamError,
    );
    if (existingHealthy) {
      return existingHealthy;
    }

    if (lastHit && lastPermNote) {
      const existingErrWin = [...this.items.values()].find(
        (i) => i.agentKey === opts.agent?.key && i.kind === "window" && i.windowId === lastHit!.id,
      );
      if (existingErrWin) {
        this.syncItemStreamError(existingErrWin, lastPermNote);
        return existingErrWin;
      }
      const fallbackTitle =
        opts.titleHint ||
        `${lastHit.appName}${lastHit.title && lastHit.title !== lastHit.appName ? ` · ${lastHit.title}` : ""}`;
      const { item } = await this.openPortal({
        agentKey: opts.agent?.key,
        kind: "window",
        windowId: lastHit.id,
        title: fallbackTitle,
      }).catch(() => ({ item: null as PortalItem | null }));
      return item;
    }
    return null;
  }

  private async ensureBaselineInitialized(): Promise<void> {
    if (this.baselineWindowIds !== null) return;
    if (this.baselineInitPromise) return this.baselineInitPromise;
    this.baselineInitPromise = this.capture
      .listWindows()
      .then((wins) => {
        if (this.baselineWindowIds === null) {
          this.baselineWindowIds = new Set(wins.filter((w) => !w.isScreen).map((w) => w.id));
          if (!this.windowBaselineSeeded && wins.length > 0) {
            const visible = wins.filter((w) => this.isTrackableAppWindow(w));
            this.knownWindows = new Map(visible.map((w) => [w.id, { appName: w.appName, title: w.title }]));
            this.windowBaselineSeeded = true;
          }
          for (const t of this.deps.getTerminals().values()) {
            if (t.foreground?.pid) this.baselineFgPids.add(t.foreground.pid);
          }
        }
      })
      .catch(() => {
        if (this.baselineWindowIds === null) this.baselineWindowIds = new Set();
      })
      .finally(() => {
        this.baselineInitPromise = null;
      });
    return this.baselineInitPromise;
  }

  private scheduleFollowupScans(delaysMs: number[]): void {
    for (const ms of delaysMs) {
      const t = setTimeout(() => {
        const idx = this.scanFollowupTimers.indexOf(t);
        if (idx >= 0) this.scanFollowupTimers.splice(idx, 1);
        if (this.deps.hasRemoteViewers()) {
          void this.scanProcessTreePortals().catch(() => {});
        }
        void this.pollWindowDeltas().catch(() => {});
      }, ms);
      t.unref?.();
      this.scanFollowupTimers.push(t);
    }
  }

  /** Called when host terminals/foreground processes update; discovers child GUI windows automatically. */
  observeTerminalsUpdated(): void {
    let fgChanged = false;
    const terms = this.deps.getTerminals();
    for (const [addr, t] of terms) {
      const fgPid = t.foreground?.pid ?? 0;
      const prev = this.lastTerminalFgPid.get(addr);
      if (fgPid > 0 && prev !== fgPid) {
        this.lastTerminalFgPid.set(addr, fgPid);
        if (prev !== undefined) fgChanged = true;
      } else if (fgPid === 0 && prev !== undefined) {
        this.lastTerminalFgPid.delete(addr);
      }
    }
    if (!this.deps.hasRemoteViewers()) return;

    const recentCmd = this.hasUnexpiredPendingIntents();
    if (!fgChanged && this.autoWindowMeta.size === 0 && !recentCmd) return;

    if (fgChanged) {
      this.scheduleFollowupScans([0, 800]);
      return;
    }
    if (this.scanTimer) return;
    const elapsed = Date.now() - this.lastScanAt;
    const wait = Math.max(0, 900 - elapsed);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.deps.hasRemoteViewers()) {
        void this.scanProcessTreePortals().catch(() => {});
      }
    }, wait);
    this.scanTimer.unref?.();
  }

  /**
   * Scans visible OS windows against terminal process trees (`w.pid -> ppid -> term.pid / term.foreground.pid`)
   * and Windows X-Server (`vcxsrv`/`x410`/`xming`/`msrdc`) windows, opening & cleaning up portals automatically.
   */
  async scanProcessTreePortals(): Promise<void> {
    if (this.scanInFlight) return this.scanInFlight;
    const run = (async () => {
      this.lastScanAt = Date.now();
      await this.ensureBaselineInitialized();
      const wins = await this.capture.listWindows().catch(() => []);
      const visible = wins.filter(
        (w) => !w.isScreen && (w.bounds?.width ?? 200) >= 80 && (w.bounds?.height ?? 200) >= 60,
      );

      const procs = visible.some((w) => w.pid)
        ? await this.capture.listProcessParents().catch(() => new Map<number, { ppid: number; name: string }>())
        : new Map<number, { ppid: number; name: string }>();

      for (const w of visible) {
        const appLower = w.appName.toLowerCase();
        if (TERMINAL_APP_NAMES.has(appLower) || appLower.includes("herdr pocket") || /ego\s*lite/i.test(w.appName)) {
          continue;
        }
        const isNewWindow = !(this.baselineWindowIds?.has(w.id));
        const matchedAgent = this.resolveProcessTreeOwnerAgent(w, procs, {
          isNewWindow,
          requireNonBaselineForExistingWin: true,
        });
        if (!matchedAgent) continue;

        const existing = [...this.items.values()].find(
          (i) => i.kind === "window" && i.windowId === w.id && i.agentKey === matchedAgent.key,
        );
        if (existing) {
          const meta = this.autoWindowMeta.get(existing.id);
          if (meta) meta.missCount = 0;
          continue;
        }

        const cap = await this.capture.captureWindow(w.id).catch(() => null);
        if (!cap) continue;

        const nextTitle = `${w.appName}${w.title && w.title !== w.appName ? ` · ${w.title}` : ""}`;
        const { item } = await this.openPortal({
          agentKey: matchedAgent.key,
          kind: "window",
          windowId: w.id,
          title: nextTitle,
        });
        this.autoWindowMeta.set(item.id, {
          portalId: item.id,
          windowId: w.id,
          openedAt: Date.now(),
          missCount: 0,
        });
      }

      if (this.autoWindowMeta.size > 0 && wins.length > 0) {
        const liveIds = new Set(visible.map((w) => w.id));
        const now = Date.now();
        for (const [portalId, meta] of [...this.autoWindowMeta.entries()]) {
          if (liveIds.has(meta.windowId)) {
            meta.missCount = 0;
            continue;
          }
          if (now - meta.openedAt < 1200) continue;
          meta.missCount += 1;
          if (meta.missCount >= 2) {
            this.closePortal(portalId);
          }
        }
      }
    })().finally(() => {
      this.scanInFlight = null;
    });
    this.scanInFlight = run;
    return run;
  }

  /** Reconstruct submitted commands from raw terminal keystrokes/pastes and auto-open matching portals. */
  observeTerminalInput(agent: Agent, rawData: string): void {
    if (!this.deps.hasRemoteViewers()) return;
    const submitted = this.inputTracker.feed(agent.key, rawData);
    for (const line of submitted) {
      this.observeSubmittedCommand(agent, line, "terminal_input");
    }
  }

  /** Parse submitted shell commands (typed, pasted, sent via composer, or run by an Agent) into live Portals. */
  observeSubmittedCommand(
    agent: Agent,
    commandText: string,
    source: "terminal_input" | "user_send" | "agent_tool" | "foreground" = "terminal_input",
  ): void {
    if (!commandText) return;
    const isWsl = /\bwsl(?:\.exe)?\b|\bDISPLAY\s*=/i.test(commandText);
    const liveCwd = this.deps.getTerminals().get(agent.localId)?.cwd || agent.cwd || undefined;
    const intents = extractAutoPortalIntents(commandText, liveCwd);
    if (isWsl && !intents.some((i) => i.type === "app_window" || i.type === "ego_space")) {
      this.recordPendingWindowIntent(agent.key, {
        appHints: expandAppHints(["x11"]),
        titleHint: "X11",
        isWsl: true,
      });
    }
    for (const intent of intents) {
      void this.applyAutoPortalIntent(agent, intent, source).catch(() => {});
    }
    if (intents.length > 0 || isWsl) {
      this.scheduleFollowupScans([250, 800, 1800]);
    }
  }

  private resolveTargetWithUniquePrefix(target: string): string | null {
    if (existsSync(target)) return target;
    try {
      const dir = dirname(target);
      const baseLower = basename(target).toLowerCase();
      if (!baseLower || !existsSync(dir)) return null;
      const matches = readdirSync(dir).filter((name) => name.toLowerCase().startsWith(baseLower));
      if (matches.length === 1 && matches[0]) {
        const candidate = resolve(dir, matches[0]);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore fs errors
    }
    return null;
  }

  private async queryEgoSpaces(serverName?: string): Promise<EgoTaskSpaceEntry[]> {
    if (this.deps.queryEgoTaskSpaces) {
      return this.deps.queryEgoTaskSpaces(serverName).catch(() => []);
    }
    // Avoid shelling out to a developer machine's live Ego Lite daemon during mocked captureDeps unit tests.
    if (this.deps.captureDeps?.execBin) return [];
    return defaultQueryEgoTaskSpaces(serverName).catch(() => []);
  }

  private maybeStopEgoSpaceSyncTimer(): void {
    if (this.egoBindings.size === 0 && this.egoSyncTimer) {
      clearInterval(this.egoSyncTimer);
      this.egoSyncTimer = null;
    }
  }

  private ensureEgoSpaceSyncTimer(): void {
    if (this.egoSyncTimer || this.egoBindings.size === 0) return;
    this.egoSyncTimer = setInterval(() => {
      if (this.egoBindings.size === 0) {
        this.maybeStopEgoSpaceSyncTimer();
        return;
      }
      void this.syncActiveEgoSpacePortals().catch(() => {});
    }, EGO_SPACE_SYNC_MS);
    this.egoSyncTimer.unref?.();
  }

  private async syncActiveEgoSpacePortals(): Promise<void> {
    const agents = this.deps.getAgents();
    for (const [agentKey, binding] of [...this.egoBindings.entries()]) {
      const agent = agents.find((a) => a.key === agentKey);
      if (!agent) {
        if (binding.portalId) this.closePortal(binding.portalId);
        this.egoBindings.delete(agentKey);
        continue;
      }
      await this.syncEgoSpaceForAgent(agent).catch(() => {});
    }
    this.maybeStopEgoSpaceSyncTimer();
  }

  private async handleEgoSpaceIntent(
    agent: Agent,
    intent: Extract<AutoPortalIntent, { type: "ego_space" }>,
    source: "terminal_input" | "user_send" | "agent_tool" | "foreground" = "agent_tool",
  ): Promise<void> {
    if (intent.finish?.closeSpace) {
      const existing = this.egoBindings.get(agent.key);
      if (existing?.portalId) {
        this.closePortal(existing.portalId);
      }
      this.egoBindings.delete(agent.key);
      this.maybeStopEgoSpaceSyncTimer();
      return;
    }

    let binding = this.egoBindings.get(agent.key);
    const isFreshBinding = !binding;
    if (!binding) {
      binding = {
        agentKey: agent.key,
        updatedAt: Date.now(),
      };
      this.egoBindings.set(agent.key, binding);
    }

    if (intent.spaceId !== undefined && binding.spaceId !== undefined && intent.spaceId !== binding.spaceId) {
      delete binding.screenPageTitle;
      delete binding.confirmedInEgoLite;
    }
    if (intent.serverName) binding.serverName = intent.serverName;
    if (intent.spaceId !== undefined) binding.spaceId = intent.spaceId;
    if (intent.spaceName) binding.spaceName = intent.spaceName;
    if (intent.pageLabel) binding.pageLabel = intent.pageLabel;
    if (intent.url) binding.url = intent.url;
    if (intent.handoff) binding.handoffHint = true;
    else if (source !== "foreground") binding.handoffHint = false;
    if (intent.action && (source !== "foreground" || !binding.lastAction)) {
      binding.lastAction = intent.action;
    }
    binding.updatedAt = Date.now();

    if (isFreshBinding && intent.spaceId === undefined && !intent.spaceName) {
      const preSpaces = await this.queryEgoSpaces(intent.serverName);
      if (preSpaces.length > 0 && !binding.beforeSpaceIds) {
        binding.beforeSpaceIds = new Set(preSpaces.map((s) => s.id));
      }
    }

    if (isFreshBinding || source !== "foreground" || intent.spaceId !== undefined || intent.spaceName) {
      this.ensureEgoSpaceSyncTimer();
    }
    await this.syncEgoSpaceForAgent(agent, source !== "foreground");
  }

  private async handleEgoSpaceSnapshot(agent: Agent, snap: EgoScreenSnapshot, fgArgv?: string[]): Promise<void> {
    const binding = this.egoBindings.get(agent.key);
    const hasEgoFg = Boolean(fgArgv?.some((arg) => /\bego-browser\b/i.test(arg)));
    if (!binding && !hasEgoFg && !snap.spaceName) return;

    await this.handleEgoSpaceIntent(
      agent,
      {
        type: "ego_space",
        ...(snap.spaceId !== undefined ? { spaceId: snap.spaceId } : {}),
        ...(snap.spaceName ? { spaceName: snap.spaceName } : {}),
        ...(snap.pageLabel ? { pageLabel: snap.pageLabel } : {}),
      },
      "foreground",
    );
    const latest = this.egoBindings.get(agent.key);
    if (latest && snap.pageTitle && latest.screenPageTitle !== snap.pageTitle) {
      latest.screenPageTitle = snap.pageTitle;
      await this.syncEgoSpaceForAgent(agent, false);
    }
  }

  private syncEgoSpaceForAgent(agent: Agent, forceRefreshFrame = false): Promise<PortalItem | null> {
    const inflight = this.egoSyncInFlight.get(agent.key);
    if (inflight) {
      return inflight.then(() => this.runSyncEgoSpaceForAgent(agent, forceRefreshFrame));
    }
    const p = this.runSyncEgoSpaceForAgent(agent, forceRefreshFrame).finally(() => {
      if (this.egoSyncInFlight.get(agent.key) === p) {
        this.egoSyncInFlight.delete(agent.key);
      }
    });
    this.egoSyncInFlight.set(agent.key, p);
    return p;
  }

  private async runSyncEgoSpaceForAgent(agent: Agent, forceRefreshFrame = false): Promise<PortalItem | null> {
    const binding = this.egoBindings.get(agent.key);
    if (!binding) return null;

    const allSpaces = await this.queryEgoSpaces(binding.serverName);
    const claimedByOthers = new Set<number>();
    for (const [k, other] of this.egoBindings) {
      if (k !== agent.key && other.spaceId !== undefined) claimedByOthers.add(other.spaceId);
    }

    let entry: EgoTaskSpaceEntry | undefined;
    if (binding.spaceId !== undefined) {
      entry = allSpaces.find((s) => s.id === binding.spaceId);
    }
    if (!entry && binding.spaceName) {
      entry = allSpaces.find(
        (s) =>
          s.createdBy === "agent" &&
          !claimedByOthers.has(s.id) &&
          (s.name === binding.spaceName || s.taskId === binding.spaceName),
      );
    }
    if (!entry && binding.beforeSpaceIds) {
      entry = allSpaces.find(
        (s) => s.createdBy === "agent" && !binding.beforeSpaceIds!.has(s.id) && !claimedByOthers.has(s.id),
      );
    }

    if (entry) {
      binding.spaceId = entry.id;
      binding.confirmedInEgoLite = true;
      if (!binding.spaceName && entry.name) binding.spaceName = entry.name;
    } else if (
      binding.confirmedInEgoLite &&
      binding.spaceId !== undefined &&
      allSpaces.length > 0 &&
      !allSpaces.some((s) => s.id === binding.spaceId)
    ) {
      if (binding.portalId) this.closePortal(binding.portalId);
      this.egoBindings.delete(agent.key);
      this.maybeStopEgoSpaceSyncTimer();
      return null;
    }

    const spaceName =
      entry?.name || binding.spaceName || (binding.spaceId !== undefined ? `Space #${binding.spaceId}` : "临时任务空间");
    const activeTabTitle =
      binding.screenPageTitle || entry?.recentTabTitles?.[entry.recentTabTitles.length - 1] || entry?.recentTabTitles?.[0];
    const phase = ownershipToEgoPhase(entry?.ownership, binding.handoffHint);

    const egoSpace: PortalEgoSpaceState = {
      ...(entry?.id !== undefined ? { spaceId: entry.id } : binding.spaceId !== undefined ? { spaceId: binding.spaceId } : {}),
      spaceName,
      ...(entry?.ownership ? { ownership: entry.ownership } : {}),
      phase,
      ...(binding.pageLabel ? { pageLabel: binding.pageLabel } : {}),
      ...(activeTabTitle ? { activeTabTitle } : {}),
      ...(entry?.recentTabTitles?.length ? { tabCount: entry.recentTabTitles.length } : {}),
      ...(binding.lastAction ? { lastAction: binding.lastAction } : {}),
      ...(binding.serverName ? { serverName: binding.serverName } : {}),
      ...(entry?.profileName ? { profileName: entry.profileName } : {}),
    };

    const wins = await this.capture.listWindows().catch(() => []);
    const matchedWin = selectMatchingEgoSpaceWindow(
      wins,
      {
        spaceId: egoSpace.spaceId,
        spaceName: entry?.name || binding.spaceName,
        activeTabTitle,
        recentTabTitles: entry?.recentTabTitles,
      },
      allSpaces,
    );

    const nextTitle = `EG 空间 · ${spaceName}`;
    const nextSubtitle = buildEgoSubtitle(egoSpace, binding.url);

    const existing = binding.portalId ? this.items.get(binding.portalId) : undefined;
    if (existing) {
      const prevWindowId = existing.windowId;
      const changedMeta =
        existing.title !== nextTitle ||
        existing.subtitle !== nextSubtitle ||
        existing.url !== binding.url ||
        JSON.stringify(existing.egoSpace) !== JSON.stringify(egoSpace) ||
        prevWindowId !== matchedWin?.id;

      existing.title = nextTitle;
      existing.subtitle = nextSubtitle;
      if (binding.url) existing.url = binding.url;
      existing.egoSpace = egoSpace;

      if (matchedWin) {
        existing.windowId = matchedWin.id;
        existing.canInteract = true;
        if (prevWindowId !== matchedWin.id || forceRefreshFrame) {
          const cap = await this.capture.captureWindow(matchedWin.id).catch(() => null);
          if (cap) {
            this.syncItemStreamError(existing, undefined);
            this.pushWindowPortalUpdate(existing, { title: nextTitle, url: binding.url, cap }, "updated");
          } else if (changedMeta || prevWindowId !== matchedWin.id) {
            existing.updatedAt = Date.now();
            this.emitEvent("updated", existing);
          }
          if (prevWindowId !== matchedWin.id) {
            for (const [streamId, w] of this.streamWatchers) {
              if (w.portalId === existing.id && !w.timer) {
                this.startWindowWatcherLoop(streamId, w);
              }
            }
          }
          return existing;
        }
      } else if (prevWindowId && wins.length > 0 && !matchedWin) {
        delete existing.windowId;
        delete existing.streamError;
        existing.canInteract = false;
      }

      if (changedMeta) {
        existing.updatedAt = Date.now();
        this.emitEvent("updated", existing);
      }
      return existing;
    }

    const { item } = await this.openPortal({
      agentKey: agent.key,
      kind: "window",
      ...(matchedWin ? { windowId: matchedWin.id } : {}),
      ...(binding.url ? { url: binding.url } : {}),
      title: nextTitle,
      egoSpace,
    });
    binding.portalId = item.id;
    return item;
  }

  private async applyAutoPortalIntent(
    agent: Agent,
    intent: AutoPortalIntent,
    source: "terminal_input" | "user_send" | "agent_tool" | "foreground" = "terminal_input",
  ): Promise<void> {
    if (intent.type === "ego_space") {
      await this.handleEgoSpaceIntent(agent, intent, source);
      return;
    }

    if (intent.type === "app_window") {
      const dedupKey = `${agent.key}\0win\0${intent.appHint.toLowerCase()}\0${intent.url ?? ""}`;
      if (this.checkAndMarkAutoDedup(dedupKey, 2500)) return;
      this.recordPendingWindowIntent(agent.key, {
        appHints: expandAppHints([intent.appHint]),
        titleHint: intent.label,
        urlHint: intent.url,
        isWsl: intent.appHint.toLowerCase() === "x11",
      });
      const appLower = intent.appHint.toLowerCase();
      const immediate = appLower.includes("ego") || appLower.includes("tabbit");
      await this.detectAndOpenWindowPortal({
        agent,
        appHint: intent.appHint,
        titleHint: intent.label,
        urlHint: intent.url,
        immediate,
      });
      return;
    }

    const dedupId = intent.url || intent.target || intent.app || "";
    if (this.checkAndMarkAutoDedup(`${agent.key}\0${intent.kind}\0${dedupId}`, 3500)) return;

    if (intent.app) {
      this.recordPendingWindowIntent(agent.key, {
        appHints: expandAppHints([intent.app]),
        titleHint: intent.target ? basename(intent.target) : intent.app,
        urlHint: intent.url,
      });
      const wins = await this.capture.listWindows().catch(() => []);
      await this.detectAndOpenWindowPortal({
        agent,
        appHint: intent.app,
        titleHint: intent.target ? basename(intent.target) : intent.app,
        urlHint: intent.url,
        beforeIds: new Set(wins.map((w) => w.id)),
        beforeTitles: new Map(wins.map((w) => [w.id, w.title])),
        fallbackOpener: intent,
      });
      return;
    }

    if (intent.kind === "browser") {
      const url = intent.url || intent.target;
      if (!url) return;
      const canCdp = await this.browser.hasBrowser().catch(() => false);
      if (canCdp) {
        const existingBrowser = [...this.items.values()].find(
          (i) => i.agentKey === agent.key && i.kind === "browser" && i.url === url && !i.streamError,
        );
        if (existingBrowser) {
          existingBrowser.updatedAt = Date.now();
          this.emitEvent("opened", existingBrowser);
          return;
        }
        const opened = await this.openPortal({
          agentKey: agent.key,
          kind: "browser",
          url,
          title: url,
        }).catch(() => null);
        if (opened?.item && !opened.item.streamError) return;
      }
      this.recordPendingWindowIntent(agent.key, {
        appHints: expandAppHints(BROWSER_WINDOW_HINTS),
        titleHint: url,
        urlHint: url,
      });
      const wins = await this.capture.listWindows().catch(() => []);
      await this.detectAndOpenWindowPortal({
        agent,
        appHint: BROWSER_WINDOW_HINTS,
        urlHint: url,
        beforeIds: new Set(wins.map((w) => w.id)),
        beforeTitles: new Map(wins.map((w) => [w.id, w.title])),
        titleHint: url,
      });
      return;
    }

    const resolvedTarget = intent.target ? this.resolveTargetWithUniquePrefix(intent.target) : null;
    if (!resolvedTarget) return;
    const beforeWins = await this.capture.listWindows().catch(() => []);
    const existing = [...this.items.values()].find(
      (i) => i.agentKey === agent.key && i.kind === intent.kind && i.targetPath === resolvedTarget,
    );
    if (existing) {
      existing.updatedAt = Date.now();
      this.emitEvent("opened", existing);
    } else {
      await this.openPortal({
        agentKey: agent.key,
        kind: intent.kind,
        target: resolvedTarget,
        reveal: intent.reveal,
      });
    }

    if (intent.kind !== "html") {
      this.recordPendingWindowIntent(agent.key, {
        appHints: [],
        titleHint: basename(resolvedTarget),
      });
      // Follow up on GUI windows explicitly matching the opened filename (e.g. `open CLAUDE.md` -> Typora / Preview).
      void this.detectAndOpenWindowPortal({
        agent,
        beforeIds: new Set(beforeWins.map((w) => w.id)),
        beforeTitles: new Map(beforeWins.map((w) => [w.id, w.title])),
        titleHint: basename(resolvedTarget),
      }).catch(() => {});
    }
  }

  /** Detect `open` / `xdg-open` / `ego-browser` / MCP browser / file-display calls from Agent turns or shell tools. */
  inspectToolCallForPortal(agent: Agent, toolName: string, input: unknown): void {
    let parsedInput: Record<string, unknown> | null = null;
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedInput = parsed as Record<string, unknown>;
        }
      } catch {
        // Plain string command fallback below
      }
      if (!parsedInput) {
        if (/bash|zsh|shell|exec|terminal|command|run_command/i.test(toolName)) {
          this.observeSubmittedCommand(agent, trimmed, "agent_tool");
        }
        return;
      }
    } else if (input && typeof input === "object") {
      parsedInput = input as Record<string, unknown>;
    } else {
      return;
    }
    const inp = parsedInput;

    if (/bash|zsh|shell|exec|terminal|command/i.test(toolName)) {
      const cmd =
        (typeof inp.command === "string" && inp.command) ||
        (typeof inp.CommandLine === "string" && inp.CommandLine) ||
        (typeof inp.cmd === "string" && inp.cmd) ||
        (typeof inp.script === "string" && inp.script) ||
        "";
      if (cmd) this.observeSubmittedCommand(agent, cmd, "agent_tool");
      return;
    }

    if (/ego[-_]?browser|tabbit|playwright|puppeteer|chrome[-_]?devtools|browser|navigate|goto|open_url|web_preview/i.test(toolName)) {
      const url =
        (typeof inp.url === "string" && inp.url) ||
        (typeof inp.href === "string" && inp.href) ||
        (typeof inp.target === "string" && /^https?:/i.test(inp.target) && inp.target) ||
        undefined;
      if (/ego/i.test(toolName)) {
        const spaceName =
          (typeof inp.spaceName === "string" && inp.spaceName) ||
          (typeof inp.taskSpace === "string" && inp.taskSpace) ||
          undefined;
        const spaceId = typeof inp.spaceId === "number" ? inp.spaceId : undefined;
        const pageLabel = typeof inp.page === "string" ? inp.page : undefined;
        void this.handleEgoSpaceIntent(
          agent,
          {
            type: "ego_space",
            ...(spaceName ? { spaceName } : {}),
            ...(spaceId !== undefined ? { spaceId } : {}),
            ...(pageLabel ? { pageLabel } : {}),
            ...(url ? { url } : {}),
            action: url ? `访问 ${url}` : "执行页面操作",
          },
          "agent_tool",
        ).catch(() => {});
        return;
      }
      const appHint = /tabbit/i.test(toolName) ? "Tabbit" : BROWSER_WINDOW_HINTS;
      const dedupKey = `${agent.key}\0mcp\0${Array.isArray(appHint) ? "browser" : appHint}\0${url ?? ""}`;
      if (this.checkAndMarkAutoDedup(dedupKey, 2500)) return;
      this.recordPendingWindowIntent(agent.key, {
        appHints: expandAppHints(Array.isArray(appHint) ? appHint : [appHint]),
        titleHint: /tabbit/i.test(toolName) ? "Tabbit" : url,
        urlHint: url,
      });
      void this.detectAndOpenWindowPortal({
        agent,
        appHint,
        titleHint: /tabbit/i.test(toolName) ? "Tabbit 浏览器" : undefined,
        urlHint: url,
        immediate: true,
      }).catch(() => {});
      return;
    }

    if (/display_file|open_file|preview_file/i.test(toolName)) {
      const raw =
        (typeof inp.path === "string" && inp.path) ||
        (typeof inp.file_path === "string" && inp.file_path) ||
        (typeof inp.target === "string" && inp.target) ||
        "";
      if (!raw) return;
      const full = agent.cwd && !raw.startsWith("/") ? resolve(agent.cwd, raw) : raw;
      if (!existsSync(full)) return;
      if (this.checkAndMarkAutoDedup(`${agent.key}\0display\0${full}`, 3500)) return;
      const kind: PortalKind = /\.html?$/i.test(full) ? "html" : "file";
      void this.openPortal({ agentKey: agent.key, kind, target: full }).catch(() => {});
    }
  }

  /** Detect OAuth URLs or running browser CLIs (`ego-browser`, `tabbit`) on active remote terminals. */
  inspectScreenForOAuth(agent: Agent, screenText: string, fgArgv?: string[]): void {
    if (!this.deps.hasRemoteViewers()) return;

    if (fgArgv?.length) {
      const joined = fgArgv.join(" ");
      if (/\b(ego-browser|tabbit|agent-browser)\b/i.test(joined)) {
        const prevAt = this.lastForegroundCheckAt.get(agent.key) ?? 0;
        if (Date.now() - prevAt >= SCREEN_FOREGROUND_THROTTLE_MS) {
          this.lastForegroundCheckAt.set(agent.key, Date.now());
          if (/\bego-browser\b/i.test(joined)) {
            const intents = extractAutoPortalIntents(joined);
            for (const it of intents) {
              if (it.type === "ego_space") {
                void this.handleEgoSpaceIntent(agent, it, "foreground").catch(() => {});
              }
            }
          } else {
            this.observeSubmittedCommand(agent, joined, "foreground");
          }
        }
      }
    }

    if (!screenText) return;
    const snap = parseEgoScreenSnapshot(screenText);
    if (snap) {
      const prevAt = this.lastForegroundCheckAt.get(agent.key) ?? 0;
      if (Date.now() - prevAt >= SCREEN_FOREGROUND_THROTTLE_MS || this.egoBindings.has(agent.key)) {
        this.lastForegroundCheckAt.set(agent.key, Date.now());
        void this.handleEgoSpaceSnapshot(agent, snap, fgArgv).catch(() => {});
      }
    }

    const flat = screenText.replace(/\r/g, "");
    const m = /(https?:\/\/[^\s"'<>()]+(?:oauth|authorize|login|auth)[^\s"'<>()]*)/i.exec(flat);
    if (!m?.[1]) return;
    const url = m[1].replace(/[.,;!?)]+$/, "");
    if (!/(?:redirect_uri=http|localhost|127\.0\.0\.1|device_code|user_code|oauth)/i.test(url)) return;
    const dedupKey = `${agent.key}\0${url}`;
    if (this.seenOAuthUrls.has(dedupKey)) return;
    this.seenOAuthUrls.add(dedupKey);
    if (this.seenOAuthUrls.size > 120) {
      const oldest = this.seenOAuthUrls.values().next().value;
      if (oldest) this.seenOAuthUrls.delete(oldest);
    }
    void this.openPortal({
      agentKey: agent.key,
      kind: "browser",
      url,
      title: "远程浏览器认证",
    }).catch(() => {});
  }
}

export { mimeForFilename };
