import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { currentDataScope, runMode, type AppConfig } from "../config";
import { checkKeyEnvName } from "./secrets";
import type { ProviderKind } from "./types";

/**
 * Profils de moteur (docs/plateforme.md § 7.1, 7.5) : fournisseur, modèle, URL, concurrence, plafonds.
 *
 * - Fichier `~/.personas/config.json` (chemin imposé par `PERSONAS_CONFIG` ; sous vitest, un dossier
 *   temporaire). Il ne contient JAMAIS de clé : elles sont dans le trousseau (src/engine/secrets.ts),
 *   et un champ de clé en clair fait refuser le fichier.
 * - Deux profils intégrés, tirés de l'environnement (`CLAUDE_CLI_*`, `OLLAMA_*`, src/config.ts) :
 *   `claude-cli` (défaut) et `ollama`. Sans fichier ni `PERSONAS_PROFILE`, le comportement est celui
 *   d'avant les profils.
 * - Profil actif : `--profile`, sinon `PERSONAS_PROFILE`, sinon `activeProfile` du fichier, sinon `claude-cli`.
 */

export const PROVIDER_KINDS = ["claude-cli", "anthropic", "openai", "openrouter", "gemini", "openai-compatible", "ollama"] as const satisfies readonly ProviderKind[];

/** Profils tirés de l'environnement ; leurs noms sont réservés. */
export const BUILTIN_PROFILE_NAMES = ["claude-cli", "ollama"] as const;
export const DEFAULT_PROFILE = "claude-cli";

export const limitsSchema = z.strictObject({
  /** Plafond de dépense par étude, en USD (appliqué au lot B : BudgetGuard). */
  perStudyUsd: z.number().positive().optional(),
  perDayUsd: z.number().positive().optional(),
  perMonthUsd: z.number().positive().optional(),
});

export const profileSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "minuscules, chiffres, - et _ (40 caractères au plus)"),
  provider: z.enum(PROVIDER_KINDS),
  model: z.string().min(1),
  baseUrl: z.url().optional(),
  concurrency: z.int().min(1).max(64).optional(),
  timeoutMs: z.int().positive().optional(),
  /** Repli sans trousseau : NOM de la variable d'environnement qui porte la clé (jamais la clé). */
  keyEnv: z
    .string()
    .refine((v) => checkKeyEnvName(v) === null, { error: (iss) => checkKeyEnvName(String(iss.input)) ?? "variable refusée" })
    .optional(),
  /** Plafonds de dépense : champ prévu, appliqué au lot B. */
  limits: limitsSchema.optional(),
});

export type EngineProfile = z.infer<typeof profileSchema>;

export const engineConfigSchema = z.strictObject({
  version: z.literal(1),
  activeProfile: z.string().optional(),
  profiles: z.array(profileSchema),
});

export type EngineConfigFile = z.infer<typeof engineConfigSchema>;

// ─── Service hébergé : fournisseurs admis ────────────────────────────────────

/**
 * Service hébergé (docs/plateforme.md § 13, phase 4) : seuls les fournisseurs à clé de l'utilisateur. `claude-cli`
 * (abonnement personnel), `ollama` (serveur local) et `openai-compatible` (URL arbitraire) sont refusés, comme
 * toute URL de base imposée par un profil.
 */
export const HOSTED_PROVIDERS = ["anthropic", "openai", "gemini", "openrouter"] as const satisfies readonly ProviderKind[];
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number];
/** Fichier de profils d'un compte hébergé (dans son dossier de données ; jamais de clé). */
export const HOSTED_ENGINE_FILE = "engine.json";
/** Nom du profil unique d'un compte hébergé. */
export const HOSTED_PROFILE = "user";

export class HostedProviderError extends Error {
  override name = "HostedProviderError";
}

/** Lève `HostedProviderError` si ce profil n'est pas admis en mode hébergé (sans effet ailleurs). */
export function assertProviderAllowed(profile: Pick<EngineProfile, "provider" | "baseUrl">, env: NodeJS.ProcessEnv = process.env): void {
  if (runMode(env) !== "hosted") return;
  if (!(HOSTED_PROVIDERS as readonly string[]).includes(profile.provider)) {
    throw new HostedProviderError(
      `Moteur ${profile.provider} refusé sur le service hébergé : seuls Anthropic, OpenAI, Gemini et OpenRouter, avec votre clé (page « Ma clé IA »).`,
    );
  }
  if (profile.baseUrl) throw new HostedProviderError("URL de fournisseur personnalisée refusée sur le service hébergé.");
}

export class PlaintextSecretError extends Error {
  override name = "PlaintextSecretError";
}

export class ProfileError extends Error {
  override name = "ProfileError";
}

/** Chemin du fichier de profils. */
export function engineConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  // Service hébergé, dans une requête : le fichier de profils du compte (jamais celui du serveur)
  const scope = env === process.env ? currentDataScope() : undefined;
  if (scope) return join(scope.dataDir, HOSTED_ENGINE_FILE);
  if (env.PERSONAS_CONFIG) return env.PERSONAS_CONFIG;
  // Sous vitest : jamais le fichier réel de l'utilisateur
  if (env.VITEST) return join(tmpdir(), `personas-test-${process.pid}`, "config.json");
  return join(homedir(), ".personas", "config.json");
}

const SECRET_FIELD = /^(api[_-]?key|apikey|key|secret|token|password|access[_-]?token|auth(orization)?)$/i;

/** Refuse tout champ qui ressemble à une clé en clair, à n'importe quelle profondeur. */
function rejectPlaintextSecrets(value: unknown, path: string, file: string): void {
  if (Array.isArray(value)) return value.forEach((v, i) => rejectPlaintextSecrets(v, `${path.replace(/\.$/, "")}[${i}].`, file));
  if (typeof value !== "object" || value === null) return;
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELD.test(k)) {
      throw new PlaintextSecretError(
        `${file} : champ « ${path}${k} » refusé, le stockage d'une clé en clair est interdit. ` +
          "Retirer le champ, puis ranger la clé dans le trousseau : npm run engine:key -- set --profile <nom>.",
      );
    }
    rejectPlaintextSecrets(v, `${path}${k}.`, file);
  }
}

export function emptyEngineConfig(): EngineConfigFile {
  return { version: 1, profiles: [] };
}

/** Lit le fichier de profils (vide s'il n'existe pas). */
export function loadEngineConfig(path = engineConfigPath()): EngineConfigFile {
  if (!existsSync(path)) return emptyEngineConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ProfileError(`${path} : JSON illisible (${(err as Error).message})`);
  }
  rejectPlaintextSecrets(raw, "", path);
  const parsed = engineConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ");
    throw new ProfileError(`${path} : configuration invalide (${issues})`);
  }
  const names = parsed.data.profiles.map((p) => p.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new ProfileError(`${path} : profil en double (${dup})`);
  const reserved = names.find((n) => (BUILTIN_PROFILE_NAMES as readonly string[]).includes(n));
  if (reserved) throw new ProfileError(`${path} : le nom ${reserved} est réservé au profil intégré`);
  return parsed.data;
}

/** Écrit le fichier (dossier 0700, fichier 0600, écriture atomique). */
export function saveEngineConfig(cfg: EngineConfigFile, path = engineConfigPath()): void {
  const valid = engineConfigSchema.parse(cfg);
  rejectPlaintextSecrets(valid, "", path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // système de fichiers sans droits POSIX
  }
}

/** Profils intégrés, tirés de l'environnement : exactement les réglages d'avant les profils. */
export function builtinProfiles(config: AppConfig): EngineProfile[] {
  return [
    {
      name: "claude-cli",
      provider: "claude-cli",
      model: config.CLAUDE_CLI_MODEL,
      concurrency: config.CLAUDE_CLI_CONCURRENCY,
      timeoutMs: config.CLAUDE_CLI_TIMEOUT_MS,
    },
    {
      name: "ollama",
      provider: "ollama",
      model: config.OLLAMA_MODEL,
      baseUrl: config.OLLAMA_BASE_URL,
      concurrency: config.OLLAMA_CONCURRENCY,
      timeoutMs: config.OLLAMA_TIMEOUT_MS,
    },
  ];
}

export const isBuiltinProfile = (name: string): boolean => (BUILTIN_PROFILE_NAMES as readonly string[]).includes(name);

/** Tous les profils : intégrés puis ceux du fichier. */
export function listProfiles(config: AppConfig, file: EngineConfigFile = loadEngineConfig()): EngineProfile[] {
  return [...builtinProfiles(config), ...file.profiles];
}

/** Nom du profil actif : option, puis `PERSONAS_PROFILE`, puis le fichier, puis `claude-cli`. */
export function activeProfileName(opts: { flag?: string | undefined; env?: NodeJS.ProcessEnv; file?: EngineConfigFile } = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env.PERSONAS_PROFILE?.trim();
  if (opts.flag) return opts.flag;
  if (fromEnv) return fromEnv;
  const file = opts.file ?? loadEngineConfig(engineConfigPath(env));
  return file.activeProfile ?? DEFAULT_PROFILE;
}

export function findProfile(name: string, config: AppConfig, file: EngineConfigFile = loadEngineConfig()): EngineProfile {
  const p = listProfiles(config, file).find((x) => x.name === name);
  if (!p) {
    const known = listProfiles(config, file).map((x) => x.name).join(", ");
    throw new ProfileError(`Profil inconnu : ${name} (profils : ${known}). Créer : npm run engine:profile -- add --name ${name} --provider <fournisseur> --model <modèle>`);
  }
  return p;
}

/** Profil actif résolu (voir `activeProfileName`). */
export function resolveProfile(
  config: AppConfig,
  opts: { flag?: string | undefined; env?: NodeJS.ProcessEnv; path?: string } = {},
): EngineProfile {
  const env = opts.env ?? process.env;
  const file = loadEngineConfig(opts.path ?? engineConfigPath(env));
  return findProfile(activeProfileName({ ...(opts.flag && { flag: opts.flag }), env, file }), config, file);
}

/** Ajoute ou remplace un profil du fichier ; renvoie le fichier mis à jour (non écrit). */
export function upsertProfile(file: EngineConfigFile, profile: EngineProfile): EngineConfigFile {
  if (isBuiltinProfile(profile.name)) throw new ProfileError(`Le nom ${profile.name} est réservé au profil intégré (réglé par l'environnement).`);
  const parsed = profileSchema.safeParse(profile);
  if (!parsed.success) {
    throw new ProfileError(`Profil ${profile.name} invalide : ${parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ")}`);
  }
  const valid = parsed.data;
  if (valid.provider === "openai-compatible" && !valid.baseUrl) {
    throw new ProfileError("Un profil openai-compatible exige une URL de base (--base-url), par ex. http://localhost:8000/v1.");
  }
  const profiles = file.profiles.filter((p) => p.name !== valid.name);
  return { ...file, profiles: [...profiles, valid] };
}

export function removeProfileFrom(file: EngineConfigFile, name: string): EngineConfigFile {
  if (isBuiltinProfile(name)) throw new ProfileError(`Le profil intégré ${name} ne se supprime pas.`);
  if (!file.profiles.some((p) => p.name === name)) throw new ProfileError(`Profil inconnu : ${name}`);
  const { activeProfile, ...rest } = file;
  return { ...rest, ...(activeProfile && activeProfile !== name && { activeProfile }), profiles: file.profiles.filter((p) => p.name !== name) };
}

export function setActiveProfile(file: EngineConfigFile, name: string, config: AppConfig): EngineConfigFile {
  findProfile(name, config, file);
  const { activeProfile: _old, ...rest } = file;
  return name === DEFAULT_PROFILE ? rest : { ...rest, activeProfile: name };
}
