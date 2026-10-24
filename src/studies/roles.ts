import { z } from "zod";
import type { Persona, Project } from "../db/schema";
import { cardLines, drawPhase, type ModuleValues } from "../modules/engine";
import { attributeBlock, type BlockLocale } from "./protocols/attribute-block";
import { moduleLibrary, resolveModules, type LoadedModule, type ResolvedModules } from "../modules/registry";
import { Rng } from "../personas/rng";
import { compileEligibility, type CompiledEligibility } from "../population/eligibility";
import { targetSpecSchema } from "../population/target";
import { pricingSchema } from "./price-model";

/**
 * Multi-rôles (phase 7, docs/architecture-v2.md § « Multi-rôles ») : plusieurs populations dans une même
 * étude, chacune avec sa cible, sa vue de l'offre, sa perspective et ses sections de protocole.
 *
 * - `both` : la persona utilise et paie (cas de tous les projets sans rôles).
 * - `payer` : la persona décide et paie ; d'autres utilisent (le coach d'un groupe).
 * - `user` : la persona utilise sans payer (un membre du groupe) : ni Van Westendorp, ni Gabor-Granger,
 *   ni comportement payant ; une question d'usage attendu.
 * - `payer_for_child` : un adulte du socle répond en parent qui déciderait et paierait pour un enfant de
 *   son foyer (application pour enfant). L'enfant est tiré du ménage (âges connus), son profil par des modules « enfant ».
 *
 * Un projet sans `roles` se comporte exactement comme avant (prompts v2 et v3 inchangés).
 */

export const PERSPECTIVES = ["user", "payer", "payer_for_child", "both"] as const;
export type Perspective = (typeof PERSPECTIVES)[number];
export const PERSPECTIVE_LABELS: Record<Perspective, string> = {
  user: "utilisateur, ne paie pas",
  payer: "payeur, décide pour d'autres utilisateurs",
  payer_for_child: "parent payeur, pour un enfant du foyer",
  both: "utilisateur et payeur",
};
/** Perspectives qui voient un prix et répondent aux questions de prix. */
export const PAYING_PERSPECTIVES = new Set<Perspective>(["payer", "payer_for_child", "both"]);

export const USAGE_LEVELS = ["never", "tried_once", "monthly", "weekly", "several_per_week"] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];
export const USAGE_LABELS: Record<UsageLevel, string> = {
  never: "Ne l'utiliserait pas",
  tried_once: "Essaierait une fois",
  monthly: "Quelques fois par mois",
  weekly: "Chaque semaine",
  several_per_week: "Plusieurs fois par semaine",
};
/** Usage régulier : au moins chaque semaine. */
export const REGULAR_USAGE = new Set<UsageLevel>(["weekly", "several_per_week"]);

const roleId = z.string().regex(/^[a-z][a-z0-9_-]*$/, "minuscules, chiffres, tirets ou _ (ex. coach, member)");

export const childSpecSchema = z
  .object({
    /** Tranche d'âge des enfants concernés (inclusive). */
    ages: z.object({ min: z.number().int().min(0).max(17), max: z.number().int().min(0).max(17) }).strict(),
    /** Modules appliqués à l'enfant (déclarés `applies_to: [<socle>-enfants]`), tirés à partir du ménage. */
    modules: z.array(z.string()).default([]),
    /** Filtre sur l'enfant : `child.age`, `child.sex` et `module.attribut` des modules enfant. */
    eligibility: z.string().optional(),
  })
  .strict()
  .refine((c) => c.ages.min <= c.ages.max, { message: "ages.min doit être ≤ ages.max" });
export type ChildSpec = z.infer<typeof childSpecSchema>;

const legacyPrice = z.object({ amountEur: z.number().positive(), period: z.enum(["month", "year", "once", "connection"]).default("month") });

export const roleSpecSchema = z
  .object({
    id: roleId,
    label: z.string().min(1),
    perspective: z.enum(PERSPECTIVES),
    /** Cible du rôle : même format que `target` (socle, modules, éligibilité, quotas, n). */
    target: targetSpecSchema,
    /** Situation du rôle, montrée à la persona (« Tu entraînes un ou plusieurs groupes… »). */
    intro: z.string().min(10).optional(),
    /** Pitch vu de ce rôle ; par défaut celui du projet. */
    pitch: z.string().min(20).optional(),
    /** Prix vu de ce rôle (rôles payeurs) ; par défaut celui du projet. */
    price: z.union([legacyPrice, pricingSchema]).optional(),
    priceTiers: z.array(z.number().positive()).min(2).max(5).optional(),
    freeOffer: z.string().nullable().optional(),
    /** Rôle non payeur : ce que l'offre lui coûte (« gratuit pour les membres : c'est le coach qui paie »). */
    offerNote: z.string().min(5).optional(),
    /** Sections actives ; par défaut : prix pour les perspectives payeuses, usage attendu pour `user`. */
    sections: z.object({ pricing: z.boolean().optional(), usage: z.boolean().optional() }).strict().optional(),
    /** `payer_for_child` : enfants concernés et leur profil. */
    child: childSpecSchema.optional(),
    /**
     * Dépendance à un autre rôle (sans simulation d'interaction) : le payeur dit à partir de quelle part
     * d'utilisateurs réguliers de ce rôle il paierait, et le résumé croise avec l'usage simulé de ce rôle.
     */
    dependsOn: z.object({ role: roleId }).strict().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (r.perspective === "user" && r.sections?.pricing) issue("sections", "un rôle « user » ne paie pas : pas de section prix");
    if (r.perspective === "user" && (r.price || r.priceTiers)) issue("price", "un rôle « user » ne paie pas : pas de prix");
    if (r.perspective === "payer_for_child" && !r.child) issue("child", "perspective « payer_for_child » : bloc `child` requis (âges, modules)");
    if (r.perspective !== "payer_for_child" && r.child) issue("child", "bloc `child` réservé à la perspective « payer_for_child »");
    if (r.dependsOn && !PAYING_PERSPECTIVES.has(r.perspective)) issue("dependsOn", "seul un rôle payeur dépend de l'adoption d'un autre rôle");
  });
export type RoleSpec = z.infer<typeof roleSpecSchema>;

/** Bloc `roles` du fichier projet, avec ses contrôles croisés. */
export const rolesSchema = z
  .array(roleSpecSchema)
  .min(1)
  .superRefine((roles, ctx) => {
    const ids = roles.map((r) => r.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: "custom", message: `rôle « ${dup} » déclaré deux fois` });
    for (const r of roles) {
      if (!r.dependsOn) continue;
      const dep = roles.find((x) => x.id === r.dependsOn!.role);
      if (!dep) ctx.addIssue({ code: "custom", message: `rôle « ${r.id} » : dependsOn vers un rôle inconnu « ${r.dependsOn.role} »` });
      else if (dep.id === r.id) ctx.addIssue({ code: "custom", message: `rôle « ${r.id} » : dépend de lui-même` });
    }
  });

/** Rôles d'un projet (vide : projet classique). */
export function projectRoles(project: Pick<Project, "extra">): RoleSpec[] {
  return ((project.extra as { roles?: RoleSpec[] } | null)?.roles ?? []) as RoleSpec[];
}

export const rolePricing = (r: Pick<RoleSpec, "perspective" | "sections">) => r.sections?.pricing ?? PAYING_PERSPECTIVES.has(r.perspective);
export const roleUsage = (r: Pick<RoleSpec, "perspective" | "sections">) => r.sections?.usage ?? r.perspective === "user";

/** Rôle figé dans une réponse (pour le résumé : un changement ultérieur du projet ne modifie pas une étude passée). */
export interface FrozenRole {
  id: string;
  label: string;
  perspective: Perspective;
  pricing: boolean;
  usage: boolean;
  dependsOn?: string;
}
export const freezeRole = (r: RoleSpec): FrozenRole => ({
  id: r.id,
  label: r.label,
  perspective: r.perspective,
  pricing: rolePricing(r),
  usage: roleUsage(r),
  ...(r.dependsOn && { dependsOn: r.dependsOn.role }),
});

// ─── Enfant (payer_for_child) ─────────────────────────────────────────────────

export interface ChildProfile {
  /** Rang de l'enfant dans `extra.childrenAges`. */
  index: number;
  age: number;
  sex: "M" | "F";
  /** Valeurs des modules enfant. */
  modules: ModuleValues;
  /** Lignes de fiche des modules enfant. */
  lines: string[];
}

type ChildPersona = Pick<Persona, "id" | "seed" | "drawIndex" | "narrative" | "region" | "townSize" | "householdType" | "extra">;

export interface PreparedChild {
  spec: ChildSpec;
  modules: ResolvedModules;
  filter: CompiledEligibility | null;
}

/** Socle des modules enfant : `<socle>-enfants` (ex. fr-enfants), pour qu'un module adulte ne s'applique pas à un enfant. */
export const childSocle = (socle: string) => `${socle}-enfants`;

export function prepareChild(spec: ChildSpec, socle: string, lib: Map<string, LoadedModule> = moduleLibrary()): PreparedChild {
  const modules = resolveModules(spec.modules, childSocle(socle), lib);
  const known = new Set(["child.age", "child.sex"]);
  for (const m of modules.ordered) for (const a of m.def.attributes) known.add(`${m.def.id}.${a.key}`);
  return { spec, modules, filter: spec.eligibility ? compileEligibility(spec.eligibility, known) : null };
}

/**
 * Sexe d'un enfant : celui du récit s'il ne parle que d'un fils ou que d'une fille (enfant unique), sinon tiré.
 * Évite la contradiction avec le contrôle des faits (`child_gender_mismatch`).
 */
function childSex(p: ChildPersona, k: number, nKids: number): "M" | "F" {
  const narrative = (p.narrative ?? "").replace(/’/g, "'");
  if (nKids <= 1) {
    const son = /\b(son|un|leur) fils\b/i.test(narrative);
    const daughter = /\b(sa|une|leur) fille\b/i.test(narrative);
    if (son && !daughter) return "M";
    if (daughter && !son) return "F";
  }
  return new Rng(`child-sex:${p.id}:${k}`).bool(0.5) ? "M" : "F";
}

/** Profils de tous les enfants du foyer dans la tranche d'âge (déterministe : persona, rang de l'enfant). */
export function childProfiles(p: ChildPersona, prepared: PreparedChild): ChildProfile[] {
  const ages = ((p.extra ?? {}) as { childrenAges?: number[] }).childrenAges ?? [];
  const out: ChildProfile[] = [];
  ages.forEach((age, k) => {
    if (age < prepared.spec.ages.min || age > prepared.spec.ages.max) return;
    const sex = childSex(p, k, ages.length);
    const x = (p.extra ?? {}) as { livingStandardEur?: number; tenure?: string };
    const socle: Record<string, string | number | null> = {
      age,
      sex,
      region: p.region,
      town_size: p.townSize,
      household_type: p.householdType,
      tenure: x.tenure ?? null,
      living_standard: x.livingStandardEur ?? null,
      siblings: ages.length - 1,
    };
    const values: ModuleValues = {};
    if (prepared.modules.ordered.length) {
      if (p.seed === null || p.drawIndex === null) throw new Error(`Persona ${p.id} sans graine ni rang : profil d'enfant impossible à tirer`);
      // Flux propre à l'enfant et au module ; rang décalé pour les dimensions quasi aléatoires (indépendant des modules adultes)
      const ctx = {
        rng: new Rng("unused"),
        rngFor: (id: string) => Rng.forPersona(p.seed!, p.drawIndex!, `child:${k}:module:${id}`),
        seed: p.seed,
        index: 1_000_000 + p.drawIndex * 20 + k,
        socle,
      };
      const streams = new Map<string, Rng>();
      const rngFor = (id: string) => {
        let r = streams.get(id);
        if (!r) streams.set(id, (r = ctx.rngFor(id)));
        return r;
      };
      drawPhase(prepared.modules, "work", values, { ...ctx, rngFor });
      drawPhase(prepared.modules, "profile", values, { ...ctx, rngFor });
    }
    const vars: Record<string, string | number | boolean | null> = { "child.age": age, "child.sex": sex };
    for (const [mid, vals] of Object.entries(values)) for (const [key, v] of Object.entries(vals)) vars[`${mid}.${key}`] = v as never;
    if (prepared.filter && !prepared.filter.test(vars as never)) return;
    out.push({ index: k, age, sex, modules: values, lines: cardLines(prepared.modules, values, sex, socle).map((l) => l.line) });
  });
  return out;
}

/** Enfant retenu pour une persona dans une étude (déterministe : graine de l'étude, persona) ; null si aucun. */
export function pickChild(p: ChildPersona, prepared: PreparedChild, studySeed: number): ChildProfile | null {
  const kids = childProfiles(p, prepared);
  if (!kids.length) return null;
  return kids[new Rng(`child-pick:${studySeed}:${p.id}`).int(0, kids.length - 1)]!;
}

/** Désignation de l'enfant : « ton fils de 11 ans », « ta fille de 9 ans ». */
export const childDesignation = (c: Pick<ChildProfile, "age" | "sex">, possessive: "ton" | "mon" = "ton") =>
  `${c.sex === "M" ? possessive : possessive === "ton" ? "ta" : "ma"} ${c.sex === "M" ? "fils" : "fille"} de ${c.age} an${c.age > 1 ? "s" : ""}`;

/**
 * Bloc « Ton enfant » du prompt utilisateur. `attributeBlock` (protocole v4) : les lignes des modules enfant
 * sont placées dans le bloc délimité, valeurs neutralisées ; absent : texte historique.
 */
export function childBlock(c: ChildProfile, opts: { attributeBlock?: BlockLocale } = {}): string {
  const head = `${childDesignation(c).replace(/^./, (x) => x.toUpperCase())}, qui vit avec toi.`;
  const lines = [head, ...(opts.attributeBlock ? attributeBlock(c.lines, opts.attributeBlock, "- ") : c.lines.map((l) => `- ${l}`))];
  return `## L'enfant pour qui tu décides\n${lines.join("\n")}\nTu réponds pour cet enfant-là : parle de « ${childDesignation(c, "mon")} ».`;
}

/** Libellé d'un niveau d'usage, ou le code s'il est inconnu. */
export const usageLabel = (code: string) => USAGE_LABELS[code as UsageLevel] ?? code;
