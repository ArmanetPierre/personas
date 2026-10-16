import type { NewPersona, PersonaSubscription } from "../db/schema";
import {
  findBand,
  findBandClamped,
  PCS_CODES,
  ROGERS,
  type ActivityStatus,
  type FrPack,
  type HouseholdType,
  type Pack,
  type PcsCode,
  type Rogers,
  type Sex,
  type SocialUsage,
  type Tenure,
  type TownSize,
} from "./pack";
import { createHash } from "node:crypto";
import { applyModules, socleVars } from "../modules/apply";
import { recomputeEconomics } from "./economics";
import { drawPhase, earnerOverride, moduleEconomics, type ModuleValues } from "../modules/engine";
import type { ResolvedModules } from "../modules/registry";
import { clamp, normalCdf, Rng, sigmoid } from "./rng";
import { asFr } from "./pack";
import { drawSgSocle } from "./countries/sg/sampler";

/**
 * Tirage statistique d'une persona. Chaîne conditionnelle :
 *   âge × sexe → région → taille d'agglomération → prénom (cohorte de naissance)
 *   → situation d'activité | âge × sexe → PCS | âge × sexe → revenu | PCS, âge, sexe
 *   → ménage | âge (conjoint, enfants, parents) → impôt et prestations → niveau de vie
 *   → logement | âge → dépenses pré-engagées et courantes
 *   → profil techno | âge, revenu → équipement et réseaux sociaux | âge (+ profil)
 *   → abonnements | âge, revenu → budget disponible → sensibilité au prix, scepticisme.
 * Aucun appel au LLM : le récit vient après et ne modifie rien.
 */

export interface Earner {
  age: number;
  sex: Sex;
  status: ActivityStatus;
  pcs: PcsCode | null;
  partTime: boolean;
  /** Revenu personnel net mensuel avant impôt sur le revenu. */
  income: number;
  /** Part imposable (salaires, pensions, allocations chômage). */
  taxable: boolean;
}

export interface PersonaExtra extends Record<string, unknown> {
  partTime: boolean;
  partner: { age: number; sex: Sex; status: ActivityStatus; pcs: PcsCode | null; incomeEur: number } | null;
  parents: Array<{ age: number; status: ActivityStatus; incomeEur: number }>;
  childrenAges: number[];
  consumptionUnits: number;
  tenure: Tenure;
  housingCostEur: number;
  housingAidEur: number;
  incomeTaxEur: number;
  benefitsEur: number;
  preCommittedEur: number;
  currentExpensesEur: number;
  subscriptionsEur: number;
  /** Niveau de vie mensuel (revenu disponible / UC). */
  livingStandardEur: number;
  /** Reste-à-vivre négatif ramené à 0 : montant manquant par UC. */
  monthlyShortfallEur: number;
  /** Variable latente d'aisance techno (≈ N(0,1)). */
  techScore: number;
  narrativeTone: string;
  cityHint: string | null;
  /** Attributs des modules activés, par module (voir docs/modules.md). */
  modules?: ModuleValues;
  /** Versions des modules appliqués (v2). */
  moduleVersions?: Record<string, string>;
}

export type DrawnPersona = Omit<NewPersona, "extra" | "subscriptions" | "equipment"> & {
  id: string;
  extra: PersonaExtra;
  subscriptions: PersonaSubscription[];
  equipment: string[];
};

export function personaId(packVersion: string, seed: number, index: number): string {
  return `${packVersion}-s${seed}-${String(index + 1).padStart(4, "0")}`;
}

/** Quantile de la loi normale (algorithme d'Acklam). */
export function probit(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const poly = (k: number[], x: number) => k.reduce((acc, v) => acc * x + v, 0);
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(c, q) / (poly(d, q) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -poly(c, q) / (poly(d, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (poly(a, r) * q) / (poly(b, r) * r + 1);
}

const round = (x: number) => Math.round(x);

/** Situation d'activité, PCS et revenu personnel d'un adulte. */
export function drawEarner(rng: Rng, pack: FrPack, age: number, sex: Sex, opts: { pcs?: PcsCode } = {}): Earner {
  // Conjoints et parents peuvent dépasser 79 ans : on leur applique les tables des 75-79 ans.
  const act = findBandClamped(pack.activity.data.bands, age);
  const a = Math.min(age, act.to);
  const status = rng.weighted(act[sex]);
  const e = pack.earnings.data;
  let pcs: PcsCode | null = null;
  if (status === "employed" || status === "unemployed") {
    pcs = opts.pcs ?? rng.weighted(findBand(pack.pcs.data.employed, a)[sex]);
  } else if (status === "retired") {
    pcs = opts.pcs ?? rng.weighted(pack.pcs.data.retiredFormer[sex]);
  }
  let income = 0;
  let partTime = false;
  let taxable = true;
  switch (status) {
    case "employed": {
      const ln = e.fullTime[pcs!];
      const ageF = findBand(e.ageFactor, a).factor;
      income = rng.logNormal(ln.median * ageF * e.sexFactor[sex], ln.sigma);
      if (pcs !== "1" && pcs !== "2") income = Math.max(income, e.minFullTime);
      partTime = rng.bool(e.partTime[sex]);
      if (partTime) income *= e.partTime.incomeFactor;
      break;
    }
    case "unemployed":
      if (rng.bool(e.unemployment.indemnifiedShare)) {
        income = rng.logNormal(e.unemployment.benefit.median, e.unemployment.benefit.sigma);
      }
      break;
    case "retired": {
      const ln = e.pension[sex];
      income = rng.logNormal(ln.median * e.pensionPcsFactor[pcs!], ln.sigma);
      break;
    }
    case "student":
      income = rng.logNormal(e.student.resources.median, e.student.resources.sigma);
      taxable = false;
      break;
    case "inactive":
      if (rng.bool(e.inactive.withIncomeShare)) income = rng.logNormal(e.inactive.income.median, e.inactive.income.sigma);
      taxable = false;
      break;
  }
  return { age, sex, status, pcs, partTime, income: round(income), taxable };
}

/** Impôt sur le revenu annuel (barème progressif, quotient familial, décote). Simplifié. */
export function incomeTax(pack: FrPack, annualTaxable: number, parts: number, couple: boolean): number {
  const t = pack.taxBenefits.data.incomeTax;
  const net = annualTaxable * (1 - t.abatement);
  const perPart = net / parts;
  let tax = 0;
  let lower = 0;
  for (const b of t.brackets) {
    const upper = b.upTo ?? Infinity;
    if (perPart > lower) tax += (Math.min(perPart, upper) - lower) * b.rate;
    lower = upper;
  }
  tax *= parts;
  const dc = couple ? t.decote.couple : t.decote.single;
  if (tax < dc.threshold) tax = Math.max(0, tax - (dc.base - t.decote.rate * tax));
  return tax;
}

function childAges(rng: Rng, parentAge: number, sex: Sex, n: number, maxAge: number): number[] {
  // Âge du parent à la première naissance ≈ 29 ans (mère) / 32 ans (père), puis 2 à 5 ans d'écart.
  // L'aîné a au moins (n − 1) × 2 ans pour que tous les enfants soient nés, et le parent au moins 18 ans de plus.
  const gaps = Array.from({ length: n - 1 }, () => 2 + rng.next() * 3);
  const span = gaps.reduce((s, g) => s + g, 0);
  const first = clamp(parentAge - (sex === "F" ? 29 : 32) + rng.normal() * 3, span, Math.min(maxAge, parentAge - 18));
  const ages = [Math.round(first)];
  let a = first;
  for (const g of gaps) {
    a = Math.max(0, a - g);
    ages.push(Math.round(a));
  }
  return ages;
}

function drawHousehold(rng: Rng, pack: FrPack, age: number, sex: Sex): HouseholdType {
  return rng.weighted(findBand(pack.household.data.bands, age)[sex]);
}

function drawChildrenCount(rng: Rng, pack: FrPack): number {
  const c = pack.household.data.children;
  const k = rng.weighted({ one: c.one, two: c.two, threePlus: c.threePlus });
  return k === "one" ? 1 : k === "two" ? 2 : rng.bool(0.75) ? 3 : 4;
}

function techThresholds(pack: Pack): Array<[Rogers, number]> {
  // Seuils de la variable latente : parts cumulées de Rogers sur une loi normale.
  const r = pack.psychographics.data.rogers;
  let cum = 0;
  return ROGERS.map((k) => {
    cum += r[k];
    return [k, probit(1 - cum)] as [Rogers, number];
  });
}

export interface DrawOptions {
  /** Modules à appliquer (ciblage) ; par défaut ceux du pack. */
  modules?: ResolvedModules;
}

/** Tire la persona n° `index` du tirage (`seed`, pack). Déterministe. */
export function drawPersona(pack: Pack, seed: number, index: number, opts: DrawOptions = {}): DrawnPersona {
  if (pack.manifest.rngStreams === "module") return drawPersonaV2(pack, seed, index, opts.modules ?? pack.modules);
  return drawSocle(asFr(pack, "Tirage à flux partagé (v1)"), seed, index, pack.modules);
}

/** Socle seul d'un pays (contrat de pack pays : chaque générateur fournit sa chaîne de tirage). */
function drawCountrySocle(pack: Pack, seed: number, index: number): DrawnPersona {
  return pack.kind === "sg" ? drawSgSocle(pack, seed, index) : drawSocle(pack, seed, index, { ordered: [], quasiDims: new Map() });
}

/**
 * v2 : socle seul (aucun module dans la chaîne), puis modules tirés chacun dans leur flux.
 * Les attributs du socle sont ceux du même rang en v1 sans module.
 */
function drawPersonaV2(pack: Pack, seed: number, index: number, modules: ResolvedModules): DrawnPersona {
  const p = drawCountrySocle(pack, seed, index);
  // Sans module : le socle tel quel (aucun recalcul, identifiant inchangé)
  if (!modules.ordered.length) return p;
  if (modules.ordered.some((m) => m.def.socle_overrides?.activity_status)) {
    throw new Error(`Socle ${pack.manifest.version} (flux par module) : un module ne peut pas remplacer la situation professionnelle (seulement le revenu)`);
  }
  const { modules: values, versions } = applyModules(pack, p as DrawnPersona & { seed: number; drawIndex: number }, modules);
  let out: DrawnPersona = { ...p, id: personaIdFor(pack, seed, index, modules), extra: { ...p.extra, modules: values, moduleVersions: versions } };
  // Effets budgétaires déclarés (revenu remplacé, abonnements payés) : recalcul du budget, sans nouveau tirage.
  // Les modules sont tirés sur le socle d'avant ce recalcul.
  const eco = moduleEconomics(modules, values, socleVars(pack, p));
  if (eco) out = recomputeEconomics(pack, out, eco);
  return out;
}

/** Version de référence des modules d'un socle (« 2026.2 » pour fr-2026.2). */
export function baseModuleVersion(pack: Pack): string {
  return pack.manifest.version.replace(/^.*?-(?=\d)/, "");
}

/**
 * Identifiant d'une persona v2 tirée avec des modules. Les modules à la version du socle et sans effet
 * budgétaire ne le changent pas (cache partagé entre études). Un module dans une autre version (ex.
 * numerique@2026.3), ou qui remplace le revenu ou déduit des abonnements, peut donner d'autres valeurs que la
 * persona déjà en base : l'identifiant reçoit alors un suffixe stable `-m<empreinte>` de ces modules, pour ne
 * jamais réécrire une persona existante (règle : docs/modules.md, « Versions et identité »).
 */
export function personaIdFor(pack: Pack, seed: number, index: number, modules: ResolvedModules): string {
  const base = personaId(pack.manifest.version, seed, index);
  const ref = baseModuleVersion(pack);
  // Modules qui peuvent donner d'autres valeurs que celles déjà en base : autre version que le socle,
  // ou effets budgétaires déclarés (revenu remplacé, abonnements déduits), qui modifient le socle.
  const touchesSocle = (m: ResolvedModules["ordered"][number]) =>
    !!m.def.socle_overrides || m.def.attributes.some((a) => a.type === "set" && !!a.affects_budget);
  const changed = modules.ordered.filter((m) => m.def.version !== ref || touchesSocle(m)).map((m) => `${m.def.id}@${m.def.version}`).sort();
  if (!changed.length) return base;
  return `${base}-m${createHash("sha1").update(changed.join(",")).digest("hex").slice(0, 6)}`;
}

function drawSocle(pack: FrPack, seed: number, index: number, modules: ResolvedModules): DrawnPersona {
  const rng = Rng.forPersona(seed, index);
  const m = pack.manifest;

  // Âge × sexe
  const ageBands = pack.ageSex.data.bands;
  const ab = rng.weightedEntry(ageBands.map((b) => [b, b.M + b.F] as const));
  const sex: Sex = rng.bool(ab.F / (ab.M + ab.F)) ? "F" : "M";
  const age = rng.int(ab.from, ab.to);

  // Région → taille d'agglomération → ville de référence pour le récit
  const regions = pack.regions.data.regions;
  const region = rng.weightedEntry(regions.map((r) => [r.code, r.population] as const));
  const townSize = rng.weighted(pack.townSize.data.byRegion[region]!);
  const cityHint = drawCityHint(rng, pack, region, townSize);

  // Prénom (fichier des prénoms, cohorte de naissance)
  const birthYear = m.referenceYear - age;
  const cohort =
    pack.firstNames.data.cohorts.find((c) => c.sex === sex && birthYear >= c.birthFrom && birthYear <= c.birthTo) ??
    pack.firstNames.data.cohorts.filter((c) => c.sex === sex).at(birthYear < 1960 ? 0 : -1)!;
  const firstName = rng.weightedEntry(cohort.names);

  // Activité, PCS, revenu. Un module peut tirer sa propre situation professionnelle (phase « work »)
  // et la substituer à celle du socle (`socle_overrides`, voir docs/modules.md).
  const hasModules = modules.ordered.length > 0;
  const moduleValues: ModuleValues = {};
  if (hasModules) drawPhase(modules, "work", moduleValues, { rng, seed, index, socle: { age, sex, region, town_size: townSize } });
  const override = hasModules ? earnerOverride(modules, moduleValues, sex) : null;
  const self: Earner = override
    ? { age, sex, status: override.activityStatus as ActivityStatus, pcs: override.pcs as PcsCode, partTime: override.partTime, income: override.income, taxable: override.taxable }
    : drawEarner(rng, pack, age, sex);

  // Ménage
  const householdType = drawHousehold(rng, pack, age, sex);
  let partner: Earner | null = null;
  const parents: Earner[] = [];
  let children: number[] = [];
  let otherAdults = 0;
  if (householdType === "couple_no_child" || householdType === "couple_with_children") {
    const pSex: Sex = sex === "F" ? "M" : "F";
    const pAge = Math.round(clamp(age + (sex === "F" ? 2 : -2) + rng.normal() * 4, 18, 85));
    // Homogamie : un conjoint sur trois partage le groupe socioprofessionnel (hypothèse).
    const sameGroup = self.pcs && rng.bool(0.35);
    partner = drawEarner(rng, pack, pAge, pSex, sameGroup ? { pcs: self.pcs! } : {});
  }
  if (householdType === "couple_with_children" || householdType === "single_parent") {
    children = childAges(rng, age, sex, drawChildrenCount(rng, pack), 24);
  }
  if (householdType === "with_parents") {
    const pa = Math.round(clamp(age + 29 + rng.normal() * 4, 40, 90));
    parents.push(drawEarner(rng, pack, pa, "F"));
    if (rng.bool(0.7)) parents.push(drawEarner(rng, pack, Math.round(clamp(pa + 2 + rng.normal() * 3, 40, 92)), "M"));
  }
  if (householdType === "other") otherAdults = 1;

  const adults = 1 + (partner ? 1 : 0) + parents.length + otherAdults;
  const householdSize = adults + children.length;
  // Unités de consommation (échelle OCDE modifiée). « other » (colocation, hébergement chez un tiers) :
  // on ne connaît pas les revenus de l'autre adulte, la persona est traitée comme un budget autonome.
  const uc =
    householdType === "other"
      ? 1
      : 1 + 0.5 * (adults - 1) + children.reduce((s, a) => s + (a >= 14 ? 0.5 : 0.3), 0);

  // Revenus du ménage
  const earners = [self, ...(partner ? [partner] : []), ...parents];
  const grossMonthly = earners.reduce((s, e) => s + e.income, 0);
  const taxableAnnual = earners.filter((e) => e.taxable).reduce((s, e) => s + e.income * 12, 0);
  const couple = partner !== null || parents.length === 2;
  const dependents = householdType === "with_parents" ? [age] : children.filter((a) => a < 21);
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
  // Minima sociaux (simplifiés) : RSA différentiel (hors forfait logement, pas pour les étudiants),
  // minimum vieillesse (ASPA) quand la persona ou son conjoint a 65 ans ou plus, prime d'activité.
  const rsaAdults = householdType === "other" ? 1 : 1 + (partner ? 1 : 0);
  const scale =
    1 +
    (rsaAdults - 1) * tb.rsa.secondAdult +
    children.filter((a) => a < 20).reduce((s, _, i) => s + (i < 2 ? tb.rsa.perChild : tb.rsa.thirdChildOn), 0);
  if (householdType !== "with_parents" && self.status !== "student") {
    const senior = age >= 65 || (partner !== null && partner.age >= 65);
    const floor = senior ? (rsaAdults > 1 ? tb.aspa.couple : tb.aspa.single) : tb.rsa.base * scale;
    const resources = grossMonthly - tax + benefits;
    if (resources < floor) benefits += floor - resources;
    const earned = [self, ...(partner ? [partner] : [])].filter((e) => e.status === "employed").reduce((s, e) => s + e.income, 0);
    if (earned > 0) {
      const pa = tb.activityBonus.base * scale + tb.activityBonus.earnedRate * earned - (grossMonthly - tax + benefits);
      if (pa >= tb.activityBonus.minPayment) benefits += pa;
    }
  }

  // Revenus du patrimoine (intérêts, dividendes, loyers perçus), proportionnels aux revenus et croissants avec l'âge.
  const patrimony = grossMonthly * findBandClamped(tb.patrimonyRate, householdType === "with_parents" ? parents[0]!.age : age).rate * Math.exp(0.8 * rng.normal() - 0.32);

  // Logement
  const hd = pack.housing.data;
  const tenure: Tenure =
    householdType === "with_parents"
      ? rng.weighted(findBandClamped(hd.tenureByAge, parents[0]!.age).shares)
      : age < 30
        ? rng.weighted(hd.youngIndependent)
        : rng.weighted(findBand(hd.tenureByAge, age).shares);
  const c = pack.costs.data;
  const sizeFactor = 1 + c.rentPerExtraPerson * (Math.min(householdSize, 6) - 1);
  let housingCost = 0;
  switch (tenure) {
    case "renter_private":
      housingCost = c.rentPrivate[townSize] * sizeFactor * Math.exp(c.rentSigma * rng.normal());
      break;
    case "renter_social":
      housingCost = c.rentSocial * sizeFactor * Math.exp(c.rentSigma * rng.normal());
      break;
    case "owner_mortgage": {
      const preTax = grossMonthly - tax + benefits;
      housingCost = Math.min(rng.logNormal(c.mortgage.median, c.mortgage.sigma), c.maxMortgageEffort * preTax) + c.ownerCharges;
      break;
    }
    case "owner":
      housingCost = c.ownerCharges;
      break;
    case "free":
      housingCost = 0;
  }
  if (householdType === "other") housingCost /= 2; // logement partagé
  let housingAid = 0;
  if (tenure === "renter_private" || tenure === "renter_social") {
    const ha = tb.housingAid;
    const max = (rsaAdults > 1 ? ha.maxCouple : ha.maxSingle) + ha.perChild * children.length;
    const perUc = (grossMonthly - tax) / uc;
    housingAid = Math.max(0, Math.min(max, housingCost * 0.9) - ha.taperRate * Math.max(0, perUc - ha.floorIncomePerUc) * uc);
    if (householdType === "with_parents") housingAid = 0;
  }
  benefits += housingAid;

  const disposable = grossMonthly - tax + benefits + patrimony;
  const livingStandard = disposable / uc;

  // Profil techno (latente) : baisse avec l'âge, hausse avec le niveau de vie (hypothèse).
  const ps = pack.psychographics.data;
  const median = pack.livingStandard.data.median / 12;
  const ageZ = -(age - ps.tech.pivotAge) / ps.tech.ageScale;
  const incZ = Math.log(Math.max(livingStandard, 200) / median) / ps.tech.incomeScale;
  const wA = ps.tech.ageWeight;
  const wI = ps.tech.incomeWeight;
  const residual = rng.normal();
  const techScore = wA * ageZ + wI * incZ + Math.sqrt(Math.max(0, 1 - wA * wA - wI * wI)) * residual + ps.tech.shift;
  const techAdoption = techThresholds(pack).find(([, t]) => techScore >= t)?.[0] ?? "laggard";
  // Part de la latente indépendante de l'âge : sert à corréler l'équipement au profil sans fausser les marges par âge.
  // equipmentFromResidual (population aisée) : la part revenu décalerait les taux d'équipement cibles ; on ne garde que le résidu.
  const withinAge = ps.equipmentFromResidual ? residual : (wI * incZ + Math.sqrt(Math.max(0, 1 - wA * wA - wI * wI)) * residual) / Math.sqrt(Math.max(1e-6, 1 - wA * wA));
  const rho = ps.equipmentCorrelation;
  const correlatedUniform = () => normalCdf(rho * withinAge + Math.sqrt(1 - rho * rho) * rng.normal());

  // Équipement | âge (+ profil)
  const dig = findBand(pack.digital.data.bands, age);
  const owns = (p: number) => correlatedUniform() > 1 - p;
  const equipment: string[] = [];
  const hasSmartphone = owns(dig.smartphone);
  if (hasSmartphone) equipment.push("smartphone");
  else equipment.push("téléphone mobile simple");
  if (owns(dig.computer)) equipment.push("ordinateur");
  if (owns(dig.tablet)) equipment.push("tablette");
  const hasInternet = owns(dig.internet);
  if (hasInternet) equipment.push("internet à domicile");
  const uSocial = correlatedUniform();
  let socialMediaUsage: SocialUsage = "none";
  if (uSocial > 1 - dig.socialDaily) socialMediaUsage = uSocial > 1 - dig.socialDaily * 0.35 ? "heavy" : "daily";
  else if (uSocial > 1 - dig.socialAny) socialMediaUsage = "occasional";

  // Abonnements | âge, revenu
  const subs: PersonaSubscription[] = [];
  const held = new Set<string>();
  const relIncome = livingStandard / median;
  for (const item of pack.subscriptions.data.items) {
    if (item.requires === "smartphone" && !hasSmartphone) continue;
    if (item.requires === "internet" && !hasInternet) continue;
    if (item.requiresItem && !held.has(item.requiresItem)) continue;
    const base = findBand(item.penetration, age).p;
    const p = clamp(base * Math.pow(relIncome, item.incomeElasticity), 0, 0.99);
    if (!rng.bool(p)) continue;
    const offers = item.offers.filter((o) => !subs.some((s) => s.name === o.name));
    if (!offers.length) continue;
    const offer = rng.weightedEntry(offers.map((o) => [o, o.weight] as const));
    held.add(item.id);
    subs.push({ name: offer.name, category: item.category, monthlyEur: offer.monthlyEur, ...(item.household && { household: true }) });
  }

  // Attributs de modules de la phase « profile » (après équipement et abonnements) ; leurs abonnements
  // éventuels s'ajoutent à ceux du socle et pèsent donc sur le reste-à-vivre.
  if (hasModules) {
    subs.push(
      ...drawPhase(modules, "profile", moduleValues, {
        rng,
        seed,
        index,
        socle: {
          age,
          sex,
          region,
          town_size: townSize,
          household_type: householdType,
          tenure,
          children_under_12: children.filter((a) => a < 12).length,
          partner_status: partner ? (partner.status === "employed" ? "employed" : "not_employed") : "none",
          living_standard_ratio: relIncome,
          monthly_income: self.income,
        },
      }),
    );
  }

  // Dépenses du ménage. Chez ses parents, les abonnements du foyer (box, vidéo partagée) sont payés par eux.
  const paidByPersona = (s: PersonaSubscription) => !(householdType === "with_parents" && s.household);
  const telecom = subs.filter((s) => paidByPersona(s) && (s.category === "téléphonie" || s.category === "internet"));
  const telecomCost = telecom.reduce((s, t) => s + t.monthlyEur * (t.household ? 1 : Math.max(1, adults - otherAdults - parents.length)), 0);
  const otherSubs = subs.filter((s) => paidByPersona(s) && !telecom.includes(s)).reduce((s, t) => s + t.monthlyEur, 0);
  const incomeScale = Math.pow(clamp(relIncome, 0.3, 4), c.currentIncomeElasticity);
  let preCommitted: number;
  let current: number;
  let budgetHousehold: number;
  let budgetUnits: number;
  if (householdType === "with_parents") {
    // Logement et énergie à la charge des parents : la persona paie son téléphone, ses transports,
    // ses abonnements et participe aux courses.
    preCommitted = telecomCost;
    current = (c.foodPerUc * c.withParentsShare + c.transportPerUc[townSize] + c.otherCurrentPerUc * 0.5) * incomeScale;
    budgetHousehold = self.income - preCommitted - current - otherSubs;
    budgetUnits = 1;
  } else {
    preCommitted =
      housingCost - housingAid + c.energyPerHousehold + c.energyPerUc * uc + c.insurancePerHousehold + c.insurancePerUc * uc + telecomCost;
    current = (c.foodPerUc + c.transportPerUc[townSize] + c.otherCurrentPerUc) * uc * incomeScale;
    if (householdType === "other") preCommitted -= (c.energyPerHousehold + c.insurancePerHousehold) / 2;
    budgetHousehold = disposable - preCommitted - current - otherSubs;
    budgetUnits = uc;
  }
  const perUnit = budgetHousehold / budgetUnits;
  const budget = Math.max(0, perUnit);
  const shortfall = perUnit < 0 ? -perUnit : 0;

  // Sensibilité au prix et scepticisme (hypothèses), entre 0 et 1
  const strain = clamp(1 - perUnit / Math.max(200, median * 0.4), 0, 1.5);
  const pz = ps.priceSensitivity;
  const priceSensitivity = sigmoid(pz.intercept + pz.income * Math.log(Math.max(relIncome, 0.1)) + pz.strain * strain + pz.noise * rng.normal());
  const sz = ps.skepticism;
  const skepticism = sigmoid(sz.intercept + sz.age * ((age - 47) / 17) + sz.tech * -techScore + sz.noise * rng.normal());

  // Tonalité du récit : poids de base modulés par les attributs (hypothèse, voir psychographics.json)
  const earlyTech = techAdoption === "innovator" || techAdoption === "early_adopter";
  const modulate: Record<string, number> = {
    tech: earlyTech ? 1.6 : 0.8,
    income: 0.6 + 0.4 * Math.min(2, relIncome),
    busy: self.status === "employed" ? (children.some((a) => a < 18) ? 1.8 : 1) : 0.4,
    skepticism: 0.4 + 1.6 * skepticism,
    strain: 0.6 + strain,
  };
  const tones = ps.tones.map((t) => [t.id, t.weight * (t.modulator ? modulate[t.modulator]! : 1)] as const);
  const narrativeTone = rng.weightedEntry(tones);

  const occupation = override ? override.occupationLabel : occupationLabel(pack, self, sex);

  return {
    id: personaId(m.version, seed, index),
    country: m.country,
    packVersion: m.version,
    seed,
    drawIndex: index,
    firstName,
    age,
    sex,
    region,
    townSize,
    occupation,
    activityStatus: self.status,
    pcs: self.pcs,
    monthlyIncomeEur: round(self.income),
    householdIncomeEur: round(disposable),
    householdSize,
    monthlyDiscretionaryBudgetEur: round(budget),
    householdType,
    techAdoption,
    priceSensitivity: Math.round(priceSensitivity * 100) / 100,
    skepticism: Math.round(skepticism * 100) / 100,
    socialMediaUsage,
    equipment,
    subscriptions: subs,
    extra: {
      partTime: self.partTime,
      partner: partner && { age: partner.age, sex: partner.sex, status: partner.status, pcs: partner.pcs, incomeEur: partner.income },
      parents: parents.map((p) => ({ age: p.age, status: p.status, incomeEur: p.income })),
      childrenAges: children,
      consumptionUnits: Math.round(uc * 10) / 10,
      tenure,
      housingCostEur: round(housingCost),
      housingAidEur: round(housingAid),
      incomeTaxEur: round(tax),
      benefitsEur: round(benefits),
      preCommittedEur: round(preCommitted),
      currentExpensesEur: round(current),
      subscriptionsEur: round(otherSubs),
      livingStandardEur: round(livingStandard),
      monthlyShortfallEur: round(shortfall),
      techScore: Math.round(techScore * 100) / 100,
      narrativeTone,
      cityHint,
      ...(hasModules && { modules: moduleValues }),
    },
  };
}

function drawCityHint(rng: Rng, pack: FrPack, region: string, townSize: TownSize): string | null {
  if (townSize === "uu_paris") return "Paris et son agglomération";
  const sizeClass: Partial<Record<TownSize, number>> = { uu_200k_2m: 7, uu_100k_200k: 6 };
  const sc = sizeClass[townSize];
  if (!sc) return null;
  const units = pack.urbanUnits.data.units.filter((u) => u.region === region && u.sizeClass === sc);
  if (!units.length) return null;
  return rng.weightedEntry(units.map((u) => [u.name.replace(/\s*\(.*?\)/g, ""), u.population] as const));
}

export function occupationLabel(pack: FrPack, e: Earner, sex: Sex): string {
  const f = sex === "F";
  const pcs = e.pcs ? pack.pcs.data.labels[e.pcs][sex] : null;
  switch (e.status) {
    case "employed":
      return pcs! + (e.partTime ? " (temps partiel)" : "");
    case "unemployed":
      return `${f ? "Demandeuse" : "Demandeur"} d'emploi (${pcs!.toLowerCase()})`;
    case "retired":
      return `${f ? "Retraitée" : "Retraité"}, ${f ? "ancienne" : "ancien"} ${pcs!.toLowerCase()}`;
    case "student":
      return f ? "Étudiante" : "Étudiant";
    case "inactive":
      return "Sans activité professionnelle";
  }
}

/** Tire `count` personas (index 0..count-1). */
export function drawPersonas(pack: Pack, seed: number, count: number, start = 0, opts: DrawOptions = {}): DrawnPersona[] {
  const out: DrawnPersona[] = [];
  for (let i = start; i < start + count; i++) out.push(drawPersona(pack, seed, i, opts));
  return out;
}

export { PCS_CODES };
