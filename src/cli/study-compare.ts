import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { compareSummaries, formatComparison } from "../studies/compare";
import { getProject } from "../studies/project";
import { QUESTION_KEY } from "../studies/protocols/concept-price";
import { findStudy, personasByIds, repeatStudies, studyResponses } from "../studies/store";
import { summarize } from "../studies/summary";
import { errorText, t } from "./i18n";

/** Compare plusieurs études (variantes d'une offre) ; la première sert de référence. */

const { values } = parseArgs({
  options: {
    studies: { type: "string" },
    group: { type: "string" },
    normalize: { type: "string" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.studies) {
  console.log(t.studyCompare.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const summaries = values.studies.split(",").map((raw) => {
    const study = findStudy(db, raw.trim());
    const project = getProject(db, study.projectId);
    if (!project) throw new Error(t.common.projectNotFound(study.projectId));
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    if (!rows.length) throw new Error(t.common.noResponses(study.id));
    const personas = new Map(personasByIds(db, rows.map((r) => r.personaId)).map((p) => [p.id, p]));
    return summarize(pack, study, project, rows, personas, undefined, { repeats: repeatStudies(db, study) });
  });
  if (values.normalize && values.normalize !== "monthly-eur") throw new Error(t.studyCompare.unknownNormalize(values.normalize));
  const comparison = compareSummaries(summaries, values.group, values.normalize ? { normalize: "monthly-eur" } : {});
  const out = values.out ?? join(dirname(resolve(config.DATABASE_PATH)), "summaries", `compare-${comparison.entries.map((e) => e.studyId).join("_")}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(comparison, null, 2));
  if (values.json) console.log(JSON.stringify(comparison, null, 2));
  else console.log(`${formatComparison(comparison)}\n\n${t.common.json(out)}`);
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
