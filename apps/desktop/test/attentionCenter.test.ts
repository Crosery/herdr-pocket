import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { Agent } from "@herdr-pocket/protocol";

registerHooks({
  load(url, context, nextLoad) {
    if ((url.endsWith(".tsx") || url.endsWith(".ts")) && !url.includes("/node_modules/") && !url.endsWith("attentionCenter.test.ts")) {
      const sourceText = readFileSync(fileURLToPath(url), "utf8");
      const out = ts.transpileModule(sourceText, {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      return { format: "module", shortCircuit: true, source: out.outputText };
    }
    return nextLoad(url, context);
  },
});

const { liveStore, settingsStore } = await import("../src/lib/store.ts");
const { shellStore, tabLeaves } = await import("../src/shell/shellStore.ts");
const { PocketDroplet } = await import("../src/components/PocketDroplet.tsx");
const {
  attentionStore,
  classifyAttentionCategory,
  createAttentionTracker,
  jumpToAttentionAgent,
  reconcileAttentionSnapshot,
  sortAttentionItems,
} = await import("../src/lib/attentionCenter.ts");
type AttentionItem = import("../src/lib/attentionCenter.ts").AttentionItem;

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
  assert.equal(
    classifyAttentionCategory(
      makeAgent({
        key: "d1/a6",
        status: "working",
        interaction: { kind: "question", prompt: "Choose deploy mode", source: "terminal" },
      }),
    ),
    "question",
  );
  assert.equal(
    classifyAttentionCategory(
      makeAgent({
        key: "d1/a7",
        status: "working",
        interaction: { kind: "permission", prompt: "Allow command?", source: "terminal" },
      }),
    ),
    "approval",
  );
  assert.equal(
    classifyAttentionCategory(
      makeAgent({
        key: "d1/a8",
        status: "working",
        interaction: { kind: "auth", prompt: "Sign in required", source: "terminal" },
      }),
    ),
    "approval",
  );
  // Defense-in-depth: permission/auth statusKind must never be downgraded by a question interaction,
  // while a stale statusKind on a non-blocked idle agent must not trigger approval.
  assert.equal(
    classifyAttentionCategory(
      makeAgent({
        key: "d1/a9",
        status: "blocked",
        statusKind: "permission",
        interaction: { kind: "question", prompt: "Do you want to proceed?", source: "terminal" },
      }),
    ),
    "approval",
  );
  assert.equal(
    classifyAttentionCategory(makeAgent({ key: "d1/a10", status: "idle", statusKind: "permission" })),
    null,
  );

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

test("PocketDroplet renders attention peek popup cleanly with zero emojis and notch-hud assets are removed", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = resolve(testDir, "..");
  assert.equal(existsSync(resolve(desktopRoot, "public/notch-hud.html")), false, "public/notch-hud.html removed");
  assert.equal(existsSync(resolve(desktopRoot, "public/notch-hud.js")), false, "public/notch-hud.js removed");
  assert.equal(existsSync(resolve(desktopRoot, "src-tauri/src/notch.rs")), false, "src-tauri/src/notch.rs removed");

  const ac = readFileSync(resolve(desktopRoot, "src/lib/attentionCenter.ts"), "utf8");
  const dropletSrc = readFileSync(resolve(desktopRoot, "src/components/PocketDroplet.tsx"), "utf8");
  const emojiRe = /[\u{1F300}-\u{1FAFF}]/u;
  assert.equal(emojiRe.test(ac), false, "attentionCenter.ts must not contain emojis");
  assert.equal(emojiRe.test(dropletSrc), false, "PocketDroplet.tsx must not contain emojis");

  const prevNotif = settingsStore.get().notifications;
  const prevAtt = attentionStore.get();
  try {
    settingsStore.set({ notifications: true });
    attentionStore.set({
      items: [
        { id: "i1", agentKey: "h1/hc:t1", category: "approval", title: "work · app", subtitle: "需要审批确认", ts: 1000 },
        { id: "i2", agentKey: "h1/hc:t2", category: "completed", title: "work · web", subtitle: "已完成", ts: 900 },
      ],
      peek: { id: "i1", agentKey: "h1/hc:t1", category: "approval", title: "work · app", subtitle: "需要审批确认", ts: 1000 },
      windowFocused: true,
    });
    const html = renderToStaticMarkup(React.createElement(PocketDroplet));
    assert.match(html, /需要审批/);
    assert.match(html, /work · app/);
    assert.match(html, /\+1/);
  } finally {
    settingsStore.set({ notifications: prevNotif });
    attentionStore.set(prevAtt);
  }
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

test("reconcileAttentionSnapshot tracks working agents with active interaction without double-chiming on blocked transition", () => {
  const tracker = createAttentionTracker();
  const seed = reconcileAttentionSnapshot(
    tracker,
    [],
    [makeAgent({ key: "d1/codex", status: "working", statusSince: 1_000 })],
    new Set(),
    true,
    2_000,
  );
  assert.equal(seed.items.length, 0);

  // Hostd attaches interaction.kind === "question" while status stays "working"
  const asked = reconcileAttentionSnapshot(
    tracker,
    seed.items,
    [
      makeAgent({
        key: "d1/codex",
        status: "working",
        interaction: { kind: "question", prompt: "确认执行迁移？", source: "terminal" },
      }),
    ],
    new Set(),
    true,
    3_000,
  );
  assert.equal(asked.items.length, 1);
  assert.equal(asked.items[0]!.category, "question");
  assert.equal(asked.items[0]!.subtitle, "确认执行迁移？");
  assert.equal(asked.chimes.length, 1);
  assert.equal(asked.newPeek?.agentKey, "d1/codex");

  // Status later flips to "blocked" while interaction stays active -> no duplicate chime
  const nowBlocked = reconcileAttentionSnapshot(
    tracker,
    asked.items,
    [
      makeAgent({
        key: "d1/codex",
        status: "blocked",
        interaction: { kind: "question", prompt: "确认执行迁移？", source: "terminal" },
      }),
    ],
    new Set(),
    true,
    4_000,
  );
  assert.equal(nowBlocked.items.length, 1);
  assert.equal(nowBlocked.chimes.length, 0);

  // Interaction resolves & agent resumes working -> cleared from attention queue
  const resumed = reconcileAttentionSnapshot(
    tracker,
    nowBlocked.items,
    [makeAgent({ key: "d1/codex", status: "working" })],
    new Set(),
    true,
    5_000,
  );
  assert.equal(resumed.items.length, 0);
});
