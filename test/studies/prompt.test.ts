import { describe, expect, it } from "vitest";
import {
  answerSchemaFor,
  buildSystemPrompt,
  buildUserPrompt,
  pickEncounter,
  tierKey,
} from "../../src/studies/protocols/concept-price";
import { priceTiersFor } from "../../src/studies/project";
import { makePersonas, pack, project } from "./fixtures";

const personas = makePersonas(6);
const tiers = priceTiersFor(project);

describe("prompt concept + prix", () => {
  const system = buildSystemPrompt(project, tiers);

  it("met les garde-fous anti-complaisance et l'offre dans le prompt système", () => {
    expect(system).toMatch(/Inertie par défaut/);
    expect(system).toMatch(/Ignorer est la réponse normale/);
    expect(system).toMatch(/besoin concret et actuel/);
    expect(system).toMatch(/reste-à-vivre/);
    expect(system).toMatch(/ne sont simplement pas concernés/);
    expect(system).toMatch(/N'invente pas un besoin/);
    expect(system).toMatch(/enquêteur poli/);
    // v2 : faits personnels, objections propres à la persona, transmission
    expect(system).toMatch(/N'invente aucun fait personnel/);
    expect(system).toMatch(/enfants \(leur nombre, leur sexe\), conjoint, statut d'emploi, employeur/);
    expect(system).toMatch(/Ne recopie pas par réflexe une caractéristique de l'offre/);
    expect(system).toMatch(/souvent juste "no_need", et deux objections au plus/);
    expect(system).toMatch(/wouldForward/);
    expect(system).toMatch(/que toi tu paies ou non/);
    expect(system).toContain(project.pitch);
    expect(system).toContain("5 €/mois");
    expect(system).toContain("Marmiton");
    for (const b of ["ignore", "save_for_later", "visit_page", "free_signup", "free_active", "pay_subscription", "recommend"]) expect(system).toContain(`"${b}"`);
    for (const c of ["price", "no_need", "already_covered", "trust_privacy", "effort_time", "network_effect", "other"]) expect(system).toContain(`"${c}"`);
    expect(system).toMatch(/wouldNeverPay/);
    expect(system).toContain("2 €/mois, 5 €/mois, 9 €/mois");
  });

  it("ne montre pas la cible visée ni le modèle économique à la persona", () => {
    expect(system).not.toContain("CIBLE-SECRETE");
  });

  it("est identique pour toutes les personas (cache) et ne contient aucune persona", () => {
    expect(buildSystemPrompt(project, tiers)).toBe(system);
    for (const p of personas) expect(system).not.toContain(p.id);
  });

  it("place la fiche, le récit, les contraintes réelles et la situation dans le message de la persona", () => {
    const p = personas.find((x) => x.subscriptions.length > 0 && x.narrative)!;
    const user = buildUserPrompt(pack, p, project, pickEncounter(p, 7));
    expect(user).toContain(`${p.age} ans`);
    expect(user).toContain(p.occupation);
    expect(user).toContain(p.narrative!);
    expect(user).toMatch(/Reste-à-vivre/);
    expect(user).toMatch(/Abonnements en cours : \d+, pour/);
    expect(user).toContain(p.subscriptions[0]!.name);
    expect(user).toMatch(/Temps : /);
    expect(user).toMatch(/## La situation/);
    expect(user).not.toMatch(/Tonalité/);
    // La persona vient après le contexte commun
    expect(user.indexOf("## Qui tu es")).toBe(0);
  });

  it("signale l'absence de récit sans en inventer", () => {
    const p = personas.find((x) => !x.narrative)!;
    expect(buildUserPrompt(pack, p, project, pickEncounter(p, 7))).toMatch(/Pas de portrait : appuie-toi sur la fiche seule/);
  });

  it("rappelle explicitement un reste-à-vivre nul", () => {
    const p = { ...personas[0]!, monthlyDiscretionaryBudgetEur: 0 };
    expect(buildUserPrompt(pack, p, project, pickEncounter(p, 7))).toMatch(/0 € : .*il ne reste rien/);
  });

  it("tire une situation stable et compatible (pas de pub sociale sans réseaux sociaux)", () => {
    const p = { ...personas[1]!, socialMediaUsage: "none" };
    for (let seed = 0; seed < 30; seed++) expect(pickEncounter(p, seed).id).not.toBe("social_ad");
    expect(pickEncounter(personas[2]!, 7)).toEqual(pickEncounter(personas[2]!, 7));
    const offline = { ...personas[1]!, equipment: ["téléphone mobile simple"], socialMediaUsage: "daily" };
    for (let seed = 0; seed < 30; seed++) {
      const e = pickEncounter(offline, seed);
      expect(e.id).not.toBe("social_ad");
      expect(e.text).not.toMatch(/lien/);
    }
  });

  it("impose un booléen par palier Gabor-Granger", () => {
    const schema = answerSchemaFor(tiers);
    expect(tiers).toEqual([2, 5, 9]);
    expect(tierKey(4.99)).toBe("at_4_99_eur");
    const shape = schema.shape.gaborGranger.shape as Record<string, unknown>;
    expect(Object.keys(shape)).toEqual(["at_2_eur", "at_5_eur", "at_9_eur"]);
  });
});
