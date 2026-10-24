import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { Engine } from "../../src/engine/engine";
import { insertPersonas } from "../../src/personas/store";
import { drawPersonas } from "../../src/personas/sampler";
import { createProject, readProjectFile } from "../../src/studies/project";
import { QUESTION_KEY } from "../../src/studies/protocols/concept-price";
import { isUsageLimitError, runStudy } from "../../src/studies/run";
import { findStudy, studyResponses } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { answer, fakeBackend, pack, payer } from "./fixtures";

function setup() {
  const { db, sqlite } = openDb(":memory:");
  runMigrations(db);
  insertPersonas(db, drawPersonas(pack, 99, 30));
  const project = createProject(db, readProjectFile("examples/meal-planner.json"));
  const { study } = createStudy(db, pack, { projectId: project.id, n: 8, seed: 7, backend: "ollama", model: "fake" });
  return { db, sqlite, study };
}

const ok = () => JSON.stringify(answer());

describe("exécution d'une étude", () => {
  it("fige un échantillon reproductible et permet de le reprendre", () => {
    const { db, sqlite, study } = setup();
    const again = createStudy(db, pack, { projectId: study.projectId, n: 8, seed: 7, backend: "ollama", model: "fake" }).study;
    expect(again.personaIds).toEqual(study.personaIds);
    const same = createStudy(db, pack, { projectId: study.projectId, sameSampleAs: study.id, n: 5, backend: "ollama", model: "m", seed: 0 }).study;
    expect(same.personaIds).toEqual(study.personaIds.slice(0, 5));
    expect(same.sampleFromStudyId).toBe(study.id);
    sqlite.close();
  });

  it("combine un groupe cible et un groupe témoin issus de deux populations", () => {
    const { db, sqlite, study } = setup();
    // Une deuxième population (autre graine de tirage, autre pack)
    insertPersonas(db, drawPersonas(pack, 5, 12).map((p) => ({ ...p, id: p.id.replace(pack.manifest.version, "fr-tech-test"), packVersion: "fr-tech-test" })));
    const { study: s2 } = createStudy(db, pack, {
      projectId: study.projectId, seed: 7, backend: "ollama", model: "m",
      populations: [
        { group: "target", packVersion: "fr-tech-test", n: 6 },
        { group: "control", n: 4 },
      ],
    });
    expect(s2.personaIds).toHaveLength(10);
    expect(s2.populations).toEqual([
      { group: "target", packVersion: "fr-tech-test", n: 6 },
      { group: "control", packVersion: pack.manifest.version, n: 4 },
    ]);
    const target = s2.personaIds.filter((id) => s2.personaGroups[id] === "target");
    expect(target).toHaveLength(6);
    expect(target.every((id) => id.startsWith("fr-tech-test"))).toBe(true);
    expect(s2.personaIds.filter((id) => s2.personaGroups[id] === "control").every((id) => id.startsWith(pack.manifest.version))).toBe(true);
    // La reprise d'échantillon garde les groupes
    const same = createStudy(db, pack, { projectId: study.projectId, sameSampleAs: s2.id, backend: "ollama", model: "m", seed: 7 }).study;
    expect(same.personaGroups).toEqual(s2.personaGroups);
    // … ou seulement le groupe cible
    const onlyTarget = createStudy(db, pack, { projectId: study.projectId, sameSampleAs: s2.id, sameSampleGroup: "target", backend: "ollama", model: "m", seed: 7 }).study;
    expect(onlyTarget.personaIds).toEqual(target);
    expect(Object.values(onlyTarget.personaGroups).every((g) => g === "target")).toBe(true);
    expect(onlyTarget.populations).toEqual([{ group: "target", packVersion: "fr-tech-test", n: 6 }]);
    sqlite.close();
  });

  it("respecte des quotas", () => {
    const { db, sqlite, study } = setup();
    const q = createStudy(db, pack, { projectId: study.projectId, n: 6, seed: 3, backend: "ollama", model: "m", quotas: { sex: { F: 0.5, M: 0.5 } } });
    expect(q.shortfalls).toEqual([]);
    const all = db.$client.prepare(`select sex from personas where id in (${q.study.personaIds.map(() => "?").join(",")})`).all(...q.study.personaIds) as Array<{ sex: string }>;
    expect(all.filter((r) => r.sex === "F")).toHaveLength(3);
    sqlite.close();
  });

  it("écrit au fil de l'eau, s'arrête proprement sur un quota atteint et reprend sans refaire", async () => {
    const { db, sqlite, study } = setup();
    // Le quota tombe au 4e appel
    const limited = fakeBackend((_, call) => {
      if (call >= 3) throw new Error("claude a renvoyé une erreur : Claude AI usage limit reached|1760000000");
      return ok();
    }, 1);
    const r1 = await runStudy(db, new Engine(limited.backend), pack, study);
    expect(r1.written).toBe(3);
    expect(r1.stoppedForUsageLimit).toMatch(/usage limit/);
    expect(studyResponses(db, study.id, QUESTION_KEY)).toHaveLength(3);
    expect(findStudy(db, study.id)).toMatchObject({ status: "paused", progressDone: 3 });

    const fresh = fakeBackend(() => ok());
    const r2 = await runStudy(db, new Engine(fresh.backend), pack, findStudy(db, study.id));
    expect(r2.alreadyDone).toBe(3);
    expect(r2.written).toBe(5);
    expect(fresh.requests).toHaveLength(5);
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    expect(new Set(rows.map((r) => r.personaId)).size).toBe(8);
    expect(findStudy(db, study.id)).toMatchObject({ status: "completed", progressDone: 8 });
    expect(rows[0]).toMatchObject({ backend: "ollama", model: "fake", inputTokens: 100, outputTokens: 50 });
    expect(rows.every((r) => r.narrativeUsed === false)).toBe(true); // aucune persona n'a de récit ici

    const r3 = await runStudy(db, new Engine(fakeBackend(() => ok()).backend), pack, findStudy(db, study.id));
    expect(r3.written).toBe(0);
    sqlite.close();
  });

  it("répare une réponse incohérente une fois, puis marque l'anomalie si elle persiste", async () => {
    const { db, sqlite, study } = setup();
    const incoherent = JSON.stringify({ ...payer(), gaborGranger: { at_2_eur: true, at_5_eur: false, at_9_eur: false } });
    let personaCalls = 0;
    const fb = fakeBackend((req) => {
      const repair = req.messages.length > 1;
      if (!repair) personaCalls++;
      // Persona n° 1 : réparée correctement ; les autres : toujours incohérentes
      if (repair && personaCalls === 1) return ok();
      return incoherent;
    }, 1);
    await runStudy(db, new Engine(fb.backend), pack, study);
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.repaired)).toBe(true);
    const fixed = rows.filter((r) => r.anomalies.length === 0);
    expect(fixed).toHaveLength(1);
    expect((fixed[0]!.payload as { answer: { behavior: string } }).answer.behavior).toBe("ignore");
    expect(rows.filter((r) => r.anomalies.includes("pay_without_gg"))).toHaveLength(7);
    expect(rows[0]!.inputTokens).toBe(200); // appel initial + réparation
    const repairMsg = fb.requests.find((r) => r.messages.length === 3)!.messages[2]!.content;
    expect(repairMsg).toMatch(/garde le plus prudent/);
    sqlite.close();
  });

  it("répare une réponse qui invente un fait personnel et transmet le détail", async () => {
    const { db, sqlite, study } = setup();
    const invented = JSON.stringify({ ...answer(), verbatim: "Non, moi j'ai déjà monté ma boîte, ça me suffit." });
    const fb = fakeBackend((req) => (req.messages.length > 1 ? ok() : invented), 1);
    await runStudy(db, new Engine(fb.backend), pack, study);
    const rows = studyResponses(db, study.id, QUESTION_KEY);
    // Les personas tirées ici ne sont pas à leur compte, sauf éventuellement une PCS 2
    const flagged = rows.filter((r) => (r.payload as { initialAnomalies: string[] }).initialAnomalies.includes("invented_business"));
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((r) => r.repaired && r.anomalies.length === 0)).toBe(true);
    const repairMsg = fb.requests.find((r) => r.messages.length === 3)!.messages[2]!.content;
    expect(repairMsg).toMatch(/« j'ai déjà monté ma boîte » : ta fiche ne dit pas/);
    sqlite.close();
  });

  it("reconnaît les erreurs de quota", () => {
    expect(isUsageLimitError(new Error("Claude AI usage limit reached|1760000000"))).toBe(true);
    expect(isUsageLimitError(new Error("You've hit your limit · resets 3pm (Europe/Paris)"))).toBe(true);
    expect(isUsageLimitError(new Error("POST /api/chat : HTTP 429 Too Many Requests"))).toBe(true);
    expect(isUsageLimitError(new Error("Réponse invalide après 3 tentative(s)"))).toBe(false);
  });
});
