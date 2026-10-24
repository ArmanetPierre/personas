import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { stringify as toYaml } from "yaml";
import { z } from "zod";
import { defaultDataDir, loadConfig } from "../config";
import type { Engine } from "../engine";
import { assistantEngine } from "../engine/select";
import type { CompleteResult } from "../engine/types";
import type { Project } from "../db/schema";
import { isLegacy, moduleAt, moduleLibrary, resolveModules, socleCatalog, SOCLE_CODES, SOCLE_VAR_DOCS, type LoadedModule } from "../modules/registry";
import { canonicalRef, qualifiedRef } from "../modules/refs";
import { readCachedCatalog } from "../hub/cache";
import { HubClient } from "../hub/client";
import type { CatalogResponse, QualityScore } from "../hub/contract";
import { pullModule } from "../hub/pull";
import { autoEligible, bm25, searchDocs, type SearchDoc } from "../hub/search";
import { SG_ELIGIBILITY_VARS } from "../personas/countries/sg/vars";
import { formatPricing, hasGenericPricing, pricingOf } from "../studies/price-model";
import { formatPrice, type ProjectExtra } from "../studies/project";
import { AGE_BANDS, SEGMENT_DIMENSIONS, MODULE_SEGMENTS } from "../studies/segments";
import { drawPersona } from "../personas/sampler";
import { previewTarget, projectRow, type ProjectInput, type TargetPreview } from "./preview";
import { eligibilityVars, prepareTarget, targetSpecSchema, type TargetSpec } from "./target";

/**
 * Assistant de cible (lot P1, point 4) : à partir du pitch, Claude (claude-cli, sans outil) propose
 * les attributs qui conditionnent l'usage, un filtre d'éligibilité et des variantes de cible, des
 * quotas éventuels et les modules manquants. Les filtres sont validés (syntaxe, variables, codes,
 * au moins une persona éligible) avec une boucle de réparation, puis chaque variante est
 * prévisualisée (`previewTarget`). Rien n'est appliqué : la proposition est écrite dans un fichier.
 */

export const MAX_TARGET_REPAIRS = 3;
/** Tirages de contrôle : une variante sans aucune persona éligible sur ce nombre est refusée. */
export const CHECK_DRAWS = 30_000;

// ─── Schéma de la réponse ─────────────────────────────────────────────────────

const criterionSchema = z.object({
  criterion: z.string().describe("Morceau du filtre, ex. « equipement-ecosysteme.employer_provided_computer == false »"),
  why: z.string().describe("Pourquoi ce critère conditionne l'usage, en une ou deux phrases"),
});

const variantSchema = z.object({
  id: z.string().describe("Identifiant court en minuscules et tirets, ex. coeur-de-cible"),
  label: z.string(),
  description: z.string().describe("Qui est dans cette variante, en une phrase"),
  modules: z.array(z.string()).describe("Modules validés utilisés (ids du catalogue)"),
  eligibility: z.string().describe("Filtre d'éligibilité dans la syntaxe décrite"),
  quotas: z
    .array(
      z.object({
        dimension: z.string().describe("Dimension de segment (liste fournie)"),
        shares: z.array(z.object({ value: z.string(), share: z.number().min(0).max(1) })),
        why: z.string(),
      }),
    )
    .default([])
    .describe("Quotas facultatifs ; vide le plus souvent"),
  justification: z.array(criterionSchema).min(1),
});

export const targetSuggestionSchema = z.object({
  analysis: z.string().describe("Ce que suppose l'usage du produit (matériel, système, situation, contraintes), en 3 à 6 phrases"),
  usageConditions: z
    .array(
      z.object({
        condition: z.string().describe("Condition d'usage, ex. « installer une application sur son Mac »"),
        attribute: z.string().describe("Attribut qui la représente (module.attr ou variable du socle), ou chaîne vide si aucun"),
        why: z.string(),
      }),
    )
    .min(1),
  variants: z.array(variantSchema).min(1).max(4),
  missingModules: z
    .array(
      z.object({
        id: z.string().describe("Identifiant proposé, minuscules et tirets"),
        description: z.string().describe("Description du domaine prête pour `npm run module:propose -- --description`"),
        attributes: z.array(z.string()).describe("Attributs à créer, avec leurs valeurs"),
        why: z.string(),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
});
export type TargetSuggestionData = z.infer<typeof targetSuggestionSchema>;
export type TargetVariant = z.infer<typeof variantSchema>;

// ─── Catalogues ───────────────────────────────────────────────────────────────

const EXTRA_DOCS: Record<string, string> = {
  household_size: "nombre de personnes du foyer",
  household_income: "revenu du foyer après impôts et aides (€/mois)",
  budget: "reste-à-vivre personnel mensuel (€) après dépenses contraintes et abonnements",
  children: "nombre d'enfants au foyer",
  living_standard: "niveau de vie mensuel en € par unité de consommation",
};
const SOCLE_FILTER_VARS = [
  "age", "sex", "region", "town_size", "pcs", "activity_status", "household_type", "household_size", "monthly_income",
  "household_income", "budget", "living_standard", "tech_adoption", "social_media", "tenure", "children",
  "has_computer", "has_smartphone", "has_tablet",
];
const REGIONS = ["IDF", "ARA", "OCC", "PAC", "NAQ", "HDF", "GES", "BRE", "PDL", "NOR", "BFC", "CVL", "COR"];

/** Pays d'un nom de socle (« fr », « fr-2026.2 », « sg-2026.1 » → fr, fr, sg). */
const socleCountry = (socle: string) => socle.toLowerCase().replace(/-.*$/, "");

/** Codes admis pour une variable du socle du filtre (null : numérique ou libre). */
function socleCodes(v: string, socle = "fr"): string[] | null {
  if (v.startsWith("has_")) return ["true", "false"];
  if (socleCountry(socle) !== "fr") return socleCatalog(socle).codes[v] ?? null;
  if (v === "region") return REGIONS;
  return SOCLE_CODES[v] ?? null;
}

/** Variables du socle utilisables dans un filtre de cible, avec leur définition (socle France par défaut). */
export function filterCatalogue(socle = "fr"): string {
  if (socleCountry(socle) !== "fr") {
    const docs = socleCatalog(socle).docs;
    return SG_ELIGIBILITY_VARS.map((v) => `- ${v} : ${docs[v] ?? ""}`).join("\n");
  }
  return SOCLE_FILTER_VARS.map((v) => `- ${v} : ${SOCLE_VAR_DOCS[v] ?? EXTRA_DOCS[v] ?? ""}`).join("\n");
}

const compact = (x: unknown) => JSON.stringify(x).replace(/"([a-z_][a-z0-9_.-]*)":/gi, "$1:");

export function moduleCatalogue(lib: Map<string, LoadedModule> = moduleLibrary()): string {
  const out: string[] = [];
  for (const m of lib.values()) {
    if (isLegacy(m)) continue; // modules archivés, hors de la bibliothèque proposée
    out.push(`### ${m.def.id} : ${m.def.label}${m.def.requires.length ? ` (dépend de ${m.def.requires.join(", ")})` : ""}`);
    if (m.def.description) out.push(m.def.description.trim());
    for (const a of m.def.attributes) {
      const when = a.when ? ` ; renseigné seulement si ${typeof a.when === "string" ? a.when : compact(a.when)} (sinon null)` : "";
      let values = "";
      if (a.type === "enum") values = ` ; valeurs : ${a.values.map((v) => `${v.code} = ${typeof v.label === "string" ? v.label : v.label.F}`).join(" | ")}`;
      else if (a.type === "set") values = ` ; liste de codes parmi : ${a.items.map((i) => `${i.code} = ${i.label}`).join(" | ")} (tester avec « in [..] »)`;
      else if (a.type === "boolean") values = " ; true / false";
      else values = ` ; nombre${a.unit ? ` (${a.unit})` : ""}`;
      out.push(`- ${m.def.id}.${a.key} [${a.type}] ${a.label}${a.description ? ` : ${a.description.trim()}` : ""}${values}${when}`);
    }
    const conds = Object.entries(m.def.conditions);
    if (conds.length) out.push(`  Conditions nommées du module (non utilisables dans le filtre) : ${conds.map(([k, c]) => `${k} = ${compact(c)}`).join(" ; ")}`);
  }
  return out.join("\n");
}

function segmentCatalogue(): string {
  const socle = [
    `ageBand (${AGE_BANDS.map((b) => b.code).join(", ")})`,
    "sex (F, M)",
    "pcs (1 à 6, none)",
    "activityStatus (employed, unemployed, student, retired, inactive)",
    "livingStandard (Q1 à Q5)",
    "techAdoption, townSize, region",
  ];
  return [...socle, ...MODULE_SEGMENTS.map((s) => `${s.id} (attribut ${s.module}.${s.attribute})`)].join(" ; ");
}

const FILTER_SYNTAX = `Syntaxe du filtre : and, or, not, parenthèses ; comparaisons ==, !=, <, <=, >, >= ; « x in [a, b] » et « x not in [a, b] » ; une variable seule est vraie si elle est renseignée et non nulle (false, 0, "", "none" et liste vide sont faux). Les codes s'écrivent sans guillemets (pcs in [3, 4], activity_status == employed, equipement-ecosysteme.computer_os == macos). Une variable de module s'écrit « module.attribut » ; un attribut non renseigné (null) fait échouer les comparaisons ==, <, >, in. Les modules utilisés doivent figurer dans « modules » de la variante.`;

export const TARGET_SYSTEM = [
  "Tu es chargé d'études. Tu aides un porteur de projet à définir la population cible d'une étude de marché simulée sur une population synthétique d'adultes vivant en France (18-79 ans), tirée de statistiques.",
  "Une persona est décrite par des variables du socle (âge, PCS, activité, revenus, équipement…) et par des attributs de modules validés. La cible est un filtre d'éligibilité sur ces variables.",
  "Ta tâche :",
  "1. Lire le pitch, l'offre, les concurrents et les alternatives, et dire ce que suppose l'usage réel du produit : matériel, système, situation professionnelle, fréquence du besoin, droit d'installer ou de choisir l'outil, contraintes de l'employeur, budget.",
  "2. Relier chaque condition d'usage à un attribut existant (socle ou module), ou dire qu'aucun ne la représente.",
  "3. Proposer de 2 à 4 variantes de cible, de la plus resserrée (cœur de cible : ceux qui peuvent et veulent l'utiliser tout de suite) à la plus large (cible large : ceux qui ont le besoin, même avec un frein). Chaque critère du filtre est justifié. Si une distinction change fortement l'usage (par exemple qui contrôle l'ordinateur, ou la part de l'activité concernée), fais-en deux variantes plutôt que de trancher.",
  "4. Quotas : seulement s'ils servent la lecture (par exemple équilibrer deux sous-populations qu'on veut comparer). Sinon, liste vide.",
  "5. Modules manquants : pour une condition d'usage décisive qu'aucun attribut ne représente, propose un module (identifiant, description du domaine prête pour l'assistant de modules, attributs à créer avec leurs valeurs). N'en propose pas si les attributs existants suffisent.",
  "Règles strictes :",
  "- N'utilise que les variables et les codes du catalogue fourni, avec la syntaxe indiquée. N'invente ni variable, ni code, ni module.",
  "- Évite les filtres trop étroits : chaque variante doit garder une population plausible (au moins quelques dixièmes de pour cent des adultes).",
  "- N'avance aucun chiffre de marché : la taille de chaque variante sera mesurée ensuite sur la population.",
  "- Textes en français, courts et concrets.",
  "Réponds uniquement par l'objet JSON demandé.",
].join("\n");

function projectBlock(p: Project): string {
  const extra = p.extra as ProjectExtra;
  const pricing = hasGenericPricing(p) ? pricingOf(p) : null;
  const price = pricing ? formatPricing(pricing) : p.priceEur ? formatPrice(p.priceEur, p.pricePeriod) : "non affiché";
  return [
    `Nom : ${p.name}`,
    `Pitch (ce que voit la persona) : « ${p.pitch} »`,
    `Prix : ${price}`,
    p.freeOffer ? `Offre gratuite : ${p.freeOffer}` : "",
    p.targetAudience ? `Cible visée par le porteur (non montrée aux personas) : ${p.targetAudience}` : "",
    p.businessModel ? `Modèle économique : ${p.businessModel}` : "",
    p.competitors.length ? `Concurrents : ${p.competitors.join(" ; ")}` : "",
    p.alternatives.length ? `Alternatives : ${p.alternatives.join(" ; ")}` : "",
    extra.target ? `Cible actuelle du projet (à critiquer, pas à recopier) : modules ${extra.target.modules.join(", ") || "aucun"} ; filtre « ${extra.target.eligibility ?? "aucun"} »` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function suggestPrompt(p: Project, lib?: Map<string, LoadedModule>): string {
  return [
    `## Projet\n${projectBlock(p)}`,
    `## Variables du socle utilisables dans le filtre\n${filterCatalogue()}`,
    `## Modules validés (attributs utilisables dans le filtre sous la forme module.attribut)\n${moduleCatalogue(lib)}`,
    `## Dimensions de quotas\n${segmentCatalogue()}`,
    `## ${FILTER_SYNTAX}`,
    "Propose maintenant l'analyse, les conditions d'usage, les variantes de cible, les quotas éventuels et les modules manquants, puis renvoie le JSON.",
  ].join("\n\n");
}

export function targetRepairPrompt(previous: TargetSuggestionData, errors: Array<{ variant: string; errors: string[] }>): string {
  return [
    "Ta proposition contient des variantes invalides. Corrige-les (filtre, modules, codes, quotas) sans changer leur intention, garde les variantes valides telles quelles, et renvoie l'objet JSON complet.",
    "Erreurs :",
    ...errors.map((e) => `- ${e.variant} :\n${e.errors.map((x) => `  - ${x}`).join("\n")}`),
    "Proposition précédente :",
    JSON.stringify(previous, null, 1),
  ].join("\n");
}

// ─── Validation d'une variante ────────────────────────────────────────────────

export function variantSpec(v: TargetVariant, n = 200, socle = "fr"): TargetSpec {
  const quotas = v.quotas.length ? Object.fromEntries(v.quotas.map((q) => [q.dimension, Object.fromEntries(q.shares.map((s) => [s.value, s.share]))])) : undefined;
  return { socle, modules: v.modules, eligibility: v.eligibility, ...(quotas && { quotas }), n };
}

/**
 * Erreurs d'une variante : schéma, modules, syntaxe et variables du filtre, codes comparés,
 * dimensions de quotas, et au moins une persona éligible sur CHECK_DRAWS tirages.
 * Renvoie aussi le taux mesuré sur ces tirages. `socle` : socle de la cible (France par défaut).
 */
export function checkVariant(v: TargetVariant, lib?: Map<string, LoadedModule>, socle = "fr"): { errors: string[]; checkRate?: number } {
  const errors: string[] = [];
  let prepared;
  try {
    prepared = prepareTarget(variantSpec(v, 200, socle), lib ? { library: lib } : {});
  } catch (err) {
    return { errors: [(err as Error).message] };
  }
  const library = lib ?? moduleLibrary();
  for (const [name, lits] of Object.entries(prepared.filter?.literals ?? {})) {
    let allowed: string[] | null = null;
    if (name.includes(".")) {
      const [mid, key] = name.split(".") as [string, string];
      const a = library.get(mid)?.attrs.get(key);
      if (a?.type === "enum") allowed = a.values.map((x) => x.code);
      else if (a?.type === "set") allowed = a.items.map((x) => x.code);
      else if (a?.type === "boolean") allowed = ["true", "false"];
    } else allowed = socleCodes(name, socle);
    if (!allowed) continue;
    const bad = lits.map(String).filter((x) => !allowed!.includes(x));
    if (bad.length) errors.push(`${name} : code(s) inconnu(s) ${bad.join(", ")} (codes admis : ${allowed.join(", ")})`);
  }
  for (const q of v.quotas) {
    if (!SEGMENT_DIMENSIONS.includes(q.dimension)) errors.push(`quota : dimension « ${q.dimension} » inconnue (admises : ${SEGMENT_DIMENSIONS.join(", ")})`);
    const total = q.shares.reduce((a, s) => a + s.share, 0);
    if (Math.abs(total - 1) > 0.02) errors.push(`quota ${q.dimension} : les parts somment à ${total.toFixed(2)} au lieu de 1`);
  }
  if (errors.length) return { errors };
  if (prepared.filter) {
    let eligible = 0;
    for (let i = 0; i < CHECK_DRAWS; i++) {
      const p = drawPersona(prepared.pack, 7_777, i, { modules: prepared.modules });
      if (prepared.filter.test(eligibilityVars(p))) eligible++;
    }
    if (!eligible) errors.push(`aucune persona éligible sur ${CHECK_DRAWS.toLocaleString("fr-FR")} tirages : filtre contradictoire ou trop étroit`);
    return { errors, checkRate: eligible / CHECK_DRAWS };
  }
  return { errors, checkRate: 1 };
}

// ─── Assistant ────────────────────────────────────────────────────────────────

/** Catalogue du Hub dans l'assistant de cible (docs/plateforme.md § 6.2). */
export interface HubSuggestOptions {
  /** Catalogue (défaut : celui du cache local, téléchargé par `personas hub sync` ; null : aucun). */
  catalog?: CatalogResponse | null;
  /**
   * Téléchargement d'un candidat absent du cache (GET d'un objet public, rien du projet). Défaut : client du
   * Hub quand le catalogue vient du cache ; un échec (hors ligne) écarte le candidat avec une note.
   */
  pull?: (ref: string, version: string) => Promise<void>;
  /** Nombre maximal de modules candidats dans le prompt (défaut 15). */
  limit?: number;
}

export const MAX_CANDIDATES = 15;

export interface SuggestOptions {
  engine?: Engine;
  /** Catalogue du Hub : pré-sélection locale des modules candidats (sans catalogue : bibliothèque entière, prompt historique). */
  hub?: HubSuggestOptions;
  /** Prévisualiser chaque variante valide (défaut : oui). */
  preview?: boolean;
  /** Pré-tri Qwen dans les aperçus (défaut : non). */
  triage?: boolean;
  /** Effectif des aperçus (défaut 200). */
  n?: number;
  seed?: number;
  maxRepairs?: number;
  library?: Map<string, LoadedModule>;
  log?: (msg: string) => void;
}

export interface VariantResult {
  variant: TargetVariant;
  /** Bloc `target` prêt à copier dans le fichier projet. */
  target: TargetSpec;
  errors: string[];
  preview?: TargetPreview;
}

export interface TargetSuggestion {
  project: { id: string; name: string };
  generatedAt: string;
  model: string;
  analysis: string;
  usageConditions: TargetSuggestionData["usageConditions"];
  variants: VariantResult[];
  missingModules: TargetSuggestionData["missingModules"];
  notes: string[];
  repairs: number;
  usage: { calls: number; inputTokens: number; outputTokens: number; durationMs: number };
  ms: number;
  /** Présent quand un catalogue du Hub est disponible : candidats pré-sélectionnés et modules existants proches des modules manquants. */
  hub?: HubSuggestionInfo;
}

export interface HubCandidate {
  /** Référence qualifiée (`personas/numerique`, `alice/sport`). */
  ref: string;
  version: string;
  label: string;
  source: SearchDoc["source"];
  quality: QualityScore | null;
  score: number;
}

export interface HubSuggestionInfo {
  candidates: HubCandidate[];
  /** Pour chaque module manquant proposé : modules existants proches (on cherche avant de créer). */
  missingMatches: Record<string, HubCandidate[]>;
  notes: string[];
}

/** Texte de la recherche locale : ce que dit le projet (jamais envoyé au Hub). */
function projectQuery(p: Project): string {
  return [p.name, p.pitch, p.targetAudience, p.businessModel, p.freeOffer, ...p.competitors, ...p.alternatives].filter(Boolean).join("\n");
}

const candidateOf = (d: SearchDoc, score: number, version = d.latest): HubCandidate => ({ ref: qualifiedRef(d.ref), version, label: d.label, source: d.source, quality: d.quality, score: Math.round(score * 1000) / 1000 });

/**
 * Pré-sélection (§ 6.2) : au plus `limit` modules candidats, bibliothèque locale et catalogue du Hub confondus,
 * classés par BM25 sur le projet, filtrés par socle et admissibilité (statut, Q). Les modules de la cible
 * actuelle du projet sont toujours gardés. Un candidat du catalogue absent du cache est téléchargé (lecture
 * seule, non épinglé) ; sinon il est écarté. Renvoie la bibliothèque réduite du prompt et celle des contrôles.
 */
export async function preselectModules(
  p: Project,
  opts: { catalog: CatalogResponse; library: Map<string, LoadedModule>; socle?: string; limit?: number; pull?: HubSuggestOptions["pull"]; log?: (m: string) => void },
): Promise<{ prompt: Map<string, LoadedModule>; check: Map<string, LoadedModule>; candidates: HubCandidate[]; notes: string[] }> {
  const socle = opts.socle ?? "fr";
  const limit = opts.limit ?? MAX_CANDIDATES;
  const docs = searchDocs(opts.library, opts.catalog).filter((d) => autoEligible(d, socle));
  const scores = new Map(bm25(docs, projectQuery(p)).map((h) => [h.doc.ref, h.score]));
  const current = new Set(((p.extra as ProjectExtra).target?.modules ?? []).map((m) => {
    try {
      return canonicalRef(m.replace(/@.*$/, ""));
    } catch {
      return m;
    }
  }));
  const ranked = [...docs].sort(
    (a, b) =>
      Number(current.has(b.ref)) - Number(current.has(a.ref)) ||
      (scores.get(b.ref) ?? 0) - (scores.get(a.ref) ?? 0) ||
      Number(b.source !== "hub") - Number(a.source !== "hub") ||
      (a.ref < b.ref ? -1 : 1),
  );
  const notes: string[] = [];
  const check = new Map(opts.library);
  const chosen: Array<{ doc: SearchDoc; m: LoadedModule }> = [];
  for (const d of ranked) {
    if (chosen.length >= limit) break;
    let m = opts.library.get(d.ref) ?? moduleAt(d.ref, d.latest, opts.library);
    if (!m && opts.pull) {
      try {
        opts.log?.(`Hub : téléchargement du candidat ${qualifiedRef(d.ref)}@${d.latest}…`);
        await opts.pull(qualifiedRef(d.ref), d.latest);
        m = moduleAt(d.ref, d.latest, opts.library);
      } catch (err) {
        notes.push(`candidat ${qualifiedRef(d.ref)}@${d.latest} écarté : ${(err as Error).message}`);
        continue;
      }
    }
    if (!m) {
      notes.push(`candidat ${qualifiedRef(d.ref)}@${d.latest} écarté : absent du cache (personas hub pull ${qualifiedRef(d.ref)})`);
      continue;
    }
    check.set(m.def.id, m);
    chosen.push({ doc: d, m });
  }
  // Bibliothèque du prompt : candidats et leurs dépendances, dans l'ordre de la bibliothèque (alphabétique)
  const prompt = new Map<string, LoadedModule>();
  for (const { doc, m } of chosen) {
    try {
      for (const dep of resolveModules([m.def.id], m.def.applies_to.includes(socle) ? socle : m.def.applies_to[0]!, check).ordered) prompt.set(dep.def.id, dep);
    } catch (err) {
      notes.push(`candidat ${qualifiedRef(doc.ref)} écarté : ${(err as Error).message}`);
    }
  }
  const sorted = new Map([...prompt].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const candidates = chosen.filter(({ m }) => sorted.has(m.def.id)).map(({ doc, m }) => candidateOf(doc, scores.get(doc.ref) ?? 0, m.def.version));
  return { prompt: sorted, check, candidates, notes };
}

/** Modules existants proches de chaque module manquant proposé (recherche locale sur sa description). */
export function missingModuleMatches(missing: TargetSuggestionData["missingModules"], library: Map<string, LoadedModule>, catalog: CatalogResponse | null, socle = "fr"): Record<string, HubCandidate[]> {
  const docs = searchDocs(library, catalog).filter((d) => autoEligible(d, socle));
  const out: Record<string, HubCandidate[]> = {};
  for (const mm of missing) {
    const hits = bm25(docs, [mm.id.replace(/-/g, " "), mm.description, ...mm.attributes].join("\n"), { limit: 3 });
    if (hits.length) out[mm.id] = hits.map((h) => candidateOf(h.doc, h.score));
  }
  return out;
}

export async function suggestTarget(project: ProjectInput, opts: SuggestOptions = {}): Promise<TargetSuggestion> {
  const t0 = performance.now();
  const row = projectRow(project);
  const engine = opts.engine ?? assistantEngine(loadConfig());
  const log = opts.log ?? (() => {});
  let lib = opts.library;
  // Catalogue du Hub : pré-sélection locale de ≤ 15 candidats (sans catalogue : bibliothèque entière, prompt inchangé)
  const fromCache = opts.hub?.catalog === undefined;
  const catalog = fromCache ? (readCachedCatalog()?.catalog ?? null) : (opts.hub!.catalog ?? null);
  let promptLib = lib;
  let hubInfo: HubSuggestionInfo | undefined;
  if (catalog) {
    const pull =
      opts.hub?.pull ??
      (fromCache
        ? async (ref: string, version: string) => {
            await pullModule(new HubClient(), `${ref}@${version}`, { catalog });
          }
        : undefined);
    const pre = await preselectModules(row, { catalog, library: lib ?? moduleLibrary(), limit: opts.hub?.limit ?? MAX_CANDIDATES, ...(pull && { pull }), log });
    promptLib = pre.prompt;
    lib = pre.check;
    hubInfo = { candidates: pre.candidates, missingMatches: {}, notes: pre.notes };
    log(`Hub : ${pre.candidates.length} module(s) candidat(s) pré-sélectionné(s) en local`);
  }
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
  const add = (r: CompleteResult<unknown>) => {
    usage.calls += r.attempts;
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    usage.durationMs += r.durationMs;
  };
  log("Assistant de cible : proposition (claude-cli, sans outil)…");
  let r = await engine.complete({ system: TARGET_SYSTEM, messages: [{ role: "user", content: suggestPrompt(row, promptLib) }], schema: targetSuggestionSchema, maxTokens: 12_000 });
  add(r);
  let data = r.data;
  let model = r.model;
  let checks = data.variants.map((v) => checkVariant(v, lib));
  let repairs = 0;
  const max = opts.maxRepairs ?? MAX_TARGET_REPAIRS;
  while (checks.some((c) => c.errors.length) && repairs < max) {
    repairs++;
    const errs = data.variants.map((v, i) => ({ variant: v.id, errors: checks[i]!.errors })).filter((e) => e.errors.length);
    log(`Réparation ${repairs}/${max} : ${errs.length} variante(s) invalide(s)`);
    r = await engine.complete({
      system: TARGET_SYSTEM,
      messages: [
        { role: "user", content: suggestPrompt(row, promptLib) },
        { role: "assistant", content: JSON.stringify(data) },
        { role: "user", content: targetRepairPrompt(data, errs) },
      ],
      schema: targetSuggestionSchema,
      maxTokens: 12_000,
    });
    add(r);
    data = r.data;
    model = r.model;
    checks = data.variants.map((v) => checkVariant(v, lib));
  }
  const variants: VariantResult[] = [];
  for (const [i, v] of data.variants.entries()) {
    const target = variantSpec(v, opts.n ?? 200);
    const res: VariantResult = { variant: v, target, errors: checks[i]!.errors };
    if (!res.errors.length && opts.preview !== false) {
      log(`Aperçu de la variante ${v.id}…`);
      try {
        res.preview = await previewTarget(row, { spec: target, n: opts.n ?? 200, seed: opts.seed ?? 42, sample: 3, triage: opts.triage ?? false, ...(lib && { library: lib }), log });
      } catch (err) {
        res.errors.push(`aperçu impossible : ${(err as Error).message}`);
      }
    }
    variants.push(res);
  }
  if (hubInfo && catalog) hubInfo.missingMatches = missingModuleMatches(data.missingModules, lib ?? moduleLibrary(), catalog);
  return {
    project: { id: row.id, name: row.name },
    generatedAt: new Date().toISOString(),
    model,
    analysis: data.analysis,
    usageConditions: data.usageConditions,
    variants,
    missingModules: data.missingModules,
    notes: data.notes,
    repairs,
    usage,
    ms: Math.round(performance.now() - t0),
    ...(hubInfo && { hub: hubInfo }),
  };
}

// ─── Fichier de proposition ───────────────────────────────────────────────────

/** Chemin par défaut : à côté du fichier projet (`x.target-suggestion.yaml`), sinon data/suggestions/<id>.target-suggestion.yaml. */
export function suggestionPath(projectFile: string | null, projectId: string): string {
  if (projectFile) return join(dirname(projectFile), `${basename(projectFile, extname(projectFile))}.target-suggestion.yaml`);
  return resolve(defaultDataDir(), "suggestions", `${projectId}.target-suggestion.yaml`);
}

/** Forme écrite dans le fichier : lisible, avec un bloc `target` prêt à copier par variante. */
export function suggestionDocument(s: TargetSuggestion): Record<string, unknown> {
  const pct = (x: number) => Math.round(x * 10_000) / 100;
  return {
    project: s.project.id,
    generatedAt: s.generatedAt,
    model: s.model,
    status: "proposition : rien n'est appliqué au projet",
    analysis: s.analysis,
    usageConditions: s.usageConditions,
    variants: s.variants.map((v) => ({
      id: v.variant.id,
      label: v.variant.label,
      description: v.variant.description,
      target: v.target,
      justification: v.variant.justification,
      ...(v.variant.quotas.length && { quotasWhy: v.variant.quotas.map((q) => `${q.dimension} : ${q.why}`) }),
      ...(v.errors.length && { errors: v.errors }),
      ...(v.preview && {
        preview: {
          eligibilityPct: pct(v.preview.eligibility.rate),
          ciPct: v.preview.eligibility.ci.map(pct),
          draws: v.preview.eligibility.draws,
          rare: v.preview.eligibility.rare,
          pcs: Object.fromEntries((v.preview.distributions.find((d) => d.key === "pcs")?.values ?? []).map((x) => [x.label, pct(x.share)])),
          // Attributs des conditions d'usage hors filtre : ce que la variante laisse varier
          ...(() => {
            const keys = new Set(s.usageConditions.map((c) => c.attribute).filter(Boolean));
            const dists = v.preview.distributions.filter((d) => keys.has(d.key) && !d.inFilter && d.values.length <= 6);
            return dists.length ? { outsideFilter: Object.fromEntries(dists.map((d) => [d.key, Object.fromEntries(d.values.map((x) => [x.label, pct(x.share)]))])) } : {};
          })(),
          ...(v.preview.triage && {
            triage: { notConcernedPct: pct(v.preview.triage.share), ciPct: v.preview.triage.ci.map(pct), alert: v.preview.triage.alert, message: v.preview.triage.message },
          }),
        },
      }),
    })),
    missingModules: s.missingModules,
    ...(s.hub && {
      hub: {
        candidates: s.hub.candidates.map((c) => `${c.ref}@${c.version} (${c.source})`),
        ...(Object.keys(s.hub.missingMatches).length && {
          existingForMissing: Object.fromEntries(Object.entries(s.hub.missingMatches).map(([id, l]) => [id, l.map((c) => `${c.ref}@${c.version}${c.quality ? ` (Q ${Math.round(c.quality.q)})` : ""}`)])),
        }),
        ...(s.hub.notes.length && { notes: s.hub.notes }),
      },
    }),
    notes: s.notes,
    usage: { claudeCalls: s.usage.calls, repairs: s.repairs, inputTokens: s.usage.inputTokens, outputTokens: s.usage.outputTokens, seconds: Math.round(s.ms / 1000) },
  };
}

export function writeSuggestion(s: TargetSuggestion, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# Proposition de l'assistant de cible (npm run target:suggest) pour le projet ${s.project.id}.\n` +
      "# Rien n'est appliqué : copier le bloc `target` d'une variante dans le fichier projet après relecture.\n" +
      toYaml(suggestionDocument(s), { lineWidth: 110 }),
  );
  return path;
}

