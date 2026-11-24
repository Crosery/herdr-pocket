import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canActOnLocalFile } from "../src/lib/localFileActions.ts";
import { parseFileTarget } from "../src/lib/openFileTarget.ts";
import { buildPortalP2pUrl, filterVisiblePortalItems, mapContainedPointer } from "../src/lib/portalClient.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("buildPortalP2pUrl handles IPv4, bracketed IPv6, active direct endpoints, and encoded subpaths", () => {
  assert.equal(
    buildPortalP2pUrl(
      "h1",
      { token: "tok/1", entryPath: "docs/my report.html", port: 49210, addrs: ["192.168.1.10"] },
      { addr: "192.168.1.10", port: 49210 },
    ),
    "http://192.168.1.10:49210/v1/portal-fs/tok%2F1/docs/my%20report.html",
  );
  assert.equal(
    buildPortalP2pUrl(
      "h1",
      { token: "tok2", entryPath: "clip.mp4", port: 49211, addrs: ["fd7a:115c::1"] },
      { addr: "fd7a:115c::1", port: 49211 },
    ),
    "http://[fd7a:115c::1]:49211/v1/portal-fs/tok2/clip.mp4",
  );
  // Returns null when no P2P direct link is active
  assert.equal(
    buildPortalP2pUrl("h-offline", { token: "t", entryPath: "a.png", port: 49210, addrs: ["10.0.0.1"] }, null),
    null,
  );
});

test("mapContainedPointer maps letterbox, pillarbox, and clamps pointer coordinates", () => {
  // Container 1000x500 (aspect 2.0), image 1000x1000 (aspect 1.0) -> drawn square x=[250..750], y=[0..500]
  const pillarCenter = mapContainedPointer({
    clientX: 500,
    clientY: 250,
    rectLeft: 0,
    rectTop: 0,
    rectWidth: 1000,
    rectHeight: 500,
    imageWidth: 1000,
    imageHeight: 1000,
  });
  assert.equal(pillarCenter.nx, 0.5);
  assert.equal(pillarCenter.ny, 0.5);

  const pillarLeftClamp = mapContainedPointer({
    clientX: 100,
    clientY: 250,
    rectLeft: 0,
    rectTop: 0,
    rectWidth: 1000,
    rectHeight: 500,
    imageWidth: 1000,
    imageHeight: 1000,
  });
  assert.equal(pillarLeftClamp.nx, 0);

  // Container 500x1000 (aspect 0.5), image 1000x500 (aspect 2.0) -> drawn height 250 at y=[375..625]
  const letterTopEdge = mapContainedPointer({
    clientX: 250,
    clientY: 375,
    rectLeft: 0,
    rectTop: 0,
    rectWidth: 500,
    rectHeight: 1000,
    imageWidth: 1000,
    imageHeight: 500,
  });
  assert.equal(letterTopEdge.nx, 0.5);
  assert.equal(letterTopEdge.ny, 0);
});

test("canActOnLocalFile blocks remote agent paths when localHostId is absent or mismatched", () => {
  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      path: "a.txt",
      absPath: "/Users/remote/work/a.txt",
      agentDeviceId: "remote-mac",
      localHostId: null,
    }),
    false,
  );
  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      path: "a.txt",
      absPath: "/Users/remote/work/a.txt",
      agentDeviceId: "remote-mac",
      localHostId: "local-mac",
    }),
    false,
  );
  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      path: "a.txt",
      absPath: "/Users/local/work/a.txt",
      agentDeviceId: "local-mac",
      localHostId: "local-mac",
    }),
    true,
  );
});

test("parseFileTarget recognizes Office, HTML, and image extensions", () => {
  for (const name of ["spec.docx", "budget.xlsx", "deck.pptx", "docs/oauth-flow.html", "shots/screen.png"]) {
    const parsed = parseFileTarget(name, "/work/repo");
    assert.ok(parsed, `expected ${name} to parse`);
    assert.ok(parsed.absPath.endsWith(name));
  }
});

test("new Batch 2 UI/docs files contain zero emojis", () => {
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const files = [
    "apps/desktop/src/components/PortalViewerModal.tsx",
    "apps/desktop/src/components/SessionPortalPiP.tsx",
    "apps/desktop/src/lib/portalClient.ts",
    "apps/desktop/src/views/settings/ToolVersions.tsx",
    "apps/mobile/src/components/HostToolsSheet.tsx",
    "apps/mobile/src/components/MobilePortalModal.tsx",
    "docs/releases/v0.2.25.md",
  ];
  for (const rel of files) {
    const full = join(ROOT, rel);
    assert.ok(existsSync(full), `missing ${rel}`);
    const text = readFileSync(full, "utf8");
    const m = EMOJI_RE.exec(text);
    assert.equal(m, null, `unexpected emoji in ${rel}: ${m?.[0]}`);
  }
});

test("SessionPortalPiP filters same-machine auto-popups on desktop, preserves terminal focus, and anchors in-term top-right", () => {
  const autoItem = {
    id: "ptl-auto",
    hostId: "h1",
    agentKey: "h1/hc:t1",
    kind: "window" as const,
    title: "ego lite",
    canInteract: true,
    transportHint: "p2p" as const,
    createdAt: 100,
    updatedAt: 200,
  };
  const manualItem = { ...autoItem, id: "ptl-manual", updatedAt: 150 };
  const itemsById = { [autoItem.id]: autoItem, [manualItem.id]: manualItem };

  // Same local Tauri machine hides automatic popups while retaining manually launched portals
  const localVisible = filterVisiblePortalItems({
    itemsById,
    dismissedIds: {},
    manualIds: { [manualItem.id]: true },
    agent: { deviceId: "h1", key: "h1/hc:t1" },
    isTauriApp: true,
    localHostId: "h1",
  });
  assert.deepEqual(
    localVisible.map((i) => i.id),
    ["ptl-manual"],
  );

  // Controlling a remote host or web H5 surfaces automatic portals immediately
  const remoteVisible = filterVisiblePortalItems({
    itemsById,
    dismissedIds: {},
    manualIds: { [manualItem.id]: true },
    agent: { deviceId: "h1", key: "h1/hc:t1" },
    isTauriApp: true,
    localHostId: "h2",
  });
  assert.deepEqual(
    remoteVisible.map((i) => i.id),
    ["ptl-auto", "ptl-manual"],
  );

  const h5Visible = filterVisiblePortalItems({
    itemsById,
    dismissedIds: { [manualItem.id]: true },
    manualIds: {},
    agent: { deviceId: "h1", key: "h1/hc:t1" },
    isTauriApp: false,
    localHostId: null,
  });
  assert.deepEqual(
    h5Visible.map((i) => i.id),
    ["ptl-auto"],
  );

  const pipSrc = readFileSync(join(ROOT, "apps/desktop/src/components/SessionPortalPiP.tsx"), "utf8");
  const agentsSrc = readFileSync(join(ROOT, "apps/desktop/src/views/AgentsView.tsx"), "utf8");
  const cssSrc = readFileSync(join(ROOT, "apps/desktop/src/styles/app.css"), "utf8");
  assert.match(pipSrc, /onMouseDown=\{\(e\)\s*=>\s*\{\s*e\.preventDefault\(\);/);
  assert.match(pipSrc, /mode\s*===\s*"term"\s*\?\s*" in-term"\s*:\s*""/);
  assert.match(agentsSrc, /<SessionPortalPiP[\s\S]*mode=\{activeMode\}/);
  assert.match(cssSrc, /\.session-portal-pip\.in-term\s*\{[\s\S]*top:\s*14px;/);
});
