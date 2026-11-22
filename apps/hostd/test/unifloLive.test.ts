import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";
import { Host } from "../src/host.ts";
import { cleanEvent, UnifloAdapter } from "../src/uniflo.ts";

const S = "claude:aaaaaaaa-0000-0000-0000-000000000001";

/** A Uniflo daemon: a session list, an events page and a live stream the test writes to. */
async function fakeUniflo() {
  const streams: ServerResponse[] = [];
  let page: unknown[] = [];
  let lists = 0;
  let pages = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/v1/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      streams.push(res);
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/health") return res.end(JSON.stringify({ ok: true }));
    if (url.pathname === "/v1/sessions") {
      lists++;
      return res.end(JSON.stringify([{ key: S, harness: "claude", updated_at: 1, status: "work", cwd: "/w" }]));
    }
    if (url.pathname === `/v1/sessions/${encodeURIComponent(S)}/events` || url.pathname === `/v1/sessions/${S}/events`) {
      pages++;
      return res.end(JSON.stringify({ events: page, next_before: null }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  let seq = 0;
  const push = (type: string, body: Record<string, unknown>) => {
    seq++;
    for (const s of streams) s.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ type, seq, ...body })}\n\n`);
  };
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    push,
    setPage: (p: unknown[]) => (page = p),
    lists: () => lists,
    pages: () => pages,
    connected: () => streams.filter((s) => !s.destroyed).length,
    dropStreams: () => {
      for (const s of streams.splice(0)) s.destroy();
    },
    close: () => {
      for (const s of streams) s.destroy();
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const until = async (what: string, ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const ev = (id: string, text: string) => ({ id, session: S, ts: 1, pos: 7, kind: "assistant_message", text });

test("Uniflo's live stream reaches a listener as the phone would get it; what can't go as is asks for a page read", async (t) => {
  const u = await fakeUniflo();
  const a = new UnifloAdapter(u.base);
  t.after(async () => {
    a.stop();
    await u.close();
  });
  const got: Array<unknown> = [];
  a.onEvents(S, (e) => got.push(e));
  a.start(() => {});
  await until("the stream", () => u.connected() === 1);
  u.push("hello", { version: 1 });
  await until("live", () => a.live);
  assert.deepEqual(got, [null], "coming up asks for one page read");

  u.push("event", { event: ev("e1#0", "hi") });
  u.push("event", { event: { id: "m:usage", session: S, ts: 1, kind: "usage", input: 1 } });
  u.push("event", { event: { ...ev("o1#0", "elsewhere"), session: "claude:other" } });
  u.push("event", { event: ev("e2#0", "长".repeat(3000)) });
  await until("two more", () => got.length === 3);
  assert.deepEqual(got[1], { ...ev("e1#0", "hi"), pos: "7" });
  assert.equal(got[2], null, "too long for the page to show it unchanged: read the page instead");

  // A session that appears (a fresh start, /clear) is matched within about a second, not at the next 8 s refresh.
  const before = u.lists();
  u.push("session", { session: { key: "claude:new", harness: "claude", updated_at: 2, status: "work" } });
  await until("a list read", () => u.lists() > before, 2000);

  // The stream goes away: the adapter says so, asks for a page read, and comes back on its own.
  u.dropStreams();
  await until("not live", () => !a.live);
  assert.equal(got.at(-1), null);
  await until("reconnected", () => u.connected() === 1, 4000);
});

type Frame = { type: string; id?: string; event?: any; result?: unknown; error?: unknown };

test("a conversation stream sends a pushed event at once and does not send it again from the page", async (t) => {
  const u = await fakeUniflo();
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  h.uniflo = new UnifloAdapter(u.base);
  h.sessionPollLiveMs = 60_000; // only the push and the reads it asks for
  const x = h as unknown as { agents: unknown[]; send: (f: Frame) => void; handleStreamSubscribe: (f: unknown) => Promise<void>; stopStream: (id: string) => void };
  x.agents = [{ key: "d/hc:t1", localId: "t1", source: "hc", deviceId: "d", status: "working", sessionKey: S }];
  const sent: Frame[] = [];
  x.send = (f) => sent.push(f);
  t.after(async () => {
    h.stop();
    await u.close();
  });
  h.uniflo.start(() => {});
  await until("the stream", () => u.connected() === 1);
  u.push("hello", { version: 1 });
  await until("live", () => h.uniflo.live);

  u.setPage([ev("e0#0", "before")]);
  await x.handleStreamSubscribe({ type: "stream_subscribe", id: "s1", from: "phone", stream: "session", params: { agent: "d/hc:t1" } });
  const events = () => sent.filter((f) => f.type === "stream_event" && f.event?.kind === "session").map((f) => f.event.event);
  await until("the first page", () => events().length === 1);
  assert.ok(sent.some((f) => f.type === "stream_open" && !f.error));

  const pagesBefore = u.pages();
  u.push("event", { event: ev("e1#0", "now") });
  await until("the pushed event", () => events().length === 2);
  assert.equal(events()[1].text, "now");
  assert.equal(u.pages(), pagesBefore, "a pushed event needs no page read");

  // The page catches up later with the same event: nothing is sent twice.
  u.setPage([ev("e0#0", "before"), ev("e1#0", "now")]);
  u.push("event", { event: ev("e2#0", "长".repeat(3000)) });
  await until("a page read", () => u.pages() > pagesBefore);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(events().map((e) => e.id), ["e0#0", "e1#0"]);

  // Unsubscribed: no more listeners, no more reads.
  x.stopStream("s1");
  const n = u.pages();
  u.push("event", { event: ev("e3#0", "late") });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(u.pages(), n);
  assert.equal(events().length, 2);
});

test("UnifloAdapter.enrich populates model and thinkingLevel from s.source transcript when s.model is undefined and refreshes on updated_at", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-uniflo-enrich-"));
  try {
    const transcript = join(dir, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "USER_INPUT", content: "hello" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", content: "world" }),
      ].join("\n") + "\n",
    );

    const now = Date.now();
    const adapter = new UnifloAdapter("http://127.0.0.1:9");
    adapter.sessions = [
      {
        key: "antigravity:74bb761a-1234-4567-89ab-cdef01234567",
        harness: "antigravity",
        cwd: "/tmp/proj",
        model: undefined,
        source: transcript,
        updated_at: now,
        status: "idle",
      },
    ];

    const baseAgent: Agent = {
      key: "d/hc:t1s",
      deviceId: "d",
      source: "hc",
      localId: "t1s",
      harness: "antigravity",
      cwd: "/tmp/proj",
      status: "idle",
      isShell: false,
      updatedAt: now - 50,
    };

    const enriched1 = adapter.enrich([baseAgent], new Map());
    assert.equal(enriched1[0]?.model, "gemini-4-neon-high");
    assert.equal(enriched1[0]?.thinkingLevel, "high");

    // Updated file with same updated_at stays cached, then refreshes once updated_at advances
    writeFileSync(
      transcript,
      JSON.stringify({ type: "PLANNER_RESPONSE", model: "gemini-4-neon-xhigh", content: "next" }) + "\n",
    );
    const cached = adapter.enrich([baseAgent], new Map());
    assert.equal(cached[0]?.model, "gemini-4-neon-high");
    assert.equal(cached[0]?.thinkingLevel, "high");

    adapter.sessions[0]!.updated_at = now + 100;
    const refreshed = adapter.enrich([baseAgent], new Map());
    assert.equal(refreshed[0]?.model, "gemini-4-neon-xhigh");
    assert.equal(refreshed[0]?.thinkingLevel, "xhigh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanEvent parses model switch XML commands and drops empty local-command-stdout noise", () => {
  const modelCmd = cleanEvent({
    id: "m1",
    session: S,
    ts: 1000,
    kind: "user_message",
    text: "<command-name>/model</command-name>\n<command-args>gpt-6.2-sol</command-args>",
  });
  assert.ok(modelCmd);
  assert.equal(modelCmd.kind, "system");
  if (modelCmd.kind === "system") {
    assert.equal(modelCmd.subtype, "model_switch");
    assert.equal(modelCmd.summary, "已切换模型为 gpt-6.2-sol");
  }

  const emptyStdout = cleanEvent({
    id: "m2",
    session: S,
    ts: 1001,
    kind: "user_message",
    text: "<local-command-stdout>  \u001b[0m  </local-command-stdout>",
  });
  assert.equal(emptyStdout, null);

  const otherCmd = cleanEvent({
    id: "m3",
    session: S,
    ts: 1002,
    kind: "user_message",
    text: "<command-name>/compact</command-name>",
  });
  assert.ok(otherCmd);
  assert.equal(otherCmd.kind, "system");
  if (otherCmd.kind === "system") {
    assert.equal(otherCmd.summary, "命令 /compact");
  }
});
