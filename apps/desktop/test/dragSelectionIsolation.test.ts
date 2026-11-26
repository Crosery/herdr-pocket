import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("cross-tab and cross-pane drag selection isolation guards remain wired", () => {
  const shellCss = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8");
  const shellWork = readFileSync(new URL("../src/shell/ShellWork.tsx", import.meta.url), "utf8");
  const fileDrag = readFileSync(new URL("../src/lib/fileDrag.ts", import.meta.url), "utf8");
  const agentsView = readFileSync(new URL("../src/views/AgentsView.tsx", import.meta.url), "utf8");

  assert.match(shellCss, /\.v3-tab-layer\.is-hidden\s*\{[\s\S]*content-visibility:\s*hidden;[\s\S]*user-select:\s*none\s*!important;/);
  assert.match(shellCss, /\.v3-split-stage\.is-select-locked\s*>\s*\.v3-split-slot:not\(\.is-select-owner\)/);
  assert.match(shellCss, /:root\[data-shell-dragging="true"\]/);

  assert.match(shellWork, /inert=\{!isTabActive \|\| undefined\}/);
  assert.match(shellWork, /classList\.add\("is-select-owner"\)/);
  assert.match(shellWork, /classList\.add\("is-select-locked"\)/);

  assert.match(fileDrag, /dataset\.shellDragging\s*=\s*"true"/);
  assert.match(fileDrag, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);

  assert.match(agentsView, /inert=\{activeMode !== "term" \|\| !visible \? true : undefined\}/);
});
