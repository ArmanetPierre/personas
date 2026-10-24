import { resolve } from "node:path";
import { z } from "zod";

/**
 * Socle commun du contrat de pack pays (docs/architecture-v2.md § 16) : manifeste, constantes partagées,
 * forme des tables communes à tous les pays (âge × sexe, régions, niveau de vie, numérique, abonnements,
 * psychographie, prénoms) et outils de tranches. Les tables propres à un générateur (France : PCS, impôt,
 * prestations… ; Singapour : statut de résidence, logement HDB, CPF…) sont déclarées par son schéma.
 * Ce fichier n'importe aucun pack : il sert à la fois au pack France (`pack.ts`) et aux autres pays.
 */

export const PACKS_DIR = resolve(import.meta.dirname, "../../packs");

export const SEXES = ["F", "M"] as const;
export type Sex = (typeof SEXES)[number];

export const ACTIVITY_STATUSES = ["employed", "unemployed", "student", "retired", "inactive"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const HOUSEHOLD_TYPES = [
  "alone",
  "couple_no_child",
  "couple_with_children",
  "single_parent",
  "with_parents",
  "other",
] as const;
export type HouseholdType = (typeof HOUSEHOLD_TYPES)[number];

export const ROGERS = ["innovator", "early_adopter", "early_majority", "late_majority", "laggard"] as const;
export type Rogers = (typeof ROGERS)[number];

export const SOCIAL_USAGE = ["none", "occasional", "daily", "heavy"] as const;
export type SocialUsage = (typeof SOCIAL_USAGE)[number];

export const sourceSchema = z.object({
  org: z.string().min(1),
  title: z.string().min(1),
  year: z.number().int(),
  url: z.url(),
  detail: z.string().optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const share = z.number().min(0).max(1);
export const band = { from: z.number().int(), to: z.number().int() };
export const record = <K extends readonly [string, ...string[]], V extends z.ZodType>(keys: K, v: V) =>
  z.object(Object.fromEntries(keys.map((k) => [k, v])) as { [P in K[number]]: V });
export const logNormal = z.object({ median: z.number().positive(), sigma: z.number().min(0) });

export function table<D extends z.ZodType>(data: D) {
  return z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      assumption: z.boolean(),
      sources: z.array(sourceSchema).default([]),
      referenceYear: z.number().int().optional(),
      justification: z.string().optional(),
      notes: z.string().optional(),
      data,
    })
    .superRefine((t, ctx) => {
      if (!t.assumption && (t.sources.length === 0 || t.referenceYear === undefined)) {
        ctx.addIssue({ code: "custom", message: `Table sourcée ${t.id} sans source ou sans année de référence` });
      }
      if (t.assumption && !t.justification) {
        ctx.addIssue({ code: "custom", message: `Hypothèse ${t.id} sans justification` });
      }
    });
}

export const byAgeSex = <V extends z.ZodType>(v: V) => z.array(z.object({ ...band, M: v, F: v })).min(1);

/** Langues des contenus d'un socle (récits, prompts d'étude, réponses, textes générés côté serveur). */
export const LOCALES = ["fr", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Chaînes de tirage connues (contrat de pack pays, docs/architecture-v2.md § 16). Chaque générateur lit
 * les tables communes et ses tables propres : `fr` (INSEE, DREES…), `sg` (SingStat, MOM, HDB…), `us` (Census, BLS, IRS…).
 */
export const GENERATORS = ["fr", "sg", "us"] as const;
export type Generator = (typeof GENERATORS)[number];

export const manifestSchema = z.object({
    country: z.string().length(2),
    version: z.string().min(1),
    population: z.string(),
    ageMin: z.number().int(),
    ageMax: z.number().int(),
    /** Année de référence des âges (sert à dater les naissances). */
    referenceYear: z.number().int(),
    description: z.string(),
    /** Pack de base dont les tables absentes de ce dossier sont reprises (ex. "fr"). */
    extends: z.string().optional(),
    /** Libellé de la population (tableau de bord, sorties). */
    label: z.string().optional(),
    /** Libellé court (listes). */
    shortLabel: z.string().optional(),
    /** Comment désigner un membre de la population, au singulier et au pluriel. */
    memberLabel: z.object({ one: z.string(), many: z.string() }).optional(),
    /** Modules activés (bibliothèque `modules/`), tirés après le socle ; voir docs/modules.md. */
    modules: z.array(z.string()).default([]),
    /**
     * Population ciblée (sous-population du socle) : les marges générales d'activité, de PCS et de
     * niveau de vie ne s'appliquent pas en validation.
     */
    targeted: z.boolean().default(false),
    /**
     * `shared` (v1) : les modules consomment le générateur de la persona, dans la chaîne du socle.
     * `module` (v2) : un flux par module (graine, rang, module), tiré après le socle complet ; ajouter un
     * module ne change ni le socle ni les autres modules. Les modules ne peuvent alors pas remplacer le socle.
     */
    rngStreams: z.enum(["shared", "module"]).default("shared"),
    /** Chaîne de tirage (générateur du pays) ; `fr` par défaut. */
    generator: z.enum(GENERATORS).default("fr"),
    /** Langue des récits, des prompts d'étude et des réponses ; `fr` par défaut. */
    locale: z.enum(LOCALES).default("fr"),
    /** Devise de tous les montants de la persona (revenus, budget, abonnements) ; `EUR` par défaut. */
    currency: z.string().regex(/^[A-Z]{3}$/).default("EUR"),
    /** Historique des versions du socle (la plus récente d'abord) : ce qui change dans les tirages. */
    changelog: z.array(z.object({ version: z.string(), date: z.string(), changes: z.array(z.string()).min(1) })).optional(),
  });
export type PackManifest = z.infer<typeof manifestSchema>;


// ─── Tables communes ──────────────────────────────────────────────────────────

export const ageSexTable = table(z.object({ bands: z.array(z.object({ ...band, M: z.number().positive(), F: z.number().positive() })).min(1) }));
export const regionsTable = table(
  z.object({
    regions: z.array(z.object({ code: z.string(), name: z.string(), population: z.number().positive() })).min(1),
  }),
);
export const livingStandardTable = table(
  z.object({ deciles: z.array(z.number().positive()).length(9), median: z.number().positive() }),
);
export const digitalTable = table(
  z.object({
    bands: z.array(
      z.object({
        ...band,
        smartphone: share,
        computer: share,
        tablet: share,
        internet: share,
        socialDaily: share,
        socialAny: share,
      }),
    ),
  }),
);
export const subscriptionsTable = table(
  z.object({
    items: z.array(
      z.object({
        id: z.string(),
        category: z.string(),
        /** Variantes (offres) : libellé, prix mensuel, poids relatif. */
        offers: z.array(z.object({ name: z.string(), monthlyEur: z.number().nonnegative(), weight: z.number().positive() })),
        household: z.boolean(),
        penetration: z.array(z.object({ ...band, p: share })),
        incomeElasticity: z.number(),
        requires: z.enum(["smartphone", "internet"]).optional(),
        /** N'est tiré que si l'abonnement `requiresItem` est détenu ; la pénétration est alors conditionnelle. */
        requiresItem: z.string().optional(),
        /** Nature de la donnée (sourcée ou hypothèse). */
        basis: z.string(),
      }),
    ),
  }),
);
export const psychographicsTable = table(
  z.object({
    rogers: record(ROGERS, share),
    tech: z.object({
      ageWeight: z.number(),
      incomeWeight: z.number(),
      pivotAge: z.number(),
      ageScale: z.number(),
      incomeScale: z.number(),
      /** Décalage de la latente techno (population ciblée plus à l'aise que la moyenne). */
      shift: z.number().default(0),
    }),
    equipmentCorrelation: share,
    /**
     * Corrèle l'équipement au seul résidu individuel de la latente (sans la part revenu) :
     * utile pour une population aisée, dont la part revenu décalerait les taux cibles.
     */
    equipmentFromResidual: z.boolean().default(false),
    priceSensitivity: z.object({ intercept: z.number(), income: z.number(), strain: z.number(), noise: z.number() }),
    skepticism: z.object({ intercept: z.number(), age: z.number(), tech: z.number(), noise: z.number() }),
    tones: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        valence: z.enum(["positive", "neutral", "negative"]),
        modulator: z.enum(["tech", "income", "busy", "skepticism", "strain"]).optional(),
        weight: z.number().positive(),
      }),
    ),
  }),
);
export const firstNamesTable = table(
  z.object({
    cohorts: z.array(
      z.object({
        birthFrom: z.number().int(),
        birthTo: z.number().int(),
        sex: z.enum(SEXES),
        /** Groupe de prénoms (ethnie, nationalité), pour les pays où le prénom ne dépend pas que de l'âge. */
        group: z.string().optional(),
        /**
         * Religions servies par cette cohorte (pays où le nom d'usage dépend aussi de la religion, ex. Indiens
         * musulmans ou chrétiens à Singapour). Sans ce champ : cohorte par défaut du groupe, pour les
         * religions qu'aucune cohorte du groupe ne déclare.
         */
        religions: z.array(z.string()).min(1).optional(),
        names: z.array(z.tuple([z.string(), z.number().positive()])).min(1),
      }),
    ),
  }),
);

/** Comme findBand, mais ramène l'âge dans les bornes de la table (conjoints, parents hors population). */
export function findBandClamped<T extends { from: number; to: number }>(bands: readonly T[], age: number): T {
  const lo = Math.min(...bands.map((b) => b.from));
  const hi = Math.max(...bands.map((b) => b.to));
  return findBand(bands, Math.min(hi, Math.max(lo, age)));
}

/** Trouve la tranche [from, to] qui contient `age`. */
export function findBand<T extends { from: number; to: number }>(bands: readonly T[], age: number): T {
  const b = bands.find((x) => age >= x.from && age <= x.to);
  if (!b) throw new Error(`Aucune tranche ne couvre l'âge ${age}`);
  return b;
}

/** Retire les accents en gardant la casse. */
export const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
