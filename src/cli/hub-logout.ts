import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { logout } from "../hub/auth";
import { errorText, t } from "./i18n";

/** Retire le jeton personnel du Hub du trousseau (personas hub logout). */

const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log(t.hub.logoutUsage);
  process.exit(0);
}
loadDotEnv();
try {
  console.log((await logout()) ? t.hub.logoutDone : t.hub.logoutNone);
  if (process.env.PERSONAS_HUB_TOKEN?.trim()) console.log(t.hub.logoutEnv);
} catch (err) {
  console.error(t.common.error(errorText(err)));
  process.exitCode = 1;
}
