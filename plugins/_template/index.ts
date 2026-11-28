import type { PluginManifest } from "@herdr-pocket/protocol";
import manifestJson from "./manifest.json" with { type: "json" };

export const manifest: PluginManifest = manifestJson as PluginManifest;
export default manifest;
