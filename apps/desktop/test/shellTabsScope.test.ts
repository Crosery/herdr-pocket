import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALL_SPACES_KEY,
  activeTabIdForSpace,
  moveTabRelative,
  openFileTab,
  openWebTab,
  setActiveTab,
  setSelectedSpace,
  shellStore,
  spaceKeyFromAgent,
  visibleTabsForSpace,
  type AgentSpaceRef,
  type ShellTab,
} from "../src/shell/shellStore.ts";

const agents: Record<string, AgentSpaceRef> = {
  a1: { deviceId: "dev1", where: "repoA / main" },
  a2: { deviceId: "dev1", where: "repoB / dev" },
  a3: { deviceId: "dev2", where: "repoA / feat" },
};
const lookup = (key: string) => agents[key];

test("spaceKeyFromAgent & visibleTabsForSpace filter tabs cleanly when a Space is selected", () => {
  const spA = spaceKeyFromAgent(agents.a1!);
  const spB = spaceKeyFromAgent(agents.a2!);
  const spOtherDev = spaceKeyFromAgent(agents.a3!);

  const tabs: ShellTab[] = [
    { id: "a:a1", kind: "agent", agentKey: "a1" },
    { id: "f:a1:README.md", kind: "file", agentKey: "a1", path: "README.md", title: "README.md" },
    { id: "w:webA", kind: "web", url: "https://example.com", title: "Docs", spaceKey: spA },
    { id: "a:a2", kind: "agent", agentKey: "a2" },
    { id: "w:global", kind: "web", url: "https://example.org", title: "Global" },
    { id: "a:a3", kind: "agent", agentKey: "a3" },
  ];

  // Default (null) returns all tabs.
  assert.equal(visibleTabsForSpace(tabs, null, lookup).length, 6);

  // Space A shows a1, file on a1, and web tab belonging to Space A.
  const onlyA = visibleTabsForSpace(tabs, spA, lookup);
  assert.deepEqual(
    onlyA.map((t) => t.id),
    ["a:a1", "f:a1:README.md", "w:webA"],
  );

  // Space B shows only a2.
  const onlyB = visibleTabsForSpace(tabs, spB, lookup);
  assert.deepEqual(
    onlyB.map((t) => t.id),
    ["a:a2"],
  );

  // Same folder name on another device stays distinct.
  assert.notEqual(spA, spOtherDev);
  assert.deepEqual(
    visibleTabsForSpace(tabs, spOtherDev, lookup).map((t) => t.id),
    ["a:a3"],
  );

  // activeTabIdForSpace falls back to remembered or first tab in that space.
  const activeInB = activeTabIdForSpace(
    { tabs, active: "a:a1", selectedSpace: spB, activeBySpace: {} },
    lookup,
  );
  assert.equal(activeInB, "a:a2");
});

test("setSelectedSpace remembers per-space active tab and moveTabRelative reorders smoothly", () => {
  const spA = spaceKeyFromAgent(agents.a1!);
  const spB = spaceKeyFromAgent(agents.a2!);
  shellStore.set({
    tabs: [
      { id: "a:a1", kind: "agent", agentKey: "a1" },
      { id: "a:a2", kind: "agent", agentKey: "a2" },
    ],
    active: "a:a1",
    selectedSpace: null,
    activeBySpace: {},
    panel: null,
    panelWidth: 368,
    subagentAside: null,
    settings: null,
    palette: false,
    peek: null,
  });

  setSelectedSpace(spA, lookup);
  assert.equal(shellStore.get().active, "a:a1");
  openFileTab("a1", "src/index.ts", "index.ts");
  assert.equal(shellStore.get().active, "f:a1:src/index.ts");

  setSelectedSpace(spB, lookup);
  assert.equal(shellStore.get().active, "a:a2");

  // Switching back to Space A restores the file tab instead of resetting to a1.
  setSelectedSpace(spA, lookup);
  assert.equal(shellStore.get().active, "f:a1:src/index.ts");

  // New web tab inherits current Space filter, and returning to null shows all.
  openWebTab("https://docs.example.com", "Docs");
  const webTab = shellStore.get().tabs.find((t) => t.kind === "web");
  assert.equal(webTab?.kind === "web" ? webTab.spaceKey : null, spA);

  setSelectedSpace(null, lookup);
  assert.equal(shellStore.get().activeBySpace[ALL_SPACES_KEY], "a:a1");
  setActiveTab("a:a2");
  assert.equal(shellStore.get().active, "a:a2");

  moveTabRelative("a:a2", "a:a1", "before");
  assert.equal(shellStore.get().tabs[0]?.id, "a:a2");
});
