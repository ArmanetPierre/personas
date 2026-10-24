import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { messageIn } from "../web/i18n";
import { cliMessageEn } from "./error-patterns";
import { en } from "./messages.en";
import { fr, type CliMessages } from "./messages.fr";

/**
 * Langue des sorties console de la CLI (usage, progression, erreurs, résumés texte).
 *
 * - `PERSONAS_LANG=fr|en` (environnement, puis `.env`) l'impose ;
 * - sinon la locale du terminal : `LC_ALL`, puis `LC_MESSAGES`, puis `LANG` (fr* → français, sinon anglais).
 *
 * Le français reste identique à l'historique, octet pour octet. Les dictionnaires sont dans
 * messages.fr.ts (référence, qui définit le type) et messages.en.ts : une clé manquante ou en trop en
 * anglais est une erreur de typecheck. Les noms de commandes et d'options ne sont jamais traduits.
 */

export type CliLang = "fr" | "en";
export type { CliMessages };

const asLang = (v: string | undefined): CliLang | null => {
  const x = v?.trim().toLowerCase();
  return x?.startsWith("fr") ? "fr" : x?.startsWith("en") ? "en" : null;
};

/** `PERSONAS_LANG` déclaré dans `.env` (lu seul, sans charger le reste du fichier). */
function dotEnvLang(path = ".env"): string | undefined {
  try {
    return parseEnv(readFileSync(path, "utf8")).PERSONAS_LANG;
  } catch {
    return undefined;
  }
}

/** Langue de la CLI selon l'environnement (voir l'en-tête). `dotEnv` : valeur de `.env`, lue par défaut. */
export function detectCliLang(env: NodeJS.ProcessEnv = process.env, dotEnv: string | undefined = env === process.env ? dotEnvLang() : undefined): CliLang {
  const forced = asLang(env.PERSONAS_LANG) ?? asLang(dotEnv);
  if (forced) return forced;
  // Ordre POSIX : LC_ALL l'emporte sur LC_MESSAGES, qui l'emporte sur LANG ; « C » / « POSIX » → anglais
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v && v.trim());
  return locale && /^fr/i.test(locale.trim()) ? "fr" : "en";
}

export const CLI_MESSAGES: Record<CliLang, CliMessages> = { fr, en };

/** Langue courante de la CLI (fixée au démarrage du processus). */
export const lang: CliLang = detectCliLang();
/** Messages de la langue courante. */
export const t: CliMessages = CLI_MESSAGES[lang];

/** Locale Intl des nombres : fr-FR, en-GB. */
export const numberLocale = lang === "fr" ? "fr-FR" : "en-GB";

/**
 * Message d'une erreur levée ailleurs dans src/, traduit en anglais quand le motif est connu
 * (mêmes motifs que l'API web, src/web/i18n.ts) ; inchangé en français.
 */
export function errorText(err: unknown, l: CliLang = lang): string {
  const msg = err instanceof Error ? err.message : String(err);
  return l === "en" ? messageIn("en", cliMessageEn(msg)) : msg;
}
