import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { personas } from "../../src/db/schema";
import { loadPack } from "../../src/personas/pack";
import { targetSpecSchema } from "../../src/population/target";
import { createProject, readProjectFile } from "../../src/studies/project";
import { createStudy } from "../../src/studies/study";

/**
 * Non-régression (tests V1, C14 B1) : deux projets aux jeux de modules différents, même socle, même graine.
 * Les personas ont le même (pack, graine, rang) mais des identifiants distincts (suffixe -m<empreinte>) :
 * la seconde étude doit se créer sans `UNIQUE constraint failed: personas.pack_version, seed, draw_index`.
 */
describe("tirage : deux jeux de modules à la même graine", () => {
  it("crée les deux études sans collision ni réécriture", () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const base = readProjectFile("examples/meal-planner.json");
    createProject(db, { ...base, id: "num2" });
    createProject(db, { ...base, id: "num" });
    const pack = loadPack("fr");
    const opts = { seed: 7, backend: "ollama", model: "m", protocolVersion: "2" as const, force: true };
    const pop = (modules: string[]) => [{ group: "target", n: 20, target: targetSpecSchema.parse({ socle: "fr", modules }) }];

    const a = createStudy(db, pack, { ...opts, projectId: "num2", populations: pop(["numerique", "entrepreneuriat"]) }).study;
    const before = db.select().from(personas).all();
    const b = createStudy(db, pack, { ...opts, projectId: "num", populations: pop(["numerique"]) }).study;

    const idsA = a.personaIds as string[];
    const idsB = b.personaIds as string[];
    expect(idsA).toHaveLength(20);
    expect(idsB).toHaveLength(20);
    expect(idsA.every((id) => /-m[0-9a-f]{6}$/.test(id))).toBe(true);
    expect(idsB.every((id) => /-m[0-9a-f]{6}$/.test(id))).toBe(true);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);

    // Même (pack, graine, rang) en base pour au moins une paire : c'est le cas qui échouait
    const rows = db.select().from(personas).all();
    const keys = rows.map((p) => `${p.packVersion}:${p.seed}:${p.drawIndex}`);
    expect(new Set(keys).size).toBeLessThan(keys.length);

    // Les personas de la première étude sont intactes (aucune réécriture)
    const after = new Map(rows.map((p) => [p.id, p]));
    for (const p of before) expect(after.get(p.id)).toEqual(p);

    // L'index n'est plus unique, mais existe toujours pour les recherches par (pack, graine, rang)
    const idx = sqlite.prepare("select name, \"unique\" as u from pragma_index_list('personas')").all() as Array<{ name: string; u: number }>;
    expect(idx.find((i) => i.name === "personas_draw_uq")).toBeUndefined();
    expect(idx.find((i) => i.name === "personas_draw_idx")?.u).toBe(0);
    sqlite.close();
  });
});
