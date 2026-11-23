import assert from "node:assert/strict";
import test from "node:test";
import {
  canActOnLocalFile,
  isAbsoluteOrHomePath,
  openLocalFileDefault,
  resolveLocalActionTarget,
  revealInFolderLabel,
  revealInFolderShortLabel,
  revealLocalFile,
} from "../src/lib/localFileActions.ts";
import { looksLikeClickableFilePath, parseFileTarget } from "../src/lib/openFileTarget.ts";

test("revealInFolderLabel and revealInFolderShortLabel localize per platform", () => {
  assert.equal(revealInFolderLabel("macos"), "在访达中定位");
  assert.equal(revealInFolderLabel("windows"), "在资源管理器中打开所在目录");
  assert.equal(revealInFolderLabel("linux"), "打开所在目录");
  assert.equal(revealInFolderLabel("web"), "打开所在目录");
  assert.equal(revealInFolderLabel("openharmony"), "打开所在目录");

  assert.equal(revealInFolderShortLabel("macos"), "在访达中显示");
  assert.equal(revealInFolderShortLabel("windows"), "在资源管理器中显示");
  assert.equal(revealInFolderShortLabel("linux"), "打开所在目录");
  assert.equal(revealInFolderShortLabel("web"), "打开所在目录");
  assert.equal(revealInFolderShortLabel("openharmony"), "打开所在目录");
});

test("isAbsoluteOrHomePath recognizes POSIX, tilde, Windows drive, and file:// paths", () => {
  assert.equal(isAbsoluteOrHomePath("/Users/alice/Downloads/app.ipa"), true);
  assert.equal(isAbsoluteOrHomePath("~/Downloads/app.dmg"), true);
  assert.equal(isAbsoluteOrHomePath("C:\\Users\\alice\\setup.exe"), true);
  assert.equal(isAbsoluteOrHomePath("D:/builds/app.msi"), true);
  assert.equal(isAbsoluteOrHomePath("file:///Users/alice/Downloads/app.zip"), true);
  assert.equal(isAbsoluteOrHomePath("dist/app.zip"), false);
  assert.equal(isAbsoluteOrHomePath("./app.ipa"), false);
  assert.equal(isAbsoluteOrHomePath(""), false);
  assert.equal(isAbsoluteOrHomePath("   "), false);
});

test("canActOnLocalFile enforces desktop runtime, local host ownership, and valid paths", () => {
  assert.equal(
    canActOnLocalFile({
      nativeAvailable: false,
      agentDeviceId: "host-local",
      agentCwd: "/Users/alice/work",
      localHostId: "host-local",
      path: "dist/app.ipa",
    }),
    false,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      agentDeviceId: "host-remote",
      agentCwd: "/Users/bob/work",
      localHostId: "host-local",
      path: "dist/app.ipa",
      absPath: "/Users/bob/work/dist/app.ipa",
    }),
    false,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      agentDeviceId: "host-local",
      agentCwd: "/Users/alice/work",
      localHostId: null,
      path: "dist/app.ipa",
    }),
    false,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      agentDeviceId: "host-local",
      agentCwd: "/Users/alice/work",
      localHostId: "host-local",
      path: "dist/app.ipa",
    }),
    true,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      agentDeviceId: "host-local",
      localHostId: "host-local",
      path: "/Users/alice/Downloads/app.dmg",
    }),
    true,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      agentDeviceId: "host-local",
      localHostId: "host-local",
      path: "relative/only.txt",
    }),
    false,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      path: "~/Downloads/app.ipa",
    }),
    true,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      path: "app.ipa",
      absPath: "/Users/alice/Downloads/app.ipa",
    }),
    true,
  );

  assert.equal(
    canActOnLocalFile({
      nativeAvailable: true,
      path: "dist/app.ipa",
    }),
    false,
  );
});

test("resolveLocalActionTarget prefers non-empty absPath and trims cwd", () => {
  assert.deepEqual(
    resolveLocalActionTarget({
      path: "dist/app.ipa",
      absPath: "/Users/alice/work/dist/app.ipa",
      agentCwd: "  /Users/alice/work  ",
    }),
    {
      path: "/Users/alice/work/dist/app.ipa",
      cwd: "/Users/alice/work",
    },
  );

  assert.deepEqual(
    resolveLocalActionTarget({
      path: "dist/app.ipa",
      absPath: "   ",
      agentCwd: "/Users/alice/work",
    }),
    {
      path: "dist/app.ipa",
      cwd: "/Users/alice/work",
    },
  );

  assert.deepEqual(
    resolveLocalActionTarget({
      path: "~/Downloads/app.dmg",
    }),
    {
      path: "~/Downloads/app.dmg",
    },
  );
});

test("revealLocalFile and openLocalFileDefault reject cleanly outside Tauri or on empty paths", async () => {
  await assert.rejects(() => revealLocalFile({ path: "" }), /文件路径为空/);
  await assert.rejects(() => openLocalFileDefault({ path: "   " }), /文件路径为空/);
  await assert.rejects(
    () => revealLocalFile({ path: "/Users/alice/Downloads/app.ipa" }),
    /仅桌面端支持本地文件操作/,
  );
  await assert.rejects(
    () => openLocalFileDefault({ path: "/Users/alice/Downloads/app.ipa" }),
    /仅桌面端支持本地文件操作/,
  );
});

test("openFileTarget recognizes binary installers, archives, and media paths", () => {
  for (const candidate of [
    "/Users/alice/Downloads/app.ipa",
    "~/Downloads/app.dmg",
    "dist/app.zip",
    "build/outputs/apk/release/app-release.apk",
    "entry/build/default/outputs/default/entry-default-signed.hap",
    "C:\\Installer\\HerdrPocket.msi",
    "release/herdr-pocket-setup.exe",
    "dist/bundle.tar.gz",
    "media/demo.mov",
    "audio/clip.m4a",
    "pkg/engine.wasm",
  ]) {
    assert.equal(looksLikeClickableFilePath(candidate), true, `expected clickable: ${candidate}`);
  }

  assert.deepEqual(parseFileTarget("/Users/alice/Downloads/app.ipa"), {
    path: "/Users/alice/Downloads/app.ipa",
    title: "app.ipa",
    absPath: "/Users/alice/Downloads/app.ipa",
  });

  assert.deepEqual(parseFileTarget("~/Downloads/app.dmg", "/Users/alice/work"), {
    path: "~/Downloads/app.dmg",
    title: "app.dmg",
    absPath: "~/Downloads/app.dmg",
  });

  assert.deepEqual(parseFileTarget("dist/app.zip", "/Users/alice/work"), {
    path: "dist/app.zip",
    title: "app.zip",
    absPath: "/Users/alice/work/dist/app.zip",
  });
});
