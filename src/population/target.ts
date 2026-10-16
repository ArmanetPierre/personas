import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { personas, type Persona } from "../db/schema";
import type { ModuleValues } from "../modules/engine";
import { isLegacy, resolveModules, type LoadedModule, type ResolvedModules } from "../modules/registry";
import { loadPack, PACKS_DIR, type Pack } from "../personas/pack";
import { drawPersona, type DrawnPersona } from "../personas/sampler";
import { segmentOf } from "../studies/segments";
import { compileEligibility, type CompiledEligibility, type Vars } from "./eligibility";
import { SG_ELIGIBILITY_VARS, sgEligibilityVars } from "../personas/countries/sg/vars";

/**
 * Ciblage conditionnel : une population se déclare par un socle, des modules et un filtre
 * d'éligibilité. Le générateur tire des personas virtuelles (socle + modules, sans LLM) rang après
 * rang, garde celles qui passent le filtre (et les quotas) jusqu'à n, et mesure le taux d'éligibilité.
 * Les personas retenues sont mises en cache en base (ids stables : socle, graine, rang).
 */

export const DEFAULT_MAX_DRAWS = 1_000_000;
/** En dessous de ce taux d'éligibilité, la cible est signalée comme rare. */
export const DEFAULT_RARE_THRESHOLD = 0.005;

const quotas = z.record(z.string(), z.record(z.string(), z.number().nonnegative()));

export const targetSpecSchema = z
  .object({
    /** Socle : nom de pays (résolu par packs/socles.json, ex. fr → fr-2026.2) ou nom de dossier de pack. */
    socle: z.string().default("fr"),
    /** Modules appliqués (et leurs dépendances). */
    modules: z.array(z.string()).default([]),
    /** Filtre d'éligibilité, en phrase (voir src/population/eligibility.ts). */
    eligibility: z.string().optional(),
    quotas: quotas.optional(),
    /** Effectif ; peut être fourni par la ligne de commande. */
    n: z.number().int().positive().optional(),
    /** Plafond de tirages virtuels avant d'abandonner (cible trop rare). */
    max_draws: z.number().int().positive().optional(),
    /** Seuil de cible rare (défaut 0,5 %). */
    rare_threshold: z.number().min(0).max(1).optional(),
  })
  .strict();
export type TargetSpec = z.infer<typeof targetSpecSchema>;

/** Témoin : même format, sans filtre le plus souvent (population générale du socle). */
export const controlSpecSchema = targetSpecSchema;

/** Bloc à ajouter au fichier projet. */
export const projectTargetingSchema = {
  target: targetSpecSchema.optional(),
  control: controlSpecSchema.optional(),
};

/** Résout le nom de socle d'une cible vers un pack chargeable. */
export function resolveSoclePack(socle: string): Pack {
  let dir = socle;
  try {
    const map = JSON.parse(readFileSync(resolve(PACKS_DIR, "socles.json"), "utf8")) as Record<string, string>;
    if (map[socle]) dir = map[socle];
  } catch {
    // pas de table des socles : nom de dossier direct
  }
  return loadPack(dir);
}

/** Variables visibles par le filtre d'éligibilité pour une persona (socle + modules « module.attr »). */
export function eligibilityVars(p: Pick<DrawnPersona, "age" | "sex" | "region" | "townSize" | "pcs" | "activityStatus" | "householdType" | "householdSize" | "monthlyIncomeEur" | "householdIncomeEur" | "monthlyDiscretionaryBudgetEur" | "techAdoption" | "socialMediaUsage" | "extra"> & { country?: string }): Vars {
  if (p.country === "SG") return sgEligibilityVars(p);
  const x = p.extra as { tenure?: string; childrenAges?: number[]; livingStandardEur?: number; modules?: ModuleValues };
  const vars: Vars = {
    age: p.age,
    sex: p.sex,
    region: p.region,
    town_size: p.townSize,
    pcs: p.pcs ?? "none",
    activity_status: p.activityStatus ?? null,
    household_type: p.householdType,
    household_size: p.householdSize ?? null,
    monthly_income: p.monthlyIncomeEur,
    household_income: p.householdIncomeEur ?? null,
    budget: p.monthlyDiscretionaryBudgetEur,
    living_standard: x.livingStandardEur ?? null,
    tech_adoption: p.techAdoption,
    social_media: p.socialMediaUsage,
    tenure: x.tenure ?? null,
    children: x.childrenAges?.length ?? 0,
    has_computer: (p as { equipment?: string[] }).equipment?.includes("ordinateur") ?? null,
    has_smartphone: (p as { equipment?: string[] }).equipment?.includes("smartphone") ?? null,
    has_tablet: (p as { equipment?: string[] }).equipment?.includes("tablette") ?? null,
  };
  for (const [mid, vals] of Object.entries(x.modules ?? {})) for (const [k, v] of Object.entries(vals)) vars[`${mid}.${k}`] = v;
  return vars;
}

const SOCLE_ELIGIBILITY_VARS = Object.keys(
  eligibilityVars({ age: 0, sex: "F", region: "", townSize: "", pcs: null, activityStatus: null, householdType: "", householdSize: 0, monthlyIncomeEur: 0, householdIncomeEur: 0, monthlyDiscretionaryBudgetEur: 0, techAdoption: "", socialMediaUsage: "", extra: {} } as never),
);

export interface PreparedTarget {
  spec: TargetSpec;
  pack: Pack;
  modules: ResolvedModules;
  filter: CompiledEligibility | null;
}

/** Valide une spécification : socle, modules (dépendances, compatibilité), variables du filtre. */
/**
 * `library` : bibliothèque de modules à utiliser (par défaut, les modules validés). La CLI d'aperçu
 * peut y ajouter des brouillons (`population:draw --drafts`) ; les études n'utilisent que les modules validés.
 */
export function prepareTarget(input: unknown, opts: { library?: Map<string, LoadedModule> } = {}): PreparedTarget {
  const spec = targetSpecSchema.parse(input);
  const pack = resolveSoclePack(spec.socle);
  if (pack.manifest.rngStreams !== "module" && spec.modules.length) {
    throw new Error(`Le socle ${pack.manifest.version} tire les modules dans la chaîne du socle (v1) : utiliser un socle v2 (ex. fr-2026.2).`);
  }
  const modules = resolveModules(spec.modules, pack.socle, opts.library);
  const legacy = modules.ordered.filter(isLegacy).map((m) => m.def.id);
  if (legacy.length) throw new Error(`Module(s) archivé(s), réservé(s) aux études historiques : ${legacy.join(", ")}`);
  const known = new Set(pack.kind === "sg" ? SG_ELIGIBILITY_VARS : SOCLE_ELIGIBILITY_VARS);
  for (const m of modules.ordered) for (const a of m.def.attributes) known.add(`${m.def.id}.${a.key}`);
  const filter = spec.eligibility ? compileEligibility(spec.eligibility, known) : null;
  return { spec, pack, modules, filter };
}

export interface TargetDraw {
  pack: Pack;
  personas: DrawnPersona[];
  /** Personas virtuelles tirées (rangs 0..draws-1). */
  draws: number;
  /** Dont éligibles au filtre (avant quotas et exclusions). */
  eligible: number;
  rate: number;
  /** Intervalle de confiance à 95 % (Wilson) du taux d'éligibilité. */
  ci: [number, number];
  rare: boolean;
  shortfalls: string[];
  warnings: string[];
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/**
 * Tire les `n` premières personas éligibles (dans l'ordre des rangs virtuels de la graine), en respectant
 * les quotas éventuels et en sautant les ids exclus (autre groupe de l'étude). Déterministe.
 */
export function drawTarget(
  target: PreparedTarget,
  n: number,
  seed: number,
  opts: { exclude?: Set<string>; /** Condition d'éligibilité supplémentaire (ex. un enfant du foyer dans la tranche d'âge d'un rôle). */ accept?: (p: DrawnPersona) => boolean } = {},
): TargetDraw {
  const { spec, pack, modules, filter } = target;
  const maxDraws = spec.max_draws ?? DEFAULT_MAX_DRAWS;
  const rareThreshold = spec.rare_threshold ?? DEFAULT_RARE_THRESHOLD;
  const quotaDims = Object.keys(spec.quotas ?? {});
  const remaining = new Map<string, Record<string, number>>();
  for (const d of quotaDims) remaining.set(d, quotaCells(spec.quotas![d]!, n));
  const out: DrawnPersona[] = [];
  let draws = 0;
  let eligible = 0;
  while (out.length < n) {
    if (draws >= maxDraws) {
      const rate = eligible / Math.max(1, draws);
      throw new Error(
        `Cible trop rare : ${out.length}/${n} personas après ${draws.toLocaleString("fr-FR")} tirages ` +
          `(taux d'éligibilité ${(rate * 100).toFixed(3)} %${quotaDims.length ? ", quotas compris" : ""}). ` +
          `Élargir le filtre, réduire n ou relever max_draws.`,
      );
    }
    const p = drawPersona(pack, seed, draws, { modules });
    draws++;
    if (filter && !filter.test(eligibilityVars(p))) continue;
    if (opts.accept && !opts.accept(p)) continue;
    eligible++;
    if (opts.exclude?.has(p.id)) continue;
    if (quotaDims.length) {
      const cells = quotaDims.map((d) => [d, segmentOf(pack, p as unknown as Persona, d)] as const);
      if (!cells.every(([d, c]) => (remaining.get(d)![c] ?? 0) > 0)) {
        // Quotas : on continue tant que des cellules restent ouvertes
        if ([...remaining.values()].every((cells) => Object.values(cells).every((x) => x <= 0))) break;
        continue;
      }
      for (const [d, c] of cells) remaining.get(d)![c]!--;
    }
    out.push(p);
  }
  const rate = eligible / draws;
  const ci = wilson(eligible, draws);
  const shortfalls: string[] = [];
  for (const [d, cells] of remaining) for (const [c, left] of Object.entries(cells)) if (left > 0) shortfalls.push(`${d}=${c} : manque ${left}`);
  const warnings: string[] = [];
  if (filter && rate < rareThreshold) {
    warnings.push(`Cible rare : ${(rate * 100).toFixed(2)} % de la population adulte (seuil ${(rareThreshold * 100).toFixed(1)} %). Les résultats décrivent un petit segment.`);
  }
  return { pack, personas: out, draws, eligible, rate, ci, rare: !!filter && rate < rareThreshold, shortfalls, warnings };
}

/** Effectifs par cellule (plus fort reste), comme les quotas des études. */
function quotaCells(shares: Record<string, number>, n: number): Record<string, number> {
  const total = Object.values(shares).reduce((a, b) => a + b, 0);
  const raw = Object.entries(shares).map(([k, s]) => ({ k, exact: (s / total) * n }));
  const out: Record<string, number> = {};
  let assigned = 0;
  for (const r of raw) assigned += out[r.k] = Math.floor(r.exact);
  raw
    .sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.k.localeCompare(b.k))
    .slice(0, n - assigned)
    .forEach((r) => (out[r.k] = out[r.k]! + 1));
  return out;
}

/**
 * Met en cache les personas tirées : insère celles qui manquent ; pour celles déjà en base, ajoute
 * les modules qui leur manquent (valeurs identiques par construction : un flux par module).
 * Ne touche jamais aux récits.
 */
export function persistDrawn(db: Db, drawn: DrawnPersona[]): { inserted: number; updated: number; reused: number } {
  if (!drawn.length) return { inserted: 0, updated: 0, reused: 0 };
  const existing = new Map(
    db
      .select()
      .from(personas)
      .where(inArray(personas.id, drawn.map((p) => p.id)))
      .all()
      .map((p) => [p.id, p]),
  );
  let inserted = 0;
  let updated = 0;
  let reused = 0;
  db.transaction((tx) => {
    for (const p of drawn) {
      const old = existing.get(p.id);
      if (!old) {
        tx.insert(personas).values(p).run();
        inserted++;
        continue;
      }
      const ox = old.extra as { modules?: ModuleValues; moduleVersions?: Record<string, string> };
      const nx = p.extra as { modules?: ModuleValues; moduleVersions?: Record<string, string> };
      // Jamais de réécriture : une persona en base garde son socle et les valeurs de ses modules.
      // Même identifiant ⇒ même socle et mêmes versions (sinon l'identifiant aurait un suffixe de version).
      for (const [mid, v] of Object.entries(nx.moduleVersions ?? {})) {
        const was = ox.moduleVersions?.[mid];
        if (was && was !== v && ox.modules?.[mid]) throw new Error(`Persona ${p.id} : module ${mid} déjà en base en version ${was}, tiré en ${v} (identifiant à revoir)`);
      }
      if (old.monthlyIncomeEur !== p.monthlyIncomeEur || old.monthlyDiscretionaryBudgetEur !== p.monthlyDiscretionaryBudgetEur) {
        throw new Error(`Persona ${p.id} : socle différent de celui en base (revenu ou budget) ; elle ne sera pas réécrite`);
      }
      const merged = { ...(nx.modules ?? {}), ...(ox.modules ?? {}) };
      if (JSON.stringify(merged) === JSON.stringify(ox.modules ?? {})) {
        reused++;
        continue;
      }
      tx.update(personas)
        .set({ extra: { ...(old.extra as object), modules: merged, moduleVersions: { ...(ox.moduleVersions ?? {}), ...(nx.moduleVersions ?? {}) } } })
        .where(eq(personas.id, p.id))
        .run();
      updated++;
    }
  });
  return { inserted, updated, reused };
}

/** Statistiques d'éligibilité gardées dans l'étude (champ ajouté à `studies.populations`). */
export interface EligibilityStats {
  socle: string;
  modules: string[];
  expression: string | null;
  draws: number;
  eligible: number;
  rate: number;
  ci: [number, number];
  rare: boolean;
}

export function eligibilityStats(target: PreparedTarget, d: TargetDraw): EligibilityStats {
  return {
    socle: d.pack.manifest.version,
    modules: target.modules.ordered.map((m) => `${m.def.id}@${m.def.version}`),
    expression: target.filter?.source ?? null,
    draws: d.draws,
    eligible: d.eligible,
    rate: d.rate,
    ci: d.ci,
    rare: d.rare,
  };
}
