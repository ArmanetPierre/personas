import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { OLLAMA_MAX_CONCURRENCY } from "../config";
import { Rng } from "../personas/rng";
import type { LogprobClient } from "./client";
import {
  argmaxLabel,
  averageProbs,
  digitProbs,
  LABEL_ORDERS,
  RELEVANCE_LABELS,
  type LabelOrder,
  type RelevanceLabel,
  type RelevanceProbs,
} from "./relevance";

export * from "./relevance";
export { ollamaLogprobClient, type LogprobClient, type OllamaLogprobOptions } from "./client";

/**
 * Pré-tri bon marché de la pertinence (Qwen local, méthode A) : exécution avec cache et reprise,
 * estimation de la part « pas concerné·e » et profils typiques.
 */

/**
 * Seuil par persona sur P(pas concerné·e), pour lister les personas « probablement pas concernées »
 * (fiches à relire). Sur les cibles de la validation hors ligne : rappel 69 %, 13 % de faux « pas
 * concernés » (docs/architecture-v2.md, § Lot P1). La part estimée, elle, est la moyenne des P(NC).
 */
export const DEFAULT_NC_THRESHOLD = 0.3;
/** Alerte quand la part estimée de « pas concerné·e » dans la cible dépasse ce seuil. */
export const DEFAULT_ALERT_SHARE = 0.1;
/** En dessous de cette masse sur les chiffres, la réponse est jugée hors format (comptée, signalée). */
export const LOW_MASS = 0.5;

export function defaultCachePath(): string {
  return process.env.PERSONAS_TRIAGE_CACHE ?? resolve(import.meta.dirname, "../../data/triage/relevance.jsonl");
}

export interface TriageItem {
  /** Identifiant libre (id de persona, ou « étude:persona »). */
  id: string;
  /** Prompt système par ordre d'étiquettes (voir relevanceSystem). */
  system: Record<LabelOrder, string>;
  user: string;
}

export interface TriageResult {
  id: string;
  /** Moyenne des deux ordres. */
  probs: RelevanceProbs;
  byOrder: Partial<Record<LabelOrder, RelevanceProbs>>;
  /** Masse minimale des chiffres sur les deux ordres (avant renormalisation). */
  mass: number;
  label: RelevanceLabel;
}

export interface TriageRun {
  results: TriageResult[];
  failed: Array<{ id: string; error: string }>;
  calls: number;
  cached: number;
  ms: number;
  model: string;
}

interface CacheRow {
  key: string;
  model: string;
  order: LabelOrder;
  probs: RelevanceProbs;
  mass: number;
  token: string;
  ms: number;
}

const cacheKey = (model: string, order: LabelOrder, system: string, user: string) =>
  createHash("sha256").update(`${model}\0${order}\0${system}\0${user}`).digest("hex").slice(0, 32);

/** Cache JSONL en ajout seul : une ligne par appel réussi ; une ligne tronquée est refaite. */
export class TriageCache {
  private rows = new Map<string, CacheRow>();
  constructor(readonly path: string | null) {
    if (!path || !existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as CacheRow;
        this.rows.set(r.key, r);
      } catch {
        // arrêt brutal pendant l'écriture : la ligne sera refaite
      }
    }
  }
  get(key: string): CacheRow | undefined {
    return this.rows.get(key);
  }
  set(row: CacheRow): void {
    this.rows.set(row.key, row);
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(row) + "\n");
  }
  get size(): number {
    return this.rows.size;
  }
}

export interface TriageOptions {
  client: LogprobClient;
  /** Fichier de cache ; null : pas de cache disque. Défaut : data/triage/relevance.jsonl. */
  cachePath?: string | null;
  cache?: TriageCache;
  log?: (msg: string) => void;
  /** Arrêt après ce nombre d'échecs consécutifs (tunnel coupé…). */
  maxConsecutiveFailures?: number;
}

/**
 * Passe chaque item dans les deux ordres d'étiquettes (2 appels, ou 0 s'ils sont en cache).
 * Concurrence plafonnée à OLLAMA_MAX_CONCURRENCY (2). Les appels sont triés par ordre d'étiquettes
 * pour que le prompt système commun reste dans le cache de préfixe d'Ollama.
 */
export async function runTriage(items: TriageItem[], opts: TriageOptions): Promise<TriageRun> {
  const t0 = performance.now();
  const cache = opts.cache ?? new TriageCache(opts.cachePath === undefined ? defaultCachePath() : opts.cachePath);
  const model = opts.client.model;
  const tasks: Array<{ item: TriageItem; order: LabelOrder; key: string }> = [];
  let cached = 0;
  const planned = new Set<string>();
  for (const order of LABEL_ORDERS) {
    for (const item of items) {
      const key = cacheKey(model, order, item.system[order], item.user);
      if (cache.get(key)) cached++;
      else if (!planned.has(key)) {
        // Deux items au prompt identique ne coûtent qu'un appel
        planned.add(key);
        tasks.push({ item, order, key });
      }
    }
  }
  const failedIds = new Map<string, string>();
  const n = Math.max(1, Math.min(opts.client.concurrency ?? OLLAMA_MAX_CONCURRENCY, OLLAMA_MAX_CONCURRENCY));
  const maxFails = opts.maxConsecutiveFailures ?? 5;
  let consecutive = 0;
  let stop = false;
  let done = 0;
  const queue = [...tasks];
  const worker = async () => {
    while (!stop) {
      const t = queue.shift();
      if (!t) return;
      const c0 = performance.now();
      try {
        const r = await opts.client.firstToken(t.item.system[t.order], t.item.user);
        const { probs, mass } = digitProbs(r.top, t.order);
        if (mass <= 0) throw new Error(`réponse hors format (« ${r.content.slice(0, 20)} »)`);
        cache.set({ key: t.key, model, order: t.order, probs, mass, token: r.content, ms: Math.round(performance.now() - c0) });
        consecutive = 0;
      } catch (err) {
        failedIds.set(t.item.id, (err as Error).message.slice(0, 300));
        if (++consecutive >= maxFails) stop = true;
      }
      done++;
      if (opts.log && (done % 50 === 0 || done === tasks.length)) {
        const el = (performance.now() - t0) / 1000;
        opts.log(`tri : ${done}/${tasks.length} appels (${el.toFixed(0)} s, ${(el / done).toFixed(2)} s/appel)`);
      }
    }
  };
  if (tasks.length) await Promise.all(Array.from({ length: n }, worker));
  if (stop && queue.length) for (const t of queue) failedIds.set(t.item.id, failedIds.get(t.item.id) ?? "non tenté (trop d'échecs consécutifs)");

  const results: TriageResult[] = [];
  for (const item of items) {
    const byOrder: Partial<Record<LabelOrder, RelevanceProbs>> = {};
    let mass = 1;
    for (const order of LABEL_ORDERS) {
      const row = cache.get(cacheKey(model, order, item.system[order], item.user));
      if (row) {
        byOrder[order] = row.probs;
        mass = Math.min(mass, row.mass);
      }
    }
    if (!byOrder.direct || !byOrder.reverse) continue;
    const probs = averageProbs([byOrder.direct, byOrder.reverse]);
    results.push({ id: item.id, probs, byOrder, mass, label: argmaxLabel(probs) });
  }
  const ok = new Set(results.map((r) => r.id));
  return {
    results,
    failed: [...failedIds].filter(([id]) => !ok.has(id)).map(([id, error]) => ({ id, error })),
    calls: tasks.length,
    cached,
    ms: Math.round(performance.now() - t0),
    model,
  };
}

// ─── Estimation ───────────────────────────────────────────────────────────────

export interface ShareEstimate {
  /**
   * Part estimée de personas « pas concernées » : moyenne des P(NC). C'est l'estimateur retenu
   * (écart moyen de 4 points à Claude sur 5 cibles), les comptes au seuil étant biaisés.
   */
  share: number;
  /** Intervalle à 95 % (bootstrap sur les personas, graine fixe). */
  ci: [number, number];
  /** Personas au-dessus du seuil (à relire), et leur part. */
  flagged: number;
  flaggedShare: number;
  n: number;
  threshold: number;
  /** Répartition par étiquette la plus probable. */
  argmax: Record<RelevanceLabel, number>;
}

export function estimateNotConcerned(results: TriageResult[], threshold = DEFAULT_NC_THRESHOLD, resamples = 2000): ShareEstimate {
  const n = results.length;
  const probs = results.map((r) => r.probs.not_concerned);
  const flagged = probs.filter((p) => p >= threshold).length;
  const argmax: Record<RelevanceLabel, number> = { concerned: 0, marginal: 0, not_concerned: 0 };
  for (const r of results) argmax[r.label]++;
  if (!n) return { share: 0, ci: [0, 1], flagged, flaggedShare: 0, n, threshold, argmax };
  const share = probs.reduce((a, b) => a + b, 0) / n;
  const rng = new Rng(`triage-bootstrap:${n}:${Math.round(share * 1e6)}`);
  const means: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += probs[rng.int(0, n - 1)]!;
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  const q = (x: number) => means[Math.min(means.length - 1, Math.max(0, Math.round(x * (means.length - 1))))]!;
  return { share, ci: [q(0.025), q(0.975)], flagged, flaggedShare: flagged / n, n, threshold, argmax };
}

// ─── Profils typiques ─────────────────────────────────────────────────────────

export interface ProfileDimension {
  key: string;
  label: string;
  /** Code et libellé de la valeur pour une persona (null : dimension non applicable). */
  value(id: string): { code: string; label: string } | null;
}

export interface ProfileGroup {
  criteria: Array<{ key: string; label: string; value: string; valueLabel: string }>;
  /** Personas du groupe dans l'échantillon trié. */
  n: number;
  /** Nombre attendu de « pas concernées » dans le groupe (somme des P(NC)). */
  expected: number;
  /** Part estimée de « pas concernées » dans le groupe (moyenne des P(NC)). */
  rate: number;
  /** Rapport à la part globale. */
  lift: number;
  /** Part des « pas concernées » attendues que le groupe explique. */
  coverage: number;
  /** Personas du groupe présentes dans la liste à relire (les plus probablement pas concernées). */
  inReview: number;
  /** Personas du groupe les plus probablement pas concernées. */
  examples: string[];
}

/**
 * Liste à relire : les personas les plus probablement pas concernées, au moins 10, et au moins autant
 * que la part estimée en annonce (un petit groupe très concentré y apparaît même s'il pèse peu).
 */
export function reviewList(results: TriageResult[], share?: number): string[] {
  const k = Math.min(results.length, Math.max(10, Math.round((share ?? 0) * results.length)));
  return [...results].sort((a, b) => b.probs.not_concerned - a.probs.not_concerned).slice(0, k).map((r) => r.id);
}

/**
 * Groupes de personas sur-représentés parmi les « pas concernées » (valeurs simples et couples de
 * valeurs) : soit au moins `minExpected` « pas concernées » attendues et une part au moins `minLift`
 * fois la part globale ; soit un petit groupe concentré, dont au moins 2 personas et la moitié des
 * membres sont dans la liste à relire (`reviewList`). Un couple n'est gardé que s'il resserre
 * nettement sa valeur simple. Triés par « pas concernées » expliquées × concentration.
 */
export function profileGroups(
  results: TriageResult[],
  dims: ProfileDimension[],
  opts: { minExpected?: number; minLift?: number; max?: number } = {},
): ProfileGroup[] {
  const minExpected = opts.minExpected ?? 2.5;
  const minLift = opts.minLift ?? 1.5;
  const total = results.length;
  const pr = results.map((r) => r.probs.not_concerned);
  const totalExpected = pr.reduce((a, b) => a + b, 0);
  if (!total || totalExpected <= 0) return [];
  const base = totalExpected / total;
  const review = new Set(reviewList(results, base));
  const values = new Map<string, Array<{ code: string; label: string } | null>>();
  for (const d of dims) values.set(d.key, results.map((r) => d.value(r.id)));

  type Cand = { cells: Array<[ProfileDimension, { code: string; label: string }]>; members: number[] };
  const singles: Cand[] = [];
  for (const d of dims) {
    const byCode = new Map<string, { label: string; members: number[] }>();
    values.get(d.key)!.forEach((v, i) => {
      if (!v) return;
      const g = byCode.get(v.code) ?? { label: v.label, members: [] };
      g.members.push(i);
      byCode.set(v.code, g);
    });
    for (const [code, g] of byCode) singles.push({ cells: [[d, { code, label: g.label }]], members: g.members });
  }
  const stat = (c: Cand): ProfileGroup => {
    const expected = c.members.reduce((a, i) => a + pr[i]!, 0);
    const rate = expected / c.members.length;
    return {
      criteria: c.cells.map(([d, v]) => ({ key: d.key, label: d.label, value: v.code, valueLabel: v.label })),
      n: c.members.length,
      expected,
      rate,
      lift: rate / base,
      coverage: expected / totalExpected,
      inReview: c.members.filter((i) => review.has(results[i]!.id)).length,
      examples: [...c.members].sort((a, b) => pr[b]! - pr[a]!).slice(0, 3).map((i) => results[i]!.id),
    };
  };
  const concentrated = (g: ProfileGroup) => g.inReview >= 2 && g.inReview / g.n >= 0.5;
  const keep = (g: ProfileGroup) => g.n < total && ((g.expected >= minExpected && g.lift >= minLift) || concentrated(g));
  const goodSingles = singles.map((c) => ({ c, g: stat(c) })).filter(({ g }) => keep(g));
  const out: ProfileGroup[] = goodSingles.map(({ g }) => g);
  for (const { c: a, g: ga } of goodSingles) {
    for (const b of singles) {
      if (b.cells[0]![0].key === a.cells[0]![0].key) continue;
      const set = new Set(b.members);
      const members = a.members.filter((i) => set.has(i));
      if (!members.length) continue;
      const g = stat({ cells: [...a.cells, ...b.cells], members });
      if (keep(g) && !concentrated(ga) && g.rate >= Math.max(ga.rate * 1.25, 0.5) && g.expected >= ga.expected * 0.5) out.push(g);
    }
  }
  const score = (g: ProfileGroup) => g.expected * g.rate + (g.inReview * g.inReview) / g.n;
  const seen = new Set<string>();
  return out
    .filter((g) => {
      const k = g.criteria.map((c) => `${c.key}=${c.value}`).sort().join("&");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => score(y) - score(x) || y.lift - x.lift)
    .slice(0, opts.max ?? 8);
}

// ─── Accord avec une référence (validation hors ligne) ────────────────────────

export interface AgreementReport {
  n: number;
  /** Accord exact de l'étiquette la plus probable. */
  exact: number;
  /** Kappa pondéré quadratique (ordre concerné < marginal < pas concerné). */
  qwk: number;
  /** Au seuil : rappel des « pas concernés » de la référence. */
  recallNc: number;
  /** Au seuil : précision des signalés. */
  precisionNc: number;
  /** Au seuil : part des personas concernées ou marginales (référence) signalées à tort. */
  falseNcRate: number;
  refShare: number;
  estShare: number;
  /** Moyenne des P(NC) : l'estimateur de la part retenu. */
  meanProb: number;
  /** Aire sous la courbe ROC de P(NC) pour retrouver les « pas concernés » de la référence (classement). */
  auc: number;
  confusion: Record<RelevanceLabel, Record<RelevanceLabel, number>>;
}

export function agreement(pairs: Array<{ ref: RelevanceLabel; result: TriageResult }>, threshold = DEFAULT_NC_THRESHOLD): AgreementReport {
  const idx = (l: RelevanceLabel) => RELEVANCE_LABELS.indexOf(l);
  const n = pairs.length;
  const confusion = Object.fromEntries(RELEVANCE_LABELS.map((r) => [r, Object.fromEntries(RELEVANCE_LABELS.map((p) => [p, 0]))])) as AgreementReport["confusion"];
  let exact = 0;
  let tp = 0;
  let fp = 0;
  let refNc = 0;
  let refOther = 0;
  let meanProb = 0;
  for (const { ref, result } of pairs) {
    confusion[ref][result.label]++;
    if (ref === result.label) exact++;
    const flag = result.probs.not_concerned >= threshold;
    meanProb += result.probs.not_concerned / Math.max(1, n);
    if (ref === "not_concerned") {
      refNc++;
      if (flag) tp++;
    } else {
      refOther++;
      if (flag) fp++;
    }
  }
  // Kappa quadratique
  const k = RELEVANCE_LABELS.length;
  const rowM = RELEVANCE_LABELS.map((r) => RELEVANCE_LABELS.reduce((a, p) => a + confusion[r][p], 0));
  const colM = RELEVANCE_LABELS.map((p) => RELEVANCE_LABELS.reduce((a, r) => a + confusion[r][p], 0));
  let obs = 0;
  let exp = 0;
  for (const r of RELEVANCE_LABELS) {
    for (const p of RELEVANCE_LABELS) {
      const w = ((idx(r) - idx(p)) / (k - 1)) ** 2;
      obs += w * confusion[r][p];
      exp += (w * rowM[idx(r)]! * colM[idx(p)]!) / Math.max(1, n);
    }
  }
  return {
    n,
    exact: exact / Math.max(1, n),
    qwk: exp > 0 ? 1 - obs / exp : 1,
    recallNc: refNc ? tp / refNc : NaN,
    precisionNc: tp + fp ? tp / (tp + fp) : NaN,
    falseNcRate: refOther ? fp / refOther : NaN,
    refShare: refNc / Math.max(1, n),
    estShare: (tp + fp) / Math.max(1, n),
    meanProb,
    auc: rocAuc(pairs.map((x) => ({ score: x.result.probs.not_concerned, positive: x.ref === "not_concerned" }))),
    confusion,
  };
}

export function rocAuc(rows: Array<{ score: number; positive: boolean }>): number {
  const pos = rows.filter((r) => r.positive).map((r) => r.score);
  const neg = rows.filter((r) => !r.positive).map((r) => r.score);
  if (!pos.length || !neg.length) return NaN;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
