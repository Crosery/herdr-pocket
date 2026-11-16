/**
 * Demo stand-in for the relay's assistant configuration (`mock://demo`):
 * providers, models, voice and prompts, changed in memory only. Like the relay
 * it never keeps a key: a key sent here only leaves its last characters behind.
 * Rules follow apps/relay/src/assistant/configstore.ts (rev, server providers
 * can't be removed, reset drops every phone change, at least one model).
 */
import type {
  AssistantConfigChange,
  AssistantConfigView,
  KeyView,
  ModelProtocol,
  ModelAuth,
  ModelRef,
  ModelTestResult,
  PromptId,
  PromptView,
  ProviderPatch,
  ProviderView,
  VoicePatch,
  VoiceProviderId,
  VoiceView,
} from "@herdr-pocket/protocol";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Errors carry an HTTP status like the relay's (409: someone changed it first). */
function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

/** What is left of a key: whether there is one and its last characters (the relay gives no hint for short keys). */
type Kept = { hint: string | null } | null;
const keep = (key: string): Kept => ({ hint: key.length > 8 ? key.slice(-4) : null });

interface DemoProvider {
  label?: string;
  protocol?: ModelProtocol;
  baseUrl?: string;
  auth?: ModelAuth;
  key?: Kept;
}

interface DemoVoice {
  provider?: VoiceProviderId | null;
  url?: string;
  model?: string;
  voice?: string;
  speed?: number;
  key?: Kept;
}

interface DemoSaved {
  rev: number;
  providers: Record<string, DemoProvider>;
  models?: ModelRef[];
  voice?: DemoVoice;
  updatedAt?: number;
  updatedBy?: string;
}

/** What "the server's own settings" are in the demo. */
const SERVER = {
  providers: { custom: { label: "自建网关", protocol: "openai" as ModelProtocol, baseUrl: "https://llm.example.com/v1", key: { hint: "a1b2" } } },
  models: [
    { provider: "custom", model: "gpt-6.1-terra" },
    { provider: "custom", model: "claude-sonnet-5-5" },
    { provider: "custom", model: "gpt-6.1-sol" },
  ] as ModelRef[],
  voice: { provider: "moss-live" as VoiceProviderId, url: "wss://voice.example.com/v1/realtime", model: "moss-live-1.0", voice: "xiaoyang", speed: 1.1, key: { hint: "7f3c" } },
};

const VOICE_DEFAULTS: Record<VoiceProviderId, { url: string; model: string; speed?: number }> = {
  "moss-live": { url: "wss://voice.example.com/v1/realtime", model: "moss-live-1.0", speed: 1.1 },
  "openai-realtime": { url: "wss://realtime.example.com/v1/realtime", model: "gpt-realtime" },
};

/** What each demo provider lists, and how fast each model answers (first word, whole answer). */
const LISTS: Record<string, string[]> = {
  custom: ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.1-luna", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
};
const SPEED: Record<string, [number, number]> = {
  "gpt-6.1-terra": [1800, 2400],
  "claude-sonnet-5-5": [1200, 2100],
  "gpt-6.1-sol": [900, 1600],
  "gpt-6.1-luna": [700, 1300],
  "claude-opus-5-5": [2600, 4100],
  "claude-haiku-5-5": [600, 1100],
  "deepseek-chat": [1500, 2600],
  "deepseek-reasoner": [4200, 6800],
};

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const urlOk = (u: string | undefined, schemes: string[]) => !!u && schemes.some((s) => u.toLowerCase().startsWith(`${s}//`)) && u.length > 8;

function initial(): DemoSaved {
  return {
    rev: 7,
    providers: { deepseek: { label: "DeepSeek", protocol: "openai", baseUrl: "https://deepseek.example.com/v1", key: { hint: "e5d4" } } },
    updatedAt: Date.now() - 2 * 86_400_000,
    updatedBy: "我的平板",
  };
}

let saved: DemoSaved = initial();

function keyView(phone: Kept | undefined, server: Kept | undefined): KeyView {
  if (phone) return { set: true, hint: phone.hint, from: "phone" };
  if (server) return { set: true, hint: server.hint, from: "server" };
  return { set: false, hint: null, from: null };
}

function providerViews(s: DemoSaved): Map<string, { view: ProviderView; issue?: string }> {
  const out = new Map<string, { view: ProviderView; issue?: string }>();
  const ids = [...Object.keys(SERVER.providers), ...Object.keys(s.providers).filter((id) => !(id in SERVER.providers))];
  for (const id of ids) {
    const b = (SERVER.providers as Record<string, DemoProvider>)[id];
    const o = s.providers[id] ?? {};
    const key = keyView(o.key, b?.key);
    const auth = o.auth ?? b?.auth;
    const view: ProviderView = {
      id,
      ...(o.label ?? b?.label ? { label: o.label ?? b?.label } : {}),
      protocol: o.protocol ?? b?.protocol ?? "openai",
      baseUrl: o.baseUrl ?? b?.baseUrl ?? "",
      ...(auth ? { auth } : {}),
      key,
      from: b ? "server" : "phone",
    };
    const issue = !urlOk(view.baseUrl, ["http:", "https:"]) ? " 的地址不对" : !key.set && auth !== "none" ? " 还没有密钥" : undefined;
    out.set(id, { view, ...(issue ? { issue } : {}) });
  }
  return out;
}

function voiceView(s: DemoSaved, warnings: string[]): VoiceView {
  const o = s.voice ?? {};
  const provider = o.provider !== undefined ? o.provider : SERVER.voice.provider;
  if (!provider) return { provider: null, key: keyView(o.key, null) };
  const same = SERVER.voice.provider === provider ? SERVER.voice : undefined;
  const d = VOICE_DEFAULTS[provider];
  const voice = o.voice ?? same?.voice;
  const speed = o.speed ?? same?.speed ?? d.speed;
  const view: VoiceView = { provider, url: o.url ?? same?.url ?? d.url, model: o.model ?? same?.model ?? d.model, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}), key: keyView(o.key, same?.key) };
  if (!view.key.set) warnings.push("语音还没有密钥：电话打不通。");
  else if (!urlOk(view.url, ["ws:", "wss:"])) warnings.push("语音的地址要以 ws:// 或 wss:// 开头：电话打不通。");
  return view;
}

function view(): AssistantConfigView {
  const s = saved;
  const warnings: string[] = [];
  const providers = providerViews(s);
  const models = s.models ?? SERVER.models;
  let usable = 0;
  for (const m of models) {
    const p = providers.get(m.provider);
    if (!p) warnings.push(`模型 ${m.model}：服务商 ${m.provider} 已经不在了。`);
    else if (p.issue) warnings.push(`模型 ${m.model} 现在用不了：${p.view.label ?? m.provider}${p.issue}。`);
    else usable++;
  }
  if (!usable) warnings.push("没有能用的文字模型：小羊只能说自己还没配好。");
  const voice = voiceView(s, warnings);
  return {
    rev: s.rev,
    name: "小羊",
    providers: [...providers.values()].map((p) => p.view),
    models: models.map((m) => ({ ...m })),
    voice,
    edited: !!(s.models || (s.voice && Object.keys(s.voice).length) || Object.keys(s.providers).length),
    ...(s.updatedAt ? { updatedAt: s.updatedAt, updatedBy: s.updatedBy } : {}),
    warnings,
  };
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function applyProvider(next: DemoSaved, p: ProviderPatch) {
  const id = p.id?.trim() ?? "";
  if (!PROVIDER_ID.test(id)) fail(400, "bad_request", `服务商的名字“${id}”不行：用小写字母、数字和短横线，字母开头。`);
  const server = id in SERVER.providers;
  if (p.remove) {
    if (server) fail(400, "bad_request", "服务器上配的服务商不能删，只能改，或者恢复成服务器上的设置。");
    delete next.providers[id];
    return;
  }
  const isNew = !server && !next.providers[id];
  const o: DemoProvider = { ...(next.providers[id] ?? {}) };
  if (p.label !== undefined) {
    const label = text(p.label, 40);
    if (label) o.label = label;
    else delete o.label;
  }
  if (p.protocol !== undefined) o.protocol = p.protocol;
  if (p.baseUrl !== undefined) {
    const u = text(p.baseUrl, 300)?.replace(/\/+$/, "");
    if (!u || !urlOk(u, ["http:", "https:"])) fail(400, "bad_request", "地址要以 http:// 或 https:// 开头。");
    o.baseUrl = u;
  }
  if (p.auth !== undefined) {
    if (p.auth === null) delete o.auth;
    else o.auth = p.auth;
  }
  if (p.apiKey === null) delete o.key;
  else if (typeof p.apiKey === "string" && p.apiKey.trim()) {
    if (/\s/.test(p.apiKey.trim())) fail(400, "bad_request", "密钥里不能有空格，也不能太长。");
    o.key = keep(p.apiKey.trim());
  }
  if (isNew && (!o.protocol || !o.baseUrl)) fail(400, "bad_request", "新加的服务商要写协议和地址。");
  next.providers[id] = o;
}

function applyVoice(next: DemoSaved, v: VoicePatch) {
  const o: DemoVoice = { ...(next.voice ?? {}) };
  if (v.provider !== undefined) o.provider = v.provider;
  for (const field of ["url", "model", "voice"] as const) {
    const val = v[field];
    if (val === undefined) continue;
    if (val === null || !String(val).trim()) delete o[field];
    else {
      const t = String(val).trim();
      if (field === "url" && !urlOk(t, ["ws:", "wss:"])) fail(400, "bad_request", "语音地址要以 ws:// 或 wss:// 开头。");
      o[field] = t;
    }
  }
  if (v.speed !== undefined) {
    if (v.speed === null) delete o.speed;
    else if (!(v.speed >= 0.5 && v.speed <= 1.5)) fail(400, "bad_request", "语速要在 0.5 到 1.5 之间。");
    else o.speed = v.speed;
  }
  if (v.apiKey === null) delete o.key;
  else if (typeof v.apiKey === "string" && v.apiKey.trim()) o.key = keep(v.apiKey.trim());
  next.voice = o;
}

// ---- Prompts ----

const NAME = { slot: "{{name}}", means: "小羊的名字" };
type PromptMeta = Omit<PromptView, "id" | "text" | "defaultText" | "edited" | "updatedAt" | "updatedBy">;
const PROMPT_META: [PromptId, PromptMeta, string][] = [
  [
    "base",
    { title: "性格和办事规矩", about: "打字和通话都用：它是谁、怎么说话、怎么查、怎么传话。", group: "性格与规矩", slots: [NAME, { slot: "{{acting}}", means: "下面“动手”两条里按设置选的一条" }] },
    "你是{{name}}，主人放在口袋里的小助理，帮主人盯着几台电脑上的 agent。\n\n说话像身边熟悉的朋友：先说结论，再说要紧的一两件事。不知道就去查，查不到就照实说，不编。\n\n替主人给 agent 传话时，用主人的意思，说得比主人更清楚，但不添主人没说的要求。\n\n{{acting}}",
  ],
  ["act_direct", { title: "动手：直接办", about: "“动手前先问我”关着时（通话里总是这样），怎么替你动手。", group: "性格与规矩", slots: [] }, "主人让你做的事，直接去做，做完照实说结果。\n\n只有删东西、重启服务这种收不回来的事，先说一句再做。"],
  ["act_ask", { title: "动手：先问再办", about: "“动手前先问我”开着时，先生成待确认操作再问你。", group: "性格与规矩", slots: [] }, "要给 agent 发消息、按键或新开 agent 时，先生成待确认的操作，用一句话说清要做什么，等主人点确认。"],
  ["text", { title: "文字聊天", about: "打字聊天时回答的长短和格式。", group: "文字聊天", slots: [{ slot: "{{cards}}", means: "下面两条“卡片”里按设置选的一条" }] }, "打字聊天时，回答尽量短：一两句能说完就不要列表。要列的时候最多五条。\n\n{{cards}}"],
  ["cards_direct", { title: "卡片：直接办", about: "直接办完后，聊天里的卡片怎么配一句话。", group: "文字聊天", slots: [] }, "办完的事会显示成一张卡片，你只需要配一句话说结果，不要把卡片上的内容再说一遍。"],
  ["cards_ask", { title: "卡片：等你确认", about: "带“确认 / 取消”的卡片出来时，怎么配一句话。", group: "文字聊天", slots: [] }, "等确认的卡片出来时，配一句“点确认就发”之类的话就够了。"],
  ["call", { title: "通话：后台查和办", about: "通话里后台去查、去办，带回“台词 / --- / 备查”。", group: "通话", slots: [] }, "你在电话的后台帮忙查和办。先写一两句能直接念出来的台词，再写一行 ---，下面写备查的细节。"],
  [
    "persona",
    { title: "通话：语音的人设", about: "电话里出声的那个语音模型是谁、怎么说话。", group: "通话", slots: [NAME] },
    "你是{{name}}，在电话里陪主人说话。语气轻松，句子短，一次只说一件事。听不清就请主人再说一遍。",
  ],
  ["voice_rules", { title: "通话：语音怎么干活", about: "语音模型什么自己答、什么交给后台、结果回来怎么说。", group: "通话", slots: [] }, "闲聊自己答。要看 agent、要动手的事交给后台，同时跟主人说一句“我去看看”。后台的结果回来后，用自己的话说给主人听。"],
  ["woken", { title: "被叫醒", about: "agent 停下时去看一眼，回来写成通知。", group: "被叫醒", slots: [] }, "有 agent 停下了。去看看它最后做了什么、是不是在等主人，写一条通知：第一句说结论，最多再写三行细节。"],
];

let promptEdits: Partial<Record<PromptId, { text: string; updatedAt: number; updatedBy: string }>> = {};

function initialPromptEdits(): typeof promptEdits {
  const persona = PROMPT_META.find(([id]) => id === "persona")![2];
  return { persona: { text: `${persona}\n\n主人叫你的时候，先轻轻应一声“嗯，我在”。`, updatedAt: Date.now() - 3 * 3_600_000, updatedBy: "我的平板" } };
}

let promptsSeeded = false;

function promptViews(): PromptView[] {
  if (!promptsSeeded) {
    promptEdits = initialPromptEdits();
    promptsSeeded = true;
  }
  return PROMPT_META.map(([id, meta, defaultText]) => {
    const e = promptEdits[id];
    return { id, ...meta, slots: meta.slots.map((s) => ({ ...s })), text: e?.text ?? defaultText, defaultText, edited: !!e, ...(e ? { updatedAt: e.updatedAt, updatedBy: e.updatedBy } : {}) };
  });
}

const DEMO_PHONE = "我的手机";

export const mockConfig = {
  async view(): Promise<AssistantConfigView> {
    await wait(220);
    return view();
  },
  async change(change: AssistantConfigChange): Promise<AssistantConfigView> {
    await wait(260);
    if (change.rev !== saved.rev) fail(409, "conflict", "另一台手机刚改过设置，先刷新再改。");
    if (change.reset) {
      saved = { rev: saved.rev + 1, providers: {}, updatedAt: Date.now(), updatedBy: DEMO_PHONE };
      return view();
    }
    const next: DemoSaved = JSON.parse(JSON.stringify(saved)) as DemoSaved;
    for (const p of change.providers ?? []) applyProvider(next, p);
    if (change.models !== undefined) {
      if (!change.models.length) fail(400, "bad_request", "至少要留一个模型。");
      if (change.models.length > 12) fail(400, "bad_request", "最多 12 个模型。");
      const seen = new Set<string>();
      next.models = [];
      for (const m of change.models) {
        const model = text(m.model, 120);
        if (!model) fail(400, "bad_request", "模型名是空的。");
        if (seen.has(`${m.provider}:${model}`)) continue;
        seen.add(`${m.provider}:${model}`);
        next.models.push({ provider: m.provider, model });
      }
    }
    if (change.voice) applyVoice(next, change.voice);
    const known = new Set([...Object.keys(SERVER.providers), ...Object.keys(next.providers)]);
    for (const m of next.models ?? SERVER.models) if (!known.has(m.provider)) fail(400, "bad_request", `模型 ${m.model} 用的服务商 ${m.provider} 不存在。`);
    next.rev = saved.rev + 1;
    next.updatedAt = Date.now();
    next.updatedBy = DEMO_PHONE;
    saved = next;
    return view();
  },
  /** A short demo request: plausible times after about as long as they say. */
  async test(body: { provider: string | ProviderPatch; model: string }): Promise<ModelTestResult> {
    const model = body.model.trim();
    let id: string;
    let p: { view: ProviderView; issue?: string } | undefined;
    if (typeof body.provider === "string") {
      id = body.provider;
      p = providerViews(saved).get(id);
      if (!p) fail(404, "not_found", `没有叫 ${id} 的服务商。`);
    } else {
      id = body.provider.id;
      const next: DemoSaved = JSON.parse(JSON.stringify(saved)) as DemoSaved;
      applyProvider(next, { ...body.provider, remove: false });
      p = providerViews(next).get(id);
    }
    await wait(400);
    if (!p || p.issue) fail(400, "bad_request", `${p?.view.label ?? id}${p?.issue ?? " 没配好"}。`);
    const list = LISTS[id];
    if (list && !list.includes(model)) {
      await wait(500);
      return { ok: false, firstMs: undefined, totalMs: 640, error: `服务商说没有这个模型：${model}（404）` };
    }
    const [first, total] = SPEED[model] ?? [1400, 2300];
    const jitter = () => 0.88 + Math.random() * 0.24;
    const firstMs = Math.round(first * jitter());
    const totalMs = Math.max(firstMs + 200, Math.round(total * jitter()));
    await wait(Math.min(totalMs, 3200));
    return { ok: true, firstMs, totalMs, reply: "你好，我在。" };
  },
  async models(provider: string): Promise<string[]> {
    await wait(450);
    if (!providerViews(saved).has(provider)) fail(404, "not_found", `没有叫 ${provider} 的服务商。`);
    return LISTS[provider] ?? [];
  },
  async prompts(): Promise<PromptView[]> {
    await wait(200);
    return promptViews();
  },
  async savePrompt(id: PromptId, value: string | null): Promise<PromptView> {
    await wait(280);
    promptViews();
    if (value === null) delete promptEdits[id];
    else {
      if (!value.trim()) fail(400, "bad_request", "提示词不能是空的；想用原来的就点恢复默认。");
      promptEdits[id] = { text: value.replace(/\r\n/g, "\n"), updatedAt: Date.now(), updatedBy: DEMO_PHONE };
    }
    const v = promptViews().find((x) => x.id === id);
    if (!v) fail(404, "not_found", "没有这段提示词。");
    return v;
  },
  /** Back to how the demo starts (a new demo session). */
  restart() {
    saved = initial();
    promptsSeeded = false;
  },
};
