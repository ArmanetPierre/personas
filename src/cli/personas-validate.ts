import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { resolveModules } from "../modules/registry";
import { drawPersonas } from "../personas/sampler";
import { allPersonas } from "../personas/store";
import { computeMargins, plausibilityChecks } from "../personas/validate";
import { t } from "./i18n";
import { formatValidationPlausibility, formatValidationReports } from "./validate-report";

/** Compare les marges de la base aux tables cibles du pack ; code de sortie 1 au-delà des seuils. */

const { values } = parseArgs({
  options: {
    pack: { type: "string", default: "fr" },
    seed: { type: "string" },
    modules: { type: "string" },
    virtual: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(t.personasValidate.usage);
  process.exit(0);
}

loadDotEnv();
const config = loadConfig();
const basePack = loadPack(values.pack);
// Modules appliqués par la ligne de commande (socle v2) : la validation porte sur la population générale.
const pack = values.modules ? { ...basePack, modules: resolveModules(values.modules.split(",").map((x) => x.trim()), basePack.socle) } : basePack;
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const rows = values.virtual
    ? drawPersonas(pack, Number(values.seed ?? 42), Number(values.virtual)).map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null }))
    : allPersonas(db, {
        packVersion: pack.manifest.version,
        ...(values.seed !== undefined && { seed: Number(values.seed) }),
      });
  if (!rows.length) {
    console.error(t.personasValidate.none(pack.manifest.version));
    process.exit(1);
  }
  const reports = computeMargins(pack, rows);
  console.log(t.personasValidate.header(pack.manifest.version, pack.modules.ordered.map((m) => m.def.id).join(", "), rows.length, !!values.virtual));
  console.log(formatValidationReports(reports, t.personasValidate.report));
  const plaus = plausibilityChecks(pack, rows);
  if (plaus.length) console.log(formatValidationPlausibility(plaus, t.personasValidate.report));
  process.exitCode = reports.every((r) => r.pass) && plaus.every((c) => c.pass) ? 0 : 1;
} finally {
  sqlite.close();
}
