import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import type { BackendRequest } from "../../src/engine/types";
import { Engine } from "../../src/engine/engine";
import { checkModule, type LoadedModule } from "../../src/modules/registry";
import { compareSummaries } from "../../src/studies/compare";
import { createProject, getProject, priceTiersFor, projectFileSchema, readProjectFile } from "../../src/studies/project";
import { buildRoleSystemPrompt, buildSystemPrompt, QUESTION_KEY, roleAnswerSchema, studyTiers } from "../../src/studies/protocols/concept-price";
import { LEGACY_PROTOCOL } from "../../src/studies/protocols/protocol";
import { roleProject, rolePrompt } from "../../src/studies/role-view";
import { childBlock, childProfiles, pickChild, prepareChild, projectRoles, rolesSchema } from "../../src/studies/roles";
import { runStudy, type ConceptPricePayload } from "../../src/studies/run";
import { findStudy, personasByIds, studyResponses } from "../../src/studies/store";
import { createStudy, rolePopulations } from "../../src/studies/study";
import { formatSummary, summarize } from "../../src/studies/summary";
import { z } from "zod";
import { answer, fakeBackend, pack } from "./fixtures";
import { projectFrom } from "./project-helpers";

const V2_PROMPTS = JSON.parse(readFileSync("test/studies/__fixtures__/v2-system-prompts.json", "utf8")) as Record<string, string>;
const SNAP = "__fixtures__/roles";

const fromFile = (path: string) => {
  const p = projectFrom(path);
  const f = readProjectFile(path);
  return { ...p, extra: { ...(p.extra as object), ...(f.roles && { roles: f.roles }) } } as typeof p;
};

describe("schéma des rôles", () => {
  it("un projet sans rôles est inchangé (prompts v2 identiques, aucun champ ajouté)", () => {
    for (const [file, prompt] of Object.entries(V2_PROMPTS)) {
      const p = projectFrom(file);
      expect(projectRoles(p)).toEqual([]);
      expect(buildSystemPrompt(p, priceTiersFor(p))).toBe(prompt);
    }
    const f = readProjectFile("examples/meal-planner.json");
    expect(f.roles).toBeUndefined();
  });

  it("lit les exemples multi-rôles", () => {
    expect(readProjectFile("examples/team-schedule.yaml").roles!.map((r) => [r.id, r.perspective, r.dependsOn?.role])).toEqual([
      ["manager", "payer", "member"],
      ["member", "user", undefined],
    ]);
    expect(readProjectFile("examples/kids-reading-no-module.yaml").roles!.map((r) => r.perspective)).toEqual(["payer_for_child", "both"]);
  });

  it("refuse les cas invalides", () => {
    const base = { id: "a", label: "A", perspective: "user", target: { socle: "fr" } };
    const bad = (roles: unknown) => rolesSchema.safeParse(roles).success;
    expect(bad([])).toBe(false);
    expect(bad([{ ...base, price: { amountEur: 5, period: "month" } }])).toBe(false); // un utilisateur ne paie pas
    expect(bad([{ ...base, sections: { pricing: true } }])).toBe(false);
    expect(bad([{ ...base, perspective: "payer_for_child" }])).toBe(false); // bloc child requis
    expect(bad([{ ...base, child: { ages: { min: 7, max: 12 } } }])).toBe(false); // child réservé au parent
    expect(bad([{ ...base, perspective: "payer_for_child", child: { ages: { min: 12, max: 7 } } }])).toBe(false);
    expect(bad([base, { ...base }])).toBe(false); // id en double
    expect(bad([{ ...base, perspective: "payer", dependsOn: { role: "zzz" } }])).toBe(false);
    expect(bad([{ ...base, dependsOn: { role: "a" } }])).toBe(false); // un utilisateur ne dépend pas
    expect(bad([{ ...base, unknownField: 1 }])).toBe(false);
    expect(bad([base])).toBe(true);
    // `roles` remplace target et control
    const file = { ...readProjectFile("examples/team-schedule-no-module.yaml"), target: { socle: "fr", modules: [], n: 10 } };
    expect(projectFileSchema.safeParse(file).success).toBe(false);
  });
});

describe("prompts par perspective (instantanés)", () => {
  const team = fromFile("examples/team-schedule-no-module.yaml");
  const kids = fromFile("examples/kids-reading-no-module.yaml");
  const promptOf = (p: typeof team, id: string) => {
    const roles = projectRoles(p);
    const role = roles.find((r) => r.id === id)!;
    const view = roleProject(p, role);
    return buildRoleSystemPrompt(view, studyTiers(view, "3"), "3", rolePrompt(role, roles));
  };

  it("membre de Créneau (user) : ni prix ni comportement payant, usage attendu", async () => {
    const s = promptOf(team, "member");
    await expect(s).toMatchFileSnapshot(`${SNAP}/team-member.txt`);
    expect(s).toContain("## Ton rôle\nTu travailles en horaires décalés");
    expect(s).toContain("Ce que ça te coûte : gratuit pour les membres");
    for (const x of ["Prix affiché", "vanWestendorp", "gaborGranger", "budgetFit", '"pay_subscription"', '"recommend"']) expect(s).not.toContain(x);
    expect(s).toContain('  "free_active" : tu remplis ton profil et tu reviens utiliser la version gratuite, sans payer.');
    expect(s).toContain("- expectedUsage : ");
  });

  it("responsable de Créneau (payer, dépend des membres) : prix et seuil d'adoption", async () => {
    const s = promptOf(team, "manager");
    await expect(s).toMatchFileSnapshot(`${SNAP}/team-manager.txt`);
    expect(s).toContain("C'est toi qui déciderais et qui paierais");
    expect(s).toContain("Prix affiché : 9,99 $/mois ou 99 $/an");
    expect(s).toContain("- adoptionThreshold : quelle part de tes membres");
    expect(s).not.toContain("expectedUsage");
  });

  it("parent de Petit Lecteur (payer_for_child) : pertinence et comportements rapportés à l'enfant", async () => {
    const s = promptOf(kids, "parent");
    await expect(s).toMatchFileSnapshot(`${SNAP}/kids-reading-parent.txt`);
    expect(s).toContain("Tu réponds en parent.");
    expect(s).toContain('"concerned" si ton enfant a aujourd\'hui le besoin');
    expect(s).toContain('  "free_signup" : tu l\'installes ou l\'inscris gratuitement pour ton enfant');
    expect(s).toContain("Prix affiché : Premium : 2,99 €/mois");
  });

  it("perspective both sans texte propre : prompt v3 standard de la vue du rôle", () => {
    const roles = projectRoles(kids);
    const role = roles.find((r) => r.id === "adult-reader")!;
    const view = roleProject(kids, role);
    expect(buildRoleSystemPrompt(view, studyTiers(view, "3"), "3", rolePrompt(role, roles))).toBe(buildSystemPrompt(view, studyTiers(view, "3"), "3"));
  });

  it("schéma du membre sans champs de prix ; schéma du responsable avec seuil d'adoption", () => {
    const roles = projectRoles(team);
    const js = (id: string) => z.toJSONSchema(roleAnswerSchema([5, 10, 15], LEGACY_PROTOCOL, "3", rolePrompt(roles.find((r) => r.id === id)!, roles))) as { properties: Record<string, { enum?: string[] }> };
    const m = js("member");
    expect(Object.keys(m.properties)).not.toContain("vanWestendorp");
    expect(Object.keys(m.properties)).not.toContain("gaborGranger");
    expect(m.properties.behavior!.enum).toEqual(["ignore", "save_for_later", "visit_page", "free_signup", "free_active"]);
    expect(Object.keys(m.properties)[Object.keys(m.properties).indexOf("behaviorReason") + 1]).toBe("expectedUsage");
    expect(Object.keys(js("manager").properties)).toContain("adoptionThreshold");
  });
});

/** Réponses simulées selon le rôle (lu dans le prompt système). */
function roleReply(req: BackendRequest, call: number): string {
  const a = answer();
  if (req.system.includes("- expectedUsage : ")) {
    const { vanWestendorp: _v, gaborGranger: _g, budgetFit: _b, ...rest } = a;
    const engaged = call % 3 === 0;
    return JSON.stringify({ ...rest, ...(engaged && { relevance: "concerned", behavior: "free_active" }), expectedUsage: engaged ? "weekly" : "never" });
  }
  // Paliers lus dans le schéma imposé (clés at_<prix>_eur)
  const props = (req.jsonSchema as { properties: { gaborGranger: { properties: Record<string, unknown> } } }).properties;
  const gg = Object.fromEntries(Object.keys(props.gaborGranger.properties).map((k, i) => [k, i === 0 && call % 2 === 0]));
  const base = { ...a, gaborGranger: gg };
  const yes = call % 2 === 0;
  return JSON.stringify({
    ...base,
    ...(yes && { relevance: "marginal", vanWestendorp: { wouldNeverPay: false, tooCheapEur: 1, cheapEur: 3, expensiveEur: 8, tooExpensiveEur: 15 }, budgetFit: "Je le prends sur mon budget de loisirs du mois." }),
    ...(req.system.includes("- adoptionThreshold : ") && { adoptionThreshold: yes ? 20 : null }),
  });
}

describe("étude multi-rôles (backend simulé)", () => {
  it("crée un groupe par rôle, chacun avec sa cible, et exécute chaque rôle avec son prompt", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const project = createProject(db, readProjectFile("examples/team-schedule-no-module.yaml"));
    const { study } = createStudy(db, pack, { projectId: project.id, populations: rolePopulations(project, { manager: 6, member: 9 }), seed: 3, backend: "ollama", model: "fake" });
    expect(study.protocolVersion).toBe("4");
    expect(study.populations.map((p) => [p.group, p.n])).toEqual([["manager", 6], ["member", 9]]);
    const groups = Object.values(study.personaGroups);
    expect(groups.filter((g) => g === "manager")).toHaveLength(6);
    const coaches = personasByIds(db, study.personaIds.filter((id) => study.personaGroups[id] === "manager"));
    expect(coaches.every((p) => p.age >= 20 && p.age <= 45 && p.activityStatus === "employed")).toBe(true);
    const members = personasByIds(db, study.personaIds.filter((id) => study.personaGroups[id] === "member"));
    expect(members.every((p) => p.age <= 35)).toBe(true);

    const fb = fakeBackend(roleReply);
    const r = await runStudy(db, new Engine(fb.backend), pack, findStudy(db, study.id));
    expect(r.written).toBe(15);
    const systems = new Set(fb.requests.map((q) => q.system));
    expect(systems.size).toBe(2); // un prompt système par rôle (cache)
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    const member = rows.find((x) => study.personaGroups[x.personaId] === "member")!.payload as ConceptPricePayload;
    expect(member.role).toMatchObject({ id: "member", perspective: "user", pricing: false, usage: true });
    expect(member.tiers).toEqual([]);
    expect(member.answer.vanWestendorp).toBeUndefined();
    expect(member.answer.expectedUsage).toBeDefined();
    const coach = rows.find((x) => study.personaGroups[x.personaId] === "manager")!.payload as ConceptPricePayload;
    expect(coach.role).toMatchObject({ id: "manager", perspective: "payer", pricing: true, dependsOn: "member" });
    expect(coach.tiers).toEqual([4.99, 9.99, 14.99]);
    // Aucun contrôle de prix pour le membre
    expect(rows.filter((x) => study.personaGroups[x.personaId] === "member").flatMap((x) => x.anomalies)).not.toContain("vw_incomplete");

    // Résumé par rôle et croisement
    const personas = new Map(personasByIds(db, rows.map((x) => x.personaId)).map((p) => [p.id, p]));
    const s = summarize(pack, findStudy(db, study.id), getProject(db, project.id)!, rows, personas);
    expect(s.groups.map((g) => [g.group, g.label])).toEqual([["manager", "Responsables"], ["member", "Membres"]]);
    const [gc, gm] = s.groups.map((g) => g.analysis);
    expect(gm!.payment).toBeUndefined();
    expect(gm!.expectedUsage!.regularShare).toBeCloseTo(3 / 9, 5);
    expect(gc!.payment).toBeDefined();
    expect(gc!.adoptionThreshold).toMatchObject({ n: 6 });
    expect(s.payment!.group).toBe("manager");
    expect(s.roles!.map((x) => x.id)).toEqual(["manager", "member"]);
    const dep = s.crossRoles!.dependencies[0]!;
    expect(dep).toMatchObject({ payer: "manager", user: "member", payerRespondents: 6 });
    expect(dep.thresholdMet + dep.payerNever).toBeLessThanOrEqual(6);
    expect(dep.sentence).toMatch(/Membres : 33 % utiliseraient le service au moins chaque semaine/);
    const text = formatSummary(s);
    expect(text).toContain("Croisement des rôles");
    expect(text).toContain("Prix : sans objet pour ce rôle (Membres ne paie pas).");
    expect(text).toContain("Usage attendu (si la persona s'y mettait)");
    // Comparaison par rôle, sans casser
    expect(compareSummaries([s, s], "member").entries[0]!.payment).toBeUndefined();
    expect(compareSummaries([s, s], "manager").entries[0]!.payment).toBeDefined();
    sqlite.close();
  });
});

describe("payer_for_child (Petit Lecteur)", () => {
  /** Module enfant de test (en mémoire) : la collection dépend de l'âge de l'enfant. */
  const childModule: LoadedModule = checkModule({
    id: "collection-test",
    version: "1",
    label: "Collection (test)",
    applies_to: ["fr-enfants"],
    tables: { by_age: { bands: [{ from: 0, to: 9, value: 0.9 }, { from: 10, to: 17, value: 0.1 }], assumption: true, justification: "test" } },
    attributes: [{ key: "collects", label: "Collectionne", type: "boolean", rate: { lookup: "by_age", by: "socle.age" }, labels: { yes: "collectionne des cartes", no: "ne collectionne pas" }, assumption: true, justification: "test" }],
    card: ["Collection : {collects}"],
  });
  const lib = new Map([["collection-test", childModule]]);

  it("tire l'enfant à partir du ménage, de façon déterministe, avec le profil des modules enfant", () => {
    const parent = { id: "x", seed: 7, drawIndex: 12, narrative: null, region: "IDF", townSize: "paris", householdType: "couple_with_children", extra: { childrenAges: [4, 8, 13, 16] } };
    const prepared = prepareChild({ ages: { min: 7, max: 15 }, modules: ["collection-test"] }, "fr", lib);
    const kids = childProfiles(parent as never, prepared);
    expect(kids.map((k) => k.age)).toEqual([8, 13]);
    expect(kids[0]!.modules["collection-test"]).toHaveProperty("collects");
    expect(childProfiles(parent as never, prepared)).toEqual(kids);
    const filtered = prepareChild({ ages: { min: 7, max: 15 }, modules: ["collection-test"], eligibility: "collection-test.collects == true and child.age < 12" }, "fr", lib);
    expect(childProfiles(parent as never, filtered).every((k) => k.age < 12 && k.modules["collection-test"]!.collects === true)).toBe(true);
    expect(pickChild(parent as never, prepared, 1)).toEqual(pickChild(parent as never, prepared, 1));
    expect(childBlock(kids[0]!)).toMatch(/^## L'enfant pour qui tu décides\n(Ton fils|Ta fille) de 8 ans, qui vit avec toi\.\n- Collection : /);
    // Un module adulte ne s'applique pas à un enfant
    expect(() => prepareChild({ ages: { min: 7, max: 15 }, modules: ["numerique"] }, "fr")).toThrow(/non compatible avec le socle « fr-enfants »/);
  });

  it("sexe de l'enfant : celui du récit quand il est explicite", () => {
    const prepared = prepareChild({ ages: { min: 0, max: 17 }, modules: [] }, "fr", lib);
    const p = (narrative: string) => ({ id: "y", seed: 1, drawIndex: 1, narrative, region: "IDF", townSize: "paris", householdType: "single_parent", extra: { childrenAges: [10] } });
    expect(childProfiles(p("Elle élève seule sa fille de 10 ans.") as never, prepared)[0]!.sex).toBe("F");
    expect(childProfiles(p("Il élève seul son fils.") as never, prepared)[0]!.sex).toBe("M");
  });

  it("crée et exécute une étude parent : seuls les adultes avec un enfant de 7 à 15 ans, profil de l'enfant dans le prompt", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const project = createProject(db, readProjectFile("examples/kids-reading-no-module.yaml"));
    const { study } = createStudy(db, pack, { projectId: project.id, populations: rolePopulations(project, { parent: 5, "adult-reader": 3 }), seed: 4, backend: "ollama", model: "fake" });
    const parents = personasByIds(db, study.personaIds.filter((id) => study.personaGroups[id] === "parent"));
    expect(parents).toHaveLength(5);
    expect(parents.every((p) => ((p.extra as { childrenAges?: number[] }).childrenAges ?? []).some((a) => a >= 7 && a <= 15))).toBe(true);
    const fb = fakeBackend(roleReply);
    await runStudy(db, new Engine(fb.backend), pack, findStudy(db, study.id));
    const parentReq = fb.requests.find((q) => q.system.includes("Tu réponds en parent."))!;
    expect(parentReq.messages[0]!.content).toMatch(/## L'enfant pour qui tu décides\n(Ton fils|Ta fille) de \d+ ans, qui vit avec toi\./);
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    const pay = rows.filter((x) => study.personaGroups[x.personaId] === "parent").map((x) => x.payload as ConceptPricePayload);
    expect(pay.every((x) => x.child && x.child.age >= 7 && x.child.age <= 15 && x.role?.perspective === "payer_for_child")).toBe(true);
    // Le rôle « both » garde le prompt standard
    const adultReq = fb.requests.find((q) => !q.system.includes("## Ton rôle"))!;
    const view = roleProject(getProject(db, project.id)!, projectRoles(getProject(db, project.id)!)[1]!);
    expect(adultReq.system).toBe(buildSystemPrompt(view, studyTiers(view, "4"), "4"));
    const personas = new Map(personasByIds(db, rows.map((x) => x.personaId)).map((p) => [p.id, p]));
    const s = summarize(pack, findStudy(db, study.id), getProject(db, project.id)!, rows, personas);
    expect(s.groups.map((g) => g.analysis.payment !== undefined)).toEqual([true, true]);
    expect(s.crossRoles!.overview.map((o) => o.perspective)).toEqual(["payer_for_child", "both"]);
    sqlite.close();
  });
});
