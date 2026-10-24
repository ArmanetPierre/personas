import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, loadDotEnv } from "../../config";
import { openDb } from "../../db/client";
import type { Project } from "../../db/schema";
import { getProject } from "../../studies/project";

/** Outils communs aux tâches détachées du tableau de bord (src/web/jobs/*). */

export const ROOT = resolve(import.meta.dirname, "../../..");

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

export function loadProject(id: string): Project {
  loadDotEnv(resolve(ROOT, ".env"));
  const config = loadConfig();
  const { sqlite, db } = openDb(resolve(ROOT, config.DATABASE_PATH));
  try {
    const p = getProject(db, id);
    if (!p) throw new Error(`Projet introuvable : ${id}`);
    return p;
  } finally {
    sqlite.close();
  }
}

/** Écriture atomique d'un résultat JSON (lu par l'API pendant que la tâche tourne). */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export async function main(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`Échec : ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
