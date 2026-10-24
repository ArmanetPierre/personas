import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Context, Hono } from "hono";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { z } from "zod";
import { PACKAGE_ROOT } from "../config";
import { createBackendFromProfile, redactSecrets } from "../engine";
import {
  builtinProfiles,
  engineConfigPath,
  isBuiltinProfile,
  loadEngineConfig,
  saveEngineConfig,
  setActiveProfile,
  upsertProfile,
  type EngineProfile,
} from "../engine/profiles";
import { defaultSecretStore, KeychainUnavailableError, memoryStore, type SecretStore } from "../engine/secrets";
import { createProject, getProject, projectFileSchema } from "../studies/project";
import type { AppContext } from "./app";
import { L, langOf, messageIn } from "./i18n";

/**
 * API locale du premier lancement (page Onboarding du tableau de bord) : moteur, clé, plafond, projet de démonstration.
 *
 * Sécurité :
 * - requêtes de la boucle locale seulement (adresse de la connexion), hôte `localhost` / `127.0.0.1` / `[::1]`
 *   (pas de rebinding DNS), jamais `Sec-Fetch-Site: cross-site` ;
 * - jeton de session tiré au démarrage du serveur, exigé dans l'en-tête `x-personas-session` (sauf pour le lire :
 *   GET /setup/session, illisible depuis une autre origine faute de CORS) ;
 * - la clé n'arrive qu'en POST (corps JSON), n'est jamais journalisée, jamais renvoyée, et n'est rangée dans le
 *   trousseau qu'après un test réussi sur un point d'accès gratuit (catalogue ou fiche du modèle : aucune génération).
 */

export const SESSION_HEADER = "x-personas-session";

export interface SetupDeps {
  /** Trousseau (défaut : celui du système ; mémoire sous vitest). */
  store?: SecretStore;
  /** Fichier des profils (défaut : ~/.personas/config.json ou PERSONAS_CONFIG). */
  configPath?: string;
  /** fetch du test de clé (tests : faux serveur). */
  fetch?: typeof fetch;
  /** Détection de la CLI `claude` (défaut : `claude --version`). */
  detectClaude?: () => Promise<ClaudeDetection>;
  /** Racine des exemples livrés (défaut : racine du paquet). */
  examplesRoot?: string;
}

export interface ClaudeDetection {
  detected: boolean;
  version?: string;
}

/** Fournisseurs à clé proposés à l'écran de premier lancement. */
export const API_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter"] as const;
type ApiProvider = (typeof API_PROVIDERS)[number];

/** Projet de démonstration selon la langue (fichiers livrés dans le paquet), effectif réduit. */
export const DEMO_PROJECTS: Record<"fr" | "en", string> = { en: "examples/sg/recipe-app.yaml", fr: "examples/meal-planner.json" };
export const DEMO_N = 20;
/** Plafond proposé par défaut (USD par étude). */
export const DEFAULT_PER_STUDY_USD = 5;

const keySchema = z
  .string()
  .trim()
  .min(8)
  .max(512)
  .regex(/^\S+$/);

const engineBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("claude-cli"), acknowledgePersonalUse: z.literal(true) }),
  z.strictObject({ kind: z.literal("api"), provider: z.enum(API_PROVIDERS), model: z.string().trim().min(1).max(200), key: keySchema }),
  z.strictObject({
    kind: z.literal("local"),
    server: z.enum(["ollama", "vllm"]),
    baseUrl: z.url({ protocol: /^https?$/ }),
    model: z.string().trim().min(1).max(200),
    key: keySchema.optional(),
  }),
]);

const limitsBody = z.strictObject({ profile: z.string().min(1), perStudyUsd: z.number().positive().max(10_000) });
const demoBody = z.strictObject({ lang: z.enum(["fr", "en"]) });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Adresse de la boucle locale (IPv4 127/8, IPv6 ::1, IPv4 projetée). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, "");
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function remoteAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Détection de la CLI `claude` : `claude --version` (aucune génération). */
export function claudeDetector(ctx: Pick<AppContext, "config">): () => Promise<ClaudeDetection> {
  let cached: Promise<ClaudeDetection> | undefined;
  return () =>
    (cached ??= (async () => {
      const profile = builtinProfiles(ctx.config).find((p) => p.name === "claude-cli")!;
      const a = await createBackendFromProfile(profile, ctx.config).checkAvailability();
      return a.ok ? { detected: true, version: a.detail.replace(/^CLI\s+/, "") } : { detected: false };
    })().catch(() => ({ detected: false })));
}

export function registerSetupRoutes(api: Hono, ctx: AppContext & { dataDir: string; sessionToken: string }): void {
  const deps = ctx.setup ?? {};
  const store = deps.store ?? defaultSecretStore();
  const configPath = deps.configPath ?? engineConfigPath();
  const detectClaude = deps.detectClaude ?? claudeDetector(ctx);
  const examplesRoot = deps.examplesRoot ?? PACKAGE_ROOT;
  const { db, config } = ctx;

  // Garde : boucle locale, hôte local, pas de requête inter-sites ; jeton sauf pour le lire
  api.use("/setup/*", async (c, next) => {
    const lang = langOf(c);
    const host = new URL(c.req.url).hostname;
    if (!isLoopbackAddress(remoteAddress(c)) || !LOOPBACK_HOSTS.has(host) || c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: L(lang, "Configuration refusée : réservée au navigateur de cette machine (127.0.0.1).", "Setup refused: only allowed from this machine's browser (127.0.0.1).") }, 403);
    }
    if (!(c.req.method === "GET" && c.req.path.endsWith("/setup/session")) && !sameToken(c.req.header(SESSION_HEADER), ctx.sessionToken)) {
      return c.json({ error: L(lang, "Jeton de session absent ou invalide : recharger la page.", "Missing or invalid session token: reload the page.") }, 401);
    }
    c.header("cache-control", "no-store");
    await next();
  });

  api.get("/setup/session", (c) => c.json({ token: ctx.sessionToken }));

  api.get("/setup/status", async (c) => {
    const file = loadEngineConfig(configPath);
    const claude = await detectClaude();
    const configured = file.profiles.length > 0 || file.activeProfile !== undefined;
    const active = file.activeProfile ?? "claude-cli";
    return c.json({
      claudeCli: claude,
      activeProfile: active,
      configured,
      needsOnboarding: !configured && !claude.detected,
      profiles: file.profiles.map((p) => ({ name: p.name, provider: p.provider, model: p.model, ...(p.baseUrl && { baseUrl: p.baseUrl }), perStudyUsd: p.limits?.perStudyUsd ?? null })),
      defaultPerStudyUsd: DEFAULT_PER_STUDY_USD,
      dataDir: ctx.dataDir,
    });
  });

  api.post("/setup/engine", async (c) => {
    const lang = langOf(c);
    const parsed = engineBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: L(lang, "Demande invalide : vérifier le fournisseur, le modèle, l'URL et la clé.", "Invalid request: check the provider, model, URL and key."), fields: parsed.error.issues.map((i) => i.path.join(".")) }, 400);
    }
    const body = parsed.data;
    let file = loadEngineConfig(configPath);

    if (body.kind === "claude-cli") {
      const claude = await detectClaude();
      if (!claude.detected) return c.json({ error: L(lang, "CLI claude introuvable : installer Claude Code puis se connecter (claude, puis /login).", "claude CLI not found: install Claude Code, then log in (claude, then /login).") }, 400);
      saveEngineConfig(setActiveProfile(file, "claude-cli", config), configPath);
      return c.json({ ok: true, profile: "claude-cli", provider: "claude-cli", billed: false, detail: claude.version ?? "" });
    }

    const name = body.kind === "api" ? body.provider : "local";
    const previous = file.profiles.find((p) => p.name === name);
    const profile: EngineProfile = {
      name,
      provider: body.kind === "api" ? (body.provider satisfies ApiProvider) : body.server === "ollama" ? "ollama" : "openai-compatible",
      model: body.model,
      ...(body.kind === "local" && { baseUrl: body.baseUrl.replace(/\/+$/, "") }),
      ...(previous?.limits && { limits: previous.limits }),
    };
    const key = body.key;
    // Test sur un point d'accès gratuit, avec la clé en mémoire seulement (rien n'est rangé avant le succès)
    const backend = createBackendFromProfile(profile, config, {
      secrets: memoryStore(key ? { [name]: key } : {}),
      env: {},
      warn: () => {},
      ...(deps.fetch && { fetch: deps.fetch }),
    });
    let a: Awaited<ReturnType<typeof backend.checkAvailability>>;
    try {
      a = await backend.checkAvailability();
    } catch (err) {
      a = { ok: false, detail: (err as Error).message };
    }
    const detail = messageIn(lang, redactSecrets(a.detail, [key]));
    if (!a.ok) return c.json({ ok: false, error: L(lang, "Test refusé par le fournisseur : rien n'a été enregistré.", "The provider rejected the test: nothing was saved."), detail }, 400);
    try {
      if (key) await store.set(name, key);
    } catch (err) {
      const msg = err instanceof KeychainUnavailableError ? err.message : String((err as Error).message ?? err);
      return c.json({ ok: false, error: L(lang, "Trousseau du système indisponible : la clé n'a pas été enregistrée.", "System keychain unavailable: the key was not saved."), detail: redactSecrets(msg, [key]) }, 503);
    }
    file = upsertProfile(file, profile);
    saveEngineConfig(setActiveProfile(file, name, config), configPath);
    return c.json({ ok: true, profile: name, provider: profile.provider, billed: body.kind === "api", detail });
  });

  api.post("/setup/limits", async (c) => {
    const lang = langOf(c);
    const parsed = limitsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: L(lang, "Plafond invalide : un montant positif en dollars.", "Invalid cap: a positive amount in dollars.") }, 400);
    const { profile: name, perStudyUsd } = parsed.data;
    if (isBuiltinProfile(name)) return c.json({ error: L(lang, `Le profil ${name} n'est pas facturé : pas de plafond à régler.`, `Profile ${name} is not billed: no cap to set.`) }, 400);
    const file = loadEngineConfig(configPath);
    const p = file.profiles.find((x) => x.name === name);
    if (!p) return c.json({ error: L(lang, `Profil introuvable : ${name}`, `Profile not found: ${name}`) }, 404);
    saveEngineConfig(upsertProfile(file, { ...p, limits: { ...p.limits, perStudyUsd } }), configPath);
    return c.json({ ok: true, profile: name, perStudyUsd });
  });

  api.post("/setup/demo", async (c) => {
    const lang = langOf(c);
    const parsed = demoBody.safeParse(await c.req.json().catch(() => ({ lang })));
    const demoLang = parsed.success ? parsed.data.lang : lang;
    const src = resolve(examplesRoot, DEMO_PROJECTS[demoLang]);
    if (!existsSync(src)) return c.json({ error: L(lang, `Exemple introuvable : ${DEMO_PROJECTS[demoLang]}`, `Example not found: ${DEMO_PROJECTS[demoLang]}`) }, 404);
    // Copie dans le dossier de données : le tableau de bord peut la modifier sans toucher au paquet installé
    const dest = join(ctx.dataDir, "projects", basename(src));
    let created = false;
    if (!existsSync(dest)) {
      mkdirSync(join(ctx.dataDir, "projects"), { recursive: true });
      writeFileSync(dest, demoCopy(src));
      created = true;
    }
    const text = readFileSync(dest, "utf8");
    const file = projectFileSchema.parse(/\.ya?ml$/i.test(dest) ? parseYaml(text) : JSON.parse(text));
    const existing = file.id ? getProject(db, file.id) : undefined;
    const project = existing && !created ? existing : createProject(db, file, { sourceFile: dest, update: Boolean(existing) });
    return c.json({ ok: true, projectId: project.id, created, n: DEMO_N });
  });
}

/** Contenu de la copie de démonstration : même projet, cible ramenée à `DEMO_N` personas (témoin retiré). */
export function demoCopy(src: string): string {
  const yaml = /\.ya?ml$/i.test(src);
  const raw = readFileSync(src, "utf8");
  const obj = (yaml ? parseYaml(raw) : JSON.parse(raw)) as Record<string, unknown>;
  const target = (obj.target as Record<string, unknown> | undefined) ?? { socle: "fr", eligibility: "age >= 25 and age <= 50" };
  const next: Record<string, unknown> = { ...obj, target: { ...target, n: DEMO_N } };
  delete next.control;
  projectFileSchema.parse(next);
  return yaml ? `# Copie de démonstration (${basename(src)}), ${DEMO_N} personas.\n${toYaml(next, { lineWidth: 110 })}` : `${JSON.stringify(next, null, 2)}\n`;
}
