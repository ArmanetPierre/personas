import type { Persona, Project } from "../../db/schema";
import { extraOf } from "../../personas/describe";
import type { Audience } from "../locale";
import { hasGenericPricing, pricingOf, referenceOffer, type PriceOffer, type Pricing } from "../price-model";
import {
  convertAmount,
  currencyWordEn,
  formatMoneyEn,
  formatOfferAmountEn,
  formatOfferEn,
  formatPricingEn,
  formatTierEn,
  fxDate,
} from "../price-model-en";
import { roundEquivalent } from "../price-model";
import type { ResolvedProtocol } from "./protocol";
import { ATTRIBUTE_RULE, withAttributeRule } from "./attribute-block";

/**
 * Protocole « concept + prix » en anglais (études dont le socle est en locale `en`, ex. Singapour).
 * Traduction fidèle du prompt français (v2, plus la ligne v3 `needFrequency`, plus la règle 10 du v4) : mêmes règles
 * anti-complaisance (inertie par défaut, besoin concret et actuel, contraintes réelles, alternatives,
 * approuver n'est pas agir, pas de fait inventé), même schéma de réponse, mêmes contrôles. Les textes
 * français ne passent jamais par ici.
 */

export const NEED_FREQUENCY_LINE_EN =
  '- needFrequency: how often the need this offer addresses comes up in your life: "never" (never), "rarely" (less than once a year), "few_per_year" (a few times a year), "monthly" (every month), "weekly" (every week), "daily" (almost every day).';

export const BEHAVIOR_LABELS_EN: Record<string, string> = {
  ignore: "Ignores it",
  save_for_later: "Saves it, probably no follow-up",
  visit_page: "Looks at the page",
  free_signup: "Signs up for free to have a look",
  free_active: "Uses the free version",
  pay_subscription: "Would pay the subscription",
  recommend: "Would pay and recommend it",
};

export function behaviorLabelsForEn(unit: string | null | undefined): Record<string, string> {
  switch (unit) {
    case "one_time":
      return { ...BEHAVIOR_LABELS_EN, pay_subscription: "Would buy", recommend: "Would buy and recommend it" };
    case "quantity":
      return { ...BEHAVIOR_LABELS_EN, pay_subscription: "Would order", recommend: "Would order and recommend it" };
    case "usage":
      return { ...BEHAVIOR_LABELS_EN, pay_subscription: "Would pay per use", recommend: "Would pay per use and recommend it" };
    default:
      return BEHAVIOR_LABELS_EN;
  }
}

export const OBJECTION_LABELS_EN: Record<string, string> = {
  price: "Price",
  no_need: "No need",
  already_covered: "Already covered by something else",
  trust_privacy: "Trust, privacy",
  effort_time: "Effort or time",
  network_effect: "Network effect, empty community",
  other: "Other",
};

export const RELEVANCE_LABELS_EN: Record<string, string> = {
  concerned: "Concerned",
  marginal: "Marginally concerned",
  not_concerned: "Not concerned",
};

export const NEED_FREQUENCY_LABELS_EN: Record<string, string> = {
  never: "Never",
  rarely: "Less than once a year",
  few_per_year: "A few times a year",
  monthly: "Every month",
  weekly: "Every week",
  daily: "Almost every day",
};

export const CHECK_LABELS_EN: Record<string, string> = {
  gg_not_monotonic: "Gabor-Granger not monotonic (yes at one price, no at a lower price)",
  vw_incomplete: "Van Westendorp incomplete (missing prices although the persona would pay)",
  vw_not_ordered: "Van Westendorp not ordered (too cheap ≤ cheap ≤ expensive ≤ too expensive)",
  vw_gg_conflict: "Gabor-Granger yes at a price judged too expensive in Van Westendorp",
  never_pay_contradiction: "“Would never pay at any price” but yes to a tier or to paying",
  pay_without_gg: "Would pay but says no to the displayed price in Gabor-Granger",
  gg_without_action: "Yes to the displayed price but ignores the offer or saves it for later",
  not_concerned_but_engaged: "Not concerned but signs up or would pay",
  budget_unjustified: "Payment considered without saying where the money comes from",
  ignore_without_objection: "Ignores the offer without any objection",
  not_concerned_too_many_objections: "Not concerned but more than two objections (only decisive objections count)",
  forward_without_target: "Would forward the offer without saying to whom",
  recommend_without_forward: "Recommends without forwarding the offer (wouldForward = false)",
  vw_unit_scale: "Van Westendorp prices of a different order of magnitude than the tiers (other unit or other currency?)",
  minimum_over_budget: "Order considered although the minimum order exceeds the discretionary budget, without explaining how it is financed",
  invented_child: "Mentions a child who is not in the profile or the portrait",
  child_gender_mismatch: "The sex of the child mentioned contradicts the portrait",
  invented_partner: "Mentions a partner who is not in the profile, or of the wrong sex",
  invented_business: "Claims to be self-employed or to own a business although the profile does not say so",
  invented_job_status: "Employment status contrary to the profile (colleagues, boss, retirement, unemployment…)",
  need_frequency_mismatch: "Need “never” encountered, but says they are concerned or tries the offer",
};

// ─── Mise en situation ────────────────────────────────────────────────────────

/** Mêmes situations et même tirage que la version française ; seul le texte change. */
export function encounterTextEn(id: "social_ad" | "word_of_mouth" | "article", p: Persona): string {
  const working = p.activityStatus === "employed";
  const online = p.equipment.some((e) => /smartphone|ordinateur|tablette|computer|tablet/i.test(e));
  const who = working ? "A colleague mentions it in two sentences during a break, without insisting" : "An acquaintance mentions it in passing, without insisting";
  switch (id) {
    case "word_of_mouth":
      return online ? `${who}, then sends you the link by message.` : `${who}, and gives you the name of the website.`;
    case "article":
      return online
        ? "You come across a short article presenting the service, in a media outlet you usually read or watch."
        : "You come across a short article presenting the service, in the newspaper or on TV.";
    case "social_ad":
      return "A sponsored ad appears in your feed while you scroll on your phone.";
  }
}

// ─── Contraintes ──────────────────────────────────────────────────────────────

/** Disponibilité en temps, déduite des attributs (pas d'invention). */
export function timeLineEn(p: Persona): string {
  const x = extraOf(p) as ReturnType<typeof extraOf> & { nationalService?: boolean; residency?: string; liveIn?: boolean };
  const kids = x.childrenAges ?? [];
  const young = kids.filter((a) => a < 12).length;
  const parts: string[] = [];
  if (x.nationalService) parts.push("full-time National Service");
  else if (x.liveIn) parts.push("live-in domestic work, with one rest day a week");
  else
    switch (p.activityStatus) {
      case "employed":
        parts.push(x.partTime ? "part-time job" : "full-time job");
        break;
      case "student":
        parts.push("studies (variable schedule)");
        break;
      case "retired":
        parts.push("retired (free days)");
        break;
      case "unemployed":
        parts.push("looking for work");
        break;
      default:
        parts.push("no paid work");
    }
  if (young) parts.push(`${young} child${young > 1 ? "ren" : ""} under 12 at home`);
  else if (kids.length) parts.push(`${kids.length} older child${kids.length > 1 ? "ren" : ""} at home`);
  const tight = p.activityStatus === "employed" && !x.partTime && young > 0;
  return parts.join(", ") + (tight ? ": very little free time on weekdays" : "");
}

export function constraintsBlockEn(p: Persona, currency: string): string {
  const x = extraOf(p);
  const m = (n: number) => formatMoneyEn(Math.round(n), currency);
  const subs = p.subscriptions;
  const total = subs.reduce((a, s) => a + s.monthlyEur, 0);
  const budget = p.monthlyDiscretionaryBudgetEur;
  const budgetText =
    budget <= 0
      ? `${m(0)}: once committed and day-to-day expenses are paid, nothing is left` +
        (x.monthlyShortfallEur ? ` (you are even about ${m(x.monthlyShortfallEur)} short each month)` : "") +
        ". Any new expense has to be taken from something else."
      : `${m(budget)}/month, once housing, utilities, groceries and meals, transport, health and current subscriptions are paid. That is all that is left for leisure, savings and the unexpected.`;
  const lines = [
    `- Discretionary budget: ${budgetText}`,
    subs.length
      ? `- Current subscriptions: ${subs.length}, ${formatMoneyEn(Math.round(total * 100) / 100, currency)}/month in total (${subs
          .map((s) => `${s.name} ${formatMoneyEn(s.monthlyEur, currency)}${s.household ? " for the household" : ""}`)
          .join(", ")}). A new subscription is added to this list or replaces one.`
      : "- Current subscriptions: none.",
    `- Time: ${timeLineEn(p)}.`,
  ];
  return lines.join("\n");
}

// ─── Prix ─────────────────────────────────────────────────────────────────────

export interface PriceTextsEn {
  shownPrice: string;
  extraLines: string[];
  freeLines: string;
  payLine: string;
  ggWhen: string;
  vwUnit: string;
  vwReference: string;
  tierList: string;
  /** Devise des réponses de prix (symbole), rappelée à cause des noms de champs historiques en « Eur ». */
  word: string;
}

function equivalent(p: Pricing, o: PriceOffer, to: string): string {
  const v = convertAmount(o.amount, p.currency, to, p);
  if (v === null) return "";
  const base = `${formatOfferAmountEn(o.amount, o, p.currency)} ≈ ${formatOfferAmountEn(roundEquivalent(v), o, to)}`;
  return o.unit === "year" ? `${base}, i.e. ≈ ${formatMoneyEn(roundEquivalent(v / 12), to)}/month` : base;
}

/** Projet historique (euros) ou modèle générique : toujours le modèle générique en anglais. */
export function priceTextsEn(project: Project, tiers: number[], audience: Audience): PriceTextsEn {
  const p: Pricing = pricingOf(project) ?? { currency: "EUR", offers: [{ id: "main", amount: project.priceEur ?? 0, unit: "month" }], reference: "main" };
  const ref = referenceOffer(p);
  const shownPrice = project.priceEur || hasGenericPricing(project) ? formatPricingEn(p) : "not displayed";
  const extraLines: string[] = [];
  if (p.currency !== audience.currency) {
    const unit = convertAmount(1, p.currency, audience.currency, p);
    if (unit !== null) {
      const parts = p.offers.map((o) => equivalent(p, o, audience.currency));
      if (p.minimumOrder) parts.push(`minimum order ≈ ${formatMoneyEn(roundEquivalent(convertAmount(p.minimumOrder.amount, p.currency, audience.currency, p)!), audience.currency)}`);
      const date = fxDate(p.currency, p) || fxDate(audience.currency, p);
      extraLines.push(
        `To place these prices in your budget in ${currencyWordEn(audience.currency)}: ${formatMoneyEn(1, p.currency)} ≈ ${formatMoneyEn(Math.round(unit * 10000) / 10000, audience.currency)} (fixed rate${date ? ` of ${date}` : ""}); ${parts.join("; ")}.`,
      );
    }
  }
  const freqs = p.offers.filter((o) => o.expectedFrequency).map((o) => (p.offers.length > 1 && o.label ? `${o.label}: ${o.expectedFrequency}` : o.expectedFrequency!));
  if (freqs.length) extraLines.push(`Expected purchase frequency: ${freqs.join("; ")}.`);

  const free = p.freemium?.free ?? project.freeOffer;
  const freeLines = free ? `Free offer: ${free}${p.freemium ? `\nWhat you pay for: ${p.freemium.paid}` : ""}` : "Free offer: none.";

  const several = p.offers.length > 1;
  const minimum = p.minimumOrder ? `, minimum order of ${formatMoneyEn(p.minimumOrder.amount, p.currency)} included` : "";
  let payLine: string;
  let ggWhen: string;
  switch (ref.unit) {
    case "month":
      payLine = several ? `you pay for one of the paid offers (${shownPrice})` : `you pay the displayed price (${shownPrice})`;
      ggWhen = "true if you would really pay for this service at this price this month";
      break;
    case "year":
      payLine = several ? `you pay for one of the paid offers (${shownPrice})` : `you pay the displayed price (${shownPrice})`;
      ggWhen = "true if you would really take the annual subscription at this price this month";
      break;
    case "usage":
      payLine = `you pay for at least one ${ref.usageLabel} at the displayed price (${shownPrice})`;
      ggWhen = `true if you would really pay for one ${ref.usageLabel} at this price within the coming month`;
      break;
    case "quantity":
      payLine =
        several || p.minimumOrder
          ? `you place a paid order${p.minimumOrder ? ` (minimum order ${formatMoneyEn(p.minimumOrder.amount, p.currency)})` : ""}`
          : `you place a paid order (${shownPrice})`;
      ggWhen = `true if you would really place an order within the coming month at this price per ${ref.quantity?.unit}${minimum}`;
      break;
    case "one_time":
      payLine = `you buy at the displayed price (${shownPrice})`;
      ggWhen = "true if you would really buy at this price within the coming month";
      break;
  }
  const word = currencyWordEn(p.currency);
  const vwUnit =
    ref.unit === "one_time" ? `in ${word}, as a one-time purchase` : ref.unit === "quantity" ? `in ${word} per ${ref.quantity?.unit}` : `in ${word} per ${ref.unit === "month" ? "month" : ref.unit === "year" ? "year" : ref.usageLabel}`;
  return {
    shownPrice,
    extraLines,
    freeLines,
    payLine,
    ggWhen,
    vwUnit,
    vwReference: several ? `  The price questions (Van Westendorp and tiers) are about the reference offer: ${formatOfferEn(ref, p.currency)}.\n` : "",
    tierList: tiers.map((t) => formatTierEn(p, t)).join(", "),
    word,
  };
}

// ─── Protocole propre au projet ───────────────────────────────────────────────

export function customRelevanceLineEn(p: ResolvedProtocol): string {
  return `- relevance: a single value: ${p.relevance.map((r) => `"${r.code}" if ${r.description}`).join("; ")}.`;
}

export function customObjectionsLineEn(p: ResolvedProtocol): string {
  const noNeed = p.objections.find((o) => o.canonical === "no_need")!.code;
  return `- objections: 0 to 4 real, personal obstacles, each with a category and a concrete detail, from the most to the least decisive. If you are not concerned, only mention what is really decisive for you, often just "${noNeed}", and two objections at most. Categories: ${p.objections.map((o) => `"${o.code}" (${o.description})`).join(", ")}. Choose the most precise category; if none fits, take the closest one. If you ignore the offer or save it for later, give at least one objection.`;
}

export function customBehaviorLinesEn(p: ResolvedProtocol, shownPrice: string): string {
  const lines = p.behaviors.map((b, i) => {
    const priced = b.level === "payment" && !/\d/.test(b.description) ? `${b.description} (${shownPrice})` : b.description;
    return `  "${b.code}": ${priced}${i === p.behaviors.length - 1 ? "." : ";"}`;
  });
  return `- behavior: what you concretely do within the next 7 days, a single value, the most committed action you really take:\n${lines.join("\n")}`;
}

// ─── Prompt système ───────────────────────────────────────────────────────────

export function buildSystemPromptEn(project: Project, tiers: number[], version: "2" | "3" | "4", audience: Audience, proto: ResolvedProtocol): string {
  const known = [...new Set([...project.competitors, ...project.alternatives])];
  const pt = priceTextsEn(project, tiers, audience);
  const text = `You simulate the behaviour of a real person who lives in ${audience.countryName}. They are described at the end of this message by a factual profile, drawn from statistics, and sometimes by a portrait. You are not an assistant, nor a consultant, nor a customer questioned by a polite interviewer: you are this person, in their ordinary day, and you do what they would really do.

## Why candour matters
The project owner uses these simulations to rule out bad ideas before investing in them. A complacent answer costs them money and months of work. There is no right answer and nobody to spare.

## Behaviour rules
1. Inertia by default. In real life, almost everyone ignores an offer like this: you barely notice it and move on. Ignoring it is the normal answer.
2. Any action beyond ignoring it rests on a concrete, current need in your life that you can name. “It might be useful one day” or “the idea is interesting” is not enough: in that case, you ignore it or save it for later.
3. Your constraints are real. Your discretionary budget is what is left each month once everything is paid. Every new subscription competes with the ones you already have and with your other expenses. Your time and attention are limited.
4. You have habits and alternatives, often free ones. You do not change tools without a strong reason.
5. Finding an idea nice makes nobody pay. Approving of the principle is not acting.
6. Many people are simply not concerned by a given offer. That is normal and useful to know: say so.
7. Stay true to your profile: age, job, income, household, relationship with technology, price sensitivity, distrust. Do not invent a need, a project or an interest that appears neither in your profile nor in your portrait and that would be implausible for someone like you.
8. Do not invent any personal fact absent from your profile and your portrait: children (how many, their sex), partner, employment status, employer, a business of your own. If the sex of your children is not specified, say “my children” or “my child”. If you are an employee, you do not have a business of your own; if you have no partner, you do not talk about one.
9. An objection only counts if it really weighs on your decision, in your situation. Do not copy a feature of the offer by reflex (number of members, novelty, price): if you do not have the need, the number of members does not concern you.

## The offer you come across
Name: ${project.name}
Text you see:
“${project.pitch}”
Displayed price: ${pt.shownPrice}${pt.extraLines.map((l) => `\n${l}`).join("")}
${pt.freeLines}
${known.length ? `What already exists for similar needs (you may or may not know some of them, depending on your profile): ${known.join("; ")}.` : ""}

## What you return
A JSON object, and nothing else, with these fields. Text fields are in English, in the first person, short.
${version === "3" || version === "4" ? `${NEED_FREQUENCY_LINE_EN}\n` : ""}- spontaneousReaction: your immediate thought on seeing the offer, one or two sentences.
${proto.custom ? customRelevanceLineEn(proto) : `- relevance: "concerned" if you have today the need the offer addresses; "marginal" if this need exists but remains weak, occasional or distant; "not_concerned" if you do not have it.`}
- relevanceReason: why, in one sentence.
- currentSolution: what you do or use today for this need, or “nothing, I don't need it”.
- alternatives: what you would use instead of this offer (tools, people, habits), possibly empty.
${proto.custom ? customObjectionsLineEn(proto) : `- objections: 0 to 4 real, personal obstacles, each with a category and a concrete detail, from the most to the least decisive. If you are not concerned, only mention what is really decisive for you, often just "no_need", and two objections at most. Categories: "price" (price), "no_need" (no need), "already_covered" (already covered by something else: name it), "trust_privacy" (trust, privacy), "effort_time" (effort or time it would take), "network_effect" (not enough people, empty community), "other". If you ignore the offer or save it for later, give at least one objection.`}
${proto.custom ? customBehaviorLinesEn(proto, pt.shownPrice) : `- behavior: what you concretely do within the next 7 days, a single value, the most committed action you really take:
  "ignore": you move on;
  "save_for_later": you keep the link or tell yourself “I'll have a look”, probably without follow-up;
  "visit_page": you open the page and browse it;
  "free_signup": you sign up for free to have a look, out of curiosity, without necessarily coming back${project.freeOffer ? "" : " (if the offer allows it)"};
  "free_active": you fill in your profile and come back to use the free version, without paying;
  "pay_subscription": ${pt.payLine};
  "recommend": you pay and recommend it to a specific person around you.`}
- behaviorReason: the concrete, current need that justifies this action; or, if you ignore it, what turns you away.
- wouldForward: true if, within the next 7 days, you forward the offer to a specific person around you because it might interest them, whether or not you pay yourself; otherwise false.
- forwardTo: to whom (for example “my colleague who wants to go freelance”), staying within what your profile says; empty string if wouldForward is false.
- vanWestendorp: prices ${pt.vwUnit} for this service as you understand it, increasing (the field names end in “Eur” for historical reasons: give the amounts in ${pt.word}):
${pt.vwReference}  tooCheapEur: a price so low you would doubt the service is serious;
  cheapEur: a price at which it would be a bargain;
  expensiveEur: a price at which it starts to be expensive, without ruling it out;
  tooExpensiveEur: the price from which you would not consider it.
  If you would not pay at any price (no need, or no budget for it), wouldNeverPay = true and the four prices are null; otherwise wouldNeverPay = false and the four prices are filled in.
- gaborGranger: for each tier (${pt.tierList}), ${pt.ggWhen}, given your budget and your need, otherwise false. A yes at one price implies a yes at lower prices. Your answer at the displayed price must match your behaviour: you do not pay for a service you ignore.
- budgetFit: if you say yes to at least one price, where the money comes from (what you cut down or drop, or why it fits easily); otherwise empty string.
- verbatim: one or two sentences you would really say to someone close to you about this offer, in your own words, register and level of language, without advertising style.`;
  return version === "4" ? withAttributeRule(text, ATTRIBUTE_RULE.en, "\n\n## The offer you come across") : text;
}

export function buildUserPromptEn(card: string, constraints: string, narrative: string | null | undefined, encounterText: string, child?: string): string {
  const portrait = narrative?.trim()
    ? `### Portrait (written in the third person: it is you)\n${narrative.trim()}`
    : "### Portrait\n(No portrait: rely on the profile alone, without embellishing.)";
  return `## Who you are
${card}

${portrait}

## Your constraints this month
${constraints}
${child ? `\n${child}\n` : ""}
## The situation
An ordinary weekday, with your usual concerns. ${encounterText}

Reply now with the JSON object only.`;
}

export function buildRepairPromptEn(issues: string[], details: string[] = []): string {
  return `Your answer contains inconsistencies:
${issues.map((i) => `- ${CHECK_LABELS_EN[i] ?? i}`).join("\n")}${details.length ? `\n\nDetails:\n${details.map((d) => `- ${d}`).join("\n")}\nDo not state any personal fact absent from your profile and your portrait.` : ""}

Return the complete JSON object, corrected and consistent. Do not make your answer more favourable to the offer to remove a contradiction: when two elements contradict each other, keep the more cautious one (less commitment, no payment), unless your need and your budget clearly justify the opposite. Reply with the JSON object only.`;
}

/** Précisions de réparation des contrôles de prix, en anglais. */
export function priceIssueDetailsEn(codes: string[], ctx: { price?: { vwUnit: string; minimumLabel?: string }; budgetEur?: number }, currency: string): string[] {
  const out: string[] = [];
  if (codes.includes("vw_unit_scale") && ctx.price) {
    out.push(`Your Van Westendorp prices and your answers to the tiers must be expressed ${ctx.price.vwUnit}, like the proposed tiers.`);
  }
  if (codes.includes("minimum_over_budget") && ctx.price?.minimumLabel) {
    out.push(
      `The minimum order (${ctx.price.minimumLabel}) exceeds your monthly discretionary budget (${formatMoneyEn(ctx.budgetEur ?? 0, currency)}): either you explain precisely in budgetFit how you finance it, or you revise your behaviour and your tiers.`,
    );
  }
  return out;
}

// ─── Rôles (phase 7) ──────────────────────────────────────────────────────────

export const EXPECTED_USAGE_LINE_EN =
  '- expectedUsage: if you took it up, how often you would really use it the following month: "never" (not at all), "tried_once" (once, to try), "monthly" (a few times in the month), "weekly" (every week), "several_per_week" (several times a week).';
export const adoptionLineEn = (label: string) =>
  `- adoptionThreshold: what share of your ${label.toLowerCase()} would need to use the service regularly (at least weekly) for you to pay, from 0 to 100; null if you would not pay in any case.`;

export function roleSectionEn(r: { perspective: string; intro: string | null; offerNote: string | null }): string | null {
  const intro = r.intro ? `${r.intro.trim()} ` : "";
  switch (r.perspective) {
    case "both":
      return r.intro ? `## Your role\n${r.intro.trim()}` : null;
    case "user":
      return `## Your role\n${intro}You would be a user of this service, without paying for it${r.offerNote ? `: ${r.offerNote.trim().replace(/\.$/, "")}` : ""}. The price does not concern you: judge the interest, the use you would make of it and what would hold you back from using it. Not paying does not make an offer useful: the rules below apply to use.`;
    case "payer":
      return `## Your role\n${intro}You are the one who would decide and pay; other people would also use it. Judge the offer in this role, with your budget and your constraints.`;
    case "payer_for_child":
      return `## Your role\n${intro}You answer as a parent. The offer is aimed at a child or a teenager; the child in your household concerned is described at the end (“The child you decide for”). They are the one who would use it; you are the one who would decide and pay. Judge their need and interest as you know them, and the price with your budget. Talk about them in the third person (“my 11-year-old son…”), without inventing other children or details absent from their description.`;
    default:
      return null;
  }
}

export const CHILD_BEHAVIORS_EN: Record<string, string> = {
  ignore: "you move on",
  save_for_later: "you keep the link or tell yourself “I'll have a look”, probably without follow-up",
  visit_page: "you open the page and browse it",
  free_signup: "you install it or sign your child up for free, to have a look, without commitment",
  free_active: "your child uses it regularly in the free version, without paying",
};

/** Ligne « Prix affiché » et ses ancres, pour l'adaptation des rôles. */
export const EN_ANCHORS = {
  relevance: '- relevance: "concerned"',
  shownPrice: "Displayed price: ",
  freeOffer: "Free offer: ",
  behavior: "- behavior: ",
  vw: "- vanWestendorp: ",
  vwEnd: "  If you would not pay at any price",
  gg: "- gaborGranger: ",
  budget: "- budgetFit: ",
  behaviorReason: "- behaviorReason: ",
  candour: "\n\n## Why candour matters",
} as const;

