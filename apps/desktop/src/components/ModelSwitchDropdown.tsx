import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Brain, Check, ChevronLeft, ChevronRight, Cpu, Search, SlidersHorizontal } from "lucide-react";
import {
  OMP_MODEL_ROLES,
  OMP_QUICK_ROLE_CHIPS,
  inferAgentModelAndThinking,
  normalizeSwitchHarness,
  stripModelEffortSuffix,
  type Agent,
  type AgentModelOption,
  type AgentModelsResult,
  type OmpModelRole,
} from "@herdr-pocket/protocol";
import {
  collectPeerModels,
  fetchAgentModelsWithFallback,
  getInitialAgentModelsSeed,
  patchCachedAgentModelMeta,
  updateAgentRoleModel,
} from "../lib/modelCatalogClient";
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

const OMP_ROLE_DESCRIPTIONS: Record<OmpModelRole, string> = {
  default: "主模型",
  smol: "轻量快速",
  slow: "深度慢想",
  plan: "架构规划",
  commit: "提交摘要",
};

type DropdownEntry =
  | { kind: "model"; model: AgentModelOption }
  | { kind: "custom"; id: string };

interface PopCoords {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
}

export interface ModelSwitchDropdownProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode?: "model" | "thinking";
  agent: Agent;
  anchorRef: RefObject<HTMLElement | null>;
  fallbackAnchorRef?: RefObject<HTMLElement | null>;
  currentModelHint?: string;
  currentThinkingHint?: string;
  hasReasoningEvents?: boolean;
  initialOmpTab?: "session" | "roles";
  onSelectModel: (modelId: string) => void;
  onSelectThinking?: (thinkingLevel: string) => void;
  onSelectRoleModel?: (slot: OmpModelRole, modelId: string) => void;
  onLoaded?: (res: AgentModelsResult) => void;
}

/** Anchored compact dropdown menu for switching an agent's model, thinking effort, or OMP role models. */
export function ModelSwitchDropdown({
  open,
  onOpenChange,
  mode = "model",
  agent,
  anchorRef,
  fallbackAnchorRef,
  currentModelHint,
  currentThinkingHint,
  hasReasoningEvents,
  initialOmpTab = "session",
  onSelectModel,
  onSelectThinking,
  onSelectRoleModel,
  onLoaded,
}: ModelSwitchDropdownProps) {
  const isOmp = !agent.isShell && normalizeSwitchHarness(agent.harness) === "omp";
  const [dataState, setDataState] = useState<{ key: string; res: AgentModelsResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [ompTab, setOmpTab] = useState<"session" | "roles">(initialOmpTab);
  const [editingRole, setEditingRole] = useState<OmpModelRole | null>(null);
  const [roleNotice, setRoleNotice] = useState<string | null>(null);
  const [coords, setCoords] = useState<PopCoords>({
    left: 24,
    bottom: 84,
    width: mode === "thinking" ? 228 : isOmp ? 364 : 340,
    maxHeight: 320,
  });

  const seededFallback = useMemo(
    () => (open ? getInitialAgentModelsSeed(agent, collectPeerModels(agent), { hasReasoningEvents }) : null),
    [open, agent.key, agent.harness, agent.model, agent.isShell, agent.source, hasReasoningEvents],
  );
  const data = (dataState?.key === agent.key ? dataState.res : null) ?? seededFallback;

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
    setRoleNotice(null);
    setOmpTab(initialOmpTab);
    setEditingRole(null);
    const peers = collectPeerModels(agent);
    const seeded = getInitialAgentModelsSeed(agent, peers, { hasReasoningEvents });
    setDataState({ key: agent.key, res: seeded });

    let alive = true;
    setLoading(true);
    fetchAgentModelsWithFallback(agent, peers, {
      hasReasoningEvents,
      onUpdate: (updated) => {
        if (!alive) return;
        setDataState({ key: agent.key, res: updated });
        onLoaded?.(updated);
      },
    })
      .then((res) => {
        if (!alive) return;
        setError(null);
        setDataState({ key: agent.key, res });
        onLoaded?.(res);
      })
      .catch(() => {
        if (alive) setError(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const raf = requestAnimationFrame(() => {
      if (mode === "model" && (!isOmp || initialOmpTab === "session")) {
        inputRef.current?.focus();
      }
    });
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [open, agent.deviceId, agent.key, agent.harness, agent.model, agent.sessionKey, mode, hasReasoningEvents, initialOmpTab, isOmp]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const targetWidth = mode === "thinking" ? 228 : isOmp ? 364 : 340;
      const anchor = anchorRef.current ?? fallbackAnchorRef?.current ?? null;
      if (!anchor) {
        setCoords({
          left: 24,
          bottom: 84,
          width: Math.min(targetWidth, Math.max(200, window.innerWidth - 24)),
          maxHeight: 320,
        });
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(targetWidth, Math.max(200, window.innerWidth - 24));
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const bottom = window.innerHeight - rect.top + 6;
      const maxHeight = Math.max(200, Math.min(380, rect.top - 18));
      setCoords({ left, bottom, width, maxHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, mode, isOmp, anchorRef, fallbackAnchorRef]);

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
        if (editingRole) {
          setEditingRole(null);
          setQuery("");
        } else {
          onOpenChange(false);
        }
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onOpenChange, anchorRef, editingRole]);

  const inferred = useMemo(
    () =>
      agent.isShell
        ? {}
        : inferAgentModelAndThinking(agent.harness, currentModelHint || agent.model, { hasReasoningEvents }),
    [agent.isShell, agent.harness, currentModelHint, agent.model, hasReasoningEvents],
  );
  const currentModel = currentModelHint || data?.currentModel || inferred.currentModel || agent.model;
  const resolvedLookupModel =
    isOmp && currentModel?.startsWith("@")
      ? stripModelEffortSuffix(data?.modelRoles?.[currentModel.slice(1).toLowerCase()] ?? currentModel)
      : currentModel;

  const currentModelOpt = useMemo(
    () =>
      (data?.models ?? []).find(
        (m) => resolvedLookupModel && m.id.toLowerCase() === resolvedLookupModel.toLowerCase(),
      ),
    [data?.models, resolvedLookupModel],
  );
  const thinkingLevels = useMemo(() => {
    if (agent.isShell) return [];
    if (data) {
      if (currentModelOpt?.reasoning === false && !hasReasoningEvents) return [];
      const fromData = currentModelOpt?.thinkingLevels?.length
        ? currentModelOpt.thinkingLevels
        : data.thinkingLevels ?? [];
      if (fromData.length > 0) return fromData;
      if (hasReasoningEvents) return inferred.thinkingLevels ?? [];
      return [];
    }
    return inferred.thinkingLevels ?? [];
  }, [agent.isShell, data, currentModelOpt, hasReasoningEvents, inferred.thinkingLevels]);
  const currentThinking =
    thinkingLevels.length === 0
      ? ""
      : (currentThinkingHint || data?.currentThinking || inferred.currentThinking || "").toLowerCase();

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
    if (isOmp && ompTab === "roles" && !editingRole) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-model-idx="${effectiveIdx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [open, mode, effectiveIdx, entries.length, isOmp, ompTab, editingRole]);

  if (!open) return null;

  const commitModel = (id: string) => {
    const clean = id.trim();
    if (!clean) return;
    if (isOmp && clean.startsWith("@")) {
      const resolved = data?.modelRoles?.[clean.slice(1).toLowerCase()];
      if (resolved) {
        patchCachedAgentModelMeta(agent.key, { currentModel: resolved });
      }
    } else {
      patchCachedAgentModelMeta(agent.key, { currentModel: clean });
    }
    onSelectModel(clean);
    onOpenChange(false);
  };

  const commitThinking = (lvl: string) => {
    const clean = lvl.trim();
    if (!clean || !onSelectThinking) return;
    patchCachedAgentModelMeta(agent.key, { currentThinking: clean });
    onSelectThinking(clean);
    onOpenChange(false);
  };

  const commitRoleModel = async (slot: OmpModelRole, modelId: string) => {
    const clean = modelId.trim();
    if (!clean) return;
    const nextRoles = { ...(data?.modelRoles ?? {}), [slot]: clean };
    setError(null);
    setDataState((prev) => {
      const base = (prev?.key === agent.key ? prev.res : null) ?? data;
      return base ? { key: agent.key, res: { ...base, modelRoles: nextRoles } } : prev;
    });
    patchCachedAgentModelMeta(agent.key, { modelRoles: nextRoles });
    setEditingRole(null);
    setQuery("");
    setActiveIdx(0);
    setRoleNotice(`已设置 ${slot} 角色 -> ${clean}`);
    if (onSelectRoleModel) {
      onSelectRoleModel(slot, clean);
      return;
    }
    try {
      const res = await updateAgentRoleModel(agent, slot, clean);
      if (res.modelRoles) {
        setDataState((prev) => {
          const base = (prev?.key === agent.key ? prev.res : null) ?? data;
          return base ? { key: agent.key, res: { ...base, modelRoles: res.modelRoles } } : prev;
        });
      }
    } catch (err) {
      setError((err as Error).message || `更新角色 ${slot} 失败`);
    }
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

  const showRoleOverview = isOmp && ompTab === "roles" && editingRole === null;
  const roleTargetModel = editingRole ? data?.modelRoles?.[editingRole] : undefined;

  return createPortal(
    <div
      ref={popRef}
      className="model-pop"
      role="dialog"
      aria-label={isOmp && ompTab === "roles" ? "OMP 角色模型配置" : "切换模型"}
      style={{
        position: "fixed",
        left: coords.left,
        bottom: coords.bottom,
        width: coords.width,
        maxHeight: coords.maxHeight,
        zIndex: 2200,
      }}
    >
      {isOmp ? (
        <div
          style={{
            padding: "6px 8px",
            borderBottom: "1px solid var(--divider)",
            background: "var(--surface-2)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <div className="segmented" role="tablist" aria-label="OMP 模型模式" style={{ width: "100%", display: "flex" }}>
            <button
              type="button"
              role="tab"
              aria-selected={ompTab === "session"}
              className={ompTab === "session" ? "active" : ""}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "4px 8px",
                fontSize: "calc(11.5px * var(--ts, 1))",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOmpTab("session");
                setEditingRole(null);
                setQuery("");
                setActiveIdx(0);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
            >
              <Cpu size={12} />
              <span className="truncate">会话模型 (/switch)</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={ompTab === "roles"}
              className={ompTab === "roles" ? "active" : ""}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "4px 8px",
                fontSize: "calc(11.5px * var(--ts, 1))",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOmpTab("roles");
                setEditingRole(null);
                setQuery("");
                setActiveIdx(0);
              }}
            >
              <SlidersHorizontal size={12} />
              <span className="truncate">角色模型 (/model)</span>
            </button>
          </div>
        </div>
      ) : null}

      {isOmp && ompTab === "roles" && editingRole !== null ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderBottom: "1px solid var(--divider)",
            background: "var(--surface)",
          }}
        >
          <button
            type="button"
            className="model-effort-chip"
            style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setEditingRole(null);
              setQuery("");
              setActiveIdx(0);
            }}
          >
            <ChevronLeft size={12} />
            <span>返回</span>
          </button>
          <span
            className="truncate"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: "calc(11.5px * var(--ts, 1))",
              fontWeight: 700,
              color: "var(--accent-text)",
            }}
          >
            设置 {editingRole} ({OMP_ROLE_DESCRIPTIONS[editingRole]})
          </span>
        </div>
      ) : null}

      {!showRoleOverview ? (
        <div className="model-pop-search">
          <Search size={13} className="model-pop-search-ic" />
          <input
            ref={inputRef}
            type="text"
            className="model-pop-input mono"
            value={query}
            placeholder={
              editingRole
                ? `筛选或输入 ${editingRole} 角色模型 ID…`
                : "筛选或输入模型 ID…"
            }
            aria-label={editingRole ? `筛选或输入 ${editingRole} 角色模型 ID` : "筛选或输入模型 ID"}
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
                const targetId = chosen
                  ? chosen.kind === "model"
                    ? chosen.model.id
                    : chosen.id
                  : trimmedQuery;
                if (!targetId) return;
                if (editingRole) {
                  void commitRoleModel(editingRole, targetId);
                } else {
                  commitModel(targetId);
                }
              }
            }}
          />
          {loading ? (
            <span className="model-pop-badge" style={{ flexShrink: 0 }}>
              同步中
            </span>
          ) : null}
        </div>
      ) : null}

      {ompTab === "session" && thinkingLevels.length > 0 && data?.canSwitch !== false && onSelectThinking ? (
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

      {isOmp && ompTab === "session" && data?.canSwitch !== false ? (
        <div className="model-effort-bar" role="group" aria-label="OMP 角色快捷切换">
          <span className="model-effort-label">角色</span>
          <div className="model-effort-pills">
            {OMP_QUICK_ROLE_CHIPS.map((slot) => {
              const assigned = data?.modelRoles?.[slot];
              const assignedClean = assigned ? stripModelEffortSuffix(assigned).toLowerCase() : "";
              const isRoleActive = Boolean(
                assignedClean && resolvedLookupModel && assignedClean === resolvedLookupModel.toLowerCase(),
              );
              return (
                <button
                  key={slot}
                  type="button"
                  className={`model-effort-chip mono${isRoleActive ? " on" : ""}`}
                  title={assigned ? `/switch @${slot} -> ${assigned}` : `/switch @${slot}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commitModel(`@${slot}`)}
                >
                  @{slot}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {data && !data.canSwitch ? (
        <div className="model-pop-note">{data.reason || "当前会话不支持直接切换模型"}</div>
      ) : null}
      {roleNotice && ompTab === "roles" && !editingRole ? (
        <div className="model-pop-note">{roleNotice}</div>
      ) : null}
      {error ? <div className="model-pop-note">{error}</div> : null}

      <div
        ref={listRef}
        className="model-pop-list"
        role="listbox"
        aria-label={showRoleOverview ? "OMP 角色模型列表" : "可选模型列表"}
      >
        {showRoleOverview ? (
          OMP_MODEL_ROLES.map((slot) => {
            const assigned = data?.modelRoles?.[slot];
            return (
              <button
                key={slot}
                type="button"
                role="option"
                aria-selected={false}
                disabled={data?.canSwitch === false}
                className="model-pop-item"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setEditingRole(slot);
                  setQuery("");
                  setActiveIdx(0);
                  setRoleNotice(null);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                <SlidersHorizontal size={13} className="model-pop-ic" />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                  }}
                >
                  <span
                    className="truncate"
                    style={{
                      fontSize: "calc(12px * var(--ts, 1))",
                      fontWeight: 700,
                      color: "var(--ink)",
                    }}
                  >
                    {slot} ({OMP_ROLE_DESCRIPTIONS[slot]})
                  </span>
                  <span
                    className="mono truncate"
                    title={assigned || "未配置"}
                    style={{
                      fontSize: "calc(11px * var(--ts, 1))",
                      color: assigned ? "var(--accent-text)" : "var(--faint)",
                    }}
                  >
                    {assigned || "未配置（点击选择）"}
                  </span>
                </span>
                <span className="model-pop-meta">
                  <span className="model-pop-badge">分配</span>
                  <ChevronRight size={13} className="model-pop-ic" />
                </span>
              </button>
            );
          })
        ) : loading && !data && entries.length === 0 ? (
          <div className="usage-empty">正在读取可用模型…</div>
        ) : entries.length === 0 ? (
          <div className="usage-empty">
            {data?.canSwitch === false ? "没有找到匹配的模型" : "输入模型 ID 按回车即可设置"}
          </div>
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
                  onClick={() => {
                    if (editingRole) void commitRoleModel(editingRole, entry.id);
                    else commitModel(entry.id);
                  }}
                >
                  <Cpu size={13} className="model-pop-ic" />
                  <span className="model-pop-id mono truncate">
                    {editingRole ? `设为 ${editingRole}: ${entry.id}` : `切换到 ${entry.id}`}
                  </span>
                  <span className="model-pop-meta">
                    <span className="model-pop-badge">自定义</span>
                  </span>
                </button>
              );
            }
            const m = entry.model;
            const isCurrent = editingRole
              ? Boolean(
                  roleTargetModel &&
                    m.id.toLowerCase() === stripModelEffortSuffix(roleTargetModel).toLowerCase(),
                )
              : Boolean(resolvedLookupModel && m.id.toLowerCase() === resolvedLookupModel.toLowerCase());
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
                onClick={() => {
                  if (editingRole) void commitRoleModel(editingRole, m.id);
                  else commitModel(m.id);
                }}
              >
                <Cpu size={13} className="model-pop-ic" />
                <span
                  className="model-pop-id mono truncate"
                  title={m.label && m.label !== m.id ? `${m.id} · ${m.label}` : m.id}
                >
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
