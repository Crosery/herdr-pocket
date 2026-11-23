import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { allReleaseSources, inMainlandChina, releaseFromSums, releaseSources } from "@herdr-pocket/protocol";
import { ASSETS, compareVersions, fileMentions, findLayout, latestRelease, linkTarget, readVersion, rollback, setLink, sourcesFor, sumFor, update } from "../src/index.ts";

// Never read or write this machine's own config.json or remembered download source.
process.env.HERDR_POCKET_HOME = mkdtempSync(join(tmpdir(), "hp-home-"));
process.env.HERDR_POCKET_STATE = mkdtempSync(join(tmpdir(), "hp-state-"));

/** Windows' own tar (bsdtar): Git's GNU tar on PATH reads `C:` in paths as a remote host. */
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const quiet = () => {};

/** A minimal copy: package.json with the version and a host CLI that prints it (or fails). */
function writeCopy(dir: string, version: string, works = true): void {
  mkdirSync(join(dir, "apps/hostd/src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "herdr-pocket", version }));
  writeFileSync(join(dir, "apps/hostd/src/cli.ts"), works ? `console.log(${JSON.stringify(version)});\n` : `process.exit(3);\n`);
}

function makeBundle(dir: string, version: string, works = true): string {
  const stage = mkdtempSync(join(dir, "stage-"));
  writeCopy(join(stage, `herdr-pocket-${version}`), version, works);
  const file = join(dir, `${works ? "" : "broken-"}${ASSETS.bundle(version)}`);
  execFileSync(TAR, ["-czf", file, "-C", stage, `herdr-pocket-${version}`]);
  return file;
}

function makeInstall(dir: string, version: string): string {
  const root = join(dir, "install");
  writeCopy(join(root, "releases", version), version);
  setLink(root, "current", `releases/${version}`);
  return root;
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("versions", () => {
  test("semver order", () => {
    assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
    assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1);
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  });

  test("checksum listing", () => {
    const h = "a".repeat(64);
    assert.equal(sumFor(`${"b".repeat(64)}  other.apk\n${h} *dist/herdr-pocket-1.0.0.tar.gz\n`, "herdr-pocket-1.0.0.tar.gz"), h);
    assert.equal(sumFor(`${h}  x\n`, "y"), undefined);
  });

  test("the release a SHA256SUMS listing names", () => {
    const h = "a".repeat(64);
    const r = releaseFromSums(`${h}  herdr-pocket-0.1.3-android-arm64.apk\n${"b".repeat(64)}  herdr-pocket-0.1.3.tar.gz\n`);
    assert.equal(r?.version, "0.1.3");
    assert.equal(r?.sums["herdr-pocket-0.1.3-android-arm64.apk"], h);
    assert.equal(releaseFromSums("<html>rate limited</html>"), null);
    assert.equal(releaseFromSums(`${h}  herdr-pocket-1.0.0-rc.1-android-arm64.apk\n`)?.version, "1.0.0-rc.1");
  });

  test("mirrors come first in mainland China, after GitHub elsewhere", () => {
    const gh = "https://github.com/o/r/releases/download/v1/x.tar.gz";
    assert.deepEqual(releaseSources(gh, true), [`https://ghfast.top/${gh}`, `https://gh-proxy.com/${gh}`, gh]);
    assert.deepEqual(allReleaseSources(gh, true), [
      `https://ghfast.top/${gh}`,
      `https://gh-proxy.com/${gh}`,
      `https://cdn.gh-proxy.com/${gh}`,
      `https://edgeone.gh-proxy.com/${gh}`,
      gh,
    ]);
    assert.equal(allReleaseSources(gh, false)[0], gh);
    assert.equal(releaseSources(gh, false)[0], gh);
    assert.equal(inMainlandChina("Asia/Shanghai"), true);
    assert.equal(inMainlandChina("Asia/Beijing"), true);
    assert.equal(inMainlandChina("GMT+08:00", "zh-CN", 480), true);
    assert.equal(inMainlandChina("GMT+08:00", "zh-TW", 480), false);
    assert.equal(inMainlandChina("Asia/Hong_Kong"), false);
    assert.equal(inMainlandChina("UTC"), false);
    const before = process.env.HERDR_POCKET_MIRROR;
    try {
      process.env.HERDR_POCKET_MIRROR = "1";
      assert.equal(sourcesFor(gh)[0], `https://ghfast.top/${gh}`);
      process.env.HERDR_POCKET_MIRROR = "0";
      assert.equal(sourcesFor(gh)[0], gh);
      assert.deepEqual(sourcesFor("https://example.com/x.tar.gz"), ["https://example.com/x.tar.gz"], "only GitHub files are mirrored");
    } finally {
      if (before === undefined) delete process.env.HERDR_POCKET_MIRROR;
      else process.env.HERDR_POCKET_MIRROR = before;
    }
  });

  test("sumFor also parses RELEASE-MANIFEST.json entries for carried-forward bundles", () => {
    const h = "c".repeat(64);
    const manifestJson = JSON.stringify({
      schema: 1,
      releaseVersion: "0.2.25",
      updatedAt: "2026-11-23T10:00:00Z",
      channels: {
        bundle: {
          version: "0.2.24",
          tag: "v0.2.24",
          fileName: "herdr-pocket-0.2.24.tar.gz",
          sha256: h,
        },
      },
    });
    assert.equal(sumFor(manifestJson, "herdr-pocket-0.2.24.tar.gz"), h);
  });

  test("an unmanaged copy explains how it is updated", () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-layout-"));
    mkdirSync(join(dir, ".git"));
    assert.throws(() => findLayout(dir), /git checkout/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("update from a file", () => {
  let dir: string;
  let root: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hp-update-"));
    root = makeInstall(dir, "0.1.0");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("installs next to the old copy and switches", async () => {
    const r = await update({ service: "host", from: makeBundle(dir, "0.2.0"), restart: false, layout: { root }, log: quiet });
    assert.deepEqual([r.from, r.to, r.changed], ["0.1.0", "0.2.0", true]);
    assert.equal(linkTarget(root, "current"), "releases/0.2.0");
    assert.equal(linkTarget(root, "previous"), "releases/0.1.0");
    assert.equal(readVersion(join(root, "current")), "0.2.0");
  });

  test("a copy that does not start is never switched to", async () => {
    await assert.rejects(update({ service: "host", from: makeBundle(dir, "0.3.0", false), restart: false, layout: { root }, log: quiet }), /did not start/);
    assert.equal(linkTarget(root, "current"), "releases/0.2.0");
    assert.deepEqual(readdirSync(join(root, "releases")).sort(), ["0.1.0", "0.2.0"]);
    assert.ok(!readdirSync(root).some((n) => n.startsWith(".update")));
  });

  test("rollback swaps current and previous", () => {
    const r = rollback({ service: "host", restart: false, layout: { root }, log: quiet });
    assert.deepEqual([r.from, r.to], ["0.2.0", "0.1.0"]);
    assert.equal(readVersion(join(root, "current")), "0.1.0");
    assert.equal(linkTarget(root, "previous"), "releases/0.2.0");
  });

  test("keeps only current and previous", async () => {
    await update({ service: "host", from: makeBundle(dir, "0.4.0"), restart: false, layout: { root }, log: quiet });
    assert.deepEqual(readdirSync(join(root, "releases")).sort(), ["0.1.0", "0.4.0"]);
    // Reinstalling the running version goes to a new folder instead of over the running one.
    await update({ service: "host", from: makeBundle(dir, "0.4.0"), restart: false, layout: { root }, log: quiet });
    assert.match(linkTarget(root, "current") ?? "", /^releases\/0\.4\.0\+/);
    assert.equal(linkTarget(root, "previous"), "releases/0.4.0");
    assert.equal(readdirSync(join(root, "releases")).length, 2);
  });
});

describe("update from a GitHub release", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let bundle: string;
  let sums = "";
  let latest = "0.5.0";
  const env = { ...process.env };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "hp-release-"));
    bundle = makeBundle(dir, "0.5.0");
    server = createServer((req, res) => {
      if (req.url === "/repos/acme/pocket/releases/latest") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            tag_name: `v${latest}`,
            html_url: `${base}/release`,
            tarball_url: `${base}/tarball`,
            assets: [
              { name: ASSETS.bundle("0.5.0"), browser_download_url: `${base}/dl/bundle` },
              { name: ASSETS.checksums, browser_download_url: `${base}/dl/sums` },
            ],
          }),
        );
      } else if (req.url === "/dl/bundle") res.end(readFileSync(bundle));
      else if (req.url === "/dl/sums") res.end(sums);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    process.env.HERDR_POCKET_API = base;
    process.env.HERDR_POCKET_REPO = "acme/pocket";
  });
  after(() => {
    server.close();
    process.env = env;
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads the latest release", async () => {
    const r = await latestRelease();
    assert.equal(r.version, "0.5.0");
    assert.equal(r.assets[ASSETS.bundle("0.5.0")], `${base}/dl/bundle`);
  });

  test("refuses a download whose checksum does not match", async () => {
    const root = makeInstall(mkdtempSync(join(dir, "a-")), "0.1.0");
    sums = `${"0".repeat(64)}  ${ASSETS.bundle("0.5.0")}\n`;
    await assert.rejects(update({ service: "host", restart: false, layout: { root }, log: quiet }), /checksum mismatch/);
    assert.equal(readVersion(join(root, "current")), "0.1.0");
  });

  test("installs a verified bundle, then reports up to date", async () => {
    const root = makeInstall(mkdtempSync(join(dir, "b-")), "0.1.0");
    sums = `${sha(bundle)}  ${ASSETS.bundle("0.5.0")}\n`;
    const r = await update({ service: "host", restart: false, layout: { root }, log: quiet });
    assert.deepEqual([r.to, r.changed], ["0.5.0", true]);
    const again = await update({ service: "host", restart: false, layout: { root }, log: quiet });
    assert.equal(again.changed, false);
    assert.ok(existsSync(join(root, "current", "apps/hostd/src/cli.ts")));
  });
});

describe("service files", () => {
  test("the Windows launcher (UTF-16 JScript, escaped paths) names its install", async () => {
    const { launcherScript } = await import("../../../apps/hostd/src/winservice.ts").catch(() => ({ launcherScript: undefined }));
    const dir = mkdtempSync(join(tmpdir(), "hp-svcfile-"));
    const root = "C:\\Users\\张三\\AppData\\Local\\Programs\\herdr-pocket";
    const js =
      launcherScript?.(`${root}\\node\\node.exe`, `${root}\\current\\apps\\hostd\\src\\cli.ts`, []) ??
      `shell.Run(${JSON.stringify(`"${root}\\node\\node.exe"`)}, 0, false);`;
    const file = join(dir, "hostd-start.js");
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(js, "utf16le")]));
    assert.ok(fileMentions(file, root, true));
    assert.ok(fileMentions(file, root.toLowerCase(), true));
    assert.ok(!fileMentions(file, "C:\\Users\\other", true));
    rmSync(dir, { recursive: true, force: true });
  });
});
