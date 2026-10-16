import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { getEngine } from "../engine";
import { loadPack } from "../personas/pack";
import { createNextStudy, recommendationPath, recommendStudy } from "../studies/recommend";
import { errorText, numberLocale, t } from "./i18n";

/**
 * Recommandations après une étude (claude-cli), vérifiées contre le résumé, en cache dans
 * data/recommendations/<étude>.json. `--create <recId> --confirm` crée la variante du projet et
 * l'étude suivante, sans la lancer.
 */

const { values } = parseArgs({
  options: {
    study: { type: "string" },
    force: { type: "boolean", default: false },
    create: { type: "string" },
    confirm: { type: "boolean", default: false },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.study) {
  console.log(t.studyRecommend.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
const conf = (c: string) => ({ faible: "○", moyenne: "◐", forte: "●" })[c] ?? c;
try {
  runMigrations(db);
  if (values.create) {
    if (!values.confirm) throw new Error(t.studyRecommend.needConfirm);
    const r = createNextStudy(values.study, values.create, { confirm: true, db, pack });
    console.log(t.studyRecommend.projectCreated(r.projectId, r.projectFile));
    console.log(t.studyRecommend.studyCreated(r.studyId));
  } else {
    const r = await recommendStudy(values.study, { db, pack, engine: getEngine("claude-cli", config), force: values.force, log: (m) => console.log(m) });
    console.log(`\n${r.headline}\n`);
    console.log(t.studyRecommend.findings);
    for (const f of r.findings) {
      console.log(`  ${conf(f.strength)} ${f.title} — ${f.detail}`);
      for (const e of f.evidence) console.log(t.studyRecommend.evidence(e.metric, e.value, e.source));
    }
    console.log(t.studyRecommend.recommendations);
    r.recommendations.forEach((x, i) => {
      console.log(t.studyRecommend.recommendation(i + 1, x.kind, x.title, x.confidence, x.id));
      console.log(`     ${x.rationale}`);
      for (const e of x.evidence) console.log(t.studyRecommend.evidence(e.metric, e.value, e.source));
      if (x.nextStudy) {
        const n = x.nextStudy;
        console.log(
          t.studyRecommend.nextStudy(n.sample, n.n, n.control, n.estimatedCalls, n.estimatedMinutes, n.targetCheck ? (n.targetCheck.rate * 100).toLocaleString(numberLocale, { maximumFractionDigits: 2 }) : null),
        );
        console.log(t.studyRecommend.nextStudyDetail(n.hypothesis, n.successCriterion, JSON.stringify(n.projectPatch)));
        console.log(t.studyRecommend.create(r.studyId, x.id));
      }
    });
    console.log(t.studyRecommend.caveats);
    for (const c of r.caveats) console.log(`  - ${c}`);
    const v = r.verification;
    console.log(t.studyRecommend.verification(v.evidenceValid, v.evidenceChecked, !!v.repaired, v.dropped.length, v.droppedNextStudies.length));
    for (const d of v.dropped) console.log(t.studyRecommend.dropped(d.where, d.source, d.value, d.reason));
    for (const d of v.droppedNextStudies) console.log(t.studyRecommend.droppedNext(d.recommendation, d.reason));
    for (const n of v.notes) console.log(`  - ${n}`);
    console.log(t.common.callsTokens(r.usage.calls, r.usage.inputTokens, r.usage.outputTokens));
    console.log(t.common.json(recommendationPath(r.studyId)));
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
