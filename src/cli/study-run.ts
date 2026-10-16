import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { getEngine, type BackendName } from "../engine";
import { loadPack } from "../personas/pack";
import { ensureNarratives } from "../population/narratives";
import { packResolver } from "../studies/packs";
import { runStudy } from "../studies/run";
import { findStudy } from "../studies/store";
import { errorText, t } from "./i18n";

/** Exécute (ou reprend) une étude : ne traite que les réponses manquantes. */

const { values } = parseArgs({
  options: {
    study: { type: "string" },
    concurrency: { type: "string" },
    "no-narrate": { type: "boolean", default: false },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.study) {
  console.log(t.studyRun.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const baseConfig = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(baseConfig.DATABASE_PATH);
try {
  runMigrations(db);
  const study = findStudy(db, values.study);
  if (study.backend !== "claude-cli" && study.backend !== "ollama") throw new Error(t.studyRun.backendRefused(study.backend));
  const config = study.backend === "ollama" ? { ...baseConfig, OLLAMA_MODEL: study.model } : { ...baseConfig, CLAUDE_CLI_MODEL: study.model };
  const engine = getEngine(study.backend as BackendName, config);
  const avail = await engine.backend.checkAvailability();
  if (!avail.ok) throw new Error(t.studyRun.unavailable(study.backend, errorText(avail.detail), avail.hint && errorText(avail.hint)));

  console.log(t.studyRun.header(study.id, study.name));
  console.log(t.studyRun.engine(study.backend, study.model, engine.backend.concurrency));
  // Récits manquants de l'échantillon, écrits avant l'étude (reprenable ; claude-cli, jamais l'API payante)
  if (!values["no-narrate"]) {
    const r = await ensureNarratives(db, study.personaIds, {
      packOf: packResolver(pack),
      engine: getEngine("claude-cli", baseConfig),
      log: (m) => console.log(`  ${m}`),
    });
    if (r.reused || r.written || r.missing.length || r.aborted) {
      console.log(t.studyRun.narratives(r));
    }
    if (r.aborted) throw new Error(t.studyRun.narrativesAborted(r.aborted, study.id));
  }
  const res = await runStudy(db, engine, pack, study, {
    log: (m) => console.log(m),
    ...(values.concurrency && { concurrency: Number(values.concurrency) }),
  });
  const u = res.usage;
  console.log(t.studyRun.written(res.written, (res.durationMs / 1000).toFixed(0), res.alreadyDone, res.total));
  if (res.written) {
    console.log(t.studyRun.tokens(u.inputTokens, u.cacheReadTokens ?? 0, u.outputTokens, (res.durationMs / res.written / 1000).toFixed(1), u.costUsd));
  }
  if (res.stoppedForUsageLimit) {
    console.log(t.studyRun.quota(res.stoppedForUsageLimit.slice(0, 300)));
    console.log(t.studyRun.quotaResume(study.id));
    process.exitCode = 3;
  } else if (res.aborted) {
    console.log(t.studyRun.aborted(res.aborted, study.id));
    process.exitCode = 1;
  } else if (res.failed.length) {
    console.log(t.studyRun.failed(res.failed.length, study.id));
    process.exitCode = 1;
  } else {
    console.log(t.studyRun.complete(study.id));
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
