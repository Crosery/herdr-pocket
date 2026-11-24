#!/usr/bin/env node
/**
 * Ensures every semver GitHub Release (`Latest`) carries forward unchanged client packages
 * so visitors on the Latest release page always find ready-to-install downloads for all platforms,
 * and generates a summary Markdown download table for the release notes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const ALL_RELEASE_CHANNELS = [
  "android-arm64",
  "ios-arm64",
  "harmonyos-arm64",
  "macos-arm64",
  "macos-x64",
  "windows-x64-setup",
  "windows-x64-msi",
  "linux-x64-appimage",
  "linux-x64-deb",
  "bundle",
];

const CHANNEL_ASSET_RULES = [
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-android-arm64\.apk$/, "android-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-ios-arm64\.ipa$/, "ios-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-harmonyos-arm64\.hap$/, "harmonyos-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-macos-arm64\.dmg$/, "macos-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-macos-x64\.dmg$/, "macos-x64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-windows-x64-setup\.exe$/, "windows-x64-setup"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-windows-x64\.msi$/, "windows-x64-msi"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-linux-x64\.AppImage$/, "linux-x64-appimage"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-linux-x64\.deb$/, "linux-x64-deb"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tar\.gz$/, "bundle"],
];

const CHANNEL_LABELS = {
  "android-arm64": "Android 手机端（arm64 `.apk`）",
  "ios-arm64": "iOS 手机端（arm64 未签名 `.ipa`）",
  "harmonyos-arm64": "HarmonyOS NEXT 鸿蒙端（arm64 未签名 `.hap`）",
  "macos-arm64": "macOS Apple Silicon 桌面端（`.dmg`）",
  "macos-x64": "macOS Intel 桌面端（`.dmg`）",
  "windows-x64-setup": "Windows 64 位安装程序（`-setup.exe`）",
  "windows-x64-msi": "Windows 64 位 MSI 安装包（`.msi`）",
  "linux-x64-appimage": "Linux 64 位 AppImage（`.AppImage`）",
  "linux-x64-deb": "Linux Debian / Ubuntu（`.deb`）",
  bundle: "中转服务端与电脑守护进程包（`.tar.gz`）",
};

function matchAssetChannel(fileName) {
  for (const [re, channel] of CHANNEL_ASSET_RULES) {
    const m = re.exec(fileName);
    if (m?.[1]) return { channel, version: m[1] };
  }
  return null;
}

/**
 * Computes which missing channels need to be carried forward into `distFiles` from `prevManifest`
 * or `recentReleases`, preserving newly built channels already present in `distFiles`.
 */
export function planCarriedReleaseAssets({
  distFiles = [],
  prevManifest = null,
  recentReleases = [],
  currentTag = "",
}) {
  const presentChannels = new Set();
  for (const f of distFiles) {
    const hit = matchAssetChannel(f);
    if (hit) presentChannels.add(hit.channel);
  }

  const currentVersion = String(currentTag).replace(/^v/i, "").trim();
  const currentIsPrerelease = currentVersion.includes("-");
  const plan = [];

  for (const channel of ALL_RELEASE_CHANNELS) {
    if (presentChannels.has(channel)) continue;

    const prevEntry = prevManifest?.channels?.[channel];
    if (prevEntry && prevEntry.fileName) {
      const hit = matchAssetChannel(prevEntry.fileName);
      const entryTag = prevEntry.tag || (prevEntry.version ? `v${prevEntry.version}` : "");
      if (hit?.channel === channel && entryTag && entryTag !== currentTag) {
        plan.push({
          channel,
          version: prevEntry.version || hit.version,
          tag: entryTag,
          fileName: prevEntry.fileName,
          ...(prevEntry.sha256 ? { sha256: String(prevEntry.sha256).toLowerCase() } : {}),
        });
        continue;
      }
    }

    for (const rel of recentReleases) {
      if (!rel || rel.draft) continue;
      if (!currentIsPrerelease && rel.prerelease) continue;
      const relTag = String(rel.tag_name ?? "").trim();
      if (!relTag || relTag === currentTag) continue;
      const asset = Array.isArray(rel.assets)
        ? rel.assets.find((a) => matchAssetChannel(String(a?.name ?? ""))?.channel === channel)
        : undefined;
      if (!asset?.name) continue;
      const hit = matchAssetChannel(asset.name);
      if (!hit) continue;
      const digest = typeof asset.digest === "string" ? asset.digest.trim() : "";
      const sha256 = digest.startsWith("sha256:") && /^[0-9a-f]{64}$/i.test(digest.slice(7))
        ? digest.slice(7).toLowerCase()
        : undefined;
      plan.push({
        channel,
        version: hit.version,
        tag: relTag,
        fileName: asset.name,
        ...(sha256 ? { sha256 } : {}),
      });
      break;
    }
  }

  return plan;
}

/**
 * Renders a Markdown table aggregating every platform's current latest package shipped inside
 * the `Latest` GitHub Release (even when per-client versions differ across channels).
 */
export function renderLatestDownloadsMarkdown({ manifest, repo, releaseTag }) {
  const cleanTag = releaseTag.startsWith("v") ? releaseTag : `v${releaseTag}`;
  const channels = manifest?.channels ?? {};
  const lines = [
    "## 全平台最新客户端下载（Latest 汇总）",
    "",
    "> 各端版本号跟随对应端改动递增；`Latest` 统一汇总并附带所有端当前最新已验证安装包，点击下方链接即可直接下载。",
    "",
    "| 客户端平台 | 当前最新版本 | 安装包文件 | 直接下载 |",
    "| --- | --- | --- | --- |",
  ];

  for (const channel of ALL_RELEASE_CHANNELS) {
    const entry = channels[channel];
    if (!entry?.fileName || !entry?.version) continue;
    const label = CHANNEL_LABELS[channel] ?? channel;
    const ver = entry.version.startsWith("v") ? entry.version : `v${entry.version}`;
    const url = `https://github.com/${repo}/releases/download/${cleanTag}/${entry.fileName}`;
    lines.push(`| ${label} | \`${ver}\` | \`${entry.fileName}\` | [下载](${url}) |`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex").toLowerCase();
}

function downloadCarriedAsset(repo, item, distDir, recentReleases) {
  const dest = join(distDir, item.fileName);
  const candidateTags = Array.from(
    new Set([
      item.tag,
      `v${item.version}`,
      ...recentReleases
        .filter((r) => !r.draft && Array.isArray(r.assets) && r.assets.some((a) => a.name === item.fileName))
        .map((r) => r.tag_name),
    ]),
  ).filter(Boolean);

  let downloaded = false;
  let lastErr;
  for (const candidateTag of candidateTags) {
    try {
      execFileSync(
        "gh",
        ["release", "download", candidateTag, "--repo", repo, "--pattern", item.fileName, "--dir", distDir, "--clobber"],
        { stdio: "inherit" },
      );
      downloaded = true;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!downloaded || !existsSync(dest)) {
    throw new Error(`failed to carry forward ${item.fileName} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  }
  if (item.sha256) {
    const actual = sha256File(dest);
    if (actual !== item.sha256.toLowerCase()) {
      rmSync(dest, { force: true });
      throw new Error(`sha256 mismatch for carried asset ${item.fileName}: expected ${item.sha256}, got ${actual}`);
    }
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      carry: { type: "boolean", default: false },
      repo: { type: "string", default: "" },
      tag: { type: "string", default: "" },
      dist: { type: "string", default: "dist" },
      prev: { type: "string", default: "" },
      "render-table": { type: "string", default: "" },
      "release-tag": { type: "string", default: "" },
      out: { type: "string", default: "" },
    },
  });

  if (values["render-table"]) {
    if (!values.repo || !values["release-tag"] || !values.out) {
      console.error("usage: --render-table <manifest.json> --repo <owner/repo> --release-tag <vX.Y.Z> --out <file.md>");
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(values["render-table"], "utf8"));
    const md = renderLatestDownloadsMarkdown({
      manifest,
      repo: values.repo,
      releaseTag: values["release-tag"],
    });
    writeFileSync(values.out, md, "utf8");
    console.log(`wrote download table to ${values.out}`);
    return;
  }

  if (values.carry) {
    if (!values.repo || !values.tag) {
      console.error("usage: --carry --repo <owner/repo> --tag <vX.Y.Z> --dist <dir> [--prev <prev-manifest.json>]");
      process.exit(1);
    }
    mkdirSync(values.dist, { recursive: true });
    const distFiles = readdirSync(values.dist);
    let prevManifest = null;
    if (values.prev && existsSync(values.prev)) {
      try {
        prevManifest = JSON.parse(readFileSync(values.prev, "utf8"));
      } catch {
        prevManifest = null;
      }
    }
    let recentReleases = [];
    try {
      const raw = execFileSync("gh", ["api", `repos/${values.repo}/releases?per_page=15`], { encoding: "utf8" });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) recentReleases = parsed;
    } catch (err) {
      console.warn(`warning: failed to list recent releases for ${values.repo}: ${(err instanceof Error ? err.message : String(err))}`);
    }

    const plan = planCarriedReleaseAssets({
      distFiles,
      prevManifest,
      recentReleases,
      currentTag: values.tag,
    });
    console.log(`carrying forward ${plan.length} unchanged channel asset(s) into ${values.dist}`);
    for (const item of plan) {
      console.log(`- ${item.channel}: ${item.fileName} (from ${item.tag})`);
      downloadCarriedAsset(values.repo, item, values.dist, recentReleases);
    }
    return;
  }

  console.error("specify --carry or --render-table");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
