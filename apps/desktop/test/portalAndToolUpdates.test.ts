import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canActOnLocalFile } from "../src/lib/localFileActions.ts";
import { parseFileTarget } from "../src/lib/openFileTarget.ts";
import { extractPromptCommandFromXterm, feedLocalCommandLineBuffer } from "../src/lib/terminalCommandExtract.ts";
import {
  buildPortalP2pUrl,
  dismissPortalInUi,
  filterVisiblePortalItems,
  ingestPortalStreamEvent,
  isLoopbackPortalUrl,
  mapContainedPointer,
  mapZoomedStagePointer,
  portalStore,
  resetPortalClientStateForTest,
  stepTrackpadCursor,
} from "../src/lib/portalClient.ts";

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
    "apps/desktop/src/components/ChatTimeline.tsx",
    "apps/desktop/src/components/PortalRemoteStage.tsx",
    "apps/desktop/src/components/PortalViewerModal.tsx",
    "apps/desktop/src/components/SessionPortalPiP.tsx",
    "apps/desktop/src/lib/portalClient.ts",
    "apps/desktop/src/views/settings/ToolVersions.tsx",
    "apps/mobile/src/components/HostToolsSheet.tsx",
    "apps/mobile/src/components/MobilePortalModal.tsx",
    "apps/mobile/src/components/chat.tsx",
    "docs/releases/v0.2.25.md",
    "docs/releases/v0.2.42.md",
  ];
  for (const rel of files) {
    const full = join(ROOT, rel);
    assert.ok(existsSync(full), `missing ${rel}`);
    const text = readFileSync(full, "utf8");
    const m = EMOJI_RE.exec(text);
    assert.equal(m, null, `unexpected emoji in ${rel}: ${m?.[0]}`);
  }
});

test("SessionPortalPiP surfaces same-machine and remote portals immediately, preserves terminal focus, and anchors in-term top-right", () => {
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

  // Same local Tauri machine now also surfaces newly launched window/browser/file PiPs immediately
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
    ["ptl-auto", "ptl-manual"],
  );

  // Dismissing an auto portal hides only the dismissed card
  const afterDismiss = filterVisiblePortalItems({
    itemsById,
    dismissedIds: { [autoItem.id]: true },
    manualIds: { [manualItem.id]: true },
    agent: { deviceId: "h1", key: "h1/hc:t1" },
    isTauriApp: true,
    localHostId: "h1",
  });
  assert.deepEqual(
    afterDismiss.map((i) => i.id),
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

test("isLoopbackPortalUrl distinguishes remote loopback URLs and portal_frame clears streamError", (t) => {
  t.after(() => resetPortalClientStateForTest());
  assert.equal(isLoopbackPortalUrl("http://127.0.0.1:8764/?edition=winter&t=0.1"), true);
  assert.equal(isLoopbackPortalUrl("http://localhost:3000/auth"), true);
  assert.equal(isLoopbackPortalUrl("http://[::1]:5173/"), true);
  assert.equal(isLoopbackPortalUrl("http://0.0.0.0:8080/health"), true);
  assert.equal(isLoopbackPortalUrl("https://example.com/oauth"), false);
  assert.equal(isLoopbackPortalUrl(undefined), false);

  ingestPortalStreamEvent({
    kind: "portal_event",
    action: "opened",
    at: 1000,
    item: {
      id: "ptl-err-1",
      hostId: "h-remote",
      agentKey: "h-remote/hc:t1",
      kind: "browser",
      title: "ego lite",
      url: "http://127.0.0.1:8764/?edition=winter&t=0.1",
      canInteract: true,
      streamError: "屏幕录制未授权",
      createdAt: 1000,
      updatedAt: 1000,
    },
  });
  assert.equal(portalStore.get().itemsById["ptl-err-1"]?.streamError, "屏幕录制未授权");

  ingestPortalStreamEvent({
    kind: "portal_frame",
    portalId: "ptl-err-1",
    seq: 1,
    mime: "image/jpeg",
    data: "abc",
    width: 1280,
    height: 820,
    at: 2000,
  });
  assert.equal(portalStore.get().itemsById["ptl-err-1"]?.streamError, undefined);
  assert.equal(portalStore.get().framesById["ptl-err-1"]?.seq, 1);
  assert.match(readFileSync(join(ROOT, "apps/desktop/src/components/SessionPortalPiP.tsx"), "utf8"), /去授权屏幕录制/);
  assert.match(readFileSync(join(ROOT, "apps/desktop/src/components/PortalViewerModal.tsx"), "utf8"), /去授权屏幕录制/);
});

test("mapZoomedStagePointer & stepTrackpadCursor handle zoom, pan, acceleration, and clamping", () => {
  // Stage 1000x500, image 1000x500 -> zoom=2, panX=100, panY=-50.
  // Clicking at center+pan => (600, 200) maps back to center (0.5, 0.5).
  const centerHit = mapZoomedStagePointer({
    clientX: 600,
    clientY: 200,
    rectLeft: 0,
    rectTop: 0,
    rectWidth: 1000,
    rectHeight: 500,
    imageWidth: 1000,
    imageHeight: 500,
    zoom: 2,
    panX: 100,
    panY: -50,
  });
  assert.ok(Math.abs(centerHit.nx - 0.5) < 1e-6);
  assert.ok(Math.abs(centerHit.ny - 0.5) < 1e-6);
  assert.equal(centerHit.inside, true);

  // Far right edge beyond image => clamps to 1.0 and marks inside = false
  const clamped = mapZoomedStagePointer({
    clientX: 1200,
    clientY: 250,
    rectLeft: 0,
    rectTop: 0,
    rectWidth: 1000,
    rectHeight: 500,
    imageWidth: 1000,
    imageHeight: 500,
    zoom: 1,
  });
  assert.equal(clamped.nx, 1);
  assert.equal(clamped.inside, false);

  // Small relative trackpad nudge has near 1x precision, fast swipe accelerates, and ends clamp [0, 1]
  const slow = stepTrackpadCursor({ nx: 0.5, ny: 0.5 }, 2, 0, 1000, 500);
  const fast = stepTrackpadCursor({ nx: 0.5, ny: 0.5 }, 40, 0, 1000, 500);
  assert.ok(slow.nx > 0.502 && slow.nx < 0.503);
  assert.ok(fast.nx > 0.57);
  const edge = stepTrackpadCursor({ nx: 0.99, ny: 0.01 }, 200, -200, 500, 500);
  assert.deepEqual(edge, { nx: 1, ny: 0 });
});

test("extractPromptCommandFromXterm reconstructs wrapped rows and strips Starship/OMZ/ANSI prompts", () => {
  const makeTerm = (rows: Array<{ text: string; isWrapped?: boolean }>, cursorY: number, baseY = 0) => ({
    buffer: {
      active: {
        baseY,
        cursorY,
        length: rows.length,
        getLine: (y: number) =>
          rows[y]
            ? {
                isWrapped: rows[y]!.isWrapped,
                translateToString: () => rows[y]!.text,
              }
            : undefined,
      },
    },
  });

  // 1) Wrapped Starship command line (split across two xterm rows)
  assert.equal(
    extractPromptCommandFromXterm(
      makeTerm(
        [
          { text: "crosery ~/work/strum_app stage" },
          { text: "→ open CLAU", isWrapped: false },
          { text: "DE.md", isWrapped: true },
        ],
        2,
      ),
    ),
    "open CLAUDE.md",
  );

  // 2) Oh-My-Zsh arrow & ANSI colors
  assert.equal(
    extractPromptCommandFromXterm(makeTerm([{ text: "\x1b[32m➜\x1b[0m  herdr-pocket git:(main) ego-browser nodejs" }], 0)),
    "ego-browser nodejs",
  );

  // 3) Standard zsh prompt with %
  assert.equal(
    extractPromptCommandFromXterm(makeTerm([{ text: "crosery@mac ~/repo % open docs/index.html" }], 0)),
    "open docs/index.html",
  );

  // 4) Bare empty prompt returns empty string
  assert.equal(extractPromptCommandFromXterm(makeTerm([{ text: "→ " }], 0)), "");

  // 5) feedLocalCommandLineBuffer handles backspace and word delete
  const bufRef = { current: "" };
  assert.deepEqual(feedLocalCommandLineBuffer(bufRef, "open foob\x7f\x7f\x7f\x7fCLAUDE.md\r"), ["open CLAUDE.md"]);
});

test("ingestPortalStreamEvent opened increments openSeqById and clears dismissedIds so SessionPortalPiP re-surfaces", () => {
  resetPortalClientStateForTest();
  const item = {
    id: "ptl-reopen",
    hostId: "h1",
    agentKey: "h1/hc:t1",
    kind: "window" as const,
    title: "ego lite",
    canInteract: true,
    createdAt: 1000,
    updatedAt: 1000,
  };
  ingestPortalStreamEvent({ kind: "portal_event", action: "opened", item, at: 1000 });
  assert.equal(portalStore.get().openSeqById["ptl-reopen"], 1);
  assert.equal(portalStore.get().dismissedIds["ptl-reopen"], undefined);

  dismissPortalInUi("ptl-reopen");
  assert.equal(portalStore.get().dismissedIds["ptl-reopen"], true);

  ingestPortalStreamEvent({
    kind: "portal_event",
    action: "opened",
    item: { ...item, title: "ego lite - updated", updatedAt: 2000 },
    at: 2000,
  });
  assert.equal(portalStore.get().dismissedIds["ptl-reopen"], undefined);
  assert.equal(portalStore.get().openSeqById["ptl-reopen"], 2);
  resetPortalClientStateForTest();
});

test("t3code Chat UI structural contract: unboxed centered layout, no bulky bottom run card, and compact stop button", () => {
  const agentsView = readFileSync(join(ROOT, "apps/desktop/src/views/AgentsView.tsx"), "utf8");
  const chatTimeline = readFileSync(join(ROOT, "apps/desktop/src/components/ChatTimeline.tsx"), "utf8");
  const mobileChat = readFileSync(join(ROOT, "apps/mobile/src/components/chat.tsx"), "utf8");

  assert.ok(!agentsView.includes("agent-run-card"), "AgentsView should not render legacy agent-run-card");
  assert.ok(!agentsView.includes("agent-stop-pill"), "AgentsView should not render legacy agent-stop-pill");
  for (const cls of ["t3-chat-column", "t3-working-row", "t3-composer-shell", "composer-stop-btn"]) {
    assert.ok(agentsView.includes(cls), `AgentsView missing ${cls}`);
  }
  for (const cls of ["t3-work-row", "t3-work-children", "t3-assistant-row", "t3-assistant-body", "t3-live-shine"]) {
    assert.ok(chatTimeline.includes(cls), `ChatTimeline missing ${cls}`);
  }
  assert.ok(!mobileChat.includes("BusyMascot"), "mobile chat should not keep bulky BusyMascot working banner");

  // AgentsView has 1 pre-existing ✓ at chat-shell-empty; ensure zero other emojis exist.
  const NON_CHECKMARK_EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2712}\u{2715}-\u{27BF}]/u;
  assert.equal(NON_CHECKMARK_EMOJI_RE.exec(agentsView), null, "unexpected emoji in AgentsView.tsx");
});
