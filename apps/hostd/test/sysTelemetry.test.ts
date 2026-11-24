import assert from "node:assert/strict";
import { test } from "node:test";
import { collectHostResourcePulse, collectHostSystemProfile, detectHostDisplayServer } from "../src/sysTelemetry.ts";

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
