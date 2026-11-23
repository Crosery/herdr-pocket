import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConvEvent } from "@herdr-pocket/protocol";
import { foldConvEvents } from "../src/lib/chatFold.ts";

const sampleEvents: ConvEvent[] = [
  { id: "u1", session: "s", ts: 1, kind: "user_message", text: "分析并修改代码" },
  { id: "r1", session: "s", ts: 2, kind: "reasoning", text: "先查看三个关键文件" },
  { id: "c1", session: "s", ts: 3, kind: "tool_call", call_id: "call-1", name: "read_file", input: { path: "src/a.ts" } },
  { id: "c1r", session: "s", ts: 4, kind: "tool_result", call_id: "call-1", name: "read_file", output: "ok" },
  { id: "c2", session: "s", ts: 5, kind: "tool_call", call_id: "call-2", name: "edit_file", input: { path: "src/b.ts" } },
  { id: "c2r", session: "s", ts: 6, kind: "tool_result", call_id: "call-2", name: "edit_file", output: "edited" },
  { id: "r2", session: "s", ts: 7, kind: "reasoning", text: "再运行验证脚本" },
  { id: "c3", session: "s", ts: 8, kind: "tool_call", call_id: "call-3", name: "run_command", input: { CommandLine: "pnpm test" } },
  { id: "c3r", session: "s", ts: 9, kind: "tool_result", call_id: "call-3", name: "run_command", output: "PASS" },
  { id: "a1", session: "s", ts: 10, kind: "assistant_message", text: "全部完成。" },
];

test("foldConvEvents standard mode keeps collapsed thinking separate from grouped tools", () => {
  const rows = foldConvEvents(sampleEvents, "standard");
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["user", "thinking", "activity_group", "thinking", "tool", "assistant"],
  );
  const firstThought = rows[1];
  const grp = rows[2];
  assert.equal(firstThought?.kind, "thinking");
  if (firstThought?.kind === "thinking") assert.equal(firstThought.defaultOpen, false);
  assert.equal(grp?.kind, "activity_group");
  if (grp?.kind === "activity_group") {
    assert.equal(grp.tools.length, 2);
    assert.equal(grp.thoughts.length, 0);
    assert.deepEqual(
      grp.entries.map((e) => e.kind),
      ["tool", "tool"],
    );
    assert.equal(grp.defaultOpen, undefined);
    assert.equal(grp.hasFollowingAssistant, true);
  }
});

test("foldConvEvents standard mode folds consecutive retry system notices without merging standalone thinking", () => {
  const events: ConvEvent[] = [
    { id: "u1", session: "s", ts: 1, kind: "user_message", text: "继续" },
    { id: "s1", session: "s", ts: 2, kind: "system", text: "API error (attempt 1): 502" },
    { id: "s2", session: "s", ts: 3, kind: "system", text: "API error (attempt 2): 502" },
    { id: "r1", session: "s", ts: 4, kind: "reasoning", text: "重新检查" },
    { id: "a1", session: "s", ts: 5, kind: "assistant_message", text: "好了" },
  ];
  const standardRows = foldConvEvents(events, "standard");
  assert.deepEqual(
    standardRows.map((r) => r.kind),
    ["user", "activity_group", "thinking", "assistant"],
  );
  const expandedRows = foldConvEvents(events, "expanded");
  assert.deepEqual(
    expandedRows.map((r) => r.kind),
    ["user", "system", "system", "thinking", "assistant"],
  );
});

test("foldConvEvents compact mode folds thoughts and tools into a single activity_group", () => {
  const rows = foldConvEvents(sampleEvents, "compact");
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["user", "activity_group", "assistant"],
  );
  const grp = rows[1];
  if (grp?.kind === "activity_group") {
    assert.equal(grp.tools.length, 3);
    assert.equal(grp.thoughts.length, 2);
    assert.deepEqual(
      grp.entries.map((e) => e.kind),
      ["thinking", "tool", "tool", "thinking", "tool"],
    );
  }
});

test("foldConvEvents expanded mode separates thinking blocks and opens groups by default", () => {
  const rows = foldConvEvents(sampleEvents, "expanded");
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["user", "thinking", "activity_group", "thinking", "tool", "assistant"],
  );
  const firstThought = rows[1];
  const grp = rows[2];
  if (firstThought?.kind === "thinking") assert.equal(firstThought.defaultOpen, true);
  if (grp?.kind === "activity_group") {
    assert.equal(grp.defaultOpen, true);
    assert.equal(grp.tools.length, 2);
    assert.equal(grp.thoughts.length, 0);
  }
});
