import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Agent, AgentModelsResult } from "@herdr-pocket/protocol";
import {
  collectPeerModels,
  fetchAgentModelsWithFallback,
  invalidateModelCatalogCache,
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
