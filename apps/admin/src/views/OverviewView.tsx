import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Coins,
  Hand,
  Laptop,
  Layers,
  Mic,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";
import {
  adminApi,
  fmtAgo,
  fmtTime,
  fmtTokens,
  type AdminOverview,
  type AgentStatus,
  type Device,
} from "../lib/api";
import { XiaoyangOrb, VendorAvatar, resolveVendor } from "../components/MascotAndVendor";
import {
  EmptyState,
  PocketButton,
  PocketCard,
  PocketChip,
  PocketSelect,
  PocketSwitch,
  SettingRow,
  StatusPill,
  useToast,
} from "../components/ui/PocketUI";

const STATE_LABEL: Record<string, { label: string; cls: string }> = {
  done: { label: "已完成", cls: "working" },
  running: { label: "进行中", cls: "lavender" },
  pending: { label: "待确认", cls: "warn" },
  failed: { label: "失败", cls: "blocked" },
  cancelled: { label: "已取消", cls: "" },
  expired: { label: "已过期", cls: "" },
};

export function OverviewView({
  overview,
  devices,
  dark,
  onReload,
  onGoVoice,
  onGoDevices,
}: {
  overview: AdminOverview;
  devices: Device[];
  dark: boolean;
  onReload: () => Promise<void>;
  onGoVoice: () => void;
  onGoDevices: () => void;
}) {
  const toast = useToast();
  const [hostFilter, setHostFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | AgentStatus>("");
  const [showShells, setShowShells] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const bentoRef = useRef<HTMLDivElement>(null);

  const hosts = useMemo(() => devices.filter((d) => d.kind === "host"), [devices]);

  const counts = useMemo(() => {
    const base = overview.agentList.filter(
      (a) => (showShells || !a.isShell) && (!hostFilter || a.deviceId === hostFilter),
    );
    return {
      blocked: base.filter((a) => a.status === "blocked").length,
      working: base.filter((a) => a.status === "working").length,
      done: base.filter((a) => a.status === "done").length,
      total: base.length,
    };
  }, [overview.agentList, showShells, hostFilter]);

  const visibleAgents = useMemo(() => {
    const order: Record<AgentStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
    return overview.agentList
      .filter((a) => (showShells || !a.isShell) && (!hostFilter || a.deviceId === hostFilter))
      .filter((a) => (!statusFilter ? true : a.status === statusFilter))
      .slice()
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [overview.agentList, showShells, hostFilter, statusFilter]);

  useEffect(() => {
    if (!bentoRef.current) return;
    const nums = bentoRef.current.querySelectorAll(".bento-num");
    nums.forEach((el, idx) => {
      (el as HTMLElement).animate?.(
        [
          { transform: "translateY(6px)", opacity: 0.65 },
          { transform: "translateY(0)", opacity: 1 },
        ],
        { duration: 320, delay: idx * 35, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
      );
    });
  }, [counts.blocked, counts.working, counts.done]);

  const toggleConfirm = async (checked: boolean) => {
    setConfirmBusy(true);
    try {
      await adminApi.setConfirm(checked ? "always" : "never");
      await onReload();
      toast(checked ? "已切为：动手前先问你" : "已切为：直接去办，办完汇报");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setConfirmBusy(false);
    }
  };

  const mascotMood = counts.blocked > 0 ? "waiting" : counts.working > 0 ? "working" : "yay";
  const hostOptions = [
    { value: "", label: "全部电脑" },
    ...hosts.map((h) => ({ value: h.id, label: h.name })),
  ];

  return (
    <div className="stack">
      {/* Hero Bento Row */}
      <div className="bento-grid" ref={bentoRef}>
        <button
          type="button"
          className={`bento-tile wait${statusFilter === "blocked" ? " active-filter" : ""}`}
          onClick={() => setStatusFilter((s) => (s === "blocked" ? "" : "blocked"))}
        >
          <div className="between">
            <span className="row" style={{ gap: 6, fontWeight: 800, fontSize: 13.5 }}>
              <Hand size={16} />
              <span>需要你</span>
            </span>
            <span className="faint" style={{ color: "inherit", opacity: 0.78 }}>
              {statusFilter === "blocked" ? "已筛选" : "点击筛选"}
            </span>
          </div>
          <div className="bento-num num">{counts.blocked}</div>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85 }}>等待拍板或报错停住</div>
        </button>

        <button
          type="button"
          className={`bento-tile work${statusFilter === "working" ? " active-filter" : ""}`}
          onClick={() => setStatusFilter((s) => (s === "working" ? "" : "working"))}
        >
          <div className="between">
            <span className="row" style={{ gap: 6, fontWeight: 800, fontSize: 13.5 }}>
              <Sparkles size={16} />
              <span>工作中</span>
            </span>
            <span className="faint" style={{ color: "inherit", opacity: 0.78 }}>
              {statusFilter === "working" ? "已筛选" : "正在执行"}
            </span>
          </div>
          <div className="bento-num num">{counts.working}</div>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85 }}>正在运行与输出代码</div>
        </button>

        <button
          type="button"
          className={`bento-tile done${statusFilter === "done" ? " active-filter" : ""}`}
          onClick={() => setStatusFilter((s) => (s === "done" ? "" : "done"))}
        >
          <div className="between">
            <span className="row" style={{ gap: 6, fontWeight: 800, fontSize: 13.5 }}>
              <CheckCircle2 size={16} />
              <span>已完成</span>
            </span>
            <span className="faint" style={{ color: "inherit", opacity: 0.78 }}>
              {statusFilter === "done" ? "已筛选" : "收工汇总"}
            </span>
          </div>
          <div className="bento-num num">{counts.done}</div>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.85 }}>本轮已经停稳待查看</div>
        </button>

        {/* Xiaoyang Pod */}
        <div className="bento-pod">
          <XiaoyangOrb mood={mascotMood} size={74} />
          <div className="grow stack" style={{ gap: 8 }}>
            <div className="between" style={{ gap: 6 }}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>小羊实时值守</span>
              <span className={`pk-pill ${overview.assistant.ready ? "working" : "warn"}`}>
                <i className="pk-dot pulse" />
                <span>{overview.assistant.ready ? "在线" : "未配模型"}</span>
              </span>
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              <PocketButton variant="soft" size="sm" onClick={onGoVoice}>
                <Mic size={13} />
                <span>{overview.voice ? (overview.voice.voice || overview.voice.provider) : "语音关闭"}</span>
              </PocketButton>
              <PocketButton variant="ghost" size="sm" onClick={onGoDevices}>
                <Laptop size={13} />
                <span className="num">设备 {overview.online}/{overview.devices}</span>
              </PocketButton>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <span className={`pk-pill ${overview.last24h.warn > 0 ? "warn" : ""}`}>
                warn {overview.last24h.warn}
              </span>
              <span className={`pk-pill ${overview.last24h.error > 0 ? "blocked" : ""}`}>
                error {overview.last24h.error}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Online Agents */}
      <PocketCard>
        <div className="pk-card-head">
          <div className="row wrap">
            <h3 className="pk-card-title">
              <Bot size={18} style={{ color: "var(--accent-text)" }} />
              <span>在线 Agent</span>
              <span className="pk-pill pink num">{visibleAgents.length}</span>
            </h3>
            <div className="row wrap" style={{ gap: 6 }}>
              <PocketChip active={statusFilter === ""} onClick={() => setStatusFilter("")}>
                全部 {counts.total}
              </PocketChip>
              <PocketChip active={statusFilter === "blocked"} onClick={() => setStatusFilter("blocked")}>
                需要你 {counts.blocked}
              </PocketChip>
              <PocketChip active={statusFilter === "working"} onClick={() => setStatusFilter("working")}>
                工作中 {counts.working}
              </PocketChip>
            </div>
          </div>
          <div className="row wrap">
            <label className="row faint" style={{ gap: 8, cursor: "pointer" }}>
              <Terminal size={14} />
              <span>显示普通终端</span>
              <PocketSwitch checked={showShells} onCheckedChange={setShowShells} label="显示普通终端" />
            </label>
            <PocketSelect value={hostFilter} onValueChange={setHostFilter} options={hostOptions} ariaLabel="筛选电脑" />
          </div>
        </div>

        {visibleAgents.length ? (
          <div className="agents-grid">
            {visibleAgents.map((a) => {
              const vendor = resolveVendor(a.harness, a.isShell);
              const title = a.title || a.name || a.localId;
              const headline = a.where ? `${a.where} · ${title}` : title;
              const pct =
                a.contextTokens && a.contextLimit
                  ? Math.min(100, Math.round((a.contextTokens / a.contextLimit) * 100))
                  : 0;
              return (
                <article key={a.key} className={`agent-card${a.status === "blocked" ? " need" : ""}`}>
                  <div className="between" style={{ alignItems: "flex-start" }}>
                    <div className="row grow" style={{ alignItems: "center", gap: 11 }}>
                      <VendorAvatar harness={a.harness} isShell={a.isShell} dark={dark} size={46} />
                      <div className="grow">
                        <div className="truncate" style={{ fontWeight: 800, fontSize: 14.5 }} title={headline}>
                          {headline}
                        </div>
                        <div className="faint truncate">
                          {vendor.label} · {a.deviceName || a.deviceId}
                          {a.turn ? ` · 第 ${a.turn} 轮` : ""}
                        </div>
                      </div>
                    </div>
                    <StatusPill status={a.status} errored={a.errored} />
                  </div>

                  {a.statusNote ? (
                    <div
                      style={{
                        fontSize: 12.5,
                        padding: "7px 10px",
                        borderRadius: 12,
                        background: a.status === "blocked" ? "var(--blush-soft)" : "var(--surface)",
                        color: a.status === "blocked" ? "var(--blush-text)" : "var(--muted)",
                        border: "1px solid var(--divider)",
                      }}
                    >
                      {a.statusNote}
                    </div>
                  ) : a.preview ? (
                    <div className="faint truncate" title={a.preview}>
                      {a.preview}
                    </div>
                  ) : null}

                  <div className="between wrap" style={{ gap: 6 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {a.subagents ? (
                        <span className="pk-pill working">
                          <Layers size={11} />
                          <span>子 agent {a.subagents}</span>
                        </span>
                      ) : null}
                      {a.queued ? (
                        <span className="pk-pill pink">排队中 {a.queued}</span>
                      ) : null}
                      {a.costUsd && a.costUsd > 0 ? (
                        <span className="pk-pill lavender num">
                          <Coins size={11} />
                          <span>${a.costUsd.toFixed(2)}</span>
                        </span>
                      ) : null}
                      {a.model ? <span className="pk-pill mono">{a.model}</span> : null}
                    </div>
                    <span className="faint num">{fmtAgo(a.updatedAt)}</span>
                  </div>

                  {pct > 0 ? (
                    <div className="stack" style={{ gap: 4 }}>
                      <div className="between faint" style={{ fontSize: 11 }}>
                        <span>上下文窗口</span>
                        <span className="mono">{fmtTokens(a.contextTokens)} / {fmtTokens(a.contextLimit)} ({pct}%)</span>
                      </div>
                      <div className="ctx-bar">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            mood="sleepy"
            title="暂时没有符合条件的在线 Agent"
            hint={statusFilter || hostFilter ? "点上面的筛选胶囊即可查看全部在线会话。" : "电脑端 herdr-pocket 连上来以后，所有会话都会在这里亮起来。"}
          />
        )}
      </PocketCard>

      {/* Assistant Behavior & Recent Actions */}
      <div className="grid-2">
        <PocketCard>
          <div className="pk-card-head">
            <h3 className="pk-card-title">
              <ShieldCheck size={18} style={{ color: "var(--accent-text)" }} />
              <span>小羊办事规矩</span>
            </h3>
          </div>
          <SettingRow
            icon={<Sparkles size={20} />}
            tone="pink"
            title="小羊动手前先问我"
            description={
              overview.assistant.confirm === "always"
                ? "开着：所有实机动作先发确认卡片等你点头（通话中仍直接办事）"
                : "关着：收到明确指令直接去办，办完把真实结果告诉你"
            }
            right={
              <PocketSwitch
                checked={overview.assistant.confirm === "always"}
                onCheckedChange={toggleConfirm}
                disabled={confirmBusy}
                label="小羊动手前先问我"
              />
            }
          />
          {overview.assistant.models.length ? (
            <div className="row wrap" style={{ marginTop: 12, gap: 6 }}>
              <span className="faint">当前文字模型链：</span>
              {overview.assistant.models.map((m, i) => (
                <span key={m + i} className={`pk-pill ${i === 0 ? "pink" : "lavender"} mono`}>
                  {m}
                </span>
              ))}
            </div>
          ) : (
            <div className="row" style={{ marginTop: 12, gap: 6, color: "var(--warn-text)", fontSize: 12.5 }}>
              <AlertTriangle size={15} />
              <span>还没有可用的文字模型，请到「模型与服务商」配置。</span>
            </div>
          )}
        </PocketCard>

        <PocketCard>
          <div className="pk-card-head">
            <h3 className="pk-card-title">
              <Sparkles size={18} style={{ color: "var(--lav-text)" }} />
              <span>最近派发的动作</span>
            </h3>
            <span className="faint num">最近 {overview.actions.length} 条</span>
          </div>
          {overview.actions.length ? (
            <div className="table-wrap" style={{ maxHeight: 280, overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>状态</th>
                    <th>说明</th>
                    <th>结果</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.actions.slice(0, 12).map((act) => {
                    const st = STATE_LABEL[act.state] ?? { label: act.state, cls: "" };
                    return (
                      <tr key={act.id}>
                        <td className="num faint" style={{ whiteSpace: "nowrap" }}>{fmtTime(act.createdAt)}</td>
                        <td>
                          <span className={`pk-pill ${st.cls}`}>{st.label}</span>
                        </td>
                        <td>{act.summary}</td>
                        <td className="faint">{act.result || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="faint" style={{ padding: "18px 4px" }}>
              小羊今天还没有替你往终端发过操作指令。
            </div>
          )}
        </PocketCard>
      </div>
    </div>
  );
}
