import { createHash } from "node:crypto";

/**
 * En-têtes de sécurité propres au service hébergé (le tableau de bord local n'en pose aucun de ceux-ci) :
 * - Content-Security-Policy stricte : tout vient du service lui-même ; seule exception, l'origine de Supabase en
 *   connect-src (demande du lien magique depuis la page /connexion). Le seul script en ligne du front (thème lu
 *   avant le premier rendu, web/index.html) est autorisé par son empreinte, calculée sur l'index.html servi.
 * - Strict-Transport-Security quand la requête est arrivée en HTTPS (directement, ou derrière le proxy de
 *   confiance : TRUST_PROXY et X-Forwarded-Proto).
 */

export const HSTS = "max-age=31536000";

/** Origine (schéma, hôte, port) d'une URL ; null si absente ou invalide. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Empreintes 'sha256-…' des scripts en ligne (sans src) d'une page HTML. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1] ?? "")) continue;
    const body = m[2] ?? "";
    if (!body.trim()) continue;
    out.push(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  return out;
}

export function contentSecurityPolicy(opts: { supabaseOrigin: string | null; scriptHashes?: string[] }): string {
  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...(opts.scriptHashes ?? [])]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...(opts.supabaseOrigin ? [opts.supabaseOrigin] : [])]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** La requête est-elle arrivée en HTTPS ? X-Forwarded-Proto n'est cru que derrière un proxy de confiance. */
export function isHttps(url: string, forwardedProto: string | undefined, trustProxy: boolean): boolean {
  if (trustProxy && forwardedProto) return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
