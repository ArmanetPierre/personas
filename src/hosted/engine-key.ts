import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { HOSTED_ENGINE_FILE, HOSTED_PROFILE, HOSTED_PROVIDERS, loadEngineConfig, saveEngineConfig, type HostedProvider } from "../engine/profiles";
import { openSecret, sealSecret, type SealedSecret } from "./crypto";

/**
 * Clé IA d'un compte hébergé :
 * - `<compte>/engine.json` : le profil unique `user` (fournisseur, modèle, plafonds), au format des profils de
 *   moteur (src/engine/profiles.ts), sans clé : c'est lui que lisent l'API et les processus enfants ;
 * - `<compte>/secrets/engine-key.json` (0600) : la clé chiffrée (AES-256-GCM, src/hosted/crypto.ts), plus les
 *   4 derniers caractères pour l'affichage. La clé en clair n'est jamais écrite ni renvoyée.
 */

export const KEY_FILE = join("secrets", "engine-key.json");

const sealedSchema = z.object({ v: z.literal(1), alg: z.literal("aes-256-gcm"), iv: z.string(), tag: z.string(), ct: z.string() });
const keyFileSchema = z.object({ provider: z.enum(HOSTED_PROVIDERS), last4: z.string().max(4), updatedAt: z.string(), sealed: sealedSchema });
type KeyFile = z.infer<typeof keyFileSchema>;

export interface EngineLimits {
  perStudyUsd: number;
  perMonthUsd: number;
}

export interface EngineSummary {
  provider: HostedProvider;
  model: string;
  last4: string;
  limits: EngineLimits;
  updatedAt: string;
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // système de fichiers sans droits POSIX
  }
}

function readKeyFile(accountDir: string): KeyFile | null {
  const f = join(accountDir, KEY_FILE);
  if (!existsSync(f)) return null;
  try {
    return keyFileSchema.parse(JSON.parse(readFileSync(f, "utf8")));
  } catch {
    return null;
  }
}

/** Fournisseur, modèle, 4 derniers caractères et plafonds ; null sans clé configurée. */
export function readEngineSummary(accountDir: string, defaults: EngineLimits): EngineSummary | null {
  const k = readKeyFile(accountDir);
  if (!k) return null;
  let profile;
  try {
    profile = loadEngineConfig(join(accountDir, HOSTED_ENGINE_FILE)).profiles.find((p) => p.name === HOSTED_PROFILE);
  } catch {
    profile = undefined;
  }
  if (!profile || profile.provider !== k.provider) return null;
  return {
    provider: k.provider,
    model: profile.model,
    last4: k.last4,
    limits: { perStudyUsd: profile.limits?.perStudyUsd ?? defaults.perStudyUsd, perMonthUsd: profile.limits?.perMonthUsd ?? defaults.perMonthUsd },
    updatedAt: k.updatedAt,
  };
}

/** Enregistre le profil et, si `apiKey` est donnée, la clé chiffrée (sinon la clé déjà rangée est gardée). */
export function saveEngine(
  accountDir: string,
  input: { userId: string; masterKey: Buffer; provider: HostedProvider; model: string; apiKey?: string; limits: EngineLimits },
): void {
  if (input.apiKey) {
    const sealed: SealedSecret = sealSecret(input.masterKey, input.userId, input.provider, input.apiKey);
    const file: KeyFile = { provider: input.provider, last4: input.apiKey.slice(-4), updatedAt: new Date().toISOString(), sealed };
    writePrivate(join(accountDir, KEY_FILE), `${JSON.stringify(file, null, 2)}\n`);
  } else {
    const k = readKeyFile(accountDir);
    if (!k || k.provider !== input.provider) throw new Error("Clé requise pour ce fournisseur.");
    writePrivate(join(accountDir, KEY_FILE), `${JSON.stringify({ ...k, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  saveEngineConfig(
    {
      version: 1,
      activeProfile: HOSTED_PROFILE,
      profiles: [{ name: HOSTED_PROFILE, provider: input.provider, model: input.model, limits: { perStudyUsd: input.limits.perStudyUsd, perMonthUsd: input.limits.perMonthUsd } }],
    },
    join(accountDir, HOSTED_ENGINE_FILE),
  );
}

export function deleteEngine(accountDir: string): boolean {
  const had = existsSync(join(accountDir, KEY_FILE)) || existsSync(join(accountDir, HOSTED_ENGINE_FILE));
  rmSync(join(accountDir, KEY_FILE), { force: true });
  rmSync(join(accountDir, HOSTED_ENGINE_FILE), { force: true });
  return had;
}

/** Clé déchiffrée, pour le processus enfant seulement (jamais pour une réponse HTTP). */
export function decryptEngineKey(accountDir: string, userId: string, masterKey: Buffer): { profile: string; apiKey: string } | null {
  const k = readKeyFile(accountDir);
  if (!k) return null;
  return { profile: HOSTED_PROFILE, apiKey: openSecret(masterKey, userId, k.provider, k.sealed) };
}
