import type { ModelProtocol, ModelRef, ModelTestResult, ProviderPatch, ProviderView } from "@herdr-pocket/protocol";
import { testAssistantModel } from "../../lib/assistant";
import { isMockServer, mockApi } from "../../lib/mock";
import { createStore, settingsStore } from "../../lib/store";

// Shared by the model and provider sections of Settings > 小羊助理. Wording follows the
// mobile app (apps/mobile/src/lib/assistantConfig.ts) so both clients read the same.

export const PROTOCOL_LABEL: Record<ModelProtocol, string> = {
  openai: "OpenAI 兼容",
  "openai-responses": "Responses / Codex",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  ollama: "Ollama 本地",
};

export const URL_HINTS: Record<ModelProtocol, string> = {
  openai: "https://api.example.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

export const MAX_MODELS = 12;

export const modelKey = (m: ModelRef) => `${m.provider}:${m.model}`;
export const providerName = (p: Pick<ProviderView, "id" | "label"> | undefined, id = p?.id ?? "") => p?.label || id;

/** "首字 0.8 秒 · 全部 1.5 秒". */
export function speedLine(r: Pick<ModelTestResult, "firstMs" | "totalMs">): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
  const parts = [r.firstMs != null ? `首字 ${sec(r.firstMs)}` : null, r.totalMs != null ? `全部 ${sec(r.totalMs)}` : null].filter(Boolean);
  return parts.join(" · ");
}

/** Whether a provider can answer as far as its key goes, and the chip text for it. */
export function keyState(p: ProviderView): { ok: boolean; text: string } {
  const free = p.auth === "none" || p.protocol === "ollama";
  if (p.key.set) return { ok: true, text: `密钥 ··${p.key.hint ?? ""}` };
  if (free) return { ok: true, text: "不用密钥" };
  return { ok: false, text: "缺密钥" };
}

export type ModelTest = { running: true } | (ModelTestResult & { running?: false; at: number });
export const answered = (t: ModelTest | undefined): t is ModelTestResult & { running?: false; at: number } => !!t && !t.running;

/** Last speed test per model, for the server it ran against. */
export const modelTestStore = createStore<{ server: string | null; tests: Record<string, ModelTest> }>({ server: null, tests: {} });

function testsFor(server: string | null): Record<string, ModelTest> {
  const s = modelTestStore.get();
  return s.server === server ? s.tests : {};
}

export function useModelTests(): Record<string, ModelTest> {
  const server = settingsStore.use((s) => s.server);
  return modelTestStore.use((s) => (s.server === server ? s.tests : EMPTY));
}
const EMPTY: Record<string, ModelTest> = {};

async function runTest(body: { provider: string | ProviderPatch; model: string }): Promise<ModelTestResult> {
  const server = settingsStore.get().server;
  try {
    // Demo mode answers here so a demo can show slow, fast and failing models.
    if (isMockServer(server)) return await mockApi.testModel(body);
    return await testAssistantModel(body);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Tests a model in the list; the result shows on its row until the next test. */
export async function testModel(m: ModelRef): Promise<ModelTestResult> {
  const server = settingsStore.get().server;
  const key = modelKey(m);
  modelTestStore.set({ server, tests: { ...testsFor(server), [key]: { running: true } } });
  const r = await runTest({ provider: m.provider, model: m.model });
  if (settingsStore.get().server === server) {
    modelTestStore.set({ server, tests: { ...testsFor(server), [key]: { ...r, running: false, at: Date.now() } } });
  }
  return r;
}

/** Tests a provider as it would be saved; nothing is kept. */
export function testDraft(provider: ProviderPatch, model: string): Promise<ModelTestResult> {
  return runTest({ provider, model });
}
