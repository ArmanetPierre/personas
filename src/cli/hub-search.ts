import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { readCachedCatalog } from "../hub/cache";
import { HubClient } from "../hub/client";
import { formatQuality, hitRef, searchModules } from "../hub/search";
import { moduleLibrary } from "../modules/registry";
import { errorText, lang, t } from "./i18n";

/**
 * Recherche de modules. Par défaut en local (BM25 sur la bibliothèque et le dernier catalogue du Hub en cache) :
 * rien n'est envoyé. `--remote` interroge le Hub (GET /v1/search) avec le seul texte tapé.
 *
 *   personas hub search <texte> [--socle fr] [--limit 20] [--remote] [--json]
 */

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    socle: { type: "string" },
    limit: { type: "string", default: "20" },
    remote: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
const query = positionals.join(" ").trim();
if (values.help || !query) {
  console.log(t.hub.searchUsage);
  process.exit(values.help ? 0 : 2);
}
loadDotEnv();
try {
  const limit = Number(values.limit);
  if (values.remote) {
    const r = await new HubClient().search(query, { ...(values.socle && { socle: values.socle }), limit });
    if (values.json) console.log(JSON.stringify(r, null, 1));
    else if (!r.results.length) console.log(t.hub.noResults(query));
    else for (const x of r.results) console.log(t.hub.result(x.ref, x.latest, "Hub", x.label, x.q === null ? formatQuality(null, lang) : `Q ${Math.round(x.q)}`, x.appliesTo.join(", ")));
  } else {
    const catalog = readCachedCatalog()?.catalog ?? null;
    const hits = searchModules(query, { lib: moduleLibrary(), catalog, ...(values.socle && { socle: values.socle }), limit });
    if (values.json) {
      console.log(JSON.stringify(hits.map((h) => ({ ref: hitRef(h), version: h.doc.latest, label: h.doc.label, source: h.doc.source, quality: h.doc.quality, appliesTo: h.doc.appliesTo, score: h.score })), null, 1));
    } else if (!hits.length) console.log(t.hub.noResults(query));
    else for (const h of hits) console.log(t.hub.result(hitRef(h), h.doc.latest, t.hub.sources[h.doc.source]!, h.doc.label, formatQuality(h.doc.quality, lang), h.doc.appliesTo.join(", ")));
  }
} catch (err) {
  console.error(t.common.error(errorText(err)));
  process.exitCode = 1;
}
