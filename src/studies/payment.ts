import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { lowTierOf } from "./protocols/concept-price";

/**
 * Double mesure du paiement (protocole v3, docs/protocol-v3.md § 3).
 *
 * - M1, paiement observé : part des personas au niveau « paiement » ou plus dans l'horizon de 7 jours.
 *   Presque toujours 0 : jamais affiché seul.
 * - M2, part payante estimée : conversion de G, la part de « oui » au palier Gabor-Granger bas p_b
 *   (le plus haut palier sous le prix affiché P) :
 *
 *     logit(M2) = a + b · logit(G') + c · log(P / p_b),   G' = (n·G + 0,5) / (n + 1)
 *
 *   Les paramètres viennent de `calibration/payment-v3.json` (versionné, avec sa provenance). Tant
 *   qu'ils ne sont pas ajustés sur une série v3 (`npm run calibration:fit`), M2 est « non calibrée » :
 *   a = 0, b = 1, c = 0 (M2 ≈ G lissé), intervalle très large, confiance faible.
 *
 * Intervalle à 95 % : incertitude d'échantillonnage de G (méthode delta sur l'échelle logit, l'équivalent
 * paramétrique du bootstrap sur les personas) combinée à l'incertitude des paramètres (`logitHalfWidth` :
 * défaut documenté tant que non calibré, sinon bootstrap et leave-one-out de l'ajustement).
 */

export const CALIBRATION_FILE = fileURLToPath(new URL("../../calibration/payment-v3.json", import.meta.url));

export const calibrationSchema = z.object({
  version: z.string(),
  status: z.enum(["uncalibrated", "calibrated"]),
  formula: z.string().optional(),
  params: z.object({ a: z.number(), b: z.number(), c: z.number() }),
  uncertainty: z.object({ logitHalfWidth: z.number().nonnegative(), note: z.string().optional() }),
  /** Domaine calibré : unités de prix, plage de prix (en €), plage de la part « au moins chaque mois ». */
  domain: z
    .object({
      units: z.array(z.string()),
      priceEur: z.tuple([z.number(), z.number()]),
      recurringShare: z.tuple([z.number(), z.number()]).nullable(),
    })
    .nullable()
    .optional(),
  /** Erreur leave-one-out de l'ajustement, en facteur sur la part payante (max(prévu/réel, réel/prévu)). */
  looErrorFactor: z.number().nullable().optional(),
  fittedOn: z.array(
    z.object({ product: z.string(), studyId: z.string(), realPayShare: z.number(), lowTierYes: z.number(), n: z.number() }).passthrough(),
  ),
  provenance: z.string(),
  updatedAt: z.string(),
});
export type PaymentCalibration = z.infer<typeof calibrationSchema>;

/** Paramètres par défaut (non calibrés), si le fichier manque. Mêmes valeurs que `calibration/payment-v3.json`. */
export const DEFAULT_CALIBRATION: PaymentCalibration = {
  version: "payment-v3/0",
  status: "uncalibrated",
  params: { a: 0, b: 1, c: 0 },
  uncertainty: { logitHalfWidth: 2.8 },
  domain: null,
  looErrorFactor: null,
  fittedOn: [],
  provenance: "Paramètres par défaut, non calibrés (docs/protocol-v3.md § 3).",
  updatedAt: "2026-10-15",
};

let cached: PaymentCalibration | null = null;
/** Paramètres de conversion courants (fichier versionné, sinon défaut). */
export function loadCalibration(path = CALIBRATION_FILE): PaymentCalibration {
  if (path === CALIBRATION_FILE && cached) return cached;
  const c = existsSync(path) ? calibrationSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : DEFAULT_CALIBRATION;
  if (path === CALIBRATION_FILE) cached = c;
  return c;
}

export const logit = (p: number) => Math.log(p / (1 - p));
export const expit = (x: number) => 1 / (1 + Math.exp(-x));
/** Lissage de G pour G = 0 ou 1 : G' = (n·G + 0,5) / (n + 1). */
export const smoothShare = (yes: number, n: number) => (yes + 0.5) / (n + 1);

export type Confidence = "high" | "medium" | "low";
export const CONFIDENCE_LABELS: Record<Confidence, string> = { high: "élevée", medium: "moyenne", low: "faible" };

export interface PaymentEstimate {
  /** Part payante estimée (0-1), et intervalle à 95 %. */
  value: number;
  ci: [number, number];
  confidence: Confidence;
  /** Raisons qui fixent la confiance (domaine, protocole, calibration). */
  confidenceReasons: string[];
  calibration: { status: "uncalibrated" | "calibrated"; version: string; fittedOn: string[] };
}

export interface PaymentMeasure {
  /** M1 : part au niveau « paiement » ou plus dans l'horizon de 7 jours. */
  observed: number;
  /** Palier bas p_b (sous le prix affiché, le plus proche de 0,4 × le prix) et G, la part de « oui » à ce palier. Null sans palier bas. */
  lowTierYes: { price: number; yes: number; n: number; share: number } | null;
  /** M2 : null sans palier bas (étude v2 dont le projet n'en a pas). */
  estimated: PaymentEstimate | null;
}

export interface PaymentInput {
  n: number;
  /** Personas au niveau paiement ou plus (M1). */
  payers: number;
  /** Prix affiché P, paliers et « oui » par palier. */
  shown: number;
  tiers: Array<{ price: number; yes: number }>;
  /** Contexte du domaine calibré. */
  unit: string;
  shownEur: number | null;
  /** Part « au moins chaque mois » de la fréquence du besoin (v3), null en v2. */
  recurringShare: number | null;
  protocolVersion: string;
}

/** M1 et M2 d'un ensemble de réponses. */
export function paymentMeasure(input: PaymentInput, cal: PaymentCalibration = loadCalibration()): PaymentMeasure {
  const observed = input.n ? input.payers / input.n : 0;
  const lowPrice = lowTierOf(input.tiers.map((t) => t.price), input.shown);
  const low = lowPrice === null ? null : input.tiers.find((t) => t.price === lowPrice)!;
  if (!low || !input.n) return { observed, lowTierYes: null, estimated: null };
  const n = input.n;
  const g = smoothShare(low.yes, n);
  const { a, b, c } = cal.params;
  const point = a + b * logit(g) + c * Math.log(input.shown / low.price);
  // Échantillonnage : var(logit G') ≈ 1 / ((n + 1)·G'(1 − G')), transmise par b
  const sampSd = Math.abs(b) / Math.sqrt((n + 1) * g * (1 - g));
  const half = Math.sqrt((1.96 * sampSd) ** 2 + cal.uncertainty.logitHalfWidth ** 2);
  const { confidence, reasons } = paymentConfidence(input, cal);
  return {
    observed,
    lowTierYes: { price: low.price, yes: low.yes, n, share: low.yes / n },
    estimated: {
      value: expit(point),
      ci: [expit(point - half), expit(point + half)],
      confidence,
      confidenceReasons: reasons,
      calibration: { status: cal.status, version: cal.version, fittedOn: cal.fittedOn.map((f) => f.product) },
    },
  };
}

/** Indice de confiance de M2 (§ 3.3) : élevée dans le domaine calibré, moyenne s'il manque une condition, faible sinon. */
export function paymentConfidence(input: Pick<PaymentInput, "unit" | "shownEur" | "recurringShare" | "protocolVersion">, cal: PaymentCalibration): { confidence: Confidence; reasons: string[] } {
  if (cal.status !== "calibrated" || !cal.domain) {
    return { confidence: "low", reasons: ["conversion non calibrée (paramètres par défaut : M2 ≈ part de « oui » au palier bas)"] };
  }
  const reasons: string[] = [];
  if (input.protocolVersion !== "3") return { confidence: "low", reasons: ["protocole v2 : la conversion est ajustée sur des études v3"] };
  if (!cal.domain.units.includes(input.unit)) return { confidence: "low", reasons: [`unité de prix « ${input.unit} » jamais calibrée`] };
  if (input.recurringShare === null || !cal.domain.recurringShare) return { confidence: "low", reasons: ["fréquence du besoin hors du domaine calibré"] };
  let missing = 0;
  const [plo, phi] = cal.domain.priceEur;
  if (input.shownEur === null || input.shownEur < plo || input.shownEur > phi) {
    missing++;
    reasons.push(`prix hors de la plage calibrée (${plo}-${phi} €)`);
  }
  const [rlo, rhi] = cal.domain.recurringShare;
  if (input.recurringShare < rlo || input.recurringShare > rhi) {
    missing++;
    reasons.push("part d'usage au moins mensuel hors de la plage calibrée");
  }
  if (!(cal.looErrorFactor && cal.looErrorFactor < 2)) {
    missing++;
    reasons.push(`erreur leave-one-out ${cal.looErrorFactor ? `d'un facteur ${cal.looErrorFactor.toFixed(1)}` : "inconnue"} (≥ 2)`);
  }
  if (missing === 0) return { confidence: "high", reasons: ["dans le domaine calibré"] };
  return { confidence: missing === 1 ? "medium" : "low", reasons };
}

/** Part en pourcentage : une décimale sous 10 %, deux sous 1 %, « < 0,01 % » en dessous. */
export const pct1 = (x: number) => {
  const v = x * 100;
  if (v > 0 && v < 0.01) return "< 0,01 %";
  return `${v.toLocaleString("fr-FR", { maximumFractionDigits: v < 1 ? 2 : v < 10 ? 1 : 0 })} %`;
};

/** Ligne d'affichage unique (§ 3.4) : M1 n'est jamais affiché sans G et M2. */
export function formatPaymentLine(m: PaymentMeasure, money: (x: number) => string): string {
  const parts = [`paiement observé dans les 7 jours : ${pct1(m.observed)}`];
  if (!m.lowTierYes || !m.estimated) {
    parts.push("part payante estimée : non disponible (aucun palier sous le prix affiché)");
    return parts.join(" ; ");
  }
  parts.push(`oui à ${money(m.lowTierYes.price)} : ${pct1(m.lowTierYes.share)}`);
  const e = m.estimated;
  parts.push(
    `part payante estimée : ${pct1(e.value)} [${pct1(e.ci[0])} ; ${pct1(e.ci[1])}], ${e.calibration.status === "calibrated" ? "calibrée" : "non calibrée"}, confiance ${CONFIDENCE_LABELS[e.confidence]}`,
  );
  return parts.join(" ; ");
}
