import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Project } from "../../src/db/schema";
import { loadPack } from "../../src/personas/pack";
import { drawPersonas } from "../../src/personas/sampler";
import { formatPrice, priceColumns, priceTiersFor, readProjectFile } from "../../src/studies/project";
import { buildSystemPrompt, buildUserPrompt, checkCoherence, pickEncounter } from "../../src/studies/protocols/concept-price";
import { answer } from "./fixtures";

function projectFrom(path: string): Project {
  const f = readProjectFile(path);
  const cols = priceColumns(f);
  return {
    id: "x", name: f.name, pitch: f.pitch, targetAudience: null, businessModel: null, priceEur: cols.priceEur,
    pricePeriod: cols.pricePeriod, freeOffer: cols.freeOffer, competitors: f.competitors, alternatives: f.alternatives,
    extra: { priceTiers: f.priceTiers, ...cols.extra }, createdAt: "", updatedAt: "",
  } as Project;
}

const fixture = (name: string) => readFileSync(`test/studies/__fixtures__/${name}`, "utf8");

describe("unité de prix", () => {
  it("laisse le prompt de référence (abonnement mensuel) rigoureusement identique", () => {
    const ref = projectFrom("examples/meal-planner.json");
    expect(buildSystemPrompt(ref, priceTiersFor(ref))).toBe(fixture("reference-system-prompt.txt"));
    const pack = loadPack("fr");
    const p = { ...drawPersonas(pack, 99, 1)[0]!, narrative: null } as never;
    expect(buildUserPrompt(pack, p, ref, pickEncounter(p, 7))).toBe(fixture("reference-user-prompt.txt"));
  });

  it("formate un prix par mise en relation", () => {
    expect(formatPrice(5, "month")).toBe("5 €/mois");
    expect(formatPrice(15, "connection")).toBe("15 € par mise en relation");
    expect(formatPrice(49, "once")).toBe("49 €");
  });

  it("exprime Van Westendorp, paliers et paiement dans l'unité de la variante", () => {
    const v3 = projectFrom("examples/variants/meal-planner-dietitian-booking.json");
    const tiers = priceTiersFor(v3);
    expect(tiers).toEqual([5, 15, 30]);
    const sys = buildSystemPrompt(v3, tiers);
    expect(sys).toContain("Prix affiché : 15 € par mise en relation");
    expect(sys).toContain("prix en € par mise en relation");
    expect(sys).toContain("5 € par mise en relation, 15 € par mise en relation, 30 € par mise en relation");
    expect(sys).toContain("tu paies au moins une mise en relation au prix affiché");
    expect(sys).toContain("true si tu paierais vraiment une mise en relation à ce prix dans le mois qui vient");
    expect(sys).not.toMatch(/€\/mois/);
  });

  it("applique les contrôles de cohérence au prix affiché de la variante", () => {
    const ctx = { tiers: [5, 15, 30], projectPrice: 15 };
    const pays = answer({
      relevance: "concerned", behavior: "pay_subscription",
      vanWestendorp: { wouldNeverPay: false, tooCheapEur: 3, cheapEur: 8, expensiveEur: 20, tooExpensiveEur: 40 },
      gaborGranger: { at_5_eur: true, at_15_eur: true, at_30_eur: false },
      budgetFit: "Une mise en relation de temps en temps, sur mes sorties.",
    });
    expect(checkCoherence(pays, ctx)).toEqual([]);
    expect(checkCoherence({ ...pays, gaborGranger: { at_5_eur: true, at_15_eur: false, at_30_eur: false } }, ctx)).toContain("pay_without_gg");
  });
});
