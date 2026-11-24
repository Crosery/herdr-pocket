import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planCarriedReleaseAssets,
  renderLatestDownloadsMarkdown,
} from "../../../scripts/sync-carried-release-assets.mjs";

test("planCarriedReleaseAssets preserves new packages, carries prevManifest entries, and falls back to recentReleases", () => {
  const prevManifest = {
    schema: 1,
    releaseVersion: "0.2.27",
    updatedAt: "2026-11-24T04:00:00Z",
    channels: {
      "android-arm64": {
        version: "0.2.26",
        tag: "v0.2.26",
        fileName: "herdr-pocket-0.2.26-android-arm64.apk",
        sha256: "a".repeat(64),
      },
      "macos-arm64": {
        version: "0.2.27",
        tag: "v0.2.27",
        fileName: "herdr-pocket-0.2.27-macos-arm64.dmg",
        sha256: "b".repeat(64),
      },
    },
  };

  const recentReleases = [
    {
      tag_name: "v0.2.27",
      draft: false,
      prerelease: false,
      assets: [{ name: "herdr-pocket-0.2.27-macos-arm64.dmg" }],
    },
    {
      tag_name: "v0.2.26",
      draft: false,
      prerelease: false,
      assets: [
        { name: "herdr-pocket-0.2.26-android-arm64.apk" },
        { name: "herdr-pocket-0.2.26-ios-arm64.ipa" },
      ],
    },
  ];

  const plan = planCarriedReleaseAssets({
    distFiles: [
      "herdr-pocket-0.2.28-macos-arm64.dmg",
      "herdr-pocket-0.2.28.tar.gz",
    ],
    prevManifest,
    recentReleases,
    currentTag: "v0.2.28",
  });

  const byChannel = Object.fromEntries(plan.map((item) => [item.channel, item]));
  assert.equal(byChannel["macos-arm64"], undefined, "does not overwrite newly built macOS asset");
  assert.equal(byChannel.bundle, undefined, "does not overwrite newly built bundle asset");
  assert.deepEqual(byChannel["android-arm64"], {
    channel: "android-arm64",
    version: "0.2.26",
    tag: "v0.2.26",
    fileName: "herdr-pocket-0.2.26-android-arm64.apk",
    sha256: "a".repeat(64),
  });
  assert.deepEqual(byChannel["ios-arm64"], {
    channel: "ios-arm64",
    version: "0.2.26",
    tag: "v0.2.26",
    fileName: "herdr-pocket-0.2.26-ios-arm64.ipa",
  });
});

test("renderLatestDownloadsMarkdown aggregates per-client latest versions pointing at the Latest release tag", () => {
  const md = renderLatestDownloadsMarkdown({
    repo: "Crosery/herdr-pocket",
    releaseTag: "v0.2.28",
    manifest: {
      schema: 1,
      releaseVersion: "0.2.28",
      updatedAt: "2026-11-24T05:00:00Z",
      channels: {
        "android-arm64": {
          version: "0.2.26",
          tag: "v0.2.26",
          fileName: "herdr-pocket-0.2.26-android-arm64.apk",
          sha256: "a".repeat(64),
        },
        "macos-arm64": {
          version: "0.2.28",
          tag: "v0.2.28",
          fileName: "herdr-pocket-0.2.28-macos-arm64.dmg",
          sha256: "c".repeat(64),
        },
      },
    },
  });

  assert.equal(md.includes("## 全平台最新客户端下载（Latest 汇总）"), true);
  assert.equal(
    md.includes("https://github.com/Crosery/herdr-pocket/releases/download/v0.2.28/herdr-pocket-0.2.26-android-arm64.apk"),
    true,
  );
  assert.equal(
    md.includes("https://github.com/Crosery/herdr-pocket/releases/download/v0.2.28/herdr-pocket-0.2.28-macos-arm64.dmg"),
    true,
  );
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(md), false);
});
