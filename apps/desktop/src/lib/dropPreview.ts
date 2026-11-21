import type { PutFile } from "@herdr-pocket/protocol";

export type DropKind = "image" | "video" | "audio" | "pdf" | "document" | "text" | "archive" | "file";

export const KIND_TEXT_ZH: Readonly<Record<DropKind, string>> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
  document: "文档",
  text: "文本",
  archive: "压缩包",
  file: "文件",
};

const RASTER_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const LOSSLESS_RASTER_LIMIT = Math.floor(1.5 * 1024 * 1024);

const KIND_BY_EXTENSION: Readonly<Record<string, DropKind>> = {
  png: "image", jpg: "image", jpeg: "image", jfif: "image", webp: "image", gif: "image",
  svg: "image", avif: "image", heic: "image", heif: "image", bmp: "image", ico: "image",
  tif: "image", tiff: "image",

  mp4: "video", webm: "video", mov: "video", m4v: "video", mkv: "video", avi: "video",
  ogv: "video", mpg: "video", mpeg: "video",

  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
  oga: "audio", opus: "audio", aiff: "audio", wma: "audio",

  pdf: "pdf",

  doc: "document", docx: "document", ppt: "document", pptx: "document",
  xls: "document", xlsx: "document", odt: "document", ods: "document", odp: "document",
  rtf: "document", pages: "document", numbers: "document", key: "document", epub: "document",

  md: "text", markdown: "text", mdx: "text", txt: "text", log: "text", csv: "text",
  tsv: "text", json: "text", jsonl: "text", yaml: "text", yml: "text", toml: "text",
  ini: "text", conf: "text", env: "text", xml: "text", html: "text", htm: "text",
  css: "text", scss: "text", less: "text", js: "text", mjs: "text", cjs: "text",
  jsx: "text", ts: "text", tsx: "text", vue: "text", svelte: "text", py: "text",
  rb: "text", go: "text", rs: "text", java: "text", kt: "text", swift: "text",
  c: "text", h: "text", cc: "text", cpp: "text", hpp: "text", cs: "text", php: "text",
  sh: "text", bash: "text", zsh: "text", fish: "text", sql: "text", graphql: "text",
  lua: "text", r: "text", pl: "text", patch: "text", diff: "text",

  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive",
  xz: "archive", rar: "archive", "7z": "archive", zst: "archive",
};

const KIND_BY_TYPE: Readonly<Record<string, DropKind>> = {
  "application/pdf": "pdf",
  "application/json": "text",
  "application/xml": "text",
  "application/zip": "archive",
  "application/gzip": "archive",
  "application/x-tar": "archive",
};

const KIND_BY_TYPE_PREFIX: readonly (readonly [string, DropKind])[] = [
  ["image/", "image"],
  ["video/", "video"],
  ["audio/", "audio"],
  ["text/", "text"],
];

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
  webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif",
  heic: "image/heic", heif: "image/heif", bmp: "image/bmp", ico: "image/x-icon",
  tif: "image/tiff", tiff: "image/tiff",

  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mkv: "video/x-matroska", ogv: "video/ogg", mpg: "video/mpeg", mpeg: "video/mpeg",

  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  aiff: "audio/aiff",

  pdf: "application/pdf",
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", log: "text/plain",
  csv: "text/csv", json: "application/json", yaml: "text/yaml", yml: "text/yaml",
};

export function extensionOf(name: string): string {
  const cut = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = cut < 0 ? name : name.slice(cut + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function dropKindOf(name: string, mediaType = ""): DropKind {
  const extension = extensionOf(name);
  if (extension !== "" && Object.hasOwn(KIND_BY_EXTENSION, extension)) return KIND_BY_EXTENSION[extension]!;
  const type = mediaType.split(";")[0]!.trim().toLowerCase();
  if (Object.hasOwn(KIND_BY_TYPE, type)) return KIND_BY_TYPE[type]!;
  for (const [prefix, kind] of KIND_BY_TYPE_PREFIX) {
    if (type.startsWith(prefix)) return kind;
  }
  return "file";
}

export function mediaTypeFor(name: string, declared = ""): string {
  if (dropKindOf(name, declared) === "pdf") return "application/pdf";
  const clean = declared.split(";")[0]!.trim().toLowerCase();
  if (clean !== "") return clean;
  const extension = extensionOf(name);
  return extension !== "" && Object.hasOwn(MIME_BY_EXTENSION, extension)
    ? MIME_BY_EXTENSION[extension]!
    : "";
}

export function kindBadge(name: string): string {
  const extension = extensionOf(name);
  return extension.length === 0 || extension.length > 5 ? "" : extension.toUpperCase();
}

export function formatDropBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function looksBinary(sample: string): boolean {
  return sample.includes("\u0000") || sample.includes("\uFFFD");
}

export interface StagedAttachment {
  id: string;
  sig: string;
  name: string;
  mime: string;
  size: number;
  kind: DropKind;
  put: PutFile;
  file: File;
  previewUrl?: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function encodeRasterToJpeg(file: File, maxSide = 1280): Promise<{ put: PutFile; size: number }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`无法解析图片 ${file.name}`));
    el.src = dataUrl;
  });
  const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
  const w = Math.max(1, Math.round((img.width || 1) * scale));
  const h = Math.max(1, Math.round((img.height || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`无法处理图片 ${file.name}`);
  ctx.drawImage(img, 0, 0, w, h);
  const jpegUrl = canvas.toDataURL("image/jpeg", 0.84);
  const data = jpegUrl.split(",")[1] ?? "";
  if (!data) throw new Error(`转换图片 ${file.name} 失败`);
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  const bytes = Math.floor((data.length * 3) / 4);
  return { put: { name: `${baseName}.jpg`, mime: "image/jpeg", data }, size: bytes };
}

function needsObjectUrl(kind: DropKind): boolean {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf";
}

function fileSignature(f: File): string {
  return `${f.name}\0${f.size}\0${f.lastModified}`;
}

function approxDecodedBytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

let seq = 0;

/**
 * Validates, deduplicates and encodes dropped/pasted files into {@link StagedAttachment}s.
 * Keeps raster PNG/JPEG/WebP/GIF lossless up to 1.5 MB, downscales larger or exotic images,
 * and encodes media/documents/text up to `maxFileBytes` and `maxTotalBytes`.
 */
export async function prepareDroppedFiles(
  existing: readonly StagedAttachment[],
  incoming: readonly File[],
  maxFiles: number,
  maxFileBytes: number,
  maxTotalBytes: number,
): Promise<{ added: StagedAttachment[]; notice?: string }> {
  const seen = new Set(existing.map((a) => a.sig));
  let total = existing.reduce((sum, a) => sum + approxDecodedBytes(a.put.data), 0);
  const added: StagedAttachment[] = [];
  let notice: string | undefined;

  for (const file of incoming) {
    if (existing.length + added.length >= maxFiles) {
      notice = `一次最多附带 ${maxFiles} 个文件`;
      break;
    }
    const sig = fileSignature(file);
    if (seen.has(sig)) continue;
    seen.add(sig);

    if (file.size === 0) {
      notice = `已跳过空文件「${file.name}」`;
      continue;
    }

    const mime = mediaTypeFor(file.name, file.type);
    const kind = dropKindOf(file.name, mime);
    const name = file.name || "attachment";

    let put: PutFile;
    let encodedBytes: number;
    if (kind === "image" && mime !== "image/svg+xml" && (!RASTER_MIMES.has(mime) || file.size > LOSSLESS_RASTER_LIMIT)) {
      const encoded = await encodeRasterToJpeg(file);
      put = encoded.put;
      encodedBytes = encoded.size;
      if (encodedBytes > maxFileBytes) {
        notice = `「${name}」压缩后仍超过 ${Math.floor(maxFileBytes / 1024 / 1024)} MB 上限`;
        continue;
      }
    } else {
      if (file.size > maxFileBytes) {
        notice = `「${name}」超过 ${Math.floor(maxFileBytes / 1024 / 1024)} MB 上限`;
        continue;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      put = { name, mime: mime || "application/octet-stream", data: bytesToBase64(buf) };
      encodedBytes = buf.byteLength;
    }

    if (total + encodedBytes > maxTotalBytes) {
      notice = `附件总大小一次最多 ${Math.floor(maxTotalBytes / 1024 / 1024)} MB`;
      break;
    }
    total += encodedBytes;

    let previewUrl: string | undefined;
    if (needsObjectUrl(kind)) {
      const blob = kind === "pdf" && file.type !== "application/pdf"
        ? new Blob([file], { type: "application/pdf" })
        : file;
      previewUrl = URL.createObjectURL(blob);
    }

    added.push({
      id: `att-${++seq}`,
      sig,
      name,
      mime: put.mime,
      size: file.size,
      kind,
      put,
      file,
      previewUrl,
    });
  }

  return { added, notice };
}

export function revokeAttachment(item: StagedAttachment): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}
