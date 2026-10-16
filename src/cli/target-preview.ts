import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb } from "../db/client";
import { libraryWithDrafts } from "../modules/assistant";
import { previewTarget, type ProjectInput, type TargetPreview } from "../population/preview";
import { getProject, readProjectFile } from "../studies/project";
import { errorText, numberLocale, t } from "./i18n";

/**
 * Aperçu d'une cible avant lancement : éligibilité, distributions, fiches et, avec --triage,
 * pré-tri de pertinence par le modèle local d'Ollama (2 appels par persona, en cache).
 *
 *   npm run target:preview -- --project <id | fichier> [--group target] [--n 200] [--sample 10]
 *                             [--seed 42] [--triage] [--threshold 0.5] [--alert 0.1] [--drafts] [--json]
 */

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    group: { type: "string", default: "target" },
    n: { type: "string" },
    sample: { type: "string", default: "10" },
    seed: { type: "string", default: "42" },
    triage: { type: "boolean", default: false },
    threshold: { type: "string" },
    alert: { type: "string" },
    drafts: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.project) {
  console.log(t.targetPreview.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const log = values.json ? (m: string) => console.error(m) : (m: string) => console.log(m);
try {
  let project: ProjectInput;
  if (existsSync(values.project)) project = readProjectFile(values.project);
  else {
    const config = loadConfig();
    const { sqlite, db } = openDb(config.DATABASE_PATH);
    const row = getProject(db, values.project);
    sqlite.close();
    if (!row) throw new Error(t.common.projectNotFoundAnywhere(values.project));
    project = row;
  }
  const drafts = values.drafts ? libraryWithDrafts() : null;
  const preview = await previewTarget(project, {
    group: values.group,
    ...(values.n && { n: Number(values.n) }),
    sample: Number(values.sample),
    seed: Number(values.seed),
    ...(drafts && { library: drafts.library }),
    ...(values.triage && {
      triage: {
        ...(values.threshold && { threshold: Number(values.threshold) }),
        ...(values.alert && { alertShare: Number(values.alert) }),
      },
    }),
    log,
  });
  if (values.json) console.log(JSON.stringify(preview, null, 2));
  else printPreview(preview);
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
}

export function printPreview(p: TargetPreview): void {
  const m = t.targetPreview;
  const pct = (x: number, d = 1) => `${t.common.decimalComma ? (x * 100).toFixed(d).replace(".", ",") : (x * 100).toFixed(d)}${t.common.pct}`;
  console.log(m.header(p.group, p.project.name));
  console.log(m.socle(p.socle, p.modules.join(", "), p.seed));
  console.log(t.common.filter(p.filter ?? undefined));
  const e = p.eligibility;
  console.log(m.draws(p.n, e.draws.toLocaleString(numberLocale)));
  if (p.filter) console.log(m.rate(pct(e.rate, 2), pct(e.ci[0], 2), pct(e.ci[1], 2)));
  for (const w of [...e.warnings, ...e.shortfalls.map((s) => m.quota(s))]) console.log(`⚠ ${w}`);
  console.log(m.distributions);
  for (const d of p.distributions) {
    const vals = d.values.slice(0, 8).map((v) => `${v.label} ${Math.round(v.share * 100)}${t.common.pct}`).join(", ");
    console.log(m.distribution(d.label, !!d.inFilter, !!d.multi, vals, d.values.length > 8));
  }
  console.log(m.cards(p.cards.length));
  for (const c of p.cards) console.log(`\n### ${c.id}\n${c.card}`);
  if (p.triage) {
    const tr = p.triage;
    console.log(m.triage(tr.model));
    console.log(`${tr.alert ? m.alert : ""}${tr.message}`);
    console.log(m.argmax(tr.argmax.concerned, tr.argmax.marginal, tr.argmax.not_concerned, tr.flagged, tr.threshold));
    if (tr.profiles.length) {
      console.log(m.profiles);
      for (const g of tr.profiles) {
        console.log(m.profile(g.criteria.map((c) => m.criterion(c.label, c.valueLabel)).join(m.criteriaJoin), g.n, pct(g.rate, 0), g.lift.toFixed(1), g.inReview, g.examples.join(", ")));
      }
    }
    console.log(m.review(tr.review.length));
    for (const r of tr.review) {
      const line = (k: string) => r.card.split("\n").find((l) => l.startsWith(k))?.replace(/^[^:]+: /, "") ?? "";
      console.log(m.reviewLine(r.id, r.notConcerned.toFixed(2), [line("Prénom"), line("Situation"), line("Réunions"), line("Visio")]));
    }
    console.log(m.calls(tr.calls, tr.cachedCalls, (tr.ms / 1000).toFixed(0), tr.failed));
  }
  console.log(m.duration((p.ms / 1000).toFixed(1)));
}
