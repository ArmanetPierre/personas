import type { PaymentCalibration } from "./payment";
import { hasV3Measures } from "./protocols/concept-price";

/**
 * Indice de confiance d'une étude (protocoles v3 et v4, « voie 1 ») : les niveaux absolus (paiement, essai)
 * sont indicatifs ; ce qui est fiable, ce sont les objections, les segments, les écarts entre variantes
 * et l'effet du ton. L'indice dit à quel point un niveau absolu de cette étude peut être lu.
 *
 * Trois critères, un point chacun :
 * - échantillon : n ≥ 100 dans le groupe de référence, ou une passe répétée (même projet, même protocole) ;
 * - protocole calibré pour ce modèle : conversion M2 ajustée sur une série v3 jouée sur la même famille de
 *   modèle (calibration/payment-v3.json, indexé par famille) ; un modèle absent de la table perd ce point ;
 *   la v4 a la même mesure que la v3 : la même calibration s'y applique telle quelle ;
 * - pitch neutre : score de ton < seuil (ou neutralisé).
 * 3 points : élevé ; 2 : moyen ; 0-1 : faible. Les réserves connues sont listées à part.
 */

export const MIN_N_WITHOUT_REPEAT = 100;
/** Bruit test-retest mesuré dans le REX de calibration : ±15 points à n = 20 (rejeu à l'identique). */
export const RETEST_NOISE_PTS_AT_20 = 15;

export type ConfidenceLevel = "high" | "medium" | "low";
export const CONFIDENCE_LEVEL_LABELS: Record<ConfidenceLevel, string> = { high: "élevé", medium: "moyen", low: "faible" };

export const RELIABLE_SIGNALS = ["objections", "segments", "écarts entre variantes", "effet du ton"];
export const INDICATIVE_SIGNALS = ["niveaux absolus (essai, paiement) : lire M1 avec M2 et cet indice"];

export interface ConfidenceIndex {
  level: ConfidenceLevel;
  label: string;
  /** Points obtenus sur 3 (échantillon, calibration, pitch). */
  score: number;
  sample: {
    group: string | null;
    n: number;
    /** Demi-largeur de l'intervalle à 95 % d'une part de 50 %, en points. */
    ciHalfWidthPts: number;
    /** Bruit test-retest attendu à cet effectif, en points (±15 à n = 20, en 1/√n). */
    retestNoisePts: number;
    /** Autres études terminées du même projet au même protocole (passes répétées). Null : non vérifié. */
    repeats: string[] | null;
    ok: boolean;
    warning: string | null;
  };
  protocol: {
    version: string;
    /** Calibré pour le modèle de l'étude. */
    calibrated: boolean;
    calibrationVersion: string;
    /** Présent seulement pour un modèle absent de la table de calibration (champ additif). */
    model?: { family: string | null; calibrated: false };
  };
  pitch: {
    /** Score lexical de ton (0 : factuel, 100 : survendu) ; null si non mesuré. */
    score: number | null;
    threshold: number;
    neutralized: boolean | null;
    /** Figé dans les réponses (v3) ou mesuré sur le pitch actuel du projet (v2). */
    measuredOn: "responses" | "current_project";
    ok: boolean;
  };
  caveats: string[];
  reliable: string[];
  indicative: string[];
}

export interface ConfidenceInput {
  protocolVersion: string;
  group: string | null;
  n: number;
  repeats: string[] | null;
  calibration: PaymentCalibration;
  /** Famille du modèle de l'étude et présence dans la table de calibration ; absent : non vérifié (comme avant). */
  model?: { family: string | null; inTable: boolean };
  pitch: { score: number | null; threshold: number; neutralized: boolean | null; measuredOn: "responses" | "current_project" };
  /** Réserves calculées ailleurs (fréquence du besoin, anomalies…). */
  extraCaveats?: string[];
  /** Langue des textes (étude en anglais : socle en locale `en`). */
  locale?: "fr" | "en";
}

export const CONFIDENCE_LEVEL_LABELS_EN: Record<ConfidenceLevel, string> = { high: "high", medium: "medium", low: "low" };
export const RELIABLE_SIGNALS_EN = ["objections", "segments", "differences between variants", "effect of tone"];
export const INDICATIVE_SIGNALS_EN = ["absolute levels (trial, payment): read M1 with M2 and this index"];

export function confidenceIndex(i: ConfidenceInput): ConfidenceIndex {
  const n = i.n;
  const ciHalfWidthPts = n ? Math.round(1.96 * Math.sqrt(0.25 / n) * 100) : 100;
  const retestNoisePts = n ? Math.round(RETEST_NOISE_PTS_AT_20 * Math.sqrt(20 / n)) : 100;
  const repeated = (i.repeats?.length ?? 0) > 0;
  const sampleOk = n >= MIN_N_WITHOUT_REPEAT || repeated;
  const en = i.locale === "en";
  const warning = sampleOk
    ? null
    : en
      ? `n = ${n} < ${MIN_N_WITHOUT_REPEAT} without a repeated run${i.repeats === null ? " known" : ""}: test-retest noise ≈ ±${retestNoisePts} points, only read clear differences or run another pass.`
      : `n = ${n} < ${MIN_N_WITHOUT_REPEAT} sans passe répétée${i.repeats === null ? " connue" : ""} : bruit test-retest ≈ ±${retestNoisePts} points, ne lire que des écarts nets ou relancer une passe.`;
  const modelUncalibrated = i.model !== undefined && !i.model.inTable;
  const calibrated = i.calibration.status === "calibrated" && !modelUncalibrated;
  const pitchOk = i.pitch.score !== null && i.pitch.score < i.pitch.threshold;
  const score = Number(sampleOk) + Number(calibrated) + Number(pitchOk);
  const level: ConfidenceLevel = score === 3 ? "high" : score === 2 ? "medium" : "low";

  const caveats: string[] = [];
  if (en) {
    if (modelUncalibrated) caveats.push(`Model not calibrated (${i.model!.family ?? "unknown"}): absolute levels were only compared with real data on Sonnet.`);
    if (!calibrated) caveats.push("Payment conversion not calibrated: the estimated paying share (M2) is only an order of magnitude, to compare between variants.");
    caveats.push("Payment observed within 7 days (M1) is structurally close to 0 for synthetic personas (calibration review): it underestimates products with real conversion.");
    if (!hasV3Measures(i.protocolVersion)) caveats.push("Protocol v2: no need frequency, no guaranteed low tier, no neutral pitch required.");
    if (i.pitch.score === null) caveats.push("Pitch tone not measured.");
    else if (!pitchOk) caveats.push(`Pitch with a commercial tone (score ${i.pitch.score}/100, threshold ${i.pitch.threshold}): “trust” objection and prices distorted.`);
    else if (i.pitch.measuredOn === "current_project") caveats.push("Tone measured on the current pitch of the project (not frozen in a v2 study).");
  } else {
  if (modelUncalibrated) caveats.push(`Modèle non calibré (${i.model!.family ?? "inconnu"}) : les niveaux absolus n'ont été comparés au réel que sur Sonnet.`);
  if (!calibrated) caveats.push("Conversion du paiement non calibrée : la part payante estimée (M2) n'est qu'un ordre de grandeur, à comparer entre variantes.");
  caveats.push("Le paiement observé dans les 7 jours (M1) est structurellement proche de 0 chez les personas synthétiques (REX de calibration) : il sous-estime les produits à conversion réelle.");
  if (!hasV3Measures(i.protocolVersion)) caveats.push("Protocole v2 : ni fréquence du besoin, ni palier bas garanti, ni pitch neutre exigé.");
  if (i.pitch.score === null) caveats.push("Ton du pitch non mesuré.");
  else if (!pitchOk) caveats.push(`Pitch au ton commercial (score ${i.pitch.score}/100, seuil ${i.pitch.threshold}) : frein « confiance » et prix faussés.`);
  else if (i.pitch.measuredOn === "current_project") caveats.push("Ton mesuré sur le pitch actuel du projet (non figé dans une étude v2).");
  }
  caveats.push(...(i.extraCaveats ?? []));

  return {
    level,
    label: (en ? CONFIDENCE_LEVEL_LABELS_EN : CONFIDENCE_LEVEL_LABELS)[level],
    score,
    sample: { group: i.group, n, ciHalfWidthPts, retestNoisePts, repeats: i.repeats, ok: sampleOk, warning },
    protocol: { version: i.protocolVersion, calibrated, calibrationVersion: i.calibration.version, ...(modelUncalibrated && { model: { family: i.model!.family, calibrated: false as const } }) },
    pitch: { ...i.pitch, ok: pitchOk },
    caveats,
    reliable: en ? RELIABLE_SIGNALS_EN : RELIABLE_SIGNALS,
    indicative: en ? INDICATIVE_SIGNALS_EN : INDICATIVE_SIGNALS,
  };
}

/** Lignes console de l'indice. */
export function formatConfidence(c: ConfidenceIndex): string[] {
  const out = [`  Indice de confiance des niveaux absolus : ${c.label} (${c.score}/3)`];
  out.push(
    `  - échantillon : n = ${c.sample.n}${c.sample.group ? ` (${c.sample.group})` : ""}, intervalle ±${c.sample.ciHalfWidthPts} points sur une part de 50 %` +
      (c.sample.repeats?.length ? `, passe(s) répétée(s) : ${c.sample.repeats.join(", ")}` : ""),
  );
  if (c.sample.warning) out.push(`    ⚠ ${c.sample.warning}`);
  out.push(
    `  - protocole v${c.protocol.version} ; conversion du paiement ${c.protocol.calibrated ? "calibrée pour ce modèle" : "non calibrée"} (${c.protocol.calibrationVersion})` +
      (c.protocol.model ? ` ; modèle non calibré (${c.protocol.model.family ?? "inconnu"})` : ""),
  );
  out.push(
    `  - pitch : ${c.pitch.score === null ? "non mesuré" : `score de ton ${c.pitch.score}/100 (seuil ${c.pitch.threshold})`}${c.pitch.neutralized ? ", neutralisé" : ""}${c.pitch.ok ? "" : " ⚠"}`,
  );
  for (const r of c.caveats) out.push(`  - ${r}`);
  out.push(`  Fiable : ${c.reliable.join(", ")}. Indicatif : ${c.indicative.join(", ")}.`);
  return out;
}
