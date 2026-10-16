import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { createContext, HOST, ROOT, WEB_PORT } from "./context";

/** `npm run start:web` : l'API et le build du front (web/dist) sur un seul port. */

const dist = resolve(ROOT, "web/dist");
if (!existsSync(resolve(dist, "index.html"))) {
  console.error("Build introuvable (web/dist) : lancer d'abord npm run build:web.");
  process.exit(1);
}

const ctx = createContext();
const app = createApp(ctx);
app.use("/assets/*", serveStatic({ root: dist }));
app.use("/favicon.svg", serveStatic({ root: dist }));
// Application monopage : toute autre URL renvoie index.html (relu à chaque fois : un nouveau build est pris sans redémarrer)
app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Route inconnue." }, 404) : c.html(readFileSync(resolve(dist, "index.html"), "utf8"))));

serve({ fetch: app.fetch, port: WEB_PORT, hostname: HOST }, (info) => {
  console.log(`Personas — tableau de bord : http://localhost:${info.port}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (ctx.close(), process.exit(0)));
