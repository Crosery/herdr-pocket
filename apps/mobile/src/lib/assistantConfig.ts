/**
 * The assistant's models, keys, voice and prompts as phones change them: the
 * relay keeps one copy and every phone edits that same copy. Loaded over REST
 * while a screen shows it; an `assistant_config` frame (another phone changed
 * something) refetches what is in view and marks the rest stale.
 *
 * Keys only go out: a key typed here is sent once and never kept, logged or
 * shown again; the relay only says whether one is set and its last characters.
 * In demo mode a local stand-in answers (mockConfig.ts).
 */
import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { create } from "zustand";
import {
  voiceCatalogFor,
  type AssistantConfigChange,
  type AssistantConfigView,
  type KeyView,
  type ModelProtocol,
  type ModelRef,
  type ModelTestResult,
  type PromptId,
  type PromptView,
  type ProviderPatch,
  type ProviderView,
  type ServerFrame,
  type VoiceCatalogResponse,
  type VoiceProviderId,
} from "@herdr-pocket/protocol";
import { useLive, useSettings } from "./store";
import { loadToken } from "./auth";
import { isMockServer } from "./mock";
import { mockConfig } from "./mockConfig";

/** One model's last test: running, or what came back. Kept while the app runs. */
export type ModelTest = { running: true } | (ModelTestResult & { running?: false; at: number });

interface ConfigStore {
  config: AssistantConfigView | null;
  configError: string | null;
  /** Another phone changed it while no screen showed it: load again before showing it. */
  configStale: boolean;
  prompts: PromptView[] | null;
  promptsError: string | null;
  promptsStale: boolean;
  /** By `provider:model`. */
  tests: Record<string, ModelTest>;
  /** A short line for the screen in view: a save went through, or another phone changed something. */
  flash: string | null;
}

const EMPTY: ConfigStore = { config: null, configError: null, configStale: false, prompts: null, promptsError: null, promptsStale: false, tests: {}, flash: null };

export const useAssistantConfig = create<ConfigStore>()(() => ({ ...EMPTY }));

/** What the person sees when their change crossed another phone's. */
export const CONFLICT_TEXT = "另一台手机刚改过，已刷新，再改一次";
const OLD_RELAY = "服务器还不支持在手机上改这些，更新服务器后就能用";

export const PROTOCOL_LABEL: Record<ModelProtocol, string> = {
  openai: "OpenAI 兼容",
  "openai-responses": "Responses / Codex",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  ollama: "Ollama 本地",
};
export const VOICE_LABEL: Record<VoiceProviderId, string> = { "moss-live": "MOSS-Live", "openai-realtime": "OpenAI Realtime 兼容" };

export const modelKey = (m: ModelRef) => `${m.provider}:${m.model}`;
export const providerName = (p: Pick<ProviderView, "id" | "label"> | undefined, id = p?.id ?? "") => p?.label || id;

/** "已设置 ··a1b2 · 服务器上的" / "未设置". */
export function keyLine(k: KeyView): string {
  if (!k.set) return "未设置";
  return `已设置${k.hint ? ` ··${k.hint}` : ""}${k.from === "phone" ? " · App 里设的" : k.from === "server" ? " · 服务器上的" : ""}`;
}

/** "首字 1.8 秒 · 全部 2.4 秒". */
export function speedLine(r: Pick<ModelTestResult, "firstMs" | "totalMs">): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
  const parts = [r.firstMs != null ? `首字 ${sec(r.firstMs)}` : null, r.totalMs != null ? `全部 ${sec(r.totalMs)}` : null].filter(Boolean);
  return parts.join(" · ");
}

/** "1,234 字": how long a prompt is. */
export const chars = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} 字`;

/** A refused request, with the relay's message and its HTTP status (0: never reached it). */
export class ConfigRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hasChinese = (s: string) => /[㐀-鿿]/.test(s);

/** The relay's own words when it gave some; a plain sentence for the ones it leaves in English. */
function plainMessage(status: number, message: string | undefined): string {
  if (message && hasChinese(message)) return message;
  if (status === 404) return OLD_RELAY;
  if (status === 409) return CONFLICT_TEXT;
  if (status === 401) return "这台手机的授权失效了，重新配对后再试";
  if (status === 403) return "这台手机不能改这个";
  if (status === 413) return "内容太长了，删掉一些再存";
  if (status >= 500) return `服务器出错了（${status}），过一会儿再试`;
  return `服务器没接受这个改动（${status}）`;
}

async function request<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const server = useSettings.getState().server;
  if (!server) throw new ConfigRequestError("还没连上服务器", 0);
  const token = await loadToken();
  const timeoutMs = init.timeoutMs ?? 15_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${server}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      signal: abort.signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ConfigRequestError(abort.signal.aborted ? `等了 ${Math.round(timeoutMs / 1000)} 秒，服务器没有回话` : "连不上服务器，检查一下网络", 0);
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
  if (!res.ok) throw new ConfigRequestError(plainMessage(res.status, body.error?.message), res.status, body.error?.code);
  return body;
}

/** Turns what the demo throws (an Error with a status) into the same error the relay gives. */
function asRequestError(e: unknown): ConfigRequestError {
  if (e instanceof ConfigRequestError) return e;
  const x = e as { message?: string; status?: number; code?: string };
  return new ConfigRequestError(x.message ?? "出错了", x.status ?? 0, x.code);
}

const isConflict = (e: ConfigRequestError) => e.status === 409 || e.code === "conflict";
const demo = () => isMockServer(useSettings.getState().server);

/** Bumped when the server changes, so an answer from the old one is dropped. */
let generation = 0;

useSettings.subscribe((s, prev) => {
  if (s.server === prev.server) return;
  generation++;
  useAssistantConfig.setState({ ...EMPTY });
  if (isMockServer(s.server)) mockConfig.restart();
});

// ---- Config ----

export async function loadConfig(): Promise<void> {
  if (!useSettings.getState().server) return;
  const gen = generation;
  try {
    const config = demo() ? await mockConfig.view() : await request<AssistantConfigView>("/v1/assistant/config");
    if (gen === generation) useAssistantConfig.setState({ config, configError: null, configStale: false });
  } catch (e) {
    if (gen === generation) useAssistantConfig.setState({ configError: asRequestError(e).message, configStale: false });
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Sends one change with the `rev` this phone last saw. Changes go one after
 * another, so quick taps never race each other into a conflict. When another
 * phone got there first, the new settings are loaded and CONFLICT_TEXT thrown.
 */
export function changeConfig(change: Omit<AssistantConfigChange, "rev">): Promise<AssistantConfigView> {
  const run = queue.catch(() => undefined).then(() => sendChange(change));
  queue = run;
  return run;
}

async function sendChange(change: Omit<AssistantConfigChange, "rev">): Promise<AssistantConfigView> {
  if (!useAssistantConfig.getState().config) await loadConfig();
  const s = useAssistantConfig.getState();
  if (!s.config) throw new ConfigRequestError(s.configError ?? "还没读到小羊的设置", 0);
  const body: AssistantConfigChange = { ...change, rev: s.config.rev };
  const gen = generation;
  try {
    const config = demo() ? await mockConfig.change(body) : await request<AssistantConfigView>("/v1/assistant/config", { body });
    if (gen === generation) useAssistantConfig.setState({ config, configError: null, configStale: false });
    return config;
  } catch (e) {
    const err = asRequestError(e);
    if (isConflict(err)) {
      await loadConfig();
      throw new ConfigRequestError(CONFLICT_TEXT, 409, "conflict");
    }
    throw err;
  }
}

/** Tests a saved model and keeps the result for the list. */
export async function testModel(m: ModelRef): Promise<ModelTestResult> {
  const key = modelKey(m);
  const gen = generation;
  useAssistantConfig.setState((s) => ({ tests: { ...s.tests, [key]: { running: true } } }));
  const r = await runTest({ provider: m.provider, model: m.model });
  if (gen === generation) useAssistantConfig.setState((s) => ({ tests: { ...s.tests, [key]: { ...r, running: false, at: Date.now() } } }));
  return r;
}

/** Tests a provider as it would be saved (its key, if not typed, stays the current one). Nothing is kept. */
export function testDraft(provider: ProviderPatch, model: string): Promise<ModelTestResult> {
  return runTest({ provider, model });
}

async function runTest(body: { provider: string | ProviderPatch; model: string }): Promise<ModelTestResult> {
  try {
    // A slow model can take a while to say anything; the relay gives up on its own too.
    return demo() ? await mockConfig.test(body) : await request<ModelTestResult>("/v1/assistant/config/test", { body, timeoutMs: 60_000 });
  } catch (e) {
    return { ok: false, error: asRequestError(e).message };
  }
}

/** The model names a provider lists (saved provider id or unsaved draft ProviderPatch); empty when it lists none. */
export async function listProviderModels(provider: string | ProviderPatch): Promise<string[]> {
  try {
    if (demo()) return await mockConfig.models(provider);
    const r =
      typeof provider === "string"
        ? await request<{ models?: string[] }>(`/v1/assistant/config/models?provider=${encodeURIComponent(provider)}`, { timeoutMs: 20_000 })
        : await request<{ models?: string[] }>("/v1/assistant/config/models", { body: { provider }, timeoutMs: 20_000 });
    return Array.isArray(r.models) ? r.models : [];
  } catch (e) {
    throw asRequestError(e);
  }
}

/** Curated voices offered for a voice service; falls back to the built-in catalog on older relays. */
export async function loadVoices(provider: VoiceProviderId): Promise<VoiceCatalogResponse> {
  try {
    if (demo()) return await mockConfig.voices(provider);
    return await request<VoiceCatalogResponse>(`/v1/assistant/config/voices?provider=${encodeURIComponent(provider)}`, { timeoutMs: 8_000 });
  } catch {
    return voiceCatalogFor(provider);
  }
}

// ---- Prompts ----

export async function loadPrompts(): Promise<void> {
  if (!useSettings.getState().server) return;
  const gen = generation;
  try {
    const prompts = demo() ? await mockConfig.prompts() : (await request<{ prompts: PromptView[] }>("/v1/assistant/prompts")).prompts;
    if (gen === generation) useAssistantConfig.setState({ prompts, promptsError: null, promptsStale: false });
  } catch (e) {
    if (gen === generation) useAssistantConfig.setState({ promptsError: asRequestError(e).message, promptsStale: false });
  }
}

function putPrompt(v: PromptView) {
  useAssistantConfig.setState((s) => ({ prompts: s.prompts ? s.prompts.map((x) => (x.id === v.id ? v : x)) : [v] }));
}

export async function savePrompt(id: PromptId, text: string): Promise<PromptView> {
  try {
    const v = demo() ? await mockConfig.savePrompt(id, text) : await request<PromptView>(`/v1/assistant/prompts/${encodeURIComponent(id)}`, { body: { text } });
    putPrompt(v);
    return v;
  } catch (e) {
    throw asRequestError(e);
  }
}

export async function resetPrompt(id: PromptId): Promise<PromptView> {
  try {
    const v = demo() ? await mockConfig.savePrompt(id, null) : await request<PromptView>(`/v1/assistant/prompts/${encodeURIComponent(id)}`, { body: { reset: true } });
    putPrompt(v);
    return v;
  } catch (e) {
    throw asRequestError(e);
  }
}

// ---- Live updates ----

export function flash(message: string | null): void {
  useAssistantConfig.setState({ flash: message });
}

/** How many screens showing each part are in view. */
const watching = { config: 0, prompts: 0 };

/** Who made a change, as a person reads it; null when it was this phone. */
function changedBy(by: string | undefined): string | null {
  const live = useLive.getState();
  if (by && (by === live.self?.id || by === live.self?.name)) return null;
  const d = by ? live.devices[by] : undefined;
  if (d) return `「${d.name}」`;
  // Device ids are 12 hex characters: not a name to show.
  return by && !/^[0-9a-f]{12}$/i.test(by) ? `「${by}」` : "另一台手机";
}

/** `assistant_config` frame: another phone changed the configuration or a prompt. */
export function onAssistantConfigFrame(f: Extract<ServerFrame, { type: "assistant_config" }>): void {
  const who = changedBy(f.by);
  if (f.what === "config") {
    const have = useAssistantConfig.getState().config;
    // Already have it (this phone's own change comes back with the rev it already holds).
    if (have && f.rev <= have.rev) return;
    if (watching.config > 0) void loadConfig().then(() => who && flash(`${who}刚改了小羊的设置，这里已经更新`));
    else useAssistantConfig.setState({ configStale: true });
    return;
  }
  if (watching.prompts > 0) void loadPrompts().then(() => who && flash(`${who}刚改了提示词，这里已经更新`));
  else useAssistantConfig.setState({ promptsStale: true });
}

/** The socket came back: anything may have changed while it was down. */
export function onLinkBack(): void {
  const s = useAssistantConfig.getState();
  if (s.config) {
    if (watching.config > 0) void loadConfig();
    else useAssistantConfig.setState({ configStale: true });
  }
  if (s.prompts) {
    if (watching.prompts > 0) void loadPrompts();
    else useAssistantConfig.setState({ promptsStale: true });
  }
}

/** While the screen is in view: load what it shows if needed, and follow other phones' changes. */
export function useConfigWatch(kind: "config" | "prompts"): void {
  useFocusEffect(
    useCallback(() => {
      watching[kind]++;
      const s = useAssistantConfig.getState();
      const missing = kind === "config" ? !s.config || s.configStale || !!s.configError : !s.prompts || s.promptsStale || !!s.promptsError;
      if (missing) void (kind === "config" ? loadConfig() : loadPrompts());
      return () => {
        watching[kind]--;
      };
    }, [kind]),
  );
}
