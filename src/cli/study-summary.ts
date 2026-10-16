import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { getProject } from "../studies/project";
import { QUESTION_KEY } from "../studies/protocols/concept-price";
import { findStudy, personasByIds, repeatStudies, studyResponses } from "../studies/store";
import { formatSummary, summarize } from "../studies/summary";
import { errorText, t } from "./i18n";

/** Agrège les réponses d'une étude : console + JSON (data/summaries/<étude>.json). */

const { values } = parseArgs({
  options: {
    study: { type: "string" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.study) {
  console.log(t.studySummary.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const study = findStudy(db, values.study);
  const project = getProject(db, study.projectId);
  if (!project) throw new Error(t.common.projectNotFound(study.projectId));
  const rows = studyResponses(db, study.id, QUESTION_KEY);
  if (!rows.length) throw new Error(t.studySummary.noResponses(study.id));
  const personas = new Map(personasByIds(db, rows.map((r) => r.personaId)).map((p) => [p.id, p]));
  const summary = summarize(pack, study, project, rows, personas, undefined, { repeats: repeatStudies(db, study) });
  const out = values.out ?? join(dirname(resolve(config.DATABASE_PATH)), "summaries", `${study.id}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2));
  if (values.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`${formatSummary(summary)}\n\n${t.common.json(out)}`);
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
