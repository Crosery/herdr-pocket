import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type {
  BrowserSpaceSummary,
  RpcError,
  RpcMethods,
  RpcResult,
} from "@herdr-pocket/protocol";
import { readClientConfig } from "@herdr-pocket/update";
import { AiBrowserEngine } from "./aiBrowserEngine.ts";
import { CONFIG_DIR } from "./config.ts";
import { CdpBrowserPool, findChromiumBinary } from "./portal/cdpBrowser.ts";

export class BrowserPluginError extends Error {
  code: RpcError["code"];
  constructor(code: RpcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface BrowserPluginOptions {
  configPath?: string;
  bridgePath?: string;
  enabledOverride?: boolean;
  cdpPool?: CdpBrowserPool;
  engine?: AiBrowserEngine;
  inHostd?: boolean;
  hasChromium?: () => Promise<boolean>;
}

interface BridgeFileInfo {
  port: number;
  token: string;
  pid?: number;
  kind?: "hostd" | "desktop";
}

const DISABLED_MSG =
  "AI 浏览器插件默认关闭（零依赖模式）。如需启用，请在 设置 › 插件中心 开启「AI 浏览器协作」，或运行 herdr-pocket config set plugins.aiBrowser true";

export const HOSTD_BROWSER_BRIDGE_FILE = join(CONFIG_DIR, "hostd-browser.json");

let sharedEngine: AiBrowserEngine | null = null;
let usedLocalFallback = false;
let residentServer: Server | null = null;
let residentBridgePath: string | null = null;
let residentBridgePid: number | null = null;

export function getResidentAiBrowserEngine(): AiBrowserEngine {
  sharedEngine ??= new AiBrowserEngine();
  return sharedEngine;
}

export function usedStandaloneBrowserEngine(): boolean {
  return usedLocalFallback;
}

export function isAiBrowserEnabled(opts?: BrowserPluginOptions): boolean {
  if (typeof opts?.enabledOverride === "boolean") return opts.enabledOverride;
  return Boolean(readClientConfig(opts?.configPath).config.plugins?.aiBrowser);
}

function readBridgeFile(bridgePath: string): BridgeFileInfo | null {
  if (!existsSync(bridgePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(bridgePath, "utf8")) as Partial<BridgeFileInfo>;
    const port = Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof raw.token !== "string" || !raw.token.trim()) return null;
    return {
      port,
      token: raw.token.trim(),
      pid: typeof raw.pid === "number" ? raw.pid : undefined,
      kind: raw.kind === "hostd" || raw.kind === "desktop" ? raw.kind : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchBridge<T>(bridge: BridgeFileInfo, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; code?: RpcError["code"] };
  if (!res.ok) {
    const code: RpcError["code"] =
      json?.code === "unsupported" ||
      json?.code === "not_found" ||
      json?.code === "offline" ||
      json?.code === "timeout" ||
      json?.code === "internal"
        ? json.code
        : res.status === 403
          ? "unsupported"
          : res.status === 404
            ? "not_found"
            : "bad_request";
    throw new BrowserPluginError(code, json?.error || `Browser bridge HTTP ${res.status}`);
  }
  return json;
}

function normalizeBridgeSpaces(raw: unknown): BrowserSpaceSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object"))
    .map((s) => ({
      id: String(s.id ?? "default"),
      name: String(s.name ?? "默认浏览"),
      kind: s.kind === "ai" ? "ai" : "user",
      ownership:
        s.ownership === "agentWorking" || s.ownership === "agentHandoff" ? s.ownership : "user",
      ...(typeof s.statusText === "string" ? { statusText: s.statusText } : {}),
      ...(typeof s.handoffReason === "string" ? { handoffReason: s.handoffReason } : {}),
      ...(typeof s.activePage === "string" ? { activePage: s.activePage } : {}),
      ...(typeof s.portalId === "string" ? { portalId: s.portalId } : {}),
      ...(typeof s.networkCount === "number" ? { networkCount: s.networkCount } : {}),
      ...(s.cursor && typeof s.cursor === "object" ? { cursor: s.cursor as BrowserSpaceSummary["cursor"] } : {}),
      ...(typeof s.headed === "boolean" ? { headed: s.headed } : {}),
      ...(typeof s.createdAt === "number" ? { createdAt: s.createdAt } : {}),
      ...(typeof s.updatedAt === "number" ? { updatedAt: s.updatedAt } : {}),
      pages: Array.isArray(s.pages)
        ? s.pages
            .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
            .map((p) => ({
              label: String(p.label ?? "p1"),
              title: String(p.title ?? ""),
              url: String(p.url ?? "about:blank"),
              active: Boolean(p.active),
              ...(typeof p.targetId === "string" ? { targetId: p.targetId } : {}),
              ...(typeof p.portalId === "string" ? { portalId: p.portalId } : {}),
              ...(p.openedBy === "agent" || p.openedBy === "user" || p.openedBy === "popup" ? { openedBy: p.openedBy } : {}),
              ...(typeof p.networkCount === "number" ? { networkCount: p.networkCount } : {}),
              ...(typeof p.canGoBack === "boolean" ? { canGoBack: p.canGoBack } : {}),
              ...(typeof p.canGoForward === "boolean" ? { canGoForward: p.canGoForward } : {}),
              ...(typeof p.snapshotId === "string" ? { snapshotId: p.snapshotId } : {}),
            }))
        : [],
    }));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > 4 * 1024 * 1024) {
      throw new BrowserPluginError("bad_request", "请求体过大（上限 4 MB）");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new BrowserPluginError("bad_request", "请求体不是合法 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Starts the resident hostd loopback HTTP bridge (`~/.config/herdr-pocket/hostd-browser.json`)
 * so CLI commands (`herdr-pocket browser run/open/net/...`) and RPC callers share the exact
 * same Chromium CDP pool, task spaces, network buffers, and live Portal streams.
 */
export async function startResidentBrowserBridge(
  engine: AiBrowserEngine,
  opts?: { configPath?: string; enabledOverride?: boolean; bridgePath?: string },
): Promise<{ port: number; path: string }> {
  if (residentServer) {
    const addr = residentServer.address() as AddressInfo | null;
    if (addr?.port && residentBridgePath) {
      return { port: addr.port, path: residentBridgePath };
    }
  }

  const token = randomBytes(24).toString("hex");
  const bridgePath = opts?.bridgePath ?? HOSTD_BROWSER_BRIDGE_FILE;

  const srv = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const url = (req.url ?? "/").split("?")[0];
      const enabled = isAiBrowserEnabled({
        configPath: opts?.configPath,
        enabledOverride: opts?.enabledOverride,
      });

      if (req.method === "GET" && url === "/v1/browser/status") {
        if (!enabled) {
          sendJson(res, 200, { enabled: false, backend: "none", spaces: [], resident: true, platform: process.platform });
          return;
        }
        const status = await engine.getStatus();
        sendJson(res, 200, status);
        return;
      }

      if (req.method === "POST" && url === "/v1/browser/act") {
        const body = (await readJsonBody(req)) as unknown as RpcMethods["browser.act"]["params"];
        if (!enabled && body?.op !== "doctor") {
          sendJson(res, 403, { code: "unsupported", error: DISABLED_MSG });
          return;
        }
        const out = await engine.act(body);
        sendJson(res, 200, out);
        return;
      }

      if (req.method === "POST" && url === "/v1/browser/net") {
        if (!enabled) {
          sendJson(res, 403, { code: "unsupported", error: DISABLED_MSG });
          return;
        }
        const body = (await readJsonBody(req)) as unknown as RpcMethods["browser.net"]["params"];
        const out = await engine.inspectNetwork(body);
        sendJson(res, 200, out);
        return;
      }

      if (req.method === "POST" && url === "/v1/browser/run") {
        if (!enabled) {
          sendJson(res, 403, { code: "unsupported", error: DISABLED_MSG });
          return;
        }
        const body = (await readJsonBody(req)) as unknown as RpcMethods["browser.run"]["params"];
        const out = await engine.runScript(body);
        sendJson(res, 200, out);
        return;
      }

      sendJson(res, 404, { code: "not_found", error: `Unknown browser endpoint: ${url}` });
    } catch (err) {
      if (err instanceof BrowserPluginError) {
        sendJson(res, err.code === "unsupported" ? 403 : err.code === "not_found" ? 404 : 400, {
          code: err.code,
          error: err.message,
        });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const isNotFound = /不存在|未打开|未找到/.test(msg);
      sendJson(res, isNotFound ? 404 : 400, {
        code: isNotFound ? "not_found" : "bad_request",
        error: msg,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      srv.off("error", reject);
      resolve();
    });
  });

  const port = (srv.address() as AddressInfo).port;
  mkdirSync(dirname(bridgePath), { recursive: true });
  writeFileSync(
    bridgePath,
    JSON.stringify({ port, token, pid: process.pid, kind: "hostd" }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  if (process.platform !== "win32") {
    try {
      chmodSync(bridgePath, 0o600);
    } catch {
      // ignore chmod errors on restricted filesystems
    }
  }

  residentServer = srv;
  residentBridgePath = bridgePath;
  residentBridgePid = process.pid;
  return { port, path: bridgePath };
}

export async function stopResidentBrowserBridge(): Promise<void> {
  const srv = residentServer;
  const path = residentBridgePath;
  const pid = residentBridgePid;
  residentServer = null;
  residentBridgePath = null;
  residentBridgePid = null;

  if (srv) {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  if (path && existsSync(path)) {
    try {
      const cur = readBridgeFile(path);
      if (!cur || !cur.pid || cur.pid === pid) {
        unlinkSync(path);
      }
    } catch {
      // ignore
    }
  }
}

function getEngineForLocal(opts?: BrowserPluginOptions): AiBrowserEngine {
  if (opts?.engine) return opts.engine;
  if (opts?.cdpPool) {
    usedLocalFallback = true;
    return new AiBrowserEngine({ pool: opts.cdpPool });
  }
  if (!opts?.inHostd) usedLocalFallback = true;
  return getResidentAiBrowserEngine();
}

function classifyEngineError(err: unknown): BrowserPluginError {
  if (err instanceof BrowserPluginError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/未检测到.*Chrome|未安装.*Chromium|CDP 均不可用/.test(msg)) {
    return new BrowserPluginError("offline", msg);
  }
  if (/超时/.test(msg)) {
    return new BrowserPluginError("timeout", msg);
  }
  if (/不存在|未打开/.test(msg)) {
    return new BrowserPluginError("not_found", msg);
  }
  return new BrowserPluginError("bad_request", msg);
}

export async function getBrowserStatus(
  opts?: BrowserPluginOptions,
): Promise<RpcResult<"browser.status">> {
  if (!isAiBrowserEnabled(opts)) {
    return { enabled: false, backend: "none", spaces: [] };
  }

  if (opts?.engine || opts?.inHostd) {
    return getEngineForLocal(opts).getStatus();
  }

  // Explicit bridge path (used by unit tests and custom bridge setups)
  if (opts?.bridgePath) {
    const explicit = readBridgeFile(opts.bridgePath);
    if (explicit) {
      try {
        const res = await fetchBridge<{
          enabled?: boolean;
          backend?: string;
          spaces?: unknown;
          activeSpaceId?: string;
          chromePath?: string;
          resident?: boolean;
          platform?: string;
        }>(explicit, "/v1/browser/status", undefined, 5_000);
        return {
          enabled: res.enabled !== false,
          backend:
            res.backend === "desktop" || res.backend === "cdp" || res.backend === "none"
              ? res.backend
              : explicit.kind === "hostd"
                ? "cdp"
                : "desktop",
          spaces: normalizeBridgeSpaces(res.spaces),
          ...(typeof res.activeSpaceId === "string" ? { activeSpaceId: res.activeSpaceId } : {}),
          ...(typeof res.chromePath === "string" ? { chromePath: res.chromePath } : {}),
          ...(typeof res.resident === "boolean" ? { resident: res.resident } : {}),
          ...(typeof res.platform === "string" ? { platform: res.platform } : {}),
        };
      } catch {
        // Fall through cleanly if the bridge file is stale or closed.
      }
    }
  } else {
    // Default CLI path: prefer resident hostd Chromium CDP bridge
    const hostdBridge = readBridgeFile(HOSTD_BROWSER_BRIDGE_FILE);
    if (hostdBridge) {
      try {
        const res = await fetchBridge<RpcResult<"browser.status">>(hostdBridge, "/v1/browser/status", undefined, 5_000);
        return {
          enabled: res.enabled !== false,
          backend: res.backend === "cdp" || res.backend === "desktop" || res.backend === "none" ? res.backend : "cdp",
          spaces: normalizeBridgeSpaces(res.spaces),
          ...(typeof res.activeSpaceId === "string" ? { activeSpaceId: res.activeSpaceId } : {}),
          ...(typeof res.chromePath === "string" ? { chromePath: res.chromePath } : {}),
          resident: true,
          ...(typeof res.platform === "string" ? { platform: res.platform } : { platform: process.platform }),
        };
      } catch {
        // hostd bridge not listening — fall back to local Chromium check.
      }
    }
  }

  if (opts?.hasChromium) {
    const hasCdp = await opts.hasChromium();
    return {
      enabled: true,
      backend: hasCdp ? "cdp" : "none",
      spaces: [],
      resident: false,
      platform: process.platform,
    };
  }

  const bin = await findChromiumBinary(process.platform, process.env, { preferHeadlessShell: true }).catch(() => null);
  const existingSpaces = sharedEngine ? (await sharedEngine.getStatus()).spaces : [];
  return {
    enabled: true,
    backend: bin || existingSpaces.length > 0 ? "cdp" : "none",
    spaces: existingSpaces,
    ...(bin ? { chromePath: bin } : {}),
    resident: false,
    platform: process.platform,
  };
}

export async function runBrowserAct(
  params: RpcMethods["browser.act"]["params"],
  opts?: BrowserPluginOptions,
): Promise<RpcResult<"browser.act">> {
  if (!isAiBrowserEnabled(opts) && params.op !== "doctor") {
    throw new BrowserPluginError("unsupported", DISABLED_MSG);
  }

  if (opts?.engine || opts?.inHostd) {
    try {
      return await getEngineForLocal(opts).act(params);
    } catch (err) {
      throw classifyEngineError(err);
    }
  }

  const timeoutMs = Math.max(20_000, (params.timeoutMs ?? 15_000) + 15_000);

  if (opts?.bridgePath) {
    const explicit = readBridgeFile(opts.bridgePath);
    if (explicit) {
      try {
        return await fetchBridge<RpcResult<"browser.act">>(explicit, "/v1/browser/act", params, timeoutMs);
      } catch (err) {
        if (err instanceof BrowserPluginError) throw err;
      }
    }
  } else {
    const hostdBridge = readBridgeFile(HOSTD_BROWSER_BRIDGE_FILE);
    if (hostdBridge) {
      try {
        return await fetchBridge<RpcResult<"browser.act">>(hostdBridge, "/v1/browser/act", params, timeoutMs);
      } catch (err) {
        if (err instanceof BrowserPluginError) throw err;
        // Connection refused / hostd stopped -> fall back to standalone local engine.
      }
    }
  }

  try {
    return await getEngineForLocal(opts).act(params);
  } catch (err) {
    throw classifyEngineError(err);
  }
}

export async function runBrowserNet(
  params: RpcMethods["browser.net"]["params"],
  opts?: BrowserPluginOptions,
): Promise<RpcResult<"browser.net">> {
  if (!isAiBrowserEnabled(opts)) {
    throw new BrowserPluginError("unsupported", DISABLED_MSG);
  }

  if (opts?.engine || opts?.inHostd) {
    try {
      return await getEngineForLocal(opts).inspectNetwork(params);
    } catch (err) {
      throw classifyEngineError(err);
    }
  }

  const bridgeFile = opts?.bridgePath ?? HOSTD_BROWSER_BRIDGE_FILE;
  const bridge = readBridgeFile(bridgeFile);
  if (bridge) {
    try {
      return await fetchBridge<RpcResult<"browser.net">>(bridge, "/v1/browser/net", params, 15_000);
    } catch (err) {
      if (err instanceof BrowserPluginError) throw err;
    }
  }

  try {
    return await getEngineForLocal(opts).inspectNetwork(params);
  } catch (err) {
    throw classifyEngineError(err);
  }
}

export async function runBrowserScript(
  params: RpcMethods["browser.run"]["params"],
  opts?: BrowserPluginOptions,
): Promise<RpcResult<"browser.run">> {
  if (!isAiBrowserEnabled(opts)) {
    throw new BrowserPluginError("unsupported", DISABLED_MSG);
  }

  if (opts?.engine || opts?.inHostd) {
    try {
      return await getEngineForLocal(opts).runScript(params);
    } catch (err) {
      throw classifyEngineError(err);
    }
  }

  const timeoutMs = Math.max(30_000, (params.timeoutMs ?? 60_000) + 15_000);
  const bridgeFile = opts?.bridgePath ?? HOSTD_BROWSER_BRIDGE_FILE;
  const bridge = readBridgeFile(bridgeFile);
  if (bridge) {
    try {
      return await fetchBridge<RpcResult<"browser.run">>(bridge, "/v1/browser/run", params, timeoutMs);
    } catch (err) {
      if (err instanceof BrowserPluginError) throw err;
    }
  }

  try {
    return await getEngineForLocal(opts).runScript(params);
  } catch (err) {
    throw classifyEngineError(err);
  }
}

export async function runBrowserDoctor(opts?: BrowserPluginOptions): Promise<{
  enabled: boolean;
  resident: boolean;
  platform: string;
  chromePath: string | null;
  headlessShell: boolean;
  headedPath: string | null;
  spacesCount: number;
  note: string;
}> {
  const enabled = isAiBrowserEnabled(opts);
  const hostdBridge = !opts?.inHostd ? readBridgeFile(opts?.bridgePath ?? HOSTD_BROWSER_BRIDGE_FILE) : null;
  let resident = Boolean(opts?.inHostd);
  let spacesCount = 0;

  if (hostdBridge) {
    try {
      const st = await fetchBridge<RpcResult<"browser.status">>(hostdBridge, "/v1/browser/status", undefined, 3_000);
      resident = true;
      spacesCount = Array.isArray(st.spaces) ? st.spaces.length : 0;
    } catch {
      resident = false;
    }
  } else if (opts?.engine || opts?.inHostd) {
    const st = await getEngineForLocal(opts).getStatus();
    spacesCount = st.spaces.length;
  }

  const headlessBin = await findChromiumBinary(process.platform, process.env, { preferHeadlessShell: true }).catch(() => null);
  const headedBin = await findChromiumBinary(process.platform, process.env, { headedOnly: true }).catch(() => null);
  const headlessShell = Boolean(headlessBin && /headless.?shell/i.test(headlessBin));
  const note = headlessBin
    ? headlessShell
      ? `已就绪（${headlessBin}，原生无头 Shell，零窗口抢焦）`
      : `已就绪（${headlessBin}，--headless=new 无窗口抢焦模式）`
    : "未检测到 Chrome / Chromium / Edge / Brave，请安装任意 Chromium 内核浏览器或设置 CHROME_PATH";

  return {
    enabled,
    resident,
    platform: process.platform,
    chromePath: headlessBin,
    headlessShell,
    headedPath: headedBin,
    spacesCount,
    note,
  };
}

export async function shutdownBrowserPluginCdp(): Promise<void> {
  await stopResidentBrowserBridge();
  sharedEngine?.shutdown();
  sharedEngine = null;
  usedLocalFallback = false;
}
