import { parse as parseYaml } from "yaml";
import { moduleSchema, type ModuleDef } from "../../src/modules/schema";
import type { UiLang } from "./i18n";

/**
 * Lecture de la fiche d'un module du Hub à partir du YAML exact publié : résumé, chiffres clés, filtres
 * prêts à l'emploi en clair, attributs, sources, hypothèses, notes d'en-tête. Aucun chiffre n'est calculé
 * ici au-delà de comptes et de fourchettes déclarées : les parts mesurées viennent de l'aperçu stocké.
 */

/** Module validé depuis le YAML publié ; null si le texte ne passe plus le schéma (module archivé, ancien format). */
export function parseModuleYaml(yaml: string): ModuleDef | null {
  try {
    const r = moduleSchema.safeParse(parseYaml(yaml));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Première phrase d'une description (fin de phrase suivie d'une majuscule) ; le texte entier s'il n'y en a qu'une. */
export function firstSentence(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])\s+(?=[A-ZÀ-ÖØ-Þ«“"(])/u.exec(s);
  return m ? m[1]! : s;
}

/** Commentaires d'en-tête du YAML (lignes `#` avant la première clé) : notes techniques de l'auteur. */
export function headerNotes(yaml: string): string[] {
  const out: string[] = [];
  for (const line of yaml.split("\n")) {
    if (/^\s*#/.test(line)) out.push(line.replace(/^\s*#\s?/, "").trim());
    else if (line.trim()) break;
  }
  return out.filter(Boolean);
}

/** Libellé d'une part sourcée : titre, et note de source finale entre parenthèses (« SELL : 76 % »). */
export function splitShareLabel(l: string): { title: string; note: string | null } {
  const m = /^(.*\S)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/s.exec(l);
  return m ? { title: m[1]!, note: m[2]! } : { title: l, note: null };
}

const labelOf = (l: string | { M: string; F: string }) => (typeof l === "string" ? l : l.M === l.F ? l.M : `${l.M} / ${l.F}`);

/** Valeurs lisibles d'un attribut (pastilles) : modalités, options, oui/non ; vide pour un nombre. */
export function attributeValues(a: ModuleDef["attributes"][number], ui: UiLang): string[] {
  if (a.type === "enum") return a.values.map((v) => labelOf(v.label));
  if (a.type === "set") return a.items.map((i) => i.label);
  if (a.type === "boolean") return [a.labels?.yes ?? (ui === "fr" ? "oui" : "yes"), a.labels?.no ?? (ui === "fr" ? "non" : "no")];
  return [];
}

/**
 * Provenance d'un attribut ou d'une table, comme le sourçage S du score Q : sourcé (sources, pas d'hypothèse),
 * modélisé (hypothèse appuyée sur des sources), hypothèse sans source, ou rien.
 */
export type Provenance = "sourced" | "modeled" | "assumption" | "none";
export const PROVENANCES: readonly Provenance[] = ["sourced", "modeled", "assumption", "none"];
export const provenanceOf = (p: { sources: string[]; assumption: boolean }): Provenance => (p.sources.length ? (p.assumption ? "modeled" : "sourced") : p.assumption ? "assumption" : "none");

const SOCLE_VARS: Record<UiLang, Record<string, string>> = {
  fr: { age: "âge", sex: "sexe", children: "enfants", children_under_12: "enfants de moins de 12 ans", monthly_income: "revenu mensuel", pcs: "PCS", activity_status: "situation d'activité" },
  en: { age: "age", sex: "sex", children: "children", children_under_12: "children under 12", monthly_income: "monthly income", pcs: "occupation group", activity_status: "activity status" },
};

/**
 * Filtre d'éligibilité en clair, lu jeton par jeton : variables du module → libellés d'attributs, codes →
 * libellés de valeurs, opérateurs en mots. Ce n'est qu'un affichage : la phrase exacte reste montrée à côté.
 */
export function eligibilityText(expression: string, def: ModuleDef, ui: UiLang): string {
  const fr = ui === "fr";
  const re = /\s*(not\s+in\b|==|!=|>=|<=|>|<|\[|\]|\(|\)|,|"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|[A-Za-z_][\w.-]*)/gy;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression))) tokens.push(m[1]!);
  if (tokens.join("").replace(/\s+/g, "") !== expression.replace(/\s+/g, "")) return expression;
  const prefix = `${def.id}.`;
  let attr: ModuleDef["attributes"][number] | undefined;
  let inList = false;
  let listSep = "";
  const valueLabel = (code: string) => {
    const c = code.replace(/^["']|["']$/g, "");
    if (attr?.type === "enum") return labelOf(attr.values.find((v) => v.code === c)?.label ?? c);
    if (attr?.type === "set") return attr.items.find((i) => i.code === c)?.label ?? c;
    return c;
  };
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const low = tok.toLowerCase();
    if (low === "and") out.push(fr ? " et " : " and ");
    else if (low === "or") out.push(fr ? " ou " : " or ");
    else if (low === "not") out.push(fr ? "non " : "not ");
    else if (/^not\s+in$/i.test(tok)) {
      out.push(fr ? " hors " : " not ");
      listSep = fr ? ", " : ", ";
    } else if (low === "in") {
      out.push(fr ? " : " : ": ");
      listSep = fr ? " ou " : " or ";
    } else if (tok === "[") inList = true;
    else if (tok === "]") inList = false;
    else if (tok === ",") out.push(inList ? listSep : ", ");
    else if (tok === "==") out.push(" = ");
    else if (tok === "!=") out.push(" ≠ ");
    else if ([">=", "<=", ">", "<"].includes(tok)) out.push(` ${tok === ">=" ? "≥" : tok === "<=" ? "≤" : tok} `);
    else if (tok === "(" || tok === ")") out.push(tok);
    else if (/^[A-Za-z_]/.test(tok) && !(attr && /^(==|!=|in|not\s+in|,|\[)$/i.test(tokens[i - 1] ?? ""))) {
      // Variable : attribut du module, du socle, ou d'un autre module (gardée telle quelle)
      if (low === "true" || low === "false") out.push(low === "true" ? (fr ? "oui" : "yes") : fr ? "non" : "no");
      else if (tok.startsWith(prefix)) {
        attr = def.attributes.find((a) => a.key === tok.slice(prefix.length));
        out.push(attr?.label ?? tok);
      } else {
        attr = undefined;
        out.push(tok.includes(".") ? tok : (SOCLE_VARS[ui][tok] ?? tok));
      }
    } else out.push(valueLabel(tok));
  }
  const s = out.join("").replace(/[ \t\n]+/g, " ").trim();
  return s.charAt(0).toLocaleUpperCase(fr ? "fr-FR" : "en-GB") + s.slice(1);
}

/** Textes de la fiche module (FR/EN), propres à cette page. */
export const MODULE_PAGE = {
  fr: {
    keyFigures: "Chiffres clés",
    prov: { sourced: (n: number) => `${n} sourcé${n > 1 ? "s" : ""}`, modeled: (n: number) => `${n} modélisé${n > 1 ? "s" : ""} d'après des sources`, assumption: (n: number) => `${n} hypothèse${n > 1 ? "s" : ""} sans source`, none: (n: number) => `${n} sans source` } as Record<string, (n: number) => string>,
    provenanceSplit: "Provenance des attributs",
    modeled: "modélisé",
    shares: "Parts validées",
    sharesHint: "Fourchettes sourcées que le tirage doit respecter",
    noShares: "Aucune part sourcée déclarée.",
    filters: (n: number) => (n === 1 ? "filtre prêt à l'emploi" : "filtres prêts à l'emploi"),
    segmentsCount: (n: number) => (n === 1 ? "1 segment d'analyse" : `${n} segments d'analyse`),
    version: "Version",
    fullDescription: "Description complète",
    purpose: "À quoi sert ce module",
    helpers: "Filtres prêts à l'emploi",
    helpersHint: "À reprendre tels quels dans target.eligibility d'une étude.",
    helperShare: (p: string) => `${p} des personas`,
    noHelpers: "Aucun filtre déclaré.",
    segments: "Segments d'analyse",
    segmentsHint: "Dimensions de comparaison des résultats d'une étude.",
    noSegments: "Aucun segment déclaré.",
    type: { enum: "choix unique", set: "choix multiples", number: "nombre", boolean: "oui / non" } as Record<string, string>,
    more: (n: number) => `+${n}`,
    concerns: (p: string) => `concerne ${p} des personas`,
    sourcesOf: "Sources",
    assumption: "hypothèse",
    noSource: "sans source",
    sources: "Sources",
    sourcesCount: (n: number) => (n === 1 ? "1 source" : `${n} sources`),
    assumptions: "Hypothèses",
    assumptionsHint: "Distributions sans chiffre publié direct : à lire comme des choix de calibration.",
    noAssumption: "Aucune hypothèse déclarée.",
    tables: (n: number) => (n === 1 ? "1 table de calibration" : `${n} tables de calibration`),
    install: "Installer ce module",
    installCopy: "Sélectionnez la commande pour la copier.",
    apiDoc: "Documentation de l'API",
    more_: "Pour aller plus loin",
    history: "Historique des changements",
    notes: "Notes techniques de l'auteur",
    notesHint: "Commentaires en tête du fichier YAML.",
    quality: "Détail du score et alertes",
    noParse: "Le détail de ce module n'est pas lisible par cette version du Hub : seul le YAML exact fait foi.",
  },
  en: {
    keyFigures: "Key figures",
    prov: { sourced: (n: number) => `${n} sourced`, modeled: (n: number) => `${n} modelled from sources`, assumption: (n: number) => `${n} unsourced assumption${n > 1 ? "s" : ""}`, none: (n: number) => `${n} unsourced` } as Record<string, (n: number) => string>,
    provenanceSplit: "Attribute provenance",
    modeled: "modelled",
    shares: "Validated shares",
    sharesHint: "Sourced ranges the draw must hit",
    noShares: "No sourced share declared.",
    filters: (n: number) => (n === 1 ? "ready-made filter" : "ready-made filters"),
    segmentsCount: (n: number) => (n === 1 ? "1 analysis segment" : `${n} analysis segments`),
    version: "Version",
    fullDescription: "Full description",
    purpose: "What this module is for",
    helpers: "Ready-made filters",
    helpersHint: "Use them as is in a study's target.eligibility.",
    helperShare: (p: string) => `${p} of personas`,
    noHelpers: "No filter declared.",
    segments: "Analysis segments",
    segmentsHint: "Dimensions for comparing a study's results.",
    noSegments: "No segment declared.",
    type: { enum: "single choice", set: "multiple choice", number: "number", boolean: "yes / no" } as Record<string, string>,
    more: (n: number) => `+${n}`,
    concerns: (p: string) => `applies to ${p} of personas`,
    sourcesOf: "Sources",
    assumption: "assumption",
    noSource: "unsourced",
    sources: "Sources",
    sourcesCount: (n: number) => (n === 1 ? "1 source" : `${n} sources`),
    assumptions: "Assumptions",
    assumptionsHint: "Distributions without a directly published figure: read them as calibration choices.",
    noAssumption: "No assumption declared.",
    tables: (n: number) => (n === 1 ? "1 calibration table" : `${n} calibration tables`),
    install: "Install this module",
    installCopy: "Select the command to copy it.",
    apiDoc: "API documentation",
    more_: "More details",
    history: "Change history",
    notes: "Author's technical notes",
    notesHint: "Comments at the top of the YAML file.",
    quality: "Score breakdown and alerts",
    noParse: "This Hub version cannot read this module's details: the exact YAML is authoritative.",
  },
} satisfies Record<UiLang, unknown>;
