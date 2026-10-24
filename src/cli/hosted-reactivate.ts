import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { reactivateAccount, tombstonesFileOf } from "../hosted/tombstones";
import { errorText, t } from "./i18n";

/**
 * Réactive une adresse supprimée du service hébergé (personas hosted reactivate <e-mail>) : retire ses empreintes
 * de `<HOSTED_DATA_ROOT>/_system/deleted-accounts.json` (src/hosted/tombstones.ts). Commande d'administration, à
 * lancer sur demande écrite de l'utilisateur, dans le conteneur du service :
 *   docker compose exec hosted node --import tsx src/cli/hosted-reactivate.ts <e-mail>
 * Aucun e-mail n'est affiché ni journalisé ; le serveur relit la liste sans redémarrage.
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "data-root": { type: "string" }, help: { type: "boolean", short: "h" } } });
const m = t.hostedReactivate;
if (values.help) {
  console.log(m.usage);
  process.exit(0);
}
const value = positionals[0]?.trim();
const root = values["data-root"] ?? process.env.HOSTED_DATA_ROOT;
if (!value) {
  console.error(m.missing);
  console.error(m.usage);
  process.exitCode = 2;
} else if (!root) {
  console.error(m.noDataRoot);
  process.exitCode = 2;
} else {
  try {
    const n = reactivateAccount(tombstonesFileOf(resolve(root)), value);
    console.log(n ? m.done(n) : m.none);
  } catch (err) {
    console.error(t.common.error(errorText(err)));
    process.exitCode = 1;
  }
}
