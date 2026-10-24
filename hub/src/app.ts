import { createHash, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { namespaceSlug, OFFICIAL_NAMESPACE, publishModuleRequest, preferLang, publishPackRequest, type CatalogResponse } from "../../src/hub/contract";
import type { HubDb } from "../db/client";
import { modules, moduleVersions, users } from "../db/schema";
import { createAuth, type AuthConfig } from "./auth";
import { loadLegal } from "./legal";
import { PublishError, sha256 } from "./module-check";
import { MAX_PACK_BYTES } from "./pack-check";
import { publishModuleVersion, publishPackVersion, type PublishDeps } from "./publish";
import { preferLanguage, rankCatalog, rankedSearch, moduleRankings } from "./ranking";
import { registerCollabRoutes } from "./routes";
import { loadSigner, signatureOf, type Signer } from "./signing";
import { loadAssets } from "./assets";
import { isUiLang, UI_COOKIE, uiFromAcceptLanguage, type UiLang } from "./i18n";
import { renderDevice, renderIndex, renderLegal, renderModule, renderNotFound, renderServerError, type PageCtx } from "./pages";
import {
  buildCatalog,
  catalogModuleOf,
  findModule,
  findModuleVersion,
  findPackVersion,
  iso,
  moduleDepsOf,
  moduleVersionRows,
  socleLocales,
} from "./repo";
import { RateLimiter } from "./rate-limit";

/**
 * Service Hub : catalogue public, pages publiques, publication d'administration (jeton
 * HUB_ADMIN_TOKEN) et, en phase 3, Hub collaboratif (comptes Supabase, jetons personnels, publication
 * par les utilisateurs, forks, étoiles, avis, modération, télémétrie : hub/src/routes/).
 * Contrat : src/hub/contract.ts.
 */

export interface HubOptions {
  db: HubDb;
  /** Jeton d'administration ; absent ou vide : publication désactivée (403). */
  adminToken?: string | undefined;
  publicBaseUrl?: string;
  /** Faire confiance à X-Forwarded-For / CF-Connecting-IP (derrière le reverse proxy). */
  trustProxy?: boolean;
  /** Requêtes par minute et par IP : lecture, et publication d'administration. */
  rateLimit?: { readPerMinute: number; adminPerMinute: number; writePerMinute?: number };
  log?: (line: Record<string, unknown>) => void;
  /** Phase 3 : vérification des JWT de Supabase Auth (absente : seuls les jetons personnels passent). */
  auth?: AuthConfig;
  /** Clé de signature Ed25519 des versions (HUB_SIGNING_KEY), ou signataire déjà chargé. */
  signingKey?: string | undefined;
  signer?: Signer | null;
  /** Clé anonyme (publique) de Supabase, pour le lien magique de la page /device (SUPABASE_ANON_KEY). */
  supabaseAnonKey?: string | undefined;
  /** Intervalle de sondage du flux d'appareil, en secondes (5 par défaut ; 0 dans les tests). */
  deviceIntervalSec?: number;
}

const MODULE_BODY_LIMIT = 256 * 1024 * 2 + 4096; // YAML 256 Ko, échappement JSON compris
const PACK_BODY_LIMIT = MAX_PACK_BYTES * 2 + 4096;
const DELETED_AUTHOR = "auteur supprimé";

type ErrorCode = "not_found" | "invalid" | "conflict" | "unauthorized" | "rate_limited" | "internal";
/** `reason` : précision stable et facultative (ex. état d'un code d'appareil), en plus de `code`. */
const errorBody = (code: ErrorCode, message: string, reason?: string) => ({ error: reason ? { code, message, reason } : { code, message } });

/** Comparaison en temps constant (empreintes de même longueur), sans jamais journaliser le jeton. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag);
}

export function createHubApp(opts: HubOptions) {
  const { db } = opts;
  const log = opts.log ?? (() => {});
  const limits = opts.rateLimit ?? { readPerMinute: 600, adminPerMinute: 60 };
  const readLimiter = new RateLimiter(limits.readPerMinute, 60_000);
  const adminLimiter = new RateLimiter(limits.adminPerMinute, 60_000);
  const writeLimiter = new RateLimiter(limits.writePerMinute ?? 30, 60_000);
  const app = new Hono();
  const signer = opts.signer !== undefined ? opts.signer : loadSigner(opts.signingKey);
  const auth = createAuth(db, opts.auth);
  const legal = loadLegal();

  let catalogCache: { body: string; etag: string; data: CatalogResponse } | null = null;
  const invalidate = () => {
    catalogCache = null;
  };
  // Publications sérialisées : l'aperçu est synchrone et le contrôle 409 précède l'insertion.
  let publishQueue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = publishQueue.then(fn, fn);
    publishQueue = run.catch(() => {});
    return run;
  };
  const publishDeps: PublishDeps = { db, signer, serialized, invalidate };

  const clientIp = (c: Context): string => {
    if (opts.trustProxy) {
      const h = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (h) return h;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  // Journal structuré : méthode, chemin, statut, durée. Jamais d'en-têtes ni de corps (jeton, YAML).
  app.use("*", async (c, next) => {
    const t0 = performance.now();
    await next();
    log({ at: new Date().toISOString(), method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - t0) });
  });
  // CSP stricte : feuille de style, polices et icône servies par le Hub ; aucun script, aucun style en ligne.
  // Seule exception, la page /device (connexion de la CLI) : son script, et Supabase Auth en connect-src.
  const pageCsp = { defaultSrc: ["'none'"], styleSrc: ["'self'"], fontSrc: ["'self'"], imgSrc: ["'self'", "data:"], formAction: ["'self'"], baseUri: ["'none'"], frameAncestors: ["'none'"] };
  const supabaseOrigin = (() => {
    try {
      return opts.auth?.supabaseUrl ? new URL(opts.auth.supabaseUrl).origin : null;
    } catch {
      return null;
    }
  })();
  const strictHeaders = secureHeaders({ contentSecurityPolicy: pageCsp });
  const deviceHeaders = supabaseOrigin ? secureHeaders({ contentSecurityPolicy: { ...pageCsp, scriptSrc: ["'self'"], connectSrc: ["'self'", supabaseOrigin] } }) : strictHeaders;
  app.use("*", (c, next) => (c.req.path === "/device" ? deviceHeaders : strictHeaders)(c, next));
  app.use("/v1/*", async (c, next) => {
    const admin = c.req.path.startsWith("/v1/admin/");
    const limiter = admin ? adminLimiter : readLimiter;
    const r = limiter.take(clientIp(c));
    if (!r.ok) {
      c.header("Retry-After", String(r.retryAfterSec));
      return c.json(errorBody("rate_limited", "Trop de requêtes, réessayer plus tard."), 429);
    }
    await next();
  });
  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/admin/")) return next();
    return cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], allowHeaders: ["If-None-Match"], exposeHeaders: ["ETag"], maxAge: 86_400 })(c, next);
  });

  app.onError((err, c) => {
    if (err instanceof PublishError) return c.json(errorBody(err.code, err.message, err.reason), err.status);
    log({ at: new Date().toISOString(), level: "error", path: c.req.path, message: err.message });
    // API : JSON stable ; pages publiques : page HTML traduite, comme la 404.
    if (c.req.path.startsWith("/v1/")) return c.json(errorBody("internal", "Erreur interne."), 500);
    c.header("Cache-Control", "no-store");
    return c.html(renderServerError(pageCtx(c)), 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ── Ressources statiques des pages (CSS, polices, icône) ────────────────
  const assets = loadAssets();
  app.get("/assets/*", (c) => {
    const name = c.req.path.slice("/assets/".length);
    const a = assets.files.get(name);
    if (!a) return c.text("Not found", 404);
    c.header("ETag", a.etag);
    // Feuille versionnée (?v=empreinte) et polices : immuables ; sinon revalidation courte.
    c.header("Cache-Control", name.startsWith("fonts/") || c.req.query("v") ? "public, max-age=31536000, immutable" : "public, max-age=300");
    if (etagMatches(c.req.header("if-none-match"), a.etag)) return c.body(null, 304);
    return c.body(a.body as Uint8Array<ArrayBuffer>, 200, { "Content-Type": a.type });
  });
  app.get("/favicon.ico", (c) => c.redirect(assets.faviconHref, 301));

  // ── Lecture publique ─────────────────────────────────────────────────────

  /** Champs additifs d'une version (phase 3) : signature, filiation, auteur, badges, attributs sensibles. */
  const versionExtras = async (m: { id: string; namespace: string; slug: string; forkedFromVersionId: string | null }, v: { status: string; sensitive: string[]; signature: string | null; signatureKid: string | null; publishedBy: string | null }) => {
    let author: string | null = null;
    // Indicateur explicite pour l'affichage (texte traduit), au lieu de comparer la chaîne DELETED_AUTHOR.
    let authorDeleted = false;
    if (v.publishedBy) {
      const [u] = await db.select({ displayName: users.displayName, deletedAt: users.deletedAt, namespace: users.namespace }).from(users).where(eq(users.id, v.publishedBy));
      authorDeleted = !u || Boolean(u.deletedAt);
      author = !u || u.deletedAt ? DELETED_AUTHOR : (u.displayName ?? u.namespace);
    }
    let forkedFrom: { ref: string; version: string } | null = null;
    if (m.forkedFromVersionId) {
      const [o] = await db.select({ ns: modules.namespace, slug: modules.slug, version: moduleVersions.version }).from(moduleVersions).innerJoin(modules, eq(modules.id, moduleVersions.moduleId)).where(eq(moduleVersions.id, m.forkedFromVersionId));
      if (o) forkedFrom = { ref: `${o.ns}/${o.slug}`, version: o.version };
    }
    const badges = [...(m.namespace === OFFICIAL_NAMESPACE ? ["official"] : []), ...(v.status === "verified" ? ["verified"] : []), ...(v.status === "unverified" ? ["unverified"] : []), ...(v.sensitive.length ? ["sensitive"] : []), ...(m.forkedFromVersionId ? ["fork"] : [])];
    return { signature: signatureOf(v), forkedFrom, author, authorDeleted, badges, sensitive: v.sensitive };
  };

  const catalog = async () => {
    if (!catalogCache) {
      // Tri par défaut : classement R (§ 5.2), chaque carte avec son classement (ajout additif)
      const data = await rankCatalog(db, await buildCatalog(db));
      const body = JSON.stringify(data);
      catalogCache = { body, etag: `"${sha256(body).slice(0, 32)}"`, data };
    }
    return catalogCache;
  };

  // Variantes `prefer=` du catalogue (ajout additif) : mêmes cartes, langue demandée d'abord.
  const preferParam = preferLang.optional();
  const preferredCatalogs = new Map<string, { base: string; body: string; etag: string }>();
  app.get("/v1/catalog", async (c) => {
    const pref = preferParam.safeParse(c.req.query("prefer") || undefined);
    if (!pref.success) return c.json(errorBody("invalid", "prefer : fr ou en."), 422);
    const base = await catalog();
    let cat: { body: string; etag: string } = base;
    if (pref.data) {
      let v = preferredCatalogs.get(pref.data);
      if (!v || v.base !== base.etag) {
        const data = { ...base.data, modules: preferLanguage(base.data.modules, pref.data, await socleLocales(db)) };
        const body = JSON.stringify(data);
        v = { base: base.etag, body, etag: `"${sha256(body).slice(0, 32)}"` };
        preferredCatalogs.set(pref.data, v);
      }
      cat = v;
    }
    c.header("ETag", cat.etag);
    c.header("Cache-Control", "public, max-age=60, must-revalidate");
    if (etagMatches(c.req.header("if-none-match"), cat.etag)) return c.body(null, 304);
    return c.body(cat.body, 200, { "Content-Type": "application/json; charset=utf-8" });
  });

  app.get("/v1/modules/:ns/:slug", async (c) => {
    const m = await findModule(db, c.req.param("ns"), c.req.param("slug"));
    const card = m && m.status !== "hidden" ? catalogModuleOf(m, await moduleVersionRows(db, m.id), true, await socleLocales(db)) : null;
    if (!card) return c.json(errorBody("not_found", "Module introuvable."), 404);
    c.header("Cache-Control", "public, max-age=60");
    const ranking = (await moduleRankings(db)).get(card.ref);
    return c.json(ranking ? { ...card, ranking } : card);
  });

  app.get("/v1/modules/:ns/:slug/:version", async (c) => {
    const found = await findModuleVersion(db, c.req.param("ns"), c.req.param("slug"), c.req.param("version"));
    if (!found) return c.json(errorBody("not_found", "Version introuvable."), 404);
    const v = found.version;
    // Retirée par la modération (contenu illégal ou malveillant) : téléchargement refusé
    if (v.status === "removed") return c.json(errorBody("not_found", "Version retirée par la modération : téléchargement refusé."), 410);
    const etag = `"${v.sha256}"`;
    c.header("ETag", etag);
    // Contenu immuable ; le statut (yanked) peut changer, d'où un cache court.
    c.header("Cache-Control", "public, max-age=300");
    if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    return c.json({
      ref: `${found.module.namespace}/${found.module.slug}`,
      version: v.version,
      sha256: v.sha256,
      yaml: v.yaml,
      requires: v.requires,
      quality: v.quality ?? null,
      publishedAt: iso(v.publishedAt),
      status: v.status,
      license: v.license,
      ...(await versionExtras(found.module, v)),
    });
  });

  app.get("/v1/packs/:ns/:slug/:version", async (c) => {
    const found = await findPackVersion(db, c.req.param("ns"), c.req.param("slug"), c.req.param("version"));
    if (!found) return c.json(errorBody("not_found", "Version de pack introuvable."), 404);
    const v = found.version;
    if (v.status === "removed") return c.json(errorBody("not_found", "Version retirée par la modération : téléchargement refusé."), 410);
    const etag = `"${v.sha256}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "public, max-age=300");
    if (etagMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    return c.json({ ref: `${found.pack.namespace}/${found.pack.slug}`, version: v.version, sha256: v.sha256, files: v.files, extends: v.extends, license: v.license, status: v.status, publishedAt: iso(v.publishedAt), signature: signatureOf(v) });
  });

  const searchQuery = z.object({
    q: z.string().max(200).default(""),
    socle: z.string().regex(/^[a-z0-9-]{1,40}$/).optional(),
    lang: z.string().regex(/^[a-z]{2,3}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** Tri : `r` (classement R, défaut) ou `q` (score de qualité). */
    sort: z.enum(["r", "q"]).default("r"),
    /** Langue mise en avant (ajout additif) : modules dans cette langue d'abord, rien n'est filtré. */
    prefer: preferLang.optional(),
  });

  app.get("/v1/search", async (c) => {
    const p = searchQuery.safeParse({ q: c.req.query("q") ?? undefined, socle: c.req.query("socle") || undefined, lang: c.req.query("lang") || undefined, limit: c.req.query("limit") ?? undefined, sort: c.req.query("sort") || undefined, prefer: c.req.query("prefer") || undefined });
    if (!p.success) return c.json(errorBody("invalid", p.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join("; ")), 422);
    const results = await rankedSearch(db, { q: p.data.q, ...(p.data.socle && { socle: p.data.socle }), ...(p.data.lang && { lang: p.data.lang }), limit: p.data.limit, sort: p.data.sort, ...(p.data.prefer && { prefer: p.data.prefer }) });
    c.header("Cache-Control", "public, max-age=30");
    return c.json({ query: p.data.q, sort: p.data.sort, ...(p.data.prefer && { prefer: p.data.prefer }), results });
  });

  // ── Hub collaboratif (phase 3) : routes de hub/src/routes/ ──────────────
  registerCollabRoutes(app, {
    db,
    auth,
    signer,
    publish: publishDeps,
    invalidate,
    publicBaseUrl: opts.publicBaseUrl ?? "",
    adminToken: opts.adminToken,
    tokenMatches,
    deviceIntervalSec: opts.deviceIntervalSec ?? 5,
    writeLimiter,
    legal,
  });

  app.all("/v1/*", (c, next) => (c.req.path.startsWith("/v1/admin/") ? next() : c.json(errorBody("not_found", "Route inconnue."), 404)));

  // ── Administration ───────────────────────────────────────────────────────

  app.use("/v1/admin/*", async (c, next) => {
    const auth = c.req.header("authorization");
    const m = auth ? /^Bearer (\S+)$/.exec(auth) : null;
    if (!m) return c.json(errorBody("unauthorized", "Jeton d'administration requis (Authorization: Bearer …)."), 401);
    if (!opts.adminToken || !tokenMatches(m[1]!, opts.adminToken)) return c.json(errorBody("unauthorized", "Jeton refusé."), 403);
    await next();
  });

  const readJson = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new PublishError(422, "invalid", "Corps JSON illisible.");
    }
  };

  // Même porte que la publication des utilisateurs (hub/src/publish.ts) : validation, lint, aperçu, Q, signature.
  app.post(
    "/v1/admin/modules",
    bodyLimit({ maxSize: MODULE_BODY_LIMIT, onError: (c) => c.json(errorBody("invalid", "Module trop gros (256 Ko au plus)."), 413) }),
    async (c) => {
      const parsed = publishModuleRequest.safeParse(await readJson(c));
      if (!parsed.success) return c.json(errorBody("invalid", parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join("; ")), 422);
      const out = await publishModuleVersion(publishDeps, { namespace: parsed.data.namespace, yaml: parsed.data.yaml, publishedBy: null });
      return c.json(out, 201);
    },
  );

  app.post(
    "/v1/admin/packs",
    bodyLimit({ maxSize: PACK_BODY_LIMIT, onError: (c) => c.json(errorBody("invalid", "Pack trop gros (5 Mo au plus)."), 413) }),
    async (c) => {
      const parsed = publishPackRequest.safeParse(await readJson(c));
      if (!parsed.success) return c.json(errorBody("invalid", parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join("; ")), 422);
      const req = parsed.data;
      if (!namespaceSlug.safeParse(req.namespace).success) return c.json(errorBody("invalid", "namespace invalide."), 422);
      const out = await publishPackVersion(publishDeps, { ...req, publishedBy: null });
      return c.json(out, 201);
    },
  );

  // ── Pages publiques (HTML rendu côté serveur, interface en français ou en anglais) ──

  /**
   * Langue de l'interface : ?ui=fr|en (mémorisée dans un cookie), sinon le cookie, sinon
   * Accept-Language. Les pages varient donc selon ces en-têtes (Vary, cache privé).
   */
  const pageCtx = (c: Context): PageCtx => {
    const asked = c.req.query("ui");
    let ui: UiLang;
    if (isUiLang(asked)) {
      ui = asked;
      setCookie(c, UI_COOKIE, ui, { path: "/", maxAge: 365 * 86_400, sameSite: "Lax", httpOnly: true, secure: new URL(c.req.url).protocol === "https:" || (opts.publicBaseUrl ?? "").startsWith("https:") });
    } else {
      const saved = getCookie(c, UI_COOKIE);
      ui = isUiLang(saved) ? saved : uiFromAcceptLanguage(c.req.header("accept-language"));
    }
    c.header("Vary", "Accept-Language, Cookie");
    c.header("Content-Language", ui);
    const url = new URL(c.req.url);
    return {
      ui,
      uiHref: (l) => {
        const sp = new URLSearchParams(url.search);
        sp.set("ui", l);
        return `${url.pathname}?${sp.toString()}`;
      },
      cssHref: assets.cssHref,
      faviconHref: assets.faviconHref,
      baseUrl: opts.publicBaseUrl,
    };
  };
  const slugParam = (v: string | undefined) => (v && /^[a-z0-9-]{1,40}$/.test(v) ? v : undefined);

  app.get("/", async (c) => {
    const ctx = pageCtx(c);
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const socle = slugParam(c.req.query("socle"));
    const langQ = c.req.query("lang");
    const lang = langQ && /^[a-z]{2,3}$/.test(langQ) ? langQ : undefined;
    const sort = c.req.query("sort") === "q" ? "q" : "r";
    // Recherche texte seule, triée par R puis Q (défaut) ou par Q, modules dans la langue de l'interface
    // d'abord (mise en avant, pas un filtre) ; langue et socle filtrés au rendu, pour compter chaque option.
    const hits = await rankedSearch(db, { q, limit: 100, sort, prefer: ctx.ui });
    const cat = await catalog();
    const locales = await socleLocales(db);
    c.header("Cache-Control", "private, max-age=60");
    const view = c.req.query("view") === "packs" ? "packs" : undefined;
    return c.html(renderIndex(ctx, { hits, q, lang, socle, sort, catalog: cat.data, locales, view }));
  });

  app.get("/m/:ns/:slug", async (c) => {
    const ctx = pageCtx(c);
    const m = await findModule(db, c.req.param("ns"), c.req.param("slug"));
    if (!m || m.status === "hidden") return c.html(renderNotFound(ctx), 404);
    const rows = await moduleVersionRows(db, m.id);
    const locales = await socleLocales(db);
    const card = catalogModuleOf(m, rows, true, locales);
    if (!card) return c.html(renderNotFound(ctx), 404);
    const latest = rows.find((r) => r.version === card.latest)!;
    const deps = await moduleDepsOf(db, latest.id);
    const cat = await catalog();
    const ranking = (await moduleRankings(db)).get(card.ref);
    const extras = await versionExtras(m, latest);
    c.header("Cache-Control", "private, max-age=60");
    return c.html(renderModule(ctx, { card, latest, deps, packs: cat.data.packs, locales, ranking, extras }));
  });

  // Textes légaux : mêmes fichiers que GET /v1/legal/:doc (hub/legal/), dans la langue de l'interface.
  for (const doc of ["terms", "privacy"] as const) {
    app.get(`/${doc}`, (c) => {
      const ctx = pageCtx(c);
      const v = legal.get(`${doc}.${ctx.ui}`) ?? legal.get(`${doc}.${ctx.ui === "fr" ? "en" : "fr"}`);
      if (!v) return c.html(renderNotFound(ctx), 404);
      c.header("Cache-Control", "private, max-age=3600");
      return c.html(renderLegal(ctx, { doc, lang: legal.has(`${doc}.${ctx.ui}`) ? ctx.ui : ctx.ui === "fr" ? "en" : "fr", version: v.version, markdown: v.markdown }));
    });
  }

  // Validation de `personas hub login` (flux d'appareil) : connexion Supabase, puis /v1/device/*.
  app.get("/device", (c) => {
    const ctx = pageCtx(c);
    c.header("Cache-Control", "no-store");
    const base = (opts.publicBaseUrl || new URL(c.req.url).origin).replace(/\/+$/, "");
    return c.html(
      renderDevice(ctx, {
        code: c.req.query("code") ?? "",
        supabase: opts.auth?.supabaseUrl ? { url: opts.auth.supabaseUrl, anonKey: opts.supabaseAnonKey } : null,
        redirect: `${base}/device`,
        scriptHref: assets.deviceJsHref,
      }),
    );
  });

  app.notFound((c) => (c.req.path.startsWith("/v1/") ? c.json(errorBody("not_found", "Route inconnue."), 404) : c.html(renderNotFound(pageCtx(c)), 404)));

  return app;
}
