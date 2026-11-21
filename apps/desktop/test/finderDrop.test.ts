import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDroppedFilesSafe,
  readOsDraggedPaths,
  stageOsDraggedItems,
  type DropEntryLike,
} from "../src/lib/finderDrop.ts";

function makeFileEntry(name: string, content = "ok"): DropEntryLike {
  const f = new File([content], name, { type: "text/plain" });
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok(f),
  };
}

function makeDirEntry(name: string, children: DropEntryLike[]): DropEntryLike {
  let cursor = 0;
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok) => {
        if (cursor >= children.length) {
          ok([]);
          return;
        }
        // Return in batches of 2 to exercise multi-call readEntries loops.
        const slice = children.slice(cursor, cursor + 2);
        cursor += slice.length;
        ok(slice);
      },
    }),
  };
}

test("readOsDraggedPaths returns empty array safely outside Tauri", async () => {
  const items = await readOsDraggedPaths();
  assert.deepEqual(items, []);
});

test("stageOsDraggedItems sets hostRef, isDir, kind, deduplication, maxFiles and pocket-local previewUrl", () => {
  const res = stageOsDraggedItems(
    [],
    [
      { path: "/Users/dev/project", name: "project", isDir: true, size: 0 },
      { path: "/Users/dev/project/shot.png", name: "shot.png", isDir: false, size: 2048 },
      { path: "/Users/dev/project/notes.md", name: "notes.md", isDir: false, size: 512 },
      { path: "/Users/dev/project/shot.png", name: "shot.png", isDir: false, size: 2048 },
    ],
    6,
  );

  assert.equal(res.added.length, 3);
  assert.equal(res.notice, undefined);

  assert.equal(res.added[0]!.hostRef, "/Users/dev/project");
  assert.equal(res.added[0]!.isDir, true);
  assert.equal(res.added[0]!.kind, "file");
  assert.equal(res.added[0]!.previewUrl, undefined);

  assert.equal(res.added[1]!.hostRef, "/Users/dev/project/shot.png");
  assert.equal(res.added[1]!.isDir, false);
  assert.equal(res.added[1]!.kind, "image");
  assert.equal(
    res.added[1]!.previewUrl,
    "pocket-local://localhost/file?path=%2FUsers%2Fdev%2Fproject%2Fshot.png",
  );

  assert.equal(res.added[2]!.hostRef, "/Users/dev/project/notes.md");
  assert.equal(res.added[2]!.kind, "text");
  assert.equal(res.added[2]!.previewUrl, undefined);

  const capped = stageOsDraggedItems(
    res.added,
    [{ path: "/Users/dev/extra.txt", name: "extra.txt", isDir: false, size: 10 }],
    3,
  );
  assert.equal(capped.added.length, 0);
  assert.equal(capped.notice, "一次最多附带 3 个文件");
});

test("collectDroppedFilesSafe walks webkitGetAsEntry folders, filters ignored dirs, and caps at 20 files", async () => {
  const manyFiles = Array.from({ length: 25 }, (_, i) => makeFileEntry(`f${i}.ts`, `x${i}`));
  const dir = makeDirEntry("repo", [
    makeDirEntry(".git", [makeFileEntry("HEAD", "ref")]),
    makeDirEntry("node_modules", [makeFileEntry("dep.js", "x")]),
    makeDirEntry("target", [makeFileEntry("bin", "x")]),
    makeFileEntry(".DS_Store", "junk"),
    ...manyFiles,
  ]);
  const emptyDir = makeDirEntry("empty-folder", [makeFileEntry(".DS_Store", "junk")]);
  const topFile = makeFileEntry("README.md", "hi");

  const entries = [topFile, dir, emptyDir];
  const fakeDataTransfer = {
    items: entries.map((entry) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
    })),
    files: [],
  } as unknown as DataTransfer;

  const res = await collectDroppedFilesSafe(fakeDataTransfer);
  assert.equal(res.files.length, 20);
  assert.equal(res.files[0]!.name, "README.md");
  assert.ok(res.files.every((f) => f.name !== "HEAD" && f.name !== "dep.js" && f.name !== "bin" && f.name !== ".DS_Store"));
  assert.deepEqual(res.folderNames, ["repo", "empty-folder"]);
  assert.deepEqual(res.skippedDirs, ["empty-folder"]);
});

test("collectDroppedFilesSafe catches NotReadableError/EISDIR directory files when webkitGetAsEntry is unavailable", async () => {
  const dirLikeFile = {
    name: "FinderFolder",
    size: 96,
    type: "",
    slice: () => ({
      arrayBuffer: async () => {
        const err = new Error("EISDIR: illegal operation on a directory");
        err.name = "NotReadableError";
        throw err;
      },
    }),
    arrayBuffer: async () => {
      throw new Error("NotReadableError");
    },
  } as unknown as File;
  const goodFile = new File(["hello"], "ok.txt", { type: "text/plain" });

  const fakeDataTransfer = {
    items: [],
    files: [dirLikeFile, goodFile],
  } as unknown as DataTransfer;

  const res = await collectDroppedFilesSafe(fakeDataTransfer);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0]!.name, "ok.txt");
  assert.deepEqual(res.folderNames, ["FinderFolder"]);
  assert.deepEqual(res.skippedDirs, ["FinderFolder"]);
});
