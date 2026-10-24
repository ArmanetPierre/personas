import type { ModuleValues } from "../../../modules/engine";
import type { UsPack } from "./pack";

/**
 * Variables du socle États-Unis visibles par les modules (`socle.<var>`) et par le filtre d'éligibilité
 * d'une cible. Mêmes noms qu'en France et à Singapour pour les variables communes (age, sex, region,
 * town_size, household_type, tenure, pcs…), plus les variables propres : state, division, urbanicity,
 * race_ethnicity, nativity, home_language, education, dwelling, class_of_worker, health_insurance,
 * has_student_loan, vehicles, married. Catalogue : SOCLE_VAR_DOCS_US (modules/registry.ts).
 */

export interface UsExtra {
  state?: string;
  division?: string;
  urbanicity?: string;
  race?: string;
  nativity?: string;
  homeLanguage?: string;
  education?: string;
  dwelling?: string;
  classOfWorker?: string;
  healthInsurance?: string;
  studentLoan?: boolean;
  vehicles?: number;
  married?: boolean;
  tenure?: string;
  childrenAges?: number[];
  partner?: { status?: string } | null;
  livingStandardEur?: number;
  modules?: ModuleValues;
}

interface UsLike {
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

function own(x: UsExtra, p: UsLike) {
  return {
    state: x.state ?? p.townSize,
    division: x.division ?? null,
    urbanicity: x.urbanicity ?? null,
    race_ethnicity: x.race ?? null,
    nativity: x.nativity ?? null,
    home_language: x.homeLanguage ?? null,
    education: x.education ?? null,
    dwelling: x.dwelling ?? null,
    class_of_worker: x.classOfWorker ?? "none",
    health_insurance: x.healthInsurance ?? null,
    has_student_loan: x.studentLoan === true,
    vehicles: x.vehicles ?? null,
    married: x.married === true,
  };
}

export function usSocleVars(pack: UsPack, p: UsLike): Record<string, string | number | null> {
  const x = (p.extra ?? {}) as UsExtra;
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
    ...own(x, p),
  } as unknown as Record<string, string | number | null>;
}

/** Variables du filtre d'éligibilité d'une persona du socle États-Unis (socle + modules « module.attr »). */
export function usEligibilityVars(p: UsLike & { householdSize?: number | null; householdIncomeEur?: number | null; monthlyDiscretionaryBudgetEur: number }): Record<string, unknown> {
  const x = (p.extra ?? {}) as UsExtra;
  const vars: Record<string, unknown> = {
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
    has_computer: has(p, "computer"),
    has_smartphone: has(p, "smartphone"),
    has_tablet: has(p, "tablet"),
    has_internet: has(p, "home internet"),
    ...own(x, p),
  };
  for (const [mid, vals] of Object.entries(x.modules ?? {})) for (const [k, v] of Object.entries(vals)) vars[`${mid}.${k}`] = v;
  return vars;
}

/** Noms des variables du filtre pour le socle États-Unis (contrôle des filtres). */
export const US_ELIGIBILITY_VARS = Object.keys(
  usEligibilityVars({ age: 0, sex: "F", region: "", townSize: "", householdType: "", monthlyIncomeEur: 0, monthlyDiscretionaryBudgetEur: 0, extra: {} }),
);
