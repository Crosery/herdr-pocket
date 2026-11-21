import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, ChevronRight, Folder, FolderOpen, Home, Layers, RefreshCw } from "lucide-react";
import type { SpaceInfo } from "@herdr-pocket/protocol";
import { PocketButton, PocketInput, PocketModal, useToast } from "./PocketUI";
import { native } from "../lib/native";
import { rpcCall } from "../lib/relay";

interface FolderListData {
  path: string;
  displayPath: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

export function normalizeFolderKey(p: string | undefined | null): string {
  if (!p) return "";
  const slash = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (slash.startsWith("~/")) return slash;
  const homeMatch = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(slash);
  if (homeMatch) return `~${homeMatch[1] || ""}`;
  return slash;
}

export function FolderExplorerModal({
  open,
  onOpenChange,
  hostId,
  isLocalHost,
  spaces,
  recentFolders,
  initialPath,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  hostId: string;
  isLocalHost: boolean;
  spaces: SpaceInfo[];
  recentFolders: string[];
  initialPath?: string;
  onSelect: (folder: string) => void;
}) {
  const toast = useToast();
  const [target, setTarget] = useState<string | undefined>(initialPath?.trim() || undefined);
  const [selected, setSelected] = useState<string>(initialPath?.trim() || "");
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [pathEditing, setPathEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FolderListData | null>(null);

  const navigate = useCallback(async (nextTarget: string | undefined, hiddenFlag: boolean) => {
    if (!hostId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await rpcCall(hostId, "folders.list", { path: nextTarget, hidden: hiddenFlag });
      setData(res);
      setSelected(res.displayPath || res.path);
      setPathDraft(res.displayPath || res.path);
      setFilter("");
    } catch (e) {
      setError((e as Error).message || "无法读取目录");
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  useEffect(() => {
    if (!open || !hostId) return;
    const start = initialPath?.trim() || undefined;
    setTarget(start);
    setSelected(start || "");
    setPathEditing(false);
    setFilter("");
    void navigate(start, showHidden);
  }, [open, hostId, initialPath, showHidden, navigate]);

  const entries = useMemo(() => {
    const list = data?.entries ?? [];
    const q = filter.trim().toLowerCase();
    return q ? list.filter((e) => e.name.toLowerCase().includes(q)) : list;
  }, [data, filter]);

  const spaceShortcuts = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ name: string; folder: string }> = [];
    for (const s of spaces) {
      if (!s.folder) continue;
      const k = normalizeFolderKey(s.folder);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ name: s.name, folder: s.folder });
    }
    return out;
  }, [spaces]);

  const recentShortcuts = useMemo(() => {
    const used = new Set(spaceShortcuts.map((s) => normalizeFolderKey(s.folder)));
    return recentFolders.filter((f) => f && !used.has(normalizeFolderKey(f))).slice(0, 6);
  }, [recentFolders, spaceShortcuts]);

  const activeDir = selected || data?.displayPath || data?.path || "";
  const crumbs = useMemo(() => {
    const raw = data?.displayPath || data?.path || "";
    if (!raw) return [];
    if (raw === "~") return [{ label: "~", path: "~" }];
    if (raw.startsWith("~/")) {
      const parts = raw.slice(2).split("/").filter(Boolean);
      return [
        { label: "~", path: "~" },
        ...parts.map((p, idx) => ({ label: p, path: `~/${parts.slice(0, idx + 1).join("/")}` })),
      ];
    }
    if (raw.startsWith("/")) {
      const parts = raw.slice(1).split("/").filter(Boolean);
      return [
        { label: "/", path: "/" },
        ...parts.map((p, idx) => ({ label: p, path: `/${parts.slice(0, idx + 1).join("/")}` })),
      ];
    }
    return [{ label: raw, path: raw }];
  }, [data]);

  const pickWithFinder = async () => {
    try {
      const picked = await native.pickFolder(activeDir || undefined);
      if (picked) {
        onSelect(picked);
        onOpenChange(false);
      }
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <PocketModal open={open} onOpenChange={onOpenChange} title="选择工作目录" subtitle="左侧可快速跳转到已有空间或常用目录，双击文件夹进入" width={690}>
      <div className="folder-exp">
        <aside className="folder-exp-side" aria-label="快捷目录">
          <div className="folder-exp-sec">位置</div>
          <button
            type="button"
            className={`folder-exp-nav${normalizeFolderKey(data?.displayPath || data?.path) === "~" ? " on" : ""}`}
            onClick={() => void navigate("~", showHidden)}
          >
            <Home size={13} />
            <span className="truncate">主目录 (~)</span>
          </button>
          {isLocalHost ? (
            <button type="button" className="folder-exp-nav" onClick={() => void pickWithFinder()}>
              <FolderOpen size={13} />
              <span className="truncate">用访达选择…</span>
            </button>
          ) : null}

          {spaceShortcuts.length > 0 ? (
            <>
              <div className="folder-exp-sec">已有空间</div>
              {spaceShortcuts.map((sp) => {
                const on = normalizeFolderKey(activeDir) === normalizeFolderKey(sp.folder);
                return (
                  <button
                    key={sp.folder}
                    type="button"
                    className={`folder-exp-nav${on ? " on" : ""}`}
                    title={sp.folder}
                    onClick={() => {
                      setSelected(sp.folder);
                      void navigate(sp.folder, showHidden);
                    }}
                  >
                    <Layers size={13} />
                    <span className="truncate">{sp.name}</span>
                  </button>
                );
              })}
            </>
          ) : null}

          {recentShortcuts.length > 0 ? (
            <>
              <div className="folder-exp-sec">最近常用</div>
              {recentShortcuts.map((f) => {
                const on = normalizeFolderKey(activeDir) === normalizeFolderKey(f);
                const label = f.split(/[\\/]/).filter(Boolean).pop() || f;
                return (
                  <button
                    key={f}
                    type="button"
                    className={`folder-exp-nav${on ? " on" : ""}`}
                    title={f}
                    onClick={() => {
                      setSelected(f);
                      void navigate(f, showHidden);
                    }}
                  >
                    <Folder size={13} />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </>
          ) : null}
        </aside>

        <div className="folder-exp-main">
          <div className="folder-exp-bar">
            <PocketButton
              size="sm"
              variant="ghost"
              disabled={!data?.parent || loading}
              onClick={() => {
                if (data?.parent) void navigate(data.parent, showHidden);
              }}
            >
              <ArrowUp size={13} />
              <span>上一级</span>
            </PocketButton>
            {pathEditing ? (
              <form
                className="folder-exp-path-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  setPathEditing(false);
                  void navigate(pathDraft.trim() || "~", showHidden);
                }}
              >
                <PocketInput
                  mono
                  value={pathDraft}
                  autoFocus
                  onChange={(e) => setPathDraft(e.target.value)}
                  onBlur={() => setPathEditing(false)}
                  placeholder="输入路径后按回车…"
                />
              </form>
            ) : (
              <div
                className="folder-exp-crumbs"
                role="button"
                tabIndex={0}
                title="点击可直接输入路径"
                onClick={() => {
                  setPathDraft(data?.displayPath || data?.path || "~");
                  setPathEditing(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setPathDraft(data?.displayPath || data?.path || "~");
                    setPathEditing(true);
                  }
                }}
              >
                {crumbs.map((c, idx) => (
                  <span key={c.path} className="folder-exp-crumb-item">
                    {idx > 0 ? <ChevronRight size={11} className="faint" /> : null}
                    <button
                      type="button"
                      className="folder-exp-crumb-btn mono"
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigate(c.path, showHidden);
                      }}
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {loading ? <RefreshCw size={12} className="faint" style={{ flexShrink: 0 }} /> : null}
          </div>

          <div className="folder-exp-filter">
            <PocketInput
              aria-label="筛选当前目录"
              placeholder="筛选当前目录里的文件夹…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ flex: 1, minWidth: 0 }}
            />
            <PocketButton
              size="sm"
              variant={showHidden ? "soft" : "ghost"}
              aria-pressed={showHidden}
              disabled={loading}
              onClick={() => setShowHidden((h) => !h)}
            >
              显示隐藏
            </PocketButton>
          </div>

          <div className="folder-exp-list" role="listbox" aria-label="子文件夹列表">
            {error ? (
              <div className="folder-exp-empty">
                <span style={{ color: "var(--blush-text)" }}>{error}</span>
                <PocketButton size="sm" variant="ghost" onClick={() => void navigate(target || "~", showHidden)}>
                  重试
                </PocketButton>
                <PocketButton size="sm" variant="ghost" onClick={() => void navigate("~", showHidden)}>
                  回主目录
                </PocketButton>
              </div>
            ) : loading && !data ? (
              <div className="folder-exp-empty">正在读取目录…</div>
            ) : entries.length === 0 ? (
              <div className="folder-exp-empty">{filter.trim() ? "没有匹配的文件夹" : "空目录（可直接选定当前目录）"}</div>
            ) : (
              entries.map((entry) => {
                const isSel = normalizeFolderKey(selected) === normalizeFolderKey(entry.path);
                return (
                  <div
                    key={entry.path}
                    role="option"
                    aria-selected={isSel}
                    tabIndex={0}
                    className={`folder-exp-row${isSel ? " on" : ""}`}
                    onClick={() => setSelected(entry.path)}
                    onDoubleClick={() => void navigate(entry.path, showHidden)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void navigate(entry.path, showHidden);
                    }}
                  >
                    <Folder size={14} className="folder-exp-ic" />
                    <span className="truncate grow">{entry.name}</span>
                    <button
                      type="button"
                      className="folder-exp-enter"
                      title={`打开 ${entry.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigate(entry.path, showHidden);
                      }}
                    >
                      <ChevronRight size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="folder-exp-foot">
            <div className="folder-exp-picked mono truncate" title={activeDir}>
              已选：{activeDir || "—"}
            </div>
            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
              <PocketButton variant="ghost" onClick={() => onOpenChange(false)}>取消</PocketButton>
              <PocketButton
                variant="primary"
                disabled={!activeDir || loading}
                onClick={() => {
                  onSelect(activeDir);
                  onOpenChange(false);
                }}
              >
                选定此目录
              </PocketButton>
            </div>
          </div>
        </div>
      </div>
    </PocketModal>
  );
}
