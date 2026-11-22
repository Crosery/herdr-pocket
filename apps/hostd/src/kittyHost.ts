import { lstatSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface KittyHostProcessResult {
  outBytes: Buffer;
  autoReplies: Buffer[];
}

interface ParsedKittyHeader {
  action?: string;
  format?: number;
  medium?: string;
  compression?: string;
  more: boolean;
  width?: number;
  height?: number;
  id?: number;
  imageNumber?: number;
  quiet: number;
  rawPairs: string[];
}

interface ActiveFileUpload {
  firstHeaderRaw: string;
  action: string;
  medium: string;
  format?: number;
  id?: number;
  imageNumber?: number;
  width?: number;
  height?: number;
  quiet: number;
  rawPairs: string[];
  rawChunks: Buffer[];
  payloadParts: Buffer[];
  totalBytes: number;
}

const MAX_SINGLE_APC_BYTES = 8 * 1024 * 1024;
const MAX_HOST_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_PATH_CHUNKS_BYTES = 64 * 1024;
const INLINE_CHUNK_B64_CHARS = 4096;

const BLOCKED_COMPONENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  "keychains",
  "herdr-pocket",
  "credentials",
  ".env",
  "id_rsa",
  "id_ed25519",
]);

function isUnderDir(candidate: string, dir: string): boolean {
  const cleanDir = dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return candidate === cleanDir || candidate.startsWith(`${cleanDir}/`) || candidate.startsWith(`${cleanDir}\\`);
}

function hasBlockedComponent(p: string): boolean {
  return p
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((seg) => BLOCKED_COMPONENTS.has(seg.toLowerCase()));
}

function tempRoots(): string[] {
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  try {
    roots.push(realpathSync(tmpdir()));
  } catch {
    /* ignore */
  }
  return [...new Set(roots)];
}

function isTempPath(rawPath: string): boolean {
  if (hasBlockedComponent(rawPath)) return false;
  const resolved = resolve(rawPath);
  const roots = tempRoots();
  if (roots.some((r) => isUnderDir(resolved, r))) return true;
  try {
    const canon = realpathSync(resolved);
    if (hasBlockedComponent(canon)) return false;
    return roots.some((r) => isUnderDir(canon, r));
  } catch {
    return false;
  }
}

function allowedImageRoots(): string[] {
  const roots = [homedir(), ...tempRoots()];
  try {
    roots.push(realpathSync(homedir()));
  } catch {
    /* ignore */
  }
  return [...new Set(roots)];
}

function validateHostImagePath(rawPath: string): string | null {
  const trimmed = rawPath.replace(/\0+$/, "").trim();
  if (!trimmed || !isAbsolute(trimmed) || hasBlockedComponent(trimmed)) return null;
  let canon: string;
  try {
    canon = realpathSync(trimmed);
  } catch {
    return null;
  }
  if (hasBlockedComponent(canon)) return null;
  if (!allowedImageRoots().some((r) => isUnderDir(canon, r))) return null;
  try {
    const st = statSync(canon);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_HOST_IMAGE_BYTES) return null;
  } catch {
    return null;
  }
  return canon;
}

function parseUint(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

function parseKittyHeader(rawHeader: string): ParsedKittyHeader {
  const parsed: ParsedKittyHeader = {
    more: false,
    quiet: 0,
    rawPairs: [],
  };
  if (!rawHeader) return parsed;
  for (const part of rawHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    parsed.rawPairs.push(part);
    switch (k) {
      case "a":
        parsed.action = v;
        break;
      case "f":
        parsed.format = parseUint(v);
        break;
      case "t":
        parsed.medium = v;
        break;
      case "o":
        parsed.compression = v;
        break;
      case "m":
        parsed.more = v === "1";
        break;
      case "s":
        parsed.width = parseUint(v);
        break;
      case "v":
        parsed.height = parseUint(v);
        break;
      case "i":
        parsed.id = parseUint(v);
        break;
      case "I":
        parsed.imageNumber = parseUint(v);
        break;
      case "q": {
        const q = parseUint(v);
        if (q !== undefined) parsed.quiet = q;
        break;
      }
    }
  }
  return parsed;
}

function sniffJpegDimensions(buf: Buffer): [number, number] {
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    while (i < buf.length && buf[i] === 0xff) i += 1;
    if (i >= buf.length) break;
    const marker = buf[i]!;
    i += 1;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (i + 7 <= buf.length) {
        return [buf.readUInt16BE(i + 5), buf.readUInt16BE(i + 3)];
      }
      break;
    }
    if (i + 2 <= buf.length) {
      const segLen = buf.readUInt16BE(i);
      if (segLen < 2) break;
      i += segLen;
    } else {
      break;
    }
  }
  return [0, 0];
}

function sniffImageDimensions(buf: Buffer): { mime: string; width: number; height: number } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    if (buf.length >= 24 && buf.subarray(12, 16).toString("ascii") === "IHDR") {
      return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    return { mime: "image/png", width: 0, height: 0 };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const [width, height] = sniffJpegDimensions(buf);
    return { mime: "image/jpeg", width, height };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { mime: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    if (buf.length >= 30 && buf.subarray(12, 16).toString("ascii") === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return {
        mime: "image/webp",
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (buf.length >= 25 && buf.subarray(12, 16).toString("ascii") === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (buf.length >= 30 && buf.subarray(12, 16).toString("ascii") === "VP8X") {
      const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { mime: "image/webp", width: w, height: h };
    }
    return { mime: "image/webp", width: 0, height: 0 };
  }
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const dibSize = buf.readUInt32LE(14);
    if (dibSize >= 40) {
      const width = Math.abs(buf.readInt32LE(18));
      const height = Math.abs(buf.readInt32LE(22));
      return { mime: "image/bmp", width, height };
    }
  }
  return null;
}

function kittyReply(id: number | undefined, imageNumber: number | undefined, status: string): Buffer | null {
  const parts: string[] = [];
  if (id !== undefined) parts.push(`i=${id}`);
  if (imageNumber !== undefined) parts.push(`I=${imageNumber}`);
  if (!parts.length) return null;
  return Buffer.from(`\x1b_G${parts.join(",")};${status}\x1b\\`, "utf8");
}

function rewriteHeaderQuiet2(rawHeader: string): string {
  const filtered = rawHeader.split(",").filter((p) => !p.startsWith("q=") && p.length > 0);
  filtered.push("q=2");
  return filtered.join(",");
}

function trailingUtf8Remaining(slice: Buffer): number {
  const n = slice.length;
  if (n === 0) return 0;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = slice[n - back]!;
    if ((b & 0x80) === 0) return 0;
    if ((b & 0xc0) === 0xc0) {
      const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
      return need > back ? need - back : 0;
    }
  }
  return 0;
}

function isUtf8ContinuationAt(chunk: Buffer, floor: number, pos: number, pendingOut: Buffer[]): boolean {
  if (pos > floor) {
    const prev = chunk[pos - 1]!;
    return prev >= 0xc2 && prev <= 0xf4;
  }
  for (let idx = pendingOut.length - 1; idx >= 0; idx--) {
    const b = pendingOut[idx]!;
    if (b.length > 0) {
      const last = b[b.length - 1]!;
      return last >= 0xc2 && last <= 0xf4;
    }
  }
  return false;
}

function inlineFileToDirectApcs(upload: ActiveFileUpload): { out: Buffer; ok: boolean } {
  const b64Path = Buffer.concat(upload.payloadParts).toString("utf8").replace(/\s+/g, "");
  let rawPath: string;
  try {
    rawPath = Buffer.from(b64Path, "base64").toString("utf8");
  } catch {
    return { out: Buffer.alloc(0), ok: false };
  }
  const canon = validateHostImagePath(rawPath);
  if (!canon) return { out: Buffer.alloc(0), ok: false };

  let fileBytes: Buffer;
  try {
    fileBytes = readFileSync(canon);
  } catch {
    return { out: Buffer.alloc(0), ok: false };
  }
  if (!fileBytes.length || fileBytes.length > MAX_HOST_IMAGE_BYTES) {
    return { out: Buffer.alloc(0), ok: false };
  }

  let width = upload.width ?? 0;
  let height = upload.height ?? 0;
  let outFmt = upload.format ?? 100;
  if (outFmt === 24 || outFmt === 32) {
    const expected = width > 0 && height > 0 ? width * height * (outFmt === 24 ? 3 : 4) : 0;
    if (expected <= 0 || fileBytes.length < expected) {
      return { out: Buffer.alloc(0), ok: false };
    }
  } else {
    const info = sniffImageDimensions(fileBytes);
    if (!info) return { out: Buffer.alloc(0), ok: false };
    outFmt = 100;
    if (info.width > 0) width = info.width;
    if (info.height > 0) height = info.height;
  }

  if (upload.medium === "t" && isTempPath(rawPath) && isTempPath(canon)) {
    try {
      const lst = lstatSync(rawPath);
      if (!lst.isSymbolicLink() && lst.isFile()) unlinkSync(rawPath);
    } catch {
      try {
        unlinkSync(canon);
      } catch {
        /* ignore cleanup failure */
      }
    }
  }

  const keptPairs = upload.rawPairs.filter((p) => {
    const k = p.slice(0, p.indexOf("="));
    return k !== "t" && k !== "f" && k !== "q" && k !== "m" && k !== "s" && k !== "v";
  });
  keptPairs.push("t=d", `f=${outFmt}`, "q=2");
  if (width > 0) keptPairs.push(`s=${width}`);
  if (height > 0) keptPairs.push(`v=${height}`);

  const b64 = fileBytes.toString("base64");
  const contPrefixParts: string[] = [];
  if (upload.action) contPrefixParts.push(`a=${upload.action}`);
  if (upload.id !== undefined) contPrefixParts.push(`i=${upload.id}`);
  if (upload.imageNumber !== undefined) contPrefixParts.push(`I=${upload.imageNumber}`);
  contPrefixParts.push("t=d", "q=2");

  const chunks: Buffer[] = [];
  for (let off = 0, idx = 0; off < b64.length || idx === 0; off += INLINE_CHUNK_B64_CHARS, idx++) {
    const slice = b64.slice(off, off + INLINE_CHUNK_B64_CHARS);
    const hasMore = off + INLINE_CHUNK_B64_CHARS < b64.length;
    const hdrParts = idx === 0 ? [...keptPairs] : [...contPrefixParts];
    if (hasMore) hdrParts.push("m=1");
    else if (idx > 0) hdrParts.push("m=0");
    chunks.push(Buffer.from(`\x1b_G${hdrParts.join(",")};${slice}\x1b\\`, "utf8"));
  }
  return { out: Buffer.concat(chunks), ok: true };
}

/**
 * Streaming host-side Kitty Graphics APC processor (`watchRaw` pipeline):
 * - Replies immediately on host to capability queries (`a=q`), rewriting `q=2` downstream.
 * - Securely inlines `t=f` / `t=t` host image files into `t=d` chunks so remote clients
 *   render logos like `fastfetch` without multi-second stdin stalls or missing images.
 * - Zero-copy fast path for normal PTY bytes containing no APC prefixes.
 */
export class KittyHostStream {
  private inApc = false;
  private apcPassthrough = false;
  private pendingPrefix = Buffer.alloc(0);
  private apcPrefix = Buffer.alloc(0);
  private apcChunks: Buffer[] = [];
  private apcLen = 0;
  private passthroughTail = Buffer.alloc(0);
  private utf8Rem = 0;
  private chunked: ActiveFileUpload | null = null;

  push(bytes: Buffer): KittyHostProcessResult {
    if (!bytes.length) return { outBytes: bytes, autoReplies: [] };

    // Fast path: plain PTY traffic with no open APC state and no ESC/APC introducer bytes.
    if (
      !this.inApc &&
      !this.pendingPrefix.length &&
      !this.chunked &&
      this.utf8Rem === 0 &&
      bytes.indexOf(0x1b) < 0 &&
      bytes.indexOf(0x9f) < 0 &&
      bytes.indexOf(0xc2) < 0
    ) {
      return { outBytes: bytes, autoReplies: [] };
    }

    const outParts: Buffer[] = [];
    const autoReplies: Buffer[] = [];
    let i = 0;

    if (!this.inApc && this.pendingPrefix.length > 0) {
      const take = Math.min(3, bytes.length);
      const joined = Buffer.concat([this.pendingPrefix, bytes.subarray(0, take)]);
      if (joined.subarray(0, 3).toString("latin1") === "\x1b_G") {
        const need = 3 - this.pendingPrefix.length;
        this.pendingPrefix = Buffer.alloc(0);
        this.inApc = true;
        this.apcPrefix = Buffer.from("\x1b_G", "latin1");
        this.apcChunks = [];
        this.apcLen = 0;
        this.apcPassthrough = false;
        i = need;
      } else if (joined[0] === 0x9f && joined[1] === 0x47) {
        const need = 2 - this.pendingPrefix.length;
        this.pendingPrefix = Buffer.alloc(0);
        this.inApc = true;
        this.apcPrefix = Buffer.from([0x9f, 0x47]);
        this.apcChunks = [];
        this.apcLen = 0;
        this.apcPassthrough = false;
        i = need;
      } else if (joined.length >= 3 && joined[0] === 0xc2 && joined[1] === 0x9f && joined[2] === 0x47) {
        const need = 3 - this.pendingPrefix.length;
        this.pendingPrefix = Buffer.alloc(0);
        this.inApc = true;
        this.apcPrefix = Buffer.from([0xc2, 0x9f, 0x47]);
        this.apcChunks = [];
        this.apcLen = 0;
        this.apcPassthrough = false;
        i = need;
      } else if (
        (joined.length === 2 && joined[0] === 0x1b && joined[1] === 0x5f) ||
        (joined.length === 2 && joined[0] === 0xc2 && joined[1] === 0x9f)
      ) {
        this.pendingPrefix = joined;
        return { outBytes: Buffer.alloc(0), autoReplies };
      } else {
        outParts.push(this.pendingPrefix);
        this.utf8Rem = trailingUtf8Remaining(this.pendingPrefix);
        this.pendingPrefix = Buffer.alloc(0);
      }
    }

    while (i < bytes.length) {
      if (this.inApc) {
        if (this.apcPassthrough) {
          if (this.passthroughTail.length === 1 && this.passthroughTail[0] === 0x1b && bytes[i] === 0x5c) {
            outParts.push(Buffer.from("\x1b\\", "latin1"));
            this.passthroughTail = Buffer.alloc(0);
            this.inApc = false;
            this.apcPassthrough = false;
            i += 1;
            continue;
          }
          if (this.passthroughTail.length === 1 && this.passthroughTail[0] === 0xc2 && bytes[i] === 0x9c) {
            outParts.push(Buffer.from([0xc2, 0x9c]));
            this.passthroughTail = Buffer.alloc(0);
            this.inApc = false;
            this.apcPassthrough = false;
            i += 1;
            continue;
          }
          if (this.passthroughTail.length > 0) {
            outParts.push(this.passthroughTail);
            this.passthroughTail = Buffer.alloc(0);
          }
          const termPos = findFirstByte3(bytes, i, 0x07, 0x1b, 0x9c);
          if (termPos >= 0) {
            const b = bytes[termPos]!;
            if (b === 0x07 || b === 0x9c) {
              outParts.push(bytes.subarray(i, termPos + 1));
              this.inApc = false;
              this.apcPassthrough = false;
              i = termPos + 1;
            } else if (termPos + 1 < bytes.length && bytes[termPos + 1] === 0x5c) {
              outParts.push(bytes.subarray(i, termPos + 2));
              this.inApc = false;
              this.apcPassthrough = false;
              i = termPos + 2;
            } else if (termPos + 1 === bytes.length) {
              outParts.push(bytes.subarray(i, termPos));
              this.passthroughTail = Buffer.from([0x1b]);
              i = bytes.length;
            } else {
              outParts.push(bytes.subarray(i, termPos + 1));
              i = termPos + 1;
            }
          } else if (bytes[bytes.length - 1] === 0xc2) {
            outParts.push(bytes.subarray(i, bytes.length - 1));
            this.passthroughTail = Buffer.from([0xc2]);
            i = bytes.length;
          } else {
            outParts.push(bytes.subarray(i));
            i = bytes.length;
          }
          continue;
        }

        // Check terminator split right at frame boundary (`ESC` + `\` or `0xc2` + `0x9c`).
        const prevLast = this.apcChunks.length ? this.apcChunks[this.apcChunks.length - 1]! : null;
        const lastByte = prevLast && prevLast.length ? prevLast[prevLast.length - 1] : undefined;
        if (lastByte === 0x1b && bytes[i] === 0x5c) {
          this.popLastApcByte();
          const prefix = this.apcPrefix;
          const content = this.takeApcContent();
          this.inApc = false;
          this.finishApc(prefix, content, Buffer.from("\x1b\\", "latin1"), outParts, autoReplies);
          i += 1;
          continue;
        }
        if (lastByte === 0xc2 && bytes[i] === 0x9c) {
          this.popLastApcByte();
          const prefix = this.apcPrefix;
          const content = this.takeApcContent();
          this.inApc = false;
          this.finishApc(prefix, content, Buffer.from([0xc2, 0x9c]), outParts, autoReplies);
          i += 1;
          continue;
        }

        const termPos = findFirstByte3(bytes, i, 0x07, 0x1b, 0x9c);
        if (termPos >= 0) {
          const b = bytes[termPos]!;
          if (b === 0x07) {
            this.appendApcSlice(bytes.subarray(i, termPos));
            const prefix = this.apcPrefix;
            const content = this.takeApcContent();
            this.inApc = false;
            this.finishApc(prefix, content, Buffer.from([0x07]), outParts, autoReplies);
            i = termPos + 1;
          } else if (b === 0x9c) {
            this.appendApcSlice(bytes.subarray(i, termPos));
            let suffix: Buffer;
            if (this.lastApcByte() === 0xc2) {
              this.popLastApcByte();
              suffix = Buffer.from([0xc2, 0x9c]);
            } else {
              suffix = Buffer.from([0x9c]);
            }
            const prefix = this.apcPrefix;
            const content = this.takeApcContent();
            this.inApc = false;
            this.finishApc(prefix, content, suffix, outParts, autoReplies);
            i = termPos + 1;
          } else if (termPos + 1 < bytes.length && bytes[termPos + 1] === 0x5c) {
            this.appendApcSlice(bytes.subarray(i, termPos));
            const prefix = this.apcPrefix;
            const content = this.takeApcContent();
            this.inApc = false;
            this.finishApc(prefix, content, Buffer.from("\x1b\\", "latin1"), outParts, autoReplies);
            i = termPos + 2;
          } else {
            this.appendApcSlice(bytes.subarray(i, termPos + 1));
            i = termPos + 1;
          }
        } else {
          this.appendApcSlice(bytes.subarray(i));
          i = bytes.length;
        }

        if (this.inApc && this.apcLen > MAX_SINGLE_APC_BYTES) {
          this.flushChunkedRaw(outParts);
          outParts.push(this.apcPrefix, ...this.apcChunks);
          this.apcPrefix = Buffer.alloc(0);
          this.apcChunks = [];
          this.apcLen = 0;
          this.apcPassthrough = true;
        }
        continue;
      }

      while (i < bytes.length && this.utf8Rem > 0 && bytes[i]! >= 0x80 && bytes[i]! <= 0xbf) {
        outParts.push(bytes.subarray(i, i + 1));
        i += 1;
        this.utf8Rem -= 1;
      }
      if (i < bytes.length && this.utf8Rem > 0) this.utf8Rem = 0;
      if (i >= bytes.length) break;

      const pos = findFirstByte3(bytes, i, 0x1b, 0x9f, 0xc2);
      if (pos < 0) {
        const tail = bytes.subarray(i);
        outParts.push(tail);
        this.utf8Rem = trailingUtf8Remaining(tail);
        break;
      }

      const b = bytes[pos]!;
      if (b === 0x1b) {
        if (pos + 1 === bytes.length) {
          if (pos > i) outParts.push(bytes.subarray(i, pos));
          this.pendingPrefix = Buffer.from([0x1b]);
          break;
        }
        if (bytes[pos + 1] === 0x5f) {
          if (pos + 2 === bytes.length) {
            if (pos > i) outParts.push(bytes.subarray(i, pos));
            this.pendingPrefix = Buffer.from([0x1b, 0x5f]);
            break;
          }
          if (bytes[pos + 2] === 0x47) {
            if (pos > i) outParts.push(bytes.subarray(i, pos));
            this.inApc = true;
            this.apcPrefix = Buffer.from("\x1b_G", "latin1");
            this.apcChunks = [];
            this.apcLen = 0;
            this.apcPassthrough = false;
            i = pos + 3;
            continue;
          }
          outParts.push(bytes.subarray(i, pos + 2));
          this.utf8Rem = 0;
          i = pos + 2;
          continue;
        }
        outParts.push(bytes.subarray(i, pos + 1));
        this.utf8Rem = 0;
        i = pos + 1;
      } else if (b === 0xc2) {
        if (pos + 1 === bytes.length) {
          if (pos > i) outParts.push(bytes.subarray(i, pos));
          this.pendingPrefix = Buffer.from([0xc2]);
          break;
        }
        if (bytes[pos + 1] === 0x9f) {
          if (pos + 2 === bytes.length) {
            if (pos > i) outParts.push(bytes.subarray(i, pos));
            this.pendingPrefix = Buffer.from([0xc2, 0x9f]);
            break;
          }
          if (bytes[pos + 2] === 0x47) {
            if (pos > i) outParts.push(bytes.subarray(i, pos));
            this.inApc = true;
            this.apcPrefix = Buffer.from([0xc2, 0x9f, 0x47]);
            this.apcChunks = [];
            this.apcLen = 0;
            this.apcPassthrough = false;
            i = pos + 3;
            continue;
          }
          outParts.push(bytes.subarray(i, pos + 2));
          this.utf8Rem = 0;
          i = pos + 2;
          continue;
        }
        outParts.push(bytes.subarray(i, pos + 2));
        this.utf8Rem = 0;
        i = pos + 2;
      } else {
        // 0x9f
        if (isUtf8ContinuationAt(bytes, i, pos, outParts)) {
          const seg = bytes.subarray(i, pos + 1);
          outParts.push(seg);
          this.utf8Rem = trailingUtf8Remaining(seg);
          i = pos + 1;
          continue;
        }
        if (pos + 1 === bytes.length) {
          if (pos > i) outParts.push(bytes.subarray(i, pos));
          this.pendingPrefix = Buffer.from([0x9f]);
          break;
        }
        if (bytes[pos + 1] === 0x47) {
          if (pos > i) outParts.push(bytes.subarray(i, pos));
          this.inApc = true;
          this.apcPrefix = Buffer.from([0x9f, 0x47]);
          this.apcChunks = [];
          this.apcLen = 0;
          this.apcPassthrough = false;
          i = pos + 2;
          continue;
        }
        outParts.push(bytes.subarray(i, pos + 1));
        this.utf8Rem = 0;
        i = pos + 1;
      }
    }

    const outBytes = outParts.length === 0 ? Buffer.alloc(0) : outParts.length === 1 ? outParts[0]! : Buffer.concat(outParts);
    return { outBytes, autoReplies };
  }

  private appendApcSlice(slice: Buffer): void {
    if (!slice.length) return;
    this.apcChunks.push(slice);
    this.apcLen += slice.length;
  }

  private lastApcByte(): number | undefined {
    for (let i = this.apcChunks.length - 1; i >= 0; i--) {
      const c = this.apcChunks[i]!;
      if (c.length) return c[c.length - 1];
    }
    return undefined;
  }

  private popLastApcByte(): void {
    for (let i = this.apcChunks.length - 1; i >= 0; i--) {
      const c = this.apcChunks[i]!;
      if (c.length > 0) {
        this.apcChunks[i] = c.subarray(0, c.length - 1);
        this.apcLen -= 1;
        return;
      }
    }
  }

  private takeApcContent(): Buffer {
    const out = this.apcChunks.length === 0 ? Buffer.alloc(0) : this.apcChunks.length === 1 ? this.apcChunks[0]! : Buffer.concat(this.apcChunks, this.apcLen);
    this.apcChunks = [];
    this.apcLen = 0;
    this.apcPrefix = Buffer.alloc(0);
    return out;
  }

  private flushChunkedRaw(outParts: Buffer[]): void {
    if (!this.chunked) return;
    for (const c of this.chunked.rawChunks) outParts.push(c);
    this.chunked = null;
  }

  private finishApc(prefix: Buffer, content: Buffer, suffix: Buffer, outParts: Buffer[], autoReplies: Buffer[]): void {
    const semi = content.indexOf(0x3b);
    const hdrRaw = (semi >= 0 ? content.subarray(0, semi) : content).toString("utf8");
    const payload = semi >= 0 ? content.subarray(semi + 1) : Buffer.alloc(0);
    const hdr = parseKittyHeader(hdrRaw);

    const emitOriginal = () => {
      outParts.push(prefix, content, suffix);
    };

    if (this.chunked) {
      const active = this.chunked;
      const isCont =
        !hdr.action ||
        (hdr.action === active.action && (active.id === undefined || hdr.id === undefined || hdr.id === active.id));
      if (isCont && active.totalBytes + content.length <= MAX_FILE_PATH_CHUNKS_BYTES) {
        this.chunked = null;
        active.rawChunks.push(prefix, content, suffix);
        active.payloadParts.push(payload);
        active.totalBytes += content.length;
        if (hdr.more) {
          this.chunked = active;
          return;
        }
        const inlined = inlineFileToDirectApcs(active);
        if (inlined.ok) {
          if (active.quiet === 0) {
            const reply = kittyReply(active.id, active.imageNumber, "OK");
            if (reply) autoReplies.push(reply);
          }
          outParts.push(inlined.out);
        } else {
          if (active.quiet < 2) {
            const reply = kittyReply(active.id, active.imageNumber, "ENOENT:unable to open file");
            if (reply) autoReplies.push(reply);
          }
        }
        return;
      }
      this.flushChunkedRaw(outParts);
    }

    // Immediate host reply for capability queries (`a=q`), rewriting `q=2` downstream.
    if (hdr.action === "q" && !hdr.more) {
      const med = hdr.medium ?? "d";
      const fmtOk = hdr.format === undefined || hdr.format === 24 || hdr.format === 32 || hdr.format === 100;
      const medOk = med === "d" || med === "f" || med === "t";
      let replyStatus = fmtOk && medOk ? "OK" : "ENOTSUP:unsupported";
      if (med === "t" && fmtOk) {
        try {
          const p = Buffer.from(payload.toString("utf8").replace(/\s+/g, ""), "base64").toString("utf8").replace(/\0+$/, "").trim();
          if (p && isTempPath(p)) {
            try {
              const lst = lstatSync(p);
              if (!lst.isSymbolicLink() && lst.isFile()) unlinkSync(p);
              else replyStatus = "ENOENT:unable to open file";
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") replyStatus = "ENOENT:unable to open file";
            }
          } else {
            replyStatus = "ENOENT:unable to open file";
          }
        } catch {
          replyStatus = "ENOENT:unable to open file";
        }
      }
      if (replyStatus === "OK" ? hdr.quiet === 0 : hdr.quiet < 2) {
        const reply = kittyReply(hdr.id, hdr.imageNumber, replyStatus);
        if (reply) autoReplies.push(reply);
      }
      if (hdr.quiet < 2) {
        const nextHdr = rewriteHeaderQuiet2(hdrRaw);
        outParts.push(prefix, Buffer.from(`${nextHdr};`, "utf8"), payload, suffix);
      } else {
        emitOriginal();
      }
      return;
    }

    const isUploadAction =
      hdr.action === "T" ||
      hdr.action === "t" ||
      (!hdr.action && payload.length > 0 && (hdr.format !== undefined || hdr.medium !== undefined || (hdr.width !== undefined && hdr.height !== undefined)));

    if (isUploadAction && (hdr.medium === "f" || hdr.medium === "t") && !hdr.compression) {
      const upload: ActiveFileUpload = {
        firstHeaderRaw: hdrRaw,
        action: hdr.action ?? "t",
        medium: hdr.medium,
        format: hdr.format,
        id: hdr.id,
        imageNumber: hdr.imageNumber,
        width: hdr.width,
        height: hdr.height,
        quiet: hdr.quiet,
        rawPairs: hdr.rawPairs,
        rawChunks: [prefix, content, suffix],
        payloadParts: [payload],
        totalBytes: content.length,
      };
      if (hdr.more) {
        this.chunked = upload;
        return;
      }
      const inlined = inlineFileToDirectApcs(upload);
      if (inlined.ok) {
        if (hdr.quiet === 0) {
          const reply = kittyReply(hdr.id, hdr.imageNumber, "OK");
          if (reply) autoReplies.push(reply);
        }
        outParts.push(inlined.out);
      } else {
        if (hdr.quiet < 2) {
          const reply = kittyReply(hdr.id, hdr.imageNumber, "ENOENT:unable to open file");
          if (reply) autoReplies.push(reply);
        }
      }
      return;
    }

    // Also answer quiet=0 `t=d` uploads quickly on host and rewrite downstream `q=2` to save WAN RTT.
    if (isUploadAction && (hdr.medium ?? "d") === "d" && !hdr.more && hdr.quiet === 0 && (hdr.id !== undefined || hdr.imageNumber !== undefined)) {
      const reply = kittyReply(hdr.id, hdr.imageNumber, "OK");
      if (reply) autoReplies.push(reply);
      const nextHdr = rewriteHeaderQuiet2(hdrRaw);
      outParts.push(prefix, Buffer.from(`${nextHdr};`, "utf8"), payload, suffix);
      return;
    }

    emitOriginal();
  }
}

function findFirstByte3(buf: Buffer, from: number, a: number, b: number, c: number): number {
  const ia = buf.indexOf(a, from);
  const ib = buf.indexOf(b, from);
  const ic = buf.indexOf(c, from);
  let best = ia >= 0 ? ia : -1;
  if (ib >= 0 && (best < 0 || ib < best)) best = ib;
  if (ic >= 0 && (best < 0 || ic < best)) best = ic;
  return best;
}

export { validateHostImagePath };
