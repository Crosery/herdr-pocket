import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_BRAND_ICONS, resolveModelBrand, type ModelBrandId } from "../src/index.ts";

test("resolveModelBrand maps AI models and routing prefixes to official brand IDs", () => {
  const cases: Array<[string, { provider?: string; label?: string } | undefined, ModelBrandId | null]> = [
    ["gemini-4-neon-high", undefined, "gemini"],
    ["gemini-3.5-flash", undefined, "gemini"],
    ["google/gemini-2.5-pro", undefined, "gemini"],
    ["openrouter/google/gemini-2.5-pro", { provider: "openrouter" }, "gemini"],
    ["gemma-3-27b-it", undefined, "gemma"],
    ["claude-opus-5-5", undefined, "claude"],
    ["anthropic/claude-sonnet-4-6", { provider: "anthropic" }, "claude"],
    ["@oracle/claude-sonnet-4-6:high", undefined, "claude"],
    ["gpt-5.4", undefined, "openai"],
    ["gpt-6.2-astra", undefined, "openai"],
    ["o3-mini", undefined, "openai"],
    ["o4-mini", undefined, "openai"],
    ["gpt-5.3-codex", undefined, "codex"],
    ["codex-mini-latest", undefined, "codex"],
    ["deepseek-reasoner", undefined, "deepseek"],
    ["deepseek-r1-0528", undefined, "deepseek"],
    ["qwen3-coder-480b", undefined, "qwen"],
    ["qwq-32b", undefined, "qwen"],
    ["kimi-k2.5", undefined, "kimi"],
    ["moonshot-v1-128k", undefined, "moonshot"],
    ["minimax-m2.7", undefined, "minimax"],
    ["glm-5.1", undefined, "zhipu"],
    ["chatglm-4-9b", undefined, "chatglm"],
    ["auto/crosery/mimo-v2.6-pro", undefined, "xiaomimimo"],
    ["mimo-v2.6-fast", undefined, "xiaomimimo"],
    ["doubao-1.6-pro", undefined, "doubao"],
    ["grok-3", undefined, "grok"],
    ["llama-4-maverick", undefined, "meta"],
    ["codestral-latest", undefined, "mistral"],
    ["hunyuan-turbos", undefined, "hunyuan"],
    ["ernie-4.5-turbo", undefined, "baidu"],
    ["step-2-16k", undefined, "stepfun"],
    ["yi-lightning", undefined, "yi"],
    ["baichuan4-turbo", undefined, "baichuan"],
    ["sonar-reasoning-pro", undefined, "perplexity"],
    ["nvidia/llama-3.3-nemotron", undefined, "meta"],
    ["custom-endpoint-model", { provider: "openrouter" }, "openrouter"],
    ["local-finetune", { provider: "ollama" }, "ollama"],
    ["unknown-custom-model", undefined, null],
  ];

  for (const [modelId, opts, expected] of cases) {
    assert.equal(resolveModelBrand(modelId, opts), expected, `modelId=${modelId}`);
  }
});

test("MODEL_BRAND_ICONS specs contain valid geometric elements and resolved gradients", () => {
  const entries = Object.entries(MODEL_BRAND_ICONS);
  assert.ok(entries.length >= 40);
  for (const [id, spec] of entries) {
    assert.equal(spec.id, id);
    assert.equal(spec.viewBox, "0 0 24 24", `${id} viewBox`);
    assert.ok(spec.elements.length > 0, `${id} should have elements`);
    const gradIds = new Set((spec.gradients ?? []).map((g) => g.localId));
    for (const el of spec.elements) {
      if (el.fillGradient) {
        assert.ok(gradIds.has(el.fillGradient), `${id} references missing gradient ${el.fillGradient}`);
      }
      if (el.tag === "path") {
        assert.ok(typeof el.d === "string" && el.d.length > 0, `${id} path missing d`);
      }
    }
  }
});
