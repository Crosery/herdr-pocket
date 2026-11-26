// Strip the trailing slash too: at "/" a leftover slash would make "//admin-assets/…",
// a protocol-relative URL to a host named "admin-assets".
const BASE = location.pathname.replace(/\/admin\/?$/, "").replace(/\/+$/, "");
const TOKEN_KEY = "herdr-pocket-admin";

export function assetUrl(rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  return `${BASE}/admin-assets/${clean}`;
}

export function getSavedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSavedToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export type DeviceKind = "host" | "viewer";
export type AgentStatus = "working" | "blocked" | "done" | "idle" | "unknown";
export type VoiceProviderId = "moss-live" | "openai-realtime";
export type ModelProtocol = "openai" | "openai-responses" | "anthropic" | "gemini" | "ollama";
export type ModelAuth = "bearer" | "x-api-key" | "api-key" | "x-goog-api-key" | "none";

export const PROTOCOL_LABEL: Record<ModelProtocol, string> = {
  openai: "OpenAI 兼容",
  "openai-responses": "Responses / Codex",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  ollama: "Ollama 本地",
};

export interface AdminPresetItem {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  auth?: ModelAuth;
  recommendedModel?: string;
}

export const ADMIN_PROVIDER_PRESETS: readonly AdminPresetItem[] = [
  { id: "mimo", label: "小米 MiMo", protocol: "openai", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", recommendedModel: "mimo-v2.6-flash" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", recommendedModel: "deepseek-chat" },
  { id: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", recommendedModel: "gpt-4.1-mini" },
  { id: "openai-codex", label: "OpenAI Responses / Codex", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", recommendedModel: "gpt-5-codex" },
  { id: "anthropic", label: "Anthropic Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com", recommendedModel: "claude-sonnet-4-5" },
  { id: "gemini", label: "Google Gemini 原生", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", recommendedModel: "gemini-2.5-flash" },
  { id: "qwen", label: "通义千问", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", recommendedModel: "qwen-plus" },
  { id: "moonshot", label: "Moonshot Kimi", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", recommendedModel: "kimi-k2-0711-preview" },
  { id: "zhipu", label: "智谱 GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", recommendedModel: "glm-4.5-air" },
  { id: "siliconflow", label: "SiliconFlow", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama", label: "Ollama 本地", protocol: "ollama", baseUrl: "http://localhost:11434", auth: "none" },
];

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  platform?: string;
  online: boolean;
  createdAt: number;
  lastSeenAt: number;
  sources?: string[];
  version?: string;
}

export interface AgentRow {
  key: string;
  deviceId: string;
  deviceName?: string;
  source: "hc" | "herdr" | "uniflo";
  localId: string;
  harness: string;
  title?: string;
  name?: string;
  where?: string;
  cwd?: string;
  status: AgentStatus;
  statusSince?: number;
  statusNote?: string;
  errored?: boolean;
  turn?: number;
  isShell: boolean;
  model?: string;
  preview?: string;
  costUsd?: number;
  contextTokens?: number;
  contextLimit?: number;
  subagents?: number;
  subagentsWorking?: number;
  queued?: number;
  queuedText?: string;
  updatedAt: number;
}

export interface JoinRequest {
  id: string;
  name: string;
  kind: DeviceKind;
  platform?: string;
  expiresAt: number;
}

export interface AssistantAction {
  id: string;
  kind: string;
  agentTitle?: string;
  agentName?: string;
  deviceName?: string;
  summary: string;
  state: "pending" | "running" | "done" | "cancelled" | "failed" | "expired";
  result?: string;
  createdAt: number;
}

export interface AdminOverview {
  version: string;
  uiVersion?: string;
  protocol: number;
  startedAt: number;
  devices: number;
  online: number;
  agents: number;
  agentList: AgentRow[];
  joins: JoinRequest[];
  assistant: {
    ready: boolean;
    models: string[];
    endpoint: string;
    confirm: "never" | "always";
    busy: boolean;
  };
  voice: {
    provider: VoiceProviderId | string;
    model?: string;
    voice?: string;
    endpoint?: string;
  } | null;
  last24h: { warn: number; error: number };
  actions: AssistantAction[];
}

export interface KeyView {
  set: boolean;
  hint: string | null;
  from: "server" | "phone" | null;
}

export interface ProviderView {
  id: string;
  label?: string;
  protocol: ModelProtocol;
  baseUrl: string;
  auth?: ModelAuth;
  key: KeyView;
  from: "server" | "phone";
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface VoiceView {
  provider: VoiceProviderId | null;
  url?: string;
  model?: string;
  voice?: string;
  speed?: number;
  key: KeyView;
}

export interface AssistantConfigView {
  rev: number;
  name: string;
  providers: ProviderView[];
  models: ModelRef[];
  voice: VoiceView;
  edited: boolean;
  updatedAt?: number;
  updatedBy?: string;
  warnings: string[];
}

export interface VoiceOption {
  id: string;
  label: string;
  gender?: "female" | "male" | "neutral";
  hint?: string;
  recommended?: boolean;
}

export interface VoiceCatalogResponse {
  provider: VoiceProviderId;
  defaultVoice?: string;
  voices: VoiceOption[];
}

export interface PromptView {
  id: string;
  title: string;
  about: string;
  group: string;
  slots: Array<{ slot: string; means: string }>;
  text: string;
  defaultText: string;
  edited: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

export interface LogEntry {
  id: number;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  source: "relay" | DeviceKind;
  kind: string;
  msg: string;
  device?: string;
  deviceName?: string;
  data?: Record<string, unknown>;
}

export interface ModelTestResult {
  ok: boolean;
  firstMs?: number;
  totalMs?: number;
  reply?: string;
  error?: string;
}

export interface PairCodeResponse {
  code: string;
  expiresAt: number;
  link: string;
  qrSvg?: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function reqJson<T>(path: string, init: RequestInit = {}, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? getSavedToken();
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (!tokenOverride && onUnauthorized) onUnauthorized();
    throw new ApiError("令牌不对，或者已经更换", 401, "unauthorized");
  }
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body?.error?.code);
  }
  return body as T;
}

export const adminApi = {
  overview: (token?: string) => reqJson<AdminOverview>("/v1/admin/overview", {}, token),
  devices: () => reqJson<{ devices: Device[] }>("/v1/devices"),
  revokeDevice: (id: string) => reqJson<{ ok: boolean }>(`/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  mintPairCode: (kind?: DeviceKind) =>
    reqJson<PairCodeResponse>("/v1/pair/codes", { method: "POST", body: JSON.stringify(kind ? { kind } : {}) }),
  approveJoin: (id: string) => reqJson<{ device: Device }>(`/v1/join/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" }),
  denyJoin: (id: string) => reqJson<{ ok: boolean }>(`/v1/join/${encodeURIComponent(id)}/deny`, { method: "POST", body: "{}" }),
  setConfirm: (confirm: "never" | "always") =>
    reqJson<{ confirm: "never" | "always" }>("/v1/assistant/settings", { method: "POST", body: JSON.stringify({ confirm }) }),
  config: () => reqJson<AssistantConfigView>("/v1/assistant/config"),
  saveConfig: (patch: Record<string, unknown>) =>
    reqJson<AssistantConfigView>("/v1/assistant/config", { method: "POST", body: JSON.stringify(patch) }),
  testModel: (provider: string | Record<string, unknown>, model: string) =>
    reqJson<ModelTestResult>("/v1/assistant/config/test", { method: "POST", body: JSON.stringify({ provider, model }) }),
  fetchProviderModels: (provider: string | Record<string, unknown>) =>
    typeof provider === "string"
      ? reqJson<{ models: string[] }>(`/v1/assistant/config/models?provider=${encodeURIComponent(provider)}`)
      : reqJson<{ models: string[] }>("/v1/assistant/config/models", { method: "POST", body: JSON.stringify({ provider }) }),
  voices: (provider: VoiceProviderId) =>
    reqJson<VoiceCatalogResponse>(`/v1/assistant/config/voices?provider=${encodeURIComponent(provider)}`),
  prompts: () => reqJson<{ prompts: PromptView[] }>("/v1/assistant/prompts"),
  savePrompt: (id: string, body: { text: string } | { reset: true }) =>
    reqJson<PromptView>(`/v1/assistant/prompts/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
  logs: (params: URLSearchParams) => reqJson<{ entries: LogEntry[] }>(`/v1/logs?${params.toString()}`),
};

export function greetingNow(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "夜深啦";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  if (h < 22) return "晚上好";
  return "夜深啦";
}

export function fmtAgo(ts?: number): string {
  if (!ts) return "-";
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} 小时前`;
  return `${Math.round(hr / 24)} 天前`;
}

export function fmtTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtUptime(startedAt: number): string {
  const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天`;
}

export function fmtTokens(n?: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
