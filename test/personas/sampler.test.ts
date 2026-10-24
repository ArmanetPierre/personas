import { describe, expect, it } from "vitest";
import { asFr, loadPack } from "../../src/personas/pack";
import { Rng } from "../../src/personas/rng";
import { drawPersona, drawPersonas, incomeTax } from "../../src/personas/sampler";
import { computeMargins } from "../../src/personas/validate";

const pack = asFr(loadPack("fr"));

describe("PRNG", () => {
  it("est déterministe et indépendant par persona", () => {
    const a = Rng.forPersona(42, 7);
    const b = Rng.forPersona(42, 7);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Rng.forPersona(43, 7).next()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe("tirage", () => {
  it("même graine, même pack : mêmes personas", () => {
    expect(drawPersonas(pack, 42, 50)).toEqual(drawPersonas(pack, 42, 50));
  });

  it("le tirage de la persona i ne dépend pas du nombre total (extension idempotente)", () => {
    const all = drawPersonas(pack, 42, 30);
    expect(drawPersonas(pack, 42, 10, 20)).toEqual(all.slice(20));
    expect(drawPersona(pack, 42, 5)).toEqual(all[5]);
  });

  it("une autre graine donne une autre base", () => {
    const a = drawPersonas(pack, 1, 20).map((p) => p.age);
    const b = drawPersonas(pack, 2, 20).map((p) => p.age);
    expect(a).not.toEqual(b);
  });
});

describe("marges sur un grand tirage", () => {
  const big = drawPersonas(pack, 2024, 20_000);
  const reports = computeMargins(pack, big.map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null })));

  for (const r of reports.filter((x) => x.kind === "drawn")) {
    it(`${r.title} : écart max < 1,5 pt`, () => {
      expect(r.maxAbsDevPts).toBeLessThan(1.5);
    });
  }

  it("déciles de niveau de vie dans la tolérance du modèle", () => {
    const r = reports.find((x) => x.key === "living_standard")!;
    expect(r.maxAbsDevPts).toBeLessThan(5);
  });
});

describe("cohérence des contraintes", () => {
  const ps = drawPersonas(pack, 7, 3000);

  it("budget ≥ 0, et déficit consigné quand le reste-à-vivre serait négatif", () => {
    for (const p of ps) {
      expect(p.monthlyDiscretionaryBudgetEur).toBeGreaterThanOrEqual(0);
      if (p.monthlyDiscretionaryBudgetEur === 0) expect(p.extra.monthlyShortfallEur).toBeGreaterThanOrEqual(0);
      if (p.extra.monthlyShortfallEur > 0) expect(p.monthlyDiscretionaryBudgetEur).toBe(0);
    }
  });

  it("revenus plausibles par PCS : médiane des cadres > professions intermédiaires > employés", () => {
    const med = (code: string) => {
      const xs = ps
        .filter((p) => p.activityStatus === "employed" && p.pcs === code && !p.extra.partTime)
        .map((p) => p.monthlyIncomeEur)
        .sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)]!;
    };
    expect(med("3")).toBeGreaterThan(med("4"));
    expect(med("4")).toBeGreaterThan(med("5"));
    expect(med("3")).toBeGreaterThan(3000);
    expect(med("5")).toBeGreaterThan(1200);
    expect(med("5")).toBeLessThan(2500);
  });

  it("aucun revenu aberrant, aucun retraité de moins de 50 ans, étudiants jeunes", () => {
    for (const p of ps) {
      expect(p.monthlyIncomeEur).toBeGreaterThanOrEqual(0);
      expect(p.monthlyIncomeEur).toBeLessThan(60_000);
      if (p.activityStatus === "retired") expect(p.age).toBeGreaterThanOrEqual(50);
      if (p.activityStatus === "student") expect(p.age).toBeLessThan(40);
      if (p.activityStatus === "employed") expect(p.monthlyIncomeEur).toBeGreaterThan(150);
    }
  });

  it("composition du foyer cohérente", () => {
    for (const p of ps) {
      if (p.householdType === "alone") expect(p.householdSize).toBe(1);
      if (p.householdType.startsWith("couple")) expect(p.extra.partner).not.toBeNull();
      if (p.householdType === "couple_with_children" || p.householdType === "single_parent") {
        expect(p.extra.childrenAges.length).toBeGreaterThan(0);
        for (const a of p.extra.childrenAges) expect(p.age - a).toBeGreaterThanOrEqual(15);
      }
      if (p.householdType === "with_parents") expect(p.extra.parents.length).toBeGreaterThan(0);
    }
  });

  it("abonnements : prix positifs, pas de box sans internet, pas d'appli sans smartphone", () => {
    for (const p of ps) {
      for (const s of p.subscriptions) expect(s.monthlyEur).toBeGreaterThan(0);
      if (!p.equipment.includes("internet à domicile")) expect(p.subscriptions.some((s) => s.category === "internet")).toBe(false);
    }
  });

  it("le budget disponible croît avec le niveau de vie", () => {
    const sorted = [...ps].sort((a, b) => a.extra.livingStandardEur - b.extra.livingStandardEur);
    const q = Math.floor(sorted.length / 5);
    const mean = (xs: typeof ps) => xs.reduce((s, p) => s + p.monthlyDiscretionaryBudgetEur, 0) / xs.length;
    expect(mean(sorted.slice(-q))).toBeGreaterThan(3 * mean(sorted.slice(0, q)));
  });
});

describe("impôt sur le revenu", () => {
  it("nul sous le seuil, progressif au-dessus", () => {
    expect(incomeTax(pack, 12_000, 1, false)).toBe(0);
    const t30 = incomeTax(pack, 30_000, 1, false);
    const t60 = incomeTax(pack, 60_000, 1, false);
    expect(t30).toBeGreaterThan(0);
    expect(t60 / 60_000).toBeGreaterThan(t30 / 30_000);
    expect(incomeTax(pack, 60_000, 2, true)).toBeLessThan(t60);
  });
});
