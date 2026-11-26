import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  FileText,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  List,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Undo2,
} from "lucide-react";
import type { Agent, GitFileChange, GitFileStatusCode, GitStatusResult, RpcResult } from "@herdr-pocket/protocol";
import { rpcCall } from "../lib/relay";
import { buildSplitDiffRows, parseUnifiedPatch } from "../lib/gitDiff";
import { detectCodeLanguage, highlightSingleLine } from "../lib/syntaxHighlight";
import { liveStore } from "../lib/store";
import { openDiffTab, openFileTab, type DiffTab } from "../shell/shellStore";
import { PocketSelect, useToast } from "./PocketUI";
import "../styles/git.css";

function statusClass(code: GitFileStatusCode): string {
  return `st-${code === "?" ? "Q" : code}`;
}

function splitNameDir(p: string): { name: string; dir: string } {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return { name: norm, dir: "" };
  return { name: norm.slice(idx + 1), dir: norm.slice(0, idx) };
}

function shortCommitAge(ms: number): string {
  if (!ms) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return "刚刚";
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function FileStat({ add, del }: { add?: number; del?: number }) {
  if (add === undefined && del === undefined) return null;
  return (
    <span className="git-stat">
      {add ? <span className="git-stat-add">+{add}</span> : null}
      {del ? <span className="git-stat-del">−{del}</span> : null}
    </span>
  );
}

export function GitPanel({
  deviceId,
  agent,
  initialCwd,
  spaceKey,
}: {
  deviceId?: string;
  agent?: Agent;
  initialCwd?: string;
  spaceKey?: string | null;
}) {
  const toast = useToast();
  const spacesMap = liveStore.use((s) => s.spaces);
  const effectiveCwd = initialCwd || agent?.cwd;
  const [selectedRepo, setSelectedRepo] = useState<string | undefined>(undefined);
  const targetCwd = selectedRepo || effectiveCwd;

  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [commits, setCommits] = useState<RpcResult<"git.log">["commits"]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState("");
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(true);

  useEffect(() => {
    setSelectedRepo(undefined);
  }, [deviceId, effectiveCwd]);

  const spaceFolders = useMemo(() => {
    if (!deviceId) return [];
    const out: Array<{ folder: string; label: string }> = [];
    const seen = new Set<string>();
    for (const s of spacesMap[deviceId] ?? []) {
      if (!s.folder || seen.has(s.folder)) continue;
      seen.add(s.folder);
      out.push({ folder: s.folder, label: s.name });
    }
    return out;
  }, [deviceId, spacesMap]);

  const refresh = useCallback(async () => {
    if (!deviceId || (!targetCwd && !agent?.key)) return;
    setLoading(true);
    setError(null);
    try {
      const params = targetCwd ? { cwd: targetCwd } : { agent: agent!.key };
      const st = await rpcCall(deviceId, "git.status", params, 15_000);
      setStatus(st);
      if (st.isRepo) {
        const logRes = await rpcCall(
          deviceId,
          "git.log",
          { cwd: st.root || targetCwd, limit: 15 },
          15_000,
        ).catch(() => ({ commits: [] }));
        setCommits(logRes.commits);
      } else {
        setCommits([]);
      }
    } catch (err) {
      setError((err as Error)?.message || "读取 Git 状态失败");
    } finally {
      setLoading(false);
    }
  }, [agent, deviceId, targetCwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const repoCwd = status?.root || targetCwd || "";

  const runAction = async (fn: () => Promise<unknown>, okMsg?: string) => {
    if (!deviceId || !repoCwd || busy) return;
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await refresh();
    } catch (err) {
      toast((err as Error)?.message || "操作失败", true);
    } finally {
      setBusy(false);
    }
  };

  const openChangeDiff = (c: GitFileChange) => {
    if (!deviceId || !repoCwd) return;
    openDiffTab({
      deviceId,
      agentKey: agent?.key,
      cwd: repoCwd,
      path: c.path,
      staged: c.staged,
      spaceKey,
    });
  };

  const openWorkingFile = (path: string) => {
    const absPath = `${repoCwd.replace(/[\\/]+$/, "")}/${path}`;
    const name = path.split("/").pop() || path;
    if (agent) {
      openFileTab(agent.key, path, name, { absPath, spaceKey });
    } else if (deviceId) {
      openFileTab(`${deviceId}/git`, path, name, { absPath, spaceKey });
    }
  };

  const handleCommit = async (stageAllIfNeeded = false) => {
    if (!commitMsg.trim() || !deviceId || !repoCwd) return;
    await runAction(async () => {
      if (stageAllIfNeeded && (!status || status.staged.length === 0)) {
        await rpcCall(deviceId, "git.stage", { cwd: repoCwd, paths: [], all: true });
      }
      const res = await rpcCall(deviceId, "git.commit", { cwd: repoCwd, message: commitMsg.trim() });
      setCommitMsg("");
      toast(`已提交 ${res.hash ? `${res.hash} · ` : ""}${res.subject}`);
    });
  };

  const handleCheckout = async (branch: string, create = false) => {
    if (!deviceId || !repoCwd || !branch.trim()) return;
    await runAction(async () => {
      await rpcCall(deviceId, "git.checkout", { cwd: repoCwd, branch: branch.trim(), create });
      setNewBranchOpen(false);
      setNewBranchName("");
    }, `已切换到分支 ${branch.trim()}`);
  };

  const repoOptions = useMemo(() => {
    const list: Array<{ root: string; label: string; badge?: number }> = [];
    const seen = new Set<string>();
    for (const r of status?.repos ?? []) {
      seen.add(r.root);
      list.push({ root: r.root, label: `${r.name} (${r.branch})`, badge: r.dirtyCount });
    }
    for (const sf of spaceFolders) {
      if (seen.has(sf.folder)) continue;
      seen.add(sf.folder);
      list.push({ root: sf.folder, label: `空间 · ${sf.label}` });
    }
    return list;
  }, [spaceFolders, status?.repos]);

  if (!deviceId || (!targetCwd && !agent?.key)) {
    return <div className="v3-empty-line">先选择一个带工作目录的空间或 Agent，这里就会显示它的 Git 状态与变更。</div>;
  }

  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const totalChanges = staged.length + unstaged.length;

  return (
    <div className="git-panel">
      <div className="git-toolbar">
        {repoOptions.length > 0 ? (
          <div className="git-row">
            <PocketSelect
              size="sm"
              className="git-repo-select"
              ariaLabel="选择仓库"
              prefixIcon={<FolderGit2 size={13} />}
              value={status?.root || targetCwd || ""}
              onValueChange={(v) => setSelectedRepo(v)}
              options={repoOptions.map((opt) => ({
                value: opt.root,
                label: opt.label,
                badge: opt.badge ? String(opt.badge) : undefined,
              }))}
            />
            <button
              type="button"
              className="git-btn icon"
              title="刷新 Git 状态"
              aria-label="刷新 Git 状态"
              disabled={loading || busy}
              onClick={() => void refresh()}
            >
              <RotateCw size={13} className={loading ? "v3-spin" : undefined} />
            </button>
          </div>
        ) : null}

        {status?.isRepo ? (
          <div className="git-row">
            <PocketSelect
              size="sm"
              mono
              className="git-branch-select"
              ariaLabel="切换分支"
              prefixIcon={<GitBranch size={13} style={{ color: "var(--accent-text)" }} />}
              value={status.branch ?? ""}
              disabled={busy}
              onValueChange={(v) => {
                if (v === "__new__") setNewBranchOpen(true);
                else if (v && v !== status.branch) void handleCheckout(v);
              }}
              options={[
                ...status.branches.map((b) => ({ value: b, label: b })),
                ...(status.branch && !status.branches.includes(status.branch) ? [{ value: status.branch, label: status.branch }] : []),
                { value: "__new__", label: "+ 新建分支…", tone: "accent" as const },
              ]}
            />
            <button
              type="button"
              className="git-btn"
              title="从远端拉取 (git pull --ff-only)"
              disabled={busy}
              onClick={() =>
                void runAction(
                  () => rpcCall(deviceId, "git.pull", { cwd: repoCwd }),
                  "拉取完成",
                )
              }
            >
              <ArrowDown size={12} />
              {status.behind > 0 ? <span className="git-sync-num">{status.behind}</span> : null}
            </button>
            <button
              type="button"
              className="git-btn"
              title="推送到远端 (git push)"
              disabled={busy}
              onClick={() =>
                void runAction(
                  () => rpcCall(deviceId, "git.push", { cwd: repoCwd }),
                  "推送完成",
                )
              }
            >
              <ArrowUp size={12} />
              {status.ahead > 0 ? <span className="git-sync-num">{status.ahead}</span> : null}
            </button>
          </div>
        ) : null}

        {newBranchOpen ? (
          <div className="git-branch-create">
            <input
              type="text"
              placeholder="输入新分支名，如 feat/login"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCheckout(newBranchName, true);
                else if (e.key === "Escape") setNewBranchOpen(false);
              }}
              autoFocus
            />
            <button type="button" className="git-btn primary" disabled={!newBranchName.trim() || busy} onClick={() => void handleCheckout(newBranchName, true)}>
              创建
            </button>
            <button type="button" className="git-btn" onClick={() => setNewBranchOpen(false)}>取消</button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="inline-alert" style={{ margin: 12 }}>{error}</div>
      ) : status && !status.isRepo ? (
        <div className="v3-empty-line">当前目录还不是 Git 仓库。可从上方切换到其它空间仓库。</div>
      ) : (
        <>
          <div className="git-commit-box">
            <textarea
              placeholder="输入提交信息（⌘/Ctrl + Enter 提交）"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleCommit(staged.length === 0);
                }
              }}
            />
            <div className="git-commit-actions">
              <span className="git-commit-hint">
                {staged.length > 0 ? `已暂存 ${staged.length} 个文件` : `${totalChanges} 个待提交变更`}
              </span>
              <button
                type="button"
                className="git-btn primary"
                disabled={busy || !commitMsg.trim() || totalChanges === 0}
                onClick={() => void handleCommit(staged.length === 0)}
              >
                <Check size={12} />
                <span>{staged.length > 0 ? "提交暂存" : "全部暂存并提交"}</span>
              </button>
            </div>
          </div>

          <div className="git-scroll">
            <div className="git-section">
              <div className="git-sec-head" onClick={() => setStagedOpen((v) => !v)} role="button" tabIndex={0}>
                {stagedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>暂存的更改</span>
                <span className="git-sec-count">{staged.length}</span>
                {staged.length > 0 ? (
                  <span className="git-sec-act" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="git-mini-btn"
                      title="全部取消暂存"
                      disabled={busy}
                      onClick={() => void runAction(() => rpcCall(deviceId, "git.unstage", { cwd: repoCwd, paths: [], all: true }))}
                    >
                      <Minus size={12} />
                    </button>
                  </span>
                ) : null}
              </div>
              {stagedOpen
                ? staged.map((c) => {
                    const { name, dir } = splitNameDir(c.path);
                    return (
                      <div key={`s:${c.path}`} className="git-file-row" onClick={() => openChangeDiff(c)}>
                        <span className={`git-tree-badge ${statusClass(c.status)}`}>{c.status}</span>
                        <span className="git-file-main">
                          <span className="git-file-name" title={c.path}>{name}</span>
                          {dir ? <span className="git-file-dir">{dir}</span> : null}
                        </span>
                        <FileStat add={c.additions} del={c.deletions} />
                        <span className="git-file-acts" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="git-mini-btn" title="打开文件" onClick={() => openWorkingFile(c.path)}>
                            <FileText size={12} />
                          </button>
                          <button
                            type="button"
                            className="git-mini-btn"
                            title="取消暂存"
                            disabled={busy}
                            onClick={() => void runAction(() => rpcCall(deviceId, "git.unstage", { cwd: repoCwd, paths: [c.path] }))}
                          >
                            <Minus size={12} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                : null}
            </div>

            <div className="git-section">
              <div className="git-sec-head" onClick={() => setChangesOpen((v) => !v)} role="button" tabIndex={0}>
                {changesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>更改</span>
                <span className="git-sec-count">{unstaged.length}</span>
                {unstaged.length > 0 ? (
                  <span className="git-sec-act" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="git-mini-btn"
                      title="暂存全部更改"
                      disabled={busy}
                      onClick={() => void runAction(() => rpcCall(deviceId, "git.stage", { cwd: repoCwd, paths: [], all: true }))}
                    >
                      <Plus size={12} />
                    </button>
                  </span>
                ) : null}
              </div>
              {changesOpen && unstaged.length === 0 ? (
                <div className="v3-empty-line" style={{ padding: "8px 16px" }}>工作区干净，没有未暂存的修改。</div>
              ) : null}
              {changesOpen
                ? unstaged.map((c) => {
                    const { name, dir } = splitNameDir(c.path);
                    return (
                      <div key={`u:${c.path}`} className="git-file-row" onClick={() => openChangeDiff(c)}>
                        <span className={`git-tree-badge ${statusClass(c.status)}`}>{c.status}</span>
                        <span className="git-file-main">
                          <span className="git-file-name" title={c.path}>{name}</span>
                          {dir ? <span className="git-file-dir">{dir}</span> : null}
                        </span>
                        <FileStat add={c.additions} del={c.deletions} />
                        <span className="git-file-acts" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="git-mini-btn" title="打开文件" onClick={() => openWorkingFile(c.path)}>
                            <FileText size={12} />
                          </button>
                          <button
                            type="button"
                            className="git-mini-btn"
                            title={c.status === "?" ? "删除未跟踪文件" : "放弃此文件更改"}
                            disabled={busy}
                            onClick={() =>
                              void runAction(
                                () =>
                                  rpcCall(deviceId, "git.discard", {
                                    cwd: repoCwd,
                                    paths: [c.path],
                                    untracked: c.status === "?",
                                  }),
                                `已还原 ${name}`,
                              )
                            }
                          >
                            <Undo2 size={12} />
                          </button>
                          <button
                            type="button"
                            className="git-mini-btn"
                            title="暂存更改"
                            disabled={busy}
                            onClick={() => void runAction(() => rpcCall(deviceId, "git.stage", { cwd: repoCwd, paths: [c.path] }))}
                          >
                            <Plus size={12} />
                          </button>
                        </span>
                      </div>
                    );
                  })
                : null}
            </div>

            <div className="git-section">
              <div className="git-sec-head" onClick={() => setLogOpen((v) => !v)} role="button" tabIndex={0}>
                {logOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span>最近提交</span>
                <span className="git-sec-count">{commits.length}</span>
              </div>
              {logOpen
                ? commits.map((cm) => (
                    <div key={cm.hash} className="git-commit-item">
                      <div className="git-commit-subj" title={cm.subject}>
                        <GitCommitHorizontal size={12} style={{ verticalAlign: -2, marginRight: 5, color: "var(--muted)" }} />
                        {cm.subject}
                      </div>
                      <div className="git-commit-meta">
                        <span className="git-commit-hash">{cm.shortHash}</span>
                        <span>{cm.author}</span>
                        <span>{shortCommitAge(cm.dateMs)}</span>
                        {cm.refs ? <span className="git-commit-ref truncate">{cm.refs}</span> : null}
                      </div>
                    </div>
                  ))
                : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function DiffTabView({ tab }: { tab: DiffTab }) {
  const toast = useToast();
  const [diff, setDiff] = useState<RpcResult<"git.diff"> | null>(null);
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await rpcCall(tab.deviceId, "git.diff", {
        cwd: tab.cwd,
        path: tab.path,
        staged: tab.staged,
        commit: tab.commit,
      });
      setDiff(res);
    } catch (err) {
      setError((err as Error)?.message || "加载 Diff 失败");
    } finally {
      setLoading(false);
    }
  }, [tab.commit, tab.cwd, tab.deviceId, tab.path, tab.staged]);

  useEffect(() => {
    void load();
  }, [load]);

  const unifiedLines = useMemo(() => (diff?.patch ? parseUnifiedPatch(diff.patch) : []), [diff?.patch]);
  const splitRows = useMemo(() => (diff?.patch ? buildSplitDiffRows(diff.patch) : []), [diff?.patch]);
  const diffLang = useMemo(() => detectCodeLanguage(null, tab.path), [tab.path]);

  const toggleStage = async () => {
    try {
      if (tab.staged) {
        await rpcCall(tab.deviceId, "git.unstage", { cwd: tab.cwd, paths: [tab.path] });
        toast(`已取消暂存 ${tab.title}`);
      } else {
        await rpcCall(tab.deviceId, "git.stage", { cwd: tab.cwd, paths: [tab.path] });
        toast(`已暂存 ${tab.title}`);
      }
      void load();
    } catch (err) {
      toast((err as Error)?.message || "操作失败", true);
    }
  };

  return (
    <div className="diff-view">
      <div className="diff-bar">
        <span className="diff-path" title={tab.path}>{tab.path}</span>
        <span className={`diff-pill${tab.staged ? " staged" : ""}`}>
          {tab.commit ? `提交 ${tab.commit.slice(0, 7)}` : tab.staged ? "已暂存" : "工作区"}
        </span>
        {diff ? <FileStat add={diff.additions} del={diff.deletions} /> : null}
        <div className="v3-mode-switch" role="group" aria-label="Diff 视图模式">
          <button
            type="button"
            className={`v3-mode-btn${mode === "split" ? " on" : ""}`}
            title="双栏对比"
            onClick={() => setMode("split")}
          >
            <Columns2 size={13} />
          </button>
          <button
            type="button"
            className={`v3-mode-btn${mode === "unified" ? " on" : ""}`}
            title="统一视图"
            onClick={() => setMode("unified")}
          >
            <List size={13} />
          </button>
        </div>
        {!tab.commit ? (
          <button type="button" className="git-btn" onClick={() => void toggleStage()}>
            {tab.staged ? <Minus size={12} /> : <Plus size={12} />}
            <span>{tab.staged ? "取消暂存" : "暂存"}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="git-btn"
          onClick={() => {
            const absPath = `${tab.cwd.replace(/[\\/]+$/, "")}/${tab.path}`;
            openFileTab(tab.agentKey || `${tab.deviceId}/git`, tab.path, tab.title, {
              absPath,
              spaceKey: tab.spaceKey,
            });
          }}
        >
          <FileText size={12} />
          <span>打开文件</span>
        </button>
        <button type="button" className="git-btn icon" aria-label="刷新" onClick={() => void load()}>
          <RotateCcw size={12} />
        </button>
      </div>

      <div className="diff-body">
        {error ? (
          <div className="inline-alert" style={{ margin: 16 }}>{error}</div>
        ) : loading ? (
          <div className="faint" style={{ padding: 16 }}>正在加载差异…</div>
        ) : diff?.binary ? (
          <div className="v3-empty-line">二进制文件，无法以文本对比差异。</div>
        ) : unifiedLines.length === 0 ? (
          <div className="v3-empty-line">该文件当前没有文本差异。</div>
        ) : mode === "unified" ? (
          <table className="diff-table">
            <colgroup>
              <col style={{ width: 44 }} />
              <col style={{ width: 44 }} />
              <col />
            </colgroup>
            <tbody>
              {unifiedLines.map((ln, idx) =>
                ln.kind === "hunk" ? (
                  <tr key={idx} className="diff-hunk">
                    <td colSpan={3}>{ln.text}</td>
                  </tr>
                ) : (
                  <tr key={idx} className={ln.kind === "add" ? "diff-line-add" : ln.kind === "del" ? "diff-line-del" : undefined}>
                    <td className="diff-ln">{ln.oldNo ?? ""}</td>
                    <td className="diff-ln">{ln.newNo ?? ""}</td>
                    <td className="diff-code">
                      {ln.kind === "add" ? "+" : ln.kind === "del" ? "-" : " "}
                      {highlightSingleLine(ln.text, diffLang)}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        ) : (
          <table className="diff-table">
            <colgroup>
              <col style={{ width: 44 }} />
              <col />
              <col style={{ width: 44 }} />
              <col />
            </colgroup>
            <tbody>
              {splitRows.map((r, idx) =>
                r.kind === "hunk" ? (
                  <tr key={idx} className="diff-hunk">
                    <td colSpan={4}>{r.header}</td>
                  </tr>
                ) : (
                  <tr key={idx}>
                    <td className={`diff-ln${r.left.kind === "del" ? " diff-line-del" : r.left.kind === "empty" ? " diff-line-empty" : ""}`}>
                      {r.left.no ?? ""}
                    </td>
                    <td className={`diff-code diff-split-sep${r.left.kind === "del" ? " diff-line-del" : r.left.kind === "empty" ? " diff-line-empty" : ""}`}>
                      {r.left.kind === "empty" ? "" : highlightSingleLine(r.left.text, diffLang)}
                    </td>
                    <td className={`diff-ln${r.right.kind === "add" ? " diff-line-add" : r.right.kind === "empty" ? " diff-line-empty" : ""}`}>
                      {r.right.no ?? ""}
                    </td>
                    <td className={`diff-code${r.right.kind === "add" ? " diff-line-add" : r.right.kind === "empty" ? " diff-line-empty" : ""}`}>
                      {r.right.kind === "empty" ? "" : highlightSingleLine(r.right.text, diffLang)}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
