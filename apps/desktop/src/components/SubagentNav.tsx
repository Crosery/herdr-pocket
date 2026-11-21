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
} from "lucide-react";
import type { SubSession } from "@herdr-pocket/protocol";
import { rpcCall } from "../lib/relay";

export function subLabel(s: Pick<SubSession, "key" | "title" | "preview">): string {
  const t = s.title?.trim();
  if (t) return t;
  const line = s.preview?.trim().split("\n").map((l) => l.trim()).find(Boolean);
  if (line) return line.length > 48 ? `${line.slice(0, 47)}…` : line;
  return s.key;
}

export function fmtSubDuration(s: SubSession, now: number): string | null {
  const end = s.status === "working" ? now : (s.updatedAt || now);
  const start = s.startedAt ?? s.statusSince;
  if (!start || end < start) return null;
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分${String(sec % 60).padStart(2, "0")}秒`;
  const hr = Math.floor(min / 60);
  return `${hr}时${String(min % 60).padStart(2, "0")}分`;
}

function clampPopoverPos(rect: DOMRect, menuWidth = 340): { top: number; left: number; maxWidth: number } {
  if (typeof window === "undefined") return { top: rect.bottom + 6, left: rect.left, maxWidth: menuWidth };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(menuWidth, Math.max(240, vw - 16));
  const left = Math.max(8, Math.min(vw - width - 8, rect.left));
  const estHeight = 320;
  const top = rect.bottom + 6 + estHeight > vh - 8 && rect.top - estHeight > 12 ? Math.max(8, rect.top - 6 - estHeight) : rect.bottom + 6;
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
        const label = subLabel(item);
        const dur = fmtSubDuration(item, now);
        const preview = item.preview?.trim().split("\n")[0]?.trim();
        const showPreview = preview && preview !== label ? preview : item.harness;
        const statusText = item.status === "working" ? "进行中" : "已完成";
        const costText = item.costUsd !== undefined && item.costUsd > 0 ? `$${item.costUsd.toFixed(item.costUsd >= 1 ? 2 : 3)}` : null;

        return (
          <div key={item.key} className="sub-tree-node">
            <div
              role="treeitem"
              tabIndex={0}
              aria-level={level}
              aria-current={isCurrent ? "page" : undefined}
              aria-expanded={hasKids ? isExpanded : undefined}
              className={`sub-tree-row${isCurrent ? " current" : ""}`}
              style={{ paddingLeft: 8 + (level - 1) * 14 }}
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
                  aria-label={isExpanded ? `收起 ${label} 的下级子 Agent` : `展开 ${label} 的下级子 Agent`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleBranch(item);
                  }}
                >
                  <ChevronRight size={12} />
                </button>
              ) : (
                <span className="sub-tree-disclose-spacer" aria-hidden />
              )}

              <span className={`sub-dot ${item.status === "working" ? "working" : "done"}`} aria-label={statusText} />

              <span className="sub-tree-content">
                <span className="sub-tree-title truncate">{label}</span>
                <span className="sub-tree-meta truncate">
                  <span>{statusText}</span>
                  {item.model ? <span> · {item.model}</span> : null}
                  {showPreview ? <span> · {showPreview}</span> : null}
                </span>
              </span>

              {dur || costText ? (
                <span className="sub-tree-metrics">
                  {dur ? <span className="num">{dur}</span> : null}
                  {costText ? <span className="num">{costText}</span> : null}
                </span>
              ) : null}

              {isCurrent ? (
                <span className="sub-tree-current-ic" aria-label="当前查看">
                  <Check size={14} />
                </span>
              ) : onOpenAside ? (
                <button
                  type="button"
                  className="sub-tree-aside-btn"
                  title="在右侧边栏打开"
                  aria-label={`在侧边栏打开 ${label}`}
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
                  <div className="sub-pop-notice" style={{ paddingLeft: 26 + level * 14 }}>
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
                  <div className="sub-pop-notice" style={{ paddingLeft: 26 + level * 14 }}>暂无下级子 Agent</div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * DeepSeek-Harness-style subagent catalog trigger button & hover/click portal tree popover.
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
  const [now, setNow] = useState(() => Date.now());

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const hoverOpenRef = useRef<number | undefined>(undefined);
  const hoverCloseRef = useRef<number | undefined>(undefined);
  const popId = useId();

  const items = useMemo(() => (subs.length > 0 ? subs : rootFetched ?? []), [rootFetched, subs]);
  const totalCount = Math.max(knownCount, items.length);
  const workingCount = items.filter((s) => s.status === "working").length;
  const doneCount = items.filter((s) => s.status !== "working").length;

  useEffect(() => {
    setRootFetched(null);
    setChildrenMap({});
    setExpanded(new Set());
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
      // silent fallback to existing items
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

  const clearTimers = () => {
    if (hoverOpenRef.current !== undefined) {
      window.clearTimeout(hoverOpenRef.current);
      hoverOpenRef.current = undefined;
    }
    if (hoverCloseRef.current !== undefined) {
      window.clearTimeout(hoverCloseRef.current);
      hoverCloseRef.current = undefined;
    }
  };

  const openMenu = useCallback(
    (pin: boolean) => {
      clearTimers();
      const el = triggerRef.current;
      if (!el) return;
      pinnedRef.current = pin;
      setCoords(clampPopoverPos(el.getBoundingClientRect()));
      setNow(Date.now());
      setOpen(true);
      if (items.length === 0) void fetchRoot();
    },
    [fetchRoot, items.length],
  );

  const closeMenu = useCallback(() => {
    clearTimers();
    pinnedRef.current = false;
    setOpen(false);
  }, []);

  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (!open) return;
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
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("click", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [closeMenu, open]);

  if (variant === "count" && totalCount === 0) return null;

  const scheduleHoverOpen = () => {
    clearTimers();
    if (open) return;
    hoverOpenRef.current = window.setTimeout(() => {
      openMenu(false);
    }, 150);
  };

  const scheduleHoverClose = () => {
    clearTimers();
    if (pinnedRef.current) return;
    hoverCloseRef.current = window.setTimeout(() => {
      closeMenu();
    }, 140);
  };

  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
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
        className={variant === "switcher" ? "sub-switcher-btn" : `sub-cat-btn${compact ? " compact" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={variant === "switcher" ? `切换子 Agent：${switcherTitle || ""}` : `查看 ${totalCount} 个子 Agent`}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") scheduleHoverOpen();
        }}
        onPointerLeave={scheduleHoverClose}
        onClick={() => {
          if (open && pinnedRef.current) closeMenu();
          else openMenu(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu(true);
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
            <span>{compact ? `${totalCount}` : `${totalCount} 个子 Agent`}</span>
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
              aria-label="子 Agent 列表"
              className="sub-pop"
              style={{ top: coords.top, left: coords.left, width: coords.maxWidth }}
              onPointerEnter={(e) => {
                if (e.pointerType !== "touch" && hoverCloseRef.current !== undefined) {
                  window.clearTimeout(hoverCloseRef.current);
                  hoverCloseRef.current = undefined;
                }
              }}
              onPointerLeave={scheduleHoverClose}
              onKeyDown={onTreeKeyDown}
            >
              <div className="sub-pop-head">
                <span className="sub-pop-title">子 Agent 目录</span>
                <span className="sub-pop-progress">
                  {[
                    doneCount > 0 ? `${doneCount} 已完成` : "",
                    workingCount > 0 ? `${workingCount} 进行中` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || `${totalCount} 项`}
                </span>
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
              <div className="sub-pop-body" role="tree" aria-label="子 Agent 树">
                {rootLoading && items.length === 0 ? (
                  <div className="sub-pop-notice">
                    <span className="act-spin" aria-hidden />
                    <span>正在加载子 Agent…</span>
                  </div>
                ) : items.length === 0 ? (
                  <div className="sub-pop-notice">暂无子 Agent 记录</div>
                ) : (
                  <SubTreeRows
                    deviceId={deviceId}
                    agentKey={agentKey}
                    items={items}
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
