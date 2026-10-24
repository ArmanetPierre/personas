import type { PersonaSubscription } from "../../../db/schema";
import { findBand, findBandClamped, ROGERS, type ActivityStatus, type HouseholdType, type Rogers, type Sex, type SocialUsage } from "../../pack-common";
import { clamp, normalCdf, Rng, sigmoid } from "../../rng";
import type { DrawnPersona, PersonaExtra } from "../../sampler";
import type { ClassOfWorker, HealthInsurance, Nativity, Race, UsDwelling, UsEducation, UsOccupation, UsPack, UsTenure } from "./pack";

/**
 * Tirage statistique d'une persona du socle États-Unis (générateur `us`). Chaîne conditionnelle :
 *   âge × sexe → État (adultes de 18 à 79 ans) → zone urbaine ou rurale | État → race et origine hispanique
 *   | État, âge → nativité | race → langue parlée à la maison | race, nativité → diplôme | âge, sexe, race
 *   → nom (prénom | groupe, génération ; nom de famille | groupe) → études en cours, activité | âge, sexe,
 *   diplôme → profession (SOC) | diplôme, sexe → statut de l'emploi → revenu brut | profession, sexe, âge,
 *   diplôme → ménage (conjoint, enfants, parents) → statut d'occupation | âge, race, revenu → type de
 *   logement → coût du logement | État → impôt fédéral, FICA, impôt de l'État, crédits (EITC, CTC), SNAP
 *   → assurance santé | âge, emploi, revenu, État → voitures, prêt étudiant, garde d'enfants, dépenses
 *   courantes → profil techno, équipement, abonnements → budget → sensibilité au prix, scepticisme, tonalité.
 * Montants en USD (devise du pack), stockés dans les colonnes historiques en « Eur ».
 * Aucun appel au LLM. Tables et sources : packs/us/, docs/research/socle-us.md.
 */

export interface UsEarner {
  age: number;
  sex: Sex;
  status: ActivityStatus;
  occupation: UsOccupation | null;
  classOfWorker: ClassOfWorker | null;
  partTime: boolean;
  /** Revenu brut mensuel (salaire, revenu d'indépendant, pension, allocation). */
  gross: number;
  /** Part du brut soumise à l'impôt fédéral (pensions et Social Security en partie). */
  taxableShare: number;
  /** Revenu du travail (salaire ou revenu d'indépendant) : base de la FICA et de l'EITC. */
  earned: number;
  /** FICA (Social Security et Medicare) payée par la personne, mensuelle. */
  fica: number;
}

/** Foyer fiscal : déclaration commune des couples mariés, sinon déclaration individuelle. */
export interface UsTaxUnit {
  filing: "single" | "joint" | "head_of_household";
  /** Revenus annuels : brut imposable, revenu du travail (EITC, ACTC). */
  taxable: number;
  earned: number;
  /** Enfants de moins de 17 ans (CTC), enfants à charge (EITC, au plus 3). */
  kidsUnder17: number;
  kids: number;
  seniors: number;
  youngestAdultAge: number;
  oldestAdultAge: number;
}

const round = (x: number) => Math.round(x);
const monthly = (annual: number) => annual / 12;

/** FICA mensuelle d'un salarié (ou d'un indépendant : double part sur 92,35 % du revenu). */
export function usFica(pack: UsPack, earnedMonthly: number, selfEmployed: boolean): number {
  const f = pack.tax.data.fica;
  const annual = earnedMonthly * 12 * (selfEmployed ? f.selfEmployedFactor : 1);
  const k = selfEmployed ? 2 : 1;
  const ss = Math.min(annual, f.wageBase) * f.socialSecurityRate * k;
  const med = annual * f.medicareRate * k + Math.max(0, annual - f.additionalThresholdSingle) * f.additionalMedicareRate;
  return monthly(ss + med);
}

function bracketTax(brackets: Array<{ upTo: number | null; rate: number }>, x: number): number {
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    const upper = b.upTo ?? Infinity;
    if (x > lower) tax += (Math.min(x, upper) - lower) * b.rate;
    lower = upper;
  }
  return tax;
}

export interface UsTaxResult {
  /** Impôt fédéral avant crédits remboursables, après CTC non remboursable (annuel). */
  federal: number;
  /** Impôt de l'État (annuel). */
  state: number;
  /** Crédits remboursables versés (EITC, part remboursable du CTC), annuels. */
  eitc: number;
  actc: number;
}

/** Impôt fédéral 2026 (barème, déduction standard et déduction des seniors, CTC, EITC) et impôt de l'État. */
export function usIncomeTax(pack: UsPack, u: UsTaxUnit, stateRate: number): UsTaxResult {
  const t = pack.tax.data;
  const joint = u.filing === "joint";
  const sd = t.standardDeduction;
  const base = joint ? sd.joint : u.filing === "head_of_household" ? sd.headOfHousehold : sd.single;
  const phase = joint ? sd.seniorPhaseOutJoint : sd.seniorPhaseOutSingle;
  const senior = Math.max(0, u.seniors * sd.seniorDeduction - 0.06 * Math.max(0, u.taxable - phase));
  const deduction = base + u.seniors * sd.extra65 + senior;
  const taxableIncome = Math.max(0, u.taxable - deduction);
  const brackets = joint ? t.brackets.joint : t.brackets.single;
  let federal = bracketTax(brackets, taxableIncome);
  // Head of household : barème simple, déduction plus forte (approximation documentée)
  const c = t.childTaxCredit;
  const ctcMax = Math.max(0, u.kidsUnder17 * c.perChild - c.phaseOutRate * Math.max(0, u.taxable - (joint ? c.phaseOutJoint : c.phaseOutSingle)));
  const nonRefundable = Math.min(federal, ctcMax);
  federal -= nonRefundable;
  const actc = Math.min(ctcMax - nonRefundable, u.kidsUnder17 * c.refundableMax, c.refundableRate * Math.max(0, u.earned - c.refundableFloor));
  // EITC (sans enfant : 25 à 64 ans)
  let eitc = 0;
  const e = t.eitc.find((x) => x.children === Math.min(3, u.kids));
  if (e && u.earned > 0 && (u.kids > 0 || (u.youngestAdultAge >= 25 && u.oldestAdultAge <= 64))) {
    const phaseIn = Math.min(e.maxCredit, e.phaseInRate * u.earned);
    const start = joint ? e.phaseOutJoint : e.phaseOutSingle;
    eitc = Math.max(0, phaseIn - e.phaseOutRate * Math.max(0, Math.max(u.earned, u.taxable) - start));
  }
  const state = stateRate * taxableIncome;
  return { federal, state, eitc, actc: Math.max(0, actc) };
}

/** Seuil de pauvreté fédéral annuel d'un ménage. */
export function povertyLine(pack: UsPack, size: number): number {
  const p = pack.tax.data.poverty;
  return p.base + p.perPerson * Math.max(0, size - 1);
}

/** SNAP mensuel d'un ménage (règle simplifiée : revenu brut < 130 % du seuil, 30 % du revenu net déduit). */
export function snapBenefit(pack: UsPack, size: number, grossMonthly: number, earnedMonthly: number): number {
  const s = pack.tax.data.snap;
  if (grossMonthly > (s.grossLimitPoverty * povertyLine(pack, size)) / 12) return 0;
  const max = size <= s.maxAllotment.length ? s.maxAllotment[size - 1]! : s.maxAllotment.at(-1)! + s.perExtraPerson * (size - s.maxAllotment.length);
  const net = Math.max(0, grossMonthly - 0.2 * earnedMonthly - s.standardDeduction);
  return Math.max(0, max - s.benefitReduction * net);
}

function occupationFor(rng: Rng, pack: UsPack, education: UsEducation, sex: Sex): UsOccupation {
  const o = pack.occupation.data.byEducationSex;
  return rng.weighted((o[education] ?? o.high_school!)[sex]) as UsOccupation;
}

/** Revenu d'un adulte (persona, conjoint, parent) selon son statut. */
export function drawUsEarner(rng: Rng, pack: UsPack, a: { age: number; sex: Sex; status: ActivityStatus; education: UsEducation; occupation?: UsOccupation | null }): UsEarner {
  const e = pack.earnings.data;
  let occupation: UsOccupation | null = a.occupation ?? null;
  let classOfWorker: ClassOfWorker | null = null;
  let gross = 0;
  let earned = 0;
  let partTime = false;
  let taxableShare = 1;
  switch (a.status) {
    case "employed": {
      occupation ??= occupationFor(rng, pack, a.education, a.sex);
      classOfWorker = rng.weighted(pack.occupation.data.classOfWorker[occupation]) as ClassOfWorker;
      const ln = e.fullTime[occupation][a.sex];
      const sigma = classOfWorker === "self_employed" ? Math.sqrt(ln.sigma ** 2 + e.selfEmployedSigma ** 2) : ln.sigma;
      // Log-normale asymétrique : dispersion plus faible sous la médiane (salaire minimum, temps plein)
      const z = rng.normal();
      gross = ln.median * findBandClamped(e.ageFactor, a.age).factor * e.educationFactor[a.education] * Math.exp(z * (z < 0 ? Math.min(sigma, e.lowerSigma) : sigma));
      partTime = rng.bool(e.partTime[a.sex] * (a.age >= 65 ? 1.8 : a.age < 25 ? 1.6 : 1));
      if (partTime) gross *= e.partTime.incomeFactor;
      earned = gross;
      break;
    }
    case "retired": {
      const ln = e.retired[a.education];
      gross = rng.logNormal(ln.median * (a.age < 62 ? 0.8 : 1), ln.sigma);
      taxableShare = 0.6;
      break;
    }
    case "student":
      if (rng.bool(e.student.withIncomeShare)) earned = gross = rng.logNormal(e.student.income.median, e.student.income.sigma);
      break;
    case "unemployed":
      if (rng.bool(e.unemployed.withIncomeShare)) gross = rng.logNormal(e.unemployed.income.median, e.unemployed.income.sigma);
      break;
    case "inactive":
      // Pensions d'invalidité (SSDI, SSI) surtout : peu imposées
      if (rng.bool(e.inactive.withIncomeShare)) gross = rng.logNormal(e.inactive.income.median, e.inactive.income.sigma);
      taxableShare = 0.3;
      break;
  }
  gross = round(gross);
  earned = round(earned);
  const fica = round(usFica(pack, earned, classOfWorker === "self_employed"));
  return { age: a.age, sex: a.sex, status: a.status, occupation, classOfWorker, partTime, gross, taxableShare, earned, fica };
}

function childAges(rng: Rng, parentAge: number, firstBirthAge: number, n: number, maxAge: number): number[] {
  const gaps = Array.from({ length: n - 1 }, () => 1.5 + rng.next() * 3.5);
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
  let lo = -8;
  let hi = 8;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function techThresholds(pack: UsPack): Array<[Rogers, number]> {
  const r = pack.psychographics.data.rogers;
  let cum = 0;
  return ROGERS.map((k) => {
    cum += r[k];
    return [k, probit(1 - cum)] as [Rogers, number];
  });
}

/** Normalise des poids pondérés par un facteur (garde la masse de la case de référence). */
function reweight<K extends string>(base: Readonly<Record<K, number>>, factor: (k: K) => number): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of Object.keys(base) as K[]) out[k] = base[k] * factor(k);
  return out;
}

/** Foyer fiscal d'adultes (persona et conjoint marié) ; enfants à charge. */
function taxUnitOf(earners: UsEarner[], filing: UsTaxUnit["filing"], kids: number[]): UsTaxUnit {
  return {
    filing,
    taxable: earners.reduce((s, e) => s + e.gross * e.taxableShare, 0) * 12,
    earned: earners.reduce((s, e) => s + e.earned, 0) * 12,
    kidsUnder17: kids.filter((a) => a < 17).length,
    kids: kids.filter((a) => a < 19).length,
    seniors: earners.filter((e) => e.age >= 65).length,
    youngestAdultAge: Math.min(...earners.map((e) => e.age)),
    oldestAdultAge: Math.max(...earners.map((e) => e.age)),
  };
}

export function drawUsSocle(pack: UsPack, seed: number, index: number): DrawnPersona {
  const rng = Rng.forPersona(seed, index);
  const m = pack.manifest;

  // Âge × sexe
  const cells: Array<readonly [{ from: number; to: number; sex: Sex }, number]> = [];
  for (const b of pack.ageSex.data.bands) for (const sex of ["M", "F"] as const) cells.push([{ from: b.from, to: b.to, sex }, b[sex]]);
  const cell = rng.weightedEntry(cells);
  const sex = cell.sex;
  const age = rng.int(Math.max(cell.from, m.ageMin), Math.min(cell.to, m.ageMax));

  // État, zone, race, nativité, langue, diplôme
  const G = pack.geography.data;
  const st = rng.weightedEntry(G.states.map((s) => [s, s.adults] as const));
  const urbanicity = rng.bool(st.rural) ? "rural" : "urban";
  const R = pack.race.data;
  const af = findBandClamped(R.ageFactor, age).factors;
  const race = rng.weighted(reweight(R.byState[st.code]!, (k) => af[k as Race])) as Race;
  const nativity = rng.weighted(pack.nativity.data.byRace[race]) as Nativity;
  const foreign = nativity !== "us_born";
  const homeLanguage = rng.weighted(pack.language.data.byGroup[`${race}:${foreign ? "foreign_born" : "us_born"}`]!);
  const Ed = pack.education.data;
  const rf = Ed.raceFactor[race];
  const eduBase = findBandClamped(Ed.byAgeSex, age)[sex];
  const education = rng.weighted(reweight(eduBase, (k) => rf[k as UsEducation])) as UsEducation;

  // Nom : prénom | groupe (race, nés à l'étranger pour les Hispanic et les Asian), sexe, génération ; nom | groupe
  const birthYear = m.referenceYear - age;
  // Asian : origine (Inde et Asie du Sud, Chine, Philippines, Vietnam, Corée, Japon, autres), qui oriente les noms
  const origins = pack.surnames.data.asianOrigins;
  const asianOrigin = race === "asian" && origins ? rng.weighted(origins) : null;
  const group = foreign && race === "hispanic" ? "hispanic_foreign_born" : foreign && race === "asian" ? `asian_foreign_born${asianOrigin ? `:${asianOrigin}` : ""}` : race;
  const pool = pack.firstNames.data.cohorts.filter((c) => c.sex === sex && c.group === group);
  const cohort = pool.find((c) => birthYear >= c.birthFrom && birthYear <= c.birthTo) ?? pool.at(birthYear < 1970 ? 0 : -1)!;
  const given = rng.weightedEntry(cohort.names);
  const surnames = pack.surnames.data.groups[asianOrigin ? `asian:${asianOrigin}` : race] ?? pack.surnames.data.groups[race] ?? pack.surnames.data.groups.white!;
  const firstName = `${given} ${rng.weightedEntry(surnames)}`;

  // Études en cours, activité (le diplôme module l'emploi et les études)
  const A = pack.activity.data;
  const eduMix = reweight(eduBase, (k) => rf[k as UsEducation]);
  const mixTotal = Object.values(eduMix).reduce((s: number, v) => s + (v as number), 0);
  const avg = (f: Record<string, number>) => (Object.entries(eduMix) as Array<[string, number]>).reduce((s, [k, v]) => s + (v / mixTotal) * (f[k] ?? 1), 0);
  const enrolled = clamp((findBandClamped(A.enrolled, age)[sex] * A.educationEnrollment[education]) / avg(A.educationEnrollment), 0, 0.95);
  let status: ActivityStatus;
  if (rng.bool(enrolled)) status = "student";
  else {
    const act = findBandClamped(A.byAgeSex, age)[sex];
    const empF = age >= 25 && age < 65 ? A.educationEmployment[education] / avg(A.educationEmployment) : 1;
    const employed = clamp(act.employed * empF, 0, 0.97);
    const rest = 1 - act.employed;
    const k = rest > 0 ? (1 - employed) / rest : 0;
    const s3 = rng.weighted({ employed, unemployed: act.unemployed * k, nilf: act.nilf * k });
    status = s3 === "nilf" ? (rng.bool(findBandClamped(A.retiredShareOfNilf, age).share) ? "retired" : "inactive") : s3;
  }
  const self = drawUsEarner(rng, pack, { age, sex, status, education });

  // Ménage
  const H = pack.household.data;
  const householdType: HouseholdType = rng.weighted(findBandClamped(H.types, age)[sex]);
  let partner: UsEarner | null = null;
  let married = false;
  const parents: UsEarner[] = [];
  let children: number[] = [];
  let otherAdults = 0;
  const A3 = (a: number, s: Sex): ActivityStatus => {
    const act = findBandClamped(A.byAgeSex, a)[s];
    const x = rng.weighted(act);
    return x === "nilf" ? (rng.bool(findBandClamped(A.retiredShareOfNilf, a).share) ? "retired" : "inactive") : x;
  };
  if (householdType === "couple_no_child" || householdType === "couple_with_children") {
    const pSex: Sex = rng.bool(0.02) ? sex : sex === "F" ? "M" : "F";
    const pAge = Math.round(clamp(age + (sex === "F" ? 2 : -2) + rng.normal() * 4, 18, 85));
    married = rng.bool(findBandClamped(H.marriedShareOfCouples, age).share);
    // Homogamie : diplôme du conjoint proche de celui de la persona
    const pEdu = rng.bool(H.sameEducationPartner) ? education : (rng.weighted(findBandClamped(Ed.byAgeSex, pAge)[pSex]) as UsEducation);
    partner = drawUsEarner(rng, pack, { age: pAge, sex: pSex, status: A3(pAge, pSex), education: pEdu });
  }
  if (householdType === "couple_with_children" || householdType === "single_parent") {
    const c = H.children;
    const k = rng.weighted({ one: c.one, two: c.two, threePlus: c.threePlus });
    const n = k === "one" ? 1 : k === "two" ? 2 : rng.bool(0.75) ? 3 : 4;
    children = childAges(rng, age, H.firstBirthAge[sex], n, 17);
  }
  if (householdType === "with_parents") {
    const pa = Math.round(clamp(age + 29 + rng.normal() * 5, 38, 95));
    parents.push(drawUsEarner(rng, pack, { age: pa, sex: "F", status: A3(pa, "F"), education: rng.weighted(findBandClamped(Ed.byAgeSex, pa).F) as UsEducation }));
    if (rng.bool(0.7)) {
      const da = Math.round(clamp(pa + 2 + rng.normal() * 3, 38, 97));
      parents.push(drawUsEarner(rng, pack, { age: da, sex: "M", status: A3(da, "M"), education: rng.weighted(findBandClamped(Ed.byAgeSex, da).M) as UsEducation }));
    }
  }
  if (householdType === "other") otherAdults = 1 + (rng.bool(0.35) ? 1 : 0);
  // Enfant adulte au foyer (fréquent après 45 ans) : ses revenus comptent dans ceux du ménage
  const adultChildren: UsEarner[] = [];
  if ((householdType === "couple_no_child" || householdType === "couple_with_children" || householdType === "single_parent") && rng.bool(findBandClamped(H.adultChildAtHome, age).share)) {
    const ca = Math.round(clamp(age - H.firstBirthAge[sex] - 2 + rng.normal() * 4, 18, 34));
    const cs: Sex = rng.bool(0.55) ? "M" : "F";
    const ce = rng.weighted(findBandClamped(Ed.byAgeSex, ca)[cs]) as UsEducation;
    adultChildren.push(drawUsEarner(rng, pack, { age: ca, sex: cs, status: rng.bool(findBandClamped(A.enrolled, ca)[cs]) ? "student" : A3(ca, cs), education: ce }));
  }
  // Revenus du patrimoine du ménage (intérêts, dividendes, loyers perçus)
  const PI = H.propertyIncome;
  const coupleGross = self.gross + (partner?.gross ?? 0);
  const pProp = clamp(PI.base + (age >= 45 ? PI.olderBonus : 0) + PI.incomeSlope * Math.log(Math.max(0.2, coupleGross / 7000)), 0, PI.max);
  const propertyIncome = householdType !== "with_parents" && rng.bool(pProp) ? round(rng.logNormal(PI.amount.median * Math.pow(Math.max(0.3, coupleGross / 7000), PI.incomeElasticity), PI.amount.sigma)) : 0;

  const adults = 1 + (partner ? 1 : 0) + parents.length + adultChildren.length + otherAdults;
  const householdSize = adults + children.length;
  const ownHome = householdType !== "with_parents";
  // Unités de consommation (échelle OCDE modifiée) ; colocation : budget individuel
  const uc = householdType === "other" ? 1 : 1 + 0.5 * (adults - 1) + children.reduce((s, a) => s + (a >= 14 ? 0.5 : 0.3), 0);

  // Impôts, FICA, crédits : persona (et conjoint marié) ; conjoint non marié et parents déclarent seuls
  const ps = pack.psychographics.data;
  const median = pack.livingStandard.data.median / 12;
  const stateRate = st.stateTaxRate;
  const unitMembers = [self, ...(partner && married ? [partner] : [])];
  const filing: UsTaxUnit["filing"] = unitMembers.length === 2 ? "joint" : householdType === "single_parent" ? "head_of_household" : "single";
  const unit = taxUnitOf(unitMembers, filing, children);
  unit.taxable += propertyIncome * 12;
  const t1 = usIncomeTax(pack, unit, stateRate);
  const others: UsEarner[] = [...(partner && !married ? [partner] : []), ...parents, ...adultChildren];
  let otherTax = 0;
  let otherCredits = 0;
  for (const o of others) {
    const r = usIncomeTax(pack, taxUnitOf([o], "single", []), stateRate);
    otherTax += monthly(r.federal + r.state);
    otherCredits += monthly(r.eitc + r.actc);
  }
  const earners = [self, ...(partner ? [partner] : []), ...parents, ...adultChildren];
  const grossHh = earners.reduce((s, e) => s + e.gross, 0) + propertyIncome;
  const earnedHh = earners.reduce((s, e) => s + e.earned, 0);
  const fica = earners.reduce((s, e) => s + e.fica, 0);
  const tax = monthly(t1.federal + t1.state) + otherTax;
  const selfTax = monthly(t1.federal + t1.state) * (unitMembers.length === 2 ? self.gross / Math.max(1, self.gross + partner!.gross) : 1);
  const credits = monthly(t1.eitc + t1.actc) + otherCredits;
  // SNAP : ménage entier (hors persona chez ses parents, dont le budget est individuel), taux de recours
  const snapSize = householdType === "other" ? 1 : householdSize;
  const snapGross = householdType === "other" ? self.gross : grossHh;
  const snapEarned = householdType === "other" ? self.earned : earnedHh;
  const snapRaw = ownHome ? snapBenefit(pack, snapSize, snapGross, snapEarned) : 0;
  const snap = snapRaw > 0 && rng.bool(pack.tax.data.snap.participation) ? snapRaw : 0;
  const transfers = credits + snap;
  const householdGross = householdType === "other" ? self.gross + propertyIncome : grossHh;
  const disposable = (householdType === "other" ? self.gross + propertyIncome - self.fica - selfTax : grossHh - fica - tax) + transfers;
  const livingStandard = disposable / uc;
  const relIncome = livingStandard / median;
  const povertyRatio = (householdGross * 12) / povertyLine(pack, householdType === "other" ? 1 : householdSize);

  // Statut d'occupation et logement
  const Hs = pack.housing.data;
  let tenure: UsTenure;
  if (!ownHome) tenure = "free";
  else {
    const base = findBandClamped(Hs.ownerByAge, age).share;
    const odds = (base / (1 - base)) * Hs.ownerRaceOdds[race] * Math.exp(Hs.ownerIncomeSlope * Math.log(clamp(relIncome, 0.15, 6))) * (householdType === "other" ? 0.25 : householdType === "alone" ? 0.7 : 1.25) * (urbanicity === "rural" ? 1.5 : 1);
    if (rng.bool(odds / (1 + odds))) tenure = rng.bool(findBandClamped(Hs.mortgageByAge, age).share) ? "owner_mortgage" : "owner";
    else if (relIncome < Hs.social.maxRelativeIncome && rng.bool(Hs.social.share)) tenure = "renter_social";
    else tenure = rng.bool(Hs.noCashRent) ? "free" : "renter_private";
  }
  const owner = tenure === "owner" || tenure === "owner_mortgage";
  const dw = owner ? Hs.dwellingByTenure.owner : Hs.dwellingByTenure.renter;
  const mobileF = Math.pow(clamp(relIncome, 0.5, 4), -Hs.mobileHomeIncomeExponent);
  const dwelling = rng.weighted(reweight(dw, (k) => (urbanicity === "rural" ? Hs.ruralDwellingFactor[k as UsDwelling] : 1) * (k === "mobile_home" ? mobileF : 1))) as UsDwelling;
  // Coût du logement (charges, taxes foncières, assurance et énergie compris, comme dans l'ACS)
  const rural = (urbanicity === "rural" ? Hs.ruralCostFactor : 1) * Hs.dwellingCostFactor[dwelling];
  const costScale = Math.pow(clamp(relIncome, 0.3, 5), Hs.incomeElasticity) * rural;
  const ownerScale = Math.pow(clamp(relIncome, 0.3, 5), Hs.ownerIncomeElasticity) * rural;
  let housingCost = 0;
  switch (tenure) {
    case "owner_mortgage":
      housingCost = rng.logNormal(st.ownerCostsMortgage * ownerScale, Hs.ownerCostSigma);
      break;
    case "owner":
      housingCost = rng.logNormal(st.ownerCostsNoMortgage * ownerScale, Hs.ownerCostSigma);
      break;
    case "renter_private":
      housingCost = rng.logNormal(st.medianGrossRent * costScale * (householdType === "alone" ? 0.85 : 1), Hs.rentSigma) * (householdType === "other" ? pack.costs.data.roommateRentShare : 1);
      break;
    case "renter_social":
      housingCost = Math.max(Hs.social.minRent, Hs.social.rentIncomeShare * householdGross);
      break;
    default:
      housingCost = 0;
  }
  if (tenure !== "renter_social") housingCost = Math.min(housingCost, Math.max(Hs.social.minRent * 4, Hs.maxCostShare * householdGross));

  // Assurance santé
  const He = pack.health.data;
  const coverage = (e: UsEarner, spouseEmployer: boolean): HealthInsurance => {
    if (e.age >= 65) return "medicare";
    // SSDI (antécédents de travail requis) : Medicare après 24 mois ; les jeunes invalides relèvent du SSI et de Medicaid
    if (e.status === "inactive" && e.gross > 0 && e.age >= 30 && rng.bool(0.45)) return "medicare";
    if (e.status === "employed") {
      const p = e.classOfWorker === "self_employed" ? He.employerSelfEmployed : e.partTime ? He.employerPartTime : He.employerFullTime;
      if (rng.bool(clamp(p + He.employerIncomeSlope * Math.log(clamp(povertyRatio / 3, 0.2, 5)), 0.02, 0.97))) return "employer";
    }
    if (e.status === "retired" && rng.bool(He.retireeEmployer)) return "employer";
    if (spouseEmployer && rng.bool(He.spouseCoverage)) return "employer";
    if (householdType === "with_parents" && e.age < 26 && parents.some((x) => x.status === "employed") && rng.bool(He.parentsPlanUnder26)) return "employer";
    if (rng.bool(He.military)) return "military";
    if (povertyRatio < He.medicaidMaxPoverty && rng.bool(st.medicaidExpansion ? He.medicaidTakeUp : He.medicaidNonExpansion * (children.length || e.status === "inactive" ? 2 : 0.4))) return "medicaid";
    if (rng.bool(clamp(He.marketplace * (povertyRatio >= 1 && povertyRatio <= 4 ? 1.3 : 0.6) * (e.classOfWorker === "self_employed" ? 1.6 : 1), 0, 0.9))) return "marketplace";
    return "uninsured";
  };
  const partnerCov = partner ? coverage(partner, false) : null;
  const healthInsurance = coverage(self, partnerCov === "employer");
  // Coût mensuel pour le budget : persona (et conjoint, hors chez les parents) ; supplément famille
  // Marketplace : prime nette croissante avec le revenu (crédit d'impôt) ; Medicare des bas revenus : primes payées
  // par Medicaid (Medicare Savings Programs, « dual eligibles »)
  const lowIncomeMedicare = povertyRatio < 1.35;
  const healthCostOf = (h: HealthInsurance) =>
    h === "medicare" && lowIncomeMedicare ? He.outOfPocket.medicaid * 2 : He.premium[h] * (h === "marketplace" ? clamp(povertyRatio / 3, 0.3, 2.5) : 1) + He.outOfPocket[h];
  const familyExtra = healthInsurance === "employer" && (partnerCov === "employer" || children.length) ? He.familyPremiumExtra : 0;
  const healthCost = healthCostOf(healthInsurance) + (partner && partnerCov ? healthCostOf(partnerCov) - (partnerCov === "employer" && healthInsurance === "employer" ? He.premium.employer : 0) : 0) + familyExtra;

  // Voitures, prêt étudiant, garde d'enfants
  const C = pack.costs.data;
  const noCar = clamp((owner ? C.noVehicle.owner : C.noVehicle.renter) * (urbanicity === "rural" ? C.noVehicle.ruralFactor : 1) * (relIncome < 0.5 ? 1.8 : relIncome > 2 ? 0.5 : 1), 0, 0.9);
  const vehicles = ownHome ? (rng.bool(noCar) ? 0 : 1 + (adults - otherAdults >= 2 && rng.bool(C.secondVehicle) ? 1 : 0)) : rng.bool(age < 22 ? 0.45 : 0.7) ? 1 : 0;
  let car = 0;
  for (let i = 0; i < vehicles; i++) car += rng.logNormal(C.vehicleRunning.median, C.vehicleRunning.sigma) * (age < 25 ? 1.3 : 1);
  const carLoan = vehicles > 0 && rng.bool(C.carLoan.share * (relIncome < 0.4 ? 0.6 : 1));
  if (carLoan) car += rng.logNormal(C.carLoan.payment.median, C.carLoan.payment.sigma);
  const loanP = findBandClamped(C.studentLoan.byAge, age).share * C.studentLoan.educationFactor[education];
  const hasStudentLoan = rng.bool(clamp(loanP, 0, 0.8));
  const studentLoan = hasStudentLoan && status !== "student" && rng.bool(0.55) ? rng.logNormal(C.studentLoan.payment.median, C.studentLoan.payment.sigma) : 0;
  const allWork = [self, ...(partner ? [partner] : [])].every((e) => e.status === "employed");
  const childcare = children.filter((a) => a < 5).length && allWork && rng.bool(C.childcare.share) ? children.filter((a) => a < 5).length * rng.logNormal(C.childcare.monthly.median, C.childcare.monthly.sigma) : 0;

  // Profil techno (même modèle que la France), équipement, réseaux sociaux
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
  if (owns(dig.computer)) equipment.push("computer");
  if (owns(dig.tablet)) equipment.push("tablet");
  const hasInternet = owns(dig.internet);
  if (hasInternet) equipment.push("home internet");
  const uSocial = correlatedUniform();
  let socialMediaUsage: SocialUsage = "none";
  if (uSocial > 1 - dig.socialDaily) socialMediaUsage = uSocial > 1 - dig.socialDaily * 0.4 ? "heavy" : "daily";
  else if (uSocial > 1 - dig.socialAny) socialMediaUsage = "occasional";

  // Abonnements | âge, revenu (pas d'abonnement de foyer pour qui vit chez ses parents)
  const subs: PersonaSubscription[] = [];
  const held = new Set<string>();
  for (const item of pack.subscriptions.data.items) {
    if (item.requires === "smartphone" && !hasSmartphone) continue;
    if (item.requires === "internet" && !hasInternet) continue;
    if (item.requiresItem && !held.has(item.requiresItem)) continue;
    if (item.household && !ownHome) continue;
    const p = clamp(findBand(item.penetration, age).p * Math.pow(relIncome, item.incomeElasticity), 0, 0.99);
    if (!rng.bool(p)) continue;
    const offers = item.offers.filter((o) => !subs.some((s) => s.name === o.name));
    if (!offers.length) continue;
    const offer = rng.weightedEntry(offers.map((o) => [o, o.weight] as const));
    held.add(item.id);
    subs.push({ name: offer.name, category: item.category, monthlyEur: offer.monthlyEur, ...(item.household && { household: true }) });
  }
  const payers = Math.max(1, adults - otherAdults - parents.length - adultChildren.length);
  const telecom = subs.filter((s) => s.category === "mobile" || s.category === "internet").reduce((s, t) => s + t.monthlyEur * (t.household ? 1 : payers), 0);
  const otherSubs = subs.filter((s) => s.category !== "mobile" && s.category !== "internet").reduce((s, t) => s + t.monthlyEur, 0);

  // Budget disponible : revenu disponible − dépenses contraintes − dépenses courantes − abonnements
  const incomeScale = Math.pow(clamp(relIncome, 0.3, 4), C.currentIncomeElasticity);
  let preCommitted: number;
  let current: number;
  let budgetHousehold: number;
  let budgetUnits: number;
  if (!ownHome) {
    // Chez ses parents : participation au foyer, téléphone, voiture, santé, repas pris dehors, abonnements
    const selfNet = self.gross - self.fica - selfTax + monthly(t1.eitc + t1.actc);
    // Étudiants et moins de 22 ans : les parents paient le plus souvent le forfait, l'assurance et la voiture
    const supported = self.status === "student" || age < 22 ? 0.3 : 1;
    preCommitted = (telecom + healthCostOf(healthInsurance) * (healthInsurance === "employer" && self.status !== "employed" ? 0.2 : 1) + car) * supported + Math.max(0, selfNet) * C.withParentsContribution + studentLoan;
    current = (C.foodPerUc * 0.3 + C.otherCurrentPerUc * 0.45 + (vehicles ? 0 : C.transitPerUc)) * incomeScale;
    budgetHousehold = selfNet - preCommitted - current - otherSubs;
    budgetUnits = 1;
  } else {
    preCommitted = housingCost + healthCost + telecom + car + studentLoan + childcare;
    current = (C.foodPerUc + C.otherCurrentPerUc * (age >= 65 ? 0.8 : 1) + (vehicles ? 0 : C.transitPerUc)) * uc * incomeScale;
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
    partner: partner && { age: partner.age, sex: partner.sex, status: partner.status, pcs: partner.occupation as never, incomeEur: partner.gross - partner.fica },
    parents: parents.map((p) => ({ age: p.age, status: p.status, incomeEur: p.gross - p.fica })),
    ...(adultChildren.length && { adultChildren: adultChildren.map((c) => ({ age: c.age, sex: c.sex, status: c.status, incomeEur: c.gross - c.fica })) }),
    ...(propertyIncome > 0 && { propertyIncomeEur: propertyIncome }),
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
    // Propres au socle États-Unis
    state: st.code,
    division: st.division,
    urbanicity,
    race,
    ...(asianOrigin && { asianOrigin }),
    nativity,
    homeLanguage,
    education,
    dwelling,
    married,
    ...(self.classOfWorker && { classOfWorker: self.classOfWorker }),
    healthInsurance,
    healthCostEur: round(healthCost),
    grossIncomeEur: self.gross,
    householdGrossEur: round(householdGross),
    payrollTaxEur: self.fica,
    selfIncomeTaxEur: round(selfTax),
    taxUnit: unit,
    vehicles,
    ...(car > 0 && { carEur: round(car) }),
    ...(carLoan && { carLoan: true }),
    ...(hasStudentLoan && { studentLoan: true, studentLoanEur: round(studentLoan) }),
    ...(childcare > 0 && { childcareEur: round(childcare) }),
    ...(snap > 0 && { snapEur: round(snap) }),
    ...(t1.eitc > 0 && { eitcEur: round(monthly(t1.eitc)) }),
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
    region: st.region,
    townSize: st.code,
    occupation: occupationLabelUs(pack, self),
    activityStatus: self.status,
    pcs: self.occupation,
    monthlyIncomeEur: round(self.gross - self.fica),
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

const CLASS_SUFFIX: Record<ClassOfWorker, string> = { private: "", nonprofit: ", nonprofit sector", government: ", public sector", self_employed: ", self-employed" };

/** Libellé de la situation, en anglais. */
export function occupationLabelUs(pack: UsPack, e: UsEarner): string {
  const occ = e.occupation ? pack.occupation.data.labels[e.occupation] : null;
  switch (e.status) {
    case "employed":
      return occ! + (e.classOfWorker ? CLASS_SUFFIX[e.classOfWorker] : "") + (e.partTime ? " (part-time)" : "");
    case "unemployed":
      return "Unemployed, looking for work";
    case "retired":
      return "Retired";
    case "student":
      return e.earned > 0 ? "Student, with a part-time job" : "Student";
    case "inactive":
      return e.gross > 0 ? "Not working (disability benefits)" : "Not in paid work (homemaker, caregiver or other)";
  }
}
