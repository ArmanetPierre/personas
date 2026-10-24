import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { PACKAGE_ROOT } from "../config";
import { createHostedServer } from "./app";
import { loadHostedConfig } from "./config";

/**
 * `personas hosted start` (`npm run hosted:start`) : le service hébergé, API et front compilé (web/dist) sur un
 * seul port (PORT, 8081 par défaut). Variables : hosted/.env.example. Aucun `.env` n'est lu : la configuration vient
 * de l'environnement (docker compose `env_file`).
 */

process.env.PERSONAS_MODE = "hosted";
let config;
try {
  config = loadHostedConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
// La clé maître ne reste pas dans l'environnement du processus (déjà lue)
delete process.env.HOSTED_MASTER_KEY;
mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 });

const hosted = createHostedServer({ config, webDist: resolve(PACKAGE_ROOT, "web/dist") });
const server = serve({ fetch: hosted.app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Personas (service hébergé) : http://${config.host}:${info.port}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    hosted.close();
    server.close();
    process.exit(0);
  });
}
