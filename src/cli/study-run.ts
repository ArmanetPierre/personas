import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { isBudgetExceeded, UNKNOWN_COST_PREFIX } from "../engine/budget";
import { engineForProfile, engineInfoOf, guardedEngine, narrativeProfile, profileForStudy, studyAcceptsUnknownCost, studyEngineInfo, type StudyEngineRecord } from "../engine/select";
import { loadPack } from "../personas/pack";
import { ensureNarratives } from "../population/narratives";
import { estimateExistingStudy, formatEstimate } from "../studies/cost";
import { packResolver } from "../studies/packs";
import { runStudy } from "../studies/run";
import { findStudy, updateStudy } from "../studies/store";
import { errorText, lang, t } from "./i18n";

/**
 * Exécute (ou reprend) une étude : ne traite que les réponses manquantes. Moteur : le profil enregistré
 * dans l'étude (études antérieures aux profils : claude-cli ou ollama, réglés par l'environnement, comme
 * avant). Plafond de dépense du profil : l'étude passe en pause, et reprend ici après relèvement.
 */

const { values } = parseArgs({
  options: {
    study: { type: "string" },
    concurrency: { type: "string" },
    profile: { type: "string" },
    "no-narrate": { type: "boolean", default: false },
    "accept-unknown-cost": { type: "boolean", default: false },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.study) {
  console.log(t.studyRun.usage);
  console.log(t.studyRun.usageMore);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const study = findStudy(db, values.study);
  if (study.backend === "anthropic-api") throw new Error(t.studyRun.backendRefused(study.backend));
  const profile = profileForStudy(study, config, { profile: values.profile });
  const base = engineForProfile(profile, config);
  // Coût inconnu accepté à la création, ou ici (--accept-unknown-cost, noté dans l'étude pour les reprises)
  let acceptUnknownCost = studyAcceptsUnknownCost(study);
  if (values["accept-unknown-cost"] && !acceptUnknownCost) {
    acceptUnknownCost = true;
    const engineRecord: StudyEngineRecord = { ...(studyEngineInfo(study) ?? engineInfoOf(profile)), acceptUnknownCost: true };
    updateStudy(db, study.id, { extra: { ...(study.extra ?? {}), engine: engineRecord } });
  }
  const engine = guardedEngine(db, profile, config, { studyId: study.id, base, acceptUnknownCost });
  const avail = await engine.backend.checkAvailability();
  if (!avail.ok) throw new Error(t.studyRun.unavailable(study.backend, errorText(avail.detail), avail.hint && errorText(avail.hint)));

  console.log(t.studyRun.header(study.id, study.name));
  console.log(t.studyRun.engine(study.backend, study.model, engine.backend.concurrency));
  if (values.profile || !["claude-cli", "ollama"].includes(profile.name)) console.log(t.studyRun.profile(profile.name));
  if (engine.budget?.limits.perStudyUsd !== undefined || engine.budget?.pricing.kind === "paid") {
    console.log(t.studyRun.estimate(formatEstimate(estimateExistingStudy(db, study, profile, { concurrency: engine.backend.concurrency }), lang === "en")));
  }
  // Récits manquants de l'échantillon, écrits avant l'étude (reprenable). Sans profil configuré : claude-cli, comme avant.
  if (!values["no-narrate"]) {
    const narr = narrativeProfile(config, { studyProfile: profile });
    const narrEngine = narr.name === profile.name ? engine : guardedEngine(db, narr, config, { studyId: study.id });
    const r = await ensureNarratives(db, study.personaIds, {
      packOf: packResolver(pack),
      engine: narrEngine,
      log: (m) => console.log(`  ${m}`),
    });
    if (r.reused || r.written || r.missing.length || r.aborted) {
      console.log(t.studyRun.narratives(r));
    }
    if (r.aborted && isBudgetExceeded(r.aborted)) {
      updateStudy(db, study.id, { status: "paused", error: r.aborted.slice(0, 500) });
      console.log(t.studyRun.narrativesBudget(r.aborted, study.id));
      sqlite.close();
      process.exit(3);
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
  if (res.stoppedForBudget?.startsWith(UNKNOWN_COST_PREFIX)) {
    console.log(t.studyRun.unknownCostBlocked(errorText(res.stoppedForBudget.slice(0, 600))));
    process.exitCode = 3;
  } else if (res.stoppedForBudget) {
    console.log(t.studyRun.budget(res.stoppedForBudget.slice(0, 400)));
    console.log(t.studyRun.budgetResume(study.id));
    process.exitCode = 3;
  } else if (res.stoppedForUsageLimit) {
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
