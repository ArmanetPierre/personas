import { formatPricing, formatTier, unitLabel, type PriceOffer, type Pricing } from "../studies/price-model";
import { formatMoneyEn, formatPricingEn, formatTierEn, unitLabelEn } from "../studies/price-model-en";
import { formatPrice, PER_USE_PERIODS } from "../studies/project";
import type { Lang } from "./i18n";
import { PERIOD_LABELS_EN } from "./i18n-labels";

/**
 * Prix affichés en anglais (`?lang=en`) : formatage anglais commun aux études en anglais
 * (src/studies/price-model-en.ts, devise du projet : « S$24 per kg »). Le français reste celui de
 * price-model.ts et project.ts. Les textes saisis dans le projet (libellé d'offre, `quantity.per`,
 * `usageLabel`, note du panier minimum) sont des données : ils restent tels quels.
 */

/** Prix d'un projet historique (colonnes `priceEur`, `pricePeriod`) : « €5/month ». */
export function formatPriceEn(amount: number, period: string | null): string {
  const a = formatMoneyEn(amount, "EUR");
  if (period === "once") return a;
  if (period && PER_USE_PERIODS.has(period)) return `${a} per ${PERIOD_LABELS_EN[period] ?? period}`;
  return `${a}/${PERIOD_LABELS_EN[period ?? "month"] ?? period}`;
}

// Sélecteurs par langue
export const pricingIn = (lang: Lang, p: Pricing) => (lang === "en" ? formatPricingEn(p) : formatPricing(p));
export const tierIn = (lang: Lang, p: Pricing, amount: number) => (lang === "en" ? formatTierEn(p, amount) : formatTier(p, amount));
export const unitLabelIn = (lang: Lang, o: PriceOffer) => (lang === "en" ? unitLabelEn(o) : unitLabel(o));
export const priceIn = (lang: Lang, amount: number, period: string | null) => (lang === "en" ? formatPriceEn(amount, period) : formatPrice(amount, period));

/** Unité française déjà calculée (« mois », « achat unique », « mise en relation », « achat ») vers l'anglais. */
const UNIT_FR_EN: Record<string, string> = {
  mois: "month",
  an: "year",
  "achat unique": "one-time purchase",
  "mise en relation": "connection",
  achat: "purchase",
  usage: "use",
  unité: "unit",
};
export const unitWordIn = (lang: Lang, fr: string) => (lang === "en" ? UNIT_FR_EN[fr] ?? fr : fr);
