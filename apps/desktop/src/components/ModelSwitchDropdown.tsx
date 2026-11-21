import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, Cpu, Search } from "lucide-react";
import type { Agent, AgentModelOption, AgentModelsResult } from "@herdr-pocket/protocol";
import { rpcCall } from "../lib/relay";
import { overlayStore } from "./PocketUI";

function fmtContext(tokens?: number): string {
  if (!tokens || !Number.isFinite(tokens)) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1_000)}k`;
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

/** Anchored compact dropdown menu for discovering and switching an active agent's model. */
export function ModelSwitchDropdown({
  open,
  onOpenChange,
  agent,
  anchorRef,
  fallbackAnchorRef,
  onSelectModel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agent: Agent;
  anchorRef: RefObject<HTMLElement | null>;
  fallbackAnchorRef?: RefObject<HTMLElement | null>;
  onSelectModel: (modelId: string) => void;
}) {
  const [data, setData] = useState<AgentModelsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [coords, setCoords] = useState<PopCoords>({
    left: 24,
    bottom: 84,
    width: 320,
    maxHeight: 280,
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
        if (alive) setData(res);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message || "读取模型列表失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [open, agent.deviceId, agent.key]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = anchorRef.current ?? fallbackAnchorRef?.current ?? null;
      if (!anchor) {
        setCoords({
          left: 24,
          bottom: 84,
          width: Math.min(340, Math.max(240, window.innerWidth - 24)),
          maxHeight: 280,
        });
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(340, Math.max(240, window.innerWidth - 24));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const bottom = window.innerHeight - rect.top + 6;
      const maxHeight = Math.max(180, Math.min(300, rect.top - 18));
      setCoords({ left, bottom, width, maxHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, anchorRef, fallbackAnchorRef]);

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
  const currentModel = data?.currentModel || agent.model;

  useEffect(() => {
    if (!open || entries.length === 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-model-idx="${effectiveIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [open, effectiveIdx, entries.length]);

  if (!open) return null;

  const commit = (id: string) => {
    const clean = id.trim();
    if (!clean) return;
    onSelectModel(clean);
    onOpenChange(false);
  };

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
                commit(chosen.kind === "model" ? chosen.model.id : chosen.id);
              } else if (trimmedQuery) {
                commit(trimmedQuery);
              }
            }
          }}
        />
      </div>

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
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => commit(entry.id)}
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
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => commit(m.id)}
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
