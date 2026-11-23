import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DIRECT_PORTAL_FS_PREFIX } from "@herdr-pocket/protocol";
import { DirectServer } from "../src/direct.ts";
import { computeCapabilities, detectPortalSession, resolveLinuxGuiEnv } from "../src/portal/osCapture.ts";
import { PortalFileTicketStore, bundleHtmlForRelay, readChunkForRpc } from "../src/portal/p2pFiles.ts";
import { PortalHookServer, parseOpenerArgs } from "../src/portal/shims.ts";

test("PortalFileTicketStore + DirectServer serve /v1/portal-fs HTTP files, Ranges, CORS, and block traversal/private files", async (t) => {
  const rawRoot = mkdtempSync(join(tmpdir(), "hp-portal-fs-"));
  t.after(() => rmSync(rawRoot, { recursive: true, force: true }));
  const root = realpathSync(rawRoot);
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
