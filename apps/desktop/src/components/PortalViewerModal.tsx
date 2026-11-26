import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Columns2,
  Copy,
  ExternalLink,
  Eye,
  FileCode2,
  Folder,
  FolderOpen,
  FolderSearch,
  Globe,
  Hand,
  Keyboard,
  Maximize2,
  Minimize2,
  Monitor,
  MousePointer,
  MousePointerClick,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Agent, FileEntry, PortalInputAction, PortalItem, RemoteWindowInfo } from "@herdr-pocket/protocol";
import { FileViewer } from "../views/WorkbenchView";
import { copyToClipboard, detectPlatform, isTauri, openExternalUrl, readFromClipboard } from "../lib/bridge";
import { useLocalHostDeviceId } from "../lib/fonts";
import { native } from "../lib/native";
import {
  capturePortalFrameOnce,
  closePortalSurface,
  isLoopbackPortalUrl,
  openPortalSurface,
  portalStore,
  refreshHostPortals,
  resolvePortalTransport,
  sendPortalInput,
  subscribePortalFrames,
  syncPortalClipboard,
  updatePortalStreamConfig,
} from "../lib/portalClient";
import { ensureDirectLinkNow, rpcCall } from "../lib/relay";
import { liveStore } from "../lib/store";
import { openFileTab } from "../shell/shellStore";
import { PocketButton, PocketIconButton, PocketInput, PocketModal, PocketSelect, useToast } from "./PocketUI";
import { PortalRemoteStage, type RemoteControlMode, type StageStreamMetrics } from "./PortalRemoteStage";

const SESSION_LABELS: Record<string, string> = {
  macos: "macOS ScreenCaptureKit",
  win32: "Windows Win32",
  x11: "Linux X11",
  "wayland-wlroots": "Linux Wayland (wlroots)",
  "wayland-kde": "Linux Wayland (KDE)",
  "wayland-gnome": "Linux Wayland (GNOME)",
  "wayland-other": "Linux Wayland",
  headless: "Linux 无界面模式",
};

const QUALITY_PRESETS: Array<{ id: string; label: string; fps: number; maxWidth: number; quality: number }> = [
  { id: "smooth", label: "流畅 · 60帧", fps: 60, maxWidth: 1280, quality: 54 },
  { id: "hd30", label: "高清 · 30帧", fps: 30, maxWidth: 1440, quality: 68 },
  { id: "hd60", label: "超清 · 60帧", fps: 60, maxWidth: 1600, quality: 66 },
  { id: "raw60", label: "原画 · 60帧", fps: 60, maxWidth: 2240, quality: 82 },
];

const MOD_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "meta", label: "Cmd/Win" },
  { id: "ctrl", label: "Ctrl" },
  { id: "alt", label: "Opt/Alt" },
  { id: "shift", label: "Shift" },
];

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
  const heartbeatsById = portalStore.use((s) => s.heartbeatsById);
  const caps = portalStore.use((s) => s.capsByHost[hostId]);
  const windows = portalStore.use((s) => s.windowsByHost[hostId] ?? []);
  liveStore.use((s) => s.direct[hostId]);
  const relayRttMs = liveStore.use((s) => s.rttMs);
  const [, setTransportTick] = useState(0);

  const item = activePortalId ? itemsById[activePortalId] : undefined;
  const frame = item ? framesById[item.id] : undefined;
  const heartbeat = item ? heartbeatsById[item.id] : undefined;
  const localHostId = useLocalHostDeviceId();

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTransportTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const isRemoteHost = !isTauri() || !localHostId || (item ? item.hostId !== localHostId : hostId !== localHostId);
  const canOpenUrlLocally = Boolean(item?.url && (!isRemoteHost || !isLoopbackPortalUrl(item.url)));
  const isMacDesktop = isTauri() && detectPlatform() === "macos";
  const permNoteMatch = /屏幕录制|抓屏权限|screen_recording/i;
  const needsMacScreenPerm = Boolean(
    isMacDesktop &&
      !isRemoteHost &&
      (permNoteMatch.test(item?.streamError ?? "") ||
        (!item && caps?.notes?.some((n) => permNoteMatch.test(n)))),
  );
  const inputPermNote = caps?.inputPermissionNote;
  const needsMacAccessPerm = Boolean(isMacDesktop && !isRemoteHost && inputPermNote);

  const [browserUrlInput, setBrowserUrlInput] = useState("http://127.0.0.1:3000");
  const [navUrlInput, setNavUrlInput] = useState("");
  const [targetPathInput, setTargetPathInput] = useState("");
  const [loadingWin, setLoadingWin] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [retryingFrame, setRetryingFrame] = useState(false);
  const [waitingSlow, setWaitingSlow] = useState(false);
  const [keyBuffer, setKeyBuffer] = useState("");
  const [controlMode, setControlMode] = useState<RemoteControlMode>(() =>
    typeof window !== "undefined" && window.innerWidth < 720 ? "trackpad" : "pointer",
  );
  const [presetId, setPresetId] = useState<string>("hd60");
  const [showRemoteCursor, setShowRemoteCursor] = useState(true);
  const [shortcutOpen, setShortcutOpen] = useState(true);
  const [immersive, setImmersive] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [latchedMods, setLatchedMods] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<StageStreamMetrics>({ fps: 0, kbps: 0 });
  const [clipBusy, setClipBusy] = useState(false);

  const DEFAULT_PRESET = { id: "hd60", label: "超清 · 60帧", fps: 60, maxWidth: 1600, quality: 66 };
  const activePreset = QUALITY_PRESETS.find((p) => p.id === presetId) ?? DEFAULT_PRESET;
  const streamCfgRef = useRef({
    fps: activePreset.fps,
    maxWidth: activePreset.maxWidth,
    quality: activePreset.quality,
    showCursor: showRemoteCursor,
  });
  streamCfgRef.current = {
    fps: activePreset.fps,
    maxWidth: activePreset.maxWidth,
    quality: activePreset.quality,
    showCursor: showRemoteCursor,
  };

  useEffect(() => {
    if (item?.url) setNavUrlInput(item.url);
  }, [item?.id, item?.url]);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setLatchedMods([]);
    setMetrics({ fps: 0, kbps: 0 });
  }, [item?.id]);

  useEffect(() => {
    if (!open || !item) return;
    if (!isRemoteHost && item.kind === "window") {
      // Viewing a local OS window inside Pocket on the same computer: default to read-only so pointer moves never warp our own mouse cursor.
      setControlMode("view");
    } else {
      setControlMode(typeof window !== "undefined" && window.innerWidth < 720 ? "trackpad" : "pointer");
    }
  }, [isRemoteHost, item?.id, item?.kind, open]);

  useEffect(() => {
    if (!open || !hostId) return;
    ensureDirectLinkNow(hostId);
    setLoadingWin(true);
    void refreshHostPortals(hostId, agent?.key, true)
      .catch(() => {})
      .finally(() => setLoadingWin(false));
  }, [agent?.key, hostId, open]);

  const itemHostId = item?.hostId;
  const itemId = item?.id;
  const itemCanInteract = Boolean(item?.canInteract);
  const hasFrame = Boolean(frame);
  useEffect(() => {
    setWaitingSlow(false);
    if (!open || !itemId || !itemCanInteract || hasFrame) return;
    const t = window.setTimeout(() => setWaitingSlow(true), 3500);
    return () => window.clearTimeout(t);
  }, [hasFrame, itemCanInteract, itemId, open]);

  useEffect(() => {
    if (!open || !itemHostId || !itemId || !itemCanInteract) return;
    return subscribePortalFrames(itemHostId, itemId, streamCfgRef.current);
  }, [itemCanInteract, itemHostId, itemId, open]);

  useEffect(() => {
    if (!open || (!needsMacScreenPerm && !needsMacAccessPerm)) return;
    const retryAfterGrant = async () => {
      const p = await native.getPermissions();
      if (p?.screenRecording !== "granted" && p?.accessibility !== "granted") return;
      void refreshHostPortals(hostId, agent?.key, true).catch(() => {});
      if (itemHostId && itemId) {
        void capturePortalFrameOnce(itemHostId, itemId, streamCfgRef.current).catch(() => {});
      }
    };
    const off = native.onPermissionsChanged((p) => {
      if (p.screenRecording !== "granted" && p.accessibility !== "granted") return;
      void refreshHostPortals(hostId, agent?.key, true).catch(() => {});
      if (itemHostId && itemId) {
        void capturePortalFrameOnce(itemHostId, itemId, streamCfgRef.current).catch(() => {});
      }
    });
    const onFocus = () => {
      void retryAfterGrant();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [agent?.key, hostId, itemHostId, itemId, needsMacAccessPerm, needsMacScreenPerm, open]);

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

  const handleSendInput = (input: PortalInputAction): Promise<unknown> | void => {
    if (!item || !item.canInteract) return;
    return sendPortalInput(item.hostId, item.id, input).catch((e: Error) => {
      if (input.type !== "pointer" || (input.action !== "move" && input.action !== "drag")) {
        toast(e.message || "远控输入失败", true);
      }
    });
  };

  const handleSelectPreset = (nextId: string) => {
    setPresetId(nextId);
    const next = QUALITY_PRESETS.find((p) => p.id === nextId);
    if (!next || !item || !item.canInteract) return;
    void updatePortalStreamConfig(item.hostId, item.id, {
      fps: next.fps,
      maxWidth: next.maxWidth,
      quality: next.quality,
      showCursor: showRemoteCursor,
    });
  };

  const handleToggleCursor = () => {
    const next = !showRemoteCursor;
    setShowRemoteCursor(next);
    if (!item || !item.canInteract) return;
    void updatePortalStreamConfig(item.hostId, item.id, { showCursor: next });
  };

  const handleToggleMod = (mod: string) => {
    setLatchedMods((prev) => (prev.includes(mod) ? prev.filter((m) => m !== mod) : [...prev, mod]));
  };

  const sendShortcutKey = (key: string, fixedMods: string[] = []) => {
    if (!item || !item.canInteract) return;
    const mods = Array.from(new Set([...fixedMods, ...latchedMods]));
    handleSendInput({
      type: "key",
      key,
      action: "press",
      ...(mods.length ? { modifiers: mods } : {}),
    });
    if (latchedMods.length) setLatchedMods([]);
  };

  const handlePushClipboard = async () => {
    if (!item || clipBusy) return;
    setClipBusy(true);
    try {
      const localText = (await readFromClipboard()) ?? keyBuffer;
      if (!localText) {
        toast("本机剪贴板为空，可先在下方输入文本再同步", true);
        return;
      }
      await syncPortalClipboard(item.hostId, item.id, "set", localText);
      toast(`已推送剪贴板到远端（${localText.length} 字符）`);
    } catch (e) {
      toast((e as Error).message || "推送剪贴板失败", true);
    } finally {
      setClipBusy(false);
    }
  };

  const handlePullClipboard = async () => {
    if (!item || clipBusy) return;
    setClipBusy(true);
    try {
      const remoteText = await syncPortalClipboard(item.hostId, item.id, "get");
      if (!remoteText) {
        toast("远端剪贴板暂无文本内容");
        return;
      }
      await copyToClipboard(remoteText).catch(() => false);
      const preview = remoteText.replace(/\s+/g, " ").slice(0, 32);
      toast(`已拉取远端剪贴板：${preview}${remoteText.length > 32 ? "…" : ""}`);
    } catch (e) {
      toast((e as Error).message || "拉取剪贴板失败", true);
    } finally {
      setClipBusy(false);
    }
  };

  const handleScreenshot = () => {
    if (!frame) return;
    const ext = frame.mime === "image/jpeg" ? "jpg" : frame.mime === "image/webp" ? "webp" : "png";
    const filename = `remote-${(item?.title || "capture").replace(/[^\w.-]+/g, "_")}.${ext}`;
    const a = document.createElement("a");
    if (frame.rawBytes && frame.rawBytes.byteLength > 0) {
      const url = URL.createObjectURL(new Blob([frame.rawBytes as Uint8Array<ArrayBuffer>], { type: frame.mime }));
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } else if (frame.data) {
      a.href = `data:${frame.mime};base64,${frame.data}`;
      a.download = filename;
      a.click();
    } else {
      return;
    }
    toast("已保存当前画面截图");
  };

  const handleRequestAccessibility = () => {
    if (needsMacAccessPerm) {
      void native.openPermissionSettings("accessibility", true);
    }
    if (item) {
      void sendPortalInput(item.hostId, item.id, { type: "promptPermission", kind: "accessibility" }).catch(() => {});
    }
  };

  const sessionLabel = caps ? (SESSION_LABELS[caps.sessionType] ?? caps.sessionType) : "检测中";
  const isRemoteMacHost = caps?.sessionType === "macos";
  const primaryCopyMod = isRemoteMacHost ? ["meta"] : ["ctrl"];
  const transport = resolvePortalTransport(hostId, localHostId, frame);
  const transportLabel = transport.label;
  const rttMs = transport.rttMs ?? relayRttMs;
  const handleRetryP2p = () => {
    ensureDirectLinkNow(hostId);
    toast("正在尝试建立 P2P 直连…");
  };
  const fpsStatusText =
    metrics.fps > 0 && !(heartbeat?.idle && metrics.fps <= 1)
      ? `${metrics.fps} fps · ${metrics.kbps} KB/s`
      : frame
        ? `静止省流 · 就绪 ${heartbeat?.fps ?? activePreset.fps}fps`
        : "等待首帧…";

  return (
    <PocketModal
      open={open}
      onOpenChange={(next) => {
        if (!next) setImmersive(false);
        onOpenChange(next);
      }}
      width={immersive ? 1920 : 1060}
      className={immersive ? "is-immersive" : ""}
      hideHeader={immersive}
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
                <div className="inline-alert" style={{ marginBottom: 8, alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span>{caps.notes.join("；")}</span>
                  {needsMacScreenPerm ? (
                    <PocketButton
                      size="sm"
                      variant="primary"
                      onClick={() => void native.openPermissionSettings("screenRecording", true)}
                    >
                      <ExternalLink size={12} />
                      <span>去授权屏幕录制</span>
                    </PocketButton>
                  ) : null}
                </div>
              ) : null}
              {inputPermNote ? (
                <div className="inline-alert" style={{ marginBottom: 8, alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <ShieldAlert size={14} />
                    <span>{inputPermNote}</span>
                  </span>
                  <PocketButton size="sm" variant="primary" onClick={handleRequestAccessibility}>
                    <ExternalLink size={12} />
                    <span>{needsMacAccessPerm ? "去授权辅助功能" : "触发远端辅助功能授权"}</span>
                  </PocketButton>
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
          <div className={`portal-interactive-wrap${immersive ? " is-immersive" : ""}`}>
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
                      {canOpenUrlLocally ? (
                        <PocketButton
                          size="sm"
                          variant="ghost"
                          onClick={() => void openExternalUrl(item.url!)}
                          title="在当前设备浏览器打开"
                        >
                          <ExternalLink size={12} />
                          <span>本机打开</span>
                        </PocketButton>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  {windows.length > 0 ? (
                    <PocketSelect
                      size="sm"
                      ariaLabel="切换远端显示器或窗口"
                      value={item.windowId || "screen:0"}
                      onValueChange={(nextWid) => {
                        const chosen = windows.find((w) => w.id === nextWid);
                        if (chosen) void handleLaunchWindow(chosen);
                      }}
                      options={windows.map((w) => ({
                        value: w.id,
                        label: `${w.appName} · ${w.title}`,
                        ...(w.bounds ? { badge: `${w.bounds.width}×${w.bounds.height}` } : {}),
                      }))}
                    />
                  ) : (
                    <span className="portal-cap-pill truncate">{item.title}</span>
                  )}
                </>
              )}

              <div className="portal-mode-seg" role="group" aria-label="操控模式">
                <button
                  type="button"
                  className={`portal-mode-btn${controlMode === "pointer" ? " active" : ""}`}
                  onClick={() => setControlMode("pointer")}
                  title="指针直控：移动同步、点击与拖拽直达目标"
                >
                  <MousePointer size={12} />
                  <span>指针</span>
                </button>
                <button
                  type="button"
                  className={`portal-mode-btn${controlMode === "trackpad" ? " active" : ""}`}
                  onClick={() => setControlMode("trackpad")}
                  title="触控板模式：单指划动光标、双击拖拽、双指缩放"
                >
                  <Hand size={12} />
                  <span>触控板</span>
                </button>
                <button
                  type="button"
                  className={`portal-mode-btn${controlMode === "view" ? " active" : ""}`}
                  onClick={() => setControlMode("view")}
                  title="仅观看：锁定远端输入，避免误触"
                >
                  <Eye size={12} />
                  <span>只读</span>
                </button>
              </div>

              <PocketSelect
                size="sm"
                ariaLabel="画面清晰度与帧率"
                value={presetId}
                onValueChange={handleSelectPreset}
                options={QUALITY_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
              />

              {!transport.isDirect ? (
                <button
                  type="button"
                  className="portal-cap-pill accent mono"
                  style={{ cursor: "pointer" }}
                  title={transport.addr ? `${transport.label} (${transport.addr})` : "当前走中继传输，点击重试 P2P 直连"}
                  onClick={handleRetryP2p}
                >
                  {transportLabel} · {fpsStatusText}
                  {typeof rttMs === "number" ? ` · ${rttMs}ms` : ""}
                </button>
              ) : (
                <span
                  className="portal-cap-pill accent mono"
                  title={transport.addr ? `${transport.label} (${transport.addr})` : transport.label}
                >
                  {transportLabel} · {fpsStatusText}
                  {typeof rttMs === "number" ? ` · ${rttMs}ms` : ""}
                </span>
              )}

              <div className="portal-bar-actions">
                <PocketIconButton
                  size="sm"
                  tooltip={showRemoteCursor ? "隐藏远端原生光标" : "显示远端原生光标"}
                  active={showRemoteCursor}
                  onClick={handleToggleCursor}
                >
                  <MousePointerClick size={13} />
                </PocketIconButton>
                <PocketIconButton
                  size="sm"
                  tooltip="缩小画面"
                  disabled={zoom <= 1}
                  onClick={() => {
                    const next = Math.max(1, Math.round((zoom - 0.5) * 10) / 10);
                    setZoom(next);
                    if (next <= 1) setPan({ x: 0, y: 0 });
                  }}
                >
                  <ZoomOut size={13} />
                </PocketIconButton>
                <PocketIconButton
                  size="sm"
                  tooltip={`放大画面（当前 ${Math.round(zoom * 100)}%）`}
                  disabled={zoom >= 4}
                  onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.5) * 10) / 10))}
                >
                  <ZoomIn size={13} />
                </PocketIconButton>
                <PocketIconButton
                  size="sm"
                  tooltip={shortcutOpen ? "收起快捷按键与剪贴板栏" : "展开快捷按键与剪贴板栏"}
                  active={shortcutOpen}
                  onClick={() => setShortcutOpen((v) => !v)}
                >
                  <Keyboard size={13} />
                </PocketIconButton>
                <PocketIconButton
                  size="sm"
                  tooltip="截图保存当前帧"
                  disabled={!frame}
                  onClick={handleScreenshot}
                >
                  <Camera size={13} />
                </PocketIconButton>
                <PocketIconButton
                  size="sm"
                  tooltip={immersive ? "退出全屏远控" : "沉浸全屏远控"}
                  active={immersive}
                  onClick={() => setImmersive((v) => !v)}
                >
                  {immersive ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </PocketIconButton>
                <PocketIconButton
                  size="sm"
                  tooltip="关闭此次回传"
                  onClick={() => {
                    const closingId = item.id;
                    setImmersive(false);
                    onSelectPortalId(null);
                    void closePortalSurface(item.hostId, closingId);
                  }}
                >
                  <Trash2 size={13} />
                </PocketIconButton>
                {immersive ? (
                  <PocketIconButton
                    size="sm"
                    tooltip="退出远程窗口"
                    onClick={() => {
                      setImmersive(false);
                      onOpenChange(false);
                    }}
                  >
                    <X size={14} />
                  </PocketIconButton>
                ) : null}
              </div>
            </div>

            {inputPermNote ? (
              <div className="inline-alert" style={{ alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <ShieldAlert size={14} />
                  <span>{inputPermNote}</span>
                </span>
                <PocketButton size="sm" variant="primary" onClick={handleRequestAccessibility}>
                  <ExternalLink size={12} />
                  <span>{needsMacAccessPerm ? "去授权辅助功能" : "触发远端辅助功能授权"}</span>
                </PocketButton>
              </div>
            ) : null}

            {shortcutOpen ? (
              <div className="portal-shortcut-bar">
                <div className="portal-shortcut-group">
                  {MOD_OPTIONS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`portal-mod-chip mono${latchedMods.includes(m.id) ? " active" : ""}`}
                      onClick={() => handleToggleMod(m.id)}
                      title="点击锁定修饰键（将在下次点击或按键后自动生效并释放）"
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="portal-shortcut-group">
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("Escape")}>
                    Esc
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("Tab")}>
                    Tab
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("Backspace")}>
                    退格
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("a", primaryCopyMod)}>
                    全选
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("c", primaryCopyMod)}>
                    复制
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("v", primaryCopyMod)}>
                    粘贴
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("z", primaryCopyMod)}>
                    撤销
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="ghost"
                    onClick={() => sendShortcutKey("Tab", isRemoteMacHost ? ["meta"] : ["alt"])}
                  >
                    切换应用
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="ghost"
                    onClick={() => sendShortcutKey("ArrowUp", isRemoteMacHost ? ["ctrl"] : ["meta"])}
                  >
                    调度中心
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("ArrowLeft")}>
                    左
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("ArrowUp")}>
                    上
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("ArrowDown")}>
                    下
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("ArrowRight")}>
                    右
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => sendShortcutKey("Enter")}>
                    回车
                  </PocketButton>
                </div>
                <div className="portal-shortcut-group">
                  <PocketButton
                    size="sm"
                    variant="soft"
                    disabled={clipBusy}
                    onClick={() => void handlePushClipboard()}
                  >
                    <ClipboardPaste size={12} />
                    <span>推送剪贴板</span>
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="soft"
                    disabled={clipBusy}
                    onClick={() => void handlePullClipboard()}
                  >
                    <Clipboard size={12} />
                    <span>拉取剪贴板</span>
                  </PocketButton>
                </div>
              </div>
            ) : null}

            <PortalRemoteStage
              item={item}
              frame={frame}
              controlMode={controlMode}
              showRemoteCursor={showRemoteCursor}
              zoom={zoom}
              pan={pan}
              onPanChange={setPan}
              onZoomChange={setZoom}
              latchedMods={latchedMods}
              onConsumeLatchedMods={() => setLatchedMods([])}
              onSendInput={handleSendInput}
              onMetricsChange={setMetrics}
              placeholder={
                <div className="portal-stage-placeholder">
                  <MousePointerClick size={28} />
                  <div>
                    {item.streamError
                      ? "暂时无法获取远端画面"
                      : waitingSlow
                        ? "暂未收到画面帧"
                        : "正在建立画面流…"}
                  </div>
                  {item.streamError ? (
                    <div className="faint" style={{ maxWidth: 520, lineHeight: 1.5 }}>{item.streamError}</div>
                  ) : caps?.notes?.length ? (
                    <div className="faint" style={{ maxWidth: 520, lineHeight: 1.5 }}>{caps.notes.join("；")}</div>
                  ) : waitingSlow ? (
                    <div className="faint" style={{ maxWidth: 520, lineHeight: 1.5 }}>
                      远端窗口可能已最小化、被遮挡，或当前会话未授予系统屏幕录制权限
                    </div>
                  ) : null}
                  {isRemoteHost && item.url && isLoopbackPortalUrl(item.url) ? (
                    <div className="faint mono">该地址为远端电脑本地服务 (127.0.0.1)，无法从当前设备直接打开</div>
                  ) : null}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                    {needsMacScreenPerm ? (
                      <PocketButton
                        size="sm"
                        variant="primary"
                        onClick={() => void native.openPermissionSettings("screenRecording", true)}
                      >
                        <ExternalLink size={12} />
                        <span>去授权屏幕录制</span>
                      </PocketButton>
                    ) : null}
                    <PocketButton
                      size="sm"
                      variant="soft"
                      disabled={retryingFrame}
                      onClick={() => {
                        setRetryingFrame(true);
                        void capturePortalFrameOnce(item.hostId, item.id, streamCfgRef.current)
                          .catch((e: Error) => toast(e.message || "重试捕获失败", true))
                          .finally(() => setRetryingFrame(false));
                      }}
                    >
                      <RefreshCw size={12} className={retryingFrame ? "pk-spin" : undefined} />
                      <span>重试捕获</span>
                    </PocketButton>
                    {canOpenUrlLocally ? (
                      <PocketButton size="sm" variant="soft" onClick={() => void openExternalUrl(item.url!)}>
                        <ExternalLink size={12} />
                        <span>在当前设备直接打开链接</span>
                      </PocketButton>
                    ) : null}
                  </div>
                </div>
              }
            />

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
              {!transport.isDirect ? (
                <button
                  type="button"
                  className="portal-cap-pill accent"
                  style={{ cursor: "pointer" }}
                  title="当前走中继传输，点击重试 P2P 直连"
                  onClick={handleRetryP2p}
                >
                  {transportLabel}
                  {typeof rttMs === "number" ? ` · ${rttMs}ms` : ""}
                </button>
              ) : (
                <span className="portal-cap-pill accent">
                  {transportLabel}
                  {typeof rttMs === "number" ? ` · ${rttMs}ms` : ""}
                </span>
              )}
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
