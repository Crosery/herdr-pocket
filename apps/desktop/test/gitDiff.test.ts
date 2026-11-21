import assert from "node:assert/strict";
import test from "node:test";
import { buildSplitDiffRows, parseUnifiedPatch } from "../src/lib/gitDiff.ts";

const SAMPLE_PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 20;",
  "+const c = 30;",
  " const d = 4;",
].join("\n");

test("parseUnifiedPatch tracks line numbers across hunks", () => {
  const lines = parseUnifiedPatch(SAMPLE_PATCH);
  assert.equal(lines.length, 6);
  assert.equal(lines[0]!.kind, "hunk");
  assert.deepEqual([lines[1]!.oldNo, lines[1]!.newNo, lines[1]!.kind], [1, 1, "ctx"]);
  assert.deepEqual([lines[2]!.oldNo, lines[2]!.newNo, lines[2]!.kind], [2, null, "del"]);
  assert.deepEqual([lines[3]!.oldNo, lines[3]!.newNo, lines[3]!.kind], [null, 2, "add"]);
  assert.deepEqual([lines[4]!.oldNo, lines[4]!.newNo, lines[4]!.kind], [null, 3, "add"]);
  assert.deepEqual([lines[5]!.oldNo, lines[5]!.newNo, lines[5]!.kind], [3, 4, "ctx"]);
});

test("buildSplitDiffRows aligns deletions and additions side by side", () => {
  const rows = buildSplitDiffRows(SAMPLE_PATCH);
  assert.equal(rows.length, 5);
  assert.equal(rows[0]!.kind, "hunk");
  assert.deepEqual(rows[2]!, {
    kind: "pair",
    left: { no: 2, kind: "del", text: "const b = 2;" },
    right: { no: 2, kind: "add", text: "const b = 20;" },
  });
  assert.deepEqual(rows[3]!, {
    kind: "pair",
    left: { no: null, kind: "empty", text: "" },
    right: { no: 3, kind: "add", text: "const c = 30;" },
  });
});
