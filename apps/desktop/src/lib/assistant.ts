import type {
  AssistantConfigChange,
  AssistantConfigView,
  AssistantItem,
  AssistantSettings,
  AssistantState,
  ModelTestResult,
  PromptId,
  PromptView,
  ProviderPatch,
  Reminder,
  ServerFrame,
  VoiceCatalogResponse,
} from "@herdr-pocket/protocol";
import { createStore, settingsStore } from "./store";
import { getActiveToken, restRequest } from "./relay";
import { isMockServer, mockApi } from "./mock";

export interface AssistantStoreState {
  items: AssistantItem[];
  busy: boolean;
  busyLabel: string | null;
  ready: boolean;
  voice: boolean;
  model: string | null;
  reminders: Reminder[];
  settings: AssistantSettings;
  loaded: boolean;
  error: string | null;
  unread: number;
}

export const assistantStore = createStore<AssistantStoreState>({
  items: [],
  busy: false,
  busyLabel: null,
  ready: false,
  voice: false,
  model: null,
  reminders: [],
  settings: { confirm: "never" },
  loaded: false,
  error: null,
  unread: 0,
});

export interface AssistantConfigState {
  config: AssistantConfigView | null;
  prompts: PromptView[];
  loaded: boolean;
  loading: boolean;
}

export const assistantConfigStore = createStore<AssistantConfigState>({
  config: null,
  prompts: [],
  loaded: false,
  loading: false,
});

let watching = false;

export function setAssistantWatching(on: boolean): void {
  watching = on;
  if (on && assistantStore.get().unread) {
    assistantStore.set({ unread: 0 });
  }
}

function byTime(items: AssistantItem[]): AssistantItem[] {
  return items.slice().sort((a, b) => a.ts - b.ts);
}

export function applyAssistantState(s: AssistantState): void {
  assistantStore.set({
    items: byTime(s.items),
    busy: s.busy,
    ready: s.ready,
    voice: s.voice,
    model: s.model ?? null,
    reminders: s.reminders,
    settings: s.settings ?? { confirm: "never" },
    loaded: true,
    error: null,
  });
}

export function upsertAssistantItem(item: AssistantItem): void {
  assistantStore.set((prev) => {
    const i = prev.items.findIndex((x) => x.id === item.id);
    if (i >= 0) {
      const next = prev.items.slice();
      const moved = next[i]!.ts !== item.ts;
      next[i] = item;
      return { ...prev, items: moved ? byTime(next) : next };
    }
    const items = [...prev.items, item].sort((a, b) => a.ts - b.ts).slice(-200);
    return {
      ...prev,
      items,
      unread: item.role === "notice" && !watching ? prev.unread + 1 : prev.unread,
    };
  });
}

async function assistantApi<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const server = settingsStore.get().server;
  if (!server) throw new Error("还没连上服务器");
  const token = getActiveToken() ?? undefined;
  return restRequest<T>(server, path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    token,
    timeoutMs: init.timeoutMs ?? 15_000,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export function onAssistantFrame(f: ServerFrame): boolean {
  switch (f.type) {
    case "assistant_item":
      upsertAssistantItem(f.item);
      return true;
    case "assistant_busy":
      assistantStore.set({ busy: f.busy, busyLabel: f.label ?? null });
      return true;
    case "assistant_reset":
      void loadAssistant();
      return true;
    case "assistant_config":
      void loadAssistantConfig();
      return true;
    default:
      return false;
  }
}

export async function loadAssistant(): Promise<void> {
  const server = settingsStore.get().server;
  if (!server) return;
  if (isMockServer(server)) {
    applyAssistantState(mockApi.assistantState());
    return;
  }
  try {
    applyAssistantState(await assistantApi<AssistantState>("/v1/assistant"));
  } catch (e) {
    assistantStore.set({ loaded: true, error: (e as Error).message });
  }
}

export async function sendToAssistant(text: string): Promise<void> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    upsertAssistantItem(mockApi.say(text));
    applyAssistantState(mockApi.assistantState());
    return;
  }
  const r = await assistantApi<{ item: AssistantItem }>("/v1/assistant/messages", { body: { text } });
  upsertAssistantItem(r.item);
}

export async function decideAssistantAction(id: string, decision: "confirm" | "cancel"): Promise<void> {
  const r = await assistantApi<{ item: AssistantItem }>(`/v1/assistant/actions/${encodeURIComponent(id)}`, {
    body: { decision },
  });
  upsertAssistantItem(r.item);
}

export async function clearAssistantThread(): Promise<void> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    mockApi.clearAssistant();
    assistantStore.set({ items: [] });
    return;
  }
  await assistantApi("/v1/assistant/thread", { method: "DELETE" });
  assistantStore.set({ items: [] });
}

export async function deleteAssistantReminder(id: string): Promise<void> {
  await assistantApi(`/v1/assistant/reminders/${encodeURIComponent(id)}`, { method: "DELETE" });
  assistantStore.set((prev) => ({ ...prev, reminders: prev.reminders.filter((r) => r.id !== id) }));
}

export async function loadAssistantConfig(): Promise<void> {
  const server = settingsStore.get().server;
  if (!server) return;
  assistantConfigStore.set({ loading: true });
  try {
    if (isMockServer(server)) {
      assistantConfigStore.set({
        config: mockApi.configView(),
        prompts: mockApi.prompts(),
        loaded: true,
        loading: false,
      });
      return;
    }
    const [config, promptsRes] = await Promise.all([
      assistantApi<AssistantConfigView>("/v1/assistant/config"),
      assistantApi<{ prompts: PromptView[] }>("/v1/assistant/prompts").catch(() => ({ prompts: [] })),
    ]);
    assistantConfigStore.set({
      config,
      prompts: promptsRes.prompts,
      loaded: true,
      loading: false,
    });
  } catch {
    assistantConfigStore.set({ loading: false });
  }
}

export async function saveAssistantConfig(patch: AssistantConfigChange): Promise<AssistantConfigView> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    const view = mockApi.saveConfig(patch);
    assistantConfigStore.set({ config: view });
    return view;
  }
  const view = await assistantApi<AssistantConfigView>("/v1/assistant/config", { body: patch });
  assistantConfigStore.set({ config: view });
  return view;
}

export async function testAssistantModel(body: Record<string, unknown>): Promise<ModelTestResult> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    return { ok: true, firstMs: 180, totalMs: 420, reply: "（演示模式）测试响应正常。" };
  }
  return assistantApi<ModelTestResult>("/v1/assistant/config/test", { body, timeoutMs: 25_000 });
}

export async function fetchAssistantProviderModels(provider: string | ProviderPatch): Promise<string[]> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    return mockApi.listModels(provider);
  }
  const r =
    typeof provider === "string"
      ? await assistantApi<{ models?: string[] }>(`/v1/assistant/config/models?provider=${encodeURIComponent(provider)}`)
      : await assistantApi<{ models?: string[] }>("/v1/assistant/config/models", { body: { provider }, timeoutMs: 20_000 });
  return Array.isArray(r.models) ? r.models : [];
}

export async function fetchVoiceCatalog(providerId: string): Promise<VoiceCatalogResponse> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    return mockApi.voiceCatalog();
  }
  return assistantApi<VoiceCatalogResponse>(`/v1/assistant/config/voices?provider=${encodeURIComponent(providerId)}`);
}

export async function saveAssistantPrompt(id: PromptId, body: { text?: string; reset?: boolean }): Promise<PromptView> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    const updated = mockApi.savePrompt(id, body);
    assistantConfigStore.set((prev) => ({
      ...prev,
      prompts: prev.prompts.map((p) => (p.id === id ? updated : p)),
    }));
    return updated;
  }
  const updated = await assistantApi<PromptView>(`/v1/assistant/prompts/${encodeURIComponent(id)}`, { body });
  assistantConfigStore.set((prev) => ({
    ...prev,
    prompts: prev.prompts.map((p) => (p.id === id ? updated : p)),
  }));
  return updated;
}

export async function loadAssistantSettings(): Promise<AssistantSettings> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    const cur = mockApi.assistantSettings();
    assistantStore.set({ settings: cur });
    return cur;
  }
  const s = await assistantApi<AssistantSettings>("/v1/assistant/settings");
  assistantStore.set({ settings: s });
  return s;
}

export async function updateAssistantSettings(patch: Partial<AssistantSettings>): Promise<AssistantSettings> {
  const server = settingsStore.get().server;
  if (server && isMockServer(server)) {
    const next = mockApi.saveAssistantSettings(patch);
    assistantStore.set({ settings: next });
    return next;
  }
  const next = await assistantApi<AssistantSettings>("/v1/assistant/settings", { body: patch });
  assistantStore.set({ settings: next });
  return next;
}
