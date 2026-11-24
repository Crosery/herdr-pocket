import assert from "node:assert/strict";
import { test } from "node:test";
import { logStore } from "../src/lib/log.ts";
import { computeFrameStats, recordClientRpcSample, resetPerfTelemetryForTest } from "../src/lib/perfTelemetry.ts";

test("computeFrameStats reports smooth 60fps vs janky/frozen frame windows accurately", () => {
  const smooth = computeFrameStats(Array.from({ length: 60 }, () => 16.6));
  assert.equal(smooth.frames, 60);
  assert.ok(smooth.fpsAvg >= 59 && smooth.fpsAvg <= 61);
  assert.equal(smooth.droppedFrames, 0);
  assert.equal(smooth.jankFrames, 0);
  assert.equal(smooth.severeFreezeFrames, 0);

  const janky = computeFrameStats([16, 16, 45, 16, 120, 16, 35, 16]);
  assert.equal(janky.frames, 8);
  assert.equal(janky.droppedFrames, 3);
  assert.equal(janky.jankFrames, 3);
  assert.equal(janky.severeFreezeFrames, 1);
  assert.ok(janky.fpsAvg < 35);
  assert.equal(janky.frameMaxMs, 120);
});

test("recordClientRpcSample warns immediately on slow RPCs except excluded long operations", () => {
  resetPerfTelemetryForTest();
  const baseLen = logStore.get().entries.length;
  recordClientRpcSample("terminal.resize", 2600, false, true);
  recordClientRpcSample("agent.create", 4000, false, true);
  const added = logStore.get().entries.slice(baseLen);
  assert.equal(added.length, 1);
  assert.equal(added[0]!.scope, "perf.rpc");
  assert.equal(added[0]!.level, "warn");
  assert.equal(added[0]!.data?.method, "terminal.resize");
});
