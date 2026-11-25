import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  MAX_WEBGL_POOL,
  acquireWebglSlot,
  getActiveWebglPoolCount,
  markWebglSlotInactive,
  releaseWebglSlot,
  resetWebglPoolForTest,
} from "../src/lib/terminalWebglPool.ts";

afterEach(() => {
  resetWebglPoolForTest();
});

test("terminalWebglPool keeps up to MAX_WEBGL_POOL warm slots and reactivates in O(1)", () => {
  const keys = Array.from({ length: MAX_WEBGL_POOL }, (_, i) => Symbol(`t${i}`));
  let evictions = 0;

  for (const k of keys) {
    assert.equal(acquireWebglSlot(k, () => { evictions += 1; }), true);
    markWebglSlotInactive(k);
  }
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  assert.equal(evictions, 0);

  // Reactivating an already warm slot keeps it in pool without triggering eviction.
  assert.equal(acquireWebglSlot(keys[0]!, () => { evictions += 1; }), true);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  assert.equal(evictions, 0);
});

test("terminalWebglPool evicts oldest inactive LRU slot asynchronously on overflow", async () => {
  const keys = Array.from({ length: MAX_WEBGL_POOL }, (_, i) => Symbol(`t${i}`));
  const evicted: string[] = [];

  for (let i = 0; i < keys.length; i += 1) {
    const label = `t${i}`;
    assert.equal(acquireWebglSlot(keys[i]!, () => evicted.push(label)), true);
    markWebglSlotInactive(keys[i]!);
  }
  // Touch t0 so t1 becomes the oldest inactive LRU entry.
  assert.equal(acquireWebglSlot(keys[0]!, () => evicted.push("t0")), true);
  markWebglSlotInactive(keys[0]!);

  const extra = Symbol("extra");
  assert.equal(acquireWebglSlot(extra, () => evicted.push("extra")), true);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  // Victim disposal must not block the synchronous click/acquire path.
  assert.deepEqual(evicted, []);

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(evicted, ["t1"]);
});

test("terminalWebglPool refuses to evict active panes and cancels pending eviction if re-acquired", async () => {
  const activeKeys = Array.from({ length: MAX_WEBGL_POOL }, (_, i) => Symbol(`active${i}`));
  let evictions = 0;

  for (const k of activeKeys) {
    assert.equal(acquireWebglSlot(k, () => { evictions += 1; }), true);
  }
  const ninth = Symbol("ninth");
  assert.equal(acquireWebglSlot(ninth, () => { evictions += 1; }), false);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  assert.equal(evictions, 0);

  // Release one active slot to make room, test cancel-on-reacquire race safety.
  releaseWebglSlot(activeKeys[0]!);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL - 1);

  const victim = Symbol("victim");
  let victimEvicted = 0;
  assert.equal(acquireWebglSlot(victim, () => { victimEvicted += 1; }), true);
  markWebglSlotInactive(victim);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);

  // Acquire another slot, scheduling async eviction of `victim`.
  const challenger = Symbol("challenger");
  assert.equal(acquireWebglSlot(challenger, () => {}), true);
  // Free an active slot and immediately re-acquire `victim` before macrotask fires.
  releaseWebglSlot(activeKeys[1]!);
  assert.equal(acquireWebglSlot(victim, () => { victimEvicted += 1; }), true);

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(victimEvicted, 0);
});
