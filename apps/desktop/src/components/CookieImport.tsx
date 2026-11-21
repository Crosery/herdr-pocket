import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Cookie, Search, ShieldCheck } from "lucide-react";
import { PocketButton, PocketCheckbox, PocketInput, PocketModal, useToast } from "./PocketUI";
import { native, type CookieImportResult, type CookieSource } from "../lib/native";
import { useClientConfig } from "../lib/config";
import { logger } from "../lib/log";

/** One sentence per import warning, each saying what to do next. */
export function describeImport(r: CookieImportResult, from: string): { summary: string; notes: string[] } {
  const summary = `已从 ${from} 导入 ${r.imported} 个 Cookie（${r.domains.length} 个站点）${r.skipped ? `，跳过 ${r.skipped} 个` : ""}。`;
  const notes = r.warnings.map((w) => {
    switch (w.code) {
      case "app_bound":
        return `${w.count} 个用了 Chrome 127 起的“应用绑定加密”，别的程序读不出来，我们也不会去绕过它：这些网站请在内置浏览器里直接登录。`;
      case "session":
        return `${w.count} 个是关掉浏览器就失效的会话 Cookie，没有导入；需要的话勾选“也导入会话 Cookie”再导一次。`;
      case "expired":
        return `${w.count} 个已经过期，跳过了。`;
      default:
        return `${w.count} 个读不出来，跳过了；这些网站请在内置浏览器里直接登录。`;
    }
  });
  if (r.note) notes.push(r.note);
  return { summary, notes };
}

const bare = (d: string) => d.replace(/^\./, "").toLowerCase();

/** Whether a cookie domain belongs to the site at `host` (same site or a parent domain of it). */
function matchesHost(domain: string, host: string): boolean {
  const d = bare(domain);
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`);
}

type Domain = { domain: string; count: number };

export function CookieImportDialog({ open, onOpenChange, currentHost }: { open: boolean; onOpenChange: (v: boolean) => void; currentHost?: string }) {
  const toast = useToast();
  const supported = native.cookieImportSupported();
  const [sources, setSources] = useState<CookieSource[] | null>(null);
  const [source, setSource] = useState<CookieSource | null>(null);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [includeSession, setIncludeSession] = useState(true);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ summary: string; notes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storeKind, setStoreKind] = useState<"persistent" | "session" | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource(null);
    setDomains(null);
    setResult(null);
    setError(null);
    setConfirmAll(false);
    if (!supported) return;
    void native.listCookieSources().then(setSources, () => setSources([]));
    void native.browserStoreKind().then(setStoreKind, () => setStoreKind(null));
  }, [open, supported]);

  const choose = (s: CookieSource) => {
    setSource(s);
    setDomains(null);
    setResult(null);
    setError(null);
    setFilter("");
    setConfirmAll(false);
    // Host names only: nothing is decrypted yet, so no Keychain prompt here.
    void native.listCookieDomains(s.id).then(
      (list) => {
        setDomains(list);
        setPicked(new Set(currentHost ? list.filter((d) => matchesHost(d.domain, currentHost)).map((d) => d.domain) : []));
      },
      (e: Error) => {
        setDomains([]);
        setError(`${e.message}。`);
      },
    );
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (domains ?? []).filter((d) => !q || d.domain.toLowerCase().includes(q));
  }, [domains, filter]);

  const toggle = (domain: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });

  const run = async (all: boolean) => {
    if (!source) return;
    const list = all ? (domains ?? []).map((d) => d.domain) : [...picked];
    if (!list.length) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await native.importCookies({ sourceId: source.id, domains: list.map(bare), includeSession });
      const d = describeImport(r, source.label);
      setResult(d);
      toast(d.summary);
      logger.info("cookie", `imported ${r.imported}, skipped ${r.skipped}, sites ${r.domains.length} from ${source.browser}`);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      logger.warn("cookie", `import from ${source.browser} failed: ${msg}`);
    } finally {
      setBusy(false);
      setConfirmAll(false);
    }
  };

  const quickImportHost = async (s: CookieSource) => {
    if (!currentHost) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await native.importCookies({ sourceId: s.id, domains: [bare(currentHost)], includeSession: true });
      const d = describeImport(r, s.label);
      setResult(d);
      toast(d.summary);
      logger.info("cookie", `quick imported ${r.imported}, skipped ${r.skipped} for ${currentHost} from ${s.browser}`);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      logger.warn("cookie", `quick import from ${s.browser} failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const total = domains?.length ?? 0;

  return (
    <PocketModal open={open} onOpenChange={onOpenChange} title="导入浏览器数据" subtitle="把其他浏览器里某些网站的登录带进内置浏览器" width={540}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="inline-alert soft">
          <ShieldCheck size={16} />
          <span>只读这台电脑上的浏览器，Cookie 只存在本机，不会上传。macOS 在导入时会弹一次钥匙串授权，点“允许”即可。</span>
        </div>
        {storeKind === "session" ? (
          <div className="inline-alert">这台 Mac 的系统版本较旧：导入的 Cookie 只保留到关闭内置浏览器为止。</div>
        ) : null}

        {!supported ? (
          <div className="muted">导入 Cookie 需要 Herdr Pocket 桌面版。</div>
        ) : !source ? (
          sources === null ? (
            <div className="muted">正在查找这台电脑上的浏览器…</div>
          ) : sources.length === 0 ? (
            <div className="muted">没找到可以导入的浏览器（支持 Chrome、Edge、Brave、Arc、Chromium、Vivaldi）。直接在内置浏览器里登录也可以。</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {currentHost ? (
                <div className="inline-alert soft" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <span>当前打开 <strong>{currentHost}</strong>，可直接一键带入登录态：</span>
                  {sources.find((s) => s.importable) ? (
                    <PocketButton
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void quickImportHost(sources.find((s) => s.importable)!)}
                    >
                      {busy ? "导入中…" : `从 ${sources.find((s) => s.importable)!.label} 一键导入`}
                    </PocketButton>
                  ) : null}
                </div>
              ) : null}
              <div className="faint">第 1 步：选一个浏览器</div>
              {sources.map((s) => (
                <div key={s.id} className="choice-card">
                  <Cookie size={16} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate" style={{ fontWeight: 700 }}>
                      {s.label}
                    </div>
                    {s.note ? <div className="faint">{s.note}</div> : null}
                  </div>
                  {s.importable ? (
                    <PocketButton size="sm" variant="soft" onClick={() => choose(s)}>
                      选网站
                    </PocketButton>
                  ) : s.settings === "fullDiskAccess" ? (
                    <PocketButton size="sm" variant="ghost" onClick={() => void native.openPermissionSettings("fullDiskAccess")}>
                      打开权限设置
                    </PocketButton>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <button className="back-link" onClick={() => setSource(null)}>
              <ChevronLeft size={16} />
              <span>换个浏览器（现在：{source.label}）</span>
            </button>
            <div className="faint">第 2 步：选要带过来的网站{currentHost ? `，已帮你选好正在打开的 ${currentHost}` : ""}</div>
            {domains === null ? (
              <div className="muted">正在读取网站列表…</div>
            ) : total === 0 ? (
              <div className="muted">这个浏览器配置里没有 Cookie。</div>
            ) : (
              <>
                <div className="cookie-filter">
                  <Search size={14} />
                  <PocketInput placeholder={`在 ${total} 个网站里筛选`} value={filter} onChange={(e) => setFilter(e.target.value)} />
                </div>
                <div className="cookie-domains" role="group" aria-label="网站">
                  {shown.slice(0, 200).map((d) => {
                    const checked = picked.has(d.domain);
                    return (
                      <div
                        key={d.domain}
                        role="button"
                        tabIndex={0}
                        className="cookie-domain"
                        onClick={() => toggle(d.domain)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggle(d.domain);
                          }
                        }}
                      >
                        <PocketCheckbox checked={checked} onCheckedChange={() => toggle(d.domain)} ariaLabel={`选择 ${bare(d.domain)}`} />
                        <span className="grow truncate mono">{bare(d.domain)}</span>
                        <span className="faint num">{d.count}</span>
                      </div>
                    );
                  })}
                  {shown.length > 200 ? <div className="faint">还有 {shown.length - 200} 个，输入网址筛选。</div> : null}
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  className="cookie-domain plain"
                  onClick={() => setIncludeSession((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setIncludeSession((v) => !v);
                    }
                  }}
                >
                  <PocketCheckbox checked={includeSession} onCheckedChange={setIncludeSession} ariaLabel="也导入会话 Cookie" />
                  <span>也导入会话 Cookie（关掉浏览器就失效的那种）</span>
                </div>
                {confirmAll ? (
                  <div className="inline-alert">
                    <span className="grow">要把 {total} 个网站的登录全部带进内置浏览器吗？以后可以在“性能与资源”里清除。</span>
                    <PocketButton size="sm" variant="primary" disabled={busy} onClick={() => void run(true)}>
                      {busy ? "导入中…" : "全部导入"}
                    </PocketButton>
                    <PocketButton size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
                      取消
                    </PocketButton>
                  </div>
                ) : (
                  <div className="row wrap" style={{ gap: 8, justifyContent: "flex-end" }}>
                    <PocketButton size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmAll(true)}>
                      全部网站…
                    </PocketButton>
                    <PocketButton size="sm" variant="primary" disabled={busy || picked.size === 0} onClick={() => void run(false)}>
                      {busy ? "导入中…" : picked.size ? `导入 ${picked.size} 个网站` : "先勾选网站"}
                    </PocketButton>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {result ? (
          <div className="choice-card primary column">
            <div style={{ fontWeight: 800 }}>{result.summary}</div>
            {result.notes.map((n) => (
              <div key={n} className="faint">
                {n}
              </div>
            ))}
          </div>
        ) : null}
        {error ? <div className="inline-alert">{error}</div> : null}
      </div>
    </PocketModal>
  );
}

export function CookieImportButton({
  size = "sm",
  compact = false,
  currentHost,
}: {
  size?: "sm" | "md";
  compact?: boolean;
  currentHost?: string;
}) {
  const [open, setOpen] = useState(false);
  const mode = useClientConfig().browser.cookieImport;
  if (mode === "off") return null;
  return (
    <>
      <PocketButton
        size={size}
        variant="soft"
        aria-label={compact ? "导入其他浏览器 Cookie" : undefined}
        title={compact ? "导入其他浏览器 Cookie" : undefined}
        onClick={() => setOpen(true)}
      >
        <Cookie size={14} />
        {compact ? null : <span>导入浏览器数据…</span>}
      </PocketButton>
      <CookieImportDialog open={open} onOpenChange={setOpen} currentHost={currentHost} />
    </>
  );
}
