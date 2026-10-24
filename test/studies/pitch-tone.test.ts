import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import type { Project } from "../../src/db/schema";
import { Engine } from "../../src/engine/engine";
import { insertPersonas } from "../../src/personas/store";
import { drawPersonas } from "../../src/personas/sampler";
import { neutralizePitch } from "../../src/studies/pitch-neutralize";
import { checkFacts, lexicalTone, namesOf, numbersOf, TONE_WARNING_THRESHOLD, toneWarning } from "../../src/studies/pitch-tone";
import { createProject, projectFileSchema, readProjectFile } from "../../src/studies/project";
import { createStudy } from "../../src/studies/study";
import { fakeBackend, pack } from "./fixtures";

const pitchOf = (f: string) => readProjectFile(f).pitch;
const FACT = pitchOf("examples/pitch-tone/conciergerie-factuel.json");
const COMM = pitchOf("examples/pitch-tone/conciergerie-commercial.json");
const OVER = pitchOf("examples/pitch-tone/conciergerie-survendu.json");

describe("détection du ton", () => {
  it("donne des scores croissants sur les 3 pitchs de l'expérience", () => {
    const [f, c, o] = [FACT, COMM, OVER].map((p) => lexicalTone(p).score);
    expect(f).toBeLessThan(TONE_WARNING_THRESHOLD);
    expect(c).toBeGreaterThanOrEqual(TONE_WARNING_THRESHOLD);
    expect(o).toBeGreaterThan(c!);
    const cats = new Set(lexicalTone(OVER).hits.map((h) => h.category));
    for (const k of ["superlative", "social_proof", "urgency", "price_judgment", "unverifiable_promise"]) expect(cats.has(k as never)).toBe(true);
  });
  it("n'avertit pas sur les exemples factuels", () => {
    const files = ["examples/meal-planner.json", "examples/variants/meal-planner-dietitian-booking.json", ...readdirSync("examples/pricing").map((f) => `examples/pricing/${f}`)];
    for (const f of files) expect(toneWarning(pitchOf(f)).warn).toBe(false);
    const w = toneWarning(OVER);
    expect(w.warn).toBe(true);
    expect(w.message).toMatch(/project:neutralize-pitch/);
  });
});

describe("détection du ton en anglais", () => {
  const EN = (k: string) => pitchOf(`examples/pitch-tone/conciergerie-en-${k}.json`);
  const vitrine = readProjectFile("examples/sg/home-barbecue-chef.yaml");
  it("donne des scores croissants sur la traduction des 3 pitchs", () => {
    const [f, c, o] = ["factuel", "commercial", "survendu"].map((k) => lexicalTone(EN(k), "en").score);
    expect(f).toBeLessThan(TONE_WARNING_THRESHOLD);
    expect(c).toBeGreaterThan(TONE_WARNING_THRESHOLD);
    expect(o).toBeGreaterThanOrEqual(c! + 30);
    const cats = new Set(lexicalTone(EN("survendu"), "en").hits.map((h) => h.category));
    for (const k of ["superlative", "social_proof", "urgency", "price_judgment", "unverifiable_promise"]) expect(cats.has(k as never)).toBe(true);
  });
  it("détecte le registre de vitrine (comparaison chiffrée, désintermédiation) sans toucher au pitch neutre", () => {
    const orig = lexicalTone(vitrine.pitchOriginal!, "en");
    expect(orig.score).toBeGreaterThan(TONE_WARNING_THRESHOLD);
    expect(orig.hits.map((h) => h.text)).toEqual(expect.arrayContaining(["no middleman", "−50% vs.", "you pay what restaurants pay", "100% whole"]));
    expect(lexicalTone(vitrine.pitch, "en").score).toBeLessThan(TONE_WARNING_THRESHOLD);
    expect(toneWarning(vitrine.pitch, TONE_WARNING_THRESHOLD, "en").warn).toBe(false);
  });
  it("marqueurs unitaires : réductions, urgence, capitales", () => {
    const s = (t: string) => lexicalTone(t, "en").hits.map((h) => h.category);
    expect(s("Save up to 30% today.")).toContain("price_judgment");
    expect(s("Now 20% off all menus.")).toContain("price_judgment");
    expect(s("Limited stock, while stocks last.")).toEqual(["urgency", "urgency"]);
    expect(s("ORDER NOW for the weekend.")).toContain("emotional");
    expect(s("Prices include 9% GST, paid in SGD.")).toEqual([]);
  });
});

describe("conservation des faits", () => {
  it("extrait nombres et noms", () => {
    expect(numbersOf(FACT)).toEqual(["19 €", "6 €", "48", "72 h"]);
    expect(namesOf(FACT)).toEqual(expect.arrayContaining(["Paris", "Île-de-France"]));
  });
  it("signale un nombre ou un lieu perdu, et un nombre ajouté", () => {
    const neutral = "Conciergerie express : pressing et colis à domicile. 19 € par mois, quatre passages, à Paris et en petite couronne.";
    const fc = checkFacts(COMM, neutral, [{ fact: "réparation de chaussures", keyTerms: ["chaussures"] }]);
    expect(fc.ok).toBe(false);
    expect(fc.numbersMissing).toEqual(["6 €"]);
    expect(fc.factsMissing).toEqual(["réparation de chaussures"]);
    const added = checkFacts(COMM, `${COMM} Délai : 48 h.`);
    expect(added.numbersAdded).toEqual(["48 h"]);
    expect(checkFacts(COMM, COMM.replace("Paris", "Lyon")).namesMissing).toContain("Paris");
    expect(checkFacts(FACT, FACT).ok).toBe(true);
  });
});

describe("neutralisation (backend simulé)", () => {
  const project = { id: "x", name: "Conciergerie express", pitch: OVER, freeOffer: null, priceEur: 19, pricePeriod: "month", extra: {} } as unknown as Project;
  const answer = (neutral: string) => ({
    passages: [{ text: "un prix imbattable", category: "price_judgment", reason: "jugement", replacement: "" }],
    neutral,
    facts: [{ fact: "zone", keyTerms: ["Paris"] }],
    missingInfo: ["délais"],
    toneBefore: 92,
    toneAfter: 5,
  });
  const good = FACT.replace("Île-de-France", "ville").replace(" Les délais dépendent des prestataires (pressing : 48 à 72 h).", "");
  it("répare une version qui perd un fait, puis contrôle", async () => {
    const fb = fakeBackend((req) => JSON.stringify(answer(req.messages.length > 1 ? good : good.replace("6 €", "quelques euros"))), 1);
    const r = await neutralizePitch(project, { engine: new Engine(fb.backend) });
    expect(r.factCheck.repaired).toBe(true);
    expect(r.factCheck.ok).toBe(true);
    expect(fb.requests[1]!.messages[2]!.content).toMatch(/« 6 € »/);
    expect(r.lexicalScore.before).toBe(100);
    expect(r.lexicalScore.after).toBeLessThan(TONE_WARNING_THRESHOLD);
    expect(r.toneScore).toEqual({ before: 92, after: 5 });
    expect(r.usage.calls).toBe(2);
  });
  it("signale ce qui reste faux après réparation", async () => {
    const fb = fakeBackend(() => JSON.stringify(answer(good.replace("Paris", "Lyon"))), 1);
    const r = await neutralizePitch(project, { engine: new Engine(fb.backend) });
    expect(r.factCheck.ok).toBe(false);
    expect(r.factCheck.namesMissing).toContain("Paris");
  });
});

describe("schéma du projet et garde-fou", () => {
  it("reste rétrocompatible et garde les deux versions du pitch", () => {
    const base = readProjectFile("examples/pitch-tone/conciergerie-factuel.json");
    expect(base.pitchOriginal).toBeUndefined();
    const withBoth = projectFileSchema.parse({ ...base, pitchOriginal: OVER, pitchNeutralized: true });
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const p0 = createProject(db, base);
    expect(Object.keys(p0.extra)).not.toContain("pitchOriginal");
    const p1 = createProject(db, { ...withBoth, id: "neutre" });
    expect(p1.pitch).toBe(FACT);
    expect(p1.extra).toMatchObject({ pitchOriginal: OVER, pitchNeutralized: true });
    sqlite.close();
  });
  it("protocole v2 : avertit à la création d'une étude si le pitch est commercial, sans bloquer", () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 10));
    const over = createProject(db, readProjectFile("examples/pitch-tone/conciergerie-survendu.json"));
    const fact = createProject(db, readProjectFile("examples/pitch-tone/conciergerie-factuel.json"));
    const r1 = createStudy(db, pack, { projectId: over.id, n: 3, seed: 1, backend: "ollama", model: "m", protocolVersion: "2" });
    expect(r1.pitchTone?.warn).toBe(true);
    expect(r1.notes.join(" ")).toMatch(/ton commercial/);
    expect(r1.study.id).toBeTruthy();
    expect(r1.study.protocolVersion).toBe("2");
    const r2 = createStudy(db, pack, { projectId: fact.id, n: 3, seed: 1, backend: "ollama", model: "m", protocolVersion: "2" });
    expect(r2.pitchTone).toBeUndefined();
    sqlite.close();
  });

  it("protocoles v4 (défaut) et v3 : refusent un pitch commercial sauf --force, sans neutraliser en silence", () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    insertPersonas(db, drawPersonas(pack, 99, 10));
    const over = createProject(db, readProjectFile("examples/pitch-tone/conciergerie-survendu.json"));
    const fact = createProject(db, readProjectFile("examples/pitch-tone/conciergerie-factuel.json"));
    const before = db.$client.prepare("select count(*) as n from studies").get() as { n: number };
    expect(() => createStudy(db, pack, { projectId: over.id, n: 3, seed: 1, backend: "ollama", model: "m" })).toThrow(/protocole v4 exige un pitch neutre.*--force/);
    expect(() => createStudy(db, pack, { projectId: over.id, n: 3, seed: 1, backend: "ollama", model: "m", protocolVersion: "3" })).toThrow(/protocole v3 exige un pitch neutre.*--force/);
    expect((db.$client.prepare("select count(*) as n from studies").get() as { n: number }).n).toBe(before.n);
    const forced = createStudy(db, pack, { projectId: over.id, n: 3, seed: 1, backend: "ollama", model: "m", force: true });
    expect(forced.study.protocolVersion).toBe("4");
    expect(forced.pitchTone?.warn).toBe(true);
    expect(forced.notes.join(" ")).toMatch(/étude forcée/);
    // Le pitch du projet n'est pas modifié
    expect((db.$client.prepare("select pitch from projects where id = ?").get(over.id) as { pitch: string }).pitch).toBe(readProjectFile("examples/pitch-tone/conciergerie-survendu.json").pitch);
    const ok = createStudy(db, pack, { projectId: fact.id, n: 3, seed: 1, backend: "ollama", model: "m" });
    expect(ok.study.protocolVersion).toBe("4");
    expect(ok.pitchTone).toBeUndefined();
    sqlite.close();
  });
});
