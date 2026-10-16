import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { personas } from "../db/schema";
import type { Pack } from "../personas/pack";
import { drawPersona } from "../personas/sampler";
import { allPersonas } from "../personas/store";

/**
 * Migration de données vers le format modules (`extra.modules.<id>`), idempotente et générique :
 * chaque persona du pack est re-tirée (graine, rang) avec le moteur actuel ; si tous ses attributs
 * enregistrés sont identiques au nouveau tirage, on écrit `extra.modules` et on retire de `extra`
 * les clés que le moteur ne produit plus (ex. l'ancien `extra.founder`). Une persona dont le tirage
 * diffère n'est pas touchée et est signalée. Récits, ids et réponses d'étude restent intacts.
 */

export const SOCLE_FIELDS = [
  "firstName", "age", "sex", "region", "townSize", "occupation", "activityStatus", "pcs", "monthlyIncomeEur",
  "householdIncomeEur", "householdSize", "monthlyDiscretionaryBudgetEur", "householdType", "techAdoption",
  "priceSensitivity", "skepticism", "socialMediaUsage", "equipment", "subscriptions",
] as const;

export interface MigrationResult {
  total: number;
  migrated: number;
  already: number;
  mismatches: string[];
}

export function migratePackToModules(db: Db, pack: Pack, opts: { dryRun?: boolean } = {}): MigrationResult {
  const rows = allPersonas(db, { packVersion: pack.manifest.version });
  const result: MigrationResult = { total: rows.length, migrated: 0, already: 0, mismatches: [] };
  const updates: Array<{ id: string; extra: Record<string, unknown> }> = [];
  for (const row of rows) {
    if (row.seed === null || row.drawIndex === null) {
      result.mismatches.push(`${row.id} : graine ou rang inconnu`);
      continue;
    }
    const drawn = drawPersona(pack, row.seed, row.drawIndex);
    const diff: string[] = SOCLE_FIELDS.filter((f) => JSON.stringify(row[f]) !== JSON.stringify(drawn[f]));
    const stored = row.extra as Record<string, unknown>;
    const fresh = drawn.extra as Record<string, unknown>;
    for (const k of Object.keys(fresh)) {
      if (k !== "modules" && k in stored && JSON.stringify(stored[k]) !== JSON.stringify(fresh[k])) diff.push(`extra.${k}`);
    }
    if (drawn.id !== row.id) diff.push("id");
    if (diff.length) {
      result.mismatches.push(`${row.id} : tirage différent (${diff.join(", ")})`);
      continue;
    }
    const stale = Object.keys(stored).filter((k) => !(k in fresh));
    if (!stale.length && JSON.stringify(stored.modules) === JSON.stringify(fresh.modules)) {
      result.already++;
      continue;
    }
    // Ordre des clés : celui du moteur actuel
    updates.push({ id: row.id, extra: Object.fromEntries(Object.keys(fresh).map((k) => [k, k === "modules" ? fresh.modules : (stored[k] ?? fresh[k])])) });
    result.migrated++;
  }
  if (!opts.dryRun && updates.length) {
    db.transaction((tx) => {
      for (const u of updates) tx.update(personas).set({ extra: u.extra }).where(eq(personas.id, u.id)).run();
    });
  }
  return result;
}
