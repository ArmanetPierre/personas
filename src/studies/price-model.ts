import { z } from "zod";
import type { Project } from "../db/schema";

/**
 * Modèle de prix générique (phase 2b) : unités, devises, offres multiples avec une offre de
 * référence, freemium, panier minimum, paliers Gabor-Granger dans l'unité de la référence.
 *
 * Stockage : `projects.extra.pricing` (forme normalisée). `projects.price_eur` garde le montant
 * de l'offre de référence (dans sa devise, malgré le nom de la colonne) et `projects.price_period`
 * son unité, pour la rétrocompatibilité. Un projet sans `extra.pricing` est un projet « historique »
 * (`price: { amountEur, period }`) : il est lu comme une offre unique en EUR, et son prompt,
 * son résumé et sa comparaison restent strictement identiques.
 */

export const PRICE_UNITS = ["month", "year", "one_time", "usage", "quantity"] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const offerSchema = z
  .object({
    /** Identifiant court, ex. « mensuel », « kg ». */
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "minuscules, chiffres, tirets"),
    /** Libellé montré à la persona, ex. « Premium Coach », « pack Weekender ». */
    label: z.string().min(1).optional(),
    amount: z.number().positive(),
    unit: z.enum(PRICE_UNITS),
    /** Pour `usage` : ce qu'on paie à l'acte, ex. « mise en relation », « transcription ». */
    usageLabel: z.string().min(1).optional(),
    /** Pour `quantity` : unité de mesure (kg, pack, pièce) et formulation (« le kg », « la pièce »). */
    quantity: z.object({ unit: z.string().min(1), per: z.string().min(1).optional() }).optional(),
    /** Fréquence d'achat attendue, montrée à la persona (achat unique, usage, quantité). */
    expectedFrequency: z.string().min(1).optional(),
    /** Achats (ou unités) par mois, pour la normalisation en coût mensuel équivalent. */
    purchasesPerMonth: z.number().positive().optional(),
  })
  .superRefine((o, ctx) => {
    if (o.unit === "usage" && !o.usageLabel) ctx.addIssue({ code: "custom", path: ["usageLabel"], message: "requis pour une unité « usage » (ex. « transcription »)" });
    if (o.unit === "quantity" && !o.quantity) ctx.addIssue({ code: "custom", path: ["quantity"], message: "requis pour une unité « quantity » (ex. { unit: kg })" });
  });
export type PriceOffer = z.infer<typeof offerSchema>;

export const fxSchema = z.object({
  /** Valeur d'une unité de la devise en euros, ex. 0,69 pour 1 SGD. */
  eurPerUnit: z.number().positive(),
  /** Date du taux (AAAA-MM-JJ). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().optional(),
});
export type Fx = z.infer<typeof fxSchema>;

/**
 * Taux fixes indicatifs, utilisés quand le projet n'en déclare pas. Ordres de grandeur à mettre à jour :
 * ils ne servent qu'à situer un prix dans le budget mensuel en euros de la persona.
 */
export const FX_TABLE: Record<string, Fx> = {
  USD: { eurPerUnit: 0.92, date: "2026-10-01", source: "table interne, indicatif" },
  SGD: { eurPerUnit: 0.69, date: "2026-10-01", source: "table interne, indicatif" },
  GBP: { eurPerUnit: 1.17, date: "2026-10-01", source: "table interne, indicatif" },
  CHF: { eurPerUnit: 1.06, date: "2026-10-01", source: "table interne, indicatif" },
};

export const pricingSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/, "code ISO à 3 lettres (EUR, SGD, USD…)").default("EUR"),
    offers: z.array(offerSchema).min(1),
    /** Offre de référence : Van Westendorp et Gabor-Granger sont posés dans son unité. Par défaut la première. */
    reference: z.string().optional(),
    /** Paliers Gabor-Granger, dans l'unité et la devise de l'offre de référence. */
    tiers: z.array(z.number().positive()).min(2).max(5).optional(),
    freemium: z.object({ free: z.string().min(1), paid: z.string().min(1) }).optional(),
    minimumOrder: z.object({ amount: z.number().positive(), note: z.string().min(1).optional() }).optional(),
    fx: fxSchema.optional(),
  })
  .superRefine((p, ctx) => {
    const ids = p.offers.map((o) => o.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["offers"], message: "identifiants d'offre en double" });
    if (p.reference && !ids.includes(p.reference)) ctx.addIssue({ code: "custom", path: ["reference"], message: `offre de référence inconnue (offres : ${ids.join(", ")})` });
    if (p.currency !== "EUR" && !p.fx && !FX_TABLE[p.currency]) {
      ctx.addIssue({ code: "custom", path: ["fx"], message: `taux de change requis pour ${p.currency} (fx: { eurPerUnit, date })` });
    }
  });
export type PricingInput = z.input<typeof pricingSchema>;

/** Forme normalisée stockée dans `projects.extra.pricing`. */
export interface Pricing {
  currency: string;
  offers: PriceOffer[];
  reference: string;
  tiers?: number[];
  freemium?: { free: string; paid: string };
  minimumOrder?: { amount: number; note?: string };
  fx?: Fx;
}

export function normalizePricing(input: z.infer<typeof pricingSchema>): Pricing {
  return {
    currency: input.currency,
    offers: input.offers,
    reference: input.reference ?? input.offers[0]!.id,
    ...(input.tiers && { tiers: [...input.tiers].sort((a, b) => a - b) }),
    ...(input.freemium && { freemium: input.freemium }),
    ...(input.minimumOrder && { minimumOrder: input.minimumOrder }),
    ...(input.fx && { fx: input.fx }),
  };
}

// ─── Unités historiques ───────────────────────────────────────────────────────

/** Correspondance des anciennes périodes (`price.period`) vers le modèle générique. */
export function legacyOffer(amount: number, period: string | null): PriceOffer {
  switch (period ?? "month") {
    case "year":
      return { id: "main", amount, unit: "year" };
    case "once":
      return { id: "main", amount, unit: "one_time" };
    case "connection":
      return { id: "main", amount, unit: "usage", usageLabel: "mise en relation" };
    default:
      return { id: "main", amount, unit: "month" };
  }
}

/** Modèle de prix d'un projet : celui de `extra.pricing`, sinon reconstruit depuis les colonnes historiques. */
export function pricingOf(project: Pick<Project, "priceEur" | "pricePeriod" | "extra" | "freeOffer">): Pricing | null {
  const stored = (project.extra as { pricing?: Pricing } | null)?.pricing;
  if (stored) return stored;
  if (!project.priceEur) return null;
  const tiers = (project.extra as { priceTiers?: number[] } | null)?.priceTiers;
  return { currency: "EUR", offers: [legacyOffer(project.priceEur, project.pricePeriod)], reference: "main", ...(tiers && { tiers }) };
}

/** Vrai si le projet utilise le modèle générique (et non les colonnes historiques). */
export function hasGenericPricing(project: Pick<Project, "extra">): boolean {
  return Boolean((project.extra as { pricing?: unknown } | null)?.pricing);
}

export function referenceOffer(p: Pricing): PriceOffer {
  return p.offers.find((o) => o.id === p.reference) ?? p.offers[0]!;
}

// ─── Formatage ────────────────────────────────────────────────────────────────

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

/** « 9,99 $ », « 150 SGD », « 5 € ». */
export function formatMoney(amount: number, currency = "EUR"): string {
  return `${amount.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ${SYMBOLS[currency] ?? currency}`;
}

/** Symbole ou code d'une devise, pour « prix en € » ou « prix en SGD ». */
export function currencyWord(currency = "EUR"): string {
  return SYMBOLS[currency] ?? currency;
}

/** Libellé « par … » de l'unité d'une offre : « mois », « an », « kg », « mise en relation », « achat ». */
export function unitLabel(o: PriceOffer): string {
  switch (o.unit) {
    case "month":
      return "mois";
    case "year":
      return "an";
    case "one_time":
      return "achat unique";
    case "usage":
      return o.usageLabel ?? "usage";
    case "quantity":
      return o.quantity?.unit ?? "unité";
  }
}

/** Prix d'une offre, sans libellé : « 5 €/mois », « 15 € par mise en relation », « 24 SGD le kg », « 29 € ». */
export function formatOfferAmount(amount: number, o: PriceOffer, currency = "EUR"): string {
  const a = formatMoney(amount, currency);
  switch (o.unit) {
    case "month":
      return `${a}/mois`;
    case "year":
      return `${a}/an`;
    case "one_time":
      return a;
    case "usage":
      return `${a} par ${o.usageLabel ?? "usage"}`;
    case "quantity":
      return `${a} ${o.quantity?.per ?? `le ${o.quantity?.unit ?? "unité"}`}`;
  }
}

/** Une offre telle qu'affichée : « Premium Coach : 9,99 $/mois », « 29 € en achat unique ». */
export function formatOffer(o: PriceOffer, currency = "EUR"): string {
  const price = o.unit === "one_time" ? `${formatMoney(o.amount, currency)} en achat unique` : formatOfferAmount(o.amount, o, currency);
  return o.label ? `${o.label} : ${price}` : price;
}

/** Toutes les offres : « 9,99 $/mois ou 99 $/an » ; « … ; panier minimum de 150 SGD ». */
export function formatPricing(p: Pricing): string {
  const labelled = p.offers.some((o) => o.label);
  const offers = p.offers.map((o) => formatOffer(o, p.currency)).join(labelled ? " ; " : " ou ");
  const min = p.minimumOrder ? `${labelled ? " ;" : ","} panier minimum de ${formatMoney(p.minimumOrder.amount, p.currency)}${p.minimumOrder.note ? ` (${p.minimumOrder.note})` : ""}` : "";
  return offers + min;
}

/** Prix de l'offre de référence d'un projet (historique : identique à l'ancien `formatPrice`). */
export function formatTier(p: Pricing, amount: number): string {
  return formatOfferAmount(amount, referenceOffer(p), p.currency);
}

// ─── Devises et normalisation ─────────────────────────────────────────────────

export function fxOf(p: Pricing): Fx | null {
  if (p.currency === "EUR") return { eurPerUnit: 1, date: "", source: "" };
  return p.fx ?? FX_TABLE[p.currency] ?? null;
}

/** Montant en euros (null si la devise n'a pas de taux). */
export function toEur(p: Pricing, amount: number): number | null {
  const fx = fxOf(p);
  return fx ? amount * fx.eurPerUnit : null;
}

/** Arrondi lisible d'un équivalent : centimes sous 20, unités au-delà. */
export function roundEquivalent(x: number): number {
  return x < 20 ? Math.round(x * 100) / 100 : Math.round(x);
}

/**
 * Facteur qui convertit un prix de l'offre en coût mensuel équivalent (même devise).
 * Mois : 1 ; an : 1/12 ; usage, quantité ou achat unique : `purchasesPerMonth` s'il est déclaré, sinon null.
 */
export function monthlyFactor(o: PriceOffer): number | null {
  switch (o.unit) {
    case "month":
      return 1;
    case "year":
      return 1 / 12;
    default:
      return o.purchasesPerMonth ?? null;
  }
}

/** Coût mensuel équivalent en euros d'un prix exprimé dans l'unité de l'offre (null si non normalisable). */
export function monthlyEurEquivalent(p: Pricing, o: PriceOffer, amount: number): number | null {
  const f = monthlyFactor(o);
  const eur = toEur(p, amount);
  return f === null || eur === null ? null : eur * f;
}

/** Prix d'un projet pour les sorties console et l'API (« 9,99 $/mois ou 99 $/an »). */
export function formatProjectPrice(project: Pick<Project, "priceEur" | "pricePeriod" | "extra" | "freeOffer">): string {
  const p = pricingOf(project);
  return p ? formatPricing(p) : "sans prix";
}

/** Un palier Gabor-Granger d'un projet, dans l'unité et la devise de l'offre de référence. */
export function formatProjectTier(project: Pick<Project, "priceEur" | "pricePeriod" | "extra" | "freeOffer">, amount: number): string {
  const p = pricingOf(project);
  return p ? formatTier(p, amount) : formatMoney(amount);
}
