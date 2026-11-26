import assert from "node:assert/strict";
import { test } from "node:test";
import type { HerdrDoc, SpaceInfo } from "@herdr-pocket/protocol";
import {
  mergeHerdrWorkspacesIntoSpaces,
  syncSpacesBidirectional,
  type SpaceBridgeCoreLike,
  type SpaceBridgeHerdrLike,
} from "../src/spaceBridge.ts";
import type { HerdrWorkspaceInfo } from "../src/herdr.ts";

test("mergeHerdrWorkspacesIntoSpaces deduplicates by normalized name or folder and combines terminal counts", () => {
  const coreSpaces: SpaceInfo[] = [
    { id: "s1", name: "Backend", folder: "~/work/backend", tabs: 2, terminals: 1 },
    { id: "s2", name: "Frontend", folder: "~/work/frontend", tabs: 1, terminals: 2 },
  ];
  const herdrWorkspaces: HerdrWorkspaceInfo[] = [
    { id: "w1", label: "backend", folder: "~/work/backend", active: true, tabs: [{ id: "tb1", label: "api" }] },
    { id: "w2", label: "Web UI", folder: "~/work/frontend/", active: false, tabs: [{ id: "tb2", label: "web" }] },
    { id: "w3", label: "Mobile App", folder: "~/work/mobile", active: false, tabs: [{ id: "tb3", label: "rn" }, { id: "tb4", label: "ios" }] },
  ];
  const counts = new Map<string, number>([
    ["w1", 2],
    ["w2", 1],
    ["w3", 3],
  ]);

  const merged = mergeHerdrWorkspacesIntoSpaces(coreSpaces, herdrWorkspaces, counts);
  assert.equal(merged.length, 3);
  assert.equal(merged[0]?.id, "s1");
  assert.equal(merged[0]?.terminals, 3);
  assert.equal(merged[1]?.id, "s2");
  assert.equal(merged[1]?.terminals, 3);
  assert.deepEqual(merged[2], {
    id: "herdr:w3",
    name: "Mobile App",
    folder: "~/work/mobile",
    tabs: 2,
    terminals: 3,
  });
});

test("syncSpacesBidirectional mirrors missing spaces both ways and stays idempotent on repeat runs", async () => {
  let docVersion = 1;
  let docValue: HerdrDoc = {
    spaces: [
      { id: "s1", name: "Core Only", folder: "~/work/core-only", tabs: [] },
      { id: "s2", name: "Shared", folder: "~/work/shared", tabs: [] },
    ],
  };

  const core: SpaceBridgeCoreLike = {
    async docGet() {
      return { value: structuredClone(docValue), version: docVersion };
    },
    async docSetCas(_name, value, version) {
      assert.equal(version, docVersion);
      docValue = structuredClone(value as HerdrDoc);
      docVersion += 1;
      return { ok: true, version: docVersion };
    },
  };

  const herdrWorkspaces: HerdrWorkspaceInfo[] = [
    { id: "w1", label: "Shared", folder: "~/work/shared", active: true, tabs: [] },
    { id: "w2", label: "TUI Only", folder: "~/work/tui-only", active: false, tabs: [] },
  ];

  const createdInHerdr: Array<{ label: string; cwd?: string }> = [];
  const herdr: SpaceBridgeHerdrLike = {
    get workspaces() {
      return herdrWorkspaces;
    },
    async refreshWorkspaces() {
      return herdrWorkspaces;
    },
    async createWorkspace(label, cwd) {
      createdInHerdr.push({ label, cwd });
      const ws: HerdrWorkspaceInfo = { id: `w${herdrWorkspaces.length + 1}`, label, folder: cwd, active: false, tabs: [] };
      herdrWorkspaces.push(ws);
      return { id: ws.id, label };
    },
    async renameWorkspace() {},
  };

  const first = await syncSpacesBidirectional({ core, herdr, herdrAvailable: true, mirrorToHerdr: true });
  assert.deepEqual(first, { syncedToCore: 1, syncedToHerdr: 1, herdrAvailable: true });
  assert.equal(docValue.spaces?.some((s) => s.name === "TUI Only"), true);
  assert.deepEqual(createdInHerdr.map((x) => x.label), ["Core Only"]);

  // Second run must be completely idempotent (0 changes in either direction).
  const second = await syncSpacesBidirectional({ core, herdr, herdrAvailable: true, mirrorToHerdr: true });
  assert.deepEqual(second, { syncedToCore: 0, syncedToHerdr: 0, herdrAvailable: true });
});
