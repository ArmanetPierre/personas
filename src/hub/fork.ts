import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { invalidateModuleLibraries, moduleLibrary, modulesRoot } from "../modules/registry";
import { parseModuleSpec } from "../modules/refs";
import { hubCacheDir, readCachedModule } from "./cache";
import type { HubClient, UserPublishResult } from "./client";
import { pullModule, type PullResult } from "./pull";

/**
 * Fork d'un module (`personas hub fork <ns/slug>[@version]`) : le Hub copie la version dans le namespace du compte
 * (POST /v1/modules/:ns/:slug/fork, filiation `forkedFrom`) ; la copie est téléchargée dans le cache (sha256,
 * signature et lint vérifiés), puis une **copie éditable** est écrite dans la bibliothèque locale
 * (`modules/<id>/module.yaml`) sous un nouvel id, avec `forked_from: <origine>@<version>`. Elle se modifie et se
 * republie ensuite comme un module local (`personas hub publish <id>`), sous la même référence `<compte>/<id>`.
 */

export interface ForkResult {
  /** Fork sur le Hub (namespace du compte). */
  hub: UserPublishResult;
  pulled: PullResult[];
  /** Id local de la copie éditable. */
  localId: string;
  file: string;
  forkedFrom: string;
}

const LOCAL_ID = /^[a-z][a-z0-9-]*$/;

/** Id local libre : celui demandé, sinon le slug d'origine, sinon `<slug>-fork`. */
export function forkLocalId(slug: string, wanted: string | undefined, taken: (id: string) => boolean): string {
  if (wanted) {
    if (!LOCAL_ID.test(wanted)) throw new Error(`Id invalide : ${wanted} (minuscules, chiffres et tirets).`);
    if (taken(wanted)) throw new Error(`Le module ${wanted} existe déjà dans modules/ : choisir un autre id (--as).`);
    return wanted;
  }
  for (const id of [slug, `${slug}-fork`, ...Array.from({ length: 8 }, (_, i) => `${slug}-fork-${i + 2}`)]) if (!taken(id)) return id;
  throw new Error(`Aucun id libre pour le fork de ${slug} : préciser --as <id>.`);
}

export async function forkModule(client: HubClient, spec: string, opts: { token: string; as?: string; cacheDir?: string | null; modulesDir?: string }): Promise<ForkResult> {
  const s = parseModuleSpec(spec);
  const origin = `${s.namespace}/${s.slug}`;
  const dir = opts.modulesDir ?? modulesRoot();
  const lib = moduleLibrary(dir, { fresh: true });
  const taken = (id: string) => lib.has(id) || existsSync(resolve(dir, id));
  const localId = forkLocalId(s.slug, opts.as, taken);
  // Le slug du fork sur le Hub est l'id local : la copie se republie sous la même référence.
  const hub = await client.forkModule({ ref: origin, ...(s.version && { version: s.version }), slug: localId }, opts.token);
  const cacheDir = opts.cacheDir === undefined ? hubCacheDir() : opts.cacheDir;
  const pulled = await pullModule(client, `${hub.ref}@${hub.version}`, { cacheDir });
  const [ns, slug] = hub.ref.split("/") as [string, string];
  const cached = cacheDir ? readCachedModule(cacheDir, ns, slug, hub.version) : null;
  if (!cached) throw new Error(`Fork ${hub.ref}@${hub.version} absent du cache après téléchargement.`);
  const forkedFrom = hub.forkedFrom ? `${hub.forkedFrom.ref}@${hub.forkedFrom.version}` : `${origin}${s.version ? `@${s.version}` : ""}`;
  const doc = parseDocument(cached.text);
  doc.set("id", localId);
  doc.set("forked_from", forkedFrom);
  const file = resolve(dir, localId, "module.yaml");
  mkdirSync(resolve(dir, localId), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, file);
  invalidateModuleLibraries();
  return { hub, pulled, localId, file, forkedFrom };
}
