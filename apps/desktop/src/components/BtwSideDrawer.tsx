import { useState } from "react";
import { Bot, Check, ChevronDown, ChevronUp, Copy, Sparkles, X } from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { assistantStore, loadAssistant, sendToAssistant, type AssistantStoreState } from "../lib/assistant";
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
  status: "loading" | "streaming" | "done" | "error";
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

export interface BtwExecutionDeps {
  rpcCall: typeof rpcCall;
  loadAssistant: typeof loadAssistant;
  sendToAssistant: typeof sendToAssistant;
  getAssistantState: () => AssistantStoreState;
  subscribeAssistant: typeof assistantStore.subscribe;
  getServer: () => string | null;
}

export interface ExecuteAgentBtwOptions {
  onStream?: (partialAnswer: string, model?: string) => void;
  timeoutMs?: number;
  settleMs?: number;
  deps?: Partial<BtwExecutionDeps>;
}

export interface WaitForAssistantBtwReplyOptions {
  onStream?: (partialAnswer: string, model?: string) => void;
  timeoutMs?: number;
  settleMs?: number;
  signal?: AbortSignal;
  getAssistantState?: () => AssistantStoreState;
  subscribeAssistant?: typeof assistantStore.subscribe;
  loadAssistant?: typeof loadAssistant;
}

type BtwRpcCall = (
  to: string,
  method: "agent.btw",
  params: { agent: string; question: string },
  timeoutMs?: number,
) => Promise<{ answer?: string; model?: string; durationMs?: number }>;

const ASSISTANT_SETTLE_MS = 150;

function isUnsupportedRpcError(err: unknown): boolean {
  if (err instanceof RelayError && err.code === "unsupported") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /unsupported|unknown method|method not found|未实现|不支持/i.test(msg);
}

/**
 * Waits for the assistant reply corresponding to a `/btw` fallback turn.
 * Streams incremental chunks via `onStream` while `busy === true`, and only resolves once
 * a matching reply exists AND `busy === false` for `settleMs` (150ms default) so final
 * `assistant_item` frames arriving right alongside `assistant_busy: false` are never truncated.
 */
export function waitForAssistantBtwReply(
  beforeIds: ReadonlySet<string>,
  startedAt: number,
  opts?: WaitForAssistantBtwReplyOptions | number,
): Promise<string> {
  const timeoutMs = typeof opts === "number" ? opts : (opts?.timeoutMs ?? 45_000);
  const settleMs = typeof opts === "number" ? ASSISTANT_SETTLE_MS : (opts?.settleMs ?? ASSISTANT_SETTLE_MS);
  const onStream = typeof opts === "number" ? undefined : opts?.onStream;
  const signal = typeof opts === "number" ? undefined : opts?.signal;
  const getState = (typeof opts !== "number" && opts?.getAssistantState) || assistantStore.get;
  const subscribe = (typeof opts !== "number" && opts?.subscribeAssistant) || assistantStore.subscribe;
  const reloadAssistant = (typeof opts !== "number" && opts?.loadAssistant) || loadAssistant;

  return new Promise((resolve, reject) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastStreamedText = "";
    let sawBusy = false;
    const initialError = getState().error;

    const findReply = (items: AssistantStoreState["items"]) =>
      [...items]
        .reverse()
        .find(
          (item) =>
            item.role === "assistant" &&
            !beforeIds.has(item.id) &&
            item.ts >= startedAt - 2000 &&
            (item.text.trim().length > 0 || Boolean(item.error)),
        );

    const clearSettleTimer = () => {
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    let onAbort: (() => void) | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      clearSettleTimer();
      timer = null;
      unsub?.();
      unsub = null;
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    onAbort = () => {
      finish(() => reject(new Error("旁路提问已取消")));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const check = () => {
      if (settled) return;
      const s = getState();
      if (s.busy) sawBusy = true;

      const reply = findReply(s.items);
      if (reply) {
        if (reply.error) {
          clearSettleTimer();
          finish(() => reject(new Error(reply.text.trim() || "小羊助理回答失败")));
          return;
        }

        if (reply.text !== lastStreamedText) {
          lastStreamedText = reply.text;
          onStream?.(reply.text, s.model ?? undefined);
          if (!s.busy) clearSettleTimer();
        }

        if (s.busy) {
          clearSettleTimer();
          return;
        }

        if (!settleTimer) {
          settleTimer = setTimeout(() => {
            settleTimer = null;
            if (settled) return;
            const latest = getState();
            if (latest.busy) {
              sawBusy = true;
              return;
            }
            const finalReply = findReply(latest.items);
            if (finalReply) {
              if (finalReply.error) {
                finish(() => reject(new Error(finalReply.text.trim() || "小羊助理回答失败")));
                return;
              }
              if (finalReply.text !== lastStreamedText) {
                lastStreamedText = finalReply.text;
                onStream?.(finalReply.text, latest.model ?? undefined);
              }
              finish(() => resolve(finalReply.text));
              return;
            }
            if (latest.error && (sawBusy || latest.error !== initialError)) {
              finish(() => reject(new Error(latest.error!)));
            }
          }, settleMs);
        }
        return;
      }

      clearSettleTimer();
      if (!s.busy && s.error && (sawBusy || s.error !== initialError)) {
        finish(() => reject(new Error(s.error!)));
      }
    };

    unsub = subscribe(() => check());
    timer = setTimeout(() => {
      clearSettleTimer();
      void reloadAssistant().finally(() => {
        if (settled) return;
        const latest = getState();
        const finalReply = findReply(latest.items);
        if (finalReply && !latest.busy) {
          if (finalReply.error) {
            finish(() => reject(new Error(finalReply.text.trim() || "小羊助理回答失败")));
          } else {
            if (finalReply.text !== lastStreamedText) {
              lastStreamedText = finalReply.text;
              onStream?.(finalReply.text, latest.model ?? undefined);
            }
            finish(() => resolve(finalReply.text));
          }
          return;
        }
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
 *    - Falls back to `sendToAssistant(...)` with live streaming updates when relay assistant is ready.
 *    - Or sends `/btw <question>` directly when idle on `omp` / `claude`.
 */
export async function executeAgentBtw(
  agent: Agent,
  question: string,
  opts?: ExecuteAgentBtwOptions,
): Promise<BtwResponse> {
  const cleanQuestion = question.trim();
  if (!cleanQuestion) {
    throw new Error("请输入旁路提问内容");
  }

  const startedAt = Date.now();
  const deps: BtwExecutionDeps = {
    rpcCall,
    loadAssistant,
    sendToAssistant,
    getAssistantState: assistantStore.get,
    subscribeAssistant: assistantStore.subscribe,
    getServer: () => settingsStore.get().server,
    ...opts?.deps,
  };
  const server = deps.getServer();

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
    const rpc = deps.rpcCall as unknown as BtwRpcCall;
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

  if (!deps.getAssistantState().loaded) {
    await deps.loadAssistant().catch(() => {});
  }
  const assistantState = deps.getAssistantState();
  if (assistantState.ready) {
    const beforeIds = new Set(assistantState.items.map((x) => x.id));
    const askPrompt = [
      `请在完全不向目标 Agent 发送任何输入、不打断其运行的前提下，只读查看「${agent.title || agent.name || agent.harness}」（key: ${agent.key}）的近期对话或状态，直接回答我的旁路提问：`,
      cleanQuestion,
    ].join("\n\n");
    const ac = new AbortController();
    const replyPromise = waitForAssistantBtwReply(beforeIds, startedAt, {
      onStream: opts?.onStream,
      timeoutMs: opts?.timeoutMs,
      settleMs: opts?.settleMs,
      signal: ac.signal,
      getAssistantState: deps.getAssistantState,
      subscribeAssistant: deps.subscribeAssistant,
      loadAssistant: deps.loadAssistant,
    });
    try {
      await deps.sendToAssistant(askPrompt);
    } catch (err) {
      ac.abort();
      replyPromise.catch(() => {});
      throw err;
    }
    const answer = await replyPromise;
    return {
      answer,
      model: deps.getAssistantState().model ?? "小羊助理",
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  }

  const canonical = canonicalHarnessId(agent.harness);
  const isIdle = agent.status === "idle" || agent.status === "done";
  if (isIdle && (canonical === "omp" || canonical === "claude")) {
    await deps.rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: `/btw ${cleanQuestion}` });
    return {
      answer: "当前主机版本暂不支持 `agent.btw` 离线旁路，已为你发送原生 `/btw` 指令到当前空闲会话中，回复将在主会话输出。",
      model: `${canonical} /btw`,
      durationMs: Math.max(1, Date.now() - startedAt),
    };
  }

  throw new Error("当前主机版本暂不支持旁路 `agent.btw`，且小羊文字模型未配置或主会话正在运行中。请升级主机 hostd 或在「设置 → 小羊助理」配置文字模型。");
}

export function formatDurationMs(ms?: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
          <span className="btw-drawer-heading">旁路提问 /btw</span>
          {isWorking ? (
            <span className="btw-pill pink">
              <Sparkles size={10} />
              <span>主线运行中</span>
            </span>
          ) : null}
          {latest.status === "streaming" ? (
            <span className="btw-pill pink">
              <span className="status-dot breathe" aria-hidden="true" />
              <span>生成中</span>
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
            const hasPartialAnswer = Boolean(item.answer && item.answer.trim().length > 0);
            const isStreaming = item.status === "streaming" || (item.status === "loading" && hasPartialAnswer);
            return (
              <div key={item.id} className="btw-turn">
                <div className="btw-turn-head">
                  <div className="btw-turn-q">
                    <span className="btw-turn-q-label">问：</span>
                    <span className="btw-turn-q-text">{item.question}</span>
                  </div>
                  {items.length > 1 ? (
                    <div className="btw-turn-meta">
                      {item.model ? (
                        <span className="btw-pill lav mono truncate" title={item.model}>
                          {item.model}
                        </span>
                      ) : null}
                      {dur ? <span className="btw-pill mono">{dur}</span> : null}
                      {item.status === "done" && item.answer ? (
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
                      <button
                        type="button"
                        className="btw-icon-btn"
                        aria-label="移除这条旁路问答"
                        title="移除"
                        onClick={() => onDismiss(item.id)}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : null}
                </div>

                {item.status === "error" ? (
                  <div className="inline-alert">{item.error || "旁路提问失败"}</div>
                ) : isStreaming ? (
                  <div className="btw-turn-a streaming">
                    <RichMarkdown text={item.answer || ""} onOpenFile={onOpenFile} />
                    <div className="btw-turn-streaming" role="status" aria-live="polite">
                      <span className="status-dot breathe" style={{ color: "var(--accent-text)" }} aria-hidden="true" />
                      <span>正在旁路流式输出…</span>
                    </div>
                  </div>
                ) : item.status === "loading" ? (
                  <div className="btw-turn-loading" role="status" aria-live="polite">
                    <span className="status-dot breathe" style={{ color: "var(--accent-text)" }} aria-hidden="true" />
                    <span>正在只读旁路思考，主线对话不会被打断…</span>
                  </div>
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
