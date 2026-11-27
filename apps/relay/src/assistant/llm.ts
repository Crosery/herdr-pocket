/**
 * Streaming chat client for the text assistant. Five wire protocols:
 *   - openai: OpenAI Chat Completions (/chat/completions)
 *   - openai-responses: OpenAI Responses API (/responses, Codex)
 *   - anthropic: Anthropic Messages (/v1/messages)
 *   - gemini: Google Gemini native generateContent (/v1beta/models/...:streamGenerateContent?alt=sse)
 *   - ollama: Ollama native chat (/api/chat, NDJSON)
 * No SDK: the relay keeps its runtime dependency list at `ws` + `qrcode` only.
 */
import type { ModelAuth, ModelProtocol } from "@herdr-pocket/protocol";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Msg {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  reasoning?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  /** Hint to disallow tool calls on the final synthesis turn while preserving tool declarations. */
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streamed text of the current answer, as it arrives. */
  onText?: (delta: string) => void;
  /** Called as reasoning/thinking deltas stream before text output. */
  onReasoning?: () => void;
}

export interface LlmResult {
  content: ContentBlock[];
  stopReason: string | null;
  model: string;
  reasoning?: string;
}

export type Llm = (req: LlmRequest) => Promise<LlmResult>;

export type Protocol = ModelProtocol;
export type AuthStyle = ModelAuth;

/** One model at one provider: an entry of the fallback list. */
export interface LlmTarget {
  /** Provider id, for logs and health (never the key). */
  provider: string;
  protocol: Protocol;
  /** Endpoint root URL. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Default depends on protocol; nothing is sent without a key. */
  auth?: AuthStyle;
  headers?: Record<string, string>;
  /** OpenAI Chat protocol: `max_tokens` unless the vendor wants `max_completion_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Merged into every request body last, e.g. `{"thinking":{"type":"disabled"}}`. */
  extraBody?: Record<string, unknown>;
}

export interface LlmConfig {
  /** Tried in order: the next one is used when one fails or stays silent too long. */
  targets: LlmTarget[];
  /** No first token of the answer within this long: give up on that model. */
  firstByteMs?: number;
  totalMs?: number;
  /** Fallbacks and slow answers (never the key). */
  log?: (msg: string) => void;
}

const SLOW_MS = 8_000;
const QUOTA_COOLDOWN_MS = 5 * 60_000;
const QUOTA_ERROR_RE = /\b429\b|quota exhausted|insufficient_quota|weekly limit|FreeUsageLimitError|rate[ _-]?limit/i;

export class LlmError extends Error {}

export function makeLlm(cfg: LlmConfig): Llm {
  const cooldownUntil = new Map<string, number>();
  return async (req) => {
    const now = Date.now();
    const active: LlmTarget[] = [];
    const cooled: LlmTarget[] = [];
    for (const t of cfg.targets) {
      const k = `${t.provider}\0${t.model}\0${t.baseUrl}`;
      if ((cooldownUntil.get(k) ?? 0) > now) cooled.push(t);
      else active.push(t);
    }
    const ordered = active.length ? [...active, ...cooled] : cooled;
    let last: unknown;
    for (const t of ordered) {
      if (req.signal?.aborted) throw new LlmError("cancelled");
      const t0 = Date.now();
      const key = `${t.provider}\0${t.model}\0${t.baseUrl}`;
      const label = `${t.provider}:${t.model}`;
      try {
        const r = await once(t, cfg, req);
        cooldownUntil.delete(key);
        const ms = Date.now() - t0;
        if (ms > SLOW_MS) cfg.log?.(`${label} slow: ${ms}ms`);
        return r;
      } catch (e) {
        last = e;
        if (req.signal?.aborted) throw e;
        const msg = (e as Error).message;
        if (QUOTA_ERROR_RE.test(msg)) {
          cooldownUntil.set(key, Date.now() + QUOTA_COOLDOWN_MS);
          cfg.log?.(`${label} failed (cooldown 5m) after ${Date.now() - t0}ms: ${msg.slice(0, 200)}`);
        } else {
          cfg.log?.(`${label} failed after ${Date.now() - t0}ms: ${msg.slice(0, 200)}`);
        }
      }
    }
    throw last instanceof Error ? last : new LlmError("model unavailable");
  };
}

/** One short request to one model: does it answer, and how fast (first word, whole answer). */
export async function testModel(t: LlmTarget, signal?: AbortSignal): Promise<{ ok: boolean; firstMs?: number; totalMs?: number; reply?: string; error?: string }> {
  const t0 = Date.now();
  let first = 0;
  try {
    const r = await once(t, { targets: [t], firstByteMs: 20_000, totalMs: 30_000 }, {
      system: "你在接受连通测试。只回一个字。",
      messages: [{ role: "user", content: "回一个字：好" }],
      tools: [],
      maxTokens: 256,
      signal,
      onText: () => (first ||= Date.now() - t0),
    });
    const reply = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return { ok: true, firstMs: first || Date.now() - t0, totalMs: Date.now() - t0, reply: reply.slice(0, 40) };
  } catch (e) {
    return { ok: false, totalMs: Date.now() - t0, error: (e as Error).message.slice(0, 300) };
  }
}

function isRootPath(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).pathname === "/";
  } catch {
    return false;
  }
}

function anthropicRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function geminiRoot(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  return /\/v1(?:beta|alpha)$/i.test(clean) ? clean : `${clean}/v1beta`;
}

function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/(?:v1|api)$/i, "");
}

function defaultAuth(protocol: Protocol): AuthStyle {
  switch (protocol) {
    case "anthropic":
      return "x-api-key";
    case "gemini":
      return "x-goog-api-key";
    case "ollama":
      return "none";
    default:
      return "bearer";
  }
}

export function authHeaders(t: LlmTarget): Record<string, string> {
  if (!t.apiKey) return {};
  switch (t.auth ?? defaultAuth(t.protocol)) {
    case "bearer":
      return { authorization: `Bearer ${t.apiKey}` };
    case "x-api-key":
      return { "x-api-key": t.apiKey };
    case "api-key":
      return { "api-key": t.apiKey };
    case "x-goog-api-key":
      return { "x-goog-api-key": t.apiKey };
    default:
      return {};
  }
}

async function fetchWithRootV1Fallback(url: string, base: string, suffix: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status === 404 && (isRootPath(base) || !/\/v1(?:$|\/)/i.test(base))) {
    return fetch(`${base}/v1${suffix}`, init);
  }
  return res;
}

const MAX_MODEL_PAGES = 20;
const MAX_LISTED_MODELS = 5000;

interface ParsedModelsPage {
  ids: string[];
  hasMore: boolean;
  lastId?: string;
  nextPageToken?: string;
}

function parseModelsBody(raw: unknown): ParsedModelsPage {
  if (Array.isArray(raw)) {
    const ids = raw
      .map((m) => (typeof m === "string" ? m : typeof (m as { id?: unknown })?.id === "string" ? (m as { id: string }).id : typeof (m as { name?: unknown })?.name === "string" ? (m as { name: string }).name.replace(/^models\//, "") : ""))
      .filter(Boolean);
    return { ids, hasMore: false };
  }
  const body = (raw && typeof raw === "object" ? raw : {}) as {
    data?: unknown;
    models?: Array<{ id?: unknown; name?: unknown }>;
    has_more?: unknown;
    last_id?: unknown;
    nextPageToken?: unknown;
  };
  const dataArr = Array.isArray(body.data)
    ? body.data
    : body.data && typeof body.data === "object" && Array.isArray((body.data as { models?: unknown }).models)
      ? ((body.data as { models: unknown[] }).models)
      : [];
  const fromData = dataArr
    .map((m) => (typeof m === "string" ? m : typeof (m as { id?: unknown })?.id === "string" ? (m as { id: string }).id : typeof (m as { name?: unknown })?.name === "string" ? (m as { name: string }).name.replace(/^models\//, "") : ""))
    .filter(Boolean);
  const fromModels = (Array.isArray(body.models) ? body.models : [])
    .map((m) => (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : typeof m?.id === "string" ? m.id : ""))
    .filter(Boolean);
  const ids = [...fromData, ...fromModels];
  const lastId = typeof body.last_id === "string" && body.last_id ? body.last_id : ids.length ? ids[ids.length - 1] : undefined;
  const nextPageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
  return {
    ids,
    hasMore: body.has_more === true,
    lastId,
    nextPageToken,
  };
}

/** The model names a provider lists; follows pagination and auth/path fallbacks. */
export async function listModels(t: LlmTarget): Promise<string[]> {
  const base = t.baseUrl.replace(/\/+$/, "");
  const collected = new Set<string>();
  const collect = (ids: string[]) => {
    for (const id of ids) {
      if (collected.size < MAX_LISTED_MODELS) collected.add(id);
    }
  };

  if (t.protocol === "anthropic") {
    let activeHdrs: Record<string, string> = { "anthropic-version": "2023-06-01", ...authHeaders(t), ...t.headers };
    let endpoint = `${anthropicRoot(base)}/v1/models`;
    let useLimit = true;
    let afterId: string | undefined;

    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const qs = new URLSearchParams();
      if (useLimit) qs.set("limit", "1000");
      if (afterId) qs.set("after_id", afterId);
      const url = qs.size ? `${endpoint}?${qs.toString()}` : endpoint;

      let res = await fetch(url, { headers: activeHdrs, signal: AbortSignal.timeout(10_000) });

      // Many third-party Anthropic-compatible gateways require Authorization: Bearer instead of x-api-key.
      if (page === 0 && (res.status === 401 || res.status === 403) && !t.auth && t.apiKey) {
        const bearerHdrs: Record<string, string> = {
          "anthropic-version": "2023-06-01",
          authorization: `Bearer ${t.apiKey}`,
          ...t.headers,
        };
        const retry = await fetch(url, { headers: bearerHdrs, signal: AbortSignal.timeout(10_000) });
        if (retry.ok || (retry.status !== 401 && retry.status !== 403)) {
          activeHdrs = bearerHdrs;
          res = retry;
        }
      }

      // Some gateways reject ?limit=1000 with 400/422.
      if (page === 0 && useLimit && (res.status === 400 || res.status === 422)) {
        useLimit = false;
        res = await fetch(endpoint, { headers: activeHdrs, signal: AbortSignal.timeout(10_000) });
      }

      // Custom prefixed base URLs that already serve /models directly without /v1.
      if (page === 0 && res.status === 404 && endpoint !== `${base}/models`) {
        endpoint = `${base}/models`;
        const altUrl = useLimit ? `${endpoint}?limit=1000` : endpoint;
        res = await fetch(altUrl, { headers: activeHdrs, signal: AbortSignal.timeout(10_000) });
      }

      if (!res.ok) {
        if (page > 0 && collected.size > 0) break;
        throw new LlmError(`${t.provider}: HTTP ${res.status} ${scrub((await res.text().catch(() => "")).slice(0, 160), t.apiKey)}`);
      }
      const parsed = parseModelsBody(await res.json().catch(() => ({})));
      const before = collected.size;
      collect(parsed.ids);
      if (!parsed.hasMore || !parsed.lastId || parsed.lastId === afterId || collected.size === before || collected.size >= MAX_LISTED_MODELS) {
        break;
      }
      afterId = parsed.lastId;
    }
    return [...collected].sort();
  }

  const hdrs = { ...authHeaders(t), ...t.headers };

  if (t.protocol === "gemini") {
    const root = geminiRoot(base);
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const qs = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) qs.set("pageToken", pageToken);
      const res = await fetch(`${root}/models?${qs.toString()}`, {
        headers: hdrs,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (page > 0 && collected.size > 0) break;
        throw new LlmError(`${t.provider}: HTTP ${res.status} ${scrub((await res.text().catch(() => "")).slice(0, 160), t.apiKey)}`);
      }
      const parsed = parseModelsBody(await res.json().catch(() => ({})));
      const before = collected.size;
      collect(parsed.ids);
      if (!parsed.nextPageToken || parsed.nextPageToken === pageToken || collected.size === before || collected.size >= MAX_LISTED_MODELS) {
        break;
      }
      pageToken = parsed.nextPageToken;
    }
    return [...collected].sort();
  }

  if (t.protocol === "ollama") {
    const oBase = ollamaRoot(base);
    let res = await fetch(`${oBase}/api/tags`, { headers: hdrs, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      res = await fetch(`${oBase}/v1/models`, { headers: hdrs, signal: AbortSignal.timeout(10_000) });
    }
    if (!res.ok) throw new LlmError(`${t.provider}: HTTP ${res.status} ${scrub((await res.text().catch(() => "")).slice(0, 160), t.apiKey)}`);
    collect(parseModelsBody(await res.json().catch(() => ({}))).ids);
    return [...collected].sort();
  }

  // OpenAI Chat / OpenAI Responses: support prefixed /v1 fallback and cursor pagination when exposed.
  let endpoint = `${base}/models`;
  let afterId: string | undefined;
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    let res: Response;
    if (page === 0) {
      res = await fetchWithRootV1Fallback(endpoint, base, "/models", {
        headers: hdrs,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.url) {
        try {
          const resolved = new URL(res.url);
          endpoint = `${resolved.origin}${resolved.pathname}`;
        } catch {
          // keep endpoint
        }
      }
    } else {
      const qs = new URLSearchParams({ after: afterId! });
      res = await fetch(`${endpoint}?${qs.toString()}`, {
        headers: hdrs,
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!res.ok) {
      if (page > 0 && collected.size > 0) break;
      throw new LlmError(`${t.provider}: HTTP ${res.status} ${scrub((await res.text().catch(() => "")).slice(0, 160), t.apiKey)}`);
    }
    const parsed = parseModelsBody(await res.json().catch(() => ({})));
    const before = collected.size;
    collect(parsed.ids);
    if (!parsed.hasMore || !parsed.lastId || parsed.lastId === afterId || collected.size === before || collected.size >= MAX_LISTED_MODELS) {
      break;
    }
    afterId = parsed.lastId;
  }
  return [...collected].sort();
}

/** What a protocol needs to know while a stream is read. */
interface Stream {
  /** Set once the answer has really started (text, a tool call, or reasoning). */
  started(): void;
}

async function once(t: LlmTarget, cfg: LlmConfig, req: LlmRequest): Promise<LlmResult> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  let gotContent = false;
  const firstTimer = setTimeout(() => {
    if (!gotContent) ac.abort();
  }, cfg.firstByteMs ?? 15_000);
  const totalTimer = setTimeout(() => ac.abort(), cfg.totalMs ?? 120_000);
  const label = `${t.provider}:${t.model}`;
  const stream: Stream = { started: () => (gotContent = true) };
  try {
    const base = t.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(t.protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
      ...authHeaders(t),
      ...t.headers,
    };
    let res: Response;
    if (t.protocol === "anthropic") {
      res = await fetch(`${anthropicRoot(base)}/v1/messages`, {
        method: "POST",
        signal: ac.signal,
        headers,
        body: JSON.stringify({ ...anthropicBody(t, req), ...t.extraBody }),
      });
    } else if (t.protocol === "gemini") {
      res = await fetch(`${geminiRoot(base)}/models/${encodeURIComponent(t.model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        signal: ac.signal,
        headers,
        body: JSON.stringify({ ...geminiBody(req), ...t.extraBody }),
      });
    } else if (t.protocol === "ollama") {
      res = await fetch(`${ollamaRoot(base)}/api/chat`, {
        method: "POST",
        signal: ac.signal,
        headers,
        body: JSON.stringify({ ...ollamaBody(t, req), ...t.extraBody }),
      });
    } else if (t.protocol === "openai-responses") {
      res = await fetchWithRootV1Fallback(`${base}/responses`, base, "/responses", {
        method: "POST",
        signal: ac.signal,
        headers,
        body: JSON.stringify({ ...responsesBody(t, req), ...t.extraBody }),
      });
    } else {
      const isMimo = base.includes("xiaomimimo.com") || t.provider === "mimo";
      const autoExtra = isMimo
        ? req.tools.length === 0 || req.toolChoice === "none"
          ? !t.extraBody || t.extraBody.thinking === undefined
            ? { thinking: { type: "disabled" } }
            : undefined
          : {
              ...(t.extraBody?.reasoning_effort === undefined ? { reasoning_effort: "low" } : {}),
              ...(t.extraBody?.parallel_tool_calls === undefined ? { parallel_tool_calls: true } : {}),
              ...(t.extraBody?.max_tokens === undefined && (req.maxTokens ?? 1200) < 2048 ? { max_tokens: 2048 } : {}),
            }
        : undefined;
      res = await fetchWithRootV1Fallback(`${base}/chat/completions`, base, "/chat/completions", {
        method: "POST",
        signal: ac.signal,
        headers,
        body: JSON.stringify({ ...openaiBody(t, req), ...autoExtra, ...t.extraBody }),
      });
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new LlmError(`${label}: HTTP ${res.status} ${scrub(text, t.apiKey).slice(0, 200)}`);
    }
    const r =
      t.protocol === "ollama"
        ? await readOllama(ndjson(res.body as unknown as AsyncIterable<Uint8Array>), t, req, stream)
        : await (async () => {
            const events = sse(res.body as unknown as AsyncIterable<Uint8Array>);
            switch (t.protocol) {
              case "anthropic":
                return readAnthropic(events, t, req, stream);
              case "gemini":
                return readGemini(events, t, req, stream);
              case "openai-responses":
                return readResponses(events, t, req, stream);
              default:
                return readOpenai(events, t, req, stream);
            }
          })();
    // Reasoning counts as stream activity, but a completed turn needs text or a tool call.
    const usable = r.content.some((b) =>
      (b.type === "text" && b.text.trim()) || (b.type === "tool_use" && req.tools.length > 0 && b.name.trim()),
    );
    if (!usable) throw new LlmError(r.stopReason === "max_tokens" ? `${label}: empty answer (hit max_tokens)` : `${label}: empty answer`);
    return r;
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (ac.signal.aborted && !req.signal?.aborted) throw new LlmError(`${label}: no answer in time`);
    throw new LlmError(`${label}: ${scrub((e as Error).message, t.apiKey)}`);
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

/** `data:` payloads of a server-sent event stream, parsed; `[DONE]` and junk are skipped. */
async function* sse(body: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* keep-alive or broken line */
      }
    }
  }
}

/** Newline-delimited JSON objects (Ollama /api/chat). */
async function* ndjson(body: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* partial or malformed line */
      }
    }
  }
  const rest = buf.trim();
  if (rest) {
    try {
      yield JSON.parse(rest);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicBody(t: LlmTarget, req: LlmRequest): Record<string, unknown> {
  return {
    model: t.model,
    max_tokens: req.maxTokens ?? 1200,
    stream: true,
    system: req.system,
    messages: req.messages.map(({ role, content }) => ({ role, content })),
    ...(req.tools.length ? { tools: req.tools } : {}),
  };
}

async function readAnthropic(events: AsyncGenerator<any>, t: LlmTarget, req: LlmRequest, stream: Stream): Promise<LlmResult> {
  const blocks: Array<{ type: string; text?: string; id?: string; name?: string; json?: string }> = [];
  let stopReason: string | null = null;
  for await (const d of events) {
    switch (d.type) {
      case "content_block_start": {
        stream.started();
        const b = d.content_block ?? {};
        blocks[d.index] = { type: b.type, text: b.text ?? "", id: b.id, name: b.name, json: "" };
        break;
      }
      case "content_block_delta": {
        stream.started();
        const b = blocks[d.index];
        if (!b) break;
        if (d.delta?.type === "text_delta" && typeof d.delta.text === "string") {
          b.text += d.delta.text;
          req.onText?.(d.delta.text);
        } else if (d.delta?.type === "thinking_delta" && typeof d.delta.thinking === "string") {
          req.onReasoning?.();
        } else if (d.delta?.type === "input_json_delta" && typeof d.delta.partial_json === "string") {
          b.json += d.delta.partial_json;
        }
        break;
      }
      case "message_delta":
        if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
        break;
      case "error":
        throw new LlmError(`${t.provider}:${t.model}: ${scrub(String(d.error?.message ?? "stream error"), t.apiKey)}`);
    }
  }
  const content: ContentBlock[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use" && b.id && b.name) content.push({ type: "tool_use", id: b.id, name: b.name, input: parseArgs(b.json) });
  }
  return { content, stopReason, model: t.model };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

function openaiBody(t: LlmTarget, req: LlmRequest): Record<string, unknown> {
  return {
    model: t.model,
    stream: true,
    [t.maxTokensField ?? "max_tokens"]: req.maxTokens ?? 1200,
    messages: [{ role: "system", content: req.system }, ...toOpenaiMessages(req.messages)],
    ...(req.tools.length
      ? {
          tools: req.tools.map((x) => ({ type: "function", function: { name: x.name, description: x.description, parameters: x.input_schema } })),
          ...(req.toolChoice === "none" ? { tool_choice: "none" } : {}),
        }
      : {}),
  };
}

/** Anthropic-shaped history to Chat Completions messages: tool results become `tool` messages right after the call. */
export function toOpenaiMessages(msgs: Msg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      out.push({
        role: m.role,
        content: m.content,
        ...(m.role === "assistant" && m.reasoning ? { reasoning_content: m.reasoning } : {}),
      });
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (m.role === "assistant") {
      const calls = m.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
      });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const OPENAI_STOP: Record<string, string> = { tool_calls: "tool_use", function_call: "tool_use", stop: "end_turn", length: "max_tokens" };

async function readOpenai(events: AsyncGenerator<any>, t: LlmTarget, req: LlmRequest, stream: Stream): Promise<LlmResult> {
  let text = "";
  let reasoning = "";
  const calls: Array<{ id: string; name: string; args: string }> = [];
  let stopReason: string | null = null;
  for await (const d of events) {
    if (d.error) throw new LlmError(`${t.provider}:${t.model}: ${scrub(String(d.error.message ?? d.error.code ?? "stream error"), t.apiKey)}`);
    const ch = Array.isArray(d.choices) ? d.choices[0] : undefined;
    if (!ch) continue;
    const delta = ch.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      stream.started();
      text += delta.content;
      req.onText?.(delta.content);
    }
    // Thinking models reason before they answer: that counts as having started, but is not the answer.
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      stream.started();
      reasoning += delta.reasoning_content;
      req.onReasoning?.();
    } else if (typeof delta.reasoning === "string" && delta.reasoning) {
      stream.started();
      reasoning += delta.reasoning;
      req.onReasoning?.();
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        stream.started();
        let i: number = typeof tc.index === "number" ? tc.index : calls.length - 1;
        if (typeof tc.index !== "number" && (i < 0 || (tc.id && calls[i]!.id && calls[i]!.id !== tc.id))) i = calls.length;
        const c = (calls[i] ??= { id: "", name: "", args: "" });
        if (typeof tc.id === "string" && tc.id) c.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name && !c.name) c.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") c.args += tc.function.arguments;
        else if (tc.function?.arguments && typeof tc.function.arguments === "object") c.args = JSON.stringify(tc.function.arguments);
      }
    }
    if (ch.finish_reason) stopReason = OPENAI_STOP[ch.finish_reason] ?? ch.finish_reason;
  }
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  calls.forEach((c, n) => {
    if (!c?.name) return;
    content.push({ type: "tool_use", id: c.id || `call_${Date.now().toString(36)}_${n}`, name: c.name, input: parseArgs(c.args) });
  });
  return { content, stopReason, model: t.model, ...(reasoning ? { reasoning } : {}) };
}

// ---------------------------------------------------------------------------
// OpenAI Responses API (/responses, Codex)
// ---------------------------------------------------------------------------

export function toResponsesInput(msgs: Msg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (m.role === "assistant") {
      if (text) out.push({ role: "assistant", content: text });
      for (const b of m.content) {
        if (b.type === "tool_use") {
          out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        }
      }
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function responsesBody(t: LlmTarget, req: LlmRequest): Record<string, unknown> {
  return {
    model: t.model,
    stream: true,
    instructions: req.system,
    max_output_tokens: Math.max(16, req.maxTokens ?? 1200),
    input: toResponsesInput(req.messages),
    ...(req.tools.length
      ? { tools: req.tools.map((x) => ({ type: "function", name: x.name, description: x.description, parameters: x.input_schema })) }
      : {}),
  };
}

async function readResponses(events: AsyncGenerator<any>, t: LlmTarget, req: LlmRequest, stream: Stream): Promise<LlmResult> {
  let text = "";
  const callsByKey = new Map<string, { callId: string; name: string; args: string }>();
  const callOrder: string[] = [];
  const getCall = (key: string) => {
    let c = callsByKey.get(key);
    if (!c) {
      c = { callId: "", name: "", args: "" };
      callsByKey.set(key, c);
      callOrder.push(key);
    }
    return c;
  };
  let stopReason: string | null = null;
  for await (const d of events) {
    if (d.type === "error" || d.type === "response.failed") {
      const msg = d.error?.message ?? d.response?.error?.message ?? d.message ?? "responses stream error";
      throw new LlmError(`${t.provider}:${t.model}: ${scrub(String(msg), t.apiKey)}`);
    }
    if (d.type === "response.output_text.delta" && typeof d.delta === "string") {
      stream.started();
      text += d.delta;
      req.onText?.(d.delta);
    } else if (d.type === "response.reasoning_summary_text.delta" || d.type === "response.reasoning_text.delta") {
      stream.started();
      req.onReasoning?.();
    } else if (d.type === "response.output_item.added" && d.item?.type === "function_call") {
      stream.started();
      const key = String(d.item.id ?? d.output_index ?? callOrder.length);
      const c = getCall(key);
      if (typeof d.item.call_id === "string" && d.item.call_id) c.callId = d.item.call_id;
      else if (typeof d.item.id === "string" && d.item.id && !c.callId) c.callId = d.item.id;
      if (typeof d.item.name === "string" && d.item.name) c.name = d.item.name;
      if (typeof d.item.arguments === "string" && d.item.arguments) c.args += d.item.arguments;
    } else if (d.type === "response.function_call_arguments.delta" && typeof d.delta === "string") {
      stream.started();
      const key = String(d.item_id ?? d.output_index ?? callOrder[callOrder.length - 1] ?? 0);
      getCall(key).args += d.delta;
    } else if (d.type === "response.function_call_arguments.done" && typeof d.arguments === "string") {
      const key = String(d.item_id ?? d.output_index ?? callOrder[callOrder.length - 1] ?? 0);
      const c = getCall(key);
      if (!c.args) c.args = d.arguments;
    } else if (d.type === "response.output_item.done" && d.item?.type === "function_call") {
      stream.started();
      const key = String(d.item.id ?? d.output_index ?? callOrder[callOrder.length - 1] ?? 0);
      const c = getCall(key);
      if (typeof d.item.call_id === "string" && d.item.call_id) c.callId = d.item.call_id;
      else if (typeof d.item.id === "string" && d.item.id && !c.callId) c.callId = d.item.id;
      if (typeof d.item.name === "string" && d.item.name) c.name = d.item.name;
      if (typeof d.item.arguments === "string" && d.item.arguments && !c.args) c.args = d.item.arguments;
    } else if (d.type === "response.completed") {
      stopReason = callOrder.some((k) => callsByKey.get(k)?.name) ? "tool_use" : "end_turn";
    }
  }
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  callOrder.forEach((key, n) => {
    const c = callsByKey.get(key);
    if (!c?.name) return;
    content.push({ type: "tool_use", id: c.callId || `call_${Date.now().toString(36)}_${n}`, name: c.name, input: parseArgs(c.args) });
  });
  return { content, stopReason: stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"), model: t.model };
}

// ---------------------------------------------------------------------------
// Google Gemini Native API (/v1beta/models/...:streamGenerateContent?alt=sse)
// ---------------------------------------------------------------------------

export function toGeminiContents(msgs: Msg[]): Array<Record<string, unknown>> {
  const idToName = new Map<string, string>();
  const out: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === "text" && b.text) {
        parts.push({ text: b.text });
      } else if (b.type === "tool_use") {
        idToName.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown> } });
      } else if (b.type === "tool_result") {
        parts.push({
          functionResponse: {
            name: idToName.get(b.tool_use_id) ?? b.tool_use_id,
            response: { content: b.content, ...(b.is_error ? { is_error: true } : {}) },
          },
        });
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

function geminiBody(req: LlmRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toGeminiContents(req.messages),
    ...(req.tools.length
      ? { tools: [{ functionDeclarations: req.tools.map((x) => ({ name: x.name, description: x.description, parameters: x.input_schema })) }] }
      : {}),
    generationConfig: { maxOutputTokens: req.maxTokens ?? 1200 },
  };
}

async function readGemini(events: AsyncGenerator<any>, t: LlmTarget, req: LlmRequest, stream: Stream): Promise<LlmResult> {
  let text = "";
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  let stopReason: string | null = null;
  let seq = 0;
  for await (const d of events) {
    if (d.error) throw new LlmError(`${t.provider}:${t.model}: ${scrub(String(d.error.message ?? d.error.status ?? "gemini error"), t.apiKey)}`);
    const cand = Array.isArray(d.candidates) ? d.candidates[0] : undefined;
    if (!cand) continue;
    const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
    for (const part of parts) {
      if (part.thought) {
        stream.started();
        req.onReasoning?.();
        continue;
      }
      if (typeof part.text === "string" && part.text) {
        stream.started();
        text += part.text;
        req.onText?.(part.text);
      }
      if (part.functionCall?.name) {
        stream.started();
        calls.push({
          id: `call_gem_${Date.now().toString(36)}_${seq++}`,
          name: String(part.functionCall.name),
          input: part.functionCall.args && typeof part.functionCall.args === "object" ? part.functionCall.args : {},
        });
      }
    }
    if (cand.finishReason) {
      stopReason = calls.length ? "tool_use" : cand.finishReason === "STOP" ? "end_turn" : String(cand.finishReason).toLowerCase();
    }
  }
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  return { content, stopReason: calls.length ? "tool_use" : stopReason, model: t.model };
}

// ---------------------------------------------------------------------------
// Ollama Native API (/api/chat)
// ---------------------------------------------------------------------------

function toOllamaMessages(msgs: Msg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (m.role === "assistant") {
      const calls = m.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ function: { name: b.name, arguments: b.input && typeof b.input === "object" ? b.input : {} } }));
      out.push(calls.length ? { role: "assistant", content: text || "", tool_calls: calls } : { role: "assistant", content: text });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", content: b.content });
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function ollamaBody(t: LlmTarget, req: LlmRequest): Record<string, unknown> {
  return {
    model: t.model,
    stream: true,
    messages: [{ role: "system", content: req.system }, ...toOllamaMessages(req.messages)],
    ...(req.tools.length
      ? { tools: req.tools.map((x) => ({ type: "function", function: { name: x.name, description: x.description, parameters: x.input_schema } })) }
      : {}),
    ...(req.maxTokens ? { options: { num_predict: req.maxTokens } } : {}),
  };
}

async function readOllama(events: AsyncGenerator<any>, t: LlmTarget, req: LlmRequest, stream: Stream): Promise<LlmResult> {
  let text = "";
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  let seq = 0;
  for await (const d of events) {
    if (d.error) throw new LlmError(`${t.provider}:${t.model}: ${scrub(String(d.error), t.apiKey)}`);
    const msg = d.message;
    if (msg) {
      if (typeof msg.thinking === "string" && msg.thinking) {
        stream.started();
        req.onReasoning?.();
      }
      if (typeof msg.content === "string" && msg.content) {
        stream.started();
        text += msg.content;
        req.onText?.(msg.content);
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc?.function?.name;
          if (!name) continue;
          stream.started();
          const rawArgs = tc.function.arguments;
          const input = typeof rawArgs === "string" ? parseArgs(rawArgs) : rawArgs && typeof rawArgs === "object" ? rawArgs : {};
          calls.push({ id: `call_ol_${Date.now().toString(36)}_${seq++}`, name: String(name), input });
        }
      }
    }
  }
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  return { content, stopReason: calls.length ? "tool_use" : "end_turn", model: t.model };
}

function parseArgs(json: string | undefined): unknown {
  if (!json || !json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function scrub(s: string, key: string | undefined): string {
  return key ? s.split(key).join("[redacted]") : s;
}
