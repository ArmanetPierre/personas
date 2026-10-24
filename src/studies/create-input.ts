import type { Db } from "../db/client";
import type { Pack } from "../personas/pack";
import { createProject, getProject, readProjectFile, type ProjectExtra } from "./project";
import { rolePopulations, type CreateStudyInput, type PopulationInput } from "./study";
import { PROTOCOL_VERSION, type ProtocolVersion } from "./protocols/concept-price";
import { existsSync } from "node:fs";

/** Options de `study:create` et `study:estimate` qui décrivent les populations. */
export interface PopulationArgs {
  project: string;
  n?: string | undefined;
  seed?: string | undefined;
  quotas?: string | undefined;
  population?: string | undefined;
  "control-population"?: string | undefined;
  "control-n"?: string | undefined;
  "control-quotas"?: string | undefined;
  "same-sample-as"?: string | undefined;
  "same-sample-group"?: string | undefined;
  "role-n"?: string | undefined;
  name?: string | undefined;
  protocol?: string | undefined;
  force?: boolean | undefined;
}

export interface CreateInputMessages {
  projectNotFound: (id: string) => string;
  nRequired: string;
  sizesRequired: string;
  loaded?: (id: string, file: string) => void;
}

/**
 * Entrée de `createStudy` à partir des options de la CLI (cible ou rôles du projet, packs, même
 * échantillon). Un fichier projet est créé ou mis à jour (`--project <fichier>`), comme avant.
 */
export function createInputFromArgs(
  db: Db,
  pack: Pack,
  values: PopulationArgs,
  engine: { backend: string; model: string; engine?: CreateStudyInput["engine"] },
  msg: CreateInputMessages,
): CreateStudyInput {
  let projectId = values.project;
  if (/\.(json|ya?ml)$/i.test(projectId) && existsSync(projectId)) {
    const p = createProject(db, readProjectFile(projectId), { sourceFile: projectId, update: true });
    msg.loaded?.(p.id, projectId);
    projectId = p.id;
  }
  const project = getProject(db, projectId);
  if (!project) throw new Error(msg.projectNotFound(projectId));
  const targeting = project.extra as ProjectExtra;
  const useRoles = !!targeting.roles?.length && !values.population && !values["control-population"] && !values["same-sample-as"];
  const roleN = Object.fromEntries(
    (values["role-n"] ?? "")
      .split(",")
      .filter(Boolean)
      .map((kv) => {
        const [k, v] = kv.split("=");
        return [k!.trim(), Number(v)];
      }),
  );
  const useTargeting = !useRoles && !!targeting.target && !values.population && !values["control-population"] && !values["same-sample-as"];
  if (!useRoles && !useTargeting && !values.n && !values["same-sample-as"]) throw new Error(msg.nRequired);
  const parseQuotas = (q?: string) => (q ? (JSON.parse(q) as Record<string, Record<string, number>>) : undefined);
  const targetN = Number(values.n ?? targeting.target?.n ?? NaN);
  const controlN = Number(values["control-n"] ?? targeting.control?.n ?? NaN);
  const populations: PopulationInput[] | undefined = useRoles
    ? rolePopulations(project, values.n ? Object.fromEntries(targeting.roles!.map((r) => [r.id, Number(values.n)])) : roleN)
    : useTargeting
      ? [
          { group: "target", n: targetN, target: targeting.target!, ...(values.quotas && { quotas: parseQuotas(values.quotas)! }) },
          ...(targeting.control ? [{ group: "control", n: controlN, target: targeting.control, ...(values["control-quotas"] && { quotas: parseQuotas(values["control-quotas"])! }) }] : []),
        ]
      : values.population || values["control-population"]
        ? [
            { group: "target", packVersion: values.population ?? pack.manifest.version, n: Number(values.n), ...(values.quotas && { quotas: parseQuotas(values.quotas)! }) },
            ...(values["control-population"]
              ? [{ group: "control", packVersion: values["control-population"], n: Number(values["control-n"] ?? NaN), ...(values["control-quotas"] && { quotas: parseQuotas(values["control-quotas"])! }) }]
              : []),
          ]
        : undefined;
  if (populations?.some((p) => !Number.isInteger(p.n) || p.n < 1)) throw new Error(msg.sizesRequired);
  return {
    projectId,
    ...(populations && !values["same-sample-as"] && { populations }),
    ...(values.n && !useTargeting && !useRoles && { n: Number(values.n) }),
    seed: Number(values.seed ?? 7),
    backend: engine.backend,
    model: engine.model,
    ...(engine.engine && { engine: engine.engine }),
    ...(values.quotas && { quotas: JSON.parse(values.quotas) as Record<string, Record<string, number>> }),
    ...(values["same-sample-as"] && { sameSampleAs: values["same-sample-as"] }),
    ...(values["same-sample-group"] && { sameSampleGroup: values["same-sample-group"] }),
    ...(values.name && { name: values.name }),
    protocolVersion: (values.protocol ?? PROTOCOL_VERSION) as ProtocolVersion,
    force: values.force ?? false,
  };
}
