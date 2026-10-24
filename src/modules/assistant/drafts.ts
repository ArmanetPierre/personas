import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { compileEligibility } from "../../population/eligibility";
import { SG_ELIGIBILITY_VARS } from "../../personas/countries/sg/vars";
import { US_ELIGIBILITY_VARS } from "../../personas/countries/us/vars";
import { lintModule as securityLint } from "../lint";
import { isLegacy, lintModule, moduleLibrary, modulesRoot, resolveModules, checkModule, type LoadedModule } from "../registry";
import type { ModuleDef } from "../schema";
import { lineDiff } from "./diff";

/**
 * Brouillons de modules : `modules/_drafts/<draftId>/module.yaml` + `meta.json`.
 * Un module validé est déplacé vers `modules/<id>/module.yaml` (le dossier du brouillon garde son
 * `meta.json`, au statut `accepted`).
 */

export const draftsDir = () => resolve(modulesRoot(), "_drafts");

export type DraftStatus = "proposing" | "ready" | "error" | "accepted";

export interface DraftHistoryEntry {
  at: string;
  kind: "propose" | "repair" | "revise" | "edit" | "accept";
  summary: string;
  /** Diff ligne à ligne avec la version précédente (révisions, éditions). */
  diff?: string;
}

export interface DraftUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface DraftMeta {
  id: string;
  status: DraftStatus;
  progress: string;
  description: string;
  projectId?: string;
  socle: string;
  /** Id de module visé (ex. equipement-ecosysteme), s'il est imposé. */
  moduleId?: string;
  createdAt: string;
  updatedAt: string;
  notes: string[];
  history: DraftHistoryEntry[];
  error?: string;
  /** Étapes faites (reprise) : recherche, génération, réparations. */
  steps?: { research?: boolean; generated?: boolean; repairRounds?: number };
  usage?: DraftUsage;
  acceptedAs?: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

const now = () => new Date().toISOString();
const draftDir = (id: string) => resolve(draftsDir(), id);

export function draftExists(id: string): boolean {
  return existsSync(resolve(draftDir(id), "meta.json"));
}

export function newDraftId(hint: string): string {
  const slug = hint
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12);
  return `${slug || "module"}-${stamp}`;
}

/** Écriture atomique (le tableau de bord lit `meta.json` pendant que la CLI l'écrit). */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function readMeta(id: string): DraftMeta {
  const p = resolve(draftDir(id), "meta.json");
  if (!existsSync(p)) throw new Error(`Brouillon introuvable : ${id}`);
  return JSON.parse(readFileSync(p, "utf8")) as DraftMeta;
}

export function writeMeta(meta: DraftMeta): DraftMeta {
  mkdirSync(draftDir(meta.id), { recursive: true });
  meta.updatedAt = now();
  writeAtomic(resolve(draftDir(meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export function updateMeta(id: string, patch: Partial<DraftMeta>): DraftMeta {
  return writeMeta({ ...readMeta(id), ...patch });
}

export function createDraft(input: { id?: string; description: string; socle: string; projectId?: string; moduleId?: string }): DraftMeta {
  const id = input.id ?? newDraftId(input.moduleId ?? input.description);
  if (draftExists(id)) throw new Error(`Le brouillon ${id} existe déjà.`);
  return writeMeta({
    id,
    status: "proposing",
    progress: "Brouillon créé",
    description: input.description,
    ...(input.projectId && { projectId: input.projectId }),
    ...(input.moduleId && { moduleId: input.moduleId }),
    socle: input.socle,
    createdAt: now(),
    updatedAt: now(),
    notes: [],
    history: [],
    steps: {},
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
  });
}

export function readDraftYaml(id: string): string | null {
  const p = resolve(draftDir(id), "module.yaml");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function writeDraftYaml(id: string, yaml: string): void {
  mkdirSync(draftDir(id), { recursive: true });
  writeAtomic(resolve(draftDir(id), "module.yaml"), yaml.endsWith("\n") ? yaml : `${yaml}\n`);
}

export function readDraftFile(id: string, name: string): string | null {
  const p = resolve(draftDir(id), name);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function writeDraftFile(id: string, name: string, content: string): void {
  mkdirSync(draftDir(id), { recursive: true });
  writeAtomic(resolve(draftDir(id), name), content);
}

/**
 * Validation complète d'un YAML de module : syntaxe, schéma zod, contrôles sémantiques, dépendances
 * (bibliothèque + ce module), compatibilité au socle, filtres d'éligibilité prêts à l'emploi, puis lint de
 * sécurité (src/modules/lint.ts : injection de prompt, complaisance, tailles, attributs sensibles), dont les
 * erreurs bloquent comme les autres et les avertissements sont renvoyés à part.
 */
export function validateModuleYaml(
  yaml: string,
  opts: { socle?: string; library?: Map<string, LoadedModule> } = {},
): { ok: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[]; module?: LoadedModule } {
  const security = securityLint(yaml);
  const warnings: ValidationIssue[] = security.warnings.map((w) => ({ path: w.path, message: `${w.message} [lint ${w.code}]` }));
  const lintErrors: ValidationIssue[] = security.errors.map((e) => ({ path: e.path, message: `${e.message} [lint ${e.code}]` }));
  if (security.errors.some((e) => e.code === "yaml" || e.code === "size")) return { ok: false, errors: lintErrors, warnings };
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    return { ok: false, errors: [{ path: "", message: `YAML illisible : ${(err as Error).message}` }], warnings };
  }
  const errors = lintModule(raw);
  if (errors.length) return { ok: false, errors: [...errors, ...lintErrors], warnings };
  const m = checkModule(raw, "(brouillon)");
  const lib = new Map(opts.library ?? moduleLibrary());
  lib.set(m.def.id, m);
  try {
    resolveModules([m.def.id], opts.socle ?? m.def.applies_to[0]!, lib);
  } catch (err) {
    errors.push({ path: "requires", message: (err as Error).message });
  }
  // Filtres prêts à l'emploi : variables du socle et attributs « module.attr » de ce module et de ses dépendances
  const known = new Set(eligibilitySocleVars(opts.socle ?? m.def.applies_to[0]));
  for (const mod of [m, ...m.def.requires.map((r) => lib.get(r)).filter((x): x is LoadedModule => !!x)]) {
    for (const a of mod.def.attributes) known.add(`${mod.def.id}.${a.key}`);
  }
  for (const [name, expr] of Object.entries(m.def.eligibility_helpers)) {
    try {
      compileEligibility(expr, known);
    } catch (err) {
      errors.push({ path: `eligibility_helpers.${name}`, message: (err as Error).message });
    }
  }
  errors.push(...lintErrors);
  return { ok: errors.length === 0, errors, warnings, module: m };
}

/**
 * Bibliothèque des modules validés + brouillons valides (non encore validés), en lecture seule, pour
 * l'aperçu d'une cible (`population:draw --drafts`). Un module validé l'emporte sur un brouillon de même id.
 */
export function libraryWithDrafts(): { library: Map<string, LoadedModule>; drafts: string[] } {
  const library = new Map(moduleLibrary());
  const drafts: string[] = [];
  if (existsSync(draftsDir())) {
    for (const d of readdirSync(draftsDir(), { withFileTypes: true })) {
      if (!d.isDirectory() || !draftExists(d.name)) continue;
      const meta = readMeta(d.name);
      if (meta.status === "accepted") continue;
      const yaml = readDraftYaml(d.name);
      if (!yaml) continue;
      const v = validateModuleYaml(yaml, { socle: meta.socle });
      if (!v.ok || !v.module || library.has(v.module.def.id)) continue;
      library.set(v.module.def.id, v.module);
      drafts.push(`${v.module.def.id} (brouillon ${d.name})`);
    }
  }
  return { library, drafts };
}

/** Variables du socle reconnues par le filtre d'éligibilité (voir population/target.ts ; Singapour : countries/sg/vars.ts). */
export function eligibilitySocleVars(socle = "fr"): string[] {
  if (socle.replace(/-.*$/, "") === "sg") return [...SG_ELIGIBILITY_VARS];
  if (socle.replace(/-.*$/, "") === "us") return [...US_ELIGIBILITY_VARS];
  return [
    "age", "sex", "region", "town_size", "pcs", "activity_status", "household_type", "household_size", "monthly_income",
    "household_income", "budget", "living_standard", "tech_adoption", "social_media", "tenure", "children",
    "has_computer", "has_smartphone", "has_tablet",
  ];
}

export interface ModuleSummary {
  id: string;
  version: string;
  label: string;
  status: "validated" | `draft:${DraftStatus}`;
  draftId?: string;
  appliesTo: string[];
  requires: string[];
  attributeCount: number;
  sourcedCount: number;
  assumptionCount: number;
  updatedAt: string;
}

function summarize(def: ModuleDef, status: ModuleSummary["status"], updatedAt: string, draftId?: string): ModuleSummary {
  const sourced = def.attributes.filter((a) => a.sources.length > 0).length;
  const assumptions = def.attributes.filter((a) => a.assumption).length;
  return {
    id: def.id,
    version: def.version,
    label: def.label,
    status,
    ...(draftId && { draftId }),
    appliesTo: def.applies_to,
    requires: def.requires,
    attributeCount: def.attributes.length,
    sourcedCount: sourced,
    assumptionCount: assumptions,
    updatedAt,
  };
}

/** Modules validés (bibliothèque) et brouillons. */
export function listModules(): ModuleSummary[] {
  const out: ModuleSummary[] = [];
  for (const m of moduleLibrary(modulesRoot(), { fresh: true }).values()) {
    if (isLegacy(m)) continue; // archivé : hors de la bibliothèque proposée
    out.push(summarize(m.def, "validated", statSync(m.file).mtime.toISOString()));
  }
  if (existsSync(draftsDir())) {
    for (const d of readdirSync(draftsDir(), { withFileTypes: true })) {
      if (!d.isDirectory() || !draftExists(d.name)) continue;
      const meta = readMeta(d.name);
      if (meta.status === "accepted") continue;
      const yaml = readDraftYaml(d.name);
      let def: ModuleDef | null = null;
      if (yaml) {
        try {
          def = checkModule(parseYaml(yaml), "(brouillon)").def;
        } catch {
          // brouillon invalide : résumé minimal
        }
      }
      out.push(
        def
          ? summarize(def, `draft:${meta.status}`, meta.updatedAt, d.name)
          : {
              id: meta.moduleId ?? d.name,
              version: "",
              label: meta.description.slice(0, 80),
              status: `draft:${meta.status}`,
              draftId: d.name,
              appliesTo: [meta.socle],
              requires: [],
              attributeCount: 0,
              sourcedCount: 0,
              assumptionCount: 0,
              updatedAt: meta.updatedAt,
            },
      );
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Module validé (par id) ou brouillon (par draftId) : YAML, version analysée, statut, erreurs. */
export function getModule(idOrDraftId: string): {
  yaml: string;
  parsed?: ModuleDef;
  status: ModuleSummary["status"];
  meta?: DraftMeta;
  validationErrors: ValidationIssue[];
} {
  if (draftExists(idOrDraftId)) {
    const meta = readMeta(idOrDraftId);
    const yaml = readDraftYaml(idOrDraftId) ?? "";
    const v = yaml ? validateModuleYaml(yaml, { socle: meta.socle }) : { ok: false, errors: [{ path: "", message: "Pas encore de YAML" }], warnings: [] };
    // Brouillon à valider : un segment déjà pris bloque l'acceptation (route web), signalé dès l'affichage
    const conflicts = v.module && meta.status !== "accepted" ? segmentConflicts(v.module.def) : [];
    return { yaml, ...(v.module && { parsed: v.module.def }), status: `draft:${meta.status}`, meta, validationErrors: [...v.errors, ...conflicts] };
  }
  const file = resolve(modulesRoot(), idOrDraftId, "module.yaml");
  if (!existsSync(file)) throw new Error(`Module ou brouillon introuvable : ${idOrDraftId}`);
  const yaml = readFileSync(file, "utf8");
  const v = validateModuleYaml(yaml);
  return { yaml, ...(v.module && { parsed: v.module.def }), status: "validated", validationErrors: v.errors };
}

/** Édition manuelle (tableau de bord) : enregistre le YAML s'il est valide, avec une entrée d'historique. */
export function saveDraftYaml(draftId: string, yaml: string): { ok: boolean; errors: ValidationIssue[] } {
  const meta = readMeta(draftId);
  if (meta.status === "accepted") throw new Error(`Le brouillon ${draftId} a déjà été validé.`);
  if (meta.status === "proposing") throw new Error(`Le brouillon ${draftId} est en cours de proposition.`);
  const v = validateModuleYaml(yaml, { socle: meta.socle });
  if (!v.ok) return { ok: false, errors: v.errors };
  const before = readDraftYaml(draftId) ?? "";
  writeDraftYaml(draftId, yaml);
  writeMeta({
    ...meta,
    status: "ready",
    history: [...meta.history, { at: now(), kind: "edit", summary: "Édition manuelle", diff: lineDiff(before, yaml) }],
  });
  return { ok: true, errors: [] };
}

/**
 * Identifiants de segment (dimensions des résumés et des filtres) du module déjà déclarés par un autre module
 * de la bibliothèque locale, archivés compris. La bibliothèque refuse deux segments de même id
 * (librarySegments) : un module accepté malgré ce conflit la rendrait inutilisable. Le module de même id
 * (remplacement) est ignoré ; un module du cache du Hub aussi (une dimension locale passe toujours devant).
 */
export function segmentConflicts(def: ModuleDef, lib: Map<string, LoadedModule> = moduleLibrary(modulesRoot())): ValidationIssue[] {
  const owner = new Map<string, string>();
  for (const m of lib.values()) {
    if (m.def.id === def.id || m.source === "hub-cache") continue;
    for (const s of m.def.segments) if (!owner.has(s.id)) owner.set(s.id, m.def.id);
  }
  return def.segments.flatMap((s, i) => {
    const other = owner.get(s.id);
    return other ? [{ path: `segments.${i}.id`, message: `segment « ${s.id} » déjà déclaré par le module ${other} : choisir un autre identifiant` }] : [];
  });
}

/** Déplace un brouillon validé vers la bibliothèque. Refuse si la validation échoue ou si le module existe. */
export function acceptDraft(draftId: string, opts: { replace?: boolean; blockingAlerts?: string[] } = {}): { moduleId: string; file: string } {
  const meta = readMeta(draftId);
  if (meta.status === "accepted") throw new Error(`Le brouillon ${draftId} est déjà validé (${meta.acceptedAs}).`);
  const yaml = readDraftYaml(draftId);
  if (!yaml) throw new Error(`Le brouillon ${draftId} n'a pas de YAML.`);
  const v = validateModuleYaml(yaml, { socle: meta.socle });
  if (!v.ok) throw new Error(`Validation en échec, module refusé :\n${v.errors.map((e) => `- ${e.path ? `${e.path} : ` : ""}${e.message}`).join("\n")}`);
  if (opts.blockingAlerts?.length) throw new Error(`Aperçu en erreur, module refusé :\n${opts.blockingAlerts.map((a) => `- ${a}`).join("\n")}`);
  const id = v.module!.def.id;
  const dir = resolve(modulesRoot(), id);
  const file = resolve(dir, "module.yaml");
  if (existsSync(file) && !opts.replace) throw new Error(`Le module ${id} existe déjà (modules/${id}) : ajouter --replace pour le remplacer.`);
  // Avant toute écriture, sur la bibliothèque relue (un autre brouillon a pu être validé entre-temps)
  const conflicts = segmentConflicts(v.module!.def, moduleLibrary(modulesRoot(), { fresh: true }));
  if (conflicts.length) throw new Error(`Segments en double, module refusé :\n${conflicts.map((e) => `- ${e.path} : ${e.message}`).join("\n")}`);
  mkdirSync(dir, { recursive: true });
  writeAtomic(file, yaml.endsWith("\n") ? yaml : `${yaml}\n`);
  writeMeta({ ...meta, status: "accepted", acceptedAs: `modules/${id}/module.yaml`, progress: "Module validé", history: [...meta.history, { at: now(), kind: "accept", summary: `Validé vers modules/${id}/module.yaml` }] });
  moduleLibrary(modulesRoot(), { fresh: true });
  return { moduleId: id, file };
}
