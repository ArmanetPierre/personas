// Contrat HTTP du Hub (phase 2, lecture seule + publication d'administration).
// Partagé par le service Hub (hub/) et le client du runner (src/hub/client…).
// Toute évolution est additive ; un changement cassant passe par /v2.
import { z } from "zod";

export const HUB_API_VERSION = "v1";

/** Namespace : minuscules, chiffres, tirets. `personas` est réservé aux modules officiels. */
export const namespaceSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
export const OFFICIAL_NAMESPACE = "personas";

/** Référence qualifiée `namespace/slug`, version à part (`@version`). */
export const qualifiedRef = z.string().regex(/^[a-z0-9-]+\/[a-z0-9][a-z0-9-]*$/);
export const versionString = z.string().min(1).max(32);
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** Décomposition du score de qualité Q (docs/plateforme.md §5.1, formule « q1 »). */
export const qualityScore = z.object({
  formula: z.literal("q1"),
  q: z.number().min(0).max(100),
  sourcing: z.number().min(0).max(1),
  margins: z.number().min(0).max(1),
  alerts: z.number().min(0).max(1),
  docs: z.number().min(0).max(1),
});
export type QualityScore = z.infer<typeof qualityScore>;

/** `flagged` et `removed` : ajouts additifs de la phase 3 (modération ; `removed` : téléchargement refusé). */
export const versionStatus = z.enum(["published", "unverified", "verified", "yanked", "flagged", "removed"]);

export const moduleVersionSummary = z.object({
  version: versionString,
  sha256: sha256Hex, // empreinte du texte YAML exact publié
  publishedAt: z.string(), // ISO 8601
  status: versionStatus,
  quality: qualityScore.nullable(),
});

export const catalogModule = z.object({
  ref: qualifiedRef,
  label: z.string(),
  description: z.string(),
  appliesTo: z.array(z.string()), // socles : fr, sg…
  /** Langue du contenu, celle du (premier) socle d'après le manifeste de son pack : fr, en… (ajout additif). */
  locale: z.string().optional(),
  tags: z.array(z.string()),
  attributes: z.array(z.object({ key: z.string(), label: z.string() })),
  latest: versionString,
  versions: z.array(moduleVersionSummary),
});
export type CatalogModule = z.infer<typeof catalogModule>;

export const catalogPack = z.object({
  ref: qualifiedRef, // ex. personas/sg
  label: z.string(),
  country: z.string(),
  locale: z.string(),
  /** Générateur du socle (fr, sg) : le socle auquel le pack se rattache (ajout additif). */
  generator: z.string().optional(),
  latest: versionString, // ex. sg-2026.2
  versions: z.array(z.object({ version: versionString, sha256: sha256Hex, publishedAt: z.string(), extends: z.string().nullable() })),
});

/** GET /v1/catalog : index complet, petit, mis en cache par le runner (ETag). */
export const catalogResponse = z.object({
  apiVersion: z.literal(HUB_API_VERSION),
  generatedAt: z.string(),
  modules: z.array(catalogModule),
  packs: z.array(catalogPack),
});
export type CatalogResponse = z.infer<typeof catalogResponse>;

/** GET /v1/modules/:ns/:slug/:version : contenu exact d'une version immuable. */
export const moduleVersionResponse = z.object({
  ref: qualifiedRef,
  version: versionString,
  sha256: sha256Hex,
  yaml: z.string(),
  requires: z.array(z.object({ ref: qualifiedRef, version: versionString, as: z.string() })),
  quality: qualityScore.nullable(),
  publishedAt: z.string(),
  status: versionStatus,
  license: z.string(), // CC-BY-4.0 par défaut
});
export type ModuleVersionResponse = z.infer<typeof moduleVersionResponse>;

/** GET /v1/packs/:ns/:slug/:version : fichiers JSON du pack (tables), texte exact. */
export const packVersionResponse = z.object({
  ref: qualifiedRef,
  version: versionString,
  sha256: sha256Hex, // empreinte de la concaténation canonique : noms triés, "name\n" + contenu + "\n"
  files: z.record(z.string(), z.string()),
  extends: z.string().nullable(),
  license: z.string(),
});

/**
 * GET /v1/search?q=&socle=&lang=&limit= : modules classés. `lang` (facultatif, ajout additif) : langue
 * du contenu (fr, en), dérivée des socles du module et des manifestes des packs.
 */
export const searchResponse = z.object({
  query: z.string(),
  results: z.array(z.object({ ref: qualifiedRef, latest: versionString, label: z.string(), description: z.string(), appliesTo: z.array(z.string()), locale: z.string().optional(), q: z.number().nullable(), score: z.number() })),
});

/** POST /v1/admin/modules (Authorization: Bearer <jeton d'administration>). */
export const publishModuleRequest = z.object({ namespace: namespaceSlug, yaml: z.string().max(256 * 1024) });
/** POST /v1/admin/packs. */
export const publishPackRequest = z.object({ namespace: namespaceSlug, slug: z.string(), version: versionString, files: z.record(z.string(), z.string()), extends: z.string().nullable() });
export const publishResponse = z.object({ ref: qualifiedRef, version: versionString, sha256: sha256Hex, quality: qualityScore.nullable() });

/** Erreurs : { error: { code, message } } avec codes stables. */
export const hubError = z.object({
  error: z.object({ code: z.enum(["not_found", "invalid", "conflict", "unauthorized", "rate_limited", "internal"]), message: z.string() }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 : Hub collaboratif (ajouts additifs). Authentification : `Authorization: Bearer <jeton>`,
// soit un JWT Supabase Auth (session web), soit un jeton personnel `pst_…` (CLI, API).
// ─────────────────────────────────────────────────────────────────────────────

/** Portées d'un jeton personnel. `moderation` : réservée aux rôles moderator et admin. */
export const hubScope = z.enum(["read", "modules:publish", "packs:publish", "moderation"]);
export type HubScope = z.infer<typeof hubScope>;
export const DEFAULT_TOKEN_SCOPES: HubScope[] = ["read", "modules:publish", "packs:publish"];
export const TOKEN_MAX_DAYS = 90;

/** Signature Ed25519 d'une version par le Hub, sur `signedPayload(…)` (voir GET /v1/keys). */
export const versionSignature = z.object({ alg: z.literal("Ed25519"), kid: z.string(), value: z.string() });
export type VersionSignature = z.infer<typeof versionSignature>;

/**
 * Texte exact signé par le Hub : JSON compact, clés dans cet ordre. `publishedAt` est la valeur ISO
 * renvoyée par l'API (millisecondes, suffixe Z) ; `ref` est `namespace/slug` (module ou pack).
 */
export function signedPayload(f: { ref: string; version: string; sha256: string; publishedAt: string }): string {
  return JSON.stringify({ ref: f.ref, version: f.version, sha256: f.sha256, publishedAt: f.publishedAt });
}

/** GET /v1/keys : clés publiques de signature (la première est la clé courante). */
export const hubKeysResponse = z.object({
  keys: z.array(z.object({ kid: z.string(), alg: z.literal("Ed25519"), publicKey: z.string(), jwk: z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string(), kid: z.string() }) })),
  payload: z.string(),
});

/** Badges d'une version : official, verified, unverified, sensitive, fork. */
export const moduleBadge = z.enum(["official", "verified", "unverified", "sensitive", "fork"]);

/** Filiation d'un fork : version d'origine (`ns/slug@version`). */
export const forkOrigin = z.object({ ref: qualifiedRef, version: versionString });

/** Champs additifs d'une version de module (GET /v1/modules/:ns/:slug/:version, publication). */
export const moduleVersionExtras = z.object({
  signature: versionSignature.nullable().optional(),
  forkedFrom: forkOrigin.nullable().optional(),
  /** Nom affiché de l'auteur ; « auteur supprimé » après suppression de compte ; nul : publication d'administration. */
  author: z.string().nullable().optional(),
  badges: z.array(moduleBadge).optional(),
  /** Attributs déclarés `sensitive: true`. */
  sensitive: z.array(z.string()).optional(),
});
export const moduleVersionResponseV3 = moduleVersionResponse.extend(moduleVersionExtras.shape);
export const packVersionResponseV3 = packVersionResponse.extend({ status: versionStatus.optional(), publishedAt: z.string().optional(), signature: versionSignature.nullable().optional() });

/** Classement R (docs/plateforme.md § 5.2) et compteurs sociaux, ajoutés aux cartes et résultats. */
export const moduleRanking = z.object({
  r: z.number(),
  /** Composantes de R : u (usage), e (étoiles), n (avis, moyenne bayésienne ramenée sur [0, 1]). */
  components: z.object({ q: z.number(), u: z.number(), e: z.number(), n: z.number(), verifiedBonus: z.number() }),
  stars: z.number().int(),
  reviews: z.object({ count: z.number().int(), mean: z.number().nullable() }),
  /** Installations-jours sur 90 jours (télémétrie acceptée). */
  usage90: z.number().int(),
  status: versionStatus,
  badges: z.array(moduleBadge),
  forkedFrom: forkOrigin.nullable(),
});
export const R_WEIGHTS = { q: 0.45, usage: 0.25, stars: 0.15, reviews: 0.15, verifiedBonus: 0.05 } as const;
/** Moyenne bayésienne des avis : (C·m + Σ notes) / (C + n). */
export const REVIEW_PRIOR = { m: 3, c: 5 } as const;

export const catalogModuleV3 = catalogModule.extend({ ranking: moduleRanking.optional() });
/**
 * Langue mise en avant (ajout additif, 2026-10-20) : `GET /v1/search?prefer=en|fr` et
 * `GET /v1/catalog?prefer=en|fr` placent d'abord les modules dont un socle est dans cette langue, puis
 * les autres, chaque groupe dans l'ordre habituel (R par défaut, ou Q). Ce n'est pas un filtre ; `lang=`
 * reste le filtre. Sans `prefer`, l'ordre ne change pas pour les clients existants.
 */
export const preferLang = z.enum(["fr", "en"]);
export const rankedSearchResponse = z.object({
  query: z.string(),
  /** Tri : `r` (défaut, classement R) ou `q` (score de qualité). */
  sort: z.enum(["r", "q"]).optional(),
  /** Langue mise en avant, si demandée (`prefer=`). */
  prefer: preferLang.optional(),
  results: z.array(searchResponse.shape.results.element.extend({ ranking: moduleRanking.optional() })),
});

// ── Compte, jetons, flux d'appareil ─────────────────────────────────────────

export const meResponse = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  githubLogin: z.string().nullable(),
  role: z.enum(["user", "moderator", "admin"]),
  namespace: namespaceSlug,
  /** Le namespace peut encore être changé (une fois, tant qu'il ne contient rien). */
  namespaceChangeable: z.boolean(),
  createdAt: z.string(),
  /** Mode d'authentification de la requête. */
  via: z.enum(["jwt", "token"]),
  scopes: z.array(hubScope),
});
export const updateMeRequest = z.object({ displayName: z.string().trim().min(1).max(80).optional(), namespace: namespaceSlug.optional() }).strict();

export const tokenInfo = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(hubScope),
  createdAt: z.string(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export const createTokenRequest = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(hubScope).min(1).default(DEFAULT_TOKEN_SCOPES), expiresInDays: z.number().int().min(1).max(TOKEN_MAX_DAYS).default(TOKEN_MAX_DAYS) }).strict();
/** Le jeton en clair n'est renvoyé qu'une fois, à la création. */
export const createTokenResponse = tokenInfo.extend({ token: z.string() });
export const tokenListResponse = z.object({ tokens: z.array(tokenInfo) });

/** POST /v1/device/code (anonyme). */
export const deviceCodeRequest = z.object({ clientName: z.string().trim().min(1).max(80).optional(), scopes: z.array(hubScope).min(1).optional() }).strict();
export const deviceCodeResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number().int(),
  interval: z.number().int(),
});
/** POST /v1/device/lookup et /v1/device/approve (JWT d'une session web). */
export const deviceLookupRequest = z.object({ user_code: z.string().min(4).max(16) }).strict();
export const deviceApproveRequest = z.object({ user_code: z.string().min(4).max(16), approve: z.boolean().default(true) }).strict();
export const deviceInfoResponse = z.object({ clientName: z.string(), scopes: z.array(hubScope), expiresAt: z.string(), state: z.enum(["pending", "approved", "denied", "consumed", "expired"]) });
/** POST /v1/device/token : 200 approved ; 202 authorization_pending | slow_down ; 410 access_denied | expired_token ; 404 code inconnu. */
export const deviceTokenRequest = z.object({ device_code: z.string().min(16).max(128) }).strict();
export const deviceTokenResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved"), token: z.string(), tokenType: z.literal("bearer"), id: z.string(), prefix: z.string(), scopes: z.array(hubScope), expiresAt: z.string() }),
  z.object({ status: z.enum(["authorization_pending", "slow_down"]), interval: z.number().int() }),
  z.object({ status: z.enum(["access_denied", "expired_token"]), message: z.string() }),
]);

// ── Publication par les utilisateurs, forks ─────────────────────────────────

/** POST /v1/modules (portée modules:publish) : namespace de l'appelant par défaut. */
export const userPublishModuleRequest = z.object({ yaml: z.string().max(256 * 1024), namespace: namespaceSlug.optional() }).strict();
/** POST /v1/packs (portée packs:publish) : versions de packs, données seulement (générateur existant). */
export const userPublishPackRequest = z.object({ slug: z.string(), version: versionString, files: z.record(z.string(), z.string()), extends: z.string().nullable(), namespace: namespaceSlug.optional() }).strict();
export const userPublishResponse = publishResponse.extend({
  status: versionStatus.optional(),
  publishedAt: z.string().optional(),
  signature: versionSignature.nullable().optional(),
  forkedFrom: forkOrigin.nullable().optional(),
  sensitive: z.array(z.string()).optional(),
  /** Alertes non bloquantes du lint de sécurité. */
  warnings: z.array(z.object({ path: z.string().optional(), message: z.string() })).optional(),
});
/** POST /v1/modules/:ns/:slug/fork : copie de la dernière version (ou `version`) dans le namespace de l'appelant. */
export const forkRequest = z.object({ version: versionString.optional(), slug: z.string().regex(/^[a-z][a-z0-9-]*$/).max(64).optional() }).strict();

// ── Étoiles, avis, signalements ─────────────────────────────────────────────

export const starResponse = z.object({ ref: qualifiedRef, starred: z.boolean(), stars: z.number().int() });
export const reviewRequest = z.object({ rating: z.number().int().min(1).max(5), body: z.string().max(1000).default("") }).strict();
export const reviewItem = z.object({ id: z.string(), version: versionString, rating: z.number().int(), body: z.string(), author: z.string(), createdAt: z.string(), updatedAt: z.string() });
export const reviewListResponse = z.object({ ref: qualifiedRef, version: versionString, count: z.number().int(), mean: z.number().nullable(), reviews: z.array(reviewItem) });

export const reportReason = z.enum(["malicious", "injection", "sensitive", "rights", "other"]);
export const reportTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("module_version"), ref: qualifiedRef, version: versionString }),
  z.object({ kind: z.literal("pack_version"), ref: qualifiedRef, version: versionString }),
  z.object({ kind: z.literal("review"), id: z.string().uuid() }),
]);
export const reportRequest = z.object({ target: reportTarget, reason: reportReason, body: z.string().max(1000).default("") }).strict();
export const reportResponse = z.object({ id: z.string(), reports: z.number().int(), status: z.string() });

// ── Modération (portée moderation, ou jeton d'administration) ───────────────

export const reviewQueueItem = z.object({
  kind: z.enum(["module_version", "pack_version", "review"]),
  id: z.string(),
  ref: z.string().nullable(),
  version: z.string().nullable(),
  status: z.string(),
  publishedAt: z.string(),
  author: z.string().nullable(),
  /** YAML du module, fichiers du pack, ou texte de l'avis. */
  content: z.unknown(),
  lint: z.unknown().nullable(),
  sensitive: z.array(z.string()),
  reports: z.array(z.object({ id: z.string(), reason: z.string(), body: z.string(), state: z.string(), createdAt: z.string() })),
});
export const reviewQueueResponse = z.object({ items: z.array(reviewQueueItem) });
export const moderationAction = z.enum(["verify", "flag", "yank", "remove", "restore"]);
export const moderationEventRequest = z
  .object({
    target: z.union([reportTarget, z.object({ kind: z.enum(["module_version", "pack_version", "review"]), id: z.string().uuid() })]),
    action: moderationAction,
    /** Preuves (obligatoires) : extraits, règles déclenchées, scores de l'agent… */
    evidence: z.record(z.string(), z.unknown()).refine((e) => Object.keys(e).length > 0, { message: "preuves obligatoires" }),
    note: z.string().max(2000).optional(),
    /** `agent` : l'agent de modération automatique se déclare comme tel. */
    actor: z.enum(["agent", "admin", "moderator"]).optional(),
  })
  .strict();
export const moderationEventResponse = z.object({ id: z.string(), targetKind: z.string(), targetId: z.string(), action: moderationAction, fromStatus: z.string().nullable(), toStatus: z.string().nullable() });

// ── Télémétrie (opt-in, anonyme) ────────────────────────────────────────────

/**
 * POST /v1/telemetry : agrégats par étude terminée, sans aucun texte libre (schéma strict : tout champ
 * inconnu, comme un pitch ou un projet, est refusé). `installId` : identifiant d'installation tournant
 * (renouvelé chaque mois), jamais lié au compte. `modules` : `ns/slug@version` (ou `slug@version` pour `personas/`).
 */
export const telemetryRequest = z
  .object({
    installId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    studies: z
      .array(
        z
          .object({
            modules: z.array(z.string().regex(/^(?:[a-z0-9-]+\/)?[a-z0-9][a-z0-9-]*@[0-9A-Za-z._-]{1,32}$/)).max(50),
            socle: z.string().regex(/^[a-z0-9-]{1,40}$/),
            personas: z.number().int().min(1).max(100_000),
            protocol: z.string().regex(/^[a-z0-9-]{1,40}$/),
            engineVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/),
            modelFamily: z.string().regex(/^[a-z0-9.-]{1,60}$/),
            day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export const telemetryResponse = z.object({ accepted: z.number().int(), ignored: z.number().int() });

// ── Conditions d'utilisation et confidentialité ─────────────────────────────

export const legalDocName = z.enum(["terms", "privacy"]);
export const legalLang = z.enum(["fr", "en"]);
export const legalDocResponse = z.object({ doc: legalDocName, lang: legalLang, version: z.string(), markdown: z.string() });
export const legalIndexResponse = z.object({ docs: z.array(z.object({ doc: legalDocName, lang: legalLang, version: z.string(), path: z.string() })) });
