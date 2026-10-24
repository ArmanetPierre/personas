import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { JSONWebKeySet, JWTPayload } from "jose";
import { createJwtVerifier, JwtError } from "../../src/auth/supabase-jwt";
import { DEFAULT_TOKEN_SCOPES, namespaceSlug, OFFICIAL_NAMESPACE, type HubScope } from "../../src/hub/contract";
import type { HubDb } from "../db/client";
import { apiTokens, namespaces, users, type UserRole } from "../db/schema";
import { PublishError } from "./module-check";

/**
 * Authentification du Hub (phase 3).
 *
 * - **Session web** : JWT de Supabase Auth (`Authorization: Bearer <access_token>`), vérifié par JWKS
 *   (clés asymétriques de Supabase) ou par le secret HS256 (SUPABASE_JWT_SECRET, mode historique),
 *   avec contrôle de l'émetteur, de l'audience et de l'expiration. Inscriptions fermées : le Hub n'a
 *   aucun endpoint d'inscription ; il accepte tout utilisateur valide de Supabase (les comptes sont invités par l'administrateur).
 * - **Jeton personnel** (CLI, API) : `pst_` + 32 octets aléatoires, stocké haché (sha256), avec portées,
 *   expiration et révocation.
 *
 * L'utilisateur est créé au premier appel authentifié par JWT (id = `sub`), avec un namespace personnel.
 */

export interface AuthConfig {
  /** https://supabase.example.org : émetteur `<url>/auth/v1`, JWKS `<url>/auth/v1/.well-known/jwks.json`. */
  supabaseUrl?: string | undefined;
  /** Secret HS256 du projet Supabase (mode historique). */
  jwtSecret?: string | undefined;
  /** URL JWKS explicite (sinon dérivée de supabaseUrl quand aucun secret n'est donné). */
  jwksUrl?: string | undefined;
  /** Jeu de clés local (tests, hors ligne). */
  jwks?: JSONWebKeySet | undefined;
  issuer?: string | undefined;
  /** Audience attendue (Supabase : `authenticated`). */
  audience?: string | undefined;
  /** E-mails ou ids Supabase des administrateurs et des modérateurs (HUB_ADMINS, HUB_MODERATORS). */
  admins?: string[] | undefined;
  moderators?: string[] | undefined;
}

export type User = typeof users.$inferSelect;
export interface Principal {
  user: User;
  via: "jwt" | "token";
  scopes: Set<HubScope>;
  tokenId?: string;
}

export const TOKEN_PREFIX = "pst_";
const TOKEN_RE = /^pst_[A-Za-z0-9_-]{43}$/;
export const hashSecret = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export function newPersonalToken(): { token: string; hash: string; prefix: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashSecret(token), prefix: token.slice(0, 10) };
}

/** Portées qu'un utilisateur peut détenir (moderation selon le rôle). */
export function allowedScopes(role: UserRole): HubScope[] {
  return role === "user" ? [...DEFAULT_TOKEN_SCOPES] : [...DEFAULT_TOKEN_SCOPES, "moderation"];
}

/** Slugs jamais attribués à un namespace personnel. */
export const RESERVED_NAMESPACES = new Set([
  OFFICIAL_NAMESPACE,
  "admin", "administrator", "api", "app", "auth", "hub", "www", "v1", "v2", "official", "officiel", "moderation", "moderator", "support", "help", "root",
  "system", "systeme", "anonymous", "deleted", "supprime", "null", "undefined", "me", "login", "logout", "device", "legal", "terms", "privacy", "security", "static", "assets",
]);

/** Réservé : liste fixe, plus tout ce qui commence par `personas` (imitation du namespace officiel). */
export const isReservedNamespace = (slug: string) => RESERVED_NAMESPACES.has(slug) || slug.startsWith(OFFICIAL_NAMESPACE);

/** Slug de namespace dérivé d'un pseudo, d'un nom ou d'un e-mail. */
export function slugifyNamespace(s: string): string {
  const base = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return base;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

interface IdentityClaims {
  sub: string;
  email: string | null;
  displayName: string | null;
  githubId: string | null;
  githubLogin: string | null;
}

function identityOf(p: JWTPayload): IdentityClaims {
  const meta = (p.user_metadata ?? {}) as Record<string, unknown>;
  const app = (p.app_metadata ?? {}) as Record<string, unknown>;
  const providers = Array.isArray(app.providers) ? app.providers : [app.provider];
  const github = providers.includes("github");
  const login = str(meta.user_name) ?? str(meta.preferred_username);
  return {
    sub: p.sub!,
    email: str(p.email)?.toLowerCase() ?? null,
    displayName: (str(meta.full_name) ?? str(meta.name) ?? login ?? str(p.email)?.split("@")[0] ?? null)?.slice(0, 80) ?? null,
    githubId: github ? (str(meta.provider_id) ?? (typeof meta.provider_id === "number" ? String(meta.provider_id) : null)) : null,
    githubLogin: github ? login : null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuth(db: HubDb, cfg: AuthConfig = {}) {
  // Vérification des JWT partagée avec le service hébergé (src/auth/supabase-jwt.ts)
  const verifier = createJwtVerifier(cfg);
  const { issuer, audience } = verifier;
  /** Authentification par JWT active : un émetteur connu et une clé (secret ou JWKS). */
  const jwtEnabled = verifier.enabled;
  const roleLists = { admin: new Set((cfg.admins ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean)), moderator: new Set((cfg.moderators ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean)) };

  const roleFor = (id: IdentityClaims, current: UserRole): UserRole => {
    const keys = [id.sub.toLowerCase(), ...(id.email ? [id.email] : [])];
    if (keys.some((k) => roleLists.admin.has(k))) return "admin";
    if (keys.some((k) => roleLists.moderator.has(k))) return "moderator";
    return current;
  };

  async function verifyJwt(token: string): Promise<JWTPayload> {
    if (!jwtEnabled) throw new PublishError(401, "unauthorized", "Connexion par session non configurée sur ce Hub (SUPABASE_URL, SUPABASE_JWT_SECRET ou JWKS).");
    try {
      return await verifier.verify(token);
    } catch (err) {
      throw new PublishError(401, "unauthorized", err instanceof JwtError ? err.message : "Session invalide ou expirée : se reconnecter.");
    }
  }

  /** Namespace personnel libre, dérivé du pseudo GitHub, du nom, puis de l'e-mail. */
  async function freeNamespace(tx: HubDb, id: IdentityClaims): Promise<string> {
    const candidates = [id.githubLogin, id.email?.split("@")[0], id.displayName].map((x) => (x ? slugifyNamespace(x) : "")).filter((x) => x.length >= 2);
    candidates.push(`user-${id.sub.slice(0, 8).toLowerCase()}`);
    for (const base of candidates) {
      // Un nom réservé n'est jamais décliné (personas-2 ressemblerait à l'officiel)
      if (isReservedNamespace(base)) continue;
      for (let i = 1; i < 50; i++) {
        const slug = i === 1 ? base : `${base.slice(0, 32)}-${i}`;
        if (isReservedNamespace(slug) || !namespaceSlug.safeParse(slug).success) continue;
        const [taken] = await tx.select({ slug: namespaces.slug }).from(namespaces).where(eq(namespaces.slug, slug));
        if (!taken) return slug;
      }
    }
    return `user-${id.sub.replace(/-/g, "").slice(0, 16).toLowerCase()}`;
  }

  /** Utilisateur du JWT, créé au premier appel (namespace personnel réservé). */
  async function upsertUser(p: JWTPayload): Promise<User> {
    if (p.role !== "authenticated" || p.is_anonymous === true) throw new PublishError(401, "unauthorized", "Compte invité requis (session anonyme refusée).");
    if (!p.sub || !UUID_RE.test(p.sub)) throw new PublishError(401, "unauthorized", "Jeton sans identifiant d'utilisateur.");
    const id = identityOf(p);
    const [existing] = await db.select().from(users).where(eq(users.id, id.sub));
    if (existing) {
      if (existing.deletedAt) throw new PublishError(403, "unauthorized", "Ce compte a été supprimé.");
      const role = roleFor(id, existing.role);
      const changed = existing.email !== id.email || existing.githubLogin !== id.githubLogin || existing.githubId !== id.githubId || existing.role !== role;
      const stale = Date.now() - new Date(existing.lastSeenAt).getTime() > 5 * 60_000;
      if (!changed && !stale) return existing;
      const [u] = await db.update(users).set({ email: id.email, githubId: id.githubId, githubLogin: id.githubLogin, role, lastSeenAt: new Date() }).where(eq(users.id, id.sub)).returning();
      return u!;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const t = tx as unknown as HubDb;
          const slug = await freeNamespace(t, id);
          const [u] = await t
            .insert(users)
            .values({ id: id.sub, email: id.email, displayName: id.displayName, githubId: id.githubId, githubLogin: id.githubLogin, role: roleFor(id, "user"), namespace: slug })
            .returning();
          await t.insert(namespaces).values({ slug, ownerUserId: id.sub, verified: false });
          return u!;
        });
      } catch (err) {
        // Course entre deux premières connexions (même utilisateur ou même slug) : on relit
        const [again] = await db.select().from(users).where(eq(users.id, id.sub));
        if (again) return again;
        if (attempt === 2) throw err;
      }
    }
    throw new Error("unreachable");
  }

  async function fromPersonalToken(token: string): Promise<Principal> {
    if (!TOKEN_RE.test(token)) throw new PublishError(401, "unauthorized", "Jeton personnel invalide.");
    const [row] = await db
      .select({ t: apiTokens, u: users })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(and(eq(apiTokens.hash, hashSecret(token)), isNull(apiTokens.revokedAt)));
    if (!row || row.u.deletedAt) throw new PublishError(401, "unauthorized", "Jeton personnel inconnu ou révoqué.");
    if (new Date(row.t.expiresAt).getTime() <= Date.now()) throw new PublishError(401, "unauthorized", "Jeton personnel expiré : en créer un nouveau (personas hub login).");
    const last = row.t.lastUsedAt ? new Date(row.t.lastUsedAt).getTime() : 0;
    if (Date.now() - last > 60_000) await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.t.id));
    // Une portée retirée par le rôle (moderation) ne survit pas dans un ancien jeton
    const allowed = new Set(allowedScopes(row.u.role));
    return { user: row.u, via: "token", scopes: new Set(row.t.scopes.filter((s) => allowed.has(s))), tokenId: row.t.id };
  }

  const bearerOf = (c: Context): string | null => {
    const h = c.req.header("authorization");
    const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
    return m ? m[1]! : null;
  };

  /**
   * Principal de la requête. `scopes` : portées exigées (toutes) ; `jwtOnly` : session web exigée
   * (création de jeton, approbation d'appareil, suppression de compte).
   */
  async function authenticate(c: Context, need: { scopes?: HubScope[]; jwtOnly?: boolean } = {}): Promise<Principal> {
    const bearer = bearerOf(c);
    if (!bearer) throw new PublishError(401, "unauthorized", "Authentification requise (Authorization: Bearer <session ou jeton pst_…>).");
    let principal: Principal;
    if (bearer.startsWith(TOKEN_PREFIX)) {
      if (need.jwtOnly) throw new PublishError(403, "unauthorized", "Action réservée à une session web (pas de jeton personnel).");
      principal = await fromPersonalToken(bearer);
    } else {
      const user = await upsertUser(await verifyJwt(bearer));
      principal = { user, via: "jwt", scopes: new Set(allowedScopes(user.role)) };
    }
    const missing = (need.scopes ?? []).filter((s) => !principal.scopes.has(s));
    if (missing.length) throw new PublishError(403, "unauthorized", `Portée manquante : ${missing.join(", ")}.`);
    return principal;
  }

  /** Nombre de modules et packs d'un namespace (renommage possible seulement s'il est vide). */
  async function namespaceIsEmpty(slug: string): Promise<boolean> {
    const r = await db.execute(
      sql`select (select count(*) from personas_hub.modules where namespace = ${slug}) + (select count(*) from personas_hub.packs where namespace = ${slug}) as n`,
    );
    const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0) === 0;
  }

  return { authenticate, jwtEnabled, bearerOf, namespaceIsEmpty, issuer, audience };
}

export type Auth = ReturnType<typeof createAuth>;
