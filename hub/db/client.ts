import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { schema } from "./schema";

/** Base du Hub : Postgres (postgres-js) en production, PGlite dans les tests. Même code de requêtes. */
export type HubDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export const MIGRATIONS_DIR = resolve(import.meta.dirname, "migrations");
/** Table des migrations dans le schéma du Hub (et pas dans un schéma `drizzle` partagé). */
export const MIGRATIONS_CONFIG = { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: "personas_hub", migrationsTable: "__drizzle_migrations" } as const;

export const HUB_SCHEMA = "personas_hub";
/** `CREATE SCHEMA IF NOT EXISTS "personas_hub"` (première instruction de 0000_init.sql). */
const CREATE_HUB_SCHEMA = /^\s*CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+"?personas_hub"?\s*;?\s*$/i;

/** Lignes d'un `db.execute` : tableau (postgres-js) ou `{ rows }` (PGlite). */
function rowsOf<T>(r: unknown): T[] {
  return (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];
}

/**
 * Migrations du Hub, compatibles avec la table de suivi de Drizzle (`personas_hub.__drizzle_migrations`,
 * mêmes colonnes, même règle « created_at < folderMillis »).
 *
 * Différence avec `migrate()` de Drizzle : `CREATE SCHEMA IF NOT EXISTS` n'est émis que si le schéma
 * n'existe pas. Postgres vérifie le droit CREATE sur la base AVANT de regarder si le schéma existe :
 * un rôle cantonné à un schéma créé pour lui (cas d'une base partagée, voir hub/README.md) serait
 * refusé par Drizzle à chaque démarrage. Quand le schéma existe, l'instruction équivalente de
 * 0000_init.sql est sautée pour la même raison.
 */
export async function migrateHub(db: HubDb, migrationsFolder = MIGRATIONS_DIR): Promise<{ applied: number }> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const exists = async () =>
    rowsOf<{ n: number | string }>(await db.execute(sql`select count(*)::int as n from pg_catalog.pg_namespace where nspname = ${HUB_SCHEMA}`))[0]?.n;
  const schemaExists = Number(await exists()) > 0;
  if (!schemaExists) await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${HUB_SCHEMA}"`));
  const table = sql.raw(`"${HUB_SCHEMA}"."${MIGRATIONS_CONFIG.migrationsTable}"`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
  const last = rowsOf<{ created_at: string | number }>(await db.execute(sql`select id, hash, created_at from ${table} order by created_at desc limit 1`))[0];
  let applied = 0;
  await db.transaction(async (tx) => {
    for (const m of migrations) {
      if (last && Number(last.created_at) >= m.folderMillis) continue;
      for (const stmt of m.sql) {
        if (CREATE_HUB_SCHEMA.test(stmt)) continue; // déjà traité ci-dessus (créé si absent)
        if (stmt.trim()) await tx.execute(sql.raw(stmt));
      }
      await tx.execute(sql`insert into ${table} ("hash", "created_at") values (${m.hash}, ${m.folderMillis})`);
      applied++;
    }
  });
  return { applied };
}

/** Connexion Postgres de production (DATABASE_URL), migrations appliquées. */
export async function openPostgres(url: string, opts: { migrate?: boolean; max?: number } = {}): Promise<{ db: HubDb; close: () => Promise<void> }> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const client = postgres(url, { max: opts.max ?? 5, onnotice: () => {} });
  const db = drizzle(client, { schema });
  if (opts.migrate ?? true) await migrateHub(db as unknown as HubDb);
  return { db: db as unknown as HubDb, close: () => client.end() };
}

/** Postgres embarqué en mémoire (PGlite), migrations appliquées : tests et démonstrations locales. */
export async function openPglite(): Promise<{ db: HubDb; close: () => Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrateHub(db as unknown as HubDb);
  return { db: db as unknown as HubDb, close: () => client.close() };
}
