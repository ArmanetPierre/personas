import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT, type AppConfig } from "../config";
import { openDb, runMigrations, type Db } from "../db/client";
import type { Study, StudyEngineInfo } from "../db/schema";
import { cliCommand } from "../hints";
import { BudgetGuard, dbUsageStore, effectiveLimits, type BudgetLimits, type UsageStore } from "./budget";
import { Engine } from "./engine";
import { createBackendFromProfile, getEngine, type BackendDeps } from "./index";
import { isPaidProvider, pricingFor, type Pricing } from "./pricing";
import { assertProviderAllowed, builtinProfiles, findProfile, isBuiltinProfile, loadEngineConfig, engineConfigPath, resolveProfile, type EngineProfile } from "./profiles";

/**
 * Choix du moteur d'une étude, d'un récit ou d'un assistant (docs/plateforme.md § 7.1, 7.3, 7.4).
 *
 * - Sans profil configuré (ni `--profile`, ni `PERSONAS_PROFILE`, ni fichier), le profil actif est le profil
 *   intégré `claude-cli` : comportement strictement identique à celui d'avant les profils.
 * - `--backend claude-cli|ollama` garde son sens historique (profil intégré, réglé par l'environnement).
 * - `anthropic-api` reste refusé ; le fournisseur `anthropic` n'existe que par un profil avec une clé.
 */

let versionCache: string | null = null;
/** Version de Personas (package.json). */
export function personasVersion(): string {
  if (versionCache) return versionCache;
  try {
    versionCache = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    versionCache = "0.0.0";
  }
  return versionCache;
}

export const ANTHROPIC_API_REFUSED =
  "Backend anthropic-api refusé (API payante). Le fournisseur anthropic n'est utilisable que par un profil de moteur avec la clé de l'utilisateur dans le trousseau : " +
  `${cliCommand("engine:profile", "add --name <nom> --provider anthropic --model <modèle>")}, puis ${cliCommand("engine:key", "set --profile <nom>")}.`;

export interface ChooseOptions {
  /** `--profile` (prioritaire sur `PERSONAS_PROFILE` et le fichier). */
  profile?: string | undefined;
  /** `--backend` historique : claude-cli ou ollama (profils intégrés). */
  backend?: string | undefined;
  /** Modèle imposé (sinon celui du profil). */
  model?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Fichier de profils (tests). */
  path?: string;
}

/** Profil retenu pour créer une étude ou lancer un assistant. */
export function chooseProfile(config: AppConfig, opts: ChooseOptions = {}): EngineProfile {
  const env = opts.env ?? process.env;
  let profile: EngineProfile;
  if (opts.backend && !opts.profile) {
    if (opts.backend === "anthropic-api") throw new Error(ANTHROPIC_API_REFUSED);
    if (opts.backend !== "claude-cli" && opts.backend !== "ollama") {
      throw new Error(`Backend ${opts.backend} : seuls claude-cli et ollama se choisissent par --backend ; les autres fournisseurs passent par un profil (--profile <nom>).`);
    }
    profile = builtinProfiles(config).find((p) => p.name === opts.backend)!;
  } else {
    profile = resolveProfile(config, { ...(opts.profile && { flag: opts.profile }), env, ...(opts.path && { path: opts.path }) });
  }
  assertProviderAllowed(profile);
  return opts.model ? { ...profile, model: opts.model } : profile;
}

/**
 * Moteur figé dans `studies.extra.engine` à la création. `acceptUnknownCost` : l'utilisateur a accepté le coût
 * inconnu du modèle pour cette étude (`--accept-unknown-cost`) ; le plafond compte alors au prix prudent.
 */
export type StudyEngineRecord = StudyEngineInfo & { acceptUnknownCost?: boolean };

export function engineInfoOf(profile: EngineProfile, extra: Partial<StudyEngineRecord> = {}): StudyEngineRecord {
  return { provider: profile.provider, model: profile.model, profile: profile.name, personasVersion: personasVersion(), ...extra };
}

/** Moteur enregistré dans une étude (absent pour les études antérieures aux profils). */
export function studyEngineInfo(study: Pick<Study, "extra">): StudyEngineRecord | null {
  const e = (study.extra as { engine?: StudyEngineRecord } | null | undefined)?.engine;
  return e && typeof e === "object" ? e : null;
}

/** Coût inconnu accepté à la création de l'étude. */
export function studyAcceptsUnknownCost(study: Pick<Study, "extra">): boolean {
  return studyEngineInfo(study)?.acceptUnknownCost === true;
}

/**
 * Profil qui exécute une étude existante : `--profile` s'il est donné (même fournisseur exigé), sinon celui
 * enregistré à la création, sinon le profil intégré du backend (études antérieures). Modèle : celui de l'étude.
 */
export function profileForStudy(study: Pick<Study, "id" | "backend" | "model" | "extra">, config: AppConfig, opts: { profile?: string | undefined; env?: NodeJS.ProcessEnv; path?: string } = {}): EngineProfile {
  if (study.backend === "anthropic-api") throw new Error(ANTHROPIC_API_REFUSED);
  const env = opts.env ?? process.env;
  const file = loadEngineConfig(opts.path ?? engineConfigPath(env));
  const recorded = studyEngineInfo(study)?.profile;
  const name = opts.profile ?? recorded ?? (study.backend === "claude-cli" || study.backend === "ollama" ? study.backend : null);
  if (!name) throw new Error(`L'étude ${study.id} a été créée pour ${study.backend} sans profil enregistré : relancer avec --profile <nom> (un profil de ce fournisseur).`);
  let profile: EngineProfile;
  try {
    profile = findProfile(name, config, file);
  } catch (err) {
    if (recorded && !opts.profile) throw new Error(`Le profil ${recorded} de l'étude ${study.id} n'existe plus : relancer avec --profile <nom> (un profil ${study.backend}). ${(err as Error).message}`);
    throw err;
  }
  if (profile.provider !== study.backend) {
    throw new Error(`Le profil ${profile.name} (${profile.provider}) ne correspond pas au fournisseur de l'étude ${study.id} (${study.backend}).`);
  }
  assertProviderAllowed(profile);
  return { ...profile, model: study.model };
}

/**
 * Profil des récits : celui de l'étude s'il vient du fichier de profils ; sinon le profil actif
 * (`--profile`, `PERSONAS_PROFILE`, fichier), puis claude-cli, comme avant les profils.
 */
export function narrativeProfile(config: AppConfig, opts: { studyProfile?: EngineProfile; flag?: string | undefined; env?: NodeJS.ProcessEnv } = {}): EngineProfile {
  if (opts.studyProfile && !isBuiltinProfile(opts.studyProfile.name)) return opts.studyProfile;
  return resolveProfile(config, { ...(opts.flag && { flag: opts.flag }), ...(opts.env && { env: opts.env }) });
}

const profileEngines = new Map<string, Engine>();

/**
 * Moteur d'un profil (sans plafond). Profils intégrés au modèle de l'environnement : le moteur partagé de
 * `getEngine` (même limiteur). Autres : un moteur par profil et par modèle, partagé dans le processus.
 */
export function engineForProfile(profile: EngineProfile, config: AppConfig, deps?: BackendDeps): Engine {
  const builtin = isBuiltinProfile(profile.name) ? builtinProfiles(config).find((p) => p.name === profile.name) : undefined;
  if (builtin && builtin.model === profile.model && builtin.provider === profile.provider) return getEngine(builtin.provider, config);
  const key = `${profile.name}|${profile.provider}|${profile.model}|${profile.baseUrl ?? ""}`;
  let engine = profileEngines.get(key);
  if (!engine) {
    engine = new Engine(createBackendFromProfile(profile, config, deps));
    profileEngines.set(key, engine);
  }
  return engine;
}

/** Tarification et plafonds d'un profil. */
export function profileBudget(profile: EngineProfile): { pricing: Pricing; limits: BudgetLimits; paid: boolean } {
  const paid = isPaidProvider(profile.provider, profile.baseUrl);
  return { pricing: pricingFor(profile.provider, profile.model, { baseUrl: profile.baseUrl }), limits: effectiveLimits(profile.limits, paid), paid };
}

/**
 * Moteur avec plafond de dépense, imputé à une étude (ou à aucune : assistants, récits hors étude).
 * L'usage est cumulé dans `engine_usage`.
 */
export function guardedEngine(
  db: Db | null,
  profile: EngineProfile,
  config: AppConfig,
  opts: { studyId?: string | null; deps?: BackendDeps; store?: UsageStore; base?: Engine; acceptUnknownCost?: boolean } = {},
): Engine {
  const base = opts.base ?? engineForProfile(profile, config, opts.deps);
  const store = opts.store ?? (db ? dbUsageStore(db) : null);
  if (!store) return base;
  const { pricing, limits } = profileBudget(profile);
  return base.withBudget(new BudgetGuard({ store, profile: profile.name, provider: profile.provider, model: profile.model, pricing, limits, studyId: opts.studyId ?? null, ...(opts.acceptUnknownCost && { acceptUnknownCost: true }) }));
}

/**
 * Moteur d'un assistant (modules, cible, protocole, neutralisation, recommandations, recodage) : profil
 * `--profile`, sinon `PERSONAS_PROFILE`, le profil actif, puis claude-cli (sans configuration : le moteur
 * claude-cli d'avant les profils, inchangé). Un fournisseur payant a ses plafonds journalier et mensuel
 * (l'usage est cumulé dans la base locale, ouverte pour l'occasion si l'appelant n'en donne pas).
 */
export function assistantEngine(config: AppConfig, opts: { profile?: string | undefined; db?: Db | null; env?: NodeJS.ProcessEnv } = {}): Engine {
  const profile = chooseProfile(config, { profile: opts.profile, ...(opts.env && { env: opts.env }) });
  if (isBuiltinProfile(profile.name)) return engineForProfile(profile, config);
  let db = opts.db ?? null;
  if (!db) {
    const opened = openDb(config.DATABASE_PATH);
    runMigrations(opened.db);
    db = opened.db;
  }
  return guardedEngine(db, profile, config);
}
