import { defaultSecretStore, type SecretStore } from "../engine/secrets";

/** Compte du trousseau (service `personas`) qui porte le jeton d'administration du Hub. */
export const HUB_ADMIN_ACCOUNT = "hub-admin";

/**
 * Jeton d'administration du Hub (publication des modules et packs officiels) : `HUB_ADMIN_TOKEN`, sinon le
 * trousseau du système (compte `hub-admin`). Le jeton n'est jamais affiché ni écrit dans un journal.
 */
export async function resolveHubAdminToken(
  opts: { env?: NodeJS.ProcessEnv; store?: SecretStore } = {},
): Promise<{ token: string; source: "env" | "keychain" } | null> {
  const env = opts.env ?? process.env;
  const fromEnv = env.HUB_ADMIN_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };
  try {
    const k = await (opts.store ?? defaultSecretStore(env)).get(HUB_ADMIN_ACCOUNT);
    if (k) return { token: k, source: "keychain" };
  } catch {
    // trousseau indisponible : pas de jeton
  }
  return null;
}
