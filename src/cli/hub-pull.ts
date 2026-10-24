import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { hubCacheDir } from "../hub/cache";
import { HubClient } from "../hub/client";
import { pullModule, pullPack } from "../hub/pull";
import { errorText, t } from "./i18n";

/**
 * Télécharge un module (ou un pack, --pack) du Hub dans le cache local : version exacte, sha256 vérifié,
 * module revalidé par ce moteur, dépendances comprises. Rien n'est épinglé (voir personas hub lock).
 *
 *   personas hub pull <namespace/module>[@version] [--pack]
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { pack: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
const spec = positionals[0];
if (values.help || !spec) {
  console.log(t.hub.pullUsage);
  process.exit(values.help ? 0 : 2);
}
loadDotEnv();
try {
  const client = new HubClient();
  const results = values.pack ? await pullPack(client, spec) : await pullModule(client, spec);
  for (const r of results) {
    console.log(r.bundled ? t.hub.bundled(t.hub.kinds[r.kind]!, r.ref, r.version) : r.already ? t.hub.alreadyCached(t.hub.kinds[r.kind]!, r.ref, r.version) : t.hub.pulled(t.hub.kinds[r.kind]!, r.ref, r.version, r.sha256));
    for (const w of r.warnings) console.log(t.hub.warning(w));
  }
  console.log(t.hub.cacheDir(hubCacheDir() ?? "-"));
} catch (err) {
  console.error(t.common.error(errorText(err)));
  process.exitCode = 1;
}
