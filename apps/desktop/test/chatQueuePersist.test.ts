import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import {
  cancelPendingModelSwitch,
  chatQueueStore,
  enqueuePrompt,
  injectTerminalQueuedNow,
  interruptComposerNow,
  resetChatQueueForTest,
  schedulePendingModelSwitch,
} from "../src/lib/chatQueue.ts";
import { filterTerminalQueuedItems } from "../src/lib/chatQueueLogic.ts";
import { DEMO_URL, mockApi } from "../src/lib/mock.ts";
import { settingsStore } from "../src/lib/store.ts";
import {
  getComposerDraft,
  resetComposerDraftsForTest,
  setComposerDraftAttachments,
  setComposerDraftText,
  subscribeComposerDrafts,
} from "../src/lib/composerDrafts.ts";
import {
  hydrateAttachment,
  serializeAttachment,
  type StagedAttachment,
} from "../src/lib/dropPreview.ts";
import {
  WORKSPACE_STATE_KEY,
  flushWorkspaceStateNow,
  hydrateWorkspaceState,
  resetWorkspacePersistForTest,
} from "../src/lib/workspacePersist.ts";
import { openAgentTab, shellStore, showPanel } from "../src/shell/shellStore.ts";

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    storage.set(k, v);
  },
  removeItem: (k: string) => {
    storage.delete(k);
  },
};

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function sampleImageAttachment(id = "att-1"): StagedAttachment {
  return {
    id,
    sig: `sig-${id}`,
    name: "screenshot.png",
    mime: "image/png",
    size: 68,
    kind: "image",
    put: { name: "screenshot.png", mime: "image/png", data: TINY_PNG_B64 },
    previewUrl: "blob:ephemeral-before-restart",
  };
}

beforeEach(() => {
  storage.clear();
  resetChatQueueForTest();
  resetComposerDraftsForTest();
  resetWorkspacePersistForTest();
  shellStore.set({
    tabs: [],
    active: null,
    selectedSpace: null,
    activeBySpace: {},
    panel: null,
    panelWidth: 368,
  });
});

afterEach(() => {
  resetChatQueueForTest();
  resetComposerDraftsForTest();
  resetWorkspacePersistForTest();
  storage.clear();
});

test("serializeAttachment & hydrateAttachment strip ephemeral fields and recreate previewUrl", () => {
  const att = sampleImageAttachment("att-42");
  const serialized = serializeAttachment(att);
  assert.equal("file" in serialized, false);
  assert.equal("previewUrl" in serialized, false);
  assert.equal(serialized.put?.data, TINY_PNG_B64);

  const hydrated = hydrateAttachment(serialized);
  assert.equal(hydrated.id, "att-42");
  assert.equal(hydrated.name, "screenshot.png");
  assert.equal(hydrated.put?.data, TINY_PNG_B64);
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    assert.ok(hydrated.previewUrl?.startsWith("blob:"));
    URL.revokeObjectURL(hydrated.previewUrl!);
  }
});

test("chatQueue persistence keeps queued items, drops sent items, and marks interrupted sending as failed", async () => {
  const agent = { key: "host1/hc:t1", deviceId: "host1" };
  enqueuePrompt(agent, "排队中的消息", [sampleImageAttachment("att-q1")]);
  chatQueueStore.set((prev) => ({
    ...prev,
    outgoingByAgent: {
      [agent.key]: [
        {
          id: "out-100-1",
          agentKey: agent.key,
          deviceId: agent.deviceId,
          text: "已经发成功的消息",
          attachments: [],
          attachedCount: 0,
          attachedNames: [],
          ts: 1000,
          state: "sent",
        },
        {
          id: "out-100-2",
          agentKey: agent.key,
          deviceId: agent.deviceId,
          text: "重启前正在发送的消息",
          attachments: [sampleImageAttachment("att-out2")],
          attachedCount: 1,
          attachedNames: ["screenshot.png"],
          ts: 2000,
          state: "sending",
        },
        {
          id: "out-100-3",
          agentKey: agent.key,
          deviceId: agent.deviceId,
          text: "之前失败的消息",
          attachments: [],
          attachedCount: 0,
          attachedNames: [],
          ts: 3000,
          state: "failed",
          error: "网络超时",
        },
      ],
    },
  }));

  await flushWorkspaceStateNow();
  const savedRaw = storage.get(WORKSPACE_STATE_KEY);
  assert.ok(savedRaw, "workspace state should be saved");

  // Simulate process restart with empty in-memory stores.
  resetChatQueueForTest();
  resetWorkspacePersistForTest();
  storage.set(WORKSPACE_STATE_KEY, savedRaw);

  await hydrateWorkspaceState();

  const restored = chatQueueStore.get();
  const qList = restored.queuedByAgent[agent.key] ?? [];
  assert.equal(qList.length, 1);
  assert.equal(qList[0]!.text, "排队中的消息");
  assert.equal(qList[0]!.attachments.length, 1);
  assert.equal(qList[0]!.attachments[0]!.put?.data, TINY_PNG_B64);

  const outList = restored.outgoingByAgent[agent.key] ?? [];
  assert.equal(outList.length, 2, "already-sent item must not reappear");
  assert.equal(outList[0]!.id, "out-100-2");
  assert.equal(outList[0]!.state, "failed");
  assert.equal(outList[0]!.error, "应用重启前发送中断，点击可重试");
  assert.equal(outList[0]!.attachments.length, 1);
  assert.equal(outList[1]!.id, "out-100-3");
  assert.equal(outList[1]!.state, "failed");
  assert.equal(outList[1]!.error, "网络超时");
});

test("composerDrafts persist text and attachments across restarts and notify subscribers on hydration", async () => {
  setComposerDraftText("host1/hc:draft1", "带图片草稿");
  setComposerDraftAttachments("host1/hc:draft1", [sampleImageAttachment("att-d1")]);
  setComposerDraftAttachments("host1/hc:draft2", [
    {
      id: "att-d2",
      sig: "ws:host1/hc:draft2:file:README.md",
      name: "README.md",
      mime: "text/markdown",
      size: 0,
      kind: "text",
      hostRef: "/tmp/README.md",
    },
  ]);

  await flushWorkspaceStateNow();
  const savedWorkspace = storage.get(WORKSPACE_STATE_KEY);
  assert.ok(savedWorkspace);

  // Wipe both in-memory caches and legacy draft storage key, keeping only workspace-state.
  resetComposerDraftsForTest();
  resetWorkspacePersistForTest();
  storage.clear();
  storage.set(WORKSPACE_STATE_KEY, savedWorkspace);

  let notified = 0;
  const unsub = subscribeComposerDrafts(() => {
    notified += 1;
  });

  await hydrateWorkspaceState();
  unsub();

  assert.equal(notified, 1);
  const d1 = getComposerDraft("host1/hc:draft1");
  assert.equal(d1.text, "带图片草稿");
  assert.equal(d1.attachments.length, 1);
  assert.equal(d1.attachments[0]!.put?.data, TINY_PNG_B64);
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    assert.ok(d1.attachments[0]!.previewUrl?.startsWith("blob:"));
  }

  const d2 = getComposerDraft("host1/hc:draft2");
  assert.equal(d2.text, "");
  assert.equal(d2.attachments.length, 1);
  assert.equal(d2.attachments[0]!.hostRef, "/tmp/README.md");
});

test("shellStore mirrors tabs and panel state into workspacePersist across restart", async () => {
  openAgentTab("host1/hc:t1", "chat");
  showPanel("files");
  await flushWorkspaceStateNow();
  const savedWorkspace = storage.get(WORKSPACE_STATE_KEY);
  assert.ok(savedWorkspace);

  resetWorkspacePersistForTest();
  storage.clear();
  shellStore.set({ tabs: [], active: null, panel: null });
  storage.set(WORKSPACE_STATE_KEY, savedWorkspace);

  await hydrateWorkspaceState();
  assert.equal(shellStore.get().tabs.length, 1);
  assert.equal(shellStore.get().active, "a:host1/hc:t1");
  assert.equal(shellStore.get().panel, "files");
});

test("pendingSwitchByAgent coalesces model + thinking switches separately from queuedByAgent and persists across restart", async () => {
  const agent = { key: "host1/hc:sw1", deviceId: "host1", harness: "claude" };

  schedulePendingModelSwitch(agent, { modelId: "claude-sonnet-4-6" });
  schedulePendingModelSwitch(agent, { thinkingLevel: "high" });

  const state = chatQueueStore.get();
  assert.equal(state.queuedByAgent[agent.key]?.length ?? 0, 0);
  const sw = state.pendingSwitchByAgent[agent.key];
  assert.ok(sw);
  assert.equal(sw.modelId, "claude-sonnet-4-6");
  assert.equal(sw.thinkingLevel, "high");
  assert.match(sw.label, /claude-sonnet-4-6/);
  assert.match(sw.label, /high/);

  await flushWorkspaceStateNow();
  const savedWorkspace = storage.get(WORKSPACE_STATE_KEY);
  assert.ok(savedWorkspace);

  resetChatQueueForTest();
  resetWorkspacePersistForTest();
  storage.clear();
  storage.set(WORKSPACE_STATE_KEY, savedWorkspace);

  await hydrateWorkspaceState();
  const restored = chatQueueStore.get().pendingSwitchByAgent[agent.key];
  assert.ok(restored);
  assert.equal(restored.modelId, "claude-sonnet-4-6");
  assert.equal(restored.thinkingLevel, "high");

  cancelPendingModelSwitch(agent.key);
  assert.equal(chatQueueStore.get().pendingSwitchByAgent[agent.key], undefined);
});

test("filterTerminalQueuedItems suppresses duplicates across unmatched, app queue, injected, and foldedRows", () => {
  const remaining = filterTerminalQueuedItems(
    ["  ", "消息一", "消息二", "消息三", "消息四", "未发消息"],
    [{ id: "out-1", text: "消息一", attachments: [], attachedCount: 0, ts: 10, state: "sent" }],
    ["消息二"],
    new Set(["消息三"]),
    [
      {
        id: "u-1",
        kind: "user",
        text: "消息四",
        ts: 20,
        images: [],
        attachedLines: [],
      },
    ],
  );
  assert.deepEqual(remaining, ["未发消息"]);
});

test("interruptComposerNow keeps one sent bubble even if terminal.send returns waiting: true", async () => {
  const prevServer = settingsStore.get().server;
  const origCall = mockApi.call;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  settingsStore.set({ ...settingsStore.get(), server: DEMO_URL });
  mockApi.call = (async (_to: string, method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === "terminal.send") return { ok: true, waiting: true };
    return { ok: true };
  }) as typeof mockApi.call;
  try {
    const ok = await interruptComposerNow(
      { key: "host1/hc:int1", deviceId: "host1", status: "working" },
      "马上处理这个",
      [],
    );
    assert.equal(ok, true);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["terminal.interrupt", "terminal.send"],
    );
    const outgoing = chatQueueStore.get().outgoingByAgent["host1/hc:int1"] ?? [];
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0]!.text, "马上处理这个");
    assert.equal(outgoing[0]!.state, "sent");
  } finally {
    mockApi.call = origCall;
    settingsStore.set({ ...settingsStore.get(), server: prevServer });
  }
});

test("injectTerminalQueuedNow promotes existing queued_terminal bubble without duplicating and hides shelf item", async () => {
  const prevServer = settingsStore.get().server;
  const origCall = mockApi.call;
  const keyCalls: string[][] = [];
  settingsStore.set({ ...settingsStore.get(), server: DEMO_URL });
  mockApi.call = (async (_to: string, method: string, params: Record<string, unknown>) => {
    if (method === "terminal.keys" && Array.isArray(params.keys)) {
      keyCalls.push(params.keys.map(String));
    }
    return { ok: true };
  }) as typeof mockApi.call;
  try {
    const agent = { key: "host1/hc:inj1", deviceId: "host1" };
    chatQueueStore.set({
      ...chatQueueStore.get(),
      outgoingByAgent: {
        [agent.key]: [
          {
            id: "out-q1",
            agentKey: agent.key,
            deviceId: agent.deviceId,
            text: "插队消息",
            attachments: [],
            attachedCount: 0,
            attachedNames: [],
            ts: 100,
            state: "queued_terminal",
          },
        ],
      },
    });
    await injectTerminalQueuedNow(agent, "插队消息");
    assert.deepEqual(keyCalls, [["alt+m"]]);
    const state = chatQueueStore.get();
    const outgoing = state.outgoingByAgent[agent.key] ?? [];
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0]!.id, "out-q1");
    assert.equal(outgoing[0]!.state, "sent");
    const injectedSet = new Set((state.injectedTerminalByAgent[agent.key] ?? []).map((r) => r.text));
    assert.deepEqual(filterTerminalQueuedItems(["插队消息", "下一条"], [], [], injectedSet), ["下一条"]);
  } finally {
    mockApi.call = origCall;
    settingsStore.set({ ...settingsStore.get(), server: prevServer });
  }
});
