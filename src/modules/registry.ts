import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { moduleSchema, type Condition, type Expr, type ModuleAttribute, type ModuleDef } from "./schema";
import { DWELLINGS, EDUCATION_LEVELS, ETHNICITIES, HOME_LANGUAGES, RELIGIONS, RESIDENCY, SG_NATIONALITIES, SG_TENURES, SSOC_CODES } from "../personas/countries/sg/codes";

/**
 * Bibliothèque de modules : chargement des YAML, contrôles sémantiques (sources, références,
 * ordre de tirage), résolution des dépendances (graphe acyclique) et attribution des dimensions
 * quasi aléatoires.
 */

export const MODULES_DIR = resolve(import.meta.dirname, "../../modules");

/** Variables du socle visibles par les modules, selon la phase de tirage. */
export const SOCLE_VARS = {
  work: ["age", "sex", "region", "town_size"],
  profile: [
    "age",
    "sex",
    "region",
    "town_size",
    "household_type",
    "tenure",
    "children_under_12",
    "partner_status",
    "living_standard_ratio",
    "monthly_income",
    "activity_status",
    "pcs",
    "living_standard",
    "has_computer",
    "has_smartphone",
    "has_tablet",
    "has_internet",
    "tech_adoption",
    "social_media",
  ],
} as const;
/** Codes des variables catégorielles du socle (contrôle des tables conditionnées au socle). */
export const SOCLE_CODES: Record<string, string[]> = {
  sex: ["F", "M"],
  activity_status: ["employed", "unemployed", "student", "retired", "inactive"],
  pcs: ["1", "2", "3", "4", "5", "6", "none"],
  town_size: ["rural", "uu_lt20k", "uu_20k_100k", "uu_100k_200k", "uu_200k_2m", "uu_paris"],
  tenure: ["owner", "owner_mortgage", "renter_private", "renter_social", "free"],
  household_type: ["alone", "couple_no_child", "couple_with_children", "single_parent", "with_parents", "other"],
  partner_status: ["none", "employed", "not_employed"],
  tech_adoption: ["innovator", "early_adopter", "early_majority", "late_majority", "laggard"],
  social_media: ["none", "occasional", "daily", "heavy"],
};

/** Description des variables du socle (catalogue fourni à l'assistant de modules et à la doc). */
export const SOCLE_VAR_DOCS: Record<string, string> = {
  age: "âge en années (18-79)",
  sex: "F ou M",
  region: "code de région (IDF, ARA, OCC, PAC, NAQ, HDF, GES, BRE, PDL, NOR, BFC, CVL, COR)",
  town_size: "taille d'agglomération : rural, uu_lt20k, uu_20k_100k, uu_100k_200k, uu_200k_2m, uu_paris",
  household_type: "alone, couple_no_child, couple_with_children, single_parent, with_parents, other",
  tenure: "owner, owner_mortgage, renter_private, renter_social, free",
  children_under_12: "nombre d'enfants de moins de 12 ans au foyer",
  partner_status: "none, employed, not_employed",
  living_standard_ratio: "niveau de vie / médiane nationale (≈ 1 = médian)",
  living_standard: "niveau de vie mensuel en € par unité de consommation",
  monthly_income: "revenu personnel net mensuel (€)",
  activity_status: "employed, unemployed, student, retired, inactive",
  pcs: "PCS 2020 niveau 1 : 1 agriculteurs, 2 artisans-commerçants-chefs d'entreprise, 3 cadres, 4 professions intermédiaires, 5 employés, 6 ouvriers, none (jamais en emploi)",
  has_computer: "true si la persona a un ordinateur (Baromètre du numérique, par âge)",
  has_smartphone: "true si elle a un smartphone",
  has_tablet: "true si elle a une tablette",
  has_internet: "true si elle a internet à domicile",
  tech_adoption: "profil de Rogers : innovator, early_adopter, early_majority, late_majority, laggard",
  social_media: "usage des réseaux sociaux : none, occasional, daily, heavy",
};

// ─── Catalogues de variables du socle, par pays (contrat de pack pays) ────────

/** Singapour : variables communes (mêmes noms qu'en France) plus les variables propres au socle. */
export const SOCLE_VARS_SG = {
  work: ["age", "sex", "region", "town_size", "residency_status", "ethnicity"],
  profile: [...SOCLE_VARS.profile, "residency_status", "ethnicity", "religion", "home_language", "education", "dwelling", "planning_area", "nationality"],
} as const;

export const SOCLE_CODES_SG: Record<string, string[]> = {
  sex: ["F", "M"],
  activity_status: ["employed", "unemployed", "student", "retired", "inactive"],
  pcs: [...SSOC_CODES, "none"],
  tenure: [...SG_TENURES],
  household_type: ["alone", "couple_no_child", "couple_with_children", "single_parent", "with_parents", "other"],
  partner_status: ["none", "employed", "not_employed"],
  tech_adoption: ["innovator", "early_adopter", "early_majority", "late_majority", "laggard"],
  social_media: ["none", "occasional", "daily", "heavy"],
  region: ["CR", "ER", "NR", "NER", "WR"],
  residency_status: [...RESIDENCY],
  ethnicity: [...ETHNICITIES],
  religion: [...RELIGIONS],
  home_language: [...HOME_LANGUAGES],
  education: [...EDUCATION_LEVELS],
  dwelling: [...DWELLINGS],
  nationality: [...SG_NATIONALITIES],
};

export const SOCLE_VAR_DOCS_SG: Record<string, string> = {
  age: "age in years (18-79)",
  sex: "F or M",
  region: "planning region: CR (Central), ER (East), NR (North), NER (North-East), WR (West)",
  town_size: "planning area code (same value as planning_area)",
  planning_area: "planning area code (e.g. tampines, bedok, jurong_west)",
  household_type: "alone, couple_no_child, couple_with_children, single_parent, with_parents, other (unrelated people, dormitory, live-in employer)",
  tenure: "owner, owner_mortgage, renter_private (renting a flat or a room on the open market), renter_social (HDB public rental), free (with parents, employer-provided, dormitory)",
  children_under_12: "number of children under 12 in the household",
  partner_status: "none, employed, not_employed",
  living_standard_ratio: "living standard / national median (≈ 1 = median)",
  living_standard: "monthly living standard in S$ per adult-equivalent",
  monthly_income: "personal net monthly income in S$ (after employee CPF)",
  activity_status: "employed, unemployed, student, retired, inactive (full-time National Servicemen: inactive)",
  pcs: "SSOC 2020 major group: 1 managers, 2 professionals, 3 associate professionals and technicians, 4 clerical, 5 service and sales, 6 agriculture and fishery, 7 craft and trades, 8 plant and machine operators, 9 cleaners and labourers; none",
  has_computer: "true if the persona has a computer",
  has_smartphone: "true if they have a smartphone",
  has_tablet: "true if they have a tablet",
  has_internet: "true if they have home internet",
  tech_adoption: "Rogers profile: innovator, early_adopter, early_majority, late_majority, laggard",
  social_media: "social media use: none, occasional, daily, heavy",
  residency_status: "citizen, pr, ep (Employment Pass), spass (S Pass), wp (Work Permit), mdw (migrant domestic worker), dependant, student",
  ethnicity: "chinese, malay, indian, others",
  religion: "buddhism, taoism, christianity, islam, hinduism, sikhism, other, none",
  home_language: "language most spoken at home: english, mandarin, chinese_dialects, malay, tamil, other_indian, other",
  education: "highest qualification: below_secondary, secondary, post_secondary, diploma, degree",
  dwelling: "hdb_1_2, hdb_3, hdb_4, hdb_5_exec, condo, landed, dormitory, other",
  nationality: "singapore for citizens; drawn nationality for non-residents (western = Europe, North America, Australia/NZ; east_asia = Japan, Korea…); null for PRs (not drawn)",
};

/** Catalogue des variables du socle d'un pays (« fr-enfants » → France). */
export function socleCatalog(socle: string): { vars: { work: readonly string[]; profile: readonly string[] }; codes: Record<string, string[]>; docs: Record<string, string> } {
  return socle.replace(/-.*$/, "") === "sg"
    ? { vars: SOCLE_VARS_SG, codes: SOCLE_CODES_SG, docs: SOCLE_VAR_DOCS_SG }
    : { vars: SOCLE_VARS, codes: SOCLE_CODES, docs: SOCLE_VAR_DOCS };
}

/** Lint structuré (zod puis sémantique) d'un module brut, sans lever. */
export function lintModule(raw: unknown): Array<{ path: string; message: string }> {
  const parsed = moduleSchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return semanticErrors(parsed.data).map((m) => {
    const at = /^(attribut « [^»]+ »|table « [^»]+ »|card|segment « [^»]+ »|socle_overrides\.[a-z_]+|validation\.[a-z_]+)/.exec(m);
    return { path: at ? at[1]! : "", message: m };
  });
}

/** Variables du socle utilisables en validation (lues sur la persona enregistrée). */
const SOCLE_VALIDATION_VARS = ["monthly_income", "age", "sex", "region", "town_size"];

export class ModuleError extends Error {
  override name = "ModuleError";
}

export interface LoadedModule {
  def: ModuleDef;
  file: string;
  attrs: Map<string, ModuleAttribute>;
}

function formatZod(err: z.ZodError): string {
  return err.issues.map((i) => `  - ${i.path.length ? i.path.join(".") : "(racine)"} : ${i.message}`).join("\n");
}

/** Lit et valide un fichier de module (YAML). Lève une ModuleError lisible. */
export function loadModuleFile(file: string): LoadedModule {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ModuleError(`Module ${file} : YAML illisible : ${(err as Error).message}`);
  }
  return checkModule(raw, file);
}

export function checkModule(raw: unknown, file = "(en mémoire)"): LoadedModule {
  const parsed = moduleSchema.safeParse(raw);
  if (!parsed.success) throw new ModuleError(`Module ${file} invalide :\n${formatZod(parsed.error)}`);
  const def = parsed.data;
  const errors = semanticErrors(def);
  if (errors.length) throw new ModuleError(`Module ${def.id} (${file}) invalide :\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  return { def, file, attrs: new Map(def.attributes.map((a) => [a.key, a])) };
}

/** Références d'attributs d'une expression ou d'une condition (pour l'ordre de tirage). */
export function exprRefs(e: Expr, def: ModuleDef, out = new Set<string>()): Set<string> {
  if (typeof e === "number") return out;
  const o = e as Record<string, unknown>;
  if ("attr" in o) out.add(o.attr as string);
  if ("lookup" in o) out.add(o.by as string);
  if ("pick" in o) out.add(o.pick as string);
  if ("if" in o) {
    condRefs(o.if as Condition, def, out);
    exprRefs(o.then as Expr, def, out);
    exprRefs(o.else as Expr, def, out);
  }
  if ("cases" in o) {
    for (const c of o.cases as Array<Record<string, unknown>>) {
      if ("when" in c) condRefs(c.when as Condition, def, out);
      exprRefs(("value" in c ? c.value : c.else) as Expr, def, out);
    }
  }
  for (const k of ["mul", "add", "min", "max", "div"]) if (k in o) for (const x of o[k] as Expr[]) exprRefs(x, def, out);
  for (const k of ["exp", "round", "bernoulli"]) if (k in o) exprRefs(o[k] as Expr, def, out);
  if ("round_to" in o) exprRefs(o.value as Expr, def, out);
  if ("lognormal" in o) {
    const l = o.lognormal as { median: Expr; sigma: Expr };
    exprRefs(l.median, def, out);
    exprRefs(l.sigma, def, out);
  }
  return out;
}

export function condRefs(c: Condition, def: ModuleDef, out = new Set<string>(), seen = new Set<string>()): Set<string> {
  if (typeof c === "string") {
    if (seen.has(c)) return out;
    seen.add(c);
    const named = def.conditions[c];
    if (named) condRefs(named, def, out, seen);
    return out;
  }
  if ("attr" in c) out.add(c.attr);
  if ("all" in c) for (const x of c.all) condRefs(x, def, out, seen);
  if ("any" in c) for (const x of c.any) condRefs(x, def, out, seen);
  if ("not" in c) condRefs(c.not, def, out, seen);
  return out;
}

function attrRefs(a: ModuleAttribute, def: ModuleDef): Set<string> {
  const out = new Set<string>();
  if (a.when) condRefs(a.when, def, out);
  if (a.type === "enum") {
    const g = a.distribution.given;
    for (const x of g === undefined ? [] : Array.isArray(g) ? g : [g]) out.add(x);
    for (const w of Object.values(a.distribution.weights ?? {})) exprRefs(w as Expr, def, out);
  }
  if (a.type === "number") exprRefs(a.value, def, out);
  if (a.type === "boolean") exprRefs((a.rate ?? a.value)!, def, out);
  if (a.type === "set") {
    for (const it of a.items) {
      if (typeof it.rate === "object" && it.rate !== null && "base" in it.rate) {
        for (const c of Object.keys((it.rate as { factors: Record<string, number> }).factors)) condRefs(c, def, out);
      } else exprRefs(it.rate as Expr, def, out);
    }
  }
  return out;
}

function namedCondsUsed(c: Condition | undefined, def: ModuleDef, out: Set<string>) {
  if (c === undefined) return;
  if (typeof c === "string") {
    out.add(c);
    if (def.conditions[c]) namedCondsUsed(def.conditions[c], def, out);
    return;
  }
  if ("all" in c) c.all.forEach((x) => namedCondsUsed(x, def, out));
  if ("any" in c) c.any.forEach((x) => namedCondsUsed(x, def, out));
  if ("not" in c) namedCondsUsed(c.not, def, out);
}

function semanticErrors(def: ModuleDef): string[] {
  const errs: string[] = [];
  const keys = new Set<string>();
  for (const a of def.attributes) {
    if (keys.has(a.key)) errs.push(`attribut « ${a.key} » déclaré deux fois`);
    keys.add(a.key);
  }
  const provenance = (what: string, p: { sources: string[]; assumption: boolean; justification?: string | undefined }) => {
    for (const s of p.sources) if (!def.sources[s]) errs.push(`${what} : source « ${s} » absente de \`sources\``);
    if (!p.assumption && p.sources.length === 0) errs.push(`${what} : ni source citée ni \`assumption: true\``);
    if (p.assumption && !p.justification) errs.push(`${what} : hypothèse sans \`justification\``);
  };
  for (const [name, t] of Object.entries(def.tables)) provenance(`table « ${name} »`, t);

  // Ordre de tirage = ordre de déclaration : une référence doit viser un attribut déjà tiré.
  const drawn = new Map<string, ModuleAttribute>();
  const phaseRank = { work: 0, profile: 1 } as const;
  const enumCodes = (key: string) => {
    const a = drawn.get(key) ?? def.attributes.find((x) => x.key === key);
    return a?.type === "enum" ? new Set(a.values.map((v) => v.code)) : a?.type === "set" ? new Set(a.items.map((i) => i.code)) : null;
  };
  // Variables et codes du socle : ceux des pays visés par `applies_to` (France seule : catalogue historique).
  const catalogs = [...new Set(def.applies_to.map((x) => x.replace(/-.*$/, "")))].map(socleCatalog);
  const phaseVars = (phase: "work" | "profile") => [...new Set(catalogs.flatMap((c) => [...c.vars[phase]]))];
  const socleCodes = (v: string) => {
    const lists = catalogs.map((c) => c.codes[v]).filter((x): x is string[] => Boolean(x));
    return lists.length ? [...new Set(lists.flat())] : undefined;
  };
  const checkRef = (ref: string, a: ModuleAttribute, what: string) => {
    if (ref.startsWith("socle.")) {
      const v = ref.slice(6);
      if (!phaseVars(a.phase).includes(v)) {
        errs.push(`${what} : variable du socle « ${v} » indisponible en phase ${a.phase} (disponibles : ${phaseVars(a.phase).join(", ")})`);
      }
      return;
    }
    if (ref.includes(".")) return; // autre module : vérifié à la résolution
    const target = drawn.get(ref);
    if (!target) {
      errs.push(`${what} : « ${ref} » n'est pas un attribut déclaré avant lui (l'ordre de déclaration est l'ordre de tirage)`);
      return;
    }
    if (phaseRank[target.phase] > phaseRank[a.phase]) errs.push(`${what} : dépend de « ${ref} », tiré dans une phase ultérieure`);
  };

  const lookupErrs = new Set<string>();
  for (const a of def.attributes) {
    const what = `attribut « ${a.key} »`;
    provenance(what, a);
    for (const ref of attrRefs(a, def)) checkRef(ref, a, what);
    const used = new Set<string>();
    namedCondsUsed(a.when, def, used);
    if (a.type === "set") for (const it of a.items) if (typeof it.rate === "object" && "base" in it.rate) for (const c of Object.keys(it.rate.factors)) used.add(c);
    walkConds(a, (c) => namedCondsUsed(c, def, used));
    for (const c of used) if (!def.conditions[c]) errs.push(`${what} : condition « ${c} » non déclarée dans \`conditions\``);
    walkLookups(a, (table, by) => {
      const t = def.tables[table];
      if (!t) return lookupErrs.add(`${what} : table « ${table} » non déclarée dans \`tables\``);
      if (t.values && !by.startsWith("socle.")) {
        const codes = enumCodes(by);
        // Une table peut ne couvrir que les valeurs utiles (lecture sous condition) ; une clé inconnue est une erreur.
        if (codes) for (const k of Object.keys(t.values)) if (!codes.has(k)) lookupErrs.add(`table « ${table} » : « ${k} » n'est pas une valeur de ${by}`);
      }
      if (t.bands && !by.startsWith("socle.")) lookupErrs.add(`table « ${table} » : des tranches (bands) se lisent sur une variable numérique du socle`);
    });
    if (a.type === "enum") {
      const codes = new Set(a.values.map((v) => v.code));
      const d = a.distribution;
      const check = (w: Record<string, unknown>, where: string) => {
        for (const c of Object.keys(w)) if (!codes.has(c)) errs.push(`${what} : valeur « ${c} » inconnue dans ${where}`);
        const nums = Object.values(w).filter((x): x is number => typeof x === "number");
        if (nums.length === Object.keys(w).length && nums.every((x) => x <= 0)) errs.push(`${what} : poids tous nuls dans ${where}`);
      };
      if (d.weights) check(d.weights, "weights");
      if (d.table) {
        const givens = Array.isArray(d.given) ? d.given : [d.given!];
        // Table imbriquée : un niveau par attribut de `given`, des poids numériques aux feuilles.
        const walk = (node: unknown, depth: number, path: string) => {
          if (!node || typeof node !== "object") return errs.push(`${what} : table.${path} n'est pas un objet`);
          const g = givens[depth]!;
          if (depth === givens.length - 1) {
            for (const [k, w] of Object.entries(node)) {
              if (!w || typeof w !== "object" || Object.values(w).some((x) => typeof x !== "number" || x < 0)) {
                errs.push(`${what} : table.${path}${k} doit donner des poids numériques positifs`);
              } else check(w as Record<string, number>, `table.${path}${k}`);
            }
          } else for (const [k, sub] of Object.entries(node)) walk(sub, depth + 1, `${path}${k}.`);
          const givenCodes = !g.includes(".") ? enumCodes(g) : g.startsWith("socle.") && socleCodes(g.slice(6)) ? new Set(socleCodes(g.slice(6))) : null;
          if (givenCodes) {
            for (const k of Object.keys(node)) if (k !== "default" && !givenCodes.has(k)) errs.push(`${what} : la table cite « ${k} », valeur inconnue de ${g}`);
            // Avec une condition de présence (`when`), certaines valeurs n'arrivent jamais : pas de ligne exigée.
            if (!("default" in node) && !a.when) for (const c of givenCodes) if (!(c in node)) errs.push(`${what} : pas de ligne pour ${g} = « ${c} » (ni \`default\`)`);
          }
        };
        walk(d.table, 0, "");
      }
    }
    drawn.set(a.key, a);
  }

  errs.push(...lookupErrs);

  // Remplacements du socle
  const so = def.socle_overrides;
  if (so) {
    const inc = def.attributes.find((x) => x.key === so.monthly_income.attr);
    if (so.activity_status && so.pcs && so.occupation_label !== undefined) {
      // Packs v1 : situation professionnelle complète, tirée en phase work
      for (const [field, spec] of [["activity_status", so.activity_status], ["pcs", so.pcs]] as const) {
        const a = def.attributes.find((x) => x.key === spec.from);
        if (a?.type !== "enum" || a.phase !== "work") errs.push(`socle_overrides.${field} : « ${spec.from} » doit être un enum de phase work`);
        else for (const v of a.values) if (!v.socle?.[spec.field]) errs.push(`socle_overrides.${field} : la valeur « ${v.code} » n'a pas de correspondance socle.${spec.field}`);
      }
      if (inc?.type !== "number" || inc.phase !== "work") errs.push(`socle_overrides.monthly_income : « ${so.monthly_income.attr} » doit être un nombre de phase work`);
      for (const k of placeholders(so.occupation_label)) if (!keys.has(k)) errs.push(`socle_overrides.occupation_label : « {${k}} » inconnu`);
      if (so.monthly_income.when) errs.push("socle_overrides.monthly_income.when : réservé au socle v2 (revenu seul)");
    } else {
      // Socle v2 : revenu seul, recalcul du budget après les modules
      if (inc?.type !== "number") errs.push(`socle_overrides.monthly_income : « ${so.monthly_income.attr} » doit être un attribut nombre`);
      if (so.monthly_income.when) {
        const refs = condRefs(so.monthly_income.when, def);
        for (const r of refs) if (!r.includes(".") && !keys.has(r) && !def.conditions[r]) errs.push(`socle_overrides.monthly_income.when : « ${r} » inconnu`);
      }
    }
  }
  for (const a of def.attributes) {
    if (a.type !== "set" || a.affects_budget === undefined || a.affects_budget === false) continue;
    if (!a.items.some((i) => i.subscription)) errs.push(`attribut « ${a.key} » : affects_budget sans aucune option portant un \`subscription\``);
  }

  // Fiche, segments, validation
  for (const line of def.card) {
    const tpl = typeof line === "string" ? line : line.template;
    for (const k of placeholders(tpl)) if (!keys.has(k)) errs.push(`card : « {${k}} » n'est pas un attribut du module`);
    if (typeof line !== "string") {
      const used = new Set<string>();
      namedCondsUsed(line.when, def, used);
      for (const c of used) if (!def.conditions[c]) errs.push(`card : condition « ${c} » non déclarée`);
    }
  }
  const segIds = new Set<string>();
  for (const s of def.segments) {
    if (segIds.has(s.id)) errs.push(`segment « ${s.id} » déclaré deux fois`);
    segIds.add(s.id);
    const a = def.attributes.find((x) => x.key === s.attribute);
    if (a?.type !== "enum") errs.push(`segment « ${s.id} » : « ${s.attribute} » doit être un attribut enum`);
  }
  for (const m of def.validation.margins) {
    const a = def.attributes.find((x) => x.key === m.attribute);
    if (a?.type !== "enum") errs.push(`validation.margins : « ${m.attribute} » doit être un attribut enum`);
  }
  for (const sh of def.validation.shares) {
    const used = new Set<string>();
    for (const c of [sh.share_of, sh.among]) if (c !== undefined) namedCondsUsed(c, def, used);
    for (const c of used) if (!def.conditions[c]) errs.push(`validation.shares : condition « ${c} » non déclarée (« ${sh.label} »)`);
  }
  for (const p of def.validation.plausibility) {
    if (p.value.startsWith("socle.") ? !SOCLE_VALIDATION_VARS.includes(p.value.slice(6)) : !keys.has(p.value)) {
      errs.push(`validation.plausibility : valeur « ${p.value} » inconnue`);
    }
    if (def.attributes.find((x) => x.key === p.group_by)?.type !== "enum") errs.push(`validation.plausibility : group_by « ${p.group_by} » doit être un enum`);
    if (p.median_vs_table && !def.tables[p.median_vs_table.table]) errs.push(`validation.plausibility : table « ${p.median_vs_table.table} » inconnue`);
  }
  return errs;
}

export function placeholders(tpl: string): string[] {
  return [...tpl.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]!);
}

function walkExpr(e: Expr, onExpr: (o: Record<string, unknown>) => void, onCond: (c: Condition) => void) {
  if (typeof e === "number") return;
  const o = e as Record<string, unknown>;
  onExpr(o);
  if ("if" in o) {
    onCond(o.if as Condition);
    walkExpr(o.then as Expr, onExpr, onCond);
    walkExpr(o.else as Expr, onExpr, onCond);
  }
  if ("cases" in o)
    for (const c of o.cases as Array<Record<string, unknown>>) {
      if ("when" in c) onCond(c.when as Condition);
      walkExpr(("value" in c ? c.value : c.else) as Expr, onExpr, onCond);
    }
  for (const k of ["mul", "add", "min", "max", "div"]) if (k in o) for (const x of o[k] as Expr[]) walkExpr(x, onExpr, onCond);
  for (const k of ["exp", "round", "bernoulli"]) if (k in o) walkExpr(o[k] as Expr, onExpr, onCond);
  if ("round_to" in o) walkExpr(o.value as Expr, onExpr, onCond);
  if ("lognormal" in o) {
    const l = o.lognormal as { median: Expr; sigma: Expr };
    walkExpr(l.median, onExpr, onCond);
    walkExpr(l.sigma, onExpr, onCond);
  }
}

function attrExprs(a: ModuleAttribute): Expr[] {
  if (a.type === "number") return [a.value];
  if (a.type === "boolean") return [(a.rate ?? a.value)!];
  if (a.type === "enum") return Object.values(a.distribution.weights ?? {}).filter((w): w is Expr => typeof w !== "number");
  if (a.type === "set") return a.items.flatMap((it) => (typeof it.rate === "object" && "base" in it.rate ? [] : [it.rate as Expr]));
  return [];
}

function walkConds(a: ModuleAttribute, onCond: (c: Condition) => void) {
  for (const e of attrExprs(a)) walkExpr(e, () => {}, onCond);
}

function walkLookups(a: ModuleAttribute, on: (table: string, by: string) => void) {
  for (const e of attrExprs(a)) walkExpr(e, (o) => ("lookup" in o ? on(o.lookup as string, o.by as string) : undefined), () => {});
}

// ── Bibliothèque et résolution des dépendances ─────────────────────────────

/** Racine de la bibliothèque (surchargeable par PERSONAS_MODULES_DIR, pour les tests). */
export function modulesRoot(): string {
  return process.env.PERSONAS_MODULES_DIR ?? MODULES_DIR;
}

const libraries = new Map<string, Map<string, LoadedModule>>();

/**
 * Tous les modules de la bibliothèque (`modules/<id>/module.yaml`), chargés une fois par processus
 * (`fresh` : relecture, après la validation d'un brouillon). Les dossiers commençant par « _ » (brouillons) sont ignorés.
 */
/** Dossier des modules archivés, sous la racine des modules. */
export const ARCHIVE_DIR = "_archive";

/** Module archivé : lisible pour l'historique, absent de la bibliothèque proposée, des filtres et des cibles. */
export const isLegacy = (m: LoadedModule) => m.def.status === "legacy";

/** Modules actifs seulement (bibliothèque proposée : assistant, catalogues, cibles). */
export function activeLibrary(dir = modulesRoot()): Map<string, LoadedModule> {
  return new Map([...moduleLibrary(dir)].filter(([, m]) => !isLegacy(m)));
}

export function moduleLibrary(dir = modulesRoot(), opts: { fresh?: boolean } = {}): Map<string, LoadedModule> {
  const cached = libraries.get(dir);
  if (cached && !opts.fresh) return cached;
  const out = new Map<string, LoadedModule>();
  // Modules actifs, puis modules archivés (modules/_archive) : ceux-ci restent chargés pour relire les
  // personas et les études historiques, avec le statut legacy (voir isLegacy).
  for (const [root, legacy] of [[dir, false], [resolve(dir, ARCHIVE_DIR), true]] as const) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith("_")) continue;
      const file = resolve(root, d.name, "module.yaml");
      if (!existsSync(file)) continue;
      const m = loadModuleFile(file);
      if (m.def.id !== d.name) throw new ModuleError(`Module ${file} : l'id « ${m.def.id} » doit être le nom du dossier (« ${d.name} »)`);
      if (legacy) m.def.status = "legacy";
      if (out.has(m.def.id)) throw new ModuleError(`Module « ${m.def.id} » à la fois actif et archivé`);
      out.set(m.def.id, m);
    }
  }
  // Ordre alphabétique des identifiants, archivés compris (ordre historique des segments et des fiches)
  const sorted = new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  libraries.set(dir, sorted);
  return sorted;
}

export interface ResolvedModules {
  /** Modules dans l'ordre de tirage (dépendances d'abord). */
  ordered: LoadedModule[];
  /** Dimension quasi aléatoire attribuée à chaque attribut `sampler: quasi` (clé « module.attr »). */
  quasiDims: Map<string, number>;
}

/**
 * Résout une liste de modules activés : ajoute les dépendances, vérifie la compatibilité avec le
 * socle, refuse les cycles, ordonne (tri topologique stable) et numérote les dimensions quasi aléatoires.
 */
export function resolveModules(ids: string[], socle: string, lib: Map<string, LoadedModule> = moduleLibrary()): ResolvedModules {
  const ordered: LoadedModule[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]) => {
    const st = state.get(id);
    if (st === "done") return;
    if (st === "visiting") throw new ModuleError(`Dépendances circulaires entre modules : ${[...path, id].join(" → ")}`);
    const m = lib.get(id);
    if (!m) throw new ModuleError(`Module « ${id} » introuvable${path.length ? ` (requis par ${path.at(-1)})` : ""}`);
    if (!m.def.applies_to.includes(socle)) {
      throw new ModuleError(`Module « ${id} » non compatible avec le socle « ${socle} » (applies_to : ${m.def.applies_to.join(", ")})`);
    }
    state.set(id, "visiting");
    for (const dep of m.def.requires) visit(dep, [...path, id]);
    state.set(id, "done");
    ordered.push(m);
  };
  for (const id of ids) visit(id, []);

  // Références inter-modules : le module visé doit être tiré avant, et l'attribut doit exister.
  const seen = new Set<string>();
  for (const m of ordered) {
    for (const a of m.def.attributes) {
      for (const ref of attrRefs(a, m.def)) {
        if (ref.startsWith("socle.") || !ref.includes(".")) continue;
        const [mid, key] = [ref.slice(0, ref.lastIndexOf(".")), ref.slice(ref.lastIndexOf(".") + 1)];
        if (!seen.has(mid)) throw new ModuleError(`Module « ${m.def.id} », attribut « ${a.key} » : « ${ref} » vise un module absent de \`requires\` ou tiré après`);
        if (!lib.get(mid)!.attrs.has(key)) throw new ModuleError(`Module « ${m.def.id} » : « ${ref} » n'existe pas`);
      }
    }
    seen.add(m.def.id);
  }
  const overriding = ordered.filter((m) => m.def.socle_overrides);
  if (overriding.length > 1) {
    throw new ModuleError(`Un seul module peut remplacer la situation professionnelle du socle (${overriding.map((m) => m.def.id).join(", ")})`);
  }

  const quasiDims = new Map<string, number>();
  let dim = 0;
  for (const phase of ["work", "profile"] as const) {
    for (const m of ordered) {
      for (const a of m.def.attributes) {
        if (a.phase === phase && a.type === "enum" && a.distribution.sampler === "quasi") quasiDims.set(`${m.def.id}.${a.key}`, dim++);
      }
    }
  }
  return { ordered, quasiDims };
}

/** Segments déclarés par tous les modules de la bibliothèque (dimension → module, attribut). */
/**
 * Segments déclarés par les modules, archivés compris (les résumés des études historiques en ont besoin) ;
 * `legacy: true` pour ceux d'un module archivé (à exclure des filtres et des propositions).
 */
export function librarySegments(lib = moduleLibrary()) {
  const out: Array<{ id: string; label: string; module: string; attribute: string; compare?: number; legacy?: true }> = [];
  for (const m of lib.values()) {
    for (const s of m.def.segments) {
      if (out.some((x) => x.id === s.id)) throw new ModuleError(`Dimension « ${s.id} » déclarée par deux modules`);
      out.push({ id: s.id, label: s.label, module: m.def.id, attribute: s.attribute, ...(s.compare !== undefined && { compare: s.compare }), ...(isLegacy(m) && { legacy: true as const }) });
    }
  }
  return out;
}
