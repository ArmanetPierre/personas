import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { Engine } from "../../src/engine/engine";
import { insertPersonas } from "../../src/personas/store";
import { drawPersonas } from "../../src/personas/sampler";
import { createProject, getProject, readProjectFile } from "../../src/studies/project";
import {
  applyProjectPatch,
  checkEvidence,
  checkTargetPatch,
  createNextStudy,
  getPath,
  recommendStudy,
  similar,
  valueMatches,
} from "../../src/studies/recommend";
import { runStudy } from "../../src/studies/run";
import { findStudy } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { answer, fakeBackend, pack, payer } from "./fixtures";

describe("vérification des preuves", () => {
  const input = { groups: [{ analysis: { n: 200, payers: 0, vanWestendorp: { opp: 19, pme: 39.94 }, behaviors: { ignore: 0.455 } }, label: "Cible" }], drivers: { outcomes: [{ factors: [{ sentence: "Profil = précoce : intérêt 32 %" }] }] }, "x.y": { z: 1 } };
  it("lit un chemin et refuse un chemin absent ou un objet", () => {
    expect(getPath(input, "groups[0].analysis.vanWestendorp.opp")).toBe(19);
    expect(getPath(input, '["x.y"].z')).toBe(1);
    expect(getPath(input, "groups[1].analysis")).toBeUndefined();
    expect(checkEvidence(input, { metric: "OPP", value: "19 €", source: "groups[0].analysis.vanWestendorp.opp" })).toBeNull();
    expect(checkEvidence(input, { metric: "OPP", value: "19 €", source: "groups[0].analysis.vw.opp" })).toMatch(/introuvable/);
    expect(checkEvidence(input, { metric: "VW", value: "19", source: "groups[0].analysis.vanWestendorp" })).toMatch(/objet/);
    expect(checkEvidence(input, { metric: "OPP", value: "24 €", source: "groups[0].analysis.vanWestendorp.opp" })).toMatch(/valeur différente/);
  });
  it("accepte les arrondis, les parts en % et les libellés", () => {
    expect(valueMatches(0.455, "45,5 %")).toBe(true);
    expect(valueMatches(0.455, "46 %")).toBe(true);
    expect(valueMatches(0.455, "0.455")).toBe(true);
    expect(valueMatches(0.455, "55 %")).toBe(false);
    expect(valueMatches(39.94, "39,94 €")).toBe(true);
    expect(valueMatches(39.94, "40 €")).toBe(true);
    expect(valueMatches(0, "0 %")).toBe(true);
    expect(valueMatches("Profil = précoce : intérêt 32 %", "intérêt 32 %")).toBe(true);
    expect(valueMatches("Cible", "Témoin")).toBe(false);
    expect(similar("Bogue de fiche corrigé après l'étude : les lignes de module", "Une note signale un bogue de fiche corrigé après coup : lignes de module")).toBe(true);
  });
});

describe("patch de projet", () => {
  const base = readProjectFile("examples/meal-planner.json");
  it("valide un patch de prix et refuse un patch invalide", () => {
    const ok = applyProjectPatch(base, { price: { currency: "EUR", offers: [{ id: "m", amount: 3, unit: "month" }], tiers: [2, 3, 5] } }, { id: "x-r1" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.file.id).toBe("x-r1");
      expect(ok.file.priceTiers).toBeUndefined();
      expect(ok.file.pitch).toBe(base.pitch);
    }
    const bad = applyProjectPatch(base, { price: { currency: "EUR", offers: [] } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/price/);
    expect(applyProjectPatch(base, { pitch: "court" }).ok).toBe(false);
  });
  it("vérifie un filtre de cible avec le module de population", () => {
    expect(checkTargetPatch({ socle: "fr", modules: [], eligibility: "age >= 25 and agee <= 40" }).errors.join(" ")).toMatch(/agee/);
    const t = checkTargetPatch({ socle: "fr", modules: [], eligibility: "age >= 25 and age <= 35 and pcs == 3" });
    expect(t.errors).toEqual([]);
    expect(t.rate).toBeGreaterThan(0.01);
  });
});

describe("recommandations et étude suivante (backend simulé)", () => {
  async function setup() {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 30));
    const project = createProject(db, readProjectFile("examples/meal-planner.json"), { sourceFile: resolve("examples/meal-planner.json") });
    const { study } = createStudy(db, pack, { projectId: project.id, n: 10, seed: 7, backend: "ollama", model: "fake" });
    await runStudy(db, new Engine(fakeBackend((_, i) => JSON.stringify(i % 4 === 0 ? payer() : answer())).backend), pack, findStudy(db, study.id));
    return { db, sqlite, study, project };
  }
  const out = (evidenceSource: string, extra: object = {}) => ({
    headline: "Personne ne paie.",
    findings: [
      { title: "Effectif", detail: "10 réponses", evidence: [{ metric: "n", value: "10", source: "groups[0].analysis.n" }], strength: "faible" },
      { title: "Prix", detail: "x", evidence: [{ metric: "payeurs", value: "25 %", source: evidenceSource }], strength: "faible" },
    ],
    recommendations: [
      {
        id: "prix-bas",
        kind: "prix",
        title: "Tester 2, 3 et 4 €",
        rationale: "r",
        evidence: [{ metric: "n", value: "10", source: "groups[0].analysis.n" }],
        confidence: "faible",
        nextStudy: { hypothesis: "h", successCriterion: "s", projectPatch: { price: { amountEur: 3, period: "month" }, priceTiers: [2, 3, 4] }, sample: "same_sample", n: 10 },
      },
      { id: "message", kind: "message", title: "t", rationale: "r", evidence: [{ metric: "n", value: "10", source: "groups[0].analysis.n" }], confidence: "faible" },
    ],
    caveats: ["Petit échantillon."],
    ...extra,
  });

  it("répare une preuve invalide, supprime ce qui reste faux, met en cache, et crée la variante", async () => {
    const { db, sqlite, study } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    // 1er appel : une preuve fausse ; réparation : encore fausse → supprimée
    const fb = fakeBackend((req) => JSON.stringify(out(req.messages.length > 1 ? "groups[0].analysis.inexistant" : "groups[0].analysis.payers")), 1);
    const r = await recommendStudy(study.id, { db, pack, engine: new Engine(fb.backend), outDir: dir });
    expect(r.verification.repaired).toBe(true);
    expect(r.verification.dropped).toHaveLength(1);
    expect(r.findings[1]!.evidence).toEqual([]);
    expect(r.verification.evidenceValid).toBe(r.verification.evidenceChecked - 1);
    expect(r.caveats[0]).toMatch(/Conversion du paiement non calibrée/);
    // Niveaux absolus jamais sans statut : M1 avec G, M2 (non calibrée) et l'indice de confiance
    expect(r.caveats.join("\n")).toMatch(/paiement observé dans les 7 jours : .* ; part payante estimée : .*non calibrée, confiance faible/);
    expect(r.caveats.join("\n")).toMatch(/Indice de confiance des niveaux absolus : faible/);
    expect(r.absoluteLevels).toMatchObject({ estimated: { calibration: "uncalibrated", confidence: "low" }, confidenceIndex: { level: "low" } });
    const input = JSON.parse(readFileSync(join(dir, `${study.id}.input.json`), "utf8"));
    expect(input.confidence).toMatchObject({ level: "low", calibrated: false });
    expect(input.groups[0].analysis.payment.estimated.calibration).toBe("uncalibrated");
    expect(r.recommendations[0]!.nextStudy!.estimatedCalls).toBe(10);
    expect(r.usage.calls).toBe(2);
    expect(existsSync(join(dir, `${study.id}.input.json`))).toBe(true);
    // Cache : même entrée, aucun nouvel appel
    const fb2 = fakeBackend(() => {
      throw new Error("ne doit pas être appelé");
    });
    expect((await recommendStudy(study.id, { db, pack, engine: new Engine(fb2.backend), outDir: dir })).inputsHash).toBe(r.inputsHash);

    // Variante issue d'un fichier : nouveau fichier YAML, projet et étude non lancée sur le même échantillon
    const vdir = mkdtempSync(join(tmpdir(), "var-"));
    const res = createNextStudy(study.id, "prix-bas", { confirm: true, db, pack, outDir: dir, variantsDir: vdir });
    expect(res.projectId).toBe("meal-planner-prix-bas");
    expect(res.projectFile).toBe(join(vdir, "meal-planner-prix-bas.yaml"));
    expect(readFileSync(res.projectFile!, "utf8")).toMatch(/amountEur: 3/);
    const p = getProject(db, res.projectId)!;
    expect(p.name).toBe("Menu Malin");
    expect(p.priceEur).toBe(3);
    expect((p.extra as { variantOf?: string }).variantOf).toBe("meal-planner");
    const s2 = findStudy(db, res.studyId);
    expect(s2.status).toBe("draft");
    expect(s2.personaIds).toEqual(findStudy(db, study.id).personaIds);
    expect(() => createNextStudy(study.id, "prix-bas", { confirm: true, db, pack, outDir: dir, variantsDir: vdir })).toThrow(/existe déjà/);
    expect(() => createNextStudy(study.id, "message", { confirm: true, db, pack, outDir: dir })).toThrow(/ne propose pas/);
    sqlite.close();
  });

  it("écarte une étude suivante au patch invalide, et crée une variante en base sans fichier", async () => {
    const { db, sqlite, study, project } = await setup();
    db.$client.prepare("update projects set extra = json_remove(extra, '$.sourceFile') where id = ?").run(project.id);
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const bad = out("groups[0].analysis.n");
    const good = structuredClone(bad);
    (bad.recommendations[0]!.nextStudy as { projectPatch: object }).projectPatch = { price: { currency: "EUR", offers: [] } };
    const fb = fakeBackend((req) => JSON.stringify(req.messages.length > 1 ? good : bad), 1);
    const r = await recommendStudy(study.id, { db, pack, engine: new Engine(fb.backend), outDir: dir });
    expect(r.verification.repaired).toBe(true);
    expect(r.verification.droppedNextStudies).toEqual([]);
    expect(fb.requests[1]!.messages[2]!.content).toMatch(/patch invalide/);
    const res = createNextStudy(study.id, "prix-bas", { confirm: true, db, pack, outDir: dir });
    expect(res.projectFile).toBeUndefined();
    expect(getProject(db, res.projectId)!.priceEur).toBe(3);
    sqlite.close();
  });
});
