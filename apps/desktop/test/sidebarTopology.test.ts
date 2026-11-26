import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Agent, Device, SpaceInfo } from "@herdr-pocket/protocol";
import type { ShellTab } from "../src/shell/shellStore.ts";
import {
  buildSidebarAgentSections,
  computeWorkspaceTopology,
  formatCompactDeviceBadge,
  formatTopologyBadge,
} from "../src/shell/sidebarTopology.ts";

function makeAgent(
  id: string,
  overrides: Partial<Agent> = {},
): Agent {
  const key = `mac1/${id}`;
  return {
    key,
    deviceId: "mac1",
    localId: id,
    harness: "claude",
    name: id,
    status: "working",
    where: "ibuki-next / main",
    updatedAt: 1_700_000_000_000,
    statusSince: 1_700_000_000_000,
    ...overrides,
  };
}

const DEVICES: Record<string, Device> = {
  mac1: { id: "mac1", name: "MacBook Pro", kind: "host", online: true, lastSeen: 1_700_000_000_000 },
};

const SPACES_MAP: Record<string, SpaceInfo[]> = {
  mac1: [
    { id: "sp-ibuki", name: "ibuki-next", folder: "~/work/ibuki-next", color: "ansi6", tabs: 3, active: true },
    { id: "sp-pocket", name: "herdr-pocket", folder: "~/work/herdr-pocket", color: "ansi5", tabs: 1 },
  ],
};

test("computeWorkspaceTopology indexes multi-page Space, 3-way split panes, single tabs, and background agents", () => {
  const agents: Agent[] = [
    makeAgent("a1", { name: "API Gateway", status: "blocked", statusSince: 1_700_000_050_000 }),
    makeAgent("a2", { name: "WebSocket Hub", status: "working", statusSince: 1_700_000_040_000 }),
    makeAgent("a3", { name: "SQLite Worker", status: "done", statusSince: 1_700_000_030_000 }),
    makeAgent("a4", { name: "UI Polish", status: "working", statusSince: 1_700_000_020_000 }),
    makeAgent("a5", { name: "Doc Reviewer", status: "done", statusSince: 1_700_000_010_000 }),
    makeAgent("a6", { name: "Background Watcher", status: "idle", statusSince: 1_700_000_005_000 }),
    makeAgent("a7", { name: "Pocket Build", status: "working", where: "herdr-pocket / p1", statusSince: 1_700_000_060_000 }),
  ];
  const byKey = new Map(agents.map((a) => [a.key, a] as const));

  const tabs: ShellTab[] = [
    {
      id: "tab-split-3",
      kind: "agent",
      agentKey: "mac1/a1",
      docHostId: "mac1",
      docSpaceId: "sp-ibuki",
      docSpaceName: "ibuki-next",
      split: {
        focusedPaneId: "p-2",
        zoomedPaneId: null,
        root: {
          id: "split-root",
          type: "row",
          children: [
            { id: "p-1", type: "leaf", weight: 1, content: { kind: "agent", agentKey: "mac1/a1" } },
            { id: "p-2", type: "leaf", weight: 1, content: { kind: "agent", agentKey: "mac1/a2" } },
            { id: "p-3", type: "leaf", weight: 1, content: { kind: "agent", agentKey: "mac1/a3" } },
          ],
        },
      },
    },
    {
      id: "tab-single",
      kind: "agent",
      agentKey: "mac1/a4",
      docHostId: "mac1",
      docSpaceId: "sp-ibuki",
      docSpaceName: "ibuki-next",
    },
    {
      id: "tab-file-agent",
      kind: "agent",
      agentKey: "mac1/a5",
      docHostId: "mac1",
      docSpaceId: "sp-ibuki",
      docSpaceName: "ibuki-next",
      split: {
        focusedPaneId: "p-f1",
        zoomedPaneId: null,
        root: {
          id: "split-fa",
          type: "row",
          children: [
            { id: "p-f1", type: "leaf", weight: 1, content: { kind: "file", agentKey: "mac1/a5", path: "src/index.ts", title: "index.ts" } },
            { id: "p-a5", type: "leaf", weight: 1, content: { kind: "agent", agentKey: "mac1/a5" } },
          ],
        },
      },
    },
    {
      id: "tab-pocket",
      kind: "agent",
      agentKey: "mac1/a7",
      docHostId: "mac1",
      docSpaceId: "sp-pocket",
      docSpaceName: "herdr-pocket",
    },
  ];

  const topo = computeWorkspaceTopology(
    tabs,
    "tab-split-3",
    (k) => byKey.get(k),
    SPACES_MAP,
    agents,
  );

  const ibuki = topo.bySpace.get("mac1\u0000ibuki-next");
  assert.ok(ibuki);
  assert.equal(ibuki.pageCount, 3);
  assert.equal(ibuki.splitPageCount, 2);
  assert.equal(ibuki.paneCount, 6);
  assert.deepEqual(
    ibuki.pages.map((p) => [p.pageNumber, p.pageTotal, p.isSplit, p.paneCount]),
    [
      [1, 3, true, 3],
      [2, 3, false, 1],
      [3, 3, true, 2],
    ],
  );
  assert.equal(ibuki.pages[0]!.active, true);
  assert.equal(ibuki.pages[0]!.hasBlocked, true);

  const p1 = topo.byAgent.get("mac1/a1")!;
  const p2 = topo.byAgent.get("mac1/a2")!;
  const p3 = topo.byAgent.get("mac1/a3")!;
  const p4 = topo.byAgent.get("mac1/a4")!;
  const p5 = topo.byAgent.get("mac1/a5")!;
  const p6 = topo.byAgent.get("mac1/a6")!;

  assert.deepEqual(formatTopologyBadge(p1), { kind: "split", label: "3分屏", slot: "1/3" });
  assert.deepEqual(formatTopologyBadge(p2), { kind: "split", label: "3分屏", slot: "2/3" });
  assert.equal(p2.isFocusedPane, true);
  assert.deepEqual(p2.siblingAgentKeys, ["mac1/a1", "mac1/a3"]);
  assert.deepEqual(formatTopologyBadge(p3), { kind: "split", label: "3分屏", slot: "3/3" });
  assert.deepEqual(formatTopologyBadge(p4), { kind: "page", label: "第2页" });
  assert.deepEqual(formatTopologyBadge(p5), { kind: "split", label: "2分屏", slot: "2/2" });
  assert.deepEqual(formatTopologyBadge(p6), { kind: "bg", label: "后台" });
  assert.equal(p6.spaceKey, "mac1\u0000ibuki-next");

  const pocket = topo.bySpace.get("mac1\u0000herdr-pocket")!;
  assert.equal(pocket.pageCount, 1);
  assert.deepEqual(formatTopologyBadge(topo.byAgent.get("mac1/a7")!), { kind: "page", label: "第1页" });

  // Verify space grouping puts co-split siblings adjacent and assigns split-first / split-mid / split-last rails.
  const spaceSections = buildSidebarAgentSections({
    agents,
    devices: DEVICES,
    topology: topo,
    spacesMap: SPACES_MAP,
    selectedSpace: "mac1\u0000ibuki-next",
    grouping: "space",
  });
  assert.equal(spaceSections.length, 2);
  const ibukiSec = spaceSections[0]!;
  assert.equal(ibukiSec.kind, "space");
  assert.equal(ibukiSec.title, "ibuki-next");
  assert.equal(ibukiSec.pageCount, 3);
  assert.deepEqual(
    ibukiSec.items.map((it) => [it.agent.localId, it.joinRole]),
    [
      ["a1", "split-first"],
      ["a2", "split-mid"],
      ["a3", "split-last"],
      ["a4", "single"],
      ["a5", "single"],
      ["a6", "single"],
    ],
  );
});

test("formatCompactDeviceBadge and Sidebar Schemes A/B/C group same-space splits and expose devices in status mode", () => {
  const multiDevices: Record<string, Device> = {
    mac1: { id: "mac1", name: "Crosery 的 MacBook", kind: "host", online: true, lastSeen: 1_700_000_000_000 },
    mac2: { id: "mac2", name: "家里的 Mac", kind: "host", online: true, lastSeen: 1_700_000_000_000 },
  };
  const multiSpaces: Record<string, SpaceInfo[]> = {
    mac1: [
      { id: "sp-1", name: "伊吹工坊", folder: "~/work/ibuki", color: "ansi4", tabs: 1 },
      { id: "sp-2", name: "弹唱", folder: "~/work/strum", color: "ansi5", tabs: 1 },
    ],
    mac2: [{ id: "sp-r", name: "测试", folder: "~/work/test", color: "ansi6", tabs: 1 }],
  };

  assert.deepEqual(formatCompactDeviceBadge("mac1", multiDevices, "mac1"), {
    deviceId: "mac1",
    label: "本机",
    fullLabel: "本机 · Crosery 的 MacBook",
    isLocal: true,
  });
  assert.deepEqual(formatCompactDeviceBadge("mac2", multiDevices, "mac1"), {
    deviceId: "mac2",
    label: "家里的 Mac",
    fullLabel: "家里的 Mac",
    isLocal: false,
  });

  // Intentionally interleave statusSince so same-tab split panes (a1 + a3) are not contiguous by pure timestamp.
  const multiAgents: Agent[] = [
    makeAgent("a1", { deviceId: "mac1", where: "伊吹工坊 / p1", status: "working", statusSince: 1_700_000_090_000 }),
    {
      ...makeAgent("r1", { status: "working", statusSince: 1_700_000_080_000 }),
      key: "mac2/r1",
      deviceId: "mac2",
      where: "测试 / p1",
    },
    makeAgent("a3", { deviceId: "mac1", where: "伊吹工坊 / p2", status: "working", statusSince: 1_700_000_070_000 }),
    makeAgent("a2", { deviceId: "mac1", where: "弹唱 / p1", status: "working", statusSince: 1_700_000_085_000 }),
  ];
  const byKey = new Map(multiAgents.map((a) => [a.key, a] as const));
  const tabs: ShellTab[] = [
    {
      id: "tab-ibuki-split",
      kind: "agent",
      agentKey: "mac1/a1",
      docHostId: "mac1",
      docSpaceId: "sp-1",
      docSpaceName: "伊吹工坊",
      split: {
        focusedPaneId: "p1",
        zoomedPaneId: null,
        root: {
          id: "root",
          type: "row",
          children: [
            { id: "p1", type: "leaf", weight: 1, content: { kind: "agent", agentKey: "mac1/a1" } },
            { id: "p2", type: "leaf", weight: 1, content: { kind: "agent", agentKey: "mac1/a3" } },
          ],
        },
      },
    },
    {
      id: "tab-tan",
      kind: "agent",
      agentKey: "mac1/a2",
      docHostId: "mac1",
      docSpaceId: "sp-2",
      docSpaceName: "弹唱",
    },
    {
      id: "tab-remote",
      kind: "agent",
      agentKey: "mac2/r1",
      docHostId: "mac2",
      docSpaceId: "sp-r",
      docSpaceName: "测试",
    },
  ];
  const topo = computeWorkspaceTopology(tabs, "tab-ibuki-split", (k) => byKey.get(k), multiSpaces, multiAgents);

  // Scheme A: co-split panes (a1, a3) are clustered adjacently with split-first / split-last in status mode.
  const schemeASections = buildSidebarAgentSections({
    agents: multiAgents,
    devices: multiDevices,
    topology: topo,
    spacesMap: multiSpaces,
    selectedSpace: null,
    grouping: "status",
    scheme: "a",
    localHostId: "mac1",
  });
  assert.deepEqual(
    schemeASections[0]!.items.map((it) => [it.agent.key, it.joinRole]),
    [
      ["mac1/a1", "split-first"],
      ["mac1/a3", "split-last"],
      ["mac1/a2", "single"],
      ["mac2/r1", "single"],
    ],
  );

  // Scheme B: partitions items inside each status group by computer with deviceHeader subheaders.
  const schemeBSections = buildSidebarAgentSections({
    agents: multiAgents,
    devices: multiDevices,
    topology: topo,
    spacesMap: multiSpaces,
    selectedSpace: null,
    grouping: "status",
    scheme: "b",
    localHostId: "mac1",
  });
  assert.equal(schemeBSections[0]!.items[0]!.deviceHeader?.isLocal, true);
  assert.equal(schemeBSections[0]!.items[0]!.deviceHeader?.count, 3);
  assert.equal(schemeBSections[0]!.items[3]!.deviceHeader?.deviceId, "mac2");
  assert.equal(schemeBSections[0]!.items[3]!.deviceHeader?.count, 1);

  // Hover freeze preserves exact prior order until hover ends.
  const frozen = buildSidebarAgentSections({
    agents: multiAgents,
    devices: multiDevices,
    topology: topo,
    spacesMap: multiSpaces,
    selectedSpace: null,
    grouping: "status",
    scheme: "a",
    localHostId: "mac1",
    hoverFreeze: true,
    previousOrder: new Map([["working", ["mac2/r1", "mac1/a2", "mac1/a1", "mac1/a3"]]]),
  });
  assert.deepEqual(
    frozen[0]!.items.map((it) => it.agent.key),
    ["mac2/r1", "mac1/a2", "mac1/a1", "mac1/a3"],
  );
});
