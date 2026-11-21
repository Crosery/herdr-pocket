import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ExternalLink, Keyboard, Mic, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { configKeySpec, type TranscribeInfo } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketSelect, PocketSwitch, PocketTextarea, useToast } from "./PocketUI";
import { PermissionGuideModal } from "./PermissionGuideModal";
import { copyToClipboard, detectPlatform, voiceStart, voiceStop } from "../lib/bridge";
import { native, type Permission, type PermissionKind, type Permissions, type VoiceEvent, type VoiceRuntime } from "../lib/native";
import { setConfig, useClientConfig } from "../lib/config";
import { getActiveToken, restRequest } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { liveStore, settingsStore } from "../lib/store";
import { useWindowHidden } from "../lib/layout";
import { SOTA_ASR_RECOMMENDATIONS } from "../lib/voicePresets";
import { openSettingsFrame } from "../shell/shellStore";
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

/** One modifier held alone (voiceInput.hotkey); macOS reads these through Input Monitoring. */
const MODIFIER_KEYS: Array<{ value: string; label: string; mac: boolean; win: boolean }> = [
  { value: "RightOption", label: MAC ? "右 ⌥ Option" : "右 Alt", mac: true, win: false },
  { value: "RightControl", label: MAC ? "右 ⌃ Control" : "右 Ctrl", mac: true, win: true },
  { value: "RightCommand", label: "右 ⌘ Command", mac: true, win: false },
  { value: "RightShift", label: MAC ? "右 ⇧ Shift" : "右 Shift", mac: true, win: true },
  { value: "Fn", label: "Fn（地球仪键）", mac: true, win: false },
];
const DEFAULT_COMBO = "CommandOrControl+Shift+Space";
/** Recommended hold-to-talk key: right Option on macOS; right Ctrl on Windows (right Alt is AltGr on many layouts). */
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
    why: "用于语音输入与小羊通话",
    how: MAC ? "系统设置 › 隐私与安全性 › 麦克风" : "设置 › 隐私和安全性 › 麦克风",
  },
  accessibility: {
    title: "辅助功能",
    why: "识别后自动上屏，仅复制可不开启",
    how: "系统设置 › 隐私与安全性 › 辅助功能",
  },
  inputMonitoring: {
    title: "输入监控",
    why: "仅单键按住说话需要",
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
  denied: { tone: "blush", text: "未允许" },
  notDetermined: { tone: "warn", text: "还没问过" },
  restricted: { tone: "blush", text: "被系统策略限制" },
  notApplicable: { tone: "neutral", text: "不需要" },
  unknown: { tone: "neutral", text: "无法检测" },
};

const DEMO_PERMS: Permissions = {
  platform: MAC ? "macos" : "windows",
  microphone: "granted",
  accessibility: "denied",
  inputMonitoring: "granted",
  fullDiskAccess: "denied",
  appBundlePath: "/Applications/Herdr Pocket.app",
  notes: [],
};

export function PermissionCards({
  perms,
  onChanged,
  checking,
  singleKey = false,
}: {
  perms: Permissions | null;
  onChanged: () => void;
  checking: boolean;
  /** The hotkey is one modifier held alone: Input Monitoring is needed (macOS). */
  singleKey?: boolean;
}) {
  const toast = useToast();
  const [guideKind, setGuideKind] = useState<PermissionKind | null>(null);
  const effectivePerms = perms ?? (!native.available() ? DEMO_PERMS : null);
  const kinds: Array<"microphone" | "accessibility" | "inputMonitoring"> = MAC
    ? ["microphone", "accessibility", "inputMonitoring"]
    : ["microphone"];

  const jumpAndGuide = async (k: PermissionKind, state: Permission) => {
    setGuideKind(k);
    if (!native.available()) return;
    try {
      if (k === "microphone" && state === "notDetermined") {
        const next = await native.requestPermission(k);
        onChanged();
        if (next.microphone === "granted") {
          setGuideKind(null);
          return;
        }
      }
      await native.openPermissionSettings(k, true);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <div className="perm-grid">
        {kinds.map((k) => {
          const info = PERMISSION_INFO[k];
          const state: Permission = effectivePerms ? effectivePerms[k] : "unknown";
          if (state === "notApplicable") return null;
          const label = PERM_LABEL[state];
          const done = state === "granted";
          return (
            <div key={k} className={`perm-card${state === "denied" || state === "restricted" ? " warn" : ""}`}>
              <div className="between" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8, minWidth: 0 }}>
                  <ShieldCheck size={16} />
                  <strong>{info.title}</strong>
                </div>
                <div className="row" style={{ gap: 6, flex: "none" }}>
                  <PocketBadge tone={label.tone}>{label.text}</PocketBadge>
                  {done ? (
                    <button
                      type="button"
                      className="v3-icon-btn small"
                      aria-label={`打开${info.title}授权引导`}
                      title={`打开${info.title}授权引导与系统设置`}
                      onClick={() => setGuideKind(k)}
                    >
                      <Settings2 size={13} />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="faint">
                {info.why}
                {k === "inputMonitoring" && !singleKey ? "（当前使用组合键可不开；改用右 Option / Fn 单键时开启）" : ""}
              </div>
              <button
                type="button"
                className="perm-path-link"
                title="点击直达系统设置对应位置并查看拖拽引导"
                onClick={() => void jumpAndGuide(k, state)}
              >
                <span className="truncate">{info.how}</span>
                <ExternalLink size={12} style={{ flex: "none" }} />
              </button>
              {!done ? (
                <div className="row wrap" style={{ gap: 6 }}>
                  <PocketButton size="sm" variant="primary" onClick={() => void jumpAndGuide(k, state)}>
                    <ExternalLink size={13} />
                    <span>{state === "notDetermined" ? "去授权" : "去开启"}</span>
                  </PocketButton>
                  <PocketButton size="sm" variant="soft" onClick={() => setGuideKind(k)}>
                    <span>{MAC ? "拖拽引导" : "查看引导"}</span>
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="ghost"
                    disabled={checking}
                    onClick={() => {
                      // A permission granted just now: let the native side retry the hotkey too.
                      void native.voiceReload().finally(onChanged);
                    }}
                  >
                    <RefreshCw size={13} />
                    <span>重新检测</span>
                  </PocketButton>
                </div>
              ) : null}
            </div>
          );
        })}
        {effectivePerms?.notes.length ? <div className="faint">{effectivePerms.notes.join(" ")}</div> : null}
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

/** Can the relay turn speech into text (GET /v1/transcribe)? The desktop app asks natively. */
function useTranscribeInfo(): { info: TranscribeInfo | null; error: string | null } {
  const server = settingsStore.use((s) => s.server);
  const link = liveStore.use((s) => s.link);
  const [info, setInfo] = useState<TranscribeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const token = getActiveToken();
    if (!server || isMockServer(server) || !token) return;
    let alive = true;
    const ask = native.available()
      ? native.getTranscribeInfo().then((r) => {
          if (!r) throw new Error("没有拿到结果");
          return r as unknown as TranscribeInfo;
        })
      : restRequest<TranscribeInfo>(server, "/v1/transcribe", { token, timeoutMs: 6000 });
    ask.then((r) => alive && (setInfo(r), setError(null))).catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [server, link === "online"]);
  return { info, error };
}

/** Settings pane body and onboarding step for quick voice input (config.json voiceInput.*). */
export function VoiceInputSetup({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const cfg = useClientConfig().voiceInput;
  const server = settingsStore.use((s) => s.server);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [runtime, setRuntime] = useState<VoiceRuntime | null>(null);
  const [checking, setChecking] = useState(false);
  const [trial, setTrial] = useState("");
  const [hotkeyNote, setHotkeyNote] = useState<{ error?: boolean; text: string } | null>(null);
  const [keyboardGuideOpen, setKeyboardGuideOpen] = useState(false);
  const [selectedAsrRec, setSelectedAsrRec] = useState(SOTA_ASR_RECOMMENDATIONS[0]?.id ?? "");
  const { info, error: infoError } = useTranscribeInfo();
  const singleKey = isModifierKey(cfg.hotkey);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const [p, r] = await Promise.all([native.getPermissions(), native.getVoiceRuntime()]);
      setPerms(p);
      setRuntime(r);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    toast(`快捷键改成了 ${prettyHotkey(value)}`);
  };

  const supported = runtime ? runtime.supported : null;
  const editable = DESKTOP_VOICE;
  const engine = !server
    ? { tone: "neutral" as const, text: "连上中转服务器后可用" }
    : isMockServer(server)
      ? { tone: "neutral" as const, text: "演示模式不识别" }
      : info?.available
        ? { tone: "mint" as const, text: `可以识别 · ${info.provider ?? ""}${info.model ? ` / ${info.model}` : ""}` }
        : info
          ? { tone: "blush" as const, text: info.reason || "服务器还没配置语音识别" }
          : infoError
            ? { tone: "warn" as const, text: `查不到：${infoError}` }
            : { tone: "neutral" as const, text: "检查中…" };
  const runtimeProblem = runtime && cfg.enabled ? runtime.error || runtime.lastError : null;
  const fnTip = MAC && cfg.hotkey === "Fn" && perms?.fnKeyAction && perms.fnKeyAction !== "none";
  const keys = MODIFIER_KEYS.filter((m) => (MAC ? m.mac : m.win));

  return (
    <div className="stack" style={{ gap: compact ? 12 : 4 }}>
      {compact ? (
        <div className="muted">
          和豆包、微信的语音输入一样：在任何应用里按住 <span className="kbd">{prettyHotkey(cfg.hotkey)}</span> 说话，松开后文字自动打进光标所在的位置。
        </div>
      ) : null}

      {!DESKTOP_VOICE ? (
        <div className="inline-alert soft">
          <Mic size={16} />
          <span>语音输入目前只支持 macOS 和 Windows 桌面版。</span>
        </div>
      ) : !native.voiceSupported() ? (
        <div className="inline-alert soft">
          <Mic size={16} />
          <span>语音输入需要 Herdr Pocket 桌面版；这里的设置会先保存。</span>
        </div>
      ) : supported === false ? (
        <div className="inline-alert soft">
          <Mic size={16} />
          <span>这台电脑的系统还不支持语音输入。</span>
        </div>
      ) : null}

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">识别服务</div>
          <div className="set-about">经中转服务器识别，不留存录音</div>
        </div>
        <div className="set-control">
          <PocketBadge tone={engine.tone}>{engine.text}</PocketBadge>
        </div>
      </div>

      {!compact ? (
        <div className="set-row">
          <div className="set-text">
            <div className="set-title">推荐语音与识别模型</div>
            <div className="set-about">云端实时语音与本机 Apple Silicon MLX 预设</div>
          </div>
          <div className="row" style={{ gap: 8, alignItems: "center", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%" }}>
            <PocketSelect
              ariaLabel="推荐语音与识别模型"
              value={selectedAsrRec}
              onValueChange={setSelectedAsrRec}
              options={SOTA_ASR_RECOMMENDATIONS.map((rec) => ({
                value: rec.id,
                label: `${rec.model} · ${rec.vendor}`,
                badge: rec.badge,
              }))}
            />
            <PocketButton size="sm" variant="soft" style={{ flexShrink: 0 }} onClick={() => openSettingsFrame("assistant")}>
              去配置
            </PocketButton>
          </div>
        </div>
      ) : null}

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.enabled")?.label}</div>
          <div className="set-about">在后台监听全局快捷键</div>
        </div>
        <PocketSwitch checked={cfg.enabled} disabled={!editable} onCheckedChange={(v) => void set("enabled", v)} label="语音输入" />
      </div>

      <div className="set-row column-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.hotkey")?.label}</div>
          <div className="set-about">
            {MAC ? "推荐单按右 Option，按住说、松开上屏" : "推荐单按右 Ctrl，按住说、松开上屏"}
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
              按住一个键
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
          <span className="grow">用 Fn 说话前，先把“按下地球仪键时”改成“不执行任何操作”，否则按 Fn 会切换输入法或弹出表情。</span>
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

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.mode")?.label}</div>
          <div className="set-about">按住松开即停，或点按开始/结束</div>
        </div>
        <div className="segmented">
          <button className={cfg.mode === "hold" ? "active" : ""} disabled={!editable} onClick={() => void set("mode", "hold")}>按住说话</button>
          <button className={cfg.mode === "toggle" ? "active" : ""} disabled={!editable} onClick={() => void set("mode", "toggle")}>按一下</button>
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.insert")?.label}</div>
          <div className="set-about">粘贴需辅助功能权限；逐字输入不占剪贴板</div>
        </div>
        <PocketSelect
          value={cfg.insert}
          onValueChange={(v) => void set("insert", v)}
          options={[
            { value: "paste", label: "粘贴到光标处" },
            { value: "type", label: "逐字输入" },
            { value: "clipboard", label: "只复制" },
          ]}
        />
      </div>
      {!compact ? (
        <>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">{configKeySpec("voiceInput.language")?.label}</div>
              <div className="set-about">中英混说选“自动”</div>
            </div>
            <PocketSelect
              value={["auto", "zh", "en"].includes(cfg.language) ? cfg.language : "auto"}
              onValueChange={(v) => void set("language", v)}
              options={[
                { value: "auto", label: "自动" },
                { value: "zh", label: "中文" },
                { value: "en", label: "英文" },
              ]}
            />
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">{configKeySpec("voiceInput.maxSeconds")?.label}</div>
              <div className="set-about">5–300 秒自动结束</div>
            </div>
            <PocketSelect
              value={String(cfg.maxSeconds)}
              onValueChange={(v) => void set("maxSeconds", Number(v))}
              options={[...new Set([15, 30, 60, 120, 300, cfg.maxSeconds])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${n} 秒` }))}
            />
          </div>
          <div className="set-row">
            <div className="set-text">
              <div className="set-title">{configKeySpec("voiceInput.sounds")?.label}</div>
              <div className="set-about">起止提示音</div>
            </div>
            <PocketSwitch checked={cfg.sounds} disabled={!editable} onCheckedChange={(v) => void set("sounds", v)} label="提示音" />
          </div>
        </>
      ) : null}

      <div className="set-heading">系统权限</div>
      {DESKTOP_VOICE && !perms && native.available() ? <div className="faint">没读到权限状态，按下面的路径手动检查。</div> : null}
      <PermissionCards perms={perms} checking={checking} singleKey={singleKey} onChanged={() => void refresh()} />

      {native.voiceSupported() && supported !== false && cfg.enabled && !compact ? (
        <>
          <div className="set-heading">试一试</div>
          <PocketTextarea rows={2} value={trial} onChange={(e) => setTrial(e.target.value)} placeholder={`点这里，然后按 ${prettyHotkey(cfg.hotkey)} 说一句话`} />
        </>
      ) : null}
    </div>
  );
}

let lastVoiceTarget: { el: HTMLInputElement | HTMLTextAreaElement; start: number | null; end: number | null } | null = null;
let lastVoiceTerminal = false;
let focusTrackerInstalled = false;

function isTextEditableElement(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled;
  if (el.tagName === "INPUT") {
    const inp = el as HTMLInputElement;
    return !inp.readOnly && !inp.disabled && /^(text|search|url|email|tel|password|)$/i.test(inp.type);
  }
  return false;
}

function installFocusTracker(): void {
  if (focusTrackerInstalled || typeof document === "undefined") return;
  focusTrackerInstalled = true;
  const record = (target: EventTarget | null) => {
    const el = target instanceof HTMLElement ? target : (document.activeElement as HTMLElement | null);
    if (!el || el.closest("[data-voice-trigger]")) return;
    if (el.closest(".xterm-helper-textarea, .tp-term-wrap")) {
      lastVoiceTerminal = true;
      lastVoiceTarget = null;
      return;
    }
    if (isTextEditableElement(el)) {
      lastVoiceTerminal = false;
      lastVoiceTarget = { el, start: el.selectionStart, end: el.selectionEnd };
    }
  };
  document.addEventListener("focusin", (e) => record(e.target), true);
  document.addEventListener("keyup", (e) => record(e.target), true);
  document.addEventListener("mouseup", (e) => record(e.target), true);
}

function setNativeControlValue(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const start = el.selectionStart ?? lastVoiceTarget?.start ?? el.value.length;
  const end = el.selectionEnd ?? lastVoiceTarget?.end ?? el.value.length;
  const nextVal = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
  if (setter) setter.call(el, nextVal);
  else el.value = nextVal;
  el.focus();
  const caret = start + text.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* some input types do not expose selection range */
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  if (lastVoiceTarget?.el === el) {
    lastVoiceTarget.start = caret;
    lastVoiceTarget.end = caret;
  }
}

/**
 * Dictation finished while Herdr Pocket had the focus (target "app"): inserts into the active
 * or last focused composer/input/terminal; falls back to clipboard when none is available.
 */
function insertIntoApp(text: string, onCopied: () => void): void {
  const active = document.activeElement as HTMLElement | null;
  if (active?.closest(".xterm-helper-textarea, .tp-term-wrap") || (!isTextEditableElement(active) && !active?.isContentEditable && lastVoiceTerminal)) {
    window.dispatchEvent(new CustomEvent("pocket:voice-term-input", { detail: { text } }));
    return;
  }
  const target = isTextEditableElement(active)
    ? active
    : lastVoiceTarget?.el.isConnected
      ? lastVoiceTarget.el
      : null;
  if (target) {
    setNativeControlValue(target, text);
    return;
  }
  if (active?.isContentEditable && document.execCommand("insertText", false, text)) return;
  void copyToClipboard(text).then((ok) => ok && onCopied());
}

/** Shared microphone toggle button rendered inside message composers. */
export function VoiceMicButton({ className = "composer-tool-btn" }: { className?: string }) {
  const voice = useClientConfig().voiceInput;
  const [phase, setPhase] = useState<"listening" | "transcribing" | "idle">("idle");

  useEffect(() => {
    installFocusTracker();
    return native.onVoiceEvent((e) => {
      if (e.state === "listening") setPhase("listening");
      else if (e.state === "transcribing") setPhase("transcribing");
      else setPhase("idle");
    });
  }, []);

  if (!native.available() || !native.voiceSupported() || !voice.enabled) return null;

  const busy = phase === "listening" || phase === "transcribing";
  const label =
    phase === "listening"
      ? "正在听，点击结束并填入文字"
      : phase === "transcribing"
        ? "正在识别语音…"
        : `语音输入（${prettyHotkey(voice.hotkey)}）`;

  return (
    <button
      type="button"
      data-voice-trigger="true"
      className={`${className}${busy ? " active" : ""}`}
      aria-label={label}
      aria-pressed={phase === "listening"}
      title={label}
      disabled={phase === "transcribing"}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (phase === "listening") void voiceStop();
        else if (phase === "idle") void voiceStart();
      }}
    >
      <Mic size={16} />
    </button>
  );
}

/** In-app mirror of the native dictation HUD (suppressed on Tauri desktop where floating capsule renders). */
export function VoiceHud() {
  const hidden = useWindowHidden();
  const toast = useToast();
  const [ev, setEv] = useState<VoiceEvent>({ state: "idle" });
  useEffect(() => {
    installFocusTracker();
    return native.onVoiceEvent((e) => {
      if (e.state === "inserted" && e.target === "app" && e.text) insertIntoApp(e.text, () => toast("识别结果已复制，点输入框粘贴"));
      setEv(e);
    });
  }, [toast]);
  useEffect(() => {
    if (ev.state !== "inserted" && ev.state !== "error") return;
    const t = setTimeout(() => setEv({ state: "idle" }), ev.state === "error" ? 4000 : 1500);
    return () => clearTimeout(t);
  }, [ev]);
  // Native Tauri window displays the standalone glass floating HUD capsule; avoid double overlay.
  if (native.available() || hidden || ev.state === "idle") return null;
  const text =
    ev.state === "listening"
      ? "在听…"
      : ev.state === "transcribing"
        ? "识别中…"
        : ev.state === "inserted"
          ? `已输入：${(ev.text ?? "").slice(0, 20)}${(ev.text ?? "").length > 20 ? "…" : ""}`
          : ev.error || "没听清，再试一次";
  return (
    <div className={`voice-hud ${ev.state}`} role="status" aria-live="polite">
      <Mic size={15} />
      {ev.state === "listening" ? (
        <span className="hud-level" aria-hidden>
          <span style={{ transform: `scaleX(${Math.max(0.08, Math.min(1, ev.level ?? 0))})` }} />
        </span>
      ) : null}
      <span className="truncate">{text}</span>
    </div>
  );
}
