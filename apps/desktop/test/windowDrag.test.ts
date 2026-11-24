import assert from "node:assert/strict";
import { test } from "node:test";
import { isWindowDragTarget } from "../src/lib/windowDrag.ts";

function el(tagName: string, attrs: Record<string, string | null> = {}) {
  return {
    tagName,
    hasAttribute: (k: string) => Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null,
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
  };
}

test("isWindowDragTarget allows empty tab bar / brand children and blocks interactive or explicit false targets", () => {
  const brand = el("div", { "data-tauri-drag-region": "deep" });
  const brandLogo = el("img");
  const tabsBar = el("div", { "data-tauri-drag-region": "deep" });
  const tabScroll = el("div");
  const dragGap = el("div");
  const tab = el("div", { role: "tab", "data-tauri-drag-region": "false" });
  const tabLabel = el("span");
  const btn = el("button", { "aria-label": "新建终端" });
  const btnSvg = el("svg");
  const splitSash = el("div", { role: "separator" });
  const exactStrip = el("div", { "data-tauri-drag-region": "" });
  const childOfExact = el("div");

  assert.equal(isWindowDragTarget([brandLogo, brand]), true);
  assert.equal(isWindowDragTarget([tabScroll, tabsBar]), true);
  assert.equal(isWindowDragTarget([dragGap, tabsBar]), true);
  assert.equal(isWindowDragTarget([tabLabel, tab, tabScroll, tabsBar]), false);
  assert.equal(isWindowDragTarget([btnSvg, btn, tabsBar]), false);
  assert.equal(isWindowDragTarget([splitSash, tabsBar]), false);
  assert.equal(isWindowDragTarget([exactStrip]), true);
  assert.equal(isWindowDragTarget([childOfExact, exactStrip]), false);
});
