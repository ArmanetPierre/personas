import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { hubCacheDir, listCachedPacks, packDirFiles, packFilesSha256, verifyCachedPack } from "../hub/cache";
import { PACKS_DIR } from "./pack-common";

/**
 * Où lire un pack : `packs/` du dépôt (ou du paquet installé), puis le cache du Hub
 * (`hub-cache/packs/<ns>/<slug>/<version>/`, contenu vérifié par sha256 avant usage). Ordre de recherche d'une
 * clé (nom de dossier, ou version d'un manifeste ; c'est aussi la valeur de `extends`) :
 *  1. `packs/<clé>/` (comportement historique, inchangé) ;
 *  2. un dossier de `packs/` dont le manifeste porte cette version (`fr-2026.1` → `packs/fr`) ;
 *  3. une version en cache dont le nom est la clé (`sg-2026.3`) ;
 *  4. la version racine en cache (sans `extends`) d'un pack dont le slug est la clé (`sg`).
 * Ainsi un pack téléchargé se charge comme un pack du dépôt, héritage `extends` compris.
 */

export interface PackSource {
  dir: string;
  source: "local" | "hub-cache";
  /** Référence qualifiée (cache du Hub) ; `personas/<pays>` pour un pack local. */
  ref?: string;
  /** sha256 des fichiers du pack (contrat : noms triés, « nom\n » + contenu + « \n »). */
  sha256?: string;
}

const found = new Map<string, PackSource | null>();

function manifestVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** Source d'un pack, ou null s'il est introuvable. */
export function findPack(key: string, cacheDir: string | null = hubCacheDir()): PackSource | null {
  const k = `${cacheDir ?? ""}\0${key}`;
  if (found.has(k)) return found.get(k)!;
  let hit: PackSource | null = null;
  const direct = resolve(PACKS_DIR, key);
  if (existsSync(join(direct, "pack.json"))) hit = { dir: direct, source: "local" };
  if (!hit && existsSync(PACKS_DIR)) {
    for (const d of readdirSync(PACKS_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && manifestVersion(join(PACKS_DIR, d.name)) === key) {
        hit = { dir: join(PACKS_DIR, d.name), source: "local" };
        break;
      }
    }
  }
  if (!hit && cacheDir) {
    const versions = listCachedPacks(cacheDir);
    const pick = versions.find((v) => v.version === key) ?? versions.find((v) => v.slug === key && verifyCachedPack(v.dir).extends === null);
    if (pick) {
      const meta = verifyCachedPack(pick.dir);
      hit = { dir: pick.dir, source: "hub-cache", ref: meta.ref, sha256: meta.sha256 };
    }
  }
  found.set(k, hit);
  return hit;
}

/** Dossier d'un pack ; lève une erreur lisible s'il est introuvable. */
export function packDir(key: string): string {
  const hit = findPack(key);
  if (!hit) throw new Error(`Pack ${key} introuvable (ni dans packs/ ni dans le cache du Hub : personas hub pull --pack <ref>@${key})`);
  if (hit.source === "hub-cache") verifyCachedPack(hit.dir); // revérifié à chaque chargement
  return hit.dir;
}

/** sha256 d'un pack (ses propres fichiers JSON, sans ceux de la base `extends`), au format du contrat. */
export function packSha256(key: string): string | undefined {
  const hit = findPack(key);
  if (!hit) return undefined;
  return hit.sha256 ?? packFilesSha256(packDirFiles(hit.dir));
}

/**
 * Nom de socle d'un pack racine (sans `extends`), celui des `applies_to` des modules : le nom de dossier pour
 * un pack local (`fr`, `sg`), le slug de la référence pour un pack du cache (`personas/sg` → `sg`).
 */
export function packSocle(key: string): string {
  const hit = findPack(key);
  if (!hit) return key;
  return hit.source === "hub-cache" && hit.ref ? hit.ref.slice(hit.ref.indexOf("/") + 1) : basename(hit.dir);
}

/** Oublie les emplacements trouvés (après un téléchargement dans le cache). */
export function invalidatePackSources(): void {
  found.clear();
}
