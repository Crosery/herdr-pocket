import type { PluginManifest } from "@herdr-pocket/protocol";

export const manifest: PluginManifest = {
  id: "browser",
  scope: "assistant",
  category: "tools",
  name: "AI 浏览器操作",
  summary: "操控内置浏览器打开网页、执行操作与查看网络请求",
  defaultEnabled: false,
  tools: ["browser_act", "browser_run", "browser_net"],
  icon: "globe",
};

export default manifest;
