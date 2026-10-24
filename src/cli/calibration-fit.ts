import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig, loadDotEnv } from "../config";
import { openDb, runMigrations } from "../db/client";
import { loadPack } from "../personas/pack";
import { fitCalibration, type CalibrationPoint } from "../studies/calibration-fit";
import { CALIBRATION_FILE, DEFAULT_MODEL_FAMILY, loadCalibrationFor, readCalibrationFile } from "../studies/payment";
import { hasGenericPricing, pricingOf, toEur } from "../studies/price-model";
import { getProject } from "../studies/project";
import { hasV3Measures, QUESTION_KEY } from "../studies/protocols/concept-price";
import { findStudy, personasByIds, studyResponses } from "../studies/store";
import { summarize } from "../studies/summary";
import { errorText, t } from "./i18n";

/**
 * Ajuste la conversion M2 (part payante estimée) sur une série de calibration v3.
 * Lit calibration/truth.json (produit, étude v3, part payante réelle) ; affiche l'ajustement ;
 * n'écrit calibration/payment-v3.json qu'avec --write. Aucun appel au modèle.
 */

const { values } = parseArgs({
  options: {
    truth: { type: "string", default: "calibration/truth.json" },
    out: { type: "string", default: CALIBRATION_FILE },
    write: { type: "boolean", default: false },
    group: { type: "string", default: "target" },
    /** Famille de modèle des études de la série (table de calibration indexée par famille). */
    family: { type: "string", default: DEFAULT_MODEL_FAMILY },
    pack: { type: "string", default: "fr" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(t.calibrationFit.usage);
  process.exit(0);
}

const truthSchema = z.object({
  products: z.array(z.object({ product: z.string(), studyId: z.string().nullable(), realPayShare: z.number().positive().lt(1).nullable(), source: z.string().optional() })),
});

loadDotEnv();
const config = loadConfig();
const pack = loadPack(values.pack);
const { sqlite, db } = openDb(config.DATABASE_PATH);
try {
  runMigrations(db);
  if (!existsSync(values.truth!)) throw new Error(t.calibrationFit.fileNotFound(values.truth!));
  const truth = truthSchema.parse(JSON.parse(readFileSync(values.truth!, "utf8")));
  const points: CalibrationPoint[] = [];
  for (const p of truth.products) {
    if (!p.studyId || p.realPayShare === null) {
      console.log(t.calibrationFit.skipped(p.product, !p.studyId));
      continue;
    }
    const study = findStudy(db, p.studyId);
    // v4 : même mesure que la v3 (seul le bloc des attributs de module change dans le prompt)
    if (!hasV3Measures(study.protocolVersion)) throw new Error(t.calibrationFit.notV3(p.product, study.id, String(study.protocolVersion)));
    const project = getProject(db, study.projectId);
    if (!project) throw new Error(t.common.projectNotFound(study.projectId));
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    const personas = new Map(personasByIds(db, rows.map((r) => r.personaId)).map((p) => [p.id, p]));
    const s = summarize(pack, study, project, rows, personas);
    const a = s.groups.find((g) => g.group === values.group)?.analysis ?? s.overall;
    const pay = a.payment;
    if (!pay?.lowTierYes) throw new Error(t.calibrationFit.noLowTier(p.product, study.id));
    points.push({
      product: p.product,
      studyId: study.id,
      realPayShare: p.realPayShare,
      yes: pay.lowTierYes.yes,
      n: pay.lowTierYes.n,
      shown: rows[0]!.payload.priceShown as number,
      lowTier: pay.lowTierYes.price,
      unit: s.project.pricePeriod ?? "month",
      shownEur: project.priceEur && hasGenericPricing(project) ? toEur(pricingOf(project)!, project.priceEur) : project.priceEur,
      recurringShare: a.needFrequency?.recurringShare ?? null,
    });
    console.log(t.calibrationFit.point(p.product, study.id, pay.lowTierYes.n, pay.lowTierYes.price, pay.lowTierYes.yes));
  }
  const current = loadCalibrationFor(values.family!, values.out!) ?? { version: "payment-v3/0", status: "uncalibrated" as const };
  const next = `payment-v3/${Number(current.version.split("/")[1] ?? 0) + 1}`;
  const r = fitCalibration(points, { version: next, date: new Date().toISOString().slice(0, 10) });
  for (const l of r.report) console.log(`  ${l}`);
  if (!r.ok) {
    console.log(t.calibrationFit.refused(r.reason, current.version, current.status));
    process.exitCode = 1;
  } else if (!values.write) {
    console.log(t.calibrationFit.ready(next, JSON.stringify(r.calibration, null, 2)));
  } else {
    const file = readCalibrationFile(values.out!);
    writeFileSync(values.out!, JSON.stringify({ ...file, byModelFamily: { ...file.byModelFamily, [values.family!]: r.calibration } }, null, 2) + "\n");
    console.log(t.calibrationFit.written(values.out!, next));
  }
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  sqlite.close();
}
