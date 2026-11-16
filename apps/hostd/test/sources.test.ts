import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Host } from "../src/host.ts";

/** A host whose sources answer as told, with the relay link faked. */
function host(up: { hc: boolean; herdr: boolean; uniflo: boolean }) {
  const lines: string[] = [];
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: (m) => lines.push(m) });
  const x = h as unknown as { send: (f: unknown) => void; publishNow: () => void };
  const sent: Array<{ type: string; sources?: string[] }> = [];
  x.send = (f) => sent.push(structuredClone(f) as { type: string; sources?: string[] });
  x.publishNow = () => {};
  Object.defineProperty(h, "connected", { get: () => true });
  h.hc.available = async () => up.hc;
  h.hc.start = () => {};
  h.herdr.available = async () => up.herdr;
  h.herdr.start = () => {};
  let unifloStarts = 0;
  h.uniflo.available = async () => up.uniflo;
  h.uniflo.start = () => void unifloStarts++;
  return { h, lines, sent, unifloStarts: () => unifloStarts };
}

test("Uniflo that starts after the daemon is picked up, and the relay is told", async () => {
  const up = { hc: true, herdr: false, uniflo: false };
  const { h, lines, sent, unifloStarts } = host(up);
  h.app.names = async () => ({ spaces: new Map(), tabs: new Map() }) as never;

  await h.findSources();
  assert.deepEqual(h.sources, ["hc"]);
  assert.match(lines.join("\n"), /uniflo ✗/);
  assert.equal(sent.length, 0, "the first look only logs; hello goes out when the link opens");

  // A reboot: Uniflo comes up a minute later.
  up.uniflo = true;
  await h.findSources();
  assert.deepEqual(h.sources, ["hc", "uniflo"]);
  assert.equal(unifloStarts(), 1);
  assert.match(lines.at(-1)!, /source came up: uniflo/);
  const hello = sent.find((f) => f.type === "hello");
  assert.ok(hello, "a second hello updates the device's sources on the relay");
  assert.deepEqual(hello.sources, ["hc", "uniflo"]);

  // Nothing new: no more hellos, and a source already on is not started twice.
  await h.findSources();
  assert.equal(unifloStarts(), 1);
  assert.equal(sent.filter((f) => f.type === "hello").length, 1);
  h.stop();
});

test("a source is not probed again once it is on", async () => {
  const { h } = host({ hc: false, herdr: false, uniflo: true });
  let probes = 0;
  const probe = h.uniflo.available.bind(h.uniflo);
  h.uniflo.available = async () => {
    probes++;
    return probe();
  };
  await h.findSources();
  await h.findSources();
  assert.equal(probes, 1);
  assert.deepEqual(h.sources, ["uniflo"]);
  h.stop();
});
