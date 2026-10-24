import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { t } from "./i18n";

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const tables = sqlite
    .prepare("select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\' and name not like 'sqlite_%' order by name")
    .all() as Array<{ name: string }>;
  console.log(t.migrate.applied(config.DATABASE_PATH));
  console.log(t.migrate.tables(tables.map((x) => x.name).join(", ")));
} finally {
  sqlite.close();
}
