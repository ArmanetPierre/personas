import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createServer } from "vite";
import { createApp } from "./app";
import { API_DEV_PORT, createContext, HOST, ROOT, WEB_PORT } from "./context";

/**
 * `npm run dev:web` : l'API Hono (port interne) et Vite (port à ouvrir) dans un seul processus.
 * Vite relaie /api vers l'API (voir web/vite.config.ts).
 */

const ctx = createContext();
const api = serve({ fetch: createApp(ctx).fetch, port: API_DEV_PORT, hostname: HOST });
const vite = await createServer({ configFile: resolve(ROOT, "web/vite.config.ts"), server: { port: WEB_PORT, host: HOST, strictPort: true } });
await vite.listen();
console.log(`Personas — tableau de bord (dev) : http://localhost:${WEB_PORT}  (API interne sur ${API_DEV_PORT})`);

const stop = async () => {
  await vite.close();
  api.close();
  ctx.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
