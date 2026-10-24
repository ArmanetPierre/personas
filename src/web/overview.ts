import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { moduleLibrary } from "../modules/registry";
import { previewTarget } from "../population/preview";
import { resolveSoclePack, type TargetSpec } from "../population/target";
import type { Db } from "../db/client";
import type { Pack } from "../personas/pack";
import { canonicalShares } from "../studies/compare";
import { getProject, type ProjectExtra } from "../studies/project";
import { LEGACY_PROTOCOL, resolveProtocol } from "../studies/protocols/protocol";
import { listStudies } from "../studies/store";
import { scaleView } from "../studies/summary";
import { responseCount, studySummary } from "./adapters";
import { PRODUCT_TYPE_LABELS } from "./p1-routes";
import { SOCLE_LABELS, SOCLE_VALUE_LABELS } from "./modules";
import { readRecommendations } from "./recommend-routes";
import { DEFAULT_LANG, L, numberLocale, overlay, projectLocale, zoneOf, type Lang } from "./i18n";
import {
  CONFIDENCE_LEVEL_LABELS_EN,
  EXTRA_VALUE_LABELS_EN,
  OBJECTION_LABELS_EN,
  overlayNested,
  PRODUCT_TYPE_LABELS_EN,
  SOCLE_LABELS_EN,
  SOCLE_VALUE_LABELS_EN,
  VAR_LABELS_EN,
} from "./i18n-labels";
import { priceIn, pricingIn } from "./i18n-price";
import { hasGenericPricing, pricingOf } from "../studies/price-model";

/**
 * Vue d'ensemble d'un projet (page Projet, cartes) : cible en langage clair, taille estimée dans la zone du socle,
 * dernier pré-tri, offre, protocole, dernière étude. Lecture seule ; rien n'est écrit.
 */

// ─── Critères de sélection en langage clair ───────────────────────────────────

const VAR_LABELS: Record<string, string> = {
  ...SOCLE_LABELS,
  age: "Âge",
  sex: "Sexe",
  region: "Région",
  town_size: "Taille de la commune",
  pcs: "Catégorie socioprofessionnelle",
  activity_status: "Situation",
  household_type: "Type de ménage",
  household_size: "Taille du ménage",
  monthly_income: "Revenu personnel (€/mois)",
  household_income: "Revenu du ménage (€/mois)",
  budget: "Reste-à-vivre (€/mois)",
  living_standard: "Niveau de vie (€/mois)",
  tech_adoption: "Rapport au numérique",
  social_media: "Usage des réseaux sociaux",
  tenure: "Logement",
  children: "Enfants",
  has_computer: "A un ordinateur",
  has_smartphone: "A un smartphone",
  has_tablet: "A une tablette",
};
const EXTRA_VALUE_LABELS: Record<string, Record<string, string>> = {
  tech_adoption: { innovator: "innovateur", early_adopter: "adopteur précoce", early_majority: "majorité précoce", late_majority: "majorité tardive", laggard: "retardataire" },
  tenure: { owner: "propriétaire", owner_mortgage: "propriétaire avec crédit", renter_private: "locataire (privé)", renter_social: "locataire HLM", free: "logé gratuitement" },
  household_type: { alone: "seul", couple_no_child: "en couple sans enfant", couple_with_children: "en couple avec enfants", single_parent: "parent isolé", with_parents: "chez ses parents", other: "autre" },
  social_media: { none: "aucun", occasional: "occasionnel", daily: "quotidien", heavy: "intensif" },
};

export interface Criterion {
  /** Libellé de la caractéristique (« Réunions par semaine »). */
  label: string;
  /** Valeur en clair (« 5 ou plus », « macOS »). */
  value: string;
  /** Provenance : population de base ou caractéristique ajoutée (module). */
  source: "socle" | "module";
  module?: string;
  /** Variable technique (« productivite-reunions.meetings_per_week »). */
  variable: string;
}

/** Variables propres au socle Singapour (src/personas/countries/sg/vars.ts) : libellés et valeurs en clair. */
const SG_VAR_LABELS: Record<Lang, Record<string, string>> = {
  fr: { residency_status: "Statut de résidence", resident: "Résident (citoyen ou RP)", nationality: "Nationalité", ethnicity: "Origine", religion: "Religion", home_language: "Langue du foyer", education: "Diplôme", dwelling: "Logement", planning_area: "Quartier" },
  en: { residency_status: "Residency status", resident: "Resident (citizen or PR)", nationality: "Nationality", ethnicity: "Ethnicity", religion: "Religion", home_language: "Home language", education: "Education", dwelling: "Dwelling", planning_area: "Planning area" },
};
const SG_VALUE_LABELS: Record<string, Record<string, string>> = {
  residency_status: { citizen: "citizen", pr: "permanent resident", ep: "Employment Pass", spass: "S Pass", wp: "Work Permit", mdw: "migrant domestic worker", dependant: "Dependant's Pass", student: "Student's Pass" },
  dwelling: { hdb_1_2: "HDB 1-2 room", hdb_3: "HDB 3-room", hdb_4: "HDB 4-room", hdb_5_exec: "HDB 5-room or executive", condo: "condo", landed: "landed house", dormitory: "dormitory", other: "other" },
};

const gendered = (l: unknown) => (typeof l === "string" ? l : l && typeof l === "object" ? String((l as { M?: string; F?: string }).M ?? (l as { F?: string }).F ?? "") : "");

/** Libellés des variables du socle : VAR_LABELS (et SOCLE_LABELS dessous), en anglais si demandé. */
function varLabels(lang: Lang): Record<string, string> {
  return lang === "en" ? { ...SG_VAR_LABELS.en, ...VAR_LABELS, ...SOCLE_LABELS_EN, ...VAR_LABELS_EN } : { ...SG_VAR_LABELS.fr, ...VAR_LABELS };
}

function attrInfo(name: string, lang: Lang = DEFAULT_LANG): { label: string; source: "socle" | "module"; module?: string; values: Record<string, string>; yes?: string; no?: string } {
  if (!name.includes(".")) {
    const socleValues = overlayNested(lang, SOCLE_VALUE_LABELS, SOCLE_VALUE_LABELS_EN);
    const extraValues = overlayNested(lang, EXTRA_VALUE_LABELS, EXTRA_VALUE_LABELS_EN);
    return { label: varLabels(lang)[name] ?? name, source: "socle", values: { ...(SG_VALUE_LABELS[name] ?? {}), ...(socleValues[name] ?? {}), ...(extraValues[name] ?? {}) } };
  }
  const mid = name.slice(0, name.lastIndexOf("."));
  const key = name.slice(name.lastIndexOf(".") + 1);
  try {
    const a = moduleLibrary().get(mid)?.attrs.get(key);
    if (a) {
      const values: Record<string, string> = {};
      if (a.type === "enum") for (const v of a.values) values[v.code] = gendered(v.label);
      if (a.type === "set") for (const it of a.items) values[it.code] = it.label;
      return { label: a.label, source: "module", module: mid, values, ...(a.type === "boolean" && a.labels && { yes: a.labels.yes, no: a.labels.no }) };
    }
  } catch {
    // bibliothèque illisible : libellé brut
  }
  return { label: key.replace(/_/g, " "), source: "module", module: mid, values: {} };
}

/**
 * Découpe un filtre en critères (conjonctions de premier niveau) ; ce qui est trop complexe reste brut.
 * `lang` : langue des libellés du socle et des tournures (« ou », « sauf », « de X à Y ans ») ; les libellés
 * des attributs de modules viennent du YAML des modules et restent dans leur langue.
 */
export function plainCriteria(expression: string | null | undefined, regionName?: (code: string) => string, lang: Lang = DEFAULT_LANG): { criteria: Criterion[]; raw: string[] } {
  if (!expression?.trim()) return { criteria: [], raw: [] };
  const parts = splitTopLevelAnd(expression);
  const criteria: Criterion[] = [];
  const raw: string[] = [];
  const bounds = new Map<string, { min?: number; max?: number }>();
  const info0 = (name: string) => attrInfo(name, lang);
  const t = {
    or: L(lang, "ou", "or"),
    except: L(lang, "sauf", "except"),
    yes: L(lang, "oui", "yes"),
    no: L(lang, "non", "no"),
    years: L(lang, " ans", ""),
  };
  const fmt = (x: number) => x.toLocaleString(numberLocale(lang), { maximumFractionDigits: 2 });
  const attrInfoR = (name: string) => {
    const i = info0(name);
    if (name === "region" && regionName) return { ...i, values: new Proxy(i.values, { get: (_t, k) => (typeof k === "string" ? safeRegion(regionName, k) : undefined) }) };
    return i;
  };
  for (const part of parts) {
    const x = part.trim().replace(/^\((.*)\)$/s, "$1").trim();
    let m: RegExpMatchArray | null;
    if ((m = x.match(/^([A-Za-z_][\w.-]*)\s+(not\s+)?in\s*\[(.*)\]$/s))) {
      const info = attrInfoR(m[1]!);
      const vals = m[3]!.split(",").map((v) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean).map((v) => info.values[v] ?? v.replace(/_/g, " "));
      const list = vals.length > 1 ? `${vals.slice(0, -1).join(", ")} ${t.or} ${vals.at(-1)}` : vals[0] ?? "";
      criteria.push({ label: info.label, value: m[2] ? `${t.except} ${list}` : list, source: info.source, ...(info.module && { module: info.module }), variable: m[1]! });
    } else if ((m = x.match(/^([A-Za-z_][\w.-]*)\s*(==|=|!=|>=|<=|>|<)\s*(.+)$/s))) {
      const [, name, op, v0] = m as unknown as [string, string, string, string];
      const info = attrInfoR(name);
      const v = v0.trim().replace(/^["']|["']$/g, "");
      const num = Number(v);
      if (op === ">=" || op === ">" || op === "<=" || op === "<") {
        if (!Number.isFinite(num)) {
          raw.push(x);
          continue;
        }
        const b = bounds.get(name) ?? {};
        if (op === ">=") b.min = num;
        if (op === ">") b.min = num + (Number.isInteger(num) ? 1 : 0.0001);
        if (op === "<=") b.max = num;
        if (op === "<") b.max = num - (Number.isInteger(num) ? 1 : 0.0001);
        bounds.set(name, b);
        continue;
      }
      const label = v === "true" ? info.yes ?? t.yes : v === "false" ? info.no ?? t.no : info.values[v] ?? v.replace(/_/g, " ");
      criteria.push({ label: info.label, value: op === "!=" ? `${t.except} ${label}` : label, source: info.source, ...(info.module && { module: info.module }), variable: name });
    } else if ((m = x.match(/^(not\s+)?([A-Za-z_][\w.-]*)$/))) {
      const info = attrInfoR(m[2]!);
      // Booléen : son libellé « oui » se lit seul (« travaille dans le numérique »)
      const yes = info.yes ?? null;
      criteria.push({ label: m[1] ? info.no ?? L(lang, `${info.label} : non`, `${info.label}: no`) : yes ?? info.label, value: m[1] || yes ? "" : t.yes, source: info.source, ...(info.module && { module: info.module }), variable: m[2]! });
    } else raw.push(x);
  }
  for (const [name, b] of bounds) {
    const info = attrInfo(name, lang);
    const unit = name === "age" ? t.years : "";
    const value =
      lang === "en"
        ? b.min !== undefined && b.max !== undefined
          ? `${fmt(b.min)} to ${fmt(b.max)}`
          : b.min !== undefined
            ? `${fmt(b.min)} or more`
            : `${fmt(b.max!)} at most`
        : b.min !== undefined && b.max !== undefined
          ? `de ${fmt(b.min)} à ${fmt(b.max)}${unit}`
          : b.min !== undefined
            ? `${fmt(b.min)}${unit} ou plus`
            : `${fmt(b.max!)}${unit} au plus`;
    criteria.push({ label: info.label, value, source: info.source, ...(info.module && { module: info.module }), variable: name });
  }
  // Ordre : population de base d'abord, puis les caractéristiques ajoutées
  criteria.sort((a, b) => (a.source === b.source ? 0 : a.source === "socle" ? -1 : 1));
  return { criteria, raw };
}

function safeRegion(regionName: (code: string) => string, code: string): string {
  try {
    return regionName(code);
  } catch {
    return code;
  }
}

function splitTopLevelAnd(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  const words = src.split(/(\s+|\(|\)|\[|\])/);
  for (const w of words) {
    if (w === "(" || w === "[") depth++;
    if (w === ")" || w === "]") depth--;
    if (depth === 0 && /^and$/i.test(w.trim()) && w.trim()) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += w;
  }
  if (cur.trim()) out.push(cur);
  // Un « or » de premier niveau rend la décomposition trompeuse : tout reste brut
  if (out.some((p) => /\bor\b/i.test(p) && !/^\s*\(.*\)\s*$/s.test(p))) return [src];
  return out;
}

// ─── Taille de la population ──────────────────────────────────────────────────

function adultPopulation(socle: string, lang: Lang = DEFAULT_LANG): { total: number; label: string } | null {
  try {
    const pack: Pack = resolveSoclePack(socle);
    const bands = pack.ageSex.data.bands;
    // Libellé de population : donnée du manifeste du socle (dans la langue du socle)
    return { total: bands.reduce((a, b) => a + b.M + b.F, 0), label: (pack.manifest as { population?: string }).population ?? L(lang, "adultes", "adults") };
  } catch {
    return null;
  }
}

/** Éligibilité estimée par un petit tirage virtuel (sans LLM), gardée en mémoire par projet et version. */
const eligCache = new Map<string, { rate: number; ci: [number, number]; draws: number; rare: boolean }>();
async function eligibility(project: ReturnType<typeof getProject> & object, group: string, spec: TargetSpec) {
  const key = `${project.id}:${project.updatedAt}:${group}`;
  const hit = eligCache.get(key);
  if (hit) return hit;
  if (!spec.eligibility) return { rate: 1, ci: [1, 1] as [number, number], draws: 0, rare: false };
  const p = await previewTarget(project, { group, n: 120, sample: 0, seed: 42 });
  const v = { rate: p.eligibility.rate, ci: p.eligibility.ci, draws: p.eligibility.draws, rare: p.eligibility.rare };
  eligCache.set(key, v);
  return v;
}

// ─── Vue d'ensemble ───────────────────────────────────────────────────────────

export async function projectOverview(db: Db, pack: Pack, dataDir: string, projectId: string, lang: Lang = DEFAULT_LANG) {
  const p = getProject(db, projectId);
  if (!p) throw new Error(`Projet introuvable : ${projectId}`);
  const extra = p.extra as ProjectExtra;

  const describe = async (group: "target" | "control", spec: TargetSpec | undefined) => {
    if (!spec) return null;
    let regionName: ((c: string) => string) | undefined;
    let country: string | null = null;
    try {
      const sp = resolveSoclePack(spec.socle);
      regionName = (c: string) => sp.regionName(c);
      country = sp.manifest.country;
    } catch {
      regionName = undefined;
    }
    const plain = plainCriteria(spec.eligibility, regionName, lang);
    const pop = adultPopulation(spec.socle, lang);
    let elig: Awaited<ReturnType<typeof eligibility>> | null = null;
    let error: string | null = null;
    try {
      elig = await eligibility(p, group, spec);
    } catch (err) {
      error = (err as Error).message;
    }
    return {
      socle: spec.socle,
      socleLabel: pop?.label ?? spec.socle,
      /** Nom de la zone du socle (pays du manifeste), dans la langue de l'interface. */
      zone: zoneOf(country, lang),
      modules: spec.modules.map((id) => {
        try {
          return { id, label: moduleLibrary().get(id)?.def.label ?? id };
        } catch {
          return { id, label: id };
        }
      }),
      criteria: plain.criteria,
      rawCriteria: plain.raw,
      expression: spec.eligibility ?? null,
      quotas: spec.quotas ?? null,
      n: spec.n ?? null,
      adults: pop?.total ?? null,
      eligibility: elig,
      estimatedPeople: elig && pop ? Math.round((elig.rate * pop.total) / 1000) * 1000 : null,
      error,
    };
  };

  // Dernier pré-tri en cache (lecture seule, fichier le plus récent pour la cible)
  let triage: { share: number; ci: [number, number]; alert: boolean; alertShare: number; seed: number; generatedAt: string } | null = null;
  const dir = join(dataDir, "previews");
  if (existsSync(dir)) {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${projectId}-target-s`) && f.endsWith("-triage.json"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f, t } of files) {
      try {
        const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as { seed?: number; triage?: { share: number; ci: [number, number]; alert: boolean; alertShare: number } };
        if (r.triage) {
          triage = { share: r.triage.share, ci: r.triage.ci, alert: r.triage.alert, alertShare: r.triage.alertShare, seed: r.seed ?? 42, generatedAt: new Date(t).toISOString() };
          break;
        }
      } catch {
        // fichier en cours d'écriture : ignoré
      }
    }
  }

  // Protocole et proposition en attente
  const proto = resolveProtocol(p);
  let proposal: { generatedAt: string | null } | null = null;
  const propFile = join(dataDir, "proposals", `${projectId}-protocol.json`);
  if (existsSync(propFile)) {
    try {
      const j = JSON.parse(readFileSync(propFile, "utf8")) as { protocol?: unknown; generatedAt?: string };
      const applied = JSON.stringify(j.protocol) === JSON.stringify(extra.protocol ?? null);
      if (!applied) proposal = { generatedAt: j.generatedAt ?? null };
    } catch {
      proposal = null;
    }
  }

  // Études : dernière étude avec des réponses, et son verdict
  const studies = listStudies(db).filter((s) => s.projectId === p.id);
  const withResponses = studies.map((s) => ({ s, k: responseCount(db, s.id) })).filter((x) => x.k > 0);
  const last = withResponses[0] ?? null;
  let lastStudy = null;
  if (last) {
    const sum = studySummary(db, pack, last.s, p);
    const g = sum?.groups.find((x) => x.group === "target");
    const a = g?.analysis ?? sum?.overall;
    if (sum && a) {
      const proto2 = sum.protocol ?? LEGACY_PROTOCOL;
      const levels = canonicalShares(a, proto2).levels;
      const view = scaleView(sum.protocol ?? undefined);
      const objs = Object.entries(a.objections.overall.shares).sort((x, y) => y[1] - x[1]);
      const top = objs[0];
      lastStudy = {
        id: last.s.id,
        name: last.s.name,
        status: last.s.status,
        createdAt: last.s.createdAt,
        responses: last.k,
        total: last.s.personaIds.length,
        n: a.n,
        interest: 1 - (levels.inaction ?? 0),
        freeTrialOrMore: a.behaviors.freeSignupOrMore,
        payers: a.behaviors.payers,
        /** v3 : paiement en double mesure (M1, G, M2) et indice de confiance ; M1 ne s'affiche jamais seul. */
        payment: a.payment ?? null,
        confidence: sum.confidence
          ? { level: sum.confidence.level, label: lang === "en" ? CONFIDENCE_LEVEL_LABELS_EN[sum.confidence.level] ?? sum.confidence.label : sum.confidence.label, score: sum.confidence.score }
          : null,
        protocolVersion: sum.protocolVersion ?? "2",
        notConcerned: a.relevance.notConcernedShare,
        price: lang !== "en" ? sum.project.price : hasGenericPricing(p) && pricingOf(p) ? pricingIn(lang, pricingOf(p)!) : p.priceEur ? priceIn(lang, p.priceEur, p.pricePeriod) : sum.project.price,
        // Protocole historique : libellé traduit par code ; protocole propre au projet : ses libellés (données du projet)
        topObjection: top ? { label: (lang === "en" && !sum.protocol ? OBJECTION_LABELS_EN[top[0]] : undefined) ?? view.objections.find((o) => o.code === top[0])?.label ?? top[0], share: top[1] } : null,
        custom: Boolean(sum.protocol),
        recommendation: (() => {
          const r = readRecommendations(dataDir, last.s.id);
          const top = r?.recommendations[0];
          return r ? { headline: r.headline, top: top ? { title: top.title, confidence: top.confidence } : null } : null;
        })(),
      };
    }
  }

  return {
    project: { id: p.id, name: p.name, pitch: p.pitch, updatedAt: p.updatedAt, sourceFile: extra.sourceFile ?? null, locale: projectLocale(p) },
    target: await describe("target", extra.target),
    control: await describe("control", extra.control),
    triage,
    protocol: {
      custom: proto.custom,
      productType: proto.productType ?? null,
      productTypeLabel: proto.productType ? overlay(lang, PRODUCT_TYPE_LABELS, PRODUCT_TYPE_LABELS_EN)[proto.productType] ?? proto.productType : null,
      behaviors: proto.behaviors.length,
      objections: proto.objections.length,
      proposal,
    },
    studies: {
      count: studies.length,
      withResponses: withResponses.length,
      running: studies.filter((s) => s.status === "running").length,
      lastAt: studies[0]?.createdAt ?? null,
    },
    lastStudy,
  };
}
