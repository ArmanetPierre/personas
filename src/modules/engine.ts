import type { PersonaSubscription } from "../db/schema";
import { quasiUniform, quasiUniformKeyed, weightedByU, type Rng } from "../personas/rng";
import type { LoadedModule, ResolvedModules } from "./registry";
import type { Condition, EnumAttribute, Expr, ModuleAttribute, ModuleDef } from "./schema";

/**
 * Moteur générique : tirage des attributs de modules, rendu de la fiche, libellés.
 * Les calculs suivent l'ordre de déclaration ; chaque primitive aléatoire consomme le générateur
 * de la persona dans cet ordre, ce qui rend le tirage déterministe (graine, rang).
 */

export type ModuleValue = string | number | boolean | string[] | null;
/** Valeurs tirées, par module puis par attribut (stockées dans `extra.modules`). */
export type ModuleValues = Record<string, Record<string, ModuleValue>>;

export interface DrawContext {
  rng: Rng;
  /**
   * Flux aléatoire propre à chaque module (graine, rang, module) : ajouter ou retirer un module ne
   * change ni le socle ni les autres modules. Absent : tous les modules partagent `rng` (packs v1).
   */
  rngFor?: (moduleId: string) => Rng;
  seed: number;
  index: number;
  /** Variables du socle disponibles (voir SOCLE_VARS). */
  socle: Record<string, string | number | null>;
}

export interface Scope {
  module: LoadedModule;
  values: ModuleValues;
  socle: Record<string, string | number | null>;
  rng: Rng | null;
}

function readRef(scope: Scope, ref: string): ModuleValue | undefined {
  if (ref.startsWith("socle.")) return scope.socle[ref.slice(6)] ?? null;
  const dot = ref.lastIndexOf(".");
  if (dot === -1) return scope.values[scope.module.def.id]?.[ref];
  // `alias.attr` (forme longue de `requires`) : l'alias désigne la référence canonique du module visé
  const prefix = ref.slice(0, dot);
  return scope.values[scope.module.aliases?.get(prefix) ?? prefix]?.[ref.slice(dot + 1)];
}

export function evalCondition(c: Condition, scope: Scope): boolean {
  if (typeof c === "string") {
    const named = scope.module.def.conditions[c];
    if (!named) throw new Error(`Condition inconnue : ${c}`);
    return evalCondition(named, scope);
  }
  if ("all" in c) return c.all.every((x) => evalCondition(x, scope));
  if ("any" in c) return c.any.some((x) => evalCondition(x, scope));
  if ("not" in c) return !evalCondition(c.not, scope);
  const v = readRef(scope, c.attr);
  if (c.present !== undefined) return (v !== null && v !== undefined) === c.present;
  if (c.in !== undefined) return Array.isArray(v) ? v.some((x) => c.in!.includes(x)) : c.in.includes(v as string | number | boolean);
  if (c.eq !== undefined) return v === c.eq;
  if (c.lt !== undefined) return typeof v === "number" && v < c.lt;
  if (c.gt !== undefined) return typeof v === "number" && v > c.gt;
  return false;
}

function lookup(scope: Scope, table: string, by: string): number {
  const t = scope.module.def.tables[table];
  if (!t) throw new Error(`Table inconnue : ${table}`);
  const key = readRef(scope, by);
  if (t.values) {
    const v = t.values[String(key)];
    if (v === undefined) throw new Error(`Table ${table} : pas de valeur pour « ${String(key)} »`);
    return v;
  }
  // Tranches : la valeur est ramenée dans les bornes de la table (comme findBandClamped).
  const bands = t.bands!;
  const lo = Math.min(...bands.map((b) => b.from));
  const hi = Math.max(...bands.map((b) => b.to));
  const x = Math.min(hi, Math.max(lo, Number(key)));
  const b = bands.find((b) => x >= b.from && x <= b.to);
  if (!b) throw new Error(`Table ${table} : aucune tranche pour ${x}`);
  return b.value;
}

/** Évalue une expression ; les opérandes sont évalués de gauche à droite (ordre de consommation du générateur). */
export function evalExpr(e: Expr, scope: Scope): number {
  if (typeof e === "number") return e;
  const rng = () => {
    if (!scope.rng) throw new Error("Primitive aléatoire hors tirage");
    return scope.rng;
  };
  if ("attr" in e) {
    const v = readRef(scope, e.attr);
    return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0;
  }
  if ("lookup" in e) return lookup(scope, e.lookup, e.by);
  if ("pick" in e) {
    const v = e.values[String(readRef(scope, e.pick))];
    return v ?? e.default ?? 0;
  }
  if ("mul" in e) return e.mul.map((x) => x).reduce<number | null>((acc, x) => (acc === null ? evalExpr(x, scope) : acc * evalExpr(x, scope)), null)!;
  if ("add" in e) return e.add.reduce<number | null>((acc, x) => (acc === null ? evalExpr(x, scope) : acc + evalExpr(x, scope)), null)!;
  if ("div" in e) {
    const a = evalExpr(e.div[0], scope);
    return a / evalExpr(e.div[1], scope);
  }
  if ("min" in e) return Math.min(...e.min.map((x) => evalExpr(x, scope)));
  if ("max" in e) return Math.max(...e.max.map((x) => evalExpr(x, scope)));
  if ("exp" in e) return Math.exp(evalExpr(e.exp, scope));
  if ("round" in e) return Math.round(evalExpr(e.round, scope));
  if ("round_to" in e) return Math.round(evalExpr(e.value, scope) / e.round_to) * e.round_to;
  if ("normal" in e) return rng().normal();
  if ("lognormal" in e) {
    const median = evalExpr(e.lognormal.median, scope);
    const sigma = evalExpr(e.lognormal.sigma, scope);
    return rng().logNormal(median, sigma);
  }
  if ("bernoulli" in e) return rng().bool(evalExpr(e.bernoulli, scope)) ? 1 : 0;
  if ("if" in e) return evalCondition(e.if, scope) ? evalExpr(e.then, scope) : evalExpr(e.else, scope);
  if ("cases" in e) {
    for (const c of e.cases) {
      if ("else" in c) return evalExpr(c.else, scope);
      if (evalCondition(c.when, scope)) return evalExpr(c.value, scope);
    }
    return 0;
  }
  throw new Error(`Expression inconnue : ${JSON.stringify(e)}`);
}

function rateOf(rate: unknown, scope: Scope): number {
  if (rate && typeof rate === "object" && "base" in rate) {
    const r = rate as { base: number; factors: Record<string, number> };
    let p = r.base;
    for (const [cond, f] of Object.entries(r.factors)) if (evalCondition(cond, scope)) p *= f;
    return p;
  }
  return evalExpr(rate as Expr, scope);
}

/** Poids d'un attribut enum pour une persona : table (imbriquée si plusieurs `given`) ou poids, évalués sans tirage. */
export function enumWeights(a: EnumAttribute, scope: Scope): Array<[string, number]> {
  const d = a.distribution;
  if (d.given !== undefined) {
    const givens = Array.isArray(d.given) ? d.given : [d.given];
    let node = d.table as Record<string, unknown>;
    for (const g of givens) {
      const key = String(readRef(scope, g));
      const next = (node[key] ?? node.default) as Record<string, unknown> | undefined;
      if (!next) throw new Error(`Attribut ${a.key} : pas de ligne pour ${g} = « ${key} » (ni default)`);
      node = next;
    }
    return Object.entries(node as Record<string, number>);
  }
  return Object.entries(d.weights!).map(([k, w]) => [k, typeof w === "number" ? w : Math.max(0, evalExpr(w, { ...scope, rng: null }))]);
}

function drawAttribute(a: ModuleAttribute, scope: Scope, ctx: DrawContext, rng: Rng, quasiU: () => number): { value: ModuleValue; subscriptions: PersonaSubscription[] } {
  if (a.when && !evalCondition(a.when, scope)) return { value: null, subscriptions: [] };
  switch (a.type) {
    case "enum": {
      const entries = enumWeights(a, scope);
      const value = a.distribution.sampler === "quasi" ? weightedByU(entries, quasiU()) : rng.weightedEntry(entries);
      return { value, subscriptions: [] };
    }
    case "set": {
      const chosen: string[] = [];
      const subscriptions: PersonaSubscription[] = [];
      const rates: Array<readonly [string, number]> = [];
      for (const it of a.items) {
        let p = rateOf(it.rate, scope);
        if (a.rate_cap !== undefined) p = Math.min(a.rate_cap, p);
        rates.push([it.code, p]);
        if (rng.bool(p)) chosen.push(it.code);
      }
      // Au moins `min_items` options (ex. un outil de visio dès qu'on fait de la visio) : complément tiré
      // au prorata des taux, seulement quand il en manque (tirage supplémentaire dans ce cas seulement).
      while (a.min_items !== undefined && chosen.length < a.min_items) {
        const left = rates.filter(([c, p]) => p > 0 && !chosen.includes(c));
        if (!left.length) break;
        chosen.push(rng.weightedEntry(left));
      }
      if (a.min_items !== undefined) chosen.sort((x, y) => a.items.findIndex((i) => i.code === x) - a.items.findIndex((i) => i.code === y));
      if (a.max_items !== undefined) while (chosen.length > a.max_items) chosen.splice(rng.int(0, chosen.length - 1), 1);
      for (const code of chosen) {
        const s = a.items.find((i) => i.code === code)!.subscription;
        if (s) subscriptions.push({ name: s.name, category: s.category, monthlyEur: s.monthly_eur });
      }
      return { value: chosen, subscriptions };
    }
    case "number":
      return { value: evalExpr(a.value, scope), subscriptions: [] };
    case "boolean":
      if (a.rate !== undefined) return { value: rng.bool(evalExpr(a.rate, { ...scope, rng: null })), subscriptions: [] };
      return { value: evalExpr(a.value!, scope) !== 0, subscriptions: [] };
  }
}

/**
 * Tire les attributs d'une phase pour tous les modules résolus, dans l'ordre de tirage.
 * Complète `values` en place et renvoie les abonnements ajoutés.
 */
export function drawPhase(resolved: ResolvedModules, phase: "work" | "profile", values: ModuleValues, ctx: DrawContext): PersonaSubscription[] {
  const subs: PersonaSubscription[] = [];
  for (const m of resolved.ordered) {
    const own = (values[m.def.id] ??= {});
    const rng = ctx.rngFor ? ctx.rngFor(m.def.id) : ctx.rng;
    const scope: Scope = { module: m, values, socle: ctx.socle, rng };
    let local = 0;
    for (const a of m.def.attributes) {
      if (a.phase !== phase) continue;
      const key = `${m.def.id}.${a.key}`;
      const isQuasi = a.type === "enum" && a.distribution.sampler === "quasi";
      const localDim = isQuasi ? local++ : 0;
      // Flux par module : dimension quasi aléatoire repérée par (module, attribut), indépendante des autres modules.
      const quasiU = () =>
        ctx.rngFor ? quasiUniformKeyed(ctx.seed, ctx.index, key, localDim) : quasiUniform(ctx.seed, ctx.index, resolved.quasiDims.get(key)!);
      const r = drawAttribute(a, scope, ctx, rng, quasiU);
      own[a.key] = r.value;
      subs.push(...r.subscriptions);
    }
  }
  return subs;
}

/** Situation professionnelle imposée par un module (`socle_overrides`), après la phase work. */
export function earnerOverride(resolved: ResolvedModules, values: ModuleValues, sex: "F" | "M") {
  const m = resolved.ordered.find((x) => x.def.socle_overrides?.activity_status);
  if (!m) return null;
  const so = m.def.socle_overrides as Required<NonNullable<ModuleDef["socle_overrides"]>>;
  const own = values[m.def.id] ?? {};
  const valueOf = (key: string) => (m.attrs.get(key) as EnumAttribute).values.find((v) => v.code === own[key]);
  return {
    activityStatus: valueOf(so.activity_status.from)!.socle![so.activity_status.field]!,
    pcs: valueOf(so.pcs.from)!.socle![so.pcs.field]!,
    income: Number(own[so.monthly_income.attr] ?? 0),
    partTime: so.part_time,
    taxable: so.taxable,
    occupationLabel: renderTemplate(m, so.occupation_label, own, sex),
  };
}

/**
 * Effets budgétaires des modules sur le socle v2 (après leur tirage) : revenu remplacé
 * (`socle_overrides.monthly_income`, sous condition éventuelle) et abonnements payés par la persona
 * (attributs `affects_budget`). Déterministe : lu dans les valeurs tirées. Null s'il n'y a rien à changer.
 */
export function moduleEconomics(
  resolved: ResolvedModules,
  values: ModuleValues,
  socle: Scope["socle"],
): { income: number | null; subscriptions: PersonaSubscription[]; modules: string[] } | null {
  let income: number | null = null;
  const subscriptions: PersonaSubscription[] = [];
  const modules = new Set<string>();
  for (const m of resolved.ordered) {
    const own = values[m.def.id];
    if (!own) continue;
    const scope: Scope = { module: m, values, socle, rng: null };
    const so = m.def.socle_overrides;
    if (so && !so.activity_status && (!so.monthly_income.when || evalCondition(so.monthly_income.when, scope))) {
      const v = own[so.monthly_income.attr];
      if (typeof v === "number" && Number.isFinite(v)) {
        income = v;
        modules.add(`${m.def.id}@${m.def.version}`);
      }
    }
    for (const a of m.def.attributes) {
      if (a.type !== "set" || !a.affects_budget) continue;
      if (typeof a.affects_budget === "object" && !evalCondition(a.affects_budget.when, scope)) continue;
      const chosen = own[a.key];
      if (!Array.isArray(chosen)) continue;
      for (const code of chosen as string[]) {
        const sub = a.items.find((i) => i.code === code)?.subscription;
        if (!sub) continue;
        subscriptions.push({ name: sub.name, category: sub.category, monthlyEur: sub.monthly_eur });
        modules.add(`${m.def.id}@${m.def.version}`);
      }
    }
  }
  return income === null && !subscriptions.length ? null : { income, subscriptions, modules: [...modules] };
}

// ── Libellés et fiche ──────────────────────────────────────────────────────

export function valueLabel(m: LoadedModule, key: string, code: string, sex: string): string | undefined {
  const a = m.attrs.get(key);
  if (a?.type === "enum") {
    const v = a.values.find((x) => x.code === code);
    if (!v) return undefined;
    return typeof v.label === "string" ? v.label : sex === "F" ? v.label.F : v.label.M;
  }
  if (a?.type === "set") return a.items.find((x) => x.code === code)?.label;
  return undefined;
}

const eur = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;
/** Module d'un socle anglophone (Singapour, États-Unis) : nombres et montants à l'anglaise, en S$ ou en $ ; France : rendu historique. */
const isUsModule = (m: LoadedModule) => m.def.applies_to.some((x) => x.replace(/-.*$/, "") === "us");
const isEnModule = (m: LoadedModule) => isUsModule(m) || m.def.applies_to.some((x) => x.replace(/-.*$/, "") === "sg");
const sgd = (n: number) => `S$${Math.round(n).toLocaleString("en-SG")}`;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Rendu d'un attribut sur la fiche (libellés, format, gabarit, valeur vide). */
export function renderAttribute(m: LoadedModule, key: string, value: ModuleValue | undefined, sex: string): string {
  const a = m.attrs.get(key)!;
  const d = a.display;
  const isEmpty = value === null || value === undefined || value === 0 || value === false || (Array.isArray(value) && value.length === 0);
  if (isEmpty && d?.empty !== undefined) return d.empty;
  let text: string;
  if (Array.isArray(value)) {
    const items = a.type === "set" ? a.items : [];
    text = value.map((c) => items.find((i) => i.code === c)?.card_label ?? items.find((i) => i.code === c)?.label ?? c).join(d?.separator ?? ", ");
  } else if (typeof value === "number") {
    if (isUsModule(m)) text = d?.format === "eur" ? usd(value) : d?.format === "percent" ? `${Math.round(value * 100)}%` : value.toLocaleString("en-US");
    else if (isEnModule(m)) text = d?.format === "eur" ? sgd(value) : d?.format === "percent" ? `${Math.round(value * 100)}%` : value.toLocaleString("en-SG");
    else text = d?.format === "eur" ? eur(value) : d?.format === "percent" ? `${Math.round(value * 100)} %` : value.toLocaleString("fr-FR");
  } else if (typeof value === "boolean") {
    const [yes, no] = isEnModule(m) ? ["yes", "no"] : ["oui", "non"];
    text = a.type === "boolean" && a.labels ? (value ? a.labels.yes : a.labels.no) : value ? yes : no;
  } else if (typeof value === "string") {
    text = valueLabel(m, key, value, sex) ?? value;
  } else {
    text = "";
  }
  const tpl = d?.template && typeof value === "number" && Math.abs(value) <= 1 && !d.format && !isEnModule(m) ? singularAfterValue(d.template) : d?.template;
  return tpl ? tpl.replace("{value}", text) : text;
}

/** Mots invariables en « s » : jamais mis au singulier. */
const INVARIABLE = new Set(["fois", "mois", "pays", "temps", "cours", "prix", "repas", "gens", "des", "les", "ses", "mes", "tes", "nos", "vos", "leurs", "plus", "moins"]);

/**
 * Accord : « environ {value} réunions par semaine » avec une valeur ≤ 1 → « réunion ».
 * Seul le premier mot qui suit la valeur est accordé (pluriel régulier en -s ou -x).
 */
export function singularAfterValue(tpl: string): string {
  return tpl.replace(/\{value\}(\s+)(\p{L}+)/u, (all, sp: string, w: string) => {
    if (INVARIABLE.has(w.toLowerCase()) || w.length < 3) return all;
    if (/aux$/.test(w)) return `{value}${sp}${w.slice(0, -3)}al`;
    if (/[sx]$/.test(w)) return `{value}${sp}${w.slice(0, -1)}`;
    return all;
  });
}

export function renderTemplate(m: LoadedModule, tpl: string, own: Record<string, ModuleValue>, sex: string): string {
  return tpl.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k: string) => renderAttribute(m, k, own[k], sex));
}

/** Lignes de fiche de tous les modules résolus, pour une persona. */
/**
 * `socle` : variables du socle de la persona (`socleVars`), nécessaires aux conditions de ligne qui
 * portent sur le socle (ex. `employed`). Sans elles, ces conditions sont fausses et la ligne disparaît.
 */
export function cardLines(resolved: ResolvedModules, values: ModuleValues | undefined, sex: string, socle: Scope["socle"] = {}): Array<{ module: LoadedModule; line: string }> {
  if (!values) return [];
  const out: Array<{ module: LoadedModule; line: string }> = [];
  for (const m of resolved.ordered) {
    const own = values[m.def.id];
    if (!own) continue;
    const scope: Scope = { module: m, values, socle, rng: null };
    for (const line of m.def.card) {
      if (typeof line !== "string" && !evalCondition(line.when, scope)) continue;
      out.push({ module: m, line: renderTemplate(m, typeof line === "string" ? line : line.template, own, sex) });
    }
  }
  return out;
}

// ── Marges théoriques (validation) ─────────────────────────────────────────

/**
 * Distribution marginale théorique d'un attribut enum, en déroulant ses conditionnements
 * sur d'autres attributs enum du même module (null si elle dépend du socle ou d'un tirage non enum).
 */
export function theoreticalMargin(def: ModuleDef, key: string, seen = new Set<string>()): Record<string, number> | null {
  const a = def.attributes.find((x) => x.key === key);
  if (a?.type !== "enum" || seen.has(key) || a.when) return null;
  if (Array.isArray(a.distribution.given)) return null;
  if (a.distribution.weights && Object.values(a.distribution.weights).some((w) => typeof w !== "number")) return null;
  const norm = (w: Record<string, number>) => {
    const t = Object.values(w).reduce((s, x) => s + x, 0);
    return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / t]));
  };
  const d = a.distribution;
  if (!d.given) return norm(d.weights as Record<string, number>);
  const given = d.given as string;
  if (given.includes(".")) return null;
  const parent = theoreticalMargin(def, given, new Set([...seen, key]));
  if (!parent) return null;
  const table = d.table as Record<string, Record<string, number>>;
  const out: Record<string, number> = {};
  for (const [g, pg] of Object.entries(parent)) {
    const row = norm(table[g] ?? table.default!);
    for (const [v, pv] of Object.entries(row)) out[v] = (out[v] ?? 0) + pg * pv;
  }
  return out;
}

/**
 * Distribution attendue d'un attribut pour une persona donnée (poids ou taux évalués sur ses propres
 * attributs, sans tirage). Sert à valider les marges d'attributs conditionnés au socle : la marge
 * attendue d'une base est la moyenne de ces distributions. null si l'attribut est absent pour elle.
 */
export function expectedDistribution(
  m: LoadedModule,
  key: string,
  values: ModuleValues,
  socle: Record<string, string | number | null>,
): Record<string, number> | null {
  const a = m.attrs.get(key);
  if (!a) return null;
  const scope: Scope = { module: m, values, socle, rng: null };
  if (a.when && !evalCondition(a.when, scope)) return null;
  if (a.type === "enum") {
    const entries = enumWeights(a, scope);
    const t = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
    return t > 0 ? Object.fromEntries(entries.map(([k, w]) => [k, Math.max(0, w) / t])) : null;
  }
  if (a.type === "boolean" && a.rate !== undefined) {
    const p = Math.min(1, Math.max(0, evalExpr(a.rate, scope)));
    return { true: p, false: 1 - p };
  }
  return null;
}
