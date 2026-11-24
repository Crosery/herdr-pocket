import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { detectStandaloneDisplay } from "../src/lib/pwa.ts";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("PWA manifest.webmanifest, icons, and sw.js are valid and non-empty", () => {
  const manifestPath = resolve(DESKTOP_ROOT, "public/manifest.webmanifest");
  const swPath = resolve(DESKTOP_ROOT, "public/sw.js");
  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(swPath), true);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    name?: string;
    short_name?: string;
    display?: string;
    start_url?: string;
    scope?: string;
    icons?: Array<{ src?: string; sizes?: string; type?: string }>;
  };
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    assert.ok(icon.src, "manifest icon entry must declare src");
    const rel = icon.src.replace(/^\.\//, "");
    const abs = resolve(DESKTOP_ROOT, "public", rel);
    assert.equal(existsSync(abs), true, `missing icon file: ${abs}`);
    assert.ok(statSync(abs).size > 1000, `icon file looks empty: ${abs}`);
  }

  const sw = readFileSync(swPath, "utf8");
  assert.equal(sw.includes("SKIP_WAITING"), true);
});

test("detectStandaloneDisplay respects navigator.standalone and matchMedia standalone", () => {
  const g = globalThis as { window?: unknown };
  const prevWindow = g.window;
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const setNavigator = (val: unknown) =>
    Object.defineProperty(globalThis, "navigator", {
      value: val,
      configurable: true,
      writable: true,
    });
  try {
    setNavigator(undefined);
    assert.equal(detectStandaloneDisplay(), false);

    setNavigator({ standalone: true });
    g.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(detectStandaloneDisplay(), true);

    setNavigator({ standalone: false });
    g.window = {
      matchMedia: (q: string) => ({ matches: q === "(display-mode: standalone)" }),
    };
    assert.equal(detectStandaloneDisplay(), true);

    g.window = { matchMedia: () => ({ matches: false }) };
    assert.equal(detectStandaloneDisplay(), false);
  } finally {
    g.window = prevWindow;
    if (prevNavDesc) {
      Object.defineProperty(globalThis, "navigator", prevNavDesc);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  }
});

test("app.css avoids duplicate H5 bottom safe-area padding and keeps mobile breakpoints ordered", () => {
  const css = readFileSync(resolve(DESKTOP_ROOT, "src/styles/app.css"), "utf8");

  const h5RootBlock = /html\[data-client="h5"\],\s*html\[data-client="h5"\] body,\s*html\[data-client="h5"\] #root\s*\{[^}]*\}/.exec(css);
  assert.ok(h5RootBlock, "found html[data-client=h5] root block");
  assert.equal(h5RootBlock[0].includes("padding-bottom"), false);

  const authBlock = /\.h5-auth-screen\s*\{[^}]*\}/.exec(css);
  assert.ok(authBlock, "found .h5-auth-screen block");
  assert.equal(authBlock[0].includes("height: 100dvh"), true);
  assert.equal(authBlock[0].includes("overflow-y: auto"), true);

  const idx1099 = css.indexOf("@media (max-width: 1099.98px)");
  const idx859 = css.indexOf("@media (max-width: 859.98px)");
  assert.ok(idx1099 > 0 && idx859 > 0);
  assert.ok(idx1099 < idx859, "@media (max-width: 1099.98px) must come before @media (max-width: 859.98px)");
});
