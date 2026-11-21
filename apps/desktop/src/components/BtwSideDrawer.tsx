import { useState } from "react";
import { Bot, Check, ChevronDown, ChevronUp, Copy, Sparkles, X } from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { assistantStore, loadAssistant, sendToAssistant } from "../lib/assistant";
import { copyToClipboard } from "../lib/bridge";
import { RichMarkdown } from "../lib/markdown";
import { isMockServer } from "../lib/mock";
import { RelayError, rpcCall } from "../lib/relay";
import { canonicalHarnessId } from "../lib/slashCommands";
import { settingsStore } from "../lib/store";
import "../styles/btw-slash.css";

export interface BtwTurn {
  id: string;
  question: string;
  status: "loading" | "done" | "error";
  answer?: string;
  error?: string;
  model?: string;
  durationMs?: number;
  createdAt: number;
}

export interface BtwResponse {
  answer: string;
  model?: string;
  durationMs: number;
}

type BtwRpcCall = (
  to: string,
  method: "agent.btw",
  params: { agent: string; question: string },
  timeoutMs?: number,
) => Promise<{ answer?: string; model?: string; durationMs?: number }>;

function isUnsupportedRpcError(err: unknown): boolean {
  if (err instanceof RelayError && err.code === "unsupported") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /unsupported|unknown method|method not found|未实现|不支持/i.test(msg);
}

function waitForAssistantBtwReply(beforeIds: ReadonlySet<string>, startedAt: number, timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsub?.();
      fn();
    };

    const check = () => {
      const s = assistantStore.get();
      const reply = [...s.items]
        .reverse()
        .find((item) => item.role === "assistant" && !beforeIds.has(item.id) && item.ts >= startedAt - 2000 && item.text.trim());
      if (reply) {
        if (reply.error) {
          finish(() => reject(new Error(reply.text || "小羊助理回答失败")));
        } else {
          finish(() => resolve(reply.text));
        }
        return;
      }
      if (!s.busy && s.error) {
        finish(() => reject(new Error(s.error!)));
      }
    };

    unsub = assistantStore.subscribe(() => check());
    timer = setTimeout(() => {
      void loadAssistant().finally(() => {
        check();
        finish(() => reject(new Error("等待小羊旁路回复超时，请稍后再试")));
      });
    }, timeoutMs);
    check();
  });
}

/**
 * Executes a sidechannel `/btw` query without interrupting the main agent turn.
 * 1. Tries host `agent.btw` RPC first (read-only Uniflo context + ephemeral CLI).
 * 2. On older hosts returning `unsupported` / `unknown method`:
 *    - Falls back to `sendToAssistant(...)` when relay assistant is ready.
 *    - Or sends `/btw <question>` directly when idle on `omp` / `claude`.
 */
export async function executeAgentBtw(agent: Agent, question: string): Promise<BtwResponse> {
  const cleanQuestion = question.trim();
  if (!cleanQuestion) {
    throw new Error("请输入旁路提问内容");
  }

  const startedAt = Date.now();
  const server = settingsStore.get().server;

  if (server && isMockServer(server)) {
    const answer = [
      `（演示模式 · 旁路不打断主线）已读取 **${agent.title || agent.harness}** 当前上下文：`,
      "",
      `- 当前状态：\`${agent.status}\``,
      `- 提问内容：${cleanQuestion}`,
      "",
      "旁路问答仅在只读模式下查询近期事件，不会向主会话终端写入任何字符。",
    ].join("\n");
    return {
      answer,
      model: agent.model || "demo-sidechannel",
      durationMs: Math.max(24, Date.now() - startedAt),
    };
  }

  try {
    const rpc = rpcCall as unknown as BtwRpcCall;
    const res = await rpc(agent.deviceId, "agent.btw", { agent: agent.key, question: cleanQuestion }, 60_000);
    if (res && typeof res.answer === "string" && res.answer.trim()) {
      return {
        answer: res.answer.trim(),
        model: res.model,
        durationMs: typeof res.durationMs === "number" ? res.durationMs : Math.max(1, Date.now() - startedAt),
      };
    }
    throw new Error("主机未返回旁路回答");
  } catch (err) {
    if (!isUnsupportedRpcError(err)) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  if (!assistantStore.get().loaded) {
    await loadAssistant().catch(() => {});
  }
  const assistantState = assistantStore.get();
  if (assistantState.ready) {
    const beforeIds = new Set(assistantState.items.map((x) => x.id));
    const askPrompt = [
      `请在完全不向目标 Agent 发送任何输入、不打断其运行的前提下，只读查看「${agent.title || agent.name || agent.harness}」（key: ${agent.key}）的近期对话或状态，直接回答我的旁路提问：`,
      cleanQuestion,
    ].join("\n\n");
    const replyPromise = waitForAssistantBtwReply(beforeIds, startedAt);
    await sendToAssistant(askPrompt);
    const answer = await replyPromise;
    return {
      answer,
      model: assistantStore.get().model ?? "小羊助理",
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  }

  const canonical = canonicalHarnessId(agent.harness);
  const isIdle = agent.status === "idle" || agent.status === "done";
  if (isIdle && (canonical === "omp" || canonical === "claude")) {
    await rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: `/btw ${cleanQuestion}` });
    return {
      answer: "当前主机版本暂不支持 `agent.btw` 离线旁路，已为你发送原生 `/btw` 指令到当前空闲会话中，回复将在主会话输出。",
      model: `${canonical} /btw`,
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  }

  throw new Error("当前主机版本暂不支持旁路 `agent.btw`，且小羊文字模型未配置或主会话正在运行中。请升级主机 hostd 或在「设置 → 小羊助理」配置文字模型。");
}

function formatDurationMs(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s (${Math.round(ms)}ms)`;
}

export interface BtwSideDrawerProps {
  turns?: BtwTurn[];
  turn?: BtwTurn | null;
  agent?: Pick<Agent, "status" | "harness" | "title" | "name">;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onDismiss: (turnId?: string) => void;
  onOpenFile?: (target: string) => void;
}

/**
 * Sleek pink-themed collapsible floating panel rendered above the composer
 * for `/btw` sidechannel Q&A — works in parallel even while `agent.status === "working"`.
 */
export function BtwSideDrawer({
  turns,
  turn,
  agent,
  collapsed: controlledCollapsed,
  onToggleCollapse,
  onDismiss,
  onOpenFile,
}: BtwSideDrawerProps) {
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const items: BtwTurn[] = [...(turns ?? []), ...(turn ? [turn] : [])];
  if (items.length === 0) return null;

  const collapsed = controlledCollapsed ?? localCollapsed;
  const toggleCollapse = onToggleCollapse ?? (() => setLocalCollapsed((v) => !v));
  const latest = items[items.length - 1]!;
  const latestDuration = formatDurationMs(latest.durationMs);
  const isWorking = agent?.status === "working";

  const handleCopy = (target: BtwTurn) => {
    const content = target.answer?.trim();
    if (!content) return;
    void copyToClipboard(content).then((ok) => {
      if (!ok) return;
      setCopiedId(target.id);
      window.setTimeout(() => setCopiedId((prev) => (prev === target.id ? null : prev)), 1500);
    });
  };

  return (
    <section
      className={`btw-drawer${collapsed ? " collapsed" : ""}`}
      role="region"
      aria-label="旁路提问结果"
    >
      <div className="btw-drawer-head">
        <div className="btw-drawer-title">
          <span className="btw-drawer-badge" aria-hidden="true">
            <Bot size={13} />
          </span>
          <span>旁路提问 /btw</span>
          {isWorking ? (
            <span className="btw-pill pink">
              <Sparkles size={10} />
              <span>主线运行中</span>
            </span>
          ) : null}
          {latest.model ? (
            <span className="btw-pill lav mono truncate" title={latest.model}>
              {latest.model}
            </span>
          ) : null}
          {latestDuration ? (
            <span className="btw-pill mono">{latestDuration}</span>
          ) : null}
        </div>
        <div className="btw-drawer-actions">
          {latest.status === "done" && latest.answer ? (
            <button
              type="button"
              className="btw-icon-btn"
              aria-label="复制最新旁路回答"
              title="复制回答"
              onClick={() => handleCopy(latest)}
            >
              {copiedId === latest.id ? <Check size={13} /> : <Copy size={13} />}
            </button>
          ) : null}
          <button
            type="button"
            className="btw-icon-btn"
            aria-label={collapsed ? "展开旁路面板" : "收起旁路面板"}
            aria-expanded={!collapsed}
            title={collapsed ? "展开" : "收起"}
            onClick={toggleCollapse}
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            type="button"
            className="btw-icon-btn"
            aria-label="关闭旁路面板"
            title="关闭"
            onClick={() => onDismiss()}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {!collapsed ? (
        <div className="btw-drawer-body">
          {items.map((item) => {
            const dur = formatDurationMs(item.durationMs);
            return (
              <div key={item.id} className="btw-turn">
                <div className="btw-turn-head">
                  <div className="btw-turn-q">{item.question}</div>
                  <div className="btw-turn-meta">
                    {items.length > 1 && item.model ? (
                      <span className="btw-pill lav mono truncate">{item.model}</span>
                    ) : null}
                    {items.length > 1 && dur ? <span className="btw-pill mono">{dur}</span> : null}
                    {items.length > 1 && item.status === "done" && item.answer ? (
                      <button
                        type="button"
                        className="btw-icon-btn"
                        aria-label="复制回答"
                        title="复制回答"
                        onClick={() => handleCopy(item)}
                      >
                        {copiedId === item.id ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    ) : null}
                    {items.length > 1 ? (
                      <button
                        type="button"
                        className="btw-icon-btn"
                        aria-label="移除这条旁路问答"
                        title="移除"
                        onClick={() => onDismiss(item.id)}
                      >
                        <X size={12} />
                      </button>
                    ) : null}
                  </div>
                </div>

                {item.status === "loading" ? (
                  <div className="btw-turn-loading">
                    <span className="status-dot breathe" style={{ color: "var(--accent-text)" }} />
                    <span>正在只读旁路思考，主线对话不会被打断…</span>
                  </div>
                ) : item.status === "error" ? (
                  <div className="inline-alert">{item.error || "旁路提问失败"}</div>
                ) : (
                  <div className="btw-turn-a">
                    <RichMarkdown text={item.answer || ""} onOpenFile={onOpenFile} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
