import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { resolveModules, type ResolvedModules } from "../modules/registry";
import { loadSgPack, type SgPack } from "./countries/sg/pack";
import { loadUsPack, type UsPack } from "./countries/us/pack";
import { packDir, packSocle } from "./pack-source";

/**
 * Pack pays : tables de distribution versionnées (`packs/<pays>/`). Contrat commun (manifeste, tables
 * partagées) dans `pack-common.ts` ; ce fichier porte le schéma du générateur France (`generator: fr`)
 * et le chargement de tous les packs (Singapour : `countries/sg/pack.ts`). Voir docs/architecture-v2.md § 16.
 * Deux sortes de tables :
 * - sourcées (`assumption: false`) : chiffres officiels, avec source et année de référence ;
 * - hypothèses de modélisation (`assumption: true`) : paramètres choisis, avec justification.
 */

import {
  ACTIVITY_STATUSES,
  ageSexTable,
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
  band,
  stripAccents,
  subscriptionsTable,
  table,
} from "./pack-common";

export * from "./pack-common";

/** PCS 2020, niveau 1 (groupes socioprofessionnels des actifs). */
export const PCS_CODES = ["1", "2", "3", "4", "5", "6"] as const;
export type PcsCode = (typeof PCS_CODES)[number];

export const TENURES = ["owner", "owner_mortgage", "renter_private", "renter_social", "free"] as const;
export type Tenure = (typeof TENURES)[number];

export const TOWN_SIZES = ["rural", "uu_lt20k", "uu_20k_100k", "uu_100k_200k", "uu_200k_2m", "uu_paris"] as const;
export type TownSize = (typeof TOWN_SIZES)[number];

export const packSchema = z.object({
  manifest: manifestSchema,
  ageSex: ageSexTable,
  regions: regionsTable,
  townSize: table(
    z.object({
      labels: record(TOWN_SIZES, z.string()),
      byRegion: z.record(z.string(), record(TOWN_SIZES, share)),
    }),
  ),
  urbanUnits: table(
    z.object({
      units: z.array(
        z.object({
          name: z.string(),
          region: z.string(),
          population: z.number().positive(),
          /** Tranche officielle de taille (TUU2017) : 6 = 100 000-199 999, 7 = 200 000-1 999 999, 8 = Paris. */
          sizeClass: z.number().int(),
          /** Noms de villes à reconnaître dans les récits. */
          cities: z.array(z.string()),
        }),
      ),
    }),
  ),
  activity: table(z.object({ bands: byAgeSex(record(ACTIVITY_STATUSES, share)) })),
  pcs: table(
    z.object({
      labels: record(PCS_CODES, z.object({ M: z.string(), F: z.string() })),
      employed: byAgeSex(record(PCS_CODES, share)),
      retiredFormer: z.object({ M: record(PCS_CODES, share), F: record(PCS_CODES, share) }),
    }),
  ),
  earnings: table(
    z.object({
      /** Revenu net mensuel d'un emploi à temps complet, par PCS. */
      fullTime: record(PCS_CODES, logNormal),
      /** Plancher d'un salaire à temps complet (≈ 0,9 SMIC net). */
      minFullTime: z.number().nonnegative(),
      /** Coefficient multiplicateur par âge (carrière). */
      ageFactor: z.array(z.object({ ...band, factor: z.number().positive() })),
      /** Femmes : écart de salaire à poste et âge comparables non expliqué par la PCS. */
      sexFactor: z.object({ M: z.number().positive(), F: z.number().positive() }),
      partTime: z.object({ M: share, F: share, incomeFactor: z.number().positive() }),
      pension: z.object({ M: logNormal, F: logNormal }),
      pensionPcsFactor: record(PCS_CODES, z.number().positive()),
      unemployment: z.object({ indemnifiedShare: share, benefit: logNormal }),
      student: z.object({ resources: logNormal }),
      inactive: z.object({ withIncomeShare: share, income: logNormal }),
    }),
  ),
  taxBenefits: table(
    z.object({
      incomeTax: z.object({
        abatement: share,
        brackets: z.array(z.object({ upTo: z.number().nullable(), rate: share })),
        decote: z.object({
          single: z.object({ threshold: z.number(), base: z.number() }),
          couple: z.object({ threshold: z.number(), base: z.number() }),
          rate: share,
        }),
      }),
      rsa: z.object({ base: z.number(), secondAdult: share, perChild: share, thirdChildOn: share }),
      aspa: z.object({ single: z.number(), couple: z.number() }),
      activityBonus: z.object({ base: z.number(), earnedRate: share, minPayment: z.number() }),
      /** Revenus du patrimoine en part des revenus du ménage, selon l'âge de la personne de référence. */
      patrimonyRate: z.array(z.object({ ...band, rate: share })),
      familyAllowance: z.object({ two: z.number(), three: z.number(), perExtra: z.number() }),
      housingAid: z.object({ maxSingle: z.number(), maxCouple: z.number(), perChild: z.number(), taperRate: share, floorIncomePerUc: z.number() }),
    }),
  ),
  livingStandard: livingStandardTable,
  household: table(
    z.object({
      bands: byAgeSex(record(HOUSEHOLD_TYPES, share)),
      children: z.object({ one: share, two: share, threePlus: share }),
    }),
  ),
  housing: table(
    z.object({
      tenureByAge: z.array(z.object({ ...band, shares: record(TENURES, share) })),
      /** Moins de 30 ans qui ne vivent pas chez leurs parents (hypothèse). */
      youngIndependent: record(TENURES, share),
    }),
  ),
  costs: table(
    z.object({
      /** Loyer mensuel charges comprises d'un logement de référence, par taille d'agglomération. */
      rentPrivate: record(TOWN_SIZES, z.number().positive()),
      rentSocial: z.number().positive(),
      rentSigma: z.number().min(0),
      /** Surcoût de loyer par personne supplémentaire du ménage (part du loyer de référence). */
      rentPerExtraPerson: share,
      mortgage: logNormal,
      ownerCharges: z.number().nonnegative(),
      /** Taux d'effort maximal d'un emprunt immobilier (règle du HCSF). */
      maxMortgageEffort: share,
      energyPerHousehold: z.number().nonnegative(),
      energyPerUc: z.number().nonnegative(),
      insurancePerHousehold: z.number().nonnegative(),
      insurancePerUc: z.number().nonnegative(),
      foodPerUc: z.number().nonnegative(),
      transportPerUc: record(TOWN_SIZES, z.number().nonnegative()),
      otherCurrentPerUc: z.number().nonnegative(),
      /** Les dépenses courantes croissent moins que proportionnellement au revenu. */
      currentIncomeElasticity: z.number().min(0).max(1),
      withParentsShare: share,
    }),
  ),
  digital: digitalTable,
  subscriptions: subscriptionsTable,
  psychographics: psychographicsTable,
  firstNames: firstNamesTable,
});

export type PackData = z.infer<typeof packSchema>;
export type PackTable = NonNullable<PackData[Exclude<keyof PackData, "manifest">]>;

export interface CityRef {
  name: string;
  normalized: string;
  region: string;
}

/** Pack France (générateur `fr`). */
export interface FrPack extends PackData {
  kind: "fr";
  /** Socle racine de la chaîne d'héritage (ex. "fr"). */
  socle: string;
  /** Modules activés, résolus (dépendances, ordre de tirage). */
  modules: ResolvedModules;
  /** Grandes villes (unités urbaines) et leur région, pour les récits et le contrôle de cohérence. */
  cityIndex: CityRef[];
  regionName: (code: string) => string;
}

/** Pack de n'importe quel pays : distinguer par `kind` avant de lire une table propre à un générateur. */
export type Pack = FrPack | SgPack | UsPack;
export type { SgPack, UsPack };

/** Pack France, ou erreur explicite (fonctions propres au générateur France). */
export function asFr(pack: Pack, what = "cette fonction"): FrPack {
  if (pack.kind !== "fr") throw new Error(`${what} : réservé au socle France (pack ${pack.manifest.version}, générateur ${pack.kind})`);
  return pack;
}

const FILES: Record<Exclude<keyof PackData, "manifest">, string> = {
  ageSex: "age-sex.json",
  regions: "regions.json",
  townSize: "town-size.json",
  urbanUnits: "urban-units.json",
  activity: "activity.json",
  pcs: "pcs.json",
  earnings: "earnings.json",
  taxBenefits: "tax-benefits.json",
  livingStandard: "living-standard.json",
  household: "household.json",
  housing: "housing.json",
  costs: "costs.json",
  digital: "digital.json",
  subscriptions: "subscriptions.json",
  psychographics: "psychographics.json",
  firstNames: "first-names.json",
};

const cache = new Map<string, Pack>();

export function loadPack(name = "fr"): Pack {
  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const generator = (JSON.parse(readFileSync(resolve(packDir(key), "pack.json"), "utf8")) as { generator?: string }).generator ?? "fr";
  if (generator === "sg") {
    const sg = loadSgPack(key);
    cache.set(key, sg);
    return sg;
  }
  if (generator === "us") {
    const us = loadUsPack(key);
    cache.set(key, us);
    return us;
  }
  const { raw, socle } = readRaw(key);
  const parsed = packSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Pack ${key} invalide :\n` +
        parsed.error.issues.map((i) => `- ${i.path.join(".")} : ${i.message}`).join("\n"),
    );
  }
  const data = parsed.data;
  const names = new Map(data.regions.data.regions.map((r) => [r.code, r.name]));
  const pack: FrPack = {
    ...data,
    kind: "fr",
    socle,
    modules: resolveModules(data.manifest.modules, socle),
    cityIndex: buildCityIndex(data),
    regionName: (code) => names.get(code) ?? code,
  };
  cache.set(key, pack);
  return pack;
}

/** Lit les tables d'un pack ; avec `extends`, les tables absentes sont reprises du pack de base. */
function readRaw(key: string, depth = 0): { raw: Record<string, unknown>; socle: string } {
  if (depth > 3) throw new Error(`Chaîne d'héritage trop longue pour le pack ${key}`);
  const dir = packDir(key);
  const read = (file: string) => JSON.parse(readFileSync(resolve(dir, file), "utf8")) as unknown;
  const manifest = read("pack.json") as { extends?: string };
  const base = manifest.extends ? readRaw(manifest.extends, depth + 1) : { raw: {}, socle: packSocle(key) };
  const raw: Record<string, unknown> = { ...base.raw, manifest };
  for (const [k, file] of Object.entries(FILES)) {
    if (existsSync(resolve(dir, file))) raw[k] = read(file);
  }
  return { raw, socle: base.socle };
}

/** Index des villes des unités urbaines ; un nom présent dans deux régions est écarté. */
function buildCityIndex(data: PackData): CityRef[] {
  const out = new Map<string, CityRef>();
  const dropped = new Set<string>();
  for (const u of data.urbanUnits.data.units) {
    for (const name of u.cities) {
      const normalized = stripAccents(name);
      const prev = out.get(normalized);
      if (dropped.has(normalized)) continue;
      if (prev && prev.region !== u.region) {
        out.delete(normalized);
        dropped.add(normalized);
        continue;
      }
      out.set(normalized, { name, normalized, region: u.region });
    }
  }
  return [...out.values()];
}


/** Toutes les tables avec leurs métadonnées, pour la documentation et la validation. */
export function packTables(pack: PackData): Array<{ key: string; file: string; table: PackTable }> {
  return Object.entries(FILES).flatMap(([key, file]) => {
    const table = pack[key as keyof typeof FILES];
    return table ? [{ key, file, table }] : [];
  });
}


