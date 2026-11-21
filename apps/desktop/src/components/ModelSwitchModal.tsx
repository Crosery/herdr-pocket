import { useEffect, useMemo, useState } from "react";
import { Check, Cpu } from "lucide-react";
import type { Agent, AgentModelOption, AgentModelsResult } from "@herdr-pocket/protocol";
import { rpcCall } from "../lib/relay";
import { PocketButton, PocketInput, PocketModal } from "./PocketUI";

function fmtContext(tokens?: number): string {
  if (!tokens || !Number.isFinite(tokens)) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

function sourceLabel(src: AgentModelOption["source"]): string {
  switch (src) {
    case "current":
      return "当前";
    case "recent":
      return "常用";
    case "catalog":
    default:
      return "目录";
  }
}

/** Modal picker for discovering and switching an active agent's model (`/model`). */
export function ModelSwitchModal({
  open,
  onOpenChange,
  agent,
  onSelectModel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agent: Agent;
  onSelectModel: (modelId: string) => void;
}) {
  const [data, setData] = useState<AgentModelsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    setError(null);
    let alive = true;
    setLoading(true);
    rpcCall(agent.deviceId, "agent.models", { agent: agent.key })
      .then((res) => {
        if (alive) setData(res);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message || "读取模型列表失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, agent.deviceId, agent.key]);

  const filtered = useMemo(() => {
    const list = data?.models ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        m.label.toLowerCase().includes(q) ||
        (m.provider?.toLowerCase().includes(q) ?? false),
    );
  }, [data?.models, query]);

  const trimmedQuery = query.trim();
  const hasExactMatch = trimmedQuery ? filtered.some((m) => m.id.toLowerCase() === trimmedQuery.toLowerCase()) : false;
  const canCustom = Boolean(trimmedQuery && !hasExactMatch && data?.canSwitch !== false);
  const effectiveIdx = Math.min(activeIdx, Math.max(0, filtered.length - 1));
  const currentModel = data?.currentModel || agent.model;

  const commit = (id: string) => {
    const clean = id.trim();
    if (!clean) return;
    onSelectModel(clean);
    onOpenChange(false);
  };

  return (
    <PocketModal
      open={open}
      onOpenChange={onOpenChange}
      title="切换模型"
      subtitle={`${agent.harness}${currentModel ? ` · 当前：${currentModel}` : ""}`}
      width={460}
    >
      <div className="stack" style={{ gap: 10 }}>
        {data && !data.canSwitch ? (
          <div className="inline-alert">{data.reason || "当前会话不支持直接切换模型"}</div>
        ) : null}
        {error ? <div className="inline-alert">{error}</div> : null}

        <PocketInput
          mono
          autoFocus
          value={query}
          placeholder="筛选模型，或直接输入模型 ID 按回车切换…"
          aria-label="筛选或输入模型 ID"
          disabled={data?.canSwitch === false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" && filtered.length > 0) {
              e.preventDefault();
              setActiveIdx((i) => (i + 1) % filtered.length);
            } else if (e.key === "ArrowUp" && filtered.length > 0) {
              e.preventDefault();
              setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
            } else if (e.key === "Enter" && data?.canSwitch !== false) {
              e.preventDefault();
              if (filtered.length > 0) {
                commit(filtered[effectiveIdx]!.id);
              } else if (trimmedQuery) {
                commit(trimmedQuery);
              }
            }
          }}
        />

        <div className="model-switch-list" role="listbox" aria-label="可选模型列表">
          {loading && !data ? (
            <div className="usage-empty">正在发现可用模型…</div>
          ) : filtered.length === 0 && !canCustom ? (
            <div className="usage-empty">没有找到匹配的模型</div>
          ) : (
            filtered.map((m, idx) => {
              const isCurrent = Boolean(currentModel && m.id.toLowerCase() === currentModel.toLowerCase());
              const isHi = idx === effectiveIdx;
              const ctxText = fmtContext(m.contextWindow);
              return (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={isHi}
                  disabled={data?.canSwitch === false}
                  className={`model-switch-row${isHi ? " on" : ""}${isCurrent ? " current" : ""}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(m.id)}
                >
                  <span className="model-switch-ic">
                    <Cpu size={13} />
                  </span>
                  <span className="model-switch-main">
                    <span className="model-switch-id mono truncate">{m.id}</span>
                    {m.label && m.label !== m.id ? (
                      <span className="model-switch-sub truncate">{m.label}</span>
                    ) : null}
                  </span>
                  <span className="model-switch-tags">
                    {ctxText ? <span className="model-tag mono">{ctxText}</span> : null}
                    {m.reasoning ? <span className="model-tag">思考</span> : null}
                    <span className={`model-tag src-${m.source}`}>{sourceLabel(m.source)}</span>
                    {isCurrent ? <Check size={14} style={{ color: "var(--accent-text)", flexShrink: 0 }} /> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {canCustom ? (
          <div className="between" style={{ gap: 8 }}>
            <span className="faint truncate mono">自定义模型：{trimmedQuery}</span>
            <PocketButton size="sm" variant="soft" onClick={() => commit(trimmedQuery)}>
              切换到 {trimmedQuery}
            </PocketButton>
          </div>
        ) : null}
      </div>
    </PocketModal>
  );
}
