import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntry, TranscribeInfo } from "@herdr-pocket/protocol";
import { Relay } from "../src/server.ts";
import { TranscribeLimiter, httpBaseOfRealtime, loadTranscribeSettings, resolveTranscribe, wavDurationMs } from "../src/transcribe.ts";
import type { LlmTarget } from "../src/assistant/llm.ts";

const ADMIN = "transcribe-test-admin-token-0123456789";
const KEY = "sk-transcribe-test-key-123456";
const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

after(async () => {
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fake OpenAI-compatible speech-to-text service that records what it got (sizes only). */
async function fakeService(answer: (req: IncomingMessage, body: Buffer) => { status: number; body: string; delayMs?: number }) {
  const seen: Array<{ path: string; auth?: string; type?: string; bytes: number; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, type: req.headers["content-type"], bytes: body.length, body: body.toString("latin1") });
    const a = answer(req, body);
    if (a.delayMs) await new Promise((r) => setTimeout(r, a.delayMs));
    res.writeHead(a.status, { "Content-Type": "application/json" }).end(a.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/v1`, seen };
}

function wav(seconds: number, rate = 16_000): Buffer {
  const data = Buffer.alloc(seconds * rate * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function start(opts: ConstructorParameters<typeof Relay>[0] extends infer O ? Partial<O> : never) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-transcribe-"));
  dirs.push(dir);
  const relay = new Relay({ dbPath: join(dir, "relay.db"), adminToken: ADMIN, log: () => {}, ...opts });
  const port = await relay.listen(0, "127.0.0.1");
  closers.push(() => relay.close());
  const base = `http://127.0.0.1:${port}`;
  const pair = async (kind: "viewer" | "host", name: string) => {
    const code = (await (await fetch(`${base}/v1/pair/codes`, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ kind }) })).json()) as { code: string };
    const r = (await (await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.code, name, kind, via: "local-login" }) })).json()) as { token: string; device: { id: string } };
    return r;
  };
  const post = async (token: string, body: Buffer, type = "audio/wav", query = "") => {
    const res = await fetch(`${base}/v1/transcribe${query}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": type }, body: new Uint8Array(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const info = async (token: string) => {
    const res = await fetch(`${base}/v1/transcribe`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json().catch(() => null)) as TranscribeInfo };
  };
  const logs = async (q: string) => ((await (await fetch(`${base}/v1/logs?${q}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()) as { entries: LogEntry[] }).entries;
  return { relay, base, pair, post, info, logs };
}

test("settings: env, the realtime voice's host, the text providers, or why not", () => {
  const { settings, warnings } = loadTranscribeSettings({ POCKET_TRANSCRIBE_URL: "https://stt.example.com/v1/", POCKET_TRANSCRIBE_KEY: "k", POCKET_TRANSCRIBE_AUTH: "weird" });
  assert.equal(settings.url, "https://stt.example.com/v1");
  assert.equal(settings.auth, "bearer");
  assert.equal(warnings.length, 1);
  assert.equal(httpBaseOfRealtime("wss://api.openai.com/v1/realtime?model=gpt-realtime"), "https://api.openai.com/v1");
  assert.equal(httpBaseOfRealtime("wss://res.openai.azure.com/openai/v1/realtime"), "https://res.openai.azure.com/openai/v1");
  assert.equal(httpBaseOfRealtime("https://x"), undefined);

  const openai: LlmTarget = { provider: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k1", model: "gpt-5" };
  const deepseek: LlmTarget = { provider: "deepseek", protocol: "openai", baseUrl: "https://api.deepseek.com", apiKey: "k2", model: "deepseek-flash" };
  const realtime = { provider: "openai-realtime" as const, url: "wss://api.openai.com/v1/realtime", apiKey: "kv", model: "gpt-realtime", transcribeModel: "gpt-4o-transcribe" };
  assert.deepEqual(resolveTranscribe({}, [deepseek, openai], realtime), { provider: "voice", baseUrl: "https://api.openai.com/v1", apiKey: "kv", auth: "bearer", model: "gpt-4o-transcribe" });
  assert.equal((resolveTranscribe({}, [deepseek, openai], undefined) as { provider: string }).provider, "openai");
  assert.match((resolveTranscribe({}, [deepseek], { url: "wss://api.mosi.cn/v1/realtime", apiKey: "m", model: "moss-live-1.0" }) as { reason: string }).reason, /还没有配置语音转文字/);
  assert.equal((resolveTranscribe({ provider: "off" }, [openai], realtime) as { reason: string }).reason.includes("off"), true);
  assert.equal((resolveTranscribe({ provider: "deepseek" }, [deepseek], undefined) as { reason: string }).reason.includes("POCKET_TRANSCRIBE_MODEL"), true);
  assert.equal((resolveTranscribe({ provider: "deepseek", model: "whisper-x" }, [deepseek], undefined) as { model: string }).model, "whisper-x");
  // Its own service wins in auto mode; with no key nothing is sent as one.
  assert.deepEqual(resolveTranscribe({ url: "http://127.0.0.1:9/v1" }, [openai], realtime), { provider: "custom", baseUrl: "http://127.0.0.1:9/v1", apiKey: undefined, auth: "none", model: "gpt-4o-mini-transcribe" });
});

test("limiter: per minute and at once, per device", () => {
  let now = 0;
  const l = new TranscribeLimiter(3, 1, () => now);
  const a = l.take("d1");
  assert.equal(typeof a, "function");
  assert.match((l.take("d1") as { reason: string }).reason, /还在识别/);
  assert.equal(typeof l.take("d2"), "function", "another device is not held up");
  (a as () => void)();
  (l.take("d1") as () => void)();
  (l.take("d1") as () => void)();
  assert.match((l.take("d1") as { reason: string }).reason, /太频繁/);
  now += 61_000;
  assert.equal(typeof l.take("d1"), "function");
});

test("wav length from the header", () => {
  assert.equal(wavDurationMs(wav(2)), 2000);
  assert.equal(wavDurationMs(Buffer.from("not a wav file at all, just some text here.....")), undefined);
});

test("POST /v1/transcribe: text back, key only to its service, logs without content, limits", async () => {
  const svc = await fakeService(() => ({ status: 200, body: JSON.stringify({ text: " 你好世界 " }) }));
  const r = await start({ transcribe: { url: svc.url, key: KEY, model: "whisper-test" }, transcribeLimits: { perMinute: 3, concurrent: 2 } });
  const phone = await r.pair("viewer", "Desk");
  const host = await r.pair("host", "Mac");

  assert.equal((await r.info(host.token)).status, 401, "computers cannot dictate");
  const info = await r.info(phone.token);
  assert.deepEqual([info.json.available, info.json.provider, info.json.model], [true, "custom", "whisper-test"]);

  const ok = await r.post(phone.token, wav(1), "audio/wav", "?language=zh&durationMs=1000");
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.text, ok.json.provider, ok.json.model, ok.json.language], ["你好世界", "custom", "whisper-test", "zh"]);
  const sent = svc.seen[0]!;
  assert.equal(sent.path, "/v1/audio/transcriptions");
  assert.equal(sent.auth, `Bearer ${KEY}`);
  assert.match(sent.type ?? "", /^multipart\/form-data/);
  assert.match(sent.body, /name="model"\r\n\r\nwhisper-test/);
  assert.match(sent.body, /name="language"\r\n\r\nzh/);
  assert.match(sent.body, /filename="audio.wav"/);

  assert.equal((await r.post(phone.token, Buffer.alloc(0))).status, 400, "empty");
  assert.equal((await r.post(phone.token, Buffer.from("x"), "text/plain")).status, 400, "not audio");
  assert.equal((await r.post(phone.token, wav(301, 8000))).status, 413, "too long");
  const many = await r.post(phone.token, wav(1));
  assert.equal(many.status, 429, "per-minute limit (3, the empty and too-long ones counted)");

  const lines = await r.logs("kind=transcribe&since=1h");
  assert.ok(lines.some((e) => e.level === "info" && /custom\/whisper-test .* -> 4 chars in \d+ ms/.test(e.msg) && e.data?.bytes === wav(1).length));
  assert.ok(lines.some((e) => e.level === "warn" && /rate limited/.test(e.msg)));
  assert.ok(!JSON.stringify(lines).includes("你好"), "the text is never logged");
  assert.ok(!JSON.stringify(lines).includes(KEY), "nor the key");
  const pairs = await r.logs("kind=pair&since=1h");
  assert.ok(pairs.some((e) => /viewer "Desk" paired with a code from admin via local-login/.test(e.msg)));
  assert.ok(pairs.some((e) => /pair code for viewer made by admin/.test(e.msg)));
});

test("POST /v1/transcribe: unavailable, upstream errors and size", async () => {
  const none = await start({});
  const p0 = await none.pair("viewer", "P0");
  const i0 = await none.info(p0.token);
  assert.equal(i0.json.available, false);
  assert.match(i0.json.reason ?? "", /POCKET_TRANSCRIBE_URL/);
  const u = await none.post(p0.token, wav(1));
  assert.deepEqual([u.status, u.json.error.code], [503, "unsupported"]);

  const svc = await fakeService(() => ({ status: 401, body: JSON.stringify({ error: { message: `bad key ${KEY}` } }) }));
  const r = await start({ transcribe: { url: svc.url, key: KEY } });
  const phone = await r.pair("viewer", "P1");
  const bad = await r.post(phone.token, wav(1), "audio/webm;codecs=opus");
  assert.equal(bad.status, 502);
  assert.match(bad.json.error.message, /401/);
  assert.ok(!bad.json.error.message.includes(KEY), "the key is cut out of upstream errors");
  assert.equal(svc.seen[0]?.body.includes('filename="audio.webm"'), true);
  // Too large by its declared length: refused before any of it is read (only the headers are sent here,
  // so the answer cannot race the upload).
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(`${r.base}/v1/transcribe`);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "audio/webm", "Content-Length": String(10 * 1024 * 1024 + 1) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.flushHeaders();
  });
  assert.equal(status, 413);
});
