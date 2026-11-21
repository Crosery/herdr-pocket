import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ExternalLink, FolderOpen, GripVertical, Keyboard, RefreshCw, ShieldCheck } from "lucide-react";
import { detectPlatform } from "../lib/bridge";
import { native, type Permission, type PermissionKind, type Permissions } from "../lib/native";
import { XiaoyangOrb } from "./MascotAndVendor";
import { PocketBadge, PocketButton, PocketModal, useToast } from "./PocketUI";

const PLATFORM = detectPlatform();
const MAC = PLATFORM === "macos";

export interface PermissionGuideSpec {
  title: string;
  breadcrumbs: string[];
  why: string;
  actionLabel: string;
  dragSupported: boolean;
  steps: string[];
  settingTip?: string;
}

export function permissionGuideSpec(kind: PermissionKind): PermissionGuideSpec {
  if (!MAC) {
    if (kind === "keyboard") {
      return {
        title: "键盘快捷键",
        breadcrumbs: ["Windows 设置", "隐私和安全性"],
        why: "如果系统或输入法占用了快捷键，可在系统或输入法设置里调整后重试。",
        actionLabel: "打开输入设置",
        dragSupported: false,
        steps: ["打开对应设置页面并保存调整后，返回 Herdr Pocket 自动刷新状态。"],
      };
    }
    return {
      title: "麦克风",
      breadcrumbs: ["Windows 设置", "隐私和安全性", "麦克风"],
      why: "录音进行语音输入和小羊语音通话都需要麦克风权限。",
      actionLabel: "直达系统设置「麦克风」",
      dragSupported: false,
      steps: [
        "在系统设置页面打开「麦克风访问权限」。",
        "确保「允许应用访问麦克风」以及底部的「允许桌面应用访问麦克风」均已开启。",
      ],
    };
  }

  switch (kind) {
    case "microphone":
      return {
        title: "麦克风",
        breadcrumbs: ["系统设置", "隐私与安全性", "麦克风"],
        why: "用于语音输入与小羊实时通话。",
        actionLabel: "直达系统设置「麦克风」",
        dragSupported: true,
        steps: [
          "打开系统设置「麦克风」并开启 Herdr Pocket 开关。",
          "若列表里没有应用，按住下方卡片拖进右侧列表即可。",
        ],
      };
    case "accessibility":
      return {
        title: "辅助功能",
        breadcrumbs: ["系统设置", "隐私与安全性", "辅助功能"],
        why: "用于将识别文字直接粘贴到当前聚焦的应用。",
        actionLabel: "直达系统设置「辅助功能」",
        dragSupported: true,
        steps: [
          "打开系统设置「辅助功能」并开启 Herdr Pocket 开关。",
          "按住下方「Herdr Pocket.app」拖进右侧列表即可快速添加。",
        ],
      };
    case "inputMonitoring":
      return {
        title: "输入监控",
        breadcrumbs: ["系统设置", "隐私与安全性", "输入监控"],
        why: "用于监听右 Option、Fn 等单键按住说话。",
        actionLabel: "直达系统设置「输入监控」",
        dragSupported: true,
        steps: [
          "打开系统设置「输入监控」并开启 Herdr Pocket 开关。",
          "按住下方「Herdr Pocket.app」拖进右侧列表即可快速添加。",
        ],
      };
    case "fullDiskAccess":
      return {
        title: "完全磁盘访问权限",
        breadcrumbs: ["系统设置", "隐私与安全性", "完全磁盘访问权限"],
        why: "用于导入 Safari 已登录站点的 Cookie。",
        actionLabel: "直达系统设置「完全磁盘访问权限」",
        dragSupported: true,
        steps: [
          "打开系统设置「完全磁盘访问权限」并开启开关。",
          "按住下方「Herdr Pocket.app」拖进右侧列表即可快速添加。",
        ],
      };
    case "keyboard":
      return {
        title: "地球仪键（Fn）",
        breadcrumbs: ["系统设置", "键盘", "按下地球仪键时"],
        why: "避免按 Fn 时同时触发系统输入法或表情面板。",
        actionLabel: "直达系统设置「键盘」",
        dragSupported: false,
        steps: [
          "打开「系统设置 › 键盘」，将「按下地球仪键时」改为「不执行任何操作」。",
        ],
        settingTip: "修改后无需重启应用，状态会自动刷新。",
      };
  }
}

function anyPermissionGrantedTransition(prev: Permissions | null, next: Permissions): boolean {
  if (!prev) return false;
  return (
    (prev.microphone !== "granted" && next.microphone === "granted") ||
    (prev.accessibility !== "granted" && next.accessibility === "granted") ||
    (prev.inputMonitoring !== "granted" && next.inputMonitoring === "granted") ||
    (prev.fullDiskAccess !== "granted" && next.fullDiskAccess === "granted") ||
    (prev.fnKeyAction !== "none" && next.fnKeyAction === "none")
  );
}

export function permissionGranted(kind: PermissionKind, perms: Permissions | null): boolean {
  if (!perms) return false;
  if (kind === "keyboard") return perms.fnKeyAction === "none";
  if (kind === "fullDiskAccess") return perms.fullDiskAccess === "granted";
  return perms[kind] === "granted";
}

export function permissionStateOf(kind: PermissionKind, perms: Permissions | null): Permission {
  if (!perms) return "unknown";
  if (kind === "keyboard") return perms.fnKeyAction === "none" ? "granted" : "denied";
  if (kind === "fullDiskAccess") return perms.fullDiskAccess ?? "unknown";
  return perms[kind];
}

export interface PermissionGuideModalProps {
  kind: PermissionKind | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  perms: Permissions | null;
  onRefresh: () => Promise<void> | void;
}

/**
 * Interactive system-permission onboarding dialog: opens the exact OS settings sub-pane,
 * lets macOS users drag `Herdr Pocket.app` straight into System Settings lists, and polls live state.
 */
export function PermissionGuideModal({
  kind,
  open,
  onOpenChange,
  perms,
  onRefresh,
}: PermissionGuideModalProps) {
  const toast = useToast();
  const [livePerms, setLivePerms] = useState<Permissions | null>(perms);
  const [dragging, setDragging] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartedRef = useRef(false);
  const prevPermsRef = useRef<Permissions | null>(perms);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    setLivePerms(perms);
  }, [perms]);

  useEffect(() => {
    if (!open || !kind) return;
    prevPermsRef.current = perms;
  }, [open, kind]);

  useEffect(() => {
    if (!open || !kind || !native.available()) return;
    let alive = true;
    const poll = async () => {
      const next = await native.getPermissions();
      if (!alive || !next) return;
      const prev = prevPermsRef.current;
      prevPermsRef.current = next;
      setLivePerms(next);
      if (anyPermissionGrantedTransition(prev, next)) {
        void native.voiceReload().finally(() => {
          void onRefreshRef.current();
        });
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 800);
    const onFocus = () => {
      void poll();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, kind]);

  if (!kind) return null;
  const spec = permissionGuideSpec(kind);
  const effectivePerms = livePerms ?? perms;
  const granted = permissionGranted(kind, effectivePerms);
  const state = permissionStateOf(kind, effectivePerms);
  const bundleLabel = effectivePerms?.appBundlePath || "/Applications/Herdr Pocket.app";

  const handleOpenSettings = async () => {
    if (!native.available()) {
      toast("请在桌面客户端中使用系统设置直达与快捷引导");
      return;
    }
    try {
      // Only request OS prompt for microphone when undetermined; for Accessibility / Input Monitoring
      // avoid popping a competing macOS modal alert over System Settings.
      await native.openPermissionSettings(kind, kind === "microphone");
      const next = await native.getPermissions();
      if (next) {
        const prev = prevPermsRef.current;
        prevPermsRef.current = next;
        setLivePerms(next);
        if (anyPermissionGrantedTransition(prev, next)) {
          void native.voiceReload();
        }
      }
      await onRefreshRef.current();
    } catch (e) {
      toast((e as Error).message || "无法打开系统设置", true);
    }
  };

  const handleRevealBundle = async () => {
    if (!native.available()) {
      toast(`应用路径：${bundleLabel}`);
      return;
    }
    const revealed = await native.revealAppBundle();
    if (!revealed) {
      toast("未找到应用包，请从“应用程序”目录打开 Herdr Pocket", true);
    } else {
      toast("已在 Finder 中高亮定位 Herdr Pocket.app，可直接拖入系统设置列表");
    }
  };

  const handleRecheck = async () => {
    setRechecking(true);
    try {
      await native.voiceReload();
      if (native.available()) {
        const next = await native.getPermissions();
        if (next) setLivePerms(next);
      }
      await onRefresh();
    } finally {
      setRechecking(false);
    }
  };

  const resetPointerDrag = () => {
    pressOriginRef.current = null;
    dragStartedRef.current = false;
    setDragging(false);
  };

  const beginNativeDrag = () => {
    if (!native.available()) {
      toast("在 macOS 桌面客户端中按住即可将 Herdr Pocket.app 拖入系统设置窗口");
      resetPointerDrag();
      return;
    }
    void native.startAppBundleDrag().then((started) => {
      if (!started) setDragging(false);
    });
  };

  return (
    <PocketModal
      open={open}
      onOpenChange={(next) => {
        if (!next) resetPointerDrag();
        onOpenChange(next);
      }}
      title={`${spec.title} · 授权引导`}
      subtitle={spec.why}
      width={576}
    >
      <div className="perm-guide-stack">
        <div className={`perm-guide-banner${granted ? " ok" : ""}`}>
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            {granted ? (
              <CheckCircle2 size={16} style={{ color: "var(--mint-text)", flex: "none" }} />
            ) : (
              <ShieldCheck size={16} style={{ color: "var(--accent-text)", flex: "none" }} />
            )}
            <span className="truncate" style={{ fontWeight: 700 }}>
              {granted
                ? `${spec.title}已就绪，可以立即使用`
                : state === "notDetermined"
                  ? "尚未授予此权限，按下方两步快速开启"
                  : "当前尚未允许，开启或拖入列表后会自动生效"}
            </span>
          </div>
          <PocketBadge tone={granted ? "mint" : state === "notDetermined" ? "warn" : "blush"}>
            {granted ? "已允许 · 已生效" : "待开启 · 自动检测中"}
          </PocketBadge>
        </div>

        <section className="perm-step-card">
          <div className="perm-step-head">
            <span className="perm-step-num">1</span>
            <span className="perm-step-title">一键直达对应系统设置页面</span>
          </div>
          <div className="perm-breadcrumb" aria-label="系统设置路径">
            {spec.breadcrumbs.map((seg, i) => (
              <span key={seg} className="perm-breadcrumb-part">
                {i > 0 ? <span className="perm-breadcrumb-sep">›</span> : null}
                <span className={`perm-breadcrumb-chip${i === spec.breadcrumbs.length - 1 ? " leaf" : ""}`}>
                  {seg}
                </span>
              </span>
            ))}
          </div>
          <div className="faint" style={{ fontSize: "calc(12.5px * var(--ts, 1))", lineHeight: 1.5 }}>
            {spec.steps[0]}
          </div>
          <div className="row wrap" style={{ gap: 8, marginTop: 2 }}>
            <PocketButton size="sm" variant="primary" onClick={() => void handleOpenSettings()}>
              <ExternalLink size={13} />
              <span>{spec.actionLabel}</span>
            </PocketButton>
            <PocketButton size="sm" variant="ghost" disabled={rechecking} onClick={() => void handleRecheck()}>
              <RefreshCw size={13} />
              <span>{rechecking ? "正在检测…" : "重新检测"}</span>
            </PocketButton>
          </div>
        </section>

        {spec.dragSupported ? (
          <section className="perm-step-card">
            <div className="perm-step-head">
              <span className="perm-step-num">2</span>
              <span className="perm-step-title">按住拖动应用到系统设置列表（快速适配）</span>
            </div>
            <div className="faint" style={{ fontSize: "calc(12.5px * var(--ts, 1))", lineHeight: 1.5 }}>
              {spec.steps[1]}
            </div>
            <div className="perm-drag-stage">
              <div
                role="button"
                tabIndex={0}
                className={`perm-drag-chip${dragging ? " dragging" : ""}`}
                aria-label="按住拖动 Herdr Pocket.app 到系统设置列表"
                title={`按住并拖入系统设置：${bundleLabel}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  pressOriginRef.current = { x: e.clientX, y: e.clientY };
                  dragStartedRef.current = false;
                  setDragging(true);
                }}
                onPointerMove={(e) => {
                  if (!pressOriginRef.current || dragStartedRef.current) return;
                  if ((e.buttons & 1) === 0) {
                    resetPointerDrag();
                    return;
                  }
                  const dx = e.clientX - pressOriginRef.current.x;
                  const dy = e.clientY - pressOriginRef.current.y;
                  if (Math.hypot(dx, dy) >= 3) {
                    dragStartedRef.current = true;
                    beginNativeDrag();
                  }
                }}
                onPointerUp={() => resetPointerDrag()}
                onPointerCancel={() => resetPointerDrag()}
                onBlur={() => resetPointerDrag()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void handleRevealBundle();
                  }
                }}
              >
                <GripVertical size={15} className="perm-drag-grip" />
                <XiaoyangOrb size={34} mood={granted ? "yay" : "hello"} />
                <div className="perm-drag-meta">
                  <div className="perm-drag-name">Herdr Pocket.app</div>
                  <div className="perm-drag-path mono truncate">{bundleLabel}</div>
                </div>
                <span className="perm-drag-tag">按住拖拽</span>
              </div>

              <ArrowRight size={16} className="perm-drag-arrow" aria-hidden />

              <div className="perm-drop-preview" aria-hidden>
                <div className="perm-drop-preview-cap">系统设置 · {spec.title}</div>
                <div className="perm-drop-preview-row">
                  <span className="perm-drop-preview-dot" />
                  <span className="truncate">Herdr Pocket</span>
                  <span className="perm-drop-preview-switch">
                    <span />
                  </span>
                </div>
              </div>
            </div>

            <div className="row wrap" style={{ gap: 8 }}>
              <PocketButton size="sm" variant="soft" onClick={() => void handleRevealBundle()}>
                <FolderOpen size={13} />
                <span>在 Finder 中定位应用</span>
              </PocketButton>
            </div>
            <div className="perm-guide-tip">
              若列表已有 Herdr Pocket 仍显示未允许：关闭重开开关，或选中点「−」移除后重新拖入
            </div>
          </section>
        ) : (
          <section className="perm-step-card">
            <div className="perm-step-head">
              <span className="perm-step-num">2</span>
              <span className="perm-step-title">核对系统开关设置</span>
            </div>
            <div className="perm-drop-preview static">
              <div className="perm-drop-preview-cap">{spec.breadcrumbs.join(" › ")}</div>
              <div className="perm-drop-preview-row">
                <Keyboard size={14} style={{ flex: "none", color: "var(--accent-text)" }} />
                <span>
                  {kind === "keyboard" ? "按下地球仪键时 → 不执行任何操作" : "允许应用与桌面应用访问麦克风"}
                </span>
              </div>
            </div>
            {spec.settingTip ? <div className="perm-guide-tip">{spec.settingTip}</div> : null}
          </section>
        )}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <PocketButton size="sm" variant={granted ? "primary" : "ghost"} onClick={() => onOpenChange(false)}>
            {granted ? "已完成" : "关闭"}
          </PocketButton>
        </div>
      </div>
    </PocketModal>
  );
}
