import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb, runMigrations } from "../../src/db/client";
import { engineUsage } from "../../src/db/schema";
import { BudgetExceededError, BudgetGuard, dbUsageStore, effectiveLimits, isBudgetExceeded, memoryUsageStore } from "../../src/engine/budget";
import { Engine } from "../../src/engine/engine";
import { isLocalUrl, isPaidProvider, loadPricing, pricingFor, usageCost } from "../../src/engine/pricing";
import type { Backend } from "../../src/engine/types";

function paidBackend(usage = { inputTokens: 10_000, outputTokens: 1_000 }) {
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
      return { text: '{"ok":true}', model: "gpt-5-2025-08-07", usage };
    },
  };
  return { backend, calls: () => calls };
}

describe("prix des modèles (pricing/models.json)", () => {
  it("chaque prix est sourcé et daté", () => {
    const f = loadPricing();
    expect(f.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const m of f.models) expect(f.sources[m.provider]?.url, m.id).toMatch(/^https:\/\//);
    expect(f.models.filter((m) => m.provider === "anthropic").length).toBeGreaterThan(3);
    expect(f.models.filter((m) => m.provider === "openai").length).toBeGreaterThan(3);
    expect(f.models.filter((m) => m.provider === "gemini").length).toBeGreaterThan(3);
  });

  it("identifiants, alias, instantanés datés, préfixes OpenRouter ; un modèle inconnu reste inconnu", () => {
    expect(pricingFor("anthropic", "claude-sonnet-5-5")).toMatchObject({ kind: "paid", price: { id: "claude-sonnet-5-5", input: 2, output: 10 } });
    expect(pricingFor("claude-cli", "sonnet")).toMatchObject({ kind: "subscription", price: { id: "claude-sonnet-5-5" } });
    expect(pricingFor("anthropic", "claude-sonnet-4-5-20250929")).toMatchObject({ kind: "paid", price: { id: "claude-sonnet-4-5" } });
    expect(pricingFor("openai", "gpt-5-2025-08-07")).toMatchObject({ kind: "paid", price: { id: "gpt-5" } });
    // gpt-5-mini n'est pas gpt-5 : le suffixe doit être une date
    expect(pricingFor("openai", "gpt-5-mini")).toMatchObject({ price: { id: "gpt-5-mini" } });
    expect(pricingFor("openrouter", "anthropic/claude-sonnet-4.5")).toMatchObject({ kind: "paid", price: { id: "claude-sonnet-4-5" } });
    expect(pricingFor("gemini", "models/gemini-2.5-flash")).toMatchObject({ kind: "paid", price: { id: "gemini-2.5-flash" } });
    expect(pricingFor("openai", "gpt-9-imaginaire")).toEqual({ kind: "unknown", model: "gpt-9-imaginaire" });
    expect(pricingFor("ollama", "qwen3")).toEqual({ kind: "local" });
    expect(pricingFor("openai-compatible", "qwen3", { baseUrl: "http://localhost:8000/v1" })).toEqual({ kind: "local" });
    expect(pricingFor("openai-compatible", "mystery", { baseUrl: "https://api.example.com/v1" })).toMatchObject({ kind: "unknown" });
  });

  it("coût = entrée hors cache + cache lu + cache écrit + sortie", () => {
    const price = { provider: "anthropic" as const, id: "x", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
    // 1 000 000 d'entrée dont 600 000 lus et 100 000 écrits ; 100 000 de sortie
    expect(usageCost({ inputTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 100_000, outputTokens: 100_000 }, price)).toBeCloseTo(0.6 + 0.06 + 0.25 + 1, 6);
    expect(isLocalUrl("http://nas.local:11434")).toBe(true);
    expect(isLocalUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isPaidProvider("claude-cli")).toBe(false);
    expect(isPaidProvider("openai")).toBe(true);
  });
});

describe("BudgetGuard", () => {
  it("plafond par défaut : 5 $ par étude pour un fournisseur payant, aucun pour claude-cli et ollama", () => {
    expect(effectiveLimits(undefined, true)).toEqual({ perStudyUsd: 5 });
    expect(effectiveLimits({ perDayUsd: 2 }, true)).toEqual({ perDayUsd: 2, perStudyUsd: 5 });
    expect(effectiveLimits(undefined, false)).toEqual({});
  });

  it("refuse l'appel qui ferait dépasser le plafond, avant de l'envoyer ; cumule usage × prix", async () => {
    const store = memoryUsageStore();
    const fake = paidBackend();
    const pricing = pricingFor("openai", "gpt-5");
    const guard = new BudgetGuard({ store, profile: "perso", provider: "openai", model: "gpt-5", pricing, limits: { perStudyUsd: 0.045 }, studyId: "st-test" });
    const engine = new Engine(fake.backend).withBudget(guard);
    const req = { system: "s", messages: [{ role: "user" as const, content: "x" }], schema: z.object({ ok: z.boolean() }), maxTokens: 100 };
    // 10 000 × 1,25 $/M + 1 000 × 10 $/M = 0,0225 $ par appel
    await engine.complete(req);
    await engine.complete(req);
    expect(store.rows).toHaveLength(2);
    for (const r of store.rows) expect(r.costUsd).toBeCloseTo(0.0225, 10);
    expect(store.rows[0]).toMatchObject({ studyId: "st-test", profile: "perso", model: "gpt-5-2025-08-07" });
    const err = await engine.complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(isBudgetExceeded(err)).toBe(true);
    expect((err as BudgetExceededError).scope).toBe("study");
    expect((err as Error).message).toMatch(/Plafond de dépense atteint \(par étude, profil perso\)/);
    expect(fake.calls()).toBe(2); // le troisième appel n'est pas parti
    // Une autre étude du même profil a son propre plafond ; le plafond journalier vaut pour tout le profil
    await guard.forStudy("st-autre").check(0.01);
    const daily = new BudgetGuard({ store, profile: "perso", provider: "openai", model: "gpt-5", pricing, limits: { perDayUsd: 0.05 }, studyId: "st-autre" });
    expect(() => daily.check(0.01)).toThrow(BudgetExceededError);
  });

  it("enregistre l'usage dans la table engine_usage (coût nul en local, inconnu → null)", () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const store = dbUsageStore(db);
    const at = new Date("2026-10-16T10:00:00Z");
    new BudgetGuard({ store, profile: "p", provider: "openai", model: "gpt-5", pricing: pricingFor("openai", "gpt-5"), limits: {}, studyId: "st-a", now: () => at }).record({ inputTokens: 1000, outputTokens: 100 }, "gpt-5");
    new BudgetGuard({ store, profile: "ollama", provider: "ollama", model: "q", pricing: { kind: "local" }, limits: {}, now: () => at }).record({ inputTokens: 1000, outputTokens: 100 }, "q");
    new BudgetGuard({ store, profile: "x", provider: "openai", model: "zz", pricing: { kind: "unknown", model: "zz" }, limits: {}, now: () => at }).record({ inputTokens: 1000, outputTokens: 100 }, "zz");
    const rows = db.select().from(engineUsage).all();
    expect(rows[0]!.costUsd).toBeCloseTo(0.00225, 10);
    expect(rows.map((r) => [r.profile, r.day, r.month, r.profile === "p" ? "≈" : r.costUsd])).toEqual([
      ["p", "2026-10-16", "2026-10", "≈"],
      ["ollama", "2026-10-16", "2026-10", 0],
      ["x", "2026-10-16", "2026-10", null],
    ]);
    expect(store.committed({ scope: "study", profile: "p", studyId: "st-a", at })).toBeCloseTo(0.00225, 8);
    expect(store.committed({ scope: "day", profile: "p", studyId: null, at })).toBeCloseTo(0.00225, 8);
    expect(store.committed({ scope: "month", profile: "p", studyId: null, at: new Date("2026-11-01T00:00:00Z") })).toBe(0);
    sqlite.close();
  });
});
