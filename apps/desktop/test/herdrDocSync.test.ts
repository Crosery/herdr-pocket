import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import type { Agent, Device, HerdrDoc, SpaceInfo } from "@herdr-pocket/protocol";
import { searchTerminalBuffer } from "../src/lib/terminalSearch.ts";
import type { TerminalBufferCellLike, TerminalBufferLike, TerminalBufferLineLike } from "../src/lib/terminalLinks.ts";
import {
  extractHostHerdrDoc,
  formatHerdrTabLabel,
  herdrRootToSplitNode,
  splitNodeToHerdrRoot,
} from "../src/shell/herdrDoc.ts";
import { createHerdrDocSyncController, type HerdrDocTransport } from "../src/shell/herdrDocSync.ts";
import {
  reconcileHostHerdrDoc,
  renameShellTab,
  shellStore,
  splitTabPane,
  toggleZoomTabPane,
} from "../src/shell/shellStore.ts";

function resetShellStore(): void {
  shellStore.set({
    tabs: [],
    active: null,
    selectedSpace: null,
    activeBySpace: {},
    panel: null,
    panelWidth: 368,
    subagentAside: null,
    settings: null,
    palette: false,
    peek: null,
  });
}

afterEach(() => {
  resetShellStore();
});

test("herdrRootToSplitNode and splitNodeToHerdrRoot preserve structure, weights, extra metadata, Mod blocks, and filter Pocket-only leaves", () => {
  const docRoot: HerdrDoc["spaces"][number]["tabs"][number]["root"] = {
    id: "s1",
    type: "row",
    size: { weight: 1 },
    cloned_from: { name: "main", version: "1" },
    children: [
      { id: "p1", type: "block", size: { weight: 1.5 }, content: { terminal: "t1" } },
      {
        id: "s2",
        type: "column",
        size: { weight: 2.5 },
        children: [
          { id: "p2", type: "block", size: { weight: 1 }, content: { terminal: "t2" } },
          { id: "mod1", type: "block", content: { mod: "custom-widget", props: { x: 1 } } },
          { id: "p3", type: "block", size: { weight: 3 }, content: { terminal: "t3" } },
        ],
      },
    ],
  };

  const split = herdrRootToSplitNode("dev-1", docRoot);
  assert.ok(split);
  assert.equal(split.type, "split");
  assert.equal(split.axis, "row");
  assert.equal(split.children[0]!.type, "leaf");
  if (split.children[0]!.type === "leaf") {
    assert.equal(split.children[0]!.content.kind, "agent");
    if (split.children[0]!.content.kind === "agent") {
      assert.equal(split.children[0]!.content.agentKey, "dev-1/hc:t1");
      assert.equal(split.children[0]!.content.mode, "term");
    }
  }

  // Inject a Pocket-only file leaf alongside t1 and serialize back: file leaf excluded, Mod block kept, extra fields kept!
  const withFile = {
    ...split,
    children: [
      ...split.children,
      { type: "leaf" as const, id: "pf", weight: 1, content: { kind: "file" as const, agentKey: "dev-1/hc:t1", path: "README.md", title: "README.md" } },
    ],
  };
  const back = splitNodeToHerdrRoot("dev-1", withFile, docRoot);
  assert.ok(back);
  assert.equal(back.id, "s1");
  assert.deepEqual(back.cloned_from, { name: "main", version: "1" });
  assert.equal(back.children?.length, 2);
  assert.equal(back.children?.[0]?.size && "weight" in back.children[0].size ? back.children[0].size.weight : 1, 1.5);
  const col = back.children?.[1];
  assert.equal(col?.type, "column");
  assert.equal(col?.children?.length, 3);
  assert.equal((col?.children?.[1]?.content as { mod?: string })?.mod, "custom-widget");
});

test("formatHerdrTabLabel uses live title / program fallback for unnamed tabs, preserves custom names, and shows Z zoom badge", () => {
  assert.equal(formatHerdrTabLabel({ name: "" }, 0, "Claude Code", false), "Claude Code");
  assert.equal(
    formatHerdrTabLabel({ name: "" }, { programName: "Claude Code", liveTitle: "✳ Fix split panes" }, false),
    "Fix split panes",
  );
  assert.equal(
    formatHerdrTabLabel({ name: "" }, { programName: "Claude Code", liveTitle: "~/work_file/herdr-pocket" }, false),
    "Claude Code",
  );
  assert.equal(
    formatHerdrTabLabel({ name: "" }, { programName: "Codex", liveTitle: "t19g" }, false),
    "Codex",
  );
  assert.equal(
    formatHerdrTabLabel({ name: "" }, { programName: "Terminal", liveTitle: "zsh" }, true),
    "Terminal Z",
  );
  assert.equal(formatHerdrTabLabel({ name: "2" }, 1, "Codex", false), "2");
  assert.equal(formatHerdrTabLabel({ name: "2" }, 1, "Codex", true), "2 Z");
  assert.equal(formatHerdrTabLabel({ name: "tb12" }, 0, "Gemini CLI", false), "Gemini CLI");
  assert.equal(formatHerdrTabLabel({ name: "Auth Flow" }, 2, "Claude Code", false), "Auth Flow");
  assert.equal(formatHerdrTabLabel({ name: "Auth Flow" }, 2, "Claude Code", true), "Auth Flow Z");
});

test("reconcileHostHerdrDoc + createHerdrDocSyncController round-trip CAS sync and resolve conflicts cleanly", async () => {
  const dev: Device = { id: "h1", name: "mac", kind: "host", platform: "darwin", online: true, createdAt: 1, lastSeenAt: 1 };
  const spaces: SpaceInfo[] = [{ id: "sp-1", name: "backend", folder: "~/work/app", tabs: 1, terminals: 2, color: "ansi6", active: true }];
  const agents: Agent[] = [
    { key: "h1/hc:t1", deviceId: "h1", source: "hc", localId: "t1", harness: "claude-code", title: "A1", where: "backend", cwd: "~/work/app", status: "idle", isShell: false, updatedAt: 1 },
    { key: "h1/hc:t2", deviceId: "h1", source: "hc", localId: "t2", harness: "zsh", title: "zsh", where: "backend", cwd: "~/work/app", status: "idle", isShell: true, updatedAt: 1 },
  ];

  // Seed standalone tab that duplicates t1; reconcile must absorb/deduplicate it without losing chat mode if set.
  shellStore.set({
    tabs: [
      { id: "a:h1/hc:t1", kind: "agent", agentKey: "h1/hc:t1", mode: "chat" },
      { id: "f:h1/hc:t1:README.md", kind: "file", agentKey: "h1/hc:t1", path: "README.md", title: "README.md" },
    ],
    active: "a:h1/hc:t1",
  });

  let serverDoc: HerdrDoc = {
    spaces: [
      {
        id: "sp-1",
        name: "backend",
        folder: "~/work/app",
        tabs: [{ id: "tb1", name: "1", root: { id: "p1", type: "block", content: { terminal: "t1" } } }],
      },
    ],
  };
  let serverVersion = 3;
  let forceConflictOnce = false;

  const transport: HerdrDocTransport = {
    async getDoc() {
      return { value: JSON.parse(JSON.stringify(serverDoc)), version: serverVersion };
    },
    async setDoc(_hostId, value, version) {
      if (forceConflictOnce || version !== serverVersion) {
        forceConflictOnce = false;
        return {
          ok: false,
          conflict: true,
          value: JSON.parse(JSON.stringify(serverDoc)),
          version: serverVersion,
        };
      }
      serverDoc = JSON.parse(JSON.stringify(value));
      serverVersion += 1;
      return { ok: true, version: serverVersion };
    },
    getAgents: () => ({ h1: agents }),
    getSpaces: () => ({ h1: spaces }),
    getDevices: () => ({ h1: dev }),
    getLocalHostId: () => "h1",
  };

  const ctrl = createHerdrDocSyncController(transport, 1);
  await ctrl.syncAllOnlineHosts();

  // Deduplicated a:h1/hc:t1 -> ht:h1:sp-1:tb1, kept local README.md tab intact, and preserved chat override!
  const tabsAfterPull = shellStore.get().tabs;
  assert.equal(tabsAfterPull.length, 2);
  assert.equal(tabsAfterPull[0]!.id, "ht:h1:sp-1:tb1");
  assert.equal(tabsAfterPull[0]!.kind === "agent" ? tabsAfterPull[0]!.mode : undefined, "chat");
  assert.equal(shellStore.get().active, "ht:h1:sp-1:tb1");

  // Local split + rename pushes via CAS version 3 -> 4.
  splitTabPane("ht:h1:sp-1:tb1", null, "right", { kind: "agent", agentKey: "h1/hc:t2", mode: "term" });
  renameShellTab("ht:h1:sp-1:tb1", "Auth");
  toggleZoomTabPane("ht:h1:sp-1:tb1");
  ctrl.handleShellChange();
  await ctrl.flushHost("h1");
  assert.equal(serverVersion, 4);
  assert.equal(serverDoc.spaces[0]!.tabs[0]!.name, "Auth");
  assert.equal(serverDoc.spaces[0]!.tabs[0]!.root.type, "row");
  assert.equal(serverDoc.spaces[0]!.tabs[0]!.root.children?.length, 2);

  // Extract checks cleanly without losing non-serializable focus/zoom state.
  const extracted = extractHostHerdrDoc("h1", shellStore.get().tabs, serverDoc, spaces, (k) => agents.find((a) => a.key === k));
  assert.equal(extracted.spaces[0]!.tabs[0]!.root.children?.length, 2);

  // Conflict path reconciles remote doc back into store cleanly.
  serverDoc = {
    spaces: [
      {
        id: "sp-1",
        name: "backend",
        folder: "~/work/app",
        tabs: [{ id: "tb9", name: "9", root: { id: "p9", type: "block", content: { terminal: "t2" } } }],
      },
    ],
  };
  serverVersion = 10;
  forceConflictOnce = true;
  renameShellTab("ht:h1:sp-1:tb1", "ShouldConflict");
  ctrl.handleShellChange();
  await ctrl.flushHost("h1");
  assert.equal(ctrl.getSlotSnapshot("h1")?.version, 10);
  assert.equal(shellStore.get().tabs[0]!.id, "ht:h1:sp-1:tb9");
  ctrl.reset();
});

test("searchTerminalBuffer locates substring across wrapped rows and CJK wide glyphs", () => {
  const rowsSpec = [
    { text: "输出测试：first_tok", isWrapped: false },
    { text: "en_here 末尾", isWrapped: true },
  ];
  const lines: TerminalBufferLineLike[] = rowsSpec.map((spec) => {
    const cells: Array<{ chars: string; width: number }> = [];
    for (const ch of spec.text) {
      const cp = ch.codePointAt(0) ?? 0;
      const wide = (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xff00 && cp <= 0xffef);
      if (wide) {
        cells.push({ chars: ch, width: 2 });
        cells.push({ chars: "", width: 0 });
      } else {
        cells.push({ chars: ch, width: 1 });
      }
    }
    while (cells.length < 40) cells.push({ chars: "", width: 1 });
    return {
      isWrapped: spec.isWrapped,
      length: cells.length,
      getCell: (x: number): TerminalBufferCellLike | undefined => {
        const entry = cells[x];
        return entry ? { getChars: () => entry.chars, getWidth: () => entry.width } : undefined;
      },
    };
  });
  const buf: TerminalBufferLike = {
    length: lines.length,
    getNullCell: () => ({ getChars: () => "", getWidth: () => 1 }),
    getLine: (y: number) => lines[y],
  };

  const matches = searchTerminalBuffer(buf, "FIRST_TOKEN_HERE", 40);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.row0, 0);
  assert.equal(matches[0]!.col0, 10); // 5 wide CJK chars = 10 columns
  assert.equal(matches[0]!.length, 1 * 40 + (7 - 10)); // ends col 6 (+1 width = 7) on row 1 => 37 cells
});

test("reconcileHostHerdrDoc absorbs standalone tab into multi-pane HerdrDoc split without duplicates and keeps focus/mode", () => {
  shellStore.set({
    tabs: [
      { id: "a:h1/hc:t2", kind: "agent", agentKey: "h1/hc:t2", mode: "chat" },
    ],
    active: "a:h1/hc:t2",
    selectedSpace: "h1\u0000backend",
    activeBySpace: { "h1\u0000backend": "a:h1/hc:t2" },
  });

  const remoteDoc: HerdrDoc = {
    spaces: [
      {
        id: "sp-1",
        name: "backend",
        folder: "~/work/app",
        tabs: [
          {
            id: "tb1",
            name: "1",
            root: {
              id: "s1",
              type: "row",
              children: [
                { id: "p1", type: "block", size: { weight: 1 }, content: { terminal: "t1" } },
                { id: "p2", type: "block", size: { weight: 1 }, content: { terminal: "t2" } },
              ],
            },
          },
        ],
      },
    ],
  };

  reconcileHostHerdrDoc("h1", remoteDoc);
  const next = shellStore.get();
  assert.equal(next.tabs.length, 1);
  const synced = next.tabs[0]!;
  assert.equal(synced.id, "ht:h1:sp-1:tb1");
  assert.equal(next.active, "ht:h1:sp-1:tb1");
  assert.equal(next.activeBySpace["h1\u0000backend"], "ht:h1:sp-1:tb1");
  assert.equal(synced.kind, "agent");
  if (synced.kind === "agent") {
    assert.ok(synced.split);
    assert.equal(synced.split.focusedPaneId, "p2");
    assert.equal(synced.split.root.type, "split");
    if (synced.split.root.type === "split") {
      const first = synced.split.root.children[0]!;
      const second = synced.split.root.children[1]!;
      assert.equal(first.type, "leaf");
      assert.equal(second.type, "leaf");
      if (first.type === "leaf" && first.content.kind === "agent") {
        assert.equal(first.content.agentKey, "h1/hc:t1");
        assert.equal(first.content.mode, "term");
      }
      if (second.type === "leaf" && second.content.kind === "agent") {
        assert.equal(second.content.agentKey, "h1/hc:t2");
        assert.equal(second.content.mode, "chat");
      }
    }
  }
});
