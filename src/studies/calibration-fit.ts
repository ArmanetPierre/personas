import { Rng } from "../personas/rng";
import { logit, smoothShare, type PaymentCalibration } from "./payment";

/**
 * Ajustement de la conversion M2 (docs/protocol-v3.md § 3.2) sur une série de calibration v3 :
 *
 *   logit(réel) = a + b · logit(G') + c · log(P / p_b)
 *
 * - moindres carrés sur l'échelle logit ; c = 0 tant qu'il y a moins de 5 produits ;
 * - refus si b ≤ 0 (aucune fonction croissante ne relie G au réel : la conversion ne s'applique pas) ;
 * - incertitude : bootstrap sur les personas (G retiré par binomiale) et leave-one-out sur les produits.
 */

export interface CalibrationPoint {
  product: string;
  studyId: string;
  /** Part payante réelle dans la population (payants des utilisateurs × usage). */
  realPayShare: number;
  /** « Oui » au palier bas et effectif du groupe de référence. */
  yes: number;
  n: number;
  shown: number;
  lowTier: number;
  unit: string;
  shownEur: number | null;
  recurringShare: number | null;
}

export type FitResult =
  | { ok: true; calibration: PaymentCalibration; report: string[] }
  | { ok: false; reason: string; report: string[] };

/** Moindres carrés (équations normales, élimination de Gauss) ; null si le système est singulier. */
export function leastSquares(X: number[][], y: number[]): number[] | null {
  const k = X[0]!.length;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k + 1 }, (_, j) => (j < k ? X.reduce((s, r) => s + r[i]! * r[j]!, 0) : X.reduce((s, r, t) => s + r[i]! * y[t]!, 0))));
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    if (Math.abs(A[piv]![c]!) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let j = c; j <= k; j++) A[r]![j]! -= f * A[c]![j]!;
    }
  }
  return A.map((row, i) => row[k]! / A[i]![i]!);
}

const features = (p: CalibrationPoint, yes: number, withC: boolean) => [1, logit(smoothShare(yes, p.n)), ...(withC ? [Math.log(p.shown / p.lowTier)] : [])];
const predict = (beta: number[], x: number[]) => x.reduce((s, v, i) => s + v * beta[i]!, 0);
const expit = (x: number) => 1 / (1 + Math.exp(-x));

export function fitCalibration(points: CalibrationPoint[], opts: { version: string; date: string; bootstrap?: number; seed?: string }): FitResult {
  const report: string[] = [];
  if (points.length < 3) return { ok: false, reason: `${points.length} produit(s) avec une étude v3 et un réel : il en faut au moins 3.`, report };
  const withC = points.length >= 5;
  const y = points.map((p) => logit(p.realPayShare));
  const X = points.map((p) => features(p, p.yes, withC));
  const beta = leastSquares(X, y);
  if (!beta) return { ok: false, reason: "Système singulier (G identique pour tous les produits ?).", report };
  const [a, b, c = 0] = beta;
  for (const [i, p] of points.entries()) {
    report.push(`${p.product} (${p.studyId}) : G = ${p.yes}/${p.n} à ${p.lowTier}, réel ${(p.realPayShare * 100).toFixed(2)} %, ajusté ${(expit(predict(beta, X[i]!)) * 100).toFixed(2)} %`);
  }
  if (!(b! > 0)) return { ok: false, reason: `b = ${b!.toFixed(3)} ≤ 0 : aucune fonction croissante ne relie la part de « oui » au palier bas au réel. La conversion ne s'applique pas (docs/protocol-v3.md § 3.2).`, report };

  // Leave-one-out sur les produits
  const loo: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const keep = points.map((_, j) => j).filter((j) => j !== i);
    const bi = leastSquares(keep.map((j) => X[j]!), keep.map((j) => y[j]!));
    if (!bi) continue;
    loo.push(predict(bi, X[i]!) - y[i]!);
  }
  const shareFactor = (d: number, real: number) => {
    const pred = expit(logit(real) + d);
    return Math.max(pred / real, real / pred);
  };
  const looFactors = loo.map((d, i) => shareFactor(d, points[i]!.realPayShare));
  const looErrorFactor = looFactors.length ? Math.max(...looFactors) : null;
  const looRms = loo.length ? Math.sqrt(loo.reduce((s, d) => s + d * d, 0) / loo.length) : 0;

  // Bootstrap sur les personas : G de chaque produit retiré par binomiale, réajustement
  const B = opts.bootstrap ?? 1000;
  const rng = new Rng(opts.seed ?? `calibration:${opts.version}`);
  const preds: number[][] = points.map(() => []);
  for (let t = 0; t < B; t++) {
    const yesB = points.map((p) => {
      let k = 0;
      for (let u = 0; u < p.n; u++) if (rng.next() < p.yes / p.n) k++;
      return k;
    });
    const bb = leastSquares(points.map((p, i) => features(p, yesB[i]!, withC)), y);
    if (!bb) continue;
    points.forEach((p, i) => preds[i]!.push(predict(bb, X[i]!)));
  }
  const sd = (v: number[]) => {
    const m = v.reduce((s, x) => s + x, 0) / (v.length || 1);
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
  };
  const bootSd = Math.sqrt(preds.reduce((s, v) => s + sd(v) ** 2, 0) / preds.length);
  const logitHalfWidth = Math.round(1.96 * Math.sqrt(bootSd ** 2 + looRms ** 2) * 1000) / 1000;
  report.push(`a = ${a!.toFixed(3)}, b = ${b!.toFixed(3)}, c = ${c.toFixed(3)}${withC ? "" : " (fixé : moins de 5 produits)"}`);
  report.push(`Leave-one-out : erreur max d'un facteur ${looErrorFactor?.toFixed(2) ?? "?"} ; bootstrap (${B} tirages) : écart-type ${bootSd.toFixed(3)} sur l'échelle logit ; demi-largeur ±${logitHalfWidth}`);

  const eurs = points.map((p) => p.shownEur).filter((x): x is number => x !== null);
  const rec = points.map((p) => p.recurringShare);
  const calibration: PaymentCalibration = {
    version: opts.version,
    status: "calibrated",
    formula: "logit(M2) = a + b · logit(G') + c · log(P / p_b), G' = (n·G + 0,5) / (n + 1)",
    params: { a: round(a!), b: round(b!), c: round(c) },
    uncertainty: { logitHalfWidth, note: `1,96 × √(écart-type bootstrap² + RMS leave-one-out²), sur ${points.length} produits.` },
    domain: {
      units: [...new Set(points.map((p) => p.unit))],
      priceEur: [eurs.length ? Math.min(...eurs) : 0, eurs.length ? Math.max(...eurs) : 0],
      recurringShare: rec.every((r) => r !== null) ? [Math.min(...(rec as number[])), Math.max(...(rec as number[]))] : null,
    },
    looErrorFactor: looErrorFactor === null ? null : Math.round(looErrorFactor * 100) / 100,
    fittedOn: points.map((p) => ({ product: p.product, studyId: p.studyId, realPayShare: p.realPayShare, lowTierYes: p.yes / p.n, n: p.n })),
    provenance: `Ajusté par npm run calibration:fit le ${opts.date} sur ${points.length} études v3 (calibration/truth.json).`,
    updatedAt: opts.date,
  };
  return { ok: true, calibration, report };
}

const round = (x: number) => Math.round(x * 10000) / 10000;
