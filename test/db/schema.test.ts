import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { personas, projects, responses, studies } from "../../src/db/schema";

describe("schéma", () => {
  it("s'applique sur une base neuve et impose l'unicité (étude, persona, question)", () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const [project] = db.insert(projects).values({ name: "Test", pitch: "Un réseau social pro" }).returning().all();
    const [study] = db
      .insert(studies)
      .values({ projectId: project!.id, name: "É1", protocol: "concept", backend: "ollama", model: "m", seed: 42, sampleSize: 1 })
      .returning()
      .all();
    const [persona] = db
      .insert(personas)
      .values({
        country: "FR", packVersion: "fr-0", age: 19, sex: "F", region: "ARA", townSize: "200k+",
        occupation: "étudiante", monthlyIncomeEur: 600, monthlyDiscretionaryBudgetEur: 180,
        householdType: "seule", techAdoption: "early_majority", priceSensitivity: 0.8,
        skepticism: 0.6, socialMediaUsage: "élevé",
      })
      .returning()
      .all();
    expect(study!.status).toBe("draft");
    expect(persona!.extra).toEqual({});

    const row = {
      studyId: study!.id, personaId: persona!.id, questionKey: "intent",
      payload: { wouldPay: false }, backend: "ollama", model: "m", durationMs: 1200,
    };
    db.insert(responses).values(row).run();
    expect(() => db.insert(responses).values(row).run()).toThrow(/UNIQUE/);
    // Reprise d'étude : on ignore ce qui existe déjà
    db.insert(responses).values(row).onConflictDoNothing().run();
    expect(db.select().from(responses).all()).toHaveLength(1);
    sqlite.close();
  });
});
