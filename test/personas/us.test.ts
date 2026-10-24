import { describe, expect, it } from "vitest";
import type { Persona } from "../../src/db/schema";
import { resolveModules, socleCatalog } from "../../src/modules/registry";
import { describeForPrompt, formatPersona } from "../../src/personas/describe";
import { recomputeEconomics } from "../../src/personas/economics";
import { buildNarrativePrompt, checkNarrative, narrativeSystemFor } from "../../src/personas/narrate";
import { loadPack } from "../../src/personas/pack";
import type { UsPack } from "../../src/personas/countries/us/pack";
import { usIncomeTax } from "../../src/personas/countries/us/sampler";
import { drawPersona, drawPersonas } from "../../src/personas/sampler";
import { computeMargins } from "../../src/personas/validate";
import { eligibilityVars, prepareTarget, drawTarget, resolveSoclePack } from "../../src/population/target";
import { segmentLabel } from "../../src/studies/segments";
import { audienceOf } from "../../src/studies/locale";

const us = loadPack("us") as UsPack;
const asPersona = (p: ReturnType<typeof drawPersona>, narrative: string | null = null) =>
  ({ ...p, narrative, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" }) as Persona;
const x = (p: { extra: unknown }) => p.extra as Record<string, unknown>;

describe("socle États-Unis : contrat de pack pays", () => {
  it("manifeste : générateur us, anglais, USD, flux par module ; socle courant us", () => {
    expect(us.kind).toBe("us");
    expect(us.manifest).toMatchObject({ country: "US", version: "us-2026.1", generator: "us", locale: "en", currency: "USD", rngStreams: "module", ageMin: 18, ageMax: 79 });
    expect(us.socle).toBe("us");
    expect(resolveSoclePack("us").manifest.version).toBe("us-2026.1");
    expect(audienceOf(us)).toEqual({ locale: "en", country: "US", countryName: "the United States", currency: "USD" });
  });

  it("tirage déterministe, ids stables", () => {
    const a = drawPersona(us, 42, 7);
    expect(drawPersona(us, 42, 7)).toEqual(a);
    expect(a.id).toBe("us-2026.1-s42-0008");
    expect(a.country).toBe("US");
    expect(drawPersona(us, 43, 7)).not.toEqual(a);
    expect(a.firstName).toMatch(/^\S+ \S/);
  });

  for (const n of [1000, 2000]) {
    it(`marges conformes aux tables (${n} personas virtuelles)`, () => {
      const rows = drawPersonas(us, 42, n).map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null }));
      const reports = computeMargins(us, rows);
      expect(reports.filter((r) => !r.pass).map((r) => r.key)).toEqual([]);
      expect(reports.map((r) => r.key)).toEqual(expect.arrayContaining(["age_sex", "region", "race", "nativity", "education", "activity", "health_19-34", "health_35-64", "living_standard"]));
    });
  }

  it("corrélations attendues : revenu ↔ diplôme ↔ profession, propriété ↔ âge, Medicare à 65 ans, Medicaid des bas revenus", () => {
    const ps = drawPersonas(us, 1, 8000);
    const med = (a: number[]) => [...a].sort((u, v) => u - v)[Math.floor(a.length / 2)]!;
    const ftGross = (pred: (p: (typeof ps)[number]) => boolean) => med(ps.filter((p) => p.activityStatus === "employed" && !x(p).partTime && pred(p)).map((p) => x(p).grossIncomeEur as number));
    // Diplôme : les diplômés du supérieur gagnent nettement plus que les non-diplômés et occupent plus de postes qualifiés
    expect(ftGross((p) => x(p).education === "graduate")).toBeGreaterThan(1.8 * ftGross((p) => x(p).education === "below_hs"));
    const emp = ps.filter((p) => p.activityStatus === "employed");
    const share = (sub: typeof ps, pred: (p: (typeof ps)[number]) => boolean) => sub.filter(pred).length / sub.length;
    const prof = (p: (typeof ps)[number]) => ["management", "business_finance", "computer_engineering_science", "education_legal_community_arts", "healthcare_practitioners"].includes(p.pcs ?? "");
    expect(share(emp.filter((p) => x(p).education === "bachelor" || x(p).education === "graduate"), prof)).toBeGreaterThan(0.6);
    expect(share(emp.filter((p) => x(p).education === "below_hs" || x(p).education === "high_school"), prof)).toBeLessThan(0.25);
    expect(ftGross((p) => p.pcs === "management")).toBeGreaterThan(1.7 * ftGross((p) => p.pcs === "service"));
    // Propriétaires plus âgés
    const ownHome = ps.filter((p) => p.householdType !== "with_parents");
    const owner = (p: (typeof ps)[number]) => ["owner", "owner_mortgage"].includes(x(p).tenure as string);
    expect(share(ownHome.filter((p) => p.age >= 60), owner)).toBeGreaterThan(share(ownHome.filter((p) => p.age < 35), owner) + 0.25);
    // Les propriétaires âgés ont plus souvent fini de rembourser
    const owners = ps.filter(owner);
    expect(share(owners.filter((p) => p.age >= 70), (p) => x(p).tenure === "owner")).toBeGreaterThan(share(owners.filter((p) => p.age < 40), (p) => x(p).tenure === "owner") + 0.3);
    // Assurance santé : Medicare à 65 ans, employeur pour les salariés à temps plein, Medicaid des bas revenus
    expect(ps.filter((p) => p.age >= 65).every((p) => x(p).healthInsurance === "medicare")).toBe(true);
    expect(share(emp.filter((p) => !x(p).partTime && x(p).classOfWorker !== "self_employed" && p.age < 65), (p) => x(p).healthInsurance === "employer")).toBeGreaterThan(0.7);
    const poor = ps.filter((p) => p.age < 65 && (x(p).livingStandardEur as number) < 1000);
    expect(share(poor, (p) => x(p).healthInsurance === "medicaid")).toBeGreaterThan(3 * share(ps.filter((p) => p.age < 65 && (x(p).livingStandardEur as number) > 5000), (p) => x(p).healthInsurance === "medicaid"));
    // Origine : langue et nativité cohérentes
    const hisp = ps.filter((p) => x(p).race === "hispanic");
    expect(share(hisp, (p) => x(p).homeLanguage === "spanish")).toBeGreaterThan(0.6);
    expect(share(hisp.filter((p) => x(p).nativity !== "us_born"), (p) => x(p).homeLanguage === "spanish")).toBeGreaterThan(0.85);
    expect(share(ps.filter((p) => x(p).race === "asian"), (p) => x(p).nativity !== "us_born")).toBeGreaterThan(0.6);
    // Géographie : plus d'Hispanic en Californie et au Texas qu'en Ohio ; États sans impôt sur le revenu
    const st = (c: string) => ps.filter((p) => p.townSize === c);
    expect(share([...st("CA"), ...st("TX")], (p) => x(p).race === "hispanic")).toBeGreaterThan(share(st("OH"), (p) => x(p).race === "hispanic") + 0.2);
    expect(us.stateOf("TX")!.stateTaxRate).toBe(0);
    // Prêts étudiants : plus fréquents chez les diplômés et les jeunes
    expect(share(ps.filter((p) => p.age < 35 && x(p).education === "bachelor"), (p) => x(p).studentLoan === true)).toBeGreaterThan(share(ps.filter((p) => p.age >= 60), (p) => x(p).studentLoan === true) + 0.2);
  });

  it("impôt fédéral 2026 : barème, déduction standard, CTC et EITC", () => {
    const single = { filing: "single" as const, taxable: 60000, earned: 60000, kidsUnder17: 0, kids: 0, seniors: 0, youngestAdultAge: 40, oldestAdultAge: 40 };
    // 60 000 − 16 100 = 43 900 imposables : 1 240 + 12 % de 31 500 = 5 020
    expect(Math.round(usIncomeTax(us, single, 0).federal)).toBe(5020);
    expect(Math.round(usIncomeTax(us, single, 0.05).state)).toBe(2195);
    const family = { ...single, filing: "joint" as const, taxable: 30000, earned: 30000, kidsUnder17: 2, kids: 2, youngestAdultAge: 30 };
    const r = usIncomeTax(us, family, 0);
    expect(r.federal).toBe(0);
    expect(r.eitc).toBeGreaterThan(6000);
    expect(r.actc).toBeGreaterThan(3000);
  });

  it("fiche en anglais, sans mot français, avec origine, assurance santé, montants en $", () => {
    const ps = drawPersonas(us, 42, 60).map((p) => asPersona(p));
    for (const p of ps) {
      const card = describeForPrompt(us, p);
      expect(card).toMatch(/^Name: .+; (woman|man); \d+ years old/);
      expect(card).toContain("Background: ");
      expect(card).toContain("Health coverage: ");
      expect(card).not.toMatch(/\b(ans|Prénom|Foyer|Revenu|locataire|propriétaire|€|S\$)\b/);
      expect(formatPersona(us, p)).toContain(p.id);
    }
    expect(ps.some((p) => describeForPrompt(us, p).includes("after Social Security and Medicare payroll taxes"))).toBe(true);
  });

  it("variables du socle pour les modules et le filtre d'éligibilité", () => {
    const p = drawPersona(us, 42, 3);
    const v = eligibilityVars(p);
    for (const k of ["state", "division", "urbanicity", "race_ethnicity", "nativity", "home_language", "education", "dwelling", "class_of_worker", "health_insurance", "has_student_loan", "vehicles", "married"]) expect(k in v).toBe(true);
    expect(v.state).toBe(p.townSize);
    const cat = socleCatalog("us");
    expect(cat.vars.profile).toContain("health_insurance");
    expect(cat.codes.race_ethnicity).toEqual(["white", "black", "hispanic", "asian", "other"]);
    expect(cat.codes.state).toContain("DC");
    expect(socleCatalog("fr-enfants").vars.profile).not.toContain("race_ethnicity");
    const t = prepareTarget({ socle: "us", eligibility: "age >= 25 and age <= 44 and education in [bachelor, graduate] and has_internet == true" });
    const d = drawTarget(t, 30, 9);
    expect(d.personas).toHaveLength(30);
    expect(d.rate).toBeGreaterThan(0.05);
    expect(d.rate).toBeLessThan(0.3);
    expect(() => prepareTarget({ socle: "us", eligibility: "residency_status == ep" })).toThrow();
  });

  it("libellés de segments en anglais", () => {
    const p = asPersona(drawPersona(us, 42, 0));
    expect(segmentLabel(us, "sex", "F", p)).toBe("Women");
    expect(segmentLabel(us, "region", "MW", p)).toBe("Midwest");
    expect(segmentLabel(us, "townSize", "CA", p)).toBe("California");
    expect(segmentLabel(us, "pcs", "management", p)).toBe("Manager");
    expect(segmentLabel(us, "livingStandard", "Q1", p)).toMatch(/^Q1 \(< \$/);
  });

  it("recalcul budgétaire sans changement : valeurs du tirage retrouvées ; un revenu plus haut relève le budget", () => {
    for (const p of drawPersonas(us, 5, 300)) {
      const q = recomputeEconomics(us, p, { income: null, subscriptions: [], modules: [] });
      expect(Math.abs(q.monthlyDiscretionaryBudgetEur - p.monthlyDiscretionaryBudgetEur)).toBeLessThanOrEqual(1);
      expect(Math.abs((q.householdIncomeEur ?? 0) - (p.householdIncomeEur ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs(q.priceSensitivity - p.priceSensitivity)).toBeLessThanOrEqual(0.011);
    }
    const p = drawPersonas(us, 5, 80).find((y) => y.monthlyDiscretionaryBudgetEur > 300 && y.activityStatus === "employed")!;
    const less = recomputeEconomics(us, p, { income: null, subscriptions: [{ name: "Tool", category: "pro", monthlyEur: 100 }], modules: ["m@1"] });
    expect(less.monthlyDiscretionaryBudgetEur).toBeLessThan(p.monthlyDiscretionaryBudgetEur);
    const more = recomputeEconomics(us, p, { income: p.monthlyIncomeEur + 1000, subscriptions: [], modules: ["m@1"] });
    expect(more.monthlyDiscretionaryBudgetEur).toBeGreaterThan(p.monthlyDiscretionaryBudgetEur);
    expect((x(more).grossIncomeEur as number) - (x(p).grossIncomeEur as number)).toBeGreaterThan(1000);
  });

  it("un module français ou singapourien est refusé sur le socle États-Unis", () => {
    expect(() => resolveModules(["numerique"], "us")).toThrow(/non compatible/);
  });

  it("noms : prénom de la génération et nom cohérent avec l'origine", () => {
    const ps = drawPersonas(us, 3, 3000);
    const hisp = ps.filter((p) => x(p).race === "hispanic");
    const hispSurnames = new Set(us.surnames.data.groups.hispanic!.map(([n]) => n));
    expect(hisp.every((p) => hispSurnames.has(p.firstName!.split(" ").slice(1).join(" ")))).toBe(true);
    const old = ps.filter((p) => p.age >= 70 && p.sex === "F" && x(p).race === "white").map((p) => p.firstName!.split(" ")[0]);
    const young = ps.filter((p) => p.age <= 25 && p.sex === "F" && x(p).race === "white").map((p) => p.firstName!.split(" ")[0]);
    expect(old.some((n) => ["Linda", "Mary", "Patricia", "Barbara", "Susan", "Carol", "Nancy", "Sharon", "Karen", "Deborah"].includes(n!))).toBe(true);
    expect(young.some((n) => ["Linda", "Barbara", "Carol", "Sharon"].includes(n!))).toBe(false);
  });
});

describe("récits en anglais (socle États-Unis)", () => {
  const ps = drawPersonas(us, 42, 10).map((p) => asPersona(p));

  it("consigne et prompt en anglais, garde-fous du socle commun, consigne propre aux États-Unis", () => {
    const system = narrativeSystemFor(us);
    expect(system).toContain("living in the United States");
    expect(system).toContain("FACTS drawn from official statistics");
    expect(system).toContain("AT MOST ONE figure");
    expect(system).toContain("No stereotypes tied to race, ethnicity, origin");
    expect(system).not.toMatch(/Singlish|hawker|work pass/);
    const prompt = buildNarrativePrompt(us, ps);
    expect(prompt).toContain("Write a narrative for each of the 10 people below.");
    expect(prompt).not.toContain("Écris");
  });

  it("contrôle : nom et âge en tête, montants", () => {
    const p = ps[0]!;
    const words = " She walks to the store every morning and keeps a small notebook of what she spends, comparing prices before any purchase.".repeat(5);
    expect(checkNarrative(us, p, `${p.firstName}, ${p.age}, lives quietly.${words}`)).toEqual([]);
    expect(checkNarrative(us, p, `${p.firstName}, ${p.age}, pays $1,200 rent and $80 for her phone.${words}`).join()).toMatch(/2 amounts/);
  });
});
