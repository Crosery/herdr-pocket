import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAD_PAGES, PAD_SNIPPETS, padChar, padSpecial } from "../src/mobile/termpad.ts";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("mobile termpad key sequences match apps/mobile terminal keyboard", () => {
  assert.equal(padChar("c", { ctrl: true }), "\x03");
  assert.equal(padChar("a", { shift: true }), "A");
  assert.equal(padChar(" ", { ctrl: true }), "\x00");
  assert.equal(padSpecial("esc", {}), "\x1b");
  assert.equal(padSpecial("tab", { shift: true }), "\x1b[Z");
  assert.equal(padSpecial("up", { ctrl: true }), "\x1b[1;5A");
  assert.equal(PAD_PAGES.letters.length, 5);
  assert.equal(PAD_PAGES.symbols.length, 5);
  assert.ok(PAD_SNIPPETS.includes("/compact"));
});

test("MobileAppShell provides 4-tab parity (助理 first, Agents, 设备, 设置) and mobile-parity.css defines light/dark palettes", () => {
  const shellSrc = readFileSync(resolve(DESKTOP_ROOT, "src/mobile/MobileAppShell.tsx"), "utf8");
  assert.ok(shellSrc.includes('"assistant"'), "Assistant tab present");
  assert.ok(shellSrc.includes('"agents"'), "Agents tab present");
  assert.ok(shellSrc.includes('"devices"'), "Devices tab present");
  assert.ok(shellSrc.includes('"settings"'), "Settings tab present");
  assert.ok(shellSrc.includes("hideTabs"), "hides tabbar on full-screen agent detail");

  const drawerSrc = readFileSync(resolve(DESKTOP_ROOT, "src/mobile/MobileSidebarDrawer.tsx"), "utf8");
  assert.ok(drawerSrc.includes("<span>空间</span>"), "fixed 空间 section header present");
  assert.equal(drawerSrc.includes("aria-expanded"), false, "空间 header never folds");

  const cssPath = resolve(DESKTOP_ROOT, "src/styles/mobile-parity.css");
  assert.equal(existsSync(cssPath), true);
  const css = readFileSync(cssPath, "utf8");
  assert.ok(css.includes("#FFF8FB"), "mobile light gradient matches apps/mobile");
  assert.ok(css.includes("#221D2B"), "mobile dark gradient matches apps/mobile");
  assert.ok(css.includes("54px") && css.includes("30px"), "active tab indicator matches 54x30 pill");
  assert.ok(
    css.includes(".mp-shell .assistant-pane-header") && css.includes("--safe-top"),
    "mobile-parity.css must apply safe-area top inset to real AssistantView header",
  );
  assert.equal(css.includes(".assist-shell"), false, "stale .assist-shell selector must not linger");
  assert.equal(css.includes(".assist-header"), false, "stale .assist-header selector must not linger");
  assert.ok(css.includes(".mp-top-banners"), "top connection/call banners must respect safe-area top inset");
  assert.ok(css.includes(".mp-detail-root .mp-scroll"), "detail sub-panes must not duplicate top safe-area padding");
});
