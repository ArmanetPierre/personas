import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { resolveHubToken } from "../hub/auth";
import { HubClient } from "../hub/client";
import { qualifiedRef } from "../hub/contract";
import { errorText, t } from "./i18n";

/** Jeton personnel du Hub (trousseau ou PERSONAS_HUB_TOKEN), sinon message et sortie (code 2). Jamais affiché. */
export async function requireHubToken(): Promise<{ token: string; source: "env" | "keychain" }> {
  const tok = await resolveHubToken();
  if (!tok) {
    console.error(t.hub.notLoggedIn);
    process.exit(2);
  }
  return tok;
}

/** Message d'erreur 401 du Hub : jeton expiré ou révoqué. */
export function isUnauthorized(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { status?: number }).status === 401;
}

/** `personas hub star|unstar <namespace/module>`. */
export async function starCommand(unstar: boolean): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
  const ref = positionals[0]?.replace(/@.*$/, "");
  if (values.help || !ref || !qualifiedRef.safeParse(ref).success) {
    console.log(t.hub.starUsage);
    process.exit(values.help ? 0 : 2);
  }
  loadDotEnv();
  try {
    const { token } = await requireHubToken();
    const client = new HubClient();
    const r = unstar ? await client.unstar(ref, token) : await client.star(ref, token);
    console.log(unstar ? t.hub.unstarred(r.ref, r.stars) : t.hub.starred(r.ref, r.stars));
  } catch (err) {
    console.error(t.common.error(errorText(err)));
    if ((err as { status?: number }).status === 401) console.error(t.hub.tokenRejected);
    process.exitCode = 1;
  }
}
