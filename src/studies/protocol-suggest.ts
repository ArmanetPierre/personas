import { projectLocale } from "./locale";
import { z } from "zod";
import type { Db } from "../db/client";
import type { Project } from "../db/schema";
import type { Engine, Usage } from "../engine";
import { formatProjectPrice } from "./price-model";
import { QUESTION_KEY } from "./protocols/concept-price";
import {
  CANONICAL_LEVELS,
  CANONICAL_OBJECTIONS,
  CANONICAL_RELEVANCE,
  DEFAULT_BEHAVIORS,
  LEGACY_OBJECTIONS,
  PRODUCT_TYPES,
  projectProtocolSchema,
  type ProjectProtocol,
} from "./protocols/protocol";
import type { ConceptPricePayload } from "./run";
import { listStudies, studyResponses } from "./store";

/**
 * Proposition de protocole par l'assistant (lot P1) : à partir du pitch, des concurrents et des
 * objections libres des études existantes du projet, Claude propose un bloc `protocol` complet
 * et le justifie. La proposition est écrite dans un fichier, jamais appliquée : l'utilisateur valide.
 */

export interface ObjectionEvidence {
  studies: string[];
  respondents: number;
  /** Part des répondants qui citent chaque catégorie, dans les études existantes. */
  shares: Record<string, number>;
  /** Détails cités, par catégorie (échantillon). */
  samples: Record<string, string[]>;
}

/** Objections des études existantes du projet : parts par catégorie et échantillon de détails. */
export function gatherObjections(db: Db, projectId: string, opts: { perCategory?: number; focus?: string[] } = {}): ObjectionEvidence | null {
  const studies = listStudies(db).filter((s) => s.projectId === projectId);
  const rows = studies.flatMap((s) => studyResponses(db, s.id, QUESTION_KEY));
  if (!rows.length) return null;
  const focus = new Set(opts.focus ?? ["other", "trust_privacy"]);
  const per = opts.perCategory ?? 12;
  const counts: Record<string, number> = {};
  const details: Record<string, string[]> = {};
  for (const r of rows) {
    const objs = (r.payload as ConceptPricePayload).answer?.objections ?? [];
    for (const c of new Set(objs.map((o) => o.category))) counts[c] = (counts[c] ?? 0) + 1;
    for (const o of objs) (details[o.category] ??= []).push(o.detail);
  }
  const samples: Record<string, string[]> = {};
  for (const [c, list] of Object.entries(details)) {
    const k = focus.has(c) ? per * 4 : per;
    const uniq = [...new Set(list)];
    const step = Math.max(1, uniq.length / k);
    samples[c] = Array.from({ length: Math.min(k, uniq.length) }, (_, i) => uniq[Math.floor(i * step)]!);
  }
  return {
    studies: studies.filter((s) => rows.some((r) => r.studyId === s.id)).map((s) => s.id),
    respondents: rows.length,
    shares: Object.fromEntries(Object.entries(counts).map(([c, n]) => [c, Math.round((n / rows.length) * 1000) / 1000])),
    samples,
  };
}

/** Schéma demandé au modèle (sans les contrôles croisés, vérifiés ensuite par `projectProtocolSchema`). */
const llmSchema = z.object({
  productType: z.enum(PRODUCT_TYPES),
  behaviors: z
    .array(z.object({ code: z.string(), label: z.string(), description: z.string(), level: z.enum(CANONICAL_LEVELS), short: z.string() }))
    .min(4)
    .max(9),
  objections: z
    .array(z.object({ code: z.string(), label: z.string(), description: z.string(), canonical: z.enum(CANONICAL_OBJECTIONS), short: z.string() }))
    .min(5)
    .max(12),
  relevance: z.array(z.object({ code: z.string(), label: z.string(), description: z.string(), canonical: z.enum(CANONICAL_RELEVANCE) })).min(3).max(5),
  rationale: z.string().min(1),
});

export function buildSuggestPrompt(project: Project, evidence: ObjectionEvidence | null): { system: string; user: string } {
  const system = `Tu es méthodologue en études de marché. Tu prépares le protocole d'une étude « concept + prix » menée auprès de personas synthétiques : chaque persona découvre l'offre au milieu de son quotidien, dit ce qu'elle fait concrètement dans les 7 jours, si elle est concernée, et quels freins elle a.

Tu proposes trois choses, adaptées à CE produit :
1. Une échelle de comportements à 7 jours, de 5 à 8 étapes, du moins au plus engagé, qui colle au parcours réel du produit (par exemple pour une application à installer : ignore, met de côté, regarde la page, télécharge et installe, essaie la version gratuite, achète, recommande). Chaque étape a un code (snake_case), un libellé court sans sujet, comme dans un tableau de résultats (« Télécharge et installe »), une description à la deuxième personne (« tu télécharges et installes l'application »), un en-tête court (10 caractères au plus) et un niveau canonique : inaction, interest, free_trial, payment, recommendation. La première étape est « inaction » ; « met de côté, sans suite probable » reste au niveau « inaction » ; « interest » commence quand la persona regarde ou vérifie activement quelque chose. Les niveaux sont croissants, et au moins une étape est « payment ». Pour les étapes payantes, ne mets pas de prix : il est ajouté automatiquement.
2. Une taxonomie d'objections propre au projet, de 6 à 10 catégories, mutuellement exclusives, chacune avec un code, un libellé, une description courte (groupe nominal, sans « tu ») qui aide la persona à choisir, un en-tête court et une catégorie canonique (price, no_need, already_covered, trust_privacy, effort_time, network_effect, other). Une catégorie doit couvrir l'absence de besoin (canonique no_need). Sépare les freins qui se mélangent dans une catégorie générique, et ne garde pas une catégorie sans objet pour ce produit (par exemple l'effet réseau pour un outil individuel). Prévois une catégorie « autre » de repli, la plus petite possible.
3. Une échelle de pertinence de 3 à 5 niveaux, plus fine que « concerné / marginal / pas concerné », fondée sur des critères observables (fréquence du besoin, situation actuelle), chacun avec une catégorie canonique (concerned, marginal, not_concerned).

Appuie-toi sur les objections libres des études déjà menées quand elles existent : elles montrent les freins réels et les catégories trop larges. Justifie tes choix dans « rationale » (8 phrases au plus), en citant les chiffres utiles. ${projectLocale(project) === "en" ? "Les personas de ce projet répondent en anglais : libellés, descriptions (à la deuxième personne, « you … ») et en-têtes en anglais ; « rationale » aussi. Réponds avec l'objet JSON seul." : "Réponds en français, avec l'objet JSON seul."}`;
  const ev = evidence
    ? `## Objections des études existantes (${evidence.studies.join(", ")}, ${evidence.respondents} répondants)
Part des répondants qui citent chaque catégorie actuelle : ${Object.entries(evidence.shares)
        .sort((a, b) => b[1] - a[1])
        .map(([c, s]) => `${c} ${Math.round(s * 100)} %`)
        .join(", ")}.
Catégories actuelles : ${LEGACY_OBJECTIONS.map((o) => `${o.code} (${o.label})`).join(", ")}.
${Object.entries(evidence.samples)
  .map(([c, list]) => `### Détails cités en « ${c} »\n${list.map((d) => `- ${d}`).join("\n")}`)
  .join("\n\n")}`
    : "## Objections des études existantes\nAucune étude n'a encore été menée sur ce projet.";
  const user = `## Le projet
Nom : ${project.name}
Pitch (tel que vu par les personas) : « ${project.pitch} »
Prix : ${formatProjectPrice(project)}${project.freeOffer ? `\nOffre gratuite : ${project.freeOffer}` : ""}
${project.targetAudience ? `Cible visée : ${project.targetAudience}\n` : ""}${project.businessModel ? `Modèle économique : ${project.businessModel}\n` : ""}Concurrents et alternatives : ${[...project.competitors, ...project.alternatives].join(" ; ") || "—"}

Types de produit possibles : ${PRODUCT_TYPES.join(", ")}. Exemple d'échelle pour app_install : ${DEFAULT_BEHAVIORS.app_install.map((b) => b.code).join(", ")}.

${ev}

Propose le protocole.`;
  return { system, user };
}

export interface SuggestResult {
  protocol: ProjectProtocol;
  rationale: string;
  usage: Usage;
  model: string;
  /** Problèmes de validation corrigés automatiquement (codes normalisés, ordre des niveaux). */
  fixes: string[];
}

const snake = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "c_$1") || "x";

/** Demande une proposition au modèle, puis la valide avec le schéma du projet. */
export async function suggestProtocol(engine: Engine, project: Project, evidence: ObjectionEvidence | null): Promise<SuggestResult> {
  const { system, user } = buildSuggestPrompt(project, evidence);
  const res = await engine.complete({ system, messages: [{ role: "user", content: user }], schema: llmSchema, maxTokens: 6_000 });
  const fixes: string[] = [];
  const fixCode = <T extends { code: string }>(x: T): T => {
    const c = snake(x.code);
    if (c !== x.code) fixes.push(`code « ${x.code} » → « ${c} »`);
    return { ...x, code: c, ...("short" in x && typeof (x as { short?: string }).short === "string" ? { short: (x as unknown as { short: string }).short.slice(0, 10) } : {}) };
  };
  const draft = {
    productType: res.data.productType,
    behaviors: res.data.behaviors.map(fixCode),
    objections: res.data.objections.map(fixCode),
    relevance: res.data.relevance.map(fixCode),
    rationale: res.data.rationale,
  };
  const parsed = projectProtocolSchema.safeParse(draft);
  if (!parsed.success) {
    throw new Error(`Proposition invalide : ${parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; ")}`);
  }
  return { protocol: parsed.data, rationale: res.data.rationale, usage: res.usage, model: res.model, fixes };
}
