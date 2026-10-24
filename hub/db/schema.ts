import { sql } from "drizzle-orm";
import { boolean, check, customType, date, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { QualityScore } from "../../src/hub/contract";

/**
 * Schéma Postgres du Hub (phase 2 : catalogue public et publication d'administration).
 * Tout vit dans le schéma dédié `personas_hub` : le Postgres est partagé avec d'autres applications
 * (Supabase auto-hébergé), on ne touche à aucune autre table. Voir docs/plateforme.md § 3.
 *
 * Phase 3 (Hub collaboratif) : comptes Supabase (`users`), jetons personnels, flux d'appareil,
 * étoiles, avis, signalements, événements de modération, télémétrie agrégée ; colonnes de signature,
 * de lint et d'auteur sur les versions. Migrations additives (0002).
 */
export const hub = pgSchema("personas_hub");

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Statut d'une version (contrat : published, unverified, verified, yanked, flagged, removed).
 * `flagged` : exclue de l'index et de la recherche, accessible par lien direct ; `removed` : téléchargement refusé.
 */
export type VersionStatus = "published" | "unverified" | "verified" | "yanked" | "flagged" | "removed";
/** Statuts absents de l'index et de la recherche (la version reste lisible par sa référence exacte, sauf `removed`). */
export const UNLISTED_STATUSES: readonly VersionStatus[] = ["yanked", "flagged", "removed"];

export type UserRole = "user" | "moderator" | "admin";

/**
 * Comptes : un utilisateur Supabase Auth (id = `sub` du JWT), créé au premier appel authentifié.
 * Jamais supprimé physiquement : la suppression de compte efface e-mail, nom et GitHub (`deleted_at`),
 * les versions publiées restent attribuées à « auteur supprimé ».
 */
export const users = hub.table(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email"),
    displayName: text("display_name"),
    githubId: text("github_id"),
    githubLogin: text("github_login"),
    role: text("role").$type<UserRole>().notNull().default("user"),
    /** Namespace personnel (réservé à la création, modifiable une fois tant qu'il est vide). */
    namespace: text("namespace").notNull(),
    namespaceChanged: boolean("namespace_changed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email").on(t.email), uniqueIndex("users_namespace").on(t.namespace)],
);

export const namespaces = hub.table("namespaces", {
  slug: text("slug").primaryKey(),
  /** Propriétaire (phase 3, utilisateurs Supabase) ; nul pour les namespaces d'administration. */
  ownerUserId: uuid("owner_user_id").references((): AnyPgColumn => users.id),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const modules = hub.table(
  "modules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: text("namespace")
      .notNull()
      .references(() => namespaces.slug),
    slug: text("slug").notNull(),
    /** Libellé et description de la dernière version publiée (affichage, recherche). */
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    /** active, deprecated, hidden. */
    status: text("status").notNull().default("active"),
    forkedFromVersionId: uuid("forked_from_version_id").references((): AnyPgColumn => moduleVersions.id),
    starCount: integer("star_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("modules_ns_slug").on(t.namespace, t.slug)],
);

/** Aperçu enregistré à la publication (marges principales, alertes), pour la page publique. */
export interface StoredPreview {
  socle: string;
  n: number;
  margins: Array<{ attribute: string; label: string; type: string; applicable: number; values: Array<{ code: string; label: string; share: number }> }>;
  alerts: Array<{ level: string; message: string; attribute?: string }>;
  checks: { total: number; passed: number };
  /** Format de l'aperçu (absent : format 1, sans parts des filtres). Voir PREVIEW_FORMAT (src/module-check.ts). */
  previewFormat?: number;
  /** Filtres prêts à l'emploi (format 2) : nom, phrase, libellé en clair (fr), part des personas virtuelles concernées. */
  eligibilityHelpers?: Array<{ name: string; expression: string; label: string; rate: number }>;
}

export const moduleVersions = hub.table(
  "module_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id),
    version: text("version").notNull(),
    /** Texte YAML exact publié (immuable). */
    yaml: text("yaml").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status").$type<VersionStatus>().notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    appliesTo: text("applies_to").array().notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    attributes: jsonb("attributes").$type<Array<{ key: string; label: string }>>().notNull(),
    requires: jsonb("requires").$type<Array<{ ref: string; version: string; as: string }>>().notNull(),
    license: text("license").notNull().default("CC-BY-4.0"),
    engineMin: text("engine_min"),
    /** Score Q (formule q1) ; nul si l'aperçu n'a pas pu être calculé (module archivé). */
    quality: jsonb("quality").$type<QualityScore>(),
    preview: jsonb("preview").$type<StoredPreview>(),
    /** Texte indexé : titre (poids A) et corps (poids B : description, attributs, valeurs, segments). */
    searchTitle: text("search_title").notNull(),
    searchBody: text("search_body").notNull(),
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('french', coalesce(search_title, '')), 'A') || setweight(to_tsvector('english', coalesce(search_title, '')), 'A') || setweight(to_tsvector('french', coalesce(search_body, '')), 'B') || setweight(to_tsvector('english', coalesce(search_body, '')), 'B')`,
      ),
    // TODO phase 2b : `embedding vector(384)` (pgvector, carte du module, multilingual-e5-small sur CPU).
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    /** Auteur (phase 3) ; nul pour une publication d'administration. */
    publishedBy: uuid("published_by").references(() => users.id),
    /** Signature Ed25519 du Hub (base64) sur {ref, version, sha256, publishedAt}, et identifiant de clé. */
    signature: text("signature"),
    signatureKid: text("signature_kid"),
    /** Résultat du lint de sécurité à la publication (alertes non bloquantes, moteur de lint). */
    lint: jsonb("lint").$type<StoredLint>(),
    /** Attributs déclarés `sensitive: true` (badge « sensible »). */
    sensitive: text("sensitive").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex("module_versions_module_version").on(t.moduleId, t.version), index("module_versions_search").using("gin", t.search)],
);

export const moduleDeps = hub.table(
  "module_deps",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => moduleVersions.id),
    ref: text("ref").notNull(),
    version: text("version").notNull(),
    alias: text("alias").notNull(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.alias] })],
);

export const packs = hub.table(
  "packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: text("namespace")
      .notNull()
      .references(() => namespaces.slug),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    country: text("country").notNull(),
    locale: text("locale").notNull(),
    generator: text("generator").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("packs_ns_slug").on(t.namespace, t.slug)],
);

export const packVersions = hub.table(
  "pack_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packId: uuid("pack_id")
      .notNull()
      .references(() => packs.id),
    version: text("version").notNull(),
    /** Version de base (`fr-2026.1`) dont les tables absentes sont reprises ; nul pour un pack complet. */
    extends: text("extends"),
    /** Fichiers JSON du pack, texte exact par nom de fichier (immuables). */
    files: jsonb("files").$type<Record<string, string>>().notNull(),
    sha256: text("sha256").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<VersionStatus>().notNull(),
    license: text("license").notNull().default("CC-BY-4.0"),
    engineMin: text("engine_min"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    publishedBy: uuid("published_by").references(() => users.id),
    signature: text("signature"),
    signatureKid: text("signature_kid"),
  },
  (t) => [uniqueIndex("pack_versions_pack_version").on(t.packId, t.version)],
);

export interface StoredLint {
  /** Lint appliqué (src/modules/lint.ts). */
  engine: "shared";
  warnings: Array<{ path?: string; message: string }>;
}

export type TokenScope = "read" | "modules:publish" | "packs:publish" | "moderation";

/** Jetons personnels (`pst_` + 32 octets) : seule l'empreinte sha256 est stockée. */
export const apiTokens = hub.table(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    /** Début du jeton, affiché pour le reconnaître (`pst_ab12cd`). */
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    scopes: text("scopes").array().$type<TokenScope[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_tokens_hash").on(t.hash), index("api_tokens_user").on(t.userId)],
);

/** Flux d'appareil de `personas hub login` (code d'appareil haché, code utilisateur court). */
export const deviceCodes = hub.table(
  "device_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCode: text("user_code").notNull(),
    clientName: text("client_name").notNull(),
    scopes: text("scopes").array().$type<TokenScope[]>().notNull(),
    intervalSec: integer("interval_sec").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deniedAt: timestamp("denied_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    tokenId: uuid("token_id").references(() => apiTokens.id),
  },
  (t) => [uniqueIndex("device_codes_hash").on(t.deviceCodeHash), uniqueIndex("device_codes_user_code").on(t.userCode)],
);

export const stars = hub.table(
  "stars",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.moduleId] })],
);

/** Avis sur une version : un par utilisateur et par version, modifiable. */
export const reviews = hub.table(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => moduleVersions.id),
    rating: integer("rating").notNull(),
    body: text("body").notNull().default(""),
    /** Masqué par la modération (ou 3 signalements). */
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reviews_user_version").on(t.userId, t.versionId), index("reviews_version").on(t.versionId), check("reviews_rating", sql`${t.rating} between 1 and 5`)],
);

export type ReportTargetKind = "module_version" | "pack_version" | "review";

/** Signalements : un par utilisateur et par cible. */
export const reports = hub.table(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id),
    targetKind: text("target_kind").$type<ReportTargetKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    body: text("body").notNull().default(""),
    /** open, triaged, closed. */
    state: text("state").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reports_reporter_target").on(t.reporterId, t.targetKind, t.targetId), index("reports_target").on(t.targetKind, t.targetId)],
);

/** Journal de modération (agent, administrateur, système), avec les preuves. Jamais modifié. */
export const moderationEvents = hub.table(
  "moderation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetKind: text("target_kind").$type<ReportTargetKind>().notNull(),
    targetId: uuid("target_id").notNull(),
    /** agent, admin, moderator, system. */
    actor: text("actor").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    /** verify, flag, yank, remove, restore. */
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("moderation_events_target").on(t.targetKind, t.targetId)],
);

/** Télémétrie agrégée par version et par jour (aucun projet, aucun pitch). */
export const usageDaily = hub.table(
  "usage_daily",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => moduleVersions.id),
    day: date("day", { mode: "string" }).notNull(),
    installs: integer("installs").notNull().default(0),
    studies: integer("studies").notNull().default(0),
    personas: integer("personas").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.day] })],
);

/**
 * Dédoublonnage des installations du jour : empreinte de l'identifiant d'installation tournant
 * (jamais lié au compte), purgée après 30 jours.
 */
export const usageInstalls = hub.table(
  "usage_installs",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => moduleVersions.id),
    day: date("day", { mode: "string" }).notNull(),
    installHash: text("install_hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.day, t.installHash] })],
);

export const schema = { namespaces, modules, moduleVersions, moduleDeps, packs, packVersions, users, apiTokens, deviceCodes, stars, reviews, reports, moderationEvents, usageDaily, usageInstalls };
