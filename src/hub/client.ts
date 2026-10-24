import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "../config";
import { catalogResponseV3, hubCacheDir, readCachedCatalog, writeCachedCatalog } from "./cache";
import {
  catalogModuleV3,
  deviceCodeRequest,
  deviceCodeResponse,
  deviceTokenResponse,
  forkRequest,
  HUB_API_VERSION,
  hubError,
  hubKeysResponse,
  meResponse,
  moduleVersionResponseV3,
  packVersionResponseV3,
  publishModuleRequest,
  publishPackRequest,
  publishResponse,
  qualifiedRef,
  reportRequest,
  reportResponse,
  reviewItem,
  reviewRequest,
  searchResponse,
  starResponse,
  telemetryRequest,
  telemetryResponse,
  userPublishModuleRequest,
  userPublishPackRequest,
  userPublishResponse,
  versionString,
  type CatalogResponse,
} from "./contract";

/**
 * Client HTTP du Hub (runner local-first, docs/plateforme.md § 2.4 et § 11.1).
 *
 * Ce que le client envoie au Hub, en tout et pour tout :
 * - des GET d'objets publics : catalogue (avec ETag), version d'un module, version d'un pack, clés de signature,
 *   et la recherche distante d'un texte **tapé par l'utilisateur** (`personas hub search --remote`) ;
 * - le flux d'appareil de `personas hub login` (codes opaques, aucune donnée locale) et `GET /v1/me` ;
 * - les actions explicites de l'utilisateur, avec son jeton personnel (en-tête Authorization, jamais affiché) :
 *   publication d'un module (YAML seul), fork, étoile, avis, signalement ; la publication d'administration ;
 * - la télémétrie, si elle a été acceptée : agrégats par étude terminée (src/hub/telemetry.ts), sans texte libre.
 * Aucune méthode ne prend un projet, un pitch, une offre, une cible ni une réponse : le choix automatique des
 * modules se fait en local, sur le catalogue téléchargé (src/hub/search.ts). Un test vérifie cette liste de méthodes.
 *
 * Tolérance aux pannes : hors ligne (réseau, délai, 5xx), `catalog()` renvoie le dernier catalogue du cache
 * avec un message clair ; les autres appels lèvent `HubUnavailableError`.
 */

export const DEFAULT_HUB_URL = "https://persona.armanet.xyz";
const DEFAULT_TIMEOUT_MS = 15_000;

export class HubUnavailableError extends Error {
  override name = "HubUnavailableError";
}

/** Erreur renvoyée par le Hub (`{ error: { code, message } }`, codes stables du contrat). */
export class HubError extends Error {
  override name = "HubError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** URL du Hub : `PERSONAS_HUB_URL`, sinon l'adresse publique. Sous vitest, une URL explicite est exigée. */
export function hubBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.PERSONAS_HUB_URL?.trim();
  if (v) return v.replace(/\/+$/, "");
  if (env.VITEST) throw new Error("PERSONAS_HUB_URL requis sous vitest : aucun test n'appelle le vrai Hub.");
  return DEFAULT_HUB_URL;
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0";
  } catch {
    return "0";
  }
}

export interface HubClientOptions {
  baseUrl?: string;
  /** Implémentation de fetch (tests). */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Cache du catalogue (défaut : hub-cache du dossier de données ; null : aucun). */
  cacheDir?: string | null;
}

export interface CatalogResult {
  catalog: CatalogResponse | null;
  /** `network` : téléchargé ; `not-modified` : ETag inchangé (cache) ; `cache` : Hub injoignable, cache ; `none` : ni l'un ni l'autre. */
  source: "network" | "not-modified" | "cache" | "none";
  fetchedAt?: string;
  /** Message lisible quand le Hub n'a pas répondu. */
  offline?: string;
}

export { catalogResponseV3 };
export type CatalogModuleV3 = z.infer<typeof catalogModuleV3>;
export type ModuleVersionV3 = z.infer<typeof moduleVersionResponseV3>;
export type PackVersionV3 = z.infer<typeof packVersionResponseV3>;
export type DeviceCode = z.infer<typeof deviceCodeResponse>;
export type DeviceTokenResult = z.infer<typeof deviceTokenResponse>;
export type HubMe = z.infer<typeof meResponse>;
export type UserPublishResult = z.infer<typeof userPublishResponse>;

type Method = "GET" | "POST" | "PUT" | "DELETE";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const jsonBody = (token: string | null, body: unknown) => ({ headers: { ...(token && bearer(token)), "content-type": "application/json" }, body: JSON.stringify(body) });

const splitRef = (ref: string): [string, string] => {
  const r = qualifiedRef.parse(ref);
  const i = r.indexOf("/");
  return [r.slice(0, i), r.slice(i + 1)];
};

export class HubClient {
  readonly baseUrl: string;
  readonly cacheDir: string | null;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  constructor(opts: HubClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? hubBaseUrl()).replace(/\/+$/, "");
    this.cacheDir = opts.cacheDir === undefined ? hubCacheDir() : opts.cacheDir;
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#userAgent = `personas/${packageVersion()}`;
  }

  async #request(method: Method, path: string, init: { headers?: Record<string, string>; body?: string; okStatuses?: number[] } = {}): Promise<Response> {
    const url = `${this.baseUrl}/${HUB_API_VERSION}${path}`;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers: { "user-agent": this.#userAgent, accept: "application/json", ...init.headers },
        ...(init.body !== undefined && { body: init.body }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      const why = (err as Error).name === "TimeoutError" ? `pas de réponse en ${Math.round(this.#timeoutMs / 1000)} s` : (err as Error).message;
      throw new HubUnavailableError(`Hub injoignable (${this.baseUrl}) : ${why}. Hors ligne : les modules et packs déjà en cache restent utilisables.`);
    }
    if (res.status >= 500) throw new HubUnavailableError(`Hub indisponible (${this.baseUrl}, HTTP ${res.status}). Réessayer plus tard ; le cache reste utilisable.`);
    if (!res.ok && res.status !== 304 && !init.okStatuses?.includes(res.status)) {
      const body = await res.json().catch(() => null);
      const parsed = hubError.safeParse(body);
      if (parsed.success) throw new HubError(parsed.data.error.code, res.status, `Hub : ${parsed.data.error.message} (${parsed.data.error.code})`);
      throw new HubError("internal", res.status, `Hub : réponse HTTP ${res.status} inattendue pour ${path}`);
    }
    return res;
  }

  async #json<T extends z.ZodType>(res: Response, schema: T, what: string): Promise<z.infer<T>> {
    const body = await res.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new HubError("invalid", res.status, `Hub : réponse non conforme au contrat pour ${what} (${parsed.error.issues[0]?.path.join(".") ?? ""} : ${parsed.error.issues[0]?.message ?? ""})`);
    return parsed.data;
  }

  /**
   * Catalogue complet (GET /v1/catalog), mis en cache sur disque avec son ETag. Hors ligne : dernier catalogue
   * du cache. `offline: true` : n'appelle pas le Hub.
   */
  async catalog(opts: { offline?: boolean } = {}): Promise<CatalogResult> {
    const cached = readCachedCatalog(this.cacheDir);
    const fromCache = (source: CatalogResult["source"], offline?: string): CatalogResult => ({
      catalog: cached?.catalog ?? null,
      source: cached ? source : "none",
      ...(cached && { fetchedAt: cached.meta.fetchedAt }),
      ...(offline && { offline }),
    });
    if (opts.offline) return fromCache("cache");
    const etag = cached && cached.meta.hubUrl === this.baseUrl ? cached.meta.etag : null;
    let res: Response;
    try {
      res = await this.#request("GET", "/catalog", etag ? { headers: { "if-none-match": etag } } : {});
    } catch (err) {
      if (err instanceof HubUnavailableError) return fromCache("cache", err.message);
      throw err;
    }
    const fetchedAt = new Date().toISOString();
    if (res.status === 304 && cached) {
      if (this.cacheDir) writeCachedCatalog(this.cacheDir, cached.catalog, { ...cached.meta, fetchedAt });
      return { catalog: cached.catalog, source: "not-modified", fetchedAt };
    }
    const catalog = await this.#json(res, catalogResponseV3, "le catalogue");
    if (this.cacheDir) writeCachedCatalog(this.cacheDir, catalog, { etag: res.headers.get("etag"), hubUrl: this.baseUrl, fetchedAt });
    return { catalog, source: "network", fetchedAt };
  }

  /** Version immuable d'un module (GET /v1/modules/:ns/:slug/:version), avec signature et filiation si le Hub les donne. */
  async moduleVersion(ref: string, version: string): Promise<ModuleVersionV3> {
    const [ns, slug] = splitRef(ref);
    const res = await this.#request("GET", `/modules/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`);
    return this.#json(res, moduleVersionResponseV3, `${ref}@${version}`);
  }

  /** Version immuable d'un pack (GET /v1/packs/:ns/:slug/:version). */
  async packVersion(ref: string, version: string): Promise<PackVersionV3> {
    const [ns, slug] = splitRef(ref);
    const res = await this.#request("GET", `/packs/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`);
    return this.#json(res, packVersionResponseV3, `pack ${ref}@${version}`);
  }

  /** Clés publiques de signature du Hub (GET /v1/keys). */
  async keys(): Promise<z.infer<typeof hubKeysResponse>> {
    return this.#json(await this.#request("GET", "/keys"), hubKeysResponse, "les clés de signature");
  }

  // ── Compte : flux d'appareil (personas hub login), GET /v1/me ─────────────

  /** Demande un code d'appareil (POST /v1/device/code, anonyme). */
  async deviceCode(req: z.input<typeof deviceCodeRequest> = {}): Promise<DeviceCode> {
    const res = await this.#request("POST", "/device/code", jsonBody(null, deviceCodeRequest.parse(req)));
    return this.#json(res, deviceCodeResponse, "le code d'appareil");
  }

  /** Sondage du flux d'appareil (POST /v1/device/token) : 200 approuvé, 202 en attente, 410 refusé ou expiré. */
  async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const res = await this.#request("POST", "/device/token", { ...jsonBody(null, { device_code: deviceCode }), okStatuses: [410] });
    return this.#json(res, deviceTokenResponse, "le jeton d'appareil");
  }

  /** Compte du jeton (GET /v1/me). */
  async me(token: string): Promise<HubMe> {
    return this.#json(await this.#request("GET", "/me", { headers: bearer(token) }), meResponse, "le compte");
  }

  // ── Actions de l'utilisateur (jeton personnel) ────────────────────────────

  /** Publication d'un module dans le namespace du compte (POST /v1/modules, portée modules:publish). YAML seul. */
  async publishUserModule(req: z.input<typeof userPublishModuleRequest>, token: string): Promise<UserPublishResult> {
    const res = await this.#request("POST", "/modules", jsonBody(token, userPublishModuleRequest.parse(req)));
    return this.#json(res, userPublishResponse, "la publication");
  }

  /** Publication d'une version de pack (données seulement) dans le namespace du compte (POST /v1/packs). */
  async publishUserPack(req: z.input<typeof userPublishPackRequest>, token: string): Promise<UserPublishResult> {
    const res = await this.#request("POST", "/packs", jsonBody(token, userPublishPackRequest.parse(req)));
    return this.#json(res, userPublishResponse, "la publication du pack");
  }

  /** Fork d'un module dans le namespace du compte (POST /v1/modules/:ns/:slug/fork). */
  async forkModule(req: { ref: string; version?: string; slug?: string }, token: string): Promise<UserPublishResult> {
    const [ns, slug] = splitRef(req.ref);
    const body = forkRequest.parse({ ...(req.version && { version: req.version }), ...(req.slug && { slug: req.slug }) });
    const res = await this.#request("POST", `/modules/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/fork`, jsonBody(token, body));
    return this.#json(res, userPublishResponse, "le fork");
  }

  /** Étoile (PUT) ou retrait (DELETE) sur /v1/modules/:ns/:slug/star. */
  async star(ref: string, token: string): Promise<z.infer<typeof starResponse>> {
    const [ns, slug] = splitRef(ref);
    return this.#json(await this.#request("PUT", `/modules/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/star`, { headers: bearer(token) }), starResponse, "l'étoile");
  }

  async unstar(ref: string, token: string): Promise<z.infer<typeof starResponse>> {
    const [ns, slug] = splitRef(ref);
    return this.#json(await this.#request("DELETE", `/modules/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/star`, { headers: bearer(token) }), starResponse, "l'étoile");
  }

  /** Avis sur une version (PUT /v1/modules/:ns/:slug/:version/review : un avis par compte, remplacé s'il existe). */
  async review(req: { ref: string; version: string; rating: number; body?: string }, token: string): Promise<z.infer<typeof reviewItem>> {
    const [ns, slug] = splitRef(req.ref);
    const version = versionString.parse(req.version);
    const body = reviewRequest.parse({ rating: req.rating, body: req.body ?? "" });
    const res = await this.#request("PUT", `/modules/${encodeURIComponent(ns)}/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/review`, jsonBody(token, body));
    return this.#json(res, reviewItem, "l'avis");
  }

  /** Signalement d'une version, d'un pack ou d'un avis (POST /v1/reports). */
  async report(req: z.input<typeof reportRequest>, token: string): Promise<z.infer<typeof reportResponse>> {
    return this.#json(await this.#request("POST", "/reports", jsonBody(token, reportRequest.parse(req))), reportResponse, "le signalement");
  }

  /**
   * Télémétrie acceptée (POST /v1/telemetry, anonyme) : le corps est validé par le schéma strict du contrat,
   * qui refuse tout champ inconnu (aucun texte libre, aucun identifiant d'étude ni de projet).
   */
  async telemetry(req: z.input<typeof telemetryRequest>): Promise<z.infer<typeof telemetryResponse>> {
    return this.#json(await this.#request("POST", "/telemetry", jsonBody(null, telemetryRequest.parse(req))), telemetryResponse, "la télémétrie");
  }

  /**
   * Recherche distante (GET /v1/search) d'un texte tapé par l'utilisateur dans `personas hub search --remote`.
   * Ne jamais y passer un pitch ni une description de projet : le choix automatique cherche en local.
   */
  async search(query: string, opts: { socle?: string; limit?: number } = {}): Promise<z.infer<typeof searchResponse>> {
    const qs = new URLSearchParams({ q: query, ...(opts.socle && { socle: opts.socle }), ...(opts.limit && { limit: String(opts.limit) }) });
    const res = await this.#request("GET", `/search?${qs}`);
    return this.#json(res, searchResponse, "la recherche");
  }

  /** Publication d'administration d'un module (POST /v1/admin/modules, jeton d'administration). */
  async publishModule(req: z.input<typeof publishModuleRequest>, token: string): Promise<z.infer<typeof publishResponse>> {
    const body = JSON.stringify(publishModuleRequest.parse(req));
    const res = await this.#request("POST", "/admin/modules", { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
    return this.#json(res, publishResponse, "la publication");
  }

  /** Publication d'administration d'une version de pack (POST /v1/admin/packs). */
  async publishPack(req: z.input<typeof publishPackRequest>, token: string): Promise<z.infer<typeof publishResponse>> {
    const body = JSON.stringify(publishPackRequest.parse(req));
    const res = await this.#request("POST", "/admin/packs", { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
    return this.#json(res, publishResponse, "la publication du pack");
  }
}
