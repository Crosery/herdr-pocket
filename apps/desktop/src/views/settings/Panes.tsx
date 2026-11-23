import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink, FileText, FolderOpen, LogOut, QrCode, RefreshCw, RotateCcw, Server, Trash2 } from "lucide-react";
import {
  DIRECT_SOURCE,
  RELEASES_PAGE,
  RELEASE_REPO,
  configKeySpec,
  isMirrorPrefix,
  isRecommendedSourceForRegion,
  pickLowestLatency,
  sourceLabel,
  sourcePrefixes,
} from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketInput, PocketSelect, PocketSwitch, PocketTextarea, useToast, type SelectOption } from "../../components/PocketUI";
import { LocalHostDeps } from "../../components/LocalHostDeps";
import { CookieImportButton } from "../../components/CookieImport";
import { serverLabel } from "../../components/Sidebar";
import { appVersion, copyToClipboard, detectPlatform, getHostdStatus, openExternalUrl, pushSystemNotification, type HostdLocalStatus } from "../../lib/bridge";
import { native, type ResourceUsage } from "../../lib/native";
import { clientConfigStore, setConfig, useClientConfig } from "../../lib/config";
import {
  checkForUpdate,
  currentRegion,
  fetchReleaseNotes,
  probeMirrorsNow,
  restartToApplyUpdate,
  startUpdateDownload,
  updateStore,
  type ReleaseNotes,
} from "../../lib/updates";
import { RichMarkdown } from "../../lib/markdown";
import { isMockServer } from "../../lib/mock";
import { refreshNotifyChannel, signOut } from "../../lib/relay";
import { liveStore, relTime, settingsStore, updateSettings } from "../../lib/store";
import { useWindowHidden } from "../../lib/layout";
import { ConfigSelect, ConfigSwitch, PaneTitle, SetHeading, SetRow } from "./rows";
import { ChatDisplayModeRow, TerminalSettingsSection } from "./FramePanes";
import { ToolVersionsSection } from "./ToolVersions";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  openharmony: "鸿蒙 NEXT",
  web: "浏览器",
};

const DESKTOP = detectPlatform() === "macos" || detectPlatform() === "windows" || detectPlatform() === "linux";

const REVEAL_LABEL = detectPlatform() === "macos" ? "在访达中显示" : detectPlatform() === "windows" ? "在资源管理器中显示" : "打开所在文件夹";

/**
 * Where config.json is, and which settings live there, on the relay, or only on this device.
 * The CLI (`herdr-pocket config`) and this app share the file; outside edits apply at once.
 */
function ConfigFileBlock() {
  const toast = useToast();
  const path = clientConfigStore.use((s) => s.path);
  const error = clientConfigStore.use((s) => s.error);
  const problems = clientConfigStore.use((s) => s.problems);
  return (
    <>
      <SetHeading>配置文件</SetHeading>
      <SetRow
        title="config.json"
        about={<span className="mono wrap-anywhere">{path || "本地配置"}</span>}
      >
        {path ? (
          <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
            <PocketButton
              size="sm"
              variant="soft"
              onClick={() =>
                void native
                  .configOpen()
                  .then((how) => how === "revealed" && toast("这个版本还不能直接打开，已在文件夹里选中它"))
                  .catch((e: Error) => toast(e.message, true))
              }
            >
              <FileText size={14} />
              <span>打开配置文件</span>
            </PocketButton>
            <PocketButton size="sm" variant="ghost" onClick={() => void native.configReveal().catch((e: Error) => toast(e.message, true))}>
              <FolderOpen size={14} />
              <span>{REVEAL_LABEL}</span>
            </PocketButton>
            <PocketButton
              size="sm"
              variant="ghost"
              onClick={async () => {
                const ok = await copyToClipboard(path);
                toast(ok ? "路径已复制" : "复制失败", !ok);
              }}
            >
              <Copy size={14} />
              <span>复制路径</span>
            </PocketButton>
          </div>
        ) : null}
      </SetRow>
      {error ? <div className="inline-alert">{error}</div> : null}
      {problems.length ? <div className="faint">{problems.map((p) => `${p.key || "文件"}：${p.message}`).join("；")}</div> : null}
    </>
  );
}

/** general.theme as a segmented control; the app applies it at once and keeps the file in step. */
export function ThemeRow() {
  const toast = useToast();
  const theme = useClientConfig().general.theme;
  return (
    <SetRow title="外观">
      <div className="segmented" role="radiogroup" aria-label="外观">
        {(
          [
            ["system", "跟随系统"],
            ["light", "浅色"],
            ["dark", "暗色"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            role="radio"
            aria-checked={theme === v}
            className={theme === v ? "active" : ""}
            onClick={() => {
              updateSettings({ theme: v });
              void setConfig("general.theme", v).catch((e: Error) => toast(e.message, true));
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </SetRow>
  );
}

/** Launch at login, close to tray and the local herdr-pocket login (desktop builds only). */
export function StartupRows() {
  if (!DESKTOP) return null;
  return (
    <>
      <SetHeading>启动与窗口</SetHeading>
      <ConfigSwitch k="general.launchAtLogin" about="开机自启" />
      <ConfigSwitch k="general.closeToTray" about="关闭时留在托盘" />
      <ConfigSwitch k="general.useLocalLogin" about="首次沿用本机登录" />
    </>
  );
}

function GuideRow({ onReopenGuide }: { onReopenGuide: () => void }) {
  return (
    <>
      <SetHeading>新手引导</SetHeading>
      <SetRow title="重新打开新手引导" about="重走本机连接与语音配置">
        <PocketButton size="sm" variant="soft" onClick={onReopenGuide}>
          打开引导
        </PocketButton>
      </SetRow>
    </>
  );
}

export function GeneralPane({ onReopenGuide }: { onReopenGuide: () => void }) {
  const toast = useToast();
  const general = useClientConfig().general;
  const textSpec = configKeySpec("general.textScale");
  const textPresets = [90, 100, 115, 130].filter((v) => v >= (textSpec?.min ?? 80) && v <= (textSpec?.max ?? 160));
  return (
    <div className="pane">
      <PaneTitle title="通用" />
      <SetHeading>外观</SetHeading>
      <ThemeRow />
      <SetRow title="文字大小" about={`当前 ${general.textScale}%`}>
        <div className="segmented">
          {textPresets.map((pct) => (
            <button
              key={pct}
              className={general.textScale === pct ? "active" : ""}
              onClick={() => void setConfig("general.textScale", pct).catch((e: Error) => toast(e.message, true))}
            >
              {pct === 100 ? "标准" : pct < 100 ? "小" : pct < 120 ? "大" : "特大"}
            </button>
          ))}
        </div>
      </SetRow>
      <ChatDisplayModeRow />
      <ConfigSwitch k="general.showShells" about="列出普通 Shell 终端" />
      {DESKTOP ? <TerminalSettingsSection /> : null}
      <StartupRows />
      <ConfigFileBlock />
      <GuideRow onReopenGuide={onReopenGuide} />
    </div>
  );
}

/** The relay link as a word and a badge tone. */
export function linkLabel(link: string): { tone: "mint" | "lav" | "blush"; text: string } {
  return {
    tone: link === "online" ? "mint" : link === "connecting" ? "lav" : "blush",
    text: link === "online" ? "已连接" : link === "connecting" ? "正在连接" : link === "unauthorized" ? "授权失效" : link === "offline" ? "已断开" : "未连接",
  };
}

/** This computer's herdr-pocket state, read once and on demand. */
export function useHostdStatus() {
  const [hostd, setHostd] = useState<HostdLocalStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const recheck = () => {
    setChecking(true);
    void getHostdStatus()
      .then(setHostd)
      .finally(() => setChecking(false));
  };
  useEffect(recheck, []);
  return { hostd, checking, recheck };
}

export function SignOutBlock() {
  return (
    <>
      <SetHeading>退出</SetHeading>
      <SetRow title="退出并解绑这台设备" about="退出后需重新配对连接">
        <PocketButton size="sm" variant="danger" onClick={() => void signOut()}>
          <LogOut size={14} />
          <span>退出</span>
        </PocketButton>
      </SetRow>
    </>
  );
}

export function ConnectionPane({ onConnectRelay, onPairPhone }: { onConnectRelay: () => void; onPairPhone: () => void }) {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const deviceName = settingsStore.use((s) => s.deviceName);
  const link = liveStore.use((s) => s.link);
  const devices = liveStore.use((s) => s.devices);
  const { hostd, checking, recheck } = useHostdStatus();
  const phones = Object.values(devices).filter((d) => d.kind === "viewer");
  const { tone: statusTone, text: statusText } = linkLabel(link);
  return (
    <div className="pane">
      <PaneTitle title="连接" />
      <SetHeading>中转服务器</SetHeading>
      <SetRow title={serverLabel(server)} about={`设备名：${deviceName || "未命名"}`}>
        <PocketBadge tone={statusTone} pulse={link === "connecting"}>
          {statusText}
        </PocketBadge>
      </SetRow>
      <div className="row wrap" style={{ gap: 8, padding: "12px 0" }}>
        <PocketButton variant="primary" onClick={onPairPhone}>
          <QrCode size={15} />
          <span>扫码连接手机</span>
        </PocketButton>
        <PocketButton variant="soft" onClick={onConnectRelay}>
          <Server size={15} />
          <span>连接别的中转服务器</span>
        </PocketButton>
        {server && !isMockServer(server) ? (
          <PocketButton
            variant="ghost"
            onClick={async () => {
              const ok = await copyToClipboard(server);
              toast(ok ? "服务器地址已复制" : "复制失败", !ok);
            }}
          >
            <Copy size={14} />
            <span>复制地址</span>
          </PocketButton>
        ) : null}
      </div>
      {phones.length ? (
        <SetRow title="已连接的手机和桌面端" about={phones.map((p) => `${p.name}（${p.online ? "在线" : `上次 ${relTime(p.lastSeenAt)}`}）`).join("、")} />
      ) : null}

      {hostd ? (
        <>
          <SetHeading>本机服务</SetHeading>
          <div className="faint" style={{ paddingBottom: 10 }}>
            {hostd.configured
              ? `已登录（${hostd.deviceName || "本机"} → ${serverLabel(hostd.server ?? null)}）`
              : hostd.installed
                ? "已安装，请在终端运行 herdr-pocket up 登录"
                : "本机未接入，安装并登录后可作为运行主机"}
          </div>
          <LocalHostDeps status={hostd} server={server && !isMockServer(server) ? server : undefined} checking={checking} onRecheck={recheck} />
        </>
      ) : null}

      <SignOutBlock />
    </div>
  );
}

export function NotificationsPane() {
  const denoise = settingsStore.use((s) => s.denoise);
  const alertSound = settingsStore.use((s) => s.alertSound);
  const alertChimeOnlyLongTasks = settingsStore.use((s) => s.alertChimeOnlyLongTasks);
  return (
    <div className="pane">
      <PaneTitle title="通知" />
      <ConfigSwitch
        k="general.notifications"
        about="完成或需要确认时提醒"
        onChanged={(v) => {
          updateSettings({ notifications: v });
          void refreshNotifyChannel();
        }}
      />
      <SetRow title="提示音" about="后台 Agent 需要你确认或长任务完成时播放轻柔提示音">
        <PocketSwitch checked={alertSound} onCheckedChange={(v) => updateSettings({ alertSound: v })} label="提示音" />
      </SetRow>
      <SetRow title="仅长耗时任务完成时响铃" about="超过 45 秒完成的任务才播放完成提示音（阻塞确认始终响铃）">
        <PocketSwitch
          checked={alertChimeOnlyLongTasks}
          onCheckedChange={(v) => updateSettings({ alertChimeOnlyLongTasks: v })}
          label="仅长耗时任务完成时响铃"
        />
      </SetRow>
      <SetRow title="测试通知">
        <PocketButton size="sm" variant="ghost" onClick={() => void pushSystemNotification("Herdr Pocket", "通知能正常弹出")}>
          发一条试试
        </PocketButton>
      </SetRow>
      <SetHeading>和小羊通话</SetHeading>
      <SetRow title="通话降噪" about="系统回声消除与降噪">
        <PocketSwitch checked={denoise} onCheckedChange={(v) => updateSettings({ denoise: v })} label="通话降噪" />
      </SetRow>
    </div>
  );
}

export function BrowserPane() {
  const toast = useToast();
  const cfg = useClientConfig();
  const [home, setHome] = useState(cfg.browser.homePage);
  useEffect(() => setHome(cfg.browser.homePage), [cfg.browser.homePage]);
  return (
    <div className="pane">
      <PaneTitle title="浏览器与文件" />
      <SetHeading>内置浏览器</SetHeading>
      <SetRow title="主页" about="留空为空白页" stack>
        <PocketInput
          value={home}
          placeholder="https://example.com"
          onChange={(e) => setHome(e.target.value)}
          onBlur={() => {
            if (home.trim() === cfg.browser.homePage) return;
            void setConfig("browser.homePage", home.trim()).then(
              () => toast("主页已保存"),
              (e: Error) => toast(e.message, true),
            );
          }}
        />
      </SetRow>
      <ConfigSelect
        k="browser.searchEngine"
        options={[
          { value: "bing", label: "必应" },
          { value: "baidu", label: "百度" },
          { value: "google", label: "Google" },
          { value: "duckduckgo", label: "DuckDuckGo" },
        ]}
      />
      <ConfigSwitch k="browser.clearOnExit" about="退出时清理 Cookie 与缓存" />
      <SetHeading>登录状态</SetHeading>
      <ConfigSelect
        k="browser.cookieImport"
        about="仅本地导入常用浏览器 Cookie"
        options={[
          { value: "ask", label: "需要时可以导入" },
          { value: "off", label: "从不读取" },
        ]}
      />
      {cfg.browser.cookieImport !== "off" ? (
        <SetRow title="现在导入">
          <CookieImportButton />
        </SetRow>
      ) : null}
      <SetHeading>文件查看</SetHeading>
      <ConfigSwitch k="files.showHidden" />
      <ConfigSwitch k="files.showIgnored" about="显示 .git / node_modules" />
    </div>
  );
}

export function UpdatesPane() {
  const toast = useToast();
  const st = updateStore.use((s) => s);
  // Re-renders when update.region or update.mirrors change, so the order shown stays current.
  const updateCfg = useClientConfig().update;
  const decision = currentRegion();
  const [notes, setNotes] = useState<ReleaseNotes | null | "loading">(null);
  const latest = st.info?.hasUpdate ? st.info.latest : null;
  useEffect(() => {
    if (!latest) return;
    if (st.info?.notes?.body) {
      setNotes(st.info.notes);
      return;
    }
    let alive = true;
    setNotes("loading");
    void fetchReleaseNotes().then((n) => alive && setNotes(n));
    return () => {
      alive = false;
    };
  }, [latest, st.info?.notes]);
  useEffect(() => {
    if (updateStore.get().probes.length === 0 && !updateStore.get().probing) {
      void probeMirrorsNow(false);
    }
  }, []);
  const candidateSources = sourcePrefixes(decision.region, updateCfg.mirrors);
  const ownCount = new Set(updateCfg.mirrors.filter(isMirrorPrefix)).size;
  const fastestSource = pickLowestLatency(st.probes, candidateSources);
  const fastestProbe =
    fastestSource !== undefined ? st.probes.find((p) => p.source === fastestSource && p.ok) : undefined;
  const fastestLabel = fastestProbe ? sourceLabel(fastestProbe.source) : "";
  const fastestMs = fastestProbe?.ms;
  const preferredValue = updateCfg.preferredSource || "auto";
  const rawSourceOptions: SelectOption[] = [
    {
      value: "auto",
      label: fastestLabel ? `自动 · ${fastestLabel}` : "自动（时区推荐 · 最低延迟）",
      ...(fastestMs !== undefined
        ? { badge: `${fastestMs} ms` }
        : st.probing
          ? { badge: "测速中" }
          : {}),
      tone: "accent",
    },
    ...candidateSources.map((s): SelectOption => {
      const value = s === DIRECT_SOURCE ? "direct" : s;
      const host = sourceLabel(s);
      const probe = st.probes.find((p) => p.source === s);
      const badge = !probe
        ? st.probing
          ? "测速中"
          : "待测速"
        : probe.ok
          ? `${probe.ms} ms`
          : probe.error === "slower than the winner"
            ? "待测速"
            : "不通";
      const recommended = isRecommendedSourceForRegion(s, decision.region, candidateSources, ownCount);
      const isFastest = fastestProbe !== undefined && fastestProbe.source === s;
      return {
        value,
        label: `${host}${recommended ? " · 时区推荐" : ""}${isFastest ? " · 最快" : ""}`,
        badge,
        ...(isFastest ? { tone: "accent" as const } : {}),
      };
    }),
  ];
  const sourceOptions = rawSourceOptions.some((o) => o.value === preferredValue)
    ? rawSourceOptions
    : [...rawSourceOptions, { value: preferredValue, label: `${sourceLabel(preferredValue)}（已配置）` }];
  const pageUrl = st.info?.pageUrl || RELEASES_PAGE;
  const phase = st.installPhase;
  const busy =
    phase === "downloading" ||
    phase === "verifying" ||
    phase === "staging" ||
    phase === "restarting";
  const pct = st.progress?.percent ?? null;

  let statusAbout = "还没检查过";
  if (st.checking) statusAbout = "正在向 GitHub 与镜像线路并发查询…";
  else if (st.error) statusAbout = st.error;
  else if (phase === "error" && st.installError) statusAbout = st.installError;
  else if (phase === "ready" && st.info) statusAbout = `v${st.info.latest} 已下载并校验通过，点击右侧重启完成更新`;
  else if (phase === "downloading" && st.progress) {
    const dlMb = (st.progress.downloadedBytes / (1024 * 1024)).toFixed(1);
    const totMb = st.progress.totalBytes ? ` / ${(st.progress.totalBytes / (1024 * 1024)).toFixed(1)} MB` : " MB";
    statusAbout = `正在下载更新（${dlMb}${totMb}${pct !== null ? ` · ${pct}%` : ""}）`;
  } else if (phase === "verifying") statusAbout = st.progress?.message || "正在校验 SHA-256…";
  else if (phase === "staging") statusAbout = st.progress?.message || "正在校验签名并准备安装…";
  else if (phase === "restarting") statusAbout = "正在重启并安装新版本…";
  else if (st.info) {
    statusAbout = st.info.hasUpdate
      ? `发现新版本 v${st.info.latest}`
      : `已是最新版本 v${st.info.latest}${st.checkedAt ? `（${relTime(st.checkedAt)}检查）` : ""}`;
  } else if (st.checkedAt) {
    statusAbout = `上次检查：${relTime(st.checkedAt)}`;
  }

  return (
    <div className="pane">
      <PaneTitle title="更新" />
      <SetRow title={`当前版本 v${appVersion()}`} about={statusAbout}>
        <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
          {st.info?.hasUpdate ? (
            phase === "ready" ? (
              <PocketButton size="sm" variant="primary" onClick={() => void restartToApplyUpdate()}>
                <RotateCcw size={14} />
                <span>立即重启并更新</span>
              </PocketButton>
            ) : busy ? (
              <PocketButton size="sm" variant="soft" disabled>
                <RefreshCw size={14} />
                <span>{phase === "staging" ? "准备中…" : phase === "verifying" ? "校验中…" : phase === "restarting" ? "重启中…" : `下载中${pct !== null ? ` ${pct}%` : "…"}`}</span>
              </PocketButton>
            ) : phase === "error" ? (
              <>
                <PocketButton size="sm" variant="primary" onClick={() => void startUpdateDownload()}>
                  <RefreshCw size={14} />
                  <span>重试下载</span>
                </PocketButton>
                <PocketButton size="sm" variant="ghost" onClick={() => void openExternalUrl(st.info!.downloadUrl)}>
                  <ExternalLink size={14} />
                  <span>浏览器下载</span>
                </PocketButton>
              </>
            ) : (
              <PocketButton size="sm" variant="primary" onClick={() => void startUpdateDownload()}>
                <Download size={14} />
                <span>立即下载更新 v{st.info.latest}</span>
              </PocketButton>
            )
          ) : null}
          <PocketButton size="sm" variant="soft" disabled={st.checking || busy} onClick={() => void checkForUpdate("manual").then((i) => i && !i.hasUpdate && toast("已是最新版本"))}>
            <RefreshCw size={14} />
            <span>{st.checking ? "检查中…" : "检查更新"}</span>
          </PocketButton>
        </div>
      </SetRow>
      {phase === "downloading" || phase === "verifying" || phase === "staging" ? (
        <div className="update-inline-progress" aria-hidden>
          <div className="update-toast-track">
            <div
              className={`update-toast-fill${pct === null || phase !== "downloading" ? " pulse" : ""}`}
              style={{ width: `${pct !== null ? Math.max(4, pct) : 100}%` }}
            />
          </div>
        </div>
      ) : null}
      {st.info?.hasUpdate ? (
        <div className="release-notes">
          {notes === "loading" ? (
            <div className="faint">正在读取更新说明…</div>
          ) : notes ? (
            <>
              <div className="release-notes-body">
                <RichMarkdown text={notes.body.length > 2400 ? `${notes.body.slice(0, 2400)}…` : notes.body} />
              </div>
              <button className="link-btn" onClick={() => void openExternalUrl(notes.url || pageUrl)}>
                在网页上看完整说明
              </button>
            </>
          ) : (
            <button className="link-btn" onClick={() => void openExternalUrl(pageUrl)}>
              查看更新说明
            </button>
          )}
        </div>
      ) : null}
      <ConfigSwitch k="update.autoCheck" about="有新版本时右下角提示" />
      <ConfigSelect
        k="update.checkIntervalHours"
        options={[
          { value: "0.25", label: "15 分钟" },
          { value: "0.5", label: "30 分钟（默认）" },
          { value: "1", label: "1 小时" },
          { value: "2", label: "2 小时" },
          { value: "6", label: "6 小时" },
          { value: "12", label: "12 小时" },
          { value: "24", label: "1 天" },
          { value: "72", label: "3 天" },
        ]}
      />
      <SetHeading>下载来源</SetHeading>
      <ConfigSelect
        k="update.region"
        about="按时区自动决定先后顺序"
        options={[
          {
            value: "auto",
            label:
              decision.reason === "env" || decision.reason === "config"
                ? "按时区自动"
                : `按时区自动（${decision.region === "cn" ? "镜像优先" : "直连优先"}）`,
          },
          { value: "cn", label: "镜像优先" },
          { value: "global", label: "GitHub 直连优先" },
        ]}
      />
      <SetRow title="镜像源" about="时区推荐优先，自动选最低延迟">
        <div className="row" style={{ gap: 8, alignItems: "center", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%" }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <PocketSelect
              ariaLabel="镜像源"
              value={preferredValue}
              options={sourceOptions}
              onValueChange={(v) => {
                void setConfig("update.preferredSource", v).catch((e: Error) => toast(e.message, true));
              }}
            />
          </div>
          <PocketButton
            size="sm"
            variant="soft"
            style={{ flexShrink: 0 }}
            disabled={st.probing}
            onClick={() =>
              void probeMirrorsNow(true).then((probes) => {
                const win = pickLowestLatency(probes, candidateSources);
                const hit = win !== undefined ? probes.find((p) => p.source === win && p.ok) : undefined;
                if (hit) toast(`测速完成：最快 ${sourceLabel(hit.source)}（${hit.ms} ms）`);
                else toast("测速完成：当前没有可用线路", true);
              })
            }
          >
            <RefreshCw size={14} />
            <span>{st.probing ? "测速中" : "测速"}</span>
          </PocketButton>
        </div>
      </SetRow>
      <MirrorsRow mirrors={updateCfg.mirrors} />
      <ToolVersionsSection />
    </div>
  );
}

/** update.mirrors: the user's own GitHub mirror prefixes, raced before the built-in ones. */
function MirrorsRow({ mirrors }: { mirrors: readonly string[] }) {
  const toast = useToast();
  const [text, setText] = useState(mirrors.join("\n"));
  useEffect(() => setText(mirrors.join("\n")), [mirrors]);
  const dirty = text.trim() !== mirrors.join("\n");
  const save = async () => {
    const list = text
      .split(/[\s,]+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.endsWith("/") ? l : `${l}/`));
    try {
      await setConfig("update.mirrors", list.length ? list : undefined);
      toast(list.length ? `已保存 ${list.length} 个自定义镜像` : "已清空自定义镜像");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <SetRow title={configKeySpec("update.mirrors")?.label ?? "自定义镜像"} about="每行一个 https://.../，优先测速">
      <div className="stack" style={{ gap: 6, minWidth: 220 }}>
        <PocketTextarea rows={2} mono value={text} placeholder="https://mirror.example.com/" onChange={(e) => setText(e.target.value)} />
        {dirty ? (
          <PocketButton size="sm" variant="soft" onClick={() => void save()}>
            保存
          </PocketButton>
        ) : null}
      </div>
    </SetRow>
  );
}

function mb(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function PerformancePane() {
  const toast = useToast();
  const hidden = useWindowHidden();
  const cfg = useClientConfig().resources;
  const [u, setU] = useState<ResourceUsage | null>(null);
  const [polled, setPolled] = useState(false);
  // Sampled only while this pane is open and the window is visible.
  useEffect(() => {
    if (hidden) return;
    let alive = true;
    const look = () =>
      void native.getResourceUsage().then((x) => {
        if (!alive) return;
        setU(x);
        setPolled(true);
      });
    look();
    const t = setInterval(look, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [hidden]);
  const mem = u ? (u.process.footprintBytes ?? u.process.rssBytes) + (u.process.webviewBytes ?? 0) : null;
  const memWarn = mem !== null && mem > cfg.memoryWarnMb * 1024 ** 2;
  const diskWarn = u?.diskFreeBytes !== undefined && u.diskFreeBytes < cfg.diskWarnGb * 1024 ** 3;
  return (
    <div className="pane">
      <PaneTitle title="性能与资源" />
      {polled && !u ? <div className="faint" style={{ padding: "8px 0" }}>当前版本或平台读不到资源占用。</div> : null}
      {u ? (
        <div className="meter-grid">
          <div className={`meter${memWarn ? " warn" : ""}`}>
            <div className="faint">内存</div>
            <div className="meter-num num">{mb(mem)}</div>
            <div className="faint">提醒线 {cfg.memoryWarnMb} MB</div>
          </div>
          <div className="meter">
            <div className="faint">CPU</div>
            <div className="meter-num num">{u.cpuPercent !== undefined ? `${u.cpuPercent.toFixed(1)}%` : "—"}</div>
            <div className="faint">{u.wakeupsPerSec !== undefined ? `唤醒 ${u.wakeupsPerSec.toFixed(1)} 次/秒` : "本进程"}</div>
          </div>
          <div className={`meter${diskWarn ? " warn" : ""}`}>
            <div className="faint">磁盘剩余</div>
            <div className="meter-num num">{mb(u.diskFreeBytes)}</div>
            <div className="faint">提醒线 {cfg.diskWarnGb} GB</div>
          </div>
          <div className="meter">
            <div className="faint">本应用占用</div>
            <div className="meter-num num">{mb(u.logBytes + u.cacheBytes + u.browserDataBytes)}</div>
            <div className="faint">日志 {mb(u.logBytes)} · 缓存 {mb(u.cacheBytes)} · 浏览器 {mb(u.browserDataBytes)}</div>
          </div>
        </div>
      ) : null}
      {u?.warnings.length ? <div className="inline-alert">{u.warnings.join("；")}</div> : null}
      <SetHeading>省电</SetHeading>
      <ConfigSelect
        k="resources.lowPower"
        about={u ? `当前${u.onBattery ? "电池" : "电源"}${u.lowPower ? " · 省电中" : ""}` : "自动省电"}
        options={[
          { value: "auto", label: "自动（用电池时开启）" },
          { value: "on", label: "一直开启" },
          { value: "off", label: "关闭" },
        ]}
      />
      <ConfigSelect k="resources.memoryWarnMb" options={[512, 1024, 2048, 4096].map((n) => ({ value: String(n), label: `${n} MB` }))} />
      <ConfigSelect k="resources.diskWarnGb" options={[1, 5, 10, 20, 50].map((n) => ({ value: String(n), label: `${n} GB` }))} />
      <SetHeading>清理</SetHeading>
      <SetRow title="清理缓存" about="清除缓存与内置浏览器数据">
        <PocketButton
          size="sm"
          variant="ghost"
          disabled={!native.available()}
          onClick={async () => {
            try {
              const freed = await native.clearCaches();
              toast(`清理了 ${mb(freed)}`);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <Trash2 size={14} />
          <span>清理</span>
        </PocketButton>
      </SetRow>
    </div>
  );
}

/** `onReopenGuide`: the settings frame has no 通用 section, so the guide row lives here. */
export function AboutPane({ onReopenGuide }: { onReopenGuide?: () => void } = {}) {
  const repo = `https://github.com/${RELEASE_REPO}`;
  return (
    <div className="pane">
      <PaneTitle title="关于" />
      <SetRow title={`Herdr Pocket v${appVersion()}`} about={`${PLATFORM_LABEL[detectPlatform()] ?? detectPlatform()} 版 · 开源许可 AGPL-3.0-only`} />
      <ConfigFileBlock />
      <SetHeading>链接</SetHeading>
      <SetRow title="项目主页">
        <PocketButton size="sm" variant="ghost" onClick={() => void openExternalUrl(repo)}>
          <ExternalLink size={14} />
          <span>打开</span>
        </PocketButton>
      </SetRow>
      <SetRow title="配置项说明">
        <PocketButton size="sm" variant="ghost" onClick={() => void openExternalUrl(`${repo}/blob/main/docs/config.md`)}>
          <ExternalLink size={14} />
          <span>打开</span>
        </PocketButton>
      </SetRow>
      {onReopenGuide ? <GuideRow onReopenGuide={onReopenGuide} /> : null}
    </div>
  );
}
