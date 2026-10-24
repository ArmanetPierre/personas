import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { deviceLogin } from "../hub/auth";
import { HubClient } from "../hub/client";
import { errorText, t } from "./i18n";

/**
 * Connexion au Hub par flux d'appareil (docs/plateforme.md § 8.2) : un code s'affiche, la validation se fait
 * dans le navigateur, puis le jeton personnel est rangé dans le trousseau (compte hub-token). Le jeton n'est
 * jamais affiché ni écrit ailleurs.
 *
 *   personas hub login
 */

const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log(t.hub.loginUsage);
  process.exit(0);
}
loadDotEnv();
try {
  const client = new HubClient();
  console.log(t.hub.hubUrl(client.baseUrl));
  const r = await deviceLogin(client, {
    onCode: (code) => {
      console.log(t.hub.loginOpen(code.verification_uri));
      console.log(t.hub.loginCode(code.user_code));
      console.log(t.hub.loginDirect(code.verification_uri_complete));
      console.log(t.hub.loginWaiting(Math.round(code.expires_in / 60)));
    },
    onPending: () => process.stdout.isTTY && process.stdout.write("."),
  });
  if (process.stdout.isTTY) process.stdout.write("\n");
  console.log(t.hub.loginDone(r.me.namespace, r.me.displayName ?? r.me.githubLogin ?? r.me.namespace, t.hub.loginStores[r.storedIn] ?? r.storedIn, r.expiresAt.slice(0, 10)));
} catch (err) {
  console.error(t.hub.loginFailed(errorText(err)));
  process.exitCode = 1;
}
