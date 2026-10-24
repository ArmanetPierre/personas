import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Persona } from "../db/schema";
import { loadPack, PACKS_DIR, type Pack } from "../personas/pack";
import { findPack } from "../personas/pack-source";

/**
 * Plusieurs populations peuvent cohabiter dans la base (pack général, pack ciblé).
 * Le pack qui sert à décrire une persona est celui de sa `packVersion` s'il se charge,
 * sinon le pack par défaut (mêmes régions, PCS, tailles d'agglomération).
 */
export type PackResolver = (p: Pick<Persona, "packVersion">) => Pack;

export function packResolver(defaultPack: Pack): PackResolver {
  const byVersion = new Map<string, Pack>([[defaultPack.manifest.version, defaultPack]]);
  const tried = new Set<string>();
  return (p) => {
    const hit = byVersion.get(p.packVersion);
    if (hit) return hit;
    if (!tried.has(p.packVersion)) {
      tried.add(p.packVersion);
      const dir = findPackDir(p.packVersion);
      if (dir) {
        try {
          byVersion.set(p.packVersion, loadPack(dir));
        } catch {
          // Pack à structure différente : on retombe sur le pack par défaut.
        }
      }
    }
    return byVersion.get(p.packVersion) ?? defaultPack;
  };
}

/** Manifeste (libellés, modules) d'une version de pack présente dans packs/, s'il existe. */
export function packManifest(version: string): Pack["manifest"] | undefined {
  const dir = findPackDir(version);
  if (!dir) return undefined;
  try {
    return loadPack(dir).manifest;
  } catch {
    return undefined;
  }
}

function findPackDir(version: string): string | undefined {
  // Pack absent de packs/ : version téléchargée dans le cache du Hub (chargée par sa version)
  if (!existsSync(PACKS_DIR)) return findPack(version) ? version : undefined;
  for (const d of readdirSync(PACKS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const m = JSON.parse(readFileSync(join(PACKS_DIR, d.name, "pack.json"), "utf8")) as { version?: string };
      if (m.version === version) return d.name;
    } catch {
      // pas de manifeste lisible
    }
  }
  return findPack(version)?.source === "hub-cache" ? version : undefined;
}
