import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { DIRECT_PORTAL_FS_PREFIX, type PortalStreamEvent } from "@herdr-pocket/protocol";
import { DirectServer } from "../src/direct.ts";
import { Host } from "../src/host.ts";
import { CdpBrowserPool, findChromiumBinary } from "../src/portal/cdpBrowser.ts";
import { PortalManager } from "../src/portal/index.ts";
import {
  MAC_SWIFT_SRC,
  OsCaptureDriver,
  computeCapabilities,
  defaultExecBin,
  detectPortalSession,
  resolveLinuxGuiEnv,
} from "../src/portal/osCapture.ts";
import { PortalFileTicketStore, bundleHtmlForRelay, readChunkForRpc } from "../src/portal/p2pFiles.ts";
import {
  PortalHookServer,
  TerminalInputLineTracker,
  extractAutoPortalIntents,
  extractCommandFromTerminalScreenLine,
  parseOpenerArgs,
} from "../src/portal/shims.ts";
import { UnifloAdapter } from "../src/uniflo.ts";

test("PortalFileTicketStore + DirectServer serve /v1/portal-fs HTTP files, Ranges, CORS, and block traversal/private files", async (t) => {
  const rawRoot = mkdtempSync(join(tmpdir(), "hp-portal-fs-"));
  t.after(() => rmSync(rawRoot, { recursive: true, force: true }));
  const root = realpathSync.native(rawRoot);
  const sub = join(root, "docs");
  const privDir = join(root, "secret-cfg");
  mkdirSync(sub, { recursive: true });
  mkdirSync(privDir, { recursive: true });

  writeFileSync(
    join(sub, "index.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="dot.svg"><script src="app.js"></script><script src="https://example.com/ext.js"></script></body></html>',
  );
  writeFileSync(join(sub, "style.css"), "body{color:#ff80aa}");
  writeFileSync(join(sub, "app.js"), 'window.__ok=true;console.log("</script>");');
  writeFileSync(join(sub, "dot.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>');
  writeFileSync(join(sub, "media.bin"), "0123456789ABCDEF");
  writeFileSync(join(sub, ".env"), "SECRET_KEY=do_not_leak");
  writeFileSync(join(privDir, "hostd.json"), '{"token":"abc"}');
  writeFileSync(join(root, "outside.txt"), "parent");
  try {
    symlinkSync(join(root, "outside.txt"), join(sub, "escape-link.txt"));
  } catch {
    // symlink may require privilege on win32
  }

  const store = new PortalFileTicketStore();
  const ds = new DirectServer({
    port: 0,
    hostId: () => "host-test",
    onFrame: () => {},
    onClose: () => {},
    onHttpRequest: (req, res) => store.handleHttpRequest(req, res),
  });
  await ds.start();
  const port = ds.port!;
  t.after(() => ds.stop());

  const filesOpts = { extraRoots: [root], privateDirs: [privDir] };
  const ticket = await store.issueTicket({
    agentCwd: sub,
    path: join(sub, "index.html"),
    filesOpts,
    port,
    addrs: ["127.0.0.1"],
  });

  const base = `http://127.0.0.1:${port}${DIRECT_PORTAL_FS_PREFIX}/${ticket.token}`;
  const rHtml = await fetch(`${base}/index.html`);
  assert.equal(rHtml.status, 200);
  assert.equal(rHtml.headers.get("access-control-allow-origin"), "*");
  assert.match(rHtml.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await rHtml.text(), /style\.css/);

  const rCss = await fetch(`${base}/style.css`);
  assert.equal(rCss.status, 200);
  assert.equal(await rCss.text(), "body{color:#ff80aa}");

  const rHead = await fetch(`${base}/media.bin`, { method: "HEAD" });
  assert.equal(rHead.status, 200);
  assert.equal(rHead.headers.get("accept-ranges"), "bytes");
  assert.equal(rHead.headers.get("content-length"), "16");

  const rRange = await fetch(`${base}/media.bin`, { headers: { Range: "bytes=2-5" } });
  assert.equal(rRange.status, 206);
  assert.equal(rRange.headers.get("content-range"), "bytes 2-5/16");
  assert.equal(await rRange.text(), "2345");

  const rBadRange = await fetch(`${base}/media.bin`, { headers: { Range: "bytes=999-1000" } });
  assert.equal(rBadRange.status, 416);

  const rTrav = await fetch(`${base}/..%2Foutside.txt`);
  assert.equal(rTrav.status, 403);

  const rEnv = await fetch(`${base}/.env`);
  assert.equal(rEnv.status, 403);

  const rPriv = await fetch(`${base}/..%2Fsecret-cfg/hostd.json`).catch(() => null);
  if (rPriv) assert.equal(rPriv.status, 403);

  // Relay fallback helpers: bundleHtmlForRelay & readChunkForRpc
  const bundled = await bundleHtmlForRelay(sub, { path: "index.html" }, filesOpts);
  assert.match(bundled.html, /<style>body\{color:#ff80aa\}<\/style>/);
  assert.match(bundled.html, /window\.__ok=true/);
  assert.match(bundled.html, /data:image\/svg\+xml;base64,/);
  assert.match(bundled.html, /https:\/\/example\.com\/ext\.js/);
  assert.doesNotMatch(bundled.html, /SECRET_KEY/);

  // Workspace-relative ../ assets, CSS url(...), and ES module scripts should bundle cleanly within workspace root
  const nestedDir = join(sub, "pages");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(sub, "shared.css"), ".bg{background:url('./dot.svg')}");
  writeFileSync(join(nestedDir, "dep.js"), "export const val = 42;");
  writeFileSync(join(nestedDir, "mod.js"), "import { val } from './dep.js'; window.__mod = val;");
  writeFileSync(
    join(nestedDir, "view.html"),
    '<!doctype html><html><head><link rel="stylesheet" href="../shared.css"></head><body><script type="module" src="./mod.js"></script><script src="../.env"></script></body></html>',
  );
  const nestedBundle = await bundleHtmlForRelay(sub, { path: "pages/view.html" }, filesOpts);
  assert.match(nestedBundle.html, /\.bg\{background:url\("data:image\/svg\+xml;base64,/);
  assert.match(nestedBundle.html, /data:text\/javascript;base64,/);
  assert.match(nestedBundle.html, /window\.__mod = val/);
  assert.match(nestedBundle.html, /src="\.\.\/\.env"/);
  assert.doesNotMatch(nestedBundle.html, /SECRET_KEY/);

  const c1 = await readChunkForRpc(sub, { path: "media.bin", offset: 0, length: 6 }, filesOpts);
  assert.equal(Buffer.from(c1.base64, "base64").toString("utf8"), "012345");
  assert.equal(c1.eof, false);
  const c2 = await readChunkForRpc(sub, { path: "media.bin", offset: 6, length: 20 }, filesOpts);
  assert.equal(Buffer.from(c2.base64, "base64").toString("utf8"), "6789ABCDEF");
  assert.equal(c2.eof, true);
});

test("parseOpenerArgs + PortalHookServer handle open, open -R, xdg-open, gio open, explorer /select, and secret auth", async (t) => {
  assert.deepEqual(parseOpenerArgs("open", ["-R", "docs/out.html"], "/work/repo"), {
    kind: "reveal",
    target: resolve("/work/repo", "docs/out.html"),
    reveal: true,
  });
  assert.deepEqual(parseOpenerArgs("open", ["https://localhost:8787/callback"]), {
    kind: "browser",
    target: "https://localhost:8787/callback",
    url: "https://localhost:8787/callback",
    reveal: false,
  });
  assert.deepEqual(parseOpenerArgs("xdg-open", ["report.pdf"], "/tmp/ws"), {
    kind: "file",
    target: resolve("/tmp/ws", "report.pdf"),
    reveal: false,
  });
  assert.deepEqual(parseOpenerArgs("gio", ["open", "preview.html"], "/tmp/ws"), {
    kind: "html",
    target: resolve("/tmp/ws", "preview.html"),
    reveal: false,
  });
  assert.equal(parseOpenerArgs("gio", ["info", "preview.html"], "/tmp/ws"), null);
  assert.equal(parseOpenerArgs("explorer.exe", ["/select,C:\\demo\\pic.png"])?.reveal, true);

  const dir = mkdtempSync(join(tmpdir(), "hp-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen: unknown[] = [];
  const server = new PortalHookServer({
    dir,
    secret: "top-secret-hex",
    onOpen: async (payload) => {
      seen.push(payload);
      return { handled: true, id: "ptl-1" };
    },
  });
  const port = await server.start();
  t.after(() => server.stop());

  const bad = await fetch(`http://127.0.0.1:${port}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-portal-secret": "wrong" },
    body: JSON.stringify({ tool: "open", argv: ["-R", "/tmp/a.txt"] }),
  });
  assert.equal(bad.status, 401);

  const ok = await fetch(`http://127.0.0.1:${port}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-portal-secret": "top-secret-hex" },
    body: JSON.stringify({ tool: "open", argv: ["-R", "/tmp/a.txt"], terminalId: "t9" }),
  });
  assert.equal(ok.status, 200);
  const json = (await ok.json()) as { handled: boolean; id: string };
  assert.equal(json.handled, true);
  assert.equal(json.id, "ptl-1");
  assert.equal(seen.length, 1);
});

test("osCapture detects macOS, Windows, Linux X11, Wayland wlroots/KDE/GNOME, systemd socket discovery, and headless", () => {
  assert.equal(detectPortalSession({ platform: "darwin", env: {} }).sessionType, "macos");
  assert.equal(detectPortalSession({ platform: "win32", env: {} }).sessionType, "win32");

  // Linux X11 with maim + xdotool + wmctrl
  const x11Caps = computeCapabilities({
    hasCdpBrowser: true,
    deps: {
      platform: "linux",
      env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "XFCE" },
      hasCmd: (c) => ["wmctrl", "maim", "xdotool"].includes(c),
    },
  });
  assert.equal(x11Caps.sessionType, "x11");
  assert.equal(x11Caps.canListWindows, true);
  assert.equal(x11Caps.canCaptureWindow, true);
  assert.equal(x11Caps.canInjectInput, true);

  // Linux Wayland wlroots (Hyprland & Sway)
  assert.equal(
    detectPortalSession({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "abc" },
    }).sessionType,
    "wayland-wlroots",
  );
  const swayCaps = computeCapabilities({
    hasCdpBrowser: false,
    deps: {
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/user/1000/sway.sock", XDG_CURRENT_DESKTOP: "sway" },
      hasCmd: (c) => ["swaymsg", "grim", "ydotool"].includes(c),
    },
  });
  assert.equal(swayCaps.sessionType, "wayland-wlroots");
  assert.equal(swayCaps.canListWindows, true);
  assert.equal(swayCaps.canCaptureWindow, true);
  assert.equal(swayCaps.canInjectInput, true);

  // Linux Wayland KDE & GNOME
  assert.equal(
    detectPortalSession({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE", KDE_FULL_SESSION: "true" },
    }).sessionType,
    "wayland-kde",
  );
  assert.equal(
    detectPortalSession({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
    }).sessionType,
    "wayland-gnome",
  );

  // Systemd service auto-discovery from /run/user/<uid>
  const discovered = resolveLinuxGuiEnv({
    env: {},
    uid: () => 1000,
    pathExists: (p) => p === "/run/user/1000",
    readDir: () => ["bus", "wayland-0"],
  });
  assert.equal(discovered.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(discovered.XDG_SESSION_TYPE, "wayland");

  // Headless Linux
  const headless = computeCapabilities({
    hasCdpBrowser: true,
    deps: {
      platform: "linux",
      env: {},
      pathExists: () => false,
      readDir: () => [],
    },
  });
  assert.equal(headless.sessionType, "headless");
  assert.equal(headless.canCaptureScreen, false);
  assert.equal(headless.hasCdpBrowser, true);
});

test("TerminalInputLineTracker reconstructs lines across CSI, Backspace, Ctrl+W/C/U, and bracketed paste", () => {
  const tracker = new TerminalInputLineTracker();
  assert.deepEqual(tracker.feed("a1", "open\x1b[A ./fo"), []);
  assert.deepEqual(tracker.feed("a1", "o\x7f.html\r"), ["open ./fo.html"]);
  assert.deepEqual(tracker.feed("a1", "\n"), []); // ignores \n immediately after \r
  assert.deepEqual(tracker.feed("a1", "ls -la\x03open\t-R src\r\n"), ["open -R src"]);
  assert.deepEqual(tracker.feed("a1", "git status\x17open app.html\r"), ["git open app.html"]);
  assert.deepEqual(tracker.feed("a1", "\x1b[200~ego-browser nodejs -e 'go()' \x1b[201~\r"), ["ego-browser nodejs -e 'go()'"]);
  assert.deepEqual(tracker.feed("a1", "echo wrong\x15open ok.png\n"), ["open ok.png"]);
});

test("extractAutoPortalIntents parses open, open -R, open -a, cd && open, ego-browser, and ignores quoted text", () => {
  assert.deepEqual(extractAutoPortalIntents("open a.html", "/work/app"), [
    { type: "opener", kind: "html", target: resolve("/work/app", "a.html"), reveal: false },
  ]);
  assert.deepEqual(extractAutoPortalIntents("open -R build/out.dmg", "/work/app"), [
    { type: "opener", kind: "reveal", target: resolve("/work/app", "build/out.dmg"), reveal: true },
  ]);
  assert.deepEqual(extractAutoPortalIntents("open -a Safari https://example.com"), [
    { type: "opener", kind: "browser", target: "https://example.com", url: "https://example.com", reveal: false, app: "Safari" },
  ]);
  assert.deepEqual(extractAutoPortalIntents('open -a "微信开发者工具"'), [
    { type: "app_window", appHint: "微信开发者工具", label: "微信开发者工具" },
  ]);
  assert.deepEqual(extractAutoPortalIntents("cd docs && open arch.html", "/work/app"), [
    { type: "opener", kind: "html", target: resolve("/work/app/docs", "arch.html"), reveal: false },
  ]);
  assert.deepEqual(
    extractAutoPortalIntents(
      "ego-browser nodejs <<'EOF'\nconst task = await taskSpace(\"login check\");\nawait page.goto(\"http://127.0.0.1:5173/home\");\nEOF",
    ),
    [{ type: "app_window", appHint: "ego lite", label: "ego lite · login check", url: "http://127.0.0.1:5173/home" }],
  );
  assert.deepEqual(extractAutoPortalIntents("ego-browser skill"), []);
  assert.deepEqual(extractAutoPortalIntents('git commit -m "open window" && echo "open a.html"'), []);
});

test("PortalManager auto-opens and deduplicates portals for terminal open input and Agent ego-browser calls", async (t) => {
  const rawRoot = mkdtempSync(join(tmpdir(), "hp-auto-portal-"));
  const state = mkdtempSync(join(tmpdir(), "hp-auto-state-"));
  t.after(() => {
    rmSync(rawRoot, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  const ws = realpathSync.native(rawRoot);
  writeFileSync(join(ws, "page.html"), "<html><body>ok</body></html>");

  const events: PortalStreamEvent[] = [];
  const fakeAgent = {
    key: "h1/hc:t1",
    deviceId: "h1",
    source: "hc" as const,
    localId: "t1",
    harness: "shell",
    where: "测试",
    cwd: ws,
    status: "idle" as const,
    isShell: true,
    updatedAt: Date.now(),
  };

  const mgr = new PortalManager({
    hostId: () => "h1",
    getAgents: () => [fakeAgent],
    getTerminals: () => new Map([["t1", { address: "t1", cwd: ws }]]),
    getFilesOptions: () => ({ extraRoots: [ws] }),
    getDirectInfo: () => ({ port: null, addrs: [], connectedCount: 0 }),
    hasRemoteViewers: () => true,
    onPortalEvent: (ev) => events.push(ev),
    stateDir: state,
    captureDeps: {
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "1" },
      hasCmd: (c) => ["hyprctl", "grim"].includes(c),
      execBin: async (cmd, args) => {
        if (cmd === "hyprctl") {
          return {
            code: 0,
            stderr: "",
            stdout: Buffer.from(
              JSON.stringify([
                { address: "0xego1", pid: 4242, class: "ego lite", title: "ego lite - Preview", size: [1280, 820], at: [10, 10] },
              ]),
            ),
          };
        }
        if (cmd === "grim" && args.includes("-")) {
          return { code: 0, stderr: "", stdout: Buffer.from("fake-jpeg-bytes") };
        }
        return { code: 1, stderr: "unexpected", stdout: Buffer.alloc(0) };
      },
    },
  });
  t.after(() => mgr.stop());

  mgr.observeTerminalInput(fakeAgent, "open page.html\r");
  for (let i = 0; i < 20 && !mgr.listPortals(fakeAgent.key).some((x) => x.kind === "html"); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const htmlItem = mgr.listPortals(fakeAgent.key).find((x) => x.kind === "html");
  assert.ok(htmlItem);
  assert.equal(htmlItem.targetPath, join(ws, "page.html"));

  mgr.inspectToolCallForPortal(fakeAgent, "run_command", {
    CommandLine: 'ego-browser nodejs -e "await page.goto(\\"http://127.0.0.1:4173/demo\\")"',
  });
  for (let i = 0; i < 25 && !mgr.listPortals(fakeAgent.key).some((x) => x.kind === "window"); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const winItems1 = mgr.listPortals(fakeAgent.key).filter((x) => x.kind === "window");
  assert.equal(winItems1.length, 1);
  assert.equal(winItems1[0]!.windowId, "hypr:0xego1");
  assert.equal(winItems1[0]!.url, "http://127.0.0.1:4173/demo");

  // Running another ego-browser command on the same agent updates the same window portal instead of duplicating.
  mgr.inspectToolCallForPortal(fakeAgent, "bash", {
    command: 'ego-browser nodejs -e "await page.goto(\\"http://127.0.0.1:4173/next\\")"',
  });
  await new Promise((r) => setTimeout(r, 80));
  const winItems2 = mgr.listPortals(fakeAgent.key).filter((x) => x.kind === "window");
  assert.equal(winItems2.length, 1);
  assert.equal(winItems2[0]!.url, "http://127.0.0.1:4173/next");
  assert.ok(events.some((e) => e.kind === "portal_frame" && e.portalId === winItems2[0]!.id));
});

test("UnifloAdapter.rootSessionKey walks nested subagent parent pointers back to root session", async (t) => {
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url?.startsWith("/v1/sessions")) {
      res.end(
        JSON.stringify([
          { key: "claude:root", harness: "claude-code", updated_at: 300, status: "work" },
          { key: "claude:sub1", harness: "claude-code", parent: "claude:root", updated_at: 310, status: "work" },
          { key: "claude:sub2", harness: "claude-code", parent: "claude:sub1", updated_at: 320, status: "work" },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolveListen) => srv.listen(0, "127.0.0.1", resolveListen));
  t.after(() => srv.close());
  const port = (srv.address() as { port: number }).port;
  const u = new UnifloAdapter(`http://127.0.0.1:${port}`);
  t.after(() => u.stop());
  u.start(() => {});
  for (let i = 0; i < 30 && u.rootSessionKey("claude:sub2") !== "claude:root"; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(u.rootSessionKey("claude:sub2"), "claude:root");
  assert.equal(u.rootSessionKey("claude:sub1"), "claude:root");
  assert.equal(u.rootSessionKey("claude:root"), "claude:root");
});

test("defaultExecBin resolves with code -1 instead of throwing unhandled rejection on timeout/SIGTERM", async () => {
  const res = await defaultExecBin(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 60);
  assert.equal(res.code, -1);
});

test("OsCaptureDriver.captureWindow coalesces concurrent calls and serves 45ms cache", async () => {
  let capCalls = 0;
  const driver = new OsCaptureDriver({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-1", HYPRLAND_INSTANCE_SIGNATURE: "1" },
    hasCmd: (c) => ["hyprctl", "grim"].includes(c),
    execBin: async (cmd) => {
      if (cmd === "hyprctl") {
        return { code: 0, stderr: "", stdout: Buffer.from("[]") };
      }
      if (cmd === "grim") {
        capCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return { code: 0, stderr: "", stdout: Buffer.from("jpeg-payload") };
      }
      return { code: 1, stderr: "", stdout: Buffer.alloc(0) };
    },
  });

  const [a, b] = await Promise.all([driver.captureWindow("screen:0"), driver.captureWindow("screen:0")]);
  assert.equal(capCalls, 1);
  assert.ok(a && b);
  assert.equal(a.data, b.data);

  const c = await driver.captureWindow("screen:0");
  assert.equal(capCalls, 1);
  assert.equal(c?.data, a.data);
});

test("osCapture handles WSLg, headless WSL X-Server hint, Linux X11 wmctrl/xdotool/xwininfo/xwd, and win32 WSL notes", async () => {
  // WSLg with /mnt/wslg/runtime-dir and XWayland routes to x11 capture safely
  const wslgEnv = resolveLinuxGuiEnv({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    pathExists: (p) => p === "/mnt/wslg/runtime-dir" || p === "/mnt/wslg/.X11-unix",
    readDir: (p) => (p === "/mnt/wslg/runtime-dir" ? ["wayland-0"] : p === "/mnt/wslg/.X11-unix" ? ["X0"] : []),
  });
  assert.equal(wslgEnv.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(wslgEnv.DISPLAY, ":0");
  const wslgSession = detectPortalSession({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    pathExists: (p) => p === "/mnt/wslg/runtime-dir" || p === "/mnt/wslg/.X11-unix",
    readDir: (p) => (p === "/mnt/wslg/runtime-dir" ? ["wayland-0"] : p === "/mnt/wslg/.X11-unix" ? ["X0"] : []),
  });
  assert.equal(wslgSession.sessionType, "x11");
  assert.equal(wslgSession.desktopEnv, "WSLg");

  // Headless WSL without DISPLAY / WSLg prints VcXsrv / X410 guidance note
  const wslHeadlessCaps = computeCapabilities({
    hasCdpBrowser: false,
    deps: {
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      pathExists: () => false,
      readDir: () => [],
    },
  });
  assert.equal(wslHeadlessCaps.sessionType, "headless");
  assert.ok(wslHeadlessCaps.notes?.some((n) => n.includes("VcXsrv") && n.includes("DISPLAY")));

  // Linux GNOME Wayland without gnome-screenshot or XWayland capture reports canCaptureWindow=false
  const gnomeNoCap = computeCapabilities({
    hasCdpBrowser: false,
    deps: {
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "GNOME" },
      hasCmd: (c) => c === "gdbus",
    },
  });
  assert.equal(gnomeNoCap.canCaptureWindow, false);

  // Linux X11: wmctrl -lpGx parses WM_CLASS, xwd+convert captures window frames
  const x11Driver = new OsCaptureDriver({
    platform: "linux",
    env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" },
    hasCmd: (c) => ["wmctrl", "xwd", "convert"].includes(c),
    execBin: async (cmd, args) => {
      if (cmd === "wmctrl" && args.includes("-lpGx")) {
        return {
          code: 0,
          stderr: "",
          stdout: Buffer.from("0x01200003  0 4412   100  80   900  640  Navigator.firefox host Mozilla Firefox\n"),
        };
      }
      if (cmd === "xwd") {
        const outIdx = args.indexOf("-out");
        if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, "xwd-bytes");
        return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
      }
      if (cmd === "convert") {
        writeFileSync(args[args.length - 1]!, "jpg-from-xwd");
        return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
      }
      return { code: 1, stderr: "", stdout: Buffer.alloc(0) };
    },
  });
  const x11Wins = await x11Driver.listWindows();
  const ff = x11Wins.find((w) => w.id === "0x01200003");
  assert.ok(ff);
  assert.equal(ff.appName, "firefox");
  assert.equal(ff.pid, 4412);
  const xwdCap = await x11Driver.captureWindow("0x01200003");
  assert.ok(xwdCap);
  assert.equal(Buffer.from(xwdCap.data, "base64").toString("utf8"), "jpg-from-xwd");

  // Windows win32 warns when wsl.exe exists without WSLg or X-Server process running
  const winNoX = new OsCaptureDriver({
    platform: "win32",
    env: {},
    hasCmd: (c) => c === "wsl.exe",
    pathExists: () => false,
    listProcesses: async () => [{ pid: 100, ppid: 4, name: "explorer.exe" }],
  });
  const note = await winNoX.checkPermissionNote();
  assert.ok(note?.includes("WSLg"));
});

test("shims extract Windows start, Start-Process, qlmanage, wsl GUI commands, and direct GUI binaries", () => {
  assert.deepEqual(extractAutoPortalIntents('cmd /c start "" https://localhost:3000/auth'), [
    { type: "opener", kind: "browser", target: "https://localhost:3000/auth", url: "https://localhost:3000/auth", reveal: false },
  ]);
  assert.deepEqual(extractAutoPortalIntents("Start-Process -FilePath msedge -ArgumentList https://example.com"), [
    { type: "opener", kind: "browser", target: "https://example.com", url: "https://example.com", reveal: false, app: "msedge" },
  ]);
  assert.deepEqual(extractAutoPortalIntents("qlmanage -p demo/chart.png", "/work/app"), [
    { type: "opener", kind: "file", target: resolve("/work/app", "demo/chart.png"), reveal: false },
  ]);
  assert.deepEqual(extractAutoPortalIntents("wsl -d Ubuntu DISPLAY=:0 xeyes"), [
    { type: "app_window", appHint: "xeyes", label: "X11 xeyes" },
  ]);
  assert.deepEqual(extractAutoPortalIntents('wsl -- bash -lc "xdg-open https://localhost:9000/login"'), [
    { type: "opener", kind: "browser", target: "https://localhost:9000/login", url: "https://localhost:9000/login", reveal: false },
  ]);
  assert.deepEqual(extractAutoPortalIntents("firefox http://127.0.0.1:8080"), [
    { type: "app_window", appHint: "Firefox", label: "Firefox", url: "http://127.0.0.1:8080" },
  ]);
});

test("PortalManager discovers child GUI windows via process tree and auto-closes dead portals", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "hp-ptree-"));
  const binDir = join(state, "bin");
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const events: PortalStreamEvent[] = [];
  const fakeAgent = {
    key: "h1/hc:t1",
    deviceId: "h1",
    source: "hc" as const,
    localId: "t1",
    harness: "shell",
    where: "测试",
    cwd: "/tmp",
    status: "idle" as const,
    isShell: true,
    updatedAt: Date.now(),
  };

  let mockWindows = [
    { id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true },
    { id: "100", appName: "Finder", title: "访达", pid: 100, bounds: { x: 0, y: 0, width: 800, height: 600 } },
  ];
  let mockProcs = [
    { pid: 1, ppid: 0, name: "launchd" },
    { pid: 100, ppid: 1, name: "Finder" },
    { pid: 500, ppid: 1, name: "zsh" },
    { pid: 510, ppid: 500, name: "python3" },
    { pid: 520, ppid: 510, name: "my-gui-app" },
  ];
  const terms = new Map([["t1", { address: "t1", cwd: "/tmp", pid: 500, foreground: { pid: 510, argv: ["python3", "app.py"] } }]]);

  const mgr = new PortalManager({
    hostId: () => "h1",
    getAgents: () => [fakeAgent],
    getTerminals: () => terms,
    getFilesOptions: () => ({ extraRoots: ["/tmp"] }),
    getDirectInfo: () => ({ port: null, addrs: [], connectedCount: 0 }),
    hasRemoteViewers: () => true,
    onPortalEvent: (ev) => events.push(ev),
    stateDir: state,
    captureDeps: {
      platform: "darwin",
      binDir,
      hasCmd: (c) => c === "swiftc",
      listProcesses: async () => mockProcs,
      execBin: async (cmd, args) => {
        if (cmd === "swiftc") {
          const outIdx = args.indexOf("-o");
          if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, "mock-bin");
          return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
        }
        if (args[0] === "list") return { code: 0, stderr: "", stdout: Buffer.from(JSON.stringify(mockWindows.slice(1))) };
        if (args[0] === "capture") return { code: 0, stderr: "dims:640x480\n", stdout: Buffer.from("jpg-frame") };
        return { code: 1, stderr: "", stdout: Buffer.alloc(0) };
      },
    },
  });
  // Seed baseline before child window opens
  await mgr.scanProcessTreePortals();
  assert.equal(mgr.listPortals(fakeAgent.key).length, 0);

  // Spawn child window owned by pid 520 -> 510 -> term 500
  mockWindows = [
    ...mockWindows,
    { id: "5201", appName: "my-gui-app", title: "Plot Preview", pid: 520, bounds: { x: 10, y: 10, width: 640, height: 480 } },
  ];
  await mgr.scanProcessTreePortals();
  const opened = mgr.listPortals(fakeAgent.key).filter((p) => p.kind === "window");
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.windowId, "5201");
  assert.ok(events.some((e) => e.kind === "portal_frame" && e.portalId === opened[0]!.id));

  // Window exits -> removed after 2 missed scans (> 1.2s wait simulated by closing manually via backdated wait not needed if we wait 1.25s? No, verify stay alive <1.2s and test close flow via explicit close check or fast sleep):
  mockWindows = mockWindows.filter((w) => w.id !== "5201");
  // Fast check inside <1200ms keeps it alive; after >1200ms + 2 misses it auto-closes:
  await new Promise((r) => setTimeout(r, 1250));
  await mgr.scanProcessTreePortals();
  assert.equal(mgr.listPortals(fakeAgent.key).length, 1);
  await mgr.scanProcessTreePortals();
  assert.equal(mgr.listPortals(fakeAgent.key).length, 0);
  mgr.stop();
});

test("PortalManager binds new Windows X-Server (vcxsrv) windows to recent WSL terminal", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "hp-winx-"));
  const binDir = join(state, "bin");
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const fakeAgent = {
    key: "h1/hc:w1",
    deviceId: "h1",
    source: "hc" as const,
    localId: "w1",
    harness: "shell",
    where: "WSL",
    cwd: "C:\\\\work",
    status: "idle" as const,
    isShell: true,
    updatedAt: Date.now(),
  };
  let winList: Array<{ id: string; appName: string; title: string; pid?: number; bounds: { x: number; y: number; width: number; height: number } }> = [];
  const terms = new Map([["w1", { address: "w1", cwd: "C:\\\\work", pid: 800, foreground: { pid: 810, argv: ["wsl.exe", "xeyes"] } }]]);
  const mgr = new PortalManager({
    hostId: () => "h1",
    getAgents: () => [fakeAgent],
    getTerminals: () => terms,
    getFilesOptions: () => ({ extraRoots: ["/tmp"] }),
    getDirectInfo: () => ({ port: null, addrs: [], connectedCount: 0 }),
    hasRemoteViewers: () => true,
    onPortalEvent: () => {},
    stateDir: state,
    captureDeps: {
      platform: "win32",
      binDir,
      hasCmd: () => false,
      listProcesses: async () => [{ pid: 9999, ppid: 4, name: "vcxsrv.exe" }],
      execBin: async (_cmd, args) => {
        const cmdStr = args.join(" ");
        if (/@\('list'\)/.test(cmdStr)) {
          return { code: 0, stderr: "", stdout: Buffer.from(JSON.stringify(winList)) };
        }
        const m = /@\('capture',\s*'[^']+',\s*'([^']+)'/.exec(cmdStr);
        if (m?.[1] === "-") {
          return {
            code: 0,
            stderr: "",
            stdout: Buffer.from(`dims:800x600|cursor:0.5000,0.5000,1|b64:${Buffer.from("win-xserver-jpg").toString("base64")}`),
          };
        }
        if (m?.[1]) writeFileSync(m[1], "win-xserver-jpg");
        return { code: 0, stderr: "", stdout: Buffer.from("dims:640x480|cursor:0.5000,0.5000,1") };
      },
    },
  });
  await mgr.scanProcessTreePortals();
  winList = [{ id: "778899", appName: "vcxsrv", title: "xeyes", pid: 9999, bounds: { x: 40, y: 40, width: 300, height: 260 } }];
  await mgr.scanProcessTreePortals();
  const portals = mgr.listPortals(fakeAgent.key);
  assert.equal(portals.length, 1);
  assert.equal(portals[0]!.windowId, "778899");
  assert.match(portals[0]!.title, /xeyes/);
  mgr.stop();
});

test("findChromiumBinary discovers Playwright Chromium and CdpBrowserPool serves concurrent tabs without SingletonLock", async (t) => {
  const homeTmp = mkdtempSync(join(tmpdir(), "hp-pw-home-"));
  t.after(() => rmSync(homeTmp, { recursive: true, force: true }));
  const pwShellBin = join(
    homeTmp,
    "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  );
  mkdirSync(join(homeTmp, "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64"), {
    recursive: true,
  });
  writeFileSync(pwShellBin, "stub");
  const foundPw = await findChromiumBinary("darwin", { HOME: homeTmp });
  assert.ok(foundPw);

  const profileRoot = mkdtempSync(join(tmpdir(), "hp-cdp-pool-"));
  t.after(() => rmSync(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const wsEntryUrl = pathToFileURL(createRequire(import.meta.url).resolve("ws")).href;
  const fakeScript = join(profileRoot, "fake-chrome.mjs");
  const fakeBin = fakeScript;
  const spawnsLog = join(profileRoot, "spawns.log");
  writeFileSync(
    fakeScript,
    `#!/usr/bin/env node
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import wsPkg from ${JSON.stringify(wsEntryUrl)};

const { WebSocketServer } = wsPkg;
const udArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
const userDataDir = udArg ? udArg.slice("--user-data-dir=".length) : "";
if (!/runtime-\\d+/.test(userDataDir)) process.exit(2);
const lockPath = join(userDataDir, "SingletonLock");
try {
  writeFileSync(lockPath, String(process.pid), { flag: "wx" });
} catch {
  process.exit(0);
}
appendFileSync(${JSON.stringify(spawnsLog)}, "spawn\\n");

const targets = new Map();
let seq = 0;
const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 0x41), Buffer.from([0xff, 0xd9])]).toString("base64");

let srvPort = 0;
const srv = createServer((req, res) => {
  if (req.url === "/json/list") {
    res.setHeader("content-type", "application/json");
    const list = [...targets.values()].map((tgt) => ({
      id: tgt.id,
      type: "page",
      url: tgt.url,
      title: tgt.title,
      webSocketDebuggerUrl: \`ws://127.0.0.1:\${srvPort}/devtools/page/\${tgt.id}\`,
    }));
    res.end(JSON.stringify(list));
    return;
  }
  res.statusCode = 404;
  res.end();
});
const wss = new WebSocketServer({ noServer: true });
srv.on("upgrade", (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, (ws) => {
    const url = req.url || "";
    if (url === "/devtools/browser/mock") {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.method === "Target.createTarget") {
          const id = \`tgt-\${++seq}\`;
          targets.set(id, { id, url: msg.params?.url || "about:blank", title: "about:blank" });
          ws.send(JSON.stringify({ id: msg.id, result: { targetId: id } }));
        } else if (msg.method === "Target.closeTarget") {
          targets.delete(msg.params?.targetId);
          ws.send(JSON.stringify({ id: msg.id, result: { success: true } }));
        } else {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
      return;
    }
    const targetId = url.split("/").pop() || "";
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      const tgt = targets.get(targetId);
      if (msg.method === "Page.navigate" && tgt) {
        tgt.url = msg.params?.url || tgt.url;
        tgt.title = \`Portal \${tgt.url}\`;
        ws.send(JSON.stringify({ id: msg.id, result: { frameId: "f1" } }));
        ws.send(JSON.stringify({ method: "Page.frameNavigated", params: { frame: { url: tgt.url } } }));
        ws.send(JSON.stringify({ method: "Page.loadEventFired", params: {} }));
      } else if (msg.method === "Page.getNavigationHistory" && tgt) {
        ws.send(JSON.stringify({ id: msg.id, result: { currentIndex: 0, entries: [{ id: 1, url: tgt.url, title: tgt.title }] } }));
      } else if (msg.method === "Page.captureScreenshot") {
        ws.send(JSON.stringify({ id: msg.id, result: { data: fakeJpeg } }));
      } else {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });
  });
});
srv.listen(0, "127.0.0.1", () => {
  srvPort = srv.address().port;
  process.stderr.write(\`\\nDevTools listening on ws://127.0.0.1:\${srvPort}/devtools/browser/mock\\n\`);
});
const shutdown = () => {
  try { rmSync(lockPath, { force: true }); } catch {}
  try { srv.close(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`,
  );
  if (process.platform !== "win32") chmodSync(fakeScript, 0o755);

  const prevChromeEnv = process.env.HERDR_POCKET_CHROME_BIN;
  process.env.HERDR_POCKET_CHROME_BIN = fakeBin;
  t.after(() => {
    if (prevChromeEnv === undefined) delete process.env.HERDR_POCKET_CHROME_BIN;
    else process.env.HERDR_POCKET_CHROME_BIN = prevChromeEnv;
  });

  const pool = new CdpBrowserPool(profileRoot);
  t.after(() => pool.closeAll());

  await Promise.all([
    pool.open("p1", "http://127.0.0.1:8764/?edition=winter&t=0.1"),
    pool.open("p2", "http://127.0.0.1:8764/?edition=summer"),
    pool.open("p3", "http://127.0.0.1:8764/?edition=autumn"),
  ]);

  assert.equal(readFileSync(spawnsLog, "utf8").trim().split("\n").length, 1);

  for (const id of ["p1", "p2", "p3"]) {
    const sess = pool.get(id);
    assert.ok(sess, `missing session ${id}`);
    const frame = sess.getLatestFrame() ?? (await sess.captureOnce(true));
    assert.ok(frame && frame.mime === "image/jpeg" && frame.data.length > 100);
    const bytes = Buffer.from(frame.data, "base64");
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
  }

  pool.close("p1");
  assert.equal(pool.get("p1"), undefined);
  const f2 = await pool.get("p2")!.captureOnce(true);
  assert.ok(f2 && f2.data.length > 100);
  pool.closeAll();
});

test("PortalManager surfaces streamError cleanly and short-circuits TCC-denied window retries", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "hp-err-portal-"));
  const binDir = join(state, "bin");
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const fakeAgent = {
    key: "h1/hc:t2x",
    deviceId: "h1",
    source: "hc" as const,
    localId: "t2x",
    harness: "shell",
    where: "测试",
    cwd: "/tmp",
    status: "idle" as const,
    isShell: true,
    updatedAt: Date.now(),
  };

  const mgr = new PortalManager({
    hostId: () => "h1",
    getAgents: () => [fakeAgent],
    getTerminals: () => new Map([["t2x", { address: "t2x", cwd: "/tmp" }]]),
    getFilesOptions: () => ({ extraRoots: ["/tmp"] }),
    getDirectInfo: () => ({ port: null, addrs: [], connectedCount: 0 }),
    hasRemoteViewers: () => true,
    onPortalEvent: () => {},
    stateDir: state,
    captureDeps: {
      platform: "darwin",
      binDir,
      hasCmd: (c) => c === "swiftc",
      execBin: async (cmd, args) => {
        if (cmd === "swiftc") {
          const outIdx = args.indexOf("-o");
          if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, "mock-bin");
          return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
        }
        if (args[0] === "check") {
          return { code: 0, stderr: "", stdout: Buffer.from(JSON.stringify({ screenCapture: false })) };
        }
        if (args[0] === "list") {
          return {
            code: 0,
            stderr: "",
            stdout: Buffer.from(
              JSON.stringify([{ id: "901", appName: "ego lite", title: "ego lite · demo", pid: 901, bounds: { x: 0, y: 0, width: 1000, height: 700 } }]),
            ),
          };
        }
        if (args[0] === "capture") return { code: 2, stderr: "screen_recording_denied", stdout: Buffer.alloc(0) };
        return { code: 1, stderr: "could not create image", stdout: Buffer.alloc(0) };
      },
    },
  });
  t.after(() => mgr.stop());

  const winRes = await mgr.openPortal({ agentKey: fakeAgent.key, kind: "window", windowId: "901" });
  assert.ok(winRes.item.streamError?.includes("屏幕录制"));

  mgr.browser.open = async () => {
    throw new Error("未安装 Chrome");
  };
  const startedAt = Date.now();
  mgr.inspectToolCallForPortal(fakeAgent, "run_command", {
    CommandLine: 'ego-browser nodejs -e "await page.goto(\\"http://127.0.0.1:8764/?edition=winter&t=0.1\\")"',
  });
  for (let i = 0; i < 30 && !mgr.listPortals(fakeAgent.key).some((x) => x.kind === "browser"); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1200, `expected TCC short-circuit < 1200ms, got ${elapsed}ms`);
  const browserPortal = mgr.listPortals(fakeAgent.key).find((x) => x.kind === "browser");
  assert.ok(browserPortal);
  assert.match(browserPortal.streamError ?? "", /未安装 Chrome/);
});

test(
  "OsCaptureDriver delegates macOS check/list/capture through Herdr Pocket desktop bridge socket and falls back cleanly",
  { skip: process.platform === "win32" },
  async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hp-sock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sockPath = join(dir, "desktop-portal.sock");
  const seen: string[][] = [];
  let allowScreen = false;

  const srv = createNetServer((conn) => {
    let buf = "";
    conn.on("data", (c) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { args: string[] };
      seen.push(req.args);
      if (req.args[0] === "check") {
        const out = Buffer.from(JSON.stringify({ screenCapture: allowScreen })).toString("base64");
        conn.end(`${JSON.stringify({ code: 0, stdoutBase64: out, stderr: "" })}\n`);
      } else if (req.args[0] === "list") {
        const out = Buffer.from(
          JSON.stringify([{ id: "77", appName: "ego lite", title: "bridge-win", pid: 77, bounds: { x: 0, y: 0, width: 800, height: 600 } }]),
        ).toString("base64");
        conn.end(`${JSON.stringify({ code: 0, stdoutBase64: out, stderr: "" })}\n`);
      } else if (req.args[0] === "capture") {
        if (!allowScreen) {
          conn.end(`${JSON.stringify({ code: 2, stdoutBase64: "", stderr: "screen_recording_denied" })}\n`);
        } else {
          conn.end(`${JSON.stringify({ code: 0, stdoutBase64: Buffer.from("fake-jpg").toString("base64"), stderr: "dims:640x480\n" })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolveListen) => srv.listen(sockPath, resolveListen));
  t.after(() => srv.close());

  let localExecCalled = 0;
  const driver = new OsCaptureDriver({
    platform: "darwin",
    binDir: join(dir, "bin"),
    portalBridgeSocket: sockPath,
    hasCmd: () => false,
    pathExists: (p) => p === sockPath,
    execBin: async () => {
      localExecCalled += 1;
      return { code: 1, stdout: Buffer.alloc(0), stderr: "" };
    },
  });

  const deniedNote = await driver.checkPermissionNote();
  assert.ok(deniedNote?.includes("Herdr Pocket"));
  assert.equal(localExecCalled, 0);

  const wins = await driver.listWindows();
  assert.ok(wins.some((w) => w.id === "77" && w.title === "bridge-win"));
  assert.equal(localExecCalled, 0);

  const deniedCap = await driver.captureWindow("77");
  assert.equal(deniedCap, null);

  allowScreen = true;
  const okCap = await driver.captureWindow("77");
  assert.equal(okCap?.width, 640);
  assert.equal(okCap?.height, 480);
  assert.equal(Buffer.from(okCap!.data, "base64").toString("utf8"), "fake-jpg");
  assert.equal(localExecCalled, 0);
  assert.ok(seen.some((a) => a[0] === "check"));
  assert.ok(seen.some((a) => a[0] === "capture"));

  // Missing socket falls back cleanly without throwing.
  const fallbackDriver = new OsCaptureDriver({
    platform: "darwin",
    binDir: join(dir, "bin-missing"),
    portalBridgeSocket: join(dir, "missing.sock"),
    hasCmd: () => false,
    pathExists: () => false,
    execBin: async () => {
      localExecCalled += 1;
      return { code: 1, stdout: Buffer.alloc(0), stderr: "" };
    },
  });
  const fbCap = await fallbackDriver.captureWindow("99");
  assert.equal(fbCap, null);
  assert.ok(localExecCalled >= 1);
});

test("OsCaptureDriver maps negative multi-display bounds, caches window list, and forwards drag/key/clipboard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hp-multi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const recorded: string[][] = [];
  let listCalls = 0;

  const driver = new OsCaptureDriver({
    platform: "darwin",
    binDir,
    hasCmd: (c) => c === "swiftc",
    execBin: async (_cmd, args) => {
      if (args.includes("-o")) {
        const outIdx = args.indexOf("-o");
        if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, "mock-bin");
        return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
      }
      recorded.push(args);
      if (args[0] === "check") {
        return { code: 0, stderr: "", stdout: Buffer.from(JSON.stringify({ screenCapture: true, accessibility: true })) };
      }
      if (args[0] === "list") {
        listCalls += 1;
        return {
          code: 0,
          stderr: "",
          stdout: Buffer.from(
            JSON.stringify([
              { id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true, displayIndex: 0, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1728, height: 1117 } },
              { id: "screen:1", appName: "macOS 桌面", title: "显示器 2", isScreen: true, displayIndex: 1, scaleFactor: 1, bounds: { x: -1760, y: -1440, width: 5120, height: 1440 } },
            ]),
          ),
        };
      }
      if (args[0] === "clipboard" && args[1] === "get") {
        return { code: 0, stderr: "", stdout: Buffer.from("copied-text-123") };
      }
      if (args[0] === "clipboard" && args[1] === "set") {
        return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
      }
      return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
    },
  });
  t.after(() => driver.dispose());

  // Negative-offset display bounds: (-1760 + 0.5*5120, -1440 + 0.25*1440) => (800, -1080)
  await driver.injectInput("screen:1", {
    type: "pointer",
    action: "drag",
    nx: 0.5,
    ny: 0.25,
    button: "left",
    modifiers: ["meta", "shift"],
  });
  await driver.injectInput("screen:1", { type: "pointer", action: "move", nx: 0.25, ny: 0.5, button: "left" });
  await driver.injectInput("screen:1", { type: "pointer", action: "down", nx: 0.25, ny: 0.5, button: "right" });
  await driver.injectInput("screen:1", { type: "pointer", action: "up", nx: 0.25, ny: 0.5, button: "right" });
  await driver.injectInput("screen:1", { type: "key", key: "Tab", modifiers: ["ctrl"], action: "down" });

  assert.equal(listCalls, 1, "windowsCache should prevent redundant list calls within cache TTL");
  const dragCall = recorded.find((a) => a[0] === "click" && a[4] === "drag");
  assert.deepEqual(dragCall, ["click", "800", "-1080", "left", "drag", "0", "meta,shift"]);
  const moveCall = recorded.find((a) => a[0] === "click" && a[4] === "move");
  assert.deepEqual(moveCall, ["click", "-480", "-720", "left", "move", "0", ""]);
  const downCall = recorded.find((a) => a[0] === "click" && a[4] === "down");
  assert.deepEqual(downCall, ["click", "-480", "-720", "right", "down", "0", ""]);
  const keyCall = recorded.find((a) => a[0] === "key");
  assert.deepEqual(keyCall, ["key", "Tab", "0", "ctrl", "down"]);

  const pulled = await driver.handleClipboard("get");
  assert.equal(pulled, "copied-text-123");
  await driver.handleClipboard("set", "hello-remote");
  const setCall = recorded.find((a) => a[0] === "clipboard" && a[1] === "set");
  assert.equal(setCall?.[2], Buffer.from("hello-remote", "utf8").toString("base64"));
});

test("PortalManager handles config updates, deduplicates unchanged frames, and Host drops buffered intermediate portal_frame", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "hp-mgr-dedup-"));
  const binDir = join(state, "bin");
  mkdirSync(binDir, { recursive: true });
  t.after(() => rmSync(state, { recursive: true, force: true }));

  let imgSeed = Buffer.from("frame-alpha");
  const fakeAgent = { key: "h1/hc:t1", deviceId: "h1", name: "t1", status: "idle", tool: "claude" } as any;
  const mgr = new PortalManager({
    hostId: () => "h1",
    getAgents: () => [fakeAgent],
    getTerminals: () => new Map([["t1", { address: "t1", cwd: "/tmp" }]]),
    getFilesOptions: () => ({ extraRoots: ["/tmp"] }),
    getDirectInfo: () => ({ port: null, addrs: [], connectedCount: 0 }),
    hasRemoteViewers: () => true,
    onPortalEvent: () => {},
    stateDir: state,
    captureDeps: {
      platform: "darwin",
      binDir,
      hasCmd: (c) => c === "swiftc",
      execBin: async (_cmd, args) => {
        if (args.includes("-o")) {
          const outIdx = args.indexOf("-o");
          if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, "mock-bin");
          return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
        }
        if (args[0] === "check") return { code: 0, stderr: "", stdout: Buffer.from('{"screenCapture":true,"accessibility":true}') };
        if (args[0] === "list") {
          return {
            code: 0,
            stderr: "",
            stdout: Buffer.from(JSON.stringify([{ id: "screen:0", appName: "macOS", title: "主屏幕", isScreen: true, bounds: { x: 0, y: 0, width: 1728, height: 1117 } }])),
          };
        }
        if (args[0] === "capture") return { code: 0, stderr: "dims:1728x1117\n", stdout: imgSeed };
        return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
      },
    },
  });
  t.after(() => mgr.stop());

  const opened = await mgr.openPortal({ agentKey: fakeAgent.key, kind: "window", windowId: "screen:0" });
  const received: PortalStreamEvent[] = [];
  const stop = mgr.subscribe("sub-1", { portalId: opened.item.id, fps: 15, maxWidth: 1200, quality: 70 }, (ev) => received.push(ev));
  t.after(stop);

  for (let i = 0; i < 15 && received.filter((x) => x.kind === "portal_frame").length < 1; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const initialCount = received.filter((x) => x.kind === "portal_frame").length;
  assert.equal(initialCount, 1);

  // Stay on identical frame for ~180ms -> dedup prevents spamming identical frame hashes.
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(received.filter((x) => x.kind === "portal_frame").length, 1);

  // Mutate frame bytes -> config change raises FPS & changed frame emits right away.
  imgSeed = Buffer.from("frame-beta-updated");
  await mgr.sendInput(opened.item.id, { type: "config", fps: 60, maxWidth: 1600, quality: 85, showCursor: false });
  for (let i = 0; i < 20 && received.filter((x) => x.kind === "portal_frame").length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(received.filter((x) => x.kind === "portal_frame").length >= 2);

  // Backpressure check via Host.prototype.handleStreamSubscribe / sendStream
  let peerBuffered = 300 * 1024;
  const pushedToPeer: any[] = [];
  let portalSubCb: ((ev: any) => void) | null = null;
  const fakeHost: any = {
    streamStops: new Map(),
    streamMeta: new Map(),
    streamReply: new Map(),
    streamPeerBufferedBytes: new Map(),
    opts: {},
    resolve: () => undefined,
    send: () => {},
    note: () => {},
    who: (id: string) => id,
    stopStream: () => {},
    portal: {
      subscribe: (_id: string, _p: unknown, onEv: (ev: any) => void) => {
        portalSubCb = onEv;
        return () => {};
      },
      listPortals: () => [],
    },
    sendStream: (Host.prototype as any).sendStream,
  };
  await (Host.prototype as any).handleStreamSubscribe.call(
    fakeHost,
    { type: "stream_subscribe", id: "s-bp", from: "viewer-1", stream: "portal", params: { portalId: "p1", fps: 30 } },
    (frame: unknown) => pushedToPeer.push(frame),
    () => peerBuffered,
  );
  const emitSub = portalSubCb as ((ev: any) => void) | null;
  if (!emitSub) throw new Error("expected portalSubCb");
  emitSub({ kind: "portal_frame", portalId: "p1", seq: 1, data: "a" });
  emitSub({ kind: "portal_frame", portalId: "p1", seq: 2, data: "b" }); // dropped while > 256KB
  emitSub({ kind: "portal_event", action: "updated", item: opened.item, at: Date.now() }); // never dropped
  peerBuffered = 1024;
  emitSub({ kind: "portal_frame", portalId: "p1", seq: 3, data: "c" });

  assert.deepEqual(
    pushedToPeer.map((f) => (f.type === "stream_open" ? "stream_open" : f.event?.kind === "portal_frame" ? `f:${f.event.seq}` : f.event?.kind)),
    ["stream_open", "f:1", "portal_event", "f:3"],
  );
});

test(
  "darwin MAC_SWIFT_SRC compiles cleanly and serve handles read-only check/list",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "hp-swift-ro-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const swiftPath = join(dir, "helper.swift");
    const binPath = join(dir, "helper");
    writeFileSync(swiftPath, MAC_SWIFT_SRC);
    await new Promise<void>((res, rej) => {
      execFile("swiftc", ["-O", swiftPath, "-o", binPath], { timeout: 60_000 }, (err, _out, errStr) => {
        if (err) rej(new Error(errStr || err.message));
        else res();
      });
    });

    const child = spawn(binPath, ["serve"], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => {
      try {
        child.kill();
      } catch {}
    });

    const sendReq = (args: string[]) =>
      new Promise<{ code: number; stdoutBase64: string; stderr: string }>((res, rej) => {
        let buf = "";
        const onData = (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl >= 0) {
            child.stdout.off("data", onData);
            try {
              res(JSON.parse(buf.slice(0, nl)));
            } catch (e) {
              rej(e);
            }
          }
        };
        child.stdout.on("data", onData);
        child.stdin.write(`${JSON.stringify({ args })}\n`);
      });

    const checkResp = await sendReq(["check"]);
    assert.equal(checkResp.code, 0);
    const checkJson = JSON.parse(Buffer.from(checkResp.stdoutBase64, "base64").toString("utf8"));
    assert.equal(typeof checkJson.screenCapture, "boolean");
    assert.equal(typeof checkJson.accessibility, "boolean");

    const listResp = await sendReq(["list"]);
    assert.equal(listResp.code, 0);
    const listJson = JSON.parse(Buffer.from(listResp.stdoutBase64, "base64").toString("utf8"));
    assert.ok(Array.isArray(listJson));
    const mainScreen = listJson.find((w: any) => w.id === "screen:0");
    assert.ok(mainScreen?.bounds?.width > 0);
    assert.ok(mainScreen?.scaleFactor >= 1);
  },
);

test("extractCommandFromTerminalScreenLine strips Starship/OMZ/Powerlevel10k/ANSI prompts cleanly", () => {
  assert.equal(extractCommandFromTerminalScreenLine("\x1b[32m→\x1b[0m open CLAUDE.md"), "open CLAUDE.md");
  assert.equal(
    extractCommandFromTerminalScreenLine("➜  strum_app git:(stage) open docs/index.html"),
    "open docs/index.html",
  );
  assert.equal(extractCommandFromTerminalScreenLine("❯ ego-browser nodejs"), "ego-browser nodejs");
  assert.equal(extractCommandFromTerminalScreenLine("crosery@mac ~/app % open README.md"), "open README.md");
  assert.equal(extractCommandFromTerminalScreenLine("→   "), "");
  assert.equal(extractCommandFromTerminalScreenLine("\x1b[36m❯\x1b[0m"), "");
});

test("PortalManager.observeSubmittedCommand and pollWindowDeltas auto-surface files, new ppid=1 windows, browser retitles, and TCC streamError without active remote viewers", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "hp-win-delta-"));
  const workDir = join(state, "work");
  const binDir = join(state, "bin");
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "CLAUDE.md"), "# Project Guide\nHello world\n");
  t.after(() => rmSync(state, { recursive: true, force: true }));

  const events: PortalStreamEvent[] = [];
  const fakeAgent = {
    key: "h1/hc:delta1",
    deviceId: "h1",
    source: "hc" as const,
    localId: "delta1",
    harness: "shell",
    where: "终端",
    cwd: workDir,
    status: "idle" as const,
    isShell: true,
    updatedAt: Date.now(),
  };

  let mockWindows = [
    { id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true },
    { id: "100", appName: "Finder", title: "访达", pid: 100, bounds: { x: 0, y: 0, width: 800, height: 600 } },
    { id: "9002", appName: "ego lite", title: "http://127.0.0.1:8764/?t=1", pid: 778, bounds: { x: 20, y: 20, width: 960, height: 720 } },
  ];
  let captureFail = false;

  const mgr = new PortalManager({
    hostId: () => "h1",
    getAgents: () => [fakeAgent],
    getTerminals: () => new Map([["delta1", { address: "delta1", cwd: workDir, pid: 500 }]]),
    getFilesOptions: () => ({ extraRoots: [workDir] }),
    getDirectInfo: () => ({ port: null, addrs: [], connectedCount: 0 }),
    hasRemoteViewers: () => false,
    onPortalEvent: (ev) => events.push(ev),
    stateDir: state,
    captureDeps: {
      platform: "darwin",
      binDir,
      hasCmd: (c) => c === "swiftc",
      listProcesses: async () => [
        { pid: 1, ppid: 0, name: "launchd" },
        { pid: 100, ppid: 1, name: "Finder" },
        { pid: 500, ppid: 1, name: "zsh" },
        { pid: 777, ppid: 1, name: "Typora" },
        { pid: 778, ppid: 1, name: "ego lite" },
      ],
      execBin: async (cmd, args) => {
        if (cmd === "swiftc") {
          const outIdx = args.indexOf("-o");
          if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, "mock-bin");
          return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
        }
        if (args[0] === "list") return { code: 0, stderr: "", stdout: Buffer.from(JSON.stringify(mockWindows.slice(1))) };
        if (args[0] === "capture") {
          if (captureFail) return { code: 1, stderr: "Screen Recording denied", stdout: Buffer.alloc(0) };
          return { code: 0, stderr: "dims:900x700\n", stdout: Buffer.from("jpg-frame") };
        }
        return { code: 1, stderr: "", stdout: Buffer.alloc(0) };
      },
    },
  });
  t.after(() => mgr.stop());

  // 1) Command observation works without active remote viewers and resolves unique filename prefix `CLAU` -> `CLAUDE.md`
  mgr.observeSubmittedCommand(fakeAgent, "open CLAU", "terminal_input");
  await new Promise((r) => setTimeout(r, 80));
  const filePortals = mgr.listPortals(fakeAgent.key).filter((p) => p.targetPath?.endsWith("CLAUDE.md"));
  assert.equal(filePortals.length, 1);

  // 2) First pollWindowDeltas seeds pre-existing Finder / ego lite windows without opening them
  await mgr.pollWindowDeltas();
  assert.equal(mgr.listPortals(fakeAgent.key).filter((p) => p.kind === "window").length, 0);

  // 3) LaunchServices reparented window (ppid=1) appears -> auto-opens window portal
  mockWindows = [
    ...mockWindows,
    { id: "9001", appName: "Typora", title: "CLAUDE.md", pid: 777, bounds: { x: 20, y: 20, width: 900, height: 700 } },
  ];
  await mgr.pollWindowDeltas();
  const win9001 = mgr.listPortals(fakeAgent.key).find((p) => p.windowId === "9001");
  assert.ok(win9001, "expected new ppid=1 Typora window to auto-open");

  // 4) Existing browser window retitles (?t=1 -> ?t=2) and Screen Recording fails -> opens with streamError populated
  captureFail = true;
  mockWindows = mockWindows.map((w) =>
    w.id === "9002" ? { ...w, title: "http://127.0.0.1:8764/?t=2" } : w,
  );
  await mgr.pollWindowDeltas();
  const win9002 = mgr.listPortals(fakeAgent.key).find((p) => p.windowId === "9002");
  assert.ok(win9002, "expected retitled ego lite window to surface");
  assert.ok(win9002.streamError && win9002.streamError.length > 0, "expected TCC capture error to be surfaced as streamError");
  assert.ok(
    events.some((e) => e.kind === "portal_event" && e.action === "opened" && e.item.windowId === "9002"),
    "expected opened portal_event for retitled window",
  );

  // 5) Subsequent title updates on an already-open portal emit action="updated", never "opened".
  const evLenBeforeRetitle2 = events.length;
  mockWindows = mockWindows.map((w) =>
    w.id === "9002" ? { ...w, title: "http://127.0.0.1:8764/?t=3" } : w,
  );
  await mgr.pollWindowDeltas();
  const postEvents = events.slice(evLenBeforeRetitle2).filter((e) => e.kind === "portal_event" && e.item.windowId === "9002");
  assert.ok(
    postEvents.some((e) => e.kind === "portal_event" && e.action === "updated"),
    "expected already-open retitled window to emit updated",
  );
  assert.equal(
    postEvents.some((e) => e.kind === "portal_event" && e.action === "opened"),
    false,
    "expected already-open retitled window NOT to re-emit opened",
  );
});

test("OsCaptureDriver routes capture via v2 bridge and avoids 28ms 60fps cache frame drops", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "hp-v2-cap-"));
  const binDir = join(state, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "hp-mac-portal-v3"), "mock-bin");
  writeFileSync(join(binDir, "hp-mac-portal-v3.swift"), MAC_SWIFT_SRC);
  t.after(() => rmSync(state, { recursive: true, force: true }));

  const execCalls: string[][] = [];
  const driver = new OsCaptureDriver({
    platform: "darwin",
    binDir,
    hasCmd: (c) => c === "swiftc",
    execBin: async (cmd, args) => {
      execCalls.push([cmd, ...args]);
      if (args[0] === "check") {
        return { code: 0, stderr: "", stdout: Buffer.from(JSON.stringify({ screenCapture: true, accessibility: true, bridgeVersion: 2 })) };
      }
      if (args[0] === "capture") {
        return { code: 0, stderr: "dims:1600x1000\n", stdout: Buffer.from("fast-jpg") };
      }
      return { code: 1, stderr: "", stdout: Buffer.alloc(0) };
    },
  });
  const permNote = await driver.checkPermissionNote();
  assert.equal(permNote, null);
  const frame = await driver.captureWindow("screen:0", { fps: 60, maxWidth: 1600, quality: 66 });
  assert.ok(frame && frame.width === 1600 && frame.height === 1000);
  // Explicit streaming calls use tight 3ms cache (two calls separated by 8ms must both execute rather than returning stale cached frames).
  await new Promise((r) => setTimeout(r, 8));
  await driver.captureWindow("screen:0", { fps: 60, maxWidth: 1600, quality: 66 });
  assert.equal(execCalls.filter((c) => c.includes("capture")).length, 2);
});

test("PortalManager immediately opens CDP browser on open URL, matches shell t.pid hook, and emits heartbeat/ack telemetry", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "hp-cdp-fast-"));
  const binDir = join(state, "bin");
  mkdirSync(binDir, { recursive: true });
  t.after(() => rmSync(state, { recursive: true, force: true }));

  const events: PortalStreamEvent[] = [];
  const fakeAgent = {
    key: "h1/hc:shell1",
    deviceId: "h1",
    source: "hc" as const,
    localId: "shell1",
    harness: "shell",
    where: "终端",
    cwd: state,
    status: "idle" as const,
    isShell: true,
    updatedAt: Date.now(),
  };

  let staticMode = false;
  let frameCounter = 0;
  const mgr = new PortalManager({
    hostId: () => "h1",
    getAgents: () => [fakeAgent],
    getTerminals: () => new Map([["shell1", { address: "shell1", cwd: state, pid: 500 }]]),
    getFilesOptions: () => ({ extraRoots: [state] }),
    getDirectInfo: () => ({ port: 49000, addrs: ["127.0.0.1"], connectedCount: 1 }),
    hasRemoteViewers: () => true,
    onPortalEvent: (ev) => events.push(ev),
    stateDir: state,
    captureDeps: {
      platform: "darwin",
      binDir,
      hasCmd: (c) => c === "swiftc",
      listProcesses: async () => [
        { pid: 1, ppid: 0, name: "launchd" },
        { pid: 500, ppid: 1, name: "zsh" },
        { pid: 505, ppid: 500, name: "open" },
      ],
      execBin: async (cmd, args) => {
        if (cmd === "swiftc") {
          const outIdx = args.indexOf("-o");
          if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, "mock-bin");
          return { code: 0, stderr: "", stdout: Buffer.alloc(0) };
        }
        if (args[0] === "list") return { code: 0, stderr: "", stdout: Buffer.from("[]") };
        if (args[0] === "capture") {
          const tag = staticMode ? "static" : `dyn-${++frameCounter}`;
          return { code: 0, stderr: "dims:1280x800\n", stdout: Buffer.from(`jpeg-${tag}`) };
        }
        return { code: 1, stderr: "", stdout: Buffer.alloc(0) };
      },
    },
  });
  let stopSub: (() => void) | null = null;
  t.after(() => {
    stopSub?.();
    mgr.stop();
  });

  // 1) Inject stub CdpBrowserPool on mgr.browser so `open https://example.com` opens a CDP browser tab immediately without polling OS windows for 2.6s.
  const cdpOpenedUrls: string[] = [];
  const fakeCdpBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const stubSessions = new Map<string, Record<string, unknown>>();
  const mgrAny = mgr as unknown as { browser: Record<string, unknown> };
  mgrAny.browser = {
    hasBrowser: async () => true,
    open: async (portalId: string, url: string) => {
      cdpOpenedUrls.push(url);
      const frame = {
        portalId,
        seq: 1,
        mime: "image/jpeg" as const,
        data: "",
        rawBytes: fakeCdpBytes,
        width: 1280,
        height: 800,
        url,
        title: "Example Domain",
        at: Date.now(),
      };
      stubSessions.set(portalId, {
        url,
        title: "Example Domain",
        getLatestFrame: () => frame,
        captureOnce: async () => frame,
        onFrame: () => () => {},
        startScreencast: async () => {},
        updateScreencastConfig: async () => {},
        stopScreencast: async () => {},
        close: () => {},
      });
      return { url, title: "Example Domain" };
    },
    get: (portalId: string) => stubSessions.get(portalId),
    close: (portalId: string) => {
      stubSessions.delete(portalId);
    },
    closeAll: () => {
      stubSessions.clear();
    },
  };

  // Trigger shell `open https://example.com` and verify instant CDP browser portal without OS window polling.
  const t0 = Date.now();
  mgr.observeSubmittedCommand(fakeAgent, "open https://example.com", "terminal_input");
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(cdpOpenedUrls.includes("https://example.com"));
  const browserPortal = mgr.listPortals(fakeAgent.key).find((p) => p.kind === "browser");
  assert.ok(browserPortal, "expected browser portal immediately without waiting for OS window poll");
  assert.ok(Date.now() - t0 < 1000, "CDP launch should not stall on listWindows polling");

  // Also verify JSON-string tool_call inputs in inspectToolCallForPortal open portals cleanly.
  mgr.inspectToolCallForPortal(fakeAgent, "run_command", JSON.stringify({ CommandLine: "open https://example.org" }));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(cdpOpenedUrls.includes("https://example.org"), "expected JSON-string run_command input to trigger portal");

  // 2) Window stream emits frame -> ack clears inflight -> static screen emits idle heartbeat without duplicate frames.
  const winOpen = await mgr.openPortal({ agentKey: fakeAgent.key, kind: "window", windowId: "screen:0", title: "Desktop" });
  const emitted: PortalStreamEvent[] = [];
  stopSub = mgr.subscribe(
    "s-hb-1",
    { portalId: winOpen.item.id, fps: 30, maxWidth: 1280, quality: 60 },
    (ev) => emitted.push(ev),
  );
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(emitted.some((e) => e.kind === "portal_frame"), "expected initial streamed frame");
  const firstFrame = emitted.find((e) => e.kind === "portal_frame");
  if (firstFrame && firstFrame.kind === "portal_frame") {
    await mgr.sendInput(winOpen.item.id, { type: "ack", seq: firstFrame.seq });
  }
  staticMode = true;
  const heartbeatDeadline = Date.now() + 2000;
  while (
    Date.now() < heartbeatDeadline &&
    !emitted.some((e) => e.kind === "portal_heartbeat" && e.idle === true)
  ) {
    await new Promise((r) => setTimeout(r, 80));
  }
  stopSub();
  stopSub = null;
  assert.ok(
    emitted.some((e) => e.kind === "portal_heartbeat" && e.idle === true),
    "expected static stream to emit idle portal_heartbeat telemetry",
  );
});
