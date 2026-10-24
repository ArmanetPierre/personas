import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PACKAGE_ROOT } from "../config";
import type { ProviderKind, Usage } from "./types";

/**
 * Prix des modèles (docs/plateforme.md § 7.3) : `pricing/models.json`, versionné, sourcé et daté,
 * modifiable par l'utilisateur (`PERSONAS_PRICING` impose un autre fichier). Prix en USD par million
 * de tokens. Un modèle absent donne un coût inconnu (`kind: "unknown"`), jamais un coût nul inventé.
 */

export const PRICING_FILE = join(PACKAGE_ROOT, "pricing", "models.json");

const modelPriceSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini"]),
  id: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  note: z.string().optional(),
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const pricingFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  currency: z.literal("USD"),
  unit: z.string().optional(),
  note: z.string().optional(),
  sources: z.record(z.string(), z.object({ url: z.string(), checkedAt: z.string(), note: z.string().optional() })),
  local: z.object({ providers: z.array(z.string()), note: z.string().optional() }).optional(),
  subscription: z.object({ providers: z.array(z.string()), priceAs: z.string(), note: z.string().optional() }).optional(),
  models: z.array(modelPriceSchema),
});
export type PricingFile = z.infer<typeof pricingFileSchema>;

let cached: { path: string; file: PricingFile } | null = null;

export function pricingPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PERSONAS_PRICING?.trim() || PRICING_FILE;
}

/** Fichier de prix introuvable (paquet incomplet, ou `PERSONAS_PRICING` vers un fichier absent). */
export class PricingFileMissingError extends Error {
  override name = "PricingFileMissingError";
  constructor(readonly path: string, readonly shipped: boolean) {
    super(
      shipped
        ? `Fichier de prix introuvable : ${path}. Il est livré avec Personas (pricing/models.json) : installation incomplète, réinstaller le paquet. Sans lui, aucun coût ni plafond ne peut être calculé.`
        : `Fichier de prix introuvable : ${path} (PERSONAS_PRICING). Corriger le chemin ou retirer la variable pour utiliser pricing/models.json.`,
    );
  }
}

/**
 * Table des prix. Échoue bruyamment si le fichier manque : une table vide rendrait tous les coûts
 * « inconnus » sans le dire, et les plafonds inopérants (bug B1 des tests V1).
 */
export function loadPricing(path = pricingPath()): PricingFile {
  if (cached?.path === path) return cached.file;
  if (!existsSync(path)) throw new PricingFileMissingError(path, path === PRICING_FILE);
  const file = pricingFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  cached = { path, file };
  return file;
}

/**
 * Tarification d'un modèle :
 * - `paid` : prix du fournisseur ;
 * - `subscription` : claude-cli, prix de l'API Anthropic équivalente, couvert par l'abonnement ;
 * - `local` : modèle local, coût 0 ;
 * - `unknown` : modèle absent de la table.
 */
export type Pricing =
  | { kind: "paid" | "subscription"; price: ModelPrice; source: string | null }
  | { kind: "local" }
  | { kind: "unknown"; model: string };

/** Normalisation d'un identifiant : minuscules, sans préfixe de fournisseur (`anthropic/…`, `models/…`), points en tirets. */
const norm = (id: string) => id.trim().toLowerCase().replace(/^.*\//, "").replace(/\./g, "-");
/** Suffixe d'instantané accepté après un identifiant connu : date, `-latest`. */
const SNAPSHOT = /^(-\d{4}-?\d{2}-?\d{2}|-latest|-\d{8})?$/;

function findPrice(file: PricingFile, model: string, providers: string[]): ModelPrice | null {
  const m = norm(model);
  let best: ModelPrice | null = null;
  let bestLen = -1;
  for (const p of file.models) {
    if (!providers.includes(p.provider)) continue;
    for (const key of [p.id, ...(p.aliases ?? [])]) {
      const k = norm(key);
      if (m.startsWith(k) && SNAPSHOT.test(m.slice(k.length)) && k.length > bestLen) {
        best = p;
        bestLen = k.length;
      }
    }
  }
  return best;
}

/** Adresse locale ou privée (serveur openai-compatible sur la machine ou le réseau local). */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return (
      h === "localhost" ||
      h.endsWith(".localhost") ||
      h.endsWith(".local") ||
      h === "::1" ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)
    );
  } catch {
    return false;
  }
}

/** Fournisseurs dont la table s'applique : le sien ; OpenRouter et serveur compatible distant : tous (prix du fournisseur d'origine). */
function priceProviders(provider: string): string[] {
  return provider === "anthropic" || provider === "openai" || provider === "gemini" ? [provider] : ["anthropic", "openai", "gemini"];
}

/**
 * Prix prudent d'un modèle au prix inconnu, quand l'utilisateur a accepté le coût inconnu (`--accept-unknown-cost`) :
 * pour chaque poste, le prix le plus élevé des modèles de la table pour ce fournisseur (tous les fournisseurs pour
 * OpenRouter ou un serveur compatible distant), sans remise de cache. Un modèle absent de la table est le plus
 * souvent un modèle récent, rarement moins cher que le haut de gamme connu : le plafond reste une borne haute
 * tant que le modèle n'est pas plus cher que le plus cher connu du fournisseur. Null si la table n'a aucun modèle
 * applicable (l'appel est alors refusé).
 */
export function prudentPrice(provider: ProviderKind | string, file: PricingFile = loadPricing()): ModelPrice | null {
  const rows = file.models.filter((p) => priceProviders(provider).includes(p.provider));
  if (!rows.length) return null;
  const input = Math.max(...rows.map((p) => p.input));
  const output = Math.max(...rows.map((p) => p.output));
  const cacheWrite = Math.max(input, ...rows.map((p) => p.cacheWrite ?? 0));
  return { provider: rows[0]!.provider, id: "prix-prudent", input, output, cacheRead: input, cacheWrite, note: `prix prudent : le plus cher de la table par poste (${rows.length} modèles)` };
}

export function pricingFor(provider: ProviderKind | string, model: string, opts: { baseUrl?: string | undefined; file?: PricingFile } = {}): Pricing {
  const file = opts.file ?? loadPricing();
  const src = (p: ModelPrice) => file.sources[p.provider]?.url ?? null;
  if (provider === "ollama" || (file.local?.providers ?? []).includes(provider)) return { kind: "local" };
  if (provider === "openai-compatible" && isLocalUrl(opts.baseUrl)) return { kind: "local" };
  if (provider === "claude-cli") {
    const p = findPrice(file, model, [file.subscription?.priceAs ?? "anthropic"]);
    return p ? { kind: "subscription", price: p, source: src(p) } : { kind: "unknown", model };
  }
  const p = findPrice(file, model, priceProviders(provider));
  return p ? { kind: "paid", price: p, source: src(p) } : { kind: "unknown", model };
}

/** Coût d'un usage (USD) au prix donné. `inputTokens` compte aussi les tokens lus et écrits en cache. */
export function usageCost(usage: Pick<Usage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">, price: ModelPrice): number {
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - read - write);
  const perM =
    fresh * price.input +
    read * (price.cacheRead ?? price.input) +
    write * (price.cacheWrite ?? price.input) +
    usage.outputTokens * price.output;
  return perM / 1_000_000;
}

/** Coût d'un usage selon la tarification : 0 en local, null si inconnu. */
export function pricedCost(usage: Pick<Usage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">, pricing: Pricing): number | null {
  if (pricing.kind === "local") return 0;
  if (pricing.kind === "unknown") return null;
  return usageCost(usage, pricing.price);
}

/** Fournisseurs facturés à l'usage (plafond par défaut, avertissements). */
export function isPaidProvider(provider: string, baseUrl?: string): boolean {
  if (provider === "claude-cli" || provider === "ollama") return false;
  if (provider === "openai-compatible") return !isLocalUrl(baseUrl);
  return true;
}
