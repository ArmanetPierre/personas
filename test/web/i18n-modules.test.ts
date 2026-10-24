import { describe, expect, it } from "vitest";
import { draftMetaIn, previewAlertIn, previewIn } from "../../src/web/i18n-modules";

/** Textes de l'assistant de modules : français inchangé, anglais à la sortie de l'API (?lang=en). */

const FR_ALERTS: Array<[string, string]> = [
  ["« Space and means index » n'a aucune source (hypothèse seule).", "“Space and means index” has no source (assumption only)."],
  ["12 attributs sur 12 reposent sur des hypothèses (plus de la moitié).", "12 of 12 attributes rest on assumptions (more than half)."],
  [
    "« Fallback platforms » : la valeur « Xbox » n'est jamais tirée (14 personas concernées).",
    "“Fallback platforms”: the value “Xbox” is never drawn (14 personas concerned).",
  ],
  ["« Platforms » : « Cloud gaming » est très rare (0.12 % des personas concernées).", "“Platforms”: “Cloud gaming” is very rare (0.12 % of the personas concerned)."],
  ["Cible déclarée non atteinte : Travaille dans le numérique = 3.1 % (attendu 4.0 % à 5.2 %).", "Declared target not met: Travaille dans le numérique = 3.1 % (expected 4.0 % to 5.2 %)."],
  ["Marge « Dons » : écart max 0.8 pt avec la distribution attendue.", "Margin “Dons”: max deviation 0.8 pt from the expected distribution."],
  [
    "« Gaming PC » concerne un ordinateur, mais 12 personas sans un ordinateur dans le socle en ont une valeur : ajouter « when: {attr: socle.has_computer, eq: true} ».",
    "“Gaming PC” concerns a computer, but 12 personas without a computer in the base population have a value: add “when: {attr: socle.has_computer, eq: true}”.",
  ],
];

describe("alertes d'aperçu des modules", () => {
  it.each(FR_ALERTS)("traduit %s", (fr, en) => {
    expect(previewAlertIn("en", fr)).toBe(en);
    expect(previewAlertIn("fr", fr)).toBe(fr);
  });

  it("aucun mot français restant dans les alertes traduites", () => {
    for (const [fr] of FR_ALERTS) expect(previewAlertIn("en", fr)).not.toMatch(/\b(sur|reposent|jamais|attendu|écart|concerne|personas sans)\b|«|»/);
  });

  it("aperçu complet : alertes et tranches numériques", () => {
    const p = { margins: [{ attribute: "hours", label: "Hours", values: [{ code: "0-5", label: "0 à 5 h", share: 0.4 }] }], sampleCards: [], alerts: [{ level: "warn", message: FR_ALERTS[1]![0] }] };
    const en = previewIn("en", p);
    expect(en.alerts[0]!.message).toBe(FR_ALERTS[1]![1]);
    expect(en.margins[0]!.values[0]!.label).toBe("0 to 5 h");
    expect(previewIn("fr", p)).toBe(p);
  });
});

describe("historique et notes des brouillons", () => {
  const meta = {
    id: "sg-video-games-2610221518",
    status: "ready",
    progress: "Révision prête à relire",
    notes: ["Recherche : No IMDA source.", "Aperçu : 10 attributs sur 10 reposent sur des hypothèses (plus de la moitié).", "Note libre de l'assistant."],
    history: [
      { at: "x", kind: "propose", summary: "Proposition initiale" },
      { at: "x", kind: "repair", summary: "Réparation 1 (1 erreur(s))" },
      { at: "x", kind: "edit", summary: "Édition manuelle" },
      { at: "x", kind: "revise", summary: "Ajouter X — texte du modèle" },
    ],
  };

  it("anglais : libellés générés traduits, texte de l'assistant laissé tel quel", () => {
    const en = draftMetaIn("en", meta);
    expect(en.progress).toBe("Revision ready for review");
    expect(en.notes).toEqual(["Research: No IMDA source.", "Preview: 10 of 10 attributes rest on assumptions (more than half).", "Note libre de l'assistant."]);
    expect((en.history as Array<{ summary: string }>).map((h) => h.summary)).toEqual(["Initial proposal", "Repair 1 (1 error(s))", "Manual edit", "Ajouter X — texte du modèle"]);
  });

  it("français : méta inchangée", () => {
    expect(draftMetaIn("fr", meta)).toBe(meta);
    expect(draftMetaIn("en", null)).toBeNull();
  });
});
