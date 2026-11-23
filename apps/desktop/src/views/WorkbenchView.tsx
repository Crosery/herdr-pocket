import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Columns2,
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
  Rows2,
  X,
} from "lucide-react";
import type { Agent, FileEntry, RpcResult } from "@herdr-pocket/protocol";
import { EmptyState, PocketButton, PocketInput, PocketSelect, overlayStore, useToast } from "../components/PocketUI";
import { PocketAudioPlayer, PocketVideoPlayer } from "../components/PocketMediaPlayer";
import {
  PocketDataGrid,
  PocketDocViewer,
  PocketImageViewer,
  PocketPdfViewer,
  PocketPptxViewer,
} from "../components/FilePreviewRenderers";
import { CookieImportButton } from "../components/CookieImport";
import { RichMarkdown } from "../lib/markdown";
import { copyToClipboard, detectPlatform, openExternalUrl } from "../lib/bridge";
import {
  decodeBase64Fast,
  estimatePdfPages,
  parseDelimitedTable,
  parseDocxBuffer,
  parseJsonTable,
  parseLegacyDocFallback,
  parseLegacyXlsBuffer,
  parseOdsBuffer,
  parseOdtBuffer,
  parsePptxBuffer,
  parseRtfText,
  parseXlsxBuffer,
  type DocPreviewData,
  type SlidePreviewData,
  type TablePreviewData,
} from "../lib/filePreview";
import { ensureLocalHostDeviceId, localHostIdStore, useLocalHostDeviceId } from "../lib/fonts";
import {
  canActOnLocalFile,
  openLocalFileDefault,
  resolveLocalActionTarget,
  revealInFolderLabel,
  revealInFolderShortLabel,
  revealLocalFile,
} from "../lib/localFileActions";
import { native } from "../lib/native";
import { useClientConfig } from "../lib/config";
import { openAgentFileTarget } from "../lib/openFileTarget";
import { rpcCall, RelayError } from "../lib/relay";
import { allAgents, createStore, liveStore, spacedTitle } from "../lib/store";
import { updateResolvedFilePanePath } from "../shell/shellStore";
import { useWindowHidden } from "../lib/layout";
import { endWorkspaceDrag, startWorkspaceDrag } from "../lib/fileDrag";
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

function parseLocalFileAddress(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^file:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      const p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:\//.test(p)) return p.slice(1);
      return p;
    } catch {
      return null;
    }
  }
  if (t.startsWith("/") || t.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(t)) {
    return t;
  }
  return null;
}

function toFileUrl(filePath: string): string {
  const norm = filePath.replace(/\\/g, "/");
  return `file://${norm.startsWith("/") ? "" : "/"}${encodeURI(norm)}`;
}

function fileError(e: unknown): string {
  const err = e as RelayError;
  if (err?.code === "unsupported") return "这台电脑的 herdr-pocket 版本太旧，还不能看文件：在那台电脑上运行 herdr-pocket update。";
  if (err?.code === "forbidden") return err.message || "这个文件可能含有密钥（如 .env、私钥），为了安全不能查看。";
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

export function FileTree({
  agent,
  onOpen,
  onOpenSplit,
}: {
  agent: Agent;
  onOpen: (path: string, name: string) => void;
  onOpenSplit?: (path: string, name: string, direction: "right" | "down", absPath?: string) => void;
}) {
  const toast = useToast();
  const files = useClientConfig().files;
  const [lists, setLists] = useState<Record<string, Listing | { error: string } | "loading">>({});
  const [open, setOpen] = useState<Set<string>>(new Set([""]));
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; name: string; absPath?: string } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [ctxMenu]);

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

  const root = lists[""];
  const rootPath = root && root !== "loading" && !("error" in root) ? root.root : agent.cwd;

  const toggleRow = (e: FileEntry) => {
    if (e.private) return toast("这个文件可能含有密钥（如 .env、私钥），为了安全不能查看", true);
    if (e.kind === "link") return toast("这是指向文件夹外的链接，不会跟过去", true);
    if (e.kind === "dir") {
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
  };

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
          const draggable = !e.private && e.kind !== "link";
          const absPath = rootPath ? `${rootPath.replace(/[\\/]+$/, "")}/${e.path}` : undefined;
          return (
            <div key={e.path}>
              <div
                role="button"
                tabIndex={0}
                draggable={draggable}
                className={`tree-row${e.private ? " locked" : ""}${e.ignored ? " dim" : ""}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={e.private ? "可能含有密钥，不能查看" : e.path}
                onClick={(ev) => {
                  if (!isDir && !e.private && e.kind !== "link" && ev.altKey && onOpenSplit) {
                    ev.preventDefault();
                    onOpenSplit(e.path, e.name, ev.shiftKey ? "down" : "right", absPath);
                    return;
                  }
                  toggleRow(e);
                }}
                onContextMenu={(ev) => {
                  if (isDir || e.private || e.kind === "link" || !onOpenSplit) return;
                  ev.preventDefault();
                  setCtxMenu({ x: ev.clientX, y: ev.clientY, path: e.path, name: e.name, absPath });
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    toggleRow(e);
                  }
                }}
                onDragStart={(ev) => {
                  if (!draggable) return ev.preventDefault();
                  startWorkspaceDrag(ev, {
                    agentKey: agent.key,
                    hostId: agent.deviceId,
                    relPath: e.path,
                    absPath,
                    name: e.name,
                    kind: isDir ? "dir" : "file",
                  });
                }}
                onDragEnd={() => endWorkspaceDrag()}
              >
                {isDir ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span style={{ width: 13, flexShrink: 0 }} />}
                {e.private ? <Lock size={14} /> : isDir ? expanded ? <FolderOpen size={14} /> : <Folder size={14} /> : /\.(md|txt)$/i.test(e.name) ? <FileText size={14} /> : <File size={14} />}
                <span className="truncate">{e.name}</span>
                {e.gitStatus ? (
                  isDir ? (
                    <span className={`git-tree-dot st-${e.gitStatus === "?" ? "Q" : e.gitStatus}`} aria-label={`包含更改 (${e.gitStatus})`} />
                  ) : (
                    <span className={`git-tree-badge st-${e.gitStatus === "?" ? "Q" : e.gitStatus}`}>{e.gitStatus}</span>
                  )
                ) : null}
              </div>
              {isDir && expanded ? render(e.path, depth + 1) : null}
            </div>
          );
        })}
        {l.truncated ? <div className="tree-note" style={{ paddingLeft: 10 + depth * 14 }}>文件太多，只列出了前 {l.entries.length} 个</div> : null}
        {!l.entries.length ? <div className="tree-note" style={{ paddingLeft: 10 + depth * 14 }}>空文件夹</div> : null}
      </>
    );
  };

  const refreshAll = useCallback(() => {
    void load("");
    for (const p of open) {
      if (p) void load(p);
    }
  }, [load, open]);

  return (
    <div className="tree">
      {root && root !== "loading" && !("error" in root) ? (
        <div className="tree-root-row">
          <div className="tree-root mono truncate" title={root.root}>{root.root}</div>
          <button type="button" className="tree-refresh-btn" aria-label="刷新文件与 Git 状态" title="刷新文件与 Git 状态" onClick={refreshAll}>
            <RotateCw size={12} />
          </button>
        </div>
      ) : null}
      {render("", 0)}
      {ctxMenu && onOpenSplit && typeof document !== "undefined"
        ? createPortal(
            <div
              className="ctx-menu v3-popup"
              role="menu"
              style={{
                position: "fixed",
                left: Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 200 - 8)),
                top: Math.max(8, Math.min(ctxMenu.y, window.innerHeight - 160)),
                width: 200,
              }}
              onPointerDown={(ev) => ev.stopPropagation()}
            >
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const t = ctxMenu;
                  setCtxMenu(null);
                  onOpen(t.path, t.name);
                }}
              >
                <FileText size={14} />
                <span className="grow">在标签页中打开</span>
              </button>
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const t = ctxMenu;
                  setCtxMenu(null);
                  onOpenSplit(t.path, t.name, "right", t.absPath);
                }}
              >
                <Columns2 size={14} />
                <span className="grow">向右分屏打开</span>
              </button>
              <button
                type="button"
                className="menu-item v3-menu-item"
                role="menuitem"
                onClick={() => {
                  const t = ctxMenu;
                  setCtxMenu(null);
                  onOpenSplit(t.path, t.name, "down", t.absPath);
                }}
              >
                <Rows2 size={14} />
                <span className="grow">向下分屏打开</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// File viewer -------------------------------------------------------------------

type ReadResult = RpcResult<"files.read">;

export interface FileViewerHeadState {
  size: number | null;
  binary: boolean;
  isMd: boolean;
  canPreview: boolean;
  previewLabel?: string;
  preview: boolean;
  setPreview: (v: boolean) => void;
}

export function FileViewer({
  tab,
  agent,
  embedded = false,
  onHeadState,
}: {
  tab: { path: string; title: string; absPath?: string; line?: number; endLine?: number };
  agent: Agent | undefined;
  embedded?: boolean;
  onHeadState?: (s: FileViewerHeadState) => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<ReadResult | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [fetchedBytes, setFetchedBytes] = useState<Uint8Array | null>(null);
  const [fetchedSize, setFetchedSize] = useState<number | null>(null);
  const localId = useLocalHostDeviceId();
  const isMd = /\.(md|markdown|mdx)$/i.test(tab.path);
  const isSvg = /\.svg$/i.test(tab.path);
  const isHtml = /\.html?$/i.test(tab.path);
  const isCsv = /\.(csv|tsv|psv)$/i.test(tab.path);
  const isTsv = /\.tsv$/i.test(tab.path);
  const isPsv = /\.psv$/i.test(tab.path);
  const isJsonLines = /\.(jsonl|ndjson)$/i.test(tab.path);
  const isJson = /\.json$/i.test(tab.path);
  const isImageExt = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(tab.path);
  const isPdfExt = /\.pdf$/i.test(tab.path);
  const isAudioExt = /\.(mp3|wav|ogg|flac|m4a|aac|opus|weba|aiff|aif|caf)$/i.test(tab.path);
  const isVideoExt = /\.(mp4|webm|mov|m4v|mkv|avi|ogv|mpe?g)$/i.test(tab.path);
  const isDocxExt = /\.docx$/i.test(tab.path);
  const isDocExt = /\.doc$/i.test(tab.path);
  const isRtfExt = /\.rtf$/i.test(tab.path);
  const isOdtExt = /\.odt$/i.test(tab.path);
  const isXlsxExt = /\.xlsx$/i.test(tab.path);
  const isXlsExt = /\.xls$/i.test(tab.path);
  const isOdsExt = /\.ods$/i.test(tab.path);
  const isPptxExt = /\.pptx$/i.test(tab.path);
  const isDirectStreamMedia = isImageExt || isAudioExt || isVideoExt;
  const isDirectFetchBinary =
    isPdfExt || isDocxExt || isOdtExt || isXlsxExt || isXlsExt || isOdsExt || isPptxExt;
  const isLocalOwner =
    native.available() && ((!agent && Boolean(tab.absPath)) || Boolean(agent && localId && localId === agent.deviceId));
  const platform = detectPlatform();
  const revealLabel = revealInFolderLabel(platform);
  const revealShort = revealInFolderShortLabel(platform);
  const canRevealLocal = canActOnLocalFile({
    nativeAvailable: native.available(),
    agentDeviceId: agent?.deviceId,
    agentCwd: agent?.cwd,
    localHostId: localId,
    path: tab.path,
    absPath: tab.absPath,
  });
  const localTarget = resolveLocalActionTarget({
    path: tab.path,
    absPath: tab.absPath,
    agentCwd: agent?.cwd,
  });
  const handleRevealLocal = () => {
    void revealLocalFile({
      path: tab.path,
      absPath: tab.absPath,
      agentCwd: agent?.cwd,
    }).catch((e: Error) => toast(e.message || "打开所在目录失败", true));
  };
  const handleOpenDefaultLocal = () => {
    void openLocalFileDefault({
      path: tab.path,
      absPath: tab.absPath,
      agentCwd: agent?.cwd,
    }).catch((e: Error) => toast(e.message || "无法用系统默认应用打开", true));
  };
  const localStreamUrl = useMemo(() => {
    if (!isLocalOwner || !(isDirectStreamMedia || isDirectFetchBinary) || streamError) return null;
    const isRelWorkspace = !/^(\/|~\/|~|[A-Za-z]:[\\/])/.test(tab.path);
    const streamTarget = agent?.cwd && isRelWorkspace ? tab.path : tab.absPath || tab.path;
    return native.localFileStreamUrl(streamTarget, agent?.cwd);
  }, [agent?.cwd, isDirectFetchBinary, isDirectStreamMedia, isLocalOwner, streamError, tab.absPath, tab.path]);

  const prettyJson = useMemo(() => {
    if (!isJson || !text) return null;
    try {
      const formatted = JSON.stringify(JSON.parse(text), null, 2);
      return formatted !== text ? formatted : null;
    } catch {
      return null;
    }
  }, [isJson, text]);

  const textTableData = useMemo<TablePreviewData | null>(() => {
    if (!text) return null;
    if (isCsv) {
      const delimiter = isTsv ? "\t" : isPsv ? "|" : undefined;
      return parseDelimitedTable(text, delimiter, 100_000);
    }
    if (isJsonLines) return parseJsonTable(text, true, 50_000);
    if (isJson) return parseJsonTable(text, false, 50_000);
    return null;
  }, [isCsv, isJson, isJsonLines, isPsv, isTsv, text]);

  const rtfDocData = useMemo<DocPreviewData | null>(() => {
    if (!isRtfExt || !text) return null;
    return parseRtfText(text);
  }, [isRtfExt, text]);

  const isTextTable = Boolean(textTableData && (textTableData.sheets[0]?.rows.length ?? 0) > 0);
  const canPreviewText = Boolean(
    data?.text !== undefined &&
      (isMd || isSvg || isHtml || isTextTable || Boolean(rtfDocData) || prettyJson !== null),
  );
  const previewLabel = isTextTable ? "表格" : prettyJson !== null ? "格式化" : "预览";
  const defaultPreview = !tab.line && (isMd || isSvg || isCsv || isHtml || isJsonLines || isRtfExt);
  const [preview, setPreview] = useState(() => defaultPreview);
  const targetLineRef = useRef<HTMLDivElement | null>(null);
  const headStateCbRef = useRef(onHeadState);
  headStateCbRef.current = onHeadState;

  useEffect(() => {
    setPreview(!tab.line && (isMd || isSvg || isCsv || isHtml || isJsonLines || isRtfExt));
  }, [isCsv, isHtml, isJsonLines, isMd, isRtfExt, isSvg, tab.line, tab.path]);

  useEffect(() => {
    setStreamError(false);
    setFetchedBytes(null);
    setFetchedSize(null);
  }, [agent?.key, tab.absPath, tab.path]);

  // Decode remote or fallback base64 into Uint8Array once per read
  const rawBinaryBytes = useMemo(() => {
    if (fetchedBytes) return fetchedBytes;
    if (!data?.base64) return null;
    try {
      return decodeBase64Fast(data.base64);
    } catch {
      return null;
    }
  }, [data?.base64, fetchedBytes]);

  const [parsedDoc, setParsedDoc] = useState<DocPreviewData | null>(null);
  const [parsedSheet, setParsedSheet] = useState<TablePreviewData | null>(null);
  const [parsedSlides, setParsedSlides] = useState<SlidePreviewData | null>(null);
  const [binaryParseErr, setBinaryParseErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBinaryParseErr(null);
    setParsedDoc((prev) => {
      prev?.mediaUrls.forEach((u) => URL.revokeObjectURL(u));
      return null;
    });
    setParsedSheet(null);
    setParsedSlides((prev) => {
      prev?.mediaUrls.forEach((u) => URL.revokeObjectURL(u));
      return null;
    });

    if (!rawBinaryBytes) return;

    const run = async () => {
      try {
        if (isXlsxExt) {
          const parsed = await parseXlsxBuffer(rawBinaryBytes);
          if (alive) setParsedSheet(parsed);
        } else if (isXlsExt) {
          const parsed = parseLegacyXlsBuffer(rawBinaryBytes);
          if (alive) setParsedSheet(parsed);
        } else if (isOdsExt) {
          const parsed = await parseOdsBuffer(rawBinaryBytes);
          if (alive) setParsedSheet(parsed);
        } else if (isDocxExt) {
          const parsed = await parseDocxBuffer(rawBinaryBytes);
          if (!alive) {
            parsed.mediaUrls.forEach((u) => URL.revokeObjectURL(u));
            return;
          }
          setParsedDoc(parsed);
        } else if (isOdtExt) {
          const parsed = await parseOdtBuffer(rawBinaryBytes);
          if (!alive) {
            parsed.mediaUrls.forEach((u) => URL.revokeObjectURL(u));
            return;
          }
          setParsedDoc(parsed);
        } else if (isDocExt && !data?.previewHtml) {
          const parsed = parseLegacyDocFallback(rawBinaryBytes);
          if (alive) setParsedDoc(parsed);
        } else if (isPptxExt) {
          const parsed = await parsePptxBuffer(rawBinaryBytes);
          if (!alive) {
            parsed.mediaUrls.forEach((u) => URL.revokeObjectURL(u));
            return;
          }
          setParsedSlides(parsed);
        }
      } catch (err) {
        if (alive) setBinaryParseErr((err as Error).message || "文件解析失败");
      }
    };
    void run();

    return () => {
      alive = false;
    };
  }, [data?.previewHtml, isDocExt, isDocxExt, isOdsExt, isOdtExt, isPptxExt, isXlsExt, isXlsxExt, rawBinaryBytes]);

  useEffect(() => {
    return () => {
      parsedDoc?.mediaUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [parsedDoc]);

  useEffect(() => {
    return () => {
      parsedSlides?.mediaUrls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [parsedSlides]);

  const blobUrl = useMemo(() => {
    if (rawBinaryBytes && isPdfExt) {
      const copy = rawBinaryBytes.buffer.slice(
        rawBinaryBytes.byteOffset,
        rawBinaryBytes.byteOffset + rawBinaryBytes.byteLength,
      ) as ArrayBuffer;
      return URL.createObjectURL(new Blob([copy], { type: "application/pdf" }));
    }
    if ((localStreamUrl && isDirectStreamMedia) || !data?.base64 || !data.mime) return null;
    if (
      data.mime.startsWith("image/") ||
      data.mime === "application/pdf" ||
      data.mime.startsWith("audio/") ||
      data.mime.startsWith("video/")
    ) {
      try {
        const bytes = decodeBase64Fast(data.base64);
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return URL.createObjectURL(new Blob([copy], { type: data.mime }));
      } catch {
        return null;
      }
    }
    return null;
  }, [data?.base64, data?.mime, isDirectStreamMedia, isPdfExt, localStreamUrl, rawBinaryBytes]);

  useEffect(() => {
    if (!blobUrl) return;
    return () => URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  const pdfPageCount = useMemo(() => {
    if (!isPdfExt || !rawBinaryBytes) return null;
    return estimatePdfPages(rawBinaryBytes);
  }, [isPdfExt, rawBinaryBytes]);

  const read = useCallback(
    async (offset: number) => {
      const isRelWorkspace = !/^(\/|~\/|~|[A-Za-z]:[\\/])/.test(tab.path);
      const localPathTarget = agent?.cwd && isRelWorkspace ? tab.path : tab.absPath || tab.path;
      const wantBytes = isCsv || isJsonLines || isJson ? 2 * 1024 * 1024 : undefined;
      let res: ReadResult | null = null;
      if (offset === 0 && native.available()) {
        if (!agent && tab.absPath) {
          res = await native.localReadFile({ path: tab.absPath, maxBytes: wantBytes }).catch(() => null);
        } else if (agent) {
          const localId = localHostIdStore.get() ?? (await ensureLocalHostDeviceId());
          if (localId && localId === agent.deviceId) {
            res = await native.localReadFile({ cwd: agent.cwd, path: localPathTarget, maxBytes: wantBytes }).catch(() => null);
          }
        }
      }
      if (!res) {
        if (!agent) throw new Error("这个文件所在的 Agent 已经不在了。");
        res = await rpcCall(agent.deviceId, "files.read", {
          agent: agent.key,
          path: tab.path,
          offset,
          ...(wantBytes ? { maxBytes: wantBytes } : {}),
        });
      }
      if (offset === 0 && agent && res.path && res.path !== tab.path && isRelWorkspace) {
        updateResolvedFilePanePath(agent.key, tab.path, res.path, agent.cwd);
      }
      setData(res);
      setText((prev) => (offset ? prev + (res.text ?? "") : (res.text ?? "")));
      return res;
    },
    [agent, isCsv, isJson, isJsonLines, tab.absPath, tab.path],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    setText("");
    if (localStreamUrl && isDirectStreamMedia) return;
    if (localStreamUrl && isDirectFetchBinary) {
      let alive = true;
      fetch(localStreamUrl)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const lenHdr = r.headers.get("content-length");
          const buf = await r.arrayBuffer();
          if (!alive) return;
          setFetchedSize(lenHdr ? Number.parseInt(lenHdr, 10) || buf.byteLength : buf.byteLength);
          setFetchedBytes(new Uint8Array(buf));
        })
        .catch(() => {
          if (!alive) return;
          read(0).catch((e) => {
            if (alive) setError(fileError(e));
          });
        });
      return () => {
        alive = false;
      };
    }
    if (!agent && !(tab.absPath && native.available())) {
      setError("这个文件所在的 Agent 已经不在了。");
      return;
    }
    read(0).catch((e) => setError(fileError(e)));
  }, [agent, isDirectFetchBinary, isDirectStreamMedia, localStreamUrl, read, tab.absPath]);

  useEffect(() => {
    headStateCbRef.current?.({
      size: data?.size ?? fetchedSize ?? null,
      binary: Boolean(data?.binary || (isDirectFetchBinary && fetchedBytes)),
      isMd: isMd && data?.text !== undefined,
      canPreview: canPreviewText,
      previewLabel,
      preview,
      setPreview,
    });
  }, [canPreviewText, data?.binary, data?.size, data?.text, fetchedBytes, fetchedSize, isDirectFetchBinary, isMd, preview, previewLabel]);

  const shownText = preview && prettyJson !== null ? prettyJson : text;
  const codeLines = useMemo(() => (shownText ? shownText.split("\n") : []), [shownText]);
  const lines = useMemo(() => codeLines.map((_, i) => i + 1).join("\n"), [codeLines]);

  useLayoutEffect(() => {
    if (!tab.line || preview || !text) return;
    targetLineRef.current?.scrollIntoView({ block: "center" });
  }, [preview, tab.line, text]);

  const hlStart = tab.line;
  const hlEnd = tab.endLine ?? tab.line;
  const isPdf = data?.mime === "application/pdf" || isPdfExt;
  const isAudio = data?.kind === "audio" || Boolean(data?.mime?.startsWith("audio/"));
  const isVideo = data?.kind === "video" || Boolean(data?.mime?.startsWith("video/"));
  const isImage = data?.kind === "image" || Boolean(data?.mime?.startsWith("image/"));
  const isSpreadsheet = data?.kind === "spreadsheet" || isXlsxExt || isXlsExt || isOdsExt;
  const isRichDoc = data?.kind === "document" || isDocxExt || isDocExt || isOdtExt || isRtfExt;
  const isPresentation = data?.kind === "presentation" || isPptxExt;

  const compactExternalAction = canRevealLocal ? (
    <PocketButton size="sm" variant="ghost" onClick={handleOpenDefaultLocal} title="用系统默认应用打开">
      <ExternalLink size={12} />
      <span>系统打开</span>
    </PocketButton>
  ) : !native.available() && tab.absPath ? (
    <PocketButton
      size="sm"
      variant="ghost"
      onClick={() => void openExternalUrl(toFileUrl(tab.absPath!))}
      title="用系统默认应用打开"
    >
      <ExternalLink size={12} />
      <span>系统打开</span>
    </PocketButton>
  ) : null;

  const binaryActions = canRevealLocal ? (
    <div className="viewer-media-actions">
      <PocketButton size="sm" variant="soft" onClick={handleRevealLocal}>
        <FolderOpen size={13} />
        <span>{revealLabel}</span>
      </PocketButton>
      <PocketButton size="sm" variant="ghost" onClick={handleOpenDefaultLocal}>
        <ExternalLink size={13} />
        <span>用系统默认应用打开</span>
      </PocketButton>
    </div>
  ) : !native.available() && tab.absPath ? (
    <PocketButton size="sm" variant="soft" onClick={() => void openExternalUrl(toFileUrl(tab.absPath!))}>
      <ExternalLink size={13} />
      <span>用系统默认应用打开</span>
    </PocketButton>
  ) : null;

  const effectiveMediaSrc =
    localStreamUrl && isDirectStreamMedia ? localStreamUrl : blobUrl;

  return (
    <div className="viewer">
      {!embedded ? (
        <div className="viewer-head">
          <span className="mono truncate grow" title={tab.absPath || tab.path}>{tab.path}</span>
          {(data?.size ?? fetchedSize) !== null && (data?.size ?? fetchedSize) !== undefined ? (
            <span className="faint num">
              {(data?.size ?? fetchedSize)! >= 1024
                ? `${Math.round((data?.size ?? fetchedSize)! / 1024)} KB`
                : `${data?.size ?? fetchedSize} B`}
            </span>
          ) : null}
          {canPreviewText ? (
            <div className="segmented">
              <button className={preview ? "active" : ""} onClick={() => setPreview(true)}>{previewLabel}</button>
              <button className={!preview ? "active" : ""} onClick={() => setPreview(false)}>源码</button>
            </div>
          ) : null}
          {canRevealLocal ? (
            <button
              type="button"
              className="side-icon-btn"
              aria-label={revealShort}
              title={`${revealLabel}（${localTarget.path}）`}
              onClick={handleRevealLocal}
            >
              <FolderOpen size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="side-icon-btn"
            aria-label="复制路径"
            title="复制路径"
            onClick={async () => {
              const ok = await copyToClipboard(tab.absPath || tab.path);
              toast(ok ? "路径已复制" : "复制失败", !ok);
            }}
          >
            <Copy size={14} />
          </button>
        </div>
      ) : null}
      <div className="viewer-body">
        {error ? (
          <div className="inline-alert" style={{ margin: 16 }}>{error}</div>
        ) : effectiveMediaSrc && (isVideo || isVideoExt) ? (
          <PocketVideoPlayer
            src={effectiveMediaSrc}
            title={tab.title}
            onError={localStreamUrl && isDirectStreamMedia ? () => setStreamError(true) : undefined}
            extraActions={compactExternalAction}
          />
        ) : effectiveMediaSrc && (isAudio || isAudioExt) ? (
          <div className="viewer-media">
            <PocketAudioPlayer
              src={effectiveMediaSrc}
              title={tab.title}
              onError={localStreamUrl && isDirectStreamMedia ? () => setStreamError(true) : undefined}
              extraActions={compactExternalAction}
            />
          </div>
        ) : effectiveMediaSrc && (isImage || isImageExt) ? (
          <PocketImageViewer
            src={effectiveMediaSrc}
            alt={tab.title}
            onError={localStreamUrl && isDirectStreamMedia ? () => setStreamError(true) : undefined}
            actions={compactExternalAction}
          />
        ) : !data && !fetchedBytes ? (
          <div className="faint" style={{ padding: 16 }}>读取中…</div>
        ) : blobUrl && isPdf ? (
          <PocketPdfViewer
            url={blobUrl}
            pageCount={pdfPageCount}
            title={tab.title}
            actions={compactExternalAction}
          />
        ) : parsedSheet ? (
          <PocketDataGrid data={parsedSheet} actions={compactExternalAction} />
        ) : isRichDoc && (preview || !data?.text) && (parsedDoc || (isRtfExt && rtfDocData) || data?.previewHtml) ? (
          <PocketDocViewer
            doc={isRtfExt ? (rtfDocData ?? parsedDoc) : parsedDoc}
            previewHtml={data?.previewHtml}
            fileName={tab.title}
            formatLabel={
              isDocxExt ? "Word (.docx)" : isDocExt ? "Word (.doc)" : isOdtExt ? "OpenDocument (.odt)" : "RTF 文档"
            }
            actions={compactExternalAction}
          />
        ) : isPresentation && parsedSlides ? (
          <PocketPptxViewer data={parsedSlides} actions={compactExternalAction} />
        ) : binaryParseErr && !data?.text ? (
          <div className="viewer-media">
            <div className="faint">无法直接解析该文件（{binaryParseErr}）。</div>
            {binaryActions}
          </div>
        ) : data?.base64 && data.mime?.startsWith("image/") ? (
          <PocketImageViewer
            src={`data:${data.mime};base64,${data.base64}`}
            alt={tab.title}
            actions={compactExternalAction}
          />
        ) : data?.binary && (isImage || isPdf || isAudio || isVideo || isSpreadsheet || isRichDoc || isPresentation) && data.truncated ? (
          <div className="viewer-media">
            <div className="faint">
              这个{isPdf ? " PDF " : isAudio || isVideo ? "音视频" : isSpreadsheet ? "表格" : isRichDoc || isPresentation ? "文档" : "图片"}文件超过预览大小上限，无法直接内联加载。
            </div>
            {binaryActions}
          </div>
        ) : data?.binary && !data.text ? (
          <div className="viewer-media">
            <div className="faint">这是二进制文件，没法按文字显示。</div>
            {binaryActions}
          </div>
        ) : preview && isMd ? (
          <div className="viewer-md">
            <RichMarkdown text={text} onOpenFile={(target) => void openAgentFileTarget(agent, target)} />
          </div>
        ) : preview && isSvg ? (
          <PocketImageViewer
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`}
            alt={tab.title}
            actions={compactExternalAction}
          />
        ) : preview && isHtml ? (
          <iframe sandbox="allow-scripts" srcDoc={text} className="viewer-html-frame" title={tab.title} />
        ) : preview && isTextTable && textTableData ? (
          <PocketDataGrid data={textTableData} actions={compactExternalAction} />
        ) : hlStart !== undefined && codeLines.length <= 5000 ? (
          <div className="code-lines">
            {codeLines.map((lineText, idx) => {
              const ln = idx + 1;
              const isHl = hlEnd !== undefined ? ln >= hlStart && ln <= hlEnd : ln === hlStart;
              return (
                <div
                  key={ln}
                  ref={ln === hlStart ? targetLineRef : undefined}
                  className={`code-line${isHl ? " hl" : ""}`}
                >
                  <span className="code-line-num num" aria-hidden>{ln}</span>
                  <span className="code-line-src">{lineText || " "}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="code-view">
            <pre className="code-gutter" aria-hidden>{lines}</pre>
            <pre className="code-text">{shownText}</pre>
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
  layoutKey,
}: {
  tab: Pick<WebTab, "id" | "url">;
  active: boolean;
  /** Where URL and title changes go (the shell's tabs); the workbench's own tabs by default. */
  onChange?: (patch: { url?: string; title?: string }) => void;
  /** Layout version string to force re-measuring native WebView bounds across split resizes. */
  layoutKey?: string;
}) {
  const toast = useToast();
  const update = (patch: { url?: string; title?: string }) =>
    onChange ? onChange(patch) : wb.set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === tab.id && t.kind === "web" ? { ...t, ...patch } : t)) }));
  const engine = useClientConfig().browser.searchEngine;
  const hidden = useWindowHidden();
  const overlays = overlayStore.use((s) => s.open);
  const hostRef = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const [address, setAddress] = useState(() => parseLocalFileAddress(tab.url) ?? (tab.url === "about:blank" ? "" : tab.url));
  const [loading, setLoading] = useState(false);
  const supported = native.browserSupported();
  const localPath = useMemo(() => parseLocalFileAddress(tab.url), [tab.url]);
  const localTitle = localPath ? localPath.split(/[\\/]/).pop() || localPath : "";
  const platform = detectPlatform();
  const revealLabel = revealInFolderLabel(platform);
  const revealShort = revealInFolderShortLabel(platform);
  const canRevealLocalPath = native.available() && Boolean(localPath);

  useEffect(() => {
    const parsed = parseLocalFileAddress(tab.url);
    if (parsed) setAddress(parsed);
    else if (tab.url === "about:blank") setAddress("");
  }, [tab.url]);

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

  // The native webview follows its placeholder; it hides behind dialogs, local previews, and other tabs.
  useLayoutEffect(() => {
    if (!supported || localPath) return;
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
  }, [layoutKey, localPath, supported, tab.id, tab.url]);

  useEffect(() => {
    if (!supported) return;
    void native.browserSetVisible(tab.id, active && !hidden && overlays === 0 && !localPath);
  }, [supported, tab.id, active, hidden, overlays, localPath]);

  useEffect(() => () => void native.browserSetVisible(tab.id, false), [tab.id]);

  const go = (input: string) => {
    const local = parseLocalFileAddress(input);
    if (local) {
      const fileUrl = toFileUrl(local);
      const name = local.split(/[\\/]/).pop() || local;
      setAddress(local);
      update({ url: fileUrl, title: name });
      if (supported) void native.browserSetVisible(tab.id, false);
      return;
    }
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
        <button type="button" className="side-icon-btn" aria-label="后退" disabled={!supported || Boolean(localPath)} onClick={() => void native.browserNavigate(tab.id, { back: true })}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="side-icon-btn" aria-label="前进" disabled={!supported || Boolean(localPath)} onClick={() => void native.browserNavigate(tab.id, { forward: true })}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="side-icon-btn" aria-label={loading ? "停止" : "刷新"} disabled={!supported || Boolean(localPath)} onClick={() => void native.browserNavigate(tab.id, loading ? { stop: true } : { reload: true })}>
          {loading ? <X size={15} /> : <RotateCw size={15} />}
        </button>
        <div className="grow">
          <PocketInput value={address} onChange={(e) => setAddress(e.target.value)} placeholder="输入网址、本机文件路径，或搜索" spellCheck={false} />
        </div>
        {native.available() ? (
          <button
            type="button"
            className="side-icon-btn"
            aria-label="在内置查看器打开文件"
            title="选择本机文件在内置查看器打开 (PDF / 音视频 / HTML / SVG / 表格 / 文档)"
            onClick={async () => {
              const picked = await native.pickFile();
              if (picked) go(picked);
            }}
          >
            <FolderOpen size={15} />
          </button>
        ) : null}
        {canRevealLocalPath && localPath ? (
          <button
            type="button"
            className="side-icon-btn"
            aria-label={revealShort}
            title={revealLabel}
            onClick={() =>
              void revealLocalFile({ path: localPath }).catch((e: Error) => toast(e.message || "打开所在目录失败", true))
            }
          >
            <FolderOpen size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className="side-icon-btn"
          aria-label={localPath ? "用系统默认应用打开" : "在系统浏览器打开"}
          title={localPath ? "用系统默认应用打开" : "在系统默认程序打开"}
          onClick={() => {
            if (localPath && native.available()) {
              void openLocalFileDefault({ path: localPath }).catch((e: Error) =>
                toast(e.message || "无法用系统默认应用打开", true),
              );
            } else {
              void openExternalUrl(localPath ? toFileUrl(localPath) : toUrl(address || tab.url, engine));
            }
          }}
        >
          <ExternalLink size={15} />
        </button>
        <CookieImportButton compact currentHost={hostOf(tab.url)} />
      </form>
      <div ref={hostRef} className={`web-host${localPath ? " local" : ""}`}>
        {localPath ? (
          <FileViewer
            key={localPath}
            tab={{ path: localPath, title: localTitle, absPath: localPath }}
            agent={undefined}
          />
        ) : !supported ? (
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
