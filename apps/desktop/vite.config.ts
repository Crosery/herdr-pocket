import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const isHarmony = mode === "harmony";
  const isWeb = mode === "web" || process.env.POCKET_WEB_TARGET === "relay";
  return {
    plugins: [react()],
    base: isHarmony || isWeb ? "./" : "/",
    define: {
      __POCKET_TARGET__: JSON.stringify(isHarmony ? "harmony" : isWeb ? "web" : "desktop"),
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
      outDir: isHarmony
        ? "../harmony/entry/src/main/resources/rawfile"
        : isWeb
          ? "../relay/src/web/dist"
          : "dist",
      emptyOutDir: true,
    },
  };
});
