/**
 * Client du Hub côté runner (phase 2, lot B), contre un FAUX Hub local (test/hub/fake-hub.ts) : références
 * qualifiées et empreintes, cache vérifié par sha256, ETag et hors ligne, lock et étude épinglée hors ligne,
 * packs du cache, choix automatique des modules (moteur simulé), et aucune fuite du pitch vers le Hub.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { Engine } from "../../src/engine/engine";
import { memoryStore } from "../../src/engine/secrets";
import type { Backend, BackendRequest } from "../../src/engine/types";
import { resolveHubAdminToken } from "../../src/hub/admin";
import { hasCachedModule, hasCachedPack, HubIntegrityError, listCachedPacks, packFilesSha256, readCachedCatalog, sha256Text, writeCachedPack } from "../../src/hub/cache";
import { HubClient } from "../../src/hub/client";
import { lockPathFor, readLockFile, writeLockFile } from "../../src/hub/lock";
import { buildProjectLock } from "../../src/hub/lock-project";
import { pullModule, pullPack } from "../../src/hub/pull";
import { bm25, formatQuality, searchDocs, searchModules } from "../../src/hub/search";
import { invalidateModuleLibraries, MODULES_DIR, moduleLibrary, resolveModules } from "../../src/modules/registry";
import { compareVersions, parseModuleSpec, qualifiedRef } from "../../src/modules/refs";
import { loadPack } from "../../src/personas/pack";
import { invalidatePackSources, packDir } from "../../src/personas/pack-source";
import { drawPersona } from "../../src/personas/sampler";
import { projectRow } from "../../src/population/preview";
import { suggestPrompt, suggestTarget, type TargetSuggestionData } from "../../src/population/suggest";
import { drawTarget, prepareTarget } from "../../src/population/target";
import { createProject } from "../../src/studies/project";
import { createStudy } from "../../src/studies/study";
import { FakeHub } from "./fake-hub";

const repoYaml = (id: string) => readFileSync(join(MODULES_DIR, id, "module.yaml"), "utf8");
const NUMERIQUE_V = "2026.3";

const sportYaml = (version: string, rate = 0.6) => `id: sport-connecte
version: "${version}"
label: Sport connecté
description: Pratique sportive mesurée par une montre connectée ou une application de course à pied.
applies_to: [fr]
requires:
  - {ref: personas/numerique, version: "${NUMERIQUE_V}", as: num}
attributes:
  - key: wears_watch
    label: Porte une montre connectée de sport
    type: boolean
    rate: {if: {attr: num.work_status, present: true}, then: ${rate}, else: 0.2}
    assumption: true
    justification: hypothèse de test
`;

/** Module factice du catalogue (pour dépasser 15 candidats). */
const dummyYaml = (i: number) => `id: domaine-${i}
version: "2026.1"
label: Domaine ${i}
description: Module factice numéro ${i} sur la cuisine, le jardinage et les loisirs.
applies_to: [fr]
attributes:
  - key: level
    label: Niveau ${i}
    type: enum
    values: [{code: low, label: bas}, {code: high, label: haut}]
    distribution: {weights: {low: 0.5, high: 0.5}}
    assumption: true
    justification: test
`;

const PITCH = "Zorglub-Montre : un coach de course qui lit votre montre connectée de sport et adapte vos sorties.";

let hub: FakeHub;
let cache: string;
let client: HubClient;
const savedEnv = { ...process.env };

beforeAll(async () => {
  hub = new FakeHub();
  hub.modules.push(
    { ref: "personas/numerique", yaml: repoYaml("numerique"), status: "verified", quality: { formula: "q1", q: 82, sourcing: 0.9, margins: 0.7, alerts: 0.8, docs: 1 } },
    { ref: "personas/equipement-ecosysteme", yaml: repoYaml("equipement-ecosysteme"), requires: [{ ref: "personas/numerique", version: NUMERIQUE_V, as: "numerique" }] },
    { ref: "alice/sport-connecte", yaml: sportYaml("2026.1"), status: "verified", quality: { formula: "q1", q: 71, sourcing: 0.5, margins: 0.6, alerts: 1, docs: 0.75 }, requires: [{ ref: "personas/numerique", version: NUMERIQUE_V, as: "num" }], tags: ["sport", "montre"] },
  );
  for (let i = 0; i < 20; i++) hub.modules.push({ ref: `bob/domaine-${i}`, yaml: dummyYaml(i), status: "verified", quality: { formula: "q1", q: 60, sourcing: 0.5, margins: 0.5, alerts: 1, docs: 0.5 } });
  await hub.start();
});
afterAll(async () => {
  await hub.stop();
});

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "hub-cache-"));
  process.env.PERSONAS_HUB_CACHE_DIR = cache;
  process.env.PERSONAS_HUB_URL = hub.url;
  client = new HubClient({ baseUrl: hub.url, cacheDir: cache });
  hub.requests = [];
  invalidateModuleLibraries();
  invalidatePackSources();
});
afterEach(() => {
  process.env = { ...savedEnv };
  invalidateModuleLibraries();
  invalidatePackSources();
  rmSync(cache, { recursive: true, force: true });
});

describe("références qualifiées", () => {
  it("canonique nue pour personas/, qualifiée sinon ; versions calendaires", () => {
    expect(parseModuleSpec("numerique")).toEqual({ ref: "numerique", namespace: "personas", slug: "numerique" });
    expect(parseModuleSpec("personas/numerique@2026.3")).toEqual({ ref: "numerique", namespace: "personas", slug: "numerique", version: "2026.3" });
    expect(parseModuleSpec("alice/sport-connecte@2026.1").ref).toBe("alice/sport-connecte");
    expect(qualifiedRef("numerique")).toBe("personas/numerique");
    expect(() => parseModuleSpec("Alice/x")).toThrow(/invalide/);
    expect(compareVersions("2026.10", "2026.3")).toBeGreaterThan(0);
    expect(compareVersions("fr-2026.2", "fr-2026.3")).toBeLessThan(0);
  });

  it("module tiers : forme longue de requires, alias dans les conditions, empreinte sur la référence qualifiée", async () => {
    await pullModule(client, "alice/sport-connecte@2026.1");
    const lib = moduleLibrary();
    const m = lib.get("alice/sport-connecte")!;
    expect(m.source).toBe("hub-cache");
    expect(m.def.requires).toEqual([`personas/numerique@${NUMERIQUE_V}`]);
    expect(m.aliases?.get("num")).toBe("numerique");
    const pack = loadPack("fr-2026.2");
    const resolved = resolveModules(["alice/sport-connecte"], pack.socle);
    expect(resolved.ordered.map((x) => x.def.id)).toEqual(["numerique", "alice/sport-connecte"]);
    const p = drawPersona(pack, 42, 3, { modules: resolved });
    const expected = createHash("sha1").update([`alice/sport-connecte@2026.1`, `numerique@${NUMERIQUE_V}`].sort().join(",")).digest("hex").slice(0, 6);
    expect(p.id).toBe(`fr-2026.2-s42-0004-m${expected}`);
    const mods = (p.extra as { modules: Record<string, Record<string, unknown>> }).modules;
    expect(typeof mods["alice/sport-connecte"]!.wears_watch).toBe("boolean");
    // Le filtre accepte une variable de module tiers
    const prepared = prepareTarget({ socle: "fr", modules: ["alice/sport-connecte"], eligibility: "alice/sport-connecte.wears_watch == true" });
    expect(drawTarget(prepared, 5, 42).personas).toHaveLength(5);
  });

  it("id nu : bibliothèque locale d'abord, puis personas/ du cache ; tirages identiques au dépôt", async () => {
    // numerique est déjà dans la bibliothèque locale à cette version : la dépendance n'est pas retéléchargée
    await pullModule(client, "personas/equipement-ecosysteme@2026.2");
    expect(hub.requests.map((r) => r.url)).toEqual(["/v1/modules/personas/equipement-ecosysteme/2026.2"]);
    await pullModule(client, `personas/numerique@${NUMERIQUE_V}`);
    // Installation neuve sans le dépôt : bibliothèque locale vide, modules officiels pris dans le cache
    const empty = mkdtempSync(join(tmpdir(), "no-modules-"));
    process.env.PERSONAS_MODULES_DIR = empty;
    try {
      const fromCache = moduleLibrary();
      expect(fromCache.get("numerique")?.source).toBe("hub-cache");
      expect(fromCache.get("equipement-ecosysteme")?.source).toBe("hub-cache");
      const pack = loadPack("fr-2026.2");
      const repo = resolveModules(["equipement-ecosysteme"], pack.socle, moduleLibrary(MODULES_DIR));
      const cached = resolveModules(["equipement-ecosysteme"], pack.socle);
      const h = (r: typeof repo) => createHash("sha1").update(JSON.stringify(Array.from({ length: 300 }, (_, i) => drawPersona(pack, 42, i, { modules: r })))).digest("hex");
      expect(h(cached)).toBe(h(repo));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    // Avec le dépôt : la copie locale est prioritaire
    delete process.env.PERSONAS_MODULES_DIR;
    invalidateModuleLibraries();
    expect(moduleLibrary().get("numerique")?.source).toBe("local");
  });
});

describe("cache et intégrité", () => {
  it("refuse un contenu dont le sha256 ne correspond pas (réponse ou catalogue) et n'écrit rien", async () => {
    const sport = hub.modules.find((m) => m.ref === "alice/sport-connecte")!;
    sport.announcedSha = "0".repeat(64);
    try {
      await expect(pullModule(client, "alice/sport-connecte@2026.1")).rejects.toThrow(/sha256 refusé/);
    } finally {
      delete sport.announcedSha;
    }
    expect(existsSync(join(cache, "modules", "alice"))).toBe(false);
    // Catalogue qui annonce une autre empreinte que le contenu servi
    const catalog = hub.catalog();
    catalog.modules.find((m) => m.ref === "alice/sport-connecte")!.versions[0]!.sha256 = "1".repeat(64);
    await expect(pullModule(client, "alice/sport-connecte@2026.1", { catalog })).rejects.toThrow(/différent de celui du catalogue/);
    expect(existsSync(join(cache, "modules", "alice"))).toBe(false);
  });

  it("revérifie le cache avant usage : une copie altérée est refusée", async () => {
    await pullModule(client, "alice/sport-connecte@2026.1");
    const file = join(cache, "modules", "alice", "sport-connecte", "2026.1", "module.yaml");
    writeFileSync(file, sportYaml("2026.1", 0.99));
    invalidateModuleLibraries();
    expect(() => resolveModules(["alice/sport-connecte@2026.1"], "fr")).toThrow(HubIntegrityError);
  });

  it("cache incomplet (module.yaml absent, _hub.json présent) : téléchargé de nouveau, sans erreur", async () => {
    await pullModule(client, "alice/sport-connecte@2026.1");
    const dir = join(cache, "modules", "alice", "sport-connecte", "2026.1");
    rmSync(join(dir, "module.yaml"));
    expect(existsSync(join(dir, "_hub.json"))).toBe(true);
    expect(hasCachedModule(cache, "alice", "sport-connecte", "2026.1")).toBe(false);
    invalidateModuleLibraries();
    hub.requests = [];
    const r = await pullModule(client, "alice/sport-connecte@2026.1");
    expect(r.find((x) => x.ref === "alice/sport-connecte")).toMatchObject({ already: false });
    expect(hub.requests.some((q) => q.url.includes("/modules/alice/sport-connecte/2026.1"))).toBe(true);
    expect(readFileSync(join(dir, "module.yaml"), "utf8")).toBe(sportYaml("2026.1"));
    // Métadonnées illisibles : même traitement (copie incomplète, pas « altérée »)
    writeFileSync(join(dir, "_hub.json"), "{");
    invalidateModuleLibraries();
    const again = await pullModule(client, "alice/sport-connecte@2026.1");
    expect(again.find((x) => x.ref === "alice/sport-connecte")).toMatchObject({ already: false });
    // Contenu présent mais différent : toujours refusé comme altéré
    writeFileSync(join(dir, "module.yaml"), sportYaml("2026.1", 0.99));
    invalidateModuleLibraries();
    await expect(pullModule(client, "alice/sport-connecte@2026.1")).rejects.toThrow(/Cache du Hub altéré/);
  });

  it("catalogue : ETag (304), puis hors ligne → dernier catalogue en cache avec un message clair", async () => {
    const first = await client.catalog();
    expect(first.source).toBe("network");
    expect(first.catalog!.modules.length).toBe(23);
    const second = await client.catalog();
    expect(second.source).toBe("not-modified");
    expect(hub.requests.at(-1)!.headers["if-none-match"]).toBe(hub.etag);
    expect(hub.requests.at(-1)!.headers["user-agent"]).toMatch(/^personas\//);
    const offline = new HubClient({ baseUrl: "http://127.0.0.1:9", cacheDir: cache, timeoutMs: 2000 });
    const r = await offline.catalog();
    expect(r.source).toBe("cache");
    expect(r.offline).toMatch(/Hub injoignable .*Hors ligne/);
    expect(r.catalog!.modules.length).toBe(23);
    expect(readCachedCatalog(cache)?.meta.etag).toBe(hub.etag);
    await expect(offline.moduleVersion("alice/sport-connecte", "2026.1")).rejects.toThrow(/Hub injoignable/);
    const none = await new HubClient({ baseUrl: "http://127.0.0.1:9", cacheDir: mkdtempSync(join(tmpdir(), "empty-")), timeoutMs: 2000 }).catalog();
    expect(none.source).toBe("none");
  });

  it("erreurs du contrat lisibles (not_found)", async () => {
    await expect(client.moduleVersion("alice/inconnu", "1")).rejects.toThrow(/introuvable \(not_found\)/);
  });
});

describe("lock et étude épinglée hors ligne", () => {
  const target = { socle: "fr", modules: ["alice/sport-connecte"], eligibility: "alice/sport-connecte.wears_watch == true" };

  it("épingle versions et sha256 ; la version épinglée l'emporte sur une plus récente ; tourne sans Hub", async () => {
    await pullModule(client, "alice/sport-connecte@2026.1");
    const lock = buildProjectLock({ extra: { target } });
    expect(Object.keys(lock.modules)).toEqual(["alice/sport-connecte", "personas/numerique"]);
    expect(lock.modules["alice/sport-connecte"]).toEqual({ version: "2026.1", sha256: sha256Text(sportYaml("2026.1")), source: "hub-cache" });
    expect(lock.socles.fr).toMatchObject({ ref: "personas/fr", version: "fr-2026.2", source: "local" });
    const before = drawTarget(prepareTarget(target, { lock }), 8, 42).personas.map((p) => p.id);

    // Une version plus récente arrive dans le cache : par défaut elle est prise, jamais pour le projet épinglé
    hub.modules.push({ ref: "alice/sport-connecte", yaml: sportYaml("2026.2", 0.3), requires: [{ ref: "personas/numerique", version: NUMERIQUE_V, as: "num" }] });
    try {
      await pullModule(client, "alice/sport-connecte@2026.2");
    } finally {
      hub.modules.pop();
    }
    expect(moduleLibrary().get("alice/sport-connecte")!.def.version).toBe("2026.2");

    // Hors ligne (Hub arrêté) : l'étude épinglée se prépare et se tire depuis le cache, à l'identique
    const offlineEnv = process.env.PERSONAS_HUB_URL;
    process.env.PERSONAS_HUB_URL = "http://127.0.0.1:9";
    const pinned = prepareTarget(target, { lock });
    expect(pinned.modules.ordered.map((m) => `${m.def.id}@${m.def.version}`)).toEqual([`numerique@${NUMERIQUE_V}`, "alice/sport-connecte@2026.1"]);
    expect(drawTarget(pinned, 8, 42).personas.map((p) => p.id)).toEqual(before);
    process.env.PERSONAS_HUB_URL = offlineEnv;

    // Étude : le lock du projet est appliqué et les versions exactes sont enregistrées
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    const file = join(dir, "montre.yaml");
    writeFileSync(file, `name: Montre\npitch: ${JSON.stringify(PITCH)}\nprice: {amountEur: 5, period: month}\ntarget: ${JSON.stringify(target)}\n`);
    writeLockFile(lockPathFor(file), lock);
    expect(readLockFile(lockPathFor(file))).toEqual(lock);
    const { readProjectFile } = await import("../../src/studies/project");
    const project = createProject(db, readProjectFile(file), { sourceFile: file });
    expect((project.extra as { lock?: unknown }).lock).toEqual(lock);
    const { study } = createStudy(db, loadPack("fr-2026.2"), { projectId: project.id, populations: [{ group: "target", n: 4, target }], seed: 42, backend: "ollama", model: "fake", force: true });
    const pop = study.populations[0] as unknown as { eligibility: { modules: string[]; lock: { modules: Record<string, { version: string; sha256: string }> } } };
    expect(pop.eligibility.modules).toEqual([`numerique@${NUMERIQUE_V}`, "alice/sport-connecte@2026.1"]);
    expect(pop.eligibility.lock.modules["alice/sport-connecte"]!.sha256).toBe(lock.modules["alice/sport-connecte"]!.sha256);
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuse un lock dont le sha256 ne correspond plus, et une version absente du cache (message de téléchargement)", async () => {
    await pullModule(client, "alice/sport-connecte@2026.1");
    const lock = buildProjectLock({ extra: { target } });
    const bad = structuredClone(lock);
    bad.modules["alice/sport-connecte"]!.sha256 = "2".repeat(64);
    expect(() => prepareTarget(target, { lock: bad })).toThrow(/contenu différent de celui épinglé/);
    const missing = structuredClone(lock);
    missing.modules["alice/sport-connecte"]!.version = "2026.9";
    expect(() => prepareTarget(target, { lock: missing })).toThrow(/introuvable.*personas hub pull alice\/sport-connecte@2026\.9/);
    const socle = structuredClone(lock);
    socle.socles.fr!.sha256 = "3".repeat(64);
    expect(() => prepareTarget(target, { lock: socle })).toThrow(/Socle épinglé .* contenu différent/);
  });
});

describe("packs du cache", () => {
  it("télécharge une version de pack (extends compris), vérifiée, chargée comme un pack du dépôt", async () => {
    const pj = JSON.parse(readFileSync("packs/fr-2026.2/pack.json", "utf8")) as Record<string, unknown>;
    const files = { "pack.json": `${JSON.stringify({ ...pj, version: "fr-2026.9" }, null, 1)}\n` };
    hub.packs.push({ ref: "personas/fr", version: "fr-2026.9", files, extends: "fr-2026.1" });
    try {
      const r = await pullPack(client, "personas/fr@fr-2026.9");
      expect(r.map((x) => [x.version, x.already])).toEqual([["fr-2026.9", false]]); // base fr-2026.1 = packs/fr du dépôt
      const p = loadPack("fr-2026.9");
      expect(p.socle).toBe("fr");
      const a = drawPersona(p, 42, 5);
      const b = drawPersona(loadPack("fr-2026.2"), 42, 5);
      expect({ ...a, id: "", packVersion: "" }).toEqual({ ...b, id: "", packVersion: "" });
      // Altéré après coup : refusé au chargement
      writeFileSync(join(cache, "packs", "personas", "fr", "fr-2026.9", "pack.json"), files["pack.json"].replace("socle v2", "socle v2 modifié"));
      invalidatePackSources();
      expect(() => packDir("fr-2026.9")).toThrow(HubIntegrityError);
      hub.packs[0]!.announcedSha = "4".repeat(64);
      hub.packs[0]!.version = "fr-2026.10";
      hub.packs[0]!.files = { "pack.json": files["pack.json"].replace("fr-2026.9", "fr-2026.10") };
      await expect(pullPack(client, "personas/fr@fr-2026.10")).rejects.toThrow(/sha256 refusé/);
    } finally {
      hub.packs = [];
    }
  });

  it("pack incomplet (pack.json absent, _hub.json présent) : ignoré puis téléchargé de nouveau", async () => {
    const pj = JSON.parse(readFileSync("packs/fr-2026.2/pack.json", "utf8")) as Record<string, unknown>;
    const files = { "pack.json": `${JSON.stringify({ ...pj, version: "fr-2026.9" }, null, 1)}\n` };
    hub.packs.push({ ref: "personas/fr", version: "fr-2026.9", files, extends: "fr-2026.1" });
    try {
      await pullPack(client, "personas/fr@fr-2026.9");
      const dir = join(cache, "packs", "personas", "fr", "fr-2026.9");
      expect(JSON.parse(readFileSync(join(dir, "_hub.json"), "utf8")).files).toEqual(["pack.json"]);
      rmSync(join(dir, "pack.json"));
      expect(hasCachedPack(cache, "personas", "fr", "fr-2026.9")).toBe(false);
      invalidatePackSources();
      hub.requests = [];
      const r = await pullPack(client, "personas/fr@fr-2026.9");
      expect(r.map((x) => [x.version, x.already])).toEqual([["fr-2026.9", false]]);
      expect(hub.requests.some((q) => q.url.includes("fr-2026.9"))).toBe(true);
      expect(loadPack("fr-2026.9").socle).toBe("fr");
    } finally {
      hub.packs = [];
    }
  });

  it("pack incomplet : une table listée dans les métadonnées manque → la version n'est pas en cache", () => {
    const files = { "pack.json": '{"version":"xx-2026.1"}\n', "extra.json": "{}\n" };
    const dir = writeCachedPack(cache, { ref: "personas/xx", version: "xx-2026.1", sha256: packFilesSha256(files), extends: null, license: "CC-BY-4.0", fetchedAt: "", hubUrl: "" }, files);
    expect(hasCachedPack(cache, "personas", "xx", "xx-2026.1")).toBe(true);
    expect(listCachedPacks(cache).map((v) => v.version)).toEqual(["xx-2026.1"]);
    rmSync(join(dir, "extra.json"));
    expect(hasCachedPack(cache, "personas", "xx", "xx-2026.1")).toBe(false);
    expect(listCachedPacks(cache)).toEqual([]);
  });
});

describe("recherche locale et choix automatique", () => {
  function fakeEngine(reply: TargetSuggestionData) {
    const requests: BackendRequest[] = [];
    const backend: Backend = {
      name: "claude-cli",
      model: "fake",
      concurrency: 1,
      checkAvailability: async () => ({ ok: true, detail: "simulé" }),
      async generate(req) {
        requests.push(req);
        return { text: JSON.stringify(reply), model: "fake", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    return { engine: new Engine(backend, { maxRepairs: 0 }), requests };
  }
  const reply: TargetSuggestionData = {
    analysis: "Il faut une montre connectée de sport.",
    usageConditions: [{ condition: "porter une montre", attribute: "alice/sport-connecte.wears_watch", why: "le produit lit la montre" }],
    variants: [{ id: "coeur", label: "Cœur", description: "Porteurs de montre", modules: ["alice/sport-connecte"], eligibility: "alice/sport-connecte.wears_watch == true", quotas: [], justification: [{ criterion: "montre", why: "usage" }] }],
    missingModules: [{ id: "course-a-pied", description: "Pratique de la course à pied et montre connectée de sport", attributes: ["runs_weekly"], why: "fréquence" }],
    notes: [],
  };
  const project = { id: "montre", name: "Montre", pitch: PITCH, price: { amountEur: 5, period: "month" as const } };

  it("BM25 : la carte la plus proche arrive en tête ; Q décomposé", async () => {
    const { catalog } = await client.catalog();
    const hits = searchModules("montre connectée sport", { lib: moduleLibrary(), catalog, socle: "fr" });
    expect(hits[0]!.doc.ref).toBe("alice/sport-connecte");
    expect(hits[0]!.doc.source).toBe("hub");
    expect(formatQuality(hits[0]!.doc.quality)).toBe("Q 71 (sourçage 0,5 · marges 0,6 · alertes 1 · doc 0,75)");
    expect(bm25(searchDocs(moduleLibrary(), catalog), "zzz")).toEqual([]);
  });

  it("pré-sélectionne ≤ 15 candidats (locaux + catalogue), télécharge ceux à utiliser, cherche avant de créer, sans rien envoyer du projet", async () => {
    const { catalog } = await client.catalog();
    hub.requests = [];
    const { engine, requests } = fakeEngine(reply);
    const s = await suggestTarget(project, { engine, preview: false, hub: { catalog, pull: async (ref, v) => void (await pullModule(client, `${ref}@${v}`, { catalog })) } });
    const prompt = requests[0]!.messages[0]!.content as string;
    const headings = prompt.match(/^### /gm) ?? [];
    expect(headings.length).toBeLessThanOrEqual(15);
    expect(prompt).toMatch(/^### alice\/sport-connecte : Sport connecté/m);
    expect(prompt).toMatch(/- alice\/sport-connecte\.wears_watch \[boolean\]/);
    expect(s.variants[0]!.errors).toEqual([]);
    expect(s.hub!.candidates.length).toBeLessThanOrEqual(15);
    expect(s.hub!.candidates[0]!.ref).toBe("alice/sport-connecte");
    expect(s.hub!.missingMatches["course-a-pied"]![0]!.ref).toBe("alice/sport-connecte");
    // Le Hub n'a vu que des GET d'objets publics, sans aucun mot du pitch
    expect(hub.requests.length).toBeGreaterThan(0);
    for (const r of hub.requests) {
      expect(r.method).toBe("GET");
      expect(r.url).toMatch(/^\/v1\/modules\//);
      expect(`${r.url} ${r.body} ${JSON.stringify(r.headers)}`).not.toMatch(/zorglub|coach|course|sorties/i);
    }
  });

  it("sans catalogue du Hub : prompt identique à l'historique (bibliothèque entière)", async () => {
    const { engine, requests } = fakeEngine({ ...reply, variants: [{ ...reply.variants[0]!, modules: ["numerique"], eligibility: "numerique.is_digital_worker" }], missingModules: [] });
    const s = await suggestTarget(project, { engine, preview: false, hub: { catalog: null } });
    expect(requests[0]!.messages[0]!.content).toBe(suggestPrompt(projectRow(project)));
    expect(s.hub).toBeUndefined();
    // Défaut sous vitest : aucun cache réel lu
    delete process.env.PERSONAS_HUB_CACHE_DIR;
    const r2 = fakeEngine({ ...reply, variants: [{ ...reply.variants[0]!, modules: ["numerique"], eligibility: "numerique.is_digital_worker" }], missingModules: [] });
    await suggestTarget(project, { engine: r2.engine, preview: false });
    expect(r2.requests[0]!.messages[0]!.content).toBe(suggestPrompt(projectRow(project)));
  });

  it("le client n'a aucune méthode qui envoie un projet : lecture publique, compte, actions explicites, télémétrie", () => {
    const methods = Object.getOwnPropertyNames(HubClient.prototype).filter((m) => m !== "constructor").sort();
    // Lecture publique, flux d'appareil, compte, actions explicites de l'utilisateur, télémétrie (agrégats, schéma strict)
    expect(methods).toEqual(["catalog", "deviceCode", "deviceToken", "forkModule", "keys", "me", "moduleVersion", "packVersion", "publishModule", "publishPack", "publishUserModule", "publishUserPack", "report", "review", "search", "star", "telemetry", "unstar"]);
    // Arité : aucune ne prend plus que (référence, version) ou (requête publique, jeton)
    for (const m of methods) expect((HubClient.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!.length).toBeLessThanOrEqual(2);
  });
});

describe("publication d'administration", () => {
  it("jeton : environnement puis trousseau ; jamais dans les messages", async () => {
    expect(await resolveHubAdminToken({ env: { HUB_ADMIN_TOKEN: "abc" }, store: memoryStore() })).toEqual({ token: "abc", source: "env" });
    expect(await resolveHubAdminToken({ env: {}, store: memoryStore({ "hub-admin": "k" }) })).toEqual({ token: "k", source: "keychain" });
    expect(await resolveHubAdminToken({ env: {}, store: memoryStore() })).toBeNull();
    const r = await client.publishModule({ namespace: "personas", yaml: repoYaml("numerique") }, hub.adminToken);
    expect(r).toMatchObject({ ref: "personas/numerique", version: NUMERIQUE_V });
    expect(hub.requests.at(-1)!.headers.authorization).toBe(`Bearer ${hub.adminToken}`);
    const err = await client.publishModule({ namespace: "personas", yaml: repoYaml("numerique") }, "secret-xyz").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/unauthorized/);
    expect((err as Error).message).not.toMatch(/secret-xyz/);
  });
});

describe("API locale du tableau de bord", () => {
  it("catalogue en cache, mise à jour, téléchargement dans le cache", async () => {
    const { Hono } = await import("hono");
    const { registerHubRoutes } = await import("../../src/web/hub-routes");
    const api = new Hono();
    registerHubRoutes(api, { cacheDir: cache, client: () => client });
    const before = (await (await api.request("/hub/catalog")).json()) as { available: boolean };
    expect(before.available).toBe(false);
    const synced = (await (await api.request("/hub/sync", { method: "POST" })).json()) as { available: boolean; modules: Array<{ ref: string; cached: boolean; localVersion: string | null; quality: unknown }> };
    expect(synced.available).toBe(true);
    const sport = synced.modules.find((m) => m.ref === "alice/sport-connecte")!;
    expect(sport).toMatchObject({ cached: false, localVersion: null, quality: { q: 71 } });
    expect(synced.modules.find((m) => m.ref === "personas/numerique")).toMatchObject({ cached: true, localVersion: NUMERIQUE_V });
    const pulled = await api.request("/hub/pull", { method: "POST", body: JSON.stringify({ ref: "alice/sport-connecte" }), headers: { "content-type": "application/json" } });
    expect(pulled.status).toBe(200);
    const after = (await (await api.request("/hub/catalog")).json()) as { modules: Array<{ ref: string; cached: boolean }> };
    expect(after.modules.find((m) => m.ref === "alice/sport-connecte")!.cached).toBe(true);
    expect((await api.request("/hub/pull", { method: "POST", body: "{}" })).status).toBe(400);
  });
});
