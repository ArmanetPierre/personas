import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { assistantEngine } from "../engine/select";
import { capabilitiesOf } from "../engine";
import { proposeModule } from "../modules/assistant";
import { getProject } from "../studies/project";
import { t } from "./i18n";

/** Propose un module (brouillon) : recherche de sources, YAML, réparations. Reprenable avec --draft. */

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    description: { type: "string" },
    project: { type: "string" },
    socle: { type: "string", default: "fr" },
    draft: { type: "string" },
    id: { type: "string" },
    "no-research": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || (!values.description && !values.draft)) {
  console.log(t.modulePropose.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
let projectContext: string | undefined;
let projectId: string | undefined;
if (values.project) {
  let p: Record<string, unknown> | undefined;
  if (existsSync(values.project)) {
    const t = readFileSync(values.project, "utf8");
    p = (/\.ya?ml$/i.test(values.project) ? parseYaml(t) : JSON.parse(t)) as Record<string, unknown>;
  } else {
    const { sqlite, db } = openDb(config.DATABASE_PATH);
    runMigrations(db);
    p = getProject(db, values.project) as unknown as Record<string, unknown> | undefined;
    sqlite.close();
  }
  if (!p) throw new Error(t.common.projectNotFound(values.project));
  projectId = String(p.id ?? values.project);
  projectContext = [`Nom : ${p.name}`, `Pitch : ${p.pitch}`, p.targetAudience ? `Cible visée : ${p.targetAudience}` : ""].filter(Boolean).join("\n");
}

const engine = assistantEngine(config, { profile: values.profile });
const meta = await proposeModule(engine, {
  ...(values.draft && { draftId: values.draft }),
  description: values.description ?? "",
  ...(values.id && { moduleId: values.id }),
  socle: values.socle!,
  ...(projectId && { projectId }),
  ...(projectContext && { projectContext }),
  // Recherche de sources : seulement avec un fournisseur qui a les outils web (claude-cli aujourd'hui)
  research: !values["no-research"] && capabilitiesOf(engine.backend).webTools,
  log: (m) => console.log(m),
});
const u = meta.usage;
console.log(`\n${t.common.draftStatus(meta.id, meta.status, meta.progress)}`);
if (meta.error) console.log(t.common.error(meta.error));
if (u) console.log(t.modulePropose.usageLine(u.calls, u.inputTokens, u.outputTokens, (u.durationMs / 1000).toFixed(0)));
for (const n of meta.notes) console.log(`- ${n}`);
process.exitCode = meta.status === "ready" ? 0 : 1;
