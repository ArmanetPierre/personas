import { useCallback, useEffect, useRef, useState } from "react";
import type { Comparison } from "../../src/studies/compare";
import type { Fx, Pricing } from "../../src/studies/price-model";
import type { Analysis, StudySummary } from "../../src/studies/summary";
import { DEFAULT_LOCALE, getLocale, tr } from "./i18n";
import { commonDict } from "./i18n/common";

export type { Analysis, Comparison, Pricing, StudySummary };

/** Types des réponses de l'API (src/web/app.ts). */

export interface Meta {
  behaviors: Array<{ id: string; label: string; short?: string }>;
  objections: Array<{ id: string; label: string; short?: string }>;
  relevance: Array<{ id: string; label: string }>;
  /** Dimensions du socle, puis des modules (`module` : module source ; `compare` : rang dans les comparaisons). */
  dimensions: Array<{ id: string; label: string; module?: string; compare?: number }>;
  checks: Record<string, string>;
  groups: Record<string, string>;
  encounters: Record<string, string>;
  periods: Array<{ id: string; label: string }>;
  /** Unités du modèle de prix générique, et devises proposées (avec un taux indicatif). */
  priceUnits?: Array<{ id: string; label: string }>;
  currencies?: Array<{ id: string; fx?: Fx }>;
  backends: Array<{ id: string; label: string; defaultModel: string }>;
  methodNote: string;
  smallSegment: number;
  /** Socles déclarés (packs/socles.json). */
  socles?: Array<{ id: string; pack: string }>;
  packs: PackInfo[];
}

export interface PackInfo {
  packVersion: string;
  n: number;
  label: string;
  shortLabel?: string;
  memberLabel?: { one: string; many: string };
  targeted: boolean;
  modules: string[];
}

/** Packs connus (renseignés au chargement de /meta), pour les libellés courts. */
export const packInfos = new Map<string, PackInfo>();

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

export interface ProjectDetail {
  id: string;
  name: string;
  pitch: string;
  targetAudience: string | null;
  businessModel: string | null;
  priceEur: number | null;
  pricePeriod: string | null;
  freeOffer: string | null;
  competitors: string[];
  alternatives: string[];
  extra: Record<string, unknown>;
  price: string;
  unit: string;
  /** Identifiant de l'unité, indépendant de la langue : `month`, `year`, `one_time`, `usage`, `quantity` ; historique : `month`, `once`, `custom`. */
  unitId: string;
  priceTiers: number[];
  /** Devise des prix et des paliers (EUR pour un projet historique). */
  currency?: string;
  /** Prix de l'offre de référence (« 24 SGD le kg »). */
  referencePrice?: string;
  pricing?: Pricing;
  /** Libellés des comportements adaptés au type de prix (achat, commande, usage). */
  behaviorLabels?: Record<string, string>;
  /** Ton du pitch : score lexical (0 factuel → 100 survendu), seuil du garde-fou. */
  pitchTone?: { score: number; threshold: number; warn: boolean; neutralized: boolean; hasOriginal: boolean };
  /** Langue du contenu (socle de la cible) : `useContentLocale(project.locale)`. */
  locale?: "fr" | "en";
  createdAt: string;
}

export type ToneCategory = "superlative" | "unverifiable_promise" | "social_proof" | "urgency" | "price_judgment" | "injunction" | "emotional";
export interface FactView {
  ok: boolean;
  numbersMissing: string[];
  numbersAdded: string[];
  namesMissing: string[];
  factsMissing: string[];
  numbersKept: string[];
  namesKept: string[];
  factsKept: string[];
  repaired?: boolean;
}
export interface PitchProposalView {
  project: string;
  generatedAt: string;
  model: string;
  original: string;
  neutral: string;
  passages: Array<{ text: string; category: ToneCategory; reason: string; replacement: string }>;
  toneScore: { before: number; after: number };
  lexicalScore: { before: number; after: number };
  facts: Array<{ fact: string; keyTerms: string[] }>;
  factView: FactView;
  missingInfo: string[];
  unchanged: boolean;
  stale: boolean;
  file: string;
}
export interface PitchState {
  pitch: string;
  pitchOriginal: string | null;
  pitchNeutralized: boolean;
  tone: { score: number; hits: Array<{ category: ToneCategory; text: string }>; words: number; threshold: number; warn: boolean };
  categories: Array<{ id: ToneCategory; label: string }>;
  proposal: PitchProposalView | null;
  job: JobStateLike | null;
}
interface JobStateLike {
  key: string;
  pid: number | null;
  alive: boolean;
  startedAt: string | null;
  log: string;
}

export interface Population {
  group: string;
  packVersion: string;
  n: number;
  quotas?: Record<string, Record<string, number>>;
  /** Ciblage (phase 2a) : modules appliqués, filtre et taux d'éligibilité de la population. */
  eligibility?: { socle: string; modules: string[]; expression: string | null; draws: number; eligible: number; rate: number; ci: [number, number]; rare: boolean };
}

export interface StudyListItem {
  id: string;
  projectId: string;
  name: string;
  status: string;
  backend: string;
  model: string;
  seed: number;
  sampleSize: number;
  populations: Population[];
  responses: number;
  sampleFromStudyId: string | null;
  createdAt: string;
  completedAt: string | null;
  extra: Record<string, unknown>;
}

export interface StudyState {
  id: string;
  projectId: string;
  name: string;
  status: string;
  displayStatus: string;
  backend: string;
  model: string;
  seed: number;
  protocol: string;
  protocolVersion: string;
  populations: Population[];
  sampleFromStudyId: string | null;
  responses: number;
  total: number;
  groupSizes: Record<string, number>;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  lastResponseAt: string | null;
  run: { pid: number; alive: boolean; startedAt: string; logPath: string } | null;
  /** Récits de l'échantillon déjà écrits (study:run les écrit avant les réponses). */
  narratives?: { done: number; total: number; lastAt: string | null };
}

export type SummaryResponse = StudySummary & {
  unit: string;
  /** Libellés d'affichage de l'échelle (protocole propre à l'étude, sinon historique). */
  scale?: { behaviors: Array<{ code: string; label: string; short: string }>; objections: Array<{ code: string; label: string; short: string }>; relevance: Array<{ code: string; label: string }> };
  /** Niveau canonique de chaque comportement (protocole propre seulement). */
  behaviorLevels?: Record<string, string> | null;
  levelLabels?: Record<string, string>;
  /** Langue du contenu de l'étude (socle de la cible du projet). */
  locale?: "fr" | "en";
};

export interface SegmentValue {
  code: string;
  label: string;
}

export interface ResponseRowItem {
  personaId: string;
  who: string;
  occupation: string;
  group: string;
  behavior: string | null;
  relevance: string | null;
  objections: Array<{ category: string; detail: string }>;
  verbatim: string;
  reaction: string;
  wouldForward: boolean | null;
  neverPay: boolean | null;
  anomalies: string[];
  repaired: boolean;
  segments: Record<string, SegmentValue>;
}

export interface PersonaCard {
  id: string;
  packVersion: string;
  seed: number | null;
  firstName: string | null;
  age: number;
  sex: string;
  occupation: string;
  monthlyIncomeEur: number;
  monthlyDiscretionaryBudgetEur: number;
  priceSensitivity: number;
  skepticism: number;
  techAdoption?: string;
  narrative: string | null;
  narrativeBackend: string | null;
  narrativeModel: string | null;
  subscriptions: Array<{ name: string; category: string; monthlyEur: number; household?: boolean }>;
  facts: Array<{ label: string; value: string }>;
  segments: Record<string, SegmentValue>;
}

export interface ResponseDetail {
  response: {
    id: string;
    studyId: string;
    personaId: string;
    payload: Record<string, unknown>;
    backend: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number | null;
    durationMs: number;
    attempts: number;
    narrativeUsed: boolean;
    repaired: boolean;
    anomalies: string[];
    createdAt: string;
  };
  group: string;
  persona: PersonaCard;
  study: { id: string; name: string; backend: string; model: string };
  project: ProjectDetail | null;
}

export interface PersonaPage {
  total: number;
  page: number;
  pageSize: number;
  items: Array<{
    id: string;
    packVersion: string;
    firstName: string | null;
    age: number;
    sex: string;
    occupation: string;
    monthlyDiscretionaryBudgetEur: number;
    hasNarrative: boolean;
    segments: Record<string, SegmentValue>;
  }>;
  facets: Record<string, Array<{ code: string; label: string; n: number }>>;
  dimensionLabels: Record<string, string>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

/** Ajoute ?lang= quand l'interface n'est pas en français (textes générés par l'API dans la langue). */
export function withLang(url: string): string {
  const l = getLocale();
  if (l === DEFAULT_LOCALE || /[?&]lang=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}lang=${l}`;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(withLang(`/api${path}`), {
    ...rest,
    ...(json !== undefined && { method: rest.method ?? "POST", body: JSON.stringify(json), headers: { "content-type": "application/json" } }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(typeof body.error === "string" ? body.error : tr(commonDict).apiError(res.status), res.status, body);
  return body as T;
}

/** Charge une ressource ; `reload` la relit (après une action, ou en polling). */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e as Error);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load };
}

const metaCache = new Map<string, Promise<Meta>>();
export function useMeta(): Meta | null {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    const l = getLocale();
    let p = metaCache.get(l);
    if (!p) {
      p = api<Meta>("/meta").then((m) => {
        for (const pk of m.packs) packInfos.set(pk.packVersion, pk);
        return m;
      });
      metaCache.set(l, p);
    }
    p.then(setMeta, () => metaCache.delete(l));
  }, []);
  return meta;
}

// ─── Modules (assistant de création, phase 5) ────────────────────────────────

export type { DraftMeta, ModuleSummary, ModuleView, PreviewResult, ValidationIssue } from "../../src/web/modules";
import type { DraftMeta, ModuleSummary, ModuleView, PreviewResult, ValidationIssue } from "../../src/web/modules";
import type { ProjectTargeting } from "../../src/web/module-routes";
export type { ProjectTargeting };

export interface AssistantState {
  available: boolean;
  reason?: string;
}

export interface ModulesResponse {
  assistant: AssistantState;
  modules: ModuleSummary[];
}

export interface JobInfo {
  pid: number;
  alive: boolean;
  startedAt: string;
  logPath: string;
  command: string[];
}

export interface ModuleResponse {
  assistant: AssistantState;
  module: { yaml: string; status: string; meta?: DraftMeta; validationErrors: Array<ValidationIssue | string> };
  view: ModuleView | null;
  draftId: string | null;
  job: JobInfo | null;
}

export interface DraftStatus {
  draftId: string;
  meta: DraftMeta | null;
  job: JobInfo | null;
  log: string;
  stalled: boolean;
}

export type { PreviewResult as ModulePreview };
