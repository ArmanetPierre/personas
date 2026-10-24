import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { ensureNarratives } from "../population/narratives";
import { packResolver } from "../studies/packs";
import { createStudy } from "../studies/study";
import { PROTOCOL_VERSIONS } from "../studies/protocols/concept-price";
import { createInputFromArgs } from "../studies/create-input";
import { estimateNewStudy, formatEstimate } from "../studies/cost";
import { builtinProfiles } from "../engine/profiles";
import { chooseProfile, engineInfoOf, guardedEngine, narrativeProfile } from "../engine/select";
import { errorText, lang, t } from "./i18n";

/**
 * Crée une étude concept + prix et fige son échantillon. Moteur : `--profile`, sinon `PERSONAS_PROFILE`,
 * le profil actif, puis claude-cli (sans profil configuré : comportement d'avant les profils). L'estimation
 * du coût est affichée avant la création.
 */

const { values } = parseArgs({
  options: {
    project: { type: "string" },
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
    name: { type: "string" },
    pack: { type: "string", default: "fr" },
    "no-narrate": { type: "boolean", default: false },
    "narrate-backend": { type: "string" },
    protocol: { type: "string", default: "4" },
    "role-n": { type: "string" },
    force: { type: "boolean", default: false },
    "accept-unknown-cost": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.project) {
  console.log(t.studyCreate.usage);
  process.exit(values.help ? 0 : 2);
}
if (!(PROTOCOL_VERSIONS as readonly string[]).includes(values.protocol!)) {
  console.error(t.studyCreate.unknownProtocol(values.protocol!));
  process.exit(2);
}
if (values.backend !== undefined && values.backend !== "claude-cli" && values.backend !== "ollama") {
  console.error(t.studyCreate.backendRefused(values.backend));
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
/** Refus après l'estimation (coût inconnu sans --accept-unknown-cost) : annule la transaction de création. */
const refused = new Error("study create refused");
try {
  runMigrations(db);
  const profile = chooseProfile(config, { profile: values.profile, backend: values.backend, model: values.model });
  // Projet (fichier --project), estimation et étude dans une seule transaction : un refus ou une erreur avant
  // la création de l'étude n'enregistre rien, pas même le projet (les récits viennent après, hors transaction).
  let created: { created: ReturnType<typeof createStudy>; accepted: boolean } | null = null;
  try {
    created = sqlite.transaction(() => {
      const input = createInputFromArgs(
        db,
        pack,
        { ...values, project: values.project! },
        { backend: profile.provider, model: profile.model, engine: engineInfoOf(profile) },
        { projectNotFound: t.common.projectNotFound, nRequired: t.studyCreate.nRequired, sizesRequired: t.studyCreate.sizesRequired, loaded: (id, file) => console.log(t.studyCreate.loaded(id, file)) },
      );
      // Estimation avant création (création simulée, sans écriture)
      const estimate = estimateNewStudy(db, pack, input, profile);
      console.log(t.studyRun.estimate(formatEstimate(estimate, lang === "en")));
      if (estimate.requiresConfirmation && !values["accept-unknown-cost"]) {
        console.error(t.studyCreate.unknownCost(profile.model));
        throw refused;
      }
      // Coût inconnu accepté : noté dans l'étude, le plafond comptera au prix prudent (BudgetGuard)
      const accepted = estimate.requiresConfirmation && values["accept-unknown-cost"] === true;
      return { created: createStudy(db, pack, accepted ? { ...input, engine: engineInfoOf(profile, { acceptUnknownCost: true }) } : input), accepted };
    })();
  } catch (err) {
    if (err !== refused) throw err;
    process.exitCode = 2;
  }
  if (created) {
    const { accepted } = created;
    const { study, shortfalls, notes } = created.created;
    if (accepted) console.log(t.studyCreate.unknownCostAccepted);
    console.log(t.studyCreate.created(study.id, study.name));
    for (const p of study.populations) console.log(t.studyCreate.population(p.group, p.n, p.packVersion, !!p.quotas));
    console.log(t.studyCreate.protocol(study.protocol, String(study.protocolVersion)));
    console.log(t.studyCreate.sample(study.sampleSize, study.seed, study.backend, study.model, study.sampleFromStudyId));
    console.log(t.studyCreate.engine(profile.name, profile.provider, profile.model));
    if (shortfalls.length) console.log(t.studyCreate.shortfalls(shortfalls));
    for (const n of notes) console.log(`  ${n}`);
    // Récits à la demande : seules les personas de l'échantillon qui n'en ont pas
    if (!values["no-narrate"]) {
      const legacy = values["narrate-backend"] ?? (values.backend ? "claude-cli" : undefined);
      if (legacy !== undefined && legacy !== "claude-cli" && legacy !== "ollama") throw new Error(t.studyCreate.narrateBackendRefused(legacy));
      const narr = legacy ? builtinProfiles(config).find((p) => p.name === legacy)! : narrativeProfile(config, { studyProfile: profile });
      const r = await ensureNarratives(db, study.personaIds, {
        packOf: packResolver(pack),
        engine: guardedEngine(db, narr, config, { studyId: study.id, ...(accepted && narr.name === profile.name && { acceptUnknownCost: true }) }),
        log: (m) => console.log(`  ${m}`),
      });
      console.log(t.studyCreate.narratives(r));
    }
    console.log(t.studyCreate.launch(study.id));
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
