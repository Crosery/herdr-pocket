import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { readTar } from "@herdr-pocket/update";
import {
  allReleaseSources,
  compareVersions,
  inMainlandChina,
  LATEST_MANIFEST_URL,
  LATEST_SUMS_URL,
  parseReleaseManifest,
  RELEASE_REPO,
  releaseAssetUrl,
  releaseFromSums,
  type ReleaseManifest,
} from "@herdr-pocket/protocol";

const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ASSET_RE = /^[A-Za-z0-9._-]+$/;
const METADATA_ASSETS = new Set(["SHA256SUMS", "RELEASE-MANIFEST.json", "RELEASE-NOTES.md"]);
const ALLOWED_EXT_RE = /\.(?:dmg|apk|ipa|hap|msi|exe|deb|AppImage|tar\.gz|zip)$/i;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_CACHED_VERSIONS = 3;
const HEAD_TIMEOUT_MS = 12_000;
const STALL_TIMEOUT_MS = 20_000;
const LATEST_CACHE_TTL_MS = 20_000;
const LATEST_FETCH_TIMEOUT_MS = 6_000;

export interface ReleaseCacheOptions {
  dbPath: string;
  cacheDir?: string;
  /** Test override: upstream base URLs (`${base}/${tag}/${asset}`). */
  upstreamBases?: string[];
  /** Current relay semver used as baseline before the first upstream check completes. */
  serverVersion?: string;
  /** Override background release polling interval in ms (0 disables polling). */
  pollIntervalMs?: number;
  /** Auto-download & unpack newer `web/dist` and `admin/dist` bundles into writable cache state. */
  autoSyncUiBundles?: boolean;
  /** Invoked whenever a strictly newer verified UI bundle (`web` + `admin`) is active on disk. */
  onUiBundleSynced?: (info: { version: string; webDir: string; adminDir: string }) => void;
  /** Invoked whenever a strictly newer release version than prior known state is observed. */
  onNewRelease?: (version: string) => void;
  log?: (msg: string) => void;
}

export interface RelayLatestSnapshot {
  latest: string | null;
  manifest?: ReleaseManifest;
  notes?: string;
  checkedAt: number;
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
  readonly uiBundlesDir: string;
  private readonly ephemeral: boolean;
  private readonly upstreamBases?: string[];
  private readonly log: (msg: string) => void;
  private readonly onNewRelease?: (version: string) => void;
  private readonly onUiBundleSynced?: (info: { version: string; webDir: string; adminDir: string }) => void;
  private readonly autoSyncUiBundles: boolean;
  private readonly serverVer: string | null;
  private inflight = new Map<string, Promise<string>>();
  private uiSyncInflight = new Map<string, Promise<boolean>>();
  private latestKnown: string | null;
  private activeUiVer: string | null;
  private latestSnapshot: RelayLatestSnapshot | null = null;
  private latestInflight: Promise<RelayLatestSnapshot> | null = null;
  private initTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;

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
    this.uiBundlesDir = join(this.dir, "ui-bundles");
    this.upstreamBases = opts.upstreamBases?.length ? [...opts.upstreamBases] : undefined;
    this.log = opts.log ?? (() => {});
    this.onNewRelease = opts.onNewRelease;
    this.onUiBundleSynced = opts.onUiBundleSynced;
    this.autoSyncUiBundles = opts.autoSyncUiBundles ?? (!this.ephemeral && !this.upstreamBases?.length);
    const baseVer = opts.serverVersion?.trim().replace(/^v/i, "") ?? "";
    this.serverVer = SEMVER_RE.test(baseVer) ? baseVer : null;
    this.latestKnown = this.serverVer;
    this.activeUiVer = this.serverVer;
    mkdirSync(this.dir, { recursive: true });
    this.restoreLatestUiBundle();

    const defaultPollMs = this.ephemeral || this.upstreamBases?.length ? 0 : 60_000;
    const pollMs = typeof opts.pollIntervalMs === "number" ? opts.pollIntervalMs : defaultPollMs;
    if (pollMs > 0) {
      this.initTimer = setTimeout(() => {
        this.initTimer = null;
        if (!this.closed) void this.checkLatestRelease(true).catch(() => {});
      }, Math.min(1500, pollMs));
      this.initTimer.unref?.();
      this.pollTimer = setInterval(() => {
        if (!this.closed) void this.checkLatestRelease(true).catch(() => {});
      }, pollMs);
      this.pollTimer.unref?.();
    }
  }

  latestVersion(): string | null {
    return this.latestKnown;
  }

  activeUiVersion(): string | null {
    return this.activeUiVer;
  }

  private restoreLatestUiBundle(): void {
    try {
      if (!existsSync(this.uiBundlesDir)) return;
      const cands = readdirSync(this.uiBundlesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && TAG_RE.test(d.name))
        .map((d) => ({ ver: d.name.slice(1), full: join(this.uiBundlesDir, d.name) }))
        .filter((c) => SEMVER_RE.test(c.ver) && (!this.serverVer || compareVersions(c.ver, this.serverVer) > 0))
        .sort((a, b) => compareVersions(b.ver, a.ver));
      for (const c of cands) {
        const webDir = join(c.full, "web");
        const adminDir = join(c.full, "admin");
        if (existsSync(join(webDir, "index.html")) && existsSync(join(adminDir, "index.html"))) {
          this.activeUiVer = c.ver;
          this.onUiBundleSynced?.({ version: c.ver, webDir, adminDir });
          return;
        }
      }
    } catch {
      // non-fatal cache restore error
    }
  }

  async syncUiBundleForVersion(version: string): Promise<boolean> {
    if (!SEMVER_RE.test(version)) return false;
    if (this.activeUiVer && compareVersions(this.activeUiVer, version) >= 0) return false;
    const existing = this.uiSyncInflight.get(version);
    if (existing) return existing;

    const job = (async (): Promise<boolean> => {
      const tag = `v${version}`;
      const asset = `herdr-pocket-${version}.tar.gz`;
      const tarPath = await this.ensureCached(tag, asset);
      const entries = readTar(gunzipSync(readFileSync(tarPath)));
      mkdirSync(this.uiBundlesDir, { recursive: true });
      const stageDir = join(this.uiBundlesDir, `.stage-${tag}-${randomBytes(4).toString("hex")}`);
      const stageWeb = join(stageDir, "web");
      const stageAdmin = join(stageDir, "admin");
      const destDir = join(this.uiBundlesDir, tag);

      const safeWrite = (baseDir: string, relRaw: string, data: Buffer) => {
        if (!relRaw || relRaw.includes("\0") || relRaw.includes("\\") || relRaw.startsWith("/")) return;
        const parts = relRaw.split("/").filter(Boolean);
        if (!parts.length || parts.some((p) => p === "." || p === "..")) return;
        const outPath = resolve(baseDir, ...parts);
        if (!outPath.startsWith(resolve(baseDir) + sep)) return;
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, data, { mode: 0o644 });
      };

      try {
        for (const e of entries) {
          if (e.type !== "file") continue;
          const norm = e.name.replace(/\\/g, "/").replace(/^\.\//, "");
          const slash = norm.indexOf("/");
          const inner = slash > 0 ? norm.slice(slash + 1) : norm;
          if (inner.startsWith("apps/relay/src/web/dist/")) {
            safeWrite(stageWeb, inner.slice("apps/relay/src/web/dist/".length), e.data);
          } else if (inner.startsWith("apps/relay/src/admin/dist/")) {
            safeWrite(stageAdmin, inner.slice("apps/relay/src/admin/dist/".length), e.data);
          }
        }
        const webIndex = join(stageWeb, "index.html");
        const adminIndex = join(stageAdmin, "index.html");
        if (!existsSync(webIndex) || !existsSync(adminIndex) || statSync(webIndex).size === 0 || statSync(adminIndex).size === 0) {
          rmSync(stageDir, { recursive: true, force: true });
          return false;
        }
        if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
        renameSync(stageDir, destDir);
        const webDir = join(destDir, "web");
        const adminDir = join(destDir, "admin");
        this.activeUiVer = version;
        this.onUiBundleSynced?.({ version, webDir, adminDir });
        this.pruneOldUiBundles(tag);
        this.log(`releases: hot-synced H5 & admin UI bundles to ${tag}`);
        return true;
      } catch (err) {
        rmSync(stageDir, { recursive: true, force: true });
        throw err;
      }
    })().finally(() => {
      if (this.uiSyncInflight.get(version) === job) this.uiSyncInflight.delete(version);
    });

    this.uiSyncInflight.set(version, job);
    return job;
  }

  private pruneOldUiBundles(keepTag: string): void {
    try {
      if (!existsSync(this.uiBundlesDir)) return;
      const dirs = readdirSync(this.uiBundlesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && TAG_RE.test(d.name))
        .map((d) => ({ name: d.name, ver: d.name.slice(1), full: join(this.uiBundlesDir, d.name) }))
        .sort((a, b) => (SEMVER_RE.test(b.ver) && SEMVER_RE.test(a.ver) ? compareVersions(b.ver, a.ver) : 0));
      let kept = 0;
      for (const d of dirs) {
        if (d.name === keepTag || kept < 2) {
          kept += 1;
          continue;
        }
        rmSync(d.full, { recursive: true, force: true });
      }
    } catch {
      // non-fatal prune error
    }
  }

  close(): void {
    this.closed = true;
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ephemeral) {
      try {
        rmSync(this.dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }

  private async fetchTextNoCache(url: string, timeoutMs = LATEST_FETCH_TIMEOUT_MS): Promise<string | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          "User-Agent": "herdr-pocket-relay-cache",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        redirect: "follow",
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchFirstManifest(urls: string[]): Promise<ReleaseManifest | undefined> {
    if (!urls.length) return undefined;
    try {
      return await Promise.any(
        urls.map(async (u) => {
          const text = await this.fetchTextNoCache(u);
          const parsed = text ? parseReleaseManifest(text) : null;
          if (!parsed) throw new Error("not manifest");
          return parsed;
        }),
      );
    } catch {
      return undefined;
    }
  }

  private async fetchFirstNotes(urls: string[]): Promise<string | undefined> {
    if (!urls.length) return undefined;
    try {
      return await Promise.any(
        urls.map(async (u) => {
          const text = await this.fetchTextNoCache(u, 4000);
          const trimmed = text?.trim() ?? "";
          if (!trimmed || /^\s*<(?:!doctype|html)\b/i.test(trimmed)) throw new Error("not notes");
          return trimmed;
        }),
      );
    } catch {
      return undefined;
    }
  }

  private async fetchGithubLatest(): Promise<{ version: string; body?: string } | null> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LATEST_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
        signal: ac.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "herdr-pocket-relay-cache",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { tag_name?: string; body?: string; draft?: boolean; prerelease?: boolean };
      if (json.draft || json.prerelease) return null;
      const v = (json.tag_name ?? "").trim().replace(/^v/i, "");
      if (!SEMVER_RE.test(v)) return null;
      return { version: v, body: typeof json.body === "string" && json.body.trim() ? json.body.trim() : undefined };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkLatestRelease(force = false): Promise<RelayLatestSnapshot> {
    if (!force && this.latestSnapshot && Date.now() - this.latestSnapshot.checkedAt < LATEST_CACHE_TTL_MS) {
      return this.latestSnapshot;
    }
    if (this.latestInflight) return this.latestInflight;

    const task = (async (): Promise<RelayLatestSnapshot> => {
      let manifest: ReleaseManifest | undefined;
      let notes: string | undefined;
      let sumsVersion: string | null = null;
      let ghVersion: string | null = null;

      if (this.upstreamBases?.length) {
        const manifestUrls = this.upstreamBases.map((b) => `${b.replace(/\/+$/, "")}/latest/RELEASE-MANIFEST.json`);
        const sumsUrls = this.upstreamBases.map((b) => `${b.replace(/\/+$/, "")}/latest/SHA256SUMS`);
        const noteUrls = this.upstreamBases.map((b) => `${b.replace(/\/+$/, "")}/latest/RELEASE-NOTES.md`);
        manifest = await this.fetchFirstManifest(manifestUrls);
        if (!manifest) {
          for (const u of sumsUrls) {
            const txt = await this.fetchTextNoCache(u);
            const parsed = txt ? releaseFromSums(txt) : null;
            if (parsed) {
              sumsVersion = parsed.version;
              break;
            }
          }
        }
        notes = await this.fetchFirstNotes(noteUrls);
      } else {
        const china = inMainlandChina();
        const [gh, mirrorManifest] = await Promise.all([
          this.fetchGithubLatest(),
          this.fetchFirstManifest(allReleaseSources(LATEST_MANIFEST_URL, china)),
        ]);
        if (gh) {
          ghVersion = gh.version;
          if (gh.body) notes = gh.body;
        }
        manifest = mirrorManifest;
        if (!ghVersion && !manifest) {
          for (const u of allReleaseSources(LATEST_SUMS_URL, china)) {
            const txt = await this.fetchTextNoCache(u);
            const parsed = txt ? releaseFromSums(txt) : null;
            if (parsed) {
              sumsVersion = parsed.version;
              break;
            }
          }
        }
      }

      let best: string | null = null;
      for (const cand of [ghVersion, manifest?.releaseVersion, sumsVersion]) {
        if (cand && SEMVER_RE.test(cand) && (!best || compareVersions(cand, best) > 0)) {
          best = cand;
        }
      }

      if (best && (!manifest || compareVersions(best, manifest.releaseVersion) > 0)) {
        const taggedManifestUrls = this.upstreamBases?.length
          ? this.upstreamBases.map((b) => `${b.replace(/\/+$/, "")}/v${best}/RELEASE-MANIFEST.json`)
          : allReleaseSources(releaseAssetUrl(best, "RELEASE-MANIFEST.json"), inMainlandChina());
        const taggedManifest = await this.fetchFirstManifest(taggedManifestUrls);
        if (taggedManifest) manifest = taggedManifest;
      }

      if (best && !notes) {
        const taggedNotesUrls = this.upstreamBases?.length
          ? this.upstreamBases.map((b) => `${b.replace(/\/+$/, "")}/v${best}/RELEASE-NOTES.md`)
          : allReleaseSources(releaseAssetUrl(best, "RELEASE-NOTES.md"), inMainlandChina());
        notes = await this.fetchFirstNotes(taggedNotesUrls);
      }

      let uiSyncedNow = false;
      if (best && this.autoSyncUiBundles && (!this.activeUiVer || compareVersions(best, this.activeUiVer) > 0)) {
        try {
          uiSyncedNow = await this.syncUiBundleForVersion(best);
        } catch (err) {
          this.log(`releases: UI bundle hot-sync for v${best} skipped (${err instanceof Error ? err.message : String(err)})`);
        }
      }

      const checkedAt = Date.now();
      const prevKnown = this.latestKnown;
      if (best && (!prevKnown || compareVersions(best, prevKnown) > 0)) {
        this.latestKnown = best;
        if (prevKnown !== null) {
          this.log(`releases: detected newer release v${best} (was v${prevKnown})`);
          this.onNewRelease?.(best);
        }
      } else if (uiSyncedNow && best) {
        this.onNewRelease?.(best);
      }

      const snap: RelayLatestSnapshot = {
        latest: best ?? this.latestKnown,
        ...(manifest ? { manifest } : {}),
        ...(notes ? { notes } : {}),
        checkedAt,
      };
      this.latestSnapshot = snap;
      return snap;
    })().finally(() => {
      if (this.latestInflight === task) this.latestInflight = null;
    });

    this.latestInflight = task;
    return task;
  }

  async handleLatest(req: IncomingMessage, res: ServerResponse, relayVersion: string): Promise<void> {
    const force = (req.url ?? "").includes("refresh=1");
    const snap = await this.checkLatestRelease(force);
    const body = JSON.stringify({
      ok: true,
      latest: snap.latest ?? this.latestKnown ?? relayVersion,
      relayVersion,
      manifest: snap.manifest ?? null,
      notes: snap.notes ?? null,
      checkedAt: snap.checkedAt,
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
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
