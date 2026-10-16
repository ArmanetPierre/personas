import { dirname, resolve } from "node:path";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
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

export function createContext(): AppContext & { close(): void } {
  loadDotEnv(resolve(ROOT, ".env"));
  const config = loadConfig();
  const dbPath = resolve(ROOT, config.DATABASE_PATH);
  const { sqlite, db } = openDb(dbPath);
  runMigrations(db);
  const pack = loadPack("fr");
  const launcher = new Launcher({ root: ROOT, logDir: resolve(dirname(dbPath), "logs") });
  return { db, pack, config, launcher, close: () => sqlite.close() };
}
