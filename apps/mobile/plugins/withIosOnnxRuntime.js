// Point CocoaPods at the locally staged onnxruntime-c XCFramework when present so `pod install`
// does not hit the broken `download.onnxruntime.ai` CDN host.
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "# @herdr-pocket/local-onnxruntime-c";

module.exports = (config) =>
  withDangerousMod(config, [
    "ios",
    (c) => {
      const podfilePath = path.join(c.modRequest.platformProjectRoot, "Podfile");
      if (!fs.existsSync(podfilePath)) return c;
      const body = fs.readFileSync(podfilePath, "utf8");
      if (body.includes(MARKER)) return c;
      const inject = [
        `  ${MARKER}`,
        `  local_ort_c = File.expand_path('./.pods/onnxruntime-c', __dir__)`,
        `  pod 'onnxruntime-c', :path => './.pods/onnxruntime-c' if File.exist?(local_ort_c)`,
      ].join("\n");
      const next = body.replace(/(^\s*use_expo_modules!\s*$)/m, `$1\n${inject}`);
      if (next !== body) {
        fs.writeFileSync(podfilePath, next);
      }
      return c;
    },
  ]);
