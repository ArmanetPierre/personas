import { runMode } from "../config";
import type { EngineProfile } from "./profiles";

/**
 * Clés des fournisseurs (docs/plateforme.md § 7.5).
 *
 * - Rangées dans le trousseau du système (Trousseau macOS, Gestionnaire d'identification Windows,
 *   Secret Service sous Linux) par @napi-rs/keyring : une entrée par profil, service `personas`,
 *   compte `<profil>` (« personas/<profil> »).
 * - Repli, sans trousseau : une variable d'environnement explicitement nommée dans le profil
 *   (`keyEnv`), avec un avertissement. Jamais une variable `ANTHROPIC_*` (réservée, retirée de
 *   l'environnement des processus enfants), jamais un fichier en clair.
 * - Une clé n'est jamais écrite dans un journal, un message d'erreur ni une sortie console.
 */

export const KEYCHAIN_SERVICE = "personas";

/** Fournisseurs qui n'ont jamais de clé : abonnement de la CLI, serveur Ollama. */
export const KEYLESS_PROVIDERS = new Set(["claude-cli", "ollama"]);

export class KeychainUnavailableError extends Error {
  override name = "KeychainUnavailableError";
}

export interface SecretStore {
  readonly kind: "keychain" | "memory";
  get(profile: string): Promise<string | undefined>;
  set(profile: string, secret: string): Promise<void>;
  /** Vrai si une entrée a été supprimée. */
  remove(profile: string): Promise<boolean>;
}

type KeyringModule = typeof import("@napi-rs/keyring");
let keyringModule: Promise<KeyringModule> | undefined;

async function loadKeyring(): Promise<KeyringModule> {
  keyringModule ??= import("@napi-rs/keyring");
  try {
    return await keyringModule;
  } catch (err) {
    keyringModule = undefined;
    throw new KeychainUnavailableError(`Trousseau du système indisponible (${(err as Error).message.split("\n")[0]})`);
  }
}

/** Trousseau du système. Chaque opération lève `KeychainUnavailableError` si le trousseau ne répond pas. */
export function keychainStore(service = KEYCHAIN_SERVICE): SecretStore {
  const entry = async (profile: string) => new (await loadKeyring()).AsyncEntry(service, profile);
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof KeychainUnavailableError) throw err;
      throw new KeychainUnavailableError(`Trousseau du système indisponible (${(err as Error).message.split("\n")[0]})`);
    }
  };
  return {
    kind: "keychain",
    get: (profile) => wrap(async () => (await (await entry(profile)).getPassword()) ?? undefined),
    set: (profile, secret) => wrap(async () => (await entry(profile)).setPassword(secret)),
    remove: (profile) => wrap(async () => (await entry(profile)).deleteCredential()),
  };
}

/** Magasin en mémoire (tests, et processus sous vitest : le vrai trousseau n'est jamais touché). */
export function memoryStore(initial: Record<string, string> = {}): SecretStore {
  const m = new Map(Object.entries(initial));
  return {
    kind: "memory",
    get: async (p) => m.get(p),
    set: async (p, s) => void m.set(p, s),
    remove: async (p) => m.delete(p),
  };
}

let fallbackTestStore: SecretStore | undefined;
let hostedStore: SecretStore | undefined;

/**
 * Magasin par défaut : le trousseau ; en mémoire sous vitest, pour qu'aucun test ne l'atteigne. Service hébergé :
 * jamais le trousseau du système, seulement la clé reçue par le canal privé du processus (`installHostedSecret`).
 */
export function defaultSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  if (runMode(env) === "hosted") return (hostedStore ??= memoryStore());
  if (env.VITEST) return (fallbackTestStore ??= memoryStore());
  return keychainStore();
}

/**
 * Service hébergé, processus enfant : la clé déchiffrée reçue sur l'entrée standard (src/hosted/child.ts), en
 * mémoire seulement, pour ce profil. Jamais dans l'environnement ni sur la ligne de commande.
 */
export function installHostedSecret(profile: string, secret: string): void {
  hostedStore = memoryStore({ [profile]: secret });
}

/** Variables jamais acceptées comme source de clé (`keyEnv`). */
export const FORBIDDEN_KEY_ENV: RegExp[] = [/^ANTHROPIC_/, /^CLAUDE_CODE_/, /^CLAUDECODE$/, /^AWS_/];

export function checkKeyEnvName(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) return `Nom de variable invalide : ${name} (majuscules, chiffres et _).`;
  if (FORBIDDEN_KEY_ENV.some((re) => re.test(name))) {
    return `Variable ${name} refusée : les variables ANTHROPIC_*, CLAUDE_CODE_* et AWS_* sont réservées (ANTHROPIC_* est retirée de l'environnement des processus enfants). Choisir un autre nom, par ex. PERSONAS_ANTHROPIC_KEY.`;
  }
  return null;
}

export type KeySource = "keychain" | "env" | "none";

export interface ResolvedKey {
  key: string | undefined;
  source: KeySource;
  /** Avertissement à afficher (repli sur une variable d'environnement, trousseau indisponible). */
  warning?: string;
}

/**
 * Clé d'un profil : trousseau d'abord, puis la variable nommée dans le profil (avec avertissement).
 * Ne lit aucune autre variable d'environnement.
 */
export async function resolveApiKey(
  profile: Pick<EngineProfile, "name" | "provider" | "keyEnv">,
  opts: { store?: SecretStore; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedKey> {
  if (KEYLESS_PROVIDERS.has(profile.provider)) return { key: undefined, source: "none" };
  const store = opts.store ?? defaultSecretStore();
  let unavailable: string | undefined;
  try {
    const k = await store.get(profile.name);
    if (k) return { key: k, source: "keychain" };
  } catch (err) {
    unavailable = (err as Error).message;
  }
  if (profile.keyEnv && !checkKeyEnvName(profile.keyEnv)) {
    const v = (opts.env ?? process.env)[profile.keyEnv];
    if (v) {
      return {
        key: v,
        source: "env",
        warning:
          `Clé du profil ${profile.name} lue dans la variable ${profile.keyEnv}` +
          (unavailable ? ` (${unavailable})` : " (aucune entrée dans le trousseau)") +
          ` : préférer le trousseau (npm run engine:key -- set --profile ${profile.name}).`,
      };
    }
  }
  return { key: undefined, source: "none", ...(unavailable && { warning: unavailable }) };
}
