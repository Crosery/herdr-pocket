import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AssistantItem, Device } from "@herdr-pocket/protocol";
import { Assistant, type AssistantHost } from "../src/assistant/assistant.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";
import { Store } from "../src/store.ts";

const now = Date.now();
const devices: Device[] = [{ id: "d1", name: "Mac R", kind: "host", platform: "darwin", online: true, createdAt: now, lastSeenAt: now }];
const agents: Agent[] = [
  { key: "d1/hc:t1", deviceId: "d1", source: "hc", localId: "t1", harness: "claude-code", title: "上线检查", status: "blocked", isShell: false, updatedAt: now, sessionKey: "claude:t1" },
];
const host: AssistantHost = {
  devices: () => devices,
  agents: () => agents,
  toViewers: () => {},
  log: () => {},
  call: (async (_device: string, method: string, params: unknown) => {
    hostCalls.push(method);
    if (method === "session.events") return { sessionKey: "claude:t1", more: false, events: [{ id: "1", session: "claude:t1", ts: now, kind: "assistant_message", text: "要删掉 dist 目录再重新打包，等你确认。" }] };
    if (method === "terminal.read") return { text: "删除 dist？(y/n)\n> " };
    if (method === "terminal.send") return { ok: true, position: 0, agentStatus: "blocked", waiting: false };
    if (method === "terminal.keys") return { ok: true, params };
    throw new Error(`not in this test: ${method}`);
  }) as AssistantHost["call"],
};
const hostCalls: string[] = [];

const text = (t: string): LlmResult => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", model: "test" });
const look = (): LlmResult => ({ content: [{ type: "tool_use", id: `c${Math.random().toString(36).slice(2, 7)}`, name: "read_agent", input: { agent: "d1/hc:t1" } }], stopReason: "tool_use", model: "test" });
/** The text the relay added to the last message: the "last look" and "out of rounds" lines. */
const said = (req: LlmRequest) => {
  const last = req.messages[req.messages.length - 1]!;
  return Array.isArray(last.content) ? last.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n") : String(last.content);
};

function make(answer: (req: LlmRequest) => LlmResult) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-rounds-"));
  const asked: LlmRequest[] = [];
  const llm: Llm = async (req) => {
    // The relay keeps adding to the same list; a copy is what the model saw at that moment.
    asked.push({ ...req, messages: req.messages.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content })) });
    return answer(req);
  };
  const a = new Assistant({ store: new Store(join(dir, "a.db")), host, llm, confirm: "never", promptEpoch: 0 });
  return {
    a,
    asked,
    done: () => {
      a.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function chat(a: Assistant, q: string): Promise<AssistantItem> {
  a.say(q);
  await new Promise((r) => setTimeout(r, 20));
  while (a.state().busy) await new Promise((r) => setTimeout(r, 10));
  return a.state().items.filter((x) => x.role === "assistant").pop()!;
}

test("a chat that uses every round is answered from what was found, not with a stock line", async () => {
  const { a, asked, done } = make((req) => (/查的次数用完了/.test(said(req)) ? text("上线检查在等你确认删 dist 目录，别的还没查到。") : look()));
  const answer = await chat(a, "上线检查到底卡在哪？");
  assert.equal(answer.text, "上线检查在等你确认删 dist 目录，别的还没查到。");
  // Twelve looks, then one answer.
  assert.equal(asked.length, 13);
  assert.match(said(asked[11]!), /这是最后一次查看/);
  assert.doesNotMatch(said(asked[10]!), /这是最后一次查看/);
  // The tools stay declared: the history holds tool calls.
  assert.ok(asked[12]!.tools.length > 0);
  done();
});

test("when even the last answer fails, the stock line still comes", async () => {
  const { a, done } = make((req) => {
    if (/查的次数用完了/.test(said(req))) throw new Error("model down");
    return look();
  });
  const answer = await chat(a, "上线检查到底卡在哪？");
  assert.match(answer.text, /^查了几轮还没理清。/);
  done();
});

test("acting at once on an agent not read this turn: read it first, hold once, then act", async () => {
  const send = { type: "tool_use" as const, name: "send_to_agent", input: { agent: "上线检查", text: "可以删" } };
  const keys = { type: "tool_use" as const, name: "press_keys", input: { agent: "上线检查", keys: ["y"] } };
  const step = (b: typeof send | typeof keys): LlmResult => ({ content: [{ ...b, id: `c${Math.random().toString(36).slice(2, 7)}` }], stopReason: "tool_use", model: "test" });
  const results = (req: LlmRequest) => req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === "tool_result" ? [String(b.content)] : [])) : []));

  // Sent without a look: the first call reads the conversation and sends nothing; the same call again sends.
  hostCalls.length = 0;
  let m = make((req) => (results(req).length < 2 ? step(send) : text("发了。")));
  await chat(m.a, "跟上线检查说可以删");
  let seen = results(m.asked[m.asked.length - 1]!);
  assert.match(seen[0]!, /^还没发：先核对是不是它。\n[\s\S]*上线检查[\s\S]*要删掉 dist 目录再重新打包/);
  assert.match(seen[1]!, /^办了：给「上线检查」发送：可以删/);
  assert.deepEqual(hostCalls, ["session.events", "terminal.send"]);
  m.done();

  // Read first: nothing is held.
  hostCalls.length = 0;
  m = make((req) => (results(req).length === 0 ? look() : results(req).length === 1 ? step(send) : text("发了。")));
  await chat(m.a, "跟上线检查说可以删");
  seen = results(m.asked[m.asked.length - 1]!);
  assert.match(seen[1]!, /^办了：/);
  assert.deepEqual(hostCalls, ["session.events", "terminal.send"]);
  m.done();

  // Keys without a look: the terminal is read first.
  hostCalls.length = 0;
  m = make((req) => (results(req).length < 2 ? step(keys) : text("按了。")));
  await chat(m.a, "帮上线检查按 y");
  seen = results(m.asked[m.asked.length - 1]!);
  assert.match(seen[0]!, /^还没按：先核对是不是它。\n[\s\S]*删除 dist？\(y\/n\)/);
  assert.match(seen[1]!, /^办了：在「上线检查」按 y/);
  assert.deepEqual(hostCalls, ["terminal.read", "terminal.keys"]);
  m.done();
});

test("a call task always brings notes back: from the model, or from what the tools found", async () => {
  // The model forgets the notes: the voice still gets what was read.
  let m = make((req) => (Array.isArray(req.messages[req.messages.length - 1]!.content) ? text("它在等你确认删一个目录。") : look()));
  let s = await m.a.delegate("上线检查怎么了", [], new AbortController().signal);
  assert.equal(s.say, "它在等你确认删一个目录。");
  assert.match(s.keep, /要删掉 dist 目录再重新打包/);
  m.done();

  // Notes the model wrote are kept as written.
  m = make((req) => (Array.isArray(req.messages[req.messages.length - 1]!.content) ? text("它在等你确认删一个目录。\n---\n上线检查：想删 dist") : look()));
  s = await m.a.delegate("上线检查怎么了", [], new AbortController().signal);
  assert.equal(s.keep, "上线检查：想删 dist");
  m.done();

  // Out of rounds in a call: the answer comes in the call's format, from what was found.
  m = make((req) => (/查的次数用完了/.test(said(req)) ? text("它在等你确认删一个目录。\n---\n上线检查：想删 dist，等了一会儿") : look()));
  s = await m.a.delegate("上线检查怎么了", [], new AbortController().signal);
  assert.equal(m.asked.length, 9);
  assert.match(said(m.asked[8]!), /台词 \/ --- \/ 备查/);
  assert.equal(s.say, "它在等你确认删一个目录。");
  assert.equal(s.keep, "上线检查：想删 dist，等了一会儿");
  m.done();
});
