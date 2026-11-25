import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BrowserSpaceOwnership,
  BrowserSpaceSummary,
  RpcError,
  RpcMethods,
  RpcResult,
} from "@herdr-pocket/protocol";
import { readClientConfig } from "@herdr-pocket/update";
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
  hasChromium?: () => Promise<boolean>;
}

interface BridgeFileInfo {
  port: number;
  token: string;
  pid?: number;
}

interface CdpSpaceState {
  id: string;
  name: string;
  ownership: BrowserSpaceOwnership;
  statusText?: string;
  handoffReason?: string;
  pages: Array<{ label: string; title: string; url: string; active: boolean }>;
  activePage: string;
}

const DISABLED_MSG =
  "AI 浏览器插件默认关闭（零依赖模式）。如需启用，请在 设置 › 插件中心 开启「AI 浏览器协作」，或运行 herdr-pocket config set plugins.aiBrowser true";

let sharedCdpPool: CdpBrowserPool | null = null;
const cdpSpaces = new Map<string, CdpSpaceState>();
let nextCdpSpaceSeq = 1;

function getCdpPool(opts?: BrowserPluginOptions): CdpBrowserPool {
  if (opts?.cdpPool) return opts.cdpPool;
  sharedCdpPool ??= new CdpBrowserPool();
  return sharedCdpPool;
}

export function isAiBrowserEnabled(opts?: BrowserPluginOptions): boolean {
  if (typeof opts?.enabledOverride === "boolean") return opts.enabledOverride;
  return Boolean(readClientConfig(opts?.configPath).config.plugins?.aiBrowser);
}

function readBridgeFile(bridgePath = join(CONFIG_DIR, "browser-bridge.json")): BridgeFileInfo | null {
  if (!existsSync(bridgePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(bridgePath, "utf8")) as Partial<BridgeFileInfo>;
    const port = Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof raw.token !== "string" || !raw.token.trim()) return null;
    return { port, token: raw.token.trim(), pid: typeof raw.pid === "number" ? raw.pid : undefined };
  } catch {
    return null;
  }
}

async function fetchBridge<T>(bridge: BridgeFileInfo, path: string, body?: unknown, timeoutMs = 4000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new BrowserPluginError("bad_request", json?.error || `Browser bridge HTTP ${res.status}`);
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
      pages: Array.isArray(s.pages)
        ? s.pages
            .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
            .map((p) => ({
              label: String(p.label ?? "p1"),
              title: String(p.title ?? ""),
              url: String(p.url ?? "about:blank"),
              active: Boolean(p.active),
            }))
        : [],
    }));
}

function cdpSpaceSummaries(): BrowserSpaceSummary[] {
  return [...cdpSpaces.values()].map((sp) => ({
    id: sp.id,
    name: sp.name,
    kind: "ai",
    ownership: sp.ownership,
    statusText: sp.statusText,
    handoffReason: sp.handoffReason,
    activePage: sp.activePage,
    pages: sp.pages.map((p) => ({
      label: p.label,
      title: p.title,
      url: p.url,
      active: p.label === sp.activePage,
    })),
  }));
}

function cdpEvalHelperScript(op: string, payload: Record<string, unknown>): string {
  const args = JSON.stringify({ op, ...payload });
  return `(function(cfg){
    window.__hpCdp ||= { refs: new Map(), next: 1 };
    var st = window.__hpCdp;
    function vis(el){
      if(!el||!el.getBoundingClientRect) return false;
      var s=getComputedStyle(el);
      if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)===0) return false;
      var r=el.getBoundingClientRect();
      return r.width>1&&r.height>1;
    }
    function txt(el){
      return ((el.getAttribute&&el.getAttribute('aria-label'))||el.innerText||el.textContent||el.placeholder||'').replace(/\\s+/g,' ').trim().slice(0,80);
    }
    function roleOf(el){
      var t=el.tagName.toLowerCase();
      var r=el.getAttribute&&el.getAttribute('role');
      if(r) return r;
      if(t==='a') return 'link';
      if(t==='button'||(t==='input'&&(el.type==='submit'||el.type==='button'))) return 'button';
      if(t==='textarea'||(t==='input'&&['hidden','checkbox','radio'].indexOf(el.type)<0)) return el.type==='password'?'password':'textbox';
      if(t==='select') return 'select';
      if(t==='input') return el.type;
      return t;
    }
    function isSens(el){
      if(!el) return false;
      var tp=(el.type||'').toLowerCase();
      var ac=(el.getAttribute&&el.getAttribute('autocomplete'))||'';
      var hint=((el.name||'')+' '+(el.id||'')+' '+(el.placeholder||'')).toLowerCase();
      return tp==='password'||ac==='one-time-code'||/(captcha|otp|2fa|totp|passcode|password|verify)/.test(hint);
    }
    function snap(){
      st.refs.clear(); st.next=1;
      var lines=[];
      var nodes=document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=textbox]');
      for(var i=0;i<nodes.length&&lines.length<120;i++){
        var el=nodes[i];
        if(!vis(el)) continue;
        var k='@e'+(st.next++);
        st.refs.set(k, el);
        var t=txt(el);
        lines.push(k+' ['+roleOf(el)+']'+(t?' '+JSON.stringify(t):''));
      }
      return { url: location.href, title: document.title||'', text: 'Title: '+(document.title||location.href)+'\\nURL: '+location.href+'\\n---\\n'+lines.join('\\n') };
    }
    if(cfg.op==='snapshot') return snap();
    if(cfg.op==='scroll'){
      window.scrollBy({top:Number(cfg.deltaY||420),behavior:'smooth'});
      return { url: location.href, title: document.title||'' };
    }
    var el = cfg.target ? (st.refs.get(cfg.target) || (function(){ try{ return document.querySelector(cfg.target); }catch(_){ return null; } })()) : document.activeElement;
    if(!el) return { error: '未找到目标元素 '+(cfg.target||'') };
    if(isSens(el) && (cfg.op==='fill'||cfg.op==='click')) return { handoff: '检测到敏感/验证控件，请由用户手动操作' };
    if(cfg.op==='click'||cfg.op==='dblclick'){
      el.scrollIntoView({block:'center',inline:'center'});
      if(cfg.op==='dblclick') el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
      else { el.click(); }
    } else if(cfg.op==='hover'){
      el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
    } else if(cfg.op==='fill'){
      el.focus && el.focus();
      el.value = cfg.value ?? '';
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    } else if(cfg.op==='select'){
      el.value = cfg.value ?? '';
      el.dispatchEvent(new Event('change',{bubbles:true}));
    } else if(cfg.op==='press'){
      el.dispatchEvent(new KeyboardEvent('keydown',{key:cfg.key||'Enter',bubbles:true,cancelable:true}));
      el.dispatchEvent(new KeyboardEvent('keyup',{key:cfg.key||'Enter',bubbles:true}));
    }
    return { url: location.href, title: document.title||'' };
  })(${args})`;
}

async function runCdpFallback(
  params: RpcMethods["browser.act"]["params"],
  opts?: BrowserPluginOptions,
): Promise<RpcResult<"browser.act">> {
  const pool = getCdpPool(opts);
  const canUseCdp = (await (opts?.hasChromium ? opts.hasChromium() : findChromiumBinary())) ? true : false;
  if (!canUseCdp && !cdpSpaces.size) {
    throw new BrowserPluginError("offline", "桌面端内置浏览器与本地 Chrome/CDP 均不可用，请先打开 Herdr Pocket 桌面端。");
  }

  let spaceId = params.spaceId?.trim();
  if (!spaceId) {
    spaceId = cdpSpaces.keys().next().value;
  }
  if (!spaceId) {
    if (params.op !== "open") {
      throw new BrowserPluginError("bad_request", "未指定浏览器空间；请先执行 open 打开网页。");
    }
    spaceId = `ai-${nextCdpSpaceSeq++}`;
  }

  let sp = cdpSpaces.get(spaceId);
  if (!sp) {
    if (params.op !== "open") {
      throw new BrowserPluginError("not_found", `浏览器空间 ${spaceId} 不存在`);
    }
    sp = {
      id: spaceId,
      name: `AI 任务 · ${spaceId.replace(/^ai-/, "")}`,
      ownership: "agentWorking",
      statusText: params.label,
      pages: [],
      activePage: params.page?.trim() || "p1",
    };
    cdpSpaces.set(spaceId, sp);
  }

  const pageLabel = params.page?.trim() || sp.activePage || "p1";
  sp.activePage = pageLabel;
  const portalKey = `cdp-${spaceId}-${pageLabel}`;

  if (params.op === "finish") {
    const keep = new Set(params.keep ?? []);
    for (const pg of sp.pages) {
      if (!keep.has(pg.label)) pool.close(`cdp-${spaceId}-${pg.label}`);
    }
    if (!keep.size) {
      cdpSpaces.delete(spaceId);
    } else {
      sp.pages = sp.pages.filter((p) => keep.has(p.label));
      sp.ownership = "user";
    }
    return {
      ok: true,
      spaceId,
      page: pageLabel,
      ownership: "user",
      note: "已结束无头浏览器任务空间",
    };
  }

  if (params.op === "handoff") {
    sp.ownership = "agentHandoff";
    sp.handoffReason = params.reason || "需要用户手动协助后继续";
    return {
      ok: true,
      spaceId,
      page: pageLabel,
      ownership: "agentHandoff",
      handoffReason: sp.handoffReason,
      note: sp.handoffReason,
    };
  }

  if (params.op === "resume") {
    sp.ownership = "agentWorking";
    sp.handoffReason = undefined;
    sp.statusText = params.label || "已交还 AI 继续";
    return {
      ok: true,
      spaceId,
      page: pageLabel,
      ownership: "agentWorking",
      note: "AI 已恢复对该浏览空间的操作权",
    };
  }

  if (params.op === "open") {
    const targetUrl = params.url?.trim() || "about:blank";
    const info = await pool.open(portalKey, targetUrl);
    const existing = sp.pages.find((p) => p.label === pageLabel);
    if (existing) {
      existing.url = info.url;
      existing.title = info.title;
    } else {
      sp.pages.push({ label: pageLabel, title: info.title || info.url, url: info.url, active: true });
    }
    sp.ownership = "agentWorking";
    sp.statusText = params.label || "正在打开网页";
    return {
      ok: true,
      spaceId,
      page: pageLabel,
      url: info.url,
      title: info.title,
      ownership: sp.ownership,
    };
  }

  const sess = pool.get(portalKey);
  if (!sess) {
    throw new BrowserPluginError("not_found", `页面 ${spaceId}/${pageLabel} 尚未打开`);
  }

  const evaluated = await sess.evalJson<{
    url?: string;
    title?: string;
    text?: string;
    error?: string;
    handoff?: string;
  }>(
    cdpEvalHelperScript(params.op, {
      target: params.target,
      value: params.value,
      key: params.key,
      deltaY: params.deltaY,
    }),
  );

  if (evaluated?.handoff) {
    sp.ownership = "agentHandoff";
    sp.handoffReason = evaluated.handoff;
    return {
      ok: false,
      spaceId,
      page: pageLabel,
      url: evaluated.url ?? sess.url,
      title: evaluated.title ?? sess.title,
      ownership: "agentHandoff",
      handoffReason: evaluated.handoff,
      note: evaluated.handoff,
    };
  }

  if (evaluated?.error) {
    throw new BrowserPluginError("bad_request", evaluated.error);
  }

  const pg = sp.pages.find((p) => p.label === pageLabel);
  if (pg && evaluated?.url) pg.url = evaluated.url;
  if (pg && evaluated?.title) pg.title = evaluated.title;

  return {
    ok: true,
    spaceId,
    page: pageLabel,
    url: evaluated?.url ?? sess.url,
    title: evaluated?.title ?? sess.title,
    ownership: sp.ownership,
    ...(evaluated?.text ? { snapshot: evaluated.text } : {}),
  };
}

export async function getBrowserStatus(
  opts?: BrowserPluginOptions,
): Promise<RpcResult<"browser.status">> {
  if (!isAiBrowserEnabled(opts)) {
    return { enabled: false, backend: "none", spaces: [] };
  }
  const bridge = readBridgeFile(opts?.bridgePath);
  if (bridge) {
    try {
      const res = await fetchBridge<{
        enabled?: boolean;
        backend?: string;
        spaces?: unknown;
        activeSpaceId?: string;
      }>(bridge, "/v1/browser/status");
      return {
        enabled: true,
        backend: "desktop",
        spaces: normalizeBridgeSpaces(res.spaces),
        ...(typeof res.activeSpaceId === "string" ? { activeSpaceId: res.activeSpaceId } : {}),
      };
    } catch {
      // Fall through cleanly if the desktop bridge file is stale or closed.
    }
  }
  const hasCdp = opts?.hasChromium ? await opts.hasChromium() : Boolean(await findChromiumBinary().catch(() => null));
  return {
    enabled: true,
    backend: cdpSpaces.size > 0 || hasCdp ? "cdp" : "none",
    spaces: cdpSpaceSummaries(),
  };
}

export async function runBrowserAct(
  params: RpcMethods["browser.act"]["params"],
  opts?: BrowserPluginOptions,
): Promise<RpcResult<"browser.act">> {
  if (!isAiBrowserEnabled(opts)) {
    throw new BrowserPluginError("unsupported", DISABLED_MSG);
  }
  const bridge = readBridgeFile(opts?.bridgePath);
  if (bridge) {
    try {
      return await fetchBridge<RpcResult<"browser.act">>(bridge, "/v1/browser/act", params, 18_000);
    } catch (err) {
      if (err instanceof BrowserPluginError) throw err;
      // Stale bridge file or desktop closed: fall back to CDP when possible.
    }
  }
  return runCdpFallback(params, opts);
}

export async function shutdownBrowserPluginCdp(): Promise<void> {
  sharedCdpPool?.closeAll();
  sharedCdpPool = null;
  cdpSpaces.clear();
}
