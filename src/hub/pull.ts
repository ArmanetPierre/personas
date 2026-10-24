import { rmSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { formatIssues, lintModule } from "../modules/lint";
import { checkModule, invalidateModuleLibraries, moduleAt, ModuleError, moduleLibrary } from "../modules/registry";
import { parseModuleSpec } from "../modules/refs";
import { GENERATORS } from "../personas/pack-common";
import { findPack, invalidatePackSources } from "../personas/pack-source";
import { hubCacheDir, HubIntegrityError, packFilesSha256, readCachedModule, sha256Text, writeCachedModule, writeCachedPack } from "./cache";
import type { HubClient } from "./client";
import type { CatalogResponse } from "./contract";
import { checkVersionSignature } from "./signature";

/**
 * Téléchargement dans le cache du Hub (`personas hub pull`) : version exacte, empreinte vérifiée (réponse,
 * catalogue), signature Ed25519 vérifiée si la version en porte une (src/hub/signature.ts), module revalidé
 * localement (mêmes règles que la bibliothèque) et passé au lint de sécurité (src/modules/lint.ts), dépendances
 * comprises. Une version retirée par la modération (`removed`) est refusée. Rien n'est épinglé ici : c'est le
 * rôle de `personas hub lock`.
 */

export interface PullResult {
  kind: "module" | "pack";
  /** Référence qualifiée. */
  ref: string;
  version: string;
  sha256: string;
  /** Déjà en cache (vérifié), rien téléchargé. */
  already: boolean;
  /** Pack livré avec Personas (packs/ du paquet ou du dépôt) : prioritaire, rien n'est mis en cache. */
  bundled?: boolean;
  warnings: string[];
}

function cacheDirOf(opts: { cacheDir?: string | null }): string {
  const dir = opts.cacheDir === undefined ? hubCacheDir() : opts.cacheDir;
  if (!dir) throw new Error("Pas de cache du Hub configuré (PERSONAS_HUB_CACHE_DIR).");
  return dir;
}

async function catalogOf(client: HubClient, opts: { catalog?: CatalogResponse | null }): Promise<CatalogResponse | null> {
  if (opts.catalog !== undefined) return opts.catalog;
  return (await client.catalog()).catalog;
}

/** Télécharge `ref[@version]` (dernière version du catalogue si absente) et ses dépendances. */
export async function pullModule(
  client: HubClient,
  spec: string,
  opts: { cacheDir?: string | null; catalog?: CatalogResponse | null; seen?: Set<string> } = {},
): Promise<PullResult[]> {
  const cacheDir = cacheDirOf(opts);
  const s = parseModuleSpec(spec);
  const qref = `${s.namespace}/${s.slug}`;
  let catalog = opts.catalog;
  let version = s.version;
  if (!version) {
    catalog = await catalogOf(client, opts);
    const entry = catalog?.modules.find((m) => m.ref === qref);
    if (!entry) throw new Error(`Module ${qref} absent du catalogue du Hub${catalog ? "" : " (catalogue indisponible : personas hub sync)"}.`);
    version = entry.latest;
  }
  const seen = opts.seen ?? new Set<string>();
  const key = `${qref}@${version}`;
  if (seen.has(key)) return [];
  seen.add(key);

  const out: PullResult[] = [];
  let yaml: string;
  let requires: Array<{ ref: string; version: string }>;
  // null si absente ou incomplète (fichier manquant) : téléchargée de nouveau ; lève si altérée (sha256 différent)
  const hit = readCachedModule(cacheDir, s.namespace, s.slug, version);
  if (hit) {
    yaml = hit.text;
    requires = hit.meta.requires;
    out.push({ kind: "module", ref: qref, version, sha256: hit.meta.sha256, already: true, warnings: [] });
  } else {
    const resp = await client.moduleVersion(qref, version);
    if (resp.ref !== qref || resp.version !== version) throw new HubIntegrityError(`Hub : réponse pour ${resp.ref}@${resp.version} au lieu de ${key} ; refusée.`);
    if (resp.status === "removed") throw new ModuleError(`Module ${key} retiré par la modération du Hub : téléchargement refusé.`);
    const sha = sha256Text(resp.yaml);
    if (sha !== resp.sha256) throw new HubIntegrityError(`sha256 refusé pour ${key} : contenu reçu ${sha.slice(0, 12)}…, annoncé ${resp.sha256.slice(0, 12)}…. Rien n'est écrit dans le cache.`);
    const listed = (catalog ?? opts.catalog)?.modules.find((m) => m.ref === qref)?.versions.find((v) => v.version === version);
    if (listed && listed.sha256 !== sha) throw new HubIntegrityError(`sha256 refusé pour ${key} : différent de celui du catalogue (${listed.sha256.slice(0, 12)}…). Rien n'est écrit dans le cache.`);
    let def;
    try {
      def = checkModule(parseYaml(resp.yaml), `${key} (Hub)`).def;
    } catch (err) {
      throw new ModuleError(`Module ${key} refusé : invalide pour ce moteur.\n${(err as Error).message}`);
    }
    if (def.id !== s.slug || def.version !== version) throw new HubIntegrityError(`Module ${key} refusé : le YAML déclare ${def.id}@${def.version}.`);
    // Lint de sécurité (injection de prompt, complaisance, tailles, attributs sensibles) : mêmes règles qu'à la publication
    const lint = lintModule(resp.yaml);
    if (lint.errors.length) throw new ModuleError(`Module ${key} refusé par le lint de sécurité :\n${formatIssues(lint.errors)}`);
    const sig = await checkVersionSignature(client, { ref: qref, version, sha256: sha, publishedAt: resp.publishedAt, signature: resp.signature }, cacheDir);
    const warnings = [
      ...(resp.status === "yanked" ? [`${key} est retiré (yanked) : utilisable par sa référence exacte, déconseillé pour une nouvelle étude.`] : []),
      ...(resp.status === "flagged" ? [`${key} est signalé (en attente de revue par la modération du Hub) : à utiliser avec prudence.`] : []),
      ...(sig.status === "valid" ? [] : [sig.warning]),
      ...lint.warnings.map((w) => `${key} : ${w.path ? `${w.path} : ` : ""}${w.message}`),
    ];
    writeCachedModule(cacheDir, {
      ref: qref,
      version,
      sha256: sha,
      status: resp.status,
      license: resp.license,
      quality: resp.quality,
      publishedAt: resp.publishedAt,
      requires: resp.requires,
      fetchedAt: new Date().toISOString(),
      hubUrl: client.baseUrl,
      ...(resp.signature !== undefined && { signature: resp.signature }),
      ...(resp.forkedFrom !== undefined && { forkedFrom: resp.forkedFrom }),
    }, resp.yaml);
    yaml = resp.yaml;
    requires = resp.requires;
    out.push({ kind: "module", ref: qref, version, sha256: sha, already: false, warnings });
  }

  // Dépendances : versions exactes de la réponse ; forme courte (id nu) : bibliothèque locale, sinon personas/ au plus récent
  const deps = new Map(requires.map((r) => [`${r.ref}@${r.version}`, r]));
  const parsed = parseYaml(yaml) as { requires?: unknown[] };
  for (const r of parsed.requires ?? []) {
    if (typeof r === "string" && !r.includes("@")) {
      const d = parseModuleSpec(r);
      if (![...deps.values()].some((x) => x.ref === `${d.namespace}/${d.slug}`)) deps.set(r, { ref: `${d.namespace}/${d.slug}`, version: "" });
    }
  }
  invalidateModuleLibraries();
  for (const d of deps.values()) {
    const ds = parseModuleSpec(d.ref);
    if (d.version ? moduleAt(ds.ref, d.version) : moduleLibrary().get(ds.ref)) continue;
    out.push(...(await pullModule(client, d.version ? `${d.ref}@${d.version}` : d.ref, { cacheDir, ...(catalog !== undefined && { catalog }), seen })));
  }
  invalidateModuleLibraries();
  return out;
}

/** Télécharge une version de pack (`personas/sg@sg-2026.3`, ou la dernière) et sa base `extends` si besoin. */
export async function pullPack(
  client: HubClient,
  spec: string,
  opts: { cacheDir?: string | null; catalog?: CatalogResponse | null; seen?: Set<string> } = {},
): Promise<PullResult[]> {
  const cacheDir = cacheDirOf(opts);
  const at = spec.lastIndexOf("@");
  const qref = at > 0 ? spec.slice(0, at) : spec;
  let version = at > 0 ? spec.slice(at + 1) : undefined;
  let catalog = opts.catalog;
  if (!version) {
    catalog = await catalogOf(client, opts);
    const entry = catalog?.packs.find((p) => p.ref === qref);
    if (!entry) throw new Error(`Pack ${qref} absent du catalogue du Hub${catalog ? "" : " (catalogue indisponible : personas hub sync)"}.`);
    version = entry.latest;
  }
  const seen = opts.seen ?? new Set<string>();
  if (seen.has(`${qref}@${version}`)) return [];
  seen.add(`${qref}@${version}`);
  const existing = findPack(version, cacheDir);
  if (existing) {
    return [{ kind: "pack", ref: existing.ref ?? qref, version, sha256: existing.sha256 ?? "", already: true, ...(existing.source === "local" && { bundled: true }), warnings: [] }];
  }
  const resp = await client.packVersion(qref, version);
  if (resp.ref !== qref || resp.version !== version) throw new HubIntegrityError(`Hub : réponse pour le pack ${resp.ref}@${resp.version} au lieu de ${qref}@${version} ; refusée.`);
  const sha = packFilesSha256(resp.files);
  if (sha !== resp.sha256) throw new HubIntegrityError(`sha256 refusé pour le pack ${qref}@${version} : contenu reçu ${sha.slice(0, 12)}…, annoncé ${resp.sha256.slice(0, 12)}…. Rien n'est écrit dans le cache.`);
  const listed = catalog?.packs.find((p) => p.ref === qref)?.versions.find((v) => v.version === version);
  if (listed && listed.sha256 !== sha) throw new HubIntegrityError(`sha256 refusé pour le pack ${qref}@${version} : différent de celui du catalogue. Rien n'est écrit dans le cache.`);
  if (resp.status === "removed") throw new HubIntegrityError(`Pack ${qref}@${version} retiré par la modération du Hub : téléchargement refusé.`);
  const sig = await checkVersionSignature(client, { ref: qref, version, sha256: sha, publishedAt: resp.publishedAt, signature: resp.signature }, cacheDir);
  let manifest: { version?: string; generator?: string; extends?: string };
  try {
    manifest = JSON.parse(resp.files["pack.json"] ?? "") as typeof manifest;
  } catch {
    throw new HubIntegrityError(`Pack ${qref}@${version} refusé : pack.json absent ou illisible.`);
  }
  if (manifest.version !== version) throw new HubIntegrityError(`Pack ${qref}@${version} refusé : pack.json déclare la version ${manifest.version}.`);
  // On n'exécute jamais de code venu du Hub : le générateur doit être fourni par ce moteur (docs/plateforme.md § 4.4)
  if (!(GENERATORS as readonly string[]).includes(manifest.generator ?? "fr")) {
    throw new HubIntegrityError(`Pack ${qref}@${version} refusé : générateur « ${manifest.generator} » inconnu de ce moteur (mettre à jour personas).`);
  }
  const out: PullResult[] = [];
  const base = resp.extends ?? manifest.extends ?? null;
  if (base && !findPack(base, cacheDir)) {
    const baseSpec = base.includes("/") ? base : `${qref}@${base}`;
    out.push(...(await pullPack(client, baseSpec, { cacheDir, ...(catalog !== undefined && { catalog }), seen })));
  }
  const dir = writeCachedPack(cacheDir, { ref: qref, version, sha256: sha, extends: resp.extends, license: resp.license, fetchedAt: new Date().toISOString(), hubUrl: client.baseUrl }, resp.files);
  invalidatePackSources();
  // Contrôle final : le pack doit se charger (schéma des tables, héritage) ; sinon il est retiré du cache.
  try {
    const { loadPack } = await import("../personas/pack");
    loadPack(version);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    invalidatePackSources();
    throw new HubIntegrityError(`Pack ${qref}@${version} refusé : ${(err as Error).message}`);
  }
  out.push({ kind: "pack", ref: qref, version, sha256: sha, already: false, warnings: sig.status === "valid" ? [] : [sig.warning] });
  return out;
}
