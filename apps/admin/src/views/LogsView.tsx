import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw, Search } from "lucide-react";
import { adminApi, fmtTime, type Device, type LogEntry } from "../lib/api";
import {
  PocketButton,
  PocketCard,
  PocketChip,
  PocketInput,
  PocketSelect,
  PocketSwitch,
  useToast,
} from "../components/ui/PocketUI";

const SENSITIVE_KEYS = ["token", "secret", "password", "authorization"];

export function LogsView({ devices }: { devices: Device[] }) {
  const toast = useToast();
  const [since, setSince] = useState("1h");
  const [device, setDevice] = useState("");
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("");
  const [level, setLevel] = useState("");
  const [text, setText] = useState("");
  const [limit, setLimit] = useState("300");
  const [follow, setFollow] = useState(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [lastId, setLastId] = useState(0);
  const [loading, setLoading] = useState(false);

  const buildQuery = useCallback(
    (afterId?: number) => {
      const q = new URLSearchParams();
      if (afterId) q.set("after", String(afterId));
      else q.set("since", since);
      if (device) q.set("device", device);
      if (source) q.set("source", source);
      if (kind.trim()) q.set("kind", kind.trim());
      if (level) q.set("level", level);
      if (text.trim()) q.set("text", text.trim());
      q.set("limit", afterId ? "500" : limit);
      return q;
    },
    [since, device, source, kind, level, text, limit],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.logs(buildQuery());
      const list = res.entries ?? [];
      setLogs(list);
      if (list.length) setLastId(list[list.length - 1]!.id);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }, [buildQuery, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(async () => {
      try {
        const res = await adminApi.logs(buildQuery(lastId || undefined));
        const next = res.entries ?? [];
        if (!next.length) return;
        setLastId(next[next.length - 1]!.id);
        setLogs((prev) => {
          const seen = new Set(prev.map((x) => x.id));
          const merged = [...prev];
          for (const item of next) if (!seen.has(item.id)) merged.push(item);
          return merged.slice(-1500);
        });
      } catch {}
    }, 4000);
    return () => clearInterval(t);
  }, [follow, lastId, buildQuery]);

  const deviceOptions = [
    { value: "", label: "所有设备" },
    ...devices.map((d) => ({ value: d.id, label: d.name })),
  ];

  const rowsReversed = [...logs].reverse();

  return (
    <PocketCard>
      <div className="stack" style={{ gap: 14 }}>
        <div className="pk-card-head" style={{ marginBottom: 0 }}>
          <div className="row wrap">
            <h3 className="pk-card-title">
              <Activity size={18} style={{ color: "var(--accent-text)" }} />
              <span>实时运行日志</span>
            </h3>
            <span className="pk-pill pink num">{logs.length} 条</span>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <label className="row faint" style={{ gap: 8, cursor: "pointer" }}>
              <span>跟随新日志</span>
              <PocketSwitch checked={follow} onCheckedChange={setFollow} label="跟随新日志" />
            </label>
            <PocketButton variant="ghost" size="sm" onClick={load} disabled={loading}>
              <RefreshCw size={14} />
              <span>{loading ? "查询中…" : "查询"}</span>
            </PocketButton>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="row wrap" style={{ gap: 8 }}>
          <PocketSelect
            value={since}
            onValueChange={setSince}
            ariaLabel="时间范围"
            options={[
              { value: "15m", label: "最近 15 分钟" },
              { value: "1h", label: "最近 1 小时" },
              { value: "6h", label: "最近 6 小时" },
              { value: "1d", label: "最近 1 天" },
              { value: "7d", label: "最近 7 天" },
              { value: "14d", label: "最近 14 天" },
            ]}
          />
          <PocketSelect value={device} onValueChange={setDevice} ariaLabel="筛选设备" options={deviceOptions} />
          <PocketSelect
            value={source}
            onValueChange={setSource}
            ariaLabel="筛选来源"
            options={[
              { value: "", label: "所有来源" },
              { value: "relay", label: "服务器 relay" },
              { value: "host", label: "电脑 hostd" },
              { value: "viewer", label: "手机 App" },
            ]}
          />
          <PocketSelect
            value={level}
            onValueChange={setLevel}
            ariaLabel="日志级别"
            options={[
              { value: "", label: "所有级别" },
              { value: "info", label: "info 及以上" },
              { value: "warn", label: "warn 及以上" },
              { value: "error", label: "仅看 error" },
            ]}
          />
          <PocketSelect
            value={limit}
            onValueChange={setLimit}
            ariaLabel="条数上限"
            options={[
              { value: "100", label: "最多 100 条" },
              { value: "300", label: "最多 300 条" },
              { value: "1000", label: "最多 1000 条" },
            ]}
          />
        </div>

        {/* Search + Quick kind chips */}
        <div className="between wrap" style={{ gap: 10 }}>
          <div className="row wrap grow" style={{ gap: 8 }}>
            <div style={{ width: 250, maxWidth: "100%" }}>
              <PocketInput
                mono
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                placeholder="类别，如 live.ai、voice.ai、assistant、rpc"
                onKeyDown={(e) => e.key === "Enter" && load()}
              />
            </div>
            <div style={{ width: 220, maxWidth: "100%" }}>
              <PocketInput
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="包含关键词"
                onKeyDown={(e) => e.key === "Enter" && load()}
              />
            </div>
            <PocketButton variant="soft" size="sm" onClick={load}>
              <Search size={14} />
              <span>检索</span>
            </PocketButton>
          </div>

          <div className="row wrap" style={{ gap: 6 }}>
            {["", "live.ai", "assistant", "rpc", "device", "config"].map((k) => (
              <PocketChip key={k || "all"} active={kind === k} onClick={() => setKind(k)}>
                {k || "全部"}
              </PocketChip>
            ))}
          </div>
        </div>

        {/* Logs Table */}
        <div className="table-wrap" style={{ maxHeight: "62vh", overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>级别</th>
                <th>来源</th>
                <th>类别</th>
                <th>内容与上下文</th>
              </tr>
            </thead>
            <tbody>
              {rowsReversed.length ? (
                rowsReversed.map((e) => {
                  const trCls = e.level === "error" ? "row-error" : e.level === "warn" ? "row-warn" : "";
                  const who = e.deviceName ? `${e.source} · ${e.deviceName}` : e.source;
                  const dataEntries = Object.entries(e.data ?? {}).filter(
                    ([k]) => !SENSITIVE_KEYS.includes(k.toLowerCase()),
                  );
                  const lvlCls = e.level === "error" ? "blocked" : e.level === "warn" ? "warn" : "";
                  return (
                    <tr key={e.id} className={trCls}>
                      <td className="num faint" style={{ whiteSpace: "nowrap" }}>{fmtTime(e.ts)}</td>
                      <td>
                        <span className={`pk-pill ${lvlCls} mono`}>{e.level}</span>
                      </td>
                      <td className="faint" style={{ whiteSpace: "nowrap" }}>{who}</td>
                      <td className="mono faint" style={{ whiteSpace: "nowrap" }}>{e.kind}</td>
                      <td style={{ wordBreak: "break-word" }}>
                        <div className="mono" style={{ fontSize: 12.5 }}>{e.msg}</div>
                        {dataEntries.length ? (
                          <div className="data-pills">
                            {dataEntries.slice(0, 12).map(([k, v]) => (
                              <span key={k} className="data-pill">
                                {k}={typeof v === "object" ? JSON.stringify(v) : String(v)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} className="faint" style={{ padding: "22px 10px", textAlign: "center" }}>
                    这段时间没有符合条件的日志记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </PocketCard>
  );
}
