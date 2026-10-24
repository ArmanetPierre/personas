import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { serveStatic } from "@hono/node-server/serve-static";
import { count, eq, sum } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { JSONWebKeySet } from "jose";
import { z } from "zod";
import { PACKAGE_ROOT, withDataScope } from "../config";
import type { Db } from "../db/client";
import { BUDGET_ERROR_PREFIX } from "../engine/budget";
import { createProject, getProject, projectFileSchema, slugify } from "../studies/project";
import { DEMO_N, DEMO_PROJECTS, demoCopy } from "../web/setup-routes";
import { createJwtVerifier } from "../auth/supabase-jwt";
import { engineUsage, projects, studies } from "../db/schema";
import { createBackendFromProfile, redactSecrets } from "../engine";
import { HOSTED_PROFILE, HOSTED_PROVIDERS, type EngineProfile } from "../engine/profiles";
import { memoryStore } from "../engine/secrets";
import type { Pack } from "../personas/pack";
import { resolveSoclePack } from "../population/target";
import { HOSTED_FEATURES } from "../web/features";
import type { AssistantLoader } from "../web/modules";
import { AccountPool, type Account } from "./accounts";
import type { HostedConfig } from "./config";
import { decryptEngineKey, deleteEngine, readEngineSummary, saveEngine } from "./engine-key";
import { exportAccount } from "./export";
import { contentSecurityPolicy, HSTS, inlineScriptHashes, isHttps, originOf } from "./headers";
import { maskedPath, routePolicy } from "./policy";
import { JobQueue, type HostedSpawnFn } from "./queue";
import { AuthError, createRateLimiter, createSessions, type Authenticated } from "./session";
import { Tombstones, tombstonesFileOf } from "./tombstones";

/**
 * Serveur du service hébergé (`PERSONAS_MODE=hosted`, docs/plateforme.md § 13, phase 4) :
 * - authentification par JWT de Supabase (comptes invités, aucune inscription), cookie de session et CSRF ;
 * - un dossier de données et une base SQLite PAR COMPTE ; les routes du tableau de bord (src/web/app.ts),
 *   en liste blanche, servies avec le contexte du compte de la requête ;
 * - clé IA de l'utilisateur chiffrée (AES-256-GCM), plafonds de dépense, file de travail ;
 * - compte : lecture, export, suppression complète.
 */

export interface HostedDeps {
  config: HostedConfig;
  pack?: Pack;
  /** fetch du test de clé (tests : faux fournisseur). */
  fetch?: typeof fetch;
  spawnFn?: HostedSpawnFn;
  /** Jeu de clés local (tests). */
  jwks?: JSONWebKeySet;
  assistant?: AssistantLoader;
  /** Journal du serveur (une ligne par requête, sans contenu de projet). */
  log?: (line: string) => void;
  /** Build du front (web/dist) ; null : API seule. */
  webDist?: string | null;
  /** Environnement d'où sont reprises les rares variables transmises aux enfants (PATH, TZ…). */
  env?: NodeJS.ProcessEnv;
}

export interface HostedServer {
  app: Hono<HostedEnv>;
  pool: AccountPool;
  queue: JobQueue;
  close(): void;
}

const keySchema = z.string().trim().min(8).max(512).regex(/^\S+$/);
const engineBody = z.strictObject({
  provider: z.enum(HOSTED_PROVIDERS),
  model: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/@-]+$/),
  apiKey: keySchema.optional(),
  perStudyUsd: z.number().positive().optional(),
  perMonthUsd: z.number().positive().optional(),
  limits: z.strictObject({ perStudyUsd: z.number().positive().optional(), perMonthUsd: z.number().positive().optional() }).optional(),
});

export type HostedEnv = { Variables: { auth: Authenticated } };

/** Date de création du compte : celle de son dossier. */
function accountCreatedAt(dir: string): string | null {
  try {
    const st = statSync(dir);
    return (st.birthtimeMs > 0 ? st.birthtime : st.ctime).toISOString();
  } catch {
    return null;
  }
}

/** Projet de démonstration copié dans le dossier du compte (effectif réduit), créé en base s'il n'existe pas. */
function createDemoProject(db: Db, dir: string, lang: "fr" | "en"): { projectId: string; created: boolean } {
  const src = resolve(PACKAGE_ROOT, DEMO_PROJECTS[lang]);
  const text = demoCopy(src);
  const file = projectFileSchema.parse(/\.ya?ml$/i.test(src) ? parseYaml(text) : JSON.parse(text));
  const id = file.id ?? slugify(file.name);
  const existing = getProject(db, id);
  if (existing) return { projectId: existing.id, created: false };
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(join(dir, "projects", basename(src)), text);
  return { projectId: createProject(db, file).id, created: true };
}

/**
 * Messages d'erreur du tableau de bord local qui citent des commandes (`npm run engine:…`, `--profile`) : en
 * hébergé, remplacés par l'action à faire dans l'interface.
 */
async function hostedErrors(res: Response, ctx: { hasKey: () => boolean; lang: "fr" | "en" }): Promise<Response> {
  if (res.status < 400 || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  if (!body || typeof body.error !== "string") return res;
  const msg = body.error;
  let error: string;
  let code: unknown;
  if (HOSTED_PROVIDER_REFUSED.test(msg)) {
    // Refus d'un moteur local (src/engine/profiles.ts) : sans clé, c'est le moteur par défaut du tableau de bord
    // local qui a été choisi ; jamais son nom ici
    const hasKey = ctx.hasKey();
    error = hasKey ? providerRefused(ctx.lang) : keyRequired(ctx.lang);
    code = hasKey ? "provider_refused" : "key_required";
  } else if (/npm run|engine:(profile|key)|--profile|--per-/.test(msg)) {
    error = msg.startsWith(BUDGET_ERROR_PREFIX)
      ? `${msg.split(" Relever le plafond")[0]} Relever le plafond dans « Ma clé IA », puis relancer l'étude (les réponses déjà obtenues sont gardées).`
      : "Moteur non configuré pour ce compte : enregistrer votre clé IA (page « Ma clé IA »), puis réessayer.";
    code = body.code ?? (msg.startsWith(BUDGET_ERROR_PREFIX) ? "budget" : "engine_not_configured");
  } else return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...body, error, code }), { status: res.status, headers });
}

/** Message de `HostedProviderError` (src/engine/profiles.ts) : « Moteur <fournisseur> refusé sur le service hébergé… ». */
const HOSTED_PROVIDER_REFUSED = /Moteur \S+ refusé sur le service hébergé/;
const keyRequired = (lang: "fr" | "en") =>
  lang === "en" ? "No AI key saved: add one in “My AI key”." : "Aucune clé IA enregistrée : ajoutez-en une dans « Ma clé IA ».";
const providerRefused = (lang: "fr" | "en") =>
  lang === "en"
    ? "Engine refused on the hosted service: only Anthropic, OpenAI, Gemini and OpenRouter, with your key (“My AI key” page)."
    : "Moteur refusé sur le service hébergé : seuls Anthropic, OpenAI, Gemini et OpenRouter, avec votre clé (page « Ma clé IA »).";
const langOfRequest = (c: Context<HostedEnv>, body?: { lang?: unknown } | null): "fr" | "en" => (body?.lang === "en" || c.req.query("lang") === "en" ? "en" : "fr");

/** `application/json`, avec ou sans paramètres (`; charset=utf-8`). */
const isJson = (type: string | undefined) => !!type && type.split(";")[0]!.trim().toLowerCase() === "application/json";

const userTag = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 10);

export function createHostedServer(deps: HostedDeps): HostedServer {
  const cfg = deps.config;
  // Socle courant (packs/socles.json : fr → fr-2026.2), comme le tableau de bord local (src/web/context.ts)
  const pack = deps.pack ?? resolveSoclePack("fr");
  const log = deps.log ?? ((line: string) => console.log(line));
  const verifier = createJwtVerifier({ ...cfg.auth, ...(deps.jwks && { jwks: deps.jwks }) });
  const tombstones = new Tombstones({ file: tombstonesFileOf(cfg.dataRoot) });
  const sessions = createSessions({ verifier, secure: cfg.cookieSecure, allowedOrigins: cfg.allowedOrigins, isDeleted: (u) => tombstones.isDeleted(u) });
  const limiter = createRateLimiter(cfg.ratePerMinute);
  const defaults = { perStudyUsd: cfg.defaultPerStudyUsd, perMonthUsd: cfg.defaultMonthlyUsd };

  let pool!: AccountPool;
  const queue = new JobQueue({
    stateFile: join(cfg.dataRoot, "_system", "queue.json"),
    concurrency: cfg.concurrency,
    perAccount: cfg.accountConcurrency,
    accountDir: (userId) => pool.dirOf(userId),
    secretFor: (userId) => decryptEngineKey(pool.dirOf(userId), userId, cfg.masterKey),
    baseEnv: deps.env ?? process.env,
    ...(deps.spawnFn && { spawnFn: deps.spawnFn }),
    onExit: (job, code) => log(`job ${job.kind} fin code=${code ?? "-"} u=${userTag(job.userId)}`),
  });
  pool = new AccountPool({ root: cfg.dataRoot, pack, queue, idleMs: cfg.idleMs, ...(deps.assistant && { assistant: deps.assistant }) });
  // Reprise après redémarrage : les tâches relues repartent dès que la file tourne
  queue.pump();
  const sweeper = setInterval(() => pool.sweep(), Math.min(cfg.idleMs, 60_000));
  sweeper.unref();

  const app = new Hono<HostedEnv>();
  const supabaseOrigin = originOf(cfg.publicAuth.supabaseUrl);
  const baseCsp = contentSecurityPolicy({ supabaseOrigin });

  // ── Journal (sans identifiant ni contenu de projet) et en-têtes de sécurité ──
  app.use(async (c, next) => {
    const t0 = performance.now();
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "same-origin");
    c.header("x-frame-options", "DENY");
    // CSP de base (API, ressources) ; les pages du front posent la leur, avec l'empreinte du script en ligne
    if (!c.res.headers.has("content-security-policy")) c.header("content-security-policy", baseCsp);
    if (isHttps(c.req.url, c.req.header("x-forwarded-proto"), cfg.trustProxy)) c.header("strict-transport-security", HSTS);
    if (c.req.path.startsWith("/api/")) c.header("cache-control", "no-store");
    const u = c.get("auth") as Authenticated | undefined;
    log(`${c.req.method} ${maskedPath(c.req.path)} ${c.res.status} ${Math.round(performance.now() - t0)}ms${u ? ` u=${userTag(u.user.id)}` : ""}`);
  });

  app.use("/api/*", bodyLimit({ maxSize: cfg.maxBodyBytes, onError: (c) => c.json({ error: "Requête trop volumineuse.", code: "too_large" }, 413) }));

  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message, code: err.code }, err.status);
    // Jamais de détail interne (chemins, pile) vers le client
    log(`erreur ${maskedPath(c.req.path)} ${(err as Error).name}`);
    return c.json({ error: "Erreur interne." }, 500);
  });

  const clientIp = (c: Context<HostedEnv>): string => {
    if (cfg.trustProxy) {
      const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? "?";
  };

  const tooMany = (c: Context<HostedEnv>) => c.json({ error: "Trop de requêtes : réessayer dans une minute.", code: "rate_limited" }, 429);

  /** Authentifie, limite le débit du compte, et garde l'utilisateur dans le contexte. */
  async function auth(c: Context<HostedEnv>): Promise<Authenticated> {
    if (!limiter.hit(`ip:${clientIp(c)}`, cfg.ratePerMinute * 2)) throw new AuthError(429, "rate_limited", "Trop de requêtes : réessayer dans une minute.");
    const a = await sessions.authenticate(c);
    c.set("auth", a);
    return a;
  }

  // ── Session ──
  // Même contrôle d'origine que les autres écritures ; corps JSON obligatoire (pas de requête « simple » text/plain
  // ou formulaire, envoyée sans pré-vol depuis un autre site)
  app.post("/api/session", async (c) => {
    if (!limiter.hit(`session:${clientIp(c)}`, 30)) return tooMany(c);
    sessions.checkOrigin(c);
    if (!isJson(c.req.header("content-type"))) return c.json({ error: "Corps JSON requis (Content-Type: application/json).", code: "unsupported_media_type" }, 415);
    const body = (await c.req.json().catch(() => null)) as { accessToken?: unknown } | null;
    const { user, csrfToken, expiresAt } = await sessions.open(c, typeof body?.accessToken === "string" ? body.accessToken : undefined);
    c.set("auth", { user, via: "bearer", payload: {} });
    return c.json({ user, csrfToken, expiresAt });
  });

  app.delete("/api/session", (c) => {
    sessions.checkOrigin(c);
    sessions.close(c);
    return c.json({ ok: true });
  });

  // ── Méta : publique (page de connexion), complète une fois connecté ──
  app.get("/api/meta", async (c) => {
    const publicMeta = {
      mode: "hosted" as const,
      features: HOSTED_FEATURES,
      supabaseUrl: cfg.publicAuth.supabaseUrl,
      supabaseAnonKey: cfg.publicAuth.anonKey,
      githubEnabled: cfg.publicAuth.githubEnabled,
      auth: cfg.publicAuth,
    };
    let a: Authenticated;
    try {
      a = await auth(c);
    } catch (err) {
      // Compte supprimé : comme sans session (le front doit rester en mode hébergé, sur la page de connexion)
      if (err instanceof AuthError && (err.status === 401 || err.code === "account_deleted")) return c.json({ ...publicMeta, authenticated: false });
      throw err;
    }
    if (!limiter.hit(`user:${a.user.id}`)) return tooMany(c);
    const res = await delegate(c, pool.get(a.user.id));
    if (res.status !== 200) return res;
    const body = (await res.json()) as Record<string, unknown>;
    return c.json({ ...body, ...publicMeta, authenticated: true });
  });

  // Toutes les autres routes /api exigent une session
  app.use("/api/*", async (c, next) => {
    const a = await auth(c);
    if (!limiter.hit(`user:${a.user.id}`)) return tooMany(c);
    await next();
  });

  const userOf = (c: Context<HostedEnv>) => c.get("auth").user;

  // ── Compte ──
  function usageOf(acct: Account) {
    const month = new Date().toISOString().slice(0, 7);
    const [u] = acct.db.select({ s: sum(engineUsage.costUsd) }).from(engineUsage).where(eq(engineUsage.month, month)).all();
    const [p] = acct.db.select({ n: count() }).from(projects).all();
    const [s] = acct.db.select({ n: count() }).from(studies).all();
    return { month, monthUsd: Number(u?.s ?? 0), projects: p?.n ?? 0, studies: s?.n ?? 0 };
  }

  const jobsOf = (userId: string) =>
    queue.list(userId).map((j) => ({ key: j.key, kind: j.kind, state: j.state, enqueuedAt: j.enqueuedAt, startedAt: j.startedAt ?? null, position: queue.position(j) }));

  app.get("/api/me", (c) => {
    const user = userOf(c);
    const acct = pool.get(user.id);
    const usage = usageOf(acct);
    const engine = readEngineSummary(acct.dir, defaults);
    return c.json({
      email: user.email,
      createdAt: accountCreatedAt(acct.dir),
      user,
      mode: "hosted",
      engine,
      limits: { defaultPerStudyUsd: cfg.defaultPerStudyUsd, defaultMonthlyUsd: cfg.defaultMonthlyUsd, maxMonthlyUsd: cfg.maxMonthlyUsd },
      usage: { month: usage.month, monthUsd: usage.monthUsd, ...(engine && { monthLimitUsd: engine.limits.perMonthUsd }) },
      quotas: { projects: usage.projects, maxProjects: cfg.maxProjects, studies: usage.studies, maxStudies: cfg.maxStudies },
      jobs: jobsOf(user.id),
      csrfToken: sessions.csrfOf(c),
    });
  });

  app.delete("/api/me", async (c) => {
    const user = userOf(c);
    const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== true) return c.json({ error: "Confirmation requise : { \"confirm\": true }. Toutes les données du compte seront supprimées.", code: "confirm_required" }, 400);
    // D'abord la liste des comptes supprimés (empreintes du `sub` et de l'e-mail, définitif) : plus aucune requête
    // de ce compte n'est acceptée, même avec un jeton encore valide ou un nouvel utilisateur Supabase de même adresse
    tombstones.add(user);
    const cancelled = queue.cancelUser(user.id);
    pool.purge(user.id);
    sessions.close(c);
    return c.json({ deleted: true, cancelledJobs: cancelled });
  });

  app.get("/api/me/export", (c) => {
    const user = userOf(c);
    const acct = pool.get(user.id);
    const { archive } = exportAccount(acct.db, acct.dir, user);
    const day = new Date().toISOString().slice(0, 10);
    return c.body(new Uint8Array(archive), 200, { "content-type": "application/gzip", "content-disposition": `attachment; filename="personas-export-${day}.tar.gz"` });
  });

  // ── Clé IA de l'utilisateur ──
  app.get("/api/me/engine", (c) => {
    const acct = pool.get(userOf(c).id);
    const engine = readEngineSummary(acct.dir, defaults);
    // 404 : aucune clé enregistrée (le corps garde la même forme)
    return c.json({ engine, configured: !!engine, ...(engine ?? {}), providers: HOSTED_PROVIDERS, defaults, maxMonthlyUsd: cfg.maxMonthlyUsd }, engine ? 200 : 404);
  });

  app.post("/api/me/engine", async (c) => {
    const user = userOf(c);
    const acct = pool.get(user.id);
    const parsed = engineBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Demande invalide : vérifier le fournisseur, le modèle, la clé et les plafonds.", fields: parsed.error.issues.map((i) => i.path.join(".")) }, 400);
    const body = parsed.data;
    // Plafonds à plat ({ perStudyUsd, perMonthUsd }) ou dans `limits`
    const flat = { ...(body.perStudyUsd !== undefined && { perStudyUsd: body.perStudyUsd }), ...(body.perMonthUsd !== undefined && { perMonthUsd: body.perMonthUsd }) };
    body.limits = { ...flat, ...body.limits };
    const current = readEngineSummary(acct.dir, defaults);
    const limits = {
      perStudyUsd: body.limits?.perStudyUsd ?? current?.limits.perStudyUsd ?? defaults.perStudyUsd,
      perMonthUsd: body.limits?.perMonthUsd ?? current?.limits.perMonthUsd ?? defaults.perMonthUsd,
    };
    if (limits.perMonthUsd > cfg.maxMonthlyUsd) return c.json({ error: `Plafond mensuel trop élevé : ${cfg.maxMonthlyUsd} $ au plus sur ce service.`, code: "limit_too_high", maxMonthlyUsd: cfg.maxMonthlyUsd }, 400);
    if (limits.perStudyUsd > limits.perMonthUsd) return c.json({ error: "Le plafond par étude ne peut pas dépasser le plafond mensuel.", code: "limit_invalid" }, 400);
    let key = body.apiKey;
    if (!key) {
      if (!current || current.provider !== body.provider) return c.json({ error: "Clé requise pour ce fournisseur.", code: "key_required" }, 400);
      if (current.model !== body.model) key = decryptEngineKey(acct.dir, user.id, cfg.masterKey)?.apiKey;
    }
    // Test gratuit (catalogue ou fiche du modèle, aucune génération), clé en mémoire seulement
    if (key) {
      const profile: EngineProfile = { name: HOSTED_PROFILE, provider: body.provider, model: body.model };
      let ok = false;
      let detail = "";
      try {
        const backend = createBackendFromProfile(profile, acct.ctx.config, { secrets: memoryStore({ [HOSTED_PROFILE]: key }), env: {}, warn: () => {}, ...(deps.fetch && { fetch: deps.fetch }) });
        const a = await backend.checkAvailability();
        ok = a.ok;
        detail = a.detail;
      } catch (err) {
        detail = (err as Error).message;
      }
      if (!ok) return c.json({ ok: false, error: "Test refusé par le fournisseur : rien n'a été enregistré.", detail: redactSecrets(detail, [key]) }, 400);
    }
    saveEngine(acct.dir, { userId: user.id, masterKey: cfg.masterKey, provider: body.provider, model: body.model, ...(body.apiKey && { apiKey: body.apiKey }), limits });
    const saved = readEngineSummary(acct.dir, defaults);
    return c.json({ ok: true, configured: true, engine: saved, ...saved });
  });

  app.delete("/api/me/engine", (c) => {
    const acct = pool.get(userOf(c).id);
    return c.json({ ok: true, deleted: deleteEngine(acct.dir) });
  });

  // ── Routes du tableau de bord, par compte ──
  async function delegate(c: Context<HostedEnv>, acct: Account): Promise<Response> {
    acct.inflight++;
    acct.lastUsed = Date.now();
    try {
      return await withDataScope({ dataDir: acct.dir }, () => acct.app.fetch(c.req.raw, c.env));
    } finally {
      acct.inflight--;
    }
  }

  const PROJECT_CREATE = /^\/projects(\/import)?$/;
  const STUDY_CREATE = /^\/studies$/;
  const NEXT_STUDY = /^\/studies\/[^/]+\/recommendations\/[^/]+\/create-study$/;

  // Projet de démonstration (même contrat que le premier lancement local : /api/setup/session puis /api/setup/demo)
  app.get("/api/setup/session", (c) => c.json({ token: sessions.csrfOf(c) ?? "hosted", hosted: true }));
  app.post("/api/setup/demo", async (c) => {
    const acct = pool.get(userOf(c).id);
    const body = (await c.req.json().catch(() => null)) as { lang?: unknown } | null;
    const lang = langOfRequest(c, body);
    // Sans clé, l'étude de démonstration ne pourrait pas être lancée : rien n'est créé (ni compté dans le quota)
    if (!readEngineSummary(acct.dir, defaults)) return c.json({ error: keyRequired(lang), code: "key_required" }, 409);
    if (usageOf(acct).projects >= cfg.maxProjects) return c.json({ error: `Limite de projets atteinte (${cfg.maxProjects}).`, code: "quota_projects" }, 403);
    const r = withDataScope({ dataDir: acct.dir }, () => createDemoProject(acct.ctx.db, acct.dir, lang));
    return c.json({ ok: true, ...r, n: DEMO_N });
  });

  app.all("/api/*", async (c) => {
    const path = c.req.path.slice("/api".length) || "/";
    const decision = routePolicy(c.req.method, path);
    if (decision === "disabled") return c.json({ error: "Fonction indisponible sur le service hébergé.", code: "hosted_disabled" }, 403);
    if (decision === "unknown") return c.json({ error: "Route inconnue." }, 404);
    const acct = pool.get(userOf(c).id);
    if (c.req.method === "POST") {
      const u = usageOf(acct);
      if ((PROJECT_CREATE.test(path) || NEXT_STUDY.test(path)) && u.projects >= cfg.maxProjects) return c.json({ error: `Limite de projets atteinte (${cfg.maxProjects}).`, code: "quota_projects" }, 403);
      if ((STUDY_CREATE.test(path) || NEXT_STUDY.test(path)) && u.studies >= cfg.maxStudies) return c.json({ error: `Limite d'études atteinte (${cfg.maxStudies}).`, code: "quota_studies" }, 403);
    }
    return hostedErrors(await delegate(c, acct), { hasKey: () => !!readEngineSummary(acct.dir, defaults), lang: langOfRequest(c) });
  });

  // ── Front compilé (web/dist) : application monopage ──
  const dist = deps.webDist === undefined ? null : deps.webDist;
  if (dist && existsSync(resolve(dist, "index.html"))) {
    app.use("/assets/*", serveStatic({ root: dist }));
    app.use("/favicon.svg", serveStatic({ root: dist }));
    app.get("*", (c) => {
      const html = readFileSync(resolve(dist, "index.html"), "utf8");
      c.header("content-security-policy", contentSecurityPolicy({ supabaseOrigin, scriptHashes: inlineScriptHashes(html) }));
      return c.html(html);
    });
  }

  return {
    app,
    pool,
    queue,
    close: () => {
      clearInterval(sweeper);
      queue.close();
      pool.close();
    },
  };
}
