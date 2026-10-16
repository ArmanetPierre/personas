import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { resolveModules, type ResolvedModules } from "../../../modules/registry";
import {
  ACTIVITY_STATUSES,
  ageSexTable,
  band,
  byAgeSex,
  digitalTable,
  firstNamesTable,
  HOUSEHOLD_TYPES,
  livingStandardTable,
  logNormal,
  manifestSchema,
  PACKS_DIR,
  psychographicsTable,
  record,
  regionsTable,
  share,
  subscriptionsTable,
  table,
} from "../../pack-common";

/**
 * Pack Singapour (générateur `sg`) : tables communes du contrat de pack pays plus les tables propres à
 * Singapour (statut de résidence, ethnie, religion, langue, planning areas × type de logement, CPF…).
 * Sources et approximations : docs/research/socle-sg.md et packs/sg/README.md.
 */

export * from "./codes";
import { DWELLINGS, ETHNICITIES, EDUCATION_LEVELS, HOME_LANGUAGES, RELIGIONS, RESIDENCY, RESIDENT_DWELLINGS, SG_TENURES, SSOC_CODES } from "./codes";

const weights = z.record(z.string(), z.number().nonnegative());

export const sgPackSchema = z.object({
  manifest: manifestSchema,
  ageSex: ageSexTable,
  regions: regionsTable,
  livingStandard: livingStandardTable,
  digital: digitalTable,
  subscriptions: subscriptionsTable,
  psychographics: psychographicsTable,
  firstNames: firstNamesTable,
  residency: table(
    z.object({
      labels: record(RESIDENCY, z.string()),
      /** Effectifs 18-79 ans par statut, tranche d'âge et sexe. */
      /** `sector` (Work Permit) : `cmp` = construction, chantiers navals et process (logés en dortoir le plus souvent). */
      statuses: z.array(
        z.object({
          code: z.enum(RESIDENCY),
          sector: z.enum(["cmp", "other"]).optional(),
          bands: z.array(z.object({ ...band, M: z.number().nonnegative(), F: z.number().nonnegative() })).min(1),
        }),
      ),
    }),
  ),
  ethnicity: table(
    z.object({
      labels: record(ETHNICITIES, z.string()),
      /** Résidents : ethnie par statut et tranche d'âge. */
      residents: z.object({ citizen: z.array(z.object({ ...band, shares: record(ETHNICITIES, share) })), pr: z.array(z.object({ ...band, shares: record(ETHNICITIES, share) })) }),
      /** Étrangers : groupe de nationalité par pass, puis ethnie et groupe de prénoms de chaque nationalité. */
      nationalities: z.array(
        z.object({
          code: z.string(),
          label: z.string(),
          /** Libellé précisé selon l'ethnie tirée (ex. Taiwan ou Hong Kong pour un ressortissant d'Asie de l'Est d'ethnie chinoise). */
          labelByEthnicity: z.record(z.string(), z.string()).optional(),
          /** Ethnie (catégories de Singapour) : poids, éventuellement propres à un pass. */
          ethnicity: weights,
          ethnicityByPass: z.record(z.string(), weights).optional(),
          /** Groupe de prénoms : par défaut, par ethnie, ou par pass. */
          names: z.string(),
          namesByEthnicity: z.record(z.string(), z.string()).optional(),
          namesByPass: z.record(z.string(), z.string()).optional(),
        }),
      ),
      byPass: z.record(z.string(), weights),
    }),
  ),
  religion: table(
    z.object({
      labels: record(RELIGIONS, z.string()),
      /** Par ethnie (résidents) ; clés supplémentaires possibles par nationalité (étrangers). */
      byGroup: z.record(z.string(), record(RELIGIONS, share)),
    }),
  ),
  language: table(
    z.object({
      labels: record(HOME_LANGUAGES, z.string()),
      /** Langue la plus parlée à la maison : par ethnie et tranche d'âge (résidents). */
      byEthnicityAge: z.record(z.string(), z.array(z.object({ ...band, shares: record(HOME_LANGUAGES, share) }))),
      /** Étrangers : par nationalité. */
      byNationality: z.record(z.string(), record(HOME_LANGUAGES, share)),
    }),
  ),
  education: table(
    z.object({
      labels: record(EDUCATION_LEVELS, z.string()),
      residents: z.array(z.object({ ...band, shares: record(EDUCATION_LEVELS, share) })),
      byPass: z.record(z.string(), record(EDUCATION_LEVELS, share)),
    }),
  ),
  geography: table(
    z.object({
      dwellingLabels: record(DWELLINGS, z.string()),
      /** Planning areas : résidents par type de logement. */
      areas: z.array(z.object({ code: z.string(), name: z.string(), region: z.string(), residents: record(RESIDENT_DWELLINGS, z.number().nonnegative()) })),
      /** Type de logement des étrangers par pass (et secteur pour les Work Permit). */
      foreignDwelling: z.record(z.string(), record(DWELLINGS, share)),
      /** Dortoirs : répartition par planning area (poids). */
      dormitoryAreas: weights,
      /** Logement des résidents selon l'âge : facteurs multiplicatifs par type (jeunes adultes et seniors). */
      residentDwellingAgeFactor: z.array(z.object({ ...band, factors: record(RESIDENT_DWELLINGS, z.number().positive()) })).optional(),
    }),
  ),
  activity: table(
    z.object({
      /** Résidents : situation d'activité par âge et sexe. */
      residents: byAgeSex(record(ACTIVITY_STATUSES, share)),
      /** Hommes citoyens et PR en service national à temps plein (NSF), par âge. */
      nationalService: z.array(z.object({ ...band, share })),
      /** Dépendants : part en emploi (Letter of Consent), par sexe. */
      dependantEmployed: z.object({ M: share, F: share }),
    }),
  ),
  occupation: table(
    z.object({
      labels: record(SSOC_CODES, z.string()),
      /** Résidents en emploi : grand groupe par niveau d'éducation et sexe. */
      residents: z.record(z.string(), z.object({ M: record(SSOC_CODES, share), F: record(SSOC_CODES, share) })),
      /** Étrangers en emploi : grand groupe par pass (et `wp_cmp`). */
      byPass: z.record(z.string(), record(SSOC_CODES, share)),
      /** Anciennes professions des retraités : grand groupe par niveau d'éducation. */
      retiredFormer: z.record(z.string(), record(SSOC_CODES, share)).optional(),
    }),
  ),
  earnings: table(
    z.object({
      /** Revenu brut mensuel du travail à temps complet (hors cotisation employeur CPF), par grand groupe. */
      fullTime: record(SSOC_CODES, logNormal),
      ageFactor: z.array(z.object({ ...band, factor: z.number().positive() })),
      sexFactor: z.object({ M: z.number().positive(), F: z.number().positive() }),
      partTime: z.object({ M: share, F: share, incomeFactor: z.number().positive() }),
      /** Étrangers : salaire brut mensuel par pass, plancher éventuel (salaire minimal qualifiant). */
      passes: z.record(z.string(), z.object({ median: z.number().positive(), sigma: z.number().min(0), floor: z.number().nonnegative().optional(), floorAgeStep: z.number().nonnegative().optional() })),
      /** Retraités : revenu mensuel (CPF LIFE, Silver Support, aide des enfants), par niveau d'éducation. */
      retired: z.record(z.string(), logNormal),
      student: logNormal,
      /** Allocation mensuelle d'un NSF. */
      nationalService: logNormal,
      unemployed: z.object({ withIncomeShare: share, income: logNormal }),
      inactive: z.object({ withIncomeShare: share, income: logNormal }),
    }),
  ),
  cpf: table(
    z.object({
      /** Taux de cotisation salariale (citoyens et PR) par âge. */
      employeeRate: z.array(z.object({ ...band, rate: share })),
      /** Plafond mensuel du salaire ordinaire soumis au CPF. */
      ordinaryWageCeiling: z.number().positive(),
      /** Pas de cotisation salariale sous ce salaire ; taux réduit entre ce seuil et `fullRateFrom`. */
      noEmployeeBelow: z.number().nonnegative(),
      fullRateFrom: z.number().nonnegative(),
      /** Part de la mensualité d'un prêt HDB payée par le compte CPF ordinaire (et non en espèces). */
      hdbLoanCpfShare: share,
      /** Même part pour un prêt immobilier privé (condo, landed). */
      privateLoanCpfShare: share,
    }),
  ),
  taxBenefits: table(
    z.object({
      /** Barème annuel de l'impôt des résidents fiscaux (revenu imposable après abattements). */
      brackets: z.array(z.object({ upTo: z.number().nullable(), rate: share })),
      /** Abattements forfaitaires annuels (earned income relief, etc.). */
      reliefs: z.number().nonnegative(),
      /**
       * Transferts mensuels non ciblés par membre d'un ménage résident (GST Voucher cash, U-Save, CDC et SG60
       * Vouchers), par quintile du revenu net par tête (`cuts` : 4 bornes mensuelles).
       */
      householdTransfers: z.object({ cuts: z.array(z.number().nonnegative()).length(4), perMember: z.array(z.number().nonnegative()).length(5) }),
      /** Silver Support (65 ans et plus, faibles revenus) : montant mensuel et seuil de revenu par tête. */
      silverSupport: z.object({ monthly: z.number().nonnegative(), maxIncomePerCapita: z.number().nonnegative(), fromAge: z.number().int() }),
      /** Workfare : complément mensuel moyen des bas salaires, à partir de cet âge et sous ce salaire. */
      workfare: z.object({ monthly: z.number().nonnegative(), fromAge: z.number().int(), maxIncome: z.number().nonnegative() }),
    }),
  ),
  household: table(
    z.object({
      /** Résidents : type de ménage par âge et sexe. */
      residents: byAgeSex(record(HOUSEHOLD_TYPES, share)),
      children: z.object({ one: share, two: share, threePlus: share }),
      /** Âge moyen à la première naissance, par sexe du parent. */
      firstBirthAge: z.object({ M: z.number(), F: z.number() }),
      /** Étrangers : type de ménage par pass. */
      byPass: z.record(z.string(), record(HOUSEHOLD_TYPES, share)),
      /** Part des ménages résidents qui emploient une employée de maison, par type de logement. */
      mdwByDwelling: record(RESIDENT_DWELLINGS, share),
    }),
  ),
  housing: table(
    z.object({
      /** Statut d'occupation des ménages résidents par type de logement. */
      residentTenure: record(RESIDENT_DWELLINGS, record(SG_TENURES, share)),
      /** Part des propriétaires qui remboursent encore un prêt, par âge. */
      mortgageByAge: z.array(z.object({ ...band, share })),
      /** Étrangers hors dortoir et hors employeur : statut d'occupation par pass (location surtout). */
      foreignTenure: z.record(z.string(), record(SG_TENURES, share)),
    }),
  ),
  costs: table(
    z.object({
      /** Mensualité de prêt (total, CPF compris) par type de logement. */
      mortgage: record(RESIDENT_DWELLINGS, logNormal),
      /** Loyer mensuel d'un logement entier par type, et d'une chambre (colocation). */
      rentWhole: record(RESIDENT_DWELLINGS, logNormal),
      rentRoom: logNormal,
      /** Lit en chambre partagée (travailleurs Work Permit hors dortoir). */
      rentShared: logNormal,
      rentSocial: logNormal,
      /** Charges : S&CC HDB, charges de copropriété, par type. */
      conservancy: record(RESIDENT_DWELLINGS, z.number().nonnegative()),
      /** Électricité, eau, gaz : par type de logement (ménage). */
      utilities: record(RESIDENT_DWELLINGS, z.number().nonnegative()),
      /** Dépenses par adulte-équivalent : alimentation (dont hawker), transport, santé et assurances, autres. */
      foodPerUc: z.number().nonnegative(),
      transportPerUc: z.number().nonnegative(),
      carShareByDwelling: record(RESIDENT_DWELLINGS, share),
      carMonthly: logNormal,
      healthInsurancePerUc: z.number().nonnegative(),
      otherCurrentPerUc: z.number().nonnegative(),
      currentIncomeElasticity: z.number().min(0).max(1),
      /** Envois d'argent au pays : part du salaire net, par pass. */
      remittanceShare: z.record(z.string(), share),
      /** Participation mensuelle d'un enfant adulte (22 ans et plus) qui vit au foyer. */
      adultChildContribution: z.number().nonnegative(),
      /** Contribution d'un jeune adulte qui vit chez ses parents (part de son revenu net). */
      withParentsContribution: share,
      /** Dortoir : dépenses propres d'un travailleur (repas, téléphone, transport), mensuel. */
      dormitoryLiving: z.number().nonnegative(),
      /** Employée de maison logée et nourrie : dépenses propres, mensuel. */
      liveInLiving: z.number().nonnegative(),
    }),
  ),
});

export type SgPackData = z.infer<typeof sgPackSchema>;

export interface SgPack extends SgPackData {
  kind: "sg";
  socle: string;
  modules: ResolvedModules;
  /** Planning areas et noms à reconnaître dans les récits (contrôle de cohérence). */
  cityIndex: Array<{ name: string; normalized: string; region: string }>;
  regionName: (code: string) => string;
  areaName: (code: string) => string;
  areaRegion: (code: string) => string;
}

export const SG_FILES: Record<Exclude<keyof SgPackData, "manifest">, string> = {
  ageSex: "age-sex.json",
  regions: "regions.json",
  livingStandard: "living-standard.json",
  digital: "digital.json",
  subscriptions: "subscriptions.json",
  psychographics: "psychographics.json",
  firstNames: "first-names.json",
  residency: "residency.json",
  ethnicity: "ethnicity.json",
  religion: "religion.json",
  language: "language.json",
  education: "education.json",
  geography: "geography.json",
  activity: "activity.json",
  occupation: "occupation.json",
  earnings: "earnings.json",
  cpf: "cpf.json",
  taxBenefits: "tax-benefits.json",
  household: "household.json",
  housing: "housing.json",
  costs: "costs.json",
};

/**
 * Lit les tables d'un pack Singapour ; avec `extends`, les tables absentes du dossier sont reprises du pack
 * de base (ex. `sg-2026.2` ne porte que ses noms d'usage et hérite du reste de `packs/sg`).
 */
function readSgRaw(dir: string, depth = 0): { raw: Record<string, unknown>; socle: string } {
  if (depth > 3) throw new Error(`Chaîne d'héritage trop longue pour le pack ${dir}`);
  const base = resolve(PACKS_DIR, dir);
  const read = (file: string) => JSON.parse(readFileSync(resolve(base, file), "utf8")) as unknown;
  const manifest = read("pack.json") as { extends?: string };
  const parent = manifest.extends ? readSgRaw(manifest.extends, depth + 1) : { raw: {}, socle: dir };
  const raw: Record<string, unknown> = { ...parent.raw, manifest };
  for (const [k, file] of Object.entries(SG_FILES)) if (existsSync(resolve(base, file))) raw[k] = read(file);
  return { raw, socle: parent.socle };
}

/** Charge un pack Singapour (dossier `packs/<dir>`, héritage `extends` compris). */
export function loadSgPack(dir: string): SgPack {
  const { raw, socle } = readSgRaw(dir);
  const parsed = sgPackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Pack ${dir} invalide :\n` + parsed.error.issues.map((i) => `- ${i.path.join(".")} : ${i.message}`).join("\n"));
  }
  const data = parsed.data;
  const regions = new Map(data.regions.data.regions.map((r) => [r.code, r.name]));
  const areas = new Map(data.geography.data.areas.map((a) => [a.code, a]));
  return {
    ...data,
    kind: "sg",
    socle,
    modules: resolveModules(data.manifest.modules, socle),
    cityIndex: [],
    regionName: (code) => regions.get(code) ?? code,
    areaName: (code) => areas.get(code)?.name ?? code,
    areaRegion: (code) => areas.get(code)?.region ?? "",
  };
}
