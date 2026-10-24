import type { Context } from "hono";
import type { Project } from "../db/schema";
import { projectLocale as studiesProjectLocale } from "../studies/locale";

/**
 * Langue des textes générés par l'API (libellés, critères en clair, notes, statuts).
 * Le français est la langue par défaut et reste identique ; `?lang=en` demande l'anglais.
 * Les résumés déjà calculés en base ne sont jamais réécrits : seule leur présentation est traduite.
 */

export type Lang = "fr" | "en";
export const DEFAULT_LANG: Lang = "fr";

export const isLang = (x: unknown): x is Lang => x === "fr" || x === "en";

/** Langue demandée par la requête (`?lang=en`), français sinon. */
export function langOf(c: Context): Lang {
  const q = c.req.query("lang");
  return isLang(q) ? q : DEFAULT_LANG;
}

/** Texte selon la langue. */
export const L = <T>(lang: Lang, fr: T, en: T): T => (lang === "en" ? en : fr);

/** Table de libellés anglais superposée à une table française : l'anglais manquant retombe sur le français. */
export function overlay(lang: Lang, fr: Record<string, string>, en: Record<string, string>): Record<string, string> {
  return lang === "en" ? { ...fr, ...en } : fr;
}

/** Libellé traduit d'un code, repli sur le libellé français fourni. */
export const labelIn = (lang: Lang, en: Record<string, string>, code: string, fr: string): string => (lang === "en" ? en[code] ?? fr : fr);

/** Locale Intl des nombres : fr-FR, en-GB. */
export const numberLocale = (lang: Lang) => (lang === "en" ? "en-GB" : "fr-FR");

/**
 * Langue du contenu d'un projet : `extra.locale` s'il est déclaré, sinon `manifest.locale` du socle de sa
 * cible (ou de son premier rôle) ; français par défaut. Même règle que les assistants (src/studies/locale.ts).
 */
export const projectLocale = (p: Pick<Project, "extra">): Lang => studiesProjectLocale(p);

// ─── Zone géographique d'un socle ─────────────────────────────────────────────

/** Formes du nom de la zone d'un socle, pour les phrases de l'interface. */
export interface Zone {
  /** Complément de « adultes » : « de France métropolitaine », « in Singapore ». */
  of: string;
  /** Après « personnes » : « en France », « in Singapore ». */
  in: string;
  /** Complément de « personas tirées » : « de la population française », « from the Singapore population ». */
  population: string;
}

const ZONES: Record<string, Record<Lang, Zone>> = {
  FR: {
    fr: { of: "de France métropolitaine", in: "en France", population: "de la population française" },
    en: { of: "in metropolitan France", in: "in France", population: "from the French population" },
  },
  SG: {
    fr: { of: "de Singapour", in: "à Singapour", population: "de la population de Singapour" },
    en: { of: "in Singapore", in: "in Singapore", population: "from the Singapore population" },
  },
};
const GENERIC_ZONE: Record<Lang, Zone> = {
  fr: { of: "de la population de base", in: "(estimation)", population: "de la population de base" },
  en: { of: "in the base population", in: "(estimate)", population: "from the base population" },
};

/** Zone d'un socle d'après `manifest.country` ; pays inconnu : formulation générique. */
export const zoneOf = (country: string | null | undefined, lang: Lang): Zone => ZONES[(country ?? "").toUpperCase()]?.[lang] ?? GENERIC_ZONE[lang];

// ─── Messages d'erreur ────────────────────────────────────────────────────────

/**
 * Traductions des messages d'erreur renvoyés à l'interface (src/web et ceux levés ailleurs dans src/).
 * Motifs non ancrés : un message composé est traduit morceau par morceau ; un message inconnu reste en français.
 * Le statut HTTP est décidé avant la traduction (voir httpError dans app.ts).
 */
const ERROR_PATTERNS: Array<[RegExp, string]> = [
  // Introuvables (404)
  [/Projet introuvable : ([^\s]+)(?: \(ni fichier ni id en base\)\.)?/g, "Project not found: $1"],
  [/Étude introuvable : /g, "Study not found: "],
  [/Persona introuvable : /g, "Persona not found: "],
  [/Réponse introuvable\./g, "Response not found."],
  [/Brouillon introuvable : /g, "Draft not found: "],
  [/Module introuvable : /g, "Module not found: "],
  [/Module « ([^»]+) » introuvable(?: \(requis par ([^)]+)\))?/g, "Module “$1” not found (required by $2)"],
  [/Recommandation introuvable : /g, "Recommendation not found: "],
  [/Fichier introuvable : /g, "File not found: "],
  [/Préfixe ambigu : /g, "Ambiguous prefix: "],
  // Conflits (409)
  [/Le projet « ([^»]+) » existe déjà \(ajouter --update pour le remplacer\)\./g, "Project “$1” already exists (add --update to replace it)."],
  [/Le projet « ([^»]+) » existe déjà : variante déjà créée \?/g, "Project “$1” already exists: variant already created?"],
  [/Le brouillon ([^\s]+) existe déjà\./g, "Draft $1 already exists."],
  [/L'étude ([^\s]+) tourne déjà \(processus (\d+)\)\./g, "Study $1 is already running (process $2)."],
  [/Une tâche de l'assistant tourne déjà sur ce brouillon \(processus (\d+)\)\./g, "An assistant task is already running on this draft (process $1)."],
  [/Étude déjà complète\./g, "Study already complete."],
  [/Ce brouillon a déjà été validé\./g, "This draft has already been validated."],
  [/L'assistant travaille sur ce brouillon : attendre la fin avant de l'éditer\./g, "The assistant is working on this draft: wait until it finishes before editing it."],
  [/L'assistant travaille encore sur ce brouillon\./g, "The assistant is still working on this draft."],
  [/Brouillon pas prêt \(statut ([^)]+)\)\./g, "Draft not ready (status $1)."],
  [/Validation refusée : il reste des erreurs\./g, "Validation refused: errors remain."],
  [/Module\(s\) à valider avant de lancer une étude : /g, "Module(s) to validate before launching a study: "],
  // Indisponibles (503)
  [/Assistant indisponible : le script npm « ([^»]+) » n'existe pas encore dans package\.json\./g, "Assistant unavailable: npm script “$1” does not exist yet in package.json."],
  [/Assistant indisponible : src\/modules\/assistant\/index\.ts n'existe pas encore\./g, "Assistant unavailable: src/modules/assistant/index.ts does not exist yet."],
  [/Assistant incomplet : fonction\(s\) absente\(s\) : /g, "Incomplete assistant: missing function(s): "],
  [/Assistant indisponible : /g, "Assistant unavailable: "],
  [/Recommandations indisponibles : le script study:recommend n'existe pas encore\./g, "Recommendations unavailable: the study:recommend script does not exist yet."],
  [/Recommandations indisponibles : createNextStudy absente de src\/studies\/recommend\.ts\./g, "Recommendations unavailable: createNextStudy missing from src/studies/recommend.ts."],
  [/Recommandations indisponibles : src\/studies\/recommend\.ts n'existe pas encore\./g, "Recommendations unavailable: src/studies/recommend.ts does not exist yet."],
  [/Recommandations indisponibles\./g, "Recommendations unavailable."],
  [/Recommandations indisponibles : /g, "Recommendations unavailable: "],
  [/Le script project:neutralize-pitch n'existe pas\./g, "The project:neutralize-pitch script does not exist."],
  [/Aperçu indisponible\./g, "Preview unavailable."],
  // Requêtes invalides (400, 422)
  [/Projet invalide\./g, "Invalid project."],
  [/Fichier vide\./g, "Empty file."],
  [/Fichier illisible : /g, "Unreadable file: "],
  [/YAML illisible : /g, "Unreadable YAML: "],
  [/YAML vide\./g, "Empty YAML."],
  [/YAML invalide : non enregistré\./g, "Invalid YAML: not saved."],
  [/Pas encore de YAML : proposition en cours\./g, "No YAML yet: proposal in progress."],
  [/Population cible requise \(ou « même échantillon que », ou la cible du projet\)\./g, "Target population required (or “same sample as”, or the project's target)."],
  [/Pitch au ton commercial \(score (\d+)\/100, seuil (\d+)\) : le protocole v(\d) exige un pitch neutre\./g, "Pitch with a sales tone (score $1/100, threshold $2): protocol v$3 requires a neutral pitch."],
  [/Ce projet ne déclare pas de cible \(bloc `target`\)\./g, "This project declares no target (`target` block)."],
  [/Effectif de la cible requis \(n\)\./g, "Target sample size required (n)."],
  [/Effectif du témoin requis\./g, "Control sample size required."],
  [/Coût inconnu pour le modèle ([^\s]+) \(absent de pricing\/models\.json\) : confirmer le lancement malgré le coût inconnu\./g, "Unknown cost for model $1 (not in pricing/models.json): confirm the launch despite the unknown cost."],
  [/Plafond de dépense atteint \(par étude, profil ([^)]+)\) : /g, "Spending cap reached (per study, profile $1): "],
  [/Plafond de dépense atteint \(par jour, profil ([^)]+)\) : /g, "Spending cap reached (per day, profile $1): "],
  [/Plafond de dépense atteint \(par mois, profil ([^)]+)\) : /g, "Spending cap reached (per month, profile $1): "],
  [/ \$ engagés \+ /g, " $ committed + "],
  [/ \$ prévus > /g, " $ expected > "],
  [/Relever le plafond : /g, "Raise the cap: "],
  [/Plafond de dépense non vérifiable \(profil ([^)]+)\) : prix du modèle (\S+) inconnu \(absent de pricing\/models\.json\), aucun appel n'est parti\. /g, "Spending cap cannot be checked (profile $1): the price of model $2 is unknown (not in pricing/models.json), no call was sent. "],
  [/Ajouter son prix au fichier \(ou PERSONAS_PRICING\), ou accepter le coût inconnu pour cette étude : (.+?) \(coût compté au prix du modèle le plus cher du fournisseur\)\./g, "Add its price to the file (or PERSONAS_PRICING), or accept the unknown cost for this study: $1 (cost counted at the price of the provider's most expensive model)."],
  [/, puis relancer study:run \(les réponses déjà obtenues sont gardées\)\./g, ", then run study:run again (responses already obtained are kept)."],
  [/Le profil ([^\s]+) \(([^)]+)\) ne correspond pas au fournisseur de l'étude ([^\s]+) \(([^)]+)\)\./g, "Profile $1 ($2) does not match the provider of study $3 ($4)."],
  [/Le profil ([^\s]+) de l'étude ([^\s]+) n'existe plus : relancer avec --profile <nom> \(un profil ([^)]+)\)\. /g, "Profile $1 of study $2 no longer exists: run again with --profile <name> (a $3 profile). "],
  [/Profil inconnu : /g, "Unknown profile: "],
  [/Backend refusé : /g, "Backend refused: "],
  [/Aucune réponse pour cette étude\./g, "No responses for this study."],
  [/Aucune réponse pour l'étude ([^\s]+)\./g, "No responses for study $1."],
  [/Choisir au moins deux études\./g, "Choose at least two studies."],
  [/Identifiant d'étude invalide : /g, "Invalid study identifier: "],
  [/Identifiant invalide : /g, "Invalid identifier: "],
  [/Brouillon invalide : /g, "Invalid draft: "],
  [/Décrire le domaine en une phrase au moins \(10 caractères\)\./g, "Describe the domain in at least one sentence (10 characters)."],
  [/Socle inconnu : /g, "Unknown base population: "],
  [/Préciser la révision demandée\./g, "Specify the requested revision."],
  [/Clé invalide\./g, "Invalid key."],
  [/Bloc inconnu\./g, "Unknown block."],
  [/Bloc (target|protocol) invalide\./g, "Invalid $1 block."],
  [/Confirmation requise \(confirm: true\)\./g, "Confirmation required (confirm: true)."],
  [/Pas de taxonomie d'objections pour ce projet : ni bloc protocol, ni proposition de protocole\./g, "No objection taxonomy for this project: neither a protocol block nor a protocol proposal."],
  [/Le fichier projet modifié serait invalide : rien n'a été écrit\./g, "The modified project file would be invalid: nothing was written."],
  [/Le fichier (.+?) décrit le projet ([^,\s]+), pas ([^.\s]+)\./g, "File $1 describes project $2, not $3."],
  [/Cette recommandation ne propose pas d'étude suivante\./g, "This recommendation does not propose a next study."],
  [/Texte requis\./g, "Text required."],
  [/Pitch requis\./g, "Pitch required."],
  [/Pitch trop court \(20 caractères au moins\)\./g, "Pitch too short (at least 20 characters)."],
  [/Aucune proposition en attente\./g, "No pending proposal."],
  [/Le processus n'a pas démarré\./g, "The process did not start."],
  // Validation du corps d'une étude (studyValidationMessage, app.ts)
  [/Population cible : choisir un pack ou un socle\./g, "Target population: choose a pack or a base population."],
  [/Population témoin : choisir un pack ou un socle\./g, "Control population: choose a pack or a base population."],
  [/Effectif de la cible : /g, "Target sample size: "],
  [/Effectif du témoin : /g, "Control sample size: "],
  [/Quotas de la cible : /g, "Target quotas: "],
  [/Quotas du témoin : /g, "Control quotas: "],
  [/Nom de l'étude : /g, "Study name: "],
  [/Profil de moteur : /g, "Engine profile: "],
  [/Version du protocole : /g, "Protocol version: "],
  [/(^|; )Effectif : /g, "$1Sample size: "],
  [/(^|; )Graine : /g, "$1Seed: "],
  [/(^|; )Modèle : /g, "$1Model: "],
  [/(^|; )Projet : /g, "$1Project: "],
  [/Champ « ([^»]+) » : /g, "Field “$1”: "],
  [/nombre entier positif attendu\./g, "positive whole number expected."],
  [/valeur manquante ou invalide\./g, "missing or invalid value."],
  [/valeur invalide\./g, "invalid value."],
  [/(^|; )étude : /g, "$1study: "],
  [/ ; /g, "; "],
];

/** Message (d'erreur, d'indisponibilité) dans la langue demandée ; inchangé en français. */
export function messageIn(lang: Lang, message: string): string {
  if (lang !== "en") return message;
  let out = message;
  for (const [re, to] of ERROR_PATTERNS) out = out.replace(re, to);
  // « Module « x » introuvable » sans parent : pas de « (required by ) » vide
  return out.replace(/ \(required by \)/g, "");
}

/** Corps JSON d'une réponse d'erreur traduit : `error`, `errors` (textes ou { path, message }). */
export function errorBodyIn(lang: Lang, body: unknown): unknown {
  if (lang !== "en" || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = { ...(body as Record<string, unknown>) };
  if (typeof b.error === "string") b.error = messageIn(lang, b.error);
  if (Array.isArray(b.errors))
    b.errors = b.errors.map((e) =>
      typeof e === "string" ? messageIn(lang, e) : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? { ...e, message: messageIn(lang, (e as { message: string }).message) } : e,
    );
  return b;
}
