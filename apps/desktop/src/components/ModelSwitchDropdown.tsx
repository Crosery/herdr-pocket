import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Brain, Check, Cpu, Search } from "lucide-react";
import type { Agent, AgentModelOption, AgentModelsResult } from "@herdr-pocket/protocol";
import { rpcCall } from "../lib/relay";
import { overlayStore } from "./PocketUI";

function fmtContext(tokens?: number): string {
  if (!tokens || !Number.isFinite(tokens)) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

const EFFORT_LABELS: Record<string, string> = {
  off: "关闭",
  none: "关闭",
  minimal: "极简",
  min: "极简",
  low: "低",
  medium: "中",
  med: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "极致",
  auto: "自动",
  default: "默认",
  normal: "标准",
  fast: "快速",
  smart: "深度",
  rush: "极速",
};

/** Returns a localized display label for a canonical thinking/reasoning effort level. */
export function formatEffortLabel(level?: string): string {
  if (!level) return "思考等级";
  const k = level.trim().toLowerCase();
  return EFFORT_LABELS[k] ?? level;
}

type DropdownEntry =
  | { kind: "model"; model: AgentModelOption }
  | { kind: "custom"; id: string };

interface PopCoords {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

/** Anchored compact dropdown menu for switching an agent's model or thinking/reasoning effort. */
export function ModelSwitchDropdown({
  open,
  onOpenChange,
  mode = "model",
  agent,
  anchorRef,
  fallbackAnchorRef,
  currentModelHint,
  currentThinkingHint,
  onSelectModel,
  onSelectThinking,
  onLoaded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode?: "model" | "thinking";
  agent: Agent;
  anchorRef: RefObject<HTMLElement | null>;
  fallbackAnchorRef?: RefObject<HTMLElement | null>;
  currentModelHint?: string;
  currentThinkingHint?: string;
  onSelectModel: (modelId: string) => void;
  onSelectThinking?: (thinkingLevel: string) => void;
  onLoaded?: (res: AgentModelsResult) => void;
}) {
  const [data, setData] = useState<AgentModelsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [coords, setCoords] = useState<PopCoords>({
    left: 24,
    bottom: 84,
    width: mode === "thinking" ? 228 : 340,
    maxHeight: 300,
  });

  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    setError(null);
    let alive = true;
    setLoading(true);
    rpcCall(agent.deviceId, "agent.models", { agent: agent.key })
      .then((res) => {
        if (!alive) return;
        setData(res);
        onLoaded?.(res);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message || "读取模型列表失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const raf = requestAnimationFrame(() => {
      if (mode === "model") inputRef.current?.focus();
    });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [open, agent.deviceId, agent.key, mode]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const targetWidth = mode === "thinking" ? 228 : 340;
      const anchor = anchorRef.current ?? fallbackAnchorRef?.current ?? null;
      if (!anchor) {
        setCoords({
          left: 24,
          bottom: 84,
          width: Math.min(targetWidth, Math.max(200, window.innerWidth - 24)),
          maxHeight: 300,
        });
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(targetWidth, Math.max(200, window.innerWidth - 24));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const bottom = window.innerHeight - rect.top + 6;
      const maxHeight = Math.max(180, Math.min(320, rect.top - 18));
      setCoords({ left, bottom, width, maxHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, mode, anchorRef, fallbackAnchorRef]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onOpenChange, anchorRef]);

  const currentModel = currentModelHint || data?.currentModel || agent.model;
  const currentThinking = (currentThinkingHint || data?.currentThinking || "").toLowerCase();

  const currentModelOpt = useMemo(
    () => (data?.models ?? []).find((m) => currentModel && m.id.toLowerCase() === currentModel.toLowerCase()),
    [data?.models, currentModel],
  );
  const thinkingLevels = useMemo(
    () => (currentModelOpt?.thinkingLevels?.length ? currentModelOpt.thinkingLevels : data?.thinkingLevels ?? []),
    [currentModelOpt, data?.thinkingLevels],
  );

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

  const entries = useMemo<DropdownEntry[]>(() => {
    const out: DropdownEntry[] = filtered.map((model) => ({ kind: "model", model }));
    if (canCustom) out.push({ kind: "custom", id: trimmedQuery });
    return out;
  }, [filtered, canCustom, trimmedQuery]);

  const effectiveIdx = entries.length > 0 ? Math.min(activeIdx, entries.length - 1) : 0;

  useEffect(() => {
    if (!open || mode !== "model" || entries.length === 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-model-idx="${effectiveIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [open, mode, effectiveIdx, entries.length]);

  if (!open) return null;

  const commitModel = (id: string) => {
    const clean = id.trim();
    if (!clean) return;
    onSelectModel(clean);
    onOpenChange(false);
  };

  const commitThinking = (lvl: string) => {
    const clean = lvl.trim();
    if (!clean || !onSelectThinking) return;
    onSelectThinking(clean);
    onOpenChange(false);
  };

  if (mode === "thinking") {
    return createPortal(
      <div
        ref={popRef}
        className="model-pop"
        role="dialog"
        aria-label="切换思考等级"
        style={{
          position: "fixed",
          left: coords.left,
          bottom: coords.bottom,
          width: coords.width,
          maxHeight: coords.maxHeight,
          zIndex: 2200,
        }}
      >
        <div className="model-pop-search">
          <Brain size={13} className="model-pop-search-ic" />
          <span className="model-pop-head-title">{data?.thinkingLabel || "思考等级"}</span>
        </div>
        {data && data.canSwitch === false ? (
          <div className="model-pop-note">{data.reason || "当前会话不支持切换思考等级"}</div>
        ) : null}
        {error ? <div className="model-pop-note">{error}</div> : null}
        <div ref={listRef} className="model-pop-list" role="listbox" aria-label="可选思考等级列表">
          {loading && !data && thinkingLevels.length === 0 ? (
            <div className="usage-empty">正在读取思考等级…</div>
          ) : thinkingLevels.length === 0 ? (
            <div className="usage-empty">当前模型未提供思考等级切换</div>
          ) : (
            thinkingLevels.map((lvl) => {
              const isCur = currentThinking === lvl.toLowerCase();
              return (
                <button
                  key={lvl}
                  type="button"
                  role="option"
                  aria-selected={isCur}
                  disabled={data?.canSwitch === false}
                  className={`model-pop-item${isCur ? " on current" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitThinking(lvl)}
                >
                  <Brain size={13} className="model-pop-ic" />
                  <span className="model-pop-id truncate">{formatEffortLabel(lvl)}</span>
                  <span className="model-pop-meta">
                    <span className="model-pop-badge mono">{lvl}</span>
                    {isCur ? <Check size={13} className="model-pop-check" /> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={popRef}
      className="model-pop"
      role="dialog"
      aria-label="切换模型"
      style={{
        position: "fixed",
        left: coords.left,
        bottom: coords.bottom,
        width: coords.width,
        maxHeight: coords.maxHeight,
        zIndex: 2200,
      }}
    >
      <div className="model-pop-search">
        <Search size={13} className="model-pop-search-ic" />
        <input
          ref={inputRef}
          type="text"
          className="model-pop-input mono"
          value={query}
          placeholder="筛选或输入模型 ID…"
          aria-label="筛选或输入模型 ID"
          disabled={data?.canSwitch === false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" && entries.length > 0) {
              e.preventDefault();
              setActiveIdx((i) => (i + 1) % entries.length);
            } else if (e.key === "ArrowUp" && entries.length > 0) {
              e.preventDefault();
              setActiveIdx((i) => (i - 1 + entries.length) % entries.length);
            } else if (e.key === "Enter" && data?.canSwitch !== false) {
              e.preventDefault();
              const chosen = entries[effectiveIdx];
              if (chosen) {
                commitModel(chosen.kind === "model" ? chosen.model.id : chosen.id);
              } else if (trimmedQuery) {
                commitModel(trimmedQuery);
              }
            }
          }}
        />
      </div>

      {thinkingLevels.length > 0 && data?.canSwitch !== false && onSelectThinking ? (
        <div className="model-effort-bar" role="group" aria-label="快捷切换思考等级">
          <span className="model-effort-label">思考</span>
          <div className="model-effort-pills">
            {thinkingLevels.map((lvl) => {
              const active = currentThinking === lvl.toLowerCase();
              return (
                <button
                  key={lvl}
                  type="button"
                  className={`model-effort-chip${active ? " on" : ""}`}
                  title={`切换思考等级：${lvl}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitThinking(lvl)}
                >
                  {formatEffortLabel(lvl)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {data && !data.canSwitch ? (
        <div className="model-pop-note">{data.reason || "当前会话不支持直接切换模型"}</div>
      ) : null}
      {error ? <div className="model-pop-note">{error}</div> : null}

      <div ref={listRef} className="model-pop-list" role="listbox" aria-label="可选模型列表">
        {loading && !data ? (
          <div className="usage-empty">正在读取可用模型…</div>
        ) : entries.length === 0 ? (
          <div className="usage-empty">没有找到匹配的模型</div>
        ) : (
          entries.map((entry, idx) => {
            const isHi = idx === effectiveIdx;
            if (entry.kind === "custom") {
              return (
                <button
                  key={`custom-${entry.id}`}
                  type="button"
                  role="option"
                  aria-selected={isHi}
                  data-model-idx={idx}
                  disabled={data?.canSwitch === false}
                  className={`model-pop-item${isHi ? " on" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commitModel(entry.id)}
                >
                  <Cpu size={13} className="model-pop-ic" />
                  <span className="model-pop-id mono truncate">切换到 {entry.id}</span>
                  <span className="model-pop-meta">
                    <span className="model-pop-badge">自定义</span>
                  </span>
                </button>
              );
            }
            const m = entry.model;
            const isCurrent = Boolean(currentModel && m.id.toLowerCase() === currentModel.toLowerCase());
            const ctxText = fmtContext(m.contextWindow);
            return (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={isHi}
                data-model-idx={idx}
                disabled={data?.canSwitch === false}
                className={`model-pop-item${isHi ? " on" : ""}${isCurrent ? " current" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => commitModel(m.id)}
              >
                <Cpu size={13} className="model-pop-ic" />
                <span className="model-pop-id mono truncate" title={m.label && m.label !== m.id ? `${m.id} · ${m.label}` : m.id}>
                  {m.id}
                </span>
                <span className="model-pop-meta">
                  {ctxText ? <span className="model-pop-badge mono">{ctxText}</span> : null}
                  {m.reasoning ? <span className="model-pop-badge">思考</span> : null}
                  {isCurrent ? <Check size={13} className="model-pop-check" /> : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>,
    document.body,
  );
}
