import assert from "node:assert/strict";
import { test } from "node:test";
import { stageWorkspaceDragItem } from "../src/lib/dropPreview.ts";
import { resolveDropPath, type WorkspaceDragItem } from "../src/lib/fileDrag.ts";
import { moveTab, openFileTab, shellStore } from "../src/shell/shellStore.ts";

test("resolveDropPath & stageWorkspaceDragItem preserve same-host absPath and cross-host relative path", () => {
  const fileItem: WorkspaceDragItem = {
    agentKey: "h1/hc:t1",
    hostId: "h1",
    relPath: "src/index.ts",
    absPath: "/Users/dev/work/app/src/index.ts",
    name: "index.ts",
    kind: "file",
  };
  const dirItem: WorkspaceDragItem = {
    agentKey: "h1/hc:t1",
    hostId: "h1",
    relPath: "packages/protocol",
    absPath: "/Users/dev/work/app/packages/protocol",
    name: "protocol",
    kind: "dir",
  };

  assert.equal(resolveDropPath(fileItem, "h1"), "/Users/dev/work/app/src/index.ts");
  assert.equal(resolveDropPath(fileItem, "h2"), "./src/index.ts");

  const stagedFile = stageWorkspaceDragItem(fileItem, "h1");
  assert.equal(stagedFile.hostRef, "/Users/dev/work/app/src/index.ts");
  assert.equal(stagedFile.openPath, "src/index.ts");
  assert.equal(stagedFile.isDir, false);

  const stagedDir = stageWorkspaceDragItem(dirItem, "h2");
  assert.equal(stagedDir.hostRef, "./packages/protocol");
  assert.equal(stagedDir.isDir, true);
});

test("moveTab reorders tabs cleanly and openFileTab updates existing tab line range", () => {
  shellStore.set({
    tabs: [
      { id: "a:1", kind: "agent", agentKey: "1" },
      { id: "a:2", kind: "agent", agentKey: "2" },
      { id: "a:3", kind: "agent", agentKey: "3" },
    ],
    active: "a:1",
  });

  moveTab("a:1", 2);
  assert.deepEqual(shellStore.get().tabs.map((t) => t.id), ["a:2", "a:3", "a:1"]);

  openFileTab("1", "README.md", "README.md", { line: 4 });
  openFileTab("1", "README.md", "README.md", { line: 20, endLine: 25, absPath: "/Users/dev/README.md" });
  const fileTabs = shellStore.get().tabs.filter((t) => t.kind === "file");
  assert.equal(fileTabs.length, 1);
  assert.deepEqual(fileTabs[0], {
    id: "f:1:README.md",
    kind: "file",
    agentKey: "1",
    path: "README.md",
    title: "README.md",
    absPath: "/Users/dev/README.md",
    line: 20,
    endLine: 25,
  });
});
