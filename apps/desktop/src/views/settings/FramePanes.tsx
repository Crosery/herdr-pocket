import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Laptop, Monitor, Plus, QrCode, RefreshCw, Server, Smartphone, Trash2, Upload } from "lucide-react";
import { configKeySpec, type Device } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketInput, PocketSelect, useToast } from "../../components/PocketUI";
import { buildTerminalFontFamily } from "../../components/TerminalSurface";
import { LocalHostDeps } from "../../components/LocalHostDeps";
import { PermissionCards, prettyHotkey } from "../../components/VoiceInput";
import { serverLabel } from "../../components/Sidebar";
import { copyToClipboard } from "../../lib/bridge";
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

export function TerminalSettingsSection() {
  const toast = useToast();
  const term = useClientConfig().terminal;
  const installed = useMemo(() => detectInstalledMonoFonts(), []);
  const [fontDraft, setFontDraft] = useState(term.fontFamily);

  useEffect(() => {
    setFontDraft(term.fontFamily);
  }, [term.fontFamily]);

  const commitFont = (nextRaw: string) => {
    const next = nextRaw.trim();
    if (next === term.fontFamily) return;
    void setConfig("terminal.fontFamily", next).catch((e: Error) => toast(e.message, true));
  };

  const fontOptions = useMemo(() => {
    const base = [{ value: "", label: "默认等宽字体" }, ...installed.map((f) => ({ value: f, label: f }))];
    if (term.fontFamily && !installed.includes(term.fontFamily)) {
      base.push({ value: term.fontFamily, label: `${term.fontFamily}（当前）` });
    }
    return base;
  }, [installed, term.fontFamily]);

  return (
    <>
      <SetHeading>终端</SetHeading>
      <SetRow title="终端字体" about="可选择已安装的等宽字体，或直接输入字体名称；修改后立即应用到终端。">
        <div className="sf-term-font-ctrl">
          <PocketSelect
            value={term.fontFamily}
            options={fontOptions}
            onValueChange={(v) => {
              setFontDraft(v);
              commitFont(v);
            }}
          />
          <PocketInput
            mono
            value={fontDraft}
            placeholder="自定义字体名（留空使用默认）"
            aria-label="自定义终端字体"
            onChange={(e) => setFontDraft(e.target.value)}
            onBlur={() => commitFont(fontDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitFont(fontDraft);
              }
            }}
          />
        </div>
      </SetRow>
      <div
        className="sf-term-preview"
        style={{
          fontFamily: buildTerminalFontFamily(term.fontFamily),
          fontSize: `${term.fontSize}px`,
          lineHeight: term.lineHeight / 100,
          fontWeight: term.fontWeight,
        }}
      >
        ~/work/app $ pnpm dev · 中文对齐 0123 [] () =&gt; {"{}"}
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

const DESKTOP_PLATFORM = /mac|darwin|win|linux/i;

function DeviceRow({ d, me, agents, onRemove }: { d: Device; me: boolean; agents?: number; onRemove?: () => void }) {
  const Icon = d.kind === "host" ? Laptop : DESKTOP_PLATFORM.test(d.platform ?? "") ? Monitor : Smartphone;
  const meta = [
    d.kind === "host" ? `${agents ?? 0} 个 Agent` : null,
    d.platform,
    d.version ? `v${d.version}` : null,
    d.online ? "在线" : `上次 ${relTime(d.lastSeenAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SetRow
      title={
        <span className="sf-device">
          <Icon size={15} />
          <span className="truncate">{d.name}</span>
          {me ? <PocketBadge tone="pink">这台设备</PocketBadge> : null}
        </span>
      }
      about={meta}
    >
      <span className="sf-combo">
        <span className={`sf-dot${d.online ? " on" : ""}`} aria-label={d.online ? "在线" : "离线"} />
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
  const link = liveStore.use((s) => s.link);
  const devices = liveStore.use((s) => s.devices);
  const agents = liveStore.use((s) => s.agents);
  const { hostd, checking, recheck } = useHostdStatus();
  const [removing, setRemoving] = useState<Device | null>(null);
  const status = linkLabel(link);
  const real = Boolean(server && !isMockServer(server));
  const byName = (a: Device, b: Device) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name);
  const hosts = Object.values(devices).filter((d) => d.kind === "host").sort(byName);
  const viewers = Object.values(devices).filter((d) => d.kind === "viewer").sort(byName);

  return (
    <div className="pane">
      <PaneTitle title="电脑与中继" about="中转服务器让手机和各台电脑隔着网络也能互相找到；每台电脑上的 Agent 关掉窗口也照常运行。" />

      <SetHeading>这台电脑</SetHeading>
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
            ? "只看别的电脑上的 Agent 时可以不管。"
            : hostd.configured
              ? `连在 ${serverLabel(hostd.server ?? null)}，它的 Agent 会出现在 Pocket 里。`
              : hostd.installed
                ? "在终端运行 herdr-pocket up 登录。"
                : "要让它的 Agent 出现在 Pocket 里，下面标红的都要装好。"
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

      <SetHeading>手机和桌面端</SetHeading>
      {viewers.length ? (
        viewers.map((d) => <DeviceRow key={d.id} d={d} me={d.id === myId} onRemove={d.id === myId ? undefined : () => setRemoving(d)} />)
      ) : (
        <div className="faint sf-note">还没有手机连上来。</div>
      )}
      <div className="sf-actions">
        <PocketButton size="sm" variant="soft" onClick={onPairPhone}>
          <QrCode size={14} />
          <span>扫码连接手机</span>
        </PocketButton>
      </div>

      <SetHeading>电脑</SetHeading>
      {hosts.length ? (
        hosts.map((d) => (
          <DeviceRow key={d.id} d={d} me={false} agents={agents[d.id]?.filter((a) => !a.isShell).length ?? 0} onRemove={() => setRemoving(d)} />
        ))
      ) : (
        <div className="faint sf-note">还没有电脑加入。</div>
      )}
      <div className="sf-actions">
        <PocketButton size="sm" variant="ghost" onClick={onAddComputer}>
          <Plus size={14} />
          <span>添加电脑</span>
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
  const [folder, setFolder] = useState<LogFolderInfo | null>(null);
  useEffect(() => {
    void native.logInfo().then(setFolder);
  }, []);
  // "到 pocket.example.com，" with a real relay; "到你连接的中转服务器，" otherwise.
  const relay = server && !isMockServer(server) ? ` ${serverLabel(server)}` : "你连接的中转服务器";

  return (
    <div className="pane">
      <PaneTitle title="隐私" about="哪些东西会离开这台电脑，发到哪里。" />

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
