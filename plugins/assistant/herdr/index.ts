import type { PluginManifest } from "@herdr-pocket/protocol";

export const manifest: PluginManifest = {
  id: "herdr",
  scope: "assistant",
  category: "tools",
  name: "Herdr",
  summary: "管理空间、标签、终端与运行中的 Agent",
  defaultEnabled: true,
  tools: [
    "list_agents",
    "list_devices",
    "read_agent",
    "send_to_agent",
    "press_keys",
    "list_launchers",
    "create_agent",
    "interrupt_agent",
    "close_agent",
    "list_spaces",
    "create_space",
    "herdr_do",
    "costs",
  ],
  icon: "terminal",
};

export default manifest;
