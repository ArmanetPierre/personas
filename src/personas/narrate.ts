import { isBudgetExceeded } from "../engine/budget";
import { z } from "zod";
import type { Engine } from "../engine/engine";
import type { Usage } from "../engine/types";
import type { Persona } from "../db/schema";
import { describeForPrompt } from "./describe";
import { stripAccents, type Pack } from "./pack";

/**
 * Récits des personas, écrits par le LLM à partir des attributs tirés.
 *
 * Choix : récit à la TROISIÈME personne. C'est une fiche descriptive neutre que
 * les protocoles d'étude injecteront ensuite (« Tu es la personne décrite
 * ci-dessous… ») ; la voix à la première personne est réservée aux réponses
 * d'étude. Elle évite aussi de mélanger la voix du persona et les consignes.
 */

export const NARRATIVE_MIN_WORDS = 80;
export const NARRATIVE_MAX_WORDS = 150;
/** Tolérance du contrôle automatique (le modèle compte mal les mots). */
const CHECK_MIN_WORDS = 65;
const CHECK_MAX_WORDS = 175;

export const narrativeBatchSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).describe("Identifiant de la persona, recopié tel quel"),
        narrative: z.string().min(1).describe("Récit de 80 à 150 mots, à la troisième personne"),
      }),
    )
    .min(1),
});
export type NarrativeBatch = z.infer<typeof narrativeBatchSchema>;

/** Même schéma, descriptions en anglais (récits en locale `en`). */
export const narrativeBatchSchemaEn = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).describe("Persona identifier, copied as is"),
        narrative: z.string().min(1).describe("Narrative of 80 to 150 words, in the third person"),
      }),
    )
    .min(1),
});

export const NARRATIVE_SYSTEM = [
  "Tu rédiges de courtes fiches biographiques de personnes ordinaires vivant en France, pour un panel d'études de marché.",
  "Les attributs fournis sont des FAITS tirés de statistiques officielles : tu ne les modifies jamais, tu ne les contredis jamais, tu n'en inventes pas d'incompatibles (autre âge, autre ville, autre métier, autre composition du foyer, autres revenus).",
  "Ton travail : rendre la personne concrète, singulière et crédible, sans cliché et sans complaisance.",
  "Règles d'écriture :",
  `- ${NARRATIVE_MIN_WORDS} à ${NARRATIVE_MAX_WORDS} mots, en français, à la troisième personne, en un seul paragraphe.`,
  "- Commence exactement par « Prénom, N ans, » avec le prénom et l'âge fournis, puis enchaîne sur l'angle d'entrée indiqué pour cette personne.",
  "- Inclus une habitude concrète, une petite gêne du quotidien et une contrainte réelle (argent, temps, santé, logement, transport, famille), mais fondus dans le récit, dans l'ordre que tu veux, sans les annoncer.",
  "- VARIÉTÉ : chaque récit d'un même lot a une construction différente. Suis l'angle d'entrée et le type de fin indiqués pour chaque personne. N'utilise jamais de formule-étiquette du type « Son irritant : », « Ce qui l'agace : », « Ce qui l'irrite : », « Sa contrainte principale », « Ses irritants ». Ne termine pas systématiquement sur un agacement.",
  "- Détails propres à la personne (son métier, son coin, sa famille, ses goûts, son logement) plutôt que des clichés numériques génériques : jamais de « mots de passe », de « mises à jour », d'« applis qui changent tout le temps » ni de « boutons qui changent de place ».",
  "- Si la fiche décrit un métier et un projet de création d'entreprise : le récit parle concrètement du métier et du rapport au projet, avec ses nuances (envie velléitaire, hésitation, report, contraintes, freins indiqués). Ce n'est pas un startuppeur enthousiaste par défaut : respecte le stade, la préférence solo ou à plusieurs et les freins tels qu'ils sont donnés.",
  "- Ne parle de publicité, de démarchage ou de méfiance envers les nouveautés QUE si la fiche indique une méfiance marquée.",
  "- Respecte la tonalité indiquée : elle décrit l'humeur et le caractère (joviale, enthousiaste, sereine, pressée, méfiante, lasse…), pas l'attitude d'achat. Une personne gaie ou à l'aise reste attentive à son argent et à son temps ; une personne lasse n'est pas forcément malheureuse. Évite le misérabilisme comme l'enthousiasme de commande.",
  "- Le rapport à la technologie suit le profil d'adoption et l'équipement : la plupart des gens ne sont pas passionnés de technologie, sans pour autant la rejeter. Le numérique n'est pas forcément un sujet du récit.",
  "- AU PLUS UN montant chiffré dans tout le récit (aucun, c'est très bien). Ne récite pas la fiche : traduis les chiffres en situations (« fin de mois serrée », « pas de souci d'argent », « garde son forfait le moins cher »). Le montant éventuel doit être l'un de ceux fournis.",
  "- Pas de nom de ville hors de la région indiquée pour le lieu de vie (tu peux ne citer aucune ville).",
  "- Pas de morale, pas de conclusion positive forcée, pas de liste à puces.",
  "Réponds uniquement par le JSON demandé.",
].join("\n");

/**
 * Consigne des récits en anglais (socles en locale `en`, ex. Singapour) : mêmes règles que la version
 * française (faits intangibles, pas de cliché, pas de complaisance, au plus un montant), plus le respect
 * du statut de résidence, de l'ethnie, de la religion et du logement tels qu'ils sont tirés.
 */
/** Consignes propres au pays (contraintes typiques, stéréotypes à éviter) ; Singapour : texte d'origine. */
const COUNTRY_LINES_EN: Record<string, { constraint: string; stereotypes: string; facts: string }> = {
  "the United States": {
    constraint: "(money, time, health, health insurance, housing, transport, debt, family, work)",
    stereotypes:
      "- No stereotypes tied to race, ethnicity, origin, immigration status, religion or region: no caricatured accent or dialect, no exoticism; a person with a low income is not miserable by default, an immigrant is not defined by their origin, a rural or Southern resident is not a caricature, a well-off person is not carefree by default. Write in standard American English; a local word is fine when natural.",
    facts: "another age, another place, another job, another household composition, another income, another race or origin, another health coverage or type of housing",
  },
};

export function narrativeSystemEn(countryName: string): string {
  const c = COUNTRY_LINES_EN[countryName];
  if (c) return narrativeSystemLines(countryName, c).join("\n");
  return [
    `You write short biographical profiles of ordinary people living in ${countryName}, for a market research panel.`,
    "The attributes provided are FACTS drawn from official statistics: you never change them, never contradict them and never invent incompatible ones (another age, another place, another job, another household composition, another income, another residency status, ethnicity, religion or type of housing).",
    "Your job: make the person concrete, singular and credible, without clichés and without complacency.",
    "Writing rules:",
    `- ${NARRATIVE_MIN_WORDS} to ${NARRATIVE_MAX_WORDS} words, in English, in the third person, in a single paragraph.`,
    "- Start exactly with “Name, N,” using the name and age provided, then continue with the opening angle given for this person.",
    "- Include a concrete habit, a small everyday annoyance and a real constraint (money, time, health, housing, transport, family, work pass), woven into the story, in any order, without announcing them.",
    "- VARIETY: each narrative in a batch has a different construction. Follow the opening angle and the type of ending given for each person. Never use label formulas such as “Pet peeve:”, “What annoys him:”, “Her main constraint”. Do not systematically end on an annoyance.",
    "- Details specific to the person (their job, their neighbourhood, their family, their tastes, their housing) rather than generic digital clichés: never “passwords”, “software updates”, “apps that keep changing” or “buttons that move around”.",
    "- No stereotypes tied to ethnicity, religion, nationality or residency status: no caricatured Singlish, no exoticism, no “kiasu” cliché; a migrant worker or a domestic worker is not miserable by default, an expatriate is not wealthy and carefree by default. Write in standard English; a local word is fine when natural (hawker centre, kopitiam, void deck).",
    "- If the profile describes a job and a plan to start a business: the narrative talks concretely about the job and the relationship with the project, with its nuances (half-hearted wish, hesitation, postponement, constraints, stated obstacles). Not an enthusiastic startup founder by default.",
    "- Only mention advertising, cold calls or distrust of novelties IF the profile indicates marked distrust.",
    "- Respect the tone given: it describes mood and character (cheerful, enthusiastic, serene, rushed, wary, weary…), not the attitude to buying. A cheerful or comfortable person still watches their money and time; a weary person is not necessarily unhappy. Avoid both misery and forced enthusiasm.",
    "- The relationship with technology follows the adoption profile and the equipment: most people are not passionate about technology, without rejecting it. Technology need not be a topic of the narrative.",
    "- AT MOST ONE figure with an amount in the whole narrative (none is fine). Do not recite the profile: translate figures into situations (“tight end of the month”, “no money worries”, “keeps the cheapest mobile plan”). Any amount must be one of those provided.",
    "- No place of residence other than the one given (you may name no place at all).",
    "- No moral, no forced positive conclusion, no bullet list.",
    "Reply only with the requested JSON.",
  ].join("\n");
}

/** Même consigne que Singapour, avec les lignes propres au pays. */
function narrativeSystemLines(countryName: string, c: { constraint: string; stereotypes: string; facts: string }): string[] {
  const sg = narrativeSystemEn("Singapore").split("\n");
  return sg.map((l) => {
    if (l.startsWith("You write short biographical profiles")) return l.replace("Singapore", countryName);
    if (l.startsWith("The attributes provided are FACTS")) return `The attributes provided are FACTS drawn from official statistics: you never change them, never contradict them and never invent incompatible ones (${c.facts}).`;
    if (l.startsWith("- Include a concrete habit")) return l.replace("(money, time, health, housing, transport, family, work pass)", c.constraint);
    if (l.startsWith("- No stereotypes tied to")) return c.stereotypes;
    return l;
  });
}

export const OPENING_ANGLES_EN = [
  "a precise scene from an ordinary day (place, moment, gesture)",
  "a habit or ritual that defines them",
  "a character trait illustrated by an anecdote",
  "their current life situation (household, housing, stage of life)",
  "their work or former working life, seen from the inside",
  "an important relationship (partner, child, parent, neighbour, colleague)",
  "a taste, passion or hobby (not digital)",
  "a current worry or plan",
  "their relationship with money, shown through a concrete behaviour",
  "their neighbourhood (estate, town, commute) and what they do there",
] as const;

export const ENDINGS_EN = [
  "a plan or wish, even a modest one",
  "a concrete and unexpected detail",
  "a habit that sums the person up",
  "a relationship or someone around them",
  "a constraint that weighs on their choices",
  "a small pleasure they would not give up",
] as const;

/** Consigne système des récits d'un pack : française (historique) ou anglaise. */
export function narrativeSystemFor(pack: Pack): string {
  return pack.manifest.locale === "en" ? narrativeSystemEn(pack.manifest.country === "SG" ? "Singapore" : pack.manifest.country === "US" ? "the United States" : pack.manifest.country) : NARRATIVE_SYSTEM;
}

/** Angles d'entrée : un par persona, tous différents dans un lot de 10. */
export const OPENING_ANGLES = [
  "une scène précise d'une journée ordinaire (lieu, moment, geste)",
  "une habitude ou un rituel qui la définit",
  "un trait de caractère illustré par une anecdote",
  "sa situation de vie actuelle (foyer, logement, étape de vie)",
  "son travail ou son ancienne vie professionnelle, vu de l'intérieur",
  "une relation importante (conjoint, enfant, parent, voisin, collègue)",
  "un goût, une passion ou un loisir (pas numérique)",
  "un souci ou un projet du moment",
  "son rapport à l'argent, montré par un comportement concret",
  "son coin de vie (quartier, village, trajets) et ce qu'elle y fait",
] as const;

/** Types de fin, en rotation décalée par rapport aux angles d'entrée. */
export const ENDINGS = [
  "un projet ou une envie, même modeste",
  "un détail concret et inattendu",
  "une habitude qui résume la personne",
  "une relation ou une personne de son entourage",
  "une contrainte qui pèse sur ses choix",
  "un petit plaisir qu'elle ne lâcherait pas",
] as const;

export function buildNarrativePrompt(
  pack: Pack,
  personas: Persona[],
  retryNotes: Map<string, string[]> = new Map(),
): string {
  if (pack.manifest.locale === "en") return buildNarrativePromptEn(pack, personas, retryNotes);
  const offset = personas[0]?.drawIndex ?? 0;
  const cards = personas.map((p, i) => {
    const notes = retryNotes.get(p.id);
    const fix = notes?.length
      ? `\nATTENTION, la version précédente a été rejetée : ${notes.join(" ; ")}. Corrige ce point.`
      : "";
    // Rotation décalée par le lot : angles distincts dans un lot (≤ 10), combinaisons variées d'un lot à l'autre.
    const angle = OPENING_ANGLES[(i + offset * 3) % OPENING_ANGLES.length]!;
    const ending = ENDINGS[(i + offset) % ENDINGS.length]!;
    return `### id: ${p.id}\n${describeForPrompt(pack, p, { modules: pack.manifest.rngStreams !== "module" })}\nConstruction : commencer par « ${p.firstName ?? "Prénom"}, ${p.age} ans, » puis entrer par ${angle} ; finir sur ${ending}.${fix}`;
  });
  return [
    `Écris un récit pour chacune des ${personas.length} personnes ci-dessous.`,
    'Renvoie {"items": [{"id": "...", "narrative": "..."}]} avec exactement un élément par id, ids recopiés à l\'identique.',
    "",
    ...cards,
  ].join("\n\n");
}

function buildNarrativePromptEn(pack: Pack, personas: Persona[], retryNotes: Map<string, string[]>): string {
  const offset = personas[0]?.drawIndex ?? 0;
  const cards = personas.map((p, i) => {
    const notes = retryNotes.get(p.id);
    const fix = notes?.length ? `\nWARNING, the previous version was rejected: ${notes.join("; ")}. Fix this point.` : "";
    const angle = OPENING_ANGLES_EN[(i + offset * 3) % OPENING_ANGLES_EN.length]!;
    const ending = ENDINGS_EN[(i + offset) % ENDINGS_EN.length]!;
    return `### id: ${p.id}\n${describeForPrompt(pack, p, { modules: pack.manifest.rngStreams !== "module" })}\nConstruction: start with “${p.firstName ?? "Name"}, ${p.age},” then open with ${angle}; end on ${ending}.${fix}`;
  });
  return [
    `Write a narrative for each of the ${personas.length} people below.`,
    'Return {"items": [{"id": "...", "narrative": "..."}]} with exactly one item per id, ids copied exactly.',
    "",
    ...cards,
  ].join("\n\n");
}

export interface BatchOutcome {
  /** Récits acceptés, par id. */
  accepted: Map<string, string>;
  /** Récits rejetés par le contrôle de cohérence, avec les motifs. */
  rejected: Map<string, string[]>;
  /** Ids demandés mais absents de la réponse. */
  missing: string[];
  /** Ids renvoyés mais non demandés (ignorés). */
  unexpected: string[];
}

/** Apparie la réponse du modèle aux personas demandées et contrôle chaque récit. */
export function matchBatch(pack: Pack, personas: Persona[], data: NarrativeBatch): BatchOutcome {
  const byId = new Map(personas.map((p) => [p.id, p]));
  const accepted = new Map<string, string>();
  const rejected = new Map<string, string[]>();
  const unexpected: string[] = [];
  for (const item of data.items) {
    const id = item.id.trim();
    const persona = byId.get(id);
    if (!persona) {
      unexpected.push(id);
      continue;
    }
    if (accepted.has(id) || rejected.has(id)) continue; // doublon : on garde le premier
    const narrative = item.narrative.trim().replace(/\s+/g, " ");
    const issues = checkNarrative(pack, persona, narrative);
    if (issues.length) rejected.set(id, issues);
    else accepted.set(id, narrative);
  }
  const missing = personas.map((p) => p.id).filter((id) => !accepted.has(id) && !rejected.has(id));
  return { accepted, rejected, missing, unexpected };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

const normalize = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Mots qui, juste avant une ville, signalent un lien qui n'est pas le lieu de vie. */
const ELSEWHERE_CONTEXT =
  /(originaire|ne a|nee a|naissance|grandi|enfance|vacances|parents?|mere|pere|soeur|frere|fille|fils|enfants?|ex|ami|amie|amis|cousin|cousine|famille|week-end|weekend|demenag|quitte|ancien|ancienne|autrefois|etudes|etudie|stage|deplacement|train|tgv|visite|rendre visite|sejour|match|concert|club)\b[^.;]{0,40}$/;

/**
 * Contrôle de cohérence simple : âge, ville, longueur, clichés.
 * Renvoie la liste des problèmes (vide si le récit est accepté).
 */
export function checkNarrative(pack: Pack, p: Persona, narrative: string): string[] {
  if (pack.manifest.locale === "en") return checkNarrativeEn(pack, p, narrative);
  const issues: string[] = [];
  const words = countWords(narrative);
  if (words < CHECK_MIN_WORDS || words > CHECK_MAX_WORDS) {
    issues.push(`longueur hors bornes (${words} mots au lieu de ${NARRATIVE_MIN_WORDS} à ${NARRATIVE_MAX_WORDS})`);
  }

  // Âge : le récit commence par « Prénom, N ans » ; toute mention « Prénom … N ans » doit valoir l'âge.
  const text = normalize(narrative);
  const name = p.firstName ? normalize(p.firstName) : undefined;
  if (name && !text.startsWith(name)) {
    issues.push(`le récit doit commencer par le prénom « ${p.firstName} »`);
  }
  const ageRe = /(\d{1,3})\s*ans\b/g;
  const head = text.slice(0, (name?.length ?? 0) + 25);
  const headAge = /(\d{1,3})\s*ans\b/.exec(head);
  if (!headAge) issues.push(`l'âge (${p.age} ans) doit figurer au début du récit`);
  else if (Number(headAge[1]) !== p.age) issues.push(`âge contradictoire (${headAge[1]} ans au lieu de ${p.age})`);
  for (const m of text.matchAll(ageRe)) {
    const n = Number(m[1]);
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    // « elle a 52 ans », « âgée de 52 ans » sans autre sujet entre-temps
    if (n !== p.age && n >= 18 && /\b(elle|il)\s+a\s*$|\bagee?\s+de\s*$/.test(before) && !/\b(son|sa|ses|leur)\b/.test(before)) {
      issues.push(`âge contradictoire (« ${n} ans »)`);
      break;
    }
  }

  // Villes : aucune grande ville d'une autre région comme lieu de vie (recherche sensible à la casse :
  // « Tours » la ville, pas « des tours »).
  const cased = stripAccents(narrative);
  for (const city of pack.cityIndex) {
    if (city.region === p.region) continue;
    const re = new RegExp(`(?<![\\p{L}-])${escapeRe(city.normalized)}(?![\\p{L}-])`, "gu");
    for (const m of cased.matchAll(re)) {
      const before = cased.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
      if (ELSEWHERE_CONTEXT.test(before)) continue;
      issues.push(`ville hors région : ${city.name} (${pack.regionName(city.region)}) pour une persona en ${pack.regionName(p.region)}`);
      break;
    }
  }

  // Formules-étiquettes et clichés numériques interdits
  const lower = stripAccents(narrative).toLowerCase();
  for (const f of BANNED_PHRASES) {
    if (f.re.test(lower)) issues.push(`formule interdite : « ${f.label} »`);
  }
  // Publicité et démarchage : seulement si le scepticisme est élevé
  if (p.skepticism < HIGH_SKEPTICISM && AD_MENTION.test(lower)) {
    issues.push(`mention de la publicité ou du démarchage alors que le scepticisme est ${p.skepticism.toFixed(2)} (< ${HIGH_SKEPTICISM})`);
  }

  // Montants : un seul au plus (« 1 437 € », « 45 euros », « 2,99 € »).
  const amounts = countAmounts(narrative);
  if (amounts > MAX_AMOUNTS) issues.push(`${amounts} montants chiffrés (${MAX_AMOUNTS} au plus)`);

  // Clichés : « passionné de technologie » réservé aux innovateurs et adopteurs précoces.
  if (
    !["innovator", "early_adopter"].includes(p.techAdoption) &&
    /passionne(e|s)?\s+(de|par)\s+(la\s+|les\s+)?(tech|nouvelles technologies|numerique|high-tech|gadgets?|informatique)/.test(text)
  ) {
    issues.push("cliché « passionné de technologie » incohérent avec le profil d'adoption");
  }
  return issues;
}

export const MAX_AMOUNTS = 1;

/** Formules et clichés interdits en anglais (texte en minuscules). */
export const BANNED_PHRASES_EN: Array<{ label: string; re: RegExp }> = [
  { label: "pet peeve", re: /\bpet peeves?\b/ },
  { label: "what annoys / irritates", re: /\bwhat (really )?(annoys|irritates|bugs) (him|her|them)\b/ },
  { label: "main constraint", re: /\bmain constraint\b/ },
  { label: "passwords", re: /\bpasswords?\b/ },
  { label: "software updates", re: /\b(software )?updates? (that|which) keep\b|\bconstant updates\b/ },
];
export const AD_MENTION_EN = /\bads?\b|advertis|telemarket|cold[- ]call|door-to-door sales|scam calls?/;

/** Montants en anglais (« S$1,437 », « $45 », « 45 dollars », « €12 »). */
export function countAmountsEn(text: string): number {
  return [...text.matchAll(/(s\$|us\$|\$|€|£)\s?\d[\d,.]*|\d[\d,.]*\s*(dollars?|sgd|euros?)\b/giu)].length;
}

/** Contrôle d'un récit anglais : longueur, prénom et âge en tête, formules interdites, publicité, montants, clichés. */
function checkNarrativeEn(pack: Pack, p: Persona, narrative: string): string[] {
  const issues: string[] = [];
  const words = countWords(narrative);
  if (words < CHECK_MIN_WORDS || words > CHECK_MAX_WORDS) issues.push(`length out of bounds (${words} words instead of ${NARRATIVE_MIN_WORDS} to ${NARRATIVE_MAX_WORDS})`);
  const text = normalize(narrative);
  const name = p.firstName ? normalize(p.firstName) : undefined;
  if (name && !text.startsWith(name)) issues.push(`the narrative must start with the name “${p.firstName}”`);
  const head = text.slice((name?.length ?? 0), (name?.length ?? 0) + 12);
  const headAge = /\b(\d{1,3})\b/.exec(head);
  if (!headAge) issues.push(`the age (${p.age}) must appear at the start of the narrative`);
  else if (Number(headAge[1]) !== p.age) issues.push(`contradictory age (${headAge[1]} instead of ${p.age})`);
  for (const m of text.matchAll(/\b(?:(?:he|she) is|aged) (\d{1,3})\b|\b(\d{1,3})[- ]years?[- ]old\b/g)) {
    const n = Number(m[1] ?? m[2]);
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (n !== p.age && n >= 18 && !/\b(his|her|their|a|an)\b[^.]*$/.test(before) && (m[1] !== undefined || /\b(he|she|is|aged)\s*$/.test(before))) {
      issues.push(`contradictory age (“${m[0]}”)`);
      break;
    }
  }
  const lower = narrative.toLowerCase();
  for (const f of BANNED_PHRASES_EN) if (f.re.test(lower)) issues.push(`banned phrase: “${f.label}”`);
  if (p.skepticism < HIGH_SKEPTICISM && AD_MENTION_EN.test(lower)) {
    issues.push(`mentions advertising or cold calls while skepticism is ${p.skepticism.toFixed(2)} (< ${HIGH_SKEPTICISM})`);
  }
  const amounts = countAmountsEn(narrative);
  if (amounts > MAX_AMOUNTS) issues.push(`${amounts} amounts (${MAX_AMOUNTS} at most)`);
  if (!["innovator", "early_adopter"].includes(p.techAdoption) && /passionate about (tech|technology|gadgets|computers)|tech enthusiast|gadget lover/.test(lower)) {
    issues.push("cliché “passionate about technology” inconsistent with the adoption profile");
  }
  // Lieu de vie : pas d'autre planning area de Singapour présentée comme lieu de vie, pas de mention contraire.
  void pack;
  return issues;
}

/** Seuil de scepticisme à partir duquel la méfiance (pub, démarchage, nouveautés) peut être évoquée. */
export const HIGH_SKEPTICISM = 0.6;

/** Mention de la publicité ou du démarchage (texte sans accents, en minuscules) ; « avec pub » (offre Netflix) et la prospection de clients ne comptent pas. */
export const AD_MENTION = /(?<!avec )\bpub\b|publicit|demarchage (telephonique|a domicile)|demarcheurs?\b|reclame/;

/** Formules-modèles et clichés interdits (texte sans accents, en minuscules). */
export const BANNED_PHRASES: Array<{ label: string; re: RegExp }> = [
  { label: "son irritant / ses irritants", re: /\b(son|ses|un|l')\s*irritants?\b/ },
  { label: "ce qui l'agace", re: /ce qui l'agace/ },
  { label: "ce qui l'irrite", re: /ce qui l'irrite/ },
  { label: "contrainte principale", re: /contrainte principale/ },
  { label: "mots de passe", re: /mots? de passe/ },
  { label: "mises à jour", re: /mises? a jour/ },
];

/** Expressions suivies dans le rapport de fréquence (racines, texte sans accents, minuscules). */
export const TRACKED_STEMS = ["publicit", "demarchage", "irritant", "agace", "irrite", "contrainte principale", "mots de passe", "mises a jour", "fins de mois", "se mefie"];

export interface FrequencyReport {
  narratives: number;
  /** Nombre de récits contenant chaque racine suivie. */
  tracked: Record<string, number>;
  /** N-grammes (n = 4) les plus fréquents : nombre de récits qui les contiennent. */
  topNgrams: Array<[string, number]>;
}

/** Rapport de fréquence : expressions suivies et n-grammes répétés d'un récit à l'autre. */
export function frequencyReport(texts: string[], n = 4, top = 15): FrequencyReport {
  const tracked = Object.fromEntries(TRACKED_STEMS.map((s) => [s, 0])) as Record<string, number>;
  const grams = new Map<string, number>();
  for (const t of texts) {
    const low = stripAccents(t).toLowerCase();
    for (const s of TRACKED_STEMS) if (low.includes(s)) tracked[s]!++;
    const words = low.replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    for (let i = 0; i + n <= words.length; i++) {
      const g = words.slice(i, i + n).join(" ");
      if (/^\p{Lu}/u.test(g) || /\d/.test(g)) continue;
      seen.add(g);
    }
    for (const g of seen) grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const topNgrams = [...grams].sort((a, b) => b[1] - a[1]).slice(0, top);
  return { narratives: texts.length, tracked, topNgrams };
}

export function formatFrequencyReport(r: FrequencyReport): string {
  const pct = (k: number) => `${k} (${((k / Math.max(1, r.narratives)) * 100).toFixed(0)} %)`;
  return [
    `Fréquences sur ${r.narratives} récit(s) (nombre de récits contenant l'expression) :`,
    ...Object.entries(r.tracked).map(([s, k]) => `  ${s.padEnd(22)} ${pct(k)}`),
    "4-grammes les plus répétés :",
    ...r.topNgrams.map(([g, k]) => `  ${g.padEnd(40)} ${pct(k)}`),
  ].join("\n");
}

/** Nombre de montants en euros (« 1 437 € », « 45 euros », « 2,99 € », « 12 €/mois »). */
export function countAmounts(text: string): number {
  return [...text.matchAll(/\d[\d\s\u00a0\u202f.,]*\s*(€|euros?\b)/gu)].length;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface NarrateProgress {
  batches: number;
  written: number;
  rejected: number;
  failedBatches: number;
  usage: Usage;
  durationMs: number;
}

export interface NarrateOptions {
  batchSize?: number;
  /** Écriture en base d'un récit accepté (appelée au fil de l'eau). */
  save: (id: string, narrative: string, meta: { backend: string; model: string }) => void;
  log?: (msg: string) => void;
}

/**
 * Écrit les récits par lots (≈ 10 personas par appel). Les lots partent en
 * parallèle, dans la limite de concurrence du backend. Un récit rejeté par
 * le contrôle de cohérence, ou absent de la réponse, est redemandé une fois.
 */
export async function narratePersonas(
  engine: Engine,
  pack: Pack,
  personas: Persona[],
  opts: NarrateOptions,
): Promise<NarrateProgress & { stillMissing: Map<string, string[]>; aborted: string | null }> {
  const batchSize = opts.batchSize ?? 10;
  const log = opts.log ?? (() => {});
  const progress: NarrateProgress = {
    batches: 0,
    written: 0,
    rejected: 0,
    failedBatches: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    durationMs: 0,
  };
  const started = performance.now();
  const stillMissing = new Map<string, string[]>();

  const runBatch = async (batch: Persona[], notes: Map<string, string[]>, attempt: number) => {
    const res = await engine.complete({
      system: narrativeSystemFor(pack),
      messages: [{ role: "user", content: buildNarrativePrompt(pack, batch, notes) }],
      schema: pack.manifest.locale === "en" ? narrativeBatchSchemaEn : narrativeBatchSchema,
      maxTokens: 400 * batch.length + 500,
    });
    progress.batches++;
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
      progress.usage[k] = (progress.usage[k] ?? 0) + (res.usage[k] ?? 0);
    }
    const outcome = matchBatch(pack, batch, res.data);
    for (const [id, narrative] of outcome.accepted) {
      opts.save(id, narrative, { backend: res.backend, model: res.model });
      progress.written++;
    }
    const retry = new Map<string, string[]>(outcome.rejected);
    for (const id of outcome.missing) retry.set(id, ["récit absent de la réponse précédente"]);
    if (outcome.unexpected.length) log(`  ids inattendus ignorés : ${outcome.unexpected.join(", ")}`);
    log(
      `Lot ${attempt === 1 ? "" : "(reprise) "}de ${batch.length} : ${outcome.accepted.size} acceptés` +
        (outcome.rejected.size ? `, ${outcome.rejected.size} rejetés` : "") +
        (outcome.missing.length ? `, ${outcome.missing.length} absents` : "") +
        ` — ${(res.durationMs / 1000).toFixed(0)} s, ${res.usage.outputTokens} tokens en sortie`,
    );
    for (const [id, issues] of outcome.rejected) log(`  rejet ${id} : ${issues.join(" ; ")}`);
    return retry;
  };

  const batches: Persona[][] = [];
  for (let i = 0; i < personas.length; i += batchSize) batches.push(personas.slice(i, i + batchSize));

  // File de lots consommée par autant de workers que la concurrence du backend : en cas de limite
  // d'usage (quota Max atteint), on arrête de prendre de nouveaux lots ; une relance reprendra.
  let aborted: string | null = null;
  const handleError = (err: unknown, label: string) => {
    progress.failedBatches++;
    const msg = (err as Error).message;
    log(`${label} : ${msg}`);
    if (!aborted && (isUsageLimitError(msg) || isBudgetExceeded(err))) {
      aborted = msg;
      log("Limite d'usage atteinte : arrêt propre, relancer plus tard (seules les personas sans récit seront traitées).");
    }
  };
  const processBatch = async (batch: Persona[]) => {
    let retry: Map<string, string[]>;
    try {
      retry = await runBatch(batch, new Map(), 1);
    } catch (err) {
      handleError(err, "Lot en échec");
      retry = new Map(batch.map((p) => [p.id, [] as string[]]));
    }
    if (retry.size === 0) return;
    progress.rejected += [...retry.values()].filter((v) => v.length).length;
    const again = batch.filter((p) => retry.has(p.id));
    if (aborted) {
      for (const p of again) stillMissing.set(p.id, ["arrêt (limite d'usage)"]);
      return;
    }
    try {
      const left = await runBatch(again, retry, 2);
      for (const [id, issues] of left) stillMissing.set(id, issues);
    } catch (err) {
      handleError(err, "Lot de reprise en échec");
      for (const p of again) stillMissing.set(p.id, ["échec de l'appel"]);
    }
  };
  let next = 0;
  const workers = Array.from({ length: Math.max(1, engine.backend.concurrency) }, async () => {
    while (!aborted && next < batches.length) await processBatch(batches[next++]!);
  });
  await Promise.all(workers);
  const skipped = batches.slice(next).flat();
  for (const p of skipped) stillMissing.set(p.id, ["non traité (arrêt)"]);
  progress.durationMs = Math.round(performance.now() - started);
  return { ...progress, stillMissing, aborted };
}

/** Erreur de quota (abonnement Max) ou de limitation de débit : inutile d'insister. */
export function isUsageLimitError(message: string): boolean {
  return /usage limit|limit reached|rate.?limit|quota|too many requests|\b429\b|overloaded/i.test(message);
}
