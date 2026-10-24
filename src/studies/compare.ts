import { BEHAVIOR_LABELS, BEHAVIORS, behaviorRank, hasV3Measures, OBJECTION_CATEGORIES, OBJECTION_LABELS, type Behavior, type ObjectionCategory } from "./protocols/concept-price";
import { COMPARE_DIMENSIONS, DIMENSION_LABELS, type SegmentDimension } from "./segments";
import { formatMoney, fxOf, monthlyFactor, referenceOffer, type Pricing } from "./price-model";
import type { Analysis, Distribution, StudySummary } from "./summary";
import { CONFIDENCE_LABELS, pct1, type PaymentMeasure } from "./payment";
import type { ConfidenceLevel } from "./confidence";
import { CANONICAL_LEVELS, CANONICAL_OBJECTIONS, LEGACY_PROTOCOL, LEVEL_LABELS, protocolTools, type CanonicalLevel, type CanonicalObjection, type ResolvedProtocol } from "./protocols/protocol";

/**
 * Comparaison de plusieurs études (variantes d'une offre) sur un même groupe de personas.
 * La première étude sert de référence : chaque indicateur est donné en valeur et en écart,
 * en points de pourcentage. Fonctions pures, réutilisables par le tableau de bord.
 */

/** Dimensions comparées par défaut : celles que les modules marquent `compare` (voir segments.ts). */
export { COMPARE_DIMENSIONS };

export interface SegmentStat {
  code: string;
  label: string;
  n: number;
  freeSignupOrMore: number;
  payers: number;
}

export interface CompareEntry {
  studyId: string;
  studyName: string;
  projectId: string;
  projectName: string;
  /** Moteur de l'étude : fournisseur / modèle (modèle exact rapporté par l'API s'il est connu). */
  model: string;
  price: string;
  priceUnit: string;
  /** Groupe analysé (null : toute l'étude). */
  group: string | null;
  n: number;
  /** Codes de l'échelle du protocole de l'étude (historique : `Behavior`). */
  behaviors: Record<string, number>;
  freeSignupOrMore: number;
  /** Payeurs au prix affiché (paie ou paie et recommande). */
  payers: number;
  notConcerned: number;
  forward: number | null;
  gaborGranger: Array<{ price: number; demand: number; revenuePer100: number }>;
  vanWestendorp: { n: number; neverPayShare: number; pmc: number | null; opp: number | null; ipp: number | null; pme: number | null };
  objections: Record<string, number>;
  objectionsPerRespondent: number;
  segments: Record<string, SegmentStat[]>;
  anomalies: number;
  /** Protocole propre au projet (absent : historique), et parts par niveau et catégorie canoniques. */
  protocol?: ResolvedProtocol;
  levels?: Record<CanonicalLevel, number>;
  objectionsCanonical?: Record<CanonicalObjection, number>;
  /** Libellés des comportements adaptés à l'unité (achat unique, commande, usage), hors abonnement. */
  behaviorLabels?: Record<Behavior, string>;
  /** Devise (ajout phase 2b, présent seulement pour un projet au modèle de prix générique). */
  currency?: string;
  /** Facteur qui convertit un prix de l'offre de référence en coût mensuel équivalent en euros (null : non normalisable). */
  monthlyEurFactor?: number | null;
  /** Ajouts v3 (aussi pour les études v2) : version du protocole, double mesure du paiement, fréquence du besoin, indice de confiance. */
  protocolVersion?: string;
  payment?: PaymentMeasure;
  needFrequency?: { recurringShare: number; rareShare: number; shares: Record<string, number> };
  confidence?: { level: ConfidenceLevel; label: string; score: number; warning: string | null };
}

/** Écarts à la référence, en points de pourcentage (null si non comparable). */
export interface CompareDelta {
  studyId: string;
  behaviors: Record<string, number>;
  freeSignupOrMore: number;
  payers: number;
  notConcerned: number;
  forward: number | null;
  vwNeverPay: number;
  /** Écarts par niveau canonique (échelles différentes seulement). */
  levels?: Record<CanonicalLevel, number>;
  objectionsCanonical?: Record<CanonicalObjection, number>;
  /** Par palier de même prix que la référence ; null si le palier n'existe pas dans la référence. */
  gaborGranger: Array<{ price: number; demand: number | null }>;
  objections: Record<string, number>;
  segments: Record<string, Array<{ code: string; freeSignupOrMore: number | null; payers: number | null }>>;
  /** Écarts de G (oui au palier bas, même prix seulement) et de M2, en points ; null si non comparable. */
  lowTierYes?: number | null;
  paymentEstimated?: number | null;
}

export interface Comparison {
  referenceId: string;
  group: string | null;
  /** Les études n'ont pas toutes la même unité de prix : Gabor-Granger et Van Westendorp ne se comparent pas directement. */
  unitsDiffer: boolean;
  /** Effectifs différents d'une étude à l'autre (étude incomplète, autre échantillon). */
  sizesDiffer: boolean;
  entries: CompareEntry[];
  deltas: CompareDelta[];
  /** Échelles de comportements ou taxonomies différentes : comparaison par niveaux canoniques (présent seulement dans ce cas). */
  scalesDiffer?: true;
  /** Normalisation optionnelle (coût mensuel équivalent en euros), seulement si elle est demandée. */
  normalization?: Normalization;
  /** Mesures de protocole différentes (v2 face à v3 ou v4) : niveaux absolus non comparables (présent seulement dans ce cas). v3 et v4 ont la même mesure. */
  protocolsDiffer?: true;
}

export interface Normalization {
  mode: "monthly-eur";
  warning: string;
  entries: Array<{
    studyId: string;
    /** Facteur appliqué aux prix de l'étude ; null si l'unité ne se ramène pas à un coût mensuel. */
    factor: number | null;
    gaborGranger: Array<{ price: number; monthlyEur: number | null; demand: number }>;
    vanWestendorp: { opp: number | null; ipp: number | null };
  }>;
}

/** Analyse du groupe demandé ; une étude à groupe unique est analysée en entier. */
export function pickAnalysis(s: StudySummary, group?: string): { analysis: Analysis; group: string | null } {
  if (group && s.groups.length) {
    const g = s.groups.find((x) => x.group === group);
    if (!g) throw new Error(`L'étude ${s.study.id} n'a pas de groupe « ${group} » (groupes : ${s.groups.map((x) => x.group).join(", ")}).`);
    return { analysis: g.analysis, group };
  }
  return { analysis: s.overall, group: s.groups.length ? null : (group ?? null) };
}

/** Part d'un segment au moins à un niveau canonique, selon le protocole de l'étude. */
const atLeast = (d: Distribution<string>, l: CanonicalLevel, proto: ResolvedProtocol) => {
  const t = protocolTools(proto);
  return t.behaviorCodes.filter((x) => t.atLeast(x, l)).reduce((a, x) => a + (d.shares[x] ?? 0), 0);
};

/** Répartition par niveau canonique et par catégorie canonique d'objection, pour comparer des échelles différentes. */
export function canonicalShares(a: Analysis, proto: ResolvedProtocol): { levels: Record<CanonicalLevel, number>; objections: Record<CanonicalObjection, number> } {
  const t = protocolTools(proto);
  const levels = Object.fromEntries(CANONICAL_LEVELS.map((l) => [l, 0])) as Record<CanonicalLevel, number>;
  for (const code of t.behaviorCodes) levels[t.level(code)] += a.behaviors.overall.shares[code] ?? 0;
  const objections = a.objections.canonical
    ? { ...a.objections.canonical.shares }
    : (Object.fromEntries(CANONICAL_OBJECTIONS.map((c) => [c, a.objections.overall.shares[c] ?? 0])) as Record<CanonicalObjection, number>);
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return {
    levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, r(v)])) as Record<CanonicalLevel, number>,
    objections: Object.fromEntries(Object.entries(objections).map(([k, v]) => [k, r(v)])) as Record<CanonicalObjection, number>,
  };
}

/**
 * Équivalences entre dimensions de segment, pour comparer une étude v1 (pack fr-tech-founders,
 * attributs `extra.founder`) à une étude v2 (modules `entrepreneuriat` et `numerique`) :
 * mêmes notions, noms et parfois codes différents. Sans effet entre études d'une même génération.
 */
export const SEGMENT_ALIASES: Record<string, { dim: string; codes?: Record<string, string> }> = {
  entrepreneurStage: { dim: "projectStage", codes: { launched: "launched_solo" } },
  entrepreneurTeam: { dim: "teamPreference" },
  digitalStatus: { dim: "workStatus" },
};

/** Facteur prix de référence → coût mensuel en euros, pour un résumé (historique : mois = 1, an = 1/12). */
export function monthlyEurFactorOf(project: StudySummary["project"]): number | null {
  const p: Pricing | undefined = project.pricing;
  if (p) {
    const f = monthlyFactor(referenceOffer(p));
    const fx = fxOf(p);
    return f === null || !fx ? null : f * fx.eurPerUnit;
  }
  return project.pricePeriod === "month" || !project.pricePeriod ? 1 : project.pricePeriod === "year" ? 1 / 12 : null;
}

const priceKey = (e: Pick<CompareEntry, "priceUnit" | "currency">) => `${e.currency ?? "EUR"}|${e.priceUnit}`;

export function toEntry(s: StudySummary, group?: string): CompareEntry {
  const { analysis: a, group: g } = pickAnalysis(s, group);
  const proto = s.protocol ?? LEGACY_PROTOCOL;
  const segments: Record<string, SegmentStat[]> = {};
  for (const dim of COMPARE_DIMENSIONS) {
    const rows = a.behaviors.bySegment[dim];
    if (!rows) continue;
    // Une dimension de module équivalente à une dimension du pack v1 est rangée sous le même nom
    const alias = SEGMENT_ALIASES[dim];
    const key = alias?.dim ?? dim;
    if (segments[key]) continue;
    segments[key] = rows.map((r) => ({
      code: alias?.codes?.[r.code] ?? r.code,
      label: r.label,
      n: r.n,
      freeSignupOrMore: atLeast(r.value, "free_trial", proto),
      payers: atLeast(r.value, "payment", proto),
    }));
  }
  return {
    studyId: s.study.id,
    studyName: s.study.name,
    projectId: s.project.id,
    projectName: s.project.name,
    model: `${s.study.backend} / ${s.study.engine?.reportedModel ?? s.study.model}`,
    price: s.project.price,
    priceUnit: s.project.priceUnit ?? "mois",
    group: g,
    n: a.n,
    behaviors: { ...a.behaviors.overall.shares },
    freeSignupOrMore: a.behaviors.freeSignupOrMore,
    payers: a.behaviors.payers,
    notConcerned: a.relevance.notConcernedShare,
    forward: a.forward?.n ? a.forward.share : null,
    gaborGranger: a.gaborGranger.tiers.map((t) => ({ price: t.price, demand: t.demand, revenuePer100: t.revenuePer100 })),
    vanWestendorp: {
      n: a.vanWestendorp.n,
      neverPayShare: a.vanWestendorp.neverPayShare,
      pmc: a.vanWestendorp.pmc,
      opp: a.vanWestendorp.opp,
      ipp: a.vanWestendorp.ipp,
      pme: a.vanWestendorp.pme,
    },
    objections: { ...a.objections.overall.shares },
    objectionsPerRespondent: a.objections.perRespondent,
    segments,
    anomalies: a.anomalies.rate,
    ...(s.project.currency && { currency: s.project.currency, monthlyEurFactor: monthlyEurFactorOf(s.project) }),
    ...(s.project.behaviorLabels && { behaviorLabels: s.project.behaviorLabels }),
    ...(s.protocol && (() => {
      const c = canonicalShares(a, s.protocol!);
      return { protocol: s.protocol!, levels: c.levels, objectionsCanonical: c.objections };
    })()),
    ...(s.protocolVersion && { protocolVersion: s.protocolVersion }),
    ...(a.payment && { payment: a.payment }),
    ...(a.needFrequency && { needFrequency: { recurringShare: a.needFrequency.recurringShare, rareShare: a.needFrequency.rareShare, shares: a.needFrequency.shares } }),
    ...(s.confidence && { confidence: { level: s.confidence.level, label: s.confidence.label, score: s.confidence.score, warning: s.confidence.sample.warning } }),
  };
}

/** Écart en points de pourcentage, arrondi au dixième. */
export const pts = (x: number, ref: number) => Math.round((x - ref) * 1000) / 10;

/** Signature d'échelle d'une entrée (historique si absente). */
const scaleOf = (e: CompareEntry) => (e.protocol ?? LEGACY_PROTOCOL).signature;

/** Niveaux et catégories canoniques d'une entrée historique (codes historiques = catégories canoniques). */
function withCanonical(e: CompareEntry): CompareEntry {
  if (e.levels) return e;
  const t = protocolTools(LEGACY_PROTOCOL);
  const levels = Object.fromEntries(CANONICAL_LEVELS.map((l) => [l, 0])) as Record<CanonicalLevel, number>;
  for (const code of t.behaviorCodes) levels[t.level(code)] += e.behaviors[code] ?? 0;
  const r = (x: number) => Math.round(x * 10000) / 10000;
  return {
    ...e,
    levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, r(v)])) as Record<CanonicalLevel, number>,
    objectionsCanonical: Object.fromEntries(CANONICAL_OBJECTIONS.map((c) => [c, e.objections[c] ?? 0])) as Record<CanonicalObjection, number>,
  };
}

export function compareEntries(entriesIn: CompareEntry[]): Comparison {
  if (!entriesIn.length) throw new Error("Aucune étude à comparer.");
  // Échelles différentes : chaque entrée reçoit ses parts par niveau canonique (ajout seulement dans ce cas)
  const scalesDiffer = new Set(entriesIn.map(scaleOf)).size > 1;
  const entries = scalesDiffer ? entriesIn.map(withCanonical) : entriesIn;
  const ref = entries[0]!;
  const keysOf = (r: Record<string, number>) => Object.keys(r);
  const shared = (a: Record<string, number>, b: Record<string, number>) => keysOf(a).filter((k) => k in b);
  const deltas = entries.map((e): CompareDelta => ({
    studyId: e.studyId,
    behaviors: Object.fromEntries(shared(e.behaviors, ref.behaviors).map((b) => [b, pts(e.behaviors[b]!, ref.behaviors[b]!)])),
    freeSignupOrMore: pts(e.freeSignupOrMore, ref.freeSignupOrMore),
    payers: pts(e.payers, ref.payers),
    notConcerned: pts(e.notConcerned, ref.notConcerned),
    forward: e.forward !== null && ref.forward !== null ? pts(e.forward, ref.forward) : null,
    vwNeverPay: pts(e.vanWestendorp.neverPayShare, ref.vanWestendorp.neverPayShare),
    gaborGranger: e.gaborGranger.map((t) => {
      const r = priceKey(e) === priceKey(ref) ? ref.gaborGranger.find((x) => x.price === t.price) : undefined;
      return { price: t.price, demand: r ? pts(t.demand, r.demand) : null };
    }),
    objections: Object.fromEntries(shared(e.objections, ref.objections).map((c) => [c, pts(e.objections[c]!, ref.objections[c]!)])),
    ...(scalesDiffer && {
      levels: Object.fromEntries(CANONICAL_LEVELS.map((l) => [l, pts(e.levels![l], ref.levels![l])])) as Record<CanonicalLevel, number>,
      objectionsCanonical: Object.fromEntries(CANONICAL_OBJECTIONS.map((c) => [c, pts(e.objectionsCanonical![c], ref.objectionsCanonical![c])])) as Record<CanonicalObjection, number>,
    }),
    segments: Object.fromEntries(
      Object.entries(e.segments).map(([dim, segs]) => [
        dim,
        segs.map((sg) => {
          const r = ref.segments[dim]?.find((x) => x.code === sg.code);
          return { code: sg.code, freeSignupOrMore: r ? pts(sg.freeSignupOrMore, r.freeSignupOrMore) : null, payers: r ? pts(sg.payers, r.payers) : null };
        }),
      ]),
    ),
    ...((e.payment || ref.payment) && {
      lowTierYes:
        e.payment?.lowTierYes && ref.payment?.lowTierYes && e.payment.lowTierYes.price === ref.payment.lowTierYes.price && priceKey(e) === priceKey(ref)
          ? pts(e.payment.lowTierYes.share, ref.payment.lowTierYes.share)
          : null,
      paymentEstimated: e.payment?.estimated && ref.payment?.estimated ? pts(e.payment.estimated.value, ref.payment.estimated.value) : null,
    }),
  }));
  // v4 = mesure v3 (seul le bloc des attributs de module change) : seul un mélange avec la v2 rend les niveaux incomparables
  const versions = new Set(entries.map((e) => (hasV3Measures(e.protocolVersion) ? "3" : "2")));
  return {
    referenceId: ref.studyId,
    group: ref.group,
    unitsDiffer: new Set(entries.map(priceKey)).size > 1,
    sizesDiffer: new Set(entries.map((e) => e.n)).size > 1,
    ...(scalesDiffer && { scalesDiffer: true as const }),
    ...(versions.size > 1 && { protocolsDiffer: true as const }),
    entries,
    deltas,
  };
}

export const NORMALIZATION_WARNING =
  "Normalisation indicative en coût mensuel équivalent en euros (taux de change fixes, fréquence d'achat déclarée) : elle aide à situer les prix, elle ne rend pas les études strictement comparables.";

export function compareSummaries(summaries: StudySummary[], group?: string, opts: { normalize?: "monthly-eur" } = {}): Comparison {
  const entries = summaries.map((s) => toEntry(s, group));
  const c = compareEntries(entries);
  if (opts.normalize !== "monthly-eur") return c;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    ...c,
    normalization: {
      mode: "monthly-eur",
      warning: NORMALIZATION_WARNING,
      entries: summaries.map((s, i) => {
        const e = entries[i]!;
        const f = monthlyEurFactorOf(s.project);
        const conv = (x: number | null) => (x === null || f === null ? null : r2(x * f));
        return {
          studyId: e.studyId,
          factor: f,
          gaborGranger: e.gaborGranger.map((t) => ({ price: t.price, monthlyEur: conv(t.price), demand: t.demand })),
          vanWestendorp: { opp: conv(e.vanWestendorp.opp), ipp: conv(e.vanWestendorp.ipp) },
        };
      }),
    },
  };
}

// ─── Affichage console ────────────────────────────────────────────────────────

const pct = (x: number) => `${Math.round(x * 100)} %`;
const signed = (d: number | null) => (d === null ? "" : d === 0 ? " (=)" : ` (${d > 0 ? "+" : ""}${d.toLocaleString("fr-FR")})`);
const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);
const eur = (x: number | null) => (x === null ? "—" : `${x.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €`);

/** Libellé commun d'un comportement ; neutre si les études n'ont pas le même type de prix. */
export function compareBehaviorLabel(entries: Array<Pick<CompareEntry, "behaviorLabels">>, b: Behavior): string {
  const labels = new Set(entries.map((e) => (e.behaviorLabels ?? BEHAVIOR_LABELS)[b]));
  if (labels.size === 1) return [...labels][0]!;
  return b === "pay_subscription" ? "Paierait au prix affiché" : b === "recommend" ? "Paierait et le recommanderait" : BEHAVIOR_LABELS[b];
}

/** Montant dans la devise d'une étude (« 5 € », « 24 SGD »). */
const moneyOf = (e: Pick<CompareEntry, "currency">) => (x: number | null) => (x === null ? "—" : e.currency && e.currency !== "EUR" ? formatMoney(x, e.currency) : eur(x));

export function formatComparison(c: Comparison): string {
  const W = 22;
  const L = 40;
  const out: string[] = [];
  const cols = c.entries;
  const header = (t: string) => out.push("", t, "─".repeat(Math.min(L + W * cols.length, 120)));
  const row = (label: string, cell: (e: CompareEntry, i: number) => string) =>
    out.push(`  ${pad(label, L)}${cols.map((e, i) => " " + padL(cell(e, i), W - 1)).join("")}`);

  out.push(`Comparaison de ${cols.length} études${c.group ? `, groupe « ${c.group} »` : ""} ; référence ${c.referenceId}. Écarts en points entre parenthèses.`);
  out.push("⚠ Signaux qualitatifs issus de personas synthétiques : comparer des variantes, pas prévoir une conversion.");
  if (c.unitsDiffer) out.push("⚠ Unités de prix différentes : Gabor-Granger et Van Westendorp ne se comparent pas directement entre ces études.");
  if (c.sizesDiffer) out.push("⚠ Effectifs différents d'une étude à l'autre : vérifier que toutes les études sont complètes.");
  if (c.protocolsDiffer) out.push("⚠ Versions de protocole différentes (v2 et v3 ou v4) : les niveaux absolus ne se comparent pas ; lire les objections et les segments.");
  out.push("");
  for (const [i, e] of cols.entries()) out.push(`  [${i}] ${e.studyId}  ${e.projectName} (${e.projectId}) — ${e.price} ; n = ${e.n} ; ${e.model}`);

  const d = (i: number) => c.deltas[i]!;
  const id = (_: CompareEntry, i: number) => `[${i}] ${cols[i]!.studyId}`;
  header("Comportement dans les 7 jours");
  row("", id);
  if (c.scalesDiffer) {
    out.push("  Échelles de comportements différentes : comparaison par niveau canonique.");
    for (const l of CANONICAL_LEVELS) row(LEVEL_LABELS[l], (e, i) => `${pct(e.levels![l])}${i ? signed(d(i).levels![l]) : ""}`);
  } else {
    const p0 = cols[0]!.protocol;
    const codes = p0 ? p0.behaviors.map((b) => b.code) : [...BEHAVIORS];
    for (const b of codes) row(p0 ? p0.behaviors.find((x) => x.code === b)!.label : compareBehaviorLabel(cols, b as Behavior), (e, i) => `${pct(e.behaviors[b] ?? 0)}${i ? signed(d(i).behaviors[b] ?? null) : ""}`);
  }
  row("≥ inscription gratuite", (e, i) => `${pct(e.freeSignupOrMore)}${i ? signed(d(i).freeSignupOrMore) : ""}`);
  row("Payeurs au prix affiché", (e, i) => `${pct(e.payers)}${i ? signed(d(i).payers) : ""}`);
  if (cols.some((e) => e.payment)) {
    // M1 n'est jamais lu seul : G au palier bas, M2 et son statut, indice de confiance
    row("Oui au palier bas (G)", (e, i) => (e.payment?.lowTierYes ? `${moneyOf(e)(e.payment.lowTierYes.price)} : ${pct1(e.payment.lowTierYes.share)}${i ? signed(d(i).lowTierYes ?? null) : ""}` : "—"));
    row("Part payante estimée (M2)", (e, i) => (e.payment?.estimated ? `${pct1(e.payment.estimated.value)}${i ? signed(d(i).paymentEstimated ?? null) : ""}` : "—"));
    row("  intervalle à 95 %", (e) => (e.payment?.estimated ? `[${pct1(e.payment.estimated.ci[0])} ; ${pct1(e.payment.estimated.ci[1])}]` : "—"));
    row("  statut, confiance", (e) => (e.payment?.estimated ? `${e.payment.estimated.calibration.status === "calibrated" ? "calibrée" : "non calibrée"}, ${CONFIDENCE_LABELS[e.payment.estimated.confidence]}` : "—"));
  }
  if (cols.some((e) => e.needFrequency)) row("Besoin au moins mensuel", (e) => (e.needFrequency ? pct(e.needFrequency.recurringShare) : "—"));
  if (cols.some((e) => e.confidence)) row("Indice de confiance (niveaux)", (e) => (e.confidence ? `${e.confidence.label} (${e.confidence.score}/3)${e.confidence.warning ? " ⚠ n" : ""}` : "—"));
  if (cols.some((e) => e.payment)) out.push("  M2 et l'indice : voir study:summary. Écarts entre variantes fiables ; niveaux absolus indicatifs.");
  row("Pas concernées", (e, i) => `${pct(e.notConcerned)}${i ? signed(d(i).notConcerned) : ""}`);
  row("Transmettrait l'offre", (e, i) => (e.forward === null ? "—" : `${pct(e.forward)}${i ? signed(d(i).forward) : ""}`));

  header("Gabor-Granger (part qui paierait à chaque palier)");
  const maxTiers = Math.max(...cols.map((e) => e.gaborGranger.length));
  for (let k = 0; k < maxTiers; k++) {
    row(`Palier ${k + 1}`, (e, i) => {
      const t = e.gaborGranger[k];
      if (!t) return "—";
      const dd = i ? d(i).gaborGranger[k]?.demand ?? null : null;
      return `${moneyOf(e)(t.price)} : ${pct(t.demand)}${signed(dd)}`;
    });
  }
  row("Unité", (e) => `par ${e.priceUnit}`);
  row("Revenu max. / 100 exposés", (e) => {
    const best = e.gaborGranger.reduce<CompareEntry["gaborGranger"][number] | null>((b, t) => (!b || t.revenuePer100 > b.revenuePer100 ? t : b), null);
    return best && best.revenuePer100 > 0 ? `${moneyOf(e)(best.revenuePer100)} à ${moneyOf(e)(best.price)}` : "—";
  });
  if (c.normalization) {
    const n = c.normalization;
    out.push("", `  ⚠ ${n.warning}`);
    for (let k = 0; k < maxTiers; k++) {
      row(`Palier ${k + 1} en €/mois équivalent`, (_, i) => {
        const t = n.entries[i]?.gaborGranger[k];
        return !t ? "—" : t.monthlyEur === null ? "non normalisable" : `${eur(t.monthlyEur)} : ${pct(t.demand)}`;
      });
    }
  }

  header("Van Westendorp (répondants qui paieraient à un prix donné)");
  row("Ne paierait à aucun prix", (e, i) => `${pct(e.vanWestendorp.neverPayShare)}${i ? signed(d(i).vwNeverPay) : ""}`);
  row("Répondants", (e) => String(e.vanWestendorp.n));
  row("PMC (bon marché marginal)", (e) => moneyOf(e)(e.vanWestendorp.pmc));
  row("OPP (optimal)", (e) => moneyOf(e)(e.vanWestendorp.opp));
  row("IPP (indifférence)", (e) => moneyOf(e)(e.vanWestendorp.ipp));
  row("PME (cherté marginale)", (e) => moneyOf(e)(e.vanWestendorp.pme));
  if (c.normalization) {
    const n = c.normalization;
    row("OPP en €/mois équivalent", (_, i) => (n.entries[i]?.factor === null ? "non normalisable" : eur(n.entries[i]?.vanWestendorp.opp ?? null)));
    row("IPP en €/mois équivalent", (_, i) => (n.entries[i]?.factor === null ? "non normalisable" : eur(n.entries[i]?.vanWestendorp.ipp ?? null)));
  }

  header("Objections (part des répondants qui citent la catégorie)");
  if (c.scalesDiffer) {
    out.push("  Taxonomies différentes : catégories canoniques.");
    for (const cat of CANONICAL_OBJECTIONS) row(OBJECTION_LABELS[cat], (e, i) => `${pct(e.objectionsCanonical![cat])}${i ? signed(d(i).objectionsCanonical![cat]) : ""}`);
  } else {
    const p0 = cols[0]!.protocol;
    const list = p0 ? p0.objections.map((o) => [o.code, o.label] as const) : OBJECTION_CATEGORIES.map((x) => [x, OBJECTION_LABELS[x]] as const);
    for (const [cat, label] of list) row(label, (e, i) => `${pct(e.objections[cat] ?? 0)}${i ? signed(d(i).objections[cat] ?? null) : ""}`);
  }
  row("Objections par répondant", (e) => e.objectionsPerRespondent.toLocaleString("fr-FR"));
  row("Anomalies restantes", (e) => pct(e.anomalies));

  for (const dim of [...new Set(COMPARE_DIMENSIONS.map((d) => SEGMENT_ALIASES[d]?.dim ?? d))]) {
    const codes = [...new Map(cols.flatMap((e) => (e.segments[dim] ?? []).map((s) => [s.code, s.label] as const))).entries()];
    if (!codes.length) continue;
    header(`${DIMENSION_LABELS[dim]} : ≥ inscription gratuite / payeurs`);
    for (const [code, label] of codes) {
      const n = cols[0]!.segments[dim]?.find((s) => s.code === code)?.n ?? 0;
      row(`${n < 15 ? "⚠" : " "}${padL(String(n), 3)} ${label}`, (e, i) => {
        const s = e.segments[dim]?.find((x) => x.code === code);
        if (!s) return "—";
        const dd = i ? d(i).segments[dim]?.find((x) => x.code === code)?.freeSignupOrMore ?? null : null;
        return `${pct(s.freeSignupOrMore)}${signed(dd)} / ${pct(s.payers)}`;
      });
    }
  }
  out.push("", "  ⚠ : segment de moins de 15 personas.");
  return out.join("\n");
}
