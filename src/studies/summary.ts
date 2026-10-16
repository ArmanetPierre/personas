import type { Persona, Project, ResponseRow, Study } from "../db/schema";
import type { Pack } from "../personas/pack";
import { packResolver } from "./packs";
import { formatPricing, formatTier, hasGenericPricing, pricingOf, referenceOffer, unitLabel, type Pricing } from "./price-model";
import { formatPrice, PERIOD_LABELS } from "./project";
import { gaborGranger, vanWestendorp, type GgResult, type VwResult } from "./pricing";
import {
  BEHAVIOR_LABELS,
  behaviorLabelsFor,
  BEHAVIORS,
  behaviorRank,
  CHECK_LABELS,
  OBJECTION_CATEGORIES,
  OBJECTION_LABELS,
  RELEVANCE,
  RELEVANCE_LABELS,
  NEED_FREQUENCIES,
  NEED_FREQUENCY_LABELS,
  protocolVersionOf,
  tierKey,
  type Behavior,
  type ObjectionCategory,
} from "./protocols/concept-price";
import type { ConceptPricePayload } from "./run";
import { confidenceIndex, formatConfidence, type ConfidenceIndex } from "./confidence";
import { formatPaymentLine, loadCalibration, paymentMeasure, type PaymentCalibration, type PaymentMeasure } from "./payment";
import { toneWarning, TONE_WARNING_THRESHOLD } from "./pitch-tone";
import { toEur } from "./price-model";
import { studyAudience } from "./locale";
import { formatPricingEn, formatTierEn, unitLabelEn } from "./price-model-en";
import { behaviorLabelsForEn, NEED_FREQUENCY_LABELS_EN } from "./protocols/concept-price-en";
import { projectRoles, REGULAR_USAGE, USAGE_LEVELS, usageLabel, type FrozenRole, type UsageLevel } from "./roles";
import {
  computeDrivers,
  dimensionInfo,
  formatDrivers,
  moduleDimensions,
  socleDimension,
  AUTO_SOCLE_DIMENSIONS,
  type Dimension,
  type DimensionInfo,
  type DriversResult,
} from "./drivers";
import {
  CANONICAL_LEVELS,
  CANONICAL_OBJECTIONS,
  LEGACY_PROTOCOL,
  protocolOfPayload,
  protocolTools,
  type CanonicalLevel,
  type CanonicalObjection,
  type ResolvedProtocol,
} from "./protocols/protocol";
import {
  DIMENSION_LABELS,
  EXTRA_DIMENSIONS,
  segmentLabel,
  segmentOf,
  segmentOrder,
  SUMMARY_DIMENSIONS,
  type SegmentDimension,
} from "./segments";

export const METHOD_NOTE =
  "Signaux qualitatifs issus de personas synthétiques : à lire comme des objections et des tendances par segment, pas comme une prévision de conversion.";
export const METHOD_NOTE_EN =
  "Qualitative signals from synthetic personas: read them as objections and trends by segment, not as a conversion forecast.";

/** En dessous de cet effectif, un segment est signalé comme peu fiable. */
export const SMALL_SEGMENT = 15;

export const GROUP_LABELS: Record<string, string> = { target: "Cible", control: "Témoin (population générale)" };
export const GROUP_LABELS_EN: Record<string, string> = { target: "Target", control: "Control (general population)" };

export interface Distribution<K extends string> {
  n: number;
  counts: Record<K, number>;
  shares: Record<K, number>;
}

export interface SegmentRow<T> {
  code: string;
  label: string;
  n: number;
  small: boolean;
  value: T;
}

/** Agrégats d'un ensemble de réponses (toute l'étude, ou un groupe). */
export interface Analysis {
  n: number;
  narrativeUsedShare: number;
  behaviors: {
    /** Clés : codes de l'échelle de comportements du protocole (historique : `Behavior`). */
    overall: Distribution<string>;
    /** Part qui va au moins jusqu'à l'inscription gratuite (niveau ≥ essai gratuit), et part qui paierait (≥ paiement). */
    freeSignupOrMore: number;
    payers: number;
    bySegment: Record<string, Array<SegmentRow<Distribution<string>>>>;
    /** Répartition par niveau canonique (protocole propre au projet seulement). */
    levels?: Distribution<CanonicalLevel>;
  };
  /** Dimensions ajoutées automatiquement (attributs des modules, variables clés du socle) : id, libellé, source. */
  autoDimensions?: DimensionInfo[];
  /** Part qui transmettrait l'offre à quelqu'un, indépendamment du paiement (réponses v2). */
  forward: { n: number; share: number; examples: Array<{ personaId: string; who: string; to: string }> };
  relevance: { overall: Distribution<string>; notConcernedShare: number };
  vanWestendorp: VwResult & { neverPay: number; neverPayShare: number };
  gaborGranger: GgResult;
  objections: {
    /** Part des répondants qui citent au moins une fois la catégorie. */
    overall: Distribution<string>;
    /** Répartition par catégorie canonique (protocole propre au projet seulement). */
    canonical?: Distribution<CanonicalObjection>;
    /** Nombre moyen d'objections par répondant, et parmi les « pas concernées ». */
    perRespondent: number;
    perNotConcerned: number;
    bySegment: Record<string, Array<SegmentRow<Distribution<string>>>>;
    examples: Record<string, Array<{ personaId: string; who: string; detail: string }>>;
  };
  verbatims: Array<{ personaId: string; who: string; behavior: string; text: string }>;
  anomalies: { rate: number; repairedRate: number; byCode: Record<string, number>; initialByCode: Record<string, number> };
  /** Double mesure du paiement (ajout v3, calculée aussi pour les études v2) : M1 observé, G au palier bas, M2 estimée. */
  payment?: PaymentMeasure;
  /** Fréquence du besoin (réponses v3 seulement). */
  needFrequency?: NeedFrequencySummary;
  /** Multi-rôles (phase 7) : rôle des réponses (absent : projet sans rôles, ou rôles mêlés). */
  role?: FrozenRole;
  /** Rôle utilisateur : usage attendu (`expectedUsage`). */
  expectedUsage?: { n: number; counts: Record<string, number>; shares: Record<string, number>; regularShare: number };
  /** Rôle payeur qui dépend d'un autre rôle : part d'utilisateurs réguliers exigée pour payer (0-100, null : jamais). */
  adoptionThreshold?: { n: number; never: number; values: number[]; median: number | null };
  usage: {
    avgDurationMs: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    avgCacheReadTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
  };
}

/** Fréquence du besoin agrégée (v3). */
export interface NeedFrequencySummary {
  n: number;
  counts: Record<string, number>;
  shares: Record<string, number>;
  /** Part au moins « chaque mois » (indicateur d'usage récurrent). */
  recurringShare: number;
  /** Part « jamais » ou « moins d'une fois par an ». */
  rareShare: number;
  /** Diagnostic (§ 4 du protocole v3) quand une majorité dit « jamais » ou « moins d'une fois par an ». */
  diagnostic: string | null;
}

/** Section croisée entre rôles (phase 7) : chaque rôle répond séparément, le résumé rapproche les résultats. */
export interface CrossRoles {
  overview: Array<{ role: string; label: string; perspective: string; n: number; trial: number; regularUse: number | null; observedPayment: number | null; lowTierYes: number | null; estimated: number | null }>;
  dependencies: Array<{
    payer: string;
    user: string;
    /** Part des utilisateurs simulés qui utiliseraient au moins chaque semaine, et qui essaieraient. */
    userRegularUse: number;
    userTrial: number;
    /** Payeurs dont le seuil d'adoption est atteint par l'usage simulé, parmi ceux qui ont répondu. */
    thresholdMet: number;
    thresholdMetShare: number;
    payerRespondents: number;
    payerNever: number;
    medianThreshold: number | null;
    sentence: string;
  }>;
  note: string;
}

/** Contexte facultatif d'un résumé : passes répétées (lues en base par l'appelant), paramètres de conversion. */
export interface SummaryContext {
  /** Autres études terminées du même projet au même protocole ; absent : non vérifié. */
  repeats?: string[];
  calibration?: PaymentCalibration;
}

export interface StudySummary {
  study: { id: string; name: string; backend: string; model: string; protocol: string; sampleSize: number; responses: number; status: string };
  /** `pricePeriod` et `priceUnit` (« mois », « mise en relation »…) : ajoutés après la v2, unité des prix et des paliers. */
  project: {
    id: string;
    name: string;
    price: string;
    pricePeriod?: string;
    priceUnit?: string;
    /** Ajouts phase 2b, présents seulement pour un projet au modèle de prix générique. */
    currency?: string;
    pricing?: Pricing;
    /** Prix de l'offre de référence (« 24 SGD le kg »), dans laquelle sont posés Van Westendorp et Gabor-Granger. */
    referencePrice?: string;
    /** Équivalence annuelle (offre mensuelle) ou mensuelle (offre annuelle) du revenu : « year », « month ». */
    revenueEquivalent?: "year" | "month";
    /** Libellés des comportements adaptés à l'unité (« Achèterait », « Commanderait »…), hors abonnement. */
    behaviorLabels?: Record<Behavior, string>;
  };
  methodNote: string;
  /** Populations ciblées (phase 2a) : socle, modules, filtre et taux d'éligibilité. Absent pour une étude v1. */
  eligibility?: Array<{
    group: string;
    socle: string;
    modules: string[];
    expression: string | null;
    draws: number;
    eligible: number;
    rate: number;
    ci: [number, number];
    rare: boolean;
  }>;
  /** Protocole propre au projet, figé dans les réponses (absent : protocole historique). */
  protocol?: ResolvedProtocol;
  overall: Analysis;
  /** Facteurs d'engagement (lot P1) : groupe cible, ou toute l'étude à groupe unique. */
  drivers?: DriversResult;
  /** Une analyse par groupe (cible, témoin) quand l'étude en compte plusieurs. */
  groups: Array<{ group: string; label: string; packVersions: string[]; analysis: Analysis }>;
  /** Ajouts v3 (aussi pour les études v2) : mesures du groupe de référence (cible, ou toute l'étude à groupe unique). */
  protocolVersion?: string;
  payment?: PaymentMeasure & { group: string | null };
  /** Multi-rôles (phase 7) : rôles de l'étude (dans l'ordre du projet) et section croisée. */
  roles?: Array<FrozenRole & { group: string; n: number }>;
  crossRoles?: CrossRoles;
  needFrequency?: NeedFrequencySummary & { group: string | null };
  confidence?: ConfidenceIndex;
}

/** Champs de prix d'une étude en anglais : toujours au format du modèle générique. */
function projectFieldsEn(project: Project): Partial<StudySummary["project"]> {
  const p = pricingOf(project);
  if (!p) return { price: "—" };
  const ref = referenceOffer(p);
  const hasYear = p.offers.some((o) => o.unit === "year");
  return {
    price: formatPricingEn(p),
    pricePeriod: ref.unit,
    priceUnit: unitLabelEn(ref),
    currency: p.currency,
    pricing: p,
    referencePrice: formatTierEn(p, ref.amount),
    ...(ref.unit === "month" && hasYear && { revenueEquivalent: "year" as const }),
    ...(ref.unit === "year" && { revenueEquivalent: "month" as const }),
    ...(ref.unit !== "month" && ref.unit !== "year" && { behaviorLabels: behaviorLabelsForEn(ref.unit) as Record<Behavior, string> }),
  };
}

/** Champs de prix du modèle générique (absents pour un projet historique : JSON inchangé). */
function genericProjectFields(project: Project): Partial<StudySummary["project"]> {
  const p = hasGenericPricing(project) ? pricingOf(project) : null;
  if (!p) return {};
  const ref = referenceOffer(p);
  const hasYear = p.offers.some((o) => o.unit === "year");
  return {
    price: formatPricing(p),
    pricePeriod: ref.unit,
    priceUnit: unitLabel(ref),
    currency: p.currency,
    pricing: p,
    referencePrice: formatTier(p, ref.amount),
    ...(ref.unit === "month" && hasYear && { revenueEquivalent: "year" as const }),
    ...(ref.unit === "year" && { revenueEquivalent: "month" as const }),
    ...(ref.unit !== "month" && ref.unit !== "year" && { behaviorLabels: behaviorLabelsFor(ref.unit) }),
  };
}

/** Formateur de montants d'un résumé : « 5 € » (historique) ou dans la devise du projet. */
export function moneyFormatter(project: StudySummary["project"]): (x: number | null) => string {
  const cur = project.currency;
  if (!cur || cur === "EUR") return eur;
  const sym = cur === "USD" ? "$" : cur === "GBP" ? "£" : cur;
  return (x) => (x === null ? "—" : `${x.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ${sym}`);
}

function eligibilityOf(study: Study): Pick<StudySummary, "eligibility"> {
  type E = NonNullable<StudySummary["eligibility"]>[number];
  const list = (study.populations ?? [])
    .map((p) => ({ group: p.group, e: (p as { eligibility?: Omit<E, "group"> }).eligibility }))
    .filter((x): x is { group: string; e: Omit<E, "group"> } => Boolean(x.e))
    .map((x) => ({ group: x.group, ...x.e }));
  return list.length ? { eligibility: list } : {};
}

function distribution<K extends string>(keys: readonly K[], values: K[][] | K[], n: number): Distribution<K> {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const v of values) {
    const set = new Set(Array.isArray(v) ? v : [v]);
    for (const k of set) if (k in counts) counts[k]++;
  }
  const shares = Object.fromEntries(keys.map((k) => [k, n ? counts[k] / n : 0])) as Record<K, number>;
  return { n, counts, shares };
}

interface Row {
  persona: Persona;
  payload: ConceptPricePayload;
  response: ResponseRow;
}

function who(p: Persona, en = false): string {
  return en ? `${p.firstName ?? "?"}, ${p.age}, ${p.occupation.toLowerCase()}` : `${p.firstName ?? "?"}, ${p.age} ans, ${p.occupation.toLowerCase()}`;
}

/** Échantillon déterministe et varié : un exemple par persona différente, ordre par id. */
function pickSpread<T extends { personaId: string }>(items: T[], k: number): T[] {
  const sorted = [...items].sort((a, b) => a.personaId.localeCompare(b.personaId));
  if (sorted.length <= k) return sorted;
  const step = sorted.length / k;
  return Array.from({ length: k }, (_, i) => sorted[Math.floor(i * step)]!);
}

/** Groupe d'une réponse : celui de l'étude, sinon « target » (étude à population unique). */
function groupOf(study: Study, r: ResponseRow): string {
  return study.personaGroups[r.personaId] ?? (r.payload as ConceptPricePayload).group ?? "target";
}

export function summarize(
  pack: Pack,
  study: Study,
  project: Project,
  responses: ResponseRow[],
  personas: Map<string, Persona>,
  dims: SegmentDimension[] = SUMMARY_DIMENSIONS,
  context: SummaryContext = {},
): StudySummary {
  const packOf = packResolver(pack);
  const version = protocolVersionOf(study.protocolVersion);
  // Étude en anglais (socle en locale `en`) : libellés et textes générés en anglais ; France inchangée.
  const locale = studyAudience(study).locale;
  const en = locale === "en";
  const calibration = context.calibration ?? loadCalibration();
  const pay = paymentContext(project, version, calibration);
  const rows: Row[] = responses.map((r) => {
    const persona = personas.get(r.personaId);
    if (!persona) throw new Error(`Persona introuvable : ${r.personaId}`);
    return { persona, payload: r.payload as ConceptPricePayload, response: r };
  });
  const byGroup = new Map<string, Row[]>();
  for (const r of rows) {
    const g = groupOf(study, r.response);
    byGroup.set(g, [...(byGroup.get(g) ?? []), r]);
  }
  const roleOrder = projectRoles(project).map((r) => r.id);
  const rank = (g: string) => (roleOrder.includes(g) ? roleOrder.indexOf(g) : roleOrder.length);
  const groupNames = [...byGroup.keys()].sort((a, b) => (a === "target" ? -1 : b === "target" ? 1 : rank(a) - rank(b) || a.localeCompare(b)));
  // Protocole figé dans les réponses : un changement ultérieur du projet ne modifie pas une étude passée
  const proto = protocolOfPayload(rows.find((r) => (r.payload as { protocol?: ResolvedProtocol }).protocol)?.payload as { protocol?: ResolvedProtocol });
  const multi = groupNames.length > 1;
  const auto = (subset: Row[], g: string | null) => autoDimensionsFor(study, packOf, subset, g, multi && g === null, locale);
  const driverGroup = multi ? (groupNames.includes("target") ? "target" : groupNames[0]!) : null;
  const driverRows = driverGroup ? byGroup.get(driverGroup)! : rows;
  const tools = protocolTools(proto);
  const drivers = computeDrivers(
    driverRows.map((r) => ({ persona: r.persona, level: tools.level(r.payload.answer.behavior) })),
    [...[...new Set([...EXTRA_DIMENSIONS.filter((d) => driverRows.some((r) => segmentOf(packOf(r.persona), r.persona, d) !== "?")), ...dims])].map((d) => socleDimension(packOf, d, locale)), ...auto(driverRows, driverGroup)],
    { group: driverGroup, seed: study.id, ...(en && { locale }) },
  );

  const summary: StudySummary = {
    study: {
      id: study.id,
      name: study.name,
      backend: study.backend,
      model: study.model,
      protocol: `${study.protocol}/${study.protocolVersion}`,
      sampleSize: study.personaIds.length,
      responses: rows.length,
      status: study.status,
    },
    project: en
      ? { id: project.id, name: project.name, price: "—", ...projectFieldsEn(project) }
      : {
          id: project.id,
          name: project.name,
          price: project.priceEur ? formatPrice(project.priceEur, project.pricePeriod) : "—",
          pricePeriod: project.pricePeriod ?? "month",
          priceUnit: PERIOD_LABELS[project.pricePeriod ?? "month"] ?? project.pricePeriod ?? "mois",
          ...genericProjectFields(project),
        },
    methodNote: en ? METHOD_NOTE_EN : METHOD_NOTE,
    ...eligibilityOf(study),
    ...(proto.custom && { protocol: proto }),
    overall: analyze(packOf, rows, dims, proto, auto(rows, null), pay, en),
    drivers,
    groups:
      groupNames.length > 1
        ? groupNames.map((g) => {
            const subset = byGroup.get(g)!;
            // Dans un groupe, on ajoute les attributs propres à sa population (statut, stade du projet…)
            const extra = EXTRA_DIMENSIONS.filter((d) => subset.some((r) => segmentOf(packOf(r.persona), r.persona, d) !== "?"));
            return {
              group: g,
              label: subset[0]?.payload.role?.label ?? (en ? GROUP_LABELS_EN : GROUP_LABELS)[g] ?? g,
              packVersions: [...new Set(subset.map((r) => r.persona.packVersion))],
              analysis: analyze(packOf, subset, [...extra, ...dims], proto, auto(subset, g), pay, en),
            };
          })
        : [],
  };
  // Multi-rôles : la référence du paiement et de l'indice est le premier rôle payeur
  const roleOf = (g: string) => byGroup.get(g)?.[0]?.payload.role;
  const payerGroup = groupNames.find((g) => roleOf(g)?.pricing);
  const refGroup = multi && payerGroup && roleOf(payerGroup) ? payerGroup : driverGroup;
  return withRoles(withV3Blocks(summary, study, project, rows, refGroup, version, calibration, context, locale), byGroup, groupNames, en);
}

interface PayContext {
  unit: string;
  shownEur: number | null;
  version: string;
  calibration: PaymentCalibration;
}

function paymentContext(project: Project, version: string, calibration: PaymentCalibration): PayContext {
  const p = hasGenericPricing(project) ? pricingOf(project) : null;
  const unit = p ? referenceOffer(p).unit : (project.pricePeriod ?? "month");
  const shownEur = project.priceEur ? (p ? toEur(p, project.priceEur) : project.priceEur) : null;
  return { unit, shownEur, version, calibration };
}

/** Blocs ajoutés au résumé : version, paiement et fréquence du groupe de référence, indice de confiance. */
/** Blocs multi-rôles : rôles de l'étude et section croisée (absents pour un projet sans rôles). */
function withRoles(summary: StudySummary, byGroup: Map<string, Row[]>, groupNames: string[], en = false): StudySummary {
  const roles = groupNames
    .map((g) => ({ g, role: byGroup.get(g)?.[0]?.payload.role }))
    .filter((x): x is { g: string; role: FrozenRole } => Boolean(x.role))
    .map(({ g, role }) => ({ ...role, group: g, n: byGroup.get(g)!.length }));
  if (!roles.length) return summary;
  const analysisOf = (g: string) => summary.groups.find((x) => x.group === g)?.analysis ?? summary.overall;
  const overview = roles.map((r) => {
    const a = analysisOf(r.group);
    return {
      role: r.id,
      label: r.label,
      perspective: r.perspective,
      n: a.n,
      trial: a.behaviors.freeSignupOrMore,
      regularUse: a.expectedUsage ? a.expectedUsage.regularShare : null,
      observedPayment: a.payment ? a.payment.observed : null,
      lowTierYes: a.payment?.lowTierYes ? a.payment.lowTierYes.share : null,
      estimated: a.payment?.estimated ? a.payment.estimated.value : null,
    };
  });
  const pctS = (x: number) => `${Math.round(x * 100)} %`;
  const dependencies = roles
    .filter((r) => r.dependsOn && roles.some((u) => u.id === r.dependsOn))
    .map((r) => {
      const payer = analysisOf(r.group);
      const user = analysisOf(roles.find((u) => u.id === r.dependsOn)!.group);
      const userRegularUse = user.expectedUsage?.regularShare ?? 0;
      const th = payer.adoptionThreshold ?? { n: 0, never: 0, values: [], median: null };
      const met = th.values.filter((v) => v <= userRegularUse * 100).length;
      const pctEn = (x: number) => `${Math.round(x * 100)}%`;
      const sentence = en
        ? `${user.role?.label ?? r.dependsOn}: ${pctEn(userRegularUse)} would use the service at least weekly, ${pctEn(user.behaviors.freeSignupOrMore)} would try it. ` +
          `${payer.role?.label ?? r.id}: ${met} out of ${th.n} would pay at this adoption level (threshold ≤ ${pctEn(userRegularUse)}), ${th.never} would not pay in any case` +
          (th.median !== null ? `; median threshold ${th.median}%` : "") +
          (payer.payment ? `; observed payment ${pctEn(payer.payment.observed)}${payer.payment.lowTierYes ? `, yes at the low tier ${pctEn(payer.payment.lowTierYes.share)}` : ""}` : "") +
          "."
        : `${user.role?.label ?? r.dependsOn} : ${pctS(userRegularUse)} utiliseraient le service au moins chaque semaine, ${pctS(user.behaviors.freeSignupOrMore)} l'essaieraient. ` +
        `${payer.role?.label ?? r.id} : ${met} sur ${th.n} paieraient à ce niveau d'adoption (seuil ≤ ${pctS(userRegularUse)}), ${th.never} ne paieraient en aucun cas` +
        (th.median !== null ? ` ; seuil médian ${th.median} %` : "") +
        (payer.payment ? ` ; paiement observé ${pctS(payer.payment.observed)}${payer.payment.lowTierYes ? `, oui au palier bas ${pctS(payer.payment.lowTierYes.share)}` : ""}` : "") +
        ".";
      return {
        payer: r.id,
        user: r.dependsOn!,
        userRegularUse,
        userTrial: user.behaviors.freeSignupOrMore,
        thresholdMet: met,
        thresholdMetShare: th.n ? met / th.n : 0,
        payerRespondents: th.n,
        payerNever: th.never,
        medianThreshold: th.median,
        sentence,
      };
    });
  return {
    ...summary,
    roles,
    crossRoles: {
      overview,
      dependencies,
      note: en
        ? "Each role answers separately, without simulated interaction: the cross-analysis compares the adoption threshold stated by payers with the use stated by users. Absolute levels are indicative."
        : "Chaque rôle répond séparément, sans simulation d'interaction : le croisement rapproche le seuil d'adoption déclaré par les payeurs et l'usage déclaré par les utilisateurs. Niveaux absolus indicatifs.",
    },
  };
}

function withV3Blocks(
  summary: StudySummary,
  study: Study,
  project: Project,
  rows: Row[],
  refGroup: string | null,
  version: string,
  calibration: PaymentCalibration,
  context: SummaryContext,
  locale: "fr" | "en" = "fr",
): StudySummary {
  const en = locale === "en";
  const ref = refGroup ? summary.groups.find((g) => g.group === refGroup)!.analysis : summary.overall;
  const refRows = refGroup ? rows.filter((r) => groupOf(study, r.response) === refGroup) : rows;
  const frozen = refRows.find((r) => r.payload.pitchTone)?.payload.pitchTone;
  const current = toneWarning(project.pitch, undefined, locale);
  const neutralized = (project.extra as { pitchNeutralized?: boolean }).pitchNeutralized === true;
  const pitch = frozen
    ? { score: frozen.score, threshold: frozen.threshold, neutralized: frozen.neutralized, measuredOn: "responses" as const }
    : { score: current.score, threshold: TONE_WARNING_THRESHOLD, neutralized, measuredOn: "current_project" as const };
  const extraCaveats: string[] = [];
  if (ref.needFrequency?.diagnostic) extraCaveats.push(ref.needFrequency.diagnostic);
  if (ref.anomalies.rate > 0.1) extraCaveats.push(en ? `Remaining anomalies: ${Math.round(ref.anomalies.rate * 100)}% of answers.` : `Anomalies restantes : ${Math.round(ref.anomalies.rate * 100)} % des réponses.`);
  return {
    ...summary,
    protocolVersion: version,
    ...(ref.payment && { payment: { group: refGroup, ...ref.payment } }),
    ...(ref.needFrequency && { needFrequency: { group: refGroup, ...ref.needFrequency } }),
    confidence: confidenceIndex({
      protocolVersion: version,
      group: refGroup,
      n: ref.n,
      repeats: context.repeats ?? null,
      calibration,
      pitch,
      extraCaveats,
      ...(en && { locale }),
    }),
  };
}

/**
 * Dimensions automatiques d'un ensemble de réponses : variables clés du socle, puis attributs des
 * modules de la population (ceux de l'éligibilité du groupe, sinon ceux que portent les personas).
 * Pour l'ensemble d'une étude à plusieurs groupes : socle seulement.
 */
function autoDimensionsFor(study: Study, packOf: ReturnType<typeof packResolver>, rows: Row[], group: string | null, socleOnly: boolean, locale: "fr" | "en" = "fr"): Dimension[] {
  const socle = AUTO_SOCLE_DIMENSIONS.map((d) => socleDimension(packOf, d, locale)).filter((d) => new Set(rows.map((r) => d.codeOf(r.persona)).filter((c) => c !== "?")).size >= 2);
  if (socleOnly) return socle;
  const pop = (study.populations ?? []).find((p) => p.group === (group ?? "target")) as { eligibility?: { modules?: string[] } } | undefined;
  const modules = pop?.eligibility?.modules?.map((m) => m.split("@")[0]!) ?? null;
  return [...socle, ...moduleDimensions(rows.map((r) => r.persona), modules)];
}

function analyze(
  packOf: ReturnType<typeof packResolver>,
  rows: Row[],
  dimsIn: SegmentDimension[],
  proto: ResolvedProtocol = LEGACY_PROTOCOL,
  autoDimsIn: Dimension[] = [],
  pay?: PayContext,
  en = false,
): Analysis {
  const n = rows.length;
  // v3 : la fréquence du besoin devient une dimension de segment automatique (réponse, pas attribut de persona)
  const nf = needFrequencyOf(rows, en);
  const autoDims = nf ? [...autoDimsIn, needFrequencyDimension(rows, en)] : autoDimsIn;
  // Une étude à population unique ciblée : on affiche aussi ses attributs propres
  const dims = [
    ...EXTRA_DIMENSIONS.filter((d) => !dimsIn.includes(d) && rows.length && rows.every((r) => segmentOf(packOf(r.persona), r.persona, d) !== "?")),
    ...dimsIn,
  ];
  const behaviorOf = (r: Row) => r.payload.answer.behavior;
  const objectionsOf = (r: Row) => r.payload.answer.objections.map((o) => o.category);

  const tools = protocolTools(proto);
  const B = tools.behaviorCodes;
  const O = tools.objectionCodes;
  const R = tools.relevanceCodes;
  const bySeg = <T>(make: (subset: Row[]) => T) => {
    const out: Record<string, Array<SegmentRow<T>>> = {};
    for (const dim of dims) {
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        const code = segmentOf(packOf(r.persona), r.persona, dim);
        groups.set(code, [...(groups.get(code) ?? []), r]);
      }
      out[dim] = segmentOrder(dim, [...groups.keys()]).map((code) => {
        const subset = groups.get(code)!;
        const p0 = subset[0]!.persona;
        return { code, label: segmentLabel(packOf(p0), dim, code, p0), n: subset.length, small: subset.length < SMALL_SEGMENT, value: make(subset) };
      });
    }
    // Ajouts : dimensions automatiques, après les dimensions habituelles
    for (const d of autoDims) {
      if (out[d.id]) continue;
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        const code = d.codeOf(r.persona);
        groups.set(code, [...(groups.get(code) ?? []), r]);
      }
      const codes = d.order ? d.order([...groups.keys()]) : [...groups.keys()].sort();
      out[d.id] = codes.map((code) => {
        const subset = groups.get(code)!;
        return { code, label: d.labelOf(code, subset[0]!.persona), n: subset.length, small: subset.length < SMALL_SEGMENT, value: make(subset) };
      });
    }
    return out;
  };

  const behaviorsOverall = distribution(B, rows.map(behaviorOf), n);
  const atLeast = (l: CanonicalLevel) => (n ? rows.filter((r) => tools.atLeast(behaviorOf(r), l)).length / n : 0);
  const relevanceOverall = distribution(R, rows.map((r) => r.payload.answer.relevance), n);

  const vwAnswers = rows
    .map((r) => r.payload.answer.vanWestendorp)
    .filter((v) => v && !v.wouldNeverPay && v.tooCheapEur !== null && v.cheapEur !== null && v.expensiveEur !== null && v.tooExpensiveEur !== null)
    .map((v) => ({ tooCheap: v.tooCheapEur!, cheap: v.cheapEur!, expensive: v.expensiveEur!, tooExpensive: v.tooExpensiveEur! }));
  const neverPay = rows.filter((r) => r.payload.answer.vanWestendorp?.wouldNeverPay).length;

  const tiers = rows[0]?.payload.tiers ?? [];
  const gg = gaborGranger(
    tiers,
    rows.map((r) => tiers.map((t) => r.payload.answer.gaborGranger?.[tierKey(t)] === true)),
  );

  const examples = Object.fromEntries(O.map((c) => [c, [] as Array<{ personaId: string; who: string; detail: string }>])) as Analysis["objections"]["examples"];
  for (const c of O) {
    const items = rows.flatMap((r) =>
      r.payload.answer.objections.filter((o) => o.category === c).slice(0, 1).map((o) => ({ personaId: r.persona.id, who: who(r.persona, en), detail: o.detail })),
    );
    examples[c] = pickSpread(items, 3);
  }
  const notConcerned = rows.filter((r) => tools.relevanceCanonical(r.payload.answer.relevance) === "not_concerned");
  const avgObj = (rs: Row[]) => (rs.length ? Math.round((rs.reduce((a, r) => a + r.payload.answer.objections.length, 0) / rs.length) * 10) / 10 : 0);

  const withForward = rows.filter((r) => typeof r.payload.answer.wouldForward === "boolean");
  const forwarders = withForward.filter((r) => r.payload.answer.wouldForward);

  const byCode: Record<string, number> = {};
  const initialByCode: Record<string, number> = {};
  for (const r of rows) {
    for (const a of r.response.anomalies) byCode[a] = (byCode[a] ?? 0) + 1;
    for (const a of r.payload.initialAnomalies) initialByCode[a] = (initialByCode[a] ?? 0) + 1;
  }

  const sum = (f: (r: ResponseRow) => number) => rows.reduce((a, r) => a + f(r.response), 0);
  const avg = (f: (r: ResponseRow) => number) => (n ? Math.round(sum(f) / n) : 0);

  return {
    n,
    narrativeUsedShare: n ? rows.filter((r) => r.response.narrativeUsed).length / n : 0,
    behaviors: {
      overall: behaviorsOverall,
      freeSignupOrMore: atLeast("free_trial"),
      payers: atLeast("payment"),
      bySegment: bySeg((s) => distribution(B, s.map(behaviorOf), s.length)),
      ...(proto.custom && { levels: distribution(CANONICAL_LEVELS, rows.map((r) => tools.level(behaviorOf(r))), n) }),
    },
    ...(autoDims.length && { autoDimensions: autoDims.map(dimensionInfo) }),
    forward: {
      n: withForward.length,
      share: withForward.length ? forwarders.length / withForward.length : 0,
      examples: pickSpread(forwarders.map((r) => ({ personaId: r.persona.id, who: who(r.persona, en), to: r.payload.answer.forwardTo })), 3),
    },
    relevance: {
      overall: relevanceOverall,
      notConcernedShare: R.filter((c) => tools.relevanceCanonical(c) === "not_concerned").reduce((a, c) => a + relevanceOverall.shares[c]!, 0),
    },
    vanWestendorp: { ...vanWestendorp(vwAnswers), neverPay, neverPayShare: n ? neverPay / n : 0 },
    gaborGranger: gg,
    objections: {
      overall: distribution(O, rows.map(objectionsOf), n),
      ...(proto.custom && { canonical: distribution(CANONICAL_OBJECTIONS, rows.map((r) => objectionsOf(r).map((c) => tools.objectionCanonical(c))), n) }),
      perRespondent: avgObj(rows),
      perNotConcerned: avgObj(notConcerned),
      bySegment: bySeg((s) => distribution(O, s.map(objectionsOf), s.length)),
      examples,
    },
    verbatims: pickSpread(
      rows.map((r) => ({ personaId: r.persona.id, who: who(r.persona, en), behavior: behaviorOf(r), text: r.payload.answer.verbatim })),
      8,
    ),
    anomalies: {
      rate: n ? rows.filter((r) => r.response.anomalies.length > 0).length / n : 0,
      repairedRate: n ? rows.filter((r) => r.response.repaired).length / n : 0,
      byCode,
      initialByCode,
    },
    ...(pay && rows.every((r) => r.payload.role?.pricing !== false) && {
      payment: paymentMeasure(
        {
          n,
          payers: rows.filter((r) => tools.atLeast(behaviorOf(r), "payment")).length,
          shown: rows[0]?.payload.priceShown ?? 0,
          tiers: gg.tiers.map((t) => ({ price: t.price, yes: t.yes })),
          unit: pay.unit,
          shownEur: pay.shownEur,
          recurringShare: nf?.recurringShare ?? null,
          protocolVersion: pay.version,
        },
        pay.calibration,
      ),
    }),
    ...(nf && { needFrequency: nf }),
    ...roleBlocks(rows),
    usage: {
      avgDurationMs: avg((r) => r.durationMs),
      avgInputTokens: avg((r) => r.inputTokens),
      avgOutputTokens: avg((r) => r.outputTokens),
      avgCacheReadTokens: avg((r) => r.cacheReadTokens),
      totalInputTokens: sum((r) => r.inputTokens),
      totalOutputTokens: sum((r) => r.outputTokens),
      totalCostUsd: Math.round(sum((r) => r.costUsd ?? 0) * 1000) / 1000,
    },
  };
}

/** Blocs d'un rôle (phase 7) : rôle commun des réponses, usage attendu, seuil d'adoption. */
function roleBlocks(rows: Row[]): Pick<Analysis, "role" | "expectedUsage" | "adoptionThreshold"> {
  const role = rows[0]?.payload.role;
  if (!role || !rows.every((r) => r.payload.role?.id === role.id)) return {};
  const out: Pick<Analysis, "role" | "expectedUsage" | "adoptionThreshold"> = { role };
  const withU = rows.filter((r) => r.payload.answer.expectedUsage);
  if (withU.length) {
    const d = distribution(USAGE_LEVELS, withU.map((r) => r.payload.answer.expectedUsage as UsageLevel), withU.length);
    out.expectedUsage = { n: d.n, counts: d.counts, shares: d.shares, regularShare: withU.filter((r) => REGULAR_USAGE.has(r.payload.answer.expectedUsage as UsageLevel)).length / withU.length };
  }
  const withT = rows.filter((r) => r.payload.answer.adoptionThreshold !== undefined);
  if (withT.length) {
    const values = withT.map((r) => r.payload.answer.adoptionThreshold).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    out.adoptionThreshold = { n: withT.length, never: withT.length - values.length, values, median: values.length ? values[Math.floor(values.length / 2)]! : null };
  }
  return out;
}

/** Fréquence du besoin agrégée ; null si aucune réponse ne la porte (v2). */
function needFrequencyOf(rows: Row[], en = false): NeedFrequencySummary | null {
  const withF = rows.filter((r) => r.payload.protocolVersion === "3" && r.payload.answer.needFrequency);
  if (!withF.length) return null;
  const d = distribution(NEED_FREQUENCIES, withF.map((r) => r.payload.answer.needFrequency!), withF.length);
  const recurringShare = d.shares.monthly + d.shares.weekly + d.shares.daily;
  const rareShare = d.shares.never + d.shares.rarely;
  return {
    n: d.n,
    counts: d.counts,
    shares: d.shares,
    recurringShare,
    rareShare,
    diagnostic:
      rareShare >= 0.5 && en
        ? `${Math.round(rareShare * 100)}% of personas say the need never comes up or less than once a year: if real use is occasional but widespread, the socle does not represent it and a usage module should be created (docs/protocol-v3.md § 4).`
        : rareShare >= 0.5
        ? `${Math.round(rareShare * 100)} % des personas disent que le besoin ne se présente jamais ou moins d'une fois par an : si l'usage réel est ponctuel mais répandu, le socle ne le représente pas et un module d'usage est à créer (docs/protocol-v3.md § 4).`
        : null,
  };
}

function needFrequencyDimension(rows: Row[], en = false): Dimension {
  const byPersona = new Map(rows.map((r) => [r.persona.id, (r.payload.protocolVersion === "3" && r.payload.answer.needFrequency) || "?"]));
  return {
    id: "needFrequency",
    label: en ? "Need frequency" : "Fréquence du besoin",
    source: "response",
    codeOf: (p) => byPersona.get(p.id) ?? "?",
    labelOf: (code) => (en ? NEED_FREQUENCY_LABELS_EN[code] ?? "Not given" : NEED_FREQUENCY_LABELS[code as keyof typeof NEED_FREQUENCY_LABELS] ?? "Non renseignée"),
    order: (codes) => [...NEED_FREQUENCIES.filter((f) => codes.includes(f)), ...codes.filter((c) => !(NEED_FREQUENCIES as readonly string[]).includes(c))],
  };
}

// ─── Affichage console ────────────────────────────────────────────────────────

const pct = (x: number) => `${Math.round(x * 100)} %`;
const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s : " ".repeat(w - s.length) + s);
const eur = (x: number | null) => (x === null ? "—" : `${x.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €`);

const BEHAVIOR_SHORT: Record<Behavior, string> = {
  ignore: "ignore",
  save_for_later: "de côté",
  visit_page: "page",
  free_signup: "inscrit",
  free_active: "gratuit+",
  pay_subscription: "paie",
  recommend: "recom.",
};

const OBJ_SHORT: Record<ObjectionCategory, string> = {
  price: "prix",
  no_need: "besoin",
  already_covered: "couvert",
  trust_privacy: "confiance",
  effort_time: "temps",
  network_effect: "réseau",
  other: "autre",
};

/** Libellés d'affichage d'un protocole (historique : libellés et en-têtes d'origine). */
export interface ScaleView {
  behaviors: Array<{ code: string; label: string; short: string }>;
  objections: Array<{ code: string; label: string; short: string }>;
  relevance: Array<{ code: string; label: string }>;
}

export function scaleView(proto: ResolvedProtocol = LEGACY_PROTOCOL, behaviorLabels?: Record<string, string>): ScaleView {
  if (!proto.custom) {
    const labels = behaviorLabels ?? BEHAVIOR_LABELS;
    return {
      behaviors: BEHAVIORS.map((b) => ({ code: b, label: labels[b as Behavior] ?? BEHAVIOR_LABELS[b], short: BEHAVIOR_SHORT[b] })),
      objections: OBJECTION_CATEGORIES.map((c) => ({ code: c, label: OBJECTION_LABELS[c], short: OBJ_SHORT[c] })),
      relevance: RELEVANCE.map((r) => ({ code: r, label: RELEVANCE_LABELS[r] })),
    };
  }
  const shortOf = (x: { label: string; short?: string }) => x.short ?? x.label.slice(0, 8);
  return {
    behaviors: proto.behaviors.map((b) => ({ code: b.code, label: b.label, short: shortOf(b) })),
    objections: proto.objections.map((o) => ({ code: o.code, label: o.label, short: shortOf(o) })),
    relevance: proto.relevance.map((r) => ({ code: r.code, label: r.label })),
  };
}

function formatAnalysis(
  a: Analysis,
  out: string[],
  level = "",
  unit = "mois",
  money: (x: number | null) => string = eur,
  revenueEquivalent?: "year" | "month",
  view: ScaleView = scaleView(),
): void {
  const dimLabel = (dim: string) => a.autoDimensions?.find((d) => d.id === dim)?.label ?? DIMENSION_LABELS[dim as SegmentDimension];
  const v0 = (r: Record<string, number>, k: string) => r[k] ?? 0;
  const h = (t: string) => out.push("", `${level}${t}`, "─".repeat(Math.min(78, level.length + t.length)));
  out.push(`Réponses : ${a.n} ; récit utilisé pour ${pct(a.narrativeUsedShare)} des personas`);

  h("Comportement dans les 7 jours");
  for (const { code: b, label } of view.behaviors) {
    out.push(`  ${pad(label, 34)} ${padL(String(v0(a.behaviors.overall.counts, b)), 4)}  ${padL(pct(v0(a.behaviors.overall.shares, b)), 5)}`);
  }
  out.push(`  → au moins une inscription gratuite : ${pct(a.behaviors.freeSignupOrMore)} ; paierait : ${pct(a.behaviors.payers)}`);
  if (a.payment) out.push(`  → ${formatPaymentLine(a.payment, (x) => money(x))}`);
  if (a.forward.n) {
    out.push(`  → transmettrait l'offre à quelqu'un (indépendamment du paiement) : ${pct(a.forward.share)} (${a.forward.n} réponses)`);
    for (const f of a.forward.examples) out.push(`      à « ${f.to} » — ${f.who}`);
  }

  h("Pertinence");
  for (const { code: r, label } of view.relevance) out.push(`  ${pad(label, 34)} ${padL(String(v0(a.relevance.overall.counts, r)), 4)}  ${padL(pct(v0(a.relevance.overall.shares, r)), 5)}`);

  if (a.needFrequency) {
    h("Fréquence du besoin");
    for (const f of NEED_FREQUENCIES) {
      out.push(`  ${pad(NEED_FREQUENCY_LABELS[f], 34)} ${padL(String(a.needFrequency.counts[f] ?? 0), 4)}  ${padL(pct(a.needFrequency.shares[f] ?? 0), 5)}`);
    }
    out.push(`  → usage au moins mensuel : ${pct(a.needFrequency.recurringShare)} ; jamais ou moins d'une fois par an : ${pct(a.needFrequency.rareShare)}`);
    if (a.needFrequency.diagnostic) out.push(`  ⚠ ${a.needFrequency.diagnostic}`);
  }

  h("Comportement par segment (part de chaque comportement)");
  const bHead = view.behaviors.map((b) => padL(b.short, 9)).join("");
  for (const [dim, segs] of Object.entries(a.behaviors.bySegment)) {
    out.push(`  ${dimLabel(dim)}`);
    out.push(`    ${pad("", 40)} ${padL("n", 4)}${bHead}`);
    for (const seg of segs) {
      out.push(`    ${pad(seg.label, 40)} ${padL(String(seg.n), 4)}${view.behaviors.map((b) => padL(pct(v0(seg.value.shares, b.code)), 9)).join("")}${seg.small ? "  (n < 15)" : ""}`);
    }
  }

  if (a.expectedUsage) {
    h("Usage attendu (si la persona s'y mettait)");
    for (const u of USAGE_LEVELS) out.push(`  ${pad(usageLabel(u), 34)} ${padL(String(a.expectedUsage.counts[u] ?? 0), 4)}  ${padL(pct(a.expectedUsage.shares[u] ?? 0), 5)}`);
    out.push(`  → usage régulier (au moins chaque semaine) : ${pct(a.expectedUsage.regularShare)}`);
  }
  if (a.adoptionThreshold) {
    const t = a.adoptionThreshold;
    h("Seuil d'adoption pour payer (part d'utilisateurs réguliers exigée)");
    out.push(`  ${t.n} réponses ; ${t.never} ne paieraient en aucun cas ; seuil médian ${t.median === null ? "—" : `${t.median} %`}${t.values.length ? ` (valeurs : ${t.values.join(", ")})` : ""}`);
  }
  if (a.role && !a.role.pricing) {
    out.push("", `${level}Prix : sans objet pour ce rôle (${a.role.label} ne paie pas).`);
  } else {
  h("Van Westendorp (répondants qui paieraient à un prix donné)");
  const vw = a.vanWestendorp;
  out.push(`  ${vw.n} répondant(s) ; ${vw.neverPay} ne paieraient à aucun prix (${pct(vw.neverPayShare)})`);
  if (vw.n) {
    out.push(`  PMC (bon marché marginal) ${money(vw.pmc)} ; OPP (optimal) ${money(vw.opp)} ; IPP (indifférence) ${money(vw.ipp)} ; PME (cherté marginale) ${money(vw.pme)}`);
    out.push(`  ${pad("prix", 10)}${padL("trop bon m.", 12)}${padL("bon marché", 12)}${padL("cher", 8)}${padL("trop cher", 11)}`);
    for (const p of vw.curve) {
      out.push(`  ${pad(money(p.price), 10)}${padL(pct(p.tooCheap), 12)}${padL(pct(p.cheap), 12)}${padL(pct(p.expensive), 8)}${padL(pct(p.tooExpensive), 11)}`);
    }
    if (vw.n < SMALL_SEGMENT) out.push(`  (n < ${SMALL_SEGMENT} : points indicatifs)`);
  }

  h("Gabor-Granger (sur tout le groupe)");
  for (const t of a.gaborGranger.tiers) {
    const equiv =
      revenueEquivalent === "year" ? `, soit ≈ ${money(Math.round(t.revenuePer100 * 12))} par an` : revenueEquivalent === "month" ? `, soit ≈ ${money(Math.round((t.revenuePer100 / 12) * 100) / 100)} par mois` : "";
    out.push(`  ${pad(money(t.price), 10)} demande ${padL(pct(t.demand), 5)} (${t.yes}/${a.gaborGranger.n}) ; revenu attendu ${money(t.revenuePer100)}${unit === "mois" ? "" : ` (par ${unit})`}${equiv} pour 100 personnes exposées`);
  }
  if (a.gaborGranger.bestPrice !== null) out.push(`  Palier au revenu maximal : ${money(a.gaborGranger.bestPrice)}`);
  }

  h("Objections (part des répondants qui citent la catégorie)");
  out.push(`  ${a.objections.perRespondent} objection(s) par répondant en moyenne ; ${a.objections.perNotConcerned} chez les « pas concernées »`);
  for (const { code: c, label } of view.objections) {
    out.push(`  ${pad(label, 34)} ${padL(String(v0(a.objections.overall.counts, c)), 4)}  ${padL(pct(v0(a.objections.overall.shares, c)), 5)}`);
    for (const ex of a.objections.examples[c] ?? []) out.push(`      « ${ex.detail} » — ${ex.who}`);
  }
  out.push("");
  out.push("  Par segment :");
  const oHead = view.objections.map((c) => padL(c.short, 10)).join("");
  for (const [dim, segs] of Object.entries(a.objections.bySegment)) {
    out.push(`  ${dimLabel(dim)}`);
    out.push(`    ${pad("", 40)} ${padL("n", 4)}${oHead}`);
    for (const seg of segs) {
      out.push(`    ${pad(seg.label, 40)} ${padL(String(seg.n), 4)}${view.objections.map((c) => padL(pct(v0(seg.value.shares, c.code)), 10)).join("")}${seg.small ? "  (n < 15)" : ""}`);
    }
  }

  h("Verbatims");
  for (const v of a.verbatims) out.push(`  [${view.behaviors.find((b) => b.code === v.behavior)?.short ?? v.behavior}] « ${v.text} » — ${v.who}`);

  h("Cohérence");
  out.push(`  Réparées : ${pct(a.anomalies.repairedRate)} ; anomalies restantes : ${pct(a.anomalies.rate)}`);
  for (const [code, k] of Object.entries(a.anomalies.initialByCode)) {
    out.push(`  - ${CHECK_LABELS[code] ?? code} : ${k} avant réparation, ${a.anomalies.byCode[code] ?? 0} après`);
  }

  h("Coût");
  const u = a.usage;
  out.push(
    `  Par réponse : ${(u.avgDurationMs / 1000).toFixed(1)} s, ${u.avgInputTokens} tokens en entrée (dont ${u.avgCacheReadTokens} en cache), ${u.avgOutputTokens} en sortie` +
      (u.totalCostUsd ? ` ; coût indicatif total ${u.totalCostUsd} $ (couvert par l'abonnement)` : ""),
  );
}

export function formatSummary(s: StudySummary): string {
  const out: string[] = [];
  out.push(`Étude ${s.study.id} — ${s.study.name}`);
  out.push(`Projet : ${s.project.name} (${s.project.price}) ; protocole ${s.study.protocol} ; ${s.study.backend} / ${s.study.model}`);
  out.push(`Réponses : ${s.study.responses}/${s.study.sampleSize} (statut ${s.study.status})`);
  out.push(`⚠ ${s.methodNote}`);
  for (const e of s.eligibility ?? []) {
    const p1 = (x: number) => `${(x * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;
    out.push(
      `${GROUP_LABELS[e.group] ?? e.group} : socle ${e.socle}${e.modules.length ? ` + ${e.modules.map((m) => m.split("@")[0]).join(", ")}` : ""}` +
        (e.expression
          ? ` ; filtre « ${e.expression} » ; éligibilité ${p1(e.rate)} des adultes [${p1(e.ci[0])} ; ${p1(e.ci[1])}], ${e.eligible} sur ${e.draws.toLocaleString("fr-FR")} tirages${e.rare ? " (cible rare)" : ""}`
          : " ; sans filtre"),
    );
  }
  const view = scaleView(s.protocol, s.project.behaviorLabels);
  if (!s.groups.length) {
    formatAnalysis(s.overall, out, "", s.project.priceUnit, moneyFormatter(s.project), s.project.revenueEquivalent, view);
    formatDriversSection(s, out);
    formatConfidenceSection(s, out);
    return out.join("\n");
  }
  out.push("", "Comparaison des groupes", "═══════════════════════");
  const cols = s.groups.map((g) => g.label);
  out.push(`  ${pad("", 36)}${cols.map((c) => padL(c.slice(0, 14), 16)).join("")}`);
  const line = (label: string, f: (a: Analysis) => string) => out.push(`  ${pad(label, 36)}${s.groups.map((g) => padL(f(g.analysis), 16)).join("")}`);
  line("Effectif", (a) => String(a.n));
  line("Pas concernées", (a) => pct(a.relevance.notConcernedShare));
  for (const b of view.behaviors) line(b.label, (a) => pct(a.behaviors.overall.shares[b.code] ?? 0));
  line("Transmettrait l'offre", (a) => (a.forward.n ? pct(a.forward.share) : "—"));
  line("Ne paierait à aucun prix", (a) => (a.role && !a.role.pricing ? "—" : pct(a.vanWestendorp.neverPayShare)));
  if (s.groups.some((g) => g.analysis.expectedUsage)) line("Usage régulier attendu", (a) => (a.expectedUsage ? pct(a.expectedUsage.regularShare) : "—"));
  if (s.groups.some((g) => g.analysis.payment?.estimated)) {
    line("Part payante estimée (M2)", (a) => (a.payment?.estimated ? pct(a.payment.estimated.value) : "—"));
  }
  for (const t of s.groups[0]!.analysis.gaborGranger.tiers) {
    line(`Gabor-Granger oui à ${moneyFormatter(s.project)(t.price)}`, (a) => (a.role && !a.role.pricing ? "—" : pct(a.gaborGranger.tiers.find((x) => x.price === t.price)?.demand ?? 0)));
  }
  for (const c of view.objections) line(`Objection : ${c.label}`, (a) => pct(a.objections.overall.shares[c.code] ?? 0));
  line("Anomalies restantes", (a) => pct(a.anomalies.rate));
  for (const g of s.groups) {
    out.push("", "", `▶ ${g.label} (${g.packVersions.join(", ")})`, "═".repeat(Math.min(78, g.label.length + 4)));
    formatAnalysis(g.analysis, out, `${g.label} · `, s.project.priceUnit, moneyFormatter(s.project), s.project.revenueEquivalent, view);
  }
  formatDriversSection(s, out);
  formatCrossRolesSection(s, out);
  formatConfidenceSection(s, out);
  return out.join("\n");
}

/** Section croisée entre rôles (phase 7). */
function formatCrossRolesSection(s: StudySummary, out: string[]): void {
  if (!s.crossRoles) return;
  const t = "Croisement des rôles";
  out.push("", t, "─".repeat(t.length));
  for (const o of s.crossRoles.overview) {
    out.push(
      `  ${pad(o.label, 28)} n = ${padL(String(o.n), 3)} ; essai ${pct(o.trial)}` +
        (o.regularUse !== null ? ` ; usage régulier ${pct(o.regularUse)}` : "") +
        (o.observedPayment !== null ? ` ; paiement observé ${pct(o.observedPayment)}` : "") +
        (o.lowTierYes !== null ? ` ; oui au palier bas ${pct(o.lowTierYes)}` : ""),
    );
  }
  for (const d of s.crossRoles.dependencies) out.push(`  → ${d.sentence}`);
  out.push(`  ${s.crossRoles.note}`);
}

/** Section ajoutée en fin de résumé : indice de confiance. */
function formatConfidenceSection(s: StudySummary, out: string[]): void {
  if (!s.confidence) return;
  const t = "Indice de confiance";
  out.push("", t, "─".repeat(t.length));
  out.push(...formatConfidence(s.confidence));
}

/** Section ajoutée en fin de résumé : facteurs d'engagement. */
function formatDriversSection(s: StudySummary, out: string[]): void {
  if (!s.drivers) return;
  const g = s.drivers.group;
  const t = `Facteurs d'engagement${g ? ` (${GROUP_LABELS[g] ?? g})` : ""}`;
  out.push("", t, "─".repeat(t.length));
  out.push(...formatDrivers(s.drivers, 5));
  out.push("  Détail : npm run study:drivers -- --study " + s.study.id);
}
