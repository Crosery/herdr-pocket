import type { PluginManifest } from "@herdr-pocket/protocol";

export const manifest: PluginManifest = {
  id: "webhooks",
  scope: "assistant",
  category: "tools",
  name: "Webhook",
  summary: "接入自定义 HTTP POST 接口作为小羊工具",
  defaultEnabled: false,
  tools: ["webhook_*"],
  icon: "webhook",
};

export default manifest;
