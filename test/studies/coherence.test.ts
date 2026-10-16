import { describe, expect, it } from "vitest";
import { checkCoherence } from "../../src/studies/protocols/concept-price";
import { answer, payer } from "./fixtures";

const ctx = { tiers: [2, 5, 9], projectPrice: 5 };

describe("contrôles de cohérence", () => {
  it("accepte un refus et un payeur cohérents", () => {
    expect(checkCoherence(answer(), ctx)).toEqual([]);
    expect(checkCoherence(payer(), ctx)).toEqual([]);
  });

  it("détecte un Gabor-Granger non monotone", () => {
    const a = { ...payer(), gaborGranger: { at_2_eur: false, at_5_eur: true, at_9_eur: false } };
    expect(checkCoherence(a, ctx)).toContain("gg_not_monotonic");
  });

  it("détecte des prix Van Westendorp non ordonnés ou incomplets", () => {
    const a = payer();
    expect(checkCoherence({ ...a, vanWestendorp: { ...a.vanWestendorp, cheapEur: 10 } }, ctx)).toContain("vw_not_ordered");
    expect(checkCoherence({ ...a, vanWestendorp: { ...a.vanWestendorp, expensiveEur: null } }, ctx)).toContain("vw_incomplete");
  });

  it("détecte un oui à un prix jugé trop cher", () => {
    const a = payer();
    expect(checkCoherence({ ...a, vanWestendorp: { ...a.vanWestendorp, expensiveEur: 4, tooExpensiveEur: 5 } }, ctx)).toContain("vw_gg_conflict");
  });

  it("vérifie que « paierait » concorde avec le Gabor-Granger au prix du projet", () => {
    const a = { ...payer(), gaborGranger: { at_2_eur: true, at_5_eur: false, at_9_eur: false } };
    expect(checkCoherence(a, ctx)).toContain("pay_without_gg");
    const b = { ...payer(), behavior: "ignore" as const };
    expect(checkCoherence(b, ctx)).toContain("gg_without_action");
  });

  it("refuse « ne paierait à aucun prix » avec un oui", () => {
    const a = { ...answer(), gaborGranger: { at_2_eur: true, at_5_eur: false, at_9_eur: false }, budgetFit: "Sur mes sorties du mois, sans souci." };
    expect(checkCoherence(a, ctx)).toContain("never_pay_contradiction");
  });

  it("exige de dire où trouver l'argent quand la persona paierait", () => {
    expect(checkCoherence({ ...payer(), budgetFit: "" }, ctx)).toContain("budget_unjustified");
  });

  it("refuse une persona pas concernée qui s'inscrit, et un refus sans objection", () => {
    expect(checkCoherence({ ...answer(), behavior: "free_signup" }, ctx)).toContain("not_concerned_but_engaged");
    expect(checkCoherence({ ...answer(), objections: [] }, ctx)).toContain("ignore_without_objection");
  });

  it("refuse une persona pas concernée qui accumule les objections", () => {
    const objs = [
      { category: "no_need" as const, detail: "Pas de projet." },
      { category: "network_effect" as const, detail: "Peu de membres." },
      { category: "trust_privacy" as const, detail: "Site inconnu." },
    ];
    expect(checkCoherence({ ...answer(), objections: objs }, ctx)).toContain("not_concerned_too_many_objections");
    expect(checkCoherence({ ...answer(), objections: objs.slice(0, 2) }, ctx)).not.toContain("not_concerned_too_many_objections");
    // Une persona concernée peut en citer davantage
    expect(checkCoherence({ ...payer(), objections: objs }, ctx)).not.toContain("not_concerned_too_many_objections");
  });

  it("contrôle la transmission de l'offre", () => {
    expect(checkCoherence({ ...answer(), wouldForward: true, forwardTo: "" }, ctx)).toContain("forward_without_target");
    expect(checkCoherence({ ...answer(), wouldForward: true, forwardTo: "ma collègue qui veut se lancer" }, ctx)).toEqual([]);
    expect(checkCoherence({ ...payer(), behavior: "recommend" }, ctx)).toContain("recommend_without_forward");
  });
});
