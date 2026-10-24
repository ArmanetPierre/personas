import type { QualityScore } from "../../src/hub/contract";
import type { PreviewAlert, PreviewMargin } from "../../src/modules/assistant/preview";
import { condRefs } from "../../src/modules/registry";
import type { ModuleDef } from "../../src/modules/schema";

/**
 * Score de qualité Q, formule « q1 » (docs/plateforme.md § 5.1), recalculé par le Hub :
 *
 *   Q = 100 × (0,35·S + 0,30·M + 0,20·A + 0,15·D)
 *
 * Choix d'interprétation (à revoir avec les premières dizaines de modules, la formule est versionnée) :
 * - S : chaque attribut vaut 1 s'il cite une source sans être marqué `assumption`, 0,5 s'il cite des
 *   sources mais reste une hypothèse (distribution modélisée à partir de sources), 0 sinon ; pondéré par
 *   le nombre de valeurs tirées (personas concernées dans l'aperçu). Chaque table compte comme un
 *   attribut de poids moyen. Le bonus « sources ouvertes par la recherche » (research.json) n'est pas
 *   appliqué en phase 2 : la publication d'administration n'envoie pas research.json.
 * - M : couverture × réussite. Couverture : part des attributs enum ou set visés par `validation`
 *   (margins, shares, plausibility). Réussite : part des contrôles passés sur les personas virtuelles.
 *   Sans aucun contrôle, M = 0.
 * - A : 1 − min(1, Σ poids / 5). Poids 1 : catégorie très rare, valeur jamais tirée, attribut jamais
 *   présent, conditionnement sans effet. Poids 2 : part sourcée (`validation.shares`) ou cible déclarée
 *   non atteinte, incohérence avec le socle de niveau warn. Les autres alertes (sources absentes,
 *   marges en écart) sont déjà comptées par S et M.
 * - D : moyenne de 4 critères (description > 80 caractères, changelog, card, au moins un segment).
 */
export const Q_WEIGHTS = { sourcing: 0.35, margins: 0.3, alerts: 0.2, docs: 0.15 } as const;

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export interface QualityInput {
  def: ModuleDef;
  margins: PreviewMargin[];
  alerts: PreviewAlert[];
  /** Contrôles de validation rejoués sur les personas virtuelles (marges, parts, plausibilité). */
  checks: { total: number; passed: number };
}

const provenanceScore = (p: { sources: string[]; assumption: boolean }) => (p.sources.length ? (p.assumption ? 0.5 : 1) : 0);

export function sourcingScore(def: ModuleDef, margins: PreviewMargin[]): number {
  const applicable = new Map(margins.map((m) => [m.attribute, m.applicable]));
  const items = def.attributes.map((a) => ({ w: Math.max(1, applicable.get(a.key) ?? 1), s: provenanceScore(a) }));
  const avgW = items.reduce((s, i) => s + i.w, 0) / Math.max(1, items.length);
  for (const t of Object.values(def.tables)) items.push({ w: avgW, s: provenanceScore(t) });
  const total = items.reduce((s, i) => s + i.w, 0);
  return total ? items.reduce((s, i) => s + i.w * i.s, 0) / total : 0;
}

export function marginsScore(def: ModuleDef, checks: { total: number; passed: number }): number {
  const categorical = def.attributes.filter((a) => a.type === "enum" || a.type === "set").map((a) => a.key);
  const covered = new Set<string>();
  const v = def.validation;
  for (const m of v.margins) covered.add(m.attribute);
  for (const p of v.plausibility) {
    covered.add(p.group_by);
    covered.add(p.value);
  }
  for (const s of v.shares) {
    for (const c of [s.among, s.share_of]) if (c !== undefined) for (const r of condRefs(c, def)) covered.add(r);
  }
  const coverage = categorical.length ? categorical.filter((k) => covered.has(k)).length / categorical.length : checks.total ? 1 : 0;
  const success = checks.total ? checks.passed / checks.total : 0;
  return coverage * success;
}

const WEIGHT_1 = [/très rare/, /n'est jamais tirée/, /n'est jamais présent/, /conditionnement n'a pas d'effet/];
const WEIGHT_2 = [/Cible déclarée non atteinte/, /semble professionnel/];

export function alertWeight(a: PreviewAlert): number {
  if (WEIGHT_2.some((re) => re.test(a.message))) return 2;
  if (WEIGHT_1.some((re) => re.test(a.message))) return 1;
  return 0;
}

export function alertsScore(alerts: PreviewAlert[]): number {
  return 1 - Math.min(1, alerts.reduce((s, a) => s + alertWeight(a), 0) / 5);
}

export function docsScore(def: ModuleDef): number {
  const criteria = [(def.description ?? "").trim().length > 80, def.changelog.length > 0, def.card.length > 0, def.segments.length > 0];
  return criteria.filter(Boolean).length / criteria.length;
}

export function computeQuality(input: QualityInput): QualityScore {
  const sourcing = round(sourcingScore(input.def, input.margins));
  const margins = round(marginsScore(input.def, input.checks));
  const alerts = round(alertsScore(input.alerts));
  const docs = round(docsScore(input.def));
  const q = round(100 * (Q_WEIGHTS.sourcing * sourcing + Q_WEIGHTS.margins * margins + Q_WEIGHTS.alerts * alerts + Q_WEIGHTS.docs * docs), 1);
  return { formula: "q1", q, sourcing, margins, alerts, docs };
}
