#!/usr/bin/env node
/**
 * Builds `dist/RELEASE-MANIFEST.json` by combining newly built artifacts in `--dist`
 * with unchanged channel entries carried forward from `--prev`.
 * Usage: node scripts/build-release-manifest.mjs --version 0.2.24 --dist dist [--prev prev-manifest.json] [--out dist/RELEASE-MANIFEST.json]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

const RULES = [
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

function channelOf(name) {
  for (const [re, channel] of RULES) {
    const m = re.exec(name);
    if (m?.[1]) return { channel, version: m[1] };
  }
  return null;
}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    dist: { type: "string", default: "dist" },
    prev: { type: "string", default: "" },
    "prev-sums": { type: "string", default: "" },
    out: { type: "string", default: "" },
  },
});

const releaseVersion = (values.version ?? "").replace(/^v/i, "").trim();
if (!releaseVersion) {
  console.error("missing --version");
  process.exit(1);
}

const channels = {};
const nowIso = new Date().toISOString();

if (values.prev && existsSync(values.prev)) {
  try {
    const prev = JSON.parse(readFileSync(values.prev, "utf8"));
    if (prev && prev.schema === 1 && prev.channels && typeof prev.channels === "object") {
      Object.assign(channels, prev.channels);
    }
  } catch {
    // ignore corrupt previous manifest
  }
} else if (values["prev-sums"] && existsSync(values["prev-sums"])) {
  // Bootstrap manifest cleanly from a prior release's SHA256SUMS (e.g. v0.2.23).
  const lines = readFileSync(values["prev-sums"], "utf8").split(/\r?\n/);
  for (const line of lines) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (!m) continue;
    const fileName = basename(m[2]);
    const info = channelOf(fileName);
    if (!info) continue;
    channels[info.channel] = {
      version: info.version,
      tag: `v${info.version}`,
      fileName,
      sha256: m[1].toLowerCase(),
      updatedAt: nowIso,
    };
  }
}

if (values.dist && existsSync(values.dist)) {
  for (const entry of readdirSync(values.dist)) {
    const info = channelOf(entry);
    if (!info) continue;
    const full = join(values.dist, entry);
    const st = statSync(full);
    if (!st.isFile() || st.size === 0) continue;
    const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
    const prevEntry = channels[info.channel];
    const isCarried =
      Boolean(prevEntry) &&
      prevEntry.version === info.version &&
      prevEntry.sha256 === sha256;
    channels[info.channel] = {
      version: info.version,
      tag: isCarried ? (prevEntry.tag || `v${info.version}`) : `v${info.version}`,
      fileName: entry,
      sha256,
      size: st.size,
      updatedAt: isCarried ? (prevEntry.updatedAt || nowIso) : nowIso,
    };
  }
}

const outPath = values.out || join(values.dist, "RELEASE-MANIFEST.json");
const manifest = {
  schema: 1,
  releaseVersion,
  updatedAt: nowIso,
  channels,
};
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath} (${Object.keys(channels).length} channels, release ${releaseVersion})`);
