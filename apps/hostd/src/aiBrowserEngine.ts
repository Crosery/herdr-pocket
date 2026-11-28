import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { format } from "node:util";
import type {
  BrowserCursorOverlay,
  BrowserNetworkBodyResult,
  BrowserNetworkEntry,
  BrowserSpaceOwnership,
  BrowserSpacePageSummary,
  BrowserSpaceSummary,
  PortalFramePayload,
  PortalInputAction,
  RpcMethods,
  RpcResult,
} from "@herdr-pocket/protocol";
import { stateDir } from "@herdr-pocket/update";
import { CdpBrowserPool, CdpSession, findChromiumBinary, type PopupTargetInfo } from "./portal/cdpBrowser.ts";

export interface AiBrowserEngineHooks {
  onSpaceChanged?: (space: BrowserSpaceSummary, session: CdpSession | null, agentKey?: string) => void;
  onSpaceClosed?: (spaceId: string) => void;
}

interface ManagedPage {
  label: string;
  portalKey: string;
  targetId: string;
  title: string;
  url: string;
  openedBy: "agent" | "user" | "popup";
  snapshotId?: string;
  lastSnapshotLines?: string[];
  snapshotSeq: number;
  unsubNet?: () => void;
}

interface ManagedSpace {
  id: string;
  name: string;
  kind: "ai" | "user";
  ownership: BrowserSpaceOwnership;
  statusText?: string;
  handoffReason?: string;
  activePage: string;
  browserContextId?: string;
  agentKey?: string;
  portalId?: string;
  cursor?: BrowserCursorOverlay;
  headed?: boolean;
  createdAt: number;
  updatedAt: number;
  pages: ManagedPage[];
  nextPageNum: number;
}

interface SnapshotEvalResult {
  url: string;
  title: string;
  authGate: string | null;
  text: string;
  lines: string[];
  viewportW: number;
  viewportH: number;
}

interface ElementLocateResult {
  found: boolean;
  x?: number;
  y?: number;
  box?: { x: number; y: number; width: number; height: number };
  viewportW?: number;
  viewportH?: number;
  label?: string;
  tag?: string;
  handoff?: string;
  error?: string;
  url?: string;
  title?: string;
}

function buildPageHelperBootstrap(): string {
  return `(function(){
    if (window.__hpCdpHelper && window.__hpCdpHelper.__v === 2) return window.__hpCdpHelper;
    var st = { refs: new Map(), next: 1 };

    function isVisible(el) {
      if (!el || !el.getBoundingClientRect) return false;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2;
    }

    function inViewport(el) {
      var r = el.getBoundingClientRect();
      return r.bottom >= -20 && r.top <= (window.innerHeight + 80) && r.right >= -20 && r.left <= (window.innerWidth + 80);
    }

    function collectAllElements(root, selector, out) {
      out = out || [];
      if (!root || !root.querySelectorAll) return out;
      try {
        var matched = root.querySelectorAll(selector);
        for (var i = 0; i < matched.length; i++) out.push(matched[i]);
      } catch (_) {}
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot) collectAllElements(all[j].shadowRoot, selector, out);
      }
      return out;
    }

    function elemLabel(el) {
      if (!el) return '';
      var aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt'));
      var txt = aria || el.innerText || el.textContent || el.value || '';
      return String(txt).replace(/\\s+/g, ' ').trim().slice(0, 84);
    }

    function elemRole(el) {
      var explicit = el.getAttribute && el.getAttribute('role');
      if (explicit) return explicit;
      var t = (el.tagName || '').toLowerCase();
      if (t === 'a') return 'link';
      if (t === 'button' || (t === 'input' && /^(button|submit|reset)$/i.test(el.type || ''))) return 'button';
      if (t === 'textarea' || (t === 'input' && !/^(hidden|checkbox|radio|button|submit|reset|file)$/i.test(el.type || ''))) {
        return (el.type || '').toLowerCase() === 'password' ? 'password' : 'textbox';
      }
      if (t === 'select') return 'combobox';
      if (t === 'input') return el.type || 'input';
      if (/^h[1-6]$/.test(t)) return 'heading';
      return t;
    }

    function detectAuthGate() {
      var pw = document.querySelector('input[type="password"]');
      if (pw && isVisible(pw)) return '检测到密码输入框，请由用户手动输入登录凭证';
      var otp = document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="2fa" i],input[id*="captcha" i],input[name*="captcha" i]');
      if (otp && isVisible(otp)) return '检测到验证码或二次验证输入框，请由用户手动完成';
      var iframes = document.querySelectorAll('iframe[src]');
      for (var i = 0; i < iframes.length; i++) {
        var src = (iframes[i].getAttribute('src') || '').toLowerCase();
        if ((src.indexOf('captcha') >= 0 || src.indexOf('turnstile') >= 0 || src.indexOf('recaptcha') >= 0 || src.indexOf('hcaptcha') >= 0 || src.indexOf('geetest') >= 0) && isVisible(iframes[i])) {
          return '检测到人机验证组件，请由用户手动完成';
        }
      }
      return null;
    }

    function isSensitive(el) {
      if (!el) return null;
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'input') {
        var tp = (el.getAttribute('type') || '').toLowerCase();
        var hint = ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('id') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();
        if (tp === 'password') return '检测到密码框，禁止自动填写，请由用户手动登录';
        if (/(one-time-code|captcha|otp|2fa|totp|passcode)/.test(hint)) return '检测到验证码或二次验证字段，请由用户手动完成';
      }
      var lbl = elemLabel(el).toLowerCase();
      if (lbl.indexOf('verify you are human') >= 0 || lbl.indexOf('i am not a robot') >= 0) {
        return '检测到人机校验控件，请由用户手动完成';
      }
      return null;
    }

    function resolveRef(raw) {
      var t = String(raw || '').trim();
      if (/^@e?\\d+$/i.test(t)) {
        var num = t.replace(/^@e?/i, '');
        var el = st.refs.get('@e' + num) || st.refs.get('@' + num);
        return el && el.isConnected ? el : null;
      }
      if (/^ref=\\d+$/i.test(t)) {
        var n2 = t.slice(4);
        var el2 = st.refs.get('@e' + n2) || st.refs.get('@' + n2);
        return el2 && el2.isConnected ? el2 : null;
      }
      return undefined;
    }

    function resolveSelector(raw) {
      if (!raw) return document.activeElement;
      var t = String(raw).trim();
      var refHit = resolveRef(t);
      if (refHit !== undefined) return refHit;

      // Support trailing >> nth=N
      var nth = null;
      var nthMatch = /\\s*>>\\s*nth=(-?\\d+)\\s*$/i.exec(t);
      if (nthMatch) {
        nth = parseInt(nthMatch[1], 10);
        t = t.slice(0, nthMatch.index).trim();
      }
      var pickList = function(list) {
        var vis = list.filter(isVisible);
        var pool = vis.length ? vis : list;
        if (!pool.length) return null;
        if (nth !== null) {
          var idx = nth < 0 ? pool.length + nth : nth;
          return pool[idx] || null;
        }
        return pool[0];
      };

      if (t.startsWith('xpath=')) {
        var xp = t.slice(6);
        try {
          var snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          var xs = [];
          for (var i = 0; i < snap.snapshotLength; i++) xs.push(snap.snapshotItem(i));
          return pickList(xs);
        } catch (_) { return null; }
      }

      if (t.startsWith('loc=href:')) {
        var wantHref = t.slice(9).trim();
        var links = collectAllElements(document, 'a[href]');
        return pickList(links.filter(function(a){ return (a.getAttribute('href') || '').indexOf(wantHref) >= 0 || (a.href || '').indexOf(wantHref) >= 0; }));
      }

      if (t.startsWith('loc=role:')) {
        var rm = /^loc=role:([a-z0-9_-]+)(?:\\[name(\\*?=)(['"])(.*?)\\3\\])?$/i.exec(t);
        if (rm) {
          var wantRole = rm[1].toLowerCase();
          var op = rm[2] || '';
          var wantName = (rm[4] || '').trim();
          var nodes = collectAllElements(document, 'a[href],button,input,textarea,select,[role],[tabindex],h1,h2,h3,h4');
          var matched = nodes.filter(function(n){
            if (elemRole(n).toLowerCase() !== wantRole) return false;
            if (!wantName) return true;
            var l = elemLabel(n);
            return op === '*=' ? l.toLowerCase().indexOf(wantName.toLowerCase()) >= 0 : l.toLowerCase() === wantName.toLowerCase();
          });
          return pickList(matched);
        }
      }

      if (t.startsWith('text=')) {
        var rawText = t.slice(5).trim();
        var exact = (rawText.startsWith('"') && rawText.endsWith('"')) || (rawText.startsWith("'") && rawText.endsWith("'"));
        var want = exact ? rawText.slice(1, -1) : rawText.toLowerCase();
        var cands = collectAllElements(document, 'a,button,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="option"],label,li,span,div');
        var exactHits = [];
        var subHits = [];
        for (var k = 0; k < cands.length; k++) {
          var c = cands[k];
          if (!isVisible(c)) continue;
          var txt = elemLabel(c);
          if (!txt) continue;
          if (exact) {
            if (txt === want) exactHits.push(c);
          } else {
            var low = txt.toLowerCase();
            if (low === want) exactHits.push(c);
            else if (low.indexOf(want) >= 0) subHits.push(c);
          }
        }
        // Prefer innermost clickable match when nested divs also contain the text
        var choose = function(arr) {
          if (!arr.length) return null;
          var interactive = arr.filter(function(el){
            var tg = el.tagName.toLowerCase();
            return tg === 'a' || tg === 'button' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'link';
          });
          var src = interactive.length ? interactive : arr;
          // Prefer deepest element (smallest bounding box)
          src.sort(function(a, b){
            var ra = a.getBoundingClientRect();
            var rb = b.getBoundingClientRect();
            return (ra.width * ra.height) - (rb.width * rb.height);
          });
          return pickList(src);
        };
        return choose(exactHits) || choose(subHits);
      }

      var cssStr = t.startsWith('loc=css:') ? t.slice(8) : t.startsWith('css=') ? t.slice(4) : t;
      var hasTextMatch = /^(.*):has-text\\((['"])(.*?)\\2\\)$/.exec(cssStr);
      if (hasTextMatch) {
        var baseSel = hasTextMatch[1].trim() || '*';
        var htWant = hasTextMatch[3].toLowerCase();
        var baseNodes = collectAllElements(document, baseSel);
        return pickList(baseNodes.filter(function(n){ return elemLabel(n).toLowerCase().indexOf(htWant) >= 0; }));
      }
      var textIsMatch = /^(.*):text-is\\((['"])(.*?)\\2\\)$/.exec(cssStr);
      if (textIsMatch) {
        var baseSel2 = textIsMatch[1].trim() || '*';
        var tiWant = textIsMatch[3];
        var baseNodes2 = collectAllElements(document, baseSel2);
        return pickList(baseNodes2.filter(function(n){ return elemLabel(n) === tiWant; }));
      }

      var cssHits = collectAllElements(document, cssStr);
      return pickList(cssHits);
    }

    function snapshot(opts) {
      opts = opts || {};
      var scope = opts.scope || 'viewport';
      var maxChars = Number(opts.maxChars || 16000);
      var rootEl = document;
      if (scope === 'subtree' && opts.root) {
        var foundRoot = resolveSelector(opts.root);
        if (foundRoot) rootEl = foundRoot;
      }
      st.refs.clear();
      st.next = 1;
      var sel = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="option"],[role="textbox"],[contenteditable="true"],h1,h2,h3';
      var nodes = collectAllElements(rootEl, sel);
      var lines = ['Title: ' + (document.title || '(untitled)'), 'URL: ' + location.href];
      var gate = detectAuthGate();
      if (gate) lines.push('Notice: [HANDOFF_RECOMMENDED] ' + gate);
      var belowFold = 0;
      var maxItems = scope === 'full_page' ? 240 : 140;
      for (var i = 0; i < nodes.length && st.next <= maxItems; i++) {
        var el = nodes[i];
        if (!isVisible(el)) continue;
        if (scope === 'viewport' && !inViewport(el)) {
          belowFold++;
          continue;
        }
        var tag = el.tagName.toLowerCase();
        var lbl = elemLabel(el);
        if (!lbl && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
        var key = '@e' + (st.next++);
        st.refs.set(key, el);
        var r = el.getBoundingClientRect();
        var extra = '';
        if (tag === 'input' && (el.type || '').toLowerCase() === 'password') extra = ' [password]';
        else if (typeof el.value === 'string' && el.value && tag !== 'button') extra = ' value=' + JSON.stringify(el.value.slice(0, 48));
        if (el.disabled) extra += ' [disabled]';
        if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) extra += ' [active]';
        lines.push(key + ' [' + elemRole(el) + '] ' + JSON.stringify(lbl) + extra + ' [' + Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) + ']');
      }
      if (belowFold > 0) {
        lines.push('[more content below the viewport: ' + belowFold + ' nodes — scroll or use scope="full_page"]');
      }
      var text = lines.join('\\n');
      if (text.length > maxChars) text = text.slice(0, maxChars) + '\\n...(truncated)';
      return {
        url: location.href,
        title: document.title || '',
        authGate: gate,
        text: text,
        lines: lines,
        viewportW: window.innerWidth || 1280,
        viewportH: window.innerHeight || 820,
      };
    }

    function locateForAction(target, checkSensitive) {
      var el = resolveSelector(target);
      if (!el) return { found: false, error: '未找到目标元素：' + String(target || '') + '（请先运行 snapshot 刷新 @e ref）', url: location.href, title: document.title || '' };
      if (checkSensitive) {
        var gate = isSensitive(el);
        if (gate) return { found: true, handoff: gate, url: location.href, title: document.title || '' };
      }
      if (el.scrollIntoView) el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      var r = el.getBoundingClientRect();
      return {
        found: true,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        viewportW: window.innerWidth || 1280,
        viewportH: window.innerHeight || 820,
        label: elemLabel(el),
        tag: (el.tagName || '').toLowerCase(),
        url: location.href,
        title: document.title || '',
      };
    }

    function selectOption(target, val) {
      var el = resolveSelector(target);
      if (!el || (el.tagName || '').toLowerCase() !== 'select') {
        return { ok: false, error: '未找到下拉选择框：' + String(target || '') };
      }
      var want = String(val ?? '');
      var opts = el.options || [];
      var matched = false;
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === want || opts[i].text.trim() === want) {
          el.value = opts[i].value;
          matched = true;
          break;
        }
      }
      if (!matched && /^\\d+$/.test(want)) {
        var idx = parseInt(want, 10);
        if (opts[idx]) { el.selectedIndex = idx; matched = true; }
      }
      if (!matched) return { ok: false, error: '未找到匹配选项：' + want };
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: el.value, url: location.href, title: document.title || '' };
    }

    window.__hpCdpHelper = {
      __v: 2,
      snapshot: snapshot,
      locateForAction: locateForAction,
      selectOption: selectOption,
      detectAuthGate: detectAuthGate,
      resolveSelector: resolveSelector,
    };
    return window.__hpCdpHelper;
  })()`;
}

function diffSnapshotLines(prev: string[] | undefined, next: string[]): string {
  if (!prev || prev.length === 0) return next.join("\n");
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  const removed = prev.filter((l) => !nextSet.has(l)).slice(0, 60);
  const added = next.filter((l) => !prevSet.has(l)).slice(0, 120);
  const header = next.slice(0, 2);
  const out = [
    ...header,
    `--- diff (+${added.length} / -${removed.length}) ---`,
    ...removed.map((l) => `- ${l}`),
    ...added.map((l) => `+ ${l}`),
  ];
  return out.join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class AiBrowserEngine {
  readonly pool: CdpBrowserPool;
  private spaces = new Map<string, ManagedSpace>();
  private activeSpaceId: string | null = null;
  private nextSpaceSeq = 1;
  private hooks: AiBrowserEngineHooks;
  private popupWaiters = new Map<string, Array<(popup: { label: string; targetId: string; url: string }) => void>>();
  private recentPopupsBySpace = new Map<string, Array<{ label: string; targetId: string; url: string }>>();
  private unsubPopup: () => void;
  private unsubDestroyed: () => void;

  constructor(opts?: { pool?: CdpBrowserPool; profileRoot?: string; hooks?: AiBrowserEngineHooks }) {
    this.hooks = opts?.hooks ?? {};
    this.pool =
      opts?.pool ??
      new CdpBrowserPool(opts?.profileRoot ?? join(stateDir(), "ai-browser"), {
        preferHeadlessShell: true,
        persistentProfile: true,
      });
    this.unsubPopup = this.pool.onPopupCreated((info) => {
      void this.handlePopupTarget(info).catch(() => {});
    });
    this.unsubDestroyed = this.pool.onTargetDestroyed((targetId) => {
      this.handleTargetDestroyed(targetId);
    });
  }

  setHooks(hooks: AiBrowserEngineHooks): void {
    this.hooks = hooks;
  }

  private async handlePopupTarget(info: PopupTargetInfo): Promise<void> {
    let ownerSpace: ManagedSpace | undefined;
    for (const sp of this.spaces.values()) {
      if (info.openerId && sp.pages.some((p) => p.targetId === info.openerId)) {
        ownerSpace = sp;
        break;
      }
      if (info.browserContextId && sp.browserContextId === info.browserContextId) {
        ownerSpace = sp;
        break;
      }
    }
    if (!ownerSpace) return;
    if (ownerSpace.pages.some((p) => p.targetId === info.targetId)) return;

    const label = `p${ownerSpace.nextPageNum++}`;
    const portalKey = `ai-${ownerSpace.id}-${label}`;
    try {
      const sess = await this.pool.attachExistingTarget(portalKey, info.targetId, info.url, ownerSpace.browserContextId);
      const pg: ManagedPage = {
        label,
        portalKey,
        targetId: info.targetId,
        title: sess.title || info.title || info.url || "新标签页",
        url: sess.url || info.url || "about:blank",
        openedBy: "popup",
        snapshotSeq: 0,
      };
      pg.unsubNet = sess.onNetworkChange(() => {
        ownerSpace!.updatedAt = Date.now();
        this.emitSpaceChanged(ownerSpace!);
      });
      ownerSpace.pages.push(pg);
      ownerSpace.activePage = label;
      ownerSpace.updatedAt = Date.now();

      const popupMeta = { label, targetId: info.targetId, url: pg.url };
      const list = this.recentPopupsBySpace.get(ownerSpace.id) ?? [];
      list.push(popupMeta);
      this.recentPopupsBySpace.set(ownerSpace.id, list);

      const waiters = this.popupWaiters.get(ownerSpace.id);
      if (waiters?.length) {
        this.popupWaiters.delete(ownerSpace.id);
        for (const resolve of waiters) resolve(popupMeta);
      }
      this.emitSpaceChanged(ownerSpace);
    } catch {
      // popup closed before attach
    }
  }

  private handleTargetDestroyed(targetId: string): void {
    for (const sp of this.spaces.values()) {
      const idx = sp.pages.findIndex((p) => p.targetId === targetId);
      if (idx < 0) continue;
      const [removed] = sp.pages.splice(idx, 1);
      removed?.unsubNet?.();
      if (sp.activePage === removed?.label) {
        sp.activePage = sp.pages[sp.pages.length - 1]?.label ?? "p1";
      }
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
      break;
    }
  }

  private summarizeSpace(sp: ManagedSpace): BrowserSpaceSummary {
    let totalNet = 0;
    const pages: BrowserSpacePageSummary[] = sp.pages.map((p) => {
      const sess = this.pool.get(p.portalKey);
      const netCount = sess?.getNetworkCount() ?? 0;
      totalNet += netCount;
      return {
        label: p.label,
        title: sess?.title || p.title || p.url || "新标签页",
        url: sess?.url || p.url || "about:blank",
        active: p.label === sp.activePage,
        targetId: p.targetId,
        portalId: sp.portalId,
        openedBy: p.openedBy,
        networkCount: netCount,
        canGoBack: sess?.canGoBack ?? false,
        canGoForward: sess?.canGoForward ?? false,
        ...(p.snapshotId ? { snapshotId: p.snapshotId } : {}),
      };
    });
    return {
      id: sp.id,
      name: sp.name,
      kind: sp.kind,
      ownership: sp.ownership,
      ...(sp.statusText ? { statusText: sp.statusText } : {}),
      ...(sp.handoffReason ? { handoffReason: sp.handoffReason } : {}),
      activePage: sp.activePage,
      ...(sp.portalId ? { portalId: sp.portalId } : {}),
      networkCount: totalNet,
      ...(sp.cursor ? { cursor: sp.cursor } : {}),
      ...(sp.headed ? { headed: true } : {}),
      createdAt: sp.createdAt,
      updatedAt: sp.updatedAt,
      pages,
    };
  }

  private emitSpaceChanged(sp: ManagedSpace): void {
    const activePg = sp.pages.find((p) => p.label === sp.activePage) ?? sp.pages[0];
    const sess = activePg ? this.pool.get(activePg.portalKey) ?? null : null;
    this.hooks.onSpaceChanged?.(this.summarizeSpace(sp), sess, sp.agentKey);
  }

  setSpacePortalId(spaceId: string, portalId: string): void {
    const sp = this.spaces.get(spaceId);
    if (sp) sp.portalId = portalId;
  }

  getActiveSession(spaceId: string, pageLabel?: string): CdpSession | null {
    const sp = this.spaces.get(spaceId);
    if (!sp) return null;
    const label = pageLabel?.trim() || sp.activePage;
    const pg = sp.pages.find((p) => p.label === label) ?? sp.pages[0];
    return pg ? this.pool.get(pg.portalKey) ?? null : null;
  }

  async dispatchPortalInput(spaceId: string, input: PortalInputAction): Promise<{ url?: string; title?: string }> {
    const sess = this.getActiveSession(spaceId);
    if (!sess) throw new Error("浏览器页面未就绪");
    const res = await sess.dispatchInput(input);
    const sp = this.spaces.get(spaceId);
    if (sp) {
      const pg = sp.pages.find((p) => p.label === sp.activePage);
      if (pg) {
        if (res.url) pg.url = res.url;
        if (res.title) pg.title = res.title;
      }
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
    }
    return res;
  }

  async getStatus(): Promise<RpcResult<"browser.status">> {
    const info = await this.pool.resolveBinaryInfo();
    const spaces = [...this.spaces.values()].map((sp) => this.summarizeSpace(sp));
    return {
      enabled: true,
      backend: info.bin || spaces.length > 0 ? "cdp" : "none",
      spaces,
      ...(this.activeSpaceId ? { activeSpaceId: this.activeSpaceId } : {}),
      ...(info.bin ? { chromePath: info.bin } : {}),
      resident: true,
      platform: process.platform,
    };
  }

  private resolveSpace(spaceId?: string, createName?: string, agentKey?: string): ManagedSpace {
    const raw = spaceId?.trim();
    if (raw) {
      const hit = this.spaces.get(raw) ?? [...this.spaces.values()].find((s) => s.name === raw);
      if (hit) {
        if (agentKey && !hit.agentKey) hit.agentKey = agentKey;
        return hit;
      }
      if (createName === undefined) {
        throw new Error(`浏览器空间 ${raw} 不存在（请先调用 open）`);
      }
      const sp: ManagedSpace = {
        id: raw,
        name: createName || raw,
        kind: "ai",
        ownership: "agentWorking",
        activePage: "p1",
        agentKey,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pages: [],
        nextPageNum: 1,
      };
      this.spaces.set(sp.id, sp);
      this.activeSpaceId = sp.id;
      return sp;
    }

    if (this.activeSpaceId && this.spaces.has(this.activeSpaceId)) {
      const cur = this.spaces.get(this.activeSpaceId)!;
      if (agentKey && !cur.agentKey) cur.agentKey = agentKey;
      return cur;
    }
    const first = this.spaces.values().next().value;
    if (first) return first;

    if (createName === undefined) {
      throw new Error("当前没有活动的 AI 浏览器空间，请先调用 open 打开网页。");
    }
    const id = `ai-${this.nextSpaceSeq++}`;
    const sp: ManagedSpace = {
      id,
      name: createName || `AI 浏览 · ${id.replace(/^ai-/, "")}`,
      kind: "ai",
      ownership: "agentWorking",
      activePage: "p1",
      agentKey,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pages: [],
      nextPageNum: 1,
    };
    this.spaces.set(id, sp);
    this.activeSpaceId = id;
    return sp;
  }

  private async ensurePage(
    sp: ManagedSpace,
    reqPage?: string,
    url = "about:blank",
    openedBy: "agent" | "user" | "popup" = "agent",
  ): Promise<{ page: ManagedPage; sess: CdpSession }> {
    const label = reqPage?.trim() || sp.activePage || "p1";
    const existing = sp.pages.find((p) => p.label === label);
    if (existing) {
      const sess = this.pool.get(existing.portalKey);
      if (sess) {
        sp.activePage = existing.label;
        return { page: existing, sess };
      }
      existing.unsubNet?.();
      sp.pages = sp.pages.filter((p) => p.label !== label);
    }

    const portalKey = `ai-${sp.id}-${label}`;
    const opened = await this.pool.open(portalKey, url, {
      ...(sp.browserContextId ? { browserContextId: sp.browserContextId } : {}),
    });
    const sess = this.pool.get(portalKey);
    if (!sess) throw new Error("创建浏览器会话失败");
    const numMatch = /^p(\d+)$/.exec(label);
    if (numMatch) sp.nextPageNum = Math.max(sp.nextPageNum, Number(numMatch[1]) + 1);
    else sp.nextPageNum = Math.max(sp.nextPageNum, sp.pages.length + 2);

    const pg: ManagedPage = {
      label,
      portalKey,
      targetId: opened.targetId,
      title: opened.title || url,
      url: opened.url || url,
      openedBy,
      snapshotSeq: 0,
    };
    pg.unsubNet = sess.onNetworkChange(() => {
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
    });
    sp.pages.push(pg);
    sp.activePage = pg.label;
    return { page: pg, sess };
  }

  private takeRecentPopups(spaceId: string): Array<{ label: string; targetId: string; url: string }> | undefined {
    const list = this.recentPopupsBySpace.get(spaceId);
    if (!list?.length) return undefined;
    this.recentPopupsBySpace.delete(spaceId);
    return list;
  }

  waitForPopup(spaceId: string, timeoutMs = 10_000): Promise<{ label: string; targetId: string; url: string }> {
    const existing = this.recentPopupsBySpace.get(spaceId);
    if (existing?.length) {
      const first = existing.shift()!;
      if (!existing.length) this.recentPopupsBySpace.delete(spaceId);
      return Promise.resolve(first);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = this.popupWaiters.get(spaceId) ?? [];
        this.popupWaiters.set(spaceId, arr.filter((fn) => fn !== onPopup));
        reject(new Error(`等待新标签弹窗超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      const onPopup = (p: { label: string; targetId: string; url: string }) => {
        clearTimeout(timer);
        resolve(p);
      };
      const arr = this.popupWaiters.get(spaceId) ?? [];
      arr.push(onPopup);
      this.popupWaiters.set(spaceId, arr);
    });
  }

  async inspectNetwork(params: RpcMethods["browser.net"]["params"]): Promise<RpcResult<"browser.net">> {
    const sp = this.resolveSpace(params.spaceId);
    const label = params.page?.trim() || sp.activePage || "p1";
    const pg = sp.pages.find((p) => p.label === label) ?? sp.pages[0];
    const sess = pg ? this.pool.get(pg.portalKey) : undefined;
    if (!pg || !sess) throw new Error(`页面 ${sp.id}/${label} 未打开`);

    if (params.action === "clear") {
      sess.clearNetwork();
      return { spaceId: sp.id, page: pg.label, requests: [], total: 0 };
    }
    if (params.action === "body") {
      if (!params.requestId) throw new Error("需要提供 requestId");
      const body = await sess.getNetworkBody(params.requestId);
      return { spaceId: sp.id, page: pg.label, body };
    }
    const requests = sess.listNetwork({
      filter: params.filter,
      resourceTypes: params.resourceTypes,
      limit: params.limit,
    });
    return { spaceId: sp.id, page: pg.label, requests, total: sess.getNetworkCount() };
  }

  async act(params: RpcMethods["browser.act"]["params"]): Promise<RpcResult<"browser.act">> {
    const op = params.op;

    if (op === "doctor") {
      const info = await this.pool.resolveBinaryInfo();
      const guiBin = await findChromiumBinary(process.platform, process.env, { headedOnly: true });
      return {
        ok: Boolean(info.bin),
        spaceId: this.activeSpaceId ?? "none",
        page: "p1",
        ownership: "user",
        doctor: {
          platform: process.platform,
          chromeBinary: info.bin,
          isHeadlessShell: info.isHeadlessShell,
          headedBinary: guiBin,
          profileDir: info.profileDir,
          activeSpaces: this.spaces.size,
          capabilities: [
            "cdp",
            "network_capture",
            "response_body",
            "multi_step_script",
            "popup_adoption",
            "shadow_dom",
            "snapshot_diff",
            "stale_ref_guard",
            "real_keyboard_mouse",
            "screenshot_png",
            "cookie_import",
            "headed_popout",
          ],
        },
        note: info.bin ? `Chromium CDP 引擎就绪（${info.isHeadlessShell ? "无焦点 headless-shell" : "无头 Chromium"}）` : "未检测到 Chromium/Chrome/Edge",
      };
    }

    if (op === "open") {
      const url = params.url?.trim() || "about:blank";
      const sp = this.resolveSpace(params.spaceId, params.label?.trim() || "", params.agentKey);
      const { page: pg, sess } = await this.ensurePage(sp, params.page, url, "agent");
      if (pg.url !== url && url !== "about:blank") {
        const nav = await sess.navigateTo(url, params.timeoutMs ?? 15_000);
        pg.url = nav.url;
        pg.title = nav.title || nav.url;
      } else {
        await sess.refreshNavState();
        pg.url = sess.url;
        pg.title = sess.title || pg.url;
      }
      sp.ownership = "agentWorking";
      sp.handoffReason = undefined;
      sp.statusText = params.label || `已打开 ${pg.title || pg.url}`;
      sp.updatedAt = Date.now();
      this.activeSpaceId = sp.id;
      this.emitSpaceChanged(sp);
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        targetId: pg.targetId,
        portalId: sp.portalId,
        url: pg.url,
        title: pg.title,
        ownership: sp.ownership,
      };
    }

    const sp = this.resolveSpace(params.spaceId, undefined, params.agentKey);
    const label = params.page?.trim() || sp.activePage || "p1";

    if (op === "finish") {
      const keep = new Set(params.keep ?? []);
      for (const pg of sp.pages) {
        if (!keep.has(pg.label)) {
          pg.unsubNet?.();
          this.pool.close(pg.portalKey);
        }
      }
      sp.pages = sp.pages.filter((p) => keep.has(p.label));
      if (sp.pages.length === 0) {
        if (sp.browserContextId) void this.pool.disposeBrowserContext(sp.browserContextId);
        this.spaces.delete(sp.id);
        if (this.activeSpaceId === sp.id) this.activeSpaceId = this.spaces.keys().next().value ?? null;
        this.hooks.onSpaceClosed?.(sp.id);
      } else {
        sp.ownership = "user";
        sp.statusText = undefined;
        sp.handoffReason = undefined;
        sp.activePage = sp.pages[0]!.label;
        sp.updatedAt = Date.now();
        this.emitSpaceChanged(sp);
      }
      return {
        ok: true,
        spaceId: sp.id,
        page: label,
        ownership: "user",
        note: "已结束本次 AI 浏览任务空间",
      };
    }

    if (op === "handoff") {
      sp.ownership = "agentHandoff";
      sp.handoffReason = params.reason || "需要用户手动完成当前操作";
      sp.statusText = "等待你的操作";
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
      const curPg = sp.pages.find((p) => p.label === sp.activePage);
      return {
        ok: true,
        spaceId: sp.id,
        page: curPg?.label ?? label,
        portalId: sp.portalId,
        url: curPg?.url,
        title: curPg?.title,
        ownership: sp.ownership,
        handoffReason: sp.handoffReason,
        note: sp.handoffReason,
      };
    }

    if (op === "takeover") {
      sp.ownership = "user";
      sp.handoffReason = undefined;
      sp.statusText = "已由你接管";
      sp.cursor = undefined;
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
      return {
        ok: true,
        spaceId: sp.id,
        page: label,
        portalId: sp.portalId,
        ownership: "user",
        note: "已切换到用户手动接管模式",
      };
    }

    if (op === "resume") {
      sp.ownership = "agentWorking";
      sp.handoffReason = undefined;
      sp.statusText = params.label || "已交还 AI 继续";
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
      return {
        ok: true,
        spaceId: sp.id,
        page: label,
        portalId: sp.portalId,
        ownership: "agentWorking",
        note: "AI 已恢复操作权",
      };
    }

    if (op === "tabs") {
      const action = params.tabAction ?? "list";
      if (action === "open") {
        const nextLabel = params.page?.trim() || `p${sp.nextPageNum++}`;
        const targetUrl = params.url?.trim() || "about:blank";
        const { page: npg } = await this.ensurePage(sp, nextLabel, targetUrl, "agent");
        sp.updatedAt = Date.now();
        this.emitSpaceChanged(sp);
        return {
          ok: true,
          spaceId: sp.id,
          page: npg.label,
          targetId: npg.targetId,
          portalId: sp.portalId,
          url: npg.url,
          title: npg.title,
          ownership: sp.ownership,
          tabs: this.summarizeSpace(sp).pages,
        };
      }
      if (action === "switch") {
        const want = params.page?.trim() || params.target?.trim();
        const hit = sp.pages.find((p) => p.label === want || p.targetId === want);
        if (!hit) throw new Error(`未找到页签：${want ?? ""}`);
        sp.activePage = hit.label;
        sp.updatedAt = Date.now();
        const sess = this.pool.get(hit.portalKey);
        void sess?.captureOnce(true).catch(() => {});
        this.emitSpaceChanged(sp);
        return {
          ok: true,
          spaceId: sp.id,
          page: hit.label,
          targetId: hit.targetId,
          portalId: sp.portalId,
          url: sess?.url ?? hit.url,
          title: sess?.title ?? hit.title,
          ownership: sp.ownership,
          tabs: this.summarizeSpace(sp).pages,
        };
      }
      if (action === "close") {
        const want = params.page?.trim() || params.target?.trim() || sp.activePage;
        const hit = sp.pages.find((p) => p.label === want || p.targetId === want);
        if (hit) {
          hit.unsubNet?.();
          this.pool.close(hit.portalKey);
          sp.pages = sp.pages.filter((p) => p !== hit);
          if (sp.activePage === hit.label) {
            sp.activePage = sp.pages[sp.pages.length - 1]?.label ?? "p1";
          }
          sp.updatedAt = Date.now();
          this.emitSpaceChanged(sp);
        }
        return {
          ok: true,
          spaceId: sp.id,
          page: sp.activePage,
          portalId: sp.portalId,
          ownership: sp.ownership,
          tabs: this.summarizeSpace(sp).pages,
        };
      }
      return {
        ok: true,
        spaceId: sp.id,
        page: sp.activePage,
        portalId: sp.portalId,
        ownership: sp.ownership,
        tabs: this.summarizeSpace(sp).pages,
      };
    }

    const pg = sp.pages.find((p) => p.label === label) ?? sp.pages[0];
    const sess = pg ? this.pool.get(pg.portalKey) : undefined;
    if (!pg || !sess) {
      throw new Error(`页面 ${sp.id}/${label} 尚未打开，请先执行 open`);
    }
    sp.activePage = pg.label;

    // Respect user takeover/handoff lock for mutating agent operations
    const readOnlyOps = new Set(["snapshot", "net_list", "net_body", "net_wait", "net_clear", "screenshot", "verify", "eval", "popout", "import_cookies", "navigate", "back", "forward", "reload"]);
    if (!readOnlyOps.has(op) && sp.ownership !== "agentWorking") {
      return {
        ok: false,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        handoffReason: sp.handoffReason,
        note:
          sp.ownership === "agentHandoff"
            ? "正在等待用户手动完成当前步骤，完成后请点击“已完成，交还 AI”"
            : "用户已接管该浏览空间，AI 已暂停自动操作",
      };
    }

    if (op === "popout") {
      const pop = await this.pool.popoutUrl(sess.url);
      sp.headed = pop.launched;
      this.emitSpaceChanged(sp);
      return {
        ok: pop.launched,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        note: pop.note,
      };
    }

    if (op === "import_cookies") {
      const n = await sess.setCookies(params.cookies ?? []);
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        note: `已导入 ${n} 条 Cookie`,
      };
    }

    if (op === "navigate") {
      const targetUrl = params.url?.trim();
      if (!targetUrl) throw new Error("navigate 需要提供 url");
      const nav = await sess.navigateTo(targetUrl, params.timeoutMs ?? 15_000);
      pg.url = nav.url;
      pg.title = nav.title || nav.url;
      pg.snapshotId = undefined;
      sp.statusText = params.label || `导航到 ${pg.title || pg.url}`;
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
      return { ok: true, spaceId: sp.id, page: pg.label, targetId: pg.targetId, portalId: sp.portalId, url: pg.url, title: pg.title, ownership: sp.ownership };
    }

    if (op === "reload") {
      const nav = await sess.reload(params.timeoutMs ?? 15_000);
      pg.url = nav.url;
      pg.title = nav.title || nav.url;
      pg.snapshotId = undefined;
      this.emitSpaceChanged(sp);
      return { ok: true, spaceId: sp.id, page: pg.label, portalId: sp.portalId, url: pg.url, title: pg.title, ownership: sp.ownership };
    }

    if (op === "back" || op === "forward") {
      const nav = await sess.goBackOrForward(op);
      pg.url = nav.url;
      pg.title = nav.title || nav.url;
      pg.snapshotId = undefined;
      this.emitSpaceChanged(sp);
      return { ok: true, spaceId: sp.id, page: pg.label, portalId: sp.portalId, url: pg.url, title: pg.title, ownership: sp.ownership };
    }

    if (op === "net_list" || op === "net_clear" || op === "net_body") {
      const action = op === "net_clear" ? "clear" : op === "net_body" ? "body" : "list";
      const netRes = await this.inspectNetwork({
        spaceId: sp.id,
        page: pg.label,
        action,
        requestId: params.requestId,
        filter: params.filter,
        resourceTypes: params.resourceTypes,
        limit: params.limit,
      });
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        requests: netRes.requests,
        networkBody: netRes.body,
      };
    }

    if (op === "net_wait") {
      const filter = params.filter?.trim() || params.url?.trim() || params.target?.trim() || "";
      if (!filter) throw new Error("net_wait 需要提供 URL 匹配词或通配符");
      const waited = await sess.waitForResponse(filter, {
        includeBuffered: params.includeBuffered !== false,
        status: params.expect?.status,
        timeoutMs: params.timeoutMs ?? 12_000,
        includeBody: params.includeBody !== false,
      });
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        response: {
          ok: (waited.entry.status ?? 0) >= 200 && (waited.entry.status ?? 0) < 400,
          status: waited.entry.status ?? 0,
          statusText: waited.entry.statusText ?? "",
          url: waited.entry.url,
          headers: waited.entry.responseHeaders ?? {},
          body: waited.body?.body ?? "",
          fromCache: waited.entry.fromCache,
          requestId: waited.entry.requestId,
          ...(waited.body?.json !== undefined ? { json: waited.body.json } : {}),
        },
        networkBody: waited.body,
      };
    }

    if (op === "dialog") {
      await sess.handleDialog(params.accept !== false, params.promptText);
      return { ok: true, spaceId: sp.id, page: pg.label, portalId: sp.portalId, url: sess.url, title: sess.title, ownership: sp.ownership };
    }

    if (op === "upload") {
      if (!params.target || !params.files?.length) throw new Error("upload 需要 target 和 files 绝对路径");
      await sess.setFileInputFiles(params.target, params.files);
      return { ok: true, spaceId: sp.id, page: pg.label, portalId: sp.portalId, url: sess.url, title: sess.title, ownership: sp.ownership };
    }

    if (op === "screenshot") {
      const b64 = await sess.capturePng({ fullPage: params.fullPage });
      let savedPath: string | undefined;
      if (params.path) {
        if (!isAbsolute(params.path)) throw new Error("screenshot path 必须是绝对路径");
        mkdirSync(dirname(params.path), { recursive: true });
        writeFileSync(params.path, Buffer.from(b64, "base64"));
        savedPath = params.path;
      }
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        ...(savedPath ? { screenshotPath: savedPath } : { screenshotBase64: b64 }),
      };
    }

    if (op === "eval") {
      const expr = params.expression?.trim() || params.value?.trim();
      if (!expr) throw new Error("eval 需要提供 expression");
      const val = await sess.evalJson(expr, params.timeoutMs ?? 15_000);
      await sess.refreshNavState();
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        value: val,
      };
    }

    if (op === "fetch") {
      const targetUrl = params.url?.trim();
      if (!targetUrl) throw new Error("fetch 需要提供 url");
      const fetchArgs = JSON.stringify({
        url: targetUrl,
        method: params.method || "GET",
        headers: params.headers || {},
        body: params.body,
      });
      const res = await sess.evalJson<{
        ok: boolean;
        status: number;
        statusText: string;
        url: string;
        headers: Record<string, string>;
        body: string;
      }>(
        `(async function(cfg){
          var r = await fetch(cfg.url, { method: cfg.method, headers: cfg.headers, body: cfg.body, credentials: 'include' });
          var hdrs = {};
          r.headers.forEach(function(v, k){ hdrs[k] = v; });
          var txt = await r.text();
          return { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers: hdrs, body: txt.slice(0, 262144) };
        })(${fetchArgs})`,
        params.timeoutMs ?? 15_000,
      );
      let json: unknown = undefined;
      const trimmed = (res?.body ?? "").trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          // plain text
        }
      }
      return {
        ok: Boolean(res?.ok),
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        response: { ...res, ...(json !== undefined ? { json } : {}) },
      };
    }

    if (op === "cdp") {
      if (!params.cdpMethod?.trim()) throw new Error("cdp 需要提供 cdpMethod");
      const val = await sess.rawCdp(params.cdpMethod.trim(), params.cdpParams ?? {}, params.timeoutMs ?? 15_000);
      pg.snapshotId = undefined;
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        value: val,
      };
    }

    if (op === "snapshot") {
      const snapOpts = JSON.stringify({
        scope: params.scope || "viewport",
        root: params.root,
        maxChars: params.maxChars || 16_000,
      });
      const res = await sess.evalJson<SnapshotEvalResult>(`(${buildPageHelperBootstrap()}).snapshot(${snapOpts})`);
      const sid = `s${++pg.snapshotSeq}`;
      const diffText = params.diff ? diffSnapshotLines(pg.lastSnapshotLines, res.lines) : res.text;
      pg.snapshotId = sid;
      pg.lastSnapshotLines = res.lines;
      pg.url = res.url || sess.url;
      pg.title = res.title || sess.title;
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        targetId: pg.targetId,
        portalId: sp.portalId,
        url: pg.url,
        title: pg.title,
        ownership: sp.ownership,
        snapshotId: sid,
        snapshot: diffText,
        ...(sess.getDialog() ? { dialog: sess.getDialog()! } : {}),
      };
    }

    if (op === "wait") {
      const kind = params.waitKind ?? (params.filter ? "response" : params.url ? "url" : params.target ? "selector" : params.expression ? "function" : "timeout");
      const timeoutMs = Math.max(100, Math.min(60_000, params.timeoutMs ?? 10_000));
      if (kind === "timeout") {
        await delay(Math.min(timeoutMs, 15_000));
      } else if (kind === "load") {
        await sess.waitForLoadSignal(timeoutMs);
        await sess.refreshNavState();
      } else if (kind === "response") {
        const filter = params.filter || params.url || params.target || "";
        return this.act({ ...params, op: "net_wait", filter, timeoutMs });
      } else if (kind === "url") {
        const want = params.url || params.filter || params.target || "";
        const deadline = Date.now() + timeoutMs;
        let matched = false;
        while (Date.now() < deadline) {
          await sess.refreshNavState();
          if (sess.url.toLowerCase().includes(want.toLowerCase())) {
            matched = true;
            break;
          }
          await delay(150);
        }
        if (!matched) throw new Error(`等待 URL 包含 "${want}" 超时（当前：${sess.url}）`);
      } else if (kind === "selector") {
        const sel = params.target || "";
        const deadline = Date.now() + timeoutMs;
        let matched = false;
        while (Date.now() < deadline) {
          const hit = await sess.evalJson<boolean>(
            `Boolean((${buildPageHelperBootstrap()}).locateForAction(${JSON.stringify(sel)}, false).found)`,
          );
          if (hit) {
            matched = true;
            break;
          }
          await delay(180);
        }
        if (!matched) throw new Error(`等待元素 "${sel}" 超时`);
      } else if (kind === "function") {
        const expr = params.expression || params.value || "false";
        const deadline = Date.now() + timeoutMs;
        let matched = false;
        while (Date.now() < deadline) {
          const ok = await sess.evalJson<unknown>(expr).catch(() => false);
          if (ok) {
            matched = true;
            break;
          }
          await delay(200);
        }
        if (!matched) throw new Error("等待页面条件函数成立超时");
      } else if (kind === "human") {
        const deadline = Date.now() + timeoutMs;
        let resolved = false;
        while (Date.now() < deadline) {
          const gate = await sess.evalJson<string | null>(`(${buildPageHelperBootstrap()}).detectAuthGate()`).catch(() => null);
          const selOk = params.target
            ? await sess.evalJson<boolean>(`Boolean((${buildPageHelperBootstrap()}).locateForAction(${JSON.stringify(params.target)}, false).found)`).catch(() => false)
            : true;
          if (!gate && selOk && sp.ownership !== "agentHandoff") {
            resolved = true;
            break;
          }
          await delay(400);
        }
        return {
          ok: resolved,
          spaceId: sp.id,
          page: pg.label,
          portalId: sp.portalId,
          url: sess.url,
          title: sess.title,
          ownership: sp.ownership,
          note: resolved ? "用户已完成操作" : "等待用户操作超时",
        };
      }
      await sess.refreshNavState();
      return { ok: true, spaceId: sp.id, page: pg.label, portalId: sp.portalId, url: sess.url, title: sess.title, ownership: sp.ownership };
    }

    if (op === "verify") {
      const exp = params.expect ?? {};
      await sess.refreshNavState();
      const pageState = await sess.evalJson<{ url: string; title: string; bodyText: string; selectorFound: boolean }>(
        `(function(){
          var h = ${buildPageHelperBootstrap()};
          return {
            url: location.href,
            title: document.title || '',
            bodyText: (document.body && document.body.innerText || '').slice(0, 32000),
            selectorFound: ${exp.selector ? `Boolean(h.locateForAction(${JSON.stringify(exp.selector)}, false).found)` : "true"}
          };
        })()`,
      );
      const failures: string[] = [];
      if (exp.urlIncludes && !pageState.url.toLowerCase().includes(exp.urlIncludes.toLowerCase())) {
        failures.push(`URL 未包含 "${exp.urlIncludes}"（实际：${pageState.url}）`);
      }
      if (exp.titleIncludes && !pageState.title.toLowerCase().includes(exp.titleIncludes.toLowerCase())) {
        failures.push(`标题未包含 "${exp.titleIncludes}"（实际：${pageState.title}）`);
      }
      if (exp.selector && !pageState.selectorFound) {
        failures.push(`未找到元素 "${exp.selector}"`);
      }
      if (exp.textIncludes && !pageState.bodyText.toLowerCase().includes(exp.textIncludes.toLowerCase())) {
        failures.push(`页面正文未包含 "${exp.textIncludes}"`);
      }
      if (exp.notTextIncludes && pageState.bodyText.toLowerCase().includes(exp.notTextIncludes.toLowerCase())) {
        failures.push(`页面正文仍包含 "${exp.notTextIncludes}"`);
      }
      if (exp.responseUrl) {
        const hit = sess.listNetwork({ filter: exp.responseUrl, limit: 20 }).find((r) => (exp.status === undefined ? true : r.status === exp.status));
        if (!hit) failures.push(`未捕获到匹配的接口响应 "${exp.responseUrl}"`);
      }
      const satisfied = failures.length === 0;
      return {
        ok: satisfied,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: pageState.url,
        title: pageState.title,
        ownership: sp.ownership,
        verified: {
          satisfied,
          reason: satisfied ? "所有预期条件已满足" : failures.join("；"),
          actual: { url: pageState.url, title: pageState.title },
        },
      };
    }

    // Stale-ref guard when caller supplies snapshotId
    if (params.snapshotId && pg.snapshotId && params.snapshotId !== pg.snapshotId && params.target && /^(@e?\d+|ref=\d+)$/i.test(params.target.trim())) {
      return {
        ok: false,
        code: "STALE_REF",
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        note: `快照代次已过期（传入 ${params.snapshotId}，当前 ${pg.snapshotId}），请先重新 snapshot 再操作`,
      };
    }

    // Clear stale recent popups right before action so we only return popups spawned by THIS action
    this.recentPopupsBySpace.delete(sp.id);

    const recordCursor = (x: number, y: number, viewportW: number, viewportH: number, actionLabel: string, box?: { x: number; y: number; width: number; height: number }) => {
      const overlay: BrowserCursorOverlay = { x, y, viewportW, viewportH, ...(box ? { box } : {}), label: actionLabel, op, at: Date.now() };
      sp.cursor = overlay;
      sp.statusText = actionLabel;
      sess.setCursorOverlay(overlay);
      this.emitSpaceChanged(sp);
    };

    if (op === "scroll") {
      const dx = Number(params.deltaX ?? 0) || 0;
      const dy = Number(params.deltaY ?? 480) || 480;
      const beforeY = await sess.evalJson<number>("window.scrollY || document.documentElement.scrollTop || 0").catch(() => 0);
      const cx = Math.round(sess.viewportW / 2);
      const cy = Math.round(sess.viewportH / 2);
      recordCursor(cx, cy, sess.viewportW, sess.viewportH, params.label || (dy >= 0 ? "向下滚动页面" : "向上滚动页面"));
      await sess.wheelAt(cx, cy, dx, dy);
      await delay(180);
      const afterY = await sess.evalJson<number>("window.scrollY || document.documentElement.scrollTop || 0").catch(() => beforeY);
      void sess.captureOnce(true).catch(() => {});
      return {
        ok: true,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        cursor: sp.cursor,
        value: { beforeY, afterY, moved: Math.abs(afterY - beforeY) > 1 },
      };
    }

    if (op === "drag") {
      if (params.x !== undefined && params.y !== undefined && params.toX !== undefined && params.toY !== undefined) {
        recordCursor(params.toX, params.toY, sess.viewportW, sess.viewportH, params.label || "拖拽元素");
        await sess.dragPoints(params.x, params.y, params.toX, params.toY);
      } else {
        throw new Error("drag 需要提供 x, y, toX, toY 坐标");
      }
      await delay(150);
      void sess.captureOnce(true).catch(() => {});
      return { ok: true, spaceId: sp.id, page: pg.label, portalId: sp.portalId, url: sess.url, title: sess.title, ownership: sp.ownership, cursor: sp.cursor };
    }

    if (op === "select") {
      const res = await sess.evalJson<{ ok: boolean; value?: string; error?: string; url?: string; title?: string }>(
        `(${buildPageHelperBootstrap()}).selectOption(${JSON.stringify(params.target ?? "")}, ${JSON.stringify(params.value ?? "")})`,
      );
      if (!res?.ok) throw new Error(res?.error || "选择选项失败");
      void sess.captureOnce(true).catch(() => {});
      return { ok: true, spaceId: sp.id, page: pg.label, portalId: sp.portalId, url: res.url ?? sess.url, title: res.title ?? sess.title, ownership: sp.ownership, value: res.value };
    }

    if (op === "press" && !params.target) {
      const key = params.key || "Enter";
      sp.statusText = params.label || `按键 ${key}`;
      this.emitSpaceChanged(sp);
      await sess.pressKey(key);
      await delay(280);
      await sess.refreshNavState();
      pg.url = sess.url;
      pg.title = sess.title;
      void sess.captureOnce(true).catch(() => {});
      const popups = this.takeRecentPopups(sp.id);
      this.emitSpaceChanged(sp);
      return {
        ok: true,
        spaceId: sp.id,
        page: popups?.[0]?.label ?? pg.label,
        portalId: sp.portalId,
        url: pg.url,
        title: pg.title,
        ownership: sp.ownership,
        ...(popups ? { popups } : {}),
        ...(sess.getDialog() ? { dialog: sess.getDialog()! } : {}),
      };
    }

    // Coordinate click/hover shortcut when x & y provided without target
    if ((op === "click" || op === "dblclick" || op === "hover") && !params.target && params.x !== undefined && params.y !== undefined) {
      const actionLabel = params.label || `${op} (${params.x}, ${params.y})`;
      recordCursor(params.x, params.y, sess.viewportW, sess.viewportH, actionLabel);
      if (op === "hover") await sess.hoverPoint(params.x, params.y);
      else await sess.clickPoint(params.x, params.y, { clickCount: op === "dblclick" ? 2 : 1 });
      await delay(200);
      await sess.refreshNavState();
      void sess.captureOnce(true).catch(() => {});
      const popups = this.takeRecentPopups(sp.id);
      return {
        ok: true,
        spaceId: sp.id,
        page: popups?.[0]?.label ?? pg.label,
        portalId: sp.portalId,
        url: sess.url,
        title: sess.title,
        ownership: sp.ownership,
        cursor: sp.cursor,
        ...(popups ? { popups } : {}),
        ...(sess.getDialog() ? { dialog: sess.getDialog()! } : {}),
      };
    }

    // Element-targeted real CDP interactions: click, dblclick, hover, fill, type, press
    const checkSens = op === "click" || op === "fill" || op === "type";
    const loc = await sess.evalJson<ElementLocateResult>(
      `(${buildPageHelperBootstrap()}).locateForAction(${JSON.stringify(params.target ?? "")}, ${checkSens})`,
    );
    if (loc?.handoff) {
      sp.ownership = "agentHandoff";
      sp.handoffReason = loc.handoff;
      sp.statusText = "需要你协助完成验证/登录";
      sp.updatedAt = Date.now();
      this.emitSpaceChanged(sp);
      return {
        ok: false,
        spaceId: sp.id,
        page: pg.label,
        portalId: sp.portalId,
        url: loc.url ?? sess.url,
        title: loc.title ?? sess.title,
        ownership: "agentHandoff",
        handoffReason: loc.handoff,
        note: loc.handoff,
      };
    }
    if (!loc?.found || loc.x === undefined || loc.y === undefined) {
      throw new Error(loc?.error || `未找到目标元素：${params.target ?? ""}`);
    }

    const actionLabel =
      params.label ||
      (op === "fill" || op === "type"
        ? `输入 ${loc.label || params.target || ""}`.trim()
        : op === "press"
          ? `按键 ${params.key || "Enter"}`
          : `${op === "hover" ? "悬停" : op === "dblclick" ? "双击" : "点击"} ${loc.label || params.target || ""}`.trim());
    recordCursor(loc.x, loc.y, loc.viewportW ?? sess.viewportW, loc.viewportH ?? sess.viewportH, actionLabel, loc.box);

    if (op === "hover") {
      await sess.hoverPoint(loc.x, loc.y);
    } else if (op === "click" || op === "dblclick") {
      await sess.clickPoint(loc.x, loc.y, { clickCount: op === "dblclick" ? 2 : 1 });
      await delay(240);
    } else if (op === "fill" || op === "type") {
      await sess.clickPoint(loc.x, loc.y, { clickCount: 1 });
      if (op === "fill") {
        await sess.pressKey("ControlOrMeta+a");
        await sess.pressKey("Backspace");
      }
      if (params.value) {
        await sess.insertText(params.value);
      }
      await delay(100);
    } else if (op === "press") {
      await sess.clickPoint(loc.x, loc.y, { clickCount: 1 });
      await sess.pressKey(params.key || "Enter");
      await delay(280);
    }

    await sess.refreshNavState();
    pg.url = sess.url;
    pg.title = sess.title || pg.url;
    pg.snapshotId = undefined;
    sp.updatedAt = Date.now();
    void sess.captureOnce(true).catch(() => {});
    const popups = this.takeRecentPopups(sp.id);
    this.emitSpaceChanged(sp);
    return {
      ok: true,
      spaceId: sp.id,
      page: popups?.[0]?.label ?? pg.label,
      targetId: pg.targetId,
      portalId: sp.portalId,
      url: pg.url,
      title: pg.title,
      ownership: sp.ownership,
      cursor: sp.cursor,
      ...(popups ? { popups } : {}),
      ...(sess.getDialog() ? { dialog: sess.getDialog()! } : {}),
    };
  }

  /**
   * Executes a multi-step async JavaScript browser automation script in one invocation
   * with full Ego-compatible `taskSpace` / `page` / `network` / `cdp` helpers preloaded.
   */
  async runScript(params: RpcMethods["browser.run"]["params"]): Promise<RpcResult<"browser.run">> {
    const t0 = Date.now();
    const timeoutMs = Math.max(1000, Math.min(115_000, params.timeoutMs ?? 60_000));
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    let lastSpaceId = params.spaceId;

    const fakeConsole = {
      log: (...args: unknown[]) => stdoutLines.push(format(...args)),
      info: (...args: unknown[]) => stdoutLines.push(format(...args)),
      warn: (...args: unknown[]) => stderrLines.push(format(...args)),
      error: (...args: unknown[]) => stderrLines.push(format(...args)),
    };

    const makePageHandle = (spaceId: string, pageLabel: string) => {
      const actOn = (op: RpcMethods["browser.act"]["params"]["op"], extra: Partial<RpcMethods["browser.act"]["params"]> = {}) =>
        this.act({ ...extra, op, spaceId, page: pageLabel, agentKey: params.agentKey });
      const getSess = () => this.getActiveSession(spaceId, pageLabel);

      return {
        label: pageLabel,
        spaceId,
        get targetId() {
          return getSess()?.targetId ?? "";
        },
        url: async () => {
          const s = getSess();
          if (s) await s.refreshNavState();
          return s?.url ?? "";
        },
        title: async () => {
          const s = getSess();
          if (s) await s.refreshNavState();
          return s?.title ?? "";
        },
        info: async () => {
          const s = getSess();
          if (s) await s.refreshNavState();
          return {
            label: pageLabel,
            spaceId,
            targetId: s?.targetId ?? "",
            url: s?.url ?? "",
            title: s?.title ?? "",
            dialog: s?.getDialog() ?? null,
            networkCount: s?.getNetworkCount() ?? 0,
          };
        },
        goto: async (url: string, opts?: { timeout?: number }) => actOn("navigate", { url, timeoutMs: opts?.timeout }),
        reload: async (opts?: { timeout?: number }) => actOn("reload", { timeoutMs: opts?.timeout }),
        goBack: async () => actOn("back"),
        goForward: async () => actOn("forward"),
        snapshot: async (opts?: { scope?: "viewport" | "full_page" | "subtree"; root?: string; diff?: boolean; maxChars?: number }) => {
          const r = await actOn("snapshot", opts);
          return r.snapshot ?? "";
        },
        snapshotFull: async (opts?: { scope?: "viewport" | "full_page" | "subtree"; root?: string; diff?: boolean; maxChars?: number }) =>
          actOn("snapshot", opts),
        screenshot: async (opts?: { path?: string; fullPage?: boolean }) => {
          const outPath = opts?.path ?? join(tmpdir(), `hp-shot-${Date.now()}.png`);
          const r = await actOn("screenshot", { path: outPath, fullPage: opts?.fullPage });
          return r.screenshotPath ?? outPath;
        },
        click: async (target: string, opts?: { label?: string; snapshotId?: string }) => actOn("click", { target, ...opts }),
        dblclick: async (target: string, opts?: { label?: string; snapshotId?: string }) => actOn("dblclick", { target, ...opts }),
        hover: async (target: string, opts?: { label?: string; snapshotId?: string }) => actOn("hover", { target, ...opts }),
        fill: async (target: string, value: string, opts?: { snapshotId?: string }) => actOn("fill", { target, value, ...opts }),
        type: async (target: string, value: string) => actOn("type", { target, value }),
        selectOption: async (target: string, value: string | { label?: string; value?: string; index?: number }) => {
          const v = typeof value === "string" ? value : (value?.value ?? value?.label ?? String(value?.index ?? 0));
          return actOn("select", { target, value: v });
        },
        press: async (targetOrKey: string, maybeKey?: string) =>
          maybeKey !== undefined
            ? actOn("press", { target: targetOrKey, key: maybeKey })
            : actOn("press", { key: targetOrKey }),
        scroll: async (deltaY = 480, deltaX = 0) => actOn("scroll", { deltaY, deltaX }),
        waitForURL: async (url: string, opts?: { timeout?: number }) =>
          actOn("wait", { waitKind: "url", url, timeoutMs: opts?.timeout }),
        waitForSelector: async (target: string, opts?: { timeout?: number }) =>
          actOn("wait", { waitKind: "selector", target, timeoutMs: opts?.timeout }),
        waitForResponse: async (filter: string, opts?: { timeout?: number; includeBuffered?: boolean; status?: number; includeBody?: boolean }) => {
          const r = await actOn("net_wait", {
            filter,
            timeoutMs: opts?.timeout,
            includeBuffered: opts?.includeBuffered ?? false,
            includeBody: opts?.includeBody ?? true,
            ...(opts?.status !== undefined ? { expect: { status: opts.status } } : {}),
          });
          return r.response;
        },
        waitForFunction: async (fnOrExpr: string | ((arg?: unknown) => unknown), arg?: unknown, opts?: { timeout?: number }) => {
          const expression =
            typeof fnOrExpr === "function"
              ? `(${fnOrExpr.toString()})(${JSON.stringify(arg)})`
              : fnOrExpr;
          return actOn("wait", { waitKind: "function", expression, timeoutMs: opts?.timeout });
        },
        waitForLoadState: async (_state?: string, opts?: { timeout?: number }) =>
          actOn("wait", { waitKind: "load", timeoutMs: opts?.timeout }),
        waitForTimeout: async (ms: number) => delay(Math.min(ms, 15_000)),
        waitForEvent: async (event: "popup", opts?: { timeout?: number }) => {
          if (event !== "popup") throw new Error(`暂不支持 waitForEvent("${event}")`);
          const pop = await this.waitForPopup(spaceId, opts?.timeout ?? 12_000);
          return makePageHandle(spaceId, pop.label);
        },
        waitForHuman: async (opts?: { selector?: string; timeout?: number }) =>
          actOn("wait", { waitKind: "human", target: opts?.selector, timeoutMs: opts?.timeout }),
        verify: async (expect: NonNullable<RpcMethods["browser.act"]["params"]["expect"]>) => {
          const r = await actOn("verify", { expect });
          return r.verified;
        },
        evaluate: async (fnOrExpr: string | ((arg?: unknown) => unknown), arg?: unknown) => {
          const expression =
            typeof fnOrExpr === "function"
              ? `(${fnOrExpr.toString()})(${JSON.stringify(arg)})`
              : fnOrExpr;
          const r = await actOn("eval", { expression });
          return r.value;
        },
        fetch: async (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number }) => {
          const r = await actOn("fetch", { url, method: opts?.method, headers: opts?.headers, body: opts?.body, timeoutMs: opts?.timeout });
          return r.response;
        },
        cdp: async (cdpMethod: string, cdpParams: Record<string, unknown> = {}) => {
          const r = await actOn("cdp", { cdpMethod, cdpParams });
          return r.value;
        },
        acceptDialog: async (promptText?: string) => actOn("dialog", { accept: true, promptText }),
        dismissDialog: async () => actOn("dialog", { accept: false }),
        setInputFiles: async (target: string, files: string[]) => actOn("upload", { target, files }),
        close: async () => actOn("tabs", { tabAction: "close", page: pageLabel }),
        mouse: {
          click: async (x: number, y: number, opts?: { label?: string }) => actOn("click", { x, y, label: opts?.label }),
          move: async (x: number, y: number, opts?: { label?: string }) => actOn("hover", { x, y, label: opts?.label }),
          wheel: async (deltaX: number, deltaY: number) => actOn("scroll", { deltaX, deltaY }),
          drag: async (x: number, y: number, toX: number, toY: number) => actOn("drag", { x, y, toX, toY }),
        },
        keyboard: {
          press: async (key: string) => actOn("press", { key }),
          type: async (text: string) => {
            const s = getSess();
            if (!s) throw new Error("页面未打开");
            await s.insertText(text);
          },
          insertText: async (text: string) => {
            const s = getSess();
            if (!s) throw new Error("页面未打开");
            await s.insertText(text);
          },
        },
        network: {
          list: async (opts?: { filter?: string; resourceTypes?: string[]; limit?: number }) =>
            (await this.inspectNetwork({ spaceId, page: pageLabel, action: "list", ...opts })).requests ?? [],
          body: async (requestId: string) =>
            (await this.inspectNetwork({ spaceId, page: pageLabel, action: "body", requestId })).body,
          wait: async (filter: string, opts?: { timeout?: number; includeBuffered?: boolean; status?: number; includeBody?: boolean }) => {
            const r = await actOn("net_wait", {
              filter,
              timeoutMs: opts?.timeout,
              includeBuffered: opts?.includeBuffered,
              includeBody: opts?.includeBody,
              ...(opts?.status !== undefined ? { expect: { status: opts.status } } : {}),
            });
            return r.response;
          },
          clear: async () => {
            await this.inspectNetwork({ spaceId, page: pageLabel, action: "clear" });
          },
        },
      };
    };

    const makeSpaceHandle = (sp: ManagedSpace) => {
      lastSpaceId = sp.id;
      return {
        spaceId: sp.id,
        name: sp.name,
        get ownership() {
          return sp.ownership;
        },
        page: (label = "p1") => makePageHandle(sp.id, label),
        pages: async () => sp.pages.map((p) => makePageHandle(sp.id, p.label)),
        tabs: async () => this.summarizeSpace(sp).pages,
        newPage: async (url = "about:blank") => {
          const res = await this.act({ op: "tabs", tabAction: "open", spaceId: sp.id, url, agentKey: params.agentKey });
          return makePageHandle(sp.id, res.page);
        },
        handOff: async (reason?: string) => this.act({ op: "handoff", spaceId: sp.id, reason }),
        finish: async (opts?: { keep?: string[] }) => this.act({ op: "finish", spaceId: sp.id, keep: opts?.keep ?? [] }),
        cdp: async (method: string, cdpParams: Record<string, unknown> = {}) => this.pool.browserCdp(method, cdpParams),
      };
    };

    const taskSpace = async (nameOrId?: string) => {
      const want = nameOrId?.trim();
      const existing = want
        ? (this.spaces.get(want) ?? [...this.spaces.values()].find((s) => s.name === want))
        : (this.activeSpaceId ? this.spaces.get(this.activeSpaceId) : undefined);
      if (existing) {
        if (!existing.pages.length) {
          await this.ensurePage(existing, "p1", "about:blank", "agent");
        }
        return makeSpaceHandle(existing);
      }
      const sp = this.resolveSpace(undefined, want || "AI 浏览任务", params.agentKey);
      await this.ensurePage(sp, "p1", "about:blank", "agent");
      this.emitSpaceChanged(sp);
      return makeSpaceHandle(sp);
    };

    const listTaskSpaces = async () => [...this.spaces.values()].map((s) => this.summarizeSpace(s));
    const claimTaskSpace = async (id: string) => {
      await this.act({ op: "resume", spaceId: id });
      return taskSpace(id);
    };
    const takeOverTaskSpace = claimTaskSpace;

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...vals: unknown[]) => Promise<unknown>;

    let timedOut = false;
    try {
      const fn = new AsyncFunction(
        "taskSpace",
        "listTaskSpaces",
        "claimTaskSpace",
        "takeOverTaskSpace",
        "console",
        params.script,
      );
      const execPromise = fn(taskSpace, listTaskSpaces, claimTaskSpace, takeOverTaskSpace, fakeConsole);
      const result = await Promise.race([
        execPromise,
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => {
            timedOut = true;
            reject(new Error(`浏览器脚本执行超时（${timeoutMs}ms）`));
          }, timeoutMs);
          t.unref?.();
        }),
      ]);
      const sp = lastSpaceId ? this.spaces.get(lastSpaceId) : undefined;
      return {
        ok: true,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        ...(result !== undefined ? { result } : {}),
        ...(lastSpaceId ? { spaceId: lastSpaceId } : {}),
        ...(sp?.portalId ? { portalId: sp.portalId } : {}),
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const sp = lastSpaceId ? this.spaces.get(lastSpaceId) : undefined;
      return {
        ok: false,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        ...(lastSpaceId ? { spaceId: lastSpaceId } : {}),
        ...(sp?.portalId ? { portalId: sp.portalId } : {}),
        durationMs: Date.now() - t0,
        ...(timedOut ? { timedOut: true } : {}),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  shutdown(): void {
    this.unsubPopup();
    this.unsubDestroyed();
    for (const sp of this.spaces.values()) {
      for (const pg of sp.pages) pg.unsubNet?.();
    }
    this.spaces.clear();
    this.activeSpaceId = null;
    this.pool.closeAll();
  }
}

export const AI_BROWSER_SKILL_GUIDE = `# Herdr Pocket Built-in AI Browser (Cross-Platform Chromium CDP)

Cross-platform (macOS / Windows / Linux) resident Chromium CDP browser built into \`herdr-pocket\`, with live full-width Tab streaming, real mouse/keyboard input, popup adoption, and always-on network packet/response-body inspection.

## Quick Multi-Step Script (Recommended — parity with ego-browser nodejs)

\`\`\`bash
herdr-pocket browser run <<'EOF'
const task = await taskSpace("bilibili search");
const page = task.page("p1");
await page.goto("https://www.bilibili.com");
console.log(await page.snapshot());

const popupPromise = page.waitForEvent("popup");
await page.fill("input.nav-search-input", "国际空间站");
await page.press("input.nav-search-input", "Enter");
const p2 = await popupPromise;
await p2.waitForLoadState();

const resPromise = p2.waitForResponse("/x/web-interface/wbi/search/type");
await p2.click("text=最新发布");
const api = await resPromise;
console.log({ status: api.status, count: api.json?.data?.result?.length });
EOF
\`\`\`

## Structured Single Commands (share the same resident browser spaces!)

- \`herdr-pocket browser doctor\` — check detected Chromium/headless-shell binary & capabilities
- \`herdr-pocket browser status\` — list live AI browser spaces, tabs, and network counts
- \`herdr-pocket browser open <url> [--space <id>] [--label <name>]\`
- \`herdr-pocket browser snapshot [--space <id>] [--page <p>] [--full-page] [--diff] [--subtree <@eN>]\`
- \`herdr-pocket browser click|dblclick|hover <@eN|text=...|css> [--space <id>] [--page <p>]\`
- \`herdr-pocket browser fill|type|select <target> <value>\`
- \`herdr-pocket browser press <key> [target]\` (real CDP key events: Enter, Escape, ControlOrMeta+a, etc.)
- \`herdr-pocket browser scroll [deltaY]\`
- \`herdr-pocket browser wait --kind <url|selector|response|function|load|human|timeout> <value>\`
- \`herdr-pocket browser verify [--url ...] [--title ...] [--selector ...] [--text ...]\`
- \`herdr-pocket browser net list [--filter <url>] [--type XHR,Fetch]\`
- \`herdr-pocket browser net body <requestId>\`
- \`herdr-pocket browser net wait <url-pattern> [--timeout <ms>]\`
- \`herdr-pocket browser net clear\`
- \`herdr-pocket browser eval <js-expression>\`
- \`herdr-pocket browser fetch <url> [--method POST] [--body ...]\`
- \`herdr-pocket browser cdp <Method> [jsonParams]\`
- \`herdr-pocket browser screenshot [absPath] [--full-page]\`
- \`herdr-pocket browser tabs list|open|switch|close [page|url]\`
- \`herdr-pocket browser handoff|takeover|resume|popout|finish\`
`;
