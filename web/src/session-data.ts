/** Données de session du service hébergé : lecture tolérante des réponses de /api/me et /api/me/engine. */

export interface Me {
  email: string;
  createdAt?: string;
}

export interface EngineView {
  provider: string;
  model: string;
  /** 4 derniers caractères de la clé. */
  last4: string;
  perStudyUsd: number | null;
  perMonthUsd: number | null;
  updatedAt: string | null;
}

/** Lecture tolérante de la clé IA (`{ engine }` ou l'objet seul ; plafonds à plat ou dans `limits`). */
export function parseEngine(body: unknown): EngineView | null {
  const o = (body && typeof body === "object" && "engine" in body ? (body as { engine: unknown }).engine : body) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.provider !== "string") return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const limits = (o.limits && typeof o.limits === "object" ? o.limits : null) as Record<string, unknown> | null;
  const last4 = [o.last4, o.keyLast4, o.keyHint].find((x): x is string => typeof x === "string") ?? "";
  return {
    provider: o.provider,
    model: typeof o.model === "string" ? o.model : "",
    last4: last4.slice(-4),
    perStudyUsd: n(o.perStudyUsd) ?? n(limits?.perStudyUsd),
    perMonthUsd: n(o.perMonthUsd) ?? n(limits?.perMonthUsd),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null,
  };
}

export function parseMe(body: unknown): Me | null {
  const o = body as { email?: unknown; createdAt?: unknown; user?: { email?: unknown; createdAt?: unknown } } | null;
  const email = typeof o?.email === "string" ? o.email : typeof o?.user?.email === "string" ? o.user.email : null;
  if (!email) return null;
  const createdAt = typeof o?.createdAt === "string" ? o.createdAt : typeof o?.user?.createdAt === "string" ? o.user.createdAt : undefined;
  return { email, ...(createdAt && { createdAt }) };
}

/** Pages accessibles sans session. */
export const PUBLIC_PATHS = ["/connexion", "/confidentialite", "/conditions"];
