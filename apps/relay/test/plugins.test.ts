import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import type { AssistantPluginId, PluginManifest, PocketPluginId } from "@herdr-pocket/protocol";
import { Assistant, type AssistantHost } from "../src/assistant/assistant.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/assistant/llm.ts";
import {
  DEFAULT_PLUGINS,
  HERDR_PLUGIN_TOOLS,
  SECRET_MASK,
  UNIFLO_PLUGIN_TOOLS,
  assertPublicHttpUrl,
  disabledBuiltinToolMessage,
  executePluginTool,
  filterBuiltinToolsByPlugins,
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
import { Store } from "../src/store.ts";

interface PluginRegistryModule {
  ALL_PLUGINS: readonly PluginManifest[];
  ASSISTANT_PLUGINS: readonly PluginManifest[];
  ASSISTANT_PLUGIN_IDS: readonly AssistantPluginId[];
  POCKET_PLUGINS: readonly PluginManifest[];
  POCKET_PLUGIN_IDS: readonly PocketPluginId[];
  HERDR_PLUGIN_TOOLS: Set<string>;
  UNIFLO_PLUGIN_TOOLS: Set<string>;
  getPluginManifest: (id: string) => PluginManifest | undefined;
  validatePluginManifest: (raw: unknown) => raw is PluginManifest;
}

function extractProtocolUnion(src: string, typeName: string): string[] {
  const re = new RegExp(`export\\s+type\\s+${typeName}\\s*=([^;]+);`);
  const match = re.exec(src);
  assert.ok(match, `expected ${typeName} declaration in packages/protocol/src/index.ts`);
  const members = [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(members.length > 0, `expected string literal members in ${typeName}`);
  return members;
}

function listSubdirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

test("default Xiaoyang plugins enable herdr and uniflo, keep optional plugins off", () => {
  assert.deepEqual(DEFAULT_PLUGINS, {
    herdr: true,
    uniflo: true,
    browser: false,
    workspace: false,
    webfetch: false,
    webhooks: false,
  });
  assert.deepEqual(serializePlugins(DEFAULT_PLUGINS), {});
  assert.deepEqual(
    serializePlugins({ ...DEFAULT_PLUGINS, herdr: false, uniflo: false, browser: true }),
    { herdr: false, uniflo: false, browser: true },
  );
  assert.deepEqual(pluginToolDefs(DEFAULT_PLUGINS, []), []);
  assert.deepEqual(normalizePlugins(null), DEFAULT_PLUGINS);
  assert.deepEqual(normalizePlugins({ herdr: false, webfetch: true }), {
    herdr: false,
    uniflo: true,
    browser: false,
    workspace: false,
    webfetch: true,
    webhooks: false,
  });
});

test("toggling herdr and uniflo off filters TOOLS and blocks execution in Assistant.tool()", async () => {
  // Direct helper checks
  const sampleTools = [
    { name: "list_agents", description: "", input_schema: { type: "object", properties: {} } },
    { name: "herdr_do", description: "", input_schema: { type: "object", properties: {} } },
    { name: "search_sessions", description: "", input_schema: { type: "object", properties: {} } },
    { name: "usage", description: "", input_schema: { type: "object", properties: {} } },
    { name: "set_reminder", description: "", input_schema: { type: "object", properties: {} } },
  ];
  assert.deepEqual(
    filterBuiltinToolsByPlugins(sampleTools, { ...DEFAULT_PLUGINS, herdr: false }).map((t) => t.name),
    ["search_sessions", "usage", "set_reminder"],
  );
  assert.deepEqual(
    filterBuiltinToolsByPlugins(sampleTools, { ...DEFAULT_PLUGINS, uniflo: false }).map((t) => t.name),
    ["list_agents", "herdr_do", "set_reminder"],
  );
  assert.equal(disabledBuiltinToolMessage("list_agents", DEFAULT_PLUGINS), null);
  assert.match(disabledBuiltinToolMessage("list_agents", { ...DEFAULT_PLUGINS, herdr: false }) ?? "", /Herdr 插件已关闭/);
  assert.match(disabledBuiltinToolMessage("search_sessions", { ...DEFAULT_PLUGINS, uniflo: false }) ?? "", /Uniflo 插件已关闭/);

  // End-to-end Assistant gating test
  const dir = mkdtempSync(join(tmpdir(), "pocket-plugin-gate-"));
  const store = new Store(join(dir, "t.db"));
  const rpcCalls: Array<{ deviceId: string; method: string }> = [];
  const requests: LlmRequest[] = [];
  let idleWaiter: (() => void) | null = null;
  let script: (req: LlmRequest) => LlmResult = () => ({
    content: [{ type: "text", text: "好的" }],
    stopReason: "end_turn",
    model: "test",
  });

  const host: AssistantHost = {
    devices: () => [],
    agents: () => [],
    call: async (deviceId, method) => {
      rpcCalls.push({ deviceId, method });
      throw new Error(`unexpected RPC ${method}`);
    },
    toViewers: (frame) => {
      if (frame.type === "assistant_busy" && !frame.busy && idleWaiter) {
        const resolve = idleWaiter;
        idleWaiter = null;
        resolve();
      }
    },
    log: () => {},
  };

  const llm: Llm = async (req) => {
    requests.push(req);
    return script(req);
  };

  const assistant = new Assistant({ store, host, llm, promptEpoch: 0 });
  const runTurn = async (prompt: string, handler: (req: LlmRequest) => LlmResult) => {
    script = handler;
    const done = new Promise<void>((resolve) => {
      idleWaiter = resolve;
    });
    assistant.say(prompt);
    await done;
  };

  try {
    // 1. Defaults ON: both Herdr and Uniflo tools are exposed to the LLM
    await runTurn("默认检查", () => ({
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      model: "test",
    }));
    const defaultToolNames = new Set(requests.at(-1)!.tools.map((t) => t.name));
    for (const name of HERDR_PLUGIN_TOOLS) {
      assert.equal(defaultToolNames.has(name), true, `expected default tools to include ${name}`);
    }
    for (const name of UNIFLO_PLUGIN_TOOLS) {
      assert.equal(defaultToolNames.has(name), true, `expected default tools to include ${name}`);
    }

    // 2. Disable herdr: removes Herdr tools from TOOLS and blocks direct tool execution
    assistant.updateSettings({ plugins: { herdr: false } }, "test");
    let herdrToolCallCount = 0;
    await runTurn("关闭 herdr 后试试", (req) => {
      herdrToolCallCount += 1;
      if (herdrToolCallCount === 1) {
        return {
          content: [{ type: "tool_use", id: "call-herdr", name: "list_agents", input: {} }],
          stopReason: "tool_use",
          model: "test",
        };
      }
      return { content: [{ type: "text", text: "明白了" }], stopReason: "end_turn", model: "test" };
    });
    const noHerdrReq = requests.at(-2)!;
    const noHerdrNames = new Set(noHerdrReq.tools.map((t) => t.name));
    for (const name of HERDR_PLUGIN_TOOLS) {
      assert.equal(noHerdrNames.has(name), false, `expected herdr=false to remove ${name}`);
    }
    for (const name of UNIFLO_PLUGIN_TOOLS) {
      assert.equal(noHerdrNames.has(name), true, `expected herdr=false to keep ${name}`);
    }
    assert.equal(noHerdrNames.has("set_reminder"), true);
    const herdrBlockedReply = requests.at(-1)!.messages.at(-1)!;
    const herdrResultText = Array.isArray(herdrBlockedReply.content)
      ? herdrBlockedReply.content
          .filter((b) => b.type === "tool_result")
          .map((b) => (b as { content: string }).content)
          .join("\n")
      : "";
    assert.match(herdrResultText, /Herdr 插件已关闭/);

    // 3. Disable uniflo: removes Uniflo tools from TOOLS and blocks direct tool execution
    assistant.updateSettings({ plugins: { uniflo: false } }, "test");
    let unifloToolCallCount = 0;
    await runTurn("关闭 uniflo 后试试", () => {
      unifloToolCallCount += 1;
      if (unifloToolCallCount === 1) {
        return {
          content: [{ type: "tool_use", id: "call-uniflo", name: "search_sessions", input: { query: "abc" } }],
          stopReason: "tool_use",
          model: "test",
        };
      }
      return { content: [{ type: "text", text: "收到" }], stopReason: "end_turn", model: "test" };
    });
    const noUnifloReq = requests.at(-2)!;
    const noUnifloNames = new Set(noUnifloReq.tools.map((t) => t.name));
    for (const name of UNIFLO_PLUGIN_TOOLS) {
      assert.equal(noUnifloNames.has(name), false, `expected uniflo=false to remove ${name}`);
    }
    const unifloBlockedReply = requests.at(-1)!.messages.at(-1)!;
    const unifloResultText = Array.isArray(unifloBlockedReply.content)
      ? unifloBlockedReply.content
          .filter((b) => b.type === "tool_result")
          .map((b) => (b as { content: string }).content)
          .join("\n")
      : "";
    assert.match(unifloResultText, /Uniflo 插件已关闭/);
    assert.deepEqual(rpcCalls, []);
  } finally {
    assistant.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("folder-per-plugin contract: plugins/ disk layout matches registry.ts and protocol types", async () => {
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const pluginsDir = join(repoRoot, "plugins");
  const registry = (await import(pathToFileURL(join(pluginsDir, "registry.ts")).href)) as PluginRegistryModule;
  const {
    ALL_PLUGINS,
    ASSISTANT_PLUGINS,
    ASSISTANT_PLUGIN_IDS,
    HERDR_PLUGIN_TOOLS: REGISTRY_HERDR_TOOLS,
    POCKET_PLUGINS,
    POCKET_PLUGIN_IDS,
    UNIFLO_PLUGIN_TOOLS: REGISTRY_UNIFLO_TOOLS,
    getPluginManifest,
    validatePluginManifest,
  } = registry;

  // 1. Template folder contract
  const templateDir = join(pluginsDir, "_template");
  for (const requiredFile of ["manifest.json", "README.md", "index.ts"]) {
    const full = join(templateDir, requiredFile);
    assert.equal(existsSync(full), true, `missing plugins/_template/${requiredFile}`);
    assert.ok(readFileSync(full, "utf8").trim().length > 0, `empty plugins/_template/${requiredFile}`);
  }
  const templateJson = JSON.parse(readFileSync(join(templateDir, "manifest.json"), "utf8")) as unknown;
  assert.equal(validatePluginManifest(templateJson), true, "plugins/_template/manifest.json failed validation");
  const templateMod = (await import(pathToFileURL(join(templateDir, "index.ts")).href)) as {
    default: PluginManifest;
    manifest: PluginManifest;
  };
  assert.deepEqual(templateMod.default, templateJson);
  assert.deepEqual(templateMod.manifest, templateJson);

  // 2. Scan plugins/assistant/* and plugins/pocket/*
  const assistantFolders = listSubdirs(join(pluginsDir, "assistant"));
  const pocketFolders = listSubdirs(join(pluginsDir, "pocket"));
  assert.ok(assistantFolders.length > 0, "expected assistant plugin folders");
  assert.ok(pocketFolders.length > 0, "expected pocket plugin folders");

  const diskManifests = new Map<string, PluginManifest>();
  for (const [scope, folders] of [
    ["assistant", assistantFolders],
    ["pocket", pocketFolders],
  ] as const) {
    for (const folder of folders) {
      const dir = join(pluginsDir, scope, folder);
      for (const requiredFile of ["manifest.json", "README.md", "index.ts"]) {
        const full = join(dir, requiredFile);
        assert.equal(existsSync(full), true, `missing plugins/${scope}/${folder}/${requiredFile}`);
        assert.ok(readFileSync(full, "utf8").trim().length > 0, `empty plugins/${scope}/${folder}/${requiredFile}`);
      }
      const rawJson = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as unknown;
      assert.equal(
        validatePluginManifest(rawJson),
        true,
        `plugins/${scope}/${folder}/manifest.json failed validatePluginManifest`,
      );
      const manifest = rawJson as PluginManifest;
      assert.equal(manifest.id, folder, `manifest.id must match folder name for plugins/${scope}/${folder}`);
      assert.equal(manifest.scope, scope, `manifest.scope must match directory scope for plugins/${scope}/${folder}`);

      const mod = (await import(pathToFileURL(join(dir, "index.ts")).href)) as {
        default: PluginManifest;
        manifest: PluginManifest;
      };
      assert.deepEqual(mod.default, manifest, `index.ts default export diverged from manifest.json in ${scope}/${folder}`);
      assert.deepEqual(mod.manifest, manifest, `index.ts manifest export diverged from manifest.json in ${scope}/${folder}`);
      diskManifests.set(manifest.id, manifest);
    }
  }

  // 3. Registry sync
  assert.deepEqual([...ASSISTANT_PLUGIN_IDS].sort(), assistantFolders);
  assert.deepEqual(ASSISTANT_PLUGINS.map((p) => p.id).sort(), assistantFolders);
  assert.deepEqual([...POCKET_PLUGIN_IDS].sort(), pocketFolders);
  assert.deepEqual(POCKET_PLUGINS.map((p) => p.id).sort(), pocketFolders);
  assert.equal(ALL_PLUGINS.length, assistantFolders.length + pocketFolders.length);

  for (const [id, manifest] of diskManifests) {
    assert.deepEqual(getPluginManifest(id), manifest, `registry manifest mismatch for ${id}`);
  }

  // 4. Protocol union sync
  const protocolSrc = readFileSync(join(repoRoot, "packages/protocol/src/index.ts"), "utf8");
  const protocolAssistantIds = extractProtocolUnion(protocolSrc, "AssistantPluginId");
  const protocolPocketIds = extractProtocolUnion(protocolSrc, "PocketPluginId");
  assert.deepEqual([...protocolAssistantIds].sort(), assistantFolders);
  assert.deepEqual([...protocolPocketIds].sort(), pocketFolders);

  // Compile-time guard that registry IDs stay typed to protocol unions
  const _checkAssistantIds: readonly AssistantPluginId[] = ASSISTANT_PLUGIN_IDS;
  const _checkPocketIds: readonly PocketPluginId[] = POCKET_PLUGIN_IDS;
  assert.equal(_checkAssistantIds.length, assistantFolders.length);
  assert.equal(_checkPocketIds.length, pocketFolders.length);

  // 5. Relay plugin defaults & built-in tool sets match manifests
  for (const manifest of ASSISTANT_PLUGINS) {
    const id = manifest.id as AssistantPluginId;
    assert.equal(
      DEFAULT_PLUGINS[id],
      manifest.defaultEnabled,
      `DEFAULT_PLUGINS.${id} diverged from plugins/assistant/${id}/manifest.json`,
    );
  }
  assert.deepEqual([...HERDR_PLUGIN_TOOLS].sort(), [...REGISTRY_HERDR_TOOLS].sort());
  assert.deepEqual([...UNIFLO_PLUGIN_TOOLS].sort(), [...REGISTRY_UNIFLO_TOOLS].sort());
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
