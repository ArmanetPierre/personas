import { describe, expect, it } from "vitest";
import type { Persona, Study } from "../../src/db/schema";
import { resolveModules } from "../../src/modules/registry";
import { moduleLines } from "../../src/personas/describe";
import { loadPack } from "../../src/personas/pack";
import { drawPersona } from "../../src/personas/sampler";
import { buildUserPrompt, pickEncounter } from "../../src/studies/protocols/concept-price";
import { studyModulesFor } from "../../src/studies/run";
import { project } from "./fixtures";

const v2 = loadPack("fr-2026.2");
const modules = resolveModules(["numerique", "entrepreneuriat"], v2.socle);
// Persona du cache portant deux modules (appliqués par une étude précédente)
const p = { ...drawPersona(v2, 42, 0, { modules }), narrative: null, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" } as Persona;
const enc = pickEncounter(p, 7);

describe("fiche restreinte aux modules de l'étude", () => {
  const all = moduleLines(v2, p);
  const num = moduleLines(v2, p, ["numerique"]);
  const ent = moduleLines(v2, p, ["entrepreneuriat"]);

  it("affiche tous les modules sans liste (études v1, comportement inchangé)", () => {
    expect(all.length).toBeGreaterThan(num.length);
    const user = buildUserPrompt(v2, p, project, enc);
    for (const l of all) expect(user).toContain(l);
  });

  it("n'affiche que les modules de la population de la persona", () => {
    expect(num.length).toBeGreaterThan(0);
    const user = buildUserPrompt(v2, p, project, enc, { modules: ["numerique"] });
    for (const l of num) expect(user).toContain(l);
    for (const l of ent.filter((x) => !num.includes(x))) expect(user).not.toContain(l);
  });

  it("n'affiche aucune ligne de module pour un témoin sans module", () => {
    const user = buildUserPrompt(v2, p, project, enc, { modules: [] });
    for (const l of all) expect(user).not.toContain(l);
  });

  it("lit les modules de la population de chaque persona dans l'étude", () => {
    const study = {
      personaGroups: { a: "target", b: "control" },
      populations: [
        { group: "target", packVersion: "fr-2026.2", n: 1, eligibility: { modules: ["numerique@2026.2", "entrepreneuriat@2026.2"] } },
        { group: "control", packVersion: "fr-2026.2", n: 1, eligibility: { modules: [] } },
      ],
    } as unknown as Study;
    expect(studyModulesFor(study, "a")).toEqual(["numerique", "entrepreneuriat"]);
    expect(studyModulesFor(study, "b")).toEqual([]);
    const v1 = { personaGroups: { a: "target" }, populations: [{ group: "target", packVersion: "fr-tech-founders-2026.1", n: 1 }] } as unknown as Study;
    expect(studyModulesFor(v1, "a")).toBeUndefined();
    expect(studyModulesFor({ personaGroups: {}, populations: [] } as unknown as Study, "x")).toBeUndefined();
  });
});
