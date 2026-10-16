import { describe, expect, it } from "vitest";
import { renderAttribute, singularAfterValue } from "../../src/modules/engine";
import { loadModuleFile } from "../../src/modules/registry";

/** Accord du mot qui suit la valeur dans les gabarits de fiche (« 1 réunion », « 3 réunions »). */
describe("gabarits de fiche : singulier quand la valeur vaut 1 ou moins", () => {
  const m = loadModuleFile("modules/productivite-reunions/module.yaml");
  it("accorde « réunions par semaine »", () => {
    expect(renderAttribute(m, "meetings_per_week", 1, "F")).toBe("environ 1 réunion par semaine");
    expect(renderAttribute(m, "meetings_per_week", 0.5, "F")).toBe("environ 0,5 réunion par semaine");
    expect(renderAttribute(m, "meetings_per_week", 3, "F")).toBe("environ 3 réunions par semaine");
  });
  it("ne touche ni aux mots invariables, ni aux déterminants, ni aux pourcentages", () => {
    expect(singularAfterValue("{value} fois par an")).toBe("{value} fois par an");
    expect(singularAfterValue("{value} des réunions")).toBe("{value} des réunions");
    expect(singularAfterValue("{value} ans")).toBe("{value} an");
    expect(singularAfterValue("{value} journaux")).toBe("{value} journal");
    expect(renderAttribute(m, "video_meeting_share", 0.4, "F")).toBe("environ 40 % des réunions en visio");
  });
});

/** Module d'un socle anglophone (Singapour) : nombres, pourcentages et montants à l'anglaise, en S$, sans accord français. */
describe("gabarits de fiche : module du socle Singapour", () => {
  const fr = loadModuleFile("modules/productivite-reunions/module.yaml");
  const m = { ...fr, def: { ...fr.def, applies_to: ["sg"] } } as typeof fr;
  it("rend 0.5, 40% et S$1,234", () => {
    expect(renderAttribute(m, "meetings_per_week", 0.5, "F")).toBe("environ 0.5 réunions par semaine");
    expect(renderAttribute(m, "video_meeting_share", 0.4, "F")).toBe("environ 40% des réunions en visio");
    const eurAttr = [...fr.attrs.values()].find((a) => a.display?.format === "eur");
    if (eurAttr) expect(renderAttribute(m, eurAttr.key, 1234, "F")).toContain("S$1,234");
  });
});
