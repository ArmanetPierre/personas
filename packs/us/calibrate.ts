// Recale la table living-standard.json du socle États-Unis sur le générateur : déciles du niveau de vie annuel
// (revenu disponible du ménage par adulte-équivalent, en $) de 50 000 personas tirées (graine 1). Ces bornes ne
// servent qu'aux quintiles de segmentation et à la médiane de référence (profil techno, sensibilité au prix).
// Affiche aussi le contrôle des salaires des temps plein (cible : BLS, Usual Weekly Earnings, T3 2026) et du
// revenu des ménages (cible : CPS ASEC 2026, revenus 2025). Usage : npx tsx packs/us/calibrate.ts
// (deux passes : la médiane du niveau de vie entre dans le tirage du profil techno et de l'occupation).
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPack } from "../../src/personas/pack";
import { drawPersona } from "../../src/personas/sampler";

const N = 50_000;
const pack = loadPack("us");
const ps = Array.from({ length: N }, (_, i) => drawPersona(pack, 1, i));
const x = (p: (typeof ps)[number]) => p.extra as unknown as Record<string, number & unknown> & { partTime: boolean; classOfWorker?: string; parents: unknown[]; partner: unknown; adultChildren?: unknown[] };
const ls = ps.map((p) => Number(x(p).livingStandardEur) * 12).sort((a, b) => a - b);
const q = (f: number) => Math.round(ls[Math.floor(f * N)]! / 100) * 100;
const deciles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(q);
const table = {
  id: "us-living-standard",
  title: "Déciles du niveau de vie annuel des personas (revenu disponible du ménage par adulte-équivalent, $)",
  assumption: true,
  sources: [{ org: "U.S. Census Bureau", title: "Income in the United States: 2025 (P60-289, CPS ASEC 2026)", year: 2026, url: "https://www2.census.gov/programs-surveys/demo/tables/p60/289/" }],
  justification:
    "Le Census Bureau publie le revenu monétaire des ménages avant impôt (médiane 2025 : 87 460 $) et un revenu après impôt (76 060 $), pas un niveau de vie par adulte-équivalent après impôts fédéraux et des États, FICA et crédits d'impôt pour toute la population adulte. Les bornes sont donc celles du générateur (50 000 tirages, graine 1, packs/us/calibrate.ts), cohérentes par construction avec les revenus tirés ; elles servent aux quintiles de segmentation et à la médiane de référence.",
  notes: `Calculé le ${new Date().toISOString().slice(0, 10)} sur ${N} tirages.`,
  data: { deciles, median: deciles[4] },
};
writeFileSync(resolve(import.meta.dirname, "living-standard.json"), JSON.stringify(table, null, 1) + "\n");
console.log("déciles du niveau de vie", deciles);

const pct = (a: number[], fs: number[]) => {
  const s = [...a].sort((u, v) => u - v);
  return fs.map((f) => Math.round(s[Math.floor(f * (s.length - 1))]!));
};
const ft = ps.filter((p) => p.activityStatus === "employed" && !x(p).partTime && x(p).classOfWorker !== "self_employed").map((p) => (Number(x(p).grossIncomeEur) * 12) / 52);
console.log("salaire hebdomadaire des temps plein P10/P25/P50/P75/P90", pct(ft, [0.1, 0.25, 0.5, 0.75, 0.9]), "BLS T3 2026 : 634/849/1232/1908/2919");
// Revenu monétaire des ménages (pondéré par 1/adultes ; colocations exclues)
const rows = ps
  .filter((p) => p.householdType !== "other")
  .map((p) => [Number(x(p).householdGrossEur) * 12, 1 / (1 + (x(p).partner ? 1 : 0) + x(p).parents.length + (x(p).adultChildren?.length ?? 0))] as const)
  .sort((a, b) => a[0] - b[0]);
const tot = rows.reduce((s, r) => s + r[1], 0);
const wq = (f: number) => {
  let acc = 0;
  for (const [v, w] of rows) if ((acc += w) >= f * tot) return Math.round(v);
  return 0;
};
console.log("revenu monétaire des ménages P10/P50/P90", [0.1, 0.5, 0.9].map(wq), "CPS ASEC 2026 (revenus 2025) : 20010/87460/261300");
