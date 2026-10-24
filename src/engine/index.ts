import { OLLAMA_MAX_CONCURRENCY, type AppConfig } from "../config";
import { AnthropicBackend, type HttpBackendOptions } from "./backends/anthropic";
import { ClaudeCliBackend } from "./backends/claude-cli";
import { GeminiBackend } from "./backends/gemini";
import { OllamaBackend } from "./backends/ollama";
import { OpenAiBackend } from "./backends/openai";
import { Engine, type EngineOptions } from "./engine";
import { assertProviderAllowed, builtinProfiles, isBuiltinProfile, resolveProfile, type EngineProfile } from "./profiles";
import { resolveApiKey, type SecretStore } from "./secrets";
import type { Backend, ProviderCapabilities, ProviderKind } from "./types";

export * from "./types";
export { Engine, SchemaValidationError } from "./engine";
export { createLimiter } from "./limiter";
export { extractJson } from "./json";
export {
  ProviderAuthError,
  ProviderError,
  ProviderKeyMissingError,
  ProviderRateLimitError,
  redactSecrets,
} from "./backends/http";
export { PROVIDER_KINDS, resolveProfile, type EngineProfile } from "./profiles";

/**
 * Backends sélectionnables par leur seul nom, réglés par l'environnement (inchangé). Les fournisseurs
 * à clé (`anthropic`, `openai`, `openrouter`, `gemini`, `openai-compatible`) passent par un profil.
 * `anthropic-api` reste listé pour que les commandes qui le refusaient le refusent toujours.
 */
export const BACKEND_NAMES: readonly string[] = ["claude-cli", "ollama", "anthropic-api"];

/** Capacités d'un backend (un backend simulé de test peut ne pas les déclarer). */
export function capabilitiesOf(backend: Backend): ProviderCapabilities {
  return backend.capabilities ?? { structured: "none", webTools: false, logprobs: false };
}

export interface BackendDeps {
  /** Magasin des clés (défaut : trousseau du système ; mémoire sous vitest). */
  secrets?: SecretStore;
  /** Environnement où lire `keyEnv` (défaut : process.env). */
  env?: NodeJS.ProcessEnv;
  /** Avertissements (repli de la clé sur une variable d'environnement). Défaut : console.warn. */
  warn?: (message: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 300_000;
const DEFAULT_HTTP_CONCURRENCY = 2;

/** Un serveur Ollama joint par son API /v1 garde le plafond de concurrence d'Ollama. */
function looksLikeOllama(baseUrl: string | undefined, config: AppConfig): boolean {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    return u.port === "11434" || u.origin === new URL(config.OLLAMA_BASE_URL).origin;
  } catch {
    return false;
  }
}

/** Backend d'un profil de moteur. La clé est lue à la demande (trousseau, puis `keyEnv`), une seule fois. */
export function createBackendFromProfile(profile: EngineProfile, config: AppConfig, deps: BackendDeps = {}): Backend {
  // Service hébergé : ni claude-cli, ni ollama, ni URL arbitraire (dernier rempart, après le choix du profil)
  assertProviderAllowed(profile);
  switch (profile.provider) {
    case "claude-cli":
      return new ClaudeCliBackend({
        bin: config.CLAUDE_CLI_PATH,
        model: profile.model,
        concurrency: profile.concurrency ?? config.CLAUDE_CLI_CONCURRENCY,
        timeoutMs: profile.timeoutMs ?? config.CLAUDE_CLI_TIMEOUT_MS,
      });
    case "ollama":
      return new OllamaBackend({
        baseUrl: profile.baseUrl ?? config.OLLAMA_BASE_URL,
        model: profile.model,
        numCtx: config.OLLAMA_NUM_CTX,
        concurrency: profile.concurrency ?? config.OLLAMA_CONCURRENCY,
        timeoutMs: profile.timeoutMs ?? config.OLLAMA_TIMEOUT_MS,
      });
  }

  let keyPromise: Promise<string | undefined> | undefined;
  const apiKey = () =>
    (keyPromise ??= resolveApiKey(profile, {
      ...(deps.secrets && { store: deps.secrets }),
      ...(deps.env && { env: deps.env }),
    }).then((r) => {
      if (r.warning) (deps.warn ?? console.warn)(`Avertissement : ${r.warning}`);
      return r.key;
    }));
  const opts: HttpBackendOptions = {
    profile: profile.name,
    model: profile.model,
    ...(profile.baseUrl && { baseUrl: profile.baseUrl }),
    concurrency: profile.concurrency ?? DEFAULT_HTTP_CONCURRENCY,
    timeoutMs: profile.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    apiKey,
    ...(deps.fetch && { fetch: deps.fetch }),
    ...(deps.sleep && { sleep: deps.sleep }),
  };
  switch (profile.provider) {
    case "anthropic":
      return new AnthropicBackend(opts);
    case "gemini":
      return new GeminiBackend(opts);
    case "openai":
    case "openrouter":
      return new OpenAiBackend({ ...opts, kind: profile.provider });
    case "openai-compatible":
      return new OpenAiBackend({
        ...opts,
        kind: "openai-compatible",
        ...(looksLikeOllama(profile.baseUrl, config) && { maxConcurrency: OLLAMA_MAX_CONCURRENCY }),
      });
  }
}

/**
 * Backend par son nom (`claude-cli`, `ollama` : profils intégrés tirés de l'environnement, comme avant)
 * ou par un profil de moteur.
 */
export function createBackend(target: ProviderKind | "anthropic-api" | EngineProfile, config: AppConfig, deps: BackendDeps = {}): Backend {
  if (typeof target === "object") return createBackendFromProfile(target, config, deps);
  if (target === "claude-cli" || target === "ollama") {
    return createBackendFromProfile(builtinProfiles(config).find((p) => p.name === target)!, config, deps);
  }
  if (target === "anthropic-api") {
    throw new Error(
      "Backend anthropic-api remplacé par le fournisseur anthropic, avec la clé de l'utilisateur : " +
        "npm run engine:profile -- add --name <nom> --provider anthropic --model <modèle>, puis npm run engine:key -- set --profile <nom>.",
    );
  }
  throw new Error(`Le fournisseur ${target} se configure par un profil : npm run engine:profile -- add --name <nom> --provider ${target} --model <modèle>.`);
}

/**
 * Un moteur par backend (ou par profil), partagé dans le processus : la limite de concurrence vaut
 * pour tout le processus, pas pour chaque appelant.
 */
const engines = new Map<string, Engine>();

export function getEngine(name: ProviderKind, config: AppConfig, options?: EngineOptions): Engine {
  let engine = engines.get(name);
  if (!engine) {
    engine = new Engine(createBackend(name, config), options);
    engines.set(name, engine);
  }
  return engine;
}

/**
 * Moteur du profil actif (`--profile`, `PERSONAS_PROFILE`, fichier, sinon `claude-cli`). Les profils
 * intégrés partagent le moteur de `getEngine` (même limiteur).
 */
export function getProfileEngine(
  config: AppConfig,
  opts: { profile?: string | undefined; env?: NodeJS.ProcessEnv; path?: string; deps?: BackendDeps; engine?: EngineOptions } = {},
): Engine {
  const profile = resolveProfile(config, {
    ...(opts.profile && { flag: opts.profile }),
    ...(opts.env && { env: opts.env }),
    ...(opts.path && { path: opts.path }),
  });
  if (isBuiltinProfile(profile.name)) return getEngine(profile.provider, config, opts.engine);
  const key = `profile:${profile.name}`;
  let engine = engines.get(key);
  if (!engine) {
    engine = new Engine(createBackendFromProfile(profile, config, opts.deps), opts.engine);
    engines.set(key, engine);
  }
  return engine;
}
