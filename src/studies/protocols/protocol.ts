import { createHash } from "node:crypto";
import { z } from "zod";
import type { Project } from "../../db/schema";

/**
 * Protocole adaptable au projet (lot P1) : échelle de comportements, taxonomie
 * d'objections et échelle de pertinence propres au projet, chacune rattachée à des niveaux
 * canoniques pour garder les métriques transverses (payeurs, inscription, entonnoir), la
 * comparaison entre échelles différentes et le pré-tri.
 *
 * Sans bloc `protocol` dans le projet, le protocole « historique » (v2) s'applique, et le prompt,
 * les contrôles, le résumé et la comparaison restent strictement identiques.
 */

/** Niveaux canoniques d'engagement, du moins au plus engagé. */
export const CANONICAL_LEVELS = ["inaction", "interest", "free_trial", "payment", "recommendation"] as const;
export type CanonicalLevel = (typeof CANONICAL_LEVELS)[number];
export const LEVEL_LABELS: Record<CanonicalLevel, string> = {
  inaction: "Inaction",
  interest: "Intérêt",
  free_trial: "Essai gratuit",
  payment: "Paiement",
  recommendation: "Recommandation",
};
export const levelRank = (l: CanonicalLevel) => CANONICAL_LEVELS.indexOf(l);

/** Catégories canoniques d'objections (celles du protocole historique). */
export const CANONICAL_OBJECTIONS = ["price", "no_need", "already_covered", "trust_privacy", "effort_time", "network_effect", "other"] as const;
export type CanonicalObjection = (typeof CANONICAL_OBJECTIONS)[number];

/** Pertinence canonique. */
export const CANONICAL_RELEVANCE = ["concerned", "marginal", "not_concerned"] as const;
export type CanonicalRelevance = (typeof CANONICAL_RELEVANCE)[number];

export const PRODUCT_TYPES = ["app_install", "online_service", "marketplace_network", "physical_product", "subscription_content", "b2b_tool"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

const code = z.string().regex(/^[a-z][a-z0-9_]*$/, "code : minuscules, chiffres, soulignés");

export const behaviorDefSchema = z.object({
  code,
  label: z.string().min(1),
  /** Ce que fait la persona, tel qu'expliqué au modèle (« tu télécharges et installes l'app »). */
  description: z.string().min(1),
  level: z.enum(CANONICAL_LEVELS),
  /** En-tête court des tableaux (8 caractères environ). */
  short: z.string().min(1).max(10).optional(),
});
export const objectionDefSchema = z.object({
  code,
  label: z.string().min(1),
  description: z.string().min(1),
  canonical: z.enum(CANONICAL_OBJECTIONS),
  short: z.string().min(1).max(10).optional(),
});
export const relevanceDefSchema = z.object({
  code,
  label: z.string().min(1),
  description: z.string().min(1),
  canonical: z.enum(CANONICAL_RELEVANCE),
});
export type BehaviorDef = z.infer<typeof behaviorDefSchema>;
export type ObjectionDef = z.infer<typeof objectionDefSchema>;
export type RelevanceDef = z.infer<typeof relevanceDefSchema>;

const uniqueCodes = (list: Array<{ code: string }>) => new Set(list.map((x) => x.code)).size === list.length;

/** Bloc `protocol` d'un fichier projet. */
export const projectProtocolSchema = z
  .object({
    productType: z.enum(PRODUCT_TYPES).optional(),
    /** Échelle de comportements à 7 jours, du moins au plus engagé (sinon celle du type de produit). */
    behaviors: z.array(behaviorDefSchema).min(3).max(9).optional(),
    /** Taxonomie d'objections du projet (sinon les catégories historiques). */
    objections: z.array(objectionDefSchema).min(3).max(12).optional(),
    /** Échelle de pertinence plus fine (sinon concernée / marginale / pas concernée). */
    relevance: z.array(relevanceDefSchema).min(3).max(6).optional(),
    /** Justification de l'assistant (non montrée aux personas). */
    rationale: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.behaviors) {
      if (!uniqueCodes(p.behaviors)) ctx.addIssue({ code: "custom", path: ["behaviors"], message: "codes en double" });
      const ranks = p.behaviors.map((b) => levelRank(b.level));
      if (ranks.some((r, i) => i > 0 && r < ranks[i - 1]!)) ctx.addIssue({ code: "custom", path: ["behaviors"], message: "échelle à ordonner du moins au plus engagé (niveaux canoniques croissants)" });
      if (p.behaviors[0]!.level !== "inaction") ctx.addIssue({ code: "custom", path: ["behaviors"], message: "le premier comportement doit être de niveau « inaction »" });
      if (!p.behaviors.some((b) => b.level === "payment")) ctx.addIssue({ code: "custom", path: ["behaviors"], message: "au moins un comportement de niveau « payment » (concordance avec Gabor-Granger)" });
    }
    if (p.objections && !uniqueCodes(p.objections)) ctx.addIssue({ code: "custom", path: ["objections"], message: "codes en double" });
    if (p.objections && !p.objections.some((o) => o.canonical === "no_need")) ctx.addIssue({ code: "custom", path: ["objections"], message: "une objection de catégorie canonique « no_need » est requise" });
    if (p.relevance) {
      if (!uniqueCodes(p.relevance)) ctx.addIssue({ code: "custom", path: ["relevance"], message: "codes en double" });
      if (!p.relevance.some((r) => r.canonical === "not_concerned")) ctx.addIssue({ code: "custom", path: ["relevance"], message: "un niveau « not_concerned » est requis" });
    }
  });
export type ProjectProtocol = z.infer<typeof projectProtocolSchema>;

/** Protocole résolu, figé dans chaque réponse d'une étude à protocole propre. */
export interface ResolvedProtocol {
  /** false : protocole historique (aucun bloc `protocol` dans le projet). */
  custom: boolean;
  productType?: ProductType;
  behaviors: BehaviorDef[];
  objections: ObjectionDef[];
  relevance: RelevanceDef[];
  /** Empreinte des codes et niveaux : deux études ont la même échelle si leurs empreintes sont égales. */
  signature: string;
}

// ─── Protocole historique ─────────────────────────────────────────────────────

const L = (code: string, label: string, description: string, level: CanonicalLevel, short: string): BehaviorDef => ({ code, label, description, level, short });

/** Échelle historique (v2) : textes du prompt repris tels quels. */
export const LEGACY_BEHAVIORS: BehaviorDef[] = [
  L("ignore", "Ignore", "tu passes à autre chose", "inaction", "ignore"),
  L("save_for_later", "Met de côté, sans suite probable", "tu gardes le lien ou tu te dis « je regarderai », sans suite probable", "inaction", "de côté"),
  L("visit_page", "Regarde la page", "tu ouvres la page et tu la parcours", "interest", "page"),
  L("free_signup", "S'inscrit gratuitement pour voir", "tu t'inscris gratuitement pour voir, par curiosité, sans y revenir forcément", "free_trial", "inscrit"),
  L("free_active", "Utilise la version gratuite", "tu remplis ton profil et tu reviens utiliser la version gratuite, sans payer", "free_trial", "gratuit+"),
  L("pay_subscription", "Paierait l'abonnement", "tu paies au prix affiché", "payment", "paie"),
  L("recommend", "Paierait et le recommanderait", "tu paies et tu le recommandes à une personne précise de ton entourage", "recommendation", "recom."),
];

const O = (code: CanonicalObjection, label: string, description: string, short: string): ObjectionDef => ({ code, label, description, canonical: code, short });
export const LEGACY_OBJECTIONS: ObjectionDef[] = [
  O("price", "Prix", "prix", "prix"),
  O("no_need", "Pas de besoin", "pas de besoin", "besoin"),
  O("already_covered", "Déjà couvert par autre chose", "déjà couvert par autre chose : nomme-le", "couvert"),
  O("trust_privacy", "Confiance, vie privée", "confiance, vie privée", "confiance"),
  O("effort_time", "Effort ou temps", "effort ou temps à y consacrer", "temps"),
  O("network_effect", "Effet réseau, communauté vide", "pas assez de monde, communauté vide", "réseau"),
  O("other", "Autre", "autre", "autre"),
];

export const LEGACY_RELEVANCE: RelevanceDef[] = [
  { code: "concerned", label: "Concernée", description: "tu as aujourd'hui le besoin auquel l'offre répond", canonical: "concerned" },
  { code: "marginal", label: "Marginalement concernée", description: "ce besoin existe mais reste faible, ponctuel ou lointain", canonical: "marginal" },
  { code: "not_concerned", label: "Pas concernée", description: "tu ne l'as pas", canonical: "not_concerned" },
];

// ─── Échelles par type de produit ─────────────────────────────────────────────

const pay = (code: string, label: string, description: string, short = "paie") => L(code, label, description, "payment", short);

export const DEFAULT_BEHAVIORS: Record<ProductType, BehaviorDef[]> = {
  app_install: [
    L("ignore", "Ignore", "tu passes à autre chose", "inaction", "ignore"),
    L("save_for_later", "Met de côté", "tu gardes le lien ou tu te dis « je regarderai », sans suite probable", "inaction", "de côté"),
    L("visit_page", "Regarde la page", "tu ouvres la page de l'app ou sa fiche sur le store et tu la parcours", "interest", "page"),
    L("download_install", "Télécharge et installe", "tu télécharges et installes l'app, sans forcément t'en servir", "free_trial", "installe"),
    L("try_free", "Essaie la version gratuite", "tu l'utilises vraiment au moins une fois, sur un cas réel, dans sa version gratuite", "free_trial", "essaie"),
    pay("buy", "Achète", "tu paies au prix affiché", "achète"),
    L("recommend", "Achète et recommande", "tu paies et tu la recommandes à une personne précise de ton entourage", "recommendation", "recom."),
  ],
  online_service: LEGACY_BEHAVIORS.map((b) => ({ ...b })),
  marketplace_network: LEGACY_BEHAVIORS.map((b) => ({ ...b })),
  physical_product: [
    L("ignore", "Ignore", "tu passes à autre chose", "inaction", "ignore"),
    L("save_for_later", "Met de côté", "tu gardes l'info en tête, sans suite probable", "inaction", "de côté"),
    L("visit_page", "Regarde l'offre", "tu ouvres la fiche ou la boutique et tu regardes les produits et les prix", "interest", "page"),
    L("ask_info", "Se renseigne", "tu poses une question, compares avec ce que tu achètes d'habitude ou demandes un avis", "interest", "renseigne"),
    pay("first_order", "Commande une fois pour essayer", "tu passes une première commande payante pour essayer", "commande"),
    pay("repeat_order", "Compte en faire une habitude", "tu commandes et tu comptes recommander régulièrement", "habitude"),
    L("recommend", "Commande et recommande", "tu commandes et tu le recommandes à une personne précise de ton entourage", "recommendation", "recom."),
  ],
  subscription_content: [
    L("ignore", "Ignore", "tu passes à autre chose", "inaction", "ignore"),
    L("save_for_later", "Met de côté", "tu gardes le lien, sans suite probable", "inaction", "de côté"),
    L("visit_page", "Regarde la page", "tu ouvres la page et tu regardes le contenu proposé", "interest", "page"),
    L("free_trial", "Prend l'essai gratuit", "tu commences un essai gratuit ou consultes les contenus gratuits", "free_trial", "essai"),
    pay("subscribe", "S'abonne", "tu t'abonnes au prix affiché", "abonne"),
    L("recommend", "S'abonne et recommande", "tu t'abonnes et tu le recommandes à une personne précise de ton entourage", "recommendation", "recom."),
  ],
  b2b_tool: [
    L("ignore", "Ignore", "tu passes à autre chose", "inaction", "ignore"),
    L("save_for_later", "Met de côté", "tu gardes le lien, sans suite probable", "inaction", "de côté"),
    L("visit_page", "Regarde la page", "tu ouvres la page et tu regardes ce que fait l'outil", "interest", "page"),
    L("request_demo", "Demande une démo ou en parle en interne", "tu demandes une démonstration ou tu en parles à ton équipe ou ta hiérarchie", "interest", "démo"),
    L("pilot", "Lance un essai", "tu crées un compte d'essai ou lances un pilote gratuit", "free_trial", "essai"),
    pay("buy", "Achète ou fait acheter", "tu paies, ou tu obtiens que ton entreprise paie, au prix affiché", "achète"),
    L("recommend", "Achète et recommande", "tu paies et tu le recommandes à une personne précise", "recommendation", "recom."),
  ],
};

// ─── Résolution ───────────────────────────────────────────────────────────────

export function signatureOf(p: Pick<ResolvedProtocol, "behaviors" | "objections" | "relevance">): string {
  const s = JSON.stringify([p.behaviors.map((b) => [b.code, b.level]), p.objections.map((o) => [o.code, o.canonical]), p.relevance.map((r) => [r.code, r.canonical])]);
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

const LEGACY: ResolvedProtocol = {
  custom: false,
  behaviors: LEGACY_BEHAVIORS,
  objections: LEGACY_OBJECTIONS,
  relevance: LEGACY_RELEVANCE,
  signature: signatureOf({ behaviors: LEGACY_BEHAVIORS, objections: LEGACY_OBJECTIONS, relevance: LEGACY_RELEVANCE }),
};
export const LEGACY_PROTOCOL: Readonly<ResolvedProtocol> = LEGACY;

/** Résout un bloc `protocol` (ou son absence) en protocole complet. */
export function resolveProtocolSpec(spec: ProjectProtocol | null | undefined): ResolvedProtocol {
  if (!spec) return LEGACY;
  const behaviors = spec.behaviors ?? (spec.productType ? DEFAULT_BEHAVIORS[spec.productType] : LEGACY_BEHAVIORS);
  const objections = spec.objections ?? LEGACY_OBJECTIONS;
  const relevance = spec.relevance ?? LEGACY_RELEVANCE;
  return {
    custom: true,
    ...(spec.productType && { productType: spec.productType }),
    behaviors,
    objections,
    relevance,
    signature: signatureOf({ behaviors, objections, relevance }),
  };
}

/** Protocole d'un projet (`extra.protocol`), historique s'il n'en a pas. */
export function resolveProtocol(project: Pick<Project, "extra">): ResolvedProtocol {
  return resolveProtocolSpec((project.extra as { protocol?: ProjectProtocol } | null)?.protocol);
}

/** Protocole d'une réponse : celui figé dans sa charge utile, sinon l'historique. */
export function protocolOfPayload(payload: { protocol?: ResolvedProtocol } | null | undefined): ResolvedProtocol {
  return payload?.protocol ?? LEGACY;
}

/** Outils de lecture d'un protocole. */
export function protocolTools(p: ResolvedProtocol) {
  const bIndex = new Map(p.behaviors.map((b, i) => [b.code, i]));
  const bLevel = new Map(p.behaviors.map((b) => [b.code, b.level]));
  const oCanon = new Map(p.objections.map((o) => [o.code, o.canonical]));
  const rCanon = new Map(p.relevance.map((r) => [r.code, r.canonical]));
  return {
    /** Niveau canonique d'un comportement (inaction si inconnu). */
    level: (code: string): CanonicalLevel => bLevel.get(code) ?? "inaction",
    /** Rang dans l'échelle du projet. */
    rank: (code: string) => bIndex.get(code) ?? 0,
    atLeast: (code: string, l: CanonicalLevel) => levelRank(bLevel.get(code) ?? "inaction") >= levelRank(l),
    objectionCanonical: (code: string): CanonicalObjection => oCanon.get(code) ?? "other",
    relevanceCanonical: (code: string): CanonicalRelevance => rCanon.get(code) ?? "marginal",
    behaviorCodes: p.behaviors.map((b) => b.code),
    objectionCodes: p.objections.map((o) => o.code),
    relevanceCodes: p.relevance.map((r) => r.code),
  };
}
