import type { ModuleValues } from "../../../modules/engine";
import type { SgPack } from "./pack";

/**
 * Variables du socle Singapour visibles par les modules (`socle.<var>`) et par le filtre d'éligibilité
 * d'une cible. Mêmes noms qu'en France pour les variables communes (age, sex, region, town_size,
 * household_type, tenure, pcs…), plus les variables propres : residency_status, ethnicity, religion,
 * home_language, education, dwelling, planning_area, nationality. Catalogue : SOCLE_VAR_DOCS_SG.
 */

export interface SgExtra {
  residency?: string;
  nationality?: string | null;
  ethnicity?: string;
  religion?: string;
  homeLanguage?: string;
  education?: string;
  dwelling?: string;
  tenure?: string;
  childrenAges?: number[];
  partner?: { status?: string } | null;
  livingStandardEur?: number;
  modules?: ModuleValues;
}

interface SgLike {
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

const has = (p: { equipment?: string[] }, tag: string) => (p.equipment ? p.equipment.includes(tag) : null);

export function sgSocleVars(pack: SgPack, p: SgLike): Record<string, string | number | null> {
  const x = (p.extra ?? {}) as SgExtra;
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
    has_computer: has(p, "computer"),
    has_smartphone: has(p, "smartphone"),
    has_tablet: has(p, "tablet"),
    has_internet: has(p, "home internet"),
    tech_adoption: p.techAdoption ?? null,
    social_media: p.socialMediaUsage ?? null,
    residency_status: x.residency ?? null,
    ethnicity: x.ethnicity ?? null,
    religion: x.religion ?? null,
    home_language: x.homeLanguage ?? null,
    education: x.education ?? null,
    dwelling: x.dwelling ?? null,
    planning_area: p.townSize,
    nationality: x.nationality ?? (x.residency === "citizen" ? "singapore" : null),
  } as Record<string, string | number | null>;
}

/** Variables du filtre d'éligibilité d'une persona du socle Singapour (socle + modules « module.attr »). */
export function sgEligibilityVars(p: SgLike & { householdSize?: number | null; householdIncomeEur?: number | null; monthlyDiscretionaryBudgetEur: number }): Record<string, unknown> {
  const x = (p.extra ?? {}) as SgExtra;
  const vars: Record<string, unknown> = {
    age: p.age,
    sex: p.sex,
    region: p.region,
    town_size: p.townSize,
    planning_area: p.townSize,
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
    has_computer: has(p, "computer"),
    has_smartphone: has(p, "smartphone"),
    has_tablet: has(p, "tablet"),
    residency_status: x.residency ?? null,
    resident: x.residency === "citizen" || x.residency === "pr",
    nationality: x.nationality ?? (x.residency === "citizen" ? "singapore" : null),
    ethnicity: x.ethnicity ?? null,
    religion: x.religion ?? null,
    home_language: x.homeLanguage ?? null,
    education: x.education ?? null,
    dwelling: x.dwelling ?? null,
  };
  for (const [mid, vals] of Object.entries(x.modules ?? {})) for (const [k, v] of Object.entries(vals)) vars[`${mid}.${k}`] = v;
  return vars;
}

/** Noms des variables du filtre pour le socle Singapour (contrôle des filtres). */
export const SG_ELIGIBILITY_VARS = Object.keys(
  sgEligibilityVars({ age: 0, sex: "F", region: "", townSize: "", householdType: "", monthlyIncomeEur: 0, monthlyDiscretionaryBudgetEur: 0, extra: {} }),
);
