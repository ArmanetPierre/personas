import { parse as parseYaml } from "yaml";
import { lintModule, sensitiveAttributes } from "../../src/modules/lint";
import type { StoredLint } from "../db/schema";

/**
 * Lint de sécurité obligatoire à la publication (docs/plateforme.md § 11.3, § 11.4), avec le lint
 * partagé entre le Hub et le runner (`src/modules/lint.ts`) : injection de prompt dans les libellés et
 * la fiche, URL et balisage, longueurs et tailles, affirmations comportementales, attributs sensibles
 * sans `sensitive: true` et `sensitive_justification`. Une erreur refuse la publication (422) ; les
 * alertes sont enregistrées avec la version.
 */

export interface LintIssue {
  path?: string;
  message: string;
}
export interface LintReport {
  errors: LintIssue[];
  warnings: LintIssue[];
  /** Attributs sensibles (déclarés ou détectés) : badge « sensible », exclusion du choix automatique. */
  sensitive: string[];
  engine: StoredLint["engine"];
}

const issue = (i: { path: string; message: string; code: string }): LintIssue => (i.path ? { path: i.path, message: `${i.message} [${i.code}]` } : { message: `${i.message} [${i.code}]` });

/** Lint d'un module à publier (texte YAML exact). */
export async function lintForPublication(yaml: string): Promise<LintReport> {
  const out = lintModule(yaml);
  let sensitive: string[] = [];
  try {
    const raw = parseYaml(yaml) as unknown;
    if (raw && typeof raw === "object") sensitive = sensitiveAttributes(raw as Record<string, unknown>).map((a) => a.key);
  } catch {
    // YAML illisible : déjà signalé par le lint (erreur `yaml`)
  }
  return { errors: out.errors.map(issue), warnings: out.warnings.map(issue), sensitive, engine: "shared" };
}
