import { asc, eq, gte, sql } from "drizzle-orm";
import { OFFICIAL_NAMESPACE, R_WEIGHTS, REVIEW_PRIOR, type CatalogModule, type CatalogResponse } from "../../src/hub/contract";
import type { HubDb } from "../db/client";
import { modules, moduleVersions, reviews, UNLISTED_STATUSES, usageDaily, type VersionStatus } from "../db/schema";
import { moduleLocales, searchModules, socleLocales, type SearchHit, type SocleLocales } from "./repo";

/**
 * Classement R (docs/plateforme.md § 5.2) :
 *
 *   R = 0,45·(Q/100) + 0,25·U + 0,15·E + 0,15·N  (+ 0,05 si la dernière version est vérifiée)
 *
 * - U : log(1 + installations-jours sur 90 jours) / log(1 + maximum du catalogue) ; source : télémétrie
 *   acceptée (usage_daily.installs, installations distinctes par jour, sommées sur 90 jours).
 * - E : même normalisation logarithmique sur le nombre d'étoiles.
 * - N : moyenne bayésienne des avis (non masqués, toutes versions) (C·m + Σ notes) / (C + n), m = 3,
 *   C = 5, ramenée sur [0, 1] par (x − 1) / 4. Sans avis : 0,5.
 * Le maximum « de la catégorie » est pris sur tout le catalogue listé (pas encore de catégories).
 */

export interface ModuleRanking {
  r: number;
  components: { q: number; u: number; e: number; n: number; verifiedBonus: number };
  stars: number;
  reviews: { count: number; mean: number | null };
  usage90: number;
  status: VersionStatus;
  badges: Array<"official" | "verified" | "unverified" | "sensitive" | "fork">;
  forkedFrom: { ref: string; version: string } | null;
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const logNorm = (x: number, max: number) => (max > 0 ? Math.log1p(x) / Math.log1p(max) : 0);

export function bayesianReviewScore(count: number, sum: number): number {
  const mean = (REVIEW_PRIOR.c * REVIEW_PRIOR.m + sum) / (REVIEW_PRIOR.c + count);
  return (mean - 1) / 4;
}

export function rankScore(x: { q: number | null; usage90: number; stars: number; reviewCount: number; reviewSum: number; verified: boolean }, max: { usage90: number; stars: number }) {
  const q = (x.q ?? 0) / 100;
  const u = logNorm(x.usage90, max.usage90);
  const e = logNorm(x.stars, max.stars);
  const n = bayesianReviewScore(x.reviewCount, x.reviewSum);
  const verifiedBonus = x.verified ? R_WEIGHTS.verifiedBonus : 0;
  const r = R_WEIGHTS.q * q + R_WEIGHTS.usage * u + R_WEIGHTS.stars * e + R_WEIGHTS.reviews * n + verifiedBonus;
  return { r: round(r), components: { q: round(q), u: round(u), e: round(e), n: round(n), verifiedBonus } };
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

/** Classement de chaque module listé, par référence `ns/slug`. */
export async function moduleRankings(db: HubDb): Promise<Map<string, ModuleRanking>> {
  const mods = await db.select().from(modules);
  const versions = await db
    .select({ id: moduleVersions.id, moduleId: moduleVersions.moduleId, version: moduleVersions.version, status: moduleVersions.status, quality: moduleVersions.quality, sensitive: moduleVersions.sensitive })
    .from(moduleVersions)
    .orderBy(asc(moduleVersions.publishedAt));
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const usage = await db
    .select({ moduleId: moduleVersions.moduleId, n: sql<string>`coalesce(sum(${usageDaily.installs}), 0)` })
    .from(usageDaily)
    .innerJoin(moduleVersions, eq(moduleVersions.id, usageDaily.versionId))
    .where(gte(usageDaily.day, since))
    .groupBy(moduleVersions.moduleId);
  const revs = rowsOf<{ module_id: string; n: string | number; s: string | number }>(
    await db.execute(
      sql`select mv.module_id, count(*) as n, coalesce(sum(r.rating), 0) as s from ${reviews} r join ${moduleVersions} mv on mv.id = r.version_id where not r.hidden group by mv.module_id`,
    ),
  );
  const usageBy = new Map(usage.map((u) => [u.moduleId, Number(u.n)]));
  const revBy = new Map(revs.map((r) => [r.module_id, { n: Number(r.n), s: Number(r.s) }]));
  const byId = new Map(versions.map((v) => [v.id, v]));
  const modById = new Map(mods.map((m) => [m.id, m]));
  const latestBy = new Map<string, (typeof versions)[number]>();
  for (const v of versions) if (!UNLISTED_STATUSES.includes(v.status)) latestBy.set(v.moduleId, v);

  const listed = mods.filter((m) => m.status !== "hidden" && latestBy.has(m.id));
  const max = { usage90: Math.max(0, ...listed.map((m) => usageBy.get(m.id) ?? 0)), stars: Math.max(0, ...listed.map((m) => m.starCount)) };
  const out = new Map<string, ModuleRanking>();
  for (const m of mods) {
    const latest = latestBy.get(m.id) ?? versions.filter((v) => v.moduleId === m.id).at(-1);
    if (!latest) continue;
    const rv = revBy.get(m.id) ?? { n: 0, s: 0 };
    const usage90 = usageBy.get(m.id) ?? 0;
    const origin = m.forkedFromVersionId ? byId.get(m.forkedFromVersionId) : undefined;
    const originMod = origin ? modById.get(origin.moduleId) : undefined;
    const forkedFrom = origin && originMod ? { ref: `${originMod.namespace}/${originMod.slug}`, version: origin.version } : null;
    const score = rankScore({ q: latest.quality?.q ?? null, usage90, stars: m.starCount, reviewCount: rv.n, reviewSum: rv.s, verified: latest.status === "verified" }, max);
    const badges: ModuleRanking["badges"] = [];
    if (m.namespace === OFFICIAL_NAMESPACE) badges.push("official");
    if (latest.status === "verified") badges.push("verified");
    if (latest.status === "unverified") badges.push("unverified");
    if (latest.sensitive.length) badges.push("sensitive");
    if (forkedFrom) badges.push("fork");
    out.set(`${m.namespace}/${m.slug}`, {
      ...score,
      stars: m.starCount,
      reviews: { count: rv.n, mean: rv.n ? round(rv.s / rv.n, 2) : null },
      usage90,
      status: latest.status,
      badges,
      forkedFrom,
    });
  }
  return out;
}

export type RankedHit = SearchHit & { ranking?: ModuleRanking };

/**
 * Mise en avant d'une langue (décision du 2026-10-20) : les modules dont un socle est dans la
 * langue `prefer` passent devant, les autres suivent ; l'ordre choisi (R ou Q) est conservé dans chaque
 * groupe (partition stable). Ce n'est pas un filtre : rien n'est retiré. Sans `prefer`, ordre inchangé.
 */
export function preferLanguage<T extends { appliesTo: string[] }>(items: readonly T[], prefer: string | undefined, locales: SocleLocales): T[] {
  if (!prefer) return [...items];
  const first: T[] = [];
  const rest: T[] = [];
  for (const it of items) (moduleLocales(it.appliesTo, locales).includes(prefer) ? first : rest).push(it);
  return [...first, ...rest];
}

/**
 * Recherche plein texte (repo.searchModules), puis tri par R (défaut) ou par Q. `prefer` (facultatif) :
 * langue mise en avant avant la troncature à `limit` (voir preferLanguage).
 */
export async function rankedSearch(db: HubDb, opts: { q: string; socle?: string; lang?: string; limit: number; sort?: "r" | "q"; prefer?: string }): Promise<RankedHit[]> {
  const hits = await searchModules(db, { ...opts, limit: 10_000 });
  const ranks = await moduleRankings(db);
  const out: RankedHit[] = hits.map((h) => {
    const ranking = ranks.get(h.ref);
    return ranking ? { ...h, ranking } : h;
  });
  if ((opts.sort ?? "r") === "r") out.sort((a, b) => (b.ranking?.r ?? 0) - (a.ranking?.r ?? 0) || (b.q ?? -1) - (a.q ?? -1) || b.score - a.score || a.ref.localeCompare(b.ref));
  const ordered = opts.prefer ? preferLanguage(out, opts.prefer, await socleLocales(db)) : out;
  return ordered.slice(0, opts.limit);
}

/** Catalogue trié par R (tri par défaut), chaque carte avec son classement. */
export async function rankCatalog(db: HubDb, cat: CatalogResponse): Promise<CatalogResponse> {
  const ranks = await moduleRankings(db);
  const mods = cat.modules.map((m): CatalogModule & { ranking?: ModuleRanking } => {
    const ranking = ranks.get(m.ref);
    return ranking ? { ...m, ranking } : m;
  });
  mods.sort((a, b) => (b.ranking?.r ?? 0) - (a.ranking?.r ?? 0) || a.ref.localeCompare(b.ref));
  return { ...cat, modules: mods };
}
