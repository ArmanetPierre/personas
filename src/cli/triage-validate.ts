import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inArray } from "drizzle-orm";
import { loadConfig, loadDotEnv } from "../config";
import { openDb } from "../db/client";
import { personas as personasTable, responses, studies as studiesTable, type Persona, type Project } from "../db/schema";
import { socleVars } from "../modules/apply";
import { cardLines } from "../modules/engine";
import { extraOf, personaModules } from "../personas/describe";
import { loadPack, type Pack } from "../personas/pack";
import { packResolver } from "../studies/packs";
import { getProject } from "../studies/project";
import { studyModulesFor } from "../studies/run";
import {
  agreement,
  LABEL_ORDERS,
  ollamaLogprobClient,
  relevanceSystem,
  relevanceUser,
  runTriage,
  type RelevanceLabel,
  type TriageItem,
  type TriageResult,
} from "../triage";
import { t } from "./i18n";

/**
 * Validation hors ligne du pré-tri de pertinence : Qwen (méthode A) contre la pertinence déclarée par
 * Claude dans des études terminées. Lecture seule de la base ; appels Ollama en cache (reprenable).
 *
 *   npm run triage:validate -- --studies <id1,id2,…> [--portrait] [--out data/triage/validation.json]
 */

const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

const { values } = parseArgs({
  options: {
    studies: { type: "string" },
    portrait: { type: "boolean", default: false },
    out: { type: "string" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.studies?.trim()) {
  console.log(t.triageValidate.usage);
  process.exit(values.help ? 0 : 2);
}

/**
 * Fiche telle que les études déjà faites l'ont montrée : avant le correctif du 2026-10-15, les lignes de
 * module conditionnées par le socle (ex. « Réunions : » de productivite-reunions) n'apparaissaient pas.
 * On les retire pour comparer Qwen et Claude sur la même information.
 */
function asRun(pack: Pack, p: Persona, user: string): string {
  const mods = personaModules(pack, p);
  const values = extraOf(p).modules;
  const shown = new Set(cardLines(mods, values, p.sex).map((x) => x.line));
  const extra = cardLines(mods, values, p.sex, socleVars(pack, p)).map((x) => x.line).filter((l) => !shown.has(l));
  return extra.length ? user.split("\n").filter((l) => !extra.includes(l)).join("\n") : user;
}

loadDotEnv();
const config = loadConfig();
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  const ids = values.studies!.split(",").map((s) => s.trim()).filter(Boolean);
  const studyRows = db.select().from(studiesTable).where(inArray(studiesTable.id, ids)).all();
  const packOf = packResolver(loadPack("fr"));
  const items: TriageItem[] = [];
  const refs = new Map<string, { ref: RelevanceLabel; study: string; group: string; persona: Persona }>();
  for (const study of studyRows) {
    const project = getProject(db, study.projectId) as Project;
    const system = Object.fromEntries(LABEL_ORDERS.map((o) => [o, relevanceSystem(project, o)])) as TriageItem["system"];
    const rows = db.select().from(responses).where(inArray(responses.studyId, [study.id])).all();
    const pids = rows.map((r) => r.personaId);
    const byId = new Map<string, Persona>();
    for (let i = 0; i < pids.length; i += 500) {
      for (const p of db.select().from(personasTable).where(inArray(personasTable.id, pids.slice(i, i + 500))).all()) byId.set(p.id, p);
    }
    let rowsForStudy = rows;
    if (values.limit) rowsForStudy = rows.slice(0, Number(values.limit));
    for (const r of rowsForStudy) {
      const payload = r.payload as { answer?: { relevance?: RelevanceLabel }; group?: string };
      const rel = payload.answer?.relevance;
      const p = byId.get(r.personaId);
      if (!rel || !p) continue;
      const persona = values.portrait ? p : { ...p, narrative: null };
      const id = `${study.id}:${p.id}`;
      items.push({ id, system, user: asRun(packOf(p), persona, relevanceUser(packOf(p), persona, studyModulesFor(study, p.id))) });
      refs.set(id, { ref: rel, study: study.id, group: payload.group ?? "target", persona: p });
    }
  }
  console.log(t.triageValidate.references(items.length, studyRows.map((s) => s.id).join(", "), values.portrait!));
  const client = ollamaLogprobClient();
  const run = await runTriage(items, { client, log: (m) => console.log(m) });
  console.log(t.triageValidate.calls(run.calls, run.cached, (run.ms / 1000).toFixed(0), run.failed.length));
  for (const f of run.failed.slice(0, 5)) console.log(t.triageValidate.failure(f.id, f.error));

  const byStudyGroup = new Map<string, Array<{ ref: RelevanceLabel; result: TriageResult }>>();
  const all: Array<{ ref: RelevanceLabel; result: TriageResult }> = [];
  for (const res of run.results) {
    const r = refs.get(res.id)!;
    const k = `${r.study}/${r.group}`;
    const list = byStudyGroup.get(k) ?? [];
    list.push({ ref: r.ref, result: res });
    byStudyGroup.set(k, list);
    all.push({ ref: r.ref, result: res });
  }
  const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}${t.common.pct}` : "—");
  const report: Record<string, unknown> = { model: run.model, portrait: values.portrait, n: all.length, thresholds: {} as Record<string, unknown>, groups: {} as Record<string, unknown> };
  console.log(t.triageValidate.thresholds);
  console.log(t.triageValidate.thresholdsHeader);
  for (const t of THRESHOLDS) {
    const a = agreement(all, t);
    (report.thresholds as Record<string, unknown>)[t] = a;
    console.log(`${t.toFixed(2)}  ${pct(a.recallNc).padStart(9)}  ${pct(a.precisionNc).padStart(9)}  ${pct(a.falseNcRate).padStart(7)}  ${pct(a.refShare).padStart(9)}  ${pct(a.estShare).padStart(9)}`);
  }
  const a0 = agreement(all, 0.5);
  console.log(t.triageValidate.agreement(pct(a0.exact), a0.qwk.toFixed(2), pct(a0.meanProb)));
  console.log(t.triageValidate.confusion);
  for (const [r, row] of Object.entries(a0.confusion)) console.log(`  ${r.padEnd(14)} ${Object.values(row).map((v) => String(v).padStart(5)).join("")}`);
  console.log(t.triageValidate.byGroup);
  for (const [k, list] of [...byStudyGroup].sort()) {
    const g = THRESHOLDS.map((t) => agreement(list, t));
    (report.groups as Record<string, unknown>)[k] = Object.fromEntries(THRESHOLDS.map((t, i) => [t, g[i]]));
    const at = (t: number) => g[THRESHOLDS.indexOf(t)]!;
    console.log(
      t.triageValidate.group(
        k.padEnd(20),
        String(list.length).padStart(3),
        pct(at(0.5).refShare).padStart(5),
        pct(at(0.5).meanProb).padStart(5),
        Number.isFinite(at(0.5).auc) ? at(0.5).auc.toFixed(2) : "—",
        pct(at(0.3).recallNc),
        pct(at(0.3).falseNcRate),
        pct(at(0.5).exact),
        at(0.5).qwk.toFixed(2),
      ),
    );
  }
  const out = resolve(values.out ?? `data/triage/validation${values.portrait ? "-portrait" : ""}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        ...report,
        items: run.results.map((r) => ({ id: r.id, ref: refs.get(r.id)!.ref, group: refs.get(r.id)!.group, probs: r.probs, byOrder: r.byOrder, mass: r.mass })),
      },
      null,
      1,
    ),
  );
  console.log(t.triageValidate.detail(out));
} catch (err) {
  console.error((err as Error).stack ?? (err as Error).message);
  process.exitCode = 1;
} finally {
  sqlite.close();
}
