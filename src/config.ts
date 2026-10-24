import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

/** Plafond dur de concurrence pour Ollama : le serveur peut être partagé avec d'autres services. */
export const OLLAMA_MAX_CONCURRENCY = 2;

let envLoaded = false;

/**
 * Fusionne les variables d'un `.env` dans `env` sans écraser celles déjà définies par l'environnement du
 * processus. Précédence de la base (du plus fort au plus faible) :
 *   1. portée de données du service hébergé (`withDataScope`) ;
 *   2. `DATABASE_PATH` de l'environnement du processus ;
 *   3. `PERSONAS_DATA_DIR` de l'environnement du processus → `<dossier>/personas.db` ;
 *   4. `DATABASE_PATH` du `.env` ;
 *   5. `PERSONAS_DATA_DIR` du `.env` ;
 *   6. défaut : `./data/personas.db` dans le dépôt, dossier de l'utilisateur une fois installé.
 * Le point 3 avant le point 4 est assuré ici : un `DATABASE_PATH` venu du `.env` est ignoré quand
 * `PERSONAS_DATA_DIR` est déjà dans l'environnement (tests V1, C14 B2). Les processus enfants héritent alors
 * de `PERSONAS_DATA_DIR` seul et visent la même base. Renvoie les clés ajoutées.
 */
export function mergeDotEnv(env: NodeJS.ProcessEnv, fileVars: Record<string, string>): string[] {
  const has = (k: string) => env[k] !== undefined && env[k] !== "";
  const explicitDataDir = has("PERSONAS_DATA_DIR") && !has("DATABASE_PATH");
  const added: string[] = [];
  for (const [k, v] of Object.entries(fileVars)) {
    if (env[k] !== undefined) continue;
    if (k === "DATABASE_PATH" && explicitDataDir) continue;
    env[k] = v;
    added.push(k);
  }
  return added;
}

/** Charge `.env` s'il existe (sans écraser les variables déjà définies ; précédence : `mergeDotEnv`). */
export function loadDotEnv(path = ".env"): void {
  if (envLoaded) return;
  // Service hébergé : la configuration vient de l'environnement du conteneur, jamais d'un fichier `.env`
  // (un `.env` posé dans le dossier courant d'un compte ou du code n'ajoute aucune variable).
  if (process.env.PERSONAS_MODE?.trim().toLowerCase() === "hosted") return;
  envLoaded = true;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // Pas de .env : on garde les valeurs par défaut.
  }
  mergeDotEnv(process.env, parseEnv(text) as Record<string, string>);
}

// ─── Mode d'exécution et dossier de données ──────────────────────────────────

/** Racine du paquet : le dépôt (src/config.ts) ou le paquet installé (dist/config.js), au même niveau. */
export const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

/** Vrai quand ce code tourne compilé en JavaScript (dist/) : les enfants lancés sont alors des .js, sans tsx. */
export const IS_COMPILED = import.meta.filename.endsWith(".js");

/**
 * Spécificateur d'un import dynamique relatif (écrit sans extension dans les sources) : `.js` une fois
 * compilé, inchangé sous tsx et vitest.
 */
export const moduleSpec = (spec: string): string => (IS_COMPILED ? `${spec}.js` : spec);

export type RunMode = "repo" | "installed" | "hosted";

/**
 * Mode d'exécution :
 * - `repo` (développement) : le code tourne depuis un dépôt cloné (dossier `.git` à la racine) ou depuis les
 *   sources TypeScript. Les données restent dans `./data` (comportement historique) ;
 * - `installed` : paquet installé par `npm i -g` (code compilé, sans `.git`). Les données vont dans le dossier
 *   de l'utilisateur (`userDataDir`).
 * - `hosted` : service web hébergé (src/hosted/), seulement par `PERSONAS_MODE=hosted` : un dossier de données
 *   par compte (`PERSONAS_DATA_DIR` dans les processus enfants, portée de requête dans le serveur).
 * `PERSONAS_MODE=repo|installed|hosted` l'impose.
 */
export function runMode(env: NodeJS.ProcessEnv = process.env, opts: { root?: string; compiled?: boolean } = {}): RunMode {
  const forced = env.PERSONAS_MODE?.trim().toLowerCase();
  if (forced === "repo" || forced === "installed" || forced === "hosted") return forced;
  const compiled = opts.compiled ?? IS_COMPILED;
  return !compiled || existsSync(join(opts.root ?? PACKAGE_ROOT, ".git")) ? "repo" : "installed";
}

/**
 * Dossier de données par utilisateur (paquet installé) ; `PERSONAS_DATA_DIR` l'impose.
 * - macOS : ~/Library/Application Support/Personas
 * - Windows : %APPDATA%\Personas
 * - Linux et autres : $XDG_DATA_HOME/personas (défaut ~/.local/share/personas)
 */
export function userDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.PERSONAS_DATA_DIR?.trim()) return resolve(env.PERSONAS_DATA_DIR.trim());
  if (platform === "darwin") return join(home, "Library", "Application Support", "Personas");
  if (platform === "win32") return join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "Personas");
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "personas");
}

// ─── Portée de données (service hébergé) ─────────────────────────────────────

/**
 * Portée d'une requête du service hébergé : le dossier du compte. Pendant `withDataScope`, `loadConfig()` (sur
 * `process.env`) renvoie la base du compte, et les chemins dérivés (cache du Hub, réglages, profils de moteur,
 * suggestions, recommandations) pointent dans ce dossier. Hors portée (dépôt, paquet installé) : rien ne change.
 */
export interface DataScope {
  /** Dossier de données du compte (absolu). */
  dataDir: string;
}

const dataScope = new AsyncLocalStorage<DataScope>();

export function withDataScope<T>(scope: DataScope, fn: () => T): T {
  return dataScope.run({ dataDir: resolve(scope.dataDir) }, fn);
}

export function currentDataScope(): DataScope | undefined {
  return dataScope.getStore();
}

/** Base par défaut : `./data/personas.db` dans le dépôt (sauf `PERSONAS_DATA_DIR`), sinon dans le dossier de l'utilisateur. */
export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env, mode: RunMode = runMode(env)): string {
  if (mode === "repo" && !env.PERSONAS_DATA_DIR?.trim()) return "./data/personas.db";
  return join(userDataDir(env), "personas.db");
}

const intFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const configSchema = z.object({
  DATABASE_PATH: z.string().min(1).default("./data/personas.db"),
  CLAUDE_CLI_PATH: z.string().min(1).default("claude"),
  CLAUDE_CLI_MODEL: z.string().min(1).default("sonnet"),
  CLAUDE_CLI_CONCURRENCY: intFromEnv(2),
  CLAUDE_CLI_TIMEOUT_MS: intFromEnv(300_000),
  OLLAMA_BASE_URL: z.url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen3:8b"),
  OLLAMA_NUM_CTX: intFromEnv(32_768),
  OLLAMA_CONCURRENCY: intFromEnv(OLLAMA_MAX_CONCURRENCY),
  OLLAMA_TIMEOUT_MS: intFromEnv(600_000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { mode?: RunMode } = {}): AppConfig {
  const raw: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const scope = env === process.env ? currentDataScope() : undefined;
  if (scope) raw.DATABASE_PATH = join(scope.dataDir, "personas.db");
  raw.DATABASE_PATH ??= defaultDatabasePath(env, opts.mode ?? runMode(env));
  return configSchema.parse(raw);
}

/**
 * Dossier de données courant : celui de la base (`./data` dans le dépôt, le dossier de l'utilisateur une fois
 * installé, le dossier du compte en mode hébergé). Les fichiers produits par les tâches (recommandations,
 * recodages, suggestions) y vont, là où l'API les relit.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(resolve(loadConfig(env).DATABASE_PATH));
}
