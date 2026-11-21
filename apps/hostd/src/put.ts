import { mkdir, mkdtemp, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUT_LIMITS } from "@herdr-pocket/protocol";
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
