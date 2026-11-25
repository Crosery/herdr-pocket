import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "@herdr-pocket/update";
import { WebSocket } from "ws";
import type { PortalFramePayload, PortalInputAction } from "@herdr-pocket/protocol";
import { findPrograms } from "../create.ts";

const VIEWPORT_W = 1280;
const VIEWPORT_H = 820;
const IDLE_SHUTDOWN_MS = 60_000;

function findPlaywrightBinary(roots: string[], prefix: string, relCandidates: string[]): string | null {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let dirs: string[];
    try {
      dirs = readdirSync(root)
        .filter((name) => name.startsWith(prefix))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      for (const rel of relCandidates) {
        const candidate = join(root, dir, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

export async function findChromiumBinary(platform = process.platform, env = process.env): Promise<string | null> {
  if (env.HERDR_POCKET_CHROME_BIN && existsSync(env.HERDR_POCKET_CHROME_BIN)) {
    return env.HERDR_POCKET_CHROME_BIN;
  }
  const home = env.HOME || homedir();
  if (platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Arc.app/Contents/MacOS/Arc",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
      join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
      join(home, "Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
      join(home, "Applications/Arc.app/Contents/MacOS/Arc"),
    ];
    for (const c of candidates) if (existsSync(c)) return c;

    const pwRoots = [join(home, "Library/Caches/ms-playwright")];
    const pwShell = findPlaywrightBinary(pwRoots, "chromium_headless_shell-", [
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-headless-shell-mac-x64/chrome-headless-shell",
      "chrome-mac/headless_shell",
    ]);
    if (pwShell) return pwShell;
    const pwFull = findPlaywrightBinary(pwRoots, "chromium-", [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ]);
    if (pwFull) return pwFull;

    const extraApps = [
      "/Applications/Tabbit Browser.app/Contents/MacOS/Tabbit Browser",
      "/Applications/Tabbit.app/Contents/MacOS/Tabbit",
      "/Applications/ego lite.app/Contents/MacOS/ego lite",
      join(home, "Applications/Tabbit Browser.app/Contents/MacOS/Tabbit Browser"),
      join(home, "Applications/Tabbit.app/Contents/MacOS/Tabbit"),
      join(home, "Applications/ego lite.app/Contents/MacOS/ego lite"),
    ];
    for (const c of extraApps) if (existsSync(c)) return c;
  } else if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = env.LOCALAPPDATA || join(home, "AppData\\Local");
    const candidates = [
      join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
      join(local, "Google\\Chrome\\Application\\chrome.exe"),
      join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
      join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
      join(local, "Chromium\\Application\\chrome.exe"),
    ];
    for (const c of candidates) if (existsSync(c)) return c;

    const pwWin = findPlaywrightBinary([join(local, "ms-playwright")], "chromium-", [
      "chrome-win/chrome.exe",
      "chrome-win64/chrome.exe",
    ]);
    if (pwWin) return pwWin;
    const pwWinShell = findPlaywrightBinary([join(local, "ms-playwright")], "chromium_headless_shell-", [
      "chrome-headless-shell-win64/chrome-headless-shell.exe",
    ]);
    if (pwWinShell) return pwWinShell;
  }

  const binNames = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
  ];
  const bins = await findPrograms(binNames);
  for (const name of binNames) {
    const p = bins.get(name);
    if (p) return p;
  }
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"]) {
    if (existsSync(p)) return p;
  }
  if (platform === "linux") {
    const cacheRoot = env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "ms-playwright") : join(home, ".cache/ms-playwright");
    const pwShell = findPlaywrightBinary([cacheRoot], "chromium_headless_shell-", [
      "chrome-linux/chrome-headless-shell",
      "chrome-headless-shell-linux-x64/chrome-headless-shell",
      "chrome-headless-shell-linux-arm64/chrome-headless-shell",
    ]);
    if (pwShell) return pwShell;
    const pwFull = findPlaywrightBinary([cacheRoot], "chromium-", [
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
    ]);
    if (pwFull) return pwFull;
  }
  return null;
}

interface CdpPending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class CdpSession {
  readonly portalId: string;
  readonly targetId: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, CdpPending>();
  private seq = 0;
  private latestFrame: PortalFramePayload | null = null;
  private listeners = new Set<(frame: PortalFramePayload) => void>();
  private loadResolvers = new Set<() => void>();
  private postLoadTimer: NodeJS.Timeout | null = null;
  private captureInflight: Promise<PortalFramePayload | null> | null = null;
  private screencastMaxW = VIEWPORT_W;
  private screencastQuality = 74;
  private moveInFlight = false;
  private pendingMove: { x: number; y: number; button: string } | null = null;
  private wheelInFlight = false;
  private pendingWheel: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
  url: string;
  title: string;
  canGoBack = false;
  canGoForward = false;
  closed = false;

  constructor(portalId: string, targetId: string, url: string) {
    this.portalId = portalId;
    this.targetId = targetId;
    this.url = url;
    this.title = url;
  }

  onFrame(cb: (frame: PortalFramePayload) => void): () => void {
    this.listeners.add(cb);
    if (this.latestFrame) cb(this.latestFrame);
    return () => this.listeners.delete(cb);
  }

  getLatestFrame(): PortalFramePayload | null {
    return this.latestFrame;
  }

  private emitFrame(frame: PortalFramePayload): void {
    this.latestFrame = frame;
    for (const cb of this.listeners) cb(frame);
  }

  private signalLoaded(): void {
    for (const fn of this.loadResolvers) fn();
    this.loadResolvers.clear();
    if (this.closed) return;
    if (this.postLoadTimer) clearTimeout(this.postLoadTimer);
    this.postLoadTimer = setTimeout(() => {
      this.postLoadTimer = null;
      if (!this.closed) void this.captureOnce(true);
    }, 120);
    this.postLoadTimer.unref?.();
  }

  private waitForLoadSignal(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.loadResolvers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.loadResolvers.add(done);
    });
  }

  async connect(pageWsUrl: string): Promise<void> {
    const ws = new WebSocket(pageWsUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || "CDP error"));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === "Page.screencastFrame" && msg.params?.data) {
        const sessionId = Number(msg.params.sessionId ?? 0);
        void this.cdp("Page.screencastFrameAck", { sessionId }).catch(() => {});
        const meta = msg.params.metadata ?? {};
        const dataStr = String(msg.params.data);
        const rawBytes = Buffer.from(dataStr, "base64");
        this.emitFrame({
          portalId: this.portalId,
          seq: ++this.seq,
          mime: "image/jpeg",
          data: dataStr,
          rawBytes,
          byteLength: rawBytes.byteLength,
          width: Number(meta.deviceWidth ?? VIEWPORT_W),
          height: Number(meta.deviceHeight ?? VIEWPORT_H),
          url: this.url,
          title: this.title,
          canGoBack: this.canGoBack,
          canGoForward: this.canGoForward,
          at: Date.now(),
        });
      } else if (msg.method === "Page.frameNavigated" && !msg.params?.frame?.parentId) {
        const nextUrl = msg.params?.frame?.url;
        if (typeof nextUrl === "string" && nextUrl && !nextUrl.startsWith("chrome-error://") && nextUrl !== "about:blank") {
          this.url = nextUrl;
        }
        void this.refreshNavState();
      } else if (msg.method === "Page.loadEventFired" || msg.method === "Page.frameStoppedLoading") {
        void this.refreshNavState();
        this.signalLoaded();
      } else if (msg.method === "Runtime.executionContextCreated") {
        void this.refreshNavState();
      }
    });

    ws.on("close", () => {
      this.close();
    });

    await this.cdp("Page.enable", {});
    await this.cdp("Runtime.enable", {});
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT_W,
      height: VIEWPORT_H,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => {});
    await this.cdp("Page.startScreencast", {
      format: "jpeg",
      quality: 74,
      maxWidth: VIEWPORT_W,
      maxHeight: VIEWPORT_H,
      everyNthFrame: 1,
    });

    const loadWait = this.waitForLoadSignal(1200);
    await this.cdp("Page.navigate", { url: this.url }).catch(() => {});
    await loadWait;
    await this.refreshNavState();
    await this.captureOnce(true);
  }

  private async refreshNavState(): Promise<void> {
    try {
      const h = await this.cdp("Page.getNavigationHistory", {});
      const idx = Number(h?.currentIndex ?? 0);
      const entries = Array.isArray(h?.entries) ? h.entries : [];
      const cur = entries[idx];
      if (cur?.url && !String(cur.url).startsWith("chrome-error://") && cur.url !== "about:blank") {
        this.url = String(cur.url);
      }
      if (cur?.title && (!cur.url || !String(cur.url).startsWith("chrome-error://"))) {
        this.title = String(cur.title);
      }
      this.canGoBack = idx > 0;
      this.canGoForward = idx >= 0 && idx < entries.length - 1;
    } catch {
      // ignore
    }
  }

  private cdp(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP 未连接"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async updateScreencastConfig(opts: { maxWidth?: number; quality?: number }): Promise<void> {
    if (this.closed) return;
    const nextQ = Math.min(88, Math.max(38, Math.round(opts.quality ?? this.screencastQuality)));
    const nextW = Math.min(VIEWPORT_W, Math.max(640, Math.round(opts.maxWidth ?? this.screencastMaxW)));
    if (nextQ === this.screencastQuality && nextW === this.screencastMaxW) return;
    this.screencastQuality = nextQ;
    this.screencastMaxW = nextW;
    const nextH = Math.max(360, Math.round((nextW * VIEWPORT_H) / VIEWPORT_W));
    await this.cdp("Page.startScreencast", {
      format: "jpeg",
      quality: nextQ,
      maxWidth: nextW,
      maxHeight: nextH,
      everyNthFrame: 1,
    }).catch(() => {});
  }

  async captureOnce(force = false): Promise<PortalFramePayload | null> {
    if (!force && this.latestFrame && Date.now() - this.latestFrame.at < 250) {
      return this.latestFrame;
    }
    if (this.captureInflight) return this.captureInflight;
    const run = (async () => {
      try {
        const r = await this.cdp("Page.captureScreenshot", { format: "jpeg", quality: this.screencastQuality });
        if (typeof r?.data === "string" && r.data) {
          const rawBytes = Buffer.from(r.data, "base64");
          const frame: PortalFramePayload = {
            portalId: this.portalId,
            seq: ++this.seq,
            mime: "image/jpeg",
            data: r.data,
            rawBytes,
            byteLength: rawBytes.byteLength,
            width: VIEWPORT_W,
            height: VIEWPORT_H,
            url: this.url,
            title: this.title,
            canGoBack: this.canGoBack,
            canGoForward: this.canGoForward,
            at: Date.now(),
          };
          this.emitFrame(frame);
          return frame;
        }
      } catch {
        // ignore
      }
      return this.latestFrame;
    })().finally(() => {
      if (this.captureInflight === run) this.captureInflight = null;
    });
    this.captureInflight = run;
    return run;
  }

  private flushPendingMove(): void {
    if (this.closed || this.moveInFlight || !this.pendingMove) return;
    const next = this.pendingMove;
    this.pendingMove = null;
    this.moveInFlight = true;
    void this.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: next.x,
      y: next.y,
      button: next.button,
    })
      .catch(() => {})
      .finally(() => {
        this.moveInFlight = false;
        if (!this.closed && this.pendingMove) this.flushPendingMove();
      });
  }

  private flushPendingWheel(): void {
    if (this.closed || this.wheelInFlight || !this.pendingWheel) return;
    const next = this.pendingWheel;
    this.pendingWheel = null;
    this.wheelInFlight = true;
    void this.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: next.x,
      y: next.y,
      deltaX: Math.round(next.deltaX),
      deltaY: Math.round(next.deltaY),
    })
      .catch(() => {})
      .finally(() => {
        this.wheelInFlight = false;
        if (!this.closed && this.pendingWheel) this.flushPendingWheel();
      });
  }

  async dispatchInput(input: PortalInputAction): Promise<{ url?: string; title?: string }> {
    const w = this.latestFrame?.width ?? VIEWPORT_W;
    const h = this.latestFrame?.height ?? VIEWPORT_H;
    const clampXY = (nx: number, ny: number) => ({
      x: Math.round(Math.min(1, Math.max(0, nx)) * w),
      y: Math.round(Math.min(1, Math.max(0, ny)) * h),
    });

    if (input.type === "pointer") {
      const { x, y } = clampXY(input.nx, input.ny);
      const button = input.button ?? "left";
      if (input.action === "move" || input.action === "drag") {
        this.pendingMove = { x, y, button: input.action === "drag" ? button : "none" };
        this.flushPendingMove();
      } else if (input.action === "down") {
        this.pendingMove = null;
        await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
      } else if (input.action === "up") {
        this.pendingMove = null;
        await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
      } else {
        this.pendingMove = null;
        const count = input.action === "dblclick" ? 2 : 1;
        await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count });
        await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count });
      }
    } else if (input.type === "wheel") {
      const { x, y } = clampXY(input.nx, input.ny);
      if (this.pendingWheel) {
        this.pendingWheel.x = x;
        this.pendingWheel.y = y;
        this.pendingWheel.deltaX += input.deltaX;
        this.pendingWheel.deltaY += input.deltaY;
      } else {
        this.pendingWheel = { x, y, deltaX: input.deltaX, deltaY: input.deltaY };
      }
      this.flushPendingWheel();
    } else if (input.type === "text") {
      if (input.text) await this.cdp("Input.insertText", { text: input.text });
    } else if (input.type === "key") {
      const key = input.key;
      const mods = (input.modifiers ?? []).reduce((mask, m) => {
        const k = m.toLowerCase();
        if (k === "alt" || k === "option") return mask | 1;
        if (k === "ctrl" || k === "control") return mask | 2;
        if (k === "meta" || k === "cmd" || k === "command") return mask | 4;
        if (k === "shift") return mask | 8;
        return mask;
      }, 0);
      await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers: mods });
      await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers: mods });
    } else if (input.type === "navigate") {
      if (input.action === "reload") {
        const loadWait = this.waitForLoadSignal(1200);
        await this.cdp("Page.reload", {});
        await loadWait;
      } else if (input.action === "goto" && input.url) {
        const next = /^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`;
        const loadWait = this.waitForLoadSignal(1200);
        await this.cdp("Page.navigate", { url: next });
        this.url = next;
        await loadWait;
      } else if (input.action === "back" || input.action === "forward") {
        const hist = await this.cdp("Page.getNavigationHistory", {});
        const idx = Number(hist?.currentIndex ?? 0);
        const entries = Array.isArray(hist?.entries) ? hist.entries : [];
        const target = entries[input.action === "back" ? idx - 1 : idx + 1];
        if (target?.id !== undefined) {
          const loadWait = this.waitForLoadSignal(1200);
          await this.cdp("Page.navigateToHistoryEntry", { entryId: target.id });
          await loadWait;
        }
      }
      await this.refreshNavState();
      await this.captureOnce(true);
    }
    return { url: this.url, title: this.title };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.postLoadTimer) {
      clearTimeout(this.postLoadTimer);
      this.postLoadTimer = null;
    }
    for (const fn of this.loadResolvers) fn();
    this.loadResolvers.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("浏览器已关闭"));
    }
    this.pending.clear();
    this.listeners.clear();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

export class CdpBrowserPool {
  private sessions = new Map<string, CdpSession>();
  private profileRoot: string;
  private runtimeDir: string;
  private browserProc: ChildProcess | null = null;
  private browserWs: WebSocket | null = null;
  private browserHost: string | null = null;
  private browserPending = new Map<number, CdpPending>();
  private browserNextId = 1;
  private browserStarting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private prunedStale = false;

  constructor(profileRoot = join(stateDir(), "portal-chrome")) {
    this.profileRoot = profileRoot;
    this.runtimeDir = join(this.profileRoot, `runtime-${process.pid}`);
  }

  async hasBrowser(): Promise<boolean> {
    return Boolean(await findChromiumBinary());
  }

  get(portalId: string): CdpSession | undefined {
    const s = this.sessions.get(portalId);
    return s && !s.closed ? s : undefined;
  }

  private pruneStaleRuntimeDirs(): void {
    if (this.prunedStale) return;
    this.prunedStale = true;
    if (!existsSync(this.profileRoot)) return;
    try {
      for (const entry of readdirSync(this.profileRoot)) {
        const m = /^runtime-(\d+)$/.exec(entry);
        if (!m?.[1]) continue;
        const pid = Number(m[1]);
        if (!pid || pid === process.pid) continue;
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (err) {
          alive = (err as { code?: string })?.code === "EPERM";
        }
        if (!alive) {
          rmSync(join(this.profileRoot, entry), { recursive: true, force: true });
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private browserCdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("远端浏览器通道未连接"));
    }
    const id = this.browserNextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.browserPending.delete(id);
        reject(new Error(`Browser CDP ${method} 超时`));
      }, 10_000);
      this.browserPending.set(id, { resolve, reject, timer });
      this.browserWs!.send(JSON.stringify({ id, method, params }));
    });
  }

  private cleanupSharedBrowser(killProc = true): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const p of this.browserPending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("浏览器已关闭"));
    }
    this.browserPending.clear();
    for (const s of this.sessions.values()) {
      s.close();
    }
    this.sessions.clear();
    try {
      this.browserWs?.close();
    } catch {
      // ignore
    }
    this.browserWs = null;
    this.browserHost = null;
    const proc = this.browserProc;
    this.browserProc = null;
    if (killProc && proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  private async ensureSharedBrowser(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (
      this.browserProc &&
      this.browserProc.exitCode === null &&
      !this.browserProc.killed &&
      this.browserWs?.readyState === WebSocket.OPEN &&
      this.browserHost
    ) {
      return;
    }
    if (this.browserStarting) return this.browserStarting;

    const startPromise = (async () => {
      this.cleanupSharedBrowser(true);
      const bin = await findChromiumBinary();
      if (!bin) {
        throw new Error("这台电脑上没有找到 Chrome / Chromium / Edge，可切换为系统窗口回传或在本机打开链接");
      }
      this.pruneStaleRuntimeDirs();
      mkdirSync(this.runtimeDir, { recursive: true });
      const args = [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${this.runtimeDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--hide-scrollbars",
        "--mute-audio",
        `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
        ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
        "about:blank",
      ];
      const proc = /\.[mc]?js$/i.test(bin)
        ? spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
        : spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      this.browserProc = proc;

      const wsEndpoint = await new Promise<string>((resolve, reject) => {
        let settled = false;
        let buf = "";
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("启动内置远端浏览器超时"));
        }, 15_000);

        proc.once("exit", (code) => {
          if (this.browserProc === proc) {
            this.cleanupSharedBrowser(false);
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`远端浏览器提前退出 (${code ?? "null"})`));
        });

        proc.once("error", (err) => {
          if (this.browserProc === proc) {
            this.cleanupSharedBrowser(false);
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });

        proc.stderr?.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const m = /DevTools listening on (ws:\/\/[^\s]+)/i.exec(buf);
          if (m?.[1] && !settled) {
            settled = true;
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
      });

      const browserUrl = new URL(wsEndpoint);
      this.browserHost = browserUrl.host;
      const bws = new WebSocket(wsEndpoint);
      this.browserWs = bws;
      await new Promise<void>((resolve, reject) => {
        bws.once("open", () => resolve());
        bws.once("error", reject);
      });

      bws.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (typeof msg.id === "number") {
          const p = this.browserPending.get(msg.id);
          if (!p) return;
          this.browserPending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || "Browser CDP error"));
          else p.resolve(msg.result);
        }
      });

      bws.on("close", () => {
        if (this.browserWs === bws) {
          this.cleanupSharedBrowser(true);
        }
      });
    })()
      .catch((err) => {
        this.cleanupSharedBrowser(true);
        throw err;
      })
      .finally(() => {
        if (this.browserStarting === startPromise) {
          this.browserStarting = null;
        }
      });

    this.browserStarting = startPromise;
    return startPromise;
  }

  private async resolvePageWsUrl(targetId: string): Promise<string> {
    if (!this.browserHost) throw new Error("远端浏览器未就绪");
    const directUrl = `ws://${this.browserHost}/devtools/page/${targetId}`;
    const listUrl = `http://${this.browserHost}/json/list`;
    for (let i = 0; i < 8; i += 1) {
      try {
        const res = await fetch(listUrl, { signal: AbortSignal.timeout(1500) });
        const targets = (await res.json()) as Array<{ id?: string; type?: string; webSocketDebuggerUrl?: string }>;
        const match = targets.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
        if (match?.webSocketDebuggerUrl) return match.webSocketDebuggerUrl;
      } catch {
        // retry shortly
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    return directUrl;
  }

  async open(portalId: string, url: string): Promise<{ url: string; title: string }> {
    const existing = this.get(portalId);
    if (existing) {
      await existing.dispatchInput({ type: "navigate", action: "goto", url });
      return { url: existing.url, title: existing.title };
    }

    await this.ensureSharedBrowser();
    const created = (await this.browserCdp("Target.createTarget", { url: "about:blank" })) as { targetId?: string };
    const targetId = created?.targetId;
    if (!targetId) throw new Error("无法创建远端浏览器标签页");

    const session = new CdpSession(portalId, targetId, url);
    try {
      const pageWsUrl = await this.resolvePageWsUrl(targetId);
      await session.connect(pageWsUrl);
      this.sessions.set(portalId, session);
      return { url: session.url, title: session.title };
    } catch (err) {
      session.close();
      void this.browserCdp("Target.closeTarget", { targetId }).catch(() => {});
      throw err;
    }
  }

  close(portalId: string): void {
    const s = this.sessions.get(portalId);
    if (!s) return;
    this.sessions.delete(portalId);
    s.close();
    void this.browserCdp("Target.closeTarget", { targetId: s.targetId }).catch(() => {});
    if (this.sessions.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.sessions.size === 0) {
          this.cleanupSharedBrowser(true);
          try {
            rmSync(this.runtimeDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      }, IDLE_SHUTDOWN_MS);
      this.idleTimer.unref?.();
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      const s = this.sessions.get(id);
      if (s) {
        s.close();
        void this.browserCdp("Target.closeTarget", { targetId: s.targetId }).catch(() => {});
      }
    }
    this.sessions.clear();
    this.cleanupSharedBrowser(true);
    try {
      rmSync(this.runtimeDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
