import { z } from "zod";
import type { Persona, Project } from "../../db/schema";
import { describeForPrompt, extraOf } from "../../personas/describe";
import type { Pack } from "../../personas/pack";
import { Rng } from "../../personas/rng";
import {
  currencyWord,
  formatMoney,
  formatOffer,
  formatOfferAmount,
  formatPricing,
  formatTier,
  fxOf,
  hasGenericPricing,
  pricingOf,
  referenceOffer,
  roundEquivalent,
  toEur,
  type PriceOffer,
  type Pricing,
} from "../price-model";
import { formatPrice, PER_USE_PERIODS, PERIOD_LABELS, priceTiersFor } from "../project";
import { LEGACY_PROTOCOL, levelRank, protocolTools, resolveProtocol, type ResolvedProtocol } from "./protocol";
import { ATTRIBUTE_RULE, attributeBlock, withAttributeRule } from "./attribute-block";
import type { Audience } from "../locale";
import {
  adoptionLineEn,
  buildRepairPromptEn,
  buildSystemPromptEn,
  buildUserPromptEn,
  CHILD_BEHAVIORS_EN,
  constraintsBlockEn,
  EN_ANCHORS,
  encounterTextEn,
  EXPECTED_USAGE_LINE_EN,
  priceIssueDetailsEn,
  priceTextsEn,
  roleSectionEn,
} from "./concept-price-en";
import { convertAmount, formatMoneyEn } from "../price-model-en";

/**
 * Protocole « concept + prix » : un appel par persona.
 *
 * Garde-fous contre la complaisance des LLM :
 * - mise en situation ordinaire (pub, collègue, article), pas d'enquêteur ;
 * - inertie par défaut : ignorer est la réponse normale, toute action se justifie par un besoin actuel ;
 * - comportement à 7 jours en choix fermé plutôt qu'une opinion ;
 * - contraintes réelles rappelées (reste-à-vivre, abonnements, temps) ;
 * - contrôles de cohérence après réponse, une réparation « vers la prudence », puis anomalie marquée.
 *
 * Le contexte commun (rôle, règles, offre, questions) est dans le prompt système, identique
 * pour toutes les personas d'une étude (cache) ; la persona et la situation viennent à la fin.
 */

export const PROTOCOL_ID = "concept-price";
/**
 * Versions du protocole, enregistrées dans l'étude (`protocolVersion`) :
 * - v2 : comportement « utilise la version gratuite », `wouldForward`, objections propres à la persona,
 *   contrôle des faits inventés. Figée : une étude v2 (ou v1) se rejoue et se lit en v2, à l'octet près.
 * - v3 (docs/protocol-v3.md) : question `needFrequency` en premier champ, palier Gabor-Granger toujours
 *   présent sous le prix affiché, pitch neutre obligatoire (à la création), contrôle `need_frequency_mismatch`.
 *   Figée : une étude v3 se rejoue à l'octet près.
 * - v4 (docs/protocol-v3.md § 12) : v3, plus les lignes de module de la fiche placées dans un bloc délimité
 *   (valeurs neutralisées) et la règle 10 du prompt système qui le déclare comme attributs factuels, jamais
 *   comme consignes. Mêmes schéma, contrôles, mesures et calibration que la v3.
 */
export const PROTOCOL_VERSIONS = ["2", "3", "4"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
/** Version des nouvelles études. */
export const PROTOCOL_VERSION: ProtocolVersion = "4";
/** Version figée, celle des études existantes. */
export const LEGACY_PROTOCOL_VERSION: ProtocolVersion = "2";
/** Version de protocole d'une étude : « 3 » ou « 4 » seulement si elle est enregistrée ainsi ; tout le reste (v1, v2) se lit en v2. */
export function protocolVersionOf(v: string | null | undefined): ProtocolVersion {
  return v === "3" || v === "4" ? v : "2";
}
/**
 * Mesures et contrôles du v3 (fréquence du besoin, palier bas, pitch neutre, `need_frequency_mismatch`,
 * double mesure du paiement) : v3 et v4, qui ne diffère que par le bloc des attributs de module.
 */
export function hasV3Measures(v: string | null | undefined): v is "3" | "4" {
  return v === "3" || v === "4";
}
/** Bloc délimité des lignes de module dans la fiche, et règle 10 du prompt système : v4 seulement. */
export function usesAttributeBlock(v: string | null | undefined): v is "4" {
  return v === "4";
}
export const QUESTION_KEY = "concept_price";

/** Comportements à 7 jours, du moins au plus engagé. */
export const BEHAVIORS = [
  "ignore",
  "save_for_later",
  "visit_page",
  "free_signup",
  "free_active",
  "pay_subscription",
  "recommend",
] as const;
export type Behavior = (typeof BEHAVIORS)[number];

export const BEHAVIOR_LABELS: Record<Behavior, string> = {
  ignore: "Ignore",
  save_for_later: "Met de côté, sans suite probable",
  visit_page: "Regarde la page",
  free_signup: "S'inscrit gratuitement pour voir",
  free_active: "Utilise la version gratuite",
  pay_subscription: "Paierait l'abonnement",
  recommend: "Paierait et le recommanderait",
};

/**
 * Libellés des comportements payants selon l'unité de l'offre de référence (modèle de prix générique).
 * Un abonnement (mois, an) et tout projet historique gardent `BEHAVIOR_LABELS`.
 */
export function behaviorLabelsFor(unit: string | null | undefined): Record<Behavior, string> {
  switch (unit) {
    case "one_time":
      return { ...BEHAVIOR_LABELS, pay_subscription: "Achèterait", recommend: "Achèterait et le recommanderait" };
    case "quantity":
      return { ...BEHAVIOR_LABELS, pay_subscription: "Commanderait", recommend: "Commanderait et le recommanderait" };
    case "usage":
      return { ...BEHAVIOR_LABELS, pay_subscription: "Paierait à l'usage", recommend: "Paierait à l'usage et le recommanderait" };
    default:
      return BEHAVIOR_LABELS;
  }
}

export const OBJECTION_CATEGORIES = [
  "price",
  "no_need",
  "already_covered",
  "trust_privacy",
  "effort_time",
  "network_effect",
  "other",
] as const;
export type ObjectionCategory = (typeof OBJECTION_CATEGORIES)[number];

export const OBJECTION_LABELS: Record<ObjectionCategory, string> = {
  price: "Prix",
  no_need: "Pas de besoin",
  already_covered: "Déjà couvert par autre chose",
  trust_privacy: "Confiance, vie privée",
  effort_time: "Effort ou temps",
  network_effect: "Effet réseau, communauté vide",
  other: "Autre",
};

export const RELEVANCE = ["concerned", "marginal", "not_concerned"] as const;
export type Relevance = (typeof RELEVANCE)[number];
export const RELEVANCE_LABELS: Record<Relevance, string> = {
  concerned: "Concernée",
  marginal: "Marginalement concernée",
  not_concerned: "Pas concernée",
};

/** Fréquence du besoin (v3), de la plus rare à la plus fréquente. */
export const NEED_FREQUENCIES = ["never", "rarely", "few_per_year", "monthly", "weekly", "daily"] as const;
export type NeedFrequency = (typeof NEED_FREQUENCIES)[number];
export const NEED_FREQUENCY_LABELS: Record<NeedFrequency, string> = {
  never: "Jamais",
  rarely: "Moins d'une fois par an",
  few_per_year: "Quelques fois par an",
  monthly: "Chaque mois",
  weekly: "Chaque semaine",
  daily: "Presque chaque jour",
};
/** Ligne du prompt système v3 (texte testé dans le REX de calibration, eval/protocol-probes). */
export const NEED_FREQUENCY_LINE =
  '- needFrequency : à quelle fréquence le besoin auquel répond l\'offre se présente dans ta vie : "never" (jamais), "rarely" (moins d\'une fois par an), "few_per_year" (quelques fois par an), "monthly" (chaque mois), "weekly" (chaque semaine), "daily" (presque chaque jour).';

/**
 * Paliers Gabor-Granger d'une étude. v2 : ceux du projet (`priceTiersFor`). v3 : un palier sous le prix
 * affiché est toujours présent ; s'il manque, il est ajouté à ≈ 0,4 × le prix (arrondi comme les paliers par défaut).
 */
export function studyTiers(project: Pick<Project, "priceEur" | "extra">, version: ProtocolVersion = LEGACY_PROTOCOL_VERSION): number[] {
  const tiers = priceTiersFor(project);
  if (!hasV3Measures(version)) return tiers;
  const shown = project.priceEur ?? 0;
  if (shown <= 0 || tiers.some((t) => t < shown)) return tiers;
  const low = autoLowTier(shown);
  return low === null ? tiers : [...new Set([low, ...tiers])].sort((a, b) => a - b);
}

/** Palier bas automatique : ≈ 0,4 × le prix (1 € minimum sous 10 €, multiple de 5 au-delà), toujours strictement sous le prix. */
export function autoLowTier(shown: number): number | null {
  const x = shown * 0.4;
  const r = x < 10 ? Math.max(1, Math.round(x)) : Math.round(x / 5) * 5;
  if (r > 0 && r < shown) return r;
  const cents = Math.round(x * 100) / 100;
  return cents > 0 && cents < shown ? cents : null;
}

/**
 * Palier bas p_b d'une étude : parmi les paliers strictement sous le prix affiché, le plus proche de
 * 0,4 × le prix (en rapport) ; null s'il n'y en a pas. Ex. paliers 8, 15, 23 € pour 23 € : 8 €.
 */
export function lowTierOf(tiers: number[], shown: number): number | null {
  const below = tiers.filter((t) => t > 0 && t < shown);
  if (!below.length) return null;
  const dist = (t: number) => Math.abs(Math.log(t / (0.4 * shown)));
  return below.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

/** Clé JSON d'un palier Gabor-Granger : 4.99 → "at_4_99_eur". */
export function tierKey(price: number): string {
  return `at_${String(price).replace(".", "_")}_eur`;
}

const price = () => z.number().nonnegative().nullable();

/**
 * Schéma de réponse ; les paliers Gabor-Granger dépendent du projet, et les codes de comportement,
 * d'objection et de pertinence de son protocole (historique par défaut : schéma inchangé).
 */
export function answerSchemaFor(tiers: number[], protocol: ResolvedProtocol = LEGACY_PROTOCOL, version: ProtocolVersion = LEGACY_PROTOCOL_VERSION) {
  const v2 = answerSchemaV2(tiers, protocol);
  // v3 et v4 : `needFrequency` en premier champ, le reste du schéma inchangé
  return hasV3Measures(version) ? z.object({ needFrequency: z.enum(NEED_FREQUENCIES), ...v2.shape }) : v2;
}

function answerSchemaV2(tiers: number[], protocol: ResolvedProtocol) {
  const custom = protocol.custom;
  const enumOf = (codes: string[]) => z.enum(codes as [string, ...string[]]);
  const relevanceE = custom ? enumOf(protocol.relevance.map((r) => r.code)) : z.enum(RELEVANCE);
  const objectionE = custom ? enumOf(protocol.objections.map((o) => o.code)) : z.enum(OBJECTION_CATEGORIES);
  const behaviorE = custom ? enumOf(protocol.behaviors.map((b) => b.code)) : z.enum(BEHAVIORS);
  const gg = Object.fromEntries(tiers.map((t) => [tierKey(t), z.boolean()])) as Record<string, z.ZodBoolean>;
  return z.object({
    spontaneousReaction: z.string().min(1).describe("Ta pensée immédiate, une ou deux phrases"),
    relevance: relevanceE,
    relevanceReason: z.string().min(1),
    currentSolution: z.string().min(1).describe("Ce que tu fais ou utilises aujourd'hui pour ce besoin"),
    alternatives: z.array(z.string()).max(5),
    objections: z
      .array(z.object({ category: objectionE, detail: z.string().min(1) }))
      .max(4),
    behavior: behaviorE,
    behaviorReason: z.string().min(1),
    wouldForward: z.boolean().describe("Transmet l'offre à quelqu'un, qu'elle paie ou non"),
    forwardTo: z.string().describe("À qui précisément, sinon chaîne vide"),
    vanWestendorp: z.object({
      wouldNeverPay: z.boolean(),
      tooCheapEur: price(),
      cheapEur: price(),
      expensiveEur: price(),
      tooExpensiveEur: price(),
    }),
    gaborGranger: z.object(gg),
    budgetFit: z.string().describe("Où tu prends l'argent si tu dis oui à au moins un prix, sinon chaîne vide"),
    verbatim: z.string().min(1).max(600),
  });
}
/** Réponse validée. Les codes sont ceux du protocole de l'étude (historique : `Behavior`, `Relevance`, `ObjectionCategory`). `needFrequency` : v3 et v4 seulement. */
export type ConceptPriceAnswer = Omit<z.infer<ReturnType<typeof answerSchemaV2>>, "behavior" | "relevance" | "objections"> & {
  behavior: string;
  relevance: string;
  objections: Array<{ category: string; detail: string }>;
  needFrequency?: NeedFrequency;
  /** Rôles (phase 7) : usage attendu (rôle utilisateur), seuil d'adoption (rôle payeur qui dépend d'un autre). */
  expectedUsage?: string;
  adoptionThreshold?: number | null;
};

// ─── Mise en situation ────────────────────────────────────────────────────────

export interface Encounter {
  id: "social_ad" | "word_of_mouth" | "article";
  text: string;
}

/** Situation de découverte, tirée de façon déterministe et compatible avec la persona. */
export function pickEncounter(p: Persona, studySeed: number): Encounter {
  const working = p.activityStatus === "employed";
  // Sans smartphone ni ordinateur : pas de lien envoyé ni de pub dans un fil.
  const online = p.equipment.some((e) => /smartphone|ordinateur|tablette/i.test(e));
  const who = working ? "Un·e collègue en parle en deux phrases à la pause, sans insister" : "Une connaissance en parle en passant, sans insister";
  const options: Encounter[] = [
    {
      id: "word_of_mouth",
      text: online ? `${who}, puis t'envoie le lien par message.` : `${who}, et te donne le nom du site.`,
    },
    {
      id: "article",
      text: online
        ? "Tu tombes sur un court article qui présente le service, dans un média que tu lis ou regardes d'habitude."
        : "Tu tombes sur un court article qui présente le service, dans le journal ou à la télévision.",
    },
  ];
  if (online && p.socialMediaUsage !== "none") {
    options.push({
      id: "social_ad",
      text: "Une publicité sponsorisée apparaît dans ton fil pendant que tu fais défiler ton téléphone.",
    });
  }
  const rng = new Rng(`encounter:${studySeed}:${p.id}`);
  return options[rng.int(0, options.length - 1)]!;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

const eur = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;

/** Disponibilité en temps, déduite des attributs (pas d'invention). */
export function timeLine(p: Persona): string {
  const x = extraOf(p);
  const kids = x.childrenAges ?? [];
  const young = kids.filter((a) => a < 12).length;
  const parts: string[] = [];
  switch (p.activityStatus) {
    case "employed":
      parts.push(x.partTime ? "emploi à temps partiel" : "emploi à temps plein");
      break;
    case "student":
      parts.push("études (emploi du temps variable)");
      break;
    case "retired":
      parts.push("retraite (journées libres)");
      break;
    case "unemployed":
      parts.push("en recherche d'emploi");
      break;
    default:
      parts.push("sans activité professionnelle");
  }
  if (young) parts.push(`${young} enfant${young > 1 ? "s" : ""} de moins de 12 ans à la maison`);
  else if (kids.length) parts.push(`${kids.length} enfant${kids.length > 1 ? "s" : ""} plus grand${kids.length > 1 ? "s" : ""} au foyer`);
  const tight = p.activityStatus === "employed" && (!x.partTime && young > 0);
  return parts.join(", ") + (tight ? " : très peu de temps libre en semaine" : "");
}

export function constraintsBlock(p: Persona, audience?: Audience): string {
  if (audience?.locale === "en") return constraintsBlockEn(p, audience.currency);
  const x = extraOf(p);
  const subs = p.subscriptions;
  const total = subs.reduce((a, s) => a + s.monthlyEur, 0);
  const budget = p.monthlyDiscretionaryBudgetEur;
  const budgetText =
    budget <= 0
      ? `0 € : une fois les dépenses contraintes et courantes payées, il ne reste rien` +
        (x.monthlyShortfallEur ? ` (il manque même environ ${eur(x.monthlyShortfallEur)} par mois)` : "") +
        ". Toute nouvelle dépense doit être prise sur autre chose."
      : `${eur(budget)}/mois, une fois payés logement, énergie, courses, transports, santé et abonnements actuels. C'est tout ce qui reste pour les loisirs, l'épargne et les imprévus.`;
  const lines = [
    `- Reste-à-vivre : ${budgetText}`,
    subs.length
      ? `- Abonnements en cours : ${subs.length}, pour ${total.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €/mois au total (${subs
          .map((s) => `${s.name} ${s.monthlyEur.toLocaleString("fr-FR")} €${s.household ? " pour le foyer" : ""}`)
          .join(", ")}). Un nouvel abonnement s'ajoute à cette liste ou en remplace un.`
      : "- Abonnements en cours : aucun.",
    `- Temps : ${timeLine(p)}.`,
  ];
  return lines.join("\n");
}

/**
 * Fiche factuelle : celle des récits, sans la tonalité ni les lignes reprises dans les contraintes.
 * `modules` : modules de la population de l'étude (une persona du cache peut en porter d'autres,
 * appliqués par une autre étude) ; absent, la fiche montre tous ceux de la persona (études v1).
 */
export function personaCard(pack: Pack, p: Persona, modules?: string[], opts: { attributeBlock?: boolean } = {}): string {
  const en = pack.manifest.locale === "en";
  const hidden = en ? /^(Narrative tone|Discretionary budget|Current subscriptions)/ : /^(Tonalité|Reste-à-vivre|Abonnements en cours)/;
  // v4 : lignes de module dans le bloc délimité, à leur place dans la fiche, valeurs neutralisées
  const wrapModules = opts.attributeBlock ? (lines: string[]) => attributeBlock(lines, en ? "en" : "fr") : undefined;
  return describeForPrompt(pack, p, { ...(modules && { modules }), ...(wrapModules && { wrapModules }) })
    .split("\n")
    .filter((l) => !hidden.test(l))
    .join("\n");
}

/** Textes de prix du prompt système. */
export interface PriceTexts {
  /** « 5 €/mois », « 9,99 $/mois ou 99 $/an », « 24 SGD le kg, panier minimum de 150 SGD ». */
  shownPrice: string;
  /** Lignes ajoutées après « Prix affiché » (équivalence en euros, fréquence d'achat), vides pour un projet historique. */
  extraLines: string[];
  /** Lignes « Offre gratuite » (et « Ce qui est payant » pour un freemium). */
  freeLines: string;
  payLine: string;
  ggWhen: string;
  /** « en € par mois », « en SGD par kg », « en € en achat unique ». */
  vwUnit: string;
  /** Précision sur l'offre de référence quand il y en a plusieurs (sinon vide). */
  vwReference: string;
  tierList: string;
}

/** Projet historique (`price: { amountEur, period }`) : textes strictement identiques à la v2 du prompt. */
function legacyPriceTexts(project: Project, tiers: number[]): PriceTexts {
  const unit = PERIOD_LABELS[project.pricePeriod ?? "month"] ?? "mois";
  const shownPrice = project.priceEur ? formatPrice(project.priceEur, project.pricePeriod) : "non affiché";
  // Paiement à l'usage (ex. par mise en relation) : libellés adaptés ; l'abonnement garde le texte d'origine.
  const perUse = PER_USE_PERIODS.has(project.pricePeriod ?? "month");
  return {
    shownPrice,
    extraLines: [],
    freeLines: project.freeOffer ? `Offre gratuite : ${project.freeOffer}` : "Offre gratuite : aucune.",
    payLine: perUse ? `tu paies au moins une ${unit} au prix affiché (${shownPrice})` : `tu paies au prix affiché (${shownPrice})`,
    ggWhen: perUse ? `true si tu paierais vraiment une ${unit} à ce prix dans le mois qui vient` : "true si tu paierais vraiment ce service à ce prix ce mois-ci",
    vwUnit: `en € par ${unit}`,
    vwReference: "",
    tierList: tiers.map((t) => formatPrice(t, project.pricePeriod)).join(", "),
  };
}

/** Équivalence en euros d'un prix d'offre : « 24 SGD le kg ≈ 16,56 € le kg ». */
function eurEquivalent(p: Pricing, o: PriceOffer): string {
  const eur = toEur(p, o.amount);
  if (eur === null) return "";
  const base = `${formatOfferAmount(o.amount, o, p.currency)} ≈ ${formatOfferAmount(roundEquivalent(eur), o, "EUR")}`;
  return o.unit === "year" ? `${base}, soit ≈ ${formatMoney(roundEquivalent(eur / 12), "EUR")}/mois` : base;
}

/** Modèle de prix générique : unités, devises, offres multiples, freemium, panier minimum. */
export function genericPriceTexts(p: Pricing, freeOffer: string | null, tiers: number[]): PriceTexts {
  const ref = referenceOffer(p);
  const shownPrice = formatPricing(p);
  const extraLines: string[] = [];
  if (p.currency !== "EUR") {
    const fx = fxOf(p);
    if (fx) {
      const parts = p.offers.map((o) => eurEquivalent(p, o));
      if (p.minimumOrder) parts.push(`panier minimum ≈ ${formatMoney(roundEquivalent(toEur(p, p.minimumOrder.amount)!), "EUR")}`);
      extraLines.push(
        `Pour situer ces prix dans ton budget en euros : 1 ${p.currency} ≈ ${fx.eurPerUnit.toLocaleString("fr-FR", { maximumFractionDigits: 4 })} € (taux fixe du ${fx.date}) ; ${parts.join(" ; ")}.`,
      );
    }
  }
  const freqs = p.offers.filter((o) => o.expectedFrequency).map((o) => (p.offers.length > 1 && o.label ? `${o.label} : ${o.expectedFrequency}` : o.expectedFrequency!));
  if (freqs.length) extraLines.push(`Fréquence d'achat attendue : ${freqs.join(" ; ")}.`);

  const free = p.freemium?.free ?? freeOffer;
  const freeLines = free
    ? `Offre gratuite : ${free}${p.freemium ? `\nCe qui est payant : ${p.freemium.paid}` : ""}`
    : "Offre gratuite : aucune.";

  const several = p.offers.length > 1;
  const minimum = p.minimumOrder ? `, panier minimum de ${formatMoney(p.minimumOrder.amount, p.currency)} compris` : "";
  let payLine: string;
  let ggWhen: string;
  switch (ref.unit) {
    case "month":
      payLine = several ? `tu paies l'une des offres payantes (${shownPrice})` : `tu paies au prix affiché (${shownPrice})`;
      ggWhen = "true si tu paierais vraiment ce service à ce prix ce mois-ci";
      break;
    case "year":
      payLine = several ? `tu paies l'une des offres payantes (${shownPrice})` : `tu paies au prix affiché (${shownPrice})`;
      ggWhen = "true si tu prendrais vraiment l'abonnement annuel à ce prix ce mois-ci";
      break;
    case "usage":
      payLine = `tu paies au moins une ${ref.usageLabel} au prix affiché (${shownPrice})`;
      ggWhen = `true si tu paierais vraiment une ${ref.usageLabel} à ce prix dans le mois qui vient`;
      break;
    case "quantity":
      payLine = several || p.minimumOrder
        ? `tu passes une commande payante${p.minimumOrder ? ` (panier minimum de ${formatMoney(p.minimumOrder.amount, p.currency)})` : ""}`
        : `tu passes une commande payante (${shownPrice})`;
      ggWhen = `true si tu passerais vraiment une commande dans le mois qui vient avec ce prix par ${ref.quantity?.unit}${minimum}`;
      break;
    case "one_time":
      payLine = `tu achètes au prix affiché (${shownPrice})`;
      ggWhen = "true si tu achèterais vraiment à ce prix dans le mois qui vient";
      break;
  }
  const word = currencyWord(p.currency);
  const vwUnit =
    ref.unit === "one_time" ? `en ${word} en achat unique` : ref.unit === "quantity" ? `en ${word} par ${ref.quantity?.unit}` : `en ${word} par ${ref.unit === "month" ? "mois" : ref.unit === "year" ? "an" : ref.usageLabel}`;
  return {
    shownPrice,
    extraLines,
    freeLines,
    payLine,
    ggWhen,
    vwUnit,
    vwReference: several ? `  Les questions de prix (Van Westendorp et paliers) portent sur l'offre de référence : ${formatOffer(ref, p.currency)}.\n` : "",
    tierList: tiers.map((t) => formatTier(p, t)).join(", "),
  };
}

// ─── Protocole propre au projet ───────────────────────────────────────────────

/** Ligne « relevance » d'un protocole propre. */
export function customRelevanceLine(p: ResolvedProtocol): string {
  return `- relevance : une seule valeur : ${p.relevance.map((r) => `"${r.code}" si ${r.description}`).join(" ; ")}.`;
}

/** Ligne « objections » d'un protocole propre (taxonomie du projet). */
export function customObjectionsLine(p: ResolvedProtocol): string {
  const noNeed = p.objections.find((o) => o.canonical === "no_need")!.code;
  return `- objections : de 0 à 4 freins réels et personnels, chacun avec une catégorie et un détail concret, du plus décisif au moins décisif. Si tu n'es pas concerné·e, ne cite que ce qui est réellement décisif pour toi, souvent juste "${noNeed}", et deux objections au plus. Catégories : ${p.objections.map((o) => `"${o.code}" (${o.description})`).join(", ")}. Choisis la catégorie la plus précise ; si aucune ne convient, prends la plus proche. Si tu ignores l'offre ou la mets de côté, donne au moins une objection.`;
}

/** Lignes « behavior » d'un protocole propre ; le prix affiché est rappelé aux comportements payants. */
export function customBehaviorLines(p: ResolvedProtocol, shownPrice: string): string {
  const lines = p.behaviors.map((b, i) => {
    const priced = b.level === "payment" && !/\d/.test(b.description) ? `${b.description} (${shownPrice})` : b.description;
    return `  "${b.code}" : ${priced}${i === p.behaviors.length - 1 ? "." : " ;"}`;
  });
  return `- behavior : ce que tu fais concrètement dans les 7 jours, une seule valeur, l'action la plus engagée que tu fais réellement :\n${lines.join("\n")}`;
}

export function priceTexts(project: Project, tiers: number[]): PriceTexts {
  const p = hasGenericPricing(project) ? pricingOf(project) : null;
  return p ? genericPriceTexts(p, project.freeOffer, tiers) : legacyPriceTexts(project, tiers);
}

/**
 * Prompt système. v2 par défaut (texte figé). v3 : seule la ligne `needFrequency` est ajoutée, en tête des
 * champs ; le reste du texte est celui du v2 (docs/protocol-v3.md § 2). v4 : le texte v3, plus la règle 10
 * (bloc des attributs de module) après la règle 9 (docs/protocol-v3.md § 12).
 */
export function buildSystemPrompt(project: Project, tiers: number[], version: ProtocolVersion = LEGACY_PROTOCOL_VERSION, audience?: Audience): string {
  if (audience?.locale === "en") return buildSystemPromptEn(project, tiers, version, audience, resolveProtocol(project));
  const v2 = buildSystemPromptV2(project, tiers);
  if (!hasV3Measures(version)) return v2;
  const anchor = "\n- spontaneousReaction :";
  if (!v2.includes(anchor)) throw new Error("Prompt v2 : champ spontaneousReaction introuvable");
  const v3 = v2.replace(anchor, `\n${NEED_FREQUENCY_LINE}${anchor}`);
  return usesAttributeBlock(version) ? withAttributeRule(v3, ATTRIBUTE_RULE.fr, OFFER_ANCHOR) : v3;
}

/** Début de la section de l'offre, juste après la règle 9. */
const OFFER_ANCHOR = "\n\n## L'offre que tu croises";

// ─── Rôles (phase 7) ──────────────────────────────────────────────────────────

/** Vue d'un rôle pour le prompt (données seulement ; construite par `role-view.ts`). */
export interface RolePrompt {
  id: string;
  perspective: "user" | "payer" | "payer_for_child" | "both";
  label: string;
  intro: string | null;
  /** Questions de prix (Van Westendorp, Gabor-Granger, budget) et comportements payants. */
  pricing: boolean;
  /** Question d'usage attendu (`expectedUsage`). */
  usage: boolean;
  /** Rôle non payeur : ce que l'offre lui coûte. */
  offerNote: string | null;
  /** Rôle payeur qui dépend d'un autre : libellé de ce rôle (question `adoptionThreshold`). */
  dependsOnLabel: string | null;
}

export const EXPECTED_USAGE_LINE =
  '- expectedUsage : si tu t\'y mettais, à quelle fréquence tu l\'utiliserais vraiment le mois suivant : "never" (pas du tout), "tried_once" (une fois, pour essayer), "monthly" (quelques fois dans le mois), "weekly" (chaque semaine), "several_per_week" (plusieurs fois par semaine).';
const adoptionLine = (label: string) =>
  `- adoptionThreshold : quelle part de tes ${label.toLowerCase()} devrait utiliser régulièrement le service (au moins chaque semaine) pour que tu paies, de 0 à 100 ; null si tu ne paierais en aucun cas.`;

/** Section « Ton rôle » selon la perspective ; null pour `both` sans texte propre (prompt standard). */
export function roleSection(r: RolePrompt): string | null {
  const intro = r.intro ? `${r.intro.trim()} ` : "";
  switch (r.perspective) {
    case "both":
      return r.intro ? `## Ton rôle\n${r.intro.trim()}` : null;
    case "user":
      return `## Ton rôle\n${intro}Tu serais utilisateur ou utilisatrice de ce service, sans le payer${r.offerNote ? ` : ${r.offerNote.trim().replace(/\.$/, "")}` : ""}. Le prix ne te concerne pas : juge l'intérêt, l'usage que tu en aurais et ce qui te freinerait à l'utiliser. Ne pas payer ne rend pas une offre utile : les règles ci-dessous valent pour l'usage.`;
    case "payer":
      return `## Ton rôle\n${intro}C'est toi qui déciderais et qui paierais ; d'autres personnes l'utiliseraient aussi. Juge l'offre dans ce rôle, avec ton budget et tes contraintes.`;
    case "payer_for_child":
      return `## Ton rôle\n${intro}Tu réponds en parent. L'offre s'adresse à un enfant ou un adolescent ; l'enfant de ton foyer concerné est décrit à la fin (« L'enfant pour qui tu décides »). C'est lui ou elle qui l'utiliserait ; c'est toi qui déciderais et qui paierais. Juge son besoin et son intérêt tels que tu les connais, et le prix avec ton budget. Parle de lui ou d'elle à la troisième personne (« mon fils de 11 ans… »), sans inventer d'autres enfants ni de détails absents de sa description.`;
  }
}

const CHILD_BEHAVIORS: Record<string, string> = {
  ignore: "tu passes à autre chose",
  save_for_later: "tu gardes le lien ou tu te dis « je regarderai », sans suite probable",
  visit_page: "tu ouvres la page et tu la parcours",
  free_signup: "tu l'installes ou l'inscris gratuitement pour ton enfant, pour voir, sans suite forcée",
  free_active: "ton enfant l'utilise régulièrement en version gratuite, sans payer",
};

/**
 * Prompt système d'un rôle : le prompt de la version (v2, v3 ou v4) pour la vue du rôle (pitch, prix), puis
 * les adaptations de la perspective. Un projet sans rôles n'appelle jamais cette fonction.
 */
export function buildRoleSystemPrompt(project: Project, tiers: number[], version: ProtocolVersion, role: RolePrompt, audience?: Audience): string {
  if (audience?.locale === "en") return buildRoleSystemPromptEn(project, tiers, version, role, audience);
  const base = buildSystemPrompt(project, tiers, version);
  const proto = resolveProtocol(project);
  const lines = base.split("\n");
  const find = (pred: (l: string) => boolean, what: string) => {
    const i = lines.findIndex(pred);
    if (i < 0) throw new Error(`Prompt de rôle : ${what} introuvable`);
    return i;
  };
  // Perspective parent : pertinence et comportements rapportés à l'enfant (protocole historique)
  if (role.perspective === "payer_for_child" && !proto.custom) {
    const r = find((l) => l.startsWith('- relevance : "concerned"'), "ligne relevance");
    lines[r] = lines[r]!.replace("si tu as aujourd'hui le besoin", "si ton enfant a aujourd'hui le besoin").replace("si tu ne l'as pas", "s'il ou elle ne l'a pas");
    for (const [code, text] of Object.entries(CHILD_BEHAVIORS)) {
      const i = find((l) => l.startsWith(`  "${code}" : `), `comportement ${code}`);
      lines[i] = `  "${code}" : ${text}${lines[i]!.endsWith(".") ? "." : " ;"}`;
    }
    const pay = find((l) => l.startsWith('  "pay_subscription" : '), "comportement pay_subscription");
    lines[pay] = lines[pay]!.replace(/ ;$/, " pour ton enfant ;");
    const rec = find((l) => l.startsWith('  "recommend" : '), "comportement recommend");
    lines[rec] = '  "recommend" : tu paies pour ton enfant et tu le recommandes à un autre parent précis de ton entourage.';
  }
  if (!role.pricing) {
    // Ce que l'offre coûte au rôle, à la place du prix affiché et de ses équivalences
    const pi = find((l) => l.startsWith("Prix affiché : "), "ligne Prix affiché");
    const fi = find((l) => l.startsWith("Offre gratuite : "), "ligne Offre gratuite");
    lines.splice(pi, fi - pi, `Ce que ça te coûte : ${role.offerNote?.trim() ?? "rien, c'est gratuit pour toi"}`);
    // Comportements payants retirés ; le dernier comportement gardé termine la liste
    const payCodes = proto.custom ? proto.behaviors.filter((b) => levelRank(b.level) >= levelRank("payment")).map((b) => b.code) : ["pay_subscription", "recommend"];
    for (const code of payCodes) lines.splice(find((l) => l.startsWith(`  "${code}" : `), `comportement ${code}`), 1);
    const bh = find((l) => l.startsWith("- behavior : "), "ligne behavior");
    let last = bh + 1;
    while (lines[last + 1]?.startsWith('  "')) last++;
    lines[last] = lines[last]!.replace(/ ;$/, ".");
    // Ni Van Westendorp, ni Gabor-Granger, ni budget
    const vw = find((l) => l.startsWith("- vanWestendorp : "), "bloc vanWestendorp");
    const vwEnd = find((l) => l.startsWith("  Si tu ne paierais à aucun prix"), "fin du bloc vanWestendorp");
    lines.splice(vw, vwEnd - vw + 1);
    lines.splice(find((l) => l.startsWith("- gaborGranger : "), "ligne gaborGranger"), 1);
    lines.splice(find((l) => l.startsWith("- budgetFit : "), "ligne budgetFit"), 1);
  }
  if (role.usage) lines.splice(find((l) => l.startsWith("- behaviorReason : "), "ligne behaviorReason") + 1, 0, EXPECTED_USAGE_LINE);
  if (role.pricing && role.dependsOnLabel) lines.splice(find((l) => l.startsWith("- gaborGranger : "), "ligne gaborGranger") + 1, 0, adoptionLine(role.dependsOnLabel));
  let text = lines.join("\n");
  const section = roleSection(role);
  if (section) {
    const anchor = "\n\n## Pourquoi la franchise compte";
    if (!text.includes(anchor)) throw new Error("Prompt de rôle : section « Pourquoi la franchise compte » introuvable");
    text = text.replace(anchor, `\n\n${section}${anchor}`);
  }
  return text;
}

/** Prompt système d'un rôle en anglais : mêmes adaptations que la version française, sur les ancres anglaises. */
function buildRoleSystemPromptEn(project: Project, tiers: number[], version: ProtocolVersion, role: RolePrompt, audience: Audience): string {
  const base = buildSystemPrompt(project, tiers, version, audience);
  const proto = resolveProtocol(project);
  const lines = base.split("\n");
  const A = EN_ANCHORS;
  const find = (pred: (l: string) => boolean, what: string) => {
    const i = lines.findIndex(pred);
    if (i < 0) throw new Error(`Prompt de rôle (en) : ${what} introuvable`);
    return i;
  };
  if (role.perspective === "payer_for_child" && !proto.custom) {
    const r = find((l) => l.startsWith(A.relevance), "ligne relevance");
    lines[r] = lines[r]!.replace("if you have today the need", "if your child has today the need").replace("if you do not have it", "if they do not have it");
    for (const [code, text] of Object.entries(CHILD_BEHAVIORS_EN)) {
      const i = find((l) => l.startsWith(`  "${code}": `), `comportement ${code}`);
      lines[i] = `  "${code}": ${text}${lines[i]!.endsWith(".") ? "." : ";"}`;
    }
    const pay = find((l) => l.startsWith('  "pay_subscription": '), "comportement pay_subscription");
    lines[pay] = lines[pay]!.replace(/;$/, " for your child;");
    const rec = find((l) => l.startsWith('  "recommend": '), "comportement recommend");
    lines[rec] = '  "recommend": you pay for your child and recommend it to another specific parent around you.';
  }
  if (!role.pricing) {
    const pi = find((l) => l.startsWith(A.shownPrice), "ligne Displayed price");
    const fi = find((l) => l.startsWith(A.freeOffer), "ligne Free offer");
    lines.splice(pi, fi - pi, `What it costs you: ${role.offerNote?.trim() ?? "nothing, it is free for you"}`);
    const payCodes = proto.custom ? proto.behaviors.filter((b) => levelRank(b.level) >= levelRank("payment")).map((b) => b.code) : ["pay_subscription", "recommend"];
    for (const code of payCodes) lines.splice(find((l) => l.startsWith(`  "${code}": `), `comportement ${code}`), 1);
    const bh = find((l) => l.startsWith(A.behavior), "ligne behavior");
    let last = bh + 1;
    while (lines[last + 1]?.startsWith('  "')) last++;
    lines[last] = lines[last]!.replace(/;$/, ".");
    const vw = find((l) => l.startsWith(A.vw), "bloc vanWestendorp");
    const vwEnd = find((l) => l.startsWith(A.vwEnd), "fin du bloc vanWestendorp");
    lines.splice(vw, vwEnd - vw + 1);
    lines.splice(find((l) => l.startsWith(A.gg), "ligne gaborGranger"), 1);
    lines.splice(find((l) => l.startsWith(A.budget), "ligne budgetFit"), 1);
  }
  if (role.usage) lines.splice(find((l) => l.startsWith(A.behaviorReason), "ligne behaviorReason") + 1, 0, EXPECTED_USAGE_LINE_EN);
  if (role.pricing && role.dependsOnLabel) lines.splice(find((l) => l.startsWith(A.gg), "ligne gaborGranger") + 1, 0, adoptionLineEn(role.dependsOnLabel));
  let text = lines.join("\n");
  const section = roleSectionEn(role);
  if (section) {
    if (!text.includes(A.candour)) throw new Error("Prompt de rôle (en) : section « Why candour matters » introuvable");
    text = text.replace(A.candour, `\n\n${section}${A.candour}`);
  }
  return text;
}

/** Schéma de réponse d'un rôle : sans les champs de prix ni les comportements payants pour un rôle non payeur. */
export function roleAnswerSchema(tiers: number[], protocol: ResolvedProtocol, version: ProtocolVersion, role: RolePrompt) {
  const full = answerSchemaFor(tiers, protocol, version).shape as Record<string, z.ZodType>;
  const payCodes = new Set(protocol.behaviors.filter((b) => levelRank(b.level) >= levelRank("payment")).map((b) => b.code));
  const codes = protocol.behaviors.map((b) => b.code).filter((c) => role.pricing || !payCodes.has(c));
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(full)) {
    if (!role.pricing && (k === "vanWestendorp" || k === "gaborGranger" || k === "budgetFit")) continue;
    shape[k] = k === "behavior" ? z.enum(codes as [string, ...string[]]) : v;
    if (k === "behaviorReason" && role.usage) shape.expectedUsage = z.enum(["never", "tried_once", "monthly", "weekly", "several_per_week"]);
    if (k === "gaborGranger" && role.dependsOnLabel) shape.adoptionThreshold = z.number().min(0).max(100).nullable();
  }
  return z.object(shape);
}

function buildSystemPromptV2(project: Project, tiers: number[]): string {
  const known = [...new Set([...project.competitors, ...project.alternatives])];
  const pt = priceTexts(project, tiers);
  const proto = resolveProtocol(project);
  return `Tu simules le comportement d'une personne réelle qui vit en France. Elle est décrite à la fin de ce message par une fiche factuelle, tirée de statistiques, et parfois par un portrait. Tu n'es ni un assistant, ni un consultant, ni un client interrogé par un enquêteur poli : tu es cette personne, dans sa journée ordinaire, et tu fais ce qu'elle ferait vraiment.

## Pourquoi la franchise compte
Le porteur du projet se sert de ces simulations pour écarter les mauvaises idées avant d'y investir. Une réponse complaisante lui coûte de l'argent et des mois de travail. Il n'y a ni bonne réponse ni personne à ménager.

## Règles de comportement
1. Inertie par défaut. Dans la vraie vie, presque tout le monde ignore une offre de ce genre : on la voit à peine et on passe à autre chose. Ignorer est la réponse normale.
2. Toute action au-delà d'ignorer s'appuie sur un besoin concret et actuel de ta vie, que tu sais nommer. « Ça pourrait servir un jour » ou « l'idée est intéressante » ne suffisent pas : dans ce cas, tu ignores ou tu mets de côté.
3. Tes contraintes sont réelles. Ton reste-à-vivre est ce qui reste chaque mois une fois tout payé. Chaque nouvel abonnement entre en concurrence avec ceux que tu as déjà et avec tes autres dépenses. Ton temps et ton attention sont limités.
4. Tu as des habitudes et des alternatives, souvent gratuites. Tu ne changes pas d'outil sans raison forte.
5. Trouver une idée sympathique ne fait payer personne. Approuver le principe n'est pas agir.
6. Beaucoup de gens ne sont simplement pas concernés par une offre donnée. C'est normal et utile à savoir : dis-le.
7. Reste fidèle à ta fiche : âge, métier, revenus, foyer, rapport au numérique, sensibilité au prix, méfiance. N'invente pas un besoin, un projet ou un intérêt qui n'apparaît ni dans ta fiche ni dans ton portrait et qui serait peu plausible pour quelqu'un comme toi.
8. N'invente aucun fait personnel absent de ta fiche et de ton portrait : enfants (leur nombre, leur sexe), conjoint, statut d'emploi, employeur, entreprise à toi. Si le sexe de tes enfants n'est pas précisé, dis « mes enfants » ou « mon enfant ». Si tu es salarié·e, tu n'as pas d'entreprise à toi ; si tu n'as pas de conjoint, tu n'en parles pas.
9. Une objection ne compte que si elle pèse vraiment dans ta décision, dans ta situation. Ne recopie pas par réflexe une caractéristique de l'offre (nombre de membres, nouveauté, prix) : si tu n'as pas le besoin, le nombre de membres ne te concerne pas.

## L'offre que tu croises
Nom : ${project.name}
Texte que tu vois :
« ${project.pitch} »
Prix affiché : ${pt.shownPrice}${pt.extraLines.map((l) => `\n${l}`).join("")}
${pt.freeLines}
${known.length ? `Ce qui existe déjà pour des besoins voisins (tu en connais ou non certains, selon ton profil) : ${known.join(" ; ")}.` : ""}

## Ce que tu renvoies
Un objet JSON, et rien d'autre, avec ces champs. Les textes sont en français, à la première personne, courts.
- spontaneousReaction : ta pensée immédiate en voyant l'offre, une ou deux phrases.
${proto.custom ? customRelevanceLine(proto) : `- relevance : "concerned" si tu as aujourd'hui le besoin auquel l'offre répond ; "marginal" si ce besoin existe mais reste faible, ponctuel ou lointain ; "not_concerned" si tu ne l'as pas.`}
- relevanceReason : pourquoi, en une phrase.
- currentSolution : ce que tu fais ou utilises aujourd'hui pour ce besoin, ou « rien, je n'en ai pas besoin ».
- alternatives : ce que tu utiliserais à la place de cette offre (outils, personnes, habitudes), éventuellement vide.
${proto.custom ? customObjectionsLine(proto) : `- objections : de 0 à 4 freins réels et personnels, chacun avec une catégorie et un détail concret, du plus décisif au moins décisif. Si tu n'es pas concerné·e, ne cite que ce qui est réellement décisif pour toi, souvent juste "no_need", et deux objections au plus. Catégories : "price" (prix), "no_need" (pas de besoin), "already_covered" (déjà couvert par autre chose : nomme-le), "trust_privacy" (confiance, vie privée), "effort_time" (effort ou temps à y consacrer), "network_effect" (pas assez de monde, communauté vide), "other". Si tu ignores l'offre ou la mets de côté, donne au moins une objection.`}
${proto.custom ? customBehaviorLines(proto, pt.shownPrice) : `- behavior : ce que tu fais concrètement dans les 7 jours, une seule valeur, l'action la plus engagée que tu fais réellement :
  "ignore" : tu passes à autre chose ;
  "save_for_later" : tu gardes le lien ou tu te dis « je regarderai », sans suite probable ;
  "visit_page" : tu ouvres la page et tu la parcours ;
  "free_signup" : tu t'inscris gratuitement pour voir, par curiosité, sans y revenir forcément${project.freeOffer ? "" : " (si l'offre le permet)"} ;
  "free_active" : tu remplis ton profil et tu reviens utiliser la version gratuite, sans payer ;
  "pay_subscription" : ${pt.payLine} ;
  "recommend" : tu paies et tu le recommandes à une personne précise de ton entourage.`}
- behaviorReason : le besoin concret et actuel qui justifie cette action ; ou, si tu ignores, ce qui t'en détourne.
- wouldForward : true si, dans les 7 jours, tu transmets l'offre à une personne précise de ton entourage parce qu'elle pourrait l'intéresser, que toi tu paies ou non ; sinon false.
- forwardTo : à qui (par exemple « mon collègue qui veut se mettre à son compte »), en restant dans ce que dit ta fiche ; chaîne vide si wouldForward vaut false.
- vanWestendorp : prix ${pt.vwUnit} pour ce service tel que tu le comprends, croissants :
${pt.vwReference}  tooCheapEur : prix si bas que tu douterais du sérieux du service ;
  cheapEur : prix où ce serait une bonne affaire ;
  expensiveEur : prix où ça commence à être cher, sans l'exclure ;
  tooExpensiveEur : prix à partir duquel tu ne l'envisagerais pas.
  Si tu ne paierais à aucun prix (pas de besoin, ou pas de budget pour ça), wouldNeverPay = true et les quatre prix valent null ; sinon wouldNeverPay = false et les quatre prix sont renseignés.
- gaborGranger : pour chaque palier (${pt.tierList}), ${pt.ggWhen}, compte tenu de ton budget et de ton besoin, sinon false. Un oui à un prix implique un oui aux prix plus bas. Ta réponse au prix affiché doit concorder avec ton comportement : on ne paie pas un service qu'on ignore.
- budgetFit : si tu dis oui à au moins un prix, où tu prends l'argent (ce que tu réduis ou supprimes, ou pourquoi ça passe sans peine) ; sinon chaîne vide.
- verbatim : une ou deux phrases que tu dirais vraiment à un proche à propos de cette offre, avec tes mots, ton registre et ton niveau de langue, sans style publicitaire.`;
}

/**
 * Prompt de la persona. `version` : celle de l'étude ; en v4, les lignes de module de la fiche sont dans le
 * bloc délimité. Sans version (ou v2, v3) : texte historique, inchangé.
 */
export function buildUserPrompt(
  pack: Pack,
  p: Persona,
  project: Project,
  encounter: Encounter,
  opts: { modules?: string[]; child?: string; version?: ProtocolVersion } = {},
): string {
  const cardOpts = { attributeBlock: usesAttributeBlock(opts.version) };
  if (pack.manifest.locale === "en") {
    return buildUserPromptEn(personaCard(pack, p, opts.modules, cardOpts), constraintsBlockEn(p, pack.manifest.currency), p.narrative, encounterTextEn(encounter.id, p), opts.child);
  }
  const portrait = p.narrative?.trim()
    ? `### Portrait (écrit à la troisième personne : c'est toi)\n${p.narrative.trim()}`
    : "### Portrait\n(Pas de portrait : appuie-toi sur la fiche seule, sans broder.)";
  return `## Qui tu es
${personaCard(pack, p, opts.modules, cardOpts)}

${portrait}

## Tes contraintes ce mois-ci
${constraintsBlock(p)}
${opts.child ? `\n${opts.child}\n` : ""}
## La situation
Un jour de semaine ordinaire, avec tes préoccupations habituelles. ${encounter.text}

Réponds maintenant avec l'objet JSON seul.`;
}

// ─── Contrôles de cohérence ───────────────────────────────────────────────────

export const CHECK_LABELS: Record<string, string> = {
  gg_not_monotonic: "Gabor-Granger non monotone (oui à un prix, non à un prix plus bas)",
  vw_incomplete: "Van Westendorp incomplet (prix manquants alors que la persona paierait)",
  vw_not_ordered: "Van Westendorp non ordonné (trop bon marché ≤ bon marché ≤ cher ≤ trop cher)",
  vw_gg_conflict: "Oui Gabor-Granger à un prix jugé trop cher en Van Westendorp",
  never_pay_contradiction: "« Ne paierait à aucun prix » mais oui à un palier ou paiement",
  pay_without_gg: "Paierait l'abonnement mais non au prix affiché en Gabor-Granger",
  gg_without_action: "Oui au prix affiché mais ignore ou met de côté",
  not_concerned_but_engaged: "Pas concernée mais s'inscrit ou paierait",
  budget_unjustified: "Paiement envisagé sans dire où trouver l'argent",
  ignore_without_objection: "Ignore sans aucune objection",
  not_concerned_too_many_objections: "Pas concernée mais plus de deux objections (seules les objections décisives comptent)",
  forward_without_target: "Transmettrait l'offre sans dire à qui",
  recommend_without_forward: "Recommande sans transmettre l'offre (wouldForward = false)",
  vw_unit_scale: "Prix Van Westendorp d'un autre ordre de grandeur que les paliers (autre unité ou autre devise ?)",
  minimum_over_budget: "Commande envisagée alors que le panier minimum dépasse le reste-à-vivre, sans financement expliqué",
  invented_child: "Mentionne un enfant absent de la fiche et du portrait",
  child_gender_mismatch: "Le sexe de l'enfant mentionné contredit le portrait",
  invented_partner: "Mentionne un conjoint absent de la fiche, ou du mauvais sexe",
  invented_business: "Se dit à son compte ou parle de son entreprise alors que la fiche ne le dit pas",
  invented_job_status: "Statut d'emploi contraire à la fiche (collègues, patron, retraite, chômage…)",
  need_frequency_mismatch: "Besoin « jamais » rencontré, mais se dit concernée ou essaie l'offre",
};

export const behaviorRank = (b: Behavior) => BEHAVIORS.indexOf(b);

export function ggAnswers(answer: ConceptPriceAnswer, tiers: number[]): Array<{ price: number; yes: boolean }> {
  return tiers.map((t) => ({ price: t, yes: answer.gaborGranger[tierKey(t)] === true }));
}

/** Codes des incohérences d'une réponse (vide si cohérente). */
/** Contexte des contrôles de cohérence. `price` n'existe que pour un projet au modèle de prix générique. */
export interface CoherenceContext {
  tiers: number[];
  projectPrice: number;
  price?: {
    /** « en SGD par kg » : unité attendue des réponses de prix. */
    vwUnit: string;
    /** Panier minimum en euros, et son libellé (« 150 SGD ≈ 104 € »). */
    minimumOrderEur?: number;
    minimumLabel?: string;
  };
  /** Reste-à-vivre mensuel de la persona, en euros. */
  budgetEur?: number;
  /** Protocole de l'étude (historique par défaut). */
  protocol?: ResolvedProtocol;
  /** Version du protocole : le contrôle `need_frequency_mismatch` n'existe qu'en v3 et v4. */
  version?: ProtocolVersion;
  /** Rôle sans questions de prix (phase 7) : les contrôles de prix et de budget ne s'appliquent pas. */
  noPricing?: boolean;
}

/** Contexte de prix d'un projet ; vide (contrôles historiques seuls) pour un projet historique. */
export function coherenceContext(project: Project, tiers: number[], audience?: Audience): CoherenceContext {
  const base: CoherenceContext = { tiers, projectPrice: project.priceEur ?? 0 };
  if (audience?.locale === "en" || (audience && audience.currency !== "EUR")) return coherenceContextFor(project, tiers, audience);
  const p = hasGenericPricing(project) ? pricingOf(project) : null;
  if (!p) return base;
  const minEur = p.minimumOrder ? toEur(p, p.minimumOrder.amount) : null;
  const minLabel = p.minimumOrder
    ? formatMoney(p.minimumOrder.amount, p.currency) + (p.currency !== "EUR" && minEur !== null ? ` ≈ ${formatMoney(roundEquivalent(minEur), "EUR")}` : "")
    : undefined;
  return {
    ...base,
    price: {
      vwUnit: genericPriceTexts(p, project.freeOffer, tiers).vwUnit,
      ...(minEur !== null && { minimumOrderEur: minEur }),
      ...(minLabel && { minimumLabel: minLabel }),
    },
  };
}

/**
 * Contexte de prix pour un public autre que le public français historique : panier minimum converti dans
 * la devise de la persona (son budget est dans cette devise), libellés dans la langue du prompt.
 * `minimumOrderEur` et `budgetEur` désignent alors des montants dans la devise du public.
 */
function coherenceContextFor(project: Project, tiers: number[], audience: Audience): CoherenceContext {
  const base: CoherenceContext = { tiers, projectPrice: project.priceEur ?? 0 };
  const p = hasGenericPricing(project) ? pricingOf(project) : null;
  if (!p) return base;
  const en = audience.locale === "en";
  const min = p.minimumOrder ? convertAmount(p.minimumOrder.amount, p.currency, audience.currency, p) : null;
  const money = (a: number, c: string) => (en ? formatMoneyEn(a, c) : formatMoney(a, c));
  const minLabel = p.minimumOrder
    ? money(p.minimumOrder.amount, p.currency) + (p.currency !== audience.currency && min !== null ? ` ≈ ${money(roundEquivalent(min), audience.currency)}` : "")
    : undefined;
  return {
    ...base,
    price: {
      vwUnit: en ? priceTextsEn(project, tiers, audience).vwUnit : genericPriceTexts(p, project.freeOffer, tiers).vwUnit,
      ...(min !== null && { minimumOrderEur: min }),
      ...(minLabel && { minimumLabel: minLabel }),
    },
  };
}

/** Précisions de réparation pour les contrôles de prix (unité, devise, panier minimum). */
export function priceIssueDetails(codes: string[], ctx: CoherenceContext, audience?: Audience): string[] {
  if (audience?.locale === "en") return priceIssueDetailsEn(codes, ctx, audience.currency);
  const out: string[] = [];
  if (codes.includes("vw_unit_scale") && ctx.price) {
    out.push(`Tes prix Van Westendorp et tes réponses aux paliers doivent être exprimés ${ctx.price.vwUnit}, comme les paliers proposés.`);
  }
  if (codes.includes("minimum_over_budget") && ctx.price?.minimumLabel) {
    out.push(
      `Le panier minimum (${ctx.price.minimumLabel}) dépasse ton reste-à-vivre mensuel (${formatMoney(ctx.budgetEur ?? 0, "EUR")}) : soit tu expliques précisément dans budgetFit comment tu le finances, soit tu revois ton comportement et tes paliers.`,
    );
  }
  return out;
}

export function checkCoherence(answer: ConceptPriceAnswer, ctx: CoherenceContext): string[] {
  if (ctx.noPricing) return checkCoherenceNoPricing(answer, ctx);
  const issues: string[] = [];
  const gg = ggAnswers(answer, ctx.tiers);
  const vw = answer.vanWestendorp;
  const anyYes = gg.some((g) => g.yes);
  const yesAtPrice = gg.find((g) => g.price === ctx.projectPrice)?.yes ?? false;
  // Seuils exprimés en niveaux canoniques : identiques aux rangs historiques pour le protocole v2
  const tools = protocolTools(ctx.protocol ?? LEGACY_PROTOCOL);
  const level = levelRank(tools.level(answer.behavior));
  const pays = level >= levelRank("payment");
  const inaction = level === levelRank("inaction");
  const notConcerned = tools.relevanceCanonical(answer.relevance) === "not_concerned";

  for (let i = 1; i < gg.length; i++) {
    if (gg[i]!.yes && !gg[i - 1]!.yes) {
      issues.push("gg_not_monotonic");
      break;
    }
  }
  const vwPrices = [vw.tooCheapEur, vw.cheapEur, vw.expensiveEur, vw.tooExpensiveEur];
  if (!vw.wouldNeverPay) {
    if (vwPrices.some((x) => x === null)) issues.push("vw_incomplete");
    else {
      const [a, b, c, d] = vwPrices as number[];
      if (!(a! <= b! && b! <= c! && c! <= d! && a! < d!)) issues.push("vw_not_ordered");
      if (gg.some((g) => g.yes && g.price >= d!)) issues.push("vw_gg_conflict");
    }
  } else if (anyYes || pays) {
    issues.push("never_pay_contradiction");
  }
  if (pays && !yesAtPrice) issues.push("pay_without_gg");
  if (yesAtPrice && inaction) issues.push("gg_without_action");
  if (notConcerned && (level >= levelRank("free_trial") || yesAtPrice)) {
    issues.push("not_concerned_but_engaged");
  }
  if ((anyYes || pays) && answer.budgetFit.trim().length < 15) issues.push("budget_unjustified");
  if (inaction && answer.objections.length === 0) issues.push("ignore_without_objection");
  if (notConcerned && answer.objections.length > 2) issues.push("not_concerned_too_many_objections");
  if (answer.wouldForward && answer.forwardTo.trim().length < 3) issues.push("forward_without_target");
  if (level === levelRank("recommendation") && !answer.wouldForward) issues.push("recommend_without_forward");
  // Modèle de prix générique : unité et devise des réponses, panier minimum face au budget
  if (ctx.price && !vw.wouldNeverPay && vwPrices.every((x) => x !== null) && ctx.tiers.length) {
    const [, cheap, , tooExp] = vwPrices as number[];
    const lo = Math.min(...ctx.tiers);
    const hi = Math.max(...ctx.tiers);
    if (tooExp! < lo / 5 || cheap! > hi * 5) issues.push("vw_unit_scale");
  }
  if (
    ctx.price?.minimumOrderEur !== undefined &&
    ctx.budgetEur !== undefined &&
    ctx.price.minimumOrderEur > ctx.budgetEur &&
    (pays || yesAtPrice) &&
    answer.budgetFit.trim().length < 40
  ) {
    issues.push("minimum_over_budget");
  }
  // v3 et v4 : un besoin qui ne se présente jamais ne rend ni concernée ni prête à essayer
  if (hasV3Measures(ctx.version) && answer.needFrequency === "never") {
    const concerned = tools.relevanceCanonical(answer.relevance) === "concerned";
    if (concerned || level >= levelRank("free_trial")) issues.push("need_frequency_mismatch");
  }
  return issues;
}

/** Contrôles d'un rôle sans prix (phase 7) : ceux qui ne portent ni sur les prix ni sur le budget. */
function checkCoherenceNoPricing(answer: ConceptPriceAnswer, ctx: CoherenceContext): string[] {
  const issues: string[] = [];
  const tools = protocolTools(ctx.protocol ?? LEGACY_PROTOCOL);
  const level = levelRank(tools.level(answer.behavior));
  const inaction = level === levelRank("inaction");
  const relevance = tools.relevanceCanonical(answer.relevance);
  if (relevance === "not_concerned" && level >= levelRank("free_trial")) issues.push("not_concerned_but_engaged");
  if (inaction && answer.objections.length === 0) issues.push("ignore_without_objection");
  if (relevance === "not_concerned" && answer.objections.length > 2) issues.push("not_concerned_too_many_objections");
  if (answer.wouldForward && answer.forwardTo.trim().length < 3) issues.push("forward_without_target");
  if (hasV3Measures(ctx.version) && answer.needFrequency === "never" && (relevance === "concerned" || level >= levelRank("free_trial"))) issues.push("need_frequency_mismatch");
  return issues;
}

export function buildRepairPrompt(issues: string[], details: string[] = [], audience?: Audience): string {
  if (audience?.locale === "en") return buildRepairPromptEn(issues, details);
  return `Ta réponse comporte des incohérences :
${issues.map((i) => `- ${CHECK_LABELS[i] ?? i}`).join("\n")}${details.length ? `\n\nPrécisions :\n${details.map((d) => `- ${d}`).join("\n")}\nN'affirme aucun fait personnel absent de ta fiche et de ton portrait.` : ""}

Renvoie l'objet JSON complet, corrigé et cohérent. Ne rends pas ta réponse plus favorable à l'offre pour lever une contradiction : quand deux éléments se contredisent, garde le plus prudent (moins d'engagement, pas de paiement), sauf si ton besoin et ton budget justifient clairement le contraire. Réponds avec l'objet JSON seul.`;
}
