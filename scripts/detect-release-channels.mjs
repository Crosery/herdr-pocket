#!/usr/bin/env node
/**
 * Detects which release build channels need to run for a tag `vX.Y.Z`.
 * Ignores docs and pure version-stamp diffs produced by `scripts/set-version.mjs`
 * when comparing against each channel's previous shipped tag in `RELEASE-MANIFEST.json`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const ALL_GROUPS = ["bundle", "image", "android", "ios", "harmony", "desktop"];

const CHANNEL_FOR_GROUP = {
  bundle: ["bundle"],
  image: ["bundle"],
  android: ["android-arm64"],
  ios: ["ios-arm64"],
  harmony: ["harmonyos-arm64"],
  desktop: ["macos-arm64", "macos-x64", "windows-x64-setup", "windows-x64-msi", "linux-x64-appimage", "linux-x64-deb"],
};

const VERSION_STAMP_FILES = new Set([
  "package.json",
  "apps/relay/package.json",
  "apps/hostd/package.json",
  "apps/desktop/package.json",
  "apps/admin/package.json",
  "packages/protocol/package.json",
  "packages/update/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/harmony/oh-package.json5",
  "apps/harmony/entry/oh-package.json5",
  "apps/harmony/AppScope/app.json5",
  "apps/harmony/entry/src/main/ets/bridge/PocketHarmonyBridge.ets",
  "apps/mobile/app.json",
]);

/** Returns true if a unified-0 git diff contains ONLY version-bump lines. */
export function isVersionStampOnlyDiff(diffText) {
  const lines = diffText.split(/\r?\n/);
  let changedLines = 0;
  for (const line of lines) {
    if (!line || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    changedLines += 1;
    const body = line.slice(1).trim();
    if (!body) return false;
    const isStamp =
      /^"version":\s*"[^"]+",?$/.test(body) ||
      /^version\s*=\s*"[^"]+"$/.test(body) ||
      /^"versionCode":\s*\d+,?$/.test(body) ||
      /^"versionName":\s*"[^"]+",?$/.test(body) ||
      /^"buildNumber":\s*"[^"]+",?$/.test(body) ||
      /^private\s+versionName:\s*string\s*=\s*'[^']*';?$/.test(body);
    if (!isStamp) return false;
  }
  return changedLines > 0;
}

function fileChangedSince(baseTag, targetTag, filePath) {
  if (!VERSION_STAMP_FILES.has(filePath)) return true;
  try {
    const diff = execFileSync("git", ["diff", "-U0", baseTag, targetTag, "--", filePath], { encoding: "utf8" });
    return !isVersionStampOnlyDiff(diff);
  } catch {
    return true;
  }
}

export function groupMatchesPath(group, filePath) {
  if (filePath === ".github/workflows/release.yml" || filePath === "pnpm-lock.yaml" || filePath === "package.json") {
    return true;
  }
  if (
    filePath.startsWith("scripts/build-release-manifest") ||
    filePath.startsWith("scripts/detect-release-channels") ||
    filePath.startsWith("scripts/sync-carried-release-assets")
  ) {
    return false;
  }
  switch (group) {
    case "bundle":
      return (
        filePath.startsWith("apps/relay/") ||
        filePath.startsWith("apps/admin/") ||
        filePath.startsWith("apps/hostd/") ||
        filePath.startsWith("packages/protocol/") ||
        filePath.startsWith("packages/update/") ||
        filePath === "scripts/pack-release.sh" ||
        filePath.startsWith("scripts/install-")
      );
    case "image":
      return (
        filePath.startsWith("apps/relay/") ||
        filePath.startsWith("apps/admin/") ||
        filePath.startsWith("packages/protocol/") ||
        filePath.startsWith("packages/update/") ||
        filePath === "Dockerfile"
      );
    case "android":
    case "ios":
      return filePath.startsWith("apps/mobile/") || filePath.startsWith("packages/protocol/");
    case "harmony":
      return (
        filePath.startsWith("apps/harmony/") ||
        filePath.startsWith("apps/desktop/src/") ||
        filePath === "apps/desktop/index.html" ||
        filePath.startsWith("apps/desktop/vite") ||
        filePath.startsWith("apps/desktop/scripts/") ||
        filePath === "apps/desktop/package.json" ||
        filePath.startsWith("packages/protocol/")
      );
    case "desktop":
      return (
        filePath.startsWith("apps/desktop/") ||
        filePath.startsWith("packages/protocol/") ||
        filePath.startsWith("packages/update/") ||
        filePath === "scripts/dmg-settings.py" ||
        filePath === "scripts/gen-client-assets.py"
      );
    default:
      return true;
  }
}

function tagExists(tag) {
  if (!tag) return false;
  try {
    execFileSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectReleaseChannels({ tag = "HEAD", channels = "auto", prevManifest = null } = {}) {
  const mode = String(channels || "auto").trim().toLowerCase();
  const result = Object.fromEntries(ALL_GROUPS.map((g) => [g, false]));
  if (mode === "all") {
    for (const g of ALL_GROUPS) result[g] = true;
    return result;
  }
  if (mode && mode !== "auto") {
    const wanted = new Set(mode.split(",").map((s) => s.trim()).filter(Boolean));
    for (const g of ALL_GROUPS) result[g] = wanted.has(g);
    return result;
  }

  for (const group of ALL_GROUPS) {
    const reqChannels = CHANNEL_FOR_GROUP[group];
    const tags = reqChannels.map((c) => prevManifest?.channels?.[c]?.tag ?? "");
    if (tags.some((t) => !tagExists(t))) {
      result[group] = true;
      continue;
    }
    const baseTag = tags[0];
    let changedFiles = [];
    try {
      const raw = execFileSync("git", ["diff", "--name-only", baseTag, tag], { encoding: "utf8" });
      changedFiles = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch {
      result[group] = true;
      continue;
    }
    const effective = changedFiles.filter((f) => {
      if (f.startsWith("docs/") || f === "README.md" || f === "LICENSE") return false;
      if (f.startsWith(".github/") && f !== ".github/workflows/release.yml") return false;
      if (!groupMatchesPath(group, f)) return false;
      return fileChangedSince(baseTag, tag, f);
    });
    result[group] = effective.length > 0;
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      tag: { type: "string", default: "HEAD" },
      channels: { type: "string", default: "auto" },
      "prev-manifest": { type: "string", default: "" },
    },
  });
  let prevManifest = null;
  if (values["prev-manifest"] && existsSync(values["prev-manifest"])) {
    try {
      prevManifest = JSON.parse(readFileSync(values["prev-manifest"], "utf8"));
    } catch {
      prevManifest = null;
    }
  }
  const detected = detectReleaseChannels({
    tag: values.tag,
    channels: values.channels,
    prevManifest,
  });
  for (const [k, v] of Object.entries(detected)) {
    console.log(`build_${k}=${v ? "true" : "false"}`);
  }
}
