import { describe, expect, it } from "vitest";
import { gaborGranger, intersect, vanWestendorp } from "../../src/studies/pricing";

describe("Van Westendorp", () => {
  // Trois répondants aux réponses connues
  const answers = [
    { tooCheap: 1, cheap: 2, expensive: 5, tooExpensive: 8 },
    { tooCheap: 2, cheap: 3, expensive: 6, tooExpensive: 10 },
    { tooCheap: 1, cheap: 4, expensive: 7, tooExpensive: 9 },
  ];
  const r = vanWestendorp(answers);

  it("calcule les courbes cumulées sur la grille des prix cités", () => {
    expect(r.n).toBe(3);
    expect(r.curve.map((p) => p.price)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const at = (x: number) => r.curve.find((p) => p.price === x)!;
    expect(at(1)).toMatchObject({ tooCheap: 1, cheap: 1, expensive: 0, tooExpensive: 0 });
    expect(at(2).tooCheap).toBeCloseTo(1 / 3);
    expect(at(3).cheap).toBeCloseTo(2 / 3);
    expect(at(6).expensive).toBeCloseTo(2 / 3);
    expect(at(9).tooExpensive).toBeCloseTo(2 / 3);
    expect(at(10)).toMatchObject({ tooCheap: 0, cheap: 0, expensive: 1, tooExpensive: 1 });
  });

  it("trouve les points PMC, OPP, IPP et PME par interpolation", () => {
    // tooCheap = 1/3 à 2 et 0 à 3 ; pas bon marché = 0 à 2... croisement entre 2 et 3
    expect(r.pmc).not.toBeNull();
    expect(r.pmc!).toBeGreaterThan(1);
    expect(r.pmc!).toBeLessThan(3);
    // bon marché (décroissant) croise cher (croissant) entre 4 et 5
    expect(r.ipp).toBeCloseTo(4.5, 1);
    expect(r.opp!).toBeGreaterThanOrEqual(2);
    expect(r.pme!).toBeGreaterThan(5);
    expect(r.pme!).toBeLessThan(9);
    expect(r.pmc!).toBeLessThanOrEqual(r.ipp!);
    expect(r.ipp!).toBeLessThanOrEqual(r.pme!);
  });

  it("interpole un croisement simple", () => {
    expect(intersect([0, 10], [1, 0], [0, 1])).toBe(5);
    expect(intersect([0, 10], [1, 0.8], [0, 0.2])).toBeNull();
  });

  it("gère un échantillon vide", () => {
    expect(vanWestendorp([])).toMatchObject({ n: 0, pmc: null, opp: null, ipp: null, pme: null });
  });
});

describe("Gabor-Granger", () => {
  it("calcule la demande et le revenu attendu par palier", () => {
    const r = gaborGranger([2, 5, 9], [
      [true, true, false],
      [true, false, false],
      [false, false, false],
      [true, true, true],
    ]);
    expect(r.tiers).toEqual([
      { price: 2, yes: 3, demand: 0.75, revenuePer100: 150 },
      { price: 5, yes: 2, demand: 0.5, revenuePer100: 250 },
      { price: 9, yes: 1, demand: 0.25, revenuePer100: 225 },
    ]);
    expect(r.bestPrice).toBe(5);
  });

  it("ne désigne aucun palier si personne ne paie", () => {
    expect(gaborGranger([2, 5], [[false, false]]).bestPrice).toBeNull();
  });
});
