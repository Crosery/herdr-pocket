import { useEffect, useState } from "react";
import { Copy, Download, ExternalLink, FileText, FolderOpen, LogOut, QrCode, RefreshCw, Server, Trash2 } from "lucide-react";
import { RELEASES_PAGE, RELEASE_REPO, configKeySpec, sourceLabel } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketInput, PocketSwitch, PocketTextarea, useToast } from "../../components/PocketUI";
import { LocalHostDeps } from "../../components/LocalHostDeps";
import { CookieImportButton } from "../../components/CookieImport";
import { serverLabel } from "../../components/Sidebar";
import { appVersion, copyToClipboard, detectPlatform, getHostdStatus, openExternalUrl, pushSystemNotification, type HostdLocalStatus } from "../../lib/bridge";
import { native, type ResourceUsage } from "../../lib/native";
import { clientConfigStore, setConfig, useClientConfig } from "../../lib/config";
import { checkForUpdate, currentRegion, fetchReleaseNotes, lastSourceSentence, orderSentence, regionReason, sourceOrder, updateStore, type ReleaseNotes } from "../../lib/updates";
import { RichMarkdown } from "../../lib/markdown";
import { isMockServer } from "../../lib/mock";
import { refreshNotifyChannel, signOut } from "../../lib/relay";
import { liveStore, relTime, settingsStore, updateSettings } from "../../lib/store";
import { useWindowHidden } from "../../lib/layout";
import { ConfigSelect, ConfigSwitch, PaneTitle, SetHeading, SetRow } from "./rows";
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
        about={
          <>
            <span className="mono wrap-anywhere">{path || "这个平台把这些设置存在应用自己的存储里"}</span>
            <br />
            命令行 herdr-pocket config 和桌面端读写同一个文件，手动改完立即生效。
          </>
        }
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
      <div className="where-settings">
        <div>
          <strong>存在这个文件里</strong>：外观与启动、更新、日志、语音输入、浏览器与文件、性能与资源。只在这台电脑生效，命令行也能改。
        </div>
        <div>
          <strong>存在中转服务器上</strong>：小羊助理的模型、密钥、提示词和声音。手机和每台电脑看到的是同一份。
        </div>
        <div>
          <strong>只在这个应用里</strong>：登录状态、窗口和侧栏的样子、新手引导进度。
        </div>
      </div>
    </>
  );
}

/** general.theme as a segmented control; the app applies it at once and keeps the file in step. */
export function ThemeRow() {
  const toast = useToast();
  const theme = useClientConfig().general.theme;
  return (
    <SetRow title="外观" about="浅色、暗色，或跟随系统。">
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
      <ConfigSwitch k="general.launchAtLogin" about="登录电脑后自动打开，在后台盯着 Agent。" />
      <ConfigSwitch k="general.closeToTray" about="点关闭按钮时只隐藏窗口，图标留在菜单栏 / 托盘，通知照常。" />
      <ConfigSwitch k="general.useLocalLogin" about="这台电脑的 herdr-pocket 已登录时，首次打开自动用它连上同一个中转服务器。" />
    </>
  );
}

function GuideRow({ onReopenGuide }: { onReopenGuide: () => void }) {
  return (
    <>
      <SetHeading>新手引导</SetHeading>
      <SetRow title="重新打开新手引导" about="一步步检查本机、连接中转服务器、扫码连接手机和设置语音输入。">
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
      <SetRow title="文字大小" about={`当前 ${general.textScale}%，只影响这台电脑上的桌面端。`}>
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
      <ConfigSwitch k="general.showShells" about="在 Agent 列表里也列出没跑 Agent 的普通终端。" />
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
      <SetRow title="退出并解绑这台设备" about="会从服务器的设备列表里移除这台设备；之后要重新连接。">
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
      <PaneTitle title="连接" about="中转服务器让手机和各台电脑隔着网络也能互相找到。" />
      <SetHeading>中转服务器</SetHeading>
      <SetRow title={serverLabel(server)} about={`这台设备在服务器上叫“${deviceName || "未命名"}”。`}>
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
          <SetHeading>这台电脑的 Agent</SetHeading>
          <div className="faint" style={{ paddingBottom: 10 }}>
            {hostd.configured
              ? `这台电脑已登录 herdr-pocket（${hostd.deviceName || "本机"} → ${serverLabel(hostd.server ?? null)}），它的 Agent 会出现在 Pocket 里。`
              : hostd.installed
                ? "找到了 herdr-pocket 的配置，但还没登录：在终端运行 herdr-pocket up。"
                : "这台电脑还没接入：要让它的 Agent 出现在 Pocket 里，标红的都要装好。只看别的电脑可以不管。"}
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
  return (
    <div className="pane">
      <PaneTitle title="通知" />
      <ConfigSwitch
        k="general.notifications"
        about="Agent 需要你或干完活时弹出系统通知。"
        onChanged={(v) => {
          updateSettings({ notifications: v });
          void refreshNotifyChannel();
        }}
      />
      <SetRow title="测试通知" about="没弹出来：到系统设置的“通知”里允许 Herdr Pocket。">
        <PocketButton size="sm" variant="ghost" onClick={() => void pushSystemNotification("Herdr Pocket", "通知能正常弹出")}>
          发一条试试
        </PocketButton>
      </SetRow>
      <SetHeading>和小羊通话</SetHeading>
      <SetRow title="通话降噪" about="通话时打开系统的回声消除和环境降噪，只影响这台设备。">
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
      <PaneTitle title="浏览器与文件" about="工作台里的内置浏览器和文件查看。" />
      <SetHeading>内置浏览器</SetHeading>
      <SetRow title="主页" about="新开网页标签时打开的地址，留空就是空白页。" stack>
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
        about="地址栏里输入的不是网址时，用它来搜索。"
        options={[
          { value: "bing", label: "必应" },
          { value: "baidu", label: "百度" },
          { value: "google", label: "Google" },
          { value: "duckduckgo", label: "DuckDuckGo" },
        ]}
      />
      <ConfigSwitch k="browser.clearOnExit" about="退出应用时清掉内置浏览器的 Cookie 和缓存。" />
      <SetHeading>登录状态</SetHeading>
      <ConfigSelect
        k="browser.cookieImport"
        about="从这台电脑的 Chrome、Edge、Safari 等读取 Cookie，免得在内置浏览器里重新登录。每次导入前都会先问你；Cookie 只存在本机。"
        options={[
          { value: "ask", label: "需要时可以导入" },
          { value: "off", label: "从不读取" },
        ]}
      />
      {cfg.browser.cookieImport !== "off" ? (
        <SetRow title="现在导入" about="导入后，内置浏览器里的网站会沿用那个浏览器的登录。">
          <CookieImportButton />
        </SetRow>
      ) : null}
      <SetHeading>文件查看</SetHeading>
      <ConfigSwitch k="files.showHidden" about="在文件树里显示以“.”开头的文件。" />
      <ConfigSwitch k="files.showIgnored" about="显示 node_modules、.git、dist 这类很大的生成目录。" />
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
    let alive = true;
    setNotes("loading");
    void fetchReleaseNotes().then((n) => alive && setNotes(n));
    return () => {
      alive = false;
    };
  }, [latest]);
  const pageUrl = st.info?.pageUrl || RELEASES_PAGE;
  const words = (r: "cn" | "global") => sourceOrder(r).slice(0, 2).join("、");
  return (
    <div className="pane">
      <PaneTitle title="更新" />
      <SetRow
        title={`当前版本 v${appVersion()}`}
        about={
          st.checking
            ? "正在检查…"
            : st.error
              ? st.error
              : st.info
                ? st.info.hasUpdate
                  ? `有新版本 v${st.info.latest}`
                  : `已是最新版本${st.checkedAt ? `（${relTime(st.checkedAt)}检查）` : ""}`
                : st.checkedAt
                  ? `上次检查：${relTime(st.checkedAt)}`
                  : "还没检查过"
        }
      >
        <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
          {st.info?.hasUpdate ? (
            <PocketButton size="sm" variant="primary" onClick={() => void openExternalUrl(st.info!.downloadUrl)}>
              <Download size={14} />
              <span>下载 v{st.info.latest}</span>
            </PocketButton>
          ) : null}
          <PocketButton size="sm" variant="soft" disabled={st.checking} onClick={() => void checkForUpdate("manual").then((i) => i && !i.hasUpdate && toast("已是最新版本"))}>
            <RefreshCw size={14} />
            <span>{st.checking ? "检查中…" : "检查更新"}</span>
          </PocketButton>
        </div>
      </SetRow>
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
      <ConfigSwitch k="update.autoCheck" about="隔一段时间看看有没有新版本，有就在侧栏“设置”旁亮一个小点。" />
      <ConfigSelect
        k="update.checkIntervalHours"
        about="自动检查的间隔。"
        options={[6, 12, 24, 72, 168].map((h) => ({ value: String(h), label: h < 24 ? `${h} 小时` : `${h / 24} 天` }))}
      />
      <SetHeading>下载来源</SetHeading>
      <ConfigSelect
        k="update.region"
        about={`现在${regionReason(decision)}，${orderSentence(decision.region)}。命令行和这台电脑的后台服务也用这一项。`}
        options={[
          // With an explicit choice (or the env override) in force, "auto" would be decided by time zone.
          { value: "auto", label: decision.reason === "env" || decision.reason === "config" ? "自动（按时区）" : `自动（现在：${decision.region === "cn" ? "镜像" : "直连"}优先）` },
          { value: "cn", label: `镜像优先（${words("cn")}）` },
          { value: "global", label: `直连优先（${words("global")}）` },
        ]}
      />
      {st.info ? (
        <SetRow title="上次用的线路" about={lastSourceSentence(st.info)}>
          {st.info.probes?.length ? (
            <div className="source-list" style={{ justifyContent: "flex-end", marginTop: 0 }}>
              {st.info.probes.map((p) => {
                const label = sourceLabel(p.source) || p.source;
                return (
                  <span key={p.source || "direct"} className={`source-chip num${label === st.info!.source ? " used" : ""}`} title={p.error}>
                    {label} {p.ok ? `${(p.ms / 1000).toFixed(1)} 秒` : "不通"}
                  </span>
                );
              })}
            </div>
          ) : null}
        </SetRow>
      ) : null}
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
    <SetRow title={configKeySpec("update.mirrors")?.label ?? "自定义镜像"} about="自己的 GitHub 镜像地址，一行一个（以 https:// 开头、/ 结尾），会排在内置线路前面一起测速。">
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
      <PaneTitle title="性能与资源" about="只在这个页面打开时每 5 秒看一次，关掉就停。" />
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
        about={`开启后放慢后台刷新、关掉动画。${u ? `现在${u.onBattery ? "用电池供电" : "接着电源"}${u.lowPower ? "，省电模式生效中" : ""}。` : ""}`}
        options={[
          { value: "auto", label: "自动（用电池时开启）" },
          { value: "on", label: "一直开启" },
          { value: "off", label: "关闭" },
        ]}
      />
      <ConfigSelect k="resources.memoryWarnMb" about="本应用用的内存超过它时提醒你。" options={[512, 1024, 2048, 4096].map((n) => ({ value: String(n), label: `${n} MB` }))} />
      <ConfigSelect k="resources.diskWarnGb" about="磁盘剩余空间低于它时提醒你。" options={[1, 5, 10, 20, 50].map((n) => ({ value: String(n), label: `${n} GB` }))} />
      <SetHeading>清理</SetHeading>
      <SetRow title="清理缓存" about="删掉本应用的缓存和内置浏览器的数据（会退出内置浏览器里的登录），不影响设置和配对。">
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
      <SetRow title="项目主页" about="源码、问题反馈和安装包。">
        <PocketButton size="sm" variant="ghost" onClick={() => void openExternalUrl(repo)}>
          <ExternalLink size={14} />
          <span>打开</span>
        </PocketButton>
      </SetRow>
      <SetRow title="配置项说明" about="config.json 每一项的含义和默认值。">
        <PocketButton size="sm" variant="ghost" onClick={() => void openExternalUrl(`${repo}/blob/main/docs/config.md`)}>
          <ExternalLink size={14} />
          <span>打开</span>
        </PocketButton>
      </SetRow>
      {onReopenGuide ? <GuideRow onReopenGuide={onReopenGuide} /> : null}
    </div>
  );
}
