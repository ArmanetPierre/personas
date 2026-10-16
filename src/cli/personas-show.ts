import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { formatPersona } from "../personas/describe";
import { loadPack } from "../personas/pack";
import { getPersona, samplePersonas } from "../personas/store";
import { t } from "./i18n";

/** Affiche des personas lisibles en français. */

const { values } = parseArgs({
  options: {
    sample: { type: "string" },
    id: { type: "string", multiple: true },
    all: { type: "boolean", default: false },
    salt: { type: "string" },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || (!values.sample && !values.id)) {
  console.log(t.personasShow.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  let rows;
  if (values.id) {
    rows = values.id.map((id) => {
      const p = getPersona(db, id);
      if (!p) console.error(t.personasShow.notFound(id));
      return p;
    }).filter((p) => p !== undefined);
  } else {
    const salt = values.salt !== undefined ? Number(values.salt) : Date.now() % 100_000;
    rows = samplePersonas(db, Number(values.sample), { withNarrative: !values.all, salt, packVersion: pack.manifest.version });
    if (!rows.length) console.error(values.all ? t.personasShow.emptyBase : t.personasShow.noNarrative);
    else console.log(t.personasShow.sample(salt));
  }
  for (const p of rows) console.log(`\n${formatPersona(pack, p)}\n`);
} finally {
  sqlite.close();
}
