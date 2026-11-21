import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Agent, AgentModelsResult } from "@herdr-pocket/protocol";
import {
  collectPeerModels,
  computeAutoAgentModelMeta,
  fetchAgentModelsWithFallback,
  getInitialAgentModelsSeed,
  invalidateModelCatalogCache,
  patchCachedAgentModelMeta,
  seedModelCatalogCacheForTest,
  updateAgentRoleModel,
} from "../src/lib/modelCatalogClient.ts";

const baseAgent: Agent = {
  key: "dev-1/hc:t1",
  deviceId: "dev-1",
  source: "hc",
  localId: "t1",
  harness: "oh-my-pi",
  title: "Test Agent",
  status: "idle",
  model: "magpie/crosery/gpt-6.2-astra-fast",
  sessionKey: "omp:01a1fe83-1f9a-73e1-92ca-7ff20d80c2be",
  isShell: false,
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  invalidateModelCatalogCache();
});

test("fetchAgentModelsWithFallback returns RPC result when host supports agent.models", async () => {
  const expected: AgentModelsResult = {
    harness: "oh-my-pi",
    currentModel: "magpie/crosery/gpt-6.2-astra-fast",
    currentThinking: "max",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    canSwitchThinking: true,
    thinkingLabel: "思考等级",
    canSwitch: true,
    models: [
      { id: "magpie/crosery/gpt-6.2-astra-fast", label: "Astra Fast", reasoning: true, source: "current" },
    ],
  };

  let invokedLocal = false;
  const res = await fetchAgentModelsWithFallback(baseAgent, [], {
    deps: {
      rpcCall: async () => expected,
      isTauri: () => true,
      getLocalHostId: async () => "dev-1",
      invokeLocalAgentModels: async () => {
        invokedLocal = true;
        return expected;
      },
    },
  });

  assert.deepEqual(res, expected);
  assert.equal(invokedLocal, false);
});

test("fetchAgentModelsWithFallback falls back to local_agent_models on local Tauri host when RPC returns unknown method", async () => {
  const localRes: AgentModelsResult = {
    harness: "oh-my-pi",
    currentModel: "magpie/crosery/gpt-6.2-sol-ultrafast",
    currentThinking: "max",
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    canSwitchThinking: true,
    thinkingLabel: "思考等级",
    canSwitch: true,
    models: [
      { id: "magpie/crosery/gpt-6.2-sol-ultrafast", label: "Sol Ultrafast", reasoning: true, source: "current" },
    ],
  };

  const res = await fetchAgentModelsWithFallback(
    { ...baseAgent, source: "uniflo" },
    [],
    {
      deps: {
        rpcCall: async () => {
          throw new Error("unknown method agent.models");
        },
        isTauri: () => true,
        getLocalHostId: async () => "dev-1",
        invokeLocalAgentModels: async () => localRes,
      },
    },
  );

  assert.equal(res.currentModel, "magpie/crosery/gpt-6.2-sol-ultrafast");
  assert.equal(res.currentThinking, "max");
  // Normalizes canSwitch / reason to match uniflo read-only source
  assert.equal(res.canSwitch, false);
  assert.equal(res.canSwitchThinking, false);
  assert.ok(res.reason?.includes("历史"));
});

test("fetchAgentModelsWithFallback synthesizes fallback models on remote legacy hosts without surfacing unknown method errors", async () => {
  const peerModels = collectPeerModels(baseAgent, {
    "dev-1": [
      baseAgent,
      { ...baseAgent, key: "dev-1/hc:t2", model: "magpie/crosery/gpt-6.2-sol-ultrafast" },
      { ...baseAgent, key: "dev-1/hc:t3", harness: "claude-code", model: "claude-opus-5-5:high" },
      { ...baseAgent, key: "dev-1/hc:sh1", harness: "zsh", isShell: true, model: "ignored-shell" },
    ],
  });
  assert.deepEqual(peerModels, ["magpie/crosery/gpt-6.2-sol-ultrafast", "claude-opus-5-5"]);

  const res = await fetchAgentModelsWithFallback(baseAgent, peerModels, {
    deps: {
      rpcCall: async () => {
        throw Object.assign(new Error("unknown method agent.models"), { code: "unsupported" });
      },
      isTauri: () => false,
      getLocalHostId: async () => null,
      invokeLocalAgentModels: async () => {
        throw new Error("should not run");
      },
    },
  });

  assert.equal(res.canSwitch, true);
  assert.equal(res.canSwitchThinking, true);
  assert.equal(res.currentModel, "magpie/crosery/gpt-6.2-astra-fast");
  assert.ok(res.models.some((m) => m.id === "magpie/crosery/gpt-6.2-sol-ultrafast" && m.source === "recent"));
  assert.ok(!JSON.stringify(res).includes("unknown method"));
});

test("getInitialAgentModelsSeed keeps explicit non-reasoning models disabled even with hasReasoningEvents, while rescuing unknown custom models", () => {
  const nonReasonSeed = getInitialAgentModelsSeed(
    { ...baseAgent, model: "demo/gemini-1.5-pro" },
    ["magpie/crosery/gpt-6.2-sol-ultrafast"],
    { hasReasoningEvents: true },
  );
  assert.equal(nonReasonSeed.canSwitch, true);
  assert.equal(nonReasonSeed.canSwitchThinking, false);
  assert.equal(nonReasonSeed.thinkingLevels, undefined);
  assert.ok(nonReasonSeed.models.length >= 2);

  const rescuedSeed = getInitialAgentModelsSeed(
    { ...baseAgent, harness: "custom-cli", model: "custom-private-model" },
    [],
    { hasReasoningEvents: true },
  );
  assert.equal(rescuedSeed.canSwitch, true);
  assert.equal(rescuedSeed.canSwitchThinking, true);
  assert.deepEqual(rescuedSeed.thinkingLevels, ["low", "medium", "high"]);
});

test("fetchAgentModelsWithFallback races/merges local_agent_models for slow remote omp hosts and updates when remote finishes", async () => {
  const remoteAgent: Agent = { ...baseAgent, key: "remote-1/hc:t9", deviceId: "remote-1", model: "magpie/crosery/mimo-v2.6-pro" };
  let capturedSessionKey: string | null = "not-called";
  let releaseRemote: ((v: AgentModelsResult) => void) | undefined;
  const remotePromise = new Promise<AgentModelsResult>((resolve) => {
    releaseRemote = resolve;
  });

  const localRes: AgentModelsResult = {
    harness: "oh-my-pi",
    currentModel: "magpie/crosery/mimo-v2.6-pro",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
    canSwitchThinking: true,
    canSwitch: true,
    modelRoles: { default: "local-only-should-not-leak" },
    models: [
      { id: "magpie/crosery/mimo-v2.6-pro", label: "MiMo V2.6 Pro", reasoning: true, source: "current" },
      { id: "magpie/crosery/gpt-6.2-astra-fast", label: "Astra Fast", reasoning: true, source: "catalog" },
    ],
  };

  let lateUpdate: AgentModelsResult | null = null;
  const res = await fetchAgentModelsWithFallback(remoteAgent, [], {
    remoteRaceMs: 25,
    onUpdate: (u) => {
      lateUpdate = u;
    },
    deps: {
      rpcCall: () => remotePromise,
      isTauri: () => true,
      getLocalHostId: async () => "local-desktop",
      invokeLocalAgentModels: async (params) => {
        capturedSessionKey = params.sessionKey;
        return localRes;
      },
    },
  });

  // Remote host must not read local desktop's sessionKey or leak local modelRoles
  assert.equal(capturedSessionKey, null);
  assert.equal(res.modelRoles, undefined);
  assert.ok(res.models.some((m) => m.id === "magpie/crosery/gpt-6.2-astra-fast"));

  // Late remote completion merges remote modelRoles + models cleanly via onUpdate
  releaseRemote?.({
    harness: "oh-my-pi",
    currentModel: "magpie/crosery/mimo-v2.6-pro",
    currentThinking: "xhigh",
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"],
    canSwitchThinking: true,
    canSwitch: true,
    modelRoles: { default: "remote/default-model", slow: "remote/slow-model" },
    models: [
      { id: "magpie/crosery/mimo-v2.6-pro", label: "MiMo V2.6 Pro", reasoning: true, source: "current" },
      { id: "remote/only-model", label: "Remote Only", reasoning: true, source: "catalog" },
    ],
  });
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(lateUpdate);
  assert.equal((lateUpdate as AgentModelsResult).modelRoles?.slow, "remote/slow-model");
  assert.ok((lateUpdate as AgentModelsResult).models.some((m) => m.id === "remote/only-model"));
  assert.ok((lateUpdate as AgentModelsResult).models.some((m) => m.id === "magpie/crosery/gpt-6.2-astra-fast"));
});

test("updateAgentRoleModel forwards roleSlot to agent.setModel RPC", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const res = await updateAgentRoleModel(baseAgent, "plan", "magpie/crosery/claude-opus-5", {
    deps: {
      rpcCall: async (_deviceId, params) => {
        sent.push(params);
        return {
          ok: true,
          modelRoles: { plan: "magpie/crosery/claude-opus-5" },
        };
      },
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.modelRoles?.plan, "magpie/crosery/claude-opus-5");
  assert.deepEqual(sent, [
    {
      agent: baseAgent.key,
      roleSlot: "plan",
      modelId: "magpie/crosery/claude-opus-5",
    },
  ]);
});

test("patchCachedAgentModelMeta dynamically recomputes thinkingLevels, clamps currentThinking, and updates effortModelMap siblings", () => {
  const agyAgent: Agent = {
    ...baseAgent,
    key: "dev-1/hc:agy-1",
    harness: "antigravity",
    model: "gemini-4-neon-high",
  };

  seedModelCatalogCacheForTest(agyAgent, {
    harness: "antigravity",
    currentModel: "gemini-4-neon-high",
    currentThinking: "high",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    canSwitchThinking: true,
    thinkingLabel: "思考等级",
    canSwitch: true,
    models: [
      {
        id: "gemini-4-neon-high",
        label: "Gemini 4 Neon (High)",
        reasoning: true,
        thinkingLevels: ["low", "medium", "high", "xhigh"],
        effortModelMap: {
          low: "gemini-4-neon-low",
          medium: "gemini-4-neon-medium",
          high: "gemini-4-neon-high",
          xhigh: "gemini-4-neon-xhigh",
        },
        source: "current",
      },
      {
        id: "gemini-4-carbon-high",
        label: "Gemini 4 Carbon (High)",
        reasoning: true,
        thinkingLevels: ["low", "medium", "high"],
        source: "catalog",
      },
      {
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        reasoning: true,
        source: "catalog",
      },
      {
        id: "gpt-4o",
        label: "GPT-4o",
        reasoning: false,
        source: "catalog",
      },
    ],
  });

  // Switching to effortModelMap sibling updates both model & effort
  patchCachedAgentModelMeta(agyAgent.key, { currentModel: "gemini-4-neon-xhigh", currentThinking: "xhigh" });
  let snap = getInitialAgentModelsSeed(agyAgent);
  assert.equal(snap.currentModel, "gemini-4-neon-xhigh");
  assert.equal(snap.currentThinking, "xhigh");
  assert.deepEqual(snap.thinkingLevels, ["low", "medium", "high", "xhigh"]);

  // Switching to gemini-4-carbon-high narrows thinkingLevels and clamps xhigh -> high
  patchCachedAgentModelMeta(agyAgent.key, { currentModel: "gemini-4-carbon-high" });
  snap = getInitialAgentModelsSeed(agyAgent);
  assert.equal(snap.currentModel, "gemini-4-carbon-high");
  assert.equal(snap.currentThinking, "high");
  assert.deepEqual(snap.thinkingLevels, ["low", "medium", "high"]);

  // Switching to claude-opus-4-6 (even without pre-populated thinkingLevels on option) resolves family levels
  patchCachedAgentModelMeta(agyAgent.key, { currentModel: "claude-opus-4-6", currentThinking: "max" });
  snap = getInitialAgentModelsSeed(agyAgent);
  assert.deepEqual(snap.thinkingLevels, ["low", "medium", "high", "max"]);
  assert.equal(snap.currentThinking, "max");

  // Switching to non-reasoning gpt-4o clears thinkingLevels & currentThinking
  patchCachedAgentModelMeta(agyAgent.key, { currentModel: "gpt-4o" });
  snap = getInitialAgentModelsSeed(agyAgent);
  assert.equal(snap.thinkingLevels, undefined);
  assert.equal(snap.canSwitchThinking, false);
  assert.equal(snap.currentThinking, undefined);
});

test("fetchAgentModelsWithFallback and computeAutoAgentModelMeta survive legacy host RPC missing .harness", async () => {
  const legacyRpcRes = {
    // Intentionally omit `harness` (older hostd shape)
    currentModel: "claude-opus-4-6",
    currentThinking: "high",
    canSwitch: true,
    canSwitchThinking: true,
    models: [
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", reasoning: true, source: "current" as const },
    ],
  } as unknown as AgentModelsResult;

  const res = await fetchAgentModelsWithFallback(
    { ...baseAgent, key: "legacy-1/hc:t1", harness: "claude-code", model: "claude-opus-4-6" },
    [],
    {
      deps: {
        rpcCall: async () => legacyRpcRes,
        isTauri: () => false,
        getLocalHostId: async () => null,
        invokeLocalAgentModels: async () => {
          throw new Error("unused");
        },
      },
    },
  );

  assert.equal(res.harness, "claude-code");
  assert.deepEqual(res.thinkingLevels, ["low", "medium", "high", "max"]);

  const meta = computeAutoAgentModelMeta(
    { ...baseAgent, key: "legacy-1/hc:t1", harness: "claude-code", model: "claude-opus-4-6" },
    { fetched: legacyRpcRes, hasReasoningEvents: true },
  );
  assert.equal(meta.currentModel, "claude-opus-4-6");
  assert.equal(meta.currentThinking, "high");
  assert.equal(meta.canSwitchThinking, true);
  assert.deepEqual(meta.thinkingLevels, ["low", "medium", "high", "max"]);
});

test("computeAutoAgentModelMeta clears thinkingLevels and hides switching when switching from reasoning model (with hasReasoningEvents) to gemini-1.5-pro", () => {
  const ompAgent: Agent = {
    ...baseAgent,
    key: "dev-mac/hc:t5",
    harness: "oh-my-pi",
    model: "demo/mimo-v2.6-pro",
  };
  const fetched: AgentModelsResult = {
    harness: "oh-my-pi",
    currentModel: "demo/mimo-v2.6-pro",
    currentThinking: "xhigh",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    canSwitch: true,
    canSwitchThinking: true,
    models: [
      {
        id: "demo/mimo-v2.6-pro",
        label: "MiMo V2.6 Pro",
        reasoning: true,
        thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
        source: "current",
      },
      {
        id: "demo/gemini-1.5-pro",
        label: "Gemini 1.5 Pro",
        reasoning: false,
        source: "catalog",
      },
    ],
  };

  const before = computeAutoAgentModelMeta(ompAgent, {
    fetched,
    hasReasoningEvents: true,
  });
  assert.equal(before.canSwitchThinking, true);
  assert.deepEqual(before.thinkingLevels, ["off", "low", "medium", "high", "xhigh"]);

  const after = computeAutoAgentModelMeta(ompAgent, {
    fetched,
    override: { currentModel: "demo/gemini-1.5-pro" },
    hasReasoningEvents: true,
  });
  assert.equal(after.currentModel, "demo/gemini-1.5-pro");
  assert.equal(after.thinkingLevels, undefined);
  assert.equal(after.currentThinking, undefined);
  assert.equal(after.canSwitchThinking, false);
});
