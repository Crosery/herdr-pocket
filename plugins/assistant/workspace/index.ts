import type { PluginManifest } from "@herdr-pocket/protocol";

export const manifest: PluginManifest = {
  id: "workspace",
  scope: "assistant",
  category: "tools",
  name: "代码与 Git",
  summary: "只读查看仓库 Git 状态、差异与文件内容",
  defaultEnabled: false,
  tools: ["inspect_workspace"],
  icon: "folder-search",
};

export default manifest;
