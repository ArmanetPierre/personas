import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { HubClient } from "../hub/client";
import { forkModule } from "../hub/fork";
import { requireHubToken } from "./hub-common";
import { errorText, t } from "./i18n";

/**
 * Fork d'un module du Hub dans le namespace du compte (filiation enregistrée par le Hub), téléchargé dans le cache
 * (sha256, signature et lint vérifiés), puis copie éditable dans modules/<id> (`forked_from` renseigné).
 *
 *   personas hub fork <namespace/module>[@version] [--as <id>]
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { as: { type: "string" }, help: { type: "boolean", short: "h" } } });
const spec = positionals[0];
if (values.help || !spec || !spec.includes("/")) {
  console.log(t.hub.forkUsage);
  process.exit(values.help ? 0 : 2);
}
loadDotEnv();
try {
  const { token } = await requireHubToken();
  const client = new HubClient();
  console.log(t.hub.hubUrl(client.baseUrl));
  const r = await forkModule(client, spec, { token, ...(values.as && { as: values.as }) });
  console.log(t.hub.forked(r.hub.ref, r.hub.version, r.forkedFrom));
  for (const p of r.pulled) {
    console.log(p.already ? t.hub.alreadyCached(t.hub.kinds[p.kind]!, p.ref, p.version) : t.hub.pulled(t.hub.kinds[p.kind]!, p.ref, p.version, p.sha256));
    for (const w of p.warnings) console.log(t.hub.warning(w));
  }
  console.log(t.hub.forkLocal(r.file, r.localId));
} catch (err) {
  console.error(t.common.error(errorText(err)));
  if ((err as { status?: number }).status === 401) console.error(t.hub.tokenRejected);
  process.exitCode = 1;
}
