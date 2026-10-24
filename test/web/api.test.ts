import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { Engine } from "../../src/engine/engine";
import { drawPersonas } from "../../src/personas/sampler";
import { insertPersonas } from "../../src/personas/store";
import { createProject, readProjectFile } from "../../src/studies/project";
import { runStudy } from "../../src/studies/run";
import { findStudy } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { createApp } from "../../src/web/app";
import { childEnv, Launcher, type SpawnFn } from "../../src/web/launcher";
import { answer, fakeBackend, pack, payer } from "../studies/fixtures";

/** Routes de l'API du tableau de bord, sur une base temporaire migrée et un moteur simulé. */

const logDir = mkdtempSync(join(tmpdir(), "personas-web-"));
const { db, sqlite } = openDb(":memory:");
const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv; detached: boolean | undefined }> = [];
const spawnFn: SpawnFn = (_cmd, args, opts) => {
  spawned.push({ args, env: opts.env ?? {}, detached: opts.detached });
  // pid du processus de test : « vivant », ce qui permet de tester le refus d'un double lancement
  return { pid: process.pid, unref() {} };
};
const launcher = new Launcher({
  root: process.cwd(),
  logDir,
  spawnFn,
  env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "cle-qui-ne-doit-pas-passer", ANTHROPIC_BASE_URL: "http://x", CLAUDE_CODE_USE_BEDROCK: "1", HOME: "/tmp" },
});
const app = createApp({ db, pack, config: loadConfig({}), launcher });
const get = async <T = any>(path: string) => {
  const res = await app.request(`/api${path}`);
  return { status: res.status, body: (await res.json()) as T };
};
const post = async <T = any>(path: string, json?: unknown) => {
  const res = await app.request(`/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, body: (await res.json()) as T };
};

let studyId = "";
let otherId = "";
let draftId = "";

beforeAll(async () => {
  runMigrations(db);
  insertPersonas(db, drawPersonas(pack, 99, 40));
  const project = createProject(db, readProjectFile("examples/meal-planner.json"));
  const { study } = createStudy(db, pack, { projectId: project.id, n: 10, seed: 7, backend: "ollama", model: "fake" });
  const { backend } = fakeBackend((_req, call) => JSON.stringify(call % 3 === 0 ? payer() : answer()));
  await runStudy(db, new Engine(backend), pack, study);
  studyId = study.id;
  const { study: other } = createStudy(db, pack, { projectId: project.id, sameSampleAs: study.id, seed: 7, backend: "ollama", model: "fake" });
  await runStudy(db, new Engine(fakeBackend(() => JSON.stringify(answer())).backend), pack, other);
  otherId = other.id;
});

afterAll(() => {
  sqlite.close();
  rmSync(logDir, { recursive: true, force: true });
});

describe("API du tableau de bord", () => {
  it("sert les libellés et les populations", async () => {
    const { status, body } = await get("/meta");
    expect(status).toBe(200);
    expect(body.behaviors.map((b: { id: string }) => b.id)).toContain("pay_subscription");
    expect(body.packs[0]).toMatchObject({ packVersion: pack.manifest.version, n: 40 });
    expect(body.backends.map((b: { id: string }) => b.id)).toEqual(["claude-cli", "ollama"]);
  });

  it("liste les projets avec leurs études", async () => {
    const { body } = await get("/projects");
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "meal-planner", price: "5 €/mois", unit: "mois", studyCount: 2 });
    const detail = await get(`/projects/meal-planner`);
    expect(detail.body.studies).toHaveLength(2);
    expect(detail.body.project.priceTiers).toEqual([2, 5, 9]);
    expect((await get("/projects/inconnu")).status).toBe(404);
  });

  it("valide un projet avec le schéma zod du fichier projet", async () => {
    const bad = await post("/projects", { name: "X", pitch: "court", price: { amountEur: -1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(["pitch", "price.amountEur"]));
    const ok = await post("/projects", { name: "Carnet de bord", pitch: "Un carnet partagé pour suivre les chantiers de la maison.", price: { amountEur: 3, period: "month" } });
    expect(ok.status).toBe(201);
    expect(ok.body.id).toBe("carnet-de-bord");
    expect((await post("/projects", { name: "Carnet de bord", pitch: "Un carnet partagé pour suivre les chantiers.", price: { amountEur: 3 } })).status).toBe(409);
  });

  it("importe un fichier projet JSON ou YAML", async () => {
    const json = readFileSync("examples/meal-planner.json", "utf8").replace('"id": "meal-planner"', '"id": "import-json"');
    expect((await post("/projects/import", { content: json, filename: "p.json" })).status).toBe(201);
    const yaml = "name: Import YAML\npitch: Un service pour réserver un créneau chez le coiffeur du quartier.\nprice:\n  amountEur: 4\n";
    const res = await post("/projects/import", { content: yaml, filename: "p.yaml" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "import-yaml", price: "4 €/mois" });
    expect((await post("/projects/import", { content: "{pas du json", filename: "p.json" })).status).toBe(400);
  });

  it("crée une étude à deux groupes, et une étude sur le même échantillon", async () => {
    const res = await post("/studies", {
      projectId: "meal-planner",
      seed: 3,
      backend: "claude-cli",
      target: { packVersion: pack.manifest.version, n: 4 },
      control: { packVersion: pack.manifest.version, n: 2 },
    });
    expect(res.status).toBe(201);
    expect(res.body.study.populations.map((p: { group: string; n: number }) => [p.group, p.n])).toEqual([["target", 4], ["control", 2]]);
    expect(res.body.study.model).toBe("sonnet");
    draftId = res.body.study.id;
    const same = await post("/studies", { projectId: "meal-planner", backend: "ollama", sameSampleAs: draftId, sameSampleGroup: "target" });
    expect(same.status).toBe(201);
    expect(same.body.study.sampleSize).toBe(4);
    expect((await post("/studies", { projectId: "meal-planner", backend: "anthropic-api", target: { packVersion: "x", n: 1 } })).status).toBe(400);
    expect((await post("/studies", { projectId: "meal-planner", backend: "ollama" })).status).toBe(400);
  });

  it("donne l'état, le résumé et les réponses d'une étude", async () => {
    const st = await get(`/studies/${studyId}`);
    expect(st.body.study).toMatchObject({ id: studyId, status: "completed", responses: 10, total: 10, displayStatus: "completed" });
    expect(st.body.study.personaIds).toBeUndefined();
    const sum = await get(`/studies/${studyId}/summary`);
    expect(sum.status).toBe(200);
    expect(sum.body.overall.n).toBe(10);
    expect(sum.body.unit).toBe("mois");
    expect(sum.body.overall.gaborGranger.tiers.map((t: { price: number }) => t.price)).toEqual([2, 5, 9]);
    const rows = await get(`/studies/${studyId}/responses`);
    expect(rows.body).toHaveLength(10);
    expect(rows.body[0]).toHaveProperty("segments.ageBand.label");
    const one = await get(`/studies/${studyId}/responses/${rows.body[0].personaId}`);
    expect(one.body.persona.facts.length).toBeGreaterThan(5);
    expect(one.body.response.rawText).toBeUndefined();
    expect((await get(`/studies/${studyId}/responses/inconnue`)).status).toBe(404);
    expect((await get(`/studies/${draftId}/summary`)).status).toBe(404);
    expect((await get(`/studies/st-zzzzzz`)).status).toBe(404);
  });

  it("compare deux études avec src/studies/compare.ts", async () => {
    const { status, body } = await get(`/compare?ids=${studyId},${otherId}`);
    expect(status).toBe(200);
    expect(body.referenceId).toBe(studyId);
    expect(body.entries).toHaveLength(2);
    expect(body.deltas[1].payers).toBeLessThan(0);
    expect((await get(`/compare?ids=${studyId}`)).status).toBe(400);
  });

  it("pagine et filtre les personas", async () => {
    const all = await get(`/personas?pageSize=10`);
    expect(all.body.total).toBe(40);
    expect(all.body.items).toHaveLength(10);
    const old = await get(`/personas?ageMin=60`);
    expect(old.body.items.every((p: { age: number }) => p.age >= 60)).toBe(true);
    const seg = await get(`/personas?seg.ageBand=18-29`);
    expect(seg.body.items.every((p: { segments: { ageBand: { code: string } } }) => p.segments.ageBand.code === "18-29")).toBe(true);
    expect(seg.body.facets.ageBand.length).toBeGreaterThan(1);
    const card = await get(`/personas/${all.body.items[0].id}`);
    expect(card.body.id).toBe(all.body.items[0].id);
  });

  it("lance study:run dans un processus détaché, sans aucune variable ANTHROPIC_*", async () => {
    expect((await post(`/studies/${studyId}/run`)).status).toBe(409); // déjà complète
    const res = await post(`/studies/${draftId}/run`);
    expect(res.status).toBe(202);
    expect(spawned).toHaveLength(1);
    const child = spawned[0]!;
    expect(child.detached).toBe(true);
    expect(child.args.slice(-3)).toEqual(["src/cli/study-run.ts", "--study", draftId]);
    expect(Object.keys(child.env).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);
    expect(child.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(child.env.PATH).toBe("/usr/bin");
    expect(res.body.run.logPath).toContain(logDir);
    // Le processus (simulé) tourne encore : pas de second lancement
    expect((await post(`/studies/${draftId}/run`)).status).toBe(409);
    const st = await get(`/studies/${draftId}/progress`);
    expect(st.body.run).toMatchObject({ alive: true });
    expect((await get(`/studies/${draftId}/log`)).body.logPath).toContain(draftId);
  });

  it("estime le coût avant lancement (création simulée) et exige une confirmation pour un coût inconnu", async () => {
    const before = (await get<unknown[]>("/studies")).body.length;
    const body = { projectId: "meal-planner", seed: 7, backend: "claude-cli", target: { packVersion: pack.manifest.version, n: 10 } };
    const e = await post("/studies/estimate", body);
    expect(e.status).toBe(200);
    expect(e.body.estimate).toMatchObject({ profile: "claude-cli", provider: "claude-cli", calls: { responses: 10 }, cost: { kind: "subscription" }, sampleSize: 10 });
    expect(e.body.estimate.cost.high).toBeGreaterThan(e.body.estimate.cost.low);
    const local = await get(`/projects/meal-planner/estimate?n=12&backend=ollama`);
    expect(local.body.estimate).toMatchObject({ provider: "ollama", calls: { responses: 12 }, cost: { kind: "local", usd: 0 } });
    expect((await get<unknown[]>("/studies")).body.length).toBe(before); // rien n'a été créé
    // Modèle sans prix : refus structuré, puis création avec la confirmation explicite
    const unknown = { ...body, model: "claude-imaginaire-9" };
    expect((await post("/studies/estimate", unknown)).body.estimate).toMatchObject({ cost: { kind: "unknown", usd: null }, requiresConfirmation: true });
    const refused = await post("/studies", unknown);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("unknown_cost");
    const created = await post("/studies", { ...unknown, acceptUnknownCost: true });
    expect(created.status).toBe(201);
    expect(created.body.study.engine).toMatchObject({ provider: "claude-cli", model: "claude-imaginaire-9", profile: "claude-cli" });
    // L'accord est enregistré dans l'étude : le garde-fou de budget ne la met pas en pause au premier appel
    expect(findStudy(db, created.body.study.id).extra).toMatchObject({ engine: { acceptUnknownCost: true } });
    expect(findStudy(db, (await post("/studies", body)).body.study.id).extra).not.toMatchObject({ engine: { acceptUnknownCost: true } });
    const meta = await get("/meta");
    expect(meta.body.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ name: "claude-cli", pricing: "subscription", paid: false })]));
    expect(JSON.stringify(meta.body.profiles)).not.toMatch(/key|secret|token/i);
  });

  it("base neuve : socles proposés, tirage à la demande d'un socle, erreurs de validation lisibles", async () => {
    const meta = await get("/meta");
    expect(meta.body.socles).toEqual(expect.arrayContaining([{ id: "fr", pack: "fr-2026.2" }]));
    const before = (await get<unknown[]>("/studies")).body.length;
    // Socle sans persona en base : tirage virtuel (sans LLM) dans une création simulée, rien n'est écrit
    const e = await post("/studies/estimate", { projectId: "meal-planner", seed: 7, backend: "ollama", model: "fake", target: { socle: "fr", n: 5 } });
    expect(e.status).toBe(200);
    expect(e.body.estimate).toMatchObject({ sampleSize: 5, calls: { responses: 5 }, basis: { socle: "fr", forVersion: "4" } });
    expect((await get<unknown[]>("/studies")).body.length).toBe(before);
    // Ni pack ni socle : message guidé, pas le message brut de Zod
    const bad = await post("/studies/estimate", { projectId: "meal-planner", seed: 7, backend: "ollama", target: { packVersion: "", n: 5 } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "invalid_study", error: "Population cible : choisir un pack ou un socle." });
    const res = await app.request("/api/studies/estimate?lang=en", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "meal-planner", seed: 7, backend: "ollama", target: { n: 0 }, control: { packVersion: "x", n: 3 } }),
    });
    const en = (await res.json()) as { error: string };
    expect(en.error).toBe("Target sample size: positive whole number expected. Target population: choose a pack or a base population.");
    expect(en.error).not.toMatch(/Too small/);
  });

  it("nettoie l'environnement transmis", () => {
    expect(childEnv({ ANTHROPIC_AUTH_TOKEN: "x", CLAUDE_CODE_API_KEY_HELPER: "y", HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});

describe("en-têtes du mode local", () => {
  it("ni CSP ni HSTS (propres au service hébergé), même derrière un X-Forwarded-Proto https", async () => {
    const res = await app.request("/api/projects", { headers: { "x-forwarded-proto": "https" } });
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});
