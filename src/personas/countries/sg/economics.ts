import type { EconomicsChange } from "../../economics";
import { clamp, sigmoid } from "../../rng";
import { findBandClamped } from "../../pack-common";
import type { DrawnPersona } from "../../sampler";
import type { SgPack } from "./pack";
import { sgIncomeTax } from "./sampler";

/**
 * Recalcul budgétaire après les modules (socle Singapour), sans nouveau tirage : un module peut remplacer
 * le revenu net personnel (`socle_overrides.monthly_income`) et ajouter des abonnements payés par la persona.
 * On recalcule l'impôt de la persona (brut déduit du net et du taux CPF de son âge), le revenu disponible,
 * le niveau de vie, le budget disponible et la sensibilité au prix (même part aléatoire). Restent figés :
 * logement, ménage, transferts, dépenses courantes, profil techno, équipement, tonalité.
 */

interface SgX {
  residency?: string;
  pass?: string;
  dwelling?: string;
  liveIn?: boolean;
  consumptionUnits: number;
  livingStandardEur: number;
  monthlyShortfallEur?: number;
  subscriptionsEur: number;
  incomeTaxEur: number;
  selfIncomeTaxEur?: number;
  grossIncomeEur?: number;
  cpfEmployeeEur?: number;
}

const round = Math.round;

export function recomputeSgEconomics(pack: SgPack, p: DrawnPersona, change: EconomicsChange): DrawnPersona {
  const x = p.extra as unknown as SgX & Record<string, unknown>;
  const ps = pack.psychographics.data;
  const median = pack.livingStandard.data.median / 12;
  const net0 = p.monthlyIncomeEur;
  const net1 = change.income ?? net0;
  const resident = x.residency === "citizen" || x.residency === "pr";
  const employed = p.activityStatus === "employed";

  // Brut et impôt de la persona au nouveau revenu net
  const rate = resident && employed ? findBandClamped(pack.cpf.data.employeeRate, p.age).rate : 0;
  const ceiling = pack.cpf.data.ordinaryWageCeiling;
  const gross1 = rate ? Math.min(net1 / (1 - rate), net1 + ceiling * rate) : net1;
  const cpf1 = gross1 - net1;
  const tax0 = x.selfIncomeTaxEur ?? 0;
  const tax1 = employed ? sgIncomeTax(pack, gross1 * 12, cpf1 * 12) / 12 : tax0;
  const dIncome = net1 - net0 - (tax1 - tax0);

  // Budget : individuel (chez ses parents, dortoir, employeur, colocation de WP, étudiant étranger) ou du ménage
  const individual =
    p.householdType === "with_parents" || x.dwelling === "dormitory" || x.liveIn === true || x.pass === "wp_cmp" || x.pass === "wp_other" || x.pass === "student";
  const units = individual ? 1 : x.consumptionUnits;
  const perUnit0 = p.monthlyDiscretionaryBudgetEur > 0 ? p.monthlyDiscretionaryBudgetEur : -(x.monthlyShortfallEur ?? 0);
  const contribution = p.householdType === "with_parents" ? pack.costs.data.withParentsContribution : 0;
  const added = change.subscriptions.reduce((s, t) => s + t.monthlyEur, 0);
  const perUnit = (perUnit0 * units + dIncome * (1 - contribution) - added) / units;
  const disposable = (p.householdIncomeEur ?? 0) + dIncome;
  const livingStandard = disposable / x.consumptionUnits;

  const rel0 = x.livingStandardEur / median;
  const rel1 = livingStandard / median;
  const pz = ps.priceSensitivity;
  const strainOf = (pu: number) => clamp(1 - pu / Math.max(200, median * 0.4), 0, 1.5);
  const ps0 = clamp(p.priceSensitivity, 0.005, 0.995);
  const noise = Math.log(ps0 / (1 - ps0)) - (pz.intercept + pz.income * Math.log(Math.max(rel0, 0.1)) + pz.strain * strainOf(perUnit0));
  const priceSensitivity = sigmoid(pz.intercept + pz.income * Math.log(Math.max(rel1, 0.1)) + pz.strain * strainOf(perUnit) + noise);

  return {
    ...p,
    monthlyIncomeEur: round(net1),
    householdIncomeEur: round(disposable),
    monthlyDiscretionaryBudgetEur: round(Math.max(0, perUnit)),
    priceSensitivity: Math.round(priceSensitivity * 100) / 100,
    subscriptions: [...p.subscriptions, ...change.subscriptions],
    extra: {
      ...p.extra,
      grossIncomeEur: round(gross1),
      cpfEmployeeEur: round(cpf1),
      selfIncomeTaxEur: round(tax1),
      incomeTaxEur: round(x.incomeTaxEur + tax1 - tax0),
      subscriptionsEur: round(x.subscriptionsEur + added),
      livingStandardEur: round(livingStandard),
      monthlyShortfallEur: round(perUnit < 0 ? -perUnit : 0),
      economics: {
        modules: change.modules,
        incomeBefore: net0,
        budgetBefore: p.monthlyDiscretionaryBudgetEur,
        householdIncomeBefore: p.householdIncomeEur,
        ...(change.subscriptions.length && { subscriptions: change.subscriptions.map((s) => s.name) }),
      },
    },
  };
}
