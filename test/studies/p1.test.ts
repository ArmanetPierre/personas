import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb, runMigrations } from "../../src/db/client";
import type { Persona, Project, ResponseRow, Study } from "../../src/db/schema";
import { Engine } from "../../src/engine/engine";
import { insertPersonas } from "../../src/personas/store";
import { drawPersonas } from "../../src/personas/sampler";
import { compareSummaries, formatComparison } from "../../src/studies/compare";
import { benjaminiHochberg, chiSquare, computeDrivers, cramersVCorrected, numericBins, type Dimension } from "../../src/studies/drivers";
import { createProject, readProjectFile } from "../../src/studies/project";
import { answerSchemaFor, buildSystemPrompt, checkCoherence, QUESTION_KEY, type ConceptPriceAnswer } from "../../src/studies/protocols/concept-price";
import { DEFAULT_BEHAVIORS, LEGACY_PROTOCOL, projectProtocolSchema, resolveProtocol, resolveProtocolSpec, type ProjectProtocol } from "../../src/studies/protocols/protocol";
import { buildSuggestPrompt, suggestProtocol } from "../../src/studies/protocol-suggest";
import { readTaxonomy, recodedDistribution, recodeStudy } from "../../src/studies/recode";
import { runStudy, type ConceptPricePayload } from "../../src/studies/run";
import { studyResponses } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { formatSummary, summarize } from "../../src/studies/summary";
import { answer, fakeBackend, makePersonas, pack, payer, project } from "./fixtures";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_PROTOCOL: ProjectProtocol = {
  productType: "app_install",
  objections: [
    { code: "no_need", label: "Pas de besoin", description: "pas assez de réunions", canonical: "no_need" },
    { code: "already_covered", label: "Déjà couvert", description: "Teams ou la visio le font déjà", canonical: "already_covered" },
    { code: "employer_it", label: "Politique IT", description: "Mac de l'employeur, accord de la DSI", canonical: "trust_privacy" },
    { code: "recording_consent", label: "Consentement", description: "accord des personnes enregistrées", canonical: "trust_privacy" },
    { code: "price", label: "Prix", description: "trop cher", canonical: "price" },
    { code: "other", label: "Autre", description: "autre", canonical: "other" },
  ],
  relevance: [
    { code: "heavy", label: "Besoin fréquent", description: "plusieurs réunions par semaine", canonical: "concerned" },
    { code: "occasional", label: "Besoin occasionnel", description: "quelques réunions par mois", canonical: "marginal" },
    { code: "none", label: "Pas de besoin", description: "aucune réunion", canonical: "not_concerned" },
  ],
};
const custom: Project = { ...project, id: "app-test", extra: { ...(project.extra as object), protocol: APP_PROTOCOL } };
const ctx = { tiers: [2, 5, 9], projectPrice: 5 };
const vA = (over: Partial<ConceptPriceAnswer>): ConceptPriceAnswer => answer({ relevance: "none", objections: [{ category: "no_need", detail: "Pas de réunions." }], ...over });

describe("protocole adaptable : identité sans bloc protocol", () => {
  it("résout le protocole historique et garde le schéma de réponse", () => {
    expect(resolveProtocol(project).custom).toBe(false);
    const legacy = z.toJSONSchema(answerSchemaFor([2, 5, 9]));
    expect(z.toJSONSchema(answerSchemaFor([2, 5, 9], LEGACY_PROTOCOL))).toEqual(legacy);
    expect(JSON.stringify(legacy)).toContain('"pay_subscription"');
  });

  it("ne change ni les contrôles historiques ni le résumé (aucun champ de protocole)", () => {
    const personas = makePersonas(6);
    const rows = personas.map((p, i) => row(p, i < 2 ? payer() : answer()));
    const s = summarize(pack, studyOf(personas), project, rows, new Map(personas.map((p) => [p.id, p])));
    expect(s.protocol).toBeUndefined();
    expect(s.overall.behaviors.levels).toBeUndefined();
    expect(Object.keys(s.overall.behaviors.overall.counts)).toEqual(["ignore", "save_for_later", "visit_page", "free_signup", "free_active", "pay_subscription", "recommend"]);
    expect(s.overall.behaviors.payers).toBeCloseTo(2 / 6);
    expect(checkCoherence({ ...payer(), gaborGranger: { at_2_eur: true, at_5_eur: false, at_9_eur: false } }, ctx)).toContain("pay_without_gg");
  });
});

describe("protocole adaptable : échelle et taxonomie du projet", () => {
  const proto = resolveProtocol(custom);

  it("valide le bloc et refuse les échelles incohérentes", () => {
    expect(projectProtocolSchema.safeParse(APP_PROTOCOL).success).toBe(true);
    const bad = DEFAULT_BEHAVIORS.app_install.filter((b) => b.level !== "payment");
    expect(projectProtocolSchema.safeParse({ behaviors: bad }).success).toBe(false);
    expect(projectProtocolSchema.safeParse({ behaviors: [...DEFAULT_BEHAVIORS.app_install].reverse() }).success).toBe(false);
    expect(projectProtocolSchema.safeParse({ objections: APP_PROTOCOL.objections!.filter((o) => o.code !== "no_need") }).success).toBe(false);
    const file = readProjectFile("examples/meal-planner.json");
    expect(file.protocol).toBeUndefined();
  });

  it("donne l'échelle par défaut du type de produit, avec ses niveaux canoniques", () => {
    expect(proto.custom).toBe(true);
    expect(proto.behaviors.map((b) => b.code)).toEqual(["ignore", "save_for_later", "visit_page", "download_install", "try_free", "buy", "recommend"]);
    expect(proto.behaviors.map((b) => b.level)).toEqual(["inaction", "inaction", "interest", "free_trial", "free_trial", "payment", "recommendation"]);
    expect(resolveProtocolSpec({ productType: "online_service" }).behaviors.map((b) => b.code)).toEqual(LEGACY_PROTOCOL.behaviors.map((b) => b.code));
  });

  it("met l'échelle, la taxonomie et la pertinence du projet dans le prompt", () => {
    const sys = buildSystemPrompt(custom, [2, 5, 9]);
    expect(sys).toContain('"download_install" : tu télécharges et installes l\'app');
    expect(sys).toContain('"buy" : tu paies au prix affiché (5 €/mois)');
    expect(sys).toContain('"employer_it" (Mac de l\'employeur, accord de la DSI)');
    expect(sys).toContain('souvent juste "no_need"');
    expect(sys).toContain('"heavy" si plusieurs réunions par semaine');
    expect(sys).not.toContain('"network_effect"');
    expect(sys).not.toContain('"pay_subscription"');
    const schema = answerSchemaFor([2, 5, 9], proto);
    expect(schema.safeParse(vA({ behavior: "buy" })).success).toBe(true);
    expect(schema.safeParse(answer()).success).toBe(false); // codes historiques refusés
  });

  it("applique les contrôles par niveau canonique", () => {
    const c = { ...ctx, protocol: proto };
    const buy = vA({ behavior: "buy", relevance: "heavy", objections: [], gaborGranger: { at_2_eur: true, at_5_eur: false, at_9_eur: false }, budgetFit: "Sur mon budget sorties." , vanWestendorp: { wouldNeverPay: false, tooCheapEur: 1, cheapEur: 2, expensiveEur: 4, tooExpensiveEur: 8 } });
    expect(checkCoherence(buy, c)).toContain("pay_without_gg");
    expect(checkCoherence(vA({ behavior: "save_for_later", objections: [] }), c)).toContain("ignore_without_objection");
    expect(checkCoherence(vA({ behavior: "try_free" }), c)).toContain("not_concerned_but_engaged");
    expect(checkCoherence(vA({ behavior: "recommend", relevance: "heavy", wouldForward: false, gaborGranger: { at_2_eur: true, at_5_eur: true, at_9_eur: false }, budgetFit: "Mon budget le permet sans peine.", vanWestendorp: { wouldNeverPay: false, tooCheapEur: 1, cheapEur: 3, expensiveEur: 8, tooExpensiveEur: 15 } }), c)).toContain("recommend_without_forward");
    expect(checkCoherence(vA({}), c)).toEqual([]);
  });

  it("résume avec l'échelle du projet et compare par niveaux canoniques", () => {
    const personas = makePersonas(10);
    const byId = new Map(personas.map((p) => [p.id, p]));
    const rowsC = personas.map((p, i) => row(p, vA(i < 3 ? { behavior: "download_install", relevance: "heavy", objections: [{ category: "employer_it", detail: "Mac de la boîte" }] } : {}), proto));
    const sC = summarize(pack, studyOf(personas, "st-c"), custom, rowsC, byId);
    expect(sC.protocol?.signature).toBe(proto.signature);
    expect(sC.overall.behaviors.overall.counts.download_install).toBe(3);
    expect(sC.overall.behaviors.freeSignupOrMore).toBeCloseTo(0.3);
    expect(sC.overall.behaviors.levels!.shares.free_trial).toBeCloseTo(0.3);
    expect(sC.overall.relevance.notConcernedShare).toBeCloseTo(0.7);
    expect(sC.overall.objections.canonical!.shares.trust_privacy).toBeCloseTo(0.3);
    const text = formatSummary(sC);
    expect(text).toContain("Télécharge et installe");
    expect(text).toContain("Politique IT");
    // Le protocole figé dans les réponses prime sur celui du projet (projet modifié après coup)
    expect(summarize(pack, studyOf(personas, "st-c"), project, rowsC, byId).protocol?.signature).toBe(proto.signature);

    const rowsL = personas.map((p, i) => row(p, i < 1 ? answer({ behavior: "free_signup", relevance: "concerned" }) : answer()));
    const sL = summarize(pack, studyOf(personas, "st-l"), project, rowsL, byId);
    const c = compareSummaries([sL, sC]);
    expect(c.scalesDiffer).toBe(true);
    expect(c.entries[0]!.levels!.free_trial).toBeCloseTo(0.1);
    expect(c.deltas[1]!.levels!.free_trial).toBe(20);
    expect(c.deltas[1]!.freeSignupOrMore).toBe(20);
    expect(c.deltas[1]!.objectionsCanonical!.trust_privacy).toBe(30);
    expect(formatComparison(c)).toMatch(/comparaison par niveau canonique/);
    // Mêmes échelles : pas de champ ajouté
    expect(compareSummaries([sL, sL]).scalesDiffer).toBeUndefined();
  });

  it("refuse de reprendre une étude si le protocole du projet a changé", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 10));
    const p = createProject(db, readProjectFile("examples/meal-planner.json"));
    const { study } = createStudy(db, pack, { projectId: p.id, n: 4, seed: 7, backend: "ollama", model: "fake" });
    let calls = 0;
    const fb = fakeBackend(() => {
      if (++calls > 2) throw new Error("coupure");
      return JSON.stringify(answer());
    }, 1);
    await runStudy(db, new Engine(fb.backend), pack, study, { maxConsecutiveFailures: 1 });
    db.$client.prepare("update projects set extra = json_set(extra, '$.protocol', json(?)) where id = ?").run(JSON.stringify(APP_PROTOCOL), p.id);
    await expect(runStudy(db, new Engine(fakeBackend(() => JSON.stringify(vA({}))).backend), pack, study)).rejects.toThrow(/protocole du projet a changé/);
    sqlite.close();
  });
});

describe("analyse des facteurs", () => {
  it("calcule khi-deux, V corrigé, BH et tranches sur des données connues", () => {
    // 2 catégories × 2 : 20/20 vs 0/20
    const cats = [...Array(40)].map((_, i) => (i < 20 ? 0 : 1));
    const y = [...Array(40)].map((_, i) => (i < 20 ? 1 : 0));
    expect(chiSquare(cats, y, 2)).toBeCloseTo(40);
    expect(cramersVCorrected(40, 40, 2)).toBeGreaterThan(0.95);
    expect(cramersVCorrected(0.5, 40, 2)).toBe(0);
    expect(benjaminiHochberg([0.01, 0.04, 0.03])).toEqual([0.03, 0.04, 0.04]);
    const b = numericBins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(b.order).toEqual(["b1", "b2", "b3"]);
    expect(b.codeOf(1)).toBe("b1");
    expect(b.codeOf(12)).toBe("b3");
    expect(numericBins([0, 1, 1, 2]).order).toEqual(["v0", "v1", "v2"]);
  });

  it("classe en tête l'attribut qui détermine l'engagement, pas le bruit", () => {
    const personas = makePersonas(120);
    const mac = (p: Persona) => (personas.indexOf(p) % 3 === 0 ? "employer" : "own");
    const noise = (p: Persona) => (Math.floor(personas.indexOf(p) / 10) % 2 ? "a" : "b");
    const dims: Dimension[] = [
      { id: "noise", label: "Bruit", source: "module", codeOf: noise, labelOf: (c) => c },
      { id: "mac", label: "Mac fourni par l'employeur", source: "module", codeOf: mac, labelOf: (c) => (c === "employer" ? "oui" : "non") },
    ];
    // Intérêt : 10 % des Mac d'employeur contre 50 % des autres (déterministe)
    const rows = personas.map((p, i) => ({ persona: p, level: (mac(p) === "employer" ? i % 30 === 0 : i % 2 === 0) ? ("interest" as const) : ("inaction" as const) }));
    const d = computeDrivers(rows, dims, { permutations: 199, seed: "t" });
    const interest = d.outcomes.find((o) => o.level === "interest")!;
    expect(interest.factors[0]!.dimension).toBe("mac");
    expect(interest.factors[0]!.p).toBeLessThan(0.02);
    expect(interest.factors[0]!.sentence).toMatch(/^Mac fourni par l'employeur = (oui|non) : intérêt \d+ % contre \d+ % sinon \(n = \d+ \/ \d+\)/);
    expect(interest.factors.find((f) => f.dimension === "noise")!.p).toBeGreaterThan(0.05);
    expect(d.outcomes.find((o) => o.level === "payment")!.note).toMatch(/trop peu de cas/);
  });

  it("ajoute segments automatiques et facteurs au résumé, sans toucher au reste", () => {
    const personas = makePersonas(30);
    const rows = personas.map((p, i) => row(p, i % 3 === 0 ? answer({ behavior: "visit_page" }) : answer()));
    const s = summarize(pack, studyOf(personas), project, rows, new Map(personas.map((p) => [p.id, p])));
    expect(s.overall.behaviors.bySegment.sex).toBeDefined();
    expect(s.overall.autoDimensions!.map((d) => d.id)).toContain("sex");
    expect(s.drivers!.outcomes[0]!.level).toBe("interest");
    expect(formatSummary(s)).toMatch(/Facteurs d'engagement/);
  });
});

describe("recatégorisation a posteriori", () => {
  it("reclasse par lots sans écraser l'original, et reprend ce qui manque", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 10));
    const p = createProject(db, readProjectFile("examples/meal-planner.json"));
    const { study } = createStudy(db, pack, { projectId: p.id, n: 5, seed: 7, backend: "ollama", model: "fake" });
    const two = answer({ objections: [{ category: "trust_privacy", detail: "Mon Mac est géré par la DSI" }, { category: "other", detail: "Il faut l'accord des participants" }] });
    await runStudy(db, new Engine(fakeBackend(() => JSON.stringify(two)).backend), pack, study);
    const dir = mkdtempSync(join(tmpdir(), "tax-"));
    const file = join(dir, "app-protocol.json");
    writeFileSync(file, JSON.stringify({ protocol: APP_PROTOCOL }));
    const tax = readTaxonomy(file);
    expect(tax.key).toBe("app");
    const fb = fakeBackend((req) => {
      const items = JSON.parse(req.messages[0]!.content) as Array<{ id: string; detail: string }>;
      return JSON.stringify({ items: items.map((it) => ({ id: it.id, code: /DSI/.test(it.detail) ? "employer_it" : "recording_consent" })) });
    }, 1);
    const r = await recodeStudy(db, new Engine(fb.backend), study, tax, { batchSize: 4 });
    expect(r.objections).toBe(10);
    expect(r.calls).toBe(3);
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    const pl = rows[0]!.payload as ConceptPricePayload;
    expect(pl.recoded!.app!.codes).toEqual(["employer_it", "recording_consent"]);
    expect(pl.answer.objections[0]!.category).toBe("trust_privacy"); // original intact
    const d = recodedDistribution(rows, tax)!;
    expect(d.shares.employer_it).toBe(1);
    expect(d.crosstab.trust_privacy!.employer_it).toBe(5);
    expect(d.canonical.trust_privacy).toBe(1);
    const again = await recodeStudy(db, new Engine(fb.backend), study, tax);
    expect(again.objections).toBe(0);
    sqlite.close();
  });
});

describe("proposition de protocole", () => {
  it("construit le prompt avec les objections existantes et valide la réponse", async () => {
    const ev = { studies: ["st-x"], respondents: 10, shares: { other: 0.2, trust_privacy: 0.5 }, samples: { other: ["Mac de la boîte"], trust_privacy: ["Les clients doivent accepter"] } };
    const { user } = buildSuggestPrompt(custom, ev);
    expect(user).toContain("trust_privacy 50 %");
    expect(user).toContain("Mac de la boîte");
    const good = { ...APP_PROTOCOL, behaviors: DEFAULT_BEHAVIORS.app_install.map((b) => ({ ...b, short: b.short ?? "x" })), objections: APP_PROTOCOL.objections!.map((o) => ({ ...o, short: o.code.slice(0, 8) })), rationale: "Parce que." };
    const r = await suggestProtocol(new Engine(fakeBackend(() => JSON.stringify({ ...good, behaviors: good.behaviors.map((b) => (b.code === "buy" ? { ...b, code: "Achète Pro" } : b)) })).backend), custom, ev);
    expect(r.protocol.behaviors!.some((b) => b.code === "achete_pro")).toBe(true);
    expect(r.fixes[0]).toMatch(/Achète Pro/);
    const noPay = { ...good, behaviors: good.behaviors.filter((b) => b.level !== "payment") };
    await expect(suggestProtocol(new Engine(fakeBackend(() => JSON.stringify(noPay)).backend), custom, ev)).rejects.toThrow(/payment/);
  });
});

// ─── aides ────────────────────────────────────────────────────────────────────
function studyOf(personas: Persona[], id = "st-t"): Study {
  return { id, name: id, backend: "ollama", model: "f", protocol: "concept-price", protocolVersion: "2", personaIds: personas.map((p) => p.id), personaGroups: {}, populations: [], status: "completed" } as unknown as Study;
}
function row(p: Persona, a: ConceptPriceAnswer, protocol?: ReturnType<typeof resolveProtocol>): ResponseRow {
  const payload: ConceptPricePayload = { answer: a, encounter: "article", tiers: [2, 5, 9], priceShown: 5, initialAnomalies: [], ...(protocol?.custom && { protocol }) };
  return { id: p.id, studyId: "st", personaId: p.id, questionKey: "concept_price", payload, rawText: null, backend: "ollama", model: "f", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: null, durationMs: 1, attempts: 1, narrativeUsed: true, repaired: false, anomalies: [], createdAt: "" };
}
