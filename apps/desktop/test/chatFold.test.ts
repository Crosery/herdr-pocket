import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConvEvent } from "@herdr-pocket/protocol";
import { foldConvEvents, mergeConvEvents, type ChatRow } from "../src/lib/chatFold.ts";
import { reconcileOutgoingSends, shouldAutoDrainQueue, type OutgoingSendLike } from "../src/lib/chatQueueLogic.ts";
import {
  KittyApcSplitter,
  KittyKeyboardState,
  encodeKittyKey,
  parseKittyGfxCommand,
  parseOsc66,
  parsePngDimensions,
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

  const runningRows = foldConvEvents(runningEvents, "compact");
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
  const completedRows = foldConvEvents(completedEvents, "compact");
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
  assert.equal(encodeKittyKey({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, 0, 0, true), null);
  assert.equal(encodeKittyKey({ key: "Enter", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }, 0, 0, true), "\x1b[13;2u");
  assert.equal(encodeKittyKey({ key: "Enter", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }, 0, 0, true, false, true), "\x1b\r");
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

test("parsePngDimensions reads IHDR width/height and rejects non-PNG bytes", () => {
  const pngHeader = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x02, 0x80, // 640
    0x00, 0x00, 0x01, 0xe0, // 480
  ]);
  assert.deepEqual(parsePngDimensions(pngHeader), { width: 640, height: 480 });
  assert.equal(parsePngDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(parsePngDimensions(new Uint8Array(24)), null);
});

test("chatQueue: reconcileOutgoingSends dedupes confirmed messages and tracks awaitingReply", () => {
  const s1: OutgoingSendLike = {
    id: "out-1",
    text: "帮我检查一下",
    attachedCount: 1,
    ts: 100_000,
    state: "sent",
  };
  const s2: OutgoingSendLike = {
    id: "out-2",
    text: "第二条还没入库",
    attachedCount: 0,
    ts: 102_000,
    state: "sending",
  };
  const sErr: OutgoingSendLike = {
    id: "out-3",
    text: "失败消息",
    attachedCount: 0,
    ts: 103_000,
    state: "failed",
  };

  const rows: ChatRow[] = [
    {
      kind: "user",
      id: "u-1",
      text: "帮我检查一下",
      ts: 100_500,
      attachedLines: ["/tmp/shot.png"],
      attachedCount: 1,
    },
  ];

  const r1 = reconcileOutgoingSends([s1, s2, sErr], rows, "idle", 105_000);
  assert.deepEqual(r1.matchedIds, ["out-1"]);
  assert.deepEqual(r1.expiredIds, []);
  assert.deepEqual(
    r1.unmatched.map((x) => x.id),
    ["out-2", "out-3"],
  );
  assert.equal(r1.awaitingReply, true);

  // Once the assistant answers after the latest send, awaitingReply clears.
  const withReply: ChatRow[] = [
    ...rows,
    { kind: "user", id: "u-2", text: "第二条还没入库", ts: 102_200, attachedLines: [], attachedCount: 0 },
    { kind: "assistant", id: "a-1", text: "好的", ts: 104_000 },
  ];
  const r2 = reconcileOutgoingSends([s1, s2], withReply, "done", 106_000);
  assert.deepEqual(r2.matchedIds, ["out-1", "out-2"]);
  assert.equal(r2.awaitingReply, false);
});

test("chatQueue: shouldAutoDrainQueue only drains when online idle/done after cooldown", () => {
  assert.equal(shouldAutoDrainQueue("idle", true, 0, false, 10_000), true);
  assert.equal(shouldAutoDrainQueue("done", true, 5_000, false, 10_000), true);
  assert.equal(shouldAutoDrainQueue("working", true, 0, false, 10_000), false);
  assert.equal(shouldAutoDrainQueue("blocked", true, 0, false, 10_000), false);
  assert.equal(shouldAutoDrainQueue("unknown", true, 0, false, 10_000), false);
  assert.equal(shouldAutoDrainQueue("idle", false, 0, false, 10_000), false);
  assert.equal(shouldAutoDrainQueue("idle", true, 0, true, 10_000), false);
  assert.equal(shouldAutoDrainQueue("done", true, 8_000, false, 10_000), false);
});
