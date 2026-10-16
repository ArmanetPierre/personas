import { parseArgs } from "node:util";
import { previewModule } from "../modules/assistant";
import { t } from "./i18n";

/** Aperçu d'un module : tirage virtuel, marges, fiches exemples, alertes (sans LLM). */

const { values } = parseArgs({
  options: {
    draft: { type: "string" },
    module: { type: "string" },
    n: { type: "string", default: "10000" },
    sample: { type: "string", default: "5" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || (!values.draft && !values.module)) {
  console.log(t.modulePreview.usage);
  process.exit(values.help ? 0 : 2);
}
const r = previewModule(values.draft ? { draftId: values.draft } : { moduleId: values.module! }, { n: Number(values.n), sample: Number(values.sample) });
if (values.json) {
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log(t.modulePreview.header(r.moduleId, r.socle, r.n));
  for (const m of r.margins) {
    console.log(t.modulePreview.margin(m.label, m.attribute, m.type, m.applicable));
    for (const v of m.values) console.log(`  ${v.label.slice(0, 60).padEnd(60)} ${(v.share * 100).toFixed(1).padStart(5)}${t.common.pct}`);
  }
  if (r.eligibilityHelpers?.length) {
    console.log(t.modulePreview.helpers);
    for (const h of r.eligibilityHelpers) console.log(t.modulePreview.helper(h.name, (h.rate * 100).toFixed(2), h.expression));
  }
  console.log(t.modulePreview.alerts);
  for (const a of r.alerts) console.log(`  [${a.level}] ${a.message}`);
  for (const c of r.sampleCards) console.log(`\n--- ${c.personaId}\n${c.card}`);
}
process.exitCode = r.alerts.some((a) => a.level === "error") ? 1 : 0;
