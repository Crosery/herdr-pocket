import assert from "node:assert/strict";
import { test } from "node:test";
import { collectHostResourcePulse, collectHostSystemProfile, detectHostDisplayServer, startHostTelemetry } from "../src/sysTelemetry.ts";

test("host system telemetry reports valid profile, display server, and resource metrics", () => {
  assert.equal(detectHostDisplayServer("darwin", {}), "quartz");
  assert.equal(detectHostDisplayServer("win32", {}), "win32");
  assert.equal(detectHostDisplayServer("linux", { WAYLAND_DISPLAY: "wayland-0" }), "wayland");
  assert.equal(detectHostDisplayServer("linux", { DISPLAY: ":0" }), "x11");
  assert.equal(detectHostDisplayServer("linux", {}), "headless");

  const boot = collectHostSystemProfile();
  assert.ok(boot.cpuCores >= 1);
  assert.ok(boot.totalRamMb > 0);
  assert.ok(boot.os.length > 0);

  const pulse = collectHostResourcePulse({ agentCount: 3, activeStreams: 2, directPeers: 1 });
  assert.ok(pulse.rssMb > 0);
  assert.equal(pulse.agentCount, 3);
  assert.equal(pulse.activeStreams, 2);
  assert.equal(pulse.directPeers, 1);
});

test("startHostTelemetry emits event-loop delay stats in sys.host_pulse and cleans up on stop", async () => {
  const events: Array<{ level: string; kind: string; msg: string; data: Record<string, unknown> }> = [];
  const stop = startHostTelemetry(
    (level, kind, msg, data) => events.push({ level, kind, msg, data }),
    () => ({ agentCount: 2, activeStreams: 1, directPeers: 0 }),
    45,
  );
  try {
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "sys.host_boot");

    await new Promise((r) => setTimeout(r, 120));
    const pulses = events.filter((e) => e.kind === "sys.host_pulse");
    assert.ok(pulses.length >= 1, "expected at least one sys.host_pulse");
    const last = pulses[pulses.length - 1]!;
    assert.equal(typeof last.data.elMeanMs, "number");
    assert.equal(typeof last.data.elP99Ms, "number");
    assert.equal(typeof last.data.elMaxMs, "number");
    assert.ok((last.data.elMeanMs as number) >= 0);
    assert.ok((last.data.elP99Ms as number) >= 0);
    assert.ok((last.data.elMaxMs as number) >= 0);
  } finally {
    stop();
  }

  const countAfterStop = events.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, countAfterStop, "stop() must stop interval and event-loop monitor cleanly");
});
