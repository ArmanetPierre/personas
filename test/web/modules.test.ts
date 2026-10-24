import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { createProject, readProjectFile } from "../../src/studies/project";
import { createApp } from "../../src/web/app";
import { Launcher, type SpawnFn } from "../../src/web/launcher";
import { defaultAssistantLoader, fallbackApi, type AssistantApi, type AssistantLoader, type PreviewResult } from "../../src/web/modules";
import { pack } from "../studies/fixtures";

/** Routes de l'assistant de modules, sur un dossier `modules/` de fixtures et une base temporaire. */

const tmp = mkdtempSync(join(tmpdir(), "personas-modules-"));
const modulesDir = join(tmp, "modules");
const root = join(tmp, "root");
const fixture = (f: string) => readFileSync(join(import.meta.dirname, "fixtures", f), "utf8");

function draft(id: string, status: string, yaml?: string, extra: Record<string, unknown> = {}) {
  const dir = join(modulesDir, "_drafts", id);
  mkdirSync(dir, { recursive: true });
  if (yaml) writeFileSync(join(dir, "module.yaml"), yaml);
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ id, status, description: `Brouillon ${id}`, socle: "fr", createdAt: "2026-10-14T10:00:00Z", updatedAt: "2026-10-14T10:05:00Z", notes: ["Part des réunions à sourcer."], history: [], ...extra }),
  );
}

const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
let nextPid = 900_000_000; // pid inexistant : la tâche simulée est « terminée »
/** Vrai : la tâche simulée « tourne » (pid du processus de test, vivant). */
let jobsStayAlive = false;
const spawnFn: SpawnFn = (_cmd, args, opts) => {
  spawned.push({ args, env: opts.env ?? {} });
  return { pid: jobsStayAlive ? process.pid : nextPid++, unref() {} };
};

// Assistant simulé : le repli de lecture, plus un aperçu de fixture
let previewAlerts: PreviewResult["alerts"] = [];
const fakeAssistant: AssistantLoader = async () => ({
  api: {
    ...fallbackApi(modulesDir),
    previewModule: () => ({
      margins: [{ attribute: "meetings_per_week", label: "Réunions par semaine", values: [{ code: "few", label: "moins de 3", share: 0.6 }, { code: "many", label: "3 ou plus", share: 0.4 }] }],
      sampleCards: [{ personaId: "fr-2026.2-s1-0001", card: ["Réunions : 3 ou plus"] }],
      alerts: previewAlerts,
    }),
  } satisfies AssistantApi,
});
const noAssistant: AssistantLoader = async () => ({ api: null, reason: "Assistant indisponible : src/modules/assistant/index.ts n'existe pas encore." });

const { db, sqlite } = openDb(":memory:");
const launcher = new Launcher({ root, logDir: join(tmp, "logs"), spawnFn, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "cle-interdite" } });
const ctx = { db, pack, config: loadConfig({}), launcher, modulesDir };
const appWith = (assistant: AssistantLoader) => createApp({ ...ctx, assistant });
const app = appWith(fakeAssistant);
const offline = appWith(noAssistant);

const call = async (a: ReturnType<typeof createApp>, method: string, path: string, json?: unknown) => {
  const res = await a.request(`/api${path}`, { method, ...(json !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(json) }) });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(() => {
  runMigrations(db);
  mkdirSync(join(modulesDir, "numerique"), { recursive: true });
  copyFileSync("modules/numerique/module.yaml", join(modulesDir, "numerique", "module.yaml"));
  draft("reunions-ok", "ready", fixture("draft-ok.yaml"));
  draft("reunions-ko", "ready", fixture("draft-ko.yaml"));
  draft("en-cours", "proposing");
  for (const x of ["a", "b"]) {
    draft(`deux-${x}`, "ready", fixture("draft-ok.yaml").replace("id: productivite-reunions", `id: deux-${x}`).replace("id: meetingLoad", `id: deux${x}Load`));
  }
  // Racine factice : package.json avec les scripts de l'assistant (fichiers vides)
  mkdirSync(join(root, "src/cli"), { recursive: true });
  for (const s of ["propose", "revise", "accept"]) writeFileSync(join(root, `src/cli/module-${s}.ts`), "");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "module:propose": "tsx src/cli/module-propose.ts", "module:revise": "tsx src/cli/module-revise.ts", "module:accept": "tsx src/cli/module-accept.ts" } }));
  // Projet dont la cible utilise un module encore en brouillon
  const file = readProjectFile("examples/meal-planner-v2.json");
  createProject(db, { ...file, id: "meetings-test", name: "Réunions test", target: { ...file.target!, modules: ["numerique", "productivite-reunions"] } });
  createProject(db, { ...file, id: "cible-validee", name: "Cible validée", target: { ...file.target!, modules: ["numerique"] } });
});

afterAll(() => {
  sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("API des modules", () => {
  it("liste modules validés et brouillons, même sans assistant", async () => {
    const { status, body } = await call(offline, "GET", "/modules");
    expect(status).toBe(200);
    expect(body.assistant).toMatchObject({ available: false });
    const byId = Object.fromEntries(body.modules.map((m: any) => [m.draftId ?? m.id, m]));
    expect(byId.numerique).toMatchObject({ status: "validated", appliesTo: ["fr"] });
    expect(byId["reunions-ok"]).toMatchObject({ id: "productivite-reunions", status: "draft:ready", attributeCount: 2, sourcedCount: 1, assumptionCount: 1 });
    expect(byId["en-cours"].status).toBe("draft:proposing");
  });

  it("explique un module : dépendances en clair, sources, hypothèses", async () => {
    const { body } = await call(offline, "GET", "/modules/numerique");
    expect(body.module.status).toBe("validated");
    const digital = body.view.attributes.find((a: any) => a.key === "is_digital_worker");
    expect(digital.dependsOn).toEqual(expect.arrayContaining(["PCS", "âge", "sexe", "région"]));
    expect(digital.when).toBe("Situation d'activité parmi en emploi ; au chômage");
    expect(body.view.sources.find((s: any) => s.key === "insee_num").citedBy.length).toBeGreaterThan(1);
    const d = await call(offline, "GET", "/modules/reunions-ok");
    expect(d.body.draftId).toBe("reunions-ok");
    expect(d.body.view.attributes[0].dependsOn).toEqual(["PCS"]);
    expect(d.body.view.attributes[1].assumption).toBe(true);
    expect((await call(offline, "GET", "/modules/inconnu")).status).toBe(404);
    expect((await call(offline, "GET", "/modules/..%2Fetc")).status).toBe(400);
  });

  it("signale un brouillon invalide et valide un YAML à la volée", async () => {
    const ko = await call(offline, "GET", "/modules/reunions-ko");
    expect(ko.body.module.validationErrors.length).toBeGreaterThan(0);
    const v = await call(offline, "POST", "/modules/validate", { yaml: "id: x\nlabel: [" });
    expect(v.body.ok).toBe(false);
    expect((await call(offline, "POST", "/modules/validate", { yaml: fixture("draft-ok.yaml") })).body).toEqual({ ok: true, errors: [] });
  });

  it("enregistre le YAML d'un brouillon seulement s'il est valide", async () => {
    const bad = await call(app, "PUT", "/modules/drafts/reunions-ok/yaml", { yaml: fixture("draft-ko.yaml") });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.length).toBeGreaterThan(0);
    const edited = fixture("draft-ok.yaml").replace("Productivité et réunions", "Réunions et productivité");
    expect((await call(app, "PUT", "/modules/drafts/reunions-ok/yaml", { yaml: edited })).status).toBe(200);
    expect(readFileSync(join(modulesDir, "_drafts/reunions-ok/module.yaml"), "utf8")).toContain("Réunions et productivité");
    expect((await call(app, "PUT", "/modules/drafts/inconnu/yaml", { yaml: edited })).status).toBe(404);
  });

  it("refuse la validation s'il reste des erreurs (schéma, aperçu) ou si le brouillon n'est pas prêt", async () => {
    const ko = await call(app, "POST", "/modules/drafts/reunions-ko/accept");
    expect(ko.status).toBe(409);
    expect(ko.body.errors.length).toBeGreaterThan(0);
    expect((await call(app, "POST", "/modules/drafts/en-cours/accept")).status).toBe(409);
    previewAlerts = [{ level: "error", message: "Marge de « 3 ou plus » à 95 % : conditionnement suspect", attribute: "meetings_per_week" }];
    const alert = await call(app, "POST", "/modules/drafts/reunions-ok/accept");
    expect(alert.status).toBe(409);
    expect(alert.body.errors[0]).toContain("conditionnement suspect");
    previewAlerts = [{ level: "warning", message: "Une hypothèse sans source" }];
    expect(spawned).toHaveLength(0);
    const ok = await call(app, "POST", "/modules/drafts/reunions-ok/accept");
    expect(ok.status).toBe(202);
    expect(spawned.at(-1)!.args.slice(-3)).toEqual(["src/cli/module-accept.ts", "--draft", "reunions-ok"]);
    expect(Object.keys(spawned.at(-1)!.env).some((k) => k.startsWith("ANTHROPIC_"))).toBe(false);
  });

  it("lance proposition et révision en processus détaché, et suit le brouillon", async () => {
    expect((await call(app, "POST", "/modules/propose", { description: "court" })).status).toBe(400);
    const p = await call(app, "POST", "/modules/propose", { description: "Équipement et écosystème : iPhone ou Android, Mac ou PC", socle: "fr", projectId: "meetings-test" });
    expect(p.status).toBe(202);
    const args = spawned.at(-1)!.args;
    expect(args).toEqual(expect.arrayContaining(["src/cli/module-propose.ts", "--description", "--socle", "fr", "--draft", p.body.draftId, "--project", "meetings-test"]));
    const st = await call(app, "GET", `/modules/drafts/${p.body.draftId}/status`);
    expect(st.body).toMatchObject({ draftId: p.body.draftId, meta: null, stalled: true });
    const r = await call(app, "POST", "/modules/drafts/reunions-ok/revise", { instruction: "Citer une source pour la prise de notes." });
    expect(r.status).toBe(202);
    expect(spawned.at(-1)!.args.slice(-4)).toEqual(["--draft", "reunions-ok", "--instruction", "Citer une source pour la prise de notes."]);
    const s2 = await call(app, "GET", "/modules/drafts/reunions-ok/status");
    expect(s2.body.meta.status).toBe("ready");
    expect(s2.body.job.pid).toBeGreaterThan(0);
  });

  it("répond « assistant indisponible » sans les scripts ni l'assistant", async () => {
    const bare = createApp({ ...ctx, assistant: noAssistant, launcher: new Launcher({ root: tmp, logDir: join(tmp, "logs2"), spawnFn }) });
    const p = await call(bare, "POST", "/modules/propose", { description: "Sport, entraînement et objets connectés" });
    expect(p.status).toBe(503);
    expect(p.body.error).toContain("module:propose");
    expect((await call(bare, "GET", "/modules/numerique/preview")).status).toBe(503);
    const prev = await call(app, "GET", "/modules/reunions-ok/preview?sample=5");
    expect(prev.status).toBe(200);
    expect(prev.body.margins[0].values).toHaveLength(2);
  });

  it("montre la cible du projet et bloque une étude tant qu'un module est en brouillon", async () => {
    const p = await call(app, "GET", "/projects/meetings-test");
    expect(p.body.targeting.target.modules).toEqual(["numerique", "productivite-reunions"]);
    expect(p.body.targeting.blocking).toEqual([{ id: "productivite-reunions", status: "draft:ready", draftId: "reunions-ok" }]);
    const s = await call(app, "POST", "/studies", { projectId: "meetings-test", backend: "claude-cli", useProjectTarget: true, seed: 1 });
    expect(s.status).toBe(409);
    expect(s.body.error).toContain("productivite-reunions");
    const ok = await call(app, "GET", "/projects/cible-validee");
    expect(ok.body.targeting.blocking).toEqual([]);
    expect(ok.body.targeting.modules.map((m: any) => m.status)).toEqual(["validated"]);
  });

  it("branche l'assistant réel (src/modules/assistant/index.ts) par import dynamique", async () => {
    const { api, reason } = await defaultAssistantLoader()();
    expect(reason).toBeUndefined();
    expect(typeof api?.previewModule).toBe("function");
  });

  it("valide deux brouillons l'un après l'autre, même quand la validation du premier tourne encore", async () => {
    previewAlerts = [];
    jobsStayAlive = true;
    try {
      const a = await call(app, "POST", "/modules/drafts/deux-a/accept", {});
      expect(a.status).toBe(202);
      // La tâche du premier brouillon tourne : le second n'est pas bloqué
      const b = await call(app, "POST", "/modules/drafts/deux-b/accept", {});
      expect(b.status).toBe(202);
      expect(spawned.slice(-2).map((x) => x.args.at(-1))).toEqual(["deux-a", "deux-b"]);
      // …mais un second accept du même brouillon est refusé, avec sa raison
      const again = await call(app, "POST", "/modules/drafts/deux-a/accept", {});
      expect(again.status).toBe(409);
      expect(again.body.error).toContain("travaille encore");
      const st = await call(app, "GET", "/modules/drafts/deux-b/status");
      expect(st.body.job).toMatchObject({ alive: true });
      expect(st.body.job.command.join(" ")).toContain("module-accept");
    } finally {
      jobsStayAlive = false;
    }
  });
});

describe("Styles de la page module", () => {
  it("la jauge de provenance de la liste ne s'applique pas au bloc Sources des attributs", () => {
    // Régression : la classe .prov (jauge de 4 px, overflow hidden) écrasait le <details className="more prov">.
    const css = readFileSync(join(import.meta.dirname, "../../web/src/styles.css"), "utf8");
    const page = readFileSync(join(import.meta.dirname, "../../web/src/pages/Module.tsx"), "utf8");
    const classes = [...page.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/));
    for (const rule of css.matchAll(/(^|\n)([^{}\n]+)\{[^}]*\bheight:\s*4px/g)) {
      for (const cls of rule[2]!.matchAll(/\.([\w-]+)/g)) expect(classes, `.${cls[1]} (jauge 4 px)`).not.toContain(cls[1]);
    }
    expect(css).toMatch(/\.prov-meter\s*\{/);
  });
});
