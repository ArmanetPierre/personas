import { parseArgs } from "node:util";
import { loadDotEnv } from "../config";
import { HubClient } from "../hub/client";
import { reportReason } from "../hub/contract";
import { parseModuleSpec } from "../modules/refs";
import { requireHubToken } from "./hub-common";
import { errorText, t } from "./i18n";

/**
 * Signalement d'une version de module à la modération du Hub (POST /v1/reports) ; sans version : la dernière
 * du catalogue.
 *
 *   personas hub report <namespace/module>[@version] --reason <malicious|injection|sensitive|rights|other> [--text "…"]
 */

const { values, positionals } = parseArgs({ allowPositionals: true, options: { reason: { type: "string" }, text: { type: "string" }, help: { type: "boolean", short: "h" } } });
const spec = positionals[0];
if (values.help || !spec || !values.reason) {
  console.log(t.hub.reportUsage);
  process.exit(values.help ? 0 : 2);
}
const reason = reportReason.safeParse(values.reason);
if (!reason.success) {
  console.error(t.hub.badReason(values.reason));
  process.exit(2);
}
loadDotEnv();
try {
  const s = parseModuleSpec(spec);
  const ref = `${s.namespace}/${s.slug}`;
  const client = new HubClient();
  const version = s.version ?? (await client.catalog()).catalog?.modules.find((m) => m.ref === ref)?.latest;
  if (!version) {
    console.error(t.hub.needVersion(ref));
    process.exit(2);
  }
  const { token } = await requireHubToken();
  const r = await client.report({ target: { kind: "module_version", ref, version }, reason: reason.data, body: values.text ?? "" }, token);
  console.log(t.hub.reported(ref, version, r.reports, r.status));
} catch (err) {
  console.error(t.common.error(errorText(err)));
  if ((err as { status?: number }).status === 401) console.error(t.hub.tokenRejected);
  process.exitCode = 1;
}
