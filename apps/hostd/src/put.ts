import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECT_PUT_PREFIX, LARGE_PUT_LIMITS, PUT_LIMITS } from "@herdr-pocket/protocol";
import { stateDir } from "./platform.ts";

/** A file or picture from a client, checked: safe name, real bytes for raster images. */
export interface CheckedFile {
  name: string;
  mime: string;
  bytes: Buffer;
}

const RASTER_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const FALLBACK_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "image/svg+xml": "svg",
  "application/zip": "zip",
};

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** First bytes of each checked raster image type: the name and the stated type are not trusted. */
function looksLike(mime: string, b: Buffer): boolean {
  switch (mime) {
    case "image/jpeg":
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png":
      return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/gif":
      return b.length > 6 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a");
    case "image/webp":
      return b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
    default:
      return false;
  }
}

/**
 * A name that is safe on disk and in a typed message: ASCII letters, digits,
 * `.`, `_`, `-`, at most 60 characters plus extension.
 */
export function safeName(name: unknown, mime: string, index: number): string {
  const base = typeof name === "string" ? (name.split(/[\\/]/).pop() ?? "") : "";
  const rasterExt = RASTER_EXT[mime];
  const rawExt = /\.([A-Za-z0-9]{1,10})$/.exec(base)?.[1]?.toLowerCase();
  const ext = rasterExt ?? rawExt ?? FALLBACK_EXT[mime] ?? "bin";
  const stem = base
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 55);
  const fallbackStem = rasterExt ? `image-${index + 1}` : `file-${index + 1}`;
  return `${/[A-Za-z0-9]/.test(stem) ? stem : fallbackStem}.${ext}`;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Checks what a client sent for `terminal.put`: one to `PUT_LIMITS.files`
 * files within the size limits. Raster images have their magic bytes checked;
 * all other valid MIME types preserve safe extensions. Throws a message for people.
 */
export function checkFiles(files: unknown): CheckedFile[] {
  if (!Array.isArray(files) || !files.length) throw new Error("没有收到文件");
  if (files.length > PUT_LIMITS.files) throw new Error(`一次最多发 ${PUT_LIMITS.files} 个文件`);
  const out: CheckedFile[] = [];
  const names = new Set<string>();
  let total = 0;
  files.forEach((f, i) => {
    const file = (f && typeof f === "object" ? f : {}) as { name?: unknown; mime?: unknown; data?: unknown };
    const rawMime = typeof file.mime === "string" ? file.mime.split(";")[0]!.trim().toLowerCase() : "";
    const mime = rawMime || "application/octet-stream";
    if (!MIME_RE.test(mime)) throw new Error(`第 ${i + 1} 个文件的类型格式不对`);
    const isRaster = (PUT_LIMITS.mimes as readonly string[]).includes(mime);
    const data = typeof file.data === "string" ? file.data : "";
    // Base64 is a third larger than what it carries: anything longer is over the limit already.
    if (!data || data.length % 4 !== 0 || data.length > Math.ceil(PUT_LIMITS.fileBytes / 3) * 4 || !BASE64.test(data)) {
      throw new Error(data.length > Math.ceil(PUT_LIMITS.fileBytes / 3) * 4 ? `第 ${i + 1} 个文件太大了` : `第 ${i + 1} 个文件的内容不对`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > PUT_LIMITS.fileBytes) throw new Error(`第 ${i + 1} 个文件太大了`);
    if (isRaster && !looksLike(mime, bytes)) throw new Error(`第 ${i + 1} 张图片的内容和类型对不上`);
    total += bytes.length;
    if (total > PUT_LIMITS.totalBytes) throw new Error(`文件加起来太大了，一次最多 ${Math.floor(PUT_LIMITS.totalBytes / 1024 / 1024)} MB`);
    const first = safeName(file.name, mime, i);
    let name = first;
    for (let n = 2; names.has(name); n++) name = first.replace(/(\.[a-z0-9]+)$/, `-${n}$1`);
    names.add(name);
    out.push({ name, mime, bytes });
  });
  return out;
}

/**
 * Hands each file to `put` (e.g. `hc put`, which keeps its own copy beside the
 * terminal) from a private temporary folder that is removed afterwards.
 * Returns where each file landed, in order.
 */
export async function putThrough(files: CheckedFile[], put: (file: string) => Promise<string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-pocket-put-"));
  try {
    const paths: string[] = [];
    for (const f of files) {
      const file = join(dir, f.name);
      await writeFile(file, f.bytes, { mode: 0o600, flag: "wx" });
      paths.push(await put(file));
    }
    return paths;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Where pictures for agents of the herdr terminal app are kept (it has no `hc put`). */
export const FILES_DIR = process.env.HERDR_POCKET_FILES ?? join(stateDir(), "files");

/** Kept files older than this are removed the next time a picture arrives. */
export const KEEP_MS = 7 * 24 * 3600_000;

/**
 * Writes the files into `<root>/<terminal>/` (owner-only folders and files),
 * never over an existing file, and returns their paths. Pictures older than
 * `KEEP_MS` anywhere under `root` are removed first.
 */
export async function putLocal(files: CheckedFile[], terminal: string, root = FILES_DIR, now = Date.now()): Promise<string[]> {
  await pruneOld(root, now - KEEP_MS);
  const dir = join(root, terminal.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_") || "_");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const f of files) {
    const dot = f.name.lastIndexOf(".");
    for (let n = 1; ; n++) {
      const file = join(dir, n === 1 ? f.name : `${f.name.slice(0, dot)}-${n}${f.name.slice(dot)}`);
      try {
        await writeFile(file, f.bytes, { mode: 0o600, flag: "wx" });
        paths.push(file);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 999) throw e;
      }
    }
  }
  return paths;
}

async function pruneOld(root: string, before: number): Promise<void> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return;
  }
  for (const d of dirs) {
    const dir = join(root, d);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const file = join(dir, n);
      try {
        const s = await stat(file);
        if (s.isFile() && s.mtimeMs < before) await rm(file, { force: true });
      } catch {
        /* gone already */
      }
    }
    // Only an empty folder goes: a picture written there meanwhile keeps it.
    await rmdir(dir).catch(() => undefined);
  }
}

interface ChunkUploadSession {
  uploadId: string;
  directToken: string;
  agentKey: string;
  source: "hc" | "herdr";
  localId: string;
  name: string;
  mime: string;
  totalBytes: number;
  chunkBytes: number;
  dir: string;
  partPath: string;
  receivedBytes: number;
  lastAt: number;
}

const CHUNK_UPLOAD_IDLE_MS = 5 * 60_000;

async function moveFileAcrossFs(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(src, dst);
    await rm(src, { force: true });
  }
}

/**
 * Manages large non-image file uploads (`> 5 MB`, up to `1 GiB`) over either direct P2P HTTP
 * (`POST /v1/direct-put/<token>`) or sequential relay chunks (`terminal.putChunk`).
 */
export class ChunkedPutManager {
  private sessions = new Map<string, ChunkUploadSession>();
  private byToken = new Map<string, ChunkUploadSession>();
  private sweeper: NodeJS.Timeout;
  private opts: {
    filesDir: () => string;
    putThroughHc: (localId: string, file: string) => Promise<string>;
  };

  constructor(opts: {
    filesDir: () => string;
    putThroughHc: (localId: string, file: string) => Promise<string>;
  }) {
    this.opts = opts;
    this.sweeper = setInterval(() => {
      const cutoff = Date.now() - CHUNK_UPLOAD_IDLE_MS;
      for (const s of [...this.sessions.values()]) {
        if (s.lastAt < cutoff) {
          void this.abort(s.uploadId).catch(() => {});
        }
      }
    }, 60_000);
    this.sweeper.unref?.();
  }

  async begin(params: {
    agentKey: string;
    source: "hc" | "herdr";
    localId: string;
    name: string;
    mime?: string;
    totalBytes: number;
  }): Promise<{ uploadId: string; chunkBytes: number; directToken: string }> {
    const totalBytes = Number(params.totalBytes);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 || totalBytes > LARGE_PUT_LIMITS.maxFileBytes) {
      throw new Error(`文件大小超出支持范围（最大 ${Math.floor(LARGE_PUT_LIMITS.maxFileBytes / 1024 / 1024)} MB）`);
    }
    const rawMime = typeof params.mime === "string" ? params.mime.split(";")[0]!.trim().toLowerCase() : "";
    const mime = rawMime && MIME_RE.test(rawMime) ? rawMime : "application/octet-stream";
    const cleanName = safeName(params.name, mime, 0);
    const dir = await mkdtemp(join(tmpdir(), "herdr-pocket-chunk-"));
    const partPath = join(dir, cleanName);
    await writeFile(partPath, Buffer.alloc(0), { mode: 0o600 });

    const uploadId = randomUUID();
    const directToken = randomBytes(24).toString("hex");
    const session: ChunkUploadSession = {
      uploadId,
      directToken,
      agentKey: params.agentKey,
      source: params.source,
      localId: params.localId,
      name: cleanName,
      mime,
      totalBytes,
      chunkBytes: LARGE_PUT_LIMITS.chunkBytes,
      dir,
      partPath,
      receivedBytes: 0,
      lastAt: Date.now(),
    };
    this.sessions.set(uploadId, session);
    this.byToken.set(directToken, session);
    return { uploadId, chunkBytes: session.chunkBytes, directToken };
  }

  async writeChunk(uploadId: string, index: number, dataB64: string): Promise<{ receivedBytes: number }> {
    const session = this.sessions.get(uploadId);
    if (!session) throw new Error("上传会话不存在或已过期");
    if (!Number.isInteger(index) || index < 0) throw new Error("无效的分片序号");
    if (typeof dataB64 !== "string" || !dataB64 || dataB64.length % 4 !== 0 || !BASE64.test(dataB64)) {
      throw new Error("分片内容格式无效");
    }
    const maxChunkB64 = Math.ceil((session.chunkBytes + 64 * 1024) / 3) * 4;
    if (dataB64.length > maxChunkB64) throw new Error("单个分片超过大小上限");
    const buf = Buffer.from(dataB64, "base64");
    const offset = index * session.chunkBytes;
    if (offset + buf.length > session.totalBytes + 4096) {
      throw new Error("上传数据超出声明大小");
    }
    const fh = await open(session.partPath, "r+");
    try {
      await fh.write(buf, 0, buf.length, offset);
    } finally {
      await fh.close();
    }
    session.receivedBytes = Math.max(session.receivedBytes, offset + buf.length);
    session.lastAt = Date.now();
    return { receivedBytes: session.receivedBytes };
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? "/";
    let pathname = "/";
    try {
      pathname = new URL(rawUrl, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(`${DIRECT_PUT_PREFIX}/`)) return false;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Cache-Control": "no-store",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return true;
    }

    const token = decodeURIComponent(pathname.slice(DIRECT_PUT_PREFIX.length + 1).split("/")[0] ?? "");
    const session = token ? this.byToken.get(token) : undefined;
    if (!session) {
      res.writeHead(404, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "upload session not found" }));
      return true;
    }

    const ws = createWriteStream(session.partPath, { flags: "w", mode: 0o600 });
    let written = 0;
    let aborted = false;

    await new Promise<void>((resolve) => {
      const fail = (status: number, msg: string) => {
        if (aborted) return;
        aborted = true;
        ws.destroy();
        if (!res.headersSent) {
          res.writeHead(status, { ...cors, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        resolve();
      };

      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        written += chunk.length;
        session.lastAt = Date.now();
        if (written > session.totalBytes + 4096 || written > LARGE_PUT_LIMITS.maxFileBytes) {
          fail(413, "payload exceeds declared size");
          return;
        }
        if (!ws.write(chunk)) {
          req.pause();
          ws.once("drain", () => req.resume());
        }
      });
      req.on("end", () => {
        if (!aborted) ws.end();
      });
      req.on("aborted", () => fail(499, "client aborted"));
      req.on("error", (err) => fail(400, err.message));
      ws.on("error", (err) => fail(500, err.message));
      ws.on("finish", () => {
        if (aborted) return;
        session.receivedBytes = written;
        session.lastAt = Date.now();
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ receivedBytes: written }));
        resolve();
      });
    });

    return true;
  }

  async finish(uploadId: string): Promise<{ path: string }> {
    const session = this.sessions.get(uploadId);
    if (!session) throw new Error("上传会话不存在或已过期");
    this.sessions.delete(uploadId);
    this.byToken.delete(session.directToken);
    try {
      const info = await stat(session.partPath).catch(() => null);
      if (!info || info.size === 0 || session.receivedBytes === 0) {
        throw new Error("未收到有效文件内容");
      }
      if (session.source === "hc") {
        const dest = await this.opts.putThroughHc(session.localId, session.partPath);
        return { path: dest };
      }
      const root = this.opts.filesDir();
      await pruneOld(root, Date.now() - KEEP_MS);
      const safeTerm = session.localId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_") || "_";
      const dir = join(root, safeTerm);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const dot = session.name.lastIndexOf(".");
      const stem = dot > 0 ? session.name.slice(0, dot) : session.name;
      const ext = dot > 0 ? session.name.slice(dot) : "";
      for (let n = 1; ; n++) {
        const dest = join(dir, n === 1 ? session.name : `${stem}-${n}${ext}`);
        try {
          const fh = await open(dest, "wx", 0o600);
          await fh.close();
          await moveFileAcrossFs(session.partPath, dest);
          return { path: dest };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 999) throw e;
        }
      }
    } finally {
      await rm(session.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async abort(uploadId: string): Promise<{ ok: true }> {
    const session = this.sessions.get(uploadId);
    if (!session) return { ok: true };
    this.sessions.delete(uploadId);
    this.byToken.delete(session.directToken);
    await rm(session.dir, { recursive: true, force: true }).catch(() => {});
    return { ok: true };
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) {
      void this.abort(id).catch(() => {});
    }
  }
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
