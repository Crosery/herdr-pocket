import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Check, RefreshCw } from "lucide-react";
import {
  compareVersions,
  type Device,
  type HostToolId,
  type HostTools,
  type ToolUpdateJobSnapshot,
} from "@herdr-pocket/protocol";
import { PocketButton, useToast } from "../../components/PocketUI";
import { appVersion } from "../../lib/bridge";
import { useClientConfig } from "../../lib/config";
import { rpcCall } from "../../lib/relay";
import { liveStore, relTime } from "../../lib/store";
import { ConfigSwitch, SetHeading, SetRow } from "./rows";

type DisplayToolId = "app" | "herdr" | "hc" | "uniflo";

const TOOLS: Array<{ id: DisplayToolId; label: string }> = [
  { id: "app", label: "Herdr 桌面版" },
  { id: "herdr", label: "Herdr 终端" },
  { id: "hc", label: "hc" },
  { id: "uniflo", label: "uniflo" },
];

const PLATFORM_BADGE: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/** "hc 0.9.1 (abc)" -> "0.9.1", so a label around the number doesn't break the comparison. */
function bare(v: string): string {
  return v.match(/\d+(?:\.\d+)+(?:-[\w.]+)?/)?.[0] ?? v;
}

/** The newer upstream version of a tool, or null when it is current or nothing is known. */
function newerOf(tools: HostTools, id: DisplayToolId): string | null {
  const have = tools[id];
  const latest = tools.latest?.[id];
  return have && latest && compareVersions(bare(latest), bare(have)) > 0 ? bare(latest) : null;
}

interface HostToolEntry {
  tools: HostTools;
  hostVersion?: string;
}

type Answer = HostToolEntry | "loading" | "error";

function useHostTools(hosts: Device[]): {
  byHost: Record<string, Answer>;
  refreshHost: (hostId: string, activeCheck?: boolean) => Promise<void>;
} {
  const [byHost, setByHost] = useState<Record<string, Answer>>({});
  const ids = hosts.map((h) => h.id).join(",");

  const fetchOne = useCallback(async (id: string, activeCheck = false) => {
    setByHost((p) => ({ ...p, [id]: p[id] && p[id] !== "error" ? p[id] : "loading" }));
    try {
      if (activeCheck) {
        try {
          const checked = await rpcCall(id, "tools.check", {}, 15_000);
          setByHost((p) => ({ ...p, [id]: { tools: checked.tools ?? {}, hostVersion: checked.hostVersion } }));
          return;
        } catch {
          // Fall back to host.info on older daemons.
        }
      }
      const r = await rpcCall(id, "host.info", {}, 8_000);
      setByHost((p) => ({ ...p, [id]: { tools: r.tools ?? {}, hostVersion: r.version } }));
    } catch {
      setByHost((p) => ({ ...p, [id]: "error" }));
    }
  }, []);

  useEffect(() => {
    for (const id of ids ? ids.split(",") : []) {
      void fetchOne(id, false);
    }
  }, [fetchOne, ids]);

  return { byHost, refreshHost: fetchOne };
}

function HostToolCard({
  host,
  entry,
  onRefresh,
}: {
  host: Device;
  entry: Answer | undefined;
  onRefresh: (activeCheck?: boolean) => Promise<void>;
}) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [job, setJob] = useState<ToolUpdateJobSnapshot | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const finishJob = (snap: ToolUpdateJobSnapshot) => {
    stopPolling();
    setJob(snap);
    void onRefresh(false);
    const failed = snap.completed.filter((c) => !c.ok);
    const updated = snap.completed.filter((c) => c.ok && (c.status === "updated" || c.status === "restarting"));
    if (failed.length > 0) {
      toast(failed.map((f) => `${f.id}: ${f.message}`).join("；"), true);
    } else if (updated.length > 0) {
      toast(updated.map((u) => u.message).join(" · "));
    } else if (snap.completed.length > 0) {
      toast("所选组件已是最新版本");
    }
  };

  const runUpdate = async (targets: HostToolId[]) => {
    if (!targets.length || job?.running) return;
    stopPolling();
    try {
      const snap = await rpcCall(host.id, "tools.update", { targets, waitMs: 12_000 }, 20_000);
      setJob(snap);
      if (!snap.running) {
        finishJob(snap);
        return;
      }
      pollRef.current = window.setInterval(() => {
        void rpcCall(host.id, "tools.updateStatus", { jobId: snap.jobId }, 8_000)
          .then((next) => {
            if (!next) {
              stopPolling();
              setJob(null);
              return;
            }
            setJob(next);
            if (!next.running) finishJob(next);
          })
          .catch(() => {
            stopPolling();
            setJob(null);
            void onRefresh(false);
          });
      }, 1500);
    } catch (e) {
      const msg = (e as Error).message || "更新失败";
      if (/unknown method|unsupported/i.test(msg)) {
        toast("该电脑的 herdr-pocket 后台版本较旧，请先在该电脑运行一次 herdr-pocket update", true);
      } else {
        toast(msg, true);
      }
    }
  };

  const handleCheck = async () => {
    setChecking(true);
    try {
      await onRefresh(true);
    } finally {
      setChecking(false);
    }
  };

  const platLabel = PLATFORM_BADGE[host.platform ?? ""] ?? host.platform ?? "";
  const data = entry && entry !== "loading" && entry !== "error" ? entry : null;
  const tools = data?.tools;
  const hostVer = data?.hostVersion;
  const hostTargetVer = tools?.latest?.hostd ?? appVersion();
  const hostOutdated = Boolean(hostVer && hostTargetVer && compareVersions(bare(hostTargetVer), bare(hostVer)) > 0);
  const installed = tools ? TOOLS.filter((t) => tools[t.id]) : [];
  const outdatedIds: HostToolId[] = [
    ...(tools ? installed.filter((t) => newerOf(tools, t.id)).map((t) => t.id) : []),
    ...(hostOutdated ? (["hostd"] as HostToolId[]) : []),
  ];

  const renderStatus = (id: HostToolId, newer: string | null, known: string | undefined) => {
    const done = job?.completed.find((c) => c.id === id);
    const active = job?.running && job.current === id;
    const queued = job?.running && job.targets.includes(id) && !done && !active;

    return (
      <span className="tool-actions">
        {newer ? (
          <span className="tool-newer">可更新到 {newer}</span>
        ) : known ? (
          <span className="faint">最新</span>
        ) : null}
        {active ? (
          <span className="tool-status-busy">正在更新…</span>
        ) : queued ? (
          <span className="faint">排队中…</span>
        ) : done ? (
          <span className={done.ok ? "tool-status-ok" : "tool-status-err"} title={done.message}>
            {done.ok ? (
              <>
                <Check size={12} />
                <span>{done.status === "restarting" ? "重启中" : done.status === "updated" ? "已更新" : "最新"}</span>
              </>
            ) : (
              "失败"
            )}
          </span>
        ) : null}
        <PocketButton
          size="sm"
          variant={newer ? "primary" : "soft"}
          disabled={Boolean(job?.running) || checking}
          onClick={() => void runUpdate([id])}
          title={newer ? `直接更新 ${id} 到 ${newer}` : `检查并更新 ${id}`}
        >
          <ArrowUpCircle size={12} />
          <span>{newer ? "更新" : "检查/更新"}</span>
        </PocketButton>
      </span>
    );
  };

  return (
    <div className="tool-host">
      <div className="tool-host-head">
        <div className="tool-host-title-wrap">
          <span className="tool-host-name">{host.name}</span>
          {platLabel ? <span className="tool-platform-chip">{platLabel}</span> : null}
        </div>
        <div className="tool-host-btns">
          <PocketButton
            size="sm"
            variant="ghost"
            disabled={checking || Boolean(job?.running)}
            onClick={() => void handleCheck()}
          >
            <RefreshCw size={12} className={checking ? "pk-spin" : undefined} />
            <span>{checking ? "检查中…" : "检查更新"}</span>
          </PocketButton>
          {outdatedIds.length > 0 ? (
            <PocketButton
              size="sm"
              variant="primary"
              disabled={Boolean(job?.running)}
              onClick={() => void runUpdate(outdatedIds)}
            >
              <ArrowUpCircle size={12} />
              <span>一键更新 ({outdatedIds.length})</span>
            </PocketButton>
          ) : null}
        </div>
      </div>

      {entry === undefined || entry === "loading" ? (
        <SetRow title="正在读取…" />
      ) : entry === "error" ? (
        <SetRow title="读不到" about="这台电脑没回答，可能是它的后台服务正在重启或离线。" />
      ) : !installed.length && !hostVer ? (
        <SetRow title="没有找到" about="这台电脑上没装 hc、Herdr 或 uniflo。" />
      ) : (
        <>
          {hostVer ? (
            <SetRow title="Herdr Pocket 后台">
              <span className="tool-version">
                <span className="mono">{hostVer}</span>
                {renderStatus("hostd", hostOutdated ? bare(hostTargetVer) : null, bare(hostTargetVer))}
              </span>
            </SetRow>
          ) : null}
          {installed.map((t) => {
            const newer = tools ? newerOf(tools, t.id) : null;
            const known = tools?.latest?.[t.id];
            return (
              <SetRow key={t.id} title={t.label}>
                <span className="tool-version">
                  <span className="mono">{tools?.[t.id]}</span>
                  {renderStatus(t.id, newer, known)}
                </span>
              </SetRow>
            );
          })}
          <div className="tool-checked faint">
            {tools?.latest?.checkedAt ? `上次检查 ${relTime(tools.latest.checkedAt)}` : "还没检查上游版本"}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Settings › 更新: inspect & directly update host tools across macOS, Windows, and Linux.
 */
export function ToolVersionsSection() {
  const devices = liveStore.use((s) => s.devices);
  const autoCheck = useClientConfig().update.autoCheck;
  const hosts = Object.values(devices)
    .filter((d) => d.kind === "host" && d.online)
    .sort((a, b) => a.name.localeCompare(b.name));
  const { byHost, refreshHost } = useHostTools(hosts);

  return (
    <>
      <SetHeading>电脑端组件（hc、Herdr、uniflo）</SetHeading>
      {hosts.length === 0 ? (
        <SetRow title="没有在线电脑" />
      ) : (
        hosts.map((h) => (
          <HostToolCard
            key={h.id}
            host={h}
            entry={byHost[h.id]}
            onRefresh={(active) => refreshHost(h.id, active)}
          />
        ))
      )}
      <ConfigSwitch
        k="update.checkTools"
        disabled={!autoCheck}
        about={autoCheck ? "每日自动检查各台电脑上的组件新版本" : "需开启自动检查更新"}
      />
    </>
  );
}
