import type { PersonaSubscription } from "../../../db/schema";
import { findBand, findBandClamped, ROGERS, type ActivityStatus, type HouseholdType, type Rogers, type Sex, type SocialUsage } from "../../pack-common";
import { clamp, normalCdf, Rng, sigmoid } from "../../rng";
import type { DrawnPersona, PersonaExtra } from "../../sampler";
import type { Dwelling, Education, Ethnicity, Residency, SgPack, SgTenure, SsocCode } from "./pack";

/**
 * Tirage statistique d'une persona du socle Singapour (générateur `sg`). Chaîne conditionnelle :
 *   statut de résidence × âge × sexe → secteur (Work Permit) → nationalité, ethnie → religion, langue
 *   → éducation → nom d'usage (ethnie ou nationalité, religion, cohorte) → activité (dont service national)
 *   → profession (SSOC) | éducation, sexe, pass → revenu brut, CPF salarié, revenu net
 *   → ménage | âge, sexe, pass (conjoint, enfants, parents) → logement (planning area × type) | pass
 *   → statut d'occupation → impôt, transferts → dépenses (prêt HDB payé en partie par le CPF, loyers,
 *   S&CC, énergie, alimentation, transport, envois d'argent) → profil techno → équipement, réseaux
 *   sociaux → abonnements → budget disponible → sensibilité au prix, scepticisme, tonalité.
 * Montants en SGD (devise du pack), stockés dans les colonnes historiques en « Eur ».
 * Aucun appel au LLM. Tables et sources : packs/sg/, docs/research/socle-sg.md.
 */

/** Clé de pass utilisée par les tables (le Work Permit est séparé selon le secteur). */
export type PassKey = "ep" | "spass" | "wp_cmp" | "wp_other" | "mdw" | "dependant" | "student";

export interface SgEarner {
  age: number;
  sex: Sex;
  status: ActivityStatus;
  ssoc: SsocCode | null;
  partTime: boolean;
  /** Revenu brut mensuel (travail, pension, allocation). */
  gross: number;
  /** Cotisation salariale CPF (citoyens et PR en emploi). */
  cpf: number;
  /** Revenu net mensuel (brut − CPF salarié). */
  net: number;
  /** Impôt sur le revenu mensualisé. */
  tax: number;
  resident: boolean;
}

const round = (x: number) => Math.round(x);
const isResident = (r: Residency) => r === "citizen" || r === "pr";

export function passKeyOf(residency: Residency, wpSector: "cmp" | "other" | null): PassKey | null {
  if (residency === "citizen" || residency === "pr") return null;
  if (residency === "wp") return wpSector === "cmp" ? "wp_cmp" : "wp_other";
  return residency;
}

/** Taux de cotisation salariale CPF selon l'âge (citoyens et PR). */
export function cpfEmployee(pack: SgPack, age: number, gross: number): number {
  const c = pack.cpf.data;
  if (gross < c.noEmployeeBelow) return 0;
  const rate = findBandClamped(c.employeeRate, age).rate;
  const base = Math.min(gross, c.ordinaryWageCeiling);
  if (gross < c.fullRateFrom) {
    // Taux réduit progressif entre les deux seuils (approximation linéaire de la formule officielle)
    const k = (gross - c.noEmployeeBelow) / Math.max(1, c.fullRateFrom - c.noEmployeeBelow);
    return base * rate * k;
  }
  return base * rate;
}

/** Impôt annuel des résidents fiscaux (barème progressif, abattements forfaitaires). */
export function sgIncomeTax(pack: SgPack, annualGross: number, annualCpf: number): number {
  const t = pack.taxBenefits.data;
  const chargeable = Math.max(0, annualGross - annualCpf - t.reliefs);
  let tax = 0;
  let lower = 0;
  for (const b of t.brackets) {
    const upper = b.upTo ?? Infinity;
    if (chargeable > lower) tax += (Math.min(chargeable, upper) - lower) * b.rate;
    lower = upper;
  }
  return tax;
}

function ssocFor(rng: Rng, pack: SgPack, pass: PassKey | null, education: Education, sex: Sex): SsocCode {
  const o = pack.occupation.data;
  if (pass && pass !== "dependant" && o.byPass[pass]) return rng.weighted(o.byPass[pass]) as SsocCode;
  return rng.weighted((o.residents[education] ?? o.residents.secondary!)[sex]) as SsocCode;
}

/** Revenu d'un adulte (persona, conjoint, parent) selon son statut et son pass. */
export function drawSgEarner(
  rng: Rng,
  pack: SgPack,
  a: { age: number; sex: Sex; status: ActivityStatus; pass: PassKey | null; resident: boolean; education: Education; nationalService?: boolean; ssoc?: SsocCode | null },
): SgEarner {
  const e = pack.earnings.data;
  let ssoc: SsocCode | null = a.ssoc ?? null;
  let gross = 0;
  let partTime = false;
  switch (a.status) {
    case "employed": {
      ssoc ??= ssocFor(rng, pack, a.pass, a.education, a.sex);
      const p = a.pass && a.pass !== "dependant" ? e.passes[a.pass] : undefined;
      if (p) {
        gross = rng.logNormal(p.median, p.sigma);
        if (p.floor !== undefined) gross = Math.max(gross, p.floor + (p.floorAgeStep ?? 0) * Math.max(0, Math.min(a.age, 45) - 23));
      } else {
        const ln = e.fullTime[ssoc];
        gross = rng.logNormal(ln.median * findBandClamped(e.ageFactor, a.age).factor * e.sexFactor[a.sex], ln.sigma);
        partTime = rng.bool(e.partTime[a.sex]);
        if (partTime) gross *= e.partTime.incomeFactor;
      }
      break;
    }
    case "retired": {
      const ln = e.retired[a.education] ?? e.retired.secondary!;
      gross = rng.logNormal(ln.median, ln.sigma);
      break;
    }
    case "student": {
      // Étudiant étranger : soutien de la famille (pass « student ») ; résident : argent de poche, petits boulots
      const ln = a.pass === "student" ? e.passes.student ?? e.student : e.student;
      gross = rng.logNormal(ln.median, ln.sigma);
      break;
    }
    case "unemployed":
      if (rng.bool(e.unemployed.withIncomeShare)) gross = rng.logNormal(e.unemployed.income.median, e.unemployed.income.sigma);
      break;
    case "inactive":
      if (a.nationalService) gross = rng.logNormal(e.nationalService.median, e.nationalService.sigma);
      else if (rng.bool(e.inactive.withIncomeShare)) gross = rng.logNormal(e.inactive.income.median, e.inactive.income.sigma);
      break;
  }
  gross = round(gross);
  const cpf = a.resident && a.status === "employed" ? round(cpfEmployee(pack, a.age, gross)) : 0;
  // Impôt : résidents fiscaux (citoyens, PR, étrangers en poste depuis plus de 183 jours), revenu du travail
  const taxable = a.status === "employed" ? gross * 12 : 0;
  const tax = round(sgIncomeTax(pack, taxable, cpf * 12) / 12);
  return { age: a.age, sex: a.sex, status: a.status, ssoc, partTime, gross, cpf, net: gross - cpf, tax, resident: a.resident };
}

function childAges(rng: Rng, parentAge: number, firstBirthAge: number, n: number, maxAge: number): number[] {
  const gaps = Array.from({ length: n - 1 }, () => 2 + rng.next() * 3);
  const span = gaps.reduce((s, g) => s + g, 0);
  const first = clamp(parentAge - firstBirthAge + rng.normal() * 3, span, Math.min(maxAge, parentAge - 18));
  const ages = [Math.round(first)];
  let x = first;
  for (const g of gaps) {
    x = Math.max(0, x - g);
    ages.push(Math.round(x));
  }
  return ages;
}

function probit(p: number): number {
  // Inverse de normalCdf par dichotomie (suffisant pour 5 seuils de Rogers)
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function techThresholds(pack: SgPack): Array<[Rogers, number]> {
  const r = pack.psychographics.data.rogers;
  let cum = 0;
  return ROGERS.map((k) => {
    cum += r[k];
    return [k, probit(1 - cum)] as [Rogers, number];
  });
}

/** Planning area et type de logement d'un résident : effectifs croisés de la table, modulés par l'âge. */
function residentHome(rng: Rng, pack: SgPack, age: number, only?: Dwelling[]): { area: string; dwelling: Dwelling } {
  const g = pack.geography.data;
  const factors = g.residentDwellingAgeFactor ? findBandClamped(g.residentDwellingAgeFactor, age).factors : null;
  const entries: Array<readonly [{ area: string; dwelling: Dwelling }, number]> = [];
  for (const a of g.areas) {
    for (const [d, n] of Object.entries(a.residents) as Array<[Dwelling, number]>) {
      if (only && !only.includes(d)) continue;
      const f = factors ? (factors as Record<string, number>)[d] ?? 1 : 1;
      if (n > 0) entries.push([{ area: a.code, dwelling: d }, n * f]);
    }
  }
  return rng.weightedEntry(entries);
}

function foreignHome(rng: Rng, pack: SgPack, pass: PassKey): { area: string; dwelling: Dwelling } {
  const g = pack.geography.data;
  const dwelling = rng.weighted(g.foreignDwelling[pass] ?? g.foreignDwelling.ep!) as Dwelling;
  if (dwelling === "dormitory") return { area: rng.weighted(g.dormitoryAreas), dwelling };
  if (pass === "mdw") {
    // Employée de maison : logée chez l'employeur, dont le logement suit la part des ménages employeurs par type
    const w = pack.household.data.mdwByDwelling;
    const entries: Array<readonly [{ area: string; dwelling: Dwelling }, number]> = [];
    for (const a of g.areas) for (const [d, n] of Object.entries(a.residents) as Array<[Dwelling, number]>) if (n > 0) entries.push([{ area: a.code, dwelling: d }, n * ((w as Record<string, number>)[d] ?? 0)]);
    return rng.weightedEntry(entries);
  }
  return { area: residentHome(rng, pack, 35, [dwelling]).area, dwelling };
}

export function drawSgSocle(pack: SgPack, seed: number, index: number): DrawnPersona {
  const rng = Rng.forPersona(seed, index);
  const m = pack.manifest;
  const R = pack.residency.data;

  // Statut de résidence × âge × sexe
  const cells: Array<readonly [{ status: Residency; sector: "cmp" | "other" | null; from: number; to: number; sex: Sex }, number]> = [];
  for (const st of R.statuses) for (const b of st.bands) for (const sex of ["M", "F"] as const) if (b[sex] > 0) cells.push([{ status: st.code, sector: st.sector ?? null, from: b.from, to: b.to, sex }, b[sex]]);
  const cell = rng.weightedEntry(cells);
  const residency = cell.status;
  const sex: Sex = cell.sex;
  const age = rng.int(Math.max(cell.from, m.ageMin), Math.min(cell.to, m.ageMax));
  const resident = isResident(residency);
  const wpSector = residency === "wp" ? (cell.sector ?? "other") : null;
  const pass = passKeyOf(residency, wpSector);

  // Nationalité et ethnie, religion, langue
  const E = pack.ethnicity.data;
  let ethnicity: Ethnicity;
  let nationality: string | null = null;
  let nameGroup: string;
  if (resident) {
    ethnicity = rng.weighted(findBandClamped(E.residents[residency as "citizen" | "pr"], age).shares) as Ethnicity;
    nameGroup = ethnicity;
  } else {
    nationality = rng.weighted(E.byPass[pass!] ?? E.byPass.ep!);
    const nat = E.nationalities.find((n) => n.code === nationality)!;
    ethnicity = rng.weighted(nat.ethnicityByPass?.[pass!] ?? nat.ethnicity) as Ethnicity;
    nameGroup = nat.namesByPass?.[pass!] ?? nat.namesByEthnicity?.[ethnicity] ?? nat.names;
  }
  const religion = rng.weighted(pack.religion.data.byGroup[nationality ?? ""] ?? pack.religion.data.byGroup[ethnicity]!);
  const L = pack.language.data;
  const homeLanguage = resident || !L.byNationality[nationality!]
    ? rng.weighted(findBandClamped(L.byEthnicityAge[ethnicity] ?? L.byEthnicityAge.others!, age).shares)
    : rng.weighted(L.byNationality[nationality!]!);
  const Ed = pack.education.data;
  const education = rng.weighted(resident || !Ed.byPass[pass!] ? findBandClamped(Ed.residents, age).shares : Ed.byPass[pass!]!) as Education;

  // Nom d'usage : groupe (ethnie ou nationalité), religion, sexe, cohorte de naissance. Dans un groupe, les
  // cohortes qui déclarent la religion tirée passent en premier, sinon celles sans religion (défaut du
  // groupe). Sans cohorte déclarant de religion (sg-2026.1), le choix est celui du groupe seul.
  const birthYear = m.referenceYear - age;
  const forReligion = <C extends { religions?: string[] }>(cs: C[]): C[] => {
    const tagged = cs.filter((c) => c.religions?.includes(religion));
    return tagged.length ? tagged : cs.filter((c) => !c.religions);
  };
  const inGroup = (g: string) => forReligion(pack.firstNames.data.cohorts.filter((c) => c.sex === sex && (c.group ?? "") === g));
  const cohorts = inGroup(nameGroup);
  const pool = cohorts.length ? cohorts : inGroup(ethnicity);
  const cohort = pool.find((c) => birthYear >= c.birthFrom && birthYear <= c.birthTo) ?? pool.at(birthYear < 1970 ? 0 : -1)!;
  const firstName = rng.weightedEntry(cohort.names);

  // Activité (service national des jeunes hommes citoyens et PR)
  const A = pack.activity.data;
  let status: ActivityStatus;
  let nationalService = false;
  if (resident) {
    const ns = sex === "M" ? A.nationalService.find((b) => age >= b.from && age <= b.to) : undefined;
    if (ns && rng.bool(ns.share)) {
      nationalService = true;
      status = "inactive";
    } else status = rng.weighted(findBandClamped(A.residents, age)[sex]);
  } else if (pass === "dependant") status = rng.bool(A.dependantEmployed[sex]) ? "employed" : "inactive";
  else if (pass === "student") status = "student";
  else status = "employed";
  const self = drawSgEarner(rng, pack, { age, sex, status, pass, resident, education, nationalService });

  // Ménage
  const H = pack.household.data;
  let householdType: HouseholdType = resident ? rng.weighted(findBandClamped(H.residents, age)[sex]) : (rng.weighted(H.byPass[pass!] ?? H.byPass.ep!) as HouseholdType);
  if (nationalService && householdType !== "with_parents" && rng.bool(0.8)) householdType = "with_parents";
  let partner: SgEarner | null = null;
  const parents: SgEarner[] = [];
  let children: number[] = [];
  let otherAdults = 0;
  if (householdType === "couple_no_child" || householdType === "couple_with_children") {
    const pSex: Sex = sex === "F" ? "M" : "F";
    const pAge = Math.round(clamp(age + (sex === "F" ? 3 : -3) + rng.normal() * 4, 18, 85));
    // Conjoint : un dépendant vit avec un titulaire d'EP ou de S Pass ; un EP ou S Pass, avec un dépendant (ou un actif)
    const pPass: PassKey | null = pass === "dependant" ? (rng.bool(0.8) ? "ep" : "spass") : pass === "ep" || pass === "spass" ? "dependant" : resident ? null : pass;
    const pResident = resident;
    const pStatus: ActivityStatus = pPass === "ep" || pPass === "spass" ? "employed" : pPass === "dependant" ? (rng.bool(A.dependantEmployed[pSex]) ? "employed" : "inactive") : rng.weighted(findBandClamped(A.residents, pAge)[pSex]);
    partner = drawSgEarner(rng, pack, { age: pAge, sex: pSex, status: pStatus, pass: pPass, resident: pResident, education });
  }
  if (householdType === "couple_with_children" || householdType === "single_parent") {
    const c = H.children;
    const k = rng.weighted({ one: c.one, two: c.two, threePlus: c.threePlus });
    const n = k === "one" ? 1 : k === "two" ? 2 : rng.bool(0.8) ? 3 : 4;
    children = childAges(rng, age, H.firstBirthAge[sex], n, 30);
  }
  if (householdType === "with_parents") {
    const pa = Math.round(clamp(age + 30 + rng.normal() * 4, 40, 92));
    const momStatus: ActivityStatus = rng.weighted(findBandClamped(A.residents, pa).F);
    parents.push(drawSgEarner(rng, pack, { age: pa, sex: "F", status: momStatus, pass: null, resident: true, education: pa >= 60 ? "below_secondary" : "secondary" }));
    if (rng.bool(0.8)) {
      const da = Math.round(clamp(pa + 3 + rng.normal() * 3, 40, 95));
      parents.push(drawSgEarner(rng, pack, { age: da, sex: "M", status: rng.weighted(findBandClamped(A.residents, da).M), pass: null, resident: true, education: da >= 60 ? "below_secondary" : "secondary" }));
    }
  }
  if (householdType === "other") otherAdults = 1;

  // Logement : planning area × type ; dortoir, employeur, location pour les étrangers
  const home = resident ? residentHome(rng, pack, householdType === "with_parents" ? parents[0]!.age : age) : foreignHome(rng, pack, pass!);
  const dwelling = home.dwelling;
  const area = home.area;
  const region = pack.areaRegion(area);
  const liveIn = pass === "mdw";
  const inDorm = dwelling === "dormitory";
  // En dortoir, la famille éventuelle vit au pays : ménage de personnes non apparentées
  if (inDorm && householdType !== "other") {
    householdType = "other";
    partner = null;
    children = [];
  }

  // Statut d'occupation
  const Hs = pack.housing.data;
  let tenure: SgTenure;
  if (inDorm || liveIn || householdType === "with_parents") tenure = "free";
  else if (resident) {
    tenure = rng.weighted(Hs.residentTenure[dwelling as keyof typeof Hs.residentTenure] ?? Hs.residentTenure.other);
    if (tenure === "owner" && rng.bool(findBandClamped(Hs.mortgageByAge, age).share)) tenure = "owner_mortgage";
  } else {
    tenure = rng.weighted(Hs.foreignTenure[pass!] ?? Hs.foreignTenure.ep!);
    // Un étranger ne peut pas acheter de HDB : propriétaire seulement dans le privé
    if ((tenure === "owner" || tenure === "owner_mortgage") && dwelling.startsWith("hdb_")) tenure = "renter_private";
    if (tenure === "owner" && rng.bool(findBandClamped(Hs.mortgageByAge, age).share)) tenure = "owner_mortgage";
  }

  // Composition et unités de consommation (échelle OCDE modifiée)
  const adults = 1 + (partner ? 1 : 0) + parents.length + otherAdults;
  const householdSize = adults + children.length;
  const uc = householdType === "other" ? 1 : 1 + 0.5 * (adults - 1) + children.reduce((s, a) => s + (a >= 14 ? 0.5 : 0.3), 0);

  // Revenus du ménage, impôt, transferts
  const earners = [self, ...(partner ? [partner] : []), ...parents];
  const netMonthly = earners.reduce((s, e) => s + e.net, 0);
  const tax = earners.reduce((s, e) => s + e.tax, 0);
  const T = pack.taxBenefits.data;
  let transfers = 0;
  if (resident) {
    const perCapita = (netMonthly - tax) / Math.max(1, householdSize);
    const cuts = T.householdTransfers.cuts;
    const q = cuts.findIndex((c) => perCapita < c);
    // Chez ses parents, seule la part de la persona compte (le reste est le budget des parents)
    transfers += T.householdTransfers.perMember[q === -1 ? 4 : q]! * (householdType === "with_parents" ? 1 : householdSize);
    const seniors = earners.filter((e) => e.resident && e.age >= T.silverSupport.fromAge).length;
    if (seniors && perCapita <= T.silverSupport.maxIncomePerCapita && dwelling !== "condo" && dwelling !== "landed") transfers += seniors * T.silverSupport.monthly;
    for (const e of [self, ...(partner ? [partner] : [])]) if (e.resident && e.status === "employed" && e.age >= T.workfare.fromAge && e.gross <= T.workfare.maxIncome) transfers += T.workfare.monthly;
  }
  // Enfants adultes au foyer (fréquent à Singapour) : participation aux dépenses du ménage
  const familySupport = children.filter((a) => a >= 22).length * pack.costs.data.adultChildContribution;
  const disposable = netMonthly - tax + transfers + familySupport;
  const livingStandard = disposable / uc;

  // Logement : part payée en espèces (le prêt HDB est surtout payé par le compte CPF ordinaire)
  const C = pack.costs.data;
  const cpf = pack.cpf.data;
  const hdb = dwelling.startsWith("hdb_");
  let housingCost = 0;
  let housingTotal = 0;
  switch (tenure) {
    case "owner_mortgage": {
      const ln = C.mortgage[dwelling as keyof typeof C.mortgage] ?? C.mortgage.hdb_4;
      housingTotal = rng.logNormal(ln.median, ln.sigma);
      const cpfShare = resident ? (hdb ? cpf.hdbLoanCpfShare : cpf.privateLoanCpfShare) : 0;
      housingCost = housingTotal * (1 - cpfShare);
      break;
    }
    case "renter_private": {
      const shared = householdType === "alone" || householdType === "other";
      const ln = pass === "wp_cmp" || pass === "wp_other" ? C.rentShared : shared && (hdb || !resident) ? C.rentRoom : C.rentWhole[dwelling as keyof typeof C.rentWhole] ?? C.rentWhole.hdb_4;
      housingTotal = housingCost = rng.logNormal(ln.median, ln.sigma);
      break;
    }
    case "renter_social":
      housingTotal = housingCost = rng.logNormal(C.rentSocial.median, C.rentSocial.sigma);
      break;
    default:
      housingTotal = housingCost = 0;
  }
  const ownHome = !inDorm && !liveIn && householdType !== "with_parents";
  const dwellingKey = (dwelling === "dormitory" ? "other" : dwelling) as keyof typeof C.utilities;
  // Charges : S&CC ou charges de copropriété pour les propriétaires (comprises dans le loyer sinon), énergie et eau pour tous
  const owner = tenure === "owner" || tenure === "owner_mortgage";
  const roomShare = tenure === "renter_private" && (householdType === "alone" || householdType === "other") ? 0.4 : 1;
  const charges = ownHome ? (owner ? C.conservancy[dwellingKey] : 0) + roomShare * C.utilities[dwellingKey] : 0;

  // Profil techno (latente) : même modèle que la France, médiane du pack
  const ps = pack.psychographics.data;
  const median = pack.livingStandard.data.median / 12;
  const ageZ = -(age - ps.tech.pivotAge) / ps.tech.ageScale;
  const incZ = Math.log(Math.max(livingStandard, 200) / median) / ps.tech.incomeScale;
  const wA = ps.tech.ageWeight;
  const wI = ps.tech.incomeWeight;
  const residual = rng.normal();
  const techScore = wA * ageZ + wI * incZ + Math.sqrt(Math.max(0, 1 - wA * wA - wI * wI)) * residual + ps.tech.shift;
  const techAdoption = techThresholds(pack).find(([, t]) => techScore >= t)?.[0] ?? "laggard";
  const withinAge = ps.equipmentFromResidual ? residual : (wI * incZ + Math.sqrt(Math.max(0, 1 - wA * wA - wI * wI)) * residual) / Math.sqrt(Math.max(1e-6, 1 - wA * wA));
  const rho = ps.equipmentCorrelation;
  const correlatedUniform = () => normalCdf(rho * withinAge + Math.sqrt(1 - rho * rho) * rng.normal());

  const dig = findBandClamped(pack.digital.data.bands, age);
  const owns = (p: number) => correlatedUniform() > 1 - p;
  const equipment: string[] = [];
  const hasSmartphone = owns(dig.smartphone);
  equipment.push(hasSmartphone ? "smartphone" : "basic mobile phone");
  if (owns(dig.computer * (inDorm || liveIn ? 0.3 : 1))) equipment.push("computer");
  if (owns(dig.tablet * (inDorm || liveIn ? 0.3 : 1))) equipment.push("tablet");
  const hasInternet = inDorm || liveIn ? hasSmartphone : owns(dig.internet);
  if (hasInternet) equipment.push(inDorm ? "dormitory wifi" : liveIn ? "employer's home wifi" : "home internet");
  const uSocial = correlatedUniform();
  let socialMediaUsage: SocialUsage = "none";
  if (uSocial > 1 - dig.socialDaily) socialMediaUsage = uSocial > 1 - dig.socialDaily * 0.35 ? "heavy" : "daily";
  else if (uSocial > 1 - dig.socialAny) socialMediaUsage = "occasional";

  // Abonnements | âge, revenu (pas d'abonnement de foyer pour qui ne paie pas le foyer)
  const subs: PersonaSubscription[] = [];
  const held = new Set<string>();
  const relIncome = livingStandard / median;
  for (const item of pack.subscriptions.data.items) {
    if (item.requires === "smartphone" && !hasSmartphone) continue;
    if (item.requires === "internet" && !hasInternet) continue;
    if (item.requiresItem && !held.has(item.requiresItem)) continue;
    if (item.household && !ownHome) continue;
    const base = findBand(item.penetration, age).p;
    const p = clamp(base * Math.pow(relIncome, item.incomeElasticity), 0, 0.99);
    if (!rng.bool(p)) continue;
    const offers = item.offers.filter((o) => !subs.some((s) => s.name === o.name));
    if (!offers.length) continue;
    const offer = rng.weightedEntry(offers.map((o) => [o, o.weight] as const));
    held.add(item.id);
    subs.push({ name: offer.name, category: item.category, monthlyEur: offer.monthlyEur, ...(item.household && { household: true }) });
  }
  const telecom = subs.filter((s) => s.category === "mobile" || s.category === "internet").reduce((s, t) => s + t.monthlyEur * (t.household ? 1 : Math.max(1, adults - otherAdults - parents.length)), 0);
  const otherSubs = subs.filter((s) => s.category !== "mobile" && s.category !== "internet").reduce((s, t) => s + t.monthlyEur, 0);

  // Envois d'argent au pays (étrangers) : dépense contrainte
  // (part réduite quand la persona paie son logement : la part sourcée vaut pour les logés par l'employeur)
  // (rien quand le conjoint vit à Singapour : la famille proche est ici)
  const remittance = pass && !partner ? self.net * (C.remittanceShare[pass] ?? 0) * (housingCost > 0 && (pass === "wp_cmp" || pass === "wp_other") ? 0.6 : 1) : 0;
  const incomeScale = Math.pow(clamp(relIncome, 0.3, 4), C.currentIncomeElasticity);
  const car = ownHome && rng.bool(clamp(C.carShareByDwelling[dwellingKey] * clamp(Math.pow(Math.max(relIncome, 0.1), 0.3), 0.7, 1.3) * (resident ? 1 : 0.3), 0, 0.95)) ? rng.logNormal(C.carMonthly.median, C.carMonthly.sigma) : 0;
  let preCommitted: number;
  let current: number;
  let budgetHousehold: number;
  let budgetUnits: number;
  if (inDorm || liveIn) {
    // Logé par l'employeur : dépenses propres (repas hors fournis, téléphone, transport), envois d'argent
    preCommitted = telecom + remittance;
    current = (inDorm ? C.dormitoryLiving : C.liveInLiving) * Math.pow(clamp(self.net / 1000, 0.5, 2), 0.3);
    budgetHousehold = self.net - self.tax - preCommitted - current - otherSubs;
    budgetUnits = 1;
  } else if (pass === "wp_cmp" || pass === "wp_other" || pass === "student") {
    // Travailleurs Work Permit en colocation et étudiants étrangers : budget individuel, dépenses frugales
    // (repas partagés, transports en commun, pass étudiant), loyer d'un lit ou d'une chambre
    preCommitted = housingCost + roomShare * C.utilities[dwellingKey] + telecom + remittance;
    current = C.dormitoryLiving * (pass === "student" ? 2 : 1.3) * Math.pow(clamp(self.net / 1000, 0.5, 2), 0.3);
    budgetHousehold = self.net - self.tax - preCommitted - current - otherSubs;
    budgetUnits = 1;
  } else if (householdType === "with_parents") {
    // Chez ses parents : participation au foyer, téléphone, transports, repas, abonnements
    // (les parents paient le logement et l'essentiel des repas ; étudiants et NSF : transport réduit, pas d'assurance propre)
    const dependentYoung = self.status === "student" || nationalService;
    preCommitted = telecom + self.net * C.withParentsContribution + remittance;
    current = (C.foodPerUc * 0.3 + C.transportPerUc * (dependentYoung ? 0.4 : 1) + C.otherCurrentPerUc * 0.4 + (dependentYoung ? 0 : C.healthInsurancePerUc)) * incomeScale;
    budgetHousehold = self.net - self.tax - preCommitted - current - otherSubs;
    budgetUnits = 1;
  } else {
    preCommitted = housingCost + charges + C.healthInsurancePerUc * uc + telecom + remittance;
    current = (C.foodPerUc + C.transportPerUc + C.otherCurrentPerUc * (age >= 65 ? 0.7 : 1)) * uc * incomeScale + car;
    budgetHousehold = disposable - preCommitted - current - otherSubs;
    budgetUnits = uc;
  }
  const perUnit = budgetHousehold / budgetUnits;
  const budget = Math.max(0, perUnit);
  const shortfall = perUnit < 0 ? -perUnit : 0;

  // Sensibilité au prix, scepticisme, tonalité : mêmes formules que la France
  const strain = clamp(1 - perUnit / Math.max(200, median * 0.4), 0, 1.5);
  const pz = ps.priceSensitivity;
  const priceSensitivity = sigmoid(pz.intercept + pz.income * Math.log(Math.max(relIncome, 0.1)) + pz.strain * strain + pz.noise * rng.normal());
  const sz = ps.skepticism;
  const skepticism = sigmoid(sz.intercept + sz.age * ((age - 47) / 17) + sz.tech * -techScore + sz.noise * rng.normal());
  const earlyTech = techAdoption === "innovator" || techAdoption === "early_adopter";
  const modulate: Record<string, number> = {
    tech: earlyTech ? 1.6 : 0.8,
    income: 0.6 + 0.4 * Math.min(2, relIncome),
    busy: self.status === "employed" ? (children.some((a) => a < 18) ? 1.8 : 1) : 0.4,
    skepticism: 0.4 + 1.6 * skepticism,
    strain: 0.6 + strain,
  };
  const narrativeTone = rng.weightedEntry(ps.tones.map((t) => [t.id, t.weight * (t.modulator ? modulate[t.modulator]! : 1)] as const));

  const extra: PersonaExtra & Record<string, unknown> = {
    partTime: self.partTime,
    partner: partner && { age: partner.age, sex: partner.sex, status: partner.status, pcs: partner.ssoc as never, incomeEur: partner.net },
    parents: parents.map((p) => ({ age: p.age, status: p.status, incomeEur: p.net })),
    childrenAges: children,
    consumptionUnits: Math.round(uc * 10) / 10,
    tenure: tenure as never,
    housingCostEur: round(housingCost),
    housingAidEur: 0,
    incomeTaxEur: round(tax),
    benefitsEur: round(transfers),
    preCommittedEur: round(preCommitted),
    currentExpensesEur: round(current),
    subscriptionsEur: round(otherSubs),
    livingStandardEur: round(livingStandard),
    monthlyShortfallEur: round(shortfall),
    techScore: Math.round(techScore * 100) / 100,
    narrativeTone,
    cityHint: null,
    // Propres au socle Singapour
    residency,
    ...(pass && { pass }),
    nationality,
    ethnicity,
    religion,
    homeLanguage,
    education,
    dwelling,
    grossIncomeEur: self.gross,
    cpfEmployeeEur: self.cpf,
    selfIncomeTaxEur: self.tax,
    ...(housingTotal !== housingCost && { housingTotalEur: round(housingTotal) }),
    ...(remittance > 0 && { remittanceEur: round(remittance) }),
    ...(car > 0 && { carEur: round(car) }),
    ...(nationalService && { nationalService: true }),
    ...(liveIn && { liveIn: true }),
  };

  return {
    id: `${m.version}-s${seed}-${String(index + 1).padStart(4, "0")}`,
    country: m.country,
    packVersion: m.version,
    seed,
    drawIndex: index,
    firstName,
    age,
    sex,
    region,
    townSize: area,
    occupation: occupationLabelSg(pack, self, pass, wpSector, nationalService),
    activityStatus: self.status,
    pcs: self.ssoc,
    monthlyIncomeEur: round(self.net),
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
    extra,
  };
}

const PASS_SUFFIX: Record<PassKey, string> = {
  ep: "",
  spass: "",
  wp_cmp: "",
  wp_other: "",
  mdw: "",
  dependant: "",
  student: "",
};

/** Libellé de la situation, en anglais (la ligne « Residency » de la fiche porte le pass). */
export function occupationLabelSg(pack: SgPack, e: SgEarner, pass: PassKey | null, wpSector: "cmp" | "other" | null, nationalService: boolean): string {
  void PASS_SUFFIX;
  void wpSector;
  const occ = e.ssoc ? pack.occupation.data.labels[e.ssoc] : null;
  if (nationalService) return "Full-time National Serviceman (NSF)";
  if (pass === "mdw") return "Live-in domestic worker";
  switch (e.status) {
    case "employed":
      return occ! + (e.partTime ? " (part-time)" : "");
    case "unemployed":
      return "Unemployed, looking for work";
    case "retired":
      return occ ? `Retired, former ${occ.toLowerCase()}` : "Retired";
    case "student":
      return "Student";
    case "inactive":
      return pass === "dependant" ? "Not working (accompanying a spouse on a work pass)" : "Not in paid work (homemaker or other)";
  }
}
