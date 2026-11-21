import assert from "node:assert/strict";
import test from "node:test";
import { createStore, liveStore } from "../src/lib/store.ts";

test("createStore replaces primitive states without object spreading", () => {
  const idStore = createStore<string | null>(null);
  assert.equal(idStore.get(), null);

  let notifications = 0;
  const unsub = idStore.subscribe(() => {
    notifications += 1;
  });

  idStore.set("host-12345");
  assert.equal(typeof idStore.get(), "string");
  assert.equal(idStore.get(), "host-12345");

  idStore.set("host-999");
  assert.equal(idStore.get(), "host-999");

  idStore.set(null);
  assert.equal(idStore.get(), null);
  assert.equal(notifications, 3);
  unsub();
});

test("createStore still merges partial object patches and replaces arrays", () => {
  const objStore = createStore({ a: 1, b: "two" });
  objStore.set({ b: "updated" });
  assert.deepEqual(objStore.get(), { a: 1, b: "updated" });

  const arrStore = createStore<string[]>(["x"]);
  arrStore.set(["y", "z"]);
  assert.deepEqual(arrStore.get(), ["y", "z"]);
});

test("liveStore initializes spaces map", () => {
  assert.deepEqual(liveStore.get().spaces, {});
});
