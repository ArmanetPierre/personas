import { projectLocale } from "./locale";
import { z } from "zod";
import type { Project } from "../db/schema";
import type { Engine, Usage } from "../engine";
import { formatProjectPrice } from "./price-model";
import { checkFacts, lexicalTone, TONE_CATEGORIES, TONE_CATEGORY_LABELS, type FactCheck, type ToneCategory } from "./pitch-tone";

/**
 * Neutralisation du pitch (`project:neutralize-pitch`) : l'assistant repère les passages
 * promotionnels et propose une version factuelle, avec la même information ; l'utilisateur valide.
 * Rien n'est appliqué au projet : la proposition est écrite dans data/proposals/<projet>-pitch.json.
 */

export interface PitchPassage {
  text: string;
  category: ToneCategory;
  reason: string;
  /** Formulation factuelle retenue (vide si le passage est supprimé sans perte d'information). */
  replacement: string;
}

export interface PitchProposal {
  project: string;
  generatedAt: string;
  model: string;
  original: string;
  neutral: string;
  passages: PitchPassage[];
  /** Score de ton du modèle (0 : factuel, 100 : survendu), avant et après. */
  toneScore: { before: number; after: number };
  /** Score lexical, sans modèle (celui du garde-fou de création d'étude), avant et après. */
  lexicalScore: { before: number; after: number };
  /** Faits informatifs de l'original, avec leurs termes clés. */
  facts: Array<{ fact: string; keyTerms: string[] }>;
  /** Contrôle automatique : nombres, noms et faits conservés, rien d'ajouté. */
  factCheck: FactCheck & { repaired: boolean };
  /** Informations factuelles qui manquent à l'original (signalées, jamais inventées). */
  missingInfo: string[];
  /** Le pitch était déjà factuel : aucune modification proposée. */
  unchanged: boolean;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

const llmSchema = z.object({
  passages: z.array(z.object({ text: z.string(), category: z.enum(TONE_CATEGORIES), reason: z.string(), replacement: z.string() })),
  neutral: z.string().min(20),
  facts: z.array(z.object({ fact: z.string(), keyTerms: z.array(z.string()).min(1).max(4) })),
  missingInfo: z.array(z.string()),
  toneBefore: z.number().int().min(0).max(100),
  toneAfter: z.number().int().min(0).max(100),
});

export function buildNeutralizePrompt(project: Pick<Project, "name" | "pitch" | "freeOffer" | "priceEur" | "pricePeriod" | "extra">): { system: string; user: string } {
  const system = `Tu relis le pitch d'un produit avant qu'il soit montré à des personas synthétiques dans une étude de marché. Le ton promotionnel fausse l'étude : il crée de la méfiance et ancre les prix. Ton travail : rendre le pitch factuel sans changer ce qu'il dit du produit.

1. Repère chaque passage promotionnel et classe-le : "superlative" (le plus, le meilleur, révolutionnaire, exceptionnel), "unverifiable_promise" (va changer votre vie, en deux clics, garanti), "social_proof" (adoré par tous, des milliers d'utilisateurs, sans source), "urgency" (ne passez pas à côté, dès maintenant), "price_judgment" (seulement, imbattable, petit prix), "injunction" (Réservez !, Découvrez…), "emotional" (Libérez-vous des corvées !, enfin, points d'exclamation). Donne pour chacun la raison et la formulation factuelle qui le remplace (vide s'il n'apporte aucune information).
2. Rédige la version neutre : même information sur le service, le prix, le périmètre (zones, délais, limites, fonctionnalités), même ordre si possible, phrases déclaratives, troisième personne ou présentation descriptive, sans adjectif évaluatif ni point d'exclamation. N'ajoute AUCUNE information (pas de délai, de zone, de chiffre ou de fonctionnalité absents de l'original) et n'en retire aucune. Une promesse invérifiable qui porte une information concrète se reformule en fait (« en deux clics dans l'appli » → « la réservation se fait dans l'application »).
3. Liste les faits informatifs de l'original (« facts »), chacun avec 1 à 4 termes clés tels qu'ils doivent figurer dans la version neutre (nombres avec leur unité, lieux, fonctionnalités).
4. Signale dans « missingInfo » les informations factuelles utiles qui manquent à l'original (délais, limites, conditions), sans les inventer.
5. Note le ton de 0 (purement factuel) à 100 (survendu), avant et après.
Si le pitch est déjà factuel, renvoie-le tel quel dans « neutral », sans passage.
${projectLocale(project) === "en" ? "Le pitch est en anglais et sera montré à des personas anglophones : la version neutre, les remplacements, les faits et les informations manquantes sont en anglais. Réponds avec l'objet JSON seul." : "Réponds en français, avec l'objet JSON seul."}`;
  const user = `Produit : ${project.name}
Prix (pour information, déjà affiché à part) : ${formatProjectPrice(project as Project)}${project.freeOffer ? `\nOffre gratuite : ${project.freeOffer}` : ""}

Pitch à relire :
« ${project.pitch} »`;
  return { system, user };
}

function repairPrompt(fc: FactCheck): string {
  const lines = [
    ...fc.numbersMissing.map((x) => `- nombre de l'original absent de la version neutre : « ${x} »`),
    ...fc.numbersAdded.map((x) => `- nombre ajouté, absent de l'original : « ${x} »`),
    ...fc.namesMissing.map((x) => `- nom ou lieu de l'original absent : « ${x} »`),
    ...fc.factsMissing.map((x) => `- fait non repris : « ${x} »`),
  ];
  return `Le contrôle de conservation des faits a échoué :\n${lines.join("\n")}\nCorrige la version neutre pour reprendre exactement ces informations, sans rien ajouter, et renvoie l'objet JSON complet.`;
}

export async function neutralizePitch(project: Pick<Project, "id" | "name" | "pitch" | "freeOffer" | "priceEur" | "pricePeriod" | "extra">, opts: { engine: Engine }): Promise<PitchProposal> {
  const { system, user } = buildNeutralizePrompt(project);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  const call = async (messages: Array<{ role: "user" | "assistant"; content: string }>) => {
    const r = await opts.engine.complete({ system, messages, schema: llmSchema, maxTokens: 4_000 });
    calls++;
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    return r;
  };
  const first = await call([{ role: "user", content: user }]);
  let out = first.data;
  let fc = checkFacts(project.pitch, out.neutral, out.facts);
  let repaired = false;
  if (!fc.ok) {
    repaired = true;
    try {
      const second = await call([
        { role: "user", content: user },
        { role: "assistant", content: JSON.stringify(out) },
        { role: "user", content: repairPrompt(fc) },
      ]);
      out = second.data;
      fc = checkFacts(project.pitch, out.neutral, out.facts);
    } catch {
      // Réparation impossible : les écarts restent signalés
    }
  }
  return {
    project: project.id,
    generatedAt: new Date().toISOString(),
    model: first.model,
    original: project.pitch,
    neutral: out.neutral.trim(),
    passages: out.passages,
    toneScore: { before: out.toneBefore, after: out.toneAfter },
    lexicalScore: { before: lexicalTone(project.pitch, projectLocale(project)).score, after: lexicalTone(out.neutral, projectLocale(project)).score },
    facts: out.facts,
    factCheck: { ...fc, repaired },
    missingInfo: out.missingInfo,
    unchanged: out.neutral.trim() === project.pitch.trim(),
    usage: { calls, ...usage },
  };
}

export { TONE_CATEGORY_LABELS };
