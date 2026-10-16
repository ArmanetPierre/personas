import { describe, expect, it } from "vitest";
import type { Project } from "../../src/db/schema";
import { projectLocale, zoneOf } from "../../src/web/i18n";
import { pricingIn } from "../../src/web/i18n-price";
import { plainCriteria } from "../../src/web/overview";
import type { Pricing } from "../../src/studies/price-model";

const extra = (x: Record<string, unknown>) => ({ extra: x }) as Pick<Project, "extra">;

describe("socle Singapour dans l'interface", () => {
  it("projectLocale lit manifest.locale du socle (dossier ou version)", () => {
    expect(projectLocale(extra({ target: { socle: "sg" } }))).toBe("en");
    expect(projectLocale(extra({ target: { socle: "sg-2026.1" } }))).toBe("en");
    expect(projectLocale(extra({ target: { socle: "fr" } }))).toBe("fr");
    expect(projectLocale(extra({}))).toBe("fr");
    expect(projectLocale(extra({ locale: "en", target: { socle: "fr" } }))).toBe("en");
  });

  it("zone du socle : texte France inchangé, Singapour nommé", () => {
    expect(zoneOf("FR", "fr")).toEqual({ of: "de France métropolitaine", in: "en France", population: "de la population française" });
    expect(zoneOf("SG", "en").in).toBe("in Singapore");
    expect(zoneOf("XX", "en").of).toBe("in the base population");
  });

  it("prix anglais en SGD (formatage commun price-model-en)", () => {
    const p = { currency: "SGD", offers: [{ id: "kg", amount: 24, unit: "quantity", quantity: { unit: "kg", per: "per kg" } }], reference: "kg", tiers: [18, 24, 32] } as unknown as Pricing;
    expect(pricingIn("en", p)).toBe("S$24 per kg");
    expect(pricingIn("fr", p)).toBe("24 SGD per kg");
  });

  it("critères du socle Singapour en clair", () => {
    const { criteria } = plainCriteria("dwelling in [condo, landed] and residency_status != mdw", undefined, "en");
    expect(criteria.map((c) => `${c.label}: ${c.value}`)).toEqual(["Dwelling: condo or landed house", "Residency status: except migrant domestic worker"]);
  });
});
