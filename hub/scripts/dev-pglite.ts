import { serve } from "@hono/node-server";
import { openPglite } from "../db/client";
import { createHubApp } from "../src/app";
import { seed } from "./seed-official";

/**
 * Hub local de démonstration : Postgres embarqué (PGlite) en mémoire, amorcé avec les modules et packs
 * officiels du dépôt, pour regarder les pages publiques sans base externe.
 *
 *   PORT=8791 [SUPABASE_URL=…] [HUB_SIGNING_KEY=…] npx tsx hub/scripts/dev-pglite.ts
 *
 * HUB_SIGNING_KEY (facultatif, même format qu'en production : hub/src/signing.ts) : les versions amorcées
 * sont signées et la clé publique est servie par /v1/keys ; absente, les versions ne sont pas signées.
 */
const TOKEN = "d".repeat(48);
const { db } = await openPglite();
// SUPABASE_URL (facultatif) : affiche la page /device avec sa connexion (rien n'est appelé au rendu).
const app = createHubApp({ db, adminToken: TOKEN, publicBaseUrl: "", supabaseAnonKey: process.env.SUPABASE_ANON_KEY || undefined, auth: { supabaseUrl: process.env.SUPABASE_URL || undefined }, signingKey: process.env.HUB_SIGNING_KEY || undefined });
await seed(
  async (path, body) => {
    const r = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  },
  () => {},
);
const port = Number(process.env.PORT ?? 8791);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => console.log(`hub (pglite) http://127.0.0.1:${info.port}`));
