import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Front du tableau de bord. En dev, /api est relayé vers l'API Hono (src/web/dev.ts). */
const apiPort = Number(process.env.PERSONAS_API_PORT ?? 5174);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
});
