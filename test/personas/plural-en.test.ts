import { describe, expect, it } from "vitest";
import type { Persona } from "../../src/db/schema";
import { householdCountsEn } from "../../src/personas/countries/sg/describe";
import { formatPersona } from "../../src/personas/describe";
import { loadPack } from "../../src/personas/pack";
import { drawPersonas } from "../../src/personas/sampler";

/** Tests V1, C19 B4 : « 1 people, 1 adult-equivalents » dans la fiche lisible SG et US. */
describe("fiche lisible en anglais : accords du foyer", () => {
  it("singulier pour 1, pluriel sinon", () => {
    expect(householdCountsEn(1, 1)).toBe("1 person, 1 adult-equivalent");
    expect(householdCountsEn(3, 2.1)).toBe("3 people, 2.1 adult-equivalents");
    expect(householdCountsEn(2, 1)).toBe("2 people, 1 adult-equivalent");
    expect(householdCountsEn(null, undefined)).toBe("? people, ? adult-equivalents");
  });

  for (const country of ["us", "sg"] as const) {
    it(`${country} : une personne seule`, () => {
      const pack = loadPack(country);
      const alone = drawPersonas(pack, 300, 42)
        .map((p) => ({ ...p, narrative: null, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" }) as Persona)
        .find((p) => p.householdSize === 1 && (p.extra as { consumptionUnits?: number }).consumptionUnits === 1);
      expect(alone).toBeDefined();
      const card = formatPersona(pack, alone!);
      expect(card).toContain("(1 person, 1 adult-equivalent)");
      expect(card).not.toMatch(/1 people|1 adult-equivalents/);
    });
  }
});
