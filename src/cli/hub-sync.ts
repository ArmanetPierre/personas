import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { HubClient } from "../hub/client";
import { errorText, t } from "./i18n";

/**
 * Met à jour le catalogue du Hub en cache (GET /v1/catalog, ETag). Hors ligne : garde le dernier catalogue.
 *
 *   personas hub sync [--json]
 */

const { values } = parseArgs({ options: { json: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log(t.hub.syncUsage);
  process.exit(0);
}
loadDotEnv();
try {
  const client = new HubClient();
  const r = await client.catalog();
  if (values.json) {
    console.log(JSON.stringify({ hub: client.baseUrl, source: r.source, fetchedAt: r.fetchedAt ?? null, modules: r.catalog?.modules.length ?? 0, packs: r.catalog?.packs.length ?? 0, ...(r.offline && { offline: r.offline }) }, null, 1));
  } else {
    console.log(t.hub.hubUrl(client.baseUrl));
    if (r.offline) console.log(t.hub.offline(r.offline));
    if (r.source === "network") console.log(t.hub.catalogNetwork(r.catalog!.modules.length, r.catalog!.packs.length, r.fetchedAt!));
    else if (r.source === "not-modified") console.log(t.hub.catalogNotModified(r.fetchedAt!));
    else if (r.source === "cache") console.log(t.hub.catalogCache(r.fetchedAt ?? "?"));
    else console.log(t.hub.catalogNone);
  }
  if (r.source === "none") process.exitCode = 1;
} catch (err) {
  console.error(t.common.error(errorText(err)));
  process.exitCode = 1;
}
