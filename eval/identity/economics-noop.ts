// Contrôle du recalcul budgétaire : sans changement d'entrée, il doit retrouver les valeurs tirées.
import { loadPack } from "../../src/personas/pack";
import { drawPersona } from "../../src/personas/sampler";
import { recomputeEconomics } from "../../src/personas/economics";
const pack = loadPack("fr-2026.2");
const keys = ["monthlyDiscretionaryBudgetEur", "householdIncomeEur", "priceSensitivity"] as const;
const ex = ["incomeTaxEur", "benefitsEur", "housingAidEur", "housingCostEur", "preCommittedEur", "currentExpensesEur", "livingStandardEur", "monthlyShortfallEur"];
const maxd: Record<string, number> = {};
for (let i = 0; i < 5000; i++) {
  const p = drawPersona(pack, 42, i);
  const q = recomputeEconomics(pack, p, { income: null, subscriptions: [], modules: [] });
  for (const k of keys) maxd[k] = Math.max(maxd[k] ?? 0, Math.abs((q[k] as number) - (p[k] as number)));
  for (const k of ex) maxd[k] = Math.max(maxd[k] ?? 0, Math.abs((q.extra as any)[k] - (p.extra as any)[k]));
}
console.log(maxd);
