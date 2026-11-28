import type { AssistantPluginId, PluginManifest, PocketPluginId } from "@herdr-pocket/protocol";
import herdrPlugin from "./assistant/herdr/index.ts";
import unifloPlugin from "./assistant/uniflo/index.ts";
import browserPlugin from "./assistant/browser/index.ts";
import workspacePlugin from "./assistant/workspace/index.ts";
import webfetchPlugin from "./assistant/webfetch/index.ts";
import webhooksPlugin from "./assistant/webhooks/index.ts";
import aiBrowserPlugin from "./pocket/ai-browser/index.ts";

export const ASSISTANT_PLUGINS: readonly PluginManifest[] = [
  herdrPlugin,
  unifloPlugin,
  browserPlugin,
  workspacePlugin,
  webfetchPlugin,
  webhooksPlugin,
];

export const POCKET_PLUGINS: readonly PluginManifest[] = [
  aiBrowserPlugin,
];

export const ALL_PLUGINS: readonly PluginManifest[] = [
  ...ASSISTANT_PLUGINS,
  ...POCKET_PLUGINS,
];

export const ASSISTANT_PLUGIN_IDS: readonly AssistantPluginId[] = [
  "herdr",
  "uniflo",
  "browser",
  "workspace",
  "webfetch",
  "webhooks",
];

export const POCKET_PLUGIN_IDS: readonly PocketPluginId[] = [
  "ai-browser",
];

export const HERDR_PLUGIN_TOOLS = new Set<string>(herdrPlugin.tools ?? []);
export const UNIFLO_PLUGIN_TOOLS = new Set<string>(unifloPlugin.tools ?? []);

export function getPluginManifest(id: string): PluginManifest | undefined {
  return ALL_PLUGINS.find((p) => p.id === id);
}

export function validatePluginManifest(raw: unknown): raw is PluginManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.id)) return false;
  if (m.scope !== "assistant" && m.scope !== "pocket") return false;
  if (m.category !== "tools" && m.category !== "cli" && m.category !== "workflow") return false;
  if (typeof m.name !== "string" || !m.name.trim()) return false;
  if (typeof m.summary !== "string" || !m.summary.trim()) return false;
  if (typeof m.defaultEnabled !== "boolean") return false;
  if (typeof m.icon !== "string" || !m.icon.trim()) return false;
  if (m.scope === "assistant" && (!Array.isArray(m.tools) || m.tools.length === 0)) return false;
  if (m.scope === "pocket" && (typeof m.configKey !== "string" || !m.configKey.trim())) return false;
  return true;
}
