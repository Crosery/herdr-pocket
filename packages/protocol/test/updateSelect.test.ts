import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  DIRECT_SOURCE,
  configKeySpec,
  configValueError,
  defaultClientConfig,
  isRecommendedSourceForRegion,
  orderWithPreferredSource,
  parseClientConfig,
  parseConfigText,
  pickLowestLatency,
  resolvePreferredSource,
  updateCheckDelays,
} from "../src/index.ts";

describe("protocol updateSelect & config schema", () => {
  test("update defaults: checkIntervalHours=0.5 (min 0.25) and preferredSource=auto", () => {
    const cfg = defaultClientConfig();
    assert.equal(cfg.update.checkIntervalHours, 0.5);
    assert.equal(cfg.update.preferredSource, "auto");
    assert.equal(configKeySpec("update.checkIntervalHours")?.type, "number");
    assert.equal(configKeySpec("update.checkIntervalHours")?.label, "自动检查频率");
    assert.equal(configKeySpec("update.preferredSource")?.format, "sourceChoice");
    assert.equal(configKeySpec("update.preferredSource")?.label, "首选镜像源");
  });

  test("number config parsing accepts decimals bounded by [min, max] while integer stays strict", () => {
    assert.deepEqual(parseConfigText("update.checkIntervalHours", "0.25"), { value: 0.25 });
    assert.deepEqual(parseConfigText("update.checkIntervalHours", "0.5"), { value: 0.5 });
    assert.deepEqual(parseConfigText("update.checkIntervalHours", "72"), { value: 72 });
    assert.ok("error" in parseConfigText("update.checkIntervalHours", "0.1"));
    assert.ok("error" in parseConfigText("update.checkIntervalHours", "200"));
    assert.ok("error" in parseConfigText("update.checkIntervalHours", "abc"));
    assert.ok(configValueError(configKeySpec("update.checkIntervalHours")!, Number.NaN));

    // Existing integer keys still reject decimals.
    assert.ok("error" in parseConfigText("general.textScale", "100.5"));
    assert.deepEqual(parseConfigText("general.textScale", "100"), { value: 100 });
  });

  test("sourceChoice format accepts auto, direct, or valid mirror prefix", () => {
    assert.deepEqual(parseConfigText("update.preferredSource", "auto"), { value: "auto" });
    assert.deepEqual(parseConfigText("update.preferredSource", "direct"), { value: "direct" });
    assert.deepEqual(parseConfigText("update.preferredSource", "https://ghfast.top/"), { value: "https://ghfast.top/" });
    assert.ok("error" in parseConfigText("update.preferredSource", "https://ghfast.top"));
    assert.ok("error" in parseConfigText("update.preferredSource", "mars"));

    const { config, problems } = parseClientConfig({
      version: 1,
      update: { preferredSource: "invalid", checkIntervalHours: 0.5 },
    });
    assert.equal(config.update.preferredSource, "auto");
    assert.equal(config.update.checkIntervalHours, 0.5);
    assert.ok(problems.some((p) => p.key === "error:update.preferredSource" || p.key === "update.preferredSource"));
  });

  test("updateCheckDelays clamps [0.25, 168] and uses 15-60s first delay", () => {
    const min = updateCheckDelays(0.01, () => 0.5);
    assert.equal(min.everyMs, 0.25 * 3600_000);
    assert.equal(min.firstMs, 15_000 + Math.round(0.5 * 45_000));
    const def = updateCheckDelays(Number.NaN, () => 0.5);
    assert.equal(def.everyMs, 0.5 * 3600_000);
    const max = updateCheckDelays(500, () => 0.5);
    assert.equal(max.everyMs, 168 * 3600_000);
  });

  test("pickLowestLatency picks lowest ms and breaks ties <= 15ms by recommendedOrder", () => {
    const order = ["https://ghfast.top/", "https://gh-proxy.com/", DIRECT_SOURCE];
    assert.equal(
      pickLowestLatency(
        [
          { source: DIRECT_SOURCE, ok: true, ms: 90 },
          { source: "https://ghfast.top/", ok: true, ms: 100 },
          { source: "https://gh-proxy.com/", ok: false, ms: 10 },
        ],
        order,
      ),
      "https://ghfast.top/",
    );
    // Margin > 15ms: strict lowest ms wins even if later in order.
    assert.equal(
      pickLowestLatency(
        [
          { source: "https://ghfast.top/", ok: true, ms: 140 },
          { source: DIRECT_SOURCE, ok: true, ms: 80 },
        ],
        order,
      ),
      DIRECT_SOURCE,
    );
    assert.equal(pickLowestLatency([{ source: DIRECT_SOURCE, ok: false, ms: 10 }], order), undefined);
  });

  test("orderWithPreferredSource & resolvePreferredSource & isRecommendedSourceForRegion", () => {
    const base = ["https://ghfast.top/", "https://gh-proxy.com/", DIRECT_SOURCE];
    assert.equal(resolvePreferredSource("auto"), undefined);
    assert.equal(resolvePreferredSource("direct"), DIRECT_SOURCE);
    assert.equal(resolvePreferredSource("https://custom.example.com/"), "https://custom.example.com/");
    assert.deepEqual(orderWithPreferredSource(base, "direct", "https://gh-proxy.com/"), [
      DIRECT_SOURCE,
      "https://ghfast.top/",
      "https://gh-proxy.com/",
    ]);
    assert.deepEqual(orderWithPreferredSource(base, "https://custom.example.com/", "https://gh-proxy.com/"), [
      "https://custom.example.com/",
      "https://ghfast.top/",
      "https://gh-proxy.com/",
      DIRECT_SOURCE,
    ]);
    assert.deepEqual(orderWithPreferredSource(base, "auto", "https://gh-proxy.com/"), [
      "https://gh-proxy.com/",
      "https://ghfast.top/",
      DIRECT_SOURCE,
    ]);
    assert.equal(isRecommendedSourceForRegion("https://ghfast.top/", "cn", base), true);
    assert.equal(isRecommendedSourceForRegion(DIRECT_SOURCE, "cn", base), false);
    assert.equal(isRecommendedSourceForRegion(DIRECT_SOURCE, "global", [DIRECT_SOURCE, ...base.slice(0, 2)]), true);
  });
});
