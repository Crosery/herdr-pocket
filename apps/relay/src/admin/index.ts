import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(HERE, "dist");
const ASSETS_DIR = join(DIST_DIR, "admin-assets");

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/** GET /admin: serves the built React + Radix Web Console HTML shell. */
export function adminPage(): string {
  return readFileSync(join(DIST_DIR, "index.html"), "utf8");
}

/**
 * Safely resolves an asset inside `dist/admin-assets` for `/admin-assets/*`
 * and `/admin/admin-assets/*`, blocking path traversal and symlinks outside root.
 */
export function adminAsset(rawRel: string): { body: Buffer; type: string; immutable: boolean } | null {
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
    rootReal = realpathSync(ASSETS_DIR);
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
    return {
      body: readFileSync(real),
      type: MIME[ext] ?? "application/octet-stream",
      immutable: !decoded.includes("/"),
    };
  } catch {
    return null;
  }
}
