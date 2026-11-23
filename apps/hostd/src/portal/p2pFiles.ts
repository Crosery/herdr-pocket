import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { DIRECT_PORTAL_FS_PREFIX, FILES_LIMITS, type FileEntry, type PortalFileTicket } from "@herdr-pocket/protocol";
import { FilesError, inside, isPrivateName, resolveInside, type FilesOptions } from "../files.ts";

const CAP_TTL_MS = 30 * 60_000;
const CAP_MAX = 256;
const CHUNK_MAX_BYTES = 2 * 1024 * 1024;
const BUNDLE_HTML_MAX_TOTAL = 4 * 1024 * 1024;

export const PORTAL_MIME_MAP: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  cjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  pdf: "application/pdf",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
  weba: "audio/webm",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
};

export function mimeForFilename(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return PORTAL_MIME_MAP[ext] ?? "application/octet-stream";
}

interface CapEntry {
  token: string;
  capRoot: string;
  entryPath: string;
  isDir: boolean;
  mime: string;
  size: number;
  privateDirs: string[];
  expiresAt: number;
}

function parseRangeHeader(header: string, total: number): { start: number; end: number } | "invalid" | null {
  const spec = header.trim().replace(/^bytes=/i, "");
  if (!header.trim().toLowerCase().startsWith("bytes=") || spec.includes(",") || total <= 0) {
    return header.trim() ? "invalid" : null;
  }
  const dash = spec.indexOf("-");
  if (dash < 0) return "invalid";
  const a = spec.slice(0, dash).trim();
  const b = spec.slice(dash + 1).trim();
  if (!a) {
    const suffix = Number(b);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, total - Math.floor(suffix)), end: total - 1 };
  }
  const start = Number(a);
  if (!Number.isFinite(start) || start < 0 || start >= total) return "invalid";
  const parsedEnd = b ? Number(b) : Math.min(total - 1, Math.floor(start) + 8 * 1024 * 1024 - 1);
  if (!Number.isFinite(parsedEnd) || parsedEnd < start) return "invalid";
  return { start: Math.floor(start), end: Math.min(total - 1, Math.floor(parsedEnd)) };
}

function sendCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type",
  );
}

export class PortalFileTicketStore {
  private caps = new Map<string, CapEntry>();
  private now: () => number;

  constructor(now = Date.now) {
    this.now = now;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.caps) {
      if (v.expiresAt <= t) this.caps.delete(k);
    }
    while (this.caps.size >= CAP_MAX) {
      const oldest = this.caps.keys().next().value;
      if (!oldest) break;
      this.caps.delete(oldest);
    }
  }

  async issueTicket(opts: {
    agentCwd?: string;
    path: string;
    filesOpts: FilesOptions;
    port: number | null;
    addrs: string[];
  }): Promise<PortalFileTicket & { absPath: string }> {
    const resolved = await resolveInside(opts.agentCwd, opts.path, opts.filesOpts);
    const st = await stat(resolved.real);
    const isDir = st.isDirectory();
    const capRoot = isDir ? resolved.real : dirname(resolved.real);
    const entryPath = isDir ? "" : basename(resolved.real);
    const mime = isDir ? "inode/directory" : mimeForFilename(resolved.real);
    const size = isDir ? 0 : st.size;

    const realPrivates = await Promise.all(
      (opts.filesOpts.privateDirs ?? []).map((dir) => realpath(dir).catch(() => dir)),
    );

    this.prune();
    const token = randomBytes(24).toString("hex");
    const expiresAt = this.now() + CAP_TTL_MS;
    this.caps.set(token, {
      token,
      capRoot,
      entryPath,
      isDir,
      mime,
      size,
      privateDirs: realPrivates,
      expiresAt,
    });

    return {
      token,
      entryPath,
      port: opts.port,
      addrs: opts.addrs,
      expiresAt,
      mime,
      size,
      isDir,
      absPath: resolved.real,
    };
  }

  async resolveCapAsset(token: string, rawRelPath: string): Promise<{ filePath: string; size: number; mime: string }> {
    this.prune();
    const cap = this.caps.get(token);
    if (!cap || cap.expiresAt <= this.now()) {
      throw new FilesError("not_found", "预览票据不存在或已过期");
    }
    cap.expiresAt = this.now() + CAP_TTL_MS;

    let decoded = rawRelPath;
    try {
      decoded = decodeURIComponent(rawRelPath);
    } catch {
      throw new FilesError("bad_request", "路径编码无效");
    }
    if (!decoded && !cap.isDir && cap.entryPath) decoded = cap.entryPath;
    const cleanRel = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleanRel || cleanRel.includes("\0") || cleanRel.length > 4096) {
      throw new FilesError("bad_request", "非法路径");
    }
    const parts = cleanRel.split("/").filter((p) => p && p !== ".");
    if (parts.includes("..")) {
      throw new FilesError("forbidden", "禁止访问目录之外的文件");
    }
    if (parts.some(isPrivateName)) {
      throw new FilesError("forbidden", "禁止读取可能包含密钥的私有文件");
    }

    const candidate = join(cap.capRoot, ...parts);
    let realFile: string;
    try {
      realFile = await realpath(candidate);
    } catch {
      throw new FilesError("not_found", "文件不存在");
    }
    if (!inside(cap.capRoot, realFile)) {
      throw new FilesError("forbidden", "禁止越界读取目录外符号链接");
    }
    const realParts = relative(cap.capRoot, realFile).split(sep).filter(Boolean);
    if (realParts.some(isPrivateName) || isPrivateName(basename(realFile))) {
      throw new FilesError("forbidden", "禁止读取可能包含密钥的私有文件");
    }
    for (const priv of cap.privateDirs) {
      if (inside(priv, realFile)) {
        throw new FilesError("forbidden", "禁止读取后台设置目录");
      }
    }
    const st = await stat(realFile).catch(() => null);
    if (!st || !st.isFile()) {
      throw new FilesError("not_found", "不是普通文件");
    }
    return {
      filePath: realFile,
      size: st.size,
      mime: mimeForFilename(realFile),
    };
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, "http://127.0.0.1");
    if (!parsed.pathname.startsWith(`${DIRECT_PORTAL_FS_PREFIX}/`)) {
      return false;
    }

    sendCorsHeaders(res);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.end();
      return true;
    }

    const rest = parsed.pathname.slice(DIRECT_PORTAL_FS_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    const token = slash >= 0 ? rest.slice(0, slash) : rest;
    const relPath = slash >= 0 ? rest.slice(slash + 1) : "";
    if (!token) {
      res.statusCode = 404;
      res.end();
      return true;
    }

    let asset: { filePath: string; size: number; mime: string };
    try {
      asset = await this.resolveCapAsset(token, relPath);
    } catch (e) {
      const code = e instanceof FilesError ? e.code : "not_found";
      res.statusCode = code === "forbidden" ? 403 : code === "bad_request" ? 400 : 404;
      res.setHeader("Cache-Control", "no-store");
      res.end();
      return true;
    }

    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, asset.size);
      if (range === "invalid") {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${asset.size}`);
        res.end();
        return true;
      }
      if (range) {
        const len = range.end - range.start + 1;
        res.statusCode = 206;
        res.setHeader("Content-Type", asset.mime);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${asset.size}`);
        res.setHeader("Content-Length", String(len));
        res.setHeader("Cache-Control", "private, max-age=30");
        if (req.method === "HEAD") {
          res.end();
          return true;
        }
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(asset.filePath, { start: range.start, end: range.end });
          stream.on("error", reject);
          res.on("close", () => stream.destroy());
          stream.pipe(res).on("finish", resolve);
        }).catch(() => {
          if (!res.writableEnded) res.destroy();
        });
        return true;
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", asset.mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(asset.size));
    res.setHeader("Cache-Control", "private, max-age=30");
    if (req.method === "HEAD" || asset.size === 0) {
      res.end();
      return true;
    }
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(asset.filePath);
      stream.on("error", reject);
      res.on("close", () => stream.destroy());
      stream.pipe(res).on("finish", resolve);
    }).catch(() => {
      if (!res.writableEnded) res.destroy();
    });
    return true;
  }
}

export async function readChunkForRpc(
  agentCwd: string | undefined,
  p: { path: string; cwd?: string; offset?: number; length?: number },
  filesOpts: FilesOptions,
): Promise<{ path: string; size: number; mtime: number; offset: number; bytes: number; eof: boolean; mime: string; base64: string }> {
  const root = p.cwd?.trim() || agentCwd;
  const resolved = await resolveInside(root, p.path, filesOpts);
  const st = await stat(resolved.real);
  if (!st.isFile()) throw new FilesError("bad_request", "只能分片读取普通文件");
  const size = st.size;
  const offset = Math.min(size, Math.max(0, Math.floor(Number(p.offset ?? 0) || 0)));
  const length = Math.min(CHUNK_MAX_BYTES, Math.max(1, Math.floor(Number(p.length ?? CHUNK_MAX_BYTES) || CHUNK_MAX_BYTES)));
  const want = Math.max(0, Math.min(length, size - offset));
  let got = 0;
  const buf = Buffer.alloc(want);
  if (want > 0) {
    const fh = await open(resolved.real, "r");
    try {
      got = (await fh.read(buf, 0, want, offset)).bytesRead;
    } finally {
      await fh.close();
    }
  }
  return {
    path: resolved.rel,
    size,
    mtime: Math.round(st.mtimeMs),
    offset,
    bytes: got,
    eof: offset + got >= size,
    mime: mimeForFilename(resolved.real),
    base64: buf.subarray(0, got).toString("base64"),
  };
}

function escapeScriptClose(js: string): string {
  return js.replace(/<\/script>/gi, "<\\/script>");
}

export async function bundleHtmlForRelay(
  agentCwd: string | undefined,
  p: { path: string; cwd?: string },
  filesOpts: FilesOptions,
): Promise<{ html: string; title: string }> {
  const root = p.cwd?.trim() || agentCwd;
  const resolved = await resolveInside(root, p.path, filesOpts);
  const st = await stat(resolved.real);
  if (!st.isFile()) throw new FilesError("bad_request", "目标不是 HTML 文件");
  const baseDir = dirname(resolved.real);
  const realPrivates = await Promise.all((filesOpts.privateDirs ?? []).map((dir) => realpath(dir).catch(() => dir)));
  let html = await readFile(resolved.real, "utf8");
  let budget = BUNDLE_HTML_MAX_TOTAL - Buffer.byteLength(html, "utf8");

  const resolveSibling = async (rawRef: string): Promise<{ real: string; mime: string; bytes: Buffer } | null> => {
    const clean = rawRef.split("#")[0]?.split("?")[0]?.trim() ?? "";
    if (!clean || /^(?:https?:|data:|blob:|mailto:|javascript:|\/\/)/i.test(clean)) return null;
    if (clean.startsWith("/") && !clean.startsWith("./")) return null;
    const candidate = join(baseDir, clean);
    const real = await realpath(candidate).catch(() => null);
    if (!real || !inside(baseDir, real)) return null;
    const parts = relative(baseDir, real).split(sep).filter(Boolean);
    if (parts.some(isPrivateName) || isPrivateName(basename(real))) return null;
    if (realPrivates.some((d) => inside(d, real))) return null;
    const s = await stat(real).catch(() => null);
    if (!s || !s.isFile() || s.size > budget || s.size > 1024 * 1024) return null;
    const bytes = await readFile(real);
    budget -= bytes.length;
    return { real, mime: mimeForFilename(real), bytes };
  };

  // Inline local <link rel="stylesheet" href="...">
  const linkRe = /<link\b([^>]*?)\bhref=(["'])([^"']+)\2([^>]*)>/gi;
  const links = [...html.matchAll(linkRe)];
  for (const m of links) {
    if (!/rel=(["'])stylesheet\1/i.test(m[0])) continue;
    const hit = await resolveSibling(m[3]!);
    if (!hit) continue;
    html = html.replace(m[0], `<style>${hit.bytes.toString("utf8")}</style>`);
  }

  // Inline local classic <script src="..."></script>
  const scriptRe = /<script\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi;
  const scripts = [...html.matchAll(scriptRe)];
  for (const m of scripts) {
    if (/\btype=(["'])module\1/i.test(m[0])) continue;
    const hit = await resolveSibling(m[3]!);
    if (!hit) continue;
    html = html.replace(m[0], `<script${m[1]}${m[4]}>${escapeScriptClose(hit.bytes.toString("utf8"))}</script>`);
  }

  // Inline small local <img src="...">
  const imgRe = /(<img\b[^>]*?\bsrc=)(["'])([^"']+)\2/gi;
  const imgs = [...html.matchAll(imgRe)];
  for (const m of imgs) {
    const hit = await resolveSibling(m[3]!);
    if (!hit) continue;
    const b64 = hit.bytes.toString("base64");
    html = html.replace(m[0], `${m[1]}"data:${hit.mime};base64,${b64}"`);
  }

  const titleMatch = /<title>([^<]+)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.trim() || basename(resolved.real);
  return { html, title };
}

export async function listDirectoryForPortal(opts: {
  dirPath: string;
  agentCwd?: string;
  allowedParentDir?: string;
  highlightName?: string;
  hidden?: boolean;
  filesOpts: FilesOptions;
}): Promise<{ dirPath: string; parentDir: string | null; highlightName?: string; entries: FileEntry[]; truncated: boolean }> {
  const home = await realpath(homedir()).catch(() => homedir());
  const raw = opts.dirPath === "~" ? home : opts.dirPath.startsWith("~/") ? join(home, opts.dirPath.slice(2)) : opts.dirPath;
  const extraRoots = [...(opts.filesOpts.extraRoots ?? []), home];
  if (opts.allowedParentDir) extraRoots.push(opts.allowedParentDir);
  const resolved = await resolveInside(opts.agentCwd, raw, {
    ...opts.filesOpts,
    extraRoots,
  });

  const st = await stat(resolved.real);
  if (!st.isDirectory()) throw new FilesError("bad_request", "目标不是目录");

  const dirents = await readdir(resolved.real, { withFileTypes: true });
  const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
  const visible = dirents
    .filter((d) => (d.isFile() || d.isDirectory() || d.isSymbolicLink()) && (opts.hidden || !d.name.startsWith(".")))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || byName(a.name, b.name));

  const limit = FILES_LIMITS.list;
  const entries: FileEntry[] = [];
  for (const d of visible.slice(0, limit)) {
    const full = join(resolved.real, d.name);
    const e: FileEntry = {
      name: d.name,
      path: full,
      kind: d.isDirectory() ? "dir" : "file",
    };
    if (d.name.startsWith(".")) e.hidden = true;
    if (isPrivateName(d.name)) e.private = true;
    try {
      const s = await stat(full);
      e.kind = s.isDirectory() ? "dir" : "file";
      if (e.kind === "file") e.size = s.size;
      e.mtime = Math.round(s.mtimeMs);
    } catch {
      // keep minimal metadata
    }
    entries.push(e);
  }

  const up = dirname(resolved.real);
  const parentDir = up && up !== resolved.real ? up : null;
  return {
    dirPath: resolved.real,
    parentDir,
    ...(opts.highlightName ? { highlightName: opts.highlightName } : {}),
    entries,
    truncated: visible.length > limit,
  };
}
