import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(HERE, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

export function hasWebBundle(): boolean {
  return existsSync(join(DIST_DIR, "index.html"));
}

/** GET /app/: serves the shared subpath-safe H5 web client HTML shell. */
export function webPage(): string | null {
  try {
    return readFileSync(join(DIST_DIR, "index.html"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Safely resolves any static file inside `apps/relay/src/web/dist` (such as
 * `./assets/...` or `./favicon.ico`), blocking traversal and symlinks outside root.
 */
export function webAsset(rawRel: string): { body: Buffer; type: string; immutable: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRel);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/")) return null;
  const parts = decoded.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;

  let rootReal: string;
  try {
    rootReal = realpathSync(DIST_DIR);
  } catch {
    return null;
  }

  const candidate = resolve(rootReal, decoded);
  if (!candidate.startsWith(rootReal + sep)) return null;

  try {
    const real = realpathSync(candidate);
    if (!real.startsWith(rootReal + sep)) return null;
    if (!statSync(real).isFile()) return null;
    const ext = extname(real).toLowerCase();
    const isHashedViteChunk = /^assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(decoded);
    return {
      body: readFileSync(real),
      type: MIME[ext] ?? "application/octet-stream",
      immutable: isHashedViteChunk,
    };
  } catch {
    return null;
  }
}
