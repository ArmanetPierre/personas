import { parseArgs } from "node:util";
import { acceptDraft, previewModule } from "../modules/assistant";
import { errorText, t } from "./i18n";

/** Valide un brouillon : il rejoint la bibliothèque (modules/<id>/). Refusé si la validation ou l'aperçu échoue. */

const { values } = parseArgs({
  options: { draft: { type: "string" }, replace: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
});
if (values.help || !values.draft) {
  console.log(t.moduleAccept.usage);
  process.exit(values.help ? 0 : 2);
}
try {
  const p = previewModule({ draftId: values.draft }, { n: 10000, sample: 0 });
  const blocking = p.alerts.filter((a) => a.level === "error").map((a) => a.message);
  const r = acceptDraft(values.draft, { replace: values.replace, blockingAlerts: blocking });
  console.log(t.moduleAccept.accepted(r.moduleId, r.file));
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
}
