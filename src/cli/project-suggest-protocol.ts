import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { loadConfig, loadDotEnv } from "../config";
import type { Project } from "../db/schema";
import { openDb, runMigrations } from "../db/client";
import { assistantEngine } from "../engine/select";
import { getProject, priceColumns, readProjectFile, slugify } from "../studies/project";
import { gatherObjections, suggestProtocol } from "../studies/protocol-suggest";
import { errorText, t } from "./i18n";

/**
 * Propose un bloc `protocol` pour un projet (claude-cli, sans outils) et l'écrit dans un fichier
 * de proposition. Rien n'est appliqué : l'utilisateur relit, puis copie le bloc dans le fichier projet
 * (`protocol:`) et relance `project:create -- --file … --update`.
 */

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    project: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.project) {
  console.log(t.projectSuggestProtocol.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  let project: Project | undefined;
  if (existsSync(values.project)) {
    const f = readProjectFile(values.project);
    const id = f.id ?? slugify(f.name);
    const cols = priceColumns(f);
    project = getProject(db, id) ?? ({
      id, name: f.name, pitch: f.pitch, targetAudience: f.targetAudience ?? null, businessModel: f.businessModel ?? null,
      priceEur: cols.priceEur, pricePeriod: cols.pricePeriod, freeOffer: cols.freeOffer, competitors: f.competitors,
      alternatives: f.alternatives, extra: cols.extra, createdAt: "", updatedAt: "",
    } as Project);
  } else project = getProject(db, values.project);
  if (!project) throw new Error(t.common.projectNotFound(values.project));

  const evidence = gatherObjections(db, project.id);
  console.log(t.projectSuggestProtocol.header(project.id, project.name));
  console.log(evidence ? t.projectSuggestProtocol.evidence(evidence.respondents, evidence.studies.join(", ")) : t.projectSuggestProtocol.noEvidence);
  const engine = assistantEngine(config, { profile: values.profile, db });
  const r = await suggestProtocol(engine, project, evidence);
  const out = values.out ?? join(dirname(resolve(config.DATABASE_PATH)), "proposals", `${project.id}-protocol.json`);
  mkdirSync(dirname(out), { recursive: true });
  const proposal = { project: project.id, generatedAt: new Date().toISOString(), model: r.model, evidence, fixes: r.fixes, protocol: r.protocol };
  writeFileSync(out, JSON.stringify(proposal, null, 2));
  writeFileSync(out.replace(/\.json$/, ".yaml"), stringify({ protocol: r.protocol }, { lineWidth: 0 }));
  const p = r.protocol;
  console.log(t.projectSuggestProtocol.productType(p.productType));
  console.log(t.projectSuggestProtocol.behaviors);
  for (const b of p.behaviors ?? []) console.log(`  ${b.code.padEnd(20)} [${b.level}] ${b.label} — ${b.description}`);
  console.log(t.projectSuggestProtocol.objections);
  for (const o of p.objections ?? []) console.log(`  ${o.code.padEnd(24)} [${o.canonical}] ${o.label} — ${o.description}`);
  console.log(t.projectSuggestProtocol.relevance);
  for (const x of p.relevance ?? []) console.log(`  ${x.code.padEnd(20)} [${x.canonical}] ${x.label} — ${x.description}`);
  console.log(t.projectSuggestProtocol.rationale(r.rationale));
  if (r.fixes.length) console.log(t.projectSuggestProtocol.fixes(r.fixes));
  console.log(t.projectSuggestProtocol.proposal(out, out.replace(/\.json$/, ".yaml")));
  console.log(t.projectSuggestProtocol.tokens(r.usage.inputTokens, r.usage.outputTokens));
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
