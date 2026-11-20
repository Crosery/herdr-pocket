import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import { defaultClientConfig } from "@herdr-pocket/protocol";

// Nothing here reaches the network, this machine's state folder or its config.json.
const home = mkdtempSync(join(tmpdir(), "hp-upstream-"));
process.env.HERDR_POCKET_HOME = home;
process.env.HERDR_POCKET_STATE = join(home, "state");
const up = await import("../src/upstream.ts");
const { HcAdapter } = await import("../src/hc.ts");
const { Host } = await import("../src/host.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const SH = { skip: process.platform === "win32" && "shell-script fakes" };
const NOW = 1_800_000_000_000;

/** Stubbed release server and `uniflo update --check --json`; records what was asked. */
function stubs(o: { core?: unknown; app?: unknown; uniflo?: { code: number | null; out: unknown } | Error; offline?: boolean } = {}) {
  const urls: string[] = [];
  const runs: string[] = [];
  const deps = {
    env: {} as NodeJS.ProcessEnv,
    now: () => NOW,
    fetchText: async (url: string, timeoutMs: number) => {
      urls.push(url);
      assert.equal(timeoutMs, up.UPSTREAM_REQUEST_MS);
      if (o.offline) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      const body = url.endsWith("/core/latest.json") ? o.core : o.app;
      if (body === undefined) throw new Error("HTTP 404");
      return JSON.stringify(body);
    },
    runCheck: async (cmd: string, args: string[], timeoutMs: number) => {
      runs.push(`${cmd} ${args.join(" ")} ${timeoutMs}`);
      if (o.offline || o.uniflo instanceof Error) throw o.uniflo instanceof Error ? o.uniflo : new Error("spawn uniflo ENOENT");
      const u = o.uniflo ?? { code: 0, out: { current: "0.2.8", latest: "0.2.8", available: false, error: null, method: "cargo" } };
      return { code: u.code, stdout: JSON.stringify(u.out) };
    },
  };
  return { deps, urls, runs };
}

describe("upstream check", () => {
  test("a newer core of the installed generation, the app and uniflo (exit 10) are all reported", async () => {
    const { deps, urls, runs } = stubs({
      core: { version: "0.1.22", generation: 1, targets: {} },
      app: { version: "0.1.16" },
      uniflo: { code: 10, out: { current: "0.2.8", latest: "0.2.9", available: true, error: null, method: "cargo" } },
    });
    const r = await up.checkUpstream({ hc: "0.1.21", hcGeneration: 1, app: "0.1.16", uniflo: "0.2.8" }, undefined, deps);
    assert.deepEqual(r.latest, { hc: "0.1.22", app: "0.1.16", uniflo: "0.2.9", checkedAt: NOW });
    assert.deepEqual(urls, ["https://releases.herdr.dev/core/latest.json", "https://releases.herdr.dev/app/latest.json"]);
    assert.deepEqual(runs, ["uniflo update --check --json 10000"]);
    assert.deepEqual(r.uniflo, { current: "0.2.8", method: "cargo" });
    assert.equal(r.level, "info");
    assert.equal(r.message, "upstream check in 0 ms: hc 0.1.21 -> 0.1.22 · Herdr app 0.1.16 (latest) · uniflo 0.2.8 -> 0.2.9 via cargo");
  });

  test("a core of another generation is never offered; the older answer stays", async () => {
    const { deps } = stubs({ core: { version: "0.2.0", generation: 2 } });
    const r = await up.checkUpstream({ hc: "0.1.21", hcGeneration: 1 }, { hc: "0.1.21", checkedAt: 5 }, deps);
    assert.deepEqual(r.latest, { hc: "0.1.21", checkedAt: 5 });
    assert.equal(r.answered, 0);
    assert.match(r.message, /latest 0\.2\.0 is generation 2, this core speaks 1/);
    // No generation in the manifest, or an unknown one here: the same (as in Herdr's app).
    for (const [core, gen] of [[{ version: "0.1.22" }, 1], [{ version: "0.1.22", generation: 1 }, undefined]] as const) {
      const s = stubs({ core });
      assert.equal((await up.checkUpstream({ hc: "0.1.21", hcGeneration: gen }, undefined, s.deps)).latest.hc, undefined);
    }
  });

  test("offline: nothing answers, nothing is lost, and it is only a debug line", async () => {
    const { deps } = stubs({ offline: true });
    const before = { hc: "0.1.22", app: "0.1.16", uniflo: "0.2.9", checkedAt: 7 };
    const r = await up.checkUpstream({ hc: "0.1.21", hcGeneration: 1, app: "0.1.16", uniflo: "0.2.8" }, before, deps);
    assert.deepEqual(r.latest, before);
    assert.equal(r.level, "debug");
    assert.match(r.message, /hc 0\.1\.21 \(no answer: timed out\)/);
    assert.match(r.message, /uniflo 0\.2\.8 \(no answer: spawn uniflo ENOENT\)/);
  });

  test("uniflo's own error, an odd exit code, and programs that are not installed", async () => {
    let s = stubs({ uniflo: { code: 0, out: { current: "0.2.8", latest: null, error: "crates.io: 503", method: "binary" } } });
    let r = await up.checkUpstream({ uniflo: "0.2.8" }, undefined, s.deps);
    assert.equal(r.latest.uniflo, undefined);
    assert.match(r.message, /uniflo 0\.2\.8 \(no answer: crates\.io: 503\)/);
    s = stubs({ uniflo: { code: 2, out: {} } });
    r = await up.checkUpstream({ uniflo: "0.2.8" }, undefined, s.deps);
    assert.match(r.message, /exited 2/);
    // The path findPrograms resolved is the one run.
    s = stubs();
    await up.checkUpstream({ uniflo: "0.2.8", unifloBin: "/opt/u/bin/uniflo" }, undefined, s.deps);
    assert.deepEqual(s.runs, ["/opt/u/bin/uniflo update --check --json 10000"]);

    // Not installed: not asked, and an older answer for it is dropped.
    s = stubs({ core: { version: "0.1.22", generation: 1 } });
    r = await up.checkUpstream({}, { hc: "0.1.22", uniflo: "0.2.9", checkedAt: 3 }, s.deps);
    assert.deepEqual([s.urls, s.runs, r.latest, r.asked], [[], [], { checkedAt: 3 }, 0]);
    assert.match(r.message, /none of hc, the Herdr app and uniflo is installed/);
  });

  test("HERDR_RELEASES_URL is the release server, a file:// folder included", async () => {
    const s = stubs({ core: { version: "0.1.22", generation: 1 } });
    s.deps.env = { HERDR_RELEASES_URL: "https://releases.example.com/" };
    await up.checkUpstream({ hc: "0.1.21", hcGeneration: 1 }, undefined, s.deps);
    assert.deepEqual(s.urls, ["https://releases.example.com/core/latest.json"]);

    const dir = join(home, "releases");
    mkdirSync(join(dir, "core"), { recursive: true });
    writeFileSync(join(dir, "core", "latest.json"), '{"version":"0.1.30","generation":1}');
    const r = await up.checkUpstream({ hc: "0.1.21", hcGeneration: 1 }, undefined, { env: { HERDR_RELEASES_URL: pathToFileURL(dir).href } });
    assert.equal(r.latest.hc, "0.1.30");
  });
});

describe("upstream settings, cache and status line", () => {
  test("HERDR_POCKET_UPDATE_CHECK=0, update.autoCheck or update.checkTools off it", () => {
    const c = defaultClientConfig();
    assert.equal(c.update.checkTools, true);
    assert.equal(up.upstreamCheckEnabled({}, c), true);
    assert.equal(up.upstreamCheckEnabled({ HERDR_POCKET_UPDATE_CHECK: "0" }, c), false);
    assert.equal(up.upstreamCheckEnabled({}, { ...c, update: { ...c.update, checkTools: false } }), false);
    assert.equal(up.upstreamCheckEnabled({}, { ...c, update: { ...c.update, autoCheck: false } }), false);
  });

  test("never under node --test; a test's own `enabled` runs it, and stop stops it", async () => {
    let calls = 0;
    const check = async () => void calls++;
    assert.ok(process.env.NODE_TEST_CONTEXT, "node --test sets NODE_TEST_CONTEXT");
    up.watchUpstream(check, { firstMs: 0 })();
    const stop = up.watchUpstream(check, { firstMs: 0, everyMs: () => 5, enabled: () => true });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    const seen = calls;
    assert.ok(seen >= 2, `ran ${seen} times`);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, seen, "nothing after stop");
    up.watchUpstream(check, { firstMs: 0, enabled: () => false, everyMs: () => 1000 })();
    assert.equal(calls, seen);
  });

  test("the cache file round-trips; a broken one reads as none", () => {
    const path = join(home, "state", "upstream.json");
    assert.equal(up.upstreamCachePath(), path);
    assert.equal(up.readUpstreamCache(path), undefined);
    assert.ok(up.writeUpstreamCache({ latest: { hc: "0.1.22", checkedAt: 9 }, have: { hc: "0.1.21" } }, path));
    assert.deepEqual(up.readUpstreamCache(path), { latest: { hc: "0.1.22", checkedAt: 9 }, have: { hc: "0.1.21" } });
    writeFileSync(path, "{nope");
    assert.equal(up.readUpstreamCache(path), undefined);
  });

  test("status line: 未检查 before any answer, then 可更新 / 最新 per program", () => {
    assert.equal(up.upstreamLine(undefined), "未检查");
    assert.equal(up.upstreamLine({ hc: "0.1.21" }), "未检查");
    assert.equal(up.upstreamLine({ hc: "0.1.21" }, false), "未检查（自动检查已关闭）");
    assert.equal(
      up.upstreamLine({ hc: "0.1.21", uniflo: "0.2.8", app: "0.1.16", herdr: "0.9.5", latest: { hc: "0.1.22", uniflo: "0.2.8", checkedAt: 1 } }),
      "hc 0.1.21 → 0.1.22 可更新 · Herdr app 0.1.16 (未检查) · uniflo 0.2.8 (最新)",
    );
    // Updated since the check: the installed one is not older any more.
    assert.equal(up.upstreamLine({ hc: "0.1.22", latest: { hc: "0.1.22", checkedAt: 1 } }), "hc 0.1.22 (最新)");
  });
});

describe("what is installed", () => {
  test("the Herdr app's version: its Info.plist, or `herdr-app --version`", SH, async () => {
    const plist = join(home, "Herdr.app", "Contents", "Info.plist");
    mkdirSync(join(home, "Herdr.app", "Contents"), { recursive: true });
    writeFileSync(plist, '<?xml version="1.0"?>\n<plist><dict><key>CFBundleShortVersionString</key>\n  <string>0.1.16</string></dict></plist>\n');
    assert.equal(await up.herdrAppVersion([join(home, "missing", "Info.plist"), plist]), "0.1.16");

    const exe = join(home, "herdr-app");
    writeFileSync(exe, "#!/bin/sh\necho 'herdr-app 0.1.17'\n");
    chmodSync(exe, 0o755);
    assert.equal(await up.herdrAppVersion([exe]), "0.1.17");
    assert.equal(await up.herdrAppVersion([join(home, "nothing")]), undefined);

    assert.deepEqual(up.herdrAppPlaces("linux", "/home/u", { XDG_DATA_HOME: "/data" }), ["/data/herdr-app/herdr-app"]);
    assert.deepEqual(up.herdrAppPlaces("darwin", "/Users/u", {}), ["/Applications/Herdr.app/Contents/Info.plist", "/Users/u/Applications/Herdr.app/Contents/Info.plist"]);
  });

  test("hc hello over a connection of its own: version and generation; silence times out", SH, async () => {
    const fake = (answer: boolean) => {
      const bin = join(home, answer ? "hc-hello" : "hc-mute");
      writeFileSync(
        bin,
        `#!/usr/bin/env node
process.stdin.on("data", (d) => {
  const msg = JSON.parse(String(d).split("\\n")[0]);
  ${answer ? `if (msg.method === "hello") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { version: "0.1.22", generation: 1, framed: false } }) + "\\n");` : ""}
});
`,
      );
      chmodSync(bin, 0o755);
      return bin;
    };
    const hc = new HcAdapter(fake(true));
    hc.version = "0.1.21";
    assert.deepEqual(await hc.hello(), { version: "0.1.22", generation: 1 });
    assert.equal(hc.version, "0.1.22", "the running core's version replaces the startup one");
    const t0 = Date.now();
    assert.equal(await new HcAdapter(fake(false)).hello(300), undefined);
    assert.ok(Date.now() - t0 < 3000);
  });

  test("Host.checkUpstream: one update line, host.info tools carry `latest`, the cache is written", async () => {
    const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
    const hc = (h as unknown as { hc: InstanceType<typeof HcAdapter> }).hc;
    hc.version = "0.1.21";
    hc.hello = async () => ({ version: "0.1.21", generation: 1 });
    const cachePath = join(home, "state", "host-upstream.json");
    const { deps } = stubs({ core: { version: "0.1.22", generation: 1 }, app: { version: "0.1.16" } });
    await h.checkUpstream({ ...deps, cachePath, appVersion: async () => "0.1.15" });
    assert.deepEqual(h.tools(), { hc: "0.1.21", app: "0.1.15", latest: { hc: "0.1.22", app: "0.1.16", checkedAt: NOW } });
    assert.deepEqual(JSON.parse(readFileSync(cachePath, "utf8")), { latest: { hc: "0.1.22", app: "0.1.16", checkedAt: NOW }, have: { hc: "0.1.21", app: "0.1.15" } });
    const lines = h.logs.take().filter((e) => e.kind === "update");
    assert.equal(lines.length, 1);
    assert.match(lines[0]!.msg, /^upstream check in \d+ ms: hc 0\.1\.21 -> 0\.1\.22 · Herdr app 0\.1\.15 -> 0\.1\.16$/);
    assert.equal(up.upstreamLine(h.tools()), "hc 0.1.21 → 0.1.22 可更新 · Herdr app 0.1.15 → 0.1.16 可更新");
  });

  test("uniflo only in ~/.cargo/bin, not on the service's PATH: found, versioned and asked by its full path", SH, async () => {
    // launchd's PATH (no ~/.cargo/bin) and a shell probe that fails: only the folder scan finds it.
    const fakeHome = mkdtempSync(join(tmpdir(), "hp-cargo-"));
    const bin = join(fakeHome, ".cargo", "bin");
    mkdirSync(bin, { recursive: true });
    const uniflo = join(bin, "uniflo");
    writeFileSync(
      uniflo,
      `#!/bin/sh
case "$1" in
  --version) echo "uniflo 0.2.8" ;;
  update) echo '{"current":"0.2.8","latest":"0.2.9","available":true,"error":null,"method":"cargo"}'; exit 10 ;;
esac
`,
    );
    chmodSync(uniflo, 0o755);
    const saved = { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: process.env.PATH };
    process.env.HOME = fakeHome;
    process.env.SHELL = "/usr/bin/false";
    process.env.PATH = "/usr/bin:/bin";
    try {
      const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "d", name: "test" }, log: () => {} });
      await (h as unknown as { lookUpTools(): Promise<void> }).lookUpTools();
      assert.equal(h.tools().uniflo, "0.2.8", "`uniflo --version` ran by its full path");
      h.logs.take();
      // The real runner this time: only the resolved path can work with this PATH.
      await h.checkUpstream({ cachePath: join(fakeHome, "upstream.json"), appVersion: async () => undefined });
      assert.equal(h.tools().latest?.uniflo, "0.2.9");
      const line = h.logs.take().find((e) => e.kind === "update")!;
      assert.match(line.msg, /uniflo 0\.2\.8 -> 0\.2\.9 via cargo/);
    } finally {
      Object.assign(process.env, saved);
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
