import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { createContext, HOST, ROOT } from "./context";

/**
 * L'API et le build du front (web/dist) sur un seul port de la boucle locale : `npm run start:web` (port fixe,
 * 5173 par défaut) et `personas ui` (port libre).
 */

export const WEB_DIST = resolve(ROOT, "web/dist");

export class MissingBuildError extends Error {
  override name = "MissingBuildError";
}

export interface Dashboard {
  url: string;
  port: number;
  /** Ferme le serveur et la base (sans attendre les connexions ouvertes). */
  close(): void;
}

/** Démarre le tableau de bord. `port: 0` : port libre choisi par le système. */
export async function startDashboard(opts: { port: number; host?: string }): Promise<Dashboard> {
  if (!existsSync(resolve(WEB_DIST, "index.html"))) throw new MissingBuildError("Build introuvable (web/dist) : lancer d'abord npm run build:web.");
  const ctx = createContext();
  const app = createApp(ctx);
  app.use("/assets/*", serveStatic({ root: WEB_DIST }));
  app.use("/favicon.svg", serveStatic({ root: WEB_DIST }));
  // Application monopage : toute autre URL renvoie index.html (relu à chaque fois : un nouveau build est pris sans redémarrer)
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Route inconnue." }, 404) : c.html(readFileSync(resolve(WEB_DIST, "index.html"), "utf8"))));

  const host = opts.host ?? HOST;
  const server = await new Promise<ReturnType<typeof serve>>((ok, fail) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: host }, () => ok(s));
    s.once("error", fail);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}`,
    port,
    close: () => {
      server.close();
      if ("closeAllConnections" in server) server.closeAllConnections();
      ctx.close();
    },
  };
}
