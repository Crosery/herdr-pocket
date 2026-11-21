import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  CLIENT_CONFIG_KEYS,
  DIRECT_SOURCE,
  HOTKEY_SOLO_KEYS,
  cachedWinner,
  configKeySpec,
  decideRegion,
  defaultClientConfig,
  isMirrorPrefix,
  parseClientConfig,
  parseConfigText,
  pickFastest,
  pickLowestLatency,
  sourceLabel,
  sourcePrefixes,
  updateCheckDelays,
  withConfigValue,
  withJitter,
  withWinnerFirst,
} from "@herdr-pocket/protocol";

// Never read or write this machine's own files.
const home = mkdtempSync(join(tmpdir(), "hp-cfg-home-"));
const state = mkdtempSync(join(tmpdir(), "hp-cfg-state-"));
process.env.HERDR_POCKET_HOME = home;
process.env.HERDR_POCKET_STATE = state;
delete process.env.HERDR_POCKET_MIRROR;
const { clientConfigPath, configDir, raceSources, readClientConfig, setClientConfigValue, sourcePlan, stateDir, writeSourceCache, sourcesFor } = await import("../src/index.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const GH = "https://github.com/o/r/releases/latest/download/SHA256SUMS";

describe("config file schema", () => {
  test("defaults come from the key list; every key has a Chinese label and a known section", () => {
    const d = defaultClientConfig();
    assert.equal(d.version, 1);
    assert.equal(d.update.region, "auto");
    assert.equal(d.update.preferredSource, "auto");
    assert.equal(d.update.checkIntervalHours, 0.5);
    assert.deepEqual(d.update.mirrors, []);
    assert.equal(d.voiceInput.hotkey, "CommandOrControl+Shift+Space");
    assert.deepEqual([d.general.textScale, d.general.showShells, d.voiceInput.denoise], [100, false, true]);
    // Off by default: a closed window quits, and nothing starts or stays hidden unasked.
    assert.deepEqual([d.general.launchAtLogin, d.general.closeToTray], [false, false]);
    // Reserved: still a valid key, but no program reads it (the desktop app hides it).
    assert.deepEqual(configKeySpec("voiceInput.denoise")?.usedBy, []);
    for (const s of CLIENT_CONFIG_KEYS) {
      assert.match(s.label, /[一-鿿]/, s.key);
      assert.ok(Object.keys(d).includes(s.key.split(".")[0]!), s.key);
    }
    assert.equal(new Set(CLIENT_CONFIG_KEYS.map((s) => s.key)).size, CLIENT_CONFIG_KEYS.length);
  });

  test("bad values fall back to defaults and are reported; unknown keys are kept; secrets are flagged", () => {
    const { config, problems } = parseClientConfig({
      version: 1,
      update: { region: "mars", preferredSource: "invalid", checkIntervalHours: 0.1, mirrors: ["https://m.example.com/"], future: 1 },
      voiceInput: { hotkey: "Space", maxSeconds: 90 },
      logging: { level: "debug" },
      relay: { token: "hp_xxx" },
    });
    assert.equal(config.update.region, "auto");
    assert.equal(config.update.preferredSource, "auto");
    assert.equal(config.update.checkIntervalHours, 0.5);
    assert.deepEqual(config.update.mirrors, ["https://m.example.com/"]);
    assert.equal(config.voiceInput.hotkey, "CommandOrControl+Shift+Space");
    assert.equal(config.voiceInput.maxSeconds, 90);
    assert.equal(config.logging.level, "debug");
    const keys = problems.map((p) => `${p.level}:${p.key}`);
    assert.ok(keys.includes("error:update.region"));
    assert.ok(keys.includes("error:update.preferredSource"));
    assert.ok(keys.includes("error:update.checkIntervalHours"));
    assert.ok(keys.includes("warn:update.future"));
    assert.ok(keys.includes("error:voiceInput.hotkey"));
    assert.ok(keys.includes("warn:relay"));
    assert.ok(keys.includes("error:relay.token"), "a token anywhere in the file is flagged");
    assert.deepEqual(parseClientConfig("nope").problems.map((p) => p.level), ["error"]);
    assert.deepEqual(parseClientConfig(undefined).problems, []);
  });

  test("typed values: booleans, numbers, enums, lists, hotkeys, mirrors", () => {
    assert.deepEqual(parseConfigText("update.autoCheck", "off"), { value: false });
    assert.deepEqual(parseConfigText("update.checkIntervalHours", "0.25"), { value: 0.25 });
    assert.deepEqual(parseConfigText("update.checkIntervalHours", "0.5"), { value: 0.5 });
    assert.deepEqual(parseConfigText("update.checkIntervalHours", "48"), { value: 48 });
    assert.ok("error" in parseConfigText("update.checkIntervalHours", "0.1"));
    assert.deepEqual(parseConfigText("update.preferredSource", "auto"), { value: "auto" });
    assert.deepEqual(parseConfigText("update.preferredSource", "direct"), { value: "direct" });
    assert.deepEqual(parseConfigText("update.preferredSource", "https://ghfast.top/"), { value: "https://ghfast.top/" });
    assert.ok("error" in parseConfigText("update.preferredSource", "https://ghfast.top"));
    assert.ok("error" in parseConfigText("update.region", "moon"));
    assert.deepEqual(parseConfigText("update.mirrors", "https://a.example.com/, https://b.example.com/x/"), { value: ["https://a.example.com/", "https://b.example.com/x/"] });
    assert.deepEqual(parseConfigText("update.mirrors", '["http://127.0.0.1:8080/"]'), { value: ["http://127.0.0.1:8080/"] });
    assert.ok("error" in parseConfigText("update.mirrors", "http://mirror.example.com/"), "plain http only on this machine");
    assert.deepEqual(parseConfigText("update.mirrors", ""), { value: [] });
    assert.deepEqual(parseConfigText("voiceInput.hotkey", "Alt+Shift+KeyD"), { value: "Alt+Shift+KeyD" });
    assert.ok("error" in parseConfigText("voiceInput.hotkey", "F5"), "a hotkey needs a modifier");
    assert.deepEqual(parseConfigText("voiceInput.language", "zh"), { value: "zh" });
    assert.ok("error" in parseConfigText("nope.key", "1"));
    assert.equal(isMirrorPrefix("https://ghfast.top/"), true);
    assert.equal(isMirrorPrefix("https://ghfast.top"), false);
    assert.equal(configKeySpec("update.region")?.env, "HERDR_POCKET_MIRROR");
  });

  test("hotkeys: a shortcut with a modifier, or one modifier key alone; aliases stored under one name", () => {
    for (const [typed, stored] of [
      ["RightOption", "RightOption"],
      ["RightAlt", "RightOption"],
      ["rightalt", "RightOption"],
      ["RightControl", "RightControl"],
      ["RightCtrl", "RightControl"],
      ["RightCommand", "RightCommand"],
      ["RightShift", "RightShift"],
      ["fn", "Fn"],
      [" Alt + Space ", "Alt+Space"],
    ] as const) {
      assert.deepEqual(parseConfigText("voiceInput.hotkey", typed), { value: stored }, typed);
    }
    for (const bad of ["LeftOption", "Shift", "Space", "Fn+Space+", "RightOption+RightShift"]) assert.ok("error" in parseConfigText("voiceInput.hotkey", bad), bad);
    // macOS-only keys are taken on any OS: the desktop app refuses them when it registers the key.
    assert.deepEqual(parseClientConfig({ voiceInput: { hotkey: "RightCtrl" } }).config.voiceInput.hotkey, "RightControl");
    assert.deepEqual(parseClientConfig({ voiceInput: { hotkey: "Fn" } }).problems, []);
    assert.deepEqual(withConfigValue({}, "voiceInput.hotkey", "RightAlt"), { version: 1, voiceInput: { hotkey: "RightOption" } });
    assert.deepEqual(HOTKEY_SOLO_KEYS, ["RightOption", "RightControl", "RightCommand", "RightShift", "Fn"]);
  });

  test("setting a key keeps the rest of the file, unknown keys and a newer version", () => {
    const raw = { version: 3, update: { future: true }, other: { x: 1 } };
    const set = withConfigValue(raw, "update.region", "cn");
    assert.deepEqual(set, { version: 3, update: { future: true, region: "cn" }, other: { x: 1 } });
    assert.deepEqual(raw.update, { future: true }, "the input is not changed");
    assert.deepEqual(withConfigValue({ update: { region: "cn" } }, "update.region", undefined), { version: 1 });
    assert.deepEqual(withConfigValue(null, "files.showHidden", true), { version: 1, files: { showHidden: true } });
  });
});

describe("config file on disk", () => {
  test("lives next to hostd.json; set/unset write atomically and sparsely; a broken file is never replaced", () => {
    const path = clientConfigPath();
    assert.equal(path, join(home, "config.json"));
    assert.equal(configDir(), home);
    assert.equal(stateDir(), state);
    assert.equal(readClientConfig().exists, false);
    setClientConfigValue("update.region", "global");
    setClientConfigValue("update.mirrors", ["https://m.example.com/"]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, update: { region: "global", mirrors: ["https://m.example.com/"] } });
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600, "owner only, like the desktop app writes it");
    const after = setClientConfigValue("update.mirrors", undefined);
    assert.deepEqual(after.raw, { version: 1, update: { region: "global" } });
    assert.equal(after.config.update.region, "global");
    writeFileSync(path, "{ not json");
    const broken = readClientConfig();
    assert.ok(broken.broken);
    assert.equal(broken.config.update.region, "auto");
    assert.throws(() => setClientConfigValue("update.region", "cn"), /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
    rmSync(path);
  });
});

describe("regions", () => {
  test("environment, then the file, then the time zone", () => {
    assert.deepEqual(decideRegion({ env: "1", setting: "global", timeZone: "UTC" }), { region: "cn", reason: "env", timeZone: "UTC" });
    assert.equal(decideRegion({ env: "global", timeZone: "Asia/Shanghai" }).region, "global");
    assert.deepEqual(decideRegion({ setting: "cn", timeZone: "Europe/Berlin" }), { region: "cn", reason: "config", timeZone: "Europe/Berlin" });
    assert.equal(decideRegion({ setting: "auto", timeZone: "Asia/Shanghai" }).reason, "time-zone");
    assert.equal(decideRegion({ timeZone: "Asia/Urumqi" }).region, "cn");
    assert.deepEqual(decideRegion({ timeZone: "GMT+08:00", locale: "zh-CN", utcOffsetMinutes: 480 }).reason, "locale-offset");
    assert.equal(decideRegion({ timeZone: "GMT+08:00", locale: "zh-TW", utcOffsetMinutes: 480 }).region, "global");
    assert.equal(decideRegion({ timeZone: "Asia/Hong_Kong" }).region, "global");
    assert.deepEqual(decideRegion({ timeZone: "America/New_York" }), { region: "global", reason: "default", timeZone: "America/New_York" });
    assert.equal(decideRegion({ env: "maybe", setting: "bogus", timeZone: "UTC" }).reason, "default");
  });

  test("source order: own mirrors first; mirrors before GitHub in China, after it elsewhere", () => {
    const own = "https://m.example.com/";
    const cn = sourcePrefixes("cn", [own, "bad"]);
    assert.equal(cn[0], own);
    assert.equal(cn.at(-1), DIRECT_SOURCE);
    assert.equal(cn.length, 6);
    const global = sourcePrefixes("global", ["https://ghfast.top/"]);
    assert.deepEqual(global.slice(0, 2), ["https://ghfast.top/", DIRECT_SOURCE]);
    assert.equal(global.filter((s) => s === "https://ghfast.top/").length, 1, "no duplicates");
    assert.equal(sourceLabel(DIRECT_SOURCE), "github.com");
    assert.equal(sourceLabel("https://gh-proxy.com/"), "gh-proxy.com");
  });

  test("the fastest wins; an earlier one within the slack beats a slightly faster later one", () => {
    const order = ["a", "b", "c"];
    assert.equal(pickFastest([{ source: "c", ok: true, ms: 100 }, { source: "a", ok: true, ms: 900 }], order), "c");
    assert.equal(pickFastest([{ source: "c", ok: true, ms: 100 }, { source: "b", ok: true, ms: 200 }], order, 150), "b");
    assert.equal(pickFastest([{ source: "a", ok: false, ms: 10 }], order), undefined);
    assert.equal(pickLowestLatency([{ source: "c", ok: true, ms: 100 }, { source: "b", ok: true, ms: 110 }], order), "b");
    assert.equal(pickLowestLatency([{ source: "c", ok: true, ms: 100 }, { source: "b", ok: true, ms: 140 }], order), "c");
    assert.equal(pickLowestLatency([{ source: "a", ok: false, ms: 10 }], order), undefined);
    assert.deepEqual(withWinnerFirst(order, "c"), ["c", "a", "b"]);
    assert.deepEqual(withWinnerFirst(order, "zz"), order);
    const now = 1_000_000;
    assert.equal(cachedWinner({ region: "cn", winner: "b", at: now - 1000 }, "cn", order, now), "b");
    assert.equal(cachedWinner({ region: "cn", winner: "b", at: now - 25 * 3600_000 }, "cn", order, now), undefined, "older than a day");
    assert.equal(cachedWinner({ region: "global", winner: "b", at: now }, "cn", order, now), undefined, "another region");
    assert.equal(cachedWinner({ region: "cn", winner: "gone", at: now }, "cn", order, now), undefined);
    assert.equal(cachedWinner("junk", "cn", order, now), undefined);
  });

  test("check timing is jittered and bounded", () => {
    assert.equal(withJitter(1000, 0.1, () => 0), 900);
    assert.equal(withJitter(1000, 0.1, () => 1), 1100);
    const d = updateCheckDelays(0.1, () => 0.5);
    assert.equal(d.everyMs, 0.25 * 3600_000, "at least 0.25 hours");
    assert.ok(d.firstMs >= 15_000 && d.firstMs <= 60_000);
    assert.equal(updateCheckDelays(Number.NaN, () => 0.5).everyMs, 0.5 * 3600_000);
    assert.equal(updateCheckDelays(1000, () => 0.5).everyMs, 168 * 3600_000);
  });
});

describe("race", () => {
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      });
    });

  test("picks the fastest, gives an earlier one the slack, aborts the rest, records every probe", async () => {
    const aborted: string[] = [];
    const r = await raceSources(
      ["slow", "mid", "fast", "broken"],
      async (s, signal) => {
        signal.addEventListener("abort", () => aborted.push(s));
        if (s === "broken") throw new Error("HTTP 502");
        await wait({ slow: 2000, mid: 60, fast: 20 }[s]!, signal);
        return `v-${s}`;
      },
      { timeoutMs: 1000, slackMs: 80 },
    );
    assert.equal(r.winner, "mid", "within 80 ms of the fastest and earlier in order");
    assert.equal(r.value, "v-mid");
    assert.ok(aborted.includes("slow"));
    assert.equal(r.probes.length, 4);
    assert.equal(r.probes.find((p) => p.source === "broken")?.error, "HTTP 502");
    assert.equal(r.probes.find((p) => p.source === "slow")?.ok, false);
    assert.ok(r.ms < 1000);
  });

  test("nobody answers in time: no winner, every probe a timeout", async () => {
    const r = await raceSources(["a", "b"], (_s, signal) => wait(500, signal), { timeoutMs: 30 });
    assert.equal(r.winner, undefined);
    assert.ok(r.probes.every((p) => !p.ok && /within 30 ms/.test(p.error ?? "")));
  });

  test("the plan puts the remembered winner first, for its region only, and reads the file's region and mirrors", () => {
    process.env.HERDR_POCKET_MIRROR = "0";
    try {
      writeSourceCache({ region: "global", winner: "https://gh-proxy.com/", at: Date.now() });
      const plan = sourcePlan();
      assert.equal(plan.cached, "https://gh-proxy.com/");
      assert.equal(plan.order[0], "https://gh-proxy.com/");
      assert.equal(sourcesFor(GH)[0], `https://gh-proxy.com/${GH}`);
      process.env.HERDR_POCKET_MIRROR = "1";
      assert.equal(sourcePlan().cached, undefined, "cached for the other region");
      delete process.env.HERDR_POCKET_MIRROR;
      setClientConfigValue("update.mirrors", ["https://own.example.com/"]);
      setClientConfigValue("update.region", "cn");
      const fromFile = sourcePlan(process.env, Date.now() + 10_000);
      assert.equal(fromFile.decision.reason, "config");
      assert.equal(fromFile.order[0], "https://own.example.com/");
      assert.ok(existsSync(join(state, "sources.json")));

      setClientConfigValue("update.preferredSource", "direct");
      const directPlan = sourcePlan(process.env, Date.now() + 10_000);
      assert.equal(directPlan.order[0], DIRECT_SOURCE);
      assert.equal(directPlan.cached, undefined);

      setClientConfigValue("update.preferredSource", "https://custom.example.com/");
      const mirrorPlan = sourcePlan(process.env, Date.now() + 10_000);
      assert.equal(mirrorPlan.order[0], "https://custom.example.com/");
      assert.equal(mirrorPlan.order.filter((s) => s === "https://custom.example.com/").length, 1);
      assert.equal(mirrorPlan.cached, undefined);
    } finally {
      delete process.env.HERDR_POCKET_MIRROR;
      rmSync(clientConfigPath(), { force: true });
    }
  });
});

