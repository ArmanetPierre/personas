import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { personas } from "../../src/db/schema";
import { renderAttribute } from "../../src/modules/engine";
import { activeLibrary, checkModule, isLegacy, librarySegments, moduleLibrary, resolveModules } from "../../src/modules/registry";
import { persistDrawn, prepareTarget } from "../../src/population/target";
import { describeForPrompt } from "../../src/personas/describe";
import { recomputeEconomics } from "../../src/personas/economics";
import { loadPack } from "../../src/personas/pack";
import { drawPersona, personaIdFor, type DrawnPersona } from "../../src/personas/sampler";
import type { Persona } from "../../src/db/schema";

const v2 = loadPack("fr-2026.2");
const sha = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const numerique = resolveModules(["numerique"], v2.socle);
// Module simple, à la version du socle, sans effet budgétaire (les modules réels dépendent tous de numerique 2026.3)
const plain = checkModule({
  id: "test-plain",
  version: "2026.2",
  label: "Test",
  applies_to: ["fr"],
  attributes: [{ key: "likes_tea", label: "Aime le thé", type: "boolean", rate: 0.4, assumption: true, justification: "test" }],
});
const equip = resolveModules(["test-plain"], v2.socle, new Map([["test-plain", plain]]));

describe("socle sans module : tirage strictement inchangé", () => {
  it("3 000 personas du socle fr-2026.2 identiques à l'empreinte d'avant les effets budgétaires des modules", () => {
    // Empreinte prise le 2026-10-15 avant l'ajout des mécanismes budget/revenu (série de calibration sur ce socle)
    expect(sha(Array.from({ length: 3000 }, (_, i) => drawPersona(v2, 42, i)))).toBe("f54f94e5e7b174d2");
    expect(sha(Array.from({ length: 3000 }, (_, i) => drawPersona(v2, 7, i)))).toBe("b60ccd8222d90010");
  });
  it("même persona du socle avant et après, au champ près ; un module sans effet budgétaire n'y touche pas", () => {
    for (let i = 0; i < 200; i++) {
      const s = drawPersona(v2, 42, i);
      const e = drawPersona(v2, 42, i, { modules: equip });
      expect(s.extra.economics).toBeUndefined();
      const { modules: _m, moduleVersions: _v, ...x } = e.extra;
      expect({ ...e, extra: x }).toEqual(s); // même id (module à la version du socle), mêmes champs
    }
  });
});

describe("recalcul budgétaire (revenu remplacé, abonnements payés)", () => {
  it("sans changement d'entrée, retrouve les valeurs tirées (à l'arrondi près)", () => {
    for (let i = 0; i < 2000; i++) {
      const p = drawPersona(v2, 42, i);
      const q = recomputeEconomics(v2, p, { income: null, subscriptions: [], modules: [] });
      expect(Math.abs(q.monthlyDiscretionaryBudgetEur - p.monthlyDiscretionaryBudgetEur)).toBeLessThanOrEqual(1);
      expect(Math.abs((q.householdIncomeEur ?? 0) - (p.householdIncomeEur ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs(q.priceSensitivity - p.priceSensitivity)).toBeLessThanOrEqual(0.0101);
      expect(q.extra.incomeTaxEur).toBe(p.extra.incomeTaxEur);
    }
  });

  it("numerique : revenu des freelances par le TJM, outils pro déduits du reste-à-vivre ; le reste du socle figé", () => {
    let freelances = 0;
    let tools = 0;
    for (let i = 0; i < 40000 && (freelances < 20 || tools < 20); i++) {
      const s = drawPersona(v2, 42, i);
      const n = drawPersona(v2, 42, i, { modules: numerique });
      const own = n.extra.modules!.numerique!;
      const eco = n.extra.economics as { modules: string[]; incomeBefore: number; budgetBefore: number } | undefined;
      // Profil techno, équipement, ménage, logement : jamais recalculés
      for (const k of ["age", "sex", "pcs", "activityStatus", "techAdoption", "equipment", "householdType", "skepticism", "occupation"] as const) expect(n[k]).toEqual(s[k]);
      if (!eco) {
        expect(n.monthlyIncomeEur).toBe(s.monthlyIncomeEur);
        continue;
      }
      expect(eco.incomeBefore).toBe(s.monthlyIncomeEur);
      expect(eco.modules).toEqual(["numerique@2026.3"]);
      if (own.work_status === "freelance_micro" || own.work_status === "freelance_company") {
        freelances++;
        expect(n.monthlyIncomeEur).toBe(own.monthly_income);
      } else {
        expect(n.monthlyIncomeEur).toBe(s.monthlyIncomeEur);
        tools++;
        // Revenu inchangé : le reste-à-vivre baisse du coût des outils (par UC hors domicile parental)
        const cost = n.subscriptions.slice(s.subscriptions.length).reduce((a, t) => a + t.monthlyEur, 0);
        expect(cost).toBeGreaterThan(0);
        if (s.monthlyDiscretionaryBudgetEur > cost) {
          const units = n.householdType === "with_parents" ? 1 : n.extra.consumptionUnits;
          expect(Math.abs(s.monthlyDiscretionaryBudgetEur - n.monthlyDiscretionaryBudgetEur - cost / units)).toBeLessThanOrEqual(1.5);
        }
      }
    }
    expect(freelances).toBeGreaterThanOrEqual(20);
    expect(tools).toBeGreaterThanOrEqual(20);
  });
});

describe("versions et identifiants", () => {
  it("modules à la version du socle : identifiant inchangé ; autre version : suffixe stable", () => {
    expect(personaIdFor(v2, 42, 0, equip)).toBe("fr-2026.2-s42-0001");
    const id = personaIdFor(v2, 42, 0, numerique);
    expect(id).toMatch(/^fr-2026\.2-s42-0001-m[0-9a-f]{6}$/);
    expect(personaIdFor(v2, 42, 0, numerique)).toBe(id);
    expect(drawPersona(v2, 42, 0, { modules: numerique }).id).toBe(id);
  });

  it("persistDrawn ne réécrit jamais une persona déjà en base", () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const p = drawPersona(v2, 42, 3, { modules: equip });
    persistDrawn(db, [p]);
    // Même id, valeurs de module différentes (simulées) : celles en base sont gardées
    const altered: DrawnPersona = { ...p, extra: { ...p.extra, modules: { "test-plain": { likes_tea: !p.extra.modules!["test-plain"]!.likes_tea } } } };
    persistDrawn(db, [altered]);
    const row = db.select().from(personas).all()[0]!;
    expect((row.extra as { modules: Record<string, unknown> }).modules["test-plain"]).toEqual(p.extra.modules!["test-plain"]);
    // Socle différent sous le même id : refus
    expect(() => persistDrawn(db, [{ ...p, monthlyIncomeEur: p.monthlyIncomeEur + 100 }])).toThrow(/ne sera pas réécrite/);
    sqlite.close();
  });
});

describe("module archivé (entrepreneuriat-tech)", () => {
  it("lisible pour l'historique, absent de la bibliothèque proposée et des cibles", () => {
    const m = moduleLibrary().get("entrepreneuriat-tech")!;
    expect(isLegacy(m)).toBe(true);
    expect(activeLibrary().has("entrepreneuriat-tech")).toBe(false);
    expect(librarySegments().filter((s) => s.legacy).map((s) => s.id)).toEqual(["workStatus", "projectStage", "teamPreference", "profession"]);
    expect(loadPack("fr-tech-founders").modules.ordered.map((x) => x.def.id)).toContain("entrepreneuriat-tech");
    expect(() => prepareTarget({ socle: "fr", modules: ["entrepreneuriat-tech"] })).toThrow();
  });
});

describe("modules équipement et réunions 2026.3", () => {
  const pr = resolveModules(["equipement-ecosysteme", "productivite-reunions"], v2.socle);
  it("au moins un outil de visio au-delà de 10 % de visio ; part affichée en pourcentage", () => {
    let seen = 0;
    for (let i = 0; i < 3000; i++) {
      const p = drawPersona(v2, 42, i, { modules: pr });
      const m = p.extra.modules!["productivite-reunions"]!;
      if ((m.video_meeting_share as number) > 0.1) {
        seen++;
        expect((m.video_tools as string[]).length).toBeGreaterThan(0);
      }
    }
    expect(seen).toBeGreaterThan(100);
    const mod = moduleLibrary().get("productivite-reunions")!;
    expect(renderAttribute(mod, "video_meeting_share", 0.3, "F")).toBe("environ 30 % des réunions en visio");
  });
  it("frein « crédit immobilier » jamais chez qui vit chez ses parents", () => {
    const r = resolveModules(["numerique", "entrepreneuriat"], v2.socle);
    for (let i = 0; i < 20000; i++) {
      const p = drawPersona(v2, 42, i, { modules: r });
      const brakes = p.extra.modules!.entrepreneuriat?.brakes as string[] | null;
      if (brakes?.includes("mortgage")) {
        expect(p.householdType).not.toBe("with_parents");
        expect(p.extra.tenure).toBe("owner_mortgage");
      }
    }
    const card = describeForPrompt(v2, drawPersona(v2, 42, 0, { modules: r }) as unknown as Persona, { modules: ["entrepreneuriat"] });
    expect(typeof card).toBe("string");
  });
});
