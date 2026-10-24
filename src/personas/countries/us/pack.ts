import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { resolveModules, type ResolvedModules } from "../../../modules/registry";
import {
  ageSexTable,
  band,
  byAgeSex,
  digitalTable,
  firstNamesTable,
  HOUSEHOLD_TYPES,
  livingStandardTable,
  logNormal,
  manifestSchema,
  psychographicsTable,
  record,
  regionsTable,
  share,
  subscriptionsTable,
  table,
} from "../../pack-common";
import { packDir, packSocle } from "../../pack-source";
import {
  CLASS_OF_WORKER,
  HEALTH_INSURANCE,
  NATIVITY,
  RACES,
  US_DIVISIONS,
  US_DWELLINGS,
  US_EDUCATION,
  US_HOME_LANGUAGES,
  US_OCCUPATIONS,
  US_REGIONS,
  US_STATES,
} from "./codes";

/**
 * Pack États-Unis (générateur `us`) : tables communes du contrat de pack pays plus les tables propres aux
 * États-Unis (États, race et origine hispanique, nativité, langue, diplôme, professions SOC, impôt fédéral et
 * FICA, impôt des États, assurance santé, logement…). Sources et approximations : docs/research/socle-us.md.
 */

export * from "./codes";

const shares = <K extends readonly [string, ...string[]]>(keys: K) => record(keys, share);
const ACTIVITY3 = ["employed", "unemployed", "nilf"] as const;

export const usPackSchema = z.object({
  manifest: manifestSchema,
  ageSex: ageSexTable,
  regions: regionsTable,
  livingStandard: livingStandardTable,
  digital: digitalTable,
  subscriptions: subscriptionsTable,
  psychographics: psychographicsTable,
  firstNames: firstNamesTable,
  surnames: table(
    z.object({
      groups: z.record(z.string(), z.array(z.tuple([z.string(), z.number().positive()])).min(1)),
      /** Origines des personas Asian (poids ACS B02015) : groupes de noms « asian:<origine> », prénoms « asian_foreign_born:<origine> ». */
      asianOrigins: z.record(z.string(), z.number().positive()).optional(),
    }),
  ),
  geography: table(
    z.object({
      regionLabels: record(US_REGIONS, z.string()),
      divisionLabels: record(US_DIVISIONS, z.string()),
      states: z.array(
        z.object({
          code: z.enum(US_STATES),
          name: z.string(),
          region: z.enum(US_REGIONS),
          division: z.enum(US_DIVISIONS),
          /** Adultes de 18 à 79 ans (ACS 2024). */
          adults: z.number().positive(),
          /** Part de la population en zone rurale (recensement 2020). */
          rural: share,
          /** Loyer brut médian (charges comprises), coûts mensuels médians des propriétaires avec et sans prêt (ACS 2024). */
          medianGrossRent: z.number().positive(),
          ownerCostsMortgage: z.number().positive(),
          ownerCostsNoMortgage: z.number().positive(),
          medicaidExpansion: z.boolean(),
          /** Impôt sur le revenu de l'État : taux moyen appliqué au revenu imposable fédéral (approximation). */
          stateTaxRate: z.number().min(0).max(0.15),
        }),
      ),
    }),
  ),
  race: table(
    z.object({
      labels: record(RACES, z.string()),
      /** Toutes classes d'âge, par État (ACS 2024, B03002). */
      byState: z.record(z.string(), shares(RACES)),
      /** Facteur d'âge : part du groupe dans la tranche / part du groupe chez les 18-79 ans (national). */
      ageFactor: z.array(z.object({ ...band, factors: record(RACES, z.number().positive()) })),
    }),
  ),
  nativity: table(z.object({ labels: record(NATIVITY, z.string()), byRace: record(RACES, shares(NATIVITY)) })),
  language: table(
    z.object({
      labels: record(US_HOME_LANGUAGES, z.string()),
      /** Clé « race:us_born » ou « race:foreign_born ». */
      byGroup: z.record(z.string(), shares(US_HOME_LANGUAGES)),
    }),
  ),
  education: table(
    z.object({
      labels: record(US_EDUCATION, z.string()),
      byAgeSex: byAgeSex(shares(US_EDUCATION)),
      /** Facteur multiplicatif par race (25 ans et plus, C15002 rapporté à l'ensemble). */
      raceFactor: record(RACES, record(US_EDUCATION, z.number().positive())),
    }),
  ),
  activity: table(
    z.object({
      /** Situation au sens du BIT par âge et sexe (CPS 2025). */
      byAgeSex: byAgeSex(shares(ACTIVITY3)),
      /** Inscrits dans un établissement d'enseignement (statut « student »), par âge et sexe. */
      enrolled: byAgeSex(share),
      /** Part des inscrits qui ont un emploi (pris en compte dans les taux d'emploi). */
      enrolledEmployedShare: share,
      /** Rapport du taux d'emploi par diplôme au taux moyen des 25 ans et plus (CPS 2025). */
      educationEmployment: record(US_EDUCATION, z.number().positive()),
      /** Facteur de la probabilité d'être inscrit selon le diplôme déjà obtenu. */
      educationEnrollment: record(US_EDUCATION, z.number().nonnegative()),
      /** Parmi les inactifs non étudiants : part de retraités, par âge. */
      retiredShareOfNilf: z.array(z.object({ ...band, share })),
    }),
  ),
  occupation: table(
    z.object({
      labels: record(US_OCCUPATIONS, z.string()),
      /** Actifs occupés : grand groupe par diplôme et sexe. */
      byEducationSex: z.record(z.string(), z.object({ M: shares(US_OCCUPATIONS), F: shares(US_OCCUPATIONS) })),
      /** Statut de l'emploi par grand groupe. */
      classOfWorker: record(US_OCCUPATIONS, shares(CLASS_OF_WORKER)),
    }),
  ),
  earnings: table(
    z.object({
      /** Salaire brut mensuel d'un temps plein, par grand groupe et sexe (médiane, dispersion). */
      fullTime: record(US_OCCUPATIONS, z.object({ M: logNormal, F: logNormal })),
      /** Dispersion sous la médiane (distribution asymétrique : queue basse plus courte, salaire minimum). */
      lowerSigma: z.number().min(0),
      ageFactor: z.array(z.object({ ...band, factor: z.number().positive() })),
      educationFactor: record(US_EDUCATION, z.number().positive()),
      partTime: z.object({ M: share, F: share, incomeFactor: z.number().positive() }),
      /** Indépendants : dispersion supplémentaire du revenu. */
      selfEmployedSigma: z.number().min(0),
      /** Retraités : Social Security, pensions, retraits de comptes (mensuel brut), par diplôme. */
      retired: record(US_EDUCATION, logNormal),
      student: z.object({ withIncomeShare: share, income: logNormal }),
      unemployed: z.object({ withIncomeShare: share, income: logNormal }),
      inactive: z.object({ withIncomeShare: share, income: logNormal }),
    }),
  ),
  tax: table(
    z.object({
      brackets: z.object({ single: z.array(z.object({ upTo: z.number().nullable(), rate: share })), joint: z.array(z.object({ upTo: z.number().nullable(), rate: share })) }),
      standardDeduction: z.object({ single: z.number(), joint: z.number(), headOfHousehold: z.number(), extra65: z.number(), seniorDeduction: z.number(), seniorPhaseOutSingle: z.number(), seniorPhaseOutJoint: z.number() }),
      fica: z.object({ socialSecurityRate: share, wageBase: z.number(), medicareRate: share, additionalMedicareRate: share, additionalThresholdSingle: z.number(), additionalThresholdJoint: z.number(), selfEmployedFactor: z.number() }),
      childTaxCredit: z.object({ perChild: z.number(), refundableMax: z.number(), refundableRate: share, refundableFloor: z.number(), phaseOutSingle: z.number(), phaseOutJoint: z.number(), phaseOutRate: share }),
      eitc: z.array(z.object({ children: z.number().int(), phaseInRate: share, earnedAmount: z.number(), maxCredit: z.number(), phaseOutRate: share, phaseOutSingle: z.number(), phaseOutJoint: z.number() })),
      /** Seuil de pauvreté fédéral (HHS) : 1 personne, puis par personne en plus (annuel). */
      poverty: z.object({ base: z.number(), perPerson: z.number() }),
      snap: z.object({ maxAllotment: z.array(z.number()).min(4), perExtraPerson: z.number(), grossLimitPoverty: z.number(), benefitReduction: share, standardDeduction: z.number(), participation: share }),
    }),
  ),
  household: table(
    z.object({
      types: byAgeSex(record(HOUSEHOLD_TYPES, share)),
      children: z.object({ one: share, two: share, threePlus: share }),
      firstBirthAge: z.object({ M: z.number(), F: z.number() }),
      /** Couples mariés (déclaration commune) parmi les couples, par âge. */
      marriedShareOfCouples: z.array(z.object({ ...band, share })),
      /** Couples et parents seuls : part qui héberge un enfant adulte (18-34 ans), par âge de la persona. */
      adultChildAtHome: z.array(z.object({ ...band, share })),
      /** Homogamie : part des conjoints de même diplôme que la persona. */
      sameEducationPartner: share,
      /** Revenus du patrimoine (intérêts, dividendes, loyers) : probabilité selon l'âge et le revenu du ménage, montant mensuel. */
      propertyIncome: z.object({ base: share, olderBonus: share, incomeSlope: z.number(), max: share, amount: logNormal, incomeElasticity: z.number() }),
    }),
  ),
  housing: table(
    z.object({
      /** Part de propriétaires par âge du titulaire du logement (ACS 2024, B25007). */
      ownerByAge: z.array(z.object({ ...band, share })),
      /** Rapport de cotes de la propriété par race (B25003), puis pente sur le log du niveau de vie relatif. */
      ownerRaceOdds: record(RACES, z.number().positive()),
      ownerIncomeSlope: z.number(),
      /** Part des propriétaires qui remboursent un prêt, par âge (B25027). */
      mortgageByAge: z.array(z.object({ ...band, share })),
      /** Locataires : part en logement social ou avec bon (niveau de vie relatif < seuil), part sans loyer. */
      social: z.object({ maxRelativeIncome: z.number(), share, rentIncomeShare: share, minRent: z.number() }),
      noCashRent: share,
      dwellingByTenure: z.object({ owner: shares(US_DWELLINGS), renter: shares(US_DWELLINGS) }),
      /** Rural : facteurs multiplicatifs des types de logement. */
      ruralDwellingFactor: record(US_DWELLINGS, z.number().positive()),
      /** Coût relatif par type de logement (à revenu égal) ; les mobile homes se raréfient quand le revenu monte. */
      dwellingCostFactor: record(US_DWELLINGS, z.number().positive()),
      mobileHomeIncomeExponent: z.number(),
      /** Dispersion des loyers et des coûts des propriétaires autour de la médiane de l'État ; élasticité au revenu. */
      rentSigma: z.number(),
      ownerCostSigma: z.number(),
      incomeElasticity: z.number(),
      ownerIncomeElasticity: z.number(),
      /** Plafond du coût du logement en part du revenu brut du ménage. */
      maxCostShare: share,
      ruralCostFactor: z.number().positive(),
    }),
  ),
  health: table(
    z.object({
      labels: record(HEALTH_INSURANCE, z.string()),
      /** Probabilités du modèle de couverture (voir sampler) ; calées sur l'ACS 2024 (B27010). */
      employerFullTime: share,
      employerPartTime: share,
      employerSelfEmployed: share,
      employerIncomeSlope: z.number(),
      spouseCoverage: share,
      parentsPlanUnder26: share,
      medicaidTakeUp: share,
      medicaidNonExpansion: share,
      medicaidMaxPoverty: z.number(),
      marketplace: share,
      military: share,
      /** Retraités de moins de 65 ans couverts par l'ancien employeur. */
      retireeEmployer: share,
      /** Coûts mensuels par adulte couvert : cotisation et reste à charge moyen. */
      premium: record(HEALTH_INSURANCE, z.number().nonnegative()),
      familyPremiumExtra: z.number().nonnegative(),
      outOfPocket: record(HEALTH_INSURANCE, z.number().nonnegative()),
      /** Couverture principale publiée par tranche d'âge (« 19-34 »…), pour la validation des marges. */
      validation: z.record(z.string(), shares(HEALTH_INSURANCE)),
    }),
  ),
  costs: table(
    z.object({
      foodPerUc: z.number(),
      otherCurrentPerUc: z.number(),
      transitPerUc: z.number(),
      currentIncomeElasticity: z.number().min(0).max(1),
      /** Véhicules : part de ménages sans voiture (propriétaires, locataires ; rural), coût d'usage par véhicule, prêt. */
      noVehicle: z.object({ owner: share, renter: share, ruralFactor: z.number().positive() }),
      secondVehicle: share,
      vehicleRunning: logNormal,
      carLoan: z.object({ share, payment: logNormal }),
      /** Garde d'enfants de moins de 5 ans quand tous les adultes travaillent : part qui paie, montant mensuel. */
      childcare: z.object({ share, monthly: logNormal }),
      /** Prêt étudiant : part des adultes qui remboursent, par tranche d'âge et diplôme ; mensualité. */
      studentLoan: z.object({ byAge: z.array(z.object({ ...band, share })), educationFactor: record(US_EDUCATION, z.number().nonnegative()), payment: logNormal }),
      /** Jeune adulte chez ses parents : part de son revenu net versée au foyer. */
      withParentsContribution: share,
      /** Colocation (« other ») : part du loyer médian payée. */
      roommateRentShare: share,
    }),
  ),
});

export type UsPackData = z.infer<typeof usPackSchema>;

export interface UsPack extends UsPackData {
  kind: "us";
  socle: string;
  modules: ResolvedModules;
  cityIndex: Array<{ name: string; normalized: string; region: string }>;
  regionName: (code: string) => string;
  stateName: (code: string) => string;
  stateOf: (code: string) => UsPackData["geography"]["data"]["states"][number] | undefined;
}

export const US_FILES: Record<Exclude<keyof UsPackData, "manifest">, string> = {
  ageSex: "age-sex.json",
  regions: "regions.json",
  livingStandard: "living-standard.json",
  digital: "digital.json",
  subscriptions: "subscriptions.json",
  psychographics: "psychographics.json",
  firstNames: "first-names.json",
  surnames: "surnames.json",
  geography: "geography.json",
  race: "race.json",
  nativity: "nativity.json",
  language: "language.json",
  education: "education.json",
  activity: "activity.json",
  occupation: "occupation.json",
  earnings: "earnings.json",
  tax: "tax.json",
  household: "household.json",
  housing: "housing.json",
  health: "health.json",
  costs: "costs.json",
};

function readUsRaw(dir: string, depth = 0): { raw: Record<string, unknown>; socle: string } {
  if (depth > 3) throw new Error(`Chaîne d'héritage trop longue pour le pack ${dir}`);
  const base = packDir(dir);
  const read = (file: string) => JSON.parse(readFileSync(resolve(base, file), "utf8")) as unknown;
  const manifest = read("pack.json") as { extends?: string };
  const parent = manifest.extends ? readUsRaw(manifest.extends, depth + 1) : { raw: {}, socle: packSocle(dir) };
  const raw: Record<string, unknown> = { ...parent.raw, manifest };
  for (const [k, file] of Object.entries(US_FILES)) if (existsSync(resolve(base, file))) raw[k] = read(file);
  return { raw, socle: parent.socle };
}

/** Charge un pack États-Unis (dossier `packs/<dir>`, héritage `extends` compris). */
export function loadUsPack(dir: string): UsPack {
  const { raw, socle } = readUsRaw(dir);
  const parsed = usPackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Pack ${dir} invalide :\n` + parsed.error.issues.map((i) => `- ${i.path.join(".")} : ${i.message}`).join("\n"));
  }
  const data = parsed.data;
  const regions = new Map(data.regions.data.regions.map((r) => [r.code, r.name]));
  const states = new Map(data.geography.data.states.map((s) => [s.code as string, s]));
  return {
    ...data,
    kind: "us",
    socle,
    modules: resolveModules(data.manifest.modules, socle),
    cityIndex: [],
    regionName: (code) => regions.get(code) ?? code,
    stateName: (code) => states.get(code)?.name ?? code,
    stateOf: (code) => states.get(code),
  };
}
