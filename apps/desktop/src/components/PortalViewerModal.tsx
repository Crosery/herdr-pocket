import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Columns2,
  Copy,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  FolderSearch,
  Globe,
  Monitor,
  MousePointerClick,
  RefreshCw,
  RotateCw,
  Trash2,
} from "lucide-react";
import type { Agent, FileEntry, PortalItem, RemoteWindowInfo } from "@herdr-pocket/protocol";
import { FileViewer } from "../views/WorkbenchView";
import { copyToClipboard, openExternalUrl } from "../lib/bridge";
import {
  closePortalSurface,
  mapContainedPointer,
  openPortalSurface,
  portalStore,
  refreshHostPortals,
  sendPortalInput,
  subscribePortalFrames,
} from "../lib/portalClient";
import { rpcCall } from "../lib/relay";
import { liveStore } from "../lib/store";
import { openFileTab } from "../shell/shellStore";
import { PocketButton, PocketIconButton, PocketInput, PocketModal, PocketSelect, useToast } from "./PocketUI";

const SESSION_LABELS: Record<string, string> = {
  macos: "macOS CoreGraphics",
  win32: "Windows Win32",
  x11: "Linux X11",
  "wayland-wlroots": "Linux Wayland (wlroots)",
  "wayland-kde": "Linux Wayland (KDE)",
  "wayland-gnome": "Linux Wayland (GNOME)",
  "wayland-other": "Linux Wayland",
  headless: "Linux 无界面模式",
};

function RevealExplorer({
  item,
  agent,
  onOpenWindowStream,
}: {
  item: PortalItem;
  agent?: Agent;
  onOpenWindowStream: () => void;
}) {
  const toast = useToast();
  const initialDir = item.parentDir || item.targetPath || agent?.cwd || "~";
  const [dirPath, setDirPath] = useState(initialDir);
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(() =>
    item.targetPath && item.highlightName ? item.targetPath : null,
  );
  const hlRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDirPath(item.parentDir || item.targetPath || agent?.cwd || "~");
    setSelectedFile(item.targetPath && item.highlightName ? item.targetPath : null);
  }, [agent?.cwd, item.highlightName, item.id, item.parentDir, item.targetPath]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    void rpcCall(item.hostId, "portal.dirList", {
      portalId: item.id,
      ...(agent?.key ? { agent: agent.key } : {}),
      path: dirPath,
    })
      .then((res) => {
        if (!alive) return;
        setDirPath(res.dirPath);
        setParentDir(res.parentDir);
        setEntries(res.entries);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message || "无法读取远程目录");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agent?.key, dirPath, item.hostId, item.id]);

  useEffect(() => {
    if (hlRef.current) {
      hlRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [entries]);

  const previewTarget = selectedFile ?? (item.highlightName && item.targetPath ? item.targetPath : null);
  const previewName = previewTarget ? previewTarget.split(/[\\/]/).filter(Boolean).pop() || previewTarget : "";

  return (
    <div className="portal-reveal-split">
      <div className="portal-reveal-list-pane">
        <div className="portal-reveal-bar">
          <PocketIconButton
            size="sm"
            tooltip="上一级目录"
            disabled={!parentDir}
            onClick={() => {
              if (parentDir) setDirPath(parentDir);
            }}
          >
            <ArrowUp size={13} />
          </PocketIconButton>
          <span className="portal-reveal-path mono truncate" title={dirPath}>
            {dirPath}
          </span>
          <PocketButton size="sm" variant="ghost" onClick={onOpenWindowStream} title="回传对端桌面窗口">
            <AppWindow size={12} />
            <span>桌面窗口</span>
          </PocketButton>
        </div>
        {err ? (
          <div className="inline-alert" style={{ margin: 10 }}>
            {err}
          </div>
        ) : loading ? (
          <div className="faint" style={{ padding: 14 }}>
            正在读取远程目录…
          </div>
        ) : entries.length === 0 ? (
          <div className="faint" style={{ padding: 14 }}>
            目录为空
          </div>
        ) : (
          <div className="portal-reveal-items">
            {entries.map((entry) => {
              const isTarget = Boolean(
                item.highlightName &&
                  entry.name === item.highlightName &&
                  dirPath === item.parentDir,
              );
              const isSelected = previewTarget === entry.path;
              return (
                <button
                  key={entry.path}
                  ref={isTarget ? hlRef : undefined}
                  type="button"
                  className={`portal-reveal-row${isTarget ? " is-target" : ""}${isSelected ? " is-selected" : ""}`}
                  onClick={() => {
                    if (entry.kind === "dir") {
                      setDirPath(entry.path);
                    } else if (!entry.private) {
                      setSelectedFile(entry.path);
                    } else {
                      toast("包含敏感密钥的受保护文件不可预览", true);
                    }
                  }}
                >
                  {entry.kind === "dir" ? <Folder size={14} /> : <FileCode2 size={14} />}
                  <span className="truncate grow">{entry.name}</span>
                  {isTarget ? <span className="portal-reveal-badge">定位</span> : null}
                  {entry.kind === "file" && entry.size !== undefined ? (
                    <span className="faint num">
                      {entry.size >= 1024 ? `${Math.round(entry.size / 1024)} KB` : `${entry.size} B`}
                    </span>
                  ) : (
                    <ChevronRight size={13} className="faint" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="portal-reveal-preview">
        {previewTarget ? (
          <FileViewer
            key={`${item.hostId}:${previewTarget}`}
            tab={{ path: previewTarget, title: previewName, absPath: previewTarget }}
            agent={agent}
          />
        ) : (
          <div className="faint portal-empty-preview">点选左侧任意远程文件即可通过 P2P 直连预览</div>
        )}
      </div>
    </div>
  );
}

export function PortalViewerModal({
  open,
  onOpenChange,
  hostId,
  agent,
  activePortalId,
  onSelectPortalId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hostId: string;
  agent?: Agent;
  activePortalId: string | null;
  onSelectPortalId: (id: string | null) => void;
}) {
  const toast = useToast();
  const itemsById = portalStore.use((s) => s.itemsById);
  const framesById = portalStore.use((s) => s.framesById);
  const caps = portalStore.use((s) => s.capsByHost[hostId]);
  const windows = portalStore.use((s) => s.windowsByHost[hostId] ?? []);
  const directAddr = liveStore.use((s) => s.direct[hostId]);

  const item = activePortalId ? itemsById[activePortalId] : undefined;
  const frame = item ? framesById[item.id] : undefined;

  const [browserUrlInput, setBrowserUrlInput] = useState("http://127.0.0.1:3000");
  const [navUrlInput, setNavUrlInput] = useState("");
  const [targetPathInput, setTargetPathInput] = useState("");
  const [loadingWin, setLoadingWin] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [keyBuffer, setKeyBuffer] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (item?.url) setNavUrlInput(item.url);
  }, [item?.id, item?.url]);

  useEffect(() => {
    if (!open || !hostId) return;
    setLoadingWin(true);
    void refreshHostPortals(hostId, agent?.key, true)
      .catch(() => {})
      .finally(() => setLoadingWin(false));
  }, [agent?.key, hostId, open]);

  useEffect(() => {
    if (!open || !item || !item.canInteract) return;
    return subscribePortalFrames(item.hostId, item.id, 12);
  }, [item, open]);

  const hostSessionItems = useMemo(
    () =>
      Object.values(itemsById)
        .filter((i) => i.hostId === hostId && (!agent?.key || !i.agentKey || i.agentKey === agent.key))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [agent?.key, hostId, itemsById],
  );

  const handleLaunchBrowser = async (urlToOpen = browserUrlInput.trim()) => {
    if (!urlToOpen) return;
    setBusyAction(true);
    try {
      const normalized = /^https?:\/\//i.test(urlToOpen) ? urlToOpen : `https://${urlToOpen}`;
      const res = await openPortalSurface(hostId, {
        ...(agent?.key ? { agent: agent.key } : {}),
        kind: "browser",
        url: normalized,
      });
      onSelectPortalId(res.item.id);
    } catch (e) {
      toast((e as Error).message || "启动远程浏览器失败", true);
    } finally {
      setBusyAction(false);
    }
  };

  const handleLaunchWindow = async (w: RemoteWindowInfo) => {
    setBusyAction(true);
    try {
      const res = await openPortalSurface(hostId, {
        ...(agent?.key ? { agent: agent.key } : {}),
        kind: "window",
        windowId: w.id,
        title: `${w.appName} · ${w.title}`,
      });
      onSelectPortalId(res.item.id);
    } catch (e) {
      toast((e as Error).message || "打开系统窗口回传失败", true);
    } finally {
      setBusyAction(false);
    }
  };

  const handleLaunchPath = async (reveal: boolean) => {
    const clean = targetPathInput.trim();
    if (!clean) return;
    setBusyAction(true);
    try {
      const kind = reveal ? "reveal" : /\.html?$/i.test(clean) ? "html" : "file";
      const res = await openPortalSurface(hostId, {
        ...(agent?.key ? { agent: agent.key } : {}),
        kind,
        target: clean,
        reveal,
      });
      onSelectPortalId(res.item.id);
    } catch (e) {
      toast((e as Error).message || "打开远程文件失败", true);
    } finally {
      setBusyAction(false);
    }
  };

  const handlePointer = (action: "click" | "dblclick" | "down" | "up", clientX: number, clientY: number, button: "left" | "right" | "middle" = "left") => {
    if (!item || !item.canInteract || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const { nx, ny } = mapContainedPointer({
      clientX,
      clientY,
      rectLeft: rect.left,
      rectTop: rect.top,
      rectWidth: rect.width,
      rectHeight: rect.height,
      imageWidth: frame?.width ?? item.width,
      imageHeight: frame?.height ?? item.height,
    });
    void sendPortalInput(item.hostId, item.id, { type: "pointer", action, nx, ny, button }).catch((e: Error) => {
      toast(e.message || "远控点击失败", true);
    });
  };

  const sessionLabel = caps ? (SESSION_LABELS[caps.sessionType] ?? caps.sessionType) : "检测中";
  const transportLabel = directAddr || item?.transportHint === "p2p" ? "P2P 直连" : "中继传输";

  return (
    <PocketModal
      open={open}
      onOpenChange={onOpenChange}
      width={1020}
      title={item ? item.title : "跨端窗口、浏览器与文件回传"}
      subtitle={
        item
          ? `${transportLabel}${caps ? ` · ${sessionLabel}` : ""}${item.subtitle ? ` · ${item.subtitle}` : ""}`
          : `选择远程应用窗口、启动远程浏览器或定位远程文件（${sessionLabel}）`
      }
    >
      <div className="portal-modal-body">
        {hostSessionItems.length > 0 ? (
          <div className="portal-modal-tabs">
            {hostSessionItems.map((it) => (
              <button
                key={it.id}
                type="button"
                className={`portal-tab-chip${item?.id === it.id ? " active" : ""}`}
                onClick={() => onSelectPortalId(it.id)}
              >
                {it.kind === "browser" ? (
                  <Globe size={12} />
                ) : it.kind === "window" ? (
                  <AppWindow size={12} />
                ) : it.kind === "reveal" ? (
                  <FolderSearch size={12} />
                ) : (
                  <FileCode2 size={12} />
                )}
                <span className="truncate">{it.title}</span>
              </button>
            ))}
            <button
              type="button"
              className={`portal-tab-chip${!item ? " active" : ""}`}
              onClick={() => onSelectPortalId(null)}
            >
              <Monitor size={12} />
              <span>新建 / 选择窗口</span>
            </button>
          </div>
        ) : null}

        {!item ? (
          <div className="portal-launcher">
            <div className="portal-launch-card">
              <div className="portal-launch-title">
                <Globe size={15} />
                <span>启动远程浏览器回传（适用于 OAuth 授权、localhost 调试与远程网页）</span>
              </div>
              <div className="portal-launch-row">
                <PocketInput
                  value={browserUrlInput}
                  onChange={(e) => setBrowserUrlInput(e.target.value)}
                  placeholder="https://... 或 http://127.0.0.1:3000"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleLaunchBrowser();
                  }}
                />
                <PocketButton variant="primary" disabled={busyAction} onClick={() => void handleLaunchBrowser()}>
                  打开回传
                </PocketButton>
              </div>
            </div>

            <div className="portal-launch-card">
              <div className="portal-launch-title">
                <FolderSearch size={15} />
                <span>跨端打开或定位文件（支持 open / open -R 效果与 HTML 多资源 P2P 预览）</span>
              </div>
              <div className="portal-launch-row">
                <PocketInput
                  value={targetPathInput}
                  onChange={(e) => setTargetPathInput(e.target.value)}
                  placeholder={agent?.cwd ? `${agent.cwd}/index.html 或相对路径` : "~/work/index.html"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleLaunchPath(false);
                  }}
                />
                <PocketButton variant="soft" disabled={busyAction} onClick={() => void handleLaunchPath(false)}>
                  打开预览
                </PocketButton>
                <PocketButton variant="ghost" disabled={busyAction} onClick={() => void handleLaunchPath(true)}>
                  在目录定位 (-R)
                </PocketButton>
              </div>
            </div>

            <div className="portal-launch-card">
              <div className="portal-launch-head">
                <div className="portal-launch-title">
                  <AppWindow size={15} />
                  <span>正在运行的系统窗口与桌面（{sessionLabel}）</span>
                </div>
                <PocketButton
                  size="sm"
                  variant="ghost"
                  disabled={loadingWin}
                  onClick={() => {
                    setLoadingWin(true);
                    void refreshHostPortals(hostId, agent?.key, true).finally(() => setLoadingWin(false));
                  }}
                >
                  <RefreshCw size={12} className={loadingWin ? "pk-spin" : undefined} />
                  <span>刷新窗口</span>
                </PocketButton>
              </div>
              {caps?.notes?.length ? (
                <div className="inline-alert" style={{ marginBottom: 8 }}>
                  {caps.notes.join("；")}
                </div>
              ) : null}
              {windows.length === 0 ? (
                <div className="faint" style={{ padding: "8px 0" }}>
                  {caps?.sessionType === "headless"
                    ? "当前 Linux 主机无图形桌面环境，请使用上方「启动远程浏览器」或「文件预览」回传。"
                    : loadingWin
                      ? "正在枚举远端窗口…"
                      : "暂未发现可捕获的系统窗口。"}
                </div>
              ) : (
                <div className="portal-window-grid">
                  {windows.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      className="portal-window-card"
                      disabled={busyAction}
                      onClick={() => void handleLaunchWindow(w)}
                    >
                      <div className="portal-window-app">
                        {w.isScreen ? <Monitor size={14} /> : <AppWindow size={14} />}
                        <span className="truncate">{w.appName}</span>
                      </div>
                      <div className="portal-window-title truncate" title={w.title}>
                        {w.title}
                      </div>
                      {w.bounds ? (
                        <div className="portal-window-meta mono">
                          {w.bounds.width}×{w.bounds.height}
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : item.kind === "browser" || item.kind === "window" ? (
          <div className="portal-interactive-wrap">
            <div className="portal-interactive-bar">
              {item.kind === "browser" ? (
                <>
                  <PocketIconButton
                    size="sm"
                    tooltip="后退"
                    disabled={!frame?.canGoBack}
                    onClick={() => void sendPortalInput(item.hostId, item.id, { type: "navigate", action: "back" })}
                  >
                    <ArrowLeft size={14} />
                  </PocketIconButton>
                  <PocketIconButton
                    size="sm"
                    tooltip="前进"
                    disabled={!frame?.canGoForward}
                    onClick={() => void sendPortalInput(item.hostId, item.id, { type: "navigate", action: "forward" })}
                  >
                    <ArrowRight size={14} />
                  </PocketIconButton>
                  <PocketIconButton
                    size="sm"
                    tooltip="刷新网页"
                    onClick={() => void sendPortalInput(item.hostId, item.id, { type: "navigate", action: "reload" })}
                  >
                    <RotateCw size={14} />
                  </PocketIconButton>
                  <PocketInput
                    value={navUrlInput}
                    onChange={(e) => setNavUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void sendPortalInput(item.hostId, item.id, { type: "navigate", action: "goto", url: navUrlInput });
                      }
                    }}
                    className="portal-url-input mono"
                    placeholder="https://..."
                  />
                  {item.url ? (
                    <>
                      <PocketIconButton
                        size="sm"
                        tooltip="复制链接"
                        onClick={() => {
                          void copyToClipboard(item.url!);
                          toast("已复制链接");
                        }}
                      >
                        <Copy size={13} />
                      </PocketIconButton>
                      <PocketButton
                        size="sm"
                        variant="ghost"
                        onClick={() => void openExternalUrl(item.url!)}
                        title="如果非 localhost 链接，也可直接在当前电脑浏览器打开"
                      >
                        <ExternalLink size={12} />
                        <span>本机打开</span>
                      </PocketButton>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {windows.length > 0 ? (
                    <PocketSelect
                      size="sm"
                      value={item.windowId || "screen:0"}
                      onValueChange={(nextWid) => {
                        const chosen = windows.find((w) => w.id === nextWid);
                        if (chosen) void handleLaunchWindow(chosen);
                      }}
                      options={windows.map((w) => ({
                        value: w.id,
                        label: `${w.appName} · ${w.title}`,
                      }))}
                    />
                  ) : null}
                  <span className="portal-cap-pill">{sessionLabel}</span>
                  <div className="grow" />
                </>
              )}
              <span className="portal-cap-pill accent">{transportLabel}</span>
              <PocketIconButton
                size="sm"
                tooltip="关闭此次回传"
                onClick={() => {
                  const closingId = item.id;
                  onSelectPortalId(null);
                  void closePortalSurface(item.hostId, closingId);
                }}
              >
                <Trash2 size={13} />
              </PocketIconButton>
            </div>

            <div
              ref={stageRef}
              className="portal-stage"
              tabIndex={0}
              aria-label="远程交互画面，可点击、滚轮和键盘输入"
              onClick={(e) => {
                stageRef.current?.focus();
                handlePointer("click", e.clientX, e.clientY, e.button === 2 ? "right" : "left");
              }}
              onDoubleClick={(e) => {
                handlePointer("dblclick", e.clientX, e.clientY, "left");
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                handlePointer("click", e.clientX, e.clientY, "right");
              }}
              onWheel={(e) => {
                if (!stageRef.current) return;
                const rect = stageRef.current.getBoundingClientRect();
                const { nx, ny } = mapContainedPointer({
                  clientX: e.clientX,
                  clientY: e.clientY,
                  rectLeft: rect.left,
                  rectTop: rect.top,
                  rectWidth: rect.width,
                  rectHeight: rect.height,
                  imageWidth: frame?.width ?? item.width,
                  imageHeight: frame?.height ?? item.height,
                });
                void sendPortalInput(item.hostId, item.id, {
                  type: "wheel",
                  nx,
                  ny,
                  deltaX: e.deltaX,
                  deltaY: e.deltaY,
                }).catch(() => {});
              }}
              onKeyDown={(e) => {
                if (e.metaKey && e.key.toLowerCase() === "v") return;
                e.preventDefault();
                const mods: string[] = [];
                if (e.metaKey) mods.push("meta");
                if (e.ctrlKey) mods.push("ctrl");
                if (e.altKey) mods.push("alt");
                if (e.shiftKey) mods.push("shift");
                if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
                  void sendPortalInput(item.hostId, item.id, { type: "text", text: e.key }).catch(() => {});
                } else {
                  void sendPortalInput(item.hostId, item.id, { type: "key", key: e.key, modifiers: mods }).catch(() => {});
                }
              }}
              onPaste={(e) => {
                const clipText = e.clipboardData.getData("text/plain");
                if (clipText) {
                  e.preventDefault();
                  void sendPortalInput(item.hostId, item.id, { type: "text", text: clipText }).catch(() => {});
                }
              }}
            >
              {frame ? (
                <img
                  src={`data:${frame.mime};base64,${frame.data}`}
                  alt={item.title}
                  className="portal-stage-img"
                  draggable={false}
                />
              ) : (
                <div className="portal-stage-placeholder">
                  <MousePointerClick size={28} />
                  <div>正在建立画面流…</div>
                  {caps?.notes?.length ? <div className="faint">{caps.notes.join("；")}</div> : null}
                  {item.url ? (
                    <PocketButton size="sm" variant="soft" onClick={() => void openExternalUrl(item.url!)}>
                      <ExternalLink size={12} />
                      <span>在当前设备直接打开链接</span>
                    </PocketButton>
                  ) : null}
                </div>
              )}
            </div>

            <div className="portal-quick-input-bar">
              <PocketInput
                value={keyBuffer}
                onChange={(e) => setKeyBuffer(e.target.value)}
                placeholder="发送中文或长文本输入到远端焦点窗口（Enter 发送）…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && keyBuffer) {
                    e.preventDefault();
                    const text = keyBuffer;
                    setKeyBuffer("");
                    void sendPortalInput(item.hostId, item.id, { type: "text", text }).then(() =>
                      sendPortalInput(item.hostId, item.id, { type: "key", key: "Enter" }),
                    );
                  }
                }}
              />
              <PocketButton
                size="sm"
                variant="soft"
                disabled={!keyBuffer}
                onClick={() => {
                  const text = keyBuffer;
                  setKeyBuffer("");
                  void sendPortalInput(item.hostId, item.id, { type: "text", text });
                }}
              >
                发送文本
              </PocketButton>
            </div>
          </div>
        ) : item.kind === "reveal" ? (
          <RevealExplorer
            item={item}
            agent={agent}
            onOpenWindowStream={() => {
              const firstWin = windows.find((w) => !w.isScreen) ?? windows[0];
              if (firstWin) void handleLaunchWindow(firstWin);
              else onSelectPortalId(null);
            }}
          />
        ) : (
          <div className="portal-file-modal-wrap">
            <div className="portal-interactive-bar">
              <span className="portal-cap-pill accent">{transportLabel}</span>
              <span className="mono truncate grow">{item.targetPath || item.title}</span>
              {agent && item.targetPath ? (
                <PocketButton
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    openFileTab(agent.key, item.targetPath!, item.title, { absPath: item.targetPath });
                    onOpenChange(false);
                  }}
                >
                  <Columns2 size={12} />
                  <span>放到工作区打开</span>
                </PocketButton>
              ) : null}
              <PocketButton
                size="sm"
                variant="ghost"
                onClick={() => {
                  void openPortalSurface(hostId, {
                    ...(agent?.key ? { agent: agent.key } : {}),
                    kind: "reveal",
                    target: item.targetPath || item.parentDir,
                    reveal: true,
                  }).then((r) => onSelectPortalId(r.item.id));
                }}
              >
                <FolderOpen size={12} />
                <span>所在目录</span>
              </PocketButton>
              <PocketIconButton
                size="sm"
                tooltip="关闭此次回传"
                onClick={() => {
                  const closingId = item.id;
                  onSelectPortalId(null);
                  void closePortalSurface(item.hostId, closingId);
                }}
              >
                <Trash2 size={13} />
              </PocketIconButton>
            </div>
            <div className="portal-file-viewer-host">
              <FileViewer
                key={`${item.hostId}:${item.targetPath || item.title}`}
                tab={{ path: item.targetPath || item.title, title: item.title, absPath: item.targetPath }}
                agent={agent}
                embedded
              />
            </div>
          </div>
        )}
      </div>
    </PocketModal>
  );
}
