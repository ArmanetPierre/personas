// Recale la table living-standard.json du socle Singapour sur le générateur : déciles du niveau de vie
// annuel (revenu disponible du ménage par adulte-équivalent, en S$) de 50 000 personas tirées (graine 1).
// Ces bornes ne servent qu'aux quintiles de segmentation et à la médiane de référence (profil techno,
// sensibilité au prix). Usage : npx tsx packs/sg/calibrate-living-standard.ts
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPack } from "../../src/personas/pack";
import { drawPersona } from "../../src/personas/sampler";

const pack = loadPack("sg");
const N = 50_000;
const ls = Array.from({ length: N }, (_, i) => Number((drawPersona(pack, 1, i).extra as { livingStandardEur: number }).livingStandardEur) * 12).sort((a, b) => a - b);
const q = (f: number) => Math.round(ls[Math.floor(f * N)]! / 100) * 100;
const deciles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(q);
const table = {
  id: "sg-living-standard",
  title: "Déciles du niveau de vie annuel des personas (revenu disponible du ménage par adulte-équivalent, S$)",
  assumption: true,
  sources: [
    { org: "DOS", title: "Key Household Income Trends 2025 (M810361, M810871)", year: 2025, url: "https://tablebuilder.singstat.gov.sg/table/TS/M810871" },
  ],
  justification:
    "SingStat publie le revenu du travail et le revenu marchand des ménages résidents par membre (médiane 2025 : 4 160 S$ de revenu marchand par membre et par mois, cotisation employeur CPF comprise), mais pas de niveau de vie après impôt, transferts et CPF salarié pour toute la population résidente (non-résidents compris). Les bornes sont donc celles du générateur lui-même (50 000 tirages, graine 1, calculées par packs/sg/calibrate-living-standard.ts), cohérentes par construction avec les revenus tirés ; elles servent aux quintiles de segmentation et à la médiane de référence.",
  notes: `Calculé le ${new Date().toISOString().slice(0, 10)} sur ${N} tirages.`,
  data: { deciles, median: deciles[4] },
};
writeFileSync(resolve(import.meta.dirname, "living-standard.json"), JSON.stringify(table, null, 1) + "\n");
console.log(deciles);
