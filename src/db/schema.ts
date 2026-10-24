import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
const updatedAt = () =>
  text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    .$onUpdateFn(() => new Date().toISOString());

/** Abonnement en cours d'une persona. `household` : payé pour tout le ménage (box, streaming partagé). */
export interface PersonaSubscription {
  name: string;
  category: string;
  monthlyEur: number;
  household?: boolean;
}

/** Persona : attributs tirés statistiquement (jamais par le LLM) + récit. */
export const personas = sqliteTable(
  "personas",
  {
    id: id(),
    country: text("country").notNull(), // ISO 3166-1 alpha-2, ex. "FR"
    packVersion: text("pack_version").notNull(), // version du pack pays qui a servi au tirage
    seed: integer("seed"), // graine du tirage, pour la reproductibilité
    drawIndex: integer("draw_index"), // rang dans le tirage (graine, pack) : rend la génération idempotente
    firstName: text("first_name"), // prénom tiré dans le fichier des prénoms (cohorte de naissance)
    age: integer("age").notNull(),
    sex: text("sex").notNull(),
    region: text("region").notNull(),
    townSize: text("town_size").notNull(), // tranche de taille de commune
    occupation: text("occupation").notNull(), // libellé lisible (PCS, statut)
    activityStatus: text("activity_status"), // employed, unemployed, student, retired, inactive
    pcs: text("pcs"), // code PCS 2020 de niveau 1 (actuelle ou ancienne), null si jamais en emploi
    monthlyIncomeEur: integer("monthly_income_eur").notNull(), // revenu personnel net mensuel
    householdIncomeEur: integer("household_income_eur"), // revenu disponible mensuel du ménage
    householdSize: integer("household_size"),
    monthlyDiscretionaryBudgetEur: integer("monthly_discretionary_budget_eur").notNull(),
    householdType: text("household_type").notNull(),
    techAdoption: text("tech_adoption").notNull(), // profil de Rogers
    priceSensitivity: real("price_sensitivity").notNull(), // 0..1
    skepticism: real("skepticism").notNull(), // 0..1
    socialMediaUsage: text("social_media_usage").notNull(),
    equipment: text("equipment", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    subscriptions: text("subscriptions", { mode: "json" })
      .$type<PersonaSubscription[]>()
      .notNull()
      .default(sql`'[]'`),
    /** Attributs supplémentaires propres à un pack pays ou à une version ultérieure. */
    extra: text("extra", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    narrative: text("narrative"), // récit écrit par le LLM, cohérent avec les attributs
    narrativeBackend: text("narrative_backend"),
    narrativeModel: text("narrative_model"),
    narrativeAt: text("narrative_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("personas_country_idx").on(t.country, t.packVersion),
    index("personas_age_idx").on(t.age),
    // Pas d'unicité ici : deux jeux de modules tirés à la même graine donnent deux personas (suffixe -m<empreinte>
    // de personaIdFor) au même (pack, graine, rang). L'identité est la clé primaire `id` (migration 0005).
    index("personas_draw_idx").on(t.packVersion, t.seed, t.drawIndex),
  ],
);

/** Projet : l'idée testée. */
export const projects = sqliteTable("projects", {
  id: id(),
  name: text("name").notNull(),
  pitch: text("pitch").notNull(),
  targetAudience: text("target_audience"),
  businessModel: text("business_model"),
  priceEur: real("price_eur"),
  pricePeriod: text("price_period"), // "month", "year", "once"...
  freeOffer: text("free_offer"), // offre gratuite éventuelle (freemium, essai), telle que l'utilisateur la verrait
  competitors: text("competitors", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  alternatives: text("alternatives", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
  extra: text("extra", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const STUDY_STATUSES = ["draft", "running", "paused", "completed", "failed"] as const;
export type StudyStatus = (typeof STUDY_STATUSES)[number];

/** Population d'une étude : un groupe tiré dans un pack de personas. */
export interface StudyPopulation {
  group: string; // "target", "control"
  packVersion: string;
  n: number;
  quotas?: Record<string, Record<string, number>>;
}

/** Moteur d'une étude (docs/plateforme.md § 7.4), figé à la création ; `reportedModel` au premier appel. */
export interface StudyEngineInfo {
  /** Fournisseur (claude-cli, ollama, anthropic, openai…). */
  provider: string;
  /** Modèle demandé (celui du profil ou de l'option). */
  model: string;
  /** Modèle exact rapporté par l'API à la première réponse. */
  reportedModel?: string;
  /** Profil de moteur (claude-cli, ollama : profils intégrés). */
  profile: string;
  /** Version de Personas qui a créé l'étude. */
  personasVersion: string;
  temperature?: number;
}

export interface StudyExtra extends Record<string, unknown> {
  engine?: StudyEngineInfo;
}

/** Étude : un projet, un échantillon, un protocole, un moteur. */
export const studies = sqliteTable(
  "studies",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    protocol: text("protocol").notNull(), // "concept", "price", "interview"...
    protocolVersion: text("protocol_version").notNull().default("1"),
    status: text("status", { enum: STUDY_STATUSES }).notNull().default("draft"),
    backend: text("backend").notNull(),
    model: text("model").notNull(),
    seed: integer("seed").notNull(),
    sampleSize: integer("sample_size").notNull(),
    quotas: text("quotas", { mode: "json" }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`),
    /** Personas tirées pour l'échantillon, figées au lancement. */
    personaIds: text("persona_ids", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    /** Étude dont l'échantillon a été repris (comparaison entre moteurs sur les mêmes personas). */
    sampleFromStudyId: text("sample_from_study_id"),
    /** Populations tirées (groupe cible, groupe témoin…) : pack, effectif, quotas. */
    populations: text("populations", { mode: "json" }).$type<StudyPopulation[]>().notNull().default(sql`'[]'`),
    /** Groupe de chaque persona de l'échantillon (id → "target" | "control"). Vide : tout l'échantillon est un seul groupe. */
    personaGroups: text("persona_groups", { mode: "json" }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
    /** Champs ajoutés plus tard : `engine` (moteur figé à la création, docs/plateforme.md § 7.4). */
    extra: text("extra", { mode: "json" }).$type<StudyExtra>().notNull().default(sql`'{}'`),
    progressDone: integer("progress_done").notNull().default(0),
    progressTotal: integer("progress_total").notNull().default(0),
    error: text("error"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("studies_project_idx").on(t.projectId)],
);

/** Réponse : une par persona et par question ; écrite dès qu'elle arrive. */
export const responses = sqliteTable(
  "responses",
  {
    id: id(),
    studyId: text("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "cascade" }),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id),
    questionKey: text("question_key").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(), // JSON validé
    rawText: text("raw_text"),
    backend: text("backend").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    durationMs: integer("duration_ms").notNull(),
    attempts: integer("attempts").notNull().default(1),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** Le récit de la persona était-il disponible et injecté dans le prompt ? */
    narrativeUsed: integer("narrative_used", { mode: "boolean" }).notNull().default(false),
    /** Une réparation de cohérence a-t-elle été demandée ? */
    repaired: integer("repaired", { mode: "boolean" }).notNull().default(false),
    /** Incohérences restantes après réparation (codes des contrôles), vide si la réponse est cohérente. */
    anomalies: text("anomalies", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (t) => [
    // Rend l'étude reprenable : une relance ne refait que ce qui manque.
    uniqueIndex("responses_study_persona_question_uq").on(t.studyId, t.personaId, t.questionKey),
  ],
);

/**
 * Usage des moteurs (docs/plateforme.md § 7.3) : une ligne par appel, coût = usage × prix du modèle
 * (pricing/models.json ; 0 en local, null si le prix est inconnu). Sert au plafond de dépense
 * (BudgetGuard : par étude, par jour, par mois et par profil) et aux moyennes de l'estimation.
 */
export const engineUsage = sqliteTable(
  "engine_usage",
  {
    id: id(),
    profile: text("profile").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    studyId: text("study_id"),
    /** Jour et mois UTC de l'appel (AAAA-MM-JJ, AAAA-MM), pour les plafonds journalier et mensuel. */
    day: text("day").notNull(),
    month: text("month").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    /** Coût rapporté par le fournisseur (claude-cli : équivalent API). */
    reportedCostUsd: real("reported_cost_usd"),
    createdAt: createdAt(),
  },
  (t) => [index("engine_usage_study_idx").on(t.studyId), index("engine_usage_profile_day_idx").on(t.profile, t.day), index("engine_usage_profile_month_idx").on(t.profile, t.month)],
);

/** Rapport : agrégation par segment, exportée en Markdown puis PDF. */
export const reports = sqliteTable(
  "reports",
  {
    id: id(),
    studyId: text("study_id")
      .notNull()
      .references(() => studies.id, { onDelete: "cascade" }),
    format: text("format", { enum: ["markdown", "pdf"] }).notNull().default("markdown"),
    title: text("title").notNull(),
    content: text("content"), // Markdown
    aggregates: text("aggregates", { mode: "json" }).$type<Record<string, unknown>>(),
    filePath: text("file_path"), // PDF exporté
    backend: text("backend"),
    model: text("model"),
    createdAt: createdAt(),
  },
  (t) => [index("reports_study_idx").on(t.studyId)],
);

export type Persona = typeof personas.$inferSelect;
export type NewPersona = typeof personas.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type Study = typeof studies.$inferSelect;
export type ResponseRow = typeof responses.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type EngineUsageRow = typeof engineUsage.$inferSelect;
