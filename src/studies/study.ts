import type { Db } from "../db/client";
import { studies, type Study, type StudyEngineInfo, type StudyPopulation } from "../db/schema";
import { allPersonas } from "../personas/store";
import type { Pack } from "../personas/pack";
import { getProject, type ProjectExtra } from "./project";
import { studyAudience } from "./locale";
import { packManifest } from "./packs";
import { toneWarning, type ToneWarning } from "./pitch-tone";
import { hasV3Measures, PROTOCOL_ID, PROTOCOL_VERSION, PROTOCOL_VERSIONS, type ProtocolVersion } from "./protocols/concept-price";
import { drawSample, quotasSchema, type Quotas } from "./sampling";
import { findStudy, newStudyId } from "./store";
import { drawTarget, eligibilityStats, persistDrawn, prepareTarget, resolveSoclePack, type EligibilityStats, type TargetSpec } from "../population/target";
import type { DrawnPersona } from "../personas/sampler";
import { childProfiles, prepareChild, projectRoles, type RoleSpec } from "./roles";
import type { Project } from "../db/schema";

export const TARGET = "target";
export const CONTROL = "control";

export interface PopulationInput {
  group: string;
  /** Pack de personas (ex. fr-tech-founders-2026.1) ; par défaut le pack général. */
  packVersion?: string;
  n: number;
  quotas?: Quotas;
  /**
   * Population ciblée (phase 2a) : socle + modules + filtre d'éligibilité, tirée à la demande et mise
   * en cache en base. Remplace `packVersion` (voir src/population/target.ts).
   */
  target?: TargetSpec;
  /** Condition supplémentaire sur la persona tirée (rôle `payer_for_child` : un enfant du foyer éligible). */
  accept?: (p: DrawnPersona) => boolean;
}

/** Population enregistrée dans l'étude, avec les statistiques d'éligibilité d'une cible. */
export type TargetedStudyPopulation = StudyPopulation & { eligibility?: EligibilityStats };

export interface CreateStudyInput {
  projectId: string;
  /** Population unique (raccourci de `populations`). */
  n?: number;
  quotas?: Quotas;
  /** Plusieurs groupes : cible, témoin… */
  populations?: PopulationInput[];
  seed: number;
  backend: string;
  model: string;
  /** Moteur figé dans `studies.extra.engine` (fournisseur, modèle, profil, version de Personas). */
  engine?: StudyEngineInfo;
  /** Reprend l'échantillon d'une autre étude (ses `n` premières personas, dans l'ordre, avec leurs groupes). */
  sameSampleAs?: string;
  /** Avec `sameSampleAs` : ne reprend que les personas de ce groupe (ex. "target"). */
  sameSampleGroup?: string;
  name?: string;
  /** Version du protocole (par défaut la dernière, v4) ; "3" ou "2" forcent un protocole figé des études existantes. */
  protocolVersion?: ProtocolVersion;
  /** v3 et v4 : lance l'étude malgré un pitch au ton commercial (score ≥ seuil). Sans effet en v2 (simple avertissement). */
  force?: boolean;
}

export interface CreateStudyResult {
  study: Study;
  shortfalls: string[];
  /** Avertissements du ciblage (cible rare…) et bilan du cache de personas. */
  notes: string[];
  /** Garde-fou de ton du pitch (lexical, sans appel) : avertissement si le pitch est commercial ; on peut passer outre. */
  pitchTone?: ToneWarning;
}

/**
 * Langue de l'étude à créer, d'après le socle de sa première population (cible déclarée, pack, rôles,
 * cible du projet ou étude dont l'échantillon est repris) ; français par défaut.
 */
function creationLocale(db: Db, project: Project, input: CreateStudyInput): "fr" | "en" {
  const socleLocale = (socle: string | undefined) => {
    if (!socle) return null;
    try {
      return resolveSoclePack(socle).manifest.locale;
    } catch {
      return null;
    }
  };
  for (const pop of input.populations ?? []) {
    const l = socleLocale(pop.target?.socle ?? (pop.target ? "fr" : undefined)) ?? (pop.packVersion ? packManifest(pop.packVersion)?.locale : null);
    if (l) return l;
  }
  const roles = projectRoles(project);
  if (roles.length) return socleLocale(roles[0]!.target.socle ?? "fr") ?? "fr";
  const target = (project.extra as { target?: { socle?: string } }).target;
  if (target) return socleLocale(target.socle ?? "fr") ?? "fr";
  if (input.sameSampleAs) {
    try {
      return studyAudience(findStudy(db, input.sameSampleAs)).locale;
    } catch {
      return "fr";
    }
  }
  return "fr";
}

export function createStudy(db: Db, pack: Pack, input: CreateStudyInput): CreateStudyResult {
  const project = getProject(db, input.projectId);
  if (!project) throw new Error(`Projet introuvable : ${input.projectId}`);
  if (input.backend === "anthropic-api") throw new Error("Backend anthropic-api refusé (API payante).");
  const version = input.protocolVersion ?? PROTOCOL_VERSION;
  if (!PROTOCOL_VERSIONS.includes(version)) throw new Error(`Version de protocole inconnue : ${String(version)} (2, 3 ou 4).`);
  // Garde-fou : un pitch commercial fausse le test de l'idée (expérience du 2026-10-15).
  // v3 et v4 : refus sans --force (aucune neutralisation silencieuse) ; v2 : avertissement seul.
  const locale = creationLocale(db, project, input);
  const tone = toneWarning(project.pitch, undefined, locale);
  if (hasV3Measures(version) && tone.warn && !input.force && locale === "en") {
    throw new Error(
      `Pitch with a commercial tone (score ${tone.score}/100, threshold ${tone.threshold}${tone.markers.length ? `; markers: ${tone.markers.slice(0, 5).join(", ")}` : ""}): ` +
        `protocol v${version} requires a neutral pitch. Neutralise it: npm run project:neutralize-pitch -- --project ${project.id}; ` +
        `or override with --force (the confidence index will flag it).`,
    );
  }
  if (hasV3Measures(version) && tone.warn && !input.force) {
    throw new Error(
      `Pitch au ton commercial (score ${tone.score}/100, seuil ${tone.threshold}${tone.markers.length ? ` ; marqueurs : ${tone.markers.slice(0, 5).join(", ")}` : ""}) : ` +
        `le protocole v${version} exige un pitch neutre. Neutraliser : npm run project:neutralize-pitch -- --project ${project.id} ; ` +
        `ou passer outre avec --force (l'indice de confiance le signalera).`,
    );
  }

  let ids: string[] = [];
  let groups: Record<string, string> = {};
  let populations: StudyPopulation[] = [];
  const shortfalls: string[] = [];
  const notes: string[] = [];
  let sampleFrom: string | null = null;

  if (input.sameSampleAs) {
    const src = findStudy(db, input.sameSampleAs);
    const g = input.sameSampleGroup;
    const pool = g ? src.personaIds.filter((id) => (src.personaGroups[id] ?? "target") === g) : src.personaIds;
    if (!pool.length) throw new Error(`L'étude ${src.id} n'a aucune persona dans le groupe « ${g} ».`);
    const n = input.n ?? pool.length;
    if (n > pool.length) throw new Error(`L'étude ${src.id} n'a que ${pool.length} personas${g ? ` dans le groupe « ${g} »` : ""}.`);
    ids = pool.slice(0, n);
    groups = Object.fromEntries(ids.filter((id) => src.personaGroups[id]).map((id) => [id, src.personaGroups[id]!]));
    populations = g
      ? src.populations.filter((p) => p.group === g).map((p) => ({ ...p, n: ids.length }))
      : src.populations;
    sampleFrom = src.id;
  } else {
    const pops: PopulationInput[] =
      input.populations ?? (input.n ? [{ group: TARGET, n: input.n, ...(input.quotas && { quotas: input.quotas }) }] : []);
    if (!pops.length) throw new Error("Taille d'échantillon requise (--n).");
    if (new Set(pops.map((p) => p.group)).size !== pops.length) throw new Error("Deux populations portent le même nom de groupe.");
    for (const pop of pops) {
      if (pop.target) {
        // Ciblage : tirage virtuel filtré, mis en cache ; les ids déjà pris par un autre groupe sont sautés.
        // Lock du projet (personas hub lock) : socle et modules à leur version exacte, hors ligne
        const prepared = prepareTarget({ ...pop.target, ...(pop.quotas && { quotas: pop.quotas }) }, { lock: (project.extra as ProjectExtra).lock });
        const drawn = drawTarget(prepared, pop.n, input.seed, { exclude: new Set(ids), ...(pop.accept && { accept: pop.accept }) });
        const cache = persistDrawn(db, drawn.personas);
        const stats = eligibilityStats(prepared, drawn);
        shortfalls.push(...drawn.shortfalls.map((s) => `${pop.group} : ${s}`));
        notes.push(...drawn.warnings.map((w) => `${pop.group} : ${w}`));
        notes.push(
          `${pop.group} : ${drawn.personas.length} personas (${stats.socle}${stats.modules.length ? ` + ${stats.modules.join(", ")}` : ""}) ; ` +
            (stats.expression ? `éligibilité ${(stats.rate * 100).toFixed(2)} % [${(stats.ci[0] * 100).toFixed(2)} ; ${(stats.ci[1] * 100).toFixed(2)}] sur ${stats.draws.toLocaleString("fr-FR")} tirages ; ` : "") +
            `cache : ${cache.inserted} ajoutées, ${cache.updated} complétées, ${cache.reused} reprises`,
        );
        for (const p of drawn.personas) groups[p.id] = pop.group;
        ids.push(...drawn.personas.map((p) => p.id));
        populations.push({
          group: pop.group,
          packVersion: stats.socle,
          n: drawn.personas.length,
          ...(prepared.spec.quotas && { quotas: prepared.spec.quotas }),
          eligibility: stats,
        } as TargetedStudyPopulation);
        continue;
      }
      const packVersion = pop.packVersion ?? pack.manifest.version;
      const quotas = quotasSchema.parse(pop.quotas ?? {});
      const pool = allPersonas(db, { packVersion }).filter((p) => !groups[p.id]);
      if (!pool.length) throw new Error(`Aucune persona dans la population ${packVersion}.`);
      const drawn = drawSample(pack, pool, pop.n, input.seed, quotas);
      shortfalls.push(...drawn.shortfalls.map((s) => `${pop.group} : ${s}`));
      for (const id of drawn.ids) groups[id] = pop.group;
      ids.push(...drawn.ids);
      populations.push({ group: pop.group, packVersion, n: drawn.ids.length, ...(Object.keys(quotas).length && { quotas: quotas as Record<string, Record<string, number>> }) });
    }
  }

  const label = populations.length > 1 ? populations.map((p) => `${p.group} ${p.n}`).join(" + ") : `n=${ids.length}`;
  const study = db
    .insert(studies)
    .values({
      id: newStudyId(),
      projectId: project.id,
      name: input.name ?? `${project.name} — ${input.backend}, ${label}`,
      protocol: PROTOCOL_ID,
      protocolVersion: version,
      backend: input.backend,
      model: input.model,
      seed: input.seed,
      sampleSize: ids.length,
      quotas: populations[0]?.quotas ?? {},
      populations,
      personaGroups: groups,
      personaIds: ids,
      sampleFromStudyId: sampleFrom,
      progressTotal: ids.length,
      ...(input.engine && { extra: { engine: input.engine } }),
    })
    .returning()
    .get();
  if (tone.warn) notes.push(hasV3Measures(version) ? `⚠ Pitch au ton commercial (score ${tone.score}/100), étude forcée (--force) : les prix et le frein « confiance » sont faussés.` : `⚠ ${tone.message}`);
  return { study, shortfalls, notes, ...(tone.warn && { pitchTone: tone }) };
}

/**
 * Populations d'une étude multi-rôles (phase 7) : un groupe par rôle (id du rôle), avec sa cible.
 * `n` : effectifs par rôle (sinon `target.n` de chaque rôle). Rôle `payer_for_child` : seuls les adultes
 * qui ont au moins un enfant éligible (tranche d'âge, filtre enfant) sont retenus.
 */
export function rolePopulations(project: Project, n: Record<string, number> = {}): PopulationInput[] {
  const roles = projectRoles(project);
  if (!roles.length) throw new Error(`Le projet ${project.id} ne déclare pas de rôles.`);
  return roles.map((r: RoleSpec) => {
    const size = n[r.id] ?? r.target.n;
    if (!size) throw new Error(`Effectif requis pour le rôle « ${r.id} » (target.n ou option).`);
    const pop: PopulationInput = { group: r.id, n: size, target: r.target };
    if (r.child) {
      const prepared = prepareChild(r.child, resolveSoclePack(r.target.socle ?? "fr").socle);
      pop.accept = (p) => childProfiles(p as never, prepared).length > 0;
    }
    return pop;
  });
}
