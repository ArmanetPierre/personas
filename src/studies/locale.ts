import type { Project, Study } from "../db/schema";
import type { Locale, Pack } from "../personas/pack";
import { packManifest } from "./packs";
import { resolveSoclePack } from "../population/target";

/**
 * Public d'une étude : langue des prompts et des réponses, pays des personas et devise de leur budget.
 * Il vient du socle (manifeste du pack : `locale`, `country`, `currency`) ; une étude sur le socle
 * France garde exactement les prompts français historiques (`FR_AUDIENCE`).
 */
export interface Audience {
  locale: Locale;
  /** Code ISO du pays (FR, SG). */
  country: string;
  /** Nom du pays dans la langue du prompt (« France », « Singapore »). */
  countryName: string;
  /** Devise des montants de la persona (budget, abonnements). */
  currency: string;
}

export const FR_AUDIENCE: Audience = { locale: "fr", country: "FR", countryName: "France", currency: "EUR" };

const COUNTRY_NAMES: Record<string, Record<Locale, string>> = {
  FR: { fr: "France", en: "France" },
  SG: { fr: "Singapour", en: "Singapore" },
};

export function audienceOfManifest(m: Pick<Pack["manifest"], "locale" | "country" | "currency">): Audience {
  const country = m.country.toUpperCase();
  const locale = m.locale ?? "fr";
  return { locale, country, countryName: COUNTRY_NAMES[country]?.[locale] ?? country, currency: m.currency ?? "EUR" };
}

export function audienceOf(pack: Pick<Pack, "manifest">): Audience {
  return audienceOfManifest(pack.manifest);
}

/**
 * Public d'une étude : celui du socle de sa première population connue. Une étude sans population
 * (v1) ou sur un pack introuvable reste française.
 */
export function studyAudience(study: Pick<Study, "populations">): Audience {
  for (const pop of study.populations ?? []) {
    const m = packManifest(pop.packVersion);
    if (m) return audienceOfManifest(m);
  }
  return FR_AUDIENCE;
}

export const isEnglish = (a: Pick<Audience, "locale"> | undefined | null): boolean => a?.locale === "en";

/**
 * Langue d'un projet : `extra.locale` s'il est déclaré, sinon celle du socle de sa cible (ou de son premier
 * rôle) ; français par défaut. Sert aux assistants qui écrivent un texte montré aux personas (pitch neutre,
 * protocole propre au projet) ou destiné à l'étude (recommandations).
 */
export function projectLocale(project: Pick<Project, "extra">): Locale {
  const x = (project.extra ?? {}) as { locale?: string; target?: { socle?: string }; roles?: Array<{ target?: { socle?: string } }> };
  if (x.locale === "en" || x.locale === "fr") return x.locale;
  const socle = x.target?.socle ?? x.roles?.[0]?.target?.socle;
  if (!socle) return "fr";
  try {
    return resolveSoclePack(socle).manifest.locale;
  } catch {
    // socle désigné par sa version (« sg-2026.1 ») plutôt que par son dossier
    return packManifest(socle)?.locale ?? "fr";
  }
}
