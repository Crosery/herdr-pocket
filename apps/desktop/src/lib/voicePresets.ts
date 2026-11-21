import type { ProviderPresetItem, VoiceProviderId } from "@herdr-pocket/protocol";

export interface SotaVoicePreset {
  id: string;
  label: string;
  vendor: string;
  badge?: string;
  provider: VoiceProviderId;
  url: string;
  model: string;
  defaultVoice?: string;
  local?: boolean;
  hint: string;
}

export const SOTA_VOICE_PRESETS: readonly SotaVoicePreset[] = [
  {
    id: "openai-gpt-realtime",
    label: "OpenAI · gpt-realtime（旗舰实时语音）",
    vendor: "OpenAI",
    badge: "SOTA",
    provider: "openai-realtime",
    url: "wss://api.openai.com/v1/realtime",
    model: "gpt-realtime",
    defaultVoice: "marin",
    hint: "OpenAI 官方最新旗舰实时双工语音模型，默认搭配 marin 自然女声。",
  },
  {
    id: "openai-gpt-4o-realtime",
    label: "OpenAI · gpt-4o-realtime-preview",
    vendor: "OpenAI",
    provider: "openai-realtime",
    url: "wss://api.openai.com/v1/realtime",
    model: "gpt-4o-realtime-preview",
    defaultVoice: "marin",
    hint: "OpenAI 经典 4o 实时语音模型，兼容多数 OpenAI Realtime 中转网关。",
  },
  {
    id: "openai-gpt-4o-mini-realtime",
    label: "OpenAI · gpt-4o-mini-realtime-preview（高性价比）",
    vendor: "OpenAI",
    badge: "轻量",
    provider: "openai-realtime",
    url: "wss://api.openai.com/v1/realtime",
    model: "gpt-4o-mini-realtime-preview",
    defaultVoice: "marin",
    hint: "更低延迟与成本的实时双工语音模型，适合日常高频通话。",
  },
  {
    id: "qwen3-omni-flash-realtime",
    label: "阿里千问 · qwen3-omni-flash-realtime",
    vendor: "Alibaba DashScope",
    badge: "多模态",
    provider: "openai-realtime",
    url: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    model: "qwen3-omni-flash-realtime",
    hint: "阿里云百炼 Qwen3-Omni 实时全模态语音模型，中文与中英混说理解出色。",
  },
  {
    id: "stepfun-step-audio-2",
    label: "阶跃星辰 · step-audio-2",
    vendor: "StepFun",
    badge: "中文自然",
    provider: "openai-realtime",
    url: "wss://api.stepfun.com/v1/realtime",
    model: "step-audio-2",
    hint: "StepFun 端到端语音大模型，支持 OpenAI Realtime 兼容握手与自然中文韵律。",
  },
  {
    id: "zhipu-glm-realtime",
    label: "智谱 · glm-realtime",
    vendor: "Zhipu BigModel",
    provider: "openai-realtime",
    url: "wss://open.bigmodel.cn/api/paas/v4/realtime",
    model: "glm-realtime",
    hint: "智谱 BigModel 实时音视频互动模型，适配 OpenAI Realtime 兼容通道。",
  },
  {
    id: "gemini-2-5-flash-native-audio",
    label: "Google · Gemini 2.5 Flash Native Audio",
    vendor: "Google Gemini",
    badge: "原生音频",
    provider: "openai-realtime",
    url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    hint: "Gemini Live 原生音频流式模型（若经 OpenAI Realtime 兼容网关转发可替换为网关地址）。",
  },
  {
    id: "moss-live-1-0",
    label: "MOSS-Live · moss-live-1.0",
    vendor: "MOSI",
    provider: "moss-live",
    url: "wss://api.mosi.cn/v1/realtime",
    model: "moss-live-1.0",
    hint: "MOSS-Live 原生双工实时语音协议，响应灵敏且中文口语自然。",
  },
  {
    id: "mlx-local-realtime",
    label: "Apple Silicon 本地 · MLX-Audio / Faster-Whisper (mlx-omni-realtime)",
    vendor: "Local Apple Silicon",
    badge: "本地离线",
    provider: "openai-realtime",
    url: "ws://127.0.0.1:8000/v1/realtime",
    model: "mlx-omni-realtime",
    local: true,
    hint: "连接本机 Apple Silicon MLX-Audio / Faster-Whisper OpenAI Realtime 兼容网关，免云端传输。",
  },
  {
    id: "custom",
    label: "自定义实时语音服务…",
    vendor: "Custom",
    provider: "openai-realtime",
    url: "",
    model: "",
    hint: "手动填写任意 OpenAI Realtime 兼容或 MOSS-Live WebSocket 地址与模型名。",
  },
] as const;

export function matchVoicePresetId(
  provider: VoiceProviderId | "off",
  url: string,
  model: string,
): string {
  if (provider === "off") return "custom";
  const normUrl = url.trim().replace(/\/+$/, "").toLowerCase();
  const normModel = model.trim().toLowerCase();
  for (const preset of SOTA_VOICE_PRESETS) {
    if (preset.id === "custom" || preset.provider !== provider) continue;
    const pUrl = preset.url.toLowerCase();
    const pModel = preset.model.toLowerCase();
    if (normModel && normModel === pModel && (!normUrl || normUrl === pUrl)) {
      return preset.id;
    }
  }
  for (const preset of SOTA_VOICE_PRESETS) {
    if (preset.id === "custom" || preset.provider !== provider) continue;
    if (normUrl && normUrl === preset.url.toLowerCase() && (!normModel || normModel === preset.model.toLowerCase())) {
      return preset.id;
    }
  }
  return "custom";
}

export interface SotaAsrRecommendation {
  id: string;
  model: string;
  vendor: string;
  badge: string;
  note: string;
  localCapable?: boolean;
}

export const SOTA_ASR_RECOMMENDATIONS: readonly SotaAsrRecommendation[] = [
  {
    id: "gpt-4o-transcribe",
    model: "gpt-4o-transcribe",
    vendor: "OpenAI",
    badge: "旗舰高精度",
    note: "多语种、代码术语与长句听写准确率领先，适合技术口述。",
  },
  {
    id: "whisper-large-v3-turbo",
    model: "whisper-large-v3-turbo",
    vendor: "Groq / Faster-Whisper",
    badge: "极速 / 本地",
    note: "云端 Groq 秒级响应，或桌面端配合本地 Faster-Whisper / MLX 离线部署。",
    localCapable: true,
  },
  {
    id: "qwen3-asr-flash",
    model: "qwen3-asr-flash",
    vendor: "阿里千问",
    badge: "中英混说",
    note: "针对中英夹杂、开发词汇与口音强优化，识别稳健。",
  },
  {
    id: "sensevoice-small",
    model: "FunAudioLLM/SenseVoiceSmall",
    vendor: "SiliconFlow / 本地",
    badge: "超低延迟",
    note: "高吞吐轻量中文语音识别模型，中转内置默认兼容支持。",
    localCapable: true,
  },
] as const;

/** Extra SOTA cloud & local desktop gateways synchronized with relay `TEXT_PRESETS`. */
export const SOTA_TEXT_PRESETS: readonly ProviderPresetItem[] = [
  { id: "stepfun", label: "StepFun 阶跃星辰", protocol: "openai", baseUrl: "https://api.stepfun.com/v1", recommendedModel: "step-2-mini" },
  { id: "groq", label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", recommendedModel: "llama-3.3-70b-versatile" },
  { id: "xai", label: "xAI", protocol: "openai", baseUrl: "https://api.x.ai/v1", recommendedModel: "grok-3-fast" },
  { id: "lmstudio", label: "LM Studio 本地", protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1", auth: "none" },
  { id: "mlx", label: "Apple Silicon MLX 本地", protocol: "openai", baseUrl: "http://127.0.0.1:8080/v1", auth: "none" },
] as const;

export type VoiceAiTier = "auto" | "denoise" | "sv" | "tse";

export const VOICEPRINT_SENSITIVITY_OPTIONS = [
  { value: 0.33, label: "宽松", hint: "环境较吵或说话轻时用，不容易漏掉你的话" },
  { value: 0.38, label: "标准", hint: "日常推荐，漏人和误拦都少" },
  { value: 0.45, label: "严格", hint: "身边有声音很像的人时用，核对更严格" },
] as const;

export const VOICEPRINT_SAMPLE_LINES = [
  "小羊，帮我看看哪几个任务跑完了，有卡住的再叫我。",
  "今天先这样，等这个构建过了就发个新版本吧。",
] as const;
