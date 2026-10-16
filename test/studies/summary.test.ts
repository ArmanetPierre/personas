import { describe, expect, it } from "vitest";
import type { ResponseRow, Study } from "../../src/db/schema";
import type { ConceptPriceAnswer } from "../../src/studies/protocols/concept-price";
import type { ConceptPricePayload } from "../../src/studies/run";
import { segmentOf } from "../../src/studies/segments";
import { formatSummary, summarize } from "../../src/studies/summary";
import { answer, makePersonas, pack, payer, project } from "./fixtures";

const personas = makePersonas(40);
const study = { personaGroups: {}, populations: [], id: "st-test", name: "test", backend: "ollama", model: "fake", protocol: "concept-price", protocolVersion: "1", personaIds: personas.map((p) => p.id), status: "completed" } as unknown as Study;

function row(personaId: string, a: ConceptPriceAnswer, anomalies: string[] = []): ResponseRow {
  const payload: ConceptPricePayload = { answer: a, encounter: "article", tiers: [2, 5, 9], priceShown: 5, initialAnomalies: anomalies };
  return {
    id: personaId, studyId: study.id, personaId, questionKey: "concept_price", payload, rawText: null, backend: "ollama", model: "fake",
    inputTokens: 1000, outputTokens: 300, cacheReadTokens: 0, costUsd: null, durationMs: 2000, attempts: 1,
    narrativeUsed: true, repaired: anomalies.length > 0, anomalies, createdAt: "",
  };
}

describe("agrégation", () => {
  // Les moins de 30 ans paient, les autres ignorent
  const young = (id: string) => personas.find((p) => p.id === id)!.age < 30;
  const rows = personas.map((p, i) => row(p.id, young(p.id) ? payer() : answer(), i === 0 ? ["gg_not_monotonic"] : []));
  const full = summarize(pack, study, project, rows, new Map(personas.map((p) => [p.id, p])));
  const s = full.overall;
  const nYoung = personas.filter((p) => p.age < 30).length;

  it("répartit les comportements globalement", () => {
    expect(s.behaviors.overall.n).toBe(40);
    expect(s.behaviors.overall.counts.pay_subscription).toBe(nYoung);
    expect(s.behaviors.overall.counts.ignore).toBe(40 - nYoung);
    expect(s.behaviors.payers).toBeCloseTo(nYoung / 40);
    expect(s.relevance.notConcernedShare).toBeCloseTo((40 - nYoung) / 40);
  });

  it("répartit par segment avec les effectifs et signale n < 15", () => {
    const age = s.behaviors.bySegment.ageBand!;
    const total = age.reduce((a, seg) => a + seg.n, 0);
    expect(total).toBe(40);
    const y = age.find((seg) => seg.code === "18-29");
    if (nYoung) {
      expect(y!.n).toBe(nYoung);
      expect(y!.value.shares.pay_subscription).toBe(1);
      expect(y!.small).toBe(nYoung < 15);
    }
    for (const seg of age.filter((x) => x.code !== "18-29")) expect(seg.value.shares.ignore).toBe(1);
    const q = s.behaviors.bySegment.livingStandard!;
    expect(q.reduce((a, seg) => a + seg.n, 0)).toBe(40);
    for (const seg of q) expect(personas.filter((p) => segmentOf(pack, p, "livingStandard") === seg.code)).toHaveLength(seg.n);
  });

  it("calcule Van Westendorp sur les seuls répondants qui paieraient", () => {
    expect(s.vanWestendorp.n).toBe(nYoung);
    expect(s.vanWestendorp.neverPay).toBe(40 - nYoung);
  });

  it("calcule Gabor-Granger sur tout l'échantillon", () => {
    expect(s.gaborGranger.tiers.map((t) => t.yes)).toEqual([nYoung, nYoung, 0]);
    expect(s.gaborGranger.tiers[1]!.demand).toBeCloseTo(nYoung / 40);
  });

  it("compte les objections, les anomalies et rappelle la méthode", () => {
    expect(s.objections.overall.counts.no_need).toBe(40 - nYoung);
    expect(s.objections.examples.no_need!.length).toBeLessThanOrEqual(3);
    expect(s.anomalies.rate).toBeCloseTo(1 / 40);
    expect(full.methodNote).toMatch(/pas comme une prévision de conversion/);
    expect(full.groups).toEqual([]);
    const text = formatSummary(full);
    expect(text).toMatch(/Van Westendorp/);
    expect(text).toMatch(/\(n < 15\)/);
  });
});

describe("agrégation par groupe (cible / témoin)", () => {
  // 10 personas « ciblées » avec des attributs dans extra, 30 témoins
  const target = personas.slice(0, 10).map((p, i) => ({
    ...p,
    packVersion: "fr-tech-founders-test",
    extra: {
      ...(p.extra as object),
      modules: {
        "entrepreneuriat-tech": {
          status: i < 4 ? "freelance_micro" : "salaried_cadre",
          stage: i < 5 ? "idea" : "preparing",
          team: "team",
          occupation: "dev",
        },
      },
    },
  }));
  const control = personas.slice(10);
  const all = [...target, ...control];
  const groups = Object.fromEntries(all.map((p, i) => [p.id, i < 10 ? "target" : "control"]));
  const st = { ...study, personaIds: all.map((p) => p.id), personaGroups: groups } as Study;
  const rows = all.map((p, i) =>
    row(p.id, i < 10 && i % 2 === 0 ? { ...payer(), wouldForward: true, forwardTo: "un ancien collègue développeur" } : answer()),
  );
  const s = summarize(pack, st, project, rows, new Map(all.map((p) => [p.id, p])));

  it("sépare la cible et le témoin", () => {
    expect(s.groups.map((g) => g.group)).toEqual(["control", "target"].sort((a, b) => (a === "target" ? -1 : b === "target" ? 1 : 0)));
    const t = s.groups.find((g) => g.group === "target")!.analysis;
    const c = s.groups.find((g) => g.group === "control")!.analysis;
    expect(t.n).toBe(10);
    expect(c.n).toBe(30);
    expect(t.behaviors.payers).toBeCloseTo(0.5);
    expect(c.behaviors.payers).toBe(0);
    expect(t.forward.share).toBeCloseTo(0.5);
    expect(s.overall.n).toBe(40);
  });

  it("segmente la cible par statut, stade, préférence et métier lus dans extra", () => {
    const t = s.groups.find((g) => g.group === "target")!.analysis;
    const status = t.behaviors.bySegment.workStatus!;
    expect(status.map((x) => [x.code, x.n])).toEqual(expect.arrayContaining([["freelance_micro", 4], ["salaried_cadre", 6]]));
    expect(t.behaviors.bySegment.projectStage!.map((x) => x.n).sort()).toEqual([5, 5]);
    expect(t.behaviors.bySegment.teamPreference![0]!.n).toBe(10);
    expect(t.behaviors.bySegment.profession![0]!.code).toBe("dev");
    expect(t.behaviors.bySegment.profession![0]!.label).toBe("Développeur·se / ingénieur·e logiciel");
    // Le témoin n'a pas ces attributs : pas de segment vide
    const c = s.groups.find((g) => g.group === "control")!.analysis;
    expect(c.behaviors.bySegment.workStatus).toBeUndefined();
    const text = formatSummary(s);
    expect(text).toMatch(/Comparaison des groupes/);
    expect(text).toMatch(/Cible · Comportement/);
    expect(text).toMatch(/Stade du projet/);
  });
});
