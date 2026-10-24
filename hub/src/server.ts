import { serve } from "@hono/node-server";
import { openPostgres } from "../db/client";
import { createHubApp } from "./app";
import { refreshStalePreviews, signMissingVersions } from "./publish";
import { loadSigner } from "./signing";

/**
 * Point d'entrée du Hub (production). Variables :
 *  - DATABASE_URL (obligatoire) : Postgres ; tout est dans le schéma personas_hub.
 *  - HUB_ADMIN_TOKEN : jeton d'administration (32 caractères au moins) ; absent : publication désactivée.
 *  - PUBLIC_BASE_URL : adresse publique (liens canoniques des pages).
 *  - PORT (8080), HOST (0.0.0.0), TRUST_PROXY (1 derrière le reverse proxy), HUB_MIGRATE (1).
 *  - HUB_RATE_READ, HUB_RATE_ADMIN : requêtes par minute et par IP (600, 60) ; HUB_RATE_WRITE :
 *    écritures authentifiées par minute et par utilisateur (30).
 * Phase 3 (Hub collaboratif) :
 *  - SUPABASE_URL : Supabase Auth (émetteur `<url>/auth/v1`, JWKS `<url>/auth/v1/.well-known/jwks.json`) ;
 *  - SUPABASE_ANON_KEY : clé anonyme (publique) de Supabase, pour le lien magique de la page /device ;
 *  - SUPABASE_JWT_SECRET : secret HS256 du projet (mode historique ; sinon JWKS) ;
 *  - SUPABASE_JWKS_URL, SUPABASE_JWT_ISSUER, SUPABASE_JWT_AUDIENCE (authenticated) : surcharges ;
 *  - HUB_ADMINS, HUB_MODERATORS : e-mails ou ids Supabase, séparés par des virgules (rôles) ;
 *  - HUB_SIGNING_KEY : graine Ed25519 (32 octets, base64) ou PKCS#8 ; absente : versions non signées.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL manquant.");
  process.exit(2);
}
const adminToken = process.env.HUB_ADMIN_TOKEN || undefined;
if (adminToken && adminToken.length < 32) {
  console.error("HUB_ADMIN_TOKEN trop court (32 caractères au moins, par exemple : openssl rand -hex 32).");
  process.exit(2);
}
const { db, close } = await openPostgres(url, { migrate: process.env.HUB_MIGRATE !== "0" });
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const signer = loadSigner(process.env.HUB_SIGNING_KEY);
if (signer) {
  const n = await signMissingVersions(db, signer);
  if (n) console.log(JSON.stringify({ at: new Date().toISOString(), msg: "signed existing versions", count: n, kid: signer.kid }));
}
const app = createHubApp({
  db,
  adminToken,
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  trustProxy: process.env.TRUST_PROXY === "1",
  rateLimit: { readPerMinute: Number(process.env.HUB_RATE_READ ?? 600), adminPerMinute: Number(process.env.HUB_RATE_ADMIN ?? 60), writePerMinute: Number(process.env.HUB_RATE_WRITE ?? 30) },
  signer,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || undefined,
  auth: {
    supabaseUrl: process.env.SUPABASE_URL || undefined,
    jwtSecret: process.env.SUPABASE_JWT_SECRET || undefined,
    jwksUrl: process.env.SUPABASE_JWKS_URL || undefined,
    issuer: process.env.SUPABASE_JWT_ISSUER || undefined,
    audience: process.env.SUPABASE_JWT_AUDIENCE || undefined,
    admins: list(process.env.HUB_ADMINS),
    moderators: list(process.env.HUB_MODERATORS),
  },
  log: (line) => console.log(JSON.stringify(line)),
});
const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: "hub listening", port: info.port, admin: adminToken ? "enabled" : "disabled", signing: signer ? signer.kid : "disabled" }));
});
// Aperçus d'un format ancien (ou absents) : recalculés en arrière-plan, une version à la fois, le serveur répond pendant ce temps
setImmediate(() => {
  refreshStalePreviews(db, { log: (line) => console.log(JSON.stringify(line)) }).catch((err: Error) => console.error(JSON.stringify({ at: new Date().toISOString(), msg: "preview refresh aborted", error: err.message })));
});
const stop = () => {
  server.close();
  void close().finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
