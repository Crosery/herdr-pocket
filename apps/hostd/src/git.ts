import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  FILES_IGNORED,
  type GitCommitEntry,
  type GitDiffResult,
  type GitFileChange,
  type GitFileStatusCode,
  type GitRepoSummary,
  type GitStatusResult,
} from "@herdr-pocket/protocol";
import { FilesError, inside, isPrivateName, looksBinary } from "./files.ts";

const MAX_DIFF_TEXT_BYTES = 512 * 1024;
const MAX_SUBREPOS = 24;
const GIT_TIMEOUT_MS = 15_000;
const STATUS_CACHE_TTL_MS = 1500;

export const GIT_STATUS_PRIORITY: Record<GitFileStatusCode, number> = {
  U: 6,
  M: 5,
  A: 4,
  D: 3,
  R: 2,
  "?": 1,
};

const statusCache = new Map<string, { at: number; map: Map<string, GitFileStatusCode> }>();
const topLevelCache = new Map<string, { at: number; root: string | null }>();

export function invalidateGitCache(repoRoot?: string): void {
  if (!repoRoot) {
    statusCache.clear();
    return;
  }
  statusCache.delete(repoRoot);
}

function runGit(
  cwd: string,
  args: string[],
  allowFail = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) {
          resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        if (allowFail && typeof e.code === "number") {
          resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: e.code });
          return;
        }
        const msg = (stderr || err.message || "git 命令失败").trim();
        reject(new FilesError("bad_request", msg.slice(0, 300)));
      },
    );
  });
}

function runGitBytes(cwd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, encoding: "buffer", windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolvePromise(null);
          return;
        }
        resolvePromise(stdout as unknown as Buffer);
      },
    );
  });
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function resolveSafeBaseDir(
  dir: string | undefined,
  privateDirs: readonly string[] = [],
): Promise<string> {
  if (!dir?.trim()) throw new FilesError("not_found", "当前 Agent 没有工作目录");
  const raw = dir.trim();
  const expanded =
    raw === "~"
      ? homedir()
      : raw.startsWith("~/") || raw.startsWith("~\\")
        ? homedir() + raw.slice(1)
        : raw;
  let real: string;
  try {
    real = await realpath(expanded);
  } catch {
    throw new FilesError("not_found", "工作目录不存在");
  }
  const st = await stat(real).catch(() => null);
  if (!st?.isDirectory()) throw new FilesError("bad_request", "目标路径不是目录");
  for (const part of real.split(sep)) {
    if (part && isPrivateName(part)) {
      throw new FilesError("forbidden", "拒绝访问受保护目录");
    }
  }
  for (const priv of privateDirs) {
    const rp = await realpath(priv).catch(() => resolve(priv));
    if (inside(rp, real)) throw new FilesError("forbidden", "拒绝访问受保护目录");
  }
  return real;
}

async function resolveRepoTopLevel(dir: string): Promise<string | null> {
  const now = Date.now();
  const cached = topLevelCache.get(dir);
  if (cached && now - cached.at < 5000) return cached.root;
  const r = await runGit(dir, ["rev-parse", "--show-toplevel"], true).catch(() => null);
  const root = r && r.code === 0 && r.stdout.trim() ? await realpath(r.stdout.trim()).catch(() => r.stdout.trim()) : null;
  topLevelCache.set(dir, { at: now, root });
  return root;
}

function sanitizeRepoRelPath(repoRoot: string, rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("\0") || isAbsolute(trimmed)) {
    throw new FilesError("bad_request", "无效的文件路径");
  }
  const resolved = resolve(repoRoot, trimmed);
  if (!inside(repoRoot, resolved) || resolved === repoRoot) {
    throw new FilesError("forbidden", "路径超出了 Git 仓库范围");
  }
  return toPosix(relative(repoRoot, resolved));
}

function mapPorcelainChar(ch: string): GitFileStatusCode | null {
  switch (ch) {
    case "M":
    case "T":
      return "M";
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    case "U":
      return "U";
    case "?":
      return "?";
    default:
      return null;
  }
}

interface ParsedStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
}

function parseBranchHeader(line: string): { branch: string; upstream?: string; ahead: number; behind: number } {
  const body = line.slice(3).trim();
  if (body.startsWith("No commits yet on ")) {
    return { branch: body.slice("No commits yet on ".length).trim() || "HEAD", ahead: 0, behind: 0 };
  }
  if (body.startsWith("HEAD (no branch)")) {
    return { branch: "HEAD (detached)", ahead: 0, behind: 0 };
  }
  let ahead = 0;
  let behind = 0;
  let rest = body;
  const bracketIdx = body.lastIndexOf(" [");
  if (bracketIdx >= 0 && body.endsWith("]")) {
    const info = body.slice(bracketIdx + 2, -1);
    rest = body.slice(0, bracketIdx);
    const a = /ahead (\d+)/.exec(info);
    const b = /behind (\d+)/.exec(info);
    if (a) ahead = Number(a[1]);
    if (b) behind = Number(b[1]);
  }
  const dots = rest.indexOf("...");
  if (dots >= 0) {
    return { branch: rest.slice(0, dots), upstream: rest.slice(dots + 3), ahead, behind };
  }
  return { branch: rest || "HEAD", ahead, behind };
}

function parsePorcelainZ(stdout: string): ParsedStatus {
  const tokens = stdout.split("\0");
  let branch = "HEAD";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    if (tok.startsWith("## ")) {
      const parsed = parseBranchHeader(tok);
      branch = parsed.branch;
      upstream = parsed.upstream;
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }
    if (tok.length < 4 || tok[2] !== " ") continue;
    const x = tok[0]!;
    const y = tok[1]!;
    const path = tok.slice(3);
    let oldPath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      oldPath = tokens[i + 1] || undefined;
      i += 1;
    }
    if (x === "?" && y === "?") {
      unstaged.push({ path, status: "?", staged: false });
      continue;
    }
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      unstaged.push({ path, oldPath, status: "U", staged: false });
      continue;
    }
    const sx = mapPorcelainChar(x);
    if (sx) staged.push({ path, oldPath, status: sx, staged: true });
    const sy = mapPorcelainChar(y);
    if (sy) unstaged.push({ path, status: sy, staged: false });
  }

  return { branch, upstream, ahead, behind, staged, unstaged };
}

function parseNumstatZ(stdout: string): Map<string, { additions?: number; deletions?: number }> {
  const out = new Map<string, { additions?: number; deletions?: number }>();
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const parts = tok.split("\t");
    if (parts.length < 3) continue;
    const addRaw = parts[0]!;
    const delRaw = parts[1]!;
    const rest = parts.slice(2).join("\t");
    // In `-z` numstat, renames have an empty filename slot followed by old\0new\0.
    let filePath = rest;
    if (!filePath && i + 2 < tokens.length) {
      filePath = tokens[i + 2]!;
      i += 2;
    }
    if (!filePath) continue;
    if (addRaw === "-" && delRaw === "-") {
      out.set(filePath, {});
    } else {
      out.set(filePath, { additions: Number(addRaw) || 0, deletions: Number(delRaw) || 0 });
    }
  }
  return out;
}

async function summarizeRepo(root: string): Promise<GitRepoSummary> {
  const st = await runGit(root, ["status", "--porcelain=v1", "-z", "-b"], true);
  const parsed = parsePorcelainZ(st.stdout);
  const dirtyCount = new Set([...parsed.staged.map((c) => c.path), ...parsed.unstaged.map((c) => c.path)]).size;
  return {
    root,
    name: basename(root) || root,
    branch: parsed.branch,
    ...(parsed.upstream ? { upstream: parsed.upstream } : {}),
    ahead: parsed.ahead,
    behind: parsed.behind,
    dirtyCount,
  };
}

async function discoverWorkspaceRepos(baseDir: string, ownRoot: string | null): Promise<GitRepoSummary[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  if (ownRoot) {
    seen.add(ownRoot);
    roots.push(ownRoot);
  }
  const dirents = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  for (const d of dirents) {
    if (roots.length >= MAX_SUBREPOS) break;
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    if (d.name.startsWith(".") || FILES_IGNORED.includes(d.name)) continue;
    const child = join(baseDir, d.name);
    if (!existsSync(join(child, ".git"))) continue;
    const childRoot = await realpath(child).catch(() => child);
    if (seen.has(childRoot)) continue;
    seen.add(childRoot);
    roots.push(childRoot);
  }
  return Promise.all(roots.map((r) => summarizeRepo(r)));
}

/**
 * Returns a map from paths relative to `realRoot` (direct children + ancestor folders inside `relDir`)
 * to highest-priority git status badges, used by `files.list` without delaying non-git dirs.
 */
export async function readDirGitStatusMap(realRoot: string): Promise<{
  repoRoot: string;
  statuses: Map<string, GitFileStatusCode>;
} | null> {
  const repoRoot = await resolveRepoTopLevel(realRoot);
  if (!repoRoot) return null;
  const now = Date.now();
  const cached = statusCache.get(repoRoot);
  if (cached && now - cached.at < STATUS_CACHE_TTL_MS) {
    return { repoRoot, statuses: cached.map };
  }
  const st = await runGit(repoRoot, ["status", "--porcelain=v1", "-z"], true).catch(() => null);
  if (!st || st.code !== 0) return null;
  const parsed = parsePorcelainZ(st.stdout);
  const statuses = new Map<string, GitFileStatusCode>();
  const bump = (p: string, code: GitFileStatusCode) => {
    const prev = statuses.get(p);
    if (!prev || GIT_STATUS_PRIORITY[code] > GIT_STATUS_PRIORITY[prev]) {
      statuses.set(p, code);
    }
  };
  for (const c of [...parsed.unstaged, ...parsed.staged]) {
    const clean = c.path.replace(/\/+$/, "");
    bump(clean, c.status);
  }
  statusCache.set(repoRoot, { at: now, map: statuses });
  return { repoRoot, statuses };
}

export async function annotateEntriesGitStatus(
  realRoot: string,
  relDir: string,
  entries: Array<{ path: string; kind: "file" | "dir" | "link"; gitStatus?: GitFileStatusCode }>,
): Promise<void> {
  if (entries.length === 0) return;
  const info = await readDirGitStatusMap(realRoot);
  if (!info || info.statuses.size === 0) return;
  const repoToRootPrefix = toPosix(relative(info.repoRoot, realRoot));
  const prefix = repoToRootPrefix && !repoToRootPrefix.startsWith("..") ? `${repoToRootPrefix}/` : "";
  const relDirPrefix = relDir ? `${relDir}/` : "";

  const perTarget = new Map<string, GitFileStatusCode>();
  const setMax = (key: string, code: GitFileStatusCode) => {
    const prev = perTarget.get(key);
    if (!prev || GIT_STATUS_PRIORITY[code] > GIT_STATUS_PRIORITY[prev]) {
      perTarget.set(key, code);
    }
  };

  for (const [repoRel, code] of info.statuses.entries()) {
    let fromRealRoot = repoRel;
    if (prefix) {
      if (!repoRel.startsWith(prefix)) continue;
      fromRealRoot = repoRel.slice(prefix.length);
    } else if (repoToRootPrefix.startsWith("..")) {
      continue;
    }
    if (relDirPrefix && !fromRealRoot.startsWith(relDirPrefix)) continue;
    const sub = relDirPrefix ? fromRealRoot.slice(relDirPrefix.length) : fromRealRoot;
    if (!sub) continue;
    const firstSeg = sub.split("/")[0]!;
    const entryPath = `${relDirPrefix}${firstSeg}`;
    setMax(entryPath, code);
  }

  for (const e of entries) {
    const badge = perTarget.get(e.path);
    if (badge) e.gitStatus = badge;
  }
}

async function resolveTargetRepo(
  baseDir: string | undefined,
  privateDirs: readonly string[] = [],
): Promise<{ baseDir: string; repoRoot: string; repos: GitRepoSummary[] }> {
  const safeBase = await resolveSafeBaseDir(baseDir, privateDirs);
  const ownRoot = await resolveRepoTopLevel(safeBase);
  const repos = await discoverWorkspaceRepos(safeBase, ownRoot);
  const activeRoot = ownRoot ?? repos[0]?.root;
  if (!activeRoot) throw new FilesError("not_found", "这个目录不是 Git 仓库");
  return { baseDir: safeBase, repoRoot: activeRoot, repos };
}

async function readWorkingFileText(absPath: string): Promise<{ text?: string; binary?: boolean; truncated?: boolean }> {
  let st;
  try {
    st = lstatSync(absPath);
    if (st.isSymbolicLink()) return { text: "", binary: false };
  } catch {
    return { text: "" };
  }
  const fh = await open(absPath, "r").catch(() => null);
  if (!fh) return { text: "" };
  try {
    const s = await fh.stat();
    const truncated = s.size > MAX_DIFF_TEXT_BYTES;
    const want = Math.min(s.size, MAX_DIFF_TEXT_BYTES);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    const slice = buf.subarray(0, bytesRead);
    if (looksBinary(slice)) return { binary: true };
    return { text: slice.toString("utf8"), truncated };
  } finally {
    await fh.close();
  }
}

async function readGitObjectText(repoRoot: string, spec: string): Promise<{ text?: string; binary?: boolean; truncated?: boolean }> {
  const buf = await runGitBytes(repoRoot, ["show", spec]);
  if (!buf) return { text: "" };
  if (looksBinary(buf.subarray(0, 8192))) return { binary: true };
  if (buf.length > MAX_DIFF_TEXT_BYTES) {
    return { text: buf.subarray(0, MAX_DIFF_TEXT_BYTES).toString("utf8"), truncated: true };
  }
  return { text: buf.toString("utf8") };
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export async function getGitStatus(
  baseDir: string | undefined,
  privateDirs: readonly string[] = [],
): Promise<GitStatusResult> {
  const safeBase = await resolveSafeBaseDir(baseDir, privateDirs);
  const ownRoot = await resolveRepoTopLevel(safeBase);
  const repos = await discoverWorkspaceRepos(safeBase, ownRoot);
  const repoRoot = ownRoot ?? repos[0]?.root;
  if (!repoRoot) {
    return { isRepo: false, ahead: 0, behind: 0, branches: [], staged: [], unstaged: [], repos: [] };
  }

  const [stRes, unNum, stNum, branchRes] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "-z", "-b"], true),
    runGit(repoRoot, ["diff", "--numstat", "-z"], true),
    runGit(repoRoot, ["diff", "--cached", "--numstat", "-z"], true),
    runGit(repoRoot, ["branch", "--format=%(refname:short)"], true),
  ]);

  const parsed = parsePorcelainZ(stRes.stdout);
  const unstagedStats = parseNumstatZ(unNum.stdout);
  const stagedStats = parseNumstatZ(stNum.stdout);

  const staged = parsed.staged.map((c) => ({ ...c, ...stagedStats.get(c.path) }));
  const unstaged = parsed.unstaged.map((c) => ({ ...c, ...unstagedStats.get(c.path) }));
  const branches = branchRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parsed.branch && !parsed.branch.startsWith("HEAD") && !branches.includes(parsed.branch)) {
    branches.unshift(parsed.branch);
  }

  return {
    isRepo: true,
    root: repoRoot,
    branch: parsed.branch,
    ...(parsed.upstream ? { upstream: parsed.upstream } : {}),
    ahead: parsed.ahead,
    behind: parsed.behind,
    branches,
    staged,
    unstaged,
    repos,
  };
}

export async function getGitDiff(
  baseDir: string | undefined,
  p: { path: string; staged?: boolean; commit?: string },
  privateDirs: readonly string[] = [],
): Promise<GitDiffResult> {
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  const rel = sanitizeRepoRelPath(repoRoot, p.path);
  const staged = Boolean(p.staged);

  if (p.commit) {
    const commit = p.commit.trim();
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) throw new FilesError("bad_request", "无效的 commit hash");
    const patchRes = await runGit(repoRoot, ["show", "--format=", "--patch", "--unified=3", commit, "--", rel], true);
    const oldObj = await readGitObjectText(repoRoot, `${commit}^:${rel}`);
    const newObj = await readGitObjectText(repoRoot, `${commit}:${rel}`);
    const counts = countPatchLines(patchRes.stdout);
    return {
      path: rel,
      staged: false,
      patch: patchRes.stdout,
      oldText: oldObj.text,
      newText: newObj.text,
      binary: Boolean(oldObj.binary || newObj.binary),
      truncated: Boolean(oldObj.truncated || newObj.truncated),
      ...counts,
    };
  }

  if (staged) {
    const patchRes = await runGit(repoRoot, ["diff", "--cached", "--patch", "--unified=3", "--", rel], true);
    const oldObj = await readGitObjectText(repoRoot, `HEAD:${rel}`);
    const newObj = await readGitObjectText(repoRoot, `:0:${rel}`);
    const counts = countPatchLines(patchRes.stdout);
    return {
      path: rel,
      staged: true,
      patch: patchRes.stdout,
      oldText: oldObj.text,
      newText: newObj.text,
      binary: Boolean(oldObj.binary || newObj.binary),
      truncated: Boolean(oldObj.truncated || newObj.truncated),
      ...counts,
    };
  }

  const tracked = (await runGit(repoRoot, ["ls-files", "--error-unmatch", "--", rel], true)).code === 0;
  const work = await readWorkingFileText(join(repoRoot, rel));
  if (!tracked) {
    const text = work.text ?? "";
    const lines = text ? text.split("\n") : [];
    const header = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@`;
    const patch = work.binary ? `${header}\nBinary files differ` : `${header}\n${lines.map((l) => `+${l}`).join("\n")}`;
    return {
      path: rel,
      staged: false,
      patch,
      oldText: "",
      newText: work.binary ? undefined : text,
      binary: work.binary,
      truncated: work.truncated,
      additions: work.binary ? 0 : lines.length,
      deletions: 0,
    };
  }

  const patchRes = await runGit(repoRoot, ["diff", "--patch", "--unified=3", "--", rel], true);
  let oldObj = await readGitObjectText(repoRoot, `:0:${rel}`);
  if (oldObj.text === "" && !oldObj.binary) {
    oldObj = await readGitObjectText(repoRoot, `HEAD:${rel}`);
  }
  const counts = countPatchLines(patchRes.stdout);
  return {
    path: rel,
    staged: false,
    patch: patchRes.stdout,
    oldText: oldObj.text,
    newText: work.text,
    binary: Boolean(oldObj.binary || work.binary),
    truncated: Boolean(oldObj.truncated || work.truncated),
    ...counts,
  };
}

export async function getGitLog(
  baseDir: string | undefined,
  limit = 20,
  privateDirs: readonly string[] = [],
): Promise<GitCommitEntry[]> {
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  const clamped = Math.max(1, Math.min(100, Math.round(limit)));
  const r = await runGit(
    repoRoot,
    ["log", `-n${clamped}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%D%x1e"],
    true,
  );
  if (r.code !== 0 || !r.stdout.trim()) return [];
  const commits: GitCommitEntry[] = [];
  for (const rec of r.stdout.split("\x1e")) {
    const clean = rec.trim();
    if (!clean) continue;
    const [hash, shortHash, subject, author, tsRaw, refs] = clean.split("\x1f");
    if (!hash) continue;
    commits.push({
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      subject: subject || "(no message)",
      author: author || "",
      dateMs: (Number(tsRaw) || 0) * 1000,
      ...(refs?.trim() ? { refs: refs.trim() } : {}),
    });
  }
  return commits;
}

export async function gitStage(
  baseDir: string | undefined,
  p: { paths: string[]; all?: boolean },
  privateDirs: readonly string[] = [],
): Promise<void> {
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  if (p.all) {
    await runGit(repoRoot, ["add", "-A"]);
  } else {
    const safePaths = p.paths.map((x) => sanitizeRepoRelPath(repoRoot, x));
    if (safePaths.length === 0) throw new FilesError("bad_request", "未选择要暂存的文件");
    await runGit(repoRoot, ["add", "-A", "--", ...safePaths]);
  }
  invalidateGitCache(repoRoot);
}

export async function gitUnstage(
  baseDir: string | undefined,
  p: { paths: string[]; all?: boolean },
  privateDirs: readonly string[] = [],
): Promise<void> {
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  const hasHead = (await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], true)).code === 0;
  if (p.all) {
    if (hasHead) {
      await runGit(repoRoot, ["reset", "-q", "HEAD"]);
    } else {
      await runGit(repoRoot, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "."]);
    }
  } else {
    const safePaths = p.paths.map((x) => sanitizeRepoRelPath(repoRoot, x));
    if (safePaths.length === 0) throw new FilesError("bad_request", "未选择要取消暂存的文件");
    if (hasHead) {
      await runGit(repoRoot, ["reset", "-q", "HEAD", "--", ...safePaths]);
    } else {
      await runGit(repoRoot, ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...safePaths]);
    }
  }
  invalidateGitCache(repoRoot);
}

export async function gitDiscard(
  baseDir: string | undefined,
  p: { paths: string[]; untracked?: boolean },
  privateDirs: readonly string[] = [],
): Promise<void> {
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  const safePaths = p.paths.map((x) => sanitizeRepoRelPath(repoRoot, x));
  if (safePaths.length === 0) throw new FilesError("bad_request", "未选择要还原的文件");
  if (p.untracked) {
    await runGit(repoRoot, ["clean", "-f", "--", ...safePaths]);
  } else {
    const r = await runGit(repoRoot, ["restore", "--worktree", "--", ...safePaths], true);
    if (r.code !== 0) {
      await runGit(repoRoot, ["checkout", "--", ...safePaths]);
    }
  }
  invalidateGitCache(repoRoot);
}

export async function gitCommit(
  baseDir: string | undefined,
  message: string,
  privateDirs: readonly string[] = [],
): Promise<{ hash: string; subject: string }> {
  const msg = message.trim();
  if (!msg) throw new FilesError("bad_request", "请填写提交说明");
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  await runGit(repoRoot, ["commit", "-m", msg]);
  invalidateGitCache(repoRoot);
  const head = await runGit(repoRoot, ["log", "-n1", "--format=%h%x1f%s"], true);
  const [hash, subject] = head.stdout.trim().split("\x1f");
  return { hash: hash || "", subject: subject || msg.split("\n")[0]! };
}

export async function gitCheckout(
  baseDir: string | undefined,
  p: { branch: string; create?: boolean },
  privateDirs: readonly string[] = [],
): Promise<{ branch: string }> {
  const branch = p.branch.trim();
  if (!branch || branch.startsWith("-") || /\s/.test(branch) || branch.includes("..")) {
    throw new FilesError("bad_request", "分支名称格式不对");
  }
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  await runGit(repoRoot, p.create ? ["checkout", "-b", branch] : ["checkout", branch]);
  invalidateGitCache(repoRoot);
  return { branch };
}

export async function gitPull(
  baseDir: string | undefined,
  privateDirs: readonly string[] = [],
): Promise<{ summary: string }> {
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  const r = await runGit(repoRoot, ["pull", "--ff-only"]);
  invalidateGitCache(repoRoot);
  return { summary: (r.stdout || r.stderr || "已拉取").trim().slice(0, 300) };
}

export async function gitPush(
  baseDir: string | undefined,
  privateDirs: readonly string[] = [],
): Promise<{ summary: string }> {
  const { repoRoot } = await resolveTargetRepo(baseDir, privateDirs);
  const r = await runGit(repoRoot, ["push"]);
  invalidateGitCache(repoRoot);
  return { summary: (r.stdout || r.stderr || "已推送").trim().slice(0, 300) };
}
