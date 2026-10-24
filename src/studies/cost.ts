import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { PACKAGE_ROOT } from "../config";
import type { Db } from "../db/client";
import { personas, responses, studies, type Study } from "../db/schema";
import type { Pack } from "../personas/pack";
import { createStudy, type CreateStudyInput } from "./study";
import { pricedCost, pricingFor, type Pricing } from "../engine/pricing";
import { effectiveLimits, type BudgetLimits } from "../engine/budget";
import { isPaidProvider } from "../engine/pricing";
import type { EngineProfile } from "../engine/profiles";
import { PROTOCOL_ID } from "./protocols/concept-price";

/**
 * Estimation du coût d'une étude avant lancement (docs/plateforme.md § 7.3) :
 *
 *   appels = n × (1 + taux de réparation) + ⌈récits manquants / 10⌉ + appels de pré-tri
 *   tokens ≈ appels × moyenne mesurée par protocole et par socle
 *   coût = Σ tokens × prix du modèle (entrée, sortie, cache), fourchette ±30 %
 *
 * Moyennes : réponses de la base locale (même protocole, même socle ; même fournisseur si possible),
 * sinon la table de référence livrée (pricing/reference-usage.json, mesurée sur la base locale du mainteneur,
 * sans identifiant d'étude). Le taux de réparation est mesuré (tentatives par réponse).
 */

export const NARRATIVE_BATCH = 10;
export const RANGE = 0.3;
/** Effectif minimal de réponses locales pour préférer la mesure locale à la référence. */
export const MIN_LOCAL_RESPONSES = 20;
export const REFERENCE_FILE = join(PACKAGE_ROOT, "pricing", "reference-usage.json");

const protoRowSchema = z.object({
  protocol: z.string(),
  version: z.string(),
  socle: z.string(),
  provider: z.string(),
  responses: z.number(),
  callsPerResponse: z.number(),
  inputPerCall: z.number(),
  outputPerCall: z.number(),
  cacheReadPerCall: z.number(),
  msPerResponse: z.number(),
});
export type UsageMeans = z.infer<typeof protoRowSchema>;

export const referenceSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  note: z.string(),
  charsPerToken: z.number(),
  protocols: z.array(protoRowSchema),
  narratives: z.object({ batchSize: z.number(), batches: z.number(), inputPerBatch: z.number(), outputPerBatch: z.number(), method: z.string() }),
});
export type ReferenceUsage = z.infer<typeof referenceSchema>;

/** Valeurs de secours si la table de référence manque (ordre de grandeur de la base du mainteneur au 2026-10-16). */
const FALLBACK_REFERENCE: ReferenceUsage = {
  version: 1,
  generatedAt: "",
  note: "repli intégré",
  charsPerToken: 3,
  protocols: [{ protocol: PROTOCOL_ID, version: "3", socle: "fr", provider: "claude-cli", responses: 0, callsPerResponse: 1.05, inputPerCall: 9000, outputPerCall: 1200, cacheReadPerCall: 7000, msPerResponse: 8300 }],
  narratives: { batchSize: 10, batches: 0, inputPerBatch: 6000, outputPerBatch: 4500, method: "repli" },
};

let refCache: ReferenceUsage | null = null;
export function loadReference(path = REFERENCE_FILE): ReferenceUsage {
  if (path === REFERENCE_FILE && refCache) return refCache;
  // Table livrée absente : paquet incomplet, erreur explicite (pas d'estimation silencieuse sur le repli).
  if (!existsSync(path) && path === REFERENCE_FILE) {
    throw new Error(`Table de référence introuvable : ${path}. Elle est livrée avec Personas (pricing/reference-usage.json) : installation incomplète, réinstaller le paquet.`);
  }
  const r = existsSync(path) ? referenceSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : FALLBACK_REFERENCE;
  if (path === REFERENCE_FILE) refCache = r;
  return r;
}

/** Socle d'une population (`fr-2026.2` → `fr`, `sg-2026.1` → `sg`). */
export const socleOfPack = (packVersion: string | undefined) => (packVersion ?? "fr").split("-")[0]!.toLowerCase() || "fr";

/**
 * Moyennes mesurées dans la base locale, par protocole, version, socle et fournisseur (une ligne par
 * groupe d'au moins `min` réponses). Aucun identifiant d'étude n'en sort.
 */
export function measuredMeans(db: Db, opts: { min?: number; protocol?: string } = {}): UsageMeans[] {
  const rows = db
    .select({
      studyId: responses.studyId,
      backend: responses.backend,
      input: responses.inputTokens,
      output: responses.outputTokens,
      cacheRead: responses.cacheReadTokens,
      attempts: responses.attempts,
      ms: responses.durationMs,
    })
    .from(responses)
    .all();
  const studyRows = db.select({ id: studies.id, protocol: studies.protocol, version: studies.protocolVersion, populations: studies.populations }).from(studies).all();
  const meta = new Map(studyRows.map((s) => [s.id, s]));
  const groups = new Map<string, { key: Omit<UsageMeans, "responses" | "callsPerResponse" | "inputPerCall" | "outputPerCall" | "cacheReadPerCall" | "msPerResponse">; n: number; calls: number; input: number; output: number; cacheRead: number; ms: number }>();
  for (const r of rows) {
    const s = meta.get(r.studyId);
    if (!s || (opts.protocol && s.protocol !== opts.protocol)) continue;
    const key = { protocol: s.protocol, version: String(s.version), socle: socleOfPack(s.populations?.[0]?.packVersion), provider: r.backend };
    const k = JSON.stringify(key);
    const g = groups.get(k) ?? { key, n: 0, calls: 0, input: 0, output: 0, cacheRead: 0, ms: 0 };
    g.n++;
    g.calls += Math.max(1, r.attempts);
    g.input += r.input;
    g.output += r.output;
    g.cacheRead += r.cacheRead;
    g.ms += r.ms;
    groups.set(k, g);
  }
  const min = opts.min ?? MIN_LOCAL_RESPONSES;
  return [...groups.values()]
    .filter((g) => g.n >= min)
    .map((g) => ({
      ...g.key,
      responses: g.n,
      callsPerResponse: round(g.calls / g.n, 4),
      inputPerCall: Math.round(g.input / g.calls),
      outputPerCall: Math.round(g.output / g.calls),
      cacheReadPerCall: Math.round(g.cacheRead / g.calls),
      msPerResponse: Math.round(g.ms / g.n),
    }))
    .sort((a, b) => a.protocol.localeCompare(b.protocol) || a.version.localeCompare(b.version) || a.socle.localeCompare(b.socle) || a.provider.localeCompare(b.provider));
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Version de protocole dont les mesures (tokens, réparations, durée) valent pour une version donnée.
 * v4 = v3 + bloc délimité des attributs de module : même protocole de réponse (même JSON, mêmes mesures),
 * quelques dizaines de tokens d'entrée en plus. Une étude v4 s'appuie donc sur les mesures v3 tant qu'il
 * n'existe pas de mesures v4 (docs/plateforme.md § 7.3).
 */
export const MEASURE_VERSION: Readonly<Record<string, string>> = { "4": "3" };
export const measureVersionOf = (version: string): string => MEASURE_VERSION[version] ?? version;

/** Rang de version : 0 identique, 1 même protocole de réponse (v4 → v3), 2 + écart sinon. */
function versionRank(have: string, want: string): number {
  if (have === want) return 0;
  const h = measureVersionOf(have);
  const w = measureVersionOf(want);
  if (h === w) return 1;
  const d = Math.abs(Number(h) - Number(w));
  return 2 + (Number.isFinite(d) ? Math.min(d, 7) : 7);
}

/** Meilleure ligne : même protocole ; même version, puis même protocole de réponse (v4 → v3), puis la plus proche ; même socle, puis fr ; même fournisseur, puis claude-cli. */
function pickMeans(rows: UsageMeans[], want: { protocol: string; version: string; socle: string; provider: string }): UsageMeans | null {
  const score = (r: UsageMeans) =>
    (r.protocol === want.protocol ? 0 : 10_000) +
    versionRank(r.version, want.version) * 100 +
    (r.socle === want.socle ? 0 : r.socle === "fr" ? 10 : 20) +
    (r.provider === want.provider ? 0 : r.provider === "claude-cli" ? 1 : 2);
  const sorted = [...rows].sort((a, b) => score(a) - score(b) || b.responses - a.responses);
  return sorted[0] ?? null;
}

export interface CostEstimateInput {
  profile: Pick<EngineProfile, "name" | "provider" | "model" | "baseUrl" | "concurrency" | "limits">;
  /** Concurrence effective du backend (sinon celle du profil, sinon 1). */
  concurrency?: number;
  protocolVersion: string;
  socle: string;
  /** Réponses à obtenir (n restantes). */
  responses: number;
  missingNarratives: number;
  /** Appels de pré-tri (modèle local, Ollama), s'il est demandé. */
  triageCalls?: number;
  /** Base locale pour les moyennes mesurées (sinon la référence seule). */
  db?: Db | null;
  reference?: ReferenceUsage;
}

export interface CostEstimate {
  profile: string;
  provider: string;
  model: string;
  calls: { responses: number; repairs: number; narratives: number; triage: number; total: number };
  repairRate: number;
  tokens: { input: number; output: number; cacheRead: number };
  cost: {
    /** `paid` : facturé par le fournisseur ; `subscription` : claude-cli, équivalent API couvert par l'abonnement ; `local` : 0 ; `unknown` : prix inconnu. */
    kind: Pricing["kind"];
    usd: number | null;
    low: number | null;
    high: number | null;
    priceSource: string | null;
  };
  /** Durée estimée selon la concurrence, en minutes. */
  durationMinutes: number;
  concurrency: number;
  /** Origine des moyennes : base locale ou table de référence livrée. */
  basis: {
    source: "local" | "reference";
    responses: number;
    provider: string;
    socle: string;
    /** Version des mesures utilisées (v3 pour une étude v4 sans mesures v4). */
    version: string;
    /** Version du protocole de l'étude estimée. */
    forVersion: string;
  };
  limits: BudgetLimits;
  /** Le haut de la fourchette dépasse le plafond par étude : l'étude se mettra en pause avant la fin. */
  exceedsStudyCap: boolean;
  /** Coût inconnu : une confirmation explicite est demandée avant de créer ou lancer l'étude. */
  requiresConfirmation: boolean;
}

export function estimateCost(input: CostEstimateInput): CostEstimate {
  const ref = input.reference ?? loadReference();
  const want = { protocol: PROTOCOL_ID, version: input.protocolVersion, socle: input.socle, provider: input.profile.provider };
  const local = input.db ? pickMeans(measuredMeans(input.db, { protocol: PROTOCOL_ID }), want) : null;
  const refRow = pickMeans(ref.protocols, want);
  // Mesure locale si elle correspond au moins au protocole et que sa version vaut celle de la référence ; la référence sinon
  const useLocal = local && local.protocol === want.protocol && (!refRow || versionRank(local.version, want.version) <= versionRank(refRow.version, want.version));
  const means = (useLocal ? local : refRow) ?? FALLBACK_REFERENCE.protocols[0]!;
  const responsesN = Math.max(0, input.responses);
  const repairRate = round(Math.max(0, means.callsPerResponse - 1), 6);
  const repairs = Math.ceil(round(responsesN * repairRate, 6));
  const narrativeCalls = Math.ceil(Math.max(0, input.missingNarratives) / NARRATIVE_BATCH);
  const triage = Math.max(0, input.triageCalls ?? 0);
  const answerCalls = responsesN + repairs;
  // Cache : mesuré pour le même fournisseur ; claude-cli met en cache lui-même ; ailleurs, aucune remise supposée (prudent)
  const sameProvider = means.provider === input.profile.provider;
  const cacheShare = sameProvider || input.profile.provider === "claude-cli" ? means.cacheReadPerCall : 0;
  const tokens = {
    input: Math.round(answerCalls * means.inputPerCall + narrativeCalls * ref.narratives.inputPerBatch),
    output: Math.round(answerCalls * means.outputPerCall + narrativeCalls * ref.narratives.outputPerBatch),
    cacheRead: Math.round(answerCalls * cacheShare),
  };
  const pricing = pricingFor(input.profile.provider, input.profile.model, { baseUrl: input.profile.baseUrl });
  const usd = pricedCost({ inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead }, pricing);
  // Sans concurrence déclarée : celle des fournisseurs HTTP par défaut (2, src/engine/index.ts)
  const concurrency = Math.max(1, input.concurrency ?? input.profile.concurrency ?? 2);
  const msPerCall = means.msPerResponse / Math.max(1, means.callsPerResponse);
  const narrativeMs = msPerCall * (ref.narratives.outputPerBatch / Math.max(1, means.outputPerCall));
  const ms = Math.ceil(answerCalls / concurrency) * msPerCall + Math.ceil(narrativeCalls / concurrency) * narrativeMs;
  const paid = isPaidProvider(input.profile.provider, input.profile.baseUrl);
  const limits = effectiveLimits(input.profile.limits, paid);
  const high = usd === null ? null : round(usd * (1 + RANGE), 4);
  return {
    profile: input.profile.name,
    provider: input.profile.provider,
    model: input.profile.model,
    calls: { responses: responsesN, repairs, narratives: narrativeCalls, triage, total: answerCalls + narrativeCalls + triage },
    repairRate: round(repairRate, 4),
    tokens,
    cost: {
      kind: pricing.kind,
      usd: usd === null ? null : round(usd, 4),
      low: usd === null ? null : round(usd * (1 - RANGE), 4),
      high,
      priceSource: pricing.kind === "paid" || pricing.kind === "subscription" ? pricing.source : null,
    },
    durationMinutes: Math.max(1, Math.round(ms / 60_000)),
    concurrency,
    basis: { source: useLocal ? "local" : "reference", responses: means.responses, provider: means.provider, socle: means.socle, version: means.version, forVersion: input.protocolVersion },
    limits,
    exceedsStudyCap: limits.perStudyUsd !== undefined && pricing.kind === "paid" && high !== null && high > limits.perStudyUsd,
    requiresConfirmation: pricing.kind === "unknown",
  };
}

/** Personas de la liste qui n'ont pas encore de récit (comptage en base, par paquets de 500). */
export function missingNarratives(db: Db, ids: string[]): number {
  const unique = [...new Set(ids)];
  let withNarrative = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const [row] = db.select({ n: count() }).from(personas).where(and(inArray(personas.id, chunk), isNotNull(personas.narrative))).all();
    withNarrative += row?.n ?? 0;
  }
  return unique.length - withNarrative;
}

/** Exécute `fn` dans une transaction toujours annulée : simulation sans écriture (aperçu d'une création). */
export function dryRun<T>(db: Db, fn: () => T): T {
  const sqlite = db.$client;
  let out: T | undefined;
  let done = false;
  const rollback = new Error("dry-run rollback");
  try {
    sqlite.transaction(() => {
      out = fn();
      done = true;
      throw rollback;
    })();
  } catch (err) {
    if (err !== rollback) throw err;
  }
  if (!done) throw new Error("Simulation interrompue.");
  return out as T;
}

/**
 * Estimation d'une étude à créer : la création est simulée (transaction annulée) pour connaître
 * l'échantillon, les récits manquants et le socle, puis le coût est estimé pour le profil.
 */
export function estimateNewStudy(
  db: Db,
  pack: Pack,
  input: CreateStudyInput,
  profile: CostEstimateInput["profile"],
  opts: { concurrency?: number; triageCalls?: number } = {},
): CostEstimate & { sampleSize: number; missingNarratives: number; shortfalls: string[]; notes: string[] } {
  const sim = dryRun(db, () => {
    const r = createStudy(db, pack, input);
    return { ids: r.study.personaIds, populations: r.study.populations, version: String(r.study.protocolVersion), missing: missingNarratives(db, r.study.personaIds), shortfalls: r.shortfalls, notes: r.notes };
  });
  const e = estimateCost({
    profile,
    ...(opts.concurrency !== undefined && { concurrency: opts.concurrency }),
    protocolVersion: sim.version,
    socle: socleOfPack(sim.populations[0]?.packVersion),
    responses: sim.ids.length,
    missingNarratives: sim.missing,
    ...(opts.triageCalls !== undefined && { triageCalls: opts.triageCalls }),
    db,
  });
  return { ...e, sampleSize: sim.ids.length, missingNarratives: sim.missing, shortfalls: sim.shortfalls, notes: sim.notes };
}

/** Estimation du reste d'une étude existante (réponses manquantes, récits manquants). */
export function estimateExistingStudy(db: Db, study: Study, profile: CostEstimateInput["profile"], opts: { concurrency?: number } = {}): CostEstimate & { remaining: number; missingNarratives: number } {
  const done = new Set(db.select({ p: responses.personaId }).from(responses).where(eq(responses.studyId, study.id)).all().map((r) => r.p)).size;
  const remaining = Math.max(0, study.personaIds.length - done);
  const missing = missingNarratives(db, study.personaIds);
  const e = estimateCost({
    profile,
    ...(opts.concurrency !== undefined && { concurrency: opts.concurrency }),
    protocolVersion: String(study.protocolVersion),
    socle: socleOfPack(study.populations?.[0]?.packVersion),
    responses: remaining,
    missingNarratives: missing,
    db,
  });
  return { ...e, remaining, missingNarratives: missing };
}

const usd = (x: number) => (x < 0.01 ? `${x.toFixed(4)} $` : x < 10 ? `${x.toFixed(2)} $` : `${x.toFixed(0)} $`);

/**
 * Base de l'estimation, en une phrase : même texte dans la CLI, le MCP et le tableau de bord
 * (web/src/i18n/project.ts reprend ce gabarit).
 */
export function basisLine(b: CostEstimate["basis"], en = false): string {
  const mapped = b.forVersion && b.forVersion !== b.version;
  return en
    ? `Basis: ${b.source === "local" ? `${b.responses} local responses` : "reference table"} (protocol v${b.version}${mapped ? `, applied to v${b.forVersion}` : ""}, ${b.socle}, ${b.provider}).`
    : `Base : ${b.source === "local" ? `${b.responses} réponses locales` : "table de référence"} (protocole v${b.version}${mapped ? `, appliqué à la v${b.forVersion}` : ""}, ${b.socle}, ${b.provider}).`;
}

/** Lignes lisibles de l'estimation (CLI). */
export function formatEstimate(e: CostEstimate, en = false): string[] {
  const c = e.calls;
  const out: string[] = [];
  out.push(
    en
      ? `Estimate (${e.profile}: ${e.provider} / ${e.model}): ${c.total} calls (${c.responses} responses + ${c.repairs} repairs + ${c.narratives} narrative batches${c.triage ? ` + ${c.triage} triage` : ""}), ~${Math.round(e.tokens.input / 1000)}k input and ~${Math.round(e.tokens.output / 1000)}k output tokens, ~${e.durationMinutes} min at concurrency ${e.concurrency}.`
      : `Estimation (${e.profile} : ${e.provider} / ${e.model}) : ${c.total} appels (${c.responses} réponses + ${c.repairs} réparations + ${c.narratives} lots de récits${c.triage ? ` + ${c.triage} de pré-tri` : ""}), ~${Math.round(e.tokens.input / 1000)} k tokens en entrée et ~${Math.round(e.tokens.output / 1000)} k en sortie, ~${e.durationMinutes} min à la concurrence ${e.concurrency}.`,
  );
  const range = e.cost.low !== null && e.cost.high !== null ? `${usd(e.cost.low)} – ${usd(e.cost.high)}` : "";
  if (e.cost.kind === "local") out.push(en ? "Cost: 0 (local model)." : "Coût : 0 (modèle local).");
  else if (e.cost.kind === "unknown") out.push(en ? `Cost unknown: model ${e.model} is not in pricing/models.json. Explicit confirmation required.` : `Coût inconnu : le modèle ${e.model} n'est pas dans pricing/models.json. Confirmation explicite requise.`);
  else if (e.cost.kind === "subscription") out.push(en ? `API-equivalent cost: ${range} (±30 %), covered by the subscription.` : `Coût équivalent API : ${range} (±30 %), couvert par l'abonnement.`);
  else out.push(en ? `Estimated cost: ${range} (±30 %), billed by ${e.provider}.` : `Coût estimé : ${range} (±30 %), facturé par ${e.provider}.`);
  if (e.limits.perStudyUsd !== undefined) {
    out.push(
      en
        ? `Spending cap: ${usd(e.limits.perStudyUsd)} per study${e.exceedsStudyCap ? " — the high end exceeds it: the study will pause before the end (raise the cap to finish)." : "."}`
        : `Plafond : ${usd(e.limits.perStudyUsd)} par étude${e.exceedsStudyCap ? " — le haut de la fourchette le dépasse : l'étude se mettra en pause avant la fin (relever le plafond pour finir)." : "."}`,
    );
  }
  out.push(`${basisLine(e.basis, en)} ${en ? `Repair rate ${(e.repairRate * 100).toFixed(1)} %.` : `Taux de réparation ${(e.repairRate * 100).toFixed(1)} %.`}`);
  return out;
}

/**
 * Ordre de grandeur du coût de `calls` appels d'un assistant (cible, recommandations…), aux moyennes
 * d'une réponse d'étude v3 (table de référence). Null si le prix du modèle est inconnu.
 */
export function assistantCallsCost(profile: Pick<EngineProfile, "provider" | "model" | "baseUrl">, calls: number, reference: ReferenceUsage = loadReference()): { kind: Pricing["kind"]; usd: number | null } {
  const means = pickMeans(reference.protocols, { protocol: PROTOCOL_ID, version: "3", socle: "fr", provider: profile.provider }) ?? FALLBACK_REFERENCE.protocols[0]!;
  const pricing = pricingFor(profile.provider, profile.model, { baseUrl: profile.baseUrl });
  const usd = pricedCost({ inputTokens: calls * means.inputPerCall, outputTokens: calls * means.outputPerCall, cacheReadTokens: profile.provider === "claude-cli" ? calls * means.cacheReadPerCall : 0 }, pricing);
  return { kind: pricing.kind, usd: usd === null ? null : round(usd, 4) };
}

/** Note lisible du coût (MCP, API). */
export function costNoteOf(kind: Pricing["kind"], usdLow: number | null, usdHigh: number | null, en = true): string {
  const r = usdLow !== null && usdHigh !== null ? `${usdLow.toFixed(2)}–${usdHigh.toFixed(2)} USD` : "";
  if (kind === "local") return en ? "local model: cost 0" : "modèle local : coût 0";
  if (kind === "unknown") return en ? "cost unknown: the model is not in pricing/models.json (explicit confirmation required)" : "coût inconnu : modèle absent de pricing/models.json (confirmation explicite requise)";
  if (kind === "subscription") return en ? `API-equivalent ${r} (±30 %), covered by the claude-cli subscription` : `équivalent API ${r} (±30 %), couvert par l'abonnement claude-cli`;
  return en ? `${r} (±30 %), billed by the provider` : `${r} (±30 %), facturé par le fournisseur`;
}
