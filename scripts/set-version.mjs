#!/usr/bin/env node
// Write one version everywhere it has to be spelled out:
//   package.json (root), packages/*, apps/{relay,hostd,desktop}
//   apps/desktop/src-tauri/{tauri.conf.json,Cargo.toml}
//   apps/harmony/{oh-package.json5,entry/oh-package.json5,AppScope/app.json5}
//   apps/mobile/app.json       expo.version + ios.buildNumber; plugins/withAndroidBuild.js
//                              derives Android versionCode (1.2.3 -> 1002003) at prebuild
//   apps/mobile/android/app/build.gradle (when present)
// Usage: node scripts/set-version.mjs 1.2.3        (a leading "v" is dropped)
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] ?? "").replace(/^v/, "");
const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
if (!m) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch[-pre]>");
  process.exit(1);
}
const [major, minor, patch] = m.slice(1).map(Number);
if (minor > 999 || patch > 999) {
  console.error("minor and patch must stay below 1000 (they share the Android/Harmony versionCode)");
  process.exit(1);
}
// Android/Harmony only install an update with a versionCode at least as high: 1.2.3 -> 1002003.
const versionCode = major * 1_000_000 + minor * 1_000 + patch;

/** Replace the top-level "version" in place, keeping the file's own formatting. */
function stampPackage(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const next = text.replace(/^(\s{2}"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    writeFileSync(file, text.replace(/^(\s{2}"name":\s*"[^"]*",\n)/m, `$1  "version": "${version}",\n`));
  } else writeFileSync(file, next);
  console.log(`${file.slice(root.length + 1)}  ${version}`);
}

stampPackage(join(root, "package.json"));
for (const dir of ["packages", "apps"]) {
  for (const name of readdirSync(join(root, dir))) {
    if (dir === "apps" && name !== "relay" && name !== "hostd" && name !== "desktop") continue;
    stampPackage(join(root, dir, name, "package.json"));
  }
}

const tauriConf = join(root, "apps/desktop/src-tauri/tauri.conf.json");
if (existsSync(tauriConf)) {
  const conf = JSON.parse(readFileSync(tauriConf, "utf8"));
  conf.version = version;
  writeFileSync(tauriConf, `${JSON.stringify(conf, null, 2)}\n`);
  console.log(`apps/desktop/src-tauri/tauri.conf.json  ${version}`);
}

const cargoToml = join(root, "apps/desktop/src-tauri/Cargo.toml");
if (existsSync(cargoToml)) {
  const toml = readFileSync(cargoToml, "utf8");
  writeFileSync(cargoToml, toml.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`));
  console.log(`apps/desktop/src-tauri/Cargo.toml  ${version}`);
}

for (const ohPkg of ["apps/harmony/oh-package.json5", "apps/harmony/entry/oh-package.json5"]) {
  const file = join(root, ohPkg);
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`));
  console.log(`${ohPkg}  ${version}`);
}

const harmonyAppJson = join(root, "apps/harmony/AppScope/app.json5");
if (existsSync(harmonyAppJson)) {
  const text = readFileSync(harmonyAppJson, "utf8")
    .replace(/"versionCode":\s*\d+/, `"versionCode": ${versionCode}`)
    .replace(/"versionName":\s*"[^"]*"/, `"versionName": "${version}"`);
  writeFileSync(harmonyAppJson, text);
  console.log(`apps/harmony/AppScope/app.json5  ${version} (versionCode ${versionCode})`);
}

const harmonyBridge = join(root, "apps/harmony/entry/src/main/ets/bridge/PocketHarmonyBridge.ets");
if (existsSync(harmonyBridge)) {
  const text = readFileSync(harmonyBridge, "utf8");
  writeFileSync(
    harmonyBridge,
    text.replace(/(private\s+versionName:\s*string\s*=\s*)'[^']*'/, `$1'${version}'`),
  );
}

const appJson = join(root, "apps/mobile/app.json");
if (existsSync(appJson)) {
  const app = JSON.parse(readFileSync(appJson, "utf8"));
  app.expo.version = version;
  app.expo.ios = { ...app.expo.ios, buildNumber: String(versionCode) };
  writeFileSync(appJson, `${JSON.stringify(app, null, 2)}\n`);
  const pinned = app.expo.android?.versionCode;
  console.log(`apps/mobile/app.json  ${version} (versionCode ${pinned ?? versionCode}${pinned ? ", pinned in app.json" : ""})`);
}

const androidGradle = join(root, "apps/mobile/android/app/build.gradle");
if (existsSync(androidGradle)) {
  const text = readFileSync(androidGradle, "utf8")
    .replace(/(\bversionCode\s+)\d+/, `$1${versionCode}`)
    .replace(/(\bversionName\s+)"[^"]*"/, `$1"${version}"`);
  writeFileSync(androidGradle, text);
  console.log(`apps/mobile/android/app/build.gradle  ${version} (versionCode ${versionCode})`);
}
