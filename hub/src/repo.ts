import { and, asc, desc, eq, sql } from "drizzle-orm";
import { OFFICIAL_NAMESPACE, type CatalogModule, type CatalogResponse, HUB_API_VERSION } from "../../src/hub/contract";
import type { HubDb } from "../db/client";
import { moduleDeps, modules, moduleVersions, namespaces, packs, packVersions, UNLISTED_STATUSES, type VersionStatus } from "../db/schema";

/** Accès aux données du Hub (requêtes Drizzle, communes à Postgres et PGlite). */

export const iso = (t: string | Date) => new Date(t).toISOString();

export async function ensureNamespace(db: HubDb, slug: string): Promise<void> {
  await db
    .insert(namespaces)
    .values({ slug, verified: slug === OFFICIAL_NAMESPACE })
    .onConflictDoNothing();
}

export async function findModule(db: HubDb, ns: string, slug: string) {
  const [m] = await db
    .select()
    .from(modules)
    .where(and(eq(modules.namespace, ns), eq(modules.slug, slug)));
  return m ?? null;
}

/** Versions d'un module, de la plus ancienne à la plus récente. */
export async function moduleVersionRows(db: HubDb, moduleId: string) {
  return db.select().from(moduleVersions).where(eq(moduleVersions.moduleId, moduleId)).orderBy(asc(moduleVersions.publishedAt));
}

export async function findModuleVersion(db: HubDb, ns: string, slug: string, version: string | null) {
  const m = await findModule(db, ns, slug);
  if (!m) return null;
  const rows = await moduleVersionRows(db, m.id);
  const v = version === null ? rows.filter((r) => !UNLISTED_STATUSES.includes(r.status)).at(-1) : rows.find((r) => r.version === version);
  return v ? { module: m, version: v } : null;
}

const statusOf = (s: string) => s as VersionStatus;

/** Langue de chaque socle, d'après les manifestes des packs publiés (slug du pack, puis générateur). */
export type SocleLocales = Map<string, string>;

export async function socleLocales(db: HubDb): Promise<SocleLocales> {
  const rows = await db.select({ slug: packs.slug, generator: packs.generator, locale: packs.locale }).from(packs).orderBy(asc(packs.namespace), asc(packs.slug));
  const out: SocleLocales = new Map();
  for (const r of rows) if (!out.has(r.generator)) out.set(r.generator, r.locale);
  for (const r of rows) out.set(r.slug, r.locale);
  return out;
}

/** Langues d'un module : celles de ses socles (ordre de `applies_to`, sans doublon). */
export const moduleLocales = (appliesTo: string[], locales: SocleLocales): string[] => [...new Set(appliesTo.map((s) => locales.get(s)).filter((l): l is string => !!l))];

/** Champ `locale` (facultatif) d'une carte : langue du premier socle connu. */
const localeField = (appliesTo: string[], locales: SocleLocales | undefined): { locale?: string } => {
  const l = locales && moduleLocales(appliesTo, locales)[0];
  return l ? { locale: l } : {};
};

/** Carte de catalogue d'un module ; `includeYanked` pour la fiche directe (pas pour l'index). */
export function catalogModuleOf(m: typeof modules.$inferSelect, rows: Array<typeof moduleVersions.$inferSelect>, includeYanked: boolean, locales?: SocleLocales): CatalogModule | null {
  // Index : ni yanked, ni flagged, ni removed (phase 3) ; fiche directe : toutes les versions
  const visible = includeYanked ? rows : rows.filter((r) => !UNLISTED_STATUSES.includes(r.status));
  const live = rows.filter((r) => !UNLISTED_STATUSES.includes(r.status));
  const latest = (live.length ? live : rows).at(-1);
  if (!visible.length || !latest) return null;
  return {
    ref: `${m.namespace}/${m.slug}`,
    label: latest.label,
    description: latest.description,
    appliesTo: latest.appliesTo,
    ...localeField(latest.appliesTo, locales),
    tags: latest.tags,
    attributes: latest.attributes,
    latest: latest.version,
    versions: visible.map((r) => ({ version: r.version, sha256: r.sha256, publishedAt: iso(r.publishedAt), status: statusOf(r.status), quality: r.quality ?? null })),
  };
}

/** Index complet du catalogue (modules non retirés, packs). `generatedAt` = dernière publication (ETag stable). */
export async function buildCatalog(db: HubDb): Promise<CatalogResponse> {
  const mods = await db.select().from(modules).orderBy(asc(modules.namespace), asc(modules.slug));
  const locales = await socleLocales(db);
  const versions = await db.select().from(moduleVersions).orderBy(asc(moduleVersions.publishedAt));
  const byModule = new Map<string, Array<typeof moduleVersions.$inferSelect>>();
  for (const v of versions) byModule.set(v.moduleId, [...(byModule.get(v.moduleId) ?? []), v]);
  const outModules = mods
    .filter((m) => m.status !== "hidden")
    .map((m) => catalogModuleOf(m, byModule.get(m.id) ?? [], false, locales))
    .filter((x): x is CatalogModule => x !== null);

  const pks = await db.select().from(packs).orderBy(asc(packs.namespace), asc(packs.slug));
  const pvs = await db
    .select({ packId: packVersions.packId, version: packVersions.version, sha256: packVersions.sha256, publishedAt: packVersions.publishedAt, extends: packVersions.extends, status: packVersions.status })
    .from(packVersions)
    .orderBy(asc(packVersions.publishedAt));
  const outPacks = pks.flatMap((p) => {
    const vs = pvs.filter((v) => v.packId === p.id && !UNLISTED_STATUSES.includes(v.status));
    if (!vs.length) return [];
    return [{ ref: `${p.namespace}/${p.slug}`, label: p.label, country: p.country, locale: p.locale, generator: p.generator, latest: vs.at(-1)!.version, versions: vs.map((v) => ({ version: v.version, sha256: v.sha256, publishedAt: iso(v.publishedAt), extends: v.extends })) }];
  });

  const stamps = [...versions.map((v) => v.publishedAt), ...pvs.map((v) => v.publishedAt)].map((t) => new Date(t).getTime());
  return {
    apiVersion: HUB_API_VERSION,
    generatedAt: new Date(stamps.length ? Math.max(...stamps) : 0).toISOString(),
    modules: outModules,
    packs: outPacks,
  };
}

export async function moduleDepsOf(db: HubDb, versionId: string) {
  return db.select().from(moduleDeps).where(eq(moduleDeps.versionId, versionId));
}

export async function findPack(db: HubDb, ns: string, slug: string) {
  const [p] = await db
    .select()
    .from(packs)
    .where(and(eq(packs.namespace, ns), eq(packs.slug, slug)));
  return p ?? null;
}

export async function findPackVersion(db: HubDb, ns: string, slug: string, version: string) {
  const p = await findPack(db, ns, slug);
  if (!p) return null;
  const [v] = await db
    .select()
    .from(packVersions)
    .where(and(eq(packVersions.packId, p.id), eq(packVersions.version, version)));
  return v ? { pack: p, version: v } : null;
}

/** Version de pack d'un namespace par sa seule chaîne de version (`fr-2026.1`), ou `ns/slug@version`. */
export async function findPackVersionByRef(db: HubDb, ns: string, ref: string) {
  const m = /^([a-z0-9-]+)\/([a-z0-9][a-z0-9-]*)@(.+)$/.exec(ref);
  if (m) return findPackVersion(db, m[1]!, m[2]!, m[3]!);
  const rows = await db
    .select({ pack: packs, version: packVersions })
    .from(packVersions)
    .innerJoin(packs, eq(packs.id, packVersions.packId))
    .where(and(eq(packs.namespace, ns), eq(packVersions.version, ref)));
  return rows[0] ?? null;
}

export interface SearchHit {
  ref: string;
  latest: string;
  label: string;
  description: string;
  appliesTo: string[];
  /** Langue du premier socle du module (facultatif : socle sans pack publié). */
  locale?: string;
  q: number | null;
  score: number;
}

/**
 * Recherche plein texte (tsvector french + english) sur la dernière version non retirée de chaque
 * module ; filtre de socle ; tri par Q puis pertinence. Sans requête : tout le catalogue, trié par Q.
 */
export async function searchModules(db: HubDb, opts: { q: string; socle?: string; lang?: string; limit: number }): Promise<SearchHit[]> {
  const q = opts.q.trim();
  const locales = await socleLocales(db);
  // Filtre de langue : socles dont le pack publié est dans cette langue
  const langSocles = opts.lang ? [...locales].filter(([, l]) => l === opts.lang).map(([s]) => s) : null;
  if (langSocles && !langSocles.length) return [];
  const tsq = sql`(websearch_to_tsquery('french', ${q}) || websearch_to_tsquery('english', ${q}))`;
  // Dernière version non retirée par module (published_at maximal)
  const latest = db
    .select({ moduleId: moduleVersions.moduleId, at: sql<string>`max(${moduleVersions.publishedAt})`.as("at") })
    .from(moduleVersions)
    .where(sql`${moduleVersions.status} not in ('yanked', 'flagged', 'removed')`)
    .groupBy(moduleVersions.moduleId)
    .as("latest");
  const rank = q ? sql<number>`ts_rank_cd(${moduleVersions.search}, ${tsq})` : sql<number>`0::float8`;
  const qcol = sql<number | null>`(${moduleVersions.quality} ->> 'q')::float8`;
  const conds = [sql`${modules.status} <> 'hidden'`];
  if (q) conds.push(sql`${moduleVersions.search} @@ ${tsq}`);
  if (opts.socle) conds.push(sql`${opts.socle} = any(${moduleVersions.appliesTo})`);
  if (langSocles) conds.push(sql`${moduleVersions.appliesTo} && array[${sql.join(langSocles.map((s) => sql`${s}`), sql`, `)}]::text[]`);
  const rows = await db
    .select({
      namespace: modules.namespace,
      slug: modules.slug,
      latest: moduleVersions.version,
      label: moduleVersions.label,
      description: moduleVersions.description,
      appliesTo: moduleVersions.appliesTo,
      q: qcol,
      score: rank,
    })
    .from(moduleVersions)
    .innerJoin(latest, and(eq(latest.moduleId, moduleVersions.moduleId), eq(latest.at, moduleVersions.publishedAt)))
    .innerJoin(modules, eq(modules.id, moduleVersions.moduleId))
    .where(and(...conds))
    .orderBy(sql`${qcol} desc nulls last`, desc(rank), asc(modules.namespace), asc(modules.slug))
    .limit(opts.limit);
  return rows.map((r) => ({ ref: `${r.namespace}/${r.slug}`, latest: r.latest, label: r.label, description: r.description, appliesTo: r.appliesTo, ...localeField(r.appliesTo, locales), q: r.q === null ? null : Number(r.q), score: Math.round(Number(r.score) * 10_000) / 10_000 }));
}
