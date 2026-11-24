import { useEffect, useState } from "react";
import { ChevronLeft, Copy, FolderOpen, Keyboard, Laptop, Power, Square } from "lucide-react";
import type { Agent, SubSession } from "@herdr-pocket/protocol";
import { VendorAvatar, statusTone } from "../components/MascotAndVendor";
import { EmptyState, PocketBadge, PocketButton, PocketIconButton, PocketModal, fs, useToast } from "../components/PocketUI";
import { copyToClipboard } from "../lib/bridge";
import { rpcCall } from "../lib/relay";
import { STATUS_LABEL, agentTitle, liveStore, relTime, settingsStore } from "../lib/store";
import { AgentDetailPanel } from "../views/AgentsView";
import { MobileTermPad } from "./MobileTermPad";

type DetailSeg = "chat" | "term" | "subs" | "info";

function money(usd: number | undefined): string | null {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
  return usd < 0.01 ? `<$0.01` : `$${usd.toFixed(2)}`;
}

export function MobileAgentDetail({
  agent,
  initialTab = "chat",
  onBack,
  onOpenWorkbench,
}: {
  agent: Agent;
  initialTab?: "chat" | "term";
  onBack: () => void;
  onOpenWorkbench?: (agentKey: string) => void;
}) {
  const toast = useToast();
  const device = liveStore.use((s) => s.devices[agent.deviceId]);
  const dark = settingsStore.use((s) => s.theme) === "dark";
  const online = device?.online ?? false;

  const [seg, setSeg] = useState<DetailSeg>(agent.isShell ? "term" : initialTab);
  const [padOpen, setPadOpen] = useState(true);
  const [subs, setSubs] = useState<SubSession[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [killOpen, setKillOpen] = useState(false);

  useEffect(() => {
    setSeg(agent.isShell ? "term" : initialTab);
  }, [agent.key, agent.isShell, initialTab]);

  useEffect(() => {
    if (seg !== "subs") return;
    let cancelled = false;
    setSubsLoading(true);
    void rpcCall(agent.deviceId, "session.children", { agent: agent.key })
      .then((res) => {
        if (!cancelled) setSubs(res.sessions ?? []);
      })
      .catch(() => {
        if (!cancelled) setSubs([]);
      })
      .finally(() => {
        if (!cancelled) setSubsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.deviceId, agent.key, seg]);

  const title = agentTitle(agent);
  const costText = money(agent.costUsd);

  return (
    <div className="mp-detail-root">
      <div className="mp-detail-header">
        <div className="mp-detail-top">
          <PocketIconButton size="sm" tooltip="返回列表" onClick={onBack}>
            <ChevronLeft size={19} />
          </PocketIconButton>
          <VendorAvatar harness={agent.harness} isShell={agent.isShell} dark={dark} size={34} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate" style={{ fontWeight: 800, fontSize: fs(15) }}>{title}</div>
            <div className="row" style={{ gap: 5, fontSize: fs(11.5), color: "var(--mp-muted)", minWidth: 0 }}>
              <Laptop size={12} />
              <span className="truncate">{device?.name ?? agent.deviceId}</span>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  flexShrink: 0,
                  background: online ? "#3FB68B" : "var(--mp-faint)",
                }}
              />
            </div>
          </div>
          {seg === "term" ? (
            <PocketIconButton
              size="sm"
              tooltip={padOpen ? "收起虚拟键盘" : "打开虚拟键盘"}
              active={padOpen}
              onClick={() => setPadOpen((v) => !v)}
            >
              <Keyboard size={16} />
            </PocketIconButton>
          ) : null}
          <PocketBadge tone={online ? statusTone(agent.status) : "neutral"} pulse={online && (agent.status === "working" || agent.status === "blocked")}>
            {online ? STATUS_LABEL[agent.status] : "离线"}
          </PocketBadge>
        </div>

        <div className="mp-seg" role="tablist" aria-label="详情视图">
          {(
            [
              { id: "chat", label: "对话" },
              { id: "term", label: "终端" },
              { id: "subs", label: subs.length || agent.subagents ? `子任务(${subs.length || agent.subagents})` : "子任务" },
              { id: "info", label: "信息" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={seg === t.id}
              className={`mp-seg-btn${seg === t.id ? " active" : ""}`}
              onClick={() => setSeg(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mp-detail-body">
        {seg === "chat" || seg === "term" ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
              <AgentDetailPanel
                key={agent.key}
                agent={agent}
                embedded
                mobile
                mode={seg === "term" ? "term" : "chat"}
                onModeChange={(m) => setSeg(m)}
                onBack={onBack}
                onOpenWorkbench={onOpenWorkbench}
              />
              {seg === "term" && !padOpen ? (
                <button
                  type="button"
                  className="mp-snippet-pill"
                  style={{
                    position: "absolute",
                    right: 12,
                    bottom: 12,
                    zIndex: 12,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    background: "var(--mp-surface)",
                    boxShadow: "var(--mp-shadow)",
                  }}
                  onClick={() => setPadOpen(true)}
                >
                  <Keyboard size={13} />
                  <span>快捷键盘</span>
                </button>
              ) : null}
            </div>
            {seg === "term" && padOpen ? <MobileTermPad onClose={() => setPadOpen(false)} /> : null}
          </div>
        ) : seg === "subs" ? (
          <div className="mp-scroll">
            {subsLoading ? (
              <div className="faint" style={{ padding: 16, textAlign: "center" }}>正在加载子任务…</div>
            ) : subs.length === 0 ? (
              <EmptyState mood="hello" title="暂无子任务" body="该会话还没有派生子 Agent 任务。" />
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {subs.map((sub) => (
                  <div key={sub.key} className="mp-card stack" style={{ gap: 6 }}>
                    <div className="between" style={{ gap: 8 }}>
                      <span className="truncate" style={{ fontWeight: 800, fontSize: fs(14.5) }}>
                        {sub.title || sub.harness || sub.key}
                      </span>
                      <PocketBadge tone={sub.status === "working" ? "pink" : "neutral"}>
                        {sub.status === "working" ? "工作中" : "空闲"}
                      </PocketBadge>
                    </div>
                    {sub.preview ? (
                      <div className="faint" style={{ fontSize: fs(12.5), lineHeight: 1.45 }}>{sub.preview}</div>
                    ) : null}
                    <div className="faint mono" style={{ fontSize: 11.5 }}>
                      {[sub.harness, sub.model, relTime(sub.updatedAt)].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mp-scroll">
            <div className="stack" style={{ gap: 12 }}>
              <div className="mp-card stack" style={{ gap: 8 }}>
                <div style={{ fontWeight: 800, fontSize: fs(14) }}>会话信息</div>
                <div className="between" style={{ fontSize: fs(13) }}>
                  <span className="faint">助手类型</span>
                  <span className="mono">{agent.harness}</span>
                </div>
                {agent.model ? (
                  <div className="between" style={{ fontSize: fs(13) }}>
                    <span className="faint">当前模型</span>
                    <span className="mono truncate" style={{ maxWidth: "64%" }}>{agent.model}</span>
                  </div>
                ) : null}
                {agent.turn ? (
                  <div className="between" style={{ fontSize: fs(13) }}>
                    <span className="faint">对话轮次</span>
                    <span className="num">第 {agent.turn} 轮</span>
                  </div>
                ) : null}
                {costText ? (
                  <div className="between" style={{ fontSize: fs(13) }}>
                    <span className="faint">累计花费</span>
                    <span className="num">{costText}</span>
                  </div>
                ) : null}
                <div className="between" style={{ fontSize: fs(13) }}>
                  <span className="faint">最近更新</span>
                  <span>{relTime(agent.updatedAt)}</span>
                </div>
              </div>

              {agent.cwd ? (
                <div className="mp-card stack" style={{ gap: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: fs(14) }}>工作目录</div>
                  <div className="mono" style={{ fontSize: 12, color: "var(--mp-muted)", wordBreak: "break-all" }}>
                    {agent.cwd}
                  </div>
                  <div className="row wrap" style={{ gap: 8 }}>
                    <PocketButton
                      size="sm"
                      variant="soft"
                      onClick={() => {
                        void copyToClipboard(agent.cwd!).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok));
                      }}
                    >
                      <Copy size={13} />
                      复制路径
                    </PocketButton>
                    {onOpenWorkbench ? (
                      <PocketButton size="sm" variant="primary" onClick={() => onOpenWorkbench(agent.key)}>
                        <FolderOpen size={13} />
                        查看文件
                      </PocketButton>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="mp-card stack" style={{ gap: 8 }}>
                <div style={{ fontWeight: 800, fontSize: fs(14) }}>终端控制</div>
                <div className="row wrap" style={{ gap: 8 }}>
                  <PocketButton
                    size="sm"
                    variant="soft"
                    onClick={() => {
                      void rpcCall(agent.deviceId, "terminal.interrupt", { agent: agent.key })
                        .then(() => toast("已发送中断信号 (Ctrl+C)"))
                        .catch((e) => toast((e as Error).message, true));
                    }}
                  >
                    <Square size={13} />
                    中断任务
                  </PocketButton>
                  <PocketButton size="sm" variant="danger" onClick={() => setKillOpen(true)}>
                    <Power size={13} />
                    关闭终端
                  </PocketButton>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <PocketModal
        open={killOpen}
        onOpenChange={setKillOpen}
        title="关闭终端？"
        subtitle="关闭后将终止该终端内正在运行的进程，未保存的进度会丢失。"
        width={380}
      >
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <PocketButton variant="ghost" onClick={() => setKillOpen(false)}>取消</PocketButton>
          <PocketButton
            variant="danger"
            onClick={() => {
              setKillOpen(false);
              void rpcCall(agent.deviceId, "terminal.kill", { agent: agent.key })
                .then(() => onBack())
                .catch((e) => toast((e as Error).message, true));
            }}
          >
            关闭并结束
          </PocketButton>
        </div>
      </PocketModal>
    </div>
  );
}
