import test from "node:test";
import assert from "node:assert/strict";
import { CaptionPacer } from "../src/assistant/captions.ts";
import { taskTitle } from "../src/assistant/speech.ts";

test("caption pacer: first update at once, then the newest one per window; cancel drops what waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000;
  const pacer = new CaptionPacer(200, () => now);
  const sent: string[] = [];
  pacer.push("a", () => sent.push("a1"));
  now += 10;
  pacer.push("a", () => sent.push("a2"));
  pacer.push("a", () => sent.push("a3"));
  pacer.push("b", () => sent.push("b1"));
  assert.deepEqual(sent, ["a1", "b1"]);
  now += 190;
  t.mock.timers.tick(190);
  assert.deepEqual(sent, ["a1", "b1", "a3"]);

  now += 50;
  pacer.push("a", () => sent.push("a4"));
  pacer.cancel("a");
  now += 300;
  t.mock.timers.tick(300);
  assert.deepEqual(sent, ["a1", "b1", "a3"]);
  // After a cancel the answer starts fresh.
  pacer.push("a", () => sent.push("a5"));
  assert.deepEqual(sent, ["a1", "b1", "a3", "a5"]);
  pacer.clear();
});

test("task chip title: the request without the speaker label or the context", () => {
  assert.equal(
    taskTitle("我：你帮我看一下那些 agent 都在干嘛，就是它们详细干了什么东西。正在说的是：所有在跑的 agent。"),
    "你帮我看一下那些 agent 都在干嘛，就是它们详细干了什么东西",
  );
  assert.equal(taskTitle("看看上线检查的状态"), "看看上线检查的状态");
  assert.equal(taskTitle("我: 给 backend 发一句 继续"), "给 backend 发一句 继续");
  assert.equal(taskTitle("正在说的是：backend"), "正在说的是：backend");
});
