import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { migratePackToModules } from "../modules/migrate";
import { loadPack } from "../personas/pack";
import { t } from "./i18n";

/** Migration de données vers le format modules (voir src/modules/migrate.ts). Idempotente. */

const { values } = parseArgs({
  options: {
    pack: { type: "string", default: "fr-tech-founders" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(t.personasMigrateModules.usage);
  process.exit(0);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
if (!pack.modules.ordered.length) {
  console.log(t.personasMigrateModules.noModules(pack.manifest.version));
  process.exit(0);
}
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const r = migratePackToModules(db, pack, { dryRun: values["dry-run"] });
  console.log(t.personasMigrateModules.result(pack.manifest.version, r.total, r.migrated, values["dry-run"]!, r.already, r.mismatches.length));
  for (const m of r.mismatches.slice(0, 20)) console.log(`- ${m}`);
  if (r.mismatches.length) process.exitCode = 1;
} finally {
  sqlite.close();
}
