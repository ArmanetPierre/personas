import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { formatProjectPrice } from "../studies/price-model";
import { listProjects } from "../studies/project";
import { t } from "./i18n";

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const rows = listProjects(db);
  if (!rows.length) console.log(t.projectList.none);
  for (const p of rows) {
    console.log(t.projectList.row(p.id, p.name, formatProjectPrice(p), p.createdAt.slice(0, 16)));
  }
} finally {
  sqlite.close();
}
