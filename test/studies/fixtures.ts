import type { Persona, Project } from "../../src/db/schema";
import type { Backend, BackendRequest } from "../../src/engine/types";
import { loadPack } from "../../src/personas/pack";
import { drawPersonas } from "../../src/personas/sampler";
import type { ConceptPriceAnswer } from "../../src/studies/protocols/concept-price";

export const pack = loadPack("fr");

export function makePersonas(n: number, seed = 99): Persona[] {
  return drawPersonas(pack, seed, n).map(
    (p, i) =>
      ({
        ...p,
        narrative: i % 2 === 0 ? `${p.firstName} vit à son rythme et compte chaque euro en fin de mois.` : null,
        narrativeBackend: null,
        narrativeModel: null,
        narrativeAt: null,
        createdAt: "",
      }) as Persona,
  );
}

export const project: Project = {
  id: "menu-malin",
  name: "Menu Malin",
  pitch: "Une application qui prépare les repas de la semaine et la liste de courses pour tout le foyer.",
  targetAudience: "CIBLE-SECRETE actifs 25-50 ans",
  businessModel: "Freemium",
  priceEur: 5,
  pricePeriod: "month",
  freeOffer: "Menus de base gratuits",
  competitors: ["Jow", "Marmiton"],
  alternatives: ["Les recettes habituelles de la famille"],
  extra: { priceTiers: [2, 5, 9] },
  createdAt: "",
  updatedAt: "",
};

export function answer(overrides: Partial<ConceptPriceAnswer> = {}): ConceptPriceAnswer {
  return {
    // Champ v3 (les nouvelles études sont en v3) ; le schéma v2 l'ignore. « rarely » ne déclenche aucun contrôle.
    needFrequency: "rarely",
    spontaneousReaction: "Encore une appli de recettes, pas pour moi.",
    relevance: "not_concerned",
    relevanceReason: "Je cuisine déjà comme je veux.",
    currentSolution: "Rien, je n'en ai pas besoin.",
    alternatives: [],
    objections: [{ category: "no_need", detail: "Je n'ai pas besoin d'aide pour les repas." }],
    behavior: "ignore",
    behaviorReason: "Pas de besoin.",
    wouldForward: false,
    forwardTo: "",
    vanWestendorp: { wouldNeverPay: true, tooCheapEur: null, cheapEur: null, expensiveEur: null, tooExpensiveEur: null },
    gaborGranger: { at_2_eur: false, at_5_eur: false, at_9_eur: false },
    budgetFit: "",
    verbatim: "Franchement, ça ne me parle pas.",
    ...overrides,
  };
}

export const payer = (): ConceptPriceAnswer =>
  answer({
    relevance: "concerned",
    behavior: "pay_subscription",
    objections: [{ category: "network_effect", detail: "Peu de recettes adaptées à mon régime." }],
    vanWestendorp: { wouldNeverPay: false, tooCheapEur: 1, cheapEur: 3, expensiveEur: 8, tooExpensiveEur: 15 },
    gaborGranger: { at_2_eur: true, at_5_eur: true, at_9_eur: false },
    budgetFit: "Je résilie Deezer que je n'utilise plus.",
  });

/** Backend simulé : `reply` reçoit la requête et le numéro d'appel, renvoie le texte ou lève. */
export function fakeBackend(reply: (req: BackendRequest, call: number) => string, concurrency = 2) {
  let call = 0;
  const requests: BackendRequest[] = [];
  const backend: Backend = {
    name: "ollama",
    model: "fake",
    concurrency,
    async checkAvailability() {
      return { ok: true, detail: "simulé" };
    },
    async generate(req) {
      requests.push(req);
      const text = reply(req, call++);
      return { text, model: "fake", usage: { inputTokens: 100, outputTokens: 50 } };
    },
  };
  return { backend, requests };
}
