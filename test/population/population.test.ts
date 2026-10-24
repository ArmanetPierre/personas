import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { personas, type Persona } from "../../src/db/schema";
import { Engine } from "../../src/engine/engine";
import type { Backend, BackendRequest } from "../../src/engine/types";
import { resolveModules } from "../../src/modules/registry";
import { compileEligibility } from "../../src/population/eligibility";
import { ensureNarratives } from "../../src/population/narratives";
import { drawTarget, persistDrawn, prepareTarget, wilson } from "../../src/population/target";
import { describeForPrompt } from "../../src/personas/describe";
import { loadPack } from "../../src/personas/pack";
import { drawPersona, drawPersonas } from "../../src/personas/sampler";

const FOUNDERS = { socle: "fr", modules: ["numerique", "entrepreneuriat"], eligibility: "age >= 25 and age <= 45 and numerique.is_digital_worker and entrepreneuriat.stage != none" };
const v2 = loadPack("fr-2026.2");
const v1 = loadPack("fr");

describe("filtre d'éligibilité", () => {
  const vars = { age: 30, sex: "F", region: "IDF", pcs: "3", "numerique.is_digital_worker": true, "entrepreneuriat.stage": "idea", "entrepreneuriat.brakes": ["no_time"] };
  it("évalue et, ou, non, comparaisons et listes", () => {
    const t = (s: string) => compileEligibility(s).test(vars);
    expect(t("age >= 25 and age <= 45")).toBe(true);
    expect(t("age > 30 or region == IDF")).toBe(true);
    expect(t("not (sex = F)")).toBe(false);
    expect(t("pcs in [3, 4] and entrepreneuriat.stage not in [none, vague]")).toBe(true);
    expect(t("numerique.is_digital_worker and entrepreneuriat.stage != none")).toBe(true);
    expect(t("entrepreneuriat.brakes in [no_time]")).toBe(true);
    expect(t("region == 'IDF' and age < 25")).toBe(false);
  });
  it("refuse une phrase invalide ou une variable inconnue, avec un message clair", () => {
    expect(() => compileEligibility("age >= ")).toThrow(/valeur attendue/);
    expect(() => compileEligibility("age >= 25 and (pcs == 3")).toThrow(/« \) » attendu/);
    expect(() => prepareTarget({ socle: "fr", eligibility: "agee >= 25" })).toThrow(/variable\(s\) inconnue\(s\) : agee/);
    expect(() => prepareTarget({ socle: "fr", modules: ["inconnu"] })).toThrow(/introuvable/);
  });
});

describe("tirage conditionnel", () => {
  const target = prepareTarget(FOUNDERS);
  const a = drawTarget(target, 40, 42);

  it("ne garde que des personas éligibles, mesure le taux et son intervalle", () => {
    expect(a.personas).toHaveLength(40);
    for (const p of a.personas) {
      expect(p.age).toBeGreaterThanOrEqual(25);
      expect(p.extra.modules!.numerique!.is_digital_worker).toBe(true);
      expect(p.extra.modules!.entrepreneuriat!.stage).not.toBe("none");
    }
    expect(a.eligible).toBe(40);
    expect(a.rate).toBeGreaterThan(0.005);
    expect(a.rate).toBeLessThan(0.03);
    expect(a.ci[0]).toBeLessThan(a.rate);
    expect(a.ci[1]).toBeGreaterThan(a.rate);
  });

  it("est déterministe : même graine et même cible, même échantillon ; ids stables (socle, graine, rang)", () => {
    const b = drawTarget(prepareTarget(FOUNDERS), 40, 42);
    expect(b.personas.map((p) => p.id)).toEqual(a.personas.map((p) => p.id));
    // Modules dans une autre version que le socle (numerique 2026.3…) : suffixe de version
    expect(a.personas[0]!.id).toMatch(/^fr-2026\.2-s42-\d{4,}(-m[0-9a-f]{6})?$/);
    const rank = a.personas[0]!.drawIndex!;
    expect(drawPersona(v2, 42, rank, { modules: target.modules })).toEqual(a.personas[0]);
    const other = drawTarget(prepareTarget(FOUNDERS), 40, 7);
    expect(other.personas.map((p) => p.id)).not.toEqual(a.personas.map((p) => p.id));
  });

  it("signale une cible rare et refuse proprement une cible introuvable", () => {
    const rare = drawTarget(prepareTarget({ ...FOUNDERS, eligibility: `${FOUNDERS.eligibility} and entrepreneuriat.stage == seeking_partner` }), 3, 42);
    expect(rare.rare).toBe(true);
    expect(rare.warnings.join()).toMatch(/Cible rare/);
    expect(() => drawTarget(prepareTarget({ socle: "fr", eligibility: "age > 100", max_draws: 2000 }), 5, 42)).toThrow(/Cible trop rare : 0\/5 personas après 2.000 tirages/);
  });

  it("respecte les quotas", () => {
    const q = drawTarget(prepareTarget({ socle: "fr", eligibility: "age >= 30 and age <= 59", quotas: { sex: { F: 0.5, M: 0.5 } } }), 20, 42);
    expect(q.personas.filter((p) => p.sex === "F")).toHaveLength(10);
    expect(q.shortfalls).toEqual([]);
  });

  it("intervalle de Wilson", () => {
    const [lo, hi] = wilson(12, 1000);
    expect(lo).toBeCloseTo(0.00688, 4);
    expect(hi).toBeCloseTo(0.02084, 4);
  });
});

describe("un flux aléatoire par module", () => {
  const none = resolveModules([], "fr");
  const one = resolveModules(["numerique"], "fr");
  const two = resolveModules(["numerique", "entrepreneuriat"], "fr");
  it("ajouter un module ne change ni le socle ni les autres modules (hors effets budgétaires déclarés)", () => {
    // Champs que seuls un revenu remplacé ou des abonnements payés (déclarés par le module) peuvent changer
    const ECO = ["monthlyIncomeEur", "householdIncomeEur", "monthlyDiscretionaryBudgetEur", "priceSensitivity", "subscriptions"];
    const ECO_X = ["housingCostEur", "housingAidEur", "incomeTaxEur", "benefitsEur", "preCommittedEur", "currentExpensesEur", "subscriptionsEur", "livingStandardEur", "monthlyShortfallEur", "economics"];
    const strip = (p: ReturnType<typeof drawPersona>) => {
      const { modules: _m, moduleVersions: _v, ...x } = p.extra;
      const o: Record<string, unknown> = { ...p, id: p.id.replace(/-m[0-9a-f]{6}$/, ""), extra: Object.fromEntries(Object.entries(x).filter(([k]) => !ECO_X.includes(k))) };
      for (const k of ECO) delete o[k];
      return o;
    };
    let changed = 0;
    for (let i = 0; i < 300; i++) {
      const s = drawPersona(v2, 42, i, { modules: none });
      const n = drawPersona(v2, 42, i, { modules: one });
      const ne = drawPersona(v2, 42, i, { modules: two });
      expect(strip(n)).toEqual(strip(s));
      expect(strip(ne)).toEqual(strip(s));
      expect(ne.extra.modules!.numerique).toEqual(n.extra.modules!.numerique);
      // Sans effet budgétaire, le socle est celui du tirage sans module, au champ près
      if (!n.extra.economics) expect({ ...n, id: s.id, extra: { ...n.extra, modules: undefined, moduleVersions: undefined } }).toEqual({ ...s, extra: { ...s.extra, modules: undefined, moduleVersions: undefined } });
      else changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });
  it("le socle v2 sans module reproduit le socle v1 (mêmes attributs, autre version)", () => {
    const a = drawPersonas(v1, 42, 50);
    const b = drawPersonas(v2, 42, 50);
    expect(b.map(({ id: _i, packVersion: _p, ...r }) => r)).toEqual(a.map(({ id: _i, packVersion: _p, ...r }) => r));
  });
});

describe("cache et récits à la demande", () => {
  function fake() {
    const requests: BackendRequest[] = [];
    const backend: Backend = {
      name: "claude-cli",
      model: "fake",
      concurrency: 2,
      async checkAvailability() {
        return { ok: true, detail: "simulé" };
      },
      async generate(req) {
        requests.push(req);
        const cards = [...req.messages.at(-1)!.content.matchAll(/### id: (\S+)\nPrénom : ([^ ;]+) ; \w+ ; (\d+) ans/g)];
        const filler = "Elle fait ses courses le samedi au marché, garde un carnet de comptes dans la cuisine et surveille son compte avant chaque dépense. ".repeat(4);
        return { text: JSON.stringify({ items: cards.map((m) => ({ id: m[1], narrative: `${m[2]}, ${m[3]} ans, vit sa vie sans bruit. ${filler}` })) }), model: "fake", usage: { inputTokens: 10, outputTokens: 20 } };
      },
    };
    return { backend, requests };
  }

  it("persiste une fois, réutilise les jumeaux, n'écrit que les récits manquants, et reprend", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const target = prepareTarget({ ...FOUNDERS, eligibility: "age >= 25 and age <= 45 and numerique.is_digital_worker" });
    const d = drawTarget(target, 6, 42);
    // Jumeau v1 avec récit pour la première persona (même graine, même rang)
    const twin = drawPersona(v1, 42, d.personas[0]!.drawIndex!);
    db.insert(personas).values({ ...twin, narrative: "Récit déjà écrit.", narrativeBackend: "claude-cli", narrativeModel: "m" }).run();
    expect(persistDrawn(db, d.personas)).toEqual({ inserted: 6, updated: 0, reused: 0 });
    expect(persistDrawn(db, d.personas)).toEqual({ inserted: 0, updated: 0, reused: 6 });
    const { backend, requests } = fake();
    const packOf = () => v2;
    const ids = d.personas.map((p) => p.id);
    const r = await ensureNarratives(db, ids, { packOf, engine: new Engine(backend), limit: 3 });
    expect(r.reused).toBe(1);
    expect(r.written).toBe(3);
    // La fiche du récit est générique : pas de lignes de module
    expect(requests[0]!.messages.at(-1)!.content).not.toMatch(/Métier du numérique|Projet de création/);
    const again = await ensureNarratives(db, ids, { packOf, engine: new Engine(backend) });
    expect(again.alreadyDone).toBe(4);
    expect(again.written).toBe(2);
    const rows = db.select().from(personas).all().filter((p) => ids.includes(p.id));
    expect(rows.every((p) => p.narrative)).toBe(true);
    // Les attributs de module restent des lignes de fiche (étude)
    expect(describeForPrompt(v2, rows[0]! as Persona)).toMatch(/Métier du numérique/);
    sqlite.close();
  });
});
