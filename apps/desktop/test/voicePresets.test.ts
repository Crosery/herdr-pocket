import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SOTA_ASR_RECOMMENDATIONS,
  SOTA_TEXT_PRESETS,
  SOTA_VOICE_PRESETS,
  matchVoicePresetId,
} from "../src/lib/voicePresets.ts";

test("SOTA_VOICE_PRESETS covers flagship OpenAI, Chinese vendors, Gemini, MOSS-Live, Apple Silicon MLX, and custom", () => {
  const ids = SOTA_VOICE_PRESETS.map((p) => p.id);
  assert.ok(ids.includes("openai-gpt-realtime"));
  assert.ok(ids.includes("openai-gpt-4o-realtime"));
  assert.ok(ids.includes("openai-gpt-4o-mini-realtime"));
  assert.ok(ids.includes("qwen3-omni-flash-realtime"));
  assert.ok(ids.includes("stepfun-step-audio-2"));
  assert.ok(ids.includes("zhipu-glm-realtime"));
  assert.ok(ids.includes("gemini-2-5-flash-native-audio"));
  assert.ok(ids.includes("moss-live-1-0"));
  assert.ok(ids.includes("mlx-local-realtime"));
  assert.ok(ids.includes("custom"));

  assert.equal(
    matchVoicePresetId("openai-realtime", "wss://api.openai.com/v1/realtime", "gpt-realtime"),
    "openai-gpt-realtime",
  );
  assert.equal(
    matchVoicePresetId("openai-realtime", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime/", "qwen3-omni-flash-realtime"),
    "qwen3-omni-flash-realtime",
  );
  assert.equal(
    matchVoicePresetId("moss-live", "wss://api.mosi.cn/v1/realtime", "moss-live-1.0"),
    "moss-live-1-0",
  );
  assert.equal(
    matchVoicePresetId("openai-realtime", "ws://127.0.0.1:8000/v1/realtime", "mlx-omni-realtime"),
    "mlx-local-realtime",
  );
  assert.equal(
    matchVoicePresetId("openai-realtime", "wss://custom.example.com/v1/realtime", "my-custom-voice"),
    "custom",
  );
  assert.equal(matchVoicePresetId("off", "", ""), "custom");
});

test("SOTA_ASR_RECOMMENDATIONS and SOTA_TEXT_PRESETS match desktop & relay SOTA catalog", () => {
  const asrModels = SOTA_ASR_RECOMMENDATIONS.map((r) => r.model);
  assert.deepEqual(asrModels, [
    "gpt-4o-transcribe",
    "whisper-large-v3-turbo",
    "qwen3-asr-flash",
    "FunAudioLLM/SenseVoiceSmall",
  ]);

  const textIds = SOTA_TEXT_PRESETS.map((p) => p.id);
  assert.deepEqual(textIds, ["stepfun", "groq", "xai", "lmstudio", "mlx"]);
  assert.equal(SOTA_TEXT_PRESETS.find((p) => p.id === "lmstudio")?.auth, "none");
  assert.equal(SOTA_TEXT_PRESETS.find((p) => p.id === "mlx")?.auth, "none");
});
