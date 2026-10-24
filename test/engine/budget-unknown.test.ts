import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb, runMigrations } from "../../src/db/client";
import { BudgetExceededError, BudgetGuard, dbUsageStore, fmtUsd, isBudgetExceeded, memoryUsageStore, UnknownCostBlockedError } from "../../src/engine/budget";
import { Engine } from "../../src/engine/engine";
import { loadPricing, PRICING_FILE, PricingFileMissingError, pricingFor, prudentPrice } from "../../src/engine/pricing";
import { engineInfoOf, studyAcceptsUnknownCost } from "../../src/engine/select";
import type { Backend } from "../../src/engine/types";
import { insertPersonas } from "../../src/personas/store";
import { drawPersonas } from "../../src/personas/sampler";
import { createProject, readProjectFile } from "../../src/studies/project";
import { runStudy } from "../../src/studies/run";
import { findStudy } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { answer, pack } from "../studies/fixtures";

/**
 * Bug B2 des tests V1 : un plafond ne protégeait rien quand le prix du modèle était inconnu (15 complétions
 * envoyées sous un plafond de 0,0002 $). Le BudgetGuard échoue désormais fermé.
 */

/** Faux fournisseur OpenAI au modèle absent de pricing/models.json ; compte les requêtes. */
function unknownBackend(text: () => string = () => JSON.stringify({ ok: true })) {
  let calls = 0;
  const backend: Backend = {
    name: "openai",
    model: "modele-inconnu",
    concurrency: 1,
    async checkAvailability() {
      return { ok: true, detail: "simulé" };
    },
    async generate() {
      calls++;
      return { text: text(), model: "modele-inconnu", usage: { inputTokens: 10_000, outputTokens: 1_000 } };
    },
  };
  return { backend, calls: () => calls };
}

const req = { system: "s", messages: [{ role: "user" as const, content: "x" }], schema: z.object({ ok: z.boolean() }), maxTokens: 100 };
const unknown = pricingFor("openai", "modele-inconnu");

describe("plafond et prix inconnu (B2)", () => {
  it("le prix du modèle est bien inconnu", () => {
    expect(unknown.kind).toBe("unknown");
  });

  it("plafond défini + prix inconnu, sans accord : aucune requête ne part, erreur dédiée", async () => {
    const fake = unknownBackend();
    const guard = new BudgetGuard({ store: memoryUsageStore(), profile: "t-cap", provider: "openai", model: "modele-inconnu", pricing: unknown, limits: { perStudyUsd: 0.0002 }, studyId: "st-x" });
    const err = await new Engine(fake.backend).withBudget(guard).complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownCostBlockedError);
    expect(isBudgetExceeded(err)).toBe(true); // l'étude se met en pause
    expect((err as Error).message).toMatch(/Plafond de dépense non vérifiable \(profil t-cap\) : prix du modèle modele-inconnu inconnu/);
    expect((err as Error).message).toMatch(/--accept-unknown-cost/);
    expect(fake.calls()).toBe(0);
  });

  it("plafond journalier seul (assistant hors étude) : refusé aussi ; sans plafond applicable : l'appel part", async () => {
    const daily = unknownBackend();
    const g = new BudgetGuard({ store: memoryUsageStore(), profile: "p", provider: "openai", model: "modele-inconnu", pricing: unknown, limits: { perDayUsd: 1 } });
    await expect(new Engine(daily.backend).withBudget(g).complete(req)).rejects.toBeInstanceOf(UnknownCostBlockedError);
    expect(daily.calls()).toBe(0);
    // Plafond par étude sans étude imputée : pas de plafond applicable (comportement inchangé)
    const free = unknownBackend();
    const g2 = new BudgetGuard({ store: memoryUsageStore(), profile: "p", provider: "openai", model: "modele-inconnu", pricing: unknown, limits: { perStudyUsd: 5 } });
    await new Engine(free.backend).withBudget(g2).complete(req);
    expect(free.calls()).toBe(1);
  });

  it("coût inconnu accepté : compté au prix prudent (le plus cher du fournisseur), le plafond bas arrête avant tout envoi", async () => {
    const p = prudentPrice("openai")!;
    const openai = loadPricing().models.filter((m) => m.provider === "openai");
    expect(p.input).toBe(Math.max(...openai.map((m) => m.input)));
    expect(p.output).toBe(Math.max(...openai.map((m) => m.output)));
    expect(p.cacheRead).toBe(p.input); // aucune remise de cache supposée

    const fake = unknownBackend();
    const low = new BudgetGuard({ store: memoryUsageStore(), profile: "t-cap", provider: "openai", model: "modele-inconnu", pricing: unknown, limits: { perStudyUsd: 0.0002 }, studyId: "st-x", acceptUnknownCost: true });
    expect(low.fallbackPrice).toEqual(p);
    const err = await new Engine(fake.backend).withBudget(low).complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toMatch(/> 0\.0002 \$/); // B11 : petit plafond lisible
    expect(fake.calls()).toBe(0);

    // Plafond suffisant : l'appel part et son coût est cumulé au prix prudent (le plafond suivant le compte)
    const store = memoryUsageStore();
    const ok = new BudgetGuard({ store, profile: "t-cap", provider: "openai", model: "modele-inconnu", pricing: unknown, limits: { perStudyUsd: 10 }, studyId: "st-x", acceptUnknownCost: true });
    await new Engine(fake.backend).withBudget(ok).complete(req);
    expect(fake.calls()).toBe(1);
    expect(store.rows[0]!.costUsd).toBeCloseTo((10_000 * p.input + 1_000 * p.output) / 1e6, 10);
  });

  it("accord sans prix prudent possible (table sans modèle du fournisseur) : refusé", () => {
    const g = new BudgetGuard({ store: memoryUsageStore(), profile: "p", provider: "openai", model: "x", pricing: unknown, limits: { perStudyUsd: 1 }, studyId: "s", acceptUnknownCost: true, prudentPrice: null });
    expect(() => g.check(0)).toThrow(UnknownCostBlockedError);
  });

  it("étude au modèle inconnu, plafond bas, faux fournisseur : pause avant la première requête ; l'accord est enregistré dans l'étude", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 30));
    const project = createProject(db, readProjectFile("examples/meal-planner.json"));
    const profile = { name: "t-cap", provider: "openai" as const, model: "modele-inconnu" };
    const { study } = createStudy(db, pack, { projectId: project.id, n: 5, seed: 7, backend: "openai", model: "modele-inconnu", engine: engineInfoOf(profile), protocolVersion: "2" });
    expect(studyAcceptsUnknownCost(study)).toBe(false);
    const fake = unknownBackend(() => JSON.stringify(answer()));
    const guard = new BudgetGuard({ store: dbUsageStore(db), profile: "t-cap", provider: "openai", model: "modele-inconnu", pricing: unknown, limits: { perStudyUsd: 0.0002 }, studyId: study.id });
    const r = await runStudy(db, new Engine(fake.backend).withBudget(guard), pack, study, { concurrency: 2 });
    expect(r.written).toBe(0);
    expect(r.stoppedForBudget).toMatch(/^Plafond de dépense non vérifiable/);
    expect(findStudy(db, study.id).status).toBe("paused");
    expect(fake.calls()).toBe(0);

    const accepted = createStudy(db, pack, { projectId: project.id, n: 5, seed: 8, backend: "openai", model: "modele-inconnu", engine: engineInfoOf(profile, { acceptUnknownCost: true }), protocolVersion: "2" });
    expect(studyAcceptsUnknownCost(accepted.study)).toBe(true);
    sqlite.close();
  });
});

describe("fichier de prix livré (B1)", () => {
  it("absent : erreur explicite, pas une table vide", () => {
    const dir = mkdtempSync(join(tmpdir(), "personas-pricing-"));
    try {
      expect(() => loadPricing(join(dir, "absent.json"))).toThrow(PricingFileMissingError);
      expect(() => loadPricing(join(dir, "absent.json"))).toThrow(/Fichier de prix introuvable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(new PricingFileMissingError(PRICING_FILE, true).message).toMatch(/installation incomplète/);
  });
});

describe("affichage des montants (B11)", () => {
  it("4 décimales sous 0,01 $", () => {
    expect(fmtUsd(0.0002)).toBe("0.0002");
    expect(fmtUsd(0)).toBe("0.00");
    expect(fmtUsd(0.05)).toBe("0.05");
    expect(fmtUsd(5)).toBe("5.00");
  });
});
