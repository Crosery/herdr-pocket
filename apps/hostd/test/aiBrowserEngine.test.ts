import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AiBrowserEngine } from "../src/aiBrowserEngine.ts";
import {
  BrowserPluginError,
  getBrowserStatus,
  runBrowserAct,
  runBrowserNet,
  runBrowserScript,
  startResidentBrowserBridge,
  stopResidentBrowserBridge,
} from "../src/browserPlugin.ts";
import { readFileSlice, sanitizeRequestedFilePath } from "../src/files.ts";
import { findChromiumBinary, parseCdpKeyChord } from "../src/portal/cdpBrowser.ts";
import { selectMatchingEgoSpaceWindow } from "../src/portal/egoSpace.ts";

test("parseCdpKeyChord builds real CDP key payloads for Enter and cross-platform ControlOrMeta chords", () => {
  const enter = parseCdpKeyChord("Enter");
  assert.equal(enter.def.key, "Enter");
  assert.equal(enter.def.code, "Enter");
  assert.equal(enter.def.windowsVirtualKeyCode, 13);
  assert.equal(enter.def.text, "\r");
  assert.equal(enter.modifiers, 0);

  const macSelectAll = parseCdpKeyChord("ControlOrMeta+a", [], "darwin");
  assert.equal(macSelectAll.def.key, "a");
  assert.equal(macSelectAll.def.code, "KeyA");
  assert.equal(macSelectAll.def.windowsVirtualKeyCode, 65);
  assert.equal(macSelectAll.modifiers, 4); // Meta on macOS

  const winSelectAll = parseCdpKeyChord("ControlOrMeta+a", [], "win32");
  assert.equal(winSelectAll.modifiers, 2); // Ctrl on Windows

  const linuxSelectAll = parseCdpKeyChord("ControlOrMeta+a", [], "linux");
  assert.equal(linuxSelectAll.modifiers, 2); // Ctrl on Linux

  const shiftTab = parseCdpKeyChord("Shift+Tab");
  assert.equal(shiftTab.def.key, "Tab");
  assert.equal(shiftTab.def.windowsVirtualKeyCode, 9);
  assert.equal(shiftTab.modifiers, 8);
});

test("findChromiumBinary honors explicit HERDR_POCKET_CHROME_BIN override across platforms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-chrome-bin-"));
  const fakeBin = join(dir, "chrome-headless-shell");
  try {
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", "utf8");
    const foundMac = await findChromiumBinary("darwin", { HERDR_POCKET_CHROME_BIN: fakeBin }, { preferHeadlessShell: true });
    const foundLin = await findChromiumBinary("linux", { HERDR_POCKET_CHROME_BIN: fakeBin }, { preferHeadlessShell: true });
    const foundWin = await findChromiumBinary("win32", { HERDR_POCKET_CHROME_BIN: fakeBin }, { preferHeadlessShell: true });
    assert.equal(foundMac, fakeBin);
    assert.equal(foundLin, fakeBin);
    assert.equal(foundWin, fakeBin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectMatchingEgoSpaceWindow refuses to hijack an unrelated existing browser window", () => {
  const oldPersonalWindow = {
    id: "win-old-1",
    appName: "Ego Lite",
    title: "Personal Inbox — Gmail",
  };
  const allSpaces = [
    {
      id: 1,
      name: "Personal",
      taskId: "task-personal",
      createdBy: "user",
      ownership: "user",
      recentTabTitles: ["Personal Inbox — Gmail"],
    },
    {
      id: 2,
      name: "Bilibili Research",
      taskId: "task-bili",
      createdBy: "ai",
      ownership: "ai",
      recentTabTitles: ["国际空间站 - 搜索结果"],
    },
  ];

  const matchedOtherSpace = selectMatchingEgoSpaceWindow(
    [oldPersonalWindow],
    { spaceId: 2, spaceName: "Bilibili Research", activeTabTitle: "国际空间站 - 搜索结果" },
    allSpaces,
  );
  assert.equal(matchedOtherSpace, undefined);

  const matchedSpecificTitle = selectMatchingEgoSpaceWindow(
    [oldPersonalWindow],
    { spaceId: 2, spaceName: "Bilibili Research", activeTabTitle: "国际空间站 - 搜索结果" },
    [allSpaces[1]!],
  );
  assert.equal(matchedSpecificTitle, undefined);

  const matchedRightWindow = selectMatchingEgoSpaceWindow(
    [
      oldPersonalWindow,
      { id: "win-ai-2", appName: "Ego Lite", title: "国际空间站 - 搜索结果 - 哔哩哔哩" },
    ],
    { spaceId: 2, spaceName: "Bilibili Research", activeTabTitle: "国际空间站 - 搜索结果" },
    allSpaces,
  );
  assert.equal(matchedRightWindow?.id, "win-ai-2");
});

test("sanitizeRequestedFilePath and smart file resolution locate malformed, quoted, and truncated artifact paths safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-smart-files-"));
  const ws = join(root, "workspace");
  const brain = join(root, "brain");
  const convId = "a1f764a6-81ca-4c79-a92f-dd19b1e430ca";
  const artifactDir = join(brain, convId);
  const artifactFile = join(artifactDir, "architecture-overview.html");
  const secretFile = join(ws, ".env");

  try {
    mkdirSync(ws, { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactFile, "<h1>Architecture Overview</h1>", "utf8");
    writeFileSync(secretFile, "SECRET=do-not-leak\n", "utf8");

    assert.equal(
      sanitizeRequestedFilePath('file:///Users/demo/.gemini/antigravity-\ncli/brain/a1f764a6/overview.html"'),
      "/Users/demo/.gemini/antigravity-cli/brain/a1f764a6/overview.html",
    );

    // 1. Truncated UUID/filename with accidental trailing quote (matches image-145 bug)
    const hitTruncated = await readFileSlice(
      ws,
      { path: `${convId}/architecture-overview.html"`, offset: 0, maxBytes: 1024 },
      { extraRoots: [brain] },
    );
    assert.equal(hitTruncated.binary, false);
    assert.match(hitTruncated.text ?? "", /Architecture Overview/);

    // 2. Hard-wrapped file:// URI with newline split inside directory name
    const wrappedUri = `file://${artifactFile.slice(0, artifactFile.length - 12)}\n${artifactFile.slice(artifactFile.length - 12)}`;
    const hitWrapped = await readFileSlice(
      ws,
      { path: wrappedUri, offset: 0, maxBytes: 1024 },
      { extraRoots: [brain] },
    );
    assert.match(hitWrapped.text ?? "", /Architecture Overview/);

    // 3. Private files MUST still be strictly forbidden
    await assert.rejects(
      () => readFileSlice(ws, { path: ".env", offset: 0, maxBytes: 1024 }, { extraRoots: [brain] }),
      (err: unknown) => (err as { code?: string })?.code === "forbidden",
    );

    // 4. Outside-root system paths MUST still be rejected (bad_request)
    await assert.rejects(
      () => readFileSlice(ws, { path: "/etc/passwd", offset: 0, maxBytes: 1024 }, { extraRoots: [] }),
      (err: unknown) => (err as { code?: string })?.code === "bad_request",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resident hostd browser HTTP bridge enforces Bearer auth, disabled gate, and doctor/status round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-resident-bridge-"));
  const bridgePath = join(dir, "hostd-browser.json");
  const cfgOff = join(dir, "cfg-off.json");
  const cfgOn = join(dir, "cfg-on.json");
  writeFileSync(cfgOff, JSON.stringify({ plugins: { aiBrowser: false } }), "utf8");
  writeFileSync(cfgOn, JSON.stringify({ plugins: { aiBrowser: true } }), "utf8");

  const engine = new AiBrowserEngine({ profileRoot: join(dir, "profile") });
  try {
    await startResidentBrowserBridge(engine, { bridgePath, configPath: cfgOn });

    const status = await getBrowserStatus({ bridgePath, configPath: cfgOn });
    assert.equal(status.enabled, true);
    assert.equal(status.resident, true);
    assert.equal(Array.isArray(status.spaces), true);

    const doc = await runBrowserAct({ op: "doctor" }, { bridgePath, configPath: cfgOn });
    assert.equal(doc.ok, true);
    assert.equal(typeof doc.doctor?.platform, "string");

    // Disabled config must reject act/net/run without launching Chromium
    await assert.rejects(
      () => runBrowserAct({ op: "open", url: "https://example.com" }, { bridgePath, configPath: cfgOff }),
      (err: unknown) => err instanceof BrowserPluginError && err.code === "unsupported",
    );
    await assert.rejects(
      () => runBrowserNet({ action: "list" }, { bridgePath, configPath: cfgOff }),
      (err: unknown) => err instanceof BrowserPluginError && err.code === "unsupported",
    );
    await assert.rejects(
      () => runBrowserScript({ script: "return 1;" }, { bridgePath, configPath: cfgOff }),
      (err: unknown) => err instanceof BrowserPluginError && err.code === "unsupported",
    );
  } finally {
    await stopResidentBrowserBridge();
    engine.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
