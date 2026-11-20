import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Agent } from "@herdr-pocket/protocol";

// This machine's own config.json is never read or written here.
const home = mkdtempSync(join(tmpdir(), "hp-settings-"));
process.env.HERDR_POCKET_HOME = home;
const { Host } = await import("../src/host.ts");
const { setClientConfigValue } = await import("@herdr-pocket/update");

after(() => rmSync(home, { recursive: true, force: true }));

type Handlers = Record<string, (p: unknown, from: string) => Promise<any>>;

function host() {
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
  return { h, call: (m: string, p: unknown) => (h as unknown as { handlers: Handlers }).handlers[m]!(p, "phone") };
}

test("logging.level and logging.upload from config.json; changes are logged with old and new values", () => {
  const { h } = host();
  h.note("debug", "files", "dropped at the default level");
  h.note("info", "x", "kept");
  assert.deepEqual(h.logs.take().map((e) => e.msg), ["kept"]);

  setClientConfigValue("logging.level", "debug");
  h.checkSettings();
  const changed = h.logs.take();
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.kind, "config");
  assert.match(changed[0]!.msg, /logging\.level "info" -> "debug"/);
  h.note("debug", "files", "now kept");
  assert.deepEqual(h.logs.take().map((e) => e.msg), ["now kept"]);

  // Nothing new: nothing logged.
  h.checkSettings();
  assert.equal(h.logs.size, 0);

  writeFileSync(join(home, "config.json"), '{"version":1,"logging":{"level":"loud"}}');
  h.checkSettings();
  const lines = h.logs.take().map((e) => `${e.level} ${e.msg}`);
  assert.ok(lines.some((l) => /^info config.json changed: logging\.level "debug" -> "info"/.test(l)));
  assert.ok(lines.some((l) => /^warn config.json has problems: logging\.level/.test(l)));
  rmSync(join(home, "config.json"));
  h.checkSettings();
  h.logs.take();
});

test("files.list / files.read go through the agent's working folder; host.info says it can", async () => {
  const { h, call } = host();
  const cwd = mkdtempSync(join(tmpdir(), "hp-agent-cwd-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "main.rs"), "fn main() {}\n");
  const agent: Agent = { key: "d/hc:t1", deviceId: "d", source: "hc", localId: "t1", harness: "codex", status: "idle", isShell: false, cwd, updatedAt: Date.now() };
  h.agents = [agent];
  try {
    const list = await call("files.list", { agent: "d/hc:t1" });
    assert.deepEqual(list.entries.map((e: { path: string }) => e.path), ["src"]);
    const file = await call("files.read", { agent: "d/hc:t1", path: "src/main.rs" });
    assert.deepEqual([file.text, file.language], ["fn main() {}\n", "rs"]);
    await assert.rejects(call("files.read", { agent: "d/hc:t1", path: "../x" }), (e: Error & { code?: string }) => e.code === "forbidden");
    await assert.rejects(call("files.list", { agent: "d/hc:t9" }), (e: Error & { code?: string }) => e.code === "not_found");
    h.agents = [{ ...agent, cwd: undefined }];
    await assert.rejects(call("files.list", { agent: "d/hc:t1" }), (e: Error & { code?: string }) => e.code === "not_found");
    const info = await call("host.info", {});
    assert.equal(info.files, true);
    assert.equal(typeof info.tools, "object");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
