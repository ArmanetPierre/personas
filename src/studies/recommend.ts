import { studyAudience } from "./locale";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify as toYaml } from "yaml";
import { z } from "zod";
import type { Db } from "../db/client";
import { studies as studiesTable, type Persona, type Project, type ResponseRow, type Study } from "../db/schema";
import type { Engine, Usage } from "../engine";
import { moduleLibrary } from "../modules/registry";
import type { Pack } from "../personas/pack";
import { CHECK_DRAWS, checkVariant, filterCatalogue, moduleCatalogue } from "../population/suggest";
import { DEFAULT_RARE_THRESHOLD } from "../population/target";
import { compareSummaries } from "./compare";
import { formatProjectPrice, hasGenericPricing, pricingOf } from "./price-model";
import { createProject, getProject, projectFileSchema, readProjectFile, slugify, type ProjectFile } from "./project";
import { protocolVersionOf, QUESTION_KEY } from "./protocols/concept-price";
import { protocolOfPayload, protocolTools, type ResolvedProtocol } from "./protocols/protocol";
import { readTaxonomy, recodedDistribution } from "./recode";
import type { ConceptPricePayload } from "./run";
import { listStudies, personasByIds, repeatStudies, studyResponses } from "./store";
import { createStudy } from "./study";
import { moneyFormatter, summarize, type Analysis, type StudySummary } from "./summary";
import { formatPaymentLine, type PaymentMeasure } from "./payment";
import type { ConfidenceIndex } from "./confidence";

/** Chemins de preuve qui désignent un niveau absolu (intérêt, essai, paiement, demande à un palier). */
const ABSOLUTE_LEVEL_PATH = /(\.payers|\.freeSignupOrMore|\.interestOrMore|\.payment\.|\.gaborGranger\.tiers\[\d+\]\.demand|\.behaviors\.)/;

/**
 * Recommandations après une étude (`study:recommend`) : constats et recommandations ancrés dans
 * les chiffres du résumé, vérifiés automatiquement, et proposition d'étude suivante prête à créer
 * (`createNextStudy`), sans la lancer.
 *
 * Contrat : `StudyRecommendations` ci-dessous, fichier `data/recommendations/<studyId>.json`.
 */

/** 2 : double mesure du paiement (M1, M2) et indice de confiance dans l'entrée, statut obligatoire des niveaux absolus. */
export const RECOMMEND_VERSION = "2";
export type Strength = "faible" | "moyenne" | "forte";
export const REC_KINDS = ["prix", "cible", "offre", "message", "questionnaire", "autre"] as const;
export type RecKind = (typeof REC_KINDS)[number];

export interface Evidence {
  metric: string;
  value: string;
  /** Chemin dans le JSON d'entrée (`data/recommendations/<id>.input.json`), ex. `groups[0].analysis.vanWestendorp.opp`. */
  source: string;
}

export interface NextStudy {
  hypothesis: string;
  successCriterion: string;
  /** Blocs du fichier projet à remplacer (price, target, pitch, protocol, freeOffer…), validés par le schéma du projet. */
  projectPatch: Record<string, unknown>;
  sample: "same_sample" | "new_target";
  n: number;
  control?: number;
  estimatedCalls: number;
  estimatedMinutes: number;
  /** Ajout : éligibilité mesurée du filtre proposé (`projectPatch.target`), sur `draws` tirages virtuels. */
  targetCheck?: { rate: number; draws: number };
}

export interface Recommendation {
  id: string;
  kind: RecKind;
  title: string;
  rationale: string;
  evidence: Evidence[];
  confidence: Strength;
  nextStudy?: NextStudy;
}

export interface StudyRecommendations {
  studyId: string;
  generatedAt: string;
  model: string;
  inputsHash: string;
  headline: string;
  findings: Array<{ title: string; detail: string; evidence: Evidence[]; strength: Strength }>;
  recommendations: Recommendation[];
  caveats: string[];
  /** Ajout : bilan de la vérification des preuves et des propositions d'étude. */
  verification: Verification;
  /** Ajout : études liées prises en compte. */
  relatedStudies: string[];
  /**
   * Ajout v3 : niveaux absolus du groupe de référence, toujours avec leur statut. M1 (paiement observé)
   * n'est jamais présenté sans G, M2, le statut de calibration et l'indice de confiance.
   */
  absoluteLevels?: {
    observed: number;
    lowTierYes: { price: number; share: number } | null;
    estimated: { value: number; ci: [number, number]; confidence: string; calibration: string } | null;
    confidenceIndex: { level: string; label: string; score: number; warning: string | null };
    line: string;
  };
  /** Ajout : appels et tokens consommés. */
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

export interface Verification {
  evidenceChecked: number;
  evidenceValid: number;
  repaired: boolean;
  /** Preuves supprimées après réparation (chemin introuvable ou valeur différente). */
  dropped: Array<{ where: string; source: string; value: string; reason: string }>;
  /** Propositions d'étude écartées (patch invalide, filtre de cible invalide). */
  droppedNextStudies: Array<{ recommendation: string; reason: string }>;
  notes: string[];
}

// ─── Chemins et vérification des preuves ──────────────────────────────────────

/** Valeur au chemin `a.b[0].c` (ou `a["x.y"]`) ; `undefined` si absent. */
export function getPath(obj: unknown, path: string): unknown {
  const tokens: Array<string | number> = [];
  const re = /\s*(?:\.?([A-Za-z_$][\w$-]*)|\[(\d+)\]|\["([^"]+)"\])/y;
  let i = 0;
  while (i < path.length) {
    re.lastIndex = i;
    const m = re.exec(path);
    if (!m || m.index !== i || m[0].length === 0) return undefined;
    tokens.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3]!));
    i = re.lastIndex;
  }
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[t];
  }
  return cur;
}

const numbersIn = (s: string) =>
  [...s.replace(/ | /g, " ").matchAll(/[-+−]?\d+(?:[  ]\d{3})*(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(/[  ]/g, "").replace(",", ".").replace("−", "-")));

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** La valeur citée correspond-elle à la valeur du JSON (tolérance d'arrondi ; part en % ou en fraction) ? */
export function valueMatches(actual: unknown, cited: string): boolean {
  if (typeof actual === "number") {
    const tol = Math.max(0.006, Math.abs(actual) * 0.01);
    return numbersIn(cited).some((x) => Math.abs(x - actual) <= tol || Math.abs(x / 100 - actual) <= Math.max(0.006, Math.abs(actual) * 0.02) || Math.abs(x - actual * 100) <= 0.6);
  }
  if (typeof actual === "string") {
    const a = norm(actual);
    const c = norm(cited);
    return a.length > 0 && (a.includes(c) || c.includes(a));
  }
  if (typeof actual === "boolean") return norm(cited).includes(actual ? "oui" : "non") || norm(cited).includes(String(actual));
  return false;
}

export function checkEvidence(input: unknown, e: Evidence): string | null {
  const v = getPath(input, e.source);
  if (v === undefined) return "chemin introuvable dans le JSON d'entrée";
  if (v !== null && typeof v === "object") return "le chemin désigne un objet, pas une valeur";
  if (v === null) return "valeur nulle à ce chemin";
  return valueMatches(v, e.value) ? null : `valeur différente (JSON : ${JSON.stringify(v)})`;
}

// ─── Entrée compacte ──────────────────────────────────────────────────────────

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const roundShares = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, r3(v)]));

function compactAnalysis(a: Analysis, proto: ResolvedProtocol, withSegments: boolean) {
  const t = protocolTools(proto);
  const engage = (shares: Record<string, number>, l: "interest" | "free_trial" | "payment") => r3(t.behaviorCodes.filter((c) => t.atLeast(c, l)).reduce((s, c) => s + (shares[c] ?? 0), 0));
  return {
    n: a.n,
    behaviors: roundShares(a.behaviors.overall.shares),
    interestOrMore: engage(a.behaviors.overall.shares, "interest"),
    freeSignupOrMore: r3(a.behaviors.freeSignupOrMore),
    payers: r3(a.behaviors.payers),
    notConcerned: r3(a.relevance.notConcernedShare),
    relevance: roundShares(a.relevance.overall.shares),
    forward: a.forward.n ? r3(a.forward.share) : null,
    vanWestendorp: { n: a.vanWestendorp.n, neverPayShare: r3(a.vanWestendorp.neverPayShare), pmc: a.vanWestendorp.pmc, opp: a.vanWestendorp.opp, ipp: a.vanWestendorp.ipp, pme: a.vanWestendorp.pme },
    gaborGranger: { tiers: a.gaborGranger.tiers.map((x) => ({ price: x.price, demand: r3(x.demand), revenuePer100: x.revenuePer100 })), bestPrice: a.gaborGranger.bestPrice },
    objections: { shares: roundShares(a.objections.overall.shares), perRespondent: a.objections.perRespondent, ...(a.objections.canonical && { canonical: roundShares(a.objections.canonical.shares) }) },
    anomalies: r3(a.anomalies.rate),
    ...(a.payment && { payment: compactPayment(a.payment) }),
    ...(a.role && { role: { id: a.role.id, perspective: a.role.perspective, pricing: a.role.pricing } }),
    ...(a.expectedUsage && { expectedUsage: { shares: roundShares(a.expectedUsage.shares), regularShare: r3(a.expectedUsage.regularShare) } }),
    ...(a.adoptionThreshold && { adoptionThreshold: a.adoptionThreshold }),
    ...(a.needFrequency && {
      needFrequency: { shares: roundShares(a.needFrequency.shares), recurringShare: r3(a.needFrequency.recurringShare), rareShare: r3(a.needFrequency.rareShare), diagnostic: a.needFrequency.diagnostic },
    }),
    ...(withSegments && {
      segments: Object.entries(a.behaviors.bySegment).map(([dim, rows]) => ({
        dimension: dim,
        label: a.autoDimensions?.find((d) => d.id === dim)?.label ?? dim,
        values: rows.map((s) => ({ label: s.label, n: s.n, interestOrMore: engage(s.value.shares, "interest"), freeSignupOrMore: engage(s.value.shares, "free_trial"), small: s.small })),
      })),
    }),
  };
}

/** Double mesure du paiement, compacte : M1, G au palier bas, M2 avec intervalle, statut et confiance. */
function compactPayment(m: PaymentMeasure) {
  return {
    observed: r3(m.observed),
    lowTierYes: m.lowTierYes ? { price: m.lowTierYes.price, share: r3(m.lowTierYes.share), n: m.lowTierYes.n } : null,
    estimated: m.estimated
      ? { value: r4(m.estimated.value), ci: [r4(m.estimated.ci[0]), r4(m.estimated.ci[1])], calibration: m.estimated.calibration.status, confidence: m.estimated.confidence }
      : null,
  };
}
const r4 = (x: number) => Math.round(x * 10000) / 10000;

function compactConfidence(c: ConfidenceIndex) {
  return {
    level: c.level,
    label: c.label,
    score: c.score,
    n: c.sample.n,
    sampleWarning: c.sample.warning,
    calibrated: c.protocol.calibrated,
    protocolVersion: c.protocol.version,
    pitch: { score: c.pitch.score, ok: c.pitch.ok },
    caveats: c.caveats,
    reliable: c.reliable,
  };
}

function compactDrivers(s: StudySummary) {
  if (!s.drivers) return null;
  return {
    group: s.drivers.group,
    n: s.drivers.n,
    outcomes: s.drivers.outcomes.map((o) => ({
      level: o.level,
      label: o.label,
      rate: r3(o.rate),
      positives: o.positives,
      ...(o.note && { note: o.note }),
      factors: o.factors.slice(0, 6).map((f) => ({
        dimension: f.dimension,
        label: f.label,
        cramersV: f.cramersV,
        q: f.q,
        sentence: f.sentence,
        values: [...f.values].filter((v) => !v.small).sort((a, b) => Math.abs(b.diffPts) - Math.abs(a.diffPts)).slice(0, 3).map((v) => ({ label: v.label, n: v.n, rate: r3(v.rate), restRate: r3(v.restRate), diffPts: v.diffPts })),
      })),
    })),
  };
}

/** Études liées : même projet, variantes (projet dérivé, `variantOf`) ou même échantillon. */
export function relatedStudies(db: Db, study: Study, project: Project): Study[] {
  const all = listStudies(db).filter((s) => s.id !== study.id && s.status === "completed" && s.personaIds.length >= 20);
  const base = (project.extra as { variantOf?: string }).variantOf ?? project.id;
  const projects = new Map<string, Project | undefined>();
  const proj = (id: string) => (projects.has(id) ? projects.get(id) : (projects.set(id, getProject(db, id)), projects.get(id)));
  return all.filter((s) => {
    if (s.projectId === project.id) return true;
    if (s.sampleFromStudyId === study.id || study.sampleFromStudyId === s.id || (study.sampleFromStudyId && s.sampleFromStudyId === study.sampleFromStudyId)) return true;
    const p = proj(s.projectId);
    const vOf = (p?.extra as { variantOf?: string } | undefined)?.variantOf;
    return vOf === base || s.projectId === base || s.projectId.startsWith(`${base}-`) || base.startsWith(`${s.projectId}-`);
  });
}

/** Fichier projet (forme déclarative) d'un projet : son fichier source s'il existe, sinon reconstruit depuis la base. */
export function projectFileOf(project: Project): { file: ProjectFile; path: string | null } {
  const src = (project.extra as { sourceFile?: string }).sourceFile;
  if (src && existsSync(src)) {
    const f = readProjectFile(src);
    if ((f.id ?? slugify(f.name)) === project.id) return { file: f, path: src };
  }
  const x = project.extra as Record<string, unknown>;
  const pricing = hasGenericPricing(project) ? pricingOf(project) : null;
  const raw = {
    id: project.id,
    name: project.name,
    pitch: project.pitch,
    ...(project.targetAudience && { targetAudience: project.targetAudience }),
    ...(project.businessModel && { businessModel: project.businessModel }),
    price: pricing ?? { amountEur: project.priceEur ?? 1, period: project.pricePeriod ?? "month" },
    ...(project.freeOffer && { freeOffer: project.freeOffer }),
    competitors: project.competitors,
    alternatives: project.alternatives,
    ...(!pricing && x.priceTiers ? { priceTiers: x.priceTiers } : {}),
    ...(x.target ? { target: x.target } : {}),
    ...(x.control ? { control: x.control } : {}),
    ...(x.protocol ? { protocol: x.protocol } : {}),
  };
  return { file: projectFileSchema.parse(raw), path: null };
}

/** Réserves connues par étude (fichier versionné `docs/rex/study-notes.json`, ou `data/study-notes.json`). */
export function studyNotes(studyId: string, root = process.cwd()): string[] {
  for (const p of [join(root, "docs/rex/study-notes.json"), join(root, "data/study-notes.json")]) {
    if (!existsSync(p)) continue;
    const notes = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const v = notes[studyId];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function spread<T>(list: T[], k: number): T[] {
  if (list.length <= k) return list;
  const step = list.length / k;
  return Array.from({ length: k }, (_, i) => list[Math.floor(i * step)]!);
}

export interface RecommendationContext {
  study: Study;
  project: Project;
  summary: StudySummary;
  input: Record<string, unknown>;
  baseFile: ProjectFile;
  baseFilePath: string | null;
  related: Study[];
  avgSecondsPerResponse: number;
  /** Études réelles (≥ 50 réponses) et nombre sans aucun payeur au prix affiché. */
  pessimism: { studies: number; zeroPayers: number };
}

function loadSummary(db: Db, pack: Pack, study: Study, project: Project): { summary: StudySummary; rows: ResponseRow[]; personas: Map<string, Persona> } {
  const rows = studyResponses(db, study.id, QUESTION_KEY);
  if (!rows.length) throw new Error(`Aucune réponse pour l'étude ${study.id}.`);
  const personas = new Map(personasByIds(db, rows.map((r) => r.personaId)).map((p) => [p.id, p]));
  return { summary: summarize(pack, study, project, rows, personas, undefined, { repeats: repeatStudies(db, study) }), rows, personas };
}

/** Rassemble l'entrée (JSON compact, chemins stables) des recommandations. */
export function buildRecommendationContext(db: Db, pack: Pack, studyId: string): RecommendationContext {
  const study = db.select().from(studiesTable).all().find((s) => s.id === studyId || s.id.startsWith(studyId));
  if (!study) throw new Error(`Étude introuvable : ${studyId}`);
  const project = getProject(db, study.projectId);
  if (!project) throw new Error(`Projet introuvable : ${study.projectId}`);
  const { summary, rows, personas } = loadSummary(db, pack, study, project);
  const proto = summary.protocol ?? protocolOfPayload(undefined);
  const tools = protocolTools(proto);
  const { file: baseFile, path: baseFilePath } = projectFileOf(project);

  // Verbatims par comportement et par frein (groupe cible, ou toute l'étude)
  // Groupe de référence : la cible ; projet multi-rôles : le premier rôle payeur (sinon le premier rôle)
  const refGroup = summary.roles?.length ? (summary.roles.find((r) => r.pricing)?.group ?? summary.roles[0]!.group) : "target";
  const targetRows = rows.filter((r) => (study.personaGroups[r.personaId] ?? "target") === refGroup);
  const who = (r: ResponseRow) => {
    const p = personas.get(r.personaId)!;
    return `${p.firstName ?? "?"}, ${p.age} ans, ${p.occupation.toLowerCase()}`;
  };
  const byBehavior = Object.fromEntries(
    tools.behaviorCodes
      .map((b) => [b, spread(targetRows.filter((r) => (r.payload as ConceptPricePayload).answer.behavior === b), 3).map((r) => ({ who: who(r), verbatim: (r.payload as ConceptPricePayload).answer.verbatim }))] as const)
      .filter(([, v]) => v.length),
  );
  const recodedKeys = [...new Set(targetRows.flatMap((r) => Object.keys((r.payload as ConceptPricePayload).recoded ?? {})))];
  const objectionCode = (r: ResponseRow, i: number) => {
    const p = r.payload as ConceptPricePayload;
    const k = recodedKeys[0];
    return k && p.recoded?.[k] ? p.recoded[k]!.codes[i]! : p.answer.objections[i]!.category;
  };
  const byObjection: Record<string, Array<{ who: string; detail: string }>> = {};
  for (const r of targetRows) {
    (r.payload as ConceptPricePayload).answer.objections.forEach((o, i) => (byObjection[objectionCode(r, i)] ??= []).push({ who: who(r), detail: o.detail }));
  }
  for (const k of Object.keys(byObjection)) byObjection[k] = spread(byObjection[k]!, 3);

  // Objections recodées
  const recoded = recodedKeys.map((key) => {
    const file = join(process.cwd(), "data/summaries", `${study.id}-recode-${key}.json`);
    const tax = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { taxonomy: ReturnType<typeof readTaxonomy> }).taxonomy : null;
    const d = tax ? recodedDistribution(targetRows, tax) : null;
    return d && tax ? { key, n: d.n, categories: tax.objections.map((o) => ({ code: o.code, label: o.label, share: d.shares[o.code] ?? 0 })) } : null;
  }).filter((x) => x !== null);

  // Études liées et comparaison (cette étude en référence)
  const related = relatedStudies(db, study, project);
  const relatedSummaries = related.map((s) => ({ s, sum: loadSummary(db, pack, s, getProject(db, s.projectId)!).summary }));
  let comparison: unknown = null;
  if (relatedSummaries.length) {
    const c = compareSummaries([summary, ...relatedSummaries.map((x) => x.sum)], refGroup);
    comparison = {
      reference: c.referenceId,
      unitsDiffer: c.unitsDiffer,
      ...(c.scalesDiffer && { scalesDiffer: true }),
      studies: c.entries.map((e, i) => ({
        studyId: e.studyId,
        project: e.projectId,
        price: e.price,
        n: e.n,
        freeSignupOrMore: r3(e.freeSignupOrMore),
        payers: r3(e.payers),
        notConcerned: r3(e.notConcerned),
        neverPay: r3(e.vanWestendorp.neverPayShare),
        vanWestendorp: { opp: e.vanWestendorp.opp, ipp: e.vanWestendorp.ipp, pmc: e.vanWestendorp.pmc, pme: e.vanWestendorp.pme },
        gaborGranger: e.gaborGranger.map((t) => ({ price: t.price, demand: r3(t.demand), revenuePer100: t.revenuePer100 })),
        objections: roundShares(e.objections),
        ...(e.payment && { payment: compactPayment(e.payment) }),
        ...(e.confidence && { confidence: e.confidence.label }),
        ...(i > 0 && {
          deltaPts: {
            freeSignupOrMore: c.deltas[i]!.freeSignupOrMore,
            payers: c.deltas[i]!.payers,
            notConcerned: c.deltas[i]!.notConcerned,
            neverPay: c.deltas[i]!.vwNeverPay,
            ...(c.deltas[i]!.lowTierYes !== undefined && { lowTierYes: c.deltas[i]!.lowTierYes, paymentEstimated: c.deltas[i]!.paymentEstimated }),
          },
        }),
      })),
    };
  }

  const groups = summary.groups.length
    ? summary.groups.map((g) => ({ group: g.group, label: g.label, analysis: compactAnalysis(g.analysis, proto, g.group === refGroup) }))
    : [{ group: "target", label: "Échantillon", analysis: compactAnalysis(summary.overall, proto, true) }];

  const input = {
    study: { id: study.id, name: study.name, status: study.status, responses: summary.study.responses, seed: study.seed, protocol: summary.study.protocol },
    project: { id: project.id, price: formatProjectPrice(project), file: baseFile },
    ...(summary.eligibility && { eligibility: summary.eligibility }),
    ...(summary.protocol && { protocolScale: { behaviors: proto.behaviors.map((b) => ({ code: b.code, label: b.label, level: b.level })), objections: proto.objections.map((o) => ({ code: o.code, label: o.label })) } }),
    groups,
    ...(summary.confidence && { confidence: compactConfidence(summary.confidence) }),
    ...(summary.roles && { roles: summary.roles, crossRoles: summary.crossRoles }),
    drivers: compactDrivers(summary),
    recodedObjections: recoded,
    verbatims: { byBehavior, byObjection },
    related: comparison,
    notes: studyNotes(study.id),
  };

  // Pessimisme systématique : études réelles sans payeur
  let real = 0;
  let zero = 0;
  for (const s of listStudies(db).filter((x) => x.personaIds.length >= 50 && x.status === "completed")) {
    const rr = studyResponses(db, s.id, QUESTION_KEY);
    if (rr.length < 50) continue;
    real++;
    const pays = rr.some((r) => {
      const p = r.payload as ConceptPricePayload;
      return protocolTools(protocolOfPayload(p as { protocol?: ResolvedProtocol })).atLeast(p.answer.behavior, "payment");
    });
    if (!pays) zero++;
  }
  const t = summary.groups.find((g) => g.group === refGroup)?.analysis ?? summary.overall;
  return {
    study,
    project,
    summary,
    input,
    baseFile,
    baseFilePath,
    related,
    avgSecondsPerResponse: Math.max(1, t.usage.avgDurationMs / 1000),
    pessimism: { studies: real, zeroPayers: zero },
  };
}

// ─── Génération ───────────────────────────────────────────────────────────────

const evidenceSchema = z.object({ metric: z.string(), value: z.string(), source: z.string() });
const patchSchema = z.object({
  pitch: z.string().optional(),
  freeOffer: z.string().optional(),
  price: z.record(z.string(), z.unknown()).optional(),
  priceTiers: z.array(z.number()).optional(),
  target: z.record(z.string(), z.unknown()).optional(),
  control: z.record(z.string(), z.unknown()).optional(),
  protocol: z.record(z.string(), z.unknown()).optional(),
  competitors: z.array(z.string()).optional(),
});
const llmSchema = z.object({
  headline: z.string(),
  findings: z.array(z.object({ title: z.string(), detail: z.string(), evidence: z.array(evidenceSchema).min(1), strength: z.enum(["faible", "moyenne", "forte"]) })).min(2).max(6),
  recommendations: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(REC_KINDS),
        title: z.string(),
        rationale: z.string(),
        evidence: z.array(evidenceSchema).min(1),
        confidence: z.enum(["faible", "moyenne", "forte"]),
        nextStudy: z
          .object({
            hypothesis: z.string(),
            successCriterion: z.string(),
            projectPatch: patchSchema,
            sample: z.enum(["same_sample", "new_target"]),
            n: z.number().int().positive(),
            control: z.number().int().nonnegative().optional(),
          })
          .optional(),
      }),
    )
    .min(2)
    .max(5),
  caveats: z.array(z.string()).max(6),
});
type LlmOutput = z.infer<typeof llmSchema>;

export function buildRecommendPrompt(ctx: RecommendationContext): { system: string; user: string } {
  // Modules de la population étudiée et des études liées (une étude v1 peut avoir une variante ciblée v2)
  const mods = new Set(
    [ctx.study, ...ctx.related].flatMap((s) =>
      ((s.populations ?? []) as Array<{ group: string; eligibility?: { modules?: string[] } }>)
        .filter((p) => p.group === "target")
        .flatMap((p) => (p.eligibility?.modules ?? []).map((m) => m.split("@")[0]!)),
    ),
  );
  const lib = moduleLibrary();
  const sub = new Map([...lib].filter(([id]) => mods.has(id) || [...mods].some((m) => lib.get(m)?.def.requires.includes(id))));
  const system = `Tu es analyste en études de marché. À partir des résultats d'une étude « concept + prix » menée auprès de personas synthétiques, tu rédiges une synthèse décisionnelle pour le porteur du projet : une conclusion, des constats, et de 2 à 5 recommandations classées par priorité, dont au moins une étude suivante concrète quand c'est pertinent.

## Ancrage (obligatoire)
- Chaque constat et chaque recommandation cite ses preuves dans « evidence » : metric (ce que c'est), value (la valeur telle qu'elle figure dans le JSON, formatée lisiblement : 0.19 peut s'écrire « 19 % »), source (le chemin exact dans le JSON d'entrée, par exemple groups[0].analysis.vanWestendorp.opp, groups[0].analysis.segments[3].values[1].interestOrMore, drivers.outcomes[0].factors[1].values[0].rate, related.studies[1].neverPay).
- N'invente aucun chiffre. Un chiffre absent du JSON ne peut pas servir de preuve. Les chemins sont vérifiés automatiquement.
- Les comparaisons entre études sur le même échantillon (related) sont plus fiables que les niveaux absolus : appuie-toi d'abord sur elles.
- Ce qui est fiable : objections, segments, écarts entre variantes, effet du ton. Les niveaux absolus (intérêt, essai, paiement) sont indicatifs.
- Ne présente jamais un niveau absolu sans son statut. Le paiement observé (payers, payment.observed) est presque toujours nul chez des personas synthétiques : ne le cite jamais seul, mais avec la part de « oui » au palier bas (payment.lowTierYes), la part payante estimée (payment.estimated : valeur, intervalle, statut de calibration) et l'indice de confiance (confidence). Si payment.estimated.calibration vaut « uncalibrated », écris « non calibrée » et n'en tire qu'un ordre de grandeur.
- Indice de confiance « low » : aucune conclusion ni recommandation de confiance « forte » fondée sur un niveau absolu ; appuie-la sur des écarts, des objections ou des segments. Avertissement d'effectif (confidence.sampleWarning) : propose une passe répétée ou un échantillon plus grand avant de trancher.

## Ce que tu dois couvrir
- Prix : plage acceptable (PMC à PME du Van Westendorp), point optimal (OPP), palier au revenu maximal du Gabor-Granger, et la comparaison entre modèles de prix (achat unique, abonnement) si une étude liée existe. Propose des paliers concrets pour l'étude suivante (3 prix, dans l'unité de l'offre), et dis pourquoi.
- Cible : fonde-toi sur les facteurs d'engagement (drivers) et les segments. Un filtre de cible n'utilise que les variables du catalogue ci-dessous, avec leurs codes exacts.
- Offre ou message : fonde-toi sur les freins (objections, de préférence recodées si elles existent) et les verbatims.
- Classe les recommandations de la plus utile à la moins utile. Confiance : « forte » seulement si l'écart est net, sur un effectif suffisant et cohérent entre études.

## Étude suivante (nextStudy)
- projectPatch : uniquement les blocs du fichier projet qui changent, au même format que project.file (price complet si le prix change, avec ses tiers ; target complet si la cible change ; pitch ou freeOffer si le message change). Une seule différence par étude, pour isoler l'effet.
- sample : « same_sample » pour tester un prix, une offre ou un message sur les mêmes personas (comparaison directe) ; « new_target » si la cible change. n : effectif de la cible ; control : effectif du témoin (0 ou absent si inutile).
- hypothesis : ce qu'on attend ; successCriterion : un critère chiffré et vérifiable.

## Format des blocs de projectPatch
- price, forme historique (si project.file l'utilise) : { "amountEur": 5, "period": "month" } avec period parmi month (par mois), year (par an), once (achat unique), connection (par mise en relation acceptée) ; les paliers vont alors dans priceTiers (ex. [2, 5, 9]) au même niveau que price.
- price, forme générique : { "currency": "EUR", "offers": [ { "id": "pro", "amount": 19, "unit": "one_time" } ], "reference": "pro", "tiers": [15, 19, 24], "freemium": {…} } avec unit parmi month, year, one_time, usage (avec "usageLabel", ex. « mise en relation »), quantity (avec "quantity": { "unit": "kg" }). Garde la forme de project.file et recopie ses champs inchangés (freemium, libellés).
- Le prix affiché (amount ou amountEur) doit faire partie des paliers.
- target : { "socle": "${promptSocle(ctx)}", "modules": ["module_a", "module_b"], "eligibility": "<filtre>", "n": 200 }, rien d'autre ; le filtre n'utilise que les variables du catalogue. Exemple de filtre existant : ${ctx.related.concat(ctx.study).map((s) => ((s.populations ?? []) as Array<{ group: string; eligibility?: { expression?: string | null; modules?: string[] } }>).find((p) => p.group === "target")?.eligibility).filter((e) => e?.expression).map((e) => `modules ${JSON.stringify((e!.modules ?? []).map((m) => m.split("@")[0]))}, eligibility « ${e!.expression} »`)[0] ?? "age >= 25 and age <= 45 and pcs in [3, 4]"}.

## Prudence
« caveats » : les limites propres à cette étude (effectifs faibles, réserves connues dans notes, écarts fragiles). Les réserves générales (absence de calibration) sont ajoutées automatiquement.

${studyAudience(ctx.study).locale === "en" ? "L'étude est en anglais (socle de Singapour ou autre socle anglophone) : réponds en anglais (titres, détails, justifications, réserves), avec l'objet JSON seul. Ton : factuel, sans enthousiasme commercial." : "Réponds en français, avec l'objet JSON seul. Ton : factuel, sans enthousiasme commercial."}

## Catalogue des variables de filtre de cible
Variables du socle :
${filterCatalogue(promptSocle(ctx))}
${sub.size ? `\nModules de la population étudiée :\n${moduleCatalogue(sub)}` : ""}
Syntaxe : and, or, not, ==, !=, <, <=, >, >=, in [a, b], not in [a, b] ; les attributs de module s'écrivent module.attribut.`;
  const user = `## JSON d'entrée\n${JSON.stringify(ctx.input)}`;
  return { system, user };
}

/** Socle montré dans le prompt : « fr » pour toute cible France (prompt historique inchangé), sinon celui du projet. */
function promptSocle(ctx: RecommendationContext): string {
  const socle = baseSocleOf(ctx.baseFile, ctx.study);
  return countryOf(socle) === "fr" ? "fr" : socle;
}

/** Fusion d'un patch dans le fichier projet, puis validation zod. */
export function applyProjectPatch(base: ProjectFile, patch: Record<string, unknown>, extra: { id?: string } = {}): { ok: true; file: ProjectFile } | { ok: false; error: string } {
  const merged: Record<string, unknown> = { ...base, ...patch, ...(extra.id && { id: extra.id }) };
  // Un nouveau prix au format générique remplace les paliers historiques
  if (patch.price && typeof patch.price === "object" && !("amountEur" in (patch.price as object))) delete merged.priceTiers;
  const r = projectFileSchema.safeParse(merged);
  return r.success ? { ok: true, file: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ") };
}

/**
 * Socle de la cible étudiée : celui de la cible du projet de base, sinon le pays du socle de l'étude
 * (« sg-2026.1 » → sg), France par défaut.
 */
export function baseSocleOf(baseFile: Pick<ProjectFile, "target">, study?: Pick<Study, "populations">): string {
  if (baseFile.target?.socle) return baseFile.target.socle;
  return study ? studyAudience(study).country.toLowerCase() : "fr";
}

const countryOf = (socle: string) => socle.toLowerCase().replace(/-.*$/, "");

/**
 * Une étude suivante garde le socle (pays et version) de la cible étudiée : un `target` de patch sans socle,
 * ou d'un autre pays (le modèle recopie l'exemple), reprend celui du projet de base.
 */
export function withBaseSocle(patch: Record<string, unknown>, socle: string): Record<string, unknown> {
  const t = patch.target as { socle?: unknown } | undefined;
  if (!t || typeof t !== "object") return patch;
  if (typeof t.socle === "string" && countryOf(t.socle) === countryOf(socle)) return patch;
  return { ...patch, target: { ...t, socle } };
}

/** Vérifie un filtre de cible : schéma, modules, variables et codes, et au moins une persona éligible, sur le socle de la cible. */
export function checkTargetPatch(target: unknown): { errors: string[]; rate?: number } {
  const t = target as { socle?: string; modules?: string[]; eligibility?: string };
  const r = checkVariant({ id: "x", label: "x", description: "", modules: t.modules ?? [], eligibility: t.eligibility ?? "", quotas: [] } as never, undefined, t.socle ?? "fr");
  return { errors: r.errors, ...(r.checkRate !== undefined && { rate: r.checkRate }) };
}

/** Deux réserves disent-elles la même chose ? (recouvrement des mots significatifs) */
export function similar(a: string, b: string): boolean {
  const words = (s: string) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return a === b;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.5;
}

function estimate(ctx: RecommendationContext, ns: { sample: string; n: number; control?: number }) {
  const narratives = ns.sample === "new_target" ? Math.ceil((ns.n + (ns.control ?? 0)) / 10) : 0;
  const calls = ns.n + (ns.control ?? 0) + narratives;
  return { estimatedCalls: calls, estimatedMinutes: Math.max(1, Math.round((calls * ctx.avgSecondsPerResponse) / 2 / 60)) };
}

interface Check {
  invalidEvidence: Array<{ where: string; e: Evidence; reason: string }>;
  invalidPatches: Array<{ rec: string; reason: string }>;
  checked: number;
}

function checkOutput(ctx: RecommendationContext, out: LlmOutput): Check {
  const invalidEvidence: Check["invalidEvidence"] = [];
  let checked = 0;
  const visit = (where: string, list: Evidence[]) => {
    for (const e of list) {
      checked++;
      const reason = checkEvidence(ctx.input, e);
      if (reason) invalidEvidence.push({ where, e, reason });
    }
  };
  out.findings.forEach((f, i) => visit(`findings[${i}]`, f.evidence));
  out.recommendations.forEach((r) => visit(`recommendations.${r.id}`, r.evidence));
  const invalidPatches: Check["invalidPatches"] = [];
  for (const r of out.recommendations) {
    if (!r.nextStudy) continue;
    r.nextStudy.projectPatch = withBaseSocle(r.nextStudy.projectPatch as Record<string, unknown>, baseSocleOf(ctx.baseFile, ctx.study)) as typeof r.nextStudy.projectPatch;
    const merged = applyProjectPatch(ctx.baseFile, r.nextStudy.projectPatch as Record<string, unknown>, { id: `${ctx.project.id}-${slugify(r.id)}` });
    if (!merged.ok) invalidPatches.push({ rec: r.id, reason: `patch invalide : ${merged.error}` });
    else if (r.nextStudy.projectPatch.target) {
      const t = checkTargetPatch(merged.file.target);
      if (t.errors.length) invalidPatches.push({ rec: r.id, reason: `filtre de cible invalide : ${t.errors.join(" ; ")}` });
    }
  }
  return { invalidEvidence, invalidPatches, checked };
}

function repairPrompt(c: Check): string {
  return `Ta synthèse comporte des erreurs, vérifiées automatiquement contre le JSON d'entrée.
${c.invalidEvidence.length ? `Preuves invalides :\n${c.invalidEvidence.map((x) => `- ${x.where} : source « ${x.e.source} », valeur « ${x.e.value} » : ${x.reason}`).join("\n")}` : ""}
${c.invalidPatches.length ? `Études suivantes invalides :\n${c.invalidPatches.map((x) => `- ${x.rec} : ${x.reason}`).join("\n")}` : ""}
Corrige ces points (chemin exact et valeur reprise du JSON ; patch conforme à la section « Format des blocs de projectPatch » ; target limité à socle, modules, eligibility et n ; filtre avec les codes du catalogue) et renvoie l'objet JSON complet.`;
}

export interface RecommendOptions {
  db: Db;
  pack: Pack;
  engine: Engine;
  force?: boolean;
  outDir?: string;
  log?: (m: string) => void;
}

export function recommendationPath(studyId: string, outDir = join(process.cwd(), "data/recommendations")): string {
  return join(outDir, `${studyId}.json`);
}

export async function recommendStudy(studyId: string, opts: RecommendOptions): Promise<StudyRecommendations> {
  const log = opts.log ?? (() => {});
  const ctx = buildRecommendationContext(opts.db, opts.pack, studyId);
  const { system, user } = buildRecommendPrompt(ctx);
  const inputsHash = createHash("sha256").update(`${RECOMMEND_VERSION}\n${opts.engine.backend.model}\n${system}\n${user}`).digest("hex").slice(0, 16);
  const path = recommendationPath(ctx.study.id, opts.outDir);
  if (!opts.force && existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, "utf8")) as StudyRecommendations;
    if (cached.inputsHash === inputsHash) {
      log(`Recommandations en cache (${path}).`);
      return cached;
    }
  }
  log(`Études liées : ${ctx.related.map((s) => s.id).join(", ") || "aucune"}.`);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  const call = async (messages: Array<{ role: "user" | "assistant"; content: string }>) => {
    const r = await opts.engine.complete({ system, messages, schema: llmSchema, maxTokens: 8_000 });
    calls++;
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return r;
  };
  const first = await call([{ role: "user", content: user }]);
  let out = first.data;
  let check = checkOutput(ctx, out);
  let repaired = false;
  if (check.invalidEvidence.length || check.invalidPatches.length) {
    log(`Vérification : ${check.invalidEvidence.length} preuve(s) et ${check.invalidPatches.length} étude(s) suivante(s) invalides → réparation.`);
    repaired = true;
    try {
      const second = await call([
        { role: "user", content: user },
        { role: "assistant", content: JSON.stringify(out) },
        { role: "user", content: repairPrompt(check) },
      ]);
      out = second.data;
      check = checkOutput(ctx, out);
    } catch (err) {
      log(`Réparation impossible : ${(err as Error).message.slice(0, 200)}`);
    }
  }
  // Suppression des preuves encore invalides et des études suivantes invalides
  const bad = new Set(check.invalidEvidence.map((x) => `${x.where}|${x.e.source}|${x.e.value}`));
  const keep = (where: string, list: Evidence[]) => list.filter((e) => !bad.has(`${where}|${e.source}|${e.value}`));
  const badPatch = new Map(check.invalidPatches.map((x) => [x.rec, x.reason]));
  const verification: Verification = {
    evidenceChecked: check.checked,
    evidenceValid: check.checked - check.invalidEvidence.length,
    repaired,
    dropped: check.invalidEvidence.map((x) => ({ where: x.where, source: x.e.source, value: x.e.value, reason: x.reason })),
    droppedNextStudies: check.invalidPatches.map((x) => ({ recommendation: x.rec, reason: x.reason })),
    notes: [],
  };

  const recommendations: Recommendation[] = out.recommendations.map((r) => {
    const rec: Recommendation = { id: slugify(r.id) || r.id, kind: r.kind, title: r.title, rationale: r.rationale, evidence: keep(`recommendations.${r.id}`, r.evidence), confidence: r.confidence };
    if (r.nextStudy && !badPatch.has(r.id)) {
      const ns = r.nextStudy;
      const targetCheck = ns.projectPatch.target ? checkTargetPatch(applyProjectPatch(ctx.baseFile, ns.projectPatch as Record<string, unknown>).ok ? (applyProjectPatch(ctx.baseFile, ns.projectPatch as Record<string, unknown>) as { file: ProjectFile }).file.target : ns.projectPatch.target) : null;
      rec.nextStudy = {
        hypothesis: ns.hypothesis,
        successCriterion: ns.successCriterion,
        projectPatch: ns.projectPatch as Record<string, unknown>,
        sample: ns.sample,
        n: ns.n,
        ...(ns.control !== undefined && { control: ns.control }),
        ...estimate(ctx, ns),
        ...(targetCheck?.rate !== undefined && { targetCheck: { rate: Math.round(targetCheck.rate * 10000) / 10000, draws: CHECK_DRAWS } }),
      };
      if (targetCheck?.rate !== undefined && targetCheck.rate < DEFAULT_RARE_THRESHOLD) {
        verification.notes.push(
          `« ${rec.id} » : cible rare (${(targetCheck.rate * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} % des adultes, sous le seuil de ${(DEFAULT_RARE_THRESHOLD * 100).toLocaleString("fr-FR")} %) : marché étroit, tirage plus long.`,
        );
      }
    }
    if (!rec.evidence.length) verification.notes.push(`Recommandation « ${rec.id} » sans preuve valide après vérification.`);
    return rec;
  });

  const refG = ctx.summary.roles?.length ? (ctx.summary.roles.find((r) => r.pricing)?.group ?? ctx.summary.roles[0]!.group) : "target";
  const ref = ctx.summary.groups.find((g) => g.group === refG)?.analysis ?? ctx.summary.overall;
  const conf = ctx.summary.confidence;
  const money = moneyFormatter(ctx.summary.project);
  const levelLine = ref.payment ? formatPaymentLine(ref.payment, (x) => money(x)) : null;
  const calibrated = ref.payment?.estimated?.calibration.status === "calibrated";
  // Statut des niveaux absolus : une recommandation « forte » fondée seulement sur eux est ramenée à « moyenne » si l'indice est faible
  for (const r of recommendations) {
    const absolute = r.evidence.filter((e) => ABSOLUTE_LEVEL_PATH.test(e.source));
    if (!absolute.length) continue;
    verification.notes.push(`« ${r.id} » cite un niveau absolu (${absolute.map((e) => e.source).join(", ")}) : à lire avec ${levelLine ?? "la part payante estimée"}${conf ? ` ; indice de confiance ${conf.label}` : ""}.`);
    if (conf?.level === "low" && r.confidence === "forte" && absolute.length === r.evidence.length) {
      r.confidence = "moyenne";
      verification.notes.push(`« ${r.id} » : confiance ramenée de « forte » à « moyenne » (fondée seulement sur des niveaux absolus, indice de confiance faible).`);
    }
  }
  const caveats = [
    `${calibrated ? "Conversion du paiement calibrée" : "Conversion du paiement non calibrée : les niveaux absolus ne sont pas validés sur des produits au résultat connu"}. Pessimisme systématique : ${ctx.pessimism.zeroPayers} des ${ctx.pessimism.studies} études réelles menées à ce jour n'ont aucun payeur au prix affiché.`,
    ...(levelLine ? [`Niveaux absolus (indicatifs) : ${levelLine}.`] : []),
    ...(conf ? [`Indice de confiance des niveaux absolus : ${conf.label} (${conf.score}/3)${conf.sample.warning ? ` ; ${conf.sample.warning}` : ""}.`] : []),
    "Les écarts entre variantes testées sur le même échantillon sont plus fiables que les niveaux absolus (intérêt, paiement).",
    "Les segments de moins de 15 personas et les facteurs à q ≥ 0,1 sont indicatifs.",
    ...studyNotes(ctx.study.id),
    ...out.caveats,
  ].filter((c, i, a) => a.findIndex((x) => similar(x, c)) === i);

  const result: StudyRecommendations = {
    studyId: ctx.study.id,
    generatedAt: new Date().toISOString(),
    model: first.model,
    inputsHash,
    headline: out.headline,
    findings: out.findings.map((f, i) => ({ ...f, evidence: keep(`findings[${i}]`, f.evidence) })),
    recommendations,
    caveats,
    verification,
    relatedStudies: ctx.related.map((s) => s.id),
    usage: { calls, ...usage },
    ...(ref.payment && conf && levelLine && {
      absoluteLevels: {
        observed: ref.payment.observed,
        lowTierYes: ref.payment.lowTierYes ? { price: ref.payment.lowTierYes.price, share: ref.payment.lowTierYes.share } : null,
        estimated: ref.payment.estimated
          ? { value: ref.payment.estimated.value, ci: ref.payment.estimated.ci, confidence: ref.payment.estimated.confidence, calibration: ref.payment.estimated.calibration.status }
          : null,
        confidenceIndex: { level: conf.level, label: conf.label, score: conf.score, warning: conf.sample.warning },
        line: levelLine,
      },
    }),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2));
  writeFileSync(path.replace(/\.json$/, ".input.json"), JSON.stringify(ctx.input, null, 2));
  return result;
}

// ─── Étude suivante ───────────────────────────────────────────────────────────

export interface NextStudyResult {
  projectId: string;
  projectFile?: string;
  studyId: string;
}

export function createNextStudy(
  studyId: string,
  recId: string,
  opts: { confirm: true; db: Db; pack: Pack; outDir?: string; variantsDir?: string; backend?: string; model?: string },
): NextStudyResult {
  if (opts.confirm !== true) throw new Error("Confirmation requise ({ confirm: true }).");
  const { db, pack } = opts;
  const path = recommendationPath(studyId, opts.outDir);
  if (!existsSync(path)) throw new Error(`Aucune recommandation pour ${studyId} : lancer study:recommend.`);
  const recs = JSON.parse(readFileSync(path, "utf8")) as StudyRecommendations;
  const rec = recs.recommendations.find((r) => r.id === recId);
  if (!rec) throw new Error(`Recommandation inconnue : ${recId} (disponibles : ${recs.recommendations.map((r) => r.id).join(", ")})`);
  if (!rec.nextStudy) throw new Error(`La recommandation « ${recId} » ne propose pas d'étude suivante.`);
  const study = db.select().from(studiesTable).all().find((s) => s.id === recs.studyId)!;
  const project = getProject(db, study.projectId)!;
  const { file: base, path: basePath } = projectFileOf(project);
  const baseId = base.id ?? project.id;
  const newId = `${baseId}-${slugify(recId)}`.slice(0, 60);
  rec.nextStudy.projectPatch = withBaseSocle(rec.nextStudy.projectPatch, baseSocleOf(base, study));
  const merged = applyProjectPatch(base, rec.nextStudy.projectPatch, { id: newId });
  if (!merged.ok) throw new Error(`Patch invalide pour « ${recId} » : ${merged.error}`);
  if (rec.nextStudy.projectPatch.target) {
    const t = checkTargetPatch(merged.file.target);
    if (t.errors.length) throw new Error(`Filtre de cible invalide : ${t.errors.join(" ; ")}`);
  }
  if (getProject(db, newId)) throw new Error(`Le projet « ${newId} » existe déjà : variante déjà créée ?`);
  // Le nom (montré aux personas) ne change pas : seule la différence testée doit varier
  let projectFile: string | undefined;
  if (basePath) {
    const dir = opts.variantsDir ?? join(dirname(resolve(basePath)), "variants");
    mkdirSync(dir, { recursive: true });
    projectFile = join(dir, `${baseId}-${slugify(recId)}.yaml`);
    const header = `# Variante de ${baseId} issue de la recommandation « ${recId} » de l'étude ${recs.studyId} (study:recommend).\n# ${rec.title}\n# Seuls les blocs ${Object.keys(rec.nextStudy.projectPatch).join(", ")} diffèrent du projet de base.\n# Hypothèse : ${rec.nextStudy.hypothesis}\n# Critère de succès : ${rec.nextStudy.successCriterion}\n`;
    writeFileSync(projectFile, header + toYaml(merged.file, { lineWidth: 0 }));
  }
  const created = createProject(db, merged.file, projectFile ? { sourceFile: resolve(projectFile) } : {});
  // Rattachement à la base (études liées, comparaisons)
  db.$client.prepare("update projects set extra = json_set(extra, '$.variantOf', ?, '$.variantRecommendation', ?) where id = ?").run(project.id, `${recs.studyId}:${recId}`, created.id);
  const ns = rec.nextStudy;
  const backend = opts.backend ?? study.backend;
  const model = opts.model ?? study.model;
  const name = `${project.name} — ${rec.title}`.slice(0, 120);
  let res;
  if (ns.sample === "same_sample") {
    res = createStudy(db, pack, {
      projectId: created.id,
      sameSampleAs: study.id,
      // Projet multi-rôles : tout l'échantillon (un groupe par rôle) ; sinon la cible seule
      ...(ns.control || summaryHasRoles(project) ? {} : { sameSampleGroup: "target" }),
      seed: study.seed,
      backend,
      model,
      name,
      // Même version de protocole que l'étude de base : la comparaison reste valable
      protocolVersion: protocolVersionOf(study.protocolVersion),
    });
  } else {
    const target = merged.file.target;
    if (!target) throw new Error("Étude sur une nouvelle cible sans bloc `target`.");
    res = createStudy(db, pack, {
      projectId: created.id,
      seed: study.seed,
      backend,
      model,
      name,
      protocolVersion: protocolVersionOf(study.protocolVersion),
      populations: [
        { group: "target", n: ns.n, target },
        ...(ns.control && merged.file.control ? [{ group: "control", n: ns.control, target: merged.file.control }] : []),
      ],
    });
  }
  return { projectId: created.id, ...(projectFile && { projectFile }), studyId: res.study.id };
}

function summaryHasRoles(project: Project): boolean {
  return Boolean((project.extra as { roles?: unknown[] } | null)?.roles?.length);
}
