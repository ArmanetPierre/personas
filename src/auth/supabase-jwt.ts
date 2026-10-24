import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * Vérification des JWT de Supabase Auth, partagée par le Hub (hub/src/auth.ts) et le service hébergé
 * (src/hosted/) : clés asymétriques par JWKS (ou secret HS256, mode historique), émetteur, audience,
 * expiration (tolérance 30 s) et revendications exigées. Inscriptions fermées : aucune création de compte ici,
 * seulement la vérification d'un compte invité existant.
 */

export interface JwtVerifierConfig {
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
}

export type JwtErrorCode = "disabled" | "unreadable" | "invalid";

export class JwtError extends Error {
  override name = "JwtError";
  constructor(
    readonly code: JwtErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface JwtVerifier {
  /** Vrai si un émetteur et une clé (secret ou JWKS) sont configurés. */
  enabled: boolean;
  issuer: string | undefined;
  audience: string;
  /** Charge utile vérifiée ; lève `JwtError` sinon (le message ne contient jamais le jeton). */
  verify(token: string): Promise<JWTPayload>;
}

export function createJwtVerifier(cfg: JwtVerifierConfig = {}): JwtVerifier {
  const base = cfg.supabaseUrl?.replace(/\/+$/, "");
  const issuer = cfg.issuer ?? (base ? `${base}/auth/v1` : undefined);
  const audience = cfg.audience ?? "authenticated";
  const secret = cfg.jwtSecret ? new TextEncoder().encode(cfg.jwtSecret) : null;
  const jwksUrl = cfg.jwksUrl ?? (base ? `${base}/auth/v1/.well-known/jwks.json` : undefined);
  const jwks: JWTVerifyGetKey | null = cfg.jwks ? createLocalJWKSet(cfg.jwks) : jwksUrl ? createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 600_000 }) : null;
  const enabled = !!issuer && (!!secret || !!jwks);

  async function verify(token: string): Promise<JWTPayload> {
    if (!enabled) throw new JwtError("disabled", "Connexion par session non configurée (SUPABASE_URL, SUPABASE_JWT_SECRET ou JWKS).");
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new JwtError("unreadable", "Jeton illisible.");
    }
    const opts = { issuer: issuer!, audience, clockTolerance: 30, requiredClaims: ["sub", "exp", "iat"] };
    try {
      if (alg === "HS256") {
        if (!secret) throw new Error("HS256 non accepté");
        return (await jwtVerify(token, secret, { ...opts, algorithms: ["HS256"] })).payload;
      }
      if (!jwks) throw new Error("aucune clé JWKS");
      return (await jwtVerify(token, jwks, { ...opts, algorithms: ["RS256", "ES256", "EdDSA"] })).payload;
    } catch {
      throw new JwtError("invalid", "Session invalide ou expirée : se reconnecter.");
    }
  }

  return { enabled, issuer, audience, verify };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifiant Supabase valide (UUID) : sert aussi de nom de dossier côté service hébergé. */
export const isSupabaseUserId = (sub: unknown): sub is string => typeof sub === "string" && UUID_RE.test(sub);

export interface SessionUser {
  /** `sub` du JWT, en minuscules (UUID). */
  id: string;
  email: string | null;
  displayName: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Compte invité de la charge utile : rôle `authenticated`, pas de session anonyme, `sub` UUID. Lève `JwtError`
 * (code `invalid`) sinon.
 */
export function sessionUserOf(p: JWTPayload): SessionUser {
  if (p.role !== "authenticated" || p.is_anonymous === true) throw new JwtError("invalid", "Compte invité requis (session anonyme refusée).");
  if (!isSupabaseUserId(p.sub)) throw new JwtError("invalid", "Jeton sans identifiant d'utilisateur.");
  const meta = (p.user_metadata ?? {}) as Record<string, unknown>;
  const email = str(p.email)?.toLowerCase() ?? null;
  const displayName = (str(meta.full_name) ?? str(meta.name) ?? str(meta.user_name) ?? email?.split("@")[0] ?? null)?.slice(0, 80) ?? null;
  return { id: p.sub.toLowerCase(), email, displayName };
}
