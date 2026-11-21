import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeClickableFilePath, openAgentFileTarget, parseFileTarget } from "../src/lib/openFileTarget.ts";
import { shellStore } from "../src/shell/shellStore.ts";

test("parseFileTarget handles file:// URIs, line anchors, cwd stripping, and external paths", () => {
  const rel = parseFileTarget("src/lib/openFileTarget.ts#L12-L24", "/Users/dev/work/app");
  assert.deepEqual(rel, {
    path: "src/lib/openFileTarget.ts",
    title: "openFileTarget.ts",
    absPath: "/Users/dev/work/app/src/lib/openFileTarget.ts",
    line: 12,
    endLine: 24,
  });

  const fileUri = parseFileTarget("file:///Users/dev/work/app/docs/My%20Guide.md#L5", "/Users/dev/work/app");
  assert.deepEqual(fileUri, {
    path: "docs/My Guide.md",
    title: "My Guide.md",
    absPath: "/Users/dev/work/app/docs/My Guide.md",
    line: 5,
  });

  // Home tilde equivalence between ~/... cwd and /Users/<name>/... file link
  const tildeMatch = parseFileTarget("/Users/dev/work/app/src/main.rs:42:9", "~/work/app");
  assert.deepEqual(tildeMatch, {
    path: "src/main.rs",
    title: "main.rs",
    absPath: "/Users/dev/work/app/src/main.rs",
    line: 42,
  });

  // External attachment path outside workspace keeps full absPath for local_read_file / extraRoots
  const ext = parseFileTarget("/Users/dev/.local/state/herdr-core/default/files/t1/shot.png", "/Users/dev/work/app");
  assert.deepEqual(ext, {
    path: "/Users/dev/.local/state/herdr-core/default/files/t1/shot.png",
    title: "shot.png",
    absPath: "/Users/dev/.local/state/herdr-core/default/files/t1/shot.png",
  });
});

test("looksLikeClickableFilePath distinguishes code/doc paths from URLs and plain prose", () => {
  assert.equal(looksLikeClickableFilePath("src/App.tsx"), true);
  assert.equal(looksLikeClickableFilePath("apps/desktop/src/lib/markdown.tsx#L10-L20"), true);
  assert.equal(looksLikeClickableFilePath("file:///Users/dev/pic.png"), true);
  assert.equal(looksLikeClickableFilePath("Cargo.toml:14"), true);
  assert.equal(looksLikeClickableFilePath("https://pocket.example.com/docs"), false);
  assert.equal(looksLikeClickableFilePath("pocket.example.com"), false);
  assert.equal(looksLikeClickableFilePath("mailto:user@example.com"), false);
});

test("openAgentFileTarget opens a FileTab with parsed line range and absPath", () => {
  shellStore.set({ tabs: [], active: null });
  const ok = openAgentFileTarget(
    { key: "h1/hc:t1", cwd: "/Users/dev/work/app" },
    "/Users/dev/work/app/README.md#L10-L15",
  );
  assert.equal(ok, true);
  const st = shellStore.get();
  assert.equal(st.tabs.length, 1);
  assert.deepEqual(st.tabs[0], {
    id: "f:h1/hc:t1:README.md",
    kind: "file",
    agentKey: "h1/hc:t1",
    path: "README.md",
    title: "README.md",
    absPath: "/Users/dev/work/app/README.md",
    line: 10,
    endLine: 15,
  });
});
