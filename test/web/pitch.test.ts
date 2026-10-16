import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { createProject, getProject, readProjectFile, type ProjectExtra } from "../../src/studies/project";
import { createApp } from "../../src/web/app";
import { Launcher, type SpawnFn } from "../../src/web/launcher";
import { drawPersonas } from "../../src/personas/sampler";
import { insertPersonas } from "../../src/personas/store";
import { pack } from "../studies/fixtures";

/** Routes de la neutralisation du pitch : lecture, lancement, contrôle, application, « garder mon pitch ». */

const tmp = mkdtempSync(join(tmpdir(), "personas-pitch-"));
const root = join(tmp, "repo");
const dataDir = join(tmp, "data");
const { db, sqlite } = openDb(":memory:");
const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
let pid = 920_000_000;
const spawnFn: SpawnFn = (_c, args, opts) => {
  spawned.push({ args, env: opts.env ?? {} });
  return { pid: pid++, unref() {} };
};
const launcher = new Launcher({ root: process.cwd(), logDir: join(tmp, "logs"), spawnFn, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "interdit" } });
const app = createApp({ db, pack, config: loadConfig({}), launcher, root, dataDir });
const call = async (method: string, path: string, json?: unknown) => {
  const res = await app.request(`/api${path}`, { method, ...(json !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(json) }) });
  return { status: res.status, body: (await res.json()) as any };
};

const SURVENDU = "Conciergerie express, c'est la révolution qui va changer votre quotidien ! Le service le plus exceptionnel jamais imaginé : pressing, colis, démarches à Paris. Déjà des milliers de clients conquis. Offre limitée : 19 € par mois, une affaire incroyable. Inscrivez-vous vite !";
const NEUTRE = "Conciergerie express est un service de conciergerie à Paris : pressing, colis et démarches. L'abonnement coûte 19 € par mois.";

const YAML = `# Projet factice (tests du pitch)
id: demo-pitch
name: Démo pitch
pitch: "${SURVENDU}"
price:
  amountEur: 19
  period: month
`;

const proposal = (project: string, original: string) => ({
  project,
  generatedAt: "2026-10-15T10:00:00.000Z",
  model: "fake",
  original,
  neutral: NEUTRE,
  passages: [{ text: "c'est la révolution qui va changer votre quotidien !", category: "unverifiable_promise", reason: "Promesse invérifiable", replacement: "" }],
  toneScore: { before: 92, after: 5 },
  lexicalScore: { before: 100, after: 0 },
  facts: [{ fact: "Pressing, colis et démarches", keyTerms: ["pressing", "colis"] }],
  factCheck: { ok: true, numbersMissing: [], numbersAdded: [], namesMissing: [], factsMissing: [], repaired: false },
  missingInfo: ["Délais d'intervention"],
  unchanged: false,
  usage: { calls: 1, inputTokens: 1, outputTokens: 1 },
});

beforeAll(() => {
  runMigrations(db);
  mkdirSync(join(root, "examples"), { recursive: true });
  writeFileSync(join(root, "examples/demo-pitch.yaml"), YAML);
  createProject(db, readProjectFile(join(root, "examples/demo-pitch.yaml")), { sourceFile: "examples/demo-pitch.yaml" });
  createProject(db, { id: "demo-pitch-db", name: "Démo pitch base", pitch: SURVENDU, price: { amountEur: 19, period: "month" }, competitors: [], alternatives: [] } as never);
  insertPersonas(db, drawPersonas(pack, 11, 12));
  createProject(db, { id: "demo-survendu", name: "Démo survendu", pitch: SURVENDU, price: { amountEur: 19, period: "month" }, competitors: [], alternatives: [] } as never);
  mkdirSync(join(dataDir, "proposals"), { recursive: true });
  for (const id of ["demo-pitch", "demo-pitch-db"]) writeFileSync(join(dataDir, "proposals", `${id}-pitch.json`), JSON.stringify(proposal(id, SURVENDU)));
});

afterAll(() => {
  sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("API de la neutralisation du pitch", () => {
  it("donne le score de ton du pitch dans le détail du projet", async () => {
    const r = await call("GET", "/projects/demo-pitch");
    expect(r.body.project.pitchTone).toMatchObject({ threshold: 25, warn: true, neutralized: false });
    expect(r.body.project.pitchTone.score).toBeGreaterThanOrEqual(25);
  });

  it("lit la proposition avec le contrôle des faits (conservés et manquants)", async () => {
    const r = await call("GET", "/projects/demo-pitch/pitch");
    expect(r.status).toBe(200);
    expect(r.body.tone.warn).toBe(true);
    expect(r.body.proposal.stale).toBe(false);
    expect(r.body.proposal.factView.numbersKept).toContain("19 €");
    expect(r.body.proposal.factView.namesKept).toContain("Paris");
    expect(r.body.categories).toHaveLength(7);
  });

  it("contrôle une version éditée sans modèle", async () => {
    const r = await call("POST", "/projects/demo-pitch/pitch/check", { text: "Conciergerie express à Lyon : pressing et colis, 25 € par mois." });
    expect(r.status).toBe(200);
    expect(r.body.factView.ok).toBe(false);
    expect(r.body.factView.numbersAdded).toContain("25 €");
    expect(r.body.factView.namesMissing).toContain("Paris");
    expect((await call("POST", "/projects/demo-pitch/pitch/check", {})).status).toBe(400);
  });

  it("lance project:neutralize-pitch en tâche détachée, sans clé API", async () => {
    const r = await call("POST", "/projects/demo-pitch/pitch/neutralize");
    expect(r.status).toBe(202);
    const last = spawned[spawned.length - 1]!;
    expect(last.args.join(" ")).toContain("src/cli/project-neutralize-pitch.ts");
    expect(last.args).toEqual(expect.arrayContaining(["--project", "demo-pitch", "--out", join(dataDir, "proposals", "demo-pitch-pitch.json")]));
    expect(last.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("applique la version neutre dans le fichier projet, original conservé et sauvegarde", async () => {
    expect((await call("PUT", "/projects/demo-pitch/pitch", { pitch: NEUTRE })).status).toBe(400);
    const r = await call("PUT", "/projects/demo-pitch/pitch", { pitch: NEUTRE, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("file");
    const file = readFileSync(join(root, "examples/demo-pitch.yaml"), "utf8");
    expect(file).toContain("# Projet factice"); // commentaires conservés
    const f = readProjectFile(join(root, "examples/demo-pitch.yaml"));
    expect(f.pitch).toBe(NEUTRE);
    expect(f.pitchOriginal).toBe(SURVENDU);
    expect(f.pitchNeutralized).toBe(true);
    const row = getProject(db, "demo-pitch")!;
    expect(row.pitch).toBe(NEUTRE);
    expect((row.extra as ProjectExtra).pitchOriginal).toBe(SURVENDU);
    expect(readdirSync(join(dataDir, "backups", "projects")).some((x) => x.startsWith("demo-pitch-pitch-"))).toBe(true);
    // La proposition est archivée ; une seconde application garde l'original d'origine
    expect(existsSync(join(dataDir, "proposals", "demo-pitch-pitch.json"))).toBe(false);
    await call("PUT", "/projects/demo-pitch/pitch", { pitch: `${NEUTRE} Sans engagement.`, confirm: true });
    expect(readProjectFile(join(root, "examples/demo-pitch.yaml")).pitchOriginal).toBe(SURVENDU);
    const after = await call("GET", "/projects/demo-pitch/pitch");
    expect(after.body).toMatchObject({ pitchNeutralized: true, pitchOriginal: SURVENDU, proposal: null });
    expect(after.body.tone.warn).toBe(false);
  });

  it("projet sans fichier : base seule ; « garder mon pitch » archive la proposition", async () => {
    const k = await call("POST", "/projects/demo-pitch-db/pitch/dismiss");
    expect(k.status).toBe(200);
    expect(getProject(db, "demo-pitch-db")!.pitch).toBe(SURVENDU);
    expect((await call("POST", "/projects/demo-pitch-db/pitch/dismiss")).status).toBe(404);
    const r = await call("PUT", "/projects/demo-pitch-db/pitch", { pitch: NEUTRE, confirm: true });
    expect(r.body.source).toBe("db");
    expect(getProject(db, "demo-pitch-db")!.pitch).toBe(NEUTRE);
    expect((getProject(db, "demo-pitch-db")!.extra as ProjectExtra).pitchNeutralized).toBe(true);
    expect((await call("PUT", "/projects/demo-pitch-db/pitch", { pitch: "court", confirm: true })).status).toBe(400);
  });

  it("création d'étude v3 : refus structuré d'un pitch commercial, forçage, v2 seulement averti", async () => {
    const base = { projectId: "demo-survendu", backend: "claude-cli", target: { packVersion: pack.manifest.version, n: 3 } };
    const refused = await call("POST", "/studies", base);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "pitch_tone", pitchTone: { threshold: 25 } });
    expect(refused.body.pitchTone.score).toBeGreaterThanOrEqual(25);
    expect((await call("GET", "/studies?project=demo-survendu")).body).toHaveLength(0); // rien d'écrit
    const forced = await call("POST", "/studies", { ...base, force: true });
    expect(forced.status).toBe(201);
    expect(forced.body.notes.join(" ")).toMatch(/forcée/);
    const v2 = await call("POST", "/studies", { ...base, protocolVersion: "2" });
    expect(v2.status).toBe(201);
    expect(v2.body.notes.join(" ")).toMatch(/ton commercial/);
    const studies = (await call("GET", "/studies?project=demo-survendu")).body as Array<{ id: string }>;
    expect(studies).toHaveLength(2);
    expect((await call("POST", "/studies", { ...base, protocolVersion: "4" })).status).toBe(400);
  });

  it("expose l'avancement des récits de l'échantillon (étude lancée du terminal)", async () => {
    const [st] = (await call("GET", "/studies?project=demo-survendu")).body as Array<{ id: string }>;
    const before = (await call("GET", `/studies/${st!.id}/progress`)).body;
    expect(before.narratives.total).toBe(before.total);
    const { findStudy } = await import("../../src/studies/store");
    const { personas } = await import("../../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const pid = findStudy(db, st!.id).personaIds.find((x) => !db.select().from(personas).where(eq(personas.id, x)).get()?.narrative)!;
    db.update(personas).set({ narrative: "Récit de test.", narrativeAt: "2026-10-16T10:00:00.000Z" }).where(eq(personas.id, pid)).run();
    const after = (await call("GET", `/studies/${st!.id}/progress`)).body;
    expect(after.narratives.done).toBe(before.narratives.done + 1);
    expect(after.narratives.lastAt).toBe("2026-10-16T10:00:00.000Z");
  });
});
