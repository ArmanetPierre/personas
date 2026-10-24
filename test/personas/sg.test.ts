import { describe, expect, it } from "vitest";
import type { Persona } from "../../src/db/schema";
import { resolveModules, socleCatalog } from "../../src/modules/registry";
import { describeForPrompt, formatPersona } from "../../src/personas/describe";
import { recomputeEconomics } from "../../src/personas/economics";
import { buildNarrativePrompt, checkNarrative, narrativeSystemFor } from "../../src/personas/narrate";
import { loadPack } from "../../src/personas/pack";
import { drawPersona, drawPersonas } from "../../src/personas/sampler";
import { computeMargins } from "../../src/personas/validate";
import { eligibilityVars, prepareTarget, drawTarget } from "../../src/population/target";
import { compileEligibility } from "../../src/population/eligibility";
import { segmentLabel } from "../../src/studies/segments";

const sg = loadPack("sg");
const asPersona = (p: ReturnType<typeof drawPersona>, narrative: string | null = null) =>
  ({ ...p, narrative, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" }) as Persona;

describe("socle Singapour : contrat de pack pays", () => {
  it("manifeste : générateur sg, anglais, SGD, flux par module", () => {
    expect(sg.kind).toBe("sg");
    expect(sg.manifest).toMatchObject({ country: "SG", version: "sg-2026.1", generator: "sg", locale: "en", currency: "SGD", rngStreams: "module" });
    expect(sg.socle).toBe("sg");
  });

  it("tirage déterministe, ids stables, montants en SGD", () => {
    const a = drawPersona(sg, 42, 7);
    const b = drawPersona(sg, 42, 7);
    expect(a).toEqual(b);
    expect(a.id).toBe("sg-2026.1-s42-0008");
    expect(a.country).toBe("SG");
    expect(drawPersona(sg, 43, 7)).not.toEqual(a);
  });

  it("marges conformes aux tables (2 000 personas virtuelles)", () => {
    const rows = drawPersonas(sg, 42, 2000).map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null }));
    const reports = computeMargins(sg, rows);
    const failed = reports.filter((r) => !r.pass).map((r) => r.key);
    expect(failed).toEqual([]);
    expect(reports.map((r) => r.key)).toEqual(expect.arrayContaining(["age_sex", "residency", "ethnicity", "dwelling", "activity", "living_standard"]));
  });

  it("corrélations attendues : dortoirs et Work Permit, condos et EP, CPF des seuls résidents", () => {
    const ps = drawPersonas(sg, 1, 6000);
    const x = (p: (typeof ps)[number]) => p.extra as Record<string, unknown>;
    const dorm = ps.filter((p) => x(p).dwelling === "dormitory");
    expect(dorm.length).toBeGreaterThan(300);
    expect(dorm.filter((p) => x(p).residency === "wp").length / dorm.length).toBeGreaterThan(0.85);
    expect(dorm.every((p) => x(p).tenure === "free" && p.householdType === "other")).toBe(true);
    const mdw = ps.filter((p) => x(p).residency === "mdw");
    expect(mdw.every((p) => p.sex === "F" && x(p).liveIn === true && p.age >= 20)).toBe(true);
    const ep = ps.filter((p) => x(p).residency === "ep");
    expect(ep.filter((p) => x(p).dwelling === "condo").length / ep.length).toBeGreaterThan(0.45);
    expect(ep.every((p) => (x(p).grossIncomeEur as number) >= 5600)).toBe(true);
    // CPF : citoyens et PR en emploi seulement ; les étrangers n'en paient pas
    expect(ps.filter((p) => !["citizen", "pr"].includes(x(p).residency as string)).every((p) => x(p).cpfEmployeeEur === 0)).toBe(true);
    const cit = ps.filter((p) => x(p).residency === "citizen" && p.activityStatus === "employed" && (x(p).grossIncomeEur as number) > 1000 && p.age <= 55);
    expect(cit.every((p) => Math.abs((x(p).cpfEmployeeEur as number) - 0.2 * Math.min(8000, x(p).grossIncomeEur as number)) <= 1)).toBe(true);
    // Service national : jeunes hommes citoyens ou PR uniquement
    const nsf = ps.filter((p) => x(p).nationalService);
    expect(nsf.length).toBeGreaterThan(10);
    expect(nsf.every((p) => p.sex === "M" && p.age <= 22 && ["citizen", "pr"].includes(x(p).residency as string))).toBe(true);
    // Malais : très majoritairement musulmans
    const malay = ps.filter((p) => x(p).ethnicity === "malay" && ["citizen", "pr"].includes(x(p).residency as string));
    expect(malay.filter((p) => x(p).religion === "islam").length / malay.length).toBeGreaterThan(0.95);
  });

  it("fiche en anglais, sans mot français, avec statut, logement et CPF", () => {
    const ps = drawPersonas(sg, 42, 40).map((p) => asPersona(p));
    for (const p of ps) {
      const card = describeForPrompt(sg, p);
      expect(card).toMatch(/^Name: .+; (woman|man); \d+ years old/);
      expect(card).toContain("Residency: ");
      expect(card).toContain("Lives in: ");
      expect(card).not.toMatch(/\b(ans|Prénom|Foyer|Revenu|locataire|propriétaire|€)\b/);
      expect(formatPersona(sg, p)).toContain(p.id);
    }
    expect(ps.some((p) => describeForPrompt(sg, p).includes("after CPF contribution"))).toBe(true);
  });

  it("variables du socle pour les modules et le filtre d'éligibilité", () => {
    const p = drawPersona(sg, 42, 3);
    const v = eligibilityVars(p);
    for (const k of ["residency_status", "ethnicity", "religion", "dwelling", "planning_area", "home_language", "education", "resident"]) expect(k in v).toBe(true);
    expect(v.planning_area).toBe(p.townSize);
    const cat = socleCatalog("sg");
    expect(cat.vars.profile).toContain("dwelling");
    expect(cat.codes.residency_status).toContain("mdw");
    expect(cat.vars.profile).toContain("nationality");
    expect(cat.codes.nationality).toContain("western");
    expect(socleCatalog("fr-enfants").vars.profile).not.toContain("dwelling");
    // filtre sur les variables propres au socle
    const t = prepareTarget({ socle: "sg", eligibility: "age >= 30 and age <= 45 and dwelling in [condo, landed] and residency_status != mdw" });
    const d = drawTarget(t, 30, 9);
    expect(d.personas).toHaveLength(30);
    expect(d.rate).toBeGreaterThan(0.03);
    expect(d.rate).toBeLessThan(0.3);
    expect(d.personas.every((x) => ["condo", "landed"].includes((x.extra as unknown as { dwelling: string }).dwelling))).toBe(true);
    expect(() => compileEligibility("pcs == 3", new Set(["age"]))).toThrow();
    expect(() => prepareTarget({ socle: "sg", eligibility: "town_size == uu_paris and tenure == owner" })).not.toThrow();
  });

  it("libellés de segments en anglais", () => {
    const p = asPersona(drawPersona(sg, 42, 0));
    expect(segmentLabel(sg, "sex", "F", p)).toBe("Women");
    expect(segmentLabel(sg, "region", "ER", p)).toBe("East Region");
    expect(segmentLabel(sg, "townSize", "tampines", p)).toBe("Tampines");
    expect(segmentLabel(sg, "pcs", "2", p)).toBe("Professional");
    expect(segmentLabel(sg, "livingStandard", "Q1", p)).toMatch(/^Q1 \(< S\$/);
  });

  it("recalcul budgétaire sans changement : valeurs du tirage retrouvées", () => {
    for (const p of drawPersonas(sg, 5, 300)) {
      const q = recomputeEconomics(sg, p, { income: null, subscriptions: [], modules: [] });
      expect(Math.abs(q.monthlyDiscretionaryBudgetEur - p.monthlyDiscretionaryBudgetEur)).toBeLessThanOrEqual(1);
      expect(Math.abs((q.householdIncomeEur ?? 0) - (p.householdIncomeEur ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs(q.priceSensitivity - p.priceSensitivity)).toBeLessThanOrEqual(0.011);
    }
    const p = drawPersonas(sg, 5, 50).find((x) => x.monthlyDiscretionaryBudgetEur > 300)!;
    const q = recomputeEconomics(sg, p, { income: null, subscriptions: [{ name: "Tool", category: "pro", monthlyEur: 100 }], modules: ["m@1"] });
    expect(q.monthlyDiscretionaryBudgetEur).toBeLessThan(p.monthlyDiscretionaryBudgetEur);
  });

  it("un module français est refusé sur le socle Singapour", () => {
    expect(() => resolveModules(["numerique"], "sg")).toThrow(/non compatible/);
  });
});

describe("récits en anglais (socle en locale en)", () => {
  const ps = drawPersonas(sg, 42, 10).map((p) => asPersona(p));

  it("consigne et prompt en anglais, mêmes garde-fous que la version française", async () => {
    const system = narrativeSystemFor(sg);
    expect(system).toContain("living in Singapore");
    expect(system).toContain("FACTS drawn from official statistics");
    expect(system).toContain("AT MOST ONE figure");
    expect(system).toContain("No stereotypes tied to ethnicity");
    const prompt = buildNarrativePrompt(sg, ps);
    expect(prompt).toContain("Write a narrative for each of the 10 people below.");
    expect(prompt).not.toContain("Écris");
    await expect(`${system}\n\n=====\n\n${prompt}`).toMatchFileSnapshot("__snapshots__/sg-narrative-prompt.txt");
  });

  it("contrôle : nom et âge en tête, montants, publicité", () => {
    const p = ps[0]!;
    const words = " She walks to the market every morning and keeps a small notebook of what she spends, comparing prices before any purchase.".repeat(5);
    expect(checkNarrative(sg, p, `${p.firstName}, ${p.age}, lives quietly.${words}`)).toEqual([]);
    expect(checkNarrative(sg, p, `${p.firstName}, ${p.age + 3}, lives quietly.${words}`).join()).toMatch(/contradictory age/);
    expect(checkNarrative(sg, p, `Someone, ${p.age}, lives quietly.${words}`).join()).toMatch(/must start with the name/);
    expect(checkNarrative(sg, p, `${p.firstName}, ${p.age}, pays S$1,200 rent and S$80 for her phone.${words}`).join()).toMatch(/2 amounts/);
    const calm = { ...p, skepticism: 0.2 };
    expect(checkNarrative(sg, calm, `${p.firstName}, ${p.age}, hates the ads on her phone.${words}`).join()).toMatch(/advertising/);
  });
});
