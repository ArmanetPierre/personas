import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadConfig, loadDotEnv, runMode } from "../config";
import { openDb, runMigrations } from "../db/client";
import { resolveSoclePack } from "../population/target";
import type { AppContext } from "./app";
import { Launcher } from "./launcher";

/** Racine du dépôt (cwd des études lancées depuis le tableau de bord). */
export const ROOT = resolve(import.meta.dirname, "../..");

/** Port unique à ouvrir dans le navigateur (dev : Vite ; start : Hono). */
export const WEB_PORT = Number(process.env.PERSONAS_WEB_PORT ?? 5173);
/** Port interne de l'API en dev (Vite y relaie /api). */
export const API_DEV_PORT = Number(process.env.PERSONAS_API_PORT ?? 5174);
/** Le tableau de bord lance des processus : il n'écoute que sur la boucle locale. */
export const HOST = "127.0.0.1";

/** Jeton de session de l'API locale de configuration (en-tête `x-personas-session`), tiré au démarrage. */
export const newSessionToken = (): string => randomBytes(32).toString("base64url");

export function createContext(): AppContext & { close(): void } {
  loadDotEnv(resolve(ROOT, ".env"));
  const config = loadConfig();
  const dbPath = resolve(ROOT, config.DATABASE_PATH);
  // Premier lancement : la base est créée et migrée ici (drizzle/)
  const { sqlite, db } = openDb(dbPath);
  runMigrations(db);
  // Pack par défaut (création et estimation sans cible) : socle courant de la France (packs/socles.json),
  // pas le dossier historique packs/fr (fr-2026.1). Les études existantes gardent le pack de leurs personas.
  const pack = resolveSoclePack("fr");
  const dataDir = dirname(dbPath);
  // Paquet installé : les tâches de fond tournent dans le dossier de données (chemins relatifs « data/… »)
  const launcher = new Launcher({ root: ROOT, logDir: resolve(dataDir, "logs"), ...(runMode() === "installed" && { cwd: dataDir }) });
  return { db, pack, config, launcher, sessionToken: newSessionToken(), close: () => sqlite.close() };
}
