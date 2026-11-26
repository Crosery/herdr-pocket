import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canActOnLocalFile } from "../src/lib/localFileActions.ts";
import { parseFileTarget } from "../src/lib/openFileTarget.ts";
import { toolInputSummary } from "../src/lib/chatFold.ts";
import { classifyDirectLinkKind } from "../src/lib/direct.ts";
import { extractPromptCommandFromXterm, feedLocalCommandLineBuffer } from "../src/lib/terminalCommandExtract.ts";
import {
  DirectCipher,
  configKeySpec,
  decodeBinaryPortalStreamFrame,
  encodeBinaryPortalStreamFrame,
  jsChaCha20Poly1305,
} from "@herdr-pocket/protocol";
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
  resolvePortalTransport,
  stepTrackpadCursor,
} from "../src/lib/portalClient.ts";
import {
  builtinSlashCommands,
  extractSlashQuery,
  matchSlashCommands,
  parseLeadingSlashToken,
} from "../src/lib/slashCommands.ts";

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
    "docs/releases/v0.2.43.md",
    "docs/releases/v0.2.44.md",
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
  assert.match(pipSrc, /onMouseDown=\{\(e\)\s*=>\s*\{[\s\S]*e\.preventDefault\(\);/);
  assert.match(pipSrc, /session-portal-stack-bar/);
  assert.match(pipSrc, /session-portal-deck-back/);
  assert.match(pipSrc, /cascade/);
  assert.match(pipSrc, /bitmapCacheRef/);
  assert.match(agentsSrc, /<SessionPortalPiP[\s\S]*mode=\{activeMode\}/);
  assert.match(cssSrc, /\.session-portal-pip\s*\{[\s\S]*top:\s*14px;[\s\S]*right:\s*16px;[\s\S]*bottom:\s*auto;/);
  assert.doesNotMatch(cssSrc, /\.session-portal-pip\s*\{[^}]*bottom:\s*108px;/);
  assert.match(cssSrc, /\.session-portal-pip\.in-term\s*\{[\s\S]*top:\s*14px;/);
});

test("v0.2.44 multi-window stack preserves deterministic order across frames and updated events without thrashing", (t) => {
  t.after(() => resetPortalClientStateForTest());
  const mkItem = (id: string, title: string, ts: number) => ({
    id,
    hostId: "h1",
    agentKey: "h1/hc:t1",
    kind: "window" as const,
    title,
    canInteract: true,
    transportHint: "p2p" as const,
    createdAt: ts,
    updatedAt: ts,
  });

  ingestPortalStreamEvent({ kind: "portal_event", action: "opened", item: mkItem("ptl-1", "Doc A", 1000), at: 1000 }, "h1");
  ingestPortalStreamEvent({ kind: "portal_event", action: "opened", item: mkItem("ptl-2", "Browser B", 2000), at: 2000 }, "h1");
  ingestPortalStreamEvent({ kind: "portal_event", action: "opened", item: mkItem("ptl-3", "Preview C", 3000), at: 3000 }, "h1");

  const order1 = filterVisiblePortalItems({
    itemsById: portalStore.get().itemsById,
    dismissedIds: portalStore.get().dismissedIds,
    openedAtById: portalStore.get().openedAtById,
    agent: { deviceId: "h1", key: "h1/hc:t1" },
  }).map((i) => i.id);
  assert.deepEqual(order1, ["ptl-3", "ptl-2", "ptl-1"]);

  // High-frequency frames and "updated" title changes on ptl-1 must NOT reorder the stack or bump openSeqById.
  const prevOpenSeq1 = portalStore.get().openSeqById["ptl-1"];
  ingestPortalStreamEvent(
    { kind: "portal_frame", portalId: "ptl-1", seq: 1, mime: "image/jpeg", data: "AA==", width: 800, height: 600, at: 99999 },
    "h1",
  );
  ingestPortalStreamEvent(
    { kind: "portal_event", action: "updated", item: mkItem("ptl-1", "Doc A - Edited", 100000), at: 100000 },
    "h1",
  );
  assert.equal(portalStore.get().openSeqById["ptl-1"], prevOpenSeq1);
  assert.equal(portalStore.get().itemsById["ptl-1"]?.title, "Doc A - Edited");

  const order2 = filterVisiblePortalItems({
    itemsById: portalStore.get().itemsById,
    dismissedIds: portalStore.get().dismissedIds,
    openedAtById: portalStore.get().openedAtById,
    agent: { deviceId: "h1", key: "h1/hc:t1" },
  }).map((i) => i.id);
  assert.deepEqual(order2, ["ptl-3", "ptl-2", "ptl-1"]);

  // Explicit "opened" promotes the newly triggered portal cleanly.
  ingestPortalStreamEvent(
    { kind: "portal_event", action: "opened", item: mkItem("ptl-1", "Doc A - Reopened", 105000), at: 105000 },
    "h1",
  );
  const order3 = filterVisiblePortalItems({
    itemsById: portalStore.get().itemsById,
    dismissedIds: portalStore.get().dismissedIds,
    openedAtById: portalStore.get().openedAtById,
    agent: { deviceId: "h1", key: "h1/hc:t1" },
  }).map((i) => i.id);
  assert.deepEqual(order3, ["ptl-1", "ptl-3", "ptl-2"]);
  assert.equal(portalStore.get().openSeqById["ptl-1"], (prevOpenSeq1 ?? 0) + 1);
  resetPortalClientStateForTest();
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

test("v0.2.43 speed & step UI contracts: instant local Cmd+T/Cmd+D, 60 FPS presets, clean JSON step summaries, and mobile Stop button", () => {
  // 1) toolInputSummary cleanly unwraps complete and streaming partial JSON strings
  assert.equal(toolInputSummary('{"CommandLine":"pnpm test --filter hostd"}'), "pnpm test --filter hostd");
  assert.equal(toolInputSummary('{"CommandLine":"mkdir -p apps/web/src'), "mkdir -p apps/web/src");
  assert.equal(toolInputSummary({ Path: "/tmp/repo/docs/README.md" }), "docs/README.md");

  // 2) DesktopShell skips Relay herdr.command and launches local shells directly on Cmd+T and Cmd+D
  const desktopShell = readFileSync(join(ROOT, "apps/desktop/src/shell/DesktopShell.tsx"), "utf8");
  assert.ok(desktopShell.includes("!isLocalDesktop &&\n          splitTarget"), "canUseHerdrPaneSplit must skip local desktop");
  assert.ok(desktopShell.includes("if (isLocalDesktop) {\n        if (await tryLocalShellCreate()) return;\n      }"));

  // 3) PortalViewerModal and MobilePortalModal expose 60 FPS presets cleanly
  const viewerModal = readFileSync(join(ROOT, "apps/desktop/src/components/PortalViewerModal.tsx"), "utf8");
  assert.ok(viewerModal.includes('label: "流畅 · 60帧", fps: 60'));
  assert.ok(viewerModal.includes('label: "超清 · 60帧", fps: 60'));

  // 4) Mobile chat unifies step rows and detail composer wires Stop interrupt button
  const mobileChat = readFileSync(join(ROOT, "apps/mobile/src/components/chat.tsx"), "utf8");
  const mobileDetail = readFileSync(join(ROOT, "apps/mobile/src/components/detail.tsx"), "utf8");
  assert.ok(mobileChat.includes("friendlyToolMeta"), "mobile chat should map friendly pastel tool tiles");
  assert.ok(mobileChat.includes("MOBILE_PARTIAL_JSON_KEY_RE"), "mobile chat should unwrap raw JSON CommandLine strings");
  assert.ok(mobileDetail.includes('call(agent.deviceId, "terminal.interrupt"'), "mobile composer should wire circular Stop interrupt");
});

test("v0.2.43 binary P2P portal transport, DirectCipher rawBytes, honest transport resolution, and heartbeat store", () => {
  resetPortalClientStateForTest();

  // 1) Binary PKF1 packet roundtrip
  const rawImg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const pkt = encodeBinaryPortalStreamFrame(
    "s-bin-1",
    {
      portalId: "ptl-bin",
      seq: 7,
      mime: "image/jpeg",
      width: 1280,
      height: 800,
      url: "https://example.com",
      title: "Example",
      at: 123456,
    },
    rawImg,
  );
  const decoded = decodeBinaryPortalStreamFrame(pkt);
  assert.ok(decoded, "expected PKF1 binary packet to decode");
  assert.equal(decoded.id, "s-bin-1");
  assert.equal(decoded.meta.portalId, "ptl-bin");
  assert.equal(decoded.meta.seq, 7);
  assert.deepEqual([...decoded.bytes], [...rawImg]);

  // 2) DirectCipher.sealBytes / openBytes mixed with JSON text frames
  const key = new Uint8Array(32).fill(0x5a);
  const hostCipher = new DirectCipher(jsChaCha20Poly1305, key, 1); // DIRECT_FROM_HOST
  const viewerCipher = new DirectCipher(jsChaCha20Poly1305, key, 2); // DIRECT_FROM_PHONE
  const sealedText = hostCipher.seal(JSON.stringify({ type: "pong", t: 100 }));
  assert.equal(viewerCipher.open(sealedText), JSON.stringify({ type: "pong", t: 100 }));
  const sealedBin = hostCipher.sealBytes(pkt);
  const openedBin = viewerCipher.openBytes(sealedBin);
  assert.ok(openedBin, "expected DirectCipher.openBytes to decrypt raw binary packet");
  assert.deepEqual([...openedBin], [...pkt]);

  // 3) Address classification and honest resolvePortalTransport (never trusts static transportHint)
  assert.equal(classifyDirectLinkKind("127.0.0.1", "ws"), "local");
  assert.equal(classifyDirectLinkKind("100.64.12.34", "ws"), "vpn-p2p");
  assert.equal(classifyDirectLinkKind("fd7a:115c:a1e0::1", "ws"), "vpn-p2p");
  assert.equal(classifyDirectLinkKind("192.168.1.25", "ws"), "lan-p2p");
  assert.equal(classifyDirectLinkKind("192.168.1.25", "webrtc"), "webrtc-p2p");

  const relayResolved = resolvePortalTransport("remote-host", "local-host", null);
  assert.equal(relayResolved.isDirect, false);
  assert.equal(relayResolved.kind, "relay");
  assert.equal(relayResolved.label, "中继转发");

  // 4) portal_heartbeat and binary portal_frame ingestion + closed cleanup
  const item = {
    id: "ptl-hb",
    hostId: "remote-host",
    agentKey: "remote-host/hc:s1",
    kind: "browser" as const,
    title: "Example",
    canInteract: true,
    transportHint: "p2p" as const,
    createdAt: 1000,
    updatedAt: 1000,
  };
  ingestPortalStreamEvent({ kind: "portal_event", action: "opened", item, at: 1000 }, "remote-host");
  ingestPortalStreamEvent(
    {
      kind: "portal_frame",
      portalId: "ptl-hb",
      seq: 1,
      mime: "image/jpeg",
      data: "",
      rawBytes: rawImg,
      width: 1280,
      height: 800,
      at: 1010,
    },
    "remote-host",
  );
  const storedFrame = portalStore.get().framesById["ptl-hb"];
  assert.ok(storedFrame?.rawBytes);
  assert.equal(storedFrame?.byteLength, rawImg.byteLength);
  assert.equal(storedFrame?.transport, "relay");

  ingestPortalStreamEvent({ kind: "portal_heartbeat", portalId: "ptl-hb", fps: 60, idle: true, at: 1850 }, "remote-host");
  assert.equal(portalStore.get().heartbeatsById["ptl-hb"]?.idle, true);
  assert.equal(portalStore.get().heartbeatsById["ptl-hb"]?.fps, 60);

  ingestPortalStreamEvent({ kind: "portal_event", action: "closed", item, at: 2000 }, "remote-host");
  assert.equal(portalStore.get().heartbeatsById["ptl-hb"], undefined);
  resetPortalClientStateForTest();
});

test("slash commands support leading backslash trigger, canonical parsing, and synced CLI panels", () => {
  assert.equal(extractSlashQuery("\\"), "");
  assert.equal(extractSlashQuery("\\sw"), "sw");
  assert.equal(extractSlashQuery("  \\think"), "think");
  assert.equal(extractSlashQuery("\\swarm board"), null);

  const agy = builtinSlashCommands("antigravity");
  const claude = builtinSlashCommands("claude-code");
  assert.ok(agy.some((c) => c.name === "/swarm"));
  assert.ok(agy.some((c) => c.name === "/thinking"));
  assert.ok(claude.some((c) => c.name === "/swarm"));
  assert.ok(claude.some((c) => c.name === "/tasks"));
  assert.ok(claude.some((c) => c.name === "/thinking"));

  const matched = matchSlashCommands(agy, "\\swarm");
  assert.equal(matched[0]?.name, "/swarm");

  const parsed = parseLeadingSlashToken("\\btw check status", agy);
  assert.ok(parsed);
  assert.equal(parsed.rawToken, "/btw");
  assert.equal(parsed.rest, "check status");
});

test("SessionPortalPiP prevents cursor self-warp, defaults to collapsed capsule, and supports fan/tile/cascade modes", () => {
  const spec = configKeySpec("general.portalDisplayMode");
  assert.ok(spec);
  assert.equal(spec.default, "collapsed");
  assert.deepEqual(spec.values, ["collapsed", "fan", "tile", "cascade"]);

  const pipSrc = readFileSync(join(ROOT, "apps/desktop/src/components/SessionPortalPiP.tsx"), "utf8");
  const modalSrc = readFileSync(join(ROOT, "apps/desktop/src/components/PortalViewerModal.tsx"), "utf8");
  const cssSrc = readFileSync(join(ROOT, "apps/desktop/src/styles/app.css"), "utf8");
  const framePanesSrc = readFileSync(join(ROOT, "apps/desktop/src/views/settings/FramePanes.tsx"), "utf8");
  const panesSrc = readFileSync(join(ROOT, "apps/desktop/src/views/settings/Panes.tsx"), "utf8");

  // Direct control never auto-enabled or sending passive hover move in PiP
  assert.match(pipSrc, /useState\(false\)/);
  assert.doesNotMatch(pipSrc, /const \[directControl, setDirectControl\] = useState\(isActive\)/);
  assert.match(pipSrc, /!\(isSameLocalHost && item\.kind === "window"\)/);
  assert.match(pipSrc, /if \(!canDirectControl \|\| !pipDragBtnRef\.current\) return;/);

  // Respects user setting (collapsed default) and supports dynamic fan (1,2,3,4 live cards) + tile + cascade
  assert.match(pipSrc, /settingsStore\.use\(\(s\) => s\.portalDisplayMode\)/);
  assert.match(pipSrc, /if \(preferredMode !== "collapsed" \|\| userExpandedRef\.current\)/);
  assert.match(pipSrc, /PIP_FAN_STEP_Y = 34/);
  assert.match(pipSrc, /hoveredBackIdx/);
  assert.match(pipSrc, /fanPeekExpandY/);
  assert.match(pipSrc, /inDeckBack/);
  assert.match(pipSrc, /session-portal-stack-bar is-compact/);
  assert.match(pipSrc, /session-portal-card-num/);
  assert.match(pipSrc, /session-portal-tile-grid/);
  assert.match(cssSrc, /\.session-portal-pip\.is-tile\s*\{/);
  assert.match(cssSrc, /\.session-portal-tile-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);

  // Full modal also defaults local same-host window previews to read-only ("view")
  assert.match(modalSrc, /!isRemoteHost && item\.kind === "window"[\s\S]*?setControlMode\("view"\)/);

  // hostd macOS helper guards against warping cursor out of frontmost Herdr Pocket
  const osCaptureSrc = readFileSync(join(ROOT, "apps/hostd/src/portal/osCapture.ts"), "utf8");
  assert.match(osCaptureSrc, /isLocalPocketFrontmost\(\)/);

  // Settings panes expose the display mode selector
  assert.match(framePanesSrc, /PortalDisplayModeControl/);
  assert.match(panesSrc, /<PortalDisplayModeRow \/>/);

  // 60fps local binary fast-path + smart PiP hover intent & per-card FPS governance
  const portalClientSrc = readFileSync(join(ROOT, "apps/desktop/src/lib/portalClient.ts"), "utf8");
  assert.match(portalClientSrc, /localPortalCaptureFrame/);
  assert.match(pipSrc, /hoverTimerRef/);
  assert.match(pipSrc, /fps=\{isHovered \? 24 : 0\}/);
  assert.match(pipSrc, /pipFps >= 2 && !heartbeat\?\.idle/);
});
