import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Laptop, Monitor, Plus, QrCode, RefreshCw, Server, Smartphone, Trash2, Upload } from "lucide-react";
import { configKeySpec, type Device } from "@herdr-pocket/protocol";
import { VendorIcon } from "../../components/MascotAndVendor";
import { PocketBadge, PocketButton, PocketInput, PocketSelect, PocketSwitch, useToast } from "../../components/PocketUI";
import { LocalHostDeps } from "../../components/LocalHostDeps";
import { PermissionCards, prettyHotkey } from "../../components/VoiceInput";
import { serverLabel } from "../../components/Sidebar";
import { copyToClipboard } from "../../lib/bridge";
import { partitionDevices, type ClassifiedDevice } from "../../lib/deviceRole";
import {
  buildTerminalFontFamily,
  buildUiFontFamily,
  detectInstalledUiFonts,
  ensureTerminalFontLoaded,
  ensureUiFontLoaded,
  useLocalHostDeviceId,
  useTerminalFontCatalog,
} from "../../lib/fonts";
import { native, type LogFolderInfo, type Permissions } from "../../lib/native";
import { setConfig, useClientConfig } from "../../lib/config";
import { isMockServer } from "../../lib/mock";
import { pingRelay, refreshHostSpaces, rpcCall } from "../../lib/relay";
import {
  liveStore,
  relTime,
  settingsStore,
  updateSettings,
  type SidebarAgentGrouping,
  type SidebarStyleScheme,
} from "../../lib/store";
import { SidebarDeviceChip, SplitMatrixGlyph } from "../../shell/ShellSidebar";
import type { AgentTopologyPlacement } from "../../shell/sidebarTopology";
import { IS_MAC, SHORTCUTS, keyChips } from "../../shell/shortcuts";
import { openSettingsFrame } from "../../shell/shellStore";
import { RemoveDeviceDialog } from "../DevicesView";
import { ConfigSwitch, PaneTitle, SetHeading, SetRow } from "./rows";
import { H5IdentityLockSection, H5LayoutModeRow, SignOutBlock, StartupRows, ThemeRow, linkLabel, useHostdStatus } from "./Panes";

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
    <SetRow title="文字大小" about="仅影响本机桌面端">
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
  const about = CHAT_DISPLAY_OPTIONS.find((o) => o.value === mode)?.note ?? "控制思考与工具展示密度";
  return (
    <SetRow title="对话展示模式" about={about}>
      <ChatDisplayModeControl />
    </SetRow>
  );
}

const PORTAL_DISPLAY_OPTIONS = [
  { value: "collapsed", label: "默认收起", note: "仅在右上角保留精简胶囊，不遮挡代码与对话文字" },
  { value: "fan", label: "叠牌露头", note: "像扑克牌一样 1、2、3、4 错位露出标题栏并可切换" },
  { value: "tile", label: "平铺展开", note: "多窗口在右上角两列平铺并排预览，互不遮挡" },
  { value: "cascade", label: "纵向叠列", note: "最多 3 个窗口纵向顺排实时预览" },
] as const;

export function PortalDisplayModeControl({ className = "segmented" }: { className?: string }) {
  const toast = useToast();
  const mode = useClientConfig().general.portalDisplayMode;
  return (
    <div className={className} role="radiogroup" aria-label="跨端小窗默认显示">
      {PORTAL_DISPLAY_OPTIONS.map((o) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.note}
            className={active ? (className === "wf-seg" ? "on" : "active") : ""}
            onClick={() => void setConfig("general.portalDisplayMode", o.value).catch((e: Error) => toast(e.message, true))}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function PortalDisplayModeRow() {
  const mode = useClientConfig().general.portalDisplayMode;
  const about = PORTAL_DISPLAY_OPTIONS.find((o) => o.value === mode)?.note ?? "控制跨端小窗弹出时的默认展示形态";
  return (
    <SetRow title="跨端小窗默认显示" about={about}>
      <PortalDisplayModeControl />
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

function FontFamilyPicker({
  title,
  about,
  ariaLabel,
  customAriaLabel,
  defaultLabel,
  value,
  installed,
  loadFont,
  onSave,
}: {
  title: string;
  about: string;
  ariaLabel: string;
  customAriaLabel: string;
  defaultLabel: string;
  value: string;
  installed: string[];
  loadFont: (family: string) => Promise<boolean>;
  onSave: (next: string) => void;
}) {
  const isUnlistedCustom = useMemo(
    () => Boolean(value) && !installed.some((f) => f.toLowerCase() === value.toLowerCase()),
    [installed, value],
  );
  const [customMode, setCustomMode] = useState(false);
  const [draft, setDraft] = useState(value);
  const [missing, setMissing] = useState(false);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  const focusCustomOnCloseRef = useRef(false);
  const skipBlurCommitRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!customMode) return;
    const t = window.setTimeout(() => customInputRef.current?.focus(), 20);
    return () => window.clearTimeout(t);
  }, [customMode]);

  useEffect(() => {
    let cancelled = false;
    void loadFont(value).then((loaded) => {
      if (cancelled) return;
      setMissing(Boolean(native.available() && value.trim() && !loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [loadFont, value]);

  const commitFont = (nextRaw: string) => {
    const next = nextRaw.trim();
    const matchedInstalled = installed.some((f) => f.toLowerCase() === next.toLowerCase());
    if (!next || matchedInstalled) setCustomMode(false);
    if (next === value) return;
    void loadFont(next).then((loaded) => {
      setMissing(Boolean(native.available() && next && !loaded));
    });
    onSave(next);
  };

  const showCustomInput = customMode || isUnlistedCustom;
  const selectValue = showCustomInput ? CUSTOM_FONT_VALUE : value;

  const options = useMemo(
    () => [
      { value: "", label: defaultLabel },
      ...installed.map((f) => ({ value: f, label: f })),
      { value: CUSTOM_FONT_VALUE, label: "自定义字体…" },
    ],
    [defaultLabel, installed],
  );

  return (
    <SetRow title={title} about={missing ? `未找到“${value}”，已回退默认栈` : about}>
      <div className="sf-term-font-ctrl">
        <PocketSelect
          ariaLabel={ariaLabel}
          value={selectValue}
          options={options}
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
            setDraft(v);
            commitFont(v);
          }}
        />
        {showCustomInput ? (
          <input
            ref={customInputRef}
            className="pk-input"
            data-escape-local="true"
            value={draft}
            placeholder="输入字体名，回车生效"
            aria-label={customAriaLabel}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (skipBlurCommitRef.current) {
                skipBlurCommitRef.current = false;
                return;
              }
              commitFont(draft);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitFont(draft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation?.();
                skipBlurCommitRef.current = true;
                setDraft(value);
                if (!isUnlistedCustom) setCustomMode(false);
                customInputRef.current?.blur();
              }
            }}
          />
        ) : null}
      </div>
    </SetRow>
  );
}

export function UiFontSettingsSection() {
  const toast = useToast();
  const fontFamily = useClientConfig().general.fontFamily;
  const catalog = useTerminalFontCatalog();
  const webFallback = useMemo(() => detectInstalledUiFonts(), []);
  const installed = useMemo(
    () => (catalog?.uiFamilies && catalog.uiFamilies.length > 0 ? catalog.uiFamilies : webFallback),
    [catalog?.uiFamilies, webFallback],
  );
  const [previewTick, setPreviewTick] = useState(0);
  const loadUiFont = useCallback(async (fam: string) => {
    const ok = await ensureUiFontLoaded(fam);
    if (ok) setPreviewTick((t) => t + 1);
    return ok;
  }, []);
  const previewFamily = useMemo(() => {
    void previewTick;
    return buildUiFontFamily(fontFamily);
  }, [fontFamily, previewTick]);

  return (
    <>
      <FontFamilyPicker
        title="界面字体"
        about="全局作用于侧栏、对话与面板"
        ariaLabel="界面字体"
        customAriaLabel="自定义界面字体"
        defaultLabel="默认（Nunito + 系统界面字体）"
        value={fontFamily}
        installed={installed}
        loadFont={loadUiFont}
        onSave={(next) => {
          void setConfig("general.fontFamily", next).catch((e: Error) => toast(e.message, true));
        }}
      />
      <div className="sf-ui-preview" style={{ fontFamily: previewFamily }}>
        Herdr Pocket · 空间、对话与面板全局字体预览 0123 ABC
      </div>
    </>
  );
}

export function TerminalSettingsSection() {
  const toast = useToast();
  const term = useClientConfig().terminal;
  const catalog = useTerminalFontCatalog();
  const webFallback = useMemo(() => detectInstalledMonoFonts(), []);
  const installed = useMemo(
    () => (catalog?.families && catalog.families.length > 0 ? catalog.families : webFallback),
    [catalog, webFallback],
  );
  const [previewTick, setPreviewTick] = useState(0);
  const loadTermFont = useCallback(
    async (fam: string) => {
      const ok = await ensureTerminalFontLoaded(fam, term.fontWeight >= 600);
      if (ok) setPreviewTick((t) => t + 1);
      return ok;
    },
    [term.fontWeight],
  );

  const previewFamily = useMemo(() => {
    void previewTick;
    return buildTerminalFontFamily(term.fontFamily, catalog);
  }, [catalog, previewTick, term.fontFamily]);

  const fontAbout = catalog?.herdrFont
    ? `默认跟随 Herdr（${catalog.herdrFont}）`
    : "自动读取本机等宽与 Nerd Font";

  return (
    <>
      <SetHeading>终端</SetHeading>
      <FontFamilyPicker
        title="终端字体"
        about={fontAbout}
        ariaLabel="终端字体"
        customAriaLabel="自定义终端字体"
        defaultLabel={catalog?.herdrFont ? `默认（${catalog.herdrFont}）` : "默认等宽字体"}
        value={term.fontFamily}
        installed={installed}
        loadFont={loadTermFont}
        onSave={(next) => {
          void setConfig("terminal.fontFamily", next).catch((e: Error) => toast(e.message, true));
        }}
      />
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
      <SetRow title="终端字号">
        <ConfigIntStepper k="terminal.fontSize" label="终端字号" step={1} unit="px" />
      </SetRow>
      <SetRow title="终端行高">
        <ConfigIntStepper k="terminal.lineHeight" label="终端行高" step={5} unit="%" />
      </SetRow>
      <SetRow title="终端字重">
        <ConfigIntStepper k="terminal.fontWeight" label="终端字重" step={100} />
      </SetRow>
      <ConfigSwitch k="terminal.cursorBlink" />
    </>
  );
}

const SIDEBAR_GROUPING_OPTIONS: Array<{ value: SidebarAgentGrouping; label: string; note: string }> = [
  { value: "status", label: "按运行状态", note: "需要你 / 进行中 / 已完成" },
  { value: "space", label: "按所属空间", note: "按项目 Space 与同窗分屏聚合" },
  { value: "recent", label: "按最近活跃", note: "最近交互过的 Agent 排在前面" },
];

const SIDEBAR_SCHEME_OPTIONS: Array<{ value: SidebarStyleScheme; label: string; tag: string; note: string }> = [
  {
    value: "a",
    label: "方案 A（默认）",
    tag: "同窗聚合卡",
    note: "同空间自动聚拢，同窗分屏收纳进柔和圆角卡，左侧固定电脑小标",
  },
  {
    value: "b",
    label: "方案 B",
    tag: "按电脑分栏",
    note: "状态组内先按电脑划分小标题，整条副行全宽留给空间与页面位置",
  },
  {
    value: "c",
    label: "方案 C",
    tag: "微缩分屏图",
    note: "左侧固定电脑小标，右侧用微缩窗口分屏小格直观标明所在格位",
  },
];

const PREVIEW_PLACEMENTS: Record<string, AgentTopologyPlacement> = {
  split1: {
    agentKey: "p1",
    tabId: "t-split",
    paneId: "pane-1",
    spaceKey: "local\0伊吹工坊",
    spaceName: "伊吹工坊",
    spaceColor: "ansi4",
    pageNumber: 1,
    pageTotal: 4,
    paneIndex: 1,
    paneCount: 2,
    isSplit: true,
    isBackground: false,
    isActiveTab: true,
    isFocusedPane: true,
    siblingAgentKeys: ["p2"],
  },
  split2: {
    agentKey: "p2",
    tabId: "t-split",
    paneId: "pane-2",
    spaceKey: "local\0伊吹工坊",
    spaceName: "伊吹工坊",
    spaceColor: "ansi4",
    pageNumber: 1,
    pageTotal: 4,
    paneIndex: 2,
    paneCount: 2,
    isSplit: true,
    isBackground: false,
    isActiveTab: true,
    isFocusedPane: false,
    siblingAgentKeys: ["p1"],
  },
  singleLocal: {
    agentKey: "p3",
    tabId: "t-tan",
    paneId: "pane-tan",
    spaceKey: "local\0弹唱",
    spaceName: "弹唱",
    spaceColor: "ansi5",
    pageNumber: 3,
    pageTotal: 4,
    paneIndex: 1,
    paneCount: 1,
    isSplit: false,
    isBackground: false,
    isActiveTab: false,
    isFocusedPane: false,
    siblingAgentKeys: [],
  },
  singleRemote: {
    agentKey: "p4",
    tabId: "t-remote",
    paneId: "pane-remote",
    spaceKey: "remote\0测试",
    spaceName: "测试",
    spaceColor: "ansi6",
    pageNumber: 2,
    pageTotal: 3,
    paneIndex: 1,
    paneCount: 1,
    isSplit: false,
    isBackground: false,
    isActiveTab: false,
    isFocusedPane: false,
    siblingAgentKeys: [],
  },
};

function PreviewAgentLine({
  harness,
  title,
  age,
  selected,
  running,
  device,
  spaceName,
  spaceColor,
  subOverride,
  placement,
  scheme,
}: {
  harness: string;
  title: string;
  age: string;
  selected?: boolean;
  running?: boolean;
  device?: { label: string; fullLabel: string; isLocal: boolean } | null;
  spaceName?: string;
  spaceColor?: string;
  subOverride?: string;
  placement: AgentTopologyPlacement;
  scheme: SidebarStyleScheme;
}) {
  const glyph = scheme === "c" ? <SplitMatrixGlyph placement={placement} /> : null;
  const badge =
    scheme !== "c" && !subOverride
      ? placement.isSplit
        ? `${placement.paneCount}分屏 ${placement.paneIndex}/${placement.paneCount}`
        : `第${placement.pageNumber ?? 1}页`
      : null;
  return (
    <div className={`v3-row v3-agent has-sub${selected ? " selected" : ""}`}>
      <VendorIcon harness={harness} isShell={false} size={15} />
      <div className="v3-agent-body">
        <div className="v3-agent-top">
          <span className="v3-agent-title v3-row-label truncate">{title}</span>
          <span className="v3-time">{age}</span>
          {running ? <span className="v3-spinner" aria-hidden="true" /> : <span className="v3-ring" aria-hidden="true" />}
        </div>
        <div className="v3-agent-sub">
          <span className="v3-agent-sub-main">
            {device ? <SidebarDeviceChip label={device.label} fullLabel={device.fullLabel} isLocal={device.isLocal} /> : null}
            {subOverride ? (
              <span className="truncate">{subOverride}</span>
            ) : spaceName ? (
              <>
                {spaceColor ? <span className="v3-space-dot" style={{ backgroundColor: spaceColor }} aria-hidden="true" /> : null}
                <span className="truncate">{spaceName}</span>
              </>
            ) : null}
          </span>
          {glyph}
          {badge ? (
            <span className={`v3-topo-badge ${placement.isSplit ? "is-split" : "is-page"}`}>
              <span>{badge}</span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SidebarSchemePreview({ scheme }: { scheme: SidebarStyleScheme }) {
  const activeMeta = SIDEBAR_SCHEME_OPTIONS.find((o) => o.value === scheme) ?? SIDEBAR_SCHEME_OPTIONS[0]!;
  return (
    <div className="sf-sidebar-scheme-preview" role="region" aria-label={`侧边栏样式实时预览：${activeMeta.label}`}>
      <div className="sf-scheme-preview-head">
        <span>实时效果预览</span>
        <span className="sf-scheme-preview-tag">{activeMeta.label} · {activeMeta.tag}</span>
      </div>
      <div className="sf-scheme-preview-rail">
        <div className="v3-group-head" style={{ marginTop: 0, cursor: "default" }}>
          <span>运行中</span>
          <span className="v3-count">4</span>
        </div>

        {scheme === "b" ? (
          <>
            <div className="v3-dev-subhdr">
              <SidebarDeviceChip label="本机 MacBook · 3" fullLabel="本机 · MacBook" isLocal />
              <span className="v3-dev-subhdr-line" />
            </div>
            <div className="v3-split-cluster">
              <div className="v3-split-cluster-hd">
                <span className="v3-space-dot" style={{ backgroundColor: "#3b82f6" }} aria-hidden="true" />
                <span className="truncate">伊吹工坊</span>
                <span className="v3-split-cluster-badge">同窗 2分屏</span>
              </div>
              <PreviewAgentLine
                harness="gemini"
                title="Tsing 服务问题排查"
                age="刚刚"
                selected
                running
                subOverride="分屏格 1/2"
                placement={PREVIEW_PLACEMENTS.split1!}
                scheme={scheme}
              />
              <PreviewAgentLine
                harness="gemini"
                title="NewAPI 内测需求联调"
                age="5分"
                running
                subOverride="分屏格 2/2"
                placement={PREVIEW_PLACEMENTS.split2!}
                scheme={scheme}
              />
            </div>
            <PreviewAgentLine
              harness="claude-code"
              title="Linux Agent Handover"
              age="12分"
              running
              spaceName="弹唱"
              spaceColor="#e85d93"
              placement={PREVIEW_PLACEMENTS.singleLocal!}
              scheme={scheme}
            />
            <div className="v3-dev-subhdr">
              <SidebarDeviceChip label="家里的 Mac · 1" fullLabel="家里的 Mac" isLocal={false} />
              <span className="v3-dev-subhdr-line" />
            </div>
            <PreviewAgentLine
              harness="codex"
              title="Connecting Colab Container"
              age="1时"
              running
              spaceName="测试"
              spaceColor="#06b6d4"
              placement={PREVIEW_PLACEMENTS.singleRemote!}
              scheme={scheme}
            />
          </>
        ) : scheme === "c" ? (
          <>
            <PreviewAgentLine
              harness="gemini"
              title="Tsing 服务问题排查"
              age="刚刚"
              selected
              running
              device={{ label: "本机", fullLabel: "本机 · MacBook", isLocal: true }}
              spaceName="伊吹工坊"
              spaceColor="#3b82f6"
              placement={PREVIEW_PLACEMENTS.split1!}
              scheme={scheme}
            />
            <PreviewAgentLine
              harness="gemini"
              title="NewAPI 内测需求联调"
              age="5分"
              running
              device={{ label: "本机", fullLabel: "本机 · MacBook", isLocal: true }}
              spaceName="伊吹工坊"
              spaceColor="#3b82f6"
              placement={PREVIEW_PLACEMENTS.split2!}
              scheme={scheme}
            />
            <PreviewAgentLine
              harness="claude-code"
              title="Linux Agent Handover"
              age="12分"
              running
              device={{ label: "本机", fullLabel: "本机 · MacBook", isLocal: true }}
              spaceName="弹唱"
              spaceColor="#e85d93"
              placement={PREVIEW_PLACEMENTS.singleLocal!}
              scheme={scheme}
            />
            <PreviewAgentLine
              harness="codex"
              title="Connecting Colab Container"
              age="1时"
              running
              device={{ label: "家里的 Mac", fullLabel: "家里的 Mac", isLocal: false }}
              spaceName="测试"
              spaceColor="#06b6d4"
              placement={PREVIEW_PLACEMENTS.singleRemote!}
              scheme={scheme}
            />
          </>
        ) : (
          <>
            <div className="v3-split-cluster">
              <div className="v3-split-cluster-hd">
                <SidebarDeviceChip label="本机" fullLabel="本机 · MacBook" isLocal />
                <span className="v3-space-dot" style={{ backgroundColor: "#3b82f6" }} aria-hidden="true" />
                <span className="truncate">伊吹工坊</span>
                <span className="v3-split-cluster-badge">同窗 2分屏</span>
              </div>
              <PreviewAgentLine
                harness="gemini"
                title="Tsing 服务问题排查"
                age="刚刚"
                selected
                running
                subOverride="分屏格 1/2"
                placement={PREVIEW_PLACEMENTS.split1!}
                scheme={scheme}
              />
              <PreviewAgentLine
                harness="gemini"
                title="NewAPI 内测需求联调"
                age="5分"
                running
                subOverride="分屏格 2/2"
                placement={PREVIEW_PLACEMENTS.split2!}
                scheme={scheme}
              />
            </div>
            <PreviewAgentLine
              harness="claude-code"
              title="Linux Agent Handover"
              age="12分"
              running
              device={{ label: "本机", fullLabel: "本机 · MacBook", isLocal: true }}
              spaceName="弹唱"
              spaceColor="#e85d93"
              placement={PREVIEW_PLACEMENTS.singleLocal!}
              scheme={scheme}
            />
            <PreviewAgentLine
              harness="codex"
              title="Connecting Colab Container"
              age="1时"
              running
              device={{ label: "家里的 Mac", fullLabel: "家里的 Mac", isLocal: false }}
              spaceName="测试"
              spaceColor="#06b6d4"
              placement={PREVIEW_PLACEMENTS.singleRemote!}
              scheme={scheme}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function SidebarWorkspaceUxRows() {
  const grouping = settingsStore.use((s) => s.sidebarAgentGrouping);
  const styleScheme = settingsStore.use((s) => s.sidebarStyleScheme);
  const showTopology = settingsStore.use((s) => s.showSidebarTopology);
  const groupingNote =
    SIDEBAR_GROUPING_OPTIONS.find((o) => o.value === grouping)?.note ?? "选择侧边栏 Agent 列表的分组方式";
  return (
    <>
      <SetRow title="侧边栏 Agent 分组" about={groupingNote}>
        <PocketSelect
          value={grouping}
          onValueChange={(v) => updateSettings({ sidebarAgentGrouping: v as SidebarAgentGrouping })}
          options={SIDEBAR_GROUPING_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </SetRow>
      <div className="sf-scheme-block">
        <div className="sf-scheme-block-head">
          <div className="set-label">侧边栏排布样式</div>
          <div className="set-about">默认按方案 A 展示；切换方案 B / C 可在下方面板与真实侧栏实时生效</div>
        </div>
        <div className="sf-scheme-cards" role="radiogroup" aria-label="侧边栏排布样式">
          {SIDEBAR_SCHEME_OPTIONS.map((opt) => {
            const active = styleScheme === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                className={`sf-scheme-card${active ? " active" : ""}`}
                onClick={() => updateSettings({ sidebarStyleScheme: opt.value })}
              >
                <div className="sf-scheme-card-top">
                  <span className="sf-scheme-card-title">{opt.label}</span>
                  <span className="sf-scheme-card-tag">{opt.tag}</span>
                </div>
                <div className="sf-scheme-card-note">{opt.note}</div>
              </button>
            );
          })}
        </div>
        <SidebarSchemePreview scheme={styleScheme} />
      </div>
      <SetRow
        title="显示空间分页与分屏关系"
        about="显示 Space 页数标记（点击展开第 1..N 页快捷跳转）、同窗分屏聚合卡与悬停联动"
      >
        <PocketSwitch
          checked={showTopology}
          onCheckedChange={(checked) => updateSettings({ showSidebarTopology: checked })}
        />
      </SetRow>
    </>
  );
}

export function LookPane() {
  return (
    <div className="pane">
      <SetHeading>主题</SetHeading>
      <ThemeRow />
      <H5LayoutModeRow />
      <SetHeading>大小与字体</SetHeading>
      <TextScaleRow />
      <UiFontSettingsSection />
      <SetHeading>对话与浮窗</SetHeading>
      <ChatDisplayModeRow />
      <PortalDisplayModeRow />
      <TerminalSettingsSection />
      <SetHeading>侧边栏与空间拓扑</SetHeading>
      <SidebarWorkspaceUxRows />
      <SetHeading>列表</SetHeading>
      <ConfigSwitch k="general.showShells" about="列出普通 Shell 终端" />
      <StartupRows />
    </div>
  );
}

/** Hold-one-key hotkeys (voiceInput.hotkey); macOS needs Input Monitoring for these. Mirrors VoiceInput's list. */
const HOLD_KEYS = new Set(["RightOption", "RightControl", "RightCommand", "RightShift", "Fn"]);

export function KeyboardPane() {
  const voice = useClientConfig().voiceInput;
  const showHoldHints = settingsStore.use((s) => s.showModifierHoldHints);
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
      <PaneTitle title="键盘" />
      <SetHeading>按键提示与窗口快捷键</SetHeading>
      <SetRow
        title={`按住 ${IS_MAC ? "⌘" : "Ctrl"} 显示快捷键角标`}
        about="按住不动 0.3 秒在标签、分屏和侧栏上标出可用热键"
      >
        <PocketSwitch
          checked={showHoldHints}
          onCheckedChange={(v) => updateSettings({ showModifierHoldHints: v })}
          label={`按住 ${IS_MAC ? "⌘" : "Ctrl"} 显示快捷键角标`}
        />
      </SetRow>
      {SHORTCUTS.map((s) => (
        <SetRow key={s.id} title={s.label} about={s.when}>
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
      <SetRow title="关闭弹窗">
        <span className="sf-keys">
          <kbd className="sf-kbd">Esc</kbd>
        </span>
      </SetRow>

      <SetHeading>语音唤醒与声纹</SetHeading>
      <SetRow title="唤醒快捷键" about={voice.enabled ? "全局按一下唤醒小羊实时通话，再按挂断" : "未开启"}>
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
          <div className="faint sf-block-lead">小羊语音唤醒与通话要用到这些系统权限：</div>
          <PermissionCards perms={perms} checking={checking} onChanged={() => void refresh()} singleKey={HOLD_KEYS.has(voice.hotkey ?? "")} />
        </div>
      ) : (
        <div className="faint sf-note">在桌面版里，这里会列出小羊语音唤醒与通话要用的系统权限，并带你去打开。</div>
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
  const [syncingSpaces, setSyncingSpaces] = useState<"sync" | "migrate" | null>(null);
  const status = linkLabel(link);
  const real = Boolean(server && !isMockServer(server));
  const { desktop, mobile } = useMemo(
    () => partitionDevices(devices, { myId, localHostId }),
    [devices, myId, localHostId],
  );
  const syncTargetHost = useMemo(() => {
    if (localHostId && devices[localHostId]?.online) return devices[localHostId]!;
    return Object.values(devices).find((d) => d.kind === "host" && d.online) ?? null;
  }, [devices, localHostId]);

  const runSpaceSync = async (mode: "sync" | "migrate") => {
    if (!syncTargetHost) return;
    setSyncingSpaces(mode);
    try {
      const res = await rpcCall(syncTargetHost.id, "spaces.sync", { mode }, 20_000);
      refreshHostSpaces(syncTargetHost.id);
      if (!res.herdrAvailable) {
        toast("未检测到正在运行的 herdr 终端（已保持 Herdr Core 空间完整）");
      } else {
        const parts = [`Core +${res.syncedToCore}`, `Herdr +${res.syncedToHerdr}`];
        if (mode === "migrate") parts.push(`迁移会话 ${res.migratedAgents} 个`);
        toast(`空间同步完成：${parts.join(" · ")}`);
      }
    } catch (e) {
      toast((e as Error).message || "空间同步失败", true);
    } finally {
      setSyncingSpaces(null);
    }
  };

  return (
    <div className="pane">
      <PaneTitle title="电脑与中继" />

      <SetHeading>本机服务</SetHeading>
      <SetRow
        title={
          hostd === null
            ? checking
              ? "正在检查…"
              : "未检测到 herdr-pocket"
            : hostd.configured
              ? `已登录（${hostd.deviceName || "本机"}）`
              : hostd.installed
                ? "已安装，未登录"
                : "本机未接入"
        }
        about={
          hostd === null
            ? "仅作为控制端连接远程设备"
            : hostd.configured
              ? `本机优先直连（${serverLabel(hostd.server ?? null)}）`
              : hostd.installed
                ? "在终端运行 herdr-pocket up"
                : "安装并登录后可作为运行主机"
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

      <H5IdentityLockSection />

      {syncTargetHost ? (
        <>
          <SetHeading>Herdr ↔ Herdr Core 空间同步</SetHeading>
          <SetRow
            title={`无感双向同步（${syncTargetHost.name}）`}
            about="自动将 herdr 终端与 Herdr Core 的工作空间保持一致，并支持一键把 herdr 会话续跑迁移到 Herdr Core"
          >
            <span className="sf-combo">
              <PocketButton
                size="sm"
                variant="soft"
                disabled={syncingSpaces !== null}
                onClick={() => void runSpaceSync("sync")}
              >
                <RefreshCw size={13} className={syncingSpaces === "sync" ? "pk-spin" : undefined} />
                <span>{syncingSpaces === "sync" ? "同步中…" : "双向同步"}</span>
              </PocketButton>
              <PocketButton
                size="sm"
                variant="ghost"
                disabled={syncingSpaces !== null}
                onClick={() => void runSpaceSync("migrate")}
              >
                <span>{syncingSpaces === "migrate" ? "迁移中…" : "迁移会话"}</span>
              </PocketButton>
            </span>
          </SetRow>
        </>
      ) : null}

      <SetHeading>桌面端</SetHeading>
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
        <div className="faint sf-note">暂无已接入的桌面端</div>
      )}
      <div className="sf-actions">
        <PocketButton size="sm" variant="ghost" data-tour="machines-add-computer" onClick={onAddComputer}>
          <Plus size={14} />
          <span>添加电脑</span>
        </PocketButton>
      </div>

      <SetHeading>移动端</SetHeading>
      {mobile.length ? (
        mobile.map((item) => (
          <DeviceRow
            key={item.device.id}
            item={item}
            onRemove={item.isCurrentDevice ? undefined : () => setRemoving(item.device)}
          />
        ))
      ) : (
        <div className="faint sf-note">暂无已配对的移动端</div>
      )}
      <div className="sf-actions">
        <PocketButton size="sm" variant="soft" data-tour="machines-pair-phone" onClick={onPairPhone}>
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
    return native.onPermissionsChanged((next) => setPerms(next));
  }, [refreshPerms]);
  // "到 pocket.example.com，" with a real relay; "到你连接的中转服务器，" otherwise.
  const relay = server && !isMockServer(server) ? ` ${serverLabel(server)}` : "中转服务器";

  return (
    <div className="pane">
      <PaneTitle title="隐私" />

      <SetHeading>系统权限</SetHeading>
      <div className="sf-block">
        <PermissionCards perms={perms} checking={checkingPerms} onChanged={() => void refreshPerms()} singleKey={HOLD_KEYS.has(voice.hotkey ?? "")} scope="all" />
      </div>

      <SetHeading>日志</SetHeading>
      <ConfigSwitch
        k="logging.upload"
        about={`每分钟脱敏上传至${relay}`}
      />
      {upload && folder?.queuedForRelay ? (
        <SetRow title={`待上传 ${folder.queuedForRelay} 行`}>
          <PocketButton
            size="sm"
            variant="ghost"
            onClick={async () => {
              const n = await native.uploadLogsNow();
              toast(n ? `已上传 ${n} 行` : "稍后自动重试");
              void native.logInfo().then(setFolder);
            }}
          >
            <Upload size={14} />
            <span>立即上传</span>
          </PocketButton>
        </SetRow>
      ) : null}
      <SetRow title="诊断包" about="仅导出到本地，不会自动上传" />

      <SetHeading>数据流向</SetHeading>
      <SetRow title="对话与终端" about={`仅经${relay}加密转发`} />
      <SetRow title="语音与小羊" about="转发至所配模型及语音服务商" />
      <SetRow title="本地与统计" about="Cookie 仅存本机，无第三方统计" />
    </div>
  );
}
