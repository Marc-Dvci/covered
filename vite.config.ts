import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true, cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"], chunkSizeWarningLimit: 12000 },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
});
