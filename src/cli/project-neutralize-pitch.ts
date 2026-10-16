import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "../config";
import type { Project } from "../db/schema";
import { openDb, runMigrations } from "../db/client";
import { getEngine } from "../engine";
import { neutralizePitch } from "../studies/pitch-neutralize";
import { TONE_CATEGORY_LABELS } from "../studies/pitch-tone";
import { getProject, priceColumns, readProjectFile, slugify } from "../studies/project";
import { TONE_CATEGORY_LABELS_EN } from "../web/i18n-labels";
import { errorText, lang, t } from "./i18n";

/**
 * Propose une version factuelle du pitch d'un projet (claude-cli, sans outils) et l'écrit dans
 * data/proposals/<projet>-pitch.json. Rien n'est appliqué : l'utilisateur relit, puis remplace `pitch`
 * dans le fichier projet en gardant l'original dans `pitchOriginal` (et `pitchNeutralized: true`).
 */

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.project) {
  console.log(t.projectNeutralizePitch.usage);
  process.exit(values.help ? 0 : 2);
}

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  let project: Project | undefined;
  if (existsSync(values.project)) {
    const f = readProjectFile(values.project);
    const cols = priceColumns(f);
    project = {
      id: f.id ?? slugify(f.name), name: f.name, pitch: f.pitch, targetAudience: f.targetAudience ?? null, businessModel: f.businessModel ?? null,
      priceEur: cols.priceEur, pricePeriod: cols.pricePeriod, freeOffer: cols.freeOffer, competitors: f.competitors, alternatives: f.alternatives,
      extra: cols.extra, createdAt: "", updatedAt: "",
    } as Project;
  } else project = getProject(db, values.project);
  if (!project) throw new Error(t.common.projectNotFound(values.project));

  const r = await neutralizePitch(project, { engine: getEngine("claude-cli", config) });
  const out = values.out ?? join(dirname(resolve(config.DATABASE_PATH)), "proposals", `${project.id}-pitch.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(r, null, 2));

  console.log(t.projectNeutralizePitch.header(project.id, r.toneScore.before, r.toneScore.after, r.lexicalScore.before, r.lexicalScore.after));
  if (r.unchanged) console.log(t.projectNeutralizePitch.unchanged);
  else {
    console.log(t.projectNeutralizePitch.passages(r.passages.length));
    const toneLabel = (c: keyof typeof TONE_CATEGORY_LABELS) => (lang === "en" ? TONE_CATEGORY_LABELS_EN[c] ?? TONE_CATEGORY_LABELS[c] : TONE_CATEGORY_LABELS[c]);
    for (const p of r.passages) console.log(t.projectNeutralizePitch.passage(toneLabel(p.category), p.text, p.replacement || null, p.reason));
    console.log(t.projectNeutralizePitch.originalNeutral(r.original, r.neutral));
  }
  const fc = r.factCheck;
  console.log(
    t.projectNeutralizePitch.facts(fc.ok, !!fc.repaired, JSON.stringify(fc.numbersMissing), JSON.stringify(fc.numbersAdded), JSON.stringify(fc.namesMissing), JSON.stringify(fc.factsMissing)),
  );
  if (r.missingInfo.length) console.log(t.projectNeutralizePitch.missingInfo(r.missingInfo.map((m) => `  - ${m}`).join("\n")));
  console.log(t.projectNeutralizePitch.proposal(out));
  console.log(t.common.callsTokens(r.usage.calls, r.usage.inputTokens, r.usage.outputTokens));
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
