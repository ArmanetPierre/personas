import { and, asc, count, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { personas, responses, type Persona } from "../db/schema";
import { Rng } from "./rng";
import type { DrawnPersona } from "./sampler";

/** Accès SQLite aux personas. */

export function countPersonas(db: Db, filter: { packVersion?: string; seed?: number } = {}): number {
  const conds = [];
  if (filter.packVersion) conds.push(eq(personas.packVersion, filter.packVersion));
  if (filter.seed !== undefined) conds.push(eq(personas.seed, filter.seed));
  const [row] = db.select({ n: count() }).from(personas).where(conds.length ? and(...conds) : undefined).all();
  return row?.n ?? 0;
}

export function insertPersonas(db: Db, rows: DrawnPersona[]): void {
  db.transaction((tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      tx.insert(personas).values(rows.slice(i, i + 200)).run();
    }
  });
}

/** Supprime les personas d'un tirage. Refuse si des réponses d'étude y font référence. */
export function deleteDraw(db: Db, packVersion: string, seed: number): number {
  const [used] = db
    .select({ n: count() })
    .from(responses)
    .innerJoin(personas, eq(responses.personaId, personas.id))
    .where(and(eq(personas.packVersion, packVersion), eq(personas.seed, seed)))
    .all();
  if ((used?.n ?? 0) > 0) {
    throw new Error(`${used!.n} réponse(s) d'étude utilisent ces personas : suppression refusée.`);
  }
  return db.delete(personas).where(and(eq(personas.packVersion, packVersion), eq(personas.seed, seed))).run().changes;
}

export function personasWithoutNarrative(db: Db, limit?: number): Persona[] {
  const q = db.select().from(personas).where(isNull(personas.narrative)).orderBy(asc(personas.packVersion), asc(personas.seed), asc(personas.drawIndex));
  return limit !== undefined ? q.limit(limit).all() : q.all();
}

/**
 * Personas à (re)narrer : sans récit, ou, avec `regenerateBefore`, dont le récit date d'avant cette date
 * (`narrative_at`). L'ancien récit reste en place jusqu'à son remplacement : reprenable sans trou.
 */
export function personasToNarrate(db: Db, opts: { limit?: number; regenerateBefore?: string; packVersion?: string } = {}): Persona[] {
  const todo = opts.regenerateBefore
    ? or(isNull(personas.narrative), isNull(personas.narrativeAt), lt(personas.narrativeAt, opts.regenerateBefore))
    : isNull(personas.narrative);
  const cond = opts.packVersion ? and(todo, eq(personas.packVersion, opts.packVersion)) : todo;
  const q = db.select().from(personas).where(cond).orderBy(asc(personas.packVersion), asc(personas.seed), asc(personas.drawIndex));
  return opts.limit !== undefined ? q.limit(opts.limit).all() : q.all();
}

export function saveNarrative(db: Db, id: string, narrative: string, meta: { backend: string; model: string }): void {
  db.update(personas)
    .set({ narrative, narrativeBackend: meta.backend, narrativeModel: meta.model, narrativeAt: new Date().toISOString() })
    .where(eq(personas.id, id))
    .run();
}

export function allPersonas(db: Db, filter: { packVersion?: string; seed?: number } = {}): Persona[] {
  const conds = [];
  if (filter.packVersion) conds.push(eq(personas.packVersion, filter.packVersion));
  if (filter.seed !== undefined) conds.push(eq(personas.seed, filter.seed));
  return db.select().from(personas).where(conds.length ? and(...conds) : undefined).orderBy(asc(personas.drawIndex)).all();
}

export function getPersona(db: Db, id: string): Persona | undefined {
  return db.select().from(personas).where(eq(personas.id, id)).get();
}

/** Échantillon pseudo-aléatoire, reproductible pour un même `salt`. */
export function samplePersonas(db: Db, n: number, opts: { withNarrative?: boolean; salt?: number; packVersion?: string } = {}): Persona[] {
  const conds = [];
  if (opts.withNarrative) conds.push(isNotNull(personas.narrative));
  if (opts.packVersion) conds.push(eq(personas.packVersion, opts.packVersion));
  const rows = db
    .select()
    .from(personas)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(personas.id))
    .all();
  const rng = new Rng(`show:${opts.salt ?? 0}`);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
  }
  return rows.slice(0, n);
}
