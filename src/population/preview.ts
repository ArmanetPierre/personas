import { audienceOf } from "../studies/locale";
import type { Persona, Project } from "../db/schema";
import type { ModuleValue, ModuleValues } from "../modules/engine";
import { valueLabel } from "../modules/engine";
import type { LoadedModule } from "../modules/registry";
import type { DrawnPersona } from "../personas/sampler";
import type { Pack } from "../personas/pack";
import { personaCard } from "../studies/protocols/concept-price";
import type { z } from "zod";
import { priceColumns, projectFileSchema, type ProjectExtra } from "../studies/project";
import { AGE_BANDS, segmentLabel, segmentOf } from "../studies/segments";
import {
  DEFAULT_ALERT_SHARE,
  DEFAULT_NC_THRESHOLD,
  estimateNotConcerned,
  LABEL_ORDERS,
  ollamaLogprobClient,
  profileGroups,
  reviewList,
  relevanceSystem,
  relevanceUser,
  runTriage,
  type LogprobClient,
  type ProfileDimension,
  type ProfileGroup,
  type RelevanceLabel,
  type RelevanceProbs,
  type TriageItem,
} from "../triage";
import { drawTarget, eligibilityVars, prepareTarget, type PreparedTarget } from "./target";

/**
 * Aperçu d'une cible avant lancement (lot P1, point 1) : taux d'éligibilité, distributions des
 * attributs clés, fiches telles que le protocole les verra (restreintes aux modules de l'étude) et,
 * en option, pré-tri de pertinence par le Qwen local, avec la part estimée de « pas concerné·e »
 * et les profils typiques concernés. Aucun appel à Claude ; rien n'est écrit en base.
 */

/** Fichier projet (lu ou littéral, valeurs par défaut comprises) ou ligne `projects` de la base. */
export type ProjectInput = z.input<typeof projectFileSchema> | Project;

/** Ligne `projects` équivalente à un fichier projet (sans l'écrire en base). */
export function projectRow(input: ProjectInput): Project {
  if ("createdAt" in input && "priceEur" in input) return input as Project;
  const file = projectFileSchema.parse(input);
  const cols = priceColumns(file);
  const now = new Date().toISOString();
  return {
    id: file.id ?? "projet",
    name: file.name,
    pitch: file.pitch.trim(),
    targetAudience: file.targetAudience ?? null,
    businessModel: file.businessModel ?? null,
    priceEur: cols.priceEur,
    pricePeriod: cols.pricePeriod,
    freeOffer: cols.freeOffer,
    competitors: file.competitors,
    alternatives: file.alternatives,
    extra: { ...cols.extra, ...(file.target && { target: file.target }), ...(file.control && { control: file.control }) } satisfies ProjectExtra,
    createdAt: now,
    updatedAt: now,
  };
}

export interface PreviewOptions {
  /** Groupe du projet à prévisualiser (défaut : target). */
  group?: string;
  /** Spécification de population à la place de celle du projet (variantes de l'assistant de cible). */
  spec?: unknown;
  /** Effectif tiré (défaut : n de la cible, sinon 200). */
  n?: number;
  /** Graine du tirage (défaut 42 ; celle de l'étude pour retrouver ses personas). */
  seed?: number;
  /** Nombre de fiches d'exemple (défaut 10). */
  sample?: number;
  /** Pré-tri de pertinence par le Qwen local (2 appels par persona, en cache). */
  triage?: boolean | TriagePreviewOptions;
  /** Bibliothèque de modules (défaut : modules validés). */
  library?: Map<string, LoadedModule>;
  log?: (msg: string) => void;
}

export interface TriagePreviewOptions {
  client?: LogprobClient;
  cachePath?: string | null;
  /** Seuil sur P(pas concerné·e) par persona (défaut DEFAULT_NC_THRESHOLD). */
  threshold?: number;
  /** Seuil d'alerte sur la part estimée (défaut 10 %). */
  alertShare?: number;
}

export interface DistributionValue {
  value: string;
  label: string;
  count: number;
  share: number;
}

export interface AttributeDistribution {
  key: string;
  label: string;
  source: "socle" | "module";
  /** L'attribut figure dans le filtre d'éligibilité. */
  inFilter: boolean;
  /** Attribut à valeurs multiples (set) : les parts ne somment pas à 1. */
  multi?: boolean;
  values: DistributionValue[];
}

export interface TargetPreview {
  project: { id: string; name: string };
  group: string;
  socle: string;
  modules: string[];
  filter: string | null;
  seed: number;
  n: number;
  eligibility: {
    draws: number;
    eligible: number;
    rate: number;
    ci: [number, number];
    rare: boolean;
    warnings: string[];
    shortfalls: string[];
  };
  distributions: AttributeDistribution[];
  cards: Array<{ id: string; card: string }>;
  triage?: TriagePreview;
  ms: number;
}

export interface TriagePreview {
  model: string;
  method: string;
  threshold: number;
  alertShare: number;
  n: number;
  /** Part estimée de « pas concerné·e » (moyenne des P(NC)), IC 95 % bootstrap. */
  share: number;
  ci: [number, number];
  /** Personas au-dessus du seuil par persona. */
  flagged: number;
  /** Fiches à relire : les plus probablement pas concernées (au moins 10), avec leur fiche. */
  review: Array<{ id: string; notConcerned: number; card: string }>;
  argmax: Record<RelevanceLabel, number>;
  alert: boolean;
  message: string;
  profiles: ProfileGroup[];
  personas: Array<{ id: string; probs: RelevanceProbs; label: RelevanceLabel; flagged: boolean }>;
  failed: number;
  calls: number;
  cachedCalls: number;
  ms: number;
}

// ─── Dimensions ───────────────────────────────────────────────────────────────

interface Dimension {
  key: string;
  label: string;
  source: "socle" | "module";
  inFilter: boolean;
  multi?: boolean;
  /** Codes (plusieurs pour un set), libellés. */
  read(p: DrawnPersona): Array<{ code: string; label: string }>;
}

/** Variables du socle du filtre → dimension de segment (libellés communs). */
const SOCLE_SEGMENT: Record<string, string> = {
  age: "ageBand",
  sex: "sex",
  pcs: "pcs",
  activity_status: "activityStatus",
  region: "region",
  town_size: "townSize",
  tech_adoption: "techAdoption",
};
const SOCLE_LABELS: Record<string, string> = {
  ageBand: "Tranche d'âge",
  pcs: "PCS",
  activityStatus: "Situation d'activité",
  sex: "Sexe",
  region: "Région",
  townSize: "Taille d'agglomération",
  techAdoption: "Profil d'adoption",
};

const NA = { code: "na", label: "non applicable" };

/** Classes d'un attribut numérique : valeurs distinctes si peu nombreuses, sinon quintiles arrondis. */
export function numberBins(values: number[]): (x: number) => { code: string; label: string } {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  const fmt = (x: number) => Number(x.toPrecision(3)).toLocaleString("fr-FR");
  if (distinct.length <= 7) return (x) => ({ code: String(x), label: fmt(x) });
  const sorted = [...values].sort((a, b) => a - b);
  const cuts = [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => Number(sorted[Math.floor(q * (sorted.length - 1))]!.toPrecision(2))))].filter((c) => c > sorted[0]!);
  return (x) => {
    const i = cuts.findIndex((c) => x < c);
    if (i === 0) return { code: `<${cuts[0]}`, label: `< ${fmt(cuts[0]!)}` };
    if (i === -1) return { code: `>=${cuts[cuts.length - 1]}`, label: `≥ ${fmt(cuts[cuts.length - 1]!)}` };
    return { code: `${cuts[i - 1]}-${cuts[i]}`, label: `${fmt(cuts[i - 1]!)} à < ${fmt(cuts[i]!)}` };
  };
}

function dimensions(prepared: PreparedTarget, personas: DrawnPersona[]): Dimension[] {
  const pack: Pack = prepared.pack;
  const filterVars = new Set(prepared.filter?.variables ?? []);
  const dims: Dimension[] = [];
  const socleDims = ["ageBand", "pcs", "activityStatus"];
  for (const v of filterVars) {
    const seg = SOCLE_SEGMENT[v];
    if (seg && !socleDims.includes(seg)) socleDims.push(seg);
  }
  for (const seg of socleDims) {
    const inFilter = [...filterVars].some((v) => SOCLE_SEGMENT[v] === seg);
    dims.push({
      key: seg,
      label: SOCLE_LABELS[seg] ?? seg,
      source: "socle",
      inFilter,
      read: (p) => {
        const code = segmentOf(pack, p as unknown as Persona, seg);
        return [{ code, label: segmentLabel(pack, seg, code) }];
      },
    });
  }
  // Autres variables du socle présentes dans le filtre (revenus, foyer…)
  for (const v of filterVars) {
    if (v.includes(".") || SOCLE_SEGMENT[v]) continue;
    const raw = personas.map((p) => eligibilityVars(p)[v]);
    const nums = raw.filter((x): x is number => typeof x === "number");
    const bin = nums.length === raw.length && nums.length ? numberBins(nums) : null;
    dims.push({
      key: v,
      label: v,
      source: "socle",
      inFilter: true,
      read: (p) => {
        const x = eligibilityVars(p)[v];
        if (x === null || x === undefined) return [NA];
        if (bin && typeof x === "number") return [bin(x)];
        return [{ code: String(x), label: String(x).replace(/_/g, " ") }];
      },
    });
  }
  // Attributs des modules déclarés par la cible (pas leurs dépendances), puis attributs de dépendances cités par le filtre
  const declared = new Set(prepared.spec.modules);
  for (const m of prepared.modules.ordered) {
    for (const a of m.def.attributes) {
      const key = `${m.def.id}.${a.key}`;
      const inFilter = filterVars.has(key);
      if (!declared.has(m.def.id) && !inFilter) continue;
      const get = (p: DrawnPersona): ModuleValue | undefined => (p.extra.modules as ModuleValues | undefined)?.[m.def.id]?.[a.key];
      let read: Dimension["read"];
      if (a.type === "number") {
        const nums = personas.map(get).filter((x): x is number => typeof x === "number");
        const bin = numberBins(nums.length ? nums : [0]);
        read = (p) => {
          const x = get(p);
          return typeof x === "number" ? [bin(x)] : [NA];
        };
      } else if (a.type === "boolean") {
        read = (p) => {
          const x = get(p);
          if (x === null || x === undefined) return [NA];
          return [{ code: x ? "true" : "false", label: a.labels ? (x ? a.labels.yes : a.labels.no) : x ? "oui" : "non" }];
        };
      } else if (a.type === "set") {
        read = (p) => {
          const x = get(p);
          if (x === null || x === undefined) return [NA];
          const arr = Array.isArray(x) ? (x as string[]) : [];
          if (!arr.length) return [{ code: "none", label: "aucun" }];
          return arr.map((c) => ({ code: c, label: a.items.find((i) => i.code === c)?.label ?? c }));
        };
      } else {
        read = (p) => {
          const x = get(p);
          if (x === null || x === undefined) return [NA];
          return [{ code: String(x), label: valueLabel(m, a.key, String(x), p.sex) ?? String(x) }];
        };
      }
      dims.push({ key, label: `${a.label} (${m.def.id})`, source: "module", inFilter, multi: a.type === "set", read });
    }
  }
  return dims;
}

function distribution(dim: Dimension, personas: DrawnPersona[]): AttributeDistribution {
  const counts = new Map<string, { label: string; count: number }>();
  for (const p of personas) {
    for (const v of dim.read(p)) {
      const c = counts.get(v.code) ?? { label: v.label, count: 0 };
      c.count++;
      counts.set(v.code, c);
    }
  }
  const values = [...counts]
    .map(([value, c]) => ({ value, label: c.label, count: c.count, share: c.count / Math.max(1, personas.length) }))
    .sort((a, b) => {
      // Tranches d'âge et classes numériques dans l'ordre ; le reste par effectif
      const ia = AGE_BANDS.findIndex((x) => x.code === a.value);
      const ib = AGE_BANDS.findIndex((x) => x.code === b.value);
      if (ia >= 0 && ib >= 0) return ia - ib;
      return b.count - a.count;
    });
  return { key: dim.key, label: dim.label, source: dim.source, inFilter: dim.inFilter, ...(dim.multi && { multi: true }), values };
}

// ─── Aperçu ───────────────────────────────────────────────────────────────────

export async function previewTarget(project: ProjectInput, opts: PreviewOptions = {}): Promise<TargetPreview> {
  const t0 = performance.now();
  const row = projectRow(project);
  const group = opts.group ?? "target";
  const spec = opts.spec ?? (row.extra as Record<string, unknown>)[group];
  if (!spec) throw new Error(`Pas de bloc « ${group} » dans le projet ${row.id}.`);
  const prepared = prepareTarget(spec, opts.library ? { library: opts.library } : {});
  const n = opts.n ?? prepared.spec.n ?? 200;
  const seed = opts.seed ?? 42;
  const d = drawTarget(prepared, n, seed);
  const moduleIds = prepared.modules.ordered.map((m) => m.def.id);
  const pack = d.pack;
  const dims = dimensions(prepared, d.personas);

  const sampleN = Math.min(opts.sample ?? 10, d.personas.length);
  const cards = Array.from({ length: sampleN }, (_, i) => d.personas[Math.floor((i * d.personas.length) / sampleN)]!).map((p) => ({
    id: p.id,
    card: personaCard(pack, p as unknown as Persona, moduleIds),
  }));

  const out: TargetPreview = {
    project: { id: row.id, name: row.name },
    group,
    socle: pack.manifest.version,
    modules: prepared.modules.ordered.map((m) => `${m.def.id}@${m.def.version}`),
    filter: prepared.filter?.source ?? null,
    seed,
    n: d.personas.length,
    eligibility: { draws: d.draws, eligible: d.eligible, rate: d.rate, ci: d.ci, rare: d.rare, warnings: d.warnings, shortfalls: d.shortfalls },
    distributions: dims.map((dim) => distribution(dim, d.personas)),
    cards,
    ms: 0,
  };

  if (opts.triage) {
    const to: TriagePreviewOptions = opts.triage === true ? {} : opts.triage;
    const client = to.client ?? ollamaLogprobClient();
    const threshold = to.threshold ?? DEFAULT_NC_THRESHOLD;
    const alertShare = to.alertShare ?? DEFAULT_ALERT_SHARE;
    const system = Object.fromEntries(LABEL_ORDERS.map((o) => [o, relevanceSystem(row, o, audienceOf(pack))])) as TriageItem["system"];
    const byId = new Map(d.personas.map((p) => [p.id, p]));
    // Personas virtuelles : pas de portrait (la fiche seule, comme dans la validation hors ligne)
    const items: TriageItem[] = d.personas.map((p) => ({
      id: p.id,
      system,
      user: relevanceUser(pack, { ...(p as unknown as Persona), narrative: null }, moduleIds),
    }));
    opts.log?.(`Pré-tri : ${items.length} personas × 2 ordres (${client.model})`);
    const run = await runTriage(items, { client, ...(to.cachePath !== undefined && { cachePath: to.cachePath }), log: opts.log });
    const est = estimateNotConcerned(run.results, threshold);
    const profileDims: ProfileDimension[] = dims
      .filter((dim) => !dim.multi)
      .map((dim) => ({
        key: dim.key,
        label: dim.label,
        value: (id: string) => {
          const v = dim.read(byId.get(id)!)[0];
          return v && v.code !== "na" ? v : null;
        },
      }));
    const profiles = profileGroups(run.results, profileDims);
    const alert = est.share > alertShare;
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const top = profiles
      .slice(0, 3)
      .map((g) => `${g.criteria.map((c) => `${c.label} = ${c.valueLabel}`).join(" et ")} (≈ ${Math.round(g.rate * 100)} % de ${g.n}, ${g.inReview} dans les fiches à relire)`)
      .join(" ; ");
    const message = alert
      ? `≈ ${pct(est.share)} de la cible probablement pas concernée [IC 95 % ${pct(est.ci[0])} ; ${pct(est.ci[1])}], au-dessus du seuil de ${pct(alertShare)}. ` +
        (top ? `Profils typiques : ${top}. Resserrer le filtre sur ces attributs avant de lancer l'étude.` : "Aucun profil ne se détache.")
      : `≈ ${pct(est.share)} de la cible probablement pas concernée [IC 95 % ${pct(est.ci[0])} ; ${pct(est.ci[1])}], sous le seuil de ${pct(alertShare)}.` +
        (top ? ` Profils à surveiller : ${top}.` : "");
    out.triage = {
      model: run.model,
      method: "A : 1 token, log-probabilités, deux ordres d'étiquettes moyennés (docs/research/eval-tri.md)",
      threshold,
      alertShare,
      n: est.n,
      share: est.share,
      ci: est.ci,
      flagged: est.flagged,
      review: reviewList(run.results, est.share).map((id) => ({
        id,
        notConcerned: run.results.find((r) => r.id === id)!.probs.not_concerned,
        card: personaCard(pack, byId.get(id)! as unknown as Persona, moduleIds),
      })),
      argmax: est.argmax,
      alert,
      message,
      profiles,
      personas: run.results.map((r) => ({ id: r.id, probs: r.probs, label: r.label, flagged: r.probs.not_concerned >= threshold })),
      failed: run.failed.length,
      calls: run.calls,
      cachedCalls: run.cached,
      ms: run.ms,
    };
  }
  out.ms = Math.round(performance.now() - t0);
  return out;
}
