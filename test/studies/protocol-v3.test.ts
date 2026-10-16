import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ResponseRow, Study } from "../../src/db/schema";
import { openDb, runMigrations } from "../../src/db/client";
import { Engine } from "../../src/engine/engine";
import { drawPersonas } from "../../src/personas/sampler";
import { insertPersonas } from "../../src/personas/store";
import { compareSummaries, formatComparison } from "../../src/studies/compare";
import { confidenceIndex } from "../../src/studies/confidence";
import { DEFAULT_CALIBRATION, loadCalibration, paymentMeasure, smoothShare, type PaymentCalibration } from "../../src/studies/payment";
import { createProject, priceTiersFor, readProjectFile } from "../../src/studies/project";
import {
  answerSchemaFor,
  autoLowTier,
  buildSystemPrompt,
  checkCoherence,
  coherenceContext,
  lowTierOf,
  NEED_FREQUENCY_LINE,
  protocolVersionOf,
  QUESTION_KEY,
  studyTiers,
} from "../../src/studies/protocols/concept-price";
import { runStudy, type ConceptPricePayload } from "../../src/studies/run";
import { studyResponses } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { formatSummary, summarize } from "../../src/studies/summary";
import { answer, fakeBackend, makePersonas, pack, payer, project } from "./fixtures";
import { projectFrom } from "./project-helpers";

/** Prompts système v2 des projets d'exemple, enregistrés avant l'ajout du v3. */
const V2_PROMPTS = JSON.parse(readFileSync("test/studies/__fixtures__/v2-system-prompts.json", "utf8")) as Record<string, string>;

describe("protocole v2 figé", () => {
  it("garde, pour chaque projet d'exemple, le prompt système enregistré avant le v3 (à l'octet près)", () => {
    expect(Object.keys(V2_PROMPTS).length).toBeGreaterThanOrEqual(8);
    for (const [file, prompt] of Object.entries(V2_PROMPTS)) {
      const p = projectFrom(file);
      expect(buildSystemPrompt(p, priceTiersFor(p)), file).toBe(prompt);
      expect(buildSystemPrompt(p, studyTiers(p, "2"), "2"), file).toBe(prompt);
    }
  });

  it("lit en v2 toute étude qui n'est pas enregistrée en v3", () => {
    expect(protocolVersionOf("1")).toBe("2");
    expect(protocolVersionOf("2")).toBe("2");
    expect(protocolVersionOf(null)).toBe("2");
    expect(protocolVersionOf("3")).toBe("3");
  });

  it("garde le schéma, les paliers et les contrôles v2", () => {
    const tiers = [2, 5, 9];
    expect(z.toJSONSchema(answerSchemaFor(tiers, undefined, "2"))).toEqual(z.toJSONSchema(answerSchemaFor(tiers)));
    expect(Object.keys(z.toJSONSchema(answerSchemaFor(tiers)).properties as object)).not.toContain("needFrequency");
    expect(studyTiers({ priceEur: 23, extra: { priceTiers: [23, 40] } }, "2")).toEqual([23, 40]);
    // Aucun contrôle de fréquence en v2, même si le champ est présent
    const ctx = coherenceContext(project, tiers);
    expect(checkCoherence({ ...payer(), needFrequency: "never" }, ctx)).not.toContain("need_frequency_mismatch");
  });

  it("rejoue une étude v2 avec le prompt et le schéma v2", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 20));
    const p = createProject(db, readProjectFile("examples/meal-planner.json"));
    const { study } = createStudy(db, pack, { projectId: p.id, n: 3, seed: 7, backend: "ollama", model: "fake", protocolVersion: "2" });
    expect(study.protocolVersion).toBe("2");
    const fb = fakeBackend(() => JSON.stringify(answer()));
    await runStudy(db, new Engine(fb.backend), pack, study);
    expect(fb.requests[0]!.system).toBe(V2_PROMPTS["examples/meal-planner.json"]);
    expect(Object.keys((fb.requests[0]!.jsonSchema as { properties: object }).properties)).not.toContain("needFrequency");
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    const payload = rows[0]!.payload as ConceptPricePayload;
    expect(payload.protocolVersion).toBeUndefined();
    expect(payload.pitchTone).toBeUndefined();
    expect("needFrequency" in payload.answer).toBe(false);
    sqlite.close();
  });
});

describe("protocole v3", () => {
  it("ajoute seulement la ligne needFrequency, en tête des champs", () => {
    const p = projectFrom("examples/meal-planner.json");
    const v2 = buildSystemPrompt(p, [2, 5, 9], "2");
    const v3 = buildSystemPrompt(p, [2, 5, 9], "3");
    const l2 = v2.split("\n");
    const l3 = v3.split("\n");
    expect(l3.length).toBe(l2.length + 1);
    const i = l3.indexOf(NEED_FREQUENCY_LINE);
    expect(l3[i + 1]).toMatch(/^- spontaneousReaction :/);
    expect([...l3.slice(0, i), ...l3.slice(i + 1)]).toEqual(l2);
  });

  it("met needFrequency en premier champ du schéma", () => {
    const js = z.toJSONSchema(answerSchemaFor([2, 5, 9], undefined, "3")) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(Object.keys(js.properties)[0]).toBe("needFrequency");
    expect(js.properties.needFrequency!.enum).toEqual(["never", "rarely", "few_per_year", "monthly", "weekly", "daily"]);
    expect(js.required).toContain("needFrequency");
  });

  it("ajoute un palier sous le prix affiché s'il manque", () => {
    expect(studyTiers({ priceEur: 23, extra: { priceTiers: [23, 40] } }, "3")).toEqual([9, 23, 40]);
    expect(studyTiers({ priceEur: 5, extra: { priceTiers: [5, 9] } }, "3")).toEqual([2, 5, 9]);
    expect(studyTiers({ priceEur: 5, extra: { priceTiers: [2, 5, 9] } }, "3")).toEqual([2, 5, 9]);
    expect(studyTiers({ priceEur: 1, extra: { priceTiers: [1, 2] } }, "3")).toEqual([0.4, 1, 2]);
    expect(autoLowTier(60)).toBe(25);
    expect(lowTierOf([2, 5, 9], 5)).toBe(2);
    expect(lowTierOf([8, 15, 23, 40], 23)).toBe(8);
    expect(lowTierOf([5, 9], 5)).toBeNull();
  });

  it("contrôle la cohérence entre la fréquence du besoin et la décision", () => {
    const ctx = { ...coherenceContext(project, [2, 5, 9]), version: "3" as const };
    expect(checkCoherence({ ...answer(), needFrequency: "never" }, ctx)).toEqual([]);
    expect(checkCoherence({ ...answer({ relevance: "concerned" }), needFrequency: "never" }, ctx)).toContain("need_frequency_mismatch");
    expect(checkCoherence({ ...answer({ relevance: "marginal", behavior: "free_signup" }), needFrequency: "never" }, ctx)).toContain("need_frequency_mismatch");
    expect(checkCoherence({ ...answer({ relevance: "marginal", behavior: "visit_page" }), needFrequency: "never" }, ctx)).not.toContain("need_frequency_mismatch");
    expect(checkCoherence({ ...payer(), needFrequency: "monthly" }, ctx)).toEqual([]);
  });

  it("crée les nouvelles études en v3, fige la version, le ton et la fréquence dans les réponses", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 20));
    const p = createProject(db, { ...readProjectFile("examples/meal-planner.json"), priceTiers: [5, 9] });
    const { study } = createStudy(db, pack, { projectId: p.id, n: 3, seed: 7, backend: "ollama", model: "fake" });
    expect(study.protocolVersion).toBe("3");
    const fb = fakeBackend(() => JSON.stringify({ ...answer({ gaborGranger: { at_2_eur: false, at_5_eur: false, at_9_eur: false } }), needFrequency: "few_per_year" }));
    await runStudy(db, new Engine(fb.backend), pack, study);
    expect(fb.requests[0]!.system).toContain(NEED_FREQUENCY_LINE);
    expect(fb.requests[0]!.system).toMatch(/pour chaque palier \(2 €\/mois, 5 €\/mois, 9 €\/mois\)/);
    const payload = studyResponses(db, study.id, QUESTION_KEY)[0]!.payload as ConceptPricePayload;
    expect(payload.protocolVersion).toBe("3");
    expect(payload.tiers).toEqual([2, 5, 9]);
    expect(payload.answer.needFrequency).toBe("few_per_year");
    expect(payload.pitchTone).toMatchObject({ threshold: 25, neutralized: false });
    expect(payload.pitchTone!.score).toBeLessThan(25);
    sqlite.close();
  });
});

describe("double mesure du paiement (M1, M2)", () => {
  it("M2 non calibrée : G lissé, intervalle large, confiance faible", () => {
    const cal = loadCalibration();
    expect(cal.status).toBe("uncalibrated");
    expect(cal.params).toEqual({ a: 0, b: 1, c: 0 });
    const m = paymentMeasure({ n: 20, payers: 0, shown: 23, tiers: [{ price: 8, yes: 1 }, { price: 23, yes: 0 }, { price: 40, yes: 0 }], unit: "month", shownEur: 23, recurringShare: 0.3, protocolVersion: "3" }, cal);
    expect(m.observed).toBe(0);
    expect(m.lowTierYes).toEqual({ price: 8, yes: 1, n: 20, share: 0.05 });
    expect(m.estimated!.value).toBeCloseTo(smoothShare(1, 20), 10);
    expect(m.estimated!.ci[0]).toBeLessThan(0.005);
    expect(m.estimated!.ci[1]).toBeGreaterThan(0.3);
    expect(m.estimated!.confidence).toBe("low");
    expect(m.estimated!.calibration).toEqual({ status: "uncalibrated", version: "payment-v3/0", fittedOn: [] });
  });

  it("M2 lisse G = 0 et prend le palier sous le prix le plus proche de 0,4 × le prix", () => {
    const m = paymentMeasure({ n: 20, payers: 0, shown: 9, tiers: [{ price: 2, yes: 3 }, { price: 5, yes: 0 }, { price: 9, yes: 0 }], unit: "month", shownEur: 9, recurringShare: null, protocolVersion: "3" }, DEFAULT_CALIBRATION);
    expect(m.lowTierYes!.price).toBe(5);
    expect(m.estimated!.value).toBeCloseTo(0.5 / 21, 10);
    const none = paymentMeasure({ n: 20, payers: 0, shown: 5, tiers: [{ price: 5, yes: 0 }, { price: 9, yes: 0 }], unit: "month", shownEur: 5, recurringShare: null, protocolVersion: "2" }, DEFAULT_CALIBRATION);
    expect(none.lowTierYes).toBeNull();
    expect(none.estimated).toBeNull();
  });

  it("M2 calibrée : confiance selon le domaine et l'erreur leave-one-out", () => {
    const cal: PaymentCalibration = {
      ...DEFAULT_CALIBRATION,
      status: "calibrated",
      version: "payment-v3/1",
      params: { a: -1, b: 0.8, c: 0 },
      uncertainty: { logitHalfWidth: 0.7 },
      domain: { units: ["month"], priceEur: [3, 25], recurringShare: [0.1, 0.8] },
      looErrorFactor: 1.6,
      fittedOn: [{ product: "ChatGPT", studyId: "st-a", realPayShare: 0.09, lowTierYes: 0.2, n: 100 }],
    };
    const base = { n: 100, payers: 0, shown: 23, tiers: [{ price: 8, yes: 20 }], unit: "month", shownEur: 23, recurringShare: 0.4, protocolVersion: "3" };
    const hi = paymentMeasure(base, cal);
    expect(hi.estimated!.confidence).toBe("high");
    expect(hi.estimated!.value).toBeCloseTo(1 / (1 + Math.exp(-(-1 + 0.8 * Math.log(smoothShare(20, 100) / (1 - smoothShare(20, 100)))))), 10);
    expect(paymentMeasure({ ...base, shownEur: 40 }, cal).estimated!.confidence).toBe("medium");
    expect(paymentMeasure({ ...base, unit: "one_time" }, cal).estimated!.confidence).toBe("low");
    expect(paymentMeasure({ ...base, protocolVersion: "2" }, cal).estimated!.confidence).toBe("low");
  });
});

describe("indice de confiance", () => {
  const pitch = { score: 4, threshold: 25, neutralized: true, measuredOn: "responses" as const };
  it("avertit sous n = 100 sans passe répétée, sans bloquer", () => {
    const c = confidenceIndex({ protocolVersion: "3", group: "target", n: 20, repeats: [], calibration: DEFAULT_CALIBRATION, pitch });
    expect(c.level).toBe("low");
    expect(c.score).toBe(1);
    expect(c.sample.warning).toMatch(/n = 20 < 100 sans passe répétée/);
    expect(c.sample.retestNoisePts).toBe(15);
    expect(c.protocol.calibrated).toBe(false);
    expect(c.caveats.join(" ")).toMatch(/non calibrée/);
    const rep = confidenceIndex({ protocolVersion: "3", group: "target", n: 20, repeats: ["st-x"], calibration: DEFAULT_CALIBRATION, pitch });
    expect(rep.sample.warning).toBeNull();
    expect(rep.level).toBe("medium");
    const unknown = confidenceIndex({ protocolVersion: "3", group: null, n: 20, repeats: null, calibration: DEFAULT_CALIBRATION, pitch });
    expect(unknown.sample.warning).toMatch(/passe répétée connue/);
  });
  it("signale un pitch commercial et un protocole v2", () => {
    const c = confidenceIndex({ protocolVersion: "2", group: null, n: 200, repeats: [], calibration: DEFAULT_CALIBRATION, pitch: { score: 60, threshold: 25, neutralized: false, measuredOn: "current_project" } });
    expect(c.pitch.ok).toBe(false);
    expect(c.score).toBe(1);
    expect(c.caveats.join(" ")).toMatch(/ton commercial.*Protocole v2|Protocole v2.*ton commercial/s);
  });
});

describe("résumé et comparaison v3", () => {
  const personas = makePersonas(10);
  const byId = new Map(personas.map((p) => [p.id, p]));
  const study = (id: string, v: string) =>
    ({ id, name: id, backend: "ollama", model: "f", protocol: "concept-price", protocolVersion: v, personaIds: personas.map((p) => p.id), personaGroups: {}, populations: [], status: "completed" }) as unknown as Study;
  const FREQ = ["never", "rarely", "rarely", "few_per_year", "few_per_year", "monthly", "monthly", "weekly", "daily", "never"] as const;
  const rows = (sid: string, v: "2" | "3"): ResponseRow[] =>
    personas.map((p, i) => {
      const gg = { at_2_eur: i < 2, at_5_eur: false, at_9_eur: false };
      const payload: ConceptPricePayload = {
        answer: { ...answer({ gaborGranger: gg }), ...(v === "3" ? { needFrequency: FREQ[i] } : {}) },
        encounter: "article",
        tiers: [2, 5, 9],
        priceShown: 5,
        initialAnomalies: [],
        ...(v === "3" && { protocolVersion: "3" as const, pitchTone: { score: 3, threshold: 25, neutralized: true } }),
      };
      return { id: `${sid}-${i}`, studyId: sid, personaId: p.id, questionKey: "concept_price", payload, rawText: null, backend: "ollama", model: "f", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: null, durationMs: 1, attempts: 1, narrativeUsed: true, repaired: false, anomalies: [], createdAt: "" };
    });
  const s3 = summarize(pack, study("st-v3", "3"), project, rows("st-v3", "3"), byId, undefined, { repeats: [] });
  const s2 = summarize(pack, study("st-v2", "2"), project, rows("st-v2", "2"), byId);

  it("porte M1 et M2 avec leur statut, la fréquence agrégée et l'indice de confiance", () => {
    expect(s3.protocolVersion).toBe("3");
    expect(s3.payment).toMatchObject({ group: null, observed: 0, lowTierYes: { price: 2, yes: 2, n: 10, share: 0.2 } });
    expect(s3.payment!.estimated).toMatchObject({ confidence: "low", calibration: { status: "uncalibrated" } });
    expect(s3.overall.payment).toEqual({ observed: s3.payment!.observed, lowTierYes: s3.payment!.lowTierYes, estimated: s3.payment!.estimated });
    expect(s3.needFrequency).toMatchObject({ group: null, n: 10, recurringShare: 0.4, rareShare: 0.4, diagnostic: null });
    expect(s3.needFrequency!.counts).toEqual({ never: 2, rarely: 2, few_per_year: 2, monthly: 2, weekly: 1, daily: 1 });
    expect(s3.overall.behaviors.bySegment.needFrequency!.map((r) => r.code)).toEqual(["never", "rarely", "few_per_year", "monthly", "weekly", "daily"]);
    expect(s3.confidence).toMatchObject({ level: "low", sample: { n: 10, repeats: [] }, pitch: { score: 3, measuredOn: "responses", ok: true } });
    const text = formatSummary(s3);
    expect(text).toMatch(/paiement observé dans les 7 jours : 0 % ; oui à 2 € : 20 % ; part payante estimée : \d+(,\d+)? % \[.+\], non calibrée, confiance faible/);
    expect(text).toContain("Fréquence du besoin");
    expect(text).toContain("Indice de confiance des niveaux absolus : faible");
  });

  it("étude v2 : M1 et M2 sans fréquence ; ajouts seulement", () => {
    expect(s2.protocolVersion).toBe("2");
    expect(s2.needFrequency).toBeUndefined();
    expect(s2.overall.needFrequency).toBeUndefined();
    expect(s2.payment!.estimated!.calibration.status).toBe("uncalibrated");
    expect(s2.confidence!.pitch.measuredOn).toBe("current_project");
    expect(s2.confidence!.sample.repeats).toBeNull();
  });

  it("compare M1, G et M2 entre variantes, et signale des versions différentes", () => {
    const c = compareSummaries([s2, s3]);
    expect(c.protocolsDiffer).toBe(true);
    expect(c.entries[1]!.payment!.estimated!.calibration.status).toBe("uncalibrated");
    expect(c.entries[1]!.confidence).toMatchObject({ level: "low" });
    expect(c.deltas[1]!.lowTierYes).toBe(0);
    expect(c.deltas[1]!.paymentEstimated).toBe(0);
    const text = formatComparison(c);
    expect(text).toContain("Part payante estimée (M2)");
    expect(text).toContain("non calibrée, faible");
    expect(text).toContain("Versions de protocole différentes");
    expect(compareSummaries([s3, s3]).protocolsDiffer).toBeUndefined();
  });
});

describe("ajustement de la conversion (calibration:fit)", () => {
  const pt = (product: string, yes: number, real: number) => ({ product, studyId: `st-${product}`, realPayShare: real, yes, n: 100, shown: 20, lowTier: 8, unit: "month", shownEur: 20, recurringShare: 0.3 });
  it("ajuste a et b (c = 0 sous 5 produits), avec leave-one-out et bootstrap", async () => {
    const { fitCalibration } = await import("../../src/studies/calibration-fit");
    const r = fitCalibration([pt("A", 20, 0.09), pt("B", 5, 0.015), pt("C", 2, 0.002)], { version: "payment-v3/1", date: "2026-10-15", bootstrap: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.calibration.status).toBe("calibrated");
    expect(r.calibration.params.b).toBeGreaterThan(0);
    expect(r.calibration.params.c).toBe(0);
    expect(r.calibration.looErrorFactor).toBeGreaterThan(1);
    expect(r.calibration.uncertainty.logitHalfWidth).toBeGreaterThan(0);
    expect(r.calibration.domain).toEqual({ units: ["month"], priceEur: [20, 20], recurringShare: [0.3, 0.3] });
    expect(r.calibration.fittedOn.map((f) => f.product)).toEqual(["A", "B", "C"]);
  });
  it("refuse sous 3 produits, ou si la relation n'est pas croissante", async () => {
    const { fitCalibration } = await import("../../src/studies/calibration-fit");
    expect(fitCalibration([pt("A", 20, 0.09)], { version: "v", date: "d" }).ok).toBe(false);
    const dec = fitCalibration([pt("A", 20, 0.001), pt("B", 5, 0.02), pt("C", 2, 0.09)], { version: "v", date: "d", bootstrap: 50 });
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.reason).toMatch(/aucune fonction croissante/);
  });
});
