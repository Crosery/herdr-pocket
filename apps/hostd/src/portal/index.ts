import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  Agent,
  HostPortalCapabilities,
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
import { OsCaptureDriver, computeCapabilities, type OsCaptureDeps } from "./osCapture.ts";
import { PortalFileTicketStore, bundleHtmlForRelay, listDirectoryForPortal, mimeForFilename, readChunkForRpc } from "./p2pFiles.ts";
import { PortalHookServer, TerminalInputLineTracker, classifyTarget, ensurePortalShims, extractAutoPortalIntents, parseOpenerArgs, type AutoPortalIntent, type HookOpenPayload } from "./shims.ts";
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
  stateDir?: string;
}

const MAX_PORTAL_ITEMS = 40;
const AUTO_DEDUP_MS = 4000;
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

function delayMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  private lastCommandCtx: { agentKey: string; at: number; isWsl: boolean } | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private scanFollowupTimers: NodeJS.Timeout[] = [];
  private scanInFlight: Promise<void> | null = null;
  private lastScanAt = 0;
  private browserReviving = new Map<string, Promise<void>>();
  private streamWatchers = new Map<
    string,
    {
      portalId?: string;
      agentKey?: string;
      send: (ev: PortalStreamEvent) => void;
      timer?: NodeJS.Timeout;
      offBrowser?: () => void;
      fps: number;
    }
  >();

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
      return { ...this.shimsInfo, port };
    } catch {
      return null;
    }
  }

  isHookRunning(): boolean {
    return Boolean(this.hookServer?.port);
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
    for (const t of this.scanFollowupTimers) clearTimeout(t);
    this.scanFollowupTimers = [];
    this.autoWindowMeta.clear();
    this.browserReviving.clear();
    for (const id of [...this.streamWatchers.keys()]) this.unsubscribe(id);
    this.hookServer?.stop();
    this.hookServer = null;
    this.browser.closeAll();
  }

  async capabilities(): Promise<HostPortalCapabilities> {
    const hasCdpBrowser = await this.browser.hasBrowser().catch(() => false);
    const { port } = this.deps.getDirectInfo();
    const caps = computeCapabilities({
      deps: this.deps.captureDeps,
      hasCdpBrowser,
      directPort: port,
    });
    const permNote = await this.capture.checkPermissionNote().catch(() => null);
    if (permNote) {
      const notes = [...(caps.notes ?? []), permNote];
      return { ...caps, notes };
    }
    return caps;
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
        if (t.foreground?.pid === payload.ppid) {
          const hit = agents.find((a) => a.localId === addr);
          if (hit) return hit;
        }
      }
      // Best-effort parent PID walk on Unix (short)
      if (process.platform !== "win32") {
        let cur = payload.ppid;
        for (let depth = 0; depth < 6 && cur > 1; depth++) {
          for (const [addr, t] of terms) {
            if (t.foreground?.pid === cur) {
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
    if (payload.cwd) {
      const norm = resolve(payload.cwd);
      const exact = agents.find((a) => a.cwd && (norm === resolve(a.cwd) || norm.startsWith(`${resolve(a.cwd)}/`)));
      if (exact) return exact;
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
    if (parsed.kind === "window" && parsed.app) {
      this.markAutoDedup(`${agent?.key ?? ""}\0win\0${parsed.app.toLowerCase()}`);
      void this.detectAndOpenWindowPortal({
        agent,
        appHint: parsed.app,
        titleHint: parsed.app,
        urlHint: parsed.url,
      });
      return { handled: isHeadless || forceHandled };
    }

    this.markAutoDedup(`${agent?.key ?? ""}\0${parsed.kind}\0${parsed.url || parsed.target}`);
    const opened = await this.openPortal({
      agentKey: agent?.key,
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
      if (w.agentKey && item.agentKey && w.agentKey !== item.agentKey) continue;
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
      (kind === "window"
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
      const winId = opts.windowId || "screen:0";
      const wins = await this.capture.listWindows().catch(() => []);
      const hit = wins.find((w) => w.id === winId);
      if (hit) {
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
          width: cap.width,
          height: cap.height,
          ...(url ? { url } : {}),
          title,
          at: now,
        };
      } else {
        const permNote = await this.capture.checkPermissionNote().catch(() => null);
        streamError = permNote ?? "当前无法捕获该系统窗口画面（窗口可能已最小化、关闭，或系统未授予抓屏权限）";
      }
    }

    const item: PortalItem = {
      id: portalId,
      hostId: this.deps.hostId(),
      ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
      ...(agent?.localId ? { terminalId: agent.localId } : {}),
      kind,
      title,
      subtitle:
        kind === "reveal" && highlightName
          ? `定位文件：${highlightName}`
          : kind === "browser"
            ? url
            : url || targetPath,
      ...(targetPath ? { targetPath } : {}),
      ...(parentDir ? { parentDir } : {}),
      ...(highlightName ? { highlightName } : {}),
      ...(url ? { url } : {}),
      ...(opts.windowId ? { windowId: opts.windowId } : kind === "window" ? { windowId: "screen:0" } : {}),
      ...(mime ? { mime } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      canInteract: kind === "browser" || kind === "window",
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
    const existing = this.items.get(portalId);
    this.browser.close(portalId);
    if (!existing) return;
    this.items.delete(portalId);
    this.emitEvent("closed", existing);
  }

  listPortals(agentKey?: string): PortalItem[] {
    const all = [...this.items.values()];
    return (agentKey ? all.filter((i) => !i.agentKey || i.agentKey === agentKey) : all).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listWindows(): Promise<RemoteWindowInfo[]> {
    return this.capture.listWindows();
  }

  async captureFrame(portalId: string): Promise<{ frame: PortalFramePayload | null; item: PortalItem | null }> {
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
      const cap = await this.capture.captureWindow(item.windowId || "screen:0");
      if (!cap) {
        const permNote = await this.capture.checkPermissionNote().catch(() => null);
        this.syncItemStreamError(item, permNote ?? "当前无法捕获该系统窗口画面（窗口可能已最小化、关闭，或系统未授予抓屏权限）");
        return { frame: null, item };
      }
      const frame: PortalFramePayload = {
        portalId,
        seq: ++this.windowSeq,
        mime: cap.mime,
        data: cap.data,
        width: cap.width,
        height: cap.height,
        ...(item.url ? { url: item.url } : {}),
        title: item.title,
        at: Date.now(),
      };
      item.width = cap.width;
      item.height = cap.height;
      item.updatedAt = frame.at;
      this.syncItemStreamError(item, undefined);
      return { frame, item };
    }
    return { frame: null, item };
  }

  async sendInput(portalId: string, input: PortalInputAction): Promise<{ url?: string; title?: string }> {
    const item = this.items.get(portalId);
    if (!item) throw new Error("回传窗口不存在或已关闭");
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
      await this.capture.injectInput(item.windowId || "screen:0", input);
      item.updatedAt = Date.now();
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
    params: { portalId?: string; agent?: string; fps?: number },
    send: (ev: PortalStreamEvent) => void,
  ): () => void {
    const fps = Math.min(20, Math.max(1, Number(params.fps ?? (params.portalId ? 10 : 0)) || (params.portalId ? 10 : 0)));
    const entry: {
      portalId?: string;
      agentKey?: string;
      send: (ev: PortalStreamEvent) => void;
      timer?: NodeJS.Timeout;
      offBrowser?: () => void;
      fps: number;
    } = {
      portalId: params.portalId,
      agentKey: params.agent,
      send,
      fps,
    };
    this.streamWatchers.set(streamId, entry);

    if (params.portalId) {
      this.attachBrowserToWatcher(streamId);
      const item = this.items.get(params.portalId);
      if (item?.kind === "browser") {
        const sess = this.browser.get(params.portalId);
        if (!sess?.getLatestFrame()) {
          void this.captureFrame(params.portalId)
            .then(({ frame }) => {
              if (frame && this.streamWatchers.has(streamId)) send({ kind: "portal_frame", ...frame });
            })
            .catch(() => {});
        }
      } else if (item?.kind === "window") {
        let busy = false;
        let lastErrCapAt = 0;
        const intervalMs = Math.max(60, Math.round(1000 / Math.max(1, fps)));
        entry.timer = setInterval(() => {
          if (busy) return;
          const curItem = this.items.get(params.portalId!);
          if (curItem?.streamError && Date.now() - lastErrCapAt < 2000) return;
          busy = true;
          void this.captureFrame(params.portalId!)
            .then(({ frame }) => {
              if (frame) send({ kind: "portal_frame", ...frame });
              else lastErrCapAt = Date.now();
            })
            .catch(() => {})
            .finally(() => {
              busy = false;
            });
        }, intervalMs);
        entry.timer.unref?.();
        void this.captureFrame(params.portalId)
          .then(({ frame }) => {
            if (frame) send({ kind: "portal_frame", ...frame });
          })
          .catch(() => {});
      }
    }

    return () => this.unsubscribe(streamId);
  }

  unsubscribe(streamId: string): void {
    const w = this.streamWatchers.get(streamId);
    if (!w) return;
    this.streamWatchers.delete(streamId);
    if (w.timer) clearInterval(w.timer);
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

  private matchWindowByHint(
    windows: RemoteWindowInfo[],
    hints: string[],
    beforeIds?: Set<string>,
  ): RemoteWindowInfo | undefined {
    const visible = windows.filter((w) => !w.isScreen && (w.bounds?.width ?? 200) >= 140 && (w.bounds?.height ?? 200) >= 100);
    const expandedHints = hints.flatMap((h) => {
      const lower = h.trim().toLowerCase();
      return APP_ALIASES[lower] ?? (lower ? [lower] : []);
    });
    const allowPocket = expandedHints.some((h) => h.includes("herdr pocket"));
    const candidates = visible.filter((w) => allowPocket || !w.appName.toLowerCase().includes("herdr pocket"));

    const matchHint = (w: RemoteWindowInfo): boolean => {
      if (!expandedHints.length) return false;
      const app = w.appName.toLowerCase();
      const title = w.title.toLowerCase();
      return expandedHints.some((h) => app.includes(h) || title.includes(h));
    };

    if (expandedHints.length) {
      const freshMatch = beforeIds ? candidates.find((w) => !beforeIds.has(w.id) && matchHint(w)) : undefined;
      if (freshMatch) return freshMatch;
      const matched = candidates.filter(matchHint);
      if (matched.length) {
        return matched.sort(
          (a, b) => (b.bounds?.width ?? 800) * (b.bounds?.height ?? 600) - (a.bounds?.width ?? 800) * (a.bounds?.height ?? 600),
        )[0];
      }
    }

    if (beforeIds) {
      const freshNonTerm = candidates.find(
        (w) => !beforeIds.has(w.id) && !TERMINAL_APP_NAMES.has(w.appName.toLowerCase()),
      );
      if (freshNonTerm) return freshNonTerm;
    }
    return undefined;
  }

  private pushWindowPortalUpdate(
    existing: PortalItem,
    opts: { title?: string; url?: string; cap: { mime: "image/jpeg" | "image/png"; data: string; width: number; height: number } },
  ): void {
    const now = Date.now();
    if (opts.title) existing.title = opts.title;
    if (opts.url) {
      existing.url = opts.url;
      existing.subtitle = opts.url;
    }
    existing.width = opts.cap.width;
    existing.height = opts.cap.height;
    existing.updatedAt = now;
    this.emitEvent("opened", existing);
    const frame: PortalFramePayload = {
      portalId: existing.id,
      seq: ++this.windowSeq,
      mime: opts.cap.mime,
      data: opts.cap.data,
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
    fallbackOpener?: Extract<AutoPortalIntent, { type: "opener" }>;
    immediate?: boolean;
  }): Promise<PortalItem | null> {
    const hints = Array.isArray(opts.appHint) ? opts.appHint : opts.appHint ? [opts.appHint] : [];
    const delays = opts.immediate ? [0, 300, 900, 1700] : [250, 800, 1600];
    let lastHit: RemoteWindowInfo | undefined;
    let lastPermNote: string | null = null;

    for (const ms of delays) {
      if (ms > 0) await delayMs(ms);
      const wins = await this.capture.listWindows().catch(() => []);
      const hit = this.matchWindowByHint(wins, hints, opts.beforeIds);
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

    const recentCmd = Boolean(this.lastCommandCtx && Date.now() - this.lastCommandCtx.at < 15_000);
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

      const procs = visible.some((w) => w.pid)
        ? await this.capture.listProcessParents().catch(() => new Map<number, { ppid: number; name: string }>())
        : new Map<number, { ppid: number; name: string }>();

      const recentAgent =
        this.lastCommandCtx && Date.now() - this.lastCommandCtx.at < 15_000
          ? agents.find((a) => a.key === this.lastCommandCtx?.agentKey)
          : undefined;

      const matchWindowAgent = (w: RemoteWindowInfo): Agent | undefined => {
        const appLower = w.appName.toLowerCase();
        if (TERMINAL_APP_NAMES.has(appLower) || appLower.includes("herdr pocket")) return undefined;

        const isNewWindow = !(this.baselineWindowIds?.has(w.id));
        if (w.pid && (fgPidToAgent.size > 0 || termPidToAgent.size > 0)) {
          let cur = w.pid;
          const seen = new Set<number>();
          for (let hop = 0; hop < PROCESS_TREE_MAX_HOPS && cur > 1 && !seen.has(cur); hop += 1) {
            seen.add(cur);
            const fgHit = fgPidToAgent.get(cur);
            if (fgHit && (isNewWindow || !this.baselineFgPids.has(cur))) {
              return fgHit;
            }
            const termHit = termPidToAgent.get(cur);
            if (termHit && isNewWindow) {
              return termHit;
            }
            const p = procs.get(cur);
            if (!p || !p.ppid || p.ppid === cur) break;
            cur = p.ppid;
          }
        }

        const isWinHost = (this.deps.captureDeps?.platform ?? process.platform) === "win32";
        if (
          isNewWindow &&
          XSERVER_APP_RE.test(w.appName) &&
          (isWinHost || Boolean(this.lastCommandCtx?.isWsl) || Boolean(wslFgAgent))
        ) {
          return recentAgent ?? wslFgAgent;
        }
        return undefined;
      };

      for (const w of visible) {
        const matchedAgent = matchWindowAgent(w);
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
    _source: "terminal_input" | "user_send" | "agent_tool" | "foreground" = "terminal_input",
  ): void {
    if (!this.deps.hasRemoteViewers() || !commandText) return;
    this.lastCommandCtx = {
      agentKey: agent.key,
      at: Date.now(),
      isWsl: /\bwsl(?:\.exe)?\b|\bDISPLAY\s*=/i.test(commandText),
    };
    const liveCwd = this.deps.getTerminals().get(agent.localId)?.cwd || agent.cwd || undefined;
    const intents = extractAutoPortalIntents(commandText, liveCwd);
    for (const intent of intents) {
      void this.applyAutoPortalIntent(agent, intent).catch(() => {});
    }
    this.scheduleFollowupScans([350, 1000, 2200]);
  }

  private async applyAutoPortalIntent(agent: Agent, intent: AutoPortalIntent): Promise<void> {
    if (intent.type === "app_window") {
      const dedupKey = `${agent.key}\0win\0${intent.appHint.toLowerCase()}\0${intent.url ?? ""}`;
      if (this.checkAndMarkAutoDedup(dedupKey, 2500)) return;
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
      const wins = await this.capture.listWindows().catch(() => []);
      await this.detectAndOpenWindowPortal({
        agent,
        appHint: intent.app,
        urlHint: intent.url,
        beforeIds: new Set(wins.map((w) => w.id)),
        fallbackOpener: intent,
      });
      return;
    }

    if (intent.kind === "browser") {
      const url = intent.url || intent.target;
      if (!url) return;
      const wins = await this.capture.listWindows().catch(() => []);
      await this.detectAndOpenWindowPortal({
        agent,
        appHint: BROWSER_WINDOW_HINTS,
        urlHint: url,
        beforeIds: new Set(wins.map((w) => w.id)),
        titleHint: url,
      });
      return;
    }

    const target = intent.target;
    if (!target || !existsSync(target)) return;
    const existing = [...this.items.values()].find(
      (i) => i.agentKey === agent.key && i.kind === intent.kind && i.targetPath === target,
    );
    if (existing) {
      existing.updatedAt = Date.now();
      this.emitEvent("opened", existing);
    } else {
      await this.openPortal({
        agentKey: agent.key,
        kind: intent.kind,
        target,
        reveal: intent.reveal,
      });
    }

    if (intent.kind === "file" && !INLINE_FILE_EXT_RE.test(target)) {
      const wins = await this.capture.listWindows().catch(() => []);
      await this.detectAndOpenWindowPortal({
        agent,
        beforeIds: new Set(wins.map((w) => w.id)),
      });
    }
  }

  /** Detect `open` / `xdg-open` / `ego-browser` / MCP browser / file-display calls from Agent turns or shell tools. */
  inspectToolCallForPortal(agent: Agent, toolName: string, input: unknown): void {
    if (!this.deps.hasRemoteViewers() || !input || typeof input !== "object") return;
    const inp = input as Record<string, unknown>;

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
      const appHint = /ego/i.test(toolName)
        ? "ego lite"
        : /tabbit/i.test(toolName)
          ? "Tabbit"
          : BROWSER_WINDOW_HINTS;
      const dedupKey = `${agent.key}\0mcp\0${Array.isArray(appHint) ? "browser" : appHint}\0${url ?? ""}`;
      if (this.checkAndMarkAutoDedup(dedupKey, 2500)) return;
      void this.detectAndOpenWindowPortal({
        agent,
        appHint,
        titleHint: /ego/i.test(toolName) ? "ego lite 浏览器" : /tabbit/i.test(toolName) ? "Tabbit 浏览器" : undefined,
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
          this.observeSubmittedCommand(agent, joined, "foreground");
        }
      }
    }

    if (!screenText) return;
    if (/\[p\d+\s+"[^"]*"\s+\|\s+space\s+"/.test(screenText)) {
      const prevAt = this.lastForegroundCheckAt.get(agent.key) ?? 0;
      if (Date.now() - prevAt >= SCREEN_FOREGROUND_THROTTLE_MS) {
        this.lastForegroundCheckAt.set(agent.key, Date.now());
        this.observeSubmittedCommand(agent, "ego-browser nodejs", "foreground");
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
