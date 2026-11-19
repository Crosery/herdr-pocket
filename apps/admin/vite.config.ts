import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../relay/src/admin/dist",
    emptyOutDir: true,
    assetsDir: "admin-assets",
  },
});
