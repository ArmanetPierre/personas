import type { PersonaSubscription } from "../db/schema";
import { clamp, sigmoid } from "./rng";
import type { FrPack, Pack } from "./pack";
import { recomputeSgEconomics } from "./countries/sg/economics";
import { recomputeUsEconomics } from "./countries/us/economics";
import { incomeTax, type DrawnPersona, type PersonaExtra } from "./sampler";

/**
 * Recalcul budgétaire après les modules (socle v2). Un module peut remplacer le revenu personnel
 * (`socle_overrides.monthly_income`) et ajouter des abonnements payés par la persona
 * (`affects_budget`). On recalcule alors, de façon déterministe et sans nouveau tirage, ce qui en
 * découle dans le socle : impôt sur le revenu, prestations (allocations, minima, prime d'activité,
 * aide au logement), revenus du patrimoine (même taux), mensualité plafonnée d'un crédit, revenu
 * disponible, niveau de vie, dépenses courantes, abonnements, reste-à-vivre et sensibilité au prix
 * (même part aléatoire). Restent figés : profil techno, équipement, ménage, logement, tonalité.
 *
 * Une persona sans module, ou dont les modules ne touchent ni au revenu ni au budget, ne passe
 * jamais par ici : son tirage est strictement celui du socle.
 */

export interface EconomicsChange {
  /** Nouveau revenu personnel net mensuel (null : inchangé). */
  income: number | null;
  /** Abonnements ajoutés, payés par la persona. */
  subscriptions: PersonaSubscription[];
  /** Modules à l'origine du changement (« id@version »). */
  modules: string[];
}

const round = Math.round;

interface Earnerish {
  age: number;
  status: string;
  income: number;
}

const taxableStatus = (s: string) => s !== "student" && s !== "inactive";

/** Impôt, prestations et aide au logement du ménage : mêmes formules que le tirage du socle. */
function householdTransfers(pack: FrPack, p: DrawnPersona, selfIncome: number, housingCost: number) {
  const x = p.extra as PersonaExtra;
  const self: Earnerish = { age: p.age, status: p.activityStatus ?? "inactive", income: selfIncome };
  const partner: Earnerish | null = x.partner ? { age: x.partner.age, status: x.partner.status, income: x.partner.incomeEur } : null;
  const parents: Earnerish[] = x.parents.map((q) => ({ age: q.age, status: q.status, income: q.incomeEur }));
  const children = x.childrenAges;
  const householdType = p.householdType;
  const earners = [self, ...(partner ? [partner] : []), ...parents];
  const grossMonthly = earners.reduce((s, e) => s + e.income, 0);
  const taxableAnnual = earners.filter((e) => taxableStatus(e.status)).reduce((s, e) => s + e.income * 12, 0);
  const couple = partner !== null || parents.length === 2;
  const dependents = householdType === "with_parents" ? [p.age] : children.filter((a) => a < 21);
  const parts =
    (couple ? 2 : 1) +
    dependents.reduce((s, _, i) => s + (i < 2 ? 0.5 : 1), 0) +
    (!couple && dependents.length > 0 && householdType !== "with_parents" ? 0.5 : 0);
  const tax = incomeTax(pack, taxableAnnual, parts, couple) / 12;

  const tb = pack.taxBenefits.data;
  const youngChildren = children.filter((a) => a < 20).length;
  let benefits =
    youngChildren >= 2
      ? youngChildren === 2
        ? tb.familyAllowance.two
        : tb.familyAllowance.three + (youngChildren - 3) * tb.familyAllowance.perExtra
      : 0;
  const rsaAdults = householdType === "other" ? 1 : 1 + (partner ? 1 : 0);
  const scale =
    1 +
    (rsaAdults - 1) * tb.rsa.secondAdult +
    children.filter((a) => a < 20).reduce((s, _, i) => s + (i < 2 ? tb.rsa.perChild : tb.rsa.thirdChildOn), 0);
  if (householdType !== "with_parents" && self.status !== "student") {
    const senior = p.age >= 65 || (partner !== null && partner.age >= 65);
    const floor = senior ? (rsaAdults > 1 ? tb.aspa.couple : tb.aspa.single) : tb.rsa.base * scale;
    const resources = grossMonthly - tax + benefits;
    if (resources < floor) benefits += floor - resources;
    const earned = [self, ...(partner ? [partner] : [])].filter((e) => e.status === "employed").reduce((s, e) => s + e.income, 0);
    if (earned > 0) {
      const pa = tb.activityBonus.base * scale + tb.activityBonus.earnedRate * earned - (grossMonthly - tax + benefits);
      if (pa >= tb.activityBonus.minPayment) benefits += pa;
    }
  }
  const uc = x.consumptionUnits;
  let housingAid = 0;
  if ((x.tenure === "renter_private" || x.tenure === "renter_social") && householdType !== "with_parents") {
    const ha = tb.housingAid;
    const max = (rsaAdults > 1 ? ha.maxCouple : ha.maxSingle) + ha.perChild * children.length;
    const perUc = (grossMonthly - tax) / uc;
    housingAid = Math.max(0, Math.min(max, housingCost * 0.9) - ha.taperRate * Math.max(0, perUc - ha.floorIncomePerUc) * uc);
  }
  return { grossMonthly, tax, benefits: benefits + housingAid, housingAid };
}

export function recomputeEconomics(pack: Pack, p: DrawnPersona, change: EconomicsChange): DrawnPersona {
  if (pack.kind === "us") return recomputeUsEconomics(pack, p, change);
  return pack.kind === "sg" ? recomputeSgEconomics(pack, p, change) : recomputeFrEconomics(pack, p, change);
}

function recomputeFrEconomics(pack: FrPack, p: DrawnPersona, change: EconomicsChange): DrawnPersona {
  const x = p.extra as PersonaExtra;
  const c = pack.costs.data;
  const ps = pack.psychographics.data;
  const median = pack.livingStandard.data.median / 12;
  const uc = x.consumptionUnits;
  const income0 = p.monthlyIncomeEur;
  const income1 = change.income ?? income0;

  // État avant : transferts recalculés à l'identique, patrimoine déduit du revenu disponible enregistré
  const before = householdTransfers(pack, p, income0, x.housingCostEur);
  const patrimony0 = (p.householdIncomeEur ?? 0) - (before.grossMonthly - before.tax + before.benefits);
  const patrimonyRate = before.grossMonthly > 0 ? Math.max(0, patrimony0) / before.grossMonthly : 0;

  // Mensualité d'un crédit : plafonnée à une part du revenu ; si le plafond baisse, elle suit
  let housingCost = x.housingCostEur;
  const after0 = householdTransfers(pack, p, income1, housingCost);
  if (x.tenure === "owner_mortgage" && p.householdType !== "other") {
    const preTax1 = after0.grossMonthly - after0.tax + after0.benefits - after0.housingAid;
    housingCost = Math.min(housingCost - c.ownerCharges, c.maxMortgageEffort * preTax1) + c.ownerCharges;
  }
  const after = housingCost === x.housingCostEur ? after0 : householdTransfers(pack, p, income1, housingCost);
  const patrimony1 = patrimonyRate * after.grossMonthly;
  const disposable = after.grossMonthly - after.tax + after.benefits + patrimony1;
  const livingStandard = disposable / uc;

  // Dépenses : logement (aide recalculée), courantes (élasticité au niveau de vie), abonnements
  const withParents = p.householdType === "with_parents";
  const preCommitted = withParents ? x.preCommittedEur : x.preCommittedEur - (x.housingCostEur - before.housingAid) + (housingCost - after.housingAid);
  const rel0 = (x.livingStandardEur ?? livingStandard) / median;
  const rel1 = livingStandard / median;
  const scale = (r: number) => Math.pow(clamp(r, 0.3, 4), c.currentIncomeElasticity);
  const current = x.currentExpensesEur * (scale(rel1) / scale(rel0));
  const added = change.subscriptions.reduce((s, t) => s + t.monthlyEur, 0);
  const otherSubs = x.subscriptionsEur + added;
  const budgetHousehold = (withParents ? income1 : disposable) - preCommitted - current - otherSubs;
  const perUnit = budgetHousehold / (withParents ? 1 : uc);

  // Sensibilité au prix : même part aléatoire, termes revenu et tension recalculés
  const pz = ps.priceSensitivity;
  const strainOf = (pu: number) => clamp(1 - pu / Math.max(200, median * 0.4), 0, 1.5);
  const perUnit0 = p.monthlyDiscretionaryBudgetEur > 0 ? p.monthlyDiscretionaryBudgetEur : -(x.monthlyShortfallEur ?? 0);
  const ps0 = clamp(p.priceSensitivity, 0.005, 0.995);
  const noise = Math.log(ps0 / (1 - ps0)) - (pz.intercept + pz.income * Math.log(Math.max(rel0, 0.1)) + pz.strain * strainOf(perUnit0));
  const priceSensitivity = sigmoid(pz.intercept + pz.income * Math.log(Math.max(rel1, 0.1)) + pz.strain * strainOf(perUnit) + noise);

  return {
    ...p,
    monthlyIncomeEur: round(income1),
    householdIncomeEur: round(disposable),
    monthlyDiscretionaryBudgetEur: round(Math.max(0, perUnit)),
    priceSensitivity: Math.round(priceSensitivity * 100) / 100,
    subscriptions: [...p.subscriptions, ...change.subscriptions],
    extra: {
      ...x,
      housingCostEur: round(housingCost),
      housingAidEur: round(after.housingAid),
      incomeTaxEur: round(after.tax),
      benefitsEur: round(after.benefits),
      preCommittedEur: round(preCommitted),
      currentExpensesEur: round(current),
      subscriptionsEur: round(otherSubs),
      livingStandardEur: round(livingStandard),
      monthlyShortfallEur: round(perUnit < 0 ? -perUnit : 0),
      /** Trace du recalcul : modules en cause et valeurs du socle avant. */
      economics: {
        modules: change.modules,
        incomeBefore: income0,
        budgetBefore: p.monthlyDiscretionaryBudgetEur,
        householdIncomeBefore: p.householdIncomeEur,
        ...(change.subscriptions.length && { subscriptions: change.subscriptions.map((s) => s.name) }),
      },
    },
  };
}
