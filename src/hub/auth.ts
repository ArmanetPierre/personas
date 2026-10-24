import { defaultSecretStore, type SecretStore } from "../engine/secrets";
import type { DeviceCode, HubClient, HubMe } from "./client";
import { HubError } from "./client";
import { hubSettingsPath, readHubSettings, updateHubSettings } from "./settings";

/**
 * Jeton personnel du Hub (docs/plateforme.md § 8.2, `personas hub login`) : obtenu par le flux d'appareil, rangé
 * dans le trousseau du système (service `personas`, compte `hub-token`, src/engine/secrets.ts), jamais affiché,
 * jamais écrit dans un fichier ni un journal. `PERSONAS_HUB_TOKEN` (environnement) le remplace pour un usage
 * sans trousseau (CI), comme `HUB_ADMIN_TOKEN` pour l'administration.
 */

export const HUB_TOKEN_ACCOUNT = "hub-token";

export interface ResolvedHubToken {
  token: string;
  source: "env" | "keychain";
}

export async function resolveHubToken(opts: { env?: NodeJS.ProcessEnv; store?: SecretStore } = {}): Promise<ResolvedHubToken | null> {
  const env = opts.env ?? process.env;
  const fromEnv = env.PERSONAS_HUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  try {
    const k = await (opts.store ?? defaultSecretStore(env)).get(HUB_TOKEN_ACCOUNT);
    if (k) return { token: k, source: "keychain" };
  } catch {
    // trousseau indisponible : pas de jeton
  }
  return null;
}

export class LoginError extends Error {
  override name = "LoginError";
  constructor(
    readonly reason: "denied" | "expired" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

export interface LoginOptions {
  store?: SecretStore;
  /** Fichier des réglages (compte affiché) ; défaut : hub-settings.json du dossier de données. */
  settingsPath?: string | null;
  /** Affichage du code et de l'URL (le jeton, lui, n'est jamais transmis à ce rappel). */
  onCode: (code: DeviceCode) => void;
  /** Chaque sondage en attente (indicateur de progression). */
  onPending?: () => void;
  /** Attente entre deux sondages (tests : immédiate). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  clientName?: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Flux d'appareil complet : code (POST /v1/device/code), affichage, sondage (POST /v1/device/token) au rythme
 * imposé par le Hub (`interval`, `slow_down`), puis jeton rangé dans le trousseau et compte lu (GET /v1/me).
 * Renvoie le compte, jamais le jeton.
 */
export async function deviceLogin(client: HubClient, opts: LoginOptions): Promise<{ me: HubMe; storedIn: SecretStore["kind"]; expiresAt: string }> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const code = await client.deviceCode({ clientName: opts.clientName ?? "personas CLI" });
  opts.onCode(code);
  const deadline = now() + code.expires_in * 1000;
  let interval = Math.max(1, code.interval);
  for (;;) {
    if (now() > deadline) throw new LoginError("expired", "Code expiré avant la validation dans le navigateur : relancer personas hub login.");
    await sleep(interval * 1000);
    const r = await client.deviceToken(code.device_code);
    if (r.status === "approved") {
      const store = opts.store ?? defaultSecretStore();
      await store.set(HUB_TOKEN_ACCOUNT, r.token);
      const me = await client.me(r.token);
      updateHubSettings(
        (s) => ({ ...s, account: { hubUrl: client.baseUrl, namespace: me.namespace, displayName: me.displayName, scopes: r.scopes, expiresAt: r.expiresAt, loggedInAt: new Date().toISOString() } }),
        opts.settingsPath === undefined ? hubSettingsPath() : opts.settingsPath,
      );
      return { me, storedIn: store.kind, expiresAt: r.expiresAt };
    }
    if (r.status === "access_denied") throw new LoginError("denied", r.message);
    if (r.status === "expired_token") throw new LoginError("expired", r.message);
    if ("interval" in r) interval = Math.max(interval, r.interval);
    opts.onPending?.();
  }
}

/** Retire le jeton du trousseau et le compte des réglages. Vrai si un jeton était rangé. */
export async function logout(opts: { store?: SecretStore; settingsPath?: string | null } = {}): Promise<boolean> {
  const removed = await (opts.store ?? defaultSecretStore()).remove(HUB_TOKEN_ACCOUNT).catch(() => false);
  updateHubSettings((s) => ({ ...s, account: null }), opts.settingsPath === undefined ? hubSettingsPath() : opts.settingsPath);
  return removed;
}

export interface AccountStatus {
  hubUrl: string;
  /** Un jeton est disponible (trousseau ou PERSONAS_HUB_TOKEN). */
  tokenStored: boolean;
  tokenSource: ResolvedHubToken["source"] | null;
  /** Compte confirmé par le Hub (GET /v1/me) ; null si déconnecté, jeton refusé ou Hub injoignable. */
  me: HubMe | null;
  /** Jeton refusé par le Hub (expiré ou révoqué) : relancer personas hub login. */
  rejected: boolean;
  /** Hub injoignable : dernier compte connu (réglages). */
  offline?: string;
  lastKnown: ReturnType<typeof readHubSettings>["account"];
}

/** État de connexion (tableau de bord, `personas hub whoami`). N'affiche jamais le jeton. */
export async function accountStatus(client: HubClient, opts: { store?: SecretStore; env?: NodeJS.ProcessEnv; settingsPath?: string | null } = {}): Promise<AccountStatus> {
  const t = await resolveHubToken(opts);
  const lastKnown = readHubSettings(opts.settingsPath === undefined ? hubSettingsPath() : opts.settingsPath).account;
  const base = { hubUrl: client.baseUrl, tokenStored: !!t, tokenSource: t?.source ?? null, me: null, rejected: false, lastKnown };
  if (!t) return base;
  try {
    return { ...base, me: await client.me(t.token) };
  } catch (err) {
    if (err instanceof HubError && err.status === 401) return { ...base, rejected: true };
    return { ...base, offline: (err as Error).message };
  }
}
