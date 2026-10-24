import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { formatProjectPrice, formatProjectTier } from "../studies/price-model";
import { createProject, priceTiersFor, readProjectFile } from "../studies/project";
import { errorText, t } from "./i18n";

/** Crée (ou met à jour avec --update) un projet à partir d'un fichier JSON ou YAML. */

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    update: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.file) {
  console.log(t.projectCreate.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const file = readProjectFile(values.file);
  const project = createProject(db, file, { sourceFile: resolve(values.file), update: values.update });
  console.log(t.projectCreate.saved(values.update!, project.id));
  console.log(`  ${project.name} — ${formatProjectPrice(project)}`);
  console.log(t.projectCreate.tiers(priceTiersFor(project).map((x) => formatProjectTier(project, x)).join(", ")));
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
