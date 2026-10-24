import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { validateModuleYaml } from "../modules/assistant/drafts";
import { lintModule, sensitiveAttributes, type LintResult } from "../modules/lint";
import { modulesRoot } from "../modules/registry";
import type { ModuleDef } from "../modules/schema";
import { sha256Text } from "./cache";

/**
 * Préparation d'une publication de module (CLI `personas hub publish`, tableau de bord) : ce qui part est le
 * texte YAML exact du module, rien d'autre (ni projet, ni brouillon, ni research.json). Avant l'envoi : validation
 * complète (schéma, sémantique, dépendances) et lint de sécurité ; une erreur bloque, un avertissement s'affiche.
 */

/** Fichier d'un module : chemin d'un YAML, ou id d'un module de la bibliothèque locale (modules/<id>/module.yaml). */
export function moduleFileOf(target: string): string {
  if (existsSync(target) && statSync(target).isFile()) return resolve(target);
  if (/^[a-z][a-z0-9-]*$/.test(target)) {
    const f = resolve(modulesRoot(), target, "module.yaml");
    if (existsSync(f)) return f;
  }
  throw new Error(`Module introuvable : ${target} (fichier YAML ou id d'un module de modules/).`);
}

export interface PublicationPreview {
  file: string;
  yaml: string;
  sha256: string;
  def: ModuleDef | null;
  /** Erreurs de validation (schéma, sémantique, dépendances). */
  validation: Array<{ path: string; message: string }>;
  lint: LintResult;
  /** Attributs sensibles déclarés (badge sur le Hub). */
  sensitive: string[];
  /** Publiable : ni erreur de validation ni erreur du lint. */
  ok: boolean;
}

export function previewPublication(file: string): PublicationPreview {
  const yaml = readFileSync(file, "utf8");
  const lint = lintModule(yaml);
  const v = lint.errors.some((e) => e.code === "yaml" || e.code === "size") ? { ok: false, errors: [], module: undefined } : validateModuleYaml(yaml);
  const def = v.module?.def ?? null;
  return {
    file,
    yaml,
    sha256: sha256Text(yaml),
    def,
    validation: v.errors,
    lint,
    sensitive: def ? sensitiveAttributes(def).filter((s) => s.declared).map((s) => s.key) : [],
    ok: v.errors.length === 0 && lint.errors.length === 0 && !!def,
  };
}
