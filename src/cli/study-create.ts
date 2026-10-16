import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { existsSync } from "node:fs";
import { getEngine, type BackendName } from "../engine";
import { ensureNarratives } from "../population/narratives";
import { packResolver } from "../studies/packs";
import { createProject, getProject, readProjectFile, type ProjectExtra } from "../studies/project";
import { createStudy, rolePopulations } from "../studies/study";
import { errorText, t } from "./i18n";

/** Crée une étude concept + prix et fige son échantillon. */

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    n: { type: "string" },
    seed: { type: "string", default: "7" },
    backend: { type: "string", default: "claude-cli" },
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
    "narrate-backend": { type: "string", default: "claude-cli" },
    protocol: { type: "string", default: "3" },
    "role-n": { type: "string" },
    force: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.project) {
  console.log(t.studyCreate.usage);
  process.exit(values.help ? 0 : 2);
}
if (values.protocol !== "2" && values.protocol !== "3") {
  console.error(t.studyCreate.unknownProtocol(values.protocol!));
  process.exit(2);
}
if (values.backend !== "claude-cli" && values.backend !== "ollama") {
  console.error(t.studyCreate.backendRefused(values.backend!));
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  const model = values.model ?? (values.backend === "ollama" ? config.OLLAMA_MODEL : config.CLAUDE_CLI_MODEL);
  // --project : un fichier projet (créé ou mis à jour) ou l'id d'un projet existant
  let projectId = values.project!;
  if (/\.(json|ya?ml)$/i.test(projectId) && existsSync(projectId)) {
    const p = createProject(db, readProjectFile(projectId), { sourceFile: projectId, update: true });
    console.log(t.studyCreate.loaded(p.id, projectId));
    projectId = p.id;
  }
  const project = getProject(db, projectId);
  if (!project) throw new Error(t.common.projectNotFound(projectId));
  const targeting = project.extra as ProjectExtra;
  const useRoles = !!targeting.roles?.length && !values.population && !values["control-population"] && !values["same-sample-as"];
  const roleN = Object.fromEntries((values["role-n"] ?? "").split(",").filter(Boolean).map((kv) => {
    const [k, v] = kv.split("=");
    return [k!.trim(), Number(v)];
  }));
  const useTargeting = !useRoles && !!targeting.target && !values.population && !values["control-population"] && !values["same-sample-as"];
  if (!useRoles && !useTargeting && !values.n && !values["same-sample-as"]) throw new Error(t.studyCreate.nRequired);
  const parseQuotas = (q?: string) => (q ? (JSON.parse(q) as Record<string, Record<string, number>>) : undefined);
  const targetN = Number(values.n ?? targeting.target?.n ?? NaN);
  const controlN = Number(values["control-n"] ?? targeting.control?.n ?? NaN);
  const populations = useRoles
    ? rolePopulations(project, values.n ? Object.fromEntries(targeting.roles!.map((r) => [r.id, Number(values.n)])) : roleN)
    : useTargeting
    ? [
        { group: "target", n: targetN, target: targeting.target!, ...(values.quotas && { quotas: parseQuotas(values.quotas) }) },
        ...(targeting.control ? [{ group: "control", n: controlN, target: targeting.control, ...(values["control-quotas"] && { quotas: parseQuotas(values["control-quotas"]) }) }] : []),
      ]
    : values.population || values["control-population"]
      ? [
          { group: "target", packVersion: values.population ?? pack.manifest.version, n: Number(values.n), ...(values.quotas && { quotas: parseQuotas(values.quotas) }) },
          ...(values["control-population"]
            ? [{ group: "control", packVersion: values["control-population"], n: Number(values["control-n"] ?? NaN), ...(values["control-quotas"] && { quotas: parseQuotas(values["control-quotas"]) }) }]
            : []),
        ]
      : undefined;
  if (populations?.some((p) => !Number.isInteger(p.n) || p.n < 1)) throw new Error(t.studyCreate.sizesRequired);
  const { study, shortfalls, notes } = createStudy(db, pack, {
    projectId,
    ...(populations && !values["same-sample-as"] && { populations }),
    ...(values.n && !useTargeting && !useRoles && { n: Number(values.n) }),
    seed: Number(values.seed),
    backend: values.backend,
    model,
    ...(values.quotas && { quotas: JSON.parse(values.quotas) as Record<string, Record<string, number>> }),
    ...(values["same-sample-as"] && { sameSampleAs: values["same-sample-as"] }),
    ...(values["same-sample-group"] && { sameSampleGroup: values["same-sample-group"] }),
    ...(values.name && { name: values.name }),
    protocolVersion: values.protocol as "2" | "3",
    force: values.force!,
  });
  console.log(t.studyCreate.created(study.id, study.name));
  for (const p of study.populations) console.log(t.studyCreate.population(p.group, p.n, p.packVersion, !!p.quotas));
  console.log(t.studyCreate.protocol(study.protocol, String(study.protocolVersion)));
  console.log(t.studyCreate.sample(study.sampleSize, study.seed, study.backend, study.model, study.sampleFromStudyId));
  if (shortfalls.length) console.log(t.studyCreate.shortfalls(shortfalls));
  for (const n of notes) console.log(`  ${n}`);
  // Récits à la demande : seules les personas de l'échantillon qui n'en ont pas
  if (!values["no-narrate"]) {
    const backend = values["narrate-backend"]!;
    if (backend !== "claude-cli" && backend !== "ollama") throw new Error(t.studyCreate.narrateBackendRefused(backend));
    const r = await ensureNarratives(db, study.personaIds, {
      packOf: packResolver(pack),
      engine: getEngine(backend as BackendName, config),
      log: (m) => console.log(`  ${m}`),
    });
    console.log(t.studyCreate.narratives(r));
  }
  console.log(t.studyCreate.launch(study.id));
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
