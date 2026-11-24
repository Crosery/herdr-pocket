import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { allReleaseSources, inMainlandChina, RELEASE_REPO } from "@herdr-pocket/protocol";

const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ASSET_RE = /^[A-Za-z0-9._-]+$/;
const METADATA_ASSETS = new Set(["SHA256SUMS", "RELEASE-MANIFEST.json", "RELEASE-NOTES.md"]);
const ALLOWED_EXT_RE = /\.(?:dmg|apk|ipa|hap|msi|exe|deb|AppImage|tar\.gz|zip)$/i;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_CACHED_VERSIONS = 3;
const HEAD_TIMEOUT_MS = 12_000;
const STALL_TIMEOUT_MS = 20_000;

export interface ReleaseCacheOptions {
  dbPath: string;
  cacheDir?: string;
  /** Test override: upstream base URLs (`${base}/${tag}/${asset}`). */
  upstreamBases?: string[];
  log?: (msg: string) => void;
}

class ReleaseHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isValidReleaseTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

export function isValidReleaseAsset(asset: string): boolean {
  if (!ASSET_RE.test(asset) || asset.includes("..")) return false;
  return METADATA_ASSETS.has(asset) || ALLOWED_EXT_RE.test(asset);
}

function contentTypeFor(asset: string): string {
  if (asset.endsWith(".json")) return "application/json; charset=utf-8";
  if (asset.endsWith(".md") || asset === "SHA256SUMS") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function parseSha256Sums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m) out[m[2]!] = m[1]!.toLowerCase();
  }
  return out;
}

function parseByteRange(header: string | undefined, total: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!m) return "invalid";
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return "invalid";
  if (total <= 0) return "invalid";
  if (!rawStart) {
    const suffix = Number.parseInt(rawEnd!, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    const start = Math.max(0, total - suffix);
    return { start, end: total - 1 };
  }
  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start < 0 || start >= total) return "invalid";
  if (!rawEnd) return { start, end: total - 1 };
  const end = Math.min(total - 1, Number.parseInt(rawEnd, 10));
  if (!Number.isFinite(end) || end < start) return "invalid";
  return { start, end };
}

/**
 * Caches GitHub release installers and metadata locally on the Relay so desktop/mobile clients
 * behind slow or throttled international links can download verified artifacts directly over HTTPS
 * with full HTTP Range (`206`) resumability and parallel chunking.
 */
export class ReleaseCache {
  readonly dir: string;
  private readonly ephemeral: boolean;
  private readonly upstreamBases?: string[];
  private readonly log: (msg: string) => void;
  private inflight = new Map<string, Promise<string>>();

  constructor(opts: ReleaseCacheOptions) {
    if (opts.cacheDir) {
      this.dir = opts.cacheDir;
      this.ephemeral = false;
    } else if (opts.dbPath === ":memory:" || opts.dbPath.startsWith("file::memory:")) {
      this.dir = mkdtempSync(join(tmpdir(), "pocket-release-cache-"));
      this.ephemeral = true;
    } else {
      this.dir = join(dirname(opts.dbPath), "release-cache");
      this.ephemeral = false;
    }
    this.upstreamBases = opts.upstreamBases?.length ? [...opts.upstreamBases] : undefined;
    this.log = opts.log ?? (() => {});
    mkdirSync(this.dir, { recursive: true });
  }

  close(): void {
    if (this.ephemeral) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }

  async handleDownload(req: IncomingMessage, res: ServerResponse, tag: string, asset: string): Promise<void> {
    if (!isValidReleaseTag(tag) || !isValidReleaseAsset(asset)) {
      this.sendJsonError(res, 400, "bad_request", "无效的发布版本或安装包名称");
      return;
    }

    let filePath: string;
    try {
      filePath = await this.ensureCached(tag, asset);
    } catch (err) {
      const status = err instanceof ReleaseHttpError ? err.status : 502;
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`releases: ${tag}/${asset} failed (${status}): ${msg}`);
      if (!res.headersSent) {
        this.sendJsonError(res, status, status === 404 ? "not_found" : "upstream_error", msg);
      }
      return;
    }

    const st = statSync(filePath);
    const total = st.size;
    const etag = `"${total.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
    const range = parseByteRange(req.headers.range, total);
    if (range === "invalid") {
      res.writeHead(416, {
        "Content-Range": `bytes */${total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    const commonHeaders: Record<string, string | number> = {
      "Content-Type": contentTypeFor(asset),
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Cache-Control": METADATA_ASSETS.has(asset) ? "public, max-age=300" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    };

    if (range) {
      const len = range.end - range.start + 1;
      res.writeHead(206, {
        ...commonHeaders,
        "Content-Length": len,
        "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      await this.streamRange(res, filePath, range.start, range.end);
      return;
    }

    res.writeHead(200, {
      ...commonHeaders,
      "Content-Length": total,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (total === 0) {
      res.end();
      return;
    }
    await this.streamRange(res, filePath, 0, total - 1);
  }

  private streamRange(res: ServerResponse, filePath: string, start: number, end: number): Promise<void> {
    return new Promise((resolve) => {
      const rs = createReadStream(filePath, { start, end });
      const cleanup = () => {
        if (!rs.destroyed) rs.destroy();
        resolve();
      };
      res.once("close", cleanup);
      rs.once("error", () => {
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end();
        resolve();
      });
      rs.once("end", () => {
        res.off("close", cleanup);
        resolve();
      });
      rs.pipe(res);
    });
  }

  private sendJsonError(res: ServerResponse, status: number, code: string, message: string): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: { code, message } }));
  }

  async ensureCached(tag: string, asset: string): Promise<string> {
    const tagDir = join(this.dir, tag);
    const dest = join(tagDir, asset);
    if (existsSync(dest)) {
      const st = statSync(dest);
      if (st.isFile()) return dest;
    }

    const key = `${tag}/${asset}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const job = this.fetchAndCache(tag, asset, tagDir, dest).finally(() => {
      if (this.inflight.get(key) === job) this.inflight.delete(key);
    });
    this.inflight.set(key, job);
    return job;
  }

  private upstreamCandidates(tag: string, asset: string): string[] {
    if (this.upstreamBases?.length) {
      return this.upstreamBases.map((b) => `${b.replace(/\/+$/, "")}/${tag}/${asset}`);
    }
    const githubUrl = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${asset}`;
    return allReleaseSources(githubUrl, inMainlandChina());
  }

  private async fetchExpectedSha(tag: string, asset: string): Promise<string | null> {
    if (METADATA_ASSETS.has(asset)) return null;
    try {
      const sumsPath = await this.ensureCached(tag, "SHA256SUMS");
      const sums = parseSha256Sums(readFileSync(sumsPath, "utf8"));
      return sums[asset] ?? null;
    } catch {
      return null;
    }
  }

  private async fetchAndCache(tag: string, asset: string, tagDir: string, dest: string): Promise<string> {
    if (existsSync(dest)) {
      const st = statSync(dest);
      if (st.isFile()) return dest;
    }
    const expectedSha = await this.fetchExpectedSha(tag, asset);
    mkdirSync(tagDir, { recursive: true });

    const candidates = this.upstreamCandidates(tag, asset);
    let lastError: Error = new ReleaseHttpError(502, "未找到可用的上游发布源");

    for (const url of candidates) {
      const partPath = `${dest}.${randomBytes(6).toString("hex")}.part`;
      try {
        await this.downloadToPart(url, partPath, expectedSha);
        renameSync(partPath, dest);
        const now = new Date();
        try {
          utimesSync(tagDir, now, now);
        } catch {
          // ignore utime failure
        }
        this.pruneOldVersions();
        return dest;
      } catch (err) {
        try {
          if (existsSync(partPath)) unlinkSync(partPath);
        } catch {
          // ignore
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError;
  }

  private async downloadToPart(url: string, partPath: string, expectedSha: string | null): Promise<void> {
    const ac = new AbortController();
    const headTimer = setTimeout(() => ac.abort(new Error("upstream header timeout")), HEAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: ac.signal,
        headers: { "User-Agent": "herdr-pocket-relay-cache" },
        redirect: "follow",
      });
    } finally {
      clearTimeout(headTimer);
    }

    if (!res.ok) {
      const status = res.status === 404 ? 404 : 502;
      throw new ReleaseHttpError(status, `上游返回 HTTP ${res.status}`);
    }
    if (!res.body) throw new ReleaseHttpError(502, "上游响应缺少正文");

    const clHeader = res.headers.get("content-length");
    if (clHeader) {
      const cl = Number.parseInt(clHeader, 10);
      if (Number.isFinite(cl) && cl > MAX_ASSET_BYTES) {
        ac.abort();
        throw new ReleaseHttpError(502, "发布包超出允许的最大体积");
      }
    }

    const hash = createHash("sha256");
    const ws = createWriteStream(partPath);
    const reader = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
    let total = 0;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ac.abort(new Error("upstream stream stalled")), STALL_TIMEOUT_MS);
    };

    try {
      armStall();
      await new Promise<void>((resolve, reject) => {
        ws.on("error", reject);
        reader.on("error", reject);
        reader.on("data", (chunk: Buffer) => {
          armStall();
          total += chunk.length;
          if (total > MAX_ASSET_BYTES) {
            ac.abort();
            reject(new ReleaseHttpError(502, "发布包超出允许的最大体积"));
            return;
          }
          hash.update(chunk);
          if (!ws.write(chunk)) {
            reader.pause();
            ws.once("drain", () => reader.resume());
          }
        });
        reader.on("end", () => {
          ws.end(() => resolve());
        });
      });
    } catch (err) {
      if (!ws.destroyed) ws.destroy();
      if (!reader.destroyed) reader.destroy();
      throw err;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }

    if (expectedSha) {
      const actualSha = hash.digest("hex").toLowerCase();
      if (actualSha !== expectedSha.toLowerCase()) {
        throw new ReleaseHttpError(502, `安装包 SHA-256 校验不一致（期望 ${expectedSha.slice(0, 12)}，实际 ${actualSha.slice(0, 12)}）`);
      }
    }
  }

  private pruneOldVersions(): void {
    try {
      const activeTags = new Set<string>();
      for (const k of this.inflight.keys()) {
        const slash = k.indexOf("/");
        if (slash > 0) activeTags.add(k.slice(0, slash));
      }
      const dirs = readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && TAG_RE.test(d.name))
        .map((d) => {
          const full = join(this.dir, d.name);
          return { name: d.name, full, mtimeMs: statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      let kept = 0;
      for (const d of dirs) {
        if (kept < MAX_CACHED_VERSIONS || activeTags.has(d.name)) {
          kept += 1;
          continue;
        }
        rmSync(d.full, { recursive: true, force: true });
      }
    } catch {
      // non-fatal prune error
    }
  }
}
