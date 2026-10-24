/**
 * Références de modules (docs/plateforme.md § 4.1 et 4.2).
 *
 * - Référence **qualifiée** : `namespace/module` (+ `@version` à part), ex. `alice/sport-connecte@2026.1`.
 * - Référence **canonique** (clé de la bibliothèque, de `extra.modules`, du flux aléatoire et de l'empreinte
 *   `-m<hash>`) : l'id **nu** pour le namespace officiel `personas` (`numerique`), la référence qualifiée sinon
 *   (`alice/sport-connecte`). Les identifiants des personas existantes ne changent donc pas.
 * - Un id nu se résout d'abord dans la bibliothèque locale (modules/ du dépôt ou du paquet installé), puis
 *   dans `personas/` (cache du Hub).
 */

export const OFFICIAL_NAMESPACE = "personas";

const SPEC = /^(?:([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\/)?([a-z0-9][a-z0-9-]*)(?:@([^@\s]{1,32}))?$/;

export interface ModuleSpec {
  /** Référence canonique (id nu pour `personas/`, `ns/slug` sinon). */
  ref: string;
  namespace: string;
  slug: string;
  /** Version exacte demandée (`@version`), sinon absente. */
  version?: string;
}

/** Lit `numerique`, `numerique@2026.3`, `personas/numerique@2026.3` ou `alice/sport@2026.1`. */
export function parseModuleSpec(spec: string): ModuleSpec {
  const m = SPEC.exec(spec.trim());
  if (!m) throw new Error(`Référence de module invalide : « ${spec} » (attendu : id, namespace/module ou namespace/module@version)`);
  const namespace = m[1] ?? OFFICIAL_NAMESPACE;
  const slug = m[2]!;
  return { ref: namespace === OFFICIAL_NAMESPACE ? slug : `${namespace}/${slug}`, namespace, slug, ...(m[3] && { version: m[3] }) };
}

/** Référence canonique d'une référence nue ou qualifiée (sans version). */
export const canonicalRef = (ref: string): string => parseModuleSpec(ref).ref;

/** Référence qualifiée (`personas/numerique`) d'une référence canonique ou nue. */
export function qualifiedRef(ref: string): string {
  const s = parseModuleSpec(ref);
  return `${s.namespace}/${s.slug}`;
}

/** Vrai pour un module du namespace officiel (référence canonique nue). */
export const isOfficialRef = (ref: string): boolean => parseModuleSpec(ref).namespace === OFFICIAL_NAMESPACE;

/** `ref@version` canonique. */
export const specString = (ref: string, version?: string): string => (version ? `${canonicalRef(ref)}@${version}` : canonicalRef(ref));

/**
 * Comparaison de versions calendaires (« 2026.3 » < « 2026.10 », « fr-2026.2 » < « fr-2026.3 ») : morceaux
 * numériques comparés comme des nombres, le reste comme du texte.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/(\d+)/).filter(Boolean);
  const pb = b.split(/(\d+)/).filter(Boolean);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
