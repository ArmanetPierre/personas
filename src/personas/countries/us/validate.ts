import { findBandClamped, SEXES } from "../../pack-common";
import { report, type DimensionReport, type MarginInput } from "../../validate";
import { RACES, type UsPack } from "./pack";

/**
 * Marges du socle États-Unis comparées à ses tables : âge × sexe, région, race et origine hispanique,
 * nativité, diplôme des 25 ans et plus, situation d'activité, statut d'occupation, couverture santé des
 * 19-64 ans (ACS 2024), déciles de niveau de vie (bornes recalées sur le générateur : contrôle de stabilité).
 */

const count = <T>(rows: T[], pred: (r: T) => boolean) => rows.reduce((s, r) => s + (pred(r) ? 1 : 0), 0);
const ex = (r: MarginInput) => r.extra as { race?: string; nativity?: string; education?: string; tenure?: string; healthInsurance?: string; livingStandardEur?: number };

/** Poids âge × sexe (uniforme dans chaque tranche). */
function ageSexCells(pack: UsPack): Array<{ age: number; sex: "M" | "F"; w: number }> {
  const bands = pack.ageSex.data.bands;
  const total = bands.reduce((s, b) => s + b.M + b.F, 0);
  const out: Array<{ age: number; sex: "M" | "F"; w: number }> = [];
  for (const b of bands) for (let a = b.from; a <= b.to; a++) for (const sex of SEXES) out.push({ age: a, sex, w: b[sex] / (b.to - b.from + 1) / total });
  return out;
}

/** Parts attendues de la race (État × facteur d'âge, renormalisés comme au tirage). */
export function expectedRace(pack: UsPack): Record<string, number> {
  const states = pack.geography.data.states;
  const tot = states.reduce((s, x) => s + x.adults, 0);
  const cells = ageSexCells(pack);
  const out: Record<string, number> = Object.fromEntries(RACES.map((r) => [r, 0]));
  for (const st of states) {
    const base = pack.race.data.byState[st.code]!;
    for (const c of cells) {
      const f = findBandClamped(pack.race.data.ageFactor, c.age).factors;
      const w = RACES.map((r) => base[r] * f[r]);
      const t = w.reduce((a, b) => a + b, 0);
      RACES.forEach((r, i) => (out[r]! += (st.adults / tot) * c.w * (w[i]! / t)));
    }
  }
  return out;
}

export function computeUsMargins(pack: UsPack, rows: MarginInput[]): DimensionReport[] {
  const out: DimensionReport[] = [];
  const bands = pack.ageSex.data.bands;
  const total = bands.reduce((s, b) => s + b.M + b.F, 0);
  out.push(report("age_sex", "Âge × sexe", "drawn", bands.flatMap((b) => SEXES.map((sex) => ({ label: `${b.from}-${b.to} ${sex}`, observed: count(rows, (r) => r.sex === sex && r.age >= b.from && r.age <= b.to), expectedShare: b[sex] / total })))));

  const regTotal = pack.regions.data.regions.reduce((s, r) => s + r.population, 0);
  out.push(report("region", "Région (Census)", "drawn", pack.regions.data.regions.map((r) => ({ label: r.name, observed: count(rows, (x) => x.region === r.code), expectedShare: r.population / regTotal }))));

  const race = expectedRace(pack);
  out.push(report("race", "Race et origine hispanique", "drawn", RACES.map((r) => ({ label: r, observed: count(rows, (x) => ex(x).race === r), expectedShare: race[r]! }))));

  const nat: Record<string, number> = {};
  for (const r of RACES) for (const [k, v] of Object.entries(pack.nativity.data.byRace[r])) nat[k] = (nat[k] ?? 0) + race[r]! * v;
  out.push(report("nativity", "Nativité", "drawn", Object.entries(nat).map(([k, v]) => ({ label: k, observed: count(rows, (x) => ex(x).nativity === k), expectedShare: v }))));

  // Diplôme des 25 ans et plus : table âge × sexe (le facteur de race déplace un peu la marge : « modélisée »)
  const adults25 = rows.filter((r) => r.age >= 25);
  if (adults25.length) {
    const cells = ageSexCells(pack).filter((c) => c.age >= 25);
    const t = cells.reduce((s, c) => s + c.w, 0);
    const edu: Record<string, number> = {};
    for (const c of cells) for (const [k, v] of Object.entries(findBandClamped(pack.education.data.byAgeSex, c.age)[c.sex])) edu[k] = (edu[k] ?? 0) + (c.w / t) * v;
    out.push(report("education", "Diplôme (25 ans et plus)", "modelled", Object.entries(edu).map(([k, v]) => ({ label: k, observed: count(adults25, (r) => ex(r).education === k), expectedShare: v }))));
  }

  // Activité : études, puis situation hors étudiants (l'effet du diplôme est renormalisé : « modélisée »)
  const A = pack.activity.data;
  const act: Record<string, number> = { employed: 0, unemployed: 0, student: 0, retired: 0, inactive: 0 };
  for (const c of ageSexCells(pack)) {
    const s = findBandClamped(A.enrolled, c.age)[c.sex];
    const a = findBandClamped(A.byAgeSex, c.age)[c.sex];
    const ret = findBandClamped(A.retiredShareOfNilf, c.age).share;
    act.student! += c.w * s;
    act.employed! += c.w * (1 - s) * a.employed;
    act.unemployed! += c.w * (1 - s) * a.unemployed;
    act.retired! += c.w * (1 - s) * a.nilf * ret;
    act.inactive! += c.w * (1 - s) * a.nilf * (1 - ret);
  }
  out.push(report("activity", "Situation d'activité", "modelled", Object.entries(act).map(([k, v]) => ({ label: k, observed: count(rows, (r) => r.activityStatus === k), expectedShare: v }))));

  // Couverture santé principale des 19-64 ans (ACS 2024, B27010)
  for (const [key, [lo, hi]] of [["19-34", [19, 34]], ["35-64", [35, 64]]] as const) {
    const target = pack.health.data.validation[key];
    const sub = rows.filter((r) => r.age >= lo && r.age <= hi);
    if (target && sub.length) out.push(report(`health_${key}`, `Couverture santé (${key} ans)`, "modelled", Object.entries(target).map(([k, v]) => ({ label: k, observed: count(sub, (r) => ex(r).healthInsurance === k), expectedShare: v }))));
  }

  // Niveau de vie : 10 % attendus par intervalle de déciles
  const d = pack.livingStandard.data.deciles;
  const bounds = [0, ...d, Infinity];
  out.push(
    report(
      "living_standard",
      "Déciles de niveau de vie annuel (bornes recalées sur le générateur)",
      "modelled",
      bounds.slice(0, -1).map((lo, i) => ({
        label: i === 0 ? "< D1" : i === 9 ? "≥ D9" : `D${i}-D${i + 1}`,
        observed: count(rows, (r) => {
          const v = Number(ex(r).livingStandardEur ?? 0) * 12;
          return v >= lo && v < bounds[i + 1]!;
        }),
        expectedShare: 0.1,
      })),
    ),
  );
  return out;
}
