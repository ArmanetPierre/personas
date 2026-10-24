import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { personas } from "../../src/db/schema";
import { cardLines } from "../../src/modules/engine";
import { migratePackToModules } from "../../src/modules/migrate";
import { checkModule, moduleLibrary, ModuleError, resolveModules, type LoadedModule } from "../../src/modules/registry";
import { describeForPrompt, formatPersona } from "../../src/personas/describe";
import { loadPack, type Pack } from "../../src/personas/pack";
import { drawPersonas } from "../../src/personas/sampler";
import { computeMargins, plausibilityChecks } from "../../src/personas/validate";
import { segmentLabel, segmentOf } from "../../src/studies/segments";
import type { Persona } from "../../src/db/schema";

const MOD = "entrepreneuriat-tech";
const founders = loadPack("fr-tech-founders");
const general = loadPack("fr");
const asRow = (p: ReturnType<typeof drawPersonas>[number]) =>
  ({ ...p, narrative: null, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" }) as Persona;

/** Petit module factice valide, qu'on altère pour les cas invalides. */
function tiny(over: Record<string, unknown> = {}) {
  return {
    id: "test-loisirs",
    version: "0.1",
    label: "Loisirs (test)",
    applies_to: ["fr"],
    sources: { s1: { org: "Test", title: "Source factice", year: 2025, url: "https://example.org/s1" } },
    attributes: [
      {
        key: "hobby",
        label: "Loisir principal",
        type: "enum",
        values: [
          { code: "lecture", label: "lecture" },
          { code: "sport", label: "sport" },
          { code: "jardin", label: "jardinage" },
        ],
        distribution: { weights: { lecture: 2, sport: 1, jardin: 1 } },
        sources: ["s1"],
      },
      {
        key: "hours",
        label: "Heures par semaine",
        type: "number",
        value: { round: { mul: [{ pick: "hobby", values: { lecture: 3, sport: 4 }, default: 2 }, { exp: { mul: [0.3, { normal: {} }] } }] } },
        display: { template: "{value} h par semaine", empty: "presque jamais" },
        assumption: true,
        justification: "Test.",
      },
    ],
    card: ["Loisir : {hobby}, {hours}"],
    segments: [{ id: "hobbyTest", attribute: "hobby", label: "Loisir" }],
    validation: { margins: [{ attribute: "hobby", title: "Loisir" }] },
    ...over,
  };
}

const errorOf = (raw: unknown) => {
  try {
    checkModule(raw);
  } catch (e) {
    return (e as ModuleError).message;
  }
  return "";
};

describe("format de module", () => {
  it("accepte un module valide et la bibliothèque du dépôt", () => {
    expect(checkModule(tiny()).def.id).toBe("test-loisirs");
    const lib = moduleLibrary();
    expect([...lib.keys()]).toContain(MOD);
  });

  it("refuse les cas invalides avec des messages clairs", () => {
    expect(errorOf(tiny({ id: "Pas Valide" }))).toMatch(/id en minuscules/);
    const noSource = tiny();
    (noSource.attributes[0] as Record<string, unknown>).sources = [];
    expect(errorOf(noSource)).toMatch(/hobby.*ni source citée ni `assumption: true`/);
    const unknownSource = tiny();
    (unknownSource.attributes[0] as Record<string, unknown>).sources = ["inconnue"];
    expect(errorOf(unknownSource)).toMatch(/source « inconnue » absente/);
    const noJustif = tiny();
    delete (noJustif.attributes[1] as Record<string, unknown>).justification;
    expect(errorOf(noJustif)).toMatch(/hypothèse sans `justification`/);
    const badOrder = tiny();
    badOrder.attributes.reverse();
    expect(errorOf(badOrder)).toMatch(/« hobby » n'est pas un attribut déclaré avant lui/);
    const badSocle = tiny();
    (badSocle.attributes[1] as Record<string, unknown>).phase = "work";
    (badSocle.attributes[0] as Record<string, unknown>).phase = "work";
    (badSocle.attributes[1] as Record<string, unknown>).value = { attr: "socle.tenure" };
    expect(errorOf(badSocle)).toMatch(/« tenure » indisponible en phase work/);
    const badValue = tiny();
    (badValue.attributes[0] as { distribution: unknown }).distribution = { weights: { lecture: 1, peche: 2 } };
    expect(errorOf(badValue)).toMatch(/valeur « peche » inconnue/);
    expect(errorOf(tiny({ card: ["{inexistant}"] }))).toMatch(/card : « \{inexistant\} »/);
    const badType = tiny();
    (badType.attributes[0] as Record<string, unknown>).type = "liste";
    expect(errorOf(badType)).toMatch(/attributes\.0/);
  });
});

describe("dépendances", () => {
  const lib = (...mods: LoadedModule[]) => new Map([...moduleLibrary(), ...mods.map((m) => [m.def.id, m] as const)]);

  it("refuse un cycle", () => {
    const a = checkModule(tiny({ id: "cycle-a", requires: ["cycle-b"], segments: [] }));
    const b = checkModule(tiny({ id: "cycle-b", requires: ["cycle-a"], segments: [] }));
    expect(() => resolveModules(["cycle-a"], "fr", lib(a, b))).toThrow(/circulaires entre modules : cycle-a → cycle-b → cycle-a/);
  });

  it("ordonne les dépendances avant et refuse un socle incompatible", () => {
    const dep = checkModule(tiny({ id: "dep-test", requires: [MOD], segments: [] }));
    const r = resolveModules(["dep-test"], "fr", lib(dep));
    expect(r.ordered.map((m) => m.def.id)).toEqual([MOD, "dep-test"]);
    expect(() => resolveModules(["dep-test"], "sg", lib(dep))).toThrow(/non compatible avec le socle « sg »/);
    expect(() => resolveModules(["absent"], "fr")).toThrow(/introuvable/);
  });
});

describe("tirage avec le module entrepreneuriat-tech", () => {
  it("déterministe, valeurs rangées dans extra.modules", () => {
    const a = drawPersonas(founders, 42, 30);
    expect(drawPersonas(founders, 42, 30)).toEqual(a);
    const m = a[0]!.extra.modules![MOD]!;
    expect(Object.keys(m)).toEqual(["status", "occupation", "daily_rate", "monthly_income", "stage", "team", "brakes", "networks", "pro_tools", "weekly_hours"]);
    expect(a[0]!.monthlyIncomeEur).toBe(m.monthly_income);
    expect(a[0]!.occupation).toContain(" — ");
    expect(drawPersonas(general, 42, 3).every((p) => p.extra.modules === undefined)).toBe(true);
  });

  describe("grand tirage", () => {
    const big = drawPersonas(founders, 2024, 12_000);
    const rows = big.map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null }));
    const reports = computeMargins(founders, rows);
    it("marges du module conformes, dimensions générales inadaptées retirées", () => {
      const keys = reports.map((r) => r.key);
      expect(keys).toEqual(expect.arrayContaining([`${MOD}.status`, `${MOD}.occupation`, `${MOD}.stage`]));
      expect(keys).not.toContain("activity");
      for (const r of reports.filter((x) => x.kind === "drawn")) expect(r.maxAbsDevPts, r.title).toBeLessThan(2);
    });
    it("plausibilité des revenus par statut et par métier", () => {
      const checks = plausibilityChecks(founders, rows);
      expect(checks.length).toBeGreaterThan(5);
      for (const c of checks) expect(c.pass, `${c.label} = ${c.value}`).toBe(true);
      expect(Math.max(...big.map((p) => (p.extra.modules![MOD]!.brakes as string[]).length))).toBeLessThanOrEqual(4);
    });
  });

  it("fiche et segments lus depuis le module", () => {
    const p = asRow(drawPersonas(founders, 42, 1)[0]!);
    const card = describeForPrompt(founders, p);
    expect(card).toMatch(/^Projet de création d'entreprise : /m);
    expect(card).toMatch(/^Freins : /m);
    expect(formatPersona(founders, p)).toContain("Entreprendre");
    const g = asRow(drawPersonas(general, 42, 1)[0]!);
    expect(describeForPrompt(general, g).split("\n")).toHaveLength(11);
    const code = segmentOf(founders, p, "projectStage");
    expect(code).toBe(p.extra && (p.extra as { modules: Record<string, Record<string, string>> }).modules[MOD]!.stage);
    expect(segmentLabel(founders, "projectStage", "vague", p)).toBe("envie floue d'entreprendre « un jour », sans idée précise");
    expect(segmentLabel(founders, "workStatus", "salaried_cadre", { ...p, sex: "F" })).toBe("salariée cadre");
  });
});

describe("combinaison de deux modules", () => {
  const extra = checkModule(tiny({ requires: [MOD], segments: [] }));
  const combined: Pack = { ...founders, modules: resolveModules([MOD, "test-loisirs"], "fr", new Map([...moduleLibrary(), [extra.def.id, extra]])) };
  const one = drawPersonas(founders, 42, 50);
  const two = drawPersonas(combined, 42, 50);

  it("le second module s'ajoute sans changer les attributs du premier", () => {
    for (let i = 0; i < 50; i++) {
      expect(two[i]!.extra.modules![MOD]).toEqual(one[i]!.extra.modules![MOD]);
      expect(["lecture", "sport", "jardin"]).toContain(two[i]!.extra.modules!["test-loisirs"]!.hobby);
    }
  });

  it("la fiche affiche les lignes des deux modules, dans l'ordre de tirage", () => {
    const lines = cardLines(combined.modules, two[0]!.extra.modules, two[0]!.sex);
    expect(lines[0]!.module.def.id).toBe(MOD);
    expect(lines.at(-1)!.module.def.id).toBe("test-loisirs");
    expect(lines.at(-1)!.line).toMatch(/^Loisir : (lecture|sport|jardinage), (\d+ h par semaine|presque jamais)$/);
  });

  it("valide les marges des deux modules", () => {
    const reports = computeMargins(combined, drawPersonas(combined, 3, 4000).map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null })));
    expect(reports.find((r) => r.key === "test-loisirs.hobby")!.maxAbsDevPts).toBeLessThan(3);
  });
});

describe("migration des données", () => {
  it("convertit l'ancien format, est idempotente et refuse un tirage divergent", () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const drawn = drawPersonas(founders, 42, 12);
    // Ancien format : attributs sous extra.founder, pas d'extra.modules
    const legacy = drawn.map((p) => {
      const { modules, ...rest } = p.extra;
      return { ...p, extra: { ...rest, founder: { status: modules![MOD]!.status, statusLabel: "x" } } };
    });
    legacy[11] = { ...legacy[11]!, monthlyIncomeEur: legacy[11]!.monthlyIncomeEur + 1 };
    db.insert(personas).values(legacy).run();
    const first = migratePackToModules(db, founders);
    expect(first).toMatchObject({ total: 12, migrated: 11, already: 0 });
    expect(first.mismatches).toHaveLength(1);
    const second = migratePackToModules(db, founders);
    expect(second).toMatchObject({ migrated: 0, already: 11 });
    const row = db.select().from(personas).all().find((r) => r.id === drawn[0]!.id)!;
    expect((row.extra as Record<string, unknown>).founder).toBeUndefined();
    expect(row.extra).toEqual(drawn[0]!.extra);
    sqlite.close();
  });
});

describe("conditionnement à plusieurs attributs et poids calculés", () => {
  const multi = () =>
    tiny({
      attributes: [
        {
          key: "hobby",
          label: "Loisir",
          type: "enum",
          values: [{ code: "lecture", label: "lecture" }, { code: "sport", label: "sport" }],
          distribution: { given: ["socle.sex", "socle.activity_status"], table: { F: { retired: { lecture: 3, sport: 1 }, default: { lecture: 1, sport: 1 } }, default: { default: { lecture: 1, sport: 3 } } } },
          sources: ["s1"],
        },
        {
          key: "club",
          label: "Adhère à un club",
          type: "boolean",
          rate: { mul: [{ pick: "hobby", values: { sport: 0.4 }, default: 0.05 }, { if: { attr: "socle.age", gt: 60 }, then: 0.5, else: 1 }] },
          assumption: true,
          justification: "Test.",
        },
      ],
      card: [],
      validation: { margins: [{ attribute: "hobby", title: "Loisir" }] },
    });

  it("tire selon une table imbriquée et calcule la distribution attendue", () => {
    const m = checkModule(multi());
    const pack: Pack = { ...general, modules: { ordered: [m], quasiDims: new Map() } };
    const v2pack = { ...loadPack("fr-2026.2"), modules: { ordered: [m], quasiDims: new Map() } };
    expect(() => drawPersonas(pack, 1, 1)).not.toThrow();
    const ps = drawPersonas(v2pack, 5, 3000);
    const retiredF = ps.filter((p) => p.sex === "F" && p.activityStatus === "retired");
    const share = retiredF.filter((p) => p.extra.modules!["test-loisirs"]!.hobby === "lecture").length / retiredF.length;
    expect(share).toBeGreaterThan(0.65);
    const reports = computeMargins(v2pack, ps.map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null })));
    expect(reports.find((r) => r.key === "test-loisirs.hobby")!.pass).toBe(true);
  });

  it("refuse une table imbriquée incomplète", () => {
    const bad = multi();
    (bad.attributes[0] as unknown as { distribution: { table: Record<string, unknown> } }).distribution.table = { F: { retired: { lecture: 1, sport: 1 } } };
    expect(errorOf(bad)).toMatch(/pas de ligne pour socle\.sex|pas de ligne/);
  });
});
