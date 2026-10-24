import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { hasV3Measures, lowTierOf } from "./protocols/concept-price";

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

/**
 * Fichier de calibration indexé par famille de modèle (docs/plateforme.md § 7.4) :
 * `{ "byModelFamily": { "claude-sonnet": <calibration> } }`. L'ancien format (une calibration seule) vaut
 * pour `claude-sonnet`, la famille sur laquelle la série v3 a été jouée.
 */
export const DEFAULT_MODEL_FAMILY = "claude-sonnet";
export const calibrationFileSchema = z.object({
  note: z.string().optional(),
  byModelFamily: z.record(z.string(), calibrationSchema),
});
export type CalibrationFile = z.infer<typeof calibrationFileSchema>;

/** Contenu du fichier de calibration, quel que soit son format (ancien : une seule calibration, Sonnet). */
export function readCalibrationFile(path = CALIBRATION_FILE): CalibrationFile {
  if (!existsSync(path)) return { byModelFamily: { [DEFAULT_MODEL_FAMILY]: DEFAULT_CALIBRATION } };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (raw && typeof raw === "object" && "byModelFamily" in raw) return calibrationFileSchema.parse(raw);
  return { byModelFamily: { [DEFAULT_MODEL_FAMILY]: calibrationSchema.parse(raw) } };
}

const cachedFiles = new Map<string, CalibrationFile>();
function calibrationFile(path: string): CalibrationFile {
  if (path !== CALIBRATION_FILE) return readCalibrationFile(path);
  let f = cachedFiles.get(path);
  if (!f) {
    f = readCalibrationFile(path);
    cachedFiles.set(path, f);
  }
  return f;
}

/** Paramètres de conversion de la famille de référence (claude-sonnet), sinon défaut. */
export function loadCalibration(path = CALIBRATION_FILE): PaymentCalibration {
  return calibrationFile(path).byModelFamily[DEFAULT_MODEL_FAMILY] ?? DEFAULT_CALIBRATION;
}

/** Paramètres de conversion d'une famille de modèle ; null si la famille n'est pas dans la table. */
export function loadCalibrationFor(family: string | null, path = CALIBRATION_FILE): PaymentCalibration | null {
  if (!family) return null;
  return calibrationFile(path).byModelFamily[family] ?? null;
}

/**
 * Famille d'un modèle, pour la table de calibration : `sonnet`, `claude-sonnet-5-5`, `anthropic/claude-sonnet-4.5`
 * → `claude-sonnet` ; `gpt-5.4-mini` → `gpt-5.4-mini` ; `user/qwen3.8-27b-q8:32k` → `qwen3.8`. Null si vide.
 */
export function modelFamily(provider: string, model: string | null | undefined): string | null {
  const m = (model ?? "").trim().toLowerCase().replace(/^.*\//, "").replace(/:.*$/, "");
  if (!m) return null;
  const claude = m.match(/^(?:claude-)?(opus|sonnet|haiku|fable|mythos)\b/) ?? m.match(/^claude-(?:\d[\d.-]*-)?(opus|sonnet|haiku|fable|mythos)\b/);
  if (claude && (provider === "claude-cli" || provider === "anthropic" || m.startsWith("claude") || provider === "openrouter")) return `claude-${claude[1]}`;
  if (/^(gpt|o\d|gemini)/.test(m)) return m.replace(/-\d{4}-?\d{2}-?\d{2}$/, "").replace(/-latest$/, "");
  // Modèles ouverts : nom de base sans taille ni quantification (qwen3.8-27b-q8 → qwen3.8)
  return m.split(/[-_]/)[0] || m;
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
  // v4 : même mesure que la v3, la calibration payment-v3 s'applique telle quelle
  if (!hasV3Measures(input.protocolVersion)) return { confidence: "low", reasons: ["protocole v2 : la conversion est ajustée sur des études v3"] };
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
