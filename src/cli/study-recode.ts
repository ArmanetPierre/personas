import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { getEngine } from "../engine";
import { OBJECTION_LABELS, QUESTION_KEY, type ObjectionCategory } from "../studies/protocols/concept-price";
import { readTaxonomy, recodedDistribution, recodeStudy } from "../studies/recode";
import type { ConceptPricePayload } from "../studies/run";
import { findStudy, studyResponses } from "../studies/store";
import { OBJECTION_LABELS_EN } from "../web/i18n-labels";
import { errorText, lang, t } from "./i18n";

/** Reclasse les objections d'une étude dans une nouvelle taxonomie (claude-cli), sans écraser l'original. */

const { values } = parseArgs({
  options: {
    study: { type: "string" },
    taxonomy: { type: "string" },
    key: { type: "string" },
    group: { type: "string", default: "target" },
    "batch-size": { type: "string", default: "40" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.study || !values.taxonomy) {
  console.log(t.studyRecode.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
const pct = (x: number) => `${Math.round(x * 100)}${t.common.pct}`;
const objectionLabel = (c: string): string | undefined => (lang === "en" ? OBJECTION_LABELS_EN[c] : undefined) ?? OBJECTION_LABELS[c as ObjectionCategory];
try {
  runMigrations(db);
  const study = findStudy(db, values.study);
  const tax = readTaxonomy(values.taxonomy, values.key);
  console.log(t.studyRecode.header(study.id, tax.key, tax.objections.length));
  const r = await recodeStudy(db, getEngine("claude-cli", config), study, tax, { batchSize: Number(values["batch-size"]), log: (m) => console.log(m) });
  console.log(t.studyRecode.run(r.objections, r.responses, r.calls, r.usage.inputTokens, r.usage.outputTokens));
  if (r.stoppedForUsageLimit) console.log(t.studyRecode.usageLimit(r.stoppedForUsageLimit));

  const all = studyResponses(db, study.id, QUESTION_KEY);
  const groupRows = all.filter((x) => (study.personaGroups[x.personaId] ?? "target") === values.group);
  const rows = groupRows.length ? groupRows : all;
  const d = recodedDistribution(rows, tax);
  if (!d) throw new Error(t.studyRecode.noneRecoded);
  console.log(t.studyRecode.title(groupRows.length ? values.group! : null, d.n));
  for (const o of tax.objections) {
    console.log(`  ${o.label.padEnd(44).slice(0, 44)} ${String(d.counts[o.code] ?? 0).padStart(4)}  ${pct(d.shares[o.code] ?? 0).padStart(5)}`);
    for (const ex of d.examples[o.code] ?? []) console.log(t.studyRecode.example(ex));
  }
  // Ancienne répartition, pour comparer
  const old: Record<string, number> = {};
  for (const x of rows) for (const c of new Set((x.payload as ConceptPricePayload).answer.objections.map((o) => o.category))) old[c] = (old[c] ?? 0) + 1;
  console.log(t.studyRecode.oldCategories(Object.entries(old).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${objectionLabel(c) ?? c} ${pct(k / rows.length)}`).join(", ")));
  console.log(t.studyRecode.whence);
  for (const [o, m] of Object.entries(d.crosstab)) console.log(`  ${(objectionLabel(o) ?? o).padEnd(30)} → ${Object.entries(m).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c} ${k}`).join(", ")}`);
  const out = join(dirname(resolve(config.DATABASE_PATH)), "summaries", `${study.id}-recode-${tax.key}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ study: study.id, group: groupRows.length ? values.group : null, taxonomy: tax, distribution: d, run: r }, null, 2));
  console.log(`\n${t.common.json(out)}`);
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
