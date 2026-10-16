import type { Persona } from "../../db/schema";
import { compileEligibility } from "../../population/eligibility";
import { eligibilityVars, resolveSoclePack } from "../../population/target";
import { describeForPrompt } from "../../personas/describe";
import type { Pack } from "../../personas/pack";
import { drawPersonas, type DrawnPersona } from "../../personas/sampler";
import { computeMargins, plausibilityChecks } from "../../personas/validate";
import { socleVars } from "../apply";
import { cardLines, expectedDistribution, valueLabel, type ModuleValues } from "../engine";
import { moduleLibrary, resolveModules, type LoadedModule } from "../registry";
import type { ModuleAttribute } from "../schema";
import { readDraftYaml, readMeta, validateModuleYaml, type ValidationIssue } from "./drafts";

/**
 * Aperçu d'un module (brouillon ou validé) : tirage virtuel du socle v2 + du module (et de ses
 * dépendances), marges simulées, fiches exemples et alertes automatiques. Aucun appel au LLM.
 */

export interface PreviewAlert {
  level: "info" | "warn" | "error";
  message: string;
  attribute?: string;
}

export interface PreviewMargin {
  attribute: string;
  label: string;
  type: ModuleAttribute["type"];
  /** Personas pour qui l'attribut existe (condition `when`). */
  applicable: number;
  values: Array<{ code: string; label: string; share: number }>;
}

export interface PreviewResult {
  moduleId: string;
  socle: string;
  n: number;
  margins: PreviewMargin[];
  sampleCards: Array<{ personaId: string; card: string }>;
  alerts: PreviewAlert[];
  eligibilityHelpers?: Array<{ name: string; expression: string; rate: number }>;
  validationErrors: ValidationIssue[];
}

/** Seuil d'une catégorie « très rare », parmi les personas concernées par l'attribut. */
export const RARE_SHARE = 0.005;

const DEVICE_RULES: Array<{ re: RegExp; socle: string; equipment: string; what: string }> = [
  { re: /ordinateur|computer|\bmac\b|macos|windows|linux|laptop|\bpc\b|apple silicon|desktop/i, socle: "has_computer", equipment: "ordinateur", what: "un ordinateur" },
  { re: /smartphone|iphone|\bios\b|android/i, socle: "has_smartphone", equipment: "smartphone", what: "un smartphone" },
  { re: /tablette|ipad|tablet/i, socle: "has_tablet", equipment: "tablette", what: "une tablette" },
];
const WORK_RE = /r[ée]union|meeting|travail|professionn|bureau|employeur|\bdsi\b|coll[èe]gue/i;

function attrText(a: ModuleAttribute): string {
  const values = a.type === "enum" ? a.values.map((v) => `${v.code} ${typeof v.label === "string" ? v.label : v.label.M}`) : a.type === "set" ? a.items.map((i) => `${i.code} ${i.label}`) : [];
  return [a.key, a.label, a.description ?? "", ...values].join(" ");
}

function whenRefs(a: ModuleAttribute, m: LoadedModule): string {
  // Texte des conditions de présence (nommées comprises), pour savoir si un garde-fou du socle existe
  const seen = new Set<string>();
  const dump = (c: unknown): string => {
    if (typeof c === "string") {
      if (seen.has(c)) return "";
      seen.add(c);
      return dump(m.def.conditions[c]);
    }
    return JSON.stringify(c ?? "");
  };
  return dump(a.when);
}

export function previewModule(
  source: { draftId?: string; moduleId?: string; yaml?: string },
  opts: { n?: number; sample?: number; seed?: number; socle?: string } = {},
): PreviewResult {
  const n = opts.n ?? 10_000;
  let yaml = source.yaml;
  let socle = opts.socle;
  if (source.draftId) {
    yaml = readDraftYaml(source.draftId) ?? "";
    socle ??= readMeta(source.draftId).socle;
  }
  const lib = new Map(moduleLibrary());
  let m: LoadedModule | undefined;
  let validationErrors: ValidationIssue[] = [];
  if (yaml !== undefined) {
    const v = validateModuleYaml(yaml, { ...(socle && { socle }), library: lib });
    validationErrors = v.errors;
    m = v.module;
  } else if (source.moduleId) {
    m = lib.get(source.moduleId);
    if (!m) throw new Error(`Module introuvable : ${source.moduleId}`);
  }
  if (!m || validationErrors.length) {
    return {
      moduleId: m?.def.id ?? source.moduleId ?? source.draftId ?? "?",
      socle: socle ?? "fr",
      n: 0,
      margins: [],
      sampleCards: [],
      alerts: validationErrors.map((e) => ({ level: "error" as const, message: `${e.path ? `${e.path} : ` : ""}${e.message}` })),
      validationErrors,
    };
  }
  lib.set(m.def.id, m);
  const base = resolveSoclePack(socle ?? m.def.applies_to[0]!);
  const resolved = resolveModules([m.def.id], base.socle, lib);
  const pack: Pack = { ...base, modules: resolved };
  const personas = drawPersonas(pack, opts.seed ?? 42, n, 0, { modules: resolved });
  const own = (p: DrawnPersona) => p.extra.modules?.[m!.def.id] ?? {};

  // Marges simulées
  const margins: PreviewMargin[] = [];
  for (const a of m.def.attributes) {
    const app = personas.filter((p) => own(p)[a.key] !== null && own(p)[a.key] !== undefined);
    const share = (k: number) => (app.length ? k / app.length : 0);
    let values: PreviewMargin["values"] = [];
    if (a.type === "enum") {
      values = a.values.map((v) => ({ code: v.code, label: valueLabel(m!, a.key, v.code, "M") ?? v.code, share: share(app.filter((p) => own(p)[a.key] === v.code).length) }));
    } else if (a.type === "boolean") {
      values = [true, false].map((b) => ({ code: String(b), label: b ? (a.labels?.yes ?? "oui") : (a.labels?.no ?? "non"), share: share(app.filter((p) => own(p)[a.key] === b).length) }));
    } else if (a.type === "set") {
      values = a.items.map((it) => ({ code: it.code, label: it.label, share: share(app.filter((p) => (own(p)[a.key] as string[]).includes(it.code)).length) }));
    } else {
      const xs = app.map((p) => Number(Number(own(p)[a.key]).toPrecision(3))).sort((x, y) => x - y);
      const q = (f: number) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] ?? 0;
      const r3 = (x: number) => Number(x.toPrecision(3));
      const cuts = [...new Set([q(0), q(0.2), q(0.4), q(0.6), q(0.8), q(1)].map(r3))];
      if (cuts.length === 1) values = [{ code: String(cuts[0]), label: String(cuts[0]), share: 1 }];
      else
        for (let i = 0; i < cuts.length - 1; i++) {
          const lo = cuts[i]!;
          const hi = cuts[i + 1]!;
          const last = i === cuts.length - 2;
          values.push({ code: `${lo}-${hi}`, label: `${lo} à ${hi}${a.unit ? ` ${a.unit}` : ""}`, share: share(xs.filter((x) => x >= lo && (last ? x <= hi : x < hi)).length) });
        }
    }
    if (app.length < personas.length) values.push({ code: "__absent", label: "(non concerné)", share: 1 - app.length / personas.length });
    margins.push({ attribute: a.key, label: a.label, type: a.type, applicable: app.length, values });
  }

  // Alertes
  const alerts: PreviewAlert[] = [];
  const attrs = m.def.attributes;
  const assumptions = attrs.filter((a) => a.assumption).length;
  for (const a of attrs) {
    if (!a.sources.length) alerts.push({ level: "warn", attribute: a.key, message: `« ${a.label} » n'a aucune source (hypothèse seule).` });
  }
  for (const [name, t] of Object.entries(m.def.tables)) {
    if (!t.sources.length) alerts.push({ level: "info", message: `Table « ${name} » sans source (hypothèse).` });
  }
  if (assumptions / attrs.length > 0.5) {
    alerts.push({ level: "warn", message: `${assumptions} attributs sur ${attrs.length} reposent sur des hypothèses (plus de la moitié).` });
  }
  for (const mg of margins) {
    const a = m.attrs.get(mg.attribute)!;
    if (a.type !== "enum" && a.type !== "set" && a.type !== "boolean") continue;
    if (!mg.applicable) {
      alerts.push({ level: "warn", attribute: a.key, message: `« ${a.label} » n'est jamais présent (condition « when » jamais vraie sur ${n} personas).` });
      continue;
    }
    for (const v of mg.values) {
      if (v.code === "__absent") continue;
      if (v.share === 0) alerts.push({ level: "warn", attribute: a.key, message: `« ${a.label} » : la valeur « ${v.label} » n'est jamais tirée (${mg.applicable} personas concernées).` });
      else if (v.share < RARE_SHARE) {
        alerts.push({ level: "info", attribute: a.key, message: `« ${a.label} » : « ${v.label} » est très rare (${(v.share * 100).toFixed(2)} % des personas concernées).` });
      }
    }
  }

  // Conditionnement sans effet : distributions attendues identiques d'une persona à l'autre
  for (const a of attrs) {
    const conditioned = (a.type === "enum" && (a.distribution.given !== undefined || Object.values(a.distribution.weights ?? {}).some((w) => typeof w !== "number"))) || (a.type === "boolean" && a.rate !== undefined && typeof a.rate !== "number");
    if (!conditioned) continue;
    const lo: Record<string, number> = {};
    const hi: Record<string, number> = {};
    let seen = 0;
    for (const p of personas.slice(0, 3000)) {
      const d = expectedDistribution(m, a.key, p.extra.modules ?? {}, socleVars(pack, p));
      if (!d) continue;
      seen++;
      // Codes absents d'une distribution = probabilité 0 (tables à une seule valeur par groupe)
      const codes = a.type === "enum" ? a.values.map((v) => v.code) : Object.keys(d);
      for (const k of codes) {
        const v = d[k] ?? 0;
        lo[k] = Math.min(lo[k] ?? 1, v);
        hi[k] = Math.max(hi[k] ?? 0, v);
      }
    }
    const spread = Math.max(0, ...Object.keys(hi).map((k) => hi[k]! - lo[k]!));
    if (seen > 30 && spread < 0.005) {
      alerts.push({ level: "warn", attribute: a.key, message: `« ${a.label} » : le conditionnement n'a pas d'effet (même distribution pour toutes les personas).` });
    }
  }

  // Écarts avec les cibles déclarées en validation
  const rows = personas.map((p) => ({ ...p, activityStatus: p.activityStatus ?? null, pcs: p.pcs ?? null }));
  const onlyThis: Pack = { ...pack, modules: { ordered: [m], quasiDims: new Map() } };
  for (const r of computeMargins(onlyThis, rows).filter((x) => x.key.startsWith(`${m.def.id}.`))) {
    if (!r.pass) alerts.push({ level: "warn", attribute: r.key.split(".")[1], message: `Marge « ${r.title} » : écart max ${r.maxAbsDevPts.toFixed(1)} pt avec la distribution attendue.` });
  }
  for (const c of plausibilityChecks(onlyThis, rows)) {
    if (!c.pass) {
      const f = (x: number) => (c.percent ? `${(x * 100).toFixed(1)} %` : String(Math.round(x)));
      alerts.push({ level: "warn", message: `Cible déclarée non atteinte : ${c.label} = ${f(c.value)} (attendu ${f(c.min)} à ${f(c.max)}).` });
    }
  }

  // Cohérence avec le socle : un attribut d'équipement présent chez des personas sans cet équipement
  for (const a of attrs) {
    const text = attrText(a);
    const guards = whenRefs(a, m);
    const present = personas.filter((p) => own(p)[a.key] !== null && own(p)[a.key] !== undefined);
    for (const rule of DEVICE_RULES) {
      if (!rule.re.test(text) || guards.includes(rule.socle)) continue;
      const bad = present.filter((p) => !p.equipment.includes(rule.equipment)).length;
      if (bad > 0) {
        alerts.push({
          level: "error",
          attribute: a.key,
          message: `« ${a.label} » concerne ${rule.what}, mais ${bad} personas sans ${rule.what} dans le socle en ont une valeur : ajouter « when: {attr: socle.${rule.socle}, eq: true} ».`,
        });
      }
    }
    // Heuristique sur le nom de l'attribut seulement (les options d'un ensemble citent souvent des collègues)
    if (WORK_RE.test(`${a.key} ${a.label}`) && !/activity_status/.test(guards)) {
      const notWorking = present.filter((p) => !["employed", "unemployed"].includes(p.activityStatus ?? "")).length;
      if (notWorking / Math.max(1, present.length) > 0.05) {
        alerts.push({ level: "warn", attribute: a.key, message: `« ${a.label} » semble professionnel mais concerne aussi ${notWorking} personas sans emploi (retraités, étudiants…) : conditionner à socle.activity_status ?` });
      }
    }
  }

  // Fiches exemples (une personne concernée en priorité)
  const sample = opts.sample ?? 5;
  const candidates = personas.filter((p) => Object.values(own(p)).some((v) => v !== null && !(Array.isArray(v) && !v.length)));
  const pick = (candidates.length >= sample ? candidates : personas).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / sample)) === 0).slice(0, sample);
  const sampleCards = pick.map((p) => {
    const row = { ...p, narrative: null, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" } as unknown as Persona;
    const lines = describeForPrompt(pack, row, { modules: false }).split("\n");
    const mod = cardLines(resolved, p.extra.modules as ModuleValues, p.sex, socleVars(pack, p)).map((x) => x.line);
    const at = lines.findIndex((l) => l.startsWith("Situation"));
    lines.splice(at + 1, 0, ...mod);
    return { personaId: p.id, card: lines.filter((l) => !l.startsWith("Tonalité")).join("\n") };
  });

  // Filtres prêts à l'emploi : taux d'éligibilité sur la population simulée
  const helpers = Object.entries(m.def.eligibility_helpers);
  const eligibilityHelpers = helpers.length
    ? helpers.map(([name, expression]) => {
        const f = compileEligibility(expression);
        return { name, expression, rate: personas.filter((p) => f.test(eligibilityVars(p))).length / personas.length };
      })
    : undefined;

  return { moduleId: m.def.id, socle: base.manifest.version, n, margins, sampleCards, alerts, ...(eligibilityHelpers && { eligibilityHelpers }), validationErrors };
}
