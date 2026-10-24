import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { JWTPayload } from "jose";
import { JwtError, sessionUserOf, type JwtVerifier, type SessionUser } from "../auth/supabase-jwt";

/**
 * Session du service hébergé.
 *
 * - Le navigateur se connecte à Supabase Auth (comptes invités, inscriptions fermées), puis envoie son jeton
 *   d'accès à `POST /api/session` (en-tête `Authorization: Bearer`). Le serveur le vérifie (JWKS) et le pose dans
 *   un cookie httpOnly, Secure, SameSite=Lax (préfixe `__Host-`), qui expire avec le jeton. À chaque rafraîchissement
 *   du jeton par Supabase, le navigateur rappelle `POST /api/session`.
 * - Les clients non navigateurs peuvent envoyer le jeton à chaque requête (`Authorization: Bearer`).
 * - CSRF : une requête modifiante (POST, PUT, PATCH, DELETE) authentifiée par le cookie doit porter l'en-tête
 *   `x-csrf-token` égal au cookie `__Host-personas_csrf` (double soumission ; aussi renvoyé par POST /api/session et
 *   GET /api/me), ne pas être `Sec-Fetch-Site: cross-site`, et venir d'une origine admise si `Origin` est présent.
 * - `POST /api/session` et `DELETE /api/session` (avant toute session, donc sans jeton CSRF) passent par le même
 *   contrôle d'origine (`checkOrigin`) ; `POST /api/session` exige en plus `Content-Type: application/json`
 *   (src/hosted/app.ts), ce qui en fait une requête avec pré-vol : pas de connexion forcée par formulaire.
 * - Jetons refusés : durée de vie (`exp - iat`) au-delà de `MAX_TOKEN_LIFETIME_S` (401) ; `sub` ou e-mail d'un
 *   compte supprimé (403 `account_deleted`, cookies effacés, définitif sauf réactivation ; src/hosted/tombstones.ts).
 */

export const CSRF_HEADER = "x-csrf-token";
/** Durée de vie maximale d'un JWT accepté (Supabase : « JWT expiry » ≤ 604 800 s, une semaine). */
export const MAX_TOKEN_LIFETIME_S = 7 * 24 * 3600;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Durée maximale du cookie, même si le jeton vit plus longtemps. */
const MAX_SESSION_S = 24 * 3600;

export interface SessionOptions {
  verifier: JwtVerifier;
  secure: boolean;
  allowedOrigins: string[];
  /** Compte supprimé (`sub` ou e-mail, src/hosted/tombstones.ts) : toute session est refusée. */
  isDeleted?: (user: SessionUser) => boolean;
}

export interface Authenticated {
  user: SessionUser;
  via: "bearer" | "cookie";
  payload: JWTPayload;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function cookieNames(secure: boolean): { session: string; csrf: string } {
  return secure ? { session: "__Host-personas_session", csrf: "__Host-personas_csrf" } : { session: "personas_session", csrf: "personas_csrf" };
}

export function bearerOf(c: Context): string | null {
  const h = c.req.header("authorization");
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1]! : null;
}

function same(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createSessions(opts: SessionOptions) {
  const names = cookieNames(opts.secure);
  const cookieBase = { httpOnly: true, secure: opts.secure, sameSite: "Lax" as const, path: "/" };

  async function verify(token: string): Promise<{ user: SessionUser; payload: JWTPayload }> {
    let out: { user: SessionUser; payload: JWTPayload };
    try {
      const payload = await opts.verifier.verify(token);
      out = { user: sessionUserOf(payload), payload };
    } catch (err) {
      throw new AuthError(401, "unauthorized", err instanceof JwtError ? err.message : "Session invalide ou expirée : se reconnecter.");
    }
    checkLifetime(out.payload);
    return out;
  }

  /**
   * Durée de vie bornée au plafond de Supabase (une semaine) : un jeton plus long n'a pas été émis par une
   * configuration normale de Supabase.
   */
  function checkLifetime(p: JWTPayload): void {
    if (typeof p.exp !== "number" || typeof p.iat !== "number" || p.exp - p.iat > MAX_TOKEN_LIFETIME_S) {
      throw new AuthError(401, "unauthorized", "Jeton à durée de vie trop longue : se reconnecter.");
    }
  }

  /** Compte supprimé : cookies effacés, 403 `account_deleted`. */
  function checkNotDeleted(c: Context, user: SessionUser): void {
    if (!opts.isDeleted?.(user)) return;
    close(c);
    throw new AuthError(403, "account_deleted", "Compte supprimé : cette session n'est plus valable.");
  }

  /** Utilisateur de la requête (Bearer, sinon cookie), avec contrôle CSRF pour le cookie. */
  async function authenticate(c: Context): Promise<Authenticated> {
    const bearer = bearerOf(c);
    const token = bearer ?? getCookie(c, names.session) ?? null;
    if (!token) throw new AuthError(401, "unauthorized", "Connexion requise.");
    const { user, payload } = await verify(token);
    checkNotDeleted(c, user);
    const via = bearer ? "bearer" : "cookie";
    if (via === "cookie" && MUTATING.has(c.req.method)) checkCsrf(c);
    return { user, via, payload };
  }

  /**
   * Contrôle d'origine des requêtes modifiantes : refus de `Sec-Fetch-Site: cross-site`, et d'un `Origin` hors de
   * `HOSTED_ALLOWED_ORIGINS` (obligatoire, src/hosted/config.ts). Sans `Origin` : accepté (client non navigateur ;
   * un navigateur envoie toujours `Origin` sur un POST ou un DELETE, y compris inter-sites).
   */
  function checkOrigin(c: Context): void {
    if (c.req.header("sec-fetch-site") === "cross-site") throw new AuthError(403, "csrf", "Requête inter-sites refusée.");
    const origin = c.req.header("origin");
    if (origin && !opts.allowedOrigins.includes(origin.replace(/\/+$/, ""))) throw new AuthError(403, "csrf", "Origine refusée.");
  }

  function checkCsrf(c: Context): void {
    checkOrigin(c);
    // `x-personas-session` : en-tête du premier lancement local (GET /api/setup/session renvoie ce même jeton)
    const sent = c.req.header(CSRF_HEADER) ?? c.req.header("x-personas-session");
    if (!same(sent, getCookie(c, names.csrf))) throw new AuthError(403, "csrf", "Jeton CSRF absent ou invalide : recharger la page.");
  }

  /**
   * POST /api/session : vérifie le jeton (en-tête `Authorization: Bearer`, ou corps `{ accessToken }`) et pose les
   * cookies. 401 : jeton invalide ou expiré ; 403 : jeton valide mais pas d'un compte invité (anonyme, sans rôle).
   */
  async function open(c: Context, bodyToken?: string): Promise<{ user: SessionUser; csrfToken: string; expiresAt: string }> {
    const bearer = bearerOf(c) ?? (bodyToken && /^\S{16,8192}$/.test(bodyToken) ? bodyToken : null);
    if (!bearer) throw new AuthError(401, "unauthorized", "Jeton d'accès Supabase requis (Authorization: Bearer, ou { accessToken }).");
    let payload: JWTPayload;
    try {
      payload = await opts.verifier.verify(bearer);
    } catch (err) {
      throw new AuthError(401, "unauthorized", err instanceof JwtError ? err.message : "Session invalide ou expirée : se reconnecter.");
    }
    let user: SessionUser;
    try {
      user = sessionUserOf(payload);
    } catch (err) {
      throw new AuthError(403, "not_invited", err instanceof JwtError ? err.message : "Compte invité requis.");
    }
    checkLifetime(payload);
    checkNotDeleted(c, user);
    const now = Math.floor(Date.now() / 1000);
    const maxAge = Math.max(1, Math.min(MAX_SESSION_S, (payload.exp ?? now) - now));
    // Même jeton CSRF tant que le cookie existe (plusieurs onglets) ; nouveau sinon
    const csrfToken = getCookie(c, names.csrf) && /^[A-Za-z0-9_-]{43}$/.test(getCookie(c, names.csrf)!) ? getCookie(c, names.csrf)! : randomBytes(32).toString("base64url");
    setCookie(c, names.session, bearer, { ...cookieBase, maxAge });
    setCookie(c, names.csrf, csrfToken, { ...cookieBase, httpOnly: false, maxAge });
    return { user, csrfToken, expiresAt: new Date((now + maxAge) * 1000).toISOString() };
  }

  function close(c: Context): void {
    deleteCookie(c, names.session, { path: "/", secure: opts.secure });
    deleteCookie(c, names.csrf, { path: "/", secure: opts.secure });
  }

  const csrfOf = (c: Context): string | null => getCookie(c, names.csrf) ?? null;

  return { authenticate, open, close, checkOrigin, csrfOf, names };
}

export type Sessions = ReturnType<typeof createSessions>;

/** Limitation de débit par fenêtre d'une minute (par compte, ou par adresse avant connexion). */
export function createRateLimiter(perMinute: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; n: number }>();
  return {
    /** Vrai si la requête passe. */
    hit(key: string, limit = perMinute): boolean {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= 60_000) {
        w = { start: t, n: 0 };
        windows.set(key, w);
      }
      w.n++;
      if (windows.size > 10_000) for (const [k, v] of windows) if (t - v.start >= 60_000) windows.delete(k);
      return w.n <= limit;
    },
  };
}
