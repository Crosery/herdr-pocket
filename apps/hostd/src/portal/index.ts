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
  getTerminals: () => Map<string, { address: string; cwd?: string | null; foreground?: { pid?: number } | null }>;
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
const BROWSER_WINDOW_HINTS = ["ego lite", "google chrome", "safari", "tabbit", "arc", "microsoft edge", "brave browser", "firefox", "chromium"];
const TERMINAL_APP_NAMES = new Set(["herdr", "herdr pocket", "ghostty", "iterm2", "terminal", "终端", "wezterm", "alacritty", "kitty", "warp"]);
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
    for (const id of [...this.streamWatchers.keys()]) this.unsubscribe(id);
    this.hookServer?.stop();
    this.hookServer = null;
    this.browser.closeAll();
  }

  async capabilities(): Promise<HostPortalCapabilities> {
    const hasCdpBrowser = await this.browser.hasBrowser().catch(() => false);
    const { port } = this.deps.getDirectInfo();
    return computeCapabilities({
      deps: this.deps.captureDeps,
      hasCdpBrowser,
      directPort: port,
    });
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

  private attachBrowserToWatcher(wId: string): void {
    const w = this.streamWatchers.get(wId);
    if (!w?.portalId) return;
    w.offBrowser?.();
    w.offBrowser = undefined;
    const sess = this.browser.get(w.portalId);
    if (sess) {
      w.offBrowser = sess.onFrame((frame) => {
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

    if (kind === "browser") {
      if (!url) throw new Error("需要提供网页 URL");
      try {
        const res = await this.browser.open(portalId, url);
        url = res.url;
        title = res.title || title;
      } catch {
        // Keep portal item open so viewer still sees URL & can fall back to OS window or local browser.
      }
    } else if (kind === "window") {
      const winId = opts.windowId || "screen:0";
      const wins = await this.capture.listWindows().catch(() => []);
      const hit = wins.find((w) => w.id === winId);
      if (hit) {
        title = opts.title?.trim() || `${hit.appName} · ${hit.title}`;
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
            : targetPath,
      ...(targetPath ? { targetPath } : {}),
      ...(parentDir ? { parentDir } : {}),
      ...(highlightName ? { highlightName } : {}),
      ...(url ? { url } : {}),
      ...(opts.windowId ? { windowId: opts.windowId } : kind === "window" ? { windowId: "screen:0" } : {}),
      ...(mime ? { mime } : {}),
      ...(size !== undefined ? { size } : {}),
      canInteract: kind === "browser" || kind === "window",
      transportHint,
      createdAt: now,
      updatedAt: now,
    };

    this.items.set(portalId, item);
    this.pruneItems();
    this.emitEvent("opened", item);
    for (const [wId, w] of this.streamWatchers) {
      if (w.portalId === portalId) this.attachBrowserToWatcher(wId);
    }
    return { item, ...(ticket ? { ticket } : {}) };
  }

  closePortal(portalId: string): void {
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
      const sess = this.browser.get(portalId);
      const frame = sess ? await sess.captureOnce() : null;
      if (frame) {
        if (frame.url && frame.url !== item.url) {
          item.url = frame.url;
          item.updatedAt = Date.now();
        }
        if (frame.title && frame.title !== item.title) {
          item.title = frame.title;
        }
      }
      return { frame, item };
    }
    if (item.kind === "window") {
      const cap = await this.capture.captureWindow(item.windowId || "screen:0");
      if (!cap) return { frame: null, item };
      const frame: PortalFramePayload = {
        portalId,
        seq: ++this.windowSeq,
        mime: cap.mime,
        data: cap.data,
        width: cap.width,
        height: cap.height,
        title: item.title,
        at: Date.now(),
      };
      item.width = cap.width;
      item.height = cap.height;
      item.updatedAt = frame.at;
      return { frame, item };
    }
    return { frame: null, item };
  }

  async sendInput(portalId: string, input: PortalInputAction): Promise<{ url?: string; title?: string }> {
    const item = this.items.get(portalId);
    if (!item) throw new Error("回传窗口不存在或已关闭");
    if (item.kind === "browser") {
      const sess = this.browser.get(portalId);
      if (!sess) throw new Error("远端浏览器未启动或当前环境未安装 Chromium/Chrome");
      const res = await sess.dispatchInput(input);
      if (res.url) item.url = res.url;
      if (res.title) item.title = res.title;
      item.updatedAt = Date.now();
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
      if (item?.kind === "window") {
        let busy = false;
        const intervalMs = Math.max(60, Math.round(1000 / Math.max(1, fps)));
        entry.timer = setInterval(() => {
          if (busy) return;
          busy = true;
          void this.captureFrame(params.portalId!)
            .then(({ frame }) => {
              if (frame) send({ kind: "portal_frame", ...frame });
            })
            .catch(() => {})
            .finally(() => {
              busy = false;
            });
        }, intervalMs);
        entry.timer.unref?.();
        void this.captureFrame(params.portalId).then(({ frame }) => {
          if (frame) send({ kind: "portal_frame", ...frame });
        });
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

    for (const ms of delays) {
      if (ms > 0) await delayMs(ms);
      const wins = await this.capture.listWindows().catch(() => []);
      const hit = this.matchWindowByHint(wins, hints, opts.beforeIds);
      if (!hit) continue;
      const cap = await this.capture.captureWindow(hit.id).catch(() => null);
      if (!cap) continue;

      const existing = [...this.items.values()].find(
        (i) => i.agentKey === opts.agent?.key && i.kind === "window" && i.windowId === hit.id,
      );
      const nextTitle = opts.titleHint || `${hit.appName}${hit.title && hit.title !== hit.appName ? ` · ${hit.title}` : ""}`;
      if (existing) {
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
      this.pushWindowPortalUpdate(item, { title: nextTitle, url: opts.urlHint, cap });
      return item;
    }

    if (opts.urlHint) {
      const existingBrowser = [...this.items.values()].find(
        (i) => i.agentKey === opts.agent?.key && i.kind === "browser",
      );
      if (existingBrowser && existingBrowser.url === opts.urlHint) {
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
    return null;
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
    const liveCwd = this.deps.getTerminals().get(agent.localId)?.cwd || agent.cwd || undefined;
    const intents = extractAutoPortalIntents(commandText, liveCwd);
    for (const intent of intents) {
      void this.applyAutoPortalIntent(agent, intent).catch(() => {});
    }
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
