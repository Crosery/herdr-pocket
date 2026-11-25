import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PLUGINS,
  SECRET_MASK,
  assertPublicHttpUrl,
  executePluginTool,
  isBlockedIp,
  maskWebhooks,
  normalizePlugins,
  normalizeWebhooks,
  pluginToolDefs,
  safeFetchPublic,
  serializePlugins,
  type LookupFn,
  type PluginExecDeps,
} from "../src/assistant/plugins.ts";

test("opt-in Xiaoyang plugins default to false and expose zero tools", () => {
  assert.deepEqual(DEFAULT_PLUGINS, {
    browser: false,
    workspace: false,
    webfetch: false,
    webhooks: false,
  });
  assert.deepEqual(serializePlugins(DEFAULT_PLUGINS), {});
  assert.deepEqual(pluginToolDefs(DEFAULT_PLUGINS, []), []);
  assert.deepEqual(normalizePlugins(null), DEFAULT_PLUGINS);
});

test("SSRF guard rejects loopback, link-local, private CIDRs, non-HTTP schemes, and private redirects", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1"]) {
    assert.equal(isBlockedIp(ip), true, `expected ${ip} to be blocked`);
  }
  assert.equal(isBlockedIp("93.184.216.34"), false);

  const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1:8080", localLookup));
  await assert.rejects(() => assertPublicHttpUrl("http://localhost/admin", localLookup));
  await assert.rejects(() => assertPublicHttpUrl("http://10.0.0.1/", localLookup));
  await assert.rejects(() => assertPublicHttpUrl("http://192.168.1.1/", localLookup));
  await assert.rejects(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data", localLookup));
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]/", localLookup));
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd", localLookup));

  const mixedLookup: LookupFn = async (host) => {
    if (host === "example.com") return [{ address: "93.184.216.34", family: 4 }];
    if (host === "127.0.0.1" || host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
    return [{ address: "169.254.169.254", family: 4 }];
  };

  const redirectToLocalFetch: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9000/secret" } });

  await assert.rejects(() =>
    safeFetchPublic("https://example.com/start", {
      lookup: mixedLookup,
      fetchImpl: redirectToLocalFetch,
    }),
  );

  const okFetch: typeof fetch = async () =>
    new Response("<html><body><h1>Hello Pocket</h1><script>evil()</script><p>Public text</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  const fetched = await safeFetchPublic("https://example.com/docs", {
    lookup: mixedLookup,
    fetchImpl: okFetch,
  });
  assert.equal(fetched.finalUrl, "https://example.com/docs");
  assert.equal(fetched.status, 200);
  assert.match(fetched.text, /Hello Pocket/);
});

test("webhook secret masking preserves prior secret when saved back masked", () => {
  const saved = normalizeWebhooks([
    { id: "deploy_hook", name: "Deploy Hook", url: "https://example.com/hook", secretHeader: "top-secret-42" },
  ]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.secretHeader, "top-secret-42");

  const masked = maskWebhooks(saved);
  assert.equal(masked[0]?.secretHeader, SECRET_MASK);

  const roundTripped = normalizeWebhooks(masked, saved);
  assert.equal(roundTripped[0]?.secretHeader, "top-secret-42");

  const rotated = normalizeWebhooks(
    [{ id: "deploy_hook", name: "Deploy Hook", url: "https://example.com/hook", secretHeader: "new-secret-99" }],
    saved,
  );
  assert.equal(rotated[0]?.secretHeader, "new-secret-99");
});

test("executePluginTool enforces enabled plugins and bounds inspect_workspace output", async () => {
  const bigText = "A".repeat(12_000);
  const res = await executePluginTool(
    "inspect_workspace",
    { action: "read_file", cwd: "/repo", path: "big.log", device: "mac-1" },
    {
      plugins: { ...DEFAULT_PLUGINS, workspace: true },
      webhooks: [],
      resolveDevice: () => "dev-1",
      deviceName: () => "Mac",
      requireConfirm: () => null,
      callHost: (async () => ({ text: bigText })) as PluginExecDeps["callHost"],
    },
  );
  assert.ok(res);
  assert.equal(res.out.length, 8_000);
  assert.equal(res.step, "读取了 big.log");
});
