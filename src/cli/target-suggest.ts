import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb } from "../db/client";
import { assistantEngine } from "../engine/select";
import type { ProjectInput } from "../population/preview";
import { suggestionPath, suggestTarget, writeSuggestion } from "../population/suggest";
import { getProject, readProjectFile } from "../studies/project";
import { errorText, numberLocale, t } from "./i18n";

/**
 * Assistant de cible : Claude (claude-cli, sans outil) propose les attributs qui conditionnent
 * l'usage, des variantes de filtre, des quotas et les modules manquants ; chaque variante valide est
 * prévisualisée. Rien n'est appliqué : la proposition est écrite à côté du projet.
 *
 *   npm run target:suggest -- --project <id | fichier> [--triage] [--n 200] [--seed 42] [--out fichier.yaml] [--json]
 */

const { values } = parseArgs({
  options: {
    profile: { type: "string" },
    project: { type: "string" },
    triage: { type: "boolean", default: false },
    "no-preview": { type: "boolean", default: false },
    n: { type: "string", default: "200" },
    seed: { type: "string", default: "42" },
    out: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.project) {
  console.log(t.targetSuggest.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const log = values.json ? (m: string) => console.error(m) : (m: string) => console.log(m);
try {
  const fromFile = existsSync(values.project);
  let project: ProjectInput;
  if (fromFile) project = readProjectFile(values.project);
  else {
    const { sqlite, db } = openDb(config.DATABASE_PATH);
    const row = getProject(db, values.project);
    sqlite.close();
    if (!row) throw new Error(t.common.projectNotFoundAnywhere(values.project));
    project = row;
  }
  const engine = assistantEngine(config, { profile: values.profile });
  const s = await suggestTarget(project, {
    engine,
    triage: values.triage,
    preview: !values["no-preview"],
    n: Number(values.n),
    seed: Number(values.seed),
    log,
  });
  const path = values.out ?? suggestionPath(fromFile ? values.project : null, s.project.id);
  writeSuggestion(s, path);
  if (values.json) console.log(JSON.stringify(s, null, 2));
  else {
    const m = t.targetSuggest;
    const pct = (x: number) => `${t.common.decimalComma ? (x * 100).toFixed(2).replace(".", ",") : (x * 100).toFixed(2)}${t.common.pct}`;
    console.log(m.header(s.project.name, s.model));
    console.log(s.analysis);
    console.log(m.usageConditions);
    for (const c of s.usageConditions) console.log(m.condition(c.condition, c.attribute, c.why));
    console.log(m.variants);
    for (const v of s.variants) {
      const p = v.preview;
      console.log(`\n## ${v.variant.label} (${v.variant.id})\n${v.variant.description}`);
      console.log(m.modulesFilter(v.target.modules.join(", "), v.target.eligibility));
      if (v.target.quotas) console.log(m.quotas(JSON.stringify(v.target.quotas)));
      for (const j of v.variant.justification) console.log(m.justification(j.criterion, j.why));
      if (v.errors.length) console.log(m.errors(v.errors));
      if (p) {
        console.log(m.eligibility(pct(p.eligibility.rate), pct(p.eligibility.ci[0]), pct(p.eligibility.ci[1]), p.eligibility.draws.toLocaleString(numberLocale)));
        if (p.triage) console.log(m.triage(p.triage.message));
      }
    }
    if (s.missingModules.length) {
      console.log(m.missingModules);
      for (const x of s.missingModules) console.log(m.missingModule(x.id, x.description, x.attributes, x.why));
    }
    for (const n of s.notes) console.log(m.note(n));
    console.log(m.claude(s.usage.calls, s.repairs, (s.ms / 1000).toFixed(0)));
    console.log(m.written(path));
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
}
