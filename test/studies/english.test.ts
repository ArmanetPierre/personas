import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../../src/db/client";
import type { Persona } from "../../src/db/schema";
import { Engine } from "../../src/engine/engine";
import { loadPack } from "../../src/personas/pack";
import { drawPersona } from "../../src/personas/sampler";
import { audienceOf, FR_AUDIENCE, studyAudience } from "../../src/studies/locale";
import { lexicalTone, toneWarning } from "../../src/studies/pitch-tone";
import { createProject, getProject, readProjectFile } from "../../src/studies/project";
import { checkFacts } from "../../src/studies/protocols/facts";
import {
  buildRepairPrompt,
  buildRoleSystemPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  coherenceContext,
  constraintsBlock,
  pickEncounter,
  QUESTION_KEY,
  studyTiers,
} from "../../src/studies/protocols/concept-price";
import { roleProject, rolePrompt } from "../../src/studies/role-view";
import { projectRoles } from "../../src/studies/roles";
import { runStudy } from "../../src/studies/run";
import { personasByIds, studyResponses } from "../../src/studies/store";
import { createStudy } from "../../src/studies/study";
import { summarize } from "../../src/studies/summary";
import { relevanceSystem, relevanceUser } from "../../src/triage/relevance";
import type { TargetSpec } from "../../src/population/target";
import { answer, fakeBackend } from "./fixtures";
import { projectFrom } from "./project-helpers";

const sg = loadPack("sg");
const fr = loadPack("fr-2026.2");
const EN = audienceOf(sg);
const CATCH = "examples/sg/fresh-catch-demo.yaml";
const fish = projectFrom(CATCH);
const persona = (i: number, narrative: string | null = null) =>
  ({ ...drawPersona(sg, 42, i), narrative, narrativeBackend: null, narrativeModel: null, narrativeAt: null, createdAt: "" }) as Persona;

describe("public d'une étude (langue, pays, devise)", () => {
  it("vient du socle", () => {
    expect(EN).toEqual({ locale: "en", country: "SG", countryName: "Singapore", currency: "SGD" });
    expect(audienceOf(fr)).toEqual(FR_AUDIENCE);
    expect(studyAudience({ populations: [{ group: "target", packVersion: "sg-2026.1", n: 1 }] })).toEqual(EN);
    expect(studyAudience({ populations: [{ group: "target", packVersion: "fr-2026.2", n: 1 }] })).toEqual(FR_AUDIENCE);
    expect(studyAudience({ populations: [] })).toEqual(FR_AUDIENCE);
  });

  it("le public français donne exactement le prompt historique", () => {
    const tiers = studyTiers(fish, "3");
    expect(buildSystemPrompt(fish, tiers, "3", FR_AUDIENCE)).toBe(buildSystemPrompt(fish, tiers, "3"));
    expect(coherenceContext(fish, tiers, FR_AUDIENCE)).toEqual(coherenceContext(fish, tiers));
  });
});

describe("protocole concept-price v3 en anglais", () => {
  const tiers = studyTiers(fish, "3");
  const system = buildSystemPrompt(fish, tiers, "3", EN);

  it("garde toutes les règles anti-complaisance", async () => {
    for (const s of [
      "who lives in Singapore",
      "## Why candour matters",
      "1. Inertia by default.",
      "concrete, current need in your life",
      "Your discretionary budget is what is left each month once everything is paid.",
      "You have habits and alternatives, often free ones.",
      "Approving of the principle is not acting.",
      "Many people are simply not concerned",
      "Do not invent any personal fact",
      "- needFrequency:",
      "within the next 7 days",
      "you do not pay for a service you ignore.",
    ]) expect(system).toContain(s);
    expect(system).not.toMatch(/\b(Tu |tu |Prix affiché|Offre gratuite)\b/);
    // Prix dans la devise de la persona (pas de ligne d'équivalence) et rappel de la devise des champs « Eur »
    expect(system).toContain("Displayed price: Fish by weight (average price): S$24 per kg");
    expect(system).not.toContain("To place these prices in your budget");
    expect(system).toContain("give the amounts in S$");
    await expect(system).toMatchFileSnapshot("__fixtures__/en/fresh-catch-sg-system-prompt.txt");
  });

  it("offre en euros pour une persona de Singapour : équivalence en S$", () => {
    const eur = { ...fish, priceEur: 9.99, pricePeriod: "month", extra: { priceTiers: [5, 9.99, 15] } };
    const s = buildSystemPrompt(eur, studyTiers(eur, "3"), "3", EN);
    expect(s).toContain("Displayed price: €9.99/month");
    expect(s).toMatch(/To place these prices in your budget in S\$: €1 ≈ S\$1\.\d+/);
  });

  it("prompt utilisateur en anglais : fiche, contraintes, situation", async () => {
    const p = persona(1, "Eric Goh, 49, works shifts at a factory in Tuas.");
    const user = buildUserPrompt(sg, p, fish, pickEncounter(p, 7));
    expect(user).toContain("## Who you are");
    expect(user).toContain("## Your constraints this month");
    expect(user).toContain("- Discretionary budget: S$");
    expect(user).toContain("### Portrait (written in the third person: it is you)");
    expect(user).toContain("An ordinary weekday, with your usual concerns.");
    expect(user).not.toMatch(/Reste-à-vivre|Qui tu es|ans\b/);
    expect(constraintsBlock(p, EN)).toContain("- Time: ");
    await expect(user).toMatchFileSnapshot("__fixtures__/en/fresh-catch-sg-user-prompt.txt");
  });

  it("réparation en anglais, vers la prudence", () => {
    const r = buildRepairPrompt(["pay_without_gg"], [], EN);
    expect(r).toContain("Your answer contains inconsistencies");
    expect(r).toContain("Do not make your answer more favourable to the offer");
  });

  it("panier minimum comparé au budget dans la devise de la persona", () => {
    const ctx = coherenceContext(fish, tiers, EN);
    expect(ctx.price?.minimumOrderEur).toBe(150);
    expect(ctx.price?.minimumLabel).toBe("S$150");
    expect(ctx.price?.vwUnit).toBe("in S$ per kg");
  });

  it("rôles : mêmes adaptations sur les ancres anglaises", () => {
    const team = projectFrom("examples/team-schedule-no-module.yaml");
    const f = readProjectFile("examples/team-schedule-no-module.yaml");
    const p = { ...team, extra: { ...(team.extra as object), roles: f.roles } } as typeof team;
    const roles = projectRoles(p);
    for (const role of roles) {
      const view = roleProject(p, role);
      const s = buildRoleSystemPrompt(view, studyTiers(view, "3"), "3", rolePrompt(role, roles), EN);
      expect(s).toContain("## Your role");
      if (role.perspective === "user") {
        expect(s).toContain("What it costs you: ");
        expect(s).not.toContain("- vanWestendorp:");
        expect(s).toContain("- expectedUsage:");
      }
    }
  });

  it("pré-tri de pertinence en anglais", () => {
    const s = relevanceSystem(fish, "direct", EN);
    expect(s).toContain("## What you return");
    expect(s).toContain("1: concerned: you have today the need the offer addresses");
    expect(s).toContain("Reply with the digit alone");
    expect(relevanceUser(sg, persona(2))).toContain("Reply now with the digit alone.");
    expect(relevanceSystem(fish, "direct", FR_AUDIENCE)).toBe(relevanceSystem(fish, "direct"));
  });
});

describe("garde-fous en anglais", () => {
  it("ton du pitch : factuel ≈ 0, commercial au-dessus du seuil", () => {
    expect(lexicalTone(fish.pitch, "en").score).toBe(0);
    const sales =
      "Discover the ultimate barbecue experience! The best meat in Singapore, loved by thousands of families. Effortless ordering in two clicks, guaranteed freshness. Don't miss our limited-time offer: only S$24 per kg!";
    const t = toneWarning(sales, undefined, "en");
    expect(t.warn).toBe(true);
    expect(t.message).toContain("commercial tone");
    // Le score français d'un pitch français ne change pas
    expect(lexicalTone("Découvrez le meilleur service, adoré par des milliers de clients !").score).toBe(
      lexicalTone("Découvrez le meilleur service, adoré par des milliers de clients !", "fr").score,
    );
  });

  it("faits inventés détectés dans des réponses en anglais", () => {
    const p = persona(0); // vit chez ses parents, sans conjoint ni enfant
    const codes = (text: string) => checkFacts(answer({ verbatim: text }), p, "en").map((f) => f.code);
    expect(codes("My wife would love this.")).toContain("invented_partner");
    expect(codes("My kids eat a lot of meat.")).toContain("invented_child");
    expect(codes("I run my own business, so maybe.")).toContain("invented_business");
    expect(codes("Not for me, I prefer the hawker centre.")).toEqual([]);
  });
});

describe("étude de bout en bout sur le socle Singapour (moteur simulé)", () => {
  it("crée, lance et résume une étude en anglais et en S$", async () => {
    const { db } = openDb(":memory:");
    runMigrations(db);
    const project = createProject(db, readProjectFile(CATCH));
    const target = (getProject(db, project.id)!.extra as { target: TargetSpec }).target;
    const { study } = createStudy(db, sg, { projectId: project.id, populations: [{ group: "target", n: 6, target }], seed: 3, backend: "ollama", model: "fake" });
    expect(studyAudience(study).locale).toBe("en");
    expect(study.personaIds.every((id) => id.startsWith("sg-2026.2-s3-"))).toBe(true);

    const tiers = studyTiers(project, "3");
    const gg = Object.fromEntries(tiers.map((t) => [`at_${String(t).replace(".", "_")}_eur`, false]));
    const reply = answer({
      needFrequency: "few_per_year",
      spontaneousReaction: "Big cuts, but we only barbecue a few times a year.",
      relevance: "marginal",
      relevanceReason: "We host friends only on public holidays.",
      currentSolution: "Cold Storage when we need it.",
      objections: [{ category: "price", detail: "S$150 minimum is a lot for one barbecue." }],
      behavior: "ignore",
      behaviorReason: "No barbecue planned this month.",
      gaborGranger: gg,
      verbatim: "Nice idea, but too much meat for us.",
    });
    const fake = fakeBackend(() => JSON.stringify(reply));
    await runStudy(db, new Engine(fake.backend), sg, study);
    expect(fake.requests[0]!.system).toContain("who lives in Singapore");
    expect(fake.requests[0]!.messages[0]!.content).toContain("## Who you are");

    const rows = studyResponses(db, study.id, QUESTION_KEY);
    expect(rows).toHaveLength(6);
    const personas = new Map(personasByIds(db, rows.map((r) => r.personaId)).map((p) => [p.id, p]));
    const s = summarize(sg, study, getProject(db, project.id)!, rows, personas);
    expect(s.methodNote).toMatch(/^Qualitative signals/);
    expect(s.project.price).toContain("S$24 per kg");
    expect(s.project.currency).toBe("SGD");
    expect(s.confidence?.caveats.join(" ")).toMatch(/Payment conversion not calibrated/);
    expect(s.overall.verbatims[0]!.who).toMatch(/^.+, \d+, /);
    const sexRows = s.overall.behaviors.bySegment.ageBand ?? [];
    expect(sexRows.every((r) => !/ans\b/.test(r.label))).toBe(true);
    expect(s.drivers?.outcomes[0]?.label).toBe("Interest (at least looks at the offer)");
  });
});
