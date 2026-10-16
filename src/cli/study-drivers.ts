import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { formatDrivers } from "../studies/drivers";
import { getProject } from "../studies/project";
import { QUESTION_KEY } from "../studies/protocols/concept-price";
import { findStudy, personasByIds, studyResponses } from "../studies/store";
import { summarize } from "../studies/summary";
import { errorText, t } from "./i18n";

/** Analyse des facteurs d'engagement d'une étude : console (top N par niveau) et JSON complet. */

const { values } = parseArgs({
  options: {
    study: { type: "string" },
    top: { type: "string", default: "10" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.study) {
  console.log(t.studyDrivers.usage);
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
  if (!rows.length) throw new Error(t.common.noResponses(study.id));
  const personas = new Map(personasByIds(db, rows.map((r) => r.personaId)).map((p) => [p.id, p]));
  const d = summarize(pack, study, project, rows, personas).drivers!;
  const out = values.out ?? join(dirname(resolve(config.DATABASE_PATH)), "summaries", `${study.id}-drivers.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(d, null, 2));
  if (values.json) console.log(JSON.stringify(d, null, 2));
  else {
    console.log(t.studyDrivers.header(study.id, study.name, d.group, d.n));
    console.log(formatDrivers(d, Number(values.top)).join("\n"));
    console.log(`\n${t.common.json(out)}`);
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
