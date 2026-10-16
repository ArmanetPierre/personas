import { z } from "zod";

/**
 * Format de module (YAML). Un module ajoute des attributs aux personas d'un socle :
 * distributions conditionnées, lignes de fiche, segments d'analyse, dimensions de validation.
 * Tout est déclaratif ; les calculs passent par un petit jeu d'expressions nommées (voir docs/modules.md).
 */

const code = z.string().regex(/^[a-z][a-z0-9_]*$/, "code attendu en minuscules, chiffres et _ (ex. salaried_cadre)");
const attrKey = code;

export const sourceSchema = z.object({
  org: z.string().min(1),
  title: z.string().min(1),
  year: z.number().int(),
  url: z.url(),
  detail: z.string().optional(),
});

/** Référence d'un attribut : `status` (même module), `autre_module.attr`, ou `socle.age`. */
const attrRef = z.string().regex(/^([a-z][a-z0-9_-]*\.)?[a-z][a-z0-9_]*$/, "référence d'attribut attendue (ex. status, socle.age, autre-module.attr)");

/** Origine d'une donnée : sources citées, ou hypothèse justifiée (même exigence que les packs). */
const provenance = {
  sources: z.array(z.string()).default([]),
  assumption: z.boolean().default(false),
  justification: z.string().optional(),
};

// ── Conditions ──────────────────────────────────────────────────────────────

export type Condition =
  | string
  | { attr: string; in?: Array<string | number | boolean>; eq?: string | number | boolean | null; lt?: number; gt?: number; present?: boolean }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.string().min(1).describe("nom d'une condition déclarée dans `conditions`"),
    z
      .object({
        attr: attrRef,
        in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
        eq: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        lt: z.number().optional(),
        gt: z.number().optional(),
        present: z.boolean().optional(),
      })
      .strict()
      .refine((c) => [c.in, c.eq, c.lt, c.gt, c.present].filter((x) => x !== undefined).length === 1, {
        message: "une condition sur attribut prend exactement un opérateur : in, eq, lt, gt ou present",
      }),
    z.object({ all: z.array(conditionSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1) }).strict(),
    z.object({ not: conditionSchema }).strict(),
  ]),
);

// ── Expressions (primitives de calcul nommées) ──────────────────────────────

export type Expr =
  | number
  | { attr: string }
  | { lookup: string; by: string }
  | { pick: string; values: Record<string, number>; default?: number }
  | { mul: Expr[] }
  | { add: Expr[] }
  | { div: [Expr, Expr] }
  | { min: Expr[] }
  | { max: Expr[] }
  | { exp: Expr }
  | { round: Expr }
  | { round_to: number; value: Expr }
  | { normal: Record<string, never> }
  | { lognormal: { median: Expr; sigma: Expr } }
  | { bernoulli: Expr }
  | { if: Condition; then: Expr; else: Expr }
  | { cases: Array<{ when: Condition; value: Expr } | { else: Expr }> };

export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.number(),
    z.object({ attr: attrRef }).strict(),
    z.object({ lookup: z.string(), by: attrRef }).strict(),
    z.object({ pick: attrRef, values: z.record(z.string(), z.number()), default: z.number().optional() }).strict(),
    z.object({ mul: z.array(exprSchema).min(1) }).strict(),
    z.object({ add: z.array(exprSchema).min(1) }).strict(),
    z.object({ div: z.tuple([exprSchema, exprSchema]) }).strict(),
    z.object({ min: z.array(exprSchema).min(1) }).strict(),
    z.object({ max: z.array(exprSchema).min(1) }).strict(),
    z.object({ exp: exprSchema }).strict(),
    z.object({ round: exprSchema }).strict(),
    z.object({ round_to: z.number().positive(), value: exprSchema }).strict(),
    z.object({ normal: z.object({}).strict() }).strict(),
    z.object({ lognormal: z.object({ median: exprSchema, sigma: exprSchema }).strict() }).strict(),
    z.object({ bernoulli: exprSchema }).strict(),
    z.object({ if: conditionSchema, then: exprSchema, else: exprSchema }).strict(),
    z
      .object({
        cases: z
          .array(z.union([z.object({ when: conditionSchema, value: exprSchema }).strict(), z.object({ else: exprSchema }).strict()]))
          .min(1),
      })
      .strict(),
  ]),
);

// ── Tables de référence (lookup) ────────────────────────────────────────────

const tableSchema = z
  .object({
    label: z.string().optional(),
    /** Valeurs par code d'un attribut enum… */
    values: z.record(z.string(), z.number()).optional(),
    /** …ou par tranche d'un attribut numérique (âge). */
    bands: z.array(z.object({ from: z.number(), to: z.number(), value: z.number() })).optional(),
    ...provenance,
  })
  .strict()
  .refine((t) => (t.values ? 1 : 0) + (t.bands ? 1 : 0) === 1, { message: "une table a soit `values`, soit `bands`" });

// ── Attributs ───────────────────────────────────────────────────────────────

const genderedLabel = z.union([z.string(), z.object({ M: z.string(), F: z.string() }).strict()]);

const enumValue = z
  .object({
    code,
    label: genderedLabel,
    /** Correspondances vers le socle (activity_status, pcs…) utilisées par `socle_overrides`. */
    socle: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const categoricalDistribution = z
  .object({
    /** `random` : générateur à graine ; `quasi` : suite de Kronecker indexée par le rang (marges exactes en petit tirage). */
    sampler: z.enum(["random", "quasi"]).default("random"),
    /**
     * Attribut(s) conditionnant(s) ; absent = distribution inconditionnelle. Avec plusieurs attributs,
     * `table` est imbriquée dans l'ordre de `given` (clé `default` possible à chaque niveau).
     */
    given: z.union([attrRef, z.array(attrRef).min(1)]).optional(),
    /**
     * Poids sans `given` : nombres, ou expressions évaluées pour chaque persona (modèle multiplicatif
     * conditionné à plusieurs attributs du socle, ex. âge × PCS × sexe).
     */
    weights: z.record(z.string(), z.union([z.number().min(0), exprSchema])).optional(),
    /** Poids par valeur de `given` (tables imbriquées si plusieurs attributs). */
    table: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((d) => (d.given ? !!d.table && !d.weights : !!d.weights && !d.table), {
    message: "distribution : `weights` sans `given`, ou `given` avec `table`",
  });

/** Taux d'une option d'ensemble : expression, ou raccourci { base, factors } (multiplicateurs par condition nommée). */
const rateSchema = z.union([
  z.object({ base: z.number().min(0), factors: z.record(z.string(), z.number().min(0)).default({}) }).strict(),
  exprSchema,
]);

const setItem = z
  .object({
    code,
    label: z.string(),
    /** Libellé sur la fiche, s'il diffère (ex. avec le prix). */
    card_label: z.string().optional(),
    rate: rateSchema,
    /** Abonnement ajouté à la persona si l'option est tirée (déduit du reste-à-vivre). */
    subscription: z.object({ name: z.string(), category: z.string(), monthly_eur: z.number().positive() }).strict().optional(),
  })
  .strict();

const display = z
  .object({
    /** `eur` : montant arrondi en euros (« 590 € »). */
    /** `percent` : part entre 0 et 1 affichée en pourcentage arrondi (« 30 % »). */
    format: z.enum(["eur", "number", "percent"]).optional(),
    /** Gabarit autour de la valeur, `{value}` remplacé. */
    template: z.string().optional(),
    /** Rendu si la valeur est 0, vide ou absente. */
    empty: z.string().optional(),
    separator: z.string().default(", "),
  })
  .strict();

const baseAttr = {
  key: attrKey,
  label: z.string(),
  description: z.string().optional(),
  /** `work` : tiré avec la situation professionnelle (avant le ménage) ; `profile` : après équipement et abonnements. */
  phase: z.enum(["work", "profile"]).default("profile"),
  /** Condition de présence ; sinon l'attribut vaut null et ne consomme aucun tirage. */
  when: conditionSchema.optional(),
  display: display.optional(),
  ...provenance,
};

const enumAttr = z
  .object({ ...baseAttr, type: z.literal("enum"), values: z.array(enumValue).min(1), distribution: categoricalDistribution })
  .strict();
const setAttr = z
  .object({
    ...baseAttr,
    type: z.literal("set"),
    items: z.array(setItem).min(1),
    /** Plafond appliqué à chaque taux (ex. 0,95). */
    rate_cap: z.number().min(0).max(1).optional(),
    /** Nombre maximal d'options retenues (les autres sont retirées au hasard). */
    max_items: z.number().int().positive().optional(),
    /** Nombre minimal d'options : s'il en manque, complément tiré au prorata des taux. */
    min_items: z.number().int().positive().optional(),
    /**
     * Socle v2 : les `subscription` des options tirées s'ajoutent aux abonnements de la persona et sont
     * déduites du reste-à-vivre (recalculé). `{when}` : seulement si la condition est vraie (ex. payé de sa poche).
     * Sans ce drapeau, l'attribut reste une information de fiche. (Packs v1 : toujours déduits.)
     */
    affects_budget: z.union([z.boolean(), z.object({ when: conditionSchema }).strict()]).optional(),
  })
  .strict();
const numberAttr = z.object({ ...baseAttr, type: z.literal("number"), value: exprSchema, unit: z.string().optional() }).strict();
/** Booléen : `rate` = probabilité d'être vrai (tirage de Bernoulli), ou `value` = expression (vrai si non nulle). */
const boolAttr = z
  .object({
    ...baseAttr,
    type: z.literal("boolean"),
    rate: exprSchema.optional(),
    value: exprSchema.optional(),
    labels: z.object({ yes: z.string(), no: z.string() }).strict().optional(),
  })
  .strict()
  .refine((a) => (a.rate === undefined) !== (a.value === undefined), { message: "booléen : `rate` ou `value` (un seul)" });

export const attributeSchema = z.discriminatedUnion("type", [enumAttr, setAttr, numberAttr, boolAttr]);
export type ModuleAttribute = z.infer<typeof attributeSchema>;
export type EnumAttribute = z.infer<typeof enumAttr>;
export type SetAttribute = z.infer<typeof setAttr>;

// ── Fiche, segments, validation ─────────────────────────────────────────────

const cardLine = z.union([z.string(), z.object({ when: conditionSchema, template: z.string() }).strict()]);

const segmentSchema = z
  .object({
    /** Identifiant de la dimension d'analyse (stable : quotas, tableau de bord). */
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    attribute: attrKey,
    label: z.string(),
    /** Rang dans les comparaisons de variantes (absent : pas affiché par défaut). */
    compare: z.number().int().positive().optional(),
  })
  .strict();

/** Part d'une sous-population qui vérifie une condition, dans une fourchette (cible sourcée). */
const shareCheckSchema = z
  .object({
    label: z.string(),
    /** Sous-population (ex. personnes en emploi) ; absente = tous. */
    among: conditionSchema.optional(),
    /** Condition dont on mesure la part. */
    share_of: conditionSchema,
    range: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
  })
  .strict();

const plausibilitySchema = z
  .object({
    label: z.string().describe("gabarit ; {group} = libellé du groupe, {n} = effectif"),
    /** Valeur contrôlée : attribut numérique du module ou du socle (socle.monthly_income). */
    value: attrRef,
    group_by: attrKey,
    filter: conditionSchema.optional(),
    min_n: z.number().int().positive().default(8),
    /** Fourchettes de médiane par groupe… */
    median_in: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
    /** …ou fourchette relative à une table de référence (médiane ∈ [a × table, b × table]). */
    median_vs_table: z.object({ table: z.string(), range: z.tuple([z.number(), z.number()]) }).strict().optional(),
  })
  .strict()
  .refine((p) => (p.median_in ? 1 : 0) + (p.median_vs_table ? 1 : 0) === 1, { message: "plausibilité : median_in ou median_vs_table" });

export const moduleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "id en minuscules et tirets (ex. entrepreneuriat-tech)"),
    version: z.union([z.string(), z.number()]).transform(String),
    label: z.string(),
    /** Libellé court (préfixe d'affichage). */
    short_label: z.string().optional(),
    description: z.string().optional(),
    /** `legacy` : module archivé (modules/_archive), lisible pour l'historique, absent de la bibliothèque proposée. */
    status: z.enum(["active", "legacy"]).default("active"),
    /** Historique des versions (la plus récente d'abord). */
    changelog: z.array(z.object({ version: z.union([z.string(), z.number()]).transform(String), date: z.string(), changes: z.array(z.string()).min(1) }).strict()).default([]),
    applies_to: z.array(z.string()).min(1),
    requires: z.array(z.string()).default([]),
    sources: z.record(z.string(), sourceSchema).default({}),
    conditions: z.record(z.string(), conditionSchema).default({}),
    tables: z.record(z.string(), tableSchema).default({}),
    attributes: z.array(attributeSchema).min(1),
    /**
     * Remplacements du socle (un seul module actif peut en déclarer).
     * - Packs v1 (pack ciblé, flux du socle) : situation professionnelle complète (`activity_status`, `pcs`,
     *   `occupation_label`) et revenu, tirés en phase work.
     * - Socle v2 (flux par module) : `monthly_income` seul, éventuellement sous condition (`when`) ; le budget
     *   (impôt, prestations, niveau de vie, reste-à-vivre) est recalculé après le tirage des modules.
     */
    socle_overrides: z
      .object({
        activity_status: z.object({ from: attrKey, field: z.string().default("activity_status") }).strict().optional(),
        pcs: z.object({ from: attrKey, field: z.string().default("pcs") }).strict().optional(),
        monthly_income: z.object({ attr: attrKey, when: conditionSchema.optional() }).strict(),
        occupation_label: z.string().optional(),
        part_time: z.boolean().default(false),
        taxable: z.boolean().default(true),
      })
      .strict()
      .refine((o) => [o.activity_status, o.pcs, o.occupation_label].every((x) => x === undefined) || [o.activity_status, o.pcs, o.occupation_label].every((x) => x !== undefined), {
        message: "socle_overrides : activity_status, pcs et occupation_label vont ensemble (situation professionnelle complète, packs v1)",
      })
      .optional(),
    card: z.array(cardLine).default([]),
    /** Filtres d'éligibilité prêts à l'emploi pour une cible (phrases du langage de `target.eligibility`). */
    eligibility_helpers: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string()).default({}),
    segments: z.array(segmentSchema).default([]),
    validation: z
      .object({
        margins: z.array(z.object({ attribute: attrKey, title: z.string() }).strict()).default([]),
        plausibility: z.array(plausibilitySchema).default([]),
        shares: z.array(shareCheckSchema).default([]),
      })
      .strict()
      .default({ margins: [], plausibility: [], shares: [] }),
  })
  .strict();

export type ModuleDef = z.infer<typeof moduleSchema>;
