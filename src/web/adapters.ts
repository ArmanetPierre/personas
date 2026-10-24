import { studyEngineInfo } from "../engine/select";
import { count, desc, eq, max } from "drizzle-orm";
import { toneWarning } from "../studies/pitch-tone";
import type { Db } from "../db/client";
import { personas, responses, studies, type Persona, type Project, type ResponseRow, type Study } from "../db/schema";
import { describeForPrompt } from "../personas/describe";
import type { Pack } from "../personas/pack";
import { packManifest, packResolver } from "../studies/packs";
import { hasGenericPricing, pricingOf, referenceOffer } from "../studies/price-model";
import { PERIOD_LABELS, priceTiersFor } from "../studies/project";
import { behaviorLabelsFor, QUESTION_KEY } from "../studies/protocols/concept-price";
import type { ConceptPricePayload } from "../studies/run";
import { DIMENSION_LABELS, EXTRA_DIMENSIONS, MODULE_SEGMENTS, segmentLabel, segmentOf, SUMMARY_DIMENSIONS, type SegmentDimension } from "../studies/segments";

/** Segments des modules archivés : gardés pour l'historique, exclus des facettes. */
const LEGACY_DIMENSIONS = new Set(MODULE_SEGMENTS.filter((s) => s.legacy).map((s) => s.id));
import { personasByIds, repeatStudies, studyResponses } from "../studies/store";
import { summarize, type StudySummary } from "../studies/summary";
import { DEFAULT_LANG, overlay, projectLocale, type Lang } from "./i18n";
import { ACTIVITY_LABELS_EN, DIMENSION_LABELS_EN, PCS_SHORT_EN, ROGERS_LABELS_EN, behaviorLabelsForEn } from "./i18n-labels";
import { priceIn, pricingIn, tierIn, unitLabelIn, unitWordIn } from "./i18n-price";

/**
 * Adaptateurs en lecture entre les modules d'étude et l'API web.
 * Tolérants aux champs absents : les données évoluent (variantes d'offre, unité de prix…).
 */

// ─── Prix et unité ────────────────────────────────────────────────────────────

/** Unité de prix lisible (« mois », « mise en relation »…), repli sur la période, puis sur « mois ». */
export function priceUnit(project: Partial<Project> & Record<string, unknown>, lang: Lang = DEFAULT_LANG): string {
  // Modèle de prix générique : unité de l'offre de référence (« kg », « achat unique », « mois »)
  const generic = genericPricing(project);
  if (generic) return unitLabelIn(lang, referenceOffer(generic));
  return unitWordIn(lang, legacyUnit(project));
}

/**
 * Identifiant de l'unité de prix, indépendant de la langue : unité de l'offre de référence (`month`, `year`,
 * `one_time`, `usage`, `quantity`) ; projet historique : `month` si le prix est mensuel, sinon `once` ou `custom`.
 */
export function priceUnitId(project: Partial<Project> & Record<string, unknown>): string {
  const generic = genericPricing(project);
  if (generic) return referenceOffer(generic).unit;
  const unit = legacyUnit(project);
  if (unit === PERIOD_LABELS.month) return "month";
  if (unit === "achat") return "once";
  return "custom";
}

function legacyUnit(project: Partial<Project> & Record<string, unknown>): string {
  const extra = (project.extra ?? {}) as Record<string, unknown>;
  const candidates = [project["priceUnitLabel"], project["priceUnit"], extra["priceUnitLabel"], extra["priceUnit"], extra["unitLabel"], extra["unit"]];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return PERIOD_LABELS[c.trim()] ?? c.trim().replace(/_/g, " ");
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const l = o["label"] ?? o["labelFr"] ?? o["name"] ?? o["id"];
      if (typeof l === "string" && l.trim()) return PERIOD_LABELS[l.trim()] ?? l.trim().replace(/_/g, " ");
    }
  }
  const period = typeof project.pricePeriod === "string" ? project.pricePeriod : "month";
  return period === "once" ? "achat" : PERIOD_LABELS[period] ?? "mois";
}

/** Modèle de prix générique d'un projet, s'il en a un. */
function genericPricing(project: Partial<Project>) {
  if (!project.extra || !hasGenericPricing(project as Project)) return null;
  return pricingOf(project as Project);
}

export function priceLabel(project: Project, lang: Lang = DEFAULT_LANG): string {
  const generic = genericPricing(project);
  if (generic) return pricingIn(lang, generic);
  if (!project.priceEur) return "—";
  const unit = priceUnit(project as Project & Record<string, unknown>);
  const fromPeriod = priceIn(lang, project.priceEur, project.pricePeriod);
  // Unité propre (« par mise en relation ») : on l'affiche telle quelle
  if (unit !== (PERIOD_LABELS[project.pricePeriod ?? "month"] ?? "mois") && unit !== "achat") {
    return lang === "en"
      ? `€${project.priceEur.toLocaleString("en-GB", { maximumFractionDigits: 2 })}/${unitWordIn(lang, unit)}`
      : `${project.priceEur.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €/${unit}`;
  }
  return fromPeriod;
}

// ─── Projets ──────────────────────────────────────────────────────────────────

export interface ProjectListItem {
  id: string;
  name: string;
  pitch: string;
  price: string;
  priceEur: number | null;
  unit: string;
  studyCount: number;
  lastStudy: { id: string; name: string; status: string; createdAt: string } | null;
  createdAt: string;
}

export function projectListItem(db: Db, p: Project, lang: Lang = DEFAULT_LANG): ProjectListItem {
  const [c] = db.select({ n: count() }).from(studies).where(eq(studies.projectId, p.id)).all();
  const last = db.select().from(studies).where(eq(studies.projectId, p.id)).orderBy(desc(studies.createdAt)).limit(1).get();
  return {
    id: p.id,
    name: p.name,
    pitch: p.pitch,
    price: priceLabel(p, lang),
    priceEur: p.priceEur,
    unit: priceUnit(p as Project & Record<string, unknown>, lang),
    studyCount: c?.n ?? 0,
    lastStudy: last ? { id: last.id, name: last.name, status: last.status, createdAt: last.createdAt } : null,
    createdAt: p.createdAt,
  };
}

export function projectDetail(p: Project, lang: Lang = DEFAULT_LANG) {
  const generic = genericPricing(p);
  return {
    ...p,
    price: priceLabel(p, lang),
    unit: priceUnit(p as Project & Record<string, unknown>, lang),
    /** Identifiant de l'unité (`month`, `quantity`…), pour les tests de l'interface (le libellé dépend de la langue). */
    unitId: priceUnitId(p as Project & Record<string, unknown>),
    priceTiers: priceTiersFor(p),
    /** Devise des prix et des paliers (EUR pour un projet historique). */
    currency: generic?.currency ?? "EUR",
    /** Prix de l'offre de référence, dans laquelle sont posées les questions de prix. */
    referencePrice: generic ? tierIn(lang, generic, referenceOffer(generic).amount) : priceLabel(p, lang),
    ...(generic && { pricing: generic }),
    // Libellés des comportements selon le type de prix (achat, commande, usage), hors abonnement
    ...(generic && !["month", "year"].includes(referenceOffer(generic).unit) && { behaviorLabels: lang === "en" ? behaviorLabelsForEn(referenceOffer(generic).unit) : behaviorLabelsFor(referenceOffer(generic).unit) }),
    /** Ton du pitch (score lexical, 0 factuel → 100 survendu) et garde-fou de création d'étude. */
    pitchTone: pitchToneOf(p),
    /** Langue du contenu (socle de la cible, ou `extra.locale`) : l'interface peut s'y aligner. */
    locale: projectLocale(p),
  };
}

export function pitchToneOf(p: Project) {
  const w = toneWarning(p.pitch);
  const extra = (p.extra ?? {}) as { pitchOriginal?: string; pitchNeutralized?: boolean };
  return { score: w.score, threshold: w.threshold, warn: w.warn, neutralized: extra.pitchNeutralized === true, hasOriginal: Boolean(extra.pitchOriginal) };
}

// ─── Études ───────────────────────────────────────────────────────────────────

export function responseCount(db: Db, studyId: string): number {
  const [row] = db.select({ n: count(), last: max(responses.createdAt) }).from(responses).where(eq(responses.studyId, studyId)).all();
  return row?.n ?? 0;
}

export function lastResponseAt(db: Db, studyId: string): string | null {
  const [row] = db.select({ last: max(responses.createdAt) }).from(responses).where(eq(responses.studyId, studyId)).all();
  return row?.last ?? null;
}

export function studyListItem(db: Db, s: Study) {
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    status: s.status,
    backend: s.backend,
    model: s.model,
    seed: s.seed,
    sampleSize: s.sampleSize,
    populations: s.populations ?? [],
    responses: responseCount(db, s.id),
    sampleFromStudyId: s.sampleFromStudyId,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
    extra: pickStudyExtras(s),
    engine: studyEngineInfo(s),
  };
}

/** Champs ajoutés plus tard à l'étude (variante d'offre…) : renvoyés tels quels s'ils existent. */
function pickStudyExtras(s: Study): Record<string, unknown> {
  const known = new Set([
    "id", "projectId", "name", "protocol", "protocolVersion", "status", "backend", "model", "seed", "sampleSize", "quotas",
    "personaIds", "sampleFromStudyId", "populations", "personaGroups", "progressDone", "progressTotal", "error",
    "startedAt", "completedAt", "createdAt", "updatedAt", "extra",
  ]);
  return Object.fromEntries(Object.entries(s).filter(([k, v]) => !known.has(k) && v !== null && v !== undefined));
}

export function studySummary(db: Db, pack: Pack, study: Study, project: Project): StudySummary | null {
  const rows = studyResponses(db, study.id, QUESTION_KEY);
  if (!rows.length) return null;
  const ps = new Map(personasByIds(db, [...new Set(rows.map((r) => r.personaId))]).map((p) => [p.id, p]));
  // Passes répétées (indice de confiance) : autres études terminées du même projet, même protocole et version
  return summarize(pack, study, project, rows, ps, undefined, { repeats: repeatStudies(db, study) });
}

// ─── Réponses (verbatims filtrables) ──────────────────────────────────────────

export interface SegmentValue {
  code: string;
  label: string;
}

const resolvers = new WeakMap<Pack, ReturnType<typeof packResolver>>();
/** Résolveur de pack mis en cache (un chargement de pack par version et par processus). */
export function resolverFor(pack: Pack): ReturnType<typeof packResolver> {
  let r = resolvers.get(pack);
  if (!r) resolvers.set(pack, (r = packResolver(pack)));
  return r;
}

/**
 * Libellé d'un segment du socle en anglais (âge, sexe, PCS, adoption, activité) ; le reste (niveau de vie,
 * agglomération, région : données du pack ; modules : YAML) garde le libellé de segmentLabel (src/studies/segments.ts).
 */
export function segmentLabelIn(lang: Lang, pk: Pack, dim: SegmentDimension, code: string, p?: Persona): string {
  if (lang === "en") {
    if (dim === "ageBand") return code === "60-79" ? "60 and over" : `${code}`;
    if (dim === "sex") return code === "F" ? "Women" : "Men";
    if (dim === "pcs" && PCS_SHORT_EN[code]) return PCS_SHORT_EN[code]!;
    if (dim === "techAdoption" && ROGERS_LABELS_EN[code]) return ROGERS_LABELS_EN[code]!;
    if (dim === "activityStatus" && ACTIVITY_LABELS_EN[code]) return ACTIVITY_LABELS_EN[code]!;
  }
  return segmentLabel(pk, dim, code, p);
}

export function personaSegments(pack: Pack, p: Persona, lang: Lang = DEFAULT_LANG): Record<string, SegmentValue> {
  const pk = resolverFor(pack)(p);
  const out: Record<string, SegmentValue> = {};
  for (const dim of [...EXTRA_DIMENSIONS, ...SUMMARY_DIMENSIONS] as SegmentDimension[]) {
    try {
      const code = segmentOf(pk, p, dim);
      if (code === "?") continue;
      out[dim] = { code, label: segmentLabelIn(lang, pk, dim, code, p) };
    } catch {
      // dimension non calculable pour ce pack
    }
  }
  return out;
}

const who = (p: Persona, lang: Lang = DEFAULT_LANG) => (lang === "en" ? `${p.firstName ?? "?"}, ${p.age}` : `${p.firstName ?? "?"}, ${p.age} ans`);

export function responseRows(db: Db, pack: Pack, study: Study, lang: Lang = DEFAULT_LANG) {
  const rows = studyResponses(db, study.id, QUESTION_KEY);
  const ps = new Map(personasByIds(db, [...new Set(rows.map((r) => r.personaId))]).map((p) => [p.id, p]));
  return rows.map((r) => {
    const p = ps.get(r.personaId)!;
    const payload = r.payload as Partial<ConceptPricePayload>;
    const a = (payload.answer ?? {}) as Partial<ConceptPricePayload["answer"]>;
    return {
      personaId: r.personaId,
      who: who(p, lang),
      occupation: p.occupation,
      group: study.personaGroups?.[r.personaId] ?? payload.group ?? "target",
      behavior: a.behavior ?? null,
      relevance: a.relevance ?? null,
      objections: (a.objections ?? []).map((o) => ({ category: o.category, detail: o.detail })),
      verbatim: a.verbatim ?? "",
      reaction: a.spontaneousReaction ?? "",
      wouldForward: a.wouldForward ?? null,
      neverPay: a.vanWestendorp?.wouldNeverPay ?? null,
      anomalies: r.anomalies ?? [],
      repaired: r.repaired,
      segments: personaSegments(pack, p, lang),
    };
  });
}

export function responseDetail(db: Db, pack: Pack, study: Study, personaId: string, lang: Lang = DEFAULT_LANG) {
  const r = studyResponses(db, study.id, QUESTION_KEY).find((x) => x.personaId === personaId);
  if (!r) return null;
  const p = db.select().from(personas).where(eq(personas.id, personaId)).get();
  if (!p) return null;
  return {
    response: responseView(r),
    group: study.personaGroups?.[personaId] ?? (r.payload as Partial<ConceptPricePayload>).group ?? "target",
    persona: personaCard(pack, p, lang),
  };
}

function responseView(r: ResponseRow) {
  const { rawText: _raw, ...rest } = r;
  return rest;
}

// ─── Personas ─────────────────────────────────────────────────────────────────

export function personaCard(pack: Pack, p: Persona, lang: Lang = DEFAULT_LANG) {
  const pk = resolverFor(pack)(p);
  let facts: Array<{ label: string; value: string }> = [];
  try {
    facts = describeForPrompt(pk, p)
      .split("\n")
      .map((line) => {
        const i = line.indexOf(" : ");
        return i === -1 ? { label: "", value: line } : { label: line.slice(0, i), value: line.slice(i + 3) };
      });
  } catch (err) {
    facts = [lang === "en" ? { label: "Profile", value: `unavailable (${(err as Error).message})` } : { label: "Fiche", value: `indisponible (${(err as Error).message})` }];
  }
  return {
    id: p.id,
    packVersion: p.packVersion,
    seed: p.seed,
    firstName: p.firstName,
    age: p.age,
    sex: p.sex,
    occupation: p.occupation,
    monthlyIncomeEur: p.monthlyIncomeEur,
    monthlyDiscretionaryBudgetEur: p.monthlyDiscretionaryBudgetEur,
    priceSensitivity: p.priceSensitivity,
    skepticism: p.skepticism,
    /** Profil d'adoption technologique (code du socle), pour la jauge de la fiche. */
    techAdoption: p.techAdoption,
    narrative: p.narrative,
    narrativeBackend: p.narrativeBackend,
    narrativeModel: p.narrativeModel,
    subscriptions: p.subscriptions,
    facts,
    segments: personaSegments(pack, p, lang),
  };
}

export interface PersonaFilter {
  pack?: string;
  ageMin?: number;
  ageMax?: number;
  q?: string;
  narrative?: "with" | "without";
  /** Filtres de segment : dimension → code. */
  segments?: Record<string, string>;
  page?: number;
  pageSize?: number;
}

/** Table paginée des personas. La base fait ~1 300 lignes : filtrage en mémoire. */
export function listPersonas(db: Db, pack: Pack, f: PersonaFilter, lang: Lang = DEFAULT_LANG) {
  const all = db.select().from(personas).all();
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 5), 100);
  const q = f.q?.trim().toLowerCase();
  const filtered: Array<{ p: Persona; seg: Record<string, SegmentValue> }> = [];
  const facets: Record<string, Map<string, { label: string; n: number }>> = {};
  for (const p of all) {
    if (f.pack && p.packVersion !== f.pack) continue;
    if (f.ageMin !== undefined && p.age < f.ageMin) continue;
    if (f.ageMax !== undefined && p.age > f.ageMax) continue;
    if (f.narrative === "with" && !p.narrative) continue;
    if (f.narrative === "without" && p.narrative) continue;
    if (q && !`${p.id} ${p.firstName ?? ""} ${p.occupation} ${p.narrative ?? ""}`.toLowerCase().includes(q)) continue;
    const seg = personaSegments(pack, p, lang);
    // Facettes calculées avant les filtres de segment, pour proposer les valeurs disponibles
    for (const [dim, v] of Object.entries(seg)) {
      if (LEGACY_DIMENSIONS.has(dim)) continue; // module archivé : pas de facette (doublon des modules actifs)
      const m = (facets[dim] ??= new Map());
      const e = m.get(v.code);
      if (e) e.n++;
      else m.set(v.code, { label: v.label, n: 1 });
    }
    if (f.segments && Object.entries(f.segments).some(([dim, code]) => seg[dim]?.code !== code)) continue;
    filtered.push({ p, seg });
  }
  filtered.sort((a, b) => a.p.packVersion.localeCompare(b.p.packVersion) || (a.p.drawIndex ?? 0) - (b.p.drawIndex ?? 0));
  const page = Math.max(1, f.page ?? 1);
  const items = filtered.slice((page - 1) * pageSize, page * pageSize).map(({ p, seg }) => ({
    id: p.id,
    packVersion: p.packVersion,
    firstName: p.firstName,
    age: p.age,
    sex: p.sex,
    occupation: p.occupation,
    monthlyDiscretionaryBudgetEur: p.monthlyDiscretionaryBudgetEur,
    hasNarrative: Boolean(p.narrative),
    segments: seg,
  }));
  return {
    total: filtered.length,
    page,
    pageSize,
    items,
    facets: Object.fromEntries(
      Object.entries(facets).map(([dim, m]) => [dim, [...m.entries()].map(([code, v]) => ({ code, ...v })).sort((a, b) => a.label.localeCompare(b.label, lang))]),
    ),
    dimensionLabels: overlay(lang, DIMENSION_LABELS, DIMENSION_LABELS_EN),
  };
}

export function packList(db: Db) {
  return db
    .select({ packVersion: personas.packVersion, n: count() })
    .from(personas)
    .groupBy(personas.packVersion)
    .all()
    .map((r) => {
      const m = packManifest(r.packVersion);
      return {
        ...r,
        label: m?.label ?? r.packVersion,
        ...(m?.shortLabel && { shortLabel: m.shortLabel }),
        ...(m?.memberLabel && { memberLabel: m.memberLabel }),
        targeted: m?.targeted ?? false,
        modules: m?.modules ?? [],
      };
    });
}
