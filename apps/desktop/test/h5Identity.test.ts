import assert from "node:assert/strict";
import { test } from "node:test";
import { inferRelayUrlFromLocation, recognizeWebDevice } from "../src/lib/h5Identity.ts";

test("inferRelayUrlFromLocation strips /app and /h5 suffixes across root and subpath proxies", () => {
  assert.equal(
    inferRelayUrlFromLocation({ origin: "https://pocket.example.com", pathname: "/app/" }),
    "https://pocket.example.com",
  );
  assert.equal(
    inferRelayUrlFromLocation({ origin: "https://pocket.example.com", pathname: "/pocket/app/" }),
    "https://pocket.example.com/pocket",
  );
  assert.equal(
    inferRelayUrlFromLocation({ origin: "https://pocket.example.com", pathname: "/pocket/h5/index.html" }),
    "https://pocket.example.com/pocket",
  );
  assert.equal(
    inferRelayUrlFromLocation({ origin: "tauri://localhost", pathname: "/" }),
    "",
  );
});

test("recognizeWebDevice detects mobile, iPadOS desktop-UA, HarmonyOS, Android WeChat, Mac, and Windows", () => {
  const iphone = recognizeWebDevice({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    maxTouchPoints: 5,
  });
  assert.equal(iphone.platform, "h5-ios");
  assert.equal(iphone.formFactor, "mobile");
  assert.equal(iphone.name, "iPhone · Safari (H5)");

  const ipadDesktopUa = recognizeWebDevice({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
  });
  assert.equal(ipadDesktopUa.platform, "h5-ipados");
  assert.equal(ipadDesktopUa.formFactor, "tablet");
  assert.equal(ipadDesktopUa.name, "iPad · Safari (H5)");

  const androidWechat = recognizeWebDevice({
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50",
    platform: "Linux armv81",
    maxTouchPoints: 5,
  });
  assert.equal(androidWechat.platform, "h5-android");
  assert.equal(androidWechat.formFactor, "mobile");
  assert.equal(androidWechat.name, "Android · 微信 (H5)");

  const harmony = recognizeWebDevice(
    {
      userAgent: "Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile",
      platform: "OpenHarmony",
      maxTouchPoints: 10,
    },
    { innerWidth: 412, screen: { width: 412, height: 915 } },
  );
  assert.equal(harmony.platform, "h5-harmony");
  assert.equal(harmony.formFactor, "mobile");
  assert.match(harmony.name, /^HarmonyOS · .* \(H5\)$/);

  const macChrome = recognizeWebDevice({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    platform: "MacIntel",
    maxTouchPoints: 0,
  });
  assert.equal(macChrome.platform, "h5-macos");
  assert.equal(macChrome.formFactor, "desktop");
  assert.equal(macChrome.name, "Mac · Chrome (H5)");

  const winEdge = recognizeWebDevice({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0",
    platform: "Win32",
    maxTouchPoints: 0,
  });
  assert.equal(winEdge.platform, "h5-windows");
  assert.equal(winEdge.formFactor, "desktop");
  assert.equal(winEdge.name, "Windows · Edge (H5)");
});
