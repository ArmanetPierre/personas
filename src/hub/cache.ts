import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../config";
import { z } from "zod";
import { catalogModuleV3, catalogResponse, type CatalogResponse, type QualityScore, type VersionSignature } from "./contract";

/** Catalogue avec les champs additifs de la phase 3 (classement R : étoiles, avis, badges, filiation). */
export const catalogResponseV3 = catalogResponse.extend({ modules: z.array(catalogModuleV3) });
export type CatalogResponseV3 = z.infer<typeof catalogResponseV3>;

/**
 * Cache local du Hub (docs/plateforme.md § 2.4) : copies vérifiées des objets publics téléchargés.
 *
 *   <dossier de données>/hub-cache/
 *     catalog.json, catalog.meta.json                  index du catalogue (+ ETag, URL du Hub, date)
 *     modules/<ns>/<slug>/<version>/module.yaml        texte YAML exact publié
 *     modules/<ns>/<slug>/<version>/_hub.json          métadonnées (sha256 du contrat, statut, Q, dépendances)
 *     packs/<ns>/<slug>/<version>/<fichier>.json       tables du pack, texte exact
 *     packs/<ns>/<slug>/<version>/_hub.json
 *
 * Tout contenu est revérifié par son sha256 (celui du contrat, enregistré au téléchargement) avant usage :
 * un cache altéré est refusé, jamais utilisé en silence. Les versions sont immuables : une version déjà en
 * cache n'est jamais réécrite avec un autre contenu.
 *
 * Une version incomplète (métadonnées illisibles, ou fichier attendu absent : `module.yaml`, `pack.json`, ou une
 * table listée dans `files` des métadonnées d'un pack) n'est pas en cache : elle est ignorée et un nouveau
 * `personas hub pull` la télécharge de nouveau. Seul un contenu présent dont le sha256 diffère est « altéré ».
 */

export class HubIntegrityError extends Error {
  override name = "HubIntegrityError";
}

/** Fichier des métadonnées d'une version en cache (préfixe « _ » : jamais un nom de table de pack). */
export const META_FILE = "_hub.json";

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
/** Nom de fichier de pack admis (pas de chemin, pas de « .. ») : tables JSON. */
export const SAFE_PACK_FILE = /^[a-z0-9][a-z0-9._-]*\.json$/;

/**
 * Dossier du cache : `PERSONAS_HUB_CACHE_DIR`, sinon `hub-cache/` à côté de la base (dossier de données).
 * Sous vitest, sans `PERSONAS_HUB_CACHE_DIR`, pas de cache (aucun test ne lit le cache réel de l'utilisateur).
 */
export function hubCacheDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const forced = env.PERSONAS_HUB_CACHE_DIR?.trim();
  if (forced) return resolve(forced);
  if (env.VITEST) return null;
  return join(dirname(resolve(loadConfig(env).DATABASE_PATH)), "hub-cache");
}

export const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Empreinte d'un pack (contrat) : noms triés, concaténation de « nom\n » + contenu + « \n ». */
export function packFilesSha256(files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const name of Object.keys(files).sort()) h.update(`${name}\n`, "utf8").update(files[name]!, "utf8").update("\n", "utf8");
  return h.digest("hex");
}

function checkSegments(ns: string, slug: string, version: string): void {
  if (!SAFE_SEGMENT.test(ns) || !SAFE_SEGMENT.test(slug)) throw new HubIntegrityError(`Référence refusée pour le cache : ${ns}/${slug}`);
  if (!SAFE_VERSION.test(version)) throw new HubIntegrityError(`Version refusée pour le cache : ${version}`);
}

/** Écrit un dossier de version complet, puis le met en place d'un coup (pas de version à moitié écrite). */
function writeVersionDir(target: string, files: Record<string, string>): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(tmp, name), text);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  renameSync(tmp, target);
}

/** Métadonnées d'une version en cache ; null si le fichier manque ou est illisible. */
function readMeta<T>(dir: string): T | null {
  const file = join(dir, META_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Version de module complète : métadonnées lisibles et `module.yaml` présent. */
function moduleDirComplete(dir: string): boolean {
  return readMeta<CachedModuleMeta>(dir) !== null && existsSync(join(dir, "module.yaml"));
}

/** Version de pack complète : métadonnées lisibles, `pack.json` et toutes les tables listées présents. */
function packDirComplete(dir: string): boolean {
  const meta = readMeta<CachedPackMeta>(dir);
  if (!meta || !existsSync(join(dir, "pack.json"))) return false;
  return (meta.files ?? []).every((name) => SAFE_PACK_FILE.test(name) && existsSync(join(dir, name)));
}

function listVersions(root: string, complete: (dir: string) => boolean): Array<{ namespace: string; slug: string; version: string; dir: string }> {
  const out: Array<{ namespace: string; slug: string; version: string; dir: string }> = [];
  if (!existsSync(root)) return out;
  for (const ns of readdirSync(root, { withFileTypes: true })) {
    if (!ns.isDirectory() || !SAFE_SEGMENT.test(ns.name)) continue;
    for (const slug of readdirSync(join(root, ns.name), { withFileTypes: true })) {
      if (!slug.isDirectory() || !SAFE_SEGMENT.test(slug.name)) continue;
      for (const v of readdirSync(join(root, ns.name, slug.name), { withFileTypes: true })) {
        if (!v.isDirectory() || !SAFE_VERSION.test(v.name) || v.name.includes(".tmp-")) continue;
        const dir = join(root, ns.name, slug.name, v.name);
        if (complete(dir)) out.push({ namespace: ns.name, slug: slug.name, version: v.name, dir });
      }
    }
  }
  return out;
}

// ─── Modules ────────────────────────────────────────────────────────────────

export interface CachedModuleMeta {
  /** Référence qualifiée `ns/slug`. */
  ref: string;
  version: string;
  sha256: string;
  status: string;
  license: string;
  quality: QualityScore | null;
  publishedAt: string;
  requires: Array<{ ref: string; version: string; as: string }>;
  fetchedAt: string;
  hubUrl: string;
  /** Signature Ed25519 du Hub, si la version en porte une (vérifiée au téléchargement). */
  signature?: VersionSignature | null;
  /** Filiation d'un fork. */
  forkedFrom?: { ref: string; version: string } | null;
}

export const moduleVersionDir = (cacheDir: string, ns: string, slug: string, version: string) => {
  checkSegments(ns, slug, version);
  return join(cacheDir, "modules", ns, slug, version);
};

export function listCachedModules(cacheDir: string) {
  return listVersions(join(cacheDir, "modules"), moduleDirComplete);
}

/** Version présente et complète dans le cache (une version incomplète est à télécharger de nouveau). */
export function hasCachedModule(cacheDir: string, ns: string, slug: string, version: string): boolean {
  return moduleDirComplete(moduleVersionDir(cacheDir, ns, slug, version));
}

/**
 * Texte YAML d'une version en cache, vérifié par son sha256 ; null si absente ou incomplète (à télécharger de
 * nouveau). Lève si le contenu a changé.
 */
export function readCachedModule(cacheDir: string, ns: string, slug: string, version: string): { text: string; meta: CachedModuleMeta; file: string } | null {
  const dir = moduleVersionDir(cacheDir, ns, slug, version);
  const metaFile = join(dir, META_FILE);
  const file = join(dir, "module.yaml");
  if (!existsSync(metaFile) || !existsSync(file)) return null;
  const meta = readMeta<CachedModuleMeta>(dir);
  if (!meta) return null;
  const text = readFileSync(file, "utf8");
  const sha = sha256Text(text);
  if (sha !== meta.sha256) {
    throw new HubIntegrityError(`Cache du Hub altéré : ${ns}/${slug}@${version} (sha256 ${sha.slice(0, 12)}… au lieu de ${meta.sha256.slice(0, 12)}…). Supprimer ${dir} puis relancer personas hub pull.`);
  }
  return { text, meta, file };
}

export function writeCachedModule(cacheDir: string, meta: CachedModuleMeta, text: string): string {
  const [ns, slug] = meta.ref.split("/") as [string, string];
  if (sha256Text(text) !== meta.sha256) throw new HubIntegrityError(`Empreinte incohérente pour ${meta.ref}@${meta.version} : rien n'est écrit dans le cache.`);
  const dir = moduleVersionDir(cacheDir, ns, slug, meta.version);
  const prev = readMeta<CachedModuleMeta>(dir);
  if (prev && prev.sha256 !== meta.sha256) {
    throw new HubIntegrityError(`Version immuable modifiée sur le Hub : ${meta.ref}@${meta.version} (sha256 en cache ${prev.sha256.slice(0, 12)}…, reçu ${meta.sha256.slice(0, 12)}…). Rien n'est remplacé.`);
  }
  writeVersionDir(dir, { "module.yaml": text, [META_FILE]: `${JSON.stringify(meta, null, 1)}\n` });
  return dir;
}

// ─── Packs ──────────────────────────────────────────────────────────────────

export interface CachedPackMeta {
  ref: string;
  version: string;
  sha256: string;
  extends: string | null;
  license: string;
  fetchedAt: string;
  hubUrl: string;
  /** Tables du pack (noms triés), pour reconnaître une copie incomplète ; absent des caches plus anciens. */
  files?: string[];
}

export const packVersionDir = (cacheDir: string, ns: string, slug: string, version: string) => {
  checkSegments(ns, slug, version);
  return join(cacheDir, "packs", ns, slug, version);
};

export function listCachedPacks(cacheDir: string) {
  return listVersions(join(cacheDir, "packs"), packDirComplete);
}

/** Version de pack présente et complète dans le cache. */
export function hasCachedPack(cacheDir: string, ns: string, slug: string, version: string): boolean {
  return packDirComplete(packVersionDir(cacheDir, ns, slug, version));
}

/** Fichiers d'un dossier de pack (tables JSON), hors métadonnées du cache. */
export function packDirFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) if (SAFE_PACK_FILE.test(name)) files[name] = readFileSync(join(dir, name), "utf8");
  return files;
}

/** Vérifie une version de pack en cache (sha256 des fichiers) ; renvoie son dossier et ses métadonnées. */
export function verifyCachedPack(dir: string): CachedPackMeta {
  const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8")) as CachedPackMeta;
  const sha = packFilesSha256(packDirFiles(dir));
  if (sha !== meta.sha256) {
    throw new HubIntegrityError(`Cache du Hub altéré : pack ${meta.ref}@${meta.version} (sha256 ${sha.slice(0, 12)}… au lieu de ${meta.sha256.slice(0, 12)}…). Supprimer ${dir} puis relancer personas hub pull --pack.`);
  }
  return meta;
}

export function writeCachedPack(cacheDir: string, meta: CachedPackMeta, files: Record<string, string>): string {
  const [ns, slug] = meta.ref.split("/") as [string, string];
  for (const name of Object.keys(files)) if (!SAFE_PACK_FILE.test(name)) throw new HubIntegrityError(`Nom de fichier de pack refusé : ${name}`);
  if (!files["pack.json"]) throw new HubIntegrityError(`Pack ${meta.ref}@${meta.version} sans pack.json : refusé.`);
  if (packFilesSha256(files) !== meta.sha256) throw new HubIntegrityError(`Empreinte incohérente pour le pack ${meta.ref}@${meta.version} : rien n'est écrit dans le cache.`);
  const dir = packVersionDir(cacheDir, ns, slug, meta.version);
  writeVersionDir(dir, { ...files, [META_FILE]: `${JSON.stringify({ ...meta, files: Object.keys(files).sort() }, null, 1)}\n` });
  return dir;
}

// ─── Catalogue ──────────────────────────────────────────────────────────────

export interface CatalogMeta {
  etag: string | null;
  hubUrl: string;
  fetchedAt: string;
}

/** Catalogue téléchargé au dernier `hub sync` (null s'il n'y en a pas, ou s'il est illisible). */
export function readCachedCatalog(cacheDir: string | null = hubCacheDir()): { catalog: CatalogResponseV3; meta: CatalogMeta } | null {
  if (!cacheDir) return null;
  const file = join(cacheDir, "catalog.json");
  if (!existsSync(file)) return null;
  try {
    const catalog = catalogResponseV3.parse(JSON.parse(readFileSync(file, "utf8")));
    const metaFile = join(cacheDir, "catalog.meta.json");
    const meta = existsSync(metaFile) ? (JSON.parse(readFileSync(metaFile, "utf8")) as CatalogMeta) : { etag: null, hubUrl: "", fetchedAt: catalog.generatedAt };
    return { catalog, meta };
  } catch {
    return null;
  }
}

export function writeCachedCatalog(cacheDir: string, catalog: CatalogResponse, meta: CatalogMeta): void {
  mkdirSync(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `catalog.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(catalog)}\n`);
  renameSync(tmp, join(cacheDir, "catalog.json"));
  writeFileSync(join(cacheDir, "catalog.meta.json"), `${JSON.stringify(meta, null, 1)}\n`);
}
