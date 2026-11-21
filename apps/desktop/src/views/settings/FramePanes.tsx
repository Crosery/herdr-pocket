import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Laptop, Monitor, Plus, QrCode, RefreshCw, Server, Smartphone, Trash2, Upload } from "lucide-react";
import { configKeySpec, type Device } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketInput, PocketSelect, useToast } from "../../components/PocketUI";
import { LocalHostDeps } from "../../components/LocalHostDeps";
import { PermissionCards, prettyHotkey } from "../../components/VoiceInput";
import { serverLabel } from "../../components/Sidebar";
import { copyToClipboard } from "../../lib/bridge";
import { partitionDevices, type ClassifiedDevice } from "../../lib/deviceRole";
import { buildTerminalFontFamily, ensureTerminalFontLoaded, useLocalHostDeviceId, useTerminalFontCatalog } from "../../lib/fonts";
import { native, type LogFolderInfo, type Permissions } from "../../lib/native";
import { setConfig, useClientConfig } from "../../lib/config";
import { isMockServer } from "../../lib/mock";
import { pingRelay } from "../../lib/relay";
import { liveStore, relTime, settingsStore } from "../../lib/store";
import { IS_MAC, SHORTCUTS, keyChips } from "../../shell/shortcuts";
import { openSettingsFrame } from "../../shell/shellStore";
import { RemoveDeviceDialog } from "../DevicesView";
import { ConfigSwitch, PaneTitle, SetHeading, SetRow } from "./rows";
import { SignOutBlock, StartupRows, ThemeRow, linkLabel, useHostdStatus } from "./Panes";

/** Key chips for one combo: ["⌘", "P"] or ["Ctrl", "P"]. */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="sf-keys">
      {keyChips(keys).map((k, i) => (
        <kbd key={i} className="sf-kbd">
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** − 110% + for general.textScale, in steps of 10 within the key's range (also used by the welcome). */
export function TextScaleStepper({ className = "sf-stepper" }: { className?: string }) {
  const toast = useToast();
  const value = useClientConfig().general.textScale;
  const spec = configKeySpec("general.textScale");
  const min = spec?.min ?? 80;
  const max = spec?.max ?? 160;
  const set = (v: number) => {
    const next = Math.min(max, Math.max(min, v));
    if (next !== value) void setConfig("general.textScale", next).catch((e: Error) => toast(e.message, true));
  };
  return (
    <div className={className} role="group" aria-label="文字大小">
      <button aria-label="缩小文字" disabled={value <= min} onClick={() => set(Math.ceil(value / 10) * 10 - 10)}>
        −
      </button>
      <output className="num" aria-live="polite">
        {value}%
      </output>
      <button aria-label="放大文字" disabled={value >= max} onClick={() => set(Math.floor(value / 10) * 10 + 10)}>
        +
      </button>
    </div>
  );
}

function TextScaleRow() {
  return (
    <SetRow title="文字大小" about="只影响这台电脑上的桌面端，手机不变。">
      <TextScaleStepper />
    </SetRow>
  );
}

const CHAT_DISPLAY_OPTIONS = [
  { value: "compact", label: "精简", note: "思考与工具折叠为单行" },
  { value: "standard", label: "标准", note: "思考独立显示，工具自动归组" },
  { value: "expanded", label: "全展示", note: "思考与工具默认展开" },
] as const;

export function ChatDisplayModeControl({ className = "segmented" }: { className?: string }) {
  const toast = useToast();
  const mode = useClientConfig().general.chatDisplayMode;
  return (
    <div className={className} role="radiogroup" aria-label="对话展示模式">
      {CHAT_DISPLAY_OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.note}
            className={active ? (className === "wf-seg" ? "on" : "active") : ""}
            onClick={() => void setConfig("general.chatDisplayMode", o.value).catch((e: Error) => toast(e.message, true))}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ChatDisplayModeRow() {
  const mode = useClientConfig().general.chatDisplayMode;
  const about = CHAT_DISPLAY_OPTIONS.find((o) => o.value === mode)?.note ?? "选择思考过程和工具调用的展示密度。";
  return (
    <SetRow title="对话展示模式" about={`${about}（精简：全折叠 · 标准：思考独立、工具归组 · 全展示：默认展开）`}>
      <ChatDisplayModeControl />
    </SetRow>
  );
}

const CANDIDATE_MONO_FONTS = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "Fira Code",
  "FiraCode Nerd Font",
  "Cascadia Mono",
  "Cascadia Code",
  "Maple Mono",
  "Maple Mono NF CN",
  "Sarasa Mono SC",
  "Source Code Pro",
  "IBM Plex Mono",
  "Iosevka",
  "MesloLGS NF",
  "Hack",
  "Consolas",
  "Ubuntu Mono",
];

let cachedInstalledFonts: string[] | null = null;

function detectInstalledMonoFonts(): string[] {
  if (cachedInstalledFonts) return cachedInstalledFonts;
  if (typeof document === "undefined") return [];
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    const sample = "mmmmmmmmmmlli12345汉字测试";
    ctx.font = "48px monospace";
    const baseMono = ctx.measureText(sample).width;
    ctx.font = "48px sans-serif";
    const baseSans = ctx.measureText(sample).width;
    const found: string[] = [];
    for (const font of CANDIDATE_MONO_FONTS) {
      const q = JSON.stringify(font);
      ctx.font = `48px ${q}, monospace`;
      const wMono = ctx.measureText(sample).width;
      ctx.font = `48px ${q}, sans-serif`;
      const wSans = ctx.measureText(sample).width;
      if (wMono !== baseMono || wSans !== baseSans) found.push(font);
    }
    cachedInstalledFonts = found;
    return found;
  } catch {
    return [];
  }
}

function ConfigIntStepper({
  k,
  label,
  step,
  unit = "",
}: {
  k: string;
  label: string;
  step: number;
  unit?: string;
}) {
  const toast = useToast();
  const cfg = useClientConfig();
  const spec = configKeySpec(k);
  const min = spec?.min ?? 0;
  const max = spec?.max ?? 9999;
  const val = Number((cfg.terminal as Record<string, unknown>)[k.split(".")[1]!] ?? spec?.default ?? min);
  const apply = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== val) void setConfig(k, clamped).catch((e: Error) => toast(e.message, true));
  };
  return (
    <div className="sf-stepper" role="group" aria-label={label}>
      <button aria-label={`减小${label}`} disabled={val <= min} onClick={() => apply(val - step)}>
        −
      </button>
      <output className="num" aria-live="polite">
        {val}
        {unit}
      </output>
      <button aria-label={`增大${label}`} disabled={val >= max} onClick={() => apply(val + step)}>
        +
      </button>
    </div>
  );
}

const CUSTOM_FONT_VALUE = "__custom__";

export function TerminalSettingsSection() {
  const toast = useToast();
  const term = useClientConfig().terminal;
  const catalog = useTerminalFontCatalog();
  const webFallback = useMemo(() => detectInstalledMonoFonts(), []);
  const installed = useMemo(
    () => (catalog?.families && catalog.families.length > 0 ? catalog.families : webFallback),
    [catalog, webFallback],
  );
  const isUnlistedCustom = useMemo(
    () => Boolean(term.fontFamily) && !installed.some((f) => f.toLowerCase() === term.fontFamily.toLowerCase()),
    [installed, term.fontFamily],
  );
  const [customMode, setCustomMode] = useState(false);
  const [fontDraft, setFontDraft] = useState(term.fontFamily);
  const [fontMissing, setFontMissing] = useState(false);
  const [previewTick, setPreviewTick] = useState(0);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  const focusCustomOnCloseRef = useRef(false);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    setFontDraft(term.fontFamily);
  }, [term.fontFamily]);

  useEffect(() => {
    if (!customMode) return;
    const t = window.setTimeout(() => customInputRef.current?.focus(), 20);
    return () => window.clearTimeout(t);
  }, [customMode]);

  useEffect(() => {
    let cancelled = false;
    void ensureTerminalFontLoaded(term.fontFamily, term.fontWeight >= 600).then((loaded) => {
      if (cancelled) return;
      if (loaded) setPreviewTick((t) => t + 1);
      setFontMissing(Boolean(native.available() && term.fontFamily.trim() && !loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [term.fontFamily, term.fontWeight, catalog?.herdrFont, catalog?.symbolsFont]);

  const commitFont = (nextRaw: string) => {
    const next = nextRaw.trim();
    const matchedInstalled = installed.some((f) => f.toLowerCase() === next.toLowerCase());
    if (!next || matchedInstalled) setCustomMode(false);
    if (next === term.fontFamily) return;
    void ensureTerminalFontLoaded(next, term.fontWeight >= 600).then((loaded) => {
      if (loaded) setPreviewTick((t) => t + 1);
      setFontMissing(Boolean(native.available() && next && !loaded));
    });
    void setConfig("terminal.fontFamily", next).catch((e: Error) => toast(e.message, true));
  };

  const showCustomInput = customMode || isUnlistedCustom;
  const selectValue = showCustomInput ? CUSTOM_FONT_VALUE : term.fontFamily;

  const fontOptions = useMemo(() => {
    const defaultLabel = catalog?.herdrFont ? `默认（${catalog.herdrFont}）` : "默认等宽字体";
    return [
      { value: "", label: defaultLabel },
      ...installed.map((f) => ({ value: f, label: f })),
      { value: CUSTOM_FONT_VALUE, label: "自定义字体…" },
    ];
  }, [catalog?.herdrFont, installed]);

  const previewFamily = useMemo(() => {
    void previewTick;
    return buildTerminalFontFamily(term.fontFamily, catalog);
  }, [catalog, previewTick, term.fontFamily]);

  const fontAbout = fontMissing
    ? `本机未找到“${term.fontFamily}”，当前已回退默认等宽字体；请确认字体家族名拼写。`
    : catalog?.herdrFont
      ? `默认跟随 Herdr（${catalog.herdrFont}）；自动读取本机已安装等宽与 Nerd Font 字体。`
      : "自动读取系统与用户已安装字体（含 Nerd Font）；修改后立即生效。";

  return (
    <>
      <SetHeading>终端</SetHeading>
      <SetRow title="终端字体" about={fontAbout}>
        <div className="sf-term-font-ctrl">
          <PocketSelect
            ariaLabel="终端字体"
            value={selectValue}
            options={fontOptions}
            onCloseAutoFocus={(e) => {
              if (!focusCustomOnCloseRef.current) return;
              focusCustomOnCloseRef.current = false;
              e.preventDefault();
              window.setTimeout(() => customInputRef.current?.focus(), 20);
            }}
            onValueChange={(v) => {
              if (v === CUSTOM_FONT_VALUE) {
                focusCustomOnCloseRef.current = true;
                setCustomMode(true);
                return;
              }
              focusCustomOnCloseRef.current = false;
              setCustomMode(false);
              setFontDraft(v);
              commitFont(v);
            }}
          />
          {showCustomInput ? (
            <input
              ref={customInputRef}
              className="pk-input mono"
              data-escape-local="true"
              value={fontDraft}
              placeholder="输入字体名，回车生效"
              aria-label="自定义终端字体"
              onChange={(e) => setFontDraft(e.target.value)}
              onBlur={() => {
                if (skipBlurCommitRef.current) {
                  skipBlurCommitRef.current = false;
                  return;
                }
                commitFont(fontDraft);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitFont(fontDraft);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  e.nativeEvent.stopImmediatePropagation?.();
                  skipBlurCommitRef.current = true;
                  setFontDraft(term.fontFamily);
                  if (!isUnlistedCustom) setCustomMode(false);
                  customInputRef.current?.blur();
                }
              }}
            />
          ) : null}
        </div>
      </SetRow>
      <div
        className="sf-term-preview"
        style={{
          fontFamily: previewFamily,
          fontSize: `${term.fontSize}px`,
          lineHeight: term.lineHeight / 100,
          fontWeight: term.fontWeight,
        }}
      >
        {catalog?.symbolsFont || /nf|nerd/i.test(term.fontFamily || catalog?.herdrFont || "")
          ? "~/work/app \ue0a0 main $ pnpm dev · 中文对齐 0123 [] () => {}"
          : "~/work/app $ pnpm dev · 中文对齐 0123 [] () => {}"}
      </div>
      <SetRow title="终端字号" about="终端标签页中的文字大小（10–28 px）。">
        <ConfigIntStepper k="terminal.fontSize" label="终端字号" step={1} unit="px" />
      </SetRow>
      <SetRow title="终端行高" about="每行文字的垂直间距（100%–200%）。">
        <ConfigIntStepper k="terminal.lineHeight" label="终端行高" step={5} unit="%" />
      </SetRow>
      <SetRow title="终端字重" about="常规文本粗细（300–700；粗体保持 700）。">
        <ConfigIntStepper k="terminal.fontWeight" label="终端字重" step={100} />
      </SetRow>
      <ConfigSwitch k="terminal.cursorBlink" about="在终端模式里让光标闪烁。" />
    </>
  );
}

export function LookPane() {
  return (
    <div className="pane">
      <SetHeading>主题</SetHeading>
      <ThemeRow />
      <SetHeading>大小</SetHeading>
      <TextScaleRow />
      <SetHeading>对话</SetHeading>
      <ChatDisplayModeRow />
      <TerminalSettingsSection />
      <SetHeading>列表</SetHeading>
      <ConfigSwitch k="general.showShells" about="在 Agent 列表里也列出没跑 Agent 的普通终端。" />
      <StartupRows />
    </div>
  );
}

/** Hold-one-key hotkeys (voiceInput.hotkey); macOS needs Input Monitoring for these. Mirrors VoiceInput's list. */
const HOLD_KEYS = new Set(["RightOption", "RightControl", "RightCommand", "RightShift", "Fn"]);

export function KeyboardPane() {
  const voice = useClientConfig().voiceInput;
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [checking, setChecking] = useState(false);
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setPerms(await native.getPermissions());
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="pane">
      <PaneTitle
        title="键盘"
        about={IS_MAC ? "这些快捷键在 Herdr Pocket 窗口里有效。" : "这些快捷键在 Herdr Pocket 窗口里有效；Windows 和 Linux 上用 Ctrl 键。"}
      />
      <SetHeading>窗口</SetHeading>
      {SHORTCUTS.map((s) => (
        <SetRow key={s.id} title={s.label}>
          <span className="sf-combo">
            <Keys keys={s.keys} />
            {s.alt?.map((k, i) => (
              <span key={i} className="sf-combo">
                <span className="faint">或</span>
                <Keys keys={k} />
              </span>
            ))}
          </span>
        </SetRow>
      ))}
      <SetRow title="关闭弹窗" about="设置、命令面板和其他弹出的窗口。">
        <span className="sf-keys">
          <kbd className="sf-kbd">Esc</kbd>
        </span>
      </SetRow>

      <SetHeading>语音输入</SetHeading>
      <SetRow
        title="语音输入快捷键"
        about={voice.enabled ? "在任何应用里按住说话，松开后文字打进光标处。" : "语音输入还没开启，到“语音输入”里打开。"}
      >
        <span className="sf-combo">
          {voice.hotkey ? (
            <span className="sf-keys">
              <kbd className="sf-kbd">{prettyHotkey(voice.hotkey)}</kbd>
            </span>
          ) : (
            <span className="faint">未设置</span>
          )}
          <PocketButton size="sm" variant="ghost" onClick={() => openSettingsFrame("voice")}>
            更改
          </PocketButton>
        </span>
      </SetRow>
      {perms ? (
        <div className="sf-block">
          <div className="faint sf-block-lead">语音输入要用到这些系统权限：</div>
          <PermissionCards perms={perms} checking={checking} onChanged={() => void refresh()} singleKey={HOLD_KEYS.has(voice.hotkey ?? "")} />
        </div>
      ) : (
        <div className="faint sf-note">在桌面版里，这里会列出语音输入要用的系统权限，并带你去打开。</div>
      )}
    </div>
  );
}

function DeviceRow({
  item,
  agents,
  onRemove,
}: {
  item: ClassifiedDevice;
  agents?: number;
  onRemove?: () => void;
}) {
  const { device: d, isCurrentDevice, isLocalHost, isExecutionHost, roleLabel, mergedViewer } = item;
  const online = d.online || Boolean(mergedViewer?.online);
  const meta = [
    d.kind === "host" ? `${agents ?? 0} 个 Agent` : null,
    d.platform,
    d.version ? `v${d.version}` : null,
    online ? "在线" : `上次 ${relTime(d.lastSeenAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const roleTone = isLocalHost ? "mint" : isExecutionHost ? "lav" : "neutral";
  return (
    <SetRow
      title={
        <span className="sf-device">
          {d.kind === "host" || isExecutionHost ? <Laptop size={15} /> : roleLabel.includes("控制端") && !roleLabel.includes("手机") && !roleLabel.includes("便携") ? <Monitor size={15} /> : <Smartphone size={15} />}
          <span className="truncate">{d.name}</span>
          {isCurrentDevice ? <PocketBadge tone="pink">当前设备 · 本机</PocketBadge> : null}
          <PocketBadge tone={roleTone}>{roleLabel}</PocketBadge>
        </span>
      }
      about={meta}
    >
      <span className="sf-combo">
        <span className={`sf-dot${online ? " on" : ""}`} aria-label={online ? "在线" : "离线"} />
        {onRemove ? (
          <button className="sf-icon-btn" aria-label={`移除 ${d.name}`} title="移除授权" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        ) : null}
      </span>
    </SetRow>
  );
}

export function MachinesPane({
  onConnectRelay,
  onPairPhone,
  onAddComputer,
}: {
  onConnectRelay: () => void;
  onPairPhone: () => void;
  onAddComputer: () => void;
}) {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const deviceName = settingsStore.use((s) => s.deviceName);
  const myId = settingsStore.use((s) => s.deviceId);
  const localHostId = useLocalHostDeviceId();
  const link = liveStore.use((s) => s.link);
  const devices = liveStore.use((s) => s.devices);
  const agents = liveStore.use((s) => s.agents);
  const { hostd, checking, recheck } = useHostdStatus();
  const [removing, setRemoving] = useState<Device | null>(null);
  const status = linkLabel(link);
  const real = Boolean(server && !isMockServer(server));
  const { desktop, mobile } = useMemo(
    () => partitionDevices(devices, { myId, localHostId }),
    [devices, myId, localHostId],
  );

  return (
    <div className="pane">
      <PaneTitle title="电脑与中继" about="桌面端是运行载体（可本地直连并与其他桌面端联调），手机端作为便携控制端可远程查看、交互并调度桌面端。" />

      <SetHeading>当前设备 · 运行载体（本机）</SetHeading>
      <SetRow
        title={
          hostd === null
            ? checking
              ? "正在检查…"
              : "读不到这台电脑的 herdr-pocket"
            : hostd.configured
              ? `已登录 herdr-pocket（${hostd.deviceName || "本机"}）`
              : hostd.installed
                ? "装了 herdr-pocket，还没登录"
                : "这台电脑还没接入"
        }
        about={
          hostd === null
            ? "当前仅作为控制端连接其他桌面端；安装 herdr-pocket 后可把本机作为运行载体。"
            : hostd.configured
              ? `本机桌面端终端与文件优先走本地直连（${serverLabel(hostd.server ?? null)}），手机端和其他桌面端也可远程联调。`
              : hostd.installed
                ? "在终端运行 herdr-pocket up 登录。"
                : "要让本机的 Agent 出现在 Pocket 里，下面标红的都要装好。"
        }
      >
        <span className="sf-combo">
          <span className={`sf-dot${hostd?.configured ? " on" : ""}`} aria-hidden />
          <button className="sf-icon-btn" aria-label="重新检查" title="重新检查" disabled={checking} onClick={recheck}>
            <RefreshCw size={14} />
          </button>
        </span>
      </SetRow>
      {hostd && !hostd.configured ? (
        <div className="sf-block">
          <LocalHostDeps status={hostd} server={real ? server! : undefined} checking={checking} onRecheck={recheck} />
        </div>
      ) : null}

      <SetHeading>中转服务器</SetHeading>
      <SetRow title={serverLabel(server)} about={`${status.text} · 这台设备在服务器上叫“${deviceName || "未命名"}”。`}>
        <span className={`sf-dot${link === "online" ? " on" : link === "connecting" ? " busy" : " off"}`} aria-label={status.text} />
      </SetRow>
      <div className="sf-actions">
        <PocketButton size="sm" variant="ghost" onClick={() => pingRelay()}>
          <RefreshCw size={14} />
          <span>立即重连</span>
        </PocketButton>
        <PocketButton size="sm" variant="ghost" onClick={onConnectRelay}>
          <Server size={14} />
          <span>换一个服务器</span>
        </PocketButton>
        {real ? (
          <PocketButton
            size="sm"
            variant="ghost"
            onClick={async () => {
              const ok = await copyToClipboard(server!);
              toast(ok ? "服务器地址已复制" : "复制失败", !ok);
            }}
          >
            <Copy size={14} />
            <span>复制地址</span>
          </PocketButton>
        ) : null}
      </div>

      <SetHeading>桌面端 · 运行载体（可互相联调）</SetHeading>
      {desktop.length ? (
        desktop.map((item) => (
          <DeviceRow
            key={item.device.id}
            item={item}
            agents={item.device.kind === "host" ? agents[item.device.id]?.filter((a) => !a.isShell).length ?? 0 : undefined}
            onRemove={item.isCurrentDevice ? undefined : () => setRemoving(item.device)}
          />
        ))
      ) : (
        <div className="faint sf-note">还没有桌面端运行载体加入。</div>
      )}
      <div className="sf-actions">
        <PocketButton size="sm" variant="ghost" onClick={onAddComputer}>
          <Plus size={14} />
          <span>添加电脑</span>
        </PocketButton>
      </div>

      <SetHeading>移动端 · 便携控制</SetHeading>
      {mobile.length ? (
        mobile.map((item) => (
          <DeviceRow
            key={item.device.id}
            item={item}
            onRemove={item.isCurrentDevice ? undefined : () => setRemoving(item.device)}
          />
        ))
      ) : (
        <div className="faint sf-note">还没有手机端连上来；手机可查看并控制上面的桌面端运行载体。</div>
      )}
      <div className="sf-actions">
        <PocketButton size="sm" variant="soft" onClick={onPairPhone}>
          <QrCode size={14} />
          <span>扫码连接手机</span>
        </PocketButton>
      </div>

      <SignOutBlock />
      <RemoveDeviceDialog device={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

export function PrivacyPane() {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const upload = useClientConfig().logging.upload;
  const voice = useClientConfig().voiceInput;
  const [folder, setFolder] = useState<LogFolderInfo | null>(null);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [checkingPerms, setCheckingPerms] = useState(false);
  const refreshPerms = useCallback(async () => {
    setCheckingPerms(true);
    try {
      setPerms(await native.getPermissions());
    } finally {
      setCheckingPerms(false);
    }
  }, []);
  useEffect(() => {
    void native.logInfo().then(setFolder);
    void refreshPerms();
  }, [refreshPerms]);
  // "到 pocket.example.com，" with a real relay; "到你连接的中转服务器，" otherwise.
  const relay = server && !isMockServer(server) ? ` ${serverLabel(server)}` : "你连接的中转服务器";

  return (
    <div className="pane">
      <PaneTitle title="隐私" about="系统权限管理、以及哪些信息会离开这台电脑并发往何处。" />

      <SetHeading>系统权限</SetHeading>
      <div className="sf-block">
        <div className="faint sf-block-lead">语音输入与浏览器数据导入需要的系统权限，可直接跳转设置并拖入应用授权：</div>
        <PermissionCards perms={perms} checking={checkingPerms} onChanged={() => void refreshPerms()} singleKey={HOLD_KEYS.has(voice.hotkey ?? "")} />
      </div>

      <SetHeading>日志</SetHeading>
      <ConfigSwitch
        k="logging.upload"
        about={`开启后，这台设备的日志每分钟传一次到${relay}，在任何设备或命令行 herdr-pocket logs 里都能查。令牌、密钥、Cookie 和配对码写进日志前就会被遮掉。`}
      />
      {upload && folder?.queuedForRelay ? (
        <SetRow title={`还有 ${folder.queuedForRelay} 行等着上传`} about="传不上去时会自动重试。">
          <PocketButton
            size="sm"
            variant="ghost"
            onClick={async () => {
              const n = await native.uploadLogsNow();
              toast(n ? `已上传 ${n} 行` : "现在传不上去，稍后会自动重试");
              void native.logInfo().then(setFolder);
            }}
          >
            <Upload size={14} />
            <span>立即上传</span>
          </PocketButton>
        </SetRow>
      ) : null}
      <SetRow title="诊断包" about="“导出诊断”只在这台电脑上写一个文件，不会自动发给任何人；要不要发给维护者由你决定。" />

      <SetHeading>发到哪里</SetHeading>
      <SetRow title="Agent 的对话和终端" about={`只经过${relay}，在你的手机和电脑之间转发。Herdr Pocket 没有别的服务器。`} />
      <SetRow
        title="和小羊说话"
        about="中转服务器把你的话交给“小羊助理”里配置的模型服务商；小羊替你查看 Agent 时，读到的终端内容也会一起发过去。"
      />
      <SetRow title="语音输入" about="录音发给中转服务器转成文字，由它交给配置好的语音识别服务。" />
      <SetRow title="检查更新" about="向 GitHub 或下载镜像询问最新版本，只读版本信息。" />
      <SetRow title="内置浏览器" about="网页直接从各网站加载；导入的 Cookie 只存在这台电脑上。" />
      <SetRow title="使用统计" about="不收集使用统计，也不接任何第三方分析服务。" />
    </div>
  );
}
