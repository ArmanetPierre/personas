import {
  ACTIVITY_STATUSES,
  findBand,
  HOUSEHOLD_TYPES,
  PCS_CODES,
  ROGERS,
  SEXES,
  TOWN_SIZES,
  type FrPack,
  type Pack,
  type Sex,
} from "./pack";
import { computeSgMargins } from "./countries/sg/validate";
import { computeUsMargins } from "./countries/us/validate";
import { socleVars, type SocleLike } from "../modules/apply";
import { evalCondition, expectedDistribution, theoreticalMargin, valueLabel, type ModuleValues } from "../modules/engine";
import type { EnumAttribute } from "../modules/schema";

/**
 * Validation : compare les marges d'une base de personas aux tables cibles du pack.
 *
 * Deux natures de dimensions :
 * - « tirée » : la table est tirée directement (âge × sexe, région, activité, PCS, ménage,
 *   équipement…) : seul l'aléa d'échantillonnage sépare la base de la cible. Critère : test du
 *   chi² d'adéquation (échec si p < 0,001) et écart absolu max ≤ 4 points pour 1 000 personas
 *   (tolérance élargie en 1/√n pour les petits tirages, voir drawnTolerance).
 * - « modélisée » : la marge résulte d'un modèle (déciles de niveau de vie, issus des revenus,
 *   impôts et prestations simulés). Critère : écart absolu max ≤ 5 points par décile.
 * - « info » : hypothèse de modélisation (profil de Rogers), affichée sans critère d'échec.
 */

export const THRESHOLDS = {
  /** p-value minimale du chi² pour une dimension tirée. */
  minPValue: 0.001,
  /** Écart absolu max (en points de %) pour une dimension tirée. */
  maxAbsDevDrawn: 4,
  /** Écart absolu max (en points de %) pour une dimension modélisée (déciles de niveau de vie). */
  maxAbsDevModelled: 5,
};

/**
 * Tolérance d'écart des dimensions tirées : 4 points pour 1 000 personas, élargie comme l'erreur
 * d'échantillonnage (∝ 1/√n) pour les petits tirages (≈ 7,3 points pour 300), jamais sous 4 points.
 */
export function drawnTolerance(n: number): number {
  return Math.max(THRESHOLDS.maxAbsDevDrawn, THRESHOLDS.maxAbsDevDrawn * Math.sqrt(1000 / Math.max(1, n)));
}

export interface MarginInput {
  age: number;
  sex: string;
  region: string;
  townSize: string;
  activityStatus: string | null;
  pcs: string | null;
  householdType: string;
  equipment: string[];
  techAdoption: string;
  monthlyIncomeEur?: number;
  extra: Record<string, unknown>;
}

export interface Cell {
  label: string;
  observed: number; // effectif
  expectedShare: number; // part cible (0..1)
}

export interface DimensionReport {
  key: string;
  title: string;
  kind: "drawn" | "modelled" | "info";
  n: number;
  cells: Array<Cell & { observedShare: number; deviationPts: number }>;
  maxAbsDevPts: number;
  chi2: number;
  df: number;
  pValue: number;
  pass: boolean;
}

/** Fonction gamma incomplète régularisée supérieure Q(a, x) (Numerical Recipes). */
function gammq(a: number, x: number): number {
  if (x <= 0) return 1;
  const gln = lgamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

function lgamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

export function chiSquarePValue(chi2: number, df: number): number {
  return df > 0 ? gammq(df / 2, chi2 / 2) : 1;
}

export function report(key: string, title: string, kind: DimensionReport["kind"], cells: Cell[]): DimensionReport {
  const n = cells.reduce((s, c) => s + c.observed, 0);
  const totalShare = cells.reduce((s, c) => s + c.expectedShare, 0);
  let chi2 = 0;
  let used = 0;
  const out = cells.map((c) => {
    const exp = (c.expectedShare / totalShare) * n;
    if (exp > 0) {
      chi2 += (c.observed - exp) ** 2 / exp;
      used++;
    }
    const observedShare = n ? c.observed / n : 0;
    return { ...c, expectedShare: c.expectedShare / totalShare, observedShare, deviationPts: (observedShare - c.expectedShare / totalShare) * 100 };
  });
  const df = Math.max(0, used - 1);
  const pValue = chiSquarePValue(chi2, df);
  const maxAbsDevPts = Math.max(0, ...out.map((c) => Math.abs(c.deviationPts)));
  const pass =
    kind === "info" ||
    (kind === "drawn"
      ? pValue >= THRESHOLDS.minPValue && maxAbsDevPts <= drawnTolerance(n)
      : maxAbsDevPts <= THRESHOLDS.maxAbsDevModelled);
  return { key, title, kind, n, cells: out, maxAbsDevPts, chi2, df, pValue, pass };
}

/** Poids de chaque âge × sexe dans la population cible (uniforme dans chaque tranche). */
function ageSexWeights(pack: Pack): Array<{ age: number; sex: Sex; w: number }> {
  const out: Array<{ age: number; sex: Sex; w: number }> = [];
  const total = pack.ageSex.data.bands.reduce((s, b) => s + b.M + b.F, 0);
  for (const b of pack.ageSex.data.bands) {
    const width = b.to - b.from + 1;
    for (let a = b.from; a <= b.to; a++) for (const sex of SEXES) out.push({ age: a, sex, w: b[sex] / width / total });
  }
  return out;
}

const count = <T>(rows: T[], pred: (r: T) => boolean) => rows.reduce((s, r) => s + (pred(r) ? 1 : 0), 0);

export function computeMargins(pack: Pack, rows: MarginInput[]): DimensionReport[] {
  if (pack.kind === "sg") return [...computeSgMargins(pack, rows), ...moduleMargins(pack, rows)];
  if (pack.kind === "us") return [...computeUsMargins(pack, rows), ...moduleMargins(pack, rows)];
  return computeFrMargins(pack, rows);
}

function computeFrMargins(pack: FrPack, rows: MarginInput[]): DimensionReport[] {
  const reports: DimensionReport[] = [];
  const asw = ageSexWeights(pack);

  // Âge × sexe
  const total = pack.ageSex.data.bands.reduce((s, b) => s + b.M + b.F, 0);
  reports.push(
    report(
      "age_sex",
      "Âge × sexe",
      "drawn",
      pack.ageSex.data.bands.flatMap((b) =>
        SEXES.map((sex) => ({
          label: `${b.from}-${b.to} ${sex}`,
          observed: count(rows, (r) => r.sex === sex && r.age >= b.from && r.age <= b.to),
          expectedShare: b[sex] / total,
        })),
      ),
    ),
  );

  // Région
  const regTotal = pack.regions.data.regions.reduce((s, r) => s + r.population, 0);
  reports.push(
    report(
      "region",
      "Région",
      "drawn",
      pack.regions.data.regions.map((r) => ({
        label: r.name,
        observed: count(rows, (x) => x.region === r.code),
        expectedShare: r.population / regTotal,
      })),
    ),
  );

  // Taille d'agglomération
  reports.push(
    report(
      "town_size",
      "Taille d'agglomération",
      "drawn",
      TOWN_SIZES.map((t) => ({
        label: pack.townSize.data.labels[t],
        observed: count(rows, (x) => x.townSize === t),
        expectedShare: pack.regions.data.regions.reduce(
          (s, r) => s + (r.population / regTotal) * (pack.townSize.data.byRegion[r.code]?.[t] ?? 0) / sumValues(pack.townSize.data.byRegion[r.code] ?? {}),
          0,
        ),
      })),
    ),
  );

  // Population ciblée : activité, PCS et déciles de niveau de vie généraux ne s'appliquent pas.
  const general = !pack.manifest.targeted;
  if (general) {
    // Situation d'activité
    const actShare = (st: string) =>
      asw.reduce((s, x) => {
        const band = findBand(pack.activity.data.bands, x.age)[x.sex];
        return s + (x.w * band[st as keyof typeof band]) / sumValues(band);
      }, 0);
    reports.push(
      report(
        "activity",
        "Situation d'activité",
        "drawn",
        ACTIVITY_STATUSES.map((st) => ({ label: st, observed: count(rows, (r) => r.activityStatus === st), expectedShare: actShare(st) })),
      ),
    );

    // PCS des personnes en emploi
    const employedRows = rows.filter((r) => r.activityStatus === "employed");
    const pcsTarget = Object.fromEntries(PCS_CODES.map((c) => [c, 0])) as Record<string, number>;
    for (const x of asw) {
      const act = findBand(pack.activity.data.bands, x.age)[x.sex];
      const wEmp = (x.w * act.employed) / sumValues(act);
      const shares = findBand(pack.pcs.data.employed, x.age)[x.sex];
      const tot = sumValues(shares);
      for (const c of PCS_CODES) pcsTarget[c]! += (wEmp * shares[c]) / tot;
  }
  reports.push(
    report(
      "pcs",
      "PCS (personnes en emploi)",
      "drawn",
      PCS_CODES.map((c) => ({ label: pack.pcs.data.labels[c].M, observed: count(employedRows, (r) => r.pcs === c), expectedShare: pcsTarget[c]! })),
    ),
  );

  }

  // Mode de cohabitation
  const hhTarget = Object.fromEntries(HOUSEHOLD_TYPES.map((h) => [h, 0])) as Record<string, number>;
  for (const x of asw) {
    const sh = findBand(pack.household.data.bands, x.age)[x.sex];
    const tot = sumValues(sh);
    for (const h of HOUSEHOLD_TYPES) hhTarget[h]! += (x.w * sh[h]) / tot;
  }
  reports.push(
    report(
      "household",
      "Type de ménage",
      "drawn",
      HOUSEHOLD_TYPES.map((h) => ({ label: h, observed: count(rows, (r) => r.householdType === h), expectedShare: hhTarget[h]! })),
    ),
  );

  // Équipement (une dimension binaire par équipement)
  for (const [key, label, tag] of [
    ["smartphone", "Smartphone", "smartphone"],
    ["computer", "Ordinateur", "ordinateur"],
    ["tablet", "Tablette", "tablette"],
  ] as const) {
    const p = asw.reduce((s, x) => s + x.w * findBand(pack.digital.data.bands, x.age)[key], 0);
    const yes = count(rows, (r) => r.equipment.includes(tag));
    reports.push(
      report(`equipment_${key}`, `Équipement : ${label}`, "drawn", [
        { label: "oui", observed: yes, expectedShare: p },
        { label: "non", observed: rows.length - yes, expectedShare: 1 - p },
      ]),
    );
  }

  if (general) {
    // Déciles de niveau de vie (INSEE) : 10 % attendus dans chaque intervalle
    const d = pack.livingStandard.data.deciles;
    const bounds = [0, ...d, Infinity];
    reports.push(
      report(
        "living_standard",
        "Déciles de niveau de vie annuel (bornes INSEE)",
        "modelled",
        bounds.slice(0, -1).map((lo, i) => {
          const hi = bounds[i + 1]!;
          return {
            label: i === 0 ? `< D1 (${fmt(d[0]!)})` : i === 9 ? `≥ D9 (${fmt(d[8]!)})` : `D${i}-D${i + 1}`,
            observed: count(rows, (r) => {
              const nv = Number(r.extra.livingStandardEur ?? 0) * 12;
              return nv >= lo && nv < hi;
            }),
            expectedShare: 0.1,
          };
        }),
      ),
    );

  }

  reports.push(...moduleMargins(pack, rows));

  // Profil de Rogers (hypothèse)
  reports.push(
    report(
      "rogers",
      pack.manifest.targeted ? "Profil d'adoption (Rogers ; cible = population générale, écart attendu)" : "Profil d'adoption (Rogers, hypothèse)",
      "info",
      ROGERS.map((k) => ({ label: k, observed: count(rows, (r) => r.techAdoption === k), expectedShare: pack.psychographics.data.rogers[k] })),
    ),
  );

  return reports;
}

function sumValues(o: object): number {
  return Object.values(o).reduce((s: number, v) => s + (typeof v === "number" ? v : 0), 0);
}

const fmt = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;

export function formatReports(reports: DimensionReport[]): string {
  const out: string[] = [];
  const pct = (x: number) => `${(x * 100).toFixed(1).padStart(5)} %`;
  for (const r of reports) {
    out.push(
      `\n## ${r.title}  [${r.kind === "drawn" ? "tirée" : r.kind === "modelled" ? "modélisée" : "info"}]  n=${r.n}`,
    );
    out.push(`${"".padEnd(34)} ${"base".padStart(7)} ${"cible".padStart(7)} ${"écart".padStart(8)}`);
    for (const c of r.cells) {
      out.push(
        `${c.label.slice(0, 34).padEnd(34)} ${pct(c.observedShare)} ${pct(c.expectedShare)} ${(c.deviationPts >= 0 ? "+" : "") + c.deviationPts.toFixed(1).padStart(5)} pt`,
      );
    }
    out.push(
      `→ écart max ${r.maxAbsDevPts.toFixed(1)} pt ; chi² ${r.chi2.toFixed(1)} (ddl ${r.df}, p = ${r.pValue < 0.0001 ? r.pValue.toExponential(1) : r.pValue.toFixed(4)}) ; ${r.kind === "info" ? "indicatif" : r.pass ? "OK" : "ÉCHEC"}`,
    );
  }
  const scored = reports.filter((r) => r.kind !== "info");
  const worst = scored.reduce((a, b) => (b.maxAbsDevPts > a.maxAbsDevPts ? b : a));
  const minP = scored.filter((r) => r.kind === "drawn").reduce((a, b) => (b.pValue < a.pValue ? b : a));
  const failed = scored.filter((r) => !r.pass);
  out.push("\n## Indicateur global");
  out.push(`Écart absolu max : ${worst.maxAbsDevPts.toFixed(1)} pt (${worst.title})`);
  out.push(`Plus petite p-value du chi² (dimensions tirées) : ${minP.pValue.toFixed(4)} (${minP.title})`);
  out.push(
    `Seuils : dimensions tirées p ≥ ${THRESHOLDS.minPValue} et écart ≤ ${drawnTolerance(worst.n).toFixed(1)} pt (n=${worst.n}) ; dimensions modélisées écart ≤ ${THRESHOLDS.maxAbsDevModelled} pt`,
  );
  out.push(failed.length ? `RÉSULTAT : ÉCHEC (${failed.map((f) => f.title).join(", ")})` : "RÉSULTAT : OK");
  return out.join("\n");
}

const moduleValuesOf = (r: MarginInput) => (r.extra.modules ?? {}) as ModuleValues;

/** Marges déclarées par les modules (`validation.margins`), contre leur distribution théorique. */
/**
 * Marges déclarées par les modules (`validation.margins`). Cible : distribution théorique quand elle se
 * déroule dans le module, sinon moyenne des distributions attendues de chaque persona (attributs
 * conditionnés au socle : âge, PCS, sexe…). Seules les personas pour qui l'attribut existe comptent.
 */
export function moduleMargins(pack: Pack, rows: MarginInput[]): DimensionReport[] {
  const out: DimensionReport[] = [];
  for (const m of pack.modules.ordered) {
    for (const spec of m.def.validation.margins) {
      const a = m.attrs.get(spec.attribute) as EnumAttribute;
      const has = rows.filter((r) => {
        const v = moduleValuesOf(r)[m.def.id]?.[spec.attribute];
        return v !== undefined && v !== null;
      });
      if (!has.length) continue;
      let target = theoreticalMargin(m.def, spec.attribute);
      if (!target) {
        const acc: Record<string, number> = {};
        for (const r of has) {
          const d = expectedDistribution(m, spec.attribute, moduleValuesOf(r), socleVars(pack, r as unknown as SocleLike));
          for (const [k, p] of Object.entries(d ?? {})) acc[k] = (acc[k] ?? 0) + p / has.length;
        }
        target = acc;
      }
      out.push(
        report(
          `${m.def.id}.${spec.attribute}`,
          spec.title,
          "drawn",
          a.values.map((v) => ({
            label: valueLabel(m, spec.attribute, v.code, "M") ?? v.code,
            observed: count(has, (r) => moduleValuesOf(r)[m.def.id]?.[spec.attribute] === v.code),
            expectedShare: target![v.code] ?? 0,
          })),
        ),
      );
    }
  }
  return out;
}

export interface PlausibilityCheck {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Valeur exprimée en part (affichée en %). */
  percent?: boolean;
  pass: boolean;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

/**
 * Contrôles de plausibilité : ceux déclarés par les modules (médianes par groupe dans des fourchettes),
 * plus, pour une population ciblée, les bornes d'âge du pack.
 */
export function plausibilityChecks(pack: Pack, rows: MarginInput[]): PlausibilityCheck[] {
  const checks: PlausibilityCheck[] = [];
  for (const m of pack.modules.ordered) {
    for (const spec of m.def.validation.plausibility) {
      const read = (r: MarginInput): number => {
        if (spec.value === "socle.monthly_income") return r.monthlyIncomeEur ?? 0;
        if (spec.value.startsWith("socle.")) return Number((r as unknown as Record<string, unknown>)[spec.value.slice(6)] ?? 0);
        return Number(moduleValuesOf(r)[m.def.id]?.[spec.value] ?? 0);
      };
      const keep = (r: MarginInput) => {
        if (!spec.filter) return true;
        return evalCondition(spec.filter, { module: m, values: moduleValuesOf(r), socle: {}, rng: null });
      };
      const a = m.attrs.get(spec.group_by) as EnumAttribute;
      for (const v of a.values) {
        const xs = rows.filter((r) => keep(r) && moduleValuesOf(r)[m.def.id]?.[spec.group_by] === v.code).map(read);
        let range: [number, number] | undefined;
        if (spec.median_in) range = spec.median_in[v.code];
        else if (spec.median_vs_table) {
          const ref = m.def.tables[spec.median_vs_table.table]?.values?.[v.code];
          if (ref !== undefined) range = [Math.round(ref * spec.median_vs_table.range[0]), Math.round(ref * spec.median_vs_table.range[1])];
        }
        if (xs.length < spec.min_n || !range) continue;
        const value = median(xs);
        const label = spec.label.replace("{group}", valueLabel(m, spec.group_by, v.code, "M") ?? v.code).replace("{n}", String(xs.length));
        checks.push({ label, value, min: range[0], max: range[1], pass: value >= range[0] && value <= range[1] });
      }
    }
  }
  // Parts sourcées déclarées par les modules (`validation.shares`)
  for (const m of pack.modules.ordered) {
    for (const spec of m.def.validation.shares) {
      const scopeOf = (r: MarginInput) => ({ module: m, values: moduleValuesOf(r), socle: socleVars(pack, r as unknown as SocleLike), rng: null });
      const base = rows.filter((r) => moduleValuesOf(r)[m.def.id] && (!spec.among || evalCondition(spec.among, scopeOf(r))));
      if (base.length < 30) continue;
      const share = count(base, (r) => evalCondition(spec.share_of, scopeOf(r))) / base.length;
      checks.push({ label: `${spec.label} (n=${base.length})`, value: share, min: spec.range[0], max: spec.range[1], pass: share >= spec.range[0] && share <= spec.range[1], percent: true });
    }
  }
  if (pack.manifest.targeted && rows.length) {
    const ages = rows.map((r) => r.age);
    const lo = Math.min(...ages);
    const hi = Math.max(...ages);
    const { ageMin, ageMax } = pack.manifest;
    checks.push({ label: "Âge minimum", value: lo, min: ageMin, max: ageMax, pass: lo >= ageMin });
    checks.push({ label: "Âge maximum", value: hi, min: ageMin, max: ageMax, pass: hi <= ageMax });
  }
  return checks;
}

export function formatPlausibility(checks: PlausibilityCheck[]): string {
  if (!checks.length) return "";
  return [
    "\n## Plausibilité",
    ...checks.map((c) => {
      const f = (x: number) => (c.percent ? `${(x * 100).toFixed(1)} %` : String(Math.round(x)));
      return `${c.label.padEnd(60)} ${f(c.value).padStart(8)}  [${f(c.min)} ; ${f(c.max)}]  ${c.pass ? "OK" : "ÉCHEC"}`;
    }),
  ].join("\n");
}
