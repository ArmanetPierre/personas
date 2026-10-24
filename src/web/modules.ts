import { moduleSpec } from "../config";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkModule, moduleLibrary, ModuleError, modulesRoot } from "../modules/registry";
import { compileEligibility, type EligibilityNode } from "../population/eligibility";
import { moduleSchema, type ModuleDef } from "../modules/schema";
import { DEFAULT_LANG, L, overlay, type Lang } from "./i18n";
import { overlayNested, SOCLE_LABELS_EN, SOCLE_VALUE_LABELS_EN } from "./i18n-labels";

/**
 * Adaptateur entre l'API web et l'assistant de création de modules (`src/modules/assistant/index.ts`,
 * écrit à part). Les fonctions de l'assistant sont importées dynamiquement : tant qu'il n'existe pas,
 * la bibliothèque, la lecture et la validation passent par un repli qui lit `modules/` directement,
 * et la proposition, la révision, l'aperçu et l'acceptation répondent « assistant indisponible ».
 */

// ─── Contrat de l'assistant ───────────────────────────────────────────────────

export interface ModuleSummary {
  id: string;
  version: string;
  label: string;
  /** `validated` ou `draft:<statut du brouillon>`. */
  status: string;
  draftId?: string;
  appliesTo: string[];
  requires: string[];
  attributeCount: number;
  sourcedCount: number;
  assumptionCount: number;
  updatedAt: string | null;
}

export interface DraftMeta {
  id: string;
  status: "proposing" | "ready" | "error" | "accepted" | string;
  progress?: unknown;
  description?: string;
  projectId?: string;
  socle?: string;
  createdAt?: string;
  updatedAt?: string;
  notes?: unknown[];
  history?: unknown[];
  error?: string;
  [k: string]: unknown;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface GetModuleResult {
  yaml: string;
  parsed?: unknown;
  status: string;
  meta?: DraftMeta;
  validationErrors: Array<ValidationIssue | string>;
}

export interface PreviewResult {
  n?: number;
  margins: Array<{ attribute: string; label: string; type?: string; applicable?: number; values: Array<{ code: string; label: string; share: number }> }>;
  sampleCards: Array<{ personaId: string; card: unknown }>;
  /** Niveaux : `error`, `warn` (ou `warning`), `info`. */
  alerts: Array<{ level: "error" | "warn" | "warning" | "info" | string; message: string; attribute?: string }>;
  eligibilityHelpers?: Array<{ name: string; expression: string; rate: number }> | unknown;
}

type MaybePromise<T> = T | Promise<T>;

export interface AssistantApi {
  listModules(): MaybePromise<ModuleSummary[]>;
  getModule(idOrDraftId: string): MaybePromise<GetModuleResult>;
  validateModuleYaml(yaml: string): MaybePromise<{ ok: boolean; errors: ValidationIssue[] }>;
  previewModule(source: { draftId?: string; moduleId?: string; yaml?: string }, opts: { n: number; sample: number }): MaybePromise<PreviewResult>;
  saveDraftYaml(draftId: string, yaml: string): MaybePromise<unknown>;
}

export type AssistantLoader = () => Promise<{ api: AssistantApi | null; reason?: string }>;

const REQUIRED = ["listModules", "getModule", "validateModuleYaml", "previewModule", "saveDraftYaml"] as const;

/** Import dynamique de l'assistant ; un succès est gardé, un échec est retenté à l'appel suivant. */
export function defaultAssistantLoader(): AssistantLoader {
  let cached: AssistantApi | null = null;
  return async () => {
    if (cached) return { api: cached };
    try {
      // Chemin en variable : le module peut ne pas exister au moment du typecheck et du build
      const spec = moduleSpec("../modules/assistant/index");
      const mod = (await import(/* @vite-ignore */ spec)) as Partial<AssistantApi>;
      const missing = REQUIRED.filter((f) => typeof mod[f] !== "function");
      if (missing.length) return { api: null, reason: `Assistant incomplet : fonction(s) absente(s) : ${missing.join(", ")}.` };
      cached = mod as AssistantApi;
      return { api: cached };
    } catch (err) {
      const msg = (err as Error).message;
      return {
        api: null,
        reason: /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load/i.test(msg)
          ? "Assistant indisponible : src/modules/assistant/index.ts n'existe pas encore."
          : `Assistant indisponible : ${msg}`,
      };
    }
  };
}

// ─── Repli : lecture directe de modules/ ─────────────────────────────────────

export const draftsDir = (modulesDir: string) => join(modulesDir, "_drafts");
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function readDraftMeta(modulesDir: string, draftId: string): DraftMeta | null {
  if (!SAFE_ID.test(draftId)) return null;
  const f = join(draftsDir(modulesDir), draftId, "meta.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as DraftMeta;
  } catch {
    return null;
  }
}

function mtime(f: string): string | null {
  try {
    return statSync(f).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Validation complète d'un YAML de module : syntaxe, schéma zod, puis contrôles sémantiques du registre. */
export function fallbackValidate(yaml: string): { ok: boolean; errors: ValidationIssue[]; def?: ModuleDef } {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    return { ok: false, errors: [{ path: "", message: `YAML illisible : ${(err as Error).message.split("\n")[0]}` }] };
  }
  const parsed = moduleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  try {
    checkModule(raw);
  } catch (err) {
    if (!(err instanceof ModuleError)) throw err;
    const lines = err.message.split("\n").slice(1).map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
    return { ok: false, errors: (lines.length ? lines : [err.message]).map((message) => ({ path: "", message })), def: parsed.data };
  }
  return { ok: true, errors: [], def: parsed.data };
}

function summaryOf(def: ModuleDef | undefined, fallbackId: string, status: string, updatedAt: string | null, draftId?: string): ModuleSummary {
  const attrs = def?.attributes ?? [];
  return {
    id: def?.id ?? fallbackId,
    version: def?.version ?? "?",
    label: def?.label ?? fallbackId,
    status,
    ...(draftId && { draftId }),
    appliesTo: def?.applies_to ?? [],
    requires: def?.requires ?? [],
    attributeCount: attrs.length,
    sourcedCount: attrs.filter((a) => a.sources.length > 0).length,
    assumptionCount: attrs.filter((a) => a.assumption).length,
    updatedAt,
  };
}

export function fallbackApi(modulesDir = modulesRoot()): Omit<AssistantApi, "previewModule"> {
  const fileOf = (id: string) => {
    if (!SAFE_ID.test(id)) return null;
    const validated = join(modulesDir, id, "module.yaml");
    if (id !== "_drafts" && existsSync(validated)) return { file: validated, draftId: undefined };
    const draft = join(draftsDir(modulesDir), id, "module.yaml");
    if (existsSync(draft) || existsSync(join(draftsDir(modulesDir), id, "meta.json"))) return { file: draft, draftId: id };
    return null;
  };
  return {
    listModules() {
      const out: ModuleSummary[] = [];
      if (!existsSync(modulesDir)) return out;
      for (const d of readdirSync(modulesDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith("_")) continue;
        const f = join(modulesDir, d.name, "module.yaml");
        if (!existsSync(f)) continue;
        out.push(summaryOf(fallbackValidate(readFileSync(f, "utf8")).def, d.name, "validated", mtime(f)));
      }
      const dd = draftsDir(modulesDir);
      if (existsSync(dd)) {
        for (const d of readdirSync(dd, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const meta = readDraftMeta(modulesDir, d.name);
          const f = join(dd, d.name, "module.yaml");
          const def = existsSync(f) ? fallbackValidate(readFileSync(f, "utf8")).def : undefined;
          out.push(summaryOf(def, d.name, `draft:${meta?.status ?? "proposing"}`, meta?.updatedAt ?? mtime(f), d.name));
        }
      }
      return out;
    },
    getModule(id) {
      const found = fileOf(id);
      if (!found) throw new Error(`Module introuvable : ${id}`);
      const yaml = existsSync(found.file) ? readFileSync(found.file, "utf8") : "";
      const v = yaml ? fallbackValidate(yaml) : { ok: false, errors: [{ path: "", message: "Pas encore de YAML : proposition en cours." }], def: undefined };
      const meta = found.draftId ? readDraftMeta(modulesDir, found.draftId) : null;
      return {
        yaml,
        ...(v.def && { parsed: v.def }),
        status: found.draftId ? `draft:${meta?.status ?? "proposing"}` : "validated",
        ...(meta && { meta }),
        validationErrors: v.errors,
      };
    },
    validateModuleYaml(yaml) {
      const { ok, errors } = fallbackValidate(yaml);
      return { ok, errors };
    },
    saveDraftYaml(draftId, yaml) {
      if (!SAFE_ID.test(draftId)) throw new Error(`Brouillon invalide : ${draftId}`);
      const dir = join(draftsDir(modulesDir), draftId);
      if (!existsSync(dir)) throw new Error(`Brouillon introuvable : ${draftId}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "module.yaml"), yaml);
      return { ok: true };
    },
  };
}

// ─── Vue lisible d'un module (détail et revue) ───────────────────────────────

export const SOCLE_LABELS: Record<string, string> = {
  age: "âge",
  sex: "sexe",
  region: "région",
  town_size: "taille d'agglomération",
  household_type: "type de ménage",
  tenure: "statut d'occupation du logement",
  children_under_12: "enfants de moins de 12 ans",
  partner_status: "situation du conjoint",
  living_standard_ratio: "niveau de vie rapporté à la médiane",
  living_standard: "niveau de vie",
  tech_adoption: "adoption technologique",
  social_media: "usage des réseaux sociaux",
  has_computer: "possède un ordinateur",
  has_smartphone: "possède un smartphone",
  has_tablet: "possède une tablette",
  budget: "reste-à-vivre",
  household_size: "taille du ménage",
  household_income: "revenu du ménage",
  children: "enfants",
  monthly_income: "revenu",
  activity_status: "situation d'activité",
  pcs: "PCS",
};

/** Libellés des codes du socle (conditions en clair). */
export const SOCLE_VALUE_LABELS: Record<string, Record<string, string>> = {
  activity_status: { employed: "en emploi", unemployed: "au chômage", student: "en études", retired: "à la retraite", inactive: "inactif" },
  sex: { F: "femme", M: "homme" },
  pcs: { "1": "agriculteurs", "2": "artisans, commerçants, chefs d'entreprise", "3": "cadres", "4": "professions intermédiaires", "5": "employés", "6": "ouvriers", none: "jamais en emploi" },
  town_size: { rural: "rural", uu_lt20k: "moins de 20 000 hab.", uu_20k_100k: "20 000 à 99 999 hab.", uu_100k_200k: "100 000 à 199 999 hab.", uu_200k_2m: "200 000 à 2 millions", uu_paris: "agglomération parisienne" },
  partner_status: { none: "sans conjoint", employed: "conjoint en emploi", not_employed: "conjoint sans emploi" },
};

const cap = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

const REF_KEYS = new Set(["attr", "given", "by", "pick"]);

type Def = ModuleDef;

/** Références d'attributs citées dans une partie de définition (conditions nommées et tables suivies). */
function collectRefs(node: unknown, def: Def, out: Set<string>, seen: Set<string>): void {
  if (typeof node === "string") {
    // Nom d'une condition déclarée (when: digital, factors: { freelance: 0.3 })
    if (def.conditions[node] && !seen.has(`cond:${node}`)) {
      seen.add(`cond:${node}`);
      collectRefs(def.conditions[node], def, out, seen);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, def, out, seen);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (REF_KEYS.has(k)) {
      for (const r of Array.isArray(v) ? v : [v]) if (typeof r === "string") out.add(r);
    }
    if (k === "lookup" && typeof v === "string" && def.tables[v] && !seen.has(`table:${v}`)) seen.add(`table:${v}`);
    if (k === "factors" && v && typeof v === "object") for (const c of Object.keys(v)) collectRefs(c, def, out, seen);
    if (k === "values" || k === "items" || k === "labels" || k === "table" || k === "display" || k === "sources" || k === "justification") continue;
    collectRefs(v, def, out, seen);
  }
}

function refLabel(ref: string, def: Def, lang: Lang = DEFAULT_LANG): string {
  if (ref.startsWith("socle.")) return overlay(lang, SOCLE_LABELS, SOCLE_LABELS_EN)[ref.slice(6)] ?? ref.slice(6);
  if (ref.includes(".")) {
    // Attribut d'un module requis : son libellé, lu dans la bibliothèque
    const [mid, key] = [ref.slice(0, ref.lastIndexOf(".")), ref.slice(ref.lastIndexOf(".") + 1)];
    try {
      const l = moduleLibrary().get(mid)?.attrs.get(key)?.label;
      if (l) return `${l} (${mid})`;
    } catch {
      // bibliothèque illisible : référence brute
    }
    return ref;
  }
  return def.attributes.find((a) => a.key === ref)?.label ?? ref;
}

function valueLabelOf(def: Def, ref: string, code: unknown, lang: Lang = DEFAULT_LANG): string {
  if (ref.startsWith("socle.")) return overlayNested(lang, SOCLE_VALUE_LABELS, SOCLE_VALUE_LABELS_EN)[ref.slice(6)]?.[String(code)] ?? String(code);
  const a = def.attributes.find((x) => x.key === ref);
  if (a?.type === "enum") {
    const v = a.values.find((x) => x.code === String(code));
    if (v) return typeof v.label === "string" ? v.label : v.label.F === v.label.M ? v.label.M : `${v.label.M} / ${v.label.F}`;
  }
  if (a?.type === "set") {
    const i = a.items.find((x) => x.code === String(code));
    if (i) return i.label;
  }
  return String(code);
}

/** Condition en clair : « Situation d'activité parmi en emploi ; au chômage ». */
export function conditionText(c: unknown, def: Def, depth = 0, lang: Lang = DEFAULT_LANG): string {
  if (depth === 0) return cap(conditionInner(c, def, 0, lang));
  return conditionInner(c, def, depth, lang);
}

function conditionInner(c: unknown, def: Def, depth: number, lang: Lang): string {
  if (depth > 6) return "…";
  const q = (x: string) => L(lang, `« ${x} »`, `“${x}”`);
  // Condition nommée : son nom suffit ici, son détail est dans la liste des conditions
  if (typeof c === "string") return depth === 0 || !def.conditions[c] ? q(c) : conditionText(def.conditions[c], def, depth + 1, lang);
  if (!c || typeof c !== "object") return String(c);
  const o = c as Record<string, unknown>;
  if (Array.isArray(o.all)) return o.all.map((x) => conditionText(x, def, depth + 1, lang)).join(L(lang, " et ", " and "));
  if (Array.isArray(o.any)) return `(${o.any.map((x) => conditionText(x, def, depth + 1, lang)).join(L(lang, " ou ", " or "))})`;
  if (o.not !== undefined) return `${L(lang, "non", "not")} (${conditionText(o.not, def, depth + 1, lang)})`;
  const attr = typeof o.attr === "string" ? o.attr : "?";
  const l = refLabel(attr, def, lang);
  if (Array.isArray(o.in)) {
    const vals = o.in.map((v) => valueLabelOf(def, attr, v, lang));
    const sep = L(lang, " ; ", "; ");
    const list = vals.length > 4 ? L(lang, `${vals.slice(0, 3).join(sep)} et ${vals.length - 3} autres`, `${vals.slice(0, 3).join(sep)} and ${vals.length - 3} others`) : vals.join(sep);
    return `${l} ${L(lang, "parmi", "in")} ${list}`;
  }
  if ("eq" in o) return o.eq === true ? l : o.eq === false ? `${L(lang, "pas", "not")} ${l.toLowerCase()}` : `${l} = ${valueLabelOf(def, attr, o.eq, lang)}`;
  if ("lt" in o) return `${l} < ${String(o.lt)}`;
  if ("gt" in o) return `${l} > ${String(o.gt)}`;
  if ("present" in o) return o.present ? `${l} ${L(lang, "renseigné", "provided")}` : `${l} ${L(lang, "absent", "missing")}`;
  return JSON.stringify(c);
}

/**
 * Filtre d'éligibilité en clair (« Fréquence de jeu : régulier hebdomadaire ou quotidien »). Les variables du module
 * s'écrivent `<id>.<attribut>`, celles du socle sans préfixe (age, pcs, children…). Phrase illisible : null.
 */
export function eligibilityText(expression: string, def: Def, lang: Lang = DEFAULT_LANG): string | null {
  let ast: EligibilityNode;
  try {
    ast = compileEligibility(expression).ast;
  } catch {
    return null;
  }
  const prefix = `${def.id}.`;
  const refOf = (name: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name.includes(".") ? name : `socle.${name}`);
  const lab = (name: string) => refLabel(refOf(name), def, lang);
  const val = (name: string, v: unknown) => valueLabelOf(def, refOf(name), v, lang);
  const or = L(lang, " ou ", " or ");
  const walk = (n: EligibilityNode, depth: number): string => {
    switch (n.kind) {
      case "truthy":
        return lab(n.name);
      case "not":
        return `${L(lang, "non", "not")} (${walk(n.item, depth + 1)})`;
      case "and":
        return n.items.map((x) => walk(x, depth + 1)).join(L(lang, " et ", " and "));
      case "or": {
        const t = n.items.map((x) => walk(x, depth + 1)).join(or);
        return depth > 0 ? `(${t})` : t;
      }
      case "in": {
        const vs = n.values.map((v) => val(n.name, v));
        const list = vs.length > 1 ? `${vs.slice(0, -1).join(", ")}${or}${vs[vs.length - 1]}` : (vs[0] ?? "");
        return n.negate ? `${lab(n.name)}${L(lang, " : ni ", ": neither ")}${vs.join(L(lang, " ni ", " nor "))}` : `${lab(n.name)}${L(lang, " : ", ": ")}${list}`;
      }
      case "cmp": {
        const sym = { "==": "=", "!=": "≠", "<": "<", "<=": "≤", ">": ">", ">=": "≥" }[n.op];
        if (typeof n.value === "boolean") return n.value === (n.op === "==") ? lab(n.name) : `${L(lang, "non", "not")} (${lab(n.name)})`;
        return `${lab(n.name)} ${sym} ${typeof n.value === "number" ? n.value : val(n.name, n.value)}`;
      }
    }
  };
  return cap(walk(ast, 0));
}

/** « Joueurs parmi les adultes (SELL : 76 %) » → libellé et note de source (la dernière parenthèse). */
export function splitShareLabel(l: string): { title: string; note: string | null } {
  const m = /^(.*\S)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/s.exec(l);
  return m ? { title: m[1]!, note: m[2]! } : { title: l, note: null };
}

const label = (l: string | { M: string; F: string }) => (typeof l === "string" ? l : l.M === l.F ? l.M : `${l.M} / ${l.F}`);

/**
 * Vue lisible d'un module. `lang` traduit les tournures générées ici (conditions, distribution, provenance)
 * et les libellés du socle ; les libellés, descriptions et sources du module viennent du YAML (données).
 */
export function moduleView(def: Def, lang: Lang = DEFAULT_LANG) {
  const ref = (r: string) => refLabel(r, def, lang);
  const cond = (c: unknown) => conditionText(c, def, 0, lang);
  const citedBy = new Map<string, string[]>();
  const cite = (keys: string[], who: string) => keys.forEach((k) => citedBy.set(k, [...(citedBy.get(k) ?? []), who]));
  const attributes = def.attributes.map((a) => {
    const refs = new Set<string>();
    collectRefs({ ...a, when: undefined }, def, refs, new Set());
    const whenRefs = new Set<string>();
    if (a.when !== undefined) collectRefs(a.when, def, whenRefs, new Set());
    const tablesUsed: string[] = [];
    JSON.stringify(a, (k, v) => {
      if (k === "lookup" && typeof v === "string") tablesUsed.push(v);
      return v;
    });
    for (const t of tablesUsed) collectRefs(def.tables[t] ?? {}, def, refs, new Set());
    cite(a.sources, L(lang, `attribut « ${a.label} »`, `attribute “${a.label}”`));
    const dist = a.type === "enum" ? a.distribution : null;
    return {
      key: a.key,
      label: a.label,
      type: a.type,
      description: a.description ?? null,
      values: a.type === "enum" ? a.values.map((v) => ({ code: v.code, label: label(v.label) })) : a.type === "set" ? a.items.map((i) => ({ code: i.code, label: i.label })) : a.type === "boolean" && a.labels ? [{ code: "true", label: a.labels.yes }, { code: "false", label: a.labels.no }] : [],
      unit: a.type === "number" ? a.unit ?? null : null,
      when: a.when !== undefined ? cond(a.when) : null,
      whenDependsOn: [...whenRefs].map(ref),
      dependsOn: [...refs].filter((r) => r !== a.key).map(ref),
      tables: [...new Set(tablesUsed)],
      distribution:
        a.type === "enum"
          ? dist!.given
            ? `${L(lang, "table conditionnée à", "table conditioned on")} ${(Array.isArray(dist!.given) ? dist!.given : [dist!.given]).map(ref).join(" × ")}`
            : lang === "en"
              ? `${Object.values(dist!.weights ?? {}).some((w) => typeof w !== "number") ? "weights computed for each persona" : "fixed weights"}${dist!.sampler === "quasi" ? ", quasi-random draw" : ""}`
              : `poids${Object.values(dist!.weights ?? {}).some((w) => typeof w !== "number") ? " calculés pour chaque persona" : " fixes"}${dist!.sampler === "quasi" ? ", tirage quasi aléatoire" : ""}`
          : a.type === "set"
            ? `${L(lang, "options tirées indépendamment", "options drawn independently")}${a.max_items ? L(lang, `, ${a.max_items} au plus`, `, at most ${a.max_items}`) : ""}`
            : a.type === "boolean"
              ? a.rate !== undefined
                ? L(lang, "probabilité calculée", "computed probability")
                : L(lang, "calculé", "computed")
              : L(lang, "valeur calculée", "computed value"),
      sources: a.sources,
      assumption: a.assumption,
      justification: a.justification ?? null,
    };
  });
  const tables = Object.entries(def.tables).map(([key, t]) => {
    const tt = t as { label?: string; sources?: string[]; assumption?: boolean; justification?: string; values?: Record<string, unknown>; bands?: unknown[] };
    cite(tt.sources ?? [], L(lang, `table « ${tt.label ?? key} »`, `table “${tt.label ?? key}”`));
    return { key, label: tt.label ?? key, kind: tt.bands ? L(lang, "tranches", "bands") : L(lang, "valeurs", "values"), size: tt.bands?.length ?? Object.keys(tt.values ?? {}).length, sources: tt.sources ?? [], assumption: tt.assumption ?? false, justification: tt.justification ?? null };
  });
  const sources = Object.entries(def.sources).map(([key, s]) => ({ key, ...s, citedBy: citedBy.get(key) ?? [] }));
  return {
    id: def.id,
    version: def.version,
    label: def.label,
    shortLabel: def.short_label ?? null,
    description: def.description ?? null,
    appliesTo: def.applies_to,
    requires: def.requires,
    sources,
    conditions: Object.entries(def.conditions).map(([name, c]) => ({ name, text: cond(c) })),
    tables,
    attributes,
    card: def.card.map((l) => (typeof l === "string" ? { when: null, template: l } : { when: (l as { when?: unknown }).when !== undefined ? cond((l as { when: unknown }).when) : null, template: (l as { template: string }).template })),
    segments: def.segments.map((s) => ({ id: s.id, label: s.label, attribute: s.attribute, attributeLabel: ref(s.attribute) })),
    /** Filtres prêts à l'emploi : nom, phrase du langage de ciblage et sa lecture en clair. */
    eligibilityHelpers: Object.entries(def.eligibility_helpers).map(([name, expression]) => ({ name, expression, text: eligibilityText(expression, def, lang) })),
    /** Parts sourcées déclarées (validation.shares) : fourchette attendue, libellé et note de source séparés. */
    validationShares: def.validation.shares.map((sh) => ({ label: sh.label, ...splitShareLabel(sh.label), range: sh.range })),
    sourcedCount: attributes.filter((a) => a.sources.length > 0).length,
    assumptionCount: attributes.filter((a) => a.assumption).length,
    /** Libellés des attributs déclarés sensibles (RGPD art. 9). */
    sensitive: def.attributes.filter((a) => a.sensitive).map((a) => a.label),
    changelog: def.changelog,
    overridesSocle: Boolean(def.socle_overrides),
    unsourced: [...attributes.filter((a) => !a.sources.length && !a.assumption).map((a) => a.label), ...tables.filter((t) => !t.sources.length && !t.assumption).map((t) => t.label)],
  };
}

export type ModuleView = ReturnType<typeof moduleView>;

/** Vue d'un `parsed` venu de l'assistant : revalidé par le schéma, sinon rien. */
export function viewOf(parsed: unknown, yaml: string, lang: Lang = DEFAULT_LANG): ModuleView | null {
  const p = moduleSchema.safeParse(parsed);
  if (p.success) return moduleView(p.data, lang);
  const v = fallbackValidate(yaml);
  return v.def ? moduleView(v.def, lang) : null;
}
