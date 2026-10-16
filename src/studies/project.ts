import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { asc, eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Db } from "../db/client";
import { projects, type Project } from "../db/schema";
import { normalizePricing, pricingSchema, referenceOffer, type Pricing } from "./price-model";
import { projectTargetingSchema, type TargetSpec } from "../population/target";
import { projectProtocolSchema, type ProjectProtocol } from "./protocols/protocol";
import { rolesSchema, type RoleSpec } from "./roles";

/** Fichier de description d'un projet (JSON ou YAML). */
export const projectFileSchema = z.object({
  /** Identifiant lisible ; par défaut dérivé du nom. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "minuscules, chiffres et tirets").optional(),
  name: z.string().min(1),
  /** Ce que verrait un utilisateur : texte de la pub, de la page d'accueil, du message d'un collègue. */
  pitch: z.string().min(20),
  /** Cible visée par le porteur (n'est pas montrée aux personas). */
  targetAudience: z.string().optional(),
  /** Modèle économique (n'est pas montré aux personas). */
  businessModel: z.string().optional(),
  /**
   * Prix. Forme historique : `{ amountEur, period }` (offre unique en euros). Forme générique (phase 2b) :
   * `{ currency, offers, reference, tiers, freemium, minimumOrder, fx }`, voir `price-model.ts`.
   */
  price: z.union([
    z.object({
      amountEur: z.number().positive(),
      /** Unité de prix : abonnement mensuel ou annuel, achat unique, ou paiement par mise en relation acceptée. */
      period: z.enum(["month", "year", "once", "connection"]).default("month"),
    }),
    pricingSchema,
  ]),
  /** Offre gratuite éventuelle, telle qu'affichée. */
  freeOffer: z.string().nullable().optional(),
  competitors: z.array(z.string()).default([]),
  alternatives: z.array(z.string()).default([]),
  /** Paliers Gabor-Granger (€ par période) ; le prix du projet est ajouté s'il manque. */
  priceTiers: z.array(z.number().positive()).min(2).max(5).optional(),
  /** Population ciblée et témoin (socle, modules, filtre d'éligibilité, quotas) : voir src/population/target.ts. */
  ...projectTargetingSchema,
  /** Protocole propre au projet (lot P1) : type de produit, échelle de comportements, taxonomie d'objections, pertinence. */
  protocol: projectProtocolSchema.optional(),
  /**
   * Neutralisation du pitch (project:neutralize-pitch) : quand une version factuelle a été validée,
   * `pitch` porte la version testée (neutre) et `pitchOriginal` le texte d'origine du porteur.
   * Sans ces champs, le comportement est inchangé.
   */
  pitchOriginal: z.string().min(1).optional(),
  pitchNeutralized: z.boolean().optional(),
  /**
   * Multi-rôles (phase 7) : une population par rôle (coach et membre, parent payeur…), chacune avec sa
   * cible, sa vue de l'offre et sa perspective. Remplace `target` et `control`. Voir src/studies/roles.ts.
   */
  roles: rolesSchema.optional(),
}).superRefine((f, ctx) => {
  if (f.roles && (f.target || f.control)) {
    ctx.addIssue({ code: "custom", path: ["roles"], message: "`roles` remplace `target` et `control` : chaque rôle porte sa propre cible" });
  }
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export interface ProjectExtra {
  priceTiers?: number[];
  /** Modèle de prix générique (absent pour un projet historique). */
  pricing?: Pricing;
  sourceFile?: string;
  /** Ciblage (phase 2a) : cible et témoin déclarés dans le fichier projet. */
  target?: TargetSpec;
  control?: TargetSpec;
  /** Protocole propre au projet (absent : protocole historique). */
  protocol?: ProjectProtocol;
  /** Pitch d'origine, si le pitch testé a été neutralisé. */
  pitchOriginal?: string;
  pitchNeutralized?: boolean;
  /** Rôles (phase 7) ; absent : projet classique. */
  roles?: RoleSpec[];
}

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function readProjectFile(path: string): ProjectFile {
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  const raw: unknown = ext === ".yaml" || ext === ".yml" ? parseYaml(text) : JSON.parse(text);
  const parsed = projectFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Projet invalide (${path}) :\n` + parsed.error.issues.map((i) => `- ${i.path.join(".")} : ${i.message}`).join("\n"),
    );
  }
  return parsed.data;
}

/** Paliers Gabor-Granger : ceux du fichier, sinon ≈ 0,4×, 1× et 1,8× le prix. Le prix du projet en fait toujours partie. */
export function priceTiersFor(project: Pick<Project, "priceEur" | "extra">): number[] {
  const price = project.priceEur ?? 0;
  const fromFile = (project.extra as ProjectExtra).priceTiers;
  const round = (x: number) => (x < 10 ? Math.max(1, Math.round(x)) : Math.round(x / 5) * 5);
  const tiers = fromFile?.length ? [...fromFile] : [round(price * 0.4), price, round(price * 1.8)];
  if (price > 0 && !tiers.includes(price)) tiers.push(price);
  return [...new Set(tiers)].sort((a, b) => a - b);
}

/** Colonnes de prix d'un projet, depuis la forme historique ou générique du fichier. */
export function priceColumns(file: Pick<ProjectFile, "price" | "priceTiers" | "freeOffer">): {
  priceEur: number;
  pricePeriod: string;
  freeOffer: string | null;
  extra: Pick<ProjectExtra, "priceTiers" | "pricing">;
} {
  const price = file.price;
  if ("amountEur" in price) {
    return {
      priceEur: price.amountEur,
      pricePeriod: price.period,
      freeOffer: file.freeOffer ?? null,
      extra: { ...(file.priceTiers && { priceTiers: file.priceTiers }) },
    };
  }
  const pricing = normalizePricing(price);
  const ref = referenceOffer(pricing);
  const tiers = pricing.tiers ?? file.priceTiers;
  return {
    // Montant de l'offre de référence, dans sa devise (la colonne garde son nom historique).
    priceEur: ref.amount,
    pricePeriod: ref.unit,
    freeOffer: file.freeOffer ?? pricing.freemium?.free ?? null,
    extra: { pricing: { ...pricing, ...(tiers && { tiers }) }, ...(tiers && { priceTiers: tiers }) },
  };
}

export function createProject(db: Db, file: ProjectFile, opts: { sourceFile?: string; update?: boolean } = {}): Project {
  const id = file.id ?? slugify(file.name);
  const cols = priceColumns(file);
  const values = {
    name: file.name,
    pitch: file.pitch.trim(),
    targetAudience: file.targetAudience ?? null,
    businessModel: file.businessModel ?? null,
    priceEur: cols.priceEur,
    pricePeriod: cols.pricePeriod,
    freeOffer: cols.freeOffer,
    competitors: file.competitors,
    alternatives: file.alternatives,
    extra: {
      ...cols.extra,
      ...(opts.sourceFile && { sourceFile: opts.sourceFile }),
      ...(file.target && { target: file.target }),
      ...(file.control && { control: file.control }),
      ...(file.protocol && { protocol: file.protocol }),
      ...(file.pitchOriginal && { pitchOriginal: file.pitchOriginal }),
      ...(file.pitchNeutralized !== undefined && { pitchNeutralized: file.pitchNeutralized }),
      ...(file.roles && { roles: file.roles }),
    } satisfies ProjectExtra,
  };
  const existing = getProject(db, id);
  if (existing) {
    if (!opts.update) throw new Error(`Le projet « ${id} » existe déjà (ajouter --update pour le remplacer).`);
    return db.update(projects).set(values).where(eq(projects.id, id)).returning().get();
  }
  return db.insert(projects).values({ id, ...values }).returning().get();
}

export function getProject(db: Db, id: string): Project | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export function listProjects(db: Db): Project[] {
  return db.select().from(projects).orderBy(asc(projects.createdAt)).all();
}

/** Unité « par … » de chaque période de prix (Van Westendorp, paliers, revenus). */
export const PERIOD_LABELS: Record<string, string> = {
  month: "mois",
  year: "an",
  once: "achat unique",
  connection: "mise en relation",
  // Unités du modèle générique (le libellé précis vient de l'offre : voir `unitLabel`)
  one_time: "achat unique",
};

/** Unités payées à l'usage (et non par abonnement ou achat). */
export const PER_USE_PERIODS = new Set(["connection"]);

export function formatPrice(amount: number, period: string | null): string {
  const a = `${amount.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} €`;
  if (period === "once") return a;
  if (period && PER_USE_PERIODS.has(period)) return `${a} par ${PERIOD_LABELS[period]}`;
  return `${a}/${PERIOD_LABELS[period ?? "month"] ?? period}`;
}
