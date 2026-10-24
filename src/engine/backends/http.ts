import type { ProviderKind } from "../types";

/**
 * Socle commun des fournisseurs HTTP (anthropic, openai, openrouter, gemini, openai-compatible) :
 * erreurs typées, masquage des clés, réessais bornés sur 5xx et délais dépassés.
 *
 * Règle : une clé n'apparaît JAMAIS dans un message d'erreur, un journal ou une sortie console.
 * Tout texte venu d'un fournisseur (corps d'erreur, message réseau) passe par `redactSecrets`.
 */

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly provider: ProviderKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 401 / 403 : clé absente, invalide ou sans droit sur ce modèle. */
export class ProviderAuthError extends ProviderError {
  override name = "ProviderAuthError";
}

/**
 * 429 : limite de débit ou quota du compte. Même traitement que la limite d'usage de l'abonnement Max :
 * le message contient « rate limit » et « 429 », reconnus par `isUsageLimitError` (src/studies/run.ts),
 * ce qui met l'étude en pause (reprise par `study:run`).
 */
export class ProviderRateLimitError extends ProviderError {
  override name = "ProviderRateLimitError";
  readonly usageLimit = true;
  constructor(
    message: string,
    provider: ProviderKind,
    readonly retryAfterSeconds?: number,
  ) {
    super(message, provider, 429);
  }
}

/** Aucune clé trouvée pour un profil qui en exige une. */
export class ProviderKeyMissingError extends ProviderError {
  override name = "ProviderKeyMissingError";
}

const MASK = "***";

/** Motifs de secrets connus, masqués même s'ils ne sont pas la clé du profil. */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI, Anthropic, OpenRouter
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi,
  /(["']?(?:x-api-key|x-goog-api-key|authorization|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
  // Clé déjà tronquée par le fournisseur (« sk-abc*****wxyz ») : on ne garde même pas les bouts
  /\b[\w-]{2,}\*{4,}[\w-]{0,12}/g,
];

/** Masque les secrets (clés du profil et motifs connus) dans un texte destiné à l'utilisateur. */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join(MASK);
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, prefix?: unknown) => (typeof prefix === "string" ? prefix + MASK : MASK));
  }
  return out;
}

export interface HttpCallOptions {
  provider: ProviderKind;
  /** Nom du profil, pour les conseils d'action (`engine:key -- set --profile <nom>`). */
  profile?: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Réessais après une 5xx, une 408, une 529 ou un délai dépassé (défaut 2). */
  maxRetries?: number;
  /** Secrets à masquer dans toute erreur produite. */
  secrets?: ReadonlyArray<string | undefined>;
  fetch?: typeof fetch;
  /** Attente entre deux réessais (injectable dans les tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Codes réessayables : erreurs du serveur, surcharge, délai côté serveur. */
function retryable(status: number): boolean {
  return status >= 500 || status === 408;
}

function retryAfterSeconds(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(h);
  return Number.isNaN(d) ? undefined : Math.max(0, Math.round((d - Date.now()) / 1000));
}

/** Message d'erreur lisible extrait d'un corps de réponse (JSON des fournisseurs, sinon texte brut). */
export function errorDetail(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string; type?: string } | string; message?: string };
    const e = j.error;
    const msg = typeof e === "string" ? e : (e?.message ?? j.message);
    if (msg) return msg;
  } catch {
    // corps non JSON
  }
  return raw.trim();
}

export function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === "TimeoutError" || e.name === "AbortError") return "délai dépassé";
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(err);
}

/**
 * Appel HTTP JSON avec réessais bornés. Renvoie le corps décodé d'une réponse 2xx ; lève une erreur
 * typée et masquée sinon. Ne réessaie jamais une 4xx (clé, requête, limite de débit).
 */
export async function callJson<T = unknown>(opts: HttpCallOptions): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 2;
  const redact = (s: string) => redactSecrets(s, opts.secrets);
  const label = `${opts.provider}${opts.profile ? ` (profil ${opts.profile})` : ""}`;
  const path = safePath(opts.url);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(opts.url, {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: { ...(opts.body !== undefined && { "content-type": "application/json" }), ...opts.headers },
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new ProviderError(
        redact(`Appel ${label} échoué (${describeNetworkError(err)}) après ${attempt + 1} tentative(s) : ${path}`),
        opts.provider,
      );
    }

    if (res.ok) {
      const raw = await res.text();
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new ProviderError(redact(`Réponse illisible de ${label} : ${raw.slice(0, 300)}`), opts.provider, res.status);
      }
    }

    const detail = redact(errorDetail(await res.text().catch(() => "")).slice(0, 400));
    if (res.status === 401 || res.status === 403) {
      throw new ProviderAuthError(
        `Clé refusée par ${label} (HTTP ${res.status}) : ${detail || "accès refusé"}. ` +
          `Vérifier la clé : npm run engine:key -- set --profile ${opts.profile ?? "<profil>"}`,
        opts.provider,
        res.status,
      );
    }
    if (res.status === 429) {
      const after = retryAfterSeconds(res);
      throw new ProviderRateLimitError(
        `Limite de débit atteinte chez ${label} (HTTP 429, rate limit)${after !== undefined ? `, réessayer dans ${after} s` : ""} : ${detail}`,
        opts.provider,
        after,
      );
    }
    if (retryable(res.status) && attempt < maxRetries) {
      const after = retryAfterSeconds(res);
      await sleep(after !== undefined && after <= 30 ? after * 1000 : backoffMs(attempt));
      continue;
    }
    throw new ProviderError(
      `${label} : HTTP ${res.status} sur ${path}${retryable(res.status) ? ` après ${attempt + 1} tentative(s)` : ""} : ${detail}`,
      opts.provider,
      res.status,
    );
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 1_000 * 2 ** attempt);
}

/** Chemin de l'URL sans la requête (une clé passée en paramètre ne doit jamais s'afficher). */
function safePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(URL invalide)";
  }
}

/** Le texte du système, complété de la consigne JSON quand le fournisseur n'impose pas le schéma. */
export function withJsonInstruction(system: string, jsonSchema: Record<string, unknown>): string {
  return `${system}\n\nRéponds uniquement par un objet JSON valide qui respecte ce schéma, sans texte autour ni bloc de code :\n${JSON.stringify(jsonSchema)}`;
}
