import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_CONFIG, migrateHub, type HubDb } from "../db/client";
import { schema } from "../db/schema";

// Base partagée (Supabase auto-hébergé) : le schéma personas_hub est créé par un administrateur pour
// un rôle qui n'a AUCUN droit CREATE sur la base. Le migrateur du Hub doit passer quand même.

let client: PGlite | null = null;
afterEach(async () => {
  await client?.close();
  client = null;
});

async function sharedDatabase() {
  client = new PGlite();
  await client.exec(`
    create role personas_hub nologin;
    revoke create on database postgres from public;
    create schema personas_hub authorization personas_hub;
  `);
  const db = drizzle(client, { schema }) as unknown as HubDb;
  return { client, db };
}

const rows = (r: unknown) => (r as { rows: Array<Record<string, unknown>> }).rows;

describe("migrations du Hub sur une base partagée", () => {
  it("le rôle n'a pas le droit CREATE sur la base : le migrateur de Drizzle échoue (témoin)", async () => {
    const { client } = await sharedDatabase();
    await client.exec("set role personas_hub");
    await expect(migrate(drizzle(client, { schema }), MIGRATIONS_CONFIG)).rejects.toThrow();
  });

  it("schéma pré-créé par un autre rôle : migrateHub applique tout sans CREATE SCHEMA", async () => {
    const { client, db } = await sharedDatabase();
    await client.exec("set role personas_hub");
    expect(rows(await db.execute(sql`select has_database_privilege(current_user, current_database(), 'CREATE') as c`))[0]!.c).toBe(false);

    const first = await migrateHub(db);
    expect(first.applied).toBeGreaterThan(0);

    // Tables et suivi des migrations dans personas_hub, propriété du rôle
    const tables = rows(await db.execute(sql`select tablename, tableowner from pg_tables where schemaname = 'personas_hub' order by 1`));
    expect(tables.map((t) => t.tablename)).toEqual(expect.arrayContaining(["__drizzle_migrations", "modules", "module_versions"]));
    expect(new Set(tables.map((t) => t.tableowner))).toEqual(new Set(["personas_hub"]));
    expect(rows(await db.execute(sql`select count(*)::int as n from pg_namespace where nspname = 'drizzle'`))[0]!.n).toBe(0);

    // Redémarrage : rien à rejouer, toujours sans droit CREATE sur la base
    expect((await migrateHub(db)).applied).toBe(0);
  });

  it("schéma absent : migrateHub le crée (base dédiée, tests)", async () => {
    client = new PGlite();
    const db = drizzle(client, { schema }) as unknown as HubDb;
    await migrateHub(db);
    expect(rows(await db.execute(sql`select count(*)::int as n from pg_namespace where nspname = 'personas_hub'`))[0]!.n).toBe(1);
  });
});
