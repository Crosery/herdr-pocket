import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import type { Agent, FileEntry, RpcResult } from "@herdr-pocket/protocol";
import { EmptyState, PocketButton, PocketInput, PocketSelect, overlayStore, useToast } from "../components/PocketUI";
import { CookieImportButton } from "../components/CookieImport";
import { RichMarkdown } from "../lib/markdown";
import { copyToClipboard, openExternalUrl } from "../lib/bridge";
import { native } from "../lib/native";
import { useClientConfig } from "../lib/config";
import { rpcCall, RelayError } from "../lib/relay";
import { allAgents, createStore, liveStore, spacedTitle } from "../lib/store";
import { useWindowHidden } from "../lib/layout";
import { logger } from "../lib/log";

type FileTab = { id: string; kind: "file"; agent: string; path: string; title: string; pinned?: boolean };
type WebTab = { id: string; kind: "web"; url: string; title: string; pinned?: boolean };
type WbTab = FileTab | WebTab;

interface WorkbenchState {
  tabs: WbTab[];
  active: string | null;
  agent: string | null;
  treeOpen: boolean;
}

/** Lives for the app's lifetime so tabs survive switching pages. */
const wb = createStore<WorkbenchState>({ tabs: [], active: null, agent: null, treeOpen: true });
let tabSeq = 0;

const SEARCH: Record<string, string> = {
  bing: "https://www.bing.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
};

export function toUrl(input: string, engine: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  // Only web pages load directly; javascript:, file:, data: and other schemes become a search.
  if (/^https?:\/\//i.test(t) || t === "about:blank") return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t)) return `https://${t}`;
  return `${SEARCH[engine] ?? SEARCH.bing}${encodeURIComponent(t)}`;
}

function fileError(e: unknown): string {
  const err = e as RelayError;
  if (err?.code === "unsupported") return "这台电脑的 herdr-pocket 版本太旧，还不能看文件：在那台电脑上运行 herdr-pocket update。";
  if (err?.code === "forbidden") return "这个文件可能含有密钥（如 .env、私钥），为了安全不能查看。";
  if (err?.code === "not_found") return "找不到了：可能已被删除或改名，刷新文件树再试。";
  if (err?.code === "bad_request") return err.message || "这个路径不能这样打开。";
  if (err?.code === "offline" || err?.code === "timeout") return `${err.message}：那台电脑可能离线了。`;
  return (e as Error)?.message || "读取失败";
}

function openTab(tab: WbTab): void {
  wb.set((s) => {
    const same = s.tabs.find((t) => (t.kind === "file" && tab.kind === "file" ? t.agent === tab.agent && t.path === tab.path : false));
    if (same) return { ...s, active: same.id };
    return { ...s, tabs: [...s.tabs, tab], active: tab.id };
  });
}

function closeTabs(ids: string[]): void {
  for (const id of ids) {
    const t = wb.get().tabs.find((x) => x.id === id);
    if (t?.kind === "web") void native.browserClose(t.id);
  }
  wb.set((s) => {
    const tabs = s.tabs.filter((t) => !ids.includes(t.id));
    const active = s.active && ids.includes(s.active) ? (tabs[tabs.length - 1]?.id ?? null) : s.active;
    return { ...s, tabs, active };
  });
}

export function newWebTab(url: string): void {
  openTab({ id: `web-${++tabSeq}`, kind: "web", url, title: url === "about:blank" ? "新标签页" : url });
}

// File tree ---------------------------------------------------------------------

type Listing = RpcResult<"files.list">;

export function FileTree({ agent, onOpen }: { agent: Agent; onOpen: (path: string, name: string) => void }) {
  const toast = useToast();
  const files = useClientConfig().files;
  const [lists, setLists] = useState<Record<string, Listing | { error: string } | "loading">>({});
  const [open, setOpen] = useState<Set<string>>(new Set([""]));

  const load = useCallback(
    async (path: string) => {
      setLists((p) => ({ ...p, [path]: "loading" }));
      try {
        const res = await rpcCall(agent.deviceId, "files.list", { agent: agent.key, path, hidden: files.showHidden, all: files.showIgnored });
        setLists((p) => ({ ...p, [path]: res }));
      } catch (e) {
        setLists((p) => ({ ...p, [path]: { error: fileError(e) } }));
        logger.warn("files", `files.list ${path || "/"} on ${agent.deviceId}: ${(e as Error).message}`);
      }
    },
    [agent.deviceId, agent.key, files.showHidden, files.showIgnored],
  );

  useEffect(() => {
    setLists({});
    setOpen(new Set([""]));
    void load("");
  }, [load]);

  const render = (path: string, depth: number): React.ReactNode => {
    const l = lists[path];
    if (!l || l === "loading") return <div className="tree-note" style={{ paddingLeft: 10 + depth * 14 }}>读取中…</div>;
    if ("error" in l) {
      return (
        <div className="tree-note err" style={{ paddingLeft: 10 + depth * 14 }}>
          {l.error}
          <button className="link-btn" onClick={() => void load(path)}>重试</button>
        </div>
      );
    }
    return (
      <>
        {l.entries.map((e: FileEntry) => {
          const isDir = e.kind === "dir";
          const expanded = open.has(e.path);
          return (
            <div key={e.path}>
              <button
                className={`tree-row${e.private ? " locked" : ""}${e.ignored ? " dim" : ""}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={e.private ? "可能含有密钥，不能查看" : e.path}
                onClick={() => {
                  if (e.private) return toast("这个文件可能含有密钥（如 .env、私钥），为了安全不能查看", true);
                  if (e.kind === "link") return toast("这是指向文件夹外的链接，不会跟过去", true);
                  if (isDir) {
                    setOpen((p) => {
                      const n = new Set(p);
                      if (n.has(e.path)) n.delete(e.path);
                      else {
                        n.add(e.path);
                        if (!lists[e.path]) void load(e.path);
                      }
                      return n;
                    });
                  } else onOpen(e.path, e.name);
                }}
              >
                {isDir ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span style={{ width: 13 }} />}
                {e.private ? <Lock size={14} /> : isDir ? expanded ? <FolderOpen size={14} /> : <Folder size={14} /> : /\.(md|txt)$/i.test(e.name) ? <FileText size={14} /> : <File size={14} />}
                <span className="truncate">{e.name}</span>
              </button>
              {isDir && expanded ? render(e.path, depth + 1) : null}
            </div>
          );
        })}
        {l.truncated ? <div className="tree-note" style={{ paddingLeft: 10 + depth * 14 }}>文件太多，只列出了前 {l.entries.length} 个</div> : null}
        {!l.entries.length ? <div className="tree-note" style={{ paddingLeft: 10 + depth * 14 }}>空文件夹</div> : null}
      </>
    );
  };

  const root = lists[""];
  return (
    <div className="tree">
      {root && root !== "loading" && !("error" in root) ? <div className="tree-root mono truncate" title={root.root}>{root.root}</div> : null}
      {render("", 0)}
    </div>
  );
}

// File viewer -------------------------------------------------------------------

type ReadResult = RpcResult<"files.read">;

export function FileViewer({ tab, agent }: { tab: { path: string; title: string }; agent: Agent | undefined }) {
  const toast = useToast();
  const [data, setData] = useState<ReadResult | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [preview, setPreview] = useState(/\.md$/i.test(tab.path));

  const read = useCallback(
    async (offset: number) => {
      if (!agent) return;
      const res = await rpcCall(agent.deviceId, "files.read", { agent: agent.key, path: tab.path, offset });
      setData(res);
      setText((prev) => (offset ? prev + (res.text ?? "") : (res.text ?? "")));
      return res;
    },
    [agent, tab.path],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    setText("");
    if (!agent) {
      setError("这个文件所在的 Agent 已经不在了。");
      return;
    }
    read(0).catch((e) => setError(fileError(e)));
  }, [agent, read]);

  const lines = useMemo(() => {
    const n = text ? text.split("\n").length : 0;
    return Array.from({ length: n }, (_, i) => i + 1).join("\n");
  }, [text]);

  return (
    <div className="viewer">
      <div className="viewer-head">
        <span className="mono truncate grow" title={tab.path}>{tab.path}</span>
        {data ? <span className="faint num">{data.size >= 1024 ? `${Math.round(data.size / 1024)} KB` : `${data.size} B`}</span> : null}
        {/\.md$/i.test(tab.path) && data?.text !== undefined ? (
          <div className="segmented">
            <button className={preview ? "active" : ""} onClick={() => setPreview(true)}>预览</button>
            <button className={!preview ? "active" : ""} onClick={() => setPreview(false)}>源码</button>
          </div>
        ) : null}
        <button
          className="side-icon-btn"
          aria-label="复制路径"
          title="复制路径"
          onClick={async () => {
            const ok = await copyToClipboard(tab.path);
            toast(ok ? "路径已复制" : "复制失败", !ok);
          }}
        >
          <Copy size={14} />
        </button>
      </div>
      <div className="viewer-body">
        {error ? (
          <div className="inline-alert" style={{ margin: 16 }}>{error}</div>
        ) : !data ? (
          <div className="faint" style={{ padding: 16 }}>读取中…</div>
        ) : data.base64 && data.mime ? (
          <div className="viewer-image">
            <img src={`data:${data.mime};base64,${data.base64}`} alt={tab.title} />
          </div>
        ) : data.binary && data.mime?.startsWith("image/") && data.truncated ? (
          <div className="faint" style={{ padding: 16 }}>这张图片超过 1 MB，太大了不在这里显示，请在那台电脑上直接打开。</div>
        ) : data.binary ? (
          <div className="faint" style={{ padding: 16 }}>这是二进制文件，没法按文字显示。</div>
        ) : preview ? (
          <div className="viewer-md">
            <RichMarkdown text={text} />
          </div>
        ) : (
          <div className="code-view">
            <pre className="code-gutter" aria-hidden>{lines}</pre>
            <pre className="code-text">{text}</pre>
          </div>
        )}
        {data?.truncated && !data.binary ? (
          <div className="viewer-more">
            <span className="faint">只显示了前 {Math.round((data.offset + data.bytes) / 1024)} KB</span>
            <PocketButton
              size="sm"
              variant="soft"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                try {
                  await read(data.offset + data.bytes);
                } catch (e) {
                  toast(fileError(e), true);
                } finally {
                  setLoadingMore(false);
                }
              }}
            >
              {loadingMore ? "加载中…" : "继续加载"}
            </PocketButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Web pane ----------------------------------------------------------------------

/** The page's host name, for preselecting it in the cookie import ("" for blank pages). */
function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : undefined;
  } catch {
    return undefined;
  }
}

export function WebPane({
  tab,
  active,
  onChange,
}: {
  tab: Pick<WebTab, "id" | "url">;
  active: boolean;
  /** Where URL and title changes go (the shell's tabs); the workbench's own tabs by default. */
  onChange?: (patch: { url?: string; title?: string }) => void;
}) {
  const update = (patch: { url?: string; title?: string }) =>
    onChange ? onChange(patch) : wb.set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === tab.id && t.kind === "web" ? { ...t, ...patch } : t)) }));
  const engine = useClientConfig().browser.searchEngine;
  const hidden = useWindowHidden();
  const overlays = overlayStore.use((s) => s.open);
  const hostRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const [address, setAddress] = useState(tab.url === "about:blank" ? "" : tab.url);
  const [loading, setLoading] = useState(false);
  const supported = native.browserSupported();

  useEffect(
    () =>
      native.onBrowserEvent((e) => {
        if (e.id !== tab.id) return;
        if (e.kind === "url" && e.url) {
          setAddress(e.url);
          update({ url: e.url });
        }
        if (e.kind === "title" && e.title) update({ title: e.title });
        if (e.kind === "loading") setLoading(true);
        if (e.kind === "loaded" || e.kind === "error") setLoading(false);
      }),
    [tab.id],
  );

  // The native webview follows its placeholder; it hides behind dialogs and other tabs.
  useLayoutEffect(() => {
    if (!supported) return;
    const el = hostRef.current;
    if (!el) return;
    const rect = () => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    if (!opened.current) {
      opened.current = true;
      void native.browserOpen(tab.id, tab.url, rect()).catch((e: Error) => logger.warn("browser", e.message));
    }
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void native.browserSetBounds(tab.id, rect()));
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
      cancelAnimationFrame(frame);
    };
  }, [supported, tab.id, tab.url]);

  useEffect(() => {
    if (!supported) return;
    void native.browserSetVisible(tab.id, active && !hidden && overlays === 0);
  }, [supported, tab.id, active, hidden, overlays]);

  useEffect(() => () => void native.browserSetVisible(tab.id, false), [tab.id]);

  const go = (input: string) => {
    const url = toUrl(input, engine);
    setAddress(url);
    update({ url, title: url });
    if (supported) void native.browserNavigate(tab.id, { url });
  };

  return (
    <div className="web-pane" style={{ display: active ? undefined : "none" }}>
      <form
        className="web-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          go(address);
        }}
      >
        <button type="button" className="side-icon-btn" aria-label="后退" disabled={!supported} onClick={() => void native.browserNavigate(tab.id, { back: true })}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="side-icon-btn" aria-label="前进" disabled={!supported} onClick={() => void native.browserNavigate(tab.id, { forward: true })}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="side-icon-btn" aria-label={loading ? "停止" : "刷新"} disabled={!supported} onClick={() => void native.browserNavigate(tab.id, loading ? { stop: true } : { reload: true })}>
          {loading ? <X size={15} /> : <RotateCw size={15} />}
        </button>
        <div className="grow">
          <PocketInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="输入网址，或搜索" spellCheck={false} />
        </div>
        <button type="button" className="side-icon-btn" aria-label="在系统浏览器打开" title="在系统浏览器打开" onClick={() => void openExternalUrl(toUrl(address || tab.url, engine))}>
          <ExternalLink size={15} />
        </button>
        <CookieImportButton currentHost={hostOf(tab.url)} />
      </form>
      <div ref={hostRef} className="web-host">
        {!supported ? (
          <EmptyState
            mood="sleepy"
            title="内置浏览器在这里还用不了"
            body="这个版本或平台还不支持内置浏览器。可以先在系统浏览器里打开。"
            action={
              <PocketButton size="sm" variant="soft" onClick={() => void openExternalUrl(toUrl(address || tab.url, engine))}>
                <ExternalLink size={13} />
                <span>在系统浏览器打开</span>
              </PocketButton>
            }
          />
        ) : null}
      </div>
    </div>
  );
}

// Tab strip ---------------------------------------------------------------------

function TabMenu({ x, y, tab, onClose }: { x: number; y: number; tab: WbTab; onClose: () => void }) {
  const toast = useToast();
  const tabs = wb.use((s) => s.tabs);
  useEffect(() => {
    const off = () => onClose();
    window.addEventListener("pointerdown", off);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("pointerdown", off);
      window.removeEventListener("blur", off);
    };
  }, [onClose]);
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      className="menu-item"
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        fn();
        onClose();
      }}
    >
      {label}
    </button>
  );
  const others = tabs.filter((t) => t.id !== tab.id && !t.pinned).map((t) => t.id);
  return (
    <div className="ctx-menu" style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 220) }} role="menu">
      {item("关闭", () => closeTabs([tab.id]))}
      {item("关闭其他", () => closeTabs(others), !others.length)}
      {item("关闭全部", () => closeTabs(tabs.filter((t) => !t.pinned).map((t) => t.id)))}
      <div className="menu-sep" />
      {tab.kind === "file"
        ? item("复制路径", () => void copyToClipboard(tab.path).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok)))
        : item("复制网址", () => void copyToClipboard(tab.url).then((ok) => toast(ok ? "网址已复制" : "复制失败", !ok)))}
      {item(tab.pinned ? "取消固定" : "固定", () => wb.set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, pinned: !t.pinned } : t)) })))}
    </div>
  );
}

// View ----------------------------------------------------------------------------

export function WorkbenchView({ agentKey, mobileLayout }: { agentKey: string | null; mobileLayout: boolean }) {
  const state = wb.use((s) => s);
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const homePage = useClientConfig().browser.homePage;
  const [menu, setMenu] = useState<{ x: number; y: number; tab: WbTab } | null>(null);

  const agents = useMemo(() => allAgents(agentsMap).filter((a) => !a.isShell && a.cwd), [agentsMap]);

  useEffect(() => {
    if (agentKey) wb.set((s) => ({ ...s, agent: agentKey, treeOpen: true }));
  }, [agentKey]);

  const agent = agents.find((a) => a.key === state.agent) ?? agents[0];
  const sorted = useMemo(() => [...state.tabs.filter((t) => t.pinned), ...state.tabs.filter((t) => !t.pinned)], [state.tabs]);
  const active = sorted.find((t) => t.id === state.active) ?? null;

  const openFile = (path: string, name: string) => {
    if (!agent) return;
    openTab({ id: `file-${++tabSeq}`, kind: "file", agent: agent.key, path, title: name });
  };

  const onTabMenu = (e: ReactMouseEvent, tab: WbTab) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, tab });
  };

  const findAgent = (key: string) => allAgents(agentsMap).find((a) => a.key === key);
  const showTree = state.treeOpen && (!mobileLayout || !active);

  return (
    <div className={`wb-shell${showTree && !mobileLayout ? " with-tree" : ""}${mobileLayout ? " mobile" : ""}`}>
      {showTree ? (
        <aside className="wb-tree" aria-label="文件">
          <div className="wb-tree-head">
            {agents.length ? (
              <PocketSelect
                value={agent?.key ?? ""}
                onValueChange={(v) => wb.set((s) => ({ ...s, agent: v }))}
                options={agents.map((a) => ({ value: a.key, label: `${devices[a.deviceId]?.name ?? a.deviceId} · ${spacedTitle(a)}` }))}
              />
            ) : null}
            {!mobileLayout ? (
              <button className="side-icon-btn" aria-label="收起文件树" title="收起文件树" onClick={() => wb.set((s) => ({ ...s, treeOpen: false }))}>
                <PanelLeftClose size={15} />
              </button>
            ) : null}
          </div>
          {agent ? (
            <FileTree key={agent.key} agent={agent} onOpen={openFile} />
          ) : (
            <div className="tree-note">还没有带工作目录的 Agent。连上电脑、开一个 Agent 后，这里会列出它的文件。</div>
          )}
        </aside>
      ) : null}

      <section className="wb-main" style={mobileLayout && showTree ? { display: "none" } : undefined}>
        <div className="wb-tabs" role="tablist" aria-label="工作台标签">
          {!state.treeOpen && !mobileLayout ? (
            <button className="side-icon-btn" aria-label="展开文件树" title="展开文件树" onClick={() => wb.set((s) => ({ ...s, treeOpen: true }))}>
              <PanelLeftOpen size={15} />
            </button>
          ) : null}
          {mobileLayout && active ? (
            <button className="side-icon-btn" aria-label="返回文件" onClick={() => wb.set((s) => ({ ...s, active: null, treeOpen: true }))}>
              <ArrowLeft size={15} />
            </button>
          ) : null}
          <div className="wb-tab-list">
            {sorted.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === state.active}
                className={`wb-tab${t.id === state.active ? " active" : ""}${t.pinned ? " pinned" : ""}`}
                onClick={() => wb.set((s) => ({ ...s, active: t.id }))}
                onAuxClick={(e) => e.button === 1 && !t.pinned && closeTabs([t.id])}
                onContextMenu={(e) => onTabMenu(e, t)}
                title={t.kind === "file" ? t.path : t.url}
              >
                {t.kind === "web" ? <Globe size={13} /> : <File size={13} />}
                <span className="truncate">{t.title}</span>
                {t.pinned ? (
                  <Pin size={11} />
                ) : (
                  <button
                    className="wb-tab-x"
                    aria-label={`关闭 ${t.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTabs([t.id]);
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button className="side-icon-btn" aria-label="新建网页标签" title="新建网页标签" onClick={() => newWebTab(homePage || "about:blank")}>
            <Plus size={15} />
          </button>
        </div>

        <div className="wb-content">
          {!active ? (
            <EmptyState
              mood="hello"
              title="工作台"
              body={agent ? "在左边点一个文件查看，或点右上角的 + 打开网页。右键标签可以关闭其他、固定或复制路径。" : "点右上角的 + 打开网页。连上电脑后，这里还能看 Agent 的文件。"}
              action={
                <PocketButton size="sm" variant="soft" onClick={() => newWebTab(homePage || "about:blank")}>
                  <Globe size={13} />
                  <span>打开网页</span>
                </PocketButton>
              }
            />
          ) : null}
          {active?.kind === "file" ? <FileViewer key={active.id} tab={active} agent={findAgent(active.agent)} /> : null}
          {/* Web panes stay mounted so their native views keep their pages. */}
          {state.tabs.filter((t): t is WebTab => t.kind === "web").map((t) => (
            <WebPane key={t.id} tab={t} active={t.id === state.active} />
          ))}
        </div>
      </section>
      {menu ? <TabMenu {...menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
