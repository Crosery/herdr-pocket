// Read-only view of an agent's working folder (`files.list`, `files.read`). Nothing outside the
// folder is listed or read: paths are relative, `..` is refused, and every path is resolved to its
// real location (symlinks followed) and checked to be inside the folder's real location. Files that
// may hold keys are listed but never read, and so is this computer's own herdr-pocket folder.

import { execFile, spawn } from "node:child_process";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { FILES_IGNORED, FILES_LIMITS, type FileEntry, type RpcResult } from "@herdr-pocket/protocol";
import { annotateEntriesGitStatus } from "./git.ts";

const execFileAsync = promisify(execFile);

export type FilesErrorCode = "bad_request" | "forbidden" | "not_found";

export class FilesError extends Error {
  code: FilesErrorCode;
  constructor(code: FilesErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const ICLOUD_DATALESS_MESSAGE = "该文件目前仅保存在 iCloud 云端，已尝试触发本机下载，请稍候重试或在 Finder 中下载";
const ICLOUD_DOWNLOAD_COOLDOWN_MS = 60_000;
const ICLOUD_DOWNLOAD_MAX_CACHE = 256;
const icloudDownloadCooldown = new Map<string, number>();

/** True when reading a macOS iCloud dataless file fails with errno -11 / EDEADLK. */
export function isMacDatalessError(err: unknown, plat: NodeJS.Platform = process.platform): boolean {
  if (plat !== "darwin" || !err || typeof err !== "object") return false;
  const e = err as { errno?: unknown; code?: unknown };
  return e.errno === -11 || e.code === "EDEADLK";
}

function triggerMacICloudDownload(realPath: string): void {
  if (process.platform !== "darwin") return;
  const now = Date.now();
  const last = icloudDownloadCooldown.get(realPath);
  if (last !== undefined && now - last < ICLOUD_DOWNLOAD_COOLDOWN_MS) return;
  if (icloudDownloadCooldown.size >= ICLOUD_DOWNLOAD_MAX_CACHE) {
    const oldest = icloudDownloadCooldown.keys().next().value;
    if (oldest !== undefined) icloudDownloadCooldown.delete(oldest);
  }
  icloudDownloadCooldown.set(realPath, now);
  try {
    const child = spawn("/usr/bin/brctl", ["download", realPath], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort only; ignore spawn errors.
  }
}

export async function readHandleSlice(
  fh: Pick<FileHandle, "read">,
  realPath: string,
  buf: Buffer,
  offset: number,
  length: number,
  position: number,
  opts?: { platform?: NodeJS.Platform; triggerDownload?: (p: string) => void },
): Promise<number> {
  try {
    return (await fh.read(buf, offset, length, position)).bytesRead;
  } catch (e) {
    if (isMacDatalessError(e, opts?.platform ?? process.platform)) {
      (opts?.triggerDownload ?? triggerMacICloudDownload)(realPath);
      throw new FilesError("not_found", ICLOUD_DATALESS_MESSAGE);
    }
    throw e;
  }
}

/** Names of files and folders that hold keys or credentials: listed, never read or opened. */
const PRIVATE_NAME =
  /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|keychains|\.env(\.(?!example$|sample$|template$|dist$).+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const MEDIA_MIME: Record<string, { mime: string; kind: "pdf" | "audio" | "video" }> = {
  pdf: { mime: "application/pdf", kind: "pdf" },
  mp3: { mime: "audio/mpeg", kind: "audio" },
  wav: { mime: "audio/wav", kind: "audio" },
  ogg: { mime: "audio/ogg", kind: "audio" },
  flac: { mime: "audio/flac", kind: "audio" },
  m4a: { mime: "audio/mp4", kind: "audio" },
  aac: { mime: "audio/aac", kind: "audio" },
  opus: { mime: "audio/opus", kind: "audio" },
  weba: { mime: "audio/webm", kind: "audio" },
  aiff: { mime: "audio/aiff", kind: "audio" },
  aif: { mime: "audio/aiff", kind: "audio" },
  caf: { mime: "audio/x-caf", kind: "audio" },
  mp4: { mime: "video/mp4", kind: "video" },
  webm: { mime: "video/webm", kind: "video" },
  mov: { mime: "video/quicktime", kind: "video" },
  m4v: { mime: "video/x-m4v", kind: "video" },
  mkv: { mime: "video/x-matroska", kind: "video" },
  avi: { mime: "video/x-msvideo", kind: "video" },
  ogv: { mime: "video/ogg", kind: "video" },
  mpg: { mime: "video/mpeg", kind: "video" },
  mpeg: { mime: "video/mpeg", kind: "video" },
};

const OFFICE_MIME: Record<string, { mime: string; kind: "document" | "spreadsheet" | "presentation" }> = {
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
  doc: { mime: "application/msword", kind: "document" },
  rtf: { mime: "application/rtf", kind: "document" },
  odt: { mime: "application/vnd.oasis.opendocument.text", kind: "document" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "spreadsheet" },
  xls: { mime: "application/vnd.ms-excel", kind: "spreadsheet" },
  ods: { mime: "application/vnd.oasis.opendocument.spreadsheet", kind: "spreadsheet" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "presentation" },
};

const MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const OFFICE_MAX_BYTES = 32 * 1024 * 1024;

const LANGUAGE: Record<string, string> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx",
  py: "py", rs: "rs", go: "go", java: "java", kt: "kt", kts: "kt", swift: "swift", c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "cs", rb: "rb", php: "php", lua: "lua",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", ps1: "ps1", bat: "bat", cmd: "bat",
  md: "md", markdown: "md", json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", xml: "xml", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  sql: "sql", vue: "vue", svelte: "svelte", ets: "ts", dart: "dart", gradle: "gradle", svg: "xml", csv: "csv", tsv: "csv", psv: "csv", txt: "text", log: "text",
};

const LANGUAGE_BY_NAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", "cmakelists.txt": "cmake" };

const SNIFF_BYTES = 8192;

export interface FilesOptions {
  /** Folders whose contents are never shown (this computer's herdr-pocket settings, with its token). */
  privateDirs?: string[];
  /** Additional trusted base folders (e.g. ~/.local/state/herdr-core) readable by absolute/`~` path. */
  extraRoots?: string[];
}

export function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.min(hi, Math.max(lo, n));
}

export function isPrivateName(name: string): boolean {
  return PRIVATE_NAME.test(name);
}

/**
 * True when any path contains a `.agents` segment followed by a `credentials` segment
 * (e.g. `~/.agents/credentials` or `~/.agents/<profile>/credentials`), regardless of OS or username.
 */
export function isPrivateAgentCredentialsPath(p: string): boolean {
  const segs = p.split(/[\\/]+/).filter(Boolean);
  let sawAgents = false;
  for (const seg of segs) {
    const low = seg.toLowerCase();
    if (low === ".agents") {
      sawAgents = true;
    } else if (sawAgents && low === "credentials") {
      return true;
    }
  }
  return false;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (sep === "\\" && p.startsWith("~\\"))) return join(homedir(), p.slice(2));
  return p;
}

/** Real location of `rel` inside `root` (or `o.extraRoots`), refusing anything outside or private. */
export async function resolveInside(root: string | undefined, rel: unknown, o: FilesOptions = {}): Promise<{ realRoot: string; real: string; rel: string }> {
  if (rel !== undefined && typeof rel !== "string") throw new FilesError("bad_request", "path 要是文字");
  const raw = (rel ?? "").replace(/\\/g, "/");
  if (raw.length > 4096 || raw.includes("\0")) throw new FilesError("bad_request", "路径不对");

  const hasExtraRoots = Boolean(o.extraRoots?.length);
  const looksAbsOrHome = raw.startsWith("/") || raw === "~" || raw.startsWith("~/") || /^[A-Za-z]:/.test(raw);
  if (looksAbsOrHome && !hasExtraRoots) {
    throw new FilesError("bad_request", "路径要相对于 agent 的工作目录");
  }

  let realRoot: string | null = null;
  if (root && isAbsolute(root)) {
    realRoot = await realpath(root).catch(() => null);
  }
  if (!realRoot && !hasExtraRoots) {
    throw new FilesError("not_found", !root || !isAbsolute(root) ? "这个 agent 没有工作目录" : "agent 的工作目录已经不在了");
  }

  const resolvedExtras: string[] = [];
  for (const extra of o.extraRoots ?? []) {
    if (!extra) continue;
    const expanded = expandHome(extra);
    if (!isAbsolute(expanded)) continue;
    const realExtra = await realpath(expanded).catch(() => null);
    if (realExtra) resolvedExtras.push(realExtra);
  }

  if (looksAbsOrHome) {
    const candidate = expandHome(raw);
    if (!isAbsolute(candidate)) throw new FilesError("bad_request", "路径要相对于 agent 的工作目录");
    if (isPrivateAgentCredentialsPath(candidate)) {
      throw new FilesError("forbidden", "这个文件可能存有密钥，不在这里显示");
    }
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new FilesError("not_found", "没有这个文件或目录");
    }
    const allowedRoots = [...(realRoot ? [realRoot] : []), ...resolvedExtras];
    const matchedRoot = allowedRoots.find((base) => inside(base, real));
    if (!matchedRoot) throw new FilesError("forbidden", "不能看工作目录以外的文件");
    const relFromRoot = relative(matchedRoot, real).split(sep).filter(Boolean);
    if (relFromRoot.some(isPrivateName) || isPrivateName(basename(real)) || isPrivateAgentCredentialsPath(real)) {
      throw new FilesError("forbidden", "这个文件可能存有密钥，不在这里显示");
    }
    for (const dir of o.privateDirs ?? []) {
      const realDir = await realpath(dir).catch(() => dir);
      if (inside(realDir, real)) throw new FilesError("forbidden", "这是 herdr-pocket 自己的设置目录，不在这里显示");
    }
    return { realRoot: matchedRoot, real, rel: relFromRoot.join("/") || basename(real) };
  }

  if (!root || !isAbsolute(root)) throw new FilesError("not_found", "这个 agent 没有工作目录");
  if (!realRoot) throw new FilesError("not_found", "agent 的工作目录已经不在了");

  const parts = raw.split("/").filter((p) => p && p !== ".");
  if (parts.includes("..")) throw new FilesError("forbidden", "不能看工作目录以外的文件");
  if (parts.some(isPrivateName) || isPrivateAgentCredentialsPath(parts.join("/"))) {
    throw new FilesError("forbidden", "这个文件可能存有密钥，不在这里显示");
  }
  let real: string;
  try {
    real = await realpath(join(realRoot, ...parts));
  } catch {
    throw new FilesError("not_found", "没有这个文件或目录");
  }
  const matchedExtra = !inside(realRoot, real) ? resolvedExtras.find((base) => inside(base, real)) : undefined;
  if (!inside(realRoot, real) && !matchedExtra) {
    throw new FilesError("forbidden", "这个链接指向工作目录以外，不能打开");
  }
  if (isPrivateAgentCredentialsPath(real)) {
    throw new FilesError("forbidden", "这个文件可能存有密钥，不在这里显示");
  }
  if (matchedExtra) {
    const extraParts = relative(matchedExtra, real).split(sep).filter(Boolean);
    if (extraParts.some(isPrivateName)) {
      throw new FilesError("forbidden", "这个文件可能存有密钥，不在这里显示");
    }
  }
  for (const dir of o.privateDirs ?? []) {
    const realDir = await realpath(dir).catch(() => dir);
    if (inside(realDir, real)) throw new FilesError("forbidden", "这是 herdr-pocket 自己的设置目录，不在这里显示");
  }
  return { realRoot: matchedExtra ?? realRoot, real, rel: matchedExtra ? (relative(matchedExtra, real).split(sep).join("/") || basename(real)) : parts.join("/") };
}

const IGNORED_WORKSPACE_DIRS = new Set(FILES_IGNORED);

async function findWorkspaceFileBySuffix(
  realRoot: string,
  rawRel: string,
  o: FilesOptions = {},
): Promise<{ realRoot: string; real: string; rel: string } | null> {
  if (!rawRel || rawRel.length > 4096 || rawRel.includes("\0")) return null;
  const parts = rawRel.replace(/\\/g, "/").split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.includes("..") || parts.some(isPrivateName)) return null;
  const cleanSuffix = parts.join("/");
  const lowerSuffix = cleanSuffix.toLowerCase();
  const allowHiddenDirs = parts[0]!.startsWith(".");
  const realPrivates = await Promise.all((o.privateDirs ?? []).map((dir) => realpath(dir).catch(() => dir)));

  let exactBest: { depth: number; rel: string; real: string } | null = null;
  let ciBest: { depth: number; rel: string; real: string } | null = null;
  const queue: Array<{ dir: string; relPrefix: string; depth: number }> = [{ dir: realRoot, relPrefix: "", depth: 0 }];
  const maxDepth = 8;
  const maxEntries = 12_000;
  let visited = 0;

  while (queue.length > 0 && visited < maxEntries) {
    const cur = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      visited += 1;
      if (visited > maxEntries) break;
      if (isPrivateName(d.name)) continue;
      const rel = cur.relPrefix ? `${cur.relPrefix}/${d.name}` : d.name;
      const full = join(cur.dir, d.name);
      if (d.isDirectory()) {
        if (cur.depth + 1 >= maxDepth) continue;
        if (IGNORED_WORKSPACE_DIRS.has(d.name)) continue;
        if (!allowHiddenDirs && d.name.startsWith(".")) continue;
        queue.push({ dir: full, relPrefix: rel, depth: cur.depth + 1 });
        continue;
      }
      if (!d.isFile()) continue;
      const relLower = rel.toLowerCase();
      const isExact = rel === cleanSuffix || rel.endsWith(`/${cleanSuffix}`);
      const isCi = isExact || relLower === lowerSuffix || relLower.endsWith(`/${lowerSuffix}`);
      if (!isExact && !isCi) continue;
      const real = await realpath(full).catch(() => null);
      if (!real || !inside(realRoot, real)) continue;
      if (isPrivateAgentCredentialsPath(real)) continue;
      if (realPrivates.some((dir) => inside(dir, real))) continue;
      const depth = rel.split("/").length - 1;
      if (isExact) {
        if (!exactBest || depth < exactBest.depth || (depth === exactBest.depth && byName(rel, exactBest.rel) < 0)) {
          exactBest = { depth, rel, real };
        }
      } else {
        if (!ciBest || depth < ciBest.depth || (depth === ciBest.depth && byName(rel, ciBest.rel) < 0)) {
          ciBest = { depth, rel, real };
        }
      }
    }
  }

  const pick = exactBest ?? ciBest;
  return pick ? { realRoot, real: pick.real, rel: pick.rel } : null;
}

const SMART_RESOLVE_CACHE_TTL_MS = 30_000;
const SMART_RESOLVE_CACHE_MAX = 256;
const smartResolveCache = new Map<string, { at: number; hit: { realRoot: string; real: string; rel: string } }>();

/**
 * Strips accidental quotes, brackets, zero-width spaces, embedded hard-wrap newlines,
 * `file://` schemes, and `#L12-L20` / `:12` line suffixes from a requested file path.
 */
export function sanitizeRequestedFilePath(raw: string): string {
  let clean = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\r\n]+/g, "")
    .trim()
    .replace(/^[<("'`\u201c\u2018]+|[>)"'`\u201d\u2019.,;!?]+$/g, "");
  if (/^file:\/\//i.test(clean)) {
    clean = clean.slice("file://".length);
    if (clean.startsWith("localhost/")) clean = clean.slice("localhost".length);
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // keep raw path if percent-encoding is malformed
    }
  }
  clean = clean.replace(/#L\d+(?:-L?\d+)?$/i, "");
  const colon = /:(\d+)(?::\d+)?$/.exec(clean);
  if (colon) {
    const prefix = clean.slice(0, colon.index);
    if (prefix && !/^[A-Za-z]$/.test(prefix)) clean = prefix;
  }
  return clean.trim();
}

function defaultAgentArtifactRoots(): string[] {
  const home = homedir();
  const candidates = [
    join(home, ".gemini", "antigravity-cli", "brain"),
    join(home, ".gemini", "antigravity", "brain"),
    join(home, ".local", "state", "herdr-core", "default", "files"),
    join(home, ".claude"),
    join(home, ".codex"),
  ];
  return candidates;
}

async function searchArtifactRootsBySuffix(
  artifactRoots: string[],
  allowedRealRoots: string[],
  suffixes: string[],
  realPrivates: string[],
): Promise<{ realRoot: string; real: string; rel: string } | null> {
  const cleanSuffixes = [...new Set(suffixes.map((s) => s.replace(/\\/g, "/").replace(/^\/+/, "")).filter(Boolean))];
  if (!cleanSuffixes.length) return null;

  // Tier 2A: O(1) direct join probe across known artifact roots (instant <1ms for `<uuid>/<file>`).
  for (const base of artifactRoots) {
    const realBase = await realpath(base).catch(() => null);
    if (!realBase) continue;
    const allowedParent = allowedRealRoots.find((r) => inside(r, realBase));
    if (!allowedParent) continue;
    for (const sfx of cleanSuffixes) {
      const parts = sfx.split("/").filter((p) => p && p !== ".");
      if (!parts.length || parts.includes("..") || parts.some(isPrivateName)) continue;
      const real = await realpath(join(realBase, ...parts)).catch(() => null);
      if (!real || !inside(allowedParent, real)) continue;
      const st = await stat(real).catch(() => null);
      if (!st?.isFile()) continue;
      const relParts = relative(allowedParent, real).split(sep).filter(Boolean);
      if (relParts.some(isPrivateName) || isPrivateName(basename(real)) || isPrivateAgentCredentialsPath(real)) continue;
      if (realPrivates.some((dir) => inside(dir, real))) continue;
      return { realRoot: allowedParent, real, rel: relParts.join("/") || basename(real) };
    }
  }

  // Tier 2B: Bounded shallow BFS (depth <= 3) in artifact/brain dirs for bare filenames or truncated paths.
  const lowerSuffixes = cleanSuffixes.map((s) => s.toLowerCase());
  let best: { priority: number; mtimeMs: number; realRoot: string; real: string; rel: string } | null = null;
  for (const base of artifactRoots) {
    const realBase = await realpath(base).catch(() => null);
    if (!realBase) continue;
    const allowedParent = allowedRealRoots.find((r) => inside(r, realBase));
    if (!allowedParent) continue;
    const queue: Array<{ dir: string; depth: number }> = [{ dir: realBase, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited < 4000) {
      const cur = queue.shift()!;
      const dirents = await readdir(cur.dir, { withFileTypes: true }).catch(() => null);
      if (!dirents) continue;
      for (const d of dirents) {
        visited += 1;
        if (visited > 4000) break;
        if (isPrivateName(d.name) || d.name === ".system_generated" || IGNORED_WORKSPACE_DIRS.has(d.name)) continue;
        const full = join(cur.dir, d.name);
        if (d.isDirectory()) {
          if (cur.depth + 1 <= 3) queue.push({ dir: full, depth: cur.depth + 1 });
          continue;
        }
        if (!d.isFile()) continue;
        const fullNorm = full.replace(/\\/g, "/").toLowerCase();
        let matchedPriority = -1;
        for (let si = 0; si < lowerSuffixes.length; si++) {
          const ls = lowerSuffixes[si]!;
          if (fullNorm === ls || fullNorm.endsWith(`/${ls}`)) {
            matchedPriority = si;
            break;
          }
        }
        if (matchedPriority < 0) continue;
        const real = await realpath(full).catch(() => null);
        if (!real || !inside(allowedParent, real)) continue;
        const relParts = relative(allowedParent, real).split(sep).filter(Boolean);
        if (relParts.some(isPrivateName) || isPrivateName(basename(real)) || isPrivateAgentCredentialsPath(real)) continue;
        if (realPrivates.some((dir) => inside(dir, real))) continue;
        const st = await stat(real).catch(() => null);
        if (!st?.isFile()) continue;
        if (!best || matchedPriority < best.priority || (matchedPriority === best.priority && st.mtimeMs > best.mtimeMs)) {
          best = {
            priority: matchedPriority,
            mtimeMs: st.mtimeMs,
            realRoot: allowedParent,
            real,
            rel: relParts.join("/") || basename(real),
          };
        }
      }
    }
  }
  return best ? { realRoot: best.realRoot, real: best.real, rel: best.rel } : null;
}

/**
 * Smart, fast, security-preserving file locator:
 * 1) Sanitizes stray quotes/newlines/`file://` schemes.
 * 2) Tries exact `resolveInside` (O(1)).
 * 3) Probes known Agent artifact/brain roots (O(1) direct join, then depth<=3 search).
 * 4) Falls back to workspace suffix & trailing-segment matching inside `root`.
 * Always enforces `PRIVATE_NAME` and `privateDirs` boundaries.
 */
export async function smartResolveFile(
  root: string | undefined,
  rawPath: string,
  o: FilesOptions = {},
): Promise<{ realRoot: string; real: string; rel: string }> {
  const clean = sanitizeRequestedFilePath(rawPath);
  if (!clean) throw new FilesError("bad_request", "需要 path");

  try {
    return await resolveInside(root, clean, o);
  } catch (err) {
    if (!(err instanceof FilesError) || err.code !== "not_found") {
      throw err;
    }

    const cacheKey = `${root ?? ""}\0${clean}\0${(o.extraRoots ?? []).join("|")}`;
    const cached = smartResolveCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SMART_RESOLVE_CACHE_TTL_MS) {
      const stillThere = await stat(cached.hit.real).catch(() => null);
      if (stillThere?.isFile()) return cached.hit;
      smartResolveCache.delete(cacheKey);
    }

    const realRoot = root && isAbsolute(root) ? await realpath(root).catch(() => null) : null;
    const resolvedExtras: string[] = [];
    for (const extra of o.extraRoots ?? []) {
      if (!extra) continue;
      const expanded = expandHome(extra);
      if (!isAbsolute(expanded)) continue;
      const r = await realpath(expanded).catch(() => null);
      if (r) resolvedExtras.push(r);
    }
    const allowedRoots = [...(realRoot ? [realRoot] : []), ...resolvedExtras];
    const realPrivates = await Promise.all((o.privateDirs ?? []).map((dir) => realpath(dir).catch(() => dir)));

    const rawNorm = clean.replace(/\\/g, "/");
    const rootNorm = root?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
    const realRootNorm = realRoot?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";

    // Build prioritized suffix candidates from most specific to basename.
    const candidates: string[] = [];
    if (rootNorm && rawNorm.startsWith(`${rootNorm}/`)) candidates.push(rawNorm.slice(rootNorm.length + 1));
    if (realRootNorm && rawNorm.startsWith(`${realRootNorm}/`)) candidates.push(rawNorm.slice(realRootNorm.length + 1));
    if (!/^(\/|~\/|~|[A-Za-z]:)/.test(rawNorm)) {
      candidates.push(rawNorm.replace(/^\.\//, ""));
    }
    const segments = rawNorm.split("/").filter((p) => p && p !== "." && p !== "..");
    if (segments.length >= 3) candidates.push(segments.slice(-3).join("/"));
    if (segments.length >= 2) candidates.push(segments.slice(-2).join("/"));
    if (segments.length >= 1) candidates.push(segments[segments.length - 1]!);

    const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
    const putCache = (hit: { realRoot: string; real: string; rel: string }) => {
      if (smartResolveCache.size >= SMART_RESOLVE_CACHE_MAX) {
        const oldest = smartResolveCache.keys().next().value;
        if (oldest) smartResolveCache.delete(oldest);
      }
      smartResolveCache.set(cacheKey, { at: Date.now(), hit });
      return hit;
    };

    // Fast path 1: direct/shallow match in known agent artifact & brain directories (when covered by extraRoots).
    if (resolvedExtras.length > 0) {
      const artifactHit = await searchArtifactRootsBySuffix(
        [...defaultAgentArtifactRoots(), ...resolvedExtras.filter((r) => r !== homedir())],
        allowedRoots,
        uniqueCandidates,
        realPrivates,
      );
      if (artifactHit) return putCache(artifactHit);
    }

    // Fast path 2: workspace suffix search (most specific candidate first).
    if (realRoot) {
      for (const sfx of uniqueCandidates) {
        const hit = await findWorkspaceFileBySuffix(realRoot, sfx, o);
        if (hit) return putCache(hit);
      }
    }

    throw err;
  }
}

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

export async function listFiles(
  root: string | undefined,
  p: { path?: string; hidden?: boolean; all?: boolean; limit?: number },
  o: FilesOptions = {},
): Promise<RpcResult<"files.list">> {
  const { realRoot, real, rel } = await resolveInside(root, p.path, o);
  const st = await stat(real);
  if (!st.isDirectory()) throw new FilesError("bad_request", "这不是一个目录");
  const limit = clamp(p.limit, 1, FILES_LIMITS.listMax, FILES_LIMITS.list);
  let dirents;
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch (e) {
    throw new FilesError("forbidden", `读不了这个目录（${(e as NodeJS.ErrnoException).code ?? "error"}）`);
  }
  const shown = dirents
    .filter((d) => d.isFile() || d.isDirectory() || d.isSymbolicLink())
    .map((d) => ({ d, ignored: FILES_IGNORED.includes(d.name), hidden: d.name.startsWith(".") }))
    // Heavy folders follow `all`, whatever their name; other dot files follow `hidden`.
    .filter((x) => (x.ignored ? !!p.all : !x.hidden || !!p.hidden))
    .sort((a, b) => Number(b.d.isDirectory()) - Number(a.d.isDirectory()) || byName(a.d.name, b.d.name));
  const entries: FileEntry[] = [];
  for (const { d, ignored, hidden } of shown.slice(0, limit)) {
    const path = rel ? `${rel}/${d.name}` : d.name;
    const full = join(real, d.name);
    const e: FileEntry = { name: d.name, path, kind: d.isDirectory() ? "dir" : "file" };
    if (hidden) e.hidden = true;
    if (ignored) e.ignored = true;
    if (isPrivateName(d.name) || isPrivateAgentCredentialsPath(full)) e.private = true;
    try {
      if (d.isSymbolicLink()) {
        const target = await realpath(full).catch(() => undefined);
        if (!target || !inside(realRoot, target)) {
          e.kind = "link";
          entries.push(e);
          continue;
        }
        e.symlink = true;
      }
      const s = await stat(full);
      e.kind = s.isDirectory() ? "dir" : "file";
      if (e.kind === "file") e.size = s.size;
      e.mtime = Math.round(s.mtimeMs);
    } catch {
      // Gone between the listing and the look, or not readable: listed without details.
    }
    entries.push(e);
  }
  await annotateEntriesGitStatus(realRoot, rel, entries).catch(() => {});
  return { root: realRoot, path: rel, entries, truncated: shown.length > limit };
}

/** Where a cut at `end` would split a UTF-8 character: the start of that character, else `end`. */
function utf8Cut(buf: Uint8Array, end: number): number {
  for (let i = end - 1; i >= Math.max(0, end - 4); i--) {
    const b = buf[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i + len > end ? i : end;
  }
  return end;
}

export async function readFileSlice(
  root: string | undefined,
  p: { path?: string; maxBytes?: number; offset?: number },
  o: FilesOptions = {},
): Promise<RpcResult<"files.read">> {
  if (typeof p.path !== "string" || !p.path) throw new FilesError("bad_request", "需要 path");
  const resolved = await smartResolveFile(root, p.path, o);
  const { real, rel } = resolved;
  const st = await stat(real);
  if (st.isDirectory()) throw new FilesError("bad_request", "这是一个目录，用 files.list 看");
  if (!st.isFile()) throw new FilesError("bad_request", "这不是普通文件");
  const size = st.size;
  const mtime = Math.round(st.mtimeMs);
  // At least 4 bytes, so one character of any length always fits.
  const maxBytes = clamp(p.maxBytes, 4, FILES_LIMITS.readMax, FILES_LIMITS.read);
  let offset = clamp(p.offset, 0, size, 0);
  const name = rel.split("/").pop() ?? "";
  const ext = extname(name).slice(1).toLowerCase();
  const language = LANGUAGE[ext] ?? LANGUAGE_BY_NAME[name.toLowerCase()];
  const base = { path: rel, size, mtime, ...(language ? { language } : {}) };
  let fh;
  try {
    fh = await open(real, "r");
  } catch (e) {
    if (isMacDatalessError(e)) {
      triggerMacICloudDownload(real);
      throw new FilesError("not_found", ICLOUD_DATALESS_MESSAGE);
    }
    throw new FilesError("forbidden", `读不了这个文件（${(e as NodeJS.ErrnoException).code ?? "error"}）`);
  }
  try {
    const mime = IMAGE_MIME[ext];
    if (mime) {
      if (size > FILES_LIMITS.image) return { ...base, binary: true, kind: "image", truncated: true, offset: 0, bytes: 0, mime };
      const buf = Buffer.alloc(size);
      const bytesRead = await readHandleSlice(fh, real, buf, 0, size, 0);
      return { ...base, binary: true, kind: "image", truncated: false, offset: 0, bytes: bytesRead, mime, base64: buf.subarray(0, bytesRead).toString("base64") };
    }
    const media = MEDIA_MIME[ext];
    if (media) {
      if (size > MEDIA_MAX_BYTES) return { ...base, binary: true, kind: media.kind, truncated: true, offset: 0, bytes: 0, mime: media.mime };
      const buf = Buffer.alloc(size);
      const bytesRead = await readHandleSlice(fh, real, buf, 0, size, 0);
      return { ...base, binary: true, kind: media.kind, truncated: false, offset: 0, bytes: bytesRead, mime: media.mime, base64: buf.subarray(0, bytesRead).toString("base64") };
    }
    const office = OFFICE_MIME[ext];
    if (office) {
      if (size > OFFICE_MAX_BYTES) return { ...base, binary: true, kind: office.kind, truncated: true, offset: 0, bytes: 0, mime: office.mime };
      const buf = Buffer.alloc(size);
      const bytesRead = await readHandleSlice(fh, real, buf, 0, size, 0);
      const slice = buf.subarray(0, bytesRead);
      let text: string | undefined;
      if (ext === "rtf" && !looksBinary(slice.subarray(0, Math.min(SNIFF_BYTES, slice.length)))) {
        const cap = Math.min(bytesRead, maxBytes);
        text = new TextDecoder("utf-8").decode(slice.subarray(0, utf8Cut(slice, cap)));
      }
      let previewHtml: string | undefined;
      if (process.platform === "darwin" && (ext === "doc" || ext === "rtf" || ext === "odt")) {
        try {
          const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "html", "-stdout", real], {
            timeout: 3500,
            maxBuffer: 8 * 1024 * 1024,
            encoding: "utf8",
          });
          if (typeof stdout === "string" && stdout.trim()) previewHtml = stdout;
        } catch {
          // Non-fatal: client falls back to pure-TS binary/RTF parser.
        }
      }
      return {
        ...base,
        binary: ext !== "rtf" || text === undefined,
        kind: office.kind,
        truncated: false,
        offset: 0,
        bytes: bytesRead,
        mime: office.mime,
        base64: slice.toString("base64"),
        ...(text !== undefined ? { text } : {}),
        ...(previewHtml !== undefined ? { previewHtml } : {}),
      };
    }
    const sniff = Buffer.alloc(Math.min(SNIFF_BYTES, size));
    const sniffed = await readHandleSlice(fh, real, sniff, 0, sniff.length, 0);
    if (looksBinary(sniff.subarray(0, sniffed))) return { ...base, binary: true, kind: "binary", truncated: false, offset: 0, bytes: 0 };
    const want = Math.min(maxBytes + 4, size - offset);
    const buf = Buffer.alloc(want);
    const got = await readHandleSlice(fh, real, buf, 0, want, offset);
    // An offset in the middle of a character starts at the next one.
    let start = 0;
    while (start < got && start < 4 && (buf[start]! & 0xc0) === 0x80) start++;
    offset += start;
    let end = Math.min(got, start + maxBytes);
    if (offset - start + end < size) end = utf8Cut(buf, end);
    const bytes = end - start;
    const text = new TextDecoder("utf-8").decode(buf.subarray(start, end));
    return { ...base, binary: false, kind: "text", truncated: offset + bytes < size, offset, bytes, text };
  } finally {
    await fh.close();
  }
}

/** NUL bytes, or bytes that are not UTF-8, near the start of a file. */
export function looksBinary(head: Uint8Array): boolean {
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return false;
  } catch {
    return true;
  }
}

const FOLDER_LIMIT = 200;

function compactHome(p: string, home: string): string {
  if (!home || home === "/" || home === "\\") return p;
  if (p === home) return "~";
  return p.startsWith(`${home}${sep}`) ? `~${sep}${p.slice(home.length + 1)}` : p;
}

/** Lists subdirectories inside `inputPath` (defaulting to the user's home directory) for folder picking. */
export async function listFolders(
  inputPath: unknown,
  hidden = false,
  o: FilesOptions = {},
): Promise<RpcResult<"folders.list">> {
  const home = await realpath(homedir()).catch(() => homedir());
  let target = typeof inputPath === "string" ? inputPath.trim() : "";
  if (!target || target === "~") target = home;
  else if (target.startsWith("~/") || target.startsWith("~\\")) target = join(home, target.slice(2));
  if (target.length > 4096 || target.includes("\0")) throw new FilesError("bad_request", "路径不对");

  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new FilesError("not_found", "没有这个目录");
  }
  const st = await stat(real).catch(() => null);
  if (!st?.isDirectory()) throw new FilesError("bad_request", "这不是一个目录");

  const resolvedPrivate = await Promise.all((o.privateDirs ?? []).map((dir) => realpath(dir).catch(() => dir)));
  const isRestricted = (p: string): boolean => {
    const parts = p.split(/[\\/]+/).filter(Boolean);
    if (parts.some(isPrivateName) || isPrivateAgentCredentialsPath(p)) return true;
    return resolvedPrivate.some((dir) => inside(dir, p));
  };
  if (isRestricted(real)) throw new FilesError("forbidden", "这个目录可能存有密钥或私有配置，不能浏览");

  let dirents;
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch (e) {
    throw new FilesError("forbidden", `读不了这个目录（${(e as NodeJS.ErrnoException).code ?? "error"}）`);
  }

  const dirs: string[] = [];
  for (const d of dirents) {
    if (!hidden && (d.name.startsWith(".") || d.name === "node_modules")) continue;
    if (isPrivateName(d.name)) continue;
    const full = join(real, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      const linkTarget = await realpath(full).catch(() => undefined);
      if (!linkTarget || isRestricted(linkTarget)) continue;
      const lst = await stat(linkTarget).catch(() => null);
      isDir = Boolean(lst?.isDirectory());
    }
    if (isDir) dirs.push(d.name);
  }
  dirs.sort(byName);

  const up = dirname(real);
  const parent = up && up !== real ? compactHome(up, home) : null;
  const displayPath = compactHome(real, home);

  return {
    path: displayPath,
    displayPath,
    parent,
    entries: dirs.slice(0, FOLDER_LIMIT).map((name) => ({
      name,
      path: compactHome(join(real, name), home),
    })),
  };
}
