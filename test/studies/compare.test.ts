import { describe, expect, it } from "vitest";
import type { Persona, Project, ResponseRow, Study } from "../../src/db/schema";
import { compareSummaries, formatComparison, pickAnalysis, pts } from "../../src/studies/compare";
import type { ConceptPriceAnswer } from "../../src/studies/protocols/concept-price";
import type { ConceptPricePayload } from "../../src/studies/run";
import { summarize } from "../../src/studies/summary";
import { answer, makePersonas, pack, payer, project } from "./fixtures";

const base = makePersonas(20);
// Population ciblée simulée : attributs du module entrepreneuriat-tech dans extra.modules
const personas: Persona[] = base.map((p, i) => ({
  ...p,
  extra: { ...(p.extra as object), modules: { "entrepreneuriat-tech": { stage: i < 10 ? "seeking_partner" : "vague", team: "open", status: "salaried_tech" } } },
}));
const byId = new Map(personas.map((p) => [p.id, p]));

function study(id: string, groups: Record<string, string> = {}): Study {
  return { id, name: id, backend: "ollama", model: "fake", protocol: "concept-price", protocolVersion: "2", personaIds: personas.map((p) => p.id), personaGroups: groups, populations: [], status: "completed" } as unknown as Study;
}
function rows(studyId: string, make: (i: number) => ConceptPriceAnswer, tiers = [2, 5, 9]): ResponseRow[] {
  return personas.map((p, i) => {
    const payload: ConceptPricePayload = { answer: make(i), encounter: "article", tiers, priceShown: 5, initialAnomalies: [] };
    return { id: `${studyId}-${i}`, studyId, personaId: p.id, questionKey: "concept_price", payload, rawText: null, backend: "ollama", model: "fake", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: null, durationMs: 1, attempts: 1, narrativeUsed: true, repaired: false, anomalies: [], createdAt: "" };
  });
}
const signup = () => answer({ relevance: "concerned", behavior: "free_signup", objections: [{ category: "price", detail: "Pas encore." }] });

// Référence : 2 inscriptions gratuites sur 20 (parmi « searching »), objection réseau partout
const refRows = rows("st-ref", (i) =>
  i < 2 ? signup() : answer({ objections: [{ category: "no_need", detail: "x" }, { category: "network_effect", detail: "peu de membres" }] }),
);
// Variante : 6 inscriptions dont 1 payeur, plus d'objection réseau
const varRows = rows("st-var", (i) => (i === 0 ? payer() : i < 6 ? signup() : answer()));
const ref = summarize(pack, study("st-ref"), project, refRows, byId);
const variant = summarize(pack, study("st-var"), project, varRows, byId);

describe("comparaison de variantes", () => {
  const c = compareSummaries([ref, variant]);

  it("donne les écarts en points par rapport à la référence", () => {
    expect(pts(0.3, 0.1)).toBe(20);
    expect(c.referenceId).toBe("st-ref");
    expect(c.entries[0]!.freeSignupOrMore).toBeCloseTo(0.1);
    expect(c.entries[1]!.freeSignupOrMore).toBeCloseTo(0.3);
    expect(c.deltas[1]!.freeSignupOrMore).toBe(20);
    expect(c.deltas[1]!.payers).toBe(5);
    expect(c.deltas[1]!.objections.network_effect).toBe(-85);
    expect(c.deltas[0]!.freeSignupOrMore).toBe(0);
    expect(c.deltas[1]!.gaborGranger.map((t) => t.price)).toEqual([2, 5, 9]);
    expect(c.deltas[1]!.gaborGranger[1]!.demand).toBe(5);
    expect(c.unitsDiffer).toBe(false);
  });

  it("compare les segments (stade du projet) et signale les petits effectifs", () => {
    const seg = c.entries[1]!.segments.projectStage!;
    const searching = seg.find((s) => s.code === "seeking_partner")!;
    expect(searching.n).toBe(10);
    expect(searching.freeSignupOrMore).toBeCloseTo(0.6);
    expect(c.deltas[1]!.segments.projectStage!.find((s) => s.code === "seeking_partner")!.freeSignupOrMore).toBe(40);
    const text = formatComparison(c);
    expect(text).toMatch(/Stade du projet/);
    expect(text).toMatch(/\(\+20\)/);
    expect(text).toMatch(/⚠ 10 cherche activement un ou une associ/);
  });

  it("ne compare pas des paliers d'unités différentes", () => {
    const perUse: Project = { ...project, priceEur: 15, pricePeriod: "connection", extra: { priceTiers: [5, 15, 30] } };
    const v3 = summarize(pack, study("st-v3"), perUse, rows("st-v3", () => answer({ gaborGranger: { at_5_eur: false, at_15_eur: false, at_30_eur: false } }), [5, 15, 30]), byId);
    const c3 = compareSummaries([ref, v3]);
    expect(c3.unitsDiffer).toBe(true);
    expect(c3.entries[1]!.priceUnit).toBe("mise en relation");
    expect(c3.deltas[1]!.gaborGranger.every((t) => t.demand === null)).toBe(true);
    expect(formatComparison(c3)).toMatch(/Unités de prix différentes/);
  });

  it("choisit le groupe demandé dans une étude cible / témoin", () => {
    const groups = Object.fromEntries(personas.map((p, i) => [p.id, i < 10 ? "target" : "control"]));
    const mixed = summarize(pack, study("st-mix", groups), project, rows("st-mix", (i) => (i < 10 ? signup() : answer())), byId);
    expect(pickAnalysis(mixed, "target").analysis.n).toBe(10);
    const cg = compareSummaries([mixed, variant], "target");
    expect(cg.entries[0]!.n).toBe(10);
    expect(cg.entries[0]!.freeSignupOrMore).toBe(1);
    expect(cg.entries[1]!.n).toBe(20); // étude à groupe unique : prise en entier
    expect(cg.sizesDiffer).toBe(true);
    expect(() => compareSummaries([mixed], "autre")).toThrow(/pas de groupe/);
  });
});

describe("comparaison v1 (pack sur-mesure) contre v2 (modules)", () => {
  it("range les dimensions de module sous la dimension v1 équivalente", async () => {
    const { toEntry, SEGMENT_ALIASES } = await import("../../src/studies/compare");
    const { COMPARE_DIMENSIONS } = await import("../../src/studies/segments");
    expect(COMPARE_DIMENSIONS).toEqual(expect.arrayContaining(["entrepreneurStage"]));
    expect(SEGMENT_ALIASES.entrepreneurStage!.dim).toBe("projectStage");
    const dist = (signup: number) => ({ n: 10, counts: {}, shares: { ignore: 1 - signup, save_for_later: 0, visit_page: 0, free_signup: signup, free_active: 0, pay_subscription: 0, recommend: 0 } });
    const base = summarize(pack, study("st-x"), project, rows("st-x", () => answer()), byId);
    const fake = {
      ...base,
      overall: {
        ...base.overall,
        behaviors: { ...base.overall.behaviors, bySegment: { entrepreneurStage: [{ code: "launched", label: "activité lancée", n: 10, small: true, value: dist(0.5) }] } },
      },
    } as unknown as typeof base;
    const e = toEntry(fake);
    expect(e.segments.projectStage).toEqual([{ code: "launched_solo", label: "activité lancée", n: 10, freeSignupOrMore: 0.5, payers: 0 }]);
    expect(e.segments.entrepreneurStage).toBeUndefined();
  });
});
