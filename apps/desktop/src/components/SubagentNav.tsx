import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  GitBranch,
  PanelRightOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import type { SubSession } from "@herdr-pocket/protocol";
import { rpcCall } from "../lib/relay";
import { relTime } from "../lib/store";
import { shellStore } from "../shell/shellStore";
import { ModelBrandIcon } from "./ModelBrandIcon";
import { overlayStore } from "./PocketUI";

const ROLE_LABELS: Record<string, { label: string; tone: "lav" | "sky" | "mint" | "pink" | "warn" }> = {
  research: { label: "调研", tone: "lav" },
  researcher: { label: "调研", tone: "lav" },
  explore: { label: "探索", tone: "sky" },
  explorer: { label: "探索", tone: "sky" },
  review: { label: "审核", tone: "warn" },
  reviewer: { label: "审核", tone: "warn" },
  code: { label: "编码", tone: "mint" },
  coder: { label: "编码", tone: "mint" },
  worker: { label: "执行", tone: "mint" },
  task: { label: "任务", tone: "mint" },
  test: { label: "测试", tone: "sky" },
  tester: { label: "测试", tone: "sky" },
  qa: { label: "质检", tone: "warn" },
  plan: { label: "规划", tone: "lav" },
  planner: { label: "规划", tone: "lav" },
  "image-generator": { label: "生图", tone: "pink" },
  self: { label: "子会话", tone: "pink" },
  subagent: { label: "子会话", tone: "pink" },
  general: { label: "通用", tone: "lav" },
};

function cleanPreviewHeadline(raw?: string): string {
  if (!raw) return "";
  let text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  // Strip system-injected message wrappers like `[Message] timestamp=... content=...` or `<SYSTEM_MESSAGE>`
  text = text
    .replace(/<\/?SYSTEM_MESSAGE>/gi, " ")
    .replace(/^\[Message\][^\n]*?\bcontent=/i, "")
    .replace(/^#+\s*/gm, "");
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^timestamp=|^sender=|^priority=/i.test(l));
  if (!firstLine) return "";
  const cleaned = firstLine.replace(/\s+/g, " ").trim();
  return cleaned.length > 56 ? `${cleaned.slice(0, 55)}…` : cleaned;
}

export interface SubagentDisplayInfo {
  headline: string;
  roleLabel?: string;
  roleTone: "lav" | "sky" | "mint" | "pink" | "warn";
  secondary?: string;
}

/**
 * Separates generic subagent role slugs (`research`, `explore`, `self`, etc.) into a
 * semantic role badge while promoting the real task prompt / preview into the row headline.
 */
export function parseSubagentDisplay(
  s: Pick<SubSession, "key" | "title" | "preview" | "role" | "harness">,
): SubagentDisplayInfo {
  const rawTitle = s.title?.trim() ?? "";
  const rawRole = s.role?.trim() ?? "";
  const titleSlug = rawTitle.toLowerCase();
  const roleSlug = rawRole.toLowerCase();

  const matchedRole = ROLE_LABELS[roleSlug] ?? ROLE_LABELS[titleSlug];
  const isGenericTitle = !rawTitle || Boolean(ROLE_LABELS[titleSlug]) || /^[a-z0-9_-]{2,20}$/.test(rawTitle) && rawTitle === titleSlug;
  const previewLine = cleanPreviewHeadline(s.preview);

  if (isGenericTitle) {
    const headline = previewLine || rawTitle || s.key;
    const roleLabel = matchedRole?.label ?? (rawRole || (rawTitle && rawTitle !== headline ? rawTitle : undefined));
    return {
      headline,
      ...(roleLabel ? { roleLabel } : {}),
      roleTone: matchedRole?.tone ?? "lav",
      secondary: rawTitle && rawTitle !== headline && !matchedRole ? rawTitle : undefined,
    };
  }

  return {
    headline: rawTitle.length > 56 ? `${rawTitle.slice(0, 55)}…` : rawTitle,
    ...(matchedRole ? { roleLabel: matchedRole.label } : rawRole ? { roleLabel: rawRole } : {}),
    roleTone: matchedRole?.tone ?? "pink",
    secondary: previewLine && previewLine !== rawTitle ? previewLine : undefined,
  };
}

export function subLabel(s: Pick<SubSession, "key" | "title" | "preview" | "role" | "harness">): string {
  return parseSubagentDisplay(s).headline;
}

/**
 * Computes honest duration for a subagent:
 * - Working: elapsed since `startedAt ?? statusSince`
 * - Completed with explicit `startedAt`: elapsed `updatedAt - startedAt` (if >= 1s)
 * - Completed without `startedAt`: NEVER fabricates `"0秒"` from `statusSince === updatedAt`; returns `relTime(updatedAt)` instead.
 */
export function fmtSubDuration(s: SubSession, now: number): string | null {
  if (s.status === "working") {
    const start = s.startedAt ?? s.statusSince;
    if (!start || now < start) return "运行中";
    const sec = Math.max(1, Math.floor((now - start) / 1000));
    if (sec < 60) return `${sec}秒`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}分${String(sec % 60).padStart(2, "0")}秒`;
    const hr = Math.floor(min / 60);
    return `${hr}时${String(min % 60).padStart(2, "0")}分`;
  }
  if (s.startedAt && s.updatedAt && s.updatedAt > s.startedAt) {
    const sec = Math.floor((s.updatedAt - s.startedAt) / 1000);
    if (sec >= 1) {
      if (sec < 60) return `${sec}秒`;
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}分${String(sec % 60).padStart(2, "0")}秒`;
      const hr = Math.floor(min / 60);
      return `${hr}时${String(min % 60).padStart(2, "0")}分`;
    }
  }
  return s.updatedAt ? relTime(s.updatedAt) : null;
}

function clampPopoverPos(rect: DOMRect, menuWidth = 412): { top: number; left: number; maxWidth: number } {
  if (typeof window === "undefined") return { top: rect.bottom + 6, left: rect.left, maxWidth: menuWidth };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(menuWidth, Math.max(264, vw - 16));
  const left = Math.max(8, Math.min(vw - width - 8, rect.right - width));
  const estHeight = 390;
  const top =
    rect.bottom + 6 + estHeight > vh - 8 && rect.top - estHeight > 12
      ? Math.max(8, rect.top - 6 - estHeight)
      : rect.bottom + 6;
  return { top, left, maxWidth: width };
}

interface SubTreeRowsProps {
  deviceId: string;
  agentKey: string;
  items: SubSession[];
  trailPrefix: SubSession[];
  activeSubKey?: string;
  childrenMap: Record<string, SubSession[]>;
  loadingMap: Record<string, boolean>;
  expanded: Set<string>;
  now: number;
  level: number;
  onToggleBranch: (s: SubSession) => void;
  onSelectSub: (s: SubSession, ancestors: SubSession[]) => void;
  onOpenAside?: (s: SubSession, ancestors: SubSession[]) => void;
  closeMenu: () => void;
}

function SubTreeRows({
  deviceId,
  agentKey,
  items,
  trailPrefix,
  activeSubKey,
  childrenMap,
  loadingMap,
  expanded,
  now,
  level,
  onToggleBranch,
  onSelectSub,
  onOpenAside,
  closeMenu,
}: SubTreeRowsProps) {
  return (
    <>
      {items.map((item) => {
        const kids = childrenMap[item.key];
        const hasKids = item.children > 0 || Boolean(kids?.length);
        const isExpanded = hasKids && expanded.has(item.key);
        const isCurrent = item.key === activeSubKey;
        const disp = parseSubagentDisplay(item);
        const dur = fmtSubDuration(item, now);
        const isWorking = item.status === "working";
        const costText =
          item.costUsd !== undefined && item.costUsd > 0
            ? `$${item.costUsd.toFixed(item.costUsd >= 1 ? 2 : 3)}`
            : null;
        const stepsText = item.steps !== undefined && item.steps > 0 ? `${item.steps} 步` : null;

        return (
          <div key={item.key} className="sub-tree-node">
            <div
              role="treeitem"
              tabIndex={0}
              aria-level={level}
              aria-current={isCurrent ? "page" : undefined}
              aria-expanded={hasKids ? isExpanded : undefined}
              className={`sub-tree-card${isCurrent ? " current" : ""}${isWorking ? " is-working" : ""}`}
              style={{ marginLeft: (level - 1) * 14 }}
              onClick={() => {
                onSelectSub(item, trailPrefix);
                closeMenu();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelectSub(item, trailPrefix);
                  closeMenu();
                } else if (e.key === "ArrowRight" && hasKids && !isExpanded) {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleBranch(item);
                } else if (e.key === "ArrowLeft" && isExpanded) {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleBranch(item);
                }
              }}
            >
              {hasKids ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className={`sub-tree-disclose${isExpanded ? " open" : ""}`}
                  aria-label={isExpanded ? `收起 ${disp.headline} 的下级子 Agent` : `展开 ${disp.headline} 的下级子 Agent`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleBranch(item);
                  }}
                >
                  <ChevronRight size={12} />
                </button>
              ) : null}

              <span className={`sub-dot ${isWorking ? "working" : "done"}`} aria-label={isWorking ? "进行中" : "已完成"} />

              <div className="sub-tree-content">
                <div className="sub-tree-headline-row">
                  {disp.roleLabel ? (
                    <span className={`sub-role-chip tone-${disp.roleTone}`}>{disp.roleLabel}</span>
                  ) : null}
                  <span className="sub-tree-title truncate" title={disp.headline}>
                    {disp.headline}
                  </span>
                </div>
                <div className="sub-tree-meta-row">
                  {item.model ? (
                    <span className="sub-meta-chip mono">
                      <ModelBrandIcon model={item.model} size={11} />
                      <span className="truncate">{item.model}</span>
                    </span>
                  ) : null}
                  {stepsText ? <span className="sub-meta-chip num">{stepsText}</span> : null}
                  {dur ? <span className="sub-meta-chip num">{dur}</span> : null}
                  {costText ? <span className="sub-meta-chip cost mono num">{costText}</span> : null}
                  {disp.secondary && !item.model ? (
                    <span className="sub-meta-sec truncate">{disp.secondary}</span>
                  ) : null}
                </div>
              </div>

              {isCurrent ? (
                <span className="sub-tree-current-ic" aria-label="当前查看">
                  <Check size={14} />
                </span>
              ) : onOpenAside ? (
                <button
                  type="button"
                  className="sub-tree-aside-btn"
                  title="在右侧边栏并排打开"
                  aria-label={`在侧边栏打开 ${disp.headline}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenAside(item, trailPrefix);
                    closeMenu();
                  }}
                >
                  <PanelRightOpen size={13} />
                </button>
              ) : null}
            </div>

            {isExpanded ? (
              <div role="group" className="sub-tree-children">
                {loadingMap[item.key] && !(kids?.length) ? (
                  <div className="sub-pop-notice" style={{ paddingLeft: 18 + level * 14 }}>
                    <span className="act-spin" aria-hidden />
                    <span>正在加载下级子 Agent…</span>
                  </div>
                ) : kids?.length ? (
                  <SubTreeRows
                    deviceId={deviceId}
                    agentKey={agentKey}
                    items={kids}
                    trailPrefix={[...trailPrefix, item]}
                    activeSubKey={activeSubKey}
                    childrenMap={childrenMap}
                    loadingMap={loadingMap}
                    expanded={expanded}
                    now={now}
                    level={level + 1}
                    onToggleBranch={onToggleBranch}
                    onSelectSub={onSelectSub}
                    onOpenAside={onOpenAside}
                    closeMenu={closeMenu}
                  />
                ) : (
                  <div className="sub-pop-notice" style={{ paddingLeft: 18 + level * 14 }}>暂无下级子 Agent</div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

type SubFilter = "all" | "working" | "done";

/**
 * Pocket-styled Subagent Catalog trigger pill & card-list popover (click-to-open, overlayStore-managed).
 */
export function SubagentCatalogTrigger({
  deviceId,
  agentKey,
  parentSubKey,
  knownCount,
  subs,
  activeSubKey,
  variant = "count",
  switcherTitle,
  baseTrail = [],
  onSelectSub,
  onOpenAside,
  onRefresh,
  compact = false,
}: {
  deviceId: string;
  agentKey: string;
  parentSubKey?: string;
  knownCount: number;
  subs: SubSession[];
  activeSubKey?: string;
  variant?: "count" | "switcher";
  switcherTitle?: string;
  baseTrail?: SubSession[];
  onSelectSub: (s: SubSession, ancestors: SubSession[]) => void;
  onOpenAside?: (s: SubSession, ancestors: SubSession[]) => void;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number; maxWidth: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [childrenMap, setChildrenMap] = useState<Record<string, SubSession[]>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [rootLoading, setRootLoading] = useState(false);
  const [rootFetched, setRootFetched] = useState<SubSession[] | null>(null);
  const [filter, setFilter] = useState<SubFilter>("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  const items = useMemo(() => (subs.length > 0 ? subs : rootFetched ?? []), [rootFetched, subs]);
  const totalCount = Math.max(knownCount, items.length);
  const workingCount = items.filter((s) => s.status === "working").length;
  const doneCount = items.filter((s) => s.status !== "working").length;

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (filter === "working" && it.status !== "working") return false;
      if (filter === "done" && it.status === "working") return false;
      if (!q) return true;
      const d = parseSubagentDisplay(it);
      return (
        d.headline.toLowerCase().includes(q) ||
        (d.roleLabel?.toLowerCase().includes(q) ?? false) ||
        (it.model?.toLowerCase().includes(q) ?? false) ||
        (it.title?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [filter, items, query]);

  useEffect(() => {
    setRootFetched(null);
    setChildrenMap({});
    setExpanded(new Set());
    setFilter("all");
    setQuery("");
  }, [agentKey, parentSubKey]);

  useEffect(() => {
    if (!open || workingCount === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open, workingCount]);

  const fetchRoot = useCallback(async () => {
    if (onRefresh) onRefresh();
    setRootLoading(true);
    try {
      const res = await rpcCall(deviceId, "session.children", { agent: agentKey, ...(parentSubKey ? { sub: parentSubKey } : {}) });
      setRootFetched(res.sessions);
    } catch {
      // silent fallback
    } finally {
      setRootLoading(false);
    }
  }, [agentKey, deviceId, onRefresh, parentSubKey]);

  const fetchChildBranch = useCallback(
    async (subKey: string) => {
      setLoadingMap((prev) => ({ ...prev, [subKey]: true }));
      try {
        const res = await rpcCall(deviceId, "session.children", { agent: agentKey, sub: subKey });
        setChildrenMap((prev) => ({ ...prev, [subKey]: res.sessions }));
      } catch {
        setChildrenMap((prev) => ({ ...prev, [subKey]: [] }));
      } finally {
        setLoadingMap((prev) => ({ ...prev, [subKey]: false }));
      }
    },
    [agentKey, deviceId],
  );

  const toggleBranch = useCallback(
    (s: SubSession) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(s.key)) {
          next.delete(s.key);
        } else {
          next.add(s.key);
          if (!childrenMap[s.key] && !loadingMap[s.key]) {
            void fetchChildBranch(s.key);
          }
        }
        return next;
      });
    },
    [childrenMap, fetchChildBranch, loadingMap],
  );

  const openMenu = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    setCoords(clampPopoverPos(el.getBoundingClientRect()));
    setNow(Date.now());
    setOpen(true);
    if (items.length === 0) void fetchRoot();
  }, [fetchRoot, items.length]);

  const activeTabId = shellStore.use((s) => s.active);
  const selectedSpace = shellStore.use((s) => s.selectedSpace);

  const closeMenu = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [activeTabId, agentKey, selectedSpace]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent("pocket:close-popovers", { detail: popId }));
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const onPeerOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== popId) closeMenu();
    };
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && !triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    const onScrollOrResize = () => {
      const el = triggerRef.current;
      if (el) setCoords(clampPopoverPos(el.getBoundingClientRect()));
    };
    window.addEventListener("pocket:close-popovers", onPeerOpen);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("pocket:close-popovers", onPeerOpen);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onScrollOrResize);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [closeMenu, open, popId]);

  if (variant === "count" && totalCount === 0) return null;

  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    const nodes = menuRef.current
      ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      : [];
    if (!nodes.length) return;
    const idx = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      nodes[(idx + 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nodes[(idx - 1 + nodes.length) % nodes.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      nodes[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      nodes[nodes.length - 1]?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={
          variant === "switcher"
            ? "sub-switcher-btn"
            : `sub-cat-btn${compact ? " compact" : ""}${workingCount > 0 ? " is-working" : ""}${open ? " is-open" : ""}`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={variant === "switcher" ? `切换子 Agent：${switcherTitle || ""}` : `查看 ${totalCount} 个子 Agent`}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu();
            window.setTimeout(() => {
              menuRef.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
            }, 20);
          }
        }}
      >
        {variant === "switcher" ? (
          <>
            <span className="truncate">{switcherTitle || "子 Agent"}</span>
            <ChevronsUpDown size={12} className="sub-cat-chev" />
          </>
        ) : (
          <>
            <span className="sub-cat-ic" aria-hidden>
              <GitBranch size={12} />
              {workingCount > 0 ? <span className="sub-cat-dot" /> : null}
            </span>
            <span className="num">
              {compact
                ? workingCount > 0
                  ? `${workingCount}/${totalCount}`
                  : `${totalCount}`
                : `${totalCount} 个子 Agent`}
            </span>
            <ChevronDown size={11} className="sub-cat-chev" />
          </>
        )}
      </button>

      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              id={popId}
              role="dialog"
              aria-label="子 Agent 目录"
              className="sub-pop"
              style={{ top: coords.top, left: coords.left, width: coords.maxWidth }}
              onKeyDown={onTreeKeyDown}
            >
              <div className="sub-pop-head">
                <span className="sub-pop-title">
                  <GitBranch size={13} />
                  <span>子 Agent · {totalCount}</span>
                </span>
                <div className="sub-pop-filters" role="tablist" aria-label="按状态筛选">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter === "all"}
                    className={`sub-filter-pill${filter === "all" ? " active" : ""}`}
                    onClick={() => setFilter("all")}
                  >
                    全部 {items.length || totalCount}
                  </button>
                  {workingCount > 0 ? (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={filter === "working"}
                      className={`sub-filter-pill working${filter === "working" ? " active" : ""}`}
                      onClick={() => setFilter("working")}
                    >
                      进行中 {workingCount}
                    </button>
                  ) : null}
                  {doneCount > 0 ? (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={filter === "done"}
                      className={`sub-filter-pill${filter === "done" ? " active" : ""}`}
                      onClick={() => setFilter("done")}
                    >
                      已完成 {doneCount}
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="sub-pop-refresh"
                  aria-label="刷新子 Agent 列表"
                  title="刷新"
                  onClick={() => void fetchRoot()}
                >
                  <RefreshCw size={12} className={rootLoading ? "spin" : ""} />
                </button>
              </div>
              {items.length >= 5 ? (
                <div className="sub-pop-search-wrap">
                  <Search size={12} className="sub-pop-search-ic" />
                  <input
                    type="text"
                    className="sub-pop-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="按任务摘要、角色或模型筛选…"
                    aria-label="搜索子 Agent"
                  />
                </div>
              ) : null}
              <div className="sub-pop-body" role="tree" aria-label="子 Agent 树">
                {rootLoading && items.length === 0 ? (
                  <div className="sub-pop-notice">
                    <span className="act-spin" aria-hidden />
                    <span>正在加载子 Agent…</span>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="sub-pop-notice">
                    {items.length === 0 ? "暂无子 Agent 记录" : "没有匹配当前筛选的子 Agent"}
                  </div>
                ) : (
                  <SubTreeRows
                    deviceId={deviceId}
                    agentKey={agentKey}
                    items={filteredItems}
                    trailPrefix={baseTrail}
                    activeSubKey={activeSubKey}
                    childrenMap={childrenMap}
                    loadingMap={loadingMap}
                    expanded={expanded}
                    now={now}
                    level={1}
                    onToggleBranch={toggleBranch}
                    onSelectSub={onSelectSub}
                    onOpenAside={onOpenAside}
                    closeMenu={closeMenu}
                  />
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * Header breadcrumb + sibling switcher shown when viewing a subagent in-place inside a pane.
 */
export function SubagentHeaderLineage({
  mainTitle,
  trail,
  rootSubs,
  activeSubs,
  deviceId,
  agentKey,
  onGoRoot,
  onSelectCrumbIndex,
  onSelectSub,
  onOpenAside,
}: {
  mainTitle: string;
  trail: SubSession[];
  rootSubs: SubSession[];
  activeSubs: SubSession[];
  deviceId: string;
  agentKey: string;
  onGoRoot: () => void;
  onSelectCrumbIndex: (idx: number) => void;
  onSelectSub: (s: SubSession, ancestors: SubSession[]) => void;
  onOpenAside?: (s: SubSession, ancestors: SubSession[]) => void;
}) {
  const current = trail[trail.length - 1];
  const parentTrail = trail.slice(0, -1);
  const parentSub = parentTrail[parentTrail.length - 1];
  if (!current) return null;

  return (
    <div className="sub-lineage" role="navigation" aria-label="子 Agent 路径">
      <button type="button" className="sub-crumb-btn" title={`回到主对话：${mainTitle}`} onClick={onGoRoot}>
        <ArrowLeft size={12} />
        <span className="truncate">{mainTitle}</span>
      </button>
      {parentTrail.map((anc, i) => (
        <span key={anc.key} className="sub-crumb-seg">
          <ChevronRight size={12} className="sub-crumb-sep" />
          <button
            type="button"
            className="sub-crumb-btn"
            title={subLabel(anc)}
            onClick={() => onSelectCrumbIndex(i)}
          >
            <span className="truncate">{subLabel(anc)}</span>
          </button>
        </span>
      ))}
      <ChevronRight size={12} className="sub-crumb-sep" />
      <SubagentCatalogTrigger
        variant="switcher"
        switcherTitle={subLabel(current)}
        deviceId={deviceId}
        agentKey={agentKey}
        parentSubKey={parentSub?.key}
        knownCount={parentTrail.length === 0 ? rootSubs.length : parentSub?.children ?? 0}
        subs={parentTrail.length === 0 ? rootSubs : []}
        activeSubKey={current.key}
        baseTrail={parentTrail}
        onSelectSub={onSelectSub}
        onOpenAside={onOpenAside}
      />
      {(current.children > 0 || activeSubs.length > 0) ? (
        <SubagentCatalogTrigger
          variant="count"
          compact
          deviceId={deviceId}
          agentKey={agentKey}
          parentSubKey={current.key}
          knownCount={Math.max(current.children, activeSubs.length)}
          subs={activeSubs}
          baseTrail={trail}
          onSelectSub={onSelectSub}
          onOpenAside={onOpenAside}
        />
      ) : null}
    </div>
  );
}

/**
 * Replaces the main composer when viewing a subagent session (DeepSeek Harness read-only footer pattern).
 */
export function SubagentReadOnlyBar({
  current,
  onOpenAside,
  onBackMain,
  inSidebar = false,
}: {
  current: SubSession;
  onOpenAside?: () => void;
  onBackMain: () => void;
  inSidebar?: boolean;
}) {
  return (
    <div className="sub-readonly-bar" role="status">
      <div className="sub-readonly-info">
        <span className={`sub-dot ${current.status === "working" ? "working" : "done"}`} />
        <div className="sub-readonly-text">
          <div className="sub-readonly-title">
            子 Agent 记录 · {subLabel(current)}（{current.status === "working" ? "正在运行" : "只读"}）
          </div>
          <div className="sub-readonly-sub">子智能体由主对话调度，可在主对话中下达新指令或切到侧边栏并排查看。</div>
        </div>
      </div>
      <div className="sub-readonly-actions">
        {!inSidebar && onOpenAside ? (
          <button type="button" className="sub-readonly-btn" onClick={onOpenAside}>
            <PanelRightOpen size={13} />
            <span>侧边栏并排看</span>
          </button>
        ) : null}
        <button type="button" className="sub-readonly-btn primary" onClick={onBackMain}>
          <ArrowLeft size={13} />
          <span>{inSidebar ? "在主窗打开" : "返回主对话"}</span>
        </button>
      </div>
    </div>
  );
}
