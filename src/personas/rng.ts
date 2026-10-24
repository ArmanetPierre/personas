/**
 * Générateur pseudo-aléatoire à graine (sfc32), sans `Math.random`.
 * Chaque persona a son propre flux, dérivé de (graine, index) : le tirage
 * de la persona n° i ne dépend ni du nombre total ni de l'ordre des tirages.
 */

/** Hachage 128 bits d'une chaîne (cyrb128) : sert à initialiser sfc32. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spareNormal: number | undefined;

  constructor(key: string) {
    [this.a, this.b, this.c, this.d] = cyrb128(key);
    // Écarte les premières sorties, peu mélangées
    for (let i = 0; i < 15; i++) this.next();
  }

  /** Flux indépendant pour la persona `index` d'un tirage `seed`. */
  static forPersona(seed: number, index: number, stream = "persona"): Rng {
    return new Rng(`${stream}:${seed}:${index}`);
  }

  /** Uniforme dans [0, 1). */
  next(): number {
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  /** Entier uniforme dans [min, max] (bornes incluses). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(p: number): boolean {
    return this.next() < p;
  }

  /** Loi normale centrée réduite (Box-Muller). */
  normal(): number {
    if (this.spareNormal !== undefined) {
      const s = this.spareNormal;
      this.spareNormal = undefined;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spareNormal = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Log-normale de médiane `median` et d'écart-type logarithmique `sigma`. */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  /** Choix pondéré parmi des clés (les poids n'ont pas besoin d'être normalisés). */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as Array<[K, number]>;
    return this.weightedEntry(entries);
  }

  weightedEntry<K>(entries: ReadonlyArray<readonly [K, number]>): K {
    let total = 0;
    for (const [, w] of entries) total += Math.max(0, w);
    if (total <= 0) throw new Error("Tirage pondéré impossible : poids tous nuls");
    let x = this.next() * total;
    for (const [k, w] of entries) {
      x -= Math.max(0, w);
      if (x < 0) return k;
    }
    return entries[entries.length - 1]![0];
  }
}

/** Choix pondéré à partir d'un uniforme u ∈ [0, 1) fourni (suite quasi aléatoire, par exemple). */
export function weightedByU<K>(entries: ReadonlyArray<readonly [K, number]>, u: number): K {
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, w);
  let x = u * total;
  for (const [k, w] of entries) {
    x -= Math.max(0, w);
    if (x < 0) return k;
  }
  return entries[entries.length - 1]![0];
}

/** Irrationnels de la suite de Kronecker (faible discrépance en dimension 3). */
const KRONECKER = [0.6180339887498949, 0.4142135623730951, 0.7320508075688772];

/**
 * Uniforme quasi aléatoire n° `dim` pour la persona `index` : frac(décalage(graine) + index × α).
 * Les marges d'un petit tirage collent aux cibles, et la persona i ne dépend toujours pas du total.
 */
export function quasiUniform(seed: number, index: number, dim: number): number {
  const offset = new Rng(`kronecker:${seed}:${dim}`).next();
  const x = offset + index * KRONECKER[dim % KRONECKER.length]!;
  return x - Math.floor(x);
}

/**
 * Variante repérée par une clé (module.attribut) plutôt que par un numéro de dimension : la valeur
 * ne dépend pas des autres modules activés. `alphaIndex` choisit l'irrationnel (0, 1, 2).
 */
export function quasiUniformKeyed(seed: number, index: number, key: string, alphaIndex: number): number {
  const offset = new Rng(`kronecker:${seed}:${key}`).next();
  const x = offset + index * KRONECKER[alphaIndex % KRONECKER.length]!;
  return x - Math.floor(x);
}

/** Fonction de répartition de la loi normale (approximation d'Abramowitz-Stegun 7.1.26). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
