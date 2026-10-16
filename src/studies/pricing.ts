/**
 * Analyses de prix : Van Westendorp (Price Sensitivity Meter) et Gabor-Granger.
 */

export interface VwAnswer {
  tooCheap: number;
  cheap: number;
  expensive: number;
  tooExpensive: number;
}

export interface VwCurvePoint {
  price: number;
  /** Part trouvant ce prix trop bon marché (prix ≤ sa réponse « trop bon marché »). Décroissante. */
  tooCheap: number;
  /** Part trouvant ce prix bon marché (prix ≤ sa réponse « bon marché »). Décroissante. */
  cheap: number;
  /** Part trouvant ce prix cher (prix ≥ sa réponse « cher »). Croissante. */
  expensive: number;
  /** Part trouvant ce prix trop cher (prix ≥ sa réponse « trop cher »). Croissante. */
  tooExpensive: number;
}

export interface VwResult {
  n: number;
  curve: VwCurvePoint[];
  /** Point de bon marché marginal : « trop bon marché » = « pas bon marché ». */
  pmc: number | null;
  /** Point de cherté marginale : « trop cher » = « pas cher ». */
  pme: number | null;
  /** Prix optimal : « trop bon marché » = « trop cher ». */
  opp: number | null;
  /** Prix d'indifférence : « bon marché » = « cher ». */
  ipp: number | null;
}

const share = (k: number, n: number) => (n ? k / n : 0);

/** Courbes cumulées sur la grille des prix cités, et points d'intersection (interpolation linéaire). */
export function vanWestendorp(answers: VwAnswer[]): VwResult {
  const n = answers.length;
  const grid = [...new Set(answers.flatMap((a) => [a.tooCheap, a.cheap, a.expensive, a.tooExpensive]))].sort((a, b) => a - b);
  const curve: VwCurvePoint[] = grid.map((price) => ({
    price,
    tooCheap: share(answers.filter((a) => a.tooCheap >= price).length, n),
    cheap: share(answers.filter((a) => a.cheap >= price).length, n),
    expensive: share(answers.filter((a) => a.expensive <= price).length, n),
    tooExpensive: share(answers.filter((a) => a.tooExpensive <= price).length, n),
  }));
  const col = (f: (p: VwCurvePoint) => number) => curve.map(f);
  const prices = curve.map((p) => p.price);
  return {
    n,
    curve,
    pmc: intersect(prices, col((p) => p.tooCheap), col((p) => 1 - p.cheap)),
    pme: intersect(prices, col((p) => p.tooExpensive), col((p) => 1 - p.expensive)),
    opp: intersect(prices, col((p) => p.tooCheap), col((p) => p.tooExpensive)),
    ipp: intersect(prices, col((p) => p.cheap), col((p) => p.expensive)),
  };
}

/** Premier croisement de deux courbes échantillonnées sur `xs`, par interpolation linéaire. */
export function intersect(xs: number[], a: number[], b: number[]): number | null {
  for (let i = 0; i < xs.length; i++) {
    const d = a[i]! - b[i]!;
    if (d === 0) {
      // Égalité sur un plateau : milieu du plateau
      let j = i;
      while (j + 1 < xs.length && a[j + 1]! - b[j + 1]! === 0) j++;
      return round2((xs[i]! + xs[j]!) / 2);
    }
    if (i + 1 < xs.length) {
      const d2 = a[i + 1]! - b[i + 1]!;
      if (d * d2 < 0) {
        const t = d / (d - d2);
        return round2(xs[i]! + t * (xs[i + 1]! - xs[i]!));
      }
    }
  }
  return null;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface GgTier {
  price: number;
  yes: number;
  /** Part de l'échantillon complet qui paierait à ce prix. */
  demand: number;
  /** Revenu attendu par période pour 100 personnes exposées (prix × demande × 100). */
  revenuePer100: number;
}

export interface GgResult {
  n: number;
  tiers: GgTier[];
  /** Palier qui maximise le revenu attendu (null si personne ne paie). */
  bestPrice: number | null;
}

/** `answers` : une ligne par persona, oui/non à chaque palier (dans l'ordre de `prices`). */
export function gaborGranger(prices: number[], answers: boolean[][]): GgResult {
  const n = answers.length;
  const tiers = prices.map((price, i) => {
    const yes = answers.filter((a) => a[i] === true).length;
    const demand = share(yes, n);
    return { price, yes, demand, revenuePer100: round2(price * demand * 100) };
  });
  const best = tiers.reduce<GgTier | null>((b, t) => (t.revenuePer100 > 0 && (!b || t.revenuePer100 > b.revenuePer100) ? t : b), null);
  return { n, tiers, bestPrice: best?.price ?? null };
}
