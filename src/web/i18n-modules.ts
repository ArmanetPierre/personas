import type { Lang } from "./i18n";
import type { DraftMeta, PreviewResult } from "./modules";

/**
 * Textes de l'assistant de modules dans la langue de l'interface (`?lang=en`) : alertes de l'aperçu
 * (src/modules/assistant/preview.ts), libellés de l'historique et de l'avancement des brouillons, préfixes
 * des notes (src/modules/assistant/propose.ts et drafts.ts). Le français est produit tel quel et n'est
 * jamais réécrit : la traduction se fait à la sortie de l'API, par motifs, comme les messages d'erreur
 * (src/web/i18n.ts). Un texte sans motif (contenu rédigé par l'assistant) reste tel quel.
 */

type Rule = [RegExp, string];

const ALERT_RULES: Rule[] = [
  [/^« (.+) » n'a aucune source \(hypothèse seule\)\.$/, "“$1” has no source (assumption only)."],
  [/^Table « (.+) » sans source \(hypothèse\)\.$/, "Table “$1” has no source (assumption)."],
  [/^(\d+) attributs sur (\d+) reposent sur des hypothèses \(plus de la moitié\)\.$/, "$1 of $2 attributes rest on assumptions (more than half)."],
  [/^« (.+) » n'est jamais présent \(condition « when » jamais vraie sur (\d+) personas\)\.$/, "“$1” is never present (“when” condition never true on $2 personas)."],
  [/^« (.+) » : la valeur « (.+) » n'est jamais tirée \((\d+) personas concernées\)\.$/, "“$1”: the value “$2” is never drawn ($3 personas concerned)."],
  [/^« (.+) » : « (.+) » est très rare \(([\d.]+) % des personas concernées\)\.$/, "“$1”: “$2” is very rare ($3 % of the personas concerned)."],
  [/^« (.+) » : le conditionnement n'a pas d'effet \(même distribution pour toutes les personas\)\.$/, "“$1”: the conditioning has no effect (same distribution for all personas)."],
  [/^Marge « (.+) » : écart max ([\d.]+) pt avec la distribution attendue\.$/, "Margin “$1”: max deviation $2 pt from the expected distribution."],
  [/^Cible déclarée non atteinte : (.+) = (.+) \(attendu (.+) à (.+)\)\.$/, "Declared target not met: $1 = $2 (expected $3 to $4)."],
  [
    /^« (.+) » semble professionnel mais concerne aussi (\d+) personas sans emploi \(retraités, étudiants…\) : conditionner à socle\.activity_status \?$/,
    "“$1” looks work-related but also concerns $2 personas without a job (retired, students…): condition on socle.activity_status?",
  ],
];

const DEVICES: Record<string, string> = { "un ordinateur": "a computer", "un smartphone": "a smartphone", "une tablette": "a tablet" };
const DEVICE_ALERT = /^« (.+) » concerne (un ordinateur|un smartphone|une tablette), mais (\d+) personas sans \2 dans le socle en ont une valeur : ajouter « when: (\{.+\}) »\.$/;

/** Libellés de l'historique (`history[].summary`) et de l'avancement (`progress`). */
const DRAFT_RULES: Rule[] = [
  [/^Proposition initiale$/, "Initial proposal"],
  [/^Réparation (\d+) \((\d+) erreur\(s\)\)$/, "Repair $1 ($2 error(s))"],
  [/^Réparation (\d+)\/(\d+) : (\d+) erreur\(s\)$/, "Repair $1/$2: $3 error(s)"],
  [/^Recalage (\d+)\/(\d+) sur les parts sourcées : (\d+) écart\(s\)$/, "Recalibration $1/$2 on sourced shares: $3 gap(s)"],
  [/^Recalage (\d+) : /, "Recalibration $1: "],
  [/^Édition manuelle$/, "Manual edit"],
  [/^Validé vers (.+)$/, "Validated to $1"],
  [/^Brouillon créé$/, "Draft created"],
  [/^Module validé$/, "Module validated"],
  [/^Prêt à relire$/, "Ready for review"],
  [/^Révision prête à relire$/, "Revision ready for review"],
  [/^Validation en échec après réparations$/, "Validation failed after repairs"],
  [/^Révision invalide après réparations$/, "Revision invalid after repairs"],
  [/^Recherche de sources \(WebSearch, WebFetch\)…$/, "Searching for sources (WebSearch, WebFetch)…"],
  [/^Rédaction du YAML…$/, "Writing the YAML…"],
  [/^Recherche ciblée \(WebSearch, WebFetch\) : /, "Targeted search (WebSearch, WebFetch): "],
  [/^Révision : /, "Revision: "],
];

/** Préfixes ajoutés aux notes par l'assistant (le reste de la note est son texte, laissé tel quel). */
const NOTE_RULES: Rule[] = [
  [/^Recherche : /, "Research: "],
  [/^Recalage : part sourcée encore hors fourchette : /, "Recalibration: sourced share still out of range: "],
];

function apply(rules: Rule[], text: string): string {
  for (const [re, to] of rules) if (re.test(text)) return text.replace(re, to);
  return text;
}

/** Alerte d'aperçu en anglais (inchangée en français, et sans motif connu). */
export function previewAlertIn(lang: Lang, message: string): string {
  if (lang !== "en") return message;
  const d = DEVICE_ALERT.exec(message);
  if (d) {
    const what = DEVICES[d[2]!] ?? d[2]!;
    return `“${d[1]}” concerns ${what}, but ${d[3]} personas without ${what} in the base population have a value: add “when: ${d[4]}”.`;
  }
  return apply(ALERT_RULES, message);
}

/** Note d'un brouillon : alerte d'aperçu recopiée (« Aperçu : … ») ou préfixe de l'assistant. */
export function draftNoteIn(lang: Lang, note: string): string {
  if (lang !== "en") return note;
  const m = /^Aperçu : (.*)$/s.exec(note);
  if (m) return `Preview: ${previewAlertIn(lang, m[1]!)}`;
  return apply(NOTE_RULES, note);
}

/** Libellé d'historique ou d'avancement. */
export function draftLabelIn(lang: Lang, text: string): string {
  return lang === "en" ? apply(DRAFT_RULES, text) : text;
}

/** Aperçu d'un module : alertes et tranches numériques (« 10 à 20 » → « 10 to 20 »). */
export function previewIn<T extends PreviewResult>(lang: Lang, p: T): T {
  if (lang !== "en") return p;
  return {
    ...p,
    alerts: p.alerts.map((a) => ({ ...a, message: previewAlertIn(lang, a.message) })),
    margins: p.margins.map((mg) => ({ ...mg, values: mg.values.map((v) => ({ ...v, label: v.label.replace(/^(-?[\d.]+) à (-?[\d.]+)/, "$1 to $2") })) })),
  };
}

/** Méta d'un brouillon : avancement, historique et préfixes des notes. */
export function draftMetaIn<T extends DraftMeta | null | undefined>(lang: Lang, meta: T): T {
  if (lang !== "en" || !meta) return meta;
  const tr = (x: unknown, f: (s: string) => string) => (typeof x === "string" ? f(x) : x);
  return {
    ...meta,
    ...(typeof meta.progress === "string" && { progress: draftLabelIn(lang, meta.progress) }),
    ...(Array.isArray(meta.notes) && { notes: meta.notes.map((n) => tr(n, (s) => draftNoteIn(lang, s))) }),
    ...(Array.isArray(meta.history) && {
      history: meta.history.map((h) =>
        h && typeof h === "object" && typeof (h as { summary?: unknown }).summary === "string"
          ? { ...(h as object), summary: draftLabelIn(lang, (h as { summary: string }).summary) }
          : h,
      ),
    }),
  };
}
