import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import { Engine } from "../../src/engine/engine";
import { loadPack } from "../../src/personas/pack";
import type { TargetSpec } from "../../src/population/target";
import { createProject, getProject, readProjectFile } from "../../src/studies/project";
import { studyTiers } from "../../src/studies/protocols/concept-price";
import { baseSocleOf, checkTargetPatch, createNextStudy, recommendStudy, withBaseSocle } from "../../src/studies/recommend";
import { runStudy } from "../../src/studies/run";
import { createStudy } from "../../src/studies/study";
import { answer, fakeBackend } from "./fixtures";

/**
 * Non-régression (projet sur le socle Singapour) : le filtre de cible d'une étude suivante était vérifié
 * contre le socle France, d'où « Module « barbecue-reception » non compatible avec le socle « fr » ».
 */
const sg = loadPack("sg");
const SG_PROJECT = "examples/sg/home-barbecue-chef.yaml";
const MODULES = ["barbecue-reception", "viande-alimentation", "achats-groupes-communaute"];
const NARROW =
  "age >= 30 and age <= 45 and barbecue-reception.bbq_grill_access in [condo_shared_pit, landed_private_grill] and barbecue-reception.typical_table_size >= 6 and barbecue-reception.bbq_per_month >= 1 and viande-alimentation.dietary_restriction not in [vegetarian, halal_strict]";

describe("filtre de cible d'une étude suivante sur le socle Singapour", () => {
  it("se vérifie sur le socle de la cible, pas sur la France", () => {
    const t = checkTargetPatch({ socle: "sg", modules: MODULES, eligibility: NARROW });
    expect(t.errors).toEqual([]);
    expect(t.rate).toBeGreaterThan(0);
    // Codes et variables du socle Singapour
    expect(checkTargetPatch({ socle: "sg", modules: [], eligibility: "dwelling in [condo, landed] and residency_status != mdw" }).errors).toEqual([]);
    expect(checkTargetPatch({ socle: "sg", modules: [], eligibility: "dwelling == castle" }).errors.join(" ")).toMatch(/dwelling : code/);
    // Le socle France refuse toujours les modules de Singapour
    expect(checkTargetPatch({ socle: "fr", modules: MODULES, eligibility: NARROW }).errors.join(" ")).toMatch(/non compatible avec le socle « fr »/);
  }, 30_000);

  it("un patch sans socle ou d'un autre pays reprend le socle du projet", () => {
    expect(withBaseSocle({ target: { socle: "fr", modules: MODULES } }, "sg")).toEqual({ target: { socle: "sg", modules: MODULES } });
    expect(withBaseSocle({ target: { modules: MODULES } }, "sg")).toEqual({ target: { socle: "sg", modules: MODULES } });
    expect(withBaseSocle({ target: { socle: "fr-2026.2" } }, "fr")).toEqual({ target: { socle: "fr-2026.2" } });
    expect(withBaseSocle({ pitch: "p" }, "sg")).toEqual({ pitch: "p" });
    expect(baseSocleOf({}, { populations: [{ group: "target", packVersion: "sg-2026.1", n: 1 }] })).toBe("sg");
    expect(baseSocleOf({})).toBe("fr");
  });

  it("study:recommend garde la cible plus étroite et createNextStudy la crée (moteur simulé)", async () => {
    const { db, sqlite } = openDb(":memory:");
    runMigrations(db);
    const project = createProject(db, readProjectFile(SG_PROJECT));
    const target = (getProject(db, project.id)!.extra as { target: TargetSpec }).target;
    const { study } = createStudy(db, sg, { projectId: project.id, populations: [{ group: "target", n: 6, target }], seed: 3, backend: "ollama", model: "fake" });
    const gg = Object.fromEntries(studyTiers(project, "3").map((t) => [`at_${String(t).replace(".", "_")}_eur`, false]));
    await runStudy(db, new Engine(fakeBackend(() => JSON.stringify(answer({ behavior: "ignore", gaborGranger: gg }))).backend), sg, study);

    const out = {
      headline: "Low interest.",
      findings: [
        { title: "Sample", detail: "6 answers", evidence: [{ metric: "n", value: "6", source: "groups[0].analysis.n" }], strength: "faible" },
        { title: "Interest", detail: "low", evidence: [{ metric: "n", value: "6", source: "groups[0].analysis.n" }], strength: "faible" },
      ],
      recommendations: [
        {
          id: "r3",
          kind: "cible",
          title: "Narrow the target to frequent barbecuers",
          rationale: "r",
          evidence: [{ metric: "n", value: "6", source: "groups[0].analysis.n" }],
          confidence: "moyenne",
          // Le modèle recopie l'exemple du prompt historique : socle « fr »
          nextStudy: { hypothesis: "h", successCriterion: "s", projectPatch: { target: { socle: "fr", modules: MODULES, eligibility: NARROW, n: 6 } }, sample: "new_target", n: 6 },
        },
        { id: "message", kind: "message", title: "t", rationale: "r", evidence: [{ metric: "n", value: "6", source: "groups[0].analysis.n" }], confidence: "faible" },
      ],
      caveats: [],
    };
    const fb = fakeBackend(() => JSON.stringify(out), 1);
    const dir = mkdtempSync(join(tmpdir(), "rec-sg-"));
    const r = await recommendStudy(study.id, { db, pack: sg, engine: new Engine(fb.backend), outDir: dir });
    expect(fb.requests).toHaveLength(1);
    expect(r.verification.droppedNextStudies).toEqual([]);
    const ns = r.recommendations.find((x) => x.id === "r3")!.nextStudy!;
    expect((ns.projectPatch.target as { socle: string }).socle).toBe("sg");
    expect(ns.targetCheck?.rate).toBeGreaterThan(0);
    // Prompt : exemple et catalogue du socle de l'étude
    expect(fb.requests[0]!.system).toContain('"socle": "sg"');
    expect(fb.requests[0]!.system).toContain("- residency_status :");
    expect(fb.requests[0]!.system).not.toContain("- pcs : PCS");

    const res = createNextStudy(study.id, "r3", { confirm: true, db, pack: sg, outDir: dir });
    const created = getProject(db, res.projectId)!.extra as { target: TargetSpec };
    expect(created.target.socle).toBe("sg");
    expect(created.target.modules).toEqual(MODULES);
    sqlite.close();
  }, 60_000);
});
