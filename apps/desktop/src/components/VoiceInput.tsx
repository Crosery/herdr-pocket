import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ExternalLink,
  Keyboard,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Power,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import { configKeySpec } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketIconButton, PocketSelect, PocketSwitch, useToast } from "./PocketUI";
import { XiaoyangOrb, resolveCallMascotMood } from "./MascotAndVendor";
import { PermissionGuideModal } from "./PermissionGuideModal";
import { VoiceprintModal } from "./VoiceprintModal";
import { assistantStore, loadAssistant } from "../lib/assistant";
import { detectPlatform } from "../lib/bridge";
import {
  native,
  type Permission,
  type PermissionKind,
  type Permissions,
  type VoiceAiConfigPatch,
  type VoiceAiState,
  type VoiceAiTier,
  type VoiceRuntime,
} from "../lib/native";
import { setConfig, useClientConfig } from "../lib/config";
import { isMockServer } from "../lib/mock";
import { settingsStore } from "../lib/store";
import { useWindowHidden } from "../lib/layout";
import { dismissVoiceMessage, hangupVoiceCall, setVoiceMuted, startVoiceCall, voiceCallStore } from "../lib/voiceCall";
import "../styles/btw-slash.css";

const PLATFORM = detectPlatform();
const MAC = PLATFORM === "macos";
const DESKTOP_VOICE = PLATFORM === "macos" || PLATFORM === "windows";

/** "CommandOrControl+Shift+Space" -> "⌘ ⇧ Space" on macOS, "Ctrl + Shift + Space" elsewhere. */
export function prettyHotkey(accel: string | null | undefined): string {
  if (!accel) return "未设置";
  const single = MODIFIER_KEYS.find((m) => m.value === accel);
  if (single) return single.label;
  const parts = accel.split("+");
  if (MAC) {
    const sym: Record<string, string> = { CommandOrControl: "⌘", CmdOrCtrl: "⌘", Command: "⌘", Cmd: "⌘", Super: "⌘", Alt: "⌥", Option: "⌥", Ctrl: "⌃", Control: "⌃", Shift: "⇧" };
    return parts.map((p) => sym[p] ?? p).join(" ");
  }
  const word: Record<string, string> = { CommandOrControl: "Ctrl", CmdOrCtrl: "Ctrl", Control: "Ctrl", Super: "Win", Option: "Alt" };
  return parts.map((p) => word[p] ?? p).join(" + ");
}

/** One modifier tapped alone (voiceInput.hotkey); macOS reads these through Input Monitoring. */
const MODIFIER_KEYS: Array<{ value: string; label: string; mac: boolean; win: boolean }> = [
  { value: "RightOption", label: MAC ? "右 ⌥ Option" : "右 Alt", mac: true, win: false },
  { value: "RightControl", label: MAC ? "右 ⌃ Control" : "右 Ctrl", mac: true, win: true },
  { value: "RightCommand", label: "右 ⌘ Command", mac: true, win: false },
  { value: "RightShift", label: MAC ? "右 ⇧ Shift" : "右 Shift", mac: true, win: true },
  { value: "Fn", label: "Fn（地球仪键）", mac: true, win: false },
];
const DEFAULT_COMBO = "CommandOrControl+Shift+Space";
/** Recommended wake key: right Option on macOS; right Ctrl on Windows (right Alt is AltGr on many layouts). */
const RECOMMENDED_KEY = MAC ? "RightOption" : "RightControl";
const isModifierKey = (v: string | null | undefined) => Boolean(v && MODIFIER_KEYS.some((m) => m.value === v));

/** Builds a Tauri accelerator from a keydown; null until a non-modifier key arrives. */
function acceleratorFrom(e: ReactKeyboardEvent): string | null {
  const mods: string[] = [];
  const primary = MAC ? e.metaKey : e.ctrlKey;
  if (primary) mods.push("CommandOrControl");
  if (MAC && e.ctrlKey) mods.push("Control");
  if (!MAC && e.metaKey) mods.push("Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code === "Space") key = "Space";
  else if (["Backquote", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash"].includes(code)) key = code;
  if (!key || !mods.length) return null;
  return [...mods, key].join("+");
}

const PERMISSION_INFO: Record<PermissionKind, { title: string; why: string; how: string }> = {
  microphone: {
    title: "麦克风",
    why: "用于与小羊实时语音通话和本地声纹降噪",
    how: MAC ? "系统设置 › 隐私与安全性 › 麦克风" : "设置 › 隐私和安全性 › 麦克风",
  },
  accessibility: {
    title: "辅助功能",
    why: "无需开启",
    how: "系统设置 › 隐私与安全性 › 辅助功能",
  },
  inputMonitoring: {
    title: "输入监控",
    why: "使用右 Option、Fn 等单键按一下唤醒小羊时需要",
    how: "系统设置 › 隐私与安全性 › 输入监控",
  },
  keyboard: {
    title: "地球仪键（Fn）",
    why: "避免按 Fn 时误触发系统输入法或表情",
    how: "系统设置 › 键盘 › 按下地球仪键时",
  },
  fullDiskAccess: {
    title: "完全磁盘访问",
    why: "导入 Safari Cookie 需要",
    how: "系统设置 › 隐私与安全性 › 完全磁盘访问权限",
  },
};

const PERM_LABEL: Record<Permission, { tone: "mint" | "blush" | "warn" | "neutral"; text: string }> = {
  granted: { tone: "mint", text: "已允许" },
  denied: { tone: "blush", text: "待开启" },
  notDetermined: { tone: "blush", text: "待开启" },
  restricted: { tone: "blush", text: "被系统限制" },
  notApplicable: { tone: "neutral", text: "不需要" },
  unknown: { tone: "neutral", text: "未检测" },
};

const DEMO_PERMS: Permissions = {
  platform: MAC ? "macos" : "windows",
  microphone: "granted",
  accessibility: "notApplicable",
  inputMonitoring: "notDetermined",
  fullDiskAccess: "denied",
  appBundlePath: "/Applications/Herdr Pocket.app",
  notes: [],
};

type MacRepairableKind = "inputMonitoring";

function PermissionRowIcon({ kind }: { kind: "microphone" | "inputMonitoring" }) {
  if (kind === "microphone") return <Mic size={16} />;
  return <Keyboard size={16} />;
}

export function PermissionCards({
  perms,
  onChanged,
  checking,
  singleKey = false,
}: {
  perms: Permissions | null;
  onChanged: () => void;
  checking: boolean;
  /** The hotkey is one modifier tapped alone: Input Monitoring is needed (macOS). */
  singleKey?: boolean;
}) {
  const toast = useToast();
  const [guideKind, setGuideKind] = useState<PermissionKind | null>(null);
  const [permsOverride, setPermsOverride] = useState<Permissions | null>(null);
  const [pendingGrant, setPendingGrant] = useState<Partial<Record<MacRepairableKind, boolean>>>({});
  const [resettingKind, setResettingKind] = useState<PermissionKind | null>(null);
  const [relaunching, setRelaunching] = useState(false);

  useEffect(() => {
    setPermsOverride(null);
  }, [perms]);

  const effectivePerms = permsOverride ?? perms ?? (!native.available() ? DEMO_PERMS : null);
  const kinds: Array<"microphone" | "inputMonitoring"> = MAC
    ? ["microphone", "inputMonitoring"]
    : ["microphone"];

  useEffect(() => {
    if (!effectivePerms) return;
    setPendingGrant((prev) => {
      if (prev.inputMonitoring && effectivePerms.inputMonitoring === "granted") {
        return {};
      }
      return prev;
    });
  }, [effectivePerms]);

  useEffect(() => {
    if (!MAC || !native.available() || !pendingGrant.inputMonitoring) return;
    let alive = true;
    const poll = async (forceRefresh = false) => {
      const next = await native.getPermissions();
      if (!alive || !next) return;
      const grantedNow = next.inputMonitoring === "granted";
      if (grantedNow) {
        await native.voiceReload().catch(() => false);
      }
      if ((grantedNow || forceRefresh) && alive) {
        onChanged();
      }
    };
    const timer = window.setInterval(() => {
      void poll(false);
    }, 800);
    const onFocus = () => {
      void poll(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [pendingGrant.inputMonitoring, onChanged]);

  const handleGrant = async (k: "microphone" | "inputMonitoring", state: Permission) => {
    if (MAC && k === "inputMonitoring") {
      setPendingGrant((prev) => ({ ...prev, [k]: true }));
    }
    if (!native.available()) {
      toast(
        MAC
          ? `演示模式：已打开系统设置「${PERMISSION_INFO[k].title}」，可直接使用下方重启或重置缓存`
          : "请在桌面客户端中打开系统设置",
      );
      return;
    }
    try {
      if (k === "microphone" && state === "notDetermined") {
        const next = await native.requestPermission(k);
        await native.voiceReload().finally(onChanged);
        if (next.microphone === "granted") return;
      }
      await native.openPermissionSettings(k, true);
      void native.voiceReload().finally(onChanged);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const handleResetMacPermission = async (k: MacRepairableKind) => {
    setResettingKind(k);
    try {
      const next = await native.resetMacPermission(k);
      setPendingGrant((prev) => ({ ...prev, [k]: next[k] !== "granted" }));
      if (!native.available()) {
        setPermsOverride(next);
        toast(`演示模式：已重置「${PERMISSION_INFO[k].title}」权限缓存并重新登记`);
      } else {
        await native.voiceReload().finally(onChanged);
        toast(`已重置「${PERMISSION_INFO[k].title}」权限缓存，请在系统设置中重新开启开关`);
      }
    } catch (e) {
      toast((e as Error).message || "重置权限缓存失败", true);
    } finally {
      setResettingKind(null);
    }
  };

  const handleRelaunch = async () => {
    setRelaunching(true);
    try {
      const restarted = await native.relaunchApp();
      if (!restarted) {
        toast("演示模式无法重启进程；桌面端会立即重启应用使权限生效");
      }
    } catch (e) {
      toast((e as Error).message || "重启应用失败", true);
    } finally {
      setRelaunching(false);
    }
  };

  return (
    <>
      <div className="perm-list" role="list">
        {kinds.map((k) => {
          const info = PERMISSION_INFO[k];
          const state: Permission = effectivePerms ? effectivePerms[k] : "unknown";
          if (state === "notApplicable") return null;
          const label = PERM_LABEL[state];
          const done = state === "granted";
          const isMacRepairable = MAC && k === "inputMonitoring";
          const showPendingBar = isMacRepairable && !done && Boolean(pendingGrant[k]);
          const optionalCombo = MAC && k === "inputMonitoring" && !singleKey;
          return (
            <div
              key={k}
              role="listitem"
              className={`perm-row${done ? " granted" : state === "denied" || state === "restricted" ? " warn" : ""}${showPendingBar ? " pending" : ""}`}
            >
              <div className="perm-row-main">
                <div className="perm-row-left">
                  <span className="perm-row-icon" aria-hidden>
                    <PermissionRowIcon kind={k} />
                  </span>
                  <div className="perm-row-copy">
                    <div className="perm-row-title-line">
                      <strong className="perm-row-title">{info.title}</strong>
                      {optionalCombo ? <span className="perm-opt-pill">可选（当前为组合键）</span> : null}
                    </div>
                    <div className="perm-row-desc">{info.why}</div>
                  </div>
                </div>
                <div className="perm-row-side">
                  <PocketBadge tone={label.tone}>{label.text}</PocketBadge>
                  <div className="perm-row-actions">
                    {!done ? (
                      <>
                        <PocketButton size="sm" variant="primary" onClick={() => void handleGrant(k, state)}>
                          <ExternalLink size={13} />
                          <span>{MAC ? "去授权" : "去开启"}</span>
                        </PocketButton>
                        {MAC ? (
                          <PocketButton size="sm" variant="soft" onClick={() => setGuideKind(k)}>
                            <span>引导与修复</span>
                          </PocketButton>
                        ) : (
                          <PocketButton
                            size="sm"
                            variant="ghost"
                            disabled={checking}
                            onClick={() => void native.voiceReload().finally(onChanged)}
                          >
                            <RefreshCw size={13} />
                            <span>重新检测</span>
                          </PocketButton>
                        )}
                      </>
                    ) : MAC ? (
                      <PocketButton size="sm" variant="ghost" onClick={() => setGuideKind(k)}>
                        <SlidersHorizontal size={13} />
                        <span>引导与修复</span>
                      </PocketButton>
                    ) : null}
                  </div>
                </div>
              </div>

              {showPendingBar ? (
                <div className="perm-pending-bar">
                  <div className="perm-pending-status">
                    <span className="status-dot breathe" aria-hidden />
                    <span>已打开系统设置，开启开关后需重启应用生效…</span>
                  </div>
                  <div className="perm-pending-actions">
                    <PocketButton
                      size="sm"
                      variant="soft"
                      disabled={relaunching}
                      onClick={() => void handleRelaunch()}
                    >
                      <Power size={13} />
                      <span>{relaunching ? "正在重启…" : "重启应用生效"}</span>
                    </PocketButton>
                    <PocketButton
                      size="sm"
                      variant="ghost"
                      disabled={resettingKind === k}
                      onClick={() => void handleResetMacPermission(k)}
                    >
                      <RotateCcw size={13} />
                      <span>
                        {resettingKind === k ? "正在重置…" : "已打开仍显示未允许？重置此权限缓存"}
                      </span>
                    </PocketButton>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <PermissionGuideModal
        kind={guideKind}
        open={guideKind !== null}
        onOpenChange={(o) => {
          if (!o) setGuideKind(null);
        }}
        perms={effectivePerms}
        onRefresh={onChanged}
      />
    </>
  );
}

export function HotkeyRecorder({ value, onChange, disabled }: { value: string | null; onChange: (v: string) => void; disabled?: boolean }) {
  const [recording, setRecording] = useState(false);
  return (
    <button
      type="button"
      className={`hotkey-box${recording ? " recording" : ""}`}
      disabled={disabled}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return setRecording(false);
        const accel = acceleratorFrom(e);
        if (accel) {
          setRecording(false);
          onChange(accel);
        }
      }}
      aria-label="录制快捷键"
    >
      <Keyboard size={14} />
      <span className="mono truncate">{recording ? "按下组合键（至少带一个修饰键，Esc 取消）" : prettyHotkey(value)}</span>
    </button>
  );
}

/** Settings pane body and onboarding step for Xiaoyang voice wake & local DSP (config.json voiceInput.*). */
export function VoiceInputSetup({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const cfg = useClientConfig().voiceInput;
  const server = settingsStore.use((s) => s.server);
  const assistantVoice = assistantStore.use((s) => s.voice);
  const callStatus = voiceCallStore.use((s) => s.status);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [runtime, setRuntime] = useState<VoiceRuntime | null>(null);
  const [checking, setChecking] = useState(false);
  const [hotkeyNote, setHotkeyNote] = useState<{ error?: boolean; text: string } | null>(null);
  const [keyboardGuideOpen, setKeyboardGuideOpen] = useState(false);
  const [aiState, setAiState] = useState<VoiceAiState | null>(null);
  const [vpModalOpen, setVpModalOpen] = useState(false);
  const refreshingRef = useRef(false);
  const singleKey = isModifierKey(cfg.hotkey);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setChecking(true);
    try {
      const [p, r, ai] = await Promise.all([
        native.getPermissions(),
        native.getVoiceRuntime(),
        native.voiceAiState().catch(() => null),
      ]);
      setPerms(p);
      setRuntime(r);
      if (ai) setAiState(ai);
    } finally {
      refreshingRef.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (server && !isMockServer(server) && !assistantStore.get().loaded) {
      void loadAssistant().catch(() => {});
    }
  }, [refresh, server]);

  useEffect(() => {
    const syncOnReturn = () => {
      void native.voiceReload().finally(refresh);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") syncOnReturn();
    };
    window.addEventListener("focus", syncOnReturn);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", syncOnReturn);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    return native.onVoiceAiProgress((ev) => {
      setAiState((cur) =>
        cur
          ? {
              ...cur,
              downloading: ev.downloading,
              progress: ev.progress,
              dlLabel: ev.dlLabel ?? null,
              dlError: ev.dlError ?? null,
            }
          : cur,
      );
      if (!ev.downloading && ev.done) {
        void native.voiceAiState().then(setAiState);
      }
    });
  }, []);

  const updateAiConfig = async (patch: VoiceAiConfigPatch) => {
    try {
      const next = await native.voiceAiSetConfig(patch);
      setAiState(next);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const selectAiTier = async (nextTier: VoiceAiTier) => {
    try {
      const next = await native.voiceAiSetConfig({ tier: nextTier });
      setAiState(next);
      if (nextTier === "sv" && !next.svReady) {
        setAiState(await native.voiceAiDownload("sv"));
      } else if (nextTier === "tse" && (!next.svReady || !next.tseReady)) {
        setAiState(await native.voiceAiDownload("tse"));
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (!/取消/.test(msg)) toast(msg, true);
      void native.voiceAiState().then(setAiState);
    }
  };

  const set = async (key: string, value: boolean | number | string) => {
    try {
      await setConfig(`voiceInput.${key}`, value);
      if (key === "hotkey" || key === "enabled") void refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  /** Asks the native side first (syntax, taken by another app, permission), then saves. */
  const setHotkey = async (value: string) => {
    setHotkeyNote(null);
    const check = await native.checkHotkey(value);
    if (check && !check.ok) {
      setHotkeyNote({ error: true, text: check.error || "这个快捷键用不了，换一个试试。" });
      return;
    }
    await set("hotkey", value);
    const notes = [check?.warning, check?.needsPermission === "inputMonitoring" ? "还需要打开下面的“输入监控”权限。" : ""].filter(Boolean);
    setHotkeyNote(notes.length ? { text: notes.join(" ") } : null);
    toast(`唤醒快捷键已设为 ${prettyHotkey(value)}`);
  };

  const supported = runtime ? runtime.supported : null;
  const editable = DESKTOP_VOICE;
  const runtimeProblem = runtime && cfg.enabled ? runtime.error || runtime.lastError : null;
  const fnTip = MAC && cfg.hotkey === "Fn" && perms?.fnKeyAction && perms.fnKeyAction !== "none";
  const keys = MODIFIER_KEYS.filter((m) => (MAC ? m.mac : m.win));
  const callActive = callStatus === "connecting" || callStatus === "ready";
  const realtimeReady = Boolean(assistantVoice || (server && isMockServer(server)));

  return (
    <div className="stack" style={{ gap: compact ? 12 : 4 }}>
      {compact ? (
        <div className="muted">
          在任何应用里按一下 <span className="kbd">{prettyHotkey(cfg.hotkey)}</span> 即可悬浮唤起小羊实时语音通话，再按一次挂断。
        </div>
      ) : null}

      {!DESKTOP_VOICE ? (
        <div className="inline-alert soft">
          <Mic size={16} />
          <span>全局快捷键唤醒小羊目前只支持 macOS 和 Windows 桌面版。</span>
        </div>
      ) : !native.voiceSupported() ? (
        <div className="inline-alert soft">
          <Mic size={16} />
          <span>全局快捷键唤醒小羊需要 Herdr Pocket 桌面版；这里的设置会先保存。</span>
        </div>
      ) : supported === false ? (
        <div className="inline-alert soft">
          <Mic size={16} />
          <span>这台电脑的系统还不支持全局唤醒快捷键。</span>
        </div>
      ) : null}

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.enabled")?.label ?? "快捷键唤醒小羊"}</div>
          <div className="set-about">在后台监听全局快捷键，按一下唤起或挂断小羊通话</div>
        </div>
        <PocketSwitch checked={cfg.enabled} disabled={!editable} onCheckedChange={(v) => void set("enabled", v)} label="快捷键唤醒小羊" />
      </div>

      <div className="set-row column-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.hotkey")?.label ?? "唤醒快捷键"}</div>
          <div className="set-about">
            {MAC ? "推荐单按右 Option（按一下开启对话，再按挂断）" : "推荐单按右 Ctrl（按一下开启对话，再按挂断）"}
            {runtimeProblem ? <span className="err-text"> {runtimeProblem}</span> : null}
            {runtime?.warning && cfg.enabled ? <span className="faint"> {runtime.warning}</span> : null}
            {hotkeyNote ? <span className={hotkeyNote.error ? "err-text" : "faint"}> {hotkeyNote.text}</span> : null}
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
          <div className="segmented">
            <button
              className={singleKey ? "active" : ""}
              disabled={!editable}
              onClick={() => !singleKey && void setHotkey(RECOMMENDED_KEY)}
            >
              单按一个键
            </button>
            <button
              className={!singleKey ? "active" : ""}
              disabled={!editable}
              onClick={() => singleKey && void setHotkey(DEFAULT_COMBO)}
            >
              组合键
            </button>
          </div>
          {singleKey ? (
            <PocketSelect
              value={cfg.hotkey}
              onValueChange={(v) => void setHotkey(v)}
              options={keys.map((m) => ({ value: m.value, label: m.value === RECOMMENDED_KEY ? `${m.label}（推荐）` : m.label }))}
            />
          ) : (
            <HotkeyRecorder value={cfg.hotkey} disabled={!editable} onChange={(v) => void setHotkey(v)} />
          )}
        </div>
      </div>
      {fnTip ? (
        <div className="inline-alert">
          <span className="grow">用 Fn 键唤醒前，先把“按下地球仪键时”改成“不执行任何操作”，否则按 Fn 会切换输入法或弹出表情。</span>
          <PocketButton
            size="sm"
            variant="soft"
            onClick={() => {
              setKeyboardGuideOpen(true);
              void native.openPermissionSettings("keyboard", true);
            }}
          >
            去调整设置
          </PocketButton>
        </div>
      ) : null}
      <PermissionGuideModal
        kind="keyboard"
        open={keyboardGuideOpen}
        onOpenChange={setKeyboardGuideOpen}
        perms={perms}
        onRefresh={refresh}
      />

      {!compact ? (
        <>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">{configKeySpec("voiceInput.sounds")?.label ?? "通话提示音"}</div>
              <div className="set-about">接通或出现提示时播放轻柔音效</div>
            </div>
            <PocketSwitch checked={cfg.sounds} disabled={!editable} onCheckedChange={(v) => void set("sounds", v)} label="通话提示音" />
          </div>

          <div className="set-row">
            <div className="set-text">
              <div className="set-title">悬浮小羊通话</div>
              <div className="set-about">
                {callActive
                  ? "正在与小羊实时通话中，可从悬浮胶囊或此处随时挂断"
                  : realtimeReady
                    ? "立即呼出悬浮胶囊并接通小羊实时语音"
                    : "连上中转服务器并开启小羊实时语音模型后可用"}
              </div>
            </div>
            <div className="set-control">
              <PocketButton
                size="sm"
                variant={callActive ? "danger" : "primary"}
                disabled={!callActive && !realtimeReady}
                onClick={() => {
                  if (callActive) {
                    hangupVoiceCall();
                  } else {
                    void startVoiceCall({ showHud: true }).then((err) => {
                      if (err) {
                        toast(err, true);
                        dismissVoiceMessage();
                      }
                    });
                  }
                }}
              >
                {callActive ? <PhoneOff size={14} /> : <PhoneCall size={14} />}
                <span>{callActive ? "挂断通话" : "立即唤起小羊"}</span>
              </PocketButton>
            </div>
          </div>

          {aiState ? (
            <>
              <div className="set-heading">本地音频增强与声纹</div>

              <div className="set-row">
                <div className="set-text">
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className="set-title">语音降噪与人声增强</span>
                    <PocketBadge tone={aiState.ortReady && aiState.dpdfReady ? "mint" : "lav"}>
                      {aiState.ortReady && aiState.dpdfReady ? "DPDFNet + Silero VAD" : "纯 Rust DSP"}
                    </PocketBadge>
                  </div>
                  <div className="set-about">本地实时降噪与频段增强，不上传原始环境音</div>
                </div>
                <div className="set-control">
                  <PocketSwitch
                    checked={aiState.denoise}
                    onCheckedChange={(v) => void updateAiConfig({ denoise: v })}
                    label="语音降噪与人声增强"
                  />
                </div>
              </div>

              <div className="set-row">
                <div className="set-text">
                  <div className="set-title">人声清晰度增强</div>
                  <div className="set-about">1.5–3.8 kHz 谐波增强与柔和限幅</div>
                </div>
                <div className="set-control">
                  <PocketSwitch
                    checked={aiState.enhanceVocal}
                    onCheckedChange={(v) => void updateAiConfig({ enhanceVocal: v })}
                    label="人声清晰度增强"
                  />
                </div>
              </div>

              <div className="set-row">
                <div className="set-text">
                  <div className="set-title">声纹与人声分离档位</div>
                  <div className="set-about">
                    {aiState.downloading
                      ? `正在准备 ${aiState.dlLabel ?? "模型"} · ${Math.round(aiState.progress * 100)}%`
                      : aiState.dlError
                        ? aiState.dlError
                        : aiState.recommendReason || "自动按本机算力匹配声纹模型"}
                  </div>
                </div>
                <div className="set-control" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <PocketSelect
                    ariaLabel="声纹与人声分离档位"
                    value={aiState.tier}
                    disabled={aiState.downloading}
                    onValueChange={(v) => void selectAiTier(v as VoiceAiTier)}
                    options={[
                      {
                        value: "auto",
                        label: "自动推荐",
                        badge:
                          aiState.recommendedTier === "tse"
                            ? "旗舰"
                            : aiState.recommendedTier === "sv"
                              ? "灵巧"
                              : undefined,
                      },
                      { value: "sv", label: "灵巧声纹 · ERes2NetV2", badge: `${aiState.svSizeMb} MB` },
                      { value: "tse", label: "旗舰声纹分离 · VoxLock v2", badge: `${aiState.tseSizeMb} MB` },
                      { value: "denoise", label: "仅降噪与人声增强" },
                    ]}
                  />
                  {aiState.downloading ? (
                    <PocketButton
                      size="sm"
                      variant="ghost"
                      onClick={() => void native.voiceAiCancelDownload().then(() => native.voiceAiState().then(setAiState))}
                    >
                      取消
                    </PocketButton>
                  ) : null}
                </div>
              </div>

              <div className="set-row">
                <div className="set-text">
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className="set-title">只认我的声音</span>
                    <PocketBadge tone={aiState.enrolled ? (aiState.filter ? "mint" : "neutral") : "neutral"}>
                      {aiState.enrolled
                        ? aiState.filter
                          ? `已开启 · ${aiState.enrollSeconds.toFixed(1)}s`
                          : "已录入"
                        : "未录入"}
                    </PocketBadge>
                  </div>
                  <div className="set-about">仅保留本人声音，忽略周围旁人说话</div>
                </div>
                <div className="set-control" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {aiState.enrolled ? (
                    <PocketSwitch
                      checked={aiState.filter}
                      onCheckedChange={(v) => void updateAiConfig({ filter: v })}
                      label="只认我的声音"
                    />
                  ) : null}
                  <PocketButton
                    size="sm"
                    variant={aiState.enrolled ? "soft" : "primary"}
                    onClick={() => setVpModalOpen(true)}
                  >
                    {aiState.enrolled ? "管理声纹" : "录入与测试"}
                  </PocketButton>
                </div>
              </div>

              <VoiceprintModal
                open={vpModalOpen}
                onOpenChange={setVpModalOpen}
                aiState={aiState}
                onStateChange={setAiState}
              />
            </>
          ) : null}
        </>
      ) : null}

      <div className="set-heading">系统权限</div>
      {DESKTOP_VOICE && !perms && native.available() ? <div className="faint">没读到权限状态，按下面的路径手动检查。</div> : null}
      <PermissionCards perms={perms} checking={checking} singleKey={singleKey} onChanged={() => void refresh()} />
    </div>
  );
}

function WebVoiceHudLevel() {
  const micLevel = voiceCallStore.use((s) => s.micLevel);
  const outLevel = voiceCallStore.use((s) => s.outLevel);
  const level = Math.max(0, Math.min(1, Math.max(micLevel, outLevel)));
  return (
    <span className="hud-level" aria-hidden>
      <span style={{ transform: `scaleX(${Math.max(0.08, level)})` }} />
    </span>
  );
}

function WebVoiceHud() {
  const hidden = useWindowHidden();
  const status = voiceCallStore.use((s) => s.status);
  const hudShown = voiceCallStore.use((s) => s.hudShown);
  const muted = voiceCallStore.use((s) => s.muted);
  const assistant = voiceCallStore.use((s) => s.assistant);

  if (hidden || !hudShown || status === "idle") return null;

  const label =
    status === "connecting"
      ? "正在接通小羊…"
      : muted && assistant !== "speaking"
        ? "麦克风已静音"
        : assistant === "speaking"
          ? "小羊正在说…"
          : assistant === "thinking"
            ? "小羊在想…"
            : "和小羊通话中";
  const mood = resolveCallMascotMood({ status, assistant, muted });

  return (
    <div className="voice-hud listening" role="status" aria-live="polite">
      <XiaoyangOrb mood={mood} size={28} />
      <span className="truncate">{label}</span>
      <WebVoiceHudLevel />
      <PocketIconButton
        size="sm"
        active={muted}
        tooltip={muted ? "取消静音" : "静音"}
        onClick={() => setVoiceMuted(!muted)}
      >
        {muted ? <MicOff size={14} /> : <Mic size={14} />}
      </PocketIconButton>
      <PocketButton size="sm" variant="danger" onClick={() => hangupVoiceCall()}>
        <PhoneOff size={13} />
        <span>挂断</span>
      </PocketButton>
    </div>
  );
}

/** In-app floating call capsule fallback for web / HarmonyOS builds (suppressed on Tauri desktop). */
export function VoiceHud() {
  if (native.available()) return null;
  return <WebVoiceHud />;
}
