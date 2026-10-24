import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { assistantEngine } from "../engine/select";
import { reviseModule } from "../modules/assistant";
import { t } from "./i18n";

/** Révision ciblée d'un brouillon de module, par instruction (historique et diff dans meta.json). */

const { values } = parseArgs({
  options: { draft: { type: "string" }, profile: { type: "string" }, instruction: { type: "string" }, research: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
});
if (values.help || !values.draft || !values.instruction) {
  console.log(t.moduleRevise.usage);
  process.exit(values.help ? 0 : 2);
}
loadDotEnv();
const meta = await reviseModule(assistantEngine(loadConfig(), { profile: values.profile }), values.draft, values.instruction, { research: values.research, log: (m) => console.log(m) });
console.log(t.common.draftStatus(meta.id, meta.status, meta.progress));
const last = meta.history.at(-1);
if (last?.diff) console.log(`\n${last.summary}\n${last.diff}`);
if (meta.error) console.log(t.common.error(meta.error));
const u = meta.usage;
if (u) console.log(t.moduleRevise.total(u.calls, u.inputTokens, u.outputTokens));
process.exitCode = meta.status === "ready" ? 0 : 1;
