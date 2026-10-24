import type { Pack } from "../personas/pack";
import { sgSocleVars } from "../personas/countries/sg/vars";
import { usSocleVars } from "../personas/countries/us/vars";
import { Rng } from "../personas/rng";
import { drawPhase, type ModuleValues } from "./engine";
import type { ResolvedModules } from "./registry";

/**
 * Application des modules à une persona déjà tirée (socle complet), avec un flux aléatoire par module
 * (graine, rang, module) : le socle et les autres modules ne bougent pas quand on en ajoute un.
 * Fonctionne aussi sur une persona relue en base (cache), pour lui ajouter un module.
 */

export interface SocleLike {
  age: number;
  sex: string;
  region: string;
  townSize: string;
  householdType: string;
  activityStatus?: string | null;
  pcs?: string | null;
  monthlyIncomeEur: number;
  equipment?: string[];
  techAdoption?: string;
  socialMediaUsage?: string;
  extra: unknown;
}

/** Variables du socle visibles par les modules (voir SOCLE_VARS dans registry.ts). */
export function socleVars(pack: Pack, p: SocleLike): Record<string, string | number | null> {
  if (pack.kind === "sg") return sgSocleVars(pack, p);
  if (pack.kind === "us") return usSocleVars(pack, p);
  const x = (p.extra ?? {}) as {
    tenure?: string;
    childrenAges?: number[];
    partner?: { status?: string } | null;
    livingStandardEur?: number;
  };
  const median = pack.livingStandard.data.median / 12;
  const ls = x.livingStandardEur ?? 0;
  return {
    age: p.age,
    sex: p.sex,
    region: p.region,
    town_size: p.townSize,
    household_type: p.householdType,
    tenure: x.tenure ?? null,
    children_under_12: (x.childrenAges ?? []).filter((a) => a < 12).length,
    partner_status: x.partner ? (x.partner.status === "employed" ? "employed" : "not_employed") : "none",
    living_standard_ratio: ls / median,
    living_standard: ls,
    monthly_income: p.monthlyIncomeEur,
    activity_status: p.activityStatus ?? null,
    pcs: p.pcs ?? "none",
    has_computer: p.equipment ? p.equipment.includes("ordinateur") : null,
    has_smartphone: p.equipment ? p.equipment.includes("smartphone") : null,
    has_tablet: p.equipment ? p.equipment.includes("tablette") : null,
    has_internet: p.equipment ? p.equipment.includes("internet à domicile") : null,
    tech_adoption: p.techAdoption ?? null,
    social_media: p.socialMediaUsage ?? null,
  } as Record<string, string | number | null>;
}

export const moduleStream = (seed: number, index: number, moduleId: string) => Rng.forPersona(seed, index, `module:${moduleId}`);

/**
 * Tire les modules manquants d'une persona (les valeurs déjà présentes sont gardées). Renvoie les valeurs
 * complétées et les versions des modules appliqués.
 */
export function applyModules(
  pack: Pack,
  p: SocleLike & { seed: number | null; drawIndex: number | null },
  resolved: ResolvedModules,
  existing: ModuleValues = {},
): { modules: ModuleValues; versions: Record<string, string> } {
  if (p.seed === null || p.drawIndex === null) throw new Error("Persona sans graine ni rang : modules impossibles à tirer");
  const values: ModuleValues = structuredClone(existing);
  const missing: ResolvedModules = { ordered: resolved.ordered.filter((m) => !values[m.def.id]), quasiDims: resolved.quasiDims };
  const ctx = {
    rng: new Rng("unused"),
    rngFor: (id: string) => moduleStream(p.seed!, p.drawIndex!, id),
    seed: p.seed,
    index: p.drawIndex,
    socle: socleVars(pack, p),
  };
  // Deux phases pour respecter les dépendances déclarées ; chaque module a son propre flux, créé une fois.
  const streams = new Map<string, Rng>();
  const rngFor = (id: string) => {
    let r = streams.get(id);
    if (!r) streams.set(id, (r = ctx.rngFor(id)));
    return r;
  };
  drawPhase(missing, "work", values, { ...ctx, rngFor });
  drawPhase(missing, "profile", values, { ...ctx, rngFor });
  const versions = Object.fromEntries(resolved.ordered.map((m) => [m.def.id, m.def.version]));
  return { modules: values, versions };
}
