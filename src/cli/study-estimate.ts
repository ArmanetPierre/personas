import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { chooseProfile, engineInfoOf, profileForStudy } from "../engine/select";
import { loadPack } from "../personas/pack";
import { dryRun, estimateExistingStudy, estimateNewStudy, formatEstimate } from "../studies/cost";
import { createInputFromArgs } from "../studies/create-input";
import { findStudy } from "../studies/store";
import { errorText, lang, t } from "./i18n";

/**
 * Estimation du coût d'une étude avant lancement (docs/plateforme.md § 7.3) : création simulée (aucune
 * écriture), aucun appel au modèle. `--study` : reste d'une étude existante.
 */

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    study: { type: "string" },
    n: { type: "string" },
    seed: { type: "string", default: "7" },
    backend: { type: "string" },
    profile: { type: "string" },
    model: { type: "string" },
    quotas: { type: "string" },
    population: { type: "string" },
    "control-population": { type: "string" },
    "control-n": { type: "string" },
    "control-quotas": { type: "string" },
    "same-sample-as": { type: "string" },
    "same-sample-group": { type: "string" },
    "role-n": { type: "string" },
    pack: { type: "string", default: "fr" },
    protocol: { type: "string", default: "4" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || (!values.project && !values.study)) {
  console.log(t.studyEstimate.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  let estimate;
  if (values.study) {
    const study = findStudy(db, values.study);
    estimate = estimateExistingStudy(db, study, profileForStudy(study, config, { profile: values.profile }));
  } else {
    const profile = chooseProfile(config, { profile: values.profile, backend: values.backend, model: values.model });
    // Estimation seulement : le garde-fou de ton s'appliquera à la création (study:create)
    // Tout est simulé (un fichier projet n'est pas enregistré en base)
    estimate = dryRun(db, () => {
      const input = createInputFromArgs(
        db,
        pack,
        { ...values, project: values.project!, force: true },
        { backend: profile.provider, model: profile.model, engine: engineInfoOf(profile) },
        { projectNotFound: t.common.projectNotFound, nRequired: t.studyCreate.nRequired, sizesRequired: t.studyCreate.sizesRequired },
      );
      return estimateNewStudy(db, pack, input, profile);
    });
  }
  if (values.json) console.log(JSON.stringify(estimate, null, 2));
  else for (const l of formatEstimate(estimate, lang === "en")) console.log(l);
  if (estimate.requiresConfirmation) process.exitCode = 4;
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
