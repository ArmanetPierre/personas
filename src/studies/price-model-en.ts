import { FX_TABLE, referenceOffer, type PriceOffer, type Pricing } from "./price-model";

/**
 * Formatage anglais des prix (études en anglais, ex. socle Singapour) et conversion entre devises.
 * Le formatage français (`price-model.ts`) n'est pas modifié.
 */

const PREFIX: Record<string, string> = { EUR: "€", USD: "US$", SGD: "S$", GBP: "£" };

/** « S$24 », « €9.99 », « US$1,250 », « CHF 10 ». */
export function formatMoneyEn(amount: number, currency = "EUR"): string {
  const cents = Math.round(amount * 100) % 100 !== 0;
  const n = amount.toLocaleString("en-SG", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
  const p = PREFIX[currency];
  return p ? `${p}${n}` : `${currency} ${n}`;
}

/** Devise en toutes lettres courtes, pour « prices in S$ per kg ». */
export function currencyWordEn(currency = "EUR"): string {
  return PREFIX[currency] ?? currency;
}

export function unitLabelEn(o: PriceOffer): string {
  switch (o.unit) {
    case "month":
      return "month";
    case "year":
      return "year";
    case "one_time":
      return "one-time purchase";
    case "usage":
      return o.usageLabel ?? "use";
    case "quantity":
      return o.quantity?.unit ?? "unit";
  }
}

/** « S$9.99/month », « S$15 per transcription », « S$24 per kg », « S$29 ». */
export function formatOfferAmountEn(amount: number, o: PriceOffer, currency = "EUR"): string {
  const a = formatMoneyEn(amount, currency);
  switch (o.unit) {
    case "month":
      return `${a}/month`;
    case "year":
      return `${a}/year`;
    case "one_time":
      return a;
    case "usage":
      return `${a} per ${o.usageLabel ?? "use"}`;
    case "quantity":
      return `${a} ${o.quantity?.per ?? `per ${o.quantity?.unit ?? "unit"}`}`;
  }
}

export function formatOfferEn(o: PriceOffer, currency = "EUR"): string {
  const price = o.unit === "one_time" ? `${formatMoneyEn(o.amount, currency)} one-time purchase` : formatOfferAmountEn(o.amount, o, currency);
  return o.label ? `${o.label}: ${price}` : price;
}

/** « S$9.99/month or S$99/year » ; « …; minimum order S$150 (free delivery) ». */
export function formatPricingEn(p: Pricing): string {
  const labelled = p.offers.some((o) => o.label);
  const offers = p.offers.map((o) => formatOfferEn(o, p.currency)).join(labelled ? "; " : " or ");
  const min = p.minimumOrder ? `${labelled ? ";" : ","} minimum order ${formatMoneyEn(p.minimumOrder.amount, p.currency)}${p.minimumOrder.note ? ` (${p.minimumOrder.note})` : ""}` : "";
  return offers + min;
}

export function formatTierEn(p: Pricing, amount: number): string {
  return formatOfferAmountEn(amount, referenceOffer(p), p.currency);
}

/** Valeur en euros d'une unité de devise : taux du projet pour sa devise, sinon table interne ; null si inconnu. */
export function eurPerUnit(currency: string, p?: Pick<Pricing, "currency" | "fx">): number | null {
  if (currency === "EUR") return 1;
  if (p && p.currency === currency && p.fx) return p.fx.eurPerUnit;
  return FX_TABLE[currency]?.eurPerUnit ?? null;
}

/** Montant converti d'une devise à une autre (via l'euro) ; null si un taux manque. */
export function convertAmount(amount: number, from: string, to: string, p?: Pick<Pricing, "currency" | "fx">): number | null {
  if (from === to) return amount;
  const a = eurPerUnit(from, p);
  const b = eurPerUnit(to, p);
  return a === null || b === null ? null : (amount * a) / b;
}

/** Date et source du taux utilisé pour une devise (projet, sinon table interne). */
export function fxDate(currency: string, p?: Pick<Pricing, "currency" | "fx">): string {
  if (p && p.currency === currency && p.fx) return p.fx.date;
  return FX_TABLE[currency]?.date ?? "";
}
