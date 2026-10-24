import { findBandClamped, SEXES } from "../../pack-common";
import { report, type DimensionReport, type MarginInput } from "../../validate";
import type { SgPack } from "./pack";

/**
 * Marges du socle Singapour comparées à ses tables : âge × sexe, statut de résidence, ethnie et type de
 * logement des résidents, région des résidents, activité des résidents (service national compris),
 * déciles de niveau de vie (bornes recalées sur le générateur : contrôle de stabilité).
 */

const count = <T>(rows: T[], pred: (r: T) => boolean) => rows.reduce((s, r) => s + (pred(r) ? 1 : 0), 0);
const ex = (r: MarginInput) => r.extra as { residency?: string; ethnicity?: string; dwelling?: string; livingStandardEur?: number; nationalService?: boolean };
const isRes = (r: MarginInput) => ex(r).residency === "citizen" || ex(r).residency === "pr";

export function computeSgMargins(pack: SgPack, rows: MarginInput[]): DimensionReport[] {
  const out: DimensionReport[] = [];
  const bands = pack.ageSex.data.bands;
  const total = bands.reduce((s, b) => s + b.M + b.F, 0);
  out.push(
    report("age_sex", "Âge × sexe", "drawn", bands.flatMap((b) => SEXES.map((sex) => ({ label: `${b.from}-${b.to} ${sex}`, observed: count(rows, (r) => r.sex === sex && r.age >= b.from && r.age <= b.to), expectedShare: b[sex] / total })))),
  );

  // Statut de résidence (le Work Permit regroupe ses deux secteurs)
  const R = pack.residency.data.statuses;
  const byStatus = new Map<string, number>();
  for (const s of R) byStatus.set(s.code, (byStatus.get(s.code) ?? 0) + s.bands.reduce((a, b) => a + b.M + b.F, 0));
  const all = [...byStatus.values()].reduce((a, b) => a + b, 0);
  out.push(report("residency", "Statut de résidence", "drawn", [...byStatus].map(([code, n]) => ({ label: code, observed: count(rows, (r) => ex(r).residency === code), expectedShare: n / all }))));

  // Résidents : ethnie (pondérée par l'âge et le statut), logement, région
  const res = rows.filter(isRes);
  if (res.length) {
    const resCells = R.filter((s) => s.code === "citizen" || s.code === "pr").flatMap((s) => s.bands.map((b) => ({ s: s.code as "citizen" | "pr", b, n: b.M + b.F })));
    const resTotal = resCells.reduce((a, c) => a + c.n, 0);
    const eth: Record<string, number> = {};
    for (const c of resCells) {
      const sh = findBandClamped(pack.ethnicity.data.residents[c.s], (c.b.from + c.b.to) / 2).shares;
      const t = Object.values(sh).reduce((a, b) => a + b, 0);
      for (const [k, v] of Object.entries(sh)) eth[k] = (eth[k] ?? 0) + (c.n / resTotal) * (v / t);
    }
    out.push(report("ethnicity", "Ethnie (résidents)", "drawn", Object.entries(eth).map(([k, v]) => ({ label: k, observed: count(res, (r) => ex(r).ethnicity === k), expectedShare: v }))));

    // Logement et région : effectifs par planning area, modulés par l'âge (tirage du logement des parents
    // pour qui vit chez eux : écart attendu de quelques points, d'où le type « modélisé »)
    const dw: Record<string, number> = {};
    for (const a of pack.geography.data.areas) for (const [k, v] of Object.entries(a.residents)) dw[k] = (dw[k] ?? 0) + v;
    const dwTotal = Object.values(dw).reduce((a, b) => a + b, 0);
    out.push(report("dwelling", "Type de logement (résidents)", "modelled", Object.entries(dw).map(([k, v]) => ({ label: k, observed: count(res, (r) => ex(r).dwelling === k), expectedShare: v / dwTotal }))));
    const regTotal = pack.regions.data.regions.reduce((s, r) => s + r.population, 0);
    out.push(report("region", "Région (résidents)", "modelled", pack.regions.data.regions.map((r) => ({ label: r.name, observed: count(res, (x) => x.region === r.code), expectedShare: r.population / regTotal }))));

    // Activité des résidents (NSF comptés « inactive »)
    const A = pack.activity.data;
    const act: Record<string, number> = {};
    for (const c of resCells) {
      for (const sex of SEXES) {
        const w = c.b[sex] / resTotal;
        const mid = Math.round((c.b.from + c.b.to) / 2);
        // part NSF moyenne de la tranche (hommes) : moyenne des âges de la tranche
        let ns = 0;
        if (sex === "M") {
          for (let age = c.b.from; age <= c.b.to; age++) ns += A.nationalService.find((x) => age >= x.from && age <= x.to)?.share ?? 0;
          ns /= c.b.to - c.b.from + 1;
        }
        const sh = findBandClamped(A.residents, mid)[sex];
        const t = Object.values(sh).reduce((a, b) => a + b, 0);
        act.inactive = (act.inactive ?? 0) + w * ns;
        for (const [k, v] of Object.entries(sh)) act[k] = (act[k] ?? 0) + w * (1 - ns) * (v / t);
      }
    }
    out.push(report("activity", "Situation d'activité (résidents)", "drawn", Object.entries(act).map(([k, v]) => ({ label: k, observed: count(res, (r) => r.activityStatus === k), expectedShare: v }))));
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
