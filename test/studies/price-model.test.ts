import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ResponseRow, Study } from "../../src/db/schema";
import { compareBehaviorLabel, compareSummaries, formatComparison, monthlyEurFactorOf } from "../../src/studies/compare";
import {
  formatMoney,
  formatOfferAmount,
  formatPricing,
  legacyOffer,
  monthlyEurEquivalent,
  pricingOf,
  pricingSchema,
  referenceOffer,
} from "../../src/studies/price-model";
import { priceColumns, priceTiersFor, projectFileSchema, readProjectFile } from "../../src/studies/project";
import {
  BEHAVIOR_LABELS,
  behaviorLabelsFor,
  buildSystemPrompt,
  checkCoherence,
  coherenceContext,
  priceIssueDetails,
  type ConceptPriceAnswer,
} from "../../src/studies/protocols/concept-price";
import type { ConceptPricePayload } from "../../src/studies/run";
import { formatSummary, summarize } from "../../src/studies/summary";
import { answer, makePersonas, pack } from "./fixtures";
import { PRICE_EXAMPLES, projectFrom } from "./project-helpers";

const fixture = (name: string) => readFileSync(`test/studies/__fixtures__/${name}`, "utf8");
const fish = () => projectFrom("examples/pricing/fresh-catch-per-kg.yaml");
const team = () => projectFrom("examples/pricing/team-schedule-usd.yaml");
const photo = () => projectFrom("examples/pricing/photo-editor-one-time.yaml");

describe("schéma de prix", () => {
  it("accepte toujours la forme historique { amountEur, period }", () => {
    const f = readProjectFile("examples/meal-planner.json");
    const cols = priceColumns(f);
    expect(cols).toMatchObject({ priceEur: 5, pricePeriod: "month", extra: { priceTiers: [2, 5, 9] } });
    expect(cols.extra.pricing).toBeUndefined();
    const v3 = priceColumns(readProjectFile("examples/variants/meal-planner-dietitian-booking.json"));
    expect(v3).toMatchObject({ priceEur: 15, pricePeriod: "connection" });
  });

  it("lit les 4 exemples génériques et place l'offre de référence dans les colonnes historiques", () => {
    for (const ex of PRICE_EXAMPLES) expect(() => readProjectFile(`examples/pricing/${ex}.yaml`)).not.toThrow();
    const cols = priceColumns(readProjectFile("examples/pricing/team-schedule-usd.yaml"));
    expect(cols).toMatchObject({ priceEur: 9.99, pricePeriod: "month", extra: { priceTiers: [4.99, 9.99, 14.99] } });
    expect(cols.extra.pricing).toMatchObject({ currency: "USD", reference: "mensuel" });
    expect(cols.freeOffer).toMatch(/2 équipes/);
    expect(priceTiersFor(fish())).toEqual([18, 24, 32]);
  });

  it("reconstruit un modèle depuis les colonnes historiques", () => {
    expect(legacyOffer(15, "connection")).toEqual({ id: "main", amount: 15, unit: "usage", usageLabel: "mise en relation" });
    expect(legacyOffer(29, "once").unit).toBe("one_time");
    const p = pricingOf({ priceEur: 5, pricePeriod: "month", extra: { priceTiers: [2, 5, 9] }, freeOffer: null })!;
    expect(p).toMatchObject({ currency: "EUR", reference: "main", tiers: [2, 5, 9] });
  });

  it("refuse les cas invalides", () => {
    const base = { currency: "EUR", offers: [{ id: "m", amount: 5, unit: "month" }] };
    expect(pricingSchema.safeParse(base).success).toBe(true);
    expect(pricingSchema.safeParse({ ...base, reference: "absente" }).success).toBe(false);
    expect(pricingSchema.safeParse({ offers: [{ id: "u", amount: 2, unit: "usage" }] }).success).toBe(false);
    expect(pricingSchema.safeParse({ offers: [{ id: "q", amount: 2, unit: "quantity" }] }).success).toBe(false);
    expect(pricingSchema.safeParse({ currency: "JPY", offers: base.offers }).success).toBe(false);
    expect(pricingSchema.safeParse({ currency: "JPY", offers: base.offers, fx: { eurPerUnit: 0.0061, date: "2026-10-01" } }).success).toBe(true);
    expect(pricingSchema.safeParse({ currency: "eur", offers: base.offers }).success).toBe(false);
    expect(pricingSchema.safeParse({ offers: [...base.offers, ...base.offers] }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...base, tiers: [5] }).success).toBe(false);
    const file = { name: "X", pitch: "Un pitch suffisamment long pour passer.", price: { amountEur: -1, period: "month" } };
    expect(projectFileSchema.safeParse(file).success).toBe(false);
  });
});

describe("formatage des prix", () => {
  it("affiche la devise à la française", () => {
    expect(formatMoney(150, "SGD")).toBe("150 SGD");
    expect(formatMoney(9.99, "USD")).toBe("9,99 $");
    expect(formatMoney(5)).toBe("5 €");
  });

  it("affiche chaque unité et les offres multiples", () => {
    expect(formatPricing(pricingOf(team())!)).toBe("9,99 $/mois ou 99 $/an");
    const g = pricingOf(fish())!;
    expect(formatOfferAmount(24, referenceOffer(g), "SGD")).toBe("24 SGD le kg");
    expect(formatPricing(g)).toContain("; panier minimum de 150 SGD");
    expect(formatPricing(pricingOf(photo())!)).toBe("Lumen Pro : 29 € en achat unique");
    expect(formatOfferAmount(15, { id: "u", amount: 15, unit: "usage", usageLabel: "transcription" })).toBe("15 € par transcription");
  });

  it("calcule un coût mensuel équivalent en euros quand il a un sens", () => {
    const h = pricingOf(team())!;
    expect(monthlyEurEquivalent(h, h.offers[1]!, 99)).toBeCloseTo((99 * 0.92) / 12);
    const g = pricingOf(fish())!;
    expect(monthlyEurEquivalent(g, referenceOffer(g), 24)).toBeCloseTo(24 * 0.69 * 10);
    const v = pricingOf(photo())!;
    expect(monthlyEurEquivalent(v, referenceOffer(v), 29)).toBeNull();
  });
});

describe("prompt par modèle de prix", () => {
  it("garde un instantané par nouveau cas", () => {
    for (const ex of PRICE_EXAMPLES) {
      const p = projectFrom(`examples/pricing/${ex}.yaml`);
      expect(buildSystemPrompt(p, priceTiersFor(p))).toBe(fixture(`pricing-${ex}-system-prompt.txt`));
    }
  });

  it("présente le prix, l'équivalence en euros et les questions dans l'unité de référence", () => {
    const g = buildSystemPrompt(fish(), [18, 24, 32]);
    expect(g).toContain("24 SGD le kg");
    expect(g).toContain("panier minimum de 150 SGD");
    expect(g).toMatch(/1 SGD ≈ 0,69 € \(taux fixe du 2026-10-01\)/);
    expect(g).toContain("Fréquence d'achat attendue");
    expect(g).toContain("prix en SGD par kg");
    expect(g).toContain("(18 SGD le kg, 24 SGD le kg, 32 SGD le kg)");
    const h = buildSystemPrompt(team(), [4.99, 9.99, 14.99]);
    expect(h).toContain("Prix affiché : 9,99 $/mois ou 99 $/an");
    expect(h).toContain("99 $/an ≈ 91 €/an, soit ≈ 7,59 €/mois");
    expect(h).toContain("portent sur l'offre de référence : 9,99 $/mois");
    expect(h).toContain("Ce qui est payant : Premium Équipe");
    const v = buildSystemPrompt(photo(), [15, 29, 49]);
    expect(v).toContain("prix en € en achat unique");
    expect(v).toContain("true si tu achèterais vraiment à ce prix dans le mois qui vient");
    expect(v).not.toMatch(/budget en euros/);
  });
});

describe("contrôles de cohérence adaptés à l'unité et à la devise", () => {
  const vwOk = { wouldNeverPay: false, tooCheapEur: 10, cheapEur: 18, expensiveEur: 30, tooExpensiveEur: 45 };
  const pays = (over: Partial<ConceptPriceAnswer> = {}) =>
    answer({ relevance: "concerned", behavior: "pay_subscription", objections: [], vanWestendorp: vwOk, gaborGranger: { at_18_eur: true, at_24_eur: true, at_32_eur: false }, budgetFit: "Je prends sur mon budget sorties.", ...over });

  it("ne change rien pour un projet historique", () => {
    const ctx = coherenceContext(projectFrom("examples/meal-planner.json"), [2, 5, 9]);
    expect(ctx).toEqual({ tiers: [2, 5, 9], projectPrice: 5 });
  });

  it("signale des prix Van Westendorp dans une autre unité ou devise", () => {
    const ctx = coherenceContext(fish(), [18, 24, 32]);
    expect(checkCoherence(pays(), ctx)).toEqual([]);
    // Réponse en SGD pour tout le panier, pas au kg
    const panier = pays({ vanWestendorp: { wouldNeverPay: false, tooCheapEur: 100, cheapEur: 180, expensiveEur: 300, tooExpensiveEur: 450 }, gaborGranger: { at_18_eur: true, at_24_eur: false, at_32_eur: false }, behavior: "free_signup" });
    const codes = checkCoherence(panier, ctx);
    expect(codes).toContain("vw_unit_scale");
    expect(priceIssueDetails(codes, ctx)[0]).toMatch(/en SGD par kg/);
  });

  it("demande de justifier une commande quand le panier minimum dépasse le reste-à-vivre", () => {
    const ctx = { ...coherenceContext(fish(), [18, 24, 32]), budgetEur: 80 };
    const codes = checkCoherence(pays(), ctx);
    expect(codes).toContain("minimum_over_budget");
    expect(priceIssueDetails(codes, ctx)[0]).toMatch(/150 SGD ≈ 103 €.*80 €/);
    expect(checkCoherence(pays({ budgetFit: "Je partage la commande avec deux voisins du condo, 50 SGD chacun, et je saute un restaurant." }), ctx)).not.toContain("minimum_over_budget");
    expect(checkCoherence(pays(), { ...ctx, budgetEur: 500 })).not.toContain("minimum_over_budget");
  });
});

describe("résumé et comparaison dans l'unité et la devise", () => {
  const personas = makePersonas(10);
  const byId = new Map(personas.map((p) => [p.id, p]));
  const study = (id: string) => ({ id, name: id, backend: "ollama", model: "f", protocol: "concept-price", protocolVersion: "2", personaIds: personas.map((p) => p.id), personaGroups: {}, populations: [], status: "completed" }) as unknown as Study;
  const rows = (sid: string, tiers: number[], yes: (i: number) => boolean[]): ResponseRow[] =>
    personas.map((p, i) => {
      const gg = Object.fromEntries(tiers.map((t, k) => [`at_${String(t).replace(".", "_")}_eur`, yes(i)[k]!]));
      const payload: ConceptPricePayload = { answer: answer({ gaborGranger: gg, vanWestendorp: { wouldNeverPay: false, tooCheapEur: tiers[0]! / 2, cheapEur: tiers[0]!, expensiveEur: tiers[1]!, tooExpensiveEur: tiers[2]! } }), encounter: "article", tiers, priceShown: tiers[1]!, initialAnomalies: [] };
      return { id: `${sid}-${i}`, studyId: sid, personaId: p.id, questionKey: "concept_price", payload, rawText: null, backend: "ollama", model: "f", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: null, durationMs: 1, attempts: 1, narrativeUsed: true, repaired: false, anomalies: [], createdAt: "" };
    });
  const hTiers = [4.99, 9.99, 14.99];
  const sH = summarize(pack, study("st-h"), team(), rows("st-h", hTiers, (i) => [i < 4, i < 2, false]), byId);
  const ref = projectFrom("examples/meal-planner.json");
  const sRef = summarize(pack, study("st-ref"), ref, rows("st-ref", [2, 5, 9], (i) => [i < 3, i < 1, false]), byId);

  it("ajoute la devise et le modèle au résumé d'un projet générique, pas à un projet historique", () => {
    expect(sH.project).toMatchObject({ currency: "USD", price: "9,99 $/mois ou 99 $/an", priceUnit: "mois", referencePrice: "9,99 $/mois", revenueEquivalent: "year" });
    expect(Object.keys(sRef.project)).toEqual(["id", "name", "price", "pricePeriod", "priceUnit"]);
    const text = formatSummary(sH);
    expect(text).toContain("9,99 $     demande  20 %");
    expect(text).toMatch(/revenu attendu 199,8 \$, soit ≈ 2\s398 \$ par an pour 100 personnes exposées/);
    expect(formatSummary(sRef)).not.toMatch(/par an/);
  });

  it("ne compare pas des devises différentes, sauf normalisation demandée et signalée", () => {
    const c = compareSummaries([sRef, sH]);
    expect(c.unitsDiffer).toBe(true); // même unité (mois) mais devises différentes
    expect(c.deltas[1]!.gaborGranger.every((t) => t.demand === null)).toBe(true);
    expect(c.normalization).toBeUndefined();
    expect(formatComparison(c)).toContain("9,99 $ : 20 %");
    expect(monthlyEurFactorOf(sH.project)).toBeCloseTo(0.92);
    const n = compareSummaries([sRef, sH], undefined, { normalize: "monthly-eur" });
    expect(n.normalization!.entries[1]!.gaborGranger[1]).toEqual({ price: 9.99, monthlyEur: 9.19, demand: 0.2 });
    expect(n.normalization!.entries[0]!.factor).toBe(1);
    const text = formatComparison(n);
    expect(text).toMatch(/Normalisation indicative/);
    expect(text).toContain("9,19 € : 20 %");
  });

  it("adapte les libellés des comportements au type de prix, pas pour un abonnement", () => {
    expect(behaviorLabelsFor("month")).toBe(BEHAVIOR_LABELS);
    expect(behaviorLabelsFor("quantity").pay_subscription).toBe("Commanderait");
    expect(behaviorLabelsFor("usage").pay_subscription).toBe("Paierait à l'usage");
    const sV = summarize(pack, study("st-v"), photo(), rows("st-v", [15, 29, 49], () => [false, false, false]), byId);
    expect(sV.project.behaviorLabels?.pay_subscription).toBe("Achèterait");
    expect(formatSummary(sV)).toContain("Achèterait et le recommanderait");
    expect(sH.project.behaviorLabels).toBeUndefined();
    expect(formatSummary(sRef)).toContain("Paierait l'abonnement");
    const c = compareSummaries([sRef, sV]);
    expect(c.entries[0]!.behaviorLabels).toBeUndefined();
    expect(compareBehaviorLabel(c.entries, "pay_subscription")).toBe("Paierait au prix affiché");
    expect(compareBehaviorLabel([c.entries[1]!], "pay_subscription")).toBe("Achèterait");
    expect(compareBehaviorLabel([c.entries[0]!], "pay_subscription")).toBe("Paierait l'abonnement");
  });
});
