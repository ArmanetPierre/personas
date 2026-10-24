import type { Lang } from "./i18n";

/**
 * Tables anglaises superposées aux libellés français (clé = code). Le français reste la source :
 * un code absent ici retombe sur son libellé français. Les tables marquées « source » doublonnent
 * une table de src/studies ou src/personas : à déplacer à la source quand elle deviendra bilingue.
 */

// ─── Source : src/studies/protocols/concept-price.ts ──────────────────────────

/** BEHAVIOR_LABELS (concept-price.ts). */
export const BEHAVIOR_LABELS_EN: Record<string, string> = {
  ignore: "Ignores it",
  save_for_later: "Saves it for later, probably no follow-up",
  visit_page: "Looks at the page",
  free_signup: "Signs up for free to have a look",
  free_active: "Uses the free version",
  pay_subscription: "Would pay the subscription",
  recommend: "Would pay and recommend it",
};

/** behaviorLabelsFor(unit) (concept-price.ts) : libellés payants selon l'unité de l'offre. */
export function behaviorLabelsForEn(unit: string | null | undefined): Record<string, string> {
  switch (unit) {
    case "one_time":
      return { ...BEHAVIOR_LABELS_EN, pay_subscription: "Would buy it", recommend: "Would buy and recommend it" };
    case "quantity":
      return { ...BEHAVIOR_LABELS_EN, pay_subscription: "Would order", recommend: "Would order and recommend it" };
    case "usage":
      return { ...BEHAVIOR_LABELS_EN, pay_subscription: "Would pay per use", recommend: "Would pay per use and recommend it" };
    default:
      return BEHAVIOR_LABELS_EN;
  }
}

/** OBJECTION_LABELS (concept-price.ts). */
export const OBJECTION_LABELS_EN: Record<string, string> = {
  price: "Price",
  no_need: "No need",
  already_covered: "Already covered by something else",
  trust_privacy: "Trust, privacy",
  effort_time: "Effort or time",
  network_effect: "Network effect, empty community",
  other: "Other",
};

/** RELEVANCE_LABELS (concept-price.ts) et CANONICAL_RELEVANCE_LABELS (p1-routes.ts). */
export const RELEVANCE_LABELS_EN: Record<string, string> = {
  concerned: "Concerned",
  marginal: "Marginally concerned",
  not_concerned: "Not concerned",
};

/** NEED_FREQUENCY_LABELS (concept-price.ts). */
export const NEED_FREQUENCY_LABELS_EN: Record<string, string> = {
  never: "Never",
  rarely: "Less than once a year",
  few_per_year: "A few times a year",
  monthly: "Every month",
  weekly: "Every week",
  daily: "Almost every day",
};

/** CHECK_LABELS (concept-price.ts). */
export const CHECK_LABELS_EN: Record<string, string> = {
  gg_not_monotonic: "Gabor-Granger not monotonic (yes at one price, no at a lower price)",
  vw_incomplete: "Van Westendorp incomplete (missing prices although the persona would pay)",
  vw_not_ordered: "Van Westendorp not ordered (too cheap ≤ cheap ≤ expensive ≤ too expensive)",
  vw_gg_conflict: "Gabor-Granger yes at a price judged too expensive in Van Westendorp",
  never_pay_contradiction: "“Would not pay at any price” but yes to a tier or to paying",
  pay_without_gg: "Would pay the subscription but no at the displayed Gabor-Granger price",
  gg_without_action: "Yes at the displayed price but ignores it or saves it for later",
  not_concerned_but_engaged: "Not concerned but signs up or would pay",
  budget_unjustified: "Considers paying without saying where the money would come from",
  ignore_without_objection: "Ignores it without any objection",
  not_concerned_too_many_objections: "Not concerned but more than two objections (only decisive objections count)",
  forward_without_target: "Would forward the offer without saying to whom",
  recommend_without_forward: "Recommends without forwarding the offer (wouldForward = false)",
  vw_unit_scale: "Van Westendorp prices of a different order of magnitude than the tiers (other unit or currency?)",
  minimum_over_budget: "Considers ordering although the minimum basket exceeds the disposable income, with no explained funding",
  invented_child: "Mentions a child absent from the profile and the portrait",
  child_gender_mismatch: "The sex of the mentioned child contradicts the portrait",
  invented_partner: "Mentions a partner absent from the profile, or of the wrong sex",
  invented_business: "Claims to be self-employed or talks about their business although the profile does not say so",
  invented_job_status: "Employment status contrary to the profile (colleagues, boss, retirement, unemployment…)",
  need_frequency_mismatch: "Need “never” encountered, yet says they are concerned or tries the offer",
};

// ─── Source : src/studies/protocols/protocol.ts ───────────────────────────────

/** LEVEL_LABELS (protocol.ts). */
export const LEVEL_LABELS_EN: Record<string, string> = {
  inaction: "Inaction",
  interest: "Interest",
  free_trial: "Free trial",
  payment: "Payment",
  recommendation: "Recommendation",
};

// ─── Source : src/studies/segments.ts ─────────────────────────────────────────

/** DIMENSION_LABELS (segments.ts), dimensions du socle seulement (celles des modules viennent du YAML). */
export const DIMENSION_LABELS_EN: Record<string, string> = {
  ageBand: "Age band",
  sex: "Sex",
  pcs: "Socio-professional category",
  livingStandard: "Living standard (quintile)",
  techAdoption: "Adoption profile",
  townSize: "Urban area size",
  activityStatus: "Activity status",
  region: "Region",
};

/** PCS_SHORT (segments.ts). */
export const PCS_SHORT_EN: Record<string, string> = {
  "1": "Farmers",
  "2": "Craftspeople, shopkeepers, business owners",
  "3": "Managers and professionals",
  "4": "Intermediate occupations",
  "5": "Clerical and service workers",
  "6": "Manual workers",
  none: "Never employed",
};

/** ACTIVITY_LABELS (segments.ts). */
export const ACTIVITY_LABELS_EN: Record<string, string> = {
  employed: "Employed",
  unemployed: "Unemployed",
  student: "Student",
  retired: "Retired",
  inactive: "Other inactive",
};

/** ROGERS_LABELS (src/personas/describe.ts), sans la parenthèse (comme segmentLabel). */
export const ROGERS_LABELS_EN: Record<string, string> = {
  innovator: "Innovator",
  early_adopter: "Early adopter",
  early_majority: "Early majority",
  late_majority: "Late majority",
  laggard: "Laggard",
};

// ─── Source : src/studies/summary.ts, project.ts, confidence.ts, pitch-tone.ts ─

/** GROUP_LABELS (summary.ts). */
export const GROUP_LABELS_EN: Record<string, string> = { target: "Target", control: "Control (general population)" };

/** METHOD_NOTE (summary.ts). */
export const METHOD_NOTE_EN =
  "Qualitative signals from synthetic personas: read them as objections and trends by segment, not as a conversion forecast.";

/** PERIOD_LABELS (project.ts). */
export const PERIOD_LABELS_EN: Record<string, string> = {
  month: "month",
  year: "year",
  once: "one-time purchase",
  connection: "connection",
  one_time: "one-time purchase",
};

/** CONFIDENCE_LEVEL_LABELS (confidence.ts). */
export const CONFIDENCE_LEVEL_LABELS_EN: Record<string, string> = { high: "high", medium: "medium", low: "low" };

/** TONE_CATEGORY_LABELS (pitch-tone.ts). */
export const TONE_CATEGORY_LABELS_EN: Record<string, string> = {
  superlative: "Superlative",
  unverifiable_promise: "Unverifiable promise",
  social_proof: "Unsourced social proof",
  urgency: "Urgency",
  price_judgment: "Value judgement on the price",
  injunction: "Injunction",
  emotional: "Loaded emotion",
};

// ─── Libellés propres à src/web ───────────────────────────────────────────────

/** Façons de découvrir l'offre (app.ts). */
export const ENCOUNTER_LABELS_FR: Record<string, string> = {
  social_ad: "Publicité dans un fil de réseau social",
  word_of_mouth: "Bouche-à-oreille (collègue, connaissance)",
  article: "Article ou reportage",
};
export const ENCOUNTER_LABELS_EN: Record<string, string> = {
  social_ad: "Ad in a social media feed",
  word_of_mouth: "Word of mouth (colleague, acquaintance)",
  article: "Article or news report",
};

/** Unités du modèle de prix générique (app.ts, /meta). */
export const PRICE_UNITS: Array<{ id: string; fr: string; en: string }> = [
  { id: "month", fr: "par mois", en: "per month" },
  { id: "year", fr: "par an", en: "per year" },
  { id: "one_time", fr: "achat unique", en: "one-time purchase" },
  { id: "usage", fr: "à l'usage", en: "per use" },
  { id: "quantity", fr: "à la quantité (kg, pack…)", en: "by quantity (kg, pack…)" },
];

/** Moteurs (app.ts, /meta). */
export const BACKEND_LABELS: Record<string, { fr: string; en: string }> = {
  "claude-cli": { fr: "Claude (abonnement Max, CLI)", en: "Claude (Max subscription, CLI)" },
  ollama: { fr: "Ollama (local)", en: "Ollama (local)" },
};

/** PRODUCT_TYPE_LABELS (p1-routes.ts). */
export const PRODUCT_TYPE_LABELS_EN: Record<string, string> = {
  app_install: "App to install",
  online_service: "Online service",
  marketplace_network: "Network or marketplace",
  physical_product: "Physical product",
  subscription_content: "Content subscription",
  b2b_tool: "Professional tool (B2B)",
};

/** CANONICAL_OBJECTION_LABELS (p1-routes.ts). */
export const CANONICAL_OBJECTION_LABELS_EN: Record<string, string> = {
  price: "Price",
  no_need: "No need",
  already_covered: "Already covered",
  trust_privacy: "Trust, privacy",
  effort_time: "Effort or time",
  network_effect: "Network effect",
  other: "Other",
};

/** SOCLE_LABELS (modules.ts) : variables du socle, en minuscules (conditions en clair). */
export const SOCLE_LABELS_EN: Record<string, string> = {
  age: "age",
  sex: "sex",
  region: "region",
  town_size: "urban area size",
  household_type: "household type",
  tenure: "housing tenure",
  children_under_12: "children under 12",
  partner_status: "partner status",
  living_standard_ratio: "living standard relative to the median",
  living_standard: "living standard",
  tech_adoption: "technology adoption",
  social_media: "social media use",
  has_computer: "owns a computer",
  has_smartphone: "owns a smartphone",
  has_tablet: "owns a tablet",
  budget: "disposable income",
  household_size: "household size",
  household_income: "household income",
  children: "children",
  monthly_income: "income",
  activity_status: "activity status",
  pcs: "socio-professional category",
};

/** SOCLE_VALUE_LABELS (modules.ts). */
export const SOCLE_VALUE_LABELS_EN: Record<string, Record<string, string>> = {
  activity_status: { employed: "employed", unemployed: "unemployed", student: "studying", retired: "retired", inactive: "inactive" },
  sex: { F: "woman", M: "man" },
  pcs: { "1": "farmers", "2": "craftspeople, shopkeepers, business owners", "3": "managers and professionals", "4": "intermediate occupations", "5": "clerical and service workers", "6": "manual workers", none: "never employed" },
  town_size: { rural: "rural", uu_lt20k: "under 20,000 inhabitants", uu_20k_100k: "20,000 to 99,999 inhabitants", uu_100k_200k: "100,000 to 199,999 inhabitants", uu_200k_2m: "200,000 to 2 million", uu_paris: "Paris urban area" },
  partner_status: { none: "no partner", employed: "partner employed", not_employed: "partner not employed" },
};

/** VAR_LABELS (overview.ts) : variables du socle, critères en clair. */
export const VAR_LABELS_EN: Record<string, string> = {
  age: "Age",
  sex: "Sex",
  region: "Region",
  town_size: "Town size",
  pcs: "Socio-professional category",
  activity_status: "Situation",
  household_type: "Household type",
  household_size: "Household size",
  monthly_income: "Personal income (per month)",
  household_income: "Household income (per month)",
  budget: "Disposable income (per month)",
  living_standard: "Living standard (per month)",
  tech_adoption: "Relationship with digital tech",
  social_media: "Social media use",
  tenure: "Housing",
  children: "Children",
  has_computer: "Has a computer",
  has_smartphone: "Has a smartphone",
  has_tablet: "Has a tablet",
};

/** EXTRA_VALUE_LABELS (overview.ts). */
export const EXTRA_VALUE_LABELS_EN: Record<string, Record<string, string>> = {
  tech_adoption: { innovator: "innovator", early_adopter: "early adopter", early_majority: "early majority", late_majority: "late majority", laggard: "laggard" },
  tenure: { owner: "owner", owner_mortgage: "owner with a mortgage", renter_private: "tenant (private)", renter_social: "social housing tenant", free: "housed for free" },
  household_type: { alone: "alone", couple_no_child: "couple without children", couple_with_children: "couple with children", single_parent: "single parent", with_parents: "living with parents", other: "other" },
  social_media: { none: "none", occasional: "occasional", daily: "daily", heavy: "heavy" },
};

/** Superposition de tables imbriquées (code de variable → code de valeur → libellé). */
export function overlayNested(lang: Lang, fr: Record<string, Record<string, string>>, en: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  if (lang !== "en") return fr;
  const out: Record<string, Record<string, string>> = {};
  for (const k of new Set([...Object.keys(fr), ...Object.keys(en)])) out[k] = { ...(fr[k] ?? {}), ...(en[k] ?? {}) };
  return out;
}

// ─── Questionnaire standard (src/studies/protocols/protocol.ts, LEGACY_PROTOCOL) ─

/** Descriptions anglaises de l'échelle standard : celles du prompt anglais (concept-price-en.ts). */
const LEGACY_DESCRIPTIONS_EN = {
  behaviors: {
    ignore: "you move on",
    save_for_later: "you keep the link or tell yourself “I'll have a look”, probably without follow-up",
    visit_page: "you open the page and browse it",
    free_signup: "you sign up for free to have a look, out of curiosity, without necessarily coming back",
    free_active: "you fill in your profile and come back to use the free version, without paying",
    pay_subscription: "you pay the displayed price",
    recommend: "you pay and recommend it to a specific person around you",
  } as Record<string, string>,
  objections: {
    price: "price",
    no_need: "no need",
    already_covered: "already covered by something else: name it",
    trust_privacy: "trust, privacy",
    effort_time: "effort or time it would take",
    network_effect: "not enough people, empty community",
    other: "other",
  } as Record<string, string>,
  relevance: {
    concerned: "you have today the need the offer addresses",
    marginal: "this need exists but remains weak, occasional or distant",
    not_concerned: "you do not have it",
  } as Record<string, string>,
};

/**
 * Questionnaire standard (non propre au projet) affiché en anglais : libellés et descriptions par code.
 * Un protocole propre au projet est une donnée du projet : il reste tel quel.
 */
export function standardProtocolIn<P extends { custom: boolean; behaviors: Array<{ code: string; label: string; description: string }>; objections: Array<{ code: string; label: string; description: string }>; relevance: Array<{ code: string; label: string; description: string }> }>(lang: Lang, p: P): P {
  if (lang !== "en" || p.custom) return p;
  const d = LEGACY_DESCRIPTIONS_EN;
  return {
    ...p,
    behaviors: p.behaviors.map((b) => ({ ...b, label: BEHAVIOR_LABELS_EN[b.code] ?? b.label, description: d.behaviors[b.code] ?? b.description })),
    objections: p.objections.map((o) => ({ ...o, label: OBJECTION_LABELS_EN[o.code] ?? o.label, description: d.objections[o.code] ?? o.description })),
    relevance: p.relevance.map((r) => ({ ...r, label: RELEVANCE_LABELS_EN[r.code] ?? r.label, description: d.relevance[r.code] ?? r.description })),
  };
}
