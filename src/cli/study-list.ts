import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { listStudies } from "../studies/store";
import { t } from "./i18n";

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const rows = listStudies(db);
  if (!rows.length) console.log(t.studyList.none);
  for (const s of rows) {
    console.log(
      `${s.id}  ${s.status.padEnd(9)} ${String(s.progressDone).padStart(4)}/${String(s.sampleSize).padEnd(4)} ${s.backend}/${s.model}  ${s.name}` +
        (s.sampleFromStudyId ? t.studyList.sampleOf(s.sampleFromStudyId) : "") +
        (s.error ? `\n    ${s.error.slice(0, 200)}` : ""),
    );
  }
} finally {
  sqlite.close();
}
