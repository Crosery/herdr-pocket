import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConvEvent } from "@herdr-pocket/protocol";
import { foldConvEvents, mergeConvEvents } from "../src/lib/chatFold.ts";
import {
  KittyApcSplitter,
  KittyKeyboardState,
  encodeKittyKey,
  parseKittyGfxCommand,
  parseOsc66,
} from "../src/lib/kittyProtocol.ts";

test("mergeConvEvents: preserves reference identity when unchanged and sorts by numeric pos", () => {
  const e1: ConvEvent = { id: "a", session: "s", ts: 100, pos: "2", kind: "user_message", text: "hi" };
  const e2: ConvEvent = { id: "b", session: "s", ts: 101, pos: "10", kind: "assistant_message", text: "ok" };
  const e0: ConvEvent = { id: "c", session: "s", ts: 99, pos: "1", kind: "user_message", text: "first" };

  const initial = mergeConvEvents([], [e2, e1]);
  assert.deepEqual(initial.map((x) => x.id), ["a", "b"]);

  const sameRef = mergeConvEvents(initial, [
    { id: "a", session: "s", ts: 100, pos: "2", kind: "user_message", text: "hi" },
  ]);
  assert.equal(sameRef, initial);

  const prepended = mergeConvEvents(initial, [e0]);
  assert.deepEqual(prepended.map((x) => x.id), ["c", "a", "b"]);

  const updated = mergeConvEvents(prepended, [
    { id: "b", session: "s", ts: 101, pos: "10", kind: "assistant_message", text: "ok done", partial: false },
  ]);
  assert.equal(updated[2]?.kind === "assistant_message" ? updated[2].text : "", "ok done");
});

test("foldConvEvents: pairs tool_call + tool_result, collapses multi-tool runs, and handles orphan results", () => {
  const runningEvents: ConvEvent[] = [
    { id: "u1", session: "s", ts: 1, kind: "user_message", text: "查看几个文件并跑测试\n/tmp/a.png" },
    { id: "r1", session: "s", ts: 2, kind: "reasoning", text: "先检查源码结构" },
    { id: "c1", session: "s", ts: 3, kind: "tool_call", call_id: "call-1", name: "read_file", input: { path: "src/a.ts" } },
    { id: "c1r", session: "s", ts: 4, kind: "tool_result", call_id: "call-1", name: "read_file", output: "ok" },
    { id: "c2", session: "s", ts: 5, kind: "tool_call", call_id: "call-2", name: "read_file", input: { path: "src/b.ts" } },
    { id: "c2r", session: "s", ts: 6, kind: "tool_result", call_id: "call-2", name: "read_file", output: "ok" },
    { id: "c3", session: "s", ts: 7, kind: "tool_call", call_id: "call-3", name: "run_command", input: { CommandLine: "pnpm test" } },
  ];

  const runningRows = foldConvEvents(runningEvents);
  assert.equal(runningRows.length, 2);
  assert.equal(runningRows[0]?.kind, "user");
  if (runningRows[0]?.kind === "user") {
    assert.equal(runningRows[0].text, "查看几个文件并跑测试");
    assert.equal(runningRows[0].attachedCount, 1);
  }

  const grpRunning = runningRows[1];
  assert.equal(grpRunning?.kind, "activity_group");
  if (grpRunning?.kind === "activity_group") {
    assert.equal(grpRunning.running, true);
    assert.equal(grpRunning.tools.length, 3);
    assert.equal(grpRunning.thoughts.length, 1);
    assert.match(grpRunning.headline, /正在运行.*已调用 3 个工具/);
    assert.deepEqual(
      grpRunning.series.map((s) => `${s.name}:${s.count}:${s.running}`),
      ["read_file:2:false", "run_command:1:true"],
    );
  }

  const completedEvents: ConvEvent[] = [
    ...runningEvents,
    { id: "c3r", session: "s", ts: 8, kind: "tool_result", call_id: "call-3", name: "run_command", output: "PASS", is_error: false },
    { id: "a1", session: "s", ts: 9, kind: "assistant_message", text: "全部完成" },
  ];
  const completedRows = foldConvEvents(completedEvents);
  assert.equal(completedRows.length, 3);
  if (completedRows[1]?.kind === "activity_group") {
    assert.equal(completedRows[1].running, false);
    assert.equal(completedRows[1].headline, "已调用 3 个工具");
    assert.equal(completedRows[1].failedCount, 0);
  }

  // Orphan tool_result whose tool_call was before the loaded page still pairs cleanly into a single step.
  const orphanRows = foldConvEvents([
    { id: "or1", session: "s", ts: 10, kind: "tool_result", call_id: "missing-call", name: "read_file", output: "done", is_error: false },
  ]);
  assert.equal(orphanRows.length, 1);
  assert.equal(orphanRows[0]?.kind, "tool");
  if (orphanRows[0]?.kind === "tool") {
    assert.equal(orphanRows[0].step.running, false);
    assert.equal(orphanRows[0].step.result?.output, "done");
  }
});

test("kittyProtocol: APC splitter across chunks, graphics headers, OSC 66 sizing, and CSI u keys", () => {
  const splitter = new KittyApcSplitter();
  const s1 = splitter.push("hello \x1b");
  const s2 = splitter.push("_Gf=100,a=T,i=7;AQID\x1b");
  const s3 = splitter.push("\\ world");
  const all = [...s1, ...s2, ...s3];
  assert.deepEqual(all, [
    { kind: "vt", data: "hello " },
    { kind: "kitty", raw: "f=100,a=T,i=7;AQID" },
    { kind: "vt", data: " world" },
  ]);

  const cmd = parseKittyGfxCommand("a=T,f=100,c=20,r=8,i=7,m=1;AAAA");
  assert.equal(cmd.action, "T");
  assert.equal(cmd.format, 100);
  assert.equal(cmd.cols, 20);
  assert.equal(cmd.rows, 8);
  assert.equal(cmd.id, 7);
  assert.equal(cmd.more, true);
  assert.equal(cmd.payload, "AAAA");

  const sized = parseOsc66("s=2:w=4;Hi");
  assert.ok(sized);
  assert.equal(sized.scale, 2);
  assert.equal(sized.width, 4);
  assert.equal(sized.text, "Hi");
  assert.equal(sized.cellsWide, 8);

  // Kitty U+10EEEE virtual image placeholders must be ignored by OSC 66 text-sizing.
  const virtualPlaceholder = String.fromCodePoint(0x10eeee);
  assert.equal(parseOsc66(`s=2;${virtualPlaceholder}`), null);

  const kb = new KittyKeyboardState();
  assert.equal(encodeKittyKey({ key: "Enter", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }, 0, 0, true), null);
  kb.push(false, 1);
  assert.equal(
    encodeKittyKey({ key: "Enter", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }, kb.current(false), 0, true),
    "\x1b[13;2u",
  );
  assert.equal(
    encodeKittyKey({ key: "Tab", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }, kb.current(false), 0, true),
    "\x1b[9;2u",
  );
  kb.pop(false, 1);
  assert.equal(kb.current(false), 0);
});
