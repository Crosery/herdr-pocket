import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "harmony" ? "./" : "/",
  define: {
    __POCKET_TARGET__: JSON.stringify(mode === "harmony" ? "harmony" : "desktop"),
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || "0.2.0"),
  },
  resolve: {
    alias: {
      "@herdr-pocket/protocol": path.resolve(__dirname, "../../packages/protocol/src/index.ts"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: mode === "harmony" ? "../harmony/entry/src/main/resources/rawfile" : "dist",
    emptyOutDir: true,
  },
}));
