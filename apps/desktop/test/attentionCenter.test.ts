import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent } from "@herdr-pocket/protocol";
import { liveStore } from "../src/lib/store.ts";
import { shellStore, tabLeaves } from "../src/shell/shellStore.ts";
import {
  attentionStore,
  classifyAttentionCategory,
  createAttentionTracker,
  jumpToAttentionAgent,
  pushNotchNow,
  reconcileAttentionSnapshot,
  resetNotchSyncDedupeForTest,
  sortAttentionItems,
  type AttentionItem,
} from "../src/lib/attentionCenter.ts";

function makeAgent(patch: Partial<Agent> & Pick<Agent, "key">): Agent {
  return {
    deviceId: "d1",
    source: "hc",
    localId: patch.key,
    harness: "claude-code",
    status: "idle",
    updatedAt: 1000,
    ...patch,
  };
}

test("classifyAttentionCategory and sortAttentionItems categorize all 4 Ovis tiers in priority order", () => {
  assert.equal(
    classifyAttentionCategory(makeAgent({ key: "d1/a1", status: "blocked", statusKind: "permission" })),
    "approval",
  );
  assert.equal(
    classifyAttentionCategory(makeAgent({ key: "d1/a2", status: "blocked", statusNote: "是否继续发布版本?" })),
    "question",
  );
  assert.equal(
    classifyAttentionCategory(makeAgent({ key: "d1/a3", status: "idle", errored: true, statusNote: "504" })),
    "error",
  );
  assert.equal(
    classifyAttentionCategory(makeAgent({ key: "d1/a4", status: "done" })),
    "completed",
  );
  assert.equal(classifyAttentionCategory(makeAgent({ key: "d1/a5", status: "working" })), null);

  const shuffled: AttentionItem[] = [
    { id: "c", agentKey: "k4", category: "completed", title: "Done", subtitle: "", ts: 900 },
    { id: "q", agentKey: "k2", category: "question", title: "Question", subtitle: "", ts: 100 },
    { id: "e", agentKey: "k3", category: "error", title: "Error", subtitle: "", ts: 500 },
    { id: "a", agentKey: "k1", category: "approval", title: "Approval", subtitle: "", ts: 50 },
  ];
  assert.deepEqual(
    sortAttentionItems(shuffled).map((i) => i.category),
    ["approval", "question", "error", "completed"],
  );
});

test("reconcileAttentionSnapshot suppresses chimes for actively viewed agents and alerts on unfocused transitions", () => {
  const tracker = createAttentionTracker();
  const initialAgents = [
    makeAgent({ key: "d1/bg", status: "working", statusSince: 1_000 }),
    makeAgent({ key: "d1/fg", status: "working", statusSince: 1_000 }),
    makeAgent({ key: "d1/preblocked", status: "blocked", statusKind: "permission", statusNote: "Allow Bash?" }),
  ];

  // Initial seed populates existing blocked agents silently with zero chimes/peeks.
  const seed = reconcileAttentionSnapshot(tracker, [], initialAgents, new Set(["d1/fg"]), true, 2_000);
  assert.equal(seed.chimes.length, 0);
  assert.equal(seed.newPeek, null);
  assert.deepEqual(seed.items.map((x) => [x.agentKey, x.category]), [["d1/preblocked", "approval"]]);

  // Foreground focused agent finishes long work -> no chime/peek; background agent finishes after 60s -> peek + chime.
  const nextAgents = [
    makeAgent({ key: "d1/bg", status: "done", updatedAt: 62_000 }),
    makeAgent({ key: "d1/fg", status: "done", updatedAt: 62_000 }),
    makeAgent({ key: "d1/preblocked", status: "blocked", statusKind: "permission", statusNote: "Allow Bash?" }),
  ];
  const afterDone = reconcileAttentionSnapshot(
    tracker,
    seed.items,
    nextAgents,
    new Set(["d1/fg"]),
    true,
    62_000,
  );
  assert.deepEqual(afterDone.chimes, [{ kind: "done", elapsedMs: 61_000 }]);
  assert.equal(afterDone.newPeek?.agentKey, "d1/bg");
  assert.equal(afterDone.newPeek?.category, "completed");
  assert.deepEqual(afterDone.items.map((x) => x.agentKey), ["d1/preblocked", "d1/bg"]);

  // Once resolved/focused again, stale items clean out automatically.
  const focusedNow = reconcileAttentionSnapshot(
    tracker,
    afterDone.items,
    [
      makeAgent({ key: "d1/bg", status: "done", updatedAt: 65_000 }),
      makeAgent({ key: "d1/preblocked", status: "working", updatedAt: 65_000 }),
    ],
    new Set(["d1/bg"]),
    true,
    65_000,
  );
  assert.equal(focusedNow.items.length, 0);
});

test("notch-hud.html and notch-hud.js enforce strict CSP and zero emojis", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(resolve(testDir, "../public/notch-hud.html"), "utf8");
  const js = readFileSync(resolve(testDir, "../public/notch-hud.js"), "utf8");
  const ac = readFileSync(resolve(testDir, "../src/lib/attentionCenter.ts"), "utf8");

  assert.match(html, /Content-Security-Policy/i);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /<script>[\s\S]*\S[\s\S]*<\/script>/);
  assert.match(js, /window\.__notch\s*=/);
  assert.match(js, /pocket-notch:\/\/jump\?key=/);
  const emojiRe = /[\u{1F300}-\u{1FAFF}]/u;
  assert.equal(emojiRe.test(html), false, "notch-hud.html must not contain emojis");
  assert.equal(emojiRe.test(js), false, "notch-hud.js must not contain emojis");
  assert.equal(emojiRe.test(ac), false, "attentionCenter.ts must not contain emojis");
});

test("jumpToAttentionAgent activates existing split pane across spaces, unzooms sibling zoom, and clears its queue entry", () => {
  const targetAgent = makeAgent({ key: "d1/hc:target", where: "work / target", status: "blocked", statusKind: "permission" });
  const siblingAgent = makeAgent({ key: "d1/hc:sib", where: "work / sib", status: "working" });
  const otherAgent = makeAgent({ key: "d1/hc:other", where: "other / main", status: "idle" });
  liveStore.set({
    agents: { d1: [targetAgent, siblingAgent, otherAgent] },
    spaces: { d1: [{ id: "s1", name: "work" }, { id: "s2", name: "other" }] as any },
  });
  shellStore.set({
    selectedSpace: "d1\u0000other",
    active: "tab-other",
    activeBySpace: { "d1\u0000other": "tab-other", "d1\u0000work": "tab-work" },
    tabs: [
      {
        id: "tab-other",
        kind: "agent",
        agentKey: "d1/hc:other",
      },
      {
        id: "tab-work",
        kind: "agent",
        agentKey: "d1/hc:sib",
        split: {
          focusedPaneId: "p-sib",
          zoomedPaneId: "p-sib",
          root: {
            type: "split",
            id: "s-root",
            axis: "row",
            weight: 1,
            children: [
              { type: "leaf", id: "p-sib", weight: 1, content: { kind: "agent", agentKey: "d1/hc:sib" } },
              { type: "leaf", id: "p-target", weight: 1, content: { kind: "agent", agentKey: "d1/hc:target" } },
            ],
          },
        },
      },
    ],
  });
  attentionStore.set({
    items: [{ id: "d1/hc:target:approval", agentKey: "d1/hc:target", category: "approval", title: "work · target", subtitle: "Allow", ts: 1000 }],
    peek: null,
    windowFocused: true,
  });

  assert.equal(jumpToAttentionAgent("d1/hc:target"), true);
  const next = shellStore.get();
  assert.equal(next.selectedSpace, "d1\u0000work");
  assert.equal(next.active, "tab-work");
  const workTab = next.tabs.find((t) => t.id === "tab-work");
  assert.equal(workTab?.split?.focusedPaneId, "p-target");
  assert.equal(workTab?.split?.zoomedPaneId, undefined);
  assert.equal(tabLeaves(workTab!).length, 2);
  assert.equal(attentionStore.get().items.length, 0);
});

test("pushNotchNow skips duplicate serialized notch payloads", () => {
  resetNotchSyncDedupeForTest();
  attentionStore.set({
    items: [{ id: "d1/hc:a:done", agentKey: "d1/hc:a", category: "completed", title: "Done", subtitle: "ok", ts: 1234 }],
    peek: null,
    windowFocused: true,
  });
  assert.equal(pushNotchNow(), true);
  assert.equal(pushNotchNow(), false);
  attentionStore.set({
    items: [{ id: "d1/hc:a:done", agentKey: "d1/hc:a", category: "completed", title: "Done 2", subtitle: "ok", ts: 1235 }],
    peek: null,
    windowFocused: true,
  });
  assert.equal(pushNotchNow(), true);
  assert.equal(pushNotchNow(), false);
});
