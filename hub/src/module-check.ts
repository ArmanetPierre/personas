import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { OFFICIAL_NAMESPACE, type QualityScore } from "../../src/hub/contract";
import { validateModuleYaml } from "../../src/modules/assistant/drafts";
import { previewModule, type PreviewResult } from "../../src/modules/assistant/preview";
import { checkModule, moduleLibrary, resolveModules, type LoadedModule } from "../../src/modules/registry";
import type { ModuleDef } from "../../src/modules/schema";
import type { Pack } from "../../src/personas/pack";
import { drawPersonas } from "../../src/personas/sampler";
import { computeMargins, plausibilityChecks } from "../../src/personas/validate";
import { resolveSoclePack } from "../../src/population/target";
import type { StoredPreview } from "../db/schema";
import { computeQuality } from "./quality";

/**
 * Contrôle d'un module à publier, avec le paquet moteur (aucun LLM) : validation complète
 * (schéma, sémantique, dépendances, filtres prêts à l'emploi), aperçu sur 10 000 personas virtuelles,
 * porte d'entrée (erreur de validation ou alerte `error` → refus) et score Q.
 */

export const PREVIEW_N = 10_000;
export const PREVIEW_SEED = 42;

/** Erreur HTTP au format du contrat (`{ error: { code, message } }`), traduite par `app.onError`. */
export class PublishError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429,
    readonly code: "not_found" | "conflict" | "invalid" | "unauthorized" | "rate_limited",
    message: string,
    /** Précision stable pour les clients (ex. `expired`, `unknown_code`), renvoyée dans error.reason. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Dépendance déclarée dans `requires` (forme courte officielle, ou référence qualifiée épinglée). */
export interface RequireSpec {
  ref: string; // ns/slug
  version: string | null; // null : dernière version publiée (forme courte `numerique`, officielle)
  as: string;
}

/** Lecture tolérante de `requires` : `numerique`, `alice/sport@2026.1`, ou `{ref, version?, as?}`. */
export function parseRequires(raw: unknown): RequireSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r): RequireSpec => {
    const fromString = (s: string, as?: string): RequireSpec => {
      const [ref, version] = s.split("@") as [string, string | undefined];
      if (!ref.includes("/")) return { ref: `${OFFICIAL_NAMESPACE}/${ref}`, version: version ?? null, as: as ?? ref };
      return { ref, version: version ?? null, as: as ?? ref.slice(ref.indexOf("/") + 1) };
    };
    if (typeof r === "string") return fromString(r);
    if (r && typeof r === "object" && typeof (r as { ref?: unknown }).ref === "string") {
      const o = r as { ref: string; version?: unknown; as?: unknown };
      const spec = fromString(o.ref, typeof o.as === "string" ? o.as : undefined);
      if (typeof o.version === "string" || typeof o.version === "number") spec.version = String(o.version);
      return spec;
    }
    throw new PublishError(422, "invalid", `requires : entrée illisible (${JSON.stringify(r)})`);
  });
}

/** Version publiée d'une dépendance, avec ses propres dépendances (déjà épinglées en base). */
export interface PublishedDep {
  ref: string;
  version: string;
  yaml: string;
  requires: Array<{ ref: string; version: string; as: string }>;
}

export type DepResolver = (ref: string, version: string | null) => Promise<PublishedDep | null>;

export interface ModuleCheckResult {
  def: ModuleDef;
  module: LoadedModule;
  requires: Array<{ ref: string; version: string; as: string }>;
  quality: QualityScore | null;
  preview: StoredPreview | null;
  legacy: boolean;
}

/** Première étape, peu coûteuse : YAML lisible, id et version (pour le 409 avant l'aperçu). */
export function readModuleHeader(yaml: string): { id: string; version: string; raw: Record<string, unknown> } {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    throw new PublishError(422, "invalid", `YAML illisible : ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PublishError(422, "invalid", "Le module doit être un objet YAML.");
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(o.id)) throw new PublishError(422, "invalid", "id : minuscules et tirets attendus (ex. sport-connecte).");
  if (typeof o.version !== "string" && typeof o.version !== "number") throw new PublishError(422, "invalid", "version : chaîne attendue (ex. \"2026.1\").");
  const version = String(o.version);
  if (!version.length || version.length > 32) throw new PublishError(422, "invalid", "version : 1 à 32 caractères.");
  return { id: o.id, version, raw: o };
}

/** Dépendances transitives, chargées depuis le Hub (versions épinglées). */
async function loadDeps(specs: RequireSpec[], resolve: DepResolver): Promise<{ direct: Array<{ ref: string; version: string; as: string }>; all: PublishedDep[] }> {
  const all = new Map<string, PublishedDep>();
  const direct: Array<{ ref: string; version: string; as: string }> = [];
  const visit = async (ref: string, version: string | null, path: string[]): Promise<PublishedDep> => {
    if (path.length > 16) throw new PublishError(422, "invalid", `requires : chaîne de dépendances trop longue (${path.join(" → ")})`);
    const dep = await resolve(ref, version);
    if (!dep) throw new PublishError(422, "invalid", `requires : ${ref}${version ? `@${version}` : ""} introuvable sur le Hub (le publier d'abord).`);
    const key = `${dep.ref}@${dep.version}`;
    if (!all.has(key)) {
      all.set(key, dep);
      for (const r of dep.requires) await visit(r.ref, r.version, [...path, key]);
    }
    return dep;
  };
  for (const s of specs) {
    const dep = await visit(s.ref, s.version, []);
    direct.push({ ref: dep.ref, version: dep.version, as: s.as });
  }
  return { direct, all: [...all.values()] };
}

/**
 * Bibliothèque temporaire des dépendances (un dossier par module, comme `modules/`), pour que
 * `previewModule` et la validation voient exactement les versions épinglées du Hub, et pas le dépôt.
 */
function depsLibraryDir(deps: PublishedDep[]): string {
  const key = sha256(deps.map((d) => `${d.ref}@${d.version}:${sha256(d.yaml)}`).sort().join("\n")).slice(0, 24);
  const dir = join(tmpdir(), "personas-hub-lib", key);
  if (!existsSync(join(dir, ".ready"))) {
    mkdirSync(dir, { recursive: true });
    const ids = new Set<string>();
    for (const d of deps) {
      const id = checkModule(parseYaml(d.yaml), d.ref).def.id;
      if (ids.has(id)) throw new PublishError(422, "invalid", `requires : deux versions du module « ${id} » dans les dépendances.`);
      ids.add(id);
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, "module.yaml"), d.yaml);
    }
    writeFileSync(join(dir, ".ready"), "");
  }
  return dir;
}

/** Exécute `fn` avec la bibliothèque `dir` (PERSONAS_MODULES_DIR) ; synchrone, donc sans concurrence. */
function withModulesDir<T>(dir: string, fn: () => T): T {
  const prev = process.env.PERSONAS_MODULES_DIR;
  process.env.PERSONAS_MODULES_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PERSONAS_MODULES_DIR;
    else process.env.PERSONAS_MODULES_DIR = prev;
  }
}

const formatIssues = (errs: Array<{ path: string; message: string }>) => errs.map((e) => `- ${e.path ? `${e.path} : ` : ""}${e.message}`).join("\n");

/** Contrôles rejoués sur les personas virtuelles : marges déclarées, parts sourcées, plausibilité. */
function validationChecks(m: LoadedModule, socle: string, lib: Map<string, LoadedModule>): { total: number; passed: number } {
  const base = resolveSoclePack(socle);
  const resolved = resolveModules([m.def.id], base.socle, lib);
  const pack: Pack = { ...base, modules: resolved };
  const personas = drawPersonas(pack, PREVIEW_SEED, PREVIEW_N, 0, { modules: resolved });
  const rows = personas.map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null }));
  const onlyThis: Pack = { ...pack, modules: { ordered: [m], quasiDims: new Map() } };
  const margins = computeMargins(onlyThis, rows).filter((r) => r.key.startsWith(`${m.def.id}.`));
  const plaus = plausibilityChecks(onlyThis, rows);
  return { total: margins.length + plaus.length, passed: margins.filter((r) => r.pass).length + plaus.filter((c) => c.pass).length };
}

/**
 * Validation complète + aperçu + Q. Lève une PublishError 422 si la porte d'entrée refuse le module.
 * Un module archivé (`status: legacy`) est accepté même si l'aperçu échoue sur le socle courant
 * (Q nul) : il reste téléchargeable pour relire les études historiques.
 */
export async function checkModuleForPublication(yaml: string, resolve: DepResolver): Promise<ModuleCheckResult> {
  const { raw } = readModuleHeader(yaml);
  const { direct, all } = await loadDeps(parseRequires(raw.requires), resolve);
  const dir = depsLibraryDir(all);

  return withModulesDir(dir, () => {
    const lib = new Map(moduleLibrary(dir));
    const v = validateModuleYaml(yaml, { library: lib });
    if (!v.ok || !v.module) throw new PublishError(422, "invalid", `Validation en échec, module refusé :\n${formatIssues(v.errors)}`);
    const m = v.module;
    const legacy = m.def.status === "legacy";
    let preview: PreviewResult;
    try {
      preview = previewModule({ yaml }, { n: PREVIEW_N, sample: 0, seed: PREVIEW_SEED });
    } catch (err) {
      if (legacy) return { def: m.def, module: m, requires: direct, quality: null, preview: null, legacy };
      throw new PublishError(422, "invalid", `Aperçu impossible, module refusé : ${(err as Error).message}`);
    }
    const errors = preview.alerts.filter((a) => a.level === "error");
    if (errors.length) throw new PublishError(422, "invalid", `Aperçu en erreur, module refusé :\n${errors.map((a) => `- ${a.message}`).join("\n")}`);
    lib.set(m.def.id, m);
    const socle = m.def.applies_to[0]!;
    const checks = validationChecks(m, socle, lib);
    const quality = computeQuality({ def: m.def, margins: preview.margins, alerts: preview.alerts, checks });
    const stored: StoredPreview = {
      socle: preview.socle,
      n: preview.n,
      margins: preview.margins.map((mg) => ({ ...mg, values: mg.values.map((x) => ({ ...x, share: Math.round(x.share * 10_000) / 10_000 })) })),
      alerts: preview.alerts,
      checks,
    };
    return { def: m.def, module: m, requires: direct, quality, preview: stored, legacy };
  });
}

/** Textes indexés par la recherche plein texte (titre, puis corps). */
export function searchTexts(def: ModuleDef, ref: string): { title: string; body: string } {
  const title = [def.label, def.short_label ?? "", def.id, ref].join(" ");
  const body: string[] = [def.description ?? ""];
  for (const a of def.attributes) {
    body.push(a.label, a.description ?? "");
    if (a.type === "enum") for (const v of a.values) body.push(typeof v.label === "string" ? v.label : `${v.label.M} ${v.label.F}`);
    if (a.type === "set") for (const i of a.items) body.push(i.label);
  }
  for (const s of def.segments) body.push(s.label);
  return { title, body: body.filter(Boolean).join(" \n") };
}
