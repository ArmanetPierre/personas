import type { Persona, Project } from "../db/schema";
import type { Pack } from "../personas/pack";
import { buildSystemPrompt, constraintsBlock, personaCard } from "../studies/protocols/concept-price";
import { priceTiersFor } from "../studies/project";
import { audienceOf, type Audience } from "../studies/locale";

/**
 * Pré-tri de la pertinence (méthode A de docs/research/eval-tri.md, appliquée à la question
 * « concerné·e / marginal·e / pas concerné·e » du protocole) : prompts.
 *
 * Le prompt système reprend mot pour mot celui du protocole concept-price (rôle, règles, offre),
 * sans sa consigne de sortie ; les trois définitions de pertinence sont celles du protocole.
 * Le prompt utilisateur reprend la fiche (restreinte aux modules de la population), le portrait s'il
 * existe et les contraintes ; la situation de découverte est omise (elle ne change pas le besoin).
 */

export const RELEVANCE_LABELS = ["concerned", "marginal", "not_concerned"] as const;
export type RelevanceLabel = (typeof RELEVANCE_LABELS)[number];
export type RelevanceProbs = Record<RelevanceLabel, number>;

export type LabelOrder = "direct" | "reverse";
export const LABEL_ORDERS: LabelOrder[] = ["direct", "reverse"];

/** Ordre de présentation : chiffre affiché (1, 2, 3) → étiquette. */
export function labelsInOrder(order: LabelOrder): RelevanceLabel[] {
  return order === "direct" ? [...RELEVANCE_LABELS] : [...RELEVANCE_LABELS].reverse();
}

const OUTPUT_HEADER = "## Ce que tu renvoies";

/** Définitions par défaut, identiques au protocole (relues dans son prompt quand c'est possible). */
const DEFAULT_DEFINITIONS: Record<RelevanceLabel, string> = {
  concerned: "tu as aujourd'hui le besoin auquel l'offre répond",
  marginal: "ce besoin existe mais reste faible, ponctuel ou lointain",
  not_concerned: "tu ne l'as pas",
};

const NAMES: Record<RelevanceLabel, string> = {
  concerned: "concerné·e",
  marginal: "marginalement concerné·e",
  not_concerned: "pas concerné·e",
};

/** Définitions lues dans la ligne « relevance » du prompt du protocole (repli : texte par défaut). */
export function relevanceDefinitions(protocolSystem: string): Record<RelevanceLabel, string> {
  const line = protocolSystem.split("\n").find((l) => l.startsWith("- relevance :"));
  const out = { ...DEFAULT_DEFINITIONS };
  if (!line) return out;
  const m = line.match(/"concerned" si (.+?) ; "marginal" si (.+?) ; "not_concerned" si (.+?)\.?$/);
  if (m) {
    out.concerned = m[1]!;
    out.marginal = m[2]!;
    out.not_concerned = m[3]!.replace(/\.$/, "");
  }
  return out;
}

const OUTPUT_HEADER_EN = "## What you return";
const DEFAULT_DEFINITIONS_EN: Record<RelevanceLabel, string> = {
  concerned: "you have today the need the offer addresses",
  marginal: "this need exists but remains weak, occasional or distant",
  not_concerned: "you do not have it",
};
const NAMES_EN: Record<RelevanceLabel, string> = { concerned: "concerned", marginal: "marginally concerned", not_concerned: "not concerned" };

/** Version anglaise (études en locale `en`) : même prompt que le protocole anglais, mêmes définitions. */
function relevanceSystemEn(project: Project, order: LabelOrder, audience: Audience): string {
  const protocol = buildSystemPrompt(project, priceTiersFor(project), "2", audience);
  const i = protocol.indexOf(OUTPUT_HEADER_EN);
  const context = (i < 0 ? protocol : protocol.slice(0, i)).trimEnd();
  const line = protocol.split("\n").find((l) => l.startsWith("- relevance:"));
  const defs = { ...DEFAULT_DEFINITIONS_EN };
  const m = line?.match(/"concerned" if (.+?); "marginal" if (.+?); "not_concerned" if (.+?)\.?$/);
  if (m) {
    defs.concerned = m[1]!;
    defs.marginal = m[2]!;
    defs.not_concerned = m[3]!.replace(/\.$/, "");
  }
  const list = labelsInOrder(order)
    .map((l, k) => `${k + 1}: ${NAMES_EN[l]}: ${defs[l]}`)
    .join("\n");
  return `${context}

${OUTPUT_HEADER_EN}
Only one thing: are you concerned by this offer, today, in your life as your profile and your portrait describe it? This is not about whether you like the idea or what you would do, only whether you have the need it addresses. You answer with a single digit, among:
${list}

Reply with the digit alone, without any other text.`;
}

/** Prompt système du tri pour un projet et un ordre d'étiquettes (`audience` : langue du socle de la cible). */
export function relevanceSystem(project: Project, order: LabelOrder, audience?: Audience): string {
  if (audience?.locale === "en") return relevanceSystemEn(project, order, audience);
  const protocol = buildSystemPrompt(project, priceTiersFor(project));
  const i = protocol.indexOf(OUTPUT_HEADER);
  const context = (i < 0 ? protocol : protocol.slice(0, i)).trimEnd();
  const defs = relevanceDefinitions(protocol);
  const list = labelsInOrder(order)
    .map((l, k) => `${k + 1} : ${NAMES[l]} : ${defs[l]}`)
    .join("\n");
  return `${context}

${OUTPUT_HEADER}
Une seule chose : es-tu concerné·e par cette offre, aujourd'hui, dans ta vie telle que la décrivent ta fiche et ton portrait ? Il ne s'agit pas de dire si l'idée te plaît ni ce que tu ferais, seulement si tu as le besoin auquel elle répond. Tu réponds par un seul chiffre, parmi :
${list}

Réponds par le chiffre seul, sans aucun autre texte.`;
}

/** Prompt utilisateur : fiche (modules de la population), portrait éventuel, contraintes. */
export function relevanceUser(pack: Pack, p: Persona, modules?: string[]): string {
  if (pack.manifest.locale === "en") {
    const portraitEn = p.narrative?.trim()
      ? `### Portrait (written in the third person: it is you)\n${p.narrative.trim()}`
      : "### Portrait\n(No portrait: rely on the profile alone, without embellishing.)";
    return `## Who you are
${personaCard(pack, p, modules)}

${portraitEn}

## Your constraints this month
${constraintsBlock(p, audienceOf(pack))}

Reply now with the digit alone.`;
  }
  const portrait = p.narrative?.trim()
    ? `### Portrait (écrit à la troisième personne : c'est toi)\n${p.narrative.trim()}`
    : "### Portrait\n(Pas de portrait : appuie-toi sur la fiche seule, sans broder.)";
  return `## Qui tu es
${personaCard(pack, p, modules)}

${portrait}

## Tes contraintes ce mois-ci
${constraintsBlock(p)}

Réponds maintenant par le chiffre seul.`;
}

export interface TopLogprob {
  token: string;
  logprob: number;
}

/**
 * Probabilités des trois étiquettes à partir des log-probabilités du premier token :
 * somme des tokens « 1 », « 2 », « 3 » (espaces ignorés), renormalisée sur ces trois chiffres.
 * `mass` : masse totale des chiffres avant renormalisation (faible : le modèle n'a pas répondu par un chiffre).
 */
export function digitProbs(top: TopLogprob[], order: LabelOrder): { probs: RelevanceProbs; mass: number } {
  const labels = labelsInOrder(order);
  const raw: RelevanceProbs = { concerned: 0, marginal: 0, not_concerned: 0 };
  let mass = 0;
  for (const t of top) {
    const d = t.token.trim();
    if (!/^[1-3]$/.test(d)) continue;
    const p = Math.exp(t.logprob);
    raw[labels[Number(d) - 1]!] += p;
    mass += p;
  }
  if (mass <= 0) return { probs: { concerned: NaN, marginal: NaN, not_concerned: NaN }, mass: 0 };
  return {
    probs: { concerned: raw.concerned / mass, marginal: raw.marginal / mass, not_concerned: raw.not_concerned / mass },
    mass,
  };
}

/** Moyenne des distributions des deux ordres (corrige le biais de position). */
export function averageProbs(list: RelevanceProbs[]): RelevanceProbs {
  const ok = list.filter((p) => RELEVANCE_LABELS.every((l) => Number.isFinite(p[l])));
  if (!ok.length) return { concerned: NaN, marginal: NaN, not_concerned: NaN };
  const out: RelevanceProbs = { concerned: 0, marginal: 0, not_concerned: 0 };
  for (const p of ok) for (const l of RELEVANCE_LABELS) out[l] += p[l] / ok.length;
  return out;
}

export function argmaxLabel(p: RelevanceProbs): RelevanceLabel {
  return RELEVANCE_LABELS.reduce((best, l) => (p[l] > p[best] ? l : best), "concerned" as RelevanceLabel);
}
