// Médianes de revenu personnel et de reste-à-vivre par statut (module numerique), et pack fondateurs.
import { loadPack } from "../../src/personas/pack";
import { drawPersona } from "../../src/personas/sampler";
import { resolveModules } from "../../src/modules/registry";
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const v2 = loadPack("fr-2026.2");
const r = resolveModules(["numerique"], v2.socle);
const N = Number(process.argv[2] ?? 300000);
const by: Record<string, { inc: number[]; bud: number[]; tools: number[] }> = {};
for (let i = 0; i < N; i++) {
  const p = drawPersona(v2, 42, i, { modules: r });
  const ws = (p.extra.modules as any)?.numerique?.work_status;
  if (!ws) continue;
  const b = (by[ws] ??= { inc: [], bud: [], tools: [] });
  b.inc.push(p.monthlyIncomeEur); b.bud.push(p.monthlyDiscretionaryBudgetEur);
  b.tools.push(((p.extra as any).economics?.subscriptions ?? []).length);
}
console.log("v2 + numerique (" + r.ordered.map((m) => m.def.id + "@" + m.def.version).join(", ") + ")");
for (const [k, v] of Object.entries(by)) console.log(k.padEnd(18), "n", String(v.inc.length).padStart(5), "revenu méd.", med(v.inc), "reste-à-vivre méd.", med(v.bud), "avec abonnements pro", (v.tools.filter((x) => x > 0).length / v.inc.length).toFixed(2));
const f = loadPack("fr-tech-founders");
const fb: Record<string, number[]> = {};
for (let i = 0; i < 3000; i++) { const p = drawPersona(f, 7, i); const s = (p.extra.modules as any)?.["entrepreneuriat-tech"]?.status; (fb[s] ??= []).push(p.monthlyIncomeEur); }
console.log("pack fr-tech-founders"); for (const [k, v] of Object.entries(fb)) console.log(k.padEnd(18), "n", String(v.length).padStart(5), "revenu méd.", med(v));
