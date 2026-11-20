import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Keyboard, Mic, RefreshCw, ShieldCheck } from "lucide-react";
import { configKeySpec, type TranscribeInfo } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketSelect, PocketSwitch, PocketTextarea, useToast } from "./PocketUI";
import { copyToClipboard, detectPlatform } from "../lib/bridge";
import { native, type Permission, type PermissionKind, type Permissions, type VoiceEvent, type VoiceRuntime } from "../lib/native";
import { setConfig, useClientConfig } from "../lib/config";
import { getActiveToken, restRequest } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { liveStore, settingsStore } from "../lib/store";
import { useWindowHidden } from "../lib/layout";

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
    why: "听你说话。没有它，语音输入和小羊通话都用不了。",
    how: MAC ? "系统设置 › 隐私与安全性 › 麦克风，打开 Herdr Pocket" : "设置 › 隐私和安全性 › 麦克风：打开“麦克风访问权限”和“让桌面应用访问你的麦克风”",
  },
  accessibility: {
    title: "辅助功能",
    why: "把识别出的文字打进你正在用的应用（微信、浏览器、编辑器）。只复制到剪贴板可以不开。",
    how: "系统设置 › 隐私与安全性 › 辅助功能，打开 Herdr Pocket",
  },
  inputMonitoring: {
    title: "输入监控",
    why: "只有“按住一个键说话”需要：用来知道你什么时候按下、松开这个键。用组合键可以不开。",
    how: "系统设置 › 隐私与安全性 › 输入监控，打开 Herdr Pocket",
  },
  keyboard: {
    title: "地球仪键（Fn）",
    why: "用 Fn 说话时，系统不能再拿这个键切换输入法或弹出表情。",
    how: "系统设置 › 键盘 › “按下地球仪键时”，选“不执行任何操作”",
  },
  fullDiskAccess: {
    title: "完全磁盘访问",
    why: "读取 Safari 的 Cookie 需要。",
    how: "系统设置 › 隐私与安全性 › 完全磁盘访问权限，打开 Herdr Pocket",
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
  const kinds: Array<"microphone" | "accessibility" | "inputMonitoring"> = MAC
    ? ["microphone", "accessibility", ...(singleKey ? (["inputMonitoring"] as const) : [])]
    : ["microphone"];
  const open = async (k: PermissionKind, state: Permission) => {
    try {
      // Never asked: the system prompt is quicker than a trip to Settings.
      if (state === "notDetermined") {
        await native.requestPermission(k);
        onChanged();
      } else {
        await native.openPermissionSettings(k);
      }
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="perm-grid">
      {kinds.map((k) => {
        const info = PERMISSION_INFO[k];
        const state: Permission = perms ? perms[k] : "unknown";
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
              <PocketBadge tone={label.tone}>{label.text}</PocketBadge>
            </div>
            <div className="faint">{info.why}</div>
            {!done ? <div className="perm-how">{info.how}</div> : null}
            {!done && perms ? (
              <div className="row wrap" style={{ gap: 6 }}>
                <PocketButton size="sm" variant="primary" onClick={() => void open(k, state)}>
                  {state === "notDetermined" ? "允许" : "去开启"}
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
                  <span>我已开启，重新检测</span>
                </PocketButton>
              </div>
            ) : null}
          </div>
        );
      })}
      {perms?.notes.length ? <div className="faint">{perms.notes.join(" ")}</div> : null}
    </div>
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
          <div className="set-about">声音发给你的中转服务器转成文字，服务器不保存录音和文字。不能识别时，请服务器管理员在后台配置。</div>
        </div>
        <PocketBadge tone={engine.tone}>{engine.text}</PocketBadge>
      </div>

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.enabled")?.label}</div>
          <div className="set-about">开启后在后台注册快捷键；关掉就完全不监听。</div>
        </div>
        <PocketSwitch checked={cfg.enabled} disabled={!editable} onCheckedChange={(v) => void set("enabled", v)} label="语音输入" />
      </div>

      <div className="set-row column-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.hotkey")?.label}</div>
          <div className="set-about">
            推荐“按住一个键说话”：{MAC ? "右边的 Option 键" : "右边的 Ctrl 键"}平时几乎用不到，按住就说，松开就打字。
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
          <PocketButton size="sm" variant="soft" onClick={() => void native.openPermissionSettings("keyboard")}>
            打开键盘设置
          </PocketButton>
        </div>
      ) : null}

      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.mode")?.label}</div>
          <div className="set-about">按住说话：按住快捷键说，松开结束。按一下：按一下开始，再按一下结束，适合说长段。</div>
        </div>
        <div className="segmented">
          <button className={cfg.mode === "hold" ? "active" : ""} disabled={!editable} onClick={() => void set("mode", "hold")}>按住说话</button>
          <button className={cfg.mode === "toggle" ? "active" : ""} disabled={!editable} onClick={() => void set("mode", "toggle")}>按一下</button>
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">{configKeySpec("voiceInput.insert")?.label}</div>
          <div className="set-about">粘贴：直接出现在光标处（需要辅助功能权限）。逐字输入：不经过剪贴板，适合不让粘贴的输入框。只复制：放进剪贴板，自己粘贴。</div>
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
              <div className="set-about">中英混说选“自动”。</div>
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
              <div className="set-about">说到这么久会自动结束，5 到 300 秒。</div>
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
              <div className="set-about">开始和结束时轻响一声。</div>
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

/**
 * Dictation finished while Herdr Pocket had the focus (target "app"): the text goes into the
 * focused text box here, like typing. It is never sent; with no text box it is copied instead.
 */
function insertIntoApp(text: string, onCopied: () => void): void {
  const el = document.activeElement as HTMLElement | null;
  const editable = el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && (el as HTMLInputElement).type === "text") || el.isContentEditable);
  if (editable && document.execCommand("insertText", false, text)) return;
  void copyToClipboard(text).then((ok) => ok && onCopied());
}

/** In-app mirror of the native dictation HUD; renders nothing when idle. */
export function VoiceHud() {
  const hidden = useWindowHidden();
  const toast = useToast();
  const [ev, setEv] = useState<VoiceEvent>({ state: "idle" });
  useEffect(
    () =>
      native.onVoiceEvent((e) => {
        if (e.state === "inserted" && e.target === "app" && e.text) insertIntoApp(e.text, () => toast("识别结果已复制，点输入框粘贴"));
        setEv(e);
      }),
    [toast],
  );
  useEffect(() => {
    if (ev.state !== "inserted" && ev.state !== "error") return;
    const t = setTimeout(() => setEv({ state: "idle" }), ev.state === "error" ? 4000 : 1500);
    return () => clearTimeout(t);
  }, [ev]);
  if (hidden || ev.state === "idle") return null;
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
