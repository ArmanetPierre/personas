import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { BACKEND_NAMES, getEngine, type BackendName } from "../engine";
import { chooseProfile, guardedEngine } from "../engine/select";
import { formatFrequencyReport, frequencyReport, narratePersonas } from "../personas/narrate";
import { loadPack } from "../personas/pack";
import { allPersonas, personasToNarrate, saveNarrative } from "../personas/store";
import { t } from "./i18n";

/**
 * Écrit les récits des personas qui n'en ont pas encore (reprenable).
 * Backend par défaut : claude-cli (abonnement Max). Jamais d'API payante.
 */

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    "batch-size": { type: "string", default: "10" },
    backend: { type: "string" },
    profile: { type: "string" },
    pack: { type: "string", default: "fr" },
    regenerate: { type: "boolean", default: false },
    before: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(t.personasNarrate.usage);
  process.exit(0);
}
if (values.backend !== undefined && (!(BACKEND_NAMES as readonly string[]).includes(values.backend) || values.backend === "anthropic-api")) {
  console.error(t.personasNarrate.backendRefused(values.backend));
  process.exit(2);
}

let before: string | undefined;
if (values.regenerate) {
  const d = values.before ? new Date(values.before) : undefined;
  if (!d || Number.isNaN(d.getTime())) {
    console.error(t.personasNarrate.regenerateNeedsBefore);
    process.exit(2);
  }
  before = d.toISOString();
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const limit = values.limit !== undefined ? Number(values.limit) : undefined;
  const todo = personasToNarrate(db, {
    packVersion: pack.manifest.version,
    ...(limit !== undefined && { limit }),
    ...(before && { regenerateBefore: before }),
  });
  if (!todo.length) {
    console.log(t.personasNarrate.allDone);
    process.exit(0);
  }
  // --backend historique (claude-cli, ollama), sinon le profil (--profile, PERSONAS_PROFILE, actif, puis claude-cli)
  const engine = values.backend ? getEngine(values.backend as BackendName, config) : guardedEngine(db, chooseProfile(config, { profile: values.profile }), config);
  const batchSize = Number(values["batch-size"]);
  console.log(t.personasNarrate.start(todo.length, batchSize, engine.backend.name, engine.backend.model, engine.backend.concurrency));
  const written: string[] = [];
  const res = await narratePersonas(engine, pack, todo, {
    batchSize,
    save: (id, narrative, meta) => {
      saveNarrative(db, id, narrative, meta);
      written.push(narrative);
    },
    log: (m) => console.log(m),
  });
  const u = res.usage;
  console.log(t.personasNarrate.summary(res.written, todo.length, (res.durationMs / 1000).toFixed(0), res.batches, res.failedBatches, res.rejected));
  console.log(t.personasNarrate.tokens(u.inputTokens, u.cacheReadTokens ?? 0, u.outputTokens, u.costUsd));
  if (res.written) {
    const per = res.durationMs / res.written;
    console.log(t.personasNarrate.average((per / 1000).toFixed(1), Math.round(u.outputTokens / res.written)));
  }
  if (written.length) console.log(`\n${formatFrequencyReport(frequencyReport(written))}`);
  const base = allPersonas(db, { packVersion: pack.manifest.version }).flatMap((p) => (p.narrative ? [p.narrative] : []));
  if (base.length > written.length) {
    const r = frequencyReport(base, 4, 0);
    console.log(t.personasNarrate.wholeBase(base.length) + Object.entries(r.tracked).map(([k, v]) => `${k} ${v}`).join(", "));
  }
  if (res.aborted) {
    console.log(t.personasNarrate.aborted(res.aborted));
    process.exitCode = 3;
  }
  if (res.stillMissing.size) {
    console.log(t.personasNarrate.stillMissing(res.stillMissing.size));
    const shown = [...res.stillMissing].slice(0, 30);
    for (const [id, issues] of shown) console.log(t.personasNarrate.missingLine(id, issues));
    if (res.stillMissing.size > shown.length) console.log(t.personasNarrate.more(res.stillMissing.size - shown.length));
    process.exitCode ||= 1;
  }
} finally {
  sqlite.close();
}
