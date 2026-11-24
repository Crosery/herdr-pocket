import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { formatSidebarAgentRow } from "../src/shell/sidebarAgentRow.ts";
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, resolveInitialSidebarWidth } from "../src/lib/store.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("formatSidebarAgentRow preserves task titles and deduplicates redundant prefixes or machine labels", () => {
  // Real task title on remote machine -> primary keeps full title, secondary shows space · machine
  assert.deepEqual(
    formatSidebarAgentRow(
      { name: "修复登录重连异常", title: "修复登录重连异常", localId: "a1", harness: "claude", where: "伊吹工坊", isShell: false },
      { showMachine: true, machineName: "主力笔记本" },
    ),
    { primary: "修复登录重连异常", secondary: "伊吹工坊 · 主力笔记本" },
  );

  // Generic terminal title on remote machine -> primary carries space · 终端, secondary shows machine
  assert.deepEqual(
    formatSidebarAgentRow(
      { name: "", title: "终端", localId: "s1", harness: "zsh", where: "弹唱", isShell: true },
      { showMachine: true, machineName: "主力笔记本" },
    ),
    { primary: "弹唱 · 终端", secondary: "主力笔记本" },
  );

  // Generic harness title locally -> primary carries space · harness, secondary is null
  assert.deepEqual(
    formatSidebarAgentRow(
      { name: "", title: "claude", localId: "c1", harness: "claude", where: "测试", isShell: false },
      { showMachine: false },
    ),
    { primary: "测试 · claude", secondary: null },
  );

  // Title already prefixed with space -> strip duplicate prefix for primary and place space in secondary
  assert.deepEqual(
    formatSidebarAgentRow(
      { name: "酒吧 · 核对库存", title: "酒吧 · 核对库存", localId: "c2", harness: "codex", where: "酒吧", isShell: false },
      { showMachine: false },
    ),
    { primary: "核对库存", secondary: "酒吧" },
  );
});

test("sidebar width default widens to 268 and migrates legacy default 236 once", () => {
  assert.equal(DEFAULT_SIDEBAR_WIDTH, 268);
  assert.equal(resolveInitialSidebarWidth({}), 268);
  assert.equal(resolveInitialSidebarWidth({ sidebarWidth: 236 }), 268);
  assert.equal(resolveInitialSidebarWidth({ sidebarWidth: 236, sidebarWidthV2: true }), 236);
  assert.equal(resolveInitialSidebarWidth({ sidebarWidth: 312 }), 312);
  assert.equal(resolveInitialSidebarWidth({ sidebarWidth: 120 }), MIN_SIDEBAR_WIDTH);
  assert.equal(resolveInitialSidebarWidth({ sidebarWidth: 900 }), MAX_SIDEBAR_WIDTH);
});

test("desktop shell header alignment, macOS traffic-light clearance, and CSP rules are enforced", () => {
  const css = readFileSync(resolve(ROOT, "src/styles/shell.css"), "utf8");
  const brand = /\.v3-brand\s*\{[^}]*\}/.exec(css);
  assert.ok(brand, "found .v3-brand block");
  assert.equal(brand[0].includes("height: 42px"), true);
  assert.equal(brand[0].includes("border-bottom: 1px solid var(--v3-border)"), true);

  const tabs = /\.v3-tabs\s*\{[^}]*\}/.exec(css);
  assert.ok(tabs, "found .v3-tabs block");
  assert.equal(tabs[0].includes("height: 42px"), true);
  assert.equal(tabs[0].includes("border-bottom: 1px solid var(--v3-border)"), true);

  assert.equal(css.includes("var(--tl-safe-left, 88px)"), true);
  assert.equal(css.includes(".v3-tabs.lights"), true);
  assert.equal(/\.v3-brand-name\s*\{[^}]*overflow:\s*hidden/.test(css), true);

  const conf = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
    app: { security: { csp: Record<string, string> } };
  };
  const csp = conf.app.security.csp;
  assert.equal(csp["frame-src"]?.includes("https: http:"), true);
  assert.equal(csp["img-src"]?.includes("https: http:"), true);
  assert.equal(csp["media-src"]?.includes("https: http:"), true);
});
