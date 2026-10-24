import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { Engine } from "../../src/engine/engine";
import { createMcpServer, TOOL_NAMES } from "../../src/mcp/server";
import { estimateCost } from "../../src/mcp/estimate";
import type { ReferenceUsage } from "../../src/studies/cost";
import { drawPersonas } from "../../src/personas/sampler";
import { insertPersonas } from "../../src/personas/store";
import { createProject, getProject, projectFileSchema, readProjectFile } from "../../src/studies/project";
import { runStudy } from "../../src/studies/run";
import { findStudy, listStudies } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { Launcher, type SpawnFn } from "../../src/web/launcher";
import { answer, fakeBackend, pack, payer } from "../studies/fixtures";

/** Serveur MCP sur une base temporaire, client en mémoire, moteur simulé : aucun appel LLM réel. */

const dataDir = mkdtempSync(join(tmpdir(), "personas-mcp-"));
const { db, sqlite } = openDb(":memory:");
const spawned: string[][] = [];
const spawnFn: SpawnFn = (_cmd, args) => {
  spawned.push(args);
  return { pid: process.pid, unref() {} };
};
const launcher = new Launcher({ root: process.cwd(), logDir: join(dataDir, "logs"), spawnFn, env: { PATH: "/usr/bin" } });
let replies: (call: number) => string = () => "{}";
const engineCalls: number[] = [];
const server = createMcpServer({
  db,
  pack,
  config: loadConfig({}),
  launcher,
  dataDir,
  engine: () => new Engine(fakeBackend((_req, call) => (engineCalls.push(call), replies(call)), 1).backend, { maxRepairs: 0 }),
});
const client = new Client({ name: "test", version: "0" });

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as Result;
  return { isError: Boolean(r.isError), body: JSON.parse(r.content[0]!.text!) as any };
}

let studyId = "";
let otherId = "";

beforeAll(async () => {
  runMigrations(db);
  insertPersonas(db, drawPersonas(pack, 99, 40));
  const project = createProject(db, readProjectFile("examples/meal-planner.json"));
  const { study } = createStudy(db, pack, { projectId: project.id, n: 10, seed: 7, backend: "ollama", model: "fake" });
  await runStudy(db, new Engine(fakeBackend((_r, c) => JSON.stringify(c % 3 === 0 ? payer() : answer())).backend), pack, study);
  studyId = study.id;
  const { study: other } = createStudy(db, pack, { projectId: project.id, sameSampleAs: study.id, seed: 7, backend: "ollama", model: "fake" });
  await runStudy(db, new Engine(fakeBackend(() => JSON.stringify(answer())).backend), pack, other);
  otherId = other.id;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
});

afterAll(async () => {
  await client.close();
  sqlite.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("serveur MCP : catalogue", () => {
  it("expose les outils prévus, et aucun outil réservé à l'utilisateur", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.some((t) => /accept|neutrali|delete|remove/i.test(t.name))).toBe(false);
    for (const name of ["create_project", "suggest_target", "create_study", "run_study", "recommend"]) {
      const t = tools.find((x) => x.name === name)!;
      expect(Object.keys(t.inputSchema.properties ?? {})).toContain("confirm");
      expect(t.annotations?.readOnlyHint).toBe(false);
    }
    expect(tools.find((t) => t.name === "create_study")!.inputSchema.properties).not.toHaveProperty("force");
    expect(tools.find((t) => t.name === "study_summary")!.description).toMatch(/Indicative only: absolute levels/);
    expect(client.getInstructions()).toMatch(/not an oracle/);
  });
});

describe("serveur MCP : lecture", () => {
  it("liste et décrit les projets", async () => {
    const list = await call("list_projects");
    expect(list.body).toEqual([expect.objectContaining({ id: "meal-planner", price: "5 €/mois", studyCount: 2 })]);
    const p = await call("get_project", { projectId: "meal-planner" });
    expect(p.body.pitchTone.threshold).toBe(25);
    expect(p.body.studies).toHaveLength(2);
    expect((await call("get_project", { projectId: "inconnu" })).isError).toBe(true);
  });

  it("suit l'avancement et résume une étude avec l'indice de confiance et le modèle", async () => {
    const st = await call("study_status", { studyId });
    expect(st.body).toMatchObject({ id: studyId, responses: 10, total: 10, complete: true, backend: "ollama", model: "fake" });
    const s = await call("study_summary", { studyId, verbatims: 2 });
    expect(s.body.model).toEqual({ backend: "ollama", model: "fake", protocolVersion: "4" });
    expect(s.body.confidence.level).toMatch(/high|medium|low/);
    expect(s.body.overall.n).toBe(10);
    expect(s.body.overall.verbatims.length).toBeLessThanOrEqual(2);
    expect(s.body.positioning).toMatch(/objection generator/);
    const full = await call("study_summary", { studyId, full: true });
    expect(full.body.overall.behaviors.bySegment).toBeDefined();
  });

  it("compare deux études", async () => {
    const c = await call("compare_studies", { studyIds: [studyId, otherId] });
    expect(c.isError).toBe(false);
    expect(c.body.entries.map((e: { studyId: string }) => e.studyId)).toEqual([studyId, otherId]);
  });

  it("liste et cherche les modules", async () => {
    const all = await call("list_modules");
    expect(all.body.map((m: { id: string }) => m.id)).toContain("numerique");
    const found = await call("search_modules", { query: "numérique" });
    expect(found.body[0].module.id).toBe("numerique");
    expect((await call("search_modules", { query: "zzzz-introuvable" })).body).toEqual([]);
  });

  it("prévisualise une cible sans pré-tri ni appel LLM", async () => {
    const r = await call("preview_target", { project: readProjectFile("examples/meal-planner-v2.json"), n: 30, sample: 2 });
    expect(r.isError).toBe(false);
    expect(r.body.n).toBe(30);
    expect(r.body.cards).toHaveLength(2);
    expect(r.body.triage).toBeUndefined();
    expect(r.body.eligibility.rate).toBeGreaterThan(0);
  });
});

describe("serveur MCP : écriture avec confirmation", () => {
  const demo = { id: "demo-mcp", name: "Démo MCP", pitch: "Un carnet partagé pour noter les dépenses du foyer, sans publicité.", price: { amountEur: 3, period: "month" } };

  it("create_project : aperçu sans écrire, puis création confirmée ; refuse un schéma invalide et la neutralisation", async () => {
    const pre = await call("create_project", { project: demo });
    expect(pre.body).toMatchObject({ preview: true, id: "demo-mcp", action: "create", plannedLlmCalls: { total: 0, estimatedCost: 0 } });
    expect(getProject(db, "demo-mcp")).toBeUndefined();
    const done = await call("create_project", { project: demo, confirm: true });
    expect(done.body.created).toBe(true);
    expect(getProject(db, "demo-mcp")).toBeDefined();
    expect((await call("create_project", { project: demo, confirm: true })).body.error).toMatch(/existe déjà/);
    const bad = await call("create_project", { project: { name: "x", pitch: "court" } });
    expect(bad.isError).toBe(true);
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toContain("pitch");
    const neutral = await call("create_project", { project: { ...demo, id: "demo-n", pitchOriginal: "texte", pitchNeutralized: true }, confirm: true });
    expect(neutral.body.error).toMatch(/neutralisation du pitch/);
  });

  it("create_study : aperçu simulé sans écriture (estimation des appels), puis création", async () => {
    const before = listStudies(db).length;
    const pre = await call("create_study", { projectId: "meal-planner", n: 20, seed: 3, backend: "ollama", model: "fake" });
    expect(pre.isError).toBe(false);
    expect(pre.body.preview).toBe(true);
    expect(pre.body.sampleSize).toBe(20);
    expect(pre.body.protocolVersion).toBe("4");
    const missing = pre.body.plannedLlmCalls.narratives;
    // Taux de réparation mesuré (table de référence, aucune réponse locale) ; Ollama : modèle local, coût 0
    const repairs = pre.body.plannedLlmCalls.repairs;
    expect(repairs).toBeGreaterThanOrEqual(0);
    expect(pre.body.plannedLlmCalls).toMatchObject({ responses: 20, estimatedCost: 0, costKind: "local", engine: { provider: "ollama", model: "fake" } });
    expect(pre.body.plannedLlmCalls.total).toBe(20 + repairs + missing);
    expect(listStudies(db).length).toBe(before);
    const done = await call("create_study", { projectId: "meal-planner", n: 20, seed: 3, backend: "ollama", model: "fake", confirm: true });
    expect(done.body.created).toBe(true);
    expect(listStudies(db).length).toBe(before + 1);
    expect(findStudy(db, done.body.studyId).sampleSize).toBe(20);
  });

  it("create_study : population ciblée du projet, simulée sans rien laisser en base", async () => {
    createProject(db, readProjectFile("examples/meal-planner-v2.json"));
    const pre = await call("create_study", { projectId: "meal-planner-v2", n: 10, controlN: 5 });
    expect(pre.isError).toBe(false);
    expect(pre.body.populations).toEqual([expect.objectContaining({ group: "target", n: 10 }), expect.objectContaining({ group: "control", n: 5 })]);
    expect(pre.body.backend).toBe("claude-cli");
    // Personas tirées pour la cible : aucune n'a de récit, toutes comptent dans l'estimation
    expect(pre.body.plannedLlmCalls.narratives).toBe(2);
    expect(listStudies(db).filter((s) => s.projectId === "meal-planner-v2")).toHaveLength(0);
  });

  it("create_study : le garde-fou de ton refuse un pitch commercial, sans contournement", async () => {
    const hype =
      "Révolutionnaire ! La meilleure application du marché, incroyable et unique : gagnez des heures chaque semaine, sans effort, garanti. " +
      "Rejoignez dès maintenant des milliers d'utilisateurs conquis, offre exclusive limitée, ne ratez pas ça !";
    createProject(db, projectFileSchema.parse({ id: "demo-survendu", name: "Démo survendue", pitch: hype, price: { amountEur: 9, period: "month" } }));
    const r = await call("create_study", { projectId: "demo-survendu", n: 10, confirm: true, force: true });
    expect(r.isError).toBe(true);
    expect(r.body.reason).toBe("pitch_tone");
    expect(r.body.tone.score).toBeGreaterThan(25);
    expect(r.body.howToFix).toMatch(/no override through MCP/);
    expect(listStudies(db).filter((s) => s.projectId === "demo-survendu")).toHaveLength(0);
  });

  it("run_study : aperçu, lancement détaché non bloquant, refus d'un double lancement et d'une étude complète", async () => {
    const { study } = createStudy(db, pack, { projectId: "meal-planner", n: 10, seed: 11, backend: "ollama", model: "fake" });
    const pre = await call("run_study", { studyId: study.id });
    expect(pre.body).toMatchObject({ preview: true, responsesDone: 0, total: 10, plannedLlmCalls: { responses: 10, estimatedCost: 0, costKind: "local" } });
    expect(spawned).toHaveLength(0);
    const go = await call("run_study", { studyId: study.id, confirm: true });
    expect(go.body.launched).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.join(" ")).toMatch(new RegExp(`src/cli/study-run\\.ts --study ${study.id}`));
    expect((await call("run_study", { studyId: study.id, confirm: true })).body.error).toMatch(/tourne déjà/);
    expect((await call("study_status", { studyId: study.id })).body.run.alive).toBe(true);
    expect((await call("run_study", { studyId, confirm: true })).body.error).toMatch(/déjà complète/);
  });

  it("suggest_target : aperçu sans appel, puis proposition écrite sans rien appliquer", async () => {
    const proposal = {
      analysis: "Il faut être freelance du numérique.",
      usageConditions: [{ condition: "être freelance", attribute: "numerique.work_status", why: "outil pour freelances" }],
      variants: [
        { id: "coeur", label: "Cœur", description: "Freelances", modules: ["numerique"], eligibility: "numerique.work_status in [freelance_micro, freelance_company]", quotas: [], justification: [{ criterion: "freelance", why: "usage" }] },
      ],
      missingModules: [],
      notes: [],
    };
    replies = () => JSON.stringify(proposal);
    engineCalls.length = 0;
    const pre = await call("suggest_target", { projectId: "demo-mcp" });
    // Profil actif par défaut (claude-cli) : coût équivalent API, couvert par l'abonnement
    expect(pre.body).toMatchObject({ preview: true, plannedLlmCalls: { expected: 1, max: 4, costKind: "subscription" } });
    expect(pre.body.plannedLlmCalls.estimatedCost).toBeGreaterThan(0);
    expect(engineCalls).toHaveLength(0);
    const r = await call("suggest_target", { projectId: "demo-mcp", n: 20, confirm: true });
    expect(r.isError).toBe(false);
    expect(engineCalls).toHaveLength(1);
    expect(existsSync(r.body.written)).toBe(true);
    expect(readFileSync(r.body.written, "utf8")).toMatch(/rien n'est appliqué/);
    expect(r.body.suggestion.variants[0].target.modules).toEqual(["numerique"]);
    expect((getProject(db, "demo-mcp")!.extra as { target?: unknown }).target).toBeUndefined();
  });

  it("recommend : aperçu sans appel, puis recommandations vérifiées et mises en cache", async () => {
    const ev = [{ metric: "n", value: "10", source: "groups[0].analysis.n" }];
    replies = () =>
      JSON.stringify({
        headline: "Peu de payeurs.",
        findings: [
          { title: "Effectif", detail: "10 réponses", evidence: ev, strength: "faible" },
          { title: "Objections", detail: "pas de besoin", evidence: ev, strength: "faible" },
        ],
        recommendations: [
          { id: "message", kind: "message", title: "Clarifier le pitch", rationale: "r", evidence: ev, confidence: "faible" },
          { id: "cible", kind: "cible", title: "Resserrer la cible", rationale: "r", evidence: ev, confidence: "faible" },
        ],
        caveats: ["Petit échantillon."],
      });
    engineCalls.length = 0;
    const pre = await call("recommend", { studyId });
    expect(pre.body).toMatchObject({ preview: true, cached: false, plannedLlmCalls: { expected: 1 } });
    expect(engineCalls).toHaveLength(0);
    const r = await call("recommend", { studyId, confirm: true });
    expect(r.isError).toBe(false);
    expect(r.body.headline).toBe("Peu de payeurs.");
    expect(r.body.positioning).toMatch(/not an oracle/);
    expect(engineCalls).toHaveLength(1);
    expect(existsSync(join(dataDir, "recommendations", `${studyId}.json`))).toBe(true);
    expect((await call("recommend", { studyId })).body.cached).toBe(true);
  });
});

describe("estimation des appels", () => {
  const reference: ReferenceUsage = {
    version: 1,
    generatedAt: "2026-10-16",
    note: "test",
    charsPerToken: 3,
    protocols: [{ protocol: "concept-price", version: "3", socle: "fr", provider: "claude-cli", responses: 100, callsPerResponse: 1.1, inputPerCall: 9000, outputPerCall: 1000, cacheReadPerCall: 7000, msPerResponse: 8000 }],
    narratives: { batchSize: 10, batches: 10, inputPerBatch: 5000, outputPerBatch: 7000, method: "test" },
  };
  it("n × (1 + taux de réparation) + ⌈récits manquants / 10⌉, coût au prix du modèle", () => {
    const e = estimateCost({ profile: { name: "p", provider: "openai", model: "gpt-5" }, protocolVersion: "3", socle: "fr", responses: 200, missingNarratives: 35, reference });
    expect(e.calls).toEqual({ responses: 200, repairs: 20, narratives: 4, triage: 0, total: 224 });
    // 220 × 9000 + 4 × 5000 entrée à 1,25 $/M ; 220 × 1000 + 4 × 7000 sortie à 10 $/M (aucune remise de cache supposée)
    expect(e.cost.usd).toBeCloseTo((2_000_000 * 1.25 + 248_000 * 10) / 1e6, 4);
    expect(e.cost.low).toBeCloseTo(e.cost.usd! * 0.7, 4);
    expect(e.cost.high).toBeCloseTo(e.cost.usd! * 1.3, 4);
    expect(e.limits.perStudyUsd).toBe(5);
    // Haut de la fourchette (≈ 6,5 $) au-dessus du plafond par défaut de 5 $ : l'étude se mettra en pause
    expect(e.exceedsStudyCap).toBe(true);
    expect(estimateCost({ profile: { name: "p", provider: "openai", model: "gpt-5" }, protocolVersion: "3", socle: "fr", responses: 0, missingNarratives: 0, reference }).calls.total).toBe(0);
  });
  it("modèle inconnu : coût inconnu et confirmation ; local : 0 ; claude-cli : équivalent abonnement", () => {
    const unknown = estimateCost({ profile: { name: "p", provider: "openai", model: "gpt-unknown-9" }, protocolVersion: "3", socle: "fr", responses: 10, missingNarratives: 0, reference });
    expect(unknown.cost).toMatchObject({ kind: "unknown", usd: null });
    expect(unknown.requiresConfirmation).toBe(true);
    expect(estimateCost({ profile: { name: "ollama", provider: "ollama", model: "qwen" }, protocolVersion: "3", socle: "fr", responses: 10, missingNarratives: 0, reference }).cost).toMatchObject({ kind: "local", usd: 0 });
    const cli = estimateCost({ profile: { name: "claude-cli", provider: "claude-cli", model: "sonnet" }, protocolVersion: "3", socle: "fr", responses: 10, missingNarratives: 0, reference });
    expect(cli.cost.kind).toBe("subscription");
    expect(cli.cost.usd).toBeGreaterThan(0);
    expect(cli.limits.perStudyUsd).toBeUndefined();
  });
});
