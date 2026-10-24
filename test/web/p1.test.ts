import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { responses } from "../../src/db/schema";
import { Engine } from "../../src/engine/engine";
import { drawPersonas } from "../../src/personas/sampler";
import { insertPersonas } from "../../src/personas/store";
import { createProject, getProject, readProjectFile, type ProjectExtra } from "../../src/studies/project";
import { runStudy } from "../../src/studies/run";
import { createStudy } from "../../src/studies/study";
import { createApp } from "../../src/web/app";
import { Launcher, type SpawnFn } from "../../src/web/launcher";
import { plainCriteria } from "../../src/web/overview";
import { answer, fakeBackend, pack, payer } from "../studies/fixtures";

/** Routes du lot P1 : aperçu de cible, assistant de cible, blocs du projet (cible, protocole), recodage. */

const tmp = mkdtempSync(join(tmpdir(), "personas-p1-"));
const root = join(tmp, "repo");
const dataDir = join(tmp, "data");
const { db, sqlite } = openDb(":memory:");
const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
let pid = 910_000_000;
const spawnFn: SpawnFn = (_c, args, opts) => {
  spawned.push({ args, env: opts.env ?? {} });
  return { pid: pid++, unref() {} };
};
// Lanceur sur le vrai dépôt (scripts npm existants), journaux en temporaire, processus simulés
const launcher = new Launcher({ root: process.cwd(), logDir: join(tmp, "logs"), spawnFn, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "interdit" } });
const app = createApp({ db, pack, config: loadConfig({}), launcher, root, dataDir });
const call = async (method: string, path: string, json?: unknown) => {
  const res = await app.request(`/api${path}`, { method, ...(json !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(json) }) });
  return { status: res.status, body: (await res.json()) as any };
};

const PROJECT_YAML = `# Projet de démonstration (tests du tableau de bord)
id: demo-p1
name: Démo P1
pitch: Une application pour Mac qui range automatiquement les captures d'écran par projet, sans rien envoyer en ligne.
price:
  amountEur: 9
  period: once
# Cible : jeunes actifs
target:
  socle: fr
  modules: []
  eligibility: age >= 25 and age <= 40
  n: 30
control:
  socle: fr
  n: 10
`;

let studyId = "";

beforeAll(async () => {
  runMigrations(db);
  mkdirSync(join(root, "examples"), { recursive: true });
  writeFileSync(join(root, "examples/demo-p1.yaml"), PROJECT_YAML);
  createProject(db, readProjectFile(join(root, "examples/demo-p1.yaml")), { sourceFile: "examples/demo-p1.yaml" });
  // Projet sans fichier (base seule) avec une étude, pour le protocole et le recodage
  insertPersonas(db, drawPersonas(pack, 99, 20));
  const p = createProject(db, readProjectFile("examples/meal-planner.json"));
  const { study } = createStudy(db, pack, { projectId: p.id, n: 8, seed: 7, backend: "ollama", model: "fake" });
  await runStudy(db, new Engine(fakeBackend((_r, i) => JSON.stringify(i % 2 ? payer() : answer())).backend), pack, study);
  studyId = study.id;
});

afterAll(() => {
  sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

const TAXONOMY = [
  { code: "no_need", label: "Pas de besoin", description: "pas de projet", canonical: "no_need" },
  { code: "network_empty", label: "Réseau trop vide", description: "pas assez de membres", canonical: "network_effect" },
  { code: "other", label: "Autre", description: "le reste", canonical: "other" },
];

describe("API du lot P1", () => {
  it("donne un aperçu rapide de la cible, sans pré-tri", async () => {
    const { status, body } = await call("GET", "/projects/demo-p1/target-preview?seed=7&sample=2");
    expect(status).toBe(200);
    expect(body.eligibility.eligible).toBe(30);
    expect(body.eligibility.rate).toBeGreaterThan(0.1);
    expect(body.cards).toHaveLength(2);
    expect(body.distributions.map((d: any) => d.key)).toContain("ageBand");
    expect(body.triage).toBeUndefined();
    expect((await call("GET", "/projects/inconnu/target-preview")).status).toBe(404);
  });

  it("lance le pré-tri en tâche détachée et relit le résultat en cache", async () => {
    const empty = await call("GET", "/projects/demo-p1/target-preview/triage?seed=7");
    expect(empty.body).toMatchObject({ result: null, job: null });
    const r = await call("POST", "/projects/demo-p1/target-preview/triage", { seed: 7 });
    expect(r.status).toBe(202);
    const args = spawned.at(-1)!.args;
    expect(args).toEqual(expect.arrayContaining(["src/web/jobs/target-preview.ts", "--project", "demo-p1", "--seed", "7"]));
    expect(Object.keys(spawned.at(-1)!.env).some((k) => k.startsWith("ANTHROPIC_"))).toBe(false);
    const out = args[args.indexOf("--out") + 1]!;
    expect(out.startsWith(dataDir)).toBe(true);
    mkdirSync(join(dataDir, "previews"), { recursive: true });
    writeFileSync(out, JSON.stringify({ project: { id: "demo-p1" }, triage: { share: 0.12, alert: true } }));
    const cached = await call("GET", "/projects/demo-p1/target-preview/triage?seed=7");
    expect(cached.body.result.triage).toMatchObject({ share: 0.12, alert: true });
    expect(cached.body.job.key).toBe("preview-demo-p1-target-s7");
  });

  it("lit la proposition de cible et lance l'assistant", async () => {
    const none = await call("GET", "/projects/demo-p1/target-suggestion");
    expect(none.body.suggestion).toBeNull();
    writeFileSync(join(root, "examples/demo-p1.target-suggestion.yaml"), "project: demo-p1\nanalysis: test\nvariants:\n  - id: v1\n    label: Variante 1\n    target: { socle: fr, modules: [], eligibility: 'age >= 30', n: 30 }\n");
    const s = await call("GET", "/projects/demo-p1/target-suggestion");
    expect(s.body.suggestion.variants[0].id).toBe("v1");
    expect(s.body.file).toBe("examples/demo-p1.target-suggestion.yaml");
    const r = await call("POST", "/projects/demo-p1/target-suggestion");
    expect(r.status).toBe(202);
    expect(spawned.at(-1)!.args).toEqual(expect.arrayContaining(["src/web/jobs/target-suggest.ts", "--project", "demo-p1"]));
  });

  it("valide un bloc et montre le diff avant d'appliquer", async () => {
    const bad = await call("POST", "/projects/demo-p1/blocks/target/validate", { value: { socle: "fr", n: -2 } });
    expect(bad.body.ok).toBe(false);
    const ok = await call("POST", "/projects/demo-p1/blocks/target/validate", { value: { socle: "fr", modules: [], eligibility: "age >= 30", n: 30 } });
    expect(ok.body.ok).toBe(true);
    expect(ok.body.before).toContain("age >= 25");
    expect(ok.body.after).toContain("age >= 30");
    expect((await call("POST", "/projects/demo-p1/blocks/autre/validate", { value: {} })).status).toBe(400);
  });

  it("remplace la cible dans le fichier projet, avec sauvegarde et base resynchronisée", async () => {
    const target = { socle: "fr", modules: [], eligibility: "age >= 30", n: 30 };
    expect((await call("PUT", "/projects/demo-p1/blocks/target", { value: target })).status).toBe(400); // sans confirmation
    const r = await call("PUT", "/projects/demo-p1/blocks/target", { value: target, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: "file", file: "examples/demo-p1.yaml" });
    const text = readFileSync(join(root, "examples/demo-p1.yaml"), "utf8");
    expect(text).toContain("age >= 30");
    expect(text).toContain("# Projet de démonstration"); // commentaires conservés
    expect(text).toContain("control:");
    const backups = readdirSync(join(dataDir, "backups/projects"));
    expect(backups.some((f) => f.startsWith("demo-p1-target-") && readFileSync(join(dataDir, "backups/projects", f), "utf8").includes("age >= 25"))).toBe(true);
    expect((getProject(db, "demo-p1")!.extra as ProjectExtra).target?.eligibility).toBe("age >= 30");
  });

  it("valide puis applique un protocole (projet sans fichier : base seule)", async () => {
    const bad = await call("PUT", "/projects/meal-planner/blocks/protocol", {
      confirm: true,
      value: { productType: "app_install", behaviors: [{ code: "ignore", label: "Ignore", description: "rien", level: "inaction" }, { code: "look", label: "Regarde", description: "regarde", level: "interest" }, { code: "try", label: "Essaie", description: "essaie", level: "free_trial" }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: any) => e.message).join(" ")).toContain("payment");
    const before = await call("GET", "/projects/meal-planner/protocol");
    expect(before.body.resolved.custom).toBe(false);
    expect(before.body.vocab.levels.map((l: any) => l.id)).toEqual(["inaction", "interest", "free_trial", "payment", "recommendation"]);
    const ok = await call("PUT", "/projects/meal-planner/blocks/protocol", { confirm: true, value: { productType: "marketplace_network", objections: TAXONOMY } });
    expect(ok.status).toBe(200);
    expect(ok.body.source).toBe("db");
    expect(existsSync(join(root, ok.body.backup)) || existsSync(ok.body.backup)).toBe(true);
    const after = await call("GET", "/projects/meal-planner/protocol");
    expect(after.body.resolved.custom).toBe(true);
    expect(after.body.resolved.objections.map((o: any) => o.code)).toEqual(["no_need", "network_empty", "other"]);
  });

  it("lance le recodage avec la taxonomie du projet et lit les objections recodées", async () => {
    const r = await call("POST", `/studies/${studyId}/recode`);
    expect(r.status).toBe(202);
    const args = spawned.at(-1)!.args;
    expect(args).toEqual(expect.arrayContaining(["src/cli/study-recode.ts", "--study", studyId, "--key", "meal-planner"]));
    const taxFile = args[args.indexOf("--taxonomy") + 1]!;
    expect(JSON.parse(readFileSync(taxFile, "utf8")).objections).toHaveLength(3);
    // Résultat simulé du recodage : codes dans les réponses et fichier de taxonomie dans data/summaries
    for (const row of db.select().from(responses).where(eq(responses.studyId, studyId)).all()) {
      const p = row.payload as { answer: { objections: unknown[] } };
      const codes = p.answer.objections.map((_, i) => (i === 0 ? "network_empty" : "other"));
      db.update(responses).set({ payload: { ...row.payload, recoded: { "meal-planner": { codes, at: "x", model: "fake" } } } }).where(eq(responses.id, row.id)).run();
    }
    mkdirSync(join(dataDir, "summaries"), { recursive: true });
    writeFileSync(join(dataDir, "summaries", `${studyId}-recode-meal-planner.json`), JSON.stringify({ taxonomy: { key: "meal-planner", objections: TAXONOMY } }));
    const rec = await call("GET", `/studies/${studyId}/recoded`);
    expect(rec.body.recodings).toHaveLength(1);
    expect(rec.body.recodings[0].overall.n).toBe(8);
    expect(rec.body.recodings[0].overall.shares.network_empty).toBeGreaterThan(0);
    expect(rec.body.available).toMatchObject({ key: "meal-planner", source: "protocol", count: 3 });
  });

  it("ajoute l'échelle d'affichage au résumé d'une étude", async () => {
    const { body } = await call("GET", `/studies/${studyId}/summary`);
    expect(body.scale.behaviors.map((b: any) => b.code)).toContain("pay_subscription");
    expect(body.behaviorLevels).toBeNull(); // étude au protocole historique
    expect(body.levelLabels.payment).toBe("Paiement");
  });

  it("traduit les critères de sélection en langage clair", () => {
    const { criteria, raw } = plainCriteria("activity_status == employed and age >= 25 and age <= 40 and pcs in [3, 4] and numerique.is_digital_worker", (c) => c);
    const text = criteria.map((c) => (c.value ? `${c.label} : ${c.value}` : c.label));
    expect(text).toEqual(expect.arrayContaining(["Situation : en emploi", "Catégorie socioprofessionnelle : cadres ou professions intermédiaires", "Âge : de 25 à 40 ans", "travaille dans le numérique"]));
    expect(criteria.at(-1)!.source).toBe("module");
    expect(raw).toEqual([]);
    expect(plainCriteria("age > 30 or pcs == 3").raw).toHaveLength(1); // « or » de premier niveau : laissé brut
  });

  it("donne la vue d'ensemble d'un projet : cible chiffrée, offre, questionnaire, dernière étude", async () => {
    const empty = await call("GET", "/projects/demo-p1/overview");
    expect(empty.status).toBe(200);
    expect(empty.body.target.criteria.map((c: any) => c.label)).toEqual(["Âge"]);
    expect(empty.body.target.eligibility.rate).toBeGreaterThan(0.1);
    expect(empty.body.target.estimatedPeople).toBeGreaterThan(1_000_000);
    expect(empty.body.control.criteria).toEqual([]);
    expect(empty.body.lastStudy).toBeNull();
    expect(empty.body.studies.count).toBe(0);
    const withStudy = await call("GET", "/projects/meal-planner/overview");
    expect(withStudy.body.target).toBeNull();
    expect(withStudy.body.lastStudy).toMatchObject({ id: studyId, n: 8 });
    expect(withStudy.body.lastStudy.payers).toBeGreaterThan(0);
    expect(withStudy.body.protocol.custom).toBe(true); // appliqué plus haut
    expect((await call("GET", "/projects/inconnu/overview")).status).toBe(404);
  });

  it("lit, génère et applique les recommandations d'une étude", async () => {
    const none = await call("GET", `/studies/${studyId}/recommendations`);
    expect(none.body.recommendations).toBeNull();
    // Génération : la CLI study:recommend en tâche détachée
    const gen = await call("POST", `/studies/${studyId}/recommendations`, { force: true });
    expect(gen.status).toBe(202);
    expect(spawned.at(-1)!.args).toEqual(expect.arrayContaining(["src/cli/study-recommend.ts", "--study", studyId, "--force"]));
    // Cache simulé
    mkdirSync(join(dataDir, "recommendations"), { recursive: true });
    writeFileSync(
      join(dataDir, "recommendations", `${studyId}.json`),
      JSON.stringify({
        studyId, generatedAt: "2026-10-15T09:00:00Z", model: "fake", inputsHash: "x", headline: "Tester 2 €.",
        findings: [], caveats: ["factice"],
        recommendations: [
          { id: "prix-2", kind: "prix", title: "Tester 2 €", rationale: "r", evidence: [], confidence: "faible", nextStudy: { hypothesis: "h", successCriterion: "c", projectPatch: { price: { amountEur: 2, period: "month" }, target: { socle: "fr", modules: [], eligibility: "age >= 30", n: 20 } }, sample: "same_sample", n: 8, estimatedCalls: 10, estimatedMinutes: 2 } },
          { id: "message", kind: "message", title: "Changer le message", rationale: "r", evidence: [], confidence: "moyenne" },
        ],
      }),
    );
    const got = await call("GET", `/studies/${studyId}/recommendations`);
    expect(got.body.recommendations.headline).toBe("Tester 2 €.");
    expect(got.body.plainTargets["prix-2"].after.map((c: any) => c.label)).toEqual(["Âge"]);
    // Création de l'étude suivante : confirmation obligatoire, recommandation existante avec nextStudy
    expect((await call("POST", `/studies/${studyId}/recommendations/prix-2/create-study`, {})).status).toBe(400);
    expect((await call("POST", `/studies/${studyId}/recommendations/inconnue/create-study`, { confirm: true })).status).toBe(404);
    expect((await call("POST", `/studies/${studyId}/recommendations/message/create-study`, { confirm: true })).status).toBe(400);
    const calls: Array<{ studyId: string; recId: string; opts: Record<string, unknown> }> = [];
    const withFake = createApp({ db, pack, config: loadConfig({}), launcher, root, dataDir, recommend: async () => ({ api: { createNextStudy: (sid, rid, opts) => (calls.push({ studyId: sid, recId: rid, opts }), { projectId: "p-var", studyId: "st-next" }) } }) });
    const res = await withFake.request(`/api/studies/${studyId}/recommendations/prix-2/create-study`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ projectId: "p-var", studyId: "st-next" });
    expect(calls[0]).toMatchObject({ studyId, recId: "prix-2", opts: { confirm: true, outDir: join(dataDir, "recommendations") } });
    expect(calls[0]!.opts.db).toBe(db);
    const off = createApp({ db, pack, config: loadConfig({}), launcher, root, dataDir, recommend: async () => ({ api: null, reason: "Recommandations indisponibles." }) });
    const r503 = await off.request(`/api/studies/${studyId}/recommendations/prix-2/create-study`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    expect(r503.status).toBe(503);
    // La vue d'ensemble du projet mentionne la recommandation principale
    const ov = await call("GET", "/projects/meal-planner/overview");
    expect(ov.body.lastStudy.recommendation.top).toMatchObject({ title: "Tester 2 €", confidence: "faible" });
  });

  it("décrit en clair qui a été interrogé dans une étude", async () => {
    const { body } = await call("GET", `/studies/${studyId}`);
    expect(body.populationsPlain[0]).toMatchObject({ group: "target", n: 8, criteria: [] });
  });
});
