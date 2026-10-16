import type { Persona } from "../db/schema";
import { valueLabel } from "../modules/engine";
import { moduleLibrary } from "../modules/registry";
import type { ModuleAttribute } from "../modules/schema";
import type { Pack } from "../personas/pack";
import { Rng } from "../personas/rng";
import { wilson } from "./stats";
import { LEVEL_LABELS, levelRank, type CanonicalLevel } from "./protocols/protocol";
import { DIMENSION_LABELS, DIMENSION_LABELS_EN, MODULE_SEGMENTS, segmentLabel, segmentOf, segmentOrder } from "./segments";

/**
 * Segments automatiques et analyse des facteurs d'engagement (lot P1).
 *
 * - Tout attribut des modules de la population étudiée devient un segment (les nombres par tranches,
 *   les ensembles par option), en plus des variables clés du socle.
 * - Pour chaque niveau d'engagement (≥ intérêt, ≥ essai gratuit, paiement), chaque attribut est
 *   mesuré par le V de Cramér, avec un test de permutation (p) et une correction de
 *   Benjamini-Hochberg (q) ; chaque valeur par son taux, comparé au reste, avec un intervalle de Wilson.
 */

/** Une dimension d'analyse : code et libellé de chaque persona. */
export interface Dimension {
  id: string;
  label: string;
  source: "socle" | "module" | "response";
  module?: string;
  attribute?: string;
  codeOf: (p: Persona) => string;
  labelOf: (code: string, example?: Persona) => string;
  order?: (codes: string[]) => string[];
}

/** Description JSON d'une dimension automatique (sans fonctions). */
export interface DimensionInfo {
  id: string;
  label: string;
  source: "socle" | "module" | "response";
  module?: string;
  attribute?: string;
}

export const dimensionInfo = (d: Dimension): DimensionInfo => ({
  id: d.id,
  label: d.label,
  source: d.source,
  ...(d.module && { module: d.module }),
  ...(d.attribute && { attribute: d.attribute }),
});

/** Variables clés du socle ajoutées automatiquement (en plus des dimensions habituelles du résumé). */
export const AUTO_SOCLE_DIMENSIONS = ["sex", "activityStatus"] as const;

/** Dimension du socle (segments existants : âge, PCS, niveau de vie…). */
export function socleDimension(packOf: (p: Persona) => Pack, id: string, locale: "fr" | "en" = "fr"): Dimension {
  return {
    id,
    label: (locale === "en" ? DIMENSION_LABELS_EN[id] : undefined) ?? DIMENSION_LABELS[id] ?? id,
    source: MODULE_SEGMENTS.some((s) => s.id === id) ? "module" : "socle",
    codeOf: (p) => segmentOf(packOf(p), p, id),
    labelOf: (code, ex) => (ex ? segmentLabel(packOf(ex), id, code, ex) : code),
    order: (codes) => segmentOrder(id, codes),
  };
}

type ModuleValues = Record<string, Record<string, unknown>>;
const modulesOf = (p: Persona) => ((p.extra as { modules?: ModuleValues } | null)?.modules ?? {}) as ModuleValues;

const fmtNum = (x: number, unit?: string) => `${x.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;

/** Quantile (interpolation linéaire) d'un tableau trié. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Tranches d'une variable numérique : valeurs distinctes s'il y en a peu, sinon tertiles de l'échantillon. */
export function numericBins(values: number[], unit?: string): { codeOf: (x: number) => string; labels: Record<string, string>; order: string[] } {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  if (distinct.length <= 6) {
    const labels = Object.fromEntries(distinct.map((v) => [`v${v}`, fmtNum(v, unit)]));
    return { codeOf: (x) => `v${x}`, labels, order: distinct.map((v) => `v${v}`) };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const round = (x: number) => (Math.abs(x) >= 10 ? Math.round(x) : Math.round(x * 100) / 100);
  let c1 = round(quantile(sorted, 1 / 3));
  let c2 = round(quantile(sorted, 2 / 3));
  if (c2 <= c1) c2 = distinct.find((v) => v > c1) ?? c1;
  if (c1 === c2) {
    c1 = round(quantile(sorted, 0.5));
    return { codeOf: (x) => (x <= c1 ? "b1" : "b2"), labels: { b1: `≤ ${fmtNum(c1, unit)}`, b2: `> ${fmtNum(c1, unit)}` }, order: ["b1", "b2"] };
  }
  return {
    codeOf: (x) => (x <= c1 ? "b1" : x <= c2 ? "b2" : "b3"),
    labels: { b1: `≤ ${fmtNum(c1, unit)}`, b2: `${fmtNum(c1, unit)} – ${fmtNum(c2, unit)}`, b3: `> ${fmtNum(c2, unit)}` },
    order: ["b1", "b2", "b3"],
  };
}

const NA = "?";
const naLabel = "Non renseigné";

/**
 * Dimensions automatiques des modules pour un ensemble de personas.
 * `modules` : modules de la population (étude ciblée) ; à défaut, ceux que portent au moins la moitié des personas.
 * Les attributs déjà déclarés comme segments par leur module ne sont pas dupliqués.
 */
export function moduleDimensions(personas: Persona[], modules?: string[] | null): Dimension[] {
  if (!personas.length) return [];
  const lib = moduleLibrary();
  let ids = modules ?? null;
  if (!ids) {
    const counts = new Map<string, number>();
    for (const p of personas) for (const m of Object.keys(modulesOf(p))) counts.set(m, (counts.get(m) ?? 0) + 1);
    ids = [...counts].filter(([, c]) => c >= personas.length / 2).map(([m]) => m);
  }
  const declared = new Set(MODULE_SEGMENTS.map((s) => `${s.module}.${s.attribute}`));
  const out: Dimension[] = [];
  for (const mid of ids) {
    const m = lib.get(mid);
    if (!m) continue;
    for (const a of m.def.attributes as ModuleAttribute[]) {
      if (declared.has(`${mid}.${a.key}`)) continue;
      const raw = (p: Persona) => modulesOf(p)[mid]?.[a.key];
      const base = { source: "module" as const, module: mid, attribute: a.key };
      const present = personas.filter((p) => raw(p) !== null && raw(p) !== undefined);
      if (present.length < Math.max(5, personas.length * 0.05)) continue;
      if (a.type === "enum") {
        const dim: Dimension = {
          ...base,
          id: `${mid}.${a.key}`,
          label: a.label,
          codeOf: (p) => (typeof raw(p) === "string" ? (raw(p) as string) : NA),
          labelOf: (code, ex) => (code === NA ? naLabel : valueLabel(m, a.key, code, ex?.sex ?? "M") ?? code),
          order: (codes) => [...a.values.map((v) => v.code).filter((c) => codes.includes(c)), ...codes.filter((c) => !a.values.some((v) => v.code === c))],
        };
        if (varies(dim, personas)) out.push(dim);
      } else if (a.type === "boolean") {
        const yes = a.labels?.yes ?? "Oui";
        const no = a.labels?.no ?? "Non";
        const dim: Dimension = {
          ...base,
          id: `${mid}.${a.key}`,
          label: a.label,
          codeOf: (p) => (raw(p) === true ? "yes" : raw(p) === false ? "no" : NA),
          labelOf: (code) => (code === "yes" ? yes : code === "no" ? no : naLabel),
          order: (codes) => ["yes", "no", NA].filter((c) => codes.includes(c)),
        };
        if (varies(dim, personas)) out.push(dim);
      } else if (a.type === "number") {
        const vals = present.map((p) => Number(raw(p))).filter((x) => Number.isFinite(x));
        if (vals.length < 5) continue;
        const bins = numericBins(vals, a.unit);
        const dim: Dimension = {
          ...base,
          id: `${mid}.${a.key}`,
          label: a.label,
          codeOf: (p) => {
            const v = raw(p);
            return typeof v === "number" && Number.isFinite(v) ? bins.codeOf(v) : NA;
          },
          labelOf: (code) => (code === NA ? naLabel : bins.labels[code] ?? code),
          order: (codes) => [...bins.order.filter((c) => codes.includes(c)), ...codes.filter((c) => !bins.order.includes(c))],
        };
        if (varies(dim, personas)) out.push(dim);
      } else if (a.type === "set") {
        for (const item of a.items) {
          const has = personas.filter((p) => Array.isArray(raw(p)) && (raw(p) as string[]).includes(item.code)).length;
          const share = has / personas.length;
          if (share < 0.05 || share > 0.95) continue;
          out.push({
            ...base,
            id: `${mid}.${a.key}=${item.code}`,
            label: `${a.label} : ${item.label}`,
            // Ensemble absent (attribut non tiré) : la persona n'a pas l'option
            codeOf: (p) => (Array.isArray(raw(p)) && (raw(p) as string[]).includes(item.code) ? "yes" : "no"),
            labelOf: (code) => (code === "yes" ? "Oui" : "Non"),
            order: (codes) => ["yes", "no"].filter((c) => codes.includes(c)),
          });
        }
      }
    }
  }
  return out;
}

function varies(d: Dimension, personas: Persona[]): boolean {
  const codes = new Set(personas.map((p) => d.codeOf(p)).filter((c) => c !== NA));
  return codes.size >= 2;
}

// ─── Analyse des facteurs ─────────────────────────────────────────────────────

export const DRIVER_OUTCOMES: Array<{ level: CanonicalLevel; label: string; short: string }> = [
  { level: "interest", label: "Intérêt (regarde au moins l'offre)", short: "intérêt" },
  { level: "free_trial", label: "Essai gratuit ou plus", short: "essai" },
  { level: "payment", label: "Paiement au prix affiché", short: "paiement" },
];
export const DRIVER_OUTCOMES_EN: Array<{ level: CanonicalLevel; label: string; short: string }> = [
  { level: "interest", label: "Interest (at least looks at the offer)", short: "interest" },
  { level: "free_trial", label: "Free trial or more", short: "trial" },
  { level: "payment", label: "Payment at the displayed price", short: "payment" },
];

export interface DriverValue {
  code: string;
  label: string;
  n: number;
  rate: number;
  ci: [number, number];
  restN: number;
  restRate: number;
  /** Écart en points de pourcentage avec le reste de l'échantillon. */
  diffPts: number;
  small: boolean;
}

export interface DriverFactor {
  dimension: string;
  label: string;
  source: "socle" | "module" | "response";
  /** V de Cramér (0 : aucune association, 1 : association parfaite). */
  cramersV: number;
  /** p du test de permutation, et q de Benjamini-Hochberg sur l'ensemble des attributs testés. */
  p: number;
  q: number;
  values: DriverValue[];
  /** Phrase lisible sur la valeur la plus discriminante. */
  sentence: string;
}

export interface DriverOutcome {
  level: CanonicalLevel;
  label: string;
  n: number;
  positives: number;
  rate: number;
  /** Absent si trop peu de cas positifs ou négatifs pour analyser. */
  factors: DriverFactor[];
  note?: string;
}

export interface DriversResult {
  group: string | null;
  n: number;
  method: string;
  permutations: number;
  minSegment: number;
  outcomes: DriverOutcome[];
}

/** Nombre minimal de cas positifs (et négatifs) pour analyser un niveau d'engagement. */
export const MIN_CASES = 10;

export const DRIVERS_METHOD =
  "V de Cramér corrigé du biais par attribut (catégories de moins de 5 personas regroupées), test de permutation, correction de Benjamini-Hochberg ; taux par valeur contre le reste, intervalle de Wilson à 95 %. Association, pas causalité.";

/** Khi-deux d'un tableau catégories × {0, 1}. */
export function chiSquare(cats: number[], y: number[], k: number): number {
  const n = y.length;
  const tot = new Array<number>(k).fill(0);
  const pos = new Array<number>(k).fill(0);
  let P = 0;
  for (let i = 0; i < n; i++) {
    tot[cats[i]!]!++;
    if (y[i]) {
      pos[cats[i]!]!++;
      P++;
    }
  }
  if (P === 0 || P === n) return 0;
  const pr = P / n;
  let chi = 0;
  for (let j = 0; j < k; j++) {
    if (!tot[j]) continue;
    const e1 = tot[j]! * pr;
    const e0 = tot[j]! - e1;
    chi += (pos[j]! - e1) ** 2 / e1 + (tot[j]! - pos[j]! - e0) ** 2 / e0;
  }
  return chi;
}

/**
 * V de Cramér corrigé du biais (Bergsma, 2013) pour un tableau k × 2 : le V brut gonfle
 * avec le nombre de catégories quand l'échantillon est petit.
 */
export function cramersVCorrected(chi: number, n: number, k: number, r = 2): number {
  if (n < 2) return 0;
  const phi2 = Math.max(0, chi / n - ((k - 1) * (r - 1)) / (n - 1));
  const kc = k - (k - 1) ** 2 / (n - 1);
  const rc = r - (r - 1) ** 2 / (n - 1);
  const d = Math.min(kc - 1, rc - 1);
  return d > 0 ? Math.sqrt(phi2 / d) : 0;
}

/** Valeurs q de Benjamini-Hochberg. */
export function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const idx = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const q = new Array<number>(m);
  let min = 1;
  for (let r = m - 1; r >= 0; r--) {
    const [p, i] = idx[r]!;
    min = Math.min(min, (p * m) / (r + 1));
    q[i] = min;
  }
  return q;
}

const pctS = (x: number) => `${Math.round(x * 100)} %`;
const pctEn = (x: number) => `${Math.round(x * 100)}%`;

export interface DriverInput {
  persona: Persona;
  level: CanonicalLevel;
}

export function computeDrivers(
  rows: DriverInput[],
  dims: Dimension[],
  opts: { group?: string | null; permutations?: number; minSegment?: number; seed?: string; locale?: "fr" | "en" } = {},
): DriversResult {
  const en = opts.locale === "en";
  const B = opts.permutations ?? 999;
  const minSeg = opts.minSegment ?? 15;
  const n = rows.length;
  const outcomes: DriverOutcome[] = [];
  for (const o of en ? DRIVER_OUTCOMES_EN : DRIVER_OUTCOMES) {
    const y: number[] = rows.map((r) => (levelRank(r.level) >= levelRank(o.level) ? 1 : 0));
    const P = y.reduce<number>((a, b) => a + b, 0);
    const base: DriverOutcome = { level: o.level, label: o.label, n, positives: P, rate: n ? P / n : 0, factors: [] };
    if (P < MIN_CASES || n - P < MIN_CASES) {
      outcomes.push({ ...base, note: en ? `too few cases to analyse (${P} out of ${n})` : `trop peu de cas pour analyser (${P} sur ${n})` });
      continue;
    }
    const raw: Array<Omit<DriverFactor, "q">> = [];
    for (const d of dims) {
      const codes = rows.map((r) => d.codeOf(r.persona));
      const counts = new Map<string, number>();
      for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
      // Catégories trop petites regroupées pour le test (la description par valeur les garde)
      const testCodes = codes.map((c) => ((counts.get(c) ?? 0) < 5 ? "__small" : c));
      const levels = [...new Set(testCodes)];
      // Au moins deux catégories d'au moins 5 personas : sinon l'association repose sur une poignée de cas
      if (levels.filter((c) => c !== "__small").length < 2) continue;
      const k = levels.length;
      const ci = testCodes.map((c) => levels.indexOf(c));
      const chi = chiSquare(ci, y, k);
      const v = cramersVCorrected(chi, n, k);
      const rng = new Rng(`${opts.seed ?? "drivers"}:${o.level}:${d.id}`);
      const perm = [...y];
      let ge = 0;
      for (let b = 0; b < B; b++) {
        for (let i = perm.length - 1; i > 0; i--) {
          const j = rng.int(0, i);
          [perm[i], perm[j]] = [perm[j]!, perm[i]!];
        }
        if (chiSquare(ci, perm, k) >= chi - 1e-12) ge++;
      }
      const p = (ge + 1) / (B + 1);
      const ex = new Map<string, Persona>();
      rows.forEach((r, i) => ex.has(codes[i]!) || ex.set(codes[i]!, r.persona));
      const ordered = d.order ? d.order([...counts.keys()]) : [...counts.keys()].sort();
      const values: DriverValue[] = ordered.map((code) => {
        const inIdx = codes.map((c, i) => (c === code ? i : -1)).filter((i) => i >= 0);
        const nIn = inIdx.length;
        const pIn = inIdx.reduce((a, i) => a + y[i]!, 0);
        const nOut = n - nIn;
        const pOut = P - pIn;
        const rate = nIn ? pIn / nIn : 0;
        const restRate = nOut ? pOut / nOut : 0;
        return {
          code,
          label: d.labelOf(code, ex.get(code)),
          n: nIn,
          rate,
          ci: wilson(pIn, nIn),
          restN: nOut,
          restRate,
          diffPts: Math.round((rate - restRate) * 1000) / 10,
          small: nIn < minSeg || nOut < minSeg,
        };
      });
      const solid = values.filter((x) => !x.small);
      const best = (solid.length ? solid : values.filter((x) => x.n >= 5)).sort((a, b) => Math.abs(b.diffPts) - Math.abs(a.diffPts))[0];
      const sentence = en
        ? best
          ? `${d.label} = ${best.label}: ${o.short} ${pctEn(best.rate)} vs ${pctEn(best.restRate)} otherwise (n = ${best.n} / ${best.restN})${best.small ? ", small sample" : ""}`
          : `${d.label}: no value frequent enough`
        : best
          ? `${d.label} = ${best.label} : ${o.short} ${pctS(best.rate)} contre ${pctS(best.restRate)} sinon (n = ${best.n} / ${best.restN})${best.small ? ", effectif faible" : ""}`
          : `${d.label} : pas de valeur assez fréquente`;
      raw.push({ dimension: d.id, label: d.label, source: d.source, cramersV: Math.round(v * 1000) / 1000, p: Math.round(p * 10000) / 10000, values, sentence });
    }
    const q = benjaminiHochberg(raw.map((f) => f.p));
    const factors = raw
      .map((f, i) => ({ ...f, q: Math.round(q[i]! * 10000) / 10000 }))
      .sort((a, b) => Number(b.q < 0.1) - Number(a.q < 0.1) || b.cramersV - a.cramersV || a.p - b.p);
    outcomes.push({ ...base, factors });
  }
  return { group: opts.group ?? null, n, method: DRIVERS_METHOD, permutations: B, minSegment: minSeg, outcomes };
}

/** Texte console : les `top` premiers facteurs de chaque niveau. */
export function formatDrivers(d: DriversResult, top = 5): string[] {
  const out: string[] = [];
  out.push(`  ${d.method}`);
  for (const o of d.outcomes) {
    out.push("", `  ${o.label} : ${pctS(o.rate)} (${o.positives}/${o.n})`);
    if (o.note) {
      out.push(`    ${o.note}`);
      continue;
    }
    for (const [i, f] of o.factors.slice(0, top).entries()) {
      const sig = f.q < 0.05 ? "**" : f.q < 0.1 ? "*" : "";
      out.push(`    ${i + 1}. ${f.sentence}`);
      out.push(`       V = ${f.cramersV.toLocaleString("fr-FR")}, p = ${f.p.toLocaleString("fr-FR")}, q = ${f.q.toLocaleString("fr-FR")}${sig ? ` ${sig}` : ""}`);
    }
  }
  out.push("", "  ** q < 0,05 ; * q < 0,1 (sinon : à confirmer, petit échantillon).");
  return out;
}

export { LEVEL_LABELS };
