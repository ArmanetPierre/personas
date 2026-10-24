import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { drawPersonas } from "../personas/sampler";
import { countPersonas, deleteDraw, insertPersonas } from "../personas/store";
import { errorText, t } from "./i18n";

/** Tire les attributs des personas (sans LLM) et les insère en base. */

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "1000" },
    seed: { type: "string", default: "42" },
    pack: { type: "string", default: "fr" },
    reset: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(t.personasGenerate.usage);
  process.exit(0);
}

const count = Number(values.count);
const seed = Number(values.seed);
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(seed)) {
  console.error(t.personasGenerate.badArgs);
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const version = pack.manifest.version;
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const existing = countPersonas(db, { packVersion: version, seed });
  if (existing > 0 && values.reset) {
    const removed = deleteDraw(db, version, seed);
    console.log(t.personasGenerate.reset(removed, version, seed));
  } else if (existing === count) {
    console.log(t.personasGenerate.alreadyDone(existing, version, seed));
    process.exit(0);
  } else if (existing > count) {
    console.error(t.personasGenerate.tooMany(existing, version, seed, count));
    process.exit(1);
  }
  const start = values.reset ? 0 : existing;
  const t0 = performance.now();
  const rows = drawPersonas(pack, seed, count - start, start);
  insertPersonas(db, rows);
  const total = countPersonas(db, { packVersion: version, seed });
  console.log(t.personasGenerate.done(rows.length, start, version, seed, Math.round(performance.now() - t0), total));
  console.log(t.personasGenerate.next);
} catch (err) {
  console.error(t.personasGenerate.failed(errorText(err)));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
