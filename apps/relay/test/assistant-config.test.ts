import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { AssistantConfigView, PromptView } from "@herdr-pocket/protocol";
import { Relay } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { ConfigError, ConfigStore, Sealer, type ServerSetup } from "../src/assistant/configstore.ts";
import { promptText, setPromptEdits, systemPrompt, usePromptDir } from "../src/assistant/prompts.ts";

const ADMIN = "admin-token-for-config-tests-0000";
const SERVER_KEY = "sk-server-key-1234abcd";
const PHONE_KEY = "sk-phone-key-5678wxyz";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "pocket-config-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(): ServerSetup {
  return {
    targets: [
      { provider: "custom", protocol: "anthropic", baseUrl: "https://gw.example.com", apiKey: SERVER_KEY, model: "fast-model", headers: { "user-agent": "pocket-test" } },
      { provider: "custom", protocol: "anthropic", baseUrl: "https://gw.example.com", apiKey: SERVER_KEY, model: "careful-model", headers: { "user-agent": "pocket-test" } },
    ],
    live: { provider: "moss-live", url: "wss://voice.example.com/v1/realtime", apiKey: "voice-server-key-0000", model: "moss-live-1.0" },
  };
}

function makeStore(name: string, keyFile = join(dir, `${name}.key`)) {
  const store = new Store(join(dir, `${name}.db`));
  return { store, cfg: new ConfigStore(store, new Sealer(keyFile), setup()), keyFile };
}

test("the server's settings are the start; keys are only ever shown as set and their last characters", () => {
  const { cfg, store } = makeStore("start");
  const e = cfg.effective();
  assert.deepEqual(e.view.models, [
    { provider: "custom", model: "fast-model" },
    { provider: "custom", model: "careful-model" },
  ]);
  assert.equal(e.view.providers.length, 1);
  assert.deepEqual(e.view.providers[0]!.key, { set: true, hint: "abcd", from: "server" });
  assert.equal(e.view.providers[0]!.from, "server");
  assert.equal(e.view.edited, false);
  assert.equal(e.targets[0]!.apiKey, SERVER_KEY);
  assert.equal(e.live?.provider, "moss-live");
  assert.doesNotMatch(JSON.stringify(e.view), /sk-server|voice-server/);
  store.close();
});

test("a phone adds a provider and reorders models: it is used at once, and its key is sealed at rest", () => {
  const { cfg, store, keyFile } = makeStore("change");
  const said = cfg.apply(
    {
      rev: 0,
      providers: [{ id: "deep", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deep.example.com/v1/", apiKey: PHONE_KEY }],
      models: [
        { provider: "deep", model: "deep-chat" },
        { provider: "custom", model: "fast-model" },
      ],
    },
    "Redmi",
  );
  assert.match(said, /provider deep added \(address, key replaced\)/);
  assert.doesNotMatch(said, /sk-/);
  const e = cfg.effective();
  assert.equal(e.view.rev, 1);
  assert.equal(e.view.updatedBy, "Redmi");
  assert.deepEqual(
    e.targets.map((t) => `${t.provider}:${t.model}`),
    ["deep:deep-chat", "custom:fast-model"],
  );
  assert.equal(e.targets[0]!.apiKey, PHONE_KEY);
  assert.equal(e.targets[0]!.baseUrl, "https://api.deep.example.com/v1");
  // The server's provider keeps what only the server knows (headers).
  assert.equal(e.targets[1]!.headers?.["user-agent"], "pocket-test");
  assert.deepEqual(e.view.providers.find((p) => p.id === "deep")!.key, { set: true, hint: "wxyz", from: "phone" });
  // At rest: the saved value holds a sealed key, not the key; nor does any database file. The seal key is owner-only.
  const raw = JSON.stringify(store.getSetting("assistant.config"));
  assert.match(raw, /"deep":\{[^}]*"key":\{"iv":/);
  assert.doesNotMatch(raw, /sk-phone/);
  store.close();
  for (const f of ["change.db", "change.db-wal", "change.db-shm"]) {
    try {
      assert.doesNotMatch(readFileSync(join(dir, f)).toString("latin1"), /sk-phone/);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
});

test("changes are all or nothing and checked: an old rev, a bad URL, deleting a server provider", () => {
  const { cfg, store } = makeStore("checks");
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof ConfigError ? `${e.status} ${e.code}` : String(e);
    }
    return "ok";
  };
  assert.equal(code(() => cfg.apply({ rev: 0, name: "阿羊" }, "a")), "ok");
  assert.equal(code(() => cfg.apply({ rev: 0, name: "又改" }, "b")), "409 conflict");
  assert.equal(code(() => cfg.apply({ rev: 1, providers: [{ id: "x", protocol: "openai", baseUrl: "ftp://nope" }] }, "a")), "400 bad_request");
  assert.equal(code(() => cfg.apply({ rev: 1, providers: [{ id: "custom", remove: true }] }, "a")), "400 bad_request");
  assert.equal(code(() => cfg.apply({ rev: 1, models: [{ provider: "nobody", model: "m" }] }, "a")), "400 bad_request");
  assert.equal(code(() => cfg.apply({ rev: 1, models: [] }, "a")), "400 bad_request");
  assert.equal(code(() => cfg.apply({ rev: 1, providers: [{ id: "Bad Id", protocol: "openai", baseUrl: "https://x.example.com" }] }, "a")), "400 bad_request");
  // None of the refused ones left anything behind.
  assert.equal(cfg.effective().view.rev, 1);
  assert.equal(cfg.effective().name, "阿羊");
  store.close();
});

test("a phone key overrides the server's, removing it falls back, reset forgets every phone change", () => {
  const { cfg, store } = makeStore("keys");
  cfg.apply({ rev: 0, providers: [{ id: "custom", apiKey: PHONE_KEY }] }, "a");
  assert.equal(cfg.effective().targets[0]!.apiKey, PHONE_KEY);
  cfg.apply({ rev: 1, providers: [{ id: "custom", apiKey: null }] }, "a");
  assert.equal(cfg.effective().targets[0]!.apiKey, SERVER_KEY);
  cfg.apply({ rev: 2, models: [{ provider: "custom", model: "careful-model" }], name: "阿羊" }, "a");
  cfg.apply({ rev: 3, reset: true }, "a");
  const e = cfg.effective();
  assert.equal(e.view.edited, false);
  assert.equal(e.name, "小羊");
  assert.equal(e.targets.length, 2);
  store.close();
});

test("a key goes only to the address it was given for: moving the address does not take it along", () => {
  const { cfg, store } = makeStore("bound");
  // The server's key does not follow its provider to another host, not even for a test.
  assert.throws(() => cfg.targetFor({ id: "custom", baseUrl: "https://elsewhere.example.net" }, "m"), (e: unknown) => e instanceof ConfigError && e.status === 400);
  cfg.apply({ rev: 0, providers: [{ id: "custom", baseUrl: "https://elsewhere.example.net" }] }, "a");
  let e = cfg.effective();
  assert.equal(e.targets.length, 0);
  assert.deepEqual(e.view.providers[0]!.key, { set: false, hint: null, from: null });
  assert.ok(e.view.warnings.some((w) => /换了地址，密钥要重新填一次/.test(w)));
  // A path on the same host keeps it.
  cfg.apply({ rev: 1, providers: [{ id: "custom", baseUrl: "https://gw.example.com/anthropic" }] }, "a");
  assert.equal(cfg.effective().targets[0]!.apiKey, SERVER_KEY);
  // A phone key given with a new address goes there; moving again drops it.
  cfg.apply({ rev: 2, providers: [{ id: "custom", baseUrl: "https://mine.example.org", apiKey: PHONE_KEY }] }, "a");
  assert.equal(cfg.effective().targets[0]!.apiKey, PHONE_KEY);
  const said = cfg.apply({ rev: 3, providers: [{ id: "custom", baseUrl: "https://other.example.org" }] }, "a");
  assert.match(said, /phone key dropped: new address/);
  e = cfg.effective();
  assert.equal(e.targets.length, 0);
  assert.doesNotMatch(JSON.stringify(store.getSetting("assistant.config")), /"key":/);
  store.close();
});

test("a key sealed with another key file cannot be read: the relay says so and uses the server's key", () => {
  const first = makeStore("lost");
  first.cfg.apply({ rev: 0, providers: [{ id: "custom", apiKey: PHONE_KEY }] }, "a");
  first.store.close();
  const store = new Store(join(dir, "lost.db"));
  const cfg = new ConfigStore(store, new Sealer(join(dir, "other.key")), setup());
  const e = cfg.effective();
  assert.equal(e.targets[0]!.apiKey, SERVER_KEY);
  assert.ok(e.view.warnings.some((w) => /读不出来/.test(w)));
  store.close();
});

test("voice: another service needs its own key; with one, the service's defaults fill the rest", () => {
  const { cfg, store } = makeStore("voice");
  cfg.apply({ rev: 0, voice: { provider: "openai-realtime" } }, "a");
  let e = cfg.effective();
  assert.equal(e.live, undefined);
  assert.ok(e.view.warnings.some((w) => /语音还没有密钥/.test(w)));
  cfg.apply({ rev: 1, voice: { apiKey: "rt-phone-key-9999", voice: "marin" } }, "a");
  e = cfg.effective();
  assert.equal(e.live?.provider, "openai-realtime");
  assert.equal(e.live?.apiKey, "rt-phone-key-9999");
  assert.equal(e.live?.model, "gpt-realtime");
  assert.deepEqual(e.view.voice.key, { set: true, hint: "9999", from: "phone" });
  cfg.apply({ rev: 2, voice: { provider: null } }, "a");
  assert.equal(cfg.effective().live, undefined);
  store.close();
});

test("prompt edits are sealed, used in place of the shipped text, and a private folder replaces the defaults", () => {
  const { cfg, store } = makeStore("prompts");
  cfg.setPrompt("persona", "你叫{{name}}。只说一个字。", "a");
  assert.doesNotMatch(JSON.stringify(store.getSetting("assistant.prompts")), /只说一个字/);
  assert.match(JSON.stringify(store.getSetting("assistant.prompts")), /"persona":\{"sealed":\{"iv":/);
  store.close();
  const again = new Store(join(dir, "prompts.db"));
  const cfg2 = new ConfigStore(again, new Sealer(join(dir, "prompts.key")), setup());
  setPromptEdits(cfg2.promptEdits());
  assert.equal(promptText("persona"), "你叫{{name}}。只说一个字。");
  setPromptEdits({});
  again.close();

  const own = join(dir, "own-prompts");
  mkdirSync(own);
  writeFileSync(join(own, "act_direct.md"), "私有的动手说明。\n");
  const shipped = promptText("act_direct");
  assert.deepEqual(usePromptDir(own), ["act_direct"]);
  try {
    assert.match(systemPrompt("小羊", "text", ""), /私有的动手说明。/);
  } finally {
    // Put the shipped text back for the tests after this one.
    writeFileSync(join(own, "act_direct.md"), `${shipped}\n`);
    usePromptDir(own);
  }
});

// ---------------------------------------------------------------------------
// Through the relay, against a made-up model gateway
// ---------------------------------------------------------------------------

test("phones change models and prompts over the API; the next message uses them and the other phones hear of it", async () => {
  const seen: Array<{ path: string; key?: string; body?: any }> = [];
  const gw: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ path: req.url ?? "", key: req.headers["x-api-key"] as string | undefined, body });
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fast-model" }, { id: "careful-model" }, { id: "new-model" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      ev({ type: "message_start", message: { usage: {} } });
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `好（${body.model}）` } });
      ev({ type: "message_delta", delta: { stop_reason: "end_turn" } });
      res.end();
    });
  });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", () => r()));
  const gwUrl = `http://127.0.0.1:${(gw.address() as { port: number }).port}`;
  const relay = new Relay({
    dbPath: join(dir, "relay.db"),
    adminToken: ADMIN,
    log: () => {},
    assistant: { targets: [{ provider: "custom", protocol: "anthropic", baseUrl: gwUrl, apiKey: SERVER_KEY, model: "fast-model" }] },
    assistantTiming: { promptEpoch: 0 },
  });
  const base = `http://127.0.0.1:${await relay.listen(0, "127.0.0.1")}`;
  const api = async (path: string, init: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: init.body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const raw = await res.text();
    return { status: res.status, raw, json: JSON.parse(raw) as any };
  };
  const pair = async (kind: "host" | "viewer", name: string) => {
    const code = (await api("/v1/pair/codes", { token: ADMIN, body: { kind } })).json.code;
    return (await api("/v1/pair", { body: { code, name, kind } })).json as { token: string };
  };
  try {
    const phone = await pair("viewer", "Phone A");
    const other = await pair("viewer", "Phone B");
    const computer = await pair("host", "Mac");
    const frames: any[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/v1/ws?token=${other.token}`);
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));

    // Computers do not see it.
    assert.equal((await api("/v1/assistant/config", { token: computer.token })).status, 401);
    const got = await api("/v1/assistant/config", { token: phone.token });
    const view = got.json as AssistantConfigView;
    assert.equal(view.providers[0]!.key.hint, "abcd");
    assert.doesNotMatch(got.raw, /sk-server/);

    // How fast a model answers, with the key the relay holds.
    const t = await api("/v1/assistant/config/test", { token: phone.token, body: { provider: "custom", model: "new-model" } });
    assert.equal(t.json.ok, true);
    assert.equal(t.json.reply, "好（new-model）");
    assert.equal(typeof t.json.firstMs, "number");
    assert.equal(seen.at(-1)!.key, SERVER_KEY);
    // An unsaved provider can be tried before it is saved.
    const t2 = await api("/v1/assistant/config/test", { token: phone.token, body: { provider: { id: "mine", protocol: "anthropic", baseUrl: gwUrl, apiKey: PHONE_KEY }, model: "new-model" } });
    assert.equal(t2.json.ok, true);
    assert.equal(seen.at(-1)!.key, PHONE_KEY);
    assert.equal((await api("/v1/assistant/config", { token: phone.token })).json.providers.length, 1);
    // What the provider lists.
    assert.deepEqual((await api("/v1/assistant/config/models?provider=custom", { token: phone.token })).json.models, ["careful-model", "fast-model", "new-model"]);

    // Switch the main model: the next message goes to it; the other phone is told.
    const changed = await api("/v1/assistant/config", { token: phone.token, body: { rev: view.rev, models: [{ provider: "custom", model: "new-model" }] } });
    assert.equal(changed.status, 200);
    assert.equal((await api("/v1/assistant/config", { token: phone.token, body: { rev: view.rev, name: "晚了" } })).status, 409);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(frames.some((f) => f.type === "assistant_config" && f.what === "config" && f.by === "Phone A" && f.rev === view.rev + 1));
    assert.equal((await api("/v1/health")).json.assistant[0], "custom");

    // A prompt edit from the phone is what the model gets next.
    const p = await api("/v1/assistant/prompts/base", { token: phone.token, body: { text: "你叫{{name}}。今天只说一个字。\n\n{{acting}}" } });
    assert.equal((p.json as PromptView).edited, true);
    await api("/v1/assistant/messages", { token: phone.token, body: { text: "在吗" } });
    for (let i = 0; i < 100 && !seen.some((s) => s.path.startsWith("/v1/messages") && s.body?.model === "new-model" && s.body?.messages?.length > 0 && JSON.stringify(s.body.messages).includes("在吗")); i++) await new Promise((r) => setTimeout(r, 20));
    const asked = seen.findLast((s) => JSON.stringify(s.body?.messages ?? []).includes("在吗"))!;
    assert.equal(asked.body.model, "new-model");
    assert.match(asked.body.system, /^你叫小羊。今天只说一个字。/);
    assert.ok(frames.some((f) => f.type === "assistant_config" && f.what === "prompts"));
    const list = (await api("/v1/assistant/prompts", { token: phone.token })).json.prompts as PromptView[];
    assert.equal(list.length, 10);
    assert.equal(list.find((x) => x.id === "base")!.edited, true);
    const back = await api("/v1/assistant/prompts/base", { token: phone.token, body: { reset: true } });
    assert.equal(back.json.edited, false);
    assert.equal(back.json.text, back.json.defaultText);
    assert.equal((await api("/v1/assistant/prompts/nope", { token: phone.token, body: { text: "x" } })).status, 404);
    ws.close();
  } finally {
    await relay.close();
    await new Promise<void>((r) => gw.close(() => r()));
  }
});
