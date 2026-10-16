import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { isLegacy, moduleLibrary, socleCatalog, SOCLE_CODES, SOCLE_VAR_DOCS, SOCLE_VARS } from "../registry";

/** Prompts et schémas de sortie de l'assistant de modules. */

const ROOT = resolve(import.meta.dirname, "../../..");

export const researchSchema = z.object({
  summary: z.string().describe("Résumé du domaine et des données disponibles, en 3 à 6 phrases"),
  sources: z
    .array(
      z.object({
        key: z.string().describe("clé courte en snake_case, réutilisée dans le YAML"),
        org: z.string(),
        title: z.string(),
        year: z.number().int(),
        url: z.string().describe("URL réellement consultée"),
        verified: z.boolean().describe("true seulement si la page a été ouverte (WebFetch) et contient le chiffre"),
        findings: z.array(z.string()).describe("chiffres trouvés, avec leur champ (pays, population, année)"),
      }),
    )
    .describe("Sources trouvées ; aucune source inventée"),
  attributes: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(["enum", "set", "number", "boolean"]),
      values: z.array(z.string()).optional(),
      conditioned_on: z.array(z.string()).describe("variables du socle ou attributs de modules existants qui conditionnent l'attribut"),
      figures: z.array(z.object({ statement: z.string(), source_key: z.string().nullable() })),
      assumption: z.boolean().describe("true si aucune source ne donne directement la distribution"),
      justification: z.string().optional(),
    }),
  ),
  notes: z.array(z.string()).describe("incertitudes, sources manquantes, choix à valider par l'utilisateur"),
});
export type Research = z.infer<typeof researchSchema>;

export const proposalSchema = z.object({
  yaml: z.string().min(50).describe("module YAML complet, conforme au format"),
  notes: z.array(z.string()).describe("choix faits, incertitudes, sources manquantes, en phrases courtes"),
});

export const revisionSchema = z.object({
  yaml: z.string().min(50).describe("module YAML complet après la modification"),
  summary: z.string().describe("ce qui a changé, en une ou deux phrases"),
  notes: z.array(z.string()),
});

export function socleCatalogue(socle = "fr"): string {
  // France : catalogue historique (texte inchangé) ; autre pays : catalogue de son socle
  const c = socle.replace(/-.*$/, "") === "fr" ? { vars: SOCLE_VARS, docs: SOCLE_VAR_DOCS, codes: SOCLE_CODES } : socleCatalog(socle);
  const lines = c.vars.profile.map((v) => `- socle.${v} : ${c.docs[v] ?? ""}${c.codes[v] ? ` (codes : ${c.codes[v]!.join(", ")})` : ""}`);
  return lines.join("\n");
}

/** Pays et langue des libellés d'un socle, pour les consignes de l'assistant (France : texte historique). */
function socleContext(socle: string): { country: string; languageLine: string } {
  if (socle.replace(/-.*$/, "") !== "sg") return { country: "France", languageLine: "" };
  return {
    country: "Singapour",
    languageLine:
      "Le socle est en anglais : libellés des attributs et des valeurs, lignes de fiche (`card`) et phrases des segments sont en anglais (les personas et les prompts d'étude de ce socle sont en anglais). Sources à privilégier : SingStat, MOM, IMDA, HDB, MAS, MOH, ministères et enquêtes publiées à Singapour.",
  };
}

export function libraryCatalogue(exclude?: string): string {
  const out: string[] = [];
  for (const m of moduleLibrary().values()) {
    if (m.def.id === exclude || isLegacy(m)) continue;
    out.push(`- ${m.def.id} (${m.def.label}) : ${m.def.attributes.map((a) => `${a.key} [${a.type}${a.type === "enum" ? ` : ${a.values.map((v) => v.code).join("/")}` : ""}]`).join(", ")}`);
  }
  return out.join("\n");
}

export const RESEARCH_SYSTEM = [
  "Tu es chargé d'études quantitatives. Tu prépares un module d'attributs pour une population synthétique d'adultes (18-79 ans) d'un pays donné, tirée de statistiques officielles.",
  "Tu disposes des outils WebSearch et WebFetch, et de rien d'autre. Cherche des chiffres publiés et récents : instituts officiels (INSEE, Arcep, CREDOC Baromètre du numérique, DARES, Eurostat), études de référence (Médiamétrie, StatCounter, Kantar, IDC, Ifop, enquêtes d'organismes professionnels), en priorité pour la France.",
  "Règles strictes :",
  "- Ne cite que des URL que tu as réellement vues. `verified: true` seulement si tu as ouvert la page (WebFetch) et qu'elle contient le chiffre ; sinon `verified: false`.",
  "- Pour chaque chiffre, précise son champ (pays, population, année, base : individus ou ménages, appareils en usage ou ventes).",
  "- Si rien n'est trouvé, dis-le : l'attribut sera une hypothèse (`assumption: true`) avec une justification.",
  "- Les attributs doivent se conditionner aux variables du socle fournies (âge, sexe, PCS, activité, niveau de vie, équipement…) quand c'est plausible et documenté.",
  "- Pas plus de 8 attributs ; sois économe en recherches (une dizaine au plus).",
  "Réponds uniquement par le JSON demandé.",
].join("\n");

export function researchPrompt(input: { description: string; moduleId?: string; projectContext?: string; socle: string }): string {
  return [
    `Domaine du module : ${input.description}`,
    input.moduleId ? `Identifiant visé : ${input.moduleId}` : "",
    input.projectContext ? `Projet qui motive le module (contexte, à ne pas recopier) :\n${input.projectContext}` : "",
    `Socle : ${input.socle} (${socleContext(input.socle).country}). Variables du socle disponibles pour conditionner :\n${socleCatalogue(input.socle)}`,
    socleContext(input.socle).languageLine,
    `Modules existants (on peut en dépendre et réutiliser leurs attributs) :\n${libraryCatalogue(input.moduleId)}`,
    "Trouve les sources, propose les attributs (clé, libellé, type, valeurs, conditionnements) avec les chiffres qui permettront de fixer leurs distributions, puis renvoie le JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

let docsCache: { format: string; example: string } | null = null;
function docs() {
  docsCache ??= {
    format: readFileSync(resolve(ROOT, "docs/modules.md"), "utf8"),
    example: readFileSync(resolve(ROOT, "modules/numerique/module.yaml"), "utf8"),
  };
  return docsCache;
}

export function generationSystem(): string {
  const d = docs();
  return [
    "Tu rédiges des modules YAML pour Personas, un simulateur de personas synthétiques. Le YAML doit respecter exactement le format décrit ci-dessous, sans logique cachée : distributions déclaratives, primitives de calcul nommées, sources ou hypothèses justifiées.",
    "Règles de rédaction :",
    "- L'ordre de déclaration des attributs est l'ordre de tirage : un attribut ne cite que des attributs déclarés avant lui.",
    "- Chaque attribut et chaque table cite des sources (`sources: [clé]`, clés déclarées dans `sources:` avec org, title, year, url) ou porte `assumption: true` et une `justification`. Une source non vérifiée peut être citée, mais l'attribut reste alors `assumption: true`.",
    "- Conditionne aux variables du socle (catalogue fourni) quand c'est plausible : âge, sexe, PCS, activité, niveau de vie, équipement. Utilise `when` pour les attributs qui n'existent que pour une partie de la population (ex. `when: {attr: socle.has_computer, eq: true}` pour l'OS de l'ordinateur ; `when: {attr: socle.activity_status, in: [employed]}` pour un attribut professionnel).",
    "- Distributions réalistes et pessimistes : la majorité des gens n'ont pas de pratique avancée.",
    "- Ajoute des lignes de fiche (`card`) courtes, des segments (ids camelCase uniques, préfixés par le domaine), des marges de validation pour les enums et des `validation.shares` pour les chiffres sourcés, et des `eligibility_helpers` utiles (phrases du langage de ciblage, variables `<id-du-module>.<attribut>` et variables du socle sans préfixe : age, pcs, activity_status, has_computer…).",
    "- `applies_to` contient le socle ; `version: \"2026.2\"`. Ne remplace jamais la situation professionnelle ; `socle_overrides.monthly_income` (revenu calculé par le module) et `affects_budget` (abonnements payés par la persona, déduits du reste-à-vivre) seulement si le module détermine vraiment un revenu ou des dépenses de la persona.",
    "Réponds uniquement par le JSON demandé : le YAML complet dans `yaml`, et tes notes pour l'utilisateur (choix faits, incertitudes, sources manquantes) dans `notes`.",
    "",
    "=== Format des modules (docs/modules.md) ===",
    d.format,
    "",
    "=== Module exemple (modules/numerique/module.yaml) ===",
    d.example,
  ].join("\n");
}

export function generationPrompt(input: { description: string; moduleId?: string; socle: string; research: Research | null; projectContext?: string }): string {
  return [
    `Rédige le module pour : ${input.description}`,
    input.moduleId ? `id : ${input.moduleId}` : "",
    `Socle : ${input.socle}. Variables du socle :\n${socleCatalogue(input.socle)}`,
    socleContext(input.socle).languageLine,
    `Modules existants (requires possible) :\n${libraryCatalogue(input.moduleId)}`,
    input.projectContext ? `Contexte du projet :\n${input.projectContext}` : "",
    input.research ? `Recherche de sources (à utiliser ; ne cite que ces URL) :\n${JSON.stringify(input.research, null, 1)}` : "Aucune recherche de sources : tout attribut non sourcé est une hypothèse justifiée.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function repairPrompt(yaml: string, errors: string[]): string {
  return [
    "Le YAML ne passe pas la validation. Corrige toutes les erreurs ci-dessous et renvoie le module complet (même JSON : yaml et notes).",
    ...errors.map((e) => `- ${e}`),
    "",
    "YAML actuel :",
    yaml,
  ].join("\n");
}

export function revisionPrompt(yaml: string, instruction: string, research?: Research | null): string {
  return [
    `Modifie ce module selon l'instruction suivante, et seulement elle : « ${instruction} »`,
    "Garde tout le reste à l'identique (sources, valeurs, ordre). Si l'instruction ajoute un chiffre, cite une source déclarée ou marque l'attribut en hypothèse avec une justification.",
    "Une part sourcée (ex. part de macOS parmi les ordinateurs) se déclare en `validation.shares` avec sa fourchette, et les distributions doivent l'atteindre. Un attribut reste `assumption: true` tant que sa distribution n'est pas directement donnée par une source vérifiée ; les sources non vérifiées sont citées comme telles dans la justification.",
    research
      ? `Recherche ciblée faite pour cette révision (déclare dans \`sources:\` celles que tu utilises, avec leur URL ; ne cite aucune autre URL nouvelle) :\n${JSON.stringify(research, null, 1)}`
      : "",
    "Renvoie le YAML complet dans `yaml`, un résumé du changement dans `summary` et tes remarques dans `notes` (choix de source, incertitudes).",
    "",
    "YAML actuel :",
    yaml,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Recherche ciblée sur une instruction de révision (mode recherche). */
export function targetedResearchPrompt(yaml: string, instruction: string): string {
  return [
    `Recherche ciblée pour réviser un module existant. Instruction de l'utilisateur : « ${instruction} »`,
    "Fais réellement les recherches : au moins 3 requêtes WebSearch (en français et en anglais) sur les sources citées par l'instruction, puis ouvre (WebFetch) les pages prometteuses. Une recherche antérieure ne compte pas : repars de zéro sur ce que demande l'instruction.",
    "Cherche seulement ce que l'instruction demande. Mêmes règles : URL réellement vues, `verified: true` seulement si la page a été ouverte et contient le chiffre, champ de chaque chiffre (pays, population, année, parc ou ventes ou trafic). Liste aussi les sources consultées qui ne donnent pas le chiffre voulu (avec `findings` vide ou ce qu'elles donnent). Si rien n'est trouvé, dis-le dans les notes, avec les requêtes essayées.",
    "Dans `attributes`, ne liste que les attributs concernés par l'instruction, avec les chiffres utiles.",
    "",
    "Module actuel (pour savoir ce qui est déjà sourcé) :",
    yaml,
  ].join("\n");
}

/** Recalage des distributions sur les parts sourcées déclarées en validation.shares. */
export function recalibrationPrompt(yaml: string, unmet: string[]): string {
  return [
    "L'aperçu (tirage de 10 000 personas virtuelles) montre que ces parts sourcées, déclarées en `validation.shares`, ne sont pas atteintes :",
    ...unmet.map((u) => `- ${u}`),
    "Ajuste les poids, taux ou coefficients concernés (pas les fourchettes, ni les sources) pour que les parts simulées tombent dans leur fourchette, en gardant les gradients (âge, PCS, niveau de vie) et le reste du module à l'identique.",
    "Renvoie le YAML complet dans `yaml`, ce que tu as ajusté dans `summary`, et tes remarques dans `notes`.",
    "",
    "YAML actuel :",
    yaml,
  ].join("\n");
}
