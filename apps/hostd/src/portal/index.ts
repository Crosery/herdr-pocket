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
import { PortalHookServer, classifyTarget, ensurePortalShims, parseOpenerArgs, type HookOpenPayload } from "./shims.ts";
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
    if (!hasRemote && !isHeadless && payload.tool !== "herdr-pocket-open" && payload.tool !== "herdr-pocket-browser") {
      // No remote viewer connected and host has its own desktop: let native OS opener handle it.
      return { handled: false };
    }

    const parsed =
      payload.target
        ? classifyTarget(payload.target, { reveal: payload.reveal, cwd: payload.cwd })
        : parseOpenerArgs(payload.tool, payload.argv, payload.cwd);
    if (!parsed) return { handled: false };

    const agent = this.resolveAgentForHook(payload);
    const opened = await this.openPortal({
      agentKey: agent?.key,
      kind: parsed.kind,
      target: parsed.target,
      url: parsed.url,
      reveal: parsed.reveal,
      title: parsed.app ? `${parsed.app} · ${basename(parsed.target)}` : undefined,
    });
    return { handled: true, id: opened.item.id };
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

  /** Detect `open` / `xdg-open` / OAuth localhost hints from passive Uniflo tool calls. */
  inspectToolCallForPortal(agent: Agent, toolName: string, input: unknown): void {
    if (!this.deps.hasRemoteViewers()) return;
    if (!/bash|shell|exec|terminal/i.test(toolName) || !input || typeof input !== "object") return;
    const cmd = typeof (input as Record<string, unknown>).command === "string"
      ? (input as Record<string, unknown>).command as string
      : typeof (input as Record<string, unknown>).cmd === "string"
        ? (input as Record<string, unknown>).cmd as string
        : "";
    if (!cmd) return;
    const m = /\b(open\s+-R|open|xdg-open|gio\s+open)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(cmd);
    if (!m) return;
    const rawTarget = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!rawTarget || rawTarget.startsWith("-")) return;
    const reveal = /open\s+-R/i.test(m[1]!);
    const full = agent.cwd && !rawTarget.startsWith("/") && !/^https?:/i.test(rawTarget)
      ? resolve(agent.cwd, rawTarget)
      : rawTarget;
    if (!/^https?:/i.test(full) && !existsSync(full)) return;
    const dup = [...this.items.values()].find(
      (i) => i.agentKey === agent.key && (i.targetPath === full || i.url === full) && Date.now() - i.createdAt < 15_000,
    );
    if (dup) return;
    void this.openPortal({
      agentKey: agent.key,
      kind: /^https?:/i.test(full) ? "browser" : reveal ? "reveal" : /\.html?$/i.test(full) ? "html" : "file",
      target: full,
      reveal,
    }).catch(() => {});
  }

  /** Detect OAuth / localhost login URLs printed on active remote terminals and surface in PiP. */
  inspectScreenForOAuth(agent: Agent, screenText: string): void {
    if (!this.deps.hasRemoteViewers() || !screenText) return;
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
