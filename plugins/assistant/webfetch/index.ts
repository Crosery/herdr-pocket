import type { PluginManifest } from "@herdr-pocket/protocol";

export const manifest: PluginManifest = {
  id: "webfetch",
  scope: "assistant",
  category: "tools",
  name: "网页阅读",
  summary: "抓取公开网页正文供小羊阅读参考",
  defaultEnabled: false,
  tools: ["fetch_webpage"],
  icon: "book-open",
};

export default manifest;
