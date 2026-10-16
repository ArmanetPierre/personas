import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDb, runMigrations } from "../../src/db/client";
import { drawPersonas } from "../../src/personas/sampler";
import { insertPersonas } from "../../src/personas/store";
import { createProject, readProjectFile } from "../../src/studies/project";
import { BEHAVIOR_LABELS, CHECK_LABELS } from "../../src/studies/protocols/concept-price";
import { GROUP_LABELS, METHOD_NOTE } from "../../src/studies/summary";
import { createApp } from "../../src/web/app";
import { messageIn } from "../../src/web/i18n";
import { BEHAVIOR_LABELS_EN, METHOD_NOTE_EN } from "../../src/web/i18n-labels";
import { Launcher, type SpawnFn } from "../../src/web/launcher";
import { fallbackValidate, moduleView } from "../../src/web/modules";
import { plainCriteria } from "../../src/web/overview";
import { Engine } from "../../src/engine/engine";
import { runStudy } from "../../src/studies/run";
import { createStudy } from "../../src/studies/study";
import { answer, fakeBackend, pack, payer } from "../studies/fixtures";

/** Interface bilingue : `?lang=en` traduit les textes générés par l'API ; sans `lang`, le français est inchangé. */

const logDir = mkdtempSync(join(tmpdir(), "personas-i18n-"));
const { db, sqlite } = openDb(":memory:");
const spawnFn: SpawnFn = () => ({ pid: process.pid, unref() {} });
const app = createApp({ db, pack, config: loadConfig({}), launcher: new Launcher({ root: process.cwd(), logDir, spawnFn, env: {} }) });
const get = async <T = any>(path: string) => {
  const res = await app.request(`/api${path}`);
  return { status: res.status, body: (await res.json()) as T };
};

let studyId = "";
beforeAll(async () => {
  runMigrations(db);
  insertPersonas(db, drawPersonas(pack, 99, 20));
  const project = createProject(db, readProjectFile("examples/meal-planner.json"));
  const { study } = createStudy(db, pack, { projectId: project.id, n: 8, seed: 7, backend: "ollama", model: "fake" });
  const { backend } = fakeBackend((_req, call) => JSON.stringify(call % 3 === 0 ? payer() : answer()));
  await runStudy(db, new Engine(backend), pack, study);
  studyId = study.id;
});

afterAll(() => {
  sqlite.close();
  rmSync(logDir, { recursive: true, force: true });
});

describe("i18n de l'API", () => {
  it("/meta sans lang : libellés français inchangés, identiques à ?lang=fr", async () => {
    const fr = await get("/meta");
    expect(fr.status).toBe(200);
    expect(fr.body.behaviors.find((b: any) => b.id === "pay_subscription").label).toBe(BEHAVIOR_LABELS.pay_subscription);
    expect(fr.body.checks).toEqual(CHECK_LABELS);
    expect(fr.body.groups).toEqual(GROUP_LABELS);
    expect(fr.body.methodNote).toBe(METHOD_NOTE);
    expect(fr.body.priceUnits[0]).toEqual({ id: "month", label: "par mois" });
    expect(fr.body.encounters.article).toBe("Article ou reportage");
    expect(fr.body.backends[0].label).toBe("Claude (abonnement Max, CLI)");
    expect(fr.body.periods.find((p: any) => p.id === "month").label).toBe("mois");
    expect((await get("/meta?lang=fr")).body).toEqual(fr.body);
    expect((await get("/meta?lang=xx")).body).toEqual(fr.body); // langue inconnue : français
  });

  it("/meta?lang=en : libellés en anglais, mêmes codes", async () => {
    const fr = (await get("/meta")).body;
    const { status, body } = await get("/meta?lang=en");
    expect(status).toBe(200);
    expect(body.behaviors.map((b: any) => b.id)).toEqual(fr.behaviors.map((b: any) => b.id));
    expect(body.behaviors.find((b: any) => b.id === "pay_subscription").label).toBe(BEHAVIOR_LABELS_EN.pay_subscription);
    expect(body.objections.find((o: any) => o.id === "price").label).toBe("Price");
    expect(body.relevance.find((r: any) => r.id === "not_concerned").label).toBe("Not concerned");
    expect(body.dimensions.find((d: any) => d.id === "ageBand").label).toBe("Age band");
    expect(body.checks.vw_incomplete).toMatch(/^Van Westendorp incomplete/);
    expect(Object.keys(body.checks)).toEqual(Object.keys(fr.checks));
    expect(body.groups).toEqual({ target: "Target", control: "Control (general population)" });
    expect(body.encounters.word_of_mouth).toMatch(/^Word of mouth/);
    expect(body.periods.find((p: any) => p.id === "month").label).toBe("month");
    expect(body.priceUnits.map((u: any) => u.label)).toContain("per month");
    expect(body.backends[0].label).toBe("Claude (Max subscription, CLI)");
    expect(body.methodNote).toBe(METHOD_NOTE_EN);
    // Données non traduites : identiques
    expect(body.currencies).toEqual(fr.currencies);
    expect(body.packs).toEqual(fr.packs);
  });

  it("plainCriteria en anglais (défaut : français)", () => {
    const expr = "activity_status == employed and age >= 25 and age <= 40 and pcs in [3, 4] and sex != F and tech_adoption in [innovator, early_adopter]";
    const text = (lang?: "fr" | "en") => plainCriteria(expr, (c) => c, lang).criteria.map((c) => (c.value ? `${c.label} : ${c.value}` : c.label));
    expect(text()).toEqual(expect.arrayContaining(["Situation : en emploi", "Âge : de 25 à 40 ans", "Catégorie socioprofessionnelle : cadres ou professions intermédiaires", "Sexe : sauf femme"]));
    expect(text("fr")).toEqual(text());
    expect(text("en")).toEqual(
      expect.arrayContaining([
        "Situation : employed",
        "Age : 25 to 40",
        "Socio-professional category : managers and professionals or intermediate occupations",
        "Sex : except woman",
        "Relationship with digital tech : innovator or early adopter",
      ]),
    );
    const bounds = (e: string) => plainCriteria(e, undefined, "en").criteria[0]!.value;
    expect(bounds("age >= 60")).toBe("60 or more");
    expect(bounds("budget <= 1500")).toBe("1,500 at most");
    expect(plainCriteria("has_computer == true", undefined, "en").criteria[0]!.value).toBe("yes");
  });

  it("404 en anglais : le statut reste 404", async () => {
    const persona = await get("/personas/inconnue?lang=en");
    expect(persona).toEqual({ status: 404, body: { error: "Persona not found: inconnue" } });
    // Erreur levée par src/studies (findStudy), traitée par onError
    const study = await get("/studies/zzz-inconnue?lang=en");
    expect(study.status).toBe(404);
    expect(study.body.error).toBe("Study not found: zzz-inconnue");
    // Sans lang : français inchangé
    expect(await get("/personas/inconnue")).toEqual({ status: 404, body: { error: "Persona introuvable : inconnue" } });
    expect((await get("/studies/zzz-inconnue")).body.error).toBe("Étude introuvable : zzz-inconnue");
    // 400 traduit aussi
    expect((await get("/compare?ids=a&lang=en")).body.error).toBe("Choose at least two studies.");
  });

  it("messages d'erreur : motifs traduits, message inconnu laissé tel quel", () => {
    expect(messageIn("en", "L'étude abc tourne déjà (processus 42).")).toBe("Study abc is already running (process 42).");
    expect(messageIn("en", "Module « numerique » introuvable")).toBe("Module “numerique” not found");
    expect(messageIn("en", "Module « a » introuvable (requis par b)")).toBe("Module “a” not found (required by b)");
    expect(messageIn("en", "Message inconnu")).toBe("Message inconnu");
    expect(messageIn("fr", "Projet introuvable : x")).toBe("Projet introuvable : x");
  });

  it("prix et unité d'un projet historique en anglais", async () => {
    const fr = await get("/projects");
    expect(fr.body[0]).toMatchObject({ price: "5 €/mois", unit: "mois" });
    const en = await get("/projects?lang=en");
    expect(en.body[0]).toMatchObject({ price: "€5/month", unit: "month" });
    const detail = await get("/projects/meal-planner?lang=en");
    expect(detail.body.project).toMatchObject({ price: "€5/month", unit: "month", referencePrice: "€5/month" });
  });

  it("vue d'un module : tournures générées en anglais, libellés du YAML inchangés", () => {
    const def = fallbackValidate(readFileSync(join(import.meta.dirname, "fixtures", "draft-ok.yaml"), "utf8")).def!;
    const fr = moduleView(def);
    const en = moduleView(def, "en");
    const meetings = (v: typeof fr) => v.attributes.find((a) => a.key === "meetings_per_week")!;
    expect(meetings(fr).when).toBe("Situation d'activité = en emploi");
    expect(meetings(en).when).toBe("Activity status = employed");
    expect(meetings(en).distribution).toBe("table conditioned on socio-professional category");
    expect(meetings(en).label).toBe(meetings(fr).label); // libellé du module : donnée
    expect(en.sources[0]!.citedBy[0]).toBe("attribute “Réunions par semaine”");
  });

  it("résumé d'une étude : échelle, niveaux, note de méthode et prix en anglais ; français inchangé", async () => {
    const fr = await get(`/studies/${studyId}/summary`);
    const en = await get(`/studies/${studyId}/summary?lang=en`);
    expect(fr.body.levelLabels.payment).toBe("Paiement");
    expect(en.body.levelLabels.payment).toBe("Payment");
    expect(fr.body.scale.behaviors.find((b: any) => b.code === "pay_subscription").label).toBe(BEHAVIOR_LABELS.pay_subscription);
    expect(en.body.scale.behaviors.find((b: any) => b.code === "pay_subscription").label).toBe(BEHAVIOR_LABELS_EN.pay_subscription);
    expect(en.body.scale.objections.find((o: any) => o.code === "price").label).toBe("Price");
    expect(fr.body.methodNote).toBe(METHOD_NOTE);
    expect(en.body.methodNote).toBe(METHOD_NOTE_EN);
    expect(fr.body).toMatchObject({ unit: "mois", project: { price: "5 €/mois" } });
    expect(en.body).toMatchObject({ unit: "month", project: { price: "€5/month", priceUnit: "month" } });
    // Chiffres identiques
    expect(en.body.overall.behaviors).toEqual(fr.body.overall.behaviors);
  });

  it("vue d'ensemble et réponses : libellés de segments du socle en anglais", async () => {
    const ov = await get(`/projects/meal-planner/overview?lang=en`);
    expect(ov.status).toBe(200);
    expect(ov.body.lastStudy.price).toBe("€5/month");
    const rows = await get(`/studies/${studyId}/responses?lang=en`);
    const rowsFr = await get(`/studies/${studyId}/responses`);
    const seg = rows.body[0].segments;
    const segFr = rowsFr.body[0].segments;
    expect(seg.ageBand.code).toBe(segFr.ageBand.code);
    expect(seg.ageBand.label).not.toMatch(/ans/);
    expect(segFr.ageBand.label).toMatch(/ans/);
    expect(rows.body[0].who).not.toMatch(/ ans$/);
    expect(rowsFr.body[0].who).toMatch(/ ans$/);
  });
});
