import { and, eq, sum } from "drizzle-orm";
import type { Db } from "../db/client";
import { engineUsage } from "../db/schema";
import { cliCommand } from "../hints";
import { pricedCost, prudentPrice, usageCost, type ModelPrice, type Pricing } from "./pricing";
import type { BackendRequest, Usage } from "./types";

/**
 * Plafond de dépense (docs/plateforme.md § 7.3). Partagé par l'Engine comme le limiteur :
 * - avant chaque appel, si le coût engagé (base locale `engine_usage`) plus le coût prévu de l'appel
 *   dépasse un plafond (étude, jour, mois du profil), l'appel ne part pas : `BudgetExceededError` ;
 * - après chaque appel, l'usage × le prix du modèle est cumulé en base.
 * claude-cli et ollama n'ont pas de plafond par défaut (abonnement, local) : l'usage est enregistré.
 *
 * Prix inconnu (modèle absent de pricing/models.json) avec un plafond applicable : on échoue fermé.
 * - sans accord explicite : l'appel ne part pas (`UnknownCostBlockedError`, l'étude se met en pause) ;
 * - avec `acceptUnknownCost` (`--accept-unknown-cost` à la création de l'étude) : le coût est compté au prix
 *   prudent (`prudentPrice` : le plus cher de la table pour ce fournisseur, poste par poste), et le plafond
 *   s'applique à ce prix.
 */

export interface BudgetLimits {
  perStudyUsd?: number | undefined;
  perDayUsd?: number | undefined;
  perMonthUsd?: number | undefined;
}

/** Plafond par étude proposé pour un fournisseur payant, si le profil n'en fixe pas. */
export const DEFAULT_PER_STUDY_USD = 5;

/** Caractères par token pour prévoir l'entrée d'un appel (texte français, JSON : mesuré ≈ 3 à 3,5). */
export const CHARS_PER_TOKEN = 3;
/** Sortie prévue d'un appel sans `maxTokens`. */
export const DEFAULT_EXPECTED_OUTPUT = 1_500;

export type BudgetScope = "study" | "day" | "month";

/** Montant lisible : 4 décimales sous 0,01 $ (petits plafonds), 2 au-delà. */
export const fmtUsd = (x: number): string => x.toFixed(Math.abs(x) > 0 && Math.abs(x) < 0.01 ? 4 : 2);

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
  constructor(
    readonly scope: BudgetScope,
    readonly limitUsd: number,
    readonly committedUsd: number,
    readonly expectedUsd: number,
    readonly profile: string,
  ) {
    super(
      `Plafond de dépense atteint (${scope === "study" ? "par étude" : scope === "day" ? "par jour" : "par mois"}, profil ${profile}) : ` +
        `${fmtUsd(committedUsd)} $ engagés + ${expectedUsd.toFixed(expectedUsd > 0 && expectedUsd < 0.001 ? 6 : 3)} $ prévus > ${fmtUsd(limitUsd)} $. ` +
        `Relever le plafond : ${cliCommand("engine:profile", `limit ${profile} --per-${scope === "study" ? "study" : scope}-usd <montant>`)}, puis relancer study:run (les réponses déjà obtenues sont gardées).`,
    );
  }
}

/**
 * Plafond défini mais prix du modèle inconnu, sans accord explicite : le plafond ne peut pas être vérifié,
 * l'appel ne part pas. Traité comme un plafond atteint (l'étude se met en pause, reprise possible).
 */
export class UnknownCostBlockedError extends Error {
  override name = "UnknownCostBlockedError";
  constructor(
    readonly model: string,
    readonly profile: string,
    readonly studyId: string | null,
  ) {
    super(
      `${UNKNOWN_COST_PREFIX} (profil ${profile}) : prix du modèle ${model} inconnu (absent de pricing/models.json), aucun appel n'est parti. ` +
        `Ajouter son prix au fichier (ou PERSONAS_PRICING), ou accepter le coût inconnu pour cette étude : ` +
        `${cliCommand("study:run", `--study ${studyId ?? "<id>"} --accept-unknown-cost`)} (coût compté au prix du modèle le plus cher du fournisseur).`,
    );
  }
}

export const UNKNOWN_COST_PREFIX = "Plafond de dépense non vérifiable";

export const BUDGET_ERROR_PREFIX = "Plafond de dépense atteint";
export function isBudgetExceeded(err: unknown): boolean {
  if (err instanceof BudgetExceededError || err instanceof UnknownCostBlockedError) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.startsWith(BUDGET_ERROR_PREFIX) || msg.startsWith(UNKNOWN_COST_PREFIX);
}

export interface UsageRecord {
  profile: string;
  provider: string;
  model: string;
  studyId: string | null;
  usage: Usage;
  costUsd: number | null;
  at: Date;
}

/** Stockage de l'usage (base locale ; mémoire dans les tests). */
export interface UsageStore {
  committed(q: { scope: BudgetScope; profile: string; studyId: string | null; at: Date }): number;
  record(r: UsageRecord): void;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (d: Date) => d.toISOString().slice(0, 7);

export function dbUsageStore(db: Db): UsageStore {
  return {
    committed({ scope, profile, studyId, at }) {
      const where =
        scope === "study"
          ? studyId === null
            ? null
            : eq(engineUsage.studyId, studyId)
          : scope === "day"
            ? and(eq(engineUsage.profile, profile), eq(engineUsage.day, dayOf(at)))
            : and(eq(engineUsage.profile, profile), eq(engineUsage.month, monthOf(at)));
      if (!where) return 0;
      const [row] = db.select({ s: sum(engineUsage.costUsd) }).from(engineUsage).where(where).all();
      return Number(row?.s ?? 0);
    },
    record(r) {
      db.insert(engineUsage)
        .values({
          profile: r.profile,
          provider: r.provider,
          model: r.model,
          studyId: r.studyId,
          day: dayOf(r.at),
          month: monthOf(r.at),
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          cacheReadTokens: r.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: r.usage.cacheWriteTokens ?? 0,
          costUsd: r.costUsd,
          reportedCostUsd: r.usage.costUsd ?? null,
        })
        .run();
    },
  };
}

export function memoryUsageStore(): UsageStore & { rows: UsageRecord[] } {
  const rows: UsageRecord[] = [];
  return {
    rows,
    committed({ scope, profile, studyId, at }) {
      return rows
        .filter((r) =>
          scope === "study" ? studyId !== null && r.studyId === studyId : r.profile === profile && (scope === "day" ? dayOf(r.at) === dayOf(at) : monthOf(r.at) === monthOf(at)),
        )
        .reduce((s, r) => s + (r.costUsd ?? 0), 0);
    },
    record(r) {
      rows.push(r);
    },
  };
}

export interface BudgetGuardOptions {
  store: UsageStore;
  profile: string;
  provider: string;
  model: string;
  pricing: Pricing;
  limits: BudgetLimits;
  /** Étude à laquelle les appels sont imputés (plafond par étude). */
  studyId?: string | null;
  now?: () => Date;
  /** Prix inconnu accepté explicitement pour cette étude : compté au prix prudent au lieu d'être refusé. */
  acceptUnknownCost?: boolean;
  /** Prix prudent imposé (tests) ; sinon `prudentPrice(provider)`. */
  prudentPrice?: ModelPrice | null;
}

export class BudgetGuard {
  readonly limits: BudgetLimits;
  readonly pricing: Pricing;
  readonly profile: string;
  readonly studyId: string | null;
  /** Prix appliqué quand le prix réel est inconnu et accepté (null : pas de prix, l'appel est refusé sous plafond). */
  readonly fallbackPrice: ModelPrice | null;
  /** Coût prévu des appels partis et pas encore revenus (concurrence > 1) : compté comme engagé. */
  private pending = 0;

  constructor(private readonly opts: BudgetGuardOptions) {
    this.limits = opts.limits;
    this.pricing = opts.pricing;
    this.profile = opts.profile;
    this.studyId = opts.studyId ?? null;
    this.fallbackPrice =
      opts.pricing.kind === "unknown" && opts.acceptUnknownCost ? (opts.prudentPrice !== undefined ? opts.prudentPrice : prudentPrice(opts.provider)) : null;
  }

  /** Coût d'un usage : prix du modèle, sinon prix prudent accepté, sinon null (inconnu). */
  private costOf(usage: Pick<Usage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number | null {
    if (this.pricing.kind === "unknown" && this.fallbackPrice) return usageCost(usage, this.fallbackPrice);
    return pricedCost(usage, this.pricing);
  }

  /** Coût prévu d'un appel : entrée d'après la longueur du prompt, sortie d'après `maxTokens`. */
  expectedCost(request: Pick<BackendRequest, "system" | "messages" | "maxTokens" | "jsonSchema">): number {
    const chars = request.system.length + request.messages.reduce((s, m) => s + m.content.length, 0) + (request.jsonSchema ? JSON.stringify(request.jsonSchema).length : 0);
    const usage = { inputTokens: Math.ceil(chars / CHARS_PER_TOKEN), outputTokens: request.maxTokens ?? DEFAULT_EXPECTED_OUTPUT };
    return this.costOf(usage) ?? 0;
  }

  /** Lève BudgetExceededError si un plafond serait dépassé par cet appel. */
  check(expectedUsd: number): void {
    const at = (this.opts.now ?? (() => new Date()))();
    const scopes: Array<[BudgetScope, number | undefined]> = [
      ["study", this.studyId ? this.limits.perStudyUsd : undefined],
      ["day", this.limits.perDayUsd],
      ["month", this.limits.perMonthUsd],
    ];
    // Plafond applicable et prix inconnu sans prix prudent accepté : échouer fermé, aucun appel ne part
    if (this.pricing.kind === "unknown" && !this.fallbackPrice && scopes.some(([, limit]) => limit !== undefined)) {
      throw new UnknownCostBlockedError(this.pricing.model, this.profile, this.studyId);
    }
    for (const [scope, limit] of scopes) {
      if (limit === undefined) continue;
      const committed = this.opts.store.committed({ scope, profile: this.profile, studyId: this.studyId, at }) + this.pending;
      if (committed + expectedUsd > limit) throw new BudgetExceededError(scope, limit, committed, expectedUsd, this.profile);
    }
  }

  /** Réserve le coût prévu d'un appel qui part (vérifié d'abord) ; `release` à son retour. */
  reserve(expectedUsd: number): () => void {
    this.check(expectedUsd);
    this.pending += expectedUsd;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.pending = Math.max(0, this.pending - expectedUsd);
    };
  }

  /** Cumule l'usage d'un appel (usage × prix) ; renvoie le coût (null si le prix est inconnu). */
  record(usage: Usage, model: string): number | null {
    const costUsd = this.costOf(usage);
    this.opts.store.record({
      profile: this.profile,
      provider: this.opts.provider,
      model: model || this.opts.model,
      studyId: this.studyId,
      usage,
      costUsd,
      at: (this.opts.now ?? (() => new Date()))(),
    });
    return costUsd;
  }

  /** Même plafond et même stockage, imputé à une autre étude. */
  forStudy(studyId: string | null): BudgetGuard {
    return new BudgetGuard({ ...this.opts, studyId });
  }
}

/** Plafonds effectifs d'un profil : ceux du profil, sinon 5 $ par étude pour un fournisseur payant. */
export function effectiveLimits(limits: BudgetLimits | undefined, paid: boolean): BudgetLimits {
  const out: BudgetLimits = { ...(limits ?? {}) };
  if (paid && out.perStudyUsd === undefined) out.perStudyUsd = DEFAULT_PER_STUDY_USD;
  return out;
}
