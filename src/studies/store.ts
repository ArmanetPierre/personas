import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import type { Db } from "../db/client";
import { personas, responses, studies, type Persona, type ResponseRow, type Study } from "../db/schema";

/** Accès SQLite aux études et réponses. */

export function newStudyId(): string {
  return `st-${randomBytes(3).toString("hex")}`;
}

/** Retrouve une étude par id exact ou par préfixe unique. */
export function findStudy(db: Db, idOrPrefix: string): Study {
  const exact = db.select().from(studies).where(eq(studies.id, idOrPrefix)).get();
  if (exact) return exact;
  const rows = db.select().from(studies).where(like(studies.id, `${idOrPrefix}%`)).all();
  if (rows.length === 1) return rows[0]!;
  throw new Error(rows.length ? `Préfixe ambigu : ${idOrPrefix}` : `Étude introuvable : ${idOrPrefix}`);
}

export function listStudies(db: Db): Study[] {
  return db.select().from(studies).orderBy(desc(studies.createdAt)).all();
}

export function personasByIds(db: Db, ids: string[]): Persona[] {
  const byId = new Map<string, Persona>();
  for (let i = 0; i < ids.length; i += 500) {
    for (const p of db.select().from(personas).where(inArray(personas.id, ids.slice(i, i + 500))).all()) byId.set(p.id, p);
  }
  return ids.map((id) => {
    const p = byId.get(id);
    if (!p) throw new Error(`Persona introuvable : ${id}`);
    return p;
  });
}

export function studyResponses(db: Db, studyId: string, questionKey?: string): ResponseRow[] {
  return db
    .select()
    .from(responses)
    .where(questionKey ? and(eq(responses.studyId, studyId), eq(responses.questionKey, questionKey)) : eq(responses.studyId, studyId))
    .orderBy(asc(responses.createdAt))
    .all();
}

export function updateStudy(db: Db, id: string, values: Partial<typeof studies.$inferInsert>): void {
  db.update(studies).set(values).where(eq(studies.id, id)).run();
}

/**
 * Passes répétées d'une étude (indice de confiance) : autres études terminées du même projet,
 * au même protocole et à la même version.
 */
export function repeatStudies(db: Db, study: Study): string[] {
  return listStudies(db)
    .filter((s) => s.id !== study.id && s.projectId === study.projectId && s.protocol === study.protocol && s.protocolVersion === study.protocolVersion && s.status === "completed")
    .map((s) => s.id);
}
