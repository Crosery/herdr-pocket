import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import {
  ALL_SPACES_KEY,
  closeTabPane,
  computeSplitLayout,
  detachPaneToTab,
  equalizeTabSplits,
  findPaneInDirection,
  focusedLeafOfTab,
  focusPaneDirection,
  focusTabPane,
  insertSplitLeaf,
  listLeaves,
  mergeTabIntoSplit,
  moveSplitLeaf,
  normalizeSplitNode,
  openAgentTab,
  openFileTab,
  parsePersistedSplitState,
  removeSplitLeaf,
  resizeSplitPair,
  resizeTabSplit,
  shellStore,
  splitTabPane,
  swapPaneDirection,
  swapSplitLeaves,
  tabLeaves,
  tabPaneCount,
  toggleZoomTabPane,
  unsplitTabToTabs,
  type PaneContent,
  type SplitLeafNode,
  type SplitNode,
} from "../src/shell/shellStore.ts";
import {
  WORKSPACE_STATE_KEY,
  flushWorkspaceStateNow,
  hydrateWorkspaceState,
  resetWorkspacePersistForTest,
} from "../src/lib/workspacePersist.ts";

if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return mem.size;
      },
      clear() {
        mem.clear();
      },
      getItem(k: string) {
        return mem.has(k) ? mem.get(k)! : null;
      },
      key(i: number) {
        return Array.from(mem.keys())[i] ?? null;
      },
      removeItem(k: string) {
        mem.delete(k);
      },
      setItem(k: string, v: string) {
        mem.set(k, String(v));
      },
    } satisfies Storage,
  });
}

function agentLeaf(id: string, key: string, weight = 1): SplitLeafNode {
  return { type: "leaf", id, weight, content: { kind: "agent", agentKey: key } };
}

function fileContent(path: string, title = path, agentKey = "host1/hc:t1"): PaneContent {
  return { kind: "file", agentKey, path, title };
}

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
  resetWorkspacePersistForTest();
});

test("splitTree flattens same-axis splits cleanly, preserves weights on remove, and computes exact affine CSS layout", () => {
  const leafA = agentLeaf("pa", "host1/hc:a", 1);
  const leafB = agentLeaf("pb", "host1/hc:b", 1);
  const leafC = agentLeaf("pc", "host1/hc:c", 1);

  // Split A right -> [A, B], then split B right -> flattened 3-child row [A(0.5), B(0.25), C(0.25)]
  const two = insertSplitLeaf(leafA, "pa", "right", leafB);
  assert.equal(two.type, "split");
  assert.equal(two.axis, "row");
  assert.equal(two.children.length, 2);

  const three = insertSplitLeaf(two, "pb", "right", leafC);
  assert.equal(three.type, "split");
  assert.equal(three.axis, "row");
  assert.equal(three.children.length, 3, "same-axis right split flattens into n-ary row branch");
  assert.deepEqual(listLeaves(three).map((l) => l.id), ["pa", "pb", "pc"]);

  const lay2 = computeSplitLayout(two, null, 6);
  assert.equal(lay2.leaves.length, 2);
  assert.equal(lay2.sashes.length, 1);
  assert.deepEqual(lay2.leaves[0]!.css, { left: "0%", top: "0%", width: "calc(50% - 3px)", height: "100%" });
  assert.deepEqual(lay2.leaves[1]!.css, { left: "calc(50% + 3px)", top: "0%", width: "calc(50% - 3px)", height: "100%" });
  assert.equal(lay2.sashes[0]!.axis, "row");

  // Zoom hides sibling panes without unmounting them and removes sashes.
  const zoomed = computeSplitLayout(two, "pb", 6);
  assert.equal(zoomed.sashes.length, 0);
  assert.equal(zoomed.leaves.find((l) => l.leaf.id === "pa")?.visible, false);
  assert.equal(zoomed.leaves.find((l) => l.leaf.id === "pb")?.visible, true);
  assert.deepEqual(zoomed.leaves.find((l) => l.leaf.id === "pb")?.css, { left: "0%", top: "0%", width: "100%", height: "100%" });

  // Remove pa -> leaves [pb, pc] keeping normalized tree
  const afterRemove = removeSplitLeaf(three, "pa");
  assert.ok(afterRemove);
  assert.deepEqual(listLeaves(afterRemove).map((l) => l.id), ["pb", "pc"]);
});

test("splitTree supports nested split, resize clamping, swap, move-to-edge, and directional navigation", () => {
  // Build L-shaped layout: Left = A (weight 0.5), Right = column [Top=B, Bottom=C] (weight 0.5)
  let root: SplitNode = agentLeaf("pa", "host1/hc:a");
  root = insertSplitLeaf(root, "pa", "right", agentLeaf("pb", "host1/hc:b"));
  root = insertSplitLeaf(root, "pb", "down", agentLeaf("pc", "host1/hc:c"));

  const layout = computeSplitLayout(root, null, 6);
  assert.equal(layout.sashes.length, 2);
  assert.equal(layout.leaves.length, 3);

  // Navigation right from pa -> pb (top-left preference when no focus history)
  assert.equal(findPaneInDirection(layout.leaves, "pa", "right"), "pb");
  // Navigation right with pc more recently focused than pb picks pc (Herdr MRU edge rule)
  assert.equal(findPaneInDirection(layout.leaves, "pa", "right", ["pb", "pc"]), "pc");
  // Navigation down from pb -> pc, left from pc -> pa
  assert.equal(findPaneInDirection(layout.leaves, "pb", "down"), "pc");
  assert.equal(findPaneInDirection(layout.leaves, "pc", "left"), "pa");

  // Swap pa <-> pc preserves slot geometry while moving ids & contents
  const swapped = swapSplitLeaves(root, "pa", "pc");
  const swappedLayout = computeSplitLayout(swapped, null, 6);
  assert.equal(findPaneInDirection(swappedLayout.leaves, "pc", "right"), "pb");
  assert.equal(findPaneInDirection(swappedLayout.leaves, "pb", "down"), "pa");

  // Sash resize enforces minimum share clamp
  const rootBranchId = (root as Extract<SplitNode, { type: "split" }>).id;
  const clamped = resizeSplitPair(root, rootBranchId, 0, -0.95, 0.12);
  const clampedLayout = computeSplitLayout(clamped, null, 6);
  const leftShare = clampedLayout.leaves.find((l) => l.leaf.id === "pa")!.unit.w;
  assert.ok(leftShare >= 0.119 && leftShare <= 0.121, `expected minShare ~0.12, got ${leftShare}`);

  // Move leaf pb to up edge of pa
  const moved = moveSplitLeaf(root, "pb", "pa", "up");
  const movedLayout = computeSplitLayout(moved, null, 6);
  assert.equal(findPaneInDirection(movedLayout.leaves, "pb", "down"), "pa");

  // Normalizing malformed nested same-axis tree merges children safely
  const nestedSameAxis: SplitNode = {
    type: "split",
    id: "outer",
    axis: "row",
    weight: 1,
    children: [
      { type: "split", id: "inner", axis: "row", weight: 2, children: [agentLeaf("p1", "k1"), agentLeaf("p2", "k2")] },
      agentLeaf("p3", "k3", 2),
    ],
  };
  const flat = normalizeSplitNode(nestedSameAxis);
  assert.equal(flat.type, "split");
  assert.equal(flat.children.length, 3);
});

test("shellStore split lifecycle: split, focus, zoom, resize, swap, detach, merge, close, and workspacePersist round-trip", async () => {
  openAgentTab("host1/hc:a1", "chat");
  const baseTabId = "a:host1/hc:a1";
  const p1 = focusedLeafOfTab(shellStore.get().tabs[0]!).id;

  const p2 = splitTabPane(baseTabId, p1, "right", fileContent("src/index.ts", "index.ts", "host1/hc:a1"));
  assert.ok(p2);
  assert.equal(tabPaneCount(shellStore.get().tabs[0]!), 2);
  assert.equal(focusedLeafOfTab(shellStore.get().tabs[0]!).id, p2);

  // Focusing existing open file inside split tab focuses that split pane instead of opening a duplicate tab!
  openFileTab("host1/hc:a1", "src/index.ts", "index.ts", { line: 42 });
  assert.equal(shellStore.get().tabs.length, 1);
  assert.equal(focusedLeafOfTab(shellStore.get().tabs[0]!).content.kind, "file");
  assert.equal((focusedLeafOfTab(shellStore.get().tabs[0]!).content as { line?: number }).line, 42);

  // Focus navigation + swap
  assert.equal(focusPaneDirection(baseTabId, "left"), true);
  assert.equal(focusedLeafOfTab(shellStore.get().tabs[0]!).id, p1);
  assert.equal(swapPaneDirection(baseTabId, "right"), true);
  assert.equal(focusPaneDirection(baseTabId, "left"), true);
  assert.equal(focusedLeafOfTab(shellStore.get().tabs[0]!).id, p2);

  // Resize + equalize
  const branchId = (shellStore.get().tabs[0]!.split!.root as Extract<SplitNode, { type: "split" }>).id;
  resizeTabSplit(baseTabId, branchId, 0, 0.2);
  equalizeTabSplits(baseTabId);

  // Zoom & unzoom
  toggleZoomTabPane(baseTabId, p2);
  assert.equal(shellStore.get().tabs[0]!.split?.zoomedPaneId, p2);
  toggleZoomTabPane(baseTabId, p2);
  assert.equal(shellStore.get().tabs[0]!.split?.zoomedPaneId, undefined);

  // Persist & rehydrate round-trip (note: resetWorkspacePersistForTest clears WORKSPACE_STATE_KEY, so capture & restore raw JSON to simulate app restart)
  await flushWorkspaceStateNow();
  const savedRaw = localStorage.getItem(WORKSPACE_STATE_KEY);
  assert.ok(savedRaw, "expected workspace snapshot written to localStorage");
  resetWorkspacePersistForTest();
  resetShellStore();
  assert.equal(shellStore.get().tabs.length, 0);
  localStorage.setItem(WORKSPACE_STATE_KEY, savedRaw);
  await hydrateWorkspaceState();
  assert.equal(shellStore.get().tabs.length, 1);
  const parsedSplit = parsePersistedSplitState(shellStore.get().tabs[0]!.split);
  assert.ok(parsedSplit);
  assert.equal(listLeaves(parsedSplit.root).length, 2);

  // Detach p2 into standalone tab, then merge back into baseTabId down edge
  const detachedId = detachPaneToTab(baseTabId, p2);
  assert.ok(detachedId);
  assert.equal(shellStore.get().tabs.length, 2);
  assert.equal(tabPaneCount(shellStore.get().tabs.find((t) => t.id === baseTabId)!), 1);

  mergeTabIntoSplit(detachedId, baseTabId, null, "down");
  assert.equal(shellStore.get().tabs.length, 1);
  assert.equal(tabPaneCount(shellStore.get().tabs[0]!), 2);

  // Add third pane then unsplit all -> 3 standalone tabs
  const p3 = splitTabPane(baseTabId, p1, "right", { kind: "agent", agentKey: "host1/hc:a2", mode: "term" });
  assert.ok(p3);
  assert.equal(tabLeaves(shellStore.get().tabs[0]!).length, 3);
  unsplitTabToTabs(baseTabId);
  assert.equal(shellStore.get().tabs.length, 3);
  assert.equal(shellStore.get().tabs[0]!.split, undefined);
  assert.equal(shellStore.get().activeBySpace[ALL_SPACES_KEY], shellStore.get().active);

  // Closing last pane collapses split back to 1-pane tab cleanly
  const firstId = shellStore.get().tabs[0]!.id;
  focusTabPane(firstId, focusedLeafOfTab(shellStore.get().tabs[0]!).id);
  const splitAgain = splitTabPane(firstId, null, "right", fileContent("README.md"));
  assert.ok(splitAgain);
  closeTabPane(firstId, splitAgain);
  assert.equal(tabPaneCount(shellStore.get().tabs.find((t) => t.id === firstId)!), 1);
  assert.equal(shellStore.get().tabs.find((t) => t.id === firstId)?.split, undefined);
});
