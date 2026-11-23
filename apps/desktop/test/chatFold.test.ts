import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConvEvent } from "@herdr-pocket/protocol";
import { createBufferedEventMerger, foldConvEvents, mergeConvEvents, type ChatRow } from "../src/lib/chatFold.ts";
import {
  interleaveOptimisticSends,
  isAgentTurnBusy,
  reconcileOutgoingSends,
  shouldAutoDrainQueue,
  type OutgoingSendLike,
} from "../src/lib/chatQueueLogic.ts";
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

test("mergeConvEvents (compareConvEvents): orders same-pos ids numerically, kind tie-breakers, and pos vs missing pos by ts", () => {
  const events: ConvEvent[] = [
    // Missing pos with later ts must come AFTER pos "3118048" with earlier ts (not lexicographical "3..." > "1795...").
    { id: "late-no-pos", session: "s", ts: 1795_000_000_000, kind: "assistant_message", text: "after" },
    { id: "s10:c10", session: "s", ts: 1700_000_000_000, pos: "3118048", kind: "tool_call", call_id: "c10", name: "read_file", input: {} },
    { id: "s10:c0r", session: "s", ts: 1700_000_000_000, pos: "3118048", kind: "tool_result", call_id: "c0", name: "read_file", output: "ok" },
    { id: "s10:c2", session: "s", ts: 1700_000_000_000, pos: "3118048", kind: "tool_call", call_id: "c2", name: "read_file", input: {} },
    { id: "s10:a", session: "s", ts: 1700_000_000_000, pos: "3118048", kind: "assistant_message", text: "working" },
    { id: "s10:c0", session: "s", ts: 1700_000_000_000, pos: "3118048", kind: "tool_call", call_id: "c0", name: "read_file", input: {} },
    { id: "s10:r", session: "s", ts: 1700_000_000_000, pos: "3118048", kind: "reasoning", text: "think" },
    { id: "eff#10", session: "s", ts: 1700_000_000_100, pos: "3118050", kind: "user_message", text: "item 10" },
    { id: "eff#1", session: "s", ts: 1700_000_000_100, pos: "3118050", kind: "user_message", text: "item 1" },
    { id: "eff#0", session: "s", ts: 1700_000_000_100, pos: "3118050", kind: "user_message", text: "item 0" },
  ];

  const sorted = mergeConvEvents([], events);
  assert.deepEqual(
    sorted.map((e) => e.id),
    [
      "s10:r",
      "s10:a",
      "s10:c0",
      "s10:c2",
      "s10:c10",
      "s10:c0r",
      "eff#0",
      "eff#1",
      "eff#10",
      "late-no-pos",
    ],
  );
});

test("createBufferedEventMerger: holds pre-page SSE frames, coalesces post-page bursts, respects fallbackMs and dispose", async () => {
  const batches: string[][] = [];
  const merger = createBufferedEventMerger((evs) => {
    batches.push(evs.map((e) => e.id));
  }, 500);

  merger.onStreamEvent({ id: "sse-1", session: "s", ts: 20, pos: "2", kind: "assistant_message", text: "reply" });
  merger.onStreamEvent({ id: "sse-2", session: "s", ts: 30, pos: "3", kind: "turn_end" });
  assert.equal(batches.length, 0);

  merger.onInitialPage([{ id: "page-1", session: "s", ts: 10, pos: "1", kind: "user_message", text: "hi" }]);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], ["page-1", "sse-1", "sse-2"]);

  // Rapid post-page events coalesce into a single 16ms batch.
  merger.onStreamEvent({ id: "sse-3", session: "s", ts: 40, pos: "4", kind: "user_message", text: "next" });
  merger.onStreamEvent({ id: "sse-4", session: "s", ts: 50, pos: "5", kind: "assistant_message", text: "ok" });
  assert.equal(batches.length, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1], ["sse-3", "sse-4"]);
  merger.dispose();

  // Fallback timer flushes buffered SSE when initial page never arrives, and dispose cancels future work.
  const fallbackBatches: string[][] = [];
  const slowMerger = createBufferedEventMerger((evs) => {
    fallbackBatches.push(evs.map((e) => e.id));
  }, 30);
  slowMerger.onStreamEvent({ id: "late-1", session: "s", ts: 10, kind: "user_message", text: "solo" });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(fallbackBatches, [["late-1"]]);

  slowMerger.dispose();
  slowMerger.onStreamEvent({ id: "after-dispose", session: "s", ts: 20, kind: "user_message", text: "ignored" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fallbackBatches.length, 1);
});

test("interleaveOptimisticSends: places unconfirmed send before SSE reply without crossing completed turn_end", () => {
  const prevTurnEnd: ChatRow = { kind: "turn_end", id: "te-1", ts: 100_000 };
  const replyRow: ChatRow = { kind: "assistant", id: "a-new", text: "新的回复", ts: 105_000 };
  const rows: ChatRow[] = [
    { kind: "user", id: "u-old", text: "上一轮问题", ts: 95_000, attachedLines: [], attachedCount: 0 },
    { kind: "assistant", id: "a-old", text: "上一轮回答", ts: 98_000 },
    prevTurnEnd,
    // Simulate second-truncated transcript reply timestamp 500ms earlier than send.ts (within 1000ms slack).
    { ...replyRow, ts: 104_000 },
  ];
  const pendingSend: OutgoingSendLike = {
    id: "out-new",
    text: "刚发的追问",
    attachedCount: 0,
    ts: 104_500,
    state: "sent",
  };

  const timeline = interleaveOptimisticSends(rows, [pendingSend]);
  assert.deepEqual(
    timeline.map((item) => (item.kind === "row" ? item.row.id : `out:${item.send.id}`)),
    ["u-old", "a-old", "te-1", "out:out-new", "a-new"],
  );
});

test("foldConvEvents: coalesces Claude command XML, stdout, and effort switch into a single model_switch row", () => {
  const events: ConvEvent[] = [
    {
      id: "m-1",
      session: "s",
      ts: 200_000,
      kind: "system",
      text: "<command-name>/model</command-name>\n<command-args>opus</command-args>",
    },
    {
      id: "m-2",
      session: "s",
      ts: 200_200,
      kind: "system",
      text: "<local-command-stdout>Set model to opus</local-command-stdout>",
    },
    {
      id: "m-3",
      session: "s",
      ts: 201_000,
      kind: "user_message",
      synthetic: true,
      text: "/effort high",
    },
  ];

  const rows = foldConvEvents(events, "standard");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "model_switch");
  if (rows[0]?.kind === "model_switch") {
    assert.equal(rows[0].model, "opus");
    assert.equal(rows[0].thinking, "high");
  }
});

test("foldConvEvents: suppresses system reminders in standard mode, turns failed /model into command_result, and respects expanded mode", () => {
  const events: ConvEvent[] = [
    { id: "r-1", session: "s", ts: 10_000, kind: "system", subtype: "reminder", text: "<system-reminder>internal note</system-reminder>", summary: "系统提醒" },
    { id: "c-1", session: "s", ts: 11_000, kind: "system", subtype: "command", text: "<command-name>/model nonexistent</command-name>" },
    { id: "c-2", session: "s", ts: 11_100, kind: "system", subtype: "command_error", summary: "/model nonexistent", text: 'Error: Model "nonexistent" is not available.' },
    { id: "c-3", session: "s", ts: 12_000, kind: "system", subtype: "command_output", summary: "/cost", text: "Total cost: $0.05" },
  ];

  const std = foldConvEvents(events, "standard");
  assert.equal(std.some((r) => r.kind === "system"), false);
  assert.equal(std.some((r) => r.kind === "model_switch"), false);
  const cmdRows = std.filter((r) => r.kind === "command_result");
  assert.equal(cmdRows.length, 2);
  assert.equal(cmdRows[0]?.kind === "command_result" ? cmdRows[0].isError : false, true);
  assert.equal(cmdRows[1]?.kind === "command_result" ? cmdRows[1].command : "", "/cost");

  const noisyEvents: ConvEvent[] = [
    { id: "n-1", session: "s", ts: 100, kind: "system", subtype: "system_message", text: "<SYSTEM_MESSAGE>hidden</SYSTEM_MESSAGE>" },
    { id: "n-2", session: "s", ts: 101, kind: "system", subtype: "developer", text: "<session_context>cwd=/repo</session_context>" },
    { id: "n-3", session: "s", ts: 102, kind: "system", subtype: "compact_boundary", text: "compacted" },
  ];
  const filtered = foldConvEvents(noisyEvents, "standard");
  assert.deepEqual(filtered.map((r) => r.kind), ["compact_notice"]);

  const exp = foldConvEvents(events, "expanded");
  assert.equal(exp.some((r) => r.kind === "system"), true);
});

test("chatQueueLogic: slash commands reconcile via command_result, expire at 8s, and do not cross newer turns", () => {
  const send: OutgoingSendLike = { id: "s1", text: "/cost", attachedCount: 0, ts: 100_000, state: "sent" };
  const cmdRow: ChatRow = { kind: "command_result", id: "cmd1", command: "/cost", text: "Total cost: $0.01", isError: false, ts: 100_500 };
  const matched = reconcileOutgoingSends([send], [cmdRow], "idle", 101_000);
  assert.deepEqual(matched.matchedIds, ["s1"]);
  assert.equal(matched.awaitingReply, false);

  const expired = reconcileOutgoingSends([send], [], "idle", 109_000);
  assert.deepEqual(expired.expiredIds, ["s1"]);

  // Newer user turn at ts=110_000 must stay AFTER unmatched earlier slash send at ts=100_000
  const rows: ChatRow[] = [
    { kind: "user", id: "u1", text: "earlier prompt", ts: 90_000, attachedLines: [], attachedCount: 0 },
    { kind: "assistant", id: "a1", text: "earlier reply", ts: 95_000 },
    { kind: "turn_end", id: "te1", ts: 99_000 },
    { kind: "user", id: "u2", text: "newer prompt", ts: 110_000, attachedLines: [], attachedCount: 0 },
    { kind: "assistant", id: "a2", text: "newer reply", ts: 112_000 },
  ];
  const timeline = interleaveOptimisticSends(rows, [send]);
  assert.deepEqual(
    timeline.map((x) => (x.kind === "row" ? x.row.id : `out:${x.send.id}`)),
    ["u1", "a1", "te1", "out:s1", "u2", "a2"],
  );
});

test("chatQueueLogic: isAgentTurnBusy detects running tools on status flicker and keeps queued_terminal at bottom", () => {
  const runningToolRow: ChatRow = {
    kind: "tool",
    id: "t1",
    ts: 100_000,
    step: { id: "t1", callId: "c1", name: "Bash", category: "run", input: {}, summary: "pnpm test", ts: 100_000, running: true, isError: false },
  };
  assert.equal(isAgentTurnBusy("idle", [runningToolRow]), true);
  assert.equal(isAgentTurnBusy("working", []), true);
  assert.equal(isAgentTurnBusy("idle", [{ kind: "assistant", id: "a1", text: "done", ts: 102_000 }]), false);

  const qtSend: OutgoingSendLike = { id: "qt-1", text: "下一个任务", attachedCount: 0, ts: 99_500, state: "queued_terminal" };
  const rec = reconcileOutgoingSends([qtSend], [runningToolRow], "idle", 103_000);
  assert.equal(rec.awaitingReply, false);
  const segs = interleaveOptimisticSends([runningToolRow], rec.unmatched);
  assert.deepEqual(
    segs.map((x) => (x.kind === "row" ? x.row.id : `out:${x.send.id}`)),
    ["t1", "out:qt-1"],
  );
});
