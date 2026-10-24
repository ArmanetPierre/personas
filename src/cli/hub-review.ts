import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { HubClient } from "../hub/client";
import { parseModuleSpec } from "../modules/refs";
import { requireHubToken } from "./hub-common";
import { errorText, t } from "./i18n";

/**
 * Avis public sur une version de module (POST /v1/modules/:ns/:slug/:version/reviews).
 *
 *   personas hub review <namespace/module@version> --rating 1-5 [--text "…"]
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { rating: { type: "string" }, text: { type: "string" }, help: { type: "boolean", short: "h" } } });
const spec = positionals[0];
if (values.help || !spec || values.rating === undefined) {
  console.log(t.hub.reviewUsage);
  process.exit(values.help ? 0 : 2);
}
const rating = Number(values.rating);
if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
  console.error(t.hub.badRating(values.rating));
  process.exit(2);
}
loadDotEnv();
try {
  const s = parseModuleSpec(spec);
  if (!s.version) {
    console.error(t.hub.needVersion(`${s.namespace}/${s.slug}`));
    process.exit(2);
  }
  const { token } = await requireHubToken();
  const ref = `${s.namespace}/${s.slug}`;
  const r = await new HubClient().review({ ref, version: s.version, rating, body: values.text ?? "" }, token);
  console.log(t.hub.reviewed(ref, r.version, r.rating));
} catch (err) {
  console.error(t.common.error(errorText(err)));
  if ((err as { status?: number }).status === 401) console.error(t.hub.tokenRejected);
  process.exitCode = 1;
}
