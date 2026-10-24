import { SENSITIVE_SOCLE_VARS, sensitiveAttributes, type SensitiveCategory } from "../modules/lint";
import { isLegacy, socleCatalog, type LoadedModule } from "../modules/registry";
import { canonicalRef, isOfficialRef, qualifiedRef } from "../modules/refs";
import type { catalogModuleV3, CatalogModule, CatalogResponse, QualityScore } from "./contract";
import type { z } from "zod";

/**
 * Recherche locale des modules (docs/plateforme.md § 6.2) : BM25 en mémoire sur les cartes des modules
 * (libellé, description, étiquettes, libellés des attributs et, pour les modules chargés, de leurs valeurs),
 * bibliothèque locale et catalogue du Hub téléchargé confondus. Tout tourne sur la machine : le texte cherché
 * (pitch, offre, description d'un module manquant) n'est jamais envoyé au Hub.
 *
 * Pas d'embeddings pour l'instant : un modèle CPU multilingue (famille e5-small, ONNX) demanderait un runtime
 * natif et un téléchargement de 30 à 120 Mo, disproportionnés pour un catalogue de quelques dizaines de modules ;
 * c'est la « variante dégradée » du § 6.2 (BM25 seul). L'index se reconstruit à chaque recherche (quelques
 * millisecondes pour un millier de cartes) : aucun fichier d'index à tenir à jour.
 */

export interface SearchDoc {
  /** Référence canonique (id nu pour personas/, ns/slug sinon). */
  ref: string;
  label: string;
  description: string;
  appliesTo: string[];
  latest: string;
  /** `local` : bibliothèque locale ; `cache` : téléchargé ; `hub` : catalogue seulement (à télécharger). */
  source: "local" | "cache" | "hub";
  status: string;
  quality: QualityScore | null;
  official: boolean;
  /**
   * Catégories sensibles (§ 11.4) : celles des attributs du module (local), `unknown` pour un module du catalogue
   * badgé « sensible » ; vide sinon.
   */
  sensitive: Array<SensitiveCategory | "unknown">;
  /** Texte indexé, pondéré par répétition (libellé ×3, étiquettes ×2, attributs ×1, description ×1). */
  text: string[];
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
}

const STOPWORDS = new Set(
  (
    "les des une est pour par avec dans sur aux qui que quoi dont ses son sont leur leurs plus moins pas tout tous toute " +
    "cette ces mais comme elle elles ils nous vous lui ont avoir etre fait faire peut sans entre chez vers apres avant " +
    "the and for with that this from are was were have has not you your their they them its into about over than then " +
    "will can our out all any but how what which who why when where also more most such use used using"
  ).split(" "),
);

/** Mots d'un texte : minuscules, sans accents, mots de 3 lettres et plus hors mots vides, pluriels simples retirés. */
export function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w));
}

const weighted = (parts: Array<[string | undefined, number]>) => parts.flatMap(([t, w]) => (t ? Array.from({ length: w }, () => tokenize(t)).flat() : []));

function localDoc(m: LoadedModule, catalogEntry?: CatalogModule): SearchDoc {
  const attrs = m.def.attributes.map((a) => {
    const values = a.type === "enum" ? a.values.map((v) => (typeof v.label === "string" ? v.label : v.label.F)).join(" ") : a.type === "set" ? a.items.map((i) => i.label).join(" ") : "";
    return `${a.label} ${a.description ?? ""} ${values}`;
  });
  return {
    ref: m.def.id,
    label: m.def.label,
    description: m.def.description?.trim() ?? "",
    appliesTo: m.def.applies_to,
    latest: m.def.version,
    source: m.source === "hub-cache" ? "cache" : "local",
    status: catalogEntry?.versions.find((v) => v.version === m.def.version)?.status ?? "published",
    quality: catalogEntry?.versions.find((v) => v.version === m.def.version)?.quality ?? null,
    official: isOfficialRef(m.def.id),
    sensitive: [...new Set(sensitiveAttributes(m.def).flatMap((a) => (a.categories.length ? a.categories : ["unknown" as const])))],
    text: weighted([[m.def.label, 3], [m.def.short_label, 2], [catalogEntry?.tags.join(" "), 2], [attrs.join(" "), 1], [m.def.description, 1]]),
  };
}

function catalogDoc(c: CatalogModule & Partial<Pick<z.infer<typeof catalogModuleV3>, "ranking">>): SearchDoc {
  const latest = c.versions.find((v) => v.version === c.latest);
  return {
    ref: canonicalRef(c.ref),
    label: c.label,
    description: c.description,
    appliesTo: c.appliesTo,
    latest: c.latest,
    source: "hub",
    status: latest?.status ?? "published",
    quality: latest?.quality ?? null,
    sensitive: c.ranking?.badges.includes("sensitive") ? ["unknown"] : [],
    official: isOfficialRef(c.ref),
    text: weighted([[c.label, 3], [c.tags.join(" "), 2], [c.attributes.map((a) => `${a.key.replace(/_/g, " ")} ${a.label}`).join(" "), 1], [c.description, 1]]),
  };
}

/** Cartes indexées : modules actifs de la bibliothèque (prioritaires), puis ceux du catalogue absents localement. */
export function searchDocs(lib: Map<string, LoadedModule>, catalog: CatalogResponse | null | undefined): SearchDoc[] {
  const byRef = new Map((catalog?.modules ?? []).map((c) => [canonicalRef(c.ref), c]));
  const out = new Map<string, SearchDoc>();
  for (const m of lib.values()) if (!isLegacy(m)) out.set(m.def.id, localDoc(m, byRef.get(m.def.id)));
  for (const [ref, c] of byRef) if (!out.has(ref)) out.set(ref, catalogDoc(c));
  return [...out.values()];
}

/** Pays d'un nom de socle (« fr-2026.2 » → fr). */
const country = (socle: string) => socle.toLowerCase().replace(/-.*$/, "");

/** Catégories sensibles que le socle porte déjà (Singapour : ethnie, religion), § 11.4. */
export function socleSensitiveCategories(socle: string): Set<SensitiveCategory> {
  const vars: readonly string[] = socleCatalog(country(socle)).vars.profile;
  return new Set(vars.flatMap((v) => (SENSITIVE_SOCLE_VARS[v] ? [SENSITIVE_SOCLE_VARS[v]] : [])));
}

/**
 * Admissible au choix automatique (§ 5.2) : compatible avec le socle, pas retiré ni signalé ; hors namespace
 * officiel, une version non vérifiée ou de qualité Q < 40 reste visible en recherche manuelle seulement.
 * Un module sensible (§ 11.4) n'est proposé que si le socle porte déjà toutes ses catégories sensibles
 * (catégories inconnues, module du catalogue seulement : exclu).
 */
export function autoEligible(d: SearchDoc, socle?: string): boolean {
  if (socle && !d.appliesTo.map(country).includes(country(socle))) return false;
  if (d.status === "yanked" || d.status === "flagged" || d.status === "removed") return false;
  if (d.sensitive.length) {
    const carried = socle ? socleSensitiveCategories(socle) : new Set<SensitiveCategory>();
    if (!d.sensitive.every((c) => c !== "unknown" && carried.has(c))) return false;
  }
  if (d.official || d.source === "local") return true;
  if (d.status === "unverified") return false;
  return d.quality === null || d.quality.q >= 40;
}

/** BM25 (k1 = 1,2, b = 0,75) ; résultats de score > 0, triés par score puis par référence. */
export function bm25(docs: SearchDoc[], query: string, opts: { limit?: number } = {}): SearchHit[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.text.length, 0) / N || 1;
  const df = new Map<string, number>();
  const tfs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const w of d.text) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    return tf;
  });
  const k1 = 1.2;
  const b = 0.75;
  const hits: SearchHit[] = [];
  docs.forEach((d, i) => {
    let score = 0;
    for (const w of q) {
      const f = tfs[i]!.get(w);
      if (!f) continue;
      const n = df.get(w)!;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.text.length) / avg));
    }
    if (score > 0) hits.push({ doc: d, score });
  });
  hits.sort((x, y) => y.score - x.score || (x.doc.ref < y.doc.ref ? -1 : 1));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/** Recherche manuelle (`personas hub search`) : tous les modules compatibles, admissibles ou non au choix automatique. */
export function searchModules(query: string, opts: { lib: Map<string, LoadedModule>; catalog?: CatalogResponse | null; socle?: string; limit?: number }): SearchHit[] {
  const docs = searchDocs(opts.lib, opts.catalog).filter((d) => !opts.socle || d.appliesTo.map(country).includes(country(opts.socle)));
  return bm25(docs, query, { limit: opts.limit ?? 20 });
}

/** Libellé qualifié d'un résultat (`personas/numerique`). */
export const hitRef = (h: SearchHit) => qualifiedRef(h.doc.ref);

/** Q décomposé (§ 5.1) : « Q 78 (sourçage 0,8 · marges 0,6 · alertes 0,9 · doc 1) ». */
export function formatQuality(q: QualityScore | null, lang: "fr" | "en" = "fr"): string {
  if (!q) return lang === "fr" ? "Q non calculé" : "Q not computed";
  const n = (x: number) => (lang === "fr" ? String(Math.round(x * 100) / 100).replace(".", ",") : String(Math.round(x * 100) / 100));
  return lang === "fr"
    ? `Q ${Math.round(q.q)} (sourçage ${n(q.sourcing)} · marges ${n(q.margins)} · alertes ${n(q.alerts)} · doc ${n(q.docs)})`
    : `Q ${Math.round(q.q)} (sourcing ${n(q.sourcing)} · margins ${n(q.margins)} · alerts ${n(q.alerts)} · docs ${n(q.docs)})`;
}
