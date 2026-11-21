import assert from "node:assert/strict";
import { test } from "node:test";
import type { Device } from "@herdr-pocket/protocol";
import { partitionDevices } from "../src/lib/deviceRole.ts";

function dev(overrides: Partial<Device>): Device {
  return {
    id: "d-id",
    name: "Device",
    kind: "viewer",
    platform: "darwin",
    online: true,
    lastSeenAt: 1_000_000,
    ...overrides,
  };
}

test("partitionDevices groups desktop execution hosts separately from mobile controllers and merges local mac", () => {
  const devices: Record<string, Device> = {
    "h-remote": dev({ id: "h-remote", name: "Home-Mac", kind: "host", platform: "darwin", online: true }),
    "h-local": dev({ id: "h-local", name: "Work-Mac", kind: "host", platform: "darwin", online: true }),
    "v-local": dev({ id: "v-local", name: "Work-Mac", kind: "viewer", platform: "darwin", online: true }),
    "v-desk": dev({ id: "v-desk", name: "Studio-Display-UI", kind: "viewer", platform: "win32", online: false }),
    "v-phone": dev({ id: "v-phone", name: "Phone-A", kind: "viewer", platform: "android", online: true }),
  };

  const p = partitionDevices(devices, { myId: "v-local", localHostId: "h-local" });

  // Local viewer is merged into local host row instead of duplicating "Work-Mac".
  assert.equal(p.desktop.length, 3);
  assert.equal(p.desktop[0]!.device.id, "h-local");
  assert.equal(p.desktop[0]!.isCurrentDevice, true);
  assert.equal(p.desktop[0]!.isLocalHost, true);
  assert.equal(p.desktop[0]!.roleLabel, "运行载体 · 本地直连");
  assert.equal(p.desktop[0]!.mergedViewer?.id, "v-local");

  assert.equal(p.desktop[1]!.device.id, "h-remote");
  assert.equal(p.desktop[1]!.isExecutionHost, true);
  assert.equal(p.desktop[1]!.roleLabel, "外部桌面 · 远程联调");

  assert.equal(p.desktop[2]!.device.id, "v-desk");
  assert.equal(p.desktop[2]!.roleLabel, "桌面控制端");

  assert.equal(p.mobile.length, 1);
  assert.equal(p.mobile[0]!.device.id, "v-phone");
  assert.equal(p.mobile[0]!.roleLabel, "便携控制端");
  assert.equal(p.desktopOnlineCount, 2);
  assert.equal(p.mobileOnlineCount, 1);
});
