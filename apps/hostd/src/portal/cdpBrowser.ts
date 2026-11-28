import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir } from "@herdr-pocket/update";
import { WebSocket } from "ws";
import type {
  BrowserCursorOverlay,
  BrowserNetworkBodyResult,
  BrowserNetworkEntry,
  PortalFramePayload,
  PortalInputAction,
} from "@herdr-pocket/protocol";
import { findPrograms } from "../create.ts";

const VIEWPORT_W = 1280;
const VIEWPORT_H = 820;
const IDLE_SHUTDOWN_MS = 180_000;
const MAX_NETWORK_ENTRIES = 300;
const MAX_BODY_CHARS = 256 * 1024;

export interface FindChromiumOptions {
  /** Prefer headless-shell binary first (zero Dock icon / zero focus steal on macOS/Windows/Linux). */
  preferHeadlessShell?: boolean;
  /** Require a full GUI browser binary (skip headless-shell, e.g. for headed pop-out windows). */
  headedOnly?: boolean;
}

export interface CdpKeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Record<string, CdpKeyDef> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
};

for (let i = 1; i <= 12; i += 1) {
  SPECIAL_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, windowsVirtualKeyCode: 111 + i };
}

/**
 * Resolves a Playwright/Ego-style key or chord (e.g. `"Enter"`, `"ControlOrMeta+a"`, `"Shift+Tab"`)
 * into real CDP `Input.dispatchKeyEvent` fields (`key`, `code`, `windowsVirtualKeyCode`, `modifiers`, `text`).
 */
export function parseCdpKeyChord(
  rawChord: string,
  extraModifiers: string[] = [],
  platform = process.platform,
): { def: CdpKeyDef; modifiers: number } {
  const parts = rawChord
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  let modMask = 0;
  const applyMod = (m: string): boolean => {
    const low = m.toLowerCase();
    if (low === "alt" || low === "option") {
      modMask |= 1;
      return true;
    }
    if (low === "ctrl" || low === "control") {
      modMask |= 2;
      return true;
    }
    if (low === "meta" || low === "cmd" || low === "command" || low === "super") {
      modMask |= 4;
      return true;
    }
    if (low === "controlormeta") {
      modMask |= platform === "darwin" ? 4 : 2;
      return true;
    }
    if (low === "shift") {
      modMask |= 8;
      return true;
    }
    return false;
  };
  for (const m of extraModifiers) applyMod(m);

  let mainKey = rawChord === " " ? " " : parts[parts.length - 1] ?? rawChord;
  if (parts.length > 1) {
    for (let i = 0; i < parts.length - 1; i += 1) {
      applyMod(parts[i]!);
    }
    mainKey = parts[parts.length - 1]!;
  }

  const low = mainKey.toLowerCase();
  const special = SPECIAL_KEYS[low];
  if (special) return { def: special, modifiers: modMask };

  if (mainKey.length === 1) {
    const ch = mainKey;
    const upper = ch.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(ch);
    const vk = isLetter || isDigit ? upper.charCodeAt(0) : ch.charCodeAt(0);
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${ch}` : "";
    return {
      def: {
        key: ch,
        code,
        windowsVirtualKeyCode: vk,
        ...(modMask === 0 || modMask === 8 ? { text: ch } : {}),
      },
      modifiers: modMask,
    };
  }

  return {
    def: { key: mainKey, code: mainKey, windowsVirtualKeyCode: 0 },
    modifiers: modMask,
  };
}

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

export async function findChromiumBinary(
  platform = process.platform,
  env = process.env,
  opts: FindChromiumOptions = {},
): Promise<string | null> {
  if (env.HERDR_POCKET_CHROME_BIN && existsSync(env.HERDR_POCKET_CHROME_BIN)) {
    return env.HERDR_POCKET_CHROME_BIN;
  }
  const home = env.HOME || homedir();
  const findPwHeadlessShell = (): string | null => {
    if (opts.headedOnly) return null;
    if (platform === "darwin") {
      return findPlaywrightBinary([join(home, "Library/Caches/ms-playwright")], "chromium_headless_shell-", [
        "chrome-headless-shell-mac-arm64/chrome-headless-shell",
        "chrome-headless-shell-mac-x64/chrome-headless-shell",
        "chrome-mac/headless_shell",
      ]);
    }
    if (platform === "win32") {
      const local = env.LOCALAPPDATA || join(home, "AppData\\Local");
      return findPlaywrightBinary([join(local, "ms-playwright")], "chromium_headless_shell-", [
        "chrome-headless-shell-win64/chrome-headless-shell.exe",
      ]);
    }
    const cacheRoot = env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "ms-playwright") : join(home, ".cache/ms-playwright");
    return findPlaywrightBinary([cacheRoot], "chromium_headless_shell-", [
      "chrome-linux/chrome-headless-shell",
      "chrome-headless-shell-linux-x64/chrome-headless-shell",
      "chrome-headless-shell-linux-arm64/chrome-headless-shell",
    ]);
  };

  if (opts.preferHeadlessShell && !opts.headedOnly) {
    const shellBin = findPwHeadlessShell();
    if (shellBin) return shellBin;
  }

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

    const pwShell = findPwHeadlessShell();
    if (pwShell) return pwShell;
    const pwFull = findPlaywrightBinary([join(home, "Library/Caches/ms-playwright")], "chromium-", [
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
    const pwWinShell = findPwHeadlessShell();
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
    const pwShell = findPwHeadlessShell();
    if (pwShell) return pwShell;
    const cacheRoot = env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "ms-playwright") : join(home, ".cache/ms-playwright");
    const pwFull = findPlaywrightBinary([cacheRoot], "chromium-", [
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
    ]);
    if (pwFull) return pwFull;
  }
  return null;
}

function matchUrlFilter(url: string, pattern?: string): boolean {
  if (!pattern || !pattern.trim()) return true;
  const p = pattern.trim();
  if (p.startsWith("/") && p.lastIndexOf("/") > 0) {
    const last = p.lastIndexOf("/");
    try {
      const re = new RegExp(p.slice(1, last), p.slice(last + 1) || "i");
      return re.test(url);
    } catch {
      // fall through
    }
  }
  if (p.includes("*")) {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    try {
      return new RegExp(escaped, "i").test(url);
    } catch {
      // fall through
    }
  }
  return url.toLowerCase().includes(p.toLowerCase());
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

interface CdpPending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpDialogState {
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
}

export class CdpSession {
  readonly portalId: string;
  readonly targetId: string;
  readonly browserContextId?: string;
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
  private screencastQuality = 78;
  private moveInFlight = false;
  private pendingMove: { x: number; y: number; button: string } | null = null;
  private wheelInFlight = false;
  private pendingWheel: { x: number; y: number; deltaX: number; deltaY: number } | null = null;
  private networkSeq = 0;
  private docWatermarkSeq = 0;
  private networkEntries: BrowserNetworkEntry[] = [];
  private networkById = new Map<string, BrowserNetworkEntry>();
  private networkWatchers = new Set<(entry: BrowserNetworkEntry) => void>();
  private networkChangeListeners = new Set<() => void>();
  private activeDialog: CdpDialogState | null = null;
  private cursorOverlay: BrowserCursorOverlay | null = null;
  viewportW = VIEWPORT_W;
  viewportH = VIEWPORT_H;
  url: string;
  title: string;
  canGoBack = false;
  canGoForward = false;
  closed = false;

  constructor(portalId: string, targetId: string, url: string, browserContextId?: string) {
    this.portalId = portalId;
    this.targetId = targetId;
    this.url = url;
    this.title = url;
    this.browserContextId = browserContextId;
  }

  onFrame(cb: (frame: PortalFramePayload) => void): () => void {
    this.listeners.add(cb);
    if (this.latestFrame) cb(this.latestFrame);
    return () => this.listeners.delete(cb);
  }

  onNetworkChange(cb: () => void): () => void {
    this.networkChangeListeners.add(cb);
    return () => this.networkChangeListeners.delete(cb);
  }

  getLatestFrame(): PortalFramePayload | null {
    return this.latestFrame;
  }

  getDialog(): CdpDialogState | null {
    return this.activeDialog;
  }

  setCursorOverlay(cursor: BrowserCursorOverlay | null): void {
    this.cursorOverlay = cursor;
  }

  getCursorOverlay(): BrowserCursorOverlay | null {
    return this.cursorOverlay;
  }

  getNetworkCount(): number {
    return this.networkEntries.length;
  }

  listNetwork(opts?: { filter?: string; resourceTypes?: string[]; limit?: number }): BrowserNetworkEntry[] {
    const types = opts?.resourceTypes?.length
      ? new Set(opts.resourceTypes.map((t) => t.trim().toLowerCase()))
      : null;
    const filtered = this.networkEntries.filter((e) => {
      if (types && !types.has((e.resourceType ?? "other").toLowerCase())) return false;
      return matchUrlFilter(e.url, opts?.filter);
    });
    const limit = Math.max(1, Math.min(MAX_NETWORK_ENTRIES, opts?.limit ?? 120));
    return filtered.slice(-limit).map((e) => ({ ...e }));
  }

  clearNetwork(): void {
    this.networkEntries = [];
    this.networkById.clear();
    for (const cb of this.networkChangeListeners) cb();
  }

  async getNetworkBody(requestId: string): Promise<BrowserNetworkBodyResult> {
    const meta = this.networkById.get(requestId);
    const res = await this.cdp("Network.getResponseBody", { requestId });
    const rawBody = typeof res?.body === "string" ? res.body : "";
    const base64Encoded = Boolean(res?.base64Encoded);
    let body = rawBody;
    let decodedBase64 = false;
    if (base64Encoded && meta?.mimeType && /json|text|xml|javascript|html|css|form/i.test(meta.mimeType)) {
      try {
        body = Buffer.from(rawBody, "base64").toString("utf8");
        decodedBase64 = true;
      } catch {
        // keep base64
      }
    }
    const truncated = body.length > MAX_BODY_CHARS;
    if (truncated) body = body.slice(0, MAX_BODY_CHARS);
    let json: unknown = undefined;
    if (!base64Encoded || decodedBase64) {
      const trimmed = body.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && !truncated) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          // non-JSON text
        }
      }
    }
    return {
      requestId,
      url: meta?.url ?? "",
      status: meta?.status,
      mimeType: meta?.mimeType,
      base64Encoded: base64Encoded && !decodedBase64,
      body,
      ...(truncated ? { truncated: true } : {}),
      ...(json !== undefined ? { json } : {}),
    };
  }

  async waitForResponse(
    filter: string,
    opts?: { includeBuffered?: boolean; status?: number; timeoutMs?: number; includeBody?: boolean },
  ): Promise<{
    entry: BrowserNetworkEntry;
    body?: BrowserNetworkBodyResult;
  }> {
    const includeBuffered = opts?.includeBuffered !== false;
    const needBody = opts?.includeBody !== false;
    const timeoutMs = Math.max(200, Math.min(60_000, opts?.timeoutMs ?? 12_000));
    const matches = (e: BrowserNetworkEntry): boolean => {
      if (needBody ? !e.completed : !e.completed && e.status === undefined) return false;
      if (opts?.status !== undefined && e.status !== opts.status) return false;
      return matchUrlFilter(e.url, filter);
    };

    if (includeBuffered) {
      for (let i = this.networkEntries.length - 1; i >= 0; i -= 1) {
        const e = this.networkEntries[i]!;
        if (e.seq < this.docWatermarkSeq) break;
        if (matches(e)) {
          const body = opts?.includeBody !== false ? await this.getNetworkBody(e.requestId).catch(() => undefined) : undefined;
          return { entry: { ...e }, ...(body ? { body } : {}) };
        }
      }
    }

    const entry = await new Promise<BrowserNetworkEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.networkWatchers.delete(onEntry);
        const cachedHits = this.networkEntries
          .filter((e) => e.fromCache && matchUrlFilter(e.url, filter))
          .slice(-3)
          .map((e) => e.url);
        const hint = cachedHits.length
          ? `（检测到缓存命中：${cachedHits.join(", ")}）`
          : "";
        reject(new Error(`等待接口响应超时（${timeoutMs}ms）：${filter}${hint}`));
      }, timeoutMs);
      timer.unref?.();
      const onEntry = (e: BrowserNetworkEntry) => {
        if (!matches(e)) return;
        clearTimeout(timer);
        this.networkWatchers.delete(onEntry);
        resolve({ ...e });
      };
      this.networkWatchers.add(onEntry);
    });

    const body = opts?.includeBody !== false ? await this.getNetworkBody(entry.requestId).catch(() => undefined) : undefined;
    return { entry, ...(body ? { body } : {}) };
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

  waitForLoadSignal(timeoutMs: number): Promise<void> {
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

  private recordNetworkEntry(entry: BrowserNetworkEntry): void {
    this.networkById.set(entry.requestId, entry);
    this.networkEntries.push(entry);
    while (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
      const old = this.networkEntries.shift();
      if (old) this.networkById.delete(old.requestId);
    }
    for (const cb of this.networkChangeListeners) cb();
  }

  private notifyNetworkWatchers(entry: BrowserNetworkEntry): void {
    for (const w of [...this.networkWatchers]) w(entry);
    for (const cb of this.networkChangeListeners) cb();
  }

  async connect(pageWsUrl: string, opts?: { skipInitialNavigate?: boolean }): Promise<void> {
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
        const fw = Number(meta.deviceWidth ?? this.viewportW);
        const fh = Number(meta.deviceHeight ?? this.viewportH);
        if (Number.isFinite(fw) && fw > 0) this.viewportW = fw;
        if (Number.isFinite(fh) && fh > 0) this.viewportH = fh;
        this.emitFrame({
          portalId: this.portalId,
          seq: ++this.seq,
          mime: "image/jpeg",
          data: dataStr,
          rawBytes,
          byteLength: rawBytes.byteLength,
          width: this.viewportW,
          height: this.viewportH,
          url: this.url,
          title: this.title,
          canGoBack: this.canGoBack,
          canGoForward: this.canGoForward,
          ...(this.cursorOverlay
            ? {
                cursorX: Math.min(1, Math.max(0, this.cursorOverlay.x / Math.max(1, this.viewportW))),
                cursorY: Math.min(1, Math.max(0, this.cursorOverlay.y / Math.max(1, this.viewportH))),
                cursorVisible: Date.now() - this.cursorOverlay.at < 5000,
              }
            : {}),
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
      } else if (msg.method === "Page.javascriptDialogOpening") {
        this.activeDialog = {
          type: String(msg.params?.type ?? "alert"),
          message: String(msg.params?.message ?? ""),
          ...(typeof msg.params?.defaultPrompt === "string" ? { defaultPrompt: msg.params.defaultPrompt } : {}),
          ...(typeof msg.params?.url === "string" ? { url: msg.params.url } : {}),
        };
      } else if (msg.method === "Page.javascriptDialogClosed") {
        this.activeDialog = null;
      } else if (msg.method === "Network.requestWillBeSent") {
        const reqId = String(msg.params?.requestId ?? "");
        const req = msg.params?.request ?? {};
        const reqUrl = String(req.url ?? "");
        if (!reqId || !reqUrl || reqUrl.startsWith("data:")) return;
        const seq = ++this.networkSeq;
        const resourceType = typeof msg.params?.type === "string" ? msg.params.type : undefined;
        if (resourceType === "Document" && !msg.params?.redirectResponse) {
          this.docWatermarkSeq = seq;
        }
        const entry: BrowserNetworkEntry = {
          requestId: reqId,
          seq,
          method: String(req.method ?? "GET"),
          url: reqUrl,
          resourceType,
          startedAt: Date.now(),
          completed: false,
          requestHeaders: normalizeHeaders(req.headers),
          ...(typeof req.postData === "string" ? { postData: req.postData.slice(0, 8192) } : {}),
        };
        this.recordNetworkEntry(entry);
      } else if (msg.method === "Network.responseReceived") {
        const reqId = String(msg.params?.requestId ?? "");
        const resp = msg.params?.response ?? {};
        let entry = this.networkById.get(reqId);
        if (!entry) {
          const reqUrl = String(resp.url ?? "");
          if (!reqId || !reqUrl || reqUrl.startsWith("data:")) return;
          entry = {
            requestId: reqId,
            seq: ++this.networkSeq,
            method: "GET",
            url: reqUrl,
            resourceType: typeof msg.params?.type === "string" ? msg.params.type : undefined,
            startedAt: Date.now(),
            completed: false,
          };
          this.recordNetworkEntry(entry);
        }
        entry.status = typeof resp.status === "number" ? resp.status : entry.status;
        entry.statusText = typeof resp.statusText === "string" ? resp.statusText : entry.statusText;
        entry.mimeType = typeof resp.mimeType === "string" ? resp.mimeType : entry.mimeType;
        if (typeof msg.params?.type === "string" && !entry.resourceType) entry.resourceType = msg.params.type;
        if (resp.fromDiskCache || resp.fromServiceWorker || resp.fromPrefetchCache) entry.fromCache = true;
        entry.responseHeaders = normalizeHeaders(resp.headers);
        entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
        this.notifyNetworkWatchers(entry);
      } else if (msg.method === "Network.requestServedFromCache") {
        const reqId = String(msg.params?.requestId ?? "");
        const entry = this.networkById.get(reqId);
        if (entry) entry.fromCache = true;
      } else if (msg.method === "Network.loadingFinished") {
        const reqId = String(msg.params?.requestId ?? "");
        const entry = this.networkById.get(reqId);
        if (entry) {
          entry.completed = true;
          entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
          if (typeof msg.params?.encodedDataLength === "number") {
            entry.encodedDataLength = msg.params.encodedDataLength;
          }
          this.notifyNetworkWatchers(entry);
        }
      } else if (msg.method === "Network.loadingFailed") {
        const reqId = String(msg.params?.requestId ?? "");
        const entry = this.networkById.get(reqId);
        if (entry) {
          entry.completed = true;
          entry.failed = true;
          entry.errorText = typeof msg.params?.errorText === "string" ? msg.params.errorText : "failed";
          entry.durationMs = Math.max(0, Date.now() - entry.startedAt);
          this.notifyNetworkWatchers(entry);
        }
      }
    });

    ws.on("close", () => {
      this.close();
    });

    await this.cdp("Page.enable", {});
    await this.cdp("Runtime.enable", {});
    await this.cdp("DOM.enable", {}).catch(() => {});
    await this.cdp("Network.enable", {
      maxTotalBufferSize: 32 * 1024 * 1024,
      maxResourceBufferSize: 8 * 1024 * 1024,
    }).catch(() => {});
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT_W,
      height: VIEWPORT_H,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => {});
    await this.cdp("Page.startScreencast", {
      format: "jpeg",
      quality: this.screencastQuality,
      maxWidth: this.screencastMaxW,
      maxHeight: Math.round((this.screencastMaxW * VIEWPORT_H) / VIEWPORT_W),
      everyNthFrame: 2,
    }).catch(() => {});

    if (!opts?.skipInitialNavigate && this.url && this.url !== "about:blank") {
      const loadWait = this.waitForLoadSignal(4_000);
      await this.cdp("Page.navigate", { url: this.url }).catch(() => {});
      await loadWait;
    }
    await this.refreshNavState();
    await this.captureOnce(true);
  }

  async rawCdp(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<any> {
    return this.cdp(method, params, timeoutMs);
  }

  async evalJson<T = unknown>(expression: string, timeoutMs = 15_000): Promise<T> {
    const res = await this.cdp(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs,
    );
    if (res?.exceptionDetails) {
      throw new Error(String(res.exceptionDetails.text || res.exceptionDetails.exception?.description || "Page evaluate error"));
    }
    return res?.result?.value as T;
  }

  async navigateTo(url: string, timeoutMs = 15_000): Promise<{ url: string; title: string }> {
    const next = /^(?:https?|about|file):/i.test(url) ? url : `https://${url}`;
    const loadWait = this.waitForLoadSignal(Math.min(timeoutMs, 10_000));
    await this.cdp("Page.navigate", { url: next }, timeoutMs);
    this.url = next;
    await loadWait;
    await this.refreshNavState();
    await this.captureOnce(true);
    return { url: this.url, title: this.title };
  }

  async reload(timeoutMs = 15_000): Promise<{ url: string; title: string }> {
    const loadWait = this.waitForLoadSignal(Math.min(timeoutMs, 10_000));
    await this.cdp("Page.reload", {}, timeoutMs);
    await loadWait;
    await this.refreshNavState();
    await this.captureOnce(true);
    return { url: this.url, title: this.title };
  }

  async goBackOrForward(dir: "back" | "forward", timeoutMs = 10_000): Promise<{ url: string; title: string; moved: boolean }> {
    const hist = await this.cdp("Page.getNavigationHistory", {});
    const idx = Number(hist?.currentIndex ?? 0);
    const entries = Array.isArray(hist?.entries) ? hist.entries : [];
    const target = entries[dir === "back" ? idx - 1 : idx + 1];
    if (target?.id === undefined) return { url: this.url, title: this.title, moved: false };
    const loadWait = this.waitForLoadSignal(Math.min(timeoutMs, 6_000));
    await this.cdp("Page.navigateToHistoryEntry", { entryId: target.id });
    await loadWait;
    await this.refreshNavState();
    await this.captureOnce(true);
    return { url: this.url, title: this.title, moved: true };
  }

  async clickPoint(x: number, y: number, opts?: { button?: "left" | "right" | "middle"; clickCount?: number }): Promise<void> {
    const button = opts?.button ?? "left";
    const clickCount = opts?.clickCount ?? 1;
    const cx = Math.round(x);
    const cy = Math.round(y);
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none", buttons: 0 });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button, buttons: 1, clickCount });
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button, buttons: 0, clickCount });
  }

  async hoverPoint(x: number, y: number): Promise<void> {
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none", buttons: 0 });
  }

  async dragPoints(x1: number, y1: number, x2: number, y2: number, steps = 8): Promise<void> {
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1), y: Math.round(y1), button: "none", buttons: 0 });
    await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i += 1) {
      const ix = Math.round(x1 + ((x2 - x1) * i) / steps);
      const iy = Math.round(y1 + ((y2 - y1) * i) / steps);
      await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: ix, y: iy, button: "left", buttons: 1 });
    }
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
  }

  async wheelAt(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(x),
      y: Math.round(y),
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
    });
  }

  async insertText(text: string): Promise<void> {
    if (!text) return;
    await this.cdp("Input.insertText", { text });
  }

  async pressKey(chord: string, extraModifiers: string[] = []): Promise<void> {
    const { def, modifiers } = parseCdpKeyChord(chord, extraModifiers);
    await this.cdp("Input.dispatchKeyEvent", {
      type: def.text ? "keyDown" : "rawKeyDown",
      key: def.key,
      code: def.code,
      modifiers,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
      ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
    });
    await this.cdp("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: def.key,
      code: def.code,
      modifiers,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
    });
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.cdp("Page.handleJavaScriptDialog", {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
    this.activeDialog = null;
  }

  async capturePng(opts?: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number; scale?: number } }): Promise<string> {
    const r = await this.cdp(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
        ...(opts?.fullPage ? { captureBeyondViewport: true } : {}),
        ...(opts?.clip ? { clip: { ...opts.clip, scale: opts.clip.scale ?? 1 } } : {}),
      },
      20_000,
    );
    if (typeof r?.data !== "string" || !r.data) throw new Error("截图失败：未返回图像数据");
    return r.data;
  }

  async setFileInputFiles(selector: string, files: string[]): Promise<void> {
    const doc = await this.cdp("DOM.getDocument", { depth: -1, pierce: true });
    const rootId = Number(doc?.root?.nodeId ?? 0);
    if (!rootId) throw new Error("无法获取页面 DOM 根节点");
    const found = await this.cdp("DOM.querySelector", { nodeId: rootId, selector });
    const nodeId = Number(found?.nodeId ?? 0);
    if (!nodeId) throw new Error(`未找到文件上传控件：${selector}`);
    await this.cdp("DOM.setFileInputFiles", { nodeId, files });
  }

  async setCookies(
    cookies: Array<{
      name: string;
      value: string;
      domain?: string;
      path?: string;
      url?: string;
      secure?: boolean;
      httpOnly?: boolean;
      sameSite?: "Strict" | "Lax" | "None";
      expires?: number;
    }>,
  ): Promise<number> {
    if (!cookies.length) return 0;
    await this.cdp("Network.setCookies", { cookies });
    return cookies.length;
  }

  async refreshNavState(): Promise<void> {
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

  private cdp(method: string, params: Record<string, unknown>, timeoutMs = 12_000): Promise<any> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP 未连接"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async updateScreencastConfig(opts: { maxWidth?: number; quality?: number }): Promise<void> {
    if (this.closed) return;
    const nextQ = Math.min(90, Math.max(40, Math.round(opts.quality ?? this.screencastQuality)));
    const nextW = Math.min(1440, Math.max(640, Math.round(opts.maxWidth ?? this.screencastMaxW)));
    if (nextQ === this.screencastQuality && nextW === this.screencastMaxW) return;
    this.screencastQuality = nextQ;
    this.screencastMaxW = nextW;
    const nextH = Math.max(360, Math.round((nextW * VIEWPORT_H) / VIEWPORT_W));
    await this.cdp("Page.stopScreencast", {}).catch(() => {});
    await this.cdp("Page.startScreencast", {
      format: "jpeg",
      quality: nextQ,
      maxWidth: nextW,
      maxHeight: nextH,
      everyNthFrame: 2,
    }).catch(() => {});
    void this.captureOnce(true).catch(() => {});
  }

  async captureOnce(force = false): Promise<PortalFramePayload | null> {
    if (!force && this.latestFrame && Date.now() - this.latestFrame.at < 220) {
      return this.latestFrame;
    }
    if (this.captureInflight) return this.captureInflight;
    const run = (async () => {
      try {
        const r = await this.cdp("Page.captureScreenshot", { format: "jpeg", quality: this.screencastQuality, fromSurface: true }).catch(() =>
          this.cdp("Page.captureScreenshot", { format: "jpeg", quality: this.screencastQuality }),
        );
        if (typeof r?.data === "string" && r.data) {
          const rawBytes = Buffer.from(r.data, "base64");
          const frame: PortalFramePayload = {
            portalId: this.portalId,
            seq: ++this.seq,
            mime: "image/jpeg",
            data: r.data,
            rawBytes,
            byteLength: rawBytes.byteLength,
            width: this.viewportW,
            height: this.viewportH,
            url: this.url,
            title: this.title,
            canGoBack: this.canGoBack,
            canGoForward: this.canGoForward,
            ...(this.cursorOverlay
              ? {
                  cursorX: Math.min(1, Math.max(0, this.cursorOverlay.x / Math.max(1, this.viewportW))),
                  cursorY: Math.min(1, Math.max(0, this.cursorOverlay.y / Math.max(1, this.viewportH))),
                  cursorVisible: Date.now() - this.cursorOverlay.at < 5000,
                }
              : {}),
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
    const w = this.latestFrame?.width ?? this.viewportW;
    const h = this.latestFrame?.height ?? this.viewportH;
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
        await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: 1, clickCount: 1 });
      } else if (input.action === "up") {
        this.pendingMove = null;
        await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
      } else {
        this.pendingMove = null;
        await this.clickPoint(x, y, { button, clickCount: input.action === "dblclick" ? 2 : 1 });
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
      if (input.text) await this.insertText(input.text);
    } else if (input.type === "key") {
      await this.pressKey(input.key, input.modifiers ?? []);
    } else if (input.type === "navigate") {
      if (input.action === "reload") {
        await this.reload();
      } else if (input.action === "goto" && input.url) {
        await this.navigateTo(input.url);
      } else if (input.action === "back" || input.action === "forward") {
        await this.goBackOrForward(input.action);
      }
    } else if (input.type === "config") {
      await this.updateScreencastConfig({ maxWidth: input.maxWidth, quality: input.quality });
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
    this.networkWatchers.clear();
    this.networkChangeListeners.clear();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }
}

export interface PopupTargetInfo {
  targetId: string;
  openerId?: string;
  browserContextId?: string;
  url: string;
  title: string;
}

export class CdpBrowserPool {
  private sessions = new Map<string, CdpSession>();
  private sessionsByTargetId = new Map<string, CdpSession>();
  private profileRoot: string;
  private runtimeDir: string;
  private preferHeadlessShell: boolean;
  private browserProc: ChildProcess | null = null;
  private browserWs: WebSocket | null = null;
  private browserHost: string | null = null;
  private browserBinPath: string | null = null;
  private browserPending = new Map<number, CdpPending>();
  private browserNextId = 1;
  private browserStarting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private prunedStale = false;
  private popupListeners = new Set<(info: PopupTargetInfo) => void>();
  private destroyedListeners = new Set<(targetId: string) => void>();

  constructor(
    profileRoot = join(stateDir(), "portal-chrome"),
    opts?: { preferHeadlessShell?: boolean; persistentProfile?: boolean },
  ) {
    this.profileRoot = profileRoot;
    this.preferHeadlessShell = opts?.preferHeadlessShell !== false;
    this.runtimeDir = opts?.persistentProfile
      ? join(this.profileRoot, "ai-profile")
      : join(this.profileRoot, `runtime-${process.pid}`);
  }

  onPopupCreated(cb: (info: PopupTargetInfo) => void): () => void {
    this.popupListeners.add(cb);
    return () => this.popupListeners.delete(cb);
  }

  onTargetDestroyed(cb: (targetId: string) => void): () => void {
    this.destroyedListeners.add(cb);
    return () => this.destroyedListeners.delete(cb);
  }

  async hasBrowser(): Promise<boolean> {
    return Boolean(await findChromiumBinary(process.platform, process.env, { preferHeadlessShell: this.preferHeadlessShell }));
  }

  async resolveBinaryInfo(): Promise<{ bin: string | null; isHeadlessShell: boolean; profileDir: string }> {
    const bin =
      this.browserBinPath ??
      (await findChromiumBinary(process.platform, process.env, { preferHeadlessShell: this.preferHeadlessShell }));
    return {
      bin,
      isHeadlessShell: Boolean(bin && /headless[_-]?shell/i.test(bin)),
      profileDir: this.runtimeDir,
    };
  }

  get(portalId: string): CdpSession | undefined {
    const s = this.sessions.get(portalId);
    return s && !s.closed ? s : undefined;
  }

  getByTargetId(targetId: string): CdpSession | undefined {
    const s = this.sessionsByTargetId.get(targetId);
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
      // Clean stale Chrome singleton locks in persistent profile when no browserProc is alive.
      for (const lockName of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
        const p = join(this.runtimeDir, lockName);
        if (existsSync(p) && !this.browserProc) {
          rmSync(p, { force: true });
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  async browserCdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
    await this.ensureSharedBrowser();
    return this.browserCdpRaw(method, params);
  }

  private browserCdpRaw(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("远端浏览器通道未连接"));
    }
    const id = this.browserNextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.browserPending.delete(id);
        reject(new Error(`Browser CDP ${method} 超时`));
      }, 10_000);
      timer.unref?.();
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
    this.sessionsByTargetId.clear();
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
      const bin = await findChromiumBinary(process.platform, process.env, {
        preferHeadlessShell: this.preferHeadlessShell,
      });
      if (!bin) {
        throw new Error("这台电脑上没有找到 Chrome / Chromium / Edge，可切换为系统窗口回传或安装 Chromium");
      }
      this.browserBinPath = bin;
      const isHeadlessShell = /headless[_-]?shell/i.test(bin);
      const needsNoSandbox =
        process.platform === "linux" ||
        (typeof process.getuid === "function" && process.getuid() === 0) ||
        existsSync("/.dockerenv");

      this.pruneStaleRuntimeDirs();
      mkdirSync(this.runtimeDir, { recursive: true });
      const args = [
        ...(isHeadlessShell ? [] : ["--headless=new", "--no-startup-window"]),
        "--remote-debugging-port=0",
        `--user-data-dir=${this.runtimeDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=PasswordManager,AutofillServerCommunication,Translate",
        "--hide-scrollbars",
        "--mute-audio",
        `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
        ...(needsNoSandbox ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
        ...(isHeadlessShell ? ["about:blank"] : []),
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
        }, 18_000);

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
          return;
        }
        if (msg.method === "Target.targetCreated") {
          const ti = msg.params?.targetInfo;
          if (ti?.type === "page" && typeof ti.targetId === "string" && !this.sessionsByTargetId.has(ti.targetId)) {
            if (ti.openerId || ti.browserContextId) {
              const popup: PopupTargetInfo = {
                targetId: ti.targetId,
                ...(typeof ti.openerId === "string" ? { openerId: ti.openerId } : {}),
                ...(typeof ti.browserContextId === "string" ? { browserContextId: ti.browserContextId } : {}),
                url: typeof ti.url === "string" ? ti.url : "about:blank",
                title: typeof ti.title === "string" ? ti.title : "",
              };
              for (const cb of this.popupListeners) cb(popup);
            }
          }
        } else if (msg.method === "Target.targetDestroyed") {
          const tid = typeof msg.params?.targetId === "string" ? msg.params.targetId : "";
          if (tid) {
            const s = this.sessionsByTargetId.get(tid);
            if (s) {
              this.sessionsByTargetId.delete(tid);
              this.sessions.delete(s.portalId);
              s.close();
            }
            for (const cb of this.destroyedListeners) cb(tid);
          }
        }
      });

      bws.on("close", () => {
        if (this.browserWs === bws) {
          this.cleanupSharedBrowser(true);
        }
      });

      await this.browserCdpRaw("Target.setDiscoverTargets", { discover: true }).catch(() => {});
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

  async createBrowserContext(): Promise<string | undefined> {
    await this.ensureSharedBrowser();
    try {
      const res = (await this.browserCdpRaw("Target.createBrowserContext", {})) as { browserContextId?: string };
      return res?.browserContextId;
    } catch {
      return undefined;
    }
  }

  async disposeBrowserContext(browserContextId: string): Promise<void> {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) return;
    await this.browserCdpRaw("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  }

  async attachExistingTarget(
    portalId: string,
    targetId: string,
    url = "about:blank",
    browserContextId?: string,
  ): Promise<CdpSession> {
    const existing = this.get(portalId);
    if (existing) return existing;
    const byTarget = this.getByTargetId(targetId);
    if (byTarget) return byTarget;

    await this.ensureSharedBrowser();
    const session = new CdpSession(portalId, targetId, url, browserContextId);
    const pageWsUrl = await this.resolvePageWsUrl(targetId);
    await session.connect(pageWsUrl, { skipInitialNavigate: true });
    this.sessions.set(portalId, session);
    this.sessionsByTargetId.set(targetId, session);
    return session;
  }

  async open(
    portalId: string,
    url: string,
    opts?: { browserContextId?: string },
  ): Promise<{ url: string; title: string; targetId: string }> {
    const existing = this.get(portalId);
    if (existing) {
      await existing.navigateTo(url);
      return { url: existing.url, title: existing.title, targetId: existing.targetId };
    }

    await this.ensureSharedBrowser();
    const created = (await this.browserCdpRaw("Target.createTarget", {
      url: "about:blank",
      ...(opts?.browserContextId ? { browserContextId: opts.browserContextId } : {}),
    })) as { targetId?: string };
    const targetId = created?.targetId;
    if (!targetId) throw new Error("无法创建远端浏览器标签页");

    const session = new CdpSession(portalId, targetId, url, opts?.browserContextId);
    try {
      const pageWsUrl = await this.resolvePageWsUrl(targetId);
      await session.connect(pageWsUrl);
      this.sessions.set(portalId, session);
      this.sessionsByTargetId.set(targetId, session);
      return { url: session.url, title: session.title, targetId };
    } catch (err) {
      session.close();
      void this.browserCdpRaw("Target.closeTarget", { targetId }).catch(() => {});
      throw err;
    }
  }

  /** Launches a visible native Chrome/Edge/Brave window for manual user takeover on the given URL. */
  async popoutUrl(url: string): Promise<{ launched: boolean; bin?: string; note: string }> {
    const guiBin = await findChromiumBinary(process.platform, process.env, { headedOnly: true });
    if (!guiBin) {
      return { launched: false, note: "本机未找到可用的有头浏览器程序，请在当前标签页直接操作" };
    }
    const target = /^https?:\/\//i.test(url) ? url : "about:blank";
    const child = spawn(guiBin, ["--new-window", target], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { launched: true, bin: guiBin, note: "已弹出独立浏览器窗口" };
  }

  close(portalId: string): void {
    const s = this.sessions.get(portalId);
    if (!s) return;
    this.sessions.delete(portalId);
    this.sessionsByTargetId.delete(s.targetId);
    s.close();
    void this.browserCdpRaw("Target.closeTarget", { targetId: s.targetId }).catch(() => {});
    if (this.sessions.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.sessions.size === 0) {
          this.cleanupSharedBrowser(true);
          if (!this.runtimeDir.endsWith("ai-profile")) {
            try {
              rmSync(this.runtimeDir, { recursive: true, force: true });
            } catch {
              // ignore
            }
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
        this.sessions.delete(id);
        this.sessionsByTargetId.delete(s.targetId);
        s.close();
        void this.browserCdpRaw("Target.closeTarget", { targetId: s.targetId }).catch(() => {});
      }
    }
    this.sessions.clear();
    this.sessionsByTargetId.clear();
    this.cleanupSharedBrowser(true);
    if (!this.runtimeDir.endsWith("ai-profile")) {
      try {
        rmSync(this.runtimeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
