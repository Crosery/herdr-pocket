import dns from "node:dns/promises";
import net from "node:net";
import type { AssistantPluginId, AssistantWebhookTool } from "@herdr-pocket/protocol";
import type { ToolDef } from "./llm.ts";

export type AssistantPluginMap = Record<AssistantPluginId, boolean>;

export const DEFAULT_PLUGINS: AssistantPluginMap = {
  herdr: true,
  uniflo: true,
  browser: false,
  workspace: false,
  webfetch: false,
  webhooks: false,
};

/** Tool names belonging to the `herdr` tool-pack plugin (mirrors `plugins/assistant/herdr/manifest.json`). */
export const HERDR_PLUGIN_TOOLS = new Set([
  "list_agents",
  "list_devices",
  "read_agent",
  "send_to_agent",
  "press_keys",
  "list_launchers",
  "create_agent",
  "interrupt_agent",
  "close_agent",
  "list_spaces",
  "create_space",
  "herdr_do",
  "costs",
]);

/** Tool names belonging to the `uniflo` tool-pack plugin (mirrors `plugins/assistant/uniflo/manifest.json`). */
export const UNIFLO_PLUGIN_TOOLS = new Set([
  "search_sessions",
  "list_sessions",
  "read_session",
  "resume_session",
  "usage",
]);

export const PLUGIN_READ_ONLY_TOOLS = new Set(["inspect_workspace", "fetch_webpage", "browser_net"]);

const MAX_WEBHOOKS = 16;
const MAX_OUTPUT_CHARS = 8000;
const PRIVATE_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".arpa", ".home.arpa"];

export function normalizePlugins(raw: unknown): AssistantPluginMap {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    herdr: obj.herdr !== false,
    uniflo: obj.uniflo !== false,
    browser: obj.browser === true,
    workspace: obj.workspace === true,
    webfetch: obj.webfetch === true,
    webhooks: obj.webhooks === true,
  };
}

export function serializePlugins(map: AssistantPluginMap): Partial<Record<AssistantPluginId, boolean>> {
  const out: Partial<Record<AssistantPluginId, boolean>> = {};
  if (!map.herdr) out.herdr = false;
  if (!map.uniflo) out.uniflo = false;
  for (const k of ["browser", "workspace", "webfetch", "webhooks"] as const) {
    if (map[k]) out[k] = true;
  }
  return out;
}

export function filterBuiltinToolsByPlugins(tools: readonly ToolDef[], plugins: AssistantPluginMap): ToolDef[] {
  return tools.filter((t) => {
    if (HERDR_PLUGIN_TOOLS.has(t.name) && !plugins.herdr) return false;
    if (UNIFLO_PLUGIN_TOOLS.has(t.name) && !plugins.uniflo) return false;
    return true;
  });
}

export function disabledBuiltinToolMessage(name: string, plugins: AssistantPluginMap): string | null {
  if (HERDR_PLUGIN_TOOLS.has(name) && !plugins.herdr) {
    return "Herdr 插件已关闭，请先在「设置 › 插件中心」启用。";
  }
  if (UNIFLO_PLUGIN_TOOLS.has(name) && !plugins.uniflo) {
    return "Uniflo 插件已关闭，请先在「设置 › 插件中心」启用。";
  }
  return null;
}

export function sanitizeWebhookId(raw: unknown, fallbackIndex = 1): string {
  const clean = typeof raw === "string"
    ? raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24)
    : "";
  return clean || `hook_${fallbackIndex}`;
}

export const SECRET_MASK = "••••••••";

export function normalizeWebhooks(
  raw: unknown,
  previous: AssistantWebhookTool[] = [],
): AssistantWebhookTool[] {
  if (!Array.isArray(raw)) return [];
  const prevById = new Map(previous.map((h) => [h.id, h] as const));
  const out: AssistantWebhookTool[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim().slice(0, 48) : "";
    const description = typeof obj.description === "string" ? obj.description.trim().slice(0, 160) : "";
    const urlStr = typeof obj.url === "string" ? obj.url.trim() : "";
    if (!name || !urlStr) continue;
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    let id = sanitizeWebhookId(obj.id || name, out.length + 1);
    while (seen.has(id)) id = `${id.slice(0, 20)}_${out.length + 1}`;
    seen.add(id);
    const rawSecret = typeof obj.secretHeader === "string" ? obj.secretHeader.trim() : "";
    const secretHeader =
      rawSecret === SECRET_MASK
        ? prevById.get(id)?.secretHeader
        : rawSecret
          ? rawSecret.slice(0, 256)
          : undefined;
    out.push({
      id,
      name,
      description: description || `触发自定义 Webhook：${name}`,
      url: parsed.toString(),
      ...(secretHeader ? { secretHeader } : {}),
    });
    if (out.length >= MAX_WEBHOOKS) break;
  }
  return out;
}

export function maskWebhooks(list: AssistantWebhookTool[]): AssistantWebhookTool[] {
  return list.map((h) => ({
    ...h,
    ...(h.secretHeader ? { secretHeader: SECRET_MASK } : {}),
  }));
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let val = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    val = ((val << 8) | n) >>> 0;
  }
  return val;
}

export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] || "";
  if (!ip) return true;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (ip.startsWith("::ffff:")) {
    const tail = ip.slice("::ffff:".length);
    if (net.isIPv4(tail)) return isBlockedIp(tail);
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIp(dotted);
    }
  }

  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    const a = (n >>> 24) & 0xff;
    const b = (n >>> 16) & 0xff;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10.0.0.0/8 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 0 && ((n >>> 8) & 0xff) === 0) return true; // 192.0.0.0/24 IETF protocol
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
    if (a >= 224) return true; // multicast & reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === "::" || ip === "::1" || /^0+(:0+)*(:0+)?$/.test(ip) || /^0+(:0+)*:1$/.test(ip)) return true;
    const first = parseInt(ip.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }

  return true;
}

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = (host) => dns.lookup(host, { all: true });

export async function assertPublicHttpUrl(rawUrl: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new Error("网址格式无效，需要以 http:// 或 https:// 开头");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("只支持 http 或 https 公开网址");
  }
  if (u.username || u.password) {
    throw new Error("不支持携带账号密码的网址");
  }
  const host = u.hostname.trim().toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host) throw new Error("缺少域名或主机名");
  if (host === "localhost" || PRIVATE_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error(`出于安全限制，不允许访问内网或本机地址（${host}）`);
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error(`出于安全限制，不允许访问内网或保留 IP（${host}）`);
    }
    return u;
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host);
  } catch {
    throw new Error(`无法解析域名：${host}`);
  }
  if (!records.length) throw new Error(`域名没有返回有效地址：${host}`);
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new Error(`出于安全限制，目标域名解析到了内网或保留地址（${host} -> ${r.address}）`);
    }
  }
  return u;
}

export async function safeFetchPublic(
  rawUrl: string,
  init: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    lookup?: LookupFn;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ finalUrl: string; status: number; contentType: string; text: string }> {
  const fetchFn = init.fetchImpl ?? fetch;
  let current = await assertPublicHttpUrl(rawUrl, init.lookup);
  for (let hop = 0; hop <= 3; hop += 1) {
    const res = await fetchFn(current.toString(), {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === 3) {
        throw new Error(`网页重定向次数过多或缺少目标地址（HTTP ${res.status}）`);
      }
      const nextUrl = new URL(loc, current).toString();
      current = await assertPublicHttpUrl(nextUrl, init.lookup);
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`请求失败（HTTP ${res.status}）：${text.slice(0, 160)}`);
    }
    return { finalUrl: current.toString(), status: res.status, contentType, text };
  }
  throw new Error("请求未完成");
}

export function htmlToPlainText(raw: string, contentType: string): string {
  const body = /html|xhtml/i.test(contentType)
    ? raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
    : raw;
  return body
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_OUTPUT_CHARS);
}

export function pluginToolDefs(plugins: AssistantPluginMap, webhooks: AssistantWebhookTool[]): ToolDef[] {
  const defs: ToolDef[] = [];

  if (plugins.browser) {
    defs.push(
      {
        name: "browser_act",
        description:
          "操作已授权开启 AI 浏览器插件的电脑内置跨平台 Chromium 浏览器（主标签栏实时可视化，支持粉色幽灵光标）。" +
          "可用 op：open/navigate/back/forward/reload、snapshot（读取带 @eN 引用的可见元素列表）、click/dblclick/hover、fill/type/select/press/scroll、tabs、screenshot、handoff/takeover/resume/popout/finish。" +
          "遇到登录框、密码或验证码会自动触发 handoff，严禁绕过。",
        input_schema: {
          type: "object",
          properties: {
            device: { type: "string", description: "目标电脑名或 id；只有一台在线电脑时可省略" },
            spaceId: { type: "string", description: "浏览器空间 id；第一次 open 时自动创建" },
            page: { type: "string", description: "页签标识（如 p1）" },
            op: {
              type: "string",
              enum: [
                "open",
                "navigate",
                "back",
                "forward",
                "reload",
                "snapshot",
                "click",
                "dblclick",
                "hover",
                "fill",
                "type",
                "select",
                "press",
                "scroll",
                "tabs",
                "screenshot",
                "handoff",
                "takeover",
                "resume",
                "popout",
                "finish",
              ],
            },
            url: { type: "string" },
            target: { type: "string", description: "snapshot 返回的 @eN 引用、text=... 或 CSS 选择器" },
            value: { type: "string" },
            key: { type: "string" },
            deltaY: { type: "number" },
            label: { type: "string", description: "显示在虚拟光标旁的简短动作提示" },
            reason: { type: "string", description: "handoff 时说明需要协助的原因" },
            confirmed: { type: "boolean", description: "开启“动手前先问”时，用户明确同意后传 true" },
          },
          required: ["op"],
        },
      },
      {
        name: "browser_run",
        description: "在电脑内置 AI 浏览器中执行一段多步异步 JS 操作流脚本（支持 taskSpace / page.goto / fill / press / click / waitForEvent('popup') / waitForResponse）。",
        input_schema: {
          type: "object",
          properties: {
            device: { type: "string", description: "目标电脑名或 id；只有一台在线电脑时可省略" },
            spaceId: { type: "string" },
            script: { type: "string", description: "异步脚本正文" },
            timeoutMs: { type: "number" },
            confirmed: { type: "boolean" },
          },
          required: ["script"],
        },
      },
      {
        name: "browser_net",
        description: "只读查看电脑内置 AI 浏览器捕获的 HTTP 请求列表或读取指定请求的响应体 JSON/文本。",
        input_schema: {
          type: "object",
          properties: {
            device: { type: "string" },
            spaceId: { type: "string" },
            page: { type: "string" },
            action: { type: "string", enum: ["list", "body", "clear"] },
            filter: { type: "string", description: "按 URL 关键字筛选" },
            requestId: { type: "string", description: "action=body 时必填" },
            limit: { type: "number" },
          },
          required: ["action"],
        },
      },
    );
  }

  if (plugins.workspace) {
    defs.push({
      name: "inspect_workspace",
      description: "只读巡检某台电脑项目目录的文件列表、文件内容或 Git 状态/差异（截断到 8KB）。",
      input_schema: {
        type: "object",
        properties: {
          device: { type: "string", description: "目标电脑名或 id；只有一台在线电脑时可省略" },
          action: { type: "string", enum: ["git_status", "git_diff", "list_files", "read_file"] },
          cwd: { type: "string", description: "项目根目录或 agent 工作目录" },
          path: { type: "string", description: "相对路径或文件名（list_files / read_file / git_diff 时可用）" },
        },
        required: ["action", "cwd"],
      },
    });
  }

  if (plugins.webfetch) {
    defs.push({
      name: "fetch_webpage",
      description: "只读抓取公开网页正文并转为纯文本（禁止内网与本机地址，最多返回 8KB）。",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "公开的 http:// 或 https:// 网址" },
        },
        required: ["url"],
      },
    });
  }

  if (plugins.webhooks) {
    for (const hook of webhooks) {
      defs.push({
        name: `webhook_${hook.id}`,
        description: `自定义外部 Webhook 工具「${hook.name}」：${hook.description}。POST JSON 到预设公开地址。`,
        input_schema: {
          type: "object",
          properties: {
            payload: { type: "object", description: "传给 Webhook 的 JSON 数据" },
            note: { type: "string", description: "简短说明" },
            confirmed: { type: "boolean", description: "开启“动手前先问”时，用户明确同意后传 true" },
          },
        },
      });
    }
  }

  return defs;
}

export function pluginPromptHints(plugins: AssistantPluginMap): string {
  const parts: string[] = [];
  if (plugins.browser) parts.push("browser_act / browser_run / browser_net（内置 AI 浏览器与网络抓包：登录/验证码必 handoff，不绕过）");
  if (plugins.workspace) parts.push("inspect_workspace（代码与 Git 只读巡检）");
  if (plugins.webfetch) parts.push("fetch_webpage（网页阅读）");
  if (plugins.webhooks) parts.push("webhook_*（自定义 Webhook 工具）");
  return parts.length ? `\n\n## 已启用的扩展工具包\n${parts.join("；")}。` : "";
}

export interface PluginExecDeps {
  plugins: AssistantPluginMap;
  webhooks: AssistantWebhookTool[];
  resolveDevice: (ref: unknown) => string;
  deviceName: (id: string) => string;
  callHost: <T = unknown>(deviceId: string, method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** When true, mutating plugin ops must confirm unless the user confirmed after proposal. */
  requireConfirm: (opKey: string, summary: string, confirmedArg: boolean) => string | null;
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
}

export async function executePluginTool(
  name: string,
  input: Record<string, unknown>,
  deps: PluginExecDeps,
): Promise<{ out: string; step: string } | null> {
  if (name === "browser_act") {
    if (!deps.plugins.browser) throw new Error("小羊网页协作插件未开启，请先在「设置 › 插件中心」启用");
    const op = typeof input.op === "string" ? input.op.trim() : "";
    if (!op) throw new Error("需要 op");
    const id = deps.resolveDevice(input.device);
    if (op !== "snapshot") {
      const targetDesc =
        typeof input.url === "string" && input.url
          ? input.url
          : typeof input.target === "string" && input.target
            ? input.target
            : op;
      const hold = deps.requireConfirm(
        `browser:${id}:${op}:${targetDesc}`,
        `在「${deps.deviceName(id)}」的浏览器执行 ${op}（${targetDesc}）`,
        input.confirmed === true,
      );
      if (hold) return { out: hold, step: "等待确认浏览器操作" };
    }
    const r = await deps.callHost<{
      ok: boolean;
      spaceId: string;
      page: string;
      url?: string;
      title?: string;
      ownership: string;
      handoffReason?: string;
      snapshot?: string;
      note?: string;
    }>(
      id,
      "browser.act",
      {
        ...(typeof input.spaceId === "string" ? { spaceId: input.spaceId } : {}),
        ...(typeof input.page === "string" ? { page: input.page } : {}),
        op,
        ...(typeof input.url === "string" ? { url: input.url } : {}),
        ...(typeof input.target === "string" ? { target: input.target } : {}),
        ...(typeof input.value === "string" ? { value: input.value } : {}),
        ...(typeof input.key === "string" ? { key: input.key } : {}),
        ...(typeof input.deltaY === "number" ? { deltaY: input.deltaY } : {}),
        ...(typeof input.label === "string" ? { label: input.label } : {}),
        ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
      },
      20_000,
    );
    if (r.ownership === "agentHandoff") {
      return {
        out: `浏览器空间 ${r.spaceId} 已切换为“等待用户协助”：${r.handoffReason || r.note || "需要用户手动完成验证或登录"}。请告诉用户在桌面端浏览器完成操作后点击“已完成，交还 AI”。`,
        step: "等待用户接管浏览器",
      };
    }
    const summaryLines = [
      `spaceId=${r.spaceId} page=${r.page} ownership=${r.ownership}`,
      r.url ? `url=${r.url}` : "",
      r.title ? `title=${r.title}` : "",
      r.note ? `note=${r.note}` : "",
      r.snapshot ? `\n${r.snapshot.slice(0, MAX_OUTPUT_CHARS)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { out: summaryLines, step: `浏览器 ${op}` };
  }

  if (name === "browser_run") {
    if (!deps.plugins.browser) throw new Error("AI 浏览器操作插件未开启，请先在「设置 › 插件中心」启用");
    const script = typeof input.script === "string" ? input.script : "";
    if (!script.trim()) throw new Error("需要 script");
    const id = deps.resolveDevice(input.device);
    const gate = deps.requireConfirm(
      `browser_run:${id}`,
      `在 ${deps.deviceName(id)} 上执行 AI 浏览器脚本`,
      input.confirmed === true,
    );
    if (gate) return { out: gate, step: "等确认执行浏览器脚本" };
    const r = await deps.callHost<{ ok: boolean; stdout?: string; stderr?: string; error?: string; spaceId?: string }>(
      id,
      "browser.run",
      {
        script,
        ...(typeof input.spaceId === "string" && input.spaceId ? { spaceId: input.spaceId } : {}),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      },
      120_000,
    );
    const body = [r.stdout, r.stderr, r.error ? `ERROR: ${r.error}` : ""].filter(Boolean).join("\n");
    return {
      out: (body || (r.ok ? "ok" : "failed")).slice(0, MAX_OUTPUT_CHARS),
      step: "执行了浏览器脚本",
    };
  }

  if (name === "browser_net") {
    if (!deps.plugins.browser) throw new Error("AI 浏览器操作插件未开启，请先在「设置 › 插件中心」启用");
    const action = input.action === "body" || input.action === "clear" ? input.action : "list";
    const id = deps.resolveDevice(input.device);
    const r = await deps.callHost<Record<string, unknown>>(
      id,
      "browser.net",
      {
        action,
        ...(typeof input.spaceId === "string" && input.spaceId ? { spaceId: input.spaceId } : {}),
        ...(typeof input.page === "string" && input.page ? { page: input.page } : {}),
        ...(typeof input.filter === "string" && input.filter ? { filter: input.filter } : {}),
        ...(typeof input.requestId === "string" && input.requestId ? { requestId: input.requestId } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      },
      15_000,
    );
    return {
      out: JSON.stringify(r, null, 2).slice(0, MAX_OUTPUT_CHARS),
      step: action === "body" ? "读取了接口响应体" : action === "clear" ? "清空了网络抓包" : "查看了网络请求",
    };
  }

  if (name === "inspect_workspace") {
    if (!deps.plugins.workspace) throw new Error("代码与 Git 巡检插件未开启，请先在「设置 › 插件中心」启用");
    const action = typeof input.action === "string" ? input.action : "";
    const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
    if (!cwd) throw new Error("需要 cwd 目录路径");
    const id = deps.resolveDevice(input.device);
    const path = typeof input.path === "string" ? input.path.trim() : undefined;
    if (action === "git_status") {
      const r = await deps.callHost<Record<string, unknown>>(id, "git.status", { cwd });
      return { out: JSON.stringify(r, null, 2).slice(0, MAX_OUTPUT_CHARS), step: "查看了 Git 状态" };
    }
    if (action === "git_diff") {
      const r = await deps.callHost<{ diff?: string }>(id, "git.diff", { cwd, ...(path ? { path } : {}) });
      return { out: (r.diff || "（当前工作区无改动）").slice(0, MAX_OUTPUT_CHARS), step: "查看了 Git 差异" };
    }
    if (action === "list_files") {
      const r = await deps.callHost<{ entries?: Array<{ name: string; kind: string; size?: number }> }>(id, "files.list", {
        cwd,
        ...(path ? { path } : {}),
      });
      const lines = (r.entries ?? []).slice(0, 120).map((e) => `${e.kind === "dir" ? "dir " : "file"} ${e.name}${e.size !== undefined ? ` (${e.size}B)` : ""}`);
      return { out: lines.join("\n") || "（目录为空）", step: "列出了目录文件" };
    }
    if (action === "read_file") {
      if (!path) throw new Error("read_file 需要传 path");
      const r = await deps.callHost<{ text?: string; binary?: boolean }>(id, "files.read", {
        cwd,
        path,
        maxBytes: MAX_OUTPUT_CHARS,
      });
      if (r.binary) return { out: "（该文件为二进制文件，未展开内容）", step: `检查了 ${path}` };
      return { out: (r.text ?? "").slice(0, MAX_OUTPUT_CHARS), step: `读取了 ${path}` };
    }
    throw new Error(`不支持的 inspect_workspace 动作：${action}`);
  }

  if (name === "fetch_webpage") {
    if (!deps.plugins.webfetch) throw new Error("公开网页查阅插件未开启，请先在「设置 › 插件中心」启用");
    const url = typeof input.url === "string" ? input.url.trim() : "";
    if (!url) throw new Error("需要 url");
    const res = await safeFetchPublic(url, {
      method: "GET",
      headers: { "User-Agent": "HerdrPocketAssistant/1.0 (+https://github.com/Crosery/herdr-pocket)" },
      lookup: deps.lookup,
      fetchImpl: deps.fetchImpl,
    });
    const clean = htmlToPlainText(res.text, res.contentType);
    return {
      out: `URL: ${res.finalUrl}\nHTTP ${res.status}\n---\n${clean || "（页面正文为空）"}`,
      step: "查阅了公开网页",
    };
  }

  if (name.startsWith("webhook_")) {
    if (!deps.plugins.webhooks) throw new Error("自定义 Webhook 插件未开启，请先在「设置 › 插件中心」启用");
    const hookId = name.slice("webhook_".length);
    const hook = deps.webhooks.find((h) => h.id === hookId);
    if (!hook) throw new Error(`Webhook 工具「${hookId}」不存在`);
    const hold = deps.requireConfirm(
      `webhook:${hook.id}`,
      `触发自定义 Webhook「${hook.name}」`,
      input.confirmed === true,
    );
    if (hold) return { out: hold, step: "等待确认 Webhook" };
    const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? input.payload
      : {};
    const body = JSON.stringify({
      id: hook.id,
      name: hook.name,
      note: typeof input.note === "string" ? input.note.slice(0, 200) : undefined,
      arguments: payload,
      timestamp: Date.now(),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (hook.secretHeader) headers["X-Webhook-Secret"] = hook.secretHeader;
    const res = await safeFetchPublic(hook.url, {
      method: "POST",
      headers,
      body,
      lookup: deps.lookup,
      fetchImpl: deps.fetchImpl,
    });
    return {
      out: `Webhook「${hook.name}」已响应（HTTP ${res.status}）：${res.text.slice(0, 2000)}`,
      step: `触发了 ${hook.name}`,
    };
  }

  return null;
}
