import type { EconomicsChange } from "../../economics";
import { clamp, sigmoid } from "../../rng";
import type { DrawnPersona } from "../../sampler";
import type { UsPack } from "./pack";
import { usFica, usIncomeTax, type UsTaxUnit } from "./sampler";

/**
 * Recalcul budgétaire après les modules (socle États-Unis), sans nouveau tirage : un module peut remplacer
 * le revenu personnel (`socle_overrides.monthly_income`, net de FICA) et ajouter des abonnements payés par la
 * persona. On recalcule le brut (FICA de la persona), l'impôt fédéral et de l'État du foyer fiscal tiré
 * (`extra.taxUnit`, crédits d'impôt compris), le revenu disponible, le niveau de vie, le budget et la
 * sensibilité au prix (même part aléatoire). Restent figés : logement, ménage, assurance santé, SNAP,
 * dépenses courantes, profil techno, équipement, tonalité.
 */

interface UsX {
  state?: string;
  classOfWorker?: string;
  consumptionUnits: number;
  livingStandardEur: number;
  monthlyShortfallEur?: number;
  subscriptionsEur: number;
  incomeTaxEur: number;
  selfIncomeTaxEur?: number;
  grossIncomeEur?: number;
  payrollTaxEur?: number;
  benefitsEur?: number;
  taxUnit?: UsTaxUnit;
}

const round = Math.round;

export function recomputeUsEconomics(pack: UsPack, p: DrawnPersona, change: EconomicsChange): DrawnPersona {
  const x = p.extra as unknown as UsX & Record<string, unknown>;
  const ps = pack.psychographics.data;
  const median = pack.livingStandard.data.median / 12;
  const net0 = p.monthlyIncomeEur;
  const net1 = change.income ?? net0;
  const employed = p.activityStatus === "employed";
  const self = x.classOfWorker === "self_employed";
  const gross0 = x.grossIncomeEur ?? net0;
  // Brut au nouveau revenu net (FICA de la persona), par recherche du point fixe
  let gross1 = net1;
  if (employed && net1 !== net0) for (let i = 0; i < 6; i++) gross1 = net1 + usFica(pack, gross1, self);
  else if (net1 === net0) gross1 = gross0;
  const fica1 = employed ? (net1 === net0 ? (x.payrollTaxEur ?? 0) : usFica(pack, gross1, self)) : 0;
  // Impôt et crédits du foyer fiscal : avant et après
  const rate = pack.stateOf(x.state ?? "")?.stateTaxRate ?? 0;
  let dTax = 0;
  let dCredits = 0;
  if (x.taxUnit && gross1 !== gross0) {
    const u0 = x.taxUnit;
    const d = (gross1 - gross0) * 12;
    const u1: UsTaxUnit = { ...u0, taxable: Math.max(0, u0.taxable + d), earned: employed ? Math.max(0, u0.earned + d) : u0.earned };
    const r0 = usIncomeTax(pack, u0, rate);
    const r1 = usIncomeTax(pack, u1, rate);
    dTax = (r1.federal + r1.state - r0.federal - r0.state) / 12;
    dCredits = (r1.eitc + r1.actc - r0.eitc - r0.actc) / 12;
  }
  const dIncome = net1 - net0 - dTax + dCredits;

  const individual = p.householdType === "with_parents" || p.householdType === "other";
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
      payrollTaxEur: round(fica1),
      selfIncomeTaxEur: round((x.selfIncomeTaxEur ?? 0) + dTax),
      incomeTaxEur: round(x.incomeTaxEur + dTax),
      benefitsEur: round((x.benefitsEur ?? 0) + dCredits),
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
