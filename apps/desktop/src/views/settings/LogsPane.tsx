import { useEffect, useMemo, useState } from "react";
import { Copy, FileDown, FolderOpen, RefreshCw, Upload } from "lucide-react";
import type { LogEntry as RelayLogEntry } from "@herdr-pocket/protocol";
import { PocketButton, PocketInput, PocketSelect, PocketSwitch, useToast } from "../../components/PocketUI";
import { appVersion, copyToClipboard, detectPlatform } from "../../lib/bridge";
import { native, type LogFolderInfo } from "../../lib/native";
import { formatLogLine, logStore, redact, type LogLevel } from "../../lib/log";
import { useWindowHidden } from "../../lib/layout";
import { getActiveToken, restRequest } from "../../lib/relay";
import { isMockServer } from "../../lib/mock";
import { liveStore, settingsStore } from "../../lib/store";
import { ConfigSelect, ConfigSwitch, PaneTitle, SetHeading, SetRow } from "./rows";

const LEVELS: Array<{ value: LogLevel | "all"; label: string }> = [
  { value: "all", label: "全部" },
  { value: "info", label: "信息及以上" },
  { value: "warn", label: "警告及以上" },
  { value: "error", label: "只看错误" },
];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function LevelFilter({ value, onChange }: { value: LogLevel | "all"; onChange: (v: LogLevel | "all") => void }) {
  return (
    <div className="segmented wrap-ok">
      {LEVELS.map((l) => (
        <button key={l.value} className={value === l.value ? "active" : ""} onClick={() => onChange(l.value)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

function passes(level: LogLevel, min: LogLevel | "all"): boolean {
  return min === "all" || RANK[level] >= RANK[min];
}

const SHOW = 400;

export function LogsPane() {
  const toast = useToast();
  const entries = logStore.use((s) => s.entries);
  const server = settingsStore.use((s) => s.server);
  const link = liveStore.use((s) => s.link);
  const [level, setLevel] = useState<LogLevel | "all">("info");
  const [text, setText] = useState("");
  const [folder, setFolder] = useState<LogFolderInfo | null>(null);
  const [srvLevel, setSrvLevel] = useState<LogLevel | "all">("warn");
  const [srvSource, setSrvSource] = useState<"" | "relay" | "host" | "viewer">("");
  const [srvSince, setSrvSince] = useState("1h");
  const [srvText, setSrvText] = useState("");
  const [srv, setSrv] = useState<RelayLogEntry[] | null>(null);
  const [srvError, setSrvError] = useState<string | null>(null);
  const [srvLoading, setSrvLoading] = useState(false);
  const [follow, setFollow] = useState(true);
  const hidden = useWindowHidden();

  useEffect(() => {
    void native.logInfo().then(setFolder);
  }, []);

  const local = useMemo(() => {
    const q = text.trim().toLowerCase();
    const hit = entries.filter((e) => passes(e.level, level) && (!q || e.msg.toLowerCase().includes(q) || e.scope.includes(q)));
    return hit.slice(-SHOW).reverse();
  }, [entries, level, text]);

  const query = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ since: srvSince, limit: "300", ...extra });
    if (srvLevel !== "all") q.set("level", srvLevel);
    if (srvSource) q.set("source", srvSource);
    const t = srvText.trim().slice(0, 80);
    if (t) q.set("text", t);
    return q;
  };

  /** Newest lines for the current filters (GET /v1/logs, oldest first; shown newest first). */
  const loadServer = async () => {
    const token = getActiveToken();
    if (!server || isMockServer(server) || !token) return;
    setSrvLoading(true);
    setSrvError(null);
    try {
      const res = await restRequest<{ entries: RelayLogEntry[] }>(server, `/v1/logs?${query({})}`, { token });
      setSrv(res.entries.slice().reverse());
    } catch (e) {
      setSrvError((e as Error).message);
    } finally {
      setSrvLoading(false);
    }
  };

  useEffect(() => {
    if (link !== "online") return;
    const t = setTimeout(() => void loadServer(), srvText ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srvLevel, srvSource, srvSince, srvText, link === "online"]);

  // Follow: only lines after the newest one shown, every 5 s, while this pane is visible.
  const newestId = srv?.[0]?.id;
  useEffect(() => {
    if (!follow || hidden || link !== "online" || !newestId || !server || isMockServer(server)) return;
    const timer = setInterval(() => {
      const token = getActiveToken();
      if (!token) return;
      void restRequest<{ entries: RelayLogEntry[] }>(server, `/v1/logs?${query({ after: String(newestId) })}`, { token, timeoutMs: 8000 })
        .then((res) => {
          if (res.entries.length) setSrv((prev) => [...res.entries.slice().reverse(), ...(prev ?? [])].slice(0, 600));
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, hidden, link, newestId, server, srvLevel, srvSource, srvSince, srvText]);

  const copyLocal = async () => {
    const ok = await copyToClipboard(local.slice().reverse().map(formatLogLine).join("\n"));
    toast(ok ? `已复制 ${local.length} 行` : "复制失败", !ok);
  };

  return (
    <div className="pane">
      <PaneTitle title="日志与诊断" />

      <SetHeading>本机</SetHeading>
      <ConfigSelect
        k="logging.level"
        options={[
          { value: "debug", label: "调试" },
          { value: "info", label: "信息" },
          { value: "warn", label: "警告" },
          { value: "error", label: "错误" },
        ]}
      />
      <ConfigSwitch k="logging.upload" about="脱敏同步到中转服务器" />
      <ConfigSelect k="logging.keepDays" options={[3, 7, 14, 30].map((n) => ({ value: String(n), label: `${n} 天` }))} />
      {folder ? (
        <SetRow
          title="日志文件夹"
          about={
            <>
              <span className="mono wrap-anywhere">{folder.dir}</span>
              <br />
              {folder.files.length} 个文件，共 {(folder.totalBytes / 1024 / 1024).toFixed(1)} MB
            </>
          }
        >
          <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
            <PocketButton size="sm" variant="ghost" onClick={() => void native.openLogFolder().catch((e: Error) => toast(e.message, true))}>
              <FolderOpen size={14} />
              <span>打开</span>
            </PocketButton>
            {folder.queuedForRelay ? (
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
                <span>立即上传 {folder.queuedForRelay} 行</span>
              </PocketButton>
            ) : null}
          </div>
        </SetRow>
      ) : null}
      <SetRow title="导出诊断包" about="含日志、版本与本机状态，不含密钥">
        <PocketButton
          size="sm"
          variant="soft"
          disabled={!native.available()}
          onClick={async () => {
            try {
              const path = await native.exportDiagnostics({ app: appVersion(), platform: detectPlatform(), link, server: server && !isMockServer(server) ? server : null });
              toast(`已导出：${path}`);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <FileDown size={14} />
          <span>导出</span>
        </PocketButton>
      </SetRow>

      <div className="log-toolbar">
        <LevelFilter value={level} onChange={setLevel} />
        <div className="grow" style={{ minWidth: 160 }}>
          <PocketInput value={text} onChange={(e) => setText(e.target.value)} placeholder="搜索日志…" />
        </div>
        <PocketButton size="sm" variant="ghost" onClick={() => void copyLocal()}>
          <Copy size={13} />
          <span>复制</span>
        </PocketButton>
      </div>
      <div className="log-box" role="log" aria-label="本机日志">
        {local.length ? (
          local.map((e) => (
            <div key={e.id} className={`log-line ${e.level}`}>
              {formatLogLine(e)}
            </div>
          ))
        ) : (
          <div className="faint">这次打开以来还没有符合条件的日志。</div>
        )}
      </div>

      <SetHeading>中转服务器</SetHeading>
      {!server || isMockServer(server) ? (
        <div className="faint">连上真的中转服务器后，这里能看到服务器和所有设备上传的日志。</div>
      ) : (
        <>
          <div className="log-toolbar">
            <LevelFilter value={srvLevel} onChange={setSrvLevel} />
            <div className="segmented wrap-ok">
              {(
                [
                  ["", "全部来源"],
                  ["relay", "服务器"],
                  ["host", "电脑后台"],
                  ["viewer", "手机和桌面端"],
                ] as const
              ).map(([v, label]) => (
                <button key={v || "all"} className={srvSource === v ? "active" : ""} onClick={() => setSrvSource(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="log-toolbar">
            <PocketSelect
              value={srvSince}
              onValueChange={setSrvSince}
              options={[
                { value: "15m", label: "最近 15 分钟" },
                { value: "1h", label: "最近 1 小时" },
                { value: "1d", label: "最近 1 天" },
                { value: "7d", label: "最近 7 天" },
              ]}
            />
            <div className="grow" style={{ minWidth: 160 }}>
              <PocketInput value={srvText} maxLength={80} onChange={(e) => setSrvText(e.target.value)} placeholder="在服务器日志里搜索…" />
            </div>
            <PocketSwitch checked={follow} onCheckedChange={setFollow} label="自动跟随新日志" />
            <span className="faint">自动跟随</span>
            <PocketButton size="sm" variant="ghost" disabled={srvLoading} onClick={() => void loadServer()}>
              <RefreshCw size={13} />
              <span>{srvLoading ? "读取中…" : "刷新"}</span>
            </PocketButton>
          </div>
          {srvError ? <div className="inline-alert">读不到服务器日志：{srvError}</div> : null}
          <div className="log-box" role="log" aria-label="服务器日志">
            {srv && srv.length ? (
              srv.map((e) => (
                <div key={e.id} className={`log-line ${e.level}`}>
                  {new Date(e.ts).toLocaleTimeString()} {e.level.toUpperCase().padEnd(5)} [{e.source}
                  {e.deviceName ? ` ${e.deviceName}` : ""}] {e.kind}: {redact(e.msg)}
                </div>
              ))
            ) : (
              <div className="faint">{srvLoading ? "读取中…" : "这段时间没有符合条件的日志。"}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
