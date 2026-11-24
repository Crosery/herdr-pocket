/**
 * The assistant's configuration as phones change it: the name, model
 * providers and their keys, the order models are tried in, the voice service,
 * and prompt edits. The server's own settings (environment, POCKET_CONFIG)
 * are the starting point; a phone's change overrides them, "reset" goes back.
 *
 * Keys and prompt edits are sealed (AES-256-GCM) with a key kept in a file
 * next to the database, so a copy of the database alone holds neither. A key
 * never leaves the relay again: phones see whether one is set and its last
 * four characters.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type {
  AssistantConfigChange,
  AssistantConfigView,
  ConfigSource,
  KeyView,
  ModelAuth,
  ModelProtocol,
  ModelRef,
  PromptId,
  ProviderPatch,
  ProviderView,
  RpcErrorCode,
  VoicePatch,
  VoiceProviderId,
  VoiceView,
} from "@herdr-pocket/protocol";
import { RESERVED, urlOk } from "../config.ts";
import type { Store } from "../store.ts";
import type { LlmTarget } from "./llm.ts";
import type { LiveConfig } from "./live.ts";
import type { PromptEdit } from "./prompts.ts";
import { MOSS_DEFAULTS, REALTIME_DEFAULTS } from "./providers.ts";

/** What the server's own settings give (src/config.ts). */
export interface ServerSetup {
  targets: LlmTarget[];
  name?: string;
  firstByteMs?: number;
  live?: LiveConfig;
}

/** The configuration in force: what the relay runs with, and what phones are shown. */
export interface EffectiveConfig {
  targets: LlmTarget[];
  name: string;
  firstByteMs?: number;
  live?: LiveConfig;
  view: AssistantConfigView;
}

export class ConfigError extends Error {
  readonly status: number;
  readonly code: RpcErrorCode;
  constructor(status: number, code: RpcErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

interface SavedProvider {
  label?: string;
  protocol?: ModelProtocol;
  baseUrl?: string;
  auth?: ModelAuth;
  key?: Sealed;
  /** The address (origin) the key was given for: it is never sent anywhere else. */
  keyFor?: string;
}

interface SavedVoice {
  /** Null: a phone turned voice calls off. */
  provider?: VoiceProviderId | null;
  url?: string;
  model?: string;
  voice?: string;
  speed?: number;
  key?: Sealed;
  keyFor?: string;
}

interface Saved {
  rev: number;
  name?: string;
  providers: Record<string, SavedProvider>;
  models?: ModelRef[];
  voice?: SavedVoice;
  updatedAt?: number;
  updatedBy?: string;
}

type SavedPrompts = Partial<Record<PromptId, { sealed: Sealed; updatedAt: number; updatedBy: string }>>;

const CONFIG_KEY = "assistant.config";
const PROMPTS_KEY = "assistant.prompts";
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PROTOCOLS: ModelProtocol[] = ["openai", "openai-responses", "anthropic", "gemini", "ollama"];
const AUTHS: ModelAuth[] = ["bearer", "x-api-key", "api-key", "x-goog-api-key", "none"];
const VOICES: VoiceProviderId[] = ["moss-live", "openai-realtime"];
const MAX_MODELS = 12;
const MAX_PROMPT = 20_000;

/** AES-256-GCM with a key in a file of its own (created on first use, owner-only). */
export class Sealer {
  private readonly key: Buffer;

  /** `path` null: the key lives in memory only (an in-memory database). */
  constructor(path: string | null) {
    if (!path) {
      this.key = randomBytes(32);
      return;
    }
    try {
      this.key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
      if (this.key.length !== 32) throw new Error(`${path} does not hold a 32-byte key`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.key = randomBytes(32);
      writeFileSync(path, `${this.key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    }
  }

  seal(plain: string): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  hmacSha256(data: string): string {
    return createHmac("sha256", this.key).update(data, "utf8").digest("base64url");
  }

  /** Undefined when it cannot be opened (another key file, a damaged value). */
  open(s: Sealed | undefined): string | undefined {
    if (!s) return undefined;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "base64"));
      d.setAuthTag(Buffer.from(s.tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8");
    } catch {
      return undefined;
    }
  }
}

function keyView(key: string | undefined, from: ConfigSource | null): KeyView {
  return key ? { set: true, hint: key.length > 8 ? key.slice(-4) : null, from } : { set: false, hint: null, from: null };
}

/** Scheme, host and port: a key goes only to the address it was given for. */
function originOf(u: string | undefined): string {
  try {
    return u ? new URL(u).origin : "";
  } catch {
    return "";
  }
}

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export class ConfigStore {
  private readonly store: Store;
  private readonly sealer: Sealer;
  private readonly base: ServerSetup;

  constructor(store: Store, sealer: Sealer, base: ServerSetup) {
    this.store = store;
    this.sealer = sealer;
    this.base = base;
  }

  private saved(): Saved {
    const s = this.store.getSetting<Saved>(CONFIG_KEY);
    return s && typeof s.rev === "number" ? { ...s, providers: s.providers ?? {} } : { rev: 0, providers: {} };
  }

  rev(): number {
    return this.saved().rev;
  }

  hmacAnchor(data: string): string {
    return this.sealer.hmacSha256(data);
  }

  // ---------------------------------------------------------------------------
  // What is in force
  // ---------------------------------------------------------------------------

  effective(): EffectiveConfig {
    const s = this.saved();
    const warnings: string[] = [];
    const providers = this.providers(s, warnings);
    const models = s.models ?? this.base.targets.map((t) => ({ provider: t.provider, model: t.model }));
    const targets: LlmTarget[] = [];
    const named = (id: string) => providers.get(id)?.view.label ?? id;
    for (const m of models) {
      const p = providers.get(m.provider);
      if (!p) warnings.push(`模型 ${m.model}：服务商 ${m.provider} 已经不在了。`);
      else if (p.issue) warnings.push(`模型 ${m.model} 现在用不了：${named(m.provider)}${p.issue}。`);
      else targets.push({ ...p.target!, model: m.model });
    }
    if (!targets.length) warnings.push("没有能用的文字模型：小羊只能说自己还没配好。");
    const voice = this.voice(s, warnings);
    const name = s.name ?? this.base.name ?? "小羊";
    return {
      targets,
      name,
      ...(this.base.firstByteMs ? { firstByteMs: this.base.firstByteMs } : {}),
      ...(voice.live ? { live: voice.live } : {}),
      view: {
        rev: s.rev,
        name,
        providers: [...providers.values()].map((p) => p.view),
        models,
        voice: voice.view,
        edited: !!(s.name || s.models || (s.voice && Object.keys(s.voice).length) || Object.keys(s.providers).length),
        ...(s.updatedAt ? { updatedAt: s.updatedAt, updatedBy: s.updatedBy } : {}),
        warnings,
      },
    };
  }

  /** Server providers first (in the order their models come), then the ones phones added. */
  private providers(s: Saved, warnings: string[]): Map<string, { target?: Omit<LlmTarget, "model">; view: ProviderView; issue?: string }> {
    const server = new Map<string, Omit<LlmTarget, "model">>();
    for (const { model: _, ...p } of this.base.targets) if (!server.has(p.provider)) server.set(p.provider, p);
    const ids = [...server.keys(), ...Object.keys(s.providers).filter((id) => !server.has(id))];
    const out = new Map<string, { target?: Omit<LlmTarget, "model">; view: ProviderView; issue?: string }>();
    for (const id of ids) {
      const b = server.get(id);
      const o = s.providers[id] ?? {};
      const protocol = o.protocol ?? b?.protocol ?? "openai";
      const baseUrl = o.baseUrl ?? b?.baseUrl ?? "";
      const origin = originOf(baseUrl);
      const opened = this.sealer.open(o.key);
      if (o.key && opened === undefined) warnings.push(`${o.label ?? id} 在手机上设的密钥读不出来了（服务器的密钥文件换过），请重新设一次。`);
      // A key goes only to the address it was given for: moving the address does not take the key along.
      const phoneKey = opened !== undefined && o.keyFor === origin ? opened : undefined;
      const serverKey = b?.apiKey && originOf(b.baseUrl) === origin ? b.apiKey : undefined;
      const apiKey = phoneKey ?? serverKey;
      const auth = o.auth ?? b?.auth;
      const view: ProviderView = {
        id,
        ...(o.label ? { label: o.label } : {}),
        protocol,
        baseUrl,
        ...(auth ? { auth } : {}),
        key: keyView(apiKey, phoneKey ? "phone" : serverKey ? "server" : null),
        from: b ? "server" : "phone",
      };
      // A server provider the relay already took without a key (a local model) or Ollama needs none.
      const keyless = auth === "none" || protocol === "ollama" || (b !== undefined && !b.apiKey && !o.key && originOf(b.baseUrl) === origin);
      const moved = !apiKey && (opened !== undefined || !!b?.apiKey);
      const issue = !urlOk(baseUrl, ["http:", "https:"]) ? " 的地址不对" : !apiKey && !keyless ? (moved ? " 换了地址，密钥要重新填一次" : " 还没有密钥") : undefined;
      const { apiKey: _, ...rest } = b ?? ({} as Partial<Omit<LlmTarget, "model">>);
      const target = issue ? undefined : { ...rest, provider: id, protocol, baseUrl, ...(apiKey ? { apiKey } : {}), ...(auth ? { auth } : {}) };
      out.set(id, { ...(target ? { target } : {}), view, ...(issue ? { issue } : {}) });
    }
    return out;
  }

  private voice(s: Saved, warnings: string[]): { live?: LiveConfig; view: VoiceView } {
    const b = this.base.live;
    const o = s.voice ?? {};
    const provider = o.provider !== undefined ? o.provider : b ? (b.provider ?? "moss-live") : null;
    const opened = this.sealer.open(o.key);
    if (o.key && opened === undefined) warnings.push("语音在手机上设的密钥读不出来了（服务器的密钥文件换过），请重新设一次。");
    if (!provider) return { view: { provider: null, key: keyView(undefined, null) } };
    // The server's voice settings count only for the same service: a MOSS key is no OpenAI key.
    const same = b && (b.provider ?? "moss-live") === provider ? b : undefined;
    const moss = provider === "moss-live";
    const url = o.url ?? same?.url ?? (moss ? MOSS_DEFAULTS.url : REALTIME_DEFAULTS.url);
    const phoneKey = opened !== undefined && o.keyFor === originOf(url) ? opened : undefined;
    const serverKey = same?.apiKey && originOf(same.url) === originOf(url) ? same.apiKey : undefined;
    const apiKey = phoneKey ?? serverKey;
    const model = o.model ?? same?.model ?? (moss ? MOSS_DEFAULTS.model : REALTIME_DEFAULTS.model);
    const voice = o.voice ?? same?.voice ?? (moss ? undefined : REALTIME_DEFAULTS.voice);
    const speed = o.speed ?? same?.speed ?? (moss ? MOSS_DEFAULTS.speed : undefined);
    const view: VoiceView = { provider, url, model, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}), key: keyView(apiKey, phoneKey ? "phone" : serverKey ? "server" : null) };
    if (!apiKey) {
      warnings.push("语音还没有密钥：电话打不通。");
      return { view };
    }
    if (!urlOk(url, ["ws:", "wss:"])) {
      warnings.push("语音的地址要以 ws:// 或 wss:// 开头：电话打不通。");
      return { view };
    }
    const common = { url, apiKey, model, ...(voice ? { voice } : {}), ...(speed ? { speed } : {}) };
    if (moss) return { live: { ...(same ?? {}), provider: "moss-live", ...common }, view };
    const r = same?.provider === "openai-realtime" ? same : undefined;
    const noiseReduction = r?.noiseReduction !== undefined ? r.noiseReduction : r?.auth === "api-key" ? undefined : ("near_field" as const);
    return {
      live: {
        dialect: "ga",
        vad: "server_vad",
        language: "zh",
        transcribeModel: REALTIME_DEFAULTS.transcribeModel,
        inputRate: REALTIME_DEFAULTS.rate,
        outputRate: REALTIME_DEFAULTS.rate,
        ...(noiseReduction !== undefined ? { noiseReduction } : {}),
        ...(r ?? {}),
        provider: "openai-realtime",
        ...common,
      },
      view,
    };
  }

  // ---------------------------------------------------------------------------
  // Changes from a phone
  // ---------------------------------------------------------------------------

  /** Applies one change from a phone, all or nothing. Returns a line for the log (never a key). */
  apply(change: AssistantConfigChange, by: string): string {
    const s = this.saved();
    if (typeof change?.rev !== "number" || change.rev !== s.rev) throw new ConfigError(409, "conflict", "另一台手机刚改过设置，先刷新再改。");
    const now = Date.now();
    if (change.reset) {
      this.store.putSetting(CONFIG_KEY, { rev: s.rev + 1, providers: {}, updatedAt: now, updatedBy: by } satisfies Saved);
      return "went back to the server's settings";
    }
    const next: Saved = structuredClone(s);
    const said: string[] = [];
    if (change.name !== undefined) {
      const name = text(change.name, 20);
      if (name) next.name = name;
      else delete next.name;
      said.push(`name ${name ?? "(server's)"}`);
    }
    for (const p of change.providers ?? []) said.push(this.applyProvider(next, p));
    if (change.models !== undefined) {
      if (!Array.isArray(change.models) || !change.models.length) throw new ConfigError(400, "bad_request", "至少要留一个模型。");
      if (change.models.length > MAX_MODELS) throw new ConfigError(400, "bad_request", `最多 ${MAX_MODELS} 个模型。`);
      const seen = new Set<string>();
      next.models = [];
      for (const m of change.models) {
        const provider = typeof m?.provider === "string" ? m.provider : "";
        const model = text(m?.model, 120);
        if (!model) throw new ConfigError(400, "bad_request", "模型名是空的。");
        if (seen.has(`${provider}:${model}`)) continue;
        seen.add(`${provider}:${model}`);
        next.models.push({ provider, model });
      }
      said.push(`models ${next.models.map((m) => `${m.provider}:${m.model}`).join(",")}`);
    }
    if (change.voice) said.push(this.applyVoice(next, change.voice));
    // Every model must name a provider that is still there.
    const known = new Set([...this.base.targets.map((t) => t.provider), ...Object.keys(next.providers)]);
    for (const m of next.models ?? this.base.targets.map((t) => ({ provider: t.provider, model: t.model }))) {
      if (!known.has(m.provider)) throw new ConfigError(400, "bad_request", `模型 ${m.model} 用的服务商 ${m.provider} 不存在。`);
    }
    next.rev = s.rev + 1;
    next.updatedAt = now;
    next.updatedBy = by;
    this.store.putSetting(CONFIG_KEY, next);
    return said.join("; ") || "nothing changed";
  }

  private applyProvider(next: Saved, p: ProviderPatch): string {
    const id = typeof p?.id === "string" ? p.id.trim() : "";
    if (!PROVIDER_ID.test(id) || RESERVED.has(id)) throw new ConfigError(400, "bad_request", `服务商的名字“${id}”不行：用小写字母、数字和短横线，字母开头。`);
    const server = this.base.targets.some((t) => t.provider === id);
    if (p.reset) {
      if (!server) throw new ConfigError(400, "bad_request", "只有服务器上配的服务商才能恢复默认。");
      delete next.providers[id];
      return `provider ${id} reset`;
    }
    if (p.remove) {
      if (server) throw new ConfigError(400, "bad_request", "服务器上配的服务商不能删，只能改，或者恢复成服务器上的设置。");
      delete next.providers[id];
      return `provider ${id} removed`;
    }
    const o: SavedProvider = { ...(next.providers[id] ?? {}) };
    const isNew = !server && !next.providers[id];
    const said: string[] = [];
    if (p.label !== undefined) {
      const label = text(p.label, 40);
      if (label) o.label = label;
      else delete o.label;
    }
    if (p.protocol !== undefined) {
      if (!PROTOCOLS.includes(p.protocol)) throw new ConfigError(400, "bad_request", `协议只能是 ${PROTOCOLS.join("、")}。`);
      o.protocol = p.protocol;
    }
    if (p.baseUrl !== undefined) {
      const u = text(p.baseUrl, 300)?.replace(/\/+$/, "");
      if (!u || !urlOk(u, ["http:", "https:"])) throw new ConfigError(400, "bad_request", "地址要以 http:// 或 https:// 开头。");
      o.baseUrl = u;
      said.push("address");
    }
    if (p.auth !== undefined) {
      if (p.auth === null) delete o.auth;
      else if (!AUTHS.includes(p.auth)) throw new ConfigError(400, "bad_request", `认证方式只能是 ${AUTHS.join("、")}。`);
      else o.auth = p.auth;
    }
    const where = originOf(o.baseUrl ?? this.base.targets.find((t) => t.provider === id)?.baseUrl);
    if (p.apiKey === null) {
      delete o.key;
      delete o.keyFor;
      said.push("phone key removed");
    } else if (typeof p.apiKey === "string" && p.apiKey.trim()) {
      const key = p.apiKey.trim();
      if (key.length > 500 || /\s/.test(key)) throw new ConfigError(400, "bad_request", "密钥里不能有空格，也不能太长。");
      o.key = this.sealer.seal(key);
      o.keyFor = where;
      said.push("key replaced");
    } else if (o.key && o.keyFor !== where) {
      delete o.key;
      delete o.keyFor;
      said.push("phone key dropped: new address");
    }
    if (isNew && (!o.protocol || !o.baseUrl)) throw new ConfigError(400, "bad_request", "新加的服务商要写协议和地址。");
    next.providers[id] = o;
    return `provider ${id}${isNew ? " added" : ""}${said.length ? ` (${said.join(", ")})` : ""}`;
  }

  private applyVoice(next: Saved, v: VoicePatch): string {
    const o: SavedVoice = { ...(next.voice ?? {}) };
    const said: string[] = [];
    if (v.provider !== undefined) {
      if (v.provider !== null && !VOICES.includes(v.provider)) throw new ConfigError(400, "bad_request", "语音服务只能是 moss-live 或 openai-realtime。");
      o.provider = v.provider;
      said.push(`provider ${v.provider ?? "off"}`);
    }
    for (const field of ["url", "model", "voice"] as const) {
      const val = v[field];
      if (val === undefined) continue;
      if (val === null || !String(val).trim()) delete o[field];
      else {
        const t = String(val).trim().slice(0, 300);
        if (field === "url" && !urlOk(t, ["ws:", "wss:"])) throw new ConfigError(400, "bad_request", "语音地址要以 ws:// 或 wss:// 开头。");
        o[field] = t;
      }
      said.push(field);
    }
    if (v.speed !== undefined) {
      if (v.speed === null) delete o.speed;
      else if (typeof v.speed !== "number" || !(v.speed >= 0.5 && v.speed <= 1.5)) throw new ConfigError(400, "bad_request", "语速要在 0.5 到 1.5 之间。");
      else o.speed = v.speed;
      said.push("speed");
    }
    // The address the voice key belongs to: the one in force after this change.
    const b = this.base.live;
    const provider = o.provider !== undefined ? o.provider : b ? (b.provider ?? "moss-live") : null;
    const same = b && (b.provider ?? "moss-live") === provider ? b : undefined;
    const where = originOf(o.url ?? same?.url ?? (provider === "openai-realtime" ? REALTIME_DEFAULTS.url : MOSS_DEFAULTS.url));
    if (v.apiKey === null) {
      delete o.key;
      delete o.keyFor;
      said.push("phone key removed");
    } else if (typeof v.apiKey === "string" && v.apiKey.trim()) {
      const key = v.apiKey.trim();
      if (key.length > 500 || /\s/.test(key)) throw new ConfigError(400, "bad_request", "密钥里不能有空格，也不能太长。");
      o.key = this.sealer.seal(key);
      o.keyFor = where;
      said.push("key replaced");
    } else if (o.key && o.keyFor !== where) {
      delete o.key;
      delete o.keyFor;
      said.push("phone key dropped: new address");
    }
    next.voice = o;
    return `voice (${said.join(", ") || "unchanged"})`;
  }

  /**
   * The target a test or a model list would use: a provider in force, or one
   * as a phone is about to save it (its key, if not given, stays the current one).
   */
  targetFor(provider: string | ProviderPatch, model: string): LlmTarget {
    const id = typeof provider === "string" ? provider : provider?.id;
    const m = text(model, 120) ?? "";
    if (typeof provider === "string") {
      const s = this.saved();
      const p = this.providers(s, []).get(id);
      if (!p) throw new ConfigError(404, "not_found", `没有叫 ${id} 的服务商。`);
      if (p.issue) throw new ConfigError(400, "bad_request", `${p.view.label ?? id}${p.issue}。`);
      return { ...p.target!, model: m };
    }
    // Not saved: try the change on a copy.
    const s = this.saved();
    const next: Saved = structuredClone(s);
    this.applyProvider(next, { ...provider, remove: false });
    const p = this.providers(next, []).get(id!);
    if (!p || p.issue) throw new ConfigError(400, "bad_request", `${provider.label ?? id}${p?.issue ?? " 没配好"}。`);
    return { ...p.target!, model: m };
  }

  // ---------------------------------------------------------------------------
  // Prompt edits
  // ---------------------------------------------------------------------------

  promptEdits(): Partial<Record<PromptId, PromptEdit>> {
    const saved = this.store.getSetting<SavedPrompts>(PROMPTS_KEY) ?? {};
    const out: Partial<Record<PromptId, PromptEdit>> = {};
    for (const [id, e] of Object.entries(saved) as Array<[PromptId, NonNullable<SavedPrompts[PromptId]>]>) {
      const t = this.sealer.open(e.sealed);
      if (t !== undefined) out[id] = { text: t, updatedAt: e.updatedAt, updatedBy: e.updatedBy };
    }
    return out;
  }

  /** `text` null: back to the default. Prompts are edited one at a time (the last save wins), apart from `rev`. */
  setPrompt(id: PromptId, value: string | null, by: string): void {
    const saved = { ...(this.store.getSetting<SavedPrompts>(PROMPTS_KEY) ?? {}) };
    if (value === null) delete saved[id];
    else {
      if (typeof value !== "string" || !value.trim()) throw new ConfigError(400, "bad_request", "提示词不能是空的；想用原来的就点恢复默认。");
      if (value.length > MAX_PROMPT) throw new ConfigError(400, "bad_request", `提示词太长了（最多 ${MAX_PROMPT} 字）。`);
      saved[id] = { sealed: this.sealer.seal(value.replace(/\r\n/g, "\n")), updatedAt: Date.now(), updatedBy: by };
    }
    this.store.putSetting(PROMPTS_KEY, saved);
  }
}
