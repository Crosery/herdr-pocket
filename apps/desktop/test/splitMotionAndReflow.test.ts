import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupAgentByKey } from "../src/lib/store.ts";
import {
  collapsedEntryUnitRect,
  easeOutQuart,
  lerpUnitRect,
  proposeGridFast,
  unitRectToCss,
} from "../src/shell/splitMotion.ts";

test("splitMotion squeeze interpolation keeps total span conserved and hits seam bounds at t=0 and t=1", () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const left = { x: 0, y: 0, w: 0.5, h: 1 };
  const right = { x: 0.5, y: 0, w: 0.5, h: 1 };

  const rightEntry = collapsedEntryUnitRect(right, left);
  assert.deepEqual(rightEntry, { x: 1, y: 0, w: 0, h: 1 });

  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const k = easeOutQuart(t);
    const lRect = lerpUnitRect(full, left, k);
    const rRect = lerpUnitRect(rightEntry, right, k);
    assert.ok(Math.abs(lRect.w + rRect.w - 1) < 1e-6, `sum mismatch at t=${t}`);
    assert.ok(Math.abs(lRect.w - rRect.x) < 1e-6, `seam mismatch at t=${t}`);
  }

  assert.deepEqual(unitRectToCss(left, 8), {
    left: "0%",
    top: "0%",
    width: "calc(50% - 4px)",
    height: "100%",
  });
  assert.deepEqual(unitRectToCss(right, 8), {
    left: "calc(50% + 4px)",
    top: "0%",
    width: "calc(50% - 4px)",
    height: "100%",
  });

  const top = { x: 0, y: 0, w: 1, h: 0.5 };
  const bottom = { x: 0, y: 0.5, w: 1, h: 0.5 };
  assert.deepEqual(collapsedEntryUnitRect(bottom, top), { x: 0, y: 1, w: 1, h: 0 });
  assert.deepEqual(collapsedEntryUnitRect(top, bottom), { x: 0, y: 0, w: 1, h: 0 });
  assert.deepEqual(collapsedEntryUnitRect(left, right), { x: 0, y: 0, w: 0, h: 1 });
});

test("proposeGridFast computes floored cols/rows and rejects zero geometry", () => {
  assert.equal(proposeGridFast(0, 400, 8, 16), null);
  assert.equal(proposeGridFast(800, 0, 8, 16), null);
  assert.equal(proposeGridFast(800, 400, 0, 16), null);
  assert.deepEqual(proposeGridFast(805, 408, 8, 16), { cols: 100, rows: 25 });
  assert.deepEqual(proposeGridFast(6, 10, 8, 16), { cols: 2, rows: 1 });
});

test("lookupAgentByKey locates host-prefixed keys directly and handles missing keys cleanly", () => {
  const byHost = {
    h1: [{ key: "h1/hc:t1" } as any, { key: "h1/hc:t2" } as any],
    h2: [{ key: "h2/hc:t9" } as any],
  };
  assert.equal(lookupAgentByKey(byHost, "h2/hc:t9")?.key, "h2/hc:t9");
  assert.equal(lookupAgentByKey(byHost, "h1/hc:missing"), undefined);
  assert.equal(lookupAgentByKey(byHost, null), undefined);
});
