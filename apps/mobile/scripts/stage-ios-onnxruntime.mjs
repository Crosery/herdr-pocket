#!/usr/bin/env node
/**
 * Stages the official Microsoft ONNX Runtime 1.30.0 iOS XCFramework and C headers
 * into `apps/mobile/ios/.pods/onnxruntime-c` from Microsoft's official NuGet package,
 * bypassing the broken `download.onnxruntime.ai` Azure CDN host during `pod install`.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.30.0";
const NUPKG_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${VERSION}/microsoft.ml.onnxruntime.${VERSION}.nupkg`;
const EXPECTED_SHA256 = "30df119bd9164eaa187666d93147448fdd4a9a1a3caf83f1505daf7af2d1c5d2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);
let outDir = join(mobileRoot, "ios", ".pods", "onnxruntime-c");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) outDir = resolve(args[++i]);
}

const markerPath = join(outDir, ".staged-sha256");
if (
  existsSync(markerPath) &&
  readFileSync(markerPath, "utf8").trim() === EXPECTED_SHA256 &&
  existsSync(join(outDir, "onnxruntime.xcframework")) &&
  existsSync(join(outDir, "onnxruntime-c.podspec.json"))
) {
  console.log(`[stage-ios-onnxruntime] Already staged onnxruntime-c ${VERSION} at ${outDir}`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "ort-ios-stage-"));
try {
  const nupkgPath = join(work, "ort.nupkg");
  let downloaded = false;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !downloaded; attempt++) {
    try {
      console.log(`[stage-ios-onnxruntime] Downloading ONNX Runtime ${VERSION} from NuGet (attempt ${attempt}/3)...`);
      execFileSync("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "20", NUPKG_URL, "-o", nupkgPath], {
        stdio: "inherit",
      });
      const actual = createHash("sha256").update(readFileSync(nupkgPath)).digest("hex");
      if (actual !== EXPECTED_SHA256) {
        throw new Error(`SHA-256 mismatch: expected ${EXPECTED_SHA256}, got ${actual}`);
      }
      downloaded = true;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!downloaded) throw lastErr ?? new Error("Failed to download ONNX Runtime NuGet package");

  const unzipDir = join(work, "nupkg");
  mkdirSync(unzipDir, { recursive: true });
  execFileSync("unzip", ["-oq", nupkgPath, "runtimes/ios/native/onnxruntime.xcframework.zip", "build/native/include/*", "-d", unzipDir], {
    stdio: "inherit",
  });
  try {
    execFileSync("unzip", ["-oq", nupkgPath, "LICENSE*", "ThirdPartyNotices.txt", "-d", unzipDir], {
      stdio: "ignore",
    });
  } catch {
    // Optional license files inside nupkg.
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "Headers"), { recursive: true });

  execFileSync("unzip", ["-oq", join(unzipDir, "runtimes/ios/native/onnxruntime.xcframework.zip"), "-d", outDir], {
    stdio: "inherit",
  });

  const incDir = join(unzipDir, "build/native/include");
  for (const name of readdirSync(incDir)) {
    if (name.endsWith(".h")) {
      writeFileSync(join(outDir, "Headers", name), readFileSync(join(incDir, name)));
    }
  }
  const licenseSrc = ["LICENSE.txt", "LICENSE", "ThirdPartyNotices.txt"]
    .map((f) => join(unzipDir, f))
    .find((p) => existsSync(p));
  writeFileSync(
    join(outDir, "LICENSE"),
    licenseSrc ? readFileSync(licenseSrc) : "MIT License — Microsoft ONNX Runtime (https://github.com/microsoft/onnxruntime)\n",
  );

  const podspec = {
    name: "onnxruntime-c",
    version: VERSION,
    summary: "ONNX Runtime C/C++ Pod",
    homepage: "https://github.com/microsoft/onnxruntime",
    license: { type: "MIT", file: "LICENSE" },
    authors: { "ONNX Runtime": "onnxruntime@microsoft.com" },
    platforms: { ios: "15.1", osx: "14.0" },
    vendored_frameworks: "onnxruntime.xcframework",
    static_framework: true,
    weak_frameworks: ["CoreML"],
    ios: {
      frameworks: ["CoreFoundation", "Foundation", "Network", "Security", "SystemConfiguration", "UIKit"],
    },
    source_files: "Headers/*.h",
    public_header_files: "Headers/*.h",
    preserve_paths: ["LICENSE"],
    libraries: "c++",
  };
  writeFileSync(join(outDir, "onnxruntime-c.podspec.json"), `${JSON.stringify(podspec, null, 2)}\n`);
  writeFileSync(markerPath, `${EXPECTED_SHA256}\n`);
  console.log(`[stage-ios-onnxruntime] Staged onnxruntime-c ${VERSION} -> ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
