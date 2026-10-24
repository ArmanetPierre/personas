import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { BudgetGuard, dbUsageStore } from "../../src/engine/budget";
import { Engine } from "../../src/engine/engine";
import { pricingFor } from "../../src/engine/pricing";
import { emptyEngineConfig, saveEngineConfig, upsertProfile } from "../../src/engine/profiles";
import { ANTHROPIC_API_REFUSED, chooseProfile, engineInfoOf, profileForStudy, studyEngineInfo } from "../../src/engine/select";
import type { Backend } from "../../src/engine/types";
import { insertPersonas } from "../../src/personas/store";
import { drawPersonas } from "../../src/personas/sampler";
import { confidenceIndex } from "../../src/studies/confidence";
import { DEFAULT_CALIBRATION, loadCalibration, loadCalibrationFor, modelFamily } from "../../src/studies/payment";
import { createProject, readProjectFile } from "../../src/studies/project";
import { QUESTION_KEY } from "../../src/studies/protocols/concept-price";
import { runStudy } from "../../src/studies/run";
import { findStudy, studyResponses } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { summarize } from "../../src/studies/summary";
import { personasByIds } from "../../src/studies/store";
import { answer, pack } from "./fixtures";

/** Faux fournisseur payant (OpenAI, gpt-5) : 10 000 tokens d'entrée et 1 000 de sortie par appel, soit 0,0225 $. */
function paidBackend() {
  let calls = 0;
  const backend: Backend = {
    name: "openai",
    model: "gpt-5",
    concurrency: 1,
    async checkAvailability() {
      return { ok: true, detail: "simulé" };
    },
    async generate() {
      calls++;
      return { text: JSON.stringify(answer()), model: "gpt-5-2025-08-07", usage: { inputTokens: 10_000, outputTokens: 1_000 } };
    },
  };
  return { backend, calls: () => calls };
}

function setup() {
  const { db, sqlite } = openDb(":memory:");
  runMigrations(db);
  insertPersonas(db, drawPersonas(pack, 99, 30));
  const project = createProject(db, readProjectFile("examples/meal-planner.json"));
  const profile = { name: "perso-openai", provider: "openai" as const, model: "gpt-5" };
  const { study } = createStudy(db, pack, { projectId: project.id, n: 8, seed: 7, backend: "openai", model: "gpt-5", engine: engineInfoOf(profile), protocolVersion: "2" });
  return { db, sqlite, study, profile };
}

const guardFor = (db: ReturnType<typeof setup>["db"], studyId: string, perStudyUsd: number) =>
  new BudgetGuard({ store: dbUsageStore(db), profile: "perso-openai", provider: "openai", model: "gpt-5", pricing: pricingFor("openai", "gpt-5"), limits: { perStudyUsd }, studyId });

describe("plafond de dépense : pause puis reprise", () => {
  it("met l'étude en pause au plafond, sans réponse perdue, puis reprend après relèvement sans refaire les réponses", async () => {
    const { db, sqlite, study } = setup();
    expect(studyEngineInfo(study)).toMatchObject({ provider: "openai", model: "gpt-5", profile: "perso-openai" });
    const fake = paidBackend();
    const base = new Engine(fake.backend);
    // Plafond 0,08 $ : trois réponses (0,0675 $) passent, la quatrième dépasserait
    const r1 = await runStudy(db, base.withBudget(guardFor(db, study.id, 0.08)), pack, study, { concurrency: 1 });
    expect(r1.stoppedForBudget).toMatch(/Plafond de dépense atteint \(par étude, profil perso-openai\)/);
    expect(r1.written).toBeGreaterThan(0);
    expect(r1.written).toBeLessThan(8);
    const paused = findStudy(db, study.id);
    expect(paused.status).toBe("paused");
    expect(paused.error).toMatch(/Plafond de dépense atteint/);
    // Modèle exact rapporté par l'API, figé dans l'étude
    expect(studyEngineInfo(paused)?.reportedModel).toBe("gpt-5-2025-08-07");
    const before = studyResponses(db, study.id, QUESTION_KEY);
    expect(before).toHaveLength(r1.written);
    const committed = dbUsageStore(db).committed({ scope: "study", profile: "perso-openai", studyId: study.id, at: new Date() });
    expect(committed).toBeLessThanOrEqual(0.08);
    const callsAtPause = fake.calls();

    // Relance sans relever le plafond : rien ne part
    const r2 = await runStudy(db, base.withBudget(guardFor(db, study.id, 0.08)), pack, findStudy(db, study.id), { concurrency: 1 });
    expect(r2.written).toBe(0);
    expect(r2.stoppedForBudget).not.toBeNull();
    expect(fake.calls()).toBe(callsAtPause);

    // Plafond relevé : reprise des seules réponses manquantes
    const r3 = await runStudy(db, base.withBudget(guardFor(db, study.id, 10)), pack, findStudy(db, study.id), { concurrency: 1 });
    expect(r3.stoppedForBudget).toBeNull();
    expect(r3.alreadyDone).toBe(before.length);
    expect(r3.written).toBe(8 - before.length);
    const after = studyResponses(db, study.id, QUESTION_KEY);
    expect(after).toHaveLength(8);
    expect(new Set(after.map((r) => r.personaId)).size).toBe(8);
    for (const r of before) expect(after.find((x) => x.personaId === r.personaId)?.id).toBe(r.id);
    expect(findStudy(db, study.id).status).toBe("completed");
    sqlite.close();
  });
});

describe("choix du moteur", () => {
  it("sans profil configuré : claude-cli de l'environnement, comme avant ; --backend garde son sens ; anthropic-api refusé", () => {
    const config = loadConfig({});
    const env = { VITEST: "1" } as NodeJS.ProcessEnv;
    const dir = mkdtempSync(join(tmpdir(), "personas-select-"));
    const path = join(dir, "config.json");
    try {
      expect(chooseProfile(config, { env, path })).toMatchObject({ name: "claude-cli", provider: "claude-cli", model: config.CLAUDE_CLI_MODEL });
      expect(chooseProfile(config, { env, path, backend: "ollama" })).toMatchObject({ name: "ollama", model: config.OLLAMA_MODEL });
      expect(chooseProfile(config, { env, path, model: "opus" })).toMatchObject({ name: "claude-cli", model: "opus" });
      expect(() => chooseProfile(config, { env, path, backend: "anthropic-api" })).toThrow(ANTHROPIC_API_REFUSED);
      saveEngineConfig(upsertProfile(emptyEngineConfig(), { name: "cle-anthropic", provider: "anthropic", model: "claude-sonnet-5-5" }), path);
      expect(chooseProfile(config, { env, path, profile: "cle-anthropic" })).toMatchObject({ provider: "anthropic" });
      expect(chooseProfile(config, { env: { ...env, PERSONAS_PROFILE: "cle-anthropic" }, path })).toMatchObject({ name: "cle-anthropic" });
      // Étude existante : profil enregistré, sinon profil intégré du backend ; fournisseur vérifié
      const legacy = { id: "st-old", backend: "claude-cli", model: "sonnet", extra: {} };
      expect(profileForStudy(legacy, config, { env, path })).toMatchObject({ name: "claude-cli", model: "sonnet" });
      const withProfile = { id: "st-new", backend: "anthropic", model: "claude-sonnet-5-5", extra: { engine: engineInfoOf({ name: "cle-anthropic", provider: "anthropic", model: "claude-sonnet-5-5" }) } };
      expect(profileForStudy(withProfile, config, { env, path })).toMatchObject({ name: "cle-anthropic" });
      expect(() => profileForStudy(withProfile, config, { env, path, profile: "claude-cli" })).toThrow(/ne correspond pas/);
      expect(() => profileForStudy({ id: "st-x", backend: "anthropic-api", model: "m", extra: {} }, config, { env, path })).toThrow(/anthropic-api refusé/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("indice de confiance : calibré pour ce modèle", () => {
  it("familles de modèle", () => {
    expect(modelFamily("claude-cli", "sonnet")).toBe("claude-sonnet");
    expect(modelFamily("claude-cli", "claude-sonnet-5-5")).toBe("claude-sonnet");
    expect(modelFamily("anthropic", "claude-3-5-sonnet-20241022")).toBe("claude-sonnet");
    expect(modelFamily("openrouter", "anthropic/claude-opus-4.5")).toBe("claude-opus");
    expect(modelFamily("openai", "gpt-5-2025-08-07")).toBe("gpt-5");
    expect(modelFamily("ollama", "user/qwen3.8-27b-q8:32k")).toBe("qwen3.8");
    expect(loadCalibrationFor("claude-sonnet")).toEqual(loadCalibration());
    expect(loadCalibrationFor("gpt-5")).toBeNull();
  });

  it("modèle absent de la table : perd le point et reçoit la réserve ; Sonnet : indice inchangé", () => {
    const calibrated = { ...DEFAULT_CALIBRATION, status: "calibrated" as const };
    const base = { protocolVersion: "3", group: null, n: 200, repeats: [], calibration: calibrated, pitch: { score: 5, threshold: 25, neutralized: false, measuredOn: "responses" as const } };
    const legacy = confidenceIndex(base);
    const sonnet = confidenceIndex({ ...base, model: { family: "claude-sonnet", inTable: true } });
    expect(sonnet).toEqual(legacy);
    expect(sonnet.score).toBe(3);
    const gpt = confidenceIndex({ ...base, model: { family: "gpt-5", inTable: false } });
    expect(gpt.score).toBe(2);
    expect(gpt.protocol).toMatchObject({ calibrated: false, model: { family: "gpt-5", calibrated: false } });
    expect(gpt.caveats[0]).toBe("Modèle non calibré (gpt-5) : les niveaux absolus n'ont été comparés au réel que sur Sonnet.");
    const gptEn = confidenceIndex({ ...base, model: { family: "gpt-5", inTable: false }, locale: "en" });
    expect(gptEn.caveats[0]).toMatch(/^Model not calibrated \(gpt-5\)/);
  });

  it("résumé : le moteur figé est ajouté (champ additif) et le modèle non calibré est signalé", async () => {
    const { db, sqlite, study } = setup();
    await runStudy(db, new Engine(paidBackend().backend), pack, study, { concurrency: 1 });
    const s = findStudy(db, study.id);
    const rows = studyResponses(db, s.id, QUESTION_KEY);
    const ps = new Map(personasByIds(db, rows.map((r) => r.personaId)).map((p) => [p.id, p]));
    const project = createProject(db, readProjectFile("examples/meal-planner.json"), { update: true });
    const sum = summarize(pack, s, project, rows, ps);
    expect(sum.study.engine).toMatchObject({ provider: "openai", model: "gpt-5", reportedModel: "gpt-5-2025-08-07", profile: "perso-openai" });
    expect(sum.confidence?.protocol.model).toEqual({ family: "gpt-5", calibrated: false });
    expect(sum.confidence?.caveats.some((c) => c.startsWith("Modèle non calibré (gpt-5)"))).toBe(true);
    sqlite.close();
  });
});
