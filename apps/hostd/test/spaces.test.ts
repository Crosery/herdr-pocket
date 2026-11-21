import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HerdrApp } from "../src/create.ts";

const tmp = mkdtempSync(join(tmpdir(), "herdr-pocket-spaces-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("HerdrApp.spaces preserves exact Herdr order, empty spaces, and shared.json colors", async () => {
  const sharedPath = join(tmp, "shared.json");
  const docsPath = join(tmp, "docs.json");
  writeFileSync(
    sharedPath,
    JSON.stringify({
      "space.colors": {
        sp1: "ansi6",
        sp2: "ansi3",
        sp3: "ansi5",
      },
    }),
  );
  writeFileSync(
    docsPath,
    JSON.stringify({
      "herdr-app": {
        version: 1,
        value: {
          activeSpaceId: "sp2",
          spaces: [
            { id: "sp1", name: "И Work", folder: "/tmp/work", isWorktree: true, tabs: [{ id: "tb1", name: "Main", root: { content: { terminal: "t1" } } }] },
            { id: "sp2", name: "Empty Space", folder: "/tmp/empty", tabs: [] },
            { id: "sp3", name: "Docs", folder: "/tmp/docs", tabs: [{ id: "tb2", name: "Notes", terminals: [{ id: "t2" }] }] },
            { id: "sp_remote", name: "Other Machine", machine: "office-mac", folder: "/tmp/other", tabs: [] },
          ],
        },
      },
    }),
  );

  const app = new HerdrApp("herdr-app", { sharedJsonPath: sharedPath, docsJsonPath: docsPath });
  app.ls = async () => ({
    spaces: [
      { id: "sp1", name: "И Work", folder: "/tmp/work", tabs: [{ id: "tb1", name: "Main", terminals: [{ terminal: "t1" }] }] },
      { id: "sp2", name: "Empty Space", folder: "/tmp/empty", tabs: [] },
      { id: "sp3", name: "Docs", folder: "/tmp/docs", tabs: [{ id: "tb2", name: "Notes", terminals: [{ terminal: "t2" }] }] },
      { id: "sp_remote", name: "Other Machine", machine: "office-mac", folder: "/tmp/other", tabs: [] },
    ],
  });

  const live = await app.spaces();
  assert.deepEqual(
    live.map((s) => ({ id: s.id, name: s.name, color: s.color, tabs: s.tabs, terminals: s.terminals, isWorktree: s.isWorktree })),
    [
      { id: "sp1", name: "И Work", color: "ansi6", tabs: 1, terminals: 1, isWorktree: true },
      { id: "sp2", name: "Empty Space", color: "ansi3", tabs: 0, terminals: 0, isWorktree: undefined },
      { id: "sp3", name: "Docs", color: "ansi5", tabs: 1, terminals: 1, isWorktree: undefined },
    ],
  );

  const fromDocs = app.spacesFromDocs();
  assert.deepEqual(
    fromDocs.map((s) => ({ id: s.id, name: s.name, color: s.color, active: s.active, tabs: s.tabs, terminals: s.terminals, isWorktree: s.isWorktree })),
    [
      { id: "sp1", name: "И Work", color: "ansi6", active: undefined, tabs: 1, terminals: 1, isWorktree: true },
      { id: "sp2", name: "Empty Space", color: "ansi3", active: true, tabs: 0, terminals: 0, isWorktree: undefined },
      { id: "sp3", name: "Docs", color: "ansi5", active: undefined, tabs: 1, terminals: 1, isWorktree: undefined },
    ],
  );
});

test("HerdrApp.spacesFromDocs resolves live terminal cwds when docs folder is absent", () => {
  const docsDir = join(tmp, "docs2");
  mkdirSync(docsDir, { recursive: true });
  const docsPath = join(docsDir, "docs.json");
  const sharedPath = join(docsDir, "shared.json");
  writeFileSync(sharedPath, JSON.stringify({ "space.colors": { sp9: "#ec4899" } }));
  writeFileSync(
    docsPath,
    JSON.stringify({
      docs: {
        "herdr-app": {
          value: {
            spaces: [
              { id: "sp9", name: "Nested", tabs: [{ id: "tb9", root: { children: [{ content: { terminal: "t99" } }] } }] },
            ],
          },
        },
      },
    }),
  );
  const app = new HerdrApp("herdr-app", { sharedJsonPath: sharedPath, docsJsonPath: docsPath });
  const terms = new Map([["t99", { cwd: "/Users/demo/repo" }]]);
  const res = app.spacesFromDocs(terms);
  assert.deepEqual(res, [
    { id: "sp9", name: "Nested", folder: "/Users/demo/repo", tabs: 1, terminals: 1, color: "#ec4899" },
  ]);
});
